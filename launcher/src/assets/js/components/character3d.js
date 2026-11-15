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
 * (components/xenodys3d.js) en prend une image, calque par calque, pour le
 * défaire en pixels.
 *
 * `prefers-reduced-motion` : pas de respiration, pas de tremblement.
 */

import { buildJar, buildPlatform } from './socle.js';

/** Hauteur d'où tombe le bocal, en unités de la scène. */
const JAR_DROP = 20;

/** Le personnage actuellement affiché (un seul à la fois : l'accueil). */
let live = null;

/** @returns {null | {capture: () => any}} */
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
    player.rotation.set(PITCH, YAW, 0);
    player.position.x = shake;
    sk.leftArm.rotation.set(armsX, 0, lax);
    sk.rightArm.rotation.set(armsX, 0, rax);
    sk.head.rotation.set(headX, headYaw, 0);
    sk.leftLeg.rotation.x = legs;
    sk.rightLeg.rotation.x = -legs * 0.6;
    const rise = 0.12 * (1 + Math.sin(t * (fear > 0.5 ? 6 : 2))) - fear * 0.8;
    sk.body.position.y = bodyY + rise;
    sk.head.position.y = headY + rise;
  };
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
    jar.root.visible = jarIn > 0.002;
    const fearTarget = corrupted ? (jarIn > 0.6 ? 1 : 0) : 0;
    const step = reduced ? 1 : dt * 2;
    fear += Math.max(-step, Math.min(step, fearTarget - fear));
    jar.update(dt);
    breathe(reduced ? 0 : clock);
  });

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
    jar.root.visible = jarShown;
    viewer.render();
    return { rect, body, jar: glass };
  }

  const handle = { capture };
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
