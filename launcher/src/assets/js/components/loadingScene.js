/**
 * La scène de chargement du launcher (fenêtre ouverte, mod OPM présent).
 *
 * Après le passage de la cinématique, le launcher couvre l'écran pendant que
 * le jeu charge ses mods : Xenodys façonne le monde dans la salle de
 * simulation, ses assistants impriment des joueurs (la galerie de skins), la
 * barre avance au fil du journal du jeu. Quand l'écran de chargement du mod
 * s'affiche (`[OPM:READY]`), le launcher s'efface : le mod reprend EXACTEMENT
 * la même composition (mod/…/client/LoadingScene.java), la barre au même point.
 *
 * Même grain que le jeu : une scène en « pixels virtuels » (≈ 270 de haut),
 * agrandie d'un facteur entier, sans lissage ; mêmes planches de sprites
 * (xenodys/sprites.py), même police pixel.
 */

import { SPRITES } from '../data/sprites.js';
import { createLab } from './lab.js';

const N = 4;
const PRINT_CYCLE = 3.4;

const COLORS = {
  creatrice: { accent: '#91D9D1', core: '#E9FFFC', deep: '#1D5C51' },
  corrompue: { accent: '#F0506E', core: '#FFD3DD', deep: '#6A1F8F' },
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

const sheet = (name) => {
  const meta = SPRITES[name];
  return meta ? { name, meta, img: image(`assets/sprites/${name}.png`) } : null;
};
const sheetFor = (name, etat) => sheet(`${name}_${etat}`) || sheet(`${name}_creatrice`);

function frameAt(s, t) {
  if (!s || s.meta.images <= 1 || !s.meta.fps) return 0;
  const i = Math.floor(t * s.meta.fps);
  return s.meta.boucle ? ((i % s.meta.images) + s.meta.images) % s.meta.images : Math.min(s.meta.images - 1, Math.max(0, i));
}

const duration = (s) => (s?.meta.fps ? s.meta.images / s.meta.fps : 0);
const ease = (k) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
};
const seg = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));

/* ------------------------------------------------- les joueurs imprimés */

/**
 * Un joueur en volume, rastérisé sur le processeur — le portage exact de
 * mod/…/client/PlayerRaster.java : même modèle, même vue (tourné de 30°, vu
 * d'un peu haut), même lumière, même animation (il respire, regarde autour de
 * lui). Le launcher et le jeu impriment les mêmes images.
 */
export const PLAYER = { FRAMES: 32, FPS: 12, W: 96, H: 152, OX: 48, OY: 144, DENSITY: 2 };
const P_SCALE = 4;
const P_YAW = ((180 + 30) * Math.PI) / 180;
const P_PITCH = (18 * Math.PI) / 180;
const P_LIGHT = (() => {
  const v = [-0.35, 0.85, 0.55];
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
})();
const PIVOTS = [[0, 24, 0], [0, 24, 0], [-5, 22, 0], [5, 22, 0], [-1.9, 12, 0], [1.9, 12, 0]];
const RAD = Math.PI / 180;

function rot3([x0, y0, z0], rx, ry, rz) {
  const y = y0 * Math.cos(rx) - z0 * Math.sin(rx);
  const z = y0 * Math.sin(rx) + z0 * Math.cos(rx);
  const x2 = x0 * Math.cos(ry) + z * Math.sin(ry);
  const z2 = -x0 * Math.sin(ry) + z * Math.cos(ry);
  return [x2 * Math.cos(rz) - y * Math.sin(rz), x2 * Math.sin(rz) + y * Math.cos(rz), z2];
}

function viewOf([x0, y0, z0]) {
  const x = x0 * Math.cos(P_YAW) + z0 * Math.sin(P_YAW);
  const z = -x0 * Math.sin(P_YAW) + z0 * Math.cos(P_YAW);
  return [x, y0 * Math.cos(P_PITCH) - z * Math.sin(P_PITCH), y0 * Math.sin(P_PITCH) + z * Math.cos(P_PITCH)];
}

function playerPose(i) {
  const ph = (i / PLAYER.FRAMES) * 2 * Math.PI;
  const r = Array.from({ length: 6 }, () => [0, 0, 0]);
  r[0][1] = 14 * Math.sin(ph) * RAD;
  r[0][0] = (-4 + 3 * Math.sin(ph * 2)) * RAD;
  r[2][0] = 5 * Math.sin(ph) * RAD;
  r[3][0] = -5 * Math.sin(ph) * RAD;
  r[2][2] = (-3 - 2 * Math.sin(ph * 2)) * RAD;
  r[3][2] = (3 + 2 * Math.sin(ph * 2)) * RAD;
  return r;
}

export function rasterPlayer(img, slim) {
  const tw = img.naturalWidth;
  const th = img.naturalHeight;
  const src = document.createElement('canvas');
  src.width = tw;
  src.height = th;
  const sg = src.getContext('2d');
  sg.drawImage(img, 0, 0);
  const tex = sg.getImageData(0, 0, tw, th).data;
  const legacy = th < 64;
  const aw = slim ? 3 : 4;
  const boxes = [
    [[-4, 24, -4], [8, 8, 8], 0, 0, 0, false, 0],
    [[-4, 12, -2], [8, 12, 4], 16, 16, 0, false, 1],
    [[-4 - aw, 12, -2], [aw, 12, 4], 40, 16, 0, false, 2],
    [[4, 12, -2], [aw, 12, 4], legacy ? 40 : 32, legacy ? 16 : 48, 0, false, 3],
    [[-3.9, 0, -2], [4, 12, 4], 0, 16, 0, false, 4],
    [[-0.1, 0, -2], [4, 12, 4], legacy ? 0 : 16, legacy ? 16 : 48, 0, false, 5],
    [[-4, 24, -4], [8, 8, 8], 32, 0, 0.5, true, 0],
  ];
  if (!legacy) {
    boxes.push(
      [[-4, 12, -2], [8, 12, 4], 16, 32, 0.25, true, 1],
      [[-4 - aw, 12, -2], [aw, 12, 4], 40, 32, 0.25, true, 2],
      [[4, 12, -2], [aw, 12, 4], 48, 48, 0.25, true, 3],
      [[-3.9, 0, -2], [4, 12, 4], 0, 32, 0.25, true, 4],
      [[-0.1, 0, -2], [4, 12, 4], 0, 48, 0.25, true, 5]
    );
  }
  const { W, H, FRAMES, OX, OY } = PLAYER;
  const out = document.createElement('canvas');
  out.width = W * FRAMES;
  out.height = H;
  const og = out.getContext('2d');
  const frame = og.createImageData(W, H);
  const zbuf = new Float32Array(W * H);
  const AXES = [[2, 1, 0], [2, 1, 0], [0, 2, 1], [0, 2, 1], [0, 1, 2], [0, 1, 2]];
  const DIRS = [[-1, -1], [1, -1], [1, 1], [1, -1], [1, -1], [-1, -1]];
  const SIGN = [1, -1, 1, -1, 1, -1];

  const tri = (a, b, c, ua, ub, uc, lum, overlay) => {
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-6) return;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y += 1) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-5 || w1 < -1e-5 || w2 < -1e-5) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const i = y * W + x;
        if (z <= zbuf[i]) continue;
        const tu = Math.min(tw - 1, Math.max(0, Math.floor(w0 * ua[0] + w1 * ub[0] + w2 * uc[0])));
        const tv = Math.min(th - 1, Math.max(0, Math.floor(w0 * ua[1] + w1 * ub[1] + w2 * uc[1])));
        const o = (tv * tw + tu) * 4;
        if (overlay && tex[o + 3] < 128) continue;
        zbuf[i] = z;
        frame.data[i * 4] = Math.min(255, tex[o] * lum);
        frame.data[i * 4 + 1] = Math.min(255, tex[o + 1] * lum);
        frame.data[i * 4 + 2] = Math.min(255, tex[o + 2] * lum);
        frame.data[i * 4 + 3] = 255;
      }
    }
  };

  for (let f = 0; f < FRAMES; f += 1) {
    zbuf.fill(-Infinity);
    frame.data.fill(0);
    const r = playerPose(f);
    const breath = Math.sin((f / FRAMES) * 4 * Math.PI) * 0.35;
    for (const [origin, size, u, v, g, overlay, part] of boxes) {
      const [sx, sy, sz] = size;
      const center = [-(origin[0] + sx) + sx / 2, origin[1] + sy / 2, origin[2] + sz / 2];
      const pv = PIVOTS[part];
      const pivot = [-pv[0], pv[1], pv[2]];
      const lift = part <= 3 ? breath : 0;
      const half = [sx / 2 + g, sy / 2 + g, sz / 2 + g];
      const w = sx;
      const h = sy;
      const d = sz;
      const rects = [
        [u, v + d, d, h], [u + d + w, v + d, d, h], [u + d, v, w, d], [u + d + w, v, w, d],
        [u + 2 * d + w, v + d, w, h], [u + d, v + d, w, h],
      ];
      for (let face = 0; face < 6; face += 1) {
        const [ua, va, wa] = AXES[face];
        const nrm = [0, 0, 0];
        nrm[wa] = SIGN[face];
        const n = viewOf(rot3(nrm, ...r[part]));
        if (n[2] <= 1e-4) continue;
        const lum = 0.5 + 0.5 * Math.max(0, n[0] * P_LIGHT[0] + n[1] * P_LIGHT[1] + n[2] * P_LIGHT[2]);
        const flipV = face === 2 || face === 3;
        const pts = [];
        const uvs = [];
        for (let iy = 0; iy <= 1; iy += 1) {
          for (let ix = 0; ix <= 1; ix += 1) {
            const p = [0, 0, 0];
            p[ua] = (ix * 2 - 1) * half[ua] * DIRS[face][0];
            p[va] = (iy * 2 - 1) * half[va] * DIRS[face][1];
            p[wa] = half[wa] * SIGN[face];
            let q = rot3([p[0] + center[0] - pivot[0], p[1] + center[1] - pivot[1], p[2] + center[2] - pivot[2]], ...r[part]);
            q = [q[0] + pivot[0], q[1] + pivot[1] + lift, q[2] + pivot[2]];
            const s = viewOf(q);
            pts.push([s[0] * P_SCALE + OX, -s[1] * P_SCALE + OY, s[2]]);
            const rc = rects[face];
            uvs.push([rc[0] + ix * rc[2], flipV ? rc[1] + (1 - iy) * rc[3] : rc[1] + iy * rc[3]]);
          }
        }
        tri(pts[0], pts[1], pts[2], uvs[0], uvs[1], uvs[2], lum, overlay);
        tri(pts[1], pts[3], pts[2], uvs[1], uvs[3], uvs[2], lum, overlay);
      }
    }
    og.putImageData(frame, f * W, 0);
  }
  return out;
}

/**
 * @param {HTMLElement} host  conteneur plein écran (vide)
 * @param {{etat: () => string, sfx?: any}} options
 */
export function createLoadingScene(host, { etat: etatOf }) {
  const labCanvas = document.createElement('canvas');
  labCanvas.className = 'opm-loading__lab';
  const canvas = document.createElement('canvas');
  canvas.className = 'opm-loading__scene';
  host.append(labCanvas, canvas);
  const ctx = canvas.getContext('2d');
  let lab = null;

  let raf = 0;
  let last = 0;
  let t = 0;
  let target = 0;
  let shownRatio = 0;
  let step = 'Éveil de la simulation';
  let gallery = [];
  let printIndex = -1;
  let printStart = 0;
  let shown = 0;
  const shownAt = [];
  let nextBlink = 2.5;
  let blinkUntil = 0;
  let creepCap = 0.12;
  const blocks = [];
  for (let k = 0; k < N; k += 1) {
    for (let s = 0; s <= 2 * (N - 1); s += 1) {
      for (let i = 0; i < N; i += 1) {
        const j = s - i;
        if (j >= 0 && j < N) blocks.push([i, j, k]);
      }
    }
  }
  const bot = { x: -1, dir: 1, state: 0, at: 0 };

  /** Un skin (data: URL) → planche animée du joueur en volume (rasterPlayer). */
  function printed(src, slim) {
    const entry = { canvas: null, ready: false };
    const img = new Image();
    img.onload = () => {
      entry.canvas = rasterPlayer(img, slim);
      entry.ready = true;
    };
    img.src = src;
    return entry;
  }

  /** Une image de planche, son origine en (x, y). Les planches « denses » (2 pixels
   *  par pixel virtuel) s'affichent à moitié : nettes, comme dans le jeu. */
  function draw(s, frame, x, y, { mirror = false, alpha = 1, scale = 1 } = {}) {
    if (!s || !s.img.complete || !s.img.naturalWidth || alpha <= 0.003) return;
    const { largeur: w, hauteur: h, origine: [ox, oy] } = s.meta;
    const cols = s.meta.colonnes ?? s.meta.images;
    const k = scale / (s.meta.densite ?? 1);
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.translate(x, y);
    ctx.scale(mirror ? -k : k, k);
    ctx.drawImage(s.img, (frame % cols) * w, Math.floor(frame / cols) * h, w, h, -ox, -oy, w, h);
    ctx.restore();
  }

  const fill = (x0, y0, x1, y1, color, alpha = 1) => {
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.fillStyle = color;
    ctx.fillRect(Math.floor(x0), Math.floor(y0), Math.floor(x1) - Math.floor(x0), Math.floor(y1) - Math.floor(y0));
    ctx.globalAlpha = 1;
  };

  /* --------------------------------------------------------------- police */
  const font = sheet('police');
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

  /* ---------------------------------------------------------------- scène */

  function render(dt) {
    t += dt;
    const etat = etatOf() === 'corrompue' ? 'corrompue' : 'creatrice';
    const col = COLORS[etat];
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(host.clientWidth * dpr);
    const H = Math.round(host.clientHeight * dpr);
    const k = Math.max(1, Math.floor(H / 270));
    const vw = Math.ceil(W / k);
    const vh = Math.ceil(H / k);
    // Le canevas a deux pixels par pixel virtuel : les planches denses y tombent
    // pixel pour pixel.
    if (canvas.width !== vw * 2 || canvas.height !== vh * 2) {
      canvas.width = vw * 2;
      canvas.height = vh * 2;
    }
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, vw, vh);

    // La barre ne reste jamais figée : elle glisse vers la prochaine étape.
    creepCap = Math.max(creepCap, target);
    target = Math.min(creepCap - 0.01, target + dt * 0.004);
    shownRatio += (Math.max(target, shownRatio) - shownRatio) * Math.min(1, dt * 4);

    const mx = vw * 0.5;
    const my = vh * 0.47;
    const floor = vh * 0.88;

    // Xenodys.
    const body = sheetFor('xen_faconne', etat);
    const blink = sheet(`xen_faconne_${etat}_blink`);
    const hands = sheetFor('xen_faconne_mains', etat);
    let xo = mx;
    let yo = my;
    if (body) {
      const [px, py] = body.meta.points.monde;
      const d = body.meta.densite ?? 1;
      xo = mx - (px - body.meta.origine[0]) / d;
      yo = my - (py - body.meta.origine[1]) / d;
    }
    if (t > nextBlink) {
      blinkUntil = t + 0.14;
      nextBlink = t + 2.5 + Math.random() * 3.5;
    }
    const jitter = etat === 'corrompue' && Math.random() < 0.08 ? (Math.random() < 0.5 ? 2 : -2) : 0;
    const frame = frameAt(body, t);
    if (t < blinkUntil && blink) {
      draw(blink, Math.min(blink.meta.images - 1, Math.floor((frame * blink.meta.images) / body.meta.images)), xo + jitter, yo);
    } else {
      draw(body, frame, xo + jitter, yo);
    }

    // Le monde, bloc à bloc.
    const want = Math.floor(Math.max(0, Math.min(1, shownRatio)) * blocks.length);
    while (shown < want) shownAt[shown++] = t;
    const block = sheetFor('bloc', etat);
    for (let n = 0; n < shown; n += 1) {
      const [i, j, kk] = blocks[n];
      const bx = mx + (i - j) * 6;
      const by = my - 5 + (i + j) * 3 - kk * 7 - 6;
      draw(block, 0, bx, by);
      const fresh = 1 - (t - shownAt[n]) / 0.35;
      if (fresh > 0) fill(bx - 5, by - 5, bx + 5, by + 5, col.core, fresh * 0.8);
    }
    draw(hands, frame, xo + jitter, yo);

    // L'imprimante : le socle de circuit imprimé, et le joueur qui s'y imprime.
    const px = vw * 0.24;
    draw(sheetFor('socle', etat), 0, px, floor - 6);
    const stand = floor - 6;
    if (gallery.length) {
      if (printIndex < 0 || t - printStart > PRINT_CYCLE) {
        printIndex = (printIndex + 1) % gallery.length;
        printStart = t;
      }
      const p = t - printStart;
      const skin = gallery[printIndex % gallery.length];
      if (skin.ready) {
        const reveal = ease(p / 1.8);
        const leave = seg(p, 2.5, 3.3);
        const rows = Math.round(reveal * PLAYER.H);
        if (rows > 0) {
          const frame = Math.floor(t * PLAYER.FPS) % PLAYER.FRAMES;
          const d = PLAYER.DENSITY;
          const top = stand - PLAYER.OY / d;
          const from = PLAYER.H - rows;
          ctx.globalAlpha = 1 - leave;
          ctx.drawImage(skin.canvas, frame * PLAYER.W, from, PLAYER.W, rows,
            px - PLAYER.OX / d, top + from / d - leave * 12, PLAYER.W / d, rows / d);
          ctx.globalAlpha = 1;
          if (reveal < 1) {
            const y = top + from / d;
            fill(px - 14, y - 1, px + 14, y, col.core, 0.95);
            fill(px - 14, y, px + 14, y + 1, col.accent, 0.6);
          }
        }
        if (p >= 2.5 && p <= 3.4) {
          const kq = seg(p, 2.5, 3.4);
          for (let i = 0; i < 10; i += 1) {
            const q = Math.max(0, Math.min(1, kq * 1.4 - i * 0.04));
            if (q <= 0 || q >= 1) continue;
            const x = px + (mx - px) * q;
            const y = stand - 32 + (my - (stand - 32)) * q - Math.sin(q * Math.PI) * 30;
            fill(x - 1 + (i % 3) - 1, y - 1, x + 1 + (i % 3) - 1, y + 1, i < 2 ? col.core : col.accent, 1 - q * 0.5);
          }
        }
      }
    }

    // Les assistants.
    const work = sheetFor('bot_travail', etat);
    draw(work, frameAt(work, t), px - 44, floor);
    patrol(dt, vw, floor, etat);

    // Bandeau et barre.
    const banner = image(etat === 'corrompue' ? 'assets/sprites/bandeau_corrompue.png' : 'assets/images/bandeau-opm.png');
    if (banner.complete && banner.naturalWidth) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(banner, 12, 10, 120, Math.round((120 * banner.naturalHeight) / banner.naturalWidth));
      ctx.imageSmoothingEnabled = false;
    }
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

  function patrol(dt, vw, floor, etat) {
    const xa = vw * 0.64;
    const xb = vw * 0.86;
    // Il entre par la droite de l'écran, puis fait sa ronde.
    if (bot.x < 0) Object.assign(bot, { x: vw + 40, dir: -1 });
    const entering = bot.x > xb + 1;
    const walk = sheetFor('bot_marche', etat);
    const fall = sheetFor('bot_chute', etat);
    const up = sheetFor('bot_releve', etat);
    const since = t - bot.at;
    if (bot.state === 0) {
      bot.x += bot.dir * (entering ? 26 : 14) * dt;
      if (bot.x > xb && !entering) bot.dir = -1;
      if (bot.x < xa) bot.dir = 1;
      if (!entering && Math.random() < 0.06 * dt) Object.assign(bot, { state: 1, at: t });
      draw(walk, frameAt(walk, t), bot.x, floor, { mirror: bot.dir < 0 });
    } else if (bot.state === 1) {
      draw(fall, frameAt(fall, since), bot.x, floor, { mirror: bot.dir < 0 });
      if (since >= duration(fall)) Object.assign(bot, { state: 2, at: t });
    } else if (bot.state === 2) {
      draw(fall, (fall?.meta.images ?? 1) - 1, bot.x, floor, { mirror: bot.dir < 0 });
      if (since >= 0.7) Object.assign(bot, { state: 3, at: t });
    } else {
      draw(up, frameAt(up, since), bot.x, floor, { mirror: bot.dir < 0 });
      if (since >= duration(up)) Object.assign(bot, { state: 0, at: t });
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    render(dt);
  }

  return {
    /** Les skins à imprimer (galerie du serveur d'authentification). */
    setGallery(list) {
      gallery = (Array.isArray(list) ? list : [])
        .filter((s) => typeof s?.data === 'string' && s.data.startsWith('data:image/png'))
        .slice(0, 16)
        .map((s) => printed(s.data, s.slim));
    },
    /** La scène apparaît (sous l'éclair du passage). */
    show() {
      if (raf) return;
      if (!lab) lab = createLab(labCanvas);
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
      host.replaceChildren();
    },
  };
}
