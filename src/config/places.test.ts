import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../core/math';
import { closestPointOnPolygon, pointInPolygon } from '../world/geometry2d';
import type { MapIndex } from '../world/map/types';
import mapIndex from '../../public/map/index.json';
import { PLACES, SPAWN_PLACE_ID, TEST_TRIGGER_ZONES, findPlace } from './places';

// The playable boundary written by the map pipeline (near curb of the boundary streets).
const index = mapIndex as unknown as MapIndex;
const boundary: Vec2[] = [];
for (let k = 0; k < index.boundary.length; k += 2) boundary.push({ x: index.boundary[k]!, z: index.boundary[k + 1]! });

/** Must be clear of the invisible boundary wall by more than the dog's radius. */
const MIN_CLEARANCE_M = 2;

const clearance = (x: number, z: number): number => {
  const d = Math.sqrt(closestPointOnPolygon(x, z, boundary).distSq);
  return pointInPolygon(x, z, boundary) ? d : -d;
};

describe('places (spawn, teleports, test zones) are inside the playable area', () => {
  it('has a valid spawn place', () => {
    expect(findPlace(SPAWN_PLACE_ID)).toBeDefined();
  });

  it('has unique place ids', () => {
    expect(new Set(PLACES.map((p) => p.id)).size).toBe(PLACES.length);
  });

  it.each(PLACES.map((p) => [p.id, p] as const))('%s is inside the boundary', (_id, p) => {
    expect(clearance(p.x, p.z)).toBeGreaterThan(MIN_CLEARANCE_M);
  });

  it.each(TEST_TRIGGER_ZONES.map((z) => [z.id, z] as const))('zone %s is inside the boundary', (_id, zone) => {
    const s = zone.shape;
    const pts = s.kind === 'circle' ? [{ x: s.x, z: s.z }] : s.points;
    for (const p of pts) expect(clearance(p.x, p.z)).toBeGreaterThan(0);
  });
});
