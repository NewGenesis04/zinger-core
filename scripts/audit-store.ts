#!/usr/bin/env node
// @ts-nocheck
/**
 * One-shot audit of the live store — slice 0.
 *
 * This is NOT a test and must not go in CI. It answers "does the state in this
 * store hold together *right now*", against real data, once. The permanent
 * invariant suite (`tests/unit/invariants.test.ts`) answers the different
 * question "does the code behave correctly", against fixtures, forever.
 *
 * Keeping them separate is deliberate: a suite whose pass/fail depends on
 * whatever happens to be in `data/` cannot distinguish a code defect from a
 * data artifact, and against an empty store it passes trivially — "cash
 * reconciles" holds perfectly with zero trades.
 *
 * READ-ONLY. It opens sqlite with readOnly:true and never writes.
 *
 * Usage:
 *   npx tsx scripts/audit-store.ts                    # audit the default data dir
 *   ZINGER_DATA_DIR=/srv/zinger/data npx tsx scripts/audit-store.ts
 *   npx tsx scripts/audit-store.ts --json             # machine-readable
 *
 * To audit a running VPS without deploying this script, take a consistent
 * snapshot there and pull it down — a live db has an un-checkpointed WAL, so
 * copying the .db alone gives a stale or torn read:
 *
 *   ssh host 'cd /opt/apps/ZINGER && node -e "
 *     const {DatabaseSync}=require(\"node:sqlite\");
 *     new DatabaseSync(\"data/zinger.db\",{readOnly:true})
 *       .exec(\"VACUUM INTO \x27/tmp/snap/zinger.db\x27\")"'
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { getDataDir } from '../src/polymarket/dataDir.js';
import { defaultLiveStrategy } from '../src/polymarket/modeConfig.js';

const require = createRequire(import.meta.url);
const asJson = process.argv.includes('--json');
const DATA_DIR = getDataDir();
const DB_PATH = process.env.ZINGER_DB_PATH
  ? path.resolve(process.env.ZINGER_DB_PATH)
  : path.join(DATA_DIR, 'zinger.db');

const EPS = 0.011; // cent-rounding tolerance; stores round to 2dp

const findings = [];
function record(invariant, status, summary, detail = null) {
  findings.push({ invariant, status, summary, detail });
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

// ---------------------------------------------------------------- load (RO)

function readStore() {
  const out = {};
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (fs.existsSync(DB_PATH)) db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    db = null;
  }
  const get = (key, fallback) => {
    if (db) {
      const row = db.prepare('SELECT value FROM docs WHERE key = ?').get(key);
      if (row) {
        try {
          return JSON.parse(row.value);
        } catch {
          return fallback;
        }
      }
    }
    const file = path.join(DATA_DIR, key);
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        return fallback;
      }
    }
    return fallback;
  };
  out.db = db;
  out.backend = db ? 'sqlite' : 'json';
  out.packages = get('poly_packages.json', []);
  out.trades = get('poly_trades.json', []);
  out.positions = get('poly_positions.json', []);
  out.config = get('poly_config.json', {});
  out.sessionPerf = get('session_perf.json', null);
  return out;
}

const store = readStore();
const packages = Array.isArray(store.packages) ? store.packages : [];
const trades = Array.isArray(store.trades) ? store.trades : [];
const positions = Array.isArray(store.positions) ? store.positions : [];

// -------------------------------------------- 1. a full set redeems to $1.00

{
  const bad = [];
  for (const p of packages) {
    const up = p.legs?.up;
    const down = p.legs?.down;
    if (!up || !down) {
      bad.push({ packageId: p.packageId, why: 'package has fewer than two legs' });
      continue;
    }
    // The arb guarantee: one share of UP + one share of DOWN redeems $1.00.
    // That requires equal share counts on both legs.
    if (Math.abs(Number(up.shares || 0) - Number(down.shares || 0)) > 1e-6) {
      bad.push({
        packageId: p.packageId,
        why: `leg shares differ — up ${up.shares} vs down ${down.shares}; the pair cannot redeem $1.00/set`,
      });
    }
    const shares = Number(p.shares || 0);
    const payout = Number(p.expectedPayout || 0);
    if (shares > 0 && Math.abs(payout - shares) > Math.max(EPS, shares * 0.001)) {
      bad.push({
        packageId: p.packageId,
        why: `expectedPayout ${payout.toFixed(2)} != shares ${shares.toFixed(3)} × $1.00`,
      });
    }
    const legCost = Number(up.cost || 0) + Number(down.cost || 0);
    if (Math.abs(legCost - Number(p.totalCost || 0)) > EPS) {
      bad.push({
        packageId: p.packageId,
        why: `leg costs ${legCost.toFixed(2)} != totalCost ${Number(p.totalCost || 0).toFixed(2)}`,
      });
    }
  }
  record(
    'a full set redeems to exactly $1.00',
    bad.length ? 'FAIL' : 'PASS',
    bad.length ? `${bad.length} problem(s) across ${packages.length} package(s)` : `${packages.length} package(s) consistent`,
    bad.length ? bad : null,
  );
}

// ------------------------------------- 2. cash reconciles to trades + fees + open cost

{
  const cost = (t) => {
    const shares = Number(t.shares) > 0
      ? Number(t.shares)
      : Number(t.entryPrice) > 0 && Number(t.size) > 0
        ? Number(t.size) / Number(t.entryPrice)
        : 0;
    return shares * Number(t.entryPrice || 0);
  };
  const closed = trades.filter((t) => t.closed || t.exitPrice != null);
  const open = positions.filter((p) => !(p.closed || p.exitPrice != null));

  // `feesPaid` is the canonical running total (entry + any exit fee); the
  // component fields are fallbacks for older records.
  const feeOf = (t) =>
    Number.isFinite(Number(t.feesPaid))
      ? Number(t.feesPaid)
      : Number(t.entryFee || 0) + Number(t.exitFee || 0);

  const realized = closed.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const grossPnl = closed.reduce((s, t) => {
    const shares = Number(t.shares) > 0 ? Number(t.shares) : 0;
    if (!shares || t.exitPrice == null) return s + Number(t.pnl || 0);
    return s + (Number(t.exitPrice) - Number(t.entryPrice)) * shares;
  }, 0);
  const feesRecorded = trades.reduce((s, t) => s + feeOf(t), 0);
  const openCost = open.reduce((s, p) => s + cost(p), 0);

  const cfg = store.config || {};
  const strat = cfg.profiles?.paper || cfg;
  const bankroll = Number(strat.paperBankroll ?? cfg.paperBankroll ?? NaN);
  const initial = Number(
    strat.paperInitialDeposit ?? cfg.paperInitialDeposit ?? strat.paperStartingBankroll ?? NaN,
  );

  const detail = {
    closedTrades: closed.length,
    openPositions: open.length,
    realizedPnl: round2(realized),
    feesRecordedOnTrades: round2(feesRecorded),
    openCostBasis: round2(openCost),
    paperBankrollNow: Number.isFinite(bankroll) ? round2(bankroll) : null,
    paperInitialDeposit: Number.isFinite(initial) ? round2(initial) : null,
  };

  if (!Number.isFinite(bankroll) || !Number.isFinite(initial)) {
    record(
      'cash reconciles to trades + fees + open cost',
      'UNKNOWN',
      'cannot reconcile — the store does not record an initial deposit to reconcile against',
      detail,
    );
  } else {
    // expected cash = initial deposit + realized pnl - fees - cost of still-open positions
    const expected = initial + realized - feesRecorded - openCost;
    const drift = bankroll - expected;
    detail.expectedCash = round2(expected);
    detail.actualCash = round2(bankroll);
    detail.drift = round2(drift);
    // What a fee-blind recompute (item 23) would set it to, for comparison.
    detail.feeBlindRecomputeWouldSet = round2(initial + realized - openCost);
    record(
      'cash reconciles to trades + fees + open cost',
      Math.abs(drift) <= EPS ? 'PASS' : 'FAIL',
      Math.abs(drift) <= EPS
        ? 'cash matches trades + fees + open cost'
        : `cash is off by $${round2(drift)} (have $${round2(bankroll)}, expected $${round2(expected)})`,
      detail,
    );

    // Item 23 tripwire: is the recorded pnl gross or net of fees?
    const pnlIsGross = Math.abs(grossPnl - realized) < Math.max(EPS, feesRecorded * 0.1);
    record(
      'recorded trade P/L is net of fees',
      pnlIsGross && feesRecorded > 0 ? 'FAIL' : 'PASS',
      pnlIsGross && feesRecorded > 0
        ? `trade.pnl matches (exit-entry)x shares to within rounding — it is GROSS of $${round2(feesRecorded)} in fees (item 23)`
        : 'trade P/L accounts for fees',
      { sumGross: round2(grossPnl), sumRecordedPnl: round2(realized), sumFees: round2(feesRecorded) },
    );
  }

  const withFees = trades.filter((t) => feeOf(t) > 0).length;
  record(
    'fees are recorded on trades',
    withFees === trades.length && trades.length > 0 ? 'PASS' : trades.length ? 'FAIL' : 'UNKNOWN',
    trades.length
      ? `${withFees}/${trades.length} trades carry a fee field — the rest reconcile as if trading were free`
      : 'no trades in store',
  );
}

// ---------------------------------- 3. every package reaches a terminal state

{
  const TERMINAL = new Set(['SETTLED', 'ABORTED', 'UNWOUND', 'CLOSED']);
  const byStatus = {};
  const stuck = [];
  const now = Date.now();
  for (const p of packages) {
    const st = String(p.status || 'UNKNOWN');
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (!TERMINAL.has(st)) {
      const ageH = (now - Number(p.createdAt || now)) / 3600000;
      stuck.push({
        packageId: p.packageId,
        status: st,
        slug: p.slug,
        ageHours: Math.round(ageH * 10) / 10,
      });
    }
  }
  record(
    'every package reaches a terminal state',
    stuck.length ? 'FAIL' : 'PASS',
    stuck.length
      ? `${stuck.length} package(s) non-terminal — each permanently consumes a maxArbPackages slot (items 9, 10)`
      : `all ${packages.length} package(s) terminal`,
    stuck.length ? { byStatus, stuck } : { byStatus },
  );
}

// ------------------------- 4. arb legs are paired or unwound — never left naked

{
  const legs = [...trades, ...positions].filter((t) => t.isArbLeg || t.packageId);
  const byPkg = new Map();
  for (const l of legs) {
    const k = l.packageId || '(none)';
    if (!byPkg.has(k)) byPkg.set(k, new Map());
    byPkg.get(k).set(l.id, l); // de-dupe: positions and trades share ids
  }
  const naked = [];
  for (const [pkgId, m] of byPkg) {
    const outcomes = new Set([...m.values()].map((l) => String(l.outcome || '').toLowerCase()));
    if (m.size === 1 || outcomes.size < 2) {
      naked.push({
        packageId: pkgId,
        legs: m.size,
        outcomes: [...outcomes],
        why: 'one side only — settles at a fabricated $0.50 regardless of the real outcome (item 8)',
      });
    }
  }
  // A package whose legs have no trade/position records at all is orphaned —
  // usually because resetPaperData cleared trades but not packages (item 24).
  const orphaned = packages
    .filter((p) => !byPkg.has(p.packageId))
    .map((p) => ({ packageId: p.packageId, slug: p.slug, status: p.status }));

  const problems = naked.length + orphaned.length;
  const orphanedSettled = orphaned.filter((o) => o.status === 'SETTLED');
  const phantomProfit = packages
    .filter((p) => orphanedSettled.some((o) => o.packageId === p.packageId))
    .reduce((s, p) => s + Number(p.lockedProfitUsd || 0), 0);

  record(
    'arb legs are paired or unwound — never left naked',
    problems ? 'FAIL' : 'PASS',
    problems
      ? `${naked.length} naked leg group(s), ${orphaned.length} package(s) with no leg records` +
          (orphanedSettled.length
            ? ` — ${orphanedSettled.length} SETTLED orphans report $${round2(phantomProfit)} of fee-blind profit via the lockedProfitUsd fallback (items 7, 24)`
            : '')
      : `${byPkg.size} package leg group(s), all paired`,
    problems ? { naked, orphaned } : null,
  );
}

// ------------------- 5. operator settings are never silently overwritten

{
  // Auditable proxy for the live case: item 19. Live risk caps must never sit
  // wider than defaultLiveStrategy(), which is what the flat->profiles
  // migration did silently.
  const live = store.config?.profiles?.live || null;
  if (!live) {
    record(
      'operator settings are never silently overwritten',
      'UNKNOWN',
      'no live profile in this store to check against defaultLiveStrategy()',
    );
  } else {
    const defaults = defaultLiveStrategy();
    const CAPS = [
      'maxPositionCap',
      'maxPositionSize',
      'maxPositionPct',
      'certaintyMaxUsd',
      'certaintyMaxPct',
      'arbMaxUsd',
      'arbBankrollFrac',
      'maxOpenPositions',
      'kellyFraction',
    ];
    const widened = [];
    for (const k of CAPS) {
      const actual = Number(live[k]);
      const cap = Number(defaults[k]);
      if (!Number.isFinite(actual) || !Number.isFinite(cap)) continue;
      if (actual > cap) {
        widened.push({
          field: k,
          actual,
          liveDefault: cap,
          inflation: `${Math.round((actual / cap) * 10) / 10}x`,
        });
      }
    }
    record(
      'operator settings are never silently overwritten',
      widened.length ? 'FAIL' : 'PASS',
      widened.length
        ? `${widened.length} live risk cap(s) sit above defaultLiveStrategy() (item 19)`
        : 'all live risk caps at or inside their defaults',
      widened.length ? widened : null,
    );
  }
}

// --------------------------------- data-integrity checks (items 14, 15)

{
  const file = path.join(DATA_DIR, 'session_perf.json');
  const count = (v) => (Array.isArray(v) ? v.length : Array.isArray(v?.sessions) ? v.sessions.length : null);
  const rowN = count(store.sessionPerf);
  let diskN = null;
  if (fs.existsSync(file)) {
    try {
      diskN = count(JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch {
      diskN = null;
    }
  }
  if (diskN == null) {
    record('session_perf is not shadowed by a stale file', 'PASS', `no stale session_perf.json on disk (store has ${rowN ?? 'n/a'})`);
  } else if (rowN != null && diskN > rowN) {
    record(
      'session_perf is not shadowed by a stale file',
      'FAIL',
      `disk has ${diskN} sessions, store has ${rowN} — ${diskN - rowN} invisible to the optimizer (item 14)`,
      { diskSessions: diskN, storeSessions: rowN, file },
    );
  } else {
    record('session_perf is not shadowed by a stale file', 'PASS', `store ${rowN} >= disk ${diskN}`);
  }

  const stale = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'))
    : [];
  record(
    'the data dir has one representation of state',
    stale.length && store.backend === 'sqlite' ? 'FAIL' : 'PASS',
    stale.length && store.backend === 'sqlite'
      ? `${stale.length} JSON file(s) sit beside zinger.db and are re-imported as truth if the db is lost (item 14)`
      : 'no shadowing JSON files',
    stale.length && store.backend === 'sqlite' ? stale : null,
  );
}

// ------------------------------------------------------------------ report

if (asJson) {
  console.log(JSON.stringify({ dataDir: DATA_DIR, backend: store.backend, findings }, null, 2));
} else {
  const mark = { PASS: '✅', FAIL: '❌', UNKNOWN: '⚠️ ' };
  console.log(`\nZinger store audit — ${new Date().toISOString()}`);
  console.log(`  data dir : ${DATA_DIR}`);
  console.log(`  backend  : ${store.backend}`);
  console.log(
    `  contents : ${packages.length} packages · ${trades.length} trades · ${positions.length} positions\n`,
  );
  for (const f of findings) {
    console.log(`${mark[f.status] || '  '} ${f.invariant}`);
    console.log(`     ${f.summary}`);
    if (f.detail) {
      for (const line of JSON.stringify(f.detail, null, 2).split('\n')) {
        console.log(`     ${line}`);
      }
    }
    console.log('');
  }
  const fails = findings.filter((f) => f.status === 'FAIL').length;
  const unknown = findings.filter((f) => f.status === 'UNKNOWN').length;
  console.log(
    `${fails} failing · ${unknown} indeterminate · ${findings.length - fails - unknown} passing\n`,
  );
  console.log('This is a snapshot of state, not a test result. Record it in docs/refactor-plan.md.\n');
}
