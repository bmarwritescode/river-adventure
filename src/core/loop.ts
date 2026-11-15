import { TUNING } from '../config/tuning';

export interface LoopCallbacks {
  /** Fixed-timestep simulation step. `dt` is always 1 / tickRate. */
  step(dt: number): void;
  /**
   * Called once per animation frame after simulation.
   * `alpha` in [0,1) is how far we are between the last two sim states (for interpolation).
   * `frameDt` is the clamped real time since the previous frame (for render-side smoothing).
   */
  render(alpha: number, frameDt: number): void;
  /** Optional: per-frame timing (raw ms since the previous frame, ms spent in step+render). */
  frameDone?(atMs: number, rawFrameMs: number, cpuMs: number): void;
}

/**
 * Fixed-timestep game loop with decoupled, interpolated rendering.
 * Large frame gaps (tab switch, debugger pause) are clamped so nothing explodes.
 */
export class GameLoop {
  private accumulator = 0;
  private lastTime = -1;
  private lastRawMs = -1;
  private rafId = 0;
  private running = false;
  /** Total simulated seconds. */
  simTime = 0;

  constructor(private readonly cb: LoopCallbacks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = -1;
    this.lastRawMs = -1;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private frame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);
    const cpuStart = performance.now();

    const { tickRate, maxFrameDelta, maxStepsPerFrame } = TUNING.sim;
    const dt = 1 / tickRate;
    const now = nowMs / 1000;
    let frameDt = this.lastTime < 0 ? dt : now - this.lastTime;
    this.lastTime = now;
    frameDt = Math.min(Math.max(frameDt, 0), maxFrameDelta);

    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= dt && steps < maxStepsPerFrame) {
      this.cb.step(dt);
      this.simTime += dt;
      this.accumulator -= dt;
      steps++;
    }
    // If we hit the step cap, drop the backlog rather than spiralling.
    if (steps >= maxStepsPerFrame) this.accumulator = Math.min(this.accumulator, dt);

    this.cb.render(this.accumulator / dt, frameDt);

    if (this.cb.frameDone && this.lastRawMs >= 0) {
      this.cb.frameDone(nowMs, nowMs - this.lastRawMs, performance.now() - cpuStart);
    }
    this.lastRawMs = nowMs;
  };
}
