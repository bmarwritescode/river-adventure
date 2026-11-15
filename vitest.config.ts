import { defineConfig } from 'vitest/config';

// Unit tests live next to the code as *.test.ts; Playwright smoke tests live in tests/.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
