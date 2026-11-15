/**
 * Xenodys en 3D — hors du cadre, en mode « fenêtre ouverte ».
 *
 * Lit le modèle GeckoLib généré par xenodys/generer.py (assets/js/data/
 * xenodys-model.js : géométrie Bedrock et animations, les mêmes que dans le
 * jeu) et le fait vivre dans un canevas posé à cheval sur le bord droit du
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
 * La cinématique du lancement : `begin` (clic), `release` (le jeu démarre),
 * `comeBack` (le launcher revient).
 */

import { ANIMATIONS, ASSISTANT_ANIMATIONS, ASSISTANT_GEO, GEO } from '../data/xenodys-model.js';
import { liveCharacter } from './character3d.js';
import { rebuildFrame } from './intro.js';

const NEAREST = 1003;
const DEG = Math.PI / 180;
/** Mise à l'échelle du modèle dans la scène de skinview3d. */
const MODEL_SCALE = 0.3;

/* ------------------------------------------------------------- géométrie */

/** Bedrock → espace Blockbench / Three.js : l'axe x est inversé. */
const pivotOf = (p) => [-p[0], p[1], p[2]];

/**
 * Applique à un pavé les coordonnées UV « box » d'un cube Bedrock.
 * Ordre des faces de BoxGeometry : +x, −x, +y, −y, +z, −z ; dans l'espace
 * Blockbench, +x = est, −z = nord (le visage).
 */
function applyBoxUv(geometry, [u, v], [w, h, d], tw, th) {
  const rects = {
    east: [u, v + d, d, h],
    north: [u + d, v + d, w, h],
    west: [u + d + w, v + d, d, h],
    south: [u + 2 * d + w, v + d, w, h],
    up: [u + d, v, w, d],
    down: [u + d + w, v, w, d],
  };
  const order = ['east', 'west', 'up', 'down', 'south', 'north'];
  const uv = geometry.attributes.uv;
  order.forEach((face, f) => {
    const [x, y, rw, rh] = rects[face];
    let top = 1 - y / th;
    let bottom = 1 - (y + rh) / th;
    const left = x / tw;
    const right = (x + rw) / tw;
    // Dessus et dessous : le bord bas de la région touche la face avant.
    if (face === 'up' || face === 'down') [top, bottom] = [bottom, top];
    const i = f * 4;
    uv.setXY(i, left, top);
    uv.setXY(i + 1, right, top);
    uv.setXY(i + 2, left, bottom);
    uv.setXY(i + 3, right, bottom);
  });
  uv.needsUpdate = true;
}

/**
 * Construit le modèle. Renvoie la racine et les os, par nom, avec leur pose de repos.
 * @param {{Mesh: any, Box: any, Group: any}} T
 * @param {any} material
 */
function buildModel(T, material, doc = GEO) {
  const geo = doc['minecraft:geometry'][0];
  const { texture_width: tw, texture_height: th } = geo.description;
  const bones = new Map();

  for (const def of geo.bones) {
    const group = new T.Group();
    group.rotation.order = 'ZYX';
    const pivot = pivotOf(def.pivot);
    const parent = def.parent ? bones.get(def.parent) : null;
    const base = parent ? parent.pivot : [0, 0, 0];
    group.position.set(pivot[0] - base[0], pivot[1] - base[1], pivot[2] - base[2]);
    const r = def.rotation ?? [0, 0, 0];
    group.rotation.set(-r[0] * DEG, -r[1] * DEG, r[2] * DEG);

    for (const cube of def.cubes ?? []) {
      const [ox, oy, oz] = cube.origin;
      const [sx, sy, sz] = cube.size;
      const from = [-(ox + sx), oy, oz];
      const center = [from[0] + sx / 2, from[1] + sy / 2, from[2] + sz / 2];
      const geometry = new T.Box(sx, sy, sz);
      applyBoxUv(geometry, cube.uv, cube.size, tw, th);
      const mesh = new T.Mesh(geometry, material);

      if (cube.rotation) {
        const cp = pivotOf(cube.pivot);
        const holder = new T.Group();
        holder.rotation.order = 'ZYX';
        holder.position.set(cp[0] - pivot[0], cp[1] - pivot[1], cp[2] - pivot[2]);
        const cr = cube.rotation;
        holder.rotation.set(-cr[0] * DEG, -cr[1] * DEG, cr[2] * DEG);
        mesh.position.set(center[0] - cp[0], center[1] - cp[1], center[2] - cp[2]);
        holder.add(mesh);
        group.add(holder);
      } else {
        mesh.position.set(center[0] - pivot[0], center[1] - pivot[1], center[2] - pivot[2]);
        group.add(mesh);
      }
    }

    (parent ? parent.group : null)?.add(group);
    bones.set(def.name, {
      group,
      pivot,
      rest: {
        position: group.position.clone(),
        rotation: [group.rotation.x, group.rotation.y, group.rotation.z],
      },
    });
  }

  const root = bones.get(geo.bones[0].name).group;
  return { root, bones };
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

/** Applique une pose : le repos, puis l'animation au temps `t`, puis des
 *  décalages éventuels (en degrés, convention Bedrock), par os. */
function pose(bones, anim, t, extra = null) {
  for (const bone of bones.values()) {
    bone.group.position.copy(bone.rest.position);
    bone.group.rotation.set(...bone.rest.rotation);
  }
  const apply = (name, r, q) => {
    const bone = bones.get(name);
    if (!bone) return;
    if (r) {
      bone.group.rotation.x += -r[0] * DEG;
      bone.group.rotation.y += -r[1] * DEG;
      bone.group.rotation.z += r[2] * DEG;
    }
    if (q) {
      bone.group.position.x += -q[0];
      bone.group.position.y += q[1];
      bone.group.position.z += q[2];
    }
  };
  for (const [name, channels] of Object.entries(anim.bones)) {
    apply(name, channels.rotation && sample(channels.rotation, t), channels.position && sample(channels.position, t));
  }
  if (extra) for (const [name, r] of Object.entries(extra)) apply(name, r, null);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} stage  le conteneur (toute la fenêtre)
 * @param {HTMLElement} frame  le cadre du launcher
 */
export async function createXenodys(canvas, stage, frame) {
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
    Box: sample3.geometry.constructor,
    Material: sample3.material.constructor,
    Texture: viewer.skinTexture.constructor,
    Group: Object.getPrototypeOf(lib.BodyPart.prototype).constructor,
  };
  viewer.playerObject.visible = false;
  if (viewer.globalLight) viewer.globalLight.intensity *= 0.85;

  const load = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const t = new T.Texture(img);
        t.magFilter = NEAREST;
        t.minFilter = NEAREST;
        t.generateMipmaps = false;
        t.needsUpdate = true;
        resolve(t);
      };
      img.onerror = () => reject(new Error(`texture introuvable : ${src}`));
      img.src = src;
    });

  /** Les textures d'un modèle, dans ses deux états, et son matériau. */
  async function skinned(name, { blink = false } = {}) {
    const skins = {};
    for (const etat of ['creatrice', 'corrompue']) {
      const [map, glow] = await Promise.all([
        load(`assets/xenodys/${name}_${etat}.png`),
        load(`assets/xenodys/${name}_${etat}_glowmask.png`),
      ]);
      skins[etat] = { map, glow };
      if (blink) {
        // Les paupières closes : la même texture, le regard éteint.
        const [bmap, bglow] = await Promise.all([
          load(`assets/xenodys/${name}_${etat}_blink.png`),
          load(`assets/xenodys/${name}_${etat}_blink_glowmask.png`),
        ]).catch(() => [null, null]);
        if (bmap && bglow) skins[`${etat}_blink`] = { map: bmap, glow: bglow };
      }
    }
    const material = new T.Material({ map: skins.creatrice.map, alphaTest: 0.5 });
    if ('emissiveMap' in material) {
      material.emissiveMap = skins.creatrice.glow;
      material.emissive?.set?.(0xffffff);
      material.emissiveIntensity = 1;
    }
    let current = 'creatrice';
    let closed = false;
    const show = () => {
      const sk = (closed && skins[`${current}_blink`]) || skins[current];
      material.map = sk.map;
      if ('emissiveMap' in material) material.emissiveMap = sk.glow;
      material.needsUpdate = true;
    };
    const setEtat = (etat) => {
      current = etat;
      show();
    };
    const setBlink = (on) => {
      if (closed === Boolean(on)) return;
      closed = Boolean(on);
      show();
    };
    const dispose = () => {
      for (const sk of Object.values(skins)) {
        sk.map.dispose();
        sk.glow.dispose();
      }
      material.dispose();
    };
    return { material, setEtat, setBlink, dispose };
  }

  const xenSkin = await skinned('xenodys', { blink: true });
  const botSkin = await skinned('xenodys_assistant');

  // Xenodys, de trois quarts, tournée vers le launcher.
  const xen = buildModel(T, xenSkin.material);
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
    const model = buildModel(T, botSkin.material, ASSISTANT_GEO);
    const h = new T.Group();
    h.add(model.root);
    h.rotation.y = Math.PI + (role === 'peek' ? 0.5 : -0.35);
    viewer.scene.add(h);
    return { role, holder: h, bones: model.bones, time: Math.random() * 3, wave: null, nextWave: 8 + Math.random() * 10 };
  });

  const anims = { creatrice: compile('lean'), corrompue: compile('corrupted_lean') };
  const botAnims = {
    idle: compile('idle', ASSISTANT_ANIMATIONS, 'animation.xenodys_assistant'),
    peek: compile('peek', ASSISTANT_ANIMATIONS, 'animation.xenodys_assistant'),
    wave: compile('wave', ASSISTANT_ANIMATIONS, 'animation.xenodys_assistant'),
  };

  const root$ = document.documentElement;
  let etat = root$.dataset.xenodys === 'corrompue' ? 'corrompue' : 'creatrice';
  let time = 0;
  /** Corrections des bras trouvées par fit() pour que les mains tombent juste. */
  const reach = { arm_right: [0, 0, 0], arm_left: [0, 0, 0] };
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
    handQuats.set(name, local);
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
  function poseXen(t, reface = false, head = null) {
    pose(xen.bones, anims[etat], t, head ? { ...reach, head } : reach);
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
  const xenMeshes = meshesOf(holder);
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
  /** Pixels par unité du monde, à la profondeur de l'objet. */
  const worldOf = (obj) => obj.getWorldPosition(new V3());
  const unitAt = (obj) => {
    const o = toPx(worldOf(obj));
    return toPx(worldOf(obj).add(new V3(1, 0, 0))).x - o.x;
  };

  /* ---------------------------------------------------------- cadrage */

  /** Recouvrement des doigts sur les bords du cadre, en pixels. */
  const GRIP = 26;
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
   * Place Xenodys. Sa tête — sa taille en découle : 17 % de la hauteur de la
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
    holder.position.set(0, -54 * MODEL_SCALE, 0);
    tilt.position.set(0, 0, 0);
    reach.arm_right = [0, 0, 0];
    reach.arm_left = [0, 0, 0];
    handQuats.clear();

    const headBox = meshesOf(xen.bones.get('head').group).filter((o) => o.geometry.parameters?.width === 12);
    const headTarget = { x: edge + Math.max(60, margin * 0.36), y: frameBox.y + frameBox.h * 0.2 };
    for (let pass = 0; pass < 5; pass += 1) {
      poseXen(0);
      refresh();
      const hb = boxOf(headBox);
      const k = (H * 0.17) / Math.max(1, hb.maxY - hb.minY);
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
      ? { x: edge - GRIP, y: frameBox.y + frameBox.h * 0.45 }
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
      pose(bot.bones, botAnims.idle, 0);
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
    measure();
    setMask(maskKind);
  }

  /* ------------------------------------------------ repères à l'écran */

  /** Ce que la vie de Xenodys doit savoir de sa pose : où sont sa tête, son
   *  cœur, ses mains, sa place et celle des assistants. */
  const marks = { head: { x: 0, y: 0 }, chest: { x: 0, y: 0 }, hands: [], yawPx: 1, pitchPx: 1 };
  let home = null;
  const headMesh = () => meshesOf(xen.bones.get('head').group).find((o) => o.geometry.parameters?.width === 12);
  /** Un point devant le visage : c'est lui qui suit le regard. */
  const facePoint = () => {
    const m = headMesh();
    return toPx(m.localToWorld(new V3(0, 0, -16)));
  };
  function measure() {
    home = transformNow();
    for (const bot of bots) bot.home = bot.holder.position.clone();
    const hb = boxOf([headMesh()]);
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
  const masks = { none: '', right: '', both: '' };
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

  /* ------------------------------------- outils de la cinématique */

  // Au clic sur JOUER : elle lâche le cadre, vole devant lui, nous tourne le
  // dos, recueille le launcher qui rétrécit entre ses mains jusqu'à n'être
  // plus qu'un orbe — le joueur s'y engouffre, en pixels. Elle attend la fin
  // de la préparation, puis ouvre grand les bras : le passage vers le monde
  // s'ouvre (lumière cyan, ou déchirure rouge et violette si elle est
  // corrompue). Au retour du jeu, le launcher se reconstruit et elle revient.
  const cineAnims = { fly: compile('fly'), cradle: compile('cradle'), unveil: compile('unveil') };
  let cine = null;

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

  /** Mélange deux poses (`w` de 0 à 1) et l'applique. */
  function poseBlend(a, b, w) {
    for (const bone of xen.bones.values()) {
      bone.group.position.copy(bone.rest.position);
      bone.group.rotation.set(...bone.rest.rotation);
    }
    const names = new Set([...a.keys(), ...b.keys()]);
    const mix = (u, v) => [0, 1, 2].map((i) => (u?.[i] ?? 0) * (1 - w) + (v?.[i] ?? 0) * w);
    for (const name of names) {
      const bone = xen.bones.get(name);
      if (!bone) continue;
      const ra = a.get(name);
      const rb = b.get(name);
      const r = mix(ra?.r, rb?.r);
      bone.group.rotation.x += -r[0] * DEG;
      bone.group.rotation.y += -r[1] * DEG;
      bone.group.rotation.z += r[2] * DEG;
      if (ra?.p || rb?.p) {
        const q = mix(ra?.p, rb?.p);
        bone.group.position.x += -q[0];
        bone.group.position.y += q[1];
        bone.group.position.z += q[2];
      }
    }
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

  /** Où elle se place pour recueillir le launcher : devant lui, de dos, les
   *  mains levées au-dessus du centre du cadre. Renvoie la transformation et
   *  le point (écran) entre ses mains. */
  function frontPlacement(lean) {
    const saved = transformNow();
    tilt.rotation.z = 0;
    holder.rotation.y = 0.12;
    holder.scale.setScalar(lean.scale * 1.15);
    const cradle = sampleMap(cineAnims.cradle, 0);
    const target = { x: frameBox.x + frameBox.w * 0.5, y: frameBox.y + frameBox.h * 0.36 };
    let point = target;
    for (let pass = 0; pass < 3; pass += 1) {
      poseBlend(cradle, cradle, 0);
      refresh();
      const L = boxOf(handL);
      const R = boxOf(handR);
      const mid = { x: (L.minX + L.maxX + R.minX + R.maxX) / 4, y: Math.min(L.minY, R.minY) };
      const unit = unitAt(holder);
      tilt.position.x += (target.x - mid.x) / unit;
      tilt.position.y -= (target.y - mid.y) / unit;
      point = mid;
    }
    refresh();
    const L = boxOf(handL);
    const R = boxOf(handR);
    point = { x: (L.minX + L.maxX + R.minX + R.maxX) / 4, y: Math.min(L.minY, R.minY) - 6 };
    const to = transformNow();
    applyTransform(saved, saved, 0);
    return { to, point };
  }

  // Le calque des effets : l'orbe, puis le passage. En pixel art, comme le décor.
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

  /** Prend l'image du personnage et le cache : ses pixels prennent le relais. */
  function dissolvePlayer(c$) {
    const cap = liveCharacter()?.capture?.();
    if (!cap) return;
    c$.particles = cellsOf(cap.body, cap.rect);
    c$.shards = cap.jar ? cellsOf(cap.jar, cap.rect, 2) : [];
    for (const el of characterEls()) el.style.visibility = 'hidden';
    c$.sfx?.play(c$.shards.length ? 'shatter' : 'dissolve');
    if (c$.shards.length) setTimeout(() => c$.sfx?.play('dissolve'), 120);
  }

  function revealPlayer() {
    for (const el of characterEls()) el.style.visibility = '';
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

  /* --------------------------------------- l'attente : l'orbe, l'anneau */

  // La cible du clic sur l'orbe, et l'étiquette de la préparation.
  const hit = document.createElement('button');
  hit.type = 'button';
  hit.className = 'opm-cine-hit';
  hit.hidden = true;
  hit.dataset.hit = '';
  hit.setAttribute('aria-label', 'Revenir au launcher');
  const hitLabel = document.createElement('span');
  hitLabel.className = 'opm-cine-hit__label';
  hit.appendChild(hitLabel);
  document.body.appendChild(hit);
  hit.addEventListener('click', () => cine?.onAbort?.());

  const PHASE_LABEL = {
    check: 'Vérification',
    download: 'Téléchargement',
    extract: 'Extraction',
    patch: 'Préparation',
    launching: 'Ouverture',
  };
  let labelText = '';
  function updateLabel(game) {
    const name = PHASE_LABEL[game?.state] ?? 'Préparation';
    const pct = game && (game.state === 'check' || game.state === 'download') ? ` ${Math.floor((game.ratio ?? 0) * 100)} %` : '…';
    const text = `${name}${pct}`;
    if (text === labelText) return;
    labelText = text;
    hitLabel.innerHTML = '';
    hitLabel.append(text);
    const small = document.createElement('small');
    small.textContent = 'cliquer pour revenir';
    hitLabel.appendChild(small);
  }

  /** L'anneau de la préparation : rempli selon l'avancement, ou un arc qui tourne. */
  function drawRing(cx, cy, t, game, col, corrupted) {
    const R = 14;
    const N = 44;
    const known = game && (game.state === 'check' || game.state === 'download');
    const frac = known ? Math.min(1, Math.max(0, game.ratio ?? 0)) : 0;
    const head = Math.floor(t * 18) % N;
    for (let i = 0; i < N; i += 1) {
      const a = -Math.PI / 2 + (i / N) * Math.PI * 2;
      let r = R;
      if (corrupted && Math.random() < 0.08) r += Math.random() < 0.5 ? -1 : 1;
      const x = Math.round(cx + Math.cos(a) * r);
      const y = Math.round(cy + Math.sin(a) * r);
      const lit = known ? i / N < frac : (i - head + N) % N < 9;
      fxCtx.fillStyle = lit ? (i % 4 === 0 ? col.core : col.glow) : col.deep;
      fxCtx.fillRect(x, y, 1, 1);
    }
  }

  /* -------------------------------------------------- la cinématique */

  /**
   * Commence la cinématique, au clic sur JOUER : elle quitte le cadre, vole
   * devant lui, recueille le launcher qui rétrécit en orbe ; le joueur se
   * défait en pixels et s'y engouffre. Puis elle attend, l'orbe entre les
   * mains, que la préparation soit finie (`release`).
   *
   * Résolue à `true` quand le passage est ouvert et le launcher parti ; à
   * `false` si le launcher revient avant (`comeBack`).
   *
   * @param {any} sfx  components/sfx.js
   * @param {{progress?: () => any, onAbort?: () => void, onFlash?: () => void}} [options]
   *   `progress` : l'avancement de la préparation (store.game) ; `onAbort` : le
   *   joueur a cliqué l'orbe pour revenir ; `onFlash` : le passage s'ouvre (l'éclair).
   */
  function begin(sfx, { progress = null, onAbort = null, onFlash = null } = {}) {
    if (cine) return cine.promise;
    if (sfx) sfxRef = sfx;
    if (reduced || !frameBox) return Promise.resolve(true);
    clearTimeout(fitTimer);
    if (arr) finishArrival();
    if (wave) endWave();
    const lean = transformNow();
    const leanMap = sampleMap(anims[etat], time % anims[etat].length, reach);
    const { to, point } = frontPlacement(lean);
    const corrupted = etat === 'corrompue';
    const savedMask = stage.style.maskImage;
    fxResize();
    fx.style.opacity = '1';
    stage.style.maskImage = edgeMask();
    sfx?.play('servo');
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    cine = {
      start: performance.now(), lean, leanMap, to, point, corrupted, savedMask, resolve, promise,
      cues: new Set(), sfx, progress, onAbort, onFlash, released: false, readyAt: 0, dissolveAt: 0.8,
    };
    hit.style.left = `${point.x + stage.getBoundingClientRect().left}px`;
    hit.style.top = `${point.y + stage.getBoundingClientRect().top}px`;
    return promise;
  }

  /** La préparation est finie, le jeu démarre : le passage s'ouvre. */
  function release() {
    if (!cine || cine.released) return;
    cine.released = true;
    cine.readyAt = (performance.now() - cine.start) / 1000;
    hit.hidden = true;
  }

  /** Les deux d'un coup : le jeu démarre déjà. */
  function launch(sfx) {
    const p = begin(sfx);
    release();
    return p;
  }

  /** L'orbe est formé à cet instant ; le passage ne s'ouvre pas avant. */
  const ORB_READY = 2.9;

  function cineFrame() {
    const c$ = cine;
    const t = (performance.now() - c$.start) / 1000;
    const u = c$.released ? Math.max(ORB_READY, c$.readyAt) : Infinity;
    const cue = (name, at, fn) => {
      if (t >= at && !c$.cues.has(name)) {
        c$.cues.add(name);
        fn();
      }
    };

    // Les assistants s'éclipsent.
    const shrinkBots = 1 - segment(t, 0, 0.35);
    for (const bot of bots) bot.holder.visible = shrinkBots > 0.02;

    // Poses : penchée → vol → coupe (elle attend là) → bras ouverts.
    const fly = sampleMap(cineAnims.fly, t);
    const cradle = sampleMap(cineAnims.cradle, t);
    if (t < 0.4) poseBlend(c$.leanMap, fly, ease(segment(t, 0, 0.4)));
    else if (t < 1.75) poseBlend(fly, cradle, ease(segment(t, 1.3, 1.75)));
    else if (t < u) poseBlend(cradle, cradle, 0);
    else poseBlend(cradle, sampleMap(cineAnims.unveil, t), ease(segment(t, u, u + 0.4)));

    // Le vol : de sa place derrière le cadre jusque devant lui.
    applyTransform(c$.lean, c$.to, ease(segment(t, 0.3, 1.5)));
    // L'attente : elle flotte, l'orbe entre les mains.
    if (t > 1.5 && t < u) tilt.position.y += Math.sin((t - 1.5) * 1.6) * 0.25;
    if (c$.corrupted && t < u + 0.6 && Math.random() < 0.18) {
      tilt.position.x += (Math.random() - 0.5) * 1.6;
      tilt.position.y += (Math.random() - 0.5) * 1.2;
    }

    cue('whoosh', 0.35, () => c$.sfx?.play('whoosh'));
    cue('dissolve', c$.dissolveAt, () => dissolvePlayer(c$));
    cue('shrink', 1.6, () => {
      c$.sfx?.play('shrink');
      const fr = frame.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      const dx = c$.point.x + sr.left - (fr.left + fr.width / 2);
      const dy = c$.point.y + sr.top - (fr.top + fr.height / 2);
      frame.style.transition = 'transform 1.3s cubic-bezier(.7,0,.3,1), opacity .45s ease .95s, filter 1.3s ease';
      frame.style.transform = `translate(${dx}px, ${dy}px) scale(0.02)`;
      frame.style.filter = c$.corrupted ? 'brightness(1.4) hue-rotate(-20deg) saturate(1.8)' : 'brightness(1.8) saturate(1.3)';
      frame.style.opacity = '0';
      for (const s of surroundCanvases()) {
        s.style.transition = 'opacity 1s ease';
        s.style.opacity = '0';
      }
    });
    cue('portal', u + 0.1, () => c$.sfx?.play('portal', { etat: c$.corrupted ? 'corrompue' : 'creatrice' }));
    // Au plus fort de l'éclair : la scène de chargement peut paraître dessous.
    cue('flashpeak', u + 0.45, () => c$.onFlash?.());
    cue('fade', u + 1.0, () => {
      stage.style.transition = 'opacity .6s ease';
      stage.style.opacity = '0';
    });

    // L'attente : l'anneau, l'étiquette, et l'orbe qu'on peut cliquer.
    const waiting = t >= ORB_READY && !c$.released;
    if (waiting && hit.hidden) hit.hidden = false;
    const game = c$.progress?.() ?? null;
    if (waiting) updateLabel(game);

    // Les effets.
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    const col = FX[c$.corrupted ? 'corrompue' : 'creatrice'];
    const cx = c$.point.x / FX_P;
    const cy = c$.point.y / FX_P;
    drawParticles(c$, t);
    if (t >= 1.6 && t < u + 0.2) {
      let r = 1.5 + 8 * ease(segment(t, 1.6, ORB_READY));
      if (t > ORB_READY) r += 0.8 * Math.sin((t - ORB_READY) * 4);
      const flicker = c$.corrupted ? (Math.random() < 0.2 ? 0.3 : 1) : 0.85 + 0.15 * Math.sin(t * 20);
      drawOrb(cx, cy, r, col, flicker);
    }
    if (waiting) drawRing(cx, cy, t, game, col, c$.corrupted);
    if (t >= u + 0.1) drawPortal(t - (u + 0.1), cx, cy, c$.corrupted ? 'corrompue' : 'creatrice');
    if (t >= u + 0.35 && t < u + 1.6) {
      // Un éclair qui couvre la fin : le monde s'ouvre.
      const k = 1 - segment(t, u + 0.45, u + 1.6);
      const a = (t < u + 0.45 ? segment(t, u + 0.35, u + 0.45) : k) * (c$.corrupted && Math.random() < 0.3 ? 0.4 : 0.85);
      fxCtx.fillStyle = `rgba(${col.flash}, ${a.toFixed(3)})`;
      fxCtx.fillRect(0, 0, fx.width, fx.height);
    }

    if (t >= u + 1.6 && !c$.cues.has('done')) {
      c$.cues.add('done');
      fx.style.opacity = '0';
      c$.resolve(true);
    }
  }

  /**
   * Le launcher revient — après une partie, après un échec, ou parce que le
   * joueur a cliqué l'orbe : tout est remis en place, sans transition, le
   * cadre se reconstruit, puis Xenodys arrive à nouveau.
   */
  function comeBack(sfx) {
    if (sfx) sfxRef = sfx;
    if (!cine) return;
    const c$ = cine;
    cine = null;
    c$.resolve(false);
    hit.hidden = true;
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    fx.style.opacity = '0';
    applyTransform(c$.lean, c$.lean, 0);
    frame.style.transition = 'none';
    frame.style.transform = '';
    frame.style.filter = '';
    frame.style.opacity = '';
    for (const s of surroundCanvases()) {
      s.style.transition = 'none';
      s.style.opacity = '';
    }
    stage.style.transition = 'none';
    stage.style.opacity = '0';
    stage.style.maskImage = c$.savedMask;
    revealPlayer();
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
    if (cine || !frameBox || !home) return Promise.resolve();
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
      poseBlend(sampleMap(cineAnims.fly, t), sampleMap(anim, at, extra), ease(segment(t, 0.5, 1.4)));
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
      pose(xen.bones, anim, at, extra);
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
    if (cine || arr) {
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
    if ('emissiveIntensity' in xenSkin.material) xenSkin.material.emissiveIntensity = look.glow;
    return [look.pitch + jitter[1], look.yaw + jitter[0], 0];
  }

  function blinkStep(dt) {
    if (blinkLeft > 0) {
      blinkLeft -= dt;
      if (blinkLeft <= 0) xenSkin.setBlink(false);
      return;
    }
    blinkIn -= dt;
    if (blinkIn > 0) return;
    xenSkin.setBlink(true);
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
    if (reduced || cine || arr || !frameBox) {
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
      const base = botAnims[bot.role];
      pose(bot.bones, base, bot.time % base.length);
      if (placing || bot.role !== 'idle' || reduced) continue;
      if (!bot.wave) {
        bot.nextWave -= dt;
        if (bot.nextWave <= 0) bot.wave = { t: 0 };
      } else {
        bot.wave.t += dt;
        const w = botAnims.wave;
        for (const [name, channels] of Object.entries(w.bones)) {
          const bone = bot.bones.get(name);
          if (!bone || !channels.rotation) continue;
          const r = sample(channels.rotation, bot.wave.t);
          bone.group.rotation.x += -r[0] * DEG;
          bone.group.rotation.y += -r[1] * DEG;
          bone.group.rotation.z += r[2] * DEG;
        }
        if (bot.wave.t >= w.length) {
          bot.wave = null;
          bot.nextWave = 14 + Math.random() * 20;
        }
      }
    }
  }

  const applySkin = () => {
    xenSkin.setEtat(etat);
    botSkin.setEtat(etat);
    stage.dataset.etat = etat;
  };
  applySkin();
  fit();
  // Rien ne se voit avant son arrivée (`arrive`, après la construction du cadre).
  hideForArrival();

  viewer.animation = new lib.FunctionAnimation((_player, _progress, delta) => {
    const dt = reduced ? 0 : Math.min(0.1, Math.max(0, delta || 0));
    time += dt;
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
    poseXen(time % anims[etat].length, false, lookStep(dt));
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
      if (arr) {
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
    comeBack,
    arrive,
    attend,
    react,
    shift,
    /** Une cinématique est-elle en cours (ou le launcher encore « parti ») ? */
    get busy() {
      return cine !== null;
    },
    /** La préparation est-elle finie (le passage s'ouvre) ? */
    get released() {
      return cine?.released ?? false;
    },
    dispose() {
      fx.remove();
      hit.remove();
      clearTimeout(fitTimer);
      observer.disconnect();
      sizer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      xenSkin.dispose();
      botSkin.dispose();
      viewer.dispose();
    },
  };
}
