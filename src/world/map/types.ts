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
  /** OSM way/relation id (for overrides and debugging). */
  id?: number;
  /** Present when the building is inside the dressed area: full house/shop instead of a gray box. */
  d?: BuildingDress;
}

export type DressKind = 'house' | 'garage' | 'shop' | 'apts';
export type RoofKind = 'hip' | 'gable' | 'flat';

/** Layout decisions made offline (tools/map/dress.py); the game decides how they look. */
export interface BuildingDress {
  k: DressKind;
  /** Stable per-building seed for colors and small variations. */
  seed: number;
  roof?: RoofKind;
  /** Front direction (unit vector toward the street it faces). */
  f?: [number, number];
  /** Front door position on the front wall. */
  door?: [number, number];
  /** Porch [width, depth], centred on the door, outside the footprint. */
  porch?: [number, number];
  /** Pier-and-beam (raised floor with skirting). */
  pier?: 0 | 1;
  /** Shop-front sign text. */
  sign?: string;
  /** Hand-made landmark (tools/map/landmarks.py): the game builds this building with its own model. */
  lm?: LandmarkInfo;
  /** Hand overrides (CSS colors). */
  wall?: string;
  trim?: string;
  roofColor?: string;
  doorColor?: string;
}

/**
 * Frame of a hand-made landmark: origin = the storefront's west corner; a = meters along the
 * storefront (u), b = meters out of the storefront (n = (u[1], -u[0])).
 */
export interface LandmarkInfo {
  id: 'homeslice';
  /** Frame origin (world x, z). */
  o: [number, number];
  /** a axis: unit vector along the storefront. The b axis (out of the storefront) is (u[1], -u[0]). */
  u: [number, number];
  /** Patio depth (m) measured from the west wall to the sidewalk. */
  pw: number;
}

export type FenceKind = 'picket' | 'chain' | 'iron' | 'cedar' | 'wood' | 'hogwire';

export interface TileFence {
  t: FenceKind;
  /** Height, meters. */
  h: number;
  p: FlatCoords;
}

/** Street-name sign: a post with two blades (a along the main street, b along the cross street). */
export interface TileSign {
  x: number;
  z: number;
  a: string;
  /** Blade rotation (rotation.y that lays the blade's local +X along its street). */
  ar: number;
  b: string;
  br: number;
}

export type MarkKind = 'yellow2' | 'white' | 'stop';

export interface TileStreet {
  n: string;
  /** OSM highway class. */
  c: string;
  /** Paved width, meters. */
  w: number;
  p: FlatCoords;
}

/** Paint order (later kinds paint over earlier ones). */
export const AREA_KINDS = ['grass', 'wood', 'pitch', 'turf', 'bed', 'parking', 'patio', 'water', 'driveway', 'walk', 'sidewalk', 'road', 'rail'] as const;
export type AreaKind = (typeof AREA_KINDS)[number];

export interface TileData {
  v: number;
  i: number;
  j: number;
  buildings: TileBuilding[];
  areas: Partial<Record<AreaKind, FlatPolygon[]>>;
  streets: TileStreet[];
  trees: FlatCoords;
  /** Dressing props per kind, flat [x, z, rot, scale, variant, ...] (stride 5). rot = rotation.y. */
  props?: Record<string, number[]>;
  signs?: TileSign[];
  /** Overhead wire spans between utility poles, flat [x0, z0, x1, z1, ...]. */
  wires?: number[];
  /** Lane markings. */
  marks?: { t: MarkKind; p: FlatCoords }[];
  /** Curb polylines. */
  curbs?: FlatCoords[];
  /** Fences (yards, the vet's lot, landmark patios). */
  fences?: TileFence[];
}

export const PROP_STRIDE = 5;

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
  /** Playable area: the dog stays inside this (near curb of the boundary streets). */
  boundary: FlatCoords;
  /** The street-centerline boundary the playable area was derived from (reference only). */
  streetBoundary?: FlatCoords;
  margin: FlatCoords;
  tiles: { i: number; j: number; bytes: number }[];
  attribution: string;
  /** Area with full art dressing (Step 5 test block; Step 7 widens it). */
  dressArea?: FlatCoords;
}

export const MAP_DATA_VERSION = 3;

export function tileKey(i: number, j: number): string {
  return `${i}_${j}`;
}
