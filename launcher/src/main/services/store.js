'use strict';

/**
 * Persistance locale non sensible du launcher.
 *
 *   config.json    → `LauncherConfig` (docs/IPC.md § Types)
 *   accounts.json  → comptes connus, SANS AUCUN JETON (ceux-ci vivent dans vault.js)
 *
 * Deux garanties tenues par ce module :
 *
 *  1. **Rien d'inattendu ne rentre.** `config.set(patch)` vient du renderer : le correctif
 *     est fusionné en profondeur puis repassé par `normalizeConfig()`, qui reconstruit
 *     l'objet champ par champ à partir du schéma connu. Les clés inconnues sont éliminées,
 *     les types sont contraints, les bornes sont appliquées.
 *  2. **Rien de sensible ne sort.** `upsertAccount()` reconstruit lui aussi le compte champ
 *     par champ : un `access_token` ou un `refresh_token` passé par erreur est simplement
 *     ignoré et n'atteint jamais le disque.
 *
 * Les écritures sont atomiques (fichier temporaire + renommage) : une coupure ne laisse
 * jamais un `config.json` tronqué. Les opérations sont synchrones — les deux fichiers
 * pèsent quelques kilo-octets et les appelants IPC sont déjà asynchrones.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths');

/* ------------------------------------------------------------------ bornes */

/** Mémoire minimale allouable à la JVM, en Go. Le maximum est la RAM de la machine. */
const RAM_MIN_GB = 1;

/** Résolution du jeu, en pixels (de la VGA au 8K). */
const RESOLUTION_MIN = 640;
const RESOLUTION_MAX = 7680;

const VOLUME_MIN = 0;
const VOLUME_MAX = 100;

/** Téléchargements simultanés passés à minecraft-java-core. */
const DOWNLOAD_MULTI_MIN = 1;
const DOWNLOAD_MULTI_MAX = 20;

/** Version du format d'`accounts.json`. */
const ACCOUNTS_VERSION = 1;

/* ------------------------------------------------------------------ valeurs par défaut */

/**
 * Configuration livrée d'usine — type `LauncherConfig` de docs/IPC.md.
 * Gelée en profondeur : elle sert de référence de repli, jamais de tampon de travail.
 */
const DEFAULT_CONFIG = deepFreeze({
  account_selected: null,
  instance_selected: null,
  java: {
    path: null,
    memory: { min: 2, max: 4 },
    args: '',
  },
  game: {
    width: 1280,
    height: 720,
    fullscreen: false,
    remember_size: true,
  },
  launcher: {
    close_on_launch: true,
    keep_console: false,
    auto_update: true,
    rp_notifications: true,
    music: false,
    volume: 40,
    auto_launch: false,
    download_multi: 5,
  },
});

/* ------------------------------------------------------------------ état interne */

/** @type {object|null} configuration en mémoire, chargée à la première lecture */
let config = null;

/** @type {Array<object>|null} comptes en mémoire, chargés à la première lecture */
let accounts = null;

/* ------------------------------------------------------------------ utilitaires */

/**
 * Journalisation paresseuse : `logger` est chargé à l'appel, ce qui évite tout cycle de
 * `require` entre services. Une panne de journalisation ne doit jamais faire échouer une
 * lecture ou une écriture de configuration.
 * @param {'info'|'warn'|'error'} level
 * @param {string} text
 */
function log(level, text) {
  try {
    require('./logger').log(level, text);
  } catch {
    console[level === 'error' ? 'error' : 'warn'](`[store] ${text}`);
  }
}

/** @returns {boolean} vrai pour un objet littéral (ni tableau, ni null, ni instance) */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (isPlainObject(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

/** Mémoire vive totale de la machine, en Go entiers (borne haute de la RAM allouable). */
function totalMemoryGb() {
  return Math.max(RAM_MIN_GB, Math.floor(os.totalmem() / 1024 ** 3));
}

/** Entier contraint à un intervalle, avec repli si la valeur n'est pas un nombre. */
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function toText(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/** Chaîne non vide, sinon `null`. Les espaces de bordure sont retirés. */
function toTextOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Fusion profonde d'un correctif dans une base. Les objets littéraux sont fusionnés,
 * tout le reste (nombres, chaînes, booléens, tableaux, `null`) remplace la valeur.
 * Les clés `__proto__` et `constructor` sont refusées : le correctif provient du renderer.
 */
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

/**
 * Lecture JSON tolérante : un fichier absent ou abîmé ne doit jamais empêcher le launcher
 * de démarrer. Le contenu fautif sera remplacé à la prochaine écriture.
 * @param {string} file
 * @param {string} label  libellé humain pour le journal
 * @returns {any|null}
 */
function readJson(file, label) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log('error', `Fichier ${label} illisible (${err.message}) — valeurs par défaut rétablies.`);
    return null;
  }
}

/**
 * Écriture atomique : fichier temporaire puis renommage. Une écriture qui échoue est
 * journalisée mais ne remonte pas : perdre un réglage ne doit pas casser une action.
 * @param {string} file
 * @param {any} value
 * @param {string} label
 */
function writeJson(file, value, label) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  } catch (err) {
    log('error', `Écriture du fichier ${label} impossible (${err.message}).`);
  }
}

/* ------------------------------------------------------------------ configuration */

/**
 * Reconstruit une configuration valide à partir de n'importe quelle entrée.
 * Toute clé absente du schéma est écartée ; toute valeur hors bornes est ramenée dedans.
 *
 * @param {any} input
 * @param {'min'|'max'|null} [pinned]  en cas d'incohérence RAM min > max, indique lequel
 *                                     des deux curseurs vient d'être bougé et fait donc foi
 * @returns {object}
 */
function normalizeConfig(input, pinned = null) {
  const source = isPlainObject(input) ? input : {};
  const java = isPlainObject(source.java) ? source.java : {};
  const memory = isPlainObject(java.memory) ? java.memory : {};
  const game = isPlainObject(source.game) ? source.game : {};
  const launcher = isPlainObject(source.launcher) ? source.launcher : {};

  const ramMax = totalMemoryGb();
  let ramMinValue = clampInt(memory.min, RAM_MIN_GB, ramMax, DEFAULT_CONFIG.java.memory.min);
  let ramMaxValue = clampInt(memory.max, RAM_MIN_GB, ramMax, DEFAULT_CONFIG.java.memory.max);
  if (ramMinValue > ramMaxValue) {
    // Le curseur que l'utilisateur vient de déplacer garde sa valeur, l'autre s'y aligne.
    if (pinned === 'min') ramMaxValue = ramMinValue;
    else ramMinValue = ramMaxValue;
  }

  return {
    account_selected: toTextOrNull(source.account_selected),
    instance_selected: toTextOrNull(source.instance_selected),
    java: {
      path: toTextOrNull(java.path),
      memory: { min: ramMinValue, max: ramMaxValue },
      args: toText(java.args, DEFAULT_CONFIG.java.args),
    },
    game: {
      width: clampInt(game.width, RESOLUTION_MIN, RESOLUTION_MAX, DEFAULT_CONFIG.game.width),
      height: clampInt(game.height, RESOLUTION_MIN, RESOLUTION_MAX, DEFAULT_CONFIG.game.height),
      fullscreen: toBool(game.fullscreen, DEFAULT_CONFIG.game.fullscreen),
      remember_size: toBool(game.remember_size, DEFAULT_CONFIG.game.remember_size),
    },
    launcher: {
      close_on_launch: toBool(launcher.close_on_launch, DEFAULT_CONFIG.launcher.close_on_launch),
      keep_console: toBool(launcher.keep_console, DEFAULT_CONFIG.launcher.keep_console),
      auto_update: toBool(launcher.auto_update, DEFAULT_CONFIG.launcher.auto_update),
      rp_notifications: toBool(launcher.rp_notifications, DEFAULT_CONFIG.launcher.rp_notifications),
      music: toBool(launcher.music, DEFAULT_CONFIG.launcher.music),
      volume: clampInt(launcher.volume, VOLUME_MIN, VOLUME_MAX, DEFAULT_CONFIG.launcher.volume),
      auto_launch: toBool(launcher.auto_launch, DEFAULT_CONFIG.launcher.auto_launch),
      download_multi: clampInt(
        launcher.download_multi,
        DOWNLOAD_MULTI_MIN,
        DOWNLOAD_MULTI_MAX,
        DEFAULT_CONFIG.launcher.download_multi
      ),
    },
  };
}

/**
 * Détermine, dans un correctif, lequel des deux curseurs de RAM a été touché.
 * @param {any} patch
 * @returns {'min'|'max'|null}
 */
function pinnedMemoryOf(patch) {
  if (!isPlainObject(patch) || !isPlainObject(patch.java) || !isPlainObject(patch.java.memory)) return null;
  const { min, max } = patch.java.memory;
  if (min !== undefined && max === undefined) return 'min';
  if (max !== undefined && min === undefined) return 'max';
  return null;
}

/** Charge la configuration à la première demande. */
function loadConfig() {
  if (!config) config = normalizeConfig(readJson(paths.configFile, 'de configuration'));
  return config;
}

/**
 * Configuration complète et valide.
 * @returns {object} copie — la modifier n'a aucun effet, passer par `setConfig()`
 */
function getConfig() {
  return structuredClone(loadConfig());
}

/**
 * Applique un correctif partiel (fusion profonde), valide le tout, puis enregistre.
 * @param {object} patch  sous-ensemble arbitrairement profond de `LauncherConfig`
 * @returns {object} la configuration résultante
 */
function setConfig(patch) {
  const merged = deepMerge(loadConfig(), patch);
  config = normalizeConfig(merged, pinnedMemoryOf(patch));
  writeJson(paths.configFile, config, 'de configuration');
  return structuredClone(config);
}

/**
 * Rétablit les réglages d'usine. Le compte et l'instance sélectionnés sont conservés :
 * réinitialiser des préférences ne doit pas déconnecter le joueur ni changer son serveur.
 * @returns {object} la configuration résultante
 */
function resetConfig() {
  const current = loadConfig();
  config = normalizeConfig({
    ...DEFAULT_CONFIG,
    account_selected: current.account_selected,
    instance_selected: current.instance_selected,
  });
  writeJson(paths.configFile, config, 'de configuration');
  return structuredClone(config);
}

/* ------------------------------------------------------------------ comptes */

/**
 * Reconstruit un compte à partir du type `Account` de docs/IPC.md.
 * Tout champ absent du type est écarté — c'est ici que se joue la promesse
 * « `accounts.json` ne contient jamais de jeton ».
 * Le drapeau `primary` n'est pas stocké : il est dérivé du compte sélectionné.
 *
 * @param {any} input
 * @returns {object}
 */
function sanitizeAccount(input) {
  if (!isPlainObject(input)) throw new TypeError('store : objet de compte attendu.');

  const id = toTextOrNull(input.id);
  if (!id) throw new TypeError('store : identifiant de compte manquant.');

  const minecraft = isPlainObject(input.minecraft) ? input.minecraft : null;
  const uuid = minecraft ? toTextOrNull(minecraft.uuid) : null;

  return {
    id,
    email: toText(input.email, ''),
    username: toText(input.username, ''),
    minecraft: uuid ? { uuid, name: toText(minecraft.name, '') } : null,
    skin_url: toTextOrNull(input.skin_url),
    can_play: toBool(input.can_play, false),
    blocked_reason: toTextOrNull(input.blocked_reason),
    session_expires_at: toTextOrNull(input.session_expires_at),
    totp_enabled: toBool(input.totp_enabled, false),
  };
}

/**
 * Ajoute le drapeau `primary`, calculé — garantit qu'un seul compte le porte.
 * @param {object} account
 * @returns {object}
 */
function withPrimary(account) {
  return {
    id: account.id,
    email: account.email,
    username: account.username,
    minecraft: account.minecraft ? { ...account.minecraft } : null,
    skin_url: account.skin_url,
    primary: account.id === loadConfig().account_selected,
    can_play: account.can_play,
    blocked_reason: account.blocked_reason,
    session_expires_at: account.session_expires_at,
    totp_enabled: account.totp_enabled,
  };
}

/** Charge les comptes à la première demande. */
function loadAccounts() {
  if (accounts) return accounts;

  const raw = readJson(paths.accountsFile, 'des comptes');
  const list = isPlainObject(raw) && Array.isArray(raw.accounts) ? raw.accounts : [];

  accounts = [];
  for (const entry of list) {
    try {
      const account = sanitizeAccount(entry);
      // Un identifiant en double serait ingérable côté interface : le premier gagne.
      if (!accounts.some((a) => a.id === account.id)) accounts.push(account);
    } catch {
      log('warn', 'Un compte enregistré était illisible et a été ignoré.');
    }
  }

  return accounts;
}

function persistAccounts() {
  writeJson(paths.accountsFile, { version: ACCOUNTS_VERSION, accounts: loadAccounts() }, 'des comptes');
}

/**
 * Tous les comptes connus localement, dans leur ordre d'ajout.
 * @returns {Array<object>} copies enrichies du drapeau `primary`
 */
function listAccounts() {
  return loadAccounts().map(withPrimary);
}

/**
 * @param {string} id
 * @returns {object|null}
 */
function getAccount(id) {
  const found = loadAccounts().find((a) => a.id === id);
  return found ? withPrimary(found) : null;
}

/**
 * Crée ou met à jour un compte. L'objet reçu peut être partiel : il est fusionné avec le
 * compte existant avant d'être filtré par `sanitizeAccount()`.
 * @param {object} account  au minimum `{ id }`
 * @returns {object} le compte enregistré
 */
function upsertAccount(account) {
  if (!isPlainObject(account)) throw new TypeError('store.upsertAccount : objet de compte attendu.');

  const list = loadAccounts();
  const index = list.findIndex((a) => a.id === toTextOrNull(account.id));
  const merged = index >= 0 ? deepMerge(list[index], account) : account;
  const saved = sanitizeAccount(merged);

  if (index >= 0) list[index] = saved;
  else list.push(saved);

  persistAccounts();
  return withPrimary(saved);
}

/**
 * Retire un compte. S'il était sélectionné, la sélection bascule sur le premier compte
 * restant, ou passe à `null` s'il n'en reste aucun.
 * Le `refresh_token` associé se supprime séparément, via `vault.deleteSecret(id)`.
 * @param {string} id
 */
function removeAccount(id) {
  const list = loadAccounts();
  const index = list.findIndex((a) => a.id === id);
  if (index < 0) return;

  list.splice(index, 1);
  persistAccounts();

  if (loadConfig().account_selected === id) {
    setConfig({ account_selected: list.length > 0 ? list[0].id : null });
  }
}

/**
 * Identifiant du compte actif — c'est `config.account_selected`, seule source de vérité.
 * @returns {string|null}
 */
function getCurrentId() {
  return loadConfig().account_selected;
}

/**
 * Change le compte actif. Le compte doit déjà être enregistré : appeler `upsertAccount()`
 * avant `setCurrentId()` lors d'une première connexion.
 * @param {string|null} id  `null` pour n'avoir aucun compte actif
 */
function setCurrentId(id) {
  const next = toTextOrNull(id);
  if (next && !loadAccounts().some((a) => a.id === next)) {
    throw new Error(`store.setCurrentId : compte inconnu (${next}).`);
  }
  setConfig({ account_selected: next });
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  setConfig,
  resetConfig,
  listAccounts,
  getAccount,
  upsertAccount,
  removeAccount,
  getCurrentId,
  setCurrentId,
};
