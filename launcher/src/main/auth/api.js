'use strict';

/**
 * Client HTTP du serveur d'authentification OPM (FastAPI).
 * Traduction fidèle de docs/API.md § 1 : une méthode par point d'entrée, aucun état
 * de session ici. Le module ne connaît ni les comptes ni les jetons stockés : il reçoit
 * l'`access_token` en paramètre et le pose dans l'en-tête `Authorization`.
 * Le rafraîchissement, la sélection du compte et la gestion du coffre appartiennent
 * à `auth/accounts.js`.
 *
 * Choix d'implémentation :
 *  - `fetch` natif de Node 18+ (aucune dépendance HTTP supplémentaire) ;
 *  - délai maximal par `AbortController` : 10 s, porté à 60 s pour les échanges qui
 *    déclenchent côté serveur la chaîne Microsoft (XBL → XSTS → Minecraft Services) ;
 *  - deux tentatives au plus, avec attente progressive, uniquement sur erreur réseau,
 *    dépassement de délai ou 5xx ; **jamais** sur une réponse 4xx, qui est une décision
 *    du serveur et non un incident ;
 *  - toute erreur remonte sous forme d'`ApiError`, jamais de `TypeError` de `fetch`.
 *
 * Aucune donnée sensible n'est journalisée : ni corps de requête, ni jeton, ni mot de passe.
 */

const DEFAULT_BASE_URL = 'https://auth.onepieceminecraft.fr';

/** Préfixe commun de l'API launcher (docs/API.md § 1). */
const API = '/api/v1';

/** Délai maximal d'une requête ordinaire. */
const TIMEOUT_MS = 10_000;

/** Délai maximal des requêtes qui font travailler le serveur avec Microsoft. */
const TIMEOUT_MS_MICROSOFT = 60_000;

/** Nombre total de tentatives (1 essai + 1 reprise). */
const MAX_ATTEMPTS = 2;

/** Base de l'attente entre deux tentatives, en millisecondes. */
const RETRY_DELAY_MS = 500;

/* ------------------------------------------------------------------ erreurs */

/**
 * Erreur normalisée du serveur — format de docs/API.md § 3 :
 * `{ "error": "invalid_credentials", "message": "…", "details": null }`
 *
 * Codes propres au client, absents du serveur :
 *  - `network`          serveur injoignable ;
 *  - `timeout`          aucune réponse dans le délai imparti ;
 *  - `aborted`          requête annulée par l'appelant ;
 *  - `invalid_response` réponse illisible (JSON attendu).
 */
class ApiError extends Error {
  /**
   * @param {string} code            code d'erreur normalisé
   * @param {number} status          statut HTTP, 0 si la requête n'a pas abouti
   * @param {string} message         message destiné à l'affichage
   * @param {object|null} [details]  informations complémentaires (`until`, `retry_after`…)
   */
  constructor(code, status, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Message de repli quand le serveur ne fournit pas le sien. */
function fallbackMessage(status) {
  if (status === 401) return "Authentification requise.";
  if (status === 403) return "Accès refusé.";
  if (status === 404) return "Ressource introuvable.";
  if (status === 409) return "Conflit avec une donnée existante.";
  if (status === 429) return "Trop de tentatives, réessayez dans un instant.";
  if (status === 503) return "Service momentanément indisponible.";
  if (status >= 500) return "Le serveur a rencontré une erreur.";
  return `La requête a échoué (HTTP ${status}).`;
}

/* ------------------------------------------------------------------ utilitaires */

/**
 * Journalisation paresseuse : `logger` est chargé à l'appel, ce qui évite tout cycle de
 * `require` entre modules du processus principal. Une panne de journalisation ne doit
 * jamais faire échouer une requête.
 * @param {'info'|'warn'|'error'} level
 * @param {string} text
 */
function log(level, text) {
  try {
    require('../services/logger').log(level, text);
  } catch {
    console[level === 'error' ? 'error' : 'warn'](`[api] ${text}`);
  }
}

/** En-tête `User-Agent`, calculé une fois : « OPMLauncher/2.0.0 ». */
let cachedUserAgent = null;
function userAgent() {
  if (!cachedUserAgent) cachedUserAgent = `OPMLauncher/${require('electron').app.getVersion()}`;
  return cachedUserAgent;
}

/**
 * Valide une URL de base et retire la barre oblique finale.
 * @param {string} value
 * @returns {string}
 */
function normalizeBaseUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('seuls les schémas http et https sont acceptés');
  }
  return (url.origin + url.pathname).replace(/\/+$/, '');
}

/**
 * URL de base initiale : `OPM_API_URL` (développement, préproduction) sinon la constante
 * de production. Une variable d'environnement invalide est ignorée, avec avertissement :
 * le launcher doit démarrer quoi qu'il arrive.
 * @returns {string}
 */
function initialBaseUrl() {
  const fromEnv = process.env.OPM_API_URL;
  if (!fromEnv) return DEFAULT_BASE_URL;
  try {
    const normalized = normalizeBaseUrl(fromEnv);
    log('info', `API OPM : ${normalized} (défini par OPM_API_URL).`);
    return normalized;
  } catch (err) {
    log('warn', `OPM_API_URL ignorée (${err.message}) : « ${fromEnv} ». Base par défaut conservée.`);
    return DEFAULT_BASE_URL;
  }
}

let base = initialBaseUrl();

/** @returns {string} URL de base courante, sans barre oblique finale */
function baseUrl() {
  return base;
}

/**
 * Change l'URL de base du serveur (bascule vers un serveur local, par exemple).
 * @param {string} value
 * @returns {string} l'URL retenue
 */
function setBaseUrl(value) {
  base = normalizeBaseUrl(value);
  log('info', `API OPM : ${base}.`);
  return base;
}

/**
 * @param {string} path             chemin absolu depuis l'URL de base, ex. `/api/v1/status`
 * @param {Record<string, any>} [query]
 * @returns {string}
 */
function buildUrl(path, query) {
  const url = new URL(base + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Une reprise n'a de sens que si l'incident peut disparaître de lui-même. */
function isRetryable(error) {
  if (!(error instanceof ApiError)) return false;
  if (error.code === 'network' || error.code === 'timeout') return true;
  return error.status >= 500 && error.status <= 599;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ transport */

/**
 * Lit la réponse et la convertit soit en données, soit en `ApiError`.
 * @param {Response} response
 * @returns {Promise<any>} `null` pour les réponses sans contenu (204, corps vide)
 */
async function parseResponse(response) {
  const { status } = response;

  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    // Le détail technique reste au journal : le joueur lit une phrase en français.
    log('warn', `Réponse interrompue : ${err.message}`);
    throw new ApiError('network', status, 'La réponse du serveur a été interrompue.', {
      cause: String(err.message || err),
    });
  }

  let data = null;
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (response.ok) {
    if (status === 204 || text === '') return null;
    if (data === null) throw new ApiError('invalid_response', status, 'Réponse illisible du serveur.');
    return data;
  }

  const code = typeof data?.error === 'string' ? data.error : `http_${status}`;
  const message = typeof data?.message === 'string' ? data.message : fallbackMessage(status);
  let details = data && typeof data.details === 'object' ? data.details : null;

  // 429 : le serveur indique le délai d'attente dans un en-tête, pas dans le corps.
  if (status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter)) details = { ...(details ?? {}), retry_after: retryAfter };
  }

  throw new ApiError(code, status, message, details);
}

/**
 * Une tentative unique, sous contrôle de délai.
 * @param {string} method
 * @param {string} url
 * @param {Record<string,string>} headers
 * @param {string|undefined} payload
 * @param {number} timeoutMs
 * @param {AbortSignal|undefined} external  annulation demandée par l'appelant
 * @returns {Promise<any>}
 */
async function attempt(method, url, headers, payload, timeoutMs, external) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort();
  if (external) external.addEventListener('abort', forward, { once: true });

  try {
    let response;
    try {
      response = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    } catch (err) {
      if (external?.aborted) throw new ApiError('aborted', 0, 'Requête annulée.');
      if (controller.signal.aborted) {
        throw new ApiError('timeout', 0, `Le serveur n'a pas répondu en ${Math.round(timeoutMs / 1000)} s.`);
      }

      // Le message de `fetch` est technique et anglais (« fetch failed »,
      // « getaddrinfo ENOTFOUND … ») : il descend au journal et dans `details`, jamais
      // dans le message affiché. Tous les appelants ne passent pas par
      // `accounts.translate()` — `game.js` et `content.js` remontent cette erreur telle
      // quelle jusqu'au toast du joueur.
      const detail = String(err && err.message ? err.message : err);
      log('warn', `${method} ${url} — serveur injoignable : ${detail}`);
      throw new ApiError(
        'network',
        0,
        "Le serveur est injoignable. Vérifiez votre connexion internet.",
        { cause: detail }
      );
    }
    return await parseResponse(response);
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', forward);
  }
}

/**
 * Requête générique — brique de toutes les méthodes ci-dessous, utilisable telle quelle
 * pour un point d'entrée non listé (Yggdrasil, par exemple).
 *
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} path  chemin absolu depuis l'URL de base, ex. `/api/v1/auth/me`
 * @param {object} [options]
 * @param {any}    [options.body]       corps sérialisé en JSON
 * @param {Record<string,any>} [options.query]  paramètres d'URL
 * @param {string} [options.token]      `access_token` OPM à porter en `Bearer`
 * @param {number} [options.timeoutMs]  délai maximal (défaut : 10 s)
 * @param {number} [options.attempts]   tentatives au plus (défaut : 2)
 * @param {AbortSignal} [options.signal] annulation depuis l'appelant
 * @returns {Promise<any>} données JSON, ou `null` si la réponse est sans contenu
 * @throws {ApiError}
 */
async function request(method, path, options = {}) {
  const {
    body,
    query,
    token,
    timeoutMs = TIMEOUT_MS,
    attempts = MAX_ATTEMPTS,
    signal,
  } = options;

  const url = buildUrl(path, query);
  const headers = { Accept: 'application/json', 'User-Agent': userAgent() };
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  for (let n = 1; ; n += 1) {
    try {
      return await attempt(method, url, headers, payload, timeoutMs, signal);
    } catch (err) {
      if (n >= attempts || !isRetryable(err)) throw err;
      log('warn', `${method} ${path} — ${err.code} ; nouvelle tentative (${n + 1}/${attempts}).`);
      await delay(RETRY_DELAY_MS * n + Math.floor(Math.random() * 200));
    }
  }
}

/* ============================================================ 1.1 Amorçage ============ */

/**
 * Plateforme annoncée au serveur, dans les valeurs de l'énumération `Platform`
 * (`opm_auth/routers/launcher.py`) : `windows` | `mac` | `linux`.
 *
 * Notre `User-Agent` (« OPMLauncher/2.0.0 ») ne mentionne aucun système : sans ce
 * paramètre, le serveur renifle l'en-tête, ne trouve rien et retombe sur Windows —
 * un joueur macOS ou Linux recevrait l'URL de téléchargement Windows.
 * @returns {'windows'|'mac'|'linux'}
 */
function platformName() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'linux') return 'linux';
  return 'windows';
}

/**
 * Premier appel du launcher : version minimale exigée, maintenance, mode d'authentification,
 * adresse du serveur de jeu et liens communautaires. Non authentifié.
 * @returns {Promise<object>}
 */
function bootstrap() {
  return request('GET', `${API}/bootstrap`, { query: { platform: platformName() } });
}

/* ============================================================ 1.2 Comptes OPM ========= */

/**
 * Création d'un compte OPM.
 * @param {{email: string, password: string, username: string}} payload
 * @returns {Promise<object>} `{ user }`
 */
function register({ email, password, username }) {
  return request('POST', `${API}/auth/register`, { body: { email, password, username } });
}

/**
 * Connexion par e-mail et mot de passe. Le code TOTP n'est envoyé que si le serveur l'a
 * réclamé lors d'une première tentative (`401 totp_required`).
 * @param {{email: string, password: string, totp?: string}} payload
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number, user: object}>}
 */
function login({ email, password, totp }) {
  const body = { email, password };
  if (totp) body.totp = totp;
  return request('POST', `${API}/auth/login`, { body });
}

/**
 * Renouvellement de session. Le serveur pratique la rotation : le `refresh_token` renvoyé
 * remplace immédiatement l'ancien, qui devient invalide.
 * @param {string} refreshToken
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
 */
function refresh(refreshToken) {
  return request('POST', `${API}/auth/refresh`, { body: { refresh_token: refreshToken } });
}

/**
 * Révocation d'une session.
 * @param {string} refreshToken
 * @returns {Promise<null>}
 */
function logout(refreshToken) {
  return request('POST', `${API}/auth/logout`, { body: { refresh_token: refreshToken } });
}

/**
 * Profil complet du compte connecté, `can_play` et `blocked_reason` compris.
 * @param {string} token  `access_token`
 * @returns {Promise<object>} `{ user }`
 */
function me(token) {
  return request('GET', `${API}/auth/me`, { token });
}

/**
 * Demande de réinitialisation de mot de passe. Le serveur répond toujours `202`,
 * que l'adresse existe ou non (anti-énumération).
 * @param {string} email
 * @returns {Promise<null>}
 */
function forgotPassword(email) {
  return request('POST', `${API}/auth/password/forgot`, { body: { email } });
}

/**
 * Réinitialisation effective, avec le jeton à usage unique reçu par courriel.
 * @param {{token: string, password: string}} payload  `token` = jeton de réinitialisation,
 *                                                     ce n'est pas un `access_token`
 * @returns {Promise<null>}
 */
function resetPassword({ token, password }) {
  return request('POST', `${API}/auth/password/reset`, { body: { token, password } });
}

/**
 * Prépare l'activation de la double authentification.
 * @param {string} token  `access_token`
 * @returns {Promise<{secret: string, otpauth_uri: string, recovery_codes: string[]}>}
 */
function totpSetup(token) {
  return request('POST', `${API}/auth/totp/setup`, { token });
}

/**
 * Confirme l'activation avec un premier code valide.
 * @param {string} code
 * @param {string} token  `access_token`
 * @returns {Promise<null>}
 */
function totpEnable(code, token) {
  return request('POST', `${API}/auth/totp/enable`, { body: { code }, token });
}

/**
 * Désactive la double authentification (mot de passe **et** code exigés).
 * @param {{password: string, code: string}} payload
 * @param {string} token  `access_token`
 * @returns {Promise<null>}
 */
function totpDisable({ password, code }, token) {
  return request('POST', `${API}/auth/totp/disable`, { body: { password, code }, token });
}

/* ============================================================ 1.3 Rattachement MS ===== */

/**
 * Ouvre un rattachement Microsoft. Le serveur renvoie soit un flux `embedded`
 * (`authorize_url`, `redirect_uri`, `state`), soit un flux `device`
 * (`verification_uri`, `user_code`, `device_code`, `interval`, `expires_in`).
 * @param {string} token  `access_token`
 * @returns {Promise<object>}
 */
function linkStart(token) {
  return request('POST', `${API}/link/microsoft/start`, { token, timeoutMs: TIMEOUT_MS_MICROSOFT });
}

/**
 * Termine un flux `embedded` : le launcher ne fait que transmettre le code d'autorisation
 * capté dans la fenêtre Microsoft. C'est le serveur qui exécute XBL → XSTS →
 * Minecraft Services → `/minecraft/profile`, d'où le délai élargi.
 * @param {{state: string, code: string}} payload
 * @param {string} token  `access_token`
 * @returns {Promise<object>} `{ user }` remis à jour
 */
function linkComplete({ state, code }, token) {
  return request('POST', `${API}/link/microsoft/complete`, {
    body: { state, code },
    token,
    timeoutMs: TIMEOUT_MS_MICROSOFT,
  });
}

/**
 * Interroge l'avancement d'un flux `device`. Une seule tentative : l'appelant boucle déjà
 * au rythme donné par `interval`, une reprise interne ne ferait que dérégler ce rythme.
 * @param {string} deviceCode
 * @param {string} token  `access_token`
 * @param {AbortSignal} [signal]  annulation du rattachement par le joueur : la requête en
 *        vol est coupée sans attendre le délai d'une minute
 * @returns {Promise<{status: 'pending'}|{user: object}>} `{status:'pending'}` tant que le
 *          joueur n'a pas validé côté Microsoft, sinon le profil rattaché
 */
function linkPoll(deviceCode, token, signal) {
  return request('POST', `${API}/link/microsoft/poll`, {
    body: { device_code: deviceCode },
    token,
    timeoutMs: TIMEOUT_MS_MICROSOFT,
    attempts: 1,
    signal,
  });
}

/**
 * Re-vérifie la possession de Minecraft et repousse l'échéance du cache serveur.
 * @param {string} token  `access_token`
 * @returns {Promise<object>} `{ user }` remis à jour
 */
function linkRefresh(token) {
  return request('POST', `${API}/link/microsoft/refresh`, { token, timeoutMs: TIMEOUT_MS_MICROSOFT });
}

/**
 * Détache le compte Microsoft. Le mot de passe OPM est exigé pour éviter qu'une session
 * volée puisse libérer le compte Minecraft.
 * @param {string} password
 * @param {string} token  `access_token`
 * @returns {Promise<null>}
 */
function unlink(password, token) {
  return request('DELETE', `${API}/link/microsoft`, { body: { password }, token });
}

/* ============================================================ 1.4 Session de jeu ====== */

/**
 * Délivre la session Yggdrasil maison à passer telle quelle à minecraft-java-core.
 * Aucun jeton Microsoft n'y figure : la signature est la nôtre (Ed25519).
 * @param {string} token  `access_token`
 * @returns {Promise<{access_token: string, client_token: string, uuid: string, name: string,
 *                    user_properties: string, meta: object}>}
 */
function gameSession(token) {
  return request('POST', `${API}/game/session`, { token });
}

/**
 * Clôt une session de jeu : la durée jouée s'ajoute à `users.tempsdejeu` (docs/DATA.md § 4,
 * seule écriture autorisée sur cette colonne) et le `client_token` invalide sur-le-champ la
 * session Yggdrasil de 24 h, pour qu'un jeton ne survive pas à la partie qu'il servait.
 *
 * Le serveur répond `204`, y compris pour une durée nulle ou une partie déjà close : cet
 * appel n'est jamais bloquant côté launcher.
 *
 * @param {{duration_s: number, client_token?: string}} payload  `duration_s` entier, 0 à 86 400
 * @param {string} token  `access_token`
 * @returns {Promise<null>}
 */
function gameSessionClose({ duration_s, client_token }, token) {
  const body = { duration_s };
  if (client_token) body.client_token = client_token;
  return request('POST', `${API}/game/session/close`, { body, token });
}

/* ============================================================ 1.5 Contenu ============= */

/**
 * Actualités du launcher.
 * @param {number} [limit=10]
 * @param {string} [token]  facultatif : permet au serveur de filtrer les annonces réservées
 * @returns {Promise<{featured: object|null, items: object[]}>}
 */
function news(limit = 10, token) {
  return request('GET', `${API}/news`, { query: { limit }, token });
}

/**
 * Instances de jeu, au format attendu par minecraft-java-core.
 * @returns {Promise<object[]>}
 */
function instances() {
  return request('GET', `${API}/instances`);
}

/**
 * État du serveur Minecraft.
 * @returns {Promise<{online: boolean, players_online: number, players_max: number,
 *                    tps: number, motd: string, latency_ms: number}>}
 */
function status() {
  return request('GET', `${API}/status`);
}

/**
 * Prochain événement RP annoncé.
 * @returns {Promise<{title: string, starts_at: string, description: string}|null>}
 *          `null` quand aucun événement n'est programmé
 */
function nextEvent() {
  return request('GET', `${API}/events/next`);
}

/**
 * Compteur de votes de la période en cours.
 * @returns {Promise<{count: number, goal: number, reward: string, reset_at: string}>}
 */
function votes() {
  return request('GET', `${API}/votes`);
}

/**
 * Cagnotte : montant collecté, objectif, paliers et meilleurs donateurs.
 * @returns {Promise<object>}
 */
function donations() {
  return request('GET', `${API}/donations`);
}

/**
 * Ouvre une intention de don et renvoie l'URL de paiement à afficher dans le navigateur.
 * @param {number} amountCents  montant en centimes
 * @param {string} [token]      facultatif : rattache le don au compte connecté
 * @returns {Promise<{checkout_url: string}>}
 */
function donateCheckout(amountCents, token) {
  return request('POST', `${API}/donations/checkout`, { body: { amount_cents: amountCents }, token });
}

module.exports = {
  ApiError,
  setBaseUrl,
  baseUrl,
  request,
  bootstrap,
  register,
  login,
  refresh,
  logout,
  me,
  forgotPassword,
  resetPassword,
  totpSetup,
  totpEnable,
  totpDisable,
  linkStart,
  linkComplete,
  linkPoll,
  linkRefresh,
  unlink,
  gameSession,
  gameSessionClose,
  news,
  instances,
  status,
  nextEvent,
  votes,
  donations,
  donateCheckout,
};
