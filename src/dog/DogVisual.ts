import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BoxDogRig } from './BoxDogRig';
import type { DogController, DogPose } from './DogController';
import { ModelDogRig } from './ModelDogRig';

export type DogVisualKind = 'box' | 'loading' | 'model' | 'failed';

/**
 * Renders the dog. Reads DogController state; never writes to it.
 * The ONLY code allowed to touch the dog's meshes (BoxDogRig / ModelDogRig are its private parts).
 *
 * Shows the box dog immediately, loads profile.modelPath (.glb) in the background, and swaps to the
 * model once it's ready. If the model fails to load, the box dog stays (and a warning is logged).
 */
export class DogVisual {
  readonly root = new THREE.Group();
  private box: BoxDogRig | null;
  private model: ModelDogRig | null = null;
  private disposed = false;
  private readonly pose: DogPose = { x: 0, y: 0, z: 0, heading: 0 };
  kind: DogVisualKind = 'box';

  constructor(private readonly controller: DogController) {
    this.box = new BoxDogRig(controller);
    this.root.add(this.box.root);
    const path = controller.profile.modelPath;
    if (path) void this.loadModel(path);
  }

  /** Names of the clips in the loaded model (empty until loaded). */
  get clipNames(): string[] {
    return this.model?.clipNames ?? [];
  }

  update(alpha: number, frameDt: number): void {
    this.controller.interpolatedPose(alpha, this.pose);
    this.root.position.set(this.pose.x, this.pose.y, this.pose.z);
    this.root.rotation.y = this.pose.heading;
    if (this.model) this.model.update(frameDt);
    else this.box?.update(frameDt);
  }

  dispose(): void {
    this.disposed = true;
    this.model?.dispose();
    this.box?.dispose();
    this.root.removeFromParent();
  }

  private async loadModel(path: string): Promise<void> {
    this.kind = 'loading';
    try {
      const url = new URL(`${import.meta.env.BASE_URL}${path}`, document.baseURI).href;
      const gltf = await new GLTFLoader().loadAsync(url);
      if (this.disposed) return;
      const rig = new ModelDogRig(this.controller, gltf);
      this.model = rig;
      this.root.add(rig.root);
      if (this.box) {
        this.box.dispose();
        this.box = null;
      }
      this.kind = 'model';
    } catch (err) {
      console.warn(`[dog] could not load model '${path}', keeping the box dog:`, err);
      this.kind = 'failed';
    }
  }
}
