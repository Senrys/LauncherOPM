/**
 * Le socle du personnage, en pixel art : une carte de circuit imprimé en
 * voxels, à étages, sous ses pieds.
 *
 * Tout porte de vraies textures pixelisées (filtrage « nearest », comme le
 * skin du joueur), dessinées une fois à partir de motifs déterministes, aux
 * couleurs du launcher — et à celles de Xenodys corrompue quand elle l'est.
 */

/** Filtre « nearest » de Three.js : des pixels nets, jamais lissés. */
const NEAREST = 1003;

/* ------------------------------------------------------------ utilitaires */

function hash(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Dessine une petite texture pixel par pixel.
 * @param {number} w
 * @param {number} h
 * @param {(px: (x: number, y: number, color: string) => void, w: number, h: number) => void} paint
 */
function pixels(w, h, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const px = (x, y, color) => {
    if (x < 0 || y < 0 || x >= w || y >= h || !color) return;
    g.fillStyle = color;
    g.fillRect(x, y, 1, 1);
  };
  paint(px, w, h);
  return canvas;
}

/* ------------------------------------------------------------------- kit 3D */

/**
 * Fabrique de meshes texturés, avec les classes Three.js fournies par
 * skinview3d (character3d.js : `threeOf`).
 * @param {{Mesh: any, Box: any, Material: any, Group: any, Texture: any}} T
 */
function kit(T) {
  const textures = [];
  const materials = new Map();
  const owned = [];

  const texture = (canvas) => {
    const t = new T.Texture(canvas);
    t.magFilter = NEAREST;
    t.minFilter = NEAREST;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    textures.push(t);
    return t;
  };

  const material = (canvas) => {
    const m = new T.Material({ map: texture(canvas), alphaTest: 0.5 });
    owned.push(m);
    return m;
  };

  /** Matériau translucide (verre, liquide) : on voit à travers. */
  const glass = (canvas, opacity) => {
    const m = new T.Material({ map: texture(canvas), transparent: true, opacity, depthWrite: false, side: 2 });
    owned.push(m);
    return m;
  };

  const flat = (color) => {
    if (!materials.has(color)) materials.set(color, new T.Material({ color }));
    return materials.get(color);
  };

  /**
   * Pavé texturé. `faces` : une texture pour toutes les faces, ou un objet
   * {right, left, top, bottom, front, back} (front = +z).
   */
  const box = (w, h, d, faces, x = 0, y = 0, z = 0) => {
    const f = faces instanceof HTMLCanvasElement
      ? { right: faces, left: faces, top: faces, bottom: faces, front: faces, back: faces }
      : faces;
    const list = [f.right, f.left, f.top, f.bottom, f.front, f.back].map((c) => material(c ?? f.front));
    const mesh = new T.Mesh(new T.Box(w, h, d), list);
    mesh.position.set(x, y, z);
    return mesh;
  };

  const group = (...children) => {
    const g = new T.Group();
    for (const child of children) g.add(child);
    return g;
  };

  return { box, group, glass, textures, materials, owned };
}

/* ------------------------------------------------------------- plateforme */

/** Couleurs du socle : celles du launcher (base/tokens.css), et leur variante
 *  quand Xenodys est corrompue (base/xenodys.css). */
const PCB = {
  creatrice: {
    board: ['#0B201D', '#081816', '#10302B'],
    side: ['#06110F', '#0C2421'],
    trace: '#1D5C51', traceHi: '#2E7F72', glow: '#91D9D1', glowHi: '#E9FFFC',
    metal: ['#C9D6D4', '#8FA3A0', '#5E716E'], chip: ['#0A1413', '#14211F'], cap: ['#1D5C51', '#2E7F72'],
  },
  corrompue: {
    board: ['#1A0A18', '#12060F', '#24102A'],
    side: ['#0C0510', '#1C0A1E'],
    trace: '#6A1F8F', traceHi: '#8E3AB0', glow: '#F0506E', glowHi: '#FFD3DD',
    metal: ['#D2BFD0', '#9C8299', '#5E4A5C'], chip: ['#0E0710', '#1A0D18'], cap: ['#6A1F8F', '#C77DFF'],
  },
};

/** Dessus d'un étage : vernis sombre, pistes en équerre, vias. `ring` : un
 *  anneau lumineux au centre (le dais, sous les pieds). */
function pcbTop(c, n, seed, ring = false) {
  return pixels(n, n, (px) => {
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) px(x, y, c.board[hash(x, y, seed) < 0.1 ? 2 : hash(x, y, seed + 1) < 0.25 ? 1 : 0]);
    }
    const mid = n / 2;
    if (ring) {
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1) {
          const d = Math.hypot(x + 0.5 - mid, y + 0.5 - mid);
          if (d > n * 0.32 && d < n * 0.42) px(x, y, (x + y) % 2 ? c.glow : c.glowHi);
        }
      }
      return;
    }
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * Math.PI * 2 + 0.4;
      let x = Math.round(mid + Math.cos(a) * n * 0.3);
      let y = Math.round(mid + Math.sin(a) * n * 0.3);
      const dx = Math.cos(a) >= 0 ? 1 : -1;
      const dy = Math.sin(a) >= 0 ? 1 : -1;
      for (let step = 0; step < n; step += 1) {
        px(x, y, k % 2 ? c.trace : c.traceHi);
        if (step % 6 < 3) x += dx;
        else y += dy;
        if (x < 1 || y < 1 || x > n - 2 || y > n - 2) break;
      }
      px(x, y, c.glow);
    }
  });
}

/** Flanc d'un étage : couches de la carte, une ligne lumineuse au milieu. */
function pcbSide(c, w, h, glowLine) {
  return pixels(w, h, (px) => {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) px(x, y, c.side[y % 2]);
    }
    if (glowLine) {
      for (let x = 0; x < w; x += 1) if (x % 4 !== 3) px(x, Math.floor(h / 2), c.glow);
    }
  });
}

/** Boîtier de puce : sombre, broches métalliques, un repère. */
function chipTex(c) {
  return pixels(8, 8, (px) => {
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) px(x, y, c.chip[(x + y) % 5 ? 0 : 1]);
    for (let k = 1; k < 7; k += 2) {
      px(k, 0, c.metal[0]); px(k, 7, c.metal[1]); px(0, k, c.metal[0]); px(7, k, c.metal[1]);
    }
    px(2, 2, c.glow);
  });
}

/**
 * Le socle du personnage : une carte de circuit imprimé en voxels, en trois
 * étages octogonaux jusqu'au dais où il se tient, avec puces, radiateur,
 * condensateurs, pistes en relief, plots lumineux et cristaux poussés çà et
 * là ; dessous, une pointe : le socle flotte. Ses couleurs sont celles du
 * launcher, et suivent l'état de Xenodys.
 * @param {{Mesh: any, Box: any, Material: any, Group: any, Texture: any}} T
 * @returns {{root: any, setEtat: (etat: string) => void, dispose: () => void}}
 */
export function buildPlatform(T) {
  const K = kit(T);
  const versions = {};

  /** Un étage octogonal : deux pavés croisés. `top` : y du dessus. */
  const tier = (w, inset, h, top, faces) => [
    K.box(w, h, w - inset * 2, faces, 0, top - h / 2, 0),
    K.box(w - inset * 2, h, w, faces, 0, top - h / 2, 0),
  ];

  for (const [etat, c] of Object.entries(PCB)) {
    const plain = pixels(4, 4, (px) => {
      for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) px(x, y, c.side[1]);
    });
    const glowTex = pixels(2, 2, (px) => {
      px(0, 0, c.glowHi); px(1, 0, c.glow); px(0, 1, c.glow); px(1, 1, c.glowHi);
    });
    const ridge = pixels(2, 6, (px) => {
      for (let y = 0; y < 6; y += 1) { px(0, y, c.traceHi); px(1, y, y % 3 ? c.trace : c.glow); }
    });
    const metal = pixels(4, 4, (px) => {
      for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) px(x, y, c.metal[(x + y) % 3]);
    });
    const cap = pixels(2, 4, (px) => {
      for (let y = 0; y < 4; y += 1) { px(0, y, y === 0 ? c.metal[0] : c.cap[0]); px(1, y, y === 0 ? c.metal[1] : c.cap[1]); }
    });
    const crystal = pixels(2, 6, (px) => {
      for (let y = 0; y < 6; y += 1) { px(0, y, y < 2 ? c.glowHi : c.glow); px(1, y, y < 3 ? c.glow : c.trace); }
    });
    const chip = chipTex(c);
    const facesOf = (n, seed, ring, glowLine) => {
      const top = pcbTop(c, n, seed, ring);
      const side = pcbSide(c, n, 2, glowLine);
      return { top, bottom: plain, front: side, back: side, right: side, left: side };
    };

    const parts = [
      // Les trois étages, jusqu'au dais (dessus en y = 0, sous les pieds).
      ...tier(24, 6, 2, -4, facesOf(24, 61, false, true)),
      ...tier(18, 4, 2, -2, facesOf(18, 63, false, false)),
      ...tier(12, 3, 2, 0, facesOf(12, 65, true, true)),
      // La pointe, dessous : le socle flotte.
      ...tier(14, 3, 2, -6, { top: plain, bottom: plain, front: plain, back: plain, right: plain, left: plain }),
      K.box(6, 2, 6, plain, 0, -9, 0),
      K.box(2, 2, 2, glowTex, 0, -11, 0),
      // Puces et radiateur, sur l'étage du milieu.
      K.box(4, 1.2, 4, chip, -5.5, -1.4, -4.5),
      K.box(3, 1.2, 3, chip, 5.5, -1.4, 4.5),
      K.box(4, 0.6, 3, metal, 5, -1.7, -5),
      ...[0, 1, 2, 3].map((k) => K.box(0.5, 1.6, 3, metal, 3.6 + k * 0.95, -0.8, -5)),
      // Pistes en relief, sur le grand étage.
      K.box(0.8, 0.5, 5, ridge, -9.5, -3.75, 0),
      K.box(5, 0.5, 0.8, ridge, 0, -3.75, 9.5),
      K.box(0.8, 0.5, 4, ridge, 9.5, -3.75, -2),
      // Condensateurs et plots lumineux.
      K.box(1.4, 3, 1.4, cap, -8.5, -2.5, 6),
      K.box(1.4, 2.4, 1.4, cap, -7, -2.8, 7.8),
      K.box(1.4, 2.6, 1.4, cap, 8.8, -2.7, 4),
      K.box(1, 0.6, 1, glowTex, -3, -1.7, 6.5),
      K.box(1, 0.6, 1, glowTex, 6.5, -1.7, 0),
      K.box(1, 0.6, 1, glowTex, -6.5, -1.7, 1),
    ];
    // Des cristaux qui ont poussé çà et là sur le grand étage : tailles,
    // places et inclinaisons différentes — rien de symétrique.
    const CRYSTALS = [
      [-7.8, -6.2, 4.6, 0.12, -0.2],
      [6.4, -8.1, 3, -0.18, 0.1],
      [8.6, 4.4, 5.2, 0.05, 0.22],
      [-4.2, 8.7, 2.4, 0.25, 0],
      [-9.2, 2.6, 3.4, -0.1, -0.28],
    ];
    for (const [x, z, h, tx, tz] of CRYSTALS) {
      const mesh = K.box(1.2, h, 1.2, crystal, x, -4 + h / 2, z);
      mesh.rotation.set(tx, 0, tz);
      parts.push(mesh);
    }
    const g = K.group(...parts);
    g.visible = etat === 'creatrice';
    versions[etat] = g;
  }
  const root = K.group(versions.creatrice, versions.corrompue);
  return {
    root,
    setEtat(etat) {
      versions.creatrice.visible = etat !== 'corrompue';
      versions.corrompue.visible = etat === 'corrompue';
    },
    dispose() {
      for (const t of K.textures) t.dispose();
      for (const m of K.materials.values()) m.dispose();
      for (const m of K.owned) m.dispose();
    },
  };
}

/* ------------------------------------------------------------------ bocal */

/**
 * Le bocal d'expérience : quand Xenodys est corrompue, le joueur n'est plus
 * qu'un sujet d'expérience. Un grand bocal en voxels sur son socle — bague de
 * métal, parois de verre teinté, liquide violet, bulles qui montent, couvercle
 * hérissé de tuyaux et d'un voyant rouge. Origine : le dessus du dais.
 * @param {{Mesh: any, Box: any, Material: any, Group: any, Texture: any}} T
 * @returns {{root: any, update: (dt: number) => void, dispose: () => void}}
 */
export function buildJar(T) {
  const K = kit(T);
  const c = PCB.corrompue;
  const R = 11.5;
  const WALL = 33;

  const metalTex = pixels(8, 4, (px) => {
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 8; x += 1) px(x, y, y === 1 ? (x % 3 ? c.glow : c.glowHi) : c.metal[2 - (y % 2)]);
  });
  const darkTex = pixels(4, 4, (px) => {
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) px(x, y, c.side[(x + y) % 2]);
  });
  // Le verre : presque transparent, des reflets verticaux, un cadre.
  const glassTex = pixels(10, 32, (px) => {
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        if (x === 0 || x === 9) px(x, y, c.metal[1]);
        else if (x === 2 || (x === 3 && y % 5 !== 0)) px(x, y, '#FFFFFF');
        else if (x === 7 && y > 4 && y < 20) px(x, y, c.glowHi);
        else if ((x + y) % 4 === 0) px(x, y, 'rgba(232, 214, 240, 0.35)');
      }
    }
  });
  const liquidTex = pixels(4, 8, (px) => {
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 4; x += 1) px(x, y, y === 0 ? c.glow : (x + y) % 3 ? '#6A1F8F' : '#8E3AB0');
  });
  const bubbleTex = pixels(2, 2, (px) => {
    px(0, 0, c.glowHi); px(1, 0, '#FFFFFF'); px(0, 1, c.glow); px(1, 1, c.glowHi);
  });
  const lightTex = pixels(2, 2, (px) => {
    px(0, 0, '#FFFFFF'); px(1, 0, c.glow); px(0, 1, c.glow); px(1, 1, c.glow);
  });

  const octo = (w, inset, h, y, faces) => [
    K.box(w, h, w - inset * 2, faces, 0, y, 0),
    K.box(w - inset * 2, h, w, faces, 0, y, 0),
  ];
  const parts = [
    // Bague du bas et couvercle : métal sombre, une ligne lumineuse.
    ...octo(26, 7, 3, 1.5, metalTex),
    ...octo(25, 7, 3, 3 + WALL + 1.5, metalTex),
    ...octo(15, 4, 2, 3 + WALL + 4, darkTex),
    // Tuyaux et voyant, sur le couvercle.
    K.box(1.6, 6, 1.6, darkTex, -5, 3 + WALL + 6, 2),
    K.box(1.6, 4, 1.6, darkTex, 4, 3 + WALL + 5, -3),
    K.box(5, 1.6, 1.6, darkTex, -2.5, 3 + WALL + 8.2, 2),
    K.box(2, 2, 2, lightTex, 4, 3 + WALL + 8, -3),
  ];
  const root = K.group(...parts);

  // Le liquide, puis les huit parois de verre.
  const liquidMat = K.glass(liquidTex, 0.14);
  for (const [w, d] of [[21, 9], [9, 21]]) {
    const m = new T.Mesh(new T.Box(w, WALL, d), liquidMat);
    m.position.set(0, 3 + WALL / 2, 0);
    root.add(m);
  }
  const glassMat = K.glass(glassTex, 0.55);
  const side = 2 * R * Math.tan(Math.PI / 8);
  for (let k = 0; k < 8; k += 1) {
    const a = (k / 8) * Math.PI * 2;
    const wall = new T.Mesh(new T.Box(side, WALL, 0.4), glassMat);
    wall.position.set(Math.sin(a) * R, 3 + WALL / 2, Math.cos(a) * R);
    wall.rotation.y = a;
    root.add(wall);
  }

  // Des bulles qui montent dans le liquide.
  const bubbleMat = K.glass(bubbleTex, 0.9);
  const bubbles = [];
  for (let k = 0; k < 12; k += 1) {
    const b = new T.Mesh(new T.Box(0.9, 0.9, 0.9), bubbleMat);
    const a = k * 2.4;
    const r = 3 + ((k * 37) % 60) / 10;
    bubbles.push({ mesh: b, x: Math.cos(a) * r, z: Math.sin(a) * r, speed: 3 + (k % 4), phase: (k * 7) % WALL });
    root.add(b);
  }
  let time = 0;
  const place = () => {
    for (const b of bubbles) {
      const y = 4 + ((b.phase + time * b.speed) % (WALL - 3));
      b.mesh.position.set(b.x + Math.sin(time * 2 + b.phase) * 0.4, y, b.z);
    }
  };
  place();

  return {
    root,
    update(dt) {
      time += dt;
      place();
    },
    dispose() {
      for (const t of K.textures) t.dispose();
      for (const m of K.owned) m.dispose();
    },
  };
}
