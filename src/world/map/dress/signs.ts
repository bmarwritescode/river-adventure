import type { MeshArrays } from '../buildTile';
import type { TileSign } from '../types';
import type { DressContext, LabelRequest } from './houses';

/**
 * Text signs: street-name blades, STOP text, shop fronts, landmark lettering. Each sign is a textured
 * quad; all of a tile's sign texts are painted into one small atlas (one texture + one draw call per
 * tile), shelf-packed. Labels without a background are cut-out letters (the material alpha-tests).
 */

const ROW = 64; // atlas row height, px (a label can take several rows for sharper big lettering)
const ATLAS_W = 1024;
const PAD = 2; // px between packed labels (keeps mipmaps from bleeding)

export interface SignMeshResult {
  mesh: MeshArrays & { uvs: Float32Array };
  pixels: Uint8Array;
  width: number;
  height: number;
}

export interface SignPainter {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalCompositeOperation: GlobalCompositeOperation;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  lineCap: CanvasLineCap;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  fill(): void;
  stroke(): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

interface Quad extends LabelRequest { twoSided: boolean; foreground: string; border: boolean }

/** Street-name blades for each sign post (two blades, both sides readable). */
export function streetSignLabels(ctx: DressContext, signs: TileSign[] | undefined): Quad[] {
  const out: Quad[] = [];
  for (const s of signs ?? []) {
    const y = ctx.hm ? ctx.hm.sample(s.x, s.z) : 0;
    for (const [text, rot, h] of [[s.a, s.ar, 2.96], [s.b, s.br, 3.2]] as const) {
      // Blade rot lays local +X along the street; its face (local +Z) is perpendicular to it.
      out.push({
        text, x: s.x, y: y + h, z: s.z, rot, width: Math.max(0.9, 0.105 * text.length + 0.25), height: 0.22,
        background: ctx.style.streetSign, foreground: '#f6f6f2', border: true, twoSided: true,
      });
    }
  }
  return out;
}

const FONTS = {
  sans: (px: number) => `bold ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`,
  block: (px: number) => `900 ${px}px "Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif`,
  script: (px: number) => `italic bold ${px}px "Brush Script MT", "Snell Roundhand", Georgia, serif`,
} as const;

/** Deterministic hash -> 0..1 (sequin pattern). */
const hash = (a: number, b: number): number => {
  let h = Math.imul(a ^ 0x27d4eb2d, 0x9e3779b1) ^ Math.imul(b + 0x165667b1, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Draw text centred at (cx, cy), fitted into maxW, with optional letter spacing (fraction of size). */
function drawText(g: SignPainter, q: Quad, cx: number, cy: number, maxW: number, rowH: number): void {
  const fontOf = FONTS[q.font ?? 'sans'];
  let size = Math.round(rowH * (q.font === 'script' ? 0.78 : q.font === 'block' ? 0.95 : 0.62));
  const spacing = q.spacing ?? 0;
  const measure = (): number => {
    g.font = fontOf(size);
    if (!spacing) return g.measureText(q.text).width;
    let w = 0;
    for (const ch of q.text) w += g.measureText(ch).width;
    return w + spacing * size * (q.text.length - 1);
  };
  let w = measure();
  if (w > maxW) {
    size = Math.max(10, Math.floor((size * maxW) / w));
    w = measure();
  }
  g.textBaseline = 'middle';
  const paint = (stroke: boolean): void => {
    if (!spacing) {
      g.textAlign = 'center';
      if (stroke) g.strokeText(q.text, cx, cy);
      else g.fillText(q.text, cx, cy);
      return;
    }
    g.textAlign = 'left';
    let x = cx - w / 2;
    for (const ch of q.text) {
      if (stroke) g.strokeText(ch, x, cy);
      else g.fillText(ch, x, cy);
      x += g.measureText(ch).width + spacing * size;
    }
  };
  if (q.outline) {
    g.strokeStyle = q.outline;
    g.lineWidth = Math.max(2, size * 0.14);
    g.lineJoin = 'round';
    paint(true);
  }
  g.fillStyle = q.foreground;
  paint(false);
}

/**
 * Sequins: tiny tiles of the letter color at varied brightness with a few white glints, painted only
 * where the letters already are ('source-atop'). Reads as the glittery Home Slice sign.
 */
function sequins(g: SignPainter, x0: number, y0: number, w: number, h: number, base: string, seed: number): void {
  const [r, gg, b] = hexToRgb(base);
  const cell = 3;
  g.globalCompositeOperation = 'source-atop';
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      const v = hash(x + seed * 131, y);
      let f = 0.8 + v * 0.5;
      if (v > 0.965) f = 1.9; // glint
      const c = (k: number): number => Math.max(0, Math.min(255, Math.round(k * f)));
      g.fillStyle = `rgb(${c(r)},${c(gg)},${c(b)})`;
      g.fillRect(x0 + x, y0 + y, cell, cell);
    }
  }
  g.globalCompositeOperation = 'source-over';
}

/**
 * Home Slice's "Queen of Pies" (the pole sign at the North Loop lot): crowned, pig-tailed pizza chef
 * with a mustache, one arm raising a pepperoni pie. White cut-out with a red outline, as in the photo.
 * Drawn into the atlas cell (x0, y0, w, h); everything is in units of the cell width.
 */
function drawQueen(g: SignPainter, x0: number, y0: number, w: number, h: number): void {
  const red = '#d0262b', white = '#fbfaf5';
  const X = (u: number): number => x0 + u * w, Y = (v: number): number => y0 + v * w;
  const lw = Math.max(2, w * 0.035);
  const shape = (draw: () => void, fill = white, stroke: string | null = red): void => {
    g.beginPath(); draw();
    g.fillStyle = fill; g.fill();
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.lineJoin = 'round'; g.stroke(); }
  };
  const circle = (u: number, v: number, r: number, fill = white, stroke: string | null = red): void =>
    shape(() => g.arc(X(u), Y(v), r * w, 0, Math.PI * 2), fill, stroke);
  const poly = (pts: [number, number][], fill = white, stroke: string | null = red): void =>
    shape(() => { pts.forEach(([u, v], i) => (i ? g.lineTo(X(u), Y(v)) : g.moveTo(X(u), Y(v)))); g.closePath(); }, fill, stroke);
  const limb = (u0: number, v0: number, u1: number, v1: number, t: number): void => {
    g.lineCap = 'round';
    for (const [c, k] of [[red, t + 0.05], [white, t]] as const) {
      g.beginPath(); g.moveTo(X(u0), Y(v0)); g.lineTo(X(u1), Y(v1));
      g.strokeStyle = c; g.lineWidth = k * w; g.stroke();
    }
  };
  const hx = 0.38, hy = (h / w) * 0.6; // head centre
  // Raised arm up to the pie, and the other arm down at her side.
  limb(hx + 0.12, hy + 0.2, 0.6, (h / w) * 0.37, 0.085);
  limb(hx - 0.08, hy + 0.2, hx - 0.21, hy + 0.36, 0.075);
  circle(hx - 0.22, hy + 0.38, 0.045);
  // Pie: crust, sauce ring, pepperoni.
  const pu = 0.62, pv = (h / w) * 0.23;
  circle(pu, pv, 0.32);
  shape(() => g.arc(X(pu), Y(pv), 0.25 * w, 0, Math.PI * 2), white, red);
  for (const [du, dv] of [[0, -0.13], [0.12, -0.07], [-0.12, -0.06], [0.0, 0.0], [0.13, 0.07], [-0.1, 0.09], [0.03, 0.14]] as const) {
    circle(pu + du, pv + dv, 0.045, red, null);
  }
  // Legs and feet, dress with apron, collar.
  for (const du of [-0.06, 0.06]) {
    poly([[hx + du - 0.035, hy + 0.4], [hx + du + 0.035, hy + 0.4], [hx + du + 0.035, hy + 0.55], [hx + du - 0.035, hy + 0.55]]);
    shape(() => g.ellipse(X(hx + du + 0.02), Y(hy + 0.57), 0.06 * w, 0.03 * w, 0, 0, Math.PI * 2));
  }
  poly([[hx - 0.1, hy + 0.13], [hx + 0.12, hy + 0.13], [hx + 0.18, hy + 0.43], [hx - 0.16, hy + 0.43]]);
  g.beginPath(); g.moveTo(X(hx - 0.14), Y(hy + 0.29)); g.lineTo(X(hx + 0.16), Y(hy + 0.29));
  g.strokeStyle = red; g.lineWidth = lw; g.stroke();
  for (let i = 0; i < 4; i++) circle(hx - 0.07 + i * 0.05, hy + 0.15, 0.025);
  // Pigtails with a red bow, head, crown.
  circle(hx - 0.17, hy + 0.06, 0.055);
  circle(hx + 0.16, hy + 0.07, 0.055);
  poly([[hx - 0.25, hy + 0.12], [hx - 0.2, hy + 0.15], [hx - 0.25, hy + 0.19]], red, null);
  circle(hx, hy, 0.15);
  poly([[hx - 0.16, hy - 0.06], [hx - 0.21, hy - 0.22], [hx - 0.11, hy - 0.14], [hx - 0.07, hy - 0.27], [hx, hy - 0.16],
    [hx + 0.07, hy - 0.25], [hx + 0.09, hy - 0.11], [hx + 0.03, hy - 0.08]]);
  for (const [u, v] of [[-0.21, -0.22], [-0.07, -0.27], [0.07, -0.25]] as const) circle(hx + u, hy + v, 0.025);
  // Face: winking eye, rosy cheek, a big curly mustache.
  g.beginPath(); g.arc(X(hx - 0.05), Y(hy - 0.01), 0.025 * w, Math.PI * 0.1, Math.PI * 0.9);
  g.strokeStyle = red; g.lineWidth = lw * 0.8; g.stroke();
  circle(hx + 0.06, hy - 0.02, 0.018, red, null);
  for (const s of [-1, 1]) shape(() => g.ellipse(X(hx + s * 0.05), Y(hy + 0.06), 0.06 * w, 0.025 * w, s * 0.35, 0, Math.PI * 2), red, null);
}

export function buildSignMesh(labels: LabelRequest[], blades: Quad[], newCanvas: (w: number, h: number) => SignPainter | null): SignMeshResult | null {
  const quads: Quad[] = [
    ...labels.map((l) => ({ ...l, twoSided: l.twoSided ?? false, foreground: l.foreground ?? '#f7f4ea', border: l.border ?? false })),
    ...blades,
  ];
  if (!quads.length) return null;

  // Shelf packing: tallest rows first, left to right.
  const order = quads.map((_, i) => i).sort((a, b) => (quads[b]!.rows ?? 1) - (quads[a]!.rows ?? 1) || a - b);
  const slots: { x: number; y: number; w: number; h: number }[] = new Array(quads.length);
  let sx = 0, sy = 0, shelfH = 0;
  for (const i of order) {
    const q = quads[i]!;
    const h = ROW * (q.rows ?? 1);
    const w = Math.min(ATLAS_W, Math.round((h * q.width) / q.height));
    if (sx + w > ATLAS_W) {
      sy += shelfH + PAD;
      sx = 0;
      shelfH = 0;
    }
    slots[i] = { x: sx, y: sy, w, h };
    sx += w + PAD;
    shelfH = Math.max(shelfH, h);
  }
  const H = Math.ceil((sy + shelfH) / 4) * 4;
  const g = newCanvas(ATLAS_W, H);
  if (!g) return null;

  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  quads.forEach((q, i) => {
    const { x: px0, y: py0, w: pw, h: ph } = slots[i]!;
    if (q.background) {
      g.fillStyle = q.background;
      g.fillRect(px0, py0, pw, ph);
    }
    if (q.border) {
      g.strokeStyle = q.foreground;
      g.lineWidth = 3;
      g.strokeRect(px0 + 4, py0 + 4, pw - 8, ph - 8);
    }
    if (q.art === 'queen') drawQueen(g, px0 + 2, py0 + 2, pw - 4, ph - 4);
    else drawText(g, q, px0 + pw / 2, py0 + ph / 2 + (q.font === 'script' ? 0 : 2), pw - 18, ph);
    if (q.sequins) sequins(g, px0, py0, pw, ph, q.foreground, i + 1);

    // Half-texel inset so neighbours in the atlas never bleed in.
    const u0 = (px0 + 0.5) / ATLAS_W, u1 = (px0 + pw - 0.5) / ATLAS_W, v0 = (py0 + 0.5) / H, v1 = (py0 + ph - 0.5) / H;
    const rx = Math.cos(q.rot), rz = -Math.sin(q.rot); // local +X (text direction)
    const nx = Math.sin(q.rot), nz = Math.cos(q.rot); // local +Z (facing)
    const hw = q.width / 2, hh = q.height / 2;
    const addFace = (sxn: number, off: number, n: number): void => {
      const base = pos.length / 3;
      const cx = q.x + nx * off, cz = q.z + nz * off;
      // BL, BR, TR, TL as seen by the viewer of this face (sxn = +1 front, −1 back: mirrored X)
      const corners: [number, number, number, number][] = [[-hw, -hh, u0, v1], [hw, -hh, u1, v1], [hw, hh, u1, v0], [-hw, hh, u0, v0]];
      for (const [a, b, u, v] of corners) {
        pos.push(cx + rx * a * sxn, q.y + b, cz + rz * a * sxn);
        nor.push(nx * n, 0, nz * n);
        uv.push(u, v);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const off = q.thickness ? q.thickness / 2 : 0.006;
    addFace(1, off, 1);
    // Text reads correctly from both sides; art (a cut-out figure) is the same object seen from behind.
    if (q.twoSided) addFace(q.art ? 1 : -1, -off, -1);
  });
  const pixels = new Uint8Array(g.getImageData(0, 0, ATLAS_W, H).data.buffer);
  return {
    mesh: { positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: new Float32Array(uv), indices: new Uint32Array(idx) },
    pixels, width: ATLAS_W, height: H,
  };
}
