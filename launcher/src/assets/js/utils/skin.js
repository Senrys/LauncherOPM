/**
 * Rendu des skins Minecraft, côté renderer.
 *
 * Deux sorties, deux usages :
 *  - `headDataUrl()` : la face 8×8 de la tête + son calque « chapeau », dans un
 *    canevas CARRÉ — c'est l'avatar de la barre du bas (46 px), du popover des
 *    comptes (32 px), des cartes de comptes (56 px) et de la confirmation de
 *    rattachement (48 px) ;
 *  - `bodyDataUrl()` : le personnage EN PIED, composé face avant à partir des
 *    faces tête / torse / bras / jambes de la texture, dans un canevas de
 *    16 × 32 unités — c'est la scène de l'accueil, que la maquette montre en
 *    pied sur 404 px de haut, jamais en tête étirée.
 *
 * ACCÈS À LA TEXTURE — le point délicat.
 * Le document est chargé en `file://` et la texture vient de
 * `https://auth…/textures/<sha256>.png`. Lire les pixels d'une image d'une
 * autre origine exige que le serveur ouvre CORS, ce que le serveur Python ne
 * fait pas (`OPM_CORS_ORIGINS` vide, docs/DATA.md § 6). Sans passer par le
 * processus principal, AUCUN skin ne s'afficherait jamais : le canevas serait
 * teinté à tous les coups et le repli sortirait systématiquement.
 *
 * Trois chemins sont donc tentés, dans cet ordre, et le premier qui donne des
 * pixels lisibles gagne :
 *
 *   1. `window.opm.app.fetchImage(url)` — LA voie nominale. Le processus
 *      principal télécharge l'image (https uniquement, 2 Mo maximum, 8 s de
 *      délai, type MIME vérifié) et rend une `data:` URL : plus de question
 *      d'origine, plus de CORS, plus de canevas teinté. Le canal rend `null`
 *      en cas d'échec, jamais une exception ;
 *   2. `crossOrigin = "anonymous"` — filet, si le serveur venait à poser
 *      `Access-Control-Allow-Origin` sur `/textures/` (une texture publique
 *      adressée par son sha256 ne divulgue rien). Le résultat est mémorisé par
 *      origine : une origine qui refuse n'est plus sollicitée deux fois ;
 *   3. chargement SANS `crossOrigin` — l'image s'affiche, mais le canevas est
 *      « teinté ». On le vérifie avant de composer quoi que ce soit
 *      (`getImageData` sur un pixel) : si les pixels sont illisibles, on ne
 *      tente pas un `toDataURL()` qui lèverait, on rend franchement le repli.
 *
 * Repli : `steve.png` pour une tête, `silhouette.png` pour un corps. Jamais une
 * image cassée, jamais le personnage de démonstration de la maquette.
 *
 * Les rendus réussis sont gardés en mémoire pour la durée de la session : le
 * même skin est réclamé par la barre du bas, le popover, les paramètres et
 * l'accueil.
 */

/** Repli d'un avatar carré, résolu depuis ce module pour rester valable partout. */
export const FALLBACK_HEAD = new URL('../../images/steve.png', import.meta.url).href;

/** Repli du personnage en pied : la silhouette neutre, pas un skin de démonstration. */
export const FALLBACK_BODY = new URL('../../images/silhouette.png', import.meta.url).href;

/** Taille de rendu par défaut d'une tête : 8 px de texture agrandis 8 fois. */
const DEFAULT_SIZE = 64;

/** Agrandissement par défaut du corps : 16 × 32 unités → 128 × 256 px. */
const DEFAULT_BODY_SCALE = 8;

/** Gabarit du personnage en pied, en unités de texture (bras + torse + bras). */
const BODY_WIDTH = 16;
const BODY_HEIGHT = 32;

/** Délai maximal de chargement d'une texture, en millisecondes. */
const LOAD_TIMEOUT = 8000;

/** Cache mémoire : clé de rendu → promesse de `data:` URL. */
const cache = new Map();

/**
 * Origines dont on sait déjà si elles servent des textures lisibles.
 * `true` : CORS ouvert. `false` : inutile de retenter le mode anonyme.
 * @type {Map<string, boolean>}
 */
const corsByOrigin = new Map();

/* ========================================================================== */
/*  Accès à la texture                                                        */
/* ========================================================================== */

/**
 * Origine d'une URL, pour mémoriser son comportement CORS.
 * @param {string} url
 * @returns {string}
 */
function originOf(url) {
  try {
    return new URL(url, document.baseURI).origin;
  } catch {
    return '';
  }
}

/**
 * Rapatriement par le processus principal — `app.fetchImage` (docs/IPC.md,
 * canal `app:fetch-image`). Le canal rend une `data:` URL, ou `null` quand le
 * téléchargement a échoué ; il ne lève pas. On garde tout de même le `try`
 * pour le cas d'un pont absent ou d'une version plus ancienne du preload : la
 * chaîne doit dégrader, jamais casser.
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function viaBridge(url) {
  const fetchImage = window.opm?.app?.fetchImage;
  if (typeof fetchImage !== 'function') return null;

  try {
    const value = await fetchImage(url);
    return typeof value === 'string' && value.startsWith('data:') ? value : null;
  } catch (error) {
    console.warn('opm : rapatriement de la texture par le processus principal impossible.', error);
    return null;
  }
}

/**
 * Charge une image en mémoire, avec délai maximal.
 * @param {string} url
 * @param {{anonymous?: boolean}} [options]
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(url, { anonymous = false } = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (anonymous) image.crossOrigin = 'anonymous';
    image.decoding = 'async';

    const timer = setTimeout(() => {
      image.src = '';
      reject(new Error(`Délai dépassé au chargement du skin : ${url}`));
    }, LOAD_TIMEOUT);

    image.addEventListener('load', () => {
      clearTimeout(timer);
      resolve(image);
    }, { once: true });

    image.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`Skin illisible : ${url}`));
    }, { once: true });

    image.src = url;
  });
}

/**
 * Obtient la texture sous une forme exploitable, en essayant les trois chemins
 * décrits en tête de module.
 *
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
async function acquire(url) {
  const bridged = await viaBridge(url);
  if (bridged) return loadImage(bridged);

  const origin = originOf(url);
  const sameOrigin = origin === '' || origin === window.location.origin;

  if (!sameOrigin && corsByOrigin.get(origin) !== false) {
    try {
      const image = await loadImage(url, { anonymous: true });
      corsByOrigin.set(origin, true);
      return image;
    } catch {
      // Le serveur n'ouvre pas CORS : on retient l'origine et on retombe sur un
      // chargement ordinaire, qui affiche l'image mais teinte le canevas.
      if (corsByOrigin.get(origin) !== false) {
        corsByOrigin.set(origin, false);
        console.warn(
          `opm : le processus principal n'a pas rapatrié la texture et ${origin} ne répond pas `
          + 'avec « Access-Control-Allow-Origin » : les pixels du skin ne pourront pas être lus '
          + 'et le repli sera utilisé.',
        );
      }
    }
  }

  return loadImage(url);
}

/* ========================================================================== */
/*  Canevas                                                                   */
/* ========================================================================== */

/**
 * Prépare un canevas 2D sans lissage : un skin se dessine au pixel près.
 * @param {number} width
 * @param {number} height
 * @returns {{canvas: HTMLCanvasElement, context: CanvasRenderingContext2D}}
 */
function surface(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;

  return { canvas, context };
}

/**
 * Copie la texture dans un canevas à l'échelle 1 et vérifie que ses pixels sont
 * lisibles. C'est le seul test fiable : une image d'une autre origine chargée
 * sans CORS se dessine parfaitement mais rend le canevas illisible.
 *
 * @param {HTMLImageElement} image
 * @returns {CanvasRenderingContext2D|null} `null` si les pixels sont illisibles
 */
function readableCopy(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (width < 64 || height < 32) return null;

  const { context } = surface(width, height);
  context.drawImage(image, 0, 0);

  try {
    context.getImageData(0, 0, 1, 1);
    return context;
  } catch {
    // Canevas teinté : ni `getImageData()` ni `toDataURL()` ne fonctionneront.
    return null;
  }
}

/* ========================================================================== */
/*  Composition                                                               */
/* ========================================================================== */

/**
 * Dessine la tête (base + chapeau) dans un canevas carré.
 * @param {CanvasRenderingContext2D} source texture lisible, à l'échelle 1
 * @param {number} size côté du rendu, en pixels
 * @returns {string} `data:` URL
 */
function drawHead(source, size) {
  // Les skins haute définition sont des multiples de 64 : on met les
  // coordonnées à l'échelle plutôt que de refuser la texture.
  const unit = source.canvas.width / 64;
  const face = 8 * unit;

  const { canvas, context } = surface(size, size);

  // Couche de base, puis calque « chapeau » par-dessus.
  context.drawImage(source.canvas, 8 * unit, 8 * unit, face, face, 0, 0, size, size);
  context.drawImage(source.canvas, 40 * unit, 8 * unit, face, face, 0, 0, size, size);

  return canvas.toDataURL('image/png');
}

/**
 * Modèle de bras d'une texture 64×64 : `slim` (3 unités, « Alex ») ou `classic`
 * (4 unités, « Steve »).
 *
 * Le modèle n'est pas dans les pixels au sens strict — le serveur, lui, le tient
 * du profil Minecraft — mais un skin slim laisse forcément vides les deux
 * colonnes que le modèle classique remplit : x 54-55 pour le bras droit,
 * x 46-47 pour le bras gauche. C'est cette trace qu'on lit ici.
 *
 * @param {CanvasRenderingContext2D} source
 * @param {number} unit
 * @returns {'classic'|'slim'}
 */
function detectModel(source, unit) {
  for (const [x, y] of [[54, 20], [46, 52]]) {
    const { data } = source.getImageData(x * unit, y * unit, 2 * unit, 12 * unit);
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) return 'classic';
    }
  }
  return 'slim';
}

/**
 * Faces avant à composer, en unités de texture.
 * Chaque entrée vaut `[sx, sy, largeur, hauteur, dx, dy, miroir]`, la
 * destination étant la grille 16 × 32 du personnage :
 * bras (0…4) · torse (4…12) · bras (12…16) en largeur, tête (0…8) ·
 * torse et bras (8…20) · jambes (20…32) en hauteur.
 *
 * @param {'classic'|'slim'} model
 * @param {boolean} legacy texture 64×32 de l'ancien format
 * @returns {Array<[number, number, number, number, number, number, boolean]>}
 */
function bodyParts(model, legacy) {
  const arm = model === 'slim' ? 3 : 4;
  // Le bras plus fin reste collé au torse : la marge se prend à l'extérieur.
  const armLeft = 4 - arm;

  const parts = [
    [8, 8, 8, 8, 4, 0, false],       // tête
    [20, 20, 8, 12, 4, 8, false],    // torse
    [44, 20, arm, 12, armLeft, 8, false], // bras droit (à gauche de l'image)
    [4, 20, 4, 12, 4, 20, false],    // jambe droite
  ];

  if (legacy) {
    // 64×32 : la texture ne décrit que le côté droit et n'a pas de seconde
    // couche hors chapeau — les membres gauches en sont le reflet.
    parts.push([44, 20, arm, 12, 12, 8, true]);
    parts.push([4, 20, 4, 12, 8, 20, true]);
  } else {
    parts.push([36, 52, arm, 12, 12, 8, false]); // bras gauche
    parts.push([20, 52, 4, 12, 8, 20, false]);   // jambe gauche
  }

  // Seconde couche : le chapeau existe dans les deux formats, le reste non.
  parts.push([40, 8, 8, 8, 4, 0, false]);
  if (!legacy) {
    parts.push([20, 36, 8, 12, 4, 8, false]);          // veste
    parts.push([44, 36, arm, 12, armLeft, 8, false]);  // manche droite
    parts.push([52, 52, arm, 12, 12, 8, false]);       // manche gauche
    parts.push([4, 36, 4, 12, 4, 20, false]);          // surcouche jambe droite
    parts.push([4, 52, 4, 12, 8, 20, false]);          // surcouche jambe gauche
  }

  return parts;
}

/**
 * Compose le personnage en pied, vu de face.
 * @param {CanvasRenderingContext2D} source texture lisible, à l'échelle 1
 * @param {{scale: number, model: 'classic'|'slim'|null}} options
 * @returns {string} `data:` URL
 */
function drawBody(source, { scale, model }) {
  const unit = source.canvas.width / 64;
  const legacy = source.canvas.height * 2 <= source.canvas.width;
  const arms = model ?? (legacy ? 'classic' : detectModel(source, unit));

  const { canvas, context } = surface(BODY_WIDTH * scale, BODY_HEIGHT * scale);

  for (const [sx, sy, sw, sh, dx, dy, mirror] of bodyParts(arms, legacy)) {
    const width = sw * scale;
    const height = sh * scale;

    if (mirror) {
      context.save();
      context.translate(dx * scale + width, dy * scale);
      context.scale(-1, 1);
      context.drawImage(source.canvas, sx * unit, sy * unit, sw * unit, sh * unit, 0, 0, width, height);
      context.restore();
      continue;
    }

    context.drawImage(
      source.canvas,
      sx * unit, sy * unit, sw * unit, sh * unit,
      dx * scale, dy * scale, width, height,
    );
  }

  return canvas.toDataURL('image/png');
}

/* ========================================================================== */
/*  API publique                                                              */
/* ========================================================================== */

/**
 * Chaîne commune : cache, acquisition, contrôle de lisibilité, composition,
 * repli. Un échec n'est jamais mémorisé — la prochaine demande retente.
 *
 * @param {string|null|undefined} url
 * @param {string} key clé de cache
 * @param {(source: CanvasRenderingContext2D) => string} compose
 * @param {string} fallback image de repli
 * @returns {Promise<string>}
 */
function render(url, key, compose, fallback) {
  if (typeof url !== 'string' || url.trim() === '') return Promise.resolve(fallback);

  const cached = cache.get(key);
  if (cached) return cached;

  const pending = acquire(url)
    .then((image) => {
      const source = readableCopy(image);
      if (!source) {
        // Pixels illisibles (canevas teinté) ou texture hors gabarit : on le dit
        // une fois et on rend le repli, sans tenter un `toDataURL()` qui lèverait.
        cache.delete(key);
        console.warn(`opm : pixels du skin illisibles, repli utilisé (${url}).`);
        return fallback;
      }
      return compose(source);
    })
    .catch((error) => {
      // Échec ponctuel (réseau, texture illisible) : on ne mémorise pas le repli,
      // pour qu'une prochaine demande retente le rendu.
      cache.delete(key);
      console.warn('opm : rendu du skin impossible, repli sur l\'image par défaut.', error);
      return fallback;
    });

  cache.set(key, pending);
  return pending;
}

/**
 * Tête 8×8 d'un skin, prête à être posée dans un `<img>` carré.
 * En cas d'absence d'URL ou d'échec, renvoie le repli `steve.png`.
 *
 * @param {string|null|undefined} url URL de la texture du skin
 * @param {number} [size=64] côté du rendu, en pixels
 * @returns {Promise<string>} `data:` URL, ou chemin du repli
 */
export function headDataUrl(url, size = DEFAULT_SIZE) {
  return render(url, `head|${url}|${size}`, (source) => drawHead(source, size), FALLBACK_HEAD);
}

/**
 * Personnage EN PIED d'un skin, vu de face, dans un canevas de 16 × 32 unités.
 * Le `<img>` qui le porte doit être en `image-rendering: pixelated` : le rendu
 * est volontairement petit et c'est l'affichage qui l'agrandit, sans lissage.
 *
 * En cas d'absence d'URL ou d'échec, renvoie la silhouette neutre.
 *
 * @param {string|null|undefined} url URL de la texture du skin
 * @param {{scale?: number, model?: 'classic'|'slim'|null}} [options]
 *        `scale` : pixels par unité de texture ; `model` : modèle de bras
 *        annoncé par le serveur, déduit de la texture quand il est absent
 * @returns {Promise<string>} `data:` URL, ou chemin du repli
 */
export function bodyDataUrl(url, { scale = DEFAULT_BODY_SCALE, model = null } = {}) {
  return render(
    url,
    `body|${url}|${scale}|${model ?? 'auto'}`,
    (source) => drawBody(source, { scale, model }),
    FALLBACK_BODY,
  );
}

/**
 * Prépare les deux rendus d'un skin sans attendre le résultat (chauffe le
 * cache) : l'avatar de la barre du bas et le personnage de l'accueil sont
 * réclamés dès l'ouverture de l'application.
 *
 * @param {string|null|undefined} url
 * @param {number} [size=64] côté de l'avatar à préparer
 * @returns {Promise<void>}
 */
export function preloadSkin(url, size = DEFAULT_SIZE) {
  return Promise.all([headDataUrl(url, size), bodyDataUrl(url)]).then(() => undefined);
}
