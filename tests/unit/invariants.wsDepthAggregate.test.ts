// @ts-nocheck
/**
 * Item 41. The WS branch of `getDepthForMarket` used to return top of book only,
 * so `imbalance` was missing whenever the socket served — the common case — and
 * both consumers (`directional.ts` order-book bias, `alphaFusion.ts` ORDER_FLOW)
 * read the gap as 0. The order-book vote was silent exactly when the data was
 * freshest.
 *
 * The property that matters: **the socket path and the REST path give the same
 * depth answer for the same ladder.** Both are built by `bookDepth.ts`, and this
 * suite is what stops them drifting apart again.
 */
import { describe, it, expect } from 'vitest';
import { normalizeLevels, getDepthForMarket } from '../../src/polymarket/clob.js';
import { upsertFromBook, applyPriceChange, getClobWsAggregate } from '../../src/polymarket/clobWs.js';
import { normalizeSide, summarizeBook } from '../../src/polymarket/bookDepth.js';

const AGG_KEYS = ['imbalance', 'spreadPct', 'totalBidVol', 'totalAskVol', 'bidCount', 'askCount'];

/** Deterministic ladder generator: tick-aligned prices, mixed sizes, both sides. */
function ladder(seed, bidLevels, askLevels) {
  let x = seed;
  const rnd = () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const bids = [];
  const asks = [];
  for (let i = 0; i < bidLevels; i++) bids.push({ price: (0.49 - i * 0.01).toFixed(2), size: (1 + Math.floor(rnd() * 400)).toString() });
  for (let i = 0; i < askLevels; i++) asks.push({ price: (0.51 + i * 0.01).toFixed(2), size: (1 + Math.floor(rnd() * 400)).toString() });
  return { bids, asks };
}

const seedWs = (id, { bids, asks }) => upsertFromBook(id, bids, asks, Date.now());
const pick = (o) => Object.fromEntries(AGG_KEYS.map((k) => [k, o[k]]));

describe('INVARIANT: the WS aggregate equals the REST aggregate for the same ladder (item 41)', () => {
  it('holds across ladders of different depth, including more than ten levels', () => {
    let n = 0;
    for (const [bl, al] of [[1, 1], [3, 5], [10, 10], [12, 25], [40, 2], [2, 40]]) {
      for (const seed of [1, 7, 42, 1234]) {
        const book = ladder(seed, bl, al);
        const id = `eq-${n++}`;
        seedWs(id, book);
        const ws = getClobWsAggregate(id);
        const rest = normalizeLevels(book);
        expect(pick(ws)).toEqual(pick(rest));
      }
    }
  });

  it('sums only the top ten levels per side', () => {
    const book = ladder(5, 15, 15);
    seedWs('cap', book);
    const ws = getClobWsAggregate('cap');
    expect(ws.bidCount).toBe(10);
    expect(ws.askCount).toBe(10);
    const topTen = (rows, side) => normalizeSide(rows, side, 10).reduce((s, r) => s + r.value, 0);
    expect(ws.totalBidVol).toBeCloseTo(topTen(book.bids, 'bid'), 9);
    expect(ws.totalAskVol).toBeCloseTo(topTen(book.asks, 'ask'), 9);
  });

  it('stays in [-1, 1] and leans the way the resting money leans', () => {
    seedWs('heavy-bid', { bids: [{ price: '0.49', size: '1000' }], asks: [{ price: '0.51', size: '10' }] });
    seedWs('heavy-ask', { bids: [{ price: '0.49', size: '10' }], asks: [{ price: '0.51', size: '1000' }] });
    const b = getClobWsAggregate('heavy-bid').imbalance;
    const a = getClobWsAggregate('heavy-ask').imbalance;
    expect(b).toBeGreaterThan(0.9);
    expect(a).toBeLessThan(-0.9);
    expect(b).toBeLessThanOrEqual(1);
    expect(a).toBeGreaterThanOrEqual(-1);
  });

  it('follows a delta: removing the top ask changes the aggregate', () => {
    seedWs('delta', { bids: [{ price: '0.40', size: '100' }], asks: [{ price: '0.42', size: '500' }, { price: '0.60', size: '10' }] });
    const before = getClobWsAggregate('delta');
    applyPriceChange({ asset_id: 'delta', price: '0.42', size: '0', side: 'SELL' }, Date.now());
    const after = getClobWsAggregate('delta');
    expect(after.askCount).toBe(before.askCount - 1);
    expect(after.imbalance).toBeGreaterThan(before.imbalance);
  });

  it('ignores zero-size levels', () => {
    seedWs('zero', { bids: [{ price: '0.40', size: '100' }, { price: '0.39', size: '0' }], asks: [{ price: '0.42', size: '100' }] });
    expect(getClobWsAggregate('zero').bidCount).toBe(1);
  });
});

describe('INVARIANT: a missing or one-sided book never yields NaN or a fabricated balance (item 41)', () => {
  it('returns null for a token the socket has never seen', () => {
    expect(getClobWsAggregate('never-seen')).toBeNull();
  });

  it('returns null when both sides are empty', () => {
    seedWs('empty', { bids: [], asks: [] });
    expect(getClobWsAggregate('empty')).toBeNull();
  });

  it('is finite on a one-sided book', () => {
    seedWs('one-sided', { bids: [{ price: '0.40', size: '100' }], asks: [] });
    const a = getClobWsAggregate('one-sided');
    for (const k of AGG_KEYS) expect(Number.isFinite(a[k])).toBe(true);
    expect(a.imbalance).toBe(1);
  });

  it('summarizeBook of two empty ladders is a finite zero', () => {
    const s = summarizeBook([], []);
    for (const k of AGG_KEYS) expect(Number.isFinite(s[k])).toBe(true);
    expect(s.imbalance).toBe(0);
  });
});

describe('INVARIANT: a fresh socket book reaches the consumers with an imbalance (item 41)', () => {
  it('getDepthForMarket serves clob-ws WITH imbalance and spreadPct', async () => {
    const heavyBids = { bids: [{ price: '0.48', size: '900' }, { price: '0.47', size: '900' }], asks: [{ price: '0.52', size: '50' }] };
    const other = { bids: [{ price: '0.48', size: '50' }], asks: [{ price: '0.52', size: '900' }] };
    seedWs('mkt-up', heavyBids);
    seedWs('mkt-down', other);
    const depth = await getDepthForMarket({ tokenIds: { up: 'mkt-up', down: 'mkt-down' } });
    expect(depth.up.source).toBe('clob-ws');
    expect(depth.up.imbalance).toBeGreaterThan(0.5);
    expect(depth.down.imbalance).toBeLessThan(-0.5);
    expect(depth.up.spreadPct).toBeGreaterThan(0);
    // top-of-book fields are unchanged by the aggregate
    expect(depth.up.bestBid).toBe(0.48);
    expect(depth.up.bestAsk).toBe(0.52);
  });
});
