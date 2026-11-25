/**
 * Le décor autour du cadre — mode « fenêtre ouverte ».
 *
 * Tout est dessiné en PIXEL ART, à la manière des sprites de Minecraft : deux
 * canvas basse résolution (un « pixel » = 4 px d'écran), agrandis sans lissage
 * (`image-rendering: pixelated`). Rien n'est lisse, rien n'est en dégradé : les
 * fondus sont tramés (matrice de Bayer), les mouvements avancent case par case.
 *
 *   - Derrière le cadre (`[data-el="surround"]`) : une nappe sombre tramée qui
 *     prolonge le launcher dans le décor, des circuits (ou des fissures), des
 *     blocs d'OPMTech en suspension, des bits qui scintillent. Ce qui
 *     passe derrière le cadre est caché par lui : la scène a de la profondeur.
 *
 *   - Devant le cadre (`[data-el="surround-front"]`) : ce qui l'incruste dans la
 *     scène — ses bords s'assombrissent en trame, des cubes s'en détachent, les
 *     circuits y entrent, des équerres de métal tiennent ses coins et des broches
 *     dorées courent le long de ses bords, comme le connecteur d'une carte.
 *
 *   - Le cadre lui-même reçoit un masque en escalier (coins pixelisés, quelques
 *     encoches) : plus aucune bordure lisse ni arrondie.
 *
 * Créatrice : cyan, circuits — le monde se construit. Corrompue : rouge et
 * violet, fissures, parasites — le monde se défait. Passage de l'un
 * à l'autre en fondu, sur `<html data-xenodys>` (utils/xenodys.js).
 *
 * Sobriété : 20 images par seconde au plus (un rythme de sprite), arrêt quand la
 * fenêtre est cachée, une image fixe si le système demande moins d'animations.
 */

/** Taille d'un pixel du décor, en pixels CSS. Les marges de la fenêtre en sont
 *  des multiples (windows/mainWindow.js) : la grille tombe juste sur le cadre. */
const P = 4;
const FPS = 20;
const FADE_MS = 1400;

/* -------------------------------------------------------------- palettes */

const THEMES = {
  creatrice: {
    ink: '#061211',
    inkMid: 'rgba(6, 18, 17, .78)',
    inkGrain: '#0D2522',
    trace: 'rgba(46, 127, 114, .85)',
    traceEdge: 'rgba(29, 92, 81, .5)',
    traceHi: '#91D9D1',
    pulse: '#ECFFFC',
    node: '#D3AE59',
    nodeHi: '#F2DC9A',
    metal: ['#0A0F13', '#6A7688', '#C9D6D4', '#12161D'],
    bits: ['#91D9D1', '#ECFFFC', '#5BBDB1'],
    cube: { top: '#BFF1EA', hi: '#ECFFFC', left: '#78CBC1', right: '#3F9C91', line: '#0E3531' },
    particle: ['#2E6E67', '#4FAAA0', '#91D9D1'],
    glitch: null,
  },
  corrompue: {
    ink: '#0B0410',
    inkMid: 'rgba(11, 4, 16, .78)',
    inkGrain: '#1E0A20',
    trace: 'rgba(142, 58, 176, .75)',
    traceEdge: 'rgba(106, 31, 143, .5)',
    traceHi: '#F0506E',
    pulse: '#FFD3DD',
    node: '#C77DFF',
    nodeHi: '#E6C4FF',
    metal: ['#0B060E', '#5E4A5C', '#9C8299', '#1B1020'],
    bits: ['#F0506E', '#C77DFF', '#FFD3DD'],
    cube: { top: '#3B1838', hi: '#F0506E', left: '#24101F', right: '#170A15', line: '#B02850' },
    particle: ['#5A1F4A', '#B02850', '#F0506E'],
    glitch: ['#F0506E', '#C77DFF', '#FFFFFF', '#0B0410'],
  },
};

const STATES = ['creatrice', 'corrompue'];

/* ------------------------------------------------------------ utilitaires */

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Seuil de trame 4 × 4 : un fondu devient un motif de pixels. */
const bayer = (x, y) => (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16;

function hash(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Bruit de valeur lissé : des formes organiques, mais stables. */
function noise(x, y, scale, seed) {
  const gx = x / scale;
  const gy = y / scale;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy;
}

/** Générateur pseudo-aléatoire à graine. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function surface(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  return { canvas, g };
}

function dot(g, x, y, color, w = 1, h = 1) {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

/* ---------------------------------------------------------------- sprites */

/** Un cube en isométrie, trois faces ombrées et un contour, comme un bloc
 *  d'inventaire. `a` : demi-largeur, en pixels du décor. */
function cubeSprite(a, c) {
  const w = a * 2;
  const top = Math.floor(a / 2);
  const { canvas, g } = surface(w, top * 2 + a + 1);
  for (let col = 0; col < w; col += 1) {
    const off = col < a ? col : w - 1 - col;
    const start = top - Math.floor(off / 2);
    const mid = top + Math.floor(off / 2) + 1;
    const end = mid + a - 1;
    for (let y = start; y <= end; y += 1) {
      let color;
      if (y === start || y === end || col === 0 || col === w - 1) color = c.line;
      else if (y < mid) color = y === start + 1 && off > 1 ? c.hi : c.top;
      else color = col < a ? c.left : c.right;
      dot(g, col, y, color);
    }
  }
  return canvas;
}

/** Un éclat, pointe en haut : corrompu, il remplace certains cubes. */
function shardSprite(h, c) {
  const { canvas, g } = surface(5, h);
  for (let y = 0; y < h; y += 1) {
    const half = Math.min(2, Math.floor((y / h) * 3));
    for (let x = 2 - half; x <= 2 + half; x += 1) {
      const color = x === 2 - half ? c.hi : x === 2 + half ? c.right : c.left;
      dot(g, x, y, color);
    }
  }
  return canvas;
}

/** Un vrai bloc d'OPMTech, en isométrie : ses textures, et ses pixels lumineux.
 *  `a` : demi-largeur ; `tile(nom)` : la case 16 × 16 d'une texture, déjà lumineuse. */
function blockSprite(a, top, side) {
  const { canvas, g } = surface(a * 2, a * 2 + 1);
  const read = (img) => img.getContext('2d').getImageData(0, 0, 16, 16).data;
  const t = read(top);
  const s = read(side);
  const put = (x, y, px, u, v, k) => {
    const i = (Math.min(15, Math.floor(v * 16)) * 16 + Math.min(15, Math.floor(u * 16))) * 4;
    // Les pixels clairs (lumineux) gardent leur éclat sur les faces à l'ombre.
    const bright = Math.max(px[i], px[i + 1], px[i + 2]) > 190 ? Math.max(k, 0.9) : k;
    dot(g, x, y, `rgb(${px[i] * bright},${px[i + 1] * bright},${px[i + 2] * bright})`);
  };
  for (let x = 0; x < a * 2; x += 1) {
    const cx = x + 0.5;
    for (let y = 0; y < a; y += 1) {
      const dx = (cx - a) / a;
      const dy = (y + 0.5 - a / 2) / (a / 2);
      const u = (dx + dy) / 2 + 0.5;
      const v = (dy - dx) / 2 + 0.5;
      if (u >= 0 && u < 1 && v >= 0 && v < 1) put(x, y, t, u, v, 1);
    }
    const left = cx < a;
    const from = Math.round(a / 2 + (left ? cx : a * 2 - cx) / 2);
    for (let y = 0; y < a; y += 1) put(x, from + y, s, left ? cx / a : (cx - a) / a, (y + 0.5) / a, left ? 0.72 : 0.5);
  }
  return canvas;
}

/** Les blocs en suspension : dessus, côté. */
const BLOCKS = [
  ['circuit:puce', 'circuit:cote'], ['circuit:coeur', 'circuit:coeur'], ['labo:mur', 'labo:mur'], ['circuit:via', 'circuit:cote'],
  ['labo:sol_lumineux', 'labo:mur_bande'], ['circuit:emetteur', 'circuit:condensateur'], ['labo:m_acier', 'labo:mur_neon'],
  ['circuit:dalle', 'circuit:radiateur'],
];

/** Une équerre de métal sur un coin du cadre (sx, sy : vers l'extérieur), et sa vis dorée. */
function drawBracket(g, x, y, sx, sy, c) {
  const [dark, metal, hi, inner] = c.metal;
  const bar = (dx, dy, w, h, color) => dot(g, sx > 0 ? x - dx - w + 1 : x + dx, sy > 0 ? y - dy - h + 1 : y + dy, color, w, h);
  bar(-2, -2, 15, 5, dark);
  bar(-2, -2, 5, 13, dark);
  bar(-1, -1, 13, 3, metal);
  bar(-1, -1, 3, 11, metal);
  bar(-1, -1, 13, 1, hi);
  bar(-1, -1, 1, 11, hi);
  bar(0, 0, 11, 1, inner);
  bar(0, 0, 1, 9, inner);
  bar(0, 0, 2, 2, c.node);
  bar(0, 0, 1, 1, c.nodeHi);
}

/* ------------------------------------------------------------------ décor */

/**
 * Démarre le décor.
 * @param {{back: HTMLCanvasElement, front: HTMLCanvasElement, frame: HTMLElement, stage?: HTMLElement|null}} parts
 * @returns {{setTiles: (provider: (etat: string, tile: string) => HTMLCanvasElement) => void, dispose: () => void}}
 */
export function createSurround({ back, front, frame, stage }) {
  const bctx = back.getContext('2d');
  const fctx = front.getContext('2d');
  const root = document.documentElement;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  let W = 0;
  let H = 0;
  let fb = { x: 0, y: 0, w: 0, h: 0 };
  /** `(état, texture) → canevas 16 × 16` : les blocs d'OPMTech, une fois le laboratoire prêt. */
  let tiles = null;
  let layers = null; // { creatrice: {...}, corrompue: {...} }
  let particles = [];
  let glitches = [];
  let nextParticle = 0;
  let nextGlitch = 1;

  let target = root.dataset.xenodys === 'corrompue' ? 1 : 0;
  let mix = target;
  let fadeFrom = mix;
  let fadeStart = 0;

  let raf = 0;
  let last = 0;
  let disposed = false;
  let rebuildTimer = 0;

  /* --------------------------------------------------------- géométrie */

  const insideFrame = (x, y) => x >= fb.x && x < fb.x + fb.w && y >= fb.y && y < fb.y + fb.h;

  /** Distance (en cases) au cadre, 0 dedans. */
  function frameDistance(x, y) {
    const dx = x < fb.x ? fb.x - x : x >= fb.x + fb.w ? x - (fb.x + fb.w - 1) : 0;
    const dy = y < fb.y ? fb.y - y : y >= fb.y + fb.h ? y - (fb.y + fb.h - 1) : 0;
    return Math.hypot(dx, dy);
  }

  /** La zone où se tient Xenodys — la marge de droite : pas de cubes devant elle. */
  function xenoZone() {
    if (!stage) return null;
    return { x: fb.x + fb.w, y: 0, w: W - fb.x - fb.w, h: H };
  }

  const overlaps = (a, b) => b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  /** Intensité de la nappe sombre en (x, y) : 1 contre le cadre, 0 au large. */
  function backdropAt(x, y, seed) {
    const d = frameDistance(x, y);
    const n = noise(x, y, 9, seed) * 0.7 + noise(x, y, 3, seed + 7) * 0.3;
    const reach = 6 + n * 26;
    const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
    return Math.min(1 - d / reach, edge / 8);
  }

  /** Circuits : départ dans le bord du cadre, lignes droites et diagonales. */
  function circuitPaths(rand, seed, occupied) {
    const paths = [];
    for (let attempt = 0; attempt < 90 && paths.length < 22; attempt += 1) {
      const side = Math.floor(rand() * 4);
      const t = 0.06 + rand() * 0.88;
      let x;
      let y;
      let dx = 0;
      let dy = 0;
      if (side === 0) { x = fb.x + Math.floor(t * fb.w); y = fb.y + 1; dy = -1; }
      else if (side === 1) { x = fb.x + fb.w - 2; y = fb.y + Math.floor(t * fb.h); dx = 1; }
      else if (side === 2) { x = fb.x + Math.floor(t * fb.w); y = fb.y + fb.h - 2; dy = 1; }
      else { x = fb.x + 1; y = fb.y + Math.floor(t * fb.h); dx = -1; }

      const cells = [];
      const runs = [2 + Math.floor(rand() * 8), 1 + Math.floor(rand() * 4), 3 + Math.floor(rand() * 10), 1 + Math.floor(rand() * 3), 2 + Math.floor(rand() * 8)];
      const perp = rand() < 0.5 ? -1 : 1;
      let blocked = false;
      for (let k = 0; k < runs.length && !blocked; k += 1) {
        const diagonal = k % 2 === 1;
        for (let s = 0; s < runs[k]; s += 1) {
          x += dx + (diagonal ? (dy !== 0 ? perp : 0) : 0);
          y += dy + (diagonal ? (dx !== 0 ? perp : 0) : 0);
          if (x < 2 || y < 2 || x > W - 3 || y > H - 3) { blocked = true; break; }
          if (insideFrame(x, y) && cells.length > 2) { blocked = true; break; }
          if (!insideFrame(x, y) && backdropAt(x, y, seed) < 0.15) { blocked = true; break; }
          const key = `${x},${y}`;
          if (occupied.has(key)) { blocked = true; break; }
          cells.push([x, y]);
        }
      }
      // Les deux premières cases sont dans le cadre : il faut au moins 6 cases dehors.
      if (cells.length < 8) continue;
      for (const [cx, cy] of cells) {
        occupied.add(`${cx},${cy}`);
        occupied.add(`${cx + 1},${cy}`);
        occupied.add(`${cx},${cy + 1}`);
      }
      paths.push({ cells: prependStart(cells, dx, dy), period: 2.2 + rand() * 4, offset: rand() * 6 });
    }
    return paths;
  }

  /** Le circuit part de deux cases à l'intérieur du cadre. */
  function prependStart(cells, dx, dy) {
    const [x, y] = cells[0];
    return [[x - dx * 2, y - dy * 2], [x - dx, y - dy], ...cells];
  }

  /** Fissures : marche au hasard qui s'éloigne du cadre en zigzag. */
  function crackPaths(rand, seed) {
    const paths = [];
    for (let attempt = 0; attempt < 60 && paths.length < 18; attempt += 1) {
      const side = Math.floor(rand() * 4);
      const t = 0.04 + rand() * 0.92;
      let x;
      let y;
      let dx = 0;
      let dy = 0;
      if (side === 0) { x = fb.x + Math.floor(t * fb.w); y = fb.y + 2; dy = -1; }
      else if (side === 1) { x = fb.x + fb.w - 3; y = fb.y + Math.floor(t * fb.h); dx = 1; }
      else if (side === 2) { x = fb.x + Math.floor(t * fb.w); y = fb.y + fb.h - 3; dy = 1; }
      else { x = fb.x + 2; y = fb.y + Math.floor(t * fb.h); dx = -1; }
      const cells = [[x, y]];
      const length = 10 + Math.floor(rand() * 22);
      for (let k = 0; k < length; k += 1) {
        if (rand() < 0.62) { x += dx; y += dy; }
        else if (dx !== 0) y += rand() < 0.5 ? -1 : 1;
        else x += rand() < 0.5 ? -1 : 1;
        if (x < 2 || y < 2 || x > W - 3 || y > H - 3) break;
        if (!insideFrame(x, y) && backdropAt(x, y, seed) < 0.1) break;
        cells.push([x, y]);
      }
      if (cells.length < 8) continue;
      paths.push({ cells, period: 1.4 + rand() * 3, offset: rand() * 5, branch: rand() < 0.35 });
    }
    return paths;
  }

  /** Encoches du cadre : quelques morsures d'une ou deux cases sur les bords. */
  function bitesOf(rand) {
    const bites = [];
    const sides = [
      { side: 'top', length: fb.w, avoid: [[0, 10], [fb.w - 48, fb.w]] },
      { side: 'bottom', length: fb.w, avoid: [[0, 10], [fb.w - 10, fb.w]] },
      { side: 'left', length: fb.h, avoid: [[0, 10], [fb.h - 10, fb.h]] },
      { side: 'right', length: fb.h, avoid: [[0, 12], [fb.h - 12, fb.h]] },
    ];
    for (const s of sides) {
      const count = Math.round(s.length / 26);
      for (let k = 0; k < count; k += 1) {
        const at = Math.floor(rand() * s.length);
        const len = 1 + Math.floor(rand() * 4);
        if (s.avoid.some(([a, b]) => at + len > a && at < b)) continue;
        bites.push({ side: s.side, at, len, depth: rand() < 0.75 ? 1 : 2 });
      }
    }
    return bites;
  }

  /** Le masque du cadre : coins en escalier et encoches, à la résolution de l'écran. */
  function applyMask(bites) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const wpx = fb.w * P;
    const hpx = fb.h * P;
    const { canvas, g } = surface(wpx * dpr, hpx * dpr);
    g.scale(dpr, dpr);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, wpx, hpx);
    const cut = (cx, cy, cw = 1, ch = 1) => g.clearRect(cx * P, cy * P, cw * P, ch * P);
    // Coins : un escalier de trois marches.
    const corner = [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2]];
    for (const [cx, cy] of corner) {
      cut(cx, cy);
      cut(fb.w - 1 - cx, cy);
      cut(cx, fb.h - 1 - cy);
      cut(fb.w - 1 - cx, fb.h - 1 - cy);
    }
    for (const b of bites) {
      if (b.side === 'top') cut(b.at, 0, b.len, b.depth);
      else if (b.side === 'bottom') cut(b.at, fb.h - b.depth, b.len, b.depth);
      else if (b.side === 'left') cut(0, b.at, b.depth, b.len);
      else cut(fb.w - b.depth, b.at, b.depth, b.len);
    }
    const url = `url(${canvas.toDataURL('image/png')})`;
    frame.style.maskImage = url;
    frame.style.maskSize = '100% 100%';
    frame.style.maskRepeat = 'no-repeat';
  }

  /* ------------------------------------------------------- construction */

  function buildState(name, seed, shared) {
    const c = THEMES[name];
    const backLayer = surface(W, H);
    const frontLayer = surface(W, H);
    const bg = backLayer.g;
    const fg = frontLayer.g;

    // 1. La nappe sombre, tramée sur ses bords.
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (insideFrame(x, y)) continue;
        const v = backdropAt(x, y, seed);
        if (v <= 0) continue;
        if (v > 0.5) dot(bg, x, y, hash(x, y, seed + 3) < 0.05 ? c.inkGrain : c.ink);
        else if (v * 2 > bayer(x, y)) dot(bg, x, y, c.inkMid);
      }
    }

    // 2. Circuits (créatrice) ou fissures (corrompue).
    const paths = name === 'creatrice' ? shared.circuits : shared.cracks;
    for (const path of paths) {
      path.cells.forEach(([x, y], k) => {
        const g = insideFrame(x, y) ? fg : bg;
        if (name === 'creatrice') {
          // Une piste : son cœur, et deux bords plus sombres.
          const [px, py] = path.cells[Math.max(0, k - 1)];
          if (px !== x) dot(g, x, y - 1, c.traceEdge, 1, 3);
          else dot(g, x - 1, y, c.traceEdge, 3, 1);
          dot(g, x, y, c.trace);
        } else {
          dot(g, x, y, c.traceHi);
          if (hash(x, y, seed + 11) < 0.5) dot(g, x + (k % 2 ? 1 : -1), y, c.trace);
        }
      });
      const [ex, ey] = path.cells[path.cells.length - 1];
      if (name === 'creatrice') {
        // Pastille de fin : un anneau de 3 × 3 au cœur sombre.
        dot(bg, ex - 1, ey - 1, c.node, 3, 3);
        dot(bg, ex - 1, ey - 1, c.nodeHi);
        dot(bg, ex, ey, c.ink);
      } else {
        dot(bg, ex, ey, c.node);
      }
    }

    // 3. Devant : les bords du cadre s'assombrissent en trame, pour qu'il se
    //    fonde dans la nappe au lieu d'y être posé.
    const reach = { top: 2, right: 5, bottom: 3, left: 3 };
    for (let y = fb.y; y < fb.y + fb.h; y += 1) {
      for (let x = fb.x; x < fb.x + fb.w; x += 1) {
        const dt = (y - fb.y) / reach.top;
        const dr = (fb.x + fb.w - 1 - x) / reach.right;
        const db = (fb.y + fb.h - 1 - y) / reach.bottom;
        const dl = (x - fb.x) / reach.left;
        const d = Math.min(dt, dr, db, dl);
        if (d >= 1) continue;
        const v = (1 - d) * (0.55 + noise(x, y, 4, seed + 13) * 0.6);
        if (v > bayer(x, y) + 0.08) dot(fg, x, y, c.ink);
      }
    }

    // 4. Les équerres des coins gauches, et les broches dorées du connecteur.
    drawBracket(fg, fb.x, fb.y, -1, -1, c);
    drawBracket(fg, fb.x, fb.y + fb.h - 1, -1, 1, c);
    const pin = (x, y, w, h) => {
      dot(fg, x, y, c.node, w, h);
      dot(fg, x, y, c.nodeHi, 1, 1);
    };
    for (let y = fb.y + 18; y < fb.y + fb.h - 18; y += 5) if (hash(y, 3, seed) < 0.8) pin(fb.x - 2, y, 3, 2);
    for (let x = fb.x + 22; x < fb.x + fb.w - 30; x += 5) if (hash(x, 7, seed) < 0.55) pin(x, fb.y + fb.h - 1, 2, 3);

    // 5. Sprites animés de cet état.
    const cubes = shared.cubes.map((cube, k) => ({
      ...cube,
      sprite: tiles ? blockSprite(cube.a, ...BLOCKS[k % BLOCKS.length].map((n) => tiles(name, n)))
        : name === 'corrompue' && k % 3 === 0 ? shardSprite(cube.a * 2 + 2, c.cube) : cubeSprite(cube.a, c.cube),
    }));

    return { c, back: backLayer.canvas, front: frontLayer.canvas, cubes, paths };
  }

  function build() {
    const seed = 0x0de5;
    const rand = seeded(seed ^ fb.w ^ (fb.h << 10));
    const zone = xenoZone();

    // Cubes en suspension, dans la marge, hors de Xenodys.
    const cubes = [];
    for (let k = 0; k < 160 && cubes.length < 16; k += 1) {
      const a = 4 + Math.floor(rand() * 5);
      const x = Math.floor(rand() * W);
      const y = Math.floor(rand() * H);
      const rect = { x: x - 1, y: y - 1, w: a * 2 + 2, h: a * 2 + 2 };
      if (rect.x < 2 || rect.y < 2 || rect.x + rect.w > W - 2 || rect.y + rect.h > H - 2) continue;
      if (frameDistance(x, y) < 3 || frameDistance(x + a * 2, y + a * 2) < 3) continue;
      if (overlaps(rect, zone)) continue;
      if (cubes.some((c) => overlaps(rect, c.rect))) continue;
      cubes.push({ x, y, a, rect, phase: rand() * 6, speed: 0.6 + rand() * 0.8 });
    }

    // Bits qui scintillent sur la nappe.
    const bits = [];
    for (let k = 0; k < 400 && bits.length < 80; k += 1) {
      const x = Math.floor(rand() * W);
      const y = Math.floor(rand() * H);
      if (insideFrame(x, y) || backdropAt(x, y, seed) < 0.35) continue;
      bits.push({ x, y, phase: rand() * 10, speed: 0.8 + rand() * 2.5, color: k % 3 });
    }

    const occupied = new Set();
    const shared = {
      circuits: circuitPaths(rand, seed, occupied),
      cracks: crackPaths(seeded(seed + 77), seed),
      cubes,
    };

    layers = {};
    for (const name of STATES) layers[name] = buildState(name, seed, shared);
    layers.bits = bits;
    applyMask(bitesOf(seeded(seed + 3)));
  }

  function measure() {
    W = Math.ceil(window.innerWidth / P);
    H = Math.ceil(window.innerHeight / P);
    for (const canvas of [back, front]) {
      canvas.width = W;
      canvas.height = H;
      canvas.style.width = `${W * P}px`;
      canvas.style.height = `${H * P}px`;
    }
    bctx.imageSmoothingEnabled = false;
    fctx.imageSmoothingEnabled = false;
    // La boîte de mise en page, pas celle affichée : pendant la cinématique, le
    // cadre est réduit dans l'orbe (transform), et la fenêtre change justement
    // de taille à ce moment-là. Mesurer l'orbe donnerait un cadre minuscule —
    // contour et décor reconstruits de travers jusqu'au prochain redimensionnement.
    let left = 0;
    let top = 0;
    for (let el = frame; el; el = el.offsetParent) {
      left += el.offsetLeft;
      top += el.offsetTop;
    }
    const r = { left, top, width: frame.offsetWidth, height: frame.offsetHeight };
    fb = { x: Math.round(r.left / P), y: Math.round(r.top / P), w: Math.round(r.width / P), h: Math.round(r.height / P) };
    build();
  }

  /* --------------------------------------------------------------- dessin */

  function drawPulses(g, layer, t, inside) {
    const { c } = layer;
    for (const path of layer.paths) {
      const progress = ((t + path.offset) % path.period) / 1.2;
      if (progress >= 1) continue;
      const head = Math.floor(progress * path.cells.length);
      for (let k = 0; k < 4; k += 1) {
        const cell = path.cells[head - k];
        if (!cell) continue;
        if (insideFrame(cell[0], cell[1]) !== inside) continue;
        dot(g, cell[0], cell[1], k === 0 ? c.pulse : c.traceHi);
      }
    }
  }

  function drawState(name, alpha, t) {
    const layer = layers[name];
    const { c } = layer;

    bctx.globalAlpha = alpha;
    bctx.drawImage(layer.back, 0, 0);

    // Bits.
    for (const bit of layers.bits) {
      if (Math.sin(t * bit.speed + bit.phase) > 0.86) dot(bctx, bit.x, bit.y, c.bits[bit.color]);
    }

    // Cubes : ils flottent case par case.
    for (const cube of layer.cubes) {
      const bob = Math.round(Math.sin(t * cube.speed + cube.phase) * 1.4);
      bctx.drawImage(cube.sprite, cube.x, cube.y + bob);
    }

    drawPulses(bctx, layer, t, false);

    fctx.globalAlpha = alpha;
    fctx.drawImage(layer.front, 0, 0);
    drawPulses(fctx, layer, t, true);
  }

  function spawnParticle(colors) {
    const side = Math.floor(Math.random() * 4);
    const t = Math.random();
    let x;
    let y;
    let dx = 0;
    let dy = 0;
    if (side === 0) { x = fb.x + Math.floor(t * fb.w); y = fb.y - 1; dy = -1; }
    else if (side === 1) { x = fb.x + fb.w; y = fb.y + Math.floor(t * fb.h); dx = 1; }
    else if (side === 2) { x = fb.x + Math.floor(t * fb.w); y = fb.y + fb.h; dy = 1; }
    else { x = fb.x - 1; y = fb.y + Math.floor(t * fb.h); dx = -1; }
    particles.push({
      x, y, dx, dy,
      size: Math.random() < 0.2 ? 2 : 1,
      color: colors[Math.floor(Math.random() * colors.length)],
      every: 0.18 + Math.random() * 0.3,
      wait: 0,
      life: 4 + Math.floor(Math.random() * 9),
    });
  }

  function draw(now, animate) {
    const t = now / 1000;
    const dt = last ? Math.min(0.15, (now - last) / 1000) : 0;
    last = now;

    if (mix !== target) {
      const r = Math.min(1, (now - fadeStart) / FADE_MS);
      mix = fadeFrom + (target - fadeFrom) * (r * r * (3 - 2 * r));
      if (r >= 1) mix = target;
    }

    bctx.clearRect(0, 0, W, H);
    fctx.clearRect(0, 0, W, H);
    if (1 - mix > 0.01) drawState('creatrice', 1 - mix, t);
    if (mix > 0.01) drawState('corrompue', mix, t);
    bctx.globalAlpha = 1;
    fctx.globalAlpha = 1;

    if (!animate) return;
    const theme = THEMES[target ? 'corrompue' : 'creatrice'];

    // Des cubes se détachent du cadre et s'éloignent, case par case.
    nextParticle -= dt;
    while (nextParticle <= 0 && particles.length < 46) {
      nextParticle += 0.09;
      spawnParticle(theme.particle);
    }
    particles = particles.filter((p) => {
      p.wait += dt;
      if (p.wait >= p.every) {
        p.wait = 0;
        p.x += p.dx;
        p.y += p.dy;
        // Créatrice : les cubes montent un peu. Corrompue : ils tombent.
        if (Math.random() < 0.3) p.y += target ? 1 : -1;
        p.life -= 1;
      }
      if (p.life <= 0) return false;
      if (p.life < 3 && bayer(p.x, p.y) > p.life / 3) return true;
      dot(fctx, p.x, p.y, p.color, p.size, p.size);
      return true;
    });

    // Corrompue : parasites — des bandes qui débordent du cadre, et des
    // tranches du décor décalées.
    if (theme.glitch) {
      nextGlitch -= dt;
      if (nextGlitch <= 0) {
        nextGlitch = 0.5 + Math.random() * 2;
        const baseY = fb.y + Math.floor(Math.random() * fb.h);
        const n = 2 + Math.floor(Math.random() * 4);
        for (let k = 0; k < n; k += 1) {
          const leftSide = Math.random() < 0.5;
          const w = 4 + Math.floor(Math.random() * 16);
          glitches.push({
            x: leftSide ? fb.x - w + Math.floor(Math.random() * 4) : fb.x + fb.w - Math.floor(Math.random() * 4),
            y: baseY + Math.floor((Math.random() - 0.5) * 14),
            w,
            color: theme.glitch[Math.floor(Math.random() * theme.glitch.length)],
            life: 0.08 + Math.random() * 0.18,
            tear: Math.random() < 0.4 ? (Math.random() < 0.5 ? -3 : 3) : 0,
          });
        }
      }
    }
    glitches = glitches.filter((g) => {
      g.life -= dt;
      if (g.life <= 0) return false;
      if (g.tear) bctx.drawImage(back, 0, g.y, W, 2, g.tear, g.y, W, 2);
      dot(fctx, g.x, g.y, g.color, g.w, 1);
      return true;
    });
  }

  /* --------------------------------------------------------------- boucle */

  const animated = () => !reduced?.matches;

  function loop(now) {
    raf = 0;
    if (disposed) return;
    if (now - last >= 1000 / FPS - 2) draw(now, true);
    schedule();
  }

  function schedule() {
    if (disposed || raf || document.hidden) return;
    if (!animated() && mix === target) return;
    raf = requestAnimationFrame(loop);
  }

  function still() {
    last = 0;
    draw(performance.now(), false);
  }

  const onState = () => {
    const next = root.dataset.xenodys === 'corrompue' ? 1 : 0;
    if (next === target) return;
    fadeFrom = mix;
    target = next;
    fadeStart = performance.now();
    if (!animated()) {
      mix = target;
      still();
    }
    schedule();
  };

  const onResize = () => {
    // Pendant un redimensionnement à la poignée, on ne reconstruit qu'une fois
    // le geste posé.
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      particles = [];
      glitches = [];
      measure();
      still();
      schedule();
    }, 90);
  };

  const onVisibility = () => {
    last = 0;
    schedule();
  };

  const observer = new MutationObserver(onState);
  observer.observe(root, { attributes: true, attributeFilter: ['data-xenodys'] });
  const sizer = new ResizeObserver(onResize);
  sizer.observe(frame);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);

  measure();
  still();
  schedule();

  return {
    /** Les vrais blocs d'OPMTech remplacent les cubes unis. */
    setTiles(provider) {
      tiles = provider;
      measure();
      still();
      schedule();
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(rebuildTimer);
      observer.disconnect();
      sizer.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      frame.style.maskImage = '';
    },
  };
}
