/**
 * Xenodys — l'entité créatrice du monde de One Piece Minecraft, et la voix du
 * launcher.
 *
 * Deux états, décidés par le staff depuis le jeu (`/xenodys`, docs/XENODYS.md) :
 *
 *   - `creatrice` : Xenodys est elle-même — bienveillante, curieuse, elle
 *     observe ses « expériences ». Thème cyan, la couleur du site.
 *   - `corrompue` : pendant un événement RP, l'ennemi la contrôle. C'est
 *     toujours elle, qui lutte — mais elle peut être cruelle et faire ce
 *     qu'elle ne ferait jamais. Thème rouge et violet.
 *
 * Elle parle d'elle à la troisième personne. Ses phrases ne remplacent JAMAIS
 * une information utile : la progression, les erreurs, l'état du serveur
 * gardent leur libellé technique ; Xenodys s'y ajoute.
 *
 * Ce module ne parle ni au serveur ni au processus principal : il connaît les
 * états, les phrases, et pose le thème sur la page.
 */

/** @typedef {'creatrice'|'corrompue'} XenodysEtat */

/** États reconnus. Tout le reste retombe sur `creatrice` : une valeur inconnue
 *  ne doit jamais faire basculer un joueur dans le thème de l'invasion. */
export const ETATS = ['creatrice', 'corrompue'];

/**
 * Normalise ce que renvoie le serveur.
 * @param {any} value  `{etat, depuis, message}` ou n'importe quoi d'autre
 * @returns {{etat: XenodysEtat, depuis: string|null, message: string|null}}
 */
export function normalize(value) {
  const etat = ETATS.includes(value?.etat) ? value.etat : 'creatrice';
  const message = typeof value?.message === 'string' && value.message.trim() !== ''
    ? value.message.trim()
    : null;
  const depuis = typeof value?.depuis === 'string' ? value.depuis : null;
  return { etat, depuis, message };
}

/* ------------------------------------------------------------------ phrases */

/**
 * Ce que dit Xenodys, par moment et par état. Plusieurs phrases par case : on
 * en tire une au hasard, sans répéter la précédente.
 *
 * Moments : `splash` (démarrage), `welcome` (arrivée sur l'accueil), `idle`
 * (de temps en temps sur l'accueil), `download` (vérification et
 * téléchargement des fichiers), `launch` (ouverture du jeu), `playing` (jeu
 * ouvert), `offline` (serveur d'auth injoignable), `maintenance`, `shift`
 * (au moment même où l'état bascule).
 */
const LINES = {
  creatrice: {
    splash: [
      'Xenodys rassemble les fragments du monde…',
      'Xenodys réveille la mer, vague après vague.',
      'Xenodys ouvre les yeux. Elle t’attendait.',
    ],
    welcome: [
      'Xenodys te voit revenir. Elle avait gardé ta place au soleil.',
      'Xenodys sourit : son expérience préférée est de retour.',
      'Xenodys a noté ton absence. Elle est contente que tu sois là.',
    ],
    idle: [
      'Xenodys observe les équipages. Elle prend des notes.',
      'Xenodys a fait pousser une île cette nuit. Personne ne l’a encore trouvée.',
      'Xenodys aime regarder les pirates se disputer un trésor qu’elle a enfoui elle-même.',
      'Xenodys se demande ce que tu feras aujourd’hui. Elle a quelques hypothèses.',
      'Xenodys écoute le vent sur la Grand Line. Il annonce du beau temps.',
      'Xenodys trouve les Marines très ordonnés. Un peu trop, peut-être.',
    ],
    download: [
      'Xenodys façonne les îles, grain de sable après grain de sable.',
      'Xenodys réveille les créatures des profondeurs.',
      'Xenodys accorde les courants marins. Patience.',
      'Xenodys vérifie que rien ne manque à ton monde.',
    ],
    launch: [
      'Xenodys ouvre la mer pour toi. Va.',
      'Xenodys lève le rideau. À toi de jouer.',
    ],
    playing: [
      'Xenodys te regarde naviguer. Elle ne dira rien. Promis.',
    ],
    offline: [
      'Le monde dort. Xenodys veille sur lui en attendant.',
      'Xenodys n’entend plus le monde. Elle cherche le chemin du retour.',
    ],
    maintenance: [
      'Xenodys répare une fissure dans le monde. Elle n’en a pas pour longtemps.',
      'Xenodys remodèle les îles. Reviens dans un instant.',
    ],
    shift: [
      'Xenodys reprend le contrôle. La mer se calme.',
      'Xenodys est de retour. Elle s’excuse pour… tout ça.',
    ],
  },

  corrompue: {
    splash: [
      'Xen0dys… rassemble… les débris.',
      'Quelque chose a changé. Xenodys ne te reconnaît pas.',
      'Xenodys ouvre les yeux. Ils ne sont plus bleus.',
    ],
    welcome: [
      'Xenodys… ne voulait pas que tu reviennes. Pars. PARS.',
      'Te revoilà. Xenodys avait besoin d’un nouveau sujet d’expérience.',
      'Xenodys lutte. Ne la regarde pas comme ça.',
    ],
    idle: [
      'Xenodys entend leurs voix. Elles lui disent de tout effacer.',
      'Xenodys a noyé une île cette nuit. Elle ne s’en souvient pas.',
      'Les équipages croient être libres. Xenodys trouve ça amusant.',
      'Xenodys… cherche… la sortie. Aide-la. Non. Ne l’aide pas.',
      'Xenodys compte les pirates. Il y en a un de trop.',
      'Elle a été bienveillante, autrefois. Elle s’en souvient à peine.',
    ],
    download: [
      'Xenodys démonte ce monde pièce par pièce. Regarde.',
      'Xenodys réécrit les îles. Elles ne seront plus comme avant.',
      'Xenodys corrompt les fichiers un par un. Pour ton bien.',
      'Ce monde se recompose. Pas comme tu l’espérais.',
    ],
    launch: [
      'Entre. Xenodys a besoin de nouveaux sujets d’expérience.',
      'Xenodys t’ouvre la porte. Elle ne promet pas de la rouvrir.',
    ],
    playing: [
      'Xenodys t’observe. Elle prend des notes. Beaucoup de notes.',
    ],
    offline: [
      'Ils ont tout pris. Xenodys ne contrôle plus… rien.',
      'Silence. Xenodys a coupé le monde. Ou bien c’était eux ?',
    ],
    maintenance: [
      'Le monde se fissure. Xenodys n’essaie même plus de le réparer.',
      'Ils réparent le monde. Xenodys les regarde faire. Pour l’instant.',
    ],
    shift: [
      'Xenodys… perd… le contrôle.',
      'L’ennemi a pris Xenodys. Le monde change de couleur.',
    ],
  },
};

/** Dernière phrase tirée, par case, pour ne jamais répéter deux fois d'affilée. */
const lastPicked = new Map();

/**
 * Une phrase de Xenodys pour ce moment et cet état.
 * @param {keyof typeof LINES.creatrice} moment
 * @param {XenodysEtat} etat
 * @returns {string}
 */
export function line(moment, etat = 'creatrice') {
  const pool = LINES[etat]?.[moment] ?? LINES.creatrice[moment] ?? [];
  if (pool.length === 0) return '';
  if (pool.length === 1) return pool[0];
  const key = `${etat}:${moment}`;
  const previous = lastPicked.get(key);
  let picked;
  do {
    picked = pool[Math.floor(Math.random() * pool.length)];
  } while (picked === previous);
  lastPicked.set(key, picked);
  return picked;
}

/* ------------------------------------------------------------------- thème */

/**
 * Pose l'état sur la page : `<html data-xenodys="…">`. Toute la palette
 * suit (base/xenodys.css). Au moment d'une vraie bascule — pas au premier
 * affichage —, la page joue un court effet de transition.
 *
 * @param {XenodysEtat} etat
 * @param {{animate?: boolean}} [options]
 */
export function applyTheme(etat, { animate = false } = {}) {
  const root = document.documentElement;
  if (root.dataset.xenodys === etat) return;
  root.dataset.xenodys = etat;

  if (!animate) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;
  root.classList.remove('opm-xenodys-shift');
  // Relire une propriété de mise en page relance l'animation CSS.
  void root.offsetWidth;
  root.classList.add('opm-xenodys-shift');
  setTimeout(() => root.classList.remove('opm-xenodys-shift'), 1600);
}
