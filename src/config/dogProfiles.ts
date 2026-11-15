/**
 * Per-dog values. Nothing in the controller, camera or visual may hard-code a
 * dog-specific number: everything comes from a DogProfile, so a second (smaller)
 * dog is just another entry in DOG_PROFILES.
 *
 * Profiles are plain mutable objects so the lil-gui panel can tune them live.
 */

export interface DogDimensions {
  /** Height at the withers (top of shoulders), meters. */
  shoulderHeight: number;
  /** Nose tip to tail base, standing with head forward, meters. */
  length: number;
  /** Top of head in natural standing posture, meters. */
  headTopHeight: number;
  /** Body width at the chest, meters. */
  chestWidth: number;
}

export interface DogSpeeds {
  /** Target ground speeds in m/s for each pace. */
  walk: number;
  trot: number;
  run: number;
  /** Crawl speed while sniffing (E held). */
  sniff: number;
}

export interface DogMovement {
  /** m/s² when speeding up. */
  acceleration: number;
  /** m/s² when slowing down with no input (coasting to a stop). */
  deceleration: number;
  /** m/s² when braking because the requested direction is far from the heading. */
  brakeDeceleration: number;
  /** Max turn rate (rad/s) when standing still / slow. */
  turnRateSlow: number;
  /** Max turn rate (rad/s) at full run speed. Interpolated by speed in between. */
  turnRateFast: number;
  /** Fraction of horizontal control kept while airborne (0..1). */
  airControl: number;
}

export interface DogJump {
  /** Apex height of a hop, meters above the ground. */
  height: number;
  /** Minimum seconds between landing and the next jump. */
  cooldown: number;
}

export interface DogCamera {
  /** Height above the dog's feet that the camera looks at, meters. */
  lookHeight: number;
  /** Default camera distance from the look point, meters. */
  distance: number;
  minDistance: number;
  maxDistance: number;
  /** Default pitch (radians above horizontal). Low = dog's-eye view. */
  pitch: number;
  /** Look height / distance the camera eases to while sniffing. */
  sniffLookHeight: number;
  sniffDistance: number;
}

export interface DogProfile {
  id: string;
  displayName: string;
  dimensions: DogDimensions;
  speeds: DogSpeeds;
  movement: DogMovement;
  jump: DogJump;
  /** Radius of the dog's collision circle in the XZ plane, meters. */
  collisionRadius: number;
  camera: DogCamera;
  /** Coat colors for placeholder/box visuals (hex). */
  colors: { coat: number; chest: number; lowerLegs: number; nose: number; eyes: number };
  /** Path to the rigged .glb (Step 3+). Undefined = box placeholder. */
  modelPath?: string;
}

/**
 * The main dog. ~23 kg, lean and fairly tall (whippet body, pit-bull head).
 * Black coat, white tuxedo chest/front, brown lower legs.
 */
export const MAIN_DOG: DogProfile = {
  id: 'main',
  displayName: 'Main dog',
  dimensions: {
    shoulderHeight: 0.63,
    length: 0.95,
    headTopHeight: 0.88,
    chestWidth: 0.24,
  },
  speeds: {
    walk: 1.5,
    trot: 3.5,
    run: 8.0,
    sniff: 0.45,
  },
  movement: {
    acceleration: 7.0,
    deceleration: 6.0,
    brakeDeceleration: 14.0,
    turnRateSlow: 7.0,
    turnRateFast: 2.6,
    airControl: 0.25,
  },
  jump: {
    height: 0.5,
    cooldown: 0.15,
  },
  // Circle in XZ; the dog is long and narrow so this is a compromise between
  // half-width (0.12) and half-length (0.48). Tune once real geometry exists.
  collisionRadius: 0.28,
  camera: {
    lookHeight: 0.75,
    distance: 3.2,
    minDistance: 1.2,
    maxDistance: 9.0,
    pitch: 0.2,
    sniffLookHeight: 0.35,
    sniffDistance: 1.7,
  },
  colors: {
    coat: 0x161616,
    chest: 0xf2f2ee,
    lowerLegs: 0x7a4a26,
    nose: 0x3a2a26,
    eyes: 0xc89a3a,
  },
};

export const DOG_PROFILES: Record<string, DogProfile> = {
  [MAIN_DOG.id]: MAIN_DOG,
};
