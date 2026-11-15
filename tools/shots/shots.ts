/**
 * Art-review screenshots:  npm run shots [-- --out=dir] [-- --only=view1,view2] [-- --webkit]
 *
 * Starts a dev server, opens the game with a fixed camera (?cam=...) for each view below, waits for
 * the map to finish loading, and saves PNGs (default: tools/shots/out/, gitignored). Same views every
 * time, so before/after comparisons of art changes are easy.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type Page } from '@playwright/test';
import type { GameDebugApi } from '../../src/debug/debugApi';

declare global {
  interface Window { __game?: GameDebugApi }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5191;
const args = process.argv.slice(2);
const outDir = resolve(ROOT, args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'tools/shots/out');
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const useWebkit = args.includes('--webkit');

// The art test block: Duval St from 51st (A) to 53rd (B). World coords (see places.ts).
const A = { x: 441.3, z: -807.2 };
const B = { x: 573.8, z: -1047.1 };
const len = Math.hypot(B.x - A.x, B.z - A.z);
const d = { x: (B.x - A.x) / len, z: (B.z - A.z) / len }; // along Duval, northward
const e = { x: -d.z, z: d.x }; // perpendicular, pointing east
/** Point at fraction t along the block, `side` meters east of the centerline. */
const at = (t: number, side = 0) => ({ x: A.x + d.x * len * t + e.x * side, z: A.z + d.z * len * t + e.z * side });

interface View { name: string; cam?: [number, number, number, number, number, number]; dog: { x: number; z: number; heading: number } }
const cam = (p: { x: number; z: number }, y: number, l: { x: number; z: number }, ly: number): View['cam'] =>
  [p.x, y, p.z, l.x, ly, l.z].map((v) => Math.round(v * 10) / 10) as View['cam'];
const northHeading = Math.atan2(-d.x, -d.z); // heading of "up Duval" (0 = −Z, CCW)
const dogAt = (t: number, side: number, heading = northHeading) => ({ ...at(t, side), heading });

const VIEWS: View[] = [
  { name: 'dog-follow', dog: dogAt(0.3, -7.2) }, // normal gameplay camera on the west sidewalk
  { name: 'street-north', cam: cam(at(0.04, -2), 1.7, at(0.45, 0), 2.5), dog: dogAt(0.06, -6) },
  { name: 'street-south', cam: cam(at(0.97, 2), 1.7, at(0.55, 0), 2.5), dog: dogAt(0.95, 6, northHeading + Math.PI) },
  { name: 'east-side', cam: cam(at(0.36, -7), 1.6, at(0.42, 22), 3), dog: dogAt(0.38, -6) },
  { name: 'west-side', cam: cam(at(0.66, 7), 1.6, at(0.6, -22), 3), dog: dogAt(0.64, 6) },
  { name: 'corner-52nd', cam: cam(at(0.4, 4), 2.2, at(0.5, -6), 2), dog: dogAt(0.47, 8) },
  { name: 'sign-52nd', cam: cam(at(0.49, 0.5), 2.7, at(0.517, 5.7), 3.0), dog: dogAt(0.44, -7) },
  { name: 'dog-eye', cam: cam(at(0.22, -7), 0.7, at(0.3, 10), 1.6), dog: dogAt(0.2, -7.5) },
  { name: 'aerial', cam: cam(at(-0.15, -70), 75, at(0.5, 0), 0), dog: dogAt(0.3, -7.2) },
];

async function waitForServer(url: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`dev server didn't start on ${url}`);
}

async function shoot(page: Page, v: View): Promise<void> {
  const q = new URLSearchParams({ at: `${v.dog.x.toFixed(1)},${v.dog.z.toFixed(1)},${v.dog.heading.toFixed(2)}`, ui: '0' });
  if (v.cam) q.set('cam', v.cam.join(','));
  await page.goto(`http://localhost:${PORT}/?${q}`);
  await page.waitForFunction(() => window.__game?.ready === true && window.__game.map.pendingTiles === 0, null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__game!.dog.visual === 'model', null, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1200); // camera settles, sit pose etc.
  await page.locator('#app canvas').screenshot({ path: `${outDir}/${v.name}.png` });
  console.log(`  ${v.name}.png`);
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const server: ChildProcess = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const browser = useWebkit
      ? await webkit.launch()
      : await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page.on('pageerror', (err) => console.error('  page error:', err.message));
    console.log(`[shots] -> ${outDir}`);
    for (const v of VIEWS) if (!only || only.includes(v.name)) await shoot(page, v);
    await browser.close();
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
