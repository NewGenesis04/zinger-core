// @ts-nocheck
/**
 * INVARIANT: what an aborted package cost reaches net profit (item 116).
 *
 * `getArbPackageMetrics` summed only settled packages. An abort whose filled
 * leg was unwound lost real money (spread plus two taker fees), and that loss
 * showed up only as a non-win in the win rate, never in the figure. So net
 * profit overstated arb by exactly the naked-leg losses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { detectAndExecuteArbPackage, getArbPackageMetrics, realizedPnlFor } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages, loadPackages } from '../../src/polymarket/arbPersistence.js';

beforeEach(() => saveAllPackages([]));

describe('INVARIANT: net profit = settled result + abort cost, each reported', () => {
  it('adds known abort costs, and counts unknowns rather than guessing', () => {
    saveAllPackages([
      { packageId: 's1', mode: 'paper', status: 'SETTLED', realizedPnlUsd: 0.5, legs: {} },
      { packageId: 'a1', mode: 'paper', status: 'ABORTED', realizedPnlUsd: -0.3, legs: { up: { filled: true }, down: { filled: false } } },
      // Nothing filled: nothing to unwind, a known zero.
      { packageId: 'a2', mode: 'paper', status: 'ABORTED', legs: { up: { filled: false }, down: { filled: false } } },
      // A filled leg with no closed trade: still held, or its trade is gone.
      { packageId: 'a3', mode: 'paper', status: 'ABORTED', legs: { up: { filled: true }, down: { filled: false } } },
    ]);
    const m = getArbPackageMetrics('paper', []);
    expect(m.settledProfitUsd).toBe(0.5);
    expect(m.abortCostUsd).toBe(-0.3);
    expect(m.netProfitUsd).toBe(0.2);
    expect(m.unknownRealizedCount).toBe(1);
  });

  it('reads an abort\'s cost from its closed trades when the package predates the field', () => {
    const pkg = { packageId: 'old', status: 'ABORTED', legs: { up: { filled: true } } };
    const trades = [{ packageId: 'old', closed: true, exitReason: 'arb_rollback', pnl: -0.41 }];
    expect(realizedPnlFor(pkg, trades)).toBe(-0.41);
  });
});

describe('INVARIANT: an unwind books its loss on the package itself', () => {
  it('records the rollback P/L on the aborted package, which outlives the trade log', async () => {
    const market = {
      symbol: 'ETH', slug: 'eth-abort-cost', conditionId: '0xabort', outcomes: ['Up', 'Down'],
      tokenIds: { up: 'u', down: 'd' }, acceptingOrders: true, tickSize: '0.01',
    };
    const botState = { config: { maxConcurrentPerSlug: 1 }, positions: [] };
    const saved = [];
    let n = 0;
    // Leg 1 fills and becomes a position; leg 2 is refused.
    const executeTrade = async (pending) => {
      n += 1;
      if (n === 2) return { ok: false, error: 'killed' };
      const pos = {
        id: 'leg-up', packageId: pending.plan.packageId, outcome: 'up', mode: 'paper', symbol: 'ETH',
        slug: market.slug, shares: pending.plan.shares, entryPrice: pending.plan.price, entryFee: 0.05, closed: false,
      };
      botState.positions.push(pos);
      return { ok: true, position: pos };
    };
    const pkg = await detectAndExecuteArbPackage({
      market,
      depth: { up: { bestAsk: 0.46, bestAskSize: 5000, bookTs: Date.now() }, down: { bestAsk: 0.46, bestAskSize: 5000, bookTs: Date.now() } },
      prices: { up: 0.46, down: 0.46 },
      cfg: {
        clobArbEnabled: true, minArbGap: 0.01, maxArbPackages: 4, paperBankroll: 500, arbBankrollFrac: 0.2,
        arbMaxUsd: 50, minPositionSize: 0.5, arbLeg2RereadBook: false, mode: 'paper',
      },
      mode: 'paper',
      log: () => {},
      executeTrade,
      adjustPaperCash: () => {},
      saveTrade: (t) => saved.push(t),
      botState,
    });
    expect(pkg.status).toBe('ABORTED');
    const rollback = saved.find((t) => t.exitReason === 'arb_rollback');
    expect(rollback).toBeDefined();
    // A round trip pays both fees, so it cannot be free.
    expect(rollback.pnl).toBeLessThan(0);
    const stored = loadPackages().find((p) => p.packageId === pkg.packageId);
    expect(stored.realizedPnlUsd).toBe(rollback.pnl);
    // With the trade log empty, the cost is still counted.
    expect(getArbPackageMetrics('paper', []).abortCostUsd).toBe(rollback.pnl);
  });
});
