// @ts-nocheck
/**
 * INVARIANTS: the arb engine knows where it is in the window — at entry (item
 * 99) and at exit (item 98).
 *
 * Both come from the 2026-09-18 BTC package. It opened at 07:34:33 against a
 * window closing at 07:35:00 — 27 seconds — and its orphaned leg was sold at
 * 07:36:34, 94 seconds *after* close, at $0.99 plus a taker fee.
 *
 * The two ends of that story are one missing fact, used twice:
 *
 *   entry  a package that orphans needs wall-clock time to get back to flat —
 *          abort, wait for the venue to credit the shares, sell. With 27s there
 *          is none, so the hedge that failed becomes an unmanaged bet at market
 *          odds: zero edge, full variance, settled before anything can act.
 *   exit   after close the market is converging on a payout that is already
 *          decided. A winning orphan redeems at exactly $1.00 fee-free; a
 *          losing one is worth $0.00 and the sell is futile. So the unwind
 *          cannot win there and can only lose.
 *
 * The gate's default is derived, not guessed: `arbUnwindCreditGraceMs` is how
 * long the unwind path itself will wait for credit before giving up (60s), so a
 * package with less window than that cannot finish its own recovery.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const sell = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../src/polymarket/trade.js', async (orig) => ({
  ...(await orig()),
  sellFloor: (px) => Math.max(0.01, Math.round(Number(px) * 0.75 * 100) / 100),
  placeMarketSell: async () => {
    sell.calls += 1;
    return { id: '0xsell', fillPrice: 0.99, price: 0.52, floorPrice: 0.52 };
  },
}));

const { detectAndExecuteArbPackage, reconcilePendingPackages } = await import('../../src/polymarket/arbEngine.js');
const { saveAllPackages, savePackage, loadPackages } = await import('../../src/polymarket/arbPersistence.js');
const { redeemRatherThanUnwind } = await import('../../src/polymarket/positions/policy.js');
const { defaultPaperStrategy } = await import('../../src/polymarket/modeConfig.js');

/** A 5m slug whose window ends `secondsLeft` from now. */
const slugEndingIn = (secondsLeft, asset = 'eth') =>
  `${asset}-updown-5m-${Math.round(Date.now() / 1000 + secondsLeft) - 300}`;

const market = (slug) => ({
  symbol: 'ETH', slug, conditionId: '0xwindow', outcomes: ['Up', 'Down'],
  tokenIds: { up: 'tok-up', down: 'tok-down' }, acceptingOrders: true, tickSize: '0.01',
});

/** A book with a 8c gap — comfortably past break-even, so only timing can refuse it. */
const depth = () => ({
  up: { bestAsk: 0.34, bestAskSize: 500, bookTs: Date.now() },
  down: { bestAsk: 0.58, bestAskSize: 500, bookTs: Date.now() },
});

const baseCfg = {
  clobArbEnabled: true, minArbGap: 0.01, maxArbPackages: 4, paperBankroll: 500,
  arbBankrollFrac: 0.2, arbMaxUsd: 50, minPositionSize: 0.5, arbLeg2RereadBook: false,
};

/** Runs the detector, collecting every `arb.decision` skip code it emits. */
async function detect({ slug, mode = 'paper', cfg = {}, fills = true }) {
  const codes = [];
  const { onEvent } = await import('../../src/polymarket/telemetry/events.js');
  const off = onEvent('arb.decision', (e) => codes.push({
    code: e?.data?.output?.skipReason?.code ?? null,
    operands: e?.data?.output?.skipReason?.operands ?? null,
    action: e?.data?.output?.action,
  }));
  try {
    const pkg = await detectAndExecuteArbPackage({
      market: market(slug),
      depth: depth(),
      prices: { up: 0.34, down: 0.58 },
      cfg: { ...baseCfg, mode, ...cfg },
      mode,
      readiness: { spendableBalance: 500, liveReady: true },
      log: () => {},
      executeTrade: async () => (fills
        ? { ok: true, shares: 4.5, price: 0.34, id: '0xfill' }
        : { ok: false, error: 'killed', rawError: 'FOK orders are fully filled or killed.' }),
      adjustPaperCash: () => {},
      saveTrade: () => {},
      botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
      peekBook: () => null,
    });
    return { pkg, codes };
  } finally {
    off();
  }
}

beforeEach(() => {
  saveAllPackages([]);
  sell.calls = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: no package opens with less window left than its own recovery needs (item 99)', () => {
  it('refuses the 2026-09-18 entry — 27 seconds — and says why', async () => {
    // THE REGRESSION. This book passed every other gate and opened.
    const { pkg, codes } = await detect({ slug: slugEndingIn(27) });

    expect(pkg).toBeNull();
    expect(loadPackages()).toHaveLength(0);
    const skip = codes.find((c) => c.code === 'window_closing');
    expect(skip, 'opened a package with 27s of window left').toBeTruthy();
    expect(skip.operands.minRemainingMs).toBe(60_000);
    expect(skip.operands.remainingMs).toBeLessThan(60_000);
  });

  it('opens the same book when the window can still carry an orphan', async () => {
    // The gate must refuse *timing*, not the trade. Same asks, same gap.
    const { pkg, codes } = await detect({ slug: slugEndingIn(200) });

    expect(codes.some((c) => c.code === 'window_closing')).toBe(false);
    expect(pkg?.status).toBe('LOCKED');
  });

  it('holds in live and in paper alike', async () => {
    // A rule about which packages are worth opening, not about how they
    // execute. Paper that ignores it stops being a model of the live book (D6).
    for (const mode of ['paper', 'live']) {
      saveAllPackages([]);
      const { pkg, codes } = await detect({ slug: slugEndingIn(30), mode });
      expect(pkg, mode).toBeNull();
      expect(codes.some((c) => c.code === 'window_closing'), mode).toBe(true);
    }
  });

  it('is the operator\'s dial, and 0 restores the old behaviour exactly', async () => {
    const { pkg } = await detect({ slug: slugEndingIn(27), cfg: { arbMinWindowSecondsLeft: 0 } });
    expect(pkg?.status).toBe('LOCKED');

    saveAllPackages([]);
    const tighter = await detect({ slug: slugEndingIn(120), cfg: { arbMinWindowSecondsLeft: 180 } });
    expect(tighter.pkg).toBeNull();
    expect(tighter.codes.some((c) => c.code === 'window_closing')).toBe(true);
  });

  it('does not gate on a window it cannot establish', async () => {
    // `marketWindow` falls back to a wall-clock bucket for an unparseable slug.
    // Refusing trades on that guess would silently disable the engine if the
    // slug format ever changed — the more expensive failure by far.
    const { pkg, codes } = await detect({ slug: 'eth-some-other-market-shape' });
    expect(codes.some((c) => c.code === 'window_closing')).toBe(false);
    expect(pkg?.status).toBe('LOCKED');
  });

  it('ships the gate on by default', () => {
    expect(defaultPaperStrategy().arbMinWindowSecondsLeft).toBe(60);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: after the window closes a leg is redeemed, never sold (item 98)', () => {
  const pos = (over = {}) => ({
    id: 'pos-up', packageId: 'pkg-late', outcome: 'up', symbol: 'BTC',
    slug: slugEndingIn(-94, 'btc'), shares: 9.3472,
    entryPrice: 0.70, currentPrice: 0.99, costBasis: 6.54,
    tokenId: 'tok-up-live', tickSize: '0.01',
    isArbLeg: true, closed: false, mode: 'live',
    ...over,
  });

  it('is decided by the window and the mode, and by nothing else', () => {
    // 94 seconds past close: the 2026-09-18 sale.
    expect(redeemRatherThanUnwind(pos())).toBe(true);
    // One second before close it is still an ordinary mid-window unwind.
    expect(redeemRatherThanUnwind(pos({ slug: slugEndingIn(1, 'btc') }))).toBe(false);
    // Paper has no redemption; its close *is* its settlement model.
    expect(redeemRatherThanUnwind(pos({ mode: 'paper' }))).toBe(false);
    // An unknown window withdraws no action — positive evidence only.
    expect(redeemRatherThanUnwind(pos({ slug: 'btc-weekly-special' }))).toBe(false);
    expect(redeemRatherThanUnwind(pos({ slug: null }))).toBe(false);
  });

  const orphanPkg = (slug) => ({
    packageId: 'pkg-late', symbol: 'BTC', slug, status: 'ABORTED', mode: 'live',
    createdAt: Date.now() - 400_000, shares: 9.3472,
    upCost: 6.54, downCost: 0, totalCost: 6.54, expectedPayout: 9.35,
    abortReason: 'Leg execution mismatch: UP=OK, DOWN=FAIL',
    legs: {
      up: { outcome: 'up', shares: 9.3472, entryPrice: 0.70, cost: 6.54, filled: true },
      down: { outcome: 'down', shares: 0, entryPrice: 0.24, cost: 0, filled: false },
    },
  });

  const sweep = (positions) => reconcilePendingPackages({
    mode: 'live',
    positions,
    trades: [],
    cfg: { simulateClobFees: true, feeCategory: 'crypto' },
    botState: { config: {}, positions },
    saveTrade: () => {},
    log: () => {},
  });

  it('leaves the post-close orphan alone instead of selling it at a discount', async () => {
    // THE REGRESSION: sold at $0.99 plus a taker fee, 94s after close, when
    // holding pays exactly $1.00 fee-free (domain facts §2). Cost ~$0.10.
    const positions = [pos()];
    savePackage(orphanPkg(positions[0].slug));

    const res = await sweep(positions);

    expect(sell.calls, 'sold a leg the venue was about to pay out in full').toBe(0);
    expect(res.orphansUnwound).toBe(0);
    expect(positions[0].closed, 'booked a close that never happened').toBe(false);
    expect(positions[0].heldToRedemptionAt).toBeGreaterThan(0);
    // The leg is real and recorded, whatever happens to it next (backlog 43).
    expect(loadPackages()[0].legs.up.filled).toBe(true);
  });

  it('does not re-decide it on every housekeeping tick', async () => {
    const positions = [pos()];
    savePackage(orphanPkg(positions[0].slug));

    const at = [];
    for (let i = 0; i < 4; i += 1) {
      await sweep(positions);
      at.push(positions[0].heldToRedemptionAt);
    }
    expect(new Set(at).size, 'restamped the hold each pass').toBe(1);
    expect(sell.calls).toBe(0);
  });

  it('still unwinds an orphan whose window is open — the rule is the close, not the abort', async () => {
    const positions = [pos({ slug: slugEndingIn(120, 'btc') })];
    savePackage(orphanPkg(positions[0].slug));

    const res = await sweep(positions);

    expect(sell.calls, 'held a leg that could still be sold into a live book').toBe(1);
    expect(res.orphansUnwound).toBe(1);
    expect(positions[0].closed).toBe(true);
    expect(positions[0].exitReason).toBe('arb_rollback');
    expect(positions[0].heldToRedemptionAt).toBeUndefined();
  });

  it('holds the leg the abort path unwinds inline, too', async () => {
    // The sweep is the second chance; dispatch unwinds inline first. Both go
    // through `unwindLeg`, so the rule has to live there rather than at one
    // call site — a package that aborts seconds after close must not sell.
    const legs = [];
    const positions = [];
    const pkg = await detectAndExecuteArbPackage({
      market: market(slugEndingIn(-10, 'eth')),
      depth: depth(),
      prices: { up: 0.34, down: 0.58 },
      // 0 only so the entry gate lets this reach dispatch: the package under
      // test opened legitimately and lost its window while executing.
      cfg: { ...baseCfg, mode: 'live', arbMinWindowSecondsLeft: 0 },
      mode: 'live',
      readiness: { spendableBalance: 500, liveReady: true },
      log: () => {},
      // Stands in for `executePendingTrade`: leg 1 fills and leaves an open
      // position behind, leg 2 is killed. That is the orphan the abort path
      // then has to deal with.
      executeTrade: async (pending) => {
        legs.push(pending?.outcome);
        if (legs.length === 1) {
          const position = {
            id: pending.id, packageId: pending.plan.packageId, outcome: 'up', symbol: 'ETH',
            slug: pending.slug, shares: 4.5, entryPrice: 0.34, currentPrice: 0.99,
            tokenId: 'tok-up', tickSize: '0.01', isArbLeg: true, closed: false, mode: 'live',
          };
          positions.push(position);
          return { ok: true, position };
        }
        return { ok: false, error: 'killed', rawError: 'FOK orders are fully filled or killed.' };
      },
      adjustPaperCash: () => {},
      saveTrade: () => {},
      botState: {
        config: { maxConcurrentPerSlug: 1 },
        get positions() { return positions; },
      },
      peekBook: () => null,
    });

    expect(pkg.status).toBe('ABORTED');
    expect(sell.calls, 'the inline unwind sold a leg past its window close').toBe(0);
    expect(positions[0].closed).toBe(false);
    expect(positions[0].heldToRedemptionAt).toBeGreaterThan(0);
  });

  it('never withholds the sell in paper, which has no redemption', async () => {
    const positions = [pos({ mode: 'paper' })];
    savePackage({ ...orphanPkg(positions[0].slug), mode: 'paper' });

    const res = await reconcilePendingPackages({
      mode: 'paper',
      positions,
      trades: [],
      cfg: { simulateClobFees: true, feeCategory: 'crypto' },
      botState: { config: {}, positions },
      adjustPaperCash: () => {},
      saveTrade: () => {},
      log: () => {},
    });

    expect(res.orphansUnwound).toBe(1);
    expect(positions[0].closed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Throws unless the entry gate runs before any order is dispatched. */
function checkEntryGate(engine) {
  const gate = engine.indexOf("'window_closing'");
  if (gate < 0) throw new Error('the window gate is gone');
  const dispatch = engine.indexOf('Promise.allSettled');
  if (!(gate < dispatch)) throw new Error('the window gate runs after dispatch');
  if (!/marketWindow\(market\)/.test(engine)) throw new Error('the gate does not read the market window');
}

/** Throws unless the unwind consults the redemption rule before selling. */
function checkUnwindGuard(engine) {
  const start = engine.indexOf('async function unwindLeg(');
  if (start < 0) throw new Error('unwindLeg not found');
  const body = engine.slice(start, engine.indexOf('\n}', engine.indexOf('return { ok: true, closed: true };', start)));
  const guard = body.indexOf('redeemRatherThanUnwind(pos)');
  const placeSell = body.indexOf('placeMarketSell');
  if (guard < 0) throw new Error('unwindLeg no longer asks whether to redeem');
  if (!(guard < placeSell)) throw new Error('the redemption check runs after the sell');
}

describe('INVARIANT: both checks are wired where they can still change the outcome', () => {
  const engine = src('../../src/polymarket/arbEngine.ts');

  it('holds for the real source', () => {
    expect(() => checkEntryGate(engine)).not.toThrow();
    expect(() => checkUnwindGuard(engine)).not.toThrow();
  });

  it('fails if the entry gate moves below dispatch', () => {
    const broken = engine.replace("arbDecision('skip', 'window_closing',", "arbDecision('skip', 'window_late',");
    expect(broken).not.toBe(engine);
    expect(() => checkEntryGate(broken)).toThrow(/window gate is gone/);
  });

  it('fails if the unwind stops consulting the rule', () => {
    const broken = engine.replace('if (redeemRatherThanUnwind(pos)) {', 'if (false) {');
    expect(broken).not.toBe(engine);
    expect(() => checkUnwindGuard(broken)).toThrow(/no longer asks/);
  });
});
