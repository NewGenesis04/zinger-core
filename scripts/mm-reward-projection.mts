// Stub reward projection with adverse-selection markouts.
// Live public books and public trades only (GET). No orders, no signing, no wallet.
import fs from 'node:fs';
import path from 'node:path';

const GAMMA = 'https://gamma-api.polymarket.com/markets';
const CLOB = 'https://clob.polymarket.com';
const DATA = 'https://data-api.polymarket.com/v2/trades';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
const MARKETS = Number(args.markets ?? 8);
const MINUTES = Number(args.minutes ?? 10);
const SAMPLE_MS = Number(args.sampleMs ?? 60_000);
const MARKOUT_MS = Number(args.markoutMs ?? 60_000);
// Thin-book floor: if competing in-band score on either side is below this, the share is not credible (sole-maker artifact).
const MIN_COMP = Number(args.minCompetition ?? 10_000);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(`tmp/commercial-evidence/mm-reward-projection/${runId}`);
fs.mkdirSync(outDir, { recursive: true });
const samplesFile = path.join(outDir, 'samples.jsonl'), fillsFile = path.join(outDir, 'fills.jsonl'), snapFile = path.join(outDir, 'snapshots.jsonl');

// Hard deadline on the whole request, body included. On 26-27 Oct a stalled body left a promise
// that never settled, and Node exited mid-day once nothing else kept the loop alive.
const withDeadline = <T>(p: Promise<T>, ms: number, what: string) => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(Error(`deadline ${ms}ms: ${what}`)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
const getJson = (url: string) => withDeadline((async () => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`${r.status} ${url}`);
  return r.json() as Promise<any>;
})(), 20_000, url.split('?')[0]);
const log = (file: string, rec: any) => fs.appendFileSync(file, JSON.stringify(rec) + '\n');

async function selectMarkets() {
  if (args.universe) {
    const u = JSON.parse(fs.readFileSync(path.resolve(args.universe), 'utf8'));
    return (u.selected as any[]).map((c) => ({
      id: c.conditionId, question: c.title, tokens: c.tokens.map((t: any) => String(t.id)),
      maxSpread: c.rewards.maxSpread, minSize: c.rewards.minSize, dailyPool: c.rewards.dailyPoolUsd,
      group: c.group ?? (c.triage?.thin ? 'thin' : 'deep'), negativeRisk: !!c.negativeRisk,
    })).filter((m: any) => m.tokens.length === 2 && m.dailyPool > 0);
  }
  const now = Date.now(), pool: any[] = [];
  for (let p = 0; p < 4; p++) pool.push(...await getJson(`${GAMMA}?active=true&closed=false&order=volume24hr&ascending=false&limit=100&offset=${p * 100}`));
  return pool.filter((m) => Array.isArray(m.clobRewards) && m.clobRewards.length && Number(m.rewardsMaxSpread) > 0 && m.endDate && Date.parse(m.endDate) > now)
    .slice(0, 200)
    .map((m) => ({
      id: m.conditionId, question: m.question,
      tokens: JSON.parse(m.clobTokenIds ?? '[]') as string[],
      maxSpread: Number(m.rewardsMaxSpread) / 100,
      minSize: Number(m.rewardsMinSize ?? 5),
      dailyPool: m.clobRewards.reduce((s: number, r: any) => s + Number(r.rewardsDailyRate ?? 0), 0),
    }))
    .filter((m) => m.tokens.length === 2 && m.dailyPool > 0)
    .slice(0, MARKETS);
}

// Docs formula: score = ((v - s)/v)^2 * size; bids and asks summed separately; smaller side counts.
const scoreLevels = (levels: { price: number; size: number }[], mid: number, v: number) =>
  levels.reduce((acc, l) => { const s = Math.abs(l.price - mid); return s <= v ? acc + l.size * ((v - s) / v) ** 2 : acc; }, 0);

// Per-market stub quotes on the reference token (index 0). Recorded locally only.
type Quote = { side: 'BUY' | 'SELL'; price: number; size: number; queueAhead: number; remaining: number; placedAt: number };
const quotes = new Map<string, Quote>();      // key: `${market}:bid|ask`
const lastTradeAt = new Map<string, number>(); // per market, for the trade window
const seenTrades = new Set<string>();
const mids: { market: string; at: number; mid: number }[] = [];
const fills: any[] = [];

// The data-api ignores start/end: it returns newest-first pages with next_cursor.
// Page until the oldest row is at or before the window start (or the page cap), then keep rows inside (from, to].
const MAX_TRADE_PAGES = Number(args.tradePages ?? 5);
async function fetchTrades(m: any, from: number, to: number) {
  const rows: any[] = []; let cursor: string | null = null, pages = 0, reachedStart = false;
  while (pages < MAX_TRADE_PAGES) {
    const url = new URL(DATA);
    url.searchParams.set('condition_id', m.id); url.searchParams.set('limit', '100'); url.searchParams.set('taker_only', 'true');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await getJson(String(url));
    const data: any[] = Array.isArray(page.data) ? page.data : [];
    pages++;
    rows.push(...data);
    const oldest = data.length ? Math.min(...data.map((t) => Number(t.timestamp) * 1000)) : -Infinity;
    if (oldest <= from) { reachedStart = true; break; }
    cursor = page.pagination?.next_cursor ?? null;
    if (!page.pagination?.has_more || !cursor) { reachedStart = true; break; }
  }
  const inWindow = rows.filter((t) => { const at = Number(t.timestamp) * 1000; return String(t.token_id) === m.tokens[0] && at > from && at <= to; });
  const seen = new Set<string>(); const unique = inWindow.filter((t) => { const k = `${t.transaction_hash}:${t.side}:${t.price}:${t.size}:${t.timestamp}:${t.token_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { truncated: !reachedStart, rows: unique };
}

let bookCache = new Map<string, any>();
async function fetchBooks(tokens: string[]) {
  const out = new Map<string, any>();
  for (let i = 0; i < tokens.length; i += 50) {
    // Body read included: an ECONNRESET while reading the body crashed day 3 on 27 Oct.
    const rows = await withDeadline((async () => {
      const r = await fetch(`${CLOB}/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tokens.slice(i, i + 50).map((token_id) => ({ token_id }))), signal: AbortSignal.timeout(20000) });
      return r.ok ? await r.json() as any[] : [];
    })(), 25_000, 'books').catch((e) => { log(samplesFile, { at: Date.now(), warning: 'books_failed', error: String(e?.message ?? e) }); return [] as any[]; });
    for (const b of rows) out.set(String(b.asset_id), b);
  }
  return out;
}
async function sampleMarket(m: any, at: number) {
  const books = m.tokens.map((t: string) => bookCache.get(t) ?? null);
  if (books.some((b) => !b?.bids?.length || !b?.asks?.length)) return log(samplesFile, { at, market: m.id, skipped: 'empty_book' });
  const b = books[0];
  const bids = b.bids.map((l: any) => ({ price: Number(l.price), size: Number(l.size) }));
  const asks = b.asks.map((l: any) => ({ price: Number(l.price), size: Number(l.size) }));
  const bestBid = Math.max(...bids.map((l) => l.price)), bestAsk = Math.min(...asks.map((l) => l.price));
  const mid = (bestBid + bestAsk) / 2;
  mids.push({ market: m.id, at, mid });
  const recentMids = mids.filter((x) => x.market === m.id).slice(-15).map((x) => x.mid);
  const meanMid = recentMids.reduce((a, x) => a + x, 0) / recentMids.length;
  const midStd15 = recentMids.length > 2 ? Math.sqrt(recentMids.reduce((a, x) => a + (x - meanMid) ** 2, 0) / (recentMids.length - 1)) : null;
  // Compact book snapshot (top 5 levels per side, reference token) for later re-scoring.
  const near = (l: any) => Math.abs(l.price - mid) <= 2 * m.maxSpread + 1e-9;
  log(snapFile, { at, market: m.id, mid, maxSpread: m.maxSpread, minSize: m.minSize, dailyPool: m.dailyPool, group: m.group ?? null, bids: bids.filter(near), asks: asks.filter(near) });

  // 1) Fills from public trades since the last sample, against quotes resting before them.
  const from = lastTradeAt.get(m.id) ?? at - SAMPLE_MS;
  const trades = await fetchTrades(m, from, at).catch(() => ({ truncated: false, rows: [] as any[] }));
  const volumeUsd = trades.rows.reduce((a: number, t: any) => a + Number(t.price) * Number(t.size), 0);
  const tradeCount = trades.rows.length;
  for (const t of trades.rows) {
    const key = `${t.transaction_hash}:${t.side}:${t.price}:${t.size}:${t.timestamp}`;
    if (seenTrades.has(key)) continue; seenTrades.add(key);
    const tAt = Number(t.timestamp) * 1000, price = Number(t.price), size = Number(t.size);
    for (const k of ['bid', 'ask'] as const) {
      const q = quotes.get(`${m.id}:${k}`);
      if (!q || tAt < q.placedAt || Math.abs(q.price - price) > 1e-9) continue;
      // Opposite-side taker: a SELL taker hits our BUY; a BUY taker lifts our SELL.
      if (!((q.side === 'BUY' && t.side === 'SELL') || (q.side === 'SELL' && t.side === 'BUY'))) continue;
      const consumed = Math.min(q.queueAhead, size); q.queueAhead -= consumed;
      const fill = Math.min(q.remaining, size - consumed);
      if (fill > 1e-6) { q.remaining -= fill; fills.push({ market: m.id, question: m.question, side: q.side, price, shares: fill, at: tAt, midAtFill: mid }); log(fillsFile, fills[fills.length - 1]); }
    }
  }
  if (trades.truncated) log(samplesFile, { at, market: m.id, warning: 'trade_page_truncated' });
  lastTradeAt.set(m.id, at);

  // 2) Stub quotes at best bid and best ask, replaced when the touch moves.
  for (const [k, side, price, levels] of [['bid', 'BUY', bestBid, bids], ['ask', 'SELL', bestAsk, asks]] as const) {
    const key = `${m.id}:${k}`, prev = quotes.get(key);
    if (!prev || prev.price !== price) {
      const queueAhead = levels.filter((l) => Math.abs(l.price - price) < 1e-9).reduce((s, l) => s + l.size, 0);
      quotes.set(key, { side, price, size: m.minSize, queueAhead, remaining: m.minSize, placedAt: at });
    }
  }

  // 3) Reward projection (unchanged from the previous version).
  const ours = { bid: scoreLevels([{ price: bestBid, size: m.minSize }], mid, m.maxSpread), ask: scoreLevels([{ price: bestAsk, size: m.minSize }], mid, m.maxSpread) };
  if (mid - bestBid > m.maxSpread || bestAsk - mid > m.maxSpread) return log(samplesFile, { at, market: m.id, skipped: 'outside_band' });
  const cBid = scoreLevels(bids, mid, m.maxSpread), cAsk = scoreLevels(asks, mid, m.maxSpread);
  if (Math.min(cBid, cAsk) < MIN_COMP) return log(samplesFile, { at, market: m.id, question: m.question, skipped: 'thin_competition', competitionBid: +cBid.toFixed(2), competitionAsk: +cAsk.toFixed(2) });
  const share = Math.min(ours.bid / (ours.bid + cBid), ours.ask / (ours.ask + cAsk));
  log(samplesFile, { at, market: m.id, question: m.question, mid, bestBid, bestAsk, maxSpread: m.maxSpread, minSize: m.minSize,
    competitionBid: +cBid.toFixed(2), competitionAsk: +cAsk.toFixed(2), share: +share.toFixed(6), projectedUsd: +(share * m.dailyPool / 1440).toFixed(6), tradesSeen: trades.rows.length, volumeUsd: +volumeUsd.toFixed(2), tradeCount, midStd15: midStd15 == null ? null : +midStd15.toFixed(6), touchQueueBid: +bids.filter((l) => Math.abs(l.price - bestBid) < 1e-9).reduce((a, l) => a + l.size, 0).toFixed(2), touchQueueAsk: +asks.filter((l) => Math.abs(l.price - bestAsk) < 1e-9).reduce((a, l) => a + l.size, 0).toFixed(2) });
}

const markets = await selectMarkets();
console.log(JSON.stringify({ runId, outDir, markets: markets.length, minutes: MINUTES, markoutMs: MARKOUT_MS }));
fs.writeFileSync(path.join(outDir, 'markets.json'), JSON.stringify(markets, null, 2));

// Keep the event loop alive between awaits, and log (not die on) anything unexpected.
const keepAlive = setInterval(() => {}, 30_000);
process.on('unhandledRejection', (e) => log(samplesFile, { at: Date.now(), warning: 'unhandled_rejection', error: String((e as any)?.message ?? e) }));
for (let i = 0; i < MINUTES; i++) {
  const at = Date.now();
  bookCache = await fetchBooks(markets.flatMap((m: any) => m.tokens));
  // Ten markets at a time, so trade-history requests do not burst against the public API.
  for (let j = 0; j < markets.length; j += 10)
    await Promise.all(markets.slice(j, j + 10).map((m: any) => sampleMarket(m, at).catch((e) => log(samplesFile, { at, market: m.id, error: String(e) }))));
  const wait = SAMPLE_MS - (Date.now() - at);
  if (i < MINUTES - 1 && wait > 0) await new Promise((r) => setTimeout(r, wait));
}
clearInterval(keepAlive);

// Markouts: mid at (fill + MARKOUT_MS), from the nearest later sample of the same market.
const marked = fills.map((f) => {
  const later = mids.filter((x) => x.market === f.market && x.at >= f.at + MARKOUT_MS).sort((a, b) => a.at - b.at)[0];
  if (!later) return { ...f, markout: null, pnlPerShare: null };
  const pnlPerShare = f.side === 'BUY' ? later.mid - f.price : f.price - later.mid; // + = favourable
  return { ...f, midLater: later.mid, markout: +pnlPerShare.toFixed(6), pnlPerShare: +pnlPerShare.toFixed(6), pnlUsd: +(pnlPerShare * f.shares).toFixed(6) };
});
fs.writeFileSync(path.join(outDir, 'fills_marked.json'), JSON.stringify(marked, null, 2));

const recs = fs.readFileSync(samplesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.share != null);
const byM: Record<string, any> = {};
for (const r of recs) { byM[r.market] ??= { q: r.question, n: 0, s: 0, pool: markets.find((m) => m.id === r.market)?.dailyPool ?? 0 }; byM[r.market].n++; byM[r.market].s += r.share; }
const rewardUsdPerDay = Object.values(byM).reduce((a: number, v: any) => a + (v.s / v.n) * v.pool, 0);
const withMarkout = marked.filter((f) => f.markout != null);
const tradingPnl = withMarkout.reduce((a, f) => a + f.pnlUsd, 0);
const summary = { runId, minutes: MINUTES, samples: recs.length, fills: fills.length, markedFills: withMarkout.length,
  adverseFills: withMarkout.filter((f) => f.pnlPerShare < 0).length, markoutPnlUsd: +tradingPnl.toFixed(4),
  meanMarkoutPerShare: withMarkout.length ? +(withMarkout.reduce((a, f) => a + f.pnlPerShare, 0) / withMarkout.length).toFixed(6) : null,
  rewardUsdPerDayMean: +rewardUsdPerDay.toFixed(4),
  markets: Object.entries(byM).map(([id, v]: [string, any]) => ({ id, question: v.q, samples: v.n, meanShare: +(v.s / v.n).toFixed(6), projectedUsdPerDay: +((v.s / v.n) * v.pool).toFixed(4) })) };
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ outDir, samples: summary.samples, fills: summary.fills, markedFills: summary.markedFills, markoutPnlUsd: summary.markoutPnlUsd, rewardUsdPerDayMean: summary.rewardUsdPerDayMean }, null, 1));
