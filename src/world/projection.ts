import { MAP_ORIGIN } from './geo';

/**
 * WGS84 lat/lon <-> UTM zone 14N (EPSG:32614) <-> world XZ, in TypeScript.
 * Same math as the pipeline's pyproj (Krüger series, accurate to well under 1 cm here),
 * so gameplay places can be authored as lat/lon (e.g. copied from a web map) if wanted.
 */
const A_AXIS = 6378137;
const FLATTENING = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING = 500000;
const ZONE = 14;
const LON0 = ((ZONE - 1) * 6 - 180 + 3) * (Math.PI / 180); // central meridian -99°

const n = FLATTENING / (2 - FLATTENING);
const n2 = n * n, n3 = n2 * n, n4 = n3 * n;
const A = (A_AXIS / (1 + n)) * (1 + n2 / 4 + n4 / 64);
const ALPHA = [n / 2 - (2 / 3) * n2 + (5 / 16) * n3, (13 / 48) * n2 - (3 / 5) * n3, (61 / 240) * n3];
const BETA = [n / 2 - (2 / 3) * n2 + (37 / 96) * n3, (1 / 48) * n2 + (1 / 15) * n3, (17 / 480) * n3];
const DELTA = [2 * n - (2 / 3) * n2 - 2 * n3, (7 / 3) * n2 - (8 / 5) * n3, (56 / 15) * n3];
const TWO_SQRT_N = (2 * Math.sqrt(n)) / (1 + n);

export function latLonToUtm(lat: number, lon: number): { easting: number; northing: number } {
  const phi = (lat * Math.PI) / 180;
  const dLon = (lon * Math.PI) / 180 - LON0;
  const sinPhi = Math.sin(phi);
  const t = Math.sinh(Math.atanh(sinPhi) - TWO_SQRT_N * Math.atanh(TWO_SQRT_N * sinPhi));
  const xiP = Math.atan2(t, Math.cos(dLon));
  const etaP = Math.atanh(Math.sin(dLon) / Math.sqrt(1 + t * t));
  let e = etaP, nn = xiP;
  for (let j = 1; j <= 3; j++) {
    const a = ALPHA[j - 1]!;
    e += a * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
    nn += a * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
  }
  return { easting: FALSE_EASTING + K0 * A * e, northing: K0 * A * nn };
}

export function utmToLatLon(easting: number, northing: number): { lat: number; lon: number } {
  const xi = northing / (K0 * A);
  const eta = (easting - FALSE_EASTING) / (K0 * A);
  let xiP = xi, etaP = eta;
  for (let j = 1; j <= 3; j++) {
    const b = BETA[j - 1]!;
    xiP -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += DELTA[j - 1]! * Math.sin(2 * j * chi);
  const lon = LON0 + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  return { lat: (phi * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}

/** lat/lon -> world (x east, z south), relative to MAP_ORIGIN. */
export function latLonToWorld(lat: number, lon: number): { x: number; z: number } {
  const { easting, northing } = latLonToUtm(lat, lon);
  return { x: easting - MAP_ORIGIN.utmEasting, z: -(northing - MAP_ORIGIN.utmNorthing) };
}

export function worldToLatLon(x: number, z: number): { lat: number; lon: number } {
  return utmToLatLon(x + MAP_ORIGIN.utmEasting, -z + MAP_ORIGIN.utmNorthing);
}
