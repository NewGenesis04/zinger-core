import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  detectAndExecuteArbPackage,
  isComplementaryBinary,
  syncPackageSettlements,
  reconcilePendingPackages,
} from '../../src/polymarket/arbEngine.js';
import { saveAllPackages, loadPackages, getActivePackages, savePackage } from '../../src/polymarket/arbPersistence.js';
import { takerFeeUsdc, closeProceedsWithFee, FEE_RATES, arbBreakEvenGap } from '../../src/polymarket/fees.js';
import { tradeNetPnl, tradeFeesPaid, tradeRealizedPnl, tradeEngine } from '../../src/polymarket/audit.js';
import { computeRecentExpectancy, evaluateEdgeGate } from '../../src/polymarket/edge.js';
import { normalizeConfigStore, defaultLiveStrategy } from '../../src/polymarket/modeConfig.js';
import { booksCash, createPaperCashLedger, roundCash } from '../../src/polymarket/ledger/cash.js';
import { resolveSettlementPrice } from '../../src/polymarket/positions/settle.js';

/**
 * Slice-0 invariants — the ones that hold today.
 *
 * These test *code behaviour* against fixtures, never production data. A suite
 * whose result depends on what happens to be in `data/` cannot tell a code
 * defect from a data artifact, and against an empty store it passes trivially.
 * State questions belong in `scripts/audit-store.ts`, which runs once.
 *
 * Invariants that do NOT hold yet live in `invariants.pending.test.ts`. They
 * are the acceptance criteria for slices 1–3.
 *
 * These are deliberately *invariants*, not characterization tests. A snapshot of
 * current behaviour would have frozen the `cccce43` bug rather than caught it —
 * the test shipped with that regression asserted the broken behaviour and CI
 * stayed green for six days.
 */

const market = (over = {}) => ({
  symbol: 'BTC',
  slug: 'btc-updown-5m-1787000000',
  conditionId: '0xcondition',
  outcomes: ['Up', 'Down'],
  tokenIds: { up: 'token-up', down: 'token-down' },
  acceptingOrders: true,
  negRisk: false, // Polymarket reports false on every market this bot trades
  ...over,
});

const cfg = (over = {}) => ({
  clobArbEnabled: true,
  minArbGap: 0.015,
  maxArbPackages: 4,
  paperBankroll: 100,
  arbBankrollFrac: 0.2,
  arbMaxUsd: 50,
  minPositionSize: 0.5,
  mode: 'paper',
  ...over,
});

const runArb = (over = {}) =>
  detectAndExecuteArbPackage({
    market: market(),
    depth: { up: { bestAsk: 0.34 }, down: { bestAsk: 0.62 } },
    prices: { up: 0.34, down: 0.62 },
    cfg: cfg(),
    mode: 'paper',
    log: () => {},
    // executePendingTrade returns { ok, ... } on every path — never a bare
    // boolean. Stubbing a boolean is what let the item 27 truthiness bug hide.
    executeTrade: async () => ({ ok: true }),
    botState: { config: {}, positions: [] },
    ...over,
  });

beforeEach(() => {
  saveAllPackages([]);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: a full set redeems to exactly $1.00', () => {
  it('holds arb open to complementary binaries regardless of negRisk', () => {
    // The $1.00 guarantee comes from the CTF binary split — one conditionId,
    // two complementary outcome tokens — NOT from negRisk. Gating on negRisk
    // disabled arb outright for six days (cccce43). This test is that guard.
    expect(isComplementaryBinary(market({ negRisk: false }))).toBe(true);
    expect(isComplementaryBinary(market({ negRisk: true }))).toBe(true);
    expect(isComplementaryBinary(market({ negRisk: undefined }))).toBe(true);
  });

  it('rejects anything that cannot redeem $1.00 as a pair', () => {
    expect(isComplementaryBinary(market({ conditionId: null }))).toBe(false);
    expect(isComplementaryBinary(market({ outcomes: ['A', 'B', 'C'] }))).toBe(false);
    // Same token on both sides is two of one outcome, not a full set.
    expect(isComplementaryBinary(market({ tokenIds: { up: 'same', down: 'same' } }))).toBe(false);
    expect(isComplementaryBinary(market({ tokenIds: { up: 'token-up' } }))).toBe(false);
  });

  it('gives both legs equal shares, so the pair redeems $1.00/set', async () => {
    // Unequal legs are not a hedge: the excess on one side is a naked
    // directional position wearing an arb label.
    //
    // Every book here must clear fee break-even, or the engine correctly
    // refuses it and there is no package to inspect (item 7). 0.48/0.49 used to
    // be in this list: gap 3.0% against a 3.50% break-even, i.e. a structural
    // loser that only opened because the old gate was fee-blind. 0.45/0.48 keeps
    // the intent — a near-50/50 book, the most expensive end of the p(1−p)
    // curve — with a gap that actually pays.
    for (const [up, down] of [
      [0.34, 0.62],
      [0.10, 0.85],
      [0.45, 0.48],
      [0.71, 0.24],
    ]) {
      saveAllPackages([]);
      const pkg = await runArb({
        depth: { up: { bestAsk: up }, down: { bestAsk: down } },
        prices: { up, down },
      });
      expect(pkg, `no package at ${up}/${down}`).toBeTruthy();
      expect(pkg.legs.up.shares).toBe(pkg.legs.down.shares);
      expect(pkg.shares).toBe(pkg.legs.up.shares);
    }
  });

  it('values the redeemed set at exactly shares x $1.00', async () => {
    const pkg = await runArb();
    expect(pkg.expectedPayout).toBeCloseTo(pkg.shares * 1.0, 2);
    // and the recorded costs must add up to what was actually spent
    expect(pkg.upCost + pkg.downCost).toBeCloseTo(pkg.totalCost, 2);
  });

  it('never opens a package when the book offers no gap', async () => {
    // asks summing to >= $1.00 cannot redeem for more than they cost
    const pkg = await runArb({
      depth: { up: { bestAsk: 0.52 }, down: { bestAsk: 0.49 } },
      prices: { up: 0.52, down: 0.49 },
    });
    expect(pkg).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: the fee model matches Polymarket', () => {
  // Verified live 2026-08-19 against GET /clob-markets/{conditionId} on a real
  // BTC market: {"r": 0.07, "e": 1, "to": true}. See
  // docs/research/polymarket-domain-facts.md — do not "simplify" this formula.
  it('charges shares x rate x (p(1-p))^exponent', () => {
    const shares = 10;
    const price = 0.4;
    const rate = FEE_RATES.crypto?.rate ?? 0.07;
    const exponent = FEE_RATES.crypto?.exponent ?? 1;
    const expected = shares * rate * (price * (1 - price)) ** exponent;
    expect(takerFeeUsdc(shares, price, 'crypto')).toBeCloseTo(expected, 6);
  });

  it('is symmetric across a complementary pair, since p(1-p) is', () => {
    // This symmetry is what makes break-even gap = 2 x rate x p(1-p).
    for (const p of [0.1, 0.23, 0.34, 0.5]) {
      expect(takerFeeUsdc(10, p, 'crypto')).toBeCloseTo(takerFeeUsdc(10, 1 - p, 'crypto'), 9);
    }
  });

  it('peaks at 50/50 — the most expensive book to arb', () => {
    // Break-even gap is therefore price-dependent, so a single flat minArbGap
    // is wrong in both directions (item 7).
    const at50 = takerFeeUsdc(10, 0.5, 'crypto');
    expect(at50).toBeGreaterThan(takerFeeUsdc(10, 0.23, 'crypto'));
    expect(at50).toBeGreaterThan(takerFeeUsdc(10, 0.1, 'crypto'));
  });

  it('charges nothing on a degenerate price', () => {
    expect(takerFeeUsdc(10, 0, 'crypto')).toBe(0);
    expect(takerFeeUsdc(10, 1, 'crypto')).toBe(0);
    expect(takerFeeUsdc(0, 0.5, 'crypto')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: arb legs are paired or unwound — never left naked', () => {
  it('aborts the package when one leg fails', async () => {
    let calls = 0;
    const pkg = await runArb({
      // first leg fills, second is refused
      executeTrade: async () => (++calls === 1 ? { ok: true } : { ok: false, error: 'refused' }),
    });
    expect(pkg.status).toBe('ABORTED');
    expect(pkg.abortReason).toMatch(/UP=OK, DOWN=FAIL/);
  });

  it('unwinds the filled leg rather than leaving it naked', async () => {
    const positions: any[] = [];
    const botState = { config: {}, positions };
    let calls = 0;
    const refunds: number[] = [];

    const pkg = await detectAndExecuteArbPackage({
      market: market(),
      depth: { up: { bestAsk: 0.34 }, down: { bestAsk: 0.62 } },
      prices: { up: 0.34, down: 0.62 },
      cfg: cfg(),
      mode: 'paper',
      log: () => {},
      adjustPaperCash: (amount: number) => refunds.push(amount),
      executeTrade: async (pending: any) => {
        const ok = ++calls === 1;
        if (ok) {
          positions.push({
            id: pending.id,
            packageId: pending.plan.packageId,
            outcome: pending.outcome,
            symbol: pending.symbol,
            shares: pending.plan.shares,
            entryPrice: pending.plan.entryPrice,
            costBasis: pending.plan.costEst,
            closed: false,
          });
        }
        return ok ? { ok: true } : { ok: false, error: 'refused' };
      },
      botState,
    });

    expect(pkg.status).toBe('ABORTED');
    // the filled leg must be closed out, not left holding exposure
    expect(positions[0].closed).toBe(true);
    expect(positions[0].exitReason).toBe('arb_rollback');
    // `pnl` used to be asserted as exactly 0 — a characterization assertion
    // that froze the fee-blind refund as correct. A rollback is a taker buy
    // followed by a taker sell, so it costs both fees and can never be free.
    expect(positions[0].pnl).toBeLessThan(0);
    expect(positions[0].pnl).toBeCloseTo(
      -(Number(positions[0].entryFee || 0) + Number(positions[0].exitFee || 0)), 2,
    );
    // and the premium must come back
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toBeGreaterThan(0);
  });

  it('does not open a second package on a slug it already holds', async () => {
    const first = await runArb();
    expect(first.status).toBe('LOCKED');
    const second = await runArb();
    expect(second).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: every package reaches a terminal state', () => {
  it('settles a LOCKED package once both legs have closed', () => {
    const pkg: any = {
      packageId: 'pkg-test-1',
      symbol: 'BTC',
      slug: 'btc-updown-5m-1',
      shares: 10,
      status: 'LOCKED',
      mode: 'paper',
      createdAt: Date.now(),
      legs: {
        up: { outcome: 'up', shares: 10, filled: true },
        down: { outcome: 'down', shares: 10, filled: true },
      },
    };
    savePackage(pkg);

    const trades = [
      { packageId: 'pkg-test-1', closed: true, pnl: 2.0 },
      { packageId: 'pkg-test-1', closed: true, pnl: -1.5 },
    ];
    expect(syncPackageSettlements(trades, 'paper')).toBe(true);
    expect(loadPackages()[0].status).toBe('SETTLED');
    // and a terminal package must stop consuming capacity
    expect(getActivePackages('paper')).toHaveLength(0);
  });

  it('leaves a package LOCKED while only one leg has closed', () => {
    const pkg: any = {
      packageId: 'pkg-test-2',
      symbol: 'BTC',
      slug: 'btc-updown-5m-2',
      shares: 10,
      status: 'LOCKED',
      mode: 'paper',
      createdAt: Date.now(),
      legs: { up: { filled: true }, down: { filled: true } },
    };
    savePackage(pkg);
    syncPackageSettlements([{ packageId: 'pkg-test-2', closed: true, pnl: 1 }], 'paper');
    // Settling a half-closed package would book a fabricated payout.
    expect(loadPackages()[0].status).toBe('LOCKED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: cash reconciles to trades + fees + open cost', () => {
  // Backlog item 23. Paper cash has two writers — the incremental ledger
  // (adjustPaperCash: debit premium+fee on entry, credit proceeds−fee on exit)
  // and the recompute (reconcilePaperCash: initial + realized − openCost).
  // The recompute had no fee term and always overwrote, so it refunded every
  // fee. On production it would have moved cash $100.70 → $102.66.
  //
  // The invariant is that the two agree. This block tests the primitives both
  // are built from; the block below tests the real `ledger/cash.ts` writers now
  // that slice 2 has moved them out of bot.ts.

  const trade = (over: any = {}) => ({
    mode: 'paper',
    closed: true,
    entryPrice: 0.4,
    exitPrice: 0.55,
    shares: 10,
    entryFee: 0.168,
    exitFee: 0.1485,
    feesPaid: 0.3165,
    ...over,
  });

  it('books realized P/L net of every fee paid', () => {
    const t = trade();
    // gross = (0.55 − 0.40) × 10 = 1.50 ; fees = 0.3165
    expect(tradeRealizedPnl(t)).toBeCloseTo(1.5, 2);
    expect(tradeFeesPaid(t)).toBeCloseTo(0.3165, 4);
    expect(tradeNetPnl(t)).toBeCloseTo(1.5 - 0.3165, 2);
  });

  it('falls back to the component fees when feesPaid is absent', () => {
    // Records written before feesPaid existed must still reconcile.
    const t = trade({ feesPaid: undefined });
    expect(tradeFeesPaid(t)).toBeCloseTo(0.168 + 0.1485, 4);
  });

  it('derives net P/L from primitives, not from a stored gross pnl', () => {
    // History written before the item 23 fix carries a GROSS `pnl` and nothing
    // marks it as such. Trusting that field would re-introduce the drift.
    const t = trade({ pnl: 1.5 }); // stored gross
    expect(tradeNetPnl(t)).toBeCloseTo(1.1835, 2);
    expect(tradeNetPnl(t)).not.toBeCloseTo(Number(t.pnl), 2);
  });

  it('makes the incremental ledger and the recompute agree', () => {
    const initial = 100;
    const closed = [
      trade(),
      trade({ entryPrice: 0.62, exitPrice: 0.5, shares: 10.4, entryFee: 0.175, exitFee: 0, feesPaid: 0.175 }),
      trade({ entryPrice: 0.2, exitPrice: 0.5, shares: 10.2, entryFee: 0.114, exitFee: 0, feesPaid: 0.114 }),
    ];
    const open = [{ mode: 'paper', closed: false, costBasis: 4.2, entryFee: 0.17 }];

    // How the incremental ledger arrives at the balance, entry by entry.
    let incremental = initial;
    for (const t of [...closed, ...open]) {
      const cost = t.closed ? t.shares * t.entryPrice : Number(t.costBasis);
      incremental -= cost + Number(t.entryFee || 0);
      if (t.closed) incremental += t.shares * t.exitPrice - Number(t.exitFee || 0);
    }

    // How the recompute arrives at it.
    const recomputed =
      initial +
      closed.reduce((s, t) => s + tradeNetPnl(t), 0) -
      open.reduce((s, p) => s + Number(p.costBasis || 0) + Number(p.entryFee || 0), 0);

    expect(recomputed).toBeCloseTo(incremental, 2);
  });

  it('treats settlement as fee-free but a mid-window sell as taker', () => {
    // executeSell depends on this split: redeeming a resolved token is not a
    // taker CLOB sell, so charging it a fee would understate settle P/L.
    expect(closeProceedsWithFee(10, 0.5, 'crypto', 'settle').fee).toBe(0);
    expect(closeProceedsWithFee(10, 0.5, 'crypto', 'orphan_settle').fee).toBe(0);
    expect(closeProceedsWithFee(10, 0.5, 'crypto', 'sl').fee).toBeGreaterThan(0);
    expect(closeProceedsWithFee(10, 0.5, 'crypto', 'tp').fee).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: operator settings are never silently overwritten', () => {
  it('keeps the live edge gate locked when migrating a legacy flat config', () => {
    // The author anticipated this hazard for the gate flags specifically.
    const migrated = normalizeConfigStore({
      mode: 'paper',
      arbOnlyUntilEdge: false,
      requireEdgeForLive: false,
    });
    expect(migrated.profiles.live.arbOnlyUntilEdge).toBe(true);
    expect(migrated.profiles.live.requireEdgeForLive).toBe(true);
  });

  it('does not let a paper profile leak into the live profile when profiles exist', () => {
    const migrated = normalizeConfigStore({
      profiles: {
        paper: { maxPositionCap: 100, arbMaxUsd: 50 },
        live: {},
      },
    });
    const defaults = defaultLiveStrategy();
    expect(migrated.profiles.live.maxPositionCap).toBe(defaults.maxPositionCap);
    expect(migrated.profiles.live.arbMaxUsd).toBe(defaults.arbMaxUsd);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: the directional edge gate scores directional trades only', () => {
  // Backlog item 6. The gate decides whether directional trading is allowed and
  // whether real money is allowed (`requireEdgeForLive`). Its input must be
  // trades that tested a directional signal.
  //
  // An arb package buys both sides of one market, so paper settlement books one
  // leg near +$1/share and the other near −$1/share. Which leg "wins" is fixed
  // at purchase time by which side was cheaper — before the market resolves. A
  // win rate computed over them measures that a hedge cancels, not that a
  // signal predicts.

  const arbPair = (pkgId, upEntry, downEntry, shares = 10) => [
    {
      id: `${pkgId}-up`, mode: 'paper', closed: true, exitReason: 'settle',
      packageId: pkgId, isArbLeg: true, outcome: 'up', shares,
      entryPrice: upEntry, exitPrice: 0.5, feesPaid: 0,
      pnl: Math.round((0.5 - upEntry) * shares * 100) / 100, timestamp: Date.now(),
    },
    {
      id: `${pkgId}-down`, mode: 'paper', closed: true, exitReason: 'settle',
      packageId: pkgId, isArbLeg: true, outcome: 'down', shares,
      entryPrice: downEntry, exitPrice: 0.5, feesPaid: 0,
      pnl: Math.round((0.5 - downEntry) * shares * 100) / 100, timestamp: Date.now(),
    },
  ];

  const directional = (id, entry, exit, shares = 10) => ({
    id, mode: 'paper', closed: true, exitReason: exit > entry ? 'tp' : 'sl',
    outcome: 'up', shares, entryPrice: entry, exitPrice: exit, feesPaid: 0,
    pnl: Math.round((exit - entry) * shares * 100) / 100, timestamp: Date.now(),
  });

  it('classifies every trade to exactly one engine', () => {
    const [up, down] = arbPair('pkg-1', 0.25, 0.72);
    expect(tradeEngine(up)).toBe('arb');
    expect(tradeEngine(down)).toBe('arb');
    expect(tradeEngine(directional('d1', 0.6, 0.7))).toBe('directional');
    // An explicit tag wins over the legacy markers, so a future engine cannot
    // be misfiled by inheriting the directional default.
    expect(tradeEngine({ engine: 'arb' })).toBe('arb');
    expect(tradeEngine({ engine: 'directional', isArbLeg: true })).toBe('directional');
  });

  it('ignores arb legs no matter how many there are', () => {
    const legs = [
      ...arbPair('pkg-1', 0.25, 0.72),
      ...arbPair('pkg-2', 0.29, 0.65),
      ...arbPair('pkg-3', 0.39, 0.50),
    ];
    const only = computeRecentExpectancy(legs);
    expect(only.n).toBe(0);

    // Adding them to a directional sample must not move a single statistic.
    const dirs = [directional('d1', 0.6, 0.7), directional('d2', 0.5, 0.42), directional('d3', 0.3, 0.55)];
    const clean = computeRecentExpectancy(dirs);
    const polluted = computeRecentExpectancy([...dirs, ...legs]);
    expect(polluted).toEqual(clean);
  });

  it('cannot be pushed past the sample threshold by arb legs alone', () => {
    // The live-money failure mode: 20 packages is 40 rows, which would clear
    // `edgeMinTrades: 40` on evidence that never tested a directional signal.
    const legs = [];
    for (let i = 0; i < 20; i += 1) legs.push(...arbPair(`pkg-${i}`, 0.25, 0.72));
    expect(legs.length).toBe(40);

    const gate = evaluateEdgeGate(legs, { edgeMinTrades: 40 });
    expect(gate.n).toBe(0);
    expect(gate.edgeOk).toBe(false);
    expect(gate.arbOnly).toBe(true);
    expect(gate.liveAllowed).toBe(false);
  });

  it('still scores a genuine directional sample', () => {
    // The filter must not be so broad that the gate can never open — that would
    // be a silent, permanent lock rather than a fix.
    const dirs = [];
    for (let i = 0; i < 40; i += 1) dirs.push(directional(`d${i}`, 0.4, i % 4 === 0 ? 0.3 : 0.55));
    const gate = evaluateEdgeGate(dirs, { edgeMinTrades: 40 });
    expect(gate.n).toBe(40);
    expect(gate.expectancy).toBeGreaterThan(0);
    expect(gate.edgeOk).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: engine slot budgets are independent (D5)', () => {
  // D5: cash is one pool, slots are per engine. Slots are internal counters
  // with nothing to reconcile, and for directional they ARE the risk dial —
  // worst case = slots x position size x SL%. A single shared count makes one
  // number serve two unrelated jobs: raising it for arb headroom silently
  // authorises that much more directional exposure, and arb legs occupying it
  // silently shrink the directional budget.
  //
  // Arb legs contribute ~nothing to worst-case drawdown (hold-to-settle, no
  // meaningful stop), so the two dials are genuinely independent.
  //
  // These test the shape of the accounting, which is what the D4 position
  // manager must preserve in slice 2. `countOpenPositions` is not exported, so
  // the classifier it filters on is what is asserted here.

  const leg = (over = {}) => ({ mode: 'paper', closed: false, packageId: 'pkg-1', isArbLeg: true, ...over });
  const dir = (over = {}) => ({ mode: 'paper', closed: false, ...over });

  const countBy = (positions, engine) =>
    positions.filter((p) => !p.closed && p.mode === 'paper' && tradeEngine(p) === engine).length;

  it('never charges an arb leg against the directional budget', () => {
    const book = [leg({ outcome: 'up' }), leg({ outcome: 'down' }), dir({ outcome: 'up' })];
    expect(countBy(book, 'directional')).toBe(1);
    expect(countBy(book, 'arb')).toBe(2);
  });

  it('a full arb book leaves the directional budget untouched', () => {
    // The concrete failure this prevents: with maxOpenPositions 4 and a shared
    // count, two locked packages (4 legs) blocked directional entry outright,
    // and the boot-time trim then closed legs to get back under 4.
    const book = [];
    for (let i = 0; i < 20; i += 1) {
      book.push(leg({ packageId: `pkg-${i}`, outcome: 'up' }), leg({ packageId: `pkg-${i}`, outcome: 'down' }));
    }
    expect(countBy(book, 'arb')).toBe(40);
    expect(countBy(book, 'directional')).toBe(0);
  });

  it('the two counts always partition the book — nothing double-counted or lost', () => {
    const book = [
      leg({ outcome: 'up' }), leg({ outcome: 'down' }),
      dir({ outcome: 'up' }), dir({ outcome: 'down' }),
      dir({ closed: true }),                      // closed: in neither
      { mode: 'live', closed: false },            // other mode: in neither
      dir({ arb: true }),                         // legacy arb marker
      { mode: 'paper', closed: false, engine: 'arb' },        // explicit tag
      { mode: 'paper', closed: false, engine: 'directional', isArbLeg: true }, // tag beats marker
    ];
    const open = book.filter((p) => !p.closed && p.mode === 'paper').length;
    expect(countBy(book, 'arb') + countBy(book, 'directional')).toBe(open);
  });

  it('closing a directional position never touches a hedged pair', () => {
    // Backlog item 25: the boot-time trim selected the oldest open paper
    // position of any engine, so trimming to maxOpenPositions could close one
    // leg of a pair — manufacturing the naked leg item 8 settles at $0.50.
    const book = [
      leg({ entryTime: 1 }), leg({ entryTime: 2 }),   // oldest, and hedged
      dir({ entryTime: 3 }),
    ];
    const trimCandidates = book
      .filter((p) => !p.closed && p.mode === 'paper' && tradeEngine(p) === 'directional')
      .sort((a, b) => (a.entryTime || 0) - (b.entryTime || 0));
    expect(trimCandidates).toHaveLength(1);
    expect(trimCandidates[0].entryTime).toBe(3);
    expect(trimCandidates.some((p) => p.isArbLeg || p.packageId)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: a refused arb leg is never recorded as filled', () => {
  // Backlog item 27, promoted from invariants.pending.test.ts once fixed.
  //
  // `executeArbLeg` used to coerce executePendingTrade's return with `!!`, and
  // every return path of that function is an object — a refusal
  // (`{ ok: false, error: 'max open positions' }`) is exactly as truthy as a
  // fill. The boolean carried no information, so the rollback handler was
  // unreachable for anything short of a thrown exception, and a refused leg was
  // written into history as filled.
  //
  // Two artifacts it produced, both now impossible:
  //   both refused  -> a LOCKED package with zero positions, reporting profit
  //                    on a trade that never happened
  //   one refused   -> a naked leg held in the belief that it was hedged

  const REFUSED = { ok: false, error: 'max open positions' };

  // Mirrors executePendingTrade's paper branch closely enough to test the
  // contract: a fill creates a position and debits premium + entry fee.
  const harness = (accept) => {
    const positions = [];
    const trades = [];
    const cash = { v: 100 };
    let n = 0;
    const adjustPaperCash = (d) => { cash.v = Math.round((cash.v + d) * 100) / 100; };
    const executeTrade = async (pending) => {
      n += 1;
      if (!accept(n)) return REFUSED;
      const { shares, entryPrice: px, packageId } = pending.plan;
      const premium = Math.round(shares * px * 100) / 100;
      const entryFee = takerFeeUsdc(shares, px, 'crypto');
      adjustPaperCash(-Math.round((premium + entryFee) * 100) / 100);
      positions.push({
        id: pending.id, symbol: pending.symbol, slug: pending.slug, outcome: pending.outcome,
        shares, entryPrice: px, costBasis: premium, entryFee, feesPaid: entryFee,
        packageId, isArbLeg: true, closed: false, mode: 'paper',
      });
      return { ok: true, position: {} };
    };
    return { positions, trades, cash, adjustPaperCash, executeTrade };
  };

  const runWith = async (accept) => {
    const h = harness(accept);
    const pkg = await detectAndExecuteArbPackage({
      market: market(),
      depth: { up: { bestAsk: 0.34 }, down: { bestAsk: 0.62 } },
      prices: { up: 0.34, down: 0.62 },
      cfg: cfg({ simulateClobFees: true, feeCategory: 'crypto' }),
      mode: 'paper',
      log: () => {},
      executeTrade: h.executeTrade,
      adjustPaperCash: h.adjustPaperCash,
      saveTrade: (t) => h.trades.push(t),
      botState: { config: {}, positions: h.positions },
    });
    return { pkg, ...h };
  };

  it('does not lock a package when both legs were refused', async () => {
    const { pkg, positions, cash } = await runWith(() => false);
    expect(pkg.status).not.toBe('LOCKED');
    expect(pkg.legs.up.filled).toBe(false);
    expect(pkg.legs.down.filled).toBe(false);
    // Nothing bought means nothing spent.
    expect(positions.filter((p) => !p.closed)).toHaveLength(0);
    expect(cash.v).toBe(100);
  });

  it('aborts and unwinds when only one leg was accepted', async () => {
    for (const [label, accept] of [['up fills', (n) => n === 1], ['down fills', (n) => n === 2]]) {
      const { pkg, positions } = await runWith(accept);
      expect(pkg.status, label).toBe('ABORTED');
      expect(pkg.abortReason, label).toMatch(/mismatch/i);
      // The whole point: never leave a pair half-open.
      expect(positions.filter((p) => !p.closed), label).toHaveLength(0);
      saveAllPackages([]);
    }
  });

  it('records the rollback as a trade, so the close is not invisible', async () => {
    const { trades, positions } = await runWith((n) => n === 1);
    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe('arb_rollback');
    expect(positions[0].closed).toBe(true);
  });

  it('charges both taker fees on a rollback — a round trip is not free', async () => {
    // The refund used to return the entry fee too, modelling the unwind as
    // costless. Buying and selling back are two taker trades.
    const { trades } = await runWith((n) => n === 1);
    const t = trades[0];
    expect(t.entryFee).toBeGreaterThan(0);
    expect(t.exitFee).toBeGreaterThan(0);
    expect(tradeFeesPaid(t)).toBeCloseTo(Number(t.entryFee) + Number(t.exitFee), 5);
    // Sold back at the entry price, so the fees are the entire loss.
    expect(tradeNetPnl(t)).toBeCloseTo(-(Number(t.entryFee) + Number(t.exitFee)), 2);
  });

  it('cash still reconciles after a rollback', async () => {
    // The coupling that makes the two fixes one change: the reconciler derives
    // realized P/L from feesPaid, so recording the trade while refunding the
    // fee would put the ledger and the recompute exactly one fee apart.
    for (const accept of [() => true, () => false, (n) => n === 1, (n) => n === 2]) {
      const { positions, trades, cash } = await runWith(accept);
      const realized = trades.reduce((s, t) => s + tradeNetPnl(t), 0);
      const openCost = positions
        .filter((p) => !p.closed)
        .reduce((s, p) => s + Number(p.costBasis || 0) + Number(p.entryFee || 0), 0);
      const recompute = Math.round((100 + realized - openCost) * 100) / 100;
      expect(Math.abs(cash.v - recompute)).toBeLessThanOrEqual(0.02);
      saveAllPackages([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: an accepted arb package is profitable after fees', () => {
  // Backlog item 7, promoted from invariants.pending.test.ts once fixed.
  //
  // Profit per share IS the gap, because a full set redeems exactly $1.00. Each
  // leg is a taker buy paying rate x (p(1-p))^e per share, so break-even is a
  // property of the book:
  //
  //   break-even gap = rate x [ (u(1-u))^e + (d(1-d))^e ]
  //
  // A flat minArbGap is therefore wrong in both directions. The shipped 0.015
  // default lost money on any book between roughly $0.12 and $0.88; the
  // operator's 0.035 stop-gap was right at 50/50 and threw away skewed books
  // that needed under 2%.

  it('matches the break-even figures verified against a real fee schedule', () => {
    // These three are the anchor: recomputed from the live CLOB schedule
    // ({"r":0.07,"e":1}) and recorded in the plan.
    expect(arbBreakEvenGap(0.50, 0.50, 'crypto')).toBeCloseTo(0.0350, 4);
    expect(arbBreakEvenGap(0.23, 0.77, 'crypto')).toBeCloseTo(0.0248, 4);
    expect(arbBreakEvenGap(0.10, 0.90, 'crypto')).toBeCloseTo(0.0126, 4);
  });

  it('is exactly the two leg fees, so the gate and the ledger cannot disagree', () => {
    // The strongest form: break-even x shares must equal the fees actually
    // charged at fill. If these drift apart the gate is pricing a different
    // trade than the ledger books.
    //
    // The books here deliberately sum to UNDER $1.00 — a real, tradable book.
    // The reference figures above (0.50/0.50, 0.23/0.77, 0.10/0.90) all sum to
    // exactly 1.00, which is the one case where assuming d = 1 - u happens to be
    // right, so they cannot catch a symmetry shortcut. 0.34/0.62 can:
    // curve(0.34) = 0.2244 but curve(0.62) = 0.2356.
    for (const [u, d] of [[0.34, 0.62], [0.83, 0.15], [0.45, 0.48], [0.10, 0.85]]) {
      for (const shares of [1, 20.833, 500]) {
        const be = arbBreakEvenGap(u, d, 'crypto');
        const legFees = takerFeeUsdc(shares, u, 'crypto') + takerFeeUsdc(shares, d, 'crypto');
        expect(be * shares, `${u}/${d} x ${shares}`).toBeCloseTo(legFees, 3);
      }
    }
  });

  it('prices each leg at its own price, not the mirror of the other', () => {
    // Guards the shortcut directly. On a tradable book the two legs sit at
    // different points on the p(1-p) curve, so doubling one leg is wrong in
    // whichever direction the book is skewed.
    const rate = FEE_RATES.crypto;
    const curve = (p) => p * (1 - p);
    for (const [u, d] of [[0.34, 0.62], [0.83, 0.15]]) {
      const doubled = rate * 2 * curve(u);
      const actual = arbBreakEvenGap(u, d, 'crypto');
      expect(actual).not.toBeCloseTo(doubled, 4);
      expect(actual).toBeCloseTo(rate * (curve(u) + curve(d)), 5);
    }
  });

  it('is most expensive at 50/50 and cheapest at the extremes', () => {
    // The shape is what makes a flat threshold wrong. p(1-p) peaks at 0.25.
    const mid = arbBreakEvenGap(0.5, 0.5, 'crypto');
    for (const [u, d] of [[0.3, 0.7], [0.15, 0.85], [0.05, 0.95]]) {
      expect(arbBreakEvenGap(u, d, 'crypto')).toBeLessThan(mid);
    }
  });

  it('fails closed on an unpriceable book', () => {
    // Infinity, not 0 — a caller testing `gap > breakEven` must refuse, never
    // wave the trade through because a price was missing.
    for (const [u, d] of [[0, 0.5], [0.5, 0], [1, 0.5], [1.4, 0.5], [NaN, 0.5]]) {
      expect(arbBreakEvenGap(u, d, 'crypto')).toBe(Infinity);
    }
  });

  it('does not open a package whose gap cannot cover both legs\' fees', async () => {
    // gap 1.6% at a 50/50 book, above the old minArbGap of 1.5% and well below
    // the 3.5% it actually costs. Measured net before the fix: -$0.38.
    const up = 0.492;
    const down = 0.492;
    expect(1 - up - down).toBeGreaterThan(0.015);            // the old gate let it through
    expect(1 - up - down).toBeLessThan(arbBreakEvenGap(up, down, 'crypto'));
    const pkg = await runArb({ depth: { up: { bestAsk: up }, down: { bestAsk: down } }, prices: { up, down } });
    expect(pkg).toBeNull();
  });

  it('still takes a skewed book that a flat 3.5% threshold would refuse', async () => {
    // The other half of the fix. 0.83/0.15 needs only 1.88%, so a 2% gap pays —
    // yet the operator's blunt 0.035 stop-gap rejected it. minArbGap must be low
    // enough not to re-impose the flat floor the fee gate replaced.
    const up = 0.83;
    const down = 0.15;
    const gap = 1 - up - down;
    expect(gap).toBeLessThan(0.035);                          // a flat 3.5% refuses this
    expect(gap).toBeGreaterThan(arbBreakEvenGap(up, down, 'crypto'));
    const pkg = await runArb({
      depth: { up: { bestAsk: up }, down: { bestAsk: down } },
      prices: { up, down },
      cfg: cfg({ minArbGap: 0.005, arbMinMarginPct: 0 }),
    });
    expect(pkg).not.toBeNull();
  });

  it('refuses a losing book at ANY minArbGap, in paper and live', async () => {
    // The guarantee the operator asked for (2026-08-21): minArbGap stays as a
    // param, but the code must prove break-even before accepting a trade —
    // "especially live, paper too".
    //
    // So the two checks are AND, not OR, and the fee gate is first and
    // unconditional. Driving minArbGap and arbMinMarginPct to zero must not open
    // a package that cannot cover its own fees. Nothing here is mode-dependent,
    // which is the point — the gate sits above the paper/live bankroll split.
    const losing = [
      [0.492, 0.492],   // gap 1.6% vs 3.50% break-even
      [0.47, 0.51],     // gap 2.0% vs 3.49%
      [0.30, 0.68],     // gap 2.0% vs 2.94%
      [0.12, 0.87],     // gap 1.0% vs 1.30%
    ];
    for (const [up, down] of losing) {
      const gap = 1 - up - down;
      const be = arbBreakEvenGap(up, down, 'crypto');
      expect(gap, `${up}/${down} must be a loser for this test to mean anything`).toBeLessThan(be);

      for (const minArbGap of [0, 0.001, 0.005, 0.015]) {
        for (const arbMinMarginPct of [0, 0.005]) {
          for (const mode of ['paper', 'live']) {
            saveAllPackages([]); // capacity is per-mode and persists across runs
            const pkg = await runArb({
              depth: { up: { bestAsk: up }, down: { bestAsk: down } },
              prices: { up, down },
              cfg: cfg({ minArbGap, arbMinMarginPct, mode }),
              mode,
              readiness: { spendableBalance: 100 },
            });
            expect(
              pkg,
              `${mode} opened a losing package at ${up}/${down} with minArbGap ${minArbGap} margin ${arbMinMarginPct}`,
            ).toBeNull();
          }
        }
      }
    }
  });

  it('keeps minArbGap working as an operator floor above break-even', async () => {
    // The other direction: the param must still do something, or removing the
    // governor's access to it was pointless. 0.83/0.15 needs 1.88% and offers
    // 2.0% — profitable — so only the operator's floor can refuse it.
    const [up, down] = [0.83, 0.15];
    const gap = 1 - up - down;
    expect(gap).toBeGreaterThan(arbBreakEvenGap(up, down, 'crypto'));

    saveAllPackages([]);
    const refused = await runArb({
      depth: { up: { bestAsk: up }, down: { bestAsk: down } },
      prices: { up, down },
      cfg: cfg({ minArbGap: 0.03, arbMinMarginPct: 0 }),
    });
    expect(refused, 'a floor above the gap must refuse a profitable book').toBeNull();

    saveAllPackages([]);
    const taken = await runArb({
      depth: { up: { bestAsk: up }, down: { bestAsk: down } },
      prices: { up, down },
      cfg: cfg({ minArbGap: 0.005, arbMinMarginPct: 0 }),
    });
    expect(taken, 'a floor below the gap must allow it').not.toBeNull();
  });

  it('reports locked profit net of fees, not gross', async () => {
    const up = 0.34;
    const down = 0.62;
    const pkg = await runArb({ depth: { up: { bestAsk: up }, down: { bestAsk: down } }, prices: { up, down } });
    const fees = takerFeeUsdc(pkg.shares, up, 'crypto') + takerFeeUsdc(pkg.shares, down, 'crypto');
    // lockedProfitUsd is what the UI and session stats report, and what
    // getArbPackageMetrics falls back to for packages whose trades are gone
    // (item 24) — so a gross figure there is permanent phantom profit.
    expect(pkg.lockedProfitUsd).toBeCloseTo(pkg.expectedPayout - pkg.totalCost - fees, 2);
    expect(pkg.lockedProfitUsd).toBeLessThan(pkg.expectedPayout - pkg.totalCost);
  });

  it('never accepts a package whose own recorded numbers show a loss', async () => {
    // The invariant behind all of the above, stated over what the package
    // itself records: if it opened, its net must be positive.
    for (const [up, down] of [[0.34, 0.62], [0.10, 0.85], [0.45, 0.48], [0.71, 0.24], [0.83, 0.15]]) {
      saveAllPackages([]);
      const pkg = await runArb({
        depth: { up: { bestAsk: up }, down: { bestAsk: down } },
        prices: { up, down },
        cfg: cfg({ minArbGap: 0.005 }),
      });
      if (!pkg) continue;   // refused is always an acceptable answer
      expect(pkg.lockedProfitUsd, `${up}/${down}`).toBeGreaterThan(0);
      expect(pkg.gap, `${up}/${down}`).toBeGreaterThan(pkg.breakEvenGap);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: arb capacity drains without anyone watching', () => {
  // Backlog items 9 and 10, promoted from invariants.pending.test.ts.
  //
  // getActivePackages counts LOCKED + PENDING_FILL toward maxArbPackages, so any
  // package that never reaches a terminal state permanently consumes a slot.
  // Two ways that happened:
  //
  //   10  syncPackageSettlements had exactly one caller — inside getState(). No
  //       timer calls getState, so with no dashboard open nothing ever settled.
  //   9   a restart between savePackage(PENDING_FILL) and the promotion after
  //       Promise.allSettled stranded the package forever, with no boot repair.
  //
  // Note the fix is a reconcile step, NOT teaching getActivePackages to ignore
  // stale packages. That would free the slot while leaving the naked leg in
  // place — capacity restored, exposure hidden. The earlier version of this test
  // asserted exactly that weaker property.

  const stuck = (over = {}) => ({
    packageId: 'pkg-stuck',
    symbol: 'BTC',
    slug: 'btc-updown-5m-stuck',
    windowKey: 'slug-btc-updown-5m-stuck',
    shares: 10,
    upCost: 2.5, downCost: 7.2, totalCost: 9.7, expectedPayout: 10,
    lockedProfitUsd: 0.3, lockedProfitPct: 3,
    status: 'PENDING_FILL',
    mode: 'paper',
    createdAt: Date.now() - 48 * 3600 * 1000,   // two days — long past any dispatch
    legs: {
      // Deliberately false: these flags are written *after* dispatch, so on the
      // interrupted path they lie about fills that really happened.
      up: { outcome: 'up', shares: 10, entryPrice: 0.25, cost: 2.5, filled: false },
      down: { outcome: 'down', shares: 10, entryPrice: 0.72, cost: 7.2, filled: false },
    },
    ...over,
  });

  const leg = (outcome, over = {}) => ({
    id: `pos-${outcome}`, packageId: 'pkg-stuck', outcome, symbol: 'BTC',
    slug: 'btc-updown-5m-stuck', shares: 10,
    entryPrice: outcome === 'up' ? 0.25 : 0.72,
    costBasis: outcome === 'up' ? 2.5 : 7.2,
    entryFee: 0.1, feesPaid: 0.1, isArbLeg: true, closed: false, mode: 'paper',
    ...over,
  });

  const reconcile = (positions = [], trades = [], over = {}) => {
    const cash = { v: 100 };
    const saved = [];
    return reconcilePendingPackages({
      mode: 'paper',
      positions,
      trades,
      cfg: { simulateClobFees: true, feeCategory: 'crypto' },
      botState: { config: {}, positions },
      adjustPaperCash: (d) => { cash.v = Math.round((cash.v + d) * 100) / 100; },
      saveTrade: (t) => saved.push(t),
      log: () => {},
      ...over,
    }).then((res) => ({ res, cash, saved, positions }));
  };

  it('frees the slot when neither leg ever filled', async () => {
    savePackage(stuck() as any);
    expect(getActivePackages('paper')).toHaveLength(1);
    const { res } = await reconcile([], []);
    expect(res.discarded).toBe(1);
    expect(getActivePackages('paper')).toHaveLength(0);
    expect(loadPackages()[0].status).toBe('ABORTED');
  });

  it('promotes to LOCKED when both fills are found, rather than discarding real positions', async () => {
    // The dangerous direction. `legs.*.filled` is false on both, so trusting the
    // flags would abort a package that is a genuine, intact hedge.
    savePackage(stuck() as any);
    const { res } = await reconcile([leg('up'), leg('down')], []);
    expect(res.locked).toBe(1);
    const pkg = loadPackages()[0];
    expect(pkg.status).toBe('LOCKED');
    expect(pkg.legs.up.filled).toBe(true);
    expect(pkg.legs.down.filled).toBe(true);
    // Still consuming a slot — correctly, it is a live hedge.
    expect(getActivePackages('paper')).toHaveLength(1);
  });

  it('unwinds the survivor when only one leg filled, and frees the slot', async () => {
    savePackage(stuck() as any);
    const positions = [leg('up')];
    const { res, saved } = await reconcile(positions, []);
    expect(res.aborted).toBe(1);
    expect(loadPackages()[0].status).toBe('ABORTED');
    expect(getActivePackages('paper')).toHaveLength(0);
    // The naked leg must be gone, not merely unaccounted for.
    expect(positions[0].closed).toBe(true);
    expect(positions[0].exitReason).toBe('arb_rollback');
    expect(saved).toHaveLength(1);
  });

  it('derives fills from positions and trades, not from the leg flags', async () => {
    // A closed leg leaves a trade but no open position. Both count as evidence
    // the fill happened.
    savePackage(stuck() as any);
    const { res } = await reconcile(
      [],
      [{ packageId: 'pkg-stuck', outcome: 'up', closed: true, pnl: 0 },
       { packageId: 'pkg-stuck', outcome: 'down', closed: true, pnl: 0 }],
    );
    expect(res.locked).toBe(1);
  });

  it('never touches a package young enough to still be dispatching', async () => {
    // The safety interlock. Without an age floor this would abort packages whose
    // legs are mid-flight — a live CLOB round trip takes seconds.
    savePackage(stuck({ packageId: 'pkg-fresh', createdAt: Date.now() - 1000 }) as any);
    const { res } = await reconcile([], []);
    expect(res.checked).toBe(0);
    expect(loadPackages()[0].status).toBe('PENDING_FILL');
    expect(getActivePackages('paper')).toHaveLength(1);
  });

  it('leaves settlement to the write path, never to a read', async () => {
    // Item 10's structural half. getState() must not transition package state:
    // it had the only call to syncPackageSettlements, and nothing calls getState
    // on a timer, so an unattended bot never settled anything at all.
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../src/polymarket/bot.ts'), 'utf-8',
    );
    const getState = src.slice(src.indexOf('export function getState'));
    const body = getState.slice(0, getState.indexOf('\nexport '));
    expect(body.length).toBeGreaterThan(500);
    expect(body).not.toMatch(/syncPackageSettlements\s*\(/);
    expect(body).not.toMatch(/reconcilePendingPackages\s*\(/);
    // …and the scan loop must be the thing that does it.
    expect(src).toMatch(/await arbHousekeeping\('scan'\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: paper cash has exactly one writer (D5)', () => {
  // Slice 2, item 23's second half. The formula was already collapsed; what
  // remained was two functions deciding WHEN to write. `reconcile` recomputes
  // from scratch and overwrites, so whenever it disagreed with the incremental
  // ledger it won silently — which is how the fee-refund bug stayed invisible
  // ($100.70 → $102.66 on production, a phantom gain equal to fees paid).
  //
  // Unlike the block above, these bind to the real `ledger/cash.ts`, not to a
  // re-implementation of it in the test.

  /** A ledger over a mutable fake store, recording every write. */
  const harness = (over: any = {}) => {
    const store: any = {
      paperBankroll: 100,
      paperInitialDeposit: 100,
      mode: 'paper',
      trades: [],
      positions: [],
      ...over,
    };
    const writes: number[] = [];
    const logs: string[] = [];
    const ledger = createPaperCashLedger({
      readBalance: () => store.paperBankroll,
      readInitial: () => store.paperInitialDeposit,
      readBooks: () => ({ trades: store.trades, positions: store.positions }),
      writeBalance: (n: number) => { store.paperBankroll = n; writes.push(n); },
      isPaper: () => store.mode === 'paper',
      log: (m: string) => logs.push(m),
    });
    return { store, writes, logs, ledger };
  };

  const closedTrade = (id: string, over: any = {}) => ({
    id,
    mode: 'paper',
    closed: true,
    entryPrice: 0.4,
    exitPrice: 0.55,
    shares: 10,
    entryFee: 0.168,
    exitFee: 0.1485,
    feesPaid: 0.3165,
    ...over,
  });

  it('never refunds a fee the incremental ledger charged', () => {
    // The actual regression, end to end. Buy 10 @ 0.40 paying a 0.168 entry
    // fee, then reconcile. If the recompute omits the fee term it hands the
    // 0.168 back, and cash lands at 96.00 instead of 95.83.
    const h = harness();
    h.ledger.adjust(-(4.0 + 0.168), 'BUY');
    expect(h.ledger.balance()).toBeCloseTo(95.83, 2);

    h.store.positions = [{ mode: 'paper', closed: false, costBasis: 4.0, entryFee: 0.168 }];
    h.ledger.reconcile('after buy');

    expect(h.ledger.balance()).toBeCloseTo(95.83, 2);
    expect(h.ledger.balance()).not.toBeCloseTo(96.0, 2);
  });

  it('leaves cash untouched when reconciling a consistent book', () => {
    // The strongest form: after a full round trip booked incrementally, the
    // recompute must agree to the cent — so reconcile writes nothing at all.
    const h = harness();
    const t = closedTrade('t1');

    h.ledger.adjust(-(t.shares * t.entryPrice + t.entryFee), 'BUY');
    h.ledger.adjust(t.shares * t.exitPrice - t.exitFee, 'SELL');
    const afterIncremental = h.ledger.balance();
    const writesBefore = h.writes.length;

    h.store.trades = [t];
    h.ledger.reconcile('round trip');

    expect(h.ledger.balance()).toBeCloseTo(afterIncremental, 2);
    expect(h.writes.length, 'a consistent book must not trigger a write').toBe(writesBefore);
  });

  it('agrees with the incremental ledger over a mixed book', () => {
    const closed = [
      closedTrade('a'),
      closedTrade('b', { entryPrice: 0.62, exitPrice: 0.5, shares: 10.4, entryFee: 0.175, exitFee: 0, feesPaid: 0.175 }),
      closedTrade('c', { entryPrice: 0.2, exitPrice: 0.5, shares: 10.2, entryFee: 0.114, exitFee: 0, feesPaid: 0.114 }),
    ];
    const open = [{ mode: 'paper', closed: false, costBasis: 4.2, entryFee: 0.17 }];

    const h = harness();
    for (const t of closed) {
      h.ledger.adjust(-(t.shares * t.entryPrice + t.entryFee), 'BUY');
      h.ledger.adjust(t.shares * t.exitPrice - Number(t.exitFee || 0), 'SELL');
    }
    for (const p of open) h.ledger.adjust(-(p.costBasis + p.entryFee), 'BUY');

    h.store.trades = closed;
    h.store.positions = open;

    // Within a cent: the incremental path rounds at each step, the recompute
    // once at the end. Anything larger is a missing term, not rounding.
    expect(Math.abs(h.ledger.books() - h.ledger.balance())).toBeLessThanOrEqual(0.01);
  });

  it('counts an open position as its premium AND its entry fee', () => {
    // The fee left the account with the premium. Treating it as a cost still to
    // come overstates spendable cash by the fee on every open position at once.
    const withFee = booksCash({
      trades: [],
      positions: [{ mode: 'paper', closed: false, costBasis: 4.0, entryFee: 0.168 }],
      initialDeposit: 100,
    });
    expect(withFee).toBeCloseTo(95.83, 2);
  });

  it('ignores positions and trades belonging to the other mode', () => {
    // Mixing modes silently merges two accounts. The filter lives in booksCash
    // rather than at the call site precisely so no caller can forget it.
    const mixed = booksCash({
      trades: [closedTrade('live-1', { mode: 'live' })],
      positions: [{ mode: 'live', closed: false, costBasis: 50, entryFee: 1 }],
      initialDeposit: 100,
      mode: 'paper',
    });
    expect(mixed).toBe(100);
  });

  it('writes nothing at all outside paper mode', () => {
    // Live cash is on-chain; a paper ledger writing to it would be fiction.
    const h = harness({ mode: 'live' });
    expect(h.ledger.adjust(-10, 'BUY')).toBeNull();
    expect(h.ledger.reconcile('live')).toBeNull();
    expect(h.writes).toHaveLength(0);
    expect(h.store.paperBankroll).toBe(100);
  });

  it('survives a nullish balance instead of throwing', () => {
    // The old reconcile read `paperBankroll ?? initial` where `initial` was a
    // free variable declared inside a different function (bot.ts:316 vs :330).
    // `??` short-circuits and resolveActiveConfig always seeds the field, so it
    // never fired — a ReferenceError one nullish balance from killing startBot.
    const h = harness({ paperBankroll: undefined });
    expect(() => h.ledger.balance()).not.toThrow();
    expect(h.ledger.balance()).toBe(100);
    expect(() => h.ledger.reconcile('cold start')).not.toThrow();
  });

  it('does not rewrite config for sub-cent drift', () => {
    // Without the epsilon guard every reconcile writes and logs, which turns
    // the one message that would matter into noise nobody reads.
    const h = harness();
    h.store.positions = [{ mode: 'paper', closed: false, costBasis: 0.004, entryFee: 0 }];
    h.ledger.reconcile('noise');
    expect(h.writes).toHaveLength(0);
    expect(h.logs).toHaveLength(0);
  });

  it('routes every mutation through the single write path', () => {
    // Structural. If a future caller finds another way to move cash, the two
    // sides of this diverge and D5's one-pool-one-owner is gone.
    const h = harness();
    h.ledger.adjust(-5, 'BUY');
    h.store.positions = [{ mode: 'paper', closed: false, costBasis: 20, entryFee: 0 }];
    h.ledger.reconcile('drift');
    expect(h.writes).toEqual([95, 80]);
    expect(h.store.paperBankroll).toBe(80);
  });

  it('keeps balances at cent precision', () => {
    // Fees carry 5dp, balances do not. Letting fee precision leak into the
    // balance accumulates a tail that shows up as permanent phantom drift.
    expect(roundCash(95.8319999)).toBe(95.83);
    const h = harness();
    h.ledger.adjust(-0.168, 'fee only');
    expect(h.ledger.balance()).toBe(99.83);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: bot.ts holds no cash logic of its own', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/polymarket/bot.ts'),
    'utf8',
  );

  it('delegates to the ledger instead of recomputing cash', () => {
    // Three copies of this formula existed (bot.ts:315, :327, and the repair
    // loop at :424). The whole point of ledger/cash.ts is that there is now
    // one. A fourth copy in bot.ts would silently win again.
    expect(src).toMatch(/createPaperCashLedger\(/);
    expect(src).not.toMatch(/paperInitialDeposit \?\? 100\);[\s\S]{0,400}?reduce/);
  });

  it('never assigns paperBankroll outside the ledger binding', () => {
    // One writer means one assignment site — inside writeBalance.
    const assignments = src.match(/botState\.config\.paperBankroll\s*=/g) || [];
    expect(assignments).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: arb engine never imports bot.js dynamically (Item 29)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/polymarket/arbEngine.ts'),
    'utf8',
  );

  it('contains no dynamic imports of bot.js', () => {
    // Backlog item 29. unwindLeg fell back to dynamic import of bot.ts for adjustPaperCash,
    // which was never exported and thus became a silent no-op.
    // Clean boundaries (D5, D7, D10) require that arbEngine receives dependencies directly
    // and never reaches back into bot.ts.
    expect(src).not.toMatch(/import\s*\(\s*['"]\.\/bot\.js['"]\s*\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: settlement valuation resolves naked legs vs real outcome (Item 8)', () => {
  const upLeg = {
    id: 'pos-up-1',
    packageId: 'pkg-arb-test',
    outcome: 'up',
    isArbLeg: true,
    entryPrice: 0.23,
    currentPrice: 0.25,
    closed: false,
  };
  const downLeg = {
    id: 'pos-down-1',
    packageId: 'pkg-arb-test',
    outcome: 'down',
    isArbLeg: true,
    entryPrice: 0.74,
    currentPrice: 0.72,
    closed: false,
  };

  it('settles intact pairs at exactly $0.50 per leg ($1.00 full set)', () => {
    const upRes = resolveSettlementPrice({
      pos: upLeg,
      openPositions: [upLeg, downLeg],
      market: { winner: 'down' },
    });
    expect(upRes.price).toBe(0.50);
    expect(upRes.isPairSettled).toBe(true);

    const downRes = resolveSettlementPrice({
      pos: downLeg,
      openPositions: [upLeg, downLeg],
      market: { winner: 'down' },
    });
    expect(downRes.price).toBe(0.50);
    expect(downRes.isPairSettled).toBe(true);
  });

  it('settles a naked arb leg against real market outcome, never fabricated $0.50', () => {
    // Backlog item 8: a single surviving arb leg must not receive a free $0.50.
    // When market resolved DOWN, the naked UP leg settles at $0.00 (loss).
    const lossRes = resolveSettlementPrice({
      pos: upLeg,
      openPositions: [upLeg], // no sibling
      market: { winner: 'down' },
    });
    expect(lossRes.price).toBe(0.00);
    expect(lossRes.isPairSettled).toBe(false);

    // When market resolved UP, the naked UP leg settles at $1.00 (win).
    const winRes = resolveSettlementPrice({
      pos: upLeg,
      openPositions: [upLeg], // no sibling
      market: { winner: 'up' },
    });
    expect(winRes.price).toBe(1.00);
    expect(winRes.isPairSettled).toBe(false);
  });
});


