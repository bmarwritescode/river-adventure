/** Small math helpers shared across modules. */

export interface Vec2 {
  x: number;
  z: number;
}

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Interpolate between angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/**
 * Frame-rate independent exponential smoothing factor.
 * `x += (target - x) * damp(sharpness, dt)` converges at the same rate at any fps.
 */
export function damp(sharpness: number, dt: number): number {
  return 1 - Math.exp(-sharpness * dt);
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

/**
 * Heading convention: heading 0 faces north (-Z); positive heading turns
 * counter-clockwise seen from above (toward west), matching three.js rotation.y.
 */
export function headingToForward(heading: number): Vec2 {
  return { x: -Math.sin(heading), z: -Math.cos(heading) };
}

export function forwardToHeading(x: number, z: number): number {
  return Math.atan2(-x, -z);
}
