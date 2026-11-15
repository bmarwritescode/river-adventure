import type { DogState } from '../dog/DogController';

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
  };
  readonly triggers: {
    readonly inside: string[];
    readonly enterCount: number;
    readonly exitCount: number;
  };
  readonly map: { readonly loadedTiles: number; readonly pendingTiles: number; readonly errors: number };
  /** Nearest named street, or null. */
  readonly street: string | null;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly places: { id: string; label: string }[];
}

declare global {
  interface Window {
    __game?: GameDebugApi;
  }
}
