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
2. Real map as gray blocks: offline script pulls OSM streets/footprints, converts to local meters, writes tiles; game streams tiles near the dog.
3. Crude real-dog test: rigged .glb with named clips, end to end.
4. Stability baseline: perf budget + automated smoke tests after every change.
5. Art direction on one fully dressed block.
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
- Movement states (exact names): `idle`, `walk`, `trot`, `run`, `sniff`, `jump`.
- Dog models are `.glb` with animation clips named exactly: `idle`, `walk`, `trot`, `run`, `sniff`, `jump`, `sit`.

### World

- All ground queries go through **`getGroundHeight(x, z)`** (`src/world/ground.ts`). Returns 0 today; later samples a heightmap.
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
- The play-area boundary lives in `tools/map/boundary.geojson` (lat/lon), the editable source of truth.
- OSM attribution ("© OpenStreetMap contributors") must stay visible in the game and README.
- Output: `public/map/index.json` + `tiles/{i}_{j}.json` (250 m world-grid tiles, DATA not meshes) +
  `terrain.bin` (Int16 cm, 5 m grid aligned to tiles). Schema: `src/world/map/types.ts` ↔ `tools/map/tiles.py`;
  bump `MAP_DATA_VERSION` in both when it changes. Generated files are committed.
- Game side (`src/world/map/`): `MapWorld` streams tiles around the dog; `tileWorker.ts` builds meshes in a
  Web Worker (pure builders in `buildTile.ts`). Per tile: ONE ground mesh (terrain grid with the surface layers
  painted into a texture; colors in `src/config/mapStyle.ts`) + ONE merged building mesh. Building footprints
  go to `CollisionWorld`; the boundary is invisible collision walls. The dog is frozen until the tiles around it
  (and their collision) are loaded.
- Named places (spawn, teleport list, test zones) live in `src/config/places.ts`.

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
- Keep draw calls low (instancing/merging where it matters). The overlay shows draw calls.

## Workflow rules

- Work in small steps. After each step run **`npm run build`** (type-check + build) and **`npm test`**
  (Vitest unit tests in `src/**/*.test.ts` + Playwright smoke tests in `tests/`, Chromium + WebKit) and fix
  failures before saying it's done.
- Use git; commit after each working step with a clear message.
- When something is ambiguous, state the assumption rather than silently guessing; ask only if a wrong guess is costly.
- At the end of each task report: what changed, how to run/test it, what to try or tune.

## Gotchas learned so far

- Node 22 via nvm (`.nvmrc`). The system Node is 18 and the nvm `default` alias is broken, so Claude's
  shell must run `. ~/.nvm/nvm.sh; nvm use` before npm commands (sourcing exits 3; ignore it, don't `&&` it).
- Playwright's WebKit doesn't populate `MouseEvent.movementX` for synthetic events; drag-orbit therefore uses
  clientX/Y deltas (pointer-lock mode still uses movementX, which real Safari supports).
- Headless Chromium uses software GL by default (FPS meaningless, ~6 fps). For real GPU numbers launch it with
  `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`. Slow frame rates also expose streaming bugs, so keep
  testing in the slow default too.
- Vite must run under Node 22: source nvm *before* starting `npx vite` in the same command.
