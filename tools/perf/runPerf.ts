/**
 * Performance benchmark:  npm run perf  [-- --no-build] [-- --only=chromium-gpu]
 *
 * Builds the production bundle, serves it with `vite preview`, and drives the game through fixed
 * scenarios in several browser setups, then checks the results against perf/budget.json.
 *   chromium-gpu      Chrome on the real GPU (Metal), 1440x900 @2x (Retina)
 *   webkit            Safari's engine, 1440x900 @2x
 *   chromium-lowend   Chrome on the GPU with the CPU throttled 4x: a rough stand-in for older Macs
 *
 * Writes perf/reports/latest.json (full numbers) and appends a summary row to perf/history.csv.
 * Exit code 1 if any budget is exceeded.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type Browser, type Page } from '@playwright/test';
import type { GameDebugApi } from '../../src/debug/debugApi';
import type { PerfSummary } from '../../src/debug/PerfMonitor';

declare global {
  interface Window { __game?: GameDebugApi }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5190;
const URL_BASE = `http://localhost:${PORT}/`;
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);

type Metrics = Record<string, number>;
type Budget = Record<string, Record<string, Metrics>>;

interface Setup {
  name: string;
  launch: () => Promise<Browser>;
  cpuThrottle?: number;
}

const GPU_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const SETUPS: Setup[] = [
  { name: 'chromium-gpu', launch: () => chromium.launch({ args: GPU_ARGS }) },
  { name: 'webkit', launch: () => webkit.launch() },
  { name: 'chromium-lowend', launch: () => chromium.launch({ args: GPU_ARGS }), cpuThrottle: 4 },
];

// --- helpers ----------------------------------------------------------------------------------
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitReady(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(() => window.__game?.ready === true && window.__game.map.pendingTiles === 0, null, { timeout });
}

/** Run `action` while sampling draw calls / triangles / heap every 250 ms; return frame summary + peaks. */
async function measure(page: Page, action: () => Promise<void>): Promise<Metrics> {
  const since = await page.evaluate(() => window.__game!.perf.now());
  const peaks = { drawCalls: 0, triangles: 0, heapMB: 0 };
  let running = true;
  const sampler = (async () => {
    while (running && !page.isClosed()) {
      const s = await page.evaluate(() => ({
        d: window.__game!.drawCalls, t: window.__game!.triangles, h: window.__game!.perf.memory.heapMB ?? 0,
      }));
      peaks.drawCalls = Math.max(peaks.drawCalls, s.d);
      peaks.triangles = Math.max(peaks.triangles, s.t);
      peaks.heapMB = Math.max(peaks.heapMB, s.h);
      await sleep(250);
    }
  })();
  try {
    await action();
  } finally {
    running = false;
    await sampler.catch(() => {});
  }
  const sum: PerfSummary = await page.evaluate((t) => window.__game!.perf.summary(t), since);
  return {
    fps: round(sum.fps), avgFrameMs: round(sum.avgFrameMs), p95FrameMs: round(sum.p95FrameMs),
    p99FrameMs: round(sum.p99FrameMs), maxFrameMs: round(sum.maxFrameMs), hitches: sum.hitches,
    avgCpuMs: round(sum.avgCpuMs), p95CpuMs: round(sum.p95CpuMs), maxCpuMs: round(sum.maxCpuMs),
    maxDrawCalls: peaks.drawCalls, maxTriangles: peaks.triangles, ...(peaks.heapMB ? { maxHeapMB: round(peaks.heapMB) } : {}),
  };
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
};

async function hold(page: Page, keys: string[], ms: number): Promise<void> {
  for (const k of keys) await page.keyboard.down(k);
  await sleep(ms);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
}

/**
 * Resource counts read from a zoomed-out top-down view with every loaded tile on screen. three.js only
 * counts a geometry/texture once it has been drawn, so both leak readings must see the same "everything".
 */
async function memoryWithEverythingDrawn(page: Page) {
  await page.keyboard.press('KeyM');
  for (let k = 0; k < 25; k++) await page.mouse.wheel(0, 100); // zoom out to the max height
  await sleep(800);
  const mem = await page.evaluate(() => window.__game!.perf.memory);
  await page.keyboard.press('KeyM');
  await sleep(300);
  return mem;
}

async function teleport(page: Page, id: string): Promise<number> {
  const label = await page.evaluate((pid) => window.__game!.places.find((p) => p.id === pid)!.label, id);
  const t0 = Date.now();
  await page.getByTestId('teleport').selectOption({ label });
  await page.locator('#app canvas').focus();
  await waitReady(page);
  return Date.now() - t0;
}

// --- scenarios --------------------------------------------------------------------------------
async function runSetup(browser: Browser, setup: Setup): Promise<Record<string, Metrics>> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (setup.cpuThrottle) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: setup.cpuThrottle });
  }
  const out: Record<string, Metrics> = {};

  // load: navigation -> map ready around the spawn
  const t0 = Date.now();
  await page.goto(URL_BASE);
  await waitReady(page, 90_000);
  out.load = { readyMs: Date.now() - t0 };
  await page.keyboard.press('KeyT'); // hide debug zones: measure the game, not the debug view
  await sleep(1500);
  const baseline = await memoryWithEverythingDrawn(page);

  out.idle = await measure(page, () => sleep(4000));

  // run: tiles stream in while the dog sprints (tilesLoaded / distanceM prove it actually happened)
  const loadsBefore = await page.evaluate(() => window.__game!.perf.tiles.finalize.length);
  const posBefore = await page.evaluate(() => window.__game!.dog.position);
  out.run = await measure(page, async () => {
    // 20 s sprint north up Duval St from 45th (the spawn faces up Duval): ~300 m on an open street,
    // crossing tile boundaries so new tiles stream in while running.
    await hold(page, ['ShiftLeft', 'KeyW'], 20000);
  });

  out.run.tilesLoaded = (await page.evaluate(() => window.__game!.perf.tiles.finalize.length)) - loadsBefore;
  const posAfter = await page.evaluate(() => window.__game!.dog.position);
  out.run.distanceM = round(Math.hypot(posAfter.x - posBefore.x, posAfter.z - posBefore.z), 0);

  // block: the fully dressed art block (Duval 51st -> 53rd): densest geometry + shadows, sprint through it
  await page.keyboard.press('Backquote');
  await teleport(page, 'art-block');
  await sleep(1500);
  const blockStart = await page.evaluate(() => window.__game!.dog.position);
  out.block = await measure(page, () => hold(page, ['ShiftLeft', 'KeyW'], 12000));
  const blockEnd = await page.evaluate(() => window.__game!.dog.position);
  out.block.distanceM = round(Math.hypot(blockEnd.x - blockStart.x, blockEnd.z - blockStart.z), 0);

  // teleports: whole areas load at once (worst case for stutters)
  const readyTimes: number[] = [];
  out.teleport = await measure(page, async () => {
    for (const id of ['nw-corner', 'ne-corner', 'se-corner', 'sw-corner', '51st-duval', 'origin']) {
      readyTimes.push(await teleport(page, id));
      await sleep(800);
    }
  });
  out.teleport.maxReadyMs = Math.max(...readyTimes);
  out.teleport.avgReadyMs = round(readyTimes.reduce((a, b) => a + b, 0) / readyTimes.length, 0);
  await page.keyboard.press('Backquote');

  // top-down from 400 m: the most geometry on screen at once
  await page.keyboard.press('KeyM');
  for (let k = 0; k < 25; k++) await page.mouse.wheel(0, -100); // min height
  for (let k = 0; k < 12; k++) await page.mouse.wheel(0, 100); // then a fixed number of steps out (~400 m)
  out.topDown = await measure(page, () => sleep(4000));
  await page.keyboard.press('KeyM');

  // tiles + leaks: back at the origin, resources should match the first visit
  await sleep(1500);
  const after = await memoryWithEverythingDrawn(page);
  const tiles = await page.evaluate(() => window.__game!.perf.tiles);
  out.tiles = {
    buildP95Ms: round(pct(tiles.build, 0.95)), finalizeP95Ms: round(pct(tiles.finalize, 0.95)),
    finalizeMaxMs: round(Math.max(0, ...tiles.finalize)),
  };
  // Leaks: resources not owned by currently-loaded tiles must be unchanged after all the loading/unloading.
  out.leaks = {
    geometriesDelta: after.nonMapGeometries - baseline.nonMapGeometries,
    texturesDelta: after.nonMapTextures - baseline.nonMapTextures,
    obstaclesDelta: after.nonMapObstacles - baseline.nonMapObstacles,
  };
  out.errors = { count: errors.length };
  if (errors.length) console.log(`  [${setup.name}] page errors:\n    ${errors.slice(0, 5).join('\n    ')}`);
  await page.close();
  return out;
}

// --- budget check + report --------------------------------------------------------------------
function check(results: Record<string, Record<string, Metrics>>, budget: Budget): string[] {
  const failures: string[] = [];
  for (const [setup, scenarios] of Object.entries(results)) {
    for (const [scenario, metrics] of Object.entries(scenarios)) {
      const limits = { ...budget['*']?.[scenario], ...budget[setup]?.[scenario] };
      for (const [metric, max] of Object.entries(limits)) {
        const v = metrics[metric];
        if (v !== undefined && v > max) failures.push(`${setup} / ${scenario} / ${metric}: ${v} > budget ${max}`);
      }
    }
  }
  return failures;
}

function printTable(results: Record<string, Record<string, Metrics>>): void {
  for (const [setup, scenarios] of Object.entries(results)) {
    console.log(`\n${setup}`);
    for (const [scenario, m] of Object.entries(scenarios)) {
      console.log(`  ${scenario.padEnd(9)} ${Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    }
  }
}

function startPreview(): Promise<ChildProcess> {
  return new Promise((resolveP, reject) => {
    const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'pipe' });
    const timer = setTimeout(() => reject(new Error('vite preview did not start')), 30_000);
    proc.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes(String(PORT))) {
        clearTimeout(timer);
        resolveP(proc);
      }
    });
    proc.on('exit', (code) => reject(new Error(`vite preview exited (${code})`)));
  });
}

async function main(): Promise<void> {
  if (!args.includes('--no-build')) {
    console.log('[perf] building production bundle ...');
    execSync('npx vite build', { cwd: ROOT, stdio: 'ignore' });
  }
  const server = await startPreview();
  const results: Record<string, Record<string, Metrics>> = {};
  try {
    for (const setup of SETUPS) {
      if (only && setup.name !== only) continue;
      console.log(`[perf] ${setup.name} ...`);
      const browser = await setup.launch();
      try {
        results[setup.name] = await runSetup(browser, setup);
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.kill();
  }

  printTable(results);
  const budget = JSON.parse(readFileSync(resolve(ROOT, 'perf/budget.json'), 'utf8')) as Budget;
  const failures = check(results, budget);
  const commit = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { return '?'; } })();
  const report = { date: new Date().toISOString(), commit, results, failures };
  const prevFile = resolve(ROOT, 'perf/reports/latest.json');
  if (existsSync(prevFile)) {
    // Not a failure: flag metrics that got >30% worse than the previous run so creep is noticed early.
    const prev = JSON.parse(readFileSync(prevFile, 'utf8')) as typeof report;
    const warnings: string[] = [];
    for (const [setup, scenarios] of Object.entries(results)) {
      for (const scenario of ['run', 'block', 'topDown', 'teleport']) {
        for (const metric of ['p95CpuMs', 'avgCpuMs', 'maxDrawCalls', 'maxTriangles', 'maxHeapMB', 'maxReadyMs']) {
          const now = scenarios[scenario]?.[metric];
          const was = prev.results[setup]?.[scenario]?.[metric];
          if (now !== undefined && was !== undefined && was > 0.5 && now > was * 1.3) {
            warnings.push(`${setup} / ${scenario} / ${metric}: ${was} -> ${now}`);
          }
        }
      }
    }
    if (warnings.length) console.log(`\n[perf] worse than the previous run (${prev.commit}):\n  ${warnings.join('\n  ')}`);
  }
  mkdirSync(resolve(ROOT, 'perf/reports'), { recursive: true });
  writeFileSync(resolve(ROOT, 'perf/reports/latest.json'), JSON.stringify(report, null, 2));
  const hist = resolve(ROOT, 'perf/history.csv');
  if (!existsSync(hist)) appendFileSync(hist, 'date,commit,setup,run_p95FrameMs,run_p95CpuMs,run_hitches,teleport_hitches,teleport_maxReadyMs,topDown_p95FrameMs,maxDrawCalls,maxTriangles,failures\n');
  for (const [setup, r] of Object.entries(results)) {
    const draws = Math.max(...['idle', 'run', 'block', 'topDown'].map((s) => r[s]?.maxDrawCalls ?? 0));
    const tris = Math.max(...['idle', 'run', 'block', 'topDown'].map((s) => r[s]?.maxTriangles ?? 0));
    appendFileSync(hist, [report.date, commit, setup, r.run?.p95FrameMs, r.run?.p95CpuMs, r.run?.hitches, r.teleport?.hitches,
      r.teleport?.maxReadyMs, r.topDown?.p95FrameMs, draws, tris, failures.filter((f) => f.startsWith(setup)).length].join(',') + '\n');
  }
  if (failures.length) {
    console.log(`\n[perf] OVER BUDGET (${failures.length}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\n[perf] all budgets met. Report: perf/reports/latest.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
