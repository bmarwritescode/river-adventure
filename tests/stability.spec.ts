import { expect, test, type Page } from '@playwright/test';

/**
 * Stability tests: things that go wrong in real browsers but not in a happy-path run.
 * The long random-wander soak is tagged @soak and only runs with `npm run test:soak`.
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`uncaught: ${err.message}`));
  return errors;
}

async function gameReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__game?.ready === true && window.__game.map.pendingTiles === 0, null, {
    timeout: 30_000,
  });
}

const dog = (page: Page) => page.evaluate(() => window.__game!.dog);

test('a 2-second main-thread stall while running into a wall: no tunnelling, no teleport', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?at=43rd-avenue-h');
  await gameReady(page);
  await page.keyboard.press('KeyM'); // compass controls: W = north
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500); // up to speed / against something
  const before = await dog(page);
  // Freeze the page (like a GC pause, debugger, or a background tab waking up).
  await page.evaluate(() => {
    const end = performance.now() + 2000;
    while (performance.now() < end) { /* busy */ }
  });
  await page.waitForTimeout(300);
  const after = await dog(page);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  // The loop clamps a frame to 0.25 s, so at most ~0.25 s of movement (+ the 300 ms wait) may happen.
  const moved = Math.hypot(after.position.x - before.position.x, after.position.z - before.position.z);
  expect(moved).toBeLessThan(16 * (0.25 + 0.35) + 1);
  expect(after.insideObstacle).toBe(false);
  expect(after.insideBoundary).toBe(true);
  expect(Number.isFinite(after.position.x) && Number.isFinite(after.position.z)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('losing window focus with a key held stops the dog (no stuck keys)', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await gameReady(page);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(800);
  expect((await dog(page)).speed).toBeGreaterThan(1);
  // Simulate the window losing focus (e.g. Cmd-Tab) while W is still physically down.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(1500);
  expect((await dog(page)).speed).toBeLessThan(0.3);
  await page.keyboard.up('KeyW');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('hidden tab -> visible again: the game keeps running', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await gameReady(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const f0 = await page.evaluate(() => window.__game!.frames);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__game!.frames)).toBeGreaterThan(f0 + 5);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(800);
  await page.keyboard.up('KeyW');
  expect((await dog(page)).speed).toBeGreaterThan(0.5);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('rapid window resizing keeps the canvas matched to the window', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await gameReady(page);
  for (const [w, h] of [[800, 600], [1600, 900], [500, 900], [1280, 720], [1000, 400]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    const size = await page.evaluate(() => {
      const c = document.querySelector('#app canvas') as HTMLCanvasElement;
      return { cw: c.clientWidth, ch: c.clientHeight };
    });
    expect(size).toEqual({ cw: w, ch: h });
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('WebGL context lost and restored: rendering recovers', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await gameReady(page);
  const lost = await page.evaluate(() => {
    const c = document.querySelector('#app canvas') as HTMLCanvasElement;
    const gl = c.getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    (window as unknown as { __loseExt: WEBGL_lose_context }).__loseExt = ext;
    ext.loseContext();
    return true;
  });
  test.skip(!lost, 'WEBGL_lose_context not available in this browser');
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as unknown as { __loseExt: WEBGL_lose_context }).__loseExt.restoreContext());
  await page.waitForTimeout(1500);

  // Frames keep coming, the map is still there, and the picture isn't blank.
  const f0 = await page.evaluate(() => window.__game!.frames);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__game!.frames)).toBeGreaterThan(f0);
  expect(await page.evaluate(() => window.__game!.triangles)).toBeGreaterThan(10_000);
  const shot = await page.locator('#app canvas').screenshot();
  expect(shot.length).toBeGreaterThan(30_000); // a blank/solid frame compresses to a few KB
  // Browsers log their own context-loss warnings; only our errors matter.
  const ours = errors.filter((e) => !/context lost|CONTEXT_LOST|lose_context/i.test(e));
  expect(ours, ours.join('\n')).toEqual([]);
});

/** Seeded random wander: run, turn, jump, sit, bow, sniff; check invariants several times a second. */
test('soak: random wander keeps every invariant @soak', async ({ page }, testInfo) => {
  const seconds = Number(process.env.SOAK_SECONDS ?? 120);
  test.setTimeout((seconds + 60) * 1000);
  let seed = Number(process.env.SOAK_SEED ?? Date.now() % 100000);
  console.log(`[${testInfo.project.name}] soak ${seconds}s, seed ${seed} (repeat with SOAK_SEED=${seed})`);
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  const errors = collectErrors(page);
  // SOAK_AT=<place id> starts somewhere else (e.g. art-block: dense props and porches).
  await page.goto(process.env.SOAK_AT ? `/?at=${process.env.SOAK_AT}` : '/');
  await gameReady(page);
  await page.keyboard.press('KeyM'); // compass controls so random directions mean something

  const problems: string[] = [];
  let lastFrames = 0;
  let lastProgress = Date.now();
  let checks = 0;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const r = rand();
    if (r < 0.06) await page.keyboard.press('Space');
    else if (r < 0.1) await page.keyboard.press('KeyX');
    else if (r < 0.13) await page.keyboard.press('KeyB');
    else {
      const dirs = [['KeyW'], ['KeyS'], ['KeyA'], ['KeyD'], ['KeyW', 'KeyD'], ['KeyW', 'KeyA'], ['KeyS', 'KeyD'], ['KeyS', 'KeyA']];
      const keys = [...dirs[Math.floor(rand() * dirs.length)]!];
      if (rand() < 0.6) keys.push('ShiftLeft');
      if (rand() < 0.1) keys.push('KeyE');
      for (const k of keys) await page.keyboard.down(k);
      for (let t = 0; t < 4 + Math.floor(rand() * 12); t++) {
        await page.waitForTimeout(150);
        const s = await page.evaluate(() => ({ dog: window.__game!.dog, frames: window.__game!.frames, map: window.__game!.map }));
        checks++;
        const p = s.dog.position;
        if (![p.x, p.y, p.z].every(Number.isFinite)) problems.push(`non-finite position ${JSON.stringify(p)}`);
        if (!s.dog.insideBoundary) problems.push(`outside boundary at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
        if (s.dog.insideObstacle) problems.push(`inside a building at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
        if (s.frames > lastFrames) lastProgress = Date.now();
        else if (Date.now() - lastProgress > 2000) problems.push('no new frame for 2 s (frozen)');
        if (s.map.errors) problems.push(`map errors: ${s.map.errors}`);
        lastFrames = s.frames;
      }
      for (const k of keys.reverse()) await page.keyboard.up(k);
    }
    if (problems.length) break;
  }
  const mem = await page.evaluate(() => window.__game!.perf.memory);
  console.log(`[${testInfo.project.name}] soak done: ${checks} checks, problems ${problems.length}, ` +
    `geometries ${mem.geometries}, textures ${mem.textures}, heap ${mem.heapMB?.toFixed(0) ?? 'n/a'} MB`);
  expect(problems.slice(0, 5), problems.join('\n')).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
});
