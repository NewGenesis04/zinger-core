// @ts-nocheck
/**
 * INVARIANT: an arb package is never sized beyond the bankroll that funds it —
 * in EITHER mode.
 *
 * The gate at `arbEngine.ts` used to read `mode === 'paper' && ...`, so live
 * sizing took `readiness.spendableBalance`, computed a cost, and never checked
 * the balance covered it. `shareBudget` floors at `minPositionSize * 2`, so even
 * a zero balance still produced an order.
 *
 * That survived only because readiness was refetched on every 250ms scan tick.
 * Caching it (backlog item 60) opens a window where a stale-high balance fills
 * leg one and has leg two rejected for collateral — leaving an UNHEDGED
 * directional position, the single outcome an arb package exists to prevent.
 * Polymarket will not fill what you cannot fund, so the risk is never an
 * overdraft; it is always a broken hedge.
 *
 * Stated as a property over both modes so neither can regress independently, and
 * so the two branches cannot drift apart again.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectAndExecuteArbPackage } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages } from '../../src/polymarket/arbPersistence.js';
import { queryEvents, clearEvents } from '../../src/polymarket/telemetry/events.js';

// `isComplementaryBinary` (arbEngine.ts:25-31) requires conditionId, exactly two
// outcomes, and two distinct token ids — it returns null *silently* otherwise,
// before the decision helper exists, so an incomplete fixture here looks
// identical to a refused trade.
const market = {
  symbol: 'BTC',
  slug: 'btc-updown-affordability',
  conditionId: '0xaffordability',
  outcomes: ['Up', 'Down'],
  tokenIds: { up: 'token-up-a', down: 'token-down-a' },
  acceptingOrders: true,
};

/** A gap wide enough to clear break-even, so only affordability can refuse it. */
const depth = { up: { bestAsk: 0.33 }, down: { bestAsk: 0.487 } };

const baseCfg = {
  clobArbEnabled: true,
  minArbGap: 0.01,
  maxArbPackages: 4,
  arbBankrollFrac: 0.2,
  arbMaxUsd: 50,
  minPositionSize: 0.5,
  instantCtfMerge: false,
};

function run({ mode, spendableBalance, paperBankroll, executeTrade }) {
  return detectAndExecuteArbPackage({
    market,
    depth,
    prices: { up: 0.33, down: 0.487 },
    cfg: { ...baseCfg, paperBankroll },
    mode,
    readiness: spendableBalance == null ? undefined : { spendableBalance },
    log: () => {},
    executeTrade: executeTrade ?? (async (p) => ({ ok: true, position: { shares: p.plan.shares } })),
    adjustPaperCash: () => {},
    saveTrade: () => {},
    botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
  });
}

/** Skip codes on the real telemetry bus — the path the dashboard actually reads. */
const skipCodes = () => queryEvents({ types: ['arb.decision'] })
  .map((e) => (e.data as any)?.output?.skipReason?.code)
  .filter(Boolean);

const reset = () => { clearEvents(); saveAllPackages([]); };

beforeEach(reset);

describe('INVARIANT: arb never sizes past the bankroll that funds it', () => {
  it('refuses a live package when spendable balance cannot cover the cost', async () => {
    const executeTrade = vi.fn();
    const pkg = await run({ mode: 'live', spendableBalance: 0.05, executeTrade });

    expect(pkg).toBeNull();
    expect(executeTrade).not.toHaveBeenCalled();   // no leg was ever sent
    expect(skipCodes()).toContain('insufficient_live_cash');
  });

  it('refuses a live package when readiness is missing entirely', async () => {
    // The cold-start case that decoupling the scan loop creates: nothing has
    // populated botState.readiness yet. Absent balance must read as zero, not
    // as permission to send a floor-sized order.
    const executeTrade = vi.fn();
    const pkg = await run({ mode: 'live', spendableBalance: undefined, executeTrade });

    expect(pkg).toBeNull();
    expect(executeTrade).not.toHaveBeenCalled();
    expect(skipCodes()).toContain('insufficient_live_cash');
  });

  it('still refuses a paper package it cannot afford, under its own code', async () => {
    const executeTrade = vi.fn();
    const pkg = await run({ mode: 'paper', paperBankroll: 0.05, executeTrade });

    expect(pkg).toBeNull();
    expect(executeTrade).not.toHaveBeenCalled();
    expect(skipCodes()).toContain('insufficient_paper_cash');
  });

  it('allows a funded live package through to execution', async () => {
    // The gate must not be so eager that it blocks legitimate trades — a guard
    // that refuses everything would pass every test above.
    const executeTrade = vi.fn(async (p) => ({ ok: true, position: { shares: p.plan.shares } }));
    const pkg = await run({ mode: 'live', spendableBalance: 500, executeTrade });

    expect(pkg).not.toBeNull();
    expect(executeTrade).toHaveBeenCalled();
    expect(skipCodes()).not.toContain('insufficient_live_cash');
  });

  it('applies the same rule to both modes at the same balance', async () => {
    // Property form: whatever the threshold is, live and paper agree on it.
    // Prevents the two branches drifting apart the way they had.
    for (const balance of [0, 0.05, 0.5]) {
      reset();
      const live = await run({ mode: 'live', spendableBalance: balance });
      reset();
      const paper = await run({ mode: 'paper', paperBankroll: balance });

      expect(live === null, `live @ ${balance}`).toBe(paper === null);
    }
  });
});
