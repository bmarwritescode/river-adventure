/**
 * All gameplay progress in one plain, JSON-serializable object, separate from
 * rendering. Save/load = serialize/deserialize this. Stretch-goal unlocks are flags.
 *
 * Step 1: defined but not yet persisted (saving is Step 8).
 * Bump SAVE_VERSION and add a migration in `deserializeGameState` when the shape changes.
 */
export const SAVE_VERSION = 1;

export interface GameState {
  version: number;
  hunt: {
    /** Index into the ordered clue list. */
    currentStep: number;
    /** Ids of clue steps already found. */
    completedStepIds: string[];
    finished: boolean;
  };
  unlocks: {
    houseInterior: boolean;
    secondDog: boolean;
  };
  /** Which DogProfile the player is controlling. */
  activeDogId: string;
}

export function createInitialGameState(): GameState {
  return {
    version: SAVE_VERSION,
    hunt: { currentStep: 0, completedStepIds: [], finished: false },
    unlocks: { houseInterior: false, secondDog: false },
    activeDogId: 'main',
  };
}

export function serializeGameState(state: GameState): string {
  return JSON.stringify(state);
}

/** Parse a saved state; falls back to a fresh state if the data is missing or malformed. */
export function deserializeGameState(json: string | null): GameState {
  const fresh = createInitialGameState();
  if (!json) return fresh;
  try {
    const parsed = JSON.parse(json) as Partial<GameState>;
    if (parsed.version !== SAVE_VERSION) return fresh; // migrations go here
    return {
      ...fresh,
      ...parsed,
      hunt: { ...fresh.hunt, ...parsed.hunt },
      unlocks: { ...fresh.unlocks, ...parsed.unlocks },
    };
  } catch {
    return fresh;
  }
}
