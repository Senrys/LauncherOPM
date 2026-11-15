'use strict';

/**
 * Les fichiers que le launcher pose lui-même dans le dossier du jeu, à chaque
 * lancement (src/main/services/bridge.js, `installGameFiles`) :
 *
 *   - le **mod OPM** (`../mod`, compilé ici avec Gradle) : écran de chargement,
 *     écran titre, menus, musique, Xenodys en jeu ;
 *   - **authlib-injector** : le jeu annonce son arrivée à NOTRE serveur
 *     d'authentification et accepte nos skins signés. Version figée, empreinte
 *     vérifiée.
 *
 * Rien à déposer sur le serveur : une mise à jour du launcher met le mod à jour.
 *
 *   node game-files.js          # prépare src/game/ (appelé aussi par build.js)
 *
 * Exige Java 21 pour compiler le mod. `OPM_SKIP_MOD=1` saute la compilation
 * (le launcher fonctionne alors sans le mod : pas de scène de chargement).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const MOD_DIR = path.join(ROOT, '..', 'mod');
const OUT_DIR = path.join(ROOT, 'src', 'game');
const CACHE_DIR = path.join(ROOT, '.cache');

/** authlib-injector : version figée, empreinte publiée par GitHub pour cette version. */
const AUTHLIB = {
  version: '1.2.8',
  url: 'https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.8/authlib-injector-1.2.8.jar',
  sha256: '9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10',
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function buildMod() {
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  execFileSync(gradlew, ['build', '--console=plain', '-q'], {
    cwd: MOD_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const libs = path.join(MOD_DIR, 'build', 'libs');
  const jar = fs.readdirSync(libs).find((f) => /^opm-\d[\w.+-]*\.jar$/.test(f) && !/sources|javadoc/.test(f));
  if (!jar) throw new Error(`aucun opm-<version>.jar dans ${libs}`);
  return path.join(libs, jar);
}

async function authlib() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, `authlib-injector-${AUTHLIB.version}.jar`);
  let data = fs.existsSync(cached) ? await fsp.readFile(cached) : null;
  if (!data || sha256(data) !== AUTHLIB.sha256) {
    const res = await fetch(AUTHLIB.url);
    if (!res.ok) throw new Error(`authlib-injector : HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
    if (sha256(data) !== AUTHLIB.sha256) {
      throw new Error('authlib-injector : empreinte SHA-256 inattendue, fichier refusé');
    }
    await fsp.writeFile(cached, data);
  }
  return data;
}

async function prepareGameFiles({ skipMod = process.env.OPM_SKIP_MOD === '1' } = {}) {
  await fsp.mkdir(OUT_DIR, { recursive: true });
  for (const f of await fsp.readdir(OUT_DIR)) await fsp.rm(path.join(OUT_DIR, f), { force: true });

  const manifest = {};
  if (!skipMod) {
    const jar = buildMod();
    const data = await fsp.readFile(jar);
    const name = path.basename(jar);
    await fsp.writeFile(path.join(OUT_DIR, name), data);
    manifest.mod = { fichier: name, sha256: sha256(data) };
  }
  const ali = await authlib();
  await fsp.writeFile(path.join(OUT_DIR, 'authlib-injector.jar'), ali);
  manifest.authlib = { fichier: 'authlib-injector.jar', version: AUTHLIB.version, sha256: AUTHLIB.sha256 };
  await fsp.writeFile(path.join(OUT_DIR, 'fichiers.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

module.exports = { prepareGameFiles };

if (require.main === module) {
  prepareGameFiles()
    .then((m) => console.log('src/game prêt :', JSON.stringify(m)))
    .catch((err) => {
      console.error(`Fichiers du jeu : ${err.message}`);
      process.exit(1);
    });
}
