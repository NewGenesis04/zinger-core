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
    for (const d of [300, 900]) {
      for (const [lo, hi] of GAPS) {
        const q = rows.filter((r) => r.dur_s === d && r[col] != null && frac(r) >= MIN_FRACTION_FOR_EDGE && r.up_ask != null && r.down_ask != null);
        const value = (r) => {
          const side = r[col] >= 0.5 ? 'up' : 'down';
          const ask = side === 'up' ? r.up_ask : r.down_ask;
          const model = side === 'up' ? r[col] : 1 - r[col];
          const gap = model - ask;
          if (!(gap >= lo && gap < hi) || !(ask > 0 && ask < 1)) return null;
          return (win(side, r) ? 1 : 0) - ask - feePerShare(ask);
        };
        const s = summarize(perWindow(q, value));
        if (s.n >= 10) console.log(`  ${d / 60}m  model-over-ask ${(lo * 100) | 0}-${hi > 1 ? '+' : (hi * 100) | 0}pts  windows=${s.n}  net/share=${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(4)} (±${s.se.toFixed(4)})`);
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
console.log('\nA bucket counts only if it is positive in BOTH halves and its net/share exceeds twice its ± error.');
