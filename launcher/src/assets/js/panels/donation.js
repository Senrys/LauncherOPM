/**
 * Panneau DONATION — pilote le fragment `src/panels/donation.html`.
 *
 * Tout ce qui est chiffré vient de `window.opm.content.donations()`
 * (`GET /api/v1/donations`, docs/API.md § 1.5) : collecte, objectif, nombre de
 * donateurs, jours restants, paliers et classement. Rien n'est simulé ; quand
 * une donnée manque, l'écran le dit au lieu d'inventer une valeur.
 *
 * FRAÎCHEUR. `content.donations()` est décoré comme les autres contenus : le
 * processus principal peut servir une réponse depuis un cache périmé quand le
 * réseau a échoué, et elle porte alors `stale: true` et `fetched_at`
 * (docs/DATA.md § 5). Le panneau le dit par le même bandeau que l'accueil, posé
 * entre les chiffres et la jauge, et le retire dès qu'une réponse fraîche prend
 * le relais : une cagnotte vieille de trois jours présentée comme le montant de
 * l'instant est une fausse donnée, pas une donnée manquante.
 *
 * Ces deux appels — la lecture de la collecte et l'ouverture du paiement —
 * alimentent aussi le compteur de santé de la liaison (`network`,
 * utils/state.js), d'où la clé `online` est dérivée : ce sont de vrais
 * allers-retours serveur, ils doivent compter comme tels.
 *
 * Le module ne sélectionne que par attribut `data-*` et ne pose des classes que
 * pour exprimer un état (`opm-amount--active`, `opm-tier--locked|--near|--unlocked`).
 */

import { errorLabel } from '../utils/labels.js';
import { network } from '../utils/state.js';

/* ========================================================================== */
/*  Constantes                                                                */
/* ========================================================================== */

/**
 * Répartition des paliers quand l'API ne donne pas de seuil explicite : les
 * quatre quarts de l'objectif, conformément à docs/DATA.md § 2.
 */
const TIER_SHARES = [0.25, 0.5, 0.75, 1];

/** États d'un palier, du plus bas au plus haut, avec leur classe et leur libellé. */
const TIER_STATES = {
  locked: { className: 'opm-tier--locked', label: 'VERROUILLÉ' },
  near: { className: 'opm-tier--near', label: 'À PORTÉE' },
  unlocked: { className: 'opm-tier--unlocked', label: 'DÉBLOQUÉ' },
};

/* ========================================================================== */
/*  Aides locales                                                             */
/* ========================================================================== */

/**
 * Accord en nombre d'un libellé français simple.
 * @param {number} count
 * @param {string} one forme au singulier
 * @param {string} many forme au pluriel
 * @returns {string}
 */
function plural(count, one, many) {
  return count > 1 ? many : one;
}

/**
 * Contraint un pourcentage entre 0 et 100.
 * @param {number} value
 * @returns {number}
 */
function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Premier champ numérique renseigné parmi une liste de noms possibles.
 * L'API peut nommer un seuil `threshold_cents` ou `amount_cents` selon la
 * source : on lit ce qui existe plutôt que d'imposer un nom.
 *
 * @param {Object} source
 * @param {string[]} names
 * @returns {number|null}
 */
function firstNumber(source, names) {
  for (const name of names) {
    const value = source?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Première chaîne non vide parmi une liste de noms possibles.
 * @param {Object} source
 * @param {string[]} names
 * @returns {string}
 */
function firstText(source, names) {
  for (const name of names) {
    const value = source?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/* ========================================================================== */
/*  Panneau                                                                   */
/* ========================================================================== */

export default class DonationPanel {
  static id = 'donation';

  /**
   * Monte le panneau : références, câblage, première collecte de données.
   * @param {Object} ctx contexte fourni par le renderer
   */
  async init(ctx) {
    this.ctx = ctx;
    this.root = ctx.root;

    const { $, $$ } = ctx.dom;

    /** Dernière réponse de `content.donations()`, ou `null` tant qu'inconnue. */
    this.data = null;

    /**
     * Relevé périmé en cours d'affichage : `fetched_at` de la réponse servie
     * depuis le cache, `null` quand elle n'en portait pas, et `undefined` quand
     * les chiffres affichés sont frais (docs/DATA.md § 5).
     * @type {string|null|undefined}
     */
    this.staleAt = undefined;

    /** Montant sélectionné, en centimes. */
    this.amount = 0;

    /** Une requête est déjà en vol : inutile d'en empiler une seconde. */
    this.loading = false;

    this.el = {
      amounts: $$('[data-action="pick-amount"]', this.root),
      projection: $('[data-bind="donation-projection"]', this.root),
      collected: $('[data-bind="donation-collected"]', this.root),
      goal: $('[data-bind="donation-goal"]', this.root),
      percent: $('[data-bind="donation-percent"]', this.root),
      remaining: $('[data-bind="donation-remaining"]', this.root),
      bar: $('[data-el="goal-bar"]', this.root),
      fill: $('[data-el="goal-fill"]', this.root),
      ghost: $('[data-el="goal-ghost"]', this.root),
      tiers: $('[data-el="tiers"]', this.root),
      tierTpl: $('[data-el="tier-tpl"]', this.root),
      donors: $('[data-el="donors"]', this.root),
      donorTpl: $('[data-el="donor-tpl"]', this.root),
      donorsCount: $('[data-bind="donors-count"]', this.root),
      donate: $('[data-action="donate"]', this.root),
      perks: $('[data-action="open-perks"]', this.root),
    };

    // Le bandeau de fraîcheur s'ancre sur la jauge : il se construit donc une
    // fois les références résolues, et part masqué — rien n'est encore chargé.
    this.el.stale = this.buildStaleNotice();
    this.paintStale();

    // Le montant de départ est celui que le balisage déclare enfoncé : on le lit
    // par son attribut ARIA, jamais par sa classe de style.
    const initial = this.el.amounts.find((node) => node.getAttribute('aria-pressed') === 'true')
      ?? this.el.amounts[0];
    this.amount = Number(initial?.dataset.amount ?? 0);

    this.wireActions();
    await this.load();
  }

  /** Le panneau redevient visible : la collecte a pu bouger entre-temps. */
  async show() {
    await this.load();
  }

  /* ---------------------------------------------------------------- câblage */

  /**
   * Les trois actions de l'écran, en délégation depuis la racine. Le panneau
   * est monté une seule fois pour la durée de la fenêtre : ces écouteurs n'ont
   * jamais à être relâchés.
   */
  wireActions() {
    const { delegate } = this.ctx.dom;

    delegate(this.root, 'click', '[data-action="pick-amount"]', (event, target) => {
      this.pickAmount(target);
    });

    delegate(this.root, 'click', '[data-action="donate"]', () => this.donate());
    delegate(this.root, 'click', '[data-action="open-perks"]', () => this.openPerks());
  }

  /* --------------------------------------------------------- fraîcheur */

  /**
   * Crée le bandeau de fraîcheur, entre les chiffres et la jauge.
   *
   * Le fragment ne le porte pas : il n'a de sens que quand le processus
   * principal sert une réponse depuis un cache périmé, et il doit disparaître
   * dès qu'une réponse fraîche arrive. Il s'ancre sur la jauge — le seul point
   * d'ancrage documenté de cette carte — et il est réutilisé si le fragment
   * finit par le déclarer lui-même.
   *
   * @returns {Element|null}
   */
  buildStaleNotice() {
    const { $, el } = this.ctx.dom;

    const existing = $('[data-el="stale-notice"]', this.root);
    if (existing) return existing;

    const bar = this.el.bar;
    if (!bar) return null;

    const notice = el('p', {
      class: ['opm-note', 'opm-note--offline'],
      dataset: { el: 'stale-notice' },
      role: 'status',
      hidden: true,
    });

    bar.before(notice);
    return notice;
  }

  /**
   * Fraîcheur de la réponse de `content.donations()` (docs/DATA.md § 5).
   *
   * Une réponse servie depuis un cache périmé porte `stale: true` et
   * `fetched_at` : on retient l'horodatage pour le bandeau. Toute autre réponse
   * efface la marque.
   *
   * @param {unknown} data
   */
  markFreshness(data) {
    const marked = Boolean(data) && typeof data === 'object' && data.stale === true;

    if (marked) this.staleAt = typeof data.fetched_at === 'string' ? data.fetched_at : null;
    else this.staleAt = undefined;

    this.paintStale();
  }

  /**
   * Bandeau « données hors ligne ». Il annonce l'âge réel des chiffres qui sont
   * sous les yeux du joueur, et disparaît dès qu'une réponse fraîche les
   * remplace. Un échec de chargement, lui, ne le touche pas : les chiffres
   * affichés restent ceux du dernier relevé, et le bandeau les décrit toujours.
   */
  paintStale() {
    const notice = this.el.stale;
    if (!notice) return;

    const { setText, toggle } = this.ctx.dom;

    if (this.staleAt === undefined) {
      toggle(notice, false);
      return;
    }

    const when = this.staleAt ? this.ctx.format.relTime(this.staleAt) : '';
    setText(notice, when
      ? `Données hors ligne · relevées ${when}`
      : 'Données hors ligne · date de relève inconnue');
    toggle(notice, true);
  }

  /* ------------------------------------------------------------- données */

  /** Interroge l'API et redessine tout l'écran. */
  async load() {
    if (this.loading) return;
    this.loading = true;

    try {
      // `network.watch` tient le compteur d'échecs d'où la clé `online` est
      // dérivée : une réponse marquée `stale` y compte comme une panne, une
      // réponse fraîche comme une liaison rétablie.
      this.data = await network.watch(this.ctx.opm.content.donations());
      this.markFreshness(this.data);
      this.render();
    } catch (error) {
      // Les squelettes restent en place : mieux vaut un écran en attente qu'un
      // faux montant collecté. Le bandeau de fraîcheur, lui, ne bouge pas : il
      // décrit toujours honnêtement ce qui reste affiché.
      this.reportFailure(
        error,
        'Collecte indisponible',
        "Les chiffres de la cagnotte n'ont pas pu être récupérés. Réessayez dans un instant.",
      );
    } finally {
      this.loading = false;
    }
  }

  /**
   * Signale un échec au joueur sans jamais lui montrer un code technique.
   *
   * Le détail brut part dans le journal, où il sert au diagnostic ; la phrase
   * affichée vient de `utils/labels.js`, seule table de libellés du launcher.
   * Sans elle, un appel dont le processus principal n'aurait pas fourni de
   * message ferait remonter le code lui-même : `preload.call()` construit
   * l'`Error` avec `message || error`.
   *
   * Le titre dit ce qui a échoué, la phrase du module dit pourquoi — la même
   * grammaire que la barre du bas et les Paramètres.
   *
   * @param {unknown} error
   * @param {string} title ce qui a échoué, en français
   * @param {string} message phrase de repli quand le code est inconnu
   */
  reportFailure(error, title, message) {
    this.ctx.log('warn', `${title} : ${error?.message ?? error}`);

    this.ctx.toast({
      kind: 'error',
      title,
      message: errorLabel(error?.code, message).message,
    });
  }

  /** Montant collecté, en centimes. */
  get collected() {
    return firstNumber(this.data, ['collected_cents']) ?? 0;
  }

  /** Objectif du mois, en centimes ; 0 quand aucun objectif n'est publié. */
  get goal() {
    return firstNumber(this.data, ['goal_cents']) ?? 0;
  }

  /* ------------------------------------------------------------- rendu */

  /** Redessine les trois cartes à partir de `this.data`. */
  render() {
    this.renderGoal();
    this.renderTiers();
    this.renderDonors();
    this.renderProjection();
    this.renderPerks();
  }

  /**
   * Écrit une valeur dont la source a répondu, même si elle est vide : le
   * squelette de chargement disparaît dans tous les cas, puisqu'il n'y a plus
   * rien à attendre. `setText` ne suffirait pas — il conserve le squelette
   * quand le texte est vide, ce qui est le bon comportement tant que la
   * donnée, elle, n'est pas arrivée.
   *
   * @param {Element|null} node
   * @param {string} text
   */
  bind(node, text) {
    if (!node) return;
    node.textContent = text;
    node.classList.remove('opm-skeleton');
  }

  /** Carte « objectif » : chiffres, pourcentage, échéance et jauge. */
  renderGoal() {
    const { euros, pct, nf } = this.ctx.format;

    const collected = this.collected;
    const goal = this.goal;

    this.bind(this.el.collected, euros(collected));
    this.bind(this.el.goal, goal > 0 ? `/ ${euros(goal)}` : 'collecte libre');
    this.bind(this.el.percent, goal > 0 ? pct(collected, goal) : '');

    const days = firstNumber(this.data, ['days_left']);
    this.bind(this.el.remaining, days === null
      ? ''
      : (days > 0
        ? `${nf(days)} ${plural(days, 'jour restant', 'jours restants')}`
        : 'Dernier jour de la collecte'));

    const percent = goal > 0 ? clampPercent((collected / goal) * 100) : 0;
    if (this.el.fill) this.el.fill.style.width = `${percent}%`;
    if (this.el.bar) this.el.bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  }

  /**
   * Paliers de la collecte. Le seuil vient de l'API quand elle le donne, sinon
   * des quarts de l'objectif ; l'état est toujours recalculé ici, à partir du
   * montant réellement collecté.
   */
  renderTiers() {
    const container = this.el.tiers;
    const template = this.el.tierTpl;
    if (!container || !template) return;

    const { $, setText, el } = this.ctx.dom;
    const tiers = Array.isArray(this.data?.tiers) ? this.data.tiers : [];

    container.replaceChildren();

    if (tiers.length === 0) {
      // Aucun palier publié : on le dit, plutôt que de laisser quatre cartes
      // vides tourner indéfiniment en squelette.
      container.append(el('article', { class: 'opm-tier' }, [
        el('p', { text: 'Les paliers de la collecte seront annoncés prochainement.' }),
      ]));
      return;
    }

    const collected = this.collected;
    const goal = this.goal;

    const thresholds = tiers.map((tier, index) => {
      const explicit = firstNumber(tier, ['threshold_cents', 'amount_cents', 'goal_cents']);
      if (explicit !== null) return explicit;

      const share = firstNumber(tier, ['percent']);
      if (share !== null) return Math.round((goal * share) / 100);

      return Math.round(goal * (TIER_SHARES[index] ?? 1));
    });

    // « À portée » désigne le prochain palier non atteint : le seul vers lequel
    // un don supplémentaire fait réellement avancer le serveur.
    const nextIndex = thresholds.findIndex((threshold) => collected < threshold);

    tiers.forEach((tier, index) => {
      const card = template.content.firstElementChild.cloneNode(true);
      const threshold = thresholds[index];

      const state = collected >= threshold
        ? TIER_STATES.unlocked
        : (index === nextIndex ? TIER_STATES.near : TIER_STATES.locked);

      card.classList.add(state.className);

      const amount = threshold > 0 ? ` · ${this.ctx.format.euros(threshold)}` : '';
      setText($('[data-bind="tier-tag"]', card), `${state.label}${amount}`);
      setText($('[data-bind="tier-title"]', card), firstText(tier, ['title', 'name', 'label']));
      setText($('[data-bind="tier-desc"]', card), firstText(tier, ['description', 'desc', 'reward']));

      container.append(card);
    });
  }

  /** Classement des donateurs du mois. */
  renderDonors() {
    const list = this.el.donors;
    const template = this.el.donorTpl;
    if (!list || !template) return;

    const { $, setText, el } = this.ctx.dom;
    const { nf, euros } = this.ctx.format;

    const top = Array.isArray(this.data?.top) ? this.data.top : [];
    const count = firstNumber(this.data, ['donors_count']);

    this.bind(this.el.donorsCount, count === null
      ? ''
      : `${nf(count)} ${plural(count, 'donateur', 'donateurs')}`);

    list.replaceChildren();

    if (top.length === 0) {
      // La partie paiement du site n'expose pas encore de classement : état vide
      // honnête plutôt qu'un podium inventé (docs/DATA.md § 2).
      list.append(el('li', { class: 'opm-donor' }, [
        el('span', {
          class: 'opm-donor__name',
          text: 'Le classement des donateurs arrive bientôt.',
        }),
      ]));
      return;
    }

    top.forEach((donor, index) => {
      const row = template.content.firstElementChild.cloneNode(true);

      setText($('[data-bind="donor-rank"]', row), index + 1);
      setText($('[data-bind="donor-name"]', row), firstText(donor, ['name', 'username', 'pseudo']));
      setText($('[data-bind="donor-tier"]', row), firstText(donor, ['tier', 'tier_title', 'label']));

      const amount = firstNumber(donor, ['amount_cents', 'total_cents']);
      if (amount !== null) setText($('[data-bind="donor-amount"]', row), euros(amount));

      list.append(row);
    });
  }

  /**
   * Barre fantôme et phrase de projection : ce que le montant choisi ferait à
   * la collecte. Sans objectif publié, la projection reste factuelle.
   */
  renderProjection() {
    const { euros, pct } = this.ctx.format;

    const collected = this.collected;
    const goal = this.goal;
    const amount = this.amount;

    if (this.el.ghost) {
      const projected = goal > 0 ? clampPercent(((collected + amount) / goal) * 100) : 0;
      this.el.ghost.style.width = `${projected}%`;
    }

    if (!this.data) return;

    if (goal <= 0) {
      this.bind(this.el.projection,
        `Un don de ${euros(amount)} va directement à l'hébergement et à la modération du serveur.`);
      return;
    }

    const reached = collected + amount;
    const sentence = reached >= goal
      ? `Un don de ${euros(amount)} porterait la collecte à ${pct(reached, goal)} de l'objectif : `
        + 'le navire passerait le mois sans avarie.'
      : `Un don de ${euros(amount)} porterait la collecte à ${pct(reached, goal)} de l'objectif, `
        + `soit ${euros(goal - reached)} encore à réunir.`;

    this.bind(this.el.projection, sentence);
  }

  /**
   * Le bouton « AVANTAGES » mène à la page du site qui les détaille. Sans URL
   * connue, il est désactivé plutôt que de ne mener nulle part.
   */
  renderPerks() {
    if (!this.el.perks) return;
    this.el.perks.disabled = this.perksUrl() === null;
  }

  /**
   * URL de la page des avantages, prise dans les données réelles.
   * @returns {string|null}
   */
  perksUrl() {
    const fromApi = firstText(this.data, ['perks_url', 'url']);
    if (fromApi) return fromApi;

    const website = this.ctx.store.get().bootstrap?.links?.website;
    return typeof website === 'string' && website !== '' ? website : null;
  }

  /* ------------------------------------------------------------- actions */

  /**
   * Choisit un montant : l'état enfoncé se déplace, la projection se recalcule.
   * @param {HTMLButtonElement} target
   */
  pickAmount(target) {
    const amount = Number(target.dataset.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;

    this.amount = amount;

    for (const button of this.el.amounts) {
      const active = button === target;
      button.classList.toggle('opm-amount--active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    this.renderProjection();
  }

  /** Ouvre la page de paiement pour le montant retenu. */
  async donate() {
    if (this.amount <= 0) return;

    this.el.donate.disabled = true;
    try {
      await network.watch(this.ctx.opm.content.donate(this.amount));
      this.ctx.toast({
        kind: 'info',
        title: 'Page de paiement ouverte',
        message: `Terminez votre don de ${this.ctx.format.euros(this.amount)} dans votre navigateur.`,
      });
    } catch (error) {
      this.reportFailure(
        error,
        'Paiement indisponible',
        "La page de paiement n'a pas pu être ouverte. Réessayez dans un instant.",
      );
    } finally {
      this.el.donate.disabled = false;
    }
  }

  /** Ouvre la page des avantages dans le navigateur du système. */
  openPerks() {
    const url = this.perksUrl();
    if (url) this.ctx.openExternal(url);
  }
}
