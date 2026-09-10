// @ts-nocheck
/**
 * Invariants for the CLOB WebSocket book maintainer.
 *
 * This module is the price source for every live arb leg: `arbEngine.ts:54`
 * reads `depth.up.bestAsk`, which `clob.ts:171-180` copies straight out of
 * `getClobWsBook`. An order is then signed with `maxPrice` set to exactly that
 * number (`bot.ts:1011`), so a wrong `bestAsk` is not a cosmetic display bug —
 * it is the limit price of a real fill-or-kill order against real money.
 *
 * The invariant under test is the only one that matters here:
 *
 *   bestAsk is the lowest ask price that currently has resting size,
 *   and bestBid is the highest bid price that currently has resting size.
 *
 * Written against the 2026-09-09 live run, in which every arb leg was rejected
 * ("order couldn't be fully filled") while a REST read of the same book showed
 * 1,386 shares resting — i.e. the book was deep and the price the bot signed
 * was not on it.
 */
import { describe, it, expect } from 'vitest';
import { upsertFromBook, applyPriceChange, getClobWsBook } from '../../src/polymarket/clobWs.js';

const TOK = 'test-token-1';

function seed(tokenId, bids, asks) {
  upsertFromBook(tokenId, bids, asks, Date.now());
}

describe('clobWs book maintainer', () => {
  it('takes best bid/ask from a full snapshot', () => {
    seed(TOK, [{ price: '0.40', size: '10' }, { price: '0.38', size: '5' }],
              [{ price: '0.42', size: '10' }, { price: '0.55', size: '5' }]);
    const b = getClobWsBook(TOK);
    expect(b.bestBid).toBe(0.4);
    expect(b.bestAsk).toBe(0.42);
  });

  it('falls back to the next resting ask when the top level is consumed', () => {
    // Two ask levels rest on the book.
    seed('t-consume', [{ price: '0.10', size: '100' }],
                      [{ price: '0.20', size: '100' }, { price: '0.90', size: '100' }]);
    expect(getClobWsBook('t-consume').bestAsk).toBe(0.2);

    // The 0.20 level is taken out. 0.90 is still resting, so that is the book.
    applyPriceChange({ asset_id: 't-consume', price: '0.20', size: '0', side: 'SELL' }, Date.now());

    expect(getClobWsBook('t-consume').bestAsk).toBe(0.9);
  });

  it('does not report an ask price that has no resting size', () => {
    seed('t-phantom', [{ price: '0.10', size: '100' }],
                      [{ price: '0.20', size: '100' }, { price: '0.90', size: '100' }]);
    applyPriceChange({ asset_id: 't-phantom', price: '0.20', size: '0', side: 'SELL' }, Date.now());

    const b = getClobWsBook('t-phantom');
    // Whatever it reports, it must never be the level that was just removed —
    // that number becomes the limit price of a live FOK order.
    expect(b.bestAsk).not.toBe(0.2);
    // ...and it must be a usable price, not null. A null here is coerced to 0 by
    // `clob.ts:174`, and `arbEngine.ts:54` then substitutes `prices.up` — a MID —
    // into a variable named `upAsk`.
    expect(b.bestAsk).toBeGreaterThan(0);
  });

  it('re-quoting above the removed level is reflected, not ignored', () => {
    seed('t-requote', [{ price: '0.10', size: '100' }], [{ price: '0.04', size: '5' }]);
    expect(getClobWsBook('t-requote').bestAsk).toBe(0.04);

    // The 4c level is lifted, and the next seller quotes 0.97.
    applyPriceChange({ asset_id: 't-requote', price: '0.04', size: '0', side: 'SELL' }, Date.now());
    applyPriceChange({ asset_id: 't-requote', price: '0.97', size: '1386', side: 'SELL' }, Date.now());

    expect(getClobWsBook('t-requote').bestAsk).toBe(0.97);
  });

  it('ignores zero-size rows carried in a snapshot', () => {
    // A book snapshot may carry a level with size 0. The delta path deletes
    // those keys outright, so this is the only route by which a zero-size level
    // reaches `bestOf` — and reporting it would put a price with nothing behind
    // it into a live order's maxPrice.
    seed('t-zero', [{ price: '0.10', size: '100' }],
                   [{ price: '0.20', size: '0' }, { price: '0.60', size: '75' }]);
    expect(getClobWsBook('t-zero').bestAsk).toBe(0.6);
  });

  it('a worse ask does not overwrite a better resting one', () => {
    seed('t-worse', [{ price: '0.10', size: '100' }], [{ price: '0.30', size: '50' }]);
    applyPriceChange({ asset_id: 't-worse', price: '0.80', size: '10', side: 'SELL' }, Date.now());
    // 0.30 still rests, so it is still the best ask.
    expect(getClobWsBook('t-worse').bestAsk).toBe(0.3);
  });
});
