import earcut from 'earcut';
import type { MapStyle } from '../../config/mapStyle';
import type { Heightmap } from '../terrain';
import { AREA_KINDS, type FlatPolygon, type TileBuilding, type TileData } from './types';

/**
 * Pure tile -> mesh-array builders. Runs inside the tile worker (no three.js, no DOM),
 * so building a tile never blocks the main thread.
 */

export interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  uvs?: Float32Array;
  colors?: Uint8Array;
}

export interface Footprints {
  /** Concatenated outer rings, flat [x, z, ...]. */
  coords: Float32Array;
  /** Start index (in points) of each ring in `coords`, plus a final end offset. */
  offsets: Uint32Array;
  /** Prism height and bottom y per building (for camera raycasts). */
  heights: Float32Array;
  bases: Float32Array;
}

const heightAt = (hm: Heightmap | null, x: number, z: number): number => (hm ? hm.sample(x, z) : 0);

/**
 * Ground: a regular grid over the tile following the heightmap. With terrain, the grid spacing
 * equals the heightmap resolution and is aligned to it, so the mesh matches getGroundHeight exactly.
 */
export function buildGround(i: number, j: number, tileSize: number, hm: Heightmap | null): MeshArrays {
  const res = hm ? hm.meta.res : tileSize / 10;
  const n = Math.max(1, Math.round(tileSize / res));
  const step = tileSize / n;
  const x0 = i * tileSize, z0 = j * tileSize;
  const verts = (n + 1) * (n + 1);
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  for (let r = 0; r <= n; r++) {
    for (let c = 0; c <= n; c++) {
      const k = r * (n + 1) + c;
      const x = x0 + c * step, z = z0 + r * step;
      positions[k * 3] = x;
      positions[k * 3 + 1] = heightAt(hm, x, z);
      positions[k * 3 + 2] = z;
      // Normal from central differences of the height field.
      const dx = heightAt(hm, x + step, z) - heightAt(hm, x - step, z);
      const dz = heightAt(hm, x, z + step) - heightAt(hm, x, z - step);
      const nx = -dx, ny = 2 * step, nz = -dz;
      const len = Math.hypot(nx, ny, nz);
      normals[k * 3] = nx / len;
      normals[k * 3 + 1] = ny / len;
      normals[k * 3 + 2] = nz / len;
      uvs[k * 2] = c / n;
      uvs[k * 2 + 1] = r / n; // texture row 0 = north edge of the tile (smallest z)
    }
  }
  const indices = new Uint32Array(n * n * 6);
  let o = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const a = r * (n + 1) + c, b = a + 1, d = a + (n + 1), e = d + 1;
      // CCW seen from above (+y): a -> d -> b, b -> d -> e
      indices[o++] = a; indices[o++] = d; indices[o++] = b;
      indices[o++] = b; indices[o++] = d; indices[o++] = e;
    }
  }
  return { positions, normals, uvs, indices };
}

function signedArea(ring: number[]): number {
  let a = 0;
  for (let k = 0, m = ring.length / 2; k < m; k++) {
    const k2 = (k + 1) % m;
    a += ring[k * 2]! * ring[k2 * 2 + 1]! - ring[k2 * 2]! * ring[k * 2 + 1]!;
  }
  return a / 2;
}

function hash01(s: number): number {
  const x = Math.sin(s * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Extruded flat-roof buildings, merged into one mesh with per-building vertex colors. */
export function buildBuildings(
  buildings: TileBuilding[], hm: Heightmap | null, style: MapStyle, seed: number,
): { mesh: MeshArrays; footprints: Footprints } {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const fpCoords: number[] = [];
  const fpOffsets: number[] = [0];
  const fpHeights: number[] = [];
  const fpBases: number[] = [];

  buildings.forEach((b, bi) => {
    const rings = b.r.filter((r) => r.length >= 6);
    const outer = rings[0];
    if (!outer) return;
    // Base/top from the terrain under the outer ring.
    let gMin = Infinity, gSum = 0;
    const m = outer.length / 2;
    for (let k = 0; k < m; k++) {
      const g = heightAt(hm, outer[k * 2]!, outer[k * 2 + 1]!);
      gMin = Math.min(gMin, g);
      gSum += g;
    }
    const base = gMin - style.buildingSink;
    const top = gSum / m + b.h;
    const v = (hash01(seed * 1000 + bi) - 0.5) * 2 * style.buildingVariation;
    const wall = Math.round(Math.min(1, Math.max(0, style.buildingWall + v)) * 255);
    const roof = Math.round(Math.min(1, Math.max(0, style.buildingRoof + v)) * 255);

    // Walls: each ring edge is a quad with a flat outward normal.
    rings.forEach((ring, ri) => {
      // Outer ring must be CCW (x/z math orientation), holes CW, so (dz, -dx) points out of the material.
      const area = signedArea(ring);
      const want = ri === 0 ? 1 : -1;
      const flip = Math.sign(area) !== want;
      const n = ring.length / 2;
      for (let k = 0; k < n; k++) {
        const ka = flip ? n - 1 - k : k;
        const kb = flip ? (n - 1 - k - 1 + n) % n : (k + 1) % n;
        const ax = ring[ka * 2]!, az = ring[ka * 2 + 1]!;
        const bx = ring[kb * 2]!, bz = ring[kb * 2 + 1]!;
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) continue;
        const nx = dz / len, nz = -dx / len;
        const s = pos.length / 3;
        pos.push(ax, base, az, bx, base, bz, bx, top, bz, ax, top, az);
        for (let q = 0; q < 4; q++) { nor.push(nx, 0, nz); col.push(wall, wall, wall); }
        idx.push(s, s + 2, s + 1, s, s + 3, s + 2);
      }
    });

    // Roof: earcut over outer + holes, oriented to face up.
    const flat: number[] = [];
    const holes: number[] = [];
    rings.forEach((ring, ri) => {
      if (ri > 0) holes.push(flat.length / 2);
      for (const c of ring) flat.push(c);
    });
    const tris = earcut(flat, holes, 2);
    const s = pos.length / 3;
    for (let k = 0; k < flat.length / 2; k++) {
      pos.push(flat[k * 2]!, top, flat[k * 2 + 1]!);
      nor.push(0, 1, 0);
      col.push(roof, roof, roof);
    }
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]!, bb = tris[t + 1]!, c = tris[t + 2]!;
      const ux = flat[bb * 2]! - flat[a * 2]!, uz = flat[bb * 2 + 1]! - flat[a * 2 + 1]!;
      const vx = flat[c * 2]! - flat[a * 2]!, vz = flat[c * 2 + 1]! - flat[a * 2 + 1]!;
      // (u x v).y = uz*vx - ux*vz must be > 0 for a front face seen from above.
      if (uz * vx - ux * vz >= 0) idx.push(s + a, s + bb, s + c);
      else idx.push(s + a, s + c, s + bb);
    }

    for (const c of outer) fpCoords.push(c);
    fpOffsets.push(fpCoords.length / 2);
    fpHeights.push(top - base);
    fpBases.push(base);
  });

  return {
    mesh: {
      positions: new Float32Array(pos),
      normals: new Float32Array(nor),
      colors: new Uint8Array(col),
      indices: new Uint32Array(idx),
    },
    footprints: {
      coords: new Float32Array(fpCoords),
      offsets: new Uint32Array(fpOffsets),
      heights: new Float32Array(fpHeights),
      bases: new Float32Array(fpBases),
    },
  };
}

/** Minimal 2D context surface we need (OffscreenCanvas in the worker, a canvas in tests). */
export interface Paint2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  fill(rule?: CanvasFillRule): void;
}

function tracePolygon(ctx: Paint2D, poly: FlatPolygon): void {
  for (const ring of poly) {
    if (ring.length < 6) continue;
    ctx.moveTo(ring[0]!, ring[1]!);
    for (let k = 2; k < ring.length; k += 2) ctx.lineTo(ring[k]!, ring[k + 1]!);
    ctx.closePath();
  }
}

/** Paint the tile's surface layers (top-down, north up) into a size x size texture. */
export function paintTile(ctx: Paint2D, data: TileData, tileSize: number, size: number, style: MapStyle): void {
  const s = size / tileSize;
  const x0 = data.i * tileSize, z0 = data.j * tileSize;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = style.ground;
  ctx.fillRect(0, 0, size, size);
  ctx.setTransform(s, 0, 0, s, -x0 * s, -z0 * s); // draw directly in world meters
  for (const kind of AREA_KINDS) {
    const polys = data.areas[kind];
    if (!polys?.length) continue;
    ctx.fillStyle = style.layers[kind];
    ctx.beginPath();
    for (const p of polys) tracePolygon(ctx, p);
    ctx.fill('evenodd');
  }
  if (data.trees.length) {
    ctx.fillStyle = style.treeCanopy;
    ctx.beginPath();
    for (let k = 0; k < data.trees.length; k += 2) {
      const x = data.trees[k]!, z = data.trees[k + 1]!;
      ctx.moveTo(x + style.treeCanopyRadius, z);
      ctx.arc(x, z, style.treeCanopyRadius, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}
