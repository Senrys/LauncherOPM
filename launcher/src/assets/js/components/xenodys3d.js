/**
 * Xenodys la Tisseuse en 3D — hors du cadre, en mode « fenêtre ouverte ».
 *
 * Lit son modèle dans le paquet de ressources (assets/js/data/xenodys-model.js :
 * géométrie préparée et animations, les mêmes que dans le jeu) et le fait vivre dans un canevas posé à cheval sur le bord droit du
 * launcher (layout/frame.css, `.opm-xeno-stage`).
 *
 * Le rendu passe par un second `SkinViewer` de skinview3d, dont on cache le
 * joueur : renderer, caméra et lumières sont déjà réglés, et Three.js n'est
 * chargé qu'une fois. Les textures sont filtrées « nearest » ; leur glowmask
 * (comme l'AutoGlowingGeoLayer de GeckoLib) devient une texture émissive.
 *
 * Dans le launcher, elle joue le « penché » (`lean`) : immense, derrière le
 * cadre, le bas du corps caché, elle penche le buste et regarde le joueur ;
 * sa main gauche agrippe le bord droit du launcher, sa main droite la bordure
 * du haut — ses doigts seuls passent devant (masque de la scène). Deux petits
 * assistants l'accompagnent : l'un se cache au coin bas-gauche du cadre,
 * l'autre se tient près d'elle. Corrompue : `corrupted_lean`, et les
 * textures rouges et violettes. L'état suit `<html data-xenodys>`.
 *
 * Elle vit : elle arrive une fois le cadre construit (`arrive`), suit la
 * souris du regard, cligne des yeux, regarde le bouton JOUER qu'on survole
 * (`attend`), réagit à un lancement raté (`react`), et sa bascule d'un état à
 * l'autre part de son cœur (`shift`). Ses mains, elles, ne bougent jamais.
 * Pendant la préparation des fichiers, le launcher reste ouvert : elle tisse
 * la barre de progression (`weave`). Le jeu démarre : la cinématique du départ
 * (`launch`) — penchée, elle prend le joueur dans sa main gauche, le launcher se
 * replie dans sa main droite, puis elle se redresse et ouvre le passage.
 * `comeBack` : le launcher revient.
 */

import { ANIMATIONS, ASSISTANT_ANIMATIONS, RIGS, layersOf } from '../data/xenodys-model.js';
import { packImage } from '../utils/pack.js';
import { liveCharacter } from './character3d.js';
import { rebuildFrame } from './intro.js';
import { DRIVERS } from './tisseuse.js';

const NEAREST = 1003;
const DEG = Math.PI / 180;
/** Mise à l'échelle du modèle dans la scène de skinview3d. */
const MODEL_SCALE = 0.5;

/* ------------------------------------------------------------- géométrie */

/** Bedrock → espace Blockbench / Three.js : l'axe x est inversé. */
const pivotOf = (p) => [-p[0], p[1], p[2]];

/**
 * Construit un modèle préparé (xenodys/tisseuse.py) : un groupe par os, et au plus un
 * maillage par os et par couche. Renvoie la racine et les os, par nom.
 * @param {any} T  classes Three.js
 * @param {{base: any, verre: any, energie: any}} materials
 */
function buildRig(T, { id, meta, faces }, materials) {
  const layers = layersOf({ meta });
  const defs = meta.os;
  const root = new T.Group();
  const bones = new Map();
  const needsRoot = id.startsWith('assistant') && !defs.some((d) => d.nom === 'assistant');
  let top = null;
  if (needsRoot) {
    top = { group: new T.Group(), pivot: [0, 0, 0], repos: [0, 0, 0] };
    top.rest = { position: top.group.position.clone(), rotation: [0, 0, 0] };
    root.add(top.group);
    bones.set('assistant', top);
  }
  const pending = [...defs];
  while (pending.length) {
    const d = pending.shift();
    if (d.parent && !bones.has(d.parent)) {
      pending.push(d);
      continue;
    }
    const group = new T.Group();
    group.rotation.order = 'ZYX';
    const pivot = pivotOf(d.pivot);
    const parent = d.parent ? bones.get(d.parent) : top;
    const base = parent ? parent.pivot : [0, 0, 0];
    group.position.set(pivot[0] - base[0], pivot[1] - base[1], pivot[2] - base[2]);
    (parent ? parent.group : root).add(group);
    bones.set(d.nom, {
      group, pivot, repos: d.repos,
      rest: { position: group.position.clone(), rotation: [-d.repos[0] * DEG, -d.repos[1] * DEG, d.repos[2] * DEG] },
    });
    group.rotation.set(...bones.get(d.nom).rest.rotation);
  }
  for (const layer of ['base', 'verre', 'energie']) {
    const [first, count] = layers[layer];
    let i = first;
    while (i < first + count) {
      const bone = faces[i * 24];
      let j = i;
      while (j < first + count && faces[j * 24] === bone) j += 1;
      const n = j - i;
      const pos = new Float32Array(n * 12);
      const nor = new Float32Array(n * 12);
      const uv = new Float32Array(n * 8);
      const idx = new Uint32Array(n * 6);
      for (let f = 0; f < n; f += 1) {
        const o = (i + f) * 24;
        for (let k = 0; k < 4; k += 1) {
          const q = o + 4 + k * 5;
          pos.set([faces[q], faces[q + 1], faces[q + 2]], (f * 4 + k) * 3);
          nor.set([faces[o + 1], faces[o + 2], faces[o + 3]], (f * 4 + k) * 3);
          uv.set([faces[q + 3], 1 - faces[q + 4]], (f * 4 + k) * 2);
        }
        idx.set([f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3], f * 6);
      }
      const geometry = new T.Geometry();
      geometry.setAttribute('position', new T.Attribute(pos, 3));
      geometry.setAttribute('normal', new T.Attribute(nor, 3));
      geometry.setAttribute('uv', new T.Attribute(uv, 2));
      geometry.setIndex(new T.Attribute(idx, 1));
      const mesh = new T.Mesh(geometry, materials[layer]);
      if (layer !== 'base') mesh.renderOrder = layer === 'verre' ? 1 : 2;
      bones.get(defs[bone].nom).group.add(mesh);
      i = j;
    }
  }
  return { root, bones, drive: DRIVERS[id], clock: 0, options: {} };
}

/* ------------------------------------------------------------ animations */

/** Prépare une piste : temps triés, valeurs, mode d'interpolation. */
function track(channel) {
  if (Array.isArray(channel)) return { times: [0], values: [channel], smooth: [false] };
  const times = Object.keys(channel).map(Number).sort((a, b) => a - b);
  const values = [];
  const smooth = [];
  for (const t of times) {
    const raw = channel[Object.keys(channel).find((k) => Number(k) === t)];
    const v = Array.isArray(raw) ? raw : raw.post ?? raw.pre;
    values.push(v.map(Number));
    smooth.push(!Array.isArray(raw) && raw.lerp_mode === 'catmullrom');
  }
  return { times, values, smooth };
}

function sample({ times, values, smooth }, t) {
  if (t <= times[0]) return values[0];
  const last = times.length - 1;
  if (t >= times[last]) return values[last];
  let i = 0;
  while (t > times[i + 1]) i += 1;
  const k = (t - times[i]) / (times[i + 1] - times[i]);
  const a = values[i];
  const b = values[i + 1];
  if (!smooth[i] && !smooth[i + 1]) return a.map((v, n) => v + (b[n] - v) * k);
  // Catmull-Rom, comme GeckoLib.
  const p0 = values[Math.max(0, i - 1)];
  const p3 = values[Math.min(last, i + 2)];
  const k2 = k * k;
  const k3 = k2 * k;
  return a.map((p1, n) => {
    const p2 = b[n];
    return 0.5 * (2 * p1 + (-p0[n] + p2) * k + (2 * p0[n] - 5 * p1 + 4 * p2 - p3[n]) * k2 + (-p0[n] + 3 * p1 - 3 * p2 + p3[n]) * k3);
  });
}

function compile(name, doc = ANIMATIONS, prefix = 'animation.xenodys') {
  const def = doc.animations[`${prefix}.${name}`];
  const bones = {};
  for (const [bone, channels] of Object.entries(def.bones)) {
    bones[bone] = {};
    for (const [kind, channel] of Object.entries(channels)) bones[bone][kind] = track(channel);
  }
  return { length: def.animation_length, loop: def.loop === true, bones };
}

/* ------------------------------------------------------------------ scène */

const ZERO = [0, 0, 0];

/** Applique une pose à un modèle : pour chaque os animé `{r, p}` (degrés, pixels,
 *  convention Bedrock), puis ce que les formules calculent (ailes, robe, cheveux…). */
function applyMap(rig, map) {
  const extra = new Map();
  const inp = (n) => {
    const r = map.get(n)?.r;
    return r ? [r[0] * DEG, r[1] * DEG, r[2] * DEG] : ZERO;
  };
  rig.drive?.(rig.clock, inp, (n, r, p, s, abs) => extra.set(n, { r, p, s, abs }), rig.options);
  for (const [name, bone] of rig.bones) {
    const e = extra.get(name);
    const m = map.get(name);
    const a = e?.abs ? ZERO : m?.r ?? ZERO;
    const d = e?.r ?? ZERO;
    const g = bone.group;
    const rest = bone.rest.rotation;
    g.rotation.set(rest[0] - a[0] * DEG - d[0], rest[1] - a[1] * DEG - d[1], rest[2] + a[2] * DEG + d[2]);
    const q = m?.p ?? ZERO;
    const f = e?.p ?? ZERO;
    const o = bone.rest.position;
    g.position.set(o.x - q[0] - f[0], o.y + q[1] + f[1], o.z + q[2] + f[2]);
    if (e?.s) g.scale.set(e.s[0], e.s[1] ?? e.s[0], e.s[2] ?? e.s[0]);
    else if (g.scale.y !== 1 || g.scale.x !== 1) g.scale.set(1, 1, 1);
    g.visible = !(e?.s && e.s[0] === 0);
  }
}

/** Les rotations (et positions) d'une animation au temps `t`, par os. */
function sampleMap(anim, t, extra = null) {
  const map = new Map();
  for (const [name, ch] of Object.entries(anim.bones)) {
    map.set(name, { r: ch.rotation ? sample(ch.rotation, t) : null, p: ch.position ? sample(ch.position, t) : null });
  }
  if (extra) {
    for (const [name, r] of Object.entries(extra)) {
      const cur = map.get(name) ?? { r: null, p: null };
      cur.r = cur.r ? cur.r.map((v, i) => v + r[i]) : [...r];
      map.set(name, cur);
    }
  }
  return map;
}

/** Une animation au temps `t`, et des décalages éventuels (en degrés), par os. */
function pose(rig, anim, t, extra = null) {
  applyMap(rig, sampleMap(anim, t, extra));
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} stage  le conteneur (toute la fenêtre)
 * @param {HTMLElement} frame  le cadre du launcher
 */
export async function createXenodys(canvas, stage, frame) {
  if (!RIGS || !ANIMATIONS) throw new Error('ressources de Xenodys absentes');
  const lib = window.skinview3d;
  if (!lib) throw new Error('skinview3d absent');

  const rect = stage.getBoundingClientRect();
  const viewer = new lib.SkinViewer({ canvas, width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
  // Caméra lointaine et focale serrée : presque pas de perspective, une
  // silhouette qui garde ses proportions même immense.
  viewer.fov = 12;
  viewer.zoom = 0.3; // sans effet sur la taille finale : fit() la calcule
  // Rendu à la résolution réelle de l'écran (Retina comprise) : Xenodys reste
  // nette ; le grain cubique vient de ses textures, filtrées « nearest ».
  viewer.pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  if (viewer.controls) viewer.controls.enabled = false;

  // Les classes Three.js, prises sur le joueur (que l'on cache ensuite).
  const blank = document.createElement('canvas');
  blank.width = 64;
  blank.height = 64;
  viewer.loadSkin(blank);
  const sample3 = viewer.playerObject.skin.head.innerLayer;
  const T = {
    Mesh: sample3.constructor,
    Geometry: Object.getPrototypeOf(sample3.geometry.constructor),
    Attribute: Object.getPrototypeOf(sample3.geometry.attributes.position.constructor),
    Material: sample3.material.constructor,
    Texture: viewer.skinTexture.constructor,
    Group: Object.getPrototypeOf(lib.BodyPart.prototype).constructor,
  };
  viewer.playerObject.visible = false;
  if (viewer.globalLight) viewer.globalLight.intensity *= 0.85;

  const load = async (name) => {
    const t = new T.Texture(await packImage(`entity/${name}.png`));
    t.magFilter = NEAREST;
    t.minFilter = NEAREST;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };

  /** Les textures d'un modèle, dans ses deux états, et ses matériaux : matière, verre, énergie. */
  async function skinned(name) {
    const skins = {};
    for (const etat of ['creatrice', 'corrompue']) {
      const [map, glow] = await Promise.all([load(`${name}_${etat}`), load(`${name}_${etat}_glowmask`)]);
      skins[etat] = { map, glow };
    }
    const lit = (options) => {
      const m = new T.Material({ map: skins.creatrice.map, ...options });
      if ('emissiveMap' in m) {
        m.emissiveMap = skins.creatrice.glow;
        m.emissive?.set?.(0xffffff);
        m.emissiveIntensity = 1;
      }
      return m;
    };
    const base = lit({ alphaTest: 0.5 });
    const verre = lit({ transparent: true, depthWrite: false });
    // L'énergie : sa propre lumière, sans ombrage.
    const energie = new T.Material({ map: skins.creatrice.map, transparent: true, depthWrite: false });
    energie.color?.set?.(0x000000);
    energie.emissive?.set?.(0xffffff);
    energie.emissiveMap = skins.creatrice.map;
    const setEtat = (etat) => {
      const sk = skins[etat];
      for (const m of [base, verre]) {
        m.map = sk.map;
        m.emissiveMap = sk.glow;
        m.needsUpdate = true;
      }
      energie.map = sk.map;
      energie.emissiveMap = sk.map;
      energie.needsUpdate = true;
    };
    /** L'éclat de ses lumières (1 : normal). */
    const setGlow = (k) => {
      base.emissiveIntensity = k;
      verre.emissiveIntensity = k;
      energie.emissiveIntensity = 0.6 + 0.4 * k;
    };
    const dispose = () => {
      for (const sk of Object.values(skins)) {
        sk.map.dispose();
        sk.glow.dispose();
      }
      for (const m of [base, verre, energie]) m.dispose();
    };
    return { materials: { base, verre, energie }, setEtat, setGlow, dispose };
  }

  const xenSkin = await skinned('xenodys_tisseuse');
  // Le bâtisseur se cache au coin du cadre ; la luciole flotte près d'elle.
  const BOT_IDS = { peek: 'assistant_graine', idle: 'assistant_luciole' };
  const botSkins = { peek: await skinned(BOT_IDS.peek), idle: await skinned(BOT_IDS.idle) };
  // La fileuse ne paraît qu'au départ : elle tend le fil d'or autour du monde tissé.
  if (RIGS.assistant_fileuse) botSkins.fileuse = await skinned('assistant_fileuse');

  // Xenodys, de trois quarts, tournée vers le launcher.
  const xen = buildRig(T, RIGS.xenodys_tisseuse, xenSkin.materials);
  // Ses mains servent (elles tiennent le cadre) : le monde qu'elle crée flotte au-dessus d'elle.
  xen.options = { hands: 0 };
  const holder = new T.Group();
  holder.add(xen.root);
  holder.rotation.y = Math.PI - 0.7;
  // Courbée par-dessus le launcher : toute la silhouette penche, le haut vers
  // la droite, les hanches derrière le cadre (cachées par lui).
  const tilt = new T.Group();
  tilt.rotation.z = -0.32;
  tilt.add(holder);
  viewer.scene.add(tilt);

  // Ses deux assistants : l'un se cache derrière le coin bas-gauche du cadre,
  // l'autre se tient près d'elle, à droite.
  const bots = ['peek', 'idle'].map((role) => {
    const model = buildRig(T, RIGS[BOT_IDS[role]], botSkins[role].materials);
    const h = new T.Group();
    h.add(model.root);
    h.rotation.y = Math.PI + (role === 'peek' ? 0.5 : -0.35);
    viewer.scene.add(h);
    return { role, holder: h, rig: model, bones: model.bones, time: Math.random() * 3, wave: null, nextWave: 8 + Math.random() * 10 };
  });

  const anims = { creatrice: compile('lean'), corrompue: compile('corrupted_lean') };
  const botAnims = {
    idle: compile('idle', ASSISTANT_ANIMATIONS, 'animation.xenodys_assistant'),
    peek: compile('peek', ASSISTANT_ANIMATIONS, 'animation.xenodys_assistant'),
    wave: compile('wave', ASSISTANT_ANIMATIONS, 'animation.xenodys_assistant'),
    // Le bâtisseur lance ses blocs vers le monde (le geste d'attaque, adouci).
    toss: compile('attaque', ASSISTANT_ANIMATIONS, 'animation.xenodys_assistant'),
  };
  /** La fileuse : cachée, sauf pendant le final du départ. */
  const spinner = botSkins.fileuse ? (() => {
    const model = buildRig(T, RIGS.assistant_fileuse, botSkins.fileuse.materials);
    const h = new T.Group();
    h.add(model.root);
    h.visible = false;
    viewer.scene.add(h);
    return { holder: h, rig: model, time: 0 };
  })() : null;

  const root$ = document.documentElement;
  let etat = root$.dataset.xenodys === 'corrompue' ? 'corrompue' : 'creatrice';
  let time = 0;
  const reach = { arm_right: [0, 0, 0], arm_left: [0, 0, 0] };
  // Penchée sur le cadre, elle replie un peu ses ailes (la marge est étroite) et
  // relève la tête : sa couronne ne cache pas sa visière.
  const POSTURE = { wing_left: [0, 0, 26], wing_right: [0, 0, -26], head: [-12, -10, 0] };
  /** Des décalages d'os, la posture en plus. */
  const withPosture = (extra) => {
    const out = { ...extra };
    for (const [name, r] of Object.entries(POSTURE)) out[name] = out[name] ? out[name].map((v, i) => v + r[i]) : r;
    return out;
  };
  /** Orientation imposée des mains (locale), calculée par fit() : elles
   *  agrippent le cadre, de face, et ne bougent plus. */
  const handQuats = new Map();
  const Quat = holder.quaternion.constructor;
  const Mat4 = holder.matrix.constructor;
  /**
   * Oriente une main dans le monde : doigts dans la direction `f`, paume vers
   * `n` (le cadre, loin de nous) — on voit le dos de la main et des doigts.
   * `palm` : côté de la paume dans le repère de la main (+1 gauche, −1 droite).
   */
  function faceHand(name, f, n, palm) {
    handQuats.set(name, handQuat(name, f, n, palm));
  }
  /** L'orientation locale d'une main (voir `faceHand`), dans la pose courante du bras ; appliquée à l'os. */
  function handQuat(name, f, n, palm) {
    const bone = xen.bones.get(name).group;
    bone.quaternion.identity();
    refresh();
    const y = new V3(...f).normalize().multiplyScalar(-1);
    const x = new V3(...n).multiplyScalar(palm);
    x.sub(y.clone().multiplyScalar(x.dot(y))).normalize();
    const z = new V3().crossVectors(x, y);
    const wanted = new Quat().setFromRotationMatrix(new Mat4().makeBasis(x, y, z));
    const parent = bone.parent.getWorldQuaternion(new Quat());
    const local = parent.invert().multiply(wanted);
    bone.quaternion.copy(local);
    return local;
  }
  // Une main qui agrippe un bord depuis l'arrière : les doigts avancent vers
  // nous par-dessus l'arête, puis se replient (vers la paume) sur la face
  // avant du cadre. La paume s'appuie sur le bord lui-même.
  const HANDS = {
    // Main gauche : bord droit. Paume contre le côté du cadre (vers la
    // gauche), les doigts repliés s'étendent sur la face avant, vers la gauche.
    hand_left: { f: [-0.25, -0.1, 1], n: [-1, 0, 0], palm: 1 },
    // Main droite : bordure du haut, au coin. Paume posée sur le dessus du
    // cadre, les doigts repliés pendent sur la face avant.
    hand_right: { f: [-0.2, 0.1, 1], n: [0, -1, 0], palm: -1 },
  };
  const faceHands = () => {
    for (const [name, h] of Object.entries(HANDS)) faceHand(name, h.f, h.n, h.palm);
  };

  /** La pose de Xenodys : animation, corrections des bras, mains de face
   *  (recalculées si `reface`, sinon celles mémorisées). */
  function poseXen(t, reface = false, head = null, more = null) {
    pose(xen, anims[etat], t, withPosture({ ...reach, ...(head ? { head } : {}), ...more }));
    if (reface) faceHands();
    else for (const [name, q] of handQuats) xen.bones.get(name).group.quaternion.copy(q);
  }

  /* ---------------------------------------------- projection à l'écran */

  const V3 = holder.position.constructor;
  const meshesOf = (group) => {
    const list = [];
    group.traverse((o) => {
      if (o.isMesh) list.push(o);
    });
    return list;
  };
  const handL = meshesOf(xen.bones.get('hand_left').group);
  const handR = meshesOf(xen.bones.get('hand_right').group);

  let W = 0;
  let H = 0;
  const toPx = (v) => {
    const q = v.clone().project(viewer.camera);
    return { x: ((q.x + 1) / 2) * W, y: ((1 - q.y) / 2) * H };
  };
  const refresh = () => {
    viewer.scene.updateMatrixWorld(true);
    viewer.camera.updateMatrixWorld();
  };
  function boxOf(meshes) {
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const o of meshes) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const { min, max } = o.geometry.boundingBox;
      for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
        const q = toPx(new V3(x, y, z).applyMatrix4(o.matrixWorld));
        b.minX = Math.min(b.minX, q.x);
        b.maxX = Math.max(b.maxX, q.x);
        b.minY = Math.min(b.minY, q.y);
        b.maxY = Math.max(b.maxY, q.y);
      }
    }
    return b;
  }
  /** La tête (sans ses ailes ni sa couronne), à l'écran. */
  function headBox() {
    const g = xen.bones.get('head').group;
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const x of [-3.4, 3.4]) for (const y of [-1.6, 8.6]) for (const z of [-3.4, 3.4]) {
      const q = toPx(g.localToWorld(new V3(x, y, z)));
      b.minX = Math.min(b.minX, q.x);
      b.maxX = Math.max(b.maxX, q.x);
      b.minY = Math.min(b.minY, q.y);
      b.maxY = Math.max(b.maxY, q.y);
    }
    return b;
  }
  /** Pixels par unité du monde, à la profondeur de l'objet. */
  const worldOf = (obj) => obj.getWorldPosition(new V3());
  const unitAt = (obj) => {
    const o = toPx(worldOf(obj));
    return toPx(worldOf(obj).add(new V3(1, 0, 0))).x - o.x;
  };

  /* ---------------------------------------------------------- cadrage */

  /** Recouvrement des doigts sur les bords du cadre, en pixels. */
  const GRIP = 26;
  /** La hauteur de sa tête, en part de la hauteur de la fenêtre. */
  const HEAD = 0.18;
  const FADE_RIGHT = 60;
  const FADE_BOTTOM = 90;
  let frameBox = null;

  /**
   * Résout un bras (deux angles : lever, écarter) pour amener un point de la
   * main sur une cible à l'écran. Newton à deux variables, jacobienne par
   * différences finies, pas bornés.
   */
  function solveArm(name, measure, target, passes = 10) {
    const at = (r) => {
      reach[name] = r;
      poseXen(0, true);
      refresh();
      return measure();
    };
    // D'abord une grille grossière : le meilleur départ, quelle que soit la
    // pose de l'animation (Newton seul s'arrête dans des minimums locaux).
    let best = null;
    for (let rx = -120; rx <= 120; rx += 15) {
      for (let rz = -120; rz <= 120; rz += 15) {
        const q = at([rx, 0, rz]);
        const e = Math.hypot(target.x - q.x, target.y - q.y);
        if (!best || e < best.e) best = { e, r: [rx, 0, rz] };
      }
    }
    reach[name] = best.r;
    newton(name, at, target, passes);
  }

  /** Affine un bras par Newton, à partir de `reach[name]`. */
  function newton(name, at, target, passes) {
    for (let pass = 0; pass < passes; pass += 1) {
      const r = [...reach[name]];
      const p0 = at(r);
      const ex = target.x - p0.x;
      const ey = target.y - p0.y;
      if (Math.hypot(ex, ey) < 2) break;
      const px = at([r[0] + 2, 0, r[2]]);
      const pz = at([r[0], 0, r[2] + 2]);
      const a = (px.x - p0.x) / 2;
      const b = (pz.x - p0.x) / 2;
      const c = (px.y - p0.y) / 2;
      const d = (pz.y - p0.y) / 2;
      const det = a * d - b * c;
      if (Math.abs(det) < 1e-6) break;
      const step = (v) => Math.max(-20, Math.min(20, v));
      reach[name] = [
        Math.max(-120, Math.min(120, r[0] + step((d * ex - b * ey) / det))),
        0,
        Math.max(-120, Math.min(120, r[2] + step((-c * ex + a * ey) / det))),
      ];
    }
    at(reach[name]);
  }

  /**
   * Place Xenodys. Sa tête — sa taille en découle : 18 % de la hauteur de la
   * fenêtre — est dans la marge de droite, tout près du cadre : son corps est
   * en partie caché derrière lui. Puis chaque bras est résolu : la main gauche
   * agrippe le bord droit du cadre, la main droite son coin haut-droit — dos
   * des mains vers nous, doigts repliés par-dessus les bords. (En fenêtre
   * ouverte, les boutons de la barre de titre laissent ce coin libre.)
   */
  function fitXenodys() {
    const edge = frameBox.x + frameBox.w;
    const margin = W - edge;
    holder.scale.setScalar(MODEL_SCALE);
    holder.position.set(0, -46 * MODEL_SCALE, 0);
    tilt.position.set(0, 0, 0);
    reach.arm_right = [0, 0, 0];
    reach.arm_left = [0, 0, 0];
    handQuats.clear();

    const headTarget = { x: edge + Math.max(64, margin * 0.36), y: frameBox.y + frameBox.h * 0.24 };
    for (let pass = 0; pass < 5; pass += 1) {
      poseXen(0);
      refresh();
      const hb = headBox();
      const k = (H * HEAD) / Math.max(1, hb.maxY - hb.minY);
      const o = toPx(worldOf(holder));
      const unit = unitAt(holder);
      const scaled = (a, c) => c + k * (a - c);
      holder.scale.multiplyScalar(k);
      tilt.position.x += (headTarget.x - scaled((hb.minX + hb.maxX) / 2, o.x)) / unit;
      tilt.position.y -= (headTarget.y - scaled((hb.minY + hb.maxY) / 2, o.y)) / unit;
    }

    solveArm('arm_left', GRIP_POINT.arm_left, gripTarget('arm_left'));
    solveArm('arm_right', GRIP_POINT.arm_right, gripTarget('arm_right'));
  }

  /** Le point de chaque main qui se pose sur le cadre, à l'écran. */
  const GRIP_POINT = {
    arm_left: () => {
      const b = boxOf(handL);
      return { x: b.minX, y: (b.minY + b.maxY) / 2 };
    },
    arm_right: () => {
      const b = boxOf(handR);
      return { x: (b.minX + b.maxX) / 2, y: b.maxY };
    },
  };

  /** Où chaque main agrippe : le bord droit, le coin haut-droit. */
  function gripTarget(name) {
    const edge = frameBox.x + frameBox.w;
    return name === 'arm_left'
      ? { x: edge - GRIP, y: frameBox.y + frameBox.h * 0.5 }
      : { x: edge - 46, y: frameBox.y + 30 };
  }

  /**
   * Les bras « à l'approche » : la main au-dessus de sa prise, à l'extérieur
   * du cadre, d'où elle vient s'y poser. `lift` : de combien de pixels.
   * Calculés depuis la pose finale (Newton seul : la solution est voisine).
   */
  function approachReach(lift) {
    const out = {};
    const saved = { arm_left: [...reach.arm_left], arm_right: [...reach.arm_right] };
    for (const name of ['arm_right', 'arm_left']) {
      const g = gripTarget(name);
      const target = name === 'arm_right'
        ? { x: g.x + lift * 0.35, y: g.y - lift }
        : { x: g.x + lift * 0.8, y: g.y - lift * 0.45 };
      const at = (r) => {
        reach[name] = r;
        poseXen(0, false);
        refresh();
        return GRIP_POINT[name]();
      };
      newton(name, at, target, 8);
      out[name] = [...reach[name]];
      reach[name] = saved[name];
    }
    poseXen(0, false);
    refresh();
    return out;
  }

  /** Place un assistant : hauteur voulue, et un point d'ancrage (le bas de ses pieds). */
  function fitBot(bot, height, anchor) {
    const h = bot.holder;
    h.scale.setScalar(MODEL_SCALE);
    h.position.set(0, 0, 6);
    for (let pass = 0; pass < 4; pass += 1) {
      pose(bot.rig, botAnims.idle, 0);
      refresh();
      const b = boxOf(meshesOf(h));
      const k = height / Math.max(1, b.maxY - b.minY);
      const o = toPx(worldOf(h));
      const unit = unitAt(h);
      const scaled = (a, c) => c + k * (a - c);
      h.scale.multiplyScalar(k);
      h.position.x += (anchor.x - scaled((b.minX + b.maxX) / 2, o.x)) / unit;
      h.position.y -= (anchor.y - scaled(b.maxY, o.y)) / unit;
    }
  }

  function fit() {
    W = stage.clientWidth;
    H = stage.clientHeight;
    if (!W || !H) return;
    const sr = stage.getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    frameBox = { x: fr.left - sr.left, y: fr.top - sr.top, w: fr.width, h: fr.height };
    // La caméra est loin : toute la précision de profondeur autour d'elle (sinon
    // ses fines plaques se disputent la même surface).
    const cam = viewer.camera;
    const far = Math.abs(cam.position.z) || 100;
    cam.near = far * 0.4;
    cam.far = far * 1.8;
    cam.updateProjectionMatrix();
    fitXenodys();
    const edge = frameBox.x + frameBox.w;
    // Le petit curieux : caché derrière le coin bas-gauche, il passe la tête.
    fitBot(bots[0], Math.min(110, frameBox.h * 0.16), { x: frameBox.x - 4, y: frameBox.y + frameBox.h - 28 });
    // Le fidèle : debout dans la marge de droite, près d'elle, au pied du cadre.
    fitBot(bots[1], Math.min(120, frameBox.h * 0.17), { x: edge + Math.max(46, (W - edge) * 0.62), y: frameBox.y + frameBox.h });
    poseXen(0);
    refresh();
    masks.both = mask(renderHands());
    masks.right = mask(renderHands(handR));
    masks.none = mask(null);
    approach.creatrice = approachReach(Math.min(70, H * 0.08));
    approach.corrompue = approachReach(Math.min(150, H * 0.18));
    weavePose = weaveReach();
    measure();
    setMask(maskKind);
  }

  /* ------------------------------------------------ repères à l'écran */

  /** Ce que la vie de Xenodys doit savoir de sa pose : où sont sa tête, son
   *  cœur, ses mains, sa place et celle des assistants. */
  const marks = { head: { x: 0, y: 0 }, chest: { x: 0, y: 0 }, hands: [], yawPx: 1, pitchPx: 1 };
  let home = null;
  /** Un point devant le visage : c'est lui qui suit le regard. */
  const facePoint = () => {
    return toPx(xen.bones.get('head').group.localToWorld(new V3(0, 4, -12)));
  };
  function measure() {
    home = transformNow();
    for (const bot of bots) bot.home = bot.holder.position.clone();
    const hb = headBox();
    marks.head = { x: (hb.minX + hb.maxX) / 2, y: (hb.minY + hb.maxY) / 2 };
    marks.chest = toPx(worldOf(xen.bones.get('chest').group));
    const L = boxOf(handL);
    const R = boxOf(handR);
    marks.hands = [
      { x: L.minX + 6, y: (L.minY + L.maxY) / 2 },
      { x: (R.minX + R.maxX) / 2, y: R.maxY - 6 },
    ];
    // De combien de pixels le regard bouge pour un degré de rotation de la
    // tête (le signe compte : il dépend de sa pose).
    const f0 = facePoint();
    poseXen(0, false, [0, 6, 0]);
    refresh();
    const fy = facePoint();
    poseXen(0, false, [6, 0, 0]);
    refresh();
    const fp = facePoint();
    marks.yawPx = (fy.x - f0.x) / 6 || 1;
    marks.pitchPx = (fp.y - f0.y) / 6 || 1;
    poseXen(0);
    refresh();
  }

  /**
   * La silhouette exacte de ses mains : un rendu où tout le reste est caché.
   * C'est elle, et non un rectangle, qui perce le masque sur le cadre.
   */
  function renderHands(meshes = [...handL, ...handR]) {
    const hidden = [];
    const keep = new Set(meshes);
    viewer.scene.traverse((o) => {
      if (o.isMesh && o.visible && !keep.has(o)) {
        o.visible = false;
        hidden.push(o);
      }
    });
    viewer.render();
    const layer = document.createElement('canvas');
    layer.width = Math.ceil(W);
    layer.height = Math.ceil(H);
    layer.getContext('2d').drawImage(viewer.canvas, 0, 0, W, H);
    for (const o of hidden) o.visible = true;
    return layer;
  }

  /** Le masque des seuls bords de la fenêtre (fondus tramés), sans le cadre :
   *  pendant la cinématique, elle passe devant le launcher. */
  function edgeMask() {
    const c = document.createElement('canvas');
    c.width = Math.ceil(W);
    c.height = Math.ceil(H);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    paintEdgeFades(g);
    return `url(${c.toDataURL('image/png')})`;
  }

  /** Les fondus tramés vers le bord droit et le bas de la fenêtre. */
  function paintEdgeFades(g) {
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const P = 4;
    for (let y = 0; y < H; y += P) {
      for (let x = 0; x < W; x += P) {
        const v = Math.min((W - x) / FADE_RIGHT, (H - y) / FADE_BOTTOM);
        if (v >= 1) continue;
        const t = (BAYER[(((y / P) & 3) << 2) | ((x / P) & 3)] + 0.5) / 16;
        if (v < t) g.clearRect(x, y, P, P);
      }
    }
  }

  /**
   * Le masque : tout est visible, SAUF sur le cadre — elle et les assistants
   * sont derrière lui —, à l'exception de ses doigts, qui passent par-dessus
   * ses bords (la silhouette des mains). Vers le bord droit et le bas de la
   * fenêtre, tout se dissout en trame : jamais de coupure nette.
   */
  function mask(hands) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(W);
    c.height = Math.ceil(H);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    paintEdgeFades(g);
    const f = frameBox;
    g.clearRect(f.x, f.y, f.w, f.h);
    g.save();
    g.beginPath();
    g.rect(f.x, f.y, f.w, f.h);
    g.clip();
    if (hands) g.drawImage(hands, 0, 0);
    g.restore();
    return `url(${c.toDataURL('image/png')})`;
  }

  /** Les trois masques de la pose : sans les mains (elle arrive), la main
   *  droite seule posée, les deux mains. */
  const masks = { none: '', right: '', both: '', weave: '' };
  /** Les bras à l'approche de leur prise (voir `approachReach`), selon l'état. */
  const approach = { creatrice: null, corrompue: null };
  let maskKind = 'both';
  function setMask(kind) {
    maskKind = kind;
    stage.style.maskImage = masks[kind];
    stage.style.maskSize = '100% 100%';
    stage.style.maskRepeat = 'no-repeat';
  }

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let fitTimer = 0;

  /* ------------------------------------------- les gestes (xenodys/tisseuse.py) */

  // Des animations ajoutées par-dessus une pose (décalages d'os, en degrés) :
  // tisser, arracher, tenir le joueur, saisir le launcher… `null` si le paquet
  // de ressources n'en a pas encore.
  const gestureOf = (name) => (ANIMATIONS.animations[`animation.xenodys.${name}`] ? compile(name) : null);
  const gestures = Object.fromEntries(['weave', 'corrupted_weave', 'take', 'corrupted_take', 'grasp_right', 'corrupted_grasp_right']
    .map((n) => [n, gestureOf(n)]));

  /**
   * Ajoute un geste, au temps `t` et avec le poids `k`, aux décalages `extra`.
   * Les gestes en boucle tournent ; les autres s'arrêtent sur leur dernière image.
   */
  function addGesture(extra, g, t, k = 1) {
    if (!g || k <= 0) return extra;
    const at = g.loop ? ((t % g.length) + g.length) % g.length : Math.max(0, Math.min(g.length, t));
    for (const [name, ch] of Object.entries(g.bones)) {
      if (!ch.rotation) continue;
      const v = sample(ch.rotation, at);
      const cur = extra[name] ?? [0, 0, 0];
      extra[name] = [cur[0] + v[0] * k, cur[1] + v[1] * k, cur[2] + v[2] * k];
    }
    return extra;
  }

  /** Un petit décalage d'os (degrés, convention Bedrock), en quaternion local. */
  const EulerOf = holder.rotation.constructor;
  const gestureQuat = (r) => new holder.quaternion.constructor().setFromEuler(new EulerOf(-r[0] * DEG, -r[1] * DEG, r[2] * DEG, 'ZYX'));

  /* ------------------------------------------- le tissage (préparation) */

  // Pendant que les fichiers se préparent, le launcher reste ouvert : sa main
  // gauche lâche le bord droit, descend dans la marge et tourne la paume vers
  // la barre de progression ; de ses doigts, des fils de lumière partent vers
  // la barre et la tissent. Sa main droite, elle, tient toujours le coin.

  /** Comment se tourne la main qui tisse : doigts vers le haut et un peu vers
   *  la gauche, paume vers la barre ET vers nous — on doit la voir. */
  const WEAVE_HAND = { f: [-0.3, 0.92, 0.2], n: [-0.42, -0.22, 0.88], palm: 1 };
  /** La main qui tisse est un peu agrandie : le geste se lit de loin. */
  const WEAVE_SCALE = 1.55;
  /** La main qui tisse a son matériau à elle : elle passe devant son corps
   *  (dessinée après lui), à peine teintée de la couleur de Xenodys. */
  const handGlowMat = xenSkin.materials.base.clone();
  handGlowMat.depthTest = false;
  const handBaseMeshes = handL.filter((m) => m.material === xenSkin.materials.base);
  // L'ordre de dessin de la main quand elle passe devant : paume, doigts, bouts des doigts.
  const boneNameOf = new Map([...xen.bones].map(([name, b]) => [b.group, name]));
  const handOrder = new Map(handBaseMeshes.map((m) => {
    const name = boneNameOf.get(m.parent) ?? '';
    return [m, name.endsWith('_tip') ? 12 : name === 'hand_left' ? 10 : 11];
  }));
  function setHandGlow(e, onTop = false) {
    const base = xenSkin.materials.base;
    const on = e > 0.01 || onTop;
    for (const m of handBaseMeshes) {
      m.material = on ? handGlowMat : base;
      m.renderOrder = on ? handOrder.get(m) : 0;
    }
    if (!on) return;
    if (handGlowMat.map !== base.map) {
      handGlowMat.map = base.map;
      handGlowMat.emissiveMap = base.map;
      handGlowMat.needsUpdate = true;
    }
    handGlowMat.emissive?.set?.(etat === 'corrompue' ? 0xf0506e : 0x91d9d1);
    handGlowMat.emissiveIntensity = e * (0.16 + 0.05 * Math.sin(weaving.t * 4));
  }
  /** La pose du bras qui tisse (calculée par fit()) : décalage du bras, orientation de la main. */
  let weavePose = null;

  /** Le point de la main qui sert de repère : le milieu de sa silhouette. */
  const palmOf = () => {
    const b = boxOf(handL);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, w: b.maxX - b.minX };
  };

  /**
   * Résout le bras qui tisse : depuis sa prise (Newton seul, la solution est
   * voisine), la main tournée comme elle tissera, dans la marge à droite du
   * cadre, aux trois quarts de sa hauteur. Rend la pose de repos intacte, et
   * prépare le masque où cette main passe devant le cadre.
   */
  function weaveReach() {
    const saved = [...reach.arm_left];
    const savedQ = handQuats.get('hand_left')?.clone();
    const hand = xen.bones.get('hand_left').group;
    const edge = frameBox.x + frameBox.w;
    let q = null;
    const at = (r) => {
      reach.arm_left = r;
      poseXen(0, false);
      q = handQuat('hand_left', WEAVE_HAND.f, WEAVE_HAND.n, WEAVE_HAND.palm);
      hand.scale.setScalar(WEAVE_SCALE);
      refresh();
      return palmOf();
    };
    // Devant le cadre, juste à l'intérieur de son bord droit, au-dessus de la
    // barre : sur le fond sombre de l'accueil, la paume claire se détache.
    const w0 = at(saved).w || 60;
    const target = { x: edge - Math.max(50, w0 * 0.8), y: frameBox.y + frameBox.h * 0.68 };
    // Une grille grossière d'abord (Newton seul reste près de la prise), puis Newton.
    let best = null;
    for (let rx = -120; rx <= 120; rx += 15) {
      for (let rz = -120; rz <= 120; rz += 15) {
        const q0 = at([rx, 0, rz]);
        const e = Math.hypot(target.x - q0.x, target.y - q0.y);
        if (!best || e < best.e) best = { e, r: [rx, 0, rz] };
      }
    }
    reach.arm_left = best.r;
    newton('arm_left', at, target, 16);
    at(reach.arm_left);
    const r = [...reach.arm_left];
    const qq = q.clone();
    // Le masque du tissage : la main droite, et la gauche tout au long de son
    // trajet (de sa prise à sa pose de tissage), qui passe devant le cadre.
    const layer = document.createElement('canvas');
    layer.width = Math.ceil(W);
    layer.height = Math.ceil(H);
    const lg = layer.getContext('2d');
    const restQ = savedQ ?? hand.quaternion.clone();
    for (const k of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      reach.arm_left = lerp3(saved, r, k);
      poseXen(0, false);
      hand.quaternion.copy(restQ).slerp(qq, k);
      hand.scale.setScalar(1 + (WEAVE_SCALE - 1) * k);
      refresh();
      lg.drawImage(renderHands(), 0, 0);
    }
    masks.weave = mask(layer);
    hand.scale.setScalar(1);
    reach.arm_left = saved;
    if (savedQ) handQuats.set('hand_left', savedQ);
    poseXen(0);
    refresh();
    return { r, q: qq };
  }

  /** L'état du tissage : `k` va de 0 (la main au cadre) à 1 (elle tisse). */
  const weaving = { on: false, k: 0, bar: null, fill: null, t: 0, flow: 1, slack: 0, mode: 'download', still: 0 };

  /**
   * Ce que fait la préparation (store.game) : les fils suivent. Le débit fait
   * courir les éclats (et les doigts) plus ou moins vite ; un téléchargement
   * qui stagne détend les fils ; la vérification les parcourt à rebours ;
   * l'extraction y fait des nœuds.
   * @param {{state?: string, speed?: number}} game
   */
  function weaveInfo(game) {
    if (!game) return;
    weaving.mode = game.state ?? 'download';
    const speed = Number(game.speed) || 0;
    weaving.flowTarget = weaving.mode === 'download'
      ? Math.max(0.25, Math.min(1.35, Math.log10(speed + 1) / 6.5))
      : weaving.mode === 'check' ? 0.9 : 0.6;
    weaving.speed = speed;
  }

  /** Le téléchargement stagne-t-il (rien depuis plus de 2 s) ? */
  const weaveStalled = () => weaving.mode === 'download' && weaving.still > 2;

  /**
   * Commence ou arrête le tissage.
   * @param {boolean} on
   * @param {{bar?: Element|null, fill?: Element|null}} [targets]  la barre et son remplissage
   */
  function weave(on, { bar = null, fill = null } = {}) {
    weaving.on = Boolean(on) && !reduced;
    if (weaving.on) weaving.still = 0;
    if (bar) weaving.bar = bar;
    if (fill) weaving.fill = fill;
    if (weaving.on && weaving.k === 0) sfxRef?.play('servo');
  }

  /** Avance le tissage ; renvoie son poids (0 : rien à faire). */
  function weaveStep(dt) {
    const target = weaving.on && weavePose ? 1 : 0;
    const speed = target ? 1.4 : 2;
    weaving.k += Math.max(-dt * speed, Math.min(dt * speed, target - weaving.k));
    weaving.still = weaving.mode === 'download' && !(weaving.speed > 0) ? weaving.still + dt : 0;
    weaving.flow += ((weaving.flowTarget ?? 1) - weaving.flow) * Math.min(1, dt * 2);
    weaving.slack += ((weaveStalled() ? 1 : 0) - weaving.slack) * Math.min(1, dt * 1.5);
    // Ses doigts suivent le débit ; quand rien ne vient, ils ralentissent.
    weaving.t += dt * (0.55 + 0.6 * weaving.flow) * (1 - 0.6 * weaving.slack);
    if (weaving.k <= 0) {
      weaving.k = 0;
      setHandGlow(0);
      if ((maskKind === 'right' || maskKind === 'weave') && !arr) setMask('both');
      return 0;
    }
    // La main quitte sa prise et passe devant le cadre, tout au long de son trajet.
    const want = masks.weave ? 'weave' : 'both';
    if (maskKind !== want) setMask(want);
    return weaving.k;
  }

  /** La pose du tissage : le bras vers la marge, la paume vers la barre, les doigts qui jouent. */
  function poseWeaving(at, head, k) {
    const e = ease(k);
    const grip = reach.arm_left;
    reach.arm_left = lerp3(grip, weavePose.r, e);
    const extra = {};
    openFingers(extra, anims[etat], at, 'arm_left', e * 0.85);
    // Le geste : elle tisse (corrompue, elle arrache les fils) — doigts, pouce, poignet, tête.
    const g = gestures[etat === 'corrompue' ? 'corrupted_weave' : 'weave'];
    addGesture(extra, g, weaving.t, e);
    const handG = extra.hand_left;
    delete extra.hand_left;
    if (extra.head) {
      head = head ? head.map((v, i) => v + extra.head[i]) : extra.head;
      delete extra.head;
    }
    poseXen(at, false, head, extra);
    reach.arm_left = grip;
    const bone = xen.bones.get('hand_left').group;
    const rest = handQuats.get('hand_left');
    if (rest) bone.quaternion.copy(rest).slerp(weavePose.q, e);
    if (handG) bone.quaternion.multiply(gestureQuat(handG));
    bone.scale.setScalar(1 + (WEAVE_SCALE - 1) * e);
    setHandGlow(e);
  }

  /** Les extrémités des doigts de la main gauche, à l'écran. */
  function fingertips() {
    const out = [];
    for (let i = 0; i < 4; i += 1) {
      const tip = xen.bones.get(`finger_left_${i}_tip`)?.group;
      if (tip) out.push(toPx(tip.localToWorld(new V3(0, -1.5, 0))));
    }
    if (!out.length) out.push(palmOf());
    return out;
  }

  /**
   * Des fils de lumière, en gros pixels : chacun part d'un point (`from`) et
   * file vers un autre (`to`), en ondulant ; des éclats y courent vers la cible.
   * `k` : de 0 à 1, l'apparition (tramée).
   */
  function drawThreads(froms, to, k, t, col, corrupted, spread = 1, { flow = 1, slack = 0, knots = false, reverse = false } = {}) {
    const P = FX_P;
    for (let i = 0; i < froms.length; i += 1) {
      const a = { x: froms[i].x / P, y: froms[i].y / P };
      const b = { x: to.x / P, y: (to.y + (i - (froms.length - 1) / 2) * 3 * spread) / P };
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const sway = Math.sin(t * 2.2 + i * 1.9) * Math.min(14, len * 0.18) * (1 + 1.5 * slack);
      const steps = Math.ceil(len * 1.4);
      for (let s = 0; s <= steps; s += 1) {
        const u = s / steps;
        // Un arc qui ondule, plus ample au milieu ; deux fils voisins se croisent.
        const bow = Math.sin(Math.PI * u) * sway + Math.sin(u * 9 + t * 5 + i) * 0.8 * Math.sin(Math.PI * u);
        let x = Math.round(a.x + dx * u + nx * bow);
        // Détendus, les fils pendent.
        let y = Math.round(a.y + dy * u + ny * bow + slack * Math.sin(Math.PI * u) * Math.min(18, len * 0.25));
        if (corrupted && Math.random() < 0.05) {
          x += Math.random() < 0.5 ? -1 : 1;
          y += Math.random() < 0.5 ? -1 : 1;
        }
        if (k < 1 && k < bayer(x, y)) continue;
        // Corrompue : des fils déchirés, troués par endroits.
        if (corrupted && (s + Math.floor(t * 18) + i * 5) % 13 < 2) continue;
        // Les éclats : des paquets de lumière qui descendent le fil.
        const run = t * 1.6 * flow * (reverse ? -1 : 1);
        const pulse = (((u * (4 + 3 * flow) - run - i * 0.37) % 1) + 1) % 1;
        const bright = slack < 0.6 && pulse < 0.12;
        if (!bright && (s + i) % 3 === 1) continue; // le fil est fin : un pixel sur trois manque
        fxCtx.fillStyle = bright ? col.core : (s + i) % 7 === 0 || slack > 0.5 ? col.deep : col.glow;
        // L'extraction : les éclats deviennent des nœuds.
        if (bright && knots) fxCtx.fillRect(x - 1, y - 1, 2, 2);
        else fxCtx.fillRect(x, y, 1, 1);
      }
    }
  }

  /** Une petite étoile de pixels, qui scintille. */
  function sparkle(x, y, t, col, size = 2) {
    const cx = Math.round(x / FX_P);
    const cy = Math.round(y / FX_P);
    const s = size + Math.round(Math.sin(t * 9) * 0.6);
    fxCtx.fillStyle = col.core;
    fxCtx.fillRect(cx, cy, 1, 1);
    fxCtx.fillStyle = col.glow;
    for (let d = 1; d <= s; d += 1) {
      fxCtx.fillRect(cx + d, cy, 1, 1);
      fxCtx.fillRect(cx - d, cy, 1, 1);
      fxCtx.fillRect(cx, cy + d, 1, 1);
      fxCtx.fillRect(cx, cy - d, 1, 1);
    }
  }

  /** La tête de la barre (là où arrivent les fils), dans la scène ; `null` sans barre. */
  function barHead() {
    const bar = weaving.bar;
    if (!bar?.isConnected) return null;
    const br = bar.getBoundingClientRect();
    if (br.width < 2) return null;
    const sr = stage.getBoundingClientRect();
    const fr = weaving.fill?.isConnected ? weaving.fill.getBoundingClientRect() : null;
    return {
      x: Math.min(br.right, Math.max(br.left, fr && fr.width > 1 ? fr.right : br.left + 2)) - sr.left,
      y: br.top + br.height / 2 - sr.top,
      h: br.height,
    };
  }

  /* Les fils cassent : la préparation a échoué. */
  let snapFx = null;

  /**
   * Les fils claquent : chacun se rompt en un point ; la moitié de sa main se
   * rétracte vers ses doigts, celle de la barre tombe et s'éteint. Puis sa main
   * revient au cadre (le tissage s'arrête).
   */
  function snap() {
    const head = barHead();
    if (head && weaving.k > 0.3 && !reduced) {
      refresh();
      const tips = [palmOf(), ...fingertips()];
      snapFx = { start: performance.now(), tips, head, cut: tips.map(() => 0.3 + Math.random() * 0.4), corrupted: etat === 'corrompue' };
      sfxRef?.play(snapFx.corrupted ? 'glitch' : 'shatter');
    }
    weave(false);
  }

  function drawSnap() {
    const f = snapFx;
    const t = (performance.now() - f.start) / 1000;
    if (t > 1.1) {
      snapFx = null;
      return;
    }
    const col = FX[f.corrupted ? 'corrompue' : 'creatrice'];
    const fade = 1 - segment(t, 0.5, 1.1);
    const recoil = ease(segment(t, 0, 0.35));
    f.tips.forEach((a, i) => {
      const b = f.head;
      const c = { x: a.x + (b.x - a.x) * f.cut[i], y: a.y + (b.y - a.y) * f.cut[i] };
      // La moitié de sa main : elle se rétracte, en ondulant.
      const end = { x: c.x + (a.x - c.x) * recoil, y: c.y + (a.y - c.y) * recoil };
      const n = Math.max(2, Math.ceil(Math.hypot(end.x - a.x, end.y - a.y) / FX_P));
      for (let s = 0; s <= n; s += 1) {
        const u = s / n;
        const x = Math.round((a.x + (end.x - a.x) * u) / FX_P + Math.sin(u * 12 + t * 30) * 1.2 * (1 - recoil));
        const y = Math.round((a.y + (end.y - a.y) * u) / FX_P);
        if (fade < bayer(x, y)) continue;
        fxCtx.fillStyle = s === n ? col.core : col.glow;
        fxCtx.fillRect(x, y, 1, 1);
      }
      // La moitié de la barre : elle tombe et s'éteint.
      const m = Math.max(2, Math.ceil(Math.hypot(b.x - c.x, b.y - c.y) / FX_P));
      for (let s = 0; s <= m; s += 1) {
        const u = s / m;
        const fall = 140 * t * t * (1 - u * 0.7);
        const x = Math.round((c.x + (b.x - c.x) * u) / FX_P);
        const y = Math.round((c.y + (b.y - c.y) * u + fall) / FX_P);
        if (fade * (1 - 0.5 * (1 - u)) < bayer(x, y) || s % 2) continue;
        fxCtx.fillStyle = (s + i) % 5 === 0 ? col.deep : col.glow;
        fxCtx.fillRect(x, y, 1, 1);
      }
      // Le point de rupture : un éclat.
      burst(c, t, col);
    });
  }

  /** Les fils, de ses doigts à la tête de la barre, et la lueur de sa paume. */
  function drawWeaving(k) {
    const bar = weaving.bar;
    const head = barHead();
    if (!head) return;
    const br = bar.getBoundingClientRect();
    refresh();
    const p = palmOf();
    const tips = [p, ...fingertips()];
    const col = fxColors();
    const corrupted = etat === 'corrompue';
    const t = weaving.t;
    const show = clamp01((k - 0.35) / 0.5);
    if (show <= 0) return;
    drawThreads(tips, head, show, t, col, corrupted, 0.6, {
      flow: weaving.flow,
      slack: weaving.slack,
      knots: weaving.mode === 'extract' || weaving.mode === 'patch',
      reverse: weaving.mode === 'check',
    });
    // Là où les fils touchent la barre, elle se tisse : des points de lumière.
    sparkle(head.x, head.y, t, col, 2);
    for (let n = 0; n < 3; n += 1) {
      const ph = (t * 1.3 + n / 3) % 1;
      const x = head.x - ph * 40;
      const y = head.y + Math.sin(t * 4 + n * 2) * br.height * 0.6;
      if (ph < 0.8 && show > bayer(Math.round(x / FX_P), Math.round(y / FX_P))) {
        fxCtx.fillStyle = n === 0 ? col.core : col.glow;
        fxCtx.fillRect(Math.round(x / FX_P), Math.round(y / FX_P), 1, 1);
      }
    }
    // Une petite lueur au creux de la paume (sans la cacher).
    drawOrb(p.x / FX_P, p.y / FX_P, 1.0 + 0.3 * Math.sin(t * 5), col, show * (corrupted && Math.random() < 0.2 ? 0.3 : 0.7));
  }

  /* ------------------------------------- outils de la cinématique */

  // Le jeu démarre : penchée sur le launcher, elle prend le joueur dans sa main
  // gauche, puis le launcher se replie dans sa main droite ; elle se redresse,
  // réunit ses mains levées et le passage vers le monde s'ouvre (lumière cyan,
  // ou déchirure rouge et violette si elle est corrompue). Au retour du jeu,
  // le launcher se reconstruit et elle revient.
  const cineAnims = { fly: compile('fly'), idle: compile('idle'), corrupted_idle: compile('corrupted_idle') };
  /** Sa pose du final : debout, les mains en coupe autour du monde qu'elle crée. */
  const finaleAnim = (corrupted) => cineAnims[corrupted ? 'corrupted_idle' : 'idle'];
  let cine = null;

  /** Mélange deux poses (`w` de 0 à 1) et l'applique. */
  function poseBlend(a, b, w) {
    const mix = (u, v) => [0, 1, 2].map((i) => (u?.[i] ?? 0) * (1 - w) + (v?.[i] ?? 0) * w);
    const map = new Map();
    for (const name of new Set([...a.keys(), ...b.keys()])) {
      const ra = a.get(name);
      const rb = b.get(name);
      map.set(name, { r: mix(ra?.r, rb?.r), p: ra?.p || rb?.p ? mix(ra?.p, rb?.p) : null });
    }
    applyMap(xen, map);
  }

  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const segment = (t, a, b) => clamp01((t - a) / (b - a));

  const transformNow = () => ({
    pos: tilt.position.clone(),
    tiltZ: tilt.rotation.z,
    rotY: holder.rotation.y,
    scale: holder.scale.x,
  });
  const applyTransform = (from, to, k) => {
    tilt.position.lerpVectors(from.pos, to.pos, k);
    tilt.rotation.z = from.tiltZ + (to.tiltZ - from.tiltZ) * k;
    holder.rotation.y = from.rotY + (to.rotY - from.rotY) * k;
    holder.scale.setScalar(from.scale + (to.scale - from.scale) * k);
  };

  /** Le milieu de ses deux mains (le haut), à l'écran : là où les deux lueurs se rejoignent. */
  const handsMid = () => {
    const L = boxOf(handL);
    const R = boxOf(handR);
    return { x: (L.minX + L.maxX + R.minX + R.maxX) / 4, y: Math.min(L.minY, R.minY) };
  };
  /** La main gauche ouverte, paume vers le ciel, les doigts vers le cadre et vers nous : le joueur s'y pose. */
  const PALM_UP = { f: [-0.7, 0.12, 0.7], n: [0, 1, 0], palm: 1 };

  /** L'orientation (locale) de la main gauche paume vers le ciel, le bras dans la pose `arm`. */
  function palmUpQuat(arm, at) {
    const saved = reach.arm_left;
    reach.arm_left = arm;
    poseXen(at, false);
    const q = handQuat('hand_left', PALM_UP.f, PALM_UP.n, PALM_UP.palm).clone();
    reach.arm_left = saved;
    return q;
  }

  /** Le haut d'une main (la gauche par défaut) : là où se pose le joueur. */
  const palmTop = (meshes = handL) => {
    const b = boxOf(meshes);
    return { x: (b.minX + b.maxX) / 2, y: b.minY + (b.maxY - b.minY) * 0.3, h: b.maxY - b.minY };
  };
  /** Le milieu d'une main, à l'écran. */
  const handCenter = (meshes) => {
    const b = boxOf(meshes);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, h: b.maxY - b.minY };
  };

  /**
   * Où elle se place pour le final : redressée, face à nous, au milieu de la
   * fenêtre, les mains en coupe autour du monde qu'elle va tisser (pose de
   * repos, os `creation` entre ses mains).
   */
  function risePlacement(lean) {
    const saved = transformNow();
    const hands = xen.options.hands;
    xen.options.hands = 1;
    tilt.rotation.z = 0;
    holder.rotation.y = lean.rotY + 0.55;
    holder.scale.setScalar(lean.scale * 0.85);
    const map = sampleMap(finaleAnim(etat === 'corrompue'), 0);
    const target = { x: W * 0.5, y: H * 0.44 };
    const anchor = xen.bones.get('creation')?.group ?? xen.bones.get('chest').group;
    for (let pass = 0; pass < 4; pass += 1) {
      applyMap(xen, map);
      refresh();
      const m = toPx(worldOf(anchor));
      const unit = unitAt(holder) || 1;
      tilt.position.x += (target.x - m.x) / unit;
      tilt.position.y -= (target.y - m.y) / unit;
    }
    refresh();
    const to = transformNow();
    xen.options.hands = hands;
    applyTransform(saved, saved, 0);
    return to;
  }

  // Le calque des effets : les fils, la lueur de sa main, puis le passage. En pixel art, comme le décor.
  const fx = document.createElement('canvas');
  fx.className = 'opm-cine';
  fx.setAttribute('aria-hidden', 'true');
  document.body.appendChild(fx);
  const fxCtx = fx.getContext('2d');
  const FX_P = 4;
  const FX = {
    creatrice: { core: '#E9FFFC', glow: '#91D9D1', deep: '#1D5C51', flash: '233, 255, 252' },
    corrompue: { core: '#FFD3DD', glow: '#F0506E', deep: '#6A1F8F', flash: '255, 211, 221' },
  };
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const bayer = (x, y) => (BAYER4[((y & 3) << 2) | (x & 3)] + 0.5) / 16;

  function fxResize() {
    fx.width = Math.ceil(W / FX_P);
    fx.height = Math.ceil(H / FX_P);
    fx.style.width = `${fx.width * FX_P}px`;
    fx.style.height = `${fx.height * FX_P}px`;
  }

  function drawOrb(cx, cy, r, c, flicker) {
    const reach = r + 4;
    for (let y = Math.floor(cy - reach); y <= cy + reach; y += 1) {
      for (let x = Math.floor(cx - reach); x <= cx + reach; x += 1) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        let color = null;
        if (d < r * 0.45) color = c.core;
        else if (d < r) color = c.glow;
        else if (d < reach && (1 - (d - r) / 4) * flicker > bayer(x, y)) color = c.deep;
        if (!color) continue;
        fxCtx.fillStyle = color;
        fxCtx.fillRect(x, y, 1, 1);
      }
    }
  }

  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const FX_RGB = Object.fromEntries(Object.entries(FX).map(([k, c]) => [k, { core: hex(c.core), glow: hex(c.glow), deep: hex(c.deep) }]));

  /**
   * Le passage s'ouvre : une onde de gros pixels tramés part de l'orbe et
   * envahit la fenêtre — un front lumineux, une traîne qui se défait derrière
   * lui. Corrompue : le front se brise en blocs qui grésillent.
   */
  function drawPortal(t, cx, cy, etat) {
    const w = fx.width;
    const h = fx.height;
    const far = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) + 8;
    const R = far * ease(clamp01(t / 0.85));
    const band = 9;
    const trail = 26;
    const rgb = FX_RGB[etat];
    const corrupted = etat === 'corrompue';
    const img = fxCtx.createImageData(w, h);
    const data = img.data;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (corrupted) d += ((x * 7 + y * 13 + Math.floor(t * 30)) % 5) - 2; // un front cassé
        const ahead = R - d; // > 0 : l'onde est passée
        if (ahead < 0 || ahead > band + trail) continue;
        let col;
        let a;
        if (ahead < band) {
          // Le front : plein, du blanc au cœur, la couleur sur les bords.
          const k = ahead / band;
          col = k < 0.35 ? rgb.core : rgb.glow;
          a = 255;
        } else {
          // La traîne : tramée, de plus en plus clairsemée.
          const k = 1 - (ahead - band) / trail;
          if (k < bayer(x, y)) continue;
          col = corrupted && (x + y) % 3 === 0 ? rgb.glow : rgb.deep;
          a = 200;
        }
        if (corrupted && Math.random() < 0.06) continue; // des trous qui grésillent
        const i = (y * w + x) * 4;
        data[i] = col[0];
        data[i + 1] = col[1];
        data[i + 2] = col[2];
        data[i + 3] = a;
      }
    }
    fxCtx.putImageData(img, 0, 0);
  }

  const surroundCanvases = () => [...document.querySelectorAll('.opm-surround')];
  const fxColors = () => FX[(cine ? cine.corrupted : etat === 'corrompue') ? 'corrompue' : 'creatrice'];

  /* ------------------------------------- le joueur se défait en pixels */

  // Le personnage de l'accueil (components/character3d.js) et l'aura de ses circuits.
  const characterEls = () => [
    document.querySelector('[data-el="character-3d"]'),
    document.querySelector('[data-el="character-aura"]'),
  ].filter(Boolean);

  /**
   * Découpe une image du personnage en cellules du calque des effets : une
   * particule par cellule pleine, qui part (de haut en bas) vers l'orbe.
   * @returns {{x: number, y: number, c: string, delay: number, dur: number, bend: number}[]}
   */
  function cellsOf(image, rect, every = 1) {
    const sr = stage.getBoundingClientRect();
    const cw = Math.max(1, Math.round(rect.width / FX_P));
    const chh = Math.max(1, Math.round(rect.height / FX_P));
    const small = document.createElement('canvas');
    small.width = cw;
    small.height = chh;
    const g = small.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(image, 0, 0, cw, chh);
    const data = g.getImageData(0, 0, cw, chh).data;
    const ox = (rect.left - sr.left) / FX_P;
    const oy = (rect.top - sr.top) / FX_P;
    const cells = [];
    for (let y = 0; y < chh; y += every) {
      for (let x = 0; x < cw; x += every) {
        const i = (y * cw + x) * 4;
        if (data[i + 3] < 110) continue;
        cells.push({
          x: ox + x,
          y: oy + y,
          c: `rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`,
          delay: (y / chh) * 0.45 + Math.random() * 0.18,
          dur: 0.5 + Math.random() * 0.25,
          bend: (Math.random() - 0.5) * 30,
          vx: (Math.random() - 0.5) * 70,
          vy: -20 - Math.random() * 50,
        });
      }
    }
    return cells;
  }

  /** Le rectangle des pixels pleins d'une image (`null` si elle est vide). */
  function opaqueBox(c) {
    const g = c.getContext('2d', { willReadFrequently: true });
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let minX = c.width;
    let minY = c.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < c.height; y += 2) {
      for (let x = 0; x < c.width; x += 2) {
        if (data[(y * c.width + x) * 4 + 3] < 40) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 2, h: maxY - minY + 2 };
  }

  /**
   * Une image du joueur seul (sans son socle), à l'endroit où il se tient :
   * c'est elle que Xenodys emporte. Prise au début de la cinématique.
   */
  function snapPlayer() {
    const cap = liveCharacter()?.capture?.();
    if (!cap) return null;
    const src = cap.alone ?? cap.body;
    const box = opaqueBox(src);
    if (!box) return null;
    const k = cap.rect.width / src.width; // pixels CSS par pixel du rendu
    const el = document.createElement('canvas');
    el.className = 'opm-cine-player';
    el.setAttribute('aria-hidden', 'true');
    el.width = box.w;
    el.height = box.h;
    el.getContext('2d').drawImage(src, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    const w = box.w * k;
    const h = box.h * k;
    const left = cap.rect.left + box.x * k;
    const top = cap.rect.top + box.y * k;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.hidden = true;
    document.body.appendChild(el);
    // Ses pieds (le bas, au milieu), en coordonnées de la fenêtre.
    return { el, w, h, x0: left + w / 2, y0: top + h, cap };
  }

  /** Le joueur quitte son socle : son image prend le relais ; le bocal, s'il est là, éclate. */
  function liftPlayer(c$) {
    const p = c$.player;
    if (!p) return;
    p.el.hidden = false;
    liveCharacter()?.setPresent?.(false);
    c$.shards = p.cap.jar ? cellsOf(p.cap.jar, p.cap.rect, 2) : [];
    c$.sfx?.play(c$.shards.length ? 'shatter' : 'dissolve');
  }

  /** Le joueur rendu à son socle (et l'image emportée, effacée). */
  function revealPlayer(c$ = null) {
    for (const el of characterEls()) el.style.visibility = '';
    c$?.player?.el.remove();
    liveCharacter()?.setPresent?.(true);
  }

  /**
   * Le joueur, de son socle jusqu'au creux de sa main : il s'élève doucement
   * (il ne pèse plus rien), glisse en arc jusqu'à elle en rapetissant — une
   * traînée de lumière derrière lui —, puis s'y pose avec un petit rebond.
   * Renvoie le milieu de son corps, dans la scène (pour les fils).
   */
  function placePlayer(c$, t) {
    const p = c$.player;
    if (!p || p.el.hidden) return null;
    const sr = stage.getBoundingClientRect();
    const palm = palmTop();
    c$.targetH ??= Math.max(50, Math.min(120, palm.h * 1.6));
    const end = c$.targetH / p.h;
    // 1. Il s'élève, à peine penché.
    const rise = ease(segment(t, LIFT, LIFT + RISE));
    const sx = p.x0;
    const sy = p.y0 - 34 * rise;
    // 2. Il glisse jusqu'à elle (lent au départ, il ralentit en arrivant).
    const g = ease(segment(t, LIFT + RISE, LAND));
    const tx = palm.x + sr.left;
    const ty = palm.y + sr.top;
    const cx = (sx + tx) / 2;
    const cy = Math.min(sy, ty) - 70;
    let x = (1 - g) * (1 - g) * sx + 2 * (1 - g) * g * cx + g * g * tx;
    let y = (1 - g) * (1 - g) * sy + 2 * (1 - g) * g * cy + g * g * ty;
    let s = 1 + (end - 1) * (g * g * (3 - 2 * g));
    let rot = -5 * rise * (1 - g) + Math.sin(Math.PI * g) * 9;
    // 3. Il se pose : un rebond, il s'écrase un peu puis se redresse.
    let squash = 1;
    if (t > LAND) {
      const b = segment(t, LAND, LAND + 0.45);
      squash = 1 - 0.12 * Math.sin(Math.PI * Math.min(1, b * 3)) * (1 - b);
      rot = 0;
      // Puis il suit sa main.
      x = tx;
      y = ty - Math.abs(Math.sin(b * Math.PI * 2)) * (1 - b) * 10;
      s = end;
      if (c$.corrupted) {
        x += (Math.random() - 0.5) * 2.5;
        y += (Math.random() - 0.5) * 2;
      }
    }
    // 4. Il quitte sa paume et plonge dans le monde (corrompue : elle l'y jette).
    if (t >= DIVE[0] && c$.worldAt) {
      if (!c$.diveFrom) c$.diveFrom = { x, y };
      const raw = segment(t, DIVE[0], DIVE[1]);
      const d = c$.corrupted ? raw ** 2.5 : ease(raw);
      const wx = c$.worldAt.x + sr.left;
      const wy = c$.worldAt.y + sr.top + p.h * end * 0.25;
      const hop = c$.corrupted ? 0 : Math.sin(Math.PI * d) * 45;
      x = c$.diveFrom.x + (wx - c$.diveFrom.x) * d;
      y = c$.diveFrom.y + (wy - c$.diveFrom.y) * d - hop;
      s = end * (1 - 0.88 * d * d);
      rot = (c$.corrupted ? 220 : 25) * d;
      squash = 1;
      p.el.style.opacity = String(1 - segment(raw, 0.75, 1));
    }
    p.el.style.transform = `translate(${(x - p.x0).toFixed(1)}px, ${(y - p.y0).toFixed(1)}px) rotate(${rot.toFixed(2)}deg) scale(${(s / Math.sqrt(squash)).toFixed(4)}, ${(s * squash).toFixed(4)})`;
    const mid = { x: x - sr.left, y: y - sr.top - p.h * s * 0.5 };
    // La traînée, pendant la glissade.
    if (t > LIFT + RISE && t < LAND) {
      c$.trail ??= [];
      c$.trail.push({ x: mid.x + (Math.random() - 0.5) * p.w * s * 0.5, y: mid.y + (Math.random() - 0.5) * p.h * s * 0.6, t });
    }
    return mid;
  }


  /** Dessine les particules du joueur (vers l'orbe) et les éclats du bocal (qui tombent). */
  function drawParticles(c$, t) {
    const tx = c$.point.x / FX_P;
    const ty = c$.point.y / FX_P;
    const col = fxColors();
    for (const p of c$.particles ?? []) {
      const k = (t - c$.dissolveAt - p.delay) / p.dur;
      if (k >= 1) continue;
      if (k <= 0) {
        fxCtx.fillStyle = p.c;
        fxCtx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
        continue;
      }
      const e = ease(k);
      // Une courbe : la particule s'écarte un peu, puis file vers l'orbe.
      const mx = (p.x + tx) / 2 + p.bend;
      const my = Math.min(p.y, ty) - 12;
      const x = (1 - e) * (1 - e) * p.x + 2 * (1 - e) * e * mx + e * e * tx;
      const y = (1 - e) * (1 - e) * p.y + 2 * (1 - e) * e * my + e * e * ty;
      fxCtx.fillStyle = k < 0.35 ? p.c : k < 0.75 ? col.glow : col.core;
      fxCtx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
    for (const p of c$.shards ?? []) {
      const s = t - c$.dissolveAt - p.delay * 0.2;
      if (s <= 0 || s > 1.1) {
        if (s <= 0) {
          fxCtx.fillStyle = p.c;
          fxCtx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
        }
        continue;
      }
      if (s > 0.6 && (1.1 - s) / 0.5 < bayer(Math.round(p.x), Math.round(p.y))) continue;
      const x = p.x + p.vx * s * 0.6;
      const y = p.y + p.vy * s * 0.6 + 60 * s * s;
      fxCtx.fillStyle = p.c;
      fxCtx.fillRect(Math.round(x), Math.round(y), 1 + (Math.abs(p.bend) > 10 ? 1 : 0), 1);
    }
  }

  /** Les extrémités des doigts d'une main (`left` ou `right`), à l'écran. */
  function fingertipsOf(side) {
    const out = [];
    for (let i = 0; i < 4; i += 1) {
      const tip = xen.bones.get(`finger_${side}_${i}_tip`)?.group;
      if (tip) out.push(toPx(tip.localToWorld(new V3(0, -1.5, 0))));
    }
    if (!out.length) out.push(palmTop(side === 'left' ? handL : handR));
    return out;
  }

  /** Un éclat : un anneau de pixels qui s'élargit et se défait (`dt` : depuis son départ). */
  function burst(at, dt, col) {
    if (dt < 0 || dt > 0.6) return;
    const k = dt / 0.6;
    const R = 2 + 9 * ease(k);
    const N = 22;
    for (let i = 0; i < N; i += 1) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.round(at.x / FX_P + Math.cos(a) * R);
      const y = Math.round(at.y / FX_P + Math.sin(a) * R * 0.6);
      if (1 - k < bayer(x, y)) continue;
      fxCtx.fillStyle = i % 3 === 0 ? col.core : col.glow;
      fxCtx.fillRect(x, y, 1, 1);
    }
  }

  /**
   * Le launcher se replie dans sa main droite — celle qui tient son coin —,
   * image par image (il suit sa main) : il se soulève un instant, s'illumine,
   * puis se resserre vers sa main en accélérant, et s'éteint en s'y posant.
   * Derrière lui, elle apparaît à mesure qu'il se retire (le masque suit son
   * rectangle). Renvoie ses quatre coins à l'écran (pour les fils).
   */
  function shrinkFrame(c$, t) {
    const k = segment(t, SHRINK, SHRINK + SHRINK_LEN);
    if (!c$.frameHome) {
      const fr = frame.getBoundingClientRect();
      c$.frameHome = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2, w: fr.width, h: fr.height };
    }
    const f = c$.frameHome;
    const sr = stage.getBoundingClientRect();
    const pr = handCenter(handR);
    const tx = pr.x + sr.left - f.x;
    const ty = pr.y + sr.top - f.y;
    // Le soulèvement (anticipation), puis la course : lente au départ, vive à la fin.
    const lift = k < 0.18 ? Math.sin(Math.PI * (k / 0.18)) : 0;
    const go = k < 0.12 ? 0 : segment(k, 0.12, 1) ** 2.2;
    const x = tx * go;
    const y = ty * go - lift * 10;
    const end = Math.max(6, pr.h * 0.4) / f.w;
    const scale = (1 + 0.03 * lift) * (1 - (1 - end) * go);
    // Corrompue : il est broyé — écrasé d'un côté puis de l'autre, secoué.
    let sx = scale;
    let sy = scale;
    let jx = 0;
    let jy = 0;
    if (c$.corrupted && go > 0) {
      const q = Math.sin(t * 37) * 0.14 * Math.sin(Math.PI * go);
      sx *= 1 + q;
      sy *= 1 - q;
      jx = (Math.random() - 0.5) * 9 * go;
      jy = (Math.random() - 0.5) * 7 * go;
    }
    frame.style.transform = `translate(${(x + jx).toFixed(1)}px, ${(y + jy).toFixed(1)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    const glow = 1 + 0.8 * Math.min(1, k * 3);
    frame.style.filter = c$.corrupted
      ? `brightness(${glow.toFixed(2)}) hue-rotate(-20deg) saturate(1.8)`
      : `brightness(${glow.toFixed(2)}) saturate(1.3)`;
    frame.style.opacity = String(k < 0.85 ? 1 : Math.max(0, 1 - (k - 0.85) / 0.15));
    // Le cadre réduit, en coordonnées de la scène.
    const cx = f.x + x - sr.left;
    const cy = f.y + y - sr.top;
    const hw = (f.w / 2) * scale;
    const hh = (f.h / 2) * scale;
    // Le masque : ses mains, plus tout ce qui n'est pas derrière le cadre.
    if (k < 0.97) {
      stage.style.maskImage = `${c$.handsUrl}, linear-gradient(#000, #000), ${c$.edgeUrl}`;
      stage.style.maskComposite = 'add, exclude, add';
      stage.style.maskSize = `100% 100%, ${(hw * 2).toFixed(1)}px ${(hh * 2).toFixed(1)}px, 100% 100%`;
      stage.style.maskPosition = `0 0, ${(cx - hw).toFixed(1)}px ${(cy - hh).toFixed(1)}px, 0 0`;
      stage.style.maskRepeat = 'no-repeat';
    } else if (!c$.unmasked) {
      c$.unmasked = true;
      stage.style.maskImage = c$.edgeUrl;
      stage.style.maskComposite = '';
      stage.style.maskSize = '100% 100%';
      stage.style.maskPosition = '';
    }
    return { corners: [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => ({ x: cx + a, y: cy + b })) };
  }

  /** Des fissures (chemins de pixels) qui partent d'un point, dans toutes les directions. */
  function cracksFrom(pt, n = 6) {
    const out = [];
    for (let k = 0; k < n; k += 1) {
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.6;
      let x = pt.x / FX_P;
      let y = pt.y / FX_P;
      const path = [];
      const len = 12 + Math.floor(Math.random() * 18);
      for (let s = 0; s < len; s += 1) {
        path.push([Math.round(x), Math.round(y)]);
        x += Math.cos(a) + (Math.random() - 0.5) * 0.9;
        y += Math.sin(a) + (Math.random() - 0.5) * 0.9;
      }
      out.push(path);
    }
    return out;
  }

  /**
   * Corrompue : une déchirure verticale, en zigzag, qui part de ses mains et
   * s'ouvre vers le haut et le bas de la fenêtre (`k` de 0 à 1).
   */
  function drawRift(c$, m, k, t) {
    if (!c$.rift) {
      const pts = [];
      const reachUp = m.y / FX_P;
      const reachDown = (H - m.y) / FX_P;
      for (const [dir, len] of [[-1, reachUp], [1, reachDown]]) {
        let x = 0;
        for (let i = 0; i < len; i += 1) {
          x += (Math.random() - 0.5) * 2.2;
          x = Math.max(-6, Math.min(6, x));
          pts.push({ dx: Math.round(x), dy: dir * i, d: i / Math.max(1, len) });
        }
      }
      c$.rift = pts;
    }
    const col = FX.corrompue;
    const cx = Math.round(m.x / FX_P);
    const cy = Math.round(m.y / FX_P);
    const w = 1 + Math.round(k * 2);
    for (const p of c$.rift) {
      if (p.d > ease(k)) continue;
      if (Math.random() < 0.08) continue;
      fxCtx.fillStyle = col.core;
      fxCtx.fillRect(cx + p.dx, cy + p.dy, 1, 1);
      fxCtx.fillStyle = (p.dy + Math.floor(t * 30)) % 3 ? col.glow : col.deep;
      fxCtx.fillRect(cx + p.dx - w, cy + p.dy, w, 1);
      fxCtx.fillRect(cx + p.dx + 1, cy + p.dy, w, 1);
    }
  }

  /** La traînée du joueur pendant qu'il glisse vers elle : des pixels qui s'éteignent. */
  function drawTrail(c$, t, col) {
    const trail = c$.trail;
    if (!trail?.length) return;
    for (const p of trail) {
      const age = t - p.t;
      if (age > 0.5) continue;
      const k = 1 - age / 0.5;
      const x = Math.round(p.x / FX_P);
      const y = Math.round(p.y / FX_P);
      if (k < bayer(x, y)) continue;
      fxCtx.fillStyle = k > 0.7 ? col.core : k > 0.35 ? col.glow : col.deep;
      fxCtx.fillRect(x, y, 1, 1);
    }
    while (trail.length && t - trail[0].t > 0.5) trail.shift();
  }

  /* ------------------------------------------- le monde tissé (final du départ) */

  // Entre ses mains en coupe, elle tisse un monde : un cœur de lumière (le
  // launcher replié), la roche, l'océan et les terres, puis les nuages, couche
  // après couche ; la fileuse l'entoure d'un fil d'or. Le joueur y plonge.
  const WORLD_R = 5;
  const worldGroup = new T.Group();
  worldGroup.visible = false;
  viewer.scene.add(worldGroup);
  const ringGroup = new T.Group();
  worldGroup.add(ringGroup);

  /** Un cube unité, centré : ses sommets, normales et indices (réutilisés par les blocs fusionnés). */
  const CUBE = (() => {
    const pos = [];
    const nor = [];
    const uv = [];
    const idx = [];
    const F = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
      [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    ];
    F.forEach(([n, u, v], f) => {
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        pos.push(...[0, 1, 2].map((i) => 0.5 * n[i] + 0.5 * a * v[i] + 0.5 * b * u[i]));
        nor.push(...n);
        uv.push((a + 1) / 2, (b + 1) / 2);
      }
      idx.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
    });
    return { pos, nor, uv, idx };
  })();

  /**
   * Des blocs fusionnés en un seul maillage par matière (une poignée d'appels de
   * dessin au lieu de centaines) : chaque image, on réécrit leurs sommets —
   * centre et taille de chacun, taille 0 pour ceux qui ne sont pas encore là.
   */
  function blockBatch(type, count, parent) {
    const pos = new Float32Array(count * 72);
    const nor = new Float32Array(count * 72);
    const uv = new Float32Array(count * 48);
    const idx = new Uint32Array(count * 36);
    for (let b = 0; b < count; b += 1) {
      nor.set(CUBE.nor, b * 72);
      uv.set(CUBE.uv, b * 48);
      for (let i = 0; i < 36; i += 1) idx[b * 36 + i] = CUBE.idx[i] + b * 24;
    }
    const g = new T.Geometry();
    const attr = new T.Attribute(pos, 3);
    g.setAttribute('position', attr);
    g.setAttribute('normal', new T.Attribute(nor, 3));
    g.setAttribute('uv', new T.Attribute(uv, 2));
    g.setIndex(new T.Attribute(idx, 1));
    const mesh = new T.Mesh(g, worldMats[type]);
    mesh.frustumCulled = false;
    parent.add(mesh);
    return {
      mesh, geometry: g,
      /** Place le bloc `b` : centre (x, y, z), taille `s`. */
      set(b, x, y, z, sz) {
        const o = b * 72;
        for (let v = 0; v < 24; v += 1) {
          pos[o + v * 3] = x + CUBE.pos[v * 3] * sz;
          pos[o + v * 3 + 1] = y + CUBE.pos[v * 3 + 1] * sz;
          pos[o + v * 3 + 2] = z + CUBE.pos[v * 3 + 2] * sz;
        }
      },
      commit() {
        attr.needsUpdate = true;
      },
    };
  }

  /** Les couleurs des blocs : la matière, et sa lueur. */
  const WORLD_COLORS = {
    creatrice: {
      core: [0xffd36b, 0xffb020], stone: [0x6e7480, 0], ocean: [0x2e86c1, 0x0a2a40], grass: [0x5dbb4a, 0],
      sand: [0xe8d58a, 0], cloud: [0xf4fbff, 0x223038], gold: [0xf2c14e, 0x9a7414],
    },
    corrompue: {
      core: [0xff3355, 0xc01030], stone: [0x3a2440, 0], ocean: [0x5b1e6e, 0x200830], grass: [0x7a2a55, 0x200010],
      sand: [0x2a1630, 0], cloud: [0x3d2a3a, 0x100810], gold: [0xc99a3a, 0x6a2010],
    },
  };
  const worldMats = Object.fromEntries(Object.keys(WORLD_COLORS.creatrice).map((k) => {
    const m = new T.Material({ color: 0xffffff, ...(k === 'cloud' ? { transparent: true, opacity: 0.85 } : {}) });
    return [k, m];
  }));
  /**
   * Les blocs du monde portent les textures des blocs du laboratoire (le même
   * atlas, components/labGl.js : `tile(etat, nom)`, lueur comprise). Sans
   * laboratoire, de simples couleurs.
   */
  const WORLD_TILES = {
    core: 'labo:m_lueur', stone: 'labo:m_acier', ocean: 'labo:m_eau', grass: 'circuit:piste',
    sand: 'circuit:dalle', cloud: 'labo:m_verre', gold: 'labo:m_or',
  };
  /** Les matières qui rayonnent de leur propre texture. */
  const WORLD_GLOW = { core: 1, gold: 0.3, ocean: 0.08, grass: 0.12, sand: 0.06, cloud: 0.15, stone: 0 };
  let tileOf = null;
  const tileTex = new Map();
  /** La source des tuiles du laboratoire (renderer : `data.tile`). */
  function setTiles(fn) {
    tileOf = typeof fn === 'function' ? fn : null;
  }
  function tileTexture(e, name) {
    const key = `${e}:${name}`;
    if (!tileTex.has(key)) {
      let canvas = null;
      try {
        canvas = tileOf?.(e, name) ?? null;
      } catch {
        canvas = null;
      }
      if (!canvas) return null;
      const tex = new T.Texture(canvas);
      tex.magFilter = NEAREST;
      tex.minFilter = NEAREST;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      tileTex.set(key, tex);
    }
    return tileTex.get(key);
  }
  function paintWorld(e) {
    for (const [k, [c, glow]] of Object.entries(WORLD_COLORS[e])) {
      const m = worldMats[k];
      const tex = tileTexture(e, WORLD_TILES[k]);
      m.map = tex;
      m.color.set(tex ? 0xffffff : c);
      if ('emissive' in m) {
        if (tex && WORLD_GLOW[k] > 0) {
          m.emissive.set(0xffffff);
          m.emissiveMap = tex;
        } else {
          m.emissive.set(tex ? 0x000000 : glow);
          m.emissiveMap = null;
        }
        m.emissiveIntensity = 1;
      }
      m.needsUpdate = true;
    }
  }

  // Les blocs, par couche : leur place, et la fenêtre de temps où ils paraissent.
  const rnd = (() => {
    let x = 7;
    return () => {
      x = (x * 16807) % 2147483647;
      return x / 2147483647;
    };
  })();
  const worldBlocks = [];
  const addBlock = (type, layer, x, y, z, size = 1) => {
    const home = new V3(x, y, z);
    const dir = home.clone().normalize();
    worldBlocks.push({ type, layer, home, from: home.clone().add(dir.multiplyScalar(3.5 + rnd() * 2)), size, u: rnd(), jit: new V3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5), at: new V3() });
  };
  for (let x = -WORLD_R; x <= WORLD_R; x += 1) {
    for (let y = -WORLD_R; y <= WORLD_R; y += 1) {
      for (let z = -WORLD_R; z <= WORLD_R; z += 1) {
        const r = Math.hypot(x, y, z);
        if (r <= 1.6) addBlock('core', 0, x, y, z);
        else if (r >= 2.2 && r <= 3.1) addBlock('stone', 1, x, y, z);
        else if (r > WORLD_R - 1 && r <= WORLD_R + 0.5) {
          const n = Math.sin(x * 0.9 + 1.7) * Math.cos(y * 0.8) + Math.sin(z * 0.85 + 0.5 * x) * 0.8;
          addBlock(n > 0.15 ? 'grass' : n > -0.1 ? 'sand' : 'ocean', 2, x, y, z);
        }
      }
    }
  }
  for (let i = 0; i < 34; i += 1) {
    const a = rnd() * Math.PI * 2;
    const b = Math.acos(2 * rnd() - 1);
    const r = WORLD_R + 1.6 + rnd() * 0.5;
    addBlock('cloud', 3, r * Math.sin(b) * Math.cos(a), r * Math.cos(b), r * Math.sin(b) * Math.sin(a), 0.8 + rnd() * 0.6);
  }
  // Un maillage par matière ; chaque bloc y a sa place (son rang).
  const batches = {};
  for (const type of Object.keys(worldMats)) {
    if (type === 'gold') continue;
    const list = worldBlocks.filter((b) => b.type === type);
    list.forEach((b, i) => {
      b.slot = i;
    });
    if (list.length) batches[type] = blockBatch(type, list.length, worldGroup);
  }
  // Le fil d'or : un anneau de petits blocs, incliné, qui tourne autour du monde.
  const RING_N = 84;
  const ringBlocks = [];
  for (let i = 0; i < RING_N; i += 1) {
    const a = (i / RING_N) * Math.PI * 2;
    ringBlocks.push(new V3(Math.cos(a) * (WORLD_R + 2.9), Math.sin(a * 3) * 0.35, Math.sin(a) * (WORLD_R + 2.9)));
  }
  const ringBatch = blockBatch('gold', RING_N, ringGroup);
  ringGroup.rotation.set(0.42, 0, 0.28);

  /** Les fenêtres de chaque couche (secondes depuis BUILD) : cœur, roche, terres et océan, nuages. */
  const LAYERS = [[0, 0.4], [0.35, 0.9], [0.85, 1.75], [1.65, 2.05]];
  const backOut = (k) => 1 + 2.4 * (k - 1) ** 3 + 1.4 * (k - 1) ** 2;
  /** La taille du monde à l'écran (rayon en pixels). */
  const worldPx = () => Math.max(44, Math.min(86, H * 0.08));

  /**
   * Le monde, à l'instant `t` du départ : il se place entre ses mains (l'os
   * `creation` du modèle), grandit couche par couche, tourne, s'entoure du fil
   * d'or. Renvoie son centre à l'écran, son rayon (unités du monde 3D) et les
   * blocs qui viennent de paraître (pour les fils de sa main).
   */
  function updateWorld(c$, t) {
    if (t < BUILD - 0.05) {
      worldGroup.visible = false;
      return null;
    }
    worldGroup.visible = true;
    const anchor = xen.bones.get('creation')?.group ?? xen.bones.get('chest').group;
    anchor.getWorldPosition(worldGroup.position);
    worldGroup.position.z += 2;
    worldGroup.scale.setScalar(1);
    refresh();
    const unit = unitAt(worldGroup) || 1;
    // À la fin, il se resserre dans l'éclair du passage.
    const close = 1 - ease(segment(t, OPEN + 0.15, OPEN + 0.5));
    worldGroup.scale.setScalar((worldPx() / (WORLD_R + 0.5) / unit) * Math.max(0.001, close));
    worldGroup.rotation.y = t * 0.55;
    worldGroup.rotation.x = 0.18;
    const b = t - BUILD;
    const fresh = [];
    for (const blk of worldBlocks) {
      const [w0, w1] = LAYERS[blk.layer];
      const start = w0 + blk.u * (w1 - w0 - 0.2);
      const k = clamp01((b - start) / 0.22);
      let size = k > 0 ? blk.size * Math.max(0.01, backOut(k)) : 0;
      blk.at.lerpVectors(blk.from, blk.home, ease(k));
      if (c$.corrupted && k > 0) {
        // Corrompue : des blocs de travers, qui grésillent.
        blk.at.addScaledVector(blk.jit, 0.35 + (Math.random() < 0.04 ? 1.2 : 0));
        if (Math.random() < 0.02) size = 0;
      }
      batches[blk.type].set(blk.slot, blk.at.x, blk.at.y, blk.at.z, size);
      if (k > 0 && k < 1 && fresh.length < 3 && blk.layer < 3) fresh.push(blk.at.clone());
    }
    for (const batch of Object.values(batches)) batch.commit();
    // Le fil d'or, bloc après bloc, enroulé par la fileuse.
    const g = segment(t, GOLD[0], GOLD[1]);
    const head = Math.floor(g * RING_N);
    ringBlocks.forEach((p, i) => ringBatch.set(i, p.x, p.y, p.z, i < head ? 0.42 * (i === head - 1 ? 1.6 : 1) : 0));
    ringBatch.commit();
    ringGroup.rotation.y = -t * 1.1;
    // Il s'illumine quand le joueur y entre, puis à l'ouverture du passage.
    const glow = 1 + 1.5 * segment(t, DIVE[1] - 0.2, OPEN + 0.2) + 0.25 * Math.sin(t * 9) * segment(t, DIVE[0], OPEN);
    for (const [k, m] of Object.entries(worldMats)) {
      if ('emissiveIntensity' in m) m.emissiveIntensity = (m.emissiveMap ? WORLD_GLOW[k] : 1) * glow;
    }
    refresh();
    const center = toPx(worldGroup.getWorldPosition(new V3()));
    const ringHead = head > 0 && head < RING_N ? toPx(ringGroup.localToWorld(ringBlocks[head - 1].clone())) : null;
    // Quelques reflets qui courent sur le fil d'or déjà enroulé.
    const glints = [];
    if (head > 4) {
      for (let n = 0; n < 5; n += 1) {
        const i = (Math.floor(t * 26) + n * 17) % head;
        glints.push(toPx(ringGroup.localToWorld(ringBlocks[i].clone())));
      }
    }
    return { center, fresh: fresh.map((p) => toPx(worldGroup.localToWorld(p))), ringHead, glints, R: worldGroup.scale.x * (WORLD_R + 0.5), rpx: worldPx() * close };
  }

  /**
   * Les effets autour du monde : un halo tramé, de la poussière d'étoiles en
   * orbite, des étincelles là où les blocs se posent, des reflets sur le fil
   * d'or, et — quand le joueur y entre — des rayons de lumière.
   */
  function drawWorldFx(w, t, col, corrupted) {
    const cx = w.center.x / FX_P;
    const cy = w.center.y / FX_P;
    const R = w.rpx / FX_P;
    const grow = segment(t, BUILD, BUILD + 1.2);
    // Le halo : un anneau doux qui respire.
    const halo = (0.22 + 0.12 * Math.sin(t * 3)) * grow;
    for (let i = 0; i < 90; i += 1) {
      const a = (i / 90) * Math.PI * 2;
      const r = R * (1.22 + 0.05 * Math.sin(a * 5 + t * 2));
      const x = Math.round(cx + Math.cos(a) * r);
      const y = Math.round(cy + Math.sin(a) * r);
      if (halo < bayer(x, y)) continue;
      fxCtx.fillStyle = i % 9 === 0 ? col.core : col.deep;
      fxCtx.fillRect(x, y, 1, 1);
    }
    // La poussière d'étoiles, en orbite inclinée.
    for (let i = 0; i < 26; i += 1) {
      const sp = 0.6 + (i % 5) * 0.18;
      const a = t * sp + i * 2.39;
      const r = R * (1.35 + (i % 4) * 0.16);
      const x = Math.round(cx + Math.cos(a) * r);
      const y = Math.round(cy + Math.sin(a) * r * 0.42 - (i % 3) * 0.6);
      if (grow < bayer(x, y)) continue;
      // Derrière le monde (la moitié haute de l'orbite) : plus sombres.
      const back = Math.sin(a) < 0;
      if (back && Math.hypot(x - cx, y - cy) < R) continue;
      fxCtx.fillStyle = corrupted && i % 4 === 0 ? FX.corrompue.glow : back ? col.deep : (Math.floor(t * 8 + i) % 5 === 0 ? col.core : col.glow);
      fxCtx.fillRect(x, y, 1, 1);
    }
    // Les étincelles des blocs qui se posent.
    for (const p of w.fresh) {
      const x = Math.round(p.x / FX_P);
      const y = Math.round(p.y / FX_P);
      fxCtx.fillStyle = col.core;
      fxCtx.fillRect(x, y, 1, 1);
      fxCtx.fillStyle = col.glow;
      fxCtx.fillRect(x + (Math.random() < 0.5 ? -1 : 1), y + (Math.random() < 0.5 ? -1 : 1), 1, 1);
    }
    // Les reflets du fil d'or.
    for (const g of w.glints) {
      const x = Math.round(g.x / FX_P);
      const y = Math.round(g.y / FX_P);
      fxCtx.fillStyle = GOLD_FX.core;
      fxCtx.fillRect(x, y, 1, 1);
      fxCtx.fillStyle = GOLD_FX.glow;
      fxCtx.fillRect(x - 1, y, 1, 1);
      fxCtx.fillRect(x + 1, y, 1, 1);
    }
    // Les rayons : le joueur est entré, le monde s'éveille.
    const rays = segment(t, DIVE[1] - 0.1, DIVE[1] + 0.4) * (1 - segment(t, OPEN + 0.2, OPEN + 0.5));
    if (rays > 0) {
      for (let k = 0; k < 12; k += 1) {
        const a = (k / 12) * Math.PI * 2 + t * 0.7;
        const len = R * (1.3 + 1.6 * rays) * (k % 2 ? 0.75 : 1);
        for (let d = R * 0.9; d < len; d += 1) {
          const x = Math.round(cx + Math.cos(a) * d);
          const y = Math.round(cy + Math.sin(a) * d);
          if (rays * (1 - (d - R) / (len - R + 1)) < bayer(x, y)) continue;
          fxCtx.fillStyle = k % 3 === 0 ? GOLD_FX.glow : col.glow;
          fxCtx.fillRect(x, y, 1, 1);
        }
      }
    }
  }

  /**
   * Les assistants autour du monde : le bâtisseur lance ses blocs, la luciole
   * en fait le tour pour l'éclairer, la fileuse déroule le fil d'or.
   */
  function updateFinaleBots(c$, t, w) {
    const show = w ? ease(segment(t, BUILD, BUILD + 0.45)) : 0;
    const fade = 1 - segment(t, OPEN + 0.1, OPEN + 0.35);
    const k = show * fade;
    const [graine, luciole] = bots;
    const all = [graine, luciole, spinner].filter(Boolean);
    for (const b of all) b.holder.visible = k > 0.02;
    if (k <= 0.02) return null;
    const c = worldGroup.getWorldPosition(new V3());
    const R = w.R;
    // Leur taille : comme le monde, à peu près.
    if (!c$.botScale) {
      c$.botScale = new Map();
      for (const b of all) {
        b.holder.scale.setScalar(1);
        b.holder.position.copy(c);
        refresh();
        const box = boxOf(meshesOf(b.holder));
        const hpx = Math.max(1, box.maxY - box.minY);
        c$.botScale.set(b, (w.rpx * 1.15) / hpx);
      }
    }
    const place = (b, offset, rotY, anim, at) => {
      b.holder.position.copy(c).add(offset);
      b.holder.rotation.set(0, rotY, 0);
      b.holder.scale.setScalar(c$.botScale.get(b) * backOut(Math.min(1, k)));
      b.rig.clock = at;
      applyMap(b.rig, sampleMap(anim, at % anim.length));
    };
    const building = t < BUILD + LAYERS[3][1];
    place(graine, new V3(-2.25 * R, -0.75 * R + Math.abs(Math.sin(t * 5)) * 0.08 * R, 1), Math.PI + 0.7, building ? botAnims.toss : botAnims.idle, t);
    const a = t * 1.7;
    place(luciole, new V3(Math.cos(a) * 1.95 * R, 0.55 * R + Math.sin(a * 2) * 0.2 * R, Math.sin(a) * 1.95 * R + 1), Math.PI - a + Math.PI / 2, botAnims.idle, t);
    if (spinner) {
      spinner.rig.options = { walk: t >= GOLD[0] && t < GOLD[1] ? 0.8 : 0.1 };
      place(spinner, new V3(2.3 * R, -0.85 * R, 1), Math.PI - 0.7, botAnims.idle, t);
    }
    refresh();
    const graineAt = toPx(graine.holder.getWorldPosition(new V3()));
    const bobine = spinner?.rig.bones.get('bobine')?.group;
    return { graine: graineAt, bobine: bobine ? toPx(bobine.getWorldPosition(new V3())) : null };
  }

  /** Le geste de tisser, mais de la main droite (doigts et rotations en miroir). */
  function addGestureRight(extra, g, t, k) {
    const tmp = addGesture({}, g, t, k);
    for (const [name, r] of Object.entries(tmp)) {
      if (!name.includes('_left')) continue;
      const to = name.replace('_left', '_right');
      const cur = extra[to] ?? [0, 0, 0];
      extra[to] = [cur[0] + r[0], cur[1] - r[1], cur[2] - r[2]];
    }
    return extra;
  }

  /** Le final rangé : le monde tissé et la fileuse disparaissent, le modèle reprend son monde. */
  function putWorldAway() {
    worldGroup.visible = false;
    if (spinner) spinner.holder.visible = false;
    xen.options.hands = 0;
    const creation = xen.bones.get('creation')?.group;
    if (creation) creation.visible = true;
  }

  /** Les couleurs du fil d'or, pour les fils de lumière. */
  const GOLD_FX = { core: '#FFF3C4', glow: '#F2C14E', deep: '#8A6A10' };

  /* -------------------------------------------------- la cinématique */

  // Le déroulé du départ (secondes depuis le début) :
  /** Le joueur quitte son socle (LIFT), s'élève (RISE), glisse jusqu'à sa main gauche et s'y pose (LAND). */
  const LIFT = 0.35;
  const RISE = 0.35;
  const LAND = 1.55;
  /** Le joueur dans sa paume, elle ramène sa main gauche contre le cadre. */
  const BRING = [LAND + 0.15, LAND + 0.65];
  /** Le launcher se replie dans sa main droite. */
  const SHRINK = LAND + 0.7;
  const SHRINK_LEN = 1.15;
  /** Elle se redresse, s'avance, réunit ses mains levées vers le ciel. */
  const UP = SHRINK + SHRINK_LEN + 0.1;
  const UP_LEN = 0.9;
  /** Entre ses mains en coupe, elle tisse le monde (voir `updateWorld`). */
  const BUILD = UP + 0.55;
  /** La fileuse l'entoure du fil d'or. */
  const GOLD = [BUILD + 1.8, BUILD + 2.6];
  /** Le joueur quitte sa paume et plonge dans le monde. */
  const DIVE = [BUILD + 2.6, BUILD + 3.3];
  /** Le passage s'ouvre depuis le monde. */
  const OPEN = BUILD + 3.5;

  /**
   * La cinématique du départ, quand la préparation est finie et que le jeu
   * démarre. Elle reste penchée sur le launcher : le joueur quitte son socle et
   * vient se poser dans sa main gauche (celle qui tissait), des fils de lumière
   * le portent ; puis le launcher se replie dans sa main droite, au coin qu'elle
   * tient. Alors elle se redresse, s'avance et lève ses deux mains réunies : les
   * deux lueurs se rejoignent, le passage s'ouvre — l'éclair couvre la
   * transition vers le chargement du jeu.
   *
   * Résolue à `true` quand le passage est ouvert et le launcher parti ; à
   * `false` si le launcher revient avant (`comeBack`).
   *
   * @param {any} sfx  components/sfx.js
   * @param {{onFlash?: () => void}} [options]  `onFlash` : le passage s'ouvre (l'éclair).
   */
  function begin(sfx, { onFlash = null } = {}) {
    if (cine) return cine.promise;
    if (sfx) sfxRef = sfx;
    if (reduced || !frameBox) return Promise.resolve(true);
    clearTimeout(fitTimer);
    if (ret) finishReturn();
    if (arr) finishArrival();
    if (wave) endWave();
    const lean = transformNow();
    // Sa pose penchée continue, avec le bras qui tissait (ou qui tient le bord).
    const wk = weavePose ? ease(weaving.k) : 0;
    const at0 = time % anims[etat].length;
    const armW = wk > 0 ? lerp3(reach.arm_left, weavePose.r, wk) : [...reach.arm_left];
    const armHome = [...reach.arm_left];
    const leanExtra = withPosture({ ...reach, arm_left: armW });
    const startQ = {
      hand_left: xen.bones.get('hand_left').group.quaternion.clone(),
      hand_right: xen.bones.get('hand_right').group.quaternion.clone(),
    };
    const handScale = xen.bones.get('hand_left').group.scale.x;
    // La paume vers le ciel : là où elle tissait, puis ramenée contre le cadre.
    const palmQ = { w: palmUpQuat(armW, at0), home: palmUpQuat(armHome, at0) };
    weaving.on = false;
    weaving.k = 0;
    const player = snapPlayer();
    const to = risePlacement(lean);
    paintWorld(etat === 'corrompue' ? 'corrompue' : 'creatrice');
    const corrupted = etat === 'corrompue';
    fxResize();
    fx.style.opacity = '1';
    sfx?.play('servo');
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    cine = {
      start: performance.now(), lean, to, at0, leanExtra, armW, armHome, palmQ, startQ, handScale, glow: wk, corrupted, weaveT: weaving.t,
      savedMask: stage.style.maskImage, handsUrl: '', edgeUrl: edgeMask(), resolve, promise,
      cues: new Set(), sfx, onFlash, player, released: true, point: { x: 0, y: 0 },
      particles: [], shards: [], dissolveAt: LIFT, trail: [],
    };
    return promise;
  }

  /** Conservé pour l'interface : la cinématique part déjà quand le jeu démarre. */
  function release() {}

  /** Le jeu démarre : la cinématique du départ. */
  function launch(sfx, options) {
    return begin(sfx, options);
  }

  function cineFrame() {
    const c$ = cine;
    const t = (performance.now() - c$.start) / 1000;
    const cue = (name, at, fn) => {
      if (t >= at && !c$.cues.has(name)) {
        c$.cues.add(name);
        fn();
      }
    };

    // Les assistants s'éclipsent.
    const shrinkBots = 1 - segment(t, 0, 0.35);
    if (t < BUILD) for (const bot of bots) bot.holder.visible = shrinkBots > 0.02;

    // La pose : penchée (elle respire, le bras qui tissait tendu) ; puis elle
    // se redresse, mains réunies levées ; puis elle ouvre grand les bras.
    // Les gestes : le tissage s'achève ; la main gauche tient le joueur (corrompue,
    // elle le serre) ; la droite s'ouvre pour le launcher et se referme (corrompue,
    // elle l'écrase dans son poing).
    const at = (c$.at0 + t) % anims[etat].length;
    const more = { ...c$.leanExtra };
    // La main gauche : elle s'ouvre en grand pour recevoir le joueur, puis, quand
    // il est dans sa paume, elle la ramène contre le cadre.
    const bring = ease(segment(t, BRING[0], BRING[1]));
    more.arm_left = lerp3(c$.armW, c$.armHome, bring);
    const turn = ease(segment(t, LIFT - 0.25, LIFT + 0.4));
    openFingers(more, anims[etat], at, 'arm_left', c$.glow * 0.85 + (1 - c$.glow * 0.85) * turn);
    addGesture(more, gestures[c$.corrupted ? 'corrupted_weave' : 'weave'], c$.weaveT + t, c$.glow * (1 - turn));
    addGesture(more, gestures[c$.corrupted ? 'corrupted_take' : 'take'], t, segment(t, LAND - 0.1, LAND + 0.3));
    if (t >= SHRINK - 0.15) addGesture(more, gestures[c$.corrupted ? 'corrupted_grasp_right' : 'grasp_right'], t - (SHRINK - 0.15));
    const handG = { hand_left: more.hand_left, hand_right: more.hand_right };
    delete more.hand_left;
    delete more.hand_right;
    const lean = sampleMap(anims[etat], at, more);
    const up = ease(segment(t, UP, UP + UP_LEN));
    // Le final : debout, les mains en coupe ; sa main droite tisse le monde.
    xen.options.hands = up;
    if (up > 0) {
      const fin = finaleAnim(c$.corrupted);
      const weaving$ = segment(t, BUILD, BUILD + 0.3) * (1 - segment(t, GOLD[0], GOLD[0] + 0.4));
      const finExtra = addGestureRight({}, gestures[c$.corrupted ? 'corrupted_weave' : 'weave'], t, weaving$);
      poseBlend(lean, sampleMap(fin, t % fin.length, finExtra), up);
    } else applyMap(xen, lean);
    // Son monde à elle remplace celui que le modèle porte entre ses mains.
    const creation = xen.bones.get('creation')?.group;
    if (creation) creation.visible = up < 0.05;
    // Les mains : la droite garde sa prise ; la gauche se tourne paume vers le
    // ciel (là où elle tissait, puis contre le cadre) — jusqu'à ce qu'elle se redresse.
    const palm = c$.palmQ.w.clone().slerp(c$.palmQ.home, bring);
    const holdQ = { hand_left: c$.startQ.hand_left.clone().slerp(palm, turn), hand_right: c$.startQ.hand_right };
    for (const [name, q0] of Object.entries(holdQ)) {
      const bone = xen.bones.get(name).group;
      const animQ = bone.quaternion.clone();
      bone.quaternion.copy(q0).slerp(animQ, up);
      if (handG[name] && up < 1) bone.quaternion.multiply(gestureQuat(handG[name].map((v) => v * (1 - up))));
    }
    xen.bones.get('hand_left').group.scale.setScalar(c$.handScale + (1 - c$.handScale) * Math.max(bring, up));
    // La main gauche reste dessinée devant son corps tant qu'elle tient le joueur.
    setHandGlow(c$.glow * (1 - turn), up < 1);

    // Elle se redresse et s'avance au milieu ; puis elle flotte.
    applyTransform(c$.lean, c$.to, up);
    if (t > UP + UP_LEN) tilt.position.y += Math.sin((t - UP - UP_LEN) * 1.6) * 0.25;
    if (c$.corrupted && t > UP && t < OPEN + 0.6 && Math.random() < 0.18) {
      tilt.position.x += (Math.random() - 0.5) * 1.6;
      tilt.position.y += (Math.random() - 0.5) * 1.2;
    }
    refresh();

    cue('lift', LIFT, () => liftPlayer(c$));
    cue('land', LAND, () => c$.sfx?.play('land'));
    cue('shrink', SHRINK, () => {
      c$.sfx?.play('shrink');
      // Les silhouettes de ses mains, telles qu'elles sont : elles passent devant
      // le cadre pendant qu'il se replie.
      c$.handsUrl = `url(${renderHands().toDataURL('image/png')})`;
      frame.style.transition = 'none';
      frame.style.willChange = 'transform, opacity, filter';
      for (const s of surroundCanvases()) {
        s.style.transition = 'opacity .9s ease';
        s.style.opacity = '0';
      }
    });
    cue('pocket', SHRINK + SHRINK_LEN, () => {
      if (!c$.corrupted) {
        c$.sfx?.play('clamp');
        return;
      }
      // Corrompue : le poing se referme, l'écran tremble, des fissures partent de ses doigts.
      c$.sfx?.play('slam');
      shake(6, 260);
      c$.cracks = cracksFrom(handCenter(handR), 7);
      c$.crackAt = t;
    });
    cue('up', UP, () => {
      c$.sfx?.play('whoosh');
      stage.style.maskImage = c$.edgeUrl;
      stage.style.maskComposite = '';
      stage.style.maskSize = '100% 100%';
      stage.style.maskPosition = '';
    });
    cue('build', BUILD, () => c$.sfx?.play('build'));
    cue('gold', GOLD[0], () => c$.sfx?.play('notify'));
    cue('dive', DIVE[0] + 0.15, () => c$.sfx?.play('whoosh'));
    cue('enter', DIVE[1], () => {
      c$.sfx?.play('dissolve');
      if (c$.corrupted) {
        c$.sfx?.play('slam');
        shake(5, 240);
        c$.cracks = cracksFrom(c$.worldAt ?? { x: W / 2, y: H / 2 }, 8);
        c$.crackAt = t;
      }
    });
    cue('portal', OPEN, () => c$.sfx?.play('portal', { etat: c$.corrupted ? 'corrompue' : 'creatrice' }));
    // Au plus fort de l'éclair : la scène de chargement peut paraître dessous.
    cue('flashpeak', OPEN + 0.35, () => {
      if (c$.player) c$.player.el.style.opacity = '0';
      c$.onFlash?.();
    });
    cue('fade', OPEN + 0.9, () => {
      stage.style.transition = 'opacity .6s ease';
      stage.style.opacity = '0';
    });

    // Le joueur, dans sa main gauche ; le launcher, dans la droite.
    const body = placePlayer(c$, t);
    const pulled = t >= SHRINK && t <= SHRINK + SHRINK_LEN + 0.05 ? shrinkFrame(c$, t) : null;

    // Les effets.
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    const col = FX[c$.corrupted ? 'corrompue' : 'creatrice'];
    drawParticles(c$, t);
    drawTrail(c$, t, col);
    // Les fils qui portent le joueur jusqu'à elle.
    if (body && t >= LIFT && t < LAND + 0.3) {
      const k = Math.min(segment(t, LIFT, LIFT + 0.25), 1 - segment(t, LAND - 0.1, LAND + 0.3));
      drawThreads(fingertipsOf('left'), body, k, t, col, c$.corrupted, 1.2);
    }
    if (t >= LAND && t < LAND + 0.6) burst(palmTop(), t - LAND, col);
    // Les fils de sa main droite tirent le launcher par ses coins.
    if (pulled && t < SHRINK + SHRINK_LEN) {
      const k = Math.min(segment(t, SHRINK, SHRINK + 0.2), 1 - segment(t, SHRINK + SHRINK_LEN - 0.15, SHRINK + SHRINK_LEN));
      const tipsR = fingertipsOf('right');
      pulled.corners.forEach((corner, n) => drawThreads([tipsR[n % tipsR.length]], corner, k, t + n, col, c$.corrupted, 0));
    }
    if (c$.cracks) drawCracks(c$.cracks, segment(t, c$.crackAt, c$.crackAt + 0.35), 1 - segment(t, c$.crackAt + 0.8, c$.crackAt + 1.4));
    // Le monde tissé, et ses assistants.
    const w = updateWorld(c$, t);
    const helpers = updateFinaleBots(c$, t, w);
    if (w) c$.worldAt = w.center;
    const pr = handCenter(handR);
    // Le launcher replié : une lueur dans sa main droite ; elle la porte entre ses
    // mains, où elle devient le cœur du monde.
    if (t >= SHRINK + SHRINK_LEN - 0.05 && t < BUILD + 0.15) {
      burst(pr, t - (SHRINK + SHRINK_LEN), col);
      const anchor = toPx(worldOf(xen.bones.get('creation')?.group ?? xen.bones.get('chest').group));
      const g = ease(segment(t, UP + 0.2, BUILD));
      const at$ = { x: pr.x + (anchor.x - pr.x) * g, y: pr.y + (anchor.y - pr.y) * g };
      const r = 1.5 + 1.6 * ease(segment(t, SHRINK + SHRINK_LEN, SHRINK + SHRINK_LEN + 0.3)) + 0.5 * Math.sin(t * 7);
      drawOrb(at$.x / FX_P, at$.y / FX_P, r, col, c$.corrupted && Math.random() < 0.2 ? 0.3 : 0.9);
    }
    if (w && t < OPEN + 0.5) drawWorldFx(w, t, col, c$.corrupted);
    if (w && t < OPEN) {
      // Les fils de sa main droite vers les blocs qui paraissent.
      if (w.fresh.length && t < BUILD + LAYERS[3][1]) {
        drawThreads(fingertipsOf('right').slice(0, w.fresh.length), w.fresh[0], 1, t, col, c$.corrupted, 1.5, { flow: 1.2 });
      }
      // Le bâtisseur lance ses blocs : de petits cubes qui volent jusqu'au monde.
      if (helpers?.graine && t < BUILD + LAYERS[2][1]) {
        for (let n = 0; n < 3; n += 1) {
          const ph = (t * 2.1 + n / 3) % 1;
          const a = helpers.graine;
          const b = w.center;
          const x = a.x + (b.x - a.x) * ph;
          const y = a.y + (b.y - a.y) * ph - Math.sin(Math.PI * ph) * 40;
          fxCtx.fillStyle = n === 0 ? col.core : col.glow;
          fxCtx.fillRect(Math.round(x / FX_P), Math.round(y / FX_P), 2, 2);
        }
      }
      // La fileuse déroule le fil d'or jusqu'à l'anneau.
      if (helpers?.bobine && w.ringHead && t >= GOLD[0] && t < GOLD[1]) {
        drawThreads([helpers.bobine], w.ringHead, 1, t, GOLD_FX, false, 0, { flow: 1.4 });
      }
      // La luciole l'éclaire : une lueur douce sur le monde.
      if (t >= BUILD + 0.4 && t < DIVE[1]) burst(w.center, ((t - BUILD) % 1.2) * 0.5, col);
    }
    if (c$.cracks) drawCracks(c$.cracks, segment(t, c$.crackAt, c$.crackAt + 0.35), 1 - segment(t, c$.crackAt + 0.8, c$.crackAt + 1.4));
    // Corrompue : avant le passage, le monde se déchire.
    if (c$.corrupted && w && t >= OPEN - 0.45 && t < OPEN + 0.4) drawRift(c$, w.center, segment(t, OPEN - 0.45, OPEN), t);
    // Le joueur est entré : un éclat sur le monde.
    if (w && t >= DIVE[1] && t < DIVE[1] + 0.6) burst(w.center, t - DIVE[1], col);
    if (t >= OPEN) {
      const m = c$.worldAt ?? handsMid();
      drawPortal(t - OPEN, m.x / FX_P, m.y / FX_P, c$.corrupted ? 'corrompue' : 'creatrice');
    }
    if (t >= OPEN + 0.25 && t < OPEN + 1.5) {
      // Un éclair qui couvre la fin : le monde s'ouvre.
      const k = 1 - segment(t, OPEN + 0.35, OPEN + 1.5);
      const a = (t < OPEN + 0.35 ? segment(t, OPEN + 0.25, OPEN + 0.35) : k) * (c$.corrupted && Math.random() < 0.3 ? 0.4 : 0.85);
      fxCtx.fillStyle = `rgba(${col.flash}, ${a.toFixed(3)})`;
      fxCtx.fillRect(0, 0, fx.width, fx.height);
    }

    if (t >= OPEN + 1.5 && !c$.cues.has('done')) {
      c$.cues.add('done');
      fx.style.opacity = '0';
      c$.resolve(true);
    }
  }

  /**
   * Le launcher revient — après une partie, ou après un échec : tout est
   * remis en place, sans transition, le joueur retrouve son socle, le cadre se
   * reconstruit, puis Xenodys arrive à nouveau.
   */
  function comeBack(sfx) {
    if (sfx) sfxRef = sfx;
    if (!cine) return;
    const c$ = cine;
    cine = null;
    c$.resolve(false);
    putWorldAway();
    // Le départ est allé jusqu'au bout : le retour le rejoue à l'envers.
    if (!reduced && c$.cues.has('done') && c$.frameHome && frameBox) {
      startReturn(c$, sfx);
      return;
    }
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    fx.style.opacity = '0';
    applyTransform(c$.lean, c$.lean, 0);
    frame.style.transition = 'none';
    frame.style.transform = '';
    frame.style.filter = '';
    frame.style.opacity = '';
    frame.style.willChange = '';
    setHandGlow(0);
    xen.bones.get('hand_left').group.scale.setScalar(1);
    for (const s of surroundCanvases()) {
      s.style.transition = 'none';
      s.style.opacity = '';
    }
    stage.style.transition = 'none';
    stage.style.opacity = '0';
    stage.style.maskComposite = '';
    stage.style.maskPosition = '';
    stage.style.maskSize = '100% 100%';
    stage.style.maskImage = c$.savedMask;
    maskKind = 'both';
    revealPlayer(c$);
    // Un tour d'affichage pour que rien ne glisse, puis la reconstruction.
    requestAnimationFrame(() => {
      frame.style.transition = '';
      for (const s of surroundCanvases()) s.style.transition = '';
      // JOUER cliqué entre-temps : la nouvelle cinématique a la main.
      if (cine) return;
      fit();
      hideForArrival();
      sfx?.play('build');
      rebuildFrame().then(() => {
        if (!cine) arrive(sfx);
      });
    });
  }


  /* --------------------------------------------------- le retour */

  // Après une partie, le départ se rejoue à l'envers : elle réapparaît
  // redressée, le joueur dans sa main gauche et le launcher, une lueur, dans la
  // droite ; elle se repenche à sa place ; le launcher se déplie de sa main et
  // reprend sa place ; le joueur retourne sur son socle ; ses assistants reviennent.
  let ret = null;
  const RET = { IN: 0.4, BACK: [0.35, 1.45], UNFOLD: [1.15, 2.3], HOME: [2.0, 2.9], END: 3.2 };

  function startReturn(c$, sfx) {
    // La fenêtre a pu changer de taille pendant la partie : la pose de repos est recalculée.
    frame.style.transition = 'none';
    frame.style.transform = '';
    frame.style.opacity = '0';
    fit();
    const to = risePlacement(home);
    // Sa main gauche, contre le cadre, paume vers le ciel : elle y tient le joueur.
    const palmQ = palmUpQuat([...reach.arm_left], time % anims[etat].length);
    stage.style.transition = 'none';
    stage.style.opacity = '0';
    stage.style.maskComposite = '';
    stage.style.maskSize = '100% 100%';
    stage.style.maskPosition = '';
    stage.style.maskImage = edgeMask();
    for (const bot of bots) bot.holder.visible = false;
    for (const sc of surroundCanvases()) {
      sc.style.transition = 'none';
      sc.style.opacity = '0';
    }
    const fr = frame.getBoundingClientRect();
    const frameHome = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2, w: fr.width, h: fr.height };
    if (c$.player) {
      c$.player.el.style.transition = 'none';
      c$.player.el.style.opacity = '0';
    }
    fxResize();
    fx.style.opacity = '1';
    sfx?.play('portal', { etat: etat === 'corrompue' ? 'corrompue' : 'creatrice' });
    ret = { start: performance.now(), c$, to, home: { ...home }, frameHome, palmQ, sfx, cues: new Set(), corrupted: etat === 'corrompue' };
  }

  function returnFrame() {
    const r$ = ret;
    const c$ = r$.c$;
    const t = (performance.now() - r$.start) / 1000;
    const cue = (name, at, fn) => {
      if (t >= at && !r$.cues.has(name)) {
        r$.cues.add(name);
        fn();
      }
    };
    const [b0, b1] = RET.BACK;
    const [u0, u1] = RET.UNFOLD;
    const [h0, h1] = RET.HOME;

    // Elle apparaît (le jeu se referme sur un éclair), puis se repenche à sa place.
    stage.style.opacity = String(segment(t, 0, RET.IN));
    if (c$.player) c$.player.el.style.opacity = String(segment(t, 0.1, RET.IN + 0.1));
    const back = ease(segment(t, b0, b1));
    applyTransform(r$.to, r$.home, back);
    if (t < b0) tilt.position.y += Math.sin(t * 1.6) * 0.25;
    const at = time % anims[etat].length;
    const more = withPosture({ ...reach });
    // Main gauche : grande ouverte, paume vers le ciel, le temps que le joueur
    // reparte vers son socle ; puis elle reprend le bord du cadre. Main droite :
    // elle s'ouvre pendant que le launcher se déplie.
    const palmK = 1 - ease(segment(t, h1, h1 + 0.45));
    openFingers(more, anims[etat], at, 'arm_left', palmK);
    const open = Math.sin(Math.PI * segment(t, u0 - 0.1, u1 + 0.1));
    addGesture(more, gestures.grasp_right, 0.6, open);
    delete more.hand_left;
    delete more.hand_right;
    const fin = finaleAnim(r$.corrupted);
    xen.options.hands = 1 - back;
    poseBlend(sampleMap(fin, t % fin.length), sampleMap(anims[etat], at, more), back);
    for (const [name, q] of handQuats) {
      const bone = xen.bones.get(name).group;
      bone.quaternion.slerp(q, back);
    }
    xen.bones.get('hand_left').group.quaternion.slerp(r$.palmQ, palmK * back);
    setHandGlow(0, palmK > 0.02);
    refresh();

    // Le launcher se déplie de sa main droite, et reprend sa place.
    const sr = stage.getBoundingClientRect();
    const f = r$.frameHome;
    const pr = handCenter(handR);
    const k = segment(t, u0, u1);
    if (t >= u0) {
      const g = 1 - (1 - k) ** 2.2;
      const tx = pr.x + sr.left - f.x;
      const ty = pr.y + sr.top - f.y;
      const end = Math.max(6, pr.h * 0.4) / f.w;
      const scale = end + (1 - end) * g;
      const x = tx * (1 - g);
      const y = ty * (1 - g) - Math.sin(Math.PI * g) * 8;
      frame.style.transform = k >= 1 ? '' : `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(4)})`;
      frame.style.opacity = String(Math.min(1, k / 0.12));
      const glow = 1 + 0.8 * (1 - k);
      frame.style.filter = k >= 1 ? '' : `brightness(${glow.toFixed(2)})`;
      // Le masque suit son rectangle : elle repasse derrière lui.
      if (k < 1) {
        const hw = (f.w / 2) * scale;
        const hh = (f.h / 2) * scale;
        const cx = f.x + x - sr.left;
        const cy = f.y + y - sr.top;
        stage.style.maskImage = `linear-gradient(#000, #000), ${r$.edgeUrl ?? (r$.edgeUrl = edgeMask())}`;
        stage.style.maskComposite = 'exclude, add';
        stage.style.maskSize = `${(hw * 2).toFixed(1)}px ${(hh * 2).toFixed(1)}px, 100% 100%`;
        stage.style.maskPosition = `${(cx - hw).toFixed(1)}px ${(cy - hh).toFixed(1)}px, 0 0`;
        stage.style.maskRepeat = 'no-repeat';
      }
    }
    cue('unfold', u0, () => r$.sfx?.play('build'));
    cue('placed', u1, () => {
      stage.style.maskComposite = '';
      stage.style.maskPosition = '';
      setMask('both');
      for (const sc of surroundCanvases()) {
        sc.style.transition = 'opacity .8s ease';
        sc.style.opacity = '';
      }
      r$.sfx?.play('clamp');
      shake(2, 160);
    });

    // Effets : la lueur du launcher dans sa main, puis le joueur qui rentre chez lui.
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    const col = FX[r$.corrupted ? 'corrompue' : 'creatrice'];
    if (t < RET.IN + 0.2) {
      const a = 0.7 * (1 - segment(t, 0, RET.IN + 0.2));
      fxCtx.fillStyle = `rgba(${col.flash}, ${a.toFixed(3)})`;
      fxCtx.fillRect(0, 0, fx.width, fx.height);
    }
    if (t < u0 + 0.15) drawOrb(pr.x / FX_P, pr.y / FX_P, 3 * (1 - segment(t, u0 - 0.1, u0 + 0.15)) + 0.4 * Math.sin(t * 7), col, 0.9);
    const p = c$.player;
    if (p) {
      const palm = palmTop();
      const end = (c$.targetH ?? 60) / p.h;
      const g = ease(segment(t, h0, h1));
      const sx0 = palm.x + sr.left;
      const sy0 = palm.y + sr.top;
      const cx = (sx0 + p.x0) / 2;
      const cy = Math.min(sy0, p.y0) - 60;
      const x = (1 - g) * (1 - g) * sx0 + 2 * (1 - g) * g * cx + g * g * p.x0;
      const y = (1 - g) * (1 - g) * sy0 + 2 * (1 - g) * g * cy + g * g * p.y0;
      const sc = end + (1 - end) * (g * g * (3 - 2 * g));
      p.el.style.transform = `translate(${(x - p.x0).toFixed(1)}px, ${(y - p.y0).toFixed(1)}px) scale(${sc.toFixed(4)})`;
      if (t > h0 && t < h1) {
        c$.trail ??= [];
        c$.trail.push({ x: x - sr.left, y: y - sr.top - p.h * sc * 0.5, t });
      }
      if (t >= h0 && t < h1 + 0.2) drawThreads(fingertipsOf('left'), { x: x - sr.left, y: y - sr.top - p.h * sc * 0.5 }, Math.min(segment(t, h0, h0 + 0.2), 1 - segment(t, h1 - 0.2, h1 + 0.2)), t, col, r$.corrupted, 1);
      if (t >= h1) {
        // Il est rentré : son modèle reprend la place de son image.
        p.el.remove();
        c$.player = null;
        liveCharacter()?.setPresent?.(true);
        r$.landAt = { x: p.x0 - sr.left, y: p.y0 - sr.top, t };
        r$.sfx?.play('land');
      }
    }
    drawTrail(c$, t, col);
    if (r$.landAt) burst(r$.landAt, t - r$.landAt.t, col);

    // Ses assistants reviennent.
    if (t >= RET.END - 0.35) for (const bot of bots) bot.holder.visible = true;
    animateBots(1 / 60, true);

    if (t >= RET.END) finishReturn();
  }

  /** Fin du retour (ou retour interrompu) : tout en place, comme au repos. */
  function finishReturn() {
    const r$ = ret;
    if (!r$) return;
    ret = null;
    putWorldAway();
    applyTransform(r$.home, r$.home, 0);
    r$.c$.player?.el.remove();
    revealPlayer(r$.c$);
    frame.style.transition = '';
    frame.style.transform = '';
    frame.style.filter = '';
    frame.style.opacity = '';
    frame.style.willChange = '';
    for (const sc of surroundCanvases()) {
      sc.style.transition = '';
      sc.style.opacity = '';
    }
    stage.style.transition = '';
    stage.style.opacity = '';
    stage.style.maskComposite = '';
    stage.style.maskPosition = '';
    setMask('both');
    for (const bot of bots) {
      bot.holder.visible = true;
      if (bot.home) bot.holder.position.copy(bot.home);
    }
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    fx.style.opacity = '0';
    stage.dataset.ready = '';
    if (fitPending) {
      fitPending = false;
      fit();
    }
  }

  /* --------------------------------------------------- l'arrivée */

  // À l'ouverture (et au retour d'une partie), le cadre se construit d'abord ;
  // puis elle arrive. Créatrice : elle descend du haut, lente, le halo d'abord,
  // se penche, pose la main droite sur le coin, puis la gauche sur le bord —
  // un « clac » à chaque contact, le cadre qui tressaille ; ses assistants
  // suivent. Corrompue : elle surgit en glitch, apparaît à deux ou trois
  // endroits, se fige, et ses mains frappent le cadre — des fissures partent de
  // ses doigts.
  let arr = null;
  let fitPending = false;
  /** Réactions et clignements : une seule chose à la fois. */
  let pendingReaction = null;

  const lerp3 = (a, b, k) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * k);

  /** Le corps tressaille : un contact, un impact. */
  function shake(px, ms) {
    if (reduced) return;
    const k = [
      { transform: 'translate(0, 0)' },
      { transform: `translate(${px}px, ${Math.round(px * 1.3)}px)` },
      { transform: `translate(${-px}px, ${-Math.round(px * 0.6)}px)` },
      { transform: `translate(${Math.round(px / 2)}px, 0)` },
      { transform: 'translate(0, 0)' },
    ];
    document.body.animate(k, { duration: ms, easing: 'steps(5, end)' });
  }

  /** Avant l'arrivée : rien d'elle ni des assistants ne se voit. */
  function hideForArrival() {
    stage.style.transition = 'none';
    stage.style.opacity = '0';
    for (const bot of bots) bot.holder.visible = false;
  }

  /** Les fissures (corrompue) : des chemins de pixels qui partent des doigts. */
  function makeCracks() {
    const out = [];
    for (const h of marks.hands) {
      for (let n = 0; n < 5; n += 1) {
        let x = h.x / FX_P;
        let y = h.y / FX_P;
        // Vers l'extérieur du cadre : à droite, ou vers le haut pour la main du coin.
        let dx = 0.6 + Math.random() * 0.6;
        let dy = (Math.random() - 0.5) * 1.6;
        if (h === marks.hands[1]) {
          dx = (Math.random() - 0.3) * 1.4;
          dy = -0.6 - Math.random() * 0.6;
        }
        const path = [];
        const len = 16 + Math.floor(Math.random() * 20);
        for (let s = 0; s < len; s += 1) {
          path.push([Math.round(x), Math.round(y)]);
          x += dx + (Math.random() - 0.5) * 0.9;
          y += dy + (Math.random() - 0.5) * 0.9;
        }
        out.push(path);
      }
    }
    return out;
  }

  function drawCracks(cracks, k, fade) {
    const col = FX.corrompue;
    for (const path of cracks) {
      const n = Math.floor(path.length * k);
      for (let i = 0; i < n; i += 1) {
        const [x, y] = path[i];
        if (fade < 1 && fade < bayer(x, y)) continue;
        fxCtx.fillStyle = i < 3 ? col.core : i % 5 === 0 ? col.deep : col.glow;
        fxCtx.fillRect(x, y, 1, 1);
      }
    }
  }

  /**
   * Joue l'arrivée. Résolue quand elle agrippe le cadre et que ses assistants
   * sont à leur place.
   */
  function arrive(sfx) {
    if (sfx) sfxRef = sfx;
    if (cine || ret || !frameBox || !home) return Promise.resolve();
    stage.dataset.ready = '';
    if (reduced) {
      stage.style.transition = '';
      stage.style.opacity = '';
      for (const bot of bots) bot.holder.visible = true;
      setMask('both');
      return Promise.resolve();
    }
    if (arr) finishArrival();
    const corrupted = etat === 'corrompue';
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    const unit = unitAt(holder) || 1;
    arr = {
      start: performance.now(),
      corrupted,
      sfx,
      resolve,
      unit,
      cues: new Set(),
      reach: { arm_right: [...reach.arm_right], arm_left: [...reach.arm_left] },
      // Corrompue : trois apparitions furtives, ailleurs, avant de se figer.
      ghosts: [
        { dx: -0.2 * W, dy: 0.1 * H, from: 0.05, to: 0.2 },
        { dx: 0.12 * W, dy: -0.22 * H, from: 0.32, to: 0.43 },
        { dx: -0.06 * W, dy: 0.04 * H, from: 0.55, to: 0.63 },
      ],
      cracks: null,
      length: corrupted ? 2.7 : 3.3,
    };
    for (const bot of bots) bot.holder.visible = false;
    setMask('none');
    stage.style.transition = 'none';
    stage.style.opacity = corrupted ? '0' : '1';
    fxResize();
    return promise;
  }

  /** Termine l'arrivée d'un coup : la pose finale, tout le monde en place. */
  function finishArrival() {
    const a$ = arr;
    if (!a$) return;
    arr = null;
    applyTransform(home, home, 0);
    for (const bot of bots) {
      bot.holder.visible = true;
      if (bot.home) bot.holder.position.copy(bot.home);
    }
    stage.style.opacity = '';
    stage.style.transform = '';
    stage.style.transition = '';
    setMask('both');
    if (!cine) {
      fxCtx.clearRect(0, 0, fx.width, fx.height);
      fx.style.opacity = '0';
    }
    a$.resolve();
    if (fitPending) {
      fitPending = false;
      fit();
    }
    if (pendingReaction) {
      const kind = pendingReaction;
      pendingReaction = null;
      setTimeout(() => react(kind), 250);
    }
  }

  /** Les doigts de chaque main (phalanges et pouce). */
  const FINGERS = {
    arm_right: [...xen.bones.keys()].filter((n) => /^(finger|thumb)_right/.test(n)),
    arm_left: [...xen.bones.keys()].filter((n) => /^(finger|thumb)_left/.test(n)),
  };

  /** Défait la courbure des doigts de l'animation : `open` 1, la main ouverte. */
  function openFingers(extra, anim, at, name, open) {
    if (open <= 0) return;
    for (const f of FINGERS[name]) {
      const ch = anim.bones[f]?.rotation;
      if (!ch) continue;
      extra[f] = sample(ch, at).map((v) => -v * open);
    }
  }

  /**
   * Un bras qui vient agripper le cadre : il approche (la main ouverte, au-
   * dessus de sa prise, qui se tourne peu à peu vers le cadre), se pose, et
   * les doigts se referment au contact. Renvoie l'ouverture des doigts.
   * @param {{a0: number, a1: number, c: number}} k  début, fin de l'approche, contact
   */
  function grabPhase(t, name, from, k) {
    const app = approach[etat]?.[name] ?? arr.reach[name];
    const final = arr.reach[name];
    const go = ease(segment(t, k.a0, k.a1));
    // La pose : vers l'approche, puis — en accélérant — sur la prise.
    const land = segment(t, k.a1, k.c) ** 2;
    const r = t < k.a1 ? lerp3(from, app, go) : lerp3(app, final, land);
    const open = Math.min(segment(t, k.a0, k.a0 + 0.3), 1 - ease(segment(t, k.c - 0.06, k.c + 0.16)));
    const turn = ease(segment(t, k.a0 + 0.1, k.a1 + 0.05));
    return { r, open, turn };
  }

  /** Oriente les mains : de leur pose animée vers la prise (`turn` de 0 à 1). */
  function turnHands(turns) {
    for (const [name, q] of handQuats) {
      const k = turns[name === 'hand_left' ? 'arm_left' : 'arm_right'] ?? 1;
      const bone = xen.bones.get(name).group;
      if (k >= 1) bone.quaternion.copy(q);
      else bone.quaternion.slerp(q, k);
    }
  }

  /** Le léger fléchissement du corps quand une main prend appui (en pixels). */
  const dipAt = (t, c) => (t > c && t < c + 0.35 ? 3 * Math.sin(Math.PI * segment(t, c, c + 0.35)) : 0);

  function arriveFrame(dt) {
    const a$ = arr;
    const t = (performance.now() - a$.start) / 1000;
    const cue = (name, at, fn) => {
      if (t >= at && !a$.cues.has(name)) {
        a$.cues.add(name);
        fn();
      }
    };
    const anim = anims[etat];
    const at = time % anim.length;

    if (!a$.corrupted) {
      // --- créatrice : elle descend.
      const down = 1 - (1 - segment(t, 0, 1.5)) ** 3;
      applyTransform(home, home, 0);
      tilt.position.y += ((H * 0.95) / a$.unit) * (1 - down);
      tilt.rotation.z = home.tiltZ * ease(segment(t, 0.5, 1.6));
      holder.rotation.y = home.rotY + 0.35 * (1 - ease(segment(t, 0.4, 1.6)));
      // La main droite d'abord (le coin du haut), puis la gauche (le bord).
      const KR = { a0: 1.0, a1: 1.55, c: 1.8 };
      const KL = { a0: 1.45, a1: 2.0, c: 2.25 };
      const gR = grabPhase(t, 'arm_right', [0, 0, 0], KR);
      const gL = grabPhase(t, 'arm_left', [0, 0, 0], KL);
      const extra = { arm_right: gR.r, arm_left: gL.r };
      openFingers(extra, anim, at, 'arm_right', gR.open);
      openFingers(extra, anim, at, 'arm_left', gL.open);
      // Elle suit sa main du regard pendant qu'elle la pose.
      const glance = Math.sin(Math.PI * segment(t, 0.9, 2.4));
      extra.head = [-7 * (Math.sign(marks.pitchPx) || 1) * glance, 8 * (Math.sign(marks.yawPx) || 1) * glance, 0];
      poseBlend(sampleMap(cineAnims.fly, t), sampleMap(anim, at, withPosture(extra)), ease(segment(t, 0.5, 1.4)));
      turnHands({ arm_right: gR.turn, arm_left: gL.turn });
      tilt.position.y -= (dipAt(t, KR.c) + dipAt(t, KL.c)) / a$.unit;
      cue('clampR', 1.8, () => {
        a$.sfx?.play('clamp');
        shake(2, 160);
        setMask('right');
      });
      cue('clampL', 2.25, () => {
        a$.sfx?.play('clamp');
        shake(2, 160);
        setMask('both');
      });
      // Les assistants : le curieux accourt de la gauche, le fidèle de la droite,
      // en sautillant, et s'arrête net (un petit bruit de pas).
      const [peek, idle] = bots;
      if (t >= 2.35 && peek.home) {
        peek.holder.visible = true;
        const k = 1 - (1 - segment(t, 2.35, 3.0)) ** 2;
        const u = unitAt(peek.holder) || 1;
        peek.holder.position.copy(peek.home);
        peek.holder.position.x -= ((frameBox.x + 140) / u) * (1 - k);
        peek.holder.position.y += (Math.abs(Math.sin(k * Math.PI * 5)) * 10 * (1 - k)) / u;
      }
      if (t >= 2.55 && idle.home) {
        idle.holder.visible = true;
        const k = 1 - (1 - segment(t, 2.55, 3.15)) ** 2;
        const u = unitAt(idle.holder) || 1;
        idle.holder.position.copy(idle.home);
        idle.holder.position.x += ((W - marks.head.x + 80) / u) * (1 - k);
        idle.holder.position.y += (Math.abs(Math.sin(k * Math.PI * 4)) * 8 * (1 - k)) / u;
      }
      cue('land', 3.15, () => a$.sfx?.play('land'));
    } else {
      // --- corrompue : elle surgit en glitch.
      applyTransform(home, home, 0);
      const ghost = a$.ghosts.find((g) => t >= g.from && t < g.to);
      let visible = t >= 0.78;
      if (ghost) {
        visible = Math.random() < 0.85;
        tilt.position.x += ghost.dx / a$.unit;
        tilt.position.y -= ghost.dy / a$.unit;
      }
      a$.ghosts.forEach((g, i) => cue(`ghost${i}`, g.from, () => a$.sfx?.play('glitch')));
      cue('lock', 0.78, () => a$.sfx?.play('glitch'));
      stage.style.opacity = visible ? '1' : '0';
      stage.style.transform = t < 0.95 && Math.random() < 0.3 ? `translateX(${Math.round((Math.random() - 0.5) * 10)}px)` : '';
      // Les bras levés au-dessus de leur prise, les doigts écartés en griffes,
      // puis qui s'abattent sur le cadre ; les doigts se referment au choc.
      const slam = segment(t, 0.9, 1.05) ** 3;
      const app = approach.corrompue ?? a$.reach;
      const extra = {
        arm_right: lerp3(app.arm_right, a$.reach.arm_right, slam),
        arm_left: lerp3(app.arm_left, a$.reach.arm_left, slam),
      };
      const open = 1 - ease(segment(t, 1.0, 1.12));
      openFingers(extra, anim, at, 'arm_right', open);
      openFingers(extra, anim, at, 'arm_left', open);
      pose(xen, anim, at, withPosture(extra));
      turnHands({});
      if (t > 1.05 && t < 1.4) tilt.position.y -= (6 * Math.sin(Math.PI * segment(t, 1.05, 1.4))) / a$.unit;
      cue('slam', 1.05, () => {
        a$.sfx?.play('slam');
        shake(7, 280);
        setMask('both');
        a$.cracks = makeCracks();
        fx.style.opacity = '1';
      });
      // Les assistants grésillent avant d'apparaître.
      if (t >= 1.3) {
        const settled = t >= 1.9;
        for (const bot of bots) bot.holder.visible = settled || Math.random() < 0.5;
        cue('bots', 1.3, () => a$.sfx?.play('glitch'));
      }
      if (a$.cracks) {
        fxCtx.clearRect(0, 0, fx.width, fx.height);
        drawCracks(a$.cracks, segment(t, 1.05, 1.5), 1 - segment(t, 1.9, 2.6));
      }
    }
    animateBots(dt, !a$.corrupted && t < 3.2);
    if (t >= a$.length) finishArrival();
  }

  /* -------------------------------------------- le regard, les réactions */

  // Sa tête suit doucement la souris (jamais ses mains) ; elle cligne des
  // yeux ; au survol de JOUER, elle se penche et regarde le bouton ; un
  // lancement raté : elle détourne la tête, méprisante (corrompue : un rire
  // haché, qui grésille).
  const look = { yaw: 0, pitch: 0, glow: 1 };
  let cursor = null;
  let cursorAt = 0;
  let attended = null;
  let reaction = null;
  let blinkIn = 2 + Math.random() * 3;
  let blinkLeft = 0;
  let blinkSecond = false;

  window.addEventListener('mousemove', (e) => {
    const sr = stage.getBoundingClientRect();
    cursor = { x: e.clientX - sr.left, y: e.clientY - sr.top };
    cursorAt = performance.now();
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => {
    cursor = null;
  });

  /** Regarde un élément (le bouton JOUER survolé), ou plus rien. */
  function attend(el) {
    attended = el ?? null;
  }

  /** Une réaction à un lancement raté ; attend la fin d'une arrivée. */
  function react(kind = 'fail') {
    if (reduced) return;
    if (cine || arr || ret) {
      pendingReaction = kind;
      return;
    }
    const corrupted = etat === 'corrompue';
    reaction = { kind: corrupted ? 'laugh' : 'deny', t: 0, length: corrupted ? 1.7 : 2.4 };
    sfxRef?.play(reaction.kind);
  }
  let sfxRef = null;

  const clamp = (v, a = -1, b = 1) => Math.min(b, Math.max(a, v));

  /** Le regard de cette image : en degrés (convention Bedrock), lissé. */
  function lookStep(dt) {
    let yaw = 0;
    let pitch = 0;
    let glow = 1;
    const sy = Math.sign(marks.yawPx) || 1;
    const sp = Math.sign(marks.pitchPx) || 1;
    let target = null;
    if (attended?.isConnected) {
      const r = attended.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      target = { x: r.left + r.width / 2 - sr.left, y: r.top + r.height / 2 - sr.top };
      glow = 1.6;
    } else if (weaving.k > 0.3 && weaving.bar?.isConnected) {
      // Elle tisse : elle regarde son ouvrage.
      const r = weaving.bar.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      target = { x: r.left + r.width * 0.7 - sr.left, y: r.top - sr.top };
      glow = 1.3;
    } else if (cursor && performance.now() - cursorAt < 10_000) {
      target = cursor;
    }
    if (target) {
      yaw = clamp((target.x - marks.head.x) / (W * 0.45)) * 16 * sy;
      pitch = clamp((target.y - marks.head.y) / (H * 0.45)) * 10 * sp;
      if (attended) pitch += 6 * sp;
    }
    let jitter = [0, 0];
    if (reaction) {
      reaction.t += dt;
      const k = Math.min(segment(reaction.t, 0, 0.3), 1 - segment(reaction.t, reaction.length - 0.5, reaction.length));
      if (reaction.kind === 'deny') {
        // Elle détourne la tête, vers l'extérieur, le menton levé.
        yaw = yaw * (1 - k) + 24 * sy * k;
        pitch = pitch * (1 - k) - 9 * sp * k;
      } else {
        // Le rire : la tête qui hoche, saccadée ; l'image qui saute.
        pitch = pitch * (1 - k) + (Math.sin(reaction.t * 26) * 5 - 5) * sp * k;
        jitter = [Math.sin(reaction.t * 47) * 3 * k, 0];
        stage.style.transform = Math.random() < 0.25 * k ? `translateX(${Math.round((Math.random() - 0.5) * 8)}px)` : '';
        for (const bot of bots) bot.holder.visible = Math.random() > 0.15 * k;
      }
      glow = reaction.kind === 'laugh' ? 1.4 + Math.random() * 0.6 * k : glow;
      if (reaction.t >= reaction.length) {
        reaction = null;
        stage.style.transform = '';
        for (const bot of bots) bot.holder.visible = true;
      }
    }
    const f = Math.min(1, dt * 3.2);
    look.yaw += (yaw - look.yaw) * f;
    look.pitch += (pitch - look.pitch) * f;
    look.glow += (glow - look.glow) * Math.min(1, dt * 4);
    xenSkin.setGlow(look.glow);
    return [look.pitch + jitter[1], look.yaw + jitter[0], 0];
  }

  function blinkStep(dt) {
    if (blinkLeft > 0) {
      blinkLeft -= dt;
      if (blinkLeft <= 0) xen.options.blink = false;
      return;
    }
    blinkIn -= dt;
    if (blinkIn > 0) return;
    xen.options.blink = true;
    blinkLeft = 0.11;
    // Corrompue, parfois : un second clignement, trop vite.
    if (!blinkSecond && etat === 'corrompue' && Math.random() < 0.4) {
      blinkSecond = true;
      blinkIn = 0.25;
    } else {
      blinkSecond = false;
      blinkIn = 2.5 + Math.random() * 4;
    }
  }

  /* ---------------------------------------------- la bascule de l'état */

  /**
   * Xenodys change d'état pendant que le launcher est ouvert : la corruption
   * (ou la lumière) part de son cœur et s'étend ; `apply` bascule le thème au
   * moment où l'onde couvre la fenêtre.
   */
  let wave = null;
  function shift(next, apply) {
    if (reduced || cine || arr || ret || !frameBox) {
      apply?.();
      return;
    }
    fxResize();
    fx.style.opacity = '1';
    wave = { start: performance.now(), etat: next === 'corrompue' ? 'corrompue' : 'creatrice', apply, applied: false };
    sfxRef?.play(next === 'corrompue' ? 'corrupt' : 'purify');
  }

  /** Le thème bascule quand l'onde a couvert l'essentiel de la fenêtre, dans un éclair. */
  const WAVE_APPLY = 0.8;
  function waveFrame() {
    const t = (performance.now() - wave.start) / 1000;
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    drawPortal(t / 1.7, marks.chest.x / FX_P, marks.chest.y / FX_P, wave.etat);
    if (!wave.applied && t >= WAVE_APPLY) {
      wave.applied = true;
      wave.apply?.();
    }
    if (t >= WAVE_APPLY && t < WAVE_APPLY + 0.4) {
      const a = 0.7 * (1 - (t - WAVE_APPLY) / 0.4);
      fxCtx.fillStyle = `rgba(${FX[wave.etat].flash}, ${a.toFixed(3)})`;
      fxCtx.fillRect(0, 0, fx.width, fx.height);
    }
    if (t >= 1.9) endWave();
  }

  function endWave() {
    if (!wave) return;
    if (!wave.applied) wave.apply?.();
    wave = null;
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    fx.style.opacity = '0';
  }

  /* ---------------------------------------------------------- vie */

  function animateBots(dt, placing = false) {
    for (const bot of bots) {
      bot.time += dt;
      bot.rig.clock = bot.time;
      const base = botAnims[bot.role];
      const map = sampleMap(base, bot.time % base.length);
      if (!placing && bot.role === 'idle' && !reduced) {
        if (!bot.wave) {
          bot.nextWave -= dt;
          if (bot.nextWave <= 0) bot.wave = { t: 0 };
        } else {
          bot.wave.t += dt;
          for (const [name, v] of sampleMap(botAnims.wave, bot.wave.t)) {
            const cur = map.get(name)?.r ?? ZERO;
            if (v.r) map.set(name, { r: cur.map((x, i) => x + v.r[i]), p: map.get(name)?.p ?? null });
          }
          if (bot.wave.t >= botAnims.wave.length) {
            bot.wave = null;
            bot.nextWave = 14 + Math.random() * 20;
          }
        }
      }
      applyMap(bot.rig, map);
    }
  }

  const applySkin = () => {
    xenSkin.setEtat(etat);
    for (const b of Object.values(botSkins)) b.setEtat(etat);
    stage.dataset.etat = etat;
  };
  applySkin();
  fit();
  // Rien ne se voit avant son arrivée (`arrive`, après la construction du cadre).
  hideForArrival();

  viewer.animation = new lib.FunctionAnimation((_player, _progress, delta) => {
    const dt = reduced ? 0 : Math.min(0.1, Math.max(0, delta || 0));
    time += dt;
    xen.clock = time;
    if (ret) {
      returnFrame();
      return;
    }
    if (cine) {
      cineFrame();
      return;
    }
    if (arr) {
      arriveFrame(dt);
      return;
    }
    if (wave) waveFrame();
    blinkStep(dt);
    const at = time % anims[etat].length;
    const head = lookStep(dt);
    const w = weaveStep(dt);
    if (w > 0) poseWeaving(at, head, w);
    else poseXen(at, false, head);
    const drawing = w > 0 || snapFx !== null;
    if (drawing) {
      if (!wave) fxCtx.clearRect(0, 0, fx.width, fx.height);
      if (fx.style.opacity !== '1') {
        fxResize();
        fx.style.opacity = '1';
      }
      if (w > 0) drawWeaving(w);
      if (snapFx) drawSnap();
    } else if (weaving.drawn && !wave) {
      fxCtx.clearRect(0, 0, fx.width, fx.height);
      fx.style.opacity = '0';
    }
    weaving.drawn = drawing;
    animateBots(dt);
  });

  const observer = new MutationObserver(() => {
    const next = root$.dataset.xenodys === 'corrompue' ? 'corrompue' : 'creatrice';
    if (next === etat) return;
    etat = next;
    applySkin();
  });
  observer.observe(root$, { attributes: true, attributeFilter: ['data-xenodys'] });

  // Le calage essaie plusieurs centaines de poses : pendant un redimensionnement
  // à la poignée, on attend que le geste se pose. Jamais pendant la cinématique.
  const sizer = new ResizeObserver(() => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      if (cine) return;
      if (arr || ret) {
        fitPending = true;
        return;
      }
      const r = stage.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) viewer.setSize(r.width, r.height);
      fit();
    }, 120);
  });
  sizer.observe(stage);
  sizer.observe(frame);

  const onVisibility = () => {
    viewer.renderPaused = document.hidden;
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    viewer,
    bones: xen.bones,
    holder,
    bots,
    begin,
    release,
    launch,
    weave,
    weaveInfo,
    setTiles,
    snap,
    get weaveStalled() {
      return weaveStalled();
    },
    comeBack,
    arrive,
    attend,
    react,
    shift,
    /** Une cinématique est-elle en cours (ou le launcher encore « parti ») ? */
    get busy() {
      return cine !== null || ret !== null;
    },
    /** La préparation est-elle finie (le passage s'ouvre) ? */
    get released() {
      return cine?.released ?? false;
    },
    dispose() {
      fx.remove();
      clearTimeout(fitTimer);
      observer.disconnect();
      sizer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      handGlowMat.dispose();
      for (const batch of [...Object.values(batches), ringBatch]) batch.geometry.dispose();
      for (const tex of tileTex.values()) tex.dispose();
      for (const m of Object.values(worldMats)) m.dispose();
      xenSkin.dispose();
      for (const b of Object.values(botSkins)) b.dispose();
      viewer.dispose();
    },
  };
}
