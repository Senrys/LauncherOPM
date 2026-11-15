'use strict';

/**
 * Le pont entre le launcher et le jeu — ce que le launcher prépare juste avant
 * de démarrer Minecraft, et ce qu'il lit dans sa sortie ensuite.
 *
 * Avant le démarrage (`prepareContext`, puis `beforeStart` une fois les fichiers
 * vérifiés) :
 *
 *   - **la redirection d'authentification** : le client Minecraft doit annoncer
 *     son arrivée (`join`) à NOTRE serveur d'authentification, pas à Mojang.
 *     authlib-injector (embarqué par le launcher, `authlib-injector.jar` à la racine
 *     de l'instance, embarqué par le launcher) s'en charge et fait aussi accepter nos skins signés ; à
 *     défaut, les propriétés système d'authlib redirigent au moins le `join` ;
 *   - **la connexion directe** : `--quickPlayMultiplayer`, le jeu entre sur le
 *     serveur OPM sans passer par l'écran titre ;
 *   - **le fichier de session** `opm/session.json`, lu par le mod OPM du modpack
 *     (état de Xenodys, pseudo, serveur, galerie de skins…). Aucun jeton n'y
 *     figure : un fichier du dossier de jeu n'est pas un coffre ;
 *   - **la fenêtre de chargement de NeoForge** (`config/fml.toml`,
 *     `earlyWindowControl`) : désactivée quand le launcher couvre lui-même le
 *     chargement des mods (fenêtre ouverte et mod OPM présent).
 *
 * Pendant le démarrage (`readLine`) : la progression du chargement, devinée dans
 * le journal de NeoForge puis annoncée explicitement par le mod (`[OPM:…]`).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const logger = require('./logger');

/** Format du fichier de session (`opm/session.json`), lu par le mod. */
const SESSION_FORMAT = 1;
/** Le mod OPM du modpack : `opm-<version>.jar` dans `mods/`. */
const MOD_FILE = /^opm-\d[\w.+-]*\.jar$/i;
/** authlib-injector, posé par le modpack à la racine de l'instance. */
const INJECTOR_FILE = 'authlib-injector.jar';
/** Serveur de jeu, à défaut de `bootstrap.server`. */
const DEFAULT_SERVER = { host: 'play.onepieceminecraft.fr', port: 25565 };
/** Délai maximal de chacune des lectures de contexte : elles ne retardent jamais JOUER. */
const CONTEXT_TIMEOUT_MS = 3_000;
/**
 * Part de la barre de chargement couverte par le launcher. Le mod reprend la
 * barre à cette valeur quand son écran s'affiche (`progression_depart`) : d'une
 * fenêtre à l'autre, la barre ne recule jamais.
 */
const LAUNCHER_SHARE = 0.4;

/* ------------------------------------------------------------------ contexte */

/** Une promesse, ou `fallback` passé `ms`. Ne rejette jamais. */
function settle(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(promise)
      .then((value) => resolve(value ?? fallback))
      .catch(() => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}

/** Adresse du serveur de jeu, validée. */
function serverOf(bootstrap) {
  const server = bootstrap && typeof bootstrap === 'object' ? bootstrap.server : null;
  const host = typeof server?.host === 'string' ? server.host.trim() : '';
  const port = Number.isInteger(server?.port) && server.port > 0 && server.port < 65536 ? server.port : 25565;
  if (!host || !/^[a-z0-9.-]{1,253}$/i.test(host)) return { ...DEFAULT_SERVER };
  return { host, port };
}

/**
 * Les skins de la galerie, téléchargés ici et transmis à la scène en data: URL :
 * la page du launcher peut alors lire leurs pixels (le rendu en volume des
 * joueurs imprimés), ce qu'une image d'un autre domaine lui interdirait.
 * @param {{url: string, slim: boolean}[]} list
 */
async function inlineSkins(list) {
  // Dans l'ordre de la galerie, places vides comprises : le mod imprime les
  // mêmes skins dans le même ordre (la chorégraphie est commune).
  const out = await Promise.all(
    list.map(async (s) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CONTEXT_TIMEOUT_MS);
        const res = await fetch(s.url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 512 * 1024 || buf.subarray(1, 4).toString() !== 'PNG') return null;
        return { url: s.url, slim: s.slim, data: `data:image/png;base64,${buf.toString('base64')}` };
      } catch {
        return null;
      }
    })
  );
  return out.map((s, i) => s || { url: list[i].url, slim: list[i].slim, data: null });
}

/** Galerie de skins : URL https uniquement, 32 au plus. */
function galleryOf(payload) {
  const list = Array.isArray(payload?.skins) ? payload.skins : [];
  return list
    .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//.test(s.url) && s.url.length < 512)
    .slice(0, 32)
    .map((s) => ({ url: s.url, slim: Boolean(s.slim) }));
}

/**
 * Ce que le launcher sait du monde au moment du clic : serveur, Xenodys, skins.
 * Chaque lecture est bornée et tolère l'échec : JOUER ne dépend d'aucune d'elles.
 * @returns {Promise<{server: {host: string, port: number}, etat: string, message: string|null, gallery: object[]}>}
 */
async function prepareContext() {
  const api = require('../auth/api');
  const content = require('./content');
  const [bootstrap, xenodys, gallery] = await Promise.all([
    settle(api.bootstrap(), CONTEXT_TIMEOUT_MS, null),
    settle(content.xenodys(), CONTEXT_TIMEOUT_MS, null),
    settle(api.skinGallery(), CONTEXT_TIMEOUT_MS, null),
  ]);
  // Douze skins au plus, déjà tirés au hasard par le serveur : le même ordre pour
  // la scène du launcher et pour le mod (opm/session.json).
  const skins = galleryOf(gallery).slice(0, 12);
  const links = bootstrap && typeof bootstrap.links === 'object' && bootstrap.links ? bootstrap.links : {};
  const https = (u) => (typeof u === 'string' && /^https:\/\//.test(u) && u.length < 300 ? u : null);
  return {
    server: serverOf(bootstrap),
    etat: xenodys?.etat === 'corrompue' ? 'corrompue' : 'creatrice',
    message: typeof xenodys?.message === 'string' ? xenodys.message.slice(0, 280) : null,
    gallery: skins,
    inline: await inlineSkins(skins),
    links: { site: https(links.website), discord: https(links.discord) },
  };
}

/* ------------------------------------------------------------------ fichiers */

/** Les fichiers du jeu embarqués dans le launcher (game-files.js → src/game/). */
const GAME_DIR = path.join(__dirname, '..', '..', 'game');

function gameManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(GAME_DIR, 'fichiers.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Chemins (relatifs à l'instance) que la vérification des fichiers du modpack
 * ne doit pas supprimer : ce sont ceux que le launcher pose lui-même.
 * @returns {string[]}
 */
function ownedPaths() {
  const m = gameManifest();
  // `downloads` : le pack de ressources du serveur, que Minecraft garde en cache.
  // Effacé à chaque lancement, il serait retéléchargé à chaque connexion.
  return ['opm', 'config/fml.toml', 'downloads', INJECTOR_FILE, ...(m.mod ? [`mods/${m.mod.fichier}`] : [])];
}

async function sameFile(file, sha) {
  try {
    const data = await fsp.readFile(file);
    return require('crypto').createHash('sha256').update(data).digest('hex') === sha;
  } catch {
    return false;
  }
}

/**
 * Pose le mod OPM et authlib-injector dans l'instance, s'ils manquent ou ont
 * changé ; retire les anciennes versions du mod. Rien à déposer sur le serveur :
 * ils voyagent avec le launcher.
 * @param {string} instanceDir
 */
async function installGameFiles(instanceDir) {
  const m = gameManifest();
  if (m.authlib) {
    const target = path.join(instanceDir, INJECTOR_FILE);
    if (!(await sameFile(target, m.authlib.sha256))) {
      await fsp.writeFile(target, await fsp.readFile(path.join(GAME_DIR, m.authlib.fichier)));
      logger.info(`authlib-injector ${m.authlib.version} installé dans le jeu.`);
    }
  }
  if (m.mod) {
    const mods = path.join(instanceDir, 'mods');
    await fsp.mkdir(mods, { recursive: true });
    for (const f of await fsp.readdir(mods)) {
      if (MOD_FILE.test(f) && f !== m.mod.fichier) await fsp.rm(path.join(mods, f), { force: true });
    }
    const target = path.join(mods, m.mod.fichier);
    if (!(await sameFile(target, m.mod.sha256))) {
      await fsp.writeFile(target, await fsp.readFile(path.join(GAME_DIR, m.mod.fichier)));
      logger.info(`Mod OPM ${m.mod.fichier} installé dans le jeu.`);
    }
  }
}

/** Le mod OPM est-il installé dans cette instance ? */
function hasOpmMod(instanceDir) {
  try {
    return fs.readdirSync(path.join(instanceDir, 'mods')).some((f) => MOD_FILE.test(f));
  } catch {
    return false;
  }
}

/**
 * Arguments JVM de la redirection d'authentification.
 * @param {string} instanceDir
 * @param {string} apiBase  racine du serveur d'authentification (https://…)
 * @returns {string[]}
 */
function authArguments(instanceDir, apiBase) {
  const root = `${apiBase.replace(/\/+$/, '')}/yggdrasil`;
  const injector = path.join(instanceDir, INJECTOR_FILE);
  if (fs.existsSync(injector)) {
    // Avant tout le reste : l'agent doit être chargé avant les classes du jeu.
    return [`-javaagent:${injector}=${root}`];
  }
  logger.warn(
    `${INJECTOR_FILE} absent du modpack : redirection minimale (connexion au serveur, ` +
      'sans les skins signés). Déposez-le à la racine des fichiers du modpack.'
  );
  // authlib (Mojang) lit ces quatre propriétés : seule `session.host` sert au
  // `join` ; les autres doivent exister pour que la redirection soit prise.
  return [
    `-Dminecraft.api.session.host=${root}/sessionserver`,
    `-Dminecraft.api.auth.host=${root}/authserver`,
    `-Dminecraft.api.account.host=${root}/api`,
    `-Dminecraft.api.services.host=${root}/minecraftservices`,
  ];
}

/**
 * Arguments de jeu de la connexion directe.
 * @param {{host: string, port: number}} server
 * @returns {string[]}
 */
function directConnectArguments(server) {
  const address = server.port === 25565 ? server.host : `${server.host}:${server.port}`;
  return ['--quickPlayMultiplayer', address];
}

/**
 * Écrit `opm/session.json` dans l'instance, pour le mod OPM.
 * @param {string} instanceDir
 * @param {object} data
 */
async function writeSession(instanceDir, data) {
  const dir = path.join(instanceDir, 'opm');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.json');
  const payload = {
    format: SESSION_FORMAT,
    launcher: data.launcherVersion,
    cree_le: new Date().toISOString(),
    etat: data.etat,
    message: data.message,
    joueur: { nom: data.name || null, uuid: data.uuid || null },
    serveur: { hote: data.server.host, port: data.server.port },
    connexion_directe: Boolean(data.direct),
    animations: Boolean(data.animations),
    api: data.apiBase,
    progression_depart: data.scene ? LAUNCHER_SHARE : 0,
    // L'horloge de la scène de chargement (ms) : le mod reprend la chorégraphie
    // du launcher là où elle en est.
    scene_debut: data.sceneEpoch || 0,
    galerie: data.gallery,
    liens: data.links,
  };
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * Règle `earlyWindowControl` dans `config/fml.toml`, sans toucher au reste.
 * NeoForge complète lui-même les clés absentes : un fichier neuf ne contient
 * que celle-ci.
 * @param {string} instanceDir
 * @param {boolean} earlyWindow  vrai pour la fenêtre de chargement de NeoForge
 */
async function setEarlyWindow(instanceDir, earlyWindow) {
  const file = path.join(instanceDir, 'config', 'fml.toml');
  const line = `earlyWindowControl = ${earlyWindow ? 'true' : 'false'}`;
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    /* fichier absent : on le crée */
  }
  const pattern = /^\s*earlyWindowControl\s*=.*$/m;
  const next = pattern.test(text) ? text.replace(pattern, line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  if (next === text) return;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, next, 'utf8');
}

/* ------------------------------------------------------------------ journal */

/**
 * Étapes du chargement reconnues dans le journal de NeoForge et de Minecraft,
 * avant que le mod ne prenne la parole. Les valeurs sont des fractions de
 * `LAUNCHER_SHARE` : la barre du launcher s'arrête où celle du mod commence.
 */
const MILESTONES = [
  { re: /ModLauncher running/, at: 0.08, step: 'Éveil de la simulation' },
  { re: /Loading ImmediateWindowProvider|Launching target/, at: 0.22, step: 'Recensement des mondes connus' },
  { re: /Setting user:/, at: 0.35, step: 'Identification de l’aventurier' },
  { re: /Backend library:/, at: 0.55, step: 'Ouverture de la fenêtre sur Grand Line' },
  { re: /\[OPM:HELLO\]/, at: 0.7, step: 'Xenodys prend la main' },
  { re: /Reloading ResourceManager/, at: 0.9, step: 'Assemblage des blocs du monde' },
];

/**
 * Interprète une ligne de la sortie du jeu.
 * @param {string} line
 * @returns {null | {kind: 'progress', ratio: number, step: string} | {kind: 'ready'} | {kind: 'music'}}
 */
function readLine(line) {
  if (line.includes('[OPM:READY]')) return { kind: 'ready' };
  if (line.includes('[OPM:MUSIC]')) return { kind: 'music' };
  for (const m of MILESTONES) {
    if (m.re.test(line)) return { kind: 'progress', ratio: m.at * LAUNCHER_SHARE, step: m.step };
  }
  return null;
}

/* ------------------------------------------------------------------ anti-triche */

const sha1File = (file) =>
  new Promise((resolve, reject) => {
    const hash = require('crypto').createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });

/**
 * L'empreinte des fichiers du jeu, juste avant le démarrage : les mods (chemin,
 * SHA-1) et les packs de ressources de l'instance, comparés au modpack officiel
 * (`files.json` de l'instance). Le mod OPM, posé par le launcher, est attendu en
 * plus. Le serveur d'authentification refait la comparaison de son côté
 * (`POST /api/v1/game/attest`) : c'est lui qui ouvre, ou non, le serveur de jeu.
 *
 * @param {string} instanceDir
 * @param {string} manifestUrl  `files.json` de l'instance
 * @returns {Promise<{mods: {path: string, sha1: string}[], packs: string[], extra: string[], modified: string[], verified: boolean}>}
 */
async function fingerprint(instanceDir, manifestUrl) {
  const modsDir = path.join(instanceDir, 'mods');
  let names = [];
  try {
    names = (await fsp.readdir(modsDir)).filter((f) => f.toLowerCase().endsWith('.jar'));
  } catch {
    names = [];
  }
  const mods = [];
  for (const name of names) {
    try {
      mods.push({ path: `mods/${name}`, sha1: await sha1File(path.join(modsDir, name)) });
    } catch {
      /* fichier verrouillé : il sera signalé côté serveur */
    }
  }
  let packs = [];
  try {
    packs = (await fsp.readdir(path.join(instanceDir, 'resourcepacks'))).slice(0, 200);
  } catch {
    packs = [];
  }

  let official = null;
  try {
    const res = await settle(fetch(manifestUrl), CONTEXT_TIMEOUT_MS * 2, null);
    if (res && res.ok) {
      const list = await res.json();
      official = new Map();
      for (const e of Array.isArray(list) ? list : []) {
        const p = String(e?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (p.startsWith('mods/') && p.endsWith('.jar')) official.set(p, String(e.hash || '').toLowerCase());
      }
    }
  } catch {
    official = null;
  }
  const extra = [];
  const modified = [];
  if (official) {
    for (const m of mods) {
      if (/^mods\/opm-\d[\w.+-]*\.jar$/i.test(m.path)) continue;
      if (!official.has(m.path)) extra.push(m.path);
      else if (official.get(m.path) && official.get(m.path) !== m.sha1) modified.push(m.path);
    }
  }
  return { mods, packs, extra, modified, verified: Boolean(official) };
}

/* ------------------------------------------------------------------ durée du chargement */

/**
 * Ce qu'a duré le dernier chargement du jeu (lignes du journal et millisecondes
 * jusqu'à l'écran du mod) : la barre avance au prorata, sans rester bloquée
 * pendant les longues minutes où NeoForge charge les mods sans rien dire de
 * reconnaissable.
 */
function loadStatsFile() {
  return path.join(require('./paths').cacheDir, 'chargement-jeu.json');
}

function readLoadStats() {
  try {
    const s = JSON.parse(fs.readFileSync(loadStatsFile(), 'utf8'));
    if (s.lines > 50 && s.ms > 3000) return s;
  } catch {
    /* premier lancement */
  }
  return { lines: 2500, ms: 60_000 };
}

function writeLoadStats(lines, ms) {
  try {
    fs.mkdirSync(path.dirname(loadStatsFile()), { recursive: true });
    fs.writeFileSync(loadStatsFile(), JSON.stringify({ lines, ms }));
  } catch {
    /* sans conséquence */
  }
}

module.exports = {
  LAUNCHER_SHARE,
  readLoadStats,
  writeLoadStats,
  fingerprint,
  installGameFiles,
  ownedPaths,
  prepareContext,
  hasOpmMod,
  authArguments,
  directConnectArguments,
  writeSession,
  setEarlyWindow,
  readLine,
};
