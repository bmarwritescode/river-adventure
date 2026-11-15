import mapOrigin from './mapOrigin.json';

/**
 * Geographic reference for the world coordinate system.
 *
 * World: 1 unit = 1 m, +Y up, +X east, -Z north (+Z south).
 * Real-world lat/lon is projected with UTM zone 14N (EPSG:32614) and offset so
 * that MAP_ORIGIN lands at world (0, 0, 0):
 *   x = easting - MAP_ORIGIN.utmEasting,  z = -(northing - MAP_ORIGIN.utmNorthing)
 *
 * MAP_ORIGIN = the OSM node at E 45th St & Duval St. The single source of truth
 * is mapOrigin.json, written by the map pipeline (tools/map) and shared with it.
 * Re-pinning it (npm run map:build -- --regen-origin) moves every world coordinate.
 */
export const MAP_ORIGIN = {
  lat: mapOrigin.lat,
  lon: mapOrigin.lon,
  utmEasting: mapOrigin.utmEasting,
  utmNorthing: mapOrigin.utmNorthing,
  osmNodeId: mapOrigin.osmNodeId,
} as const;

export const MAP_PROJECTION = 'EPSG:32614' as const;

/** Convert UTM meters to world XZ. */
export function utmToWorld(easting: number, northing: number): { x: number; z: number } {
  return { x: easting - MAP_ORIGIN.utmEasting, z: -(northing - MAP_ORIGIN.utmNorthing) };
}
