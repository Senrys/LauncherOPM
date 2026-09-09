/**
 * Modale de confirmation — la seule interruption bloquante du launcher.
 *
 * Réservée aux décisions qui engagent le joueur : suppression d'un compte,
 * réinitialisation des paramètres, dissociation du compte Microsoft. Tout le
 * reste passe par une notification (`toast`).
 *
 * Le focus est enfermé dans la carte, `Échap` et le clic sur le voile valent
 * « annuler », et le focus revient à l'élément qui l'avait à l'ouverture.
 * Deux confirmations demandées coup sur coup s'enchaînent au lieu de se
 * disputer le focus.
 */

import { $, el, focusTrap, on } from '../utils/dom.js';

/** Compteur d'identifiants, pour relier la carte à son titre et à son texte. */
let sequence = 0;

/** File d'attente : une seule modale visible à la fois. */
let chain = Promise.resolve();

/**
 * Demande une confirmation.
 *
 * @param {{title?: string, message?: string, confirmLabel?: string,
 *          cancelLabel?: string, danger?: boolean}} options
 * @returns {Promise<boolean>} vrai si le joueur confirme
 */
export function confirmModal(options = {}) {
  const result = chain.then(() => present(options));
  // La file continue même si une modale échoue : elle ne doit jamais se bloquer.
  chain = result.catch(() => false);
  return result;
}

/**
 * Affiche réellement la modale et résout la promesse au choix du joueur.
 * @param {Object} options
 * @returns {Promise<boolean>}
 */
function present({
  title = 'Confirmer',
  message = '',
  confirmLabel = 'CONFIRMER',
  cancelLabel = 'ANNULER',
  danger = false,
} = {}) {
  const root = $('[data-el="modal-root"]');
  if (!root) {
    console.error('opm : racine des modales absente — confirmation refusée par défaut.');
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    sequence += 1;
    const titleId = `opm-modal-title-${sequence}`;
    const messageId = `opm-modal-message-${sequence}`;

    let settled = false;
    /** @type {(() => void)|null} */
    let release = null;
    /** @type {Array<() => void>} */
    const listeners = [];

    /**
     * Ferme la modale et rend la réponse.
     * @param {boolean} answer
     */
    const finish = (answer) => {
      if (settled) return;
      settled = true;

      for (const off of listeners) off();
      if (release) release();
      overlay.remove();
      resolve(answer);
    };

    const cancelButton = el('button', {
      type: 'button',
      class: ['opm-btn', 'opm-btn--ghost'],
      text: cancelLabel,
      onClick: () => finish(false),
    });

    const confirmButton = el('button', {
      type: 'button',
      class: ['opm-btn', danger ? 'opm-btn--danger' : 'opm-btn--ink'],
      text: confirmLabel,
      onClick: () => finish(true),
    });

    const card = el('div', {
      class: 'opm-modal__card',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      'aria-describedby': message ? messageId : null,
    }, [
      el('h2', { class: 'opm-modal__title', id: titleId, text: title }),
      message ? el('p', { class: 'opm-modal__message', id: messageId, text: message }) : null,
      el('div', { class: 'opm-modal__actions' }, [cancelButton, confirmButton]),
    ]);

    const veil = el('div', {
      class: 'opm-modal__veil',
      onClick: () => finish(false),
    });

    const overlay = el('div', { class: 'opm-modal' }, [veil, card]);
    root.append(overlay);

    // Échap annule ; la touche est captée sur la modale, qui détient le focus.
    listeners.push(on(overlay, 'keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }));

    // Par défaut, c'est « annuler » qui a le focus : aucune action destructrice
    // ne peut être déclenchée par une frappe entrée au mauvais moment.
    release = focusTrap(card, { initial: cancelButton });
  });
}
