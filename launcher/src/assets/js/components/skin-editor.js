/**
 * Éditeur de skin — pixel par pixel, avec le personnage en 3D qui suit chaque
 * coup de crayon.
 *
 * Ce que c'est : une grille 64 × 64 agrandie, quatre outils (crayon, gomme,
 * pipette, remplissage), une palette, annuler/rétablir, un guide des parties
 * du corps, et un aperçu 3D (skinview3d) rechargé à chaque trait. On part du
 * skin courant du joueur, ou d'un personnage vierge. « ENREGISTRER » rend le
 * PNG au panneau Paramètres, qui l'envoie au serveur.
 *
 * Ce que ce n'est pas : MCSkin3D. On ne peint pas sur le modèle 3D, il n'y a
 * ni calques ni symétrie ni pinceaux. C'est un éditeur 2D avec un aperçu 3D,
 * volontairement contenu.
 *
 * Le format : la texture 64 × 64 de Minecraft, telle que le jeu la lit. Chaque
 * partie du corps est un pavé déplié en six faces à un endroit fixe de la
 * texture ; la seconde couche (chapeau, veste, manches…) occupe les mêmes
 * dépliages, décalés. `FACES` ci-dessous est ce dépliage : il sert au guide,
 * au personnage vierge, et à assombrir ce que le jeu n'affiche jamais.
 *
 * Aucune dépendance au panneau : `openSkinEditor()` rend une promesse, comme
 * `confirmModal()`, résolue avec `{dataUrl, model}` ou `null` si le joueur
 * renonce. Le module ne parle jamais au serveur.
 */

import { $, el, focusTrap, on } from '../utils/dom.js';

/** Taille de la texture. Un skin 64 × 32 (ancien format) est converti à l'ouverture. */
const SIZE = 64;
/** Agrandissement à l'écran : 64 × 7 = 448 px, ce qui tient dans la fenêtre minimale. */
const ZOOM = 7;
/** Profondeur des piles annuler/rétablir. Un instantané pèse 16 Ko : 80 × 16 Ko, c'est rien. */
const HISTORY_LIMIT = 80;
/** Couleurs récentes conservées dans la palette. */
const PALETTE_LIMIT = 16;

/** Gris neutre du personnage vierge : visible, sans rien inventer. */
const BLANK_COLOR = '#8d8d8d';

/**
 * Dépliage d'un pavé de dimensions (w, h, d) dont le coin est en (ox, oy).
 * L'ordre et la disposition sont ceux de Minecraft : dessus et dessous en
 * haut, puis droite, face, gauche, dos sur une ligne.
 *
 * @param {number} ox
 * @param {number} oy
 * @param {number} w  largeur (face avant)
 * @param {number} h  hauteur
 * @param {number} d  profondeur (face de côté)
 * @returns {Array<[number, number, number, number]>} rectangles x, y, largeur, hauteur
 */
function unfold(ox, oy, w, h, d) {
  return [
    [ox + d, oy, w, d], // dessus
    [ox + d + w, oy, w, d], // dessous
    [ox, oy + d, d, h], // droite
    [ox + d, oy + d, w, h], // face
    [ox + d + w, oy + d, d, h], // gauche
    [ox + d + w + d, oy + d, w, h], // dos
  ];
}

/**
 * Les parties du corps et leurs dépliages, pour un modèle donné.
 * `layer` 1 = peau, 2 = seconde couche (dessinée par-dessus, transparente par défaut).
 *
 * @param {'classic'|'slim'} model
 * @returns {Array<{name: string, layer: 1|2, faces: Array<[number, number, number, number]>}>}
 */
function bodyParts(model) {
  const arm = model === 'slim' ? 3 : 4;
  return [
    { name: 'Tête', layer: 1, faces: unfold(0, 0, 8, 8, 8) },
    { name: 'Chapeau', layer: 2, faces: unfold(32, 0, 8, 8, 8) },
    { name: 'Jambe droite', layer: 1, faces: unfold(0, 16, 4, 12, 4) },
    { name: 'Corps', layer: 1, faces: unfold(16, 16, 8, 12, 4) },
    { name: 'Bras droit', layer: 1, faces: unfold(40, 16, arm, 12, 4) },
    { name: 'Jambe droite · 2e couche', layer: 2, faces: unfold(0, 32, 4, 12, 4) },
    { name: 'Veste', layer: 2, faces: unfold(16, 32, 8, 12, 4) },
    { name: 'Manche droite', layer: 2, faces: unfold(40, 32, arm, 12, 4) },
    { name: 'Jambe gauche · 2e couche', layer: 2, faces: unfold(0, 48, 4, 12, 4) },
    { name: 'Jambe gauche', layer: 1, faces: unfold(16, 48, 4, 12, 4) },
    { name: 'Bras gauche', layer: 1, faces: unfold(32, 48, arm, 12, 4) },
    { name: 'Manche gauche', layer: 2, faces: unfold(48, 48, arm, 12, 4) },
  ];
}

/** Outils, dans l'ordre de la barre. Le raccourci est la première lettre. */
const TOOLS = [
  { id: 'pencil', label: 'Crayon', key: 'c', hint: 'Peint un pixel. Clic droit : pipette.' },
  { id: 'eraser', label: 'Gomme', key: 'g', hint: 'Rend le pixel transparent.' },
  { id: 'picker', label: 'Pipette', key: 'p', hint: 'Prend la couleur du pixel.' },
  { id: 'fill', label: 'Remplir', key: 'r', hint: 'Remplit la zone de même couleur.' },
];

/* -------------------------------------------------------------------------- */

/**
 * Ouvre l'éditeur par-dessus l'application.
 *
 * @param {{
 *   ctx: any,
 *   skinUrl?: string|null,
 *   model?: 'classic'|'slim',
 * }} options  `ctx` est le contexte des panneaux (dom, skin, toast…)
 * @returns {Promise<{dataUrl: string, model: 'classic'|'slim'}|null>}
 */
export function openSkinEditor({ ctx, skinUrl = null, model = 'classic' }) {
  const root = $('[data-el="modal-root"]');
  if (!root) {
    console.error('opm : racine des modales absente — éditeur de skin indisponible.');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const editor = new SkinEditor({ ctx, root, skinUrl, model, resolve });
    editor.open();
  });
}

class SkinEditor {
  constructor({ ctx, root, skinUrl, model, resolve }) {
    this.ctx = ctx;
    this.root = root;
    this.skinUrl = skinUrl;
    this.model = model === 'slim' ? 'slim' : 'classic';
    this.resolve = resolve;

    /** La texture de travail, 64 × 64, en mémoire. C'est elle qu'on enregistre. */
    this.work = document.createElement('canvas');
    this.work.width = SIZE;
    this.work.height = SIZE;
    this.wctx = this.work.getContext('2d', { willReadFrequently: true });

    this.tool = 'pencil';
    this.color = '#3a6ea5';
    /** @type {string[]} */
    this.palette = ['#3a6ea5', '#f2d3b6', '#2b2b2b', '#ffffff', '#c0392b', '#27ae60', '#f1c40f', '#8e44ad'];
    this.showGuide = true;
    this.showLayer2 = true;

    /** @type {ImageData[]} */
    this.undoStack = [];
    /** @type {ImageData[]} */
    this.redoStack = [];
    this.stroking = false;
    this.dirty = false;

    /** @type {Array<() => void>} */
    this.offs = [];
    this.release = null;
    this.viewer = null;
    this.previewQueued = false;
    this.settled = false;
  }

  /* ------------------------------------------------------------ montage */

  async open() {
    this.build();
    this.root.append(this.overlay);
    this.release = focusTrap(this.card, { initial: this.el.save });

    await this.loadInitial();
    this.paint();
    this.ensurePreview();
    this.refreshPreview();
  }

  build() {
    const make = el;

    // Barre d'outils, à gauche.
    this.el = {};
    this.el.tools = TOOLS.map((tool) => make('button', {
      type: 'button',
      class: ['opm-skined__tool', this.tool === tool.id ? 'opm-skined__tool--on' : null],
      title: `${tool.label} (${tool.key.toUpperCase()}) — ${tool.hint}`,
      'aria-label': tool.label,
      'aria-pressed': this.tool === tool.id ? 'true' : 'false',
      dataset: { tool: tool.id },
      text: tool.label,
    }));

    // La grille : la texture agrandie, puis le guide par-dessus.
    this.canvas = make('canvas', {
      class: 'opm-skined__pixels',
      width: SIZE * ZOOM,
      height: SIZE * ZOOM,
      'aria-label': 'Grille du skin, 64 par 64 pixels',
      tabindex: '0',
    });
    this.guide = make('canvas', {
      class: 'opm-skined__guide',
      width: SIZE * ZOOM,
      height: SIZE * ZOOM,
      'aria-hidden': 'true',
    });
    this.el.coords = make('span', { class: 'opm-skined__coords', text: '—' });
    this.el.part = make('span', { class: 'opm-skined__part', text: '' });

    // L'aperçu 3D et les réglages, à droite.
    this.preview = make('canvas', { class: 'opm-skined__preview', 'aria-label': 'Aperçu en 3D' });

    this.el.colorInput = make('input', {
      type: 'color',
      class: 'opm-skined__color',
      value: this.color,
      'aria-label': 'Couleur',
    });
    this.el.colorHex = make('input', {
      type: 'text',
      class: 'opm-skined__hex',
      value: this.color,
      maxlength: '7',
      spellcheck: 'false',
      'aria-label': 'Couleur en hexadécimal',
    });
    this.el.palette = make('div', { class: 'opm-skined__palette', role: 'listbox', 'aria-label': 'Palette' });

    this.el.modelClassic = make('input', { type: 'radio', name: 'skined-model', value: 'classic', checked: this.model === 'classic' });
    this.el.modelSlim = make('input', { type: 'radio', name: 'skined-model', value: 'slim', checked: this.model === 'slim' });
    this.el.guideToggle = make('input', { type: 'checkbox', checked: this.showGuide });
    this.el.layerToggle = make('input', { type: 'checkbox', checked: this.showLayer2 });

    this.el.undo = make('button', { type: 'button', class: ['opm-btn', 'opm-btn--outline'], text: 'ANNULER', title: 'Ctrl+Z' });
    this.el.redo = make('button', { type: 'button', class: ['opm-btn', 'opm-btn--outline'], text: 'RÉTABLIR', title: 'Ctrl+Maj+Z' });
    this.el.reset = make('button', { type: 'button', class: ['opm-btn', 'opm-btn--ghost'], text: 'REPARTIR DE ZÉRO' });
    this.el.cancel = make('button', { type: 'button', class: ['opm-btn', 'opm-btn--ghost'], text: 'FERMER' });
    this.el.save = make('button', { type: 'button', class: ['opm-btn', 'opm-btn--aqua'], text: 'ENREGISTRER' });

    const radio = (input, label, hint) => make('label', { class: 'opm-skined__radio' }, [input, ` ${label} `, make('span', { class: 'opm-skined__hint', text: hint })]);
    const check = (input, label) => make('label', { class: 'opm-skined__check' }, [input, ` ${label}`]);

    this.card = make('div', {
      class: 'opm-skined__card',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'opm-skined-title',
    }, [
      make('div', { class: 'opm-skined__head' }, [
        make('h2', { id: 'opm-skined-title', class: 'opm-skined__title', text: 'DESSINER MON SKIN' }),
        make('p', { class: 'opm-skined__lead', text: "Chaque pixel compte. Le personnage à droite suit vos traits. C'est l'apparence de votre personnage sur One Piece Minecraft." }),
      ]),
      make('div', { class: 'opm-skined__body' }, [
        make('div', { class: 'opm-skined__toolbar', role: 'toolbar', 'aria-label': 'Outils' }, this.el.tools),
        make('div', { class: 'opm-skined__stage' }, [
          make('div', { class: 'opm-skined__grid' }, [this.canvas, this.guide]),
          make('div', { class: 'opm-skined__status' }, [this.el.coords, this.el.part]),
        ]),
        make('div', { class: 'opm-skined__side' }, [
          this.preview,
          make('div', { class: 'opm-skined__section' }, [
            make('p', { class: 'opm-skined__label', text: 'COULEUR' }),
            make('div', { class: 'opm-skined__colorrow' }, [this.el.colorInput, this.el.colorHex]),
            this.el.palette,
          ]),
          make('div', { class: 'opm-skined__section' }, [
            make('p', { class: 'opm-skined__label', text: 'MODÈLE' }),
            make('div', { class: 'opm-skined__radios', role: 'radiogroup' }, [
              radio(this.el.modelClassic, 'Classique', 'bras de 4 px'),
              radio(this.el.modelSlim, 'Slim', 'bras de 3 px'),
            ]),
          ]),
          make('div', { class: 'opm-skined__section' }, [
            check(this.el.guideToggle, 'Guide des parties du corps'),
            check(this.el.layerToggle, 'Afficher la seconde couche'),
          ]),
          make('div', { class: 'opm-skined__history' }, [this.el.undo, this.el.redo, this.el.reset]),
        ]),
      ]),
      make('div', { class: 'opm-skined__foot' }, [this.el.cancel, this.el.save]),
    ]);

    const veil = make('div', { class: 'opm-skined__veil', 'aria-hidden': 'true' });
    this.overlay = make('div', { class: 'opm-skined' }, [veil, this.card]);

    this.wire();
    this.paintPalette();
    this.paintHistory();
  }

  wire() {
    const { offs } = this;

    for (const button of this.el.tools) {
      offs.push(on(button, 'click', () => this.setTool(button.dataset.tool)));
    }

    // Dessin : pointeur capturé pour que le trait continue hors de la grille.
    offs.push(on(this.canvas, 'pointerdown', (event) => this.onPointerDown(event)));
    offs.push(on(this.canvas, 'pointermove', (event) => this.onPointerMove(event)));
    offs.push(on(this.canvas, 'pointerup', (event) => this.onPointerUp(event)));
    offs.push(on(this.canvas, 'pointercancel', (event) => this.onPointerUp(event)));
    offs.push(on(this.canvas, 'pointerleave', () => this.setStatus(null)));
    offs.push(on(this.canvas, 'contextmenu', (event) => event.preventDefault()));

    offs.push(on(this.el.colorInput, 'input', () => this.setColor(this.el.colorInput.value, { remember: false })));
    offs.push(on(this.el.colorInput, 'change', () => this.setColor(this.el.colorInput.value)));
    offs.push(on(this.el.colorHex, 'change', () => {
      const value = this.el.colorHex.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(value)) this.setColor(value.toLowerCase());
      else this.el.colorHex.value = this.color;
    }));
    offs.push(on(this.el.palette, 'click', (event) => {
      const swatch = event.target.closest('[data-color]');
      if (swatch) this.setColor(swatch.dataset.color, { remember: false });
    }));

    offs.push(on(this.el.modelClassic, 'change', () => this.setModel('classic')));
    offs.push(on(this.el.modelSlim, 'change', () => this.setModel('slim')));
    offs.push(on(this.el.guideToggle, 'change', () => { this.showGuide = this.el.guideToggle.checked; this.paintGuide(); }));
    offs.push(on(this.el.layerToggle, 'change', () => { this.showLayer2 = this.el.layerToggle.checked; this.paint(); }));

    offs.push(on(this.el.undo, 'click', () => this.undo()));
    offs.push(on(this.el.redo, 'click', () => this.redo()));
    offs.push(on(this.el.reset, 'click', () => this.resetBlank()));
    offs.push(on(this.el.cancel, 'click', () => this.close(null)));
    offs.push(on(this.el.save, 'click', () => this.save()));

    offs.push(on(this.overlay, 'keydown', (event) => this.onKey(event)));
  }

  /* ------------------------------------------------------------- texture */

  /** Charge le skin courant, ou dessine le personnage vierge. */
  async loadInitial() {
    if (this.skinUrl && typeof this.ctx.skin?.skinImage === 'function') {
      try {
        const image = await this.ctx.skin.skinImage(this.skinUrl);
        this.wctx.clearRect(0, 0, SIZE, SIZE);
        this.wctx.drawImage(image, 0, 0);
        if (image.height === 32) this.convertLegacy();
        return;
      } catch (error) {
        console.warn('opm : skin courant illisible, éditeur ouvert sur un personnage vierge.', error);
      }
    }
    this.drawBlank();
  }

  /**
   * Ancien format 64 × 32 : pas de bras ni de jambe gauches distincts, le jeu
   * réutilisait les droits en miroir. On copie les membres droits à la place
   * des gauches pour que l'éditeur ait quelque chose à montrer ; le miroir face
   * par face n'est pas reproduit — c'est un point de départ, pas une conversion.
   */
  convertLegacy() {
    const c = this.wctx;
    c.drawImage(this.work, 0, 16, 16, 16, 16, 48, 16, 16); // jambe droite → jambe gauche
    c.drawImage(this.work, 40, 16, 16, 16, 32, 48, 16, 16); // bras droit → bras gauche
  }

  /** Personnage vierge : chaque face de la peau en gris neutre, seconde couche vide. */
  drawBlank() {
    const c = this.wctx;
    c.clearRect(0, 0, SIZE, SIZE);
    c.fillStyle = BLANK_COLOR;
    for (const part of bodyParts(this.model)) {
      if (part.layer !== 1) continue;
      for (const [x, y, w, h] of part.faces) c.fillRect(x, y, w, h);
    }
  }

  /** Repartir de zéro, en gardant la possibilité d'annuler. */
  resetBlank() {
    this.pushUndo();
    this.drawBlank();
    this.afterEdit();
  }

  /* --------------------------------------------------------------- outils */

  setTool(id) {
    if (!TOOLS.some((tool) => tool.id === id)) return;
    this.tool = id;
    for (const button of this.el.tools) {
      const active = button.dataset.tool === id;
      button.classList.toggle('opm-skined__tool--on', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  setColor(value, { remember = true } = {}) {
    this.color = value;
    this.el.colorInput.value = value;
    this.el.colorHex.value = value;
    if (remember) this.rememberColor(value);
  }

  rememberColor(value) {
    const list = this.palette.filter((item) => item !== value);
    list.unshift(value);
    this.palette = list.slice(0, PALETTE_LIMIT);
    this.paintPalette();
  }

  paintPalette() {
    this.el.palette.replaceChildren(
      ...this.palette.map((value) => el('button', {
        type: 'button',
        class: ['opm-skined__swatch', value === this.color ? 'opm-skined__swatch--on' : null],
        style: { 'background-color': value },
        title: value,
        'aria-label': `Couleur ${value}`,
        dataset: { color: value },
      })),
    );
  }

  setModel(model) {
    if (model === this.model) return;
    this.model = model;
    this.paintGuide();
    this.refreshPreview();
  }

  /* --------------------------------------------------------------- dessin */

  /**
   * Pixel de la texture sous le pointeur, ou `null` hors grille.
   * @param {PointerEvent} event
   * @returns {{x: number, y: number}|null}
   */
  pixelAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scale = rect.width / (SIZE * ZOOM);
    const x = Math.floor((event.clientX - rect.left) / (ZOOM * scale));
    const y = Math.floor((event.clientY - rect.top) / (ZOOM * scale));
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return null;
    return { x, y };
  }

  onPointerDown(event) {
    const pixel = this.pixelAt(event);
    if (!pixel) return;
    event.preventDefault();
    this.canvas.focus({ preventScroll: true });

    // Clic droit : pipette, quel que soit l'outil — le réflexe des éditeurs de pixel art.
    if (event.button === 2) {
      this.pick(pixel);
      return;
    }
    if (event.button !== 0) return;

    if (this.tool === 'picker') {
      this.pick(pixel);
      return;
    }

    this.canvas.setPointerCapture(event.pointerId);
    this.stroking = true;
    this.pushUndo();

    if (this.tool === 'fill') {
      this.floodFill(pixel);
      this.stroking = false;
      this.afterEdit();
      return;
    }
    this.plot(pixel);
    this.afterEdit();
  }

  onPointerMove(event) {
    const pixel = this.pixelAt(event);
    this.setStatus(pixel);
    if (!this.stroking || !pixel) return;
    if (this.tool === 'pencil' || this.tool === 'eraser') {
      this.plot(pixel);
      this.afterEdit();
    }
  }

  onPointerUp(event) {
    if (!this.stroking) return;
    this.stroking = false;
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* la capture a pu être perdue : sans conséquence */
    }
    if (this.tool === 'pencil') this.rememberColor(this.color);
  }

  /** Peint (ou efface) un pixel avec l'outil courant. */
  plot({ x, y }) {
    if (this.tool === 'eraser') {
      this.wctx.clearRect(x, y, 1, 1);
      return;
    }
    this.wctx.fillStyle = this.color;
    this.wctx.fillRect(x, y, 1, 1);
  }

  /** Pipette : la couleur du pixel devient la couleur courante (un pixel vide ne change rien). */
  pick({ x, y }) {
    const [r, g, b, a] = this.wctx.getImageData(x, y, 1, 1).data;
    if (a === 0) return;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    this.setColor(hex);
    this.setTool('pencil');
  }

  /**
   * Remplissage : tous les pixels contigus (4 voisins) de la même couleur que
   * le pixel cliqué prennent la couleur courante. Borné à la face cliquée : on
   * ne déborde jamais sur une autre partie du corps, même si les couleurs se
   * touchent sur la texture.
   */
  floodFill({ x, y }) {
    const face = this.faceAt(x, y);
    const [fx, fy, fw, fh] = face ?? [0, 0, SIZE, SIZE];
    const image = this.wctx.getImageData(0, 0, SIZE, SIZE);
    const data = image.data;
    const at = (px, py) => (py * SIZE + px) * 4;
    const start = at(x, y);
    const target = [data[start], data[start + 1], data[start + 2], data[start + 3]];
    const [nr, ng, nb] = hexToRgb(this.color);
    if (target[0] === nr && target[1] === ng && target[2] === nb && target[3] === 255) return;

    const same = (i) => data[i] === target[0] && data[i + 1] === target[1]
      && data[i + 2] === target[2] && data[i + 3] === target[3];

    const stack = [[x, y]];
    while (stack.length) {
      const [px, py] = stack.pop();
      if (px < fx || py < fy || px >= fx + fw || py >= fy + fh) continue;
      const i = at(px, py);
      if (!same(i)) continue;
      data[i] = nr;
      data[i + 1] = ng;
      data[i + 2] = nb;
      data[i + 3] = 255;
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
    this.wctx.putImageData(image, 0, 0);
  }

  /** La face (rectangle) qui contient ce pixel, ou `null` hors de tout dépliage. */
  faceAt(x, y) {
    for (const part of bodyParts(this.model)) {
      for (const face of part.faces) {
        const [fx, fy, fw, fh] = face;
        if (x >= fx && y >= fy && x < fx + fw && y < fy + fh) return face;
      }
    }
    return null;
  }

  /** Le nom de la partie du corps sous ce pixel, pour la ligne d'état. */
  partAt(x, y) {
    for (const part of bodyParts(this.model)) {
      for (const [fx, fy, fw, fh] of part.faces) {
        if (x >= fx && y >= fy && x < fx + fw && y < fy + fh) return part.name;
      }
    }
    return 'Hors du personnage — ignoré par le jeu';
  }

  setStatus(pixel) {
    if (!pixel) {
      this.el.coords.textContent = '—';
      this.el.part.textContent = '';
      return;
    }
    this.el.coords.textContent = `${pixel.x}, ${pixel.y}`;
    this.el.part.textContent = this.partAt(pixel.x, pixel.y);
  }

  afterEdit() {
    this.dirty = true;
    this.paint();
    this.refreshPreview();
  }

  /* ------------------------------------------------------------ historique */

  pushUndo() {
    this.undoStack.push(this.wctx.getImageData(0, 0, SIZE, SIZE));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.paintHistory();
  }

  undo() {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    this.redoStack.push(this.wctx.getImageData(0, 0, SIZE, SIZE));
    this.wctx.putImageData(snapshot, 0, 0);
    this.paintHistory();
    this.afterEdit();
  }

  redo() {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return;
    this.undoStack.push(this.wctx.getImageData(0, 0, SIZE, SIZE));
    this.wctx.putImageData(snapshot, 0, 0);
    this.paintHistory();
    this.afterEdit();
  }

  paintHistory() {
    this.el.undo.disabled = this.undoStack.length === 0;
    this.el.redo.disabled = this.redoStack.length === 0;
  }

  onKey(event) {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close(null);
      return;
    }
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (meta && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    // Raccourcis d'outil, seulement hors des champs de saisie.
    if (!meta && event.target instanceof HTMLElement && !/^(INPUT|TEXTAREA)$/.test(event.target.tagName)) {
      const tool = TOOLS.find((item) => item.key === event.key.toLowerCase());
      if (tool) {
        event.preventDefault();
        this.setTool(tool.id);
      }
    }
  }

  /* ---------------------------------------------------------------- rendu */

  /** Redessine la grille : damier, texture agrandie sans lissage, zones mortes assombries. */
  paint() {
    const c = this.canvas.getContext('2d');
    const px = SIZE * ZOOM;
    c.imageSmoothingEnabled = false;

    // Damier : la transparence doit se voir.
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        c.fillStyle = (x + y) % 2 === 0 ? '#d9dfe1' : '#c3cbce';
        c.fillRect(x * ZOOM, y * ZOOM, ZOOM, ZOOM);
      }
    }

    if (this.showLayer2) {
      c.drawImage(this.work, 0, 0, px, px);
    } else {
      // Seconde couche masquée : on ne dessine que les faces de la peau.
      for (const part of bodyParts(this.model)) {
        if (part.layer !== 1) continue;
        for (const [x, y, w, h] of part.faces) {
          c.drawImage(this.work, x, y, w, h, x * ZOOM, y * ZOOM, w * ZOOM, h * ZOOM);
        }
      }
    }

    // Ce que le jeu n'affiche jamais, assombri — pour ne pas y dessiner pour rien.
    c.fillStyle = 'rgba(15, 26, 25, .55)';
    const covered = new Uint8Array(SIZE * SIZE);
    for (const part of bodyParts(this.model)) {
      for (const [x, y, w, h] of part.faces) {
        for (let yy = y; yy < y + h; yy += 1) {
          for (let xx = x; xx < x + w; xx += 1) covered[yy * SIZE + xx] = 1;
        }
      }
    }
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        if (!covered[y * SIZE + x]) c.fillRect(x * ZOOM, y * ZOOM, ZOOM, ZOOM);
      }
    }

    this.paintGuide();
  }

  /** Le guide : contour de chaque face, et le nom de chaque partie. */
  paintGuide() {
    const c = this.guide.getContext('2d');
    c.clearRect(0, 0, SIZE * ZOOM, SIZE * ZOOM);
    if (!this.showGuide) return;

    for (const part of bodyParts(this.model)) {
      c.strokeStyle = part.layer === 1 ? 'rgba(145, 217, 209, .9)' : 'rgba(241, 196, 15, .8)';
      c.lineWidth = 1;
      for (const [x, y, w, h] of part.faces) {
        c.strokeRect(x * ZOOM + 0.5, y * ZOOM + 0.5, w * ZOOM - 1, h * ZOOM - 1);
      }
      // L'étiquette sur la face avant (la 4e du dépliage), la plus grande.
      const [fx, fy, fw] = part.faces[3];
      c.font = '600 10px "Space Grotesk", system-ui, sans-serif';
      c.fillStyle = part.layer === 1 ? 'rgba(15, 26, 25, .85)' : 'rgba(80, 60, 0, .9)';
      c.textAlign = 'center';
      c.fillText(part.name.replace(' · 2e couche', ' ²'), (fx + fw / 2) * ZOOM, fy * ZOOM + 12);
    }
  }

  /* ----------------------------------------------------------- aperçu 3D */

  ensurePreview() {
    if (this.viewer || typeof window.skinview3d === 'undefined') return;
    try {
      const lib = window.skinview3d;
      this.viewer = new lib.SkinViewer({ canvas: this.preview, width: 260, height: 300 });
      this.viewer.fov = 40;
      this.viewer.zoom = 1.05;
      this.viewer.animation = new lib.IdleAnimation();
      this.viewer.animation.speed = 0.6;
      this.viewer.autoRotate = true;
      this.viewer.autoRotateSpeed = 0.5;
      if (this.viewer.controls) {
        this.viewer.controls.enableZoom = false;
        this.viewer.controls.enablePan = false;
      }
    } catch (error) {
      console.warn('opm : aperçu 3D de l’éditeur indisponible.', error);
      this.viewer = null;
      this.preview.hidden = true;
    }
  }

  /** Recharge la texture dans l'aperçu, au plus une fois par image affichée. */
  refreshPreview() {
    if (!this.viewer || this.previewQueued) return;
    this.previewQueued = true;
    requestAnimationFrame(() => {
      this.previewQueued = false;
      if (!this.viewer) return;
      try {
        // Avec un canevas en source, skinview3d recharge de façon SYNCHRONE et ne
        // rend rien ; avec une URL il rend une promesse. On accepte les deux.
        const result = this.viewer.loadSkin(this.work, { model: this.model === 'slim' ? 'slim' : 'default' });
        if (result && typeof result.catch === 'function') {
          result.catch((error) => console.warn('opm : aperçu 3D non rechargé.', error));
        }
      } catch (error) {
        console.warn('opm : aperçu 3D non rechargé.', error);
      }
    });
  }

  /* ---------------------------------------------------------- fermeture */

  async save() {
    if (this.settled) return;
    let dataUrl;
    try {
      dataUrl = this.work.toDataURL('image/png');
    } catch (error) {
      console.error('opm : export du skin impossible.', error);
      this.ctx.toast?.({ kind: 'error', title: 'Skin', message: "Le skin n'a pas pu être exporté." });
      return;
    }
    this.close({ dataUrl, model: this.model });
  }

  async close(result) {
    if (this.settled) return;
    if (result === null && this.dirty) {
      const confirmed = await this.ctx.confirmModal?.({
        title: 'Fermer sans enregistrer ?',
        message: 'Vos modifications seront perdues.',
        confirmLabel: 'FERMER',
        danger: true,
      });
      if (!confirmed) return;
    }
    this.settled = true;
    for (const off of this.offs) off();
    this.offs = [];
    if (this.viewer) {
      try {
        this.viewer.dispose();
      } catch {
        /* rien à rattraper */
      }
      this.viewer = null;
    }
    if (this.release) this.release();
    this.overlay.remove();
    this.resolve(result);
  }
}

/**
 * `#rrggbb` → [r, g, b].
 * @param {string} hex
 * @returns {[number, number, number]}
 */
function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}
