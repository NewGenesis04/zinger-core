// @ts-nocheck
/**
 * INVARIANT: every arb decision that commits money is recoverable from disk,
 * and every decision that does not is still countable (item 75).
 *
 * The failure this replaces: the 2026-09-09/10 overnight run existed to produce
 * a skip-code distribution and produced ninety seconds of one. The bus is a
 * bounded ring (`events.ts:423-427`); it reported `evicted: 354266`.
 *
 * The properties here are stated as a conservation law —
 *
 *     rows + suppressed counts == events emitted
 *
 * — rather than as "these codes are written and those are not". A whitelist is
 * a policy and policies get edited; the conservation law is what makes an
 * edited policy still honest, because it forbids the one outcome that matters:
 * an event that reaches the sink and leaves no trace of any kind.
 *
 * `ARB_SINK_THROTTLE_MS` is set before the module loads because the module
 * resolves it once at import time, hence the dynamic imports below.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

process.env.ARB_SINK_THROTTLE_MS = '60000';

const THROTTLE_MS = 60_000;

const { emitEvent } = await import('../../src/polymarket/telemetry/events.js');
const { getDb } = await import('../../src/polymarket/sqliteStore.js');
const {
  startArbDecisionSink,
  stopArbDecisionSink,
  __resetArbSinkThrottle,
  arbSinkStatus,
  PERSISTED_CODES,
  COUNTED_CODES,
} = await import('../../src/polymarket/telemetry/decisionSink.js');

let db;

const rowCount = () => db.prepare('SELECT COUNT(*) AS n FROM arb_decisions').get().n;
const countTotal = () => db.prepare('SELECT COALESCE(SUM(n),0) AS n FROM arb_decision_counts').get().n;
const rowsFor = (code) =>
  db.prepare('SELECT * FROM arb_decisions WHERE skip_code IS ?').all(code);
const countFor = (code) =>
  db.prepare('SELECT COALESCE(SUM(n),0) AS n FROM arb_decision_counts WHERE skip_code = ?').get(code).n;

/** Mirrors the shape `arbEngine.ts:90-106` emits. */
function decide({ action = 'skip', code = null, slug = 'btc-sink', mode = 'live', sizing = {} } = {}) {
  emitEvent('arb.decision', {
    symbol: 'BTC',
    slug,
    mode,
    upAsk: 0.04,
    downAsk: 0.94,
    asksSum: 0.98,
    arbGap: 0.02,
    minArbGap: 0.015,
    breakEvenGap: 0.0066,
    requiredGap: 0.0116,
    sizing,
    packageId: action === 'open' ? `pkg-${slug}-${Math.random()}` : undefined,
    output: { action, skipReason: code ? { code, operands: { probe: 1 } } : null },
  });
}

beforeAll(() => {
  expect(startArbDecisionSink()).toBe(true);
  db = getDb();
});

afterAll(() => { stopArbDecisionSink(); });

beforeEach(() => {
  db.exec('DELETE FROM arb_decisions');
  db.exec('DELETE FROM arb_decision_counts');
  __resetArbSinkThrottle();
  vi.useRealTimers();
});

describe('INVARIANT: an opened package always leaves a row', () => {
  it('never throttles an open, even burst on one slug', () => {
    // Throttling opens would make the decision log unreconcilable against the
    // cash ledger — the one thing it has to support.
    for (let i = 0; i < 5; i++) decide({ action: 'open', code: null });

    expect(rowsFor(null)).toHaveLength(5);
    expect(rowsFor(null).every((r) => r.action === 'open')).toBe(true);
  });

  it('extracts the columns a query will actually filter on', () => {
    decide({ action: 'open', sizing: { shares: 36, capitalUsd: 35.28, restingShares: 40, depthShares: 36 } });

    const [row] = rowsFor(null);
    expect(row.symbol).toBe('BTC');
    expect(row.mode).toBe('live');
    expect(row.arb_gap).toBeCloseTo(0.02, 6);
    expect(row.shares).toBe(36);
    expect(row.resting_shares).toBe(40);
    expect(row.package_id).toMatch(/^pkg-/);
    // The verbatim payload survives alongside the columns, so a question nobody
    // thought to ask is still answerable from old rows.
    expect(JSON.parse(row.payload).output.action).toBe('open');
  });
});

describe('INVARIANT: nothing reaching the sink vanishes without trace', () => {
  it('conserves the total across rows and suppressed counts', () => {
    const emitted = [
      ...Array(50).fill('gap_below_breakeven'),
      ...Array(20).fill('gap_below_operator_floor'),
      ...Array(7).fill('depth_below_min_size'),
      ...Array(3).fill('depth_unknown'),
    ];
    emitted.forEach((code) => decide({ code }));

    // Persisted codes are counted too, so the sum is the true event total
    // regardless of how the whitelist is drawn.
    expect(countTotal()).toBe(emitted.length);
    expect(rowCount()).toBeGreaterThan(0);
  });

  it('counts an unrecognised code rather than dropping it', () => {
    // A gate added after this file was written must show up as a mystery in
    // the totals, not as silence.
    decide({ code: 'some_future_gate' });
    decide({ code: 'some_future_gate' });

    expect(countFor('some_future_gate')).toBe(2);
    expect(rowsFor('some_future_gate')).toHaveLength(0);
  });

  it('keeps the scan-rate noise codes out of the rows', () => {
    for (const code of COUNTED_CODES) {
      for (let i = 0; i < 10; i++) decide({ code });
    }
    expect(rowCount()).toBe(0);
    expect(countTotal()).toBe(COUNTED_CODES.size * 10);
  });
});

describe('INVARIANT: depth_unknown survives any filtering', () => {
  it('persists the item 70 regression canary', () => {
    // If the per-level WS book maps ever go back to publishing no ask, this
    // code is the only signal. Item 70 shipped because the previous failure was
    // invisible for six days.
    expect(PERSISTED_CODES.has('depth_unknown')).toBe(true);

    decide({ code: 'depth_unknown' });
    expect(rowsFor('depth_unknown')).toHaveLength(1);
  });
});

describe('INVARIANT: the throttle bounds volume without hiding the rate', () => {
  it('writes one row per code per slug per window, and counts the rest', () => {
    // A broke account emits `insufficient_live_cash` on every qualifying book
    // on every scan. The ten-thousandth copy carries nothing the first did not.
    for (let i = 0; i < 40; i++) decide({ code: 'insufficient_live_cash' });

    expect(rowsFor('insufficient_live_cash')).toHaveLength(1);
    expect(countFor('insufficient_live_cash')).toBe(40);
  });

  it('throttles per slug, not globally', () => {
    // Which markets are affected is the diagnostic; collapsing them would turn
    // "ETH book is thin" into "something somewhere was thin".
    for (const slug of ['btc-a', 'eth-b', 'btc-c']) {
      for (let i = 0; i < 5; i++) decide({ code: 'depth_below_min_size', slug });
    }

    const rows = rowsFor('depth_below_min_size');
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.slug))).toEqual(new Set(['btc-a', 'eth-b', 'btc-c']));
    expect(countFor('depth_below_min_size')).toBe(15);
  });

  it('re-opens the window once it has elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));
    decide({ code: 'depth_below_min_size' });
    expect(rowsFor('depth_below_min_size')).toHaveLength(1);

    // Just inside the window — still suppressed.
    vi.setSystemTime(Date.now() + THROTTLE_MS - 1000);
    decide({ code: 'depth_below_min_size' });
    expect(rowsFor('depth_below_min_size')).toHaveLength(1);

    // Past it — a fresh row, so a condition that persists for hours is visible
    // as a series rather than a single stale row.
    vi.setSystemTime(Date.now() + 2000);
    decide({ code: 'depth_below_min_size' });
    expect(rowsFor('depth_below_min_size')).toHaveLength(2);

    expect(countFor('depth_below_min_size')).toBe(3);
  });
});

describe('INVARIANT: the sink reads the payload the engine actually emits', () => {
  it('lands a real package open, driven end to end through arbEngine', async () => {
    // Every other test here hand-builds the payload, which proves the sink is
    // self-consistent and nothing about whether it agrees with its producer.
    // If `arbDecision` ever moves `sizing` or renames `output.action`, the
    // synthetic tests all keep passing and the live sink writes null columns.
    // This is the one test that fails when the two drift apart.
    const { detectAndExecuteArbPackage } = await import('../../src/polymarket/arbEngine.js');
    const { saveAllPackages } = await import('../../src/polymarket/arbPersistence.js');
    saveAllPackages([]);

    const leg = (ask) => ({ bestAsk: ask, bestAskSize: 40 });
    const pkg = await detectAndExecuteArbPackage({
      market: {
        symbol: 'BTC', slug: 'btc-sink-e2e', conditionId: '0xe2e',
        outcomes: ['Up', 'Down'], tokenIds: { up: 'tok-up-e', down: 'tok-down-e' },
        acceptingOrders: true,
      },
      depth: { up: leg(0.04), down: leg(0.94) },
      prices: { upAsk: 0.04, downAsk: 0.94 },
      cfg: {
        clobArbEnabled: true, minArbGap: 0.01, maxArbPackages: 4,
        arbBankrollFrac: 1.0, arbMaxUsd: 50, minPositionSize: 0.5, instantCtfMerge: false,
      },
      mode: 'live',
      readiness: { spendableBalance: 10_000 },
      log: () => {},
      executeTrade: async (p) => ({ ok: true, position: { shares: p.plan.shares } }),
      adjustPaperCash: () => {},
      saveTrade: () => {},
      botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
    });
    expect(pkg).not.toBeNull();

    const [row] = db.prepare("SELECT * FROM arb_decisions WHERE action = 'open'").all();
    expect(row).toBeDefined();
    expect(row.slug).toBe('btc-sink-e2e');
    expect(row.mode).toBe('live');
    // The columns that must not silently arrive as NULL.
    expect(row.shares).toBe(pkg.shares);
    expect(row.up_ask).toBeCloseTo(0.04, 6);
    expect(row.resting_shares).toBe(40);
    expect(row.depth_shares).toBeCloseTo(36, 6);
    expect(row.capital_usd).toBeGreaterThan(0);
    expect(row.package_id).toBe(pkg.packageId);
  });
});

describe('INVARIANT: a broken sink is visible, not silent', () => {
  it('accounts for a write failure rather than letting it escape', () => {
    // Asserting only `not.toThrow()` here proves nothing about this module:
    // the bus already wraps every subscriber (`events.ts:393-408`), so that
    // assertion passes even with the sink's own catch deleted — verified by
    // mutation. What the local handler adds is *attribution*: a failure
    // counted against the sink by name, rather than one generic subscriber
    // fault among all consumers of the bus. That is what is tested.
    db.exec('DROP TABLE arb_decisions');

    const before = arbSinkStatus().writeErrors;
    expect(() => decide({ action: 'open' })).not.toThrow();
    expect(() => decide({ code: 'depth_unknown' })).not.toThrow();

    const after = arbSinkStatus();
    expect(after.writeErrors).toBe(before + 2);
    expect(after.lastWriteError).toMatch(/arb_decisions/);

    // Restore for later runs.
    stopArbDecisionSink();
    startArbDecisionSink();
    expect(rowCount()).toBe(0);
  });
});
