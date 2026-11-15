/**
 * The ONE place ground height is queried. Everything (dog, camera, placement of
 * props, trigger visuals) must call this — never assume y = 0.
 *
 * Step 1: flat ground. Later: sample a terrain heightmap (bilinear) per tile.
 */
export function getGroundHeight(_x: number, _z: number): number {
  return 0;
}
