"""Terrain heightmap from USGS 3DEP (bare-earth DEM, best available resolution).

Output: public/map/terrain.bin  — Int16 little-endian, row-major (rows = +z / south, cols = +x / east),
heights in centimeters relative to the origin's ground elevation. Grid points are at
x = x0 + col*res, z = z0 + row*res. x0/z0 are aligned to the tile grid so ground meshes line up exactly.
"""

from __future__ import annotations

import io
import time
from pathlib import Path

import numpy as np
import requests
from PIL import Image

from projection import Projector

DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
RESOLUTION_M = 5.0
MAX_REQUEST_PX = 2000  # stay well under the service's image size limit


def _fetch_block(e_min: float, n_min: float, e_max: float, n_max: float, w: int, h: int) -> np.ndarray:
    params = {
        "bbox": f"{e_min},{n_min},{e_max},{n_max}", "bboxSR": 32614, "imageSR": 32614,
        "size": f"{w},{h}", "format": "tiff", "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation", "f": "image",
    }
    for attempt in range(4):
        try:
            r = requests.get(DEM_URL, params=params, timeout=180,
                             headers={"User-Agent": "hyde-park-dog-map-pipeline/0.1"})
            r.raise_for_status()
            if "tiff" not in r.headers.get("content-type", ""):
                raise RuntimeError(f"unexpected response: {r.text[:200]}")
            img = Image.open(io.BytesIO(r.content))
            arr = np.array(img, dtype=np.float32)
            if arr.shape != (h, w):
                raise RuntimeError(f"unexpected DEM shape {arr.shape}, wanted {(h, w)}")
            return arr
        except Exception as err:
            print(f"[terrain]   request failed ({err}); retrying")
            time.sleep(4 * (attempt + 1))
    raise RuntimeError("3DEP download failed")


def build_terrain(proj: Projector, x0: float, z0: float, x1: float, z1: float, cache_dir: Path,
                  out_file: Path, refresh: bool = False) -> dict:
    """Sample the DEM on a RESOLUTION_M grid covering [x0,x1]x[z0,z1] (world). Returns index metadata."""
    res = RESOLUTION_M
    cols = int(round((x1 - x0) / res)) + 1
    rows = int(round((z1 - z0) / res)) + 1
    cache = cache_dir / f"dem_{x0:.0f}_{z0:.0f}_{cols}x{rows}_{res:g}m.npy"
    if cache.exists() and not refresh:
        grid = np.load(cache)
        print(f"[terrain] using cache {cache.name}")
    else:
        grid = np.zeros((rows, cols), dtype=np.float32)
        # Pixel centers must land on grid points: extend each request by half a pixel.
        for r0 in range(0, rows, MAX_REQUEST_PX):
            for c0 in range(0, cols, MAX_REQUEST_PX):
                h = min(MAX_REQUEST_PX, rows - r0)
                w = min(MAX_REQUEST_PX, cols - c0)
                bx0 = x0 + c0 * res - res / 2
                bx1 = x0 + (c0 + w - 1) * res + res / 2
                bz0 = z0 + r0 * res - res / 2
                bz1 = z0 + (r0 + h - 1) * res + res / 2
                # World z -> northing: n = N0 - z. Image row 0 is the north edge (smallest z).
                print(f"[terrain] downloading {w}x{h} block from USGS 3DEP ...")
                block = _fetch_block(proj.e0 + bx0, proj.n0 - bz1, proj.e0 + bx1, proj.n0 - bz0, w, h)
                grid[r0:r0 + h, c0:c0 + w] = block
        cache_dir.mkdir(parents=True, exist_ok=True)
        np.save(cache, grid)

    nodata = (grid < -1000) | ~np.isfinite(grid)
    if nodata.any():
        print(f"[terrain] warning: {int(nodata.sum())} no-data samples, filled with the median")
        grid[nodata] = float(np.median(grid[~nodata]))

    # Origin elevation by bilinear sampling at world (0, 0).
    fc, fr = (0 - x0) / res, (0 - z0) / res
    c, r = int(fc), int(fr)
    tx, tz = fc - c, fr - r
    e00, e10, e01, e11 = grid[r, c], grid[r, c + 1], grid[r + 1, c], grid[r + 1, c + 1]
    origin_elev = float((e00 * (1 - tx) + e10 * tx) * (1 - tz) + (e01 * (1 - tx) + e11 * tx) * tz)

    rel_cm = np.round((grid - origin_elev) * 100).astype("<i2")
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_bytes(rel_cm.tobytes())
    rel = grid - origin_elev
    print(f"[terrain] {cols}x{rows} @ {res:g} m, relative height {rel.min():.1f} .. {rel.max():.1f} m, "
          f"origin elevation {origin_elev:.2f} m -> {out_file.name} ({out_file.stat().st_size / 1024:.0f} KB)")
    return {
        "file": out_file.name, "x0": x0, "z0": z0, "res": res, "cols": cols, "rows": rows,
        "scale": 0.01, "originElevation": round(origin_elev, 3), "source": "USGS 3DEP (bare earth)",
        "minHeight": round(float(rel.min()), 2), "maxHeight": round(float(rel.max()), 2),
    }
