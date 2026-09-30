// @ts-nocheck
/**
 * Item 64. Live directional sizing reads `readiness.spendableBalance`, which the
 * 30s/60s sync timer owns and the scan loop only reads. Between two syncs, a
 * live fill must be deducted in memory before the next entry sizes, or two
 * entries in one window both size against the pre-fill balance.
 *
 * Property: however many live entries are sized back to back, with each
 * fill's cost deducted the way `bot.ts` deducts it, the total committed never
 * exceeds the balance the window opened with.
 *
 * The deduction site is in `bot.ts`, which cannot be driven without a venue, so
 * the source is checked for it on both live success paths (same approach as
 * invariants.exitInventory.test.ts).
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { resolveOrderSize } from '../../src/polymarket/engines/directional.js';
import { applyBalanceDelta } from '../../src/polymarket/readiness.js';
import { POLY_MIN_ORDER_USD } from '../../src/polymarket/config.js';

const CFG = {
  mode: 'live',
  useKellySizing: true,
  minPositionSize: 1,
  maxPositionSize: 25,
  kellyFraction: 0.5,
  maxPositionPct: 0.1,
  certaintySizing: false,
};

const size = (readiness, cfg = CFG) => resolveOrderSize(cfg, {
  price: 0.45,
  signal: { confidence: 0.62, asset: 'BTC' },
  readiness,
  stats: { totalTrades: 60, wins: 33 },
  remaining: 120,
  windowSec: 300,
  duration: '5m',
  symbol: 'BTC',
});

describe('INVARIANT: live directional entries cannot commit more than the balance (item 64)', () => {
  it('holds over back-to-back entries when each fill is deducted before the next sizes', () => {
    for (const start of [3, 10, 50, 275.16, 1000]) {
      for (const pct of [0.05, 0.1, 0.5]) {
        const readiness = { spendableBalance: start, clobBalance: start };
        let committed = 0;
        for (let i = 0; i < 25; i++) {
          const { sizeUsd } = size(readiness, { ...CFG, maxPositionPct: pct });
          // Below the venue's minimum notional an order is refused, not placed,
          // so it commits nothing. Sub-minimum sizes also fall under the cent
          // rounding `applyBalanceDelta` applies, which would make this loop
          // count dust that never reaches the book.
          if (!(sizeUsd >= POLY_MIN_ORDER_USD)) break;
          expect(sizeUsd).toBeLessThanOrEqual(readiness.spendableBalance + 1e-6);
          committed += sizeUsd;
          applyBalanceDelta(readiness, -sizeUsd);
        }
        expect(committed).toBeLessThanOrEqual(start + 1e-6);
      }
    }
  });

  it('refuses to size against an unknown balance', () => {
    expect(size({ spendableBalance: null, clobBalance: null }).sizeUsd).toBe(0);
    expect(size(null).sizeUsd).toBe(0);
  });

  it('would over-commit if the deduction were skipped (the test can fail)', () => {
    const start = 20;
    const readiness = { spendableBalance: start, clobBalance: start };
    let committed = 0;
    for (let i = 0; i < 25; i++) {
      const { sizeUsd } = size(readiness, { ...CFG, maxPositionPct: 0.5 });
      if (!(sizeUsd >= POLY_MIN_ORDER_USD)) break;
      committed += sizeUsd; // no applyBalanceDelta: the stale balance never falls
    }
    expect(committed).toBeGreaterThan(start);
  });
});

describe('INVARIANT: both live buy-success paths deduct the fill synchronously (item 64)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/polymarket/bot.ts', import.meta.url)), 'utf8');

  it('holds for the real source', () => {
    expect(src).toMatch(/applyLiveCashDelta\(-Number\(pos\.costBasis \|\| 0\), `BUY \$\{/);
    expect(src).toMatch(/applyLiveCashDelta\(-Number\(pos\.costBasis \|\| 0\), `BUY\(reconciled\)/);
  });

  it('fails when a deduction is removed', () => {
    const mutant = src.replace(/applyLiveCashDelta\(-Number\(pos\.costBasis \|\| 0\), `BUY\(reconciled\)[^\n]*\n/, '');
    expect(mutant).not.toBe(src);
    expect(mutant).not.toMatch(/applyLiveCashDelta\(-Number\(pos\.costBasis \|\| 0\), `BUY\(reconciled\)/);
  });
});
