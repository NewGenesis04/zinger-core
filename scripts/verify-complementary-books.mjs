#!/usr/bin/env node
/**
 * Domain facts §11: do the two tokens of a binary share one order book?
 *
 * If they do, a resting buy of DOWN at $0.49 *is* a resting sell of UP at
 * $0.51 — the same order seen from the complementary side — and therefore
 *
 *     ask_up + ask_down = 1 + spread >= $1.00 + one tick
 *
 * in any snapshot read at a single moment. That makes the arb entry condition
 * (`ask_up + ask_down < 1.00`, `arbEngine.ts:132`) unreachable: what it detects
 * is a desynchronised read, not an opportunity.
 *
 *   node scripts/verify-complementary-books.mjs [options]
 *
 *     --symbol btc|eth|both   default both
 *     --samples N             snapshots per market, default 8
 *     --interval MS           wait between snapshots, default 1200
 *     --sequential            fetch the two books one after the other instead
 *                             of in parallel — the control. Reproduces the
 *                             desynchronisation `getDepthForMarket`
 *                             (`clob.ts:173`) creates with its await-in-loop.
 *     --slug SLUG             a specific market instead of the current window
 *     --fee-rate R            taker fee rate for the cost line, default 0.07
 *                             (crypto, research §3)
 *
 * Read-only: CLOB `/book` and Gamma `/markets`, both direct and unproxied, the
 * same read path as `clob.ts:9`. Touches no database and places no orders.
 * Safe to run beside a running bot.
 *
 * Run it during a fast spot move. The original 2026-09-28 capture sampled only
 * quiet books, which is the one gap in §11's evidence.
 */
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = process.env.CLOB_API_URL?.trim() || 'https://clob.polymarket.com';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const symbols = opt('symbol', 'both') === 'both' ? ['btc', 'eth'] : [opt('symbol', 'both')];
const samples = Number(opt('samples', 8));
const interval = Number(opt('interval', 1200));
const sequential = args.includes('--sequential');
const onlySlug = opt('slug', null);
const feeRate = Number(opt('fee-rate', 0.07));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? res.json() : null;
  } catch { return null; }
}
/** Best-first: asks ascending, bids descending. The CLOB does not guarantee order. */
const ladder = (book, side) => (book?.[side] || [])
  .map((o) => ({ p: Number(o.price), s: Number(o.size) }))
  .filter((o) => Number.isFinite(o.p) && Number.isFinite(o.s) && o.s > 0)
  .sort((a, b) => (side === 'asks' ? a.p - b.p : b.p - a.p));

/** Gamma exposes the pair under two shapes; the event route 404s near rollover. */
async function resolveMarket(slug) {
  const ev = await json(`${GAMMA}/events/slug/${slug}`);
  if (ev?.markets?.[0]?.clobTokenIds) return JSON.parse(ev.markets[0].clobTokenIds);
  const rows = await json(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  const m = Array.isArray(rows) ? rows.find((r) => r?.slug === slug) : null;
  return m?.clobTokenIds ? JSON.parse(m.clobTokenIds) : null;
}

async function findCurrent(symbol) {
  if (onlySlug) {
    const ids = await resolveMarket(onlySlug);
    return ids ? { slug: onlySlug, ids } : null;
  }
  const now = Math.floor(Date.now() / 1000);
  // Current window first, then the neighbours: near rollover one of them is
  // always live, and a window in its last ~20s has a one-sided book.
  for (const off of [0, -300, 300, 600]) {
    const start = Math.floor(now / 300) * 300 + off;
    const slug = `${symbol}-updown-5m-${start}`;
    const ids = await resolveMarket(slug);
    if (ids) return { slug, ids, secsIn: now - start };
  }
  return null;
}

/** Taker cost of one complete set at these asks, against the $1.00 it redeems for. */
const setCost = (askA, askB) => {
  const fee = (p) => feeRate * p * (1 - p);
  return askA + askB + fee(askA) + fee(askB);
};

let anyBelowOne = 0;
let anyChecked = 0;

for (const symbol of symbols) {
  const found = await findCurrent(symbol);
  if (!found) { console.log(`${symbol}: no live 5m market found\n`); continue; }
  console.log(`=== ${found.slug}${found.secsIn != null ? `  (${found.secsIn}s into window)` : ''}`
    + `  ${sequential ? 'SEQUENTIAL (control)' : 'parallel'}`);
  console.log('  UP bid/ask    DOWN bid/ask   askSum   sum-1    mirror   set cost   vs $1.00');

  const sums = [];
  const mirrors = [];
  for (let k = 0; k < samples; k++) {
    let A; let B;
    if (sequential) {
      A = await json(`${CLOB}/book?token_id=${found.ids[0]}`);
      B = await json(`${CLOB}/book?token_id=${found.ids[1]}`);
    } else {
      [A, B] = await Promise.all([
        json(`${CLOB}/book?token_id=${found.ids[0]}`),
        json(`${CLOB}/book?token_id=${found.ids[1]}`),
      ]);
    }
    const aAsk = ladder(A, 'asks')[0]; const aBid = ladder(A, 'bids')[0];
    const bAsk = ladder(B, 'asks')[0]; const bBid = ladder(B, 'bids')[0];
    if (!aAsk || !bAsk) { console.log('  one-sided book (window near settlement) — skipped'); await sleep(interval); continue; }

    const sum = aAsk.p + bAsk.p;
    sums.push(sum);
    anyChecked += 1;
    if (sum < 1) anyBelowOne += 1;

    // The identity under test: UP.bids and 1 - DOWN.asks are the same orders.
    // Compared on price AND size, because matching prices alone is what two
    // independent books quoting one event would also produce.
    const reflected = ladder(B, 'asks').map((o) => ({ p: Number((1 - o.p).toFixed(4)), s: o.s }));
    const upBids = ladder(A, 'bids');
    const n = Math.min(upBids.length, reflected.length);
    let exact = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(upBids[i].p - reflected[i].p) < 1e-9 && Math.abs(upBids[i].s - reflected[i].s) < 1e-9) exact += 1;
    }
    mirrors.push(n ? exact / n : null);

    const cost = setCost(aAsk.p, bAsk.p);
    console.log(
      `  ${String(aBid?.p ?? '—').padStart(5)}/${String(aAsk.p).padEnd(6)}`
      + ` ${String(bBid?.p ?? '—').padStart(6)}/${String(bAsk.p).padEnd(6)}`
      + ` ${sum.toFixed(3).padStart(7)} ${(sum - 1).toFixed(3).padStart(7)}`
      + ` ${`${exact}/${n}`.padStart(8)}`
      + ` ${cost.toFixed(4).padStart(10)} ${`${((1 - cost) * 100).toFixed(2)}%`.padStart(9)}`,
    );
    await sleep(interval);
  }

  if (sums.length) {
    const clean = mirrors.filter((m) => m != null);
    const perfect = clean.filter((m) => m === 1).length;
    console.log(`  → askSum min ${Math.min(...sums).toFixed(3)}  max ${Math.max(...sums).toFixed(3)}`
      + `  below $1.00: ${sums.filter((s) => s < 1).length}/${sums.length}`
      + `  ·  ladders identical in ${perfect}/${clean.length} snapshots\n`);
  }
}

console.log('Read: a perfect mirror (price AND size, every level) means one book seen from');
console.log('two sides, so askSum is 1 + spread and can never be under $1.00 — the arb entry');
console.log('condition is unreachable and every gap the engine fires on is a stale read.');
console.log('A mirror that breaks while askSum stays >= 1.00 means the two reads desynchronised;');
console.log('rerun with --sequential to see the engine\'s own fetch pattern do exactly that.');
console.log('An askSum genuinely below $1.00 on a clean mirror would REFUTE §11 — record it,');
console.log('note the market and the time, and reopen docs/arb-viability-decision-2026-09-28.md.');
console.log(`\nThis run: ${anyBelowOne}/${anyChecked} snapshots below $1.00.`);
