/**
 * LIBELLÉS — la seule table de traduction du launcher.
 *
 * Quatre tables de messages coexistaient jusqu'ici : écran de connexion, barre
 * du bas, paramètres, accueil. Quatre occasions de diverger, et un identifiant
 * technique qui atteignait tout de même le joueur — « Compte indisponible —
 * microsoft_expired », posé tel quel dans une notification par le renderer.
 * Ce module remplace les quatre : un code arrive, une phrase française sort.
 *
 * Deux entrées, deux usages :
 *
 *   errorLabel(code, fallback)   une opération a échoué. Traduit les quatorze
 *                                codes normalisés de docs/API.md § 3 et tous
 *                                ceux que le launcher fabrique lui-même
 *                                (réseau, rattachement, lancement, fichiers).
 *
 *   blockedLabel(reason)         un compte ne peut pas jouer : `blocked_reason`
 *                                (docs/API.md § 1.2). Rend en plus l'action à
 *                                proposer et l'écran vers lequel envoyer le
 *                                joueur.
 *
 * Règles tenues par ce module :
 *
 *  - AUCUNE valeur rendue ne contient d'identifiant technique. Un code inconnu
 *    retombe sur le repli de l'appelant, et ce repli est lui-même refusé s'il
 *    ressemble à un code (`snake_case` sans espace ni accent) : mieux vaut une
 *    phrase générique qu'un mot de code déguisé en explication ;
 *
 *  - `title` est COURT. Il sert de titre de notification, mais aussi de mention
 *    brève dans la liste des comptes et de sous-titre du bouton de compte : une
 *    phrase entière n'y tiendrait pas ;
 *
 *  - `message` est une phrase complète et actionnable : elle dit ce qui s'est
 *    passé et ce que le joueur peut faire ;
 *
 *  - `action.target` vaut `'link'`, `'login'` ou `null`. `microsoft_required`
 *    ET `microsoft_expired` renvoient tous deux sur `'link'` : le joueur a déjà
 *    un compte One Piece Minecraft, ce qui lui manque est le rattachement.
 *    L'envoyer sur `'login'` lui ferait ressaisir un mot de passe qui n'a aucun
 *    rapport avec son problème, et le ramènerait au même blocage.
 *
 * Les détails d'une erreur (`details.until` d'un bannissement, `details.message`
 * d'une maintenance, `Retry-After`) restent la responsabilité de l'appelant :
 * ils varient d'un appel à l'autre, la table, elle, ne varie pas.
 */

/* ========================================================================== */
/*  Replis                                                                    */
/* ========================================================================== */

/** Ce que lit le joueur quand rien d'autre n'est connu. */
const DEFAULT_ERROR = Object.freeze({
  title: 'Opération impossible',
  message: 'Une erreur est survenue. Réessayez dans un instant.',
});

/** Ce que lit le joueur quand un compte est bloqué pour un motif inconnu. */
const DEFAULT_BLOCKED = Object.freeze({
  title: 'Compte indisponible',
  message: 'Ce compte ne peut pas lancer le jeu pour le moment.',
  action: null,
});

/**
 * Silhouette d'un identifiant technique : minuscules ASCII, chiffres et
 * séparateurs, sans espace ni accent — « invalid_credentials », « fetch failed »
 * non, « ERR_ABORTED » non plus (majuscules), mais « timeout » oui.
 *
 * Un repli qui prend cette forme n'est pas une phrase : c'est un code que
 * l'appelant a laissé passer. On le refuse plutôt que de l'afficher.
 */
const TECHNICAL_SHAPE = /^[a-z][a-z0-9]*(?:[_.:-][a-z0-9]+)*$/;

/* ========================================================================== */
/*  Table des erreurs                                                         */
/* ========================================================================== */

/**
 * Les quatorze codes de docs/API.md § 3, `email_unverified` (§ 1.2) et les codes
 * que le launcher fabrique sans jamais interroger le serveur.
 *
 * Les phrases reprennent volontairement celles du processus principal
 * (`CLIENT_MESSAGES` de main/auth/accounts.js) : le joueur doit lire la même
 * chose, que l'erreur ait été traduite ici ou là-bas.
 */
const ERRORS = {
  /* ------------------------------------------- docs/API.md § 3 : le serveur */
  invalid_credentials: {
    title: 'Connexion refusée',
    message: 'Adresse e-mail ou mot de passe incorrect.',
  },
  totp_required: {
    title: 'Code de vérification requis',
    message: 'Un code de vérification est nécessaire pour ce compte.',
  },
  totp_invalid: {
    title: 'Code refusé',
    message: "Code de vérification incorrect. Vérifiez l'heure de votre téléphone.",
  },
  token_expired: {
    title: 'Session expirée',
    message: 'Votre session a expiré. Reconnectez-vous.',
  },
  token_revoked: {
    title: 'Session révoquée',
    message: 'Votre session a été révoquée. Reconnectez-vous.',
  },
  microsoft_required: {
    title: 'Microsoft à rattacher',
    message: 'Un compte Microsoft possédant Minecraft doit être rattaché.',
  },
  microsoft_expired: {
    title: 'Possession à revérifier',
    message: 'La possession de Minecraft doit être vérifiée à nouveau.',
  },
  ownership_missing: {
    title: 'Jeu non possédé',
    message: 'Ce compte Microsoft ne possède pas Minecraft.',
  },
  already_linked: {
    title: 'Compte déjà rattaché',
    message: 'Ce compte Minecraft est déjà rattaché à un autre compte One Piece Minecraft.',
  },
  email_taken: {
    title: 'Adresse déjà utilisée',
    message: 'Cette adresse e-mail est déjà utilisée.',
  },
  username_taken: {
    title: 'Pseudo déjà pris',
    message: "Ce pseudo est déjà pris par un autre membre d'équipage.",
  },
  banned: {
    title: 'Compte suspendu',
    message: 'Ce compte est suspendu.',
  },
  rate_limited: {
    title: 'Trop de tentatives',
    message: 'Trop de tentatives. Patientez quelques minutes avant de réessayer.',
  },
  maintenance: {
    title: 'Maintenance en cours',
    message: "Le serveur d'authentification est en maintenance.",
  },

  /* --------------------------------------- docs/API.md § 1.2 : blocage seul */
  email_unverified: {
    title: 'E-mail à confirmer',
    message: 'Confirmez votre adresse e-mail avant de vous connecter.',
  },

  /* ------------------------------------------------ transport et protocole */
  network: {
    title: 'Serveur injoignable',
    message: "Le serveur d'authentification est injoignable. Vérifiez votre connexion.",
  },
  timeout: {
    title: 'Serveur trop lent',
    message: "Le serveur d'authentification met trop de temps à répondre.",
  },
  aborted: {
    title: 'Opération annulée',
    message: "L'opération a été annulée.",
  },
  invalid_response: {
    title: 'Réponse illisible',
    message: "Le serveur d'authentification a renvoyé une réponse illisible.",
  },
  internal_error: {
    title: 'Erreur inattendue',
    message: 'Une erreur inattendue est survenue.',
  },

  /* ------------------------------------------------------------- comptes */
  no_account: {
    title: 'Aucun compte',
    message: 'Aucun compte connecté.',
  },
  unknown_account: {
    title: 'Compte inconnu',
    message: 'Ce compte ne figure pas dans le launcher.',
  },
  session_expired: {
    title: 'Session expirée',
    message: 'Votre session a expiré : reconnectez-vous.',
  },

  /* --------------------------------------------- rattachement Microsoft */
  link_cancelled: {
    title: 'Rattachement annulé',
    message: 'Rattachement Microsoft annulé.',
  },
  link_denied: {
    title: 'Autorisation refusée',
    message: "L'autorisation Microsoft a été refusée.",
  },
  link_timeout: {
    title: 'Délai dépassé',
    message: 'Le délai de rattachement Microsoft est dépassé. Relancez le rattachement.',
  },
  link_failed: {
    title: 'Rattachement impossible',
    message: 'Le rattachement Microsoft a échoué.',
  },
  link_busy: {
    title: 'Rattachement en cours',
    message: 'Un rattachement Microsoft est déjà en cours.',
  },

  /* ------------------------------------------------------ jeu et fichiers */
  already_running: {
    title: 'Déjà en cours',
    message: 'Une préparation ou une partie est déjà en cours.',
  },
  no_instance: {
    title: 'Aucune instance',
    message: "Aucune instance de jeu n'est accessible avec ce compte.",
  },
  invalid_instance: {
    title: 'Instance inutilisable',
    message: "L'instance choisie n'indique aucune version de jeu.",
  },
  invalid_java: {
    title: 'Java non valide',
    message: 'Choisissez un exécutable « java » ou « javaw ».',
  },

  /* ---------------------------------------------- fenêtre, liens, fichiers */
  invalid_url: {
    title: 'Lien refusé',
    message: 'Seuls les liens http et https peuvent être ouverts.',
  },
  open_failed: {
    title: 'Ouverture impossible',
    message: "Le système n'a pas pu ouvrir cet élément.",
  },
  forbidden_path: {
    title: 'Accès refusé',
    message: "Ce chemin n'appartient pas au launcher.",
  },
  not_found: {
    title: 'Introuvable',
    message: "Ce chemin n'existe pas (ou plus).",
  },
  unknown_panel: {
    title: 'Écran introuvable',
    message: "Cette partie de l'interface est introuvable. Réinstallez le launcher.",
  },
  panel_unreadable: {
    title: 'Écran illisible',
    message: "Cette partie de l'interface n'a pas pu être lue. Réinstallez le launcher.",
  },
  invalid_argument: {
    title: 'Demande refusée',
    message: 'Le launcher a formulé une demande que le processus principal a refusée.',
  },

  /* ------------------------------------------------------------- donations */
  invalid_amount: {
    title: 'Montant refusé',
    message: 'Le montant du don doit être compris entre 1 € et 10 000 €.',
  },
  checkout_unavailable: {
    title: 'Paiement indisponible',
    message: 'Le paiement est momentanément indisponible. Réessayez plus tard.',
  },
};

/* ========================================================================== */
/*  Table des blocages                                                        */
/* ========================================================================== */

/**
 * `blocked_reason` (docs/API.md § 1.2) : ce qui empêche un compte de jouer, et
 * ce que le joueur peut y faire.
 *
 * Seuls les motifs dont la formulation ou l'action diffèrent de la table des
 * erreurs figurent ici : `blockedLabel()` retombe sur `ERRORS` pour tous les
 * autres codes (`rate_limited`, `totp_invalid`…), sans action associée.
 */
const BLOCKED = {
  microsoft_required: {
    title: 'Microsoft à rattacher',
    message: 'Rattachez un compte Microsoft possédant Minecraft : il confirme une seule fois '
      + 'que vous possédez le jeu.',
    action: { label: 'RATTACHER', target: 'link' },
  },
  microsoft_expired: {
    title: 'Possession à revérifier',
    // Le joueur EST connecté : ce qui a expiré, c'est la vérification de
    // possession, pas sa session. Le renvoyer sur la connexion lui ferait
    // ressaisir un mot de passe pour retomber sur le même blocage.
    message: 'La vérification de votre exemplaire de Minecraft a expiré. Relancez-la pour '
      + 'reprendre la mer.',
    action: { label: 'RE-VÉRIFIER', target: 'link' },
  },
  ownership_missing: {
    title: 'Jeu non possédé',
    message: 'Le compte Microsoft rattaché ne possède pas Minecraft. Rattachez celui qui '
      + 'possède le jeu.',
    action: { label: 'CHANGER DE COMPTE MICROSOFT', target: 'link' },
  },
  banned: {
    title: 'Compte suspendu',
    message: 'Votre compte est suspendu. Le staff vous répondra sur le Discord du serveur.',
    action: null,
  },
  email_unverified: {
    title: 'E-mail à confirmer',
    message: "Confirmez votre adresse e-mail depuis le message reçu à l'inscription pour "
      + 'pouvoir embarquer.',
    action: null,
  },
  token_expired: {
    title: 'Session expirée',
    message: 'Votre session a expiré. Reconnectez-vous pour reprendre la mer.',
    action: { label: 'SE RECONNECTER', target: 'login' },
  },
  token_revoked: {
    title: 'Session révoquée',
    message: 'Votre session a été révoquée. Reconnectez-vous pour reprendre la mer.',
    action: { label: 'SE RECONNECTER', target: 'login' },
  },
  session_expired: {
    title: 'Session expirée',
    message: 'Votre session a expiré. Reconnectez-vous pour reprendre la mer.',
    action: { label: 'SE RECONNECTER', target: 'login' },
  },
  invalid_credentials: {
    title: 'Connexion refusée',
    message: 'Ce compte a été refusé par le serveur. Reconnectez-vous.',
    action: { label: 'SE RECONNECTER', target: 'login' },
  },
  maintenance: {
    title: 'Maintenance',
    message: "Le serveur d'authentification est en maintenance : le lancement rouvrira avec lui.",
    action: null,
  },
};

/* ========================================================================== */
/*  Aides internes                                                            */
/* ========================================================================== */

/**
 * Ramène un code à une clé de table. Tout ce qui n'est pas une chaîne non vide
 * est un code absent — jamais une clé forgée.
 *
 * @param {unknown} code
 * @returns {string} chaîne vide si le code est inutilisable
 */
function keyOf(code) {
  return typeof code === 'string' ? code.trim().toLowerCase() : '';
}

/**
 * Retient un repli seulement s'il est lisible par un humain.
 *
 * @param {unknown} value repli proposé par l'appelant
 * @param {string} instead phrase retenue quand le repli est refusé
 * @returns {string}
 */
function humanText(value, instead) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || TECHNICAL_SHAPE.test(text)) return instead;
  return text;
}

/**
 * Construit le libellé de repli à partir de ce que l'appelant a proposé.
 * Accepte une phrase, ou un couple `{title, message}` déjà formé.
 *
 * @param {string|{title?: string, message?: string}|null|undefined} fallback
 * @returns {{title: string, message: string}}
 */
function fallbackLabel(fallback) {
  const source = fallback && typeof fallback === 'object' ? fallback : { message: fallback };

  return {
    title: humanText(source.title, DEFAULT_ERROR.title),
    message: humanText(source.message, DEFAULT_ERROR.message),
  };
}

/* ========================================================================== */
/*  Surface publique                                                          */
/* ========================================================================== */

/**
 * Phrase française d'un code d'erreur.
 *
 * @param {string|null|undefined} code code normalisé (docs/API.md § 3) ou code
 *   fabriqué par le launcher (`network`, `link_busy`, `already_running`…)
 * @param {string|{title?: string, message?: string}} [fallback] ce qu'il faut
 *   dire si le code est inconnu — refusé s'il ressemble lui-même à un code
 * @returns {{title: string, message: string}} jamais vide, jamais technique
 */
export function errorLabel(code, fallback) {
  const entry = ERRORS[keyOf(code)];
  if (!entry) return fallbackLabel(fallback);

  return { title: entry.title, message: entry.message };
}

/**
 * Phrase française d'un motif de blocage, et sortie proposée au joueur.
 *
 * @param {string|null|undefined} reason `account.blocked_reason`
 * @returns {{title: string, message: string, action: {label: string, target: 'link'|'login'}|null}}
 */
export function blockedLabel(reason) {
  const key = keyOf(reason);
  const entry = BLOCKED[key];

  if (entry) {
    return {
      title: entry.title,
      message: entry.message,
      action: entry.action ? { label: entry.action.label, target: entry.action.target } : null,
    };
  }

  // Un code de la § 3 déposé là par une session morte : la phrase existe déjà,
  // seule l'action manque.
  const known = ERRORS[key];
  if (known) return { title: known.title, message: known.message, action: null };

  return { ...DEFAULT_BLOCKED };
}
