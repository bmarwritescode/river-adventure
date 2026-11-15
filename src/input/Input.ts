import { KEYS, type Action } from '../config/keys';

/**
 * Keyboard + mouse state. Polled by the game each sim step / frame.
 * - `isDown(action)` for held keys.
 * - `consumePressed(action)` for one-shot presses (edge-triggered, survives until consumed).
 * - `consumeMouseDelta()` for orbit, `consumeWheel()` for zoom.
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private wheel = 0;
  private dragging = false;
  private lastClientX: number | null = null;
  private lastClientY: number | null = null;
  private readonly codeToActions = new Map<string, Action[]>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    for (const [action, codes] of Object.entries(KEYS) as [Action, readonly string[]][]) {
      for (const code of codes) {
        const list = this.codeToActions.get(code) ?? [];
        list.push(action);
        this.codeToActions.set(code, list);
      }
    }
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.clear);
    document.addEventListener('visibilitychange', this.clear);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('click', this.onClick);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  isDown(action: Action): boolean {
    for (const code of KEYS[action]) if (this.down.has(code)) return true;
    return false;
  }

  consumePressed(action: Action): boolean {
    let hit = false;
    for (const code of KEYS[action]) {
      if (this.pressed.delete(code)) hit = true;
    }
    return hit;
  }

  consumeMouseDelta(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  private isTypingTarget(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isTypingTarget(e)) return;
    const actions = this.codeToActions.get(e.code);
    if (!actions) return;
    // Stop page scroll (Space/arrows) and Alt/Option side effects.
    e.preventDefault();
    if (!e.repeat) this.pressed.add(e.code);
    this.down.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
    // macOS quirk: while Meta (Cmd) is held, keyup for other keys is not delivered.
    if (e.code === 'MetaLeft' || e.code === 'MetaRight') this.down.clear();
  };

  /** Drop all held keys, e.g. when the tab loses focus mid-keypress. */
  private clear = (): void => {
    this.down.clear();
    this.pressed.clear();
    this.dragging = false;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0 || e.button === 2) this.dragging = true;
  };

  private onMouseUp = (): void => {
    this.dragging = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.pointerLocked) {
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    } else if (this.dragging) {
      // Drag mode: derive deltas from client coords (doesn't depend on movementX support).
      if (this.lastClientX !== null && this.lastClientY !== null) {
        this.mouseDX += e.clientX - this.lastClientX;
        this.mouseDY += e.clientY - this.lastClientY;
      }
    }
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Normalize line/page modes to roughly "notches".
    const scale = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 3 : 1 / 100;
    this.wheel += e.deltaY * scale;
  };

  private onClick = (): void => {
    if (this.pointerLocked) return;
    try {
      // Chrome returns a Promise; Safari returns undefined. Never let a refusal surface as an error.
      const result = this.canvas.requestPointerLock() as unknown;
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      /* pointer lock unavailable; drag-to-orbit still works */
    }
  };
}
