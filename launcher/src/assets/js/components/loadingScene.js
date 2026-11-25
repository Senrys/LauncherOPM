/**
 * La scène de chargement du launcher (fenêtre ouverte, mod OPM présent).
 *
 * Après le passage de la cinématique, le launcher couvre l'écran pendant que le jeu
 * charge ses mods : le laboratoire de Xenodys s'assemble, un joueur flotte dans la
 * grande cuve (components/labScene.js). C'est la même scène que celle du mod, réglée
 * sur la même horloge (`scene_debut`, transmise au jeu par opm/session.json) : quand
 * l'écran de chargement du jeu prend le relais (`[OPM:READY]`), elle continue sans saut.
 *
 * Derrière, la salle de simulation (components/lab.js, pixel art voulu) ; devant, la
 * barre et son étape (police pixel, data/sprites.js), au style « circuit » d'OPMTech.
 */

import { SPRITES } from '../data/sprites.js';
import { createLab } from './lab.js';
import { createLabScene } from './labScene.js';

const COLORS = {
  creatrice: { accent: '#91D9D1', core: '#E9FFFC', off: '#1F4A4A' },
  corrompue: { accent: '#F0506E', core: '#FFD3DD', off: '#3A1A34' },
};

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

/**
 * @param {HTMLElement} host  conteneur plein écran (vide)
 * @param {{etat: () => string}} options
 */
export function createLoadingScene(host, { etat: etatOf, onDismiss = null }) {
  const labCanvas = document.createElement('canvas');
  labCanvas.className = 'opm-loading__lab';
  const glCanvas = document.createElement('canvas');
  glCanvas.className = 'opm-loading__3d';
  const canvas = document.createElement('canvas');
  canvas.className = 'opm-loading__scene';
  // Jamais prisonnier de la scène : « Réduire » (et la touche Échap) la referme
  // et rend la main, le jeu continue de charger derrière.
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'opm-loading__reduire';
  dismiss.textContent = 'Réduire';
  dismiss.title = 'Réduire le launcher (le jeu continue de charger)';
  dismiss.setAttribute('data-hit', '');
  dismiss.addEventListener('click', () => onDismiss?.());
  const onKey = (e) => {
    if (e.key === 'Escape' && raf) onDismiss?.();
  };
  window.addEventListener('keydown', onKey);
  host.append(labCanvas, glCanvas, canvas, dismiss);
  const ctx = canvas.getContext('2d');
  let lab = null;
  let scene3d = null;
  let pendingGallery = [];

  let raf = 0;
  let last = 0;
  let epoch = Date.now();
  let target = 0;
  let shownRatio = 0;
  let step = 'Mise sous tension du laboratoire';
  let clock = -1;
  let loading3d = false;
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

  /** Le laboratoire (préparé d'avance : rien ne doit accrocher à l'apparition). */
  async function prepare() {
    if (scene3d || loading3d) return;
    loading3d = true;
    try {
      const s = await createLabScene(glCanvas, { actors: true });
      await s.setBanners({ creatrice: 'assets/images/bandeau-opm.png', corrompue: 'assets/sprites/bandeau_corrompue.png' });
      s.setGallery(pendingGallery);
      scene3d = s;
    } catch (err) {
      console.error('opm : scène 3D indisponible.', err);
    }
    loading3d = false;
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
    // Une image en retard ne fait pas sauter la scène : elle rattrape en douceur.
    const real = (Date.now() - epoch) / 1000;
    if (clock < 0 || Math.abs(real - clock) > 8) clock = real;
    else clock += Math.min(0.05, dt) * (1 + Math.max(-0.1, Math.min(0.1, (real - clock) * 0.1)));
    if (scene3d) scene3d.render(W, H, clock, { ratio: shownRatio, etat });

    // L'interface, en pixels virtuels (deux pixels de canevas par pixel virtuel).
    if (canvas.width !== vw * 2 || canvas.height !== vh * 2) {
      canvas.width = vw * 2;
      canvas.height = vh * 2;
    }
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, vw, vh);
    // Le cadre d'OPMTech : métal, fond sombre, broches dorées.
    const w = Math.min(Math.round(vw * 0.62), 300);
    let x0 = Math.floor((vw - w) / 2);
    let y0 = vh - 42;
    let x1 = x0 + w;
    let y1 = y0 + 34;
    for (const [color, n] of [['#0A0F13', 3], ['#6A7688', 2], ['#12161D', 1]]) {
      fill(x0, y0, x1, y1, color);
      x0 += n;
      y0 += n;
      x1 -= n;
      y1 -= n;
    }
    fill(x0, y0, x1, y1, '#0A1216');
    for (let y = y0 + 6; y < y1 - 5; y += 6) fill(x0 - 6, y, x0 - 3, y + 2, '#D3AE59');
    write(step, x0 + 7, y0 + 4, '#E4F6F4');
    const ratioShown = Math.max(0, Math.min(1, shownRatio));
    const pct = `${Math.round(ratioShown * 100)} %`;
    write(pct, x1 - 7 - textWidth(pct), y0 + 4, col.accent);
    const segs = Math.floor((w - 26) / 6);
    const lit = Math.floor(ratioShown * segs);
    for (let i = 0; i < segs; i += 1) {
      const pulse = i < lit && Math.abs(i - ((clock * 26) % (segs + 30))) < 1.5;
      fill(x0 + 7 + i * 6, y0 + 15, x0 + 11 + i * 6, y0 + 20, pulse || i === lit - 1 ? col.core : i < lit ? col.accent : col.off);
    }
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
        own: Boolean(s?.own),
        data: typeof s?.data === 'string' && s.data.startsWith('data:image/png') ? s.data : null,
      }));
      if (typeof sceneEpoch === 'number' && sceneEpoch > 0) epoch = sceneEpoch;
      clock = -1;
      scene3d?.setGallery(pendingGallery);
      void prepare();
    },
    /** La scène apparaît (sous l'éclair du passage). */
    show() {
      if (raf) return;
      if (!lab) lab = createLab(labCanvas);
      void prepare();
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
      window.removeEventListener('keydown', onKey);
      lab?.dispose();
      scene3d?.dispose();
      host.replaceChildren();
    },
  };
}
