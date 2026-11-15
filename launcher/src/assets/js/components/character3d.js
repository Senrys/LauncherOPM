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
 * `prefers-reduced-motion` : pas de respiration, pas de tremblement.
 */

import { buildJar, buildPlatform } from './socle.js';

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
  jar.root.scale.setScalar(0.001);
  jar.root.visible = false;
  viewer.scene.add(jar.root);

  const root$ = document.documentElement;
  let corrupted = false;
  const followEtat = () => {
    platform.setEtat(root$.dataset.xenodys);
    corrupted = root$.dataset.xenodys === 'corrompue';
    if (corrupted) jar.root.visible = true;
  };
  followEtat();
  const etatObserver = new MutationObserver(followEtat);
  etatObserver.observe(root$, { attributes: true, attributeFilter: ['data-xenodys'] });

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let clock = 0;
  viewer.animation = new lib.FunctionAnimation((_p, _progress, delta) => {
    const dt = reduced ? 0 : Math.min(0.1, Math.max(0, delta || 0));
    clock += dt;
    // Peur et bocal arrivent, ou repartent, en une demi-seconde.
    const target = corrupted ? 1 : 0;
    const step = reduced ? 1 : dt * 2;
    fear += Math.max(-step, Math.min(step, target - fear));
    const s = Math.max(0.001, fear < 1 ? 1 - (1 - fear) ** 3 : 1);
    jar.root.scale.set(0.8, 0.8 * s, 0.8);
    jar.root.visible = fear > 0.002;
    jar.update(dt);
    breathe(reduced ? 0 : clock);
  });

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
      etatObserver.disconnect();
      platform.dispose();
      jar.dispose();
      viewer.dispose();
    },
  };
}
