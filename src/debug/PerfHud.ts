import type { PerfMonitor } from './PerfMonitor';

export interface PerfHudInfo {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  heapMB: number | null;
  tiles: number;
}

const W = 260, H = 70, BARS = 240;
const MAX_MS = 50;

/**
 * Performance overlay (G): live frame-time graph (green < 16.7 ms, yellow < 33.3 ms, red above)
 * plus summary numbers. Meant for checking real Safari / other machines by eye.
 */
export class PerfHud {
  private readonly el = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly text = document.createElement('div');
  private readonly g: CanvasRenderingContext2D;
  private readonly buf: number[] = [];
  private visible = false;
  private tick = 0;

  constructor(private readonly monitor: PerfMonitor) {
    this.el.className = 'perf-hud';
    this.canvas.width = W * 2;
    this.canvas.height = H * 2;
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.el.append(this.canvas, this.text);
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    this.g = this.canvas.getContext('2d')!;
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? '' : 'none';
    return this.visible;
  }

  update(info: PerfHudInfo): void {
    if (!this.visible || this.tick++ % 3 !== 0) return;
    const g = this.g;
    const frames = this.monitor.recentFrames(BARS, this.buf);
    g.setTransform(2, 0, 0, 2, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, 0, W, H);
    const bw = W / BARS;
    frames.forEach((ms, k) => {
      const h = Math.min(H, (ms / MAX_MS) * H);
      g.fillStyle = ms <= 17 ? '#5c5' : ms <= 34 ? '#ec4' : '#e44';
      g.fillRect(k * bw, H - h, Math.max(1, bw - 0.2), h);
    });
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 0.5;
    for (const ms of [16.7, 33.3]) {
      const y = H - (ms / MAX_MS) * H;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
    }
    const s = this.monitor.summary(performance.now() - 5000);
    this.text.textContent =
      `${s.fps.toFixed(0)} fps · p95 ${s.p95FrameMs.toFixed(1)} ms · max ${s.maxFrameMs.toFixed(0)} ms · ` +
      `stutters ${s.hitches} (last 5 s)\n` +
      `cpu avg ${s.avgCpuMs.toFixed(1)} ms · p95 ${s.p95CpuMs.toFixed(1)} ms\n` +
      `draws ${info.drawCalls} · tris ${(info.triangles / 1000).toFixed(0)}k · tiles ${info.tiles}\n` +
      `geometries ${info.geometries} · textures ${info.textures}` +
      (info.heapMB !== null ? ` · heap ${info.heapMB.toFixed(0)} MB` : '');
  }

  dispose(): void {
    this.el.remove();
  }
}
