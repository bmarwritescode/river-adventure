import * as THREE from 'three';
import type { DogProfile } from '../config/dogProfiles';
import { TUNING } from '../config/tuning';
import { damp, TAU } from '../core/math';
import type { DogController, DogPose, DogState } from './DogController';

/**
 * Renders the dog. Reads DogController state; never writes to it.
 * The ONLY code allowed to touch the dog's meshes. Swapping the box dog for a
 * rigged .glb (clips: idle/walk/trot/run/sniff/jump/sit) only changes this file.
 *
 * Step 1: a blocky placeholder whose part sizes are derived from
 * profile.dimensions, so any profile (e.g. a smaller second dog) gets a
 * correctly proportioned box dog for free.
 */
export class DogVisual {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group(); // pivots at the hips: bob + pitch
  private readonly head = new THREE.Group(); // pivots at the base of the neck
  private readonly tail = new THREE.Group();
  private readonly legs: { pivot: THREE.Group; phase: number; front: boolean }[] = [];
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly materials: THREE.Material[] = [];

  private readonly pose: DogPose = { x: 0, y: 0, z: 0, heading: 0 };
  private gaitPhase = 0;
  private bobAmp = 0;
  private swingAmp = 0;
  private headPitch = 0;
  private bodyPitch = 0;
  private tailTime = 0;
  private readonly hipZ: number;

  constructor(private readonly controller: DogController) {
    const prof = controller.profile;
    const { length: L, shoulderHeight: H, headTopHeight: HT, chestWidth: W } = prof.dimensions;
    const c = prof.colors;
    const coat = this.mat(c.coat);
    const white = this.mat(c.chest);
    const brown = this.mat(c.lowerLegs);
    const nose = this.mat(c.nose);
    const eyes = this.mat(c.eyes);

    // Local frame: forward = -Z, origin on the ground under the body's middle.
    const noseZ = -L / 2;
    const tailZ = L / 2;
    const chestFront = noseZ + 0.3 * L;
    const chestBottom = 0.55 * H;
    const waistBottom = 0.7 * H;
    const midZ = chestFront + 0.32 * L;
    this.hipZ = tailZ - 0.1 * L;

    this.root.add(this.body);
    this.body.position.set(0, 0, this.hipZ);
    const b = (mesh: THREE.Object3D): void => {
      mesh.position.z -= this.hipZ; // children are authored in root space
      this.body.add(mesh);
    };

    // Torso: deep chest, tucked waist (whippet-like).
    b(this.box(coat, W, H - chestBottom, midZ - chestFront, 0, (H + chestBottom) / 2, (chestFront + midZ) / 2));
    b(this.box(coat, W * 0.8, 0.95 * H - waistBottom, tailZ - midZ, 0, (0.95 * H + waistBottom) / 2, (midZ + tailZ) / 2));
    // White tuxedo: chest plate on the front and a strip underneath.
    b(this.box(white, W * 0.78, (H - chestBottom) * 0.9, 0.012, 0, chestBottom + (H - chestBottom) * 0.45, chestFront - 0.006));
    b(this.box(white, W * 0.7, 0.012, (midZ - chestFront) * 0.7, 0, chestBottom - 0.006, chestFront + (midZ - chestFront) * 0.35));

    // Legs: pivot at the top, black upper / brown lower half.
    const legT = 0.28 * W;
    const legX = W / 2 - legT / 2;
    const addLeg = (x: number, z: number, top: number, front: boolean, phase: number): void => {
      const pivot = new THREE.Group();
      pivot.position.set(x, top, z);
      const lower = top * 0.5;
      pivot.add(this.box(coat, legT, top - lower, legT, 0, -(top - lower) / 2, 0));
      pivot.add(this.box(brown, legT * 0.95, lower, legT * 0.95, 0, -top + lower / 2, 0));
      b(pivot);
      this.legs.push({ pivot, phase, front });
    };
    const frontZ = chestFront + 0.08 * L;
    addLeg(-legX, frontZ, chestBottom + 0.04, true, 0);
    addLeg(legX, frontZ, chestBottom + 0.04, true, Math.PI);
    addLeg(-legX, this.hipZ, waistBottom + 0.04, false, Math.PI);
    addLeg(legX, this.hipZ, waistBottom + 0.04, false, 0);

    // Head group: neck + broad pit-bull skull + strong snout.
    const neckBaseY = 0.85 * H;
    this.head.position.set(0, neckBaseY, chestFront + 0.03);
    b(this.head);
    const h = (mesh: THREE.Object3D): THREE.Object3D => {
      mesh.position.y -= neckBaseY;
      mesh.position.z -= chestFront + 0.03;
      this.head.add(mesh);
      return mesh;
    };
    const skullH = 0.16 * L;
    const skullL = 0.17 * L;
    const skullW = 0.72 * W;
    const skullY = HT - skullH / 2;
    const skullZ = noseZ + 0.13 * L + skullL / 2;
    const neck = h(this.box(coat, W * 0.55, HT - neckBaseY, 0.1 * L, 0, (HT + neckBaseY) / 2 - 0.03, chestFront + 0.02));
    neck.rotation.x = 0.35;
    const throat = h(this.box(white, W * 0.4, (HT - neckBaseY) * 0.8, 0.01, 0, (HT + neckBaseY) / 2 - 0.05, chestFront - 0.03));
    throat.rotation.x = 0.35;
    h(this.box(coat, skullW, skullH, skullL, 0, skullY, skullZ));
    const snoutL = 0.13 * L;
    const snoutH = skullH * 0.6;
    const snoutY = skullY - skullH / 2 + snoutH / 2;
    h(this.box(coat, skullW * 0.62, snoutH, snoutL, 0, snoutY, noseZ + snoutL / 2));
    h(this.box(nose, skullW * 0.32, snoutH * 0.4, 0.03, 0, snoutY + snoutH * 0.25, noseZ - 0.005));
    for (const s of [-1, 1]) {
      h(this.box(eyes, 0.022, 0.022, 0.01, s * skullW * 0.28, skullY + skullH * 0.12, skullZ - skullL / 2 - 0.004));
      const ear = h(this.box(coat, skullW * 0.28, skullH * 0.45, 0.02, s * skullW * 0.36, HT + skullH * 0.12, skullZ + skullL * 0.25));
      ear.rotation.z = s * -0.5;
    }

    // Tail: pivot at the tail base, extends backward (+Z).
    this.tail.position.set(0, 0.9 * H, tailZ);
    const tailLen = 0.36 * L;
    this.tail.add(this.box(coat, 0.035, 0.035, tailLen, 0, 0, tailLen / 2));
    b(this.tail);

    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
  }

  get profile(): DogProfile {
    return this.controller.profile;
  }

  update(alpha: number, frameDt: number): void {
    const ctl = this.controller;
    const v = TUNING.visual;
    ctl.interpolatedPose(alpha, this.pose);
    this.root.position.set(this.pose.x, this.pose.y, this.pose.z);
    this.root.rotation.y = this.pose.heading;

    const state: DogState = ctl.state;
    const speed = ctl.groundSpeed;
    const [bobTarget, swingTarget, stride] =
      state === 'run' ? [v.bobRun, v.legSwingRun, v.strideRun]
      : state === 'trot' ? [v.bobTrot, v.legSwingTrot, v.strideTrot]
      : state === 'walk' || (state === 'sniff' && speed > 0.05) ? [v.bobWalk, v.legSwingWalk, v.strideWalk]
      : [0, 0, v.strideWalk];
    const k = damp(v.poseSharpness, frameDt);
    this.bobAmp += (bobTarget - this.bobAmp) * k;
    this.swingAmp += (swingTarget - this.swingAmp) * k;
    this.gaitPhase = (this.gaitPhase + (speed / stride) * TAU * frameDt) % TAU;

    // Legs: diagonal pairs for walk/trot; front/rear pairs for a gallop-ish run.
    const gallop = state === 'run';
    for (const leg of this.legs) {
      const offset = gallop ? (leg.front ? 0 : Math.PI) + (leg.phase ? 0.4 : 0) : leg.phase;
      leg.pivot.rotation.x = state === 'jump'
        ? (leg.front ? -0.6 : 0.6)
        : Math.sin(this.gaitPhase + offset) * this.swingAmp;
    }

    // Body: bob twice per stride; tilt nose-down to sniff, nose-up while rising in a jump.
    const bob = Math.abs(Math.sin(this.gaitPhase)) * this.bobAmp;
    this.body.position.y = bob;
    let bodyPitchTarget = 0;
    if (state === 'sniff') bodyPitchTarget = v.sniffBodyPitch;
    else if (state === 'jump') bodyPitchTarget = Math.max(-0.3, Math.min(0.3, ctl.velocity.y * 0.08));
    this.bodyPitch += (bodyPitchTarget - this.bodyPitch) * k;
    this.body.rotation.x = this.bodyPitch;

    const headTarget = state === 'sniff'
      ? v.sniffHeadPitch + Math.sin(this.tailTime * 7) * 0.06 // snuffling
      : Math.sin(this.gaitPhase * 2) * this.bobAmp * 1.5;
    this.headPitch += (headTarget - this.headPitch) * k;
    this.head.rotation.x = this.headPitch;

    // Tail: wags when idle/sniffing, streams back when running.
    this.tailTime += frameDt;
    const wag = state === 'idle' || state === 'sniff' ? v.tailWagAmount : v.tailWagAmount * 0.3;
    this.tail.rotation.y = Math.sin(this.tailTime * v.tailWagSpeed) * wag;
    this.tail.rotation.x = state === 'run' ? 0.15 : 0.6;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }

  private mat(color: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    this.materials.push(m);
    return m;
  }

  /** A unit box scaled to (w,h,d) and centered at (x,y,z). All share one geometry. */
  private box(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(this.geometry, mat);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    return mesh;
  }
}
