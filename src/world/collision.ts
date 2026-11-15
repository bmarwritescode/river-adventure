import type { Vec2 } from '../core/math';
import { TUNING } from '../config/tuning';
import {
  closestPointOnPolygon,
  pointInPolygon,
  polygonBounds,
  segmentIntersectT,
  signedArea,
  type Bounds2,
} from './geometry2d';

/**
 * The ONE obstacle-collision module.
 *
 * Obstacles are 2D footprints (any simple polygon, convex or concave) extruded
 * from `baseY` up by `height`. The dog is a circle in XZ. A uniform-grid
 * broadphase keeps queries cheap when there are thousands of OSM footprints.
 */
export interface Obstacle {
  id: string;
  /** Footprint vertices in world XZ, either winding. Not closed (first != last). */
  footprint: Vec2[];
  height: number;
  /** Bottom of the prism; defaults to 0. */
  baseY?: number;
}

interface PreparedObstacle {
  def: Obstacle;
  bounds: Bounds2;
  /** +1 if CCW in (x,z), -1 if CW. Used to orient edge normals outward. */
  winding: number;
  baseY: number;
  topY: number;
  stamp: number;
}

export interface ResolveResult {
  x: number;
  z: number;
  /** True if any obstacle pushed the circle this call. */
  collided: boolean;
}

export class CollisionWorld {
  private readonly obstacles = new Map<string, PreparedObstacle>();
  private readonly grid = new Map<string, PreparedObstacle[]>();
  private readonly cellSize: number;
  private stampCounter = 0;
  private readonly scratch: PreparedObstacle[] = [];

  constructor(cellSize = TUNING.collision.gridCellSize) {
    this.cellSize = cellSize;
  }

  get count(): number {
    return this.obstacles.size;
  }

  add(def: Obstacle): void {
    if (def.footprint.length < 3) throw new Error(`Obstacle ${def.id}: footprint needs >= 3 points`);
    if (this.obstacles.has(def.id)) this.remove(def.id);
    const baseY = def.baseY ?? 0;
    const prepared: PreparedObstacle = {
      def,
      bounds: polygonBounds(def.footprint),
      winding: signedArea(def.footprint) >= 0 ? 1 : -1,
      baseY,
      topY: baseY + def.height,
      stamp: 0,
    };
    this.obstacles.set(def.id, prepared);
    this.forCells(prepared.bounds, (key) => {
      let cell = this.grid.get(key);
      if (!cell) this.grid.set(key, (cell = []));
      cell.push(prepared);
    });
  }

  remove(id: string): void {
    const p = this.obstacles.get(id);
    if (!p) return;
    this.obstacles.delete(id);
    this.forCells(p.bounds, (key) => {
      const cell = this.grid.get(key);
      if (!cell) return;
      const i = cell.indexOf(p);
      if (i >= 0) cell.splice(i, 1);
      if (cell.length === 0) this.grid.delete(key);
    });
  }

  clear(): void {
    this.obstacles.clear();
    this.grid.clear();
  }

  /**
   * Push a circle out of all obstacles it overlaps. Because we only remove the
   * penetrating component, motion into a wall turns into sliding along it.
   * All obstacles block regardless of height (the dog can't jump onto/over them yet).
   */
  resolveCircle(x: number, z: number, radius: number): ResolveResult {
    let collided = false;
    const iterations = TUNING.collision.iterations;
    for (let iter = 0; iter < iterations; iter++) {
      let moved = false;
      const candidates = this.query({ minX: x - radius, minZ: z - radius, maxX: x + radius, maxZ: z + radius });
      for (const o of candidates) {
        const b = o.bounds;
        if (x + radius < b.minX || x - radius > b.maxX || z + radius < b.minZ || z - radius > b.maxZ) continue;
        const pts = o.def.footprint;
        const inside = pointInPolygon(x, z, pts);
        const c = closestPointOnPolygon(x, z, pts);
        if (!inside && c.distSq >= radius * radius) continue;

        const dist = Math.sqrt(c.distSq);
        let nx: number, nz: number;
        if (dist > 1e-9) {
          // Outward direction: away from the boundary point if outside, toward it if inside.
          const s = inside ? -1 : 1;
          nx = ((x - c.x) / dist) * s;
          nz = ((z - c.z) / dist) * s;
        } else {
          // Exactly on the boundary: use the edge's outward normal.
          const a = pts[c.edge]!;
          const bb = pts[(c.edge + 1) % pts.length]!;
          const ex = bb.x - a.x, ez = bb.z - a.z;
          const len = Math.hypot(ex, ez) || 1;
          nx = (ez / len) * o.winding;
          nz = (-ex / len) * o.winding;
        }
        x = c.x + nx * radius;
        z = c.z + nz * radius;
        moved = true;
        collided = true;
      }
      if (!moved) break;
    }
    return { x, z, collided };
  }

  /**
   * First obstacle hit along the 3D segment from -> to.
   * Returns the fraction t in [0,1] of the hit, or null if clear.
   * Obstacles are treated as vertical prisms (side walls only; a segment that
   * starts outside must cross a wall to get in, so the top face is implied).
   */
  raycast(
    fromX: number, fromY: number, fromZ: number,
    toX: number, toY: number, toZ: number,
  ): number | null {
    const rx = toX - fromX, ry = toY - fromY, rz = toZ - fromZ;
    const candidates = this.query({
      minX: Math.min(fromX, toX), minZ: Math.min(fromZ, toZ),
      maxX: Math.max(fromX, toX), maxZ: Math.max(fromZ, toZ),
    });
    let best = Infinity;
    for (const o of candidates) {
      const pts = o.def.footprint;
      for (let i = 0, n = pts.length; i < n; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % n]!;
        const t = segmentIntersectT(fromX, fromZ, rx, rz, a.x, a.z, b.x - a.x, b.z - a.z);
        if (t < 0 || t >= best) continue;
        const y = fromY + ry * t;
        if (y >= o.baseY && y <= o.topY) best = t;
      }
    }
    return best === Infinity ? null : best;
  }

  /** Obstacles whose bounds overlap the box (deduplicated). Result array is reused. */
  private query(box: Bounds2): PreparedObstacle[] {
    const out = this.scratch;
    out.length = 0;
    const stamp = ++this.stampCounter;
    this.forCells(box, (key) => {
      const cell = this.grid.get(key);
      if (!cell) return;
      for (const o of cell) {
        if (o.stamp === stamp) continue;
        o.stamp = stamp;
        out.push(o);
      }
    });
    return out;
  }

  private forCells(b: Bounds2, fn: (key: string) => void): void {
    const cs = this.cellSize;
    const x0 = Math.floor(b.minX / cs), x1 = Math.floor(b.maxX / cs);
    const z0 = Math.floor(b.minZ / cs), z1 = Math.floor(b.maxZ / cs);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) fn(`${ix},${iz}`);
  }
}
