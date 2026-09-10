// @ts-nocheck
/**
 * INVARIANT: the bot never asks for the whole top-of-book level (item 76).
 *
 * Orders are fill-or-kill and `maxPrice` is signed at exactly the best ask
 * (`bot.ts:1011`), so only the top level can fill — established in item 73.
 * Requesting 100% of it therefore has zero tolerance for a competing taker:
 * one share removed anywhere else in the world and the whole package dies
 * unfilled. 10 of the 15 sampled packages in the 2026-09-09/10 overnight run
 * were sized at exactly 100%.
 *
 * The properties below are stated as "at most `restingShares × UTILISATION`",
 * not as "equals 0.9 × depth", so tuning the constant does not require
 * rewriting them — only removing the cushion does.
 *
 * NOTE on the fixtures: every book here is deliberately skewed (0.04 / 0.94).
 * Break-even is fee-driven and roughly 3.5% at 50/50 but only ~0.7% at these
 * prices, so a skewed book is the only shape where a 2c gap survives the fee
 * gate at all. A symmetric fixture would skip on `gap_below_breakeven` before
 * sizing ever ran, and would test nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { detectAndExecuteArbPackage } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages } from '../../src/polymarket/arbPersistence.js';
import { queryEvents, clearEvents } from '../../src/polymarket/telemetry/events.js';

const UTILISATION = 0.90;

const market = {
  symbol: 'BTC',
  slug: 'btc-updown-utilisation',
  conditionId: '0xutil',
  outcomes: ['Up', 'Down'],
  tokenIds: { up: 'tok-up-u', down: 'tok-down-u' },
  acceptingOrders: true,
};

const baseCfg = {
  clobArbEnabled: true,
  minArbGap: 0.01,
  maxArbPackages: 4,
  arbBankrollFrac: 1.0,
  arbMaxUsd: 50,
  minPositionSize: 0.5,
  instantCtfMerge: false,
};

function run({ upAsk = 0.04, downAsk = 0.94, size = 5000, arbMaxUsd = 50, bank = 10_000 } = {}) {
  const leg = (ask) => ({ bestAsk: ask, bestAskSize: size });
  return detectAndExecuteArbPackage({
    market,
    depth: { up: leg(upAsk), down: leg(downAsk) },
    prices: { upAsk, downAsk },
    cfg: { ...baseCfg, arbMaxUsd },
    mode: 'live',
    readiness: { spendableBalance: bank },
    log: () => {},
    executeTrade: async (p) => ({ ok: true, position: { shares: p.plan.shares } }),
    adjustPaperCash: () => {},
    saveTrade: () => {},
    botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
  });
}

const decisions = () => queryEvents({ types: ['arb.decision'] }).map((e) => e.data);
const lastDecision = () => decisions().at(-1);
const skipCodes = () => decisions()
  .map((d) => d?.output?.skipReason?.code)
  .filter(Boolean);

beforeEach(() => { clearEvents(); saveAllPackages([]); });

describe('INVARIANT: an arb package never requests 100% of top-of-book', () => {
  it('leaves a cushion when depth is the binding constraint', async () => {
    // Budget allows 51.02 shares; the book holds 40. Depth binds.
    const pkg = await run({ size: 40 });

    expect(pkg).not.toBeNull();
    expect(pkg.shares).toBeLessThanOrEqual(40 * UTILISATION);
    expect(pkg.shares).toBe(36);
    // The pre-item-76 behaviour, stated explicitly so a revert cannot pass.
    expect(pkg.shares).not.toBe(40);
  });

  it('changes nothing when the budget binds first', async () => {
    // 5000 resting shares: 90% of that is still far beyond what $50 can buy,
    // so the cushion must be invisible here. A clamp that shrinks deep-book
    // sizing is costing money for no fill-probability gain.
    const pkg = await run({ size: 5000 });

    expect(pkg).not.toBeNull();
    expect(pkg.shares).toBe(Math.floor((50 / 0.98) * 1000) / 1000);
    expect(lastDecision()?.sizing?.boundBy).toBe('arbBankrollFrac/arbMaxUsd');
  });

  it('refuses a book that only clears the $1.00 floor at 100% depth', async () => {
    // The behavioural change, isolated. floorShares = $1.00/0.04 = 25.
    // 26 resting shares clears it at 100% but not at 90% (23.4), so the old
    // code opened a package sized at every share on the level. It must now
    // skip by name instead.
    const pkg = await run({ size: 26 });

    expect(pkg).toBeNull();
    expect(skipCodes()).toContain('depth_below_min_size');

    const operands = lastDecision()?.output?.skipReason?.operands;
    expect(operands.restingShares).toBe(26);
    expect(operands.depthShares).toBeCloseTo(23.4, 6);
    expect(operands.floorShares).toBeCloseTo(25, 6);
  });

  it('records what the book held next to what was asked for', async () => {
    // Item 76's cushion is a hypothesis — no size-race kill has ever been
    // observed on this bot. These two fields are what will eventually confirm
    // or kill it, so their presence is part of the contract, not a nicety.
    const pkg = await run({ size: 40 });

    const sizing = lastDecision()?.sizing;
    expect(sizing.restingShares).toBe(40);
    expect(sizing.depthShares).toBeCloseTo(40 * UTILISATION, 6);
    expect(sizing.utilisation).toBe(UTILISATION);
    expect(pkg.shares).toBeLessThanOrEqual(sizing.depthShares);
  });

  it('attributes the binding constraint to depth even when grid rounding shaves the size', async () => {
    // Regression guard. Deriving `boundBy` at the emit site as
    // `shares >= depthShares` reads FALSE whenever the 3-decimal share grid
    // takes a fraction off — so a depth-bound package reported itself
    // budget-bound. 40.001 x 0.9 = 36.0009, which floors to 36.000.
    const pkg = await run({ size: 40.001 });

    expect(pkg).not.toBeNull();
    expect(pkg.shares).toBe(36);
    expect(lastDecision()?.sizing?.boundBy).toBe('depth');
  });

  it('holds the cushion across the whole range of book sizes', async () => {
    // Property form: whatever the book holds, an opened package never asks for
    // more than the utilisation factor of it. Sizes chosen to straddle the
    // budget ceiling (51.02 shares) in both directions.
    for (const size of [30, 40, 55, 100, 500, 5000]) {
      clearEvents();
      saveAllPackages([]);
      const pkg = await run({ size });
      if (!pkg) continue;
      expect(pkg.shares).toBeLessThanOrEqual(size * UTILISATION + 1e-9);
    }
  });
});
