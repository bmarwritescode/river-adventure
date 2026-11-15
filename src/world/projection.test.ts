import { describe, expect, it } from 'vitest';
import { MAP_ORIGIN } from './geo';
import { latLonToUtm, latLonToWorld, worldToLatLon } from './projection';

// Reference values computed with pyproj (EPSG:4326 -> EPSG:32614) by the map pipeline.
const CM = 0.01;

describe('projection (UTM 14N, origin = E 45th St & Duval St)', () => {
  it('maps the origin to (0, 0)', () => {
    const p = latLonToWorld(MAP_ORIGIN.lat, MAP_ORIGIN.lon);
    expect(Math.abs(p.x)).toBeLessThan(CM);
    expect(Math.abs(p.z)).toBeLessThan(CM);
  });

  it("matches pyproj's UTM coordinates for the origin", () => {
    const u = latLonToUtm(MAP_ORIGIN.lat, MAP_ORIGIN.lon);
    expect(u.easting).toBeCloseTo(622633.2877876798, 2);
    expect(u.northing).toBeCloseTo(3353493.2560301563, 2);
  });

  it.each([
    // [name, lat, lon, expected x, expected z] (x east, z south)
    ['38th St & Guadalupe St (OSM node)', 30.302745, -97.7381519, -1297.2105, 486.2995],
    ['a point ~3.5 km north-east', 30.33, -97.7, 2337.0842, -2575.6985],
  ])('maps %s to the expected meters', (_name, lat, lon, x, z) => {
    const p = latLonToWorld(lat, lon);
    expect(Math.abs(p.x - x)).toBeLessThan(CM);
    expect(Math.abs(p.z - z)).toBeLessThan(CM);
  });

  it('follows the axis convention: north is -z, east is +x', () => {
    const north = latLonToWorld(MAP_ORIGIN.lat + 0.001, MAP_ORIGIN.lon);
    const east = latLonToWorld(MAP_ORIGIN.lat, MAP_ORIGIN.lon + 0.001);
    expect(north.z).toBeLessThan(-100);
    expect(east.x).toBeGreaterThan(90);
  });

  it('round-trips world -> lat/lon -> world to < 1 cm across the play area', () => {
    for (let x = -2000; x <= 2000; x += 500) {
      for (let z = -2500; z <= 2500; z += 500) {
        const ll = worldToLatLon(x, z);
        const back = latLonToWorld(ll.lat, ll.lon);
        expect(Math.hypot(back.x - x, back.z - z)).toBeLessThan(CM);
      }
    }
  });
});
