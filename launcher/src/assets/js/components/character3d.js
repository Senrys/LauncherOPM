/**
 * Le personnage du joueur en 3D, qui vit sa vie.
 *
 * Au repos, il respire et tourne lentement sur lui-même. De temps en temps il
 * joue une petite scène, puis revient au repos :
 *
 *   - il éclate de rire ;
 *   - il sort une épée d'un coffre, s'entraîne, puis la range ;
 *   - il boit une chope ;
 *   - il salue ;
 *   - il regarde autour de lui.
 *
 * Le rendu est celui de skinview3d (déjà embarqué pour l'accueil). Les
 * accessoires — épée, coffre, chope — sont des pavés « voxel » construits ici,
 * avec les classes Three.js que skinview3d utilise déjà : on les récupère sur
 * les objets du personnage plutôt que d'embarquer Three.js une seconde fois.
 *
 * Une scène est une liste d'images clés : à chaque instant, chaque
 * articulation prend une valeur interpolée (avec lissage) entre la clé
 * précédente et la suivante. Toute scène commence et finit à la pose de repos,
 * donc rien ne « saute » à l'entrée ni à la sortie. Les valeurs sont des
 * DÉCALAGES ajoutés au mouvement de repos, en radians pour les rotations et en
 * pixels de skin pour les positions.
 *
 * Repères (ceux de skinview3d) : le personnage regarde vers +z. Un bras dont
 * `rotation.x` est négatif se lève vers l'avant ; une tête dont `rotation.x`
 * est négatif regarde vers le haut. Le bras droit du personnage est à x = -5,
 * c'est-à-dire à gauche de l'écran quand il nous fait face.
 *
 * `prefers-reduced-motion` : ni scènes ni rotation, seulement la respiration.
 */

/* ------------------------------------------------------------------ réglages */

/** Rotation de repos, en radians par seconde : un tour complet en un peu plus de deux minutes. */
const IDLE_TURN = 0.05;
/** Angle vers lequel le personnage se tourne pour jouer une scène : un trois-quarts face. */
const STAGE_YAW = 0.35;
/** Pause entre deux scènes, en secondes (tirée au hasard dans cet intervalle). */
const GAP = [7, 13];
/** Première scène, plus tôt : le joueur doit voir que son personnage est vivant. */
const FIRST_SCENE_AFTER = 3.5;
/**
 * Écartement de l'épaule quand le bras s'incline sur le côté, en pixels de skin
 * par unité de sin(angle). Le bras de Minecraft dépasse de 2 px au-dessus de son
 * pivot : dès qu'il s'incline latéralement, ce bout d'épaule rentre dans le
 * buste (ou le bras dans la tête). Décaler le bras vers l'extérieur d'autant
 * supprime le passage au travers — mesuré : 0 px d'interpénétration sur toutes
 * les poses des scènes avec 4, contre jusqu'à 0,9 px sans.
 */
const SHOULDER_SPREAD = 4;

/* ---------------------------------------------------------------- utilitaires */

const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** Lissage « en S » : départ et arrivée en douceur. */
const smooth = (x) => x * x * (3 - 2 * x);
/** Arrivée avec un léger dépassement : pour qu'un objet « apparaisse » avec du ressort. */
const backOut = (x) => {
  const c = 1.7;
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
};
const random = (min, max) => min + Math.random() * (max - min);

/**
 * Valeur d'une piste d'images clés au temps `t`.
 * @param {Array<[number, number]>} keys  couples [temps, valeur], triés
 * @param {number} t
 * @returns {number}
 */
function track(keys, t) {
  if (!keys || keys.length === 0) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i += 1) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const k = t1 === t0 ? 1 : smooth((t - t0) / (t1 - t0));
      return v0 + (v1 - v0) * k;
    }
  }
  return keys[keys.length - 1][1];
}

/* ------------------------------------------------------------------- scènes */

/**
 * Coups d'épée : une série de « armer — frapper — revenir ».
 * @param {number} start
 * @param {number} count
 * @returns {{rax: Array<[number, number]>, raz: Array<[number, number]>, by: Array<[number, number]>}}
 */
function swings(start, count) {
  const rax = [];
  const raz = [];
  const by = [];
  const wrist = [];
  let t = start;
  for (let i = 0; i < count; i += 1) {
    const high = i % 2 === 0; // alterne coup d'estoc et coup de taille
    // Ordre des gestes, pour que la lame ne se dresse jamais bras levé (elle
    // sortirait du cadre) : à l'armé, le poignet bascule la lame en arrière
    // AVANT que le bras ne monte ; à la frappe, le bras redescend lame en
    // arrière, puis le poignet fouette vers l'avant.
    rax.push([t, -1.1], [t + 0.15, -1.15], [t + 0.35, high ? -2.25 : -1.95], [t + 0.5, -0.75], [t + 0.6, -0.75], [t + 0.95, -1.1]);
    raz.push([t, 0], [t + 0.35, high ? -0.2 : -0.45], [t + 0.5, high ? 0.12 : 0.2], [t + 0.95, 0]);
    by.push([t, 0], [t + 0.35, -0.12], [t + 0.5, 0.15], [t + 0.95, 0]);
    wrist.push([t, 0.75], [t + 0.15, -0.9], [t + 0.5, -0.9], [t + 0.6, 0.6], [t + 0.95, 0.75]);
    t += 1.05;
  }
  return { rax, raz, by, wrist };
}

/**
 * Les scènes. `duration` en secondes ; `tracks` : images clés par
 * articulation ; `extra(player, t, pose)` ajoute ce que des images clés
 * rendraient mal (rire saccadé, gorgées, main qui salue).
 */
const SCENES = {
  laugh: {
    weight: 1,
    duration: 3.2,
    tracks: {
      headX: [[0, 0], [0.35, -0.42], [2.7, -0.42], [3.2, 0]],
      rightArmX: [[0, 0], [0.3, -0.9], [2.85, -0.9], [3.2, 0]],
      rightArmZ: [[0, 0], [0.15, 0], [0.45, 0.1], [2.6, 0.1], [2.85, 0]],
      leftArmX: [[0, 0], [0.3, -0.9], [2.85, -0.9], [3.2, 0]],
      leftArmZ: [[0, 0], [0.15, 0], [0.45, -0.1], [2.6, -0.1], [2.85, 0]],
      shake: [[0, 0], [0.35, 1], [2.6, 1], [3.1, 0]],
    },
    extra(player, t, pose) {
      // Le rire : de petites secousses rapides de la tête et du buste.
      const s = pose.shake * Math.abs(Math.sin(t * 15));
      player.skin.head.rotation.x += s * 0.12;
      player.position.y += s * 0.55;
      // Les secousses écartent les bras du ventre, jamais l'inverse.
      player.skin.rightArm.rotation.z -= s * 0.06;
      player.skin.leftArm.rotation.z += s * 0.06;
    },
  },

  drink: {
    weight: 1,
    duration: 4.4,
    tracks: {
      mug: [[0, 0], [0.45, 1], [3.9, 1], [4.4, 0]],
      rightArmX: [[0, 0], [0.6, -1.3], [1.1, -1.35], [1.6, -1.75], [2.9, -1.75], [3.4, -1.3], [3.8, -1.3], [4.4, 0]],
      rightArmZ: [[0, 0], [0.6, 0.12], [1.6, 0.2], [2.9, 0.2], [3.4, 0.12], [4.4, 0]],
      headX: [[0, 0], [1.6, 0], [1.85, -0.3], [2.9, -0.3], [3.3, 0.06], [3.7, 0], [4.4, 0]],
      gulp: [[0, 0], [1.7, 0], [1.8, 1], [2.8, 1], [2.9, 0]],
      sigh: [[0, 0], [3.3, 0], [3.5, 1], [3.9, 0]],
    },
    extra(player, t, pose) {
      // Les gorgées, puis le « ahh » satisfait.
      player.skin.head.rotation.x += pose.gulp * Math.sin(t * 11) * 0.05;
      player.position.y += pose.sigh * 0.6;
    },
  },

  train: (() => {
    const s = swings(3.2, 4);
    const end = 3.2 + 4 * 1.05; // 7.4
    return {
      weight: 1,
      duration: end + 3.3,
      tracks: {
        chest: [[0, 0], [0.6, 1], [2.9, 1], [3.3, 0], [end + 0.2, 0], [end + 0.8, 1], [end + 2.7, 1], [end + 3.2, 0]],
        lid: [[0, 0], [0.8, 0], [1.2, 1], [2.4, 1], [2.8, 0], [end + 0.9, 0], [end + 1.3, 1], [end + 2.1, 1], [end + 2.5, 0]],
        headY: [[0, 0], [0.6, -0.42], [1.8, -0.42], [2.1, 0], [end + 0.9, 0], [end + 1.4, -0.42], [end + 2.4, -0.42], [end + 2.9, 0]],
        rightArmX: [
          [0, 0], [1.2, 0], [1.6, -0.3], [2.0, -0.3], [2.6, -1.1],
          ...s.rax,
          [end + 0.6, -1.0], [end + 1.4, -0.3], [end + 1.8, -0.3], [end + 2.3, 0],
        ],
        rightArmZ: [
          [0, 0], [1.2, 0], [1.6, -0.4], [2.0, -0.4], [2.6, 0],
          ...s.raz,
          [end + 0.6, 0], [end + 1.4, -0.3], [end + 1.8, -0.3], [end + 2.3, 0],
        ],
        bodyY: [[0, 0], [3.2, 0], ...s.by, [end, 0]],
        sword: [[0, 0], [1.75, 0], [2.0, 1], [end + 1.5, 1], [end + 1.75, 0]],
        // Lame inclinée vers l'avant tant qu'elle est tenue : dressée, elle sortait du cadre.
        wrist: [[0, 0], [1.75, 0], [2.3, 0.75], ...s.wrist, [end + 0.6, 0.75], [end + 1.5, 0]],
        // Garde : pied droit en arrière pendant l'entraînement.
        rightLegX: [[0, 0], [2.8, 0], [3.2, 0.3], [end, 0.3], [end + 0.4, 0]],
        leftLegX: [[0, 0], [2.8, 0], [3.2, -0.22], [end, -0.22], [end + 0.4, 0]],
        leftArmX: [[0, 0], [2.8, 0], [3.2, -0.5], [end, -0.5], [end + 0.4, 0]],
        leftArmZ: [[0, 0], [2.8, 0], [3.2, 0.1], [end, 0.1], [end + 0.4, 0]],
      },
    };
  })(),

  wave: {
    weight: 0.6,
    duration: 2.8,
    tracks: {
      rightArmX: [[0, 0], [0.5, -2.75], [2.3, -2.75], [2.8, 0]],
      rightArmZ: [[0, 0], [0.5, -0.2], [2.3, -0.2], [2.8, 0]],
      wave: [[0, 0], [0.5, 1], [2.3, 1], [2.6, 0]],
      headZ: [[0, 0], [0.5, -0.12], [2.3, -0.12], [2.8, 0]],
    },
    extra(player, t, pose) {
      player.skin.rightArm.rotation.z += pose.wave * Math.sin(t * 9) * 0.15;
    },
  },

  look: {
    weight: 0.8,
    duration: 3.6,
    tracks: {
      headY: [[0, 0], [0.6, 0.7], [1.5, 0.7], [2.3, -0.7], [3.0, -0.7], [3.6, 0]],
      headX: [[0, 0], [0.6, -0.1], [1.5, -0.1], [2.3, 0.05], [3.0, 0.05], [3.6, 0]],
      bodyY: [[0, 0], [0.6, 0.18], [1.5, 0.18], [2.3, -0.18], [3.0, -0.18], [3.6, 0]],
    },
  },
};

/* --------------------------------------------------------------- accessoires */

/**
 * Récupère les classes Three.js que skinview3d a déjà chargées.
 * @param {any} player
 * @param {any} lib  le global skinview3d
 */
function threeOf(player, lib) {
  const mesh = player.skin.head.innerLayer;
  return {
    Mesh: mesh.constructor,
    Box: mesh.geometry.constructor,
    Material: mesh.material.constructor,
    // BodyPart hérite directement de Group.
    Group: Object.getPrototypeOf(lib.BodyPart.prototype).constructor,
  };
}

/**
 * Fabrique de pavés colorés.
 * @param {ReturnType<typeof threeOf>} T
 */
function voxels(T) {
  const materials = new Map();
  const material = (color) => {
    if (!materials.has(color)) materials.set(color, new T.Material({ color }));
    return materials.get(color);
  };
  const box = (w, h, d, color, x = 0, y = 0, z = 0) => {
    const mesh = new T.Mesh(new T.Box(w, h, d), material(color));
    mesh.position.set(x, y, z);
    return mesh;
  };
  const group = (...children) => {
    const g = new T.Group();
    for (const child of children) g.add(child);
    return g;
  };
  return { box, group, materials };
}

/**
 * Épée, tenue par la poignée. Elle pointe vers +z : bras au repos, elle est
 * horizontale vers l'avant ; bras levé, elle se dresse.
 */
function buildSword(V) {
  return V.group(
    V.box(1.5, 1.5, 0.8, '#3b2a1a', 0, 0, -1.9), // pommeau
    V.box(1, 1, 3.6, '#6b4423', 0, 0, 0.25), // poignée, du pommeau à la garde
    V.box(5.2, 1.2, 1.2, '#c9a227', 0, 0, 2.6), // garde
    V.box(1.4, 0.45, 8, '#dfe4e8', 0, 0, 7.2), // lame
    V.box(0.35, 0.5, 7.9, '#aeb6bd', 0.55, 0, 7.2), // fil (plus court que la lame : extrémités décalées)
    V.box(0.8, 0.45, 1, '#dfe4e8', 0, 0, 11.7), // pointe
  );
}

/**
 * Chope en bois cerclée de fer, mousse débordante. Construite debout (+y),
 * puis basculée d'un quart de tour : dans la main d'un bras tendu vers
 * l'avant, elle se retrouve droite.
 */
function buildMug(V) {
  const mug = V.group(
    V.box(3.6, 4.6, 3.6, '#8a5a2b', 0, 0, 0), // fût
    V.box(3.8, 0.55, 3.8, '#5d646b', 0, 1.5, 0), // cerclage haut
    V.box(3.8, 0.55, 3.8, '#5d646b', 0, -1.5, 0), // cerclage bas
    V.box(3.7, 0.9, 3.7, '#f4efe1', 0, 2.65, 0), // mousse
    V.box(1.6, 0.7, 1.6, '#f4efe1', 0.6, 3.3, -0.3), // mousse qui déborde
    V.box(0.8, 3, 1, '#6b4423', 2.25, 0, 0), // anse
  );
  mug.rotation.x = Math.PI / 2;
  const holder = V.group(mug);
  return holder;
}

/**
 * Coffre au couvercle articulé : `lid` pivote sur l'arête arrière.
 * @returns {{root: any, lid: any}}
 */
function buildChest(V) {
  // Chaque garniture dépasse un peu de la caisse qu'elle habille : deux faces
  // exactement superposées « scintillent » (z-fighting) à l'écran.
  const lid = V.group(
    V.box(7, 1.9, 5.6, '#7a4a20', 0, 0.95, 2.8),
    V.box(7.2, 0.55, 5.8, '#4a2d12', 0, 0.22, 2.8),
    V.box(1, 1.2, 0.5, '#c9a227', 0, 0.2, 5.75), // serrure
  );
  lid.position.set(0, 2.25, -2.8); // charnière : arête arrière, en haut du coffre
  const body = V.group(
    V.box(7, 4.5, 5.6, '#8a5a2b', 0, 0, 0),
    V.box(7.2, 0.55, 5.8, '#4a2d12', 0, -2.0, 0),
    V.box(0.6, 4.6, 5.9, '#4a2d12', -3.25, 0, 0),
    V.box(0.6, 4.6, 5.9, '#4a2d12', 3.25, 0, 0),
    lid,
  );
  // L'origine est au SOL : quand le coffre apparaît en grandissant, il pousse
  // depuis le plancher au lieu de s'enfoncer dessous.
  body.position.y = 2.25;
  const root = V.group(body);
  return { root, lid };
}

/* ------------------------------------------------------------------ personnage */

/**
 * Crée le personnage dans un canevas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{width: number, height: number, zoom?: number}} size
 * @returns {{
 *   viewer: any,
 *   loadSkin: (source: any, model?: 'classic'|'slim') => Promise<void>,
 *   play: (name: string) => void,
 *   setPaused: (paused: boolean) => void,
 *   resize: (width: number, height: number) => void,
 *   dispose: () => void,
 * }}
 */
export function createCharacter(canvas, { width, height, zoom = 0.86 }) {
  const lib = window.skinview3d;
  if (!lib) throw new Error('skinview3d absent');

  const viewer = new lib.SkinViewer({ canvas, width, height });
  viewer.fov = 40;
  viewer.zoom = zoom;
  viewer.autoRotate = false; // c'est l'animation qui fait tourner le personnage
  if (viewer.controls) {
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;
  }

  const player = viewer.playerObject;
  const T = threeOf(player, lib);
  const V = voxels(T);

  // Accessoires, invisibles tant qu'une scène ne les montre pas.
  const sword = buildSword(V);
  const mug = buildMug(V);
  const chest = buildChest(V);
  for (const prop of [sword, mug, chest.root]) prop.visible = false;
  player.skin.rightArm.add(sword, mug);
  player.skin.add(chest.root);

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let slim = false;

  /** Place les accessoires selon le modèle de bras (le poing n'est pas au même endroit). */
  const placeProps = () => {
    const handX = slim ? -0.5 : -1;
    sword.position.set(handX, -9.6, 0.6);
    mug.position.set(handX, -9.8, 1.6);
    chest.root.position.set(-10, -24, 0);
    chest.root.rotation.y = 0.45;
  };
  placeProps();

  /* ---------------------------------------------------- état de l'animation */

  let clock = 0;
  let yaw = 0;
  let nextAt = FIRST_SCENE_AFTER;
  /** @type {{name: string, start: number, fromYaw: number, toYaw: number}|null} */
  let current = null;
  let last = '';

  const pickScene = () => {
    const names = Object.keys(SCENES).filter((name) => name !== last);
    const total = names.reduce((sum, name) => sum + SCENES[name].weight, 0);
    let roll = Math.random() * total;
    for (const name of names) {
      roll -= SCENES[name].weight;
      if (roll <= 0) return name;
    }
    return names[0];
  };

  const startScene = (forced) => {
    const name = forced && SCENES[forced] ? forced : pickScene();
    // Se tourner vers le spectateur par le chemin le plus court.
    const turns = Math.round((yaw - STAGE_YAW) / (2 * Math.PI));
    const toYaw = STAGE_YAW + turns * 2 * Math.PI;
    current = { name, start: clock, fromYaw: yaw, toYaw };
    last = name;
  };

  const show = (object, scale) => {
    object.visible = scale > 0.001;
    const s = Math.max(0.001, backOut(clamp01(scale)));
    object.scale.set(s, s, s);
  };

  const animation = new lib.FunctionAnimation((p, progress, delta) => {
    const dt = Math.min(0.1, Math.max(0, delta || 0));
    clock += dt;

    // Repos : respiration des bras, pose neutre.
    const breath = 2 * clock;
    p.skin.resetJoints?.();
    p.position.y = 0;
    p.skin.leftArm.rotation.z = 0.03 * Math.cos(breath) + 0.02 * Math.PI;
    p.skin.rightArm.rotation.z = 0.03 * Math.cos(breath + Math.PI) - 0.02 * Math.PI;
    p.skin.head.rotation.x = 0.02 * Math.sin(clock * 0.7);

    let pose = {};
    if (!reduced && !current && clock >= nextAt) startScene();

    if (current) {
      const scene = SCENES[current.name];
      const t = clock - current.start;
      for (const [key, keys] of Object.entries(scene.tracks)) pose[key] = track(keys, t);

      // Se tourner vers le spectateur pendant la première seconde.
      yaw = current.fromYaw + (current.toYaw - current.fromYaw) * smooth(clamp01(t / 0.9));

      if (t >= scene.duration) {
        current = null;
        pose = {};
        nextAt = clock + random(GAP[0], GAP[1]);
      }
    } else if (!reduced) {
      yaw += IDLE_TURN * dt;
    }

    // Décalages de la scène, ajoutés au repos.
    p.rotation.y = yaw;
    const sk = p.skin;
    sk.head.rotation.x += pose.headX ?? 0;
    sk.head.rotation.y += pose.headY ?? 0;
    sk.head.rotation.z += pose.headZ ?? 0;
    sk.body.rotation.y += pose.bodyY ?? 0;
    sk.rightArm.rotation.x += pose.rightArmX ?? 0;
    sk.rightArm.rotation.z += pose.rightArmZ ?? 0;
    sk.leftArm.rotation.x += pose.leftArmX ?? 0;
    sk.leftArm.rotation.z += pose.leftArmZ ?? 0;
    sk.rightLeg.rotation.x += pose.rightLegX ?? 0;
    sk.leftLeg.rotation.x += pose.leftLegX ?? 0;
    // Le buste qui pivote entraîne les bras : sans ça ils resteraient plantés.
    sk.rightArm.rotation.y += pose.bodyY ?? 0;
    sk.leftArm.rotation.y += pose.bodyY ?? 0;

    if (current) SCENES[current.name].extra?.(p, clock - current.start, pose);

    // Épaules : écarter le bras d'autant qu'il s'incline sur le côté. On ne
    // compense que l'inclinaison AJOUTÉE par la scène — au repos, les bras
    // restent collés au buste.
    const idleRight = 0.03 * Math.cos(breath + Math.PI) - 0.02 * Math.PI;
    const idleLeft = 0.03 * Math.cos(breath) + 0.02 * Math.PI;
    sk.head.position.y = 2.1 * Math.abs(Math.sin(sk.head.rotation.x)) + 4.1 * Math.abs(Math.sin(sk.head.rotation.z))
      + 0.9 * Math.abs(Math.sin(sk.head.rotation.y));
    sk.rightArm.position.x = -5 - SHOULDER_SPREAD * Math.abs(Math.sin(sk.rightArm.rotation.z - idleRight));
    sk.leftArm.position.x = 5 + SHOULDER_SPREAD * Math.abs(Math.sin(sk.leftArm.rotation.z - idleLeft));

    show(sword, pose.sword ?? 0);
    sword.rotation.x = pose.wrist ?? 0;
    show(mug, pose.mug ?? 0);
    show(chest.root, pose.chest ?? 0);
    chest.lid.rotation.x = -1.25 * (pose.lid ?? 0);
  });
  viewer.animation = animation;

  return {
    viewer,

    async loadSkin(source, model = 'classic') {
      slim = model === 'slim';
      placeProps();
      const result = viewer.loadSkin(source, { model: slim ? 'slim' : 'default' });
      if (result && typeof result.then === 'function') await result;
    },

    /**
     * Joue une scène tout de suite (« laugh », « drink », « train », « wave »,
     * « look »). Sert aux essais ; en usage normal, les scènes viennent seules.
     * @param {string} name
     */
    play(name, at = 0) {
      if (!SCENES[name]) return;
      startScene(name);
      // `at` : démarrer la scène déjà avancée de `at` secondes (essais visuels).
      if (current && at > 0) current.start -= at;
    },

    setPaused(paused) {
      viewer.renderPaused = Boolean(paused);
    },

    resize(w, h) {
      if (w > 0 && h > 0) {
        viewer.width = Math.round(w);
        viewer.height = Math.round(h);
      }
    },

    dispose() {
      for (const material of V.materials.values()) material.dispose?.();
      viewer.dispose();
    },
  };
}
