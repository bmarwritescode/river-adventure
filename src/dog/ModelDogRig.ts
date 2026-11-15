import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TUNING } from '../config/tuning';
import { CLIP_FOR_STATE, DOG_CLIP_NAMES, type DogClipName } from './clips';
import type { DogController, DogState } from './DogController';

/**
 * Rigged .glb dog (part of DogVisual; nothing else may touch it).
 *
 * Conventions for the file (CLAUDE.md "Dog model conventions"): 1 unit = 1 m, Y up, faces +Z,
 * origin on the ground under the body, clips named as in DOG_CLIP_NAMES, locomotion clips = one stride.
 * The model is uniformly scaled so its shoulder height matches the DogProfile.
 */
export class ModelDogRig {
  readonly root = new THREE.Group();
  readonly clipNames: string[];
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<DogClipName, THREE.AnimationAction>();
  private current: DogClipName | null = null;
  private lastState: DogState | null = null;

  constructor(
    private readonly controller: DogController,
    gltf: GLTF,
  ) {
    const model = gltf.scene;
    const prof = controller.profile;

    // Scale: authored dimensions from extras if present, else measure the bounding box height.
    const dims = (model.userData.dims ?? model.children[0]?.userData?.dims) as { shoulderHeight?: number } | undefined;
    let scale = 1;
    if (dims?.shoulderHeight) {
      scale = prof.dimensions.shoulderHeight / dims.shoulderHeight;
    } else {
      const box = new THREE.Box3().setFromObject(model);
      const h = box.max.y - box.min.y;
      if (h > 0) scale = prof.dimensions.headTopHeight / h;
    }
    model.scale.setScalar(scale);
    model.rotation.y = Math.PI; // file faces +Z; the game's dogs face -Z (heading 0 = north)

    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.frustumCulled = false; // skinned bounds don't follow the animation; the dog is always in view
      }
    });
    this.root.add(model);

    this.mixer = new THREE.AnimationMixer(model);
    this.clipNames = gltf.animations.map((c) => c.name);
    for (const name of DOG_CLIP_NAMES) {
      const clip = THREE.AnimationClip.findByName(gltf.animations, name);
      if (!clip) {
        console.warn(`[dog] model is missing clip '${name}'; falling back to 'idle'`);
        continue;
      }
      const action = this.mixer.clipAction(clip);
      if (name === 'jump') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(name, action);
    }
    if (!this.actions.has('idle')) throw new Error("dog model has no 'idle' clip");
  }

  /** Every required clip is present. */
  get complete(): boolean {
    return DOG_CLIP_NAMES.every((n) => this.actions.has(n));
  }

  update(frameDt: number): void {
    const ctl = this.controller;
    const state = ctl.state;
    const want = this.actions.has(CLIP_FOR_STATE[state]) ? CLIP_FOR_STATE[state] : 'idle';
    if (want !== this.current) this.play(want, this.fadeTime(this.lastState, state));
    this.lastState = state;

    // Playback rate: locomotion clips are one stride, so match stride frequency to ground speed
    // (feet don't slide); the jump clip is stretched to the actual time in the air.
    const v = TUNING.visual;
    const action = this.actions.get(want)!;
    const speed = ctl.groundSpeed;
    const dur = action.getClip().duration;
    if (want === 'walk') action.timeScale = (speed / v.strideWalk) * dur;
    else if (want === 'trot') action.timeScale = (speed / v.strideTrot) * dur;
    else if (want === 'run') action.timeScale = (speed / v.strideRun) * dur;
    else if (want === 'jump') {
      const g = TUNING.world.gravity;
      const airTime = 2 * Math.sqrt((2 * ctl.profile.jump.height) / g);
      action.timeScale = dur / Math.max(0.1, airTime);
    } else action.timeScale = 1;

    this.mixer.update(frameDt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
        mat.dispose();
      }
    });
    this.root.removeFromParent();
  }

  private play(name: DogClipName, fade: number): void {
    const next = this.actions.get(name)!;
    const prev = this.current ? this.actions.get(this.current) : undefined;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    this.current = name;
  }

  /** Cross-fade duration between states (the sit / bow transitions are the fade itself). */
  private fadeTime(from: DogState | null, to: DogState): number {
    const f = TUNING.visual;
    if (from === null) return 0;
    if (to === 'sit' || to === 'playBow') return f.fadeIntoPose;
    if (from === 'sit' || from === 'playBow') return f.fadeOutOfPose;
    if (to === 'jump' || from === 'jump') return f.fadeJump;
    return f.fadeDefault;
  }
}
