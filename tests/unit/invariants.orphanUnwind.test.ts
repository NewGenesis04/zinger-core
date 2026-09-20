// @ts-nocheck
/**
 * INVARIANTS: a naked arb leg is unwound as soon as it *can* be, and retrying
 * is bounded (items 100 and 101).
 *
 * The 2026-09-18 canary produced two orphaned legs. Both inline unwinds were
 * refused with `balance: 0` — the venue had not credited the bought shares yet
 * (domain facts §9d) — and both legs then sat naked for ~121 seconds on 5- and
 * 15-minute windows before the sweep would look at them.
 *
 * Two separate defects produced that, and both are pinned below:
 *
 *   100  one age predicate gated both `PENDING_FILL` promotion (where 120s is a
 *        real interlock against aborting in-flight legs) and orphan retry on an
 *        already-ABORTED package (where nothing is in flight and the wait buys
 *        nothing but exposure).
 *   101  `unwindAttempts` is a *permanent*-failure budget — it exists to stop
 *        the bot emitting a live sell every tick forever for an unsellable leg
 *        (backlog 34). A `balance: 0` refusal is transient and clears on its
 *        own, so spending that budget on it is how a 2-minute delay turns into
 *        a naked position held to expiry.
 *
 * The tests are written as properties of the retry policy rather than as a
 * transcript of the timings, because the credit gap's length is precisely what
 * is not known: §9d measured ~2.15s on one order and the canary was still
 * refused at 2.85s. Anything asserting a specific delay would be encoding that
 * guess as a requirement.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sell = vi.hoisted(() => ({
  /** 'credited' | 'not-credited' | 'no-bid' */
  mode: 'not-credited',
  calls: 0,
  /** The venue's verbatim 2026-09-18 refusal. */
  CREDIT_REFUSAL: 'CLOB market sell 9.347212sh @>=0.52: not enough balance / allowance: the balance is not enough -> balance: 0, order amount: 9340000',
}));

vi.mock('../../src/polymarket/trade.js', () => ({
  sellFloor: (px) => Math.max(0.01, Math.round(Number(px) * 0.75 * 100) / 100),
  placeMarketSell: async () => {
    sell.calls += 1;
    if (sell.mode === 'not-credited') throw new Error(sell.CREDIT_REFUSAL);
    // A leg nothing will buy: the permanent case the attempt budget is for.
    if (sell.mode === 'no-bid') throw new Error('CLOB market sell rejected: no resting bid at or above floor 0.52');
    return { id: '0xsellreceipt', fillPrice: 0.99, price: 0.52, floorPrice: 0.52 };
  },
}));

const { reconcilePendingPackages, isSettlementCreditRefusal } = await import('../../src/polymarket/arbEngine.js');
const { saveAllPackages, savePackage } = await import('../../src/polymarket/arbPersistence.js');

/** An ABORTED live package whose UP leg filled and whose DOWN leg died. */
const orphaned = (over = {}) => ({
  packageId: 'pkg-orphan',
  symbol: 'BTC',
  slug: 'btc-updown-5m-1789716600',
  windowKey: 'slug-btc-updown-5m-1789716600',
  shares: 9.3472,
  upCost: 6.54, downCost: 0, totalCost: 6.54, expectedPayout: 9.35,
  status: 'ABORTED',
  mode: 'live',
  createdAt: Date.now() - 10_000,
  abortReason: 'Leg execution mismatch: UP=OK, DOWN=FAIL',
  legs: {
    up: { outcome: 'up', shares: 9.3472, entryPrice: 0.70, cost: 6.54, filled: true },
    down: { outcome: 'down', shares: 0, entryPrice: 0.24, cost: 0, filled: false },
  },
  ...over,
});

const nakedUpLeg = (over = {}) => ({
  id: 'pos-up', packageId: 'pkg-orphan', outcome: 'up', symbol: 'BTC',
  slug: 'btc-updown-5m-1789716600', shares: 9.3472,
  entryPrice: 0.70, currentPrice: 0.70, costBasis: 6.54,
  entryFee: 0.1374, feesPaid: 0.1374,
  tokenId: 'token-up-live', tickSize: '0.01', negRisk: false,
  isArbLeg: true, closed: false, mode: 'live',
  ...over,
});

const reconcile = (positions, over = {}) => {
  const saved = [];
  return reconcilePendingPackages({
    mode: 'live',
    positions,
    trades: [],
    cfg: { simulateClobFees: true, feeCategory: 'crypto' },
    botState: { config: {}, positions },
    saveTrade: (t) => saved.push(t),
    log: () => {},
    ...over,
  }).then((res) => ({ res, saved }));
};

beforeEach(() => {
  saveAllPackages([]);
  sell.mode = 'not-credited';
  sell.calls = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: a refusal is classified before it is charged (item 101)', () => {
  it('reads the venue balance:0 wording as transient', () => {
    expect(isSettlementCreditRefusal(sell.CREDIT_REFUSAL)).toBe(true);
    // Domain facts §9 recorded this one verbatim too, at a different size.
    expect(isSettlementCreditRefusal(
      'not enough balance / allowance: the balance is not enough -> balance: 0, order amount: 4590000',
    )).toBe(true);
  });

  it('does not treat a *partial* balance as the settlement gap', () => {
    // Shares exist and something else is wrong. Reading this as "wait a moment"
    // would retry forever against a fault that waiting cannot fix.
    expect(isSettlementCreditRefusal(
      'not enough balance / allowance: the balance is not enough -> balance: 4590000, order amount: 9340000',
    )).toBe(false);
  });

  it('treats anything it does not recognise as permanent', () => {
    // Fails toward the bounded behaviour, not the unbounded one.
    expect(isSettlementCreditRefusal('no resting bid at or above floor')).toBe(false);
    expect(isSettlementCreditRefusal('401 unauthorized')).toBe(false);
    expect(isSettlementCreditRefusal('')).toBe(false);
    expect(isSettlementCreditRefusal(null)).toBe(false);
    expect(isSettlementCreditRefusal(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: waiting for settlement never spends the retry budget (item 101)', () => {
  it('keeps retrying across more passes than the attempt budget allows', async () => {
    // THE REGRESSION. Before item 101 each refusal incremented unwindAttempts,
    // so three passes latched unwindBlocked and the sweep abandoned the leg —
    // permanently naked, on a leg that was sellable seconds later. A fast
    // retry loop (3s/6s/10s) would have reached that state inside the credit
    // window and destroyed both 2026-09-18 unwinds.
    savePackage(orphaned());
    const positions = [nakedUpLeg()];

    for (let pass = 0; pass < 5; pass += 1) await reconcile(positions);

    expect(positions[0].unwindAttempts ?? 0, 'charged the permanent-failure budget').toBe(0);
    expect(positions[0].unwindBlocked, 'gave up while the venue was still settling').toBe(false);
    expect(positions[0].unwindCreditRefusals).toBe(5);
    expect(sell.calls, 'stopped asking').toBe(5);
    // Still held, still open, nothing booked — the leg is real.
    expect(positions[0].closed).toBe(false);
  });

  it('unwinds on the pass after the shares are credited, and clears the wait', async () => {
    savePackage(orphaned());
    const positions = [nakedUpLeg()];

    await reconcile(positions);
    expect(positions[0].closed).toBe(false);

    sell.mode = 'credited';
    const { res, saved } = await reconcile(positions);

    expect(positions[0].closed, 'did not unwind once it could').toBe(true);
    expect(positions[0].exitReason).toBe('arb_rollback');
    expect(positions[0].exitPrice).toBe(0.99);
    expect(res.orphansUnwound).toBe(1);
    expect(saved).toHaveLength(1);
    // The grace clock is per unwind: a later refusal is a different fault.
    expect(positions[0].unwindCreditRefusals).toBe(0);
    expect(positions[0].firstCreditRefusalAt).toBeNull();
  });

  it('books the unwind net of both fees, not just the exit fee', async () => {
    // The invariant the 2026-09-18 report tripped over: entry fee is part of
    // the cost of the round trip, so pnl must carry both legs of the fee.
    savePackage(orphaned());
    const positions = [nakedUpLeg()];
    sell.mode = 'credited';

    const { saved } = await reconcile(positions);

    const t = saved[0];
    const gross = (0.99 - 0.70) * 9.3472;
    expect(t.feesPaid).toBeCloseTo(0.1374 + t.exitFee, 5);
    expect(t.pnl).toBeCloseTo(Math.round((gross - 0.1374 - t.exitFee) * 100) / 100, 2);
    expect(t.pnl, 'booked the gross spread as net').toBeLessThan(gross);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: an unsellable leg still stops emitting orders (backlog 34)', () => {
  it('spends the budget and gives up when waiting is not the problem', async () => {
    // The property item 101 must not weaken. A leg nothing will buy has to stop
    // being offered, or it emits a live order every scan pass forever.
    savePackage(orphaned());
    const positions = [nakedUpLeg()];
    sell.mode = 'no-bid';

    await reconcile(positions);
    await reconcile(positions);
    expect(positions[0].unwindAttempts).toBe(2);
    expect(positions[0].unwindBlocked).toBe(false);

    await reconcile(positions);
    expect(positions[0].unwindAttempts).toBe(3);
    expect(positions[0].unwindBlocked).toBe(true);

    const callsAtBlock = sell.calls;
    await reconcile(positions);
    expect(sell.calls, 'kept hitting the venue after giving up').toBe(callsAtBlock);
    // Blocked is not written off: the shares are still held.
    expect(positions[0].closed).toBe(false);
  });

  it('bounds the settlement wait too, so a stuck balance cannot loop forever', async () => {
    // A balance that reads zero for some reason *other* than settlement lag is
    // indistinguishable from here. Bounded on wall clock rather than attempts
    // because the length of the credit gap is unmeasured — see §9d.
    savePackage(orphaned());
    const positions = [nakedUpLeg({
      firstCreditRefusalAt: Date.now() - 90_000,
      unwindCreditRefusals: 12,
    })];

    await reconcile(positions, { cfg: { arbUnwindCreditGraceMs: 60_000 } });

    expect(positions[0].unwindBlocked, 'waited past the grace window and kept going').toBe(true);
    expect(positions[0].closed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: the interlock guards dispatch, not resolved packages (item 100)', () => {
  it('reconciles an orphan without serving the PENDING_FILL interlock', async () => {
    // THE REGRESSION. An ABORTED package has no legs in flight — the dispatch
    // path already ran and already wrote the status — so it inherited a 120s
    // wait that protects a different case. Measured cost: ~121s naked on a
    // 300s window.
    savePackage(orphaned({ createdAt: Date.now() - 10_000 }));
    const positions = [nakedUpLeg()];
    sell.mode = 'credited';

    const { res } = await reconcile(positions);

    expect(res.orphansUnwound, 'still waiting out an interlock it is not subject to').toBe(1);
    expect(positions[0].closed).toBe(true);
  });

  it('still leaves a fresh abort to the inline unwind rather than racing it', async () => {
    // The orphan gate is short, not zero: dispatch unwinds inline first, and
    // two sellers for one leg is worse than a few seconds of delay.
    savePackage(orphaned({ createdAt: Date.now() - 500 }));
    const positions = [nakedUpLeg()];
    sell.mode = 'credited';

    const { res } = await reconcile(positions, { orphanMinAgeMs: 5_000 });

    expect(res.orphansUnwound).toBe(0);
    expect(sell.calls, 'raced the inline unwind for the same leg').toBe(0);
    expect(positions[0].closed).toBe(false);
  });

  it('keeps the full interlock for a package that may still be dispatching', async () => {
    // The safety property item 100 must not break. A PENDING_FILL package this
    // young could have legs in flight; promoting or aborting it here is how a
    // live dispatch gets torn down underneath itself.
    savePackage(orphaned({
      packageId: 'pkg-inflight',
      status: 'PENDING_FILL',
      createdAt: Date.now() - 10_000,
    }));

    const { res } = await reconcile([]);

    expect(res.checked, 'judged a package that could still be dispatching').toBe(0);
  });

  it('promotes a PENDING_FILL package once it is genuinely past any dispatch', async () => {
    savePackage(orphaned({
      packageId: 'pkg-inflight',
      status: 'PENDING_FILL',
      createdAt: Date.now() - 200_000,
    }));

    const { res } = await reconcile([]);

    expect(res.checked).toBe(1);
    // Neither leg is present in positions or trades, so nothing was bought.
    expect(res.discarded).toBe(1);
  });
});
