import * as THREE from 'three';
import type { Vec2 } from '../core/math';

/**
 * Extrude a world-XZ footprint into a vertical prism geometry (y from baseY to baseY+height).
 * Same footprint format as collision obstacles, so visuals and collision never drift apart.
 * Reused by Step 2 for OSM building footprints.
 */
export function extrudeFootprint(footprint: readonly Vec2[], height: number, baseY = 0): THREE.BufferGeometry {
  // Shape lives in (x, -z); rotating -90° about X maps shape-y -> world -z and extrusion -> world +y.
  const shape = new THREE.Shape(footprint.map((p) => new THREE.Vector2(p.x, -p.z)));
  const geom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, baseY, 0);
  geom.computeVertexNormals();
  return geom;
}
