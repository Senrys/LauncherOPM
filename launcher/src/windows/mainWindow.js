'use strict';

/**
 * Fenêtre principale du launcher.
 *
 * La maquette dessine sa propre barre de titre : la fenêtre est donc sans cadre
 * sur toutes les plateformes (`frame: false`, et `titleBarStyle: 'hidden'` sur macOS
 * pour conserver le comportement natif du plein écran).
 *
 * Gabarit : 1280 × 764, minimum 1100 × 700 (docs/UI-SPEC.md § 1.8).
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

const logger = require('../main/services/logger');

/** Dimensions issues de la maquette. */
const WIDTH = 1280;
const HEIGHT = 764;
const MIN_WIDTH = 1100;
const MIN_HEIGHT = 700;

/** Couleur peinte avant le premier rendu : la coque sombre du launcher (--abyss). */
const BACKGROUND = '#050D0C';

/** Canal d'information du renderer sur l'état maximisé (docs/IPC.md). */
const MAXIMIZE_CHANNEL = 'window:maximized';

/** Ouverture automatique des outils de développement (`npm run dev`). */
const DEV_TOOLS = process.env.DEV_TOOL === 'open';

/** @type {BrowserWindow|null} */
let win = null;

/** Icône de la fenêtre selon la plateforme. */
function iconPath() {
  const images = path.join(__dirname, '..', 'assets', 'images');
  if (process.platform === 'win32') return path.join(images, 'icon.ico');
  if (process.platform === 'darwin') return path.join(images, 'icon.icns');
  return path.join(images, 'icon.png');
}

/**
 * @returns {BrowserWindow|null} la fenêtre vivante, ou `null`
 */
function getWindow() {
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Crée la fenêtre principale (ou remonte celle qui existe déjà).
 * @returns {BrowserWindow}
 */
function create() {
  const existing = getWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }

  win = new BrowserWindow({
    title: app.getName(),
    width: WIDTH,
    height: HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    resizable: true,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    backgroundColor: BACKGROUND,
    show: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
      // La vidéo de fond et les jauges doivent continuer à tourner fenêtre réduite.
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);

  // Affichage seulement quand la première image est prête : pas de flash blanc.
  win.once('ready-to-show', () => {
    const live = getWindow();
    if (!live) return;
    live.show();
    if (DEV_TOOLS) live.webContents.openDevTools({ mode: 'detach' });
  });

  // Le renderer redessine son bouton « restaurer » d'après cet événement.
  win.on('maximize', () => send(MAXIMIZE_CHANNEL, true));
  win.on('unmaximize', () => send(MAXIMIZE_CHANNEL, false));

  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    logger.error(`Chargement de l'interface impossible (${code} ${description}) : ${url}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`Le rendu s'est interrompu : ${details.reason} (${details.exitCode}).`);
  });

  win.webContents.on('unresponsive', () => logger.warn("L'interface ne répond plus."));
  win.webContents.on('responsive', () => logger.info("L'interface répond de nouveau."));

  win.loadFile(path.join(__dirname, '..', 'launcher.html')).catch((err) => {
    logger.error("Impossible de charger launcher.html :", err);
  });

  return win;
}

/**
 * Envoie un message au renderer si la fenêtre est encore vivante.
 * @param {string} channel
 * @param {...unknown} args
 */
function send(channel, ...args) {
  const live = getWindow();
  if (!live) return;
  const wc = live.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send(channel, ...args);
}

/** Ferme et libère la fenêtre. */
function destroy() {
  const live = getWindow();
  if (live) live.destroy();
  win = null;
}

module.exports = { create, getWindow, destroy };
