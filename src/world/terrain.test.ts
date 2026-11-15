import { afterEach, describe, expect, it } from 'vitest';
import { getGroundHeight, setTerrain } from './ground';
import { Heightmap } from './terrain';

// 3x2 grid, 10 m spacing, origin at (-10, 0); values in cm.
//   z=0:   0   100   200
//   z=10: 300   400   500
const hm = new Heightmap(
  { x0: -10, z0: 0, res: 10, cols: 3, rows: 2, scale: 0.01 },
  new Int16Array([0, 100, 200, 300, 400, 500]),
);

describe('Heightmap / getGroundHeight', () => {
  afterEach(() => setTerrain(null));

  it('returns exact values at grid points', () => {
    expect(hm.sample(-10, 0)).toBeCloseTo(0);
    expect(hm.sample(0, 0)).toBeCloseTo(1);
    expect(hm.sample(10, 10)).toBeCloseTo(5);
  });

  it('interpolates between grid points (exact for a planar field)', () => {
    expect(hm.sample(-5, 0)).toBeCloseTo(0.5); // along x
    expect(hm.sample(-10, 5)).toBeCloseTo(1.5); // along z
    expect(hm.sample(-5, 5)).toBeCloseTo(2); // cell center = mean of 0, 1, 3, 4
    expect(hm.sample(2.5, 7.5)).toBeCloseTo((1 * 0.75 + 2 * 0.25) * 0.25 + (4 * 0.75 + 5 * 0.25) * 0.75);
  });

  it('matches the ground mesh triangles (split along the tx + tz = 1 diagonal)', () => {
    // One 10 m cell with a "twist": only the far corner is raised.
    const tw = new Heightmap({ x0: 0, z0: 0, res: 10, cols: 2, rows: 2, scale: 0.01 }, new Int16Array([0, 0, 0, 400]));
    expect(tw.sample(2, 2)).toBeCloseTo(0); // first triangle (0, 0, 0 corners): flat
    expect(tw.sample(5, 5)).toBeCloseTo(0); // on the diagonal
    expect(tw.sample(8, 8)).toBeCloseTo(4 * 0.6); // second triangle: h11 + (0-4)(0.2) + (0-4)(0.2)
    expect(tw.sample(10, 10)).toBeCloseTo(4);
  });

  it('clamps outside the grid', () => {
    expect(hm.sample(-100, -100)).toBeCloseTo(0);
    expect(hm.sample(100, 100)).toBeCloseTo(5);
  });

  it('getGroundHeight is flat (0) without terrain and samples it once set', () => {
    expect(getGroundHeight(-5, 5)).toBe(0);
    setTerrain(hm);
    expect(getGroundHeight(-5, 5)).toBeCloseTo(2);
  });

  it('rejects mismatched data', () => {
    expect(() => new Heightmap({ x0: 0, z0: 0, res: 1, cols: 2, rows: 2, scale: 1 }, new Int16Array(3))).toThrow();
  });
});
