'use strict';

/**
 * Contenu éditorial et vivant du launcher : actualités, état du serveur, prochain
 * événement RP, votes du mois et cagnotte.
 *
 * Chaque source est mise en cache sur disque dans `cacheDir`, avec sa propre durée de
 * vie. Deux règles gouvernent ce module :
 *
 *  1. **On n'invente rien.** Toute valeur affichée vient du serveur (docs/API.md § 1.5).
 *     Aucune donnée de démonstration, aucun repli fabriqué.
 *  2. **On ne montre jamais un écran vide par simple panne réseau.** Si le serveur ne
 *     répond pas, le dernier contenu connu est renvoyé tel quel avec le marqueur
 *     `stale: true`, que l'interface signale par un bandeau « données hors ligne »
 *     (docs/DATA.md § 5). Ce n'est qu'en l'absence totale de cache que l'erreur remonte.
 *
 * Le cache disque survit au redémarrage : au premier affichage, le joueur voit le
 * journal de bord de sa dernière session pendant que le rafraîchissement se fait.
 */

const path = require('path');
const fsp = require('fs/promises');

const paths = require('./paths');
const logger = require('./logger');
const api = require('../auth/api');

/* ------------------------------------------------------------------ constantes */

/** Version du format des fichiers de cache : un changement invalide l'ancien contenu. */
const CACHE_VERSION = 1;

/** Nombre d'actualités demandées au serveur (docs/API.md § 1.5). */
const NEWS_LIMIT = 10;

/** Garde-fou sur le montant d'un don, en centimes : de 1 € à 10 000 €. */
const DONATION_MIN_CENTS = 100;
const DONATION_MAX_CENTS = 1_000_000;

/**
 * Sources de contenu. Les durées de vie suivent docs/DATA.md § 5 : l'état du serveur
 * doit être frais, le journal de bord peut vieillir tranquillement.
 */
const SOURCES = {
  news: {
    file: 'news.json',
    ttl: 5 * 60_000,
    label: 'le journal de bord',
    // Le jeton permet au serveur de filtrer les annonces réservées ; son absence
    // n'empêche pas l'appel, elle donne simplement les actualités publiques.
    load: (token) => api.news(NEWS_LIMIT, token),
    authenticated: true,
  },
  status: {
    file: 'status.json',
    ttl: 30_000,
    label: "l'état du serveur",
    load: () => api.status(),
  },
  nextEvent: {
    file: 'next-event.json',
    ttl: 60_000,
    label: 'le prochain événement',
    load: () => api.nextEvent(),
  },
  votes: {
    file: 'votes.json',
    ttl: 5 * 60_000,
    label: 'les votes du mois',
    load: () => api.votes(),
  },
  donations: {
    file: 'donations.json',
    ttl: 2 * 60_000,
    label: 'la cagnotte',
    load: () => api.donations(),
  },
};

/* ------------------------------------------------------------------ état interne */

/** @type {Map<string, {at: number, data: any}>} miroir mémoire du cache disque. */
const memory = new Map();

/** @type {Map<string, Promise<{at: number, data: any}>>} requêtes en cours, une par source. */
const inflight = new Map();

/** Sources dont le fichier de cache a déjà été lu (même absent) : on ne relit pas le disque. */
const diskChecked = new Set();

/* ------------------------------------------------------------------ utilitaires */

/**
 * Erreur porteuse d'un code normalisé, tel que l'attend `src/main/ipc.js`.
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Chemin du fichier de cache d'une source. */
function cacheFile(key) {
  return path.join(paths.cacheDir, SOURCES[key].file);
}

/**
 * Jeton d'accès du compte courant, ou `undefined` si personne n'est connecté.
 * Le module des comptes est chargé à l'appel pour éviter tout cycle de `require`
 * entre services du processus principal.
 * @returns {Promise<string|undefined>}
 */
async function accessToken() {
  try {
    const token = await require('../auth/accounts').accessToken();
    return typeof token === 'string' && token ? token : undefined;
  } catch {
    // Non connecté ou session expirée : le contenu public reste accessible.
    return undefined;
  }
}

/**
 * Lit le cache disque d'une source, une seule fois par exécution.
 * Un fichier absent, illisible ou d'un autre format est simplement ignoré.
 * @param {string} key
 * @returns {Promise<{at: number, data: any}|null>}
 */
async function readCache(key) {
  if (memory.has(key)) return memory.get(key);
  if (diskChecked.has(key)) return null;
  diskChecked.add(key);

  try {
    const raw = JSON.parse(await fsp.readFile(cacheFile(key), 'utf8'));
    if (!raw || raw.version !== CACHE_VERSION || typeof raw.fetched_at !== 'string') return null;

    const at = Date.parse(raw.fetched_at);
    if (!Number.isFinite(at)) return null;

    const entry = { at, data: raw.data ?? null };
    memory.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Écrit le cache disque d'une source. Une écriture ratée n'est jamais fatale :
 * le contenu reste en mémoire pour la session en cours.
 * @param {string} key
 * @param {{at: number, data: any}} entry
 */
async function writeCache(key, entry) {
  const file = cacheFile(key);
  const temp = `${file}.${process.pid}.tmp`;
  const payload = {
    version: CACHE_VERSION,
    key,
    fetched_at: new Date(entry.at).toISOString(),
    data: entry.data,
  };

  try {
    await fsp.mkdir(paths.cacheDir, { recursive: true });
    await fsp.writeFile(temp, `${JSON.stringify(payload)}\n`, 'utf8');
    await fsp.rename(temp, file);
  } catch (err) {
    logger.warn(`Cache de ${SOURCES[key].label} non enregistré : ${err.message}`);
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Oublie le contenu mémorisé d'une source, mémoire et disque. La source `diskChecked`
 * reste marquée : il n'y a plus rien à relire, le prochain accès ira au serveur.
 * @param {string} key
 */
async function invalidate(key) {
  memory.delete(key);
  diskChecked.add(key);
  await fsp.rm(cacheFile(key), { force: true }).catch(() => {});
}

/**
 * Ajoute les marqueurs de fraîcheur à un contenu.
 *
 * Les charges utiles du contrat sont des objets ; `nextEvent` peut valoir `null`
 * quand aucun événement n'est programmé, auquel cas il n'y a rien à annoter.
 *
 * @param {{at: number, data: any}} entry
 * @param {boolean} stale  vrai si le contenu vient d'un cache périmé
 * @returns {any}
 */
function decorate(entry, stale) {
  const { data, at } = entry;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
  return { ...data, stale, fetched_at: new Date(at).toISOString() };
}

/**
 * Interroge le serveur et met le résultat en cache.
 * @param {string} key
 * @returns {Promise<{at: number, data: any}>}
 */
async function refresh(key) {
  const source = SOURCES[key];
  const token = source.authenticated ? await accessToken() : undefined;

  const data = await source.load(token);
  const entry = { at: Date.now(), data: data ?? null };

  memory.set(key, entry);
  await writeCache(key, entry);
  return entry;
}

/**
 * Contenu d'une source : frais si le cache est encore valide, rafraîchi sinon,
 * périmé et marqué `stale` si le serveur est injoignable.
 * @param {string} key
 * @returns {Promise<any>}
 */
async function read(key) {
  const source = SOURCES[key];
  const cached = await readCache(key);

  if (cached && Date.now() - cached.at < source.ttl) return decorate(cached, false);

  let pending = inflight.get(key);
  if (!pending) {
    pending = refresh(key).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }

  try {
    return decorate(await pending, false);
  } catch (err) {
    if (cached) {
      const age = Math.round((Date.now() - cached.at) / 1000);
      logger.warn(`Impossible de rafraîchir ${source.label} (${err.message}) — contenu vieux de ${age} s réutilisé.`);
      return decorate(cached, true);
    }
    logger.error(`Impossible de récupérer ${source.label} : ${err.message}`);
    throw err;
  }
}

/* ------------------------------------------------------------------ surface */

/**
 * Journal de bord : actualité en vedette et liste des dernières publications.
 * @returns {Promise<{featured: object|null, items: object[], stale: boolean, fetched_at: string}>}
 */
function news() {
  return read('news');
}

/**
 * État du serveur Minecraft : joueurs connectés, TPS, latence, MOTD.
 * @returns {Promise<object>}
 */
function status() {
  return read('status');
}

/**
 * Prochain événement RP annoncé, ou `null` si rien n'est programmé.
 * @returns {Promise<object|null>}
 */
function nextEvent() {
  return read('nextEvent');
}

/**
 * Compteur de votes de la période en cours.
 * @returns {Promise<object>}
 */
function votes() {
  return read('votes');
}

/**
 * Cagnotte : montant collecté, objectif, paliers et donateurs.
 * @returns {Promise<object>}
 */
function donations() {
  return read('donations');
}

/**
 * Ouvre une intention de don et renvoie l'URL de paiement.
 *
 * L'URL est exigée en `https` : un don passe par un prestataire de paiement, jamais
 * par une adresse en clair ni par un autre protocole. L'ouverture effective revient au
 * canal `content:donate` de `src/main/ipc.js`, point unique d'ouverture de lien
 * externe du launcher ; ce module garantit qu'il ne lui remet qu'une adresse sûre.
 *
 * @param {number} amountCents  montant en centimes
 * @returns {Promise<{checkout_url: string}>}
 */
async function donateCheckout(amountCents) {
  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(cents) || cents < DONATION_MIN_CENTS || cents > DONATION_MAX_CENTS) {
    throw fail('invalid_amount', 'Le montant du don doit être compris entre 1 € et 10 000 €.');
  }

  const session = await api.donateCheckout(cents, await accessToken());
  const url = typeof session?.checkout_url === 'string' ? session.checkout_url.trim() : '';

  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.protocol !== 'https:') {
    logger.error("Le serveur a renvoyé une URL de paiement inexploitable.");
    throw fail('checkout_unavailable', 'Le paiement est momentanément indisponible.');
  }

  // La cagnotte affichée change dès que le don aboutit : son cache n'a plus de valeur.
  await invalidate('donations');

  logger.info(`Intention de don créée : ${(cents / 100).toFixed(2)} €.`);
  return { checkout_url: parsed.toString() };
}

module.exports = {
  news,
  status,
  nextEvent,
  votes,
  donations,
  donateCheckout,
};
