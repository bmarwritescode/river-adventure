"""Render a PNG preview of the map data (north up, 1 grid square = 250 m)."""

from __future__ import annotations

import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.patheffects as pe  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Polygon as MplPolygon  # noqa: E402
from shapely.geometry import LineString, Polygon  # noqa: E402

import config  # noqa: E402
from boundary import Boundary  # noqa: E402
from osm_parse import OsmData, merge_lines  # noqa: E402

ROAD_STYLE = {
    # highway class: (color, linewidth in points)
    "motorway": ("#b5523b", 3.0), "motorway_link": ("#b5523b", 1.2), "trunk": ("#c96a3c", 2.6),
    "primary": ("#d8902f", 2.4), "primary_link": ("#d8902f", 1.0), "secondary": ("#c9b03a", 2.0),
    "secondary_link": ("#c9b03a", 1.0), "tertiary": ("#777", 1.6), "tertiary_link": ("#777", 0.9),
    "residential": ("#555", 1.0), "unclassified": ("#555", 1.0), "living_street": ("#555", 0.9),
    "service": ("#888", 0.5), "footway": ("#4a8f5a", 0.35), "path": ("#4a8f5a", 0.35),
    "cycleway": ("#3a7fbf", 0.35), "pedestrian": ("#4a8f5a", 0.5), "steps": ("#4a8f5a", 0.35),
    "track": ("#8a6a4a", 0.4),
}


def _to_plot(coords):
    # World z is south-positive; plot north up.
    return [x for x, _ in coords], [-z for _, z in coords]


def render_preview(osm: OsmData, b: Boundary, out_file: Path, stats: dict, playable: Polygon | None = None) -> None:
    boundary = b.polygon
    margin = boundary.buffer(config.MARGIN_M, join_style="mitre")
    minx, minz, maxx, maxz = margin.buffer(80).bounds
    w_m, h_m = maxx - minx, maxz - minz
    scale = 1 / 1.25  # inches per 100 m -> ~0.8 px/m at dpi 100
    fig, ax = plt.subplots(figsize=(w_m / 100 * scale + 2, h_m / 100 * scale + 2.2), dpi=110)
    ax.set_facecolor("#f4f1ea")
    view = margin.buffer(60)

    # Buildings
    n_buildings = 0
    for w in osm.ways.values():
        if "building" in w.tags and w.closed and len(w.coords) >= 4:
            poly = Polygon(w.coords)
            if not poly.is_valid or not view.intersects(poly):
                continue
            xs, ys = _to_plot(w.coords)
            ax.fill(xs, ys, color="#b9b2a6", lw=0, zorder=2)
            n_buildings += 1

    # Roads by class (minor first)
    order = list(ROAD_STYLE)
    roads = [w for w in osm.ways.values() if w.tags.get("highway") in ROAD_STYLE and len(w.coords) >= 2]
    roads.sort(key=lambda w: -order.index(w.tags["highway"]))
    for w in roads:
        if not view.intersects(LineString(w.coords)):
            continue
        color, lw = ROAD_STYLE[w.tags["highway"]]
        xs, ys = _to_plot(w.coords)
        ax.plot(xs, ys, color=color, lw=lw, solid_capstyle="round", zorder=3)

    # Margin + boundary
    ax.add_patch(MplPolygon(list(zip(*_to_plot(margin.exterior.coords))), closed=True, fill=False,
                            ec="#d23", lw=1.0, ls=(0, (4, 4)), zorder=5))
    ax.add_patch(MplPolygon(list(zip(*_to_plot(boundary.exterior.coords))), closed=True, fill=False,
                            ec="#d23", lw=2.6, zorder=6))
    if playable is not None:  # where the dog can actually walk (near curb of the boundary streets)
        ax.add_patch(MplPolygon(list(zip(*_to_plot(playable.exterior.coords))), closed=True, fill=False,
                                ec="#0a8a3a", lw=1.4, zorder=7))
    for seg in b.connectors:  # synthetic stretches with no real street
        cx, cy = _to_plot(seg.coords)
        ax.plot(cx, cy, color="#1a9fff", lw=3.2, zorder=7, solid_capstyle="butt")
    bx, by = _to_plot(boundary.exterior.coords)
    ax.plot(bx, by, "o", color="#d23", ms=2.5, zorder=6)

    # Origin
    ax.plot([0], [0], marker="*", color="#e0218a", ms=18, mec="white", mew=1.2, zorder=8)
    ax.annotate("origin (0,0)\nE 45th & Duval", (0, 0), xytext=(12, -22), textcoords="offset points",
                fontsize=9, color="#e0218a", weight="bold", zorder=9,
                path_effects=[pe.withStroke(linewidth=3, foreground="white")])

    # Street labels: at the middle of the longest merged run of each street inside the margin area.
    halo = [pe.withStroke(linewidth=3, foreground="white")]
    for name in config.LABEL_STREETS:
        lines = [LineString(w.coords) for w in osm.highway_ways(name=name) if len(w.coords) >= 2]
        if not lines:
            continue
        merged = merge_lines(lines).intersection(boundary.buffer(config.MARGIN_M * 0.5))
        parts = [g for g in getattr(merged, "geoms", [merged]) if isinstance(g, LineString) and not g.is_empty]
        if not parts:
            continue
        longest = max(parts, key=lambda g: g.length)
        if longest.length < 120:
            continue
        mid = longest.interpolate(0.5, normalized=True)
        a = longest.interpolate(max(0.0, longest.project(mid) - 20))
        b = longest.interpolate(min(longest.length, longest.project(mid) + 20))
        ang = math.degrees(math.atan2(-(b.y - a.y), b.x - a.x))
        if ang > 90:
            ang -= 180
        if ang < -90:
            ang += 180
        short = (name.replace("Street", "St").replace("Boulevard", "Blvd").replace("Avenue", "Ave")
                 .replace("East ", "E ").replace("West ", "W ").replace("North ", "N "))
        ax.text(mid.x, -mid.y, short, rotation=ang, rotation_mode="anchor", ha="center", va="center",
                fontsize=9, weight="bold", color="#123", zorder=10, path_effects=halo)

    # Grid every 250 m (matches the planned tile size)
    ax.set_xlim(minx, maxx)
    ax.set_ylim(-maxz, -minz)
    ax.set_aspect("equal")
    ax.set_xticks(range(int(minx // 250) * 250, int(maxx) + 1, 250))
    ax.set_yticks(range(int(-maxz // 250) * 250, int(-minz) + 1, 250))
    ax.tick_params(labelsize=7)
    ax.grid(True, color="#00000018", lw=0.6)
    ax.set_xlabel("x (m, east)")
    ax.set_ylabel("north (m) = -z")

    title = (f"Hyde Park play area — boundary {boundary.area / 1e6:.2f} km² ({boundary.area / 2.59e6:.2f} sq mi), "
             f"red = boundary (street centerlines), green = playable edge (near curb), blue = synthetic connector, dashed = +{config.MARGIN_M:.0f} m margin")
    ax.set_title(title, fontsize=10)
    lines = [f"{k}: {v}" for k, v in stats.items()]
    ax.text(0.01, 0.01, "\n".join(lines), transform=ax.transAxes, fontsize=7.5, va="bottom", ha="left",
            family="monospace", zorder=11, bbox=dict(fc="white", ec="#999", alpha=0.85))
    ax.text(0.99, 0.005, "© OpenStreetMap contributors", transform=ax.transAxes, fontsize=7,
            ha="right", va="bottom", color="#333", zorder=11)

    out_file.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_file, bbox_inches="tight")
    plt.close(fig)
    print(f"[preview] wrote {out_file} ({n_buildings} buildings drawn)")
