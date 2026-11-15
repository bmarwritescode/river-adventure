import type { DogState } from '../dog/DogController';
import type { PerfSummary } from './PerfMonitor';

/**
 * Minimal READ-ONLY debug surface on `window.__game`, for automated tests and
 * console poking. Getters return fresh copies; nothing here can mutate the game.
 */
export interface GameDebugApi {
  /** Map loaded around the dog and the dog can move. */
  readonly ready: boolean;
  readonly frames: number;
  readonly fps: number;
  readonly dog: {
    readonly position: { x: number; y: number; z: number };
    readonly heading: number;
    readonly state: DogState;
    readonly speed: number;
    /** Dog's collision circle overlaps a building/wall (should never be true). */
    readonly insideObstacle: boolean;
    readonly insideBoundary: boolean;
    /** Which visual is showing: 'box' | 'loading' | 'model' | 'failed'. */
    readonly visual: string;
    /** Clip names in the loaded .glb (empty until loaded). */
    readonly clips: string[];
  };
  readonly triggers: {
    readonly inside: string[];
    readonly enterCount: number;
    readonly exitCount: number;
  };
  readonly map: {
    readonly loadedTiles: number; readonly pendingTiles: number; readonly errors: number;
    /** Art-dressed buildings / props in the loaded tiles (Step 5 test block). */
    readonly dressedBuildings: number; readonly dressedProps: number; readonly landmarks: number;
  };
  /** Nearest named street, or null. */
  readonly street: string | null;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly places: { id: string; label: string }[];
  readonly perf: {
    /** performance.now(), for use as a `summary(since)` start mark. */
    now(): number;
    /** Frame-time summary of frames since `sinceMs`. */
    summary(sinceMs: number): PerfSummary;
    readonly memory: {
      geometries: number; textures: number; heapMB: number | null; obstacles: number;
      /** Totals minus what the loaded map tiles own: constant unless something leaks. */
      nonMapGeometries: number; nonMapTextures: number; nonMapObstacles: number;
    };
    /** Recent per-tile timings, ms. */
    readonly tiles: { build: number[]; finalize: number[] };
  };
}

declare global {
  interface Window {
    __game?: GameDebugApi;
  }
}
