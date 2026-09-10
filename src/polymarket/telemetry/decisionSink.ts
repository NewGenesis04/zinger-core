// @ts-nocheck
/**
 * Durable sink for `arb.decision` (backlog item 75).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The telemetry bus is a bounded ring and nothing else (`events.ts:423-427`).
 * The 2026-09-09/10 overnight paper run — nine hours, run specifically to
 * produce a skip-code distribution — exported `evicted: 354266` and retained
 * about ninety seconds of history. Roughly 80% of all events are
 * `gap_below_breakeven`, emitted for every market on every scan that finds
 * nothing, and that traffic pushes everything else off the back of the buffer
 * long before anyone reads it.
 *
 * Raising `EVENT_BUFFER_CAP` would buy hours, not nights, and would do it by
 * holding hundreds of thousands of uninteresting objects in the heap of a
 * live-money process. The fix is to stop treating all decisions as one stream.
 *
 * ── The split ────────────────────────────────────────────────────────────────
 *
 * Two questions are being asked of this data, and they have different shapes:
 *
 *   "Which specific books did we evaluate and refuse, and on what numbers?"
 *        → needs one row per decision, with operands. PERSISTED.
 *
 *   "How often was there simply nothing to take?"
 *        → needs a count. AGGREGATED into hourly buckets.
 *
 * So codes that describe *a book we looked at and turned down on money or
 * microstructure* are written as rows. Codes that describe *our own standing
 * state* — no edge in the market, budget floor not cleared, slot already
 * occupied — are counted. Nothing is discarded silently: the counts are the
 * denominator, and without them a row count is a numerator with no rate.
 *
 * ── Whitelist, not blacklist ─────────────────────────────────────────────────
 *
 * This is deliberate and load-bearing. Raising `minArbGap` (item 77) moves the
 * noise floor from `gap_below_breakeven` to `gap_below_operator_floor` — the
 * same volume under a different code. A blacklist naming `gap_below_breakeven`
 * would keep working for a week and then quietly start writing ~350k rows a
 * night. A whitelist degrades the other way: a new code is counted, not
 * persisted, until someone adds it here. That is the safe direction of failure
 * for something attached to a live-money process.
 *
 * `depth_unknown` is on the persist list regardless of what its volume turns
 * out to be. It is the regression canary for item 70 — if the per-level WS book
 * maps ever go back to publishing no ask, that code is the only signal, and the
 * whole point of item 70 was that the previous failure was invisible.
 */
import { onEvent } from './events.js';
import { getDb } from '../sqliteStore.js';

/**
 * One row per occurrence. Every one of these means "there was a real book in
 * front of us and something we control refused it" — the actionable set.
 */
export const PERSISTED_CODES = new Set([
  'depth_unknown',
  'depth_below_min_size',
  'budget_below_min_notional',
  'leg_below_min_notional',
  'insufficient_live_cash',
  'insufficient_paper_cash',
]);

/**
 * Counted, not stored. These fire at scan-loop rate and describe standing
 * state, not a decision about a particular book; an hourly count answers every
 * question anyone has asked of them.
 */
export const COUNTED_CODES = new Set([
  'gap_below_breakeven',
  'gap_below_operator_floor',
  'package_capacity_full',
  'package_already_on_slug',
]);

/**
 * Per-(code, slug) throttle for persisted skips, in ms.
 *
 * A flat whitelist is still unbounded: an account that cannot fund a trade
 * emits `insufficient_live_cash` on every qualifying book on every scan, and
 * the tenth thousand copy of that row carries no information the first did not.
 * One row per code per slug per window keeps the *shape* of the signal — you
 * can still see it started, on which markets, and when it stopped — at bounded
 * cost. Suppressed duplicates are counted, so the rate is still recoverable.
 *
 * Default matches the 5-minute market window rotation, so each window
 * contributes at most one row per code per slug.
 */
const THROTTLE_MS = Number(process.env.ARB_SINK_THROTTLE_MS) || 300_000;

/** Rows older than this are pruned at startup. A sink that never forgets is a leak. */
const RETENTION_DAYS = Number(process.env.ARB_SINK_RETENTION_DAYS) || 90;

let started = false;
let unsubscribe: (() => void) | null = null;
let writeErrors = 0;
let lastWriteError: string | null = null;

/** `code|slug` → last persisted timestamp. Bounded by markets × persisted codes. */
const lastPersisted = new Map<string, number>();

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS arb_decisions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      ts             INTEGER NOT NULL,
      event_id       TEXT,
      mode           TEXT,
      symbol         TEXT,
      slug           TEXT,
      action         TEXT NOT NULL,
      skip_code      TEXT,
      up_ask         REAL,
      down_ask       REAL,
      asks_sum       REAL,
      arb_gap        REAL,
      min_arb_gap    REAL,
      break_even_gap REAL,
      required_gap   REAL,
      shares         REAL,
      capital_usd    REAL,
      resting_shares REAL,
      depth_shares   REAL,
      package_id     TEXT,
      payload        TEXT NOT NULL
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_arb_decisions_ts ON arb_decisions(ts);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_arb_decisions_code ON arb_decisions(skip_code, ts);');

  // The denominator. `n` counts every occurrence in the bucket, including the
  // throttled duplicates of codes that DID get a row, so
  // `rows + suppressed` reconstructs the true event count.
  db.exec(`
    CREATE TABLE IF NOT EXISTS arb_decision_counts (
      bucket_ts INTEGER NOT NULL,
      skip_code TEXT NOT NULL,
      mode      TEXT NOT NULL,
      n         INTEGER NOT NULL,
      PRIMARY KEY (bucket_ts, skip_code, mode)
    );
  `);
}

/** Hour bucket. Fine enough to see a problem start, coarse enough to stay small. */
function hourBucket(ts: number): number {
  return Math.floor(ts / 3_600_000) * 3_600_000;
}

function num(v: unknown): number | null {
  const n = Number(v);
  // `Infinity` reaches here whenever depth is unknown (`arbEngine.ts:256-257`).
  // SQLite would store it as a float that reads back as `Inf`; null is honest.
  return Number.isFinite(n) ? n : null;
}

/**
 * Prepared statements, compiled once.
 *
 * This runs on the arb scan path at roughly 11 events/s sustained, and the
 * counted codes are the majority of them — re-compiling the same two SQL
 * strings per event is pure overhead in a live-money process that has hot-path
 * budgets (`tests/perf`). Cleared on start/stop so a schema change (or a test
 * dropping the table) cannot leave a stale handle behind.
 */
let stmts: { count: any; insert: any } | null = null;

function getStmts(db) {
  if (stmts) return stmts;
  stmts = {
    count: db.prepare(`
      INSERT INTO arb_decision_counts (bucket_ts, skip_code, mode, n)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(bucket_ts, skip_code, mode) DO UPDATE SET n = n + 1
    `),
    insert: db.prepare(`
      INSERT INTO arb_decisions (
        ts, event_id, mode, symbol, slug, action, skip_code,
        up_ask, down_ask, asks_sum, arb_gap, min_arb_gap,
        break_even_gap, required_gap,
        shares, capital_usd, resting_shares, depth_shares,
        package_id, payload
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `),
  };
  return stmts;
}

function bumpCount(db, ts: number, code: string, mode: string): void {
  getStmts(db).count.run(hourBucket(ts), code, mode);
}

function insertRow(db, event, d, action: string, code: string | null): void {
  const sizing = d?.sizing || {};
  getStmts(db).insert.run(
    event.ts, event.id ?? null,
    d?.mode ?? null, d?.symbol ?? null, d?.slug ?? null,
    action, code,
    num(d?.upAsk), num(d?.downAsk), num(d?.asksSum), num(d?.arbGap), num(d?.minArbGap),
    num(d?.breakEvenGap), num(d?.requiredGap),
    num(sizing.shares), num(sizing.capitalUsd),
    num(sizing.restingShares), num(sizing.depthShares),
    d?.packageId ?? null,
    // The full payload is kept verbatim alongside the extracted columns. The
    // columns are for querying; this is so a question nobody thought to ask in
    // 2026 is still answerable from rows written today.
    JSON.stringify(d ?? {}),
  );
}

/**
 * Route one `arb.decision`. Never throws: the bus isolates subscriber faults
 * (`events.ts:393-408`) but the emit site is the arb scan path, and a sink is
 * not a reason for a trading decision to take a different code path.
 */
function handle(event): void {
  const db = getDb();
  if (!db) return; // JSON fallback backend — no sink, by design.

  try {
    const d = (event?.data || {}) as Record<string, any>;
    const action = d?.output?.action ?? 'unknown';
    const code = d?.output?.skipReason?.code ?? null;
    const mode = String(d?.mode ?? 'unknown');

    // An opened package is never throttled and never merely counted. This is
    // the record of real money committed; if it is ever incomplete the ledger
    // cannot be reconciled against it.
    if (action === 'open') {
      insertRow(db, event, d, 'open', null);
      return;
    }

    if (!code) return;

    if (COUNTED_CODES.has(code)) {
      bumpCount(db, event.ts, code, mode);
      return;
    }

    if (!PERSISTED_CODES.has(code)) {
      // Unknown code — a gate added after this file was written. Counted, so it
      // shows up as a mystery in the totals rather than vanishing.
      bumpCount(db, event.ts, code, mode);
      return;
    }

    // Counted first, unconditionally: `rows + counts` must reconstruct the true
    // event total whether or not this particular occurrence earns a row.
    bumpCount(db, event.ts, code, mode);

    const key = `${code}|${d?.slug ?? ''}`;
    const last = lastPersisted.get(key) ?? 0;
    if (event.ts - last < THROTTLE_MS) return;
    lastPersisted.set(key, event.ts);

    insertRow(db, event, d, action, code);
  } catch (err) {
    writeErrors += 1;
    lastWriteError = (err as Error)?.message || String(err);
    if (writeErrors === 1 || writeErrors % 100 === 0) {
      console.error(`[arb-sink] write failed (${writeErrors} total): ${lastWriteError}`);
    }
  }
}

function prune(db): number {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const rows = db.prepare('DELETE FROM arb_decisions WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM arb_decision_counts WHERE bucket_ts < ?').run(cutoff);
  return rows?.changes ?? 0;
}

/** Idempotent. Safe to call when sqlite is unavailable — returns false. */
export function startArbDecisionSink(): boolean {
  if (started) return true;
  const db = getDb();
  if (!db) {
    console.log('[arb-sink] sqlite unavailable — arb decisions stay in-memory only');
    return false;
  }
  stmts = null;
  try {
    ensureSchema(db);
    const pruned = prune(db);
    if (pruned > 0) console.log(`[arb-sink] pruned ${pruned} decisions older than ${RETENTION_DAYS}d`);
  } catch (err) {
    console.error(`[arb-sink] schema init failed, sink disabled: ${(err as Error)?.message}`);
    return false;
  }
  unsubscribe = onEvent('arb.decision', handle);
  started = true;
  return true;
}

export function stopArbDecisionSink(): void {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  started = false;
  stmts = null;
  lastPersisted.clear();
}

export function arbSinkStatus(): {
  started: boolean; writeErrors: number; lastWriteError: string | null;
  rows: number | null; counts: number | null;
} {
  const db = getDb();
  let rows: number | null = null;
  let counts: number | null = null;
  try {
    if (db && started) {
      rows = db.prepare('SELECT COUNT(*) AS n FROM arb_decisions').get()?.n ?? null;
      counts = db.prepare('SELECT COALESCE(SUM(n),0) AS n FROM arb_decision_counts').get()?.n ?? null;
    }
  } catch { /* status must never throw */ }
  return { started, writeErrors, lastWriteError, rows, counts };
}

/** Test seam: the throttle is stateful across calls. */
export function __resetArbSinkThrottle(): void {
  lastPersisted.clear();
  writeErrors = 0;
  lastWriteError = null;
}
