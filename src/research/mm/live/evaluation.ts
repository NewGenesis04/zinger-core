/**
 * Dry-run evaluation: estimated liquidity-reward share of our resting orders and fill
 * markouts. Estimates only. Rewards are never booked as cash.
 *
 * Reward rule (Polymarket liquidity rewards): an order inside the band v = max_spread/100 of
 * the midpoint, and at least min_size shares, scores size·((v−s)/v)². A market's score is the
 * smaller of its two sides. One-sided quoting scores a third when the midpoint is inside
 * [0.1, 0.9] and nothing outside it. A YES bid counts on the same side as a NO ask.
 */
export interface Level { price: number; size: number }

export function levelScore(price: number, size: number, mid: number, v: number) {
  const s = Math.abs(price - mid);
  return v > 0 && s <= v ? size * ((v - s) / v) ** 2 : 0;
}

/** One-sided share for a single resting order on the YES book (see marketRewardShare for both sides). */
export function rewardShare(o: { side: 'BUY' | 'SELL'; price: number; shares: number }, book: { bids: Level[]; asks: Level[] }, maxSpreadCents: number, minSize: number) {
  if (!book.bids.length || !book.asks.length || o.shares < minSize) return 0;
  const bid = Math.max(...book.bids.map((l) => l.price)), ask = Math.min(...book.asks.map((l) => l.price));
  const mid = (bid + ask) / 2, v = maxSpreadCents / 100;
  if (mid < 0.1 || mid > 0.9) return 0;
  const side = (rows: Level[]) => rows.filter((l) => l.size >= minSize).reduce((s, l) => s + levelScore(l.price, l.size, mid, v), 0);
  const ours = levelScore(o.price, o.shares, mid, v) / 3;
  if (ours <= 0) return 0;
  const others = Math.min(side(book.bids), side(book.asks));
  return ours / (ours + others);
}

/**
 * Our share of a market's reward pool for all our resting orders, on the YES book frame.
 * A NO bid at p is passed as a YES ask at 1 − p. Score = max(min(Qbid, Qask), max(Qbid, Qask)/3)
 * when the mid is inside [0.1, 0.9]; outside it only the two-sided min counts.
 */
export function marketRewardShare(orders: { side: 'BUY' | 'SELL'; price: number; shares: number }[], book: { bids: Level[]; asks: Level[] }, maxSpreadCents: number, minSize: number) {
  if (!book.bids.length || !book.asks.length) return 0;
  const bid = Math.max(...book.bids.map((l) => l.price)), ask = Math.min(...book.asks.map((l) => l.price));
  const mid = (bid + ask) / 2, v = maxSpreadCents / 100;
  const ours = (side: 'BUY' | 'SELL') => orders.filter((o) => o.side === side && o.shares >= minSize).reduce((s, o) => s + levelScore(o.price, o.shares, mid, v), 0);
  const qb = ours('BUY'), qa = ours('SELL');
  const q = mid >= 0.1 && mid <= 0.9 ? Math.max(Math.min(qb, qa), Math.max(qb, qa) / 3) : Math.min(qb, qa);
  if (q <= 0) return 0;
  const side = (rows: Level[]) => rows.filter((l) => l.size >= minSize).reduce((s, l) => s + levelScore(l.price, l.size, mid, v), 0);
  return q / (q + Math.min(side(book.bids), side(book.asks)));
}

export interface FillMark { side: 'BUY' | 'SELL'; price: number; shares: number; at: number; token: string }

/** Markout per fill: (mid later − fill price) × shares for a buy, reversed for a sell. */
export function markouts(fills: FillMark[], midAt: (token: string, at: number) => number | null, horizonsMs = [60_000, 300_000]) {
  const out: Record<string, { usd: number; n: number }> = {};
  for (const h of horizonsMs) {
    let usd = 0, n = 0;
    for (const f of fills) {
      const m = midAt(f.token, f.at + h);
      if (m == null) continue;
      usd += (f.side === 'BUY' ? m - f.price : f.price - m) * f.shares; n++;
    }
    out[`${h / 1000}s`] = { usd: Math.round(usd * 1e4) / 1e4, n };
  }
  return out;
}

/** Mid at or just after a time, from an ascending series; null if the series ends first. */
export function midAfter(series: { at: number; mid: number }[], at: number) {
  let lo = 0, hi = series.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (series[m].at < at) lo = m + 1; else hi = m; }
  return lo < series.length ? series[lo].mid : null;
}
