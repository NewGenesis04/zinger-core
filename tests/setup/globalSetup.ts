import fs from 'fs';
import path from 'path';

/**
 * Backlog item 12 — tests must never touch the live store.
 *
 * `tests/unit/arbEngine.test.ts` used to call `saveAllPackages([])` against the
 * real `data/` directory, which is how a package with `slug: "eth-plan-test"`
 * ended up in production package history and skewed `arbMetrics`.
 *
 * The data dir is pointed at `tmp/test-data` via `ZINGER_DATA_DIR` (see
 * `vitest.config.ts`), and wiped here so every run starts from empty. The
 * per-worker guard in `isolation.ts` asserts the override actually took.
 */
export const TEST_DATA_DIR = path.resolve(import.meta.dirname, '../../tmp/test-data');

export function setup() {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

export function teardown() {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}
