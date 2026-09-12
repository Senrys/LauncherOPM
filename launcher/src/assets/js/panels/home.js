/**
 * Panneau ACCUEIL — journal de bord, tuiles et scène du personnage.
 *
 * Tout ce qui s'affiche ici vient du serveur ou du compte connecté :
 *
 *  - `content.news()`      : article mis en avant + liste des dernières news ;
 *  - `content.status()`    : badge d'état du serveur, rafraîchi toutes les 30 s ;
 *  - `content.nextEvent()` : compte à rebours du prochain événement RP, mis à
 *    jour chaque seconde et arrêté dès que le panneau est masqué ;
 *  - `content.votes()`     : tuile des votes du mois ;
 *  - `auth.current()`      : identité, skin et fiche RP du joueur — le
 *    personnage de la scène est composé EN PIED à partir du skin, et son
 *    sous-titre est la ligne RP « faction · équipage · îles tenues ».
 *
 * Tant qu'une donnée manque, l'emplacement garde son squelette de chargement
 * (`.opm-skeleton`, retiré par `setText()` dès qu'une valeur réelle arrive).
 * Si le réseau échoue, la carte le dit d'une ligne sobre au lieu d'afficher
 * une valeur inventée ou de laisser tourner un squelette pour l'éternité.
 *
 * FRAÎCHEUR. Le processus principal peut servir une réponse depuis un cache
 * périmé quand le réseau a échoué ; elle porte alors `stale: true` et
 * `fetched_at` (docs/DATA.md § 5). Le panneau le dit par un bandeau discret
 * « Données hors ligne · relevées … », posé sous l'en-tête du journal et retiré
 * dès qu'une réponse fraîche le remplace : afficher « SERVEUR EN LIGNE · 42
 * joueurs » vieux de trois jours comme une mesure de l'instant serait pire
 * qu'un écran vide.
 *
 * Ces mêmes appels alimentent le compteur de santé de la liaison
 * (`network`, utils/state.js), d'où la clé `online` est dérivée.
 */

import { $, delegate, el, on, setText, toggle } from '../utils/dom.js';
import { countdown, dateFr, nf, relTime } from '../utils/format.js';
import { blockedLabel } from '../utils/labels.js';
import { network, store } from '../utils/state.js';
import { FALLBACK_BODY, bodyDataUrl, skinImage } from '../utils/skin.js';
import { toast } from '../components/toast.js';

/** Rafraîchissement du statut du serveur. */
const STATUS_INTERVAL = 30_000;

/** Rafraîchissement des tuiles événement et votes (docs/DATA.md §5). */
const TILES_INTERVAL = 60_000;

/** Durée de vie du journal de bord avant rechargement. */
const NEWS_TTL = 300_000;

/** Nombre de segments de la tuile de fréquentation. */
const SEGMENTS = 8;

/** Marque d'une valeur inconnue — jamais un zéro qui ferait croire à une mesure. */
const UNKNOWN = '—';

/**
 * Personnage affiché tant qu'aucun skin n'est disponible : la silhouette neutre
 * prévue pour cela, celle qu'annonce déjà le balisage. Surtout pas un skin
 * nommé de la maquette : le joueur verrait le personnage de quelqu'un d'autre
 * sous le libellé « VOTRE PERSONNAGE ».
 */
const DEFAULT_CHARACTER = FALLBACK_BODY;

/** Étiquettes des actualités : libellé affiché et modificateur de style. */
const KINDS = {
  news: { label: 'ACTUALITÉ', modifier: 'opm-news-item__tag--news' },
  event: { label: 'ÉVÉNEMENT', modifier: 'opm-news-item__tag--event' },
  update: { label: 'MISE À JOUR', modifier: 'opm-news-item__tag--update' },
};

/**
 * Normalise la catégorie d'une actualité. L'API annonce `news | event | update`,
 * la base du site stocke un texte libre (« Actualité », « Événement », « Mise à
 * jour ») : les deux écritures sont acceptées, toute autre valeur reste neutre.
 *
 * @param {string|null|undefined} raw
 * @returns {'news'|'event'|'update'|null}
 */
function kindOf(raw) {
  const key = String(raw ?? '').toLowerCase().trim();

  if (key === 'news' || key.startsWith('actualit')) return 'news';
  if (key === 'event' || key.startsWith('evenement') || key.startsWith('événement')) return 'event';
  if (key === 'update' || key === 'maj' || key.startsWith('mise')) return 'update';
  return null;
}

/**
 * Coupe le titre mis en avant en deux lignes aussi équilibrées que possible :
 * la maquette l'affiche sur deux lignes, la seconde en teal.
 *
 * @param {string} title
 * @returns {[string, string]}
 */
function splitTitle(title) {
  const words = String(title ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [words[0] ?? '', ''];

  let cut = 1;
  let smallest = Infinity;

  for (let index = 1; index < words.length; index += 1) {
    const left = words.slice(0, index).join(' ').length;
    const right = words.slice(index).join(' ').length;
    const gap = Math.abs(left - right);
    if (gap < smallest) {
      smallest = gap;
      cut = index;
    }
  }
  return [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
}

/**
 * Écrit une valeur et retire le squelette, même lorsque la valeur est vide —
 * `setText()` ne le retire que sur un texte non vide, ce qui laisserait
 * scintiller un emplacement volontairement blanchi après une erreur.
 *
 * @param {Element|null} node
 * @param {string} value
 */
function fill(node, value) {
  if (!node) return;
  setText(node, value);
  if (value === '') node.classList.remove('opm-skeleton');
}

export default class Home {
  static id = 'home';

  constructor() {
    /** Points d'ancrage du fragment, résolus par `mount()`. */
    this.refs = {};
    /** @type {Array<() => void>} désabonnements posés par `init()` */
    this.offs = [];
    /** @type {Object<string, number>} minuteurs actifs */
    this.timers = {};
    /** @type {Object<string, number>} date du dernier chargement tenté */
    this.at = {};
    /**
     * Relevés périmés en cours d'affichage : clé de ressource → `fetched_at`
     * de la réponse servie depuis le cache (docs/DATA.md § 5). Une clé absente
     * signifie « cette ressource est fraîche, ou n'est pas affichée du tout ».
     * @type {Object<string, string|null>}
     */
    this.staleAt = {};

    /** @type {Object|null} compte sélectionné */
    this.account = null;
    /** @type {Object|null} prochain événement RP */
    this.event = null;
    /** @type {Object|null} réponse de `content.status()` */
    this.status = null;
    /** @type {Object|null} article mis en avant */
    this.featured = null;
    /** @type {string|null} page de vote, quand l'API en fournit une */
    this.votesUrl = null;
    /** Numéro de la dernière demande de skin, pour ignorer les rendus périmés. */
    this.skinSeq = 0;

    /**
     * Rendu 3D du personnage (skinview3d), créé à la première texture reçue et
     * réutilisé ensuite : changer de compte recharge le skin, ne recrée pas la
     * scène. `null` tant qu'aucune texture n'est arrivée, ou si la 3D est
     * hors service sur cette machine (`viewerBroken`) — auquel cas l'image 2D
     * reste seule en place.
     * @type {any}
     */
    this.viewer = null;
    this.viewerBroken = false;
    /** @type {ResizeObserver|null} */
    this.viewerResize = null;
  }

  /**
   * Câble le panneau. Appelable à nouveau si le fragment est réinjecté.
   * @param {{root?: ParentNode}} [ctx]
   */
  async init(ctx = {}) {
    this.dispose();

    if (!window.opm) {
      console.error('opm : pont du processus principal absent, accueil inerte.');
      return;
    }

    // La racine est cherchée dans l'hôte des panneaux : `data-tab="home"`
    // désigne aussi l'onglet de la barre de titre.
    const host = $('[data-el="panel-host"]');
    const root = ctx.root instanceof Element
      ? ctx.root
      : (host ? ($('[data-tab="home"]', host) ?? host) : null);

    if (!root) {
      console.error('opm : fragment de l\'accueil introuvable.');
      return;
    }

    this.mount(root);
    this.wire();

    // UNE seule source pour le compte : le magasin. Le renderer y recopie déjà
    // chaque `auth:changed` ; s'abonner en plus à `opm.auth.onChange` faisait
    // repeindre la scène — et recomposer le skin au canevas — deux fois par
    // changement de compte, pour un résultat identique.
    this.offs.push(store.subscribe((state, changed) => {
      if (!changed.has('account')) return;
      this.account = state.account;
      this.paintPlayer();
    }));

    await this.loadAccount();
    await this.refresh({ newsMaxAge: 0, tilesMaxAge: 0 });
  }

  /** Le panneau devient visible : minuteurs armés, données rafraîchies. */
  async show() {
    this.startTimers();
    this.tickCountdown();
    if (this.viewer) this.viewer.renderPaused = false;
    await this.refresh({ newsMaxAge: NEWS_TTL, tilesMaxAge: 5_000 });
  }

  /** Le panneau est masqué : plus aucun minuteur ne tourne, ni le rendu 3D. */
  async hide() {
    this.stopTimers();
    // Une boucle WebGL qui tourne derrière un autre onglet, c'est du GPU pour
    // rien — et un ventilateur qui s'emballe sur les portables.
    if (this.viewer) this.viewer.renderPaused = true;
  }

  /** Relâche minuteurs, abonnements et la scène 3D. */
  dispose() {
    this.stopTimers();
    for (const off of this.offs) off();
    this.offs = [];
    this.staleAt = {};
    this.disposeViewer();
  }

  /* --------------------------------------------------------- ancrage DOM */

  /**
   * Résout les points d'ancrage du fragment. Tout est cherché sous la racine du
   * panneau : `player-name` existe aussi dans la barre du bas.
   * @param {ParentNode} root
   */
  mount(root) {
    this.refs = {
      newsMeta: $('[data-bind="news-meta"]', root),
      newsTitle1: $('[data-bind="news-title-1"]', root),
      newsTitle2: $('[data-bind="news-title-2"]', root),
      newsLead: $('[data-bind="news-lead"]', root),
      newsList: $('[data-el="news-list"]', root),
      newsTemplate: $('[data-el="news-item-tpl"]', root),
      featuredButton: $('[data-action="open-featured"]', root),
      archiveButton: $('[data-action="open-news-archive"]', root),

      playersOnline: $('[data-bind="players-online"]', root),
      segments: $('[data-el="online-segments"]', root),

      eventCountdown: $('[data-bind="event-countdown"]', root),
      eventName: $('[data-bind="event-name"]', root),

      votesCount: $('[data-bind="votes-count"]', root),
      votesGoal: $('[data-bind="votes-goal"]', root),
      votesReward: $('[data-bind="votes-reward"]', root),
      voteButton: $('[data-action="vote"]', root),

      serverStatus: $('[data-el="server-status"]', root),
      serverState: $('[data-bind="server-state"]', root),
      serverDetail: $('[data-bind="server-detail"]', root),

      character: $('[data-el="character"]', root),
      character3d: $('[data-el="character-3d"]', root),
      playerName: $('[data-bind="player-name"]', root),
      playerSub: $('[data-bind="player-sub"]', root),

      stale: this.buildStaleNotice(root),
    };

    // Le badge d'état reste caché tant que le serveur n'a pas répondu, et le
    // bandeau de fraîcheur repart de zéro : rien n'est encore affiché.
    toggle(this.refs.serverStatus, false);
    this.paintStale();
    this.buildSegments();
  }

  /**
   * Résout le bandeau « données hors ligne » en tête du journal de bord.
   *
   * Le fragment le porte (`[data-el="stale-notice"]`, vide et masqué) : c'est
   * lui qui est repris ici. La construction de repli ne sert qu'aux hôtes qui
   * n'auraient pas ce point d'ancrage — un fragment plus ancien, un panneau
   * monté sur une racine improvisée — pour que le bandeau ne disparaisse jamais
   * silencieusement du parcours.
   *
   * @param {ParentNode} root
   * @returns {Element|null}
   */
  buildStaleNotice(root) {
    const existing = $('[data-el="stale-notice"]', root);
    if (existing) return existing;

    // Ancré sur la ligne de méta du journal : le bandeau se pose juste sous
    // l'en-tête de la carte, avant le titre mis en avant.
    const head = $('[data-bind="news-meta"]', root)?.parentElement;
    if (!head) return null;

    const notice = el('p', {
      class: ['opm-note', 'opm-note--offline'],
      dataset: { el: 'stale-notice' },
      role: 'status',
      hidden: true,
    });

    head.after(notice);
    return notice;
  }

  /** Les huit segments de la tuile de fréquentation, créés une fois pour toutes. */
  buildSegments() {
    const host = this.refs.segments;
    if (!host || host.childElementCount === SEGMENTS) return;

    host.replaceChildren(
      ...Array.from({ length: SEGMENTS }, () => el('span', {
        class: ['opm-tile__seg', 'opm-tile__seg--off'],
      })),
    );
  }

  /** Branche les commandes du panneau. */
  wire() {
    const { featuredButton, archiveButton, newsList, voteButton } = this.refs;

    if (featuredButton) {
      this.offs.push(on(featuredButton, 'click', () => this.open(this.featured?.url)));
    }

    if (archiveButton) {
      this.offs.push(on(archiveButton, 'click', async () => {
        // Le journal complet vit sur le site du serveur : c'est la seule adresse
        // que le contrat d'API nous donne (`bootstrap.links.website`).
        const bootstrap = await this.bootstrap();
        this.open(bootstrap?.links?.website);
      }));
    }

    if (newsList) {
      this.offs.push(delegate(newsList, 'click', '[data-action="open-news"]', (event, item) => {
        this.open(item.dataset.url);
      }));
    }

    if (voteButton) {
      this.offs.push(on(voteButton, 'click', async () => {
        const bootstrap = await this.bootstrap();
        this.open(this.votesUrl ?? bootstrap?.links?.website);
      }));
    }
  }

  /* ------------------------------------------------------------ minuteurs */

  /** Arme les trois cadences : statut, tuiles, compte à rebours. */
  startTimers() {
    this.stopTimers();
    this.timers.status = setInterval(() => this.loadStatus(0), STATUS_INTERVAL);
    this.timers.tiles = setInterval(() => {
      this.loadEvent(0);
      this.loadVotes(0);
    }, TILES_INTERVAL);
    this.timers.countdown = setInterval(() => this.tickCountdown(), 1_000);
  }

  /** Coupe tous les minuteurs : rien ne tourne derrière un panneau masqué. */
  stopTimers() {
    for (const id of Object.values(this.timers)) clearInterval(id);
    this.timers = {};
  }

  /* ---------------------------------------------------------- chargements */

  /**
   * Une ressource est-elle assez ancienne pour être rechargée ?
   * @param {string} key
   * @param {number} maxAge millisecondes
   * @returns {boolean}
   */
  stale(key, maxAge) {
    return Date.now() - (this.at[key] ?? 0) >= maxAge;
  }

  /**
   * Recharge ce qui doit l'être.
   * @param {{newsMaxAge?: number, tilesMaxAge?: number}} [options]
   */
  async refresh({ newsMaxAge = NEWS_TTL, tilesMaxAge = 0 } = {}) {
    await Promise.all([
      this.loadNews(newsMaxAge),
      this.loadStatus(tilesMaxAge),
      this.loadEvent(tilesMaxAge),
      this.loadVotes(tilesMaxAge),
    ]);
  }

  /**
   * Fraîcheur d'une réponse de contenu (docs/DATA.md § 5).
   *
   * Une réponse servie depuis un cache périmé porte `stale: true` et
   * `fetched_at` : on la retient pour le bandeau. Toute autre réponse — fraîche,
   * ou sans corps annotable, comme un `nextEvent` à `null` — efface la marque.
   *
   * @param {string} key
   * @param {unknown} data
   */
  markFreshness(key, data) {
    const marked = Boolean(data) && typeof data === 'object' && data.stale === true;

    if (marked) this.staleAt[key] = typeof data.fetched_at === 'string' ? data.fetched_at : null;
    else delete this.staleAt[key];

    this.paintStale();
  }

  /**
   * Une ressource n'a pas pu être chargée du tout : elle n'affiche plus rien de
   * périmé (les `fail*` blanchissent l'emplacement), donc elle sort du bandeau.
   * @param {string} key
   */
  forgetFreshness(key) {
    if (!Object.hasOwn(this.staleAt, key)) return;
    delete this.staleAt[key];
    this.paintStale();
  }

  /**
   * Bandeau « données hors ligne ». Il annonce la relève la PLUS ANCIENNE des
   * ressources périmées affichées : c'est elle qui décrit honnêtement l'âge de
   * ce que le joueur a sous les yeux. Dès qu'une réponse fraîche remplace la
   * dernière ressource périmée, le bandeau disparaît.
   */
  paintStale() {
    const notice = this.refs.stale;
    if (!notice) return;

    const stamps = Object.values(this.staleAt);
    if (stamps.length === 0) {
      toggle(notice, false);
      return;
    }

    // Les horodatages sont ISO 8601 en UTC : l'ordre alphabétique est l'ordre
    // chronologique, inutile de les convertir pour en prendre le plus ancien.
    const oldest = stamps.filter((value) => typeof value === 'string').sort()[0] ?? null;
    const when = oldest ? relTime(oldest) : '';

    setText(notice, when
      ? `Données hors ligne · relevées ${when}`
      : 'Données hors ligne · date de relève inconnue');
    toggle(notice, true);
  }

  /** Bootstrap du serveur : hôte du serveur Minecraft et liens du site. */
  async bootstrap() {
    const cached = store.get().bootstrap;
    if (cached) return cached;

    try {
      // Compte pour la santé de la liaison : c'est un vrai aller-retour serveur,
      // sans cache, donc le signal le plus net dont dispose le launcher.
      const bootstrap = await network.watch(window.opm.auth.bootstrap());
      store.set({ bootstrap, maintenance: bootstrap?.maintenance ?? null });
      return bootstrap;
    } catch (error) {
      console.warn('opm : bootstrap indisponible.', error);
      return null;
    }
  }

  /** Compte sélectionné, pour l'identité et le skin. */
  async loadAccount() {
    this.account = store.get().account ?? null;

    if (!this.account) {
      try {
        this.account = await window.opm.auth.current();
      } catch (error) {
        console.warn('opm : compte courant indisponible.', error);
      }
    }
    this.paintPlayer();
  }

  /**
   * Journal de bord.
   * @param {number} maxAge
   */
  async loadNews(maxAge) {
    if (!this.stale('news', maxAge)) return;
    this.at.news = Date.now();

    try {
      const news = await network.watch(window.opm.content.news());
      this.markFreshness('news', news);
      this.featured = news?.featured ?? null;
      this.paintNews(news);
    } catch (error) {
      console.error('opm : journal de bord indisponible.', error);
      // Un échec ne gèle pas le journal pour cinq minutes : la prochaine
      // ouverture du panneau réessaie.
      this.at.news = 0;
      this.forgetFreshness('news');
      this.failNews();
    }
  }

  /**
   * Statut du serveur : badge, TPS, hôte, et tuile de fréquentation.
   * @param {number} maxAge
   */
  async loadStatus(maxAge) {
    if (!this.stale('status', maxAge)) return;
    this.at.status = Date.now();

    try {
      this.status = await network.watch(window.opm.content.status());
      this.markFreshness('status', this.status);
      await this.paintStatus();
    } catch (error) {
      console.warn('opm : statut du serveur indisponible.', error);
      this.status = null;
      this.forgetFreshness('status');
      this.failStatus();
    }
  }

  /**
   * Prochain événement RP.
   * @param {number} maxAge
   */
  async loadEvent(maxAge) {
    if (!this.stale('event', maxAge)) return;
    this.at.event = Date.now();

    try {
      this.event = await network.watch(window.opm.content.nextEvent());
      // `nextEvent` peut valoir `null` — aucun événement programmé : il n'y a
      // alors rien à annoter, et rien à signaler dans le bandeau.
      this.markFreshness('event', this.event);
    } catch (error) {
      console.warn('opm : prochain événement indisponible.', error);
      this.event = null;
      this.forgetFreshness('event');
    }
    this.paintEvent();
  }

  /**
   * Votes du mois.
   * @param {number} maxAge
   */
  async loadVotes(maxAge) {
    if (!this.stale('votes', maxAge)) return;
    this.at.votes = Date.now();

    try {
      const votes = await network.watch(window.opm.content.votes());
      this.markFreshness('votes', votes);
      // Quand l'API expose l'adresse de la page de vote, elle prime sur le site.
      this.votesUrl = typeof votes?.url === 'string' ? votes.url : null;
      this.paintVotes(votes);
    } catch (error) {
      console.warn('opm : votes du mois indisponibles.', error);
      this.forgetFreshness('votes');
      this.paintVotes(null);
    }
  }

  /* --------------------------------------------------------------- rendu */

  /**
   * Journal de bord : article mis en avant puis liste des suivants.
   * @param {Object|null} news
   */
  paintNews(news) {
    const featured = news?.featured ?? null;

    if (featured) {
      const kind = kindOf(featured.kind);
      const label = kind ? KINDS[kind].label : 'JOURNAL DE BORD';
      const date = dateFr(featured.published_at);

      fill(this.refs.newsMeta, [label, date].filter(Boolean).join(' · '));

      // La maquette pose le titre en capitales ; Anton ne les impose pas.
      const [first, second] = splitTitle(String(featured.title ?? '').toLocaleUpperCase('fr-FR'));
      fill(this.refs.newsTitle1, first);
      fill(this.refs.newsTitle2, second);
      fill(this.refs.newsLead, featured.excerpt ?? '');
    } else {
      fill(this.refs.newsMeta, 'AUCUNE PARUTION');
      fill(this.refs.newsTitle1, '');
      fill(this.refs.newsTitle2, '');
      fill(this.refs.newsLead, 'Le journal de bord est encore vide.');
    }

    if (this.refs.featuredButton) this.refs.featuredButton.disabled = !featured?.url;

    this.paintNewsList(Array.isArray(news?.items) ? news.items : []);
  }

  /**
   * Liste des dernières actualités.
   * @param {Array<Object>} items
   */
  paintNewsList(items) {
    const { newsList, newsTemplate } = this.refs;
    if (!newsList || !newsTemplate) return;

    newsList.replaceChildren();

    for (const item of items) {
      const node = newsTemplate.content.firstElementChild.cloneNode(true);
      const kind = kindOf(item.kind);

      const tag = $('[data-bind="item-tag"]', node);
      if (tag) {
        if (kind) tag.classList.add(KINDS[kind].modifier);
        setText(tag, kind ? KINDS[kind].label : String(item.kind ?? '').toLocaleUpperCase('fr-FR'));
      }

      setText($('[data-bind="item-title"]', node), item.title ?? '');
      setText($('[data-bind="item-date"]', node), dateFr(item.published_at));

      // Sans adresse, la ligne reste lisible mais n'ouvre rien.
      if (typeof item.url === 'string' && item.url !== '') node.dataset.url = item.url;
      else node.disabled = true;

      newsList.append(node);
    }
  }

  /** Le journal n'a pas pu être chargé : on le dit, sobrement. */
  failNews() {
    fill(this.refs.newsMeta, 'JOURNAL HORS LIGNE');
    fill(this.refs.newsTitle1, '');
    fill(this.refs.newsTitle2, '');
    fill(
      this.refs.newsLead,
      'Impossible de joindre le journal de bord. Il se rechargera dès que la connexion sera rétablie.',
    );

    if (this.refs.newsList) this.refs.newsList.replaceChildren();
    if (this.refs.featuredButton) this.refs.featuredButton.disabled = true;
  }

  /** Badge d'état du serveur et tuile de fréquentation. */
  async paintStatus() {
    const status = this.status;
    const bootstrap = await this.bootstrap();
    const host = bootstrap?.server?.host ?? '';

    const online = status?.online === true;
    fill(this.refs.serverState, online ? 'SERVEUR EN LIGNE' : 'SERVEUR HORS LIGNE');

    const tps = typeof status?.tps === 'number' ? `TPS ${nf(status.tps, 1)}` : '';
    const detail = online
      ? [tps, host].filter(Boolean).join(' · ')
      : [host, 'injoignable'].filter(Boolean).join(' · ');
    fill(this.refs.serverDetail, detail || 'État inconnu');

    toggle(this.refs.serverStatus, true);

    const players = typeof status?.players_online === 'number' ? status.players_online : null;
    const capacity = typeof status?.players_max === 'number' ? status.players_max : 0;

    fill(this.refs.playersOnline, players === null ? UNKNOWN : nf(players));
    this.paintSegments(players !== null && capacity > 0 ? players / capacity : 0);
  }

  /** Le serveur n'a pas répondu : le badge le dit plutôt que de disparaître. */
  failStatus() {
    fill(this.refs.serverState, 'STATUT INDISPONIBLE');
    fill(this.refs.serverDetail, 'Le serveur n\'a pas répondu');
    toggle(this.refs.serverStatus, true);

    fill(this.refs.playersOnline, UNKNOWN);
    this.paintSegments(0);
  }

  /**
   * Huit segments : pleins jusqu'au taux d'occupation, un segment intermédiaire
   * pour la fraction entamée, éteints ensuite.
   * @param {number} ratio occupation du serveur, 0 → 1
   */
  paintSegments(ratio) {
    const host = this.refs.segments;
    if (!host) return;

    const filled = Math.max(0, Math.min(1, ratio)) * SEGMENTS;
    const full = Math.floor(filled);
    const partial = filled - full >= 0.25 ? full : -1;

    Array.from(host.children).forEach((segment, index) => {
      const lit = index < full;
      const mid = index === partial;
      segment.classList.toggle('opm-tile__seg--on', lit);
      segment.classList.toggle('opm-tile__seg--mid', mid);
      segment.classList.toggle('opm-tile__seg--off', !lit && !mid);
    });
  }

  /** Tuile du prochain événement RP. */
  paintEvent() {
    if (!this.event?.starts_at) {
      fill(this.refs.eventCountdown, UNKNOWN);
      fill(this.refs.eventName, 'Aucun événement annoncé');
      return;
    }

    fill(this.refs.eventName, this.event.title ?? '');
    this.tickCountdown();
  }

  /** Une seconde de plus vers le prochain événement. */
  tickCountdown() {
    if (!this.event?.starts_at) return;

    const text = countdown(this.event.starts_at, { past: 'EN COURS' });
    fill(this.refs.eventCountdown, text || UNKNOWN);

    // L'échéance est passée : le serveur a peut-être déjà annoncé la suivante.
    if (text === 'EN COURS') this.loadEvent(TILES_INTERVAL);
  }

  /**
   * Tuile des votes du mois.
   * @param {Object|null} votes
   */
  paintVotes(votes) {
    if (!votes) {
      fill(this.refs.votesCount, UNKNOWN);
      fill(this.refs.votesGoal, '');
      fill(this.refs.votesReward, UNKNOWN);
      return;
    }

    fill(this.refs.votesCount, typeof votes.count === 'number' ? nf(votes.count) : UNKNOWN);
    fill(this.refs.votesGoal, typeof votes.goal === 'number' ? `/ ${nf(votes.goal)}` : '');
    fill(
      this.refs.votesReward,
      votes.reward ? String(votes.reward).toLocaleUpperCase('fr-FR') : UNKNOWN,
    );
  }

  /** Scène : skin du joueur, pseudo et sous-titre. */
  paintPlayer() {
    const account = this.account;

    fill(this.refs.playerName, account?.username ?? '');
    fill(this.refs.playerSub, this.playerSub(account));

    if (!this.refs.character) return;

    const seq = ++this.skinSeq;
    if (!account?.skin_url) {
      this.refs.character.src = DEFAULT_CHARACTER;
      return;
    }

    // La maquette montre un personnage EN PIED sur 404 px de haut : on compose
    // donc le corps entier du skin (16 × 32 unités), jamais une tête carrée que
    // la feuille de style étirerait en cube de 404 px de côté. Ce rendu 2D est
    // toujours produit : il couvre l'attente de la 3D, et la remplace là où
    // WebGL fait défaut.
    bodyDataUrl(account.skin_url, { model: account.minecraft?.model ?? null }).then((source) => {
      // Un changement de compte pendant le rendu annule le résultat périmé.
      if (seq !== this.skinSeq || !this.refs.character) return;
      this.refs.character.src = source;
    });

    this.paintPlayer3d(account, seq);
  }

  /* ----------------------------------------------------------- scène 3D */

  /**
   * Le personnage en 3D : skin complet, tête aux pieds, animé et en rotation
   * lente, comme sur la page de profil du site — mais en pied, là où le site
   * ne montre qu'un buste.
   *
   * Tout échec est silencieux et définitif pour la session (`viewerBroken`) :
   * le rendu 2D, toujours produit par `paintPlayer()`, reste alors seul en
   * place. On ne réessaie pas à chaque changement de compte : une machine sans
   * WebGL n'en aura pas plus la seconde fois.
   *
   * @param {Object|null} account
   * @param {number} seq  jeton de `paintPlayer()` — un compte changé entre-temps
   *   rend le résultat périmé
   */
  async paintPlayer3d(account, seq) {
    const canvas = this.refs.character3d;
    if (!canvas || this.viewerBroken || typeof window.skinview3d === 'undefined') return;

    if (!account?.skin_url) {
      this.showCharacter3d(false);
      return;
    }

    let image;
    try {
      // La même texture que le rendu 2D, déjà en mémoire et lisible : pas de
      // second téléchargement, pas de question d'origine.
      image = await skinImage(account.skin_url);
    } catch {
      this.showCharacter3d(false);
      return;
    }
    if (seq !== this.skinSeq) return;

    try {
      const viewer = this.ensureViewer(canvas);
      await viewer.loadSkin(image);
      if (seq !== this.skinSeq) return;
      this.showCharacter3d(true);
    } catch (error) {
      console.warn('opm : rendu 3D du personnage indisponible, repli sur le rendu 2D.', error);
      this.viewerBroken = true;
      this.disposeViewer();
      this.showCharacter3d(false);
    }
  }

  /**
   * Crée la scène une seule fois. Les réglages sont ceux du site (animation
   * de repos, rotation lente, zoom et déplacement à la souris désactivés),
   * moins le cadrage buste : ici on veut le personnage entier.
   *
   * @param {HTMLCanvasElement} canvas
   * @returns {any}
   */
  ensureViewer(canvas) {
    if (this.viewer) return this.viewer;

    const lib = window.skinview3d;
    const box = canvas.getBoundingClientRect();
    const viewer = new lib.SkinViewer({
      canvas,
      width: Math.max(1, Math.round(box.width) || 360),
      height: Math.max(1, Math.round(box.height) || 404),
    });

    // Cadrage en pied, réglé à l'œil sur un canevas de 360 × 404 : la tête
    // frôle le haut, les pieds gardent une marge en bas pour le balancement de
    // l'animation de repos. En dessous de 1.0 le personnage flotte au milieu
    // d'un vide ; au-dessus de 1.2 les mains sortent du cadre en rotation.
    viewer.fov = 40;
    viewer.zoom = 1.15;

    viewer.animation = new lib.IdleAnimation();
    viewer.animation.speed = 0.6;
    viewer.autoRotate = true;
    viewer.autoRotateSpeed = 0.35;

    if (viewer.controls) {
      // On peut faire tourner le personnage à la souris ; ni zoomer, ni le
      // sortir du cadre.
      viewer.controls.enableZoom = false;
      viewer.controls.enablePan = false;
    }

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      viewer.autoRotate = false;
      viewer.animation.paused = true;
    }

    // La scène change de taille avec la fenêtre : le canevas suit.
    if (typeof ResizeObserver === 'function') {
      this.viewerResize = new ResizeObserver(() => {
        const rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          viewer.width = Math.round(rect.width);
          viewer.height = Math.round(rect.height);
        }
      });
      this.viewerResize.observe(canvas);
    }

    this.viewer = viewer;
    return viewer;
  }

  /**
   * Bascule entre le canevas 3D et l'image 2D : un seul des deux est visible.
   * @param {boolean} live
   */
  showCharacter3d(live) {
    if (this.refs.character3d) this.refs.character3d.hidden = !live;
    if (this.refs.character) this.refs.character.hidden = live;
  }

  /** Libère la scène WebGL et son observateur de taille. */
  disposeViewer() {
    if (this.viewerResize) {
      this.viewerResize.disconnect();
      this.viewerResize = null;
    }
    if (this.viewer) {
      try {
        this.viewer.dispose();
      } catch {
        /* rien à rattraper : on abandonne la scène de toute façon */
      }
      this.viewer = null;
    }
  }

  /**
   * Sous-titre de l'identité — « Pirate · Équipage Les Cœurs Brisés · 3 îles
   * tenues » : la ligne RP de la maquette, composée des champs réels de la
   * fiche du joueur (`users.faction`, `users.equipage`, comptage sur `iles`,
   * docs/DATA.md § 1). On ne retombe sur le pseudo en jeu que si le serveur
   * n'a fourni aucun de ces champs, et le motif de blocage garde la priorité :
   * savoir pourquoi on ne peut pas embarquer prime sur son identité RP.
   *
   * @param {Object|null} account
   * @returns {string}
   */
  playerSub(account) {
    if (!account) return 'Aucun compte connecté';
    if (account.can_play === false) {
      // Le titre court vient du module partagé : c'est la même phrase que la
      // barre du bas, les Paramètres et l'écran de connexion, et jamais le code
      // brut du serveur (docs/API.md §1.2).
      return blockedLabel(account.blocked_reason).title;
    }

    const rp = this.roleplaySub(account.profile);
    if (rp) return rp;

    if (account.minecraft?.name) return `Pseudo en jeu · ${account.minecraft.name}`;
    return 'Compte One Piece Minecraft';
  }

  /**
   * Assemble la ligne RP à partir de la fiche du compte. Chaque morceau absent
   * disparaît au lieu d'être remplacé par une valeur de confort : une fiche
   * vide rend une chaîne vide, et l'appelant choisit alors un autre libellé.
   *
   * @param {Object|null|undefined} profile fiche RP (docs/API.md § 1.2)
   * @returns {string} chaîne vide si la fiche n'apporte rien
   */
  roleplaySub(profile) {
    if (!profile || typeof profile !== 'object') return '';

    const faction = typeof profile.faction === 'string' ? profile.faction.trim() : '';
    const equipage = typeof profile.equipage === 'string' ? profile.equipage.trim() : '';
    const iles = Number.isFinite(profile.iles_tenues) ? Math.max(0, Math.trunc(profile.iles_tenues)) : 0;

    return [
      faction || null,
      // Le nom d'équipage est un texte libre de la base du site : on l'appose
      // tel quel plutôt que de lui fabriquer un article qui sonnerait faux.
      equipage ? `Équipage ${equipage}` : null,
      iles > 0 ? `${nf(iles)} ${iles > 1 ? 'îles tenues' : 'île tenue'}` : null,
    ].filter(Boolean).join(' · ');
  }

  /* --------------------------------------------------------------- liens */

  /**
   * Ouvre une adresse dans le navigateur du système.
   * @param {string|null|undefined} url
   */
  async open(url) {
    if (typeof url !== 'string' || url === '') return;

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
  }
}
