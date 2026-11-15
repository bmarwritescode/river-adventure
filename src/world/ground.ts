import type { Heightmap } from './terrain';

/**
 * The ONE place ground height is queried. Everything (dog, camera, placement of
 * props, trigger visuals) must call this — never assume y = 0.
 *
 * Samples the USGS terrain heightmap (bilinear, meters relative to the origin) once
 * the map has loaded it; flat (0) before that or if the map was built without terrain.
 */
let terrain: Heightmap | null = null;

export function setTerrain(h: Heightmap | null): void {
  terrain = h;
}

export function getTerrain(): Heightmap | null {
  return terrain;
}

export function getGroundHeight(x: number, z: number): number {
  return terrain ? terrain.sample(x, z) : 0;
}
