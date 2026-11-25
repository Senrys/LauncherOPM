/**
 * Xenodys la Tisseuse et ses assistants : modèles et animations, lus dans le paquet de
 * ressources. `null` si le paquet est fermé.
 */

import { packBytes, packJson } from '../utils/pack.js';

async function rig(id) {
  const [meta, bytes] = await Promise.all([packJson(`modeles/${id}.json`), packBytes(`modeles/${id}.bin`)]);
  if (!meta || !bytes) return null;
  // Une copie alignée : 24 float32 par face.
  return { id, meta, faces: new Float32Array(bytes.slice().buffer) };
}

const quiet = (p) => p.catch(() => null);
const [tisseuse, graine, luciole, fileuse, animations, assistants] = await Promise.all([
  quiet(rig('xenodys_tisseuse')), quiet(rig('assistant_graine')), quiet(rig('assistant_luciole')), quiet(rig('assistant_fileuse')),
  quiet(packJson('geckolib/animations/xenodys_tisseuse.animation.json')), quiet(packJson('geckolib/animations/xenodys_assistant.animation.json')),
]);

export const RIGS = tisseuse && graine && luciole && fileuse
  ? { xenodys_tisseuse: tisseuse, assistant_graine: graine, assistant_luciole: luciole, assistant_fileuse: fileuse } : null;
export const ANIMATIONS = animations;
export const ASSISTANT_ANIMATIONS = assistants;

/** Les couches d'un modèle : `[première face, nombre]`. */
export function layersOf({ meta }) {
  const out = {};
  let at = 0;
  for (const k of ['base', 'verre', 'lueur', 'energie']) {
    out[k] = [at, meta.couches[k]];
    at += meta.couches[k];
  }
  return out;
}
