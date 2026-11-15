import * as THREE from 'three';
import { TUNING } from '../config/tuning';

const SUN_DIR = new THREE.Vector3(0.45, 0.85, 0.3).normalize(); // high sun from the south-east

/**
 * Sky, fog and lights. The sun's shadow camera follows the dog so shadow cost stays bounded
 * (only ~2 × shadowRadius meters around the dog cast/receive shadows).
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.Fog;
  private fogEnabled = true;

  constructor(private readonly scene: THREE.Scene) {
    const sky = new THREE.Color(TUNING.map.skyColor);
    scene.background = sky;
    this.fog = new THREE.Fog(sky, 100, 400);
    scene.fog = this.fog;

    this.hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5a6b45, TUNING.lighting.hemiIntensity);
    this.sun = new THREE.DirectionalLight(0xfff1dc, TUNING.lighting.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.applyShadowSettings();
    scene.add(this.hemi, this.sun, this.sun.target);
  }

  applyShadowSettings(): void {
    const r = TUNING.lighting.shadowRadius;
    const cam = this.sun.shadow.camera;
    Object.assign(cam, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 400 });
    cam.updateProjectionMatrix();
    const size = TUNING.lighting.shadowMapSize;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  setFogEnabled(on: boolean): void {
    this.fogEnabled = on;
    this.scene.fog = on ? this.fog : null;
  }

  /** Per frame: keep the shadow box on the dog and fog matched to the tile load radius. */
  update(x: number, y: number, z: number): void {
    const r = TUNING.lighting.shadowRadius;
    // Snap to shadow texels to avoid shimmering edges while moving.
    const texel = (2 * r) / TUNING.lighting.shadowMapSize;
    const sx = Math.round(x / texel) * texel, sz = Math.round(z / texel) * texel;
    this.sun.target.position.set(sx, y, sz);
    this.sun.position.set(sx + SUN_DIR.x * 150, y + SUN_DIR.y * 150, sz + SUN_DIR.z * 150);
    this.sun.intensity = TUNING.lighting.sunIntensity;
    this.hemi.intensity = TUNING.lighting.hemiIntensity;
    if (this.fogEnabled) {
      this.fog.near = TUNING.map.loadRadius * TUNING.map.fogNearFraction;
      this.fog.far = TUNING.map.loadRadius * TUNING.map.fogFarFraction;
    }
  }
}
