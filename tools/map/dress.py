"""Dressing: decide WHAT goes WHERE in the dressed area (the game decides how it looks).

Inside the dressed area (tools/map/dress_area.geojson, editable) this module:
  - classifies buildings (house / garage / shop / apartments) and finds which way each one faces,
    where its front door is, whether it has a porch, and its roof type
  - lays out driveways, front walks and planting beds (painted ground layers)
  - places props: trees, shrubs, utility poles (+ wires), hydrants, trash carts, parked cars,
    street-name signs, stop signs, traffic signals
  - derives curbs and lane markings from the street centerlines

Everything is deterministic (seeded by OSM ids / fixed seeds), so re-running the pipeline gives the
same street. Per-building corrections (real colors, roof types, "no porch", ...) go in
tools/map/overrides.json, keyed by OSM way id.

Coordinates are world meters (x east, z south). "Heading"-style angles are not used here: directions
are stored as unit vectors (fx, fz).
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path

import shapely
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box, mapping, shape
from shapely.ops import nearest_points, substring, unary_union
from shapely.prepared import prep

import config
import landmarks
from layers import Building, Layers, Street, polygons_of, tagged_polygons
from osm_parse import OsmData

# --- Tunables -----------------------------------------------------------------------------------

DRESS_AREA_FILE = config.MAP_DIR / "dress_area.geojson"
OVERRIDES_FILE = config.MAP_DIR / "overrides.json"

# Initial dressed area (only used to create dress_area.geojson the first time): the art test block,
# Duval St from 51st to 53rd, both sides, out to roughly the rear lot lines.
INITIAL_DRESS_STREET = "Duval Street"
INITIAL_DRESS_CROSS = ("East 51st Street", "East 53rd Street")
INITIAL_DRESS_HALF_WIDTH = 44.0
INITIAL_DRESS_END_EXTENSION = 14.0

CAR_CLASSES = {"primary", "secondary", "tertiary", "residential", "unclassified", "living_street"}

HOUSE_MIN_AREA = 45.0      # smaller footprints are garages / sheds
APARTMENT_MIN_AREA = 330.0
PIER_HOUSE_MAX_AREA = 260.0  # pier-and-beam bungalows (raised floor, skirting) up to this size

PORCH_CHANCE = 0.75
PORCH_DEPTH = (1.8, 2.4)
PORCH_WIDTH_FRACTION = (0.38, 0.6)
ROOF_GABLE_CHANCE = 0.5     # houses: gable vs hip (overridable)

DRIVEWAY_WIDTH = 2.8
DRIVEWAY_SIDE_GAP = 0.6     # clearance between driveway and the house wall
DRIVEWAY_BEHIND = 9.0       # how far the driveway runs past the house front (to a garage / back yard)
WALK_WIDTH = 1.1
BED_WIDTH = 0.9

TREE_SPECIES = {
    # name: (weight, min spacing to other trees, keep-out radius from buildings)
    "oak": (0.42, 9.0, 3.5),
    "pecan": (0.18, 9.0, 3.5),
    "elm": (0.18, 7.0, 3.0),
    "myrtle": (0.22, 4.0, 1.6),
}
TREE_DENSITY = 1 / 170.0    # trees per m² of plantable ground
SHRUB_SPACING = 1.4
SHRUB_CHANCE = 0.65         # chance a house gets foundation shrubs along its front

POLE_SPACING = 40.0
POLE_SIDE = "east"          # side of the dressed street with the utility line (assumption, see report)
HYDRANT_SPACING = 120.0
CAR_CHANCE = 0.55
CARTS_CHANCE = 0.3

# Lane markings (meters). Cars park along both curbs of the dressed street (aerial imagery), so the
# white edge line marks the parking lane, not a bike lane.
PARKING_LANE_WIDTH = 2.2
STOP_BAR_SETBACK = 2.0

# Street parking: parallel-parked cars along both curbs of the dressed street.
STREET_PARKING_OCCUPANCY = 0.6
STREET_PARKING_SLOT = 6.4         # curb length per car (m)
STREET_PARKING_CORNER = 6.5       # no parking this close to an intersection (past the cross street's edge)
STREET_PARKING_HYDRANT = 4.6      # 15 ft either side of a hydrant (Texas law)

# Fences (kind -> (weight for random front-yard fences, height m)). "wood" = tall privacy fence.
FENCE_KINDS = {"picket": (0.3, 0.95), "chain": (0.3, 1.2), "iron": (0.15, 1.1), "cedar": (0.25, 1.2)}
PRIVACY_FENCE_HEIGHT = 1.85
FRONT_FENCE_CHANCE = 0.38   # houses with a fenced front yard
SIDE_FENCE_CHANCE = 0.75    # privacy fence from a house's side to its neighbor (closes the back yard)
SIDE_FENCE_MAX = 9.0


# --- Data ---------------------------------------------------------------------------------------

@dataclass
class Dressing:
    area: Polygon | None = None
    # extra painted ground layers (kind -> list of polygons)
    ground: dict[str, list[Polygon]] = field(default_factory=lambda: {
        "driveway": [], "walk": [], "bed": [], "parking": [], "patio": [], "turf": []})
    # props: kind -> list of (x, z, rot, scale, variant); rot = angle of the prop's local +X... see tiles.py
    props: dict[str, list[tuple[float, float, float, float, int]]] = field(default_factory=dict)
    signs: list[dict] = field(default_factory=list)
    wires: list[tuple[float, float, float, float]] = field(default_factory=list)
    marks: list[tuple[str, LineString]] = field(default_factory=list)
    curbs: list[LineString] = field(default_factory=list)
    # fences: (kind, height, polyline)
    fences: list[tuple[str, float, LineString]] = field(default_factory=list)
    # hand-made sites (landmarks.py): random trees / props stay out of these
    keep_out: list[Polygon] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def add(self, kind: str, x: float, z: float, rot: float = 0.0, scale: float = 1.0, variant: int = 0) -> None:
        self.props.setdefault(kind, []).append((x, z, rot, scale, variant))


# --- Dressed area -------------------------------------------------------------------------------

def _street_union(streets: list[Street], name: str):
    return unary_union([s.line for s in streets if s.name == name])


def load_or_create_dress_area(layers: Layers, proj) -> Polygon:
    if DRESS_AREA_FILE.exists():
        gj = json.loads(DRESS_AREA_FILE.read_text())
        geoms = [shape(f["geometry"]) for f in gj["features"]]
        polys = []
        for g in geoms:
            for p in polygons_of(g):
                ring = [proj.to_world(lat, lon) for lon, lat in p.exterior.coords]
                polys.append(Polygon(ring))
        return unary_union(polys)

    main = _street_union(layers.streets, INITIAL_DRESS_STREET)
    a = main.intersection(_street_union(layers.streets, INITIAL_DRESS_CROSS[0]))
    b = main.intersection(_street_union(layers.streets, INITIAL_DRESS_CROSS[1]))
    pa = a.centroid if not a.is_empty else None
    pb = b.centroid if not b.is_empty else None
    if pa is None or pb is None:
        raise RuntimeError("can't find the initial dressed block intersections")
    dx, dz = pb.x - pa.x, pb.y - pa.y
    L = math.hypot(dx, dz)
    ux, uz = dx / L, dz / L
    ext = INITIAL_DRESS_END_EXTENSION
    line = LineString([(pa.x - ux * ext, pa.y - uz * ext), (pb.x + ux * ext, pb.y + uz * ext)])
    poly = line.buffer(INITIAL_DRESS_HALF_WIDTH, cap_style="flat")
    ll = [proj.to_latlon(x, z) for x, z in poly.exterior.coords]
    gj = {"type": "FeatureCollection", "features": [{
        "type": "Feature",
        "properties": {"note": "Dressed area (art pass). Buildings whose centroid is inside get full houses; "
                               "props are placed inside. Edit freely (lon/lat)."},
        "geometry": {"type": "Polygon", "coordinates": [[[round(lon, 7), round(lat, 7)] for lat, lon in ll]]},
    }]}
    DRESS_AREA_FILE.write_text(json.dumps(gj, indent=1))
    print(f"[dress] wrote initial {DRESS_AREA_FILE.name}")
    return poly


# --- Geometry helpers ---------------------------------------------------------------------------

def _rect(cx: float, cz: float, ux: float, uz: float, half_len: float, half_w: float) -> Polygon:
    """Rectangle centred at (cx, cz), long axis along unit (ux, uz)."""
    vx, vz = -uz, ux
    return Polygon([
        (cx + ux * half_len + vx * half_w, cz + uz * half_len + vz * half_w),
        (cx - ux * half_len + vx * half_w, cz - uz * half_len + vz * half_w),
        (cx - ux * half_len - vx * half_w, cz - uz * half_len - vz * half_w),
        (cx + ux * half_len - vx * half_w, cz + uz * half_len - vz * half_w),
    ])


def _dominant_axes(poly: Polygon) -> tuple[float, float]:
    """Unit vector of the footprint's dominant wall direction (length-weighted, mod 90°)."""
    sx = sz = 0.0
    c = list(poly.exterior.coords)
    for (ax, az), (bx, bz) in zip(c, c[1:]):
        dx, dz = bx - ax, bz - az
        L = math.hypot(dx, dz)
        if L < 1e-6:
            continue
        a = math.atan2(dz, dx) * 4  # mod 90°
        sx += math.cos(a) * L
        sz += math.sin(a) * L
    a = math.atan2(sz, sx) / 4
    return math.cos(a), math.sin(a)


def _snap_to_axes(fx: float, fz: float, ax: tuple[float, float]) -> tuple[float, float]:
    """Snap direction (fx, fz) to the closest of the 4 footprint axis directions."""
    best, bd = (fx, fz), -2.0
    ux, uz = ax
    for cx, cz in ((ux, uz), (-uz, ux), (-ux, -uz), (uz, -ux)):
        d = fx * cx + fz * cz
        if d > bd:
            bd, best = d, (cx, cz)
    return best


def _extent(poly: Polygon, ux: float, uz: float) -> tuple[float, float]:
    vals = [x * ux + z * uz for x, z in poly.exterior.coords]
    return min(vals), max(vals)


def _street_for(b: Building, streets: list[Street], addr_street: str | None):
    """(street, distance) the building faces: its address street if close, else the nearest car street."""
    best, bd = None, 1e9
    for s in streets:
        if s.cls not in CAR_CLASSES:
            continue
        d = b.poly.distance(s.line)
        if addr_street and s.name == addr_street and d < 45:
            d -= 1000  # strong preference for the address street
        if d < bd:
            best, bd = s, d
    return best, bd


# --- Main ---------------------------------------------------------------------------------------

def dress(osm: OsmData, layers: Layers, proj, playable: Polygon) -> Dressing:
    D = Dressing()
    area = load_or_create_dress_area(layers, proj)
    D.area = area
    area_p = prep(area)
    overrides: dict[str, dict] = {}
    if OVERRIDES_FILE.exists():
        overrides = {k: v for k, v in json.loads(OVERRIDES_FILE.read_text()).items() if not k.startswith("_")}

    streets = [s for s in layers.streets if s.cls in CAR_CLASSES and s.line.intersects(area.buffer(60))]
    land = tagged_polygons(osm, lambda t: t.get("landuse") in ("retail", "commercial")
                           or t.get("residential") == "apartments" or t.get("building") == "apartments")
    commercial_land = unary_union([g for t, g in land if t.get("landuse") in ("retail", "commercial")]) if land else Polygon()
    apartment_land = unary_union([g for t, g in land if t.get("residential") == "apartments"]) if land else Polygon()

    all_bldg = unary_union([b.poly for b in layers.buildings if b.poly.intersects(area.buffer(30))])
    road = layers.areas.get("road", MultiPolygon())
    sidewalk = layers.areas.get("sidewalk", MultiPolygon())

    dressed = [b for b in layers.buildings if area_p.contains(b.poly.centroid)]
    houses: list[tuple[Building, dict]] = []

    # 1. Classify buildings, find fronts, doors, porches, roofs ------------------------------------
    for b in dressed:
        t = b.tags
        ov = overrides.get(str(b.osm_id), {})
        rng = random.Random(b.osm_id)
        a = b.poly.area
        c = b.poly.centroid
        if ov.get("kind"):
            kind = ov["kind"]
        elif t.get("amenity") or t.get("shop") or t.get("office") or b.kind in ("commercial", "retail", "office") \
                or commercial_land.contains(c):
            kind = "shop"
        elif b.kind == "apartments" or apartment_land.contains(c) or a >= APARTMENT_MIN_AREA:
            kind = "apts"
        elif a < HOUSE_MIN_AREA or b.kind in ("garage", "garages", "shed", "carport"):
            kind = "garage"
        else:
            kind = "house"

        addr_street = (b.address or "").split(" ", 1)[1] if b.address and " " in b.address else None
        st, dist = _street_for(b, streets, addr_street)
        axes = _dominant_axes(b.poly)
        info: dict = {"k": kind, "seed": b.osm_id % 100000}
        if st is not None:
            p_b, p_s = nearest_points(b.poly, st.line)
            fx, fz = p_s.x - c.x, p_s.y - c.y
            L = math.hypot(fx, fz) or 1.0
            fx, fz = _snap_to_axes(fx / L, fz / L, axes)
            info["f"] = [round(fx, 3), round(fz, 3)]
            info["street"] = st.name
            # Door: middle of the front face (the footprint's extent along the front side direction).
            sx, sz = -fz, fx
            smin, smax = _extent(b.poly, sx, sz)
            fmin, fmax = _extent(b.poly, fx, fz)
            front_w = smax - smin
            # Offset the door a little to one side for houses (bungalows rarely have a centred door).
            off = (rng.uniform(-0.18, 0.18) * front_w) if kind == "house" else 0.0
            s_mid = (smin + smax) / 2 + off
            # Point on the front face: project the front-most boundary along the front direction.
            probe = LineString([(sx * s_mid + fx * (fmin - 1), sz * s_mid + fz * (fmin - 1)),
                                (sx * s_mid + fx * (fmax + 1), sz * s_mid + fz * (fmax + 1))])
            hit = probe.intersection(b.poly.exterior)
            pts = [g for g in getattr(hit, "geoms", [hit]) if isinstance(g, Point)]
            if pts:
                door = max(pts, key=lambda p: p.x * fx + p.y * fz)
            else:
                door = Point(sx * s_mid + fx * fmax, sz * s_mid + fz * fmax)
            info["door"] = [round(door.x, 2), round(door.y, 2)]
            info["_front"] = (fx, fz, sx, sz, smin, smax, fmin, fmax, front_w)
            info["_street_line"] = st
            info["_street_dist"] = dist

        if kind == "house":
            info["roof"] = "gable" if rng.random() < ROOF_GABLE_CHANCE else "hip"
            info["pier"] = 1 if a <= PIER_HOUSE_MAX_AREA else 0
            if "f" in info and rng.random() < PORCH_CHANCE:
                fw = info["_front"][8]
                pw = max(2.4, min(fw - 1.0, fw * rng.uniform(*PORCH_WIDTH_FRACTION)))
                info["porch"] = [round(pw, 2), round(rng.uniform(*PORCH_DEPTH), 2)]
        elif kind == "garage":
            info["roof"] = "gable" if rng.random() < 0.6 else "flat"
        elif kind == "apts":
            info["roof"] = "hip" if rng.random() < 0.5 else "flat"
        else:
            info["roof"] = "flat"
            if b.name:
                info["sign"] = b.name
        # Hand overrides win (colors, roof, porch, ...). "porch": 0 removes the porch.
        for k, v in ov.items():
            if k == "kind" or k.startswith("_"):
                continue
            info[k] = v
        if info.get("porch") == 0:
            info.pop("porch")
        b.dress = info  # type: ignore[attr-defined]
        if kind == "house":
            houses.append((b, info))

    # Hand-made hero locations (landmarks.py): site plans that replace the generic dressing there.
    landmarks.apply(D, dressed, layers, road, sidewalk, playable)
    site = unary_union(D.keep_out) if D.keep_out else Polygon()

    # Porch footprints (outside the house footprint, in front of the door): obstacles for planting.
    porches = []
    for b, info in houses:
        if "porch" in info and "door" in info:
            fx, fz = info["f"]
            pw, pd = info["porch"]
            dx, dz = info["door"]
            porches.append(_rect(dx + fx * pd / 2, dz + fz * pd / 2, fx, fz, pd / 2, pw / 2))
    porch_union = unary_union(porches) if porches else Polygon()
    solid = unary_union([all_bldg, porch_union])
    solid_and_site = unary_union([solid, site])

    # 2. Driveways, walks, beds ---------------------------------------------------------------------
    driveways: list[Polygon] = []
    for b, info in houses:
        if "_front" not in info:
            continue
        fx, fz, sx, sz, smin, smax, fmin, fmax, fw = info["_front"]
        st: Street = info["_street_line"]
        rng = random.Random(b.osm_id * 7 + 1)
        # Distance (along the front direction) from the house front to the street centerline.
        c = b.poly.centroid
        p_s = nearest_points(c, st.line)[1]
        street_f = p_s.x * fx + p_s.y * fz
        start_f = street_f - st.width / 2 + 0.2  # curb edge (road paint covers the rest)
        end_f = fmax - DRIVEWAY_BEHIND
        if start_f - end_f < 4:
            continue
        sides = [1, -1] if rng.random() < 0.5 else [-1, 1]
        placed = None
        for side in sides:
            s_c = (smax + DRIVEWAY_SIDE_GAP + DRIVEWAY_WIDTH / 2) if side > 0 else (smin - DRIVEWAY_SIDE_GAP - DRIVEWAY_WIDTH / 2)
            for e_f in (end_f, fmax - 1.0):  # long (to the back), else just the front part
                mid_f = (start_f + e_f) / 2
                cx, cz = sx * s_c + fx * mid_f, sz * s_c + fz * mid_f
                r = _rect(cx, cz, fx, fz, (start_f - e_f) / 2, DRIVEWAY_WIDTH / 2)
                if r.intersects(solid_and_site.buffer(0.3)) or any(r.intersects(d) for d in driveways):
                    continue
                if not area_p.contains(Point(cx, cz)):
                    continue
                placed = (r, s_c, e_f)
                break
            if placed:
                break
        if not placed:
            continue
        r, s_c, e_f = placed
        r = r.intersection(playable)
        if r.is_empty:
            continue
        driveways.append(r)
        info["_drive"] = (s_c, start_f, e_f)

    D.ground["driveway"] = driveways
    drive_union = unary_union(driveways) if driveways else Polygon()

    walks = []
    for b, info in houses:
        if "door" not in info or "_street_line" not in info:
            continue
        fx, fz = info["f"]
        dx, dz = info["door"]
        st = info["_street_line"]
        p_s = nearest_points(Point(dx, dz), st.line)[1]
        dist_f = (p_s.x - dx) * fx + (p_s.y - dz) * fz - st.width / 2 + 0.2
        if dist_f < 1.5:
            continue
        line = LineString([(dx, dz), (dx + fx * dist_f, dz + fz * dist_f)])
        walks.append(line.buffer(WALK_WIDTH / 2, cap_style="flat").intersection(playable))
    D.ground["walk"] = [w for w in walks if not w.is_empty]

    beds = []
    for b, info in houses:
        ring = b.poly.buffer(BED_WIDTH, join_style="mitre").difference(b.poly)
        beds.append(ring)
    if beds:
        bed = unary_union(beds).difference(drive_union.buffer(0.2)).difference(unary_union(D.ground["walk"] or [Polygon()]))
        D.ground["bed"] = [p for p in polygons_of(bed) if p.area > 0.5]

    # 3. Street furniture along the dressed street(s) ----------------------------------------------
    hard = unary_union([road, sidewalk, drive_union, unary_union(D.ground["walk"] or [Polygon()])])
    keep_out_props = unary_union([solid.buffer(0.6), hard.buffer(0.4)])
    _place_street_furniture(D, streets, area, road, keep_out_props, drive_union, sidewalk)

    # 4. Cars, carts ------------------------------------------------------------------------------
    walkways = prep(unary_union([sidewalk, unary_union(D.ground["walk"] or [Polygon()])]).buffer(0.2))
    for b, info in houses:
        if "_drive" not in info:
            continue
        fx, fz, sx, sz, smin, smax, fmin, fmax, fw = info["_front"]
        s_c, start_f, e_f = info["_drive"]
        rng = random.Random(b.osm_id * 13 + 5)
        if rng.random() < CAR_CHANCE:
            # Parked in the driveway beside the house front, nose toward the house, never on the sidewalk.
            f_c = min(fmax + 1.0, start_f - 5.0)
            while f_c >= e_f + 2.6:
                car = _rect(sx * s_c + fx * f_c, sz * s_c + fz * f_c, fx, fz, 2.5, 1.0)
                if not walkways.intersects(car):
                    D.add("car", car.centroid.x, car.centroid.y, face(-fx, -fz), 1.0, rng.randrange(8))
                    break
                f_c -= 1.0
        if rng.random() < CARTS_CHANCE:
            # Trash day: carts at the curb beside the driveway (in the parkway strip, off the sidewalk).
            side = 1 if s_c > (smin + smax) / 2 else -1
            f_c = start_f - 0.9
            for k, kind in enumerate(("cart_trash", "cart_recycle")):
                s_k = s_c + side * (DRIVEWAY_WIDTH / 2 + 0.5 + k * 0.75)
                cx, cz = sx * s_k + fx * f_c, sz * s_k + fz * f_c
                if not walkways.intersects(Point(cx, cz).buffer(0.45)):
                    D.add(kind, cx, cz, face(fx, fz), 1.0, 0)

    # 4b. Fences: front-yard fences and side privacy fences between houses ------------------------
    _place_yard_fences(D, houses, all_bldg, porch_union, drive_union, unary_union(D.ground["walk"] or [Polygon()]),
                       unary_union([road, sidewalk]), site, playable)
    fence_zone = unary_union([ln.buffer(0.7) for _, _, ln in D.fences]) if D.fences else Polygon()

    # 5. Trees and shrubs ---------------------------------------------------------------------------
    _place_planting(D, area, playable, houses, solid_and_site, unary_union([hard, fence_zone]), porch_union)

    D.notes.append(
        f"{len(dressed)} buildings dressed ({sum(1 for b in dressed if b.dress['k'] == 'house')} houses), "  # type: ignore[attr-defined]
        f"{len(driveways)} driveways, {len(D.ground['walk'])} walks, "
        + ", ".join(f"{k} {len(v)}" for k, v in sorted(D.props.items()))
        + f", {len(D.signs)} signs, {len(D.wires)} wire spans, {len(D.marks)} markings, {len(D.curbs)} curbs, "
        f"{len(D.fences)} fences ({sum(ln.length for _, _, ln in D.fences):.0f} m)")
    return D


def _place_street_furniture(D: Dressing, streets: list[Street], area: Polygon, road, keep_out, drives, sidewalk) -> None:
    """Curbs, lane markings, poles + wires, hydrants, signs, stop signs, signals."""
    area_p = prep(area)
    # Curbs: road surface outline inside the dressed area, minus driveway cuts.
    road_local = road.intersection(area.buffer(2))
    edges = []
    for p in polygons_of(road_local):
        for ring in [p.exterior, *p.interiors]:
            edges.append(LineString(ring.coords))
    if edges:
        curb = unary_union(edges).intersection(area).difference(drives.buffer(0.6))
        for ln in getattr(curb, "geoms", [curb]):
            if isinstance(ln, LineString) and ln.length > 1.0:
                D.curbs.append(ln.simplify(0.1))

    named = {}
    for s in streets:
        named.setdefault(s.name, []).append(s)

    # The main dressed street(s): named streets with the most length inside the area.
    lengths = sorted(((sum(s.line.intersection(area).length for s in ss), name) for name, ss in named.items()),
                     reverse=True)
    if not lengths:
        return
    main_name = lengths[0][1]
    main_parts = named[main_name]
    main_line = shapely.line_merge(unary_union([s.line for s in main_parts]))
    main_w = max(s.width for s in main_parts)
    if isinstance(main_line, MultiLineString):
        main_line = max(main_line.geoms, key=lambda g: g.intersection(area).length)
    inside = main_line.intersection(area)
    if isinstance(inside, MultiLineString):
        inside = max(inside.geoms, key=lambda g: g.length)
    if not isinstance(inside, LineString) or inside.length < 10:
        return
    # Orient south -> north (z decreasing) so "left/right" are stable.
    if inside.coords[0][1] < inside.coords[-1][1]:
        inside = LineString(list(inside.coords)[::-1])

    # Intersections with cross streets along the main street.
    crosses = []  # (distance along, point, street name, cross street line, width)
    for name, ss in named.items():
        if name == main_name:
            continue
        for s in ss:
            x = s.line.intersection(main_line)
            for p in getattr(x, "geoms", [x]):
                if isinstance(p, Point) and area.buffer(5).contains(p):
                    crosses.append((inside.project(p), p, name, s, s.width))
    # dedupe
    seen = set()
    uniq = []
    for c in sorted(crosses, key=lambda c: c[0]):
        key = (round(c[1].x), round(c[1].y))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(c)
    crosses = uniq
    # Group by intersection point (the cross street can be split into two ways at the main street).
    inters: dict[tuple[int, int], dict] = {}
    for d_along, p, name, s, w in crosses:
        key = (round(p.x / 3), round(p.y / 3))
        it = inters.setdefault(key, {"d": d_along, "p": p, "names": set(), "ways": [], "w": w})
        it["names"].add(name)
        it["ways"].append(s)
        it["w"] = max(it["w"], w)

    def offset_line(line: LineString, dist: float) -> LineString | None:
        g = line.offset_curve(dist, join_style="mitre")
        if isinstance(g, MultiLineString):
            g = max(g.geoms, key=lambda q: q.length)
        return g if isinstance(g, LineString) and not g.is_empty else None

    # Lane markings on the main street, interrupted at intersections.
    gaps = [(it["d"] - it["w"] / 2 - 1.0, it["d"] + it["w"] / 2 + 1.0) for it in inters.values()]
    pieces = []
    d0 = 0.0
    for g0, g1 in sorted(gaps):
        if g0 > d0 + 2:
            pieces.append((d0, g0))
        d0 = max(d0, g1)
    if inside.length > d0 + 2:
        pieces.append((d0, inside.length))
    for a, b in pieces:
        seg = substring(inside, a, b)
        if seg.length < 2:
            continue
        D.marks.append(("yellow2", seg))
        for side in (1, -1):
            ln = offset_line(seg, side * (main_w / 2 - PARKING_LANE_WIDTH))
            if ln is not None:
                D.marks.append(("white", ln))

    # Signs, stop bars + stop signs (or signals) at each intersection.
    for it in inters.values():
        p: Point = it["p"]
        names = sorted(it["names"])
        cross_cls = max((s.cls for s in it["ways"]), key=lambda c: ["residential", "tertiary", "secondary", "primary"].index(c) if c in ("residential", "tertiary", "secondary", "primary") else 0)
        tangent = _tangent_at(inside, it["d"])
        e = (-tangent[1], tangent[0])  # perpendicular (points east for a northbound street)
        signal = cross_cls in ("secondary", "primary")
        # Each cross-street approach (east and west side).
        for side in (1, -1):
            # direction along the cross street, away from the intersection, on this side
            appr = _cross_direction(it["ways"], p, side, e)
            if appr is None:
                continue
            ax, az = appr
            # Traffic approaching the main street travels (tx, tz); its right-hand side (x east, z south,
            # seen from above) is (-tz, tx): e.g. northbound (0, -1) -> east (1, 0).
            tx, tz = -ax, -az
            rx, rz = -tz, tx
            setback = main_w / 2 + STOP_BAR_SETBACK
            cw = it["w"] / 2
            bx, bz = p.x + ax * setback, p.y + az * setback
            if area_p.contains(Point(bx, bz)) or area.buffer(15).contains(Point(bx, bz)):
                if not signal:
                    D.marks.append(("stop", LineString([(bx + rx * 0.2, bz + rz * 0.2), (bx + rx * (cw - 0.3), bz + rz * (cw - 0.3))])))
                    sx_, sz_ = bx + rx * (cw + 1.0) + ax * 0.5, bz + rz * (cw + 1.0) + az * 0.5
                    D.add("stop", sx_, sz_, face(-tx, -tz), 1.0, 0)  # faces oncoming traffic
        # Street-name sign on one corner (the north-east or south-west corner, whichever is in the area).
        for cs in ((1, 1), (-1, -1), (1, -1), (-1, 1)):
            cx = p.x + e[0] * cs[0] * (main_w / 2 + 1.2) + tangent[0] * cs[1] * (it["w"] / 2 + 1.2)
            cz = p.y + e[1] * cs[0] * (main_w / 2 + 1.2) + tangent[1] * cs[1] * (it["w"] / 2 + 1.2)
            if area_p.contains(Point(cx, cz)):
                cross_name = names[0]
                cross_dir = _cross_direction(it["ways"], p, 1, e) or (e[0], e[1])
                D.signs.append({
                    "x": round(cx, 2), "z": round(cz, 2),
                    # blade A runs along the main street, blade B along the cross street
                    "a": _sign_text(main_name), "ar": round(along(*tangent), 3),
                    "b": _sign_text(cross_name), "br": round(along(*cross_dir), 3),
                })
                if signal:
                    D.add("signal", cx, cz, face(-e[0] * cs[0], -e[1] * cs[0]), 1.0, 0)  # arm over the street
                break
        if signal:
            # Opposite corner gets the second signal pole.
            cx = p.x - e[0] * (main_w / 2 + 1.2) - tangent[0] * (it["w"] / 2 + 1.2)
            cz = p.y - e[1] * (main_w / 2 + 1.2) - tangent[1] * (it["w"] / 2 + 1.2)
            if area.buffer(20).contains(Point(cx, cz)):
                D.add("signal", cx, cz, face(e[0], e[1]), 1.0, 0)

    # Utility poles along one side of the main street, in the parkway behind the curb.
    side = 1 if POLE_SIDE == "east" else -1
    poles = []
    d = 6.0
    while d < inside.length - 4:
        tx, tz = _tangent_at(inside, d)
        ex, ez = -tz, tx
        p = inside.interpolate(d)
        # skip intersections
        if any(abs(d - it["d"]) < it["w"] / 2 + 4 for it in inters.values()):
            d += 4
            continue
        x, z = p.x + ex * side * (main_w / 2 + 0.7), p.y + ez * side * (main_w / 2 + 0.7)
        if drives.buffer(0.8).contains(Point(x, z)) or sidewalk.intersects(Point(x, z).buffer(0.35)):
            d += 2
            continue
        variant = 1 if len(poles) % 2 == 0 else 0  # every other pole carries a street light
        poles.append((x, z, face(-ex * side, -ez * side), variant))  # light arm reaches over the street
        d += POLE_SPACING
    for x, z, rot, v in poles:
        D.add("pole", x, z, rot, 1.0, v)
    for (x0, z0, *_), (x1, z1, *_) in zip(poles, poles[1:]):
        D.wires.append((x0, z0, x1, z1))

    # Hydrants on the other side, in the parkway.
    hydrants: list[tuple[float, float]] = []
    d = 25.0
    while d < inside.length - 10:
        tx, tz = _tangent_at(inside, d)
        ex, ez = -tz, tx
        p = inside.interpolate(d)
        x, z = p.x - ex * side * (main_w / 2 + 0.8), p.y - ez * side * (main_w / 2 + 0.8)
        if not drives.buffer(1.0).contains(Point(x, z)) and not sidewalk.intersects(Point(x, z).buffer(0.35)) and \
                not any(abs(d - it["d"]) < it["w"] / 2 + 2 for it in inters.values()):
            D.add("hydrant", x, z, 0.0, 1.0, 0)
            hydrants.append((x, z))
            d += HYDRANT_SPACING
        else:
            d += 3

    _place_street_parking(D, inside, main_w, road, drives, inters, hydrants)


def _place_street_parking(D: Dressing, inside: LineString, main_w: float, road, drives, inters: dict,
                          hydrants: list[tuple[float, float]]) -> None:
    """Parallel-parked cars along both curbs of the main street: not at intersections, curb cuts
    (driveways) or hydrants; facing the direction of traffic on their side."""
    rng = random.Random(4253)
    road_p = prep(road.buffer(0.05))
    no_park = prep(drives.buffer(0.9)) if not drives.is_empty else None
    count = 0
    for side in (1, -1):  # +1 = east curb (northbound traffic), -1 = west curb
        d = 2.0
        while d < inside.length - 2.0:
            mid = d + STREET_PARKING_SLOT / 2
            if any(abs(mid - it["d"]) < it["w"] / 2 + STREET_PARKING_CORNER for it in inters.values()):
                d += 1.0
                continue
            tx, tz = _tangent_at(inside, mid)
            ex, ez = -tz, tx
            p = inside.interpolate(mid)
            off = main_w / 2 - 1.15  # car centre: ~0.25 m off the curb
            cx, cz = p.x + ex * side * off, p.y + ez * side * off
            car = _rect(cx, cz, tx, tz, 2.6, 0.95)
            if not road_p.contains(car) or (no_park is not None and no_park.intersects(car)) or \
                    any(math.hypot(cx - hx, cz - hz) < STREET_PARKING_HYDRANT for hx, hz in hydrants):
                d += 1.0
                continue
            if rng.random() < STREET_PARKING_OCCUPANCY:
                j = rng.uniform(-0.12, 0.12)  # not every car hugs the curb the same
                fx, fz = (tx, tz) if side > 0 else (-tx, -tz)
                rot = face(fx, fz) + rng.uniform(-0.03, 0.03)
                D.add("car", cx + ex * side * j, cz + ez * side * j, rot, 1.0, rng.randrange(8))
                count += 1
            d += STREET_PARKING_SLOT + rng.uniform(-0.4, 0.8)
    D.notes.append(f"street parking: {count} cars")


def _first_hit(origin: tuple[float, float], direction: tuple[float, float], obstacles, max_d: float) -> float | None:
    """Distance from origin along direction to the first point inside obstacles (None if no hit)."""
    ox, oz = origin
    ray = LineString([(ox, oz), (ox + direction[0] * max_d, oz + direction[1] * max_d)])
    hit = ray.intersection(obstacles)
    if hit.is_empty:
        return None
    return min(Point(ox, oz).distance(g) for g in getattr(hit, "geoms", [hit]))


def _keep_piece(geom, touching=None, min_len: float = 0.8) -> list[LineString]:
    """Line pieces of geom at least min_len long (optionally only those touching `touching`)."""
    out = []
    for g in getattr(geom, "geoms", [geom]):
        if isinstance(g, LineString) and g.length >= min_len and (touching is None or g.distance(touching) < 0.6):
            out.append(g)
    return out


def _place_yard_fences(D: Dressing, houses, buildings, porches_all, drives_all, walks_all, street_all, site_all,
                       playable) -> None:
    """Front-yard fences (picket / chain-link / iron / cedar, with a gap at the walk and the driveway)
    and tall wood privacy fences from a house's side to its neighbor (closing off the back yard)."""
    names = list(FENCE_KINDS)
    weights = [FENCE_KINDS[n][0] for n in names]
    inner = playable.buffer(-0.4)
    for b, info in houses:
        if "_front" not in info:
            continue
        fx, fz, sx, sz, smin, smax, fmin, fmax, fw = info["_front"]
        rng = random.Random(b.osm_id * 17 + 3)
        # Work on a local window: buffering the whole map's streets per house is slow.
        win = b.poly.envelope.buffer(30.0)
        others = buildings.intersection(win).difference(b.poly.buffer(0.05))
        street = street_all.intersection(win)
        drives = drives_all.intersection(win)
        walks = walks_all.intersection(win)
        porches = porches_all.intersection(win)
        site = site_all.intersection(win)
        W = lambda s, f: (sx * s + fx * f, sz * s + fz * f)  # noqa: E731
        blocked_front = unary_union([others.buffer(1.0), porches.buffer(0.3), street.buffer(0.35), site.buffer(0.5)])

        # Front yard fence: just behind the sidewalk, across the lot, with returns back to the house.
        if rng.random() < FRONT_FENCE_CHANCE:
            door = info.get("door")
            probe_from = door if door else W((smin + smax) / 2, fmax)
            hit = _first_hit((probe_from[0], probe_from[1]), (fx, fz), street, 30.0)
            if hit is not None and hit > 3.0:
                f_line = probe_from[0] * fx + probe_from[1] * fz + hit - 0.45
                s0, s1 = smin - rng.uniform(1.5, 3.0), smax + rng.uniform(1.5, 3.0)
                kind = rng.choices(names, weights)[0]
                h = FENCE_KINDS[kind][1]
                path = LineString([W(s0, fmax - 1.0), W(s0, f_line), W(s1, f_line), W(s1, fmax - 1.0)])
                cut = unary_union([blocked_front, drives.buffer(0.3), walks.buffer(0.05)])
                pieces = _keep_piece(path.difference(cut).intersection(inner))
                for pc in pieces:
                    D.fences.append((kind, h, pc.simplify(0.05)))

        # Side privacy fence on the +s side, a few meters behind the front wall, out to the neighbor.
        if rng.random() < SIDE_FENCE_CHANCE:
            f_line = fmax - min(3.0, 0.4 * (fmax - fmin))
            # From inside the house outward: the piece that starts at this house's wall.
            path = LineString([W((smin + smax) / 2, f_line), W(smax + SIDE_FENCE_MAX, f_line)])
            cut = unary_union([b.poly.buffer(0.02), others.buffer(0.3), drives.buffer(0.3), street.buffer(1.0),
                               site.buffer(0.5)])
            pieces = _keep_piece(path.difference(cut).intersection(inner), touching=b.poly, min_len=1.5)
            for pc in pieces:
                D.fences.append(("wood", PRIVACY_FENCE_HEIGHT, pc))


def face(fx: float, fz: float) -> float:
    """Rotation (three.js rotation.y, same as the dog heading) that makes a prop's front (local −Z)
    face the world direction (fx, fz)."""
    return math.atan2(-fx, -fz)


def along(ux: float, uz: float) -> float:
    """Rotation that lays a prop's local +X axis along world direction (ux, uz) (sign blades)."""
    return math.atan2(-uz, ux)


def _tangent_at(line: LineString, d: float) -> tuple[float, float]:
    a = line.interpolate(max(0.0, d - 1.0))
    b = line.interpolate(min(line.length, d + 1.0))
    dx, dz = b.x - a.x, b.y - a.y
    L = math.hypot(dx, dz) or 1.0
    return dx / L, dz / L


def _cross_direction(ways: list[Street], p: Point, side: int, e: tuple[float, float]) -> tuple[float, float] | None:
    """Unit direction along the cross street leaving point p toward the given side (+1 = along e)."""
    best = None
    for s in ways:
        for q in (s.line.interpolate(s.line.project(p) + 8), s.line.interpolate(max(0, s.line.project(p) - 8))):
            dx, dz = q.x - p.x, q.y - p.y
            L = math.hypot(dx, dz)
            if L < 1:
                continue
            ux, uz = dx / L, dz / L
            if (ux * e[0] + uz * e[1]) * side > 0.3:
                best = (ux, uz)
    return best


_ABBR = {"Street": "St", "Avenue": "Ave", "Boulevard": "Blvd", "Lane": "Ln", "Drive": "Dr", "Road": "Rd",
         "East": "E", "West": "W", "North": "N", "South": "S"}


def _sign_text(name: str) -> str:
    """'East 52nd Street' -> 'E 52nd St' (Austin's current mixed-case style)."""
    return " ".join(_ABBR.get(w, w) for w in name.split())


def _place_planting(D: Dressing, area: Polygon, playable: Polygon, houses, solid, hard, porches) -> None:
    rng = random.Random(51_53)
    plantable = area.intersection(playable).difference(hard.buffer(0.8))
    # Trees: dart throwing with per-species spacing and building keep-out.
    names = list(TREE_SPECIES)
    weights = [TREE_SPECIES[n][0] for n in names]
    keep = {n: prep(plantable.difference(solid.buffer(TREE_SPECIES[n][2]))) for n in names}
    target = int(plantable.area * TREE_DENSITY)
    minx, minz, maxx, maxz = plantable.bounds
    trees: list[tuple[float, float, str]] = []
    tries = 0
    while len(trees) < target and tries < target * 200:
        tries += 1
        x, z = rng.uniform(minx, maxx), rng.uniform(minz, maxz)
        sp = rng.choices(names, weights)[0]
        if not keep[sp].contains(Point(x, z)):
            continue
        sd = TREE_SPECIES[sp][1]
        if any((x - tx) ** 2 + (z - tz) ** 2 < (0.5 * (sd + TREE_SPECIES[ts][1])) ** 2 for tx, tz, ts in trees):
            continue
        trees.append((x, z, sp))
    for x, z, sp in trees:
        D.add(f"tree_{sp}", x, z, rng.uniform(0, math.tau), rng.uniform(0.8, 1.2), rng.randrange(4))

    # Foundation shrubs along house fronts (skip the door / porch / walk).
    walk_u = unary_union(D.ground["walk"]) if D.ground["walk"] else Polygon()
    avoid = prep(unary_union([porches.buffer(0.5), walk_u.buffer(0.6), hard.buffer(0.3)]))
    tree_pts = [(x, z) for x, z, _ in trees]
    for b, info in houses:
        if "_front" not in info:
            continue
        r = random.Random(b.osm_id * 31 + 7)
        if r.random() > SHRUB_CHANCE:
            continue
        fx, fz, sx, sz, smin, smax, fmin, fmax, fw = info["_front"]
        # Line just in front of the front face.
        f_line = fmax + 0.6
        s = smin + 0.5
        while s < smax - 0.4:
            x, z = sx * s + fx * f_line, sz * s + fz * f_line
            p = Point(x, z)
            if not avoid.contains(p) and not solid.contains(p) and \
                    all((x - tx) ** 2 + (z - tz) ** 2 > 2.0 for tx, tz in tree_pts):
                D.add("shrub", x, z, r.uniform(0, math.tau), r.uniform(0.8, 1.25), r.randrange(3))
            s += SHRUB_SPACING * r.uniform(0.85, 1.2)


def building_records_extra(b: Building) -> dict | None:
    """The per-building dressing record written to tiles (internal keys stripped)."""
    info = getattr(b, "dress", None)
    if not info:
        return None
    return {k: v for k, v in info.items() if not k.startswith("_") and k != "street"}
