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
 * cadre, elle se penche vers lui, regarde le joueur, et sa main droite
 * agrippe le bord du launcher — ses doigts seuls passent devant (masque de la
 * scène). Corrompue : `corrupted_lean`, et la texture rouge et violette. Le
 * passage d'un état à l'autre suit `<html data-xenodys>`.
 */

import { ANIMATIONS, GEO } from '../data/xenodys-model.js';

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
function buildModel(T, material) {
  const geo = GEO['minecraft:geometry'][0];
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

function compile(name) {
  const def = ANIMATIONS.animations[`animation.xenodys.${name}`];
  const bones = {};
  for (const [bone, channels] of Object.entries(def.bones)) {
    bones[bone] = {};
    for (const [kind, channel] of Object.entries(channels)) bones[bone][kind] = track(channel);
  }
  return { length: def.animation_length, loop: def.loop === true, bones };
}

/* ------------------------------------------------------------------ scène */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} stage  le conteneur (toute la fenêtre)
 * @param {HTMLElement} frame  le cadre du launcher : elle se tient derrière, à sa droite
 * @returns {Promise<{dispose: () => void}>}
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
  // Rendu à un pixel CSS par pixel, agrandi sans lissage (frame.css) : le
  // grain cubique du jeu, et moitié moins de travail pour la carte graphique.
  viewer.pixelRatio = 1;
  if (viewer.controls) {
    viewer.controls.enabled = false;
  }

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
  // Un peu moins de lumière ambiante que pour le joueur : ses plaques claires
  // gardent leur relief, et ce qui brille (glowmask) ressort.
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

  const skins = {};
  for (const etat of ['creatrice', 'corrompue']) {
    const [map, glow] = await Promise.all([
      load(`assets/xenodys/xenodys_${etat}.png`),
      load(`assets/xenodys/xenodys_${etat}_glowmask.png`),
    ]);
    skins[etat] = { map, glow };
  }

  const material = new T.Material({ map: skins.creatrice.map, alphaTest: 0.5 });
  if ('emissiveMap' in material) {
    material.emissiveMap = skins.creatrice.glow;
    material.emissive?.set?.(0xffffff);
    material.emissiveIntensity = 1;
  }

  const { root, bones } = buildModel(T, material);
  // On la tourne de trois quarts : face à nous, un peu vers le launcher.
  const holder = new T.Group();
  holder.add(root);
  holder.rotation.y = Math.PI - 0.45;
  viewer.scene.add(holder);

  // Dans le launcher, elle joue le « penché » : derrière le cadre, la main
  // droite agrippée à son bord, le regard sur le joueur. (En jeu, GeckoLib
  // joue `idle` et `corrupted_idle`, du même fichier.)
  const anims = { creatrice: compile('lean'), corrompue: compile('corrupted_lean') };
  const root$ = document.documentElement;
  let etat = root$.dataset.xenodys === 'corrompue' ? 'corrompue' : 'creatrice';
  let time = 0;

  function pose(anim, t) {
    for (const bone of bones.values()) {
      bone.group.position.copy(bone.rest.position);
      bone.group.rotation.set(...bone.rest.rotation);
    }
    for (const [name, channels] of Object.entries(anim.bones)) {
      const bone = bones.get(name);
      if (!bone) continue;
      if (channels.rotation) {
        const r = sample(channels.rotation, t);
        bone.group.rotation.x += -r[0] * DEG;
        bone.group.rotation.y += -r[1] * DEG;
        bone.group.rotation.z += r[2] * DEG;
      }
      if (channels.position) {
        const q = sample(channels.position, t);
        bone.group.position.x += -q[0];
        bone.group.position.y += q[1];
        bone.group.position.z += q[2];
      }
    }
  }

  /* ---------------------------------------------- cadrage et masque */

  const V3 = holder.position.constructor;
  /** Les meshes de la main qui agrippe : ce sont eux qui passent devant le cadre. */
  const gripMeshes = [];
  bones.get('hand_right').group.traverse((o) => {
    if (o.isMesh) gripMeshes.push(o);
  });

  function project(W, H) {
    viewer.scene.updateMatrixWorld(true);
    viewer.camera.updateMatrixWorld();
    const toPx = (v) => {
      const q = v.clone().project(viewer.camera);
      return { x: ((q.x + 1) / 2) * W, y: ((1 - q.y) / 2) * H };
    };
    const boxOf = (meshes) => {
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
    };
    const all = [];
    holder.traverse((o) => {
      if (o.isMesh) all.push(o);
    });
    const origin = toPx(holder.position.clone());
    return {
      body: boxOf(all),
      hand: boxOf(gripMeshes),
      head: toPx(bones.get('head').group.getWorldPosition(new V3())),
      origin,
      unit: toPx(holder.position.clone().add(new V3(1, 0, 0))).x - origin.x,
    };
  }

  /** Recouvrement des doigts sur le cadre, en pixels. */
  const GRIP = 30;
  /** Fondus tramés vers les bords de la fenêtre, en pixels. */
  const FADE_RIGHT = 70;
  const FADE_BOTTOM = 150;
  let frameBox = null;

  /**
   * Taille et place. Elle s'élève derrière le launcher : sa main posée sur
   * le bord droit du cadre, sa tête dans la marge, le haut de son halo sous le
   * haut de la fenêtre — et le reste aussi grand que cela le permet, quitte à
   * ce que le bas de son corps se perde dans le fondu du bas de la fenêtre.
   * On mesure la silhouette projetée, on corrige, on recommence (la
   * perspective n'est pas tout à fait linéaire).
   */
  function fit() {
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    if (!W || !H) return;
    const sr = stage.getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    frameBox = { x: fr.left - sr.left, y: fr.top - sr.top, w: fr.width, h: fr.height };
    const edge = frameBox.x + frameBox.w;
    const gripX = edge - GRIP;

    pose(anims[etat], 0);
    holder.scale.setScalar(MODEL_SCALE);
    holder.position.set(0, -54 * MODEL_SCALE, 0);
    for (let pass = 0; pass < 6; pass += 1) {
      const m = project(W, H);
      const hx = m.hand.minX;
      const hy = (m.hand.minY + m.hand.maxY) / 2;
      // La main au plus bas à 45 % du cadre ; le halo sous le haut de la fenêtre.
      const gripY = Math.min(frameBox.y + frameBox.h * 0.45, 12 + (hy - m.body.minY) * 1e3);
      const ks = [
        (frameBox.y + frameBox.h * 0.45 - 12) / Math.max(1, hy - m.body.minY),
        (W - FADE_RIGHT - 40 - gripX) / Math.max(1, m.head.x - hx),
      ];
      const k = Math.min(...ks);
      const scaled = (a, o) => o + k * (a - o);
      const targetY = 12 + k * (hy - m.body.minY);
      const dx = gripX - scaled(hx, m.origin.x);
      const dy = Math.min(gripY, targetY) - scaled(hy, m.origin.y);
      holder.scale.multiplyScalar(k);
      holder.position.x += dx / m.unit;
      holder.position.y -= dy / m.unit;
      if (Math.abs(k - 1) < 0.005 && Math.abs(dx) < 1 && Math.abs(dy) < 1) break;
    }
    mask(W, H, project(W, H).hand);
  }

  /**
   * Le masque de la scène. Elle est visible partout, SAUF :
   *   - sur le cadre — elle est derrière lui —, à l'exception d'un rectangle
   *     autour de ses doigts, qui passent devant son bord ;
   *   - vers le bord droit et le bas de la fenêtre, où elle se dissout en
   *     trame de gros pixels : jamais de coupure nette contre le bureau.
   */
  function mask(W, H, hand) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(W);
    c.height = Math.ceil(H);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
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
    g.clearRect(frameBox.x, frameBox.y, frameBox.w, frameBox.h);
    const pad = 14; // l'animation fait un peu bouger la main
    g.fillRect(hand.minX - pad, hand.minY - pad, frameBox.x + frameBox.w - (hand.minX - pad), hand.maxY - hand.minY + pad * 2);
    stage.style.maskImage = `url(${c.toDataURL('image/png')})`;
    stage.style.maskSize = '100% 100%';
    stage.style.maskRepeat = 'no-repeat';
  }

  /* ---------------------------------------------------------- vie */

  const applySkin = () => {
    material.map = skins[etat].map;
    if ('emissiveMap' in material) material.emissiveMap = skins[etat].glow;
    material.needsUpdate = true;
    stage.dataset.etat = etat;
  };
  applySkin();
  fit();

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  viewer.animation = new lib.FunctionAnimation((_player, _progress, delta) => {
    time += reduced ? 0 : Math.min(0.1, Math.max(0, delta || 0));
    const anim = anims[etat];
    pose(anim, time % anim.length);
  });

  const observer = new MutationObserver(() => {
    const next = root$.dataset.xenodys === 'corrompue' ? 'corrompue' : 'creatrice';
    if (next === etat) return;
    etat = next;
    applySkin();
  });
  observer.observe(root$, { attributes: true, attributeFilter: ['data-xenodys'] });

  const sizer = new ResizeObserver(() => {
    const r = stage.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) viewer.setSize(r.width, r.height);
    fit();
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
    bones,
    holder,
    dispose() {
      observer.disconnect();
      sizer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const sk of Object.values(skins)) {
        sk.map.dispose();
        sk.glow.dispose();
      }
      material.dispose();
      viewer.dispose();
    },
  };
}
