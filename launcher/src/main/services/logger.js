'use strict';

/**
 * Journal du launcher.
 *
 *  - écriture dans `logs/launcher.log`, rotation sur 5 fichiers de 2 Mo ;
 *  - masquage automatique de tout ce qui ressemble à un jeton ou à un mot de passe ;
 *  - diffusion en direct au renderer sur le canal `log:line` (voir docs/IPC.md) ;
 *  - historique en mémoire des 500 dernières lignes, servi par `log:history`.
 *
 * Une ligne de journal est l'objet `LogLine` du contrat :
 *   { ts: '2026-09-08T11:34:00.000Z', level: 'info'|'warn'|'error'|'game', text: '…' }
 *
 * **L'écriture disque est asynchrone et groupée.** Le démarrage d'une instance moddée
 * produit plusieurs milliers de lignes en quelques secondes : une écriture bloquante par
 * ligne figerait le processus principal, donc l'interface et la barre de progression.
 * Les lignes sont mises en file d'attente et vidées ensemble, au plus tard 200 ms après
 * leur arrivée, plus tôt si la file grossit. Un ultime vidage synchrone à la sortie du
 * processus garantit qu'aucune ligne n'est perdue.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');

/** Canal de diffusion vers le renderer. */
const CHANNEL = 'log:line';

/** Taille maximale d'un fichier de journal avant rotation. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Nombre total de fichiers conservés : launcher.log + launcher.1.log … launcher.4.log. */
const MAX_FILES = 5;

/** Nombre de lignes gardées en mémoire pour le panneau « console » du renderer. */
const HISTORY_MAX = 500;

/** Délai maximal entre l'arrivée d'une ligne et son écriture sur le disque. */
const FLUSH_DELAY_MS = 200;

/** Volume en attente au-delà duquel on vide sans attendre la fin du délai. */
const FLUSH_BYTES = 64 * 1024;

/**
 * Volume maximal d'un seul bloc écrit. La rotation se décide entre deux blocs : sans ce
 * plafond, une rafale de plusieurs mégaoctets serait écrite d'un coup et `launcher.log`
 * dépasserait franchement sa taille de rotation.
 */
const CHUNK_MAX_BYTES = 256 * 1024;

/**
 * Plafond de la file d'attente. Un disque bloqué ne doit pas faire enfler la mémoire du
 * launcher : au-delà, les lignes les plus anciennes sont sacrifiées et comptées.
 */
const QUEUE_MAX_BYTES = 4 * 1024 * 1024;

/** Niveaux acceptés ; tout le reste retombe sur « info ». */
const LEVELS = new Set(['info', 'warn', 'error', 'game']);

/** Remplacement inséré à la place d'un secret. */
const MASK = '[masqué]';

/** Fragments de noms de champs considérés comme sensibles. */
const SECRET_KEY =
  '(?:pass(?:word|wd)?|mot[_-]?de[_-]?passe|secret|token|access[_-]?token|refresh[_-]?token|' +
  'client[_-]?token|id[_-]?token|session[_-]?token|authorization|auth[_-]?code|code|otp|totp|' +
  'recovery[_-]?codes?|api[_-]?key|apikey|xsts|xbl|rps[_-]?ticket)';

/**
 * Règles de masquage, appliquées dans l'ordre sur chaque ligne.
 * Volontairement larges : une ligne illisible vaut mieux qu'un jeton dans un fichier.
 */
const RULES = [
  // Jeton JWT complet (access_token, yggdrasil.accessToken…)
  { re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, to: MASK },
  // En-tête d'autorisation HTTP
  { re: /\b(Bearer|Basic)\s+\S+/gi, to: `$1 ${MASK}` },
  // Jeton Xbox Live (XBL3.0 x=uhs;token)
  { re: /\bXBL3\.0\s+x=\S+/gi, to: `XBL3.0 x=${MASK}` },
  // Champ JSON sensible : "refresh_token": "…"
  { re: new RegExp(`("${SECRET_KEY}"\\s*:\\s*")[^"]{4,}(")`, 'gi'), to: `$1${MASK}$2` },
  // Paire clé=valeur (URL de redirection, ligne de commande, texte libre)
  {
    re: new RegExp(`\\b(${SECRET_KEY})\\s*[=:]\\s*("[^"]{8,}"|'[^']{8,}'|[^\\s,&;"']{8,})`, 'gi'),
    to: `$1=${MASK}`,
  },
  // Arguments de la ligne de commande Minecraft
  { re: /(--(?:accessToken|clientToken|session)\s+)\S+/gi, to: `$1${MASK}` },
  // Toute suite très longue de caractères base64url : jeton opaque, code Microsoft, skin encodé
  { re: /\b[A-Za-z0-9_-]{48,}\b/g, to: MASK },
];

/** Historique circulaire des dernières lignes. */
const history = [];

/** Abonnés locaux (processus principal). */
const listeners = new Set();

/** Fenêtre destinataire de la diffusion `log:line`. */
let target = null;

/** Taille courante de `launcher.log`, pour décider de la rotation sans `stat` à chaque ligne. */
let written = -1;

/** Passe à `true` si l'écriture disque échoue, pour ne pas boucler sur l'erreur. */
let fileBroken = false;

/**
 * Lignes en attente d'écriture, retour à la ligne compris et poids déjà mesuré.
 * @type {{text: string, bytes: number}[]}
 */
const queue = [];

/** Poids exact de `queue`, pour décider du vidage sans re-mesurer la file. */
let queueBytes = 0;

/** Lignes sacrifiées faute de place dans la file, depuis le dernier vidage. */
let dropped = 0;

/** Minuterie du prochain vidage, ou `null`. */
let flushTimer = null;

/**
 * Vidage en cours, ou `null` : un seul écrivain à la fois, l'ordre des lignes en dépend.
 * @type {Promise<void>|null}
 */
let flushing = null;

/**
 * Masque tout ce qui ressemble à un secret dans une ligne.
 * @param {string} line
 * @returns {string}
 */
function mask(line) {
  let out = line;
  for (const rule of RULES) out = out.replace(rule.re, rule.to);
  return out;
}

/**
 * Met n'importe quelle valeur sous forme de texte lisible.
 * @param {unknown} value
 * @returns {string}
 */
function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

/** Chemin du fichier de journal courant. */
function currentFile() {
  return path.join(paths.logsDir, 'launcher.log');
}

/** Chemin d'une archive (`index` de 1 à MAX_FILES - 1). */
function archiveFile(index) {
  return path.join(paths.logsDir, `launcher.${index}.log`);
}

/** Renomme un fichier de journal en tolérant son absence. */
async function renameIfPresent(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Fait tourner les fichiers : la plus ancienne archive est supprimée,
 * les autres sont décalées, puis `launcher.log` devient `launcher.1.log`.
 */
async function rotate() {
  try {
    await fsp.rm(archiveFile(MAX_FILES - 1), { force: true });
    for (let i = MAX_FILES - 2; i >= 1; i--) {
      await renameIfPresent(archiveFile(i), archiveFile(i + 1));
    }
    await renameIfPresent(currentFile(), archiveFile(1));
    written = 0;
  } catch (err) {
    fileBroken = true;
    console.error('[opm] rotation du journal impossible :', err);
  }
}

/** Mesure une seule fois la taille du fichier courant, pour piloter la rotation. */
async function measureFile() {
  if (written >= 0) return;
  await fsp.mkdir(paths.logsDir, { recursive: true });
  try {
    written = (await fsp.stat(currentFile())).size;
  } catch {
    written = 0;
  }
}

/** Programme le prochain vidage, s'il n'y en a pas déjà un en attente ou en cours. */
function scheduleFlush() {
  if (flushTimer || flushing || fileBroken) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
  // La minuterie ne doit pas, à elle seule, maintenir le processus en vie.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Écrit d'un bloc tout ce qui attend. Les lignes arrivées pendant l'écriture repartent
 * pour un tour : la boucle ne rend la main que la file vide.
 * @returns {Promise<void>}
 */
async function drain() {
  try {
    while (queue.length > 0 && !fileBroken) {
      const { text, size } = takeChunk();
      const lost = dropped;
      dropped = 0;

      await measureFile();
      if (written + size > MAX_BYTES) await rotate();
      if (fileBroken) break;

      await fsp.appendFile(currentFile(), text, 'utf8');
      written += size;

      if (lost > 0) console.warn(`[opm] ${lost} ligne(s) de journal perdue(s) : écriture disque trop lente.`);
    }
  } catch (err) {
    fileBroken = true;
    console.error('[opm] écriture du journal impossible :', err);
  }
}

/**
 * Retire de la file le prochain bloc à écrire, sans dépasser `CHUNK_MAX_BYTES` — sauf si
 * une seule ligne suffit à le dépasser, auquel cas elle part telle quelle.
 * @returns {{text: string, size: number}}
 */
function takeChunk() {
  const parts = [];
  let size = 0;

  while (queue.length > 0) {
    const entry = queue[0];
    if (size > 0 && size + entry.bytes > CHUNK_MAX_BYTES) break;
    queue.shift();
    queueBytes -= entry.bytes;
    parts.push(entry.text);
    size += entry.bytes;
  }

  if (queue.length === 0) queueBytes = 0;
  return { text: parts.join(''), size };
}

/**
 * Vide la file. Un appel pendant un vidage rend la promesse de celui-ci : quiconque
 * attend `flush()` attend bien la fin de l'écriture, jamais autre chose.
 * @returns {Promise<void>}
 */
function flush() {
  if (flushing) return flushing;
  if (fileBroken || queue.length === 0) return Promise.resolve();

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  flushing = drain().finally(() => {
    flushing = null;
    if (queue.length > 0) scheduleFlush();
  });
  return flushing;
}

/**
 * Dernier vidage, synchrone, à la sortie du processus : c'est le seul moment où bloquer
 * est légitime, et le seul moyen de ne pas perdre les dernières lignes.
 */
function flushSync() {
  if (fileBroken || queue.length === 0) return;
  const chunk = queue.map((entry) => entry.text).join('');
  const size = queueBytes;
  queue.length = 0;
  queueBytes = 0;
  try {
    fs.mkdirSync(paths.logsDir, { recursive: true });
    fs.appendFileSync(currentFile(), chunk, 'utf8');
    if (written >= 0) written += size;
  } catch {
    /* le processus s'arrête : plus rien à tenter */
  }
}

/**
 * Met une ligne en file d'attente. Aucune entrée-sortie ici : c'est tout l'objet de la
 * manœuvre, la sortie du jeu ne doit jamais bloquer le processus principal.
 * @param {string} text ligne déjà formatée, sans retour à la ligne
 */
function appendToFile(text) {
  if (fileBroken) return;

  const line = `${text}\n`;
  const entry = { text: line, bytes: Buffer.byteLength(line) };
  queue.push(entry);
  queueBytes += entry.bytes;

  while (queueBytes > QUEUE_MAX_BYTES && queue.length > 1) {
    queueBytes -= queue.shift().bytes;
    dropped += 1;
  }

  if (queueBytes >= FLUSH_BYTES) void flush();
  else scheduleFlush();
}

process.on('exit', flushSync);

/**
 * Diffuse une ligne au renderer et aux abonnés du processus principal.
 * @param {{ts: string, level: string, text: string}} line
 */
function broadcast(line) {
  if (target && !target.isDestroyed()) {
    const wc = target.webContents;
    if (wc && !wc.isDestroyed()) {
      try {
        wc.send(CHANNEL, line);
      } catch {
        /* la fenêtre est en train de disparaître : rien à faire */
      }
    }
  }
  for (const cb of listeners) {
    try {
      cb(line);
    } catch (err) {
      console.error('[opm] abonné au journal en erreur :', err);
    }
  }
}

/**
 * Journalise une entrée. Les textes multilignes deviennent plusieurs `LogLine`.
 * @param {'info'|'warn'|'error'|'game'} level
 * @param {unknown} text
 */
function log(level, text) {
  const lvl = LEVELS.has(level) ? level : 'info';
  const raw = stringify(text);

  for (const piece of raw.split(/\r?\n/)) {
    const clean = mask(piece.replace(/\s+$/, ''));
    if (!clean) continue;

    const line = { ts: new Date().toISOString(), level: lvl, text: clean };

    history.push(line);
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);

    appendToFile(`${line.ts} [${lvl.toUpperCase()}] ${clean}`);
    broadcast(line);

    if (lvl === 'error') console.error(`[opm] ${clean}`);
    else if (lvl === 'warn') console.warn(`[opm] ${clean}`);
    else console.log(`[opm] ${clean}`);
  }
}

/**
 * Désigne la fenêtre qui reçoit les lignes en direct.
 * Les lignes émises avant l'attache restent disponibles via `history()`.
 * @param {import('electron').BrowserWindow|null} win
 */
function attach(win) {
  target = win || null;
  if (!win) return;
  win.once('closed', () => {
    if (target === win) target = null;
  });
}

/**
 * Abonnement local (processus principal).
 * @param {(line: {ts: string, level: string, text: string}) => void} cb
 * @returns {() => void} fonction de désabonnement
 */
function onLine(cb) {
  if (typeof cb !== 'function') throw new TypeError('logger.onLine attend une fonction.');
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Copie de l'historique en mémoire (au plus 500 lignes). */
function history_() {
  return history.slice();
}

/** Raccourcis : `logger.info('texte', err)` accepte plusieurs fragments. */
const shortcut = (level) => (...parts) => log(level, parts.map(stringify).join(' '));

module.exports = {
  attach,
  flush,
  flushSync,
  log,
  info: shortcut('info'),
  warn: shortcut('warn'),
  error: shortcut('error'),
  game: shortcut('game'),
  history: history_,
  onLine,
};
