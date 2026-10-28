import { describe, expect, it } from 'vitest';
import { levelScore, markouts, midAfter, rewardShare } from '../../src/research/mm/live/evaluation.js';

describe('MM dry-run evaluation', () => {
  const book = { bids: [{ price: 0.48, size: 100 }], asks: [{ price: 0.52, size: 100 }] };
  it('scores inside the band only and applies the one-sided third', () => {
    expect(levelScore(0.5, 10, 0.5, 0.03)).toBe(10);
    expect(levelScore(0.46, 10, 0.5, 0.03)).toBe(0);
    const others = levelScore(0.48, 100, 0.5, 0.03);
    expect(rewardShare({ side: 'BUY', price: 0.49, shares: 60 }, book, 3, 50)).toBeCloseTo((levelScore(0.49, 60, 0.5, 0.03) / 3) / (levelScore(0.49, 60, 0.5, 0.03) / 3 + others));
  });
  it('earns nothing below min size or outside 0.1-0.9', () => {
    expect(rewardShare({ side: 'BUY', price: 0.49, shares: 10 }, book, 3, 50)).toBe(0);
    expect(rewardShare({ side: 'BUY', price: 0.04, shares: 60 }, { bids: [{ price: 0.04, size: 9 }], asks: [{ price: 0.06, size: 9 }] }, 3, 50)).toBe(0);
  });
  it('marks fills against the later mid', () => {
    const s = [{ at: 0, mid: 0.5 }, { at: 60_000, mid: 0.45 }, { at: 300_000, mid: 0.55 }];
    expect(midAfter(s, 30_000)).toBe(0.45);
    const r = markouts([{ side: 'BUY', price: 0.5, shares: 10, at: 0, token: 'T' }], (_t, at) => midAfter(s, at));
    expect(r['60s'].usd).toBeCloseTo(-0.5);
    expect(r['300s'].usd).toBeCloseTo(0.5);
  });
});
