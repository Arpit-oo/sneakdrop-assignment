import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false, // all test files share one Postgres test database
    testTimeout: 30_000,
  },
});
