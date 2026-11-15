import type { DogState } from '../dog/DogController';

/**
 * Minimal READ-ONLY debug surface on `window.__game`, for automated tests and
 * console poking. Getters return fresh copies; nothing here can mutate the game.
 */
export interface GameDebugApi {
  readonly ready: boolean;
  readonly frames: number;
  readonly fps: number;
  readonly dog: {
    readonly position: { x: number; y: number; z: number };
    readonly heading: number;
    readonly state: DogState;
    readonly speed: number;
  };
  readonly triggers: {
    readonly inside: string[];
    readonly enterCount: number;
    readonly exitCount: number;
  };
  readonly drawCalls: number;
}

declare global {
  interface Window {
    __game?: GameDebugApi;
  }
}
