import earcut from 'earcut';
import type { DressStyle } from '../../../config/mapStyle';
import type { Heightmap } from '../../terrain';
import type { TileBuilding } from '../types';
import { buildLandmarkBuilding } from './landmarks';
import { jitter, MeshBuilder, mix, pick, rgb, rng, shade, type RGB } from './MeshBuilder';

/**
 * Dressed buildings: stylized low-poly houses, garages, shops and apartments built from the real
 * OSM footprint plus the layout decisions made offline (front direction, door, porch, roof type).
 *
 * Roofs: the footprint is rasterized in the building's own frame and split greedily into up to
 * four rectangles; each gets its own hip/gable roof at a shared eave height. Overlapping roofs
 * intersect like real cross-gabled bungalows. Walls always follow the exact footprint (= collision).
 */

export interface Obstacle {
  ring: number[]; // flat x, z
  base: number;
  height: number; // 0 = blocks the dog only, not the camera
}

export interface LabelRequest {
  text: string;
  /** Centre of the sign face (world). */
  x: number; y: number; z: number;
  /** rotation.y of the sign face: local +Z = facing direction, local +X = text reading direction. */
  rot: number;
  width: number;
  height: number;
  /** Panel color; null = no panel (cut-out letters, alpha-tested). */
  background: string | null;
  /** Letter color (default off-white). */
  foreground?: string;
  /** 'sans' (default), 'block' (heavy), 'script' (painted window script). */
  font?: 'sans' | 'block' | 'script';
  outline?: string;
  /** Extra letter spacing, as a fraction of the font size. */
  spacing?: number;
  /** Glittery sequin fill (Home Slice's sign). */
  sequins?: boolean;
  twoSided?: boolean;
  border?: boolean;
  /** Atlas rows (64 px each): more = sharper big lettering. */
  rows?: number;
  /** Paint a picture instead of text (cut-out sign art). */
  art?: 'queen';
  /** Two-sided signs: distance between the faces (default ~1 cm). */
  thickness?: number;
}

export interface DressContext {
  mb: MeshBuilder;
  hm: Heightmap | null;
  style: DressStyle;
  sink: number;
  obstacles: Obstacle[];
  labels: LabelRequest[];
}

type P2 = [number, number];
interface Rect { u0: number; u1: number; v0: number; v1: number }

const ground = (hm: Heightmap | null, x: number, z: number): number => (hm ? hm.sample(x, z) : 0);

const CELL = 0.25;
const MAX_CELLS = 200;
const MAX_RECTS = 4;
const MIN_RECT_AREA = 5;
const MIN_RECT_SIDE = 1.8;
const OVERHANG = 0.45;
const FASCIA = 0.16;
const WALL_MIN = 2.6; // floor to eave
const PIER_HEIGHT = 0.65;

export function signedArea(ring: number[]): number {
  let a = 0;
  for (let k = 0, m = ring.length / 2; k < m; k++) {
    const k2 = (k + 1) % m;
    a += ring[k * 2]! * ring[k2 * 2 + 1]! - ring[k2 * 2]! * ring[k * 2 + 1]!;
  }
  return a / 2;
}

function pointInRing(x: number, z: number, ring: number[]): boolean {
  let inside = false;
  for (let i = 0, m = ring.length / 2, j = m - 1; i < m; j = i++) {
    const xi = ring[i * 2]!, zi = ring[i * 2 + 1]!, xj = ring[j * 2]!, zj = ring[j * 2 + 1]!;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Dominant wall direction (length-weighted, mod 90°) as a unit vector. */
export function dominantAxis(ring: number[]): P2 {
  let sx = 0, sz = 0;
  const m = ring.length / 2;
  for (let k = 0; k < m; k++) {
    const k2 = (k + 1) % m;
    const dx = ring[k2 * 2]! - ring[k * 2]!, dz = ring[k2 * 2 + 1]! - ring[k * 2 + 1]!;
    const L = Math.hypot(dx, dz);
    const a = Math.atan2(dz, dx) * 4;
    sx += Math.cos(a) * L;
    sz += Math.sin(a) * L;
  }
  const a = Math.atan2(sz, sx) / 4;
  return [Math.cos(a), Math.sin(a)];
}

/** Largest all-filled rectangle in a grid (rows = v, cols = u). Classic histogram-stack method. */
function largestRect(grid: Uint8Array, nu: number, nv: number): { i0: number; i1: number; j0: number; j1: number; area: number } | null {
  const h = new Int32Array(nu);
  let best: { i0: number; i1: number; j0: number; j1: number; area: number } | null = null;
  const stack: number[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) h[i] = grid[j * nu + i] ? h[i]! + 1 : 0;
    stack.length = 0;
    for (let i = 0; i <= nu; i++) {
      const hi = i === nu ? 0 : h[i]!;
      while (stack.length && h[stack[stack.length - 1]!]! >= hi) {
        const top = stack.pop()!;
        const height = h[top]!;
        const left = stack.length ? stack[stack.length - 1]! + 1 : 0;
        const area = height * (i - left);
        if (height > 0 && (!best || area > best.area)) best = { i0: left, i1: i - 1, j0: j - height + 1, j1: j, area };
      }
      stack.push(i);
    }
  }
  return best;
}

/** Split a footprint (given in local u/v coords) into up to MAX_RECTS rectangles. Exported for tests. */
export function decompose(local: number[]): Rect[] {
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let k = 0; k < local.length; k += 2) {
    umin = Math.min(umin, local[k]!); umax = Math.max(umax, local[k]!);
    vmin = Math.min(vmin, local[k + 1]!); vmax = Math.max(vmax, local[k + 1]!);
  }
  const cell = Math.max(CELL, (umax - umin) / MAX_CELLS, (vmax - vmin) / MAX_CELLS);
  const nu = Math.max(1, Math.ceil((umax - umin) / cell)), nv = Math.max(1, Math.ceil((vmax - vmin) / cell));
  const grid = new Uint8Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      if (pointInRing(umin + (i + 0.5) * cell, vmin + (j + 0.5) * cell, local)) grid[j * nu + i] = 1;
    }
  }
  const rects: Rect[] = [];
  for (let n = 0; n < MAX_RECTS; n++) {
    const r = largestRect(grid, nu, nv);
    if (!r) break;
    const w = (r.i1 - r.i0 + 1) * cell, d = (r.j1 - r.j0 + 1) * cell;
    if (n > 0 && (w * d < MIN_RECT_AREA || Math.min(w, d) < MIN_RECT_SIDE)) break;
    rects.push({ u0: umin + r.i0 * cell, u1: umin + (r.i1 + 1) * cell, v0: vmin + r.j0 * cell, v1: vmin + (r.j1 + 1) * cell });
    for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) grid[j * nu + i] = 0;
  }
  return rects;
}

/** Convex polygon (world coords) facing `want` (see MeshBuilder.face). */
function poly(mb: MeshBuilder, pts: [number, number, number][], color: RGB, want: [number, number, number], colors?: RGB[]): void {
  mb.face(pts, color, want, colors);
}

interface Frame { s: P2; f: P2 }
const toWorld = (fr: Frame, u: number, v: number): P2 => [u * fr.s[0] + v * fr.f[0], u * fr.s[1] + v * fr.f[1]];

/**
 * Hip or gable roof over a rectangle (local u/v), eave at `eave` (wall top), rising `rise` m over half
 * the short side. Includes overhang, fascia, soffit and (gable) end triangles.
 */
function rectRoof(ctx: DressContext, fr: Frame, r: Rect, eave: number, tanP: number, kind: 'hip' | 'gable',
  roof: RGB, trim: RGB, wall: RGB, ridgeAlongU: boolean): number {
  const mb = ctx.mb;
  const o = OVERHANG;
  // a = along the ridge, b = across. Work in (a, b) then map to (u, v).
  const L = ridgeAlongU ? r.u1 - r.u0 : r.v1 - r.v0;
  const W = ridgeAlongU ? r.v1 - r.v0 : r.u1 - r.u0;
  const half = W / 2;
  const rise = half * tanP;
  const ridgeY = eave + rise;
  const eaveO = eave - o * tanP; // height at the overhang edge
  const P = (a: number, b: number, y: number): [number, number, number] => {
    const u = ridgeAlongU ? r.u0 + a : r.u0 + b;
    const v = ridgeAlongU ? r.v0 + b : r.v0 + a;
    const [x, z] = toWorld(fr, u, v);
    return [x, y, z];
  };
  const dirA = ((): [number, number, number] => { const [x, z] = toWorld(fr, ridgeAlongU ? 1 : 0, ridgeAlongU ? 0 : 1); return [x, 0, z]; })();
  const dirB = ((): [number, number, number] => { const [x, z] = toWorld(fr, ridgeAlongU ? 0 : 1, ridgeAlongU ? 1 : 0); return [x, 0, z]; })();
  const neg = (v: [number, number, number]): [number, number, number] => [-v[0], -v[1], -v[2]];
  const up = (v: [number, number, number]): [number, number, number] => [v[0], 1, v[2]];
  const roofLo = shade(roof, 0.92);

  if (kind === 'gable') {
    poly(mb, [P(-o, -o, eaveO), P(L + o, -o, eaveO), P(L + o, half, ridgeY), P(-o, half, ridgeY)], roof, up(neg(dirB)), [roofLo, roofLo, roof, roof]);
    poly(mb, [P(-o, W + o, eaveO), P(L + o, W + o, eaveO), P(L + o, half, ridgeY), P(-o, half, ridgeY)], roof, up(dirB), [roofLo, roofLo, roof, roof]);
    // Gable end walls (siding color) + rake fascia.
    poly(mb, [P(0, 0, eave), P(0, W, eave), P(0, half, ridgeY)], wall, neg(dirA));
    poly(mb, [P(L, 0, eave), P(L, W, eave), P(L, half, ridgeY)], wall, dirA);
    for (const [a, sgn] of [[-o, -1], [L + o, 1]] as const) {
      const n: [number, number, number] = sgn < 0 ? neg(dirA) : dirA;
      poly(mb, [P(a, -o, eaveO), P(a, half, ridgeY), P(a, half, ridgeY - FASCIA), P(a, -o, eaveO - FASCIA)], trim, n);
      poly(mb, [P(a, W + o, eaveO), P(a, half, ridgeY), P(a, half, ridgeY - FASCIA), P(a, W + o, eaveO - FASCIA)], trim, n);
      // Underside of the rake overhang.
      poly(mb, [P(a, -o, eaveO - FASCIA), P(a, half, ridgeY - FASCIA), P(sgn < 0 ? 0 : L, half, ridgeY - FASCIA), P(sgn < 0 ? 0 : L, -o, eaveO - FASCIA)], shade(trim, 0.8), [0, -1, 0]);
      poly(mb, [P(a, W + o, eaveO - FASCIA), P(a, half, ridgeY - FASCIA), P(sgn < 0 ? 0 : L, half, ridgeY - FASCIA), P(sgn < 0 ? 0 : L, W + o, eaveO - FASCIA)], shade(trim, 0.8), [0, -1, 0]);
    }
    // Eave fascia along the long sides.
    poly(mb, [P(-o, -o, eaveO), P(L + o, -o, eaveO), P(L + o, -o, eaveO - FASCIA), P(-o, -o, eaveO - FASCIA)], trim, neg(dirB));
    poly(mb, [P(-o, W + o, eaveO), P(L + o, W + o, eaveO), P(L + o, W + o, eaveO - FASCIA), P(-o, W + o, eaveO - FASCIA)], trim, dirB);
  } else {
    const h0 = Math.min(half, L / 2), h1 = Math.max(L - half, L / 2);
    poly(mb, [P(-o, -o, eaveO), P(L + o, -o, eaveO), P(h1, half, ridgeY), P(h0, half, ridgeY)], roof, up(neg(dirB)), [roofLo, roofLo, roof, roof]);
    poly(mb, [P(-o, W + o, eaveO), P(L + o, W + o, eaveO), P(h1, half, ridgeY), P(h0, half, ridgeY)], roof, up(dirB), [roofLo, roofLo, roof, roof]);
    poly(mb, [P(-o, -o, eaveO), P(-o, W + o, eaveO), P(h0, half, ridgeY)], roof, up(neg(dirA)), [roofLo, roofLo, roof]);
    poly(mb, [P(L + o, -o, eaveO), P(L + o, W + o, eaveO), P(h1, half, ridgeY)], roof, up(dirA), [roofLo, roofLo, roof]);
    // Fascia all round.
    const c = [P(-o, -o, 0), P(L + o, -o, 0), P(L + o, W + o, 0), P(-o, W + o, 0)];
    const ns = [neg(dirB), dirA, dirB, neg(dirA)];
    for (let k = 0; k < 4; k++) {
      const a = c[k]!, b = c[(k + 1) % 4]!;
      poly(mb, [[a[0], eaveO, a[2]], [b[0], eaveO, b[2]], [b[0], eaveO - FASCIA, b[2]], [a[0], eaveO - FASCIA, a[2]]], trim, ns[k]!);
    }
  }
  // Soffit: underside of the whole roof rectangle (hidden inside the walls, visible under the overhang).
  poly(mb, [P(-o, -o, eaveO - FASCIA), P(L + o, -o, eaveO - FASCIA), P(L + o, W + o, eaveO - FASCIA), P(-o, W + o, eaveO - FASCIA)], shade(trim, 0.78), [0, -1, 0]);
  return ridgeY;
}

/** Flat window/door/sign panel on a wall: rectangle at distance `off` in front of the wall plane. */
export function wallPanel(mb: MeshBuilder, ax: number, az: number, tx: number, tz: number, nx: number, nz: number,
  t0: number, t1: number, y0: number, y1: number, off: number, color: RGB, colorTop?: RGB): void {
  const p = (t: number, y: number): [number, number, number] => [ax + tx * t + nx * off, y, az + tz * t + nz * off];
  poly(mb, [p(t0, y0), p(t1, y0), p(t1, y1), p(t0, y1)], color, [nx, 0, nz], colorTop ? [color, color, colorTop, colorTop] : undefined);
}

export function buildDressedBuilding(ctx: DressContext, b: TileBuilding): void {
  const d = b.d!;
  const outer = b.r[0];
  if (!outer || outer.length < 6) return;
  if (d.lm) {
    buildLandmarkBuilding(ctx, b, d.lm);
    return;
  }
  const mb = ctx.mb, S = ctx.style, hm = ctx.hm;
  const r = rng(d.seed * 2654435761);
  const kind = d.k;

  // Frame: f = toward the street (or dominant axis), s = across.
  // Normalize: d.f is rounded in the tile data, and |f| ≠ 1 times world coordinates (~1000 m) would
  // shift the roof rectangles off the walls by most of a meter.
  const fl = d.f ? Math.hypot(d.f[0], d.f[1]) || 1 : 1;
  const f: P2 = d.f ? [d.f[0] / fl, d.f[1] / fl] : dominantAxis(outer);
  const fr: Frame = { f, s: [-f[1], f[0]] };
  const local: number[] = [];
  for (let k = 0; k < outer.length; k += 2) {
    const x = outer[k]!, z = outer[k + 1]!;
    local.push(x * fr.s[0] + z * fr.s[1], x * f[0] + z * f[1]);
  }

  // Heights
  let gMin = Infinity, gSum = 0;
  const m = outer.length / 2;
  for (let k = 0; k < m; k++) {
    const g = ground(hm, outer[k * 2]!, outer[k * 2 + 1]!);
    gMin = Math.min(gMin, g);
    gSum += g;
  }
  const gAvg = gSum / m;
  const base = gMin - ctx.sink;
  const pier = kind === 'house' && d.pier === 1;
  const floorY = gAvg + (pier ? PIER_HEIGHT : 0.12);
  const peak = gAvg + Math.max(b.h, 3);
  const roofKind = d.roof ?? 'flat';

  // Colors
  const wallPal = kind === 'house' ? S.houseWalls : kind === 'garage' ? S.garageWalls : kind === 'shop' ? S.shopWalls : S.aptWalls;
  const wall = rgb(d.wall ?? pick(wallPal, r()));
  const trim = rgb(d.trim ?? pick(S.trims, r()));
  const roof = rgb(d.roofColor ?? pick(S.roofs, r()));
  const door = rgb(d.doorColor ?? pick(S.doors, r()));
  const skirt = rgb(S.skirting);
  const glass = rgb(S.glass);

  const rects = decompose(local);
  const main = rects[0];
  const pitch = kind === 'garage' ? 0.38 + r() * 0.12 : 0.44 + r() * 0.16; // ~22–34°
  let tanP = Math.tan(pitch);
  let eave: number;
  if (roofKind === 'flat' || !main) {
    eave = Math.max(peak, floorY + WALL_MIN);
  } else {
    const half = Math.min(main.u1 - main.u0, main.v1 - main.v0) / 2;
    eave = peak - half * tanP;
    const minEave = floorY + (kind === 'garage' ? 2.3 : WALL_MIN);
    if (eave < minEave) {
      eave = minEave;
      tanP = Math.max(Math.tan(0.28), (peak - eave) / half);
    }
  }

  // --- Walls (exact footprint, all rings) ---
  const ao = S.wallAO;
  const area = signedArea(outer);
  const flatTop = roofKind === 'flat' ? eave + (kind === 'shop' || kind === 'apts' ? 0.6 : 0.25) : eave;
  const front = { best: -1, k: -1 };
  b.r.forEach((ring, ri) => {
    if (ring.length < 6) return;
    // (dz, -dx) points out of a ring with positive signed area; holes face into the hole.
    const sa = signedArea(ring);
    const sign = (sa >= 0 ? 1 : -1) * (ri === 0 ? 1 : -1);
    const n = ring.length / 2;
    for (let k = 0; k < n; k++) {
      const ax = ring[k * 2]!, az = ring[k * 2 + 1]!;
      const bx = ring[((k + 1) % n) * 2]!, bz = ring[((k + 1) % n) * 2 + 1]!;
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const nx = (dz / len) * sign, nz = (-dx / len) * sign;
      const lowC = shade(wall, 1 - ao);
      if (pier) {
        poly(mb, [[ax, base, az], [bx, base, bz], [bx, floorY, bz], [ax, floorY, az]], skirt, [nx, 0, nz]);
        poly(mb, [[ax, floorY, az], [bx, floorY, bz], [bx, flatTop, bz], [ax, flatTop, az]], wall, [nx, 0, nz],
          [lowC, lowC, wall, wall]);
      } else {
        poly(mb, [[ax, base, az], [bx, base, bz], [bx, flatTop, bz], [ax, flatTop, az]], wall, [nx, 0, nz],
          [shade(wall, 1 - ao * 1.3), shade(wall, 1 - ao * 1.3), wall, wall]);
      }
      if (ri !== 0) continue;
      // Corner trim board at the start vertex (houses).
      if (kind === 'house' && len > 0.8) {
        wallPanel(mb, ax, az, dx / len, dz / len, nx, nz, 0, 0.14, floorY, eave, 0.03, trim);
        wallPanel(mb, ax, az, dx / len, dz / len, nx, nz, len - 0.14, len, floorY, eave, 0.03, trim);
      }
      // Front wall = the outer edge facing the street that is closest to the door.
      if (d.door && nx * f[0] + nz * f[1] > 0.7) {
        const t = Math.max(0, Math.min(len, ((d.door[0] - ax) * dx + (d.door[1] - az) * dz) / len));
        const px = ax + (dx / len) * t, pz = az + (dz / len) * t;
        const dist = Math.hypot(px - d.door[0], pz - d.door[1]);
        if (front.k < 0 || dist < front.best) { front.best = dist; front.k = k; }
      }
    }
  });

  // --- Roof ---
  // Flat cap over the whole footprint (covers slivers the roof rectangles miss).
  {
    const flat: number[] = [];
    const holes: number[] = [];
    b.r.forEach((ring, ri) => {
      if (ri > 0) holes.push(flat.length / 2);
      for (const c of ring) flat.push(c);
    });
    const tris = earcut(flat, holes, 2);
    const capC = roofKind === 'flat' ? shade(roof, 1.25) : shade(roof, 0.9);
    const y = roofKind === 'flat' ? eave : eave - 0.02;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]!, bb = tris[t + 1]!, c = tris[t + 2]!;
      poly(mb, [[flat[a * 2]!, y, flat[a * 2 + 1]!], [flat[bb * 2]!, y, flat[bb * 2 + 1]!], [flat[c * 2]!, y, flat[c * 2 + 1]!]], capC, [0, 1, 0]);
    }
  }
  let ridgeTop = eave;
  if (roofKind === 'flat') {
    // Parapet coping (trim band on top of the walls) for shops/apartments.
    const n = outer.length / 2;
    const sgn = area >= 0 ? 1 : -1;
    for (let k = 0; k < n; k++) {
      const ax = outer[k * 2]!, az = outer[k * 2 + 1]!;
      const bx = outer[((k + 1) % n) * 2]!, bz = outer[((k + 1) % n) * 2 + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const nx = ((bz - az) / len) * sgn, nz = (-(bx - ax) / len) * sgn;
      poly(mb, [[ax + nx * 0.05, flatTop - 0.22, az + nz * 0.05], [bx + nx * 0.05, flatTop - 0.22, bz + nz * 0.05],
        [bx + nx * 0.05, flatTop + 0.02, bz + nz * 0.05], [ax + nx * 0.05, flatTop + 0.02, az + nz * 0.05]], trim, [nx, 0, nz]);
      // inner face of the parapet so it reads as a wall from above
      poly(mb, [[ax - nx * 0.2, eave, az - nz * 0.2], [bx - nx * 0.2, eave, bz - nz * 0.2],
        [bx - nx * 0.2, flatTop, bz - nz * 0.2], [ax - nx * 0.2, flatTop, az - nz * 0.2]], shade(wall, 0.85), [-nx, 0, -nz]);
      poly(mb, [[ax - nx * 0.2, flatTop, az - nz * 0.2], [bx - nx * 0.2, flatTop, bz - nz * 0.2],
        [bx, flatTop, bz], [ax, flatTop, az]], trim, [0, 1, 0]);
    }
    ridgeTop = flatTop;
  } else {
    rects.forEach((rc, i) => {
      const w = rc.u1 - rc.u0, dd = rc.v1 - rc.v0;
      let alongU = w >= dd;
      if (Math.max(w, dd) / Math.min(w, dd) < 1.25) alongU = r() < 0.5;
      // Secondary wings facing the street read best as front gables.
      if (i > 0 && kind === 'house' && roofKind === 'gable') alongU = false;
      const top = rectRoof(ctx, fr, rc, eave, tanP, roofKind === 'gable' ? 'gable' : 'hip', roof, trim, wall, alongU);
      ridgeTop = Math.max(ridgeTop, top);
    });
  }

  // --- Windows, doors, shop fronts ---
  const n = outer.length / 2;
  const sgn = area >= 0 ? 1 : -1;
  const floors = kind === 'apts' ? Math.max(1, Math.round((eave - floorY) / 2.9)) : (eave - floorY > 5.2 ? 2 : 1);
  const floorH = (eave - floorY) / floors;
  for (let k = 0; k < n; k++) {
    const ax = outer[k * 2]!, az = outer[k * 2 + 1]!;
    const bx = outer[((k + 1) % n) * 2]!, bz = outer[((k + 1) % n) * 2 + 1]!;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1.6) continue;
    const tx = (bx - ax) / len, tz = (bz - az) / len;
    const nx = tz * sgn, nz = -tx * sgn;
    const isFront = k === front.k;
    let doorT = -100;
    if (isFront && d.door) {
      doorT = (d.door[0] - ax) * tx + (d.door[1] - az) * tz;
      doorT = Math.max(0.7, Math.min(len - 0.7, doorT));
      if (kind === 'garage') {
        const gw = Math.min(2.6, len - 0.6);
        wallPanel(mb, ax, az, tx, tz, nx, nz, len / 2 - gw / 2, len / 2 + gw / 2, gAvg, gAvg + 2.1, 0.04, shade(trim, 0.95));
        for (let p = 1; p < 4; p++) {
          wallPanel(mb, ax, az, tx, tz, nx, nz, len / 2 - gw / 2, len / 2 + gw / 2, gAvg + p * 0.52 - 0.02, gAvg + p * 0.52, 0.05, shade(trim, 0.75));
        }
        continue;
      }
      if (kind === 'shop') {
        const w0 = Math.max(0.4, len * 0.12), w1 = Math.min(len - 0.4, len * 0.88);
        wallPanel(mb, ax, az, tx, tz, nx, nz, w0 - 0.08, w1 + 0.08, floorY + 0.35, floorY + 2.75, 0.03, rgb('#2a2c2e'));
        wallPanel(mb, ax, az, tx, tz, nx, nz, w0, w1, floorY + 0.45, floorY + 2.65, 0.045, jitter(glass, r(), 0.08), shade(glass, 1.25));
        wallPanel(mb, ax, az, tx, tz, nx, nz, doorT - 0.5, doorT + 0.5, floorY, floorY + 2.3, 0.055, shade(glass, 0.8));
        if (d.sign && eave - floorY > 3.3) {
          const sw = Math.min(len * 0.8, Math.max(3, d.sign.length * 0.32));
          const cy = Math.min(eave - 0.55, floorY + 3.3);
          ctx.labels.push({
            text: d.sign, x: ax + tx * (len / 2) + nx * 0.08, y: cy, z: az + tz * (len / 2) + nz * 0.08,
            rot: Math.atan2(nx, nz), width: sw, height: 0.7, background: S.shopSign, // faces outward
          });
        }
        continue;
      }
      // House / apartment front door with frame.
      wallPanel(mb, ax, az, tx, tz, nx, nz, doorT - 0.58, doorT + 0.58, floorY, floorY + 2.28, 0.025, trim);
      wallPanel(mb, ax, az, tx, tz, nx, nz, doorT - 0.46, doorT + 0.46, floorY, floorY + 2.12, 0.04, door);
    }
    if (kind === 'garage' || kind === 'shop') {
      if (kind === 'shop' && len > 3) {
        // side windows
        for (let t = 2; t < len - 1.5; t += 3.2) {
          wallPanel(mb, ax, az, tx, tz, nx, nz, t, t + 1.4, floorY + 1.0, floorY + 2.3, 0.04, glass, shade(glass, 1.2));
        }
      }
      continue;
    }
    const spacing = kind === 'apts' ? 2.4 : 2.5;
    const count = Math.floor((len - 0.6) / spacing);
    if (count < 1) continue;
    const step = len / count;
    for (let fl = 0; fl < floors; fl++) {
      const y0 = floorY + fl * floorH + 0.85, y1 = Math.min(y0 + 1.35, floorY + (fl + 1) * floorH - 0.25);
      if (y1 - y0 < 0.6) continue;
      for (let i = 0; i < count; i++) {
        const t = step * (i + 0.5);
        if (fl === 0 && Math.abs(t - doorT) < 1.15) continue;
        const ww = kind === 'house' && r() < 0.3 ? 1.5 : 0.9; // some paired windows
        if (t - ww / 2 < 0.35 || t + ww / 2 > len - 0.35) continue;
        wallPanel(mb, ax, az, tx, tz, nx, nz, t - ww / 2 - 0.1, t + ww / 2 + 0.1, y0 - 0.12, y1 + 0.1, 0.025, trim);
        wallPanel(mb, ax, az, tx, tz, nx, nz, t - ww / 2, t + ww / 2, y0, y1, 0.04, jitter(glass, r(), S.glassVariation), shade(glass, 1.22));
      }
    }
  }

  // --- Porch (houses) ---
  if (kind === 'house' && d.porch && d.door && d.f) {
    buildPorch(ctx, d.door, f, d.porch, gAvg, floorY, eave, wall, trim, roof, r);
  }

  // --- Chimney (some houses) ---
  if (kind === 'house' && main && roofKind !== 'flat' && r() < 0.35) {
    const side = r() < 0.5 ? main.u0 - 0.28 : main.u1 + 0.28;
    const vmid = (main.v0 + main.v1) / 2 + (r() - 0.5) * (main.v1 - main.v0) * 0.4;
    const [cx, cz] = toWorld(fr, side, vmid);
    const rot = Math.atan2(fr.s[1], fr.s[0]);
    const chim = rgb(S.chimney);
    mb.box(cx, base, cz, 0.55, ridgeTop + 0.5, 0.75, chim, -rot, { aoBottom: 0.2 });
    mb.box(cx, ridgeTop + 0.5, cz, 0.68, ridgeTop + 0.62, 0.88, shade(chim, 0.8), -rot);
  }

  // Collision footprint for the building itself is added by the caller (exact ring).
}

function buildPorch(ctx: DressContext, doorPt: [number, number], f: P2, porch: [number, number], gAvg: number,
  floorY: number, eave: number, wall: RGB, trim: RGB, roof: RGB, r: () => number): void {
  const mb = ctx.mb, S = ctx.style;
  const [pw, pd] = porch;
  const [dx, dz] = doorPt;
  const sx = -f[1], sz = f[0];
  const W = (a: number, b: number): [number, number] => [dx + sx * a + f[0] * b, dz + sz * a + f[1] * b];
  const rotS = Math.atan2(-sz, sx); // rotation.y laying local +X along s
  const floorC = rgb(S.porchFloor);
  const deckY = Math.max(floorY, gAvg + 0.25);
  // Deck (from below ground to floor level)
  const [cx, cz] = W(0, pd / 2);
  mb.box(cx, gAvg - 0.3, cz, pw, deckY, pd, floorC, rotS, { sides: shade(rgb(S.skirting), 1.1) });
  // Steps down to the walk
  const stepsH = deckY - gAvg;
  const nSteps = Math.max(0, Math.round(stepsH / 0.19));
  for (let i = 0; i < nSteps; i++) {
    const top = deckY - (i + 1) * (stepsH / (nSteps + 1)) + 0.0;
    const [sxw, szw] = W(0, pd + 0.15 + i * 0.3);
    mb.box(sxw, gAvg - 0.2, szw, 1.4, top, 0.3, floorC, rotS, { sides: shade(floorC, 0.85) });
  }
  // Posts (front corners + middle on wide porches) and a solid half-wall either side of the steps.
  const postTop = Math.min(eave - 0.1, deckY + 2.45);
  const posts = pw > 4.2 ? [-pw / 2 + 0.15, -0.95, 0.95, pw / 2 - 0.15] : [-pw / 2 + 0.15, pw / 2 - 0.15];
  for (const a of posts) {
    const [px, pz] = W(a, pd - 0.15);
    mb.box(px, deckY, pz, 0.24, postTop, 0.24, trim, rotS);
  }
  const wallH = deckY + 0.8;
  const halfWall = (a0: number, a1: number, b0: number, b1: number): void => {
    const [hx, hz] = W((a0 + a1) / 2, (b0 + b1) / 2);
    mb.box(hx, deckY, hz, Math.abs(a1 - a0), wallH, Math.abs(b1 - b0), wall, rotS, { top: trim });
  };
  halfWall(-pw / 2 + 0.03, -0.75, pd - 0.2, pd - 0.05);
  halfWall(0.75, pw / 2 - 0.03, pd - 0.2, pd - 0.05);
  halfWall(-pw / 2 + 0.03, -pw / 2 + 0.18, 0.1, pd - 0.2);
  halfWall(pw / 2 - 0.18, pw / 2 - 0.03, 0.1, pd - 0.2);

  // Roof: shed sloping away from the house, or a small front-facing gable.
  const o = 0.3;
  const yWall = Math.min(eave - 0.05, postTop + 0.6);
  const y3 = (a: number, b: number, y: number): [number, number, number] => { const [x, z] = W(a, b); return [x, y, z]; };
  const fwd: [number, number, number] = [f[0], 0, f[1]];
  const rc = jitter(roof, r(), 0.02);
  if (r() < 0.5 || pw < 2.6) {
    const slope = (yWall - postTop) / pd;
    const yFront = postTop - o * slope;
    poly(mb, [y3(-pw / 2 - o, 0, yWall), y3(pw / 2 + o, 0, yWall), y3(pw / 2 + o, pd + o, yFront), y3(-pw / 2 - o, pd + o, yFront)], rc, [f[0], 1, f[1]]);
    poly(mb, [y3(-pw / 2 - o, 0, yWall - FASCIA), y3(pw / 2 + o, 0, yWall - FASCIA), y3(pw / 2 + o, pd + o, yFront - FASCIA), y3(-pw / 2 - o, pd + o, yFront - FASCIA)], shade(trim, 0.78), [0, -1, 0]);
    poly(mb, [y3(-pw / 2 - o, pd + o, yFront), y3(pw / 2 + o, pd + o, yFront), y3(pw / 2 + o, pd + o, yFront - FASCIA), y3(-pw / 2 - o, pd + o, yFront - FASCIA)], trim, fwd);
    for (const a of [-pw / 2 - o, pw / 2 + o]) {
      poly(mb, [y3(a, 0, yWall), y3(a, pd + o, yFront), y3(a, pd + o, yFront - FASCIA), y3(a, 0, yWall - FASCIA)], trim, [sx * Math.sign(a), 0, sz * Math.sign(a)]);
    }
  } else {
    const half = pw / 2 + o;
    const ridge = postTop + half * 0.62;
    const yE = postTop - o * 0.3;
    const back = -0.2;
    for (const sgn of [-1, 1]) {
      poly(mb, [y3(sgn * half, back, yE), y3(sgn * half, pd + o, yE), y3(0, pd + o, ridge), y3(0, back, ridge)], rc, [sx * sgn, 1, sz * sgn]);
      poly(mb, [y3(sgn * half, back, yE - FASCIA), y3(sgn * half, pd + o, yE - FASCIA), y3(0, pd + o, ridge - FASCIA), y3(0, back, ridge - FASCIA)], shade(trim, 0.78), [0, -1, 0]);
      poly(mb, [y3(sgn * half, pd + o, yE), y3(0, pd + o, ridge), y3(0, pd + o, ridge - FASCIA), y3(sgn * half, pd + o, yE - FASCIA)], trim, fwd);
    }
    // Gable face (siding color) above the posts.
    poly(mb, [y3(-pw / 2, pd, postTop), y3(pw / 2, pd, postTop), y3(0, pd, ridge - 0.1)], wall, fwd);
    poly(mb, [y3(-pw / 2, pd - 0.02, postTop - 0.3), y3(pw / 2, pd - 0.02, postTop - 0.3), y3(pw / 2, pd - 0.02, postTop), y3(-pw / 2, pd - 0.02, postTop)], trim, fwd);
  }

  // Collision: deck + steps (blocks the dog, not the camera).
  const a = W(-pw / 2, -0.05), b = W(pw / 2, -0.05), c = W(pw / 2, pd + 0.15 + nSteps * 0.3), e = W(-pw / 2, pd + 0.15 + nSteps * 0.3);
  ctx.obstacles.push({ ring: [...a, ...b, ...c, ...e], base: gAvg - 0.3, height: 0 });
}

/** Mix helper re-exported for props. */
export { mix };
