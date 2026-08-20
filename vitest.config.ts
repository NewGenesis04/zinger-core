import path from 'path';
import { defineConfig } from 'vitest/config';

// Backlog item 12: tests get their own data dir, never the live store.
const TEST_DATA_DIR = path.resolve(import.meta.dirname, 'tmp/test-data');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['node_modules', 'frontend', 'ml', 'dist'],
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
    testTimeout: 15_000,
    env: { ZINGER_DATA_DIR: TEST_DATA_DIR },
    globalSetup: ['tests/setup/globalSetup.ts'],
    setupFiles: ['tests/setup/isolation.ts'],
  },
});
