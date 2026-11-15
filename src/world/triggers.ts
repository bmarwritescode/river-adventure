import type { Vec2 } from '../core/math';
import { TUNING } from '../config/tuning';
import { closestPointOnPolygon, pointInPolygon } from './geometry2d';

/**
 * The ONE trigger-zone module: named areas in world XZ that fire enter/exit
 * events when the dog's center moves into or out of them.
 * Clue locations, the front door, and future missions are all built on this.
 *
 * Exit uses a small hysteresis margin (TUNING.triggers.exitMargin) so standing
 * on a boundary doesn't spam enter/exit.
 */
export type TriggerShape =
  | { kind: 'circle'; x: number; z: number; radius: number }
  | { kind: 'polygon'; points: Vec2[] };

export interface TriggerZoneDef {
  /** Stable unique id, e.g. 'clue-03' or 'front-door'. */
  id: string;
  /** Human-readable name shown in debug view. */
  label: string;
  shape: TriggerShape;
  /** Free-form tags for consumers to filter on (e.g. 'clue', 'door', 'test'). */
  tags?: string[];
}

export interface TriggerEvent {
  type: 'enter' | 'exit';
  zone: TriggerZoneDef;
}

export type TriggerListener = (e: TriggerEvent) => void;

/** Signed-ish test: is the point inside the shape, expanded by `margin` meters? */
export function pointInShape(x: number, z: number, shape: TriggerShape, margin = 0): boolean {
  if (shape.kind === 'circle') {
    const r = shape.radius + margin;
    const dx = x - shape.x, dz = z - shape.z;
    return dx * dx + dz * dz <= r * r;
  }
  if (pointInPolygon(x, z, shape.points)) return true;
  if (margin <= 0) return false;
  return closestPointOnPolygon(x, z, shape.points).distSq <= margin * margin;
}

export class TriggerSystem {
  private readonly zones = new Map<string, TriggerZoneDef>();
  private readonly inside = new Set<string>();
  private readonly listeners = new Set<TriggerListener>();

  add(zone: TriggerZoneDef): void {
    if (this.zones.has(zone.id)) throw new Error(`Duplicate trigger zone id: ${zone.id}`);
    this.zones.set(zone.id, zone);
  }

  /** Removes a zone. If the dog was inside, an exit event fires. */
  remove(id: string): void {
    const zone = this.zones.get(id);
    if (!zone) return;
    this.zones.delete(id);
    if (this.inside.delete(id)) this.emit({ type: 'exit', zone });
  }

  /** Subscribe to enter/exit events. Returns an unsubscribe function. */
  on(listener: TriggerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isInside(id: string): boolean {
    return this.inside.has(id);
  }

  get insideIds(): string[] {
    return [...this.inside];
  }

  all(): Iterable<TriggerZoneDef> {
    return this.zones.values();
  }

  /** Call once per sim step with the dog's position. */
  update(x: number, z: number): void {
    const margin = TUNING.triggers.exitMargin;
    for (const zone of this.zones.values()) {
      const was = this.inside.has(zone.id);
      const now = pointInShape(x, z, zone.shape, was ? margin : 0);
      if (now === was) continue;
      if (now) this.inside.add(zone.id);
      else this.inside.delete(zone.id);
      this.emit({ type: now ? 'enter' : 'exit', zone });
    }
  }

  private emit(e: TriggerEvent): void {
    for (const l of this.listeners) l(e);
  }
}
