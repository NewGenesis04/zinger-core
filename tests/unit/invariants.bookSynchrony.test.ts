// @ts-nocheck
/**
 * INVARIANT: the two sides of a binary are read at the same instant.
 *
 * The two tokens of a Polymarket binary share one order book (domain facts
 * §11): `UP.bid(p)` and `DOWN.ask(1−p)` are the same resting orders, so a
 * synchronised read always satisfies `ask_up + ask_down = 1 + spread` and can
 * never show the sub-$1.00 pair the arb gate looks for.
 *
 * `getDepthForMarket` used to fetch the REST books in an await-in-loop, which
 * put hundreds of milliseconds between them. That delay alone manufactures an
 * apparent gap — 143/143 ladder levels match when the books are read in
 * parallel, 0/5 at ~0.4s of skew. The arb engine fired on the artifact, and
 * the directional path inherited the same skew through its order-book bias
 * (`bot.ts:3073`).
 *
 * Nothing about the code's *shape* forces the two reads to overlap. Someone
 * tidying the `Promise.all` back into a loop would restore the original defect
 * with every other test still green, which is why concurrency is asserted
 * directly here rather than inferred from the returned values.
 *
 * These are properties, not a snapshot: adding a third outcome or changing the
 * book shape does not edit an expectation, but serialising the reads or
 * per-call timestamping fails.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const wsBooks = new Map();
vi.mock('../../src/polymarket/clobWs.js', () => ({
  getClobWsBook: (id) => wsBooks.get(String(id)) ?? null,
  getClobWsMid: () => null,
  getClobWsAggregate: () => null,
}));

const { getDepthForMarket } = await import('../../src/polymarket/clob.js');

const MARKET = { tokenIds: { up: 'TOK_UP', down: 'TOK_DOWN' } };
const book = (bid, ask) => ({
  bids: [{ price: String(bid), size: '100' }],
  asks: [{ price: String(ask), size: '100' }],
});

/** Records when each request starts and finishes, and holds each open `delayMs`. */
function stubFetch({ delayMs = 50, fail = [] } = {}) {
  const calls = [];
  vi.stubGlobal('fetch', (url) => {
    const token = String(url).includes('TOK_UP') ? 'up' : 'down';
    const rec = { token, start: Date.now(), end: null };
    calls.push(rec);
    return new Promise((resolve) => {
      setTimeout(() => {
        rec.end = Date.now();
        if (fail.includes(token)) { resolve({ ok: false, json: async () => ({}) }); return; }
        // UP at 0.52 / DOWN at 0.49 — a coherent pair summing to 1.01.
        resolve({ ok: true, json: async () => (token === 'up' ? book(0.51, 0.52) : book(0.48, 0.49)) });
      }, delayMs);
    });
  });
  return calls;
}

beforeEach(() => {
  wsBooks.clear();
  vi.unstubAllGlobals();
});

describe('getDepthForMarket reads both sides of a binary together', () => {
  it('overlaps the REST reads instead of serialising them', async () => {
    const calls = stubFetch({ delayMs: 60 });
    await getDepthForMarket(MARKET);

    expect(calls).toHaveLength(2);
    const [first, second] = calls.sort((a, b) => a.start - b.start);
    // The defect: the second request only begins once the first has returned.
    expect(second.start).toBeLessThan(first.end);
  });

  it('stamps both REST books with one identical bookTs', async () => {
    stubFetch({ delayMs: 40 });
    const depth = await getDepthForMarket(MARKET);

    expect(depth.up.bookTs).toBeDefined();
    // Not "close enough": they were one concurrent batch, and the skew bound
    // at `arbEngine.ts:261` is only meaningful if that is recorded exactly.
    expect(depth.down.bookTs).toBe(depth.up.bookTs);
  });

  it('labels a REST book as such, so a missing book is distinguishable', async () => {
    stubFetch();
    const depth = await getDepthForMarket(MARKET);

    // Previously the REST branch set no `source`, so `leg.bookSource` recorded
    // `null` for both "REST" and "no book at all".
    expect(depth.up.source).toBe('clob-rest');
    expect(depth.down.source).toBe('clob-rest');
  });

  it('returns the side that succeeded when the other fails', async () => {
    stubFetch({ fail: ['down'] });
    const depth = await getDepthForMarket(MARKET);

    expect(depth.up?.bestAsk).toBe(0.52);
    expect(depth.down).toBeUndefined();
  });

  it('keeps a live WS book and only fetches the side that needs REST', async () => {
    wsBooks.set('TOK_UP', {
      bestBid: 0.51, bestAsk: 0.52, bestBidSize: 10, bestAskSize: 10, mid: 0.515, ts: 1_000, stale: false,
    });
    const calls = stubFetch();
    const depth = await getDepthForMarket(MARKET);

    expect(calls.map((c) => c.token)).toEqual(['down']);
    expect(depth.up.source).toBe('clob-ws');
    expect(depth.up.bookTs).toBe(1_000);
    expect(depth.down.source).toBe('clob-rest');
  });
});
