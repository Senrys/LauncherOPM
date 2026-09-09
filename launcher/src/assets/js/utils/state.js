/**
 * État partagé du renderer — un petit magasin observable, sans dépendance.
 *
 * Quatre opérations : `get()`, `set(patch)`, `clear(...clés)`, `subscribe(cb)`.
 *  - la fusion est **superficielle** : une branche (`game`, `updater`…) se
 *    remplace en entier, ce qui rend chaque changement facile à comparer ;
 *  - une écriture qui ne change rien ne notifie personne (comparaison
 *    `Object.is` clé par clé) ;
 *  - `clear()` est le geste d'effacement explicite : la clé reprend la valeur
 *    qu'elle avait au démarrage. Sans lui, faire disparaître une donnée
 *    revenait à écrire `null` — que plusieurs panneaux, ne sachant pas
 *    distinguer « absent » de « inchangé », laissaient tomber : un bandeau
 *    d'erreur ou un code de rattachement restait alors affiché pour toujours ;
 *  - les notifications sont **différées à la micro-tâche** suivante et
 *    regroupées : dix `set()` d'affilée ne provoquent qu'un seul rendu.
 *
 * Le magasin ne contient que des données d'affichage. Aucun jeton, aucun mot
 * de passe : ces valeurs ne quittent jamais le processus principal.
 *
 * Il expose enfin `network`, la santé de la liaison avec le serveur : c'est
 * elle, et non une écriture ponctuelle, qui décide de la clé `online`.
 */

/**
 * Forme de l'état, documentée une fois pour toutes.
 *
 * @typedef {Object} OpmState
 * @property {boolean} ready            le démarrage est terminé
 * @property {'splash'|'login'|'app'} screen  écran affiché
 * @property {'home'|'settings'|'donation'} tab  onglet actif de la coque
 * @property {'login'|'totp'|'register'|'link'|'forgot'} loginView  vue demandée à l'écran de connexion
 * @property {string} version           version du launcher (app.version())
 * @property {string} platform          'win32' | 'darwin' | 'linux'
 * @property {boolean} online           le serveur d'authentification répond
 *                                      (dérivé par `network`, jamais posé à la main)
 * @property {Object|null} bootstrap    réponse de GET /bootstrap
 * @property {Object|null} maintenance  bootstrap.maintenance, isolé pour l'UI
 * @property {Object|null} config       LauncherConfig local
 * @property {Array<Object>} accounts   comptes connus localement
 * @property {Object|null} account      compte sélectionné
 * @property {Array<Object>} instances  instances de jeu disponibles
 * @property {string|null} instance     nom de l'instance sélectionnée
 * @property {Object} game              avancement du jeu (voir GAME_IDLE)
 * @property {Object} updater           avancement de la mise à jour du launcher
 * @property {Array<Object>} logs       lignes de journal, les plus récentes en dernier
 */

/** État de repos du jeu — sert aussi de gabarit pour les événements. */
export const GAME_IDLE = Object.freeze({
  /** idle | check | download | extract | patch | launching | running | closed | error */
  state: 'idle',
  progress: 0,
  size: 0,
  /** progression normalisée 0 → 1, calculée par le renderer */
  ratio: 0,
  /** octets par seconde, 0 si inconnu */
  speed: 0,
  /** secondes restantes, 0 si inconnu */
  eta: 0,
  message: '',
  running: false,
});

/** État de repos de la mise à jour du launcher. */
export const UPDATER_IDLE = Object.freeze({
  /** idle | checking | available | none | downloading | downloaded | error */
  state: 'idle',
  version: null,
  percent: 0,
  message: '',
});

/** Nombre de lignes de journal conservées côté renderer. */
export const LOG_LIMIT = 300;

/** @type {OpmState} */
const INITIAL = {
  ready: false,
  screen: 'splash',
  tab: 'home',
  loginView: 'login',
  version: '',
  platform: '',
  online: true,
  bootstrap: null,
  maintenance: null,
  config: null,
  accounts: [],
  account: null,
  instances: [],
  instance: null,
  game: GAME_IDLE,
  updater: UPDATER_IDLE,
  logs: [],
};

/**
 * Crée un magasin observable.
 * @param {Object} initial état de départ
 */
function createStore(initial) {
  /** Valeurs de départ, conservées : ce sont elles que `clear()` remet en place. */
  const defaults = Object.freeze({ ...initial });

  let state = defaults;

  /** @type {Set<(state: Object, changed: Set<string>) => void>} */
  const subscribers = new Set();

  /** Clés modifiées depuis la dernière notification. */
  let pending = new Set();
  let scheduled = false;

  function flush() {
    scheduled = false;
    const changed = pending;
    pending = new Set();
    if (changed.size === 0) return;

    for (const subscriber of subscribers) {
      try {
        subscriber(state, changed);
      } catch (error) {
        // Un abonné fautif ne doit jamais empêcher les autres d'être servis.
        console.error('opm : erreur dans un abonné du magasin', error);
      }
    }
  }

  /**
   * Fusion superficielle. Les clés dont la valeur ne change pas sont ignorées.
   * @param {Object} patch
   * @returns {Object} le nouvel instantané
   */
  function set(patch) {
    if (!patch || typeof patch !== 'object') return state;

    let mutated = false;
    const next = { ...state };

    for (const [key, value] of Object.entries(patch)) {
      if (Object.is(state[key], value)) continue;
      next[key] = value;
      pending.add(key);
      mutated = true;
    }

    if (!mutated) return state;
    state = Object.freeze(next);

    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
    return state;
  }

  /**
   * Efface des clés : chacune reprend sa valeur de départ (`null`, `[]`, `''`…).
   *
   * C'est le geste qui manquait. Écrire `set({ account: null })` fonctionne,
   * mais rien ne distingue alors une absence d'un « je n'ai rien à dire » :
   * les abonnés qui filtrent les valeurs vides gardent l'ancienne. `clear()`
   * énonce l'intention, et une clé inconnue est ignorée plutôt que d'inventer
   * une valeur de repli.
   *
   * @param {...(string|string[])} keys
   * @returns {Object} le nouvel instantané
   */
  function clear(...keys) {
    const patch = {};

    for (const key of keys.flat()) {
      if (typeof key !== 'string' || !Object.hasOwn(defaults, key)) continue;
      patch[key] = defaults[key];
    }
    return set(patch);
  }

  return {
    /**
     * Instantané courant. L'objet est gelé : toute évolution passe par `set()`.
     * @returns {Object}
     */
    get() {
      return state;
    },

    set,
    clear,

    /**
     * Abonnement. Le rappel reçoit l'état et l'ensemble des clés modifiées.
     * @param {(state: Object, changed: Set<string>) => void} callback
     * @returns {() => void} désabonnement
     */
    subscribe(callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('store.subscribe attend une fonction.');
      }
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  };
}

/** Magasin unique du renderer. */
export const store = createStore(INITIAL);

/* ========================================================================== */
/*  Santé de la liaison — c'est elle qui écrit `online`                       */
/* ========================================================================== */

/**
 * `online` n'est pas un drapeau posé une fois au démarrage : c'est la lecture
 * d'un compteur d'échecs consécutifs, alimenté par TOUS les appels au serveur
 * (bootstrap, journal de bord, statut, tuiles, comptes).
 *
 * Deux échecs de transport d'affilée → hors ligne. Une seule réponse fraîche →
 * de nouveau en ligne. Un launcher démarré pendant une coupure de dix secondes
 * se débloque donc tout seul dès que la connexion revient, au lieu de rester
 * mort — bouton JOUER sur « INDISPONIBLE » — jusqu'au prochain redémarrage.
 */

/** Échecs consécutifs à partir desquels le launcher se déclare hors ligne. */
export const OFFLINE_AFTER_FAILURES = 2;

/** Codes qui prouvent que le serveur n'a pas répondu du tout (docs/API.md § 3). */
const TRANSPORT_CODES = new Set(['network', 'timeout']);

/** Codes qui ne disent rien de la liaison : le compteur n'y touche pas. */
const NEUTRAL_CODES = new Set(['aborted']);

/**
 * Fenêtre pendant laquelle un `fetched_at` vaut « relevé par cet appel-ci ».
 *
 * Le processus principal sert une réponse encore dans son TTL sans toucher au
 * réseau, et elle porte alors `stale: false` : elle ne prouve donc rien sur
 * l'instant. Seule une relève datée de maintenant est une preuve.
 */
const FETCHED_NOW_MS = 5_000;

/**
 * La relève annoncée date-t-elle de maintenant ?
 * @param {unknown} iso `fetched_at` de la réponse
 * @returns {boolean}
 */
function fetchedNow(iso) {
  if (typeof iso !== 'string') return false;

  const at = Date.parse(iso);
  return Number.isFinite(at) && Date.now() - at < FETCHED_NOW_MS;
}

/**
 * Construit le compteur de santé attaché à un magasin.
 * @param {{set: (patch: Object) => Object}} target
 */
function createNetworkHealth(target) {
  let failures = 0;

  /** Le serveur a répondu : la liaison est bonne, le compteur repart de zéro. */
  function up() {
    failures = 0;
    target.set({ online: true });
  }

  /** Un appel n'a pas abouti. Au deuxième d'affilée, le launcher se dit hors ligne. */
  function down() {
    failures = Math.min(failures + 1, OFFLINE_AFTER_FAILURES);
    if (failures >= OFFLINE_AFTER_FAILURES) target.set({ online: false });
  }

  /**
   * Classe l'échec d'un appel. Seule une panne de transport compte : un refus
   * métier (identifiants faux, maintenance) prouve au contraire que le serveur
   * est là, et un code purement local (`no_account`, `link_busy`…) ne prouve
   * rien du tout. Dans le doute, on ne bouge pas le compteur — une erreur sans
   * code, elle, est traitée comme une panne : c'est le cas d'un appel qui n'a
   * jamais atteint sa destination.
   *
   * @param {unknown} error
   */
  function fail(error) {
    const code = error?.code;
    if (NEUTRAL_CODES.has(code)) return;
    if (code === undefined || TRANSPORT_CODES.has(code)) down();
  }

  /**
   * Enveloppe un appel au serveur et rend son résultat inchangé.
   *
   * Trois lectures d'une réponse (docs/DATA.md § 5) :
   *  - marquée `stale` : elle sort d'un cache périmé parce que le réseau a
   *    échoué — c'est un échec, pas un succès ;
   *  - marquée fraîche mais relevée il y a longtemps : le cache était encore
   *    valide, aucun octet n'a circulé, elle ne prouve rien de l'instant ;
   *  - sans marqueur de cache du tout (bootstrap, compte) ou relevée à
   *    l'instant : le serveur a bel et bien répondu.
   *
   * Une réponse sans corps (`null`, tableau) laisse le compteur en place.
   *
   * @template T
   * @param {Promise<T>} promise
   * @returns {Promise<T>}
   */
  async function watch(promise) {
    try {
      const value = await promise;

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.stale === true) down();
        else if (value.stale !== false || fetchedNow(value.fetched_at)) up();
      }
      return value;
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  return {
    up,
    down,
    fail,
    watch,
    /** Échecs consécutifs — lecture seule, pour le diagnostic. */
    get failures() {
      return failures;
    },
  };
}

/** Santé de la liaison avec le serveur d'authentification. */
export const network = createNetworkHealth(store);
