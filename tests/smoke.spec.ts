import { expect, test, type Page } from '@playwright/test';

/**
 * Smoke test: the game loads without console errors, the dog moves when
 * "forward" is held, a trigger zone fires, and jumping works.
 * Also prints average FPS (headless numbers are only a rough signal).
 */

async function gameReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__game?.ready === true && window.__game.frames > 10, null, { timeout: 20_000 });
}

test('game loads, dog moves, zones fire, no errors', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`uncaught: ${err.message}`));

  await page.goto('/');
  await gameReady(page);

  const start = await page.evaluate(() => window.__game!.dog.position);
  expect(await page.evaluate(() => window.__game!.dog.state)).toBe('idle');

  // Hold forward for 2 s (default pace = trot). Zone A sits just ahead of spawn.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  const moving = await page.evaluate(() => window.__game!.dog.state);
  await page.keyboard.up('KeyW');

  const end = await page.evaluate(() => window.__game!.dog.position);
  const moved = Math.hypot(end.x - start.x, end.z - start.z);
  console.log(`[${testInfo.project.name}] moved ${moved.toFixed(2)} m, state while moving: ${moving}`);
  expect(moved).toBeGreaterThan(2);
  expect(end.z).toBeLessThan(start.z); // forward from spawn = north = -Z
  expect(['walk', 'trot', 'run']).toContain(moving);

  const triggers = await page.evaluate(() => window.__game!.triggers);
  expect(triggers.enterCount).toBeGreaterThanOrEqual(1);

  // Jump: the dog should leave the ground and come back.
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__game!.dog.state === 'jump', null, { timeout: 2000 });
  await page.waitForFunction(() => window.__game!.dog.state !== 'jump', null, { timeout: 3000 });

  // Rough FPS sample.
  const f0 = await page.evaluate(() => window.__game!.frames);
  await page.waitForTimeout(2000);
  const f1 = await page.evaluate(() => window.__game!.frames);
  const draws = await page.evaluate(() => window.__game!.drawCalls);
  console.log(`[${testInfo.project.name}] avg FPS ≈ ${((f1 - f0) / 2).toFixed(1)} (headless), draw calls: ${draws}`);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('collision: running north stops at the fence', async ({ page }) => {
  await page.goto('/');
  await gameReady(page);
  // The fence's south face is at z = -15.94; the dog's collision radius is 0.28.
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  const z = await page.evaluate(() => window.__game!.dog.position.z);
  expect(z).toBeLessThan(-14); // actually reached the fence
  expect(z).toBeGreaterThan(-15.94); // ...but didn't pass through it
});
