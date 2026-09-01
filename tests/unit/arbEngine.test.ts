import { describe, expect, it, beforeEach } from 'vitest';
import { detectAndExecuteArbPackage, getArbPackageMetrics } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages, resetPackages } from '../../src/polymarket/arbPersistence.js';

describe('Atomic Arb Engine', () => {
  beforeEach(() => {
    saveAllPackages([]);
  });

  it('detects valid orderbook gap and locks an ArbPackage', async () => {
    const market = {
      symbol: 'ETH',
      slug: 'eth-5m-test',
      conditionId: '0xeth5mtest',
      outcomes: ['Up', 'Down'],
      tokenIds: { up: 'token-up-1', down: 'token-down-1' },
      acceptingOrders: true,
    };

    const depth = {
      up: { bestAsk: 0.34 },
      down: { bestAsk: 0.62 },
    };

    const cfg = {
      clobArbEnabled: true,
      minArbGap: 0.015,
      maxArbPackages: 4,
      paperBankroll: 100,
      arbBankrollFrac: 0.2,
      arbMaxUsd: 50,
      minPositionSize: 0.5,
      mode: 'paper',
    };

    // executePendingTrade returns { ok, ... } on every path, never a bare boolean
    // (backlog item 27 — coercing it with !! is what recorded refusals as fills).
    const mockExecuteTrade = async () => ({ ok: true });

    const pkg = await detectAndExecuteArbPackage({
      market,
      depth,
      prices: { up: 0.34, down: 0.62 },
      cfg,
      mode: 'paper',
      log: () => {},
      executeTrade: mockExecuteTrade,
      adjustPaperCash: () => {},
      saveTrade: () => {},
      botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
    });

    expect(pkg).not.toBeNull();
    expect(pkg?.status).toBe('LOCKED');
    expect(pkg?.symbol).toBe('ETH');
    expect(pkg?.totalCost).toBe(20);
    expect(pkg?.expectedPayout).toBe(20.83); // 20.833 shares * $1.00
    // Net of both entry taker fees (item 7). This asserted 0.83 — the gross
    // figure — which is precisely the number the dashboard overstated by 5.2x.
    // Settlement redeems the set fee-free, so the two entry fees are the whole
    // cost: 20.833 sh at 0.34 and 0.62 => $0.67 combined.
    expect(pkg?.lockedProfitUsd).toBe(0.16);
    expect(pkg?.feesEstUsd).toBeCloseTo(0.67, 2);
    // Gross minus fees, restated so the relationship is explicit rather than a
    // magic constant.
    expect(pkg!.expectedPayout - pkg!.totalCost - pkg!.feesEstUsd!).toBeCloseTo(pkg!.lockedProfitUsd, 2);
    expect(pkg?.legs.up.filled).toBe(true);
    expect(pkg?.legs.down.filled).toBe(true);
  });

  it('rejects arbitrage execution when ask sum exceeds 1 - minArbGap', async () => {
    const market = { symbol: 'BTC', slug: 'btc-5m-test', conditionId: '0xbtc5m', outcomes: ['Up', 'Down'], tokenIds: { up: 'u', down: 'd' } };
    const depth = { up: { bestAsk: 0.51 }, down: { bestAsk: 0.50 } }; // sum = 1.01 (no gap)

    const cfg = { clobArbEnabled: true, minArbGap: 0.015, maxArbPackages: 4, paperBankroll: 100 };

    const pkg = await detectAndExecuteArbPackage({
      market,
      depth,
      prices: { up: 0.51, down: 0.50 },
      cfg,
      mode: 'paper',
      log: () => {},
      executeTrade: async () => ({ ok: true }),
      adjustPaperCash: () => {},
      saveTrade: () => {},
      botState: { config: {}, positions: [] },
    });

    expect(pkg).toBeNull();
  });

  // Polymarket reports negRisk:false on every btc/eth-updown market, yet those are
  // ordinary complementary binaries whose legs still redeem exactly $1.00 together.
  // Gating on negRisk disabled arb entirely; the payout guarantee comes from the
  // binary condition, so that is what must be checked.
  it('locks arb on a complementary binary even when negRisk is false', async () => {
    const market = {
      symbol: 'ETH',
      slug: 'eth-updown-5m-1787012400',
      conditionId: '0x6e68da643a31',
      outcomes: ['Up', 'Down'],
      tokenIds: { up: 'token-up-1', down: 'token-down-1' },
      negRisk: false,
    };
    const depth = { up: { bestAsk: 0.34 }, down: { bestAsk: 0.62 } };
    const cfg = { clobArbEnabled: true, minArbGap: 0.015, maxArbPackages: 4, paperBankroll: 100, mode: 'paper' };

    const pkg = await detectAndExecuteArbPackage({
      market, depth, prices: { up: 0.34, down: 0.62 }, cfg, mode: 'paper',
      log: () => {}, executeTrade: async () => ({ ok: true }), adjustPaperCash: () => {}, saveTrade: () => {},
      botState: { config: {}, positions: [] },
    });

    expect(pkg?.status).toBe('LOCKED');
  });

  it.each([
    ['no conditionId', { outcomes: ['Up', 'Down'], tokenIds: { up: 'u', down: 'd' } }],
    ['more than two outcomes', { conditionId: '0xabc', outcomes: ['A', 'B', 'C'], tokenIds: { up: 'u', down: 'd' } }],
    ['a missing leg token', { conditionId: '0xabc', outcomes: ['Up', 'Down'], tokenIds: { up: 'u' } }],
    ['both legs sharing one token', { conditionId: '0xabc', outcomes: ['Up', 'Down'], tokenIds: { up: 'u', down: 'u' } }],
  ])('rejects arb execution on a market with %s', async (_label, marketShape) => {
    const market = { symbol: 'ETH', slug: 'eth-not-a-binary', ...marketShape };
    const depth = { up: { bestAsk: 0.34 }, down: { bestAsk: 0.62 } }; // big gap, would lock if allowed
    const cfg = { clobArbEnabled: true, minArbGap: 0.015, maxArbPackages: 4, paperBankroll: 100, mode: 'paper' };

    const pkg = await detectAndExecuteArbPackage({
      market, depth, prices: { up: 0.34, down: 0.62 }, cfg, mode: 'paper',
      log: () => {}, executeTrade: async () => ({ ok: true }), adjustPaperCash: () => {}, saveTrade: () => {},
      botState: { config: {}, positions: [] },
    });

    expect(pkg).toBeNull();
  });

  it('enforces maxArbPackages capacity limit', async () => {
    const market1 = { symbol: 'ETH', slug: 'eth-1', conditionId: '0xeth1', outcomes: ['Up', 'Down'], tokenIds: { up: 'u1', down: 'd1' } };
    const market2 = { symbol: 'ETH', slug: 'eth-2', conditionId: '0xeth2', outcomes: ['Up', 'Down'], tokenIds: { up: 'u2', down: 'd2' } };

    const cfg = { clobArbEnabled: true, minArbGap: 0.015, maxArbPackages: 1, paperBankroll: 100, mode: 'paper' };
    const depth = { up: { bestAsk: 0.34 }, down: { bestAsk: 0.62 } };

    // Package 1 fills successfully
    const pkg1 = await detectAndExecuteArbPackage({
      market: market1, depth, prices: { up: 0.34, down: 0.62 }, cfg, mode: 'paper',
      log: () => {}, executeTrade: async () => ({ ok: true }), adjustPaperCash: () => {}, saveTrade: () => {},
      botState: { config: {}, positions: [] },
    });
    expect(pkg1?.status).toBe('LOCKED');

    // Package 2 should be blocked because maxArbPackages is 1
    const pkg2 = await detectAndExecuteArbPackage({
      market: market2, depth, prices: { up: 0.34, down: 0.62 }, cfg, mode: 'paper',
      log: () => {}, executeTrade: async () => ({ ok: true }), adjustPaperCash: () => {}, saveTrade: () => {},
      botState: { config: {}, positions: [] },
    });
    expect(pkg2).toBeNull();
  });

  it('computes package metrics correctly', () => {
    saveAllPackages([
      { packageId: 'p1', mode: 'paper', status: 'SETTLED', lockedProfitUsd: 0.83 },
      { packageId: 'p2', mode: 'paper', status: 'SETTLED', lockedProfitUsd: 1.20 },
      { packageId: 'p3', mode: 'paper', status: 'LOCKED', lockedProfitUsd: 0.50 },
    ] as any);

    const metrics = getArbPackageMetrics('paper');
    expect(metrics.totalPackages).toBe(3);
    expect(metrics.settledCount).toBe(2);
    expect(metrics.activeLocked).toBe(1);
    expect(metrics.winRatePct).toBe(100);
    expect(metrics.netProfitUsd).toBe(2.03);
  });

  it('passes valid numeric entryPrice in order plans to trade execution', async () => {
    const market = { symbol: 'ETH', slug: 'eth-plan-test', conditionId: '0xethplan', outcomes: ['Up', 'Down'], tokenIds: { up: 'u', down: 'd' } };
    const depth = { up: { bestAsk: 0.34 }, down: { bestAsk: 0.62 } };
    const cfg = { clobArbEnabled: true, minArbGap: 0.015, paperBankroll: 100, mode: 'paper' };

    const capturedPlans: any[] = [];
    const interceptExecuteTrade = async (pending: any) => {
      capturedPlans.push(pending.plan);
      return { ok: true, position: { id: 'p1' } };
    };

    await detectAndExecuteArbPackage({
      market, depth, prices: { up: 0.34, down: 0.62 }, cfg, mode: 'paper',
      log: () => {}, executeTrade: interceptExecuteTrade, adjustPaperCash: () => {}, saveTrade: () => {},
      botState: { config: {}, positions: [] },
    });

    expect(capturedPlans.length).toBe(2);
    for (const plan of capturedPlans) {
      expect(plan.entryPrice).toBeDefined();
      expect(typeof plan.entryPrice).toBe('number');
      expect(plan.entryPrice).toBeGreaterThan(0);
      expect(plan.packageId).toBeDefined();
      expect(plan.isArbLeg).toBe(true);
    }
  });

  it('resets packages by mode cleanly (item 24)', () => {
    saveAllPackages([
      { packageId: 'paper-1', mode: 'paper', status: 'SETTLED', lockedProfitUsd: 1.0 },
      { packageId: 'paper-2', mode: 'paper', status: 'LOCKED', lockedProfitUsd: 0.5 },
      { packageId: 'live-1', mode: 'live', status: 'LOCKED', lockedProfitUsd: 0.8 },
    ] as any);

    // Resetting paper removes paper-1 and paper-2, preserving live-1
    const { removed } = resetPackages('paper');
    expect(removed).toBe(2);

    const paperMetrics = getArbPackageMetrics('paper');
    expect(paperMetrics.totalPackages).toBe(0);
    expect(paperMetrics.netProfitUsd).toBe(0);

    const liveMetrics = getArbPackageMetrics('live');
    expect(liveMetrics.totalPackages).toBe(1);
    expect(liveMetrics.activeLocked).toBe(1);

    // Resetting live removes live-1
    const { removed: removedLive } = resetPackages('live');
    expect(removedLive).toBe(1);
    expect(getArbPackageMetrics('live').totalPackages).toBe(0);
  });
});

/**
 * Invariants for the fill-or-kill entry path.
 *
 * These assert *properties* rather than a snapshot of current behaviour. The
 * property that matters is share parity: a package is arbitrage only to the
 * extent that both legs hold the same number of shares, because it is the
 * complementary *set* — one token paying $1, the other $0 — that redeems to
 * exactly $1.00. Dollars bought are not the invariant; shares held are.
 */
describe('Arb entry invariants — fill-or-kill share parity', () => {
  const market = {
    symbol: 'BTC',
    slug: 'btc-updown-5m-parity',
    conditionId: '0xparity',
    outcomes: ['Up', 'Down'],
    tokenIds: { up: 'token-up-p', down: 'token-down-p' },
    acceptingOrders: true,
  };
  const depth = { up: { bestAsk: 0.33 }, down: { bestAsk: 0.487 } };
  const cfg = {
    clobArbEnabled: true,
    minArbGap: 0.01,
    maxArbPackages: 4,
    paperBankroll: 100,
    arbBankrollFrac: 0.2,
    arbMaxUsd: 50,
    minPositionSize: 0.5,
    instantCtfMerge: false,
  };

  const run = (executeTrade, mode: 'paper' | 'live' = 'live') => detectAndExecuteArbPackage({
    market,
    depth,
    prices: { up: 0.33, down: 0.487 },
    cfg,
    mode,
    readiness: { spendableBalance: 500 },
    log: () => {},
    executeTrade,
    adjustPaperCash: () => {},
    saveTrade: () => {},
    botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
  });

  beforeEach(() => {
    saveAllPackages([]);
  });

  it('sizes the second leg from what the first leg actually matched, not from the plan', async () => {
    // A market buy is denominated in dollars, so the first leg's share count is
    // only known from its receipt. Here it comes back 12% under plan.
    const seen: any[] = [];
    const executeTrade = async (pending) => {
      seen.push({ outcome: pending.outcome, requestedShares: pending.plan.shares, sizeUsd: pending.plan.sizeUsd });
      const shares = pending.outcome === 'up' ? pending.plan.shares * 0.88 : pending.plan.shares;
      return { ok: true, position: { shares } };
    };

    const pkg = await run(executeTrade);

    expect(pkg?.status).toBe('LOCKED');
    const [up, down] = seen;
    // The DOWN leg must be asked for exactly the shares UP actually got — had it
    // been sized from the plan it would still be asking for `up.requestedShares`.
    expect(down.requestedShares).toBeCloseTo(up.requestedShares * 0.88, 3);
    expect(down.requestedShares).toBeLessThan(up.requestedShares);
    // ...and its budget must follow the shares at the quoted ask.
    expect(down.sizeUsd).toBeCloseTo(down.requestedShares * 0.487, 2);
  });

  it('holds equal shares on both legs, and a locked package redeems its share count to $1.00 each', async () => {
    // Leg 1's fill is unknown until its receipt, so let it land 12% under plan.
    // Leg 2 then delivers exactly what it is asked for — which is what
    // fill-or-kill guarantees: the full signed amount, or nothing at all.
    const executeTrade = async (pending) => ({
      ok: true,
      position: { shares: pending.outcome === 'up' ? pending.plan.shares * 0.88 : pending.plan.shares },
    });

    const pkg = await run(executeTrade);

    expect(pkg?.status).toBe('LOCKED');
    // The invariant: both legs hold the same quantity.
    expect(pkg!.legs.up.shares).toBeCloseTo(pkg!.legs.down.shares!, 3);
    // The package records the matched pair, and a full set pays exactly $1.00.
    expect(pkg!.shares).toBeCloseTo(pkg!.legs.down.shares!, 3);
    expect(pkg!.expectedPayout).toBeCloseTo(pkg!.shares * 1.0, 2);
    // No residual: nothing is unhedged.
    expect(pkg!.residualShares).toBeUndefined();
  });

  it('records a residual when the legs come back unequal, and never counts it as arbitrage', async () => {
    // Should be unreachable with both legs FOK — asserted so that if the model
    // of FOK is ever wrong, the surplus is visible rather than silently treated
    // as part of the hedge.
    const executeTrade = async (pending) => ({
      ok: true,
      position: { shares: pending.outcome === 'up' ? 30 : 20 },
    });

    const pkg = await run(executeTrade);

    expect(pkg?.status).toBe('LOCKED');
    expect(pkg!.residualShares).toBeCloseTo(10, 3);
    expect(pkg!.residualOutcome).toBe('up');
    // Only the matched 20 are a hedge; payout must not count the naked 10.
    expect(pkg!.shares).toBe(20);
    expect(pkg!.expectedPayout).toBeCloseTo(20, 2);
  });

  it('refuses to hedge against a live leg that reports success without a confirmed share count', async () => {
    // `ok: true` with no verified quantity is a contradiction in live mode.
    // Buying the second leg here is precisely how an unhedged position is born.
    const seen: string[] = [];
    const executeTrade = async (pending) => {
      seen.push(pending.outcome);
      return { ok: true };
    };

    const pkg = await run(executeTrade, 'live');

    expect(pkg?.status).toBe('ABORTED');
    expect(seen).toEqual(['up']); // the DOWN leg was never dispatched
  });

  it('unwinds the first leg when the second is killed, leaving nothing naked', async () => {
    const executeTrade = async (pending) => (pending.outcome === 'up'
      ? { ok: true, position: { shares: 25 } }
      : { ok: false, error: 'FOK killed' });

    const pkg = await run(executeTrade);

    expect(pkg?.status).toBe('ABORTED');
    expect(pkg?.unwoundAt).toBeDefined();
    expect(pkg?.abortReason).toMatch(/UP=OK, DOWN=FAIL/);
  });

  /**
   * INVARIANT: `legs.*.filled` and `abortReason` describe the same reality.
   *
   * Backlog 43, taken straight from the live canary. Package pkg-btc-mtbtgyzj
   * (2026-08-27 17:48:46 UTC) recorded:
   *
   *     abortReason    : "Leg execution mismatch: UP=OK, DOWN=FAIL"
   *     legs.up.filled : false
   *
   * `abortReason` is built from `upShares > 0`, so the engine knew the UP leg
   * had matched — 25.99 shares, $2.86, confirmed on-chain. But the flag was only
   * written on the LOCKED path, so every reconciler that reads it saw nothing to
   * unwind, and the shares expired worthless.
   *
   * Asserting the two agree is the point: either alone can be made green by a
   * plausible edit, and it was their disagreement that hid a real loss.
   */
  it('records the filled leg on an aborted package, not just in the abort reason', async () => {
    const executeTrade = async (pending) => (pending.outcome === 'up'
      ? { ok: true, position: { shares: 25.99 } }
      : { ok: false, error: 'blocked: min order exceeds risk cap' });

    const pkg = await run(executeTrade);

    expect(pkg?.status).toBe('ABORTED');
    expect(pkg?.abortReason).toMatch(/UP=OK, DOWN=FAIL/);
    // The regression: this was `false` while the reason above said OK.
    expect(pkg?.legs.up.filled, 'aborted package forgot the leg that filled').toBe(true);
    expect(pkg?.legs.up.shares).toBeCloseTo(25.99, 3);
    expect(pkg?.legs.down.filled).toBe(false);

    // Stated as an agreement, so neither side can drift alone.
    const reasonSaysUpFilled = /UP=OK/.test(pkg!.abortReason);
    expect(pkg!.legs.up.filled).toBe(reasonSaysUpFilled);
    expect(pkg!.legs.down.filled).toBe(/DOWN=OK/.test(pkg!.abortReason));
  });

  it('records neither leg as filled when both are killed', () => {
    // The other nine canary packages: both legs refused, nothing on-chain. A
    // sweep that treats these as orphans would sell shares we never held.
    const executeTrade = async () => ({ ok: false, error: 'blocked' });
    return run(executeTrade).then((pkg) => {
      expect(pkg?.status).toBe('ABORTED');
      expect(pkg?.abortReason).toMatch(/UP=FAIL, DOWN=FAIL/);
      expect(pkg?.legs.up.filled).toBe(false);
      expect(pkg?.legs.down.filled).toBe(false);
    });
  });

  it('still marks both legs filled on the locked path', () => {
    // Moving the assignment earlier must not drop it for the success case.
    const executeTrade = async () => ({ ok: true, position: { shares: 26 } });
    return run(executeTrade).then((pkg) => {
      expect(pkg?.status).toBe('LOCKED');
      expect(pkg?.legs.up.filled).toBe(true);
      expect(pkg?.legs.down.filled).toBe(true);
      expect(pkg?.legs.up.shares).toBeCloseTo(26, 3);
      expect(pkg?.legs.down.shares).toBeCloseTo(26, 3);
    });
  });
});
