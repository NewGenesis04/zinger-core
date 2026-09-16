// @ts-nocheck
/**
 * INVARIANT: the fill path recognises every fill the venue could actually make
 * (item 81).
 *
 * On 2026-09-11 a $1.24 FOK buy bounded at $0.27 filled 4.682223 shares against
 * 4.59 expected — price improvement, which only ever ADDS shares to a
 * fixed-dollar buy. `verifyFilledShares` held a symmetric ±2% band, missed the
 * fill by 0.0004 shares, and reported it unverified. That is where the ghost
 * began.
 *
 * Item 80's reconciler already used the correct one-sided band, so the bug was
 * two modules answering one question with two bands. These tests pin the fix as
 * properties of the fill path itself, and pin that there is now ONE band.
 */
import { describe, it, expect } from 'vitest';
import {
  verifyFilledShares,
  expectedSharesFor,
  shareBand,
  resolveInBand,
} from '../../src/polymarket/trade.js';
import * as reconcile from '../../src/polymarket/arbReconcile.js';

/** The band `placeMarketBuy` builds for an order, via the same owner it uses. */
function bandFor({ amountUsd, maxPrice, tickSize = '0.01', minShares = 5 }) {
  const q = expectedSharesFor({ amountUsd, maxPrice, tickSize, minShares });
  return { q, band: shareBand({ expectedShares: q.expectedShares, price: q.price, tickSize: Number(tickSize), tolerance: q.tolerance }) };
}

const unreachable = async () => { throw new Error('second rung must not be needed'); };

describe('INVARIANT: the 2026-09-11 fill is verified on the fill path', () => {
  // The recorded expectation was 4.59 = 1.24 / 0.27, so the minimum-share floor
  // did not lift that order; `minShares: 0` reproduces it rather than $1.35.
  const { q, band } = bandFor({ amountUsd: 1.24, maxPrice: 0.27, minShares: 0 });

  it('derives the same quote the live order used', () => {
    expect(q.expectedShares).toBe(4.59);
    expect(q.tolerance).toBeCloseTo(0.0918, 6);
    // Proof the band it replaced refuses this fill:
    expect(Math.abs(4.682223 - q.expectedShares)).toBeGreaterThan(q.tolerance);
  });

  it('resolves it from the receipt, at either wire scale', async () => {
    expect(await verifyFilledShares({ takingAmount: '4682223' }, band, unreachable)).toBeCloseTo(4.682223, 6);
    expect(await verifyFilledShares({ takingAmount: '4.682223' }, band, unreachable)).toBeCloseTo(4.682223, 6);
  });

  it('resolves it from size_matched when the receipt is silent', async () => {
    const shares = await verifyFilledShares({ orderID: '0xabc' }, band, async (id) => {
      expect(id).toBe('0xabc');
      return '4682223';
    });
    expect(shares).toBeCloseTo(4.682223, 6);
  });
});

describe('INVARIANT: every physically possible fill resolves, and to exactly one scale', () => {
  // A fixed-dollar buy at limit `px` receives amount / fillPrice shares, for any
  // tick-aligned fillPrice in [tick, px]. Every one of those is a real outcome.
  it('holds across every cent limit price and every achievable fill price', async () => {
    let checked = 0;
    for (let c = 2; c <= 98; c++) {
      const maxPrice = c / 100;
      for (const amountUsd of [1, 1.24, 2.75, 5]) {
        const { q, band } = bandFor({ amountUsd, maxPrice });
        for (let f = 1; f <= c; f++) {
          const actual = Math.floor((q.amountUsd / (f / 100)) * 1e6) / 1e6;
          for (const wire of [actual, Math.round(actual * 1e6)]) {
            const got = await verifyFilledShares({ takingAmount: String(wire) }, band, unreachable);
            expect(got, `$${amountUsd} @<=${maxPrice}, filled @${f / 100}, wire ${wire}`).not.toBeNull();
            expect(got).toBeCloseTo(actual, 6);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(30_000);
  });
});

describe('INVARIANT: null means unknown, never a guess', () => {
  const { band } = bandFor({ amountUsd: 1.24, maxPrice: 0.27, minShares: 0 });

  it('does not accept a count below what the order could have received', async () => {
    // FOK does not partially fill, so 4.0 of 4.59 is a reading we do not understand.
    expect(await verifyFilledShares({ takingAmount: '4000000' }, band, async () => '4000000')).toBeNull();
  });

  it('does not accept a count above one-tick-per-share', async () => {
    expect(await verifyFilledShares({ takingAmount: '9999999999' }, band, async () => null)).toBeNull();
  });

  it('reports a zero or missing reading as unknown, not as zero', async () => {
    expect(await verifyFilledShares({ takingAmount: '0' }, band, async () => '0')).toBeNull();
    expect(await verifyFilledShares({}, band, async () => undefined)).toBeNull();
  });

  it('reports an unreachable venue as unknown', async () => {
    expect(await verifyFilledShares({ orderID: '0x1' }, band, async () => { throw new Error('ECONNRESET'); })).toBeNull();
  });
});

describe('INVARIANT: the fill path and the reconciler share one band', () => {
  it('re-exports the same functions rather than a copy', () => {
    expect(reconcile.shareBand).toBe(shareBand);
    expect(reconcile.resolveInBand).toBe(resolveInBand);
  });
});
