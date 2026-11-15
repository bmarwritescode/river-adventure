import type { DogState } from './DogController';

/**
 * Animation clip names every dog .glb must contain (exactly these names).
 * One clip per DogController state; 'sit' and 'playBow' are action states.
 */
export const DOG_CLIP_NAMES = ['idle', 'walk', 'trot', 'run', 'sniff', 'jump', 'sit', 'playBow'] as const;
export type DogClipName = (typeof DOG_CLIP_NAMES)[number];

/** Which clip plays for each controller state (currently 1:1). */
export const CLIP_FOR_STATE: Record<DogState, DogClipName> = {
  idle: 'idle', walk: 'walk', trot: 'trot', run: 'run', sniff: 'sniff', jump: 'jump', sit: 'sit', playBow: 'playBow',
};
