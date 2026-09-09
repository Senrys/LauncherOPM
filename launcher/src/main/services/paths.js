'use strict';

/**
 * Chemins du launcher — source unique de vérité pour tout le processus principal.
 *
 * Arborescence (voir docs/IPC.md § « Stockage local ») :
 *
 *   <userData>/opm-launcher/          userDir
 *     ├── config.json                 configFile   — LauncherConfig
 *     ├── accounts.json               accountsFile — comptes SANS jeton
 *     ├── vault.bin                   vaultFile    — refresh_token chiffrés (safeStorage)
 *     ├── cache/                      cacheDir     — news, statut, têtes de skin
 *     ├── logs/                       logsDir      — journal tournant 5 × 2 Mo
 *     └── game/                       gameDir      — installation du jeu (minecraft-java-core)
 *
 *   <appPath>/src/panels/             panelsDir    — HTML des panneaux (lecture seule)
 *
 * Les valeurs sont calculées à la demande puis mémorisées : `app.setPath('userData', …)`
 * effectué au démarrage en mode développement est donc toujours pris en compte, quel que
 * soit l'ordre des `require`.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

/** Nom du dossier de données du launcher, à l'intérieur du `userData` d'Electron. */
const NAMESPACE = 'opm-launcher';

/** Valeurs déjà calculées. */
const memo = new Map();

/**
 * Déclare une propriété calculée une seule fois, à la première lecture.
 * @param {string} key
 * @param {() => string} compute
 */
function define(key, compute) {
  Object.defineProperty(module.exports, key, {
    enumerable: true,
    configurable: false,
    get() {
      if (!memo.has(key)) memo.set(key, compute());
      return memo.get(key);
    },
  });
}

/** Racine des données utilisateur du launcher. */
define('userDir', () => path.join(app.getPath('userData'), NAMESPACE));

/** Dossier d'installation du jeu (passé à minecraft-java-core). */
define('gameDir', () => path.join(module.exports.userDir, 'game'));

/** Configuration locale du launcher (non sensible). */
define('configFile', () => path.join(module.exports.userDir, 'config.json'));

/** Comptes connus localement — ne contient jamais de jeton. */
define('accountsFile', () => path.join(module.exports.userDir, 'accounts.json'));

/** Coffre chiffré des `refresh_token` OPM. */
define('vaultFile', () => path.join(module.exports.userDir, 'vault.bin'));

/** Cache à durée de vie limitée (actualités, statut, têtes de skin). */
define('cacheDir', () => path.join(module.exports.userDir, 'cache'));

/** Journaux tournants. */
define('logsDir', () => path.join(module.exports.userDir, 'logs'));

/** Dossier des panneaux HTML embarqués dans l'application (lecture seule, peut être dans l'asar). */
define('panelsDir', () => path.join(app.getAppPath(), 'src', 'panels'));

/**
 * Crée les dossiers inscriptibles s'ils n'existent pas encore.
 * À appeler une fois, au tout début de `app.whenReady()`.
 * Ne touche pas à `panelsDir`, qui appartient au paquet applicatif.
 */
function ensureAll() {
  for (const dir of [
    module.exports.userDir,
    module.exports.gameDir,
    module.exports.cacheDir,
    module.exports.logsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports.ensureAll = ensureAll;
