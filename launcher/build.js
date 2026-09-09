#!/usr/bin/env node
'use strict';

/**
 * OPM Launcher — compilation.
 *
 * Usage :
 *   node build.js                          compile pour la plateforme courante, sans obfuscation
 *   node build.js --build=win|mac|linux    force une cible (compilation croisée limitée, voir README)
 *   node build.js --obf=true               active l'obfuscation (déconseillé, voir docs/BUILD.md § 3.1)
 *   node build.js --publish=always         publie la release GitHub (exige GH_TOKEN)
 *   node build.js --dir                     paquet non installable, pour un essai rapide
 *
 * Ce que ce script corrige par rapport à `OldLauncher/build.js` :
 *
 *  1. **L'obfuscation est désactivée par défaut.** C'est la première cause de faux positifs
 *     antivirus (docs/BUILD.md § 3.1) et elle ne protège rien : `npx asar extract` ouvre le
 *     paquet en une commande. `npm run build:obf` reste disponible, avec un avertissement.
 *
 *  2. **La préparation est séquentielle et attendue.** L'ancien script lançait des callbacks
 *     `async` dans un `forEach`, qui ne les attend pas : electron-builder pouvait démarrer
 *     avant la fin de la copie et empaqueter une arborescence incomplète. Ici chaque fichier
 *     est traité l'un après l'autre, et la compilation ne commence qu'après le dernier.
 *
 *  3. **`preload.js` n'est jamais obfusqué.** C'est la seule passerelle entre le renderer et
 *     le processus principal : elle doit rester lisible et auditable, y compris par un joueur
 *     méfiant qui ouvrirait l'archive.
 *
 *  4. **La signature est facultative.** Si les variables d'environnement de certificat sont
 *     absentes, la compilation réussit quand même et produit des binaires non signés, avec
 *     un avertissement clair. On peut donc mettre la chaîne en place avant d'acheter les
 *     certificats.
 *
 * L'arborescence `src/` est préservée telle quelle dans le paquet : `src/main/services/paths.js`
 * calcule `panelsDir` comme `<appPath>/src/panels`. Renommer le dossier casserait les panneaux.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ constantes */

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'src');
/** Copie de travail : c'est elle qui est empaquetée, jamais `src/` directement. */
const STAGE_DIR = path.join(ROOT, '.stage');
const STAGE_SRC = path.join(STAGE_DIR, 'src');
const OUT_DIR = path.join(ROOT, 'dist');

const pkg = require('./package.json');

/**
 * Extensions copiées telles quelles. Tout ce qui n'est ni du `.js` ni listé ici est
 * ignoré — c'est volontaire : le paquet ne doit contenir que ce que le launcher lit.
 */
const COPIED_EXTENSIONS = new Set([
  '.html', '.css',
  '.woff2', '.woff', '.ttf', '.otf',
  '.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.icns',
  '.mp4', '.webm', '.mp3', '.ogg',
  '.json', '.plist', '.txt', '.md',
]);

/**
 * Fichiers que l'obfuscation ne doit jamais toucher, chemins relatifs à `src/`.
 * `preload.js` est la surface de sécurité du launcher : elle reste auditable.
 * Ajouter une entrée ici suffit à exclure un autre fichier.
 */
const NEVER_OBFUSCATE = new Set([
  'preload.js',
]);

/** Options de `javascript-obfuscator`, chargées seulement si `--obf=true`. */
const OBFUSCATOR_OPTIONS = {
  optionsPreset: 'medium-obfuscation',
  // On garde les `console.*` : sans eux, le journal du launcher devient muet.
  disableConsoleOutput: false,
  // Les protections anti-débogage sont exactement ce que les heuristiques antivirus détectent.
  debugProtection: false,
  selfDefending: false,
};

/** Binaires natifs sortis de l'archive `asar` : ils doivent exister sur le disque pour être chargés. */
const ASAR_UNPACK = [
  '**/*.node',
  '**/*.dll',
  '**/*.dylib',
  '**/*.so',
  '**/*.so.*',
  '**/*.exe',
  // La vidéo de fond est lue en flux par <video> : la sortir de l'asar évite les
  // sautes de lecture liées aux requêtes de plage sur une archive.
  'src/assets/videos/**',
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
const fail = (msg) => console.error(`${C.red}✗${C.reset} ${msg}`);

/* ------------------------------------------------------------------ arguments */

/**
 * Lit les arguments de la ligne de commande.
 * @returns {{obfuscate: boolean, target: string, publish: string, dirOnly: boolean}}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  /** @type {Record<string, string>} */
  const flags = {};
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    flags[key] = value === undefined ? 'true' : value;
  }

  const bool = (value, fallback) => {
    if (value === undefined) return fallback;
    return value === 'true' || value === '1' || value === 'yes';
  };

  const requested = (flags.build || 'platform').toLowerCase();
  const target = requested === 'platform' ? currentPlatform() : requested;

  const validTargets = new Set(['win', 'mac', 'linux', 'all']);
  if (!validTargets.has(target)) {
    throw new Error(`Cible inconnue : « ${requested} ». Attendu : platform, win, mac, linux ou all.`);
  }

  const publish = (flags.publish || 'never').toLowerCase();
  const validPublish = new Set(['never', 'onTag', 'ontag', 'always']);
  if (!validPublish.has(publish)) {
    throw new Error(`Valeur de --publish inconnue : « ${publish} ». Attendu : never, onTag ou always.`);
  }

  return {
    obfuscate: bool(flags.obf, false),
    target,
    publish: publish === 'ontag' ? 'onTag' : publish,
    dirOnly: bool(flags.dir, false),
  };
}

/** Nom court de la plateforme sur laquelle tourne ce script. */
function currentPlatform() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

/* ------------------------------------------------------------------ préparation */

/**
 * Liste récursivement les fichiers d'un dossier, chemins relatifs, triés.
 * Le tri rend le paquet reproductible d'une machine à l'autre.
 *
 * @param {string} dir   dossier racine
 * @param {string} [base] préfixe relatif (usage interne)
 * @returns {Promise<string[]>}
 */
async function listFiles(dir, base = '') {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    // Les dossiers de travail et les fichiers cachés n'ont rien à faire dans le paquet.
    if (entry.name.startsWith('.')) continue;
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(dir, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

/**
 * Recopie `src/` dans `.stage/src/`, en obfusquant le JavaScript si demandé.
 *
 * Séquentiel et intégralement attendu : c'est le correctif principal de l'ancien script.
 *
 * @param {boolean} obfuscate
 * @returns {Promise<{copied: number, obfuscated: number, skipped: string[], bytes: number}>}
 */
async function stage(obfuscate) {
  // Repartir d'une copie vide : un fichier supprimé de `src/` doit disparaître du paquet.
  await fsp.rm(STAGE_DIR, { recursive: true, force: true });
  await fsp.mkdir(STAGE_SRC, { recursive: true });

  let obfuscator = null;
  if (obfuscate) {
    try {
      obfuscator = require('javascript-obfuscator');
    } catch {
      throw new Error(
        "`javascript-obfuscator` est introuvable. Installez-le (`npm i -D javascript-obfuscator`) " +
          'ou compilez sans obfuscation, ce qui est le mode recommandé.'
      );
    }
  }

  const files = await listFiles(SRC_DIR);
  /** @type {string[]} */
  const skipped = [];
  let copied = 0;
  let obfuscated = 0;
  let bytes = 0;

  for (const relative of files) {
    const from = path.join(SRC_DIR, relative);
    const to = path.join(STAGE_SRC, relative);
    const extension = path.extname(relative).toLowerCase();

    await fsp.mkdir(path.dirname(to), { recursive: true });

    if (extension === '.js' || extension === '.mjs') {
      const code = await fsp.readFile(from, 'utf8');
      const protectable = obfuscate && !NEVER_OBFUSCATE.has(relative.replace(/\\/g, '/'));

      if (protectable) {
        const result = obfuscator.obfuscate(code, OBFUSCATOR_OPTIONS);
        await fsp.writeFile(to, result.getObfuscatedCode(), 'utf8');
        obfuscated += 1;
      } else {
        await fsp.writeFile(to, code, 'utf8');
        copied += 1;
      }
      bytes += (await fsp.stat(to)).size;
      continue;
    }

    if (!COPIED_EXTENSIONS.has(extension)) {
      skipped.push(relative);
      continue;
    }

    await fsp.copyFile(from, to);
    bytes += (await fsp.stat(to)).size;
    copied += 1;
  }

  return { copied, obfuscated, skipped, bytes };
}

/* ------------------------------------------------------------------ signature */

/**
 * Établit ce qui peut être signé avec les variables d'environnement présentes.
 *
 * Aucune absence n'est fatale : sans certificat, electron-builder produit des binaires
 * non signés. On le lui dit explicitement pour qu'il ne parte pas chercher un certificat
 * dans le trousseau de la machine et n'échoue pas sur un `codesign` introuvable.
 *
 * @returns {{windows: boolean, macSign: boolean, macNotarize: boolean, notes: string[]}}
 */
function signingPlan() {
  const env = process.env;
  const has = (name) => typeof env[name] === 'string' && env[name].trim() !== '';

  // Windows : certificat classique (.pfx / token via CSC_LINK) ou Azure Trusted Signing.
  const windowsCertificate = has('WIN_CSC_LINK') || has('CSC_LINK');
  const azureTrustedSigning = has('AZURE_TENANT_ID') && has('AZURE_CLIENT_ID') && has('AZURE_CLIENT_SECRET');
  const windows = windowsCertificate || azureTrustedSigning;

  // macOS : certificat « Developer ID Application ».
  const macSign = has('CSC_LINK') || has('CSC_NAME');

  // Notarisation : les trois variables Apple, ou rien.
  const macNotarize = macSign && has('APPLE_ID') && has('APPLE_APP_SPECIFIC_PASSWORD') && has('APPLE_TEAM_ID');

  /** @type {string[]} */
  const notes = [];

  if (windows) {
    notes.push(
      azureTrustedSigning
        ? 'Windows : signature via Azure Trusted Signing.'
        : 'Windows : signature via certificat (CSC_LINK).'
    );
  } else {
    notes.push('Windows : AUCUN certificat — l\'installeur sera non signé (SmartScreen affichera un avertissement).');
  }

  if (macSign) {
    notes.push('macOS : signature « Developer ID Application » activée.');
    notes.push(
      macNotarize
        ? 'macOS : notarisation activée (comptez 5 à 20 minutes).'
        : 'macOS : notarisation DÉSACTIVÉE — APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD et APPLE_TEAM_ID sont requises.'
    );
  } else {
    notes.push('macOS : AUCUN certificat — l\'application sera non signée et Gatekeeper la refusera.');
    // Sans cette variable, electron-builder fouille le trousseau et peut échouer.
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  }

  return { windows, macSign, macNotarize, notes };
}

/* ------------------------------------------------------------------ configuration */

/**
 * Configuration electron-builder.
 *
 * @param {{macSign: boolean, macNotarize: boolean}} signing
 * @returns {object}
 */
function builderConfig(signing) {
  const year = new Date().getFullYear();
  const dmgBackground = path.join(SRC_DIR, 'assets', 'images', 'dmg-background.png');
  const hasDmgBackground = fs.existsSync(dmgBackground);

  /**
   * Les motifs d'electron-builder sont des globs : ils veulent des barres obliques,
   * y compris sous Windows où `path.relative` rend des antislashs.
   * @param {string} target
   */
  const relative = (target) => path.relative(ROOT, target).split(path.sep).join('/');

  return {
    // Doit rester identique à APP_USER_MODEL_ID de src/app.js : c'est lui qui regroupe
    // la fenêtre dans la barre des tâches Windows et rattache les notifications.
    appId: 'fr.onepieceminecraft.launcher',
    productName: pkg.productName,
    copyright: `Copyright © ${year} One Piece Minecraft`,
    artifactName: 'OPMLauncher-${os}-${arch}.${ext}',

    directories: {
      output: relative(OUT_DIR),
      // Dossier de ressources d'installeur ; il n'a pas à exister.
      buildResources: 'build-resources',
    },

    // On empaquette la copie de travail, pas `src/` : le dossier reste nommé `src`
    // à l'intérieur de l'archive, car paths.js résout `<appPath>/src/panels`.
    files: [
      { from: relative(STAGE_SRC), to: 'src', filter: ['**/*'] },
      'package.json',
      'LICENSE*',
    ],
    // `main` est déjà `src/app.js` ; on le réaffirme pour que le paquet soit lisible seul.
    extraMetadata: { main: 'src/app.js' },

    asar: true,
    asarUnpack: ASAR_UNPACK,
    compression: 'maximum',

    // Les fichiers latest*.yml sont produits dès qu'une cible de publication existe :
    // sans eux, electron-updater n'a aucun moyen de savoir qu'une version est sortie.
    // La release est créée en BROUILLON : les trois machines de
    // .github/workflows/release.yml publient chacune leurs binaires dedans, et
    // c'est vous qui la rendez publique une fois les trois arrivées. Avec
    // `releaseType: 'release'`, la première machine terminée publierait une
    // version amputée des deux autres, et electron-updater servirait un
    // `latest-mac.yml` pointant sur un fichier absent.
    generateUpdatesFilesForAllChannels: false,
    publish: [{ provider: 'github', releaseType: 'draft' }],

    win: {
      icon: path.join(SRC_DIR, 'assets', 'images', 'icon.ico'),
      target: [{ target: 'nsis', arch: ['x64'] }],
      // Aucun packer (UPX, Themida…) : docs/BUILD.md § 3.2. Ils produisent exactement
      // le même effet que l'obfuscation sur les heuristiques antivirus, en pire.
      // Horodatage RFC 3161 : sans lui, la signature expire avec le certificat et
      // les binaires déjà distribués deviennent « non signés » du jour au lendemain.
      // Ignoré silencieusement s'il n'y a pas de certificat.
      rfc3161TimeStampServer: 'http://timestamp.digicert.com',
    },

    nsis: {
      // docs/BUILD.md § 3.2 : un installeur silencieux qui lance un programme à la fin
      // est un motif de détection classique. On assume le clic supplémentaire.
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: pkg.productName,
      runAfterFinish: false,
      // Les données du joueur (comptes, jeu téléchargé) survivent à une désinstallation.
      deleteAppDataOnUninstall: false,
      installerIcon: path.join(SRC_DIR, 'assets', 'images', 'icon.ico'),
      uninstallerIcon: path.join(SRC_DIR, 'assets', 'images', 'icon.ico'),
      installerHeaderIcon: path.join(SRC_DIR, 'assets', 'images', 'icon.ico'),
      warningsAsErrors: false,
    },

    mac: {
      icon: path.join(SRC_DIR, 'assets', 'images', 'icon.icns'),
      category: 'public.app-category.games',
      target: [
        { target: 'dmg', arch: ['universal'] },
        // Le .zip n'est pas décoratif : electron-updater ne sait mettre à jour macOS
        // qu'à partir d'une archive zip.
        { target: 'zip', arch: ['universal'] },
      ],
      // Exigé par la notarisation. Les entitlements qui suivent sont ceux dont
      // Electron a besoin pour que V8 puisse compiler à la volée.
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: path.join(ROOT, 'entitlements.mac.plist'),
      entitlementsInherit: path.join(ROOT, 'entitlements.mac.plist'),
      // Sans certificat, `identity: null` demande explicitement une application non
      // signée : sans cette valeur, electron-builder fouille le trousseau et échoue.
      // Avec certificat, la clé est absente pour le laisser choisir seul.
      ...(signing.macSign ? {} : { identity: null }),
      notarize: signing.macNotarize,
    },

    dmg: {
      // Première image que voit un joueur Mac : la fenêtre de montage.
      iconSize: 100,
      ...(hasDmgBackground ? { background: dmgBackground } : { backgroundColor: '#050D0C' }),
      contents: [
        { x: 140, y: 200, type: 'file' },
        { x: 400, y: 200, type: 'link', path: '/Applications' },
      ],
    },

    linux: {
      icon: path.join(SRC_DIR, 'assets', 'images', 'icon.png'),
      target: [{ target: 'AppImage', arch: ['x64'] }],
      category: 'Game',
      synopsis: 'Launcher officiel de One Piece Minecraft',
      description: pkg.description,
      // Entrées du fichier .desktop, à plat (format d'electron-builder 25).
      // `StartupWMClass` rattache la fenêtre à son icône dans le dock GNOME ;
      // sans lui, l'AppImage apparaît sous une icône générique.
      desktop: {
        Name: pkg.productName,
        Comment: 'Launcher officiel de One Piece Minecraft',
        Categories: 'Game;',
        StartupWMClass: 'opm-launcher',
      },
    },
  };
}

/* ------------------------------------------------------------------ empreintes */

/**
 * Écrit `dist/SHA256SUMS` — docs/BUILD.md § 3.2 et § 4.3 : les empreintes sont publiées
 * à côté des binaires pour que les joueurs puissent vérifier leur téléchargement.
 *
 * @param {string[]} artifacts chemins absolus produits par electron-builder
 * @returns {Promise<string|null>} chemin du fichier écrit, ou `null` si rien à signer
 */
async function writeChecksums(artifacts) {
  const packages = artifacts.filter((file) => {
    const extension = path.extname(file).toLowerCase();
    // Seulement ce qu'un joueur télécharge : les .blockmap et les latest*.yml sont
    // des rouages internes d'electron-updater, personne ne vérifie leur empreinte.
    return ['.exe', '.dmg', '.zip', '.appimage'].includes(extension);
  });
  if (packages.length === 0) return null;

  /** @type {string[]} */
  const lines = [];
  for (const file of packages.sort()) {
    const hash = crypto.createHash('sha256');
    hash.update(await fsp.readFile(file));
    lines.push(`${hash.digest('hex')}  ${path.basename(file)}`);
  }

  const target = path.join(OUT_DIR, 'SHA256SUMS');
  await fsp.writeFile(target, `${lines.join('\n')}\n`, 'utf8');
  return target;
}

/** Formate une taille en octets pour la console. */
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Kio`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mio`;
}

/* ------------------------------------------------------------------ programme */

async function main() {
  const options = parseArgs();

  say('');
  say(`${C.bold}OPM Launcher${C.reset} ${pkg.version} — compilation`);
  say(`${C.dim}${'─'.repeat(64)}${C.reset}`);

  /* --- 1. Vérifications préalables ------------------------------------- */

  if (!fs.existsSync(SRC_DIR)) {
    throw new Error(`Dossier source introuvable : ${SRC_DIR}`);
  }

  const fontsDir = path.join(SRC_DIR, 'assets', 'fonts');
  const fontFiles = fs.existsSync(fontsDir) ? fs.readdirSync(fontsDir).filter((f) => f.endsWith('.woff2')) : [];
  if (fontFiles.length === 0) {
    warn("Aucune police dans src/assets/fonts/ : lancez `npm run fonts` avant de publier.");
    detail('Sans elles, le launcher retombe sur les replis système décrits dans base/fonts.css.');
  }

  for (const icon of ['icon.ico', 'icon.icns', 'icon.png']) {
    if (!fs.existsSync(path.join(SRC_DIR, 'assets', 'images', icon))) {
      warn(`Icône manquante : src/assets/images/${icon} — lancez \`npm run icon\`.`);
    }
  }

  if (options.obfuscate) {
    say('');
    warn(`${C.bold}L'obfuscation est activée.${C.reset}`);
    detail("C'est la première cause de faux positifs antivirus (docs/BUILD.md § 3.1) :");
    detail('du JavaScript obfusqué dans une archive asar dans un installeur NSIS est la');
    detail("signature comportementale d'un dropper. Elle ne protège par ailleurs rien —");
    detail('`npx asar extract` ouvre le paquet en une commande.');
    detail('Attendez-vous à déclarer des faux positifs à chaque version.');
    say('');
  }

  /* --- 2. Préparation de la copie de travail ---------------------------- */

  step(`Préparation de ${path.relative(ROOT, STAGE_SRC)}${options.obfuscate ? ' (avec obfuscation)' : ''}…`);
  const staged = await stage(options.obfuscate);
  ok(
    `${staged.copied} fichiers copiés` +
      (staged.obfuscated ? `, ${staged.obfuscated} obfusqués` : '') +
      ` — ${humanSize(staged.bytes)}`
  );
  if (options.obfuscate) {
    detail(`Laissés en clair : ${[...NEVER_OBFUSCATE].join(', ')} (surface de sécurité auditable).`);
  }
  if (staged.skipped.length > 0) {
    warn(`${staged.skipped.length} fichier(s) ignoré(s), extension non reconnue :`);
    for (const file of staged.skipped.slice(0, 10)) detail(file);
    if (staged.skipped.length > 10) detail(`… et ${staged.skipped.length - 10} autres.`);
    detail('Ajoutez leur extension à COPIED_EXTENSIONS si le launcher en a besoin.');
  }

  /* --- 3. Signature ----------------------------------------------------- */

  say('');
  step('Signature :');
  const signing = signingPlan();
  for (const note of signing.notes) detail(note);
  if (!signing.windows && !signing.macSign) {
    detail('La compilation se poursuit : des binaires non signés restent utilisables pour un essai.');
  }

  /* --- 4. Compilation --------------------------------------------------- */

  const builder = require('electron-builder');
  const { Platform } = builder;

  /** @type {Map<any, any>} */
  let targets;
  const label = { win: 'Windows', mac: 'macOS', linux: 'Linux', all: 'les trois plateformes' }[options.target];

  if (options.dirOnly) {
    // `--dir` : paquet décompressé, sans installeur — utile pour tester en quelques secondes.
    targets = Platform.current().createTarget('dir');
  } else if (options.target === 'win') {
    targets = Platform.WINDOWS.createTarget();
  } else if (options.target === 'mac') {
    targets = Platform.MAC.createTarget();
  } else if (options.target === 'linux') {
    targets = Platform.LINUX.createTarget();
  } else {
    targets = new Map([
      ...Platform.WINDOWS.createTarget(),
      ...Platform.MAC.createTarget(),
      ...Platform.LINUX.createTarget(),
    ]);
  }

  if (options.target === 'mac' && process.platform !== 'darwin') {
    warn('Une cible macOS signée et notarisée exige un vrai macOS (codesign et notarytool sont Apple).');
    detail('Passez par .github/workflows/release.yml — voir docs/BUILD.md § 5.');
  }
  if (options.publish !== 'never' && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    warn('--publish demandé mais GH_TOKEN est absent : la publication échouera.');
  }

  say('');
  step(`Compilation pour ${label}${options.dirOnly ? ' (paquet non installable)' : ''}…`);
  say('');

  const artifacts = await builder.build({
    targets,
    config: builderConfig(signing),
    publish: options.publish,
  });

  /* --- 5. Résumé -------------------------------------------------------- */

  say('');
  say(`${C.dim}${'─'.repeat(64)}${C.reset}`);
  ok(`Compilation terminée — ${artifacts.length} fichier(s) dans ${path.relative(ROOT, OUT_DIR)}/`);
  for (const file of artifacts) {
    let size = '';
    try {
      size = ` ${C.dim}(${humanSize(fs.statSync(file).size)})${C.reset}`;
    } catch {
      /* electron-builder liste parfois des chemins déjà consommés */
    }
    detail(`${path.basename(file)}${size}`);
  }

  const checksums = await writeChecksums(artifacts);
  if (checksums) {
    ok(`Empreintes SHA-256 écrites dans ${path.relative(ROOT, checksums)}`);
    detail('À publier à côté des binaires (docs/BUILD.md § 3.2).');
  }

  const updateFiles = artifacts.filter((f) => path.basename(f).startsWith('latest'));
  if (updateFiles.length === 0 && !options.dirOnly) {
    warn("Aucun fichier latest*.yml produit : electron-updater ne verra pas cette version.");
  }

  if (!signing.windows && !signing.macSign) {
    say('');
    warn('Rappel : ces binaires ne sont PAS signés.');
    detail("Ils s'installent et se lancent, mais SmartScreen avertira sous Windows,");
    detail('Gatekeeper refusera l\'ouverture sous macOS, et electron-updater ne peut pas');
    detail('vérifier la provenance des mises à jour (docs/BUILD.md § 4).');
  }
  say('');
}

main().catch((error) => {
  say('');
  fail('La compilation a échoué.');
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
