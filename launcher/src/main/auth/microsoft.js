'use strict';

/**
 * Fenêtre Microsoft du rattachement de compte — flux « embedded » (docs/API.md § 1.3).
 *
 * Ce module n'est **qu'un navigateur**. Il ouvre l'`authorize_url` fournie par notre serveur,
 * regarde passer les navigations, et capte le paramètre `code` au moment où Microsoft
 * redirige vers `redirect_uri`. Puis il ferme la fenêtre. C'est tout.
 *
 * Ce qu'il ne fait JAMAIS, et ne doit jamais faire :
 *  - aucun `preload`, aucune injection de script, aucun `executeJavaScript` : la page de
 *    connexion Microsoft n'est ni lue, ni instrumentée, ni modifiée ;
 *  - aucun identifiant saisi par le joueur n'est stocké, transmis ou journalisé ;
 *  - aucune URL complète n'est journalisée : la redirection finale contient le code
 *    d'autorisation, seuls l'origine et le chemin apparaissent dans le journal ;
 *  - aucun échange de jeton : le `code` part vers **notre** serveur Python, qui exécute
 *    XBL → XSTS → Minecraft Services. Le launcher ne voit jamais de jeton Microsoft.
 *
 * Isolation : la fenêtre utilise la partition `persist:msa`, **effacée avant et après**
 * chaque usage. Un joueur qui rattache un second compte ne se retrouve donc jamais
 * reconnecté d'office avec le compte Microsoft précédent.
 *
 * Résultat renvoyé — objet discriminé, jamais d'exception pour un abandon ordinaire :
 *
 *   { code: '…' }                              autorisation obtenue
 *   { cancelled: true, reason: 'closed' }      fenêtre fermée par le joueur
 *   { cancelled: true, reason: 'timeout' }     cinq minutes écoulées
 *   { error: 'access_denied', description }    refus explicite côté Microsoft
 *   { error: 'busy' | 'network' | …, … }       incident technique
 */

const { BrowserWindow, session } = require('electron');

const logger = require('../services/logger');

/* ------------------------------------------------------------------ constantes */

/** Partition dédiée : jamais celle du launcher, et remise à zéro à chaque rattachement. */
const PARTITION = 'persist:msa';

/** Gabarit de la fenêtre — assez large pour le formulaire Microsoft, pas plus. */
const WINDOW_WIDTH = 520;
const WINDOW_HEIGHT = 680;

/** Au-delà, on considère que le joueur a abandonné devant sa fenêtre. */
const MAX_DURATION_MS = 5 * 60 * 1000;

/** Chromium signale par ce code une navigation annulée : ce n'est pas une panne. */
const ERR_ABORTED = -3;

/** Événements de navigation surveillés. Les deux premiers sont annulables. */
const NAVIGATION_EVENTS = ['will-redirect', 'will-navigate', 'did-redirect-navigation', 'did-navigate'];

/* ------------------------------------------------------------------ état interne */

/** Fenêtre en cours, pour interdire deux rattachements simultanés. @type {BrowserWindow|null} */
let active = null;

/* ------------------------------------------------------------------ utilitaires */

/**
 * Décrit une URL sans jamais divulguer ses paramètres — la redirection finale porte le
 * code d'autorisation dans sa chaîne de requête.
 * @param {URL|string} url
 * @returns {string}
 */
function describe(url) {
  try {
    const parsed = url instanceof URL ? url : new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(adresse illisible)';
  }
}

/**
 * Deux URL désignent-elles le même point d'arrivée ? La comparaison porte sur l'origine et
 * le chemin uniquement : Microsoft ajoute au retour `code`, `state` et parfois d'autres
 * paramètres, et peut normaliser la barre oblique finale.
 * @param {URL} a
 * @param {URL} b
 * @returns {boolean}
 */
function sameEndpoint(a, b) {
  const trim = (p) => p.replace(/\/+$/, '');
  return a.origin.toLowerCase() === b.origin.toLowerCase() && trim(a.pathname) === trim(b.pathname);
}

/**
 * Extrait les paramètres d'une URL de retour : ils voyagent normalement dans la chaîne de
 * requête (flux « code »), le fragment n'est lu que par précaution.
 * @param {URL} url
 * @returns {URLSearchParams}
 */
function returnedParams(url) {
  if (url.searchParams.has('code') || url.searchParams.has('error')) return url.searchParams;
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  return hash ? new URLSearchParams(hash) : url.searchParams;
}

/**
 * Valide les adresses reçues du serveur avant d'ouvrir quoi que ce soit.
 * @param {string} authorizeUrl
 * @param {string} redirectUri
 * @returns {{authorize: URL, redirect: URL}}
 * @throws {Error} si l'une des deux n'est pas une URL http(s) exploitable
 */
function validate(authorizeUrl, redirectUri) {
  let authorize;
  let redirect;

  try {
    authorize = new URL(String(authorizeUrl));
  } catch {
    throw new Error("l'adresse d'autorisation Microsoft est illisible");
  }
  try {
    redirect = new URL(String(redirectUri));
  } catch {
    throw new Error("l'adresse de redirection Microsoft est illisible");
  }

  if (authorize.protocol !== 'https:') {
    throw new Error("l'adresse d'autorisation Microsoft doit être en https");
  }
  if (redirect.protocol !== 'https:' && redirect.protocol !== 'http:') {
    throw new Error('le schéma de redirection Microsoft est inattendu');
  }

  return { authorize, redirect };
}

/**
 * Vide entièrement la partition : cookies, stockages web, cache HTTP et cache
 * d'authentification. Un échec n'est pas fatal — il signifie seulement qu'une session
 * Microsoft précédente peut subsister, ce qui est journalisé.
 */
async function resetPartition() {
  try {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData();
    await ses.clearCache();
    if (typeof ses.clearAuthCache === 'function') await ses.clearAuthCache();
  } catch (err) {
    logger.warn(`Nettoyage de la session Microsoft incomplet : ${err.message}`);
  }
}

/**
 * Fenêtre parente pour l'affichage modal. La fenêtre principale n'est pas accessible
 * depuis ce module (signature imposée) : on prend celle qui a le focus, sinon la première.
 * @returns {BrowserWindow|null}
 */
function parentWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  const [first] = BrowserWindow.getAllWindows();
  return first && !first.isDestroyed() ? first : null;
}

/* ------------------------------------------------------------------ flux embarqué */

/**
 * Ouvre la fenêtre de consentement Microsoft et attend le code d'autorisation.
 *
 * @param {{authorize_url: string, redirect_uri: string}} start  réponse de
 *        `POST /api/v1/link/microsoft/start` en mode `embedded` (docs/API.md § 1.3)
 * @returns {Promise<{code: string}
 *                   | {cancelled: true, reason: 'closed'|'timeout'}
 *                   | {error: string, description?: string}>}
 */
async function runEmbeddedFlow(start = {}) {
  if (active && !active.isDestroyed()) {
    active.focus();
    return { error: 'busy', description: 'Une fenêtre Microsoft est déjà ouverte.' };
  }

  let authorize;
  let redirect;
  try {
    ({ authorize, redirect } = validate(start.authorize_url, start.redirect_uri));
  } catch (err) {
    logger.error(`Rattachement Microsoft impossible : ${err.message}.`);
    return { error: 'invalid_start', description: err.message };
  }

  // Aucun cookie hérité : le joueur choisit le compte Microsoft qu'il veut rattacher.
  await resetPartition();

  const parent = parentWindow();
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    parent: parent || undefined,
    modal: Boolean(parent),
    show: false,
    center: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    title: 'Connexion Microsoft',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // Aucun preload : rien de nous ne s'exécute dans la page de Microsoft.
      sandbox: true,
      webSecurity: true,
      nodeIntegrationInSubFrames: false,
      spellcheck: false,
    },
  });

  active = win;
  logger.info('Rattachement Microsoft : ouverture de la fenêtre de consentement.');

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    /**
     * Termine le flux une seule fois : arrête le minuteur, détruit la fenêtre, efface la
     * partition en tâche de fond, puis résout.
     * @param {object} result
     */
    const finish = (result) => {
      if (settled) return;
      settled = true;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!win.isDestroyed()) win.destroy();
      active = null;

      // Ne rien laisser derrière soi : la session Microsoft ne survit pas au rattachement.
      resetPartition().catch(() => {
        /* déjà journalisé par resetPartition */
      });

      resolve(result);
    };

    /**
     * Inspecte une navigation ; renvoie `true` si c'était la redirection finale.
     * @param {Electron.Event|null} event  événement annulable, quand il l'est
     * @param {string} rawUrl
     */
    const inspect = (event, rawUrl) => {
      let url;
      try {
        url = new URL(String(rawUrl));
      } catch {
        return;
      }
      if (!sameEndpoint(url, redirect)) return;

      // On est arrivé : la page de retour n'a aucun intérêt, inutile de la charger.
      if (event && typeof event.preventDefault === 'function') event.preventDefault();

      const params = returnedParams(url);
      const code = params.get('code');
      const error = params.get('error');

      if (code) {
        logger.info(`Rattachement Microsoft : autorisation reçue depuis ${describe(url)}.`);
        finish({ code });
        return;
      }

      if (error === 'access_denied') {
        logger.info("Rattachement Microsoft : autorisation refusée par l'utilisateur.");
        finish({ error: 'access_denied', description: params.get('error_description') || undefined });
        return;
      }

      logger.warn(`Rattachement Microsoft : redirection sans code (${error || 'motif inconnu'}).`);
      finish({
        error: error || 'no_code',
        description: params.get('error_description') || undefined,
      });
    };

    for (const name of NAVIGATION_EVENTS) {
      // `did-redirect-navigation` et `did-navigate` ne transmettent pas d'événement annulable
      // exploitable : la navigation a déjà eu lieu, on se contente d'y lire les paramètres.
      win.webContents.on(name, (event, url) => inspect(event, url));
    }

    // Le flux se déroule entièrement dans la fenêtre : aucune fenêtre secondaire n'est utile.
    win.webContents.setWindowOpenHandler(({ url }) => {
      logger.warn(`Fenêtre Microsoft : ouverture secondaire refusée vers ${describe(url)}.`);
      return { action: 'deny' };
    });

    // Une page de connexion n'a besoin ni du micro, ni de la caméra, ni des notifications.
    win.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
      logger.warn(`Fenêtre Microsoft : permission « ${permission} » refusée.`);
      callback(false);
    });

    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === ERR_ABORTED) return;
      // La redirection finale peut « échouer » puisqu'on l'a interceptée : ne rien conclure.
      if (settled) return;
      logger.error(`Fenêtre Microsoft : chargement impossible de ${describe(validatedURL)} (${errorDescription}).`);
      finish({ error: 'network', description: errorDescription });
    });

    win.webContents.on('render-process-gone', (_event, details) => {
      if (settled) return;
      logger.error(`Fenêtre Microsoft : le processus d'affichage s'est arrêté (${details.reason}).`);
      finish({ error: 'crashed', description: details.reason });
    });

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });

    win.on('closed', () => {
      if (settled) return;
      logger.info('Rattachement Microsoft : fenêtre fermée par le joueur.');
      active = null;
      settled = true;
      if (timer) clearTimeout(timer);
      resetPartition().catch(() => {
        /* déjà journalisé par resetPartition */
      });
      resolve({ cancelled: true, reason: 'closed' });
    });

    timer = setTimeout(() => {
      logger.warn('Rattachement Microsoft : délai de cinq minutes dépassé, fenêtre refermée.');
      finish({ cancelled: true, reason: 'timeout' });
    }, MAX_DURATION_MS);

    win.loadURL(authorize.toString()).catch((err) => {
      if (settled) return;
      logger.error(`Fenêtre Microsoft : ouverture impossible (${err.message}).`);
      finish({ error: 'network', description: err.message });
    });
  });
}

module.exports = { runEmbeddedFlow };
