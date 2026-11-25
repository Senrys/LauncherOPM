'use strict';

/**
 * Le paquet de ressources d'OPM : textures, modèles, animations et laboratoire,
 * chiffrés dans un seul fichier (`opm.pak`), le même pour le mod et le launcher.
 *
 *   node scripts/paquet.js            # assemble et chiffre (ressources locales)
 *   node scripts/paquet.js --cle      # crée la clé locale si elle n'existe pas
 *
 * Les ressources elles-mêmes ne sont **jamais** versionnées (.gitignore) : le dépôt
 * est public, seul le paquet chiffré y figure. La clé vient de `OPM_PACK_KEY` (secret
 * GitHub Actions) ou du fichier local `.cle-ressources`, ignoré lui aussi.
 *
 * Limite, à connaître : le jeu et le launcher doivent pouvoir lire le paquet, la clé
 * voyage donc, brouillée, dans ce qui est installé chez le joueur. Cela empêche de se
 * servir dans le dépôt ou d'ouvrir le `.jar` avec un simple dézippeur ; quelqu'un de
 * déterminé y arriverait.
 *
 * Format : « OPMR », 12 octets d'IV, 16 octets de sceau, puis AES-256-GCM de zlib(
 * longueur du sommaire (uint32 BE), sommaire JSON {nom: [début, longueur]}, données).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const KEY_FILE = path.join(ROOT, '.cle-ressources');
const RES = path.join(ROOT, 'xenodys', 'paquet');
const OUT = [
  path.join(ROOT, 'mod', 'src', 'main', 'resources', 'assets', 'opm', 'opm.pak'),
  path.join(ROOT, 'launcher', 'src', 'assets', 'opm.pak'),
];
const MAGIC = Buffer.from('OPMR');

/** La clé (32 octets), ou `null`. */
function readKey() {
  let hex = (process.env.OPM_PACK_KEY || '').trim();
  if (!hex && fs.existsSync(KEY_FILE)) hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
  return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
}

function createKey() {
  if (readKey()) return false;
  fs.writeFileSync(KEY_FILE, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  return true;
}

function list(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.name.startsWith('.')) return [];
    return e.isDirectory() ? list(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  }).sort();
}

function seal(files, key) {
  const index = {};
  const parts = [];
  let at = 0;
  for (const [name, data] of files) {
    index[name] = [at, data.length];
    parts.push(data);
    at += data.length;
  }
  const head = Buffer.from(JSON.stringify(index));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(head.length);
  const plain = zlib.deflateSync(Buffer.concat([size, head, ...parts]), { level: 9 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

/** Le contenu du paquet : `Map<nom, Buffer>`. Lève si la clé n'est pas la bonne. */
function open(pak, key) {
  if (pak.length < 32 || !pak.subarray(0, 4).equals(MAGIC)) throw new Error('paquet illisible');
  const d = crypto.createDecipheriv('aes-256-gcm', key, pak.subarray(4, 16));
  d.setAuthTag(pak.subarray(16, 32));
  const raw = zlib.inflateSync(Buffer.concat([d.update(pak.subarray(32)), d.final()]));
  const n = raw.readUInt32BE(0);
  const index = JSON.parse(raw.subarray(4, 4 + n).toString('utf8'));
  return new Map(Object.entries(index).map(([k, [a, l]]) => [k, raw.subarray(4 + n + a, 4 + n + a + l)]));
}

function same(file, files, key) {
  try {
    const old = open(fs.readFileSync(file), key);
    return old.size === files.length && files.every(([n, d]) => old.get(n)?.equals(d));
  } catch {
    return false;
  }
}

module.exports = { readKey, open, KEY_FILE };

if (require.main === module) {
  if (process.argv.includes('--cle')) console.log(createKey() ? 'Clé créée : .cle-ressources (gardez-en une copie sûre).' : 'La clé existe déjà.');
  const key = readKey();
  if (!key) {
    console.error('Aucune clé : OPM_PACK_KEY, ou « node scripts/paquet.js --cle ».');
    process.exit(1);
  }
  if (!fs.existsSync(RES)) {
    console.error('Ressources absentes (xenodys/paquet) : le paquet déjà versionné est conservé.');
    process.exit(1);
  }
  const files = list(RES).map((n) => [n, fs.readFileSync(path.join(RES, n))]);
  const bytes = seal(files, key);
  for (const f of OUT) {
    if (same(f, files, key)) continue; // rien de neuf : pas de bruit dans git
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, bytes);
  }
  console.log(`${files.length} ressources, ${Math.round(bytes.length / 1024)} Kio chiffrés.`);
}
