'use strict';

/**
 * Coffre local des jetons de renouvellement OPM (`refresh_token`).
 *
 * Règles (voir docs/IPC.md § « Stockage local ») :
 *  - un `refresh_token` ne quitte JAMAIS le processus principal ;
 *  - il n'est jamais écrit en clair sur le disque ;
 *  - `accounts.json` ne contient aucun jeton : tout est ici, dans `vault.bin`.
 *
 * Un seul mode d'écriture : `safeStorage` d'Electron — DPAPI (Windows), Trousseau (macOS),
 * libsecret (Linux). La clé appartient à la session système de l'utilisateur.
 *
 * **Quand `safeStorage` est indisponible, RIEN n'est écrit sur le disque.** Les jetons
 * restent en mémoire vive pour la durée de l'exécution, et le joueur devra se reconnecter au
 * prochain démarrage. C'est un choix délibéré, pris après la passe de vérification (§ M20) :
 * la version précédente repliait sur un AES-256-GCM dont la clé était dérivée du nom de
 * machine et du nom d'utilisateur — deux valeurs publiques — avec le sel rangé dans le
 * fichier lui-même. Quiconque obtenait une copie de `vault.bin` (sauvegarde, disque récupéré,
 * autre compte administrateur, maliciel sans privilège) reconstituait la clé en une ligne de
 * code. Ce n'était pas du chiffrement, seulement de l'obscurcissement : mieux vaut une
 * reconnexion honnête qu'un faux sentiment de sécurité.
 *
 * Le format hérité reste **lu**, uniquement pour ne pas déconnecter brutalement un joueur qui
 * met le launcher à jour : le coffre est alors soit ré-écrit avec `safeStorage` s'il est
 * disponible, soit effacé du disque et conservé en mémoire. Il n'est plus jamais produit.
 *
 * Format du fichier `vault.bin` — enveloppe JSON, contenu chiffré :
 *
 *   { "version": 1,
 *     "scheme":  "safeStorage" | "aes-256-gcm",   // « aes-256-gcm » : hérité, lecture seule
 *     "salt":    "<base64>",   // format hérité uniquement
 *     "iv":      "<base64>",   // format hérité uniquement
 *     "tag":     "<base64>",   // format hérité uniquement
 *     "data":    "<base64 du JSON chiffré { \"<id de compte>\": \"<refresh_token>\" }>" }
 *
 * `safeStorage` n'est interrogeable qu'une fois `app.whenReady()` résolu : le coffre refuse
 * d'écrire avant, pour ne jamais décider du contraire par accident.
 *
 * Toutes les opérations sont synchrones : le coffre est minuscule (quelques centaines
 * d'octets) et les appelants (accounts.js, ipc.js) sont déjà asynchrones.
 */

const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths');

/* ------------------------------------------------------------------ constantes */

/** Version du format de l'enveloppe. Toute évolution incompatible l'incrémente. */
const FORMAT_VERSION = 1;

const SCHEME_SAFE_STORAGE = 'safeStorage';

/** Schéma hérité, lu pour la migration, plus jamais écrit (voir l'en-tête du module). */
const SCHEME_AES = 'aes-256-gcm';

/** Paramètres scrypt du format hérité. `maxmem` doit dépasser 128 × N × r (ici 32 Mio). */
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEY_BYTES = 32;   // AES-256

/* ------------------------------------------------------------------ état interne */

/** Secrets déchiffrés, `null` tant que le coffre n'a pas été ouvert. @type {Map<string,string>|null} */
let secrets = null;

/** L'avertissement « mémoire seulement » n'est journalisé qu'une fois par session. */
let volatileWarned = false;

/* ------------------------------------------------------------------ utilitaires */

/**
 * Journalisation paresseuse : `logger` est chargé à l'appel, ce qui évite tout cycle de
 * `require` entre services. Une panne de journalisation ne doit jamais faire échouer
 * une écriture du coffre.
 * @param {'info'|'warn'|'error'} level
 * @param {string} text
 */
function log(level, text) {
  try {
    require('./logger').log(level, text);
  } catch {
    console[level === 'error' ? 'error' : 'warn'](`[vault] ${text}`);
  }
}

/**
 * `safeStorage` n'est interrogeable qu'une fois `app.whenReady()` résolu : interrogé plus tôt,
 * il répond faux même sur une machine parfaitement équipée. On refuse donc de conclure avant
 * ce moment — le coffre restera en mémoire plutôt que d'écrire n'importe comment.
 * @returns {boolean}
 */
function safeStorageAvailable() {
  try {
    if (!app.isReady()) {
      log('warn', "Coffre interrogé avant que l'application ne soit prête : écriture différée.");
      return false;
    }
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Matériau de dérivation du format hérité : nom de machine et nom du compte système — deux
 * valeurs PUBLIQUES, c'est précisément ce qui rendait ce format indéfendable. Conservé pour
 * relire un `vault.bin` écrit par une version antérieure du launcher, jamais pour en écrire un.
 */
function machineMaterial() {
  let user = 'utilisateur-inconnu';
  try {
    user = os.userInfo().username;
  } catch {
    // Certains environnements (conteneurs) n'ont pas d'entrée utilisateur : le nom de
    // machine et le sel suffisent alors à singulariser la clé.
  }
  return `opm-vault ${os.hostname()} ${user}`;
}

/**
 * Dérive la clé du format hérité pour un sel donné (lecture seule).
 * @param {Buffer} saltBuffer
 * @returns {Buffer}
 */
function deriveKey(saltBuffer) {
  return crypto.scryptSync(machineMaterial(), saltBuffer, KEY_BYTES, SCRYPT_OPTIONS);
}

/** Efface le fichier du coffre : rien de ce qu'il contient ne peut y être protégé. */
function dropVaultFile() {
  try {
    if (!fs.existsSync(paths.vaultFile)) return;
    fs.rmSync(paths.vaultFile, { force: true });
    log('warn', 'Coffre des sessions retiré du disque : il ne pouvait plus y être protégé.');
  } catch (err) {
    log('error', `Coffre des sessions non supprimé (${err.message}) : à retirer à la main.`);
  }
}

/**
 * Dit clairement, une fois, que les sessions ne seront pas conservées. Ce message doit être
 * compris par qui lit `launcher.log` à froid : pas de demi-mesure, pas de fausse assurance.
 */
function warnVolatileOnce() {
  if (volatileWarned) return;
  volatileWarned = true;
  log(
    'warn',
    "Aucun trousseau système disponible (safeStorage) : les jetons de session ne sont PAS " +
      "écrits sur le disque. Ils restent en mémoire pour la durée de cette exécution et une " +
      'reconnexion sera nécessaire au prochain démarrage. Le launcher ne fabrique plus de ' +
      "coffre chiffré par une clé dérivée du nom de machine : c'était de l'obscurcissement, " +
      'pas de la protection.'
  );
}

/**
 * Écriture atomique : fichier temporaire puis renommage, pour ne jamais laisser un coffre
 * tronqué derrière une coupure de courant. Droits 0600 sur les systèmes POSIX.
 * @param {string} file
 * @param {string} content
 */
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

/* ------------------------------------------------------------------ chiffrement */

/**
 * Chiffre la table des secrets et produit l'enveloppe à écrire.
 * N'est appelée que lorsque `safeStorage` est disponible : il n'existe plus d'autre mode
 * d'écriture (voir l'en-tête du module).
 * @param {Record<string,string>} plain
 * @returns {object}
 */
function seal(plain) {
  return {
    version: FORMAT_VERSION,
    scheme: SCHEME_SAFE_STORAGE,
    data: safeStorage.encryptString(JSON.stringify(plain)).toString('base64'),
  };
}

/**
 * Déchiffre une enveloppe lue sur le disque.
 * @param {object} envelope
 * @returns {Record<string,string>}
 */
function unseal(envelope) {
  if (!envelope || typeof envelope !== 'object') throw new Error('enveloppe absente');
  if (envelope.version !== FORMAT_VERSION) throw new Error(`version de coffre inconnue : ${envelope.version}`);

  const data = Buffer.from(String(envelope.data || ''), 'base64');

  if (envelope.scheme === SCHEME_SAFE_STORAGE) {
    if (!safeStorageAvailable()) throw new Error('coffre chiffré par le trousseau système, désormais indisponible');
    return JSON.parse(safeStorage.decryptString(data));
  }

  // Format hérité : relu une dernière fois, pour ne pas déconnecter brutalement un joueur
  // qui met le launcher à jour. `open()` s'occupe ensuite de le convertir ou de l'effacer.
  if (envelope.scheme === SCHEME_AES) {
    const key = deriveKey(Buffer.from(String(envelope.salt || ''), 'base64'));
    const decipher = crypto.createDecipheriv(SCHEME_AES, key, Buffer.from(String(envelope.iv || ''), 'base64'));
    decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64'));
    const clear = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(clear.toString('utf8'));
  }

  throw new Error(`schéma de chiffrement inconnu : ${envelope.scheme}`);
}

/* ------------------------------------------------------------------ chargement */

/**
 * Ouvre le coffre (une seule fois par session) et renvoie la table en mémoire.
 * Un coffre illisible n'est jamais fatal : on repart d'une table vide et l'utilisateur
 * devra se reconnecter — la prochaine écriture remplacera le fichier abîmé.
 * @returns {Map<string,string>}
 */
function open() {
  if (secrets) return secrets;
  secrets = new Map();

  let envelope = null;
  try {
    if (!fs.existsSync(paths.vaultFile)) return secrets;
    envelope = JSON.parse(fs.readFileSync(paths.vaultFile, 'utf8'));
  } catch (err) {
    log('error', `Coffre des sessions illisible (${err.message}) — une reconnexion sera nécessaire.`);
    return secrets;
  }

  try {
    const plain = unseal(envelope);
    for (const [id, token] of Object.entries(plain)) {
      if (typeof id === 'string' && id && typeof token === 'string' && token) secrets.set(id, token);
    }
  } catch (err) {
    log('error', `Coffre des sessions indéchiffrable (${err.message}) — une reconnexion sera nécessaire.`);
    return secrets;
  }

  // Coffre au format hérité : il ne doit pas rester sur le disque sous cette forme.
  if (envelope.scheme === SCHEME_AES) {
    if (safeStorageAvailable()) {
      log('warn', 'Coffre des sessions au format hérité : ré-écriture avec le trousseau système.');
      persist();
    } else {
      warnVolatileOnce();
      dropVaultFile();
    }
  }

  return secrets;
}

/**
 * Écrit sur le disque l'état courant de la table des secrets — **si et seulement si** le
 * trousseau système est disponible. Sinon, rien n'est écrit et tout `vault.bin` hérité est
 * retiré : la session vit en mémoire, et le joueur se reconnectera au prochain démarrage.
 */
function persist() {
  const table = open();

  if (!safeStorageAvailable()) {
    warnVolatileOnce();
    dropVaultFile();
    return;
  }

  writeAtomic(paths.vaultFile, JSON.stringify(seal(Object.fromEntries(table))));
}

/**
 * @param {unknown} id
 * @returns {string}
 */
function assertId(id) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError('vault : identifiant de compte attendu (chaîne non vide).');
  }
  return id;
}

/* ------------------------------------------------------------------ API publique */

/**
 * Enregistre (ou remplace) le `refresh_token` d'un compte.
 * @param {string} id      identifiant du compte OPM (`user.id` du serveur)
 * @param {string} value   jeton opaque à protéger
 */
function setSecret(id, value) {
  assertId(id);
  if (typeof value !== 'string' || value === '') {
    throw new TypeError('vault.setSecret : jeton attendu (chaîne non vide).');
  }
  open().set(id, value);
  persist();
}

/**
 * Lit le `refresh_token` d'un compte.
 * @param {string} id
 * @returns {string|null} `null` si aucun jeton n'est enregistré pour ce compte
 */
function getSecret(id) {
  assertId(id);
  return open().get(id) ?? null;
}

/**
 * Supprime le `refresh_token` d'un compte (déconnexion, suppression du compte local).
 * @param {string} id
 * @returns {boolean} `true` si un jeton a effectivement été retiré
 */
function deleteSecret(id) {
  assertId(id);
  if (!open().delete(id)) return false;
  persist();
  return true;
}

/** Vide entièrement le coffre et efface le fichier. */
function clear() {
  secrets = new Map();
  fs.rmSync(paths.vaultFile, { force: true });
}

/**
 * Les jetons survivront-ils à la fermeture du launcher ?
 *
 * Faux quand aucun trousseau système n'est disponible : le coffre fonctionne alors en mémoire
 * seulement et `accounts.js` prévient le joueur qu'une reconnexion sera nécessaire.
 * @returns {boolean}
 */
function isPersistent() {
  return safeStorageAvailable();
}

module.exports = { setSecret, getSecret, deleteSecret, clear, isPersistent };
