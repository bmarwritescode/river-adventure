import * as THREE from 'three';
import { TUNING } from '../config/tuning';

const SUN_DIR = new THREE.Vector3(0.45, 0.85, 0.3).normalize(); // high sun from the south-east
const SKY_RADIUS = 900;

/**
 * Sky, fog and lights. The sun's shadow camera follows the dog so shadow cost stays bounded
 * (only ~2 × shadowRadius meters around the dog cast/receive shadows). The sky is a big
 * vertex-colored dome that follows the camera (one draw call, no texture).
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.Fog;
  private readonly sky: THREE.Mesh;
  private fogEnabled = true;
  private skyKey = '';

  constructor(private readonly scene: THREE.Scene) {
    const L = TUNING.lighting;
    scene.background = new THREE.Color(L.skyHorizon);
    this.fog = new THREE.Fog(new THREE.Color(L.skyHorizon), 100, 400);
    scene.fog = this.fog;

    const geo = new THREE.SphereGeometry(SKY_RADIUS, 32, 48); // fine rings: smooth gradient at the horizon
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position!.count * 3), 3));
    this.sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
    }));
    this.sky.name = 'sky';
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.hemi = new THREE.HemisphereLight(L.hemiSkyColor, L.hemiGroundColor, L.hemiIntensity);
    this.sun = new THREE.DirectionalLight(L.sunColor, L.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.applyShadowSettings();
    scene.add(this.hemi, this.sun, this.sun.target);
    this.applyColors();
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

  /** Re-apply light/sky colors from TUNING (cheap; only does work when they changed). */
  private applyColors(): void {
    const L = TUNING.lighting;
    const key = `${L.sunColor}${L.hemiSkyColor}${L.hemiGroundColor}${L.skyZenith}${L.skyHorizon}`;
    if (key === this.skyKey) return;
    this.skyKey = key;
    this.sun.color.set(L.sunColor);
    this.hemi.color.set(L.hemiSkyColor);
    this.hemi.groundColor.set(L.hemiGroundColor);
    const horizon = new THREE.Color(L.skyHorizon), zenith = new THREE.Color(L.skyZenith);
    (this.scene.background as THREE.Color).copy(horizon);
    this.fog.color.copy(horizon);
    const pos = this.sky.geometry.attributes.position!;
    const col = this.sky.geometry.attributes.color!;
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getY(i) / SKY_RADIUS; // -1..1
      // Horizon color up to a bit above the horizon, then ease toward the zenith color.
      const t = Math.min(1, Math.max(0, (h - 0.02) / 0.6));
      c.copy(horizon).lerp(zenith, Math.pow(t, 0.7));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  setFogEnabled(on: boolean): void {
    this.fogEnabled = on;
    this.scene.fog = on ? this.fog : null;
  }

  /** Per frame: keep the shadow box on the dog, the sky on the camera, fog matched to the load radius. */
  update(x: number, y: number, z: number, camera: THREE.Camera): void {
    const r = TUNING.lighting.shadowRadius;
    // Snap to shadow texels to avoid shimmering edges while moving.
    const texel = (2 * r) / TUNING.lighting.shadowMapSize;
    const sx = Math.round(x / texel) * texel, sz = Math.round(z / texel) * texel;
    this.sun.target.position.set(sx, y, sz);
    this.sun.position.set(sx + SUN_DIR.x * 150, y + SUN_DIR.y * 150, sz + SUN_DIR.z * 150);
    this.sun.intensity = TUNING.lighting.sunIntensity;
    this.hemi.intensity = TUNING.lighting.hemiIntensity;
    this.sky.position.copy(camera.position);
    this.applyColors();
    if (this.fogEnabled) {
      this.fog.near = TUNING.map.loadRadius * TUNING.map.fogNearFraction;
      this.fog.far = TUNING.map.loadRadius * TUNING.map.fogFarFraction;
    }
  }
}
