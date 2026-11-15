import type { MapStyle } from '../../../config/mapStyle';
import type { Heightmap } from '../../terrain';
import { drapeTriangle, type Footprints, type MeshArrays } from '../buildTile';
import type { TileData } from '../types';
import { buildDressedBuilding, type DressContext } from './houses';
import { MeshBuilder, rgb } from './MeshBuilder';
import { buildFences } from './fences';
import { buildCurbs, buildProps, buildWires } from './props';
import { buildSignMesh, streetSignLabels, type SignMeshResult, type SignPainter } from './signs';

export interface DressedTile {
  /** Houses + props + curbs + wires: merged into the tile's building mesh (one draw call). */
  structures: MeshArrays;
  /** Lane markings (separate material with polygon offset so they never z-fight the road). */
  decals: MeshArrays | null;
  signs: SignMeshResult | null;
  /** Collision for dressed buildings and props. */
  footprints: Footprints;
  counts: { buildings: number; props: number; landmarks: number; triangles: number };
}

const MARK_WIDTH = { yellow2: 0.1, white: 0.15, stop: 0.45 } as const;

/** Build everything for the dressed parts of a tile (returns null if the tile has no dressing). */
export function buildDressing(data: TileData, hm: Heightmap | null, style: MapStyle,
  newCanvas: (w: number, h: number) => SignPainter | null): DressedTile | null {
  const dressedBuildings = data.buildings.filter((b) => b.d);
  if (!dressedBuildings.length && !data.props && !data.signs && !data.marks && !data.curbs && !data.fences) return null;

  const mb = new MeshBuilder();
  const ctx: DressContext = { mb, hm, style: style.dress, sink: style.buildingSink, obstacles: [], labels: [] };

  const fpCoords: number[] = [];
  const fpOffsets: number[] = [0];
  const fpHeights: number[] = [];
  const fpBases: number[] = [];
  const addFootprint = (ring: number[], base: number, height: number): void => {
    for (const c of ring) fpCoords.push(c);
    fpOffsets.push(fpCoords.length / 2);
    fpHeights.push(height);
    fpBases.push(base);
  };

  for (const b of dressedBuildings) {
    buildDressedBuilding(ctx, b);
    const outer = b.r[0]!;
    let gMin = Infinity, gSum = 0;
    const m = outer.length / 2;
    for (let k = 0; k < m; k++) {
      const g = hm ? hm.sample(outer[k * 2]!, outer[k * 2 + 1]!) : 0;
      gMin = Math.min(gMin, g);
      gSum += g;
    }
    const base = gMin - style.buildingSink;
    addFootprint(outer, base, gSum / m + b.h - base);
  }
  const props = (data.props ? buildProps(ctx, data.props, data.signs) : 0) + buildFences(ctx, data.fences);
  // STOP text on stop signs (same atlas as street names).
  const stops = data.props?.stop ?? [];
  for (let k = 0; k + 4 < stops.length; k += 5) {
    const x = stops[k]!, z = stops[k + 1]!, rot = stops[k + 2]!;
    const y = hm ? hm.sample(x, z) : 0;
    // The sign plate faces local −Z (= rotation + π for a label, whose face is local +Z).
    ctx.labels.push({
      text: 'STOP', x: x - Math.sin(rot) * 0.056, y: y + 2.15, z: z - Math.cos(rot) * 0.056, rot: rot + Math.PI,
      width: 0.5, height: 0.2, background: style.dress.stopSign,
    });
  }
  if (data.curbs) buildCurbs(ctx, data.curbs);
  for (const o of ctx.obstacles) addFootprint(o.ring, o.base, o.height);

  const structures = mb.build();
  // Decals: lane markings + overhead wires (wires don't cast shadows: thin shadows alias badly).
  const dm = new MeshBuilder();
  if (data.marks?.length) buildMarks(dm, data, hm, style);
  if (data.wires) buildWires({ ...ctx, mb: dm }, data.wires);
  const decals = dm.triangles ? dm.build() : null;
  const signs = buildSignMesh(ctx.labels, streetSignLabels(ctx, data.signs), newCanvas);

  return {
    structures, decals, signs,
    footprints: {
      coords: new Float32Array(fpCoords), offsets: new Uint32Array(fpOffsets),
      heights: new Float32Array(fpHeights), bases: new Float32Array(fpBases),
    },
    counts: {
      buildings: dressedBuildings.length, props, landmarks: dressedBuildings.filter((b) => b.d!.lm).length,
      triangles: structures.indices.length / 3,
    },
  };
}

/** Lane markings as thin strips draped exactly on the ground (just above the road surface). */
function buildMarks(mb: MeshBuilder, data: TileData, hm: Heightmap | null, style: MapStyle): void {
  const LIFT = 0.05; // above the road surface (buildTile.SURFACE_LIFT.road = 0.035)
  for (const m of data.marks ?? []) {
    const color = rgb(style.dress.marks[m.t]);
    const p = m.p;
    const offsets = m.t === 'yellow2' ? [-0.1, 0.1] : [0];
    const hw = MARK_WIDTH[m.t] / 2;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k]!, az = p[k + 1]!, bx = p[k + 2]!, bz = p[k + 3]!;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      const nx = -(bz - az) / L, nz = (bx - ax) / L;
      for (const off of offsets) {
        const o0 = off - hw, o1 = off + hw;
        const q = [ax + nx * o0, az + nz * o0, ax + nx * o1, az + nz * o1, bx + nx * o1, bz + nz * o1, bx + nx * o0, bz + nz * o0];
        drapeTriangle(mb, [q[0]!, q[1]!, q[2]!, q[3]!, q[4]!, q[5]!], hm, LIFT, color);
        drapeTriangle(mb, [q[0]!, q[1]!, q[4]!, q[5]!, q[6]!, q[7]!], hm, LIFT, color);
      }
    }
  }
}

/** Concatenate two mesh-array sets (same attribute layout: positions, normals, colors). */
export function mergeMeshes(a: MeshArrays, b: MeshArrays): MeshArrays {
  const na = a.positions.length / 3;
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions); positions.set(b.positions, a.positions.length);
  const normals = new Float32Array(a.normals.length + b.normals.length);
  normals.set(a.normals); normals.set(b.normals, a.normals.length);
  const colors = new Uint8Array((a.colors?.length ?? 0) + (b.colors?.length ?? 0));
  if (a.colors) colors.set(a.colors);
  if (b.colors) colors.set(b.colors, a.colors?.length ?? 0);
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i]! + na;
  return { positions, normals, colors, indices };
}

export function mergeFootprints(a: Footprints, b: Footprints): Footprints {
  const na = a.coords.length / 2;
  const coords = new Float32Array(a.coords.length + b.coords.length);
  coords.set(a.coords); coords.set(b.coords, a.coords.length);
  const offsets = new Uint32Array(a.offsets.length + b.offsets.length - 1);
  offsets.set(a.offsets);
  for (let i = 1; i < b.offsets.length; i++) offsets[a.offsets.length + i - 1] = b.offsets[i]! + na;
  const heights = new Float32Array(a.heights.length + b.heights.length);
  heights.set(a.heights); heights.set(b.heights, a.heights.length);
  const bases = new Float32Array(a.bases.length + b.bases.length);
  bases.set(a.bases); bases.set(b.bases, a.bases.length);
  return { coords, offsets, heights, bases };
}
