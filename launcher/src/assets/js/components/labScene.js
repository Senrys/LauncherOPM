/**
 * Le laboratoire de Xenodys dans le launcher — le portage de `client/LabScene` (mod).
 *
 * - pendant le chargement du jeu (components/loadingScene.js) : la salle s'assemble,
 *   un joueur flotte dans la grande cuve, Xenodys va d'un poste à l'autre. Même
 *   chorégraphie, même horloge que le jeu : le relais ne se voit pas ;
 * - derrière le launcher (`createLabBackground`) : la salle entière, ses machines en
 *   marche, la plateforme sous les pieds du personnage.
 *
 * Quand l'état de Xenodys bascule, la salle se convertit bloc après bloc, depuis la
 * plateforme.
 */

import { packImage } from '../utils/pack.js';
import { BASE, GLOW, GeoModel, LabData, M4, Painter, TRANS, add, copyPose } from './labGl.js';

const SLOT = 11;
const TRAVEL = 2.2;
const DROP = 0.65;
const CHUNK = 64;
const XS = 1.34 / 16;
const PS = 1.22 / 16;
const BOT = 1.25 / 16;
const CX = 15.5;
const CZ = 12.5;
const TOP = 3;
const TANK_FLOOR = 3.72;
const TANK_TOP = 6.75;
const PROGRAM = ['TANK', 'REACTOR', 'BUILD', 'HOLO', 'TANK', 'BUILD', 'SPECIMEN'];
const PLACE = { TANK: [CX, 4.5, 8], REACTOR: [12.4, 2.4, 5], BUILD: [17.9, 2.9, 6.6], HOLO: [13.3, 2.4, 6.6], SPECIMEN: [22, 2.4, 5.2] };
const UP = { REACTOR: 1.7, HOLO: 2, SPECIMEN: 2, BUILD: 2.2, TANK: 2 };
const RAD = Math.PI / 180;

export const ease = (k) => {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
};
export const seg = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));
const damp = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);
const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const plus = (a, x, y, z) => [a[0] + x, a[1] + y, a[2] + z];
const sin = Math.sin;
const cos = Math.cos;
const mod = (a, n) => ((a % n) + n) % n;
const rgbOf = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

/** Hasard reproductible — le même que LabScene.hash (Java). */
export function hash(n) {
  let h = (Math.imul(n, 374761393) + 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const C = 'circuit:';
const WORKS = (() => {
  const gate = [];
  for (let y = 0; y < 3; y += 1) {
    gate.push([-1.5, y + 0.5, 0, `${C}cote`, `${C}dalle`], [1.5, y + 0.5, 0, `${C}cote`, `${C}dalle`]);
  }
  for (let i = -1; i <= 1; i += 1) gate.push([i, 3.5, 0, `${C}cote`, `${C}piste`]);
  gate.push([-2, 3.5, 0, `${C}condensateur`, `${C}via`], [2, 3.5, 0, `${C}condensateur`, `${C}via`], [0, 1.6, 0, `${C}coeur`, `${C}coeur`]);
  const tower = [];
  for (let y = 0; y < 4; y += 1) {
    if (y === 2) {
      tower.push([0, y + 0.5, 0, `${C}coeur`, `${C}coeur`]);
      continue;
    }
    for (let i = 0; i < 4; i += 1) {
      tower.push([(i & 1) - 0.5, y + 0.5, (i >> 1) - 0.5, y === 3 ? `${C}radiateur` : `${C}cote`, y === 3 ? `${C}emetteur` : `${C}dalle`]);
    }
  }
  const cube = [];
  for (let i = 0; i < 27; i += 1) {
    const a = (i % 3) - 1;
    const b = (Math.floor(i / 3) % 3) - 1;
    const c = Math.floor(i / 9) - 1;
    const mid = Math.abs(a) + Math.abs(b) + Math.abs(c) === 1;
    cube.push([a * 0.62, c * 0.62 + 2.6, b * 0.62, mid ? `${C}coeur` : `${C}cote`, mid ? `${C}coeur` : `${C}puce`]);
  }
  return [gate, tower, cube];
})();
const workOf = (slot) => Math.floor(hash(slot * 13 + 5) * WORKS.length);
const placedAt = (i, n) => TRAVEL + 0.5 + (i * 4) / n;

const CUBE = [
  [[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]],
  [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5]],
  [[-0.5, 0.5, 0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5]],
  [[0.5, 0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5]],
  [[-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5]],
  [[0.5, 0.5, 0.5], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5]],
];
const SHADE = [1, 0.45, 0.92, 0.6, 0.75, 0.75];

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{actors: boolean}} options  `actors` : Xenodys, le joueur, la cuve (le chargement)
 */
export async function createLabScene(canvas, { actors }) {
  const P = new Painter(canvas);
  const { batch, white } = P;
  const data = await LabData.load(P);
  const none = Promise.resolve(null);
  const [xen, bot, wide, slim] = await Promise.all([
    actors ? GeoModel.load('xenodys', 'animation.xenodys') : none,
    GeoModel.load('xenodys_assistant', 'animation.xenodys_assistant'),
    actors ? GeoModel.load('joueur', null) : none,
    actors ? GeoModel.load('joueur_fin', null) : none,
  ]);
  if (!bot || (actors && !xen)) throw new Error('modèles absents du paquet');
  const entity = new Map();
  await Promise.all(['creatrice', 'corrompue'].flatMap((e) => [
    ...(actors ? [`xenodys_${e}`, `xenodys_${e}_glowmask`, `xenodys_${e}_blink`, `xenodys_${e}_blink_glowmask`] : []),
    `xenodys_assistant_${e}`, `xenodys_assistant_${e}_glowmask`,
  ].map(async (n) => entity.set(n, P.texture(await packImage(`entity/${n}.png`))))));

  const entries = data.entries;
  const tankIndex = entries.findIndex((e) => e.poste === 'cuve');
  const shownAt = new Float64Array(entries.length).fill(NaN);
  let shown = 0;
  const chunks = [];
  for (let i = 0; i < entries.length; i += CHUNK) chunks.push({ from: i, to: Math.min(entries.length, i + CHUNK), vb: {} });

  /* L'état de chaque groupe de blocs : la bascule court depuis la plateforme. */
  let etat = 'creatrice';
  let before = 'creatrice';
  let switchedAt = -10;
  let t = 0;
  const etatOf = (index) => (t - switchedAt > (index / chunks.length) * 1.4 ? etat : before);

  let banners = null;
  let view = new M4();
  let eye = [0, 0, 0];
  const S = { lastT: -1, handR: null, handL: null, armR: [0, 0, 0, 0], armL: [0, 0, 0, 0], solvedR: [0, 0, 0, 0], solvedL: [0, 0, 0, 0], curls: new Array(8).fill(0), headYaw: 0, headPitch: 0, bodyYaw: 180, armWeight: 0, level: TANK_FLOOR };
  let gallery = [];
  let mouth = [CX, 6, CZ];
  let viewRot = new M4();

  const corrupted = () => etat === 'corrompue';
  const accent = () => rgbOf(corrupted() ? 0xf0506e : 0x7fe9dc);
  const core = () => rgbOf(corrupted() ? 0xffd3dd : 0xeffffc);

  /* ------------------------------------------------------------- outils */

  function rect(a, b, c, d, rgb, alpha) {
    for (const p of [a, b, c, d]) batch.vertex(p[0], p[1], p[2], 0.5, 0.5, rgb[0], rgb[1], rgb[2], Math.max(0, Math.min(1, alpha)));
  }

  /** Un petit carré face à la caméra. */
  let right = [1, 0, 0];
  let up = [0, 1, 0];
  function spark(p, size, rgb, alpha) {
    const s = size / 2;
    const a = Math.max(0, Math.min(1, alpha));
    for (const [x, y] of [[-s, s], [-s, -s], [s, -s], [s, s]]) {
      batch.vertex(p[0] + right[0] * x + up[0] * y, p[1] + right[1] * x + up[1] * y, p[2] + right[2] * x + up[2] * y, 0.5, 0.5, rgb[0], rgb[1], rgb[2], a);
    }
  }

  function beam(from, to, size0, alpha, seed) {
    const size = size0 * 1.35;
    const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const n = Math.max(2, Math.floor(len / (size * 1.15)));
    const hot = core();
    const cold = accent();
    for (let i = 0; i <= n; i += 1) {
      const k = i / n;
      const sway = sin(k * Math.PI) * 0.12;
      const p = plus(lerp(from, to, k), sin(t * 9 + i * 0.9 + seed) * sway, cos(t * 7 + i * 1.3 + seed) * sway, 0);
      const run = mod(k * 6 - t * 3.2 + seed * 0.37, 1);
      spark(p, size, run < 0.25 ? hot : cold, alpha * (run < 0.25 ? 1 : 0.55));
    }
  }

  function ring(o, r, alpha, n) {
    const hot = core();
    const cold = accent();
    for (let i = 0; i < n; i += 1) {
      const a = (i * 2 * Math.PI) / n + t * 0.8;
      const h = (i + Math.floor(t * 10)) % 7 === 0;
      spark([o[0] + cos(a) * r, o[1], o[2] + sin(a) * r], 0.075, h ? hot : cold, alpha * (h ? 1 : 0.6));
    }
  }

  function block(m, side, top, glow) {
    const { largeur: w, hauteur: h } = data.meta.atlas;
    for (let f = 0; f < 6; f += 1) {
      const tile = f < 2 ? top : side;
      if (glow && !data.glowing.has(tile)) continue;
      const [u, v] = data.cell(tile);
      const uv = [[u, v], [u, v + 16], [u + 16, v + 16], [u + 16, v]];
      const s = glow ? 1 : SHADE[f] * (corrupted() ? 0.85 : 1);
      CUBE[f].forEach((q, i) => {
        const k = glow ? 1.006 : 1;
        const p = m.point(q[0] * k, q[1] * k, q[2] * k);
        batch.vertex(p[0], p[1], p[2], uv[i][0] / w, uv[i][1] / h, s, s, s, 1);
      });
    }
  }

  function model(m, pose, world, tex, glow, alpha = 1, rgb = [1, 1, 1]) {
    P.use(tex);
    m.emit(batch, pose, world, viewRot, rgb, alpha);
    P.flush();
    if (glow) {
      P.use(glow);
      P.additive(true);
      m.emit(batch, pose, world, null, [1, 1, 1], alpha);
      P.flush();
      P.additive(false);
    }
  }

  /* ------------------------------------------------------------- la salle */

  function assemble(ratio) {
    const n = entries.length;
    const first = data.foundation;
    const target = ratio === null ? n : Math.min(n, Math.floor(first + Math.max(0, Math.min(1, ratio / 0.92)) * (n - first)));
    let fresh = 0;
    while (shown < target) {
      shownAt[shown] = ratio === null || shown < first ? t - 10 : t + fresh * 0.0016 + hash(shown) * 0.12;
      fresh += 1;
      shown += 1;
    }
  }

  function settled(c) {
    for (let i = c.from; i < c.to; i += 1) if (!(t - shownAt[i] >= DROP)) return false;
    return true;
  }

  function buildChunk(c, state) {
    const layers = [];
    for (let layer = 0; layer < 3; layer += 1) {
      batch.n = 0;
      for (let i = c.from; i < c.to; i += 1) {
        if (i === tankIndex) continue;
        const [a, n] = entries[i].q[layer];
        if (n > 0) data.emit(batch, layer, a, n, state === 'corrompue', null);
      }
      layers.push(batch.n > 0 ? P.buffer(batch.data.slice(0, batch.n)) : null);
      batch.n = 0;
    }
    c.vb[state] = layers;
  }

  function dropMatrix(i) {
    const e = ease((t - shownAt[i]) / DROP);
    const c = entries[i].c;
    const a = (1 - e) * (2.2 + hash(i) * 2);
    const r = (1 - e) * 1.6;
    return new M4().translate(c[0] + cos(a + i) * r, c[1] - (1 - e) * (1.5 + hash(i * 3) * 1.5), c[2] + sin(a + i) * r)
      .rotY((1 - e) * 2.5).scale(Math.max(0.02, e)).translate(-c[0], -c[1], -c[2]);
  }

  function drawLayer(layer, atlases) {
    const loose = [];
    for (const state of ['creatrice', 'corrompue']) {
      let bound = false;
      chunks.forEach((c, index) => {
        if (c.from >= shown || etatOf(index) !== state) return;
        if (!settled(c)) {
          loose.push([c, state]);
          return;
        }
        if (!c.vb[state]) buildChunk(c, state);
        const buf = c.vb[state][layer];
        if (!buf) return;
        if (!bound) P.use(atlases[state]);
        bound = true;
        P.draw(buf);
      });
    }
    for (const state of ['creatrice', 'corrompue']) {
      for (const [c, s] of loose) {
        if (s !== state) continue;
        for (let i = c.from; i < Math.min(c.to, shown); i += 1) {
          if (i === tankIndex || !(t >= shownAt[i])) continue;
          const [a, n] = entries[i].q[layer];
          if (n > 0) data.emit(batch, layer, a, n, s === 'corrompue', t - shownAt[i] < DROP ? dropMatrix(i) : null);
        }
      }
      if (batch.n > 0) {
        P.use(atlases[state]);
        P.flush();
      }
    }
  }

  function tank(layer) {
    if (!actors || tankIndex < 0) return;
    const [a, n] = entries[tankIndex].q[layer];
    if (n > 0) data.emit(batch, layer, a, n, corrupted(), null);
    P.flush();
  }

  const POST_OF = { reacteur: 'REACTOR', hologramme: 'HOLO', specimen: 'SPECIMEN' };
  const postAt = (k) => PROGRAM[mod(k, PROGRAM.length)];

  function boost(owner) {
    const p = actors ? POST_OF[entries[owner].poste] : null;
    if (!p) return 0;
    let total = 0;
    const k = Math.floor(t / SLOT);
    for (let i = Math.max(0, k - 24); i <= k; i += 1) {
      if (postAt(i) === p) total += Math.max(0, Math.min(SLOT - 0.6, t - i * SLOT) - TRAVEL);
    }
    return total;
  }

  function pieceMatrix(p, ticks) {
    const m = p.parent ? pieceMatrix(p.parent, ticks) : p.base.clone();
    m.translate(...p.pivot);
    const turn = (axis, deg) => {
      const a = (deg % 360) * RAD;
      if (axis === 'x') m.rotX(a);
      else if (axis === 'z') m.rotZ(a);
      else m.rotY(a);
    };
    const shift = (axis, d) => m.translate(axis === 'x' ? d : 0, axis === 'y' ? d : 0, axis === 'z' ? d : 0);
    for (const a of p.anims) {
      const w = a.periode > 0 ? ticks / a.periode + (a.phase ?? 0) : 0;
      const s = sin(w * 2 * Math.PI);
      const axis = a.axe ?? 'y';
      if (a.type === 'tourne') turn(axis, a.vitesse * ticks);
      else if (a.type === 'balance') turn(axis, a.amp * s);
      else if (a.type === 'regard') turn('y', a.amp * s);
      else if (a.type === 'pas') turn(axis, a.amp * (Math.floor(w) + ease((w - Math.floor(w)) * 3)));
      else if (a.type === 'pulse') m.scale(1 + a.amp * s);
      else if (a.type === 'monte') shift(axis, (a.amp / 16) * s);
      else if (a.type === 'defile') shift(axis, (a.amp / 16) * (w - Math.floor(w)));
      else if (a.type === 'presse') shift('y', (-a.amp / 16) * Math.max(0, s) ** 3);
    }
    return m.translate(-p.pivot[0], -p.pivot[1], -p.pivot[2]);
  }

  let pieceCache = [];
  function pieces(layer) {
    for (const [p, m] of pieceCache) {
      const [a, n] = p.q[layer];
      if (n > 0) data.emit(batch, layer, a, n, corrupted(), m);
    }
    P.flush();
  }

  function screens() {
    if (shown < entries.length * 0.75) return;
    const z = 1.06;
    const on = seg(shown / entries.length, 0.75, 0.85);
    const zones = [[3.6, 12, 7.6, 10.8], [19, 27.4, 7.6, 10.8]];
    P.use(white);
    for (const r of zones) {
      rect([r[0] - 0.2, r[3] + 0.2, z], [r[0] - 0.2, r[2] - 0.2, z], [r[1] + 0.2, r[2] - 0.2, z], [r[1] + 0.2, r[3] + 0.2, z], rgbOf(corrupted() ? 0x1b1020 : 0x33454a), 1);
      rect([r[0], r[3], z + 0.02], [r[0], r[2], z + 0.02], [r[1], r[2], z + 0.02], [r[1], r[3], z + 0.02], rgbOf(corrupted() ? 0x12060f : 0x071311), 1);
    }
    const r = zones[1];
    const scroll = Math.floor(t * 2.2);
    for (let line = 0; line < 13; line += 1) {
      const id = scroll - line;
      const y = r[2] + 0.2 + line * 0.23;
      let x = r[0] + 0.25;
      const words = 1 + Math.floor(hash(id * 5) * 5);
      const typed = line === 0 ? (t * 2.2 - scroll) * 1.2 : 1;
      for (let w = 0; w < words; w += 1) {
        const len = 0.3 + hash(id * 17 + w) * 1.3;
        if (x + len > r[1] - 0.2 || w / words > typed) break;
        const col = hash(id * 31 + w) > 0.75 ? rgbOf(corrupted() ? 0xc77dff : 0xf1d58a) : accent();
        rect([x, y + 0.11, z + 0.04], [x, y, z + 0.04], [x + len, y, z + 0.04], [x + len, y + 0.11, z + 0.04], col, 0.9 * on);
        x += len + 0.16;
      }
    }
    P.flush();
    const b = banners?.[etat];
    if (b && on > 0) {
      const a = zones[0];
      const w = a[1] - a[0] - 0.9;
      const h = w * b.ratio;
      const mx = (a[0] + a[1]) / 2;
      const my = (a[2] + a[3]) / 2;
      P.use(b.tex);
      [[-1, 1, 0, 0], [-1, -1, 0, 1], [1, -1, 1, 1], [1, 1, 1, 0]].forEach(([x, y, u, v]) => batch.vertex(mx + (x * w) / 2, my + (y * h) / 2, z + 0.05, u, v, 1, 1, 1, on));
      P.flush();
    }
    P.use(white);
    P.additive(true);
    for (const q of zones) {
      const y = q[3] - ((t * 0.5) % 1) * (q[3] - q[2]);
      const y2 = Math.max(q[2], y - 0.35);
      rect([q[0], y, z + 0.06], [q[0], y2, z + 0.06], [q[1], y2, z + 0.06], [q[1], y, z + 0.06], accent(), 0.1 * on);
    }
    P.flush();
    P.additive(false);
  }

  /* -------------------------------------------------------------- Xenodys */

  function focus(p) {
    const at = { REACTOR: data.posts.reacteur, HOLO: data.posts.hologramme, SPECIMEN: data.posts.specimen, BUILD: [21.6, 1, 6.2] }[p] ?? [CX, TOP, CZ];
    return plus(at, 0, UP[p] ?? 2, 0);
  }

  function baseAt(time) {
    const k = Math.floor(time / SLOT);
    const e = ease((time - k * SLOT) / TRAVEL);
    const p = lerp(PLACE[postAt(k - 1)], PLACE[postAt(k)], e);
    if (postAt(k - 1) !== postAt(k)) p[1] += sin(e * Math.PI) * 0.9;
    return p;
  }

  function buildFocus(x) {
    const list = WORKS[workOf(x.slot)];
    const i = Math.max(0, Math.min(list.length - 1, Math.floor(((x.c - TRAVEL - 0.2) / 4) * list.length)));
    if (x.c > TRAVEL + 5.2) return [21.6, 3.2, 6.2];
    return [21.6 + list[i][0], 1 + list[i][1], 6.2 + list[i][2]];
  }

  const applyArm = (p, side, a, k) => {
    add(p, `arm_${side}`, [a[0] * k, a[1] * k, a[2] * k]);
    add(p, `forearm_${side}`, [a[3] * k, 0, 0]);
  };

  function solve(pose, world, side, target, st) {
    // Seuls le bras et l'avant-bras bougent : on ne recopie que leurs rotations.
    const arm = pose.rot.get(`arm_${side}`);
    const fore = pose.rot.get(`forearm_${side}`);
    const a0 = [...arm];
    const f0 = [...fore];
    const error = (a) => {
      for (let i = 0; i < 3; i += 1) {
        arm[i] = a0[i];
        fore[i] = f0[i];
      }
      applyArm(pose, side, a, 1);
      const h = world.point(...xen.point(pose, `hand_${side}`));
      return (h[0] - target[0]) ** 2 + (h[1] - target[1]) ** 2 + (h[2] - target[2]) ** 2
        + 0.00003 * (a[0] ** 2 + a[1] ** 2 + a[2] ** 2 + a[3] ** 2);
    };
    let best = st.slice();
    let bestE = error(best);
    let step = 10;
    for (let it = 0; it < 5; it += 1) {
      for (let i = 0; i < 4; i += 1) {
        for (const sign of [-1, 1]) {
          const cand = best.slice();
          cand[i] = Math.max(-150, Math.min(150, cand[i] + sign * step));
          if (i === 3) cand[3] = Math.max(-140, Math.min(10, cand[3]));
          const e = error(cand);
          if (e < bestE) {
            bestE = e;
            best = cand;
          }
        }
      }
      step *= 0.6;
    }
    for (let i = 0; i < 3; i += 1) {
      arm[i] = a0[i];
      fore[i] = f0[i];
    }
    for (let i = 0; i < 4; i += 1) st[i] = best[i];
  }

  function xenodys(dt) {
    const x = { slot: Math.floor(t / SLOT) };
    x.c = t - x.slot * SLOT;
    x.post = postAt(x.slot);
    const base = baseAt(t);
    const next = baseAt(t + 0.05);
    const vel = [(next[0] - base[0]) / 0.05, (next[1] - base[1]) / 0.05, (next[2] - base[2]) / 0.05];
    base[1] += sin(t * 1.3) * 0.12;
    x.base = base;
    x.work = seg(x.c, TRAVEL - 0.2, TRAVEL + 0.8) * (1 - seg(x.c, SLOT - 0.9, SLOT - 0.2));
    const aim = focus(x.post);
    const from = PLACE[x.post];
    const wantYaw = x.post === 'TANK' ? 180 : Math.atan2(-(aim[0] - from[0]), -(aim[2] - from[2])) / RAD;
    S.bodyYaw += (mod(wantYaw - S.bodyYaw + 540, 360) - 180) * (1 - Math.exp(-2.6 * dt));
    const yawR = S.bodyYaw * RAD;
    const ahead = -vel[0] * sin(yawR) - vel[2] * cos(yawR);
    const side = vel[0] * cos(yawR) - vel[2] * sin(yawR);
    x.world = new M4().translate(...base).rotY(yawR).rotX(-Math.max(-14, Math.min(16, ahead * 4)) * RAD)
      .rotZ(-Math.max(-14, Math.min(14, side * 4)) * RAD).scale(XS);

    const pose = xen.pose(corrupted() ? 'corrupted_idle' : 'idle', t);
    const travel = Math.min(1, Math.hypot(...vel) / 2.5);
    if (travel > 0.02) {
      const flap = sin(t * 8) * 14 * travel;
      add(pose, 'wing_left', [0, flap, 0]);
      add(pose, 'wing_right', [0, -flap, 0]);
      add(pose, 'skirt_front', [-16 * travel, 0, 0]);
    }
    add(pose, 'chest', [5 + 5 * x.work, 0, 0]);

    let wr = null;
    let wl = null;
    const w = x.c - TRAVEL;
    if (x.post === 'REACTOR') {
      const a = t * 1.7;
      wr = plus(aim, cos(a) * 0.5 + 1.2, sin(a) * 0.5, 1.1);
      wl = plus(aim, cos(a + Math.PI) * 0.4 + 1.5, 0.8 + sin(a + Math.PI) * 0.4, -0.1);
    } else if (x.post === 'HOLO') {
      const open = 0.75 + 0.4 * sin(w * 1.1);
      wr = plus(aim, 0.7, 0.2, -open);
      wl = plus(aim, 0.7, 0.2, open);
    } else if (x.post === 'SPECIMEN') {
      wr = plus(aim, -0.7 + 0.25 * sin(w * 0.9), 0.5 * sin(w * 0.7), 1.25);
      wl = plus(aim, -1.3, 0.9 + 0.15 * sin(w * 2), 1.6);
    } else if (x.post === 'BUILD') {
      wr = lerp(buildFocus(x), plus(base, 0, 4.3, 0), 0.45);
      wl = plus(base, 1.4, 4.4 + 0.3 * sin(w * 2.2), 1.6);
    } else {
      const press = 0.5 + 0.5 * sin(w * 0.8);
      wr = [CX - 1.5, 6.4 + 0.25 * sin(w * 1.3), 10.1 + 0.15 * press];
      wl = [CX + 1.5, 6.4 + 0.25 * sin(w * 1.3 + 2), 10.1 + 0.15 * press];
      if (w > 3.2 && w < 6.2) {
        wr = [CX - 0.5, 8.1, 10.4];
        wl = [CX + 0.5, 8.1, 10.4];
      }
    }
    S.armWeight = damp(S.armWeight, x.work, 4, dt);
    const k5 = 1 - Math.exp(-5 * dt);
    S.handR = S.handR ? lerp(S.handR, wr, k5) : wr;
    S.handL = S.handL ? lerp(S.handL, wl, k5) : wl;
    for (let f = 0; f < 4; f += 1) {
      S.curls[f] = damp(S.curls[f], x.work * 26 * Math.max(0, sin(t * 5 + f)), 8, dt);
      S.curls[f + 4] = damp(S.curls[f + 4], x.work * 26 * Math.max(0, sin(t * 5 + f + 2)), 8, dt);
      add(pose, `finger_right_${f}`, [S.curls[f], 0, 0]);
      add(pose, `finger_right_${f}_tip`, [S.curls[f] * 0.8, 0, 0]);
      add(pose, `finger_left_${f}`, [S.curls[f + 4], 0, 0]);
      add(pose, `finger_left_${f}_tip`, [S.curls[f + 4] * 0.8, 0, 0]);
    }
    const look = x.post === 'BUILD' ? buildFocus(x) : aim;
    const head = x.world.point(...xen.point(pose, 'head'));
    const d = x.world.inverse().dir(look[0] - head[0], look[1] - head[1], look[2] - head[2]);
    S.headYaw = damp(S.headYaw, Math.max(-58, Math.min(58, Math.atan2(d[0], -d[2]) / RAD)), 4, dt);
    S.headPitch = damp(S.headPitch, Math.max(-35, Math.min(42, Math.atan2(-d[1], Math.hypot(d[0], d[2])) / RAD)), 4, dt);
    add(pose, 'head', [S.headPitch * 0.7, S.headYaw * 0.7, 0]);
    add(pose, 'neck', [S.headPitch * 0.3, S.headYaw * 0.3, 0]);
    if (S.armWeight > 0.01) {
      solve(pose, x.world, 'right', S.handR, S.solvedR);
      solve(pose, x.world, 'left', S.handL, S.solvedL);
      for (let i = 0; i < 4; i += 1) {
        S.armR[i] = damp(S.armR[i], S.solvedR[i], 10, dt);
        S.armL[i] = damp(S.armL[i], S.solvedL[i], 10, dt);
      }
      applyArm(pose, 'right', S.armR, S.armWeight);
      applyArm(pose, 'left', S.armL, S.armWeight);
    }
    const blink = (t + 5 * 0.37) % (3.5 + 5 * 0.4) < 0.13;
    const name = `xenodys_${etat}${blink ? '_blink' : ''}`;
    model(xen, pose, x.world, entity.get(name), entity.get(`${name}_glowmask`), 1, corrupted() ? [0.95, 0.9, 0.94] : [1, 1, 1]);
    x.pose = pose;
    x.right = x.world.point(...xen.point(pose, 'hand_right'));
    x.left = x.world.point(...xen.point(pose, 'hand_left'));
    return x;
  }

  function construction(x, atlases) {
    if (x.post !== 'BUILD') return;
    const kind = workOf(x.slot);
    const list = WORKS[kind];
    const n = list.length;
    const from = data.posts.caisses;
    const power = seg(x.c, TRAVEL + 5, TRAVEL + 5.6) * (1 - seg(x.c, SLOT - 1.9, SLOT - 1.4));
    const gone = seg(x.c, SLOT - 1.9, SLOT - 0.2);
    const placed = [];
    list.forEach(([qx, qy, qz, side, top], i) => {
      const k = (x.c - placedAt(i, n)) / 0.75;
      if (k <= 0) return;
      const e = ease(k);
      const p = lerp(plus(from, hash(i) - 0.5, 1.2, hash(i * 3) - 0.5), [21.6 + qx, 1 + qy, 6.2 + qz], e);
      p[1] += sin(e * Math.PI) * 1.6;
      let size = (kind === 2 ? 0.6 : 0.98) * (0.35 + 0.65 * e);
      const m = new M4();
      if (kind === 2) m.translate(21.6, 3.6, 6.2).rotY(t * (0.6 + power * 2.4) * e).translate(-21.6, -3.6, -6.2);
      m.translate(...p).rotY((1 - e) * 5).rotX((1 - e) * 3);
      if (side === `${C}coeur` && kind !== 2) {
        m.translate(0, sin(t * 3) * 0.08 * power, 0).rotY(t * (0.5 + 3 * power));
        size *= 1 + 0.06 * sin(t * 7) * power;
      }
      if (gone > 0) {
        const g = Math.max(0, Math.min(1, (gone - hash(i * 7) * 0.35) / 0.65));
        m.translate((hash(i * 11) - 0.5) * 2.4 * g, 0.9 * g - 3.2 * g * g, (hash(i * 5) - 0.5) * 2 * g).rotX(g * 4).rotZ(g * 3);
        size *= 1 - g;
      }
      if (size < 0.02) return;
      placed.push([m.scale(size), side, top]);
    });
    P.use(atlases[etat]);
    for (const [m, s, u] of placed) block(m, s, u, false);
    P.flush();
    P.use(atlases[`${etat}_lueur`]);
    P.depth(false);
    for (const [m, s, u] of placed) block(m, s, u, true);
    P.flush();
    P.depth(true);
  }

  /* ------------------------------------------------------------- le joueur */

  function standing(m) {
    const p = m.pose(null, 0);
    const ph = (t * 2 * Math.PI) / 2.7;
    add(p, 'head', [4 - 3 * sin(ph * 2), 14 * sin(ph), 0]);
    add(p, 'right_arm', [-5 * sin(ph), 0, 3 + 2 * sin(ph * 2)]);
    add(p, 'left_arm', [5 * sin(ph), 0, -3 - 2 * sin(ph * 2)]);
    add(p, 'body', null, [0, sin(ph * 2) * 0.35, 0]);
    const slot = Math.floor(t / 9);
    const c = t - slot * 9;
    const on = ease(seg(c, 0.3, 0.8)) * (1 - ease(seg(c, 2.4, 3)));
    const h = hash(slot * 23 + 1);
    if (h < 0.4) add(p, 'right_arm', [-135 * on, 0, (-8 + 22 * sin(t * 9)) * on]);
    else if (h < 0.7) add(p, 'head', [-26 * on, 30 * on, 0]);
    return p;
  }

  function people(ratio, dt) {
    const who = gallery.find((g) => g.own && g.tex) ?? gallery.find((g) => g.tex);
    const want = TANK_FLOOR + (TANK_TOP - TANK_FLOOR) * Math.max(0, Math.min(1, ratio * 1.02));
    S.level = damp(S.level, want, 2.6, dt);
    if (!who) return;
    const m = who.slim ? slim : wide;
    const sub = (S.level - TANK_FLOOR) / (32 * PS);
    const swim = ease(seg(sub, 0.75, 1));
    let p = standing(m);
    const world = new M4();
    if (swim > 0) {
      const f = m.pose(null, 0);
      const ph = t * 1.7;
      const panic = corrupted() ? 1.9 : 1;
      add(f, 'right_arm', [-28 - 26 * sin(ph * panic), 0, 34 + 18 * sin(ph * panic + 0.8)]);
      add(f, 'left_arm', [-28 + 26 * sin(ph * panic), 0, -34 - 18 * sin(ph * panic + 1.6)]);
      add(f, 'right_leg', [18 * sin(ph * 1.3 * panic) - 6, 0, 4]);
      add(f, 'left_leg', [-18 * sin(ph * 1.3 * panic) - 6, 0, -4]);
      add(f, 'head', [8 * sin(ph * 0.6), 22 * sin(ph * 0.43), 0]);
      const slot = Math.floor(t / 6.5);
      const c = t - slot * 6.5;
      const on = ease(seg(c, 0.4, 1)) * (1 - ease(seg(c, 3.4, 4)));
      let act = Math.floor(hash(slot * 19 + 3) * 4);
      if (corrupted() && act === 2) act = 1;
      let flip = 0;
      if (act === 0) add(f, 'right_arm', [-120 * on, 0, (-10 + 24 * sin(t * 9)) * on]);
      else if (act === 1) {
        const knock = Math.max(0, sin(t * 10));
        add(f, 'right_arm', [(-62 - 18 * knock) * on, 0, -30 * on]);
        add(f, 'left_arm', [(-62 - 18 * (1 - knock)) * on, 0, 30 * on]);
      } else if (act === 2) {
        flip = ease(seg(c, 0.6, 3)) * 360;
        const tuck = sin(seg(c, 0.6, 3) * Math.PI);
        add(f, 'right_leg', [-70 * tuck, 0, 0]);
        add(f, 'left_leg', [-70 * tuck, 0, 0]);
      } else add(f, 'head', [-34 * on, 0, 0]);
      const out = { rot: new Map(), pos: p.pos };
      for (const [n, a] of p.rot) {
        const b = f.rot.get(n);
        out.rot.set(n, [a[0] + (b[0] - a[0]) * swim, a[1] + (b[1] - a[1]) * swim, a[2] + (b[2] - a[2]) * swim]);
      }
      p = out;
      const turn = act === 1 || act === 0 ? 0 : 1;
      const mid = 16 * PS;
      world.translate(CX + sin(t * 0.6) * 0.14 * swim, TANK_FLOOR + (0.28 + sin(t * 1.1) * 0.14) * swim + mid, CZ + cos(t * 0.5) * 0.1 * swim)
        .rotY((180 + sin(t * 0.35) * 40 * (0.35 + 0.65 * turn) * swim) * RAD).rotX(((-8 + 6 * sin(t * 0.8)) * swim - flip) * RAD)
        .rotZ(5 * sin(t * 0.7) * swim * RAD).translate(0, -mid, 0).scale(PS);
    } else {
      world.translate(CX, TANK_FLOOR, CZ).rotY(Math.PI).scale(PS);
      const wade = seg(sub, 0.25, 0.7);
      if (wade > 0) {
        add(p, 'right_arm', [-20 * wade, 0, 48 * wade]);
        add(p, 'left_arm', [-20 * wade, 0, -48 * wade]);
      }
    }
    model(m, p, world, who.tex, null, 1, corrupted() ? [0.91, 0.84, 0.89] : swim > 0.4 ? [0.85, 0.96, 0.94] : [1, 1, 1]);
    mouth = world.point(...m.point(p, 'head', 0, 3, -5));
  }

  /* --------------------------------------------------------- les assistants */

  function bots(atlases) {
    if (shown < entries.length * 0.4) return;
    const tex = entity.get(`xenodys_assistant_${etat}`);
    const glow = entity.get(`xenodys_assistant_${etat}_glowmask`);
    const p = bot.pose('idle', t);
    const type = t * 2 * Math.PI;
    add(p, 'arm_left', [-85 + 22 * sin(type * 1.3), 0, -10]);
    add(p, 'arm_right', [-85 + 22 * sin(type * 1.3 + Math.PI), 0, 10]);
    add(p, 'head', [6 * sin(t * 0.9), 16 * sin(t * 0.5), 0]);
    model(bot, p, new M4().translate(28.1, 1, 6.5).rotY(-90 * RAD).scale(BOT), tex, glow);
    const window = 9;
    const idx = Math.floor(t / window);
    let paused = 0;
    for (let i = Math.max(0, idx - 60); i < idx; i += 1) if (hash(i * 7 + 3) < 0.45) paused += 2.3;
    const local = t - idx * window;
    let fall = -1;
    if (hash(idx * 7 + 3) < 0.45) {
      if (local >= 3 && local < 5.3) fall = local - 3;
      paused += Math.max(0, Math.min(2.3, local - 3));
    }
    const walk = t - paused;
    const arc = 1.9;
    const q = mod(walk * 0.2, 2 * arc);
    const toRight = q < arc;
    const at = (toRight ? q : 2 * arc - q) - arc / 2;
    const bx = CX + sin(at) * 4.75;
    const bz = CZ + cos(at) * 4.75;
    const facing = at / RAD + (toRight ? -90 : 90);
    const w = bot.pose('idle', t);
    let rx = 0;
    if (fall >= 0) {
      const k = fall < 0.6 ? ease(fall / 0.6) : fall < 1.4 ? 1 : 1 - ease((fall - 1.4) / 0.9);
      rx = -88 * k;
      add(w, 'arm_left', [-140 * k, 0, -20]);
      add(w, 'arm_right', [-140 * k, 0, 20]);
    } else {
      const st = sin(walk * 2 * Math.PI * 1.2);
      add(w, 'leg_left', [35 * st, 0, 0]);
      add(w, 'leg_right', [-35 * st, 0, 0]);
      add(w, 'arm_left', [-78, 0, -6]);
      add(w, 'arm_right', [-78, 0, 6]);
      add(w, 'body', null, [0, Math.abs(st) * 0.8, 0]);
    }
    model(bot, w, new M4().translate(bx, TOP - 1, bz).rotY(facing * RAD).rotX(rx * RAD).scale(BOT), tex, glow);
    const fwd = fall < 0 ? 0.72 : 0.72 + 0.45 * ease(fall / 0.8);
    const hgt = fall < 0 ? 0.92 : 0.92 - 0.69 * ease(fall / 0.5);
    const fa = facing * RAD;
    P.use(atlases[etat]);
    block(new M4().translate(bx - sin(fa) * fwd, TOP - 1 + hgt, bz - cos(fa) * fwd).rotY(fa).rotX(fall < 0 ? 0 : -1.57 * ease(fall / 0.8)).scale(0.46), `${C}cote`, `${C}puce`, false);
    P.flush();
  }

  /* ---------------------------------------------------- liquide et effets */

  function liquid() {
    const y0 = TANK_FLOOR - 0.05;
    const y1 = S.level;
    if (y1 - y0 < 0.06) return;
    const r = 1.62 / cos(Math.PI / 8);
    const tint = rgbOf(corrupted() ? 0xc0264c : 0x4fd9c8);
    P.use(white);
    const edge = (i) => [CX + cos((i * Math.PI) / 4) * r, CZ + sin((i * Math.PI) / 4) * r];
    for (let i = 0; i < 8; i += 1) {
      const p = edge(i - 0.5);
      const q = edge(i + 0.5);
      for (let y = y0; y < y1; y += 0.25) {
        const top = Math.min(y1, y + 0.25);
        const wave = 0.5 + 0.5 * sin(y * 5 - t * 1.6 + i);
        rect([p[0], top, p[1]], [p[0], y, p[1]], [q[0], y, q[1]], [q[0], top, q[1]], tint, 0.2 + (0.06 * Math.round(wave * 2)) / 2);
      }
    }
    for (let i = 0; i < 8; i += 1) {
      const p = edge(i - 0.5);
      const q = edge(i + 0.5);
      const a = [p[0], y1 + sin(t * 2 + i) * 0.03, p[1]];
      const b = [q[0], y1 + sin(t * 2 + i + 1) * 0.03, q[1]];
      rect([CX, y1, CZ], a, b, [CX, y1, CZ], accent(), 0.4);
      rect(a, plus(a, 0, -0.06, 0), plus(b, 0, -0.06, 0), b, core(), 0.85);
    }
    P.flush();
    P.additive(true);
    for (let i = 0; i < 46; i += 1) {
      const life = (t * (0.35 + hash(i) * 0.35) + hash(i * 3)) % 1;
      const breath = i < 8;
      const rr = Math.sqrt(hash(i * 5)) * 1.4;
      const an = hash(i * 7) * Math.PI * 2;
      const o = breath ? mouth : [CX + cos(an) * rr, y0, CZ + sin(an) * rr];
      const y = o[1] + life * (breath ? 2.2 : y1 - y0);
      if (y > y1 - 0.05 || y < y0) continue;
      spark([o[0] + sin(t * 3 + i) * 0.07, y, o[2] + cos(t * 2 + i) * 0.07], 0.05 + hash(i * 11) * 0.07, core(), 0.55);
    }
    P.flush();
    P.additive(false);
  }

  function effects(x, beat) {
    P.use(white);
    P.additive(true);
    if (x && x.work > 0.02) {
      const w = x.c - TRAVEL;
      const aim = focus(x.post);
      if (x.post === 'REACTOR') {
        beam(x.right, aim, 0.075, x.work * 0.9, 1);
        beam(x.left, aim, 0.075, x.work * 0.9, 5);
        for (let i = 0; i < 18; i += 1) {
          const a = t * 4 + (i * Math.PI) / 9;
          const r = 0.8 + 0.25 * sin(t * 5 + i);
          spark([aim[0] + cos(a) * r, aim[1] + sin(t * 3 + i * 2) * 0.6, aim[2] + sin(a) * r], 0.07, accent(), x.work * 0.8);
        }
      } else if (x.post === 'HOLO') {
        for (let i = 0; i < 26; i += 1) {
          const k = (t * 0.6 + hash(i)) % 1;
          spark(plus(lerp(i % 2 === 0 ? x.right : x.left, aim, k), 0, sin(k * Math.PI) * 0.35, 0), 0.06, i % 5 === 0 ? core() : accent(), x.work * 0.8);
        }
        ring(aim, 1.15 + 0.3 * sin(w * 1.1), x.work * 0.7, 30);
      } else if (x.post === 'SPECIMEN') {
        beam(x.right, plus(aim, 0, 0, 0.6), 0.06, x.work * 0.7, 3);
        ring(plus(aim, 0, sin(w * 1.4) * 1.1, 0), 1, x.work * 0.6, 28);
      } else if (x.post === 'BUILD') {
        if (w < 5) beam(x.right, buildFocus(x), 0.065, x.work * 0.85, 2);
        const power = seg(w, 5, 5.6) * (1 - seg(x.c, SLOT - 1.9, SLOT - 1.4));
        if (power > 0) {
          const o = [21.6, workOf(x.slot) === 0 ? 2.6 : 3.6, 6.2];
          beam(x.right, o, 0.08, power, 2);
          beam(x.left, o, 0.08, power, 7);
          ring(o, 1.5 + 0.2 * sin(t * 5), power, 40);
          for (let i = 0; i < 24; i += 1) {
            const k = (t * 0.8 + hash(i)) % 1;
            const a = hash(i * 3) * Math.PI * 2;
            spark([o[0] + cos(a) * (0.4 + k), o[1] - 1 + k * 3, o[2] + sin(a) * (0.4 + k)], 0.08, accent(), power * (1 - k));
          }
        }
      } else {
        const orb = seg(w, 3.4, 4.2) * (1 - seg(w, 6.4, 6.6));
        if (orb > 0) {
          const o = lerp(plus(lerp(x.right, x.left, 0.5), 0, 0.2, 0.3), [CX, TANK_TOP - 0.2, CZ], ease(seg(w, 5.2, 6.4)));
          for (let i = 0; i < 30; i += 1) {
            const a = hash(i) * Math.PI * 2 + t * 3;
            const b = hash(i * 3) * Math.PI;
            const r = 0.12 + 0.26 * hash(i * 5) * orb;
            spark([o[0] + cos(a) * sin(b) * r, o[1] + cos(b) * r, o[2] + sin(a) * sin(b) * r], 0.09, i % 3 === 0 ? core() : accent(), orb);
          }
        }
        const splash = seg(w, 6.3, 6.5) * (1 - seg(w, 7.6, 8.2));
        if (splash > 0) for (let i = 0; i < 3; i += 1) ring([CX, S.level - i * 0.6 * seg(w, 6.4, 7.6), CZ], 0.5 + seg(w, 6.3, 7.4), splash * 0.8, 30);
      }
    }
    ring([CX, TOP + 0.04, CZ], 3.1, 0.22 + 0.1 * sin(t * 2) + beat * 0.5, 60);
    for (let i = 0; i < 70; i += 1) {
      const life = (t * 0.03 * (1 + hash(i)) + hash(i * 5)) % 1;
      spark([1.5 + hash(i * 3) * 28 + sin(t * 0.4 + i) * 0.5, 1.2 + life * 14, 1.5 + hash(i * 7) * 20], 0.045, accent(), 0.5 * sin(life * Math.PI));
    }
    // L'onde de conversion, à la bascule d'un état à l'autre.
    const shift = t - switchedAt;
    if (shift < 1.6) for (let k = 0; k < 4; k += 1) ring([CX, TOP + 0.2 + k * 1.4, CZ], 1 + shift * 9, (1 - shift / 1.6) * 0.9, 90);
    P.flush();
    P.additive(false);
  }

  /* -------------------------------------------------------------- l'image */

  return {
    data,
    /**
     * @param {number} w, h   taille du canevas (pixels)
     * @param {number} time   horloge de la scène (secondes)
     * @param {{ratio: number|null, etat: string, beat?: number, camera?: object}} v
     */
    render(w, h, time, v) {
      const dt = S.lastT < 0 ? 0 : Math.max(0, Math.min(0.1, time - S.lastT));
      const opening = S.lastT < 0;
      S.lastT = time;
      t = time;
      const wanted = v.etat === 'corrompue' ? 'corrompue' : 'creatrice';
      if (wanted !== etat) {
        before = opening ? wanted : etat;
        etat = wanted;
        switchedAt = opening ? -10 : t;
      }
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const cam = v.camera ?? {};
      eye = cam.eye ?? [CX, 5.6, 25.4];
      view = M4.lookAt(eye, cam.target ?? [CX, 6, 0]);
      const proj = M4.perspective((cam.fov ?? 56) * RAD, w / Math.max(1, h), 0.4, 70, cam.shiftX ?? 0, cam.shiftY ?? 0);
      viewRot = view.clone();
      viewRot.m[12] = viewRot.m[13] = viewRot.m[14] = 0;
      right = [view.m[0], view.m[4], view.m[8]];
      up = [view.m[1], view.m[5], view.m[9]];
      P.begin(w, h, proj.mul(view));
      const atlases = {};
      for (const e of ['creatrice', 'corrompue']) {
        atlases[e] = data.atlas(e, false, t);
        atlases[`${e}_lueur`] = data.atlas(e, true, t);
      }
      const glows = { creatrice: atlases.creatrice_lueur, corrompue: atlases.corrompue_lueur };
      assemble(v.ratio);
      pieceCache = [];
      for (const p of data.pieces) {
        if (p.state && p.state !== etat) continue;
        if (p.owner === tankIndex || !(t - shownAt[p.owner] >= DROP)) continue;
        pieceCache.push([p, pieceMatrix(p, t * 20 + boost(p.owner) * 50)]);
      }
      drawLayer(BASE, atlases);
      P.use(atlases[etat]);
      tank(BASE);
      pieces(BASE);
      P.depth(false);
      drawLayer(GLOW, glows);
      P.use(glows[etat]);
      tank(GLOW);
      pieces(GLOW);
      P.depth(true);
      screens();
      let x = null;
      if (actors) {
        x = xenodys(dt);
        construction(x, atlases);
        people(v.ratio ?? 1, dt);
      }
      bots(atlases);
      P.depth(false);
      drawLayer(TRANS, atlases);
      P.use(atlases[etat]);
      pieces(TRANS);
      if (actors) {
        liquid();
        P.use(atlases[etat]);
        tank(TRANS);
      }
      P.depth(true);
      effects(x, v.beat ?? 0);
    },
    /** Les skins à montrer dans la cuve : `{data, slim, own}` (data: URL). */
    setGallery(list) {
      gallery = list.map((s) => {
        const entry = { slim: Boolean(s.slim), own: Boolean(s.own), tex: null };
        if (s.data) {
          const img = new Image();
          img.onload = () => {
            entry.tex = P.texture(img);
          };
          img.src = s.data;
        }
        return entry;
      });
    },
    /** Les deux logos de l'écran du fond (images déjà chargées). */
    async setBanners(sources) {
      const out = {};
      for (const [e, src] of Object.entries(sources)) {
        const img = new Image();
        img.src = src;
        try {
          await img.decode();
          out[e] = { tex: P.smooth(P.texture(img)), ratio: img.naturalHeight / img.naturalWidth };
        } catch {
          /* sans logo */
        }
      }
      banners = out;
    },
    dispose() {
      P.dispose();
    },
  };
}

/**
 * La salle, en fond du launcher : 30 images par seconde, à l'arrêt quand la fenêtre est
 * cachée, une image fixe si le système demande moins d'animations.
 * @param {HTMLCanvasElement} canvas
 * @param {{pulse?: () => number, anchor?: () => {x: number, y: number}|null}} options
 *   `anchor` : où doit tomber le dessus de la plateforme (fractions du fond, 0 → 1)
 */
export async function createLabBackground(canvas, { pulse = () => 0, anchor = () => null } = {}) {
  const scene = await createLabScene(canvas, { actors: false });
  await scene.setBanners({ creatrice: 'assets/images/bandeau-opm.png', corrompue: 'assets/sprites/bandeau_corrompue.png' });
  const root = document.documentElement;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const start = performance.now();
  let raf = 0;
  let last = 0;
  let disposed = false;

  function draw(now) {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    // Taille de mise en page : le cadre peut être réduit (transform) pendant la cinématique.
    const w = Math.max(1, Math.round(canvas.offsetWidth * dpr));
    const h = Math.max(1, Math.round(canvas.offsetHeight * dpr));
    const at = anchor() ?? { x: 0.72, y: 0.66 };
    // La caméra : la plateforme au point voulu, le reste de la salle derrière elle.
    const eyeAt = [13.2, 6.4, 27.4];
    const target = [13.4, 6.2, 0];
    const fov = 46;
    const view = M4.lookAt(eyeAt, target);
    const p = view.point(CX, TOP, CZ);
    const f = 1 / Math.tan((fov * RAD) / 2);
    const aspect = w / h;
    const shiftX = at.x * 2 - 1 - ((f / aspect) * p[0]) / -p[2];
    const shiftY = 1 - at.y * 2 - (f * p[1]) / -p[2];
    scene.render(w, h, (now - start) / 1000 + 20, {
      ratio: null, etat: root.dataset.xenodys, beat: Math.min(1, Math.max(0, pulse() || 0)), camera: { eye: eyeAt, target, fov, shiftX, shiftY },
    });
  }

  function loop(now) {
    raf = 0;
    if (disposed) return;
    // Couvert par la scène de chargement : rien à dessiner.
    if (now - last >= 1000 / 30 - 3 && !document.querySelector('.opm-loading[data-visible]')) {
      last = now;
      draw(now);
    }
    if (!document.hidden) raf = requestAnimationFrame(loop);
  }
  const wake = () => {
    if (!raf && !disposed && !document.hidden && !still) raf = requestAnimationFrame(loop);
  };
  document.addEventListener('visibilitychange', wake);
  const redraw = () => {
    if (still) draw(performance.now());
  };
  window.addEventListener('resize', redraw);
  draw(performance.now());
  wake();
  return {
    data: scene.data,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('resize', redraw);
      scene.dispose();
    },
  };
}
