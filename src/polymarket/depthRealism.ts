/**
 * Paper order-book realism — what a paper fill may assume about the book.
 *
 * Paper used to book any size at the best price: `shares = sizeUsd / ask`, whatever
 * was resting, and exits at the best ask or bid regardless of the position's size
 * (backlog item 131). The functions here are pure so the rules are testable
 * without a socket; `bot.ts` supplies the depth side and applies the result.
 *
 * Two assumptions are modelling choices, not verified Polymarket facts, and are
 * labelled as such where they are used:
 *   - the participation fraction (default 0.4) of the resting best-ask size an
 *     entry may take;
 *   - the price assumed for size beyond the visible ladder on an exit.
 * The 5-share minimum is the documented `min_order_size`; whether it binds a
 * SELL is unverified (research doc §5), so the exit rule sits behind a flag.
 */

export const DEFAULT_PARTICIPATION = 0.4;
export const DEFAULT_MIN_SHARES = 5;
/** Ticks below the worst visible level that size beyond the ladder is assumed to fill at. */
export const LADDER_EXHAUST_TICKS = 5;
const TICK = 0.01;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

interface Level { price: number; size: number }

/** The side's visible ladder, best first; falls back to top-of-book when no ladder is published. */
function ladderOf(side: any, which: 'bids' | 'asks'): Level[] {
  const rows = Array.isArray(side?.[which]) ? side[which] : null;
  if (rows && rows.length) {
    return rows
      .map((r: any) => ({ price: Number(r.price), size: Number(r.size) }))
      .filter((r: Level) => Number.isFinite(r.price) && r.price > 0 && Number.isFinite(r.size) && r.size > 0);
  }
  const px = Number(which === 'bids' ? side?.bestBid : side?.bestAsk);
  const sz = Number(which === 'bids' ? side?.bestBidSize : side?.bestAskSize);
  return px > 0 && sz > 0 ? [{ price: px, size: sz }] : [];
}

/** What the book looked like when a fill was booked — recorded on the trade so depth can be measured later. */
export function depthSnapshot(side: any) {
  if (!side) return null;
  const bids = ladderOf(side, 'bids');
  const asks = ladderOf(side, 'asks');
  const top = (l: Level[], n: number) => Math.round(l.slice(0, n).reduce((s, x) => s + x.size, 0) * 100) / 100;
  return {
    bestBid: Number(side.bestBid) || null,
    bestAsk: Number(side.bestAsk) || null,
    bestBidSize: Number(side.bestBidSize) || bids[0]?.size || 0,
    bestAskSize: Number(side.bestAskSize) || asks[0]?.size || 0,
    top3BidSize: top(bids, 3),
    top3AskSize: top(asks, 3),
    source: side.source || null,
    bookTs: Number(side.bookTs) || null,
  };
}

export interface DepthEntryPlan {
  ok: boolean;
  /** Set when ok is false. */
  reason?: 'no_executable_ask' | 'thin_book' | 'min_order_exceeds_cap';
  shares: number;
  record: Record<string, unknown>;
}

/**
 * Size a paper entry against the resting ask.
 *
 *   maxShares = floor(bestAskSize × participation)
 *   skip when maxShares < minShares            (a 5-share order cannot be taken at 40%)
 *   shares    = min(requested, maxShares)
 *   shares    < minShares  →  lifted to minShares when affordable, else skipped
 *
 * The lift mirrors the live path (`bot.ts` min-order guard): live raises a small
 * budget to the exchange minimum, and skips when that blows the cap.
 */
export function planDepthEntry({
  requestedShares,
  entryPrice,
  side,
  minShares = DEFAULT_MIN_SHARES,
  participation = DEFAULT_PARTICIPATION,
  maxCostUsd = Infinity,
}: {
  requestedShares: number;
  entryPrice: number;
  side: any;
  minShares?: number;
  participation?: number;
  maxCostUsd?: number;
}): DepthEntryPlan {
  const askSize = Number(side?.bestAskSize) || 0;
  const bestAsk = Number(side?.bestAsk) || 0;
  const frac = Number.isFinite(Number(participation)) && Number(participation) > 0 ? Number(participation) : DEFAULT_PARTICIPATION;
  const minSh = Number(minShares) > 0 ? Number(minShares) : DEFAULT_MIN_SHARES;
  const base = { requestedShares: r3(requestedShares), askSize, participation: frac, bestAsk: bestAsk || null };

  // The entry price must be a price the book offers; a gamma mid is not one.
  if (!(bestAsk > 0) || !(askSize > 0) || Math.abs(Number(entryPrice) - bestAsk) > 1e-9) {
    return { ok: false, reason: 'no_executable_ask', shares: 0, record: { ...base, cappedBy: 'no_executable_ask' } };
  }
  const maxShares = Math.floor(askSize * frac);
  if (maxShares < minSh) {
    return { ok: false, reason: 'thin_book', shares: 0, record: { ...base, maxShares, cappedBy: 'thin_book' } };
  }
  let shares = Math.min(requestedShares, maxShares);
  let cappedBy: string = shares < requestedShares ? 'participation' : 'none';
  if (shares < minSh) {
    if (minSh * entryPrice > maxCostUsd) {
      return { ok: false, reason: 'min_order_exceeds_cap', shares: 0, record: { ...base, maxShares, cappedBy: 'min_order_exceeds_cap' } };
    }
    shares = minSh;
    cappedBy = 'min_lift';
  }
  return { ok: true, shares: r3(shares), record: { ...base, maxShares, cappedBy } };
}

export interface BookWalk {
  /** Volume-weighted fill price, 3dp. */
  price: number;
  /** Price of the worst level touched. */
  worstPrice: number;
  filledShares: number;
  /** True when the visible ladder could not absorb the order; the rest filled at the assumed exhaust price. */
  exhausted: boolean;
  levelsUsed: number;
}

/**
 * Fill `shares` against a ladder, best level first. Size beyond the visible
 * ladder fills at (worst visible price − LADDER_EXHAUST_TICKS ticks): an
 * assumption, flagged by `exhausted`.
 */
export function walkBook(ladder: Level[], shares: number, direction: 'sell' | 'buy' = 'sell'): BookWalk | null {
  if (!ladder.length || !(shares > 0)) return null;
  let left = shares;
  let notional = 0;
  let worst = ladder[0].price;
  let used = 0;
  for (const lv of ladder) {
    if (left <= 1e-9) break;
    const take = Math.min(left, lv.size);
    notional += take * lv.price;
    left -= take;
    worst = lv.price;
    used += 1;
  }
  let exhausted = false;
  if (left > 1e-9) {
    exhausted = true;
    const px = direction === 'sell'
      ? Math.max(TICK, worst - LADDER_EXHAUST_TICKS * TICK)
      : Math.min(0.99, worst + LADDER_EXHAUST_TICKS * TICK);
    notional += left * px;
    worst = px;
  }
  return { price: r3(notional / shares), worstPrice: r3(worst), filledShares: shares, exhausted, levelsUsed: used };
}

/**
 * Price a paper sell against the resting bids. Falls back to `fallbackPrice`
 * when there is no book to walk (the caller then books what it used to).
 */
export function paperSellFill({ side, sellShares, fallbackPrice }: { side: any; sellShares: number; fallbackPrice: number }) {
  const walk = walkBook(ladderOf(side, 'bids'), sellShares, 'sell');
  if (!walk) {
    return { price: fallbackPrice, record: { book: 'none', sellShares: r3(sellShares) } };
  }
  const bestBid = Number(side?.bestBid) || ladderOf(side, 'bids')[0]?.price || fallbackPrice;
  // A walk can only be at or below the best bid; never let rounding book above it.
  const price = Math.min(walk.price, bestBid);
  return {
    price,
    record: {
      book: 'walked',
      sellShares: r3(sellShares),
      bestBid,
      bestBidSize: Number(side?.bestBidSize) || ladderOf(side, 'bids')[0]?.size || 0,
      levelsUsed: walk.levelsUsed,
      worstPrice: walk.worstPrice,
      exhausted: walk.exhausted,
      slippageVsBid: r3(bestBid - price),
    },
  };
}

export type PartialPlan =
  | { skip: false; sell: number; remaining: number }
  | { skip: true; reason: 'position_below_two_minimums' };

/**
 * Size a partial exit so that neither the sale nor what is left is below the
 * exchange minimum. A remainder under the minimum could not be sold later and
 * would be stuck until redemption. Positions under twice the minimum take no
 * partial at all.
 */
export function planPartialExit({ held, partialPct, minShares = DEFAULT_MIN_SHARES }: { held: number; partialPct: number; minShares?: number }): PartialPlan {
  const min = Number(minShares) > 0 ? Number(minShares) : DEFAULT_MIN_SHARES;
  if (!(held >= 2 * min - 1e-9)) return { skip: true, reason: 'position_below_two_minimums' };
  const pct = Number(partialPct) > 0 && Number(partialPct) < 1 ? Number(partialPct) : 0.5;
  let sell = held * pct;
  if (sell < min) sell = min;
  if (held - sell < min) sell = held - min;
  // Floor, not round: rounding the sale up could leave a remainder just under the minimum.
  sell = Math.floor(sell * 1000 + 1e-6) / 1000;
  return { skip: false, sell, remaining: Math.round((held - sell) * 1000) / 1000 };
}
