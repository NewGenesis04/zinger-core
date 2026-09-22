#!/usr/bin/env node
/**
 * Item 109: do wide arb gaps arrive on stale books?
 *
 * Read-only. Lists every package in the store with its gap, the age of each
 * leg's book at dispatch (`bookAgeMs`, stamped by `executeArbLeg`), what the
 * venue said, and how the package ended. Then it tabulates outcome by gap and by
 * leg-1 book age.
 *
 *   node scripts/arb-book-age.mjs [path/to/zinger.db] [--mode live|paper] [--archive]
 *
 * Defaults: data/zinger.db, live. Opens the database read-only; safe to run
 * beside a running bot.
 *
 * `--archive` also reads the packages a live reset set aside
 * (`poly_live_archive.json`, written by `resetLiveData` before it clears them),
 * so a reset does not erase the evidence. The last 21 resets are kept.
 */
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const modeAt = args.indexOf('--mode');
const mode = modeAt >= 0 ? args[modeAt + 1] : 'live';
const withArchive = args.includes('--archive');
const dbPath = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--mode') || 'data/zinger.db';

const db = new DatabaseSync(dbPath, { readOnly: true });
const doc = (key) => {
  const r = db.prepare('SELECT value FROM docs WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : null;
};
const current = doc('poly_packages.json') || [];
const archived = withArchive
  ? (doc('poly_live_archive.json') || []).flatMap((entry) => entry?.packages || [])
  : [];
// A package can appear in more than one archive entry; count it once.
const byId = new Map();
for (const p of [...archived, ...current]) if (p?.packageId) byId.set(p.packageId, p);
const packages = [...byId.values()].filter((p) => p.mode === mode);
if (withArchive) console.log(`${archived.length} archived + ${current.length} current package record(s) read`);

const pct = (v) => (v == null ? '   —  ' : `${(v * 100).toFixed(2)}%`.padStart(6));
const ms = (v) => (v == null ? '    —' : String(Math.round(v)).padStart(5));
const usd = (v) => (v == null ? '     —' : `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`.padStart(6));

console.log(`${packages.length} ${mode} package(s) in ${dbPath}\n`);
console.log('created (UTC)        status   gap     up age  dn age  dn src   slip   realized  slug / venue');
for (const p of packages.sort((a, b) => a.createdAt - b.createdAt)) {
  const up = p.legs?.up || {};
  const dn = p.legs?.down || {};
  const err = [up.error && `UP: ${up.error}`, dn.error && `DN: ${dn.error}`].filter(Boolean).join(' · ');
  console.log([
    new Date(p.createdAt).toISOString().slice(0, 19).replace('T', ' '),
    String(p.status).padEnd(8),
    pct(p.gap),
    ms(up.bookAgeMs), ms(dn.bookAgeMs),
    String(dn.bookSource || '—').padEnd(8),
    usd(p.slippageUsd),
    usd(p.realizedPnlUsd).padStart(8),
    ` ${p.slug}${err ? `  ${err.slice(0, 90)}` : ''}`,
  ].join(' '));
}

/** Outcome counts per bucket: did both legs fill at the prices we signed? */
function table(title, keyOf) {
  const buckets = new Map();
  for (const p of packages) {
    const k = keyOf(p);
    if (k == null) continue;
    const b = buckets.get(k) || { n: 0, locked: 0, aborted: 0, oneLeg: 0 };
    b.n += 1;
    if (p.status === 'LOCKED' || p.status === 'SETTLED' || p.status === 'MERGED') b.locked += 1;
    if (p.status === 'ABORTED') {
      b.aborted += 1;
      if (p.legs?.up?.filled !== p.legs?.down?.filled) b.oneLeg += 1;
    }
    buckets.set(k, b);
  }
  console.log(`\n${title}`);
  console.log('bucket          n  both-filled  aborted  of-which-one-leg');
  for (const [k, b] of [...buckets].sort()) {
    console.log(`${k.padEnd(14)} ${String(b.n).padStart(2)}  ${String(b.locked).padStart(11)}  ${String(b.aborted).padStart(7)}  ${String(b.oneLeg).padStart(16)}`);
  }
}

table('By gap', (p) => {
  if (p.gap == null) return null;
  const g = p.gap * 100;
  return g < 4 ? '<4%' : g < 5 ? '4–5%' : g < 6 ? '5–6%' : g < 8 ? '6–8%' : '≥8%';
});
table('By leg-1 book age at dispatch', (p) => {
  const a = p.legs?.up?.bookAgeMs;
  if (a == null) return null;
  return a < 250 ? '<250ms' : a < 1000 ? '250ms–1s' : a < 5000 ? '1–5s' : '≥5s';
});

console.log('\nRead: if wide gaps and old leg-1 books both concentrate in the aborted and');
console.log('one-leg columns, the stale-quote mechanism in item 109 holds, and the fix is');
console.log('to re-read the DOWN book before leg 1 as well as after. Small n settles nothing.');
