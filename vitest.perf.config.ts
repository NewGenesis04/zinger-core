import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Perf suite: throughput budgets for pure hot-path helpers.
 * Thresholds are generous for shared GH runners but still catch major regressions.
 */

// Backlog item 12: tests get their own data dir, never the live store.
const TEST_DATA_DIR = path.resolve(import.meta.dirname, 'tmp/test-data');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/perf/**/*.perf.test.ts'],
    exclude: ['node_modules', 'frontend', 'ml', 'dist'],
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
    testTimeout: 60_000,
    // Avoid parallel contention skewing timings on small runners
    fileParallelism: false,
    maxConcurrency: 1,
    env: { ZINGER_DATA_DIR: TEST_DATA_DIR },
    globalSetup: ['tests/setup/globalSetup.ts'],
    setupFiles: ['tests/setup/isolation.ts'],
  },
});
