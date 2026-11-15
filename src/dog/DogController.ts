import type { DogProfile } from '../config/dogProfiles';
import { TUNING } from '../config/tuning';
import {
  approach, clamp, forwardToHeading, headingToForward, lerp, lerpAngle, wrapAngle,
} from '../core/math';
import type { CollisionWorld } from '../world/collision';
import { getGroundHeight } from '../world/ground';

/** Exact state names; dog .glb clips use the same names (see dog/clips.ts). */
export const DOG_STATES = ['idle', 'walk', 'trot', 'run', 'sniff', 'jump', 'sit', 'playBow'] as const;
export type DogState = (typeof DOG_STATES)[number];

export type Pace = 'walk' | 'trot' | 'run';

/** Stationary actions the dog performs on command. */
export type DogAction = 'none' | 'sit' | 'playBow';

/** What the player (or later, an AI/cutscene) wants the dog to do this step. */
export interface DogIntent {
  /** Desired move direction in world XZ, length 0..1 (already camera-relative). */
  moveX: number;
  moveZ: number;
  pace: Pace;
  sniff: boolean;
  /** One-shot: true on the step the jump key was pressed. */
  jump: boolean;
  /** One-shot: toggle sitting (sits once the dog has stopped; pressing again stands up). */
  sit: boolean;
  /** One-shot: play bow (stops first, holds for profile.behavior.playBowDuration). */
  playBow: boolean;
}

export interface DogPose {
  x: number;
  y: number;
  z: number;
  heading: number;
}

/** Below this ground speed (m/s) the dog counts as idle. */
const IDLE_SPEED = 0.25;

/**
 * Owns the dog's simulation state: position, heading, velocity, movement state.
 * Never touches meshes (that's DogVisual). Works for any DogProfile.
 *
 * Model: the dog always moves along its heading (no strafing). Input sets a
 * desired direction; the dog turns toward it at a speed-dependent rate and
 * accelerates/brakes toward the target pace speed. Turning far away slows it,
 * so it wheels around in an arc instead of pivoting on the spot at full speed.
 */
export class DogController {
  readonly position = { x: 0, y: 0, z: 0 };
  /** Heading in radians; 0 = facing north (-Z). See core/math headingToForward. */
  heading = 0;
  /** Actual world velocity from the last step (after collisions), m/s. */
  readonly velocity = { x: 0, y: 0, z: 0 };
  /** Forward ground speed the dog is trying to hold, m/s. */
  speed = 0;
  state: DogState = 'idle';
  grounded = true;
  /** Seconds spent in the current state. */
  stateTime = 0;
  /** True if an obstacle pushed the dog in the last step. */
  touchingObstacle = false;

  private readonly prev = { x: 0, y: 0, z: 0, heading: 0 };
  private timeSinceLanded = Infinity;
  /** Current stationary action, and one requested but waiting for the dog to stop. */
  private act: DogAction = 'none';
  private pendingAct: DogAction = 'none';
  private actTime = 0;
  /** Seconds the dog can't move yet (e.g. getting up from a sit). */
  private lockTime = 0;
  private idleTime = 0;

  constructor(
    public profile: DogProfile,
    private readonly collision: CollisionWorld,
  ) {}

  /** Place the dog instantly (no interpolation smear). */
  teleport(x: number, z: number, heading = this.heading): void {
    this.position.x = x;
    this.position.z = z;
    this.position.y = getGroundHeight(x, z);
    this.heading = heading;
    this.speed = 0;
    this.velocity.x = this.velocity.y = this.velocity.z = 0;
    this.grounded = true;
    this.savePrev();
  }

  step(dt: number, intent: DogIntent): void {
    this.savePrev();
    const p = this.profile;
    const g = TUNING.world.gravity;

    // --- Desired direction & speed --------------------------------------
    let mx = intent.moveX, mz = intent.moveZ;
    const mag = Math.min(1, Math.hypot(mx, mz));
    const hasInput = mag > 0.01;
    const sniffing = intent.sniff && this.grounded;
    const control = this.grounded ? 1 : p.movement.airControl;

    // --- Actions (sit / play bow): any movement, sniff or jump input cancels them ------
    this.updateAction(dt, intent, hasInput || intent.sniff || intent.jump);
    const locked = this.act !== 'none' || this.pendingAct !== 'none' || this.lockTime > 0;

    let targetSpeed = 0;
    let align = 1;
    if (hasInput && !locked) {
      mx /= mag; mz /= mag;
      const paceSpeed = sniffing ? p.speeds.sniff : p.speeds[intent.pace];
      const speedFrac = clamp(this.speed / p.speeds.run, 0, 1);
      const turnRate = lerp(p.movement.turnRateSlow, p.movement.turnRateFast, speedFrac) * control;
      const diff = wrapAngle(forwardToHeading(mx, mz) - this.heading);
      const maxTurn = turnRate * dt;
      this.heading = wrapAngle(this.heading + clamp(diff, -maxTurn, maxTurn));
      // Slow down while facing away from where we want to go -> tight arcs, no instant pivots.
      align = Math.cos(wrapAngle(forwardToHeading(mx, mz) - this.heading));
      targetSpeed = paceSpeed * mag * clamp(align, 0.15, 1);
    }

    // --- Acceleration / deceleration -------------------------------------
    let rate: number;
    if (targetSpeed > this.speed) rate = p.movement.acceleration;
    else if (hasInput && align < 0.7) rate = p.movement.brakeDeceleration;
    else rate = p.movement.deceleration;
    this.speed = approach(this.speed, targetSpeed, rate * control * dt);

    // --- Horizontal move with collision (sub-stepped so we never tunnel) --
    const fwd = headingToForward(this.heading);
    const dist = this.speed * dt;
    const r = p.collisionRadius;
    const subSteps = Math.max(1, Math.ceil(dist / (r * 0.5)));
    const startX = this.position.x, startZ = this.position.z;
    let x = startX, z = startZ;
    let collided = false;
    // If we start inside something (e.g. a tile just loaded around us), let push-out move us free.
    const startedClear = !this.collision.overlapsCircle(x, z, r);
    for (let i = 0; i < subSteps; i++) {
      const res = this.collision.resolveCircle(x + (fwd.x * dist) / subSteps, z + (fwd.z * dist) / subSteps, r);
      // In a gap narrower than the dog (or a sharp wedge between obstacles) push-outs can fight each
      // other; if we are still inside something, keep the last good position instead of jittering in.
      if (startedClear && res.collided && this.collision.overlapsCircle(res.x, res.z, r)) {
        collided = true;
        break;
      }
      x = res.x; z = res.z;
      collided ||= res.collided;
    }
    this.position.x = x;
    this.position.z = z;
    this.velocity.x = (x - startX) / dt;
    this.velocity.z = (z - startZ) / dt;
    this.touchingObstacle = collided;
    if (collided) {
      // Only keep the part of our speed that actually got us somewhere (sliding along walls).
      const along = this.velocity.x * fwd.x + this.velocity.z * fwd.z;
      this.speed = Math.min(this.speed, Math.max(0, along));
    }

    // --- Vertical: jump + gravity, glued to getGroundHeight when grounded -
    const ground = getGroundHeight(x, z);
    this.timeSinceLanded += dt;
    if (this.grounded && intent.jump && !locked && this.timeSinceLanded >= p.jump.cooldown) {
      this.velocity.y = Math.sqrt(2 * g * p.jump.height);
      this.grounded = false;
    }
    if (this.grounded) {
      this.position.y = ground;
      this.velocity.y = 0;
    } else {
      this.velocity.y -= g * dt;
      this.position.y += this.velocity.y * dt;
      if (this.position.y <= ground) {
        this.position.y = ground;
        this.velocity.y = 0;
        this.grounded = true;
        this.timeSinceLanded = 0;
      }
    }

    // --- State --------------------------------------------------------------
    const s = p.speeds;
    let next: DogState;
    if (!this.grounded) next = 'jump';
    else if (this.act !== 'none') next = this.act;
    else if (sniffing) next = 'sniff';
    else if (this.speed < IDLE_SPEED) next = 'idle';
    else if (this.speed < (s.walk + s.trot) / 2) next = 'walk';
    else if (this.speed < (s.trot + s.run) / 2) next = 'trot';
    else next = 'run';
    if (next !== this.state) {
      this.state = next;
      this.stateTime = 0;
    } else {
      this.stateTime += dt;
    }
  }

  /** Pose between the previous and current sim step, for smooth rendering. */
  interpolatedPose(alpha: number, out: DogPose): DogPose {
    out.x = lerp(this.prev.x, this.position.x, alpha);
    out.y = lerp(this.prev.y, this.position.y, alpha);
    out.z = lerp(this.prev.z, this.position.z, alpha);
    out.heading = lerpAngle(this.prev.heading, this.heading, alpha);
    return out;
  }

  /** The stationary action in progress ('none' while moving normally). */
  get action(): DogAction {
    return this.act;
  }

  private updateAction(dt: number, intent: DogIntent, wantsToMove: boolean): void {
    const b = this.profile.behavior;
    this.lockTime = Math.max(0, this.lockTime - dt);
    if (this.act !== 'none') this.actTime += dt;

    if (intent.sit) {
      if (this.act === 'sit') this.endAction();
      else this.pendingAct = 'sit';
    }
    if (intent.playBow && this.act !== 'playBow') {
      if (this.act === 'sit') this.endAction(); // get up first, then bow
      this.pendingAct = 'playBow';
    }
    if (wantsToMove && (this.act !== 'none' || this.pendingAct !== 'none')) {
      this.endAction();
      this.pendingAct = 'none';
    }
    if (this.act === 'playBow' && this.actTime >= b.playBowDuration) this.endAction();

    // Start a requested action once the dog has (almost) stopped.
    const stopped = this.grounded && this.speed < 0.3 && this.lockTime <= 0;
    if (this.pendingAct !== 'none' && this.act === 'none' && stopped) {
      this.startAction(this.pendingAct);
      this.pendingAct = 'none';
    }

    // Sit down by itself after idling a while.
    if (!wantsToMove && this.act === 'none' && this.pendingAct === 'none' && stopped) this.idleTime += dt;
    else this.idleTime = 0;
    if (b.autoSitAfter > 0 && this.idleTime >= b.autoSitAfter) this.startAction('sit');
  }

  private startAction(a: DogAction): void {
    this.act = a;
    this.actTime = 0;
    this.idleTime = 0;
  }

  private endAction(): void {
    if (this.act === 'sit') this.lockTime = this.profile.behavior.standUpTime;
    else if (this.act === 'playBow') this.lockTime = this.profile.behavior.bowRecoverTime;
    this.act = 'none';
    this.actTime = 0;
    this.idleTime = 0;
  }

  get groundSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  private savePrev(): void {
    this.prev.x = this.position.x;
    this.prev.y = this.position.y;
    this.prev.z = this.position.z;
    this.prev.heading = this.heading;
  }
}
