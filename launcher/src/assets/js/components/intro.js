/**
 * L'apparition du launcher, en fenêtre ouverte : le cadre se construit ligne
 * à ligne, de haut en bas (une ligne de scan le parcourt), puis le décor autour
 * s'allume. Xenodys n'arrive qu'ensuite (components/xenodys3d.js, `arrive`).
 *
 * Les animations elles-mêmes sont en CSS (layout/frame.css : `opmFrameBuild`,
 * `opmBuildLine`, `opmDecorOn`) : au démarrage, elles jouent même si le script
 * échoue, et le cadre finit toujours par apparaître. Ce module sait seulement
 * attendre leur fin, et les rejouer au retour d'une partie.
 */

const NAMES = new Set(['opmFrameBuild', 'opmBuildLine', 'opmDecorOn']);
/** Au-delà, on n'attend plus : le cadre est forcément là. */
const MAX_WAIT_MS = 2200;

function buildAnimations() {
  return document.getAnimations().filter((a) => NAMES.has(a.animationName));
}

/** Attend la fin de la construction du cadre (immédiat si elle est déjà jouée). */
export function frameBuilt() {
  const anims = buildAnimations();
  if (anims.length === 0) return Promise.resolve();
  return Promise.race([
    Promise.all(anims.map((a) => a.finished.catch(() => {}))),
    new Promise((r) => setTimeout(r, MAX_WAIT_MS)),
  ]).then(() => {});
}

/**
 * Rejoue la construction du cadre. Renvoie la promesse de sa fin.
 * Les animations CSS terminées restent attachées aux éléments : `play()`
 * après `cancel()` les fait repartir du début.
 */
export function rebuildFrame() {
  const els = document.querySelectorAll('[data-el="frame"], .opm-surround, .opm-buildline');
  const anims = [];
  for (const el of els) {
    for (const a of el.getAnimations()) {
      if (!NAMES.has(a.animationName)) continue;
      a.cancel();
      a.play();
      anims.push(a);
    }
  }
  if (anims.length === 0) return Promise.resolve();
  return Promise.race([
    Promise.all(anims.map((a) => a.finished.catch(() => {}))),
    new Promise((r) => setTimeout(r, MAX_WAIT_MS)),
  ]).then(() => {});
}
