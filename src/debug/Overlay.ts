import { TUNING } from '../config/tuning';
import type { DogController } from '../dog/DogController';

/** Top-left debug text: FPS, dog state, speed, position. */
export class Overlay {
  private readonly el = document.createElement('div');
  private frames = 0;
  private fpsWindow = 0;
  private sinceText = 0;
  /** Frames per second averaged over the last ~0.5 s. */
  fps = 0;

  constructor(private readonly dog: DogController) {
    this.el.className = 'overlay';
    document.body.appendChild(this.el);
  }

  update(frameDt: number, extra: string): void {
    this.frames++;
    this.fpsWindow += frameDt;
    if (this.fpsWindow >= 0.5) {
      this.fps = this.frames / this.fpsWindow;
      this.frames = 0;
      this.fpsWindow = 0;
    }
    this.sinceText += frameDt;
    if (this.sinceText < 1 / TUNING.debug.overlayHz) return;
    this.sinceText = 0;
    const d = this.dog;
    const p = d.position;
    const deg = ((-d.heading * 180) / Math.PI + 360) % 360; // compass bearing: 0 = N, 90 = E
    this.el.textContent =
      `FPS    ${this.fps.toFixed(0)}\n` +
      `state  ${d.state}\n` +
      `speed  ${d.groundSpeed.toFixed(2)} m/s\n` +
      `pos    x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}  y ${p.y.toFixed(2)}\n` +
      `facing ${deg.toFixed(0)}°\n` +
      extra;
  }

  dispose(): void {
    this.el.remove();
  }
}
