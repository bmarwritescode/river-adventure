"""Pipeline configuration: everything you might want to tweak lives here."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # repo root
MAP_DIR = Path(__file__).resolve().parent
OUT_DIR = MAP_DIR / "out"
PUBLIC_MAP_DIR = ROOT / "public" / "map"  # game-readable output

# Single source of truth for the map origin, shared with the game (src/world/geo.ts imports it).
ORIGIN_FILE = ROOT / "src" / "world" / "mapOrigin.json"

# Hand-editable play-area boundary (GeoJSON, lat/lon). Generated on first run or with --regen-boundary;
# afterwards the pipeline uses the file as-is, so you can edit it (e.g. paste into geojson.io).
BOUNDARY_FILE = MAP_DIR / "boundary.geojson"

# Origin = the OSM node shared by these two streets.
ORIGIN_STREETS = ("East 45th Street", "Duval Street")

# Streets whose centerlines bound the play area. The boundary is the face of the planar graph formed by
# these lines that contains the origin (dual carriageways resolve to the inner side automatically).
BOUNDARY_STREETS = {
    "south": ["West 38th Street", "East 38th Street"],
    "north": ["West 56th Street", "East 56th Street"],
    "west": ["Guadalupe Street"],
    "east": ["Airport Boulevard"],
}

# Airport Blvd crosses I-35 near 45th St and swings ~1 km east of the highway, and 38th St is broken at I-35.
# True  -> close the south-east corner along I-35 (keeps the play area west of the interstate).
# False -> follow 38th St literally across I-35 to Airport Blvd (adds the area east of I-35).
CLOSE_SOUTHEAST_ALONG_I35 = True
I35_REF = "I 35"

# Extend dangling ends of the boundary streets by this many meters so they meet their neighbours
# (W 56th St stops ~350 m short of Guadalupe; 38th St is broken at I-35).
BOUNDARY_END_EXTENSION_M = 600.0

# Simplification tolerance for the boundary polygon, meters.
BOUNDARY_SIMPLIFY_M = 1.5

# Data beyond the boundary that is still rendered (so the world doesn't visibly end), meters.
MARGIN_M = 150.0

# Street labels in the preview (shown when present in the data).
LABEL_STREETS = [
    "Guadalupe Street", "Duval Street", "Speedway", "Red River Street", "Airport Boulevard",
    "West 38th Street", "East 38th Street", "East 41st Street", "East 43rd Street", "East 45th Street",
    "West 45th Street", "East 47th Street", "East 51st Street", "West 51st Street", "East 53rd Street",
    "East 56th Street", "West 56th Street", "Avenue A", "Avenue B", "Avenue C", "Avenue D", "Avenue F",
    "Avenue G", "Avenue H", "Harmon Avenue", "Lamar Boulevard", "North Lamar Boulevard",
    "North Loop Boulevard", "East North Loop Boulevard", "Hyde Park", "Waller Creek",
]
