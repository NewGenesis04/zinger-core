// @ts-nocheck
/**
 * The alpha fusion takes ONE order book per symbol, but a pass scans several
 * windows of a symbol. Which window's book stands for the symbol used to be
 * whichever the scan loop reached last — an accident of `findMarkets` ordering.
 *
 * Property: the pick is a function of the set of markets, not of the order they
 * are offered in, and it follows the documented rule (live window, accepting
 * orders, shortest window, slug).
 */
import { describe, it, expect } from 'vitest';
import { offerFusionBook } from '../../src/polymarket/scan/fusionBook.js';

const depthOf = (imbalance) => ({ up: { bestBid: 0.48, bestAsk: 0.52, mid: 0.5, spread: 0.04, spreadPct: 8, imbalance, source: 'clob-ws' } });
const mk = (symbol, slug, windowSeconds, over = {}) => ({ symbol, slug, windowSeconds, isCurrent: true, acceptingOrders: true, ...over });

/** Offer markets in the given order to a fresh pass; return the picked slug per symbol. */
function pickIn(order) {
  const picked = {};
  const chosen = {};
  for (const m of order) {
    const offer = offerFusionBook(picked, m, depthOf(m.imb ?? 0.1), 1000);
    if (offer) chosen[offer.sym] = offer.book.slug;
  }
  return chosen;
}

function permutations(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe('INVARIANT: the fusion book for a symbol does not depend on scan order', () => {
  const markets = [
    mk('BTC', 'btc-5m-now', 300),
    mk('BTC', 'btc-15m-now', 900),
    mk('BTC', 'btc-4h-now', 14400),
    mk('BTC', 'btc-5m-next', 300, { isCurrent: false }),
    mk('ETH', 'eth-15m-now', 900),
    mk('ETH', 'eth-5m-now', 300),
  ];

  it('gives the same pick for every ordering', () => {
    const expected = { btc: 'btc-5m-now', eth: 'eth-5m-now' };
    let n = 0;
    for (const order of permutations(markets)) {
      expect(pickIn(order), `order ${order.map((m) => m.slug).join(',')}`).toEqual(expected);
      n++;
    }
    expect(n).toBe(720);
  });

  it('prefers a live window over an upcoming one even when the upcoming one is shorter', () => {
    const order = [mk('BTC', 'btc-5m-next', 300, { isCurrent: false }), mk('BTC', 'btc-4h-now', 14400)];
    expect(pickIn(order).btc).toBe('btc-4h-now');
    expect(pickIn([...order].reverse()).btc).toBe('btc-4h-now');
  });

  it('prefers a market accepting orders over one that is not, at equal liveness', () => {
    const order = [mk('BTC', 'btc-5m-closed', 300, { acceptingOrders: false }), mk('BTC', 'btc-15m-open', 900)];
    expect(pickIn(order).btc).toBe('btc-15m-open');
    expect(pickIn([...order].reverse()).btc).toBe('btc-15m-open');
  });

  it('breaks an exact tie by slug, the same way in either order', () => {
    const a = mk('ETH', 'eth-a', 300);
    const b = mk('ETH', 'eth-b', 300);
    expect(pickIn([a, b]).eth).toBe('eth-a');
    expect(pickIn([b, a]).eth).toBe('eth-a');
  });

  it('a market with a missing window length ranks after one with a known length', () => {
    const order = [mk('BTC', 'btc-unknown', undefined), mk('BTC', 'btc-4h', 14400)];
    expect(pickIn(order).btc).toBe('btc-4h');
    expect(pickIn([...order].reverse()).btc).toBe('btc-4h');
  });
});

describe('fusion book — what is and is not offered', () => {
  it('ignores a market with no depth and never lets it displace a held book', () => {
    const picked = {};
    expect(offerFusionBook(picked, mk('BTC', 'btc-4h', 14400), depthOf(0.2), 1)).not.toBeNull();
    expect(offerFusionBook(picked, mk('BTC', 'btc-5m', 300), null, 2)).toBeNull();
    expect(picked.btc.book.slug).toBe('btc-4h');
  });

  it('ignores symbols the fusion does not cover', () => {
    expect(offerFusionBook({}, mk('SOL', 'sol-5m', 300), depthOf(0.2), 1)).toBeNull();
  });

  it('keeps symbols independent', () => {
    const picked = {};
    offerFusionBook(picked, mk('BTC', 'btc-5m', 300), depthOf(0.3), 1);
    offerFusionBook(picked, mk('ETH', 'eth-4h', 14400), depthOf(-0.3), 1);
    expect(picked.btc.book.slug).toBe('btc-5m');
    expect(picked.eth.book.slug).toBe('eth-4h');
  });

  it('carries the market it came from, and leaves a missing imbalance null rather than 0', () => {
    const picked = {};
    const { book } = offerFusionBook(picked, mk('BTC', 'btc-5m', 300), depthOf(undefined), 5);
    expect(book.imbalance).toBeNull();
    expect(book.slug).toBe('btc-5m');
    expect(book.windowSeconds).toBe(300);
    expect(book.at).toBe(5);
  });

  it('a fresh pass starts empty, so nothing carries over between passes', () => {
    expect(pickIn([mk('BTC', 'btc-4h', 14400)]).btc).toBe('btc-4h');
    expect(pickIn([mk('BTC', 'btc-15m', 900)]).btc).toBe('btc-15m');
  });
});
