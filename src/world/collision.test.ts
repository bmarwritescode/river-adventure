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

describe('jumping over and onto obstacles', () => {
  const fence = (w: CollisionWorld): void =>
    w.add({ id: 'fence', footprint: rectFootprint(0, -6, 12, 0.24), height: 0, solidTop: 1.2 }); // E-W fence at z = -6
  const steps = (w: CollisionWorld, jumpAt: number | null, frames = 150) => {
    const dog = new DogController(MAIN_DOG, w);
    dog.teleport(0, 0, 0); // facing north (−z), toward the fence
    let maxY = 0, insideBelowTop = false;
    for (let i = 0; i < frames; i++) {
      const jump = jumpAt !== null && i === jumpAt;
      dog.step(1 / 60, { moveX: 0, moveZ: -1, pace: 'run', sniff: false, jump, sit: false, playBow: false });
      maxY = Math.max(maxY, dog.position.y);
      if (w.overlapsCircle(dog.position.x, dog.position.z, MAIN_DOG.collisionRadius, 0.02, dog.position.y)) insideBelowTop = true;
    }
    return { dog, maxY, insideBelowTop };
  };

  it('obstacles below the feet do not block; supportHeight finds walkable tops within a step', () => {
    const w = new CollisionWorld();
    fence(w);
    expect(w.resolveCircle(0, -6, 0.28, 0).collided).toBe(true);
    expect(w.resolveCircle(0, -6, 0.28, 1.3).collided).toBe(false); // feet above the fence top
    w.add({ id: 'hood', footprint: rectFootprint(0, 5, 2, 4), height: 0, solidTop: 0.9, walkable: true });
    expect(w.supportHeight(0, 5, 0.85)).toBeCloseTo(0.9);
    expect(w.supportHeight(0, 5, 0)).toBe(-Infinity); // too high to step onto from the ground
    expect(w.supportHeight(0, 0, 0.9)).toBe(-Infinity); // not over it
  });

  it('the dog is stopped by a fence on the ground, but clears it with a jump', () => {
    const w = new CollisionWorld();
    fence(w);
    const blocked = steps(w, null);
    expect(blocked.dog.position.z).toBeGreaterThan(-6);
    const jumped = steps(w, 30); // jump ~1.5 m before the fence at running speed
    expect(jumped.dog.position.z).toBeLessThan(-7);
    expect(jumped.insideBelowTop).toBe(false);
  });

  it('jumps onto a car hood, stands on it, and drops off the far side', () => {
    const w = new CollisionWorld();
    w.add({ id: 'car', footprint: rectFootprint(0, -9, 3, 6), height: 0, solidTop: 0.9, walkable: true }); // z -12..-6
    const dog = new DogController(MAIN_DOG, w);
    dog.teleport(0, 0, 0);
    const go = (frames: number, jumpAt = -1, pace: 'walk' | 'run' = 'run'): void => {
      for (let i = 0; i < frames; i++) dog.step(1 / 60, { moveX: 0, moveZ: -1, pace, sniff: false, jump: i === jumpAt, sit: false, playBow: false });
    };
    while (dog.position.z > -3.2) go(1); // run up...
    go(1, 0); // ...and jump at the car (~2.8 m out)
    let onTop = false;
    for (let i = 0; i < 60 && !onTop; i++) {
      go(1);
      if (dog.grounded && dog.position.z < -6.2 && dog.position.z > -11.8) onTop = Math.abs(dog.position.y - 0.9) < 1e-6;
    }
    expect(onTop).toBe(true);
    go(120, -1, 'walk'); // keep going: off the far end
    expect(dog.position.z).toBeLessThan(-12);
    expect(dog.position.y).toBeCloseTo(0);
    expect(dog.grounded).toBe(true);
  });
});
