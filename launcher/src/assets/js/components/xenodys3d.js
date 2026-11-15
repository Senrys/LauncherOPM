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
 */

import { ANIMATIONS, ASSISTANT_ANIMATIONS, ASSISTANT_GEO, GEO } from '../data/xenodys-model.js';

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
  async function skinned(name) {
    const skins = {};
    for (const etat of ['creatrice', 'corrompue']) {
      const [map, glow] = await Promise.all([
        load(`assets/xenodys/${name}_${etat}.png`),
        load(`assets/xenodys/${name}_${etat}_glowmask.png`),
      ]);
      skins[etat] = { map, glow };
    }
    const material = new T.Material({ map: skins.creatrice.map, alphaTest: 0.5 });
    if ('emissiveMap' in material) {
      material.emissiveMap = skins.creatrice.glow;
      material.emissive?.set?.(0xffffff);
      material.emissiveIntensity = 1;
    }
    const setEtat = (etat) => {
      material.map = skins[etat].map;
      if ('emissiveMap' in material) material.emissiveMap = skins[etat].glow;
      material.needsUpdate = true;
    };
    const dispose = () => {
      for (const sk of Object.values(skins)) {
        sk.map.dispose();
        sk.glow.dispose();
      }
      material.dispose();
    };
    return { material, setEtat, dispose };
  }

  const xenSkin = await skinned('xenodys');
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
  function poseXen(t, reface = false) {
    pose(xen.bones, anims[etat], t, reach);
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

    solveArm('arm_left', () => {
      const b = boxOf(handL);
      return { x: b.minX, y: (b.minY + b.maxY) / 2 };
    }, { x: edge - GRIP, y: frameBox.y + frameBox.h * 0.45 });

    solveArm('arm_right', () => {
      const b = boxOf(handR);
      return { x: (b.minX + b.maxX) / 2, y: b.maxY };
    }, { x: edge - 46, y: frameBox.y + 30 });
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
    mask(renderHands());
  }

  /**
   * La silhouette exacte de ses mains : un rendu où tout le reste est caché.
   * C'est elle, et non un rectangle, qui perce le masque sur le cadre.
   */
  function renderHands() {
    const hidden = [];
    const keep = new Set([...handL, ...handR]);
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
    g.drawImage(hands, 0, 0);
    g.restore();
    stage.style.maskImage = `url(${c.toDataURL('image/png')})`;
    stage.style.maskSize = '100% 100%';
    stage.style.maskRepeat = 'no-repeat';
  }

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let fitTimer = 0;

  /* ---------------------------------------------------- la cinématique */

  // Au lancement du jeu : elle lâche le cadre, vole devant lui, nous tourne
  // le dos, recueille le launcher qui rétrécit entre ses mains jusqu'à n'être
  // plus qu'un orbe, puis ouvre grand les bras — le passage vers le monde
  // s'ouvre (lumière cyan, ou déchirure rouge et violette si elle est
  // corrompue). Au retour du jeu, le launcher réapparaît.
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

  /**
   * Joue la cinématique. Résolue quand le launcher a disparu et que le passage
   * est ouvert (environ 4,6 s). `sfx` : components/sfx.js, facultatif.
   */
  function launch(sfx) {
    if (cine || reduced || !frameBox) return Promise.resolve();
    clearTimeout(fitTimer);
    const lean = transformNow();
    const leanMap = sampleMap(anims[etat], time % anims[etat].length, reach);
    const { to, point } = frontPlacement(lean);
    const corrupted = etat === 'corrompue';
    const savedMask = stage.style.maskImage;
    handQuats.clear();
    fxResize();
    fx.style.opacity = '1';
    stage.style.maskImage = edgeMask();
    sfx?.play('servo');
    return new Promise((resolve) => {
      cine = { start: performance.now(), lean, leanMap, to, point, corrupted, savedMask, resolve, cues: new Set(), sfx };
    });
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
    for (const bot of bots) bot.holder.visible = shrinkBots > 0.02;

    // Poses : penchée → vol → coupe → bras ouverts.
    const fly = sampleMap(cineAnims.fly, t);
    const cradle = sampleMap(cineAnims.cradle, t);
    const unveil = sampleMap(cineAnims.unveil, t);
    if (t < 0.4) poseBlend(c$.leanMap, fly, ease(segment(t, 0, 0.4)));
    else if (t < 1.75) poseBlend(fly, cradle, ease(segment(t, 1.3, 1.75)));
    else poseBlend(cradle, unveil, ease(segment(t, 2.9, 3.3)));

    // Le vol : de sa place derrière le cadre jusque devant lui.
    applyTransform(c$.lean, c$.to, ease(segment(t, 0.3, 1.5)));
    if (c$.corrupted && t < 3.6 && Math.random() < 0.18) {
      tilt.position.x += (Math.random() - 0.5) * 1.6;
      tilt.position.y += (Math.random() - 0.5) * 1.2;
    }

    cue('whoosh', 0.35, () => c$.sfx?.play('whoosh'));
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
    cue('portal', 3.0, () => c$.sfx?.play('portal', { etat: c$.corrupted ? 'corrompue' : 'creatrice' }));
    cue('fade', 3.9, () => {
      stage.style.transition = 'opacity .7s ease';
      stage.style.opacity = '0';
    });

    // Les effets.
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    const col = FX[c$.corrupted ? 'corrompue' : 'creatrice'];
    const cx = c$.point.x / FX_P;
    const cy = c$.point.y / FX_P;
    if (t >= 1.6 && t < 3.2) {
      const r = 1.5 + 8 * ease(segment(t, 1.6, 2.9));
      const flicker = c$.corrupted ? (Math.random() < 0.2 ? 0.3 : 1) : 0.85 + 0.15 * Math.sin(t * 20);
      drawOrb(cx, cy, r, col, flicker);
    }
    if (t >= 3.0) drawPortal(t - 3.0, cx, cy, c$.corrupted ? 'corrompue' : 'creatrice');
    if (t >= 3.25 && t < 4.6) {
      // Un éclair qui couvre la fin : le monde s'ouvre.
      const k = 1 - segment(t, 3.35, 4.6);
      const a = (t < 3.35 ? segment(t, 3.25, 3.35) : k) * (c$.corrupted && Math.random() < 0.3 ? 0.4 : 0.85);
      fxCtx.fillStyle = `rgba(${col.flash}, ${a.toFixed(3)})`;
      fxCtx.fillRect(0, 0, fx.width, fx.height);
    }

    if (t >= 4.6 && !c$.cues.has('done')) {
      c$.cues.add('done');
      fx.style.opacity = '0';
      c$.resolve();
    }
  }

  /** Le launcher revient : le cadre regrandit depuis ses mains, Xenodys
   *  reprend sa place derrière lui et ses assistants aussi. */
  function comeBack(sfx) {
    if (!cine) return;
    const c$ = cine;
    cine = null;
    fxCtx.clearRect(0, 0, fx.width, fx.height);
    fx.style.opacity = '0';
    applyTransform(c$.lean, c$.lean, 0);
    for (const bot of bots) bot.holder.visible = true;
    sfx?.play('power');
    frame.style.transition = 'transform .9s cubic-bezier(.2,.8,.2,1), opacity .35s ease, filter .9s ease';
    frame.style.transform = '';
    frame.style.filter = '';
    frame.style.opacity = '';
    for (const s of surroundCanvases()) s.style.opacity = '';
    stage.style.transition = 'opacity 1.2s ease .5s';
    stage.style.opacity = '';
    setTimeout(() => {
      frame.style.transition = '';
      stage.style.transition = '';
      stage.style.maskImage = c$.savedMask;
      fit();
    }, 950);
  }

  /* ---------------------------------------------------------- vie */

  const applySkin = () => {
    xenSkin.setEtat(etat);
    botSkin.setEtat(etat);
    stage.dataset.etat = etat;
  };
  applySkin();
  fit();

  viewer.animation = new lib.FunctionAnimation((_player, _progress, delta) => {
    const dt = reduced ? 0 : Math.min(0.1, Math.max(0, delta || 0));
    time += dt;
    if (cine) {
      cineFrame();
      return;
    }
    poseXen(time % anims[etat].length);
    for (const bot of bots) {
      bot.time += dt;
      const base = botAnims[bot.role];
      pose(bot.bones, base, bot.time % base.length);
      if (bot.role === 'idle' && !reduced) {
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

  stage.dataset.ready = '';


  return {
    viewer,
    bones: xen.bones,
    holder,
    bots,
    launch,
    comeBack,
    /** Une cinématique est-elle en cours (ou le launcher encore « parti ») ? */
    get busy() {
      return cine !== null;
    },
    dispose() {
      fx.remove();
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
