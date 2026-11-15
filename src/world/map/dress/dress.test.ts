import { describe, expect, it } from 'vitest';
import { MAP_STYLE } from '../../../config/mapStyle';
import { buildSurfaces } from '../buildTile';
import { Heightmap } from '../../terrain';
import type { TileData } from '../types';
import { decompose, dominantAxis } from './houses';
import { buildDressing } from './index';
import { MeshBuilder, rgb } from './MeshBuilder';
import type { SignPainter } from './signs';

/** Fake 2D canvas: records nothing, returns blank pixels (no DOM in unit tests). */
const fakeCanvas = (w: number, h: number): SignPainter => ({
  fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'center', textBaseline: 'middle',
  fillRect() {}, strokeRect() {}, fillText() {},
  measureText: (t: string) => ({ width: t.length * 20 }),
  getImageData: () => ({ data: new Uint8ClampedArray(w * h * 4) }),
});

const rect = (x0: number, z0: number, x1: number, z1: number): number[] => [x0, z0, x1, z0, x1, z1, x0, z1];

describe('house footprint decomposition', () => {
  it('a rectangle is one rectangle', () => {
    const r = decompose(rect(0, 0, 10, 6));
    expect(r).toHaveLength(1);
    expect(r[0]!.u1 - r[0]!.u0).toBeCloseTo(10, 0);
    expect(r[0]!.v1 - r[0]!.v0).toBeCloseTo(6, 0);
  });

  it('an L-shape splits into two rectangles covering most of it', () => {
    // 10 x 10 square minus a 5 x 5 corner = 75 m²
    const L = [0, 0, 10, 0, 10, 5, 5, 5, 5, 10, 0, 10];
    const r = decompose(L);
    expect(r.length).toBe(2);
    const area = r.reduce((a, q) => a + (q.u1 - q.u0) * (q.v1 - q.v0), 0);
    expect(area).toBeGreaterThan(70);
    expect(area).toBeLessThanOrEqual(75.5);
  });

  it('dominant axis of a rotated rectangle', () => {
    const a = 0.4, c = Math.cos(a), s = Math.sin(a);
    const pts = [[0, 0], [12, 0], [12, 7], [0, 7]].flatMap(([x, z]) => [x! * c - z! * s, x! * s + z! * c]);
    const [ux, uz] = dominantAxis(pts);
    // Parallel or perpendicular to the rotated sides (mod 90°).
    const ang = Math.atan2(uz, ux);
    const diff = Math.abs(((ang - a) % (Math.PI / 2) + Math.PI / 2) % (Math.PI / 2));
    expect(Math.min(diff, Math.PI / 2 - diff)).toBeLessThan(1e-6);
  });
});

describe('MeshBuilder', () => {
  it('face() winds triangles to face the requested direction', () => {
    const mb = new MeshBuilder();
    mb.face([[0, 0, 0], [0, 0, 1], [1, 0, 0]], rgb('#ffffff'), [0, 1, 0]); // given clockwise from above
    const m = mb.build();
    expect(m.normals[1]).toBeCloseTo(1); // normal points up anyway
  });

  it('converts sRGB palette colors to linear vertex colors', () => {
    expect(rgb('#808080')[0]).toBeCloseTo(0.2159 * 255, 0);
    expect(rgb('#ffffff')[0]).toBeCloseTo(255, 5);
  });
});

describe('buildDressing', () => {
  const tile: TileData = {
    v: 2, i: 0, j: 0, streets: [], trees: [], areas: {},
    buildings: [{
      r: [rect(10, 10, 20, 18)], h: 5.5, id: 1,
      d: { k: 'house', seed: 42, roof: 'gable', f: [0, 1], door: [15, 18], porch: [4, 2], pier: 1 },
    }, {
      r: [rect(40, 10, 48, 16)], h: 6, id: 2, d: { k: 'shop', seed: 7, roof: 'flat', f: [0, 1], door: [44, 16], sign: 'Test Shop' },
    }],
    props: {
      tree_oak: [30, 30, 0, 1, 0], tree_myrtle: [34, 30, 1, 1, 2], car: [60, 30, 0.5, 1, 1], pole: [70, 30, 0, 1, 1],
      stop: [80, 30, 0, 1, 0], hydrant: [85, 30, 0, 1, 0], cart_trash: [90, 30, 0, 1, 0],
    },
    signs: [{ x: 95, z: 30, a: 'Duval St', ar: 0, b: 'E 52nd St', br: 1.57 }],
    wires: [70, 30, 110, 30],
    marks: [{ t: 'yellow2', p: [0, 50, 100, 50] }],
    curbs: [[0, 45, 100, 45]],
  };

  it('builds finite geometry, collision for the house, porch and props, and sign quads', () => {
    const d = buildDressing(tile, null, MAP_STYLE, fakeCanvas)!;
    expect(d).not.toBeNull();
    for (const v of d.structures.positions) expect(Number.isFinite(v)).toBe(true);
    expect(d.structures.positions.length / 9).toBe(d.counts.triangles);
    // 2 buildings + porch + 7 props + sign post
    expect(d.footprints.offsets.length - 1).toBeGreaterThanOrEqual(2 + 1 + 7 + 1);
    expect(d.decals!.indices.length).toBeGreaterThan(0);
    // Signs: shop label + STOP + 2 two-sided blades = 4 + 2*2 faces
    expect(d.signs!.mesh.indices.length / 6).toBe(1 + 1 + 4);
    // Stays low-poly: a house well under 1.5k triangles, the whole test tile under 6k.
    expect(d.counts.triangles).toBeLessThan(6000);
  });

  it('returns null for tiles with no dressing', () => {
    expect(buildDressing({ ...tile, buildings: [], props: undefined, signs: undefined, wires: undefined, marks: undefined, curbs: undefined }, null, MAP_STYLE, fakeCanvas)).toBeNull();
  });
});

describe('buildSurfaces', () => {
  const surf = (hm: Heightmap | null) => {
    const mb = new MeshBuilder();
    buildSurfaces(mb, { v: 2, i: 0, j: 0, buildings: [], streets: [], trees: [], areas: { road: [[rect(0, 0, 40, 8)]] } }, hm, MAP_STYLE);
    return mb.build();
  };

  it('keeps flat ground cheap (no subdivision needed)', () => {
    const m = surf(null);
    expect(m.indices.length / 3).toBe(2);
    expect(m.positions[1]).toBeGreaterThan(0); // lifted above the ground
  });

  it('follows bumpy terrain exactly (cut along the ground mesh triangles)', () => {
    // 5 m grid with a bump in the middle
    const cols = 11, rows = 4, data = new Int16Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[r * cols + c] = Math.round(100 * Math.sin(c * 0.9) * Math.cos(r));
    const hm = new Heightmap({ x0: -1, z0: -1, res: 5, cols, rows, scale: 0.01 }, data);
    const m = surf(hm);
    expect(m.indices.length / 3).toBeGreaterThan(20);
    // Every triangle's centroid sits within tolerance of the lifted terrain.
    const p = m.positions;
    for (let t = 0; t < p.length; t += 9) {
      const cx = (p[t]! + p[t + 3]! + p[t + 6]!) / 3, cz = (p[t + 2]! + p[t + 5]! + p[t + 8]!) / 3;
      const cy = (p[t + 1]! + p[t + 4]! + p[t + 7]!) / 3;
      expect(Math.abs(cy - (hm.sample(cx, cz) + 0.035))).toBeLessThan(1e-4); // exactly on the ground triangles
    }
  });
});
