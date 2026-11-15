import * as THREE from 'three';
import type { Vec2 } from '../core/math';
import { TUNING } from '../config/tuning';
import type { CollisionWorld, Obstacle } from './collision';
import { extrudeFootprint } from './footprintMesh';
import { circleFootprint, rectFootprint } from './geometry2d';
import type { TriggerZoneDef } from './triggers';

/**
 * TEMPORARY test level for judging movement feel (Step 1 only).
 * Replaced by streamed OSM tiles in Step 2.
 *
 * Dog spawns at the origin facing north (-Z). Distances are in meters.
 */

export const TEST_LEVEL_SIZE = 200;
export const TEST_SPAWN = { x: 0, z: 0, heading: 0 };

export const TEST_TRIGGER_ZONES: TriggerZoneDef[] = [
  // Directly ahead of spawn: walking forward ~2 s enters it (the smoke test relies on this).
  { id: 'test-a', label: 'Zone A (circle)', shape: { kind: 'circle', x: 0, z: -6, radius: 2 }, tags: ['test'] },
  { id: 'test-b', label: 'Zone B (circle)', shape: { kind: 'circle', x: 14, z: 10, radius: 3 }, tags: ['test'] },
  {
    id: 'test-c',
    label: 'Zone C (polygon)',
    shape: { kind: 'polygon', points: [{ x: -20, z: 4 }, { x: -11, z: 6 }, { x: -12, z: 13 }, { x: -19, z: 12 }] },
    tags: ['test'],
  },
];

interface ObstacleSpec extends Obstacle {
  kind: 'house' | 'trunk' | 'fence' | 'crate' | 'wall';
}

function buildObstacles(): ObstacleSpec[] {
  const out: ObstacleSpec[] = [];
  const add = (kind: ObstacleSpec['kind'], id: string, footprint: Vec2[], height: number): void => {
    out.push({ kind, id, footprint, height });
  };

  // House-sized boxes (~10 x 12 m, ~6 m tall). One straight ahead for wall-slide tests, one rotated.
  add('house', 'house-north', rectFootprint(0, -40, 12, 10), 6);
  add('house', 'house-ne', rectFootprint(24, -22, 10, 12), 6);
  add('house', 'house-nw-rotated', rectFootprint(-24, -26, 10, 12, 0.45), 6.5);
  add('house', 'house-east', rectFootprint(36, 14, 12, 10), 5.5);
  // Concave L-shaped building (OSM footprints are often concave): tests inside-corner sliding.
  add('house', 'house-L', [
    { x: -40, z: 18 }, { x: -26, z: 18 }, { x: -26, z: 26 }, { x: -33, z: 26 }, { x: -33, z: 34 }, { x: -40, z: 34 },
  ], 6);

  // Thin tree trunks.
  const trunks: [number, number][] = [[6, -14], [-7, -18], [10, -30], [-12, -6], [18, 4], [-4, 22], [28, -4], [3, 12]];
  trunks.forEach(([x, z], i) => add('trunk', `trunk-${i}`, circleFootprint(x, z, 0.22, 8), 5));

  // Low fence: segments along x at z = -16, with a 0.45 m gap (too narrow for the main dog)
  // and a 0.9 m gap (fits). Useful later for the smaller second dog.
  const fenceZ = -16;
  const segs: [number, number][] = [[-14, -6], [-5.55, 2], [2.9, 14]];
  segs.forEach(([x0, x1], i) => add('fence', `fence-${i}`, rectFootprint((x0 + x1) / 2, fenceZ, x1 - x0, 0.12), 0.9));

  // Small dog-sized crates.
  const crates: [number, number, number][] = [[4, -3, 0.5], [5.2, -4.4, 0.45], [-4, -10, 0.6], [-3.2, -11, 0.4], [9, 6, 0.7]];
  crates.forEach(([x, z, s], i) => add('crate', `crate-${i}`, rectFootprint(x, z, s, s, i * 0.3), s));

  // Invisible boundary walls so the dog can't walk off the ground plane.
  const h = TEST_LEVEL_SIZE / 2;
  add('wall', 'bound-n', rectFootprint(0, -h, TEST_LEVEL_SIZE, 1), 3);
  add('wall', 'bound-s', rectFootprint(0, h, TEST_LEVEL_SIZE, 1), 3);
  add('wall', 'bound-e', rectFootprint(h, 0, 1, TEST_LEVEL_SIZE), 3);
  add('wall', 'bound-w', rectFootprint(-h, 0, 1, TEST_LEVEL_SIZE), 3);
  return out;
}

function makeGridTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  // One texture tile = 10 m: thin lines every 1 m, a bold line every 10 m.
  const px = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#86a872';
  g.fillRect(0, 0, px, px);
  g.fillStyle = 'rgba(30, 50, 25, 0.35)';
  const cell = px / 10;
  for (let i = 1; i < 10; i++) {
    g.fillRect(Math.round(i * cell) - 1, 0, 2, px);
    g.fillRect(0, Math.round(i * cell) - 1, px, 2);
  }
  g.fillStyle = 'rgba(20, 35, 15, 0.7)';
  g.fillRect(0, 0, 4, px);
  g.fillRect(0, 0, px, 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(TEST_LEVEL_SIZE / 10, TEST_LEVEL_SIZE / 10);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface TestLevel {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  /** Keep the shadow camera centered on the dog. */
  followShadow(x: number, z: number): void;
  dispose(): void;
}

const SKY_COLOR = 0x9cc8ea;
const SUN_OFFSET = new THREE.Vector3(30, 60, 20); // sun from the south-east-ish, high

export function buildTestLevel(scene: THREE.Scene, renderer: THREE.WebGLRenderer, collision: CollisionWorld): TestLevel {
  const group = new THREE.Group();
  group.name = 'test-level';
  scene.add(group);
  scene.background = new THREE.Color(SKY_COLOR);
  scene.fog = new THREE.Fog(SKY_COLOR, 70, 190);

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(d: T): T => (disposables.push(d), d);

  // Ground
  const gridTex = track(makeGridTexture(renderer));
  const groundGeom = track(new THREE.PlaneGeometry(TEST_LEVEL_SIZE, TEST_LEVEL_SIZE));
  groundGeom.rotateX(-Math.PI / 2);
  const groundMat = track(new THREE.MeshStandardMaterial({ map: gridTex, roughness: 1 }));
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.receiveShadow = true;
  group.add(ground);

  // Lights
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5a6b45, TUNING.lighting.hemiIntensity);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, TUNING.lighting.sunIntensity);
  sun.castShadow = true;
  const r = TUNING.lighting.shadowRadius;
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 200 });
  sun.shadow.mapSize.set(TUNING.lighting.shadowMapSize, TUNING.lighting.shadowMapSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  group.add(sun, sun.target);

  // Obstacles: one material per kind, geometry built from the same footprint the collision uses.
  const mats: Record<ObstacleSpec['kind'], THREE.MeshStandardMaterial> = {
    house: track(new THREE.MeshStandardMaterial({ color: 0xc9b8a0, roughness: 0.9 })),
    trunk: track(new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 1 })),
    fence: track(new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.9 })),
    crate: track(new THREE.MeshStandardMaterial({ color: 0xb07a3c, roughness: 0.9 })),
    wall: track(new THREE.MeshStandardMaterial({ color: 0x888888 })),
  };
  for (const spec of buildObstacles()) {
    collision.add(spec);
    if (spec.kind === 'wall') continue; // invisible boundary
    const mesh = new THREE.Mesh(track(extrudeFootprint(spec.footprint, spec.height, spec.baseY)), mats[spec.kind]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = spec.id;
    group.add(mesh);
  }

  return {
    group,
    sun,
    followShadow(x, z) {
      sun.target.position.set(x, 0, z);
      sun.position.set(x + SUN_OFFSET.x, SUN_OFFSET.y, z + SUN_OFFSET.z);
      sun.intensity = TUNING.lighting.sunIntensity;
      hemi.intensity = TUNING.lighting.hemiIntensity;
    },
    dispose() {
      group.removeFromParent();
      for (const d of disposables) d.dispose();
      sun.shadow.map?.dispose();
    },
  };
}
