import type { TriggerZoneDef } from '../world/triggers';

/**
 * Named spots in world coordinates (meters; +x east, +z south; origin = E 45th St & Duval St).
 * Add a spot by walking there and pressing P, then paste the snippet here.
 * These feed the teleport dropdown in the tuning panel and the `?at=<id>` URL parameter.
 *
 * Intersection coordinates come from the OSM nodes shared by both streets. Spots that sit on the
 * play-area boundary (which runs along street centerlines) are nudged ~10–15 m inside it.
 */
export interface Place {
  id: string;
  label: string;
  x: number;
  z: number;
  /** Facing direction, radians (0 = north, +π/2 = west). Optional. */
  heading?: number;
}

export const PLACES: Place[] = [
  { id: 'origin', label: 'Origin: 45th & Duval', x: 0, z: 0, heading: -0.35 },
  // Boundary corners (15 m inside the corner)
  { id: 'nw-corner', label: 'NW corner: Guadalupe & Koenig/56th', x: 55.5, z: -1820.1 },
  { id: 'ne-corner', label: 'NE corner: 56th & Airport', x: 1077.1, z: -1232.4 },
  { id: 'se-corner', label: 'SE corner: 38th & I-35', x: 432.1, z: 1412.0 },
  { id: 'sw-corner', label: 'SW corner: 38th & Guadalupe', x: -1283.7, z: 479.7 },
  // Intersections
  { id: '45th-guadalupe', label: '45th & Guadalupe', x: -799, z: -420 },
  { id: '45th-speedway', label: '45th & Speedway', x: -367.4, z: -179.3 },
  { id: '43rd-avenue-h', label: '43rd & Avenue H', x: -229.3, z: 216.4 },
  { id: '51st-duval', label: '51st & Duval', x: 441.3, z: -807.2 },
  { id: '45th-red-river', label: '45th & Red River', x: 483.2, z: 235.9 },
  { id: '41st-red-river', label: '41st & Red River', x: 222.1, z: 805.2 },
  { id: '38th-duval', label: '38th & Duval', x: -490.7, z: 922.2 },
  { id: '45th-airport', label: '45th & Airport', x: 823, z: 366 },
  // Parks
  { id: 'shipe-park', label: 'Shipe Park', x: -262, z: -46 },
];

/** Where the dog starts (an id from PLACES). On the street at the origin intersection. */
export const SPAWN_PLACE_ID = 'origin';

export function findPlace(id: string): Place | undefined {
  return PLACES.find((p) => p.id === id);
}

/**
 * Trigger zones on the real map (debug/test only for now; hunt clues come in Step 8).
 * The dog spawns inside 'duval-45th', so an enter event fires right away.
 */
export const TEST_TRIGGER_ZONES: TriggerZoneDef[] = [
  { id: 'duval-45th', label: '45th & Duval', shape: { kind: 'circle', x: 0, z: 0, radius: 12 }, tags: ['test'] },
  {
    id: 'shipe-park',
    label: 'Shipe Park',
    shape: {
      kind: 'polygon',
      points: [
        { x: -336.6, z: -11.9 }, { x: -286.9, z: 17.1 }, { x: -255.2, z: 32.8 }, { x: -225.0, z: -20.1 },
        { x: -194.2, z: -78.6 }, { x: -224.4, z: -93.1 }, { x: -276.6, z: -122.1 },
      ],
    },
    tags: ['test'],
  },
  { id: 'sparky-park', label: 'Sparky Pocket Park', shape: { kind: 'circle', x: -721, z: 884, radius: 25 }, tags: ['test'] },
];
