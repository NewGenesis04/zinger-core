import { describe, expect, it, beforeEach } from 'vitest';
import { detectAndExecuteArbPackage, getArbPackageMetrics } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages } from '../../src/polymarket/arbPersistence.js';

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
});
