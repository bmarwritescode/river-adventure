import { describe, expect, it } from 'vitest';
import { MAP_STYLE } from '../../../config/mapStyle';
import { buildSurfaces } from '../buildTile';
import { Heightmap } from '../../terrain';
import type { TileData } from '../types';
import { decompose, dominantAxis } from './houses';
import { buildDressing } from './index';
import { MeshBuilder, rgb } from './MeshBuilder';
import { buildSignMesh, type SignPainter } from './signs';

/** Fake 2D canvas: records nothing, returns blank pixels (no DOM in unit tests). */
const fakeCanvas = (w: number, h: number): SignPainter => ({
  fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: 'miter', font: '', textAlign: 'center', textBaseline: 'middle',
  globalCompositeOperation: 'source-over',
  fillRect() {}, strokeRect() {}, fillText() {}, strokeText() {},
  lineCap: 'butt', beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, fill() {}, stroke() {},
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
    v: 3, i: 0, j: 0, streets: [], trees: [], areas: {},
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
    buildSurfaces(mb, { v: 3, i: 0, j: 0, buildings: [], streets: [], trees: [], areas: { road: [[rect(0, 0, 40, 8)]] } }, hm, MAP_STYLE);
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

describe('house frame far from the origin', () => {
  it('keeps the roof on the walls even with a rounded (non-unit) front direction', () => {
    // A 10 x 8 house ~1.1 km from the origin; d.f rounded to 3 decimals like the tile data.
    const c = Math.cos(0.5), s = Math.sin(0.5);
    const cx = 580, cz = -990;
    const ring = [[-5, -4], [5, -4], [5, 4], [-5, 4]].flatMap(([x, z]) => [cx + x! * c - z! * s, cz + x! * s + z! * c]);
    const tile: TileData = {
      v: 3, i: 0, j: 0, streets: [], trees: [], areas: {},
      buildings: [{ r: [ring], h: 6, id: 9, d: { k: 'house', seed: 3, roof: 'hip', f: [Number((-s).toFixed(3)), Number(c.toFixed(3))] } }],
    };
    const d = buildDressing(tile, null, MAP_STYLE, fakeCanvas)!;
    const p = d.structures.positions;
    let maxR = 0;
    for (let k = 0; k < p.length; k += 3) {
      if (p[k + 1]! < 3) continue; // roof only
      maxR = Math.max(maxR, Math.hypot(p[k]! - cx, p[k + 2]! - cz));
    }
    // Corner distance 6.4 m + overhang/fascia ~0.65 m; a shifted roof would reach well past that.
    expect(maxR).toBeLessThan(Math.hypot(5, 4) + 0.75);
  });
});

describe('fences', () => {
  const base: TileData = { v: 3, i: 0, j: 0, buildings: [], streets: [], trees: [], areas: {} };
  for (const t of ['wood', 'cedar', 'picket', 'chain', 'iron', 'hogwire'] as const) {
    it(`${t}: finite geometry, one dog-only obstacle per segment, low-poly`, () => {
      const d = buildDressing({ ...base, fences: [{ t, h: t === 'wood' ? 1.85 : 1.1, p: [0, 0, 10, 0, 10, 6] }] }, null, MAP_STYLE, fakeCanvas)!;
      for (const v of d.structures.positions) expect(Number.isFinite(v)).toBe(true);
      expect(d.footprints.offsets.length - 1).toBe(2);
      for (const h of d.footprints.heights) expect(h).toBe(0); // blocks the dog, not the camera
      for (const top of d.footprints.tops) expect(top).toBeCloseTo(t === 'wood' ? 1.85 : 1.1, 5); // ...who can jump it
      expect(d.counts.triangles / 16).toBeLessThan(60); // triangles per meter of fence
    });
  }
});

describe('Home Slice landmark', () => {
  // The real record from the tile data (OSM way 379191561 + the pipeline's site frame).
  const hs: TileData = {
    v: 3, i: 2, j: -4, streets: [], trees: [], areas: {},
    buildings: [{
      r: [[593.19, -1000.97, 583.48, -983.24, 585.22, -982.26, 581.36, -975.34, 579.71, -976.21, 576.51, -970.3, 558.22, -980.4,
        561.8, -986.87, 562.38, -986.55, 575.67, -1010.64]],
      h: 4.15, id: 379191561,
      d: { k: 'shop', seed: 91561, f: [0.483, -0.876], door: [586.88, -1004.45], roof: 'flat',
        lm: { id: 'homeslice', o: [575.67, -1010.64], u: [0.8755, 0.4832], pw: 12.13 } },
    }],
  };

  it('builds the building, patio fixtures, signs and collision within budget', () => {
    const d = buildDressing(hs, null, MAP_STYLE, fakeCanvas)!;
    for (const v of d.structures.positions) expect(Number.isFinite(v)).toBe(true);
    expect(d.counts.landmarks).toBe(1);
    // Sign lettering: HOME / SLICE / PIZZA (two-sided) + RESTAURANT BAR + windows + awning text.
    expect(d.signs!.mesh.indices.length / 6).toBeGreaterThanOrEqual(15);
    // Building + shed/sail posts + bar + tables + mounds + tunnel walls.
    expect(d.footprints.offsets.length - 1).toBeGreaterThan(20);
    expect(d.counts.triangles).toBeLessThan(16000);
  });

  it('puts the storefront on the real wall (not floating in front of it)', () => {
    const d = buildDressing(hs, null, MAP_STYLE, fakeCanvas)!;
    // Every sign quad sits within 0.35 m of the storefront plane or above the roof (letters on the band).
    const [ox, oz] = [575.67, -1010.64], n = [0.4832, -0.8755];
    const p = d.signs!.mesh.positions;
    let poleSign = 0;
    for (let q = 0; q < p.length; q += 12) { // 4 vertices per quad
      const ys = [p[q + 1]!, p[q + 4]!, p[q + 7]!, p[q + 10]!];
      if (Math.max(...ys) - Math.min(...ys) > 3) { poleSign++; continue; } // the Queen of Pies, out by 53rd
      for (let k = q; k < q + 12; k += 3) {
        const b = (p[k]! - ox) * n[0]! + (p[k + 2]! - oz) * n[1]!;
        expect(Math.abs(b)).toBeLessThan(1.15); // awning valance text is ~1.05 m out
      }
    }
    expect(poleSign).toBe(2); // both faces
  });
});

describe('sign atlas', () => {
  it('shelf-packs labels of different sizes without overlap', () => {
    const lab = (text: string, w: number, h: number, rows?: number) => ({ text, x: 0, y: 0, z: 0, rot: 0, width: w, height: h, background: null, rows });
    const labels = [lab('HOME', 2.3, 1, 2), lab('SLICE', 2.9, 1, 2), lab('PIZZA', 3.3, 1, 2), lab('BAR', 1, 0.3, 0.75),
      lab('A long awning line of text', 6, 0.3, 0.75), lab('501', 0.5, 0.2, 0.5)];
    const r = buildSignMesh(labels, [], fakeCanvas)!;
    const uv = r.mesh.uvs;
    const rects: [number, number, number, number][] = [];
    for (let q = 0; q < uv.length; q += 8) {
      const us = [uv[q]!, uv[q + 2]!, uv[q + 4]!, uv[q + 6]!], vs = [uv[q + 1]!, uv[q + 3]!, uv[q + 5]!, uv[q + 7]!];
      rects.push([Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)]);
    }
    for (const [u0, u1, v0, v1] of rects) {
      expect(u0).toBeGreaterThanOrEqual(0); expect(u1).toBeLessThanOrEqual(1);
      expect(v0).toBeGreaterThanOrEqual(0); expect(v1).toBeLessThanOrEqual(1);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!, b = rects[j]!;
        const overlap = a[0] < b[1] && b[0] < a[1] && a[2] < b[3] && b[2] < a[3];
        expect(overlap).toBe(false);
      }
    }
    expect(r.height).toBeLessThanOrEqual(128 * 2 + 48 + 32 + 3 * 2 + 4); // 4 shelves, nothing wasted
  });
});
