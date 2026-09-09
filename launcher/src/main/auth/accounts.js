'use strict';

/**
 * Orchestrateur des comptes OPM — le seul module qui sait *où* vivent les jetons.
 *
 * Répartition des rôles (mode hybride imposé, docs/API.md § 0) :
 *
 *   api.js      parle au serveur, ne retient rien ;
 *   vault.js    conserve les `refresh_token`, chiffrés, sur le disque ;
 *   store.js    conserve les comptes, sans le moindre jeton ;
 *   accounts.js décide quand renouveler, quand oublier, et ce que voit le renderer.
 *
 * Règles tenues ici, et nulle part ailleurs :
 *
 *  1. **L'`access_token` ne touche jamais le disque.** Il vit dans `sessions`, une table en
 *     mémoire vive détruite avec le processus. Le `refresh_token`, lui, va au coffre.
 *  2. **Renouvellement anticipé.** Une minute avant l'échéance, le jeton est renouvelé — à la
 *     demande (`accessToken()`) et par minuterie pour le compte actif, afin que le bouton
 *     JOUER ne bute jamais sur une session périmée.
 *  3. **Une seule reprise.** Un appel qui échoue en `401 token_expired` est rejoué une fois,
 *     après renouvellement forcé. Jamais deux : au-delà, c'est le serveur qui refuse.
 *  4. **Un refresh révoqué est un compte perdu.** On le retire proprement — coffre,
 *     `accounts.json`, session mémoire — et on le journalise. Rien ne traîne.
 *  5. **Aucun jeton Microsoft ne passe par ici.** Le launcher transmet un code d'autorisation
 *     à notre serveur, qui vérifie la possession. La session de jeu est signée par nous.
 *  6. **Ce que `store` ne garde pas, `decorate()` le rajoute.** `accounts.json` s'en tient aux
 *     champs durables du compte ; la fiche RP (`profile`) et le code du flux Microsoft
 *     `device` (`link_device`) vivent en mémoire et sont joints à l'`Account` au moment de le
 *     remettre au renderer.
 *
 * Toute mutation (connexion, sélection, rattachement, suppression…) se termine par
 * `emitChange()`, que `ipc.js` relaie au renderer sur le canal `auth:changed`.
 */

const { shell } = require('electron');

const api = require('./api');
const microsoft = require('./microsoft');
const logger = require('../services/logger');
const store = require('../services/store');
const vault = require('../services/vault');

/* ------------------------------------------------------------------ constantes */

/** Marge de renouvellement : on ne présente jamais un jeton à moins d'une minute de sa fin. */
const REFRESH_MARGIN_MS = 60_000;

/** Durée de vie supposée d'un `access_token` quand le serveur ne la précise pas (15 min). */
const DEFAULT_EXPIRES_IN_S = 900;

/** Bornes de la minuterie de renouvellement, pour ne jamais programmer l'absurde. */
const RENEW_DELAY_MIN_MS = 5_000;
const RENEW_DELAY_MAX_MS = 6 * 60 * 60 * 1000;

/** Rythme d'interrogation du flux `device`, en secondes (docs/API.md § 1.3). */
const DEVICE_INTERVAL_DEFAULT_S = 5;
const DEVICE_INTERVAL_MIN_S = 1;
const DEVICE_INTERVAL_MAX_S = 60;

/** Durée de vie par défaut d'un code `device` quand le serveur ne la précise pas. */
const DEVICE_EXPIRES_DEFAULT_S = 900;

/**
 * Messages des codes d'erreur qui n'existent pas côté serveur : ils sont produits ici, donc
 * c'est ici qu'ils sont rédigés. Pour tous les autres, le message français du serveur fait foi
 * (docs/API.md § 3).
 */
const CLIENT_MESSAGES = {
  network: "Le serveur d'authentification est injoignable. Vérifiez votre connexion.",
  timeout: "Le serveur d'authentification met trop de temps à répondre.",
  aborted: "L'opération a été annulée.",
  invalid_response: "Le serveur d'authentification a renvoyé une réponse illisible.",
  no_account: 'Aucun compte connecté.',
  session_expired: 'Votre session a expiré : reconnectez-vous.',
  link_cancelled: 'Rattachement Microsoft annulé.',
  link_denied: "L'autorisation Microsoft a été refusée.",
  link_timeout: 'Le délai de rattachement Microsoft est dépassé.',
  link_failed: 'Le rattachement Microsoft a échoué.',
  link_busy: 'Un rattachement Microsoft est déjà en cours.',
  internal_error: 'Une erreur inattendue est survenue.',
};

/* ------------------------------------------------------------------ état interne */

/**
 * Sessions actives, **en mémoire uniquement**.
 * @type {Map<string, {token: string, expiresAt: number}>}
 */
const sessions = new Map();

/**
 * Fiches RP par compte (`user.profile`, docs/API.md § 1.2), **en mémoire uniquement**.
 *
 * `store` ne conserve que les champs du type `Account` de docs/IPC.md, et la fiche RP est une
 * donnée du serveur qui vieillit vite (prime, berry, îles tenues) : la garder sur le disque
 * exposerait le joueur à un sous-titre périmé au démarrage. Elle est remplie à chaque réponse
 * portant un `user` — connexion, `/auth/me` du splash, rattachement Microsoft — et jointe à
 * l'`Account` par `decorate()`. Tant qu'aucune réponse n'a été reçue, le champ vaut `null` et
 * l'accueil retombe sur son libellé de repli : jamais de fausse donnée.
 * @type {Map<string, object>}
 */
const profiles = new Map();

/**
 * Flux Microsoft `device` en cours : le code à saisir, publié vers le renderer par
 * `auth:changed` (champ `link_device` de l'`Account`, docs/IPC.md § Types).
 *
 * `owner` désigne le rattachement qui a publié ce code ; il ne quitte jamais le processus
 * principal (`decorate()` ne recopie que les trois champs du contrat). Il sert à ce qu'un
 * flux qui se termine n'efface que **son** code : après une annulation suivie d'une
 * nouvelle tentative, le ménage du flux abandonné ne doit pas emporter le code du suivant.
 * @type {{id: string, user_code: string, verification_uri: string, expires_at: string,
 *         owner: object|null}|null}
 */
let deviceLink = null;

/**
 * Renouvellements en vol, pour qu'un compte n'en déclenche jamais deux à la fois : un
 * `refresh_token` étant à usage unique, deux appels concurrents en tueraient un.
 * @type {Map<string, Promise<string>>}
 */
const renewals = new Map();

/** Abonnés aux changements de comptes. @type {Set<Function>} */
const listeners = new Set();

/** Minuterie de renouvellement anticipé du compte actif. */
let renewTimer = null;

/**
 * Rattachement Microsoft en cours — le verrou et son moyen d'annulation réunis en un seul
 * objet. Tant qu'il n'est pas nul, `linkMicrosoft()` refuse une nouvelle tentative
 * (`link_busy`) ; `cancelLink()` le retire et déclenche son `AbortController`, ce qui
 * interrompt la scrutation `device` et la requête en vol sans attendre le cycle suivant.
 * @type {{id: string, controller: AbortController}|null}
 */
let linkSession = null;

/** `init()` n'a d'effet qu'une fois. */
let initialized = false;

/** L'avertissement « coffre en mémoire seulement » n'est journalisé qu'une fois par session. */
let volatileVaultWarned = false;

/* ------------------------------------------------------------------ erreurs */

/**
 * Fabrique une erreur au code stable, telle que l'attend `ipc.js` (`err.code`, `err.message`,
 * `err.details`). Le drapeau `opm` la distingue d'une exception venue d'ailleurs.
 * @param {string} code
 * @param {string} [message]
 * @param {object|null} [details]
 * @returns {Error & {code: string, details: object|null, opm: true}}
 */
function fail(code, message, details = null) {
  const err = new Error(message || CLIENT_MESSAGES[code] || CLIENT_MESSAGES.internal_error);
  err.code = code;
  err.details = details;
  err.opm = true;
  return err;
}

/**
 * Traduit n'importe quelle exception en erreur au code stable.
 *
 * Les codes du serveur (docs/API.md § 3) traversent tels quels — ils font déjà partie du
 * contrat, le renderer les connaît. Seul `token_revoked` est renommé `session_expired` :
 * du point de vue du joueur, il n'y a pas deux façons de perdre sa session.
 *
 * @param {unknown} err
 * @returns {Error & {code: string}}
 */
function translate(err) {
  if (err && err.opm) return err;

  if (err instanceof api.ApiError) {
    const code = err.code === 'token_revoked' ? 'session_expired' : err.code;
    const out = fail(code, CLIENT_MESSAGES[code] || err.message, err.details);
    if (code === 'session_expired') out.revoked = true;
    return out;
  }

  logger.error('Comptes — erreur inattendue :', err);
  return fail('internal_error');
}

/** Marque une erreur comme « session définitivement perdue » (le compte doit être oublié). */
function revoked(err) {
  err.revoked = true;
  return err;
}

/** @returns {boolean} vrai si l'erreur signifie que le compte ne peut plus être rétabli */
function isRevoked(err) {
  return Boolean(err && err.revoked);
}

/* ------------------------------------------------------------------ utilitaires */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Attente interruptible. Sans signal, c'est un `setTimeout` ordinaire ; avec, la main est
 * rendue dès l'annulation — le joueur qui renonce n'a pas à attendre la fin du cycle de
 * scrutation en cours.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  if (signal && signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

/** Entier contraint à un intervalle, avec repli si la valeur est inexploitable. */
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Extrait l'objet `user` d'une réponse. Le serveur l'enveloppe (`{ user }`) sur la plupart
 * des points d'entrée ; on accepte aussi la forme nue, par robustesse.
 * @param {any} payload
 * @returns {object|null}
 */
function userOf(payload) {
  if (!isPlainObject(payload)) return null;
  if (isPlainObject(payload.user)) return payload.user;
  // `users.id` est un entier côté serveur (docs/DATA.md) : la forme nue en porte un, pas une
  // chaîne — c'est `toAccount()` qui le convertit pour le contrat IPC.
  const bare = typeof payload.id === 'string' || typeof payload.id === 'number';
  return bare ? payload : null;
}

/**
 * Adresse du skin à afficher dans l'interface (la tête 8×8 est rendue par le renderer).
 *
 * Le serveur héberge lui-même les textures (`GET /textures/{sha256}.png`, docs/API.md § 2.5)
 * après les avoir importées au rattachement (docs/DATA.md § 6). Selon ce qu'il expose, on
 * accepte une URL toute faite ou une empreinte à composer. À défaut : `null`, et le renderer
 * affiche la silhouette par défaut — jamais d'adresse inventée.
 *
 * @param {object} user
 * @returns {string|null}
 */
function skinUrl(user) {
  const ms = isPlainObject(user.microsoft) ? user.microsoft : {};
  const skin = isPlainObject(user.skin) ? user.skin : {};

  const direct = user.skin_url || skin.url || ms.skin_url;
  if (typeof direct === 'string' && direct.trim() !== '') {
    try {
      return new URL(direct, `${api.baseUrl()}/`).toString();
    } catch {
      return null;
    }
  }

  const sha = user.skin_sha256 || skin.sha256;
  if (typeof sha === 'string' && /^[0-9a-f]{64}$/i.test(sha)) {
    return `${api.baseUrl()}/textures/${sha.toLowerCase()}.png`;
  }

  return null;
}

/**
 * Traduit l'objet `user` du serveur (docs/API.md § 1.2) en `Account` du contrat IPC
 * (docs/IPC.md § Types). Le drapeau `primary` est ajouté par `store`, qui seul connaît le
 * compte sélectionné.
 *
 * `session_expires_at` porte l'échéance de la **vérification de possession** : c'est elle qui
 * fait passer `can_play` à faux (`blocked_reason: 'microsoft_expired'`), et c'est elle que
 * l'interface annonce sous la forme « session valide 21 j ».
 *
 * @param {object} user
 * @returns {object}
 */
function toAccount(user) {
  const id = isPlainObject(user) ? String(user.id ?? '').trim() : '';
  if (!id) throw fail('invalid_response', "Le serveur a renvoyé un compte sans identifiant.");

  const ms = isPlainObject(user.microsoft) ? user.microsoft : null;
  const linked = Boolean(ms && ms.linked && ms.minecraft_uuid);

  return {
    id,
    email: typeof user.email === 'string' ? user.email : '',
    username: typeof user.username === 'string' ? user.username : '',
    minecraft: linked
      ? {
          uuid: String(ms.minecraft_uuid),
          name: typeof ms.minecraft_username === 'string' ? ms.minecraft_username : '',
        }
      : null,
    skin_url: skinUrl(user),
    can_play: Boolean(user.can_play),
    blocked_reason: typeof user.blocked_reason === 'string' ? user.blocked_reason : null,
    session_expires_at: ms && typeof ms.expires_at === 'string' ? ms.expires_at : null,
    totp_enabled: Boolean(user.totp_enabled),
  };
}

/* ------------------------------------------------------------------ fiche RP */

/** Chaîne non vide, sinon `null` — un champ RP vide n'est pas une valeur affichable. */
function textOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Entier positif, sinon `null` — jamais 0 par défaut : l'absence de donnée se voit. */
function countOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Fiche RP du joueur telle que la renvoie le serveur (`user.profile`, docs/API.md § 1.2).
 * Elle alimente le sous-titre de l'accueil — « Pirate · Équipage des Cœurs Brisés ·
 * 3 îles tenues » — dont les trois morceaux viennent de `users.faction`, `equipages` et
 * `iles` (docs/DATA.md § 1).
 *
 * @param {object} user
 * @returns {object|null} `null` quand le serveur ne fournit aucune fiche
 */
function profileOf(user) {
  const raw = isPlainObject(user) && isPlainObject(user.profile) ? user.profile : null;
  if (!raw) return null;

  const profile = {
    faction: textOrNull(raw.faction),
    metier: textOrNull(raw.metier),
    equipage: textOrNull(raw.equipage),
    iles_tenues: countOrNull(raw.iles_tenues),
    prime: countOrNull(raw.prime),
    berry: countOrNull(raw.berry),
    niveau: countOrNull(raw.niveau),
    temps_de_jeu_s: countOrNull(raw.temps_de_jeu_s),
  };

  // Une fiche entièrement vide ne vaut pas mieux que pas de fiche du tout.
  return Object.values(profile).some((v) => v !== null) ? profile : null;
}

/**
 * Mémorise (ou oublie) la fiche RP d'un compte à partir d'une réponse du serveur.
 * Une réponse sans fiche efface la précédente : mieux vaut le libellé de repli qu'une
 * identité RP périmée.
 * @param {string} id
 * @param {object} user
 */
function rememberProfile(id, user) {
  const profile = profileOf(user);
  if (profile) profiles.set(id, profile);
  else profiles.delete(id);
}

/**
 * Complète un `Account` de `store` avec ce que le processus principal est seul à savoir :
 * la fiche RP en mémoire et, pendant un rattachement Microsoft en mode `device`, le code
 * à saisir. Les deux champs font partie du type `Account` de docs/IPC.md ; ils ne sont
 * jamais écrits sur le disque.
 * @param {object|null} account
 * @returns {object|null}
 */
function decorate(account) {
  if (!isPlainObject(account)) return null;
  return {
    ...account,
    profile: profiles.get(account.id) ?? null,
    link_device:
      deviceLink && deviceLink.id === account.id
        ? {
            user_code: deviceLink.user_code,
            verification_uri: deviceLink.verification_uri,
            expires_at: deviceLink.expires_at,
          }
        : null,
  };
}

/** Identifiant du compte actif, ou `null`. */
function currentId() {
  return store.getCurrentId();
}

/* ------------------------------------------------------------------ diffusion */

/** Prévient les abonnés — jamais deux fois pour la même mutation. */
function emitChange() {
  const list = store.listAccounts().map(decorate);
  const active = current();
  for (const cb of listeners) {
    try {
      cb(list, active);
    } catch (err) {
      logger.error('Comptes — abonné en erreur :', err);
    }
  }
}

/**
 * S'abonne aux changements de comptes.
 * @param {(accounts: object[], current: object|null) => void} cb
 * @returns {() => void} fonction de désabonnement
 */
function onChange(cb) {
  if (typeof cb !== 'function') throw new TypeError('accounts.onChange attend une fonction.');
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/* ------------------------------------------------------------------ sessions */

function clearRenewTimer() {
  if (!renewTimer) return;
  clearTimeout(renewTimer);
  renewTimer = null;
}

/**
 * Programme le renouvellement anticipé du compte actif, une minute avant l'échéance.
 * Un échec n'est pas rejoué en boucle : le prochain `accessToken()` s'en chargera.
 * @param {string} id
 */
function scheduleRenew(id) {
  // Seul le compte actif est maintenu au chaud : renouveler un compte en arrière-plan ne doit
  // surtout pas annuler la minuterie de celui avec lequel le joueur s'apprête à jouer.
  if (id !== currentId()) return;
  clearRenewTimer();

  const session = sessions.get(id);
  if (!session) return;

  const delay = clampInt(
    session.expiresAt - Date.now() - REFRESH_MARGIN_MS,
    RENEW_DELAY_MIN_MS,
    RENEW_DELAY_MAX_MS,
    RENEW_DELAY_MIN_MS
  );

  renewTimer = setTimeout(() => {
    renewTimer = null;
    if (id !== currentId()) return;
    renew(id).catch((err) => {
      logger.warn(`Renouvellement anticipé impossible (${err.code || 'inconnu'}) : nouvelle tentative au prochain besoin.`);
    });
  }, delay);

  // La minuterie ne doit pas, à elle seule, maintenir le processus en vie.
  if (typeof renewTimer.unref === 'function') renewTimer.unref();
}

/**
 * Enregistre le `refresh_token` reçu. Le serveur pratique la rotation : l'ancien est mort à
 * la seconde où celui-ci arrive, il faut donc l'écrire avant tout autre appel. Un coffre
 * inaccessible n'interrompt pas la session en cours, mais elle ne survivra pas au redémarrage.
 * @param {string} id
 * @param {unknown} token
 */
function keepRefreshToken(id, token) {
  if (typeof token !== 'string' || token === '') return;
  try {
    vault.setSecret(id, token);
  } catch (err) {
    logger.error(
      `Coffre inaccessible : la session de ce compte ne survivra pas à la fermeture du launcher (${err.message}).`
    );
    return;
  }

  // Sans trousseau système, le coffre garde les jetons en mémoire vive et n'écrit rien :
  // le joueur devra se reconnecter au prochain démarrage. On le dit franchement, une fois.
  if (!vault.isPersistent() && !volatileVaultWarned) {
    volatileVaultWarned = true;
    logger.warn(
      "Aucun trousseau système : la session est conservée en mémoire pour la durée de cette " +
        'exécution seulement. Une reconnexion sera nécessaire au prochain démarrage du launcher.'
    );
  }
}

/**
 * Renouvelle l'`access_token` d'un compte à partir de son `refresh_token`.
 * Les appels concurrents partagent la même promesse.
 * @param {string} id
 * @returns {Promise<string>} le nouvel `access_token`
 * @throws {Error} `session_expired` (marquée `revoked`) si le compte doit être oublié
 */
function renew(id) {
  const inFlight = renewals.get(id);
  if (inFlight) return inFlight;

  const promise = (async () => {
    let secret;
    try {
      secret = vault.getSecret(id);
    } catch (err) {
      logger.error(`Lecture du coffre impossible pour ce compte (${err.message}).`);
      secret = null;
    }
    if (!secret) {
      sessions.delete(id);
      throw revoked(fail('session_expired', 'Aucune session enregistrée pour ce compte.'));
    }

    let data;
    try {
      data = await api.refresh(secret);
    } catch (err) {
      const out = translate(err);
      // Sur `/auth/refresh`, tout refus d'authentification signe la fin du jeton lui-même.
      if (err instanceof api.ApiError && err.status === 401) {
        sessions.delete(id);
        out.code = 'session_expired';
        out.message = CLIENT_MESSAGES.session_expired;
        revoked(out);
      }
      throw out;
    }

    const token = typeof data?.access_token === 'string' ? data.access_token : '';
    if (!token) throw fail('invalid_response', "Le serveur n'a pas renvoyé de jeton d'accès.");

    keepRefreshToken(id, data.refresh_token);

    const expiresIn = clampInt(data.expires_in, 30, 86_400, DEFAULT_EXPIRES_IN_S);
    sessions.set(id, { token, expiresAt: Date.now() + expiresIn * 1000 });
    scheduleRenew(id);

    return token;
  })().finally(() => renewals.delete(id));

  renewals.set(id, promise);
  return promise;
}

/**
 * `access_token` valide du compte demandé, renouvelé d'office s'il expire dans moins d'une
 * minute.
 * @param {string} [id]  compte visé ; le compte actif par défaut
 * @returns {Promise<string>}
 */
async function accessToken(id = currentId()) {
  if (!id) throw fail('no_account');
  const session = sessions.get(id);
  if (session && session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.token;
  return renew(id);
}

/**
 * Exécute un appel authentifié, avec **une** reprise après renouvellement forcé si le serveur
 * répond `401 token_expired` — cas d'un jeton invalidé plus tôt que prévu (rotation de clé,
 * horloge décalée).
 * @template T
 * @param {(token: string) => Promise<T>} call
 * @param {string} [id]
 * @returns {Promise<T>}
 */
async function withAuth(call, id = currentId()) {
  if (!id) throw fail('no_account');

  let token = await accessToken(id).catch((err) => {
    throw translate(err);
  });

  try {
    return await call(token);
  } catch (err) {
    const expired = err instanceof api.ApiError && err.code === 'token_expired';
    if (!expired) throw translate(err);

    logger.info("Jeton d'accès périmé : renouvellement puis nouvelle tentative.");
    sessions.delete(id);
    try {
      token = await renew(id);
    } catch (renewError) {
      throw translate(renewError);
    }

    try {
      return await call(token);
    } catch (retryError) {
      throw translate(retryError);
    }
  }
}

/* ------------------------------------------------------------------ cycle de vie */

/**
 * Adopte une réponse de connexion : session en mémoire, `refresh_token` au coffre, compte
 * enregistré et sélectionné.
 * @param {object} payload  réponse de `POST /auth/login` (docs/API.md § 1.2)
 * @returns {object} le compte, tel que le verra le renderer
 */
function adopt(payload) {
  const user = userOf(payload);
  if (!user) throw fail('invalid_response', "Le serveur n'a pas renvoyé de compte.");

  const token = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!token) throw fail('invalid_response', "Le serveur n'a pas renvoyé de jeton d'accès.");

  // Le compte est enregistré en premier : `setCurrentId` refuse un compte inconnu, et
  // l'identifiant retenu est celui du dépôt, seule autorité en la matière.
  const { id } = store.upsertAccount(toAccount(user));
  rememberProfile(id, user);

  const expiresIn = clampInt(payload.expires_in, 30, 86_400, DEFAULT_EXPIRES_IN_S);
  sessions.set(id, { token, expiresAt: Date.now() + expiresIn * 1000 });
  keepRefreshToken(id, payload.refresh_token);

  store.setCurrentId(id);
  scheduleRenew(id);
  emitChange();

  return decorate(store.getAccount(id));
}

/**
 * Met à jour un compte déjà connu à partir d'un `user` renvoyé par le serveur.
 * @param {any} payload
 * @returns {object} le compte mis à jour
 */
function absorb(payload) {
  const user = userOf(payload);
  if (!user) throw fail('invalid_response', "Le serveur n'a pas renvoyé de compte.");
  const account = store.upsertAccount(toAccount(user));
  rememberProfile(account.id, user);
  emitChange();
  return decorate(account);
}

/**
 * Efface toute trace locale d'un compte : session mémoire, coffre, `accounts.json`.
 * @param {string} id
 * @param {{revoke?: boolean}} [options]  `revoke` demande au serveur d'invalider le
 *        `refresh_token` avant de l'effacer ; inutile s'il est déjà mort.
 */
async function forget(id, { revoke = true } = {}) {
  const account = store.getAccount(id);
  const label = account ? account.username || account.email || id : id;

  if (revoke) {
    let secret = null;
    try {
      secret = vault.getSecret(id);
    } catch {
      /* coffre illisible : il n'y a de toute façon rien à révoquer */
    }
    if (secret) {
      try {
        await api.logout(secret);
      } catch (err) {
        logger.warn(`Révocation de la session côté serveur impossible (${err.code || 'inconnu'}).`);
      }
    }
  }

  sessions.delete(id);
  renewals.delete(id);
  profiles.delete(id);
  if (deviceLink && deviceLink.id === id) deviceLink = null;
  if (currentId() === id) clearRenewTimer();

  try {
    vault.deleteSecret(id);
  } catch (err) {
    logger.error(`Suppression du jeton dans le coffre impossible (${err.message}).`);
  }

  store.removeAccount(id);
  logger.info(`Compte « ${label} » retiré du launcher.`);

  // `store.removeAccount` bascule la sélection : la minuterie suit le nouveau compte actif.
  const next = currentId();
  if (next && sessions.has(next)) scheduleRenew(next);

  emitChange();
}

/**
 * Prépare le module au démarrage : lecture des comptes locaux et remise en cohérence de la
 * sélection. Aucun appel réseau — c'est `refreshAll()` qui s'en charge, pendant le splash.
 */
async function init() {
  if (initialized) return;
  initialized = true;

  const list = store.listAccounts();
  const selected = currentId();

  if (selected && !list.some((a) => a.id === selected)) {
    logger.warn('Le compte sélectionné a disparu : sélection du premier compte disponible.');
    store.setCurrentId(list.length > 0 ? list[0].id : null);
  } else if (!selected && list.length > 0) {
    store.setCurrentId(list[0].id);
  }

  logger.info(
    list.length === 0
      ? 'Aucun compte enregistré : connexion requise.'
      : `${list.length} compte(s) enregistré(s) localement.`
  );
}

/* ------------------------------------------------------------------ lecture */

/**
 * Comptes connus localement.
 * @returns {object[]}
 */
function list() {
  return store.listAccounts().map(decorate);
}

/**
 * Compte actif.
 * @returns {object|null}
 */
function current() {
  const id = currentId();
  return id ? decorate(store.getAccount(id)) : null;
}

/**
 * Change de compte actif.
 * @param {string} id
 * @returns {object} le compte devenu actif
 */
function select(id) {
  const account = store.getAccount(id);
  if (!account) throw fail('unknown_account', 'Ce compte ne figure pas dans le launcher.');

  store.setCurrentId(id);
  if (sessions.has(id)) scheduleRenew(id);
  else clearRenewTimer();

  logger.info(`Compte actif : « ${account.username || account.email} ».`);
  emitChange();
  return decorate(store.getAccount(id));
}

/**
 * Retire un compte du launcher, session révoquée côté serveur.
 * @param {string} id
 */
async function remove(id) {
  if (!store.getAccount(id)) throw fail('unknown_account', 'Ce compte ne figure pas dans le launcher.');
  await forget(id, { revoke: true });
}

/* ------------------------------------------------------------------ connexion */

/**
 * Enveloppe un échec en `LoginResult` (docs/IPC.md § Types) : l'écran de connexion affiche
 * un bandeau d'erreur, il n'a pas à intercepter d'exception.
 * @param {unknown} err
 * @returns {{ok: false, error: string, message: string}}
 */
function loginFailure(err) {
  const out = translate(err);
  return { ok: false, error: out.code, message: out.message };
}

/**
 * Connexion à un compte OPM.
 *
 * Un compte sans rattachement Microsoft se connecte quand même : il obtient bien une session,
 * mais son `blocked_reason` vaut `microsoft_required` et `can_play` est faux. C'est au
 * renderer d'enchaîner sur la vue de rattachement — d'où un `ok: true` malgré tout.
 *
 * @param {{email: string, password: string, totp?: string}} credentials
 * @returns {Promise<{ok: true, account: object} | {ok: false, error: string, message: string}>}
 */
async function login({ email, password, totp }) {
  try {
    const data = await api.login({ email, password, totp });
    const account = adopt(data);
    logger.info(`Connexion réussie : « ${account.username} ».`);
    if (!account.can_play && account.blocked_reason) {
      logger.warn(`Jeu indisponible pour ce compte (${account.blocked_reason}).`);
    }
    return { ok: true, account };
  } catch (err) {
    const result = loginFailure(err);
    logger.warn(`Échec de connexion (${result.error}).`);
    return result;
  }
}

/**
 * Création d'un compte OPM, suivie de la connexion : le serveur ne délivre pas de session à
 * l'inscription (docs/API.md § 1.2, `201 {user}`), le joueur enchaînerait de toute façon.
 * @param {{email: string, password: string, username: string}} payload
 * @returns {Promise<{ok: true, account: object} | {ok: false, error: string, message: string}>}
 */
async function register({ email, password, username }) {
  try {
    await api.register({ email, password, username });
    logger.info('Compte OPM créé, connexion en cours.');
  } catch (err) {
    const result = loginFailure(err);
    logger.warn(`Échec de création de compte (${result.error}).`);
    return result;
  }
  return login({ email, password });
}

/**
 * Déconnexion : la session est révoquée côté serveur et toute trace locale du compte
 * disparaît. Sans `refresh_token`, un compte n'est plus utilisable : le laisser dans la liste
 * n'offrirait qu'une ligne morte.
 * @param {string} [id]  compte visé ; le compte actif par défaut
 */
async function logout(id = currentId()) {
  if (!id) return;
  if (!store.getAccount(id)) return;
  await forget(id, { revoke: true });
}

/**
 * Renouvelle toutes les sessions connues et rafraîchit les profils — appelé au démarrage,
 * pendant le splash (« rafraîchissement de session », docs/UI-SPEC.md § 4.7).
 *
 * Un compte dont le `refresh_token` est révoqué est retiré proprement. Un compte simplement
 * injoignable (réseau coupé, serveur en carafe) est conservé : il se rétablira tout seul.
 *
 * @param {(step: string) => void} [onStep]  progression, en français, destinée au journal
 *        et au splash
 * @returns {Promise<{total: number, refreshed: number, removed: number, unreachable: number}>}
 */
async function refreshAll(onStep) {
  const report = (text) => {
    if (typeof onStep !== 'function') return;
    try {
      onStep(text);
    } catch (err) {
      logger.warn('Comptes — rapport de progression en erreur :', err);
    }
  };

  const known = store.listAccounts();
  const summary = { total: known.length, refreshed: 0, removed: 0, unreachable: 0 };

  if (known.length === 0) {
    report('Aucun compte à rétablir.');
    return summary;
  }

  for (let i = 0; i < known.length; i += 1) {
    const account = known[i];
    const label = account.username || account.email || account.id;
    report(`Rétablissement de la session de ${label} (${i + 1}/${known.length})…`);

    try {
      const token = await renew(account.id);
      const fresh = userOf(await api.me(token));
      if (fresh) {
        store.upsertAccount(toAccount(fresh));
        rememberProfile(account.id, fresh);
      } else {
        logger.warn(`Profil de ${label} illisible : les informations locales sont conservées.`);
      }
      summary.refreshed += 1;
    } catch (err) {
      const out = translate(err);
      if (isRevoked(out)) {
        report(`Session expirée pour ${label} : reconnexion nécessaire.`);
        await forget(account.id, { revoke: false });
        summary.removed += 1;
      } else {
        summary.unreachable += 1;
        logger.warn(`Session de ${label} non rétablie (${out.code}) : le compte est conservé.`);
      }
    }
  }

  const active = currentId();
  if (active && sessions.has(active)) scheduleRenew(active);

  report(
    summary.refreshed > 0
      ? `${summary.refreshed} session(s) rétablie(s).`
      : 'Aucune session rétablie : connexion requise.'
  );
  emitChange();

  return summary;
}

/* ------------------------------------------------------------------ mot de passe et 2FA */

/**
 * Demande de réinitialisation du mot de passe. Le serveur répond toujours favorablement,
 * que l'adresse existe ou non (anti-énumération, docs/API.md § 4.6).
 * @param {string} email
 */
async function forgotPassword(email) {
  try {
    await api.forgotPassword(email);
    logger.info('Demande de réinitialisation de mot de passe transmise.');
  } catch (err) {
    throw translate(err);
  }
}

/**
 * Prépare l'activation de la double authentification.
 * @returns {Promise<{secret: string, otpauth_uri: string, recovery_codes: string[]}>}
 */
function totpSetup() {
  return withAuth((token) => api.totpSetup(token));
}

/**
 * Active la double authentification après vérification d'un premier code.
 * @param {string} code
 */
async function totpEnable(code) {
  await withAuth((token) => api.totpEnable(code, token));
  logger.info('Double authentification activée.');
  await syncCurrent();
}

/**
 * Désactive la double authentification (mot de passe **et** code exigés).
 * @param {{password: string, code: string}} payload
 */
async function totpDisable({ password, code }) {
  await withAuth((token) => api.totpDisable({ password, code }, token));
  logger.warn('Double authentification désactivée.');
  await syncCurrent();
}

/**
 * Recharge le profil du compte actif depuis le serveur (`can_play`, `blocked_reason`,
 * `totp_enabled`, rattachement) et prévient le renderer.
 * @returns {Promise<object|null>} le compte mis à jour
 */
async function syncCurrent() {
  const id = currentId();
  if (!id) return null;
  try {
    return absorb(await withAuth((token) => api.me(token), id));
  } catch (err) {
    const out = translate(err);
    logger.warn(`Profil non rafraîchi (${out.code}) : les informations affichées datent du dernier échange.`);
    // Décoré comme partout ailleurs : le contrat `Account` porte `profile` et `link_device`,
    // même quand le rafraîchissement a échoué.
    return decorate(store.getAccount(id));
  }
}

/* ------------------------------------------------------------------ Microsoft */

/**
 * Traduit le résultat de la fenêtre Microsoft en erreur au code stable.
 * @param {object} result
 * @returns {Error}
 */
function embeddedFailure(result) {
  if (result.cancelled) {
    return fail(result.reason === 'timeout' ? 'link_timeout' : 'link_cancelled');
  }
  if (result.error === 'access_denied') return fail('link_denied');
  if (result.error === 'busy') return fail('link_busy');
  return fail('link_failed', result.description ? `${CLIENT_MESSAGES.link_failed} (${result.description})` : undefined);
}

/**
 * Flux `embedded` : fenêtre de consentement, puis transmission du code au serveur, qui seul
 * dialogue avec Microsoft.
 * @param {object} start   réponse de `POST /link/microsoft/start`
 * @param {string} id      compte concerné
 * @param {AbortSignal} [signal]  annulation demandée par le joueur
 * @returns {Promise<object>} le `user` remis à jour
 */
async function linkEmbedded(start, id, signal) {
  const result = await microsoft.runEmbeddedFlow({
    authorize_url: start.authorize_url,
    redirect_uri: start.redirect_uri,
  });

  // Le joueur a renoncé pendant que la fenêtre Microsoft était ouverte : le code obtenu,
  // s'il y en a un, ne sera pas transmis au serveur.
  if (signal && signal.aborted) throw fail('link_cancelled');

  if (!result || typeof result.code !== 'string' || result.code === '') {
    throw embeddedFailure(result || {});
  }

  logger.info('Rattachement Microsoft : vérification de la possession par le serveur…');
  return withAuth((token) => api.linkComplete({ state: start.state, code: result.code }, token), id);
}

/**
 * URL de vérification Microsoft, validée avant d'être confiée au système d'exploitation.
 *
 * `verification_uri` traverse notre serveur depuis la réponse `device_code` de Microsoft, et
 * le point d'entrée est lui-même configurable (`OPM_MSA_DEVICE_CODE_URL`) : sans ce filtre,
 * une valeur `file://…` ou `ms-msdt:…` serait lancée par la machine du joueur. Même règle
 * que `src/main/ipc.js` et `src/app.js` — seuls `http:` et `https:` sortent d'ici.
 *
 * @param {unknown} value
 * @returns {string} l'URL retenue, ou une chaîne vide si elle est refusée
 */
function verificationUri(value) {
  if (typeof value !== 'string' || value === '' || value.length > 2048) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return value;
  } catch {
    /* URL illisible : traitée comme absente */
  }
  logger.warn(`Adresse de vérification Microsoft refusée (schéma non autorisé) : ${value.slice(0, 120)}`);
  return '';
}

/**
 * Publie (ou retire) le code du flux `device` à destination du renderer.
 *
 * Le code voyage dans le champ `link_device` de l'`Account` actif (docs/IPC.md § Types),
 * diffusé par `auth:changed` : l'écran de connexion peut l'afficher **dès sa réception**,
 * sans attendre la fin de la scrutation. Il n'est jamais journalisé — quiconque lit
 * `launcher.log` pendant sa validité pourrait le saisir avec SON compte Microsoft.
 *
 * @param {{id: string, user_code: string, verification_uri: string, expires_at: string}|null} value
 */
function publishDeviceLink(value) {
  deviceLink = value;
  emitChange();
}

/**
 * Flux `device` : le joueur saisit un code sur microsoft.com/link pendant que le launcher
 * interroge le serveur au rythme convenu.
 *
 * Le code est transmis au renderer avant l'entrée dans la boucle de scrutation, puis la page
 * Microsoft est ouverte dans le navigateur du joueur.
 *
 * La scrutation est interruptible : `cancelLink()` déclenche le signal, la boucle rend la
 * main immédiatement et le rattachement se solde par `link_cancelled` — le joueur n'attend
 * pas les quinze minutes du code pour pouvoir réessayer.
 *
 * @param {object} start  réponse de `POST /link/microsoft/start`
 * @param {string} id     compte concerné
 * @param {{controller: AbortController}} [session]  rattachement en cours : porte
 *        l'annulation, et identifie le propriétaire du code publié
 * @returns {Promise<object>} le `user` remis à jour
 */
async function linkDevice(start, id, session) {
  const signal = session ? session.controller.signal : undefined;
  const code = typeof start.user_code === 'string' ? start.user_code : '';
  const uri = verificationUri(start.verification_uri);
  const expiresIn = clampInt(start.expires_in, 60, 3600, DEVICE_EXPIRES_DEFAULT_S);
  let interval = clampInt(start.interval, DEVICE_INTERVAL_MIN_S, DEVICE_INTERVAL_MAX_S, DEVICE_INTERVAL_DEFAULT_S);

  if (!start.device_code) throw fail('link_failed', "Le serveur n'a pas fourni de code de rattachement.");
  if (!code) throw fail('link_failed', "Le serveur n'a pas fourni de code à saisir.");

  const deadline = Date.now() + expiresIn * 1000;

  publishDeviceLink({
    id,
    user_code: code,
    verification_uri: uri || 'https://microsoft.com/link',
    expires_at: new Date(deadline).toISOString(),
    owner: session || null,
  });

  logger.info(
    `Rattachement Microsoft : ouvrez ${uri || 'microsoft.com/link'} et saisissez le code affiché ` +
      `dans le launcher (valable ${Math.round(expiresIn / 60)} minutes).`
  );

  if (uri) {
    try {
      await shell.openExternal(uri);
    } catch (err) {
      logger.warn(`Ouverture de la page Microsoft impossible (${err.message}) : à ouvrir à la main.`);
    }
  }

  try {
    while (Date.now() < deadline) {
      await sleep(interval * 1000, signal);
      if (signal && signal.aborted) throw fail('link_cancelled');

      try {
        const answer = await withAuth((token) => api.linkPoll(start.device_code, token, signal), id);
        if (isPlainObject(answer) && answer.status === 'pending') continue;
        return answer;
      } catch (err) {
        // Une requête coupée par l'annulation n'est pas un incident réseau.
        if (signal && signal.aborted) throw fail('link_cancelled');

        const out = translate(err);

        // Trop de sollicitations : on respecte le délai demandé par le serveur.
        if (out.code === 'rate_limited') {
          const wait = clampInt(out.details?.retry_after, DEVICE_INTERVAL_MIN_S, DEVICE_INTERVAL_MAX_S, interval);
          interval = Math.max(interval, wait);
          continue;
        }
        // Une coupure passagère ne doit pas annuler un rattachement en cours.
        if (out.code === 'network' || out.code === 'timeout') continue;

        throw out;
      }
    }
  } finally {
    // Le code n'est plus valable : le renderer doit cesser de l'afficher, quelle que soit
    // l'issue (rattachement obtenu, refus, délai dépassé, annulation). On n'efface que le
    // nôtre : une nouvelle tentative a pu, entre-temps, en publier un autre.
    if (deviceLink && deviceLink.owner === (session || null)) publishDeviceLink(null);
  }

  throw fail('link_timeout');
}

/**
 * Rattache un compte Microsoft au compte OPM actif — obligatoire pour jouer (docs/API.md § 0).
 *
 * Le launcher ne fait que transporter un code d'autorisation ; la chaîne
 * XBL → XSTS → Minecraft Services → `/minecraft/profile` est exécutée par notre serveur,
 * qui met le résultat en cache. Aucun jeton Microsoft ne transite par ici.
 *
 * @returns {Promise<object>} le compte, rattachement compris
 */
async function linkMicrosoft() {
  const id = currentId();
  if (!id) throw fail('no_account');
  if (linkSession) throw fail('link_busy');

  const session = { id, controller: new AbortController() };
  linkSession = session;
  const { signal } = session.controller;

  try {
    const start = await withAuth((token) => api.linkStart(token), id);
    if (signal.aborted) throw fail('link_cancelled');
    if (!isPlainObject(start)) throw fail('link_failed', "Le serveur n'a pas ouvert de rattachement.");

    const payload =
      start.flow === 'device'
        ? await linkDevice(start, id, session)
        : await linkEmbedded(start, id, signal);
    const account = absorb(payload);

    logger.info(
      account.minecraft
        ? `Rattachement Microsoft réussi : ${account.minecraft.name} (possession vérifiée).`
        : 'Rattachement Microsoft terminé.'
    );
    return account;
  } catch (err) {
    const out = translate(err);
    logger.warn(`Rattachement Microsoft interrompu (${out.code}).`);
    throw out;
  } finally {
    // `cancelLink()` a pu libérer le verrou avant nous, et un nouveau rattachement avoir
    // déjà commencé : on ne retire que le nôtre.
    if (linkSession === session) linkSession = null;
  }
}

/**
 * Annule le rattachement Microsoft en cours (canal `auth:cancel-link`, docs/IPC.md).
 *
 * Trois effets, dans cet ordre : le verrou est libéré sur-le-champ — le joueur peut
 * relancer un rattachement immédiatement, sans attendre la fin d'une scrutation qui dure
 * jusqu'à quinze minutes ; le signal d'annulation interrompt la boucle et la requête en
 * vol ; le code `link_device` disparaît de l'`Account`, ce que `auth:changed` publie.
 *
 * Sans rattachement en cours : sans effet, et sans exception.
 */
function cancelLink() {
  const session = linkSession;
  if (!session) return;

  linkSession = null;
  try {
    session.controller.abort();
  } catch (err) {
    logger.warn('Signal d’annulation du rattachement Microsoft en erreur :', err);
  }

  logger.info('Rattachement Microsoft annulé à la demande du joueur.');
  publishDeviceLink(null);
}

/**
 * Dissocie le compte Microsoft. Le mot de passe OPM est exigé par le serveur : une session
 * volée ne doit pas pouvoir libérer le compte Minecraft.
 * @param {string} password
 */
async function unlinkMicrosoft(password) {
  await withAuth((token) => api.unlink(password, token));
  logger.warn('Compte Microsoft dissocié : le jeu restera indisponible jusqu’au prochain rattachement.');
  await syncCurrent();
}

/**
 * Re-vérifie la possession de Minecraft et repousse l'échéance du cache serveur.
 * @returns {Promise<object>} le compte mis à jour
 */
async function verifyOwnership() {
  const payload = await withAuth((token) => api.linkRefresh(token));
  const account = absorb(payload);
  logger.info(
    account.can_play
      ? 'Possession de Minecraft confirmée.'
      : `Possession non confirmée (${account.blocked_reason || 'motif inconnu'}).`
  );
  return account;
}

/* ------------------------------------------------------------------ session de jeu */

/**
 * Demande la session Yggdrasil du compte actif et la met à la forme attendue par
 * l'`authenticator` de minecraft-java-core (docs/API.md § 1.4).
 *
 * Cette session est signée par **notre** serveur (Ed25519) et vaut 24 heures ; c'est elle,
 * et elle seule, que reçoit le jeu.
 *
 * @returns {Promise<{access_token: string, client_token: string, uuid: string, name: string,
 *                    user_properties: string, meta: {type: string, demo: boolean, expires_at: string|null}}>}
 */
async function gameSession() {
  const data = await withAuth((token) => api.gameSession(token));

  if (!isPlainObject(data) || typeof data.access_token !== 'string' || typeof data.uuid !== 'string') {
    throw fail('invalid_response', "Le serveur n'a pas délivré de session de jeu exploitable.");
  }

  const meta = isPlainObject(data.meta) ? data.meta : {};

  return {
    access_token: data.access_token,
    client_token: typeof data.client_token === 'string' ? data.client_token : '',
    uuid: data.uuid,
    name: typeof data.name === 'string' ? data.name : '',
    // minecraft-java-core attend une chaîne : le serveur envoie déjà du JSON sérialisé.
    user_properties: typeof data.user_properties === 'string' ? data.user_properties : JSON.stringify(data.user_properties ?? {}),
    meta: {
      type: typeof meta.type === 'string' ? meta.type : 'OPM',
      demo: Boolean(meta.demo),
      expires_at: typeof meta.expires_at === 'string' ? meta.expires_at : null,
    },
  };
}

/**
 * Clôt la session de jeu du compte actif à la fermeture de Minecraft.
 *
 * Deux effets côté serveur (docs/API.md § 1.4, docs/DATA.md § 4) : la durée jouée s'ajoute à
 * `users.tempsdejeu` — la seule écriture que nous nous autorisons sur cette colonne — et le
 * `client_token` invalide la session Yggdrasil, qui vaudrait sinon 24 h après la fin de la
 * partie.
 *
 * L'appel est **volontairement non fatal** : c'est `game.js` qui l'invoque, une fois la partie
 * terminée. Un serveur injoignable à cet instant ne doit rien casser — la session finira par
 * expirer d'elle-même, et le temps de jeu de cette partie sera simplement perdu.
 *
 * @param {{duration_s: number, client_token?: string, account_id?: string}} payload
 *        `account_id` fige le compte crédité : le joueur peut très bien en changer dans le
 *        launcher pendant qu'il joue, la partie doit rester au compte qui l'a lancée.
 * @returns {Promise<void>}
 */
async function closeGameSession({ duration_s, client_token, account_id }) {
  const seconds = clampInt(duration_s, 0, 86_400, 0);
  const id = account_id && store.getAccount(account_id) ? account_id : currentId();
  if (!id) throw fail('no_account');
  await withAuth((token) => api.gameSessionClose({ duration_s: seconds, client_token }, token), id);
}

module.exports = {
  init,
  list,
  current,
  select,
  remove,
  register,
  login,
  logout,
  refreshAll,
  accessToken,
  linkMicrosoft,
  cancelLink,
  unlinkMicrosoft,
  verifyOwnership,
  forgotPassword,
  totpSetup,
  totpEnable,
  totpDisable,
  gameSession,
  closeGameSession,
  onChange,
};
