'use strict';

/**
 * Fenêtre principale du launcher.
 *
 * La maquette dessine sa propre barre de titre : la fenêtre est donc sans cadre
 * sur toutes les plateformes (`frame: false`), et ses boutons Réduire, Agrandir
 * et Fermer sont ceux de l'interface.
 *
 * Deux modes :
 *
 *   - **compact** : la fenêtre EST le launcher, 1280 × 764 (minimum
 *     1100 × 700, docs/UI-SPEC.md § 1.8), redimensionnable par ses bords.
 *
 *   - **ouvert** : la fenêtre est TRANSPARENTE et plus grande que le launcher.
 *     Le launcher est dessiné au milieu, et la marge autour accueille le décor
 *     de Xenodys — cubes, circuits, éclats — et Xenodys elle-même, qui déborde
 *     du cadre. Les clics sur la marge vide traversent jusqu'au bureau
 *     (`setIgnoreMouseEvents`, piloté par le renderer). Une fenêtre
 *     transparente ne se redimensionne pas par ses bords : le launcher dessine
 *     sa propre poignée, et « Agrandir » est géré ici.
 *
 * Le mode ouvert est le choix par défaut (réglage `launcher.window_open`), sauf
 * là où il ne peut pas bien fonctionner : sous Linux (transparence et clics
 * traversants dépendent du gestionnaire de fenêtres), et sur un écran trop
 * petit pour le cadre et sa marge. On retombe alors sur le mode compact, sans
 * toucher au réglage.
 */

const { app, BrowserWindow, screen } = require('electron');
const path = require('path');

const logger = require('../main/services/logger');

/** Dimensions issues de la maquette. */
const WIDTH = 1280;
const HEIGHT = 764;
const MIN_WIDTH = 1100;
const MIN_HEIGHT = 700;

/** Couleur peinte avant le premier rendu : la coque sombre du launcher (--abyss). */
const BACKGROUND = '#050D0C';

/**
 * Marge autour du launcher en mode ouvert, en pixels : idéale, et minimale en
 * deçà de laquelle on préfère le mode compact. À droite, la plus large : c'est
 * là que se tient Xenodys, à cheval sur le bord du cadre.
 */
const MARGIN_IDEAL = Object.freeze({ top: 72, right: 440, bottom: 56, left: 96 });
const MARGIN_MIN = Object.freeze({ top: 28, right: 200, bottom: 28, left: 40 });

/** Marge de la fenêtre courante (mode ouvert). */
let margin = { ...MARGIN_IDEAL };

/** Mode retenu pour la fenêtre courante : 'ouvert' | 'compact'. */
let mode = 'compact';

/** Bornes d'avant « Agrandir », en mode ouvert (la fenêtre native ne s'agrandit pas). */
let restoreBounds = null;

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
 * Choisit le mode et la taille du cadre pour l'écran courant.
 *
 * @param {boolean} wantsOpen  préférence de l'utilisateur
 * @returns {{mode: 'ouvert'|'compact', frame: {width: number, height: number}, reason: string}}
 */
function decideLayout(wantsOpen) {
  const compact = (reason) => ({ mode: 'compact', frame: { width: WIDTH, height: HEIGHT }, margin: null, reason });
  if (!wantsOpen) return compact('préférence de l’utilisateur');
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return compact('fenêtre transparente non prise en charge sur ce système');
  }

  const work = screen.getPrimaryDisplay().workAreaSize;
  // Le cadre d'abord (taille idéale si possible), la marge se partage le reste.
  const fit = (total, size, min, a, b) => {
    const frame = Math.max(min, Math.min(size, total - MARGIN_IDEAL[a] - MARGIN_IDEAL[b]));
    const room = total - frame;
    if (room < MARGIN_MIN[a] + MARGIN_MIN[b]) return null;
    const share = MARGIN_IDEAL[a] / (MARGIN_IDEAL[a] + MARGIN_IDEAL[b]);
    let first = Math.min(MARGIN_IDEAL[a], Math.max(MARGIN_MIN[a], Math.round(room * share)));
    let second = Math.min(MARGIN_IDEAL[b], room - first);
    if (second < MARGIN_MIN[b]) {
      second = MARGIN_MIN[b];
      first = room - second;
    }
    return { frame, first, second };
  };

  const h = fit(work.width, WIDTH, MIN_WIDTH, 'right', 'left');
  const v = fit(work.height, HEIGHT, MIN_HEIGHT, 'top', 'bottom');
  if (!h || !v) {
    return compact(`écran trop petit (${work.width} × ${work.height}) pour le cadre et son décor`);
  }
  // Tout en multiples de 4 : la grille du décor pixelisé (components/surround.js)
  // tombe pile sur les bords du cadre.
  const four = (n) => Math.floor(n / 4) * 4;
  h.frame = four(h.frame);
  v.frame = four(v.frame);
  h.second = four(h.second);
  v.first = four(v.first);
  h.first = four(work.width - h.frame - h.second);
  v.second = four(work.height - v.frame - v.first);
  return {
    mode: 'ouvert',
    frame: { width: h.frame, height: v.frame },
    margin: { top: v.first, right: h.first, bottom: v.second, left: h.second },
    reason: '',
  };
}

/** @returns {'ouvert'|'compact'} le mode de la fenêtre courante */
function windowMode() {
  return mode;
}

/**
 * Taille du cadre du launcher demandée par la poignée de redimensionnement
 * (mode ouvert). Bornée par le minimum du launcher et par l'écran.
 * @param {number} frameWidth
 * @param {number} frameHeight
 */
function resizeFrame(frameWidth, frameHeight) {
  const live = getWindow();
  if (!live || mode !== 'ouvert') return;
  const work = screen.getDisplayMatching(live.getBounds()).workArea;
  const maxW = work.width - margin.left - margin.right;
  const maxH = work.height - margin.top - margin.bottom;
  const four = (n) => Math.floor(n / 4) * 4;
  const w = four(Math.min(maxW, Math.max(MIN_WIDTH, frameWidth)));
  const h = four(Math.min(maxH, Math.max(MIN_HEIGHT, frameHeight)));
  restoreBounds = null;
  live.setSize(w + margin.left + margin.right, h + margin.top + margin.bottom);
  send(MAXIMIZE_CHANNEL, false);
}

/** Agrandir / restaurer, dans les deux modes. */
function toggleMaximize() {
  const live = getWindow();
  if (!live) return;

  if (mode !== 'ouvert') {
    if (live.isMaximized()) live.unmaximize();
    else live.maximize();
    return;
  }

  // Mode ouvert : la fenêtre transparente n'a pas d'« agrandir » natif fiable.
  // Le cadre prend toute la zone de travail de l'écran, décor compris.
  if (restoreBounds) {
    live.setBounds(restoreBounds);
    restoreBounds = null;
    send(MAXIMIZE_CHANNEL, false);
    return;
  }
  restoreBounds = live.getBounds();
  live.setBounds(screen.getDisplayMatching(restoreBounds).workArea);
  send(MAXIMIZE_CHANNEL, true);
}

/** @returns {boolean} la fenêtre est-elle agrandie ? */
function isMaximized() {
  const live = getWindow();
  if (!live) return false;
  return mode === 'ouvert' ? restoreBounds !== null : live.isMaximized();
}

/**
 * Clics traversants (mode ouvert) : sur la marge vide, la souris doit atteindre
 * le bureau. `forward` garde les mouvements de souris pour le renderer, qui
 * peut ainsi rendre la main dès que le pointeur revient sur le cadre.
 * @param {boolean} passthrough
 */
function setPassthrough(passthrough) {
  const live = getWindow();
  if (!live || mode !== 'ouvert') return;
  live.setIgnoreMouseEvents(Boolean(passthrough), { forward: true });
}

/**
 * Recrée la fenêtre — le mode ouvert ou compact se décide à la création
 * (une fenêtre ne devient pas transparente après coup).
 */
function recreate() {
  const old = getWindow();
  const bounds = old ? old.getBounds() : null;
  // La nouvelle fenêtre naît AVANT que l'ancienne ne disparaisse : sinon
  // « toutes les fenêtres sont fermées » ferait quitter l'application.
  win = null;
  const next = create();
  if (old) {
    old.removeAllListeners('closed');
    old.destroy();
  }
  if (bounds && mode === 'compact') next.setPosition(bounds.x, bounds.y);
  logger.attach(next);
  return next;
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

  // La préférence est lue ici, et non importée en tête : le magasin de
  // configuration charge le module de chemins, qui a besoin de l'app prête.
  const store = require('../main/services/store');
  let wantsOpen = true;
  try {
    wantsOpen = store.getConfig().launcher.window_open !== false;
  } catch (err) {
    logger.warn(`Préférence de fenêtre illisible (${err.message}) : mode ouvert par défaut.`);
  }
  const layout = decideLayout(wantsOpen);
  mode = layout.mode;
  if (layout.margin) margin = layout.margin;
  restoreBounds = null;
  if (mode === 'compact' && wantsOpen) logger.info(`Fenêtre compacte : ${layout.reason}.`);

  const open = mode === 'ouvert';
  const geometry = open
    ? {
        width: layout.frame.width + margin.left + margin.right,
        height: layout.frame.height + margin.top + margin.bottom,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        transparent: true,
        hasShadow: false,
        // Fond entièrement transparent : c'est le cadre CSS qui dessine le launcher.
        backgroundColor: '#00000000',
        // Pas de boutons natifs macOS flottant dans la marge transparente.
        titleBarStyle: 'default',
      }
    : {
        width: WIDTH,
        height: HEIGHT,
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        resizable: true,
        titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
        backgroundColor: BACKGROUND,
      };

  win = new BrowserWindow({
    title: app.getName(),
    ...geometry,
    frame: false,
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

  // Le mode et la marge voyagent dans l'adresse de la page : le renderer les
  // lit avant même le premier rendu (assets/js/frame.js), sans aller-retour IPC.
  const query = { fenetre: mode };
  if (open) {
    query.mt = String(margin.top);
    query.mr = String(margin.right);
    query.mb = String(margin.bottom);
    query.ml = String(margin.left);
  }
  win.loadFile(path.join(__dirname, '..', 'launcher.html'), { query }).catch((err) => {
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

module.exports = {
  create,
  recreate,
  getWindow,
  destroy,
  windowMode,
  toggleMaximize,
  isMaximized,
  resizeFrame,
  setPassthrough,
};
