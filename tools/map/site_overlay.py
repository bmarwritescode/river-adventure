"""Draw the generated map data over aerial imagery, to measure and check hero locations.

    npm run map:site -- --at=home-slice            (a place id from src/config/places.ts, or x,z)
    npm run map:site -- --at=575,-1000 --zoom=21 --radius=45

Writes tools/map/out/site_<name>.jpg: aerial imagery (Esri World Imagery, downloaded once into
tools/map/cache/imagery/; a reference for authoring only, never shipped with the game) with the
tile data drawn on top: building footprints (red), ground layers (tinted), stall/lane lines (white),
fences (by kind), cars (yellow boxes, red = nose), trees (green rings), other props (magenta), and
for landmarks the site frame as a 2 m grid (a along the storefront, b out of it; 10 m lines red).

Reads only the pipeline's OUTPUT (public/map), so run `npm run map:build` first.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from io import BytesIO
from pathlib import Path

import requests
from PIL import Image, ImageDraw

import config
from projection import Origin, Projector

TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
CACHE = config.MAP_DIR / "cache" / "imagery"
ROOT = config.MAP_DIR.parent.parent
AREA_COLORS = {
    "parking": (120, 120, 120, 110), "patio": (210, 130, 60, 130), "turf": (40, 255, 40, 120),
    "walk": (255, 255, 255, 110), "driveway": (255, 255, 170, 100), "bed": (120, 70, 30, 110),
    "sidewalk": (255, 200, 255, 60), "road": (60, 60, 255, 45),
}
FENCE_COLORS = {"wood": (255, 140, 0), "cedar": (255, 0, 255), "iron": (0, 0, 0), "picket": (255, 255, 255),
                "chain": (0, 255, 255)}


def place_xz(at: str) -> tuple[float, float, str]:
    m = re.fullmatch(r"\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*", at)
    if m:
        return float(m.group(1)), float(m.group(2)), f"{float(m.group(1)):.0f}_{float(m.group(2)):.0f}"
    src = (ROOT / "src/config/places.ts").read_text()
    m = re.search(r"id:\s*'" + re.escape(at) + r"'[^}]*?x:\s*(-?[\d.]+),\s*z:\s*(-?[\d.]+)", src)
    if not m:
        raise SystemExit(f"unknown place '{at}' (use a place id from src/config/places.ts or x,z)")
    return float(m.group(1)), float(m.group(2)), at


def fetch_tile(z: int, x: int, y: int) -> Image.Image:
    f = CACHE / f"{z}_{x}_{y}.jpg"
    if not f.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        r = requests.get(TILE_URL.format(z=z, x=x, y=y), headers={"User-Agent": "map-pipeline/0.1"}, timeout=30)
        r.raise_for_status()
        f.write_bytes(r.content)
    return Image.open(BytesIO(f.read_bytes())).convert("RGB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--at", required=True)
    ap.add_argument("--zoom", type=int, default=20)
    ap.add_argument("--radius", type=float, default=60.0, help="half size of the view, meters")
    args = ap.parse_args()

    origin = json.loads((ROOT / "src/world/mapOrigin.json").read_text())
    P = Projector(Origin(origin["lat"], origin["lon"]))
    cx, cz, name = place_xz(args.at)
    z = args.zoom
    n = 2 ** z

    def merc(wx: float, wz: float) -> tuple[float, float]:
        lat, lon = P.to_latlon(wx, wz)
        return (lon + 180) / 360 * n * 256, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n * 256

    x0, y0 = merc(cx - args.radius, cz - args.radius)
    x1, y1 = merc(cx + args.radius, cz + args.radius)
    tx0, ty0, tx1, ty1 = int(x0 // 256), int(y0 // 256), int(x1 // 256), int(y1 // 256)
    img = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            img.paste(fetch_tile(z, tx, ty), ((tx - tx0) * 256, (ty - ty0) * 256))

    def px(wx: float, wz: float) -> tuple[float, float]:
        mx, my = merc(wx, wz)
        return mx - tx0 * 256, my - ty0 * 256

    ov = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    near = lambda pts: any(abs(x - cx) < args.radius * 1.5 and abs(zz - cz) < args.radius * 1.5 for x, zz in pts)  # noqa: E731
    pairs = lambda flat: [(flat[i], flat[i + 1]) for i in range(0, len(flat) - 1, 2)]  # noqa: E731
    landmarks = []
    for f in sorted((ROOT / "public/map/tiles").glob("*.json")):
        t = json.loads(f.read_text())
        for kind, polys in t["areas"].items():
            if kind not in AREA_COLORS:
                continue
            for poly in polys:
                pts = pairs(poly[0])
                if near(pts):
                    d.polygon([px(*p) for p in pts], fill=AREA_COLORS[kind])
        for b in t["buildings"]:
            pts = pairs(b["r"][0])
            if near(pts):
                d.polygon([px(*p) for p in pts], outline=(255, 0, 0, 255))
                if b.get("d", {}).get("lm"):
                    landmarks.append(b["d"]["lm"])
        for m in t.get("marks", []):
            pts = pairs(m["p"])
            if near(pts):
                d.line([px(*p) for p in pts], fill=(255, 255, 255, 255), width=1)
        for fe in t.get("fences", []):
            pts = pairs(fe["p"])
            if near(pts):
                d.line([px(*p) for p in pts], fill=(*FENCE_COLORS.get(fe["t"], (255, 0, 0)), 255), width=3)
        for kind, arr in (t.get("props") or {}).items():
            for i in range(0, len(arr), 5):
                x, zz, rot = arr[i], arr[i + 1], arr[i + 2]
                if not near([(x, zz)]):
                    continue
                q = px(x, zz)
                if kind == "car":
                    fx, fz = -math.sin(rot), -math.cos(rot)
                    sx, sz = -fz, fx
                    c = [(x + fx * 2.3 + sx * 0.9, zz + fz * 2.3 + sz * 0.9), (x + fx * 2.3 - sx * 0.9, zz + fz * 2.3 - sz * 0.9),
                         (x - fx * 2.3 - sx * 0.9, zz - fz * 2.3 - sz * 0.9), (x - fx * 2.3 + sx * 0.9, zz - fz * 2.3 + sz * 0.9)]
                    d.polygon([px(*p) for p in c], outline=(255, 255, 0, 255))
                    d.line([q, px(x + fx * 2.3, zz + fz * 2.3)], fill=(255, 0, 0, 255), width=2)
                elif kind.startswith("tree"):
                    d.ellipse([q[0] - 6, q[1] - 6, q[0] + 6, q[1] + 6], outline=(0, 255, 0, 255), width=3)
                else:
                    d.ellipse([q[0] - 3, q[1] - 3, q[0] + 3, q[1] + 3], fill=(255, 0, 255, 255))
    for lm in landmarks:
        (ox, oz), (ux, uz) = lm["o"], lm["u"]
        nx, nz = uz, -ux
        W = lambda a, b: px(ox + ux * a + nx * b, oz + uz * a + nz * b)  # noqa: E731
        for k in range(-20, 41, 2):
            col = (255, 255, 0, 200) if k == 0 else (255, 60, 60, 200) if k % 10 == 0 else (0, 200, 255, 110)
            d.line([W(k, -40), W(k, 26)], fill=col, width=1)
        for k in range(-40, 27, 2):
            col = (255, 255, 0, 200) if k == 0 else (255, 60, 60, 200) if k % 10 == 0 else (0, 200, 255, 110)
            d.line([W(-20, k), W(40, k)], fill=col, width=1)
    out = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
    lx, ly = px(cx - args.radius, cz - args.radius)
    hx, hy = px(cx + args.radius, cz + args.radius)
    out = out.crop((int(lx), int(ly), int(hx), int(hy)))
    dst = config.MAP_DIR / "out" / f"site_{name}.jpg"
    dst.parent.mkdir(exist_ok=True)
    out.save(dst, quality=90)
    print(f"[site] {dst} ({out.size[0]}x{out.size[1]} px, {args.radius * 2 / out.size[0] * 100:.1f} cm/px)")


if __name__ == "__main__":
    main()
