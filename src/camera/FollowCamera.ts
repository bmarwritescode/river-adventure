import * as THREE from 'three';
import { TUNING } from '../config/tuning';
import { approach, clamp, damp, headingToForward, lerp, lerpAngle, wrapAngle, type Vec2 } from '../core/math';
import type { DogController, DogPose } from '../dog/DogController';
import type { Input } from '../input/Input';
import type { CollisionWorld } from '../world/collision';
import { getGroundHeight } from '../world/ground';

/**
 * Low third-person orbit camera. Per-dog framing (look height, distances,
 * pitch, sniff framing) comes from the active DogProfile; global feel
 * (smoothing, sensitivity, recenter) from TUNING.camera.
 *
 * Runs per render frame (not per sim step) using the interpolated dog pose.
 */
export class FollowCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Orbit angle; same convention as dog heading (yaw = heading means directly behind). */
  private yawTarget: number;
  private yaw: number;
  private pitchTarget: number;
  private pitch: number;
  private zoomTarget: number;
  private zoom: number;
  /** Distance actually used after obstacle pull-in. */
  private actualDistance: number;
  private sniffBlend = 0;
  private readonly target = new THREE.Vector3();
  private timeSinceOrbit = Infinity;
  private initialized = false;
  private readonly pose: DogPose = { x: 0, y: 0, z: 0, heading: 0 };
  /** Debug top-down view (M): straight down from high above the dog, north up. */
  topDown = false;

  constructor(
    private readonly dog: DogController,
    private readonly collision: CollisionWorld,
    private readonly input: Input,
    aspect: number,
  ) {
    const t = TUNING.camera;
    this.camera = new THREE.PerspectiveCamera(t.fov, aspect, t.near, t.far);
    const c = dog.profile.camera;
    this.yaw = this.yawTarget = dog.heading;
    this.pitch = this.pitchTarget = c.pitch;
    this.zoom = this.zoomTarget = c.distance;
    this.actualDistance = c.distance;
  }

  /** Horizontal yaw used to make WASD camera-relative. */
  get viewYaw(): number {
    return this.yaw;
  }

  /** Convert a local input vector (x = right, y = forward) into a world XZ direction. */
  inputToWorld(right: number, forward: number): Vec2 {
    const yaw = this.topDown ? 0 : this.yaw; // top-down: W = north (screen up)
    const f = headingToForward(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    return { x: f.x * forward + rx * right, z: f.z * forward + rz * right };
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Reset framing to the profile defaults (e.g. after switching dogs). */
  resetToProfile(): void {
    const c = this.dog.profile.camera;
    this.pitchTarget = c.pitch;
    this.zoomTarget = c.distance;
    this.yawTarget = this.dog.heading;
  }

  update(alpha: number, frameDt: number): void {
    const t = TUNING.camera;
    const c = this.dog.profile.camera;
    const pose = this.dog.interpolatedPose(alpha, this.pose);
    if (this.topDown) {
      this.updateTopDown(pose);
      return;
    }
    if (this.camera.up.y !== 1) this.camera.up.set(0, 1, 0);

    // --- Orbit & zoom input ---------------------------------------------
    const { dx, dy } = this.input.consumeMouseDelta();
    if (dx !== 0 || dy !== 0) {
      this.yawTarget = wrapAngle(this.yawTarget - dx * t.orbitSensitivity);
      this.pitchTarget = clamp(this.pitchTarget + dy * t.orbitSensitivity, t.minPitch, t.maxPitch);
      this.timeSinceOrbit = 0;
    } else {
      this.timeSinceOrbit += frameDt;
    }
    const wheel = this.input.consumeWheel();
    if (wheel !== 0) {
      this.zoomTarget = clamp(this.zoomTarget * (1 + t.zoomStep * wheel), c.minDistance, c.maxDistance);
    }

    // Auto-swing behind the dog while it moves and the player isn't orbiting.
    const speed = this.dog.groundSpeed;
    // Skipped when the dog runs toward the camera, otherwise "back" input would spiral.
    const diff = wrapAngle(pose.heading - this.yawTarget);
    if (t.recenterRate > 0 && this.timeSinceOrbit > t.recenterDelay && speed > 0.5 && Math.abs(diff) < t.recenterMaxAngle) {
      const speedFrac = clamp(speed / this.dog.profile.speeds.trot, 0, 1);
      this.yawTarget = wrapAngle(this.yawTarget + approach(0, diff, t.recenterRate * speedFrac * frameDt));
    }

    // --- Smoothing --------------------------------------------------------
    const ko = damp(t.orbitSharpness, frameDt);
    this.yaw = wrapAngle(lerpAngle(this.yaw, this.yawTarget, ko));
    this.pitch = lerp(this.pitch, this.pitchTarget, ko);
    this.zoom = lerp(this.zoom, this.zoomTarget, damp(t.zoomSharpness, frameDt));
    const sniffTarget = this.dog.state === 'sniff' ? 1 : 0;
    this.sniffBlend = lerp(this.sniffBlend, sniffTarget, damp(t.sniffBlendSharpness, frameDt));

    const lookHeight = lerp(c.lookHeight, c.sniffLookHeight, this.sniffBlend);
    const desiredDistance = lerp(this.zoom, Math.min(this.zoom, c.sniffDistance), this.sniffBlend);

    const tx = pose.x, ty = pose.y + lookHeight, tz = pose.z;
    if (!this.initialized) {
      this.target.set(tx, ty, tz);
      this.actualDistance = desiredDistance;
      this.initialized = true;
    } else {
      const kf = damp(t.followSharpness, frameDt);
      this.target.x += (tx - this.target.x) * kf;
      this.target.y += (ty - this.target.y) * kf;
      this.target.z += (tz - this.target.z) * kf;
    }

    // --- Obstacle avoidance: snap in when blocked, ease back out -----------
    const cosP = Math.cos(this.pitch);
    const ox = Math.sin(this.yaw) * cosP;
    const oy = Math.sin(this.pitch);
    const oz = Math.cos(this.yaw) * cosP;
    const T = this.target;
    const hit = this.collision.raycast(
      T.x, T.y, T.z,
      T.x + ox * desiredDistance, T.y + oy * desiredDistance, T.z + oz * desiredDistance,
    );
    const allowed = hit === null ? desiredDistance : Math.max(0.3, hit * desiredDistance - t.collisionMargin);
    if (allowed < this.actualDistance) this.actualDistance = allowed;
    else this.actualDistance = lerp(this.actualDistance, allowed, damp(t.unblockSharpness, frameDt));

    const d = this.actualDistance;
    const px = T.x + ox * d, pz = T.z + oz * d;
    const py = Math.max(T.y + oy * d, getGroundHeight(px, pz) + t.groundClearance);
    this.camera.position.set(px, py, pz);
    this.camera.lookAt(T);
  }

  private updateTopDown(pose: DogPose): void {
    const t = TUNING.camera;
    this.input.consumeMouseDelta();
    const wheel = this.input.consumeWheel();
    if (wheel !== 0) t.topDownHeight = clamp(t.topDownHeight * (1 + t.zoomStep * 2 * wheel), t.topDownMin, t.topDownMax);
    this.camera.up.set(0, 0, -1); // north at the top of the screen
    this.camera.position.set(pose.x, pose.y + t.topDownHeight, pose.z);
    this.camera.lookAt(pose.x, pose.y, pose.z);
    this.target.set(pose.x, pose.y + this.dog.profile.camera.lookHeight, pose.z); // resume smoothly
  }
}
