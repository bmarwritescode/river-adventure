"""Split layers into a fixed world-space tile grid and write compact JSON data files.

Tile (i, j) covers x in [i*S, (i+1)*S), z in [j*S, (j+1)*S), S = TILE_SIZE.
Files: public/map/tiles/{i}_{j}.json + public/map/index.json. Data, not meshes: the game builds
meshes at load time. Coordinates are rounded to 1 cm and stored as flat [x0, z0, x1, z1, ...] arrays.

Assignment rules:
  buildings  whole, to the tile containing their representative point (never split -> exact collision)
  areas      clipped to the tile square (merged per kind, no overlap between tiles)
  streets    clipped to the tile square (names kept)
  trees      by position
"""

from __future__ import annotations

import gzip
import json
import math
import shutil
from collections import defaultdict
from pathlib import Path

from shapely.geometry import LineString, MultiLineString, Polygon, box
from shapely.geometry.polygon import orient

from layers import Layers, polygons_of

TILE_SIZE = 250.0
DATA_VERSION = 1


def _flat(coords) -> list[float]:
    out: list[float] = []
    for x, z in list(coords)[:-1] if _is_ring(coords) else coords:
        out.append(round(x, 2))
        out.append(round(z, 2))
    return out


def _is_ring(coords) -> bool:
    c = list(coords)
    return len(c) > 1 and c[0] == c[-1]


def _poly_rings(p: Polygon) -> list[list[float]]:
    # Consistent winding: exterior counter-clockwise in (x, z) math orientation, holes clockwise.
    p = orient(p, sign=1.0)
    return [_flat(p.exterior.coords)] + [_flat(r.coords) for r in p.interiors]


def _lines(geom) -> list[LineString]:
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, LineString)]


def tile_index(x: float, z: float) -> tuple[int, int]:
    return math.floor(x / TILE_SIZE), math.floor(z / TILE_SIZE)


def tile_range(bounds) -> tuple[int, int, int, int]:
    minx, minz, maxx, maxz = bounds
    i0, j0 = tile_index(minx, minz)
    i1, j1 = tile_index(maxx, maxz)
    return i0, j0, i1, j1


def write_tiles(layers: Layers, boundary: Polygon, area: Polygon, out_dir: Path, meta: dict) -> dict:
    """Write tiles + index. Returns the index dict (also written to out_dir/index.json)."""
    tiles_dir = out_dir / "tiles"
    if tiles_dir.exists():
        shutil.rmtree(tiles_dir)
    tiles_dir.mkdir(parents=True)

    i0, j0, i1, j1 = tile_range(area.bounds)
    tiles: dict[tuple[int, int], dict] = defaultdict(lambda: {"buildings": [], "areas": {}, "streets": [], "trees": []})

    for b in layers.buildings:
        rp = b.poly.representative_point()
        rec = {"r": _poly_rings(b.poly), "h": b.height}
        if b.kind != "yes":
            rec["t"] = b.kind
        if b.name:
            rec["n"] = b.name
        if b.address:
            rec["a"] = b.address
        tiles[tile_index(rp.x, rp.y)]["buildings"].append(rec)

    for t in layers.trees:
        tiles[tile_index(t.x, t.y)]["trees"].extend([round(t.x, 2), round(t.y, 2)])

    for i in range(i0, i1 + 1):
        for j in range(j0, j1 + 1):
            sq = box(i * TILE_SIZE, j * TILE_SIZE, (i + 1) * TILE_SIZE, (j + 1) * TILE_SIZE)
            if not sq.intersects(area):
                continue
            tile = tiles[(i, j)]
            for kind, geom in layers.areas.items():
                if geom.is_empty or not geom.intersects(sq):
                    continue
                polys = [p for p in polygons_of(geom.intersection(sq)) if p.area > 0.5]
                if polys:
                    tile["areas"][kind] = [_poly_rings(p) for p in polys]
            for s in layers.streets:
                if not s.line.intersects(sq):
                    continue
                for part in _lines(s.line.intersection(sq)):
                    if part.length >= 1.0:
                        tile["streets"].append({"n": s.name, "c": s.cls, "w": s.width, "p": _flat(part.coords)})

    index_tiles = []
    total_raw = total_gz = 0
    for (i, j), tile in sorted(tiles.items()):
        payload = {"v": DATA_VERSION, "i": i, "j": j, **tile}
        data = json.dumps(payload, separators=(",", ":")).encode()
        (tiles_dir / f"{i}_{j}.json").write_bytes(data)
        gz = len(gzip.compress(data, 9))
        total_raw += len(data)
        total_gz += gz
        index_tiles.append({
            "i": i, "j": j, "bytes": len(data),
            "counts": {"buildings": len(tile["buildings"]), "streets": len(tile["streets"]),
                       "trees": len(tile["trees"]) // 2, "areas": {k: len(v) for k, v in tile["areas"].items()}},
        })

    index = {
        "v": DATA_VERSION,
        **meta,
        "tileSize": TILE_SIZE,
        "tileRange": {"i0": i0, "j0": j0, "i1": i1, "j1": j1},
        "boundary": _flat(orient(boundary, 1.0).exterior.coords),
        "margin": _flat(orient(area, 1.0).exterior.coords),
        "tiles": index_tiles,
        "attribution": "© OpenStreetMap contributors",
    }
    (out_dir / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    index["_sizes"] = {"tilesRaw": total_raw, "tilesGzip": total_gz}
    return index
