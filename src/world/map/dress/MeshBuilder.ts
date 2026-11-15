import type { MeshArrays } from '../buildTile';

/** RGB 0..255. */
export type RGB = readonly [number, number, number];

const colorCache = new Map<string, RGB>();

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * '#rrggbb' (sRGB, as written in the palette) -> linear RGB 0..255 (cached). three.js treats vertex
 * colors as linear, so palette colors must be converted or everything looks washed out.
 */
export function rgb(hex: string): RGB {
  let c = colorCache.get(hex);
  if (!c) {
    const v = parseInt(hex.replace('#', ''), 16);
    c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => srgbToLinear(x / 255) * 255) as unknown as RGB;
    colorCache.set(hex, c);
  }
  return c;
}

export function shade(c: RGB, f: number): RGB {
  return [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = (seed | 0) ^ 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(arr: readonly T[], r: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(r * arr.length))]!;
}

/** Vary a color's brightness by ±amount (r in 0..1). */
export function jitter(c: RGB, r: number, amount: number): RGB {
  return shade(c, 1 + (r * 2 - 1) * amount);
}

// Low-poly icosahedron (12 verts, 20 faces), used for leaf clusters and shrubs.
const T = (1 + Math.sqrt(5)) / 2;
const ICO_RAW: [number, number, number][] = [
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0], [0, -1, T], [0, 1, T],
  [0, -1, -T], [0, 1, -T], [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
];
const ICO_V: [number, number, number][] = ICO_RAW.map(([x, y, z]) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l] as [number, number, number];
});
const ICO_F = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6],
  [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10],
  [8, 6, 7], [9, 8, 1],
] as const;

/**
 * Accumulates flat-shaded, vertex-colored triangles (each face has its own normal: the faceted
 * low-poly look). A local transform (translate + rotate about Y + uniform scale) lets props be
 * modelled in their own frame. Front faces are counter-clockwise seen from outside.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private tx = 0; private ty = 0; private tz = 0;
  private c = 1; private s = 0; private k = 1;

  get triangles(): number {
    return this.pos.length / 9;
  }

  /** rotY uses three.js rotation.y semantics (local −Z = heading 0 = north). */
  setTransform(x: number, y: number, z: number, rotY = 0, scale = 1): this {
    this.tx = x; this.ty = y; this.tz = z;
    this.c = Math.cos(rotY); this.s = Math.sin(rotY); this.k = scale;
    return this;
  }

  resetTransform(): this {
    return this.setTransform(0, 0, 0, 0, 1);
  }

  /** Local -> world. */
  private w(x: number, y: number, z: number, out: number[]): void {
    const k = this.k;
    out.push(this.tx + (this.c * x + this.s * z) * k, this.ty + y * k, this.tz + (-this.s * x + this.c * z) * k);
  }

  private readonly tmp: number[] = [];

  /** Triangle in local coordinates with one color (or a color per vertex). */
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
    ca: RGB, cb: RGB = ca, cc: RGB = ca): void {
    const p = this.tmp;
    p.length = 0;
    this.w(ax, ay, az, p); this.w(bx, by, bz, p); this.w(cx, cy, cz, p);
    const ux = p[3]! - p[0]!, uy = p[4]! - p[1]!, uz = p[5]! - p[2]!;
    const vx = p[6]! - p[0]!, vy = p[7]! - p[1]!, vz = p[8]! - p[2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return;
    nx /= l; ny /= l; nz /= l;
    for (const v of p) this.pos.push(v);
    for (let i = 0; i < 3; i++) this.nor.push(nx, ny, nz);
    this.col.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
  }

  /**
   * Convex polygon in local coords as a fan, wound so its normal points along `want`
   * (so callers never have to think about winding). Optional per-vertex colors.
   */
  face(pts: readonly Vec3[], color: RGB, want: Vec3, colors?: readonly RGB[]): void {
    for (let k = 1; k + 1 < pts.length; k++) {
      const a = pts[0]!, b = pts[k]!, c = pts[k + 1]!;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const ok = nx * want[0] + ny * want[1] + nz * want[2] >= 0;
      const ca = colors?.[0] ?? color, cb = colors?.[k] ?? color, cc = colors?.[k + 1] ?? color;
      if (ok) this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], ca, cb, cc);
      else this.tri(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2], ca, cc, cb);
    }
  }

  /** Quad a-b-c-d (CCW from the front) as two triangles; optional per-vertex colors. */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, ca: RGB, cb: RGB = ca, cc: RGB = cb, cd: RGB = ca): void {
    this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], ca, cb, cc);
    this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], ca, cc, cd);
  }

  /**
   * Axis-aligned box in local coords: centre (cx, cz), from y0 to y1, size sx × sz,
   * rotated by `rot` around its own centre. Bottom face omitted unless `bottom`.
   */
  box(cx: number, y0: number, cz: number, sx: number, y1: number, sz: number, color: RGB, rot = 0,
    opts: { bottom?: boolean; top?: RGB; sides?: RGB; aoBottom?: number } = {}): void {
    const hx = sx / 2, hz = sz / 2;
    const c = Math.cos(rot), s = Math.sin(rot);
    const P = (x: number, z: number): [number, number] => [cx + c * x + s * z, cz - s * x + c * z];
    const corners = [P(-hx, hz), P(hx, hz), P(hx, -hz), P(-hx, -hz)]; // CCW from above (y up, z south)
    const side = opts.sides ?? color;
    const low = opts.aoBottom ? shade(side, 1 - opts.aoBottom) : side;
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i]!, [bx, bz] = corners[(i + 1) % 4]!;
      this.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], low, low, side, side);
    }
    const top = opts.top ?? color;
    const [a, b, d, e] = corners as [[number, number], [number, number], [number, number], [number, number]];
    this.quad([a[0], y1, a[1]], [b[0], y1, b[1]], [d[0], y1, d[1]], [e[0], y1, e[1]], top);
    if (opts.bottom) this.quad([e[0], y0, e[1]], [d[0], y0, d[1]], [b[0], y0, b[1]], [a[0], y0, a[1]], color);
  }

  /** Tapered n-gon prism (trunks, poles) from (x, y0, z) radius r0 to (x2, y1, z2) radius r1. */
  cylinder(x: number, y0: number, z: number, r0: number, x2: number, y1: number, z2: number, r1: number,
    n: number, color: RGB, top: RGB | null = color, colorTop: RGB = color): void {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      this.quad(
        [x + c0 * r0, y0, z - s0 * r0], [x + c1 * r0, y0, z - s1 * r0],
        [x2 + c1 * r1, y1, z2 - s1 * r1], [x2 + c0 * r1, y1, z2 - s0 * r1],
        color, color, colorTop, colorTop,
      );
      if (top) this.tri(x2, y1, z2, x2 + c0 * r1, y1, z2 - s0 * r1, x2 + c1 * r1, y1, z2 - s1 * r1, top);
    }
  }

  /** Low-poly blob (icosahedron) with per-vertex radial jitter; darker underside for depth. */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: RGB, r: () => number,
    jitterAmt = 0.18, under = 0.72): void {
    const v = ICO_V.map(([x, y, z]) => {
      const j = 1 + (r() * 2 - 1) * jitterAmt;
      return [cx + x * rx * j, cy + y * ry * j, cz + z * rz * j] as const;
    });
    const low = shade(color, under);
    for (const [a, b, c] of ICO_F) {
      const A = v[a]!, B = v[b]!, C = v[c]!;
      const ny = (A[1] + B[1] + C[1]) / 3 - cy;
      const f = ny < 0 ? low : color;
      this.tri(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], f);
    }
  }

  build(): MeshArrays {
    const n = this.pos.length / 3;
    const indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nor),
      colors: new Uint8Array(this.col.map((v) => Math.round(v))),
      indices,
    };
  }
}

export type Vec3 = readonly [number, number, number];
