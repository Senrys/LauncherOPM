/**
 * Le fond du launcher : la salle de simulation de Xenodys.
 *
 * Un sol quadrillé en perspective qui fuit vers un mur de calibration, le tout
 * en gros pixels (une cellule = `P` pixels d'écran) : aplats sombres et lignes
 * aux couleurs du launcher, rien d'autre. Par-dessus :
 *
 * - des impulsions de données qui filent le long des lignes du sol ;
 * - un balayage de scan, de temps en temps, qui allume la grille sur son passage ;
 * - des repères de calibration (croix, règles graduées) ;
 * - la grille qui pulse doucement sur les temps de la musique (`pulse()`).
 *
 * Corrompue : magenta et rouge ; des pans de sol décalés d'un pixel, des cases
 * éteintes, un scan d'alerte plus fréquent, une luminosité qui bat. Quand l'état
 * bascule en cours de session, la grille se casse un instant.
 *
 * Les circuits incrustés (components/circuits.js) restent sur leur calque, au-dessus.
 * `prefers-reduced-motion` : une image fixe.
 */

/** Taille d'une cellule, en pixels d'écran : le grain du décor. */
const P = 4;
/** Images par seconde : un fond n'a pas besoin de plus. */
const FPS = 30;
/** Densité de la grille : lignes par unité du sol. */
const G = 2.5;

const PALETTES = {
  creatrice: {
    top: [4, 11, 10],
    horizon: [9, 30, 27],
    floor: [6, 17, 16],
    minor: [28, 88, 78],
    major: [52, 150, 135],
    bright: [145, 217, 209],
    core: [233, 255, 252],
    scan: [145, 217, 209],
  },
  corrompue: {
    top: [11, 4, 10],
    horizon: [34, 10, 30],
    floor: [16, 6, 15],
    minor: [86, 26, 80],
    major: [150, 44, 132],
    bright: [240, 80, 110],
    core: [255, 211, 221],
    scan: [255, 60, 80],
  },
};

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16;

/** Un hachage entier → [0, 1[ : le hasard reproductible des cases. */
function hash(a, b, c = 0) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{pulse?: () => number}} [options]  `pulse` : 0 → 1, l'enveloppe du dernier temps musical
 * @returns {{dispose: () => void}}
 */
export function createLab(canvas, { pulse = () => 0 } = {}) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const root = document.documentElement;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  let w = 0;
  let h = 0;
  let img = null;
  let buf = null;
  let etat = root.dataset.xenodys === 'corrompue' ? 'corrompue' : 'creatrice';
  /** Fin de la « casse » de la grille (bascule d'état), en secondes d'horloge. */
  let breakUntil = 0;
  let clock = 0;
  let last = performance.now();
  let raf = 0;
  let acc = 0;

  /** Les impulsions de données : sur une ligne du sol, de l'horizon vers nous. */
  const pulses = [];
  let nextPulse = 0.5;
  /** Le balayage : position de 0 (haut) à 1 (bas), ou rien. */
  let scan = null;
  let nextScan = 3;

  function resize() {
    // Taille de mise en page : le cadre peut être réduit (transform) pendant la cinématique.
    const r = { width: canvas.offsetWidth, height: canvas.offsetHeight };
    const nw = Math.max(1, Math.ceil(r.width / P));
    const nh = Math.max(1, Math.ceil(r.height / P));
    if (nw === w && nh === h) return;
    w = nw;
    h = nh;
    canvas.width = w;
    canvas.height = h;
    img = ctx.createImageData(w, h);
    buf = new Uint32Array(img.data.buffer);
  }

  const pack = (c) => (255 << 24) | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0]);

  /** La projection du sol : horizon, point de fuite, focale, profondeur du mur. */
  function view() {
    // `hy` : la ligne de fuite, cachée derrière le mur ; `yJ` : le pied du mur,
    // là où le sol s'arrête (profondeur `zWall`).
    const hy = h * 0.27;
    const K = h * 1.05;
    const zWall = 14;
    return { hy, yJ: Math.round(hy + K / zWall), vx: w * 0.56, F: h * 0.9, K, zWall };
  }

  function spawnPulse() {
    const vertical = Math.random() < 0.7;
    pulses.push({
      vertical,
      // Ligne du sol : abscisse entière (vertical) ou profondeur entière (horizontal).
      // En lignes de la grille (unités du sol × G).
      line: vertical ? Math.round((Math.random() - 0.5) * 60) : 5 + Math.floor(Math.random() * 25),
      pos: vertical ? 35 : (Math.random() < 0.5 ? -40 : 40),
      dir: vertical ? -1 : 0,
      speed: 8 + Math.random() * 10,
      len: 4 + Math.random() * 4,
    });
    if (pulses[pulses.length - 1].dir === 0) pulses[pulses.length - 1].dir = pulses[pulses.length - 1].pos > 0 ? -1 : 1;
  }

  function draw(dt) {
    if (!buf) return;
    const pal = PALETTES[etat];
    const corrupted = etat === 'corrompue';
    const { hy, yJ, vx, F, K, zWall } = view();
    const beat = Math.min(1, Math.max(0, pulse() || 0));
    // La luminosité de la grille : le temps musical, et, corrompue, un battement lent.
    const breath = corrupted ? 0.12 * (0.5 + 0.5 * Math.sin(clock * 2.4)) : 0;
    const glow = 1 + beat * (corrupted ? 0.55 : 0.35) + breath;
    const broken = clock < breakUntil ? (breakUntil - clock) / 1.2 : 0;
    const scroll = (clock * 0.35) % 1;
    // Les cases corrompues changent de sort quatre fois par seconde ; pendant une
    // bascule, dix fois.
    const epoch = Math.floor(clock * (broken > 0 ? 10 : 4));
    const scanY = scan ? scan.y * h : -999;
    const scanBand = corrupted ? 7 : 5;

    const cTop = pal.top;
    const cHor = pal.horizon;
    const cFloor = pal.floor;
    const minor = pal.minor;
    const major = pal.major;
    const bright = pal.bright;

    for (let y = 0; y < h; y += 1) {
      const scanK = scan ? Math.max(0, 1 - Math.abs(y - scanY) / scanBand) : 0;
      const row = y * w;
      if (y < yJ) {
        // Le mur : lignes au pas du sol, de plus en plus pâles vers le haut.
        const up = (yJ - y) / yJ;
        const base = mix(cHor, cTop, Math.min(1, up * 1.4));
        const wy = ((yJ - y) * zWall * G) / F;
        const ly = Math.abs(wy - Math.round(wy)) < (0.5 * zWall * G) / F;
        const fade = 1 - up;
        for (let x = 0; x < w; x += 1) {
          const wx = ((x - vx) * zWall * G) / F;
          const lx = Math.abs(wx - Math.round(wx)) < (0.5 * zWall * G) / F;
          let c = base;
          if ((lx || ly) && fade * 0.75 > bayer(x, y)) {
            const isMajor = (lx && Math.round(wx) % 4 === 0) || (ly && Math.round(wy) % 4 === 0);
            c = mix(base, isMajor ? major : minor, Math.min(1, (isMajor ? 0.7 : 0.45) * glow * fade));
          }
          if (scanK > 0) c = mix(c, pal.scan, scanK * (lx || ly ? 0.5 : 0.12));
          buf[row + x] = pack(c);
        }
        continue;
      }
      // Le sol.
      const dy = y - hy + 0.5;
      const z = K / dy;
      const zw = (z + scroll) * G;
      const dz = (K / (dy * dy)) * G;
      const nearZ = Math.round(zw);
      const onZ = Math.abs(zw - nearZ) < dz * 0.55;
      // Au loin, les lignes s'éteignent (trame) : pas de moiré à l'horizon.
      const far = Math.min(1, z / zWall);
      const vis = (1 - far) ** 1.3;
      const base = mix(cFloor, cHor, far ** 2);
      const dx = (z / F) * G;
      for (let x = 0; x < w; x += 1) {
        let wx = (x - vx) * dx;
        if (corrupted || broken > 0) {
          // Un pan de sol (4 × 4) décalé, ou éteint.
          const tx = Math.floor(wx / 8);
          const tz = Math.floor(zw / 8);
          const r = hash(tx, tz, epoch);
          const dead = broken > 0 ? 0.35 * broken : 0.07;
          const shifted = broken > 0 ? 0.5 * broken : 0.12;
          if (r < dead) {
            buf[row + x] = pack(base);
            continue;
          }
          if (r < dead + shifted) wx += (r < dead + shifted / 2 ? 1 : -1) * dx;
        }
        const nearX = Math.round(wx);
        const onX = Math.abs(wx - nearX) < dx * 0.55;
        let c = base;
        if ((onX || onZ) && vis > bayer(x, y) * 0.9) {
          const isMajor = (onX && nearX % 4 === 0) || (onZ && nearZ % 4 === 0);
          c = mix(base, isMajor ? major : minor, Math.min(1, (isMajor ? 0.95 : 0.6) * glow));
        }
        if (scanK > 0) c = mix(c, pal.scan, scanK * (onX || onZ ? 0.7 : 0.15));
        buf[row + x] = pack(c);
      }
    }

    // L'horizon : la jonction du sol et du mur, un filet lumineux tramé.
    for (let x = 0; x < w; x += 1) {
      const edge = 1 - Math.abs(x - vx) / (w * 0.75);
      if (edge * 0.8 * glow > bayer(x, yJ)) buf[yJ * w + x] = pack(mix(major, bright, 0.4));
      if (edge * 0.35 > bayer(x, yJ - 1)) buf[(yJ - 1) * w + x] = pack(major);
    }

    // Les impulsions de données.
    for (const p of pulses) {
      p.pos += p.dir * p.speed * dt;
      for (let s = 0; s < 40; s += 1) {
        const back = (s / 40) * p.len;
        const k = 1 - s / 40;
        let X;
        let Z;
        if (p.vertical) {
          X = p.line;
          Z = p.pos - p.dir * back;
        } else {
          Z = p.line;
          X = p.pos - p.dir * back;
        }
        const zs = Z / G - scroll;
        if (zs <= 0.35 || zs > zWall) continue;
        const py = Math.round(hy + K / zs - 0.5);
        const px = Math.round(vx + (X / G * F) / zs);
        if (px < 0 || px >= w || py <= yJ || py >= h) continue;
        if (k < bayer(px, py) * 0.8) continue;
        buf[py * w + px] = pack(s < 3 ? pal.core : mix(major, bright, k));
      }
    }
    for (let i = pulses.length - 1; i >= 0; i -= 1) {
      const p = pulses[i];
      if ((p.vertical && p.pos < 0) || (!p.vertical && Math.abs(p.pos) > 44)) pulses.splice(i, 1);
    }

    markers(pal);
    ctx.putImageData(img, 0, 0);
  }

  /** Les repères de calibration : croix aux coins de la salle, règles graduées. */
  function markers(pal) {
    const put = (x, y, c) => {
      if (x >= 0 && x < w && y >= 0 && y < h) buf[y * w + x] = pack(c);
    };
    const col = mix(pal.minor, pal.bright, 0.35);
    const top = Math.ceil(52 / P);
    const bottom = h - Math.ceil(104 / P);
    const inset = 4;
    for (const [cx, cy] of [[inset + 2, top + 2], [w - inset - 3, top + 2], [inset + 2, bottom - 2], [w - inset - 3, bottom - 2]]) {
      for (let k = -2; k <= 2; k += 1) {
        if (k === 0) continue;
        put(cx + k, cy, col);
        put(cx, cy + k, col);
      }
    }
    // Règle verticale le long du bord droit, règle horizontale au pied du mur.
    for (let y = top + 6; y < bottom - 6; y += 2) {
      const majorTick = (y - top) % 8 === 0;
      put(w - inset - 1, y, col);
      if (majorTick) put(w - inset - 2, y, col);
    }
    const { yJ } = view();
    for (let x = Math.round(w * 0.3); x < w - inset - 6; x += 3) {
      put(x, yJ - 3, mix(pal.horizon, col, (x / 3) % 4 === 0 ? 0.9 : 0.5));
    }
  }

  function step(dt) {
    clock += dt;
    nextPulse -= dt;
    if (nextPulse <= 0) {
      spawnPulse();
      nextPulse = 0.6 + Math.random() * 1.6;
    }
    nextScan -= dt;
    if (!scan && nextScan <= 0) scan = { y: -0.05 };
    if (scan) {
      scan.y += dt / (etat === 'corrompue' ? 1.8 : 2.6);
      if (scan.y > 1.05) {
        scan = null;
        nextScan = etat === 'corrompue' ? 5 + Math.random() * 3 : 9 + Math.random() * 4;
      }
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    if (acc < 1 / FPS) return;
    const frameDt = acc;
    acc = 0;
    resize();
    step(frameDt);
    draw(frameDt);
  }

  const observer = new MutationObserver(() => {
    const next = root.dataset.xenodys === 'corrompue' ? 'corrompue' : 'creatrice';
    if (next === etat) return;
    etat = next;
    breakUntil = clock + 1.2;
    if (reduced) {
      resize();
      draw(0);
    }
  });
  observer.observe(root, { attributes: true, attributeFilter: ['data-xenodys'] });

  const sizer = new ResizeObserver(() => {
    resize();
    if (reduced) draw(0);
  });
  sizer.observe(canvas);

  resize();
  if (reduced) draw(0);
  else raf = requestAnimationFrame(loop);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      sizer.disconnect();
    },
  };
}
