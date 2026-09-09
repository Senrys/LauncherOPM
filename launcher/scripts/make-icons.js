#!/usr/bin/env node
'use strict';

/**
 * OPM Launcher — génération des icônes.
 *
 * Usage :
 *   node scripts/make-icons.js
 *   node scripts/make-icons.js --source=chemin/vers/un/autre.png
 *
 * Source unique : `src/assets/images/logo-opm.png`. Trois formats en sortent
 * (docs/BUILD.md § 2) :
 *
 *   icon.ico   16 → 256   Windows : exécutable, installeur, barre des tâches
 *   icon.icns  16 → 1024  macOS   : Dock, Finder, fenêtre de montage du dmg
 *   icon.png   512        Linux   : AppImage, lanceur de bureau
 *
 * `png2icons` compose lui-même toutes les tailles intermédiaires à partir d'une
 * seule image carrée : on lui donne le plus grand format utile (1024) et il
 * fabrique la pyramide. Notre travail se limite donc à normaliser la source —
 * carrée, 1024 px, transparence préservée — puis à écrire les trois fichiers.
 *
 * Le script ne échoue jamais sur une source de moins de 1024 px : il agrandit et
 * prévient. Un logo trop petit donne une icône molle sur un Dock Retina, ce qui
 * est fâcheux mais n'empêche pas de compiler.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/* ------------------------------------------------------------------ constantes */

const ROOT = path.resolve(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'src', 'assets', 'images');
const DEFAULT_SOURCE = path.join(IMAGES_DIR, 'logo-opm.png');

/** Côté de l'image maîtresse donnée à png2icons — la plus grande taille réclamée par macOS. */
const MASTER_SIZE = 1024;

/** Côté du PNG Linux. */
const LINUX_SIZE = 512;

/** En dessous de ce côté, la source est agrandie : on prévient. */
const RETINA_THRESHOLD = 1024;

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

/* ------------------------------------------------------------------ jimp */

/**
 * Charge jimp en s'accommodant des deux API en circulation.
 *
 * jimp 0.x exporte directement la classe (`require('jimp')`), jimp 1.x l'exporte
 * sous forme nommée et a changé la signature de `resize` et l'export de tampon.
 * Le `package.json` épingle la 0.22, mais un `npm update` distrait suffirait à
 * casser ce script : autant l'écrire une fois pour les deux.
 *
 * @returns {Promise<{read: (file: string) => Promise<{width: number, height: number, toPng: (size: number) => Promise<Buffer>}>}>}
 */
async function loadJimp() {
  let module;
  try {
    module = require('jimp');
  } catch {
    throw new Error("`jimp` est introuvable. Lancez `npm install` à la racine de launcher/.");
  }

  const Jimp = module && typeof module.read === 'function' ? module : module.Jimp;
  if (!Jimp || typeof Jimp.read !== 'function') {
    throw new Error("La version de `jimp` installée n'expose pas `Jimp.read` : version inattendue.");
  }

  /** API 1.x reconnaissable à la présence de `getBuffer` sans `getBufferAsync`. */
  const legacy = typeof module.MIME_PNG === 'string';

  return {
    async read(file) {
      const image = await Jimp.read(file);
      const width = image.bitmap.width;
      const height = image.bitmap.height;

      return {
        width,
        height,
        async toPng(size) {
          // On repart de l'original à chaque appel : redimensionner en cascade
          // (1024 → 512) dégrade davantage qu'un seul passage depuis la source.
          const copy = await Jimp.read(file);
          if (legacy) {
            copy.resize(size, size);
            return copy.getBufferAsync(module.MIME_PNG);
          }
          copy.resize({ w: size, h: size });
          return copy.getBuffer('image/png');
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ programme */

/** Lit `--source=…` s'il est fourni. */
function sourceFromArgs() {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--source=')) {
      const value = arg.slice('--source='.length);
      return path.isAbsolute(value) ? value : path.join(ROOT, value);
    }
  }
  return DEFAULT_SOURCE;
}

/** Formate une taille en octets. */
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  return `${(bytes / 1024).toFixed(1)} Kio`;
}

async function main() {
  const source = sourceFromArgs();

  say('');
  say(`${C.bold}OPM Launcher${C.reset} — icônes`);
  say(`${C.dim}${'─'.repeat(64)}${C.reset}`);

  if (!fs.existsSync(source)) {
    throw new Error(
      `Image source introuvable : ${source}\n` +
        'Attendu : un PNG carré avec transparence, 1024 × 1024 de préférence.'
    );
  }

  let png2icons;
  try {
    png2icons = require('png2icons');
  } catch {
    throw new Error("`png2icons` est introuvable. Lancez `npm install` à la racine de launcher/.");
  }

  const jimp = await loadJimp();

  step(`Lecture de ${path.relative(ROOT, source)}…`);
  const image = await jimp.read(source);
  detail(`${image.width} × ${image.height} px`);

  /* --- Contrôles de qualité, jamais bloquants -------------------------- */

  if (image.width !== image.height) {
    warn(`L'image n'est pas carrée (${image.width} × ${image.height}).`);
    detail('Elle sera déformée pour tenir dans un carré. Recadrez-la pour un rendu propre.');
  }

  if (Math.min(image.width, image.height) < RETINA_THRESHOLD) {
    warn(`Source inférieure à ${RETINA_THRESHOLD} px : la qualité Retina sera dégradée.`);
    detail(`Les variantes au-delà de ${image.width} px seront obtenues par agrandissement,`);
    detail('donc légèrement molles sur le Dock d\'un Mac récent.');
    detail('Si le logo existe en vectoriel (.ai, .svg), exportez-le une fois en');
    detail('1024 × 1024 PNG et remplacez logo-opm.png : tout se régénère seul.');
  }

  /* --- Image maîtresse -------------------------------------------------- */

  step(`Normalisation en ${MASTER_SIZE} × ${MASTER_SIZE}…`);
  const master = await image.toPng(MASTER_SIZE);

  await fsp.mkdir(IMAGES_DIR, { recursive: true });

  /* --- Windows ---------------------------------------------------------- */

  // png2icons.createICO(input, scalingAlgorithm, numOfColors, usePNG, forWinExe)
  // `usePNG = false` : les petites tailles restent en bitmap non compressé, ce que
  // l'explorateur Windows préfère. HERMITE est le meilleur compromis en réduction.
  step('icon.ico — 16, 24, 32, 48, 64, 128, 256…');
  const ico = png2icons.createICO(master, png2icons.HERMITE, 0, false, true);
  if (!ico) throw new Error("png2icons n'a pas pu produire l'ICO à partir de la source.");
  const icoPath = path.join(IMAGES_DIR, 'icon.ico');
  await fsp.writeFile(icoPath, ico);
  ok(`icon.ico ${C.dim}(${humanSize(ico.length)})${C.reset}`);

  /* --- macOS ------------------------------------------------------------ */

  // BILINEAR conserve mieux les dégradés sur les grandes tailles du Dock.
  step('icon.icns — 16 → 1024…');
  const icns = png2icons.createICNS(master, png2icons.BILINEAR, 0);
  if (!icns) throw new Error("png2icons n'a pas pu produire l'ICNS à partir de la source.");
  const icnsPath = path.join(IMAGES_DIR, 'icon.icns');
  await fsp.writeFile(icnsPath, icns);
  ok(`icon.icns ${C.dim}(${humanSize(icns.length)})${C.reset}`);

  /* --- Linux ------------------------------------------------------------ */

  step(`icon.png — ${LINUX_SIZE} × ${LINUX_SIZE}…`);
  const png = await image.toPng(LINUX_SIZE);
  const pngPath = path.join(IMAGES_DIR, 'icon.png');
  await fsp.writeFile(pngPath, png);
  ok(`icon.png ${C.dim}(${humanSize(png.length)})${C.reset}`);

  /* --- Résumé ----------------------------------------------------------- */

  say('');
  say(`${C.dim}${'─'.repeat(64)}${C.reset}`);
  ok(`Trois icônes écrites dans ${path.relative(ROOT, IMAGES_DIR)}/`);
  detail('Elles sont lues à la fois par src/windows/mainWindow.js (icône de fenêtre)');
  detail('et par build.js (exécutable, installeur, dmg, AppImage).');
  detail('À versionner : la compilation ne les régénère pas.');
  say('');
}

main().catch((error) => {
  say('');
  console.error(`${C.red}✗${C.reset} Génération des icônes impossible.`);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
