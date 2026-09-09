'use strict';

/**
 * Lancement du jeu — enveloppe de la bibliothèque `minecraft-java-core`.
 *
 * Ce module est le seul endroit du launcher qui connaît la bibliothèque de lancement.
 * Il traduit ses événements bruts vers le type `GameEvent` de docs/IPC.md et n'expose
 * au reste du programme qu'une surface minuscule :
 *
 *   instances()   catalogue des profils jouables par le compte courant (cache 60 s)
 *   launch(name)  prépare puis démarre la partie
 *   cancel()      renonce à un lancement en préparation
 *   isRunning()   verrou : préparation, vérification ou partie en cours
 *   verifyFiles() vérification complète de l'installation, sans démarrer le jeu
 *   clearCache()  vide les caches jetables et renvoie les octets libérés
 *   filesStat()   nombre de fichiers et poids réel du dossier de jeu (cache 30 s)
 *   onEvent(cb)   abonnement au flux d'événements
 *
 * Les options passées à la bibliothèque reprennent celles de l'ancien launcher
 * (`OldLauncher/src/assets/js/panels/home.js`, méthode `startGame`), enrichies des
 * arguments JVM saisis dans les paramètres et du plein écran.
 *
 * Deux points de mécanique méritent d'être connus avant de toucher à ce fichier :
 *
 *  1. `Launch.Launch(opt)` ne rend pas la main à la fin de la partie : il déclenche
 *     `start()` en arrière-plan. Tout le suivi passe donc par les événements, et
 *     `launch()` se contente de garantir que la préparation a bien été lancée.
 *  2. La bibliothèque n'offre aucune annulation. Le seul point d'arrêt propre est la
 *     frontière entre la préparation (`DownloadGame()`) et le démarrage de la machine
 *     virtuelle : on l'intercepte pour pouvoir refuser de démarrer le jeu. Les fichiers
 *     déjà mis en file d'attente finissent donc de se télécharger — ils sont conservés
 *     et resserviront au lancement suivant — mais le jeu, lui, ne démarre pas.
 *  3. Une partie s'ouvre ET se referme côté serveur. `launch()` retient le `client_token`
 *     de la session Yggdrasil et l'instant du passage à `running` ; à la fermeture du jeu,
 *     `finish()` rend la session par `POST /game/session/close` avec la durée réellement
 *     jouée — c'est ainsi, et seulement ainsi, que `users.tempsdejeu` est crédité et qu'un
 *     jeton de 24 h ne survit pas à la partie (docs/DATA.md § 4).
 *     **La session est rendue par tous les chemins de sortie** — annulation, échec de
 *     préparation, machine virtuelle morte sans un mot, fermeture du launcher pendant la
 *     partie — sans quoi chaque tentative avortée laisserait un accès de 24 h ouvert.
 *     Seule la durée créditée dépend du démarrage effectif du jeu.
 *  4. Un seul pilote pour la barre de progression de la barre des tâches : celui-ci.
 *     Tant qu'une exécution est en cours, `ipc.js` ignore la valeur venue du renderer
 *     (`window:progress`) — deux pilotes se contrediraient.
 */

const path = require('path');
const fsp = require('fs/promises');
const { app: electronApp } = require('electron');

const { Launch } = require('minecraft-java-core');

const paths = require('./paths');
const logger = require('./logger');
const store = require('./store');
const api = require('../auth/api');
const mainWindow = require('../../windows/mainWindow');

/* ------------------------------------------------------------------ constantes */

/** Durée de vie du catalogue d'instances (docs/DATA.md § 5 : obligatoire hors ligne). */
const INSTANCES_TTL_MS = 60_000;

/** Durée de vie de l'état du dossier de jeu. */
const FILES_STAT_TTL_MS = 30_000;

/** Cadence maximale des événements de progression envoyés au renderer. */
const PROGRESS_THROTTLE_MS = 120;

/** Intervalle minimal entre deux mesures de vitesse de téléchargement. */
const SPEED_SAMPLE_MS = 400;

/** Poids de la mesure instantanée dans la moyenne glissante de la vitesse. */
const SPEED_WEIGHT = 0.35;

/** Délai réseau par fichier, transmis à la bibliothèque. */
const DOWNLOAD_TIMEOUT_MS = 10_000;

/**
 * Première ligne émise par la bibliothèque juste avant le `spawn` de la machine
 * virtuelle. Elle sert de marqueur « préparation terminée, le jeu démarre ».
 */
const LAUNCH_BANNER = 'Launching with arguments';

/**
 * Délai au-delà duquel une machine virtuelle démarrée mais muette est considérée comme
 * ayant lancé le jeu. La première ligne de sortie est un signal fragile : un jeu qui
 * n'écrit rien laisserait sinon le bouton sur « LANCEMENT… » et la partie non comptée.
 */
const GAME_START_FALLBACK_MS = 20_000;

/** Temps accordé à la clôture de la session de jeu quand le launcher se ferme. */
const QUIT_RELEASE_TIMEOUT_MS = 3_000;

/**
 * Sentinelles renvoyées à la place du résultat de préparation pour empêcher la
 * bibliothèque de démarrer le jeu. Elles ressortent par son événement `error`,
 * où elles sont reconnues et converties en fin de course normale.
 */
const CANCELLED = 'opm:annulation';
const VERIFY_ONLY = 'opm:verification-seule';

/**
 * Lignes de sortie du jeu retenues dans le journal quand la console n'est pas
 * demandée : seules les anomalies méritent d'être conservées.
 */
const GAME_PROBLEM = /\b(ERROR|SEVERE|FATAL|Exception|Caused by)\b/;

/**
 * Sous-dossiers jetables du dossier de jeu. Rien d'irremplaçable ici : journaux,
 * rapports de plantage, caches régénérés au prochain démarrage. Les mondes, les mods,
 * la configuration, les bibliothèques et les ressources ne sont jamais touchés.
 */
const DISPOSABLE = ['logs', 'crash-reports', '.mixin.out'];

/* ------------------------------------------------------------------ état interne */

/**
 * Verrou global d'exécution : non nul pendant une préparation, une vérification ou une
 * partie. Il est pris et relâché **uniquement** par `acquire()` et `release()`.
 * @type {{label: string, at: number}|null}
 */
let lock = null;

/** @type {object|null} exécution en cours (voir `createRun`). */
let current = null;

/** Abonnés au flux d'événements. */
const listeners = new Set();

/** @type {{at: number, list: object[]}|null} catalogue d'instances mémorisé. */
let instancesCache = null;

/** @type {{at: number, value: object}|null} dernier relevé du dossier de jeu. */
let filesStatCache = null;

/** @type {Promise<object>|null} relevé en cours, pour ne pas parcourir deux fois. */
let filesStatInflight = null;

/* ------------------------------------------------------------------ utilitaires */

/**
 * Erreur porteuse d'un code normalisé, tel que l'attend `src/main/ipc.js`.
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Prend le verrou d'exécution, ou refuse.
 *
 * Le test et la prise sont **dans la même instruction synchrone**, avant le moindre
 * `await` de `launch()` et de `verifyFiles()` : deux clics arrivés dans la même
 * micro-tâche ne peuvent pas franchir cette porte tous les deux. Le second reçoit
 * `already_running`, que la barre du bas traite comme un non-événement.
 *
 * @param {'lancement'|'vérification'} label
 * @throws {Error & {code: 'already_running'}}
 */
function acquire(label) {
  if (lock) {
    throw fail(
      'already_running',
      lock.label === 'vérification'
        ? 'Une vérification des fichiers du jeu est déjà en cours.'
        : 'Une partie est déjà en cours de lancement.'
    );
  }
  lock = { label, at: Date.now() };
}

/** Relâche le verrou d'exécution. Sans effet s'il est déjà libre. */
function release() {
  lock = null;
}

/** Nombre fini, sinon 0 — les compteurs de la bibliothèque sont parfois indéfinis. */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Texte lisible extrait d'une charge utile d'erreur de la bibliothèque.
 * Celle-ci émet tantôt `{ error: 'texte' }`, tantôt `{ error: true, message }`,
 * tantôt une véritable `Error`.
 * @param {unknown} payload
 * @returns {string}
 */
function messageOf(payload) {
  if (!payload) return "Le lancement a échoué sans message d'erreur.";
  if (typeof payload === 'string') return payload;
  if (payload instanceof Error) return payload.message;
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.message === 'string') return payload.message;
  try {
    return JSON.stringify(payload);
  } catch {
    return "Le lancement a échoué pour une raison indéterminée.";
  }
}

/** Code sentinelle porté par une charge utile d'erreur, ou `null`. */
function sentinelOf(payload) {
  if (payload && typeof payload === 'object' && !(payload instanceof Error)) {
    if (payload.error === CANCELLED) return CANCELLED;
    if (payload.error === VERIFY_ONLY) return VERIFY_ONLY;
  }
  return null;
}

/**
 * Compte courant, ou `null`. Le module des comptes est chargé à l'appel : les services
 * du processus principal se requièrent mutuellement, et cette paresse évite tout cycle.
 * @returns {Promise<object|null>}
 */
async function currentAccount() {
  try {
    return (await require('../auth/accounts').current()) || null;
  } catch (err) {
    logger.warn('Compte courant indisponible :', err);
    return null;
  }
}

/* ------------------------------------------------------- diffusion des événements */

/**
 * Abonnement au flux d'événements du jeu (format `GameEvent` de docs/IPC.md).
 * @param {(event: object) => void} cb
 * @returns {() => void} fonction de désabonnement
 */
function onEvent(cb) {
  if (typeof cb !== 'function') throw new TypeError('game.onEvent attend une fonction.');
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Diffuse un événement. Un abonné en erreur ne doit jamais interrompre le lancement.
 * @param {object} event
 */
function emit(event) {
  for (const cb of listeners) {
    try {
      cb(event);
    } catch (err) {
      logger.error('Abonné aux événements du jeu en erreur :', err);
    }
  }
}

/**
 * Pilote la barre de progression de la barre des tâches.
 *
 * C'est l'unique écriture de `setProgressBar` pendant une exécution : le renderer ne
 * doit pas doubler ce pilotage par `window:progress` (voir `ownsTaskbar`).
 *
 * @param {number} ratio  0 → 1, `-1` pour l'éteindre, `2` pour l'état indéterminé
 */
function taskbar(ratio) {
  const win = mainWindow.getWindow();
  if (!win) return;
  const value = ratio === -1 || ratio === 2 ? ratio : Math.min(1, Math.max(0, ratio));
  try {
    win.setProgressBar(value);
  } catch {
    /* fenêtre en cours de destruction : sans conséquence */
  }
}

/**
 * La barre des tâches appartient-elle au jeu en ce moment ?
 * `ipc.js` s'en sert pour ignorer la valeur envoyée par le renderer : un seul pilote.
 * @returns {boolean}
 */
function ownsTaskbar() {
  return lock !== null;
}

/* ------------------------------------------------------------------ instances */

/**
 * Remet une instance du serveur au format documenté (docs/API.md § 1.5), en comblant
 * les champs absents. Le nom `loadder` est celui de l'API : il est volontairement
 * conservé pour rester compatible avec l'ancien launcher.
 * @param {any} raw
 * @returns {object|null} `null` si l'entrée est inexploitable
 */
function normalizeInstance(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;

  const loader = (raw.loadder && typeof raw.loadder === 'object' ? raw.loadder : raw.loader) || {};
  const status = raw.status && typeof raw.status === 'object' ? raw.status : {};

  return {
    name,
    url: typeof raw.url === 'string' ? raw.url : null,
    verify: raw.verify === true,
    ignored: Array.isArray(raw.ignored) ? raw.ignored.filter((v) => typeof v === 'string') : [],
    loadder: {
      minecraft_version: typeof loader.minecraft_version === 'string' ? loader.minecraft_version : '',
      loadder_type: typeof loader.loadder_type === 'string' ? loader.loadder_type : 'none',
      loadder_version: typeof loader.loadder_version === 'string' ? loader.loadder_version : 'latest',
    },
    status: {
      ip: typeof status.ip === 'string' ? status.ip : null,
      port: Number.isFinite(Number(status.port)) ? Number(status.port) : null,
      nameServer: typeof status.nameServer === 'string' ? status.nameServer : name,
    },
    whitelistActive: raw.whitelistActive === true,
    whitelist: Array.isArray(raw.whitelist) ? raw.whitelist.filter((v) => typeof v === 'string') : [],
  };
}

/**
 * Une instance est-elle accessible au compte donné ?
 * La comparaison ignore la casse : une liste blanche saisie à la main ne doit pas
 * exclure un joueur pour un « S » majuscule.
 * @param {object} instance
 * @param {object|null} account
 * @returns {boolean}
 */
function isAllowedFor(instance, account) {
  if (!instance.whitelistActive) return true;
  if (!account) return false;

  const names = [account.minecraft?.name, account.username]
    .filter((n) => typeof n === 'string' && n)
    .map((n) => n.toLowerCase());

  return instance.whitelist.some((entry) => names.includes(entry.toLowerCase()));
}

/**
 * Ramène la réponse du serveur à une liste. Le contrat (docs/API.md § 1.5) annonce un
 * tableau ; l'ancien point d'entrée `/files` renvoyait un dictionnaire dont les clés
 * étaient les noms d'instances. Les deux formes sont acceptées, pour qu'un serveur
 * resté en arrière ne rende pas le jeu injouable.
 * @param {any} raw
 * @returns {object[]}
 */
function toInstanceArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([name, data]) => ({ ...data, name }));
}

/**
 * Catalogue brut du serveur, mémorisé 60 s. En cas de panne réseau, le dernier
 * catalogue connu est réutilisé : sans lui, plus aucun lancement n'est possible.
 * @returns {Promise<object[]>}
 */
async function fetchInstances() {
  if (instancesCache && Date.now() - instancesCache.at < INSTANCES_TTL_MS) {
    return instancesCache.list;
  }

  try {
    const list = toInstanceArray(await api.instances()).map(normalizeInstance).filter(Boolean);
    instancesCache = { at: Date.now(), list };
    return list;
  } catch (err) {
    if (instancesCache) {
      logger.warn(`Catalogue des instances indisponible (${err.message}) — dernier connu réutilisé.`);
      return instancesCache.list;
    }
    throw err;
  }
}

/**
 * Instances jouables par le compte courant.
 * @returns {Promise<object[]>}
 */
async function instances() {
  const [list, account] = await Promise.all([fetchInstances(), currentAccount()]);
  return list.filter((instance) => isAllowedFor(instance, account));
}

/* ------------------------------------------------------------------ options */

/**
 * Découpe une ligne d'arguments JVM en respectant les guillemets simples et doubles :
 * `-Dfoo="deux mots" -Xss1M` donne bien deux arguments.
 * @param {string} text
 * @returns {string[]}
 */
function splitArguments(text) {
  if (typeof text !== 'string') return [];

  const args = [];
  let token = '';
  let started = false;
  let quote = null;

  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) args.push(token);
      token = '';
      started = false;
      continue;
    }
    token += char;
    started = true;
  }
  if (started) args.push(token);

  return args;
}

/**
 * Arguments JVM personnalisés, débarrassés des réglages de mémoire : ceux-ci
 * appartiennent aux curseurs de RAM des paramètres, et deux sources concurrentes
 * pour `-Xmx` produiraient un comportement incompréhensible pour le joueur.
 * @param {string} text  contenu du champ « Arguments JVM »
 * @returns {string[]}
 */
function jvmArguments(text) {
  const args = [];
  for (const arg of splitArguments(text)) {
    if (/^-Xm[sx]/i.test(arg)) {
      logger.warn(`Argument JVM « ${arg} » ignoré : la mémoire se règle avec les curseurs de RAM.`);
      continue;
    }
    args.push(arg);
  }
  return args;
}

/**
 * Construit les options de `minecraft-java-core` pour une instance donnée.
 * @param {object} instance      instance normalisée
 * @param {object} config        configuration locale (`store.getConfig()`)
 * @param {object} authenticator session de jeu Yggdrasil, ou substitut pour une vérification
 * @param {boolean} verify       force la vérification complète des fichiers
 * @returns {object}
 */
function buildOptions(instance, config, authenticator, verify) {
  const loader = instance.loadder;
  const withLoader = loader.loadder_type && loader.loadder_type !== 'none';

  // La bibliothèque n'exploite pas `screen.fullscreen` : le plein écran passe donc
  // par l'argument de jeu, que Minecraft comprend depuis toujours.
  const gameArgs = config.game.fullscreen ? ['--fullscreen'] : [];

  return {
    url: instance.url,
    authenticator,
    timeout: DOWNLOAD_TIMEOUT_MS,
    path: paths.gameDir,
    instance: instance.name,
    version: loader.minecraft_version,
    // Le jeu survit à la fermeture du launcher : masquer la fenêtre ne doit jamais
    // tuer une partie en cours.
    detached: true,
    downloadFileMultiple: config.launcher.download_multi,

    loader: {
      type: withLoader ? loader.loadder_type : null,
      build: loader.loadder_version,
      enable: Boolean(withLoader),
    },

    verify: Boolean(verify || instance.verify),
    ignored: [...instance.ignored],

    // `javaPath` de l'ancien launcher s'appelle `java.path` depuis la version 4.2 :
    // chemin complet de l'exécutable, ou `null` pour laisser la bibliothèque
    // télécharger le Java adapté à la version du jeu.
    java: { path: config.java.path, version: null, type: 'jre' },

    screen: { width: config.game.width, height: config.game.height },

    memory: {
      min: `${config.java.memory.min * 1024}M`,
      max: `${config.java.memory.max * 1024}M`,
    },

    JVM_ARGS: jvmArguments(config.java.args),
    GAME_ARGS: gameArgs,
  };
}

/* ------------------------------------------------------------------ exécution */

/**
 * État d'une exécution — un lancement ou une vérification.
 * @param {'lancement'|'vérification'} label
 * @param {object} config  configuration figée au démarrage de l'exécution
 */
function createRun(label, config) {
  return {
    label,
    config,
    phase: null,        // 'check' | 'progress' : sert à remettre la mesure de vitesse à zéro
    launching: false,   // la machine virtuelle a été démarrée
    running: false,     // le jeu produit de la sortie
    cancelled: false,
    finished: false,
    verifyOnly: false,  // vérification des fichiers : rien à démarrer, donc rien à annuler
    hidden: false,      // la fenêtre a été masquée par `close_on_launch`
    incidents: 0,       // fichiers dont le téléchargement a échoué
    lastEmitAt: 0,
    speed: 0,
    speedAt: 0,
    speedBytes: 0,
    accountId: null,    // compte qui a lancé la partie (figé : il peut changer pendant)
    clientToken: '',    // `client_token` de la session Yggdrasil, à rendre en la fermant
    startedAt: 0,       // horodatage du passage à `running`, base du temps de jeu crédité
    startTimer: null,   // repli si la machine virtuelle démarre sans rien écrire
  };
}

/** Remet la mesure de vitesse à zéro au changement de phase. */
function resetSpeed(run) {
  run.speed = 0;
  run.speedAt = 0;
  run.speedBytes = 0;
}

/**
 * Vitesse instantanée lissée, en octets par seconde.
 * @param {object} run
 * @param {number} done  octets déjà transférés
 * @returns {number}
 */
function sampleSpeed(run, done) {
  const now = Date.now();

  if (!run.speedAt) {
    run.speedAt = now;
    run.speedBytes = done;
    return run.speed;
  }

  const elapsed = now - run.speedAt;
  if (elapsed < SPEED_SAMPLE_MS) return run.speed;

  const delta = done - run.speedBytes;
  run.speedAt = now;
  run.speedBytes = done;

  // Un compteur qui repart en arrière signale un nouveau lot de fichiers.
  if (delta < 0) {
    run.speed = 0;
    return 0;
  }

  const instant = (delta * 1000) / elapsed;
  run.speed = run.speed ? run.speed * (1 - SPEED_WEIGHT) + instant * SPEED_WEIGHT : instant;
  return run.speed;
}

/**
 * Émet un événement de progression, au plus une fois toutes les `PROGRESS_THROTTLE_MS`,
 * et met à jour la barre des tâches. Le premier événement d'une phase et le dernier
 * (progression complète) passent toujours : l'interface ne doit ni rater le début
 * d'un téléchargement, ni rester bloquée à 98 %.
 * @param {object} run
 * @param {object} event
 * @param {boolean} force
 */
function pushProgress(run, event, force) {
  const complete = event.size > 0 && event.progress >= event.size;
  const now = Date.now();
  if (!force && !complete && now - run.lastEmitAt < PROGRESS_THROTTLE_MS) return;

  run.lastEmitAt = now;
  emit(event);
  taskbar(event.size > 0 ? event.progress / event.size : 2);
}

/**
 * Note le passage à une nouvelle phase et remet la mesure de vitesse à zéro.
 * @param {object} run
 * @param {'check'|'progress'} phase
 * @returns {boolean} vrai si la phase vient de changer
 */
function enterPhase(run, phase) {
  if (run.phase === phase) return false;
  run.phase = phase;
  resetSpeed(run);
  return true;
}

function onCheck(run, progress, size) {
  if (run.finished) return;
  const changed = enterPhase(run, 'check');
  pushProgress(run, { type: 'check', progress: num(progress), size: num(size) }, changed);
}

function onProgress(run, progress, size) {
  if (run.finished) return;
  const changed = enterPhase(run, 'progress');

  const done = num(progress);
  const total = num(size);
  const event = { type: 'progress', progress: done, size: total };

  const speed = sampleSpeed(run, done);
  if (speed > 0) {
    event.speed_bps = Math.round(speed);
    if (total > done) event.eta_s = Math.max(1, Math.round((total - done) / speed));
  }

  pushProgress(run, event, changed);
}

/**
 * Sortie standard du jeu. La toute première ligne est la bannière d'arguments émise
 * juste avant le démarrage de la machine virtuelle : elle marque la fin de la
 * préparation. Les suivantes sont la voix du jeu lui-même.
 * @param {object} run
 * @param {unknown} raw
 */
function onData(run, raw) {
  if (run.finished) return;

  const text = String(raw ?? '');
  const banner = text.startsWith(LAUNCH_BANNER);

  if (!run.launching) {
    run.launching = true;
    taskbar(2);
    logger.info('Démarrage de la machine virtuelle Java…');
    emit({ type: 'launching' });
    armStartFallback(run);
  }

  if (banner) {
    // Ligne très longue (classpath complet) : réservée à la console de jeu.
    if (run.config.launcher.keep_console) logger.game(text);
    return;
  }

  markRunning(run);
  logGameOutput(run, text);
}

/**
 * Note que la partie a commencé : temps de jeu à compter d'ici, fenêtre masquée si le
 * joueur l'a demandé, barre des tâches rendue au système.
 *
 * Appelé par la première ligne de sortie du jeu, et à défaut par le repli d'`armStartFallback` :
 * la préparation et le téléchargement des fichiers ne sont pas du temps joué, mais une
 * machine virtuelle silencieuse ne doit pas pour autant laisser l'interface en attente.
 * @param {object} run
 */
function markRunning(run) {
  if (run.running || run.finished) return;
  run.running = true;
  run.startedAt = Date.now();
  clearStartFallback(run);
  logger.info('Le jeu est lancé.');
  emit({ type: 'running' });
  taskbar(-1);
  hideForGame(run);
}

/**
 * Arme le repli de démarrage : si la machine virtuelle n'a rien écrit passé le délai,
 * on considère malgré tout que le jeu tourne. Sans ce filet, un jeu muet laisserait le
 * bouton sur « LANCEMENT… » jusqu'à sa fermeture.
 * @param {object} run
 */
function armStartFallback(run) {
  if (run.startTimer || run.running || run.finished) return;
  run.startTimer = setTimeout(() => {
    run.startTimer = null;
    if (run.finished || run.running) return;
    logger.info("La machine virtuelle n'a rien écrit : le jeu est considéré comme lancé.");
    markRunning(run);
  }, GAME_START_FALLBACK_MS);
  // La minuterie ne doit pas, à elle seule, maintenir le processus en vie.
  if (typeof run.startTimer.unref === 'function') run.startTimer.unref();
}

/** Désarme le repli de démarrage. */
function clearStartFallback(run) {
  if (!run.startTimer) return;
  clearTimeout(run.startTimer);
  run.startTimer = null;
}

/**
 * Recopie la sortie du jeu dans le journal. Console demandée : tout est conservé,
 * c'est le rôle du popover « DÉTAILS ». Sinon, seules les anomalies sont gardées,
 * pour que le journal reste lisible.
 * @param {object} run
 * @param {string} text
 */
function logGameOutput(run, text) {
  const keep = run.config.launcher.keep_console;

  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/\s+$/, '');
    if (!clean) continue;
    if (keep) logger.game(clean);
    else if (GAME_PROBLEM.test(clean)) logger.warn(`Jeu : ${clean}`);
  }
}

/**
 * Événement `error` de la bibliothèque. Une véritable `Error` signale l'échec d'un
 * fichier isolé : le téléchargement continue, on se contente de le noter. Un objet
 * `{ error }` signale en revanche un arrêt définitif de la préparation.
 * @param {object} run
 * @param {unknown} payload
 */
function onLibraryError(run, payload) {
  if (run.finished) return;

  const sentinel = sentinelOf(payload);
  if (sentinel === CANCELLED) {
    finish(run, { type: 'closed', code: 0 }, 'Lancement annulé.');
    return;
  }
  if (sentinel === VERIFY_ONLY) {
    finish(run, { type: 'closed', code: 0 }, 'Vérification des fichiers terminée.');
    return;
  }

  if (payload instanceof Error) {
    run.incidents += 1;
    logger.warn(`Fichier non téléchargé (${payload.message}) — nouvelle tentative au prochain lancement.`);
    return;
  }

  onFatal(run, messageOf(payload));
}

/**
 * Échec définitif : la préparation ou le démarrage s'arrête là.
 * @param {object} run
 * @param {string} message
 */
function onFatal(run, message) {
  if (run.finished) return;
  const suffix = run.incidents > 0 ? ` (${run.incidents} fichier(s) non téléchargé(s))` : '';
  finish(run, { type: 'error', message: `${message}${suffix}` }, `Échec du ${run.label} : ${message}${suffix}`);
}

/**
 * Fin de partie de la bibliothèque. Selon les versions, le code de sortie est un
 * nombre ou une phrase : les deux sont acceptés.
 * @param {object} run
 * @param {unknown} code
 */
function onClose(run, code) {
  if (run.finished) return;
  const parsed = Number.isInteger(code) ? code : Number.parseInt(String(code).replace(/\D+/g, ''), 10);
  const exit = Number.isFinite(parsed) ? parsed : 0;
  finish(run, { type: 'closed', code: exit }, `Le jeu s'est fermé (code ${exit}).`);
}

/** Durée lisible en français, pour la ligne de journal (« 2 h 14 min », « 47 s »). */
function humanDuration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/**
 * Rend la session de jeu au serveur : le `client_token` invalide sur-le-champ la session
 * Yggdrasil — qui vaudrait sinon 24 h — et la durée réellement jouée s'ajoute à
 * `users.tempsdejeu` (docs/API.md § 1.4, docs/DATA.md § 4).
 *
 * **Appelé par tous les chemins de sortie**, y compris ceux où le jeu n'a jamais démarré :
 * préparation annulée, échec de préparation, machine virtuelle morte sans un mot. Sans
 * cela, chaque tentative avortée laisserait un accès de 24 h ouvert dans `ygg_session`.
 * Seule la durée créditée dépend du démarrage effectif : `duration_s: 0` sinon.
 *
 * Le `client_token` est transmis dans tous les cas — sans lui, le serveur ne crédite rien
 * et n'invalide rien.
 *
 * Rien ici n'est fatal ni bloquant : un serveur injoignable à cet instant ne doit pas
 * produire d'erreur visible pour le joueur.
 *
 * @param {object} run
 * @returns {Promise<void>} tenue quoi qu'il arrive
 */
function releaseSession(run) {
  const token = run.clientToken;
  const startedAt = run.startedAt;

  // Une session ne se rend qu'une fois, quel que soit le nombre d'appelants.
  run.clientToken = '';
  run.startedAt = 0;

  // Aucune session ouverte : vérification des fichiers, ou échec avant `POST /game/session`.
  if (!token) return Promise.resolve();

  const seconds = startedAt
    ? Math.min(86_400, Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
    : 0;

  return require('../auth/accounts')
    .closeGameSession({
      duration_s: seconds,
      client_token: token,
      account_id: run.accountId || undefined,
    })
    .then(() =>
      logger.info(
        seconds > 0
          ? `Temps de jeu transmis : ${humanDuration(seconds)}. Session de jeu close.`
          : 'Session de jeu close (aucun temps de jeu à créditer).'
      )
    )
    .catch((err) => {
      logger.warn(
        `Session de jeu non rendue (${err.code || err.message}) : ` +
          "cette partie ne sera pas comptée et l'accès expirera de lui-même sous 24 h."
      );
    });
}

/**
 * Clôt une exécution : dernier événement, barre des tâches éteinte, fenêtre rendue,
 * verrou libéré. Les événements ultérieurs de la bibliothèque sont ignorés (les
 * écouteurs restent en place : retirer celui de `error` ferait planter l'émetteur).
 * @param {object} run
 * @param {object} event  dernier `GameEvent` à diffuser
 * @param {string} note   ligne de journal
 */
function finish(run, event, note) {
  if (run.finished) return;
  run.finished = true;
  clearStartFallback(run);

  // Avant tout le reste : la partie est finie, le serveur doit le savoir.
  void releaseSession(run);

  taskbar(-1);
  restoreWindow(run);

  if (current === run) current = null;
  release();

  // Le contenu du dossier de jeu vient de changer : le relevé mémorisé est caduc.
  filesStatCache = null;

  if (event.type === 'error') logger.error(note);
  else logger.info(note);

  emit(event);
}

/**
 * Referme une exécution qui n'a jamais démarré, sans diffuser d'événement :
 * l'appelant reçoit déjà l'erreur, il n'y a rien à rapporter à l'interface.
 *
 * La session de jeu éventuellement déjà obtenue est rendue ici : un lancement qui échoue
 * après `POST /game/session` ne doit pas laisser d'accès ouvert derrière lui.
 *
 * @param {object|null} run
 * @param {string} note  ligne de journal
 */
function abort(run, note) {
  if (run) {
    run.finished = true;
    clearStartFallback(run);
    void releaseSession(run);
  }
  current = null;
  release();
  taskbar(-1);
  logger.error(note);

  // L'appelant reçoit bien l'exception, mais le flux d'événements, lui, s'arrêtait net :
  // un échec survenu APRÈS les premiers `check`/`progress` laissait la barre du bas et la
  // barre des tâches figées sur « PATIENTEZ » jusqu'au redémarrage du launcher. La barre
  // ne relâche son verrou que sur `closed` ou `error` : c'est donc ici que la boucle
  // doit être refermée.
  emit({ type: 'error', message: note });
}

/** Masque le launcher pendant la partie, si le joueur l'a demandé. */
function hideForGame(run) {
  if (!run.config.launcher.close_on_launch) return;
  const win = mainWindow.getWindow();
  if (!win) return;
  win.hide();
  run.hidden = true;
  logger.info('Launcher masqué pendant la partie.');
}

/** Remonte la fenêtre masquée au lancement. */
function restoreWindow(run) {
  if (!run.hidden) return;
  run.hidden = false;

  const win = mainWindow.getWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Branche les événements de la bibliothèque sur les nôtres.
 * @param {import('events').EventEmitter} launcher
 * @param {object} run
 */
function wire(launcher, run) {
  launcher.on('check', (progress, size) => onCheck(run, progress, size));
  launcher.on('progress', (progress, size) => onProgress(run, progress, size));
  launcher.on('extract', (value) => {
    if (!run.finished) emit({ type: 'extract', file: String(value ?? '') });
  });
  launcher.on('patch', (value) => {
    if (run.finished) return;
    taskbar(2);
    emit({ type: 'patch', message: messageOf(value) });
  });
  launcher.on('data', (line) => onData(run, line));
  launcher.on('close', (code) => onClose(run, code));
  launcher.on('error', (payload) => onLibraryError(run, payload));
}

/**
 * Prépare une instance de `Launch` dont la frontière « préparation → démarrage »
 * est sous notre contrôle.
 *
 * @param {object} run
 * @param {boolean} verifyOnly  vrai pour s'arrêter juste avant la machine virtuelle
 * @returns {import('events').EventEmitter}
 */
function createLauncher(run, verifyOnly) {
  const launcher = new Launch();
  wire(launcher, run);

  // `start()` appelle `DownloadGame()` puis démarre le jeu, sauf si le résultat porte
  // un champ `error`. C'est notre unique levier : on l'utilise pour renoncer.
  const prepare = launcher.DownloadGame.bind(launcher);
  launcher.DownloadGame = async () => {
    const prepared = await prepare();
    if (verifyOnly) return { error: VERIFY_ONLY };
    if (run.cancelled) return { error: CANCELLED };
    return prepared;
  };

  // `Launch()` lance `start()` sans l'attendre : sans ce filet, la moindre exception
  // interne remonterait en promesse non gérée au lieu d'être signalée au joueur.
  const start = launcher.start.bind(launcher);
  launcher.start = () =>
    Promise.resolve()
      .then(start)
      .catch((err) => onFatal(run, messageOf(err)));

  return launcher;
}

/* ------------------------------------------------------------------ lancement */

/**
 * Prépare puis démarre la partie.
 *
 * La promesse est tenue dès que la bibliothèque a pris la main : téléchargement,
 * démarrage et fin de partie sont ensuite rapportés par les événements. Seuls les
 * échecs préalables (aucune instance, session de jeu refusée) sont levés ici.
 *
 * @param {string} [instanceName]  instance voulue ; à défaut, celle des réglages
 * @returns {Promise<void>}
 */
async function launch(instanceName) {
  // Première instruction, synchrone : le verrou est pris avant le moindre `await`.
  acquire('lancement');

  let run = null;
  try {
    const config = store.getConfig();
    const list = await instances();
    if (list.length === 0) {
      throw fail('no_instance', "Aucune instance de jeu n'est accessible avec ce compte.");
    }

    const wanted = instanceName || config.instance_selected;
    const instance = list.find((i) => i.name === wanted) || list[0];

    if (!instance.loadder.minecraft_version) {
      throw fail('invalid_instance', `L'instance « ${instance.name} » n'indique aucune version de jeu.`);
    }
    if (wanted && instance.name !== wanted) {
      logger.warn(`Instance « ${wanted} » indisponible : bascule sur « ${instance.name} ».`);
    }
    if (config.instance_selected !== instance.name) {
      store.setConfig({ instance_selected: instance.name });
    }

    // L'exécution existe avant la session de jeu : c'est elle qui portera le
    // `client_token`, et donc le devoir de le rendre, quoi qu'il arrive ensuite.
    run = createRun('lancement', config);
    current = run;

    // Le compte est figé au cas où le joueur en changerait pendant qu'il joue.
    const account = await currentAccount();
    run.accountId = account && typeof account.id === 'string' ? account.id : null;

    // C'est notre serveur qui délivre la session : aucun jeton Microsoft n'ira au jeu.
    const authenticator = await require('../auth/accounts').gameSession();
    run.clientToken = typeof authenticator.client_token === 'string' ? authenticator.client_token : '';

    const launcher = createLauncher(run, false);
    const options = buildOptions(instance, config, authenticator, false);

    logger.info(
      `Lancement de « ${instance.name} » (Minecraft ${instance.loadder.minecraft_version}, ` +
        `${options.loader.enable ? `${options.loader.type} ${options.loader.build}` : 'sans chargeur de mods'}, ` +
        `mémoire ${options.memory.min} → ${options.memory.max}).`
    );

    taskbar(2);
    await launcher.Launch(options);
  } catch (err) {
    // Échec avant que la bibliothèque n'ait la main : aucun événement n'a encore été
    // diffusé, l'appelant reçoit l'erreur directement. On referme tout — session de jeu
    // comprise, si elle a eu le temps d'être ouverte.
    abort(run, `Lancement impossible : ${err.message}`);
    throw err;
  }
}

/**
 * Renonce à un lancement en préparation.
 *
 * La bibliothèque ne sait pas interrompre ses téléchargements : les fichiers en file
 * d'attente vont jusqu'au bout — ils sont conservés et resserviront — mais le jeu ne
 * sera pas démarré. Une partie déjà lancée, elle, ne peut plus être annulée.
 *
 * @returns {Promise<boolean>} vrai si l'annulation a été prise en compte
 */
async function cancel() {
  const run = current;
  if (!run || run.finished) return false;

  if (run.running || run.launching) {
    logger.warn("Le jeu a déjà démarré : l'annulation ne s'applique qu'à la préparation.");
    return false;
  }
  // Une vérification n'a pas de lancement à empêcher : le seul levier d'annulation est
  // le renoncement au démarrage de la machine virtuelle, et il n'y en a pas ici. Mieux
  // vaut le dire que prétendre annuler puis laisser la vérification aller à son terme.
  if (run.verifyOnly) {
    logger.warn("Une vérification des fichiers ne s'interrompt pas : elle se termine seule.");
    return false;
  }
  if (run.cancelled) return true;

  run.cancelled = true;
  logger.info('Annulation demandée : le jeu ne sera pas démarré.');
  emit({
    type: 'patch',
    message: 'Annulation en cours — les fichiers déjà téléchargés sont conservés.',
  });
  return true;
}

/** @returns {Promise<boolean>} vrai si une préparation, une vérification ou une partie est en cours */
async function isRunning() {
  return lock !== null;
}

/**
 * Vérification complète de l'installation : tous les fichiers sont contrôlés, ceux qui
 * manquent sont retéléchargés et les intrus (hors liste `ignored`) sont supprimés.
 * Le jeu n'est jamais démarré.
 * @returns {Promise<void>}
 */
async function verifyFiles() {
  // Même verrou que `launch()`, pris de la même façon : synchrone, avant tout `await`.
  acquire('vérification');

  let run = null;
  try {
    const config = store.getConfig();
    const list = await instances();
    if (list.length === 0) {
      throw fail('no_instance', "Aucune instance de jeu n'est accessible avec ce compte.");
    }

    const instance = list.find((i) => i.name === config.instance_selected) || list[0];

    run = createRun('vérification', config);
    run.verifyOnly = true;
    current = run;

    const launcher = createLauncher(run, true);

    // La vérification ne démarre pas le jeu et n'a donc besoin d'aucune session ;
    // la bibliothèque exige seulement un objet `authenticator` non nul pour aller
    // jusqu'à la préparation des fichiers.
    const options = buildOptions(instance, config, {}, true);

    logger.info(`Vérification des fichiers de « ${instance.name} »…`);
    taskbar(2);
    await launcher.Launch(options);
  } catch (err) {
    abort(run, `Vérification impossible : ${err.message}`);
    throw err;
  }
}

/* ------------------------------------------------------------------ dossiers */

/**
 * Parcours récursif d'un dossier. Les liens symboliques sont ignorés (risque de
 * boucle infinie) et un dossier illisible n'interrompt jamais le relevé.
 * @param {string} dir
 * @param {{files: number, bytes: number}} acc
 */
async function walk(dir, acc) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else if (entry.isFile()) files.push(full);
  }

  if (files.length === 0) return;

  const sizes = await Promise.all(
    files.map((file) =>
      fsp
        .stat(file)
        .then((stat) => stat.size)
        .catch(() => null)
    )
  );

  for (const size of sizes) {
    if (size === null) continue;
    acc.files += 1;
    acc.bytes += size;
  }
}

/** Poids d'un dossier, en octets. Renvoie 0 s'il n'existe pas. */
async function directorySize(dir) {
  const acc = { files: 0, bytes: 0 };
  await walk(dir, acc);
  return acc.bytes;
}

/**
 * Nombre de fichiers et poids réel du dossier de jeu. Le parcours étant long sur une
 * installation complète, le résultat est mémorisé 30 s et jamais lancé deux fois de front.
 * @returns {Promise<{files: number, bytes: number, checked_at: string}>}
 */
async function filesStat() {
  if (filesStatCache && Date.now() - filesStatCache.at < FILES_STAT_TTL_MS) {
    return { ...filesStatCache.value };
  }
  if (filesStatInflight) return filesStatInflight;

  filesStatInflight = (async () => {
    const acc = { files: 0, bytes: 0 };
    await walk(paths.gameDir, acc);

    const value = { files: acc.files, bytes: acc.bytes, checked_at: new Date().toISOString() };
    filesStatCache = { at: Date.now(), value };
    return { ...value };
  })().finally(() => {
    filesStatInflight = null;
  });

  return filesStatInflight;
}

/**
 * Dossiers jetables : cache du launcher, journaux et rapports de plantage du jeu,
 * cache de têtes de skin de Minecraft. Rien qu'un prochain démarrage ne sache refaire.
 * @returns {Promise<string[]>}
 */
async function cacheTargets() {
  const game = paths.gameDir;
  const targets = [paths.cacheDir, path.join(game, 'assets', 'skins')];

  for (const name of DISPOSABLE) targets.push(path.join(game, name));

  // Chaque instance a ses propres journaux (docs : `<jeu>/instances/<nom>/`).
  const instancesDir = path.join(game, 'instances');
  let entries = [];
  try {
    entries = await fsp.readdir(instancesDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const name of DISPOSABLE) targets.push(path.join(instancesDir, entry.name, name));
  }

  return targets;
}

/**
 * Vide les caches jetables.
 * @returns {Promise<{freed_bytes: number}>}
 */
async function clearCache() {
  const targets = await cacheTargets();
  let freed = 0;

  for (const target of targets) {
    const size = await directorySize(target);
    if (size === 0) {
      // Un dossier vide ou absent : rien à supprimer, mais on le retire quand même
      // s'il traîne, pour ne pas laisser d'arborescence morte.
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    try {
      await fsp.rm(target, { recursive: true, force: true });
      freed += size;
    } catch (err) {
      logger.warn(`Cache non supprimé (${target}) : ${err.message}`);
    }
  }

  // Le cache du launcher doit exister en permanence : les services le réécrivent.
  await fsp.mkdir(paths.cacheDir, { recursive: true }).catch(() => {});
  filesStatCache = null;

  logger.info(`Cache vidé : ${freed} octet(s) libéré(s).`);
  return { freed_bytes: freed };
}

/* ------------------------------------------------------------------ fermeture */

/** Vrai pendant la clôture de session déclenchée par la fermeture du launcher. */
let releasingOnQuit = false;

/**
 * Rend la session de jeu quand le launcher se ferme alors qu'une exécution est en cours.
 *
 * Le jeu est lancé en `detached` : il survit au launcher, mais la session Yggdrasil, elle,
 * ne doit pas rester ouverte 24 h derrière lui. La fermeture est brièvement retardée, le
 * temps d'un aller-retour avec le serveur — jamais plus de `QUIT_RELEASE_TIMEOUT_MS`.
 */
electronApp.on('before-quit', (event) => {
  const run = current;
  if (releasingOnQuit || !run || run.finished || !run.clientToken) return;

  releasingOnQuit = true;
  event.preventDefault();
  logger.info('Fermeture du launcher : la session de jeu en cours est rendue au serveur…');

  const guard = new Promise((resolve) => {
    const timer = setTimeout(resolve, QUIT_RELEASE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });

  Promise.race([releaseSession(run), guard]).finally(() => electronApp.quit());
});

module.exports = {
  instances,
  launch,
  cancel,
  isRunning,
  verifyFiles,
  clearCache,
  filesStat,
  ownsTaskbar,
  onEvent,
};
