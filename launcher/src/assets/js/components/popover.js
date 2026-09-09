/**
 * Popover — panneau flottant rattaché à un déclencheur (bouton de compte,
 * bouton « DÉTAILS » de la console). Le placement et l'apparence sont décrits
 * en CSS ; ce module ne gère que l'ouverture, la fermeture et l'accessibilité.
 *
 * Le déclencheur n'est volontairement pas câblé ici : c'est la coque qui écoute
 * `data-action` et appelle `toggle()`. On évite ainsi qu'un même clic soit
 * traité deux fois.
 */

import { on } from '../utils/dom.js';

/** Popovers actuellement ouverts, pour pouvoir tous les fermer d'un coup. */
const opened = new Set();

export class Popover {
  /**
   * @param {HTMLElement} anchor déclencheur (porte `aria-expanded`)
   * @param {HTMLElement} panel panneau à révéler (commuté par `hidden`)
   * @param {{onOpen?: () => void, onClose?: () => void}} [options]
   */
  constructor(anchor, panel, { onOpen = null, onClose = null } = {}) {
    if (!anchor || !panel) {
      throw new TypeError('Popover attend un déclencheur et un panneau.');
    }

    this.anchor = anchor;
    this.panel = panel;
    this.onOpen = onOpen;
    this.onClose = onClose;

    /** @type {Array<() => void>} écouteurs actifs uniquement pendant l'ouverture */
    this.listeners = [];

    this.panel.hidden = true;
    this.anchor.setAttribute('aria-expanded', 'false');
  }

  /** @returns {boolean} */
  get isOpen() {
    return !this.panel.hidden;
  }

  /** Ouvre le panneau et arme les fermetures automatiques. */
  open() {
    if (this.isOpen) return;

    this.panel.hidden = false;
    this.anchor.setAttribute('aria-expanded', 'true');
    opened.add(this);

    this.listeners = [
      // Un clic hors du panneau et hors du déclencheur referme. On écoute
      // `pointerdown` : la fermeture précède le `click` du déclencheur, qui
      // reste donc libre de rouvrir ou de fermer par `toggle()`.
      on(document, 'pointerdown', (event) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (this.panel.contains(target) || this.anchor.contains(target)) return;
        this.close();
      }, true),

      on(document, 'keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        this.close();
        // Le focus revient au déclencheur : on ne le perd jamais dans le vide.
        this.anchor.focus({ preventScroll: true });
      }),
    ];

    if (this.onOpen) this.onOpen();
  }

  /** Referme le panneau. */
  close() {
    if (!this.isOpen) return;

    this.panel.hidden = true;
    this.anchor.setAttribute('aria-expanded', 'false');
    opened.delete(this);

    for (const off of this.listeners) off();
    this.listeners = [];

    if (this.onClose) this.onClose();
  }

  /** Ouvre ou ferme selon l'état courant. */
  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Détache tout : à appeler si le déclencheur quitte le document. */
  destroy() {
    this.close();
    this.anchor.removeAttribute('aria-expanded');
  }
}

/** Ferme tous les popovers ouverts (changement d'écran, raccourci Échap). */
export function closeAllPopovers() {
  for (const popover of Array.from(opened)) popover.close();
}
