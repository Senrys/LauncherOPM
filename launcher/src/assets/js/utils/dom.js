/**
 * Aides DOM du renderer — module ES natif, aucune dépendance.
 *
 * RÈGLE DE COUPLAGE : le JS ne sélectionne jamais par classe CSS. Toutes les
 * requêtes passent par des attributs `data-*` (data-el, data-screen, data-tab,
 * data-sub, data-view, data-action, data-bind). Les classes restent réservées
 * au style ; on ne fait que les *poser* pour exprimer un état.
 *
 * `el()` construit les nœuds sans jamais toucher à `innerHTML` : le seul point
 * d'entrée HTML du renderer est `setHtml()`, réservé aux fragments de panneaux
 * fournis par le processus principal. Tout texte venant du réseau passe par
 * `setText()`.
 */

/** Éléments susceptibles de recevoir le focus, pour le piège de focus. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/* -------------------------------------------------------------- sélection */

/**
 * Premier élément correspondant au sélecteur.
 * @param {string} selector
 * @param {ParentNode} [root=document]
 * @returns {Element|null}
 */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * Tous les éléments correspondants, sous forme de tableau (et non de NodeList).
 * @param {string} selector
 * @param {ParentNode} [root=document]
 * @returns {Element[]}
 */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/* -------------------------------------------------------------- création */

/**
 * Crée un élément sans passer par `innerHTML`.
 *
 * Propriétés reconnues :
 *  - `class`      : chaîne ou tableau de classes ;
 *  - `text`       : contenu textuel ;
 *  - `dataset`    : objet `{ el: 'play' }` → `data-el="play"` ;
 *  - `style`      : objet de propriétés CSS calculées au runtime (largeur de
 *                   jauge, opacité…) — jamais de style décoratif ;
 *  - `onClick`, `onKeydown`, … : écouteurs (le nom après « on » est mis en
 *    minuscules pour donner le type d'événement) ;
 *  - toute autre clé devient un attribut ; `true` pose l'attribut vide,
 *    `false`/`null`/`undefined` ne pose rien. Les propriétés booléennes
 *    natives (`hidden`, `disabled`, `checked`) sont affectées directement.
 *
 * @param {string} tag
 * @param {Object<string, *>|null} [props]
 * @param {(Node|string|Array<Node|string|null|undefined>)|null} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = null, children = null) {
  const node = document.createElement(tag);

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue;

      if (key === 'class') {
        const list = Array.isArray(value) ? value : String(value).split(/\s+/);
        node.classList.add(...list.filter(Boolean));
      } else if (key === 'text') {
        node.textContent = String(value);
      } else if (key === 'dataset') {
        for (const [name, item] of Object.entries(value)) {
          if (item !== null && item !== undefined) node.dataset[name] = String(item);
        }
      } else if (key === 'style') {
        for (const [name, item] of Object.entries(value)) {
          if (item !== null && item !== undefined) node.style.setProperty(name, String(item));
        }
      } else if (key.length > 2 && key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node && typeof node[key] === 'boolean') {
        node[key] = Boolean(value);
      } else if (value === true) {
        node.setAttribute(key, '');
      } else if (value !== false) {
        node.setAttribute(key, String(value));
      }
    }
  }

  append(node, children);
  return node;
}

/**
 * Ajoute des enfants (nœuds, chaînes, tableaux imbriqués) en ignorant les vides.
 * @param {Node} parent
 * @param {Node|string|Array<Node|string|null|undefined>|null|undefined} children
 */
function append(parent, children) {
  if (children === null || children === undefined) return;

  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
    return;
  }
  parent.append(children instanceof Node ? children : document.createTextNode(String(children)));
}

/* ------------------------------------------------------------ événements */

/**
 * Abonnement à un événement. Renvoie la fonction de désabonnement.
 * @param {EventTarget} target
 * @param {string} type
 * @param {(event: Event) => void} handler
 * @param {boolean|AddEventListenerOptions} [options]
 * @returns {() => void}
 */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/**
 * Délégation d'événement : un seul écouteur pour un ensemble d'éléments,
 * y compris ceux injectés plus tard (panneaux, listes de comptes…).
 * Le gestionnaire reçoit l'événement puis l'élément qui a réellement
 * déclenché la correspondance.
 *
 * @param {EventTarget & ParentNode} root
 * @param {string} type
 * @param {string} selector
 * @param {(event: Event, matched: Element) => void} handler
 * @param {boolean|AddEventListenerOptions} [options]
 * @returns {() => void}
 */
export function delegate(root, type, selector, handler, options) {
  return on(root, type, (event) => {
    const start = event.target;
    if (!(start instanceof Element)) return;

    const matched = start.closest(selector);
    if (matched && root.contains(matched)) handler(event, matched);
  }, options);
}

/* ------------------------------------------------------------- affichage */

/**
 * Écrit un texte dans une cible (élément ou sélecteur).
 * Dès qu'une valeur réelle est écrite, le squelette de chargement est retiré :
 * c'est la convention des panneaux (`.opm-skeleton` posé dans le HTML, enlevé
 * par le JS juste après avoir reçu la donnée).
 *
 * @param {Element|string|null} target
 * @param {string|number|null|undefined} value
 * @returns {Element|null} la cible, pour chaîner
 */
export function setText(target, value) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) return null;

  const text = value === null || value === undefined ? '' : String(value);
  node.textContent = text;
  if (text !== '') node.classList.remove('opm-skeleton');
  return node;
}

/**
 * Injecte un fragment HTML **de confiance** (panneaux servis par le processus
 * principal via `window.opm.app.panel()`). Ne jamais y passer de contenu
 * distant : tout texte venant de l'API se pose avec `setText`.
 *
 * @param {Element|string|null} target
 * @param {string} html
 * @returns {Element|null}
 */
export function setHtml(target, html) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) return null;

  node.innerHTML = html;
  return node;
}

/**
 * Affiche un élément (retire l'attribut `hidden`).
 * @param {Element|string|null} target
 */
export function show(target) {
  return toggle(target, true);
}

/**
 * Masque un élément (pose l'attribut `hidden`).
 * @param {Element|string|null} target
 */
export function hide(target) {
  return toggle(target, false);
}

/**
 * Bascule la visibilité par l'attribut `hidden`.
 * @param {Element|string|null} target
 * @param {boolean} [visible] force l'état ; sinon inverse l'état courant
 * @returns {Element|null}
 */
export function toggle(target, visible) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) return null;

  const next = visible === undefined ? node.hasAttribute('hidden') : Boolean(visible);
  node.toggleAttribute('hidden', !next);
  return node;
}

/* ---------------------------------------------------------- piège de focus */

/**
 * Liste ordonnée des éléments focusables réellement visibles.
 * @param {ParentNode} container
 * @returns {HTMLElement[]}
 */
function focusables(container) {
  return $$(FOCUSABLE, container).filter(
    (node) => node instanceof HTMLElement && node.getClientRects().length > 0,
  );
}

/**
 * Enferme le focus clavier dans un conteneur (modale, dialogue).
 * Le focus part sur le premier élément focusable, `Tab`/`Maj+Tab` bouclent,
 * et toute tentative d'en sortir ramène à l'intérieur.
 *
 * @param {HTMLElement} container
 * @param {{ initial?: HTMLElement|null }} [options]
 * @returns {(opts?: { restore?: boolean }) => void} libère le piège et,
 *          par défaut, rend le focus à l'élément qui l'avait avant.
 */
export function focusTrap(container, { initial = null } = {}) {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const entry = initial || focusables(container)[0] || container;
  if (entry === container && !container.hasAttribute('tabindex')) {
    container.setAttribute('tabindex', '-1');
  }
  entry.focus({ preventScroll: true });

  const offKey = on(container, 'keydown', (event) => {
    if (event.key !== 'Tab') return;

    const items = focusables(container);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  });

  const offFocus = on(document, 'focusin', (event) => {
    if (container.contains(event.target)) return;
    (focusables(container)[0] || container).focus({ preventScroll: true });
  });

  return ({ restore = true } = {}) => {
    offKey();
    offFocus();
    if (restore && previous && document.contains(previous)) {
      previous.focus({ preventScroll: true });
    }
  };
}
