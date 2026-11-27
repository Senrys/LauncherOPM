/**
 * Le personnage du joueur en 3D, posé sur son socle.
 *
 * Il reste en place : exposé, tourné vers la droite, sur une carte de circuit
 * imprimé en voxels (components/socle.js). Il respire, simplement. Autour de
 * lui, les circuits de Xenodys se dessinent sur un calque à part (l'accueil :
 * components/circuits.js, comme dans la vidéo de fond). Socle et cartes prennent les
 * couleurs de Xenodys, créatrice ou corrompue (`<html data-xenodys>`).
 *
 * Le rendu est celui de skinview3d (déjà embarqué pour l'accueil). Le socle
 * est construit avec les classes Three.js que skinview3d
 * utilise déjà : on les récupère sur les objets du personnage plutôt que
 * d'embarquer Three.js une seconde fois.
 *
 * Quand Xenodys est corrompue, il n'est plus qu'un sujet d'expérience : un
 * grand bocal se referme sur lui, et il a peur — il tremble, se protège le
 * visage, jette des regards affolés.
 *
 * Le bocal descend sur lui quand Xenodys bascule, et remonte quand elle revient.
 *
 * `liveCharacter()` donne le personnage affiché : la cinématique du lancement
 * (components/xenodys3d.js) en prend une image, calque par calque, pour
 * l'emporter dans sa main ; pendant la préparation, il regarde, émerveillé, la
 * barre qu'elle tisse (`wonder`).
 *
 * `prefers-reduced-motion` : pas de respiration, pas de tremblement.
 */

import { buildJar, buildPlatform } from './socle.js';

/** Hauteur d'où tombe le bocal, en unités de la scène. */
const JAR_DROP = 20;

/** Le personnage actuellement affiché (un seul à la fois : l'accueil). */
let live = null;

/** @returns {null | {capture: () => any, skin: () => any, feet: () => any, wonder: (el: Element|null) => void, setPresent: (on: boolean) => void, cheer: () => void, setMood: (m: string|null) => void}} */
export function liveCharacter() {
  return live;
}

/** Rebond en fin de course (le bocal touche le socle). */
function bounceOut(x) {
  const n = 7.5625;
  const d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
}

/** Réduction du personnage, pour qu'on le voie en entier avec son socle. */
const PLATFORM_SCALE = 0.8;
/** Le sol du personnage (le dessous de ses pieds), dans le repère de la scène. */
const FLOOR = -16;
/** Cadrage : un peu plus bas (le socle entre dans l'image) et un peu à droite
 *  (loin des textes de la scène). */
const CAMERA_DROP = -3;
const CAMERA_SHIFT = -6;
/** Tourné de 30° vers la droite de l'écran… */
const YAW = (30 * Math.PI) / 180;
/** … et légèrement penché vers nous : on voit mieux le volume du skin. */
const PITCH = 0.12;

/**
 * Récupère les classes Three.js que skinview3d a déjà chargées.
 * @param {any} viewer
 * @param {any} lib  le global skinview3d
 */
function threeOf(viewer, lib) {
  // La classe de texture n'existe qu'une fois un skin chargé : un skin vide,
  // aussitôt remplacé par le vrai, suffit à la faire naître.
  if (!viewer.skinTexture) {
    const blank = document.createElement('canvas');
    blank.width = 64;
    blank.height = 64;
    viewer.loadSkin(blank);
  }
  const mesh = viewer.playerObject.skin.head.innerLayer;
  return {
    Mesh: mesh.constructor,
    Box: mesh.geometry.constructor,
    Material: mesh.material.constructor,
    Texture: viewer.skinTexture.constructor,
    // BodyPart hérite directement de Group.
    Group: Object.getPrototypeOf(lib.BodyPart.prototype).constructor,
  };
}

/**
 * Crée le personnage dans un canevas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{width: number, height: number, zoom?: number}} size
 * @returns {{
 *   viewer: any,
 *   loadSkin: (source: any, model?: 'classic'|'slim') => Promise<void>,
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
  viewer.zoom = zoom * PLATFORM_SCALE;
  viewer.autoRotate = false;
  if (viewer.controls) {
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;
    viewer.controls.enableRotate = false;
  }

  const T = threeOf(viewer, lib);
  const player = viewer.playerObject;
  // Exposé : tourné vers la droite, penché vers nous, les bras légèrement
  // écartés du buste. skinview3d remet la pose à zéro à chaque image : on la
  // réapplique dans `breathe`, à chaque image aussi.
  // Respiration : on part des positions d'origine des parties du corps.
  const bodyY = player.skin.body.position.y;
  const headY = player.skin.head.position.y;
  /** `fear` de 0 à 1 : de la respiration calme à la peur. */
  let fear = 0;
  /** `awe` de 0 à 1 : il regarde, émerveillé, ce que Xenodys tisse (voir `wonder`). */
  let awe = 0;
  /** Ce qu'il regarde alors : un élément de la page, et où il est par rapport à lui. */
  let wonderAt = null;
  let gaze = { yaw: 0, pitch: 0, body: YAW };
  const breathe = (t) => {
    const sk = player.skin;
    const b = Math.cos(t * 2);
    // Le calme : il respire.
    let lax = 0.02 * Math.PI + 0.03 * b;
    let rax = -0.02 * Math.PI - 0.03 * b;
    let headX = 0.02 * Math.sin(t * 0.7);
    let headYaw = 0;
    let armsX = 0;
    let shake = 0;
    let legs = 0;
    if (fear > 0) {
      // La peur : les bras devant le visage, la tête rentrée, des regards
      // affolés à gauche et à droite, et tout le corps qui tremble.
      const f = fear;
      const tremble = Math.sin(t * 47) * 0.5 + Math.sin(t * 31) * 0.5;
      lax = lax * (1 - f) + f * (-0.32 + tremble * 0.03);
      rax = rax * (1 - f) + f * (0.32 - tremble * 0.03);
      armsX = f * (-2.15 + tremble * 0.05);
      headX = headX * (1 - f) + f * 0.28;
      const glance = Math.sin(t * 1.3) > 0.4 ? Math.sin(t * 9) * 0.5 : 0;
      headYaw = f * glance;
      shake = f * tremble * 0.18;
      legs = f * 0.18;
    }
    const w = awe * (1 - fear);
    const mix = (a, b, k) => a + (b - a) * k;
    const bump = (x, a, b) => (x <= a || x >= b ? 0 : Math.sin(Math.PI * ((x - a) / (b - a))));
    // L'impatience (le téléchargement stagne) et la tristesse (il a échoué).
    const imp = moodK.stalled * w;
    const sad = moodK.sad * (1 - fear);
    let rArmX = null;
    let rArmZ = null;
    if (w > 0) {
      // L'émerveillement : il tourne la tête vers la barre, l'incline ; les bras
      // s'écartent un peu, les mains à demi levées ; il sautille sur place.
      const hop = Math.max(0, Math.sin(t * 3.1)) ** 3;
      lax = lax * (1 - w) + w * (0.42 + 0.04 * Math.sin(t * 2.3));
      rax = rax * (1 - w) + w * (-0.42 - 0.04 * Math.sin(t * 2.3));
      armsX = armsX * (1 - w) + w * (-0.55 + 0.06 * Math.sin(t * 2.3));
      headX = headX * (1 - w) + w * gaze.pitch;
      headYaw = headYaw * (1 - w) + w * gaze.yaw;
      wonderHop = w * hop * 0.6 * (1 - imp);
      // De temps en temps, il pointe la barre du doigt…
      const point = w * bump(t % 7, 2.0, 3.6) * (1 - imp);
      rArmX = mix(armsX, -1.15, point);
      rArmZ = mix(rax, -0.12, point);
      // … et lève les yeux vers Xenodys, là-haut à droite.
      const look = w * bump(t % 9.5, 5.2, 6.6) * (1 - imp);
      headYaw = mix(headYaw, Math.min(1.25, 0.9 - (gaze.body - YAW) * 0.4), look);
      headX = mix(headX, -0.3, look);
      // Un palier franchi : il saute de joie, les bras en l'air.
      const c = bump(clock - cheerAt, 0, 0.9);
      if (c > 0) {
        armsX = mix(armsX, -2.9, c);
        rArmX = mix(rArmX, -2.9, c);
        lax = mix(lax, 0.35, c);
        rArmZ = mix(rArmZ, -0.35, c);
        wonderHop += 1.8 * c;
      }
      // Il s'impatiente : les mains sur les hanches, il tape du pied, secoue la tête.
      if (imp > 0) {
        lax = mix(lax, 0.75, imp);
        rArmZ = mix(rArmZ, -0.75, imp);
        armsX = mix(armsX, 0.35, imp);
        rArmX = mix(rArmX, 0.35, imp);
        legs = mix(legs, 0, imp);
        headYaw += 0.22 * Math.sin(t * 2.6) * imp;
      }
    } else {
      wonderHop = 0;
    }
    if (sad > 0) {
      // Déçu : la tête basse, les bras ballants, les épaules qui tombent.
      headX = mix(headX, 0.55, sad);
      headYaw = mix(headYaw, 0, sad);
      lax = mix(lax, 0.03, sad);
      rax = mix(rax, -0.03, sad);
      armsX = mix(armsX, 0.12, sad);
      if (rArmX !== null) rArmX = mix(rArmX, 0.12, sad);
      if (rArmZ !== null) rArmZ = mix(rArmZ, -0.03, sad);
      wonderHop *= 1 - sad;
    }
    // Émerveillé, il se tourne de tout son corps vers la barre.
    player.rotation.set(PITCH, YAW + (gaze.body - YAW) * w, 0);
    player.position.x = shake;
    sk.leftArm.rotation.set(armsX, 0, lax);
    sk.rightArm.rotation.set(rArmX ?? armsX, 0, rArmZ ?? rax);
    sk.head.rotation.set(headX, headYaw, w > 0 ? w * 0.12 * Math.sin(t * 0.9) : 0);
    sk.leftLeg.rotation.x = legs;
    sk.rightLeg.rotation.x = -legs * 0.6 - (imp > 0 ? 0.32 * Math.max(0, Math.sin(t * 9)) * imp : 0);
    const rise = 0.12 * (1 + Math.sin(t * (fear > 0.5 ? 6 : 2))) - fear * 0.8 - sad * 0.35;
    sk.body.position.y = bodyY + rise;
    sk.head.position.y = headY + rise;
    player.position.y = wonderHop;
  };
  let wonderHop = 0;
  /** Le dernier palier fêté (instant, sur l'horloge de l'animation). */
  let cheerAt = -10;
  /** Son humeur (`stalled` : il s'impatiente ; `sad` : déçu), lissée. */
  let mood = null;
  const moodK = { stalled: 0, sad: 0 };
  /** Faux pendant que Xenodys l'emporte : ni lui ni son bocal ne sont sur le socle. */
  let present = true;
  breathe(0);

  const platform = buildPlatform(T);
  platform.root.position.y = FLOOR;
  platform.root.scale.setScalar(0.8);
  viewer.scene.add(platform.root);

  if (viewer.controls?.target) {
    viewer.controls.target.set(CAMERA_SHIFT, CAMERA_DROP, 0);
    viewer.camera.position.x += CAMERA_SHIFT;
    // La caméra reste un peu plus haut que sa cible : elle plonge légèrement,
    // et l'on voit le dessus du socle, son relief.
    viewer.camera.position.y += CAMERA_DROP * 0.35;
    viewer.controls.update?.();
  }

  // Le bocal : seulement quand Xenodys est corrompue.
  const jar = buildJar(T);
  jar.root.position.y = FLOOR;
  jar.root.scale.setScalar(0.8);
  jar.root.visible = false;
  viewer.scene.add(jar.root);
  // Son fondu (il apparaît en tombant) : l'opacité d'origine de chaque matériau.
  const jarMaterials = new Map();
  jar.root.traverse((o) => {
    if (o.isMesh && !jarMaterials.has(o.material)) {
      jarMaterials.set(o.material, { opacity: o.material.opacity ?? 1, transparent: o.material.transparent });
    }
  });
  const fadeJar = (k) => {
    for (const [m, base] of jarMaterials) {
      m.transparent = base.transparent || k < 1;
      m.opacity = base.opacity * k;
    }
  };

  const root$ = document.documentElement;
  let corrupted = false;
  /** 0 : le bocal est loin (au-dessus, invisible) ; 1 : posé sur le socle. */
  let jarIn = 0;
  let first = true;
  const followEtat = () => {
    platform.setEtat(root$.dataset.xenodys);
    corrupted = root$.dataset.xenodys === 'corrompue';
    // Au démarrage, rien ne tombe : l'état est déjà là.
    if (first) {
      jarIn = corrupted ? 1 : 0;
      fear = jarIn;
      first = false;
    }
  };
  followEtat();
  const etatObserver = new MutationObserver(followEtat);
  etatObserver.observe(root$, { attributes: true, attributeFilter: ['data-xenodys'] });

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let clock = 0;
  viewer.animation = new lib.FunctionAnimation((_p, _progress, delta) => {
    const dt = reduced ? 0 : Math.min(0.1, Math.max(0, delta || 0));
    clock += dt;
    // Le bocal tombe sur le socle (avec un rebond) ou remonte en s'effaçant ;
    // la peur vient quand il se referme.
    const target = corrupted ? 1 : 0;
    jarIn += reduced ? target - jarIn : Math.max(-dt * 1.4, Math.min(dt * 1.4, target - jarIn));
    const fall = corrupted ? bounceOut(jarIn) : jarIn * jarIn * (3 - 2 * jarIn);
    jar.root.position.y = FLOOR + JAR_DROP * (1 - fall);
    fadeJar(Math.min(1, jarIn * 2.5));
    jar.root.visible = present && jarIn > 0.002;
    const fearTarget = corrupted ? (jarIn > 0.6 ? 1 : 0) : 0;
    const step = reduced ? 1 : dt * 2;
    fear += Math.max(-step, Math.min(step, fearTarget - fear));
    const aweTarget = wonderAt?.isConnected ? 1 : 0;
    awe += reduced ? aweTarget - awe : Math.max(-dt * 1.6, Math.min(dt * 1.6, aweTarget - awe));
    if (wonderAt?.isConnected) aim();
    for (const m of ['stalled', 'sad']) {
      const goal = mood === m ? 1 : 0;
      moodK[m] += reduced ? goal - moodK[m] : Math.max(-dt * 2.5, Math.min(dt * 2.5, goal - moodK[m]));
    }
    jar.update(dt);
    breathe(reduced ? 0 : clock);
  });

  /**
   * Où regarder : il se tourne vers l'élément suivi (`wonder`), à partir de
   * sa place à l'écran — le corps d'abord, la tête rattrape le reste.
   */
  function aim() {
    const r = wonderAt.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    if (!c.width || !r.width) return;
    const hx = c.left + c.width * 0.5;
    const hy = c.top + c.height * 0.32;
    const tx = r.left + r.width * 0.6;
    const ty = r.top + r.height / 2;
    // Le corps se tourne vers la barre ; la tête fait le reste (dans des limites naturelles).
    const full = Math.atan2(tx - hx, c.width * 0.45);
    const body = Math.max(-1.3, Math.min(1.0, Math.atan2(tx - hx, c.width * 0.55)));
    const yaw = Math.max(-0.5, Math.min(0.5, full - body));
    const pitch = Math.max(-0.4, Math.min(0.6, Math.atan2(ty - hy, c.height * 0.9) - PITCH));
    gaze = { yaw, pitch, body };
  }

  /** Il regarde un élément, émerveillé (la barre que Xenodys tisse) ; `null` : il reprend sa pose. */
  function wonder(el) {
    wonderAt = el ?? null;
  }

  /** Un palier de la barre est franchi : il saute de joie. */
  function cheer() {
    if (clock - cheerAt > 1) cheerAt = clock;
  }

  /** Son humeur : `stalled` (il s'impatiente), `sad` (déçu), ou `null`. */
  function setMood(m) {
    mood = m === 'stalled' || m === 'sad' ? m : null;
  }

  /** Le joueur est-il sur son socle ? (Xenodys l'emporte pendant le départ.) */
  function setPresent(on) {
    present = Boolean(on);
    player.visible = present;
    if (!present) jar.root.visible = false;
  }

  /**
   * Une image du personnage, en deux calques : lui et son socle, puis le bocal
   * seul (s'il est là). Canevas 2D à la taille du rendu, et la place du
   * canevas à l'écran. `null` s'il n'est pas affiché.
   */
  function capture() {
    const rect = canvas.getBoundingClientRect();
    if (canvas.hidden || rect.width < 2 || rect.height < 2) return null;
    const grab = () => {
      viewer.render();
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      c.getContext('2d').drawImage(canvas, 0, 0);
      return c;
    };
    const jarShown = jar.root.visible;
    jar.root.visible = false;
    const body = grab();
    let glass = null;
    if (jarShown) {
      player.visible = false;
      platform.root.visible = false;
      jar.root.visible = true;
      glass = grab();
      player.visible = true;
      platform.root.visible = true;
    }
    // Lui seul, sans son socle ni son bocal : ce que Xenodys emporte.
    platform.root.visible = false;
    jar.root.visible = false;
    const alone = grab();
    platform.root.visible = true;
    jar.root.visible = jarShown;
    viewer.render();
    return { rect, body, alone, jar: glass };
  }

  /** Le skin affiché (data: URL, bras fins ou larges), ou `null`. */
  function skin() {
    try {
      const data = viewer.skinCanvas.toDataURL('image/png');
      return { data, slim: viewer.playerObject.skin.modelType === 'slim', own: true };
    } catch {
      return null;
    }
  }

  /** Où sont ses pieds, à l'écran (coordonnées de mise en page), ou `null`. */
  function feet() {
    if (canvas.hidden || !canvas.offsetWidth) return null;
    let x = canvas.offsetWidth * 0.5;
    let y = canvas.offsetHeight * 0.8;
    for (let el = canvas; el; el = el.offsetParent) {
      x += el.offsetLeft;
      y += el.offsetTop;
      if (el.dataset?.el === 'frame') break;
    }
    return { x, y };
  }

  const handle = { capture, skin, feet, wonder, setPresent, cheer, setMood };
  live = handle;

  return {
    viewer,

    async loadSkin(source, model = 'classic') {
      const result = viewer.loadSkin(source, { model: model === 'slim' ? 'slim' : 'default' });
      if (result && typeof result.then === 'function') await result;
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
      if (live === handle) live = null;
      etatObserver.disconnect();
      platform.dispose();
      jar.dispose();
      viewer.dispose();
    },
  };
}
