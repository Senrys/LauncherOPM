'use strict';

/**
 * Pont sécurisé entre le processus principal et l'interface.
 *
 * Le renderer n'obtient jamais `ipcRenderer` : il ne voit que l'objet `window.opm`
 * décrit par docs/IPC.md. Aucun jeton, aucun mot de passe, aucun `refresh_token`
 * ne transite par ici : les appels réseau authentifiés vivent dans le processus principal.
 *
 * Deux règles de comportement :
 *  1. les arguments sont validés ici (types simples) — une valeur aberrante est refusée
 *     avant même d'atteindre le processus principal ;
 *  2. une réponse `{ error, message }` du processus principal est retransformée en `Error`
 *     rejetée (avec `.code` et `.details`). Les réponses métier portant un champ `ok`
 *     (LoginResult) sont rendues telles quelles.
 */

const { contextBridge, ipcRenderer } = require('electron');

/* -------------------------------------------------------------- validation */

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`opm : « ${label} » doit être une chaîne de caractères non vide.`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null) return undefined;
  return assertString(value, label);
}

function assertNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`opm : « ${label} » doit être un nombre.`);
  }
  return value;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`opm : « ${label} » doit être un objet.`);
  }
  return value;
}

function assertFunction(value, label) {
  if (typeof value !== 'function') {
    throw new TypeError(`opm : « ${label} » doit être une fonction.`);
  }
  return value;
}

/* ------------------------------------------------------------------ transport */

/**
 * Appel `invoke` avec remontée d'erreur normalisée.
 * @param {string} channel
 * @param {...unknown} args
 */
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);

  const isEnvelope =
    result &&
    typeof result === 'object' &&
    typeof result.error === 'string' &&
    result.ok === undefined;

  if (isEnvelope) {
    const err = new Error(result.message || result.error);
    err.code = result.error;
    if (result.details !== undefined) err.details = result.details;
    throw err;
  }
  return result;
}

/**
 * Abonnement à un canal descendant. Renvoie la fonction de désabonnement.
 * @param {string} channel
 * @param {(...args: any[]) => void} cb
 * @param {string} label
 */
function subscribe(channel, cb, label) {
  assertFunction(cb, label);
  const listener = (_event, ...args) => {
    try {
      cb(...args);
    } catch (err) {
      console.error(`opm : erreur dans l'abonné « ${label} »`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/* ----------------------------------------------------------------- surface */

const opm = {
  /* ------------------------------------------------------------- FENÊTRE */
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    hide: () => ipcRenderer.send('window:hide'),
    show: () => ipcRenderer.send('window:show'),
    isMaximized: () => call('window:is-maximized'),
    onMaximizeChange: (cb) => subscribe('window:maximized', cb, 'onMaximizeChange'),
    /** -1 éteint la barre de progression, 2 la met en indéterminé, sinon un ratio 0 → 1. */
    setProgress: (ratio) => ipcRenderer.send('window:progress', assertNumber(ratio, 'ratio')),
  },

  /* --------------------------------------------------------- APPLICATION */
  app: {
    version: () => call('app:version'),
    platform: () => call('app:platform'),
    openExternal: async (url) => call('app:open-external', assertString(url, 'url')),
    openPath: async (target) => call('app:open-path', assertString(target, 'path')),
    gameDir: () => call('app:game-dir'),
    totalMemoryGb: async () => (await call('app:memory')).total,
    freeMemoryGb: async () => (await call('app:memory')).free,
    pickJava: () => call('app:pick-java'),
    /**
     * Rapatrie une image par le processus principal et la rend en `data:` URL.
     * Le document est chargé en `file://` et le serveur n'ouvre pas CORS : c'est le seul
     * moyen d'obtenir des pixels lisibles au canevas (têtes de skin). `null` en cas
     * d'échec — jamais d'exception à traiter côté interface.
     */
    fetchImage: async (url) => call('app:fetch-image', assertString(url, 'url')),
    panel: async (name) => call('app:panel', assertString(name, 'panel')),
    devtools: () => ipcRenderer.send('app:devtools'),
  },

  /* ------------------------------------------------------- CONFIGURATION */
  config: {
    get: () => call('config:get'),
    set: async (patch) => call('config:set', assertObject(patch, 'patch')),
    reset: () => call('config:reset'),
  },

  /* ------------------------------------------------------------- COMPTES */
  auth: {
    bootstrap: () => call('auth:bootstrap'),
    list: () => call('auth:list'),
    current: () => call('auth:current'),
    select: async (id) => call('auth:select', assertString(id, 'id')),
    remove: async (id) => call('auth:remove', assertString(id, 'id')),

    login: async (p) => {
      const payload = assertObject(p, 'identifiants');
      return call('auth:login', {
        email: assertString(payload.email, 'email'),
        password: assertString(payload.password, 'password'),
        totp: optionalString(payload.totp, 'totp'),
      });
    },

    register: async (p) => {
      const payload = assertObject(p, 'inscription');
      return call('auth:register', {
        email: assertString(payload.email, 'email'),
        password: assertString(payload.password, 'password'),
        username: assertString(payload.username, 'username'),
      });
    },

    logout: async (id) => call('auth:logout', optionalString(id, 'id')),
    refresh: async (id) => call('auth:refresh', optionalString(id, 'id')),
    forgotPassword: async (email) => call('auth:forgot-password', assertString(email, 'email')),
    totpSetup: () => call('auth:totp-setup'),
    totpEnable: async (code) => call('auth:totp-enable', assertString(code, 'code')),

    totpDisable: async (p) => {
      const payload = assertObject(p, 'désactivation');
      return call('auth:totp-disable', {
        password: assertString(payload.password, 'password'),
        code: assertString(payload.code, 'code'),
      });
    },

    linkMicrosoft: () => call('auth:link-microsoft'),
    /**
     * Renonce au rattachement Microsoft en cours : la scrutation s'arrête, le verrou est
     * libéré et `link_device` repasse à `null` (publié par `auth:changed`).
     * Sans rattachement en cours : sans effet.
     */
    cancelLink: () => call('auth:cancel-link'),
    unlinkMicrosoft: async (password) =>
      call('auth:unlink-microsoft', assertString(password, 'password')),
    verifyOwnership: () => call('auth:verify-ownership'),
    onChange: (cb) => subscribe('auth:changed', cb, 'auth.onChange'),
  },

  /* ----------------------------------------------------------------- JEU */
  game: {
    instances: () => call('game:instances'),
    launch: async (instanceName) => call('game:launch', optionalString(instanceName, 'instance')),
    cancel: () => call('game:cancel'),
    isRunning: () => call('game:is-running'),
    verifyFiles: () => call('game:verify'),
    clearCache: () => call('game:clear-cache'),
    filesStat: () => call('game:files-stat'),
    on: (cb) => subscribe('game:event', cb, 'game.on'),
  },

  /* ------------------------------------------------------------- CONTENU */
  content: {
    news: () => call('content:news'),
    status: () => call('content:status'),
    nextEvent: () => call('content:next-event'),
    votes: () => call('content:votes'),
    donations: () => call('content:donations'),
    donate: async (amountCents) => call('content:donate', assertNumber(amountCents, 'montant')),
  },

  /* --------------------------------------------------------- MISE À JOUR */
  updater: {
    check: () => call('updater:check'),
    on: (cb) => subscribe('updater:event', cb, 'updater.on'),
  },

  /* ------------------------------------------------------------- JOURNAL */
  log: {
    on: (cb) => subscribe('log:line', cb, 'log.on'),
    history: () => call('log:history'),
  },
};

contextBridge.exposeInMainWorld('opm', opm);
