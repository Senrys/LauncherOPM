/**
 * Barre du bas — compte, progression, console, lancement automatique, JOUER.
 *
 * C'est le poste de pilotage du lancement : tout ce qu'elle affiche vient de
 * données réelles, jamais d'une simulation.
 *
 *  - le bloc compte lit `window.opm.auth` (avatar = tête de skin rendue par
 *    `utils/skin.js`, pseudo, sous-titre) et ouvre le popover des comptes ;
 *  - le bloc d'état est piloté par les événements `game:event` : jauge,
 *    pourcentage, ligne de détail (fichiers, octets et vitesse réels) ;
 *  - le bouton DÉTAILS ouvre la console, alimentée par `log:line` ;
 *  - la case LANCEMENT AUTO est persistée dans `config.launcher.auto_launch` ;
 *  - le bouton ANNULER n'apparaît que pendant la préparation des fichiers et
 *    appelle `game.cancel()` : c'est la seule sortie d'un téléchargement lancé
 *    par erreur. Il reste inactif pendant une vérification des fichiers, que le
 *    processus principal ne sait pas interrompre — un bouton qui ne peut rien
 *    faire le dit plutôt que de le laisser croire ;
 *  - le bouton JOUER porte les quatre états prévus par la maquette et refuse
 *    le lancement quand `account.can_play` est faux, en disant pourquoi.
 *
 * Aucune sélection par classe CSS : uniquement des attributs `data-*`, plus
 * deux relations structurelles (le pied de page qui porte le bouton JOUER, et
 * la bande lumineuse enfant du remplissage de la jauge).
 */

import { $, delegate, on, setText, toggle } from '../utils/dom.js';
import { bytes, duration, nf, pct, relTime, speed } from '../utils/format.js';
import { blockedLabel, errorLabel } from '../utils/labels.js';
import { GAME_IDLE, LOG_LIMIT, store } from '../utils/state.js';
import { headDataUrl } from '../utils/skin.js';
import { Popover } from '../components/popover.js';
import { toast } from '../components/toast.js';

/** Classes d'état du bouton JOUER — posées une à la fois. */
const PLAY_MODIFIERS = [
  'opm-bottom__play--ready',
  'opm-bottom__play--busy',
  'opm-bottom__play--maint',
];

/** États du jeu pendant lesquels la mise à jour travaille. */
const WORKING = new Set(['check', 'download', 'extract', 'patch']);

/**
 * Traduction des six phases de la barre. Les quatre apparences du bouton JOUER
 * de docs/UI-SPEC.md §4.6 y sont réparties : « prêt », « occupé »,
 * « maintenance », et « lancement » (l'apparence prête, rendue inactive).
 *
 * `JEU EN COURS` n'est pas dans la liste de l'UI-SPEC : cet état n'existe que
 * lorsque le joueur a désactivé « fermer le launcher au lancement », auquel cas
 * la barre doit nommer ce qu'elle montre au lieu de mentir.
 */
const PHASES = {
  ready: { modifier: 'opm-bottom__play--ready', label: 'JOUER', kicker: 'VOTRE JEU EST À JOUR', playable: true },
  busy: { modifier: 'opm-bottom__play--busy', label: 'PATIENTEZ', kicker: 'MISE À JOUR EN COURS', playable: false },
  launching: { modifier: 'opm-bottom__play--ready', label: 'LANCEMENT…', kicker: 'LANCEMENT DU JEU', playable: false },
  running: { modifier: 'opm-bottom__play--ready', label: 'EN JEU', kicker: 'JEU EN COURS', playable: false },
  maintenance: { modifier: 'opm-bottom__play--maint', label: 'INDISPONIBLE', kicker: 'MAINTENANCE EN COURS', playable: false },
  blocked: { modifier: 'opm-bottom__play--maint', label: 'INDISPONIBLE', kicker: 'CONNEXION REQUISE', playable: false },
};

/**
 * Motifs de blocage et messages d'erreur : la barre n'a plus de table à elle.
 * Tout vient de `utils/labels.js` — `blockedLabel(reason)` pour un compte qui ne
 * peut pas jouer (sa phrase pour la ligne de détail, son titre court pour la
 * liste des comptes), `errorLabel(code, repli)` pour un appel qui a échoué.
 */

/**
 * Horodatage d'une ligne de journal, au format de la console : « [12:04:51] ».
 * `utils/format.js` ne propose pas d'heure seule ; la conversion reste locale.
 *
 * @param {string} iso
 * @returns {string}
 */
function stamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const two = (value) => String(value).padStart(2, '0');
  return `[${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}] `;
}

export default class Bottombar {
  static id = 'bottombar';

  constructor() {
    /** Points d'ancrage du balisage, résolus par `mount()`. */
    this.refs = {};
    /** @type {Array<() => void>} désabonnements posés par `init()` */
    this.offs = [];

    /** @type {Object} avancement du jeu, alimenté par `game:event` */
    this.game = { ...GAME_IDLE };
    /** @type {Array<Object>} comptes connus localement */
    this.accounts = [];
    /** @type {Object|null} compte sélectionné */
    this.account = null;
    /** @type {Object|null} configuration locale */
    this.config = null;
    /** @type {Object|null} `bootstrap.maintenance` */
    this.maintenance = null;
    /** le serveur d'authentification répond */
    this.online = true;
    /** @type {{files: number, bytes: number, checked_at: string}|null} */
    this.files = null;

    /** @type {string[]} lignes de console déjà mises en forme */
    this.logs = [];
    /** Rendu de la console différé à la frame suivante. */
    this.consolePainting = false;

    /**
     * Verrou de lancement. Il est pris AVANT toute attente, dans la même
     * instruction synchrone que son test, et n'est relâché qu'à la fin réelle du
     * travail — l'événement `closed` ou `error` du processus principal.
     *
     * Le relâcher dans un `finally` ne protégeait de rien : `game.launch()` rend
     * la main dès que la bibliothèque a pris le relais, c'est-à-dire avant même
     * le téléchargement. Le seul filet restant était alors le verrou du
     * processus principal, qui répond `already_running` — une erreur affichée au
     * joueur pour un geste dont il n'est pas responsable.
     */
    this.launching = false;

    /**
     * Travail que le processus principal exécute en ce moment :
     *   'launch'  — demandé par le bouton JOUER de cette barre ;
     *   'verify'  — vérification des fichiers demandée ailleurs (Paramètres) ;
     *   null      — rien en cours.
     *
     * La distinction n'est pas cosmétique : `game.cancel()` ne sait renoncer
     * qu'à une PRÉPARATION DE LANCEMENT. Pendant une vérification, il accepte la
     * demande et ne l'applique jamais — le bouton ANNULER prétendrait alors
     * interrompre quelque chose qui ira jusqu'au bout.
     * @type {'launch'|'verify'|null}
     */
    this.work = null;

    /** Une annulation a déjà été demandée pour le travail en cours. */
    this.cancelRequested = false;
    /** Le lancement automatique n'a lieu qu'une fois par session. */
    this.autoLaunched = false;
    /** Numéro de la dernière demande d'avatar, pour ignorer les rendus périmés. */
    this.avatarSeq = 0;
    /** Skin déjà posé dans l'avatar — évite un rendu par événement de progression. */
    this.avatarKey = null;
    /** @type {Object|null} contexte fourni par le renderer */
    this.ctx = null;

    /** @type {Popover|null} */
    this.accountsPopover = null;
    /** @type {Popover|null} */
    this.consolePopover = null;
  }

  /**
   * Câble la barre. Appelable plusieurs fois : les abonnements précédents sont
   * relâchés avant d'en poser de nouveaux.
   * @param {{root?: ParentNode}} [ctx]
   */
  async init(ctx = {}) {
    this.dispose();
    this.ctx = ctx;

    if (!window.opm) {
      console.error('opm : pont du processus principal absent, barre du bas inerte.');
      return;
    }

    const root = ctx.root instanceof Element || ctx.root instanceof Document ? ctx.root : document;
    this.mount(root);
    if (!this.refs.play) {
      console.error('opm : barre du bas absente du document.');
      return;
    }

    this.wire();
    this.readStore(store.get());

    this.offs.push(store.subscribe((state, changed) => {
      const watched = ['accounts', 'account', 'config', 'maintenance', 'bootstrap', 'online', 'screen'];
      if (!watched.some((key) => changed.has(key))) return;
      this.readStore(state);
      this.render();
    }));

    this.offs.push(window.opm.auth.onChange((accounts, current) => {
      this.accounts = Array.isArray(accounts) ? accounts : [];
      this.account = current ?? null;
      this.render();
    }));

    this.offs.push(window.opm.game.on((event) => this.onGameEvent(event)));
    this.offs.push(window.opm.log.on((line) => this.pushLog(line)));

    this.render();
    await Promise.all([this.loadAccounts(), this.loadConfig(), this.loadFiles(), this.loadLogs(), this.loadRunning()]);
    this.render();
  }

  /**
   * La barre du bas fait partie de la coque : elle reste montée en permanence.
   * Les deux méthodes du contrat des panneaux n'ont donc rien à commuter.
   */
  async show() {}

  async hide() {}

  /** Relâche abonnements et popovers. */
  dispose() {
    for (const off of this.offs) off();
    this.offs = [];

    if (this.accountsPopover) this.accountsPopover.destroy();
    if (this.consolePopover) this.consolePopover.destroy();
    this.accountsPopover = null;
    this.consolePopover = null;
  }

  /* --------------------------------------------------------- ancrage DOM */

  /**
   * Résout tous les points d'ancrage. Les deux emplacements `player-name` du
   * document (barre du bas et scène de l'accueil) sont départagés en cherchant
   * à l'intérieur du bouton de compte.
   * @param {ParentNode} root
   */
  mount(root) {
    const accountButton = $('[data-el="account-button"]', root);
    const play = $('[data-el="play"]', root);
    const fill = $('[data-el="progress-fill"]', root);

    this.refs = {
      accountButton,
      avatar: accountButton ? $('[data-el="account-avatar"]', accountButton) : null,
      playerName: accountButton ? $('[data-bind="player-name"]', accountButton) : null,
      playerStatus: accountButton ? $('[data-bind="player-status"]', accountButton) : null,

      kicker: $('[data-bind="status-kicker"]', root),
      progress: $('[data-el="progress"]', root),
      fill,
      // La bande lumineuse n'a pas d'ancrage propre : c'est l'unique enfant du
      // remplissage de la jauge.
      shimmer: fill ? fill.firstElementChild : null,
      percent: $('[data-bind="progress-pct"]', root),
      line: $('[data-bind="status-line"]', root),

      detailsButton: $('[data-el="details-button"]', root),
      logChevron: $('[data-bind="log-chevron"]', root),
      consolePanel: $('[data-el="popover-console"]', root),
      console: $('[data-el="console"]', root),

      accountsPanel: $('[data-el="popover-accounts"]', root),
      accountList: $('[data-el="account-list"]', root),
      accountTemplate: $('[data-el="tpl-account-item"]', root),

      auto: $('[data-el="auto-launch"]', root),
      cancel: $('[data-el="cancel-launch"]', root),
      play,
    };
  }

  /** Branche les commandes de la barre et des deux popovers. */
  wire() {
    const { accountButton, accountsPanel, detailsButton, consolePanel, accountList, auto, cancel, play } = this.refs;

    if (accountButton && accountsPanel) {
      this.accountsPopover = new Popover(accountButton, accountsPanel, {
        // La liste est reconstruite à chaque ouverture : elle montre toujours
        // les comptes réellement connus au moment du clic.
        onOpen: () => this.paintAccountList(),
      });
      this.offs.push(on(accountButton, 'click', () => this.accountsPopover.toggle()));
    }

    if (detailsButton && consolePanel) {
      this.consolePopover = new Popover(detailsButton, consolePanel, {
        onOpen: () => {
          this.paintChevron(true);
          this.paintConsole();
        },
        onClose: () => this.paintChevron(false),
      });
      this.offs.push(on(detailsButton, 'click', () => this.consolePopover.toggle()));
      this.paintChevron(false);
    }

    if (accountList) {
      this.offs.push(delegate(accountList, 'click', '[data-action="select-account"]', (event, item) => {
        this.selectAccount(item.dataset.id);
      }));
    }

    if (accountsPanel) {
      const add = $('[data-action="add-account"]', accountsPanel);
      const logout = $('[data-action="logout"]', accountsPanel);
      if (add) this.offs.push(on(add, 'click', () => this.addAccount()));
      if (logout) this.offs.push(on(logout, 'click', () => this.logout()));
    }

    if (auto) {
      // `change` plutôt que `click` : la case reste pilotable au clavier et par
      // le libellé qui l'entoure.
      this.offs.push(on(auto, 'change', () => this.setAutoLaunch(auto.checked)));
    }

    if (cancel) this.offs.push(on(cancel, 'click', () => this.cancel()));

    if (play) this.offs.push(on(play, 'click', () => this.play()));
  }

  /* ------------------------------------------------------- chargements */

  /** Comptes connus et compte sélectionné. */
  async loadAccounts() {
    try {
      const [accounts, current] = await Promise.all([
        window.opm.auth.list(),
        window.opm.auth.current(),
      ]);
      this.accounts = Array.isArray(accounts) ? accounts : [];
      this.account = current ?? null;
    } catch (error) {
      console.error('opm : liste des comptes indisponible.', error);
    }
  }

  /** Configuration locale (case LANCEMENT AUTO, mémoire allouée). */
  async loadConfig() {
    if (this.config) return;

    try {
      this.config = await window.opm.config.get();
      store.set({ config: this.config });
    } catch (error) {
      console.error('opm : configuration locale illisible.', error);
    }
  }

  /** État des fichiers du jeu — sert de ligne de détail au repos. */
  async loadFiles() {
    try {
      this.files = await window.opm.game.filesStat();
    } catch (error) {
      // Première installation, ou dossier de jeu absent : la ligne le dira.
      this.files = null;
      console.warn('opm : état des fichiers du jeu inconnu.', error);
    }
  }

  /** Historique de la console, pour ne pas ouvrir un journal vide. */
  async loadLogs() {
    try {
      const history = await window.opm.log.history();
      if (!Array.isArray(history)) return;

      this.logs = history.map((line) => `${stamp(line.ts)}${line.text}`).slice(-LOG_LIMIT);
      this.paintConsole();
    } catch (error) {
      console.warn('opm : historique du journal indisponible.', error);
    }
  }

  /** Le jeu tourne peut-être déjà (launcher rouvert pendant une partie). */
  async loadRunning() {
    try {
      if (await window.opm.game.isRunning()) {
        this.setGame({ state: 'running', ratio: 1, running: true });
      }
    } catch (error) {
      console.warn('opm : état d\'exécution du jeu inconnu.', error);
    }
  }

  /**
   * Recopie ce que le renderer a publié dans le magasin.
   *
   * L'ABSENCE est une information, et elle se propage : une liste vide reste
   * vide, un compte `null` reste `null`. Ne recopier que les valeurs « pleines »
   * revenait à s'interdire d'effacer — après la déconnexion du dernier compte,
   * la barre gardait le pseudo, l'avatar et un `can_play` périmé, et le bouton
   * JOUER pouvait rester actif sans aucun compte. Elle ne s'en sortait que parce
   * que son propre `auth.onChange` écrit avant le magasin, un ordre d'exécution
   * qu'aucun contrat ne garantit.
   *
   * @param {Object} state
   */
  readStore(state) {
    this.accounts = Array.isArray(state.accounts) ? state.accounts : [];
    this.account = state.account ?? null;
    if (state.config) this.config = state.config;
    this.maintenance = state.maintenance ?? state.bootstrap?.maintenance ?? null;
    this.online = state.online !== false;
  }

  /* ------------------------------------------------------ événements jeu */

  /**
   * Fusionne un changement d'avancement et redessine.
   *
   * La barre garde sa propre lecture des événements ; la publication de
   * `store.game` reste au renderer, qui les traduit déjà pour l'ensemble du
   * launcher (barre des tâches comprise).
   *
   * @param {Object} patch
   */
  setGame(patch) {
    this.game = { ...GAME_IDLE, ...patch };
    this.render();
  }

  /**
   * Traduit un `GameEvent` (docs/IPC.md) en état d'affichage.
   * @param {Object} event
   */
  onGameEvent(event) {
    if (!event || typeof event.type !== 'string') return;

    // Un travail commence alors que le bouton JOUER n'a rien demandé : la seule
    // autre source d'événements est la vérification des fichiers des Paramètres.
    // Le savoir permet de ne pas offrir une annulation qui n'aurait aucun effet.
    if (this.work === null && event.type !== 'closed' && event.type !== 'error') {
      this.work = 'verify';
    }

    const ratio = (progress, size) => (size > 0 ? Math.min(1, Math.max(0, progress / size)) : 0);

    switch (event.type) {
      case 'check':
        this.setGame({
          state: 'check',
          progress: event.progress ?? 0,
          size: event.size ?? 0,
          ratio: ratio(event.progress ?? 0, event.size ?? 0),
        });
        break;

      case 'progress':
        this.setGame({
          state: 'download',
          progress: event.progress ?? 0,
          size: event.size ?? 0,
          ratio: ratio(event.progress ?? 0, event.size ?? 0),
          speed: event.speed_bps ?? 0,
          eta: event.eta_s ?? 0,
        });
        break;

      case 'extract':
        this.setGame({ ...this.game, state: 'extract', message: event.file ?? '' });
        break;

      case 'patch':
        this.setGame({ ...this.game, state: 'patch', message: event.message ?? '' });
        break;

      case 'launching':
        this.setGame({ state: 'launching', ratio: 1 });
        break;

      case 'running':
        this.setGame({ state: 'running', ratio: 1, running: true });
        break;

      case 'closed': {
        // Une vérification se termine aussi par `closed` : dire « le jeu s'est
        // fermé » d'un jeu qui n'a jamais démarré serait faux.
        const verified = this.work === 'verify';
        this.releaseLaunch();

        this.setGame({
          state: 'closed',
          ratio: 1,
          message: verified
            ? 'Vérification des fichiers terminée.'
            : (event.code === 0
              ? 'Le jeu s\'est fermé.'
              : `Le jeu s'est arrêté (code ${event.code}).`),
        });
        // Les fichiers viennent d'être vérifiés puis joués : on rafraîchit le
        // décompte affiché au repos.
        this.loadFiles().then(() => this.render());
        break;
      }

      case 'error':
        // Le renderer annonce déjà l'erreur au joueur : la barre se contente de
        // reprendre la main et d'afficher le message dans sa ligne de détail.
        this.releaseLaunch();
        this.setGame({ state: 'error', message: event.message ?? '' });
        break;

      default:
        break;
    }
  }

  /* ------------------------------------------------------------- console */

  /**
   * Empile une ligne de journal et rafraîchit la console si elle est ouverte.
   * @param {{ts: string, level: string, text: string}} line
   */
  pushLog(line) {
    if (!line || typeof line.text !== 'string') return;

    this.logs.push(`${stamp(line.ts)}${line.text}`);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);

    if (!this.consolePopover?.isOpen || this.consolePainting) return;

    // Une mise à jour par frame : le journal peut arriver par rafales.
    this.consolePainting = true;
    requestAnimationFrame(() => {
      this.consolePainting = false;
      this.paintConsole();
    });
  }

  /** Écrit les lignes et colle la vue au bas du journal. */
  paintConsole() {
    const node = this.refs.console;
    if (!node || !this.consolePopover?.isOpen) return;

    node.textContent = this.logs.join('\n');
    node.scrollTop = node.scrollHeight;
  }

  /**
   * Le chevron pointe vers l'endroit où ira le panneau : vers le haut quand la
   * console est fermée (elle s'ouvre au-dessus), vers le bas quand elle est
   * ouverte (le prochain clic la referme).
   * @param {boolean} open
   */
  paintChevron(open) {
    setText(this.refs.logChevron, open ? '▾' : '▴');
  }

  /* -------------------------------------------------------------- compte */

  /**
   * Change de compte sélectionné.
   * @param {string|undefined} id
   */
  async selectAccount(id) {
    if (!id || id === this.account?.id) {
      this.accountsPopover?.close();
      return;
    }

    try {
      const account = await window.opm.auth.select(id);
      this.account = account ?? this.account;
      this.accountsPopover?.close();
      this.render();
    } catch (error) {
      toast({
        kind: 'error',
        title: 'Changement de compte impossible',
        message: errorLabel(error?.code, error?.message).message,
      });
    }
  }

  /**
   * Renvoie le joueur à l'écran de connexion pour ajouter un compte.
   *
   * L'intention est ÉMISE, jamais écrite dans le magasin : `screen` n'appartient
   * qu'au renderer, dont `setScreen()` sort immédiatement si la clé porte déjà
   * la valeur visée. L'écrire ici masquerait l'écran de connexion pour de bon —
   * y compris après une déconnexion. C'est l'écran de connexion lui-même qui
   * écoute `opm:request-login` et se montre en surimpression, exactement comme
   * pour le même bouton des paramètres.
   */
  addAccount() {
    this.accountsPopover?.close();

    if (typeof this.ctx?.setLoginView === 'function') this.ctx.setLoginView('login');
    document.dispatchEvent(new CustomEvent('opm:request-login', { detail: { view: 'login' } }));
  }

  /** Déconnecte le compte courant. */
  async logout() {
    this.accountsPopover?.close();

    try {
      await window.opm.auth.logout(this.account?.id);
      const accounts = await window.opm.auth.list();
      this.accounts = Array.isArray(accounts) ? accounts : [];
      this.account = await window.opm.auth.current();

      // Le renderer décide de l'écran à présenter après une déconnexion ; à
      // défaut, on réclame l'écran de connexion par le même événement que
      // « + AJOUTER UN COMPTE » — jamais en écrivant `screen` dans le magasin.
      if (typeof this.ctx?.route === 'function') this.ctx.route();
      else if (!this.account) {
        document.dispatchEvent(new CustomEvent('opm:request-login', { detail: { view: 'login' } }));
      }

      this.render();
    } catch (error) {
      toast({
        kind: 'error',
        title: 'Déconnexion impossible',
        message: errorLabel(error?.code, error?.message).message,
      });
    }
  }

  /**
   * Persiste la case LANCEMENT AUTO.
   * @param {boolean} enabled
   */
  async setAutoLaunch(enabled) {
    try {
      this.config = await window.opm.config.set({ launcher: { auto_launch: Boolean(enabled) } });
      store.set({ config: this.config });
    } catch (error) {
      // La case reprend la valeur réellement enregistrée.
      if (this.refs.auto) this.refs.auto.checked = Boolean(this.config?.launcher?.auto_launch);
      toast({
        kind: 'error',
        title: 'Réglage non enregistré',
        message: errorLabel(error?.code, error?.message).message,
      });
    }
  }

  /* ------------------------------------------------------------ lancement */

  /** Nom de l'instance à lancer, tel que choisi ailleurs dans le launcher. */
  instanceName() {
    return store.get().instance ?? this.config?.instance_selected ?? undefined;
  }

  /**
   * Lance le jeu si, et seulement si, tout est prêt.
   *
   * Le verrou est pris dans la même instruction synchrone que son test, avant
   * tout `await` : deux clics arrivés dans la même micro-tâche — ou le clic
   * manuel qui croise le lancement automatique, tous deux déclenchés depuis
   * `render()` — ne peuvent pas le franchir ensemble. Il n'est relâché qu'à la
   * fin réelle du travail (`closed`, `error`), et non au retour de l'appel.
   */
  async play() {
    if (this.launching || this.phase() !== 'ready') return;

    this.launching = true;
    this.work = 'launch';
    this.cancelRequested = false;

    // Le bouton bascule immédiatement : les événements du processus principal
    // prennent le relais dès la première vérification de fichiers.
    this.setGame({ state: 'launching', ratio: 1 });

    try {
      await window.opm.game.launch(this.instanceName());
    } catch (error) {
      // `already_running` n'est pas une erreur du joueur : le processus principal
      // tient le même verrou et vient d'écarter un doublon. Aucun message — mais
      // on se recale sur son état réel plutôt que de laisser le bouton sur
      // « LANCEMENT… » pour un travail qui n'est pas le nôtre.
      if (error?.code === 'already_running') {
        await this.resyncBusy();
        return;
      }

      this.releaseLaunch();
      const label = errorLabel(error?.code, error?.message);

      this.setGame({ ...GAME_IDLE, state: 'error', message: label.message });
      toast({ kind: 'error', title: 'Lancement impossible', message: label.message });
    }
  }

  /** Rend le bouton JOUER après la fin — ou l'échec — d'un travail. */
  releaseLaunch() {
    this.launching = false;
    this.work = null;
    this.cancelRequested = false;
  }

  /**
   * Demande au processus principal s'il travaille vraiment, et se recale.
   *
   * Appelée après un `already_running` : si un travail est bien en cours, ses
   * événements pilotent la barre et le verrou reste pris jusqu'à sa fin. S'il
   * n'y en a plus (il s'est achevé entre le clic et l'appel), le bouton doit
   * redevenir cliquable au lieu de rester sur un « LANCEMENT… » qui n'attend
   * plus rien.
   */
  async resyncBusy() {
    let busy = false;

    try {
      busy = await window.opm.game.isRunning();
    } catch (error) {
      console.warn('opm : état d\'exécution du jeu inconnu.', error);
    }

    if (busy) {
      // Le travail en cours n'est pas le nôtre : notre lancement vient d'être
      // refusé. La seule autre source est la vérification des fichiers, qui ne
      // s'annule pas — le bouton ANNULER ne doit donc pas s'offrir.
      this.work = 'verify';
      this.render();
      return;
    }

    this.releaseLaunch();
    // On ne réécrit que notre propre affichage optimiste : un état plus récent
    // (« le jeu s'est fermé ») arrivé entre-temps a le dernier mot.
    if (this.game.state === 'launching') this.setGame({ ...GAME_IDLE });
    else this.render();
  }

  /**
   * Renonce à la préparation en cours.
   *
   * Sans ce bouton, le joueur qui lance par erreur un téléchargement de plusieurs
   * gigaoctets n'a d'autre issue que de tuer le launcher — qui n'a alors plus la
   * main pour clore proprement la session de jeu ouverte côté serveur.
   *
   * Il ne renonce QU'À UNE PRÉPARATION DE LANCEMENT. Une vérification des
   * fichiers va jusqu'au bout par construction (le processus principal accepte
   * la demande mais ne l'applique pas) : le bouton est alors désactivé et le dit,
   * au lieu de prétendre interrompre ce qui ne s'interrompt pas.
   */
  async cancel() {
    if (this.work !== 'launch' || this.cancelRequested) return;

    this.cancelRequested = true;
    this.render();

    try {
      const accepted = await window.opm.game.cancel();

      // Le jeu a démarré entre le clic et l'appel : il n'y a plus rien à annuler.
      if (accepted === false) {
        this.cancelRequested = false;
        this.render();
        toast({
          kind: 'info',
          title: 'Annulation impossible',
          message: 'Le jeu a déjà démarré : fermez-le pour revenir au launcher.',
        });
      }
    } catch (error) {
      this.cancelRequested = false;
      this.render();
      toast({
        kind: 'error',
        title: 'Annulation impossible',
        message: errorLabel(error?.code, error?.message).message,
      });
    }
  }

  /* ---------------------------------------------------------------- rendu */

  /**
   * Phase courante de la barre, du plus urgent au plus calme.
   * @returns {'ready'|'busy'|'launching'|'running'|'maintenance'|'blocked'}
   */
  phase() {
    if (this.game.state === 'launching') return 'launching';
    if (this.game.running) return 'running';
    if (WORKING.has(this.game.state)) return 'busy';
    if (this.maintenance?.active) return 'maintenance';
    if (!this.online || !this.account || this.account.can_play === false) return 'blocked';
    return 'ready';
  }

  /** Redessine la barre entière. */
  render() {
    if (!this.refs.play) return;

    const phase = this.phase();
    const view = PHASES[phase];

    this.paintAccount();
    this.paintPlay(view, phase);
    this.paintProgress(phase);
    this.paintStatus(view, phase);

    this.paintCancel(phase);

    if (this.refs.auto) this.refs.auto.checked = Boolean(this.config?.launcher?.auto_launch);

    // Le popover reste juste tant qu'il est ouvert : un compte ajouté ou
    // déconnecté ailleurs se voit tout de suite.
    if (this.accountsPopover?.isOpen) this.paintAccountList();

    this.maybeAutoLaunch(phase);
  }

  /**
   * Bouton ANNULER : présent pendant toute la préparation des fichiers, actif
   * seulement quand il y a réellement quelque chose à interrompre.
   *
   * Le laisser cliquable pendant une vérification était le mensonge le plus
   * discret de la barre : l'appel réussissait, un message d'annulation
   * s'affichait, et la vérification se poursuivait jusqu'au bout.
   *
   * @param {string} phase
   */
  paintCancel(phase) {
    const button = this.refs.cancel;
    if (!button) return;

    toggle(button, phase === 'busy');
    if (phase !== 'busy') return;

    const cancellable = this.work === 'launch' && !this.cancelRequested;
    button.disabled = !cancellable;

    if (cancellable) {
      button.title = 'Renoncer à la préparation. Les fichiers déjà téléchargés sont conservés.';
    } else if (this.cancelRequested) {
      button.title = 'Annulation demandée : le jeu ne sera pas démarré.';
    } else {
      button.title = "Une vérification des fichiers ne s'interrompt pas : elle se termine seule.";
    }
  }

  /** Bouton de compte : tête de skin, pseudo, sous-titre. */
  paintAccount() {
    const account = this.account;

    setText(this.refs.playerName, account?.username ?? 'Aucun compte');
    setText(this.refs.playerStatus, this.accountStatusLine(account));

    if (!this.refs.avatar) return;

    // La barre se redessine à chaque événement de progression : le skin, lui,
    // ne change qu'au changement de compte.
    const key = `${account?.id ?? ''}|${account?.skin_url ?? ''}`;
    if (key === this.avatarKey) return;
    this.avatarKey = key;

    const seq = ++this.avatarSeq;
    headDataUrl(account?.skin_url ?? null, 128).then((source) => {
      // Un changement de compte pendant le rendu annule le résultat périmé.
      if (seq === this.avatarSeq && this.refs.avatar) this.refs.avatar.src = source;
    });
  }

  /**
   * Sous-titre du bouton de compte, à la manière de la maquette
   * (« COMPTE PRINCIPAL · EN LIGNE »), mais avec l'état réel du compte.
   * @param {Object|null} account
   * @returns {string}
   */
  accountStatusLine(account) {
    if (!account) return 'CONNEXION REQUISE';

    const rank = account.primary ? 'COMPTE PRINCIPAL' : 'COMPTE SECONDAIRE';

    if (!this.online) return `${rank} · HORS LIGNE`;
    if (account.can_play === false) {
      // `title` est la forme courte du motif : « Possession à revérifier ».
      return `${rank} · ${blockedLabel(account.blocked_reason).title.toLocaleUpperCase('fr-FR')}`;
    }
    return `${rank} · EN LIGNE`;
  }

  /**
   * Bouton JOUER : classe d'état, libellé, disponibilité.
   * @param {Object} view
   * @param {string} phase
   */
  paintPlay(view, phase) {
    const play = this.refs.play;

    play.classList.remove(...PLAY_MODIFIERS);
    play.classList.add(view.modifier);
    setText(play, view.label);
    play.disabled = !view.playable;

    // Le libellé porte déjà l'information ; le titre donne la raison exacte.
    if (phase === 'blocked' || phase === 'maintenance') play.title = this.statusLine(phase);
    else play.removeAttribute('title');
  }

  /**
   * Jauge, pourcentage et bande lumineuse.
   * @param {string} phase
   */
  paintProgress(phase) {
    // Au repos comme à l'arrêt, la jauge est pleine : c'est l'état « rien à
    // faire », pas une progression inventée.
    const ratio = phase === 'busy' ? this.game.ratio : 1;
    const percent = Math.round(ratio * 100);

    if (this.refs.fill) this.refs.fill.style.width = `${percent}%`;
    if (this.refs.progress) this.refs.progress.setAttribute('aria-valuenow', String(percent));

    setText(
      this.refs.percent,
      phase === 'maintenance' || phase === 'blocked' ? '—' : pct(ratio),
    );

    // La bande lumineuse ne court que pendant un téléchargement. La barre de
    // progression du système, elle, est pilotée par le renderer.
    toggle(this.refs.shimmer, phase === 'busy' && this.game.state === 'download');
  }

  /**
   * Kicker et ligne de détail.
   * @param {Object} view
   * @param {string} phase
   */
  paintStatus(view, phase) {
    const kicker = phase === 'ready' && !this.files?.files ? 'PRÊT À EMBARQUER' : view.kicker;
    setText(this.refs.kicker, kicker);
    setText(this.refs.line, this.statusLine(phase));
  }

  /**
   * Ligne de détail : ce que le launcher est réellement en train de faire.
   * @param {string} phase
   * @returns {string}
   */
  statusLine(phase) {
    const game = this.game;

    if (phase === 'maintenance') {
      const message = this.maintenance?.message
        ?? 'Le serveur est en maintenance : la mer rouvrira bientôt.';
      const eta = this.maintenance?.eta ? ` · retour ${relTime(this.maintenance.eta)}` : '';
      return `${message}${eta}`;
    }

    if (phase === 'blocked') {
      if (!this.account) return 'Connectez-vous à votre compte One Piece Minecraft pour embarquer.';
      if (!this.online) return 'Serveur d\'authentification injoignable : vérifiez votre connexion.';
      return blockedLabel(this.account.blocked_reason).message;
    }

    if (phase === 'running') return 'Minecraft est ouvert. Fermez le jeu pour pouvoir le relancer.';

    if (phase === 'launching') {
      const instance = this.instanceName();
      return ['Ouverture de Minecraft', instance, this.memoryLabel()].filter(Boolean).join(' · ');
    }

    if (phase === 'busy') {
      if (game.state === 'check') {
        return `Vérification des fichiers · ${nf(game.progress)} / ${nf(game.size)}`;
      }
      if (game.state === 'download') {
        const remaining = Math.max(0, game.size - game.progress);
        return [
          `${bytes(remaining)} à télécharger sur ${bytes(game.size)}`,
          speed(game.speed),
          game.eta > 0 ? `il reste ${duration(game.eta)}` : '',
        ].filter(Boolean).join(' · ');
      }
      if (game.state === 'extract') return `Extraction · ${game.message}`;
      return game.message || 'Application des correctifs…';
    }

    // Phase « prête » : selon ce qui vient de se passer.
    if (game.state === 'error' && game.message) return game.message;
    if (game.state === 'closed' && game.message) return game.message;

    if (this.files?.files) {
      return [
        `${nf(this.files.files)} fichiers vérifiés`,
        bytes(this.files.bytes),
        this.memoryLabel(),
      ].filter(Boolean).join(' · ');
    }
    return ['Les fichiers seront vérifiés au lancement', this.memoryLabel()].filter(Boolean).join(' · ');
  }

  /** « 7 Go alloués » — mémoire réellement réservée à Java. */
  memoryLabel() {
    const max = this.config?.java?.memory?.max;
    return typeof max === 'number' ? `${nf(max)} Go alloués` : '';
  }

  /**
   * Lance le jeu tout seul, une seule fois, si le joueur l'a demandé.
   * @param {string} phase
   */
  maybeAutoLaunch(phase) {
    if (this.autoLaunched || phase !== 'ready') return;
    if (!this.config?.launcher?.auto_launch) return;
    // Tant que le splash ou la connexion sont à l'écran, rien ne se lance.
    if (store.get().screen !== 'app') return;

    this.autoLaunched = true;
    this.play();
  }

  /* ---------------------------------------------------- popover comptes */

  /** Reconstruit la liste des comptes du popover. */
  paintAccountList() {
    const { accountList, accountTemplate } = this.refs;
    if (!accountList || !accountTemplate) return;

    accountList.replaceChildren();

    for (const account of this.accounts) {
      const item = accountTemplate.content.firstElementChild.cloneNode(true);
      item.dataset.id = account.id;

      const current = account.id === this.account?.id;
      if (current) item.setAttribute('aria-current', 'true');

      setText($('[data-bind="account-name"]', item), account.username ?? '');
      setText($('[data-bind="account-meta"]', item), this.accountMeta(account, current));

      const head = $('[data-el="account-head"]', item);
      if (head) headDataUrl(account.skin_url ?? null, 64).then((source) => { head.src = source; });

      accountList.append(item);
    }
  }

  /**
   * Mention de droite d'une ligne de compte : d'abord ce qui empêche de jouer,
   * puis le rôle du compte, enfin la validité de la session.
   * @param {Object} account
   * @param {boolean} current
   * @returns {string}
   */
  accountMeta(account, current) {
    if (account.can_play === false) {
      return blockedLabel(account.blocked_reason).title;
    }
    if (current) return 'Sélectionné';
    if (account.primary) return 'Principal';

    if (account.session_expires_at) {
      const expires = new Date(account.session_expires_at).getTime();
      if (Number.isFinite(expires)) {
        return expires > Date.now() ? `Session ${relTime(account.session_expires_at)}` : 'Session expirée';
      }
    }
    return '';
  }
}
