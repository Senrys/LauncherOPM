/**
 * Les ressources d'OPM (modèles, textures, laboratoire) : le processus principal les
 * lit dans le paquet chiffré du launcher (src/main/services/pack.js).
 */

const cache = new Map();

/** Les octets d'une ressource, ou `null`. @param {string} name */
export function packBytes(name) {
  if (!cache.has(name)) cache.set(name, Promise.resolve(window.opm?.resources?.get(name) ?? null).catch(() => null));
  return cache.get(name);
}

/** Un fichier JSON du paquet, ou `null`. */
export async function packJson(name) {
  const bytes = await packBytes(name);
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
}

/** Une image du paquet (décodée), ou rejet. */
export async function packImage(name) {
  const bytes = await packBytes(name);
  if (!bytes) throw new Error(`ressource absente : ${name}`);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const img = new Image();
  img.src = `data:image/png;base64,${btoa(binary)}`;
  await img.decode();
  return img;
}
