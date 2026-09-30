// @ts-nocheck
/**
 * Order-book depth arithmetic — the single owner of what "depth" means.
 *
 * Two readers build a depth object: the REST branch (`clob.ts`, from a fetched
 * `/book` payload) and the WS branch (`clobWs.ts`, from the per-level maps the
 * socket maintains). They used to differ: only REST computed `imbalance` and
 * `spreadPct`, so a fresh socket book — the common case — reached the directional
 * scorer and the alpha-fusion ORDER_FLOW vote with no imbalance, and both
 * consumers read the gap as 0 (item 41).
 *
 * Both now go through these two functions, so the formula cannot drift between
 * the paths. Pure: no I/O, no module state.
 */

/** Ladder depth summed for the aggregate. */
export const DEPTH_LEVELS = 10;

/**
 * One side of a book as a clean ladder: numeric, resting size only, best first,
 * cut to `levels`, with per-level notional (`value`) and cumulative size (`cum`).
 * Polymarket's REST API returns bids ascending and asks descending, so the sort
 * is not optional.
 *
 * @param {Array<{price:any,size:any}>} rows
 * @param {'bid'|'ask'} side
 * @param {number} [levels]
 */
export function normalizeSide(rows, side, levels = DEPTH_LEVELS) {
  const clean = (rows || [])
    .map((r) => ({ price: parseFloat(r.price), size: parseFloat(r.size) }))
    .filter((r) => Number.isFinite(r.price) && Number.isFinite(r.size) && r.size > 0)
    .sort(side === 'bid' ? (a, b) => b.price - a.price : (a, b) => a.price - b.price);
  const ladder = clean.slice(0, levels).map((r) => ({ ...r, value: r.price * r.size }));
  let cum = 0;
  for (const level of ladder) {
    cum += level.size;
    level.cum = cum;
  }
  return ladder;
}

/**
 * Top-of-book and aggregate figures for a pair of ladders from `normalizeSide`.
 *
 * `imbalance` is (bid notional − ask notional) / total, in [-1, 1]; 0 for an
 * empty book, never NaN.
 */
export function summarizeBook(bids, asks) {
  const bestBid = bids[0]?.price || 0;
  const bestAsk = asks[0]?.price || 0;
  const bestBidSize = Number(bids[0]?.size) || 0;
  const bestAskSize = Number(asks[0]?.size) || 0;
  const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : null;
  const mid = bestBid > 0 && bestAsk > 0
    ? (bestBid + bestAsk) / 2
    : (bestBid || bestAsk || null);
  const spreadPct = mid > 0 && spread != null ? (spread / mid) * 100 : null;

  const totalBidVol = bids.reduce((s, b) => s + b.value, 0);
  const totalAskVol = asks.reduce((s, a) => s + a.value, 0);
  const imbalance = totalBidVol + totalAskVol > 0
    ? (totalBidVol - totalAskVol) / (totalBidVol + totalAskVol)
    : 0;

  return {
    bestBid,
    bestAsk,
    bestBidSize,
    bestAskSize,
    spread: spread ?? 0,
    spreadPct: spreadPct ?? 0,
    mid: mid ?? 0,
    totalBidVol,
    totalAskVol,
    imbalance,
    bidCount: bids.length,
    askCount: asks.length,
  };
}
