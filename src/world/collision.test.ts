import { describe, expect, it } from 'vitest';
import { MAIN_DOG } from '../config/dogProfiles';
import type { Vec2 } from '../core/math';
import { DogController, type DogIntent } from '../dog/DogController';
import { CollisionWorld } from './collision';
import { pointInPolygon, rectFootprint } from './geometry2d';

const square: Vec2[] = rectFootprint(0, 0, 10, 10); // x,z in [-5, 5]
// Concave L: 10 x 10 with the north-east quarter removed.
const L: Vec2[] = [
  { x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 5 }, { x: 5, z: 5 }, { x: 5, z: 10 }, { x: 0, z: 10 },
];

describe('pointInPolygon', () => {
  it('handles convex polygons', () => {
    expect(pointInPolygon(0, 0, square)).toBe(true);
    expect(pointInPolygon(5.01, 0, square)).toBe(false);
  });
  it('handles concave polygons (either winding)', () => {
    expect(pointInPolygon(2, 2, L)).toBe(true);
    expect(pointInPolygon(8, 8, L)).toBe(false); // the cut-out quarter
    const reversed = [...L].reverse();
    expect(pointInPolygon(2, 8, reversed)).toBe(true);
    expect(pointInPolygon(8, 8, reversed)).toBe(false);
  });
});

describe('CollisionWorld.resolveCircle', () => {
  const r = 0.3;

  it('pushes a circle out of a box to exactly the radius', () => {
    const w = new CollisionWorld();
    w.add({ id: 'sq', footprint: square, height: 5 });
    const res = w.resolveCircle(5.1, 0, r); // overlapping the east wall
    expect(res.collided).toBe(true);
    expect(res.x).toBeCloseTo(5 + r, 5);
    expect(res.z).toBeCloseTo(0, 5);
  });

  it('pushes out of the interior via the nearest edge', () => {
    const w = new CollisionWorld();
    w.add({ id: 'sq', footprint: square, height: 5 });
    const res = w.resolveCircle(4.5, 1, r); // inside, nearest edge is east
    expect(res.x).toBeCloseTo(5 + r, 5);
    expect(w.overlapsCircle(res.x, res.z, r)).toBe(false);
  });

  it('keeps the tangential component (slides along walls)', () => {
    const w = new CollisionWorld();
    w.add({ id: 'sq', footprint: square, height: 5 });
    const res = w.resolveCircle(5.1, 2.0, r); // moved diagonally into the east wall
    expect(res.z).toBeCloseTo(2.0, 5);
  });

  it('resolves the inside corner of a concave footprint', () => {
    const w = new CollisionWorld();
    w.add({ id: 'L', footprint: L, height: 5 });
    const res = w.resolveCircle(5.1, 5.1, r); // jammed into the reflex corner
    expect(w.overlapsCircle(res.x, res.z, r)).toBe(false);
  });

  it('ignores circles that do not touch', () => {
    const w = new CollisionWorld();
    w.add({ id: 'sq', footprint: square, height: 5 });
    expect(w.resolveCircle(6, 6, r).collided).toBe(false);
  });

  it('removes obstacles from the broadphase', () => {
    const w = new CollisionWorld();
    w.add({ id: 'sq', footprint: square, height: 5 });
    w.remove('sq');
    expect(w.count).toBe(0);
    expect(w.overlapsCircle(0, 0, r)).toBe(false);
  });

  it('raycast hits walls within their height range only', () => {
    const w = new CollisionWorld();
    w.add({ id: 'sq', footprint: square, height: 5 });
    expect(w.raycast(-10, 1, 0, 10, 1, 0)).toBeCloseTo(0.25); // enters at x = -5
    expect(w.raycast(-10, 6, 0, 10, 6, 0)).toBeNull(); // passes over the roof
  });
});

describe('DogController against real-world-like obstacles', () => {
  const run = (world: CollisionWorld, startX: number, startZ: number, heading: number, moveX: number, moveZ: number) => {
    const dog = new DogController(MAIN_DOG, world);
    dog.teleport(startX, startZ, heading);
    const intent: DogIntent = { moveX, moveZ, pace: 'run', sniff: false, jump: false, sit: false, playBow: false };
    let everInside = false;
    for (let i = 0; i < 60 * 4; i++) {
      dog.step(1 / 60, intent);
      if (world.overlapsCircle(dog.position.x, dog.position.z, MAIN_DOG.collisionRadius)) everInside = true;
    }
    return { dog, everInside };
  };

  it('never ends up inside a gap narrower than the dog (and does not pass through it)', () => {
    const w = new CollisionWorld();
    // Two buildings 0.4 m apart (dog is 0.56 m wide); the gap runs north-south at x = 0.
    w.add({ id: 'west', footprint: rectFootprint(-5.2, 0, 10, 10), height: 5 });
    w.add({ id: 'east', footprint: rectFootprint(5.2, 0, 10, 10), height: 5 });
    const { dog, everInside } = run(w, 0, 8, 0, 0, -1); // run north into the gap
    expect(everInside).toBe(false);
    expect(dog.position.z).toBeGreaterThan(5); // stopped at the entrance
  });

  it('slides out of a concave corner instead of sticking', () => {
    const w = new CollisionWorld();
    w.add({ id: 'L', footprint: L, height: 5 });
    // Run diagonally into the reflex corner at (5, 5) from the north-east...
    const { dog, everInside } = run(w, 8, 8, 0, -0.7071, -0.7071);
    expect(everInside).toBe(false);
    // ...then turn away (north) and make sure the dog actually moves.
    const before = { ...dog.position };
    const intent: DogIntent = { moveX: 0, moveZ: 1, pace: 'trot', sniff: false, jump: false, sit: false, playBow: false };
    for (let i = 0; i < 120; i++) dog.step(1 / 60, intent);
    expect(Math.hypot(dog.position.x - before.x, dog.position.z - before.z)).toBeGreaterThan(2);
  });
});
