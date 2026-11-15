/**
 * Terrain heightmap (pure data + sampling, no three.js; also used inside the tile worker).
 *
 * Grid points are at x = x0 + col*res, z = z0 + row*res (row-major, rows = +z).
 * Values are Int16 in units of `scale` meters (centimeters), relative to the origin's ground.
 * Sampling clamps to the grid edges and is piecewise-planar: each cell is two triangles split along
 * the same diagonal as the rendered ground mesh (buildTile.buildGround), so sampled heights lie
 * exactly on the visible ground (dog feet, draped decals and props never float or sink).
 */
export interface HeightmapMeta {
  x0: number;
  z0: number;
  res: number;
  cols: number;
  rows: number;
  /** Meters per stored unit (0.01 = centimeters). */
  scale: number;
}

export class Heightmap {
  constructor(
    readonly meta: HeightmapMeta,
    readonly data: Int16Array,
  ) {
    if (data.length !== meta.cols * meta.rows) {
      throw new Error(`Heightmap size mismatch: ${data.length} != ${meta.cols}x${meta.rows}`);
    }
  }

  /** Height at grid point (col, row), clamped to the grid. */
  at(col: number, row: number): number {
    const { cols, rows, scale } = this.meta;
    const c = col < 0 ? 0 : col >= cols ? cols - 1 : col;
    const r = row < 0 ? 0 : row >= rows ? rows - 1 : row;
    return this.data[r * cols + c]! * scale;
  }

  /** Height at world (x, z), on the same triangles as the ground mesh. */
  sample(x: number, z: number): number {
    const { x0, z0, res, cols, rows } = this.meta;
    let fc = (x - x0) / res;
    let fr = (z - z0) / res;
    fc = fc < 0 ? 0 : fc > cols - 1 ? cols - 1 : fc;
    fr = fr < 0 ? 0 : fr > rows - 1 ? rows - 1 : fr;
    const c = Math.min(Math.floor(fc), cols - 2);
    const r = Math.min(Math.floor(fr), rows - 2);
    const tx = fc - c;
    const tz = fr - r;
    const h00 = this.at(c, r), h10 = this.at(c + 1, r), h01 = this.at(c, r + 1), h11 = this.at(c + 1, r + 1);
    // Ground mesh triangles per cell: (c,r)-(c,r+1)-(c+1,r) and (c+1,r)-(c,r+1)-(c+1,r+1),
    // i.e. split along the diagonal tx + tz = 1.
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }
}
