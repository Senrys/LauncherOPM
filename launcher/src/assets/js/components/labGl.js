/**
 * Le laboratoire, côté WebGL : matrices, modèles GeckoLib, salle et textures.
 *
 * Le portage de `client/LabData`, `client/GeoModel` et des outils de
 * `client/LabScene` du mod : mêmes données (paquet de ressources, `labo/`), mêmes
 * calculs. Un seul shader — position, texture, couleur —, la lumière est déjà
 * calculée dans la couleur des sommets.
 */

import { packBytes, packImage, packJson } from '../utils/pack.js';

export const DEG = Math.PI / 180;

/* ---------------------------------------------------------------- matrices */

/** Une matrice 4 × 4 (colonnes), à multiplications à droite, comme JOML. */
export class M4 {
  constructor(m) {
    this.m = m ? Float64Array.from(m.m) : new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }

  clone() {
    return new M4(this);
  }

  mul(o) {
    const a = this.m;
    const b = o.m;
    const r = new Float64Array(16);
    for (let c = 0; c < 4; c += 1) {
      for (let l = 0; l < 4; l += 1) {
        r[c * 4 + l] = a[l] * b[c * 4] + a[4 + l] * b[c * 4 + 1] + a[8 + l] * b[c * 4 + 2] + a[12 + l] * b[c * 4 + 3];
      }
    }
    this.m = r;
    return this;
  }

  translate(x, y, z) {
    const a = this.m;
    for (let l = 0; l < 4; l += 1) a[12 + l] += a[l] * x + a[4 + l] * y + a[8 + l] * z;
    return this;
  }

  scale(x, y = x, z = x) {
    const a = this.m;
    for (let l = 0; l < 4; l += 1) {
      a[l] *= x;
      a[4 + l] *= y;
      a[8 + l] *= z;
    }
    return this;
  }

  rot(i, j, angle) {
    const a = this.m;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    for (let l = 0; l < 4; l += 1) {
      const u = a[i * 4 + l];
      const v = a[j * 4 + l];
      a[i * 4 + l] = u * c + v * s;
      a[j * 4 + l] = v * c - u * s;
    }
    return this;
  }

  rotX(a) {
    return this.rot(1, 2, a);
  }

  rotY(a) {
    return this.rot(2, 0, a);
  }

  rotZ(a) {
    return this.rot(0, 1, a);
  }

  point(x, y, z) {
    const a = this.m;
    return [a[0] * x + a[4] * y + a[8] * z + a[12], a[1] * x + a[5] * y + a[9] * z + a[13], a[2] * x + a[6] * y + a[10] * z + a[14]];
  }

  dir(x, y, z) {
    const a = this.m;
    return [a[0] * x + a[4] * y + a[8] * z, a[1] * x + a[5] * y + a[9] * z, a[2] * x + a[6] * y + a[10] * z];
  }

  /** L'inverse d'une transformation affine. */
  inverse() {
    const a = this.m;
    const [a00, a01, a02, , a10, a11, a12, , a20, a21, a22, , tx, ty, tz] = a;
    const b01 = a22 * a11 - a12 * a21;
    const b11 = a12 * a20 - a22 * a10;
    const b21 = a21 * a10 - a11 * a20;
    const det = 1 / (a00 * b01 + a01 * b11 + a02 * b21);
    const r = new M4();
    r.m.set([
      b01 * det, (a02 * a21 - a22 * a01) * det, (a12 * a01 - a02 * a11) * det, 0,
      b11 * det, (a22 * a00 - a02 * a20) * det, (a02 * a10 - a12 * a00) * det, 0,
      b21 * det, (a01 * a20 - a21 * a00) * det, (a11 * a00 - a01 * a10) * det, 0, 0, 0, 0, 1,
    ]);
    const p = r.dir(-tx, -ty, -tz);
    [r.m[12], r.m[13], r.m[14]] = p;
    return r;
  }

  static perspective(fovy, aspect, near, far, shiftX = 0, shiftY = 0) {
    const f = 1 / Math.tan(fovy / 2);
    const r = new M4();
    r.m.set([f / aspect, 0, 0, 0, 0, f, 0, 0, -shiftX, -shiftY, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
    return r;
  }

  static lookAt(e, t) {
    const n = (v) => {
      const l = Math.hypot(...v) || 1;
      return v.map((k) => k / l);
    };
    const f = n([e[0] - t[0], e[1] - t[1], e[2] - t[2]]);
    const s = n([f[2], 0, -f[0]]);
    const u = [f[1] * s[2] - f[2] * s[1], f[2] * s[0] - f[0] * s[2], f[0] * s[1] - f[1] * s[0]];
    const r = new M4();
    r.m.set([s[0], u[0], f[0], 0, s[1], u[1], f[1], 0, s[2], u[2], f[2], 0, 0, 0, 0, 1]);
    const p = r.dir(-e[0], -e[1], -e[2]);
    [r.m[12], r.m[13], r.m[14]] = p;
    return r;
  }
}

/* ----------------------------------------------------------------- modèles */

const vec = (p) => [-p[0], p[1], p[2]];
const LIGHT = (() => {
  const l = Math.hypot(-0.35, 0.85, 0.55);
  return [-0.35 / l, 0.85 / l, 0.55 / l];
})();
const FACES = [
  { ua: 2, va: 1, wa: 0, du: -1, dv: -1, sign: 1 },
  { ua: 2, va: 1, wa: 0, du: 1, dv: -1, sign: -1 },
  { ua: 0, va: 2, wa: 1, du: 1, dv: 1, sign: 1 },
  { ua: 0, va: 2, wa: 1, du: 1, dv: -1, sign: -1 },
  { ua: 0, va: 1, wa: 2, du: 1, dv: -1, sign: 1 },
  { ua: 0, va: 1, wa: 2, du: -1, dv: -1, sign: -1 },
];
const ORDER = [[0, 0], [0, 1], [1, 1], [1, 0]];

function sample(track, t) {
  const { times, values, smooth } = track;
  const last = times.length - 1;
  if (t <= times[0]) return values[0];
  if (t >= times[last]) return values[last];
  let i = 0;
  while (t > times[i + 1]) i += 1;
  const k = (t - times[i]) / (times[i + 1] - times[i]);
  const a = values[i];
  const b = values[i + 1];
  if (!smooth[i] && !smooth[i + 1]) return a.map((v, n) => v + (b[n] - v) * k);
  const p0 = values[Math.max(0, i - 1)];
  const p3 = values[Math.min(last, i + 2)];
  return a.map((v, n) => 0.5 * (2 * v + (-p0[n] + b[n]) * k + (2 * p0[n] - 5 * v + 4 * b[n] - p3[n]) * k * k
    + (-p0[n] + 3 * v - 3 * b[n] + p3[n]) * k * k * k));
}

function track(channel) {
  if (!channel) return null;
  if (Array.isArray(channel)) return { times: [0], values: [channel], smooth: [false] };
  const e = Object.entries(channel).sort((a, b) => Number(a[0]) - Number(b[0]));
  return {
    times: e.map(([k]) => Number(k)),
    values: e.map(([, v]) => (Array.isArray(v) ? v : v.post ?? v.pre)),
    smooth: e.map(([, v]) => !Array.isArray(v) && v.lerp_mode === 'catmullrom'),
  };
}

/** Un modèle GeckoLib, dessiné sans GeckoLib : le portage de client/GeoModel. */
export class GeoModel {
  constructor(doc, anims, prefix) {
    const g = doc['minecraft:geometry'][0];
    this.tw = g.description.texture_width;
    this.th = g.description.texture_height;
    this.bones = [];
    this.byName = new Map();
    for (const d of g.bones) {
      const pivot = vec(d.pivot);
      const parent = d.parent ? this.byName.get(d.parent) : null;
      const base = parent ? parent.pivot : [0, 0, 0];
      const r = d.rotation ?? [0, 0, 0];
      const bone = {
        name: d.name, parent, pivot, children: [],
        position: [pivot[0] - base[0], pivot[1] - base[1], pivot[2] - base[2]],
        rotation: [-r[0] * DEG, -r[1] * DEG, r[2] * DEG],
        cubes: (d.cubes ?? []).map((c) => ({
          from: [-(c.origin[0] + c.size[0]), c.origin[1], c.origin[2]], size: c.size, uv: c.uv,
          pivot: c.pivot ? vec(c.pivot) : null,
          rotation: c.rotation ? [-c.rotation[0] * DEG, -c.rotation[1] * DEG, c.rotation[2] * DEG] : null,
          inflate: c.inflate ?? 0,
        })),
      };
      parent?.children.push(bone);
      this.bones.push(bone);
      this.byName.set(d.name, bone);
    }
    this.anims = new Map();
    for (const [name, a] of Object.entries(anims?.animations ?? {})) {
      this.anims.set(name.replace(`${prefix}.`, ''), {
        length: a.animation_length ?? 1, loop: a.loop === true,
        bones: Object.entries(a.bones ?? {}).map(([b, ch]) => [b, track(ch.rotation), track(ch.position)]),
      });
    }
  }

  static async load(name, prefix) {
    const [geo, anims] = await Promise.all([packJson(`geckolib/geo/${name}.geo.json`), packJson(`geckolib/animations/${name}.animation.json`)]);
    return geo ? new GeoModel(geo, anims, prefix) : null;
  }

  pose(anim, t) {
    const p = { rot: new Map(), pos: new Map() };
    for (const b of this.bones) {
      p.rot.set(b.name, [...b.rotation]);
      p.pos.set(b.name, [...b.position]);
    }
    const a = anim ? this.anims.get(anim) : null;
    if (a) {
      const tt = a.length > 0 ? (a.loop ? t % a.length : Math.min(t, a.length)) : 0;
      for (const [name, r, q] of a.bones) add(p, name, r && sample(r, tt), q && sample(q, tt));
    }
    return p;
  }

  local(pose, b) {
    const p = pose.pos.get(b.name);
    const r = pose.rot.get(b.name);
    return (m) => m.translate(p[0], p[1], p[2]).rotZ(r[2]).rotY(r[1]).rotX(r[0]);
  }

  /** Où se trouve un os, dans le repère du modèle. */
  point(pose, name, dx = 0, dy = 0, dz = 0) {
    const chain = [];
    for (let b = this.byName.get(name); b; b = b.parent) chain.unshift(b);
    const m = new M4();
    for (const b of chain) this.local(pose, b)(m);
    const q = m.point(0, 0, 0);
    return [q[0] + dx, q[1] + dy, q[2] + dz];
  }

  /** Écrit les faces dans un lot. `viewRot` : la rotation de la caméra, pour l'ombrage (`null` : pleine lumière). */
  emit(batch, pose, world, viewRot, rgb, alpha) {
    const visit = (b, parent) => {
      const m = this.local(pose, b)(parent.clone());
      for (const c of b.cubes) {
        const ctr = [c.from[0] + c.size[0] / 2, c.from[1] + c.size[1] / 2, c.from[2] + c.size[2] / 2];
        const k = m.clone();
        if (c.rotation) {
          k.translate(c.pivot[0] - b.pivot[0], c.pivot[1] - b.pivot[1], c.pivot[2] - b.pivot[2])
            .rotZ(c.rotation[2]).rotY(c.rotation[1]).rotX(c.rotation[0])
            .translate(ctr[0] - c.pivot[0], ctr[1] - c.pivot[1], ctr[2] - c.pivot[2]);
        } else {
          k.translate(ctr[0] - b.pivot[0], ctr[1] - b.pivot[1], ctr[2] - b.pivot[2]);
        }
        this.cube(batch, k, c, viewRot, rgb, alpha);
      }
      for (const child of b.children) visit(child, m);
    };
    visit(this.bones[0], world);
  }

  cube(batch, m, c, viewRot, rgb, alpha) {
    const [w, h, d] = c.size;
    const [u, v] = c.uv;
    const rects = [[u, v + d, d, h], [u + d + w, v + d, d, h], [u + d, v, w, d], [u + d + w, v, w, d], [u + 2 * d + w, v + d, w, h], [u + d, v + d, w, h]];
    for (let f = 0; f < 6; f += 1) {
      const F = FACES[f];
      const U = c.size[F.ua] + 2 * c.inflate;
      const V = c.size[F.va] + 2 * c.inflate;
      const D = (c.size[F.wa] + 2 * c.inflate) * F.sign;
      const rect = rects[f];
      const flip = f === 2 || f === 3;
      let lum = 1;
      if (viewRot) {
        const n = [0, 0, 0];
        n[F.wa] = F.sign;
        const wn = viewRot.dir(...m.dir(...n));
        const l = Math.hypot(...wn) || 1;
        lum = 0.55 + 0.45 * Math.max(0, (wn[0] * LIGHT[0] + wn[1] * LIGHT[1] + wn[2] * LIGHT[2]) / l);
      }
      for (const [ix, iy] of ORDER) {
        const pt = [0, 0, 0];
        pt[F.ua] = (ix * U - U / 2) * F.du;
        pt[F.va] = (iy * V - V / 2) * F.dv;
        pt[F.wa] = D / 2;
        const p = m.point(pt[0], pt[1], pt[2]);
        batch.vertex(p[0], p[1], p[2], (rect[0] + ix * rect[2]) / this.tw,
          (flip ? rect[1] + (1 - iy) * rect[3] : rect[1] + iy * rect[3]) / this.th, rgb[0] * lum, rgb[1] * lum, rgb[2] * lum, alpha);
      }
    }
  }
}

/** Ajoute des décalages en degrés (convention Bedrock) et en unités. */
export function add(p, bone, r, q) {
  const rot = p.rot.get(bone);
  if (!rot) return;
  if (r) {
    rot[0] -= r[0] * DEG;
    rot[1] -= r[1] * DEG;
    rot[2] += r[2] * DEG;
  }
  if (q) {
    const pos = p.pos.get(bone);
    pos[0] -= q[0];
    pos[1] += q[1];
    pos[2] += q[2];
  }
}

export function blend(a, b, k) {
  const out = { rot: new Map(), pos: new Map() };
  for (const key of ['rot', 'pos']) {
    for (const [n, x] of a[key]) {
      const y = b[key].get(n) ?? x;
      out[key].set(n, [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k]);
    }
  }
  return out;
}

export function copyPose(p) {
  const out = { rot: new Map(), pos: new Map() };
  for (const key of ['rot', 'pos']) for (const [n, v] of p[key]) out[key].set(n, [...v]);
  return out;
}

/* ------------------------------------------------------------------ dessin */

const STRIDE = 9;

/** Un lot de quads, refait à chaque image. */
class Batch {
  constructor() {
    this.data = new Float32Array(STRIDE * 4 * 2048);
    this.n = 0;
  }

  vertex(x, y, z, u, v, r, g, b, a) {
    if (this.n + STRIDE > this.data.length) {
      const bigger = new Float32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    const d = this.data;
    let n = this.n;
    d[n++] = x; d[n++] = y; d[n++] = z; d[n++] = u; d[n++] = v; d[n++] = r; d[n++] = g; d[n++] = b; d[n++] = a;
    this.n = n;
  }
}

const VERT = `#version 300 es
layout(location=0) in vec3 p; layout(location=1) in vec2 t; layout(location=2) in vec4 c;
uniform mat4 m; out vec2 uv; out vec4 col;
void main() { uv = t; col = c; gl_Position = m * vec4(p, 1.0); }`;
const FRAG = `#version 300 es
precision mediump float; uniform sampler2D s; in vec2 uv; in vec4 col; out vec4 o;
void main() { vec4 k = texture(s, uv) * col; if (k.a < 0.004) discard; o = vec4(k.rgb * k.a, k.a); }`;

/** Le contexte de dessin : un shader, des textures, des lots. */
export class Painter {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL 2 indisponible');
    this.gl = gl;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    this.prog = prog;
    this.loc = gl.getUniformLocation(prog, 'm');
    this.batch = new Batch();
    this.white = this.texture(null);
    this.quads = 0;
    this.ibo = gl.createBuffer();
    this.dyn = this.buffer();
  }

  texture(img) {
    const { gl } = this;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (img) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }

  smooth(t) {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  buffer(data) {
    const { gl } = this;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    if (data) gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    [[0, 3, 0], [1, 2, 12], [2, 4, 20]].forEach(([i, n, at]) => {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, n, gl.FLOAT, false, STRIDE * 4, at);
    });
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);
    return { vao, vbo, count: data ? data.length / STRIDE / 4 : 0 };
  }

  indices(quads) {
    if (quads <= this.quads) return;
    const { gl } = this;
    this.quads = Math.max(quads, this.quads * 2, 4096);
    const idx = new Uint32Array(this.quads * 6);
    for (let i = 0; i < this.quads; i += 1) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }

  begin(w, h, viewProj) {
    const { gl } = this;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc, false, Float32Array.from(viewProj.m));
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    this.additive(false);
  }

  additive(on) {
    const { gl } = this;
    if (on) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(!on);
  }

  depth(on) {
    this.gl.depthMask(on);
  }

  use(tex) {
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
  }

  /** Envoie le lot courant. */
  flush() {
    const { gl, batch, dyn } = this;
    const quads = batch.n / STRIDE / 4;
    if (quads > 0) {
      this.indices(quads);
      gl.bindVertexArray(dyn.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, dyn.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, batch.data.subarray(0, batch.n), gl.DYNAMIC_DRAW);
      gl.drawElements(gl.TRIANGLES, quads * 6, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }
    batch.n = 0;
  }

  draw(buf) {
    const { gl } = this;
    this.indices(buf.count);
    gl.bindVertexArray(buf.vao);
    gl.drawElements(gl.TRIANGLES, buf.count * 6, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  free(buf) {
    this.gl.deleteVertexArray(buf.vao);
    this.gl.deleteBuffer(buf.vbo);
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/* ---------------------------------------------------------------- la salle */

export const BASE = 0;
export const GLOW = 1;
export const TRANS = 2;

/** La salle préparée par xenodys/labo.py (paquet de ressources). */
export class LabData {
  static async load(painter) {
    const [meta, bytes] = await Promise.all([packJson('labo/labo.json'), packBytes('labo/labo.bin')]);
    if (!meta || !bytes) throw new Error('laboratoire absent du paquet');
    const d = new LabData();
    d.painter = painter;
    d.meta = meta;
    d.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    d.offsets = ['base', 'lueur', 'trans'].map((k) => meta.couches[k][0]);
    d.entries = meta.blocs;
    d.foundation = meta.socle;
    d.posts = meta.postes;
    d.glowing = new Set(meta.lumineuses);
    const named = new Map();
    d.pieces = meta.pieces.map((p) => {
      const piece = {
        owner: p.machine, name: p.nom, state: p.etat || null, parent: p.parent ? named.get(`${p.machine}:${p.parent}`) : null,
        pivot: p.pivot, anims: p.anims, q: p.q,
        base: new M4().translate(...p.pos).rotY(p.rot * DEG).scale(p.s).translate(-0.5, 0, -0.5),
      };
      named.set(`${p.machine}:${p.nom}`, piece);
      return piece;
    });
    d.atlases = new Map();
    await Promise.all(['creatrice', 'corrompue'].flatMap((e) => [false, true].map((g) => d.prepareAtlas(e, g))));
    return d;
  }

  async prepareAtlas(etat, glow) {
    const name = etat + (glow ? '_lueur' : '');
    const [img, bands] = await Promise.all([packImage(`labo/atlas_${name}.png`), packImage(`labo/bandes_${name}.png`)]);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0);
    this.atlases.set(name, { canvas, g, bands, tex: this.painter.texture(canvas), shown: [] });
  }

  /** L'atlas d'un état (ou sa couche lumineuse), à jour de ses animations. */
  atlas(etat, glow, t) {
    const a = this.atlases.get(etat + (glow ? '_lueur' : ''));
    const { anims, colonnes } = this.meta.atlas;
    let dirty = false;
    anims.forEach((s, row) => {
      const frame = Math.floor((t * 20) / Math.max(1, s.duree)) % s.images;
      if (a.shown[row] === frame) return;
      a.shown[row] = frame;
      dirty = true;
      const x = (s.case % colonnes) * 16;
      const y = Math.floor(s.case / colonnes) * 16;
      a.g.clearRect(x, y, 16, 16);
      a.g.drawImage(a.bands, frame * 16, row * 16, 16, 16, x, y, 16, 16);
    });
    if (dirty) {
      const { gl } = this.painter;
      gl.bindTexture(gl.TEXTURE_2D, a.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a.canvas);
    }
    return a.tex;
  }

  /** Une texture 16 × 16, sa lueur comprise : le décor du launcher y prend ses blocs. */
  tile(etat, name) {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const g = c.getContext('2d');
    const [x, y] = this.cell(name);
    for (const layer of [etat, `${etat}_lueur`]) g.drawImage(this.atlases.get(layer).canvas, x, y, 16, 16, 0, 0, 16, 16);
    return c;
  }

  cell(tile) {
    const i = this.meta.tuiles[tile] ?? 0;
    return [(i % this.meta.atlas.colonnes) * 16, Math.floor(i / this.meta.atlas.colonnes) * 16];
  }

  emit(batch, layer, first, count, corrupted, m) {
    const { view } = this;
    const { largeur, hauteur } = this.meta.atlas;
    const col = corrupted ? 24 : 20;
    let at = this.offsets[layer] + first * 112;
    for (let i = 0; i < count * 4; i += 1, at += 28) {
      let x = view.getFloat32(at, true);
      let y = view.getFloat32(at + 4, true);
      let z = view.getFloat32(at + 8, true);
      if (m) [x, y, z] = m.point(x, y, z);
      batch.vertex(x, y, z, view.getFloat32(at + 12, true) / largeur, view.getFloat32(at + 16, true) / hauteur,
        view.getUint8(at + col) / 255, view.getUint8(at + col + 1) / 255, view.getUint8(at + col + 2) / 255, 1);
    }
  }
}
