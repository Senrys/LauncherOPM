/**
 * Le mouvement de Xenodys la Tisseuse et de ses assistants : ce que leurs os font en
 * plus des animations (ailes, robe, cheveux, planétaire, monde entre ses mains…).
 * Les formules sont celles d'OPMTech ; le mod a les mêmes (client/Tisseuse).
 *
 * `inp(os)` : l'angle que donnent l'animation et les gestes, en radians (convention
 * Bedrock), pour les os d'origine. `out(os, r, p, s, abs)` : rotation à ajouter au
 * repos (radians), position (pixels), échelle ; `abs` : remplace l'angle de l'animation.
 */

const { sin, cos, max, min, abs, PI } = Math;
const lim = (v, a, b) => min(b, max(a, v));
const RANGS = [[9, 52, 308], [8, 64, 296], [7, 76, 284]];
const PLUMES = [9, 8, 7];

function tisseuse(t, inp, out, { hands = 1, blink = false } = {}) {
  const body = inp('body');
  const chest = inp('chest');
  const head = inp('head');
  for (const [side, g, s] of [['left', 'g', 1], ['right', 'd', -1]]) {
    const arm = inp(`arm_${side}`);
    const fore = inp(`forearm_${side}`);
    out(`pauldron_${side}`, [0, 0, -s * 0.25 * max(0, -s * arm[2])]);
    out(`manche_${g}`, [lim(-0.55 * (arm[0] + fore[0] + body[0] + chest[0]), -0.3, 1.1) + 0.05 * sin(1.3 * t + s), 0, 0.04 * sin(1.1 * t + s)]);
    out(`meche_${g}`, [lim(-0.5 * (head[0] + body[0] + chest[0]), -0.2, 0.7) + 0.03 * sin(1.5 * t + s), 0, 0]);
    // Les ailes.
    const wing = inp(`wing_${side}`);
    const ouv = -s * wing[2];
    for (let w = 0; w < 3; w += 1) {
      const part = ouv > 0 ? [0.28, 0.22, -0.1][w] : [0.75, 0.45, 0.18][w];
      const shut = ouv < 0 ? -ouv : 0;
      out(`aile_${w}_${g}`, [0, 0.5 * wing[1] - s * (0.1 + 0.04 * sin(1.1 * t - 0.7 * w)) - 0.45 * s * shut, -s * ouv * part + 0.02 * s * sin(1.1 * t - 0.9 * w)]);
      const n = PLUMES[w];
      for (let k = 0; k < n; k += 1) {
        const q = k / (n - 1);
        out(`aile_${w}_${k}_${g}`, [0, 0, s * (-0.16 * ouv * (q - 0.35) + 0.018 * sin(1.4 * t - 0.55 * k - w) + 0.22 * shut * (1 - q))]);
      }
    }
  }
  // Les cheveux.
  let rx = 0;
  let rz = 0;
  for (let i = 0; i < 4; i += 1) {
    const c = inp(`cable_${i}`);
    rx += c[0] / 4;
    rz += c[2] / 4;
  }
  rx = lim(rx, -0.5, 0.55);
  for (let i = 0; i < 9; i += 1) {
    const u = (i - 4) / 4;
    out(`fibre_${i}`, [0.55 * rx + 0.035 * sin(1.6 * t + 1.1 * i), 0, 0.55 * rz - 0.05 * u * max(0, rx) + 0.03 * sin(1.3 * t + i)]);
    out(`fibre_${i}_b`, [0.5 * rx + 0.06 * sin(1.6 * t + 1.1 * i - 0.9), 0, 0.5 * rz + 0.05 * sin(1.3 * t + i - 0.8)]);
  }
  out('astres', [0, 0, 0.16 * sin(0.5 * t)], [0, -0.5 * sin(0.8 * t), 0]);
  // Les jambes, la robe.
  const sp = inp('spire');
  const spire = [lim(sp[0] - 0.8 * body[0], -0.35, 1.35), 0, lim(sp[2] - 0.8 * body[2], -0.5, 0.5)];
  out('spire', spire, null, null, true);
  out('pointe', [0, 0.9 * t, 0]);
  const sl = inp('skirt_left');
  const sr = inp('skirt_right');
  const sb = inp('skirt_back');
  const sf = inp('skirt_front');
  const traine = (sl[0] + sr[0]) / 2 + 0.25 * sb[0];
  const travers = 0.4 * (sl[2] + sr[2]);
  RANGS.forEach(([n, a0, a1], rang) => {
    for (let i = 0; i < n; i += 1) {
      const a = ((a0 + ((a1 - a0) * i) / (n - 1)) * PI) / 180;
      const ca = cos(a);
      const sa = sin(a);
      const ouvre = lim(max(0, sa) * -sl[2] + max(0, -sa) * sr[2] + max(0, -ca) * lim(sb[0], -0.1, 0.5) + 0.4 * max(0, ca) * lim(-sf[0], 0, 0.5), -0.12, 0.8);
      const suit = spire[0] * (0.45 + (0.5 * (1 - ca)) / 2);
      const phi = 0.8 * ouvre + 0.025 * sin(1.5 * t + 0.8 * i + 0.7 * rang);
      const phi2 = 0.35 * ouvre + 0.04 * sin(1.5 * t + 0.8 * i + 0.7 * rang - 0.9);
      out(`petale_${rang}_${i}`, [suit + 0.35 * traine - phi * ca, 0, 0.8 * spire[2] + travers - phi * sa]);
      out(`petale_${rang}_${i}_b`, [0.4 * traine - phi2 * ca + 0.08 * suit, 0, 0.5 * travers - phi2 * sa]);
    }
  });
  // Le planétaire.
  const halo = inp('halo');
  const inner = inp('halo_inner');
  const pz = 0.4 * halo[2];
  out('planetaire', [0.5 * halo[0], 0, pz]);
  const rings = [0.13 * t + 0.3 * inner[2], -0.085 * t - 0.5 * halo[2], 0.055 * t + 0.25 * halo[2]];
  rings.forEach((z, i) => out(`anneau_${i}`, [0, 0, z]));
  for (let k = 0; k < 7; k += 1) {
    const ring = rings[k < 2 ? 0 : k < 4 ? 1 : 2];
    out(`monde_${k}`, [0, 0.2 * t + k, -(pz + ring) - chest[2] - body[2]]);
  }
  // Le monde en création : entre ses mains, ou au-dessus d'elle quand elles servent.
  const h = 1 - hands;
  out('creation', [-body[0] * h, 0.25 * t, 0], [0, 38 * h - 0.5 * sin(1.1 * t), -6 * sin(PI * h) + 8.5 * h], [1 - 0.15 * h + 0.02 * sin(2 * t)]);
  out('creation_0', [0, -0.7 * t, 0]);
  out('creation_1', [0.2 * sin(0.7 * t), 0, 0.5 * t]);
  if (blink) out('visiere', null, null, [1, 0.12, 1]);
  out('coeur', null, null, [0]);
}

/** Les trois assistants. `walk` : 0 → 1. */
function graine(t, inp, out, { walk = 0 } = {}) {
  for (const side of ['left', 'right']) {
    const a = inp(`arm_${side}`);
    const k = max(abs(a[0]), abs(a[2])) > 0.9 ? 1 : 0.25;
    out(`arm_${side}`, [a[0] * k, a[1] * k, a[2] * k], null, null, true);
  }
  for (const [g, s] of [['g', 1], ['d', -1]]) out(`feuille_${g}`, [0, 0, s * (0.1 * sin(2.2 * t + s) + 0.25 * walk)]);
  out('cube', null, [0, -0.3 * sin(2.4 * t), 0]);
  out('halo', [0, 1.2 * t, 0], null, null, true);
}

function luciole(t, inp, out) {
  const head = inp('head');
  out('body', [head[0], head[1], head[2]]);
  for (const [g, s] of [['g', 1], ['d', -1]]) {
    out(`aile_0_${g}`, [0, 0.75 * s * sin(22 * t), 0]);
    out(`aile_1_${g}`, [0, 0.75 * s * sin(22 * t - 0.9), 0]);
  }
  for (const side of ['left', 'right']) {
    const a = inp(`arm_${side}`);
    out(`arm_${side}`, [0.6 * a[0], 0.6 * a[1], 0.6 * a[2]], null, null, true);
  }
  out('halo', [0, 1.2 * t, 0], null, null, true);
}

function fileuse(t, inp, out, { walk = 0 } = {}) {
  const l = inp('leg_left')[0];
  const r = inp('leg_right')[0];
  for (const [g, a, b] of [['g', l, r], ['d', r, l]]) {
    out(`patte_0_${g}`, [0.5 * a, 0, 0]);
    out(`patte_1_${g}`, [0.5 * b, 0, 0]);
    out(`pied_0_${g}`, [-0.25 * a, 0, 0]);
    out(`pied_1_${g}`, [-0.25 * b, 0, 0]);
  }
  for (const [side, s] of [['left', 1], ['right', -1]]) out(`arm_${side}`, [0.16 * sin(5 * t + 1.6 * s), 0, 0.1 * sin(5 * t + 1.6 * s + 1)]);
  out('bobine', [-t * (0.8 + 3 * walk), 0, 0]);
  out('halo', [0, 1.2 * t, 0], null, null, true);
}

export const DRIVERS = { xenodys_tisseuse: tisseuse, assistant_graine: graine, assistant_luciole: luciole, assistant_fileuse: fileuse };

/** Le décalage vertical (blocs) de la luciole, qui flotte. */
export const floatOf = (id, t) => (id === 'assistant_luciole' ? 0.12 + 0.08 * sin(2 * t) : 0);
