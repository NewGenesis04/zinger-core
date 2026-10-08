import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  DEFAULT_PARTICIPATION,
  LADDER_EXHAUST_TICKS,
  paperSellFill,
  planDepthEntry,
  planPartialExit,
  walkBook,
} from '../../src/polymarket/depthRealism.js';
import { getClobWsAggregate, upsertFromBook } from '../../src/polymarket/clobWs.js';

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/**
 * INVARIANT: a paper fill is something the book could have given (backlog 131).
 *
 * Paper used to book `sizeUsd / ask` shares whatever was resting, and sell at
 * the best ask or bid whatever the size. These tests pin the rules that replace
 * that: an entry takes at most a fraction of the resting best-ask size, an exit
 * is priced by walking the bids, and no leg is below the exchange minimum.
 * The 40% fraction is a modelling assumption; the tests pin the arithmetic, not
 * a claim about Polymarket.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const book = (ask: number, askSize: number) => ({ bestAsk: ask, bestAskSize: askSize, bestBid: ask - 0.01, bestBidSize: 50 });

describe('INVARIANT: an entry takes no more than the participation share of the resting ask', () => {
  it('never exceeds floor(askSize × participation), across the whole grid', () => {
    const rand = rng(1);
    for (let i = 0; i < 4000; i += 1) {
      const askSize = Math.round(rand() * 400 * 100) / 100;
      const requested = Math.round((0.5 + rand() * 300) * 1000) / 1000;
      const participation = rand() < 0.5 ? DEFAULT_PARTICIPATION : 0.1 + rand() * 0.8;
      const price = 0.4 + Math.round(rand() * 20) / 100;
      const plan = planDepthEntry({ requestedShares: requested, entryPrice: price, side: book(price, askSize), participation });
      if (plan.ok) {
        expect(plan.shares).toBeLessThanOrEqual(Math.floor(askSize * participation) + 1e-9);
        expect(plan.shares).toBeGreaterThanOrEqual(5);
        // Never above what was asked for, except the lift to the minimum.
        if (plan.shares > requested + 1e-9) expect(plan.shares).toBe(5);
      } else {
        expect(plan.shares).toBe(0);
      }
    }
  });

  it('skips a thin book: a resting ask under 13 shares cannot yield 5 at 40%', () => {
    for (const size of [0, 1, 5, 9.9, 12.4]) {
      const plan = planDepthEntry({ requestedShares: 20, entryPrice: 0.5, side: book(0.5, size) });
      expect(plan.ok, `ask size ${size}`).toBe(false);
    }
    const ok = planDepthEntry({ requestedShares: 20, entryPrice: 0.5, side: book(0.5, 12.5) });
    expect(ok.ok).toBe(true);
    expect(ok.shares).toBe(5);
  });

  it('caps a large ticket and records what capped it', () => {
    const plan = planDepthEntry({ requestedShares: 200, entryPrice: 0.5, side: book(0.5, 115) });
    expect(plan.ok).toBe(true);
    expect(plan.shares).toBe(46);
    expect(plan.record.cappedBy).toBe('participation');
  });

  it('lifts a sub-minimum budget to the minimum, as the live path does, unless that blows the cap', () => {
    const lifted = planDepthEntry({ requestedShares: 2, entryPrice: 0.5, side: book(0.5, 200) });
    expect(lifted.ok).toBe(true);
    expect(lifted.shares).toBe(5);
    expect(lifted.record.cappedBy).toBe('min_lift');
    const refused = planDepthEntry({ requestedShares: 2, entryPrice: 0.5, side: book(0.5, 200), maxCostUsd: 2 });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('min_order_exceeds_cap');
  });

  it('refuses an entry that is not at the best ask (a mid is not a price the book offers)', () => {
    const plan = planDepthEntry({ requestedShares: 20, entryPrice: 0.505, side: book(0.5, 200) });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('no_executable_ask');
    expect(planDepthEntry({ requestedShares: 20, entryPrice: 0.5, side: null }).ok).toBe(false);
  });
});

describe('INVARIANT: a paper exit is priced by walking the bids', () => {
  const bids = [
    { price: 0.5, size: 20 }, { price: 0.49, size: 30 }, { price: 0.48, size: 50 },
  ];
  const side = { bestBid: 0.5, bestBidSize: 20, bids };

  it('fills at the best bid when the book absorbs the order at the top', () => {
    expect(paperSellFill({ side, sellShares: 20, fallbackPrice: 0.55 }).price).toBe(0.5);
  });

  it('never fills above the best bid, for any size', () => {
    for (let n = 1; n <= 400; n += 3) {
      const fill = paperSellFill({ side, sellShares: n, fallbackPrice: 0.55 });
      expect(fill.price).toBeLessThanOrEqual(0.5);
    }
  });

  it('gets worse (never better) as the order grows', () => {
    let prev = Infinity;
    for (let n = 1; n <= 300; n += 1) {
      const px = paperSellFill({ side, sellShares: n, fallbackPrice: 0.55 }).price;
      expect(px).toBeLessThanOrEqual(prev + 1e-9);
      prev = px;
    }
  });

  it('is the volume-weighted price across the levels it touches', () => {
    const walk = walkBook(bids, 40, 'sell');
    expect(walk).not.toBeNull();
    // 20 @ 0.50 + 20 @ 0.49 = 19.8 over 40 shares
    expect(walk!.price).toBeCloseTo(0.495, 3);
    expect(walk!.levelsUsed).toBe(2);
    expect(walk!.exhausted).toBe(false);
  });

  it('flags size beyond the visible ladder and prices it below the worst level', () => {
    const walk = walkBook(bids, 200, 'sell');
    expect(walk!.exhausted).toBe(true);
    expect(walk!.worstPrice).toBeCloseTo(0.48 - LADDER_EXHAUST_TICKS * 0.01, 3);
  });

  it('without a book, books the fallback the caller already had', () => {
    const fill = paperSellFill({ side: null, sellShares: 10, fallbackPrice: 0.51 });
    expect(fill.price).toBe(0.51);
    expect(fill.record.book).toBe('none');
  });

  it('uses top-of-book size when no ladder is published', () => {
    const fill = paperSellFill({ side: { bestBid: 0.5, bestBidSize: 10 }, sellShares: 30, fallbackPrice: 0.5 });
    expect(fill.price).toBeLessThan(0.5);
  });
});

describe('INVARIANT: no exit leg is under the exchange minimum', () => {
  it('neither the sale nor the remainder is under 5 shares, for any position and fraction', () => {
    const rand = rng(9);
    for (let i = 0; i < 5000; i += 1) {
      const held = Math.round(rand() * 300 * 1000) / 1000;
      const pct = 0.1 + rand() * 0.8;
      const plan = planPartialExit({ held, partialPct: pct, minShares: 5 });
      if (plan.skip) {
        expect(held).toBeLessThan(10);
      } else {
        expect(plan.sell).toBeGreaterThanOrEqual(5);
        expect(plan.remaining).toBeGreaterThanOrEqual(5);
        expect(plan.sell + plan.remaining).toBeCloseTo(held, 3);
      }
    }
  });

  it('takes the configured fraction when that already satisfies both minimums', () => {
    const plan = planPartialExit({ held: 100, partialPct: 0.4, minShares: 5 });
    expect(plan).toEqual({ skip: false, sell: 40, remaining: 60 });
  });

  it('skips a position under two minimums rather than leaving unsellable dust', () => {
    expect(planPartialExit({ held: 9.9, partialPct: 0.5, minShares: 5 }).skip).toBe(true);
    expect(planPartialExit({ held: 10, partialPct: 0.5, minShares: 5 }).skip).toBe(false);
  });
});

describe('INVARIANT: the socket publishes the ladder the exit walk needs', () => {
  it('getClobWsAggregate carries bid and ask ladders, best first, with the same top of book', () => {
    upsertFromBook('tok-depth-1',
      [{ price: '0.48', size: '30' }, { price: '0.50', size: '20' }, { price: '0.49', size: '10' }],
      [{ price: '0.53', size: '5' }, { price: '0.51', size: '40' }],
      Date.now());
    const agg: any = getClobWsAggregate('tok-depth-1');
    expect(agg.bids.map((l: any) => l.price)).toEqual([0.5, 0.49, 0.48]);
    expect(agg.asks.map((l: any) => l.price)).toEqual([0.51, 0.53]);
    expect(agg.bids[0].size).toBe(20);
  });
});

describe('INVARIANT: bot.ts routes every paper entry and exit through these rules', () => {
  const src = repoFile('src/polymarket/bot.ts');

  it('sizes the paper entry with planDepthEntry before the plan is built', () => {
    expect(src).toMatch(/planDepthEntry\(/);
    expect(src.indexOf('planDepthEntry(')).toBeLessThan(src.indexOf('const plan = buildTradePlan('));
  });

  it('prices every paper stop and take-profit through paperSellFill (fast-SL, early-SL, closePosition)', () => {
    const calls = src.match(/paperSellFill\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('sizes a partial exit with planPartialExit and does not assume the sold fraction', () => {
    expect(src).toMatch(/planPartialExit\(/);
    expect(src).not.toMatch(/pos\.shares = positionShares\(pos\) \* \(1 - \(pos\.partialPct/);
  });
});
