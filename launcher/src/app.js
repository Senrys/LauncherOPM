'use strict';

/**
 * OPM Launcher — point d'entrée du processus principal.
 *
 * Responsabilités de ce fichier, et de lui seul :
 *   - isoler les données en mode développement ;
 *   - garantir une seule instance du launcher ;
 *   - poser la politique de sécurité (aucune fenêtre surgissante, aucune navigation
 *     hors de l'application, aucune permission web accordée par défaut, pas de menu) ;
 *   - démarrer le journal, les canaux IPC, la fenêtre principale et les comptes.
 *
 * Tout le reste vit dans `src/main/*` (services) et `src/windows/*` (fenêtres).
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, session, shell } = require('electron');

/** `npm start` et `npm run dev` positionnent NODE_ENV=development. */
const DEV = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev';

/**
 * En développement, les données restent dans `./data` à côté des sources :
 * on ne pollue pas le profil utilisateur et on peut tout effacer d'un coup.
 * Doit avoir lieu AVANT le chargement des modules qui dérivent leurs chemins de `userData`.
 */
if (DEV) {
  const dataDir = path.join(app.getAppPath(), 'data');
  const userDataDir = path.join(dataDir, 'Launcher');
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('appData', dataDir);
  app.setPath('userData', userDataDir);
}

const paths = require('./main/services/paths');
const logger = require('./main/services/logger');
const ipc = require('./main/ipc');
const mainWindow = require('./windows/mainWindow');
const accounts = require('./main/auth/accounts');
const api = require('./main/auth/api');
const store = require('./main/services/store');
const updater = require('./main/services/updater');

/** Identifiant Windows : regroupement dans la barre des tâches et notifications. */
const APP_USER_MODEL_ID = 'fr.onepieceminecraft.launcher';

/**
 * Délai avant la vérification de mise à jour du launcher. Le splash enchaîne déjà
 * `bootstrap`, les sessions et les actualités : la mise à jour attend son tour, elle n'a
 * aucune raison de disputer la bande passante au démarrage.
 */
const UPDATE_CHECK_DELAY_MS = 8_000;

/**
 * Permissions web tolérées dans le launcher. Tout le reste (caméra, micro,
 * géolocalisation, MIDI, périphériques USB…) est refusé sans discussion.
 */
const ALLOWED_PERMISSIONS = new Set([
  'notifications',            // notifications d'événements RP
  'clipboard-sanitized-write', // bouton « COPIER » du code Microsoft
  'fullscreen',
]);

/* ------------------------------------------------------------------ sécurité */

/**
 * Seuls les liens http(s) sont ouverts à l'extérieur : `shell.openExternal` accepte
 * sinon n'importe quel protocole enregistré sur la machine.
 * (Même règle que `src/main/ipc.js` — chaque module reste autonome.)
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
 * Une URL est « interne » si elle pointe vers un fichier du paquet applicatif.
 * @param {string} target
 */
function isInternalUrl(target) {
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== 'file:') return false;
    const decoded = decodeURIComponent(parsed.pathname).replace(/^\/([A-Za-z]:)/, '$1');
    const resolved = path.resolve(decoded);
    const root = path.resolve(app.getAppPath());
    const inside = resolved === root || resolved.startsWith(root + path.sep);
    return inside;
  } catch {
    return false;
  }
}

/** Ouvre un lien dans le navigateur du système, après validation. */
function openExternal(url) {
  if (!isHttpUrl(url)) {
    logger.warn(`Lien externe refusé : ${String(url).slice(0, 120)}`);
    return;
  }
  shell.openExternal(url).catch((err) => logger.error("Ouverture du lien impossible :", err));
}

/**
 * Politique appliquée à toute page web créée par l'application.
 *
 * La navigation n'est verrouillée que pour la fenêtre principale : la fenêtre
 * d'authentification Microsoft (`src/main/auth/microsoft.js`) doit, elle, pouvoir
 * naviguer librement sur login.live.com.
 */
function applyWebContentsPolicy() {
  app.on('web-contents-created', (_event, contents) => {
    // Aucune fenêtre surgissante : les liens partent vers le navigateur système.
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });

    // Aucune <webview> imbriquée.
    contents.on('will-attach-webview', (event) => event.preventDefault());

    contents.on('will-navigate', (event, url) => {
      const owner = BrowserWindow.fromWebContents(contents);
      if (!owner || owner !== mainWindow.getWindow()) return;
      if (isInternalUrl(url)) return;
      event.preventDefault();
      openExternal(url);
    });
  });
}

/** Refuse par défaut toutes les permissions web sensibles. */
function applySessionPolicy() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    if (!allowed) logger.warn(`Permission web refusée : ${permission}`);
    callback(allowed);
  });

  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
}

/* ------------------------------------------------------------------ mise à jour */

/**
 * Programme la vérification de mise à jour du launcher, peu après le démarrage.
 *
 * C'est le seul déclencheur automatique du projet : le canal `updater:check` reste ouvert au
 * renderer pour une vérification à la demande, mais personne ne doit vérifier deux fois.
 *
 * Le réglage « Mises à jour automatiques » (`launcher.auto_update`) commande réellement ce
 * déclencheur : décoché, le launcher ne va rien chercher de lui-même. `updater.check()`
 * relit de toute façon le même réglage avant de télécharger quoi que ce soit.
 *
 * Rien de tout cela ne peut retarder ni empêcher le démarrage : la minuterie est détachée
 * (`unref`) et toute erreur est absorbée — le launcher doit démarrer et laisser jouer, même
 * quand le serveur de mises à jour est en panne.
 */
function scheduleUpdateCheck() {
  let auto = true;
  try {
    auto = store.getConfig().launcher.auto_update !== false;
  } catch (err) {
    logger.warn('Réglage des mises à jour illisible : vérification tout de même programmée.', err);
  }

  if (!auto) {
    logger.info('Mises à jour automatiques désactivées : aucune vérification au démarrage.');
    return;
  }

  const timer = setTimeout(() => {
    updater.check().catch((err) => logger.error('Vérification de mise à jour impossible :', err));
  }, UPDATE_CHECK_DELAY_MS);

  if (typeof timer.unref === 'function') timer.unref();
}

/* ------------------------------------------------------------------ démarrage */

/** Ramène la fenêtre existante au premier plan (deuxième lancement, clic sur l'icône). */
function focusWindow() {
  const win = mainWindow.getWindow();
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}

/** Séquence de démarrage, une fois Electron prêt. */
async function start() {
  paths.ensureAll();

  logger.info(
    `OPM Launcher ${app.getVersion()} — démarrage sur ${process.platform} ` +
      `(Electron ${process.versions.electron}, Node ${process.versions.node})`
  );
  if (DEV) logger.info(`Mode développement — données dans ${paths.userDir}`);

  applySessionPolicy();

  // La base d'API peut être redirigée à l'exécution (développement, pré-production).
  if (process.env.OPM_API_URL) {
    try {
      api.setBaseUrl(process.env.OPM_API_URL);
      logger.info(`Serveur d'authentification : ${api.baseUrl()}`);
    } catch (err) {
      logger.error("OPM_API_URL ignorée :", err);
    }
  }

  // Les canaux doivent exister avant que le renderer ne commence à les appeler.
  ipc.register(mainWindow.getWindow);

  const win = mainWindow.create();
  logger.attach(win);

  // Chargement des comptes locaux : l'interface affiche son splash pendant ce temps.
  try {
    await accounts.init();
  } catch (err) {
    logger.error("Initialisation des comptes impossible :", err);
  }

  // En dernier, et jamais de façon bloquante : la mise à jour du launcher lui-même.
  scheduleUpdateCheck();
}

/* ------------------------------------------------------------------ amorçage */

if (!app.requestSingleInstanceLock()) {
  // Une autre instance tourne déjà : elle recevra `second-instance` et se montrera.
  app.quit();
} else {
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

  applyWebContentsPolicy();

  app.on('second-instance', () => {
    focusWindow();
  });

  app.on('window-all-closed', () => {
    // Sur macOS l'application survit à la fermeture de sa fenêtre (comportement natif).
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (focusWindow()) return;
    logger.attach(mainWindow.create());
  });

  app.on('before-quit', () => logger.info('Arrêt du launcher.'));

  process.on('uncaughtException', (err) => logger.error('Exception non interceptée :', err));
  process.on('unhandledRejection', (reason) => logger.error('Promesse rejetée :', reason));

  app.whenReady().then(start).catch((err) => {
    logger.error('Démarrage impossible :', err);
    app.quit();
  });
}
