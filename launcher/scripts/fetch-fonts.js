#!/usr/bin/env node
'use strict';

/**
 * OPM Launcher — récupération des polices.
 *
 * Usage :
 *   node scripts/fetch-fonts.js            télécharge ce qui manque
 *   node scripts/fetch-fonts.js --force    retélécharge tout
 *
 * ── Pourquoi embarquer les polices ────────────────────────────────────────────
 *
 * `src/launcher.html` déclare `default-src 'self'` : la CSP interdit tout appel
 * réseau du renderer, polices comprises. Un `@import` vers fonts.googleapis.com
 * serait donc bloqué — et, même sans CSP, il ferait dépendre l'apparence du
 * launcher d'une connexion Internet et enverrait l'adresse IP de chaque joueur à
 * Google à chaque démarrage. Les fichiers sont donc téléchargés une fois, ici, et
 * versionnés avec le projet. Le launcher s'affiche identiquement hors ligne.
 *
 * Ce script n'est utile qu'au développeur qui prépare le dépôt ; il n'est jamais
 * exécuté sur la machine d'un joueur.
 *
 * ── Le détail qui fait tout : le User-Agent ───────────────────────────────────
 *
 * `src/assets/css/base/fonts.css` déclare **un seul fichier WOFF2 par graisse**,
 * qui doit couvrir latin *et* latin-ext (« Œ », « Ÿ », « — », les accents rares).
 *
 * Or l'API `css2` de Google adapte sa réponse au navigateur qui la demande :
 *
 *   - à un navigateur récent, elle renvoie **plusieurs** `@font-face` par graisse,
 *     un par sous-ensemble (latin, latin-ext, vietnamese…), départagés par
 *     `unicode-range`. Chaque fichier ne contient que sa tranche : celui de
 *     « latin-ext » n'a même pas les lettres ASCII. Impossible d'en garder un seul.
 *
 *   - à un navigateur qui comprend le WOFF2 mais pas encore `unicode-range`, elle
 *     renvoie **un seul** `@font-face` par graisse, contenant tous les
 *     sous-ensembles fusionnés. C'est exactement ce dont fonts.css a besoin.
 *
 * Firefox 39 est dans cette fenêtre : WOFF2 depuis la version 39, `unicode-range`
 * seulement depuis la 44. On se présente donc comme lui. Ce n'est pas une ruse
 * douteuse mais la méthode qu'emploient tous les outils du genre — le fichier
 * obtenu est le même que celui servi aux navigateurs de l'époque, en un peu plus
 * complet.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/* ------------------------------------------------------------------ constantes */

const ROOT = path.resolve(__dirname, '..');
const FONTS_DIR = path.join(ROOT, 'src', 'assets', 'fonts');

/**
 * User-Agent choisi pour obtenir un WOFF2 par graisse, tous sous-ensembles fusionnés.
 * Voir l'explication en tête de fichier — ne pas « moderniser » sans relire fonts.css.
 */
const UA_WOFF2_MERGED = 'Mozilla/5.0 (Windows NT 6.3; rv:39.0) Gecko/20100101 Firefox/39.0';

/** Délai maximal d'une requête. */
const TIMEOUT_MS = 30_000;

/**
 * Les deux familles du launcher, et le nom de fichier exact attendu par
 * `src/assets/css/base/fonts.css` pour chaque graisse. Ces noms sont un contrat :
 * les modifier ici sans modifier fonts.css casse silencieusement la typographie.
 *
 * @type {{family: string, query: string, weights: Record<number, string>}[]}
 */
const FAMILIES = [
  {
    family: 'Anton',
    query: 'Anton',
    weights: {
      400: 'Anton-Regular.woff2',
    },
  },
  {
    family: 'Space Grotesk',
    query: 'Space+Grotesk:wght@400;500;600;700',
    weights: {
      400: 'SpaceGrotesk-Regular.woff2',
      500: 'SpaceGrotesk-Medium.woff2',
      600: 'SpaceGrotesk-SemiBold.woff2',
      700: 'SpaceGrotesk-Bold.woff2',
    },
  },
];

/* ------------------------------------------------------------------ console */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const say = (msg) => console.log(msg);
const step = (msg) => console.log(`${C.cyan}▸${C.reset} ${msg}`);
const detail = (msg) => console.log(`  ${C.dim}${msg}${C.reset}`);
const ok = (msg) => console.log(`${C.green}✓${C.reset} ${msg}`);
const warn = (msg) => console.log(`${C.yellow}!${C.reset} ${msg}`);

/* ------------------------------------------------------------------ réseau */

/**
 * Requête HTTP avec délai maximal, sur le `fetch` natif de Node 18+.
 *
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<Response>}
 */
async function request(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} sur ${url}`);
    }
    return response;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`Aucune réponse en ${TIMEOUT_MS / 1000} s : ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ analyse CSS */

/**
 * Extrait les blocs `@font-face` d'une feuille Google Fonts.
 *
 * @param {string} css
 * @returns {{weight: number, style: string, url: string, unicodeRange: string|null}[]}
 */
function parseFontFaces(css) {
  /** @type {{weight: number, style: string, url: string, unicodeRange: string|null}[]} */
  const faces = [];

  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const block = match[1];

    const weight = /font-weight:\s*(\d+)/.exec(block);
    const style = /font-style:\s*([a-z]+)/.exec(block);
    const url = /url\((https:\/\/[^)]+\.woff2)\)/.exec(block);
    const range = /unicode-range:\s*([^;]+);/.exec(block);

    if (!url) continue;

    faces.push({
      weight: weight ? Number(weight[1]) : 400,
      style: style ? style[1] : 'normal',
      url: url[1],
      unicodeRange: range ? range[1].trim() : null,
    });
  }

  return faces;
}

/**
 * Choisit, parmi les blocs d'une même graisse, celui à télécharger.
 *
 * Dans le cas nominal il n'y en a qu'un, tous sous-ensembles fusionnés. Si Google
 * a malgré tout découpé la réponse — changement de politique de leur côté — on
 * garde le bloc sans `unicode-range`, sinon celui qui couvre l'ASCII de base, et
 * on le dit clairement : la typographie restera lisible mais quelques caractères
 * accentués rares retomberont sur la police de repli déclarée dans fonts.css.
 *
 * @param {{weight: number, style: string, url: string, unicodeRange: string|null}[]} faces
 * @param {number} weight
 * @returns {{url: string, split: boolean}|null}
 */
function pickFace(faces, weight) {
  const candidates = faces.filter((face) => face.weight === weight && face.style === 'normal');
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { url: candidates[0].url, split: false };

  const merged = candidates.find((face) => face.unicodeRange === null);
  if (merged) return { url: merged.url, split: false };

  // Repli : le sous-ensemble qui contient U+0041 (« A »), donc le latin de base.
  const latin = candidates.find((face) => /U\+0000-00FF|U\+0-7F|U\+0020/i.test(face.unicodeRange || ''));
  return { url: (latin || candidates[0]).url, split: true };
}

/* ------------------------------------------------------------------ écriture */

/**
 * Vérifie qu'un tampon est bien un WOFF2 : les quatre premiers octets valent `wOF2`.
 * Sans ce contrôle, une page d'erreur HTML finirait écrite sous un nom en `.woff2`
 * et la police échouerait silencieusement à l'exécution.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isWoff2(buffer) {
  return buffer.length > 4 && buffer.subarray(0, 4).toString('latin1') === 'wOF2';
}

/** Formate une taille en octets. */
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  return `${(bytes / 1024).toFixed(1)} Kio`;
}

/* ------------------------------------------------------------------ programme */

async function main() {
  const force = process.argv.includes('--force');

  say('');
  say(`${C.bold}OPM Launcher${C.reset} — polices`);
  say(`${C.dim}${'─'.repeat(64)}${C.reset}`);

  await fsp.mkdir(FONTS_DIR, { recursive: true });

  let downloaded = 0;
  let kept = 0;
  let splitWarnings = 0;

  for (const family of FAMILIES) {
    const wanted = Object.entries(family.weights).map(([weight, file]) => ({
      weight: Number(weight),
      file,
      target: path.join(FONTS_DIR, file),
    }));

    // Idempotence : si tous les fichiers de la famille sont déjà là, on ne touche
    // même pas au réseau. `npm run fonts` peut être relancé sans conséquence.
    const missing = wanted.filter((entry) => force || !fs.existsSync(entry.target) || fs.statSync(entry.target).size === 0);
    if (missing.length === 0) {
      kept += wanted.length;
      ok(`${family.family} — ${wanted.length} fichier(s) déjà présent(s), rien à faire.`);
      continue;
    }

    step(`${family.family} — ${missing.length} graisse(s) à récupérer…`);

    const cssUrl = `https://fonts.googleapis.com/css2?family=${family.query}&display=swap`;
    const css = await (await request(cssUrl, { 'User-Agent': UA_WOFF2_MERGED })).text();
    const faces = parseFontFaces(css);

    if (faces.length === 0) {
      throw new Error(
        `Aucun @font-face lisible dans la réponse de Google pour ${family.family}. ` +
          "L'API a peut-être changé de format ; vérifiez l'URL et le User-Agent."
      );
    }

    for (const entry of missing) {
      const picked = pickFace(faces, entry.weight);
      if (!picked) {
        throw new Error(
          `Graisse ${entry.weight} absente de la réponse pour ${family.family}. ` +
            'Vérifiez que la famille propose bien cette graisse sur fonts.google.com.'
        );
      }

      if (picked.split) {
        splitWarnings += 1;
        warn(`${family.family} ${entry.weight} : Google a renvoyé des sous-ensembles séparés.`);
        detail('Le fichier retenu couvre le latin de base ; quelques caractères latin-ext');
        detail('retomberont sur la police de repli. Voir l\'explication en tête de ce script.');
      }

      const buffer = Buffer.from(await (await request(picked.url, { 'User-Agent': UA_WOFF2_MERGED })).arrayBuffer());

      if (!isWoff2(buffer)) {
        throw new Error(
          `Le fichier reçu pour ${family.family} ${entry.weight} n'est pas un WOFF2 ` +
            `(${buffer.length} octets). Rien n'a été écrit.`
        );
      }

      await fsp.writeFile(entry.target, buffer);
      downloaded += 1;
      ok(`${entry.file} ${C.dim}(${humanSize(buffer.length)})${C.reset}`);
    }
  }

  say('');
  say(`${C.dim}${'─'.repeat(64)}${C.reset}`);
  ok(`${downloaded} police(s) téléchargée(s), ${kept} déjà en place.`);
  detail(`Destination : ${path.relative(ROOT, FONTS_DIR)}/`);
  detail('Ces fichiers sont à versionner : le launcher doit fonctionner hors ligne.');
  if (splitWarnings > 0) {
    warn(`${splitWarnings} graisse(s) incomplète(s) — relisez les avertissements ci-dessus.`);
  }
  say('');
}

main().catch((error) => {
  say('');
  console.error(`${C.red}✗${C.reset} Récupération des polices impossible.`);
  console.error(error instanceof Error ? error.message : error);
  console.error(
    `${C.dim}Le launcher démarre malgré tout : base/fonts.css déclare des replis à métriques\n` +
      `corrigées (Impact, Segoe UI…) qui évitent tout décalage de mise en page.${C.reset}`
  );
  process.exitCode = 1;
});
