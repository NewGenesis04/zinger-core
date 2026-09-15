// @ts-nocheck
/**
 * INVARIANT: the share count the depth gate computed is the share count the
 * venue receives (item 78), and the diagnosis of a failed leg survives into the
 * record (item 79).
 *
 * The failure being fixed: the sizing gate computes a SHARE count against a
 * SHARE depth ceiling, then the order is submitted as a DOLLAR amount and the
 * SDK derives shares back out of it —
 *
 *     getMarketOrderRawAmounts.js:  rawMakerAmt = roundDown(amount, 2)
 *                                   rawTakerAmt = rawMakerAmt / rawPrice
 *
 * Across the 21 live canary packages, 14 demanded MORE shares than planned
 * (worst +0.0950). A depth-bound fill-or-kill that demands more than the level
 * holds cannot fill. The limit builder inverts the derivation —
 *
 *     getOrderRawAmounts.js:        rawTakerAmt = roundDown(size, 2)
 *                                   rawMakerAmt = rawTakerAmt * rawPrice
 *
 * — so the gate's number reaches the book. Both quoted from the vendored SDK.
 */
import { describe, it, expect } from 'vitest';
import { venueShareCount, VENUE_SHARE_DECIMALS } from '../../src/polymarket/trade.js';

/** What the CURRENT dollar route actually demands, per the SDK's own arithmetic. */
function marketRouteShares(plannedShares, price) {
  const cost = Math.round(plannedShares * price * 100) / 100;   // arbEngine.ts:276
  const amount = Math.floor(cost * 100) / 100;                  // roundDown(amount, 2)
  return amount / price;                                        // rawMakerAmt / rawPrice
}

describe('INVARIANT: the dollar round trip does not preserve the share count', () => {
  it('reproduces the excess that killed depth-bound legs', () => {
    // 2026-09-11 06:27 BTC, straight from docs/live_canary_packages.json.
    const demanded = marketRouteShares(4.500, 0.59);
    expect(demanded).toBeGreaterThan(4.500);
    expect(demanded - 4.500).toBeCloseTo(0.0085, 4);

    // If that package was depth-bound at 4.500, the book was 0.0085 short and
    // the FOK had to die. Exact-share routing asks for 4.50 and no more.
    expect(venueShareCount(4.500, 0.59).shares).toBe(4.5);
    expect(venueShareCount(4.500, 0.59).shares).toBeLessThanOrEqual(4.500);
  });

  it('never demands more than the gate cleared, across the live price range', () => {
    // The property the whole item rests on. Rounding DOWN is what makes a
    // depth-bound order safe; the old route rounded the dollars and let the
    // share count land wherever it fell.
    let marketOverAsks = 0;
    for (const shares of [1.234, 4.5, 4.581, 5.263, 5.319, 26.59, 100.007]) {
      for (let cents = 2; cents <= 98; cents++) {
        const price = cents / 100;
        const routed = venueShareCount(shares, price);
        if (routed.direction === 'down') {
          expect(routed.shares).toBeLessThanOrEqual(shares + 1e-9);
        }
        if (marketRouteShares(shares, price) > shares + 1e-9) marketOverAsks++;
      }
    }
    // Sanity: the old route really does over-ask across this range, so the
    // property above is not vacuous.
    expect(marketOverAsks).toBeGreaterThan(0);
  });
});

describe('INVARIANT: the venue only understands two decimals of size', () => {
  it('states the resolution the SDK actually applies', () => {
    // ROUNDING_CONFIG[tick].size === 2 for EVERY tick size in the vendored SDK,
    // and both amount builders roundDown to it. A third decimal is discarded.
    expect(VENUE_SHARE_DECIMALS).toBe(2);
    expect(venueShareCount(4.587, 0.27).shares).toBe(4.58);
    expect(venueShareCount(5.2571, 0.35).shares).toBe(5.25);
  });

  it('rounds UP instead when truncating would breach the $1.00 minimum', () => {
    // Truncation is safe against depth and UNSAFE against the marketable-BUY
    // floor, which is a hard rejection — the 2026-09-09 receipts read
    // "invalid amount for a marketable BUY order ($0.38), min size: 1".
    // At $0.21, $1.00 needs 4.7619 shares: 4.76 clears, 4.75 does not.
    const tight = venueShareCount(4.762, 0.21);
    expect(tight.notionalUsd).toBeGreaterThanOrEqual(1);

    // A case where truncation genuinely breaches, so the up-branch is exercised.
    const breach = venueShareCount(4.7615, 0.21);
    expect(breach.direction).toBe('up');
    expect(breach.notionalUsd).toBeGreaterThanOrEqual(1);
  });

  it('keeps every routed order above the $1.00 floor', () => {
    // The floor is a venue rejection, not a maybe-kill, so it wins over the
    // depth preference. Swept across the live price range.
    for (let cents = 2; cents <= 98; cents++) {
      const price = cents / 100;
      const atFloor = 1 / price;
      const routed = venueShareCount(atFloor, price);
      expect(routed.notionalUsd).toBeGreaterThanOrEqual(1);
    }
  });

  it('refuses a size or price that cannot produce an order', () => {
    expect(venueShareCount(0, 0.5)).toBeNull();
    expect(venueShareCount(5, 0)).toBeNull();
    expect(venueShareCount(NaN, 0.5)).toBeNull();
  });
});
