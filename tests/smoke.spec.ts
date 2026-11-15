import { expect, test, type Page } from '@playwright/test';

/**
 * Smoke tests on the real map: loads without console errors, tiles stream in, the dog spawns
 * outside buildings, moves, stays inside the play area at every corner, and never ends up inside
 * a building. Prints FPS / draw calls / triangles (headless numbers are only a rough signal).
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

async function hold(page: Page, keys: string[], ms: number, sample?: () => Promise<void>): Promise<void> {
  for (const k of keys) await page.keyboard.down(k);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (sample) await sample();
    await page.waitForTimeout(100);
  }
  for (const k of keys) await page.keyboard.up(k);
}

test('real map loads, dog spawns clear of buildings and moves @quick', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await gameReady(page);

  const g0 = await page.evaluate(() => ({ dog: window.__game!.dog, map: window.__game!.map, street: window.__game!.street }));
  expect(g0.map.loadedTiles).toBeGreaterThan(4);
  expect(g0.map.errors).toBe(0);
  expect(g0.dog.insideObstacle).toBe(false);
  expect(g0.dog.insideBoundary).toBe(true);
  expect(g0.street).not.toBeNull();

  await hold(page, ['KeyW'], 2000);
  const end = await page.evaluate(() => window.__game!.dog.position);
  const moved = Math.hypot(end.x - g0.dog.position.x, end.z - g0.dog.position.z);
  console.log(`[${testInfo.project.name}] moved ${moved.toFixed(2)} m; street at spawn: ${g0.street}`);
  expect(moved).toBeGreaterThan(2);

  // Rough perf sample while idle on the street.
  const f0 = await page.evaluate(() => window.__game!.frames);
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => ({
    frames: window.__game!.frames, draws: window.__game!.drawCalls, tris: window.__game!.triangles,
    tiles: window.__game!.map.loadedTiles,
  }));
  console.log(
    `[${testInfo.project.name}] avg FPS ≈ ${((s.frames - f0) / 2).toFixed(1)} (headless), ` +
    `draw calls ${s.draws}, triangles ${(s.tris / 1000).toFixed(0)}k, tiles ${s.tiles}`,
  );
  expect(errors, errors.join('\n')).toEqual([]);
});

test('rigged dog model loads with every clip; sit and play bow work @quick', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await gameReady(page);
  await page.waitForFunction(() => ['model', 'failed'].includes(window.__game!.dog.visual), null, { timeout: 20_000 });
  const dog = await page.evaluate(() => window.__game!.dog);
  expect(dog.visual).toBe('model');
  for (const clip of ['idle', 'walk', 'trot', 'run', 'sniff', 'jump', 'sit', 'playBow']) expect(dog.clips).toContain(clip);

  const state = () => page.evaluate(() => window.__game!.dog.state);
  await page.keyboard.press('KeyX');
  await expect.poll(state).toBe('sit');
  await page.keyboard.press('KeyX'); // stand up
  await expect.poll(state).toBe('idle');
  await page.keyboard.press('KeyB');
  await expect.poll(state).toBe('playBow');
  await expect.poll(state, { timeout: 5000 }).toBe('idle'); // bow ends by itself
  expect(errors, errors.join('\n')).toEqual([]);
});

test('teleport to each corner: tiles load there and the boundary holds', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await gameReady(page);

  // Top-down view makes WASD map to compass directions (W = north), so we can run "outward".
  await page.keyboard.press('KeyM');
  await page.keyboard.press('Backquote'); // open the tuning panel (teleport dropdown)
  const corners: { id: string; keys: string[] }[] = [
    { id: 'nw-corner', keys: ['KeyW', 'KeyA'] },
    { id: 'ne-corner', keys: ['KeyW', 'KeyD'] },
    { id: 'se-corner', keys: ['KeyS', 'KeyD'] },
    { id: 'sw-corner', keys: ['KeyS', 'KeyA'] },
  ];
  const places = await page.evaluate(() => window.__game!.places);

  for (const c of corners) {
    const label = places.find((p) => p.id === c.id)!.label;
    await page.getByTestId('teleport').selectOption({ label });
    await page.locator('#app canvas').focus();
    await gameReady(page);
    const at = await page.evaluate(() => ({ dog: window.__game!.dog, map: window.__game!.map, street: window.__game!.street }));
    console.log(`[${testInfo.project.name}] ${c.id}: ${at.map.loadedTiles} tiles, street ${at.street}`);
    expect(at.map.loadedTiles).toBeGreaterThan(0);
    expect(at.dog.insideObstacle).toBe(false);

    // Run outward toward the corner; the dog must stay inside the boundary and outside buildings.
    let escaped = false;
    let inBuilding = false;
    await hold(page, ['ShiftLeft', ...c.keys], 2500, async () => {
      const d = await page.evaluate(() => window.__game!.dog);
      if (!d.insideBoundary) escaped = true;
      if (d.insideObstacle) inBuilding = true;
    });
    expect(escaped, `${c.id}: dog left the play area`).toBe(false);
    expect(inBuilding, `${c.id}: dog inside a building`).toBe(false);
  }
  expect(await page.evaluate(() => window.__game!.map.errors)).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('running around town never ends up inside a building', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.goto('/?at=43rd-avenue-h');
  await gameReady(page);
  await page.keyboard.press('KeyM'); // compass-relative controls
  let inBuilding = false;
  const check = async () => {
    if ((await page.evaluate(() => window.__game!.dog.insideObstacle))) inBuilding = true;
  };
  for (const keys of [['KeyW'], ['KeyD'], ['KeyS'], ['KeyA'], ['KeyW', 'KeyD'], ['KeyS', 'KeyA']]) {
    await hold(page, ['ShiftLeft', ...keys], 2500, check);
  }
  expect(inBuilding).toBe(false);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Home Slice (hero location) builds, and the dog can cross its lot to the patio', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.goto('/?at=home-slice');
  await gameReady(page);
  const m = await page.evaluate(() => window.__game!.map);
  expect(m.errors).toBe(0);
  expect(m.landmarks).toBe(1);
  expect((await page.evaluate(() => window.__game!.dog)).insideObstacle).toBe(false);
  let stuckInside = false;
  const check = async () => {
    if ((await page.evaluate(() => window.__game!.dog.insideObstacle))) stuckInside = true;
  };
  // Toward the storefront (between the parked cars), then west along the walk to the patio.
  const p0 = (await page.evaluate(() => window.__game!.dog)).position;
  await hold(page, ['KeyW'], 1500, check);
  await page.keyboard.press('KeyM'); // compass-relative controls
  await hold(page, ['ShiftLeft', 'KeyA'], 2500, check);
  await hold(page, ['ShiftLeft', 'KeyS'], 1500, check);
  const p1 = (await page.evaluate(() => window.__game!.dog)).position;
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  console.log(`[${testInfo.project.name}] Home Slice: moved ${moved.toFixed(1)} m, ${m.dressedProps} props`);
  expect(moved).toBeGreaterThan(5);
  expect(stuckInside).toBe(false);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('art block (Duval 51st → 53rd) is dressed, renders, and the dog can run through it', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.goto('/?at=art-block');
  await gameReady(page);
  const m = await page.evaluate(() => window.__game!.map);
  expect(m.dressedBuildings).toBeGreaterThan(30);
  expect(m.dressedProps).toBeGreaterThan(150);
  expect(m.errors).toBe(0);
  expect((await page.evaluate(() => window.__game!.dog)).insideObstacle).toBe(false);

  // Up the west sidewalk (follow camera: W = forward), then zig-zag through the yards.
  let inBuilding = false;
  const check = async () => {
    if ((await page.evaluate(() => window.__game!.dog.insideObstacle))) inBuilding = true;
  };
  const p0 = (await page.evaluate(() => window.__game!.dog)).position;
  await hold(page, ['ShiftLeft', 'KeyW'], 3000, check);
  const p1 = (await page.evaluate(() => window.__game!.dog)).position;
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  await page.keyboard.press('KeyM'); // compass-relative controls
  for (const keys of [['KeyD'], ['KeyW'], ['KeyA'], ['KeyW', 'KeyD'], ['KeyS']]) {
    await hold(page, ['ShiftLeft', ...keys], 1200, check);
  }
  const s = await page.evaluate(() => ({ draws: window.__game!.drawCalls, tris: window.__game!.triangles }));
  console.log(`[${testInfo.project.name}] art block: ${m.dressedBuildings} buildings, ${m.dressedProps} props; ` +
    `sidewalk run ${moved.toFixed(1)} m; draw calls ${s.draws}, triangles ${(s.tris / 1000).toFixed(0)}k`);
  expect(moved).toBeGreaterThan(15); // the sidewalk isn't blocked by props
  expect(inBuilding).toBe(false);
  expect(errors, errors.join('\n')).toEqual([]);
});
