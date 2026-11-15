import * as THREE from 'three';
import { MAP_STYLE } from '../../config/mapStyle';
import { TUNING } from '../../config/tuning';
import type { Vec2 } from '../../core/math';
import type { CollisionWorld } from '../collision';
import { setTerrain } from '../ground';
import { closestPointOnPolygon, pointInPolygon, signedArea } from '../geometry2d';
import { Heightmap, type HeightmapMeta } from '../terrain';
import type { BuiltTile, WorkerRequest, WorkerResponse } from './tileWorker';
import { MAP_DATA_VERSION, tileKey, type FlatCoords, type MapIndex, type TileStreet } from './types';

interface LoadedTile {
  key: string;
  group: THREE.Group;
  /** Per-tile materials and textures (ground, signs) to dispose on unload. */
  materials: THREE.Material[];
  textures: THREE.Texture[];
  obstacleIds: string[];
  streets: TileStreet[];
  triangles: number;
  dressed: BuiltTile['dressed'];
}

export interface NearestStreet {
  name: string;
  cls: string;
  distance: number;
}

const pushCapped = (arr: number[], v: number, cap = 300): void => {
  arr.push(v);
  if (arr.length > cap) arr.shift();
};

const toVec2 = (flat: FlatCoords): Vec2[] => {
  const out: Vec2[] = [];
  for (let k = 0; k < flat.length; k += 2) out.push({ x: flat[k]!, z: flat[k + 1]! });
  return out;
};

/**
 * Streams the real neighbourhood: loads map tiles near the dog (built in Web Workers), turns them
 * into a few merged meshes per tile, feeds building footprints to the CollisionWorld, and unloads
 * tiles that are far away. Also owns the play-area boundary (as collision walls) and the terrain.
 */
export class MapWorld {
  readonly group = new THREE.Group();
  index!: MapIndex;
  boundary: Vec2[] = [];

  private readonly baseUrl: string;
  private readonly existing = new Set<string>();
  private readonly loaded = new Map<string, LoadedTile>();
  private readonly inFlight = new Set<string>();
  private readonly built: BuiltTile[] = [];
  /** Keys of tiles in `built` (finished by a worker, waiting to become meshes): never re-request them. */
  private readonly builtKeys = new Set<string>();
  private workers: Worker[] = [];
  private nextWorker = 0;
  private readonly buildingMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  /** Lane markings: pulled toward the camera in depth so they never z-fight the road. */
  private readonly decalMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  /** Dressing stats of the loaded tiles (dressed buildings, props, triangles). */
  dressedStats = { buildings: 0, props: 0, landmarks: 0 };
  private readonly maxAnisotropy: number;
  private lastBuildMs = 0;
  errors = 0;
  /** Recent per-tile timings, ms: worker build (off-thread) and main-thread finalize (can cause stutters). */
  readonly timings = { build: [] as number[], finalize: [] as number[] };
  private boundaryWallCount = 0;

  constructor(
    private readonly collision: CollisionWorld,
    private readonly renderer: THREE.WebGLRenderer,
  ) {
    this.group.name = 'map';
    this.baseUrl = new URL(`${import.meta.env.BASE_URL}map/`, document.baseURI).href;
    this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  }

  /** Fetch the index + terrain, start the workers, and build the boundary walls. */
  async init(): Promise<void> {
    const res = await fetch(`${this.baseUrl}index.json`);
    if (!res.ok) throw new Error(`Map index missing (${res.status}). Run: npm run map:build`);
    this.index = (await res.json()) as MapIndex;
    if (this.index.v !== MAP_DATA_VERSION) {
      throw new Error(`Map data v${this.index.v} != game v${MAP_DATA_VERSION}. Re-run: npm run map:build`);
    }
    for (const t of this.index.tiles) this.existing.add(tileKey(t.i, t.j));

    let terrain: { meta: HeightmapMeta; data: Int16Array } | null = null;
    const ti = this.index.terrain;
    if (ti) {
      const bin = await fetch(`${this.baseUrl}${ti.file}`);
      if (!bin.ok) throw new Error(`Terrain file missing (${bin.status})`);
      const data = new Int16Array(await bin.arrayBuffer());
      const meta = { x0: ti.x0, z0: ti.z0, res: ti.res, cols: ti.cols, rows: ti.rows, scale: ti.scale };
      setTerrain(new Heightmap(meta, data));
      terrain = { meta, data };
    } else {
      setTerrain(null);
    }

    const n = Math.max(1, TUNING.map.workers);
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onWorkerMessage(ev.data);
      w.onerror = (ev) => {
        this.errors++;
        console.warn('[map] worker error', ev.message);
      };
      // Each worker gets its own copy of the heightmap (~1 MB).
      const msg: WorkerRequest = {
        type: 'init', style: MAP_STYLE, tileSize: this.index.tileSize,
        terrain: terrain ? { meta: terrain.meta, data: terrain.data.slice() } : null,
      };
      w.postMessage(msg);
      this.workers.push(w);
    }

    this.boundary = toVec2(this.index.boundary);
    this.addBoundaryWalls();
  }

  get tileSize(): number {
    return this.index.tileSize;
  }

  /** Call every frame with the dog's position. Cheap when nothing changes. */
  update(x: number, z: number): void {
    const { loadRadius, unloadRadius, maxInFlight, maxFinalizePerFrame } = TUNING.map;
    const S = this.tileSize;

    // 1. Request missing tiles within the load radius, nearest first.
    const want: { key: string; d: number }[] = [];
    const i0 = Math.floor((x - loadRadius) / S), i1 = Math.floor((x + loadRadius) / S);
    const j0 = Math.floor((z - loadRadius) / S), j1 = Math.floor((z + loadRadius) / S);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = tileKey(i, j);
        if (!this.existing.has(key) || this.loaded.has(key) || this.inFlight.has(key) || this.builtKeys.has(key)) continue;
        const d = this.tileDistance(i, j, x, z);
        if (d <= loadRadius) want.push({ key, d });
      }
    }
    want.sort((a, b) => a.d - b.d);
    for (const w of want) {
      if (this.inFlight.size >= maxInFlight) break;
      this.request(w.key, TUNING.map.textureSize);
    }

    // 2. Turn finished worker results into meshes, a few per frame (each one uploads a texture).
    this.built.sort((a, b) => this.tileDistance(a.i, a.j, x, z) - this.tileDistance(b.i, b.j, x, z));
    for (let k = 0; k < maxFinalizePerFrame && this.built.length; k++) {
      const t = this.built.shift()!;
      this.builtKeys.delete(t.key);
      if (this.tileDistance(t.i, t.j, x, z) > unloadRadius) continue; // moved away while it was building
      this.finalize(t);
    }

    // 3. Unload far tiles.
    for (const [key, t] of this.loaded) {
      const [i, j] = this.parseKey(key);
      if (this.tileDistance(i, j, x, z) > unloadRadius) this.unload(t);
    }
  }

  /** True once every existing tile within `radius` m of (x, z) is loaded (collision is in place). */
  isReadyAt(x: number, z: number, radius = 40): boolean {
    if (!this.index) return false;
    const S = this.tileSize;
    for (let i = Math.floor((x - radius) / S); i <= Math.floor((x + radius) / S); i++) {
      for (let j = Math.floor((z - radius) / S); j <= Math.floor((z + radius) / S); j++) {
        const key = tileKey(i, j);
        if (this.existing.has(key) && !this.loaded.has(key)) return false;
      }
    }
    return true;
  }

  isInsideBoundary(x: number, z: number): boolean {
    return this.boundary.length >= 3 && pointInPolygon(x, z, this.boundary);
  }

  /** Nearest named street centerline within `maxDist` meters. */
  nearestStreet(x: number, z: number, maxDist = 60): NearestStreet | null {
    let best: NearestStreet | null = null;
    let bestD2 = maxDist * maxDist;
    const S = this.tileSize;
    for (let i = Math.floor((x - maxDist) / S); i <= Math.floor((x + maxDist) / S); i++) {
      for (let j = Math.floor((z - maxDist) / S); j <= Math.floor((z + maxDist) / S); j++) {
        const t = this.loaded.get(tileKey(i, j));
        if (!t) continue;
        for (const s of t.streets) {
          const p = s.p;
          for (let k = 0; k + 3 < p.length; k += 2) {
            const ax = p[k]!, az = p[k + 1]!, bx = p[k + 2]!, bz = p[k + 3]!;
            const dx = bx - ax, dz = bz - az;
            const l2 = dx * dx + dz * dz;
            let u = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const ex = ax + dx * u - x, ez = az + dz * u - z;
            const d2 = ex * ex + ez * ez;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = { name: s.n, cls: s.c, distance: 0 };
            }
          }
        }
      }
    }
    if (best) best.distance = Math.sqrt(bestD2);
    return best;
  }

  /**
   * GPU/collision resources owned by the map right now. Leak checks compare the renderer's totals
   * minus these, which must stay constant however many tiles are loaded.
   */
  get resources(): { geometries: number; textures: number; obstacles: number } {
    let geometries = 0;
    let obstacles = this.boundaryWallCount;
    for (const t of this.loaded.values()) {
      geometries += t.group.children.length; // one geometry per mesh (ground, buildings)
      obstacles += t.obstacleIds.length;
    }
    let textures = 0;
    for (const t of this.loaded.values()) textures += t.textures.length;
    return { geometries, textures, obstacles };
  }

  get stats(): { loaded: number; inFlight: number; queued: number; triangles: number; lastBuildMs: number } {
    let triangles = 0;
    for (const t of this.loaded.values()) triangles += t.triangles;
    return {
      loaded: this.loaded.size, inFlight: this.inFlight.size, queued: this.built.length,
      triangles, lastBuildMs: this.lastBuildMs,
    };
  }

  dispose(): void {
    for (const t of [...this.loaded.values()]) this.unload(t);
    this.built.length = 0;
    this.builtKeys.clear();
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.buildingMaterial.dispose();
    this.decalMaterial.dispose();
    this.group.removeFromParent();
  }

  // --- internals --------------------------------------------------------------------------------

  private parseKey(key: string): [number, number] {
    const [a, b] = key.split('_');
    return [Number(a), Number(b)];
  }

  /** Distance from (x, z) to the nearest point of tile (i, j)'s square (0 inside). */
  private tileDistance(i: number, j: number, x: number, z: number): number {
    const S = this.tileSize;
    const dx = Math.max(i * S - x, 0, x - (i + 1) * S);
    const dz = Math.max(j * S - z, 0, z - (j + 1) * S);
    return Math.hypot(dx, dz);
  }

  private request(key: string, textureSize: number): void {
    this.inFlight.add(key);
    const w = this.workers[this.nextWorker++ % this.workers.length]!;
    const msg: WorkerRequest = { type: 'build', key, url: `${this.baseUrl}tiles/${key}.json`, textureSize };
    w.postMessage(msg);
  }

  private onWorkerMessage(msg: WorkerResponse): void {
    if (msg.type === 'error') {
      this.inFlight.delete(msg.key);
      this.errors++;
      console.warn(`[map] tile ${msg.key} failed: ${msg.message}`);
      return;
    }
    this.inFlight.delete(msg.tile.key);
    this.lastBuildMs = msg.tile.buildMs;
    pushCapped(this.timings.build, msg.tile.buildMs);
    if (this.loaded.has(msg.tile.key) || this.builtKeys.has(msg.tile.key)) return; // duplicate
    this.builtKeys.add(msg.tile.key);
    this.built.push(msg.tile);
  }

  private finalize(t: BuiltTile): void {
    const t0 = performance.now();
    const group = new THREE.Group();
    group.name = `tile ${t.key}`;

    const texture = new THREE.DataTexture(t.pixels, t.textureSize, t.textureSize, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = this.maxAnisotropy;
    texture.needsUpdate = true;
    // Upload now (inside the measured, budgeted finalize step) rather than on the first frame the tile
    // comes into view, which would cause a stutter at an unpredictable moment.
    this.renderer.initTexture(texture);
    const groundMaterial = new THREE.MeshLambertMaterial({ map: texture });
    const ground = new THREE.Mesh(this.geometry(t.ground), groundMaterial);
    ground.receiveShadow = true;
    group.add(ground);

    let triangles = t.ground.indices.length / 3;
    const materials: THREE.Material[] = [groundMaterial];
    const textures: THREE.Texture[] = [texture];
    if (t.buildings.indices.length) {
      const buildings = new THREE.Mesh(this.geometry(t.buildings), this.buildingMaterial);
      buildings.castShadow = true;
      buildings.receiveShadow = true;
      group.add(buildings);
      triangles += t.buildings.indices.length / 3;
    }
    if (t.decals?.indices.length) {
      const decals = new THREE.Mesh(this.geometry(t.decals), this.decalMaterial);
      decals.receiveShadow = true;
      decals.renderOrder = 1;
      group.add(decals);
      triangles += t.decals.indices.length / 3;
    }
    if (t.signs) {
      const tex = new THREE.DataTexture(t.signs.pixels, t.signs.width, t.signs.height, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = this.maxAnisotropy;
      tex.needsUpdate = true;
      this.renderer.initTexture(tex);
      // alphaTest: cut-out letters (e.g. sign letters standing on a parapet); three.js also uses it
      // for the shadow pass, so they cast letter-shaped shadows.
      // A little self-illumination: painted signs and sequins catch the sky even on a shaded facade.
      const mat = new THREE.MeshLambertMaterial({
        map: tex, alphaTest: 0.5, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: TUNING.map.signGlow,
      });
      const signs = new THREE.Mesh(this.geometry(t.signs.mesh), mat);
      signs.castShadow = true;
      signs.receiveShadow = true;
      group.add(signs);
      materials.push(mat);
      textures.push(tex);
      triangles += t.signs.mesh.indices.length / 3;
    }
    if (t.dressed) {
      this.dressedStats.buildings += t.dressed.buildings;
      this.dressedStats.props += t.dressed.props;
      this.dressedStats.landmarks += t.dressed.landmarks;
    }
    this.group.add(group);

    // Collision: one obstacle per building outer ring.
    const ids: string[] = [];
    const { coords, offsets, heights, bases } = t.footprints;
    for (let b = 0; b + 1 < offsets.length; b++) {
      const pts: Vec2[] = [];
      for (let k = offsets[b]!; k < offsets[b + 1]!; k++) pts.push({ x: coords[k * 2]!, z: coords[k * 2 + 1]! });
      if (pts.length < 3) continue;
      const id = `${t.key}#${b}`;
      this.collision.add({ id, footprint: pts, height: heights[b]!, baseY: bases[b]! });
      ids.push(id);
    }

    this.loaded.set(t.key, {
      key: t.key, group, materials, textures, obstacleIds: ids, streets: t.streets, triangles,
      dressed: t.dressed,
    });
    pushCapped(this.timings.finalize, performance.now() - t0);
  }

  private geometry(m: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; uvs?: Float32Array; colors?: Uint8Array }): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    if (m.uvs) g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
    if (m.colors) g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3, true));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  private unload(t: LoadedTile): void {
    this.loaded.delete(t.key);
    for (const id of t.obstacleIds) this.collision.remove(id);
    t.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    t.group.removeFromParent();
    for (const m of t.materials) m.dispose();
    for (const x of t.textures) x.dispose();
    if (t.dressed) {
      this.dressedStats.buildings -= t.dressed.buildings;
      this.dressedStats.props -= t.dressed.props;
      this.dressedStats.landmarks -= t.dressed.landmarks;
    }
  }

  /**
   * The dog can't leave the play area: each boundary edge gets a thin, invisible collision strip
   * just outside it (slightly overlapping its neighbours), so the dog slides along the edge.
   */
  private addBoundaryWalls(): void {
    const pts = this.boundary;
    const wind = signedArea(pts) >= 0 ? 1 : -1;
    const T = TUNING.map.boundaryWallThickness;
    const ext = 0.5;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k]!, b = pts[(k + 1) % pts.length]!;
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const ux = dx / len, uz = dz / len;
      const nx = uz * wind, nz = -ux * wind; // outward normal
      const ax = a.x - ux * ext, az = a.z - uz * ext;
      const bx = b.x + ux * ext, bz = b.z + uz * ext;
      this.boundaryWallCount++;
      this.collision.add({
        id: `boundary#${k}`,
        // height 0: blocks the dog, but never blocks the camera ray
        height: 0,
        footprint: [{ x: ax, z: az }, { x: bx, z: bz }, { x: bx + nx * T, z: bz + nz * T }, { x: ax + nx * T, z: az + nz * T }],
      });
    }
  }

  /** Closest point on the boundary (used to bring a dog that ended up outside back in). */
  closestBoundaryPoint(x: number, z: number): Vec2 {
    const c = closestPointOnPolygon(x, z, this.boundary);
    return { x: c.x, z: c.z };
  }
}
