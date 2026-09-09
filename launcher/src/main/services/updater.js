'use strict';

/**
 * Mise à jour du launcher — enveloppe d'`electron-updater`.
 *
 * Principe : **rien ne se télécharge sans notre accord** (`autoDownload = false`).
 * `check()` interroge le serveur de publication, puis, si une version plus récente
 * existe *et* que le joueur a laissé les mises à jour automatiques actives, la
 * télécharge en tâche de fond. L'installation, elle, attend la fermeture du launcher
 * (`autoInstallOnAppQuit`) : on n'interrompt jamais une partie ni un téléchargement
 * de jeu en cours.
 *
 * Rien ici n'est bloquant. Une panne du serveur de mises à jour, un fichier de
 * publication absent ou une signature invalide sont journalisés et signalés à
 * l'interface (`UpdaterEvent` de docs/IPC.md), jamais fatals : le launcher doit
 * démarrer et laisser jouer, même quand la mise à jour échoue.
 */

const { app } = require('electron');

const logger = require('./logger');
const store = require('./store');

/* ------------------------------------------------------------------ état interne */

/** Abonnés au flux d'événements. */
const listeners = new Set();

/** @type {import('electron-updater').AppUpdater|null} instance branchée, chargée à la demande. */
let updater = null;

/** @type {Promise<void>|null} vérification en cours — une seule à la fois. */
let pending = null;

/** Version proposée par la dernière vérification, `null` si le launcher est à jour. */
let availableVersion = null;

/** Version déjà téléchargée et prête à s'installer au prochain démarrage. */
let downloadedVersion = null;

/* ------------------------------------------------------------------ diffusion */

/**
 * Abonnement au flux d'événements de mise à jour (format `UpdaterEvent` de docs/IPC.md).
 * @param {(event: object) => void} cb
 * @returns {() => void} fonction de désabonnement
 */
function onEvent(cb) {
  if (typeof cb !== 'function') throw new TypeError('updater.onEvent attend une fonction.');
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Diffuse un événement. Un abonné en erreur ne doit jamais interrompre la mise à jour.
 * @param {object} event
 */
function emit(event) {
  for (const cb of listeners) {
    try {
      cb(event);
    } catch (err) {
      logger.error('Abonné aux événements de mise à jour en erreur :', err);
    }
  }
}

/* ------------------------------------------------------------------ utilitaires */

/** Texte lisible d'une erreur d'`electron-updater`. */
function messageOf(err) {
  if (!err) return 'La mise à jour a échoué sans message.';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

/** Numéro de version porté par une notification d'`electron-updater`. */
function versionOf(info) {
  return info && typeof info.version === 'string' ? info.version : '';
}

/* ------------------------------------------------------------------ branchement */

/**
 * Charge `electron-updater` et branche ses événements sur les nôtres.
 * Le chargement est différé : la bibliothèque lit l'état de l'application au premier
 * `require`, elle ne doit donc pas être évaluée avant qu'Electron soit prêt.
 * @returns {import('electron-updater').AppUpdater}
 */
function instance() {
  if (updater) return updater;

  const { autoUpdater } = require('electron-updater');

  autoUpdater.autoDownload = false; // rien ne part sans décision explicite
  autoUpdater.autoInstallOnAppQuit = true; // installation au redémarrage, pas en pleine partie

  // Les traces de la bibliothèque rejoignent le journal du launcher ; le niveau
  // « debug » est écarté, il n'apporterait que du bruit dans la console du joueur.
  autoUpdater.logger = {
    info: (message) => logger.info('Mise à jour :', message),
    warn: (message) => logger.warn('Mise à jour :', message),
    error: (message) => logger.error('Mise à jour :', message),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => emit({ type: 'checking' }));

  autoUpdater.on('update-available', (info) => {
    availableVersion = versionOf(info) || null;
    logger.info(`Version ${availableVersion ?? 'inconnue'} disponible.`);
    emit({ type: 'available', version: availableVersion ?? '' });
  });

  autoUpdater.on('update-not-available', () => {
    availableVersion = null;
    emit({ type: 'none' });
  });

  autoUpdater.on('download-progress', (progress) => {
    emit({
      type: 'progress',
      transferred: Math.round(Number(progress?.transferred) || 0),
      total: Math.round(Number(progress?.total) || 0),
      percent: Math.min(100, Math.max(0, Math.round(Number(progress?.percent) || 0))),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = versionOf(info) || availableVersion;
    logger.info(`Version ${downloadedVersion ?? 'inconnue'} téléchargée : elle s'installera au redémarrage.`);
    emit({ type: 'downloaded' });
  });

  autoUpdater.on('error', (err) => {
    logger.error('Mise à jour impossible :', err);
    emit({ type: 'error', message: messageOf(err) });
  });

  updater = autoUpdater;
  return updater;
}

/* ------------------------------------------------------------------ vérification */

/**
 * Déroulé d'une vérification. Ne lève jamais : toute erreur devient un événement.
 * @returns {Promise<void>}
 */
async function run() {
  try {
    const auto = instance();
    availableVersion = null;

    await auto.checkForUpdates();

    if (!availableVersion) return; // à jour : l'événement « none » a déjà été diffusé

    if (downloadedVersion === availableVersion) {
      // Déjà récupérée lors d'une vérification précédente : inutile de recommencer.
      emit({ type: 'downloaded' });
      return;
    }

    if (!store.getConfig().launcher.auto_update) {
      logger.info(
        `Mises à jour automatiques désactivées : la version ${availableVersion} ne sera pas téléchargée.`
      );
      return;
    }

    await auto.downloadUpdate();
  } catch (err) {
    logger.error('Mise à jour impossible :', err);
    emit({ type: 'error', message: messageOf(err) });
  }
}

/**
 * Vérifie l'existence d'une nouvelle version du launcher, puis la télécharge si les
 * mises à jour automatiques sont actives. Les appels concurrents partagent la même
 * vérification.
 * @returns {Promise<void>}
 */
async function check() {
  // Hors application empaquetée, il n'existe aucune information de publication :
  // vérifier n'aurait aucun sens et ferait échouer la bibliothèque à chaque démarrage.
  if (!app.isPackaged) {
    logger.info('Mise à jour ignorée : le launcher tourne depuis les sources.');
    emit({ type: 'none' });
    return;
  }

  if (!pending) {
    pending = run().finally(() => {
      pending = null;
    });
  }
  return pending;
}

module.exports = { check, onEvent };
