import { defineConfig, devices } from '@playwright/test';

const PORT = 5179; // separate from `npm run dev` (5173) so tests can run while you play

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // one GPU-heavy page at a time keeps FPS numbers meaningful
  reporter: [['list']],
  // The long random-wander soak only runs via `npm run test:soak` (SOAK=1).
  grepInvert: process.env.SOAK ? undefined : /@soak/,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } },
    // WebKit = Safari's engine: catches Safari-only breakage early.
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 720 } } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
