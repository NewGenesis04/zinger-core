import path from 'path';

// The CLOB receipt capture is deliberately loud in production so a VPS run is
// greppable in journalctl. In tests it drowns the reporter — the records are
// still written to the worker's own data dir and can be read with
// `readReceipts()`. Set before any module reads it.
process.env.ZINGER_RECEIPT_ECHO ??= '0';

/**
 * Runs in every test worker before any test file loads.
 *
 * Two jobs (backlog item 12):
 *
 * 1. **Tripwire.** If `ZINGER_DATA_DIR` did not reach this worker, fail loudly
 *    rather than quietly writing into the live store. A silent failure here is
 *    exactly the defect item 12 describes — test fixtures reached production
 *    package history and skewed `arbMetrics`.
 *
 * 2. **Per-worker isolation.** Vitest runs test files in parallel workers. A
 *    single shared data dir means several processes opening the same
 *    `zinger.db`, which fails with SQLITE_BUSY ("database is locked") as soon
 *    as more than one test file writes to the store.
 *
 * The env var must be set *before* `dataDir.ts` is imported anywhere — that
 * module resolves the directory once at import time — hence the dynamic import
 * below rather than a top-level one.
 */

const base = process.env.ZINGER_DATA_DIR;

if (!base) {
  throw new Error(
    '[test isolation] ZINGER_DATA_DIR did not reach this worker. Refusing to run ' +
      'tests against the live store (backlog item 12). It is set in vitest.config.ts.',
  );
}

const workerId =
  process.env.VITEST_WORKER_ID || process.env.VITEST_POOL_ID || String(process.pid);

process.env.ZINGER_DATA_DIR = path.join(base, `worker-${workerId}`);

const { getDataDir, dataDirIsOverridden } = await import('../../src/polymarket/dataDir.js');

if (!dataDirIsOverridden() || !getDataDir().startsWith(base)) {
  throw new Error(
    `[test isolation] data dir resolved to ${getDataDir()}, which is outside the ` +
      `test root ${base}. Refusing to run (backlog item 12).`,
  );
}
