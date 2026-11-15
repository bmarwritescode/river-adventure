"""Download raw OSM data for the play area from Overpass and cache it on disk.

The game never calls this; it only reads the pipeline's output files.
Re-runs use the cache unless `refresh=True`.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import requests

CACHE_DIR = Path(__file__).parent / "cache"
RAW_FILE = CACHE_DIR / "osm_raw.json"

# Generous fetch box (south, west, north, east) in WGS84 degrees. Deliberately larger than the
# play area (38th–56th St, Guadalupe–Airport Blvd) so the boundary streets and the ~150 m margin
# are always fully covered; everything is clipped to boundary + margin later.
FETCH_BBOX = (30.2860, -97.7520, 30.3360, -97.6980)

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Everything Step 2 needs, in one query (so the cache covers 2A and 2B).
QUERY = """
[out:json][timeout:300];
(
  way["highway"]({bbox});
  way["building"]({bbox});
  relation["building"]({bbox});
  way["building:part"]({bbox});
  way["landuse"]({bbox});
  way["leisure"]({bbox});
  way["natural"]({bbox});
  way["waterway"]({bbox});
  way["water"]({bbox});
  way["amenity"="parking"]({bbox});
  way["railway"]({bbox});
  relation["type"="multipolygon"]({bbox});
  node["natural"="tree"]({bbox});
);
out body;
>;
out skel qt;
"""


def fetch_osm(refresh: bool = False) -> dict:
    """Return the raw Overpass JSON, from cache when available."""
    if RAW_FILE.exists() and not refresh:
        print(f"[osm] using cache {RAW_FILE.relative_to(Path.cwd()) if RAW_FILE.is_relative_to(Path.cwd()) else RAW_FILE}")
        return json.loads(RAW_FILE.read_text())

    s, w, n, e = FETCH_BBOX
    query = QUERY.replace("{bbox}", f"{s},{w},{n},{e}")
    last_err: Exception | None = None
    for url in OVERPASS_URLS:
        for attempt in range(3):
            try:
                print(f"[osm] downloading from {url} (attempt {attempt + 1}) ...")
                r = requests.post(
                    url,
                    data={"data": query},
                    timeout=360,
                    headers={"User-Agent": "hyde-park-dog-map-pipeline/0.1", "Accept": "*/*"},
                )
                r.raise_for_status()
                data = r.json()
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                meta = {"fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "bbox": FETCH_BBOX, "url": url}
                data["_meta"] = meta
                RAW_FILE.write_text(json.dumps(data))
                print(f"[osm] cached {len(data.get('elements', []))} elements -> {RAW_FILE}")
                return data
            except Exception as err:  # network / rate limit: back off and retry
                last_err = err
                print(f"[osm]   failed: {err}")
                time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Overpass download failed: {last_err}")
