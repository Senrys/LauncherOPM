/**
 * Mise en forme des valeurs affichées — tout en français.
 *
 * Conventions typographiques respectées partout :
 *  - séparateur décimal : la virgule ;
 *  - séparateur de milliers : l'espace insécable fine (U+202F) — « 24 812 » ;
 *  - espace insécable (U+00A0) devant les unités et les signes « % » et « € ».
 *
 * Une entrée invalide (null, NaN, date illisible) renvoie toujours une chaîne
 * vide : l'appelant garde alors son squelette de chargement plutôt que
 * d'afficher une fausse valeur.
 */

/** Espace insécable fine — séparateur de milliers. */
const THIN = ' ';
/** Espace insécable — devant les unités, « % » et « € ». */
const NBSP = ' ';

const UNITS_BYTES = ['o', 'Ko', 'Mo', 'Go', 'To'];

/**
 * Convertit une date ISO-8601 en `Date` valide, ou `null`.
 * @param {string|number|Date|null|undefined} value
 * @returns {Date|null}
 */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Nombre au format français, avec espace fine insécable en séparateur de milliers.
 * @param {number} value
 * @param {number} [decimals=0]
 * @returns {string} « 24 812 », « 4,8 »
 */
export function nf(value, decimals = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';

  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
    .format(value)
    // Selon la version d'ICU, le séparateur peut être une espace ordinaire ou
    // insécable : on impose l'espace fine insécable dans tous les cas.
    .replace(/[\s\u00A0\u2009\u202F]/g, THIN);
}

/**
 * Taille de fichier en octets → « 4,8 Go ». Base 1024.
 * @param {number} bytesCount
 * @returns {string}
 */
export function bytes(bytesCount) {
  if (typeof bytesCount !== 'number' || !Number.isFinite(bytesCount) || bytesCount < 0) return '';
  if (bytesCount === 0) return `0${NBSP}o`;

  let value = bytesCount;
  let unit = 0;
  while (value >= 1024 && unit < UNITS_BYTES.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // Les octets restent entiers ; au-delà, une décimale tant qu'on est sous 100.
  const decimals = unit === 0 || value >= 100 ? 0 : 1;
  return `${nf(value, decimals)}${NBSP}${UNITS_BYTES[unit]}`;
}

/**
 * Débit en octets par seconde → « 4,8 Mo/s ».
 * @param {number} bytesPerSecond
 * @returns {string}
 */
export function speed(bytesPerSecond) {
  if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return '';
  }
  return `${bytes(bytesPerSecond)}/s`;
}

/**
 * Durée en secondes → « 45 s », « 12 min 05 s », « 2 h 05 min ».
 * @param {number} seconds
 * @returns {string}
 */
export function duration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';

  const total = Math.round(seconds);
  if (total < 60) return `${total}${NBSP}s`;

  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const rest = total % 60;
    return rest === 0
      ? `${minutes}${NBSP}min`
      : `${minutes}${NBSP}min ${String(rest).padStart(2, '0')}${NBSP}s`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${hours}${NBSP}h`
    : `${hours}${NBSP}h ${String(rest).padStart(2, '0')}${NBSP}min`;
}

/**
 * Compte à rebours jusqu'à une date ISO → « 7 j 04 : 12 : 34 ».
 * Sous la journée, les jours disparaissent : « 04 : 12 : 34 ».
 *
 * @param {string|Date} iso date cible
 * @param {{ past?: string, now?: number }} [options] `past` : texte renvoyé une
 *        fois l'échéance dépassée ; `now` : instant de référence (ms).
 * @returns {string}
 */
export function countdown(iso, { past = 'EN COURS', now = Date.now() } = {}) {
  const target = toDate(iso);
  if (!target) return '';

  const remaining = Math.floor((target.getTime() - now) / 1000);
  if (remaining <= 0) return past;

  const days = Math.floor(remaining / 86400);
  const hours = String(Math.floor((remaining % 86400) / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
  const secs = String(remaining % 60).padStart(2, '0');

  const clock = `${hours}${NBSP}:${NBSP}${minutes}${NBSP}:${NBSP}${secs}`;
  return days > 0 ? `${days}${NBSP}j ${clock}` : clock;
}

/**
 * Montant en centimes → « 142 € », « 12,50 € ».
 * Les centimes ne sont affichés que s'ils ne sont pas nuls.
 *
 * @param {number} cents
 * @returns {string}
 */
export function euros(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return '';

  const value = cents / 100;
  const decimals = Number.isInteger(value) ? 0 : 2;
  return `${nf(value, decimals)}${NBSP}€`;
}

/**
 * Pourcentage → « 71 % ».
 * `pct(0.62)` (ratio) et `pct(142, 200)` (valeur sur total) sont équivalents.
 *
 * @param {number} value
 * @param {number} [total=1]
 * @param {number} [decimals=0]
 * @returns {string}
 */
export function pct(value, total = 1, decimals = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (typeof total !== 'number' || !Number.isFinite(total) || total === 0) return '';

  const ratio = Math.max(0, value / total);
  return `${nf(ratio * 100, decimals)}${NBSP}%`;
}

/**
 * Date courte française → « 09/05 ».
 * @param {string|Date} iso
 * @param {{ withYear?: boolean, withTime?: boolean }} [options]
 * @returns {string}
 */
export function dateFr(iso, { withYear = false, withTime = false } = {}) {
  const date = toDate(iso);
  if (!date) return '';

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');

  let out = `${day}/${month}`;
  if (withYear) out += `/${date.getFullYear()}`;
  if (withTime) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    out += ` à ${hours}${NBSP}h${NBSP}${minutes}`;
  }
  return out;
}

/** Paliers de conversion pour `relTime`, du plus fin au plus grossier. */
const REL_STEPS = [
  { limit: 60, unit: 'second', divisor: 1 },
  { limit: 3600, unit: 'minute', divisor: 60 },
  { limit: 86400, unit: 'hour', divisor: 3600 },
  { limit: 604800, unit: 'day', divisor: 86400 },
  { limit: 2629800, unit: 'week', divisor: 604800 },
  { limit: 31557600, unit: 'month', divisor: 2629800 },
  { limit: Infinity, unit: 'year', divisor: 31557600 },
];

const REL_FORMAT = new Intl.RelativeTimeFormat('fr-FR', { numeric: 'auto' });

/**
 * Date relative parlante → « il y a 3 minutes », « hier », « dans 2 jours ».
 * @param {string|Date} iso
 * @param {{ now?: number }} [options]
 * @returns {string}
 */
export function relTime(iso, { now = Date.now() } = {}) {
  const date = toDate(iso);
  if (!date) return '';

  const deltaSeconds = (date.getTime() - now) / 1000;
  const magnitude = Math.abs(deltaSeconds);

  const step = REL_STEPS.find((candidate) => magnitude < candidate.limit) ?? REL_STEPS[REL_STEPS.length - 1];
  const value = Math.round(deltaSeconds / step.divisor);

  return REL_FORMAT.format(value, step.unit);
}
