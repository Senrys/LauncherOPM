'use strict';

/**
 * Les ressources d'OPM (modèles, textures, laboratoire), lues dans le paquet chiffré
 * `assets/opm.pak` (../../../../scripts/paquet.js). La clé est écrite à la compilation
 * (`pack-key.js`, game-files.js), jamais versionnée ; en développement, elle vient du
 * fichier local `.cle-ressources`. Sans clé, le launcher marche, sans ses scènes 3D.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const logger = require('./logger');

const PAK = path.join(__dirname, '..', '..', 'assets', 'opm.pak');
const LOCAL_KEY = path.join(__dirname, '..', '..', '..', '..', '.cle-ressources');
const NAME = /^(labo|geckolib|entity)\/[\w./-]{1,80}$/;

let files = null;

function key() {
  try {
    return require('./pack-key').key();
  } catch {
    /* depuis les sources */
  }
  try {
    const hex = fs.readFileSync(LOCAL_KEY, 'utf8').trim();
    return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
  } catch {
    return null;
  }
}

function load() {
  if (files) return files;
  files = new Map();
  const k = key();
  if (!k) {
    logger.warn('Paquet de ressources fermé : aucune clé.');
    return files;
  }
  try {
    const pak = fs.readFileSync(PAK);
    const d = crypto.createDecipheriv('aes-256-gcm', k, pak.subarray(4, 16));
    d.setAuthTag(pak.subarray(16, 32));
    const raw = zlib.inflateSync(Buffer.concat([d.update(pak.subarray(32)), d.final()]));
    const n = raw.readUInt32BE(0);
    for (const [name, [at, size]] of Object.entries(JSON.parse(raw.subarray(4, 4 + n).toString('utf8')))) {
      files.set(name, raw.subarray(4 + n + at, 4 + n + at + size));
    }
  } catch (err) {
    logger.error(`Paquet de ressources illisible : ${err.message}`);
  }
  return files;
}

/**
 * Une ressource, ou `null`.
 * @param {unknown} name  chemin dans le paquet (`labo/labo.bin`, `entity/xenodys_creatrice.png`…)
 * @returns {Uint8Array | null}
 */
function get(name) {
  if (typeof name !== 'string' || !NAME.test(name) || name.includes('..')) return null;
  const data = load().get(name);
  return data ? new Uint8Array(data) : null;
}

module.exports = { get };
