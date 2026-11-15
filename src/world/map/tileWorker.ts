/// <reference lib="webworker" />
import type { MapStyle } from '../../config/mapStyle';
import { Heightmap, type HeightmapMeta } from '../terrain';
import { buildBuildings, buildGround, buildSurfaces, paintTile, type Footprints, type MeshArrays } from './buildTile';
import { buildDressing, mergeFootprints, mergeMeshes } from './dress';
import { MeshBuilder } from './dress/MeshBuilder';
import type { SignMeshResult, SignPainter } from './dress/signs';
import { MAP_DATA_VERSION, type TileData, type TileStreet } from './types';

/**
 * Tile worker: fetch tile JSON -> build ground + building mesh arrays, paint the ground texture,
 * extract collision footprints. Everything heavy happens here, off the main thread.
 */

export type WorkerRequest =
  | { type: 'init'; terrain: { meta: HeightmapMeta; data: Int16Array } | null; style: MapStyle; tileSize: number }
  | { type: 'build'; key: string; url: string; textureSize: number };

export interface BuiltTile {
  key: string;
  i: number;
  j: number;
  ground: MeshArrays;
  buildings: MeshArrays;
  footprints: Footprints;
  streets: TileStreet[];
  /** Lane markings (dressed area only). */
  decals: MeshArrays | null;
  /** Textured sign quads + their atlas (dressed area only). */
  signs: SignMeshResult | null;
  dressed: { buildings: number; props: number; triangles: number } | null;
  /** Ground texture as raw RGBA pixels (textureSize x textureSize, row 0 = north edge). */
  pixels: Uint8Array;
  textureSize: number;
  buildMs: number;
}

export type WorkerResponse =
  | { type: 'built'; tile: BuiltTile }
  | { type: 'error'; key: string; message: string };

let hm: Heightmap | null = null;
let style: MapStyle | null = null;
let tileSize = 250;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    hm = msg.terrain ? new Heightmap(msg.terrain.meta, msg.terrain.data) : null;
    style = msg.style;
    tileSize = msg.tileSize;
    return;
  }
  try {
    const t0 = performance.now();
    const res = await fetch(msg.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${msg.url}`);
    const data = (await res.json()) as TileData;
    if (data.v !== MAP_DATA_VERSION) throw new Error(`tile data v${data.v}, game expects v${MAP_DATA_VERSION}`);
    if (!style) throw new Error('worker not initialized');

    const ground = buildGround(data.i, data.j, tileSize, hm);
    // Gray boxes outside the dressed area; full houses + props inside it (merged into one mesh).
    const gray = buildBuildings(data.buildings.filter((b) => !b.d), hm, style, data.i * 7919 + data.j);
    const dressing = buildDressing(data, hm, style, (w, h) =>
      new OffscreenCanvas(w, h).getContext('2d') as unknown as SignPainter | null);
    const buildings = dressing ? mergeMeshes(gray.mesh, dressing.structures) : gray.mesh;
    const footprints = dressing ? mergeFootprints(gray.footprints, dressing.footprints) : gray.footprints;
    // Crisp hard surfaces everywhere (+ lane markings / wires in the dressed area): one decal mesh.
    const sm = new MeshBuilder();
    buildSurfaces(sm, data, hm, style);
    const surfaces = sm.triangles ? sm.build() : null;
    const decals = surfaces && dressing?.decals ? mergeMeshes(surfaces, dressing.decals) : surfaces ?? dressing?.decals ?? null;
    const canvas = new OffscreenCanvas(msg.textureSize, msg.textureSize);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('OffscreenCanvas 2D context unavailable');
    paintTile(g, data, tileSize, msg.textureSize, style);
    // Raw pixels upload much faster than an ImageBitmap in WebKit (measured: ~13 ms -> see perf report).
    const pixels = new Uint8Array(g.getImageData(0, 0, msg.textureSize, msg.textureSize).data.buffer);

    const tile: BuiltTile = {
      key: msg.key, i: data.i, j: data.j, ground, buildings, footprints,
      streets: data.streets, pixels, textureSize: msg.textureSize, buildMs: performance.now() - t0,
      decals, signs: dressing?.signs ?? null, dressed: dressing?.counts ?? null,
    };
    const transfer: Transferable[] = [pixels.buffer];
    if (tile.signs) transfer.push(tile.signs.pixels.buffer);
    for (const m of [ground, buildings, tile.decals, tile.signs?.mesh]) {
      if (!m) continue;
      transfer.push(m.positions.buffer, m.normals.buffer, m.indices.buffer);
      if (m.uvs) transfer.push(m.uvs.buffer);
      if (m.colors) transfer.push(m.colors.buffer);
    }
    transfer.push(footprints.coords.buffer, footprints.offsets.buffer, footprints.heights.buffer, footprints.bases.buffer);
    ctx.postMessage({ type: 'built', tile } satisfies WorkerResponse, transfer);
  } catch (err) {
    ctx.postMessage({ type: 'error', key: msg.key, message: String(err) } satisfies WorkerResponse);
  }
};
