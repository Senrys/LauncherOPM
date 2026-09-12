#!/usr/bin/env node
'use strict';

/**
 * Recopie les bibliothèques tierces du renderer dans `src/assets/js/vendor/`.
 *
 * Le renderer n'a pas d'empaqueteur : il charge des modules ES et des scripts
 * classiques directement depuis `src/`. Les bibliothèques qu'il utilise doivent
 * donc être des fichiers de `src/`, pas de `node_modules/` — d'où cette copie,
 * versionnée dans le dépôt pour que la compilation n'en dépende pas.
 *
 * À relancer après une montée de version : `npm run vendor`.
 *
 * Pourquoi ne pas charger depuis un CDN, comme le site : la politique de
 * sécurité du launcher (`script-src 'self'`) l'interdit, et à raison — un
 * launcher qui exécute du code téléchargé au démarrage est un launcher qu'un
 * CDN compromis peut détourner.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'assets', 'js', 'vendor');

/** Bibliothèque → fichier à recopier depuis node_modules. */
const LIBRARIES = [
  {
    name: 'skinview3d',
    from: 'node_modules/skinview3d/bundles/skinview3d.bundle.js',
    to: 'skinview3d.bundle.js',
    // MIT — Kent Rasmussen et contributeurs. Rendu 3D du skin sur l'accueil.
    license: 'node_modules/skinview3d/LICENSE',
  },
];

fs.mkdirSync(OUT, { recursive: true });

for (const lib of LIBRARIES) {
  const source = path.join(ROOT, lib.from);
  if (!fs.existsSync(source)) {
    console.error(`✗ ${lib.name} : introuvable (${lib.from}). Lancez d'abord \`npm install\`.`);
    process.exitCode = 1;
    continue;
  }
  fs.copyFileSync(source, path.join(OUT, lib.to));
  if (lib.license && fs.existsSync(path.join(ROOT, lib.license))) {
    fs.copyFileSync(path.join(ROOT, lib.license), path.join(OUT, `${lib.name}.LICENSE.txt`));
  }
  const size = (fs.statSync(source).size / 1024).toFixed(0);
  console.log(`✓ ${lib.name} → src/assets/js/vendor/${lib.to} (${size} Kio)`);
}
