import type { Vec2 } from '../core/math';

/** 2D (XZ-plane) polygon helpers used by collision and trigger zones. */

export interface Bounds2 {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function polygonBounds(points: readonly Vec2[]): Bounds2 {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, minZ, maxX, maxZ };
}

/** Signed area using (x, z) as math (x, y). Positive = counter-clockwise in that frame. */
export function signedArea(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % n]!;
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

/** Even-odd point-in-polygon test. Works for concave polygons. */
export function pointInPolygon(x: number, z: number, points: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export interface ClosestEdgePoint {
  x: number;
  z: number;
  distSq: number;
  /** Index of the edge (points[edge] -> points[edge+1]). */
  edge: number;
}

/** Closest point on the polygon's boundary to (x, z). */
export function closestPointOnPolygon(x: number, z: number, points: readonly Vec2[]): ClosestEdgePoint {
  const best: ClosestEdgePoint = { x: 0, z: 0, distSq: Infinity, edge: 0 };
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const abx = b.x - a.x, abz = b.z - a.z;
    const lenSq = abx * abx + abz * abz;
    let t = lenSq > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + abx * t, pz = a.z + abz * t;
    const dx = x - px, dz = z - pz;
    const d = dx * dx + dz * dz;
    if (d < best.distSq) {
      best.x = px;
      best.z = pz;
      best.distSq = d;
      best.edge = i;
    }
  }
  return best;
}

/**
 * Intersection of segment p->p+r with segment q->q+s.
 * Returns t along the first segment in [0,1], or -1 if none.
 */
export function segmentIntersectT(
  px: number, pz: number, rx: number, rz: number,
  qx: number, qz: number, sx: number, sz: number,
): number {
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-12) return -1; // parallel
  const qpx = qx - px, qpz = qz - pz;
  const t = (qpx * sz - qpz * sx) / denom;
  const u = (qpx * rz - qpz * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/** Axis-aligned or rotated rectangle as a 4-point CCW-in-(x,z) footprint. */
export function rectFootprint(cx: number, cz: number, width: number, depth: number, rotation = 0): Vec2[] {
  const hw = width / 2, hd = depth / 2;
  const c = Math.cos(rotation), s = Math.sin(rotation);
  const corners: [number, number][] = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  // rotation follows three.js rotation.y (counter-clockwise seen from above).
  return corners.map(([x, z]) => ({ x: cx + x * c + z * s, z: cz - x * s + z * c }));
}

/** Regular n-gon footprint (e.g. tree trunks). */
export function circleFootprint(cx: number, cz: number, radius: number, sides = 8): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * radius, z: cz + Math.sin(a) * radius });
  }
  return pts;
}
