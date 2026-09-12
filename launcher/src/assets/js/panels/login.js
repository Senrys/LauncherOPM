/**
 * ÉCRAN DE CONNEXION — pilote la section `[data-screen="login"]` de launcher.html.
 *
 * Cinq vues dans une même carte, sélectionnées par `data-view` :
 *   login · totp · register · forgot · link
 *
 * Le modèle d'authentification est le mode hybride imposé (docs/API.md § 0) :
 * le compte One Piece Minecraft ouvre la session, un compte Microsoft sert
 * d'oracle de possession, et c'est notre serveur qui délivre la session de jeu.
 * L'écran traduit donc `microsoft_required` en vue « rattachement », jamais en
 * message d'erreur sec.
 *
 * Règles tenues par ce module :
 *  - aucun mot de passe n'est journalisé, ni écrit dans le magasin, ni conservé
 *    au-delà de la double étape connexion → code de vérification ;
 *  - la confirmation d'un rattachement réussi reste à l'écran, au-dessus de
 *    l'application si le routage l'y a fait passer, jusqu'à ce que le joueur
 *    l'acquitte : une étape que personne ne voit n'est pas une étape ;
 *  - cette surimpression n'a lieu QUE pendant un rattachement réellement demandé
 *    ici : sans ce garde, changer de compte dans la barre du bas rouvrait la
 *    connexion en plein écran par-dessus l'application ;
 *  - les messages d'erreur viennent de `utils/labels.js`, seule table du
 *    launcher (docs/API.md § 3) ;
 *  - la sélection se fait exclusivement par attribut `data-*` (la seule
 *    exception est la résolution de `aria-controls`, qui désigne un `id`).
 */

import { blockedLabel, errorLabel } from '../utils/labels.js';

/* ========================================================================== */
/*  Constantes                                                                */
/* ========================================================================== */

/**
 * Événement par lequel un panneau réclame l'écran de connexion alors que
 * l'application est déjà ouverte (« + AJOUTER UN COMPTE »). Le routage du
 * renderer se décide à partir du compte courant : il ne peut pas, seul,
 * ramener un joueur connecté vers la connexion. L'écran se montre alors en
 * surimpression (il est en `position: fixed`, au-dessus de la coque).
 */
const LOGIN_REQUEST_EVENT = 'opm:request-login';

/** Longueur minimale d'un mot de passe à l'inscription (docs/DATA.md § 3). */
const PASSWORD_MIN = 12;

/** Pseudo d'équipage : 3 à 16 caractères alphanumériques ou tiret bas. */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

/**
 * Adresse e-mail : contrôle de forme, volontairement permissif. La seule
 * validation qui fasse foi reste celle du serveur.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Nombre de cases du code de vérification. */
const OTP_LENGTH = 6;

/* ========================================================================== */
/*  Aides locales                                                             */
/* ========================================================================== */

/**
 * Ramène une réponse ou une exception à une forme unique.
 *
 * `auth.login()` / `auth.register()` rendent un `LoginResult` (`{ok:false,
 * error, message}`) ; le préchargement, lui, transforme les enveloppes
 * d'erreur du processus principal en `Error` portant `.code` et `.details`.
 *
 * @param {unknown} value réponse métier ou exception
 * @returns {{ok: boolean, account: Object|null, code: string, message: string, details: *}}
 */
function normalizeResult(value) {
  if (value instanceof Error) {
    return {
      ok: false,
      account: null,
      code: typeof value.code === 'string' ? value.code : '',
      message: value.message ?? '',
      details: value.details,
    };
  }

  if (value && typeof value === 'object' && value.ok === true) {
    return { ok: true, account: value.account ?? null, code: '', message: '', details: null };
  }

  return {
    ok: false,
    account: null,
    code: typeof value?.error === 'string' ? value.error : '',
    message: typeof value?.message === 'string' ? value.message : '',
    details: value?.details ?? null,
  };
}

/**
 * Robustesse d'un mot de passe, exprimée en une phrase actionnable.
 *
 * L'inventaire de classes ne prévoit pas de jauge de robustesse : l'indication
 * se donne donc là où le joueur la lit déjà, sous le champ, et elle disparaît
 * dès que le mot de passe n'appelle plus de remarque.
 *
 * @param {string} value
 * @returns {{ok: boolean, message: string}} `ok` faux = saisie refusée
 */
function passwordStrength(value) {
  if (value.length < PASSWORD_MIN) {
    const missing = PASSWORD_MIN - value.length;
    return {
      ok: false,
      message: `Trop court : ${PASSWORD_MIN} caractères minimum, il en manque ${missing}.`,
    };
  }

  let variety = 0;
  if (/[a-z]/.test(value)) variety += 1;
  if (/[A-Z]/.test(value)) variety += 1;
  if (/[0-9]/.test(value)) variety += 1;
  if (/[^A-Za-z0-9]/.test(value)) variety += 1;

  // Un mot de passe long compense une variété plus faible : c'est la longueur
  // qui protège le mieux d'une attaque par force brute.
  const score = variety + (value.length >= 20 ? 2 : value.length >= 16 ? 1 : 0);

  if (score <= 2) {
    return {
      ok: true,
      message: 'Robustesse faible : mélangez majuscules, chiffres et symboles, ou allongez-le.',
    };
  }
  if (score === 3) {
    return {
      ok: true,
      message: 'Robustesse correcte : quelques caractères de plus le rendraient solide.',
    };
  }
  return { ok: true, message: '' };
}

/* ========================================================================== */
/*  Écran                                                                     */
/* ========================================================================== */

export default class LoginScreen {
  static id = 'login';

  /**
   * Monte l'écran : références, câblage, vue de départ.
   * @param {Object} ctx contexte fourni par le renderer
   */
  async init(ctx) {
    this.ctx = ctx;
    this.root = ctx.root;

    const { $, $$ } = ctx.dom;

    /** Vue affichée. */
    this.view = ctx.store.get().loginView ?? 'login';

    /**
     * Identifiants retenus le temps de la double étape connexion → code de
     * vérification : l'API réclame e-mail, mot de passe ET code dans le même
     * appel. Effacés dès que l'étape est franchie, abandonnée ou en échec.
     * @type {{email: string, password: string}|null}
     */
    this.pending = null;

    /** Descriptif du flux « device » en cours, quand le serveur l'impose. */
    this.device = null;

    /**
     * Un rattachement Microsoft a été demandé DEPUIS CET ÉCRAN et n'a pas encore
     * été acquitté.
     *
     * `this.view` ne suffit pas à garder l'abonnement au magasin : elle reste à
     * `'link'` après un rattachement réussi, et le moindre compte diffusé
     * ensuite — changement de compte dans la barre du bas, re-vérification
     * depuis les Paramètres, activation de la 2FA, simple rafraîchissement —
     * rouvrait alors la carte « Possession vérifiée » EN PLEIN ÉCRAN par-dessus
     * l'application. Ce drapeau distingue « le joueur attend une confirmation »
     * de « la vue de rattachement est simplement celle affichée ».
     */
    this.linkInProgress = false;

    /** Libération du piège de focus, en mode surimpression. */
    this.overlayRelease = null;

    /**
     * Une confirmation de rattachement est affichée et attend son EMBARQUER.
     *
     * Le renderer bascule sur l'application dès que le compte devient jouable —
     * dans la même micro-tâche que l'affichage de la carte. Sans ce drapeau, la
     * confirmation (tête de skin, pseudo Minecraft, échéance) et son bouton ne
     * seraient jamais vus : l'écran sauterait sur l'accueil. On la maintient
     * donc au-dessus de l'application jusqu'à ce que le joueur l'ait acquittée.
     */
    this.awaitingLinkAck = false;

    this.el = {
      views: $$('[data-view]', this.root),

      formLogin: $('[data-el="form-login"]', this.root),
      loginEmail: $('[data-el="login-email"]', this.root),
      loginPassword: $('[data-el="login-password"]', this.root),
      loginError: $('[data-el="login-error"]', this.root),

      formTotp: $('[data-el="form-totp"]', this.root),
      totpError: $('[data-el="totp-error"]', this.root),
      otp: $('[data-el="otp"]', this.root),
      otpBoxes: $$('[data-el="otp-box"]', this.root),
      recoveryField: $('[data-el="recovery-field"]', this.root),
      recovery: $('[data-el="totp-recovery"]', this.root),

      formRegister: $('[data-el="form-register"]', this.root),
      registerUsername: $('[data-el="register-username"]', this.root),
      registerEmail: $('[data-el="register-email"]', this.root),
      registerPassword: $('[data-el="register-password"]', this.root),
      registerConfirm: $('[data-el="register-confirm"]', this.root),
      registerError: $('[data-el="register-error"]', this.root),

      formForgot: $('[data-el="form-forgot"]', this.root),
      forgotEmail: $('[data-el="forgot-email"]', this.root),
      forgotError: $('[data-el="forgot-error"]', this.root),
      forgotSent: $('[data-el="forgot-sent"]', this.root),

      registerInvite: $('[data-el="register-invite"]', this.root),

      linkError: $('[data-el="link-error"]', this.root),
      linkButton: $('[data-el="link-button"]', this.root),
      linkSpinner: $('[data-el="link-spinner"]', this.root),
      linkLabel: $('[data-bind="link-label"]', this.root),
      linkDevice: $('[data-el="link-device"]', this.root),
      linkCancel: $('[data-el="link-cancel"]', this.root),
      linkCode: $('[data-bind="ms-user-code"]', this.root),
      linkResult: $('[data-el="link-result"]', this.root),
      linkHead: $('[data-el="link-head"]', this.root),
      linkName: $('[data-bind="ms-name"]', this.root),
      linkMeta: $('[data-bind="ms-meta"]', this.root),
      linkContinue: $('[data-el="link-continue"]', this.root),
    };

    /** Libellé d'origine du bouton de rattachement, restauré après une attente. */
    this.linkIdleLabel = this.el.linkLabel?.textContent ?? '';

    /** Le code de secours remplace les six cases. */
    this.recoveryMode = false;

    // L'écran est monté une seule fois pour la durée de la fenêtre : les
    // abonnements posés ici n'ont jamais à être relâchés.
    this.wireForms();
    this.wireActions();
    this.wireOtp();

    ctx.store.subscribe((state, changed) => {
      if (changed.has('loginView') && state.loginView !== this.view) {
        this.setView(state.loginView);
      }
      if (changed.has('bootstrap')) this.applyRegistrationPolicy(state.bootstrap);

      // Le renderer vient de faire passer l'application au premier plan alors
      // que la confirmation de rattachement n'a pas été acquittée : on la
      // maintient au-dessus de la coque plutôt que de la laisser disparaître.
      if (changed.has('screen') && state.screen !== 'login' && this.awaitingLinkAck) {
        this.holdOverApp();
      }

      // Trois conditions, pas deux : le compte a bougé, la vue de rattachement
      // est celle affichée, ET un rattachement est réellement en cours ici.
      // Sans la troisième, `this.view` restant à `'link'` après un rattachement
      // réussi, chaque diffusion de compte ultérieure rouvrait cet écran par
      // surimpression sur l'application.
      if (!changed.has('account') || this.view !== 'link' || !this.linkInProgress) return;

      // Flux « device » : le code à saisir voyage dans le champ `link_device`
      // du compte diffusé par `auth.onChange()` (docs/IPC.md § Types). Le
      // processus principal le publie AVANT d'entrer dans sa boucle de
      // scrutation et le retire dès qu'elle s'achève — quelle qu'en soit
      // l'issue : l'affichage suit donc exactement la validité du code.
      const device = this.deviceOf(state.account);
      if (device) this.showDevice(device);
      else if (this.device) this.hideDevice();

      // Le rattachement se termine côté processus principal : c'est le compte
      // mis à jour qui annonce le succès.
      if (state.account?.minecraft) this.showLinkResult(state.account);
    });

    // Demande d'ajout de compte venue d'un autre panneau.
    ctx.dom.on(document, LOGIN_REQUEST_EVENT, (event) => {
      this.openOverlay(event.detail?.view ?? 'login');
    });

    this.applyRegistrationPolicy(ctx.store.get().bootstrap);
    this.setView(this.view);
  }

  /**
   * Retire l'invitation à créer un compte quand le serveur a fermé les
   * inscriptions (`bootstrap.auth.registration_open`).
   *
   * Laisser le lien offert ne repousserait l'échec qu'après un formulaire
   * entièrement rempli : une porte fermée doit se voir avant qu'on la pousse.
   * Un bootstrap absent (serveur injoignable) ne ferme rien : seul un `false`
   * explicite le fait.
   *
   * @param {Object|null|undefined} bootstrap
   */
  applyRegistrationPolicy(bootstrap) {
    const closed = bootstrap?.auth?.registration_open === false;

    this.ctx.dom.toggle(this.el.registerInvite, !closed);

    // La vue d'inscription reste atteignable par le magasin : on n'y laisse pas
    // entrer un joueur pour rien.
    if (closed && this.view === 'register') this.setView('login', { sync: true });
  }

  /* ---------------------------------------------------------------- câblage */

  /** Soumission des quatre formulaires. */
  wireForms() {
    const { on } = this.ctx.dom;

    const forms = [
      [this.el.formLogin, () => this.submitLogin()],
      [this.el.formTotp, () => this.submitTotp()],
      [this.el.formRegister, () => this.submitRegister()],
      [this.el.formForgot, () => this.submitForgot()],
    ];

    for (const [form, handler] of forms) {
      if (!form) continue;
      on(form, 'submit', (event) => {
        event.preventDefault();
        handler();
      });
    }

    // Indication de robustesse en direct, sous le champ de création.
    if (this.el.registerPassword) {
      on(this.el.registerPassword, 'input', () => {
        const value = this.el.registerPassword.value;
        if (value === '') {
          this.clearFieldError('register-password');
          return;
        }
        this.setFieldError('register-password', passwordStrength(value).message);
      });
    }
  }

  /** Tous les `data-action` de l'écran, en délégation depuis la racine. */
  wireActions() {
    const { delegate } = this.ctx.dom;

    const actions = {
      'view-login': () => this.setView('login', { sync: true }),
      'view-register': () => this.setView('register', { sync: true }),
      'view-forgot': () => this.setView('forgot', { sync: true }),
      'toggle-password': (target) => this.togglePassword(target),
      'use-recovery-code': (target) => this.toggleRecovery(target),
      'link-microsoft': () => this.linkMicrosoft(),
      'copy-code': () => this.copyDeviceCode(),
      'open-ms-link': () => this.openDeviceLink(),
      'cancel-link': (target) => this.cancelLink(target),
      'link-continue': () => this.leave(),
      logout: () => this.logout(),
    };

    for (const [name, handler] of Object.entries(actions)) {
      delegate(this.root, 'click', `[data-action="${name}"]`, (event, target) => {
        handler(target);
      });
    }

    // En surimpression, Échap referme : le joueur ne doit jamais rester coincé
    // devant une connexion qu'il n'a demandée que pour ajouter un compte.
    this.ctx.dom.on(this.root, 'keydown', (event) => {
      if (event.key !== 'Escape' || !this.overlayRelease) return;
      event.preventDefault();
      this.closeOverlay();
    });
  }

  /* ------------------------------------------------------------------ vues */

  /**
   * Bascule de vue : une seule visible, focus sur son premier champ.
   * @param {string} name login | totp | register | forgot | link
   * @param {{sync?: boolean, focus?: boolean}} [options] `sync` répercute le
   *   choix dans le magasin ; `focus` à faux remet la vue en place sans réclamer
   *   le clavier — c'est ce qu'il faut en partant vers l'application.
   */
  setView(name, { sync = false, focus = true } = {}) {
    const target = this.el.views.find((node) => node.dataset.view === name);
    if (!target) return;

    const previous = this.view;
    this.view = name;

    for (const node of this.el.views) {
      node.hidden = node !== target;
    }

    // Quitter la vue du code de vérification abandonne l'étape en cours : les
    // identifiants retenus n'ont plus de raison d'exister.
    if (name !== 'totp') this.forgetCredentials();

    // On entre sur le rattachement : aucune confirmation d'une tentative
    // précédente ne doit subsister — mais un rattachement EN COURS, lui, doit
    // retrouver son code. Le processus principal ne le publie qu'une fois,
    // avant sa boucle de scrutation : une remise à zéro aveugle l'effacerait
    // pour de bon, et le joueur se retrouverait devant une page Microsoft qui
    // réclame un code introuvable.
    if (name === 'link' && previous !== 'link') this.enterLinkView();

    this.clearErrors();
    if (sync) this.ctx.setLoginView(name);

    // Tant que l'écran n'est pas affiché (splash, application au premier plan),
    // on ne vole pas le focus au reste de l'interface.
    if (!focus || this.root.hidden) return;

    const first = target.querySelector('input:not([type="hidden"])');
    if (first && !first.closest('[hidden]')) first.focus({ preventScroll: true });
  }

  /** Efface tous les bandeaux et messages d'erreur de la carte. */
  clearErrors() {
    const { hide } = this.ctx.dom;

    for (const node of [this.el.loginError, this.el.totpError, this.el.registerError,
      this.el.forgotError, this.el.linkError, this.el.forgotSent]) {
      hide(node);
    }

    for (const name of ['login-email', 'login-password', 'register-username', 'register-email',
      'register-password', 'register-confirm', 'forgot-email']) {
      this.clearFieldError(name);
    }
  }

  /**
   * Affiche un bandeau d'erreur en tête de vue.
   * @param {Element|null} node
   * @param {string} message
   */
  showBanner(node, message) {
    if (!node) return;
    this.ctx.dom.setText(node, message);
    this.ctx.dom.show(node);
  }

  /**
   * Affiche (ou masque) le message d'un champ.
   * @param {string} name préfixe du `data-el` (« login-email » → « login-email-error »)
   * @param {string} message chaîne vide = message masqué
   */
  setFieldError(name, message) {
    const node = this.ctx.dom.$(`[data-el="${name}-error"]`, this.root);
    if (!node) return;

    if (message === '') {
      this.ctx.dom.hide(node);
      return;
    }
    this.ctx.dom.setText(node, message);
    this.ctx.dom.show(node);
  }

  /**
   * Masque le message d'un champ.
   * @param {string} name
   */
  clearFieldError(name) {
    this.setFieldError(name, '');
  }

  /**
   * Traduit un code d'erreur de l'API en phrase française.
   *
   * La table est partagée (`utils/labels.js`) ; ne restent ici que les deux
   * détails qui varient d'un appel à l'autre et qu'aucune table ne peut
   * connaître à l'avance : la date de levée d'une suspension et le texte libre
   * d'une maintenance. Le message du serveur sert de repli — refusé par
   * `errorLabel()` s'il n'est qu'un code déguisé en phrase.
   *
   * @param {{code: string, message: string, details: *}} result
   * @returns {string}
   */
  messageFor(result) {
    const label = errorLabel(result.code, result.message);

    if (result.code === 'banned' && result.details?.until) {
      const until = this.ctx.format.dateFr(result.details.until, { withYear: true, withTime: true });
      return `${label.message} Levée prévue le ${until}.`;
    }
    if (result.code === 'maintenance' && result.details?.message) {
      return result.details.message;
    }
    return label.message;
  }

  /* ------------------------------------------------------------ mots de passe */

  /**
   * Bouton œil : révèle ou masque le champ que désigne `aria-controls`.
   * @param {HTMLButtonElement} button
   */
  togglePassword(button) {
    const id = button.getAttribute('aria-controls');
    const input = id ? this.root.querySelector(`[id="${id}"]`) : null;
    if (!input) return;

    const revealed = input.type === 'text';
    input.type = revealed ? 'password' : 'text';

    button.setAttribute('aria-pressed', revealed ? 'false' : 'true');
    button.setAttribute('aria-label', revealed ? 'Afficher le mot de passe' : 'Masquer le mot de passe');

    const open = this.ctx.dom.$('[data-el="eye-open"]', button);
    const closed = this.ctx.dom.$('[data-el="eye-closed"]', button);
    if (open) open.hidden = !revealed;
    if (closed) closed.hidden = revealed;

    input.focus({ preventScroll: true });
  }

  /** Oublie les identifiants retenus pour la double étape. */
  forgetCredentials() {
    this.pending = null;
  }

  /* ------------------------------------------------------- code de vérification */

  /** Saisie, collage et navigation clavier des six cases. */
  wireOtp() {
    const { on } = this.ctx.dom;
    const boxes = this.el.otpBoxes;
    if (boxes.length === 0) return;

    boxes.forEach((box, index) => {
      on(box, 'input', () => {
        // Un clavier de téléphone peut livrer le code entier dans une case.
        const digits = box.value.replace(/\D/g, '');
        if (digits.length > 1) {
          this.fillOtp(digits, index);
          return;
        }

        box.value = digits;
        if (digits !== '' && index < boxes.length - 1) boxes[index + 1].focus();
      });

      on(box, 'keydown', (event) => {
        if (event.key === 'Backspace' && box.value === '' && index > 0) {
          event.preventDefault();
          boxes[index - 1].value = '';
          boxes[index - 1].focus();
        } else if (event.key === 'ArrowLeft' && index > 0) {
          event.preventDefault();
          boxes[index - 1].focus();
        } else if (event.key === 'ArrowRight' && index < boxes.length - 1) {
          event.preventDefault();
          boxes[index + 1].focus();
        }
      });

      on(box, 'paste', (event) => {
        event.preventDefault();
        const text = event.clipboardData?.getData('text') ?? '';
        this.fillOtp(text.replace(/\D/g, ''), index);
      });

      // La case reprise se sélectionne : une nouvelle frappe remplace le chiffre.
      on(box, 'focus', () => box.select());
    });
  }

  /**
   * Répartit une suite de chiffres dans les cases, à partir de l'une d'elles.
   * @param {string} digits
   * @param {number} from index de départ
   */
  fillOtp(digits, from) {
    const boxes = this.el.otpBoxes;
    let index = from;

    for (const digit of digits) {
      if (index >= boxes.length) break;
      boxes[index].value = digit;
      index += 1;
    }
    boxes[Math.min(index, boxes.length - 1)].focus();
  }

  /** Vide les six cases et le champ de code de secours. */
  resetOtp() {
    for (const box of this.el.otpBoxes) box.value = '';
    if (this.el.recovery) this.el.recovery.value = '';
  }

  /**
   * Bascule entre les six cases et le champ de code de secours.
   * @param {HTMLButtonElement} button
   */
  toggleRecovery(button) {
    const { show, hide } = this.ctx.dom;
    this.recoveryMode = !this.recoveryMode;

    if (this.recoveryMode) {
      hide(this.el.otp);
      show(this.el.recoveryField);
      button.textContent = 'Utiliser le code à six chiffres';
      this.el.recovery?.focus({ preventScroll: true });
    } else {
      show(this.el.otp);
      hide(this.el.recoveryField);
      button.textContent = 'Utiliser un code de secours';
      this.el.otpBoxes[0]?.focus({ preventScroll: true });
    }
  }

  /* -------------------------------------------------------------- connexion */

  /** Vérifie puis envoie le formulaire de connexion. */
  async submitLogin() {
    this.clearErrors();

    const email = this.el.loginEmail.value.trim();
    const password = this.el.loginPassword.value;
    let valid = true;

    if (!EMAIL_PATTERN.test(email)) {
      this.setFieldError('login-email', 'Adresse e-mail incomplète ou mal formée.');
      valid = false;
    }
    if (password === '') {
      this.setFieldError('login-password', 'Saisissez votre mot de passe.');
      valid = false;
    }
    if (!valid) return;

    await this.attempt(this.el.formLogin, this.el.loginError, () => {
      // Retenus avant l'appel, car la 2FA peut être réclamée aussi bien par une
      // réponse `{ok:false, error:'totp_required'}` que par une exception. Ils
      // sont effacés dès la réussite, ou dès que l'écran change de vue.
      this.pending = { email, password };
      return this.ctx.opm.auth.login({ email, password });
    });
  }

  /** Valide le code à six chiffres ou le code de secours. */
  async submitTotp() {
    this.clearErrors();

    const code = this.recoveryMode
      ? this.el.recovery.value.trim()
      : this.el.otpBoxes.map((box) => box.value).join('');

    if (!this.recoveryMode && code.length !== OTP_LENGTH) {
      this.showBanner(this.el.totpError, `Le code compte ${OTP_LENGTH} chiffres.`);
      return;
    }
    if (this.recoveryMode && code === '') {
      this.showBanner(this.el.totpError, 'Saisissez l\'un de vos codes de secours.');
      return;
    }

    if (!this.pending) {
      // Les identifiants ont été oubliés (changement de vue, écran rechargé) :
      // on repart proprement de la connexion plutôt que d'échouer en silence.
      this.setView('login', { sync: true });
      this.showBanner(this.el.loginError, 'Reprenez la connexion : la vérification a expiré.');
      return;
    }

    const { email, password } = this.pending;

    await this.attempt(this.el.formTotp, this.el.totpError, async () => {
      const result = await this.ctx.opm.auth.login({ email, password, totp: code });
      const normalized = normalizeResult(result);
      if (normalized.ok || normalized.code !== 'totp_invalid') this.forgetCredentials();
      if (!normalized.ok) this.resetOtp();
      return result;
    });
  }

  /** Vérifie puis envoie le formulaire de création de compte. */
  async submitRegister() {
    this.clearErrors();

    const username = this.el.registerUsername.value.trim();
    const email = this.el.registerEmail.value.trim();
    const password = this.el.registerPassword.value;
    const confirm = this.el.registerConfirm.value;
    let valid = true;

    if (!USERNAME_PATTERN.test(username)) {
      this.setFieldError('register-username',
        'De 3 à 16 caractères : lettres, chiffres et tiret bas uniquement.');
      valid = false;
    }
    if (!EMAIL_PATTERN.test(email)) {
      this.setFieldError('register-email', 'Adresse e-mail incomplète ou mal formée.');
      valid = false;
    }

    const strength = passwordStrength(password);
    this.setFieldError('register-password', strength.message);
    if (!strength.ok) valid = false;

    if (confirm !== password) {
      this.setFieldError('register-confirm', 'Les deux mots de passe ne correspondent pas.');
      valid = false;
    }
    if (!valid) return;

    await this.attempt(this.el.formRegister, this.el.registerError, async () => {
      const result = await this.ctx.opm.auth.register({ email, password, username });
      // Le rattachement Microsoft est demandé juste après : la double étape de
      // vérification, elle, ne concerne pas un compte tout neuf.
      this.forgetCredentials();
      return result;
    });
  }

  /** Envoie une demande de réinitialisation de mot de passe. */
  async submitForgot() {
    this.clearErrors();

    const email = this.el.forgotEmail.value.trim();
    if (!EMAIL_PATTERN.test(email)) {
      this.setFieldError('forgot-email', 'Adresse e-mail incomplète ou mal formée.');
      return;
    }

    const button = this.el.formForgot.querySelector('button[type="submit"]');
    if (button) button.disabled = true;

    try {
      await this.ctx.opm.auth.forgotPassword(email);
      // Réponse volontairement identique quelle que soit l'adresse : le serveur
      // ne dit jamais si un compte existe (docs/API.md § 4.6).
      this.ctx.dom.setText(this.el.forgotSent,
        'Si cette adresse correspond à un compte, un lien de réinitialisation vient d\'y être envoyé.');
      this.ctx.dom.show(this.el.forgotSent);
    } catch (error) {
      this.showBanner(this.el.forgotError, this.messageFor(normalizeResult(error)));
    } finally {
      if (button) button.disabled = false;
    }
  }

  /**
   * Exécute une tentative d'authentification et route le résultat.
   * @param {HTMLFormElement} form formulaire à désactiver pendant l'appel
   * @param {Element|null} banner bandeau d'erreur de la vue
   * @param {() => Promise<*>} run appel réseau
   */
  async attempt(form, banner, run) {
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;

    let result;
    try {
      result = normalizeResult(await run());
    } catch (error) {
      result = normalizeResult(error);
    } finally {
      if (button) button.disabled = false;
    }

    if (result.ok) {
      this.onAuthenticated(result.account);
      return;
    }

    // Deux « erreurs » ne sont que des étapes du parcours imposé.
    if (result.code === 'totp_required') {
      this.resetOtp();
      this.setView('totp', { sync: true });
      return;
    }
    if (result.code === 'microsoft_required') {
      this.setView('link', { sync: true });
      return;
    }

    this.showBanner(banner, this.messageFor(result));
  }

  /**
   * Un compte vient d'être authentifié : on entre dans l'application, ou on
   * demande d'abord le rattachement Microsoft, qui est obligatoire.
   * @param {Object|null} account
   */
  onAuthenticated(account) {
    this.forgetCredentials();
    this.resetOtp();

    // Le processus principal annonce aussi le nouveau compte par `auth.onChange`,
    // mais l'ordre des deux messages n'est pas garanti : on inscrit le compte
    // frais dans le magasin pour que la décision de routage soit prise dessus.
    if (account) this.ctx.store.set({ account });

    // Même règle que `decideRoute()` dans le renderer : un compte authentifié
    // entre dans l'application, rattaché ou non — le rattachement se fait
    // depuis les Paramètres, et la barre du bas y mène. Seul un blocage qui
    // exige de se reconnecter retient le joueur ici.
    if (account && !account.can_play) {
      const blocked = blockedLabel(account.blocked_reason);
      if (blocked.action?.target === 'login') {
        this.setView('login', { sync: true });
        this.showBanner(this.el.loginError, blocked.message);
        return;
      }
    }
    this.leave();
  }

  /** Quitte l'écran de connexion vers l'application. */
  leave() {
    if (this.overlayRelease) {
      // `closeOverlay()` acquitte lui-même la confirmation encore affichée.
      this.closeOverlay();
      return;
    }
    if (this.awaitingLinkAck) this.resetLinkView();

    // La vue de rattachement ne doit pas SURVIVRE au départ : elle resterait la
    // vue courante et le prochain compte diffusé rouvrirait cet écran par-dessus
    // l'application. On repart de la connexion, sans réclamer le clavier —
    // l'application prend la main juste après.
    this.setView('login', { sync: true, focus: false });

    this.ctx.route();
  }

  /**
   * Déconnecte le compte courant et revient au formulaire de connexion.
   * Le changement d'écran, lui, revient au renderer : c'est `auth.onChange` qui
   * porte la disparition du compte, et lui seul en connaît le bon moment.
   */
  async logout() {
    try {
      await this.ctx.opm.auth.logout();
    } catch (error) {
      this.ctx.reportError(error, 'Déconnexion incomplète');
    }
    this.resetLinkView();
    this.setView('login', { sync: true });
  }

  /* --------------------------------------------------- rattachement Microsoft */

  /**
   * Lance le rattachement. Le processus principal ouvre lui-même la fenêtre
   * Microsoft et n'expose au launcher ni identifiants ni jeton Microsoft :
   * ce module ne fait qu'attendre et rendre compte.
   */
  async linkMicrosoft() {
    this.ctx.dom.hide(this.el.linkError);

    // À partir d'ici, et jusqu'à l'acquittement, les comptes diffusés par le
    // processus principal concernent ce rattachement : l'abonnement peut agir.
    this.linkInProgress = true;
    this.setLinkBusy(true, 'VÉRIFICATION EN COURS…');

    try {
      // En mode « device », l'appel ne rend la main qu'au terme de la scrutation
      // (jusqu'à quinze minutes) : c'est l'abonnement au magasin qui a déjà
      // affiché le code entre-temps. Le test ci-dessous ne couvre donc que le
      // cas où le descriptif serait rendu directement.
      const result = await this.ctx.opm.auth.linkMicrosoft();
      const device = this.deviceOf(result);

      if (device) {
        this.showDevice(device);
        return;
      }

      if (result?.minecraft) {
        this.showLinkResult(result);
        return;
      }

      // Rattachement rendu sans profil Minecraft : rien n'est confirmé.
      this.linkInProgress = false;
      this.setLinkBusy(false);
      this.showBanner(this.el.linkError,
        "Microsoft n'a pas confirmé la possession de Minecraft. Réessayez, ou utilisez un "
        + 'autre compte Microsoft.');
    } catch (error) {
      // La tentative est close : plus rien n'attend de confirmation, et un
      // compte diffusé plus tard ne doit pas faire réapparaître cet écran.
      this.linkInProgress = false;
      this.hideDevice();
      this.setLinkBusy(false);
      this.showBanner(this.el.linkError, this.messageFor(normalizeResult(error)));
    }
  }

  /**
   * Reconnaît un descriptif de flux « device » (docs/API.md § 1.3).
   *
   * Deux sources acceptées, la seconde étant celle qui sert réellement :
   *  - un descriptif rendu directement par `auth.linkMicrosoft()` ;
   *  - le champ `link_device` d'un `Account`, seul chemin par lequel le code
   *    arrive à temps, puisque `linkMicrosoft()` ne se résout qu'à la toute fin
   *    de la scrutation, jusqu'à quinze minutes plus tard.
   *
   * Aucune condition sur le mode annoncé au `bootstrap` : si le processus
   * principal publie un code, c'est qu'il en faut un — le taire laisserait le
   * joueur devant une page Microsoft qui réclame un code introuvable.
   *
   * @param {*} value `Account` ou valeur rendue par `auth.linkMicrosoft()`
   * @returns {{user_code: string, verification_uri: string, expires_at: string|null}|null}
   */
  deviceOf(value) {
    const raw = (value && typeof value === 'object' && value.link_device) || value;
    if (!raw || typeof raw.user_code !== 'string' || raw.user_code === '') return null;

    return {
      user_code: raw.user_code,
      verification_uri: typeof raw.verification_uri === 'string' ? raw.verification_uri : '',
      expires_at: typeof raw.expires_at === 'string' ? raw.expires_at : null,
    };
  }

  /**
   * Entrée sur la vue de rattachement : on repart de l'état réel du compte.
   * Rattachement en cours → le code reste affiché ; sinon, vue neuve.
   */
  enterLinkView() {
    const device = this.deviceOf(this.ctx.store.get().account);

    if (device) {
      this.showDevice(device);
      return;
    }
    this.resetLinkView();
  }

  /**
   * Interrompt la scrutation « device » en cours.
   *
   * Sans cette sortie, le verrou « linking » du processus principal refuse toute
   * nouvelle tentative jusqu'à l'expiration du code — jusqu'à un quart d'heure
   * pendant lequel le joueur qui s'est trompé de compte Microsoft n'a d'autre
   * recours que de tuer le launcher.
   *
   * @param {HTMLButtonElement} button
   */
  async cancelLink(button) {
    button.disabled = true;

    try {
      await this.ctx.opm.auth.cancelLink();
    } catch (error) {
      this.showBanner(this.el.linkError, this.messageFor(normalizeResult(error)));
      return;
    } finally {
      button.disabled = false;
    }

    // Le processus principal remet `link_device` à null et diffuse le compte :
    // l'abonnement au magasin retire le code. On rend seulement le bouton.
    this.hideDevice();
    this.setLinkBusy(false);

    // Le joueur a renoncé : plus aucun rattachement n'est en cours ici.
    this.linkInProgress = false;
  }

  /**
   * Bascule le bouton de rattachement en attente.
   * @param {boolean} busy
   * @param {string} [label] libellé pendant l'attente
   */
  setLinkBusy(busy, label) {
    if (this.el.linkButton) this.el.linkButton.disabled = busy;
    if (this.el.linkSpinner) this.el.linkSpinner.hidden = !busy;
    if (this.el.linkLabel) {
      this.ctx.dom.setText(this.el.linkLabel, busy ? (label ?? '') : this.linkIdleLabel);
    }
  }

  /**
   * Affiche le code à saisir sur la page Microsoft.
   *
   * Appelée à chaque diffusion du compte pendant la scrutation, et au retour sur
   * la vue : un code inchangé n'est pas réécrit, mais son bloc est toujours
   * réaffiché — c'est ce qui le ramène après un aller-retour vers une autre vue.
   *
   * @param {{user_code: string, verification_uri: string, expires_at: string|null}} device
   */
  showDevice(device) {
    // Le texte n'est réécrit que s'il change ; l'affichage, lui, est réaffirmé à
    // chaque appel — c'est ce qui ramène le code au retour sur la vue.
    if (this.device?.user_code !== device.user_code) {
      this.ctx.dom.setText(this.el.linkCode, device.user_code);
    }

    // Un code publié par le processus principal EST un rattachement en cours —
    // y compris quand il a été lancé depuis les Paramètres et que cet écran ne
    // fait que l'afficher.
    this.linkInProgress = true;
    this.device = device;
    this.ctx.dom.show(this.el.linkDevice);
    this.setLinkBusy(true, 'EN ATTENTE DE MICROSOFT…');

    // Sans adresse de validation, le lien ne mènerait nulle part.
    const open = this.ctx.dom.$('[data-action="open-ms-link"]', this.el.linkDevice);
    if (open) open.disabled = device.verification_uri === '';
  }

  /**
   * Retire le code : il a expiré, le rattachement a abouti, ou il a échoué.
   * Un code périmé affiché reste un code qu'un joueur essaie de saisir.
   */
  hideDevice() {
    if (!this.device) return;

    this.device = null;
    this.ctx.dom.setText(this.el.linkCode, '');
    this.ctx.dom.hide(this.el.linkDevice);
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

  /** Ouvre la page de validation Microsoft dans le navigateur du système. */
  openDeviceLink() {
    if (this.device?.verification_uri) this.ctx.openExternal(this.device.verification_uri);
  }

  /**
   * Carte de confirmation : tête de skin, pseudo Minecraft, validité.
   * @param {Object|null} account compte rattaché
   */
  showLinkResult(account) {
    const { setText, show, hide } = this.ctx.dom;
    const minecraft = account?.minecraft;
    if (!minecraft) return;

    this.device = null;
    this.setLinkBusy(false);

    hide(this.el.linkDevice);
    hide(this.el.linkButton);

    setText(this.el.linkName, minecraft.name ?? '');

    // Échéance de la vérification de possession : `session_expires_at` est le
    // SEUL champ qui la porte dans le type `Account` (docs/IPC.md § Types) —
    // c'est `microsoft.expires_at` du serveur, recopié par `toAccount()`.
    // Sans date réelle, on n'affirme que ce qui est certain.
    const expires = account.session_expires_at ?? null;
    setText(this.el.linkMeta, expires
      ? `Possession vérifiée · valable jusqu'au ${this.ctx.format.dateFr(expires, { withYear: true })}`
      : 'Possession vérifiée');

    if (this.el.linkHead) {
      this.el.linkHead.alt = `Tête du skin de ${minecraft.name ?? ''}`;
      this.ctx.skin.headDataUrl(account.skin_url).then((url) => { this.el.linkHead.src = url; });
    }

    show(this.el.linkResult);
    show(this.el.linkContinue);
    this.el.linkContinue?.focus({ preventScroll: true });

    // À partir d'ici, c'est EMBARQUER qui décide du départ — pas le routage.
    this.awaitingLinkAck = true;
    if (this.ctx.store.get().screen !== 'login') this.holdOverApp();
  }

  /**
   * Maintient la carte au-dessus de l'application le temps d'être acquittée.
   *
   * L'écran est en `position: fixed` au-dessus de la coque : le piège de focus
   * l'empêche de laisser le clavier filer vers l'interface qui reste visible
   * derrière, exactement comme pour l'ajout d'un compte.
   */
  holdOverApp() {
    if (this.overlayRelease) return;

    this.root.hidden = false;
    this.overlayRelease = this.ctx.dom.focusTrap(this.root, {
      initial: this.el.linkContinue ?? null,
    });
  }

  /** Remet la vue de rattachement dans son état initial. */
  resetLinkView() {
    const { hide, show } = this.ctx.dom;

    this.device = null;
    this.awaitingLinkAck = false;
    // Plus rien n'est en attente : les comptes diffusés ensuite ne concernent
    // plus cet écran, et ne doivent plus le faire apparaître.
    this.linkInProgress = false;
    this.setLinkBusy(false);

    hide(this.el.linkDevice);
    hide(this.el.linkResult);
    hide(this.el.linkContinue);
    show(this.el.linkButton);
  }

  /* ------------------------------------------------------------ surimpression */

  /**
   * Ouvre l'écran par-dessus l'application (ajout d'un compte). L'écran est en
   * `position: fixed` au-dessus de la coque : le piège de focus l'empêche de
   * laisser le clavier filer vers l'interface qui reste visible derrière.
   *
   * @param {string} view vue à présenter
   */
  openOverlay(view) {
    if (this.ctx.store.get().screen === 'login') {
      // L'écran est déjà l'écran courant : une simple bascule de vue suffit.
      this.setView(view, { sync: true });
      return;
    }
    if (this.overlayRelease) return;

    this.root.hidden = false;
    this.setView(view, { sync: true });

    // Le piège porte sur l'écran entier, et non sur la seule carte : sa barre de
    // titre réduite (réduire, agrandir, fermer) doit rester atteignable au clavier.
    const initial = this.root.querySelector('[data-view]:not([hidden]) input:not([type="hidden"])');
    this.overlayRelease = this.ctx.dom.focusTrap(this.root, { initial });
  }

  /** Referme la surimpression et rend la main à l'application. */
  closeOverlay() {
    if (!this.overlayRelease) return;

    this.overlayRelease();
    this.overlayRelease = null;

    // La carte de confirmation a été vue (EMBARQUER, ou Échap) : la vue de
    // rattachement repart de zéro pour la prochaine visite.
    if (this.awaitingLinkAck) this.resetLinkView();

    // Si le routage a fait de la connexion l'écran courant entre-temps, il ne
    // faut surtout pas la masquer.
    if (this.ctx.store.get().screen !== 'login') this.root.hidden = true;

    // Même raison qu'en `leave()` : `'link'` ne doit pas rester la vue courante
    // une fois l'écran refermé. L'ordre compte — l'écran vient d'être masqué,
    // donc cette bascule ne prend le focus à personne.
    this.setView('login', { sync: true });
  }
}
