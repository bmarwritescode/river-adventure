/**
 * Geographic reference for the world coordinate system.
 *
 * World: 1 unit = 1 m, +Y up, +X east, -Z north (+Z south).
 * Real-world lat/lon is projected with UTM zone 14N (EPSG:32614) and offset so
 * that MAP_ORIGIN lands at world (0, 0, 0).
 *
 * MAP_ORIGIN is the intersection of E 45th St and Duval St, Austin TX.
 * PLACEHOLDER: approximate. Step 2 replaces it with the exact OSM node position.
 */
export const MAP_ORIGIN = {
  lat: 30.3059,
  lon: -97.7262,
  /** Filled in by Step 2 (UTM easting/northing of the origin, meters). */
  utmEasting: undefined as number | undefined,
  utmNorthing: undefined as number | undefined,
} as const;

export const MAP_PROJECTION = 'EPSG:32614' as const;

/** Convert UTM meters (relative to MAP_ORIGIN) to world XZ. */
export function utmOffsetToWorld(dEast: number, dNorth: number): { x: number; z: number } {
  return { x: dEast, z: -dNorth };
}
