'use strict';

/**
 * Enregistrement de tous les canaux IPC du launcher.
 *
 * Le renderer n'a ni `require` ni `ipcRenderer` : il ne voit que la surface `window.opm`
 * exposée par `src/preload.js`. Ce fichier est l'exact miroir de docs/IPC.md — un canal
 * de plus ou de moins ici est un bug.
 *
 * Convention d'erreur : aucun handler ne laisse remonter d'exception. Un échec est
 * converti en objet sérialisable `{ error: <code>, message: <texte français>, details? }`,
 * que le preload retransforme en `Error` rejetée côté renderer.
 * Les réponses métier qui portent déjà un champ `ok` (LoginResult) ne sont jamais
 * confondues avec cette enveloppe.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { ipcMain, app, shell, dialog } = require('electron');

const paths = require('./services/paths');
const logger = require('./services/logger');
const store = require('./services/store');
const game = require('./services/game');
const content = require('./services/content');
const updater = require('./services/updater');
const accounts = require('./auth/accounts');
const api = require('./auth/api');

/** Panneaux HTML que le renderer a le droit de demander. */
const PANELS = new Set(['home', 'settings', 'donation', 'login']);

/** Un exécutable Java acceptable s'appelle java, javaw, java.exe ou javaw.exe. */
const JAVA_BIN = /^javaw?(?:\.exe)?$/i;

/** Extensions de fichiers que `app.openPath` accepte d'ouvrir (le reste : dossiers uniquement). */
const OPENABLE_FILES = new Set(['.log', '.txt', '.json']);

/** Poids maximal d'une image rapatriée par `app:fetch-image` (2 Mo). */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Délai maximal de récupération d'une image. */
const IMAGE_TIMEOUT_MS = 8_000;

/** Type MIME acceptable pour une image : `image/` suivi d'un sous-type plausible. */
const IMAGE_MIME = /^image\/[a-z0-9][a-z0-9.+-]{0,32}$/;

/** Un octet = 2^30 octets dans un gigaoctet (Go binaire, comme l'affiche la maquette). */
const GIB = 1024 ** 3;

/** @type {() => (import('electron').BrowserWindow|null)} */
let getWindow = () => null;

/** Empêche un double enregistrement des handlers. */
let registered = false;

/** Désabonnements des ponts d'événements (services → renderer). */
const bridges = [];

/* ------------------------------------------------------------------ outils */

/**
 * Construit une erreur porteuse d'un code normalisé (voir docs/API.md § 3).
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Transforme une exception en enveloppe sérialisable.
 * @param {string} channel
 * @param {unknown} err
 */
function toError(channel, err) {
  const code =
    (err && typeof err.code === 'string' && err.code) ||
    (err && typeof err.error === 'string' && err.error) ||
    'internal_error';
  const message =
    (err && typeof err.message === 'string' && err.message) ||
    'Une erreur inattendue est survenue.';

  logger.error(`IPC ${channel} → ${code} : ${message}`);

  const payload = { error: code, message };
  if (err && err.details !== undefined && err.details !== null) {
    try {
      payload.details = JSON.parse(JSON.stringify(err.details));
    } catch {
      /* détails non sérialisables : on les laisse de côté */
    }
  }
  return payload;
}

/**
 * Envoie un message au renderer, si la fenêtre est vivante.
 * @param {string} channel
 * @param {...unknown} args
 */
function emit(channel, ...args) {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send(channel, ...args);
  } catch {
    /* fenêtre en cours de destruction */
  }
}

/**
 * Déclare un canal `invoke/handle` protégé.
 * @param {string} channel
 * @param {(...args: any[]) => any} fn
 */
function handle(channel, fn) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return toError(channel, err);
    }
  });
}

/**
 * Déclare un canal `send/on` protégé (actions sans retour).
 * @param {string} channel
 * @param {(...args: any[]) => void} fn
 */
function listen(channel, fn) {
  ipcMain.removeAllListeners(channel);
  ipcMain.on(channel, (_event, ...args) => {
    try {
      fn(...args);
    } catch (err) {
      toError(channel, err);
    }
  });
}

/**
 * Branche un flux d'événements d'un service vers le renderer.
 * @param {string} name nom du service, pour le journal
 * @param {() => (() => void)} subscribe
 */
function bridge(name, subscribe) {
  try {
    const off = subscribe();
    if (typeof off === 'function') bridges.push(off);
  } catch (err) {
    logger.error(`Impossible d'écouter les événements de ${name} :`, err);
  }
}

/* ----------------------------------------------------- validation d'entrée */

function needString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw fail('invalid_argument', `Paramètre « ${label} » invalide.`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null) return undefined;
  return needString(value, label);
}

function needObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('invalid_argument', `Paramètre « ${label} » invalide.`);
  }
  return value;
}

/**
 * N'autorise que http(s) : `shell.openExternal` peut sinon lancer des protocoles
 * arbitraires (`file:`, `ms-…`) si le renderer est compromis.
 * Même règle que la politique de navigation de `src/app.js` — chaque module reste autonome.
 * @param {unknown} url
 */
function isHttpUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Vérifie qu'un chemin demandé par le renderer reste dans nos dossiers.
 * Seuls les dossiers et quelques fichiers inoffensifs sont ouvrables : le dossier du jeu
 * contient des exécutables et des archives téléchargés, que `shell.openPath` lancerait.
 * @param {string} target
 */
function assertOpenablePath(target) {
  const resolved = path.resolve(target);
  const roots = [paths.userDir, paths.gameDir].map((root) => path.resolve(root));
  const inside = roots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!inside) {
    throw fail('forbidden_path', "Ce chemin n'appartient pas au launcher.");
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw fail('not_found', "Ce chemin n'existe pas (ou plus).");
  }
  if (!stat.isDirectory() && !OPENABLE_FILES.has(path.extname(resolved).toLowerCase())) {
    throw fail('forbidden_path', 'Seuls les dossiers et les fichiers texte peuvent être ouverts.');
  }
  return resolved;
}

/* -------------------------------------------------------------------- images */

/**
 * Rapatrie une image et la rend en `data:` URL.
 *
 * Le renderer est chargé en `file://` : il n'a pas d'origine, et le serveur n'ouvre CORS
 * pour personne. Une texture chargée directement dans un `<canvas>` le teinte, et les
 * pixels deviennent illisibles — le rendu des têtes de skin est donc impossible côté
 * interface. Le processus principal, lui, n'a pas cette contrainte : il télécharge, et
 * rend une chaîne que n'importe quel `<img>` accepte sans condition.
 *
 * Garde-fous : `https` uniquement, 2 Mo au plus, 8 s au plus, type MIME d'image exigé.
 * **Ne lève jamais** : un échec vaut `null`, et l'appelant retombe sur sa silhouette.
 *
 * @param {unknown} url
 * @returns {Promise<string|null>}
 */
async function fetchImage(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    logger.warn("Image ignorée : adresse illisible.");
    return null;
  }
  if (parsed.protocol !== 'https:') {
    logger.warn(`Image ignorée : seul https est accepté (${parsed.protocol}).`);
    return null;
  }

  const label = `${parsed.host}${parsed.pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: { Accept: 'image/*' },
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(`Image non récupérée (HTTP ${response.status}) : ${label}`);
      return null;
    }

    const type = String(response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!IMAGE_MIME.test(type)) {
      logger.warn(`Image non récupérée : le serveur a répondu « ${type || 'sans type'} » — ${label}`);
      return null;
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) {
      logger.warn(`Image non récupérée : ${declared} octets annoncés, plus de 2 Mo — ${label}`);
      return null;
    }

    if (!response.body) {
      logger.warn(`Image non récupérée : réponse sans contenu — ${label}`);
      return null;
    }

    // Lecture par morceaux : le plafond est tenu même sans en-tête `Content-Length`.
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > IMAGE_MAX_BYTES) {
        controller.abort();
        logger.warn(`Image non récupérée : plus de 2 Mo — ${label}`);
        return null;
      }
      chunks.push(Buffer.from(value));
    }

    if (total === 0) {
      logger.warn(`Image non récupérée : fichier vide — ${label}`);
      return null;
    }

    return `data:${type};base64,${Buffer.concat(chunks, total).toString('base64')}`;
  } catch (err) {
    const reason = controller.signal.aborted ? 'délai dépassé' : err && err.message ? err.message : 'cause inconnue';
    logger.warn(`Image non récupérée (${reason}) : ${label}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ versions */

/**
 * Compare deux numéros de version « x.y.z ».
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number|null} -1, 0 ou 1 ; `null` si l'une des deux est illisible — on ne rend
 *          aucun verdict sur un doute.
 */
function compareVersions(a, b) {
  const parse = (value) => {
    if (typeof value !== 'string') return null;
    const parts = value.trim().split('-')[0].split('.');
    if (parts.length === 0 || parts.length > 4) return null;
    const numbers = parts.map((part) => Number(part));
    return numbers.every((n) => Number.isInteger(n) && n >= 0) ? numbers : null;
  };

  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Complète le bloc `launcher` de l'amorçage par le verdict de version.
 *
 * Le serveur annonce la version minimale exigée mais ignore celle qui tourne ici : seul le
 * processus principal peut trancher. Deux champs calculés viennent donc s'ajouter à la
 * réponse — `version_current` et `update_required` (docs/IPC.md § Amorçage) — pour que
 * l'interface n'ait pas à refaire la comparaison.
 *
 * @param {any} payload  réponse de `GET /api/v1/bootstrap`
 * @returns {any}
 */
function withVersionVerdict(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  const launcher =
    payload.launcher && typeof payload.launcher === 'object' && !Array.isArray(payload.launcher)
      ? payload.launcher
      : {};
  const version = app.getVersion();
  const order = compareVersions(version, launcher.version_min);
  const outdated = order !== null && order < 0;

  if (outdated) {
    logger.warn(
      `Launcher ${version} obsolète : le serveur exige la version ${launcher.version_min} ` +
        'au minimum. Le jeu ne pourra pas être lancé.'
    );
  }

  return {
    ...payload,
    launcher: { ...launcher, version_current: version, update_required: outdated },
  };
}

/* ------------------------------------------------------------ enregistrement */

/**
 * Enregistre l'intégralité des canaux décrits par docs/IPC.md.
 * @param {() => (import('electron').BrowserWindow|null)} windowGetter
 */
function register(windowGetter) {
  if (typeof windowGetter === 'function') getWindow = windowGetter;
  if (registered) {
    logger.warn('ipc.register appelé deux fois : les canaux sont déjà en place.');
    return;
  }
  registered = true;

  /* ------------------------------------------------------------- FENÊTRE */

  listen('window:minimize', () => {
    const win = getWindow();
    if (win) win.minimize();
  });

  listen('window:maximize', () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  listen('window:close', () => {
    const win = getWindow();
    if (win) win.close();
  });

  listen('window:hide', () => {
    const win = getWindow();
    if (win) win.hide();
  });

  listen('window:show', () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  handle('window:is-maximized', () => {
    const win = getWindow();
    return Boolean(win && win.isMaximized());
  });

  // -1 = barre de progression éteinte, 2 = indéterminée, sinon un ratio 0 → 1.
  listen('window:progress', (ratio) => {
    const win = getWindow();
    if (!win) return;
    // Un seul pilote : pendant une préparation, une vérification ou une partie, la barre
    // des tâches appartient à `services/game.js`, qui l'écrit déjà à chaque progression.
    // La valeur venue du renderer ferait double emploi et pourrait la contredire.
    if (game.ownsTaskbar()) return;
    const value =
      typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : -1;
    const clamped = value === -1 || value === 2 ? value : Math.min(1, Math.max(0, value));
    win.setProgressBar(clamped);
  });

  /* --------------------------------------------------------- APPLICATION */

  handle('app:version', () => app.getVersion());

  handle('app:platform', () => process.platform);

  handle('app:open-external', async (url) => {
    if (!isHttpUrl(url)) throw fail('invalid_url', 'Seuls les liens http(s) peuvent être ouverts.');
    await shell.openExternal(url);
  });

  handle('app:open-path', async (target) => {
    const dir = assertOpenablePath(needString(target, 'path'));
    const result = await shell.openPath(dir);
    if (result) throw fail('open_failed', result);
  });

  handle('app:game-dir', () => paths.gameDir);

  handle('app:memory', () => ({
    total: os.totalmem() / GIB,
    free: os.freemem() / GIB,
  }));

  handle('app:fetch-image', (url) => fetchImage(url));

  handle('app:pick-java', async () => {
    const win = getWindow();
    const filters =
      process.platform === 'win32'
        ? [{ name: 'Exécutable Java', extensions: ['exe'] }]
        : [{ name: 'Exécutable Java', extensions: ['*'] }];

    const options = {
      title: 'Sélectionnez l’exécutable Java (java ou javaw)',
      buttonLabel: 'Utiliser ce Java',
      properties: ['openFile', 'dontAddToRecent'],
      filters,
    };

    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);

    if (canceled || !filePaths.length) return null;

    const chosen = filePaths[0];
    if (!JAVA_BIN.test(path.basename(chosen))) {
      throw fail(
        'invalid_java',
        "Ce fichier n'est pas un exécutable Java : choisissez « java » ou « javaw »."
      );
    }
    return chosen;
  });

  handle('app:panel', async (name) => {
    const wanted = needString(name, 'panel');
    if (!PANELS.has(wanted)) throw fail('unknown_panel', `Panneau inconnu : ${wanted}.`);
    try {
      return await fsp.readFile(path.join(paths.panelsDir, `${wanted}.html`), 'utf8');
    } catch (err) {
      logger.warn(`Lecture du panneau « ${wanted} » impossible :`, err);
      throw fail('panel_unreadable', `Le panneau « ${wanted} » est introuvable.`);
    }
  });

  listen('app:devtools', () => {
    const win = getWindow();
    if (!win) return;
    const wc = win.webContents;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  });

  /* ------------------------------------------------------- CONFIGURATION */

  handle('config:get', () => store.getConfig());
  handle('config:set', (patch) => store.setConfig(needObject(patch, 'patch')));
  handle('config:reset', () => store.resetConfig());

  /* ------------------------------------------------------------- COMPTES */

  handle('auth:bootstrap', async () => withVersionVerdict(await api.bootstrap()));
  handle('auth:list', () => accounts.list());
  handle('auth:current', () => accounts.current());
  handle('auth:select', (id) => accounts.select(needString(id, 'id')));
  handle('auth:remove', (id) => accounts.remove(needString(id, 'id')));

  handle('auth:login', (payload) => {
    const p = needObject(payload, 'identifiants');
    return accounts.login({
      email: needString(p.email, 'email'),
      password: needString(p.password, 'password'),
      totp: optionalString(p.totp, 'totp'),
    });
  });

  handle('auth:register', (payload) => {
    const p = needObject(payload, 'inscription');
    return accounts.register({
      email: needString(p.email, 'email'),
      password: needString(p.password, 'password'),
      username: needString(p.username, 'username'),
    });
  });

  handle('auth:logout', (id) => accounts.logout(optionalString(id, 'id')));

  // Le contrat de `accounts` n'expose qu'un rafraîchissement global : on le déclenche
  // puis on renvoie le compte demandé (ou le compte courant).
  handle('auth:refresh', async (id) => {
    const wanted = optionalString(id, 'id');
    await accounts.refreshAll((step) => {
      if (step !== undefined && step !== null) logger.info('Session :', step);
    });
    if (!wanted) return accounts.current();
    const list = await accounts.list();
    return (Array.isArray(list) ? list.find((a) => a && a.id === wanted) : null) || accounts.current();
  });

  handle('auth:forgot-password', (email) => accounts.forgotPassword(needString(email, 'email')));
  handle('auth:totp-setup', () => accounts.totpSetup());
  handle('auth:totp-enable', (code) => accounts.totpEnable(needString(code, 'code')));

  handle('auth:totp-disable', (payload) => {
    const p = needObject(payload, 'désactivation');
    return accounts.totpDisable({
      password: needString(p.password, 'password'),
      code: needString(p.code, 'code'),
    });
  });

  handle('auth:link-microsoft', () => accounts.linkMicrosoft());

  // Renoncement du joueur : la scrutation en cours s'arrête, le verrou est libéré et le
  // code cesse d'être publié. Sans rattachement en cours, c'est un non-événement.
  handle('auth:cancel-link', () => {
    accounts.cancelLink();
  });

  handle('auth:unlink-microsoft', (password) =>
    accounts.unlinkMicrosoft(needString(password, 'password'))
  );
  handle('auth:verify-ownership', () => accounts.verifyOwnership());

  bridge('accounts', () =>
    accounts.onChange((list, current) => emit('auth:changed', list, current))
  );

  /* ----------------------------------------------------------------- JEU */

  handle('game:instances', () => game.instances());
  handle('game:launch', (name) => game.launch(optionalString(name, 'instance')));
  handle('game:cancel', () => game.cancel());
  handle('game:is-running', () => game.isRunning());
  handle('game:verify', () => game.verifyFiles());
  handle('game:clear-cache', () => game.clearCache());
  handle('game:files-stat', () => game.filesStat());

  bridge('game', () => game.onEvent((event) => emit('game:event', event)));

  /* ------------------------------------------------------------- CONTENU */

  handle('content:news', () => content.news());
  handle('content:status', () => content.status());
  handle('content:next-event', () => content.nextEvent());
  handle('content:votes', () => content.votes());
  handle('content:donations', () => content.donations());

  handle('content:donate', async (amountCents) => {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw fail('invalid_amount', 'Le montant du don est invalide.');
    }
    const session = await content.donateCheckout(amountCents);
    const url = session && session.checkout_url;
    if (!isHttpUrl(url)) {
      throw fail('checkout_unavailable', 'Le paiement est momentanément indisponible.');
    }
    await shell.openExternal(url);
  });

  /* --------------------------------------------------------- MISE À JOUR */

  handle('updater:check', () => updater.check());

  bridge('updater', () => updater.onEvent((event) => emit('updater:event', event)));

  /* ------------------------------------------------------------- JOURNAL */

  // Les lignes en direct sont diffusées par `logger.attach(win)` sur `log:line` :
  // ne rien rebrancher ici, sous peine de doublons dans la console du renderer.
  handle('log:history', () => logger.history());

  logger.info('Canaux IPC enregistrés.');
}

module.exports = { register };
