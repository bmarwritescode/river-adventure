/**
 * Records per-frame timing in a ring buffer:
 *   frameMs = real time between animation frames (what the player sees; capped by the display's vsync)
 *   cpuMs   = time our code spent in the frame (simulation + render submission) = headroom indicator
 * Summaries are used by the perf HUD (G), the debug API, and the perf benchmark (npm run perf).
 */
export interface PerfSummary {
  frames: number;
  seconds: number;
  fps: number;
  avgFrameMs: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  maxFrameMs: number;
  /** Frames longer than 50 ms: visible stutters. */
  hitches: number;
  avgCpuMs: number;
  p95CpuMs: number;
  maxCpuMs: number;
}

const CAPACITY = 7200; // ~1 min at 120 Hz

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export class PerfMonitor {
  private readonly at = new Float64Array(CAPACITY);
  private readonly frame = new Float32Array(CAPACITY);
  private readonly cpu = new Float32Array(CAPACITY);
  private count = 0;
  private head = 0;

  record(atMs: number, frameMs: number, cpuMs: number): void {
    this.at[this.head] = atMs;
    this.frame[this.head] = frameMs;
    this.cpu[this.head] = cpuMs;
    this.head = (this.head + 1) % CAPACITY;
    this.count = Math.min(this.count + 1, CAPACITY);
  }

  /** The last `n` frame times (oldest first), for the HUD graph. */
  recentFrames(n: number, out: number[]): number[] {
    out.length = 0;
    const m = Math.min(n, this.count);
    for (let k = m; k > 0; k--) out.push(this.frame[(this.head - k + CAPACITY) % CAPACITY]!);
    return out;
  }

  /** Summary of frames recorded at or after `sinceMs` (performance.now() time base). */
  summary(sinceMs = 0): PerfSummary {
    const frames: number[] = [];
    const cpus: number[] = [];
    let first = Infinity, last = -Infinity;
    for (let k = 0; k < this.count; k++) {
      const i = (this.head - 1 - k + CAPACITY) % CAPACITY;
      const t = this.at[i]!;
      if (t < sinceMs) break;
      frames.push(this.frame[i]!);
      cpus.push(this.cpu[i]!);
      first = Math.min(first, t);
      last = Math.max(last, t);
    }
    const n = frames.length;
    const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
    const fs = [...frames].sort((a, b) => a - b);
    const cs = [...cpus].sort((a, b) => a - b);
    const seconds = n ? sum(frames) / 1000 : 0;
    return {
      frames: n,
      seconds,
      fps: seconds > 0 ? n / seconds : 0,
      avgFrameMs: n ? sum(frames) / n : 0,
      p50FrameMs: percentile(fs, 0.5),
      p95FrameMs: percentile(fs, 0.95),
      p99FrameMs: percentile(fs, 0.99),
      maxFrameMs: fs[n - 1] ?? 0,
      hitches: frames.filter((f) => f > 50).length,
      avgCpuMs: n ? sum(cpus) / n : 0,
      p95CpuMs: percentile(cs, 0.95),
      maxCpuMs: cs[n - 1] ?? 0,
    };
  }
}
