// @ts-nocheck
/**
 * Which market's order book stands for a symbol in the alpha fusion?
 *
 * The fusion signal is per asset (BTC, ETH), computed once per pass and shared
 * by every window of that asset (5m, 15m, 4h ...). Its ORDER_FLOW vote therefore
 * needs ONE book per symbol, but a pass scans several markets per symbol. The
 * scan loop used to write each market's book into the symbol's slot as it went,
 * so whichever market the loop reached last won, and the loop order is whatever
 * `findMarkets` returned.
 *
 * Ownership: this module owns the choice. The scan offers every market's book
 * as it is read; the pick is independent of the order they are offered in.
 *
 * The rule, best first:
 *   1. a window that is live now, over one that is only upcoming — an upcoming
 *      window is barely traded, so its imbalance is noise;
 *   2. a market accepting orders, over one that is not;
 *   3. the shortest window — the fusion's other votes are 1m/5m technicals, so
 *      the book it is fused with should be the one for the same horizon;
 *   4. the slug, so ties resolve the same way every pass.
 */

const SYMBOLS = ['btc', 'eth'];

/** Sort key for a market: lower sorts first, and the first one wins. */
function rankOf(market) {
  return [
    market?.isCurrent === false ? 1 : 0,
    market?.acceptingOrders === false ? 1 : 0,
    Number(market?.windowSeconds) > 0 ? Number(market.windowSeconds) : Number.MAX_SAFE_INTEGER,
    String(market?.slug ?? ''),
  ];
}

function compareRank(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/**
 * The fusion's view of one side of a book. `imbalance` stays null when the book
 * carries none, rather than a neutral 0: the vote then reads as absent, and
 * `source` records which book answered so a silent half-vote is diagnosable.
 */
function bookFrom(market, depth, now) {
  const side = depth?.up ?? depth?.down ?? {};
  const mid = Number(side.mid) || 0;
  const spread = Number(side.spread) || 0;
  return {
    bestBid: side.bestBid ?? null,
    bestAsk: side.bestAsk ?? null,
    imbalance: Number.isFinite(side.imbalance) ? side.imbalance : null,
    spreadPct: Number.isFinite(side.spreadPct) && side.spreadPct > 0
      ? side.spreadPct
      : (mid > 0 && spread > 0 ? (spread / mid) * 100 : null),
    source: side.source || 'clob-rest',
    // Which market this book is, so a fused signal can be traced to it.
    slug: market?.slug ?? null,
    windowSeconds: Number(market?.windowSeconds) || null,
    at: now,
  };
}

/**
 * Offer one market's depth for its symbol. `picked` is a per-pass map
 * (`{ btc?: {rank, book}, eth?: ... }`) that the caller creates fresh for each
 * pass and passes to every call. Returns `{ sym, book }` when this market is now
 * the symbol's pick, otherwise null.
 */
export function offerFusionBook(picked, market, depth, now = Date.now()) {
  const sym = String(market?.symbol ?? '').toLowerCase();
  if (!depth || !SYMBOLS.includes(sym)) return null;
  const rank = rankOf(market);
  const held = picked[sym];
  if (held && compareRank(rank, held.rank) >= 0) return null;
  const book = bookFrom(market, depth, now);
  picked[sym] = { rank, book };
  return { sym, book };
}
