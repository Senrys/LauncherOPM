/**
 * Barre de titre — onglets, version, boutons de fenêtre et rail social.
 *
 * Ce module ne dessine rien : le balisage est déjà dans `src/launcher.html`.
 * Il se contente de brancher les points d'ancrage `data-*` sur `window.opm` et
 * sur le magasin partagé :
 *
 *  - `data-tab`    : les trois onglets. Un clic écrit `tab` dans le magasin ;
 *    c'est le renderer qui monte le panneau correspondant. La barre, elle, ne
 *    fait que refléter l'état (classe active, `aria-selected`, focus glissant).
 *  - `data-bind="app-version"` : version réelle, `window.opm.app.version()`.
 *  - `data-action="window-…"`  : réduire / agrandir / fermer. L'icône du bouton
 *    d'agrandissement bascule sur l'événement `window:maximized`.
 *  - `data-action="open-link"` : rail social, URL issues de `bootstrap.links`,
 *    ouvertes dans le navigateur du système.
 *
 * Les boutons de fenêtre sont câblés partout où ils existent (coque **et**
 * écran de connexion, qui réutilise la même barre réduite) : un seul module
 * s'en occupe, il n'y a donc jamais deux gestionnaires sur le même clic.
 */

import { $, $$, on, setText } from '../utils/dom.js';
import { network, store } from '../utils/state.js';
import { toast } from '../components/toast.js';

/** Onglets acceptés, dans l'ordre de la barre. */
const TABS = ['home', 'settings', 'donation'];

/** `data-el` d'une tuile du rail → clé correspondante dans `bootstrap.links`. */
const RAIL_KEYS = {
  'link-discord': 'discord',
  'link-twitch': 'twitch',
  'link-youtube': 'youtube',
  'link-website': 'website',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Construit une icône SVG 11 × 11 au trait, dans le style des boutons de fenêtre.
 * Les icônes sont créées ici parce qu'elles changent au runtime ; toutes les
 * autres vivent dans le balisage.
 *
 * @param {Array<[string, Object<string, string>]>} shapes couples `[balise, attributs]`
 * @returns {SVGElement}
 */
function windowIcon(shapes) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('viewBox', '0 0 11 11');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const [tag, attributes] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.4');
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    svg.append(node);
  }
  return svg;
}

/** Carré simple — la fenêtre est en taille normale, le bouton l'agrandit. */
const maximizeIcon = () => windowIcon([
  ['rect', { x: '1.2', y: '1.2', width: '8.6', height: '8.6' }],
]);

/** Deux carrés décalés — la fenêtre est agrandie, le bouton la restaure. */
const restoreIcon = () => windowIcon([
  ['path', { d: 'M3.4 3.4V1.2h6.4v6.4H7.6' }],
  ['rect', { x: '1.2', y: '3.4', width: '6.4', height: '6.4' }],
]);

/**
 * Numéro de version tel qu'il s'affiche à droite de la barre : « V2.0.0 ».
 * Le « v » que porteraient certains tags n'est jamais doublé.
 *
 * @param {string|null|undefined} raw
 * @returns {string}
 */
function versionLabel(raw) {
  const clean = String(raw ?? '').trim().replace(/^v/i, '');
  return clean === '' ? '' : `V${clean}`;
}

export default class Titlebar {
  static id = 'titlebar';

  constructor() {
    /** @type {Element[]} les trois onglets `role="tab"` */
    this.tabs = [];
    /** @type {Element[]} boutons d'agrandissement (coque + écran de connexion) */
    this.maxButtons = [];
    /** @type {Element[]} tuiles du rail social */
    this.railLinks = [];
    /** @type {Element|null} hôte des panneaux, pour `aria-labelledby` */
    this.host = null;
    /** @type {Object|null} contexte fourni par le renderer */
    this.ctx = null;
    /** @type {Array<() => void>} désabonnements posés par `init()` */
    this.offs = [];
  }

  /**
   * Câble la barre. Appelable plusieurs fois : les abonnements précédents sont
   * relâchés avant d'en poser de nouveaux.
   * @param {{root?: ParentNode}} [ctx]
   */
  async init(ctx = {}) {
    this.dispose();
    this.ctx = ctx;

    const root = ctx.root instanceof Element || ctx.root instanceof Document ? ctx.root : document;
    this.host = $('[data-el="panel-host"]', root);

    // Les panneaux portent eux aussi `data-tab` sur leur section racine :
    // seuls les éléments annoncés comme onglets nous concernent.
    this.tabs = $$('[data-tab]', root).filter((node) => node.getAttribute('role') === 'tab');
    this.maxButtons = $$('[data-action="window-max"]', root);
    this.railLinks = $$('[data-action="open-link"]', root);

    this.wireTabs();
    this.wireWindowButtons();
    this.wireRail();

    this.offs.push(store.subscribe((state, changed) => {
      if (changed.has('tab')) this.paintTabs(state.tab);
      if (changed.has('bootstrap')) this.paintRail(state.bootstrap);
    }));

    this.paintTabs(store.get().tab);
    this.paintRail(store.get().bootstrap);

    await Promise.all([this.loadVersion(), this.loadMaximized(), this.loadLinks()]);
  }

  /**
   * La barre de titre reste montée pendant toute la vie de la fenêtre : les
   * deux méthodes du contrat des panneaux n'ont rien à commuter ici.
   */
  async show() {}

  async hide() {}

  /** Relâche les abonnements (nouvel `init()` ou fermeture). */
  dispose() {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /* ------------------------------------------------------------- onglets */

  /** Clic et navigation clavier sur les onglets. */
  wireTabs() {
    for (const tab of this.tabs) {
      this.offs.push(on(tab, 'click', () => this.select(tab.dataset.tab)));

      // Motif ARIA « tablist » : les flèches déplacent le focus d'un onglet à
      // l'autre, Origine/Fin sautent aux extrémités, et l'onglet visé devient
      // actif dans la foulée.
      this.offs.push(on(tab, 'keydown', (event) => {
        const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
        const move = keys[event.key];
        if (move === undefined) return;

        event.preventDefault();
        const index = this.tabs.indexOf(tab);
        const target = move === 'first' ? 0
          : move === 'last' ? this.tabs.length - 1
            : (index + move + this.tabs.length) % this.tabs.length;

        const next = this.tabs[target];
        if (!next) return;
        next.focus({ preventScroll: true });
        this.select(next.dataset.tab);
      }));
    }
  }

  /**
   * Demande le changement d'onglet. Le renderer possède le routage entre
   * panneaux : quand il fournit `setTab`, c'est lui qui monte l'écran (l'appel
   * est sans effet si l'onglet est déjà actif). Sans contexte, la barre se
   * contente de publier l'intention dans le magasin.
   * @param {string|undefined} tab
   */
  select(tab) {
    if (!TABS.includes(tab)) return;

    if (typeof this.ctx?.setTab === 'function') {
      Promise.resolve(this.ctx.setTab(tab)).catch((error) => {
        console.error('opm : changement d\'onglet impossible.', error);
      });
      return;
    }
    store.set({ tab });
  }

  /**
   * Reflète l'onglet actif : classe d'état, `aria-selected`, focus glissant et
   * libellé de l'hôte des panneaux.
   * @param {string} current onglet actif
   */
  paintTabs(current) {
    for (const tab of this.tabs) {
      const selected = tab.dataset.tab === current;
      tab.classList.toggle('opm-titlebar__tab--active', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      // Un seul onglet reste dans l'ordre de tabulation : les flèches font le reste.
      tab.tabIndex = selected ? 0 : -1;
      if (selected && this.host && tab.id) this.host.setAttribute('aria-labelledby', tab.id);
    }
  }

  /* ------------------------------------------------------------- version */

  /** Écrit la version réelle du launcher et la publie dans le magasin. */
  async loadVersion() {
    try {
      const version = await window.opm.app.version();
      setText($('[data-bind="app-version"]'), versionLabel(version));
      store.set({ version: String(version ?? '') });
    } catch (error) {
      // Sans version, l'emplacement reste vide : mieux vaut rien qu'un numéro faux.
      console.error('opm : version du launcher indisponible.', error);
    }
  }

  /* ------------------------------------------------- boutons de fenêtre */

  /**
   * Réduire, agrandir/restaurer, fermer.
   *
   * Seuls les boutons de la coque sont câblés ici : la barre réduite de l'écran
   * de connexion n'appartient à aucun module, c'est le renderer qui la branche.
   * Les brancher deux fois annulerait un agrandissement aussitôt demandé.
   */
  wireWindowButtons() {
    const actions = {
      'window-min': () => window.opm.window.minimize(),
      'window-max': () => window.opm.window.maximize(),
      'window-close': () => window.opm.window.close(),
    };

    for (const [action, run] of Object.entries(actions)) {
      for (const button of $$(`[data-action="${action}"]`)) {
        if (button.closest('[data-screen="login"]')) continue;
        this.offs.push(on(button, 'click', run));
      }
    }
  }

  /** État initial de la fenêtre, puis suivi des agrandissements. */
  async loadMaximized() {
    try {
      this.paintMaximized(await window.opm.window.isMaximized());
    } catch (error) {
      console.error('opm : état d\'agrandissement de la fenêtre inconnu.', error);
    }
    this.offs.push(window.opm.window.onMaximizeChange((max) => this.paintMaximized(max)));
  }

  /**
   * Bascule l'icône, l'état pressé et le libellé du bouton d'agrandissement.
   * @param {boolean} maximized
   */
  paintMaximized(maximized) {
    for (const button of this.maxButtons) {
      button.replaceChildren(maximized ? restoreIcon() : maximizeIcon());
      button.setAttribute('aria-pressed', maximized ? 'true' : 'false');
      button.setAttribute('aria-label', maximized ? 'Restaurer la fenêtre' : 'Agrandir la fenêtre');
    }
  }

  /* ---------------------------------------------------------------- rail */

  /**
   * Ouvre le lien porté par la tuile, dans le navigateur du système.
   *
   * La propagation est arrêtée : le renderer garde une délégation de secours
   * sur `[data-action="open-link"]` pour le cas où ce module manquerait, et
   * deux gestionnaires ouvriraient deux fois la même page.
   */
  wireRail() {
    for (const link of this.railLinks) {
      this.offs.push(on(link, 'click', async (event) => {
        event.stopPropagation();

        const url = link.dataset.url;
        if (!url) return;

        try {
          await window.opm.app.openExternal(url);
        } catch (error) {
          console.error('opm : ouverture du lien impossible.', error);
          toast({
            kind: 'error',
            title: 'Lien impossible à ouvrir',
            message: 'Le navigateur n\'a pas pu être lancé.',
          });
        }
      }));
    }
  }

  /**
   * Distribue les URL de `bootstrap.links` sur les tuiles du rail. Une tuile
   * sans URL connue est désactivée plutôt que de mener nulle part.
   * @param {Object|null} bootstrap
   */
  paintRail(bootstrap) {
    const links = bootstrap && typeof bootstrap.links === 'object' ? bootstrap.links : null;

    for (const link of this.railLinks) {
      const url = links ? links[RAIL_KEYS[link.dataset.el]] : null;

      if (typeof url === 'string' && url !== '') {
        link.dataset.url = url;
        link.disabled = false;
      } else {
        delete link.dataset.url;
        link.disabled = true;
      }
    }
  }

  /**
   * Garantit que `bootstrap` est dans le magasin : le rail en dépend, et la
   * barre de titre est montée avant les panneaux. Si le renderer l'a déjà
   * chargé, on ne redemande rien.
   *
   * L'appel passe par `network.watch` : cette tentative-ci peut très bien
   * réussir alors que celle du démarrage avait échoué (coupure de quelques
   * secondes), et c'est ce succès qui remet le launcher en ligne.
   */
  async loadLinks() {
    if (store.get().bootstrap) return;

    try {
      const bootstrap = await network.watch(window.opm.auth.bootstrap());
      store.set({ bootstrap, maintenance: bootstrap?.maintenance ?? null });
    } catch (error) {
      // Hors ligne : le rail reste inactif, le renderer se charge de le dire.
      console.warn('opm : bootstrap indisponible, rail social inactif.', error);
    }
  }
}
