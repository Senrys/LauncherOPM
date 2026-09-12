/**
 * Point d'entrée du renderer — module ES natif, chargé par src/launcher.html.
 *
 * Il ne dessine rien lui-même : il orchestre.
 *   1. démarrage réel, retransmis au splash (10 % → 100 %, aucune simulation) ;
 *   2. routage entre les trois écrans : splash → connexion → application ;
 *   3. injection des panneaux servis par le processus principal, montage de
 *      leurs modules et bascule des onglets ;
 *   4. montage des modules de coque (barre de titre, barre du bas) ;
 *   5. écoute des flux du processus principal (comptes, jeu, mise à jour,
 *      journal) et report dans le magasin d'état ;
 *   6. filet de sécurité global : toute erreur non rattrapée devient une
 *      notification et une ligne de journal ;
 *   7. vidéo de fond avec repli en dégradé ;
 *   8. raccourcis clavier de la fenêtre.
 *
 * Aucune donnée d'affichage n'est inventée ici : tout vient de `window.opm`.
 */

import { $, $$, delegate, el, focusTrap, hide, on, setHtml, setText, show, toggle } from './utils/dom.js';
import * as format from './utils/format.js';
import { blockedLabel } from './utils/labels.js';
import { GAME_IDLE, LOG_LIMIT, UPDATER_IDLE, network, store } from './utils/state.js';
import { bodyDataUrl, headDataUrl, preloadSkin } from './utils/skin.js';
import { toast } from './components/toast.js';
import { confirmModal } from './components/modal.js';
import { Popover, closeAllPopovers } from './components/popover.js';

/** Pont exposé par le preload (docs/IPC.md). */
const opm = window.opm;

/* ========================================================================== */
/*  Constantes                                                                */
/* ========================================================================== */

/**
 * Modules de coque. Ils vivent dans le document hôte (barre de titre, barre du
 * bas) et sont montés juste avant que l'application ne s'affiche.
 *
 * Les chemins sont résolus par `import()` relativement à CE fichier
 * (assets/js/renderer.js) : les deux modules sont dans `assets/js/panels/`,
 * au même endroit que les trois panneaux.
 */
const SHELL_MODULES = [
  { id: 'titlebar', src: './panels/titlebar.js', label: 'la barre de titre' },
  { id: 'bottombar', src: './panels/bottombar.js', label: 'la barre du bas' },
];

/** Panneaux principaux : fragment HTML servi par le main + module de pilotage. */
const PANELS = [
  { name: 'home', src: './panels/home.js', label: "l'accueil" },
  { name: 'settings', src: './panels/settings.js', label: 'les paramètres' },
  { name: 'donation', src: './panels/donation.js', label: 'la donation' },
];

/** Écran de connexion : son balisage est déjà dans launcher.html. */
const LOGIN_MODULE = { id: 'login', src: './panels/login.js', label: "l'écran de connexion" };

/** Jalons de progression du splash, calés sur les étapes réelles du démarrage. */
const SPLASH_STEPS = {
  config: 0.10,
  bootstrap: 0.30,
  accounts: 0.60,
  instances: 0.85,
  ready: 1,
};

/** Durée minimale d'affichage du splash, raccourcie par « CLIQUEZ POUR PASSER ». */
const SPLASH_MIN_MS = 900;

/** Durée du fondu de sortie du splash (doit rester ≥ la transition CSS). */
const SPLASH_FADE_MS = 450;

/** Délai au-delà duquel une vidéo de fond qui n'a pas démarré cède la place au dégradé. */
const VIDEO_TIMEOUT_MS = 3000;

/**
 * Regroupement des lignes de journal avant écriture dans le magasin.
 *
 * Le processus principal envoie une ligne par sortie du jeu : sur une instance
 * moddée bavarde, plusieurs milliers arrivent en quelques secondes. Recopier le
 * tableau des 300 dernières lignes et notifier tous les abonnés à CHACUNE d'elles
 * figeait l'interface. On accumule donc, et on ne publie que par lots.
 */
const LOG_FLUSH_MS = 120;

/**
 * Cadence maximale des envois de progression vers la barre des tâches, et pas
 * minimal entre deux valeurs. Le processus principal pilote déjà cette barre
 * pendant une préparation (docs/IPC.md) : ce canal ne doit pas, en plus, doubler
 * le trafic IPC à chaque événement de téléchargement.
 */
const TASKBAR_MIN_INTERVAL_MS = 200;
const TASKBAR_MIN_STEP = 0.01;

/** Valeurs sentinelles de `window.setProgress` (docs/IPC.md). */
const TASKBAR_OFF = -1;
const TASKBAR_INDETERMINATE = 2;

/** Correspondance rail social → clé de `bootstrap.links`. */
const RAIL_LINKS = {
  'link-discord': 'discord',
  'link-twitch': 'twitch',
  'link-youtube': 'youtube',
  'link-website': 'website',
};

/* ========================================================================== */
/*  Références DOM et état local                                              */
/* ========================================================================== */

const ui = {
  splash: $('[data-screen="splash"]'),
  splashTrack: $('[data-el="splash-track"]'),
  splashFill: $('[data-el="splash-fill"]'),
  shell: $('[data-screen="app"]'),
  login: $('[data-screen="login"]'),
  panelHost: $('[data-el="panel-host"]'),
  video: $('[data-el="bg-video"]'),
  videoFallback: $('[data-el="bg-fallback"]'),
};

/** Panneaux montés : nom → { root, instance }. */
const panels = new Map();

/** Onglet réellement affiché (peut différer du magasin pendant une bascule). */
let activeTab = null;

/**
 * Le panneau actif est-il en marche ? Un panneau « en marche » a ses minuteurs
 * armés (l'accueil interroge le statut du serveur toutes les 30 s et fait
 * tourner un compte à rebours à 1 Hz). Passer de l'application à l'écran de
 * connexion ne changeait jusqu'ici que des attributs `hidden` : tout continuait
 * de tourner derrière. Ce drapeau donne au changement d'ÉCRAN le même effet
 * qu'un changement d'onglet.
 */
let panelsLive = false;

/** Modules de coque montés, pour ne les monter qu'une fois. */
let shellMounted = false;

/** Module de l'écran de connexion, monté à la demande. */
let loginMounted = false;

/** Le joueur a demandé à passer le splash. */
let splashSkipped = () => {};
const splashSkipPromise = new Promise((resolve) => { splashSkipped = resolve; });

/* ========================================================================== */
/*  Journal et erreurs                                                        */
/* ========================================================================== */

/** Lignes reçues mais pas encore publiées dans le magasin. */
let logQueue = [];

/** Minuterie de vidage du lot en cours, 0 quand aucun lot n'attend. */
let logFlushTimer = 0;

/**
 * Ajoute une ligne au journal.
 *
 * La ligne n'atteint pas le magasin tout de suite : elle rejoint un lot vidé au
 * plus une fois toutes les `LOG_FLUSH_MS`. C'est ce qui rend une instance moddée
 * — plusieurs milliers de lignes en quelques secondes — supportable pour
 * l'interface, là où une écriture par ligne recopiait 300 éléments et réveillait
 * tous les abonnés du magasin à chaque fois.
 *
 * La minuterie est un `setTimeout` et non un `requestAnimationFrame` : quand
 * « fermer le launcher au lancement » masque la fenêtre, les frames s'arrêtent
 * mais le jeu, lui, continue d'écrire.
 *
 * @param {{ts: string, level: string, text: string}} line
 */
function pushLog(line) {
  logQueue.push(line);

  // Une fenêtre masquée pendant une longue partie ne doit pas faire enfler la
  // file : au-delà du plafond, les plus anciennes ne seront de toute façon
  // jamais affichées.
  if (logQueue.length > LOG_LIMIT) logQueue.splice(0, logQueue.length - LOG_LIMIT);

  if (logFlushTimer) return;
  logFlushTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
}

/** Publie le lot accumulé : une seule recopie, une seule notification. */
function flushLogs() {
  logFlushTimer = 0;
  if (logQueue.length === 0) return;

  const batch = logQueue;
  logQueue = [];

  const merged = store.get().logs.concat(batch);
  store.set({
    logs: merged.length > LOG_LIMIT ? merged.slice(merged.length - LOG_LIMIT) : merged,
  });
}

/**
 * Écrit une ligne de journal produite par le renderer lui-même.
 * @param {'info'|'warn'|'error'|'game'} level
 * @param {string} text
 */
function log(level, text) {
  pushLog({ ts: new Date().toISOString(), level, text });
}

/**
 * Remonte une erreur : console, journal et notification, dans cet ordre.
 * @param {unknown} error
 * @param {string} title titre affiché au joueur
 */
function reportError(error, title) {
  const message = error instanceof Error
    ? error.message
    : String(error ?? 'erreur inconnue');

  console.error(`opm : ${title}`, error);
  log('error', `${title} : ${message}`);
  toast({ kind: 'error', title, message });
}

/* ========================================================================== */
/*  Contexte remis aux modules                                                */
/* ========================================================================== */

/**
 * Construit le contexte passé à `init(ctx)` de chaque module.
 * `root` vaut le document pour les modules de coque, et la racine du panneau
 * pour un panneau : un module ne cherche jamais en dehors de son territoire.
 *
 * @param {ParentNode} root
 * @returns {Object}
 */
function makeContext(root) {
  return {
    opm,
    store,
    root,
    toast,
    confirmModal,
    Popover,
    closeAllPopovers,
    dom: { $, $$, el, on, delegate, setText, setHtml, show, hide, toggle, focusTrap },
    format,
    skin: { headDataUrl, bodyDataUrl, preloadSkin },
    /** Bascule d'onglet, pour qu'un module puisse renvoyer vers un autre écran. */
    setTab,
    /** Change la vue de l'écran de connexion (login|totp|register|link|forgot). */
    setLoginView: (view) => store.set({ loginView: view }),
    /** Rejoue le routage : utile après une connexion ou une déconnexion. */
    route: () => routeTo(decideRoute(store.get().account)),
    /** Journalise une ligne côté renderer (visible dans la console de mise à jour). */
    log,
    /** Remonte une erreur de façon uniforme. */
    reportError,
    /** Ouvre une URL dans le navigateur du système. */
    openExternal,
  };
}

/* ========================================================================== */
/*  Chargement des modules                                                    */
/* ========================================================================== */

/**
 * Importe un module et l'initialise.
 * Deux formes acceptées : la classe par défaut du contrat des panneaux
 * (`static id`, `init`, `show`, `hide`) ou une fonction `mount(ctx)` pour les
 * modules de coque, qui n'ont pas de cycle d'affichage.
 *
 * @param {{src: string, label: string}} spec
 * @param {ParentNode} root
 * @returns {Promise<Object>} l'instance montée
 */
async function mountModule(spec, root) {
  const module = await import(spec.src);
  const context = makeContext(root);

  if (typeof module.default === 'function') {
    const instance = new module.default();
    if (typeof instance.init === 'function') await instance.init(context);
    return instance;
  }

  if (typeof module.mount === 'function') {
    return (await module.mount(context)) ?? {};
  }

  throw new Error(`le module « ${spec.src} » n'expose ni classe par défaut ni fonction « mount »`);
}

/**
 * Monte un module en absorbant son échec : une pièce manquante ne doit jamais
 * emporter tout le launcher.
 *
 * @param {{src: string, label: string}} spec
 * @param {ParentNode} root
 * @returns {Promise<Object|null>}
 */
async function mountModuleSafely(spec, root) {
  try {
    return await mountModule(spec, root);
  } catch (error) {
    reportError(error, `Impossible de charger ${spec.label}`);
    return null;
  }
}

/* ========================================================================== */
/*  Panneaux et onglets                                                       */
/* ========================================================================== */

/**
 * Injecte les trois fragments de panneau puis monte leurs modules.
 * Idempotent : le second appel ne fait rien.
 */
async function ensurePanels() {
  if (panels.size > 0) return;
  if (!ui.panelHost) throw new Error("l'hôte de panneaux est absent du document");

  for (const spec of PANELS) {
    let root = null;

    try {
      const html = await opm.app.panel(spec.name);
      // Seule injection de HTML du renderer : le fragment vient du processus
      // principal, jamais du réseau (voir dom.setHtml).
      const template = setHtml(document.createElement('template'), html);

      root = template.content.querySelector(`[data-tab="${spec.name}"]`)
        ?? template.content.firstElementChild;
      ui.panelHost.append(template.content);
    } catch (error) {
      reportError(error, `Impossible de charger ${spec.label}`);
      continue;
    }

    if (!root) {
      reportError(new Error('fragment sans racine'), `Impossible de charger ${spec.label}`);
      continue;
    }

    const instance = await mountModuleSafely(spec, root);
    panels.set(spec.name, { name: spec.name, root, instance });
  }

  await ensureShellModules();

  const wanted = panels.has(store.get().tab) ? store.get().tab : PANELS[0].name;
  await setTab(wanted);
}

/** Monte la barre de titre et la barre du bas (une seule fois). */
async function ensureShellModules() {
  if (shellMounted) return;
  shellMounted = true;

  for (const spec of SHELL_MODULES) {
    const instance = await mountModuleSafely(spec, document);
    // Le module manque : la coque doit rester utilisable, on rebranche au
    // minimum les boutons de fenêtre et la version.
    if (!instance && spec.id === 'titlebar') enableTitlebarFallback();
  }
}

/** Monte le module de l'écran de connexion (son balisage est déjà présent). */
async function ensureLogin() {
  if (loginMounted) return;
  loginMounted = true;

  if (!ui.login) throw new Error("l'écran de connexion est absent du document");
  await mountModuleSafely(LOGIN_MODULE, ui.login);
}

/**
 * Affiche un onglet : classe active sur l'écran, état ARIA des onglets,
 * puis `hide()` du panneau sortant et `show()` du panneau entrant.
 *
 * @param {'home'|'settings'|'donation'} name
 */
async function setTab(name) {
  const next = panels.get(name);
  if (!next || name === activeTab) return;

  const previous = activeTab ? panels.get(activeTab) : null;
  activeTab = name;

  if (previous) {
    previous.root.classList.remove('opm-screen--active');
    if (typeof previous.instance?.hide === 'function') {
      try {
        await previous.instance.hide();
      } catch (error) {
        reportError(error, 'Fermeture du panneau');
      }
    }
  }

  next.root.classList.add('opm-screen--active');

  for (const tab of $$('[role="tab"][data-tab]')) {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle('opm-titlebar__tab--active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
  }
  ui.panelHost?.setAttribute('aria-labelledby', `opm-tab-${name}`);

  store.set({ tab: name });

  panelsLive = true;
  if (typeof next.instance?.show === 'function') {
    try {
      await next.instance.show();
    } catch (error) {
      reportError(error, "Affichage du panneau");
    }
  }
}

/**
 * Arrête ou relance le panneau actif — ses minuteurs, ses rafraîchissements.
 *
 * Appelé quand l'ÉCRAN change (application ↔ connexion) et au déchargement de
 * la fenêtre, pour que « rien ne tourne derrière un panneau masqué » reste vrai
 * en dehors de la seule bascule d'onglets.
 *
 * @param {boolean} live
 */
function setPanelsLive(live) {
  if (live === panelsLive) return;
  panelsLive = live;

  const panel = activeTab ? panels.get(activeTab) : null;
  const run = live ? panel?.instance?.show : panel?.instance?.hide;
  if (typeof run !== 'function') return;

  // `show()`/`hide()` sont asynchrones ; le changement d'écran, lui, est
  // immédiat : on n'attend pas, mais on ne perd pas l'erreur.
  Promise.resolve(run.call(panel.instance)).catch((error) => {
    reportError(error, live ? "Affichage du panneau" : 'Fermeture du panneau');
  });
}

/* ========================================================================== */
/*  Écrans et routage                                                         */
/* ========================================================================== */

/**
 * Bascule l'écran visible.
 * La coque reste dans le flux et se dévoile en retirant `opm-shell--hidden`,
 * pour que son fondu d'entrée joue derrière le splash ; `inert` l'empêche de
 * capter les clics et le focus tant qu'elle n'est pas l'écran actif.
 *
 * @param {'splash'|'login'|'app'} name
 */
function setScreen(name) {
  if (store.get().screen === name) return;
  closeAllPopovers();

  // Quitter l'application arrête le panneau actif ; y revenir le relance. Sans
  // cela, l'accueil continuait d'interroger le serveur toutes les 30 s derrière
  // l'écran de connexion, et ne se rafraîchissait pas au retour.
  setPanelsLive(name === 'app');

  if (ui.shell) {
    ui.shell.classList.toggle('opm-shell--hidden', name !== 'app');
    ui.shell.inert = name !== 'app';
  }

  if (ui.login) ui.login.hidden = name !== 'login';

  if (ui.splash) {
    if (name === 'splash') {
      ui.splash.style.removeProperty('opacity');
      ui.splash.hidden = false;
    } else if (!ui.splash.hidden) {
      // Opacité posée au runtime ; la transition elle-même est décrite en CSS.
      ui.splash.style.opacity = '0';
      setTimeout(() => {
        ui.splash.hidden = true;
        ui.splash.style.removeProperty('opacity');
      }, SPLASH_FADE_MS);
    }
  }

  store.set({ screen: name });
}

/**
 * Décide de l'écran à afficher à partir du compte sélectionné.
 *
 * Un compte AUTHENTIFIÉ entre dans l'application, qu'il puisse jouer ou non.
 * Le joueur connecté avec son compte du site retrouve son journal de bord, les
 * statistiques et les mises à jour ; seul le bouton JOUER est fermé, et il dit
 * pourquoi — rattachement Microsoft à faire, possession à revérifier, compte
 * suspendu. Le rattachement se fait depuis les Paramètres, où le bouton
 * l'emmène. L'ancien comportement, qui bloquait tout derrière l'écran de
 * rattachement, faisait passer un compte parfaitement valide pour un compte
 * refusé.
 *
 * Seul un blocage qui exige de SE RECONNECTER (session expirée ou révoquée,
 * identifiants refusés) ramène à l'écran de connexion : là, il n'y a rien à
 * montrer, le compte n'est plus authentifié. C'est `blockedLabel()` qui porte
 * cette distinction (`action.target`), jamais un motif brut.
 *
 * @param {Object|null} account
 * @returns {{screen: 'app'|'login', view?: string, notice?: {title: string, message: string}}}
 */
function decideRoute(account) {
  if (!account) return { screen: 'login', view: 'login' };

  if (account.can_play) return { screen: 'app' };

  const blocked = blockedLabel(account.blocked_reason);
  const notice = { title: blocked.title, message: blocked.message };

  if (blocked.action?.target === 'login') {
    return { screen: 'login', view: 'login', notice };
  }
  return { screen: 'app', notice };
}

/**
 * Prépare l'écran visé (montage des modules) sans encore le montrer.
 * @param {{screen: 'app'|'login'}} decision
 */
async function prepareRoute(decision) {
  if (decision.screen === 'app') await ensurePanels();
  else await ensureLogin();
}

/**
 * Montre l'écran visé, une fois préparé.
 * @param {{screen: 'app'|'login', view?: string, notice?: {title: string, message: string}}} decision
 */
function enterRoute(decision) {
  if (decision.screen === 'app') {
    setScreen('app');
    // Compte bloqué mais admis dans l'application : on le dit une fois, à
    // l'entrée. La barre du bas le répète en permanence, avec le bouton qui
    // mène à la solution.
    if (decision.notice) {
      toast({ kind: 'info', title: decision.notice.title, message: decision.notice.message });
    }
    return;
  }

  if (decision.view) store.set({ loginView: decision.view });
  setScreen('login');

  // Titre et phrase viennent de `blockedLabel()` : plus aucun identifiant
  // technique ne peut atteindre cette notification.
  if (decision.notice) {
    toast({
      kind: 'error',
      title: decision.notice.title,
      message: decision.notice.message,
    });
  }
}

/**
 * Prépare puis affiche un écran.
 * @param {{screen: 'app'|'login', view?: string, notice?: {title: string, message: string}}} decision
 */
async function routeTo(decision) {
  try {
    await prepareRoute(decision);
  } catch (error) {
    reportError(error, "Chargement de l'interface");
  }
  enterRoute(decision);
}

/* ========================================================================== */
/*  Splash                                                                    */
/* ========================================================================== */

/**
 * Reporte la progression réelle du démarrage sur la barre du splash.
 * @param {number} ratio 0 → 1
 */
function setSplashProgress(ratio) {
  const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);

  if (ui.splashFill) ui.splashFill.style.width = `${percent}%`;
  if (ui.splashTrack) ui.splashTrack.setAttribute('aria-valuenow', String(percent));
}

/**
 * Laisse le splash à l'écran le temps minimal, sauf si le joueur l'a passé.
 * @param {number} startedAt horodatage du début du démarrage
 */
function waitSplashDwell(startedAt) {
  const remaining = SPLASH_MIN_MS - (Date.now() - startedAt);
  if (remaining <= 0) return Promise.resolve();

  return Promise.race([
    new Promise((resolve) => setTimeout(resolve, remaining)),
    splashSkipPromise,
  ]);
}

/* ========================================================================== */
/*  Démarrage                                                                 */
/* ========================================================================== */

/**
 * Séquence de démarrage. Chaque étape avance la barre du splash ; une étape en
 * échec n'interrompt pas les suivantes, elle dégrade l'expérience et le dit.
 */
async function boot() {
  /* 1 — configuration locale et identité de l'application (10 %) */
  try {
    const [config, version, platform] = await Promise.all([
      opm.config.get(),
      opm.app.version(),
      opm.app.platform(),
    ]);
    store.set({ config, version, platform, instance: config?.instance_selected ?? null });
  } catch (error) {
    reportError(error, 'Configuration locale illisible');
  }
  setSplashProgress(SPLASH_STEPS.config);

  /* 2 — bootstrap du serveur d'authentification (30 %) */
  try {
    // `network.watch` tient le compteur d'échecs d'où `online` est dérivé :
    // plus aucune écriture directe de cette clé, ici ou ailleurs.
    const bootstrap = await network.watch(opm.auth.bootstrap());
    store.set({ bootstrap, maintenance: bootstrap?.maintenance ?? null });
    applyRailLinks(bootstrap?.links);
  } catch (error) {
    log('warn', `Serveur d'authentification injoignable : ${error?.message ?? error}`);
    toast({
      kind: 'error',
      title: "Serveur d'authentification injoignable",
      // Dire la vérité : sans serveur, aucune session de jeu ne peut être
      // délivrée (docs/DATA.md § 7) et le bouton JOUER reste inactif.
      message: "Le launcher démarre en mode dégradé : vos comptes et le dernier journal restent lisibles, mais le jeu ne pourra pas être lancé tant que le serveur ne répondra pas.",
    });
  }
  setSplashProgress(SPLASH_STEPS.bootstrap);

  /* 3 — rafraîchissement silencieux de la session (60 %) */
  try {
    await opm.auth.refresh();
  } catch (error) {
    // Session expirée ou serveur muet : le routage enverra vers la connexion.
    // Le compteur ne retient que le second cas — un refus métier prouve au
    // contraire que le serveur répond. Le succès, lui, ne prouve rien : le
    // processus principal conserve le compte en cache quand le réseau tombe.
    network.fail(error);
    log('warn', `Session non rafraîchie : ${error?.message ?? error}`);
  }

  try {
    const [accounts, account] = await Promise.all([opm.auth.list(), opm.auth.current()]);
    store.set({ accounts: accounts ?? [], account: account ?? null });
    if (account?.skin_url) preloadSkin(account.skin_url);
  } catch (error) {
    reportError(error, 'Comptes locaux illisibles');
  }
  setSplashProgress(SPLASH_STEPS.accounts);

  /* 4 — instances de jeu (85 %) */
  try {
    const instances = await opm.game.instances();
    const list = Array.isArray(instances) ? instances : [];
    const selected = store.get().instance;
    const known = list.some((item) => item?.name === selected);

    store.set({ instances: list, instance: known ? selected : (list[0]?.name ?? null) });
  } catch (error) {
    log('warn', `Liste des instances indisponible : ${error?.message ?? error}`);
  }
  setSplashProgress(SPLASH_STEPS.instances);

  /* 5 — journal déjà accumulé par le processus principal */
  try {
    const history = await opm.log.history();
    if (Array.isArray(history) && history.length > 0) {
      // Le journal du processus principal précède les lignes déjà écrites ici
      // pendant le démarrage : rien n'est perdu, l'ordre reste chronologique.
      store.set({ logs: [...history, ...store.get().logs].slice(-LOG_LIMIT) });
    }
  } catch (error) {
    log('warn', `Journal indisponible : ${error?.message ?? error}`);
  }
}

/** Séquence complète : câblage, démarrage, routage. */
async function start() {
  if (!opm) {
    // Sans pont IPC il n'y a pas d'application : on le dit clairement plutôt
    // que de laisser une fenêtre vide devant le joueur.
    console.error('opm : le pont « window.opm » est absent — préchargement non appliqué.');
    toast({
      kind: 'error',
      title: 'Launcher non initialisé',
      message: "Le pont avec le processus principal est absent. Redémarrez le launcher ; si le problème persiste, réinstallez-le.",
    });
    return;
  }

  const startedAt = Date.now();

  wireGlobalErrors();
  wireShortcuts();
  wireStaticActions();
  setupBackground();
  wireMainProcessEvents();

  try {
    await boot();
  } catch (error) {
    reportError(error, 'Démarrage incomplet');
  }

  const decision = decideRoute(store.get().account);

  try {
    await prepareRoute(decision);
  } catch (error) {
    reportError(error, "Chargement de l'interface");
  }

  setSplashProgress(SPLASH_STEPS.ready);

  await waitSplashDwell(startedAt);
  enterRoute(decision);

  // `ready` n'est posé qu'ici : tant que le splash tient l'écran, un
  // `auth:changed` tardif ne doit pas router par-dessus lui et le couper net.
  store.set({ ready: true });

  // En contrepartie, un changement survenu pendant le fondu a été ignoré par le
  // garde de `onAccountsChanged` : on rejoue le routage sur l'état réel plutôt
  // que de laisser l'écran sur une décision déjà périmée.
  const settled = decideRoute(store.get().account);
  if (settled.screen !== store.get().screen) await routeTo(settled);
}

/* ========================================================================== */
/*  Câblage de la coque statique                                              */
/* ========================================================================== */

/** Actions présentes dans launcher.html, indépendantes des modules. */
function wireStaticActions() {
  // Pendant le splash, la coque est déjà dans le flux (son fondu d'entrée joue
  // derrière) : `inert` l'empêche de capter les clics et le focus d'ici là.
  if (ui.shell) ui.shell.inert = true;

  // Splash : toute la surface est cliquable, la mention du bas porte le bouton.
  delegate(document, 'click', '[data-action="skip-splash"]', () => splashSkipped());

  // Onglets principaux : le renderer possède le routage entre panneaux.
  delegate(document, 'click', '[role="tab"][data-tab]', (event, target) => {
    setTab(target.dataset.tab);
  });

  // Rail social et tout autre bouton portant une URL réelle.
  delegate(document, 'click', '[data-action="open-link"]', (event, target) => {
    const url = target.dataset.url;
    if (url) openExternal(url);
  });

  // Boutons de fenêtre de l'écran de connexion : sa barre de titre réduite
  // n'appartient à aucun module de coque.
  if (ui.login) wireWindowControls(ui.login);

  // Fermeture ou rechargement de la fenêtre : on arrête le panneau actif comme
  // on le ferait pour un changement d'écran, plutôt que de laisser un minuteur
  // déclencher un appel IPC sur un pont en train de disparaître.
  on(window, 'pagehide', () => setPanelsLive(false));
}

/**
 * Branche les trois boutons de fenêtre sur une racine donnée.
 * @param {ParentNode & EventTarget} root
 */
function wireWindowControls(root) {
  delegate(root, 'click', '[data-action="window-min"]', () => opm.window.minimize());
  delegate(root, 'click', '[data-action="window-max"]', () => opm.window.maximize());
  delegate(root, 'click', '[data-action="window-close"]', () => opm.window.close());
}

/**
 * Filet de sécurité activé uniquement si le module de barre de titre manque :
 * les boutons de fenêtre et la version restent opérants.
 */
function enableTitlebarFallback() {
  if (!ui.shell) return;

  wireWindowControls(ui.shell);

  const version = store.get().version;
  if (version) setText('[data-bind="app-version"]', `V${version}`);

  opm.window.onMaximizeChange((maximized) => {
    $('[data-el="btn-max"]')?.setAttribute('aria-pressed', maximized ? 'true' : 'false');
  });
}

/**
 * Pose les URL réelles du rail social. Sans URL connue, le bouton est désactivé
 * plutôt que de mener nulle part.
 * @param {Object|null|undefined} links
 */
function applyRailLinks(links) {
  for (const [name, key] of Object.entries(RAIL_LINKS)) {
    const node = $(`[data-el="${name}"]`);
    if (!node) continue;

    const url = links?.[key];
    if (typeof url === 'string' && url !== '') {
      node.dataset.url = url;
      node.disabled = false;
    } else {
      delete node.dataset.url;
      node.disabled = true;
    }
  }
}

/**
 * Ouvre une URL dans le navigateur du système (validée côté processus principal).
 * @param {string} url
 */
async function openExternal(url) {
  try {
    await opm.app.openExternal(url);
  } catch (error) {
    reportError(error, "Ouverture du lien impossible");
  }
}

/* ========================================================================== */
/*  Vidéo de fond                                                             */
/* ========================================================================== */

/**
 * Lance la vidéo de fond et bascule sur le dégradé de repli si elle échoue,
 * si sa lecture est refusée, ou si elle n'a toujours pas démarré au bout de
 * quelques secondes.
 */
function setupBackground() {
  const video = ui.video;
  const fallback = ui.videoFallback;
  if (!video || !fallback) return;

  let switched = false;

  const useFallback = (reason) => {
    if (switched) return;
    switched = true;

    video.pause();
    // Opacité posée au runtime, puis retrait du flux : le dégradé prend la place.
    video.style.opacity = '0';
    video.hidden = true;
    fallback.hidden = false;

    log('warn', `Vidéo de fond indisponible (${reason}) : repli sur le dégradé.`);
  };

  on(video, 'error', () => useFallback('erreur de lecture'));

  const played = video.play();
  if (played && typeof played.catch === 'function') {
    played.catch(() => useFallback('lecture refusée'));
  }

  setTimeout(() => {
    // HAVE_CURRENT_DATA : en deçà, rien n'a jamais été affiché.
    if (video.readyState < 2 || video.paused) useFallback('démarrage impossible');
  }, VIDEO_TIMEOUT_MS);
}

/* ========================================================================== */
/*  Raccourcis clavier                                                        */
/* ========================================================================== */

/** Ctrl+W ferme, F12 ouvre les outils de développement, Échap referme. */
function wireShortcuts() {
  on(window, 'keydown', (event) => {
    if (event.key === 'Escape') {
      // Les modales gèrent elles-mêmes Échap ; ici on referme les popovers.
      closeAllPopovers();
      return;
    }

    if (event.key === 'F12') {
      event.preventDefault();
      opm.app.devtools();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w') {
      event.preventDefault();
      opm.window.close();
    }
  });
}

/* ========================================================================== */
/*  Flux du processus principal                                               */
/* ========================================================================== */

/** Abonne le renderer aux quatre flux descendants. */
function wireMainProcessEvents() {
  opm.auth.onChange(onAccountsChanged);
  opm.game.on(onGameEvent);
  opm.updater.on(onUpdaterEvent);
  opm.log.on((line) => {
    if (line && typeof line === 'object') pushLog(line);
  });
}

/**
 * Comptes modifiés côté processus principal (connexion, rattachement,
 * déconnexion, expiration). Le routage ne se déclenche que si l'écran doit
 * réellement changer : l'écran de connexion garde la main sur ses vues.
 *
 * @param {Array<Object>} accounts
 * @param {Object|null} current
 */
function onAccountsChanged(accounts, current) {
  store.set({ accounts: accounts ?? [], account: current ?? null });
  if (current?.skin_url) preloadSkin(current.skin_url);

  const state = store.get();
  if (!state.ready) return;

  const decision = decideRoute(current ?? null);
  if (decision.screen === state.screen) return;

  routeTo(decision);
}

/**
 * Événements du jeu : progression, extraction, lancement, arrêt.
 * @param {Object} event
 */
function onGameEvent(event) {
  if (!event || typeof event.type !== 'string') return;

  const previous = store.get().game;
  const ratio = (size, progress) => (size > 0 ? Math.min(1, progress / size) : 0);
  let next = null;

  switch (event.type) {
    case 'check':
      next = {
        ...GAME_IDLE,
        state: 'check',
        progress: event.progress ?? 0,
        size: event.size ?? 0,
        ratio: ratio(event.size ?? 0, event.progress ?? 0),
      };
      break;

    case 'progress':
      next = {
        ...GAME_IDLE,
        state: 'download',
        progress: event.progress ?? 0,
        size: event.size ?? 0,
        ratio: ratio(event.size ?? 0, event.progress ?? 0),
        speed: event.speed_bps ?? 0,
        eta: event.eta_s ?? 0,
      };
      break;

    case 'extract':
      next = { ...previous, state: 'extract', message: event.file ?? '' };
      break;

    case 'patch':
      next = { ...previous, state: 'patch', message: event.message ?? '' };
      break;

    case 'launching':
      next = { ...GAME_IDLE, state: 'launching', ratio: 1, message: '' };
      break;

    case 'running':
      next = { ...GAME_IDLE, state: 'running', running: true };
      break;

    case 'closed':
      next = { ...GAME_IDLE, state: 'closed', message: `code ${event.code ?? 0}` };
      if (event.code) {
        toast({
          kind: 'error',
          title: 'Le jeu s\'est arrêté',
          message: `Minecraft s'est fermé avec le code ${event.code}. La console de mise à jour conserve le détail.`,
        });
      }
      break;

    case 'error':
      next = { ...GAME_IDLE, state: 'error', message: event.message ?? '' };
      reportError(new Error(event.message ?? 'erreur inconnue'), 'Erreur de lancement');
      break;

    default:
      return;
  }

  store.set({ game: next });
  updateTaskbarProgress(next);
}

/** Dernière valeur réellement envoyée à la barre des tâches, et son instant. */
let taskbarSent = null;
let taskbarSentAt = 0;

/**
 * Valeur de barre des tâches correspondant à un état du jeu.
 * @param {Object} game
 * @returns {number} 0 → 1, ou l'une des deux sentinelles
 */
function taskbarValueOf(game) {
  if (game.state === 'check' || game.state === 'download') {
    return Math.min(1, Math.max(0, game.ratio));
  }
  if (game.state === 'launching' || game.state === 'extract' || game.state === 'patch') {
    return TASKBAR_INDETERMINATE;
  }
  return TASKBAR_OFF;
}

/**
 * Reporte l'avancement sur la barre des tâches du système.
 *
 * Un téléchargement émet plusieurs dizaines d'événements par seconde ; les
 * réexpédier tous saturait un canal que le processus principal alimente déjà de
 * son côté. On n'envoie donc qu'un mouvement visible : au moins un point de
 * pourcentage, et au plus un message toutes les `TASKBAR_MIN_INTERVAL_MS`.
 *
 * Les deux sentinelles — indéterminé, extinction — échappent à cette retenue :
 * ce sont elles qui éteignent la barre à la fin, et une extinction retardée est
 * une barre qui reste allumée sur une partie terminée. Elles ne sont en revanche
 * jamais répétées.
 *
 * @param {Object} game état du jeu
 */
function updateTaskbarProgress(game) {
  const value = taskbarValueOf(game);

  if (value === TASKBAR_OFF || value === TASKBAR_INDETERMINATE) {
    if (value === taskbarSent) return;
    sendTaskbarProgress(value);
    return;
  }

  // Première progression du travail en cours : elle part tout de suite, la
  // retenue ne commence qu'après.
  const first = taskbarSent === null
    || taskbarSent === TASKBAR_OFF
    || taskbarSent === TASKBAR_INDETERMINATE;

  if (first) {
    sendTaskbarProgress(value);
    return;
  }

  if (Math.abs(value - taskbarSent) < TASKBAR_MIN_STEP) return;
  if (Date.now() - taskbarSentAt < TASKBAR_MIN_INTERVAL_MS) return;
  sendTaskbarProgress(value);
}

/**
 * Envoie la valeur et retient ce qui a été envoyé.
 * @param {number} value
 */
function sendTaskbarProgress(value) {
  taskbarSent = value;
  taskbarSentAt = Date.now();
  opm.window.setProgress(value);
}

/**
 * Événements de mise à jour du launcher.
 * @param {Object} event
 */
function onUpdaterEvent(event) {
  if (!event || typeof event.type !== 'string') return;

  switch (event.type) {
    case 'checking':
      store.set({ updater: { ...UPDATER_IDLE, state: 'checking' } });
      break;

    case 'available':
      store.set({ updater: { ...UPDATER_IDLE, state: 'available', version: event.version ?? null } });
      toast({
        kind: 'info',
        title: 'Mise à jour disponible',
        message: `La version ${event.version ?? ''} est en cours de téléchargement.`.trim(),
      });
      break;

    case 'none':
      store.set({ updater: { ...UPDATER_IDLE, state: 'none' } });
      break;

    case 'progress':
      store.set({
        updater: {
          ...store.get().updater,
          state: 'downloading',
          percent: event.percent ?? 0,
        },
      });
      break;

    case 'downloaded':
      store.set({ updater: { ...store.get().updater, state: 'downloaded', percent: 100 } });
      toast({
        kind: 'success',
        title: 'Mise à jour prête',
        message: 'Redémarrez le launcher pour l\'installer.',
      });
      break;

    case 'error':
      store.set({ updater: { ...UPDATER_IDLE, state: 'error', message: event.message ?? '' } });
      log('warn', `Mise à jour du launcher impossible : ${event.message ?? ''}`);
      break;

    default:
      break;
  }
}

/* ========================================================================== */
/*  Erreurs non rattrapées                                                    */
/* ========================================================================== */

/** Toute erreur qui échappe au code applicatif devient visible et journalisée. */
function wireGlobalErrors() {
  on(window, 'error', (event) => {
    reportError(event.error ?? event.message, 'Erreur inattendue');
  });

  on(window, 'unhandledrejection', (event) => {
    event.preventDefault();
    reportError(event.reason, 'Erreur inattendue');
  });
}

/* ========================================================================== */

start();
