"""Offline map pipeline entry point:  npm run map:build [-- options]

Options:
  --refresh          re-download OSM data (otherwise uses tools/map/cache/)
  --regen-boundary   re-derive tools/map/boundary.geojson from the street centerlines
  --regen-origin     re-pin the map origin from the current OSM data (moves every world coordinate!)

Step 2A outputs: src/world/mapOrigin.json, tools/map/boundary.geojson, tools/map/out/preview.png
"""

from __future__ import annotations

import argparse
import time
from collections import Counter

from shapely.geometry import LineString, Point, Polygon
from shapely.prepared import prep

import config
from boundary import load_or_create_boundary, load_or_create_origin
from osm_fetch import fetch_osm
from osm_parse import OsmData
from preview import render_preview
from projection import Projector

CAR_ROADS = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary",
    "secondary_link", "tertiary", "tertiary_link", "residential", "unclassified", "living_street", "service",
}
PATHS = {"footway", "path", "pedestrian", "steps", "cycleway", "track", "bridleway"}
GREEN = {("leisure", "park"), ("leisure", "golf_course"), ("leisure", "pitch"), ("leisure", "playground"),
         ("leisure", "garden"), ("landuse", "grass"), ("landuse", "recreation_ground"), ("natural", "wood"),
         ("natural", "scrub"), ("natural", "grassland"), ("landuse", "meadow"), ("landuse", "forest"),
         ("landuse", "cemetery")}


def compute_stats(osm: OsmData, boundary: Polygon) -> dict[str, str]:
    inside = prep(boundary)
    area = prep(boundary.buffer(config.MARGIN_M, join_style="mitre"))

    def hits(geom) -> tuple[bool, bool]:
        return area.intersects(geom), inside.intersects(geom)

    c: Counter = Counter()
    road_km = Counter()
    road_classes = Counter()
    named = set()
    for w in osm.ways.values():
        t = w.tags
        if len(w.coords) < 2:
            continue
        hw = t.get("highway")
        if "building" in t and w.closed:
            poly = Polygon(w.coords)
            if poly.is_valid:
                a, i = hits(poly)
                if a:
                    c["buildings (+margin)"] += 1
                    if i:
                        c["buildings (inside boundary)"] += 1
                    if "height" in t or "building:levels" in t:
                        c["buildings with height/levels tag"] += 1
                    if "name" in t or "addr:housenumber" in t:
                        c["buildings with name/address"] += 1
            continue
        geom = LineString(w.coords)
        if hw in CAR_ROADS:
            a, i = hits(geom)
            if a:
                c["road segments (ways, +margin)"] += 1
                road_classes[hw] += 1
                g = geom.intersection(boundary)
                road_km["roads"] += g.length / 1000
                if t.get("name") and i:
                    named.add(t["name"])
        elif hw in PATHS:
            if hits(geom)[0]:
                kind = "sidewalks" if t.get("footway") == "sidewalk" else "other footpaths/cycleways"
                c[kind] += 1
                road_km[kind] += geom.intersection(boundary).length / 1000
        elif "railway" in t and hits(geom)[0]:
            c["railway ways"] += 1
        elif w.closed and len(w.coords) >= 4:
            poly = Polygon(w.coords)
            if not poly.is_valid or not hits(poly)[0]:
                continue
            if t.get("amenity") == "parking":
                c["parking lots"] += 1
            elif any((k, t.get(k)) in GREEN for k in ("leisure", "landuse", "natural")):
                c["green areas"] += 1
            elif t.get("natural") == "water" or "water" in t or t.get("leisure") == "swimming_pool":
                c["water polygons (incl. pools)"] += 1
        if "waterway" in t and hits(geom)[0]:
            c["waterways (creeks)"] += 1
    c["building multipolygon relations"] = sum(
        1 for r in osm.relations.values() if "building" in r.tags)
    c["trees (points)"] = sum(
        1 for nid, t in osm.node_tags.items() if t.get("natural") == "tree" and area.contains(Point(osm.node_xz[nid])))

    out = {k: str(v) for k, v in sorted(c.items())}
    out["road length inside boundary"] = f"{road_km['roads']:.1f} km"
    out["sidewalk length inside boundary"] = f"{road_km['sidewalks']:.1f} km"
    out["road classes"] = ", ".join(f"{k} {v}" for k, v in road_classes.most_common())
    out["named streets inside"] = str(len(named))
    out["boundary area"] = f"{boundary.area / 1e6:.2f} km² ({boundary.area / 2.59e6:.2f} sq mi)"
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--regen-boundary", action="store_true")
    ap.add_argument("--regen-origin", action="store_true")
    args = ap.parse_args()
    t0 = time.time()

    osm = OsmData(fetch_osm(refresh=args.refresh))
    origin = load_or_create_origin(osm, regen=args.regen_origin)
    proj = Projector(origin)
    osm.project(proj)

    b = load_or_create_boundary(osm, proj, regen=args.regen_boundary)
    stats = compute_stats(osm, b.polygon)
    for k, v in stats.items():
        print(f"  {k:36s} {v}")
    print("[boundary] decisions:")
    for n in dict.fromkeys(b.decisions):
        print(f"  - {n}")

    render_preview(osm, b, config.OUT_DIR / "preview.png", stats)
    print(f"[done] {time.time() - t0:.1f} s")


if __name__ == "__main__":
    main()
