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

// Home Slice (world coords from the OSM footprint, see tools/map/landmarks).
const HS = {
  front: { x: 584.4, z: -1005.8 }, // middle of the storefront (north face)
  patio: { x: 566.0, z: -997.0 },
  center: { x: 576, z: -992 },
  lot: { x: 597.5, z: -1030.5 }, // lot entrance off 53rd
  lotDog: { x: 588.5, z: -1018.0 },
  dogEye: { x: 590.5, z: -1022.0 },
  duvalWest: { x: 544.0, z: -1010.0 },
  patioDog: { x: 556.0, z: -1003.0 },
  cornerNW: { x: 563.0, z: -1053.0 },
  cornerLook: { x: 578.0, z: -1003.0 },
  aerial: { x: 540.0, z: -1050.0 },
  signCam: { x: 593.8, z: -1014.4 },
  signLook: { x: 588.0, z: -1003.9 },
  underCam: { x: 563.9, z: -999.4 },
  underLook: { x: 574.5, z: -1013.6 },
  underDog: { x: 566.5, z: -1004.0 },
  turfCam: { x: 553.9, z: -990.6 },
  turfLook: { x: 562.7, z: -993.2 },
  turfDog: { x: 558.5, z: -990.5 },
  southHeading: Math.PI + Math.atan2(-0.49, 0.87), // facing roughly south-south-west down Duval
};

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
  // Hero location: Home Slice Pizza, 501 E 53rd (SE corner of Duval & 53rd). Storefront faces north
  // onto its parking lot; the patio is on the west side, facing Duval.
  { name: 'hs-front', cam: cam(HS.lot, 1.7, HS.front, 3.6), dog: { ...HS.lotDog, heading: HS.southHeading } },
  { name: 'hs-patio', cam: cam(HS.duvalWest, 1.7, HS.patio, 2.4), dog: { ...HS.patioDog, heading: HS.southHeading } },
  { name: 'hs-corner', cam: cam(HS.cornerNW, 2.0, HS.cornerLook, 2.5), dog: { ...HS.patioDog, heading: HS.southHeading } },
  { name: 'hs-dog', cam: cam(HS.dogEye, 0.7, HS.front, 3.0), dog: { ...HS.lotDog, heading: HS.southHeading } },
  { name: 'hs-aerial', cam: cam(HS.aerial, 38, HS.center, 0), dog: { ...HS.lotDog, heading: HS.southHeading } },
  // Hyde Park Animal Clinic (NW corner of Duval & 51st): tall privacy fence around its yard.
  { name: 'vet-corner', cam: cam({ x: 454.0, z: -811.0 }, 1.7, { x: 425.0, z: -846.0 }, 1.6), dog: dogAt(0.06, -6) },
  { name: 'hs-sign', cam: cam(HS.signCam, 1.7, HS.signLook, 3.6), dog: { ...HS.lotDog, heading: HS.southHeading } },
  { name: 'hs-under', cam: cam(HS.underCam, 1.5, HS.underLook, 1.7), dog: { ...HS.underDog, heading: HS.southHeading } },
  { name: 'hs-turf', cam: cam(HS.turfCam, 0.8, HS.turfLook, 0.5), dog: { ...HS.turfDog, heading: HS.southHeading } },
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
    // Surface game warnings/errors (e.g. a tile that failed to build in the worker).
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  [browser ${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));
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
