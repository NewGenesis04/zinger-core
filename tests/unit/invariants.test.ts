import { describe, expect, it, beforeEach } from 'vitest';
import {
  detectAndExecuteArbPackage,
  isComplementaryBinary,
  syncPackageSettlements,
} from '../../src/polymarket/arbEngine.js';
import { saveAllPackages, loadPackages, getActivePackages, savePackage } from '../../src/polymarket/arbPersistence.js';
import { takerFeeUsdc, closeProceedsWithFee, FEE_RATES } from '../../src/polymarket/fees.js';
import { tradeNetPnl, tradeFeesPaid, tradeRealizedPnl, tradeEngine } from '../../src/polymarket/audit.js';
import { computeRecentExpectancy, evaluateEdgeGate } from '../../src/polymarket/edge.js';
import { normalizeConfigStore, defaultLiveStrategy } from '../../src/polymarket/modeConfig.js';

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
    executeTrade: async () => true,
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
    for (const [up, down] of [
      [0.34, 0.62],
      [0.10, 0.85],
      [0.48, 0.49],
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
      // first leg fills, second fails
      executeTrade: async () => ++calls === 1,
    });
    expect(pkg.status).toBe('ABORTED');
    expect(pkg.abortReason).toMatch(/FAIL/);
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
        return ok;
      },
      botState,
    });

    expect(pkg.status).toBe('ABORTED');
    // the filled leg must be closed out, not left holding exposure
    expect(positions[0].closed).toBe(true);
    expect(positions[0].exitReason).toBe('arb_rollback');
    expect(positions[0].pnl).toBe(0);
    // and the cash must come back
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
  // The invariant is that the two agree. Tested over the primitives both are
  // built from, since reconcilePaperCash is still an unexported internal of
  // bot.ts (slice 2 moves it to ledger/cash.ts).

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
