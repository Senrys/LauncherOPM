/**
 * Accessoires du personnage en PIXEL ART, à la manière de Minecraft.
 *
 * Plus de pavés de couleur unie : chaque accessoire porte de vraies textures
 * pixelisées (filtrage « nearest », comme le skin du joueur), ou est extrudé
 * pixel par pixel depuis un sprite, comme les objets tenus en main dans le jeu.
 *
 *   - **Épée** : un sabre de pirate dessiné sur une grille de 9 × 19, extrudé
 *     (chaque pixel opaque devient un cube d'un pixel d'épaisseur), tenu dans
 *     le plan vertical : tranchant vers le bas, plat visible de profil.
 *   - **Chope** : fût en douelles de bois cerclé de fer, rivets, mousse qui
 *     déborde — textures à deux pixels par unité. L'anse est dans le poing.
 *   - **Coffre** : planches, cornières de fer, serrure dorée ; ouvert, il laisse
 *     voir des pièces d'or.
 *
 * Les contrats géométriques sont ceux de character3d.js : l'épée part de la
 * poignée (origine) et pointe vers +z ; la chope est construite debout puis
 * basculée d'un quart de tour ; le coffre a son origine au sol et son
 * couvercle pivote sur l'arête arrière.
 *
 * Les textures sont dessinées une fois, à partir de motifs déterministes : le
 * même accessoire a toujours le même grain.
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

/* ---------------------------------------------------------------- palettes */

const WOOD = { light: '#A8763F', mid: '#8A5A2B', dark: '#6B4220', gap: '#4A2C12', deep: '#2E1A0A' };
const IRON = { light: '#D8DEE3', mid: '#9AA3AB', dark: '#5D646B', deep: '#3A3F44' };
const GOLD = { light: '#FFE27A', mid: '#F2C94C', dark: '#C9962A', deep: '#8A6114' };
const FOAM = { white: '#FFFFFF', light: '#F7F3E8', mid: '#E9E1CC', shadow: '#D2C6A6' };
const BEER = { light: '#F2B53A', dark: '#C98A1E' };

/** Grain de bois : douelles verticales (`vertical`) ou planches horizontales. */
function wood(px, w, h, { vertical, seed, every = 3 }) {
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const along = vertical ? x : y;
      const across = vertical ? y : x;
      if (along % every === every - 1) {
        px(x, y, WOOD.gap);
        continue;
      }
      const n = hash(Math.floor(along / every), across, seed);
      let color = n < 0.33 ? WOOD.light : n < 0.8 ? WOOD.mid : WOOD.dark;
      // Quelques nœuds et veines.
      if (hash(x, y, seed + 9) < 0.06) color = WOOD.dark;
      px(x, y, color);
    }
  }
}

/** Bande de fer horizontale, avec rivets. */
function ironBand(px, w, y, { rivets = 4, h = 2 } = {}) {
  for (let x = 0; x < w; x += 1) {
    px(x, y, IRON.mid);
    if (h > 1) px(x, y + 1, IRON.dark);
  }
  for (let k = 0; k < rivets; k += 1) {
    const x = Math.round(((k + 0.5) * w) / rivets);
    px(x, y, IRON.light);
  }
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

  /**
   * Extrude un sprite : chaque pixel opaque devient un cube. Les lignes du
   * sprite (de haut en bas) s'étagent le long de +z, les colonnes le long de y
   * (la gauche du sprite vers -y) : le sprite est dans le plan vertical yz,
   * épais d'un pixel en x — comme un objet tenu en main dans Minecraft, dont
   * on voit le plat de profil et la tranche de face.
   * @param {string[]} rows    une chaîne par ligne, '.' = vide
   * @param {Record<string, string>} palette
   * @param {number} size      taille d'un pixel, en unités du modèle
   * @param {number} originRow ligne (fractionnaire) qui tombe en z = 0
   */
  const extrude = (rows, palette, size, originRow) => {
    const g = new T.Group();
    const cols = rows[0].length;
    rows.forEach((row, r) => {
      // Les pixels voisins de même couleur sont fusionnés en une barre :
      // moins de meshes, et pas de couture visible entre eux.
      let start = 0;
      while (start < cols) {
        const ch = row[start];
        if (ch === '.' || !palette[ch]) {
          start += 1;
          continue;
        }
        let end = start + 1;
        while (end < cols && row[end] === ch) end += 1;
        const len = end - start;
        const mesh = new T.Mesh(new T.Box(size, size * len, size), flat(palette[ch]));
        mesh.position.set(0, (start + len / 2 - cols / 2) * size, (originRow - r) * size);
        g.add(mesh);
        start = end;
      }
    });
    return g;
  };

  return { box, group, extrude, textures, materials, owned };
}

/* ------------------------------------------------------------------ épée */

/** Sabre de pirate : lame légèrement courbe (tranchant clair à gauche, tourné
 *  vers le bas une fois en main ; dos sombre à droite), garde dorée sertie
 *  d'un rubis et prolongée par une coquille qui protège les doigts, poignée de
 *  cuir, pommeau doré. La garde ne déborde presque pas côté dos : c'est le côté
 *  du bras, elle y entrerait quand le poignet bascule.
 *  Pas de contour noir : extrudé en 3D, il noircirait toute la lame. */
const SWORD = [
  '.....W...',
  '....WMD..',
  '....WMD..',
  '....LMD..',
  '...WMD...',
  '...LMD...',
  '...WMD...',
  '...LMD...',
  '...WMD...',
  '...LMD...',
  '...LMD...',
  'bGGgEg...',
  'g.bgR....',
  'g...R....',
  'g...r....',
  'g...R....',
  'b...r....',
  '.b..R....',
  '..bbG....',
];

const SWORD_PALETTE = {
  W: '#F4F8FA',
  L: '#D5DEE4',
  M: '#A9B6BF',
  D: '#7A8791',
  G: GOLD.mid,
  g: GOLD.dark,
  b: GOLD.deep,
  E: '#C0392B',
  R: '#8B5A2B',
  r: '#5E3916',
};

function buildSword(K) {
  // La poignée (lignes 13 à 18, pommeau compris) est centrée sur l'origine,
  // c'est là que la main serre. Elle est à peine plus longue que le poing
  // n'est épais : la garde reste devant la main, et rien ne dépasse derrière
  // qui pourrait entrer dans l'avant-bras quand le poignet bascule.
  return K.extrude(SWORD, SWORD_PALETTE, 0.72, 15.5);
}

/* ------------------------------------------------------------------ chope */

function buildMug(K) {
  // Fût : 4 × 5 × 4 unités, deux pixels par unité.
  const side = (seed) => pixels(8, 10, (px, w, h) => {
    wood(px, w, h, { vertical: true, seed });
    for (let x = 0; x < w; x += 1) px(x, 0, WOOD.deep); // lèvre du fût
    ironBand(px, w, 2, { rivets: 2 });
    ironBand(px, w, 7, { rivets: 2 });
  });
  const top = pixels(8, 8, (px, w, h) => {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        const n = hash(x, y, 41);
        px(x, y, edge ? WOOD.dark : n < 0.15 ? FOAM.white : n < 0.7 ? FOAM.light : FOAM.mid);
      }
    }
  });
  const bottom = pixels(8, 8, (px, w, h) => wood(px, w, h, { vertical: false, seed: 5 }));

  // Mousse qui déborde : bord du haut plein, bord du bas en coulures.
  const foamSide = pixels(9, 3, (px, w) => {
    for (let x = 0; x < w; x += 1) {
      px(x, 0, FOAM.white);
      px(x, 1, hash(x, 1, 7) < 0.4 ? FOAM.mid : FOAM.light);
      if (hash(x, 2, 7) < 0.45) px(x, 2, FOAM.shadow);
    }
  });
  const foamTop = pixels(9, 9, (px, w, h) => {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const n = hash(x, y, 13);
        px(x, y, n < 0.2 ? FOAM.white : n < 0.75 ? FOAM.light : FOAM.mid);
      }
    }
  });
  const blob = pixels(4, 4, (px) => {
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) px(x, y, hash(x, y, 3) < 0.5 ? FOAM.white : FOAM.light);
  });
  // Un filet de bière qui coule le long du fût.
  const drip = pixels(2, 6, (px) => {
    for (let y = 0; y < 6; y += 1) {
      px(0, y, BEER.light);
      if (y < 4) px(1, y, BEER.dark);
    }
  });
  const handleTex = pixels(2, 8, (px, w, h) => {
    wood(px, w, h, { vertical: false, seed: 17, every: 4 });
    px(0, 1, IRON.mid);
    px(1, 1, IRON.light);
    px(0, 6, IRON.mid);
    px(1, 6, IRON.light);
  });

  const mug = K.group(
    K.box(4, 5, 4, { right: side(1), left: side(2), front: side(3), back: side(4), top, bottom }),
    K.box(4.4, 1.1, 4.4, { right: foamSide, left: foamSide, front: foamSide, back: foamSide, top: foamTop, bottom: foamTop }, 0, 2.85, 0),
    K.box(1.8, 0.9, 1.8, blob, 0.7, 3.5, -0.4),
    K.box(1.1, 3, 0.2, drip, -0.9, 1.3, 2.1),
    // Anse : un montant et deux attaches, côté -x.
    K.box(1, 3.4, 1, handleTex, -2.9, 0, 0),
    K.box(1, 0.8, 1, handleTex, -2.3, 1.3, 0),
    K.box(1, 0.8, 1, handleTex, -2.3, -1.3, 0),
  );
  mug.rotation.x = Math.PI / 2;
  // C'est l'anse qui est dans le poing : le fût part vers +x, c'est-à-dire
  // vers l'intérieur (le bras droit est à x = -5) — du côté de la bouche. Le
  // décalage laisse le fût à distance du bras : seule l'anse touche la main.
  mug.position.x = 4.5;
  return K.group(mug);
}

/* ------------------------------------------------------------------ coffre */

/** Habillage d'une face de coffre : planches, cadre sombre, cornières de fer. */
function chestFace(w, h, { seed, lockAt = null, corners = true }) {
  return pixels(w, h, (px) => {
    wood(px, w, h, { vertical: false, seed, every: 3 });
    for (let x = 0; x < w; x += 1) {
      px(x, 0, WOOD.deep);
      px(x, h - 1, WOOD.deep);
    }
    for (let y = 0; y < h; y += 1) {
      px(0, y, WOOD.deep);
      px(w - 1, y, WOOD.deep);
    }
    if (corners) {
      for (const [cx, cy] of [[0, 0], [w - 3, 0], [0, h - 3], [w - 3, h - 3]]) {
        for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) px(cx + x, cy + y, IRON.mid);
        px(cx + 1, cy + 1, IRON.light);
        px(cx + 2, cy + 2, IRON.dark);
      }
    }
    if (lockAt !== null) {
      // Plaque de serrure dorée.
      const lx = Math.floor(w / 2) - 2;
      for (let y = lockAt; y < lockAt + 3 && y < h; y += 1) {
        for (let x = lx; x < lx + 4; x += 1) px(x, y, GOLD.mid);
      }
      px(lx, lockAt, GOLD.light);
      px(lx + 3, Math.min(h - 1, lockAt + 2), GOLD.deep);
    }
  });
}

function buildChest(K) {
  // Caisse : 7 × 4,5 × 5,6 ; couvercle : 7 × 1,9 × 5,6. Deux pixels par unité.
  const bodyFront = chestFace(14, 9, { seed: 21, lockAt: 0 });
  const bodySide = chestFace(11, 9, { seed: 22 });
  const bodyBack = chestFace(14, 9, { seed: 23 });
  // Dessus de la caisse : ce qu'on voit couvercle ouvert — un tas de pièces d'or.
  const treasure = pixels(14, 11, (px, w, h) => {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        if (edge) {
          px(x, y, WOOD.dark);
          continue;
        }
        const n = hash(x, y, 31);
        px(x, y, n < 0.12 ? GOLD.light : n < 0.55 ? GOLD.mid : n < 0.85 ? GOLD.dark : GOLD.deep);
        if (hash(x, y, 33) < 0.03) px(x, y, '#E74C3C'); // un rubis
        if (hash(x, y, 34) < 0.03) px(x, y, '#5DADE2'); // un saphir
      }
    }
  });
  const bodyBottom = pixels(14, 11, (px, w, h) => wood(px, w, h, { vertical: false, seed: 24 }));

  const lidFront = chestFace(14, 4, { seed: 25, lockAt: 2, corners: false });
  const lidSide = chestFace(11, 4, { seed: 26, corners: false });
  const lidTop = pixels(14, 11, (px, w, h) => {
    wood(px, w, h, { vertical: true, seed: 27, every: 3 });
    // Deux sangles de fer sur le couvercle.
    for (const x of [3, w - 4]) {
      for (let y = 0; y < h; y += 1) px(x, y, y % 4 === 1 ? IRON.light : IRON.mid);
    }
    for (let x = 0; x < w; x += 1) {
      px(x, 0, WOOD.deep);
      px(x, h - 1, WOOD.deep);
    }
  });
  const lidInside = pixels(14, 11, (px, w, h) => {
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) px(x, y, hash(x, y, 28) < 0.5 ? WOOD.gap : WOOD.deep);
  });
  const lockTex = pixels(2, 3, (px) => {
    px(0, 0, GOLD.light);
    px(1, 0, GOLD.mid);
    px(0, 1, GOLD.mid);
    px(1, 1, '#1F2328'); // trou de serrure
    px(0, 2, GOLD.dark);
    px(1, 2, GOLD.deep);
  });

  const lid = K.group(
    K.box(7, 1.9, 5.6, { front: lidFront, back: lidSide, right: lidSide, left: lidSide, top: lidTop, bottom: lidInside }, 0, 0.95, 2.8),
    K.box(1, 1.4, 0.5, lockTex, 0, 0.1, 5.75), // moraillon de la serrure
  );
  lid.position.set(0, 2.25, -2.8); // charnière : arête arrière, en haut du coffre
  const body = K.group(
    K.box(7, 4.5, 5.6, { front: bodyFront, back: bodyBack, right: bodySide, left: bodySide, top: treasure, bottom: bodyBottom }),
    lid,
  );
  body.position.y = 2.25;
  return { root: K.group(body), lid };
}

/* ------------------------------------------------------------------ entrée */

/**
 * Construit les trois accessoires.
 * @param {{Mesh: any, Box: any, Material: any, Group: any, Texture: any}} T
 */
export function buildPixelProps(T) {
  const K = kit(T);
  return {
    sword: buildSword(K),
    mug: buildMug(K),
    chest: buildChest(K),
    dispose() {
      for (const t of K.textures) t.dispose();
      for (const m of K.materials.values()) m.dispose();
      for (const m of K.owned) m.dispose();
    },
  };
}
