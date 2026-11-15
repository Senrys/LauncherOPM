/**
 * Les circuits de Xenodys, incrustés dans la vidéo de fond.
 *
 * Par moments, à des endroits au hasard de la vidéo (surtout à droite, où elle
 * est visible derrière le personnage), un circuit se dessine : une piste
 * pixelisée qui pousse, file droit, tourne à 90° ou à 45°, porte une impulsion
 * lumineuse, puis s'efface. Chaque circuit s'éteint en dégradé tramé autour de
 * son point d'origine : il n'a pas de bord net, il paraît gravé DANS l'image.
 * Le canevas est mélangé à la vidéo en « screen » (layout/shell.css) : le noir
 * n'existe pas, seule la lumière s'ajoute.
 *
 * Créatrice : pistes cyan, nœuds clairs, tracés réguliers. Corrompue :
 * fissures rouges et violettes, en zigzag, qui grésillent.
 */

const P = 3; // un pixel du circuit = 3 px d'écran
const FPS = 20;
const MAX = 4;
const GROW = 1.4;
const HOLD = 2.6;
const FADE = 1.6;

const THEMES = {
  creatrice: { trace: [79, 190, 178], bright: [145, 217, 209], pulse: [233, 255, 252], node: [233, 255, 252] },
  corrompue: { trace: [255, 96, 140], bright: [255, 150, 180], pulse: [255, 235, 240], node: [225, 170, 255] },
};

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16;

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {{dispose: () => void}}
 */
export function createVideoCircuits(canvas) {
  const ctx = canvas.getContext('2d');
  const root = document.documentElement;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  let W = 0;
  let H = 0;
  let circuits = [];
  let nextSpawn = 0.8;
  let last = 0;
  let raf = 0;
  let disposed = false;

  const corrupted = () => root.dataset.xenodys === 'corrompue';

  function measure() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.ceil(r.width / P));
    H = Math.max(1, Math.ceil(r.height / P));
    canvas.width = W;
    canvas.height = H;
    ctx.imageSmoothingEnabled = false;
  }

  /** Un nouveau circuit : une piste qui part d'un point au hasard. */
  function spawn() {
    const crack = corrupted();
    const x0 = Math.floor(W * (0.4 + Math.random() * 0.58));
    const y0 = Math.floor(H * (0.08 + Math.random() * 0.8));
    const cells = [[x0, y0]];
    const nodes = [];
    let x = x0;
    let y = y0;
    let dir = Math.floor(Math.random() * 4) * 2; // départ droit
    const length = 30 + Math.floor(Math.random() * 50);
    let run = 0;
    for (let i = 0; i < length; i += 1) {
      run += 1;
      if (crack) {
        // Fissure : zigzag nerveux.
        if (Math.random() < 0.35) dir = (dir + (Math.random() < 0.5 ? 1 : 7)) % 8;
      } else if (run > 4 && Math.random() < 0.18) {
        // Piste : un coude à 45°, rarement 90°, et un nœud au coude.
        dir = (dir + (Math.random() < 0.5 ? 1 : 7) * (Math.random() < 0.8 ? 1 : 2)) % 8;
        nodes.push(cells.length - 1);
        run = 0;
      }
      x += DIRS[dir][0];
      y += DIRS[dir][1];
      if (x < 1 || y < 1 || x > W - 2 || y > H - 2) break;
      cells.push([x, y]);
      // Une ramification, de temps en temps.
      if (!crack && Math.random() < 0.04) nodes.push(cells.length - 1);
    }
    circuits.push({ cells, nodes, crack, x0, y0, radius: 26 + Math.random() * 18, age: 0, pulse: Math.random() });
  }

  function color(rgb, a) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a.toFixed(3)})`;
  }

  function draw(dt) {
    ctx.clearRect(0, 0, W, H);
    const theme = THEMES[corrupted() ? 'corrompue' : 'creatrice'];
    circuits = circuits.filter((c) => {
      c.age += dt;
      const life = GROW + HOLD + FADE;
      if (c.age > life) return false;
      const grown = Math.min(1, c.age / GROW);
      const fading = c.age > GROW + HOLD ? 1 - (c.age - GROW - HOLD) / FADE : 1;
      const shown = Math.floor(c.cells.length * grown);
      // Grésillement des fissures.
      const flicker = c.crack ? (Math.random() < 0.15 ? 0.3 : 1) : 1;

      for (let i = 0; i < shown; i += 1) {
        const [x, y] = c.cells[i];
        // Dégradé tramé autour du point d'origine : le circuit se fond dans l'image.
        const d = Math.hypot(x - c.x0, y - c.y0) / c.radius;
        const v = (1 - d) * fading * flicker;
        if (v <= 0 || v < bayer(x, y) * 0.75) continue;
        const head = i >= shown - 2 && grown < 1;
        ctx.fillStyle = color(head ? theme.pulse : theme.trace, Math.min(1, 0.55 + v * 0.45));
        ctx.fillRect(x, y, 1, 1);
      }
      for (const n of c.nodes) {
        if (n >= shown) continue;
        const [x, y] = c.cells[n];
        const v = (1 - Math.hypot(x - c.x0, y - c.y0) / c.radius) * fading;
        if (v <= 0.15) continue;
        ctx.fillStyle = color(theme.node, Math.min(1, v));
        ctx.fillRect(x - 1, y - 1, 3, 3);
        ctx.clearRect(x, y, 1, 1);
      }
      // L'impulsion parcourt la piste pendant qu'elle est pleine.
      if (grown >= 1 && fading > 0.3) {
        c.pulse = (c.pulse + dt * 0.6) % 1;
        const i = Math.floor(c.pulse * c.cells.length);
        for (let k = 0; k < 3; k += 1) {
          const cell = c.cells[i - k];
          if (!cell) continue;
          const v = 1 - Math.hypot(cell[0] - c.x0, cell[1] - c.y0) / c.radius;
          if (v <= 0) continue;
          ctx.fillStyle = color(k ? theme.bright : theme.pulse, v * fading);
          ctx.fillRect(cell[0], cell[1], 1, 1);
        }
      }
      return true;
    });

    nextSpawn -= dt;
    if (nextSpawn <= 0 && circuits.length < MAX) {
      spawn();
      nextSpawn = (corrupted() ? 0.9 : 1.8) + Math.random() * 2.2;
    }
  }

  function loop(now) {
    raf = 0;
    if (disposed) return;
    const dt = last ? Math.min(0.15, (now - last) / 1000) : 0;
    if (!last || now - last >= 1000 / FPS - 2) {
      last = now;
      draw(dt);
    }
    schedule();
  }

  function schedule() {
    if (disposed || raf || document.hidden || reduced?.matches) return;
    raf = requestAnimationFrame(loop);
  }

  const onVisibility = () => {
    last = 0;
    schedule();
  };
  const sizer = new ResizeObserver(measure);
  sizer.observe(canvas);
  document.addEventListener('visibilitychange', onVisibility);

  measure();
  schedule();

  return {
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      sizer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
