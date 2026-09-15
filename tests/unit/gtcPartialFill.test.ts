// @ts-nocheck
/**
 * INVARIANT: a partially-filled GTC order is booked at what it filled (item 85).
 *
 * The defect: `readGtcFill` resolved the wire scale against a SYMMETRIC band —
 * `|c − want| ≤ max(0.05, want × 2%)`. A GTC limit order can legitimately fill
 * for less than it asked for, so anything more than 2% short failed to resolve,
 * returned null, and `bot.ts` then booked `orderResult.size` — the REQUESTED
 * amount. A 50%-filled entry was recorded as 100% filled, and equity, realised
 * P/L and Kelly sizing all read the inflated number.
 *
 * This is the third member of a family, and the three answers are different —
 * which is why the fix could not be copied from item 81:
 *
 *   market FOK (dollars in)  fill can only be LARGER  → band one-sided up
 *   limit FOK (shares in)    fill is 0 or exact       → symmetric is correct
 *   GTC limit                fill can only be SMALLER → band one-sided down
 *
 * The second property here is the one that keeps the fix honest: widening the
 * band downward would also admit any small number that happens to land in
 * range, so a partial must corroborate itself with an implied price the limit
 * could actually have produced.
 */
import { describe, it, expect } from 'vitest';
import { readGtcFill } from '../../src/polymarket/trade.js';

/** Wire amounts are `parseUnits(…, 6)`. */
const wire = (n) => String(Math.round(n * 1e6));

/** A BUY receipt: `makingAmount` = USDC paid, `takingAmount` = shares received. */
const buy = (shares, price) => ({
  orderID: '0x1',
  makingAmount: wire(shares * price),
  takingAmount: wire(shares),
  tradeIDs: ['t1'],
});

describe('INVARIANT: a partial fill resolves to what actually filled', () => {
  it('books 13 of 26 as 13, not as 26', () => {
    // The headline case. Under the symmetric band this returned null and the
    // caller booked 26.
    const fill = readGtcFill(buy(13, 0.5), 'buy', 26, 0.5);

    expect(fill.filledShares).toBeCloseTo(13, 3);
    expect(fill.partial).toBe(true);
    expect(fill.requestedShares).toBe(26);
    expect(fill.resting).toBe(false);
  });

  it('resolves partials across the whole range, not just near-misses', () => {
    for (const filled of [0.5, 1, 5, 13, 20, 25.9]) {
      const fill = readGtcFill(buy(filled, 0.4), 'buy', 26, 0.4);
      expect(fill.filledShares, `${filled} of 26`).toBeCloseTo(filled, 3);
    }
  });

  it('still resolves a full fill, and does not call it partial', () => {
    const fill = readGtcFill(buy(26, 0.33), 'buy', 26, 0.33);
    expect(fill.filledShares).toBeCloseTo(26, 3);
    expect(fill.partial).toBe(false);
  });

  it('handles the sell side, where the share leg is makingAmount', () => {
    const sell = {
      orderID: '0x1',
      makingAmount: wire(9),        // shares given up
      takingAmount: wire(9 * 0.62), // collateral received
      tradeIDs: ['t1'],
    };
    const fill = readGtcFill(sell, 'sell', 26, 0.62);
    expect(fill.filledShares).toBeCloseTo(9, 3);
    expect(fill.partial).toBe(true);
  });
});

describe('INVARIANT: a partial must be corroborated, not merely small', () => {
  it('refuses a reading whose implied price the limit could not have produced', () => {
    // A BUY cannot pay more than its own ceiling. An implied price above the
    // limit means the reading is not understood — and an unresolved fill is the
    // honest answer, not a plausible-looking small number.
    const impossible = { orderID: '0x1', makingAmount: wire(13 * 0.90), takingAmount: wire(13), tradeIDs: ['t1'] };
    const fill = readGtcFill(impossible, 'buy', 26, 0.30);

    expect(fill.filledShares).toBeNull();
    expect(fill.fillSource).toBe('matched-unverified');
  });

  it('refuses a partial when no price is available to check it against', () => {
    // Without a limit there is nothing to corroborate against, so the claim
    // stands on its own — which is exactly what it may not do.
    const fill = readGtcFill(buy(13, 0.5), 'buy', 26, null);
    expect(fill.filledShares).toBeNull();
  });

  it('keeps refusing the degenerate receipt that started this', () => {
    // invariants.fillAccounting.test.ts:127. makingAmount 1 / takingAmount 2
    // against a 26-share request is garbage, and a downward band must not turn
    // it into "2 shares filled".
    const fill = readGtcFill({ orderID: '0x1', makingAmount: '1', takingAmount: '2', tradeIDs: ['t1'] }, 'buy', 26);
    expect(fill.filledShares).toBeNull();
    expect(fill.fillSource).toBe('matched-unverified');
  });

  it('never resolves above what was requested', () => {
    // A GTC order cannot overfill. A reading larger than the request is a scale
    // error or a misread, never a fill.
    const over = { orderID: '0x1', makingAmount: wire(40 * 0.5), takingAmount: wire(40), tradeIDs: ['t1'] };
    const fill = readGtcFill(over, 'buy', 26, 0.5);
    expect(fill.filledShares).toBeNull();
  });

  it('rejects a quantity below what the venue can express', () => {
    // ROUNDING_CONFIG[tick].size is 2 for every tick, so a sub-0.01 reading is
    // the other scale, not a fill (item 83). Here neither candidate is usable:
    // 5000 is far above a 26-share request, and 5000/1e6 = 0.005 is below
    // anything the venue can represent.
    const fill = readGtcFill({ orderID: '0x1', makingAmount: '2500', takingAmount: '5000', tradeIDs: ['t1'] }, 'buy', 26, 0.5);
    expect(fill.filledShares).toBeNull();
  });

  it('resolves a small but representable partial', () => {
    // The counterpart to the case above, and the reason the floor is 0.01 and
    // not something rounder: 6 shares of a 26-share request at exactly the
    // limit price is an ordinary partial fill and must resolve.
    const fill = readGtcFill({ orderID: '0x1', makingAmount: '3', takingAmount: '6', tradeIDs: ['t1'] }, 'buy', 26, 0.5);
    expect(fill.filledShares).toBeCloseTo(6, 6);
    expect(fill.partial).toBe(true);
  });
});

describe('INVARIANT: an ambiguous scale is unresolved, not guessed', () => {
  it('refuses when both scale candidates land in the band', () => {
    // Found by mutation: `fits.length === 1` could be relaxed to "take the
    // first" and every other test still passed, because ambiguity is
    // unreachable at ordinary sizes — the two candidates differ by 1e6, so both
    // only fit once the request exceeds ~9,800 shares.
    //
    // At that size it is reachable, and the two readings are 15,000 shares
    // versus 0.015 shares. Picking the first would book a million-fold error.
    const big = { orderID: '0x1', makingAmount: '750', takingAmount: '15000', tradeIDs: ['t1'] };
    const fill = readGtcFill(big, 'buy', 20_000, 0.05);

    expect(fill.filledShares).toBeNull();
    expect(fill.fillSource).toBe('matched-unverified');
  });

  it('still resolves a large order whose scale is unambiguous', () => {
    // The counterpart: the guard must refuse ambiguity, not refuse size.
    const fill = readGtcFill(buy(15_000, 0.05), 'buy', 20_000, 0.05);
    expect(fill.filledShares).toBeCloseTo(15_000, 3);
    expect(fill.partial).toBe(true);
  });
});

describe('INVARIANT: resting is still distinguished from filled', () => {
  it('reports a resting order as zero, not as unresolved', () => {
    const fill = readGtcFill({ orderID: '0x1', makingAmount: '0', takingAmount: '0', tradeIDs: [] }, 'buy', 26, 0.5);
    expect(fill.resting).toBe(true);
    expect(fill.filledShares).toBe(0);
  });
});
