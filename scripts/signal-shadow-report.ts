#!/usr/bin/env node
// @ts-nocheck
/**
 * Signal shadow report (backlog item 132) — does any signal beat the price?
 *
 * READ-ONLY. Opens the sqlite file with readOnly:true. Pull a consistent
 * snapshot from the VPS first (a live db has an un-checkpointed WAL; see the
 * VACUUM INTO recipe in scripts/audit-store.ts), then:
 *
 *   npx tsx scripts/signal-shadow-report.ts /path/to/zinger.db
 *   npx tsx scripts/signal-shadow-report.ts /path/to/zinger.db --since=2026-10-10
 *
 * ── Pre-registered hypotheses ────────────────────────────────────────────────
 * Fixed here, before any shadow data exists, so the tables below cannot be
 * hunted for a slice that happens to look good. Change them only with a
 * written reason in the backlog item, and re-run on data collected afterwards.
 *
 *   H0  the TA signal's direction predicts the window result.
 *   H1  the strike-distance probability is accurate, by share of window elapsed.
 *   H2  buying the side the model prefers, at the ask, held to settlement, is
 *       profitable after the taker fee, when the model leads the ask by a gap.
 *   H3  the ML trace's weighted vote predicts the window result.
 *   H4  (model-free) a token bought at its ask, held to settlement, is calibrated:
 *       its win rate matches ask + fee, by ask bucket and window length.
 *       H4 was written down on 2026-10-13, AFTER a first look at the first 1,446
 *       windows, where a favourite-versus-longshot pattern appeared on 15m. Those
 *       windows are exploratory. Only windows that START at or after
 *       H4_CONFIRM_START_MS count as confirmation, and the report prints that
 *       section separately.
 *
 * Edge is measured per window, not per row: rows inside a window are
 * correlated, so each window contributes one number to a bucket and the
 * standard error is taken across windows. Every table is printed for the first
 * and second half of the data; a result that does not repeat is not a result.
 */
import { DatabaseSync } from 'node:sqlite';
import { takerFeeUsdc } from '../src/polymarket/fees.js';

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith('--')) || process.env.ZINGER_DB_PATH || 'data/zinger.db';
const sinceArg = args.find((a) => a.startsWith('--since='))?.slice(8);
const since = sinceArg ? Date.parse(sinceArg) : 0;

const FRACTIONS = [[0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 0.95]];
const GAPS = [[0.05, 0.1], [0.1, 0.2], [0.2, 1.01]];
const MIN_FRACTION_FOR_EDGE = 0.4;
// An ask only counts if someone could actually have bought from it: a real price, at least the
// exchange minimum resting, and a book that was current when the row was written.
const MIN_ASK = 0.02;
const MIN_ASK_SIZE = 5;
const MAX_BOOK_AGE_MS = 2000;
// 2026-10-13T01:15:00Z. Windows starting before this were seen when H4 was formed.
const H4_CONFIRM_START_MS = 1791854100000;
const H4_BUCKETS = [[0.02, 0.1], [0.1, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 0.95], [0.95, 0.99]];

const db = new DatabaseSync(dbPath, { readOnly: true });
const all = db.prepare(
  `SELECT * FROM signal_shadow WHERE outcome_up IS NOT NULL AND ts >= ? ORDER BY ts`,
).all(since);

const feePerShare = (p) => takerFeeUsdc(1000, p, 'crypto') / 1000;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const frac = (r) => r.elapsed_s / r.dur_s;
const win = (side, r) => (side === 'up') === (r.outcome_up === 1);

function perWindow(rows, valueOf) {
  const by = new Map();
  for (const r of rows) {
    const v = valueOf(r);
    if (v == null) continue;
    if (!by.has(r.slug)) by.set(r.slug, []);
    by.get(r.slug).push(v);
  }
  return [...by.values()].map(mean);
}
function summarize(vals) {
  if (vals.length < 2) return { n: vals.length, mean: NaN, se: NaN };
  return { n: vals.length, mean: mean(vals), se: sd(vals) / Math.sqrt(vals.length) };
}


/**
 * Mean with a standard error that treats every window as one cluster. Rows of one window are
 * correlated, so the error comes from the window totals, not from the row count.
 *
 * Entries are NOT averaged per window first: that gives a window with one qualifying row the same
 * weight as one with twenty, and inflated an apparent edge to +7.5c when pooled rows and a
 * realistic first-sight entry both said about zero. Two estimators are always printed:
 *   pooled      every qualifying row, equal weight
 *   first-sight the first qualifying row of each window (and token), the entry a bot could take
 */
function clusterMean(items) {
  const n = items.length;
  if (n < 3) return { n, windows: 0, mean: NaN, se: NaN };
  const m = items.reduce((s, x) => s + x.v, 0) / n;
  const by = new Map();
  for (const x of items) by.set(x.slug, (by.get(x.slug) || 0) + (x.v - m));
  const ss = [...by.values()].reduce((s, t) => s + t * t, 0);
  return { n, windows: by.size, mean: m, se: Math.sqrt(ss) / n };
}
function firstSight(entries) {
  const first = new Map();
  for (const e of entries) {
    const k = `${e.slug}|${e.tok || ''}`;
    if (!first.has(k) || e.ts < first.get(k).ts) first.set(k, e);
  }
  return [...first.values()];
}
const fmtNet = (t) => (t.n < 3 || Number.isNaN(t.mean) ? '      -       ' : `${t.mean >= 0 ? '+' : ''}${t.mean.toFixed(3)} (±${t.se.toFixed(3)})`);

function coverage(rows) {
  const windows = new Set(rows.map((r) => r.slug));
  const withBook = rows.filter((r) => r.up_ask != null && r.down_ask != null).length;
  const withModel = rows.filter((r) => r.p_up_spot != null).length;
  console.log(`rows ${rows.length} · windows ${windows.size} · with both asks ${pct(withBook / rows.length)} · with model ${pct(withModel / rows.length)}`);
  for (const d of [300, 900]) {
    const w = new Set(rows.filter((r) => r.dur_s === d).map((r) => r.slug));
    if (w.size) console.log(`  ${d / 60}m windows: ${w.size} · Up share ${pct(mean([...w].map((s) => rows.find((r) => r.slug === s).outcome_up)))}`);
  }
}

function h0(rows) {
  console.log('\nH0  TA signal direction vs result (up/down only)');
  for (const d of [300, 900]) {
    const q = rows.filter((r) => r.dur_s === d && (r.ta_dir === 'up' || r.ta_dir === 'down'));
    const s = summarize(perWindow(q, (r) => (win(r.ta_dir, r) ? 1 : 0)));
    if (s.n) console.log(`  ${d / 60}m  windows=${s.n}  hit=${pct(s.mean)}  (±${(100 * s.se).toFixed(1)} pts; coin = 50%)`);
  }
}

function h1(rows) {
  for (const col of ['p_up_spot', 'p_up_oracle']) {
    console.log(`\nH1  strike-distance model (${col}) accuracy by share of window elapsed`);
    for (const d of [300, 900]) {
      for (const [lo, hi] of FRACTIONS) {
        const q = rows.filter((r) => r.dur_s === d && r[col] != null && frac(r) >= lo && frac(r) < hi);
        const s = summarize(perWindow(q, (r) => (win(r[col] >= 0.5 ? 'up' : 'down', r) ? 1 : 0)));
        if (s.n >= 10) console.log(`  ${d / 60}m  ${(lo * 100) | 0}-${(hi * 100) | 0}%  windows=${s.n}  right=${pct(s.mean)} (±${(100 * s.se).toFixed(1)})`);
      }
    }
  }
}

function h2(rows, label) {
  for (const col of ['p_up_spot', 'p_up_oracle']) {
    console.log(`\nH2  buy the model's side at the ask, hold to settlement, net of taker fee — ${col}${label}`);
    console.log('       (pooled = every qualifying row; first-sight = first qualifying row per window)');
    for (const d of [300, 900]) {
      for (const [lo, hi] of GAPS) {
        const entries = [];
        for (const r of rows) {
          if (r.dur_s !== d || r[col] == null || frac(r) < MIN_FRACTION_FOR_EDGE) continue;
          if (r.up_ask == null || r.down_ask == null) continue;
          const side = r[col] >= 0.5 ? 'up' : 'down';
          const ask = side === 'up' ? r.up_ask : r.down_ask;
          const askSize = side === 'up' ? r.up_ask_size : r.down_ask_size;
          if (!(ask >= MIN_ASK) || !(askSize >= MIN_ASK_SIZE) || !(ask < 1)) continue;
          if (r.book_ts == null || r.ts - r.book_ts > MAX_BOOK_AGE_MS) continue;
          const model = side === 'up' ? r[col] : 1 - r[col];
          const gap = model - ask;
          if (!(gap >= lo && gap < hi)) continue;
          entries.push({ slug: r.slug, ts: r.ts, v: (win(side, r) ? 1 : 0) - ask - feePerShare(ask) });
        }
        const pooled = clusterMean(entries);
        if (pooled.windows < 10) continue;
        const fs = clusterMean(firstSight(entries));
        console.log(`  ${d / 60}m  model-over-ask ${(lo * 100) | 0}-${hi > 1 ? '+' : (hi * 100) | 0}pts  windows=${String(pooled.windows).padStart(4)}  pooled ${fmtNet(pooled)}  first-sight ${fmtNet(fs)}`);
      }
    }
  }
}

function h3(rows) {
  console.log('\nH3  ML trace weighted vote vs result');
  const vote = (r) => {
    let up = 0; let down = 0;
    try {
      for (const [, dir, conf] of JSON.parse(r.ml_json || '[]')) {
        if (dir === 'up') up += conf; else if (dir === 'down') down += conf;
      }
    } catch { return null; }
    return up === down ? null : up > down ? 'up' : 'down';
  };
  for (const d of [300, 900]) {
    const q = rows.filter((r) => r.dur_s === d);
    const s = summarize(perWindow(q, (r) => { const v = vote(r); return v ? (win(v, r) ? 1 : 0) : null; }));
    if (s.n) console.log(`  ${d / 60}m  windows=${s.n}  hit=${pct(s.mean)} (±${(100 * s.se).toFixed(1)})`);
  }
}

function h4(rows, label) {
  console.log(`\nH4  model-free: buy a token at its ask, hold to settlement, net of taker fee — late in window (>=${MIN_FRACTION_FOR_EDGE * 100}%)${label}`);
  console.log('       (pooled = every qualifying row; first-sight = first qualifying row per window and token)');
  const cutTs = rows.length ? rows[Math.floor(rows.length / 2)].ts : 0;
  for (const d of [300, 900]) {
    console.log(`  --- ${d / 60}m windows`);
    for (const [lo, hi] of H4_BUCKETS) {
      const entries = [];
      let wins = 0; let askSum = 0;
      for (const r of rows) {
        if (r.dur_s !== d || frac(r) < MIN_FRACTION_FOR_EDGE) continue;
        if (r.book_ts == null || r.ts - r.book_ts > MAX_BOOK_AGE_MS) continue;
        for (const tok of ['up', 'down']) {
          const ask = r[`${tok}_ask`]; const size = r[`${tok}_ask_size`];
          if (!(ask >= MIN_ASK) || !(size >= MIN_ASK_SIZE) || !(ask >= lo && ask < hi) || !(ask < 1)) continue;
          const w = win(tok, r);
          entries.push({ slug: r.slug, tok, ts: r.ts, v: (w ? 1 : 0) - ask - feePerShare(ask) });
          wins += w ? 1 : 0; askSum += ask;
        }
      }
      const pooled = clusterMean(entries);
      if (pooled.windows < 15) continue;
      const first = firstSight(entries);
      const fs = clusterMean(first);
      const a = clusterMean(first.filter((e) => e.ts < cutTs));
      const b = clusterMean(first.filter((e) => e.ts >= cutTs));
      const avgAsk = askSum / entries.length;
      console.log(`  ask ${lo.toFixed(2)}-${hi.toFixed(2)}  windows=${String(pooled.windows).padStart(4)}  wins ${pct(wins / entries.length)} at avg ask ${avgAsk.toFixed(3)} (break-even ${pct(avgAsk + feePerShare(avgAsk))})  pooled ${fmtNet(pooled)}  first-sight ${fmtNet(fs)}  halves ${a.n < 3 ? '-' : (a.mean >= 0 ? '+' : '') + a.mean.toFixed(3)} | ${b.n < 3 ? '-' : (b.mean >= 0 ? '+' : '') + b.mean.toFixed(3)}`);
    }
  }
}

if (!all.length) {
  console.log('No resolved shadow rows yet. The bot must run, and windows must end and be resolved first.');
  process.exit(0);
}
console.log(`signal_shadow report · ${dbPath}${since ? ` · since ${sinceArg}` : ''}`);
coverage(all);
h0(all); h1(all); h3(all);
h2(all, ' [all data]');
const cut = all[Math.floor(all.length / 2)].ts;
h2(all.filter((r) => r.ts < cut), ' [first half]');
h2(all.filter((r) => r.ts >= cut), ' [second half]');
h4(all, ' [all data: includes the exploratory windows]');
const confirm = all.filter((r) => r.end_ms - r.dur_s * 1000 >= H4_CONFIRM_START_MS);
console.log(`\nH4 confirmation set: windows starting at or after ${new Date(H4_CONFIRM_START_MS).toISOString()} — ${new Set(confirm.map((r) => r.slug)).size} windows`);
h4(confirm, ' [CONFIRMATION ONLY]');
console.log(`\nAsks counted only if price >= ${MIN_ASK}, resting size >= ${MIN_ASK_SIZE} shares and book age <= ${MAX_BOOK_AGE_MS} ms.`);
console.log('A bucket counts only if BOTH pooled and first-sight net/share are positive, exceed twice their ± error, and hold in both halves.');
