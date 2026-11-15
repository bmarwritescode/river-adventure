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

test('real map loads, dog spawns clear of buildings and moves', async ({ page }, testInfo) => {
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
    await page.locator('canvas').focus();
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
