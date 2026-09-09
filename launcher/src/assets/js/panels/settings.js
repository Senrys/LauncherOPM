/**
 * Panneau PARAMÈTRES — pilote le fragment `src/panels/settings.html`.
 *
 * Quatre sous-écrans : COMPTES, JAVA & MÉMOIRE, RÉSOLUTION, LAUNCHER.
 *
 * Règles tenues par ce module :
 *  - il ne sélectionne QUE par attribut `data-*` (data-el, data-sub, data-action,
 *    data-bind, data-key) et ne pose des classes que pour exprimer un état ;
 *  - il ne cherche jamais hors de sa racine, à une exception documentée : la
 *    racine des modales `[data-el="modal-root"]`, point d'ancrage partagé du
 *    document, nécessaire pour empiler correctement la demande de mot de passe ;
 *  - aucune valeur d'affichage n'est inventée : les bornes mémoire viennent de
 *    `app.totalMemoryGb()` / `app.freeMemoryGb()`, le dossier de `app.gameDir()`,
 *    l'état des fichiers de `game.filesStat()`, les comptes de `auth.list()` ;
 *  - toute modification est persistée immédiatement par `config.set()`, les
 *    écritures rapprochées (glissement d'un curseur) étant regroupées ;
 *  - aucun mot de passe n'est journalisé, ni conservé au-delà de l'appel qui
 *    l'exige (dissociation Microsoft) ;
 *  - aucun code technique n'atteint le joueur : toute phrase montrée à la suite
 *    d'un échec passe par `utils/labels.js`, seule table de libellés du
 *    launcher (docs/API.md § 3), le détail brut restant dans le journal.
 */

import { blockedLabel, errorLabel } from '../utils/labels.js';

/* ========================================================================== */
/*  Constantes                                                                */
/* ========================================================================== */

/**
 * Nom de l'événement par lequel un panneau réclame l'écran de connexion alors
 * que l'application est déjà ouverte (« + AJOUTER UN COMPTE »). Le routage du
 * renderer se décide à partir du compte courant : il ne peut pas, à lui seul,
 * ramener vers la connexion un joueur déjà connecté. `panels/login.js` écoute
 * cet événement sur le document et se montre en surimpression.
 */
const LOGIN_REQUEST_EVENT = 'opm:request-login';

/** Regroupement des écritures de configuration, en millisecondes. */
const SAVE_DELAY_MS = 140;

/** Mémoire minimale allouable à la JVM, en Go (miroir de services/store.js). */
const RAM_FLOOR_GB = 1;

/** Au-delà de cette valeur, augmenter la mémoire minimale n'apporte plus rien. */
const RAM_MIN_SANE_GB = 4;

/** En deçà, Minecraft moddé sature : le module le signale. */
const RAM_MAX_SANE_GB = 2;

/** Mémoire laissée au système lors du calcul de la recommandation, en Go. */
const RAM_SYSTEM_RESERVE_GB = 2;

/** Bornes de la recommandation automatique, en Go. */
const RAM_ADVICE_MIN_GB = 2;
const RAM_ADVICE_MAX_GB = 8;

/** Un exécutable Java valide s'appelle `java` ou `javaw` (avec ou sans `.exe`). */
const JAVA_EXECUTABLE = /(^|[\\/])javaw?(\.exe)?$/i;

/** Arguments qui entreraient en conflit avec les curseurs de mémoire. */
const JVM_MEMORY_FLAG = /(^|\s)-Xm[sx]/i;

/** Nombre de chiffres d'un code de double authentification (docs/API.md § 1.2). */
const TOTP_LENGTH = 6;

/* ========================================================================== */
/*  Aides locales                                                             */
/* ========================================================================== */

/**
 * Lit une valeur dans un objet à partir d'un chemin pointé (`java.memory.min`).
 * @param {Object|null|undefined} source
 * @param {string} path
 * @returns {*}
 */
function readPath(source, path) {
  return path.split('.').reduce(
    (node, key) => (node === null || node === undefined ? undefined : node[key]),
    source,
  );
}

/**
 * Construit un correctif imbriqué à partir d'un chemin pointé.
 * `patchPath('java.memory.min', 2)` → `{ java: { memory: { min: 2 } } }`.
 * @param {string} path
 * @param {*} value
 * @returns {Object}
 */
function patchPath(path, value) {
  const keys = path.split('.');
  const patch = {};
  let node = patch;

  keys.forEach((key, index) => {
    if (index === keys.length - 1) node[key] = value;
    else {
      node[key] = {};
      node = node[key];
    }
  });
  return patch;
}

/**
 * Fusion profonde de deux correctifs de configuration (regroupement d'écritures).
 * @param {Object} target modifié sur place
 * @param {Object} patch
 * @returns {Object} `target`
 */
function mergePatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      mergePatch(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/**
 * Chaîne utile ou rien : une valeur absente, vide ou d'un autre type rend la
 * chaîne vide, ce qui laisse l'appelant choisir un état vide honnête.
 * @param {*} value
 * @returns {string}
 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Contraint une valeur numérique entre deux bornes.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Plus grand commun diviseur, pour réduire un rapport d'écran.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Vrai si le champ est celui que le joueur est en train de remplir.
 *
 * `applyConfig()` réaffiche la configuration normalisée par le processus
 * principal : c'est ce qui empêche l'écran de mentir (4.3). Mais réécrire un
 * champ sous les doigts de celui qui le remplit lui volerait sa saisie et son
 * curseur — on laisse donc le champ actif tranquille jusqu'à ce qu'il rende le
 * focus, la valeur enregistrée étant de toute façon réaffichée à sa validation.
 *
 * @param {Element|null|undefined} node
 * @returns {boolean}
 */
function isEditing(node) {
  return Boolean(node) && node === document.activeElement;
}

/* ========================================================================== */
/*  Panneau                                                                   */
/* ========================================================================== */

export default class SettingsPanel {
  static id = 'settings';

  /**
   * Monte le panneau : références, câblage, premières données réelles.
   * @param {Object} ctx contexte fourni par le renderer
   */
  async init(ctx) {
    this.ctx = ctx;
    this.root = ctx.root;

    const { $, $$ } = ctx.dom;

    /** Sous-écran affiché. */
    this.sub = 'comptes';

    /** Configuration locale de travail (référence partagée avec le magasin). */
    this.config = ctx.store.get().config ?? (await ctx.opm.config.get());

    /** Mémoire réelle de la machine, en Go. */
    this.memory = { total: 0, free: 0 };

    /** `app.memory` a échoué : les curseurs de mémoire sont verrouillés. */
    this.memoryUnknown = false;

    /** Comptes connus localement. */
    this.accounts = [];

    /** Dossier réel du jeu, connu une fois `app.gameDir()` rendu. */
    this.gameDir = null;

    /** Écritures de configuration en attente de regroupement. */
    this.pendingPatch = null;
    this.saveTimer = null;

    /**
     * Descriptif du flux « device » en cours (`Account.link_device`), quand le
     * serveur impose ce mode. C'est la seule source du code affiché : le
     * processus principal le publie avant d'entrer dans sa boucle de scrutation
     * et le retire dès qu'elle s'achève, quelle qu'en soit l'issue.
     * @type {{user_code: string, verification_uri: string}|null}
     */
    this.device = null;

    /** Un rattachement Microsoft lancé depuis ce panneau est en cours. */
    this.linking = false;

    /**
     * Le joueur a demandé l'interruption du rattachement en cours. L'appel de
     * `linkMicrosoft()` va donc échouer : c'est l'issue attendue, pas une
     * panne, et elle a déjà sa notification.
     */
    this.cancelRequested = false;

    /** Secret et codes de secours de la double authentification, le temps de l'activation. */
    this.totp = null;

    this.el = {
      navButtons: $$('[data-el="settings-nav"]', this.root),
      subscreens: $$('[data-el="subscreen"]', this.root),
      verifyFiles: $('[data-el="verify-files"]', this.root),

      accountsList: $('[data-el="accounts-list"]', this.root),
      accountTpl: $('[data-el="account-tpl"]', this.root),

      msLinked: $('[data-el="ms-linked"]', this.root),
      msUnlinked: $('[data-el="ms-unlinked"]', this.root),
      msHead: $('[data-el="ms-head"]', this.root),
      msUsername: $('[data-bind="ms-username"]', this.root),
      msExpires: $('[data-bind="ms-expires"]', this.root),
      msDevice: $('[data-el="ms-device"]', this.root),
      msDeviceOpen: $('[data-el="ms-device-open"]', this.root),
      msCode: $('[data-bind="ms-user-code"]', this.root),

      totpOff: $('[data-el="totp-off"]', this.root),
      totpOn: $('[data-el="totp-on"]', this.root),
      totpSetup: $('[data-el="totp-setup"]', this.root),
      totpCode: $('[data-el="totp-code"]', this.root),
      totpCodeError: $('[data-el="totp-code-error"]', this.root),
      totpCodes: $('[data-el="totp-codes"]', this.root),
      totpList: $('[data-bind="totp-list"]', this.root),
      totpSecret: $('[data-bind="totp-secret"]', this.root),
      totpDisableForm: $('[data-el="totp-disable-form"]', this.root),
      totpDisablePassword: $('[data-el="totp-disable-password"]', this.root),
      totpDisableCode: $('[data-el="totp-disable-code"]', this.root),
      totpDisableError: $('[data-el="totp-disable-error"]', this.root),

      ramFill: $('[data-el="ram-fill"]', this.root),
      ramMin: $('[data-el="ram-min"]', this.root),
      ramMax: $('[data-el="ram-max"]', this.root),
      ramNote: $('[data-el="ram-note"]', this.root),
      ramMinValues: $$('[data-bind="ram-min"]', this.root),
      ramMaxValues: $$('[data-bind="ram-max"]', this.root),

      jvmArgs: $('[data-el="jvm-args"]', this.root),
      jvmArgsError: $('[data-el="jvm-args-error"]', this.root),

      resWidth: $('[data-el="res-width"]', this.root),
      resHeight: $('[data-el="res-height"]', this.root),
      resPreview: $('[data-el="res-preview"]', this.root),
      presets: $$('[data-action="preset"]', this.root),

      switches: $$('[data-el="switch"]', this.root),
      clearCache: $('[data-el="clear-cache"]', this.root),
    };

    // L'encart de version se construit ici : le fragment ne le porte pas.
    Object.assign(this.el, this.buildLauncherVersion());

    // Le panneau est monté une seule fois pour la durée de la fenêtre : les
    // abonnements posés ici n'ont jamais à être relâchés.
    this.wireNavigation();
    this.wireActions();
    this.wireControls();

    this.applyConfig();
    this.paintLauncher();

    // Le magasin peut changer sous nos pieds : connexion d'un compte, case
    // « LANCEMENT AUTO » de la barre du bas, rattachement Microsoft, amorçage
    // arrivé après le montage du panneau.
    ctx.store.subscribe((state, changed) => {
      if (changed.has('config') && state.config && state.config !== this.config) {
        this.config = state.config;
        this.applyConfig();
      }
      if (changed.has('accounts') || changed.has('account')) {
        this.accounts = Array.isArray(state.accounts) ? state.accounts : this.accounts;
        this.renderAccounts();
        this.renderMicrosoft();
      }
      if (changed.has('bootstrap') || changed.has('version')) this.paintLauncher();
    });

    await Promise.all([this.loadMemory(), this.loadGameDir(), this.loadAccounts()]);
    this.loadFilesStat();
  }

  /** Le panneau redevient visible : on rafraîchit ce qui vieillit. */
  async show() {
    // Le cache a pu être vidé lors d'un passage précédent : sa taille n'est
    // plus connue tant qu'un nouveau vidage n'a pas été demandé.
    this.ctx.dom.setText(this.ctx.dom.$('[data-bind="cache-size"]', this.root), '');

    await Promise.all([this.loadAccounts(), this.loadMemory()]);
    this.loadFilesStat();
  }

  /** Le panneau disparaît : aucune écriture ne doit rester en attente. */
  async hide() {
    await this.flushSave();
  }

  /* ------------------------------------------------------------ signalement */

  /**
   * Signale un échec au joueur sans jamais lui montrer un code technique.
   *
   * Le détail brut part dans le journal, où il sert au diagnostic ; la phrase
   * affichée vient de `utils/labels.js`. Sans ce passage, un appel dont le
   * processus principal n'aurait pas fourni de message ferait remonter le code
   * lui-même jusqu'au toast : `preload.call()` construit l'`Error` avec
   * `message || error`, et `reportError()` affiche `error.message` tel quel.
   *
   * Le titre dit ce qui a échoué, la phrase du module dit pourquoi — la même
   * grammaire que la barre du bas.
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

  /* ---------------------------------------------------------------- câblage */

  /** Colonne de navigation : clic et flèches du clavier. */
  wireNavigation() {
    const { delegate, on } = this.ctx.dom;

    delegate(this.root, 'click', '[data-el="settings-nav"]', (event, target) => {
      this.setSub(target.dataset.sub);
    });

    // Liste d'onglets verticale : flèches, Origine et Fin, comme l'attend ARIA.
    on(this.root, 'keydown', (event) => {
      const index = this.el.navButtons.indexOf(event.target);
      if (index === -1) return;

      const last = this.el.navButtons.length - 1;
      let next = -1;

      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = last;
      else return;

      event.preventDefault();
      this.el.navButtons[next].focus();
      this.setSub(this.el.navButtons[next].dataset.sub);
    });
  }

  /** Tous les `data-action` du panneau, en délégation depuis la racine. */
  wireActions() {
    const { delegate } = this.ctx.dom;

    const actions = {
      'reset-config': () => this.resetEverything(),
      'set-primary': (target) => this.setPrimary(this.accountIdOf(target)),
      'remove-account': (target) => this.removeAccount(this.accountIdOf(target)),
      'add-account': () => this.requestLogin(),
      'link-microsoft': (target) => this.linkMicrosoft(target),
      'verify-ownership': (target) => this.verifyOwnership(target),
      'unlink-microsoft': (target) => this.unlinkMicrosoft(target),
      'copy-ms-code': () => this.copyDeviceCode(),
      'open-ms-link': () => this.openDeviceLink(),
      'cancel-link': (target) => this.cancelLink(target),
      'totp-start': (target) => this.totpStart(target),
      'totp-copy-secret': () => this.copyTotpSecret(),
      'totp-confirm': (target) => this.totpConfirm(target),
      'totp-cancel': () => this.totpReset(),
      'totp-copy-codes': () => this.copyTotpCodes(),
      'totp-codes-done': () => this.totpReset(),
      'totp-ask-disable': () => this.totpAskDisable(),
      'totp-disable': (target) => this.totpDisable(target),
      'totp-disable-cancel': () => this.totpReset(),
      'pick-java': () => this.pickJava(),
      'reset-java': () => this.setJavaPath(null),
      preset: (target) => this.applyPreset(target.dataset.preset),
      'open-game-dir': () => this.openGameDir(),
      'clear-cache': (target) => this.clearCache(target),
      'verify-files': (target) => this.verifyFiles(target),
      'download-launcher': () => this.downloadLauncher(),
    };

    for (const [name, handler] of Object.entries(actions)) {
      delegate(this.root, 'click', `[data-action="${name}"]`, (event, target) => {
        handler(target);
      });
    }
  }

  /** Interrupteurs, curseurs et champs : lecture, contrainte, persistance. */
  wireControls() {
    const { delegate, on } = this.ctx.dom;

    // Interrupteur générique : la clé de configuration est dans data-key.
    delegate(this.root, 'click', '[data-el="switch"]', (event, target) => {
      const key = target.dataset.key;
      if (!key) return;

      const next = target.getAttribute('aria-checked') !== 'true';
      target.setAttribute('aria-checked', next ? 'true' : 'false');
      this.save(key, next);
    });

    // Curseurs de mémoire : l'invariant min ≤ max est tenu des deux côtés.
    if (this.el.ramMin) {
      on(this.el.ramMin, 'input', () => this.onRamInput('min'));
    }
    if (this.el.ramMax) {
      on(this.el.ramMax, 'input', () => this.onRamInput('max'));
    }

    if (this.el.jvmArgs) {
      on(this.el.jvmArgs, 'input', () => this.onJvmArgsInput());
    }

    for (const field of [this.el.resWidth, this.el.resHeight]) {
      if (!field) continue;
      on(field, 'input', () => this.onResolutionInput(field, false));
      on(field, 'change', () => this.onResolutionInput(field, true));
    }
  }

  /* ------------------------------------------------------------ sous-écrans */

  /**
   * Affiche un sous-écran et met à jour l'état ARIA de la liste d'onglets.
   * @param {string} name comptes | java | reso | launcher
   */
  setSub(name) {
    if (!name || name === this.sub) return;

    const target = this.el.subscreens.find((node) => node.dataset.sub === name);
    if (!target) return;

    this.sub = name;

    for (const screen of this.el.subscreens) {
      screen.hidden = screen !== target;
    }

    for (const button of this.el.navButtons) {
      const selected = button.dataset.sub === name;
      button.classList.toggle('opm-settings__navbtn--active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    }
  }

  /* ------------------------------------------------------- persistance */

  /**
   * Programme une écriture de configuration. Les appels rapprochés (glissement
   * d'un curseur) sont fusionnés en un seul aller-retour IPC.
   * @param {string} key chemin pointé dans `LauncherConfig`
   * @param {*} value
   */
  save(key, value) {
    this.pendingPatch = mergePatch(this.pendingPatch ?? {}, patchPath(key, value));

    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DELAY_MS);
  }

  /**
   * Écrit sans attendre les modifications en attente.
   * @returns {Promise<void>}
   */
  async flushSave() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.pendingPatch) return;

    const patch = this.pendingPatch;
    this.pendingPatch = null;

    try {
      // Le processus principal renvoie la configuration normalisée : c'est elle
      // qui fait foi, pas ce que le panneau croyait écrire. On la réaffiche donc
      // aussi en cas de SUCCÈS : sans cela, une valeur ramenée dans ses bornes
      // (résolution, mémoire) resterait affichée telle que saisie, et l'écran
      // divergerait silencieusement du disque et du jeu.
      this.config = await this.ctx.opm.config.set(patch);
      this.ctx.store.set({ config: this.config });
    } catch (error) {
      this.reportFailure(error, 'Réglage non enregistré',
        "Le réglage n'a pas pu être écrit sur le disque : la valeur affichée est celle qui reste en vigueur.");
    }
    this.applyConfig();
  }

  /** Reporte la configuration courante sur tous les contrôles du panneau. */
  applyConfig() {
    const config = this.config;
    if (!config) return;

    for (const button of this.el.switches) {
      const key = button.dataset.key;
      if (!key) continue;
      button.setAttribute('aria-checked', readPath(config, key) ? 'true' : 'false');
    }

    // Les champs libres ne sont réécrits que lorsqu'ils ne sont pas en cours de
    // saisie (cf. isEditing) : la valeur retenue les rejoindra à leur validation.
    if (this.el.jvmArgs && !isEditing(this.el.jvmArgs)) {
      this.el.jvmArgs.value = config.java?.args ?? '';
    }
    this.renderJavaPath();

    if (this.el.resWidth && !isEditing(this.el.resWidth)) {
      this.el.resWidth.value = String(config.game?.width ?? '');
    }
    if (this.el.resHeight && !isEditing(this.el.resHeight)) {
      this.el.resHeight.value = String(config.game?.height ?? '');
    }
    this.renderResolution();

    this.renderRam();
  }

  /* ------------------------------------------------------------- COMPTES */

  /**
   * Identifiant du compte porté par la carte contenant l'élément cliqué.
   * @param {Element} target
   * @returns {string}
   */
  accountIdOf(target) {
    return target.closest('[data-el="account"]')?.dataset.id ?? '';
  }

  /** Charge la liste réelle des comptes connus du launcher. */
  async loadAccounts() {
    try {
      this.accounts = (await this.ctx.opm.auth.list()) ?? [];
    } catch (error) {
      this.reportFailure(error, 'Comptes illisibles',
        "La liste des comptes enregistrés sur cette machine n'a pas pu être lue.");
      this.accounts = [];
    }
    this.renderAccounts();
    this.renderMicrosoft();
  }

  /** Reconstruit la liste des cartes de compte depuis `account-tpl`. */
  renderAccounts() {
    const list = this.el.accountsList;
    const template = this.el.accountTpl;
    if (!list || !template) return;

    const { $, setText } = this.ctx.dom;
    list.replaceChildren();

    for (const account of this.accounts) {
      const card = template.content.firstElementChild.cloneNode(true);
      card.dataset.id = account.id ?? '';
      card.classList.toggle('opm-account--primary', Boolean(account.primary));

      setText($('[data-bind="account-name"]', card), account.username ?? '');
      setText($('[data-bind="account-meta"]', card), this.accountMeta(account));

      const avatar = $('[data-el="account-avatar"]', card);
      if (avatar) {
        avatar.alt = account.username ? `Tête du skin de ${account.username}` : '';
        this.ctx.skin.headDataUrl(account.skin_url).then((url) => { avatar.src = url; });
      }

      list.append(card);
    }
  }

  /**
   * Ligne secondaire d'une carte de compte : e-mail, pseudo Minecraft, blocage.
   * @param {Object} account
   * @returns {string}
   */
  accountMeta(account) {
    const parts = [];
    if (account.email) parts.push(account.email);

    parts.push(account.minecraft?.name
      ? `Minecraft : ${account.minecraft.name}`
      : 'Compte Minecraft non rattaché');

    // Jamais le code brut : un « microsoft_expired » sous les yeux du joueur
    // n'est pas une information, c'est une fuite de vocabulaire technique. Le
    // titre court du module partagé dit la même chose que l'accueil et la barre
    // du bas, et il couvre aussi les motifs que ce launcher ne connaît pas.
    if (!account.can_play && account.blocked_reason) {
      parts.push(blockedLabel(account.blocked_reason).title);
    }
    return parts.join(' · ');
  }

  /**
   * Définit le compte de lancement.
   * @param {string} id
   */
  async setPrimary(id) {
    if (!id) return;

    try {
      await this.ctx.opm.auth.select(id);
      await this.loadAccounts();
      this.ctx.toast({
        kind: 'success',
        title: 'Compte principal modifié',
        message: 'Ce compte sera utilisé au prochain lancement du jeu.',
      });
    } catch (error) {
      this.reportFailure(error, 'Changement de compte impossible',
        "Le compte de lancement n'a pas pu être modifié.");
    }
  }

  /**
   * Retire un compte du launcher, après confirmation.
   * @param {string} id
   */
  async removeAccount(id) {
    if (!id) return;

    const account = this.accounts.find((item) => item.id === id);
    const confirmed = await this.ctx.confirmModal({
      title: 'Retirer ce compte ?',
      message: `${account?.username ?? 'Ce compte'} sera retiré du launcher. `
        + "Votre compte One Piece Minecraft n'est pas supprimé : vous pourrez vous reconnecter "
        + 'à tout moment.',
      confirmLabel: 'RETIRER',
      danger: true,
    });
    if (!confirmed) return;

    try {
      await this.ctx.opm.auth.remove(id);
      await this.loadAccounts();
      this.ctx.toast({
        kind: 'info',
        title: 'Compte retiré',
        message: 'Ce compte ne figure plus dans le launcher.',
      });
    } catch (error) {
      this.reportFailure(error, 'Retrait du compte impossible',
        "Le compte n'a pas pu être retiré du launcher.");
    }
  }

  /**
   * Réclame l'écran de connexion pour ajouter un compte supplémentaire.
   * Le routage du renderer se décidant à partir du compte courant, la demande
   * passe par un événement du document, écouté par `panels/login.js`.
   */
  requestLogin() {
    this.ctx.setLoginView('login');
    document.dispatchEvent(new CustomEvent(LOGIN_REQUEST_EVENT, { detail: { view: 'login' } }));
  }

  /* --------------------------------------------- POSSESSION (Microsoft) */

  /** Compte actuellement sélectionné, ou le compte principal. */
  currentAccount() {
    return this.ctx.store.get().account
      ?? this.accounts.find((item) => item.primary)
      ?? this.accounts[0]
      ?? null;
  }

  /** Affiche l'état de rattachement Microsoft du compte courant. */
  renderMicrosoft() {
    const { setText, show, hide } = this.ctx.dom;
    const account = this.currentAccount();
    const linked = Boolean(account?.minecraft);

    // Le code « device » REMPLACE les deux états de repos : tant qu'une
    // scrutation tourne, c'est lui qui porte l'action, et lui seul. Laisser la
    // carte « compte rattaché » à côté du code afficherait à la fois le compte
    // déjà en place et la demande de confirmation du suivant — deux réponses
    // opposées à la même question, dont l'une des deux ne vaut plus.
    this.renderDevice(account);
    const pending = this.device !== null;

    if (this.el.msLinked) this.el.msLinked.hidden = !linked || pending;
    if (this.el.msUnlinked) this.el.msUnlinked.hidden = linked || pending;
    this.renderTotp(account);
    if (!linked || !account) return;

    setText(this.el.msUsername, account.minecraft.name ?? '');

    if (this.el.msHead) {
      this.el.msHead.alt = `Tête du skin de ${account.minecraft.name ?? ''}`;
      this.ctx.skin.headDataUrl(account.skin_url).then((url) => { this.el.msHead.src = url; });
    }

    // Échéance de la vérification de possession : `session_expires_at` est le
    // SEUL champ qui la porte dans le type `Account` (docs/IPC.md § Types) —
    // c'est `microsoft.expires_at` du serveur, recopié par `toAccount()`.
    // Sans date réelle, on retire la phrase entière plutôt que d'afficher une
    // promesse vide.
    const expires = account.session_expires_at ?? null;
    const sentence = this.el.msExpires?.parentElement ?? null;

    if (expires) {
      setText(this.el.msExpires, this.ctx.format.dateFr(expires, { withYear: true }));
      show(sentence);
    } else {
      hide(sentence);
    }
  }

  /**
   * Affiche (ou retire) le code du flux « device ».
   *
   * Sans ce bloc, le joueur qui lance un rattachement depuis les paramètres voit
   * s'ouvrir une page Microsoft réclamant un code affiché nulle part : le
   * rattachement y était tout simplement impossible. La source est la même que
   * celle de l'écran de connexion — le champ `link_device` du compte diffusé par
   * `auth.onChange` — et jamais le retour de `linkMicrosoft()`, qui n'arrive
   * qu'au terme de la scrutation, jusqu'à quinze minutes plus tard.
   *
   * @param {Object|null} account
   */
  renderDevice(account) {
    const { setText, show, hide } = this.ctx.dom;
    const raw = account?.link_device ?? null;
    const code = typeof raw?.user_code === 'string' ? raw.user_code : '';

    if (code === '') {
      this.device = null;
      setText(this.el.msCode, '');
      hide(this.el.msDevice);
      return;
    }

    this.device = {
      user_code: code,
      verification_uri: typeof raw.verification_uri === 'string' ? raw.verification_uri : '',
    };

    setText(this.el.msCode, code);
    show(this.el.msDevice);

    // Sans adresse de validation, le bouton ne mènerait nulle part.
    if (this.el.msDeviceOpen) this.el.msDeviceOpen.disabled = this.device.verification_uri === '';
  }

  /** Copie le code du flux « device » dans le presse-papiers. */
  async copyDeviceCode() {
    if (!this.device) return;

    try {
      await navigator.clipboard.writeText(this.device.user_code);
      this.ctx.toast({
        kind: 'success',
        title: 'Code copié',
        message: 'Collez-le sur la page Microsoft pour confirmer votre compte.',
      });
    } catch (error) {
      this.ctx.log('warn', `Copie du code impossible : ${error?.message ?? error}`);
      this.ctx.toast({
        kind: 'error',
        title: 'Copie impossible',
        message: `Saisissez le code manuellement : ${this.device.user_code}`,
      });
    }
  }

  /** Ouvre (ou rouvre) la page de validation Microsoft. */
  openDeviceLink() {
    if (this.device?.verification_uri) this.ctx.openExternal(this.device.verification_uri);
  }

  /**
   * Interrompt le rattachement en cours.
   *
   * Sans cette sortie, le verrou « linking » du processus principal refuse toute
   * nouvelle tentative jusqu'à l'expiration du code — un quart d'heure pendant
   * lequel le joueur qui s'est trompé de compte Microsoft n'a plus aucun recours.
   *
   * L'interruption fait échouer l'appel encore en vol dans `linkMicrosoft()` :
   * le drapeau posé ici est ce qui empêche cet échec attendu de produire une
   * seconde notification, qui contredirait celle-ci.
   *
   * @param {HTMLButtonElement} button
   */
  async cancelLink(button) {
    button.disabled = true;
    this.cancelRequested = true;

    try {
      await this.ctx.opm.auth.cancelLink();
      // Le processus principal remet `link_device` à null et diffuse le compte :
      // c'est `renderDevice()` qui retire le code, à la même source que toujours.
      this.ctx.toast({
        kind: 'info',
        title: 'Rattachement annulé',
        message: 'Vous pouvez en relancer un à tout moment.',
      });
    } catch (error) {
      // Rien n'a été interrompu : le rattachement continue, et son propre échec
      // devra bien être signalé le moment venu.
      this.cancelRequested = false;
      this.reportFailure(error, 'Annulation impossible',
        "Le rattachement en cours n'a pas pu être interrompu.");
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Lance le rattachement Microsoft depuis les paramètres.
   *
   * L'appel ne rend la main qu'à la toute fin de la scrutation en mode
   * « device » : pendant ce temps, c'est `renderDevice()` — nourri par
   * `auth.onChange` — qui affiche le code et le bouton ANNULER.
   *
   * @param {HTMLButtonElement} button
   */
  async linkMicrosoft(button) {
    if (this.linking) return;

    this.linking = true;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');

    try {
      await this.ctx.opm.auth.linkMicrosoft();
      await this.loadAccounts();
      this.ctx.toast({
        kind: 'success',
        title: 'Compte Minecraft rattaché',
        message: 'La possession du jeu est confirmée : vous pouvez embarquer.',
      });
    } catch (error) {
      // L'annulation demandée par le joueur fait échouer cet appel : c'est
      // l'issue attendue, et `cancelLink()` l'a déjà annoncée. Deux toasts
      // contradictoires — « Rattachement annulé » puis « Rattachement
      // impossible » — laisseraient croire que l'annulation a raté.
      const cancelled = error?.code === 'link_cancelled' || this.cancelRequested;

      if (cancelled) {
        this.ctx.log('info', 'Rattachement Microsoft interrompu depuis les Paramètres.');
      } else {
        this.reportFailure(error, 'Rattachement impossible',
          "Le compte Microsoft n'a pas pu être rattaché.");
      }
      await this.loadAccounts();
    } finally {
      this.linking = false;
      this.cancelRequested = false;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  /**
   * Redemande à Microsoft de confirmer la possession, et repousse l'échéance.
   * @param {HTMLButtonElement} button
   */
  async verifyOwnership(button) {
    button.disabled = true;
    try {
      await this.ctx.opm.auth.verifyOwnership();
      await this.loadAccounts();
      this.ctx.toast({
        kind: 'success',
        title: 'Possession vérifiée',
        message: 'Votre droit de jeu est confirmé pour une nouvelle période.',
      });
    } catch (error) {
      this.reportFailure(error, 'Vérification impossible',
        "La possession de Minecraft n'a pas pu être vérifiée auprès de Microsoft.");
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Dissocie le compte Microsoft. Le mot de passe One Piece Minecraft est exigé :
   * une session volée ne doit pas pouvoir libérer un compte Minecraft.
   * @param {HTMLButtonElement} button
   */
  async unlinkMicrosoft(button) {
    const password = await this.askPassword({
      title: 'Dissocier le compte Minecraft ?',
      message: "Le bouton JOUER redeviendra indisponible tant qu'un compte Microsoft "
        + 'possédant Minecraft ne sera pas rattaché. Saisissez votre mot de passe '
        + 'One Piece Minecraft pour confirmer.',
      confirmLabel: 'DISSOCIER',
    });
    if (password === null) return;

    button.disabled = true;
    try {
      await this.ctx.opm.auth.unlinkMicrosoft(password);
      await this.loadAccounts();
      this.ctx.toast({
        kind: 'info',
        title: 'Compte Minecraft dissocié',
        message: 'Vous pourrez rattacher un autre compte Microsoft à tout moment.',
      });
    } catch (error) {
      this.reportFailure(error, 'Dissociation impossible',
        "Le compte Microsoft n'a pas pu être dissocié.");
    } finally {
      button.disabled = false;
    }
  }

  /* ------------------------------------------ DOUBLE AUTHENTIFICATION (TOTP) */

  /**
   * Affiche l'état de repos de la double authentification.
   *
   * Les étapes (activation, codes de secours, désactivation) sont pilotées par
   * les actions du joueur et ne sont donc PAS redessinées ici : `renderTotp()`
   * sort dès qu'une étape est ouverte, sans quoi la diffusion d'un compte
   * refermerait le formulaire sous les doigts de celui qui le remplit.
   *
   * @param {Object|null} account
   */
  renderTotp(account) {
    if (this.totpStepOpen()) return;

    // Sans compte connu, aucun des deux états n'est vrai : on n'affirme rien.
    const known = Boolean(account);
    const enabled = Boolean(account?.totp_enabled);

    if (this.el.totpOff) this.el.totpOff.hidden = !known || enabled;
    if (this.el.totpOn) this.el.totpOn.hidden = !known || !enabled;
  }

  /** Vrai si une étape (activation, codes, désactivation) est ouverte. */
  totpStepOpen() {
    return [this.el.totpSetup, this.el.totpCodes, this.el.totpDisableForm]
      .some((node) => node && !node.hidden);
  }

  /**
   * Referme toute étape en cours et revient à l'état de repos.
   * Les deux champs sensibles sont vidés : ni mot de passe ni code ne survit à
   * l'appel qui les exigeait.
   */
  totpReset() {
    const { hide } = this.ctx.dom;

    this.totp = null;
    for (const node of [this.el.totpSetup, this.el.totpCodes, this.el.totpDisableForm]) {
      hide(node);
    }
    hide(this.el.totpCodeError);
    hide(this.el.totpDisableError);

    for (const field of [this.el.totpCode, this.el.totpDisablePassword, this.el.totpDisableCode]) {
      if (field) field.value = '';
    }

    this.renderTotp(this.currentAccount());
  }

  /**
   * Première étape : le serveur produit la clé et les codes de secours. Rien
   * n'est activé tant que le premier code n'a pas été validé.
   * @param {HTMLButtonElement} button
   */
  async totpStart(button) {
    const { setText, show, hide } = this.ctx.dom;
    button.disabled = true;

    try {
      const setup = await this.ctx.opm.auth.totpSetup();
      this.totp = {
        secret: typeof setup?.secret === 'string' ? setup.secret : '',
        codes: Array.isArray(setup?.recovery_codes) ? setup.recovery_codes.map(String) : [],
      };

      setText(this.el.totpSecret, this.totp.secret);
      if (this.el.totpCode) this.el.totpCode.value = '';

      hide(this.el.totpOff);
      hide(this.el.totpOn);
      show(this.el.totpSetup);
      this.el.totpCode?.focus({ preventScroll: true });
    } catch (error) {
      this.reportFailure(error, 'Activation impossible',
        "La double authentification n'a pas pu être préparée : le serveur n'a pas délivré de clé.");
    } finally {
      button.disabled = false;
    }
  }

  /** Copie la clé de configuration dans le presse-papiers. */
  async copyTotpSecret() {
    if (!this.totp?.secret) return;

    try {
      await navigator.clipboard.writeText(this.totp.secret);
      this.ctx.toast({
        kind: 'success',
        title: 'Clé copiée',
        message: "Collez-la dans votre application d'authentification.",
      });
    } catch (error) {
      this.ctx.log('warn', `Copie de la clé impossible : ${error?.message ?? error}`);
      this.ctx.toast({
        kind: 'error',
        title: 'Copie impossible',
        message: 'Recopiez la clé affichée à la main.',
      });
    }
  }

  /**
   * Seconde étape : le premier code produit par l'application active réellement
   * la double authentification côté serveur.
   * @param {HTMLButtonElement} button
   */
  async totpConfirm(button) {
    const { setText, show, hide } = this.ctx.dom;
    const code = (this.el.totpCode?.value ?? '').trim();

    if (code.length !== TOTP_LENGTH) {
      setText(this.el.totpCodeError, `Le code compte ${TOTP_LENGTH} chiffres.`);
      show(this.el.totpCodeError);
      return;
    }

    hide(this.el.totpCodeError);
    button.disabled = true;

    try {
      await this.ctx.opm.auth.totpEnable(code);

      // Les codes de secours ne sont montrés qu'ici : avant l'activation réelle,
      // ils ne serviraient à rien ; après, ils ne seront plus jamais affichés.
      setText(this.el.totpList, this.totp?.codes.join('   ·   ') ?? '');
      hide(this.el.totpSetup);
      show(this.el.totpCodes);

      if (this.el.totpCode) this.el.totpCode.value = '';
      await this.loadAccounts();
    } catch (error) {
      // Le message vient du module partagé, jamais du code : `preload.call()`
      // recopie l'identifiant technique dans `message` quand le processus
      // principal n'en fournit pas, et il finirait sous le champ de saisie.
      this.ctx.log('warn', `Activation de la double authentification refusée : ${error?.message ?? error}`);
      setText(this.el.totpCodeError, errorLabel(error?.code, 'Code refusé.').message);
      show(this.el.totpCodeError);
    } finally {
      button.disabled = false;
    }
  }

  /** Copie les codes de secours dans le presse-papiers. */
  async copyTotpCodes() {
    if (!this.totp?.codes?.length) return;

    try {
      await navigator.clipboard.writeText(this.totp.codes.join('\n'));
      this.ctx.toast({
        kind: 'success',
        title: 'Codes copiés',
        message: 'Conservez-les hors du launcher : ils ne seront plus affichés.',
      });
    } catch (error) {
      this.ctx.log('warn', `Copie des codes impossible : ${error?.message ?? error}`);
      this.ctx.toast({
        kind: 'error',
        title: 'Copie impossible',
        message: 'Recopiez les codes affichés à la main.',
      });
    }
  }

  /** Ouvre le formulaire de désactivation (mot de passe + code, comme l'API l'exige). */
  totpAskDisable() {
    const { show, hide } = this.ctx.dom;

    hide(this.el.totpOff);
    hide(this.el.totpOn);
    show(this.el.totpDisableForm);
    this.el.totpDisablePassword?.focus({ preventScroll: true });
  }

  /**
   * Désactive la double authentification.
   *
   * Le mot de passe est saisi ici plutôt que dans la modale partagée parce que
   * l'API réclame DEUX secrets à la fois ; il n'est ni journalisé ni conservé
   * au-delà de l'appel, et les deux champs sont vidés dans tous les cas.
   *
   * @param {HTMLButtonElement} button
   */
  async totpDisable(button) {
    const { setText, show, hide } = this.ctx.dom;
    const password = this.el.totpDisablePassword?.value ?? '';
    const code = (this.el.totpDisableCode?.value ?? '').trim();

    if (password === '' || code.length !== TOTP_LENGTH) {
      setText(this.el.totpDisableError,
        `Mot de passe et code à ${TOTP_LENGTH} chiffres sont tous deux exigés.`);
      show(this.el.totpDisableError);
      return;
    }

    hide(this.el.totpDisableError);
    button.disabled = true;

    try {
      await this.ctx.opm.auth.totpDisable({ password, code });
      this.totpReset();
      await this.loadAccounts();
      this.ctx.toast({
        kind: 'info',
        title: 'Double authentification désactivée',
        message: 'Seul votre mot de passe sera désormais demandé à la connexion.',
      });
    } catch (error) {
      // Même règle que ci-dessus : le joueur lit une phrase, le journal garde
      // le détail. Rien de ce qui est saisi ici n'y figure.
      this.ctx.log('warn', `Désactivation de la double authentification refusée : ${error?.message ?? error}`);
      setText(this.el.totpDisableError, errorLabel(error?.code, 'Désactivation refusée.').message);
      show(this.el.totpDisableError);
    } finally {
      button.disabled = false;
      if (this.el.totpDisablePassword) this.el.totpDisablePassword.value = '';
    }
  }

  /**
   * Demande un mot de passe dans une modale.
   *
   * `confirmModal()` ne rend qu'un booléen : cette variante réutilise le même
   * habillage et les mêmes règles (voile, piège de focus, Échap annule) pour
   * recueillir une saisie. La valeur n'est ni journalisée, ni conservée : elle
   * est rendue à l'appelant puis effacée du champ.
   *
   * @param {{title: string, message: string, confirmLabel: string}} options
   * @returns {Promise<string|null>} le mot de passe, ou `null` si annulation
   */
  askPassword({ title, message, confirmLabel }) {
    // Racine partagée des modales : seul point d'ancrage du document utilisé
    // par ce panneau, pour que la carte se superpose au reste de l'interface.
    const host = this.ctx.dom.$('[data-el="modal-root"]');
    if (!host) return Promise.resolve(null);

    const { el, on, focusTrap, show, hide } = this.ctx.dom;

    return new Promise((resolve) => {
      let settled = false;
      /** @type {Array<() => void>} */
      const listeners = [];
      /** @type {(() => void)|null} */
      let release = null;

      const input = el('input', {
        class: 'opm-field__input',
        type: 'password',
        id: 'opm-unlink-password',
        name: 'password',
        autocomplete: 'current-password',
        required: true,
      });

      const error = el('p', {
        class: 'opm-field__error',
        role: 'alert',
        hidden: true,
        text: 'Saisissez votre mot de passe pour confirmer.',
      });

      /**
       * Ferme la modale et rend la réponse. Le champ est vidé dans tous les cas.
       * @param {string|null} answer
       */
      const finish = (answer) => {
        if (settled) return;
        settled = true;

        for (const off of listeners) off();
        if (release) release();

        input.value = '';
        overlay.remove();
        resolve(answer);
      };

      const submit = () => {
        const value = input.value;
        if (value.length === 0) {
          show(error);
          input.focus();
          return;
        }
        hide(error);
        finish(value);
      };

      const cancelButton = el('button', {
        type: 'button',
        class: ['opm-btn', 'opm-btn--ghost'],
        text: 'ANNULER',
        onClick: () => finish(null),
      });

      const confirmButton = el('button', {
        type: 'submit',
        class: ['opm-btn', 'opm-btn--danger'],
        text: confirmLabel,
      });

      const form = el('form', {
        novalidate: true,
        onSubmit: (event) => {
          event.preventDefault();
          submit();
        },
      }, [
        el('h2', { text: title }),
        el('p', { text: message }),
        el('div', { class: 'opm-field' }, [
          el('label', {
            class: 'opm-field__label',
            for: 'opm-unlink-password',
            text: 'Mot de passe One Piece Minecraft',
          }),
          input,
          error,
        ]),
        el('div', { class: 'opm-modal__actions' }, [cancelButton, confirmButton]),
      ]);

      const card = el('div', {
        class: 'opm-modal__card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
      }, [form]);

      const overlay = el('div', { class: 'opm-modal' }, [
        el('div', { class: 'opm-modal__veil', onClick: () => finish(null) }),
        card,
      ]);

      host.append(overlay);

      listeners.push(on(overlay, 'keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }));

      release = focusTrap(card, { initial: input });
    });
  }

  /* -------------------------------------------------------- JAVA & MÉMOIRE */

  /** Lit la mémoire réelle de la machine et cale les bornes des curseurs. */
  async loadMemory() {
    const { setText, $ } = this.ctx.dom;

    try {
      const [total, free] = await Promise.all([
        this.ctx.opm.app.totalMemoryGb(),
        this.ctx.opm.app.freeMemoryGb(),
      ]);
      this.memory = {
        total: Math.max(RAM_FLOOR_GB, Math.floor(total)),
        free: Math.max(0, free),
      };
    } catch (error) {
      // Sans borne haute réelle, un curseur laisserait promettre une mémoire que
      // la machine n'a pas : on le verrouille au lieu de le laisser mentir.
      this.ctx.log('warn', `Mémoire de la machine inconnue : ${error?.message ?? error}`);
      this.memory = { total: 0, free: 0 };
      this.memoryUnknown = true;
      this.lockMemorySliders(true);
      this.renderRam();
      return;
    }

    this.memoryUnknown = false;
    this.lockMemorySliders(false);
    const { total, free } = this.memory;

    for (const slider of [this.el.ramMin, this.el.ramMax]) {
      if (slider) slider.max = String(total);
    }

    setText($('[data-bind="ram-total"]', this.root), this.ctx.format.nf(total));
    setText($('[data-bind="ram-free"]', this.root), this.ctx.format.nf(free, 1));
    setText($('[data-bind="ram-recommended"]', this.root), `${this.recommendedRam()} Go`);
    setText($('[data-bind="ram-scale-mid"]', this.root), `${this.ctx.format.nf(total / 2, total % 2 ? 1 : 0)} GO`);
    setText($('[data-bind="ram-scale-max"]', this.root), `${this.ctx.format.nf(total)} GO`);

    // Une configuration héritée d'une machine plus fournie doit être ramenée
    // dans les bornes réelles, sinon les curseurs mentiraient.
    const memory = this.config?.java?.memory ?? { min: RAM_FLOOR_GB, max: RAM_FLOOR_GB };
    const max = clamp(Math.round(memory.max), RAM_FLOOR_GB, total);
    const min = clamp(Math.round(memory.min), RAM_FLOOR_GB, max);

    if (min !== memory.min || max !== memory.max) {
      this.save('java.memory.min', min);
      this.save('java.memory.max', max);
      this.config = { ...this.config, java: { ...this.config.java, memory: { min, max } } };
    }

    this.renderRam();
  }

  /**
   * Verrouille (ou libère) les deux curseurs de mémoire.
   *
   * Le balisage porte `max="1"` comme repli : sans attribut, HTML5 retomberait
   * sur 100 et laisserait glisser jusqu'à 100 Go. Tant que la mémoire réelle est
   * inconnue, le panneau préfère un curseur inerte à un curseur qui promet.
   * La note explicative, elle, est écrite par `renderRamNote()`.
   *
   * @param {boolean} locked
   */
  lockMemorySliders(locked) {
    for (const slider of [this.el.ramMin, this.el.ramMax]) {
      if (slider) slider.disabled = locked;
    }
  }

  /**
   * Recommandation d'allocation, déduite de la machine et non d'une constante :
   * environ un quart de la mémoire, bornée, en laissant de quoi faire tourner
   * le système.
   * @returns {number} mémoire conseillée, en Go
   */
  recommendedRam() {
    const total = this.memory.total || RAM_FLOOR_GB;
    const usable = Math.max(RAM_FLOOR_GB, total - RAM_SYSTEM_RESERVE_GB);
    return clamp(Math.round(total / 4), Math.min(RAM_ADVICE_MIN_GB, usable), Math.min(RAM_ADVICE_MAX_GB, usable));
  }

  /**
   * Un curseur de mémoire a bougé : on tient l'invariant min ≤ max en poussant
   * l'autre curseur, puis on persiste les deux valeurs.
   * @param {'min'|'max'} moved
   */
  onRamInput(moved) {
    const total = this.memory.total || Number(this.el.ramMax?.max) || RAM_FLOOR_GB;

    let min = clamp(Number(this.el.ramMin?.value ?? RAM_FLOOR_GB), RAM_FLOOR_GB, total);
    let max = clamp(Number(this.el.ramMax?.value ?? RAM_FLOOR_GB), RAM_FLOOR_GB, total);

    if (moved === 'min' && min > max) max = min;
    if (moved === 'max' && max < min) min = max;

    if (this.el.ramMin) this.el.ramMin.value = String(min);
    if (this.el.ramMax) this.el.ramMax.value = String(max);

    this.config = { ...this.config, java: { ...this.config.java, memory: { min, max } } };
    this.renderRam();

    this.save('java.memory.min', min);
    this.save('java.memory.max', max);
  }

  /** Valeurs chiffrées, jauge à rayures et note contextuelle de la mémoire. */
  renderRam() {
    const { setText } = this.ctx.dom;
    const memory = this.config?.java?.memory;
    if (!memory) return;

    const min = memory.min;
    const max = memory.max;

    for (const node of this.el.ramMinValues) setText(node, this.ctx.format.nf(min));
    for (const node of this.el.ramMaxValues) setText(node, this.ctx.format.nf(max));

    if (this.el.ramMin) this.el.ramMin.value = String(min);
    if (this.el.ramMax) this.el.ramMax.value = String(max);

    // La jauge n'a de sens qu'une fois la mémoire réelle connue.
    const total = this.memory.total;
    if (this.el.ramFill && total > 0) {
      this.el.ramFill.style.left = `${clamp((min / total) * 100, 0, 100)}%`;
      this.el.ramFill.style.width = `${clamp(((max - min) / total) * 100, 0, 100)}%`;
    }

    this.renderRamNote(min, max, total);
  }

  /**
   * Note sous la jauge : avertissement quand l'allocation sort de la plage
   * saine de CETTE machine, information sinon.
   * @param {number} min
   * @param {number} max
   * @param {number} total mémoire réelle, 0 si encore inconnue
   */
  renderRamNote(min, max, total) {
    const note = this.el.ramNote;
    if (!note) return;

    const { nf } = this.ctx.format;
    let text = '';
    let warn = false;

    if (this.memoryUnknown) {
      warn = true;
      text = "La mémoire de cette machine n'a pas pu être lue : les curseurs restent "
        + 'bloqués sur la valeur enregistrée. Revenez sur ce panneau pour réessayer.';
    } else if (total > 0 && max > total / 2) {
      warn = true;
      text = `Vous réservez ${nf(max)} Go sur les ${nf(total)} Go de votre machine : `
        + `au-delà de ${nf(total / 2, total % 2 ? 1 : 0)} Go, votre système et vos autres `
        + 'applications commencent à manquer de mémoire.';
    } else if (min > RAM_MIN_SANE_GB) {
      warn = true;
      text = `Une mémoire minimale de ${nf(min)} Go force la JVM à réserver tout de suite `
        + `ce qu'elle n'utilisera peut-être jamais : restez sous ${RAM_MIN_SANE_GB} Go.`;
    } else if (max < RAM_MAX_SANE_GB) {
      warn = true;
      text = `${nf(max)} Go ne suffisent pas à une instance moddée : le jeu saturera `
        + 'et se figera régulièrement.';
    } else if (total > 0) {
      text = `Allocation saine : ${nf(max)} Go pour le jeu, ${nf(total - max)} Go laissés `
        + `à votre système (recommandé pour cette instance : ${this.recommendedRam()} Go).`;
    }

    note.textContent = text;
    note.classList.toggle('opm-note--warn', warn);
  }

  /** Affiche le chemin de l'exécutable Java retenu. */
  renderJavaPath() {
    this.ctx.dom.setText(
      this.ctx.dom.$('[data-bind="java-path"]', this.root),
      this.config?.java?.path ?? 'Java embarqué par le launcher',
    );
  }

  /** Ouvre le sélecteur natif et retient l'exécutable Java choisi. */
  async pickJava() {
    let picked = null;

    try {
      picked = await this.ctx.opm.app.pickJava();
    } catch (error) {
      this.reportFailure(error, 'Sélection de Java impossible',
        "Le sélecteur de fichiers n'a pas pu s'ouvrir.");
      return;
    }
    if (!picked) return;

    if (!JAVA_EXECUTABLE.test(picked)) {
      this.ctx.toast({
        kind: 'error',
        title: 'Exécutable Java non reconnu',
        message: "Choisissez le fichier « java » ou « javaw » du dossier « bin » d'une "
          + 'installation Java.',
      });
      return;
    }
    this.setJavaPath(picked);
  }

  /**
   * Retient (ou remet par défaut) le chemin de Java.
   * @param {string|null} value `null` = Java embarqué
   */
  setJavaPath(value) {
    this.config = { ...this.config, java: { ...this.config.java, path: value } };
    this.renderJavaPath();
    this.save('java.path', value);
  }

  /** Valide les arguments JVM saisis, puis les persiste s'ils sont acceptables. */
  onJvmArgsInput() {
    const { show, hide, setText } = this.ctx.dom;
    const value = this.el.jvmArgs.value;
    const error = this.el.jvmArgsError;

    let message = '';
    if (JVM_MEMORY_FLAG.test(value)) {
      message = 'La mémoire se règle avec les curseurs ci-dessus : retirez -Xms et -Xmx.';
    } else if ((value.match(/"/g) ?? []).length % 2 !== 0) {
      message = 'Guillemet non refermé : la ligne d\'arguments serait mal découpée.';
    }

    if (message) {
      setText(error, message);
      show(error);
      return;
    }

    hide(error);
    this.save('java.args', value.trim());
  }

  /* ------------------------------------------------------------ RÉSOLUTION */

  /**
   * Champ de résolution modifié.
   *
   * Pendant la frappe (`commit` faux) seul l'aperçu suit : une largeur en cours
   * de saisie (« 1 » avant « 1920 ») ne doit pas être écrite sur le disque, où
   * elle serait aussitôt ramenée à la borne minimale. La validation du champ,
   * elle, contraint la valeur et l'enregistre.
   *
   * @param {HTMLInputElement} field
   * @param {boolean} commit vrai à la validation du champ
   */
  onResolutionInput(field, commit) {
    const key = field.dataset.key;
    const raw = Number(field.value);

    if (!Number.isFinite(raw) || raw <= 0) {
      if (commit) this.applyConfig();
      return;
    }

    const value = commit
      ? clamp(Math.round(raw), Number(field.min), Number(field.max))
      : Math.round(raw);

    if (commit) field.value = String(value);

    const game = { ...this.config.game, [key.split('.')[1]]: value };
    this.config = { ...this.config, game };

    this.renderResolution();
    if (commit) this.save(key, value);
  }

  /**
   * Applique une résolution prédéfinie.
   * @param {string} preset au format « 1920x1080 »
   */
  applyPreset(preset) {
    const [width, height] = preset.split('x').map(Number);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;

    this.config = { ...this.config, game: { ...this.config.game, width, height } };

    if (this.el.resWidth) this.el.resWidth.value = String(width);
    if (this.el.resHeight) this.el.resHeight.value = String(height);

    this.renderResolution();
    this.save('game.width', width);
    this.save('game.height', height);
  }

  /** Puce active, aperçu de proportions et libellé du rapport. */
  renderResolution() {
    const width = this.config?.game?.width ?? 0;
    const height = this.config?.game?.height ?? 0;

    const current = `${width}x${height}`;
    for (const preset of this.el.presets) {
      preset.classList.toggle('opm-preset--active', preset.dataset.preset === current);
    }

    if (width <= 0 || height <= 0) return;

    // L'aperçu fait 96 px de large (panels/settings.css) : seule sa hauteur est
    // calculée, elle porte tout le rapport d'affichage.
    if (this.el.resPreview) {
      this.el.resPreview.style.height = `${Math.round((96 * height) / width)}px`;
    }

    const divisor = gcd(width, height) || 1;
    this.ctx.dom.setText(
      this.ctx.dom.$('[data-bind="res-ratio"]', this.root),
      `${width / divisor} : ${height / divisor}`,
    );
  }

  /* -------------------------------------------------------------- LAUNCHER */

  /**
   * Construit l'encart de version du sous-écran LAUNCHER.
   *
   * Le processus principal calcule déjà le verdict de version
   * (`bootstrap.launcher.version_current` et `update_required`, docs/IPC.md
   * § Amorçage) et personne ne le lisait : le joueur d'un launcher trop ancien
   * butait sur des refus que rien ne lui expliquait. Les points d'ancrage sont
   * désormais déclarés dans `src/panels/settings.html`, comme le veut la règle du
   * projet (balisage statique, le JS ne fait que peupler) : cette méthode se
   * contente donc de les retrouver. La construction de repli n'est conservée que
   * pour le cas où le fragment ne les porterait pas — un panneau amputé ne doit
   * pas faire disparaître silencieusement l'avertissement de mise à jour.
   *
   * @returns {Object} points d'ancrage à fusionner dans `this.el`
   */
  buildLauncherVersion() {
    const { $, el } = this.ctx.dom;

    const host = this.el.subscreens.find((node) => node.dataset.sub === 'launcher');
    if (!host) return {};

    if (!$('[data-bind="launcher-version"]', host)) {
      host.append(
        el('p', { class: 'opm-kicker' }, [
          el('span', { class: 'opm-kicker__dot', 'aria-hidden': 'true' }),
          'VERSION',
        ]),
        el('h2', { text: 'VERSION DU LAUNCHER' }),
        el('div', { class: 'opm-row' }, [
          el('div', { class: 'opm-row__text' }, [
            el('p', { class: 'opm-row__title', dataset: { bind: 'launcher-version' } }),
            el('p', { class: 'opm-row__desc', dataset: { el: 'launcher-latest' }, hidden: true }),
          ]),
          el('button', {
            type: 'button',
            class: ['opm-btn', 'opm-btn--aqua'],
            dataset: { action: 'download-launcher' },
            text: 'TÉLÉCHARGER',
            hidden: true,
          }),
        ]),
        el('p', {
          class: 'opm-note--warn',
          dataset: { el: 'launcher-update' },
          role: 'status',
          hidden: true,
        }),
      );
    }

    return {
      launcherVersion: $('[data-bind="launcher-version"]', host),
      launcherLatest: $('[data-el="launcher-latest"]', host),
      launcherUpdate: $('[data-el="launcher-update"]', host),
      launcherDownload: $('[data-action="download-launcher"]', host),
    };
  }

  /**
   * Version installée, et verdict du serveur sur cette version.
   *
   * Rien n'est bloqué ici : l'écran informe. Il dit la version qui tourne, la
   * dernière publiée quand le serveur l'annonce, et — quand le serveur n'accepte
   * plus celle-ci — pourquoi le jeu ne partira pas, avec le bouton qui mène au
   * téléchargement.
   */
  paintLauncher() {
    const { setText, toggle } = this.ctx.dom;
    if (!this.el.launcherVersion) return;

    const state = this.ctx.store.get();
    const launcher = state.bootstrap?.launcher ?? null;

    // `version_current` est calculé par le processus principal ; sans amorçage
    // — serveur injoignable — le magasin garde tout de même la version lue au
    // démarrage par `app.version()`, qui ne dépend d'aucun réseau.
    const current = trimmed(launcher?.version_current) || trimmed(state.version);
    setText(this.el.launcherVersion, current ? `Version ${current}` : 'Version inconnue');

    // « Dernière version publiée », et jamais « une version plus récente
    // existe » : comparer deux numéros ici, alors que le processus principal a
    // déjà tranché ce qui compte, reviendrait à inventer un second verdict.
    const latest = trimmed(launcher?.version_latest);
    const showLatest = latest !== '' && latest !== current;

    if (showLatest) setText(this.el.launcherLatest, `Dernière version publiée : ${latest}.`);
    toggle(this.el.launcherLatest, showLatest);

    const url = trimmed(launcher?.download_url);
    const required = launcher?.update_required === true;
    const minimum = trimmed(launcher?.version_min);

    if (required) {
      setText(this.el.launcherUpdate, [
        "Cette version du launcher n'est plus acceptée par le serveur",
        minimum ? ` (version minimale exigée : ${minimum})` : '',
        ". Le jeu ne pourra pas être lancé tant qu'elle n'aura pas été mise à jour.",
        url ? '' : " Le serveur n'a pas publié d'adresse de téléchargement : rendez-vous sur le site officiel.",
      ].join(''));
    }

    toggle(this.el.launcherUpdate, required);
    toggle(this.el.launcherDownload, required && url !== '');
  }

  /** Ouvre l'adresse de téléchargement publiée par le serveur. */
  downloadLauncher() {
    const url = trimmed(this.ctx.store.get().bootstrap?.launcher?.download_url);
    if (url) this.ctx.openExternal(url);
  }

  /** Affiche le dossier réel du jeu. */
  async loadGameDir() {
    try {
      const dir = await this.ctx.opm.app.gameDir();
      this.gameDir = dir;
      this.ctx.dom.setText(this.ctx.dom.$('[data-bind="game-dir"]', this.root), dir);
    } catch (error) {
      this.ctx.log('warn', `Dossier du jeu inconnu : ${error?.message ?? error}`);
    }
  }

  /** Ouvre le dossier du jeu dans l'explorateur du système. */
  async openGameDir() {
    if (!this.gameDir) return;

    try {
      await this.ctx.opm.app.openPath(this.gameDir);
    } catch (error) {
      this.reportFailure(error, 'Ouverture du dossier impossible',
        "L'explorateur de fichiers n'a pas pu être lancé sur le dossier du jeu.");
    }
  }

  /**
   * Vide le cache et rend compte de l'espace réellement libéré.
   * @param {HTMLButtonElement} button
   */
  async clearCache(button) {
    button.disabled = true;

    try {
      const result = await this.ctx.opm.game.clearCache();
      const freed = result?.freed_bytes ?? 0;

      // Seule taille de cache réelle dont dispose le launcher : celle que le
      // vidage vient de libérer. Elle reste affichée sur le bouton jusqu'au
      // prochain affichage du panneau, où elle n'a plus cours.
      this.ctx.dom.setText(
        this.ctx.dom.$('[data-bind="cache-size"]', this.root),
        this.ctx.format.bytes(freed),
      );

      this.ctx.toast({
        kind: 'success',
        title: 'Cache vidé',
        message: freed > 0
          ? `${this.ctx.format.bytes(freed)} libérés sur votre disque.`
          : "Le cache était déjà vide : rien à libérer.",
      });
    } catch (error) {
      this.reportFailure(error, 'Vidage du cache impossible',
        "Le cache du launcher n'a pas pu être vidé.");
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Contrôle intégral des fichiers du jeu.
   *
   * `game.verifyFiles()` existait et n'était appelé de nulle part : toute la
   * mécanique de vérification sans lancement du processus principal était
   * inatteignable. La progression s'affiche dans la barre du bas, comme pour un
   * téléchargement. Le bouton ANNULER de cette barre reste en revanche **inactif**
   * pendant l'opération : le seul levier d'annulation dont dispose le launcher est
   * le renoncement au démarrage de la machine virtuelle, et une vérification n'en
   * démarre aucune. Elle va donc à son terme (voir `main/services/game.js:cancel`).
   *
   * @param {HTMLButtonElement} button
   */
  async verifyFiles(button) {
    const confirmed = await this.ctx.confirmModal({
      title: 'Vérifier les fichiers du jeu ?',
      message: 'Le launcher contrôle chaque fichier de l\'instance et retélécharge ceux qui '
        + 'manquent ou qui ont été modifiés. Le jeu ne démarre pas à la fin. Selon votre '
        + 'connexion, l\'opération peut durer plusieurs minutes.',
      confirmLabel: 'VÉRIFIER',
    });
    if (!confirmed) return;

    button.disabled = true;

    try {
      await this.ctx.opm.game.verifyFiles();
      this.ctx.toast({
        kind: 'success',
        title: 'Fichiers vérifiés',
        message: 'Votre installation correspond à celle du serveur.',
      });
    } catch (error) {
      this.reportFailure(error, 'Vérification impossible',
        "Les fichiers du jeu n'ont pas pu être vérifiés.");
    } finally {
      button.disabled = false;
      this.loadFilesStat();
    }
  }

  /** Encart « ÉTAT DES FICHIERS » de la colonne de navigation. */
  async loadFilesStat() {
    const { setText, $ } = this.ctx.dom;

    try {
      const stat = await this.ctx.opm.game.filesStat();
      if (!stat) return;

      setText($('[data-bind="files-count"]', this.root), this.ctx.format.nf(stat.files ?? 0));
      setText($('[data-bind="files-size"]', this.root), this.ctx.format.bytes(stat.bytes ?? 0));
      setText($('[data-bind="files-checked"]', this.root), this.ctx.format.relTime(stat.checked_at));
    } catch (error) {
      // L'encart garde son squelette : pas de vérification connue, pas de chiffre.
      this.ctx.log('warn', `État des fichiers indisponible : ${error?.message ?? error}`);
    }
  }

  /* ------------------------------------------------------- RÉINITIALISATION */

  /** Remet toute la configuration locale à ses valeurs d'usine. */
  async resetEverything() {
    const confirmed = await this.ctx.confirmModal({
      title: 'Tout réinitialiser ?',
      message: 'Mémoire, Java, résolution et options du launcher reviendront à leurs valeurs '
        + "d'usine. Vos comptes et vos fichiers de jeu ne sont pas touchés.",
      confirmLabel: 'RÉINITIALISER',
      danger: true,
    });
    if (!confirmed) return;

    // Une écriture encore en attente écraserait la remise à zéro juste après.
    this.pendingPatch = null;
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    try {
      this.config = await this.ctx.opm.config.reset();
      this.ctx.store.set({ config: this.config });
      this.applyConfig();
      await this.loadMemory();

      this.ctx.toast({
        kind: 'success',
        title: 'Paramètres réinitialisés',
        message: 'Le launcher est revenu à sa configuration par défaut.',
      });
    } catch (error) {
      this.reportFailure(error, 'Réinitialisation impossible',
        "La configuration n'a pas pu être remise à ses valeurs d'usine.");
    }
  }
}
