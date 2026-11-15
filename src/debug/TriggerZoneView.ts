import * as THREE from 'three';
import type { TriggerSystem, TriggerZoneDef } from '../world/triggers';
import { getGroundHeight } from '../world/ground';

const IDLE_COLOR = 0x3fa9ff;
const ACTIVE_COLOR = 0xffd23f;
const LIFT = 0.03; // meters above ground to avoid z-fighting

interface ZoneVisual {
  zone: TriggerZoneDef;
  fillMat: THREE.MeshBasicMaterial;
  lineMat: THREE.LineBasicMaterial;
}

/**
 * Debug-only rendering of trigger zones: translucent fill, outline, and a name label.
 * Toggled with T. Later this also shows clue locations.
 */
export class TriggerZoneView {
  readonly group = new THREE.Group();
  private readonly visuals: ZoneVisual[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  constructor(private readonly triggers: TriggerSystem) {
    this.group.name = 'debug-trigger-zones';
    for (const zone of triggers.all()) this.addZone(zone);
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Recolor zones the dog is currently inside. */
  update(): void {
    if (!this.group.visible) return;
    for (const v of this.visuals) {
      const inside = this.triggers.isInside(v.zone.id);
      const color = inside ? ACTIVE_COLOR : IDLE_COLOR;
      v.fillMat.color.setHex(color);
      v.fillMat.opacity = inside ? 0.35 : 0.22;
      v.lineMat.color.setHex(color);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }

  private addZone(zone: TriggerZoneDef): void {
    const fillMat = this.track(new THREE.MeshBasicMaterial({
      color: IDLE_COLOR, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide,
    }));
    const lineMat = this.track(new THREE.LineBasicMaterial({ color: IDLE_COLOR }));

    let outline: THREE.Vector3[];
    let fillGeom: THREE.BufferGeometry;
    let cx: number, cz: number;
    const s = zone.shape;
    if (s.kind === 'circle') {
      cx = s.x; cz = s.z;
      fillGeom = new THREE.CircleGeometry(s.radius, 48);
      fillGeom.rotateX(-Math.PI / 2);
      fillGeom.translate(s.x, 0, s.z);
      outline = [];
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        outline.push(new THREE.Vector3(s.x + Math.cos(a) * s.radius, 0, s.z + Math.sin(a) * s.radius));
      }
    } else {
      cx = s.points.reduce((a, p) => a + p.x, 0) / s.points.length;
      cz = s.points.reduce((a, p) => a + p.z, 0) / s.points.length;
      fillGeom = new THREE.ShapeGeometry(new THREE.Shape(s.points.map((p) => new THREE.Vector2(p.x, -p.z))));
      fillGeom.rotateX(-Math.PI / 2);
      outline = [...s.points, s.points[0]!].map((p) => new THREE.Vector3(p.x, 0, p.z));
    }
    // Drape on the ground via getGroundHeight (flat today, terrain later).
    const pos = fillGeom.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, getGroundHeight(pos.getX(i), pos.getZ(i)) + LIFT);
    for (const p of outline) p.y = getGroundHeight(p.x, p.z) + LIFT * 2;

    const fill = new THREE.Mesh(this.track(fillGeom), fillMat);
    fill.renderOrder = 1;
    const line = new THREE.Line(this.track(new THREE.BufferGeometry().setFromPoints(outline)), lineMat);
    const label = this.makeLabel(zone.label);
    label.position.set(cx, getGroundHeight(cx, cz) + 1.6, cz);
    this.group.add(fill, line, label);
    this.visuals.push({ zone, fillMat, lineMat });
  }

  private makeLabel(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d')!;
    const font = 'bold 40px system-ui, -apple-system, sans-serif';
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 24;
    canvas.width = w;
    canvas.height = 60;
    g.font = font;
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(0, 0, w, 60);
    g.fillStyle = '#fff';
    g.textBaseline = 'middle';
    g.fillText(text, 12, 31);
    const tex = this.track(new THREE.CanvasTexture(canvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = this.track(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    const sprite = new THREE.Sprite(mat);
    const height = 0.5;
    sprite.scale.set((height * w) / 60, height, 1);
    sprite.renderOrder = 2;
    return sprite;
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }
}
