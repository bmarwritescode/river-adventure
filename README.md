# Hyde Park Dog

A small stylized 3D browser game: explore Austin's Hyde Park as a dog. Vite + TypeScript + three.js.

## Setup

Requires Node 22 (pinned in `.nvmrc`).

```sh
nvm use
npm install
npx playwright install chromium webkit   # once, for tests
```

## Run

```sh
npm run dev      # http://localhost:5173 (hot reload)
npm run build    # type-check + production build to dist/
npm run preview  # serve the built dist/
npm test         # unit tests (Vitest) + Playwright smoke & stability tests (Chromium + WebKit), ~3 min
npm run test:unit
npm run test:e2e
npm run check    # quick check (~15 s); runs automatically as a git pre-commit hook
npm run perf     # performance benchmark vs perf/budget.json (report: perf/reports/latest.json)
npm run test:soak  # long random-wander stability test (SOAK_SECONDS=120, SOAK_SEED=...)
npm run dog:build  # regenerate the placeholder rigged dog (public/models/dog_main.glb)
npm run shots      # art-review screenshots of the dressed block (tools/shots/out/)
```

`dist/` is a static site (relative paths), so it can be shared by uploading it to any static host.

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows | Move (camera-relative). Default pace = trot |
| Shift (hold) | Run |
| Alt/Option (hold) or C (toggle) | Walk |
| Space | Jump |
| E (hold) | Sniff (crawl, head down, camera low and close) |
| X | Sit / stand up (the dog also sits by itself after idling ~12 s) |
| B | Play bow |
| Click | Mouse look (pointer lock); Esc releases |
| Drag (left/right button) | Orbit without pointer lock |
| Mouse wheel | Zoom |
| P | Copy dog position as `{ x: …, z: … }` |
| T | Show/hide trigger zones |
| M | Top-down map view (wheel zooms; W = north while it's on) |
| G | Performance overlay (frame-time graph, CPU time, draw calls, memory) |
| ` (backtick) | Tuning panel (includes the **Teleport** dropdown) |

Start somewhere specific with `?at=<place id>`, e.g. `http://localhost:5173/?at=art-block` (the fully
dressed Duval block), or `?at=x,z,heading` (ids are in `src/config/places.ts`). Debug extras: `?ui=0` hides
the UI, `?cam=x,y,z,lookX,lookY,lookZ` fixes the camera (heights above ground).

See `CLAUDE.md` for architecture contracts and conventions.

## Map pipeline (offline)

The game never fetches map data at runtime; an offline Python pipeline in `tools/map/` produces it.
Requires [uv](https://docs.astral.sh/uv/) (it installs the pinned Python 3.12 environment on first run).

```sh
npm run map:build                       # uses cached OSM data in tools/map/cache/
npm run map:build -- --refresh          # re-download from OpenStreetMap (Overpass API)
npm run map:build -- --regen-boundary   # re-derive tools/map/boundary.geojson from the streets
npm run map:build -- --regen-origin     # re-pin the origin (moves every world coordinate!)
```

Takes ~30 s (5 s once the elevation data is cached). Extra flags: `--skip-terrain` (flat map),
`--refresh-terrain` (re-download elevation).

Outputs:
- `src/world/mapOrigin.json`: map origin (E 45th St & Duval St), shared by the pipeline and the game.
- `tools/map/boundary.geojson`: play-area boundary. Hand-editable; paste into geojson.io to view or edit.
- `tools/map/out/preview.png`: preview of streets, buildings, boundary and origin.
- `public/map/index.json`, `public/map/tiles/{i}_{j}.json`: 250 m map tiles (data, not meshes).
- `public/map/terrain.bin`: USGS 3DEP heightmap (5 m grid).
- `tools/map/dress_area.geojson`: the art-dressed area (editable). Per-building fixes: `tools/map/overrides.json`.
  Art rules: `docs/art-direction.md`.

The generated `public/map` files are committed, so the game runs without Python.

## Attribution

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
Open Database License (ODbL). Elevation data: U.S. Geological Survey 3D Elevation Program (public domain).
