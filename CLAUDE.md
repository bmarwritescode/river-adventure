# Hyde Park Dog — project rules for Claude

A small, stylized low-poly 3D browser game (Vite + TypeScript + three.js). You play as the
owner's real dog exploring **Hyde Park and surroundings in Austin, TX**: roughly **38th St (S) to
56th St (N)** and **Guadalupe St (W) to Airport Blvd (E)**, about one square mile. Must run well in
desktop Chrome and Safari on a Mac and be shareable as a link (static build).

The owner is an experienced programmer but new to game dev. Explain game-dev-specific choices briefly.

## Priorities (in order)

1. **The dog is recognizable** as the real dog (proportions, coloring, markings, signature traits; stylized is fine).
2. **The neighborhood is recognizable** to locals: real street grid + building footprints from OpenStreetMap, plus hand-made landmarks.
3. **Playable without major/frequent issues**: stable performance, no frequent bugs.

## Gameplay

- **Core (required): scavenger hunt.** The dog is looking for its owners and follows a chain of clues.
  Each clue points to a real place; there the dog finds the next clue (reach the spot, sniff it out, or find an object).
  The last clue leads home → owners found → ending.
- The hunt is **data-driven**: an ordered list of steps (clue text, target location, how it's found) in a
  **typed TS module** (`src/hunt/clues.ts`), separate from game logic. Editing/re-placing a clue must be fast
  (P key copies the dog's position as a snippet). Progress is saved between sessions.
- **Stretch goals (don't design them out):** (a) house interior: separate small level loaded when the dog enters
  the front door, unlocked by finishing the hunt; (b) second playable dog: smaller, different speeds/camera/collision,
  can fit through gaps the big dog can't; selectable after a bonus mission.

## Roadmap

1. Skeleton: project, box-dog, third-person camera, movement. ✅
2. Real map as gray blocks: offline script pulls OSM streets/footprints, converts to local meters, writes tiles; game streams tiles near the dog. ✅
3. Crude real-dog test: rigged .glb with named clips, end to end (+ sit and play bow). ✅
4. Stability baseline: perf budget + automated smoke tests after every change. ✅
5. Art direction on one fully dressed block (Duval 51st→53rd; see `docs/art-direction.md`). ✅
6. Make the dog recognizable (art iteration).
7. Fill the neighborhood: procedural houses, trees, street dressing, landmarks.
8. Scavenger hunt: clue chain, clue UI, sniffing/scent trails, ending at home, save/load, polish (sound, map, ambient life).
9. Stretch goals: house interior, then the second dog.

## Contracts (rules for all sessions)

### Coordinates & units

- 1 unit = 1 meter. **Y is up.** **+X = east, −Z = north** (so +Z = south).
- Heading: 0 = facing north (−Z), positive = counter-clockwise from above (same as three.js `rotation.y`).
  Use `headingToForward` / `forwardToHeading` in `src/core/math.ts`.
- Map origin (0,0,0) = intersection of **E 45th St & Duval St**. Real coords are projected with
  **UTM zone 14N (EPSG:32614)** and offset so that intersection is the origin.
  The origin lat/lon lives in ONE constant: `MAP_ORIGIN` in `src/world/geo.ts` (placeholder until Step 2).

### The dog

- Real dimensions (placeholder geometry must match; tune in config):
  ~50 lb (~23 kg), lean and fairly tall; head up, reaches about the waist of a 1.75 m man.
  Withers 0.63 m · nose-to-tail-base 0.95 m · top of head 0.88 m · chest width 0.24 m.
- Appearance (reference for all art): build between a whippet and a pit bull: whippet-like leanness
  (deep chest, narrow waist, long legs) with a pit-bull-like head (broad skull, strong jaw).
  Coat mostly **black** with a **white "tuxedo" chest and front**, and **brown on the lower half of the legs**.
- **DogProfile** (`src/config/dogProfiles.ts`): ALL per-dog values (dimensions, speeds, accelerations, turn
  rates, jump, collision radius, camera framing, colors, later model path). Never hard-code dog numbers in the
  controller, camera or visual. Code must work for any profile (a smaller second dog is just another profile).
- **Controller/visual split:** `DogController` owns position, heading, velocity, state; never touches meshes.
  `DogVisual` only reads controller state and renders/animates. **Nothing outside `DogVisual` touches dog meshes.**
  Swapping the box dog for a real model changes only `DogVisual`.
- States (exact names): movement `idle`, `walk`, `trot`, `run`, `sniff`, `jump`, plus action states `sit`
  (X toggles; also automatic after idling) and `playBow` (B). Actions only start once the dog has stopped;
  movement/sniff/jump input cancels them.
- Dog models are `.glb` with animation clips named exactly: `idle`, `walk`, `trot`, `run`, `sniff`, `jump`, `sit`,
  `playBow` (list in `src/dog/clips.ts`).

### Dog model conventions (any .glb that replaces the generated one must follow these)

- 1 unit = 1 m, Y up, the dog faces **+Z** (glTF convention; `ModelDogRig` turns it to the game's −Z),
  origin on the ground under the body's middle. One skinned mesh preferred (1 draw call).
- Clips as above. Locomotion clips (`walk`, `trot`, `run`) are exactly ONE stride cycle: playback speed is set
  from ground speed and `TUNING.visual.stride*`, so paws don't slide. `jump` is one-shot and is stretched to the
  real air time. `sit` / `playBow` are looping held poses; the cross-fade into them is the transition.
- Optional `extras.dims` (= `shoulderHeight`, `length`, `headTopHeight`, `chestWidth` as authored) lets the game
  scale the model to the DogProfile exactly; otherwise it scales by bounding-box height.
- Current model: `public/models/dog_main.glb`, generated by `npm run dog:build` (`tools/dog/buildDogModel.ts`)
  from the profile dimensions/colors. It's a crude stand-in; the Step 6 art model replaces it.
- `DogVisual` shows the box dog (`BoxDogRig`) until the model loads and keeps it if loading fails.

### World

- All ground queries go through **`getGroundHeight(x, z)`** (`src/world/ground.ts`). It samples the terrain heightmap
  piecewise-planar, on exactly the same triangles as the rendered ground mesh (so anything placed with it sits on the visible ground).
- All obstacle collision goes through **`CollisionWorld`** (`src/world/collision.ts`): dog = circle in XZ vs
  obstacle footprints (2D polygons, convex or concave, extruded to a height). Grid broadphase. Push-out resolution
  → sliding along walls. Also provides `raycast` (used by the camera). Test boxes today, OSM footprints later.
  Build obstacle meshes from the same footprint (`extrudeFootprint`) so visuals and collision never drift.
- **Trigger zones:** ONE module, `TriggerSystem` (`src/world/triggers.ts`): named circles/polygons in world XZ
  firing enter/exit events (dog center point, with exit hysteresis). Clue locations, the front door and future
  missions are built on it. Gameplay places are stored in **world coordinates** so they stay valid as the map fills in.
- **Game state:** all progress (hunt step, unlocks, active dog) in ONE serializable object
  (`src/game/GameState.ts`), separate from rendering. Save/load = (de)serialize it; stretch-goal unlocks are flags.
  Bump `SAVE_VERSION` + add a migration when its shape changes.
- All models/assets are glTF binary (`.glb`), under `public/models/`.

### Map pipeline

- Offline only: `tools/map/` (Python 3.12 via uv, pinned in `uv.lock`), run with `npm run map:build`.
  The game only reads its output files; never fetch OSM at runtime.
- Raw OSM download is cached in `tools/map/cache/` (gitignored); `--refresh` re-downloads.
- The origin is pinned in `src/world/mapOrigin.json` (shared by Python and TS). Don't re-pin casually: it shifts all coordinates.
- The play-area boundary lives in `tools/map/boundary.geojson` (lat/lon), the editable source of truth. It runs
  along street centerlines; the pipeline derives the PLAYABLE area from it by removing the surfaces of the roads
  along it, so the dog stays on the near side of Guadalupe/38th/56th/Koenig/Airport/I-35 (never on them).
  `index.json` `boundary` = playable area; `places.test.ts` keeps every place inside it.
- OSM attribution ("© OpenStreetMap contributors") must stay visible in the game and README.
- Output: `public/map/index.json` + `tiles/{i}_{j}.json` (250 m world-grid tiles, DATA not meshes) +
  `terrain.bin` (Int16 cm, 5 m grid aligned to tiles). Schema: `src/world/map/types.ts` ↔ `tools/map/tiles.py`;
  bump `MAP_DATA_VERSION` in both when it changes (now 2). Generated files are committed.
- Game side (`src/world/map/`): `MapWorld` streams tiles around the dog; `tileWorker.ts` builds meshes in a
  Web Worker (pure builders in `buildTile.ts`). Per tile: ONE ground mesh (terrain grid with the surface layers
  painted into a texture; colors in `src/config/mapStyle.ts`) + ONE merged building mesh. Building footprints
  go to `CollisionWorld`; the boundary is invisible collision walls. The dog is frozen until the tiles around it
  (and their collision) are loaded.
- Named places (spawn, teleport list, test zones) live in `src/config/places.ts`.
- **Dressing (Step 5+):** inside `tools/map/dress_area.geojson`, `tools/map/dress.py` decides WHAT goes WHERE
  (building kind/front/door/porch/roof, driveways, walks, trees, poles, signs, markings, ...) and writes it into the
  tiles; `src/world/map/dress/` (in the worker) decides HOW it looks. Per-building corrections:
  `tools/map/overrides.json` (by OSM id). Palette: `MAP_STYLE.dress`. Houses + props merge into the tile's building
  mesh; one decal mesh (draped hard surfaces + markings + wires, no shadows) and one sign mesh (text atlas) per tile.
  Art rules and budgets: `docs/art-direction.md`. Review art changes with `npm run shots` (fixed views).

### Code conventions

- Layout: `src/core` (loop, Game wiring, math), `src/input`, `src/dog`, `src/camera`, `src/world`, `src/debug`,
  `src/config`, `src/game` (game state), later `src/hunt`.
- **All tunable numbers** live in config (`src/config/tuning.ts` for global, `dogProfiles.ts` per dog,
  `keys.ts` for bindings) and are exposed in the lil-gui panel (backtick). No magic numbers scattered in code.
- Game loop (`src/core/loop.ts`): fixed-timestep sim (60 Hz) + interpolated rendering; large frame deltas clamped.
  Sim code goes in `step(dt)`; visuals/camera use the interpolated pose in `render(alpha, frameDt)`.
  Use `damp(sharpness, dt)` for frame-rate-independent smoothing.
- Dispose three.js geometries/materials/textures when removing objects.
- Strict TypeScript (`noUncheckedIndexedAccess` on). Keep dependencies minimal; justify any new one.
- `window.__game` is a minimal **read-only** debug API (for tests). Don't let gameplay depend on it.

### Performance budget

- 60 fps on a recent Apple Silicon Mac in Chrome and Safari; 30 fps minimum on older hardware.
  Dev machine: 2021 MacBook Pro, M1 Max (that's the "recent Apple Silicon" reference).
- Keep draw calls low (instancing/merging where it matters). The overlay shows draw calls.
- The budget is enforced by `npm run perf` against `perf/budget.json` (frame times, stutters >50 ms,
  per-frame CPU time, draw calls, triangles, heap, tile build/finalize times, leaks, load/teleport times).

## Stability & performance (Step 4)

| Command | What | When |
| --- | --- | --- |
| `npm run check` | build + unit tests + 2 `@quick` smoke tests (WebKit), ~15 s | automatically on every commit (pre-commit hook) |
| `npm test` | unit + all smoke + stability tests, both browsers, ~3 min | after every change, before saying it's done |
| `npm run perf` | production build benchmark vs `perf/budget.json` (Chrome GPU, WebKit, Chrome CPU-throttled 4×) | after any change to rendering, map/streaming, assets, the dog visual or the loop; at the end of each roadmap step. Report the headline numbers. |
| `npm run shots` | fixed-camera screenshots of the art block → `tools/shots/out/` | after any visual change; compare with the previous set |
| `npm run test:soak` | seeded random wander checking invariants (`SOAK_SECONDS`, `SOAK_SEED`, `SOAK_AT=art-block`) | at the end of each roadmap step |

- Pre-commit hook: `.githooks/pre-commit` (enabled by `npm install` via `prepare`). Never bypass it with
  `--no-verify`; if it fails, fix the cause.
- Never loosen `perf/budget.json` just to make a run pass. A budget change needs a stated reason (e.g. a
  measurement artifact), recorded in its `_comment`. `npm run perf` also warns when a metric gets >30% worse than
  the previous run (`perf/reports/latest.json`); `perf/history.csv` keeps the trend. Commit both.
- In-game perf overlay: **G** (frame-time graph, CPU time, draws, triangles, geometries/textures, heap).
  Use it for checks in real Safari / other machines; headless numbers are a guide only.
- Low-end coverage is a proxy: CPU throttled 4× in Chrome. The GPU is NOT slowed, and on older Macs the GPU
  (fill rate, texture memory) is the likelier bottleneck. Watch triangles, texture sizes and overdraw.
- Leak check = renderer geometries/textures and collision obstacles NOT owned by loaded map tiles
  (`MapWorld.resources`) must be unchanged after teleporting around, read from a zoomed-out top-down view
  (three.js only counts resources once they've been drawn).

Lessons so far (keep following them):
- Heavy work goes in the tile worker; main-thread work per tile ("finalize") must stay well under a frame.
- Upload GPU resources when they're created (`renderer.initTexture`), not lazily on first view: lazy uploads
  stutter at unpredictable moments.
- Map ground textures are raw RGBA pixels (`DataTexture`), not ImageBitmaps: WebKit took 13–67 ms per
  ImageBitmap upload (vs ~2 ms), and keeping the pixels lets three.js re-upload after a WebGL context restore.
- Low frame rates expose streaming bugs (a tile re-request bug only showed at ~6 fps): keep testing in
  headless software-GL Chromium too.
- Benchmark routes must stay on open streets (a route that hits a wall measures nothing).
- Vertex colors are LINEAR in three.js: convert palette sRGB hex (`dress/MeshBuilder.rgb`) or everything looks washed out.
- Anything draped on the ground must follow the ground mesh's triangles exactly (`drapeTriangle` cuts along the
  5 m grid + diagonals); bilinear sampling + a small lift z-fights. Prefer exact draping over bigger lifts.

## Workflow rules

- Work in small steps. After each step run **`npm run build`** (type-check + build) and **`npm test`**
  (Vitest unit tests in `src/**/*.test.ts` + Playwright smoke/stability tests in `tests/`, Chromium + WebKit)
  and fix failures before saying it's done. Plus `npm run perf` / `npm run test:soak` per the table above.
- Use git; commit after each working step with a clear message.
- When something is ambiguous, state the assumption rather than silently guessing; ask only if a wrong guess is costly.
- At the end of each task report: what changed, how to run/test it, what to try or tune.

## Gotchas learned so far

- `npm run build` exits non-zero on type errors; never pipe it through grep/tail in a `&&` chain (that hides
  the failure). Also type-checks `tools/` via `tools/tsconfig.json` (Node types live only there).
- Node 22 via nvm (`.nvmrc`). The system Node is 18 and the nvm `default` alias is broken, so Claude's
  shell must run `. ~/.nvm/nvm.sh; nvm use` before npm commands (sourcing exits 3; ignore it, don't `&&` it).
- Playwright's WebKit doesn't populate `MouseEvent.movementX` for synthetic events; drag-orbit therefore uses
  clientX/Y deltas (pointer-lock mode still uses movementX, which real Safari supports).
- Headless Chromium uses software GL by default (FPS meaningless, ~6 fps). For real GPU numbers launch it with
  `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`. Slow frame rates also expose streaming bugs, so keep
  testing in the slow default too.
- Vite must run under Node 22: source nvm *before* starting `npx vite` in the same command.
- The shell's `rm` is interactive (prompts and hangs): use `rm -f`.
