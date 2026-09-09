/**
 * Notifications éphémères — coin bas droite, empilées dans [data-el="toasts"].
 *
 * Elles remplacent la fenêtre modale de l'ancien launcher pour tout ce qui
 * n'est pas bloquant : information, erreur réseau, confirmation d'action.
 * Les décisions qui engagent le joueur passent, elles, par `confirmModal()`.
 *
 * Comportement :
 *  - quatre notifications visibles au maximum, les suivantes attendent leur tour ;
 *  - masquage automatique au bout de six secondes ;
 *  - le compte à rebours se met en pause au survol et tant que le focus clavier
 *    reste dans la notification ;
 *  - bouton de fermeture toujours disponible.
 */

import { $, el, on } from '../utils/dom.js';

/** Notifications affichées simultanément. */
const MAX_VISIBLE = 4;

/** Durée d'affichage par défaut, en millisecondes. */
const DEFAULT_TIMEOUT = 6000;

/** Durée du fondu de sortie avant retrait du nœud. */
const EXIT_DELAY = 220;

/** Variantes acceptées, avec la classe de style correspondante. */
const KINDS = {
  info: 'opm-toast--info',
  error: 'opm-toast--error',
  success: 'opm-toast--success',
};

/** Notifications en attente d'une place libre. */
const queue = [];

/** Notifications actuellement à l'écran. */
const shown = new Set();

/**
 * Conteneur d'accueil, résolu à chaque affichage (le document est stable, mais
 * la notification peut être demandée avant la fin du démarrage).
 * @returns {Element|null}
 */
function host() {
  return $('[data-el="toasts"]');
}

/**
 * Construit le nœud d'une notification.
 * @param {{kind: string, title: string, message: string, dismiss: () => void}} item
 * @returns {HTMLElement}
 */
function build(item) {
  const close = el('button', {
    type: 'button',
    class: 'opm-toast__close',
    'aria-label': 'Fermer la notification',
    onClick: () => item.dismiss(),
  }, '×');

  return el('div', {
    class: ['opm-toast', KINDS[item.kind]],
    // Les erreurs sont annoncées sans attendre ; le conteneur reste poli.
    role: item.kind === 'error' ? 'alert' : null,
  }, [
    item.title ? el('p', { class: 'opm-toast__title', text: item.title }) : null,
    item.message ? el('p', { class: 'opm-toast__message', text: item.message }) : null,
    close,
  ]);
}

/** Lance ou relance le compte à rebours de masquage. */
function resume(item) {
  if (item.timer !== null || item.remaining <= 0) return;
  item.startedAt = Date.now();
  item.timer = setTimeout(() => item.dismiss(), item.remaining);
}

/** Suspend le compte à rebours et mémorise le temps restant. */
function pause(item) {
  if (item.timer === null) return;
  clearTimeout(item.timer);
  item.timer = null;
  item.remaining = Math.max(0, item.remaining - (Date.now() - item.startedAt));
}

/** Affiche la notification suivante si une place s'est libérée. */
function pump() {
  while (shown.size < MAX_VISIBLE && queue.length > 0) {
    present(queue.shift());
  }
}

/**
 * Pose la notification dans le document et démarre son cycle de vie.
 * @param {Object} item
 */
function present(item) {
  const container = host();
  if (!container) {
    // Sans conteneur, on ne perd pas l'information pour autant.
    console.warn(`opm : conteneur de notifications absent — ${item.title} ${item.message}`);
    return;
  }

  item.node = build(item);
  container.append(item.node);
  shown.add(item);

  // Le survol et le focus clavier suspendent le masquage automatique.
  item.listeners = [
    on(item.node, 'mouseenter', () => pause(item)),
    on(item.node, 'mouseleave', () => resume(item)),
    on(item.node, 'focusin', () => pause(item)),
    on(item.node, 'focusout', () => resume(item)),
  ];

  resume(item);
}

/**
 * Affiche une notification.
 *
 * @param {{kind?: 'info'|'error'|'success', title?: string, message?: string,
 *          timeout?: number}|string} options message seul, ou notification complète
 * @returns {() => void} fermeture anticipée
 */
export function toast(options) {
  const input = typeof options === 'string' ? { message: options } : (options || {});
  const kind = KINDS[input.kind] ? input.kind : 'info';

  const item = {
    kind,
    title: input.title ? String(input.title) : '',
    message: input.message ? String(input.message) : '',
    remaining: Number.isFinite(input.timeout) ? Math.max(0, input.timeout) : DEFAULT_TIMEOUT,
    node: null,
    timer: null,
    startedAt: 0,
    listeners: [],
    closed: false,
    dismiss: () => {},
  };

  item.dismiss = () => {
    if (item.closed) return;
    item.closed = true;

    pause(item);
    for (const off of item.listeners) off();
    item.listeners = [];

    const index = queue.indexOf(item);
    if (index !== -1) queue.splice(index, 1);

    if (item.node) {
      // Opacité posée au runtime : le fondu lui-même est décrit en CSS.
      item.node.style.opacity = '0';
      const node = item.node;
      setTimeout(() => node.remove(), EXIT_DELAY);
    }

    if (shown.delete(item)) pump();
  };

  if (item.message === '' && item.title === '') return item.dismiss;

  if (shown.size < MAX_VISIBLE) present(item);
  else queue.push(item);

  return item.dismiss;
}
