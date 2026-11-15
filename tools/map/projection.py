"""WGS84 lat/lon <-> game world meters.

Contract (see CLAUDE.md): UTM zone 14N (EPSG:32614), offset so the map origin
(E 45th St & Duval St) is (0, 0).  x = easting - E0,  z = -(northing - N0).
"""

from __future__ import annotations

from dataclasses import dataclass

from pyproj import Transformer

_TO_UTM = Transformer.from_crs("EPSG:4326", "EPSG:32614", always_xy=True)
_FROM_UTM = Transformer.from_crs("EPSG:32614", "EPSG:4326", always_xy=True)


@dataclass(frozen=True)
class Origin:
    lat: float
    lon: float

    @property
    def utm(self) -> tuple[float, float]:
        return _TO_UTM.transform(self.lon, self.lat)


class Projector:
    def __init__(self, origin: Origin):
        self.origin = origin
        self.e0, self.n0 = origin.utm

    def to_world(self, lat: float, lon: float) -> tuple[float, float]:
        e, n = _TO_UTM.transform(lon, lat)
        return e - self.e0, -(n - self.n0)

    def to_world_many(self, lats, lons):
        es, ns = _TO_UTM.transform(lons, lats)
        return [(e - self.e0, -(n - self.n0)) for e, n in zip(es, ns)]

    def to_latlon(self, x: float, z: float) -> tuple[float, float]:
        lon, lat = _FROM_UTM.transform(x + self.e0, -z + self.n0)
        return lat, lon
