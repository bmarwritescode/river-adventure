"""Hero locations: hand-made site plans for a few places locals know.

The art direction is "nail a few places" rather than make every lot perfect. A landmark is an OSM
building plus a site plan authored in the building's own frame, measured from aerial imagery and
photos (sources: docs/art-direction.md). The pipeline decides WHAT goes WHERE (ground surfaces,
parking stalls, parked cars, trees, fences, and the frame for the building model); the game's
landmark model (src/world/map/dress/landmarks/) decides how the building and its fixtures look.

Frame (per landmark): origin = the storefront's west corner; a = meters along the storefront
(toward the east end); b = meters out of the storefront (toward the street it faces). The frame
comes from the real footprint, so the site stays attached to the building if OSM is edited.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from layers import Building, polygons_of

if TYPE_CHECKING:  # dress imports this module; avoid a runtime cycle
    from dress import Dressing


@dataclass
class Frame:
    ox: float
    oz: float
    ux: float  # a axis (along the storefront)
    uz: float
    nx: float  # b axis (out of the storefront)
    nz: float

    def w(self, a: float, b: float) -> tuple[float, float]:
        return self.ox + self.ux * a + self.nx * b, self.oz + self.uz * a + self.nz * b

    def rect(self, a0: float, a1: float, b0: float, b1: float) -> Polygon:
        return Polygon([self.w(a0, b0), self.w(a1, b0), self.w(a1, b1), self.w(a0, b1)])

    def line(self, *pts: tuple[float, float]) -> LineString:
        return LineString([self.w(a, b) for a, b in pts])

    def face(self, da: float, db: float) -> float:
        """Rotation (three.js rotation.y) making a prop's front face local direction (da, db)."""
        fx, fz = self.ux * da + self.nx * db, self.uz * da + self.nz * db
        return math.atan2(-fx, -fz)


def frame_for(b: Building, front: tuple[float, float]) -> Frame:
    """Frame on the real storefront wall: the footprint edge facing `front` that sits furthest out.
    (Using the axis-snapped front direction instead would let the facade float off a wall that is a
    degree or two off the building's dominant axis.)"""
    fx, fz = front
    pts = list(b.poly.exterior.coords)
    best, score = None, -1e9
    for (ax, az), (bx, bz) in zip(pts, pts[1:]):
        dx, dz = bx - ax, bz - az
        L = math.hypot(dx, dz)
        if L < 3.0:
            continue
        # direction along the storefront with the same handedness as dress.py's (sx, sz) = (-fz, fx)
        ux, uz = dx / L, dz / L
        if ux * -fz + uz * fx < 0:
            ux, uz = -ux, -uz
        if abs(ux * fx + uz * fz) > 0.26:  # not parallel to the front (> 15 degrees off)
            continue
        out = ((ax + bx) / 2) * fx + ((az + bz) / 2) * fz
        sc = out + 0.05 * L  # furthest out, then longest
        if sc > score:
            best, score = (ux, uz, ax, az, bx, bz), sc
    if best is None:
        ux, uz = -fz, fx
        a0 = min(x * ux + z * uz for x, z in pts)
        b0 = max(x * uz - z * ux for x, z in pts)
        return Frame(a0 * ux + b0 * uz, a0 * uz - b0 * ux, ux, uz, uz, -ux)
    ux, uz, ax, az, bx, bz = best
    # origin = the edge's west end (smaller a)
    ox, oz = (ax, az) if ax * ux + az * uz <= bx * ux + bz * uz else (bx, bz)
    return Frame(ox, oz, ux, uz, uz, -ux)


def _clear_width(fr: Frame, a_from: float, b: float, direction: float, obstacles, max_d: float = 25.0) -> float:
    """Free distance from (a_from, b) along ±a until obstacles."""
    x0, z0 = fr.w(a_from, b)
    x1, z1 = fr.w(a_from + direction * max_d, b)
    hit = LineString([(x0, z0), (x1, z1)]).intersection(obstacles)
    if hit.is_empty:
        return max_d
    return min(Point(x0, z0).distance(g) for g in getattr(hit, "geoms", [hit]))


# --- Home Slice Pizza, 501 E 53rd St ------------------------------------------------------------------
#
# Free-standing brick building (former Bair's office supply), restaurant since 2018. Storefront faces
# north onto its own parking lot and 53rd; the patio is on the west side, facing Duval: a corrugated
# metal shed roof against the wall ("NYC sidewalk scaffolding"), tan shade sails, then a row of
# blue/white striped canopies over tables along the Duval sidewalk; artificial-turf kids' area further
# south. Measurements (meters, frame above) from Esri World Imagery at ~6 cm/pixel.

HOME_SLICE_ID = 379191561
HOME_SLICE_HEIGHT = 4.15        # roof deck; parapet (to 4.75) + sign letters rise above (OSM 6.78 = rooftop units)
HS_STALL = 2.7                  # stall width
HS_PATIO_B = (-17.0, 1.6)       # patio slab extent along the west wall
HS_TURF = (-6.5, -0.3, -27.0, -17.0)
# Stall rows: (a0, count, b0, b1, along) -> lines across the row; occupancy pattern (1 = car)
HS_ROW1 = (0.6, 6, 1.7, 6.9)    # nose-in to the storefront, between the walk and the aisle
HS_ROW2 = (3.0, 9, 13.6, 18.9)  # far side of the aisle, nose to the island along 53rd
HS_EAST = (-6.0, 8, 22.3, 27.6)  # along the east wall: b0 of the first stall, count, a0, a1
HS_OCC1 = (1, 1, 0, 1, 1, 1)
HS_OCC2 = (1, 0, 1, 1, 1, 0, 1, 1, 1)
HS_OCCE = (0, 1, 1, 0, 1, 1, 1, 0)


def home_slice(D: Dressing, b: Building, road, sidewalk) -> None:
    info = b.dress  # type: ignore[attr-defined]
    fr = frame_for(b, tuple(info["f"]))
    street = unary_union([road, sidewalk])

    # Patio depth: from the west wall to just short of the Duval sidewalk (measured per site).
    pw = min(_clear_width(fr, 0.0, bb, -1.0, street) for bb in (HS_PATIO_B[0], -8.0, 0.0, HS_PATIO_B[1])) - 0.35
    pw = max(6.0, min(pw, 13.0))
    b.height = HOME_SLICE_HEIGHT
    info.update({
        "k": "shop", "roof": "flat",
        "door": [round(c, 2) for c in fr.w(12.8, 0.0)],
        "lm": {"id": "homeslice", "o": [round(fr.ox, 2), round(fr.oz, 2)], "u": [round(fr.ux, 4), round(fr.uz, 4)],
               "pw": round(pw, 2)},
    })
    info.pop("sign", None)

    keep = street.buffer(0.2)
    G = D.ground
    # Ground: storefront walk, lot (front + east side), patio slab, turf, tree planter.
    walk = fr.rect(-0.6, 20.6, -0.05, 1.6)
    lot = unary_union([fr.rect(-6.5, 31.5, 1.6, 19.2), fr.rect(19.9, 29.6, -31.0, 1.6),
                       fr.rect(-6.5, -0.4, 19.2, 24.0)])  # the entrance drive off 53rd
    planter = fr.rect(16.9, 20.4, 1.75, 6.85)
    patio = fr.rect(-pw, -0.02, *HS_PATIO_B)
    turf = fr.rect(*HS_TURF)
    G["walk"].append(walk.difference(keep))
    G["parking"].append(lot.difference(b.poly).difference(walk).difference(planter).difference(keep))
    G["patio"].append(patio.difference(keep))
    G["turf"].append(turf.difference(keep))
    G["bed"].append(planter)
    D.keep_out.append(unary_union([fr.rect(-pw - 0.6, 32.0, -37.0, 24.0)]).difference(street))

    # Stall lines (white) and the cars in them.
    a0, n, s0, s1 = HS_ROW1
    for k in range(n + 1):
        D.marks.append(("white", fr.line((a0 + k * HS_STALL, s0), (a0 + k * HS_STALL, s1))))
    for k, occ in enumerate(HS_OCC1):
        if occ:
            D.add("car", *fr.w(a0 + (k + 0.5) * HS_STALL, s0 + 2.6), fr.face(0, -1), 1.0, (k * 3 + 1) % 8)
    a0, n, s0, s1 = HS_ROW2
    for k in range(n + 1):
        D.marks.append(("white", fr.line((a0 + k * HS_STALL, s0), (a0 + k * HS_STALL, s1))))
    for k, occ in enumerate(HS_OCC2):
        if occ:
            D.add("car", *fr.w(a0 + (k + 0.5) * HS_STALL, s1 - 2.6), fr.face(0, 1), 1.0, (k * 5 + 2) % 8)
    b0, n, e0, e1 = HS_EAST
    for k in range(n + 1):
        D.marks.append(("white", fr.line((e0, b0 - k * HS_STALL), (e1, b0 - k * HS_STALL))))
    for k, occ in enumerate(HS_OCCE):
        if occ:
            D.add("car", *fr.w(e0 + 2.6, b0 - (k + 0.5) * HS_STALL), fr.face(-1, 0), 1.0, (k * 7 + 3) % 8)

    # Trees seen in the aerial: big live oak at the lot's Duval corner, elms in the island along 53rd
    # and the planter, live oaks around the kids' turf and south of the patio.
    for kind, a, bb, sc in (("tree_oak", -10.2, 9.5, 1.25), ("tree_elm", 6.5, 21.0, 1.0), ("tree_elm", 15.0, 21.2, 1.05),
                            ("tree_oak", 24.0, 21.2, 0.95), ("tree_elm", 18.65, 4.3, 0.95),
                            ("tree_oak", -9.6, -22.0, 1.2), ("tree_oak", -11.0, -31.5, 1.1),
                            ("tree_pecan", -3.0, -33.5, 1.0)):
        x, z = fr.w(a, bb)
        if not keep.buffer(0.6).contains(Point(x, z)):
            D.add(kind, x, z, (a * 7.1 + bb) % math.tau, sc, 1)

    # Patio fence along the Duval side (black metal), gap = patio gate; turf enclosure closes the south.
    fa = -pw + 0.15
    fence = LineString([fr.w(fa, HS_PATIO_B[1] - 0.2), fr.w(fa, -12.6)])
    D.fences.append(("iron", 1.1, fence))
    D.fences.append(("iron", 1.1, LineString([fr.w(fa, -14.4), fr.w(fa, HS_TURF[2]), fr.w(-0.05, HS_TURF[2])])))
    D.notes.append(f"landmark: Home Slice (patio {pw:.1f} m deep)")


# --- Hyde Park Animal Clinic, NW corner of Duval & 51st -------------------------------------------------
#
# Tall wood privacy fence around most of the lot (side drive on the west, big side yard toward
# Duval); the clinic's front on 51st stays open. Lot corner measured from the aerial.

VET_ID = 381764304
VET_LOT_NW = (421.0, -872.0)    # world: north-west lot corner (west fence along the side drive)
VET_FENCE_HEIGHT = 2.1


def _street_dir(streets, name_part: str, near: tuple[float, float]) -> tuple[float, float] | None:
    best, bd = None, 1e9
    for s in streets:
        if name_part not in s.name:
            continue
        d = s.line.distance(Point(near))
        if d < bd:
            best, bd = s, d
    if best is None:
        return None
    t = best.line.project(Point(near))
    a, c = best.line.interpolate(max(0, t - 5)), best.line.interpolate(min(best.line.length, t + 5))
    dx, dz = c.x - a.x, c.y - a.y
    L = math.hypot(dx, dz) or 1.0
    return dx / L, dz / L


def vet_clinic(D: Dressing, b: Building, streets, road, sidewalk) -> None:
    d51 = _street_dir(streets, "51st", b.poly.centroid.coords[0])
    dduv = _street_dir(streets, "Duval", b.poly.centroid.coords[0])
    if d51 is None or dduv is None:
        return
    if d51[0] < 0:
        d51 = (-d51[0], -d51[1])     # east
    if dduv[1] < 0:
        dduv = (-dduv[0], -dduv[1])  # south
    x0, z0 = VET_LOT_NW
    lot = Polygon([(x0, z0), (x0 + d51[0] * 70, z0 + d51[1] * 70),
                   (x0 + d51[0] * 70 + dduv[0] * 60, z0 + d51[1] * 70 + dduv[1] * 60),
                   (x0 + dduv[0] * 60, z0 + dduv[1] * 60)])
    lot = lot.difference(unary_union([road, sidewalk]).buffer(0.6))
    parts = [p for p in polygons_of(lot) if p.area > 50]
    if not parts:
        return
    lot = max(parts, key=lambda p: p.intersection(b.poly.buffer(5)).area)
    ring = LineString(lot.exterior.coords)
    # Open frontage: the clinic's front (toward 51st), from the west lot line to just past its east wall.
    ex, ez = d51
    fx, fz = -ez, ex
    c = b.poly.centroid
    st51 = min((s for s in streets if "51st" in s.name), key=lambda s: s.line.distance(c))
    q = st51.line.interpolate(st51.line.project(c))
    if (q.x - c.x) * fx + (q.y - c.y) * fz < 0:
        fx, fz = -fx, -fz  # (fx, fz) points from the clinic toward 51st
    e_max = max(x * ex + z * ez for x, z in b.poly.exterior.coords) + 1.0
    f_front = max(x * fx + z * fz for x, z in b.poly.exterior.coords) - 0.5
    W = lambda e, f: (ex * e + fx * f, ez * e + fz * f)  # noqa: E731
    cut = Polygon([W(e_max - 80, f_front), W(e_max, f_front), W(e_max, f_front + 40), W(e_max - 80, f_front + 40)])
    fence = ring.difference(cut).difference(b.poly.buffer(0.4))
    n = 0
    for g in getattr(fence, "geoms", [fence]):
        if isinstance(g, LineString) and g.length > 1.0:
            D.fences.append(("wood", VET_FENCE_HEIGHT, g.simplify(0.1)))
            n += 1
    D.keep_out.append(lot.exterior.buffer(0.8))
    D.notes.append(f"landmark: vet clinic fence ({fence.length:.0f} m in {n} pieces)")


def apply(D: Dressing, dressed: list[Building], layers, road, sidewalk, playable) -> None:
    by_id = {b.osm_id: b for b in dressed if getattr(b, "dress", None)}
    near = unary_union([b.poly for b in dressed]).envelope.buffer(120)
    road, sidewalk = road.intersection(near), sidewalk.intersection(near)
    if HOME_SLICE_ID in by_id and "f" in by_id[HOME_SLICE_ID].dress:  # type: ignore[attr-defined]
        home_slice(D, by_id[HOME_SLICE_ID], road, sidewalk)
    vet = by_id.get(VET_ID)
    if vet is None:  # the clinic sits just outside the dressed area's edge on some edits: look it up
        vet = next((b for b in layers.buildings if b.osm_id == VET_ID), None)
    if vet is not None:
        if not getattr(vet, "dress", None):
            vet.dress = {}  # type: ignore[attr-defined]
        vet_clinic(D, vet, layers.streets, road, sidewalk)
