// @ts-nocheck
/**
 * INVARIANT: live arb sends no order the readiness check has refused (item 63b).
 *
 * `liveReady` is the single answer to "can this bot execute live orders right
 * now" — proxy route, API key, deposit-wallet owner, region, balance. It gated
 * directional entries and nothing on the arb path read it, so a confirmed-dead
 * proxy (item 59) still let arb send legs into a dead route.
 *
 * Every refusal below is paired with a control on the same book that trades, so
 * a gate that refused everything could not pass.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectAndExecuteArbPackage } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages } from '../../src/polymarket/arbPersistence.js';
import { queryEvents, clearEvents } from '../../src/polymarket/telemetry/events.js';

const { PERSISTED_CODES, COUNTED_CODES } = await import('../../src/polymarket/telemetry/decisionSink.js');

const market = {
  symbol: 'BTC',
  slug: 'btc-updown-live-ready',
  conditionId: '0xliveready',
  outcomes: ['Up', 'Down'],
  tokenIds: { up: 'token-up-lr', down: 'token-down-lr' },
  acceptingOrders: true,
};

/** Clears break-even comfortably and is deep and funded, so only readiness can refuse. */
const TRADABLE = { up: { bestAsk: 0.33, bestAskSize: 5000 }, down: { bestAsk: 0.487, bestAskSize: 5000 } };
/** Sums above $1.00 — no gap at all. */
const NO_GAP = { up: { bestAsk: 0.52, bestAskSize: 5000 }, down: { bestAsk: 0.51, bestAskSize: 5000 } };

const cfg = {
  clobArbEnabled: true, minArbGap: 0.01, maxArbPackages: 4,
  arbBankrollFrac: 0.2, arbMaxUsd: 50, minPositionSize: 0.5,
  instantCtfMerge: false, paperBankroll: 500,
};

function run({ mode = 'live', readiness, depth = TRADABLE, executeTrade }) {
  return detectAndExecuteArbPackage({
    market,
    depth,
    prices: { upAsk: depth.up.bestAsk, downAsk: depth.down.bestAsk },
    cfg,
    mode,
    readiness,
    log: () => {},
    executeTrade,
    adjustPaperCash: () => {},
    saveTrade: () => {},
    botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
  });
}

const fills = () => vi.fn(async (p) => ({ ok: true, position: { shares: p.plan.shares } }));
const skips = () => queryEvents({ types: ['arb.decision'] })
  .map((e) => e.data?.output?.skipReason)
  .filter(Boolean);

beforeEach(() => { clearEvents(); saveAllPackages([]); });

describe('INVARIANT: live arb is gated on liveReady', () => {
  it('sends no leg when readiness says not ready, and trades the same book when it says ready', async () => {
    const refused = fills();
    expect(await run({ readiness: { spendableBalance: 500, liveReady: false }, executeTrade: refused })).toBeNull();
    expect(refused).not.toHaveBeenCalled();
    expect(skips().map((s) => s.code)).toContain('live_not_ready');

    saveAllPackages([]); clearEvents();
    const control = fills();
    expect(await run({ readiness: { spendableBalance: 500, liveReady: true }, executeTrade: control })).not.toBeNull();
    expect(control).toHaveBeenCalled();
    expect(skips().map((s) => s.code)).not.toContain('live_not_ready');
  });

  it('fails closed when there is no readiness snapshot yet', async () => {
    const executeTrade = fills();
    expect(await run({ readiness: undefined, executeTrade })).toBeNull();
    expect(executeTrade).not.toHaveBeenCalled();

    const s = skips().find((x) => x.code === 'live_not_ready');
    expect(s?.operands?.readinessKnown).toBe(false);
  });

  it('records a confirmed-dead proxy as the operand, not just "not ready"', async () => {
    await run({
      readiness: { spendableBalance: 500, liveReady: false, proxyHealth: { ok: false, detail: 'timeout' } },
      executeTrade: fills(),
    });
    const s = skips().find((x) => x.code === 'live_not_ready');
    expect(s?.operands).toEqual({ readinessKnown: true, proxyDown: true });
  });

  it('does not touch paper trading', async () => {
    const executeTrade = fills();
    expect(await run({ mode: 'paper', readiness: { liveReady: false }, executeTrade })).not.toBeNull();
    expect(executeTrade).toHaveBeenCalled();
    expect(skips().map((s) => s.code)).not.toContain('live_not_ready');
  });
});

describe('INVARIANT: live_not_ready is counted only for tradable books, and not stored per row', () => {
  it('leaves a book with no gap under its own code', async () => {
    await run({ depth: NO_GAP, readiness: { spendableBalance: 500, liveReady: false }, executeTrade: fills() });
    const codes = skips().map((s) => s.code);
    expect(codes).not.toContain('live_not_ready');
    expect(codes.some((c) => c.startsWith('gap_below'))).toBe(true);
  });

  it('is classified as standing state by the decision sink', () => {
    expect(COUNTED_CODES.has('live_not_ready')).toBe(true);
    expect(PERSISTED_CODES.has('live_not_ready')).toBe(false);
  });
});
