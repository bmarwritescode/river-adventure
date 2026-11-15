/** Shapes of the map pipeline's output files (public/map). Keep in sync with tools/map/tiles.py. */

/** Flat coordinate list [x0, z0, x1, z1, ...] in world meters. */
export type FlatCoords = number[];
/** Polygon: outer ring first (CCW in x/z math orientation), then holes. Rings are not closed. */
export type FlatPolygon = FlatCoords[];

export interface TileBuilding {
  r: FlatPolygon;
  /** Height above ground, meters. */
  h: number;
  /** OSM building type when not plain 'yes'. */
  t?: string;
  n?: string;
  a?: string;
}

export interface TileStreet {
  n: string;
  /** OSM highway class. */
  c: string;
  /** Paved width, meters. */
  w: number;
  p: FlatCoords;
}

export const AREA_KINDS = ['grass', 'wood', 'pitch', 'parking', 'water', 'sidewalk', 'road', 'rail'] as const;
export type AreaKind = (typeof AREA_KINDS)[number];

export interface TileData {
  v: number;
  i: number;
  j: number;
  buildings: TileBuilding[];
  areas: Partial<Record<AreaKind, FlatPolygon[]>>;
  streets: TileStreet[];
  trees: FlatCoords;
}

export interface TerrainInfo {
  file: string;
  x0: number;
  z0: number;
  res: number;
  cols: number;
  rows: number;
  scale: number;
  originElevation: number;
  minHeight: number;
  maxHeight: number;
}

export interface MapIndex {
  v: number;
  generated: string;
  osmFetchedAt?: string;
  origin: { lat: number; lon: number; utmEasting: number; utmNorthing: number; epsg: number };
  terrain: TerrainInfo | null;
  tileSize: number;
  tileRange: { i0: number; j0: number; i1: number; j1: number };
  boundary: FlatCoords;
  margin: FlatCoords;
  tiles: { i: number; j: number; bytes: number }[];
  attribution: string;
}

export const MAP_DATA_VERSION = 1;

export function tileKey(i: number, j: number): string {
  return `${i}_${j}`;
}
