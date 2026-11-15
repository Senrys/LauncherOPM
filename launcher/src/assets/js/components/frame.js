/**
 * Fenêtre ouverte — comportement du cadre.
 *
 * En mode ouvert (assets/js/frame.js, layout/frame.css), la fenêtre est plus
 * grande que le launcher, et transparente autour. Deux choses à gérer ici :
 *
 *   1. **Clics traversants.** Sur la marge vide, la souris doit atteindre le
 *      bureau, comme si la fenêtre n'existait pas. Le processus principal laisse
 *      passer les clics (`setIgnoreMouseEvents(true, {forward: true})`) tout en
 *      continuant à nous envoyer les mouvements de la souris : dès qu'elle
 *      revient sur le cadre, on reprend la main.
 *
 *   2. **Redimensionnement.** Une fenêtre transparente ne se redimensionne pas
 *      par ses bords : le launcher dessine sa poignée, en bas à droite du cadre.
 *
 * En mode compact, rien de tout cela : la fenêtre est le cadre.
 */

/** Ce qui capte la souris : le cadre et tout ce qui est marqué `data-hit`. */
const HIT = '[data-el="frame"], [data-hit]';

/**
 * @returns {boolean} la fenêtre est-elle en mode ouvert ?
 */
export function isOpen() {
  return document.documentElement.dataset.fenetre === 'ouvert';
}

/**
 * Branche le cadre. Sans effet en mode compact.
 * @param {{setPassthrough: Function, resizeFrame: Function}} win  `opm.window`
 */
export function wireFrame(win) {
  if (!isOpen()) return;

  const frame = document.querySelector('[data-el="frame"]');
  const grip = document.querySelector('[data-el="grip"]');
  if (!frame) return;

  /* --------------------------------------------------- clics traversants */

  let passing = null; // inconnu au départ : le premier mouvement tranche
  let dragging = false;

  const setPassing = (value) => {
    if (passing === value) return;
    passing = value;
    win.setPassthrough(value);
  };

  const track = (event) => {
    if (dragging) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    setPassing(!(target && target.closest(HIT)));
  };

  window.addEventListener('mousemove', track, { passive: true });
  // La souris quitte la fenêtre : on rend la main au bureau.
  document.documentElement.addEventListener('mouseleave', () => {
    if (!dragging) setPassing(true);
  });
  // Au démarrage, la souris n'a pas encore bougé : la marge laisse passer.
  setPassing(true);

  /* ------------------------------------------------------------ poignée */

  if (!grip) return;
  let start = null;
  let pending = null;
  let frameRequest = 0;

  const flush = () => {
    frameRequest = 0;
    if (!pending) return;
    win.resizeFrame(pending.width, pending.height);
    pending = null;
  };

  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    setPassing(false);
    grip.setPointerCapture(event.pointerId);
    grip.dataset.dragging = '';
    const rect = frame.getBoundingClientRect();
    start = { x: event.screenX, y: event.screenY, width: rect.width, height: rect.height };
  });

  grip.addEventListener('pointermove', (event) => {
    if (!start) return;
    pending = {
      width: start.width + (event.screenX - start.x),
      height: start.height + (event.screenY - start.y),
    };
    if (!frameRequest) frameRequest = requestAnimationFrame(flush);
  });

  const stop = (event) => {
    if (!start) return;
    start = null;
    dragging = false;
    delete grip.dataset.dragging;
    if (grip.hasPointerCapture?.(event.pointerId)) grip.releasePointerCapture(event.pointerId);
    flush();
  };
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);
}
