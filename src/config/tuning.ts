/**
 * Global (not per-dog) tunable numbers. Per-dog numbers live in dogProfiles.ts.
 * Everything here is exposed in the lil-gui panel (backtick key).
 */
export const TUNING = {
  sim: {
    /** Fixed simulation rate, Hz. */
    tickRate: 60,
    /** Largest real frame delta we will simulate, seconds (tab switches etc.). */
    maxFrameDelta: 0.25,
    /** Hard cap on simulation steps per rendered frame. */
    maxStepsPerFrame: 8,
  },
  world: {
    gravity: 18.0, // m/s² — snappier than 9.81, reads better for a short hop
  },
  collision: {
    /** Push-out passes per step (more = more robust in tight corners). */
    iterations: 3,
    /** Broadphase grid cell size, meters. */
    gridCellSize: 16,
  },
  triggers: {
    /** Extra distance past a zone's edge before "exit" fires (hysteresis), meters. */
    exitMargin: 0.3,
  },
  camera: {
    fov: 60,
    near: 0.05,
    far: 800,
    /** Radians of orbit per pixel of mouse movement. */
    orbitSensitivity: 0.0032,
    minPitch: -0.15,
    maxPitch: 1.2,
    /** Exponential smoothing rates (1/s); higher = snappier. */
    followSharpness: 10,
    orbitSharpness: 18,
    zoomSharpness: 10,
    sniffBlendSharpness: 4,
    /** Re-pull speed after an obstacle stops blocking (1/s). */
    unblockSharpness: 6,
    /** Distance kept between the camera and anything blocking it, meters. */
    collisionMargin: 0.25,
    /** Minimum camera height above ground, meters. */
    groundClearance: 0.15,
    /** Zoom step per wheel "notch" (fraction of current distance). */
    zoomStep: 0.12,
    /** Auto-swing behind the dog while it moves (rad/s); 0 disables. */
    recenterRate: 1.4,
    /** Seconds after the last mouse orbit before auto-recenter kicks in. */
    recenterDelay: 1.5,
    /** Only recenter if the dog faces within this angle of the camera's view (radians). */
    recenterMaxAngle: 2.0,
  },
  visual: {
    /** Vertical bob amplitude per state, meters. */
    bobWalk: 0.012,
    bobTrot: 0.025,
    bobRun: 0.04,
    /** Leg swing amplitude per state, radians. */
    legSwingWalk: 0.35,
    legSwingTrot: 0.5,
    legSwingRun: 0.85,
    /** Meters travelled per full gait cycle at each pace. */
    strideWalk: 0.9,
    strideTrot: 1.4,
    strideRun: 2.6,
    /** Head pitch while sniffing, radians (negative = nose down). */
    sniffHeadPitch: -1.05,
    /** Forward body tilt while sniffing, radians. */
    sniffBodyPitch: -0.12,
    /** How fast poses blend (1/s). */
    poseSharpness: 8,
    tailWagSpeed: 9,
    tailWagAmount: 0.45,
  },
  lighting: {
    sunIntensity: 2.6,
    hemiIntensity: 1.1,
    /** Half-size of the shadow camera box around the dog, meters. */
    shadowRadius: 45,
    shadowMapSize: 2048,
  },
  debug: {
    /** Show trigger zones + names. Toggle with T. On for the test level. */
    showTriggerZones: true,
    /** Overlay text refresh rate, Hz. */
    overlayHz: 10,
  },
};

export type Tuning = typeof TUNING;
