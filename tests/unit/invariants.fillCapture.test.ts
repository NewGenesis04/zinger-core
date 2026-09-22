// @ts-nocheck
/**
 * INVARIANTS: a package's profit is computed from what its legs cost, not from
 * the quotes it was planned on (item 105).
 *
 * `pkg-eth-mu9ef745` (2026-09-20) was planned at 0.34 + 0.58 and filled at
 * 0.34 + 0.67. Its record, log line and dashboard reported +$0.16. The account
 * lost $0.164197, which is exact to the micro-dollar from `/activity`
 * (domain facts §10e):
 *
 *   UP    4.5      sh  $1.53 + $0.07068 fee
 *   DOWN  4.567163 sh  $3.06 + $0.07068 fee
 *   DOWN won, redeemed 4.567163 sh for $4.567163
 *
 * These tests pin the arithmetic against that ledger, and state the property
 * that has to hold for every resolution: the recorded profit is a floor on the
 * real one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { detectAndExecuteArbPackage, lockFromFills } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages } from '../../src/polymarket/arbPersistence.js';
import { readBuyCost } from '../../src/polymarket/trade.js';

const incidentLegs = () => ({
  up: { outcome: 'up', fill: { shares: 4.5, costUsd: 1.53, avgPrice: 0.34, feeUsd: 0.07068, priceSource: 'venue_making' } },
  down: { outcome: 'down', fill: { shares: 4.567163, costUsd: 3.06, avgPrice: 0.67, feeUsd: 0.07068, priceSource: 'venue_making' } },
});

/** What the account actually receives for this package under a payout vector. */
function realized(pkg, payout) {
  const { up, down } = pkg.legs;
  return up.fill.shares * payout.up + down.fill.shares * payout.down
    - up.fill.costUsd - down.fill.costUsd - up.fill.feeUsd - down.fill.feeUsd;
}

describe('INVARIANT: the fill path reads what a buy spent, and never more than it signed', () => {
  it('reads makingAmount in decimal human units (§9a)', () => {
    expect(readBuyCost({ makingAmount: '1.24' }, 1.24)).toEqual({ costUsd: 1.24, costSource: 'venue_making' });
  });

  it('falls back to the signed amount, and says so, when the reading is absent or impossible', () => {
    // A 1e6-scaled reading would be a million-fold overspend on a fixed-dollar buy.
    expect(readBuyCost({ makingAmount: '1240000' }, 1.24)).toEqual({ costUsd: 1.24, costSource: 'signed_amount' });
    expect(readBuyCost({}, 1.24)).toEqual({ costUsd: 1.24, costSource: 'signed_amount' });
    expect(readBuyCost(null, 3.06)).toEqual({ costUsd: 3.06, costSource: 'signed_amount' });
  });
});

describe('INVARIANT: locked profit is the guaranteed outcome of the fills', () => {
  it('reproduces pkg-eth-mu9ef745 from its ledger', () => {
    const pkg = lockFromFills({ lockedProfitUsd: 0.16, lockedProfitPct: 3.8, legs: incidentLegs() }, 4.5);
    expect(pkg.profitSource).toBe('fills');
    expect(pkg.plannedProfitUsd).toBe(0.16);
    expect(pkg.entryCostUsd).toBeCloseTo(4.59, 6);
    expect(pkg.entryFeesUsd).toBeCloseTo(0.14136, 6);
    // 4.5 full sets pay $4.50 whatever happens; the 0.067163 DOWN residual is upside.
    expect(pkg.lockedProfitUsd).toBe(-0.23);
    expect(pkg.slippageUsd).toBe(0.39);
    // DOWN won: the guaranteed floor plus the residual is the cash the account moved.
    expect(realized(pkg, { up: 0, down: 1 })).toBeCloseTo(-0.164197, 6);
  });

  it('is a floor on realized profit under every payout vector', () => {
    const cases = [
      incidentLegs(),
      // A clean pair, no residual: the floor is exact.
      {
        up: { fill: { shares: 10, costUsd: 4.6, avgPrice: 0.46, feeUsd: 0.17388, priceSource: 'venue_making' } },
        down: { fill: { shares: 10, costUsd: 4.6, avgPrice: 0.46, feeUsd: 0.17388, priceSource: 'venue_making' } },
      },
      // Residual on UP.
      {
        up: { fill: { shares: 6.2, costUsd: 3.1, avgPrice: 0.5, feeUsd: 0.1085, priceSource: 'venue_making' } },
        down: { fill: { shares: 6.0, costUsd: 2.64, avgPrice: 0.44, feeUsd: 0.10349, priceSource: 'venue_making' } },
      },
    ];
    for (const legs of cases) {
      const matched = Math.min(legs.up.fill.shares, legs.down.fill.shares);
      const pkg = lockFromFills({ lockedProfitUsd: 0, lockedProfitPct: 0, legs }, matched);
      for (const payout of [{ up: 1, down: 0 }, { up: 0, down: 1 }, { up: 0.5, down: 0.5 }]) {
        // Rounded to the cent on the way in, so allow half a cent.
        expect(realized(pkg, payout)).toBeGreaterThanOrEqual(pkg.lockedProfitUsd - 0.005);
      }
      if (legs.up.fill.shares === legs.down.fill.shares) {
        expect(realized(pkg, { up: 1, down: 0 })).toBeCloseTo(pkg.lockedProfitUsd, 2);
      }
    }
  });

  it('keeps the plan figure, and says so, when a leg has no fill', () => {
    const legs = incidentLegs();
    legs.down.fill = null;
    const pkg = lockFromFills({ lockedProfitUsd: 0.16, lockedProfitPct: 3.8, legs }, 4.5);
    expect(pkg.profitSource).toBe('plan');
    expect(pkg.lockedProfitUsd).toBe(0.16);
    expect(pkg.plannedProfitUsd).toBe(0.16);
  });
});

describe('INVARIANT: the engine records each leg\'s fill and locks on it', () => {
  beforeEach(() => saveAllPackages([]));

  const market = {
    symbol: 'ETH',
    slug: 'eth-updown-5m-1789883400',
    conditionId: '0xfills',
    outcomes: ['Up', 'Down'],
    tokenIds: { up: 'token-up', down: 'token-down' },
    acceptingOrders: true,
    tickSize: '0.01',
  };

  async function run(executeTrade) {
    const lines = [];
    const pkg = await detectAndExecuteArbPackage({
      market,
      depth: {
        up: { bestAsk: 0.34, bestAskSize: 5000, bookTs: Date.now() },
        down: { bestAsk: 0.58, bestAskSize: 5000, bookTs: Date.now() },
      },
      prices: { up: 0.34, down: 0.58 },
      cfg: {
        clobArbEnabled: true, minArbGap: 0.01, maxArbPackages: 4, paperBankroll: 500,
        arbBankrollFrac: 0.2, arbMaxUsd: 50, minPositionSize: 0.5, instantCtfMerge: false,
        arbLeg2RereadBook: false, mode: 'paper',
      },
      mode: 'paper',
      log: (m) => lines.push(m),
      executeTrade,
      adjustPaperCash: () => {},
      saveTrade: () => {},
      botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
    });
    return { pkg, lines };
  }

  it('copies the fills, signs leg 2 at the ceiling, and reports the guaranteed figure', async () => {
    const executeTrade = async (pending) => {
      const price = pending.plan.price;
      const shares = pending.plan.shares;
      const costUsd = Math.round(shares * price * 100) / 100;
      return {
        ok: true,
        position: {
          shares,
          fill: { shares, costUsd, avgPrice: price, feeUsd: 0.07, priceSource: 'venue_making' },
        },
      };
    };
    const { pkg, lines } = await run(executeTrade);
    expect(pkg.status).toBe('LOCKED');
    expect(pkg.legs.up.fill.costUsd).toBeGreaterThan(0);
    expect(pkg.legs.down.fill.costUsd).toBeGreaterThan(0);
    // Leg 2 is signed a tick above the quote (item 97), and the record now shows it.
    expect(pkg.legs.down.signedPrice).toBeCloseTo(0.59, 6);
    expect(pkg.legs.down.entryPrice).toBe(0.58);
    expect(pkg.profitSource).toBe('fills');
    const expected = Math.round(
      (pkg.shares - pkg.legs.up.fill.costUsd - pkg.legs.down.fill.costUsd - 0.14) * 100,
    ) / 100;
    expect(pkg.lockedProfitUsd).toBe(expected);
    expect(pkg.slippageUsd).toBe(Math.round((pkg.plannedProfitUsd - pkg.lockedProfitUsd) * 100) / 100);
    const lock = lines.find((l) => l.includes('ATOMIC ARB PACKAGE LOCKED'));
    expect(lock).toContain('guaranteed');
    expect(lock).toContain('signed ≤$0.590');
    expect(lock).toContain('DN quoted $0.580');
  });

  it('leaves a refused leg with no fill', async () => {
    let n = 0;
    const executeTrade = async (pending) => {
      n += 1;
      if (n === 2) return { ok: false, error: 'killed', position: { fill: { shares: 1, costUsd: 1, avgPrice: 1, feeUsd: 0, priceSource: 'x' } } };
      return { ok: true, position: { shares: pending.plan.shares, fill: { shares: pending.plan.shares, costUsd: 1, avgPrice: 0.34, feeUsd: 0.07, priceSource: 'venue_making' } } };
    };
    const { pkg } = await run(executeTrade);
    expect(pkg.status).toBe('ABORTED');
    expect(pkg.legs.down.fill).toBeNull();
  });
});
