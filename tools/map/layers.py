"""Extract game layers from OSM data (world XZ coordinates), cleaned and clipped to the play area.

Layers:
  buildings   polygons (+holes), height, type, name/address
  streets     named road centerlines (name, class, width), for the street readout and future dressing
  areas       merged surface polygons by kind: road, sidewalk, parking, grass, wood, pitch, water, rail
  trees       points
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import shapely
from shapely.prepared import prep
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union

from osm_parse import OsmData, Way, merge_lines

# --- Tunables -----------------------------------------------------------------------------------

# Paved width (m) by highway class when the way has no usable width/lanes tag.
ROAD_WIDTH = {
    "motorway": 11.0, "trunk": 11.0, "primary": 12.0, "secondary": 11.0, "tertiary": 9.0,
    "motorway_link": 6.0, "trunk_link": 6.0, "primary_link": 6.0, "secondary_link": 6.0, "tertiary_link": 6.0,
    "residential": 7.5, "unclassified": 7.0, "living_street": 6.0, "road": 7.0, "service": 4.5,
}
SERVICE_WIDTH = {"alley": 3.5, "driveway": 3.0, "parking_aisle": 5.0, "drive-through": 3.5}
# Measured curb-to-curb widths (aerial imagery) for named streets OSM has no width tag for.
# Duval: ~10 m between 51st and 53rd, cars parked along both curbs.
STREET_WIDTH_BY_NAME = {"Duval Street": 10.0}
# One carriageway of a divided road is narrower than the default (which assumes both directions).
ONEWAY_FACTOR = 0.6
PATH_WIDTH = {"footway": 1.6, "path": 1.5, "cycleway": 1.8, "steps": 1.6, "pedestrian": 4.0, "track": 3.0,
              "bridleway": 2.0}
WATERWAY_WIDTH = {"river": 12.0, "stream": 3.0, "canal": 6.0, "ditch": 1.5, "drain": 1.5}
RAIL_WIDTH = 3.5
RAIL_TYPES = {"rail", "light_rail", "tram", "narrow_gauge", "disused", "abandoned"}

GREEN_KINDS = {
    "grass": {("leisure", "park"), ("leisure", "garden"), ("leisure", "playground"), ("leisure", "golf_course"),
              ("leisure", "dog_park"), ("landuse", "grass"), ("landuse", "recreation_ground"),
              ("landuse", "meadow"), ("landuse", "village_green"), ("landuse", "cemetery"),
              ("natural", "grassland"), ("leisure", "common")},
    "wood": {("natural", "wood"), ("landuse", "forest"), ("natural", "scrub")},
    "pitch": {("leisure", "pitch"), ("leisure", "track")},
}

# Building height defaults (m) when OSM has no height/levels.
LEVEL_HEIGHT = 3.2
ROOF_ALLOWANCE = 1.0
BUILDING_DEFAULT_HEIGHT = {
    "house": 6.0, "detached": 6.0, "residential": 6.5, "semidetached_house": 6.0, "bungalow": 5.0,
    "terrace": 7.0, "duplex": 6.5, "apartments": 10.0, "dormitory": 12.0,
    "garage": 3.0, "garages": 3.0, "shed": 2.5, "carport": 3.0, "roof": 4.0, "hut": 3.0,
    "commercial": 7.0, "retail": 6.5, "office": 9.0, "industrial": 8.0, "warehouse": 8.0, "supermarket": 7.5,
    "school": 8.0, "university": 12.0, "church": 10.0, "hospital": 14.0, "public": 9.0, "civic": 9.0,
    "parking": 10.0, "hotel": 15.0, "fire_station": 7.0,
}

# Geometry cleaning
BUILDING_SIMPLIFY_M = 0.15
BUILDING_MIN_AREA_M2 = 4.0
AREA_SIMPLIFY_M = 0.25
AREA_MIN_PART_M2 = 2.0
BUFFER_QUAD_SEGS = 3  # segments per quarter circle when buffering lines (fewer = fewer triangles)


# --- Data classes -------------------------------------------------------------------------------

@dataclass
class Building:
    poly: Polygon
    height: float
    kind: str
    height_source: str  # 'height' | 'levels' | 'default'
    name: str | None = None
    address: str | None = None
    osm_id: int = 0
    tags: dict = field(default_factory=dict)


@dataclass
class Street:
    line: LineString
    name: str
    cls: str
    width: float


@dataclass
class Layers:
    buildings: list[Building] = field(default_factory=list)
    streets: list[Street] = field(default_factory=list)
    areas: dict[str, object] = field(default_factory=dict)  # kind -> (Multi)Polygon
    trees: list[Point] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


# --- Helpers ------------------------------------------------------------------------------------

_NUM = re.compile(r"^\s*([0-9]+(?:\.[0-9]+)?)\s*(m|meters?|ft|feet|')?\s*$", re.I)


def parse_length(v: str | None) -> float | None:
    """'12', '12 m', '40 ft', "40'" -> meters."""
    if not v:
        return None
    m = _NUM.match(v.split(";")[0])
    if not m:
        return None
    x = float(m.group(1))
    unit = (m.group(2) or "").lower()
    return x * 0.3048 if unit in ("ft", "feet", "'") else x


def polygons_of(geom) -> list[Polygon]:
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def clean_polygon(geom, simplify: float, min_area: float) -> list[Polygon]:
    """make_valid + simplify + drop slivers; returns valid polygons."""
    if geom is None or geom.is_empty:
        return []
    if not geom.is_valid:
        geom = shapely.make_valid(geom)
    out = []
    for p in polygons_of(geom):
        p = p.simplify(simplify, preserve_topology=True)
        if not p.is_valid:
            p = shapely.make_valid(p)
        for q in polygons_of(p):
            if q.area >= min_area:
                # drop tiny holes too
                holes = [h for h in q.interiors if Polygon(h).area >= min_area]
                out.append(Polygon(q.exterior, holes))
    return out


def way_polygon(w: Way) -> Polygon | None:
    if not w.closed or len(w.coords) < 4:
        return None
    return Polygon(w.coords)


def relation_polygon(osm: OsmData, rel) -> object | None:
    """Assemble a multipolygon relation (outer/inner member ways) into a shapely geometry."""
    outer, inner = [], []
    for m in rel.members:
        if m.get("type") != "way":
            continue
        w = osm.ways.get(m["ref"])
        if not w or len(w.coords) < 2:
            continue
        (inner if m.get("role") == "inner" else outer).append(LineString(w.coords))
    if not outer:
        return None
    outer_polys = list(polygonize(merge_lines(outer)))
    if not outer_polys:
        return None
    geom = unary_union(outer_polys)
    if inner:
        inner_polys = list(polygonize(merge_lines(inner)))
        if inner_polys:
            geom = geom.difference(unary_union(inner_polys))
    return geom


def tagged_polygons(osm: OsmData, pred) -> list[tuple[dict, object]]:
    """(tags, geometry) for closed ways and multipolygon relations whose tags satisfy pred.
    The returned tags are a copy with the element's OSM id under "_id"."""
    out = []
    member_of_mp: set[int] = set()
    for rel in osm.relations.values():
        if rel.tags.get("type") == "multipolygon" and pred(rel.tags):
            g = relation_polygon(osm, rel)
            if g is not None:
                out.append(({**rel.tags, "_id": rel.id}, g))
                member_of_mp.update(m["ref"] for m in rel.members if m.get("type") == "way")
    for w in osm.ways.values():
        if w.id in member_of_mp or not pred(w.tags):
            continue
        p = way_polygon(w)
        if p is not None:
            out.append(({**w.tags, "_id": w.id}, p))
    return out


# --- Extraction ---------------------------------------------------------------------------------

def building_height(tags: dict, area_m2: float) -> tuple[float, str]:
    h = parse_length(tags.get("height"))
    if h and 1.5 <= h <= 200:
        return h, "height"
    lv = parse_length(tags.get("building:levels"))
    if lv and 0 < lv < 60:
        return lv * LEVEL_HEIGHT + ROOF_ALLOWANCE, "levels"
    kind = tags.get("building", "yes")
    if kind in BUILDING_DEFAULT_HEIGHT:
        return BUILDING_DEFAULT_HEIGHT[kind], "default"
    # Generic 'yes': guess from footprint size.
    if area_m2 < 40:
        return 3.0, "default"
    if area_m2 < 400:
        return 6.0, "default"
    return 8.0, "default"


def road_width(tags: dict) -> float:
    hw = tags["highway"]
    if hw == "service":
        base = SERVICE_WIDTH.get(tags.get("service", ""), ROAD_WIDTH["service"])
    else:
        base = ROAD_WIDTH.get(hw, 6.0)
    oneway = tags.get("oneway") in ("yes", "1", "-1") and hw in (
        "motorway", "trunk", "primary", "secondary", "tertiary")
    if oneway:
        base *= ONEWAY_FACTOR
    w = parse_length(tags.get("width"))
    if w and 2.0 <= w <= 40.0:
        return w
    if hw != "service" and tags.get("name") in STREET_WIDTH_BY_NAME:
        return STREET_WIDTH_BY_NAME[tags["name"]]
    lanes = parse_length(tags.get("lanes"))
    if lanes and 1 <= lanes <= 12 and hw != "service":
        return max(base, lanes * 3.3)
    return base


def _buffer_union(items: list[tuple[LineString, float]], clip) -> object:
    bufs = [ln.buffer(w / 2, quad_segs=BUFFER_QUAD_SEGS, cap_style="round", join_style="round")
            for ln, w in items if ln.intersects(clip)]
    if not bufs:
        return Polygon()
    return unary_union(bufs).intersection(clip)


def extract_layers(osm: OsmData, area: Polygon) -> Layers:
    """Extract everything intersecting `area` (boundary + margin)."""
    L = Layers()
    clip = prep(area)

    # Buildings (ways + multipolygon relations). building:part is ignored (the outline is enough).
    n_invalid = 0
    for tags, geom in tagged_polygons(osm, lambda t: "building" in t and t.get("building") != "no"):
        if not clip.intersects(geom):
            continue
        if not geom.is_valid:
            n_invalid += 1
        for p in clean_polygon(geom, BUILDING_SIMPLIFY_M, BUILDING_MIN_AREA_M2):
            if not clip.intersects(p):
                continue
            h, src = building_height(tags, p.area)
            addr = " ".join(x for x in (tags.get("addr:housenumber"), tags.get("addr:street")) if x) or None
            L.buildings.append(Building(p, round(h, 2), tags.get("building", "yes"), src, tags.get("name"), addr,
                                        osm_id=int(tags["_id"]), tags=tags))
    L.notes.append(f"{n_invalid} invalid building polygons repaired with make_valid")

    # Roads
    roads: list[tuple[LineString, float]] = []
    paths: list[tuple[LineString, float]] = []
    for w in osm.ways.values():
        t = w.tags
        hw = t.get("highway")
        if not hw or len(w.coords) < 2 or t.get("area") == "yes":
            continue
        line = LineString(w.coords)
        if not clip.intersects(line):
            continue
        if hw in ROAD_WIDTH:
            wd = road_width(t)
            roads.append((line, wd))
            if t.get("name"):
                L.streets.append(Street(line.intersection(area), t["name"], hw, round(wd, 2)))
        elif hw in PATH_WIDTH:
            if t.get("footway") == "crossing" or hw == "footway" and t.get("footway") == "crossing":
                continue  # crosswalks lie on the road surface already
            if t.get("indoor") == "yes" or t.get("level") not in (None, "0"):
                continue
            wd = parse_length(t.get("width"))
            paths.append((line, wd if wd and 0.8 <= wd <= 10 else PATH_WIDTH[hw]))
    L.streets = [s for s in L.streets if not s.line.is_empty]

    areas: dict[str, object] = {}
    areas["road"] = _buffer_union(roads, area)
    areas["sidewalk"] = _buffer_union(paths, area)

    # Parking (surface lots only; garages are buildings)
    parking = [g for t, g in tagged_polygons(osm, lambda t: t.get("amenity") == "parking"
                                             and t.get("parking") not in ("underground", "multi-storey", "rooftop"))]
    areas["parking"] = unary_union([shapely.make_valid(g) for g in parking]).intersection(area) if parking else Polygon()

    # Green
    for kind, pairs in GREEN_KINDS.items():
        def pred(t, pairs=pairs):
            return any((k, t.get(k)) in pairs for k in ("leisure", "landuse", "natural"))
        geoms = [shapely.make_valid(g) for _, g in tagged_polygons(osm, pred)]
        areas[kind] = unary_union(geoms).intersection(area) if geoms else Polygon()

    # Water: polygons + buffered waterway lines (culverts skipped)
    water_polys = [shapely.make_valid(g) for _, g in tagged_polygons(
        osm, lambda t: t.get("natural") == "water" or "water" in t or t.get("leisure") == "swimming_pool"
        or t.get("landuse") in ("reservoir", "basin") or t.get("waterway") == "riverbank")]
    water_lines = []
    for w in osm.ways.values():
        t = w.tags
        ww = t.get("waterway")
        if ww in WATERWAY_WIDTH and len(w.coords) >= 2 and t.get("tunnel") not in ("culvert", "yes"):
            wd = parse_length(t.get("width")) or WATERWAY_WIDTH[ww]
            water_lines.append((LineString(w.coords), wd))
    areas["water"] = unary_union(water_polys + [_buffer_union(water_lines, area)]).intersection(area)

    # Rail
    rails = [(LineString(w.coords), RAIL_WIDTH) for w in osm.ways.values()
             if w.tags.get("railway") in RAIL_TYPES and len(w.coords) >= 2 and w.tags.get("tunnel") != "yes"]
    areas["rail"] = _buffer_union(rails, area)

    # Clean all area layers (merged per kind already)
    for kind, geom in areas.items():
        parts = clean_polygon(geom, AREA_SIMPLIFY_M, AREA_MIN_PART_M2)
        areas[kind] = MultiPolygon(parts) if parts else MultiPolygon()
    L.areas = areas

    # Trees
    for nid, t in osm.node_tags.items():
        if t.get("natural") == "tree" and nid in osm.node_xz:
            p = Point(osm.node_xz[nid])
            if clip.contains(p):
                L.trees.append(p)
    return L
