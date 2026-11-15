/**
 * La scène de chargement du launcher (fenêtre ouverte, mod OPM présent).
 *
 * Après le passage de la cinématique, le launcher couvre l'écran pendant que
 * le jeu charge ses mods. La scène est en **vraie 3D**, à la résolution de
 * l'écran (Three.js, par skinview3d) : Xenodys façonne un monde de blocs entre
 * ses mains ; sur le circuit, un joueur s'imprime (un skin de la galerie), se
 * change en orbe ; elle vole jusqu'à lui, le saisit, le rapporte dans le monde.
 * Ses mains visent ce qu'elles touchent (cinématique inverse des bras), sa tête
 * regarde ce qu'elle fait. Deux assistants : l'un au circuit, l'autre en ronde,
 * qui trébuche parfois.
 *
 * C'est le portage exact de la chorégraphie du mod (mod/…/client/Choreo.java),
 * réglée sur la même horloge (`scene_debut`, transmise au jeu par
 * opm/session.json) : quand l'écran de chargement du jeu prend le relais
 * (`[OPM:READY]`), la scène continue sans saut.
 *
 * Derrière, la salle de simulation (components/lab.js, pixel art voulu) ;
 * devant, le bandeau, la barre et son étape (police pixel, data/sprites.js).
 */

import { SPRITES } from '../data/sprites.js';
import { ANIMATIONS, ASSISTANT_ANIMATIONS, ASSISTANT_GEO } from '../data/xenodys-model.js';
import { BLOC_GEO, JOUEUR_FIN_GEO, JOUEUR_GEO, SOCLE_GEO } from '../data/scene-models.js';
import { createLab } from './lab.js';
import { buildModel, compile, pose } from './xenodys3d.js';

const NEAREST = 1003;
const DEG = Math.PI / 180;
const CYCLE = 10;
const FOV = 12;
const PITCH = 8;
const VIEW = 150;
const TARGET = [0, 64, 0];
const DIST = VIEW / 2 / Math.tan((FOV / 2) * DEG);
const N = 4;
const BLOCK = 7;
const PLAYER = 1.5;
const BOT = 1.4;

const COLORS = {
  creatrice: { accent: '#91D9D1', core: '#E9FFFC' },
  corrompue: { accent: '#F0506E', core: '#FFD3DD' },
};

const ease = (k) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
};
const seg = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));
const damp = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);

/** Hasard reproductible — le même que Choreo.hash (Java). */
function hash(n) {
  let h = (Math.imul(n, 374761393) + 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** La ronde de l'assistant — le même calcul que Choreo.walker. */
function walker(t, wv) {
  const window = 9;
  const idx = Math.floor(t / window);
  let paused = 0;
  for (let i = 0; i < idx; i += 1) if (hash(i * 7 + 3) < 0.45) paused += 2.3;
  const local = t - idx * window;
  let fall = -1;
  if (hash(idx * 7 + 3) < 0.45) {
    if (local >= 3 && local < 5.3) fall = local - 3;
    if (local >= 5.3) paused += 2.3;
    else if (local >= 3) paused += local - 3;
  }
  const walk = t - paused;
  const xEnter = 0.62 * wv;
  const xb = 0.4 * wv;
  const xa = 0.16 * wv;
  const enterTime = (xEnter - xb) / 26;
  if (walk < enterTime) return { x: xEnter - walk * 26, dir: -1, walk, fall };
  const span = xb - xa;
  const q = ((walk - enterTime) * 14) % (2 * span);
  return q < span ? { x: xb - q, dir: -1, walk, fall } : { x: xa + (q - span), dir: 1, walk, fall };
}

/* ------------------------------------------------------------------ 2D */

const images = new Map();
function image(src) {
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = src;
    images.set(src, img);
  }
  return img;
}

/* ------------------------------------------------------------------ 3D */

function createScene3D(canvas) {
  const lib = window.skinview3d;
  if (!lib) return null;
  const viewer = new lib.SkinViewer({ canvas, width: 2, height: 2 });
  viewer.fov = FOV;
  viewer.pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  if (viewer.controls) viewer.controls.enabled = false;
  const blank = document.createElement('canvas');
  blank.width = 64;
  blank.height = 64;
  viewer.loadSkin(blank);
  const sample = viewer.playerObject.skin.head.innerLayer;
  const T = {
    Mesh: sample.constructor,
    Box: sample.geometry.constructor,
    Material: sample.material.constructor,
    Texture: viewer.skinTexture.constructor,
    Group: Object.getPrototypeOf(lib.BodyPart.prototype).constructor,
    V3: viewer.camera.position.constructor,
  };
  viewer.playerObject.visible = false;
  viewer.camera.near = 60;
  viewer.camera.far = 4000;
  if (viewer.globalLight) viewer.globalLight.intensity *= 0.9;

  const textures = new Map();
  const texture = (src) => {
    let t = textures.get(src);
    if (!t) {
      t = new T.Texture(image(src));
      t.magFilter = NEAREST;
      t.minFilter = NEAREST;
      t.generateMipmaps = false;
      const img = image(src);
      if (img.complete) t.needsUpdate = true;
      else img.addEventListener('load', () => (t.needsUpdate = true), { once: true });
      textures.set(src, t);
    }
    return t;
  };
  const material = (map, glow) => {
    const m = new T.Material({ map: texture(map), alphaTest: 0.5, transparent: true });
    if (glow && 'emissiveMap' in m) {
      m.emissiveMap = texture(glow);
      m.emissive?.set?.(0xffffff);
      m.emissiveIntensity = 1;
    }
    return m;
  };
  const STILL = { bones: {}, length: 1, loop: false };

  const mats = {};
  const matsFor = (etat) => {
    if (!mats[etat]) {
      mats[etat] = {
        xen: material(`assets/xenodys/xenodys_${etat}.png`, `assets/xenodys/xenodys_${etat}_glowmask.png`),
        xenBlink: material(`assets/xenodys/xenodys_${etat}_blink.png`, `assets/xenodys/xenodys_${etat}_blink_glowmask.png`),
        bot: material(`assets/xenodys/xenodys_assistant_${etat}.png`, `assets/xenodys/xenodys_assistant_${etat}_glowmask.png`),
        socle: material(`assets/xenodys/socle_${etat}.png`, `assets/xenodys/socle_${etat}_glowmask.png`),
        bloc: material(`assets/xenodys/bloc_${etat}.png`, `assets/xenodys/bloc_${etat}_glowmask.png`),
        orbe: material(`assets/xenodys/orbe_${etat}.png`, `assets/xenodys/orbe_${etat}_glowmask.png`),
      };
    }
    return mats[etat];
  };
  let etatNow = 'creatrice';
  const m0 = matsFor(etatNow);

  const holder = (child) => {
    const g = new T.Group();
    g.add(child.root);
    viewer.scene.add(g);
    return g;
  };
  const xen = buildModel(T, m0.xen);
  // Xenodys a sa propre scène, dessinée la première : tout le reste (monde,
  // circuit, joueurs, assistants, orbe) passe toujours devant elle.
  const xenScene = new viewer.scene.constructor();
  const xenHolder = new T.Group();
  xenHolder.add(xen.root);
  xenScene.add(xenHolder);
  // Les mêmes lumières que la scène principale (copiées, réglages compris).
  const xenAmbient = viewer.globalLight ? viewer.globalLight.clone() : null;
  const xenLight = viewer.cameraLight ? viewer.cameraLight.clone() : null;
  if (xenAmbient) xenScene.add(xenAmbient);
  if (xenLight) xenScene.add(xenLight);
  xenHolder.rotation.order = 'YXZ';
  const anims = { idle: compile('idle'), corrupted_idle: compile('corrupted_idle'), fly: compile('fly') };
  const botAnims = {
    idle: compile('idle', ASSISTANT_ANIMATIONS, 'animation.xenodys_assistant'),
    wave: compile('wave', ASSISTANT_ANIMATIONS, 'animation.xenodys_assistant'),
  };
  const worker = buildModel(T, m0.bot, ASSISTANT_GEO);
  const workerHolder = holder(worker);
  const walkerBot = buildModel(T, m0.bot, ASSISTANT_GEO);
  const walkerHolder = holder(walkerBot);
  walkerHolder.rotation.order = 'YXZ';
  const socle = buildModel(T, m0.socle, SOCLE_GEO);
  const socleHolder = holder(socle);
  const playerMat = material('assets/xenodys/bloc_creatrice.png', null);
  const players = { wide: buildModel(T, playerMat, JOUEUR_GEO), slim: buildModel(T, playerMat, JOUEUR_FIN_GEO) };
  const playerHolder = new T.Group();
  playerHolder.add(players.wide.root, players.slim.root);
  viewer.scene.add(playerHolder);
  const cube = new T.Group();
  cube.rotation.order = 'XYZ';
  viewer.scene.add(cube);
  const blocks = [];
  for (let k = 0; k < N; k += 1) {
    for (let s = 0; s <= 2 * (N - 1); s += 1) {
      for (let i = 0; i < N; i += 1) {
        const j = s - i;
        if (j < 0 || j >= N) continue;
        const b = buildModel(T, m0.bloc, BLOC_GEO);
        const g = new T.Group();
        g.add(b.root);
        g.position.set((i - 1.5) * BLOCK, (k - 1.5) * BLOCK, (j - 1.5) * BLOCK);
        g.visible = false;
        cube.add(g);
        blocks.push({ group: g, model: b, at: 0 });
      }
    }
  }
  const orb = buildModel(T, m0.orbe, BLOC_GEO);
  const orbHolder = holder(orb);
  const scan = buildModel(T, m0.bloc, BLOC_GEO);
  const scanHolder = holder(scan);

  const skins = [];
  const state = { solvedR: [0, 0, 0, 0], solvedL: [0, 0, 0, 0], curls: new Array(8).fill(0), armR: [0, 0, 0, 0], armL: [0, 0, 0, 0], handR: null, handL: null, headYaw: 0, headPitch: 0, bodyYaw: 180, shown: 0, lastT: -1 };

  function setEtat(etat) {
    if (etat === etatNow) return;
    etatNow = etat;
    const m = matsFor(etat);
    const swap = (model, mat) => model.root.traverse((o) => { if (o.material) o.material = mat; });
    swap(worker, m.bot);
    swap(walkerBot, m.bot);
    swap(socle, m.socle);
    for (const b of blocks) swap(b.model, m.bloc);
    swap(orb, m.orbe);
    swap(scan, m.bloc);
  }

  const addRot = (model, name, r) => {
    const bone = model.bones.get(name);
    if (!bone) return;
    bone.group.rotation.x += -r[0] * DEG;
    bone.group.rotation.y += -r[1] * DEG;
    bone.group.rotation.z += r[2] * DEG;
  };

  /** La main de Xenodys, en coordonnées du monde, pour des paramètres de bras donnés. */
  function handWith(side, base, a) {
    const arm = xen.bones.get(`arm_${side}`).group;
    const fore = xen.bones.get(`forearm_${side}`).group;
    arm.rotation.set(base.arm[0] - a[0] * DEG, base.arm[1] - a[1] * DEG, base.arm[2] + a[2] * DEG);
    fore.rotation.set(base.fore[0] - a[3] * DEG, base.fore[1], base.fore[2]);
    const hand = xen.bones.get(`hand_${side}`).group;
    hand.updateWorldMatrix(true, false);
    return hand.getWorldPosition(new T.V3());
  }

  /** Le portage de Choreo.solve : descente coordonnée, repartie de l'image précédente. */
  function solve(side, target, st) {
    const arm = xen.bones.get(`arm_${side}`).group;
    const fore = xen.bones.get(`forearm_${side}`).group;
    const base = { arm: [arm.rotation.x, arm.rotation.y, arm.rotation.z], fore: [fore.rotation.x, fore.rotation.y, fore.rotation.z] };
    const err = (a) => handWith(side, base, a).distanceToSquared(target) + 0.004 * (a[0] ** 2 + a[1] ** 2 + a[2] ** 2 + a[3] ** 2);
    let best = st.slice();
    let bestE = err(best);
    let step = 10;
    for (let it = 0; it < 6; it += 1) {
      for (let i = 0; i < 4; i += 1) {
        for (const sign of [-1, 1]) {
          const cand = best.slice();
          cand[i] = Math.max(-150, Math.min(150, cand[i] + sign * step));
          if (i === 3) cand[3] = Math.max(-140, Math.min(10, cand[3]));
          const e = err(cand);
          if (e < bestE) {
            bestE = e;
            best = cand;
          }
        }
      }
      step *= 0.6;
    }
    for (let i = 0; i < 4; i += 1) st[i] = best[i];
    return base;
  }

  function baseAt(H, P, c, active) {
    if (!active || c < 2.6 || c >= 7) return H.clone();
    if (c < 4.4) return H.clone().lerp(P, ease(seg(c, 2.6, 4.4)));
    if (c < 5) return P.clone();
    return P.clone().lerp(H, ease(seg(c, 5, 7)));
  }

  function render(width, height, t, ratio, etat, gallery) {
    const dt = state.lastT < 0 ? 0 : Math.max(0, Math.min(0.1, t - state.lastT));
    state.lastT = t;
    setEtat(etat);
    const corrupted = etat === 'corrompue';
    if (viewer.width !== width || viewer.height !== height) {
      viewer.width = width;
      viewer.height = height;
    }
    const aspect = width / Math.max(1, height);
    const cam = viewer.camera;
    cam.fov = FOV;
    cam.aspect = aspect;
    cam.position.set(TARGET[0], TARGET[1] + Math.sin(PITCH * DEG) * DIST, Math.cos(PITCH * DEG) * DIST);
    cam.lookAt(TARGET[0], TARGET[1], TARGET[2]);
    cam.updateProjectionMatrix();

    const wv = VIEW * aspect;
    const S = new T.V3(-0.3 * wv, 5 * PLAYER, 6);
    const H = new T.V3(0, 22, -34);
    const W = new T.V3(0, 72, -8);
    const P = new T.V3(S.x + 50, 30, -14);

    const n = gallery.length;
    const k = Math.floor(t / CYCLE);
    const c = t - k * CYCLE;
    const printed = n > 0 ? gallery[((k % n) + n) % n] : null;
    const active = Boolean(printed?.ready);

    // Xenodys : où elle est, et comment elle vole.
    let B = baseAt(H, P, c, active);
    const ahead = baseAt(H, P, c + 0.05, active);
    const vel = ahead.clone().sub(B).divideScalar(0.05);
    const travel = active ? Math.max(seg(c, 2.6, 3.2) * (1 - seg(c, 4.0, 4.4)), seg(c, 5.0, 5.5) * (1 - seg(c, 6.4, 7.0))) : 0;
    B.y += Math.sin(t * 1.3) * 1.5;
    state.bodyYaw = damp(state.bodyYaw, 180 + Math.max(-30, Math.min(30, vel.x * 0.6)), 3, dt);
    const leanX = Math.min(18, vel.length() * 0.35);
    const roll = Math.max(-16, Math.min(16, -vel.x * 0.25));
    xenHolder.position.copy(B);
    xenHolder.rotation.set(-leanX * DEG, state.bodyYaw * DEG, roll * DEG);

    const blink = Math.abs(((t + 5 * 0.37) % (3.5 + 5 * 0.4))) < 0.13;
    const m = matsFor(etat);
    const xmat = blink ? m.xenBlink : m.xen;
    xen.root.traverse((o) => { if (o.material && o.material !== xmat) o.material = xmat; });

    const extra = {};
    if (travel > 0.01) {
      const flap = Math.sin(t * 9) * 18 * travel;
      extra.wing_left = [0, flap, 0];
      extra.wing_right = [0, -flap, 0];
      extra.skirt_front = [-20 * travel, 0, 0];
    }
    const ph = t * 2.4;
    let held = false;
    let orbPos = null;
    let orbScale = 0;
    if (active) {
      const chest = S.clone().add(new T.V3(0, 20 * PLAYER, 0));
      const high = S.clone().add(new T.V3(0, 40 * PLAYER, 0));
      if (c >= 2.2 && c < 4.8) {
        orbScale = ease(seg(c, 2.2, 3.0));
        orbPos = chest.clone().lerp(high, ease(seg(c, 3.0, 3.6)));
        orbPos.y += Math.sin(t * 3) * 0.8;
      } else if (c >= 4.8 && c < 8.0) {
        held = true;
        orbScale = 1 - ease(seg(c, 7.6, 8.0));
      }
    }
    for (let f = 0; f < 4; f += 1) {
      // Courbure des doigts, lissée : du travail à la prise sans à-coup.
      const work = 22 * Math.max(0, Math.sin(ph * 2 + f));
      state.curls[f] = damp(state.curls[f], held ? 55 : active && c >= 3.6 && c < 4.8 ? -12 : work, 8, dt);
      state.curls[f + 4] = damp(state.curls[f + 4], 22 * Math.max(0, Math.sin(ph * 2 + f + 2)), 8, dt);
      const curlR = state.curls[f];
      const curlL = state.curls[f + 4];
      extra[`finger_right_${f}`] = [curlR, 0, 0];
      extra[`finger_right_${f}_tip`] = [curlR * 0.8, 0, 0];
      extra[`finger_left_${f}`] = [curlL, 0, 0];
      extra[`finger_left_${f}_tip`] = [curlL * 0.8, 0, 0];
    }
    pose(xen.bones, anims[corrupted ? 'corrupted_idle' : 'idle'], t, extra);

    // Ce qu'elle regarde.
    let look = W.clone();
    if (active) {
      if (c < 2.6) look = S.clone().add(new T.V3(0, 28 * PLAYER, 0));
      else if (c < 4.8 && orbPos) look = orbPos.clone();
    }
    xenHolder.updateMatrixWorld(true);
    const headWorld = xen.bones.get('head').group.getWorldPosition(new T.V3());
    const d = xenHolder.worldToLocal(look.clone()).sub(xenHolder.worldToLocal(headWorld.clone()));
    const wantYaw = Math.max(-60, Math.min(60, Math.atan2(d.x, -d.z) / DEG));
    const wantPitch = Math.max(-35, Math.min(45, Math.atan2(-d.y, Math.hypot(d.x, d.z)) / DEG));
    state.headYaw = damp(state.headYaw, wantYaw, 4, dt);
    state.headPitch = damp(state.headPitch, wantPitch, 4, dt);
    addRot(xen, 'head', [state.headPitch * 0.7, state.headYaw * 0.7, 0]);
    addRot(xen, 'neck', [state.headPitch * 0.3, state.headYaw * 0.3, 0]);

    // Ses mains : ce qu'elles visent.
    const shapeR = W.clone().add(new T.V3(-15 + 3 * Math.cos(ph), 2 + 3 * Math.sin(ph), 5));
    const shapeL = W.clone().add(new T.V3(15 + 3 * Math.cos(ph + Math.PI), 2 + 3 * Math.sin(ph + Math.PI), 5));
    let wantR = shapeR;
    let wantL = shapeL;
    if (active) {
      if (c >= 3.6 && c < 4.8 && orbPos) {
        wantR = orbPos.clone().add(new T.V3(0, 2, 2));
        wantL = B.clone().add(new T.V3(16, 44, 12));
      } else if (c >= 4.8 && c < 7.0) {
        wantR = B.clone().add(new T.V3(-8, 52, 18));
        wantL = B.clone().add(new T.V3(16, 44, 12));
      } else if (c >= 7.0 && c < 8.0) {
        wantR = W.clone().add(new T.V3(0, 8, 6));
      } else if (c >= 2.6 && c < 3.6) {
        wantR = B.clone().add(new T.V3(-14, 44, 14));
        wantL = B.clone().add(new T.V3(16, 44, 12));
      }
    }
    const k5 = 1 - Math.exp(-5 * dt);
    state.handR = state.handR ? state.handR.lerp(wantR, k5) : wantR.clone();
    state.handL = state.handL ? state.handL.lerp(wantL, k5) : wantL.clone();
    // La solution de l'IK, puis le bras qui la rejoint en douceur.
    const baseR = solve('right', state.handR, state.solvedR);
    const baseL = solve('left', state.handL, state.solvedL);
    for (let i = 0; i < 4; i += 1) {
      state.armR[i] = damp(state.armR[i], state.solvedR[i], 10, dt);
      state.armL[i] = damp(state.armL[i], state.solvedL[i], 10, dt);
    }
    handWith('right', baseR, state.armR);
    handWith('left', baseL, state.armL);

    // Le monde : un cube de blocs qui se construit.
    const inserted = n > 0 ? Math.min(8, k + (c >= 8 ? 1 : 0)) : 0;
    const want = Math.min(N * N * N, Math.floor(Math.max(0, Math.min(1, ratio)) * 56) + inserted);
    while (state.shown < want) blocks[state.shown++].at = t;
    cube.position.copy(W);
    cube.rotation.set(15 * DEG, t * 0.3, 0);
    blocks.forEach((b, i) => {
      b.group.visible = i < state.shown;
      const fresh = Math.max(0, 1 - (t - b.at) / 0.5);
      b.group.scale.setScalar((BLOCK / 16) * (1 + fresh * 0.35));
    });

    // Le circuit et le joueur imprimé.
    socleHolder.position.copy(S);
    socleHolder.rotation.y = 210 * DEG;
    socleHolder.scale.setScalar(PLAYER);
    let alpha = 0;
    let reveal = 0;
    if (active && c < 3) {
      reveal = ease(c / 1.8);
      alpha = reveal * (1 - seg(c, 2.6, 3.0));
    }
    playerHolder.visible = alpha > 0.01;
    if (playerHolder.visible) {
      const model = printed.slim ? players.slim : players.wide;
      players.slim.root.visible = printed.slim;
      players.wide.root.visible = !printed.slim;
      playerMat.map = printed.texture;
      playerMat.opacity = alpha;
      playerMat.needsUpdate = true;
      playerHolder.position.copy(S);
      playerHolder.rotation.y = 210 * DEG;
      playerHolder.scale.setScalar(PLAYER);
      const p2 = (t * 2 * Math.PI) / 2.7;
      pose(model.bones, STILL, 0, {
        head: [4 - 3 * Math.sin(p2 * 2), 14 * Math.sin(p2), 0],
        right_arm: [-5 * Math.sin(p2), 0, 3 + 2 * Math.sin(p2 * 2)],
        left_arm: [5 * Math.sin(p2), 0, -3 - 2 * Math.sin(p2 * 2)],
      });
    }
    scanHolder.visible = playerHolder.visible && reveal < 1;
    if (scanHolder.visible) {
      scanHolder.position.set(S.x, S.y + 33 * PLAYER * reveal, S.z);
      scanHolder.rotation.y = 210 * DEG;
      scanHolder.scale.set((22 * PLAYER) / 16, 0.4 / 16, (22 * PLAYER) / 16);
    }

    // L'orbe (à terre, ou dans sa main).
    if (held) {
      xenHolder.updateMatrixWorld(true);
      orbPos = xen.bones.get('hand_right').group.getWorldPosition(new T.V3()).add(new T.V3(0, -5, 3));
      if (c >= 7.4) orbPos.lerp(W.clone().add(new T.V3(0, 4, 0)), ease(seg(c, 7.4, 8.0)));
    }
    orbHolder.visible = Boolean(orbPos) && orbScale > 0.01;
    if (orbHolder.visible) {
      orbHolder.position.copy(orbPos);
      orbHolder.rotation.set(t * 1.3, t * 2, 0);
      orbHolder.scale.setScalar((6 / 16) * orbScale * (1 + Math.sin(t * 6) * 0.08));
    }

    // Les assistants.
    const phw = t * 2 * Math.PI;
    pose(worker.bones, botAnims.idle, t, {
      arm_left: [-80 + 25 * Math.sin(phw * 0.9), 0, -10],
      arm_right: [-80 + 25 * Math.sin(phw * 0.9 + Math.PI), 0, 10],
      head: [10, 0, 0],
    });
    workerHolder.position.set(S.x - 36, 0, 16);
    workerHolder.rotation.y = -90 * DEG;
    workerHolder.scale.setScalar(BOT);
    const w = walker(t, wv);
    let rootX = 0;
    const wExtra = {};
    if (w.fall >= 0) {
      const f = w.fall;
      const fk = f < 0.6 ? ease(f / 0.6) : f < 1.4 ? 1 : 1 - ease((f - 1.4) / 0.9);
      rootX = -88 * fk;
      wExtra.arm_left = [-140 * fk, 0, -20];
      wExtra.arm_right = [-140 * fk, 0, 20];
    } else {
      const s = Math.sin(w.walk * 2 * Math.PI * 1.2);
      Object.assign(wExtra, { leg_left: [35 * s, 0, 0], leg_right: [-35 * s, 0, 0], arm_left: [-30 * s, 0, 0], arm_right: [30 * s, 0, 0] });
    }
    pose(walkerBot.bones, botAnims.idle, t, wExtra);
    walkerHolder.position.set(w.x, 0, 18);
    walkerHolder.rotation.set(rootX * DEG, (w.dir > 0 ? -90 : 90) * DEG, 0);
    walkerHolder.scale.setScalar(BOT);

    // Deux passes : Xenodys, puis — profondeur effacée — tout le reste devant elle.
    const r = viewer.renderer;
    // skinview3d décale sa scène (et la caméra qui en fait partie) : celle de
    // Xenodys suit le même repère.
    xenScene.position.copy(viewer.scene.position);
    xenScene.quaternion.copy(viewer.scene.quaternion);
    xenScene.scale.copy(viewer.scene.scale);
    viewer.scene.updateMatrixWorld(true);
    xenScene.updateMatrixWorld(true);
    if (xenLight) xenLight.position.copy(cam.position);
    r.autoClear = false;
    r.clear();
    r.render(xenScene, cam);
    r.clearDepth();
    r.render(viewer.scene, cam);
  }

  return {
    render,
    /** Les skins de la galerie (data: URL), en textures. */
    setGallery(list) {
      skins.length = 0;
      for (const s of list) {
        const entry = { ready: false, slim: Boolean(s.slim), texture: null };
        skins.push(entry);
        if (!s.data) continue;
        const img = new Image();
        img.onload = () => {
          entry.texture = new T.Texture(img);
          entry.texture.magFilter = NEAREST;
          entry.texture.minFilter = NEAREST;
          entry.texture.generateMipmaps = false;
          entry.texture.needsUpdate = true;
          entry.ready = true;
        };
        img.src = s.data;
      }
    },
    skins,
    dispose() {
      viewer.dispose?.();
    },
  };
}

/**
 * @param {HTMLElement} host  conteneur plein écran (vide)
 * @param {{etat: () => string}} options
 */
export function createLoadingScene(host, { etat: etatOf }) {
  const labCanvas = document.createElement('canvas');
  labCanvas.className = 'opm-loading__lab';
  const glCanvas = document.createElement('canvas');
  glCanvas.className = 'opm-loading__3d';
  const canvas = document.createElement('canvas');
  canvas.className = 'opm-loading__scene';
  host.append(labCanvas, glCanvas, canvas);
  const ctx = canvas.getContext('2d');
  let lab = null;
  let scene3d = null;
  let pendingGallery = [];

  let raf = 0;
  let last = 0;
  let epoch = Date.now();
  let target = 0;
  let shownRatio = 0;
  let step = 'Éveil de la simulation';
  let creepCap = 0.12;

  const fill = (x0, y0, x1, y1, color, alpha = 1) => {
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.fillStyle = color;
    ctx.fillRect(Math.floor(x0), Math.floor(y0), Math.floor(x1) - Math.floor(x0), Math.floor(y1) - Math.floor(y0));
    ctx.globalAlpha = 1;
  };

  /* --------------------------------------------------------------- police */
  const font = { meta: SPRITES.police, img: image('assets/sprites/police.png') };
  const tinted = new Map();
  function fontTinted(color) {
    let c = tinted.get(color);
    if (c || !font.img.complete || !font.img.naturalWidth) return c;
    c = document.createElement('canvas');
    c.width = font.img.naturalWidth;
    c.height = font.img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(font.img, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    tinted.set(color, c);
    return c;
  }
  const norm = (text) => text.toLocaleUpperCase('fr-FR').replace(/Œ/g, 'E');
  function textWidth(text) {
    const { caracteres, avances } = font.meta.points;
    let w = 0;
    for (const ch of norm(text)) {
      const i = caracteres.indexOf(ch);
      w += i >= 0 ? avances[i] : 4;
    }
    return Math.max(0, w - 1);
  }
  function write(text, x, y, color, alpha = 1, scale = 1) {
    const src = fontTinted(color);
    if (!src) return;
    const { largeur: cw, hauteur: ch, points } = font.meta;
    const { caracteres, avances, colonnes } = points;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(Math.round(x), Math.round(y - 2 * scale));
    ctx.scale(scale, scale);
    let cx = 0;
    for (const c of norm(text)) {
      const i = caracteres.indexOf(c);
      if (i >= 0 && c !== ' ') ctx.drawImage(src, (i % colonnes) * cw, Math.floor(i / colonnes) * ch, cw, ch, cx, 0, cw, ch);
      cx += i >= 0 ? avances[i] : 4;
    }
    ctx.restore();
  }

  function render(dt) {
    const etat = etatOf() === 'corrompue' ? 'corrompue' : 'creatrice';
    const col = COLORS[etat];
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(host.clientWidth * dpr);
    const H = Math.round(host.clientHeight * dpr);
    const k = Math.max(1, Math.floor(H / 270));
    const vw = Math.ceil(W / k);
    const vh = Math.ceil(H / k);

    // La barre ne reste jamais figée : elle glisse vers la prochaine étape.
    creepCap = Math.max(creepCap, target);
    target = Math.min(creepCap - 0.01, target + dt * 0.004);
    shownRatio += (Math.max(target, shownRatio) - shownRatio) * Math.min(1, dt * 4);

    // La scène 3D, à la résolution de l'écran.
    const t = (Date.now() - epoch) / 1000;
    if (scene3d) scene3d.render(host.clientWidth, host.clientHeight, t, shownRatio, etat, scene3d.skins);

    // L'interface, en pixels virtuels (deux pixels de canevas par pixel virtuel).
    if (canvas.width !== vw * 2 || canvas.height !== vh * 2) {
      canvas.width = vw * 2;
      canvas.height = vh * 2;
    }
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, vw, vh);
    const banner = image(etat === 'corrompue' ? 'assets/sprites/bandeau_corrompue.png' : 'assets/images/bandeau-opm.png');
    if (banner.complete && banner.naturalWidth) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(banner, 12, 10, 120, Math.round((120 * banner.naturalHeight) / banner.naturalWidth));
      ctx.imageSmoothingEnabled = false;
    }
    const mx = vw * 0.5;
    const bw = Math.min(vw * 0.46, 240);
    const bx0 = mx - bw / 2;
    const by0 = vh - 16;
    fill(bx0 - 1, by0 - 1, bx0 + bw + 1, by0 + 5, '#000', 0.55);
    fill(bx0 - 1, by0 - 1, bx0 + bw + 1, by0, col.accent, 0.5);
    const segs = Math.floor(bw / 4);
    const lit = Math.floor(Math.max(0, Math.min(1, shownRatio)) * segs);
    for (let i = 0; i < lit; i += 1) {
      const x0 = Math.floor(bx0) + i * 4;
      fill(x0, by0 + 1, x0 + 3, by0 + 4, i === lit - 1 ? col.core : col.accent);
    }
    write(step, bx0, by0 - 11, col.core, 0.95);
    const pct = `${Math.round(Math.max(0, Math.min(1, shownRatio)) * 100)} %`;
    write(pct, bx0 + bw - textWidth(pct), by0 - 11, col.accent, 0.95);
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    render(dt);
  }

  return {
    /** Les skins à imprimer (galerie, en data: URL), et l'horloge partagée avec le jeu. */
    setGallery(list, sceneEpoch) {
      // Places vides comprises : l'index d'un skin est le même que dans le jeu.
      pendingGallery = (Array.isArray(list) ? list : []).map((s) => ({
        slim: Boolean(s?.slim),
        data: typeof s?.data === 'string' && s.data.startsWith('data:image/png') ? s.data : null,
      }));
      if (typeof sceneEpoch === 'number' && sceneEpoch > 0) epoch = sceneEpoch;
      scene3d?.setGallery(pendingGallery);
    },
    /** La scène apparaît (sous l'éclair du passage). */
    show() {
      if (raf) return;
      if (!lab) lab = createLab(labCanvas);
      if (!scene3d) {
        try {
          scene3d = createScene3D(glCanvas);
          scene3d?.setGallery(pendingGallery);
        } catch (err) {
          console.error('opm : scène 3D indisponible.', err);
        }
      }
      host.hidden = false;
      host.dataset.visible = '';
      last = 0;
      raf = requestAnimationFrame(loop);
    },
    /** Avancement (0 → part du launcher) et étape lue dans le journal du jeu. */
    progress(ratio, label) {
      if (typeof ratio === 'number' && ratio > target) target = ratio;
      // La glissade s'arrête juste avant la part du launcher : le mod reprend la
      // barre à cette valeur, elle ne doit jamais reculer.
      creepCap = Math.min(0.395, Math.max(creepCap, target + 0.06));
      if (label) step = label;
    },
    get visible() {
      return Boolean(raf);
    },
    /** L'écran du mod a pris le relais : la scène s'efface. */
    hide() {
      if (!raf) return Promise.resolve();
      delete host.dataset.visible;
      return new Promise((resolve) => {
        setTimeout(() => {
          cancelAnimationFrame(raf);
          raf = 0;
          host.hidden = true;
          lab?.dispose();
          lab = null;
          resolve();
        }, 450);
      });
    },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      lab?.dispose();
      scene3d?.dispose();
      host.replaceChildren();
    },
  };
}
