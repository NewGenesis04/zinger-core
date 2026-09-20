// @ts-nocheck
/**
 * INVARIANTS: leg 2 is priced when it is sent, and the tick it may pay is
 * budgeted before the package opens (item 97).
 *
 * Through 2026-09-18 no live arb package ever locked. Every second leg died,
 * and the receipts say why: `"order couldn't be fully filled. FOK orders are
 * fully filled or killed."` One of them asked for 5.32 shares against a
 * 109.3-share book — 5% of top of book — so depth cannot explain it.
 *
 * The cause is that leg 2 was signed at a price taken before leg 1 was even
 * dispatched. Legs run sequentially (UP first, DOWN only `if (upShares > 0)`),
 * so by the time DOWN is signed its quote is stale by leg 1's whole round trip,
 * and a FOK bounded at a price the book has left has *zero* reachable shares.
 *
 * Two defences, tested separately because they cover different windows:
 *
 *   re-read  removes staleness that already happened — the book is read again
 *            after leg 1 returns.
 *   buffer   covers drift still to come, which no re-read can see. Signed one
 *            tick high, and charged to `requiredGap` at the entry gate so the
 *            package only opens if it can absorb it.
 *
 * These are properties of the pricing decision, not of any particular fill.
 * Timings are deliberately absent: the drift distribution is unmeasured, and a
 * test asserting a latency would freeze a guess about it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { detectAndExecuteArbPackage } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages, loadPackages } from '../../src/polymarket/arbPersistence.js';
import { buyCeiling } from '../../src/polymarket/trade.js';
import { arbBreakEvenGap } from '../../src/polymarket/fees.js';

const market = {
  symbol: 'BTC',
  slug: 'btc-updown-5m-1789716600',
  conditionId: '0xleg2',
  outcomes: ['Up', 'Down'],
  tokenIds: { up: 'token-up', down: 'token-down' },
  acceptingOrders: true,
  tickSize: '0.01',
};

/** A book with room to spare: gap 8%, deep on both sides. */
const UP_ASK = 0.46;
const DOWN_ASK = 0.46;
const book = (downAsk = DOWN_ASK) => ({
  up: { bestAsk: UP_ASK, bestAskSize: 5000, bookTs: Date.now() },
  down: { bestAsk: downAsk, bestAskSize: 5000, bookTs: Date.now() },
});

const baseCfg = {
  clobArbEnabled: true,
  minArbGap: 0.01,
  maxArbPackages: 4,
  paperBankroll: 500,
  arbBankrollFrac: 0.2,
  arbMaxUsd: 50,
  minPositionSize: 0.5,
  instantCtfMerge: false,
  arbLeg2BufferTicks: 1,
  arbLeg2RereadBook: true,
  arbMaxHedgeLossPct: 0.03,
};

/**
 * Drives one package and records every leg plan. `refetchDepth` is injected, so
 * "the book moved between leg 1 and leg 2" is expressible without a clock.
 */
const run = ({ cfg = {}, downAsk = DOWN_ASK, rereadDownAsk = null, fillPlan = true, slug = market.slug } = {}) => {
  const seen = [];
  const executeTrade = async (pending) => {
    seen.push({
      outcome: pending.outcome,
      price: pending.plan.price,
      entryPrice: pending.plan.entryPrice,
      shares: pending.plan.shares,
      sizeUsd: pending.plan.sizeUsd,
    });
    if (!fillPlan && pending.outcome === 'down') return { ok: false, error: 'killed' };
    return { ok: true, position: { shares: pending.plan.shares } };
  };

  const refetchDepth = async (m) => {
    // Only the DOWN token should ever be asked for — the whole point is to
    // reprice one leg, not to re-fetch a book already paid for.
    expect(Object.keys(m.tokenIds || {})).toEqual(['down']);
    if (rereadDownAsk === 'throw') throw new Error('book unavailable');
    if (rereadDownAsk == null) return {};
    return { down: { bestAsk: rereadDownAsk, bestAskSize: 5000, bookTs: Date.now() } };
  };

  return detectAndExecuteArbPackage({
    // Each call needs its own slug: an active package blocks a second one on the
    // same market (`package_already_on_slug`), which would silently make the
    // second half of a comparison test assert nothing — which it did, until the
    // "locked" log line gave it away.
    market: { ...market, slug },
    depth: book(downAsk),
    prices: { upAsk: UP_ASK, downAsk },
    cfg: { ...baseCfg, ...cfg },
    mode: 'live',
    readiness: { spendableBalance: 500, liveReady: true },
    log: () => {},
    executeTrade,
    adjustPaperCash: () => {},
    saveTrade: () => {},
    botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
    refetchDepth,
  }).then((pkg) => ({ pkg, seen }));
};

beforeEach(() => { saveAllPackages([]); });

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: a buy bound is lifted onto the grid, never below the ask', () => {
  it('lifts a grid-aligned ask by exactly the buffer', () => {
    // 0.46 / 0.01 is 45.999999999999993 in binary floating point. A bare ceil
    // would spend a tick before the buffer was applied.
    expect(buyCeiling(0.46, { tickSize: 0.01, bufferTicks: 1 })).toBe(0.47);
    expect(buyCeiling(0.14, { tickSize: 0.01, bufferTicks: 1 })).toBe(0.15);
    expect(buyCeiling(0.7, { tickSize: 0.01, bufferTicks: 2 })).toBe(0.72);
  });

  it('never returns a bound below the ask, on any grid', () => {
    for (const tick of [0.01, 0.001]) {
      for (let a = tick; a < 0.99; a += tick) {
        const ask = Math.round(a * 1e6) / 1e6;
        expect(buyCeiling(ask, { tickSize: tick, bufferTicks: 0 })).toBeGreaterThanOrEqual(ask);
        expect(buyCeiling(ask, { tickSize: tick, bufferTicks: 1 })).toBeGreaterThanOrEqual(ask);
      }
    }
  });

  it('rounds an off-grid quote up to the grid before buffering', () => {
    // Rounding an off-grid ask *down* would sign below the book.
    expect(buyCeiling(0.465, { tickSize: 0.01, bufferTicks: 0 })).toBe(0.47);
    expect(buyCeiling(0.465, { tickSize: 0.01, bufferTicks: 1 })).toBe(0.48);
  });

  it('caps below par, because a binary token is worth at most $1.00', () => {
    expect(buyCeiling(0.99, { tickSize: 0.01, bufferTicks: 1 })).toBe(0.99);
    expect(buyCeiling(0.995, { tickSize: 0.01, bufferTicks: 3 })).toBe(0.99);
  });

  it('is the identity on the grid when no buffer is asked for', () => {
    expect(buyCeiling(0.46, { tickSize: 0.01, bufferTicks: 0 })).toBe(0.46);
    expect(buyCeiling(0, { tickSize: 0.01, bufferTicks: 1 })).toBe(0);
    expect(buyCeiling(NaN, { tickSize: 0.01, bufferTicks: 1 })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: the tick leg 2 may pay is charged at the gate (item 97)', () => {
  /**
   * A book that clears break-even plus margin, but not by a whole tick. Under
   * the old gate it opened and could then fill below break-even; the buffer is
   * only honest if the package had to afford it up front.
   */
  const marginal = () => {
    const be = arbBreakEvenGap(UP_ASK, DOWN_ASK, 'crypto');
    // Sit the gap between (be + margin) and (be + margin + one tick).
    const margin = 0.002;
    const gap = be + margin + 0.004;
    const downAsk = Math.round((1 - gap - UP_ASK) * 100) / 100;
    return { margin, downAsk };
  };

  it('refuses a package that cannot absorb the buffer', async () => {
    const { margin, downAsk } = marginal();
    const { pkg, seen } = await run({
      cfg: { arbMinMarginPct: margin, minArbGap: 0.001 },
      downAsk,
    });
    expect(pkg, 'opened a package that cannot pay for its own buffer').toBeNull();
    expect(seen, 'dispatched a leg on a refused package').toHaveLength(0);
  });

  it('takes the same book once the buffer is not charged', async () => {
    // Isolates the buffer as the cause of the refusal above. If this also
    // refused, the fixture would be testing the fee gate instead.
    const { margin, downAsk } = marginal();
    const { pkg } = await run({
      cfg: { arbMinMarginPct: margin, minArbGap: 0.001, arbLeg2BufferTicks: 0 },
      downAsk,
    });
    expect(pkg?.status).toBe('LOCKED');
  });

  it('reports the worst-case cost, so locked profit is a floor', async () => {
    const { pkg } = await run({});
    // costDown is charged at the ceiling, not the quote, so a better fill can
    // only improve on what was recorded.
    const ceiling = buyCeiling(DOWN_ASK, { tickSize: 0.01, bufferTicks: 1 });
    expect(pkg.downCost).toBeCloseTo(pkg.shares * ceiling, 2);
    expect(pkg.downCost).toBeGreaterThan(pkg.shares * DOWN_ASK);
    expect(pkg.lockedProfitUsd).toBeLessThan(pkg.expectedPayout - pkg.upCost - (pkg.shares * DOWN_ASK));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: leg 2 is priced from the book as it is when leg 2 is sent', () => {
  it('signs against the re-read ask, not the scan quote', async () => {
    // THE REGRESSION. The scan said 0.46; by the time leg 1 returned the book
    // was 0.48. Signing 0.46 is an order with nothing reachable behind it.
    const { pkg, seen } = await run({ rereadDownAsk: 0.48 });

    const down = seen.find((l) => l.outcome === 'down');
    expect(down.price, 'signed a price the book had already left').not.toBe(DOWN_ASK);
    expect(down.price).toBe(buyCeiling(0.48, { tickSize: 0.01, bufferTicks: 1 }));
    expect(pkg?.status).toBe('LOCKED');
  });

  it('funds leg 2 at the bound so the signed share count equals leg 1 (§9b)', async () => {
    // `original_size` is `amountUsd / maxPrice`. Funding the quote while
    // bounding a tick higher signs *fewer* shares than leg 1 matched, and the
    // shortfall is a naked UP leg — the exact thing a package exists to avoid.
    const { seen } = await run({ rereadDownAsk: 0.48 });
    const [up, down] = seen;
    expect(down.shares).toBeCloseTo(up.shares, 6);
    // The dollar amount is rounded to the cent, so the signed size can differ
    // from leg 1 by at most one cent's worth of shares — and by nothing else.
    // Stated as the bound it actually is rather than a decimal place: at $0.10 a
    // cent is 0.1 shares, at $0.90 it is 0.011, and a fixed tolerance would be
    // either vacuous or wrong depending on the leg.
    const signedShares = down.sizeUsd / down.price;
    expect(Math.abs(signedShares - up.shares), 'signed size drifts by more than cent rounding')
      .toBeLessThanOrEqual((0.01 / down.price) + 1e-9);
  });

  it('falls back to the scan quote when the re-read fails, rather than not trading', async () => {
    const { pkg, seen } = await run({ rereadDownAsk: 'throw' });
    const down = seen.find((l) => l.outcome === 'down');
    expect(down.price).toBe(buyCeiling(DOWN_ASK, { tickSize: 0.01, bufferTicks: 1 }));
    expect(pkg?.status).toBe('LOCKED');
  });

  it('uses the fresher price when the book moved in our favour too', async () => {
    const { seen } = await run({ rereadDownAsk: 0.44 });
    const down = seen.find((l) => l.outcome === 'down');
    expect(down.price).toBe(buyCeiling(0.44, { tickSize: 0.01, bufferTicks: 1 }));
    expect(down.price).toBeLessThan(buyCeiling(DOWN_ASK, { tickSize: 0.01, bufferTicks: 1 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: a filled leg 1 is hedged unless hedging costs more than the risk', () => {
  it('hedges into a small certain loss rather than hold a naked leg', async () => {
    // Once leg 1 is filled the alternative is not "no trade" — it is a fair bet
    // at market odds: zero expected edge, full variance. A few cents of certain
    // loss is the better side of that, and this must not refuse it.
    const { pkg, seen } = await run({ rereadDownAsk: 0.55 });

    const down = seen.find((l) => l.outcome === 'down');
    expect(down, 'refused to complete a hedge over a few cents').toBeTruthy();
    // Deliberately buying above break-even: UP 0.46 + DOWN 0.56 > $1.00.
    expect(UP_ASK + down.price).toBeGreaterThan(1.0);
    expect(pkg?.status).toBe('LOCKED');
  });

  it('refuses the hedge and leaves leg 1 to the unwind path past the cap', async () => {
    // "Better than a coin flip" stops being true once the book has moved far
    // enough. The bound is what makes the previous test safe.
    const { pkg, seen } = await run({ rereadDownAsk: 0.90, cfg: { arbMaxHedgeLossPct: 0.002 } });

    expect(seen.map((l) => l.outcome), 'sent leg 2 at any price').toEqual(['up']);
    expect(pkg?.status).toBe('ABORTED');
    expect(pkg.legs.down.error).toMatch(/hedge refused/);
    expect(pkg.legs.down.error).toMatch(/over cap/);
  });

  it('judges the move, not the dollar total, at both ends of the size range', async () => {
    /*
     * Why the cap is a fraction and not a dollar figure. This move puts the pair
     * one tick past par, so it locks the same *relative* loss either way — but
     * $0.54 on a 53-share package and $0.03 on a 3-share one. A fixed ceiling
     * has to be wrong about one of them: set it for the small package and the
     * large one can never hedge; set it for the large one and the small package
     * may lose a quarter of its value.
     */
    const small = await run({ rereadDownAsk: 0.54, cfg: { arbMaxUsd: 3 }, slug: 'btc-updown-5m-small' });
    const large = await run({ rereadDownAsk: 0.54, cfg: { arbMaxUsd: 50 }, slug: 'btc-updown-5m-large' });

    expect(small.seen.map((l) => l.outcome)).toContain('down');
    expect(large.seen.map((l) => l.outcome)).toContain('down');
    // Same move, order-of-magnitude different dollar loss — which is the point.
    const sharesSmall = small.seen[0].shares;
    const sharesLarge = large.seen[0].shares;
    expect(sharesLarge / sharesSmall).toBeGreaterThan(10);
  });

  it('refuses a catastrophic move at every size', async () => {
    // The floor on the cap must not become a loophole for tiny packages: a book
    // at $0.90 against a $0.46 leg is a 37% certain loss, and no size makes that
    // the better side of a coin flip.
    const small = await run({ rereadDownAsk: 0.90, cfg: { arbMaxUsd: 3 }, slug: 'btc-updown-5m-small' });
    const large = await run({ rereadDownAsk: 0.90, cfg: { arbMaxUsd: 50 }, slug: 'btc-updown-5m-large' });

    expect(small.pkg?.status).toBe('ABORTED');
    expect(large.pkg?.status).toBe('ABORTED');
    expect(small.seen.map((l) => l.outcome)).toEqual(['up']);
    expect(large.seen.map((l) => l.outcome)).toEqual(['up']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: an expected buffer excess is not reported as a parity fault', () => {
  it('does not flag the excess the buffer itself produces', async () => {
    // Funded at the ceiling and filled at the ask, the same dollars buy
    // `tick / price` extra shares — 2.2% at $0.46, 7.1% at $0.14. That is the
    // buffer working. A threshold that flags it fires on exactly the skewed
    // books this strategy exists to trade.
    const cheapDown = 0.14;
    const seenPkgs = [];
    const executeTrade = async (pending) => {
      // DOWN is funded at the ceiling; a fill at the ask buys the excess.
      const signed = pending.plan.sizeUsd / pending.plan.price;
      const shares = pending.outcome === 'down'
        ? pending.plan.sizeUsd / cheapDown
        : signed;
      return { ok: true, position: { shares } };
    };

    const pkg = await detectAndExecuteArbPackage({
      market,
      depth: { up: { bestAsk: 0.70, bestAskSize: 5000 }, down: { bestAsk: cheapDown, bestAskSize: 5000 } },
      prices: { upAsk: 0.70, downAsk: cheapDown },
      cfg: { ...baseCfg, minArbGap: 0.01 },
      mode: 'live',
      readiness: { spendableBalance: 500, liveReady: true },
      log: (msg) => { seenPkgs.push(String(msg)); },
      executeTrade,
      adjustPaperCash: () => {},
      saveTrade: () => {},
      botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
      refetchDepth: async () => ({}),
    });

    expect(pkg?.status).toBe('LOCKED');
    expect(pkg.residualShares, 'recorded an expected excess as a breach').toBeUndefined();
    expect(seenPkgs.join(' ')).not.toMatch(/PARITY BREACH/);
  });

  it('still flags a residual too large to be the buffer', async () => {
    // The property the widened tolerance must not lose: a real parity fault is
    // still loud, because it means the FOK model encoded here is wrong.
    const logs = [];
    const executeTrade = async (pending) => ({
      ok: true,
      position: { shares: pending.outcome === 'down' ? pending.plan.shares * 0.5 : pending.plan.shares },
    });

    const pkg = await detectAndExecuteArbPackage({
      market,
      depth: book(),
      prices: { upAsk: UP_ASK, downAsk: DOWN_ASK },
      cfg: baseCfg,
      mode: 'live',
      readiness: { spendableBalance: 500, liveReady: true },
      log: (msg) => { logs.push(String(msg)); },
      executeTrade,
      adjustPaperCash: () => {},
      saveTrade: () => {},
      botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
      refetchDepth: async () => ({}),
    });

    expect(pkg.residualShares).toBeGreaterThan(0);
    expect(logs.join(' ')).toMatch(/PARITY BREACH/);
  });
});
