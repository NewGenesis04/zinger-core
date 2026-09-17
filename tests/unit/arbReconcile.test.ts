// @ts-nocheck
/**
 * INVARIANT: a live arb leg is never reported failed on an assumption (item 80).
 *
 * The failure being encoded here is specific and it has a receipt. On
 * 2026-09-11 `pkg-btc-mtwep5v2` was abandoned at 03:38:25.612 with
 * `legs.up.shares = 0`. The chain bought 4.682223 UP shares at 03:38:27 and
 * redeemed them at 03:46:39 for $4.682223. The engine held a naked position for
 * 8.2 minutes and had no idea.
 *
 * Two separate defects produced that, and both are pinned below:
 *
 *   1. the verification band is symmetric, but a fixed-dollar FOK buy can only
 *      fill ABOVE its expected share count. The real fill missed by 0.0004 sh.
 *   2. the defensive flatten fired before the venue had matched, so it sold
 *      shares that did not exist yet and concluded they never would.
 *
 * The tests are written as properties of the three-way answer rather than as a
 * transcript of the current implementation — in particular "wallet silence is
 * not evidence of absence", which is the one rule that, if it ever relaxes,
 * reproduces the ghost exactly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  reconcileArbLeg,
  shareBand,
  resolveInBand,
  haltArb,
  isArbHalted,
  arbHaltState,
  clearArbHalt,
  findUnrecordedHoldings,
  fetchWalletShares,
  fetchWalletPositions,
  PROBE_SCHEDULE_MS,
} from '../../src/polymarket/arbReconcile.js';

/** The real 2026-09-11 package, to the cent. */
const GHOST = {
  expectedShares: 4.59,     // 1.24 / 0.27
  price: 0.27,
  tickSize: 0.01,
  tolerance: 0.0918,        // max(0.05, 2%) — what the fill path used
  actualShares: 4.682223,
};

/** No real waiting; records the schedule so the window itself is assertable. */
function fakeClock() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

beforeEach(() => { clearArbHalt(); });

describe('INVARIANT: wallet silence is never evidence of not-filled', () => {
  it('returns unknown when nothing answers, however many times we ask', async () => {
    // The ghost's exact shape: no usable order record, and a wallet that will
    // not speak. A failed request is not a reading of zero, and reading it as
    // one is what abandons a live leg.
    //
    // (An endpoint that *answers* zero on every probe is a different claim and
    // resolves to `unfilled` — see 'only true blindness halts' below. The line
    // is between silence and an answer, not between zero and non-zero.)
    const { sleep } = fakeClock();
    const res = await reconcileArbLeg({
      orderId: null,
      tokenId: 'tok-up',
      depositWallet: '0xdead',
      expectedShares: GHOST.expectedShares,
      price: GHOST.price,
      tolerance: GHOST.tolerance,
      getMatched: async () => null,
      getWalletShares: async () => null,
      sleep,
    });

    expect(res.outcome).toBe('unknown');
    expect(res.shares).toBeNull();
  });

  it('only the venue speaking about our own order id yields unfilled', async () => {
    const { sleep } = fakeClock();
    const res = await reconcileArbLeg({
      orderId: '0xorder',
      tokenId: 'tok-up',
      depositWallet: '0xdead',
      expectedShares: GHOST.expectedShares,
      price: GHOST.price,
      tolerance: GHOST.tolerance,
      getMatched: async () => 0,      // acknowledged, matched nothing = FOK kill
      getWalletShares: async () => 0,
      sleep,
    });

    expect(res.outcome).toBe('unfilled');
    expect(res.door).toBe('order');
  });
});

describe('INVARIANT: the 2026-09-11 fill is recognised as a fill', () => {
  it('accepts 4.682223 against an expectation of 4.59, which the fill path rejected', async () => {
    // Regression pin on defect (1). Proof the old band refuses it:
    expect(Math.abs(GHOST.actualShares - GHOST.expectedShares)).toBeGreaterThan(GHOST.tolerance);

    const { sleep } = fakeClock();
    const res = await reconcileArbLeg({
      orderId: '0xorder',
      tokenId: 'tok-up',
      expectedShares: GHOST.expectedShares,
      price: GHOST.price,
      tickSize: GHOST.tickSize,
      tolerance: GHOST.tolerance,
      getMatched: async () => GHOST.actualShares,
      sleep,
    });

    expect(res.outcome).toBe('filled');
    expect(res.shares).toBeCloseTo(GHOST.actualShares, 6);
  });

  it('bounds the band by what the venue could actually have done', () => {
    const band = shareBand({ expectedShares: 4.59, price: 0.27, tickSize: 0.01, tolerance: 0.0918 });
    // A fill can never come in below the expected count — FOK does not partly
    // fill — so the only slack below is our own rounding.
    expect(band.lo).toBeCloseTo(4.4982, 4);
    // Above, the ceiling is every share filling at one tick, with the rounding
    // slack scaled by the same factor (item 81).
    expect(band.hi).toBeCloseTo((4.59 + 0.0918) * 27, 4);
    expect(band.hi).toBeGreaterThanOrEqual(1.24 / 0.01);
    expect(GHOST.actualShares).toBeGreaterThan(band.lo);
    expect(GHOST.actualShares).toBeLessThan(band.hi);
  });

  it('still resolves the wire scale despite the wide ceiling', () => {
    const band = shareBand({ expectedShares: 4.59, price: 0.27, tickSize: 0.01, tolerance: 0.0918 });
    // The two candidate readings differ by 1e6; a 27x band cannot confuse them.
    expect(resolveInBand(4_682_223, band)).toBeCloseTo(4.682223, 6);
    expect(resolveInBand(4.682223, band)).toBeCloseTo(4.682223, 6);
    // Nothing plausible: neither reading lands in the band.
    expect(resolveInBand(9_999_999_999, band)).toBeNull();
  });
});

describe('INVARIANT: the window outlives the venue, not the other way round', () => {
  it('finds a fill that only appears after the first probe', async () => {
    // Defect (2). The old flatten fired at ~1.5s against a match that landed at
    // +2.9s. A reconciler that gives up on probe one reproduces it exactly.
    const { sleep, waits } = fakeClock();
    let probe = 0;
    const res = await reconcileArbLeg({
      orderId: '0xorder',
      tokenId: 'tok-up',
      depositWallet: '0xdead',
      expectedShares: GHOST.expectedShares,
      price: GHOST.price,
      tolerance: GHOST.tolerance,
      getMatched: async () => (++probe >= 3 ? GHOST.actualShares : null),
      getWalletShares: async () => 0,
      sleep,
    });

    expect(res.outcome).toBe('filled');
    expect(res.probes).toHaveLength(3);
    // The schedule has to reach past the observed 2.9s settle latency.
    expect(PROBE_SCHEDULE_MS[PROBE_SCHEDULE_MS.length - 1]).toBeGreaterThanOrEqual(2900);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(PROBE_SCHEDULE_MS[PROBE_SCHEDULE_MS.length - 1]);
  });

  it('does not accept an early zero from the order record', async () => {
    // An order row can read `size_matched: 0` while the match is still being
    // written. Taking that at face value on probe one is the same mistake in a
    // different door.
    const { sleep } = fakeClock();
    let probe = 0;
    const res = await reconcileArbLeg({
      orderId: '0xorder',
      tokenId: 'tok-up',
      expectedShares: GHOST.expectedShares,
      price: GHOST.price,
      tolerance: GHOST.tolerance,
      getMatched: async () => (++probe === 1 ? 0 : GHOST.actualShares),
      sleep,
    });

    expect(res.outcome).toBe('filled');
  });

  it('stops the moment a fill is confirmed rather than burning the window', async () => {
    const { sleep, waits } = fakeClock();
    const res = await reconcileArbLeg({
      orderId: '0xorder',
      tokenId: 'tok-up',
      expectedShares: GHOST.expectedShares,
      price: GHOST.price,
      tolerance: GHOST.tolerance,
      getMatched: async () => GHOST.actualShares,
      sleep,
    });

    expect(res.outcome).toBe('filled');
    expect(res.probes).toHaveLength(1);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('INVARIANT: door A works when door B structurally cannot', () => {
  it('confirms from the wallet when the transport returned no order id', async () => {
    const { sleep } = fakeClock();
    const getMatched = vi.fn(async () => null);
    const res = await reconcileArbLeg({
      orderId: null,
      tokenId: 'tok-up',
      depositWallet: '0xdead',
      expectedShares: GHOST.expectedShares,
      price: GHOST.price,
      tolerance: GHOST.tolerance,
      getMatched,
      getWalletShares: async () => GHOST.actualShares,
      sleep,
    });

    expect(res.outcome).toBe('filled');
    expect(res.door).toBe('wallet');
    expect(res.shares).toBeCloseTo(GHOST.actualShares, 6);
    // No order id means door B is not even consulted.
    expect(getMatched).not.toHaveBeenCalled();
  });

  it('measures the change in holdings, not the holdings', async () => {
    // Shares already held before the order must not read as this order filling.
    // A wallet that holds exactly what it held before, on every probe, is
    // saying this order added nothing — which is a clean abort, not a fill.
    const { sleep } = fakeClock();
    const res = await reconcileArbLeg({
      orderId: null,
      tokenId: 'tok-up',
      depositWallet: '0xdead',
      expectedShares: GHOST.expectedShares,
      price: GHOST.price,
      tolerance: GHOST.tolerance,
      baselineShares: 100,
      getWalletShares: async () => 100,
      sleep,
    });

    expect(res.outcome).toBe('unfilled');
    expect(res.outcome).not.toBe('filled');
  });

  it('survives a door that throws rather than answering', async () => {
    const { sleep } = fakeClock();
    const res = await reconcileArbLeg({
      orderId: '0xorder',
      tokenId: 'tok-up',
      depositWallet: '0xdead',
      expectedShares: GHOST.expectedShares,
      price: GHOST.price,
      tolerance: GHOST.tolerance,
      getMatched: async () => { throw new Error('proxy 502'); },
      getWalletShares: async () => { throw new Error('dns'); },
      sleep,
    });

    // A door that throws has not spoken; it must not be read as "no shares".
    expect(res.outcome).toBe('unknown');
    expect(res.probes).toHaveLength(PROBE_SCHEDULE_MS.length);
  });
});

describe('INVARIANT: a blind leg stops the engine', () => {
  it('halts, stays halted, and clears only on an explicit operator action', () => {
    expect(isArbHalted()).toBe(false);

    haltArb('reconcile_blind', { slug: 'btc-updown-15m-1789097400' });
    expect(isArbHalted()).toBe(true);
    expect(arbHaltState().reason).toBe('reconcile_blind');

    // A second blind leg must not overwrite the first — the first is the one
    // with an unaccounted position behind it.
    haltArb('reconcile_blind', { slug: 'eth-later' });
    expect(arbHaltState().detail.slug).toBe('btc-updown-15m-1789097400');

    const cleared = clearArbHalt();
    expect(cleared.detail.slug).toBe('btc-updown-15m-1789097400');
    expect(isArbHalted()).toBe(false);
  });

  it('refuses to open a new package while halted', async () => {
    const { detectAndExecuteArbPackage } = await import('../../src/polymarket/arbEngine.js');
    const { saveAllPackages } = await import('../../src/polymarket/arbPersistence.js');
    saveAllPackages([]);

    const args = {
      market: {
        symbol: 'BTC', slug: 'btc-halt-probe', conditionId: '0xhalt',
        outcomes: ['Up', 'Down'], tokenIds: { up: 'tok-up-h', down: 'tok-down-h' },
        acceptingOrders: true,
      },
      depth: { up: { bestAsk: 0.04, bestAskSize: 400 }, down: { bestAsk: 0.94, bestAskSize: 400 } },
      prices: { upAsk: 0.04, downAsk: 0.94 },
      cfg: {
        clobArbEnabled: true, minArbGap: 0.01, maxArbPackages: 4,
        arbBankrollFrac: 1.0, arbMaxUsd: 50, minPositionSize: 0.5, instantCtfMerge: false,
      },
      mode: 'live',
      readiness: { spendableBalance: 10_000, liveReady: true },
      log: () => {},
      executeTrade: async (p) => ({ ok: true, position: { shares: p.plan.shares } }),
      adjustPaperCash: () => {},
      saveTrade: () => {},
      botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
    };

    // Same book, both sides of the halt — so the test proves the halt is what
    // changed the answer, not the fixture.
    expect(await detectAndExecuteArbPackage(args)).not.toBeNull();

    saveAllPackages([]);
    haltArb('reconcile_blind', { slug: 'btc-updown-15m-1789097400' });
    expect(await detectAndExecuteArbPackage(args)).toBeNull();
  });
});

/**
 * The softened halt (2026-09-14). The first cut halted on any unresolved leg,
 * which meant an ordinary blip on the order POST — nothing filled, connection
 * hiccupped — stopped arbitrage outright. That is the commonest failure and the
 * least dangerous one. These pin the line where it now sits.
 */
describe('INVARIANT: only true blindness halts', () => {
  it('a healthy wallet reporting nothing, every probe, is a clean abort', async () => {
    const { sleep } = fakeClock();
    const res = await reconcileArbLeg({
      orderId: null,                       // transport dropped before any id
      tokenId: 'tok-up',
      depositWallet: '0xdead',
      expectedShares: GHOST.expectedShares,
      price: GHOST.price,
      tolerance: GHOST.tolerance,
      getWalletShares: async () => 0,      // answered, three times, nothing held
      sleep,
    });

    expect(res.outcome).toBe('unfilled');
    expect(res.door).toBe('wallet');
    expect(res.blind).toBe(false);
  });

  it('distinguishes a wallet that answered zero from one that did not answer', async () => {
    // The distinction the whole softening rests on. Same outcome shape from the
    // caller's side; completely different evidence.
    const { sleep } = fakeClock();
    const silent = await reconcileArbLeg({
      orderId: null, tokenId: 'tok-up', depositWallet: '0xdead',
      expectedShares: GHOST.expectedShares, price: GHOST.price, tolerance: GHOST.tolerance,
      getWalletShares: async () => null,   // endpoint declined to answer
      sleep,
    });

    expect(silent.outcome).toBe('unknown');
    expect(silent.blind).toBe(true);
  });

  it('will not abort on a partial wallet answer', async () => {
    // Two answers out of three is not the claim "you hold nothing" — it is one
    // reading plus a gap, and the gap could be where the fill was.
    const { sleep } = fakeClock();
    let probe = 0;
    const res = await reconcileArbLeg({
      orderId: null, tokenId: 'tok-up', depositWallet: '0xdead',
      expectedShares: GHOST.expectedShares, price: GHOST.price, tolerance: GHOST.tolerance,
      getWalletShares: async () => (++probe === 2 ? null : 0),
      sleep,
    });

    expect(res.outcome).toBe('unknown');
    // But not blind — something spoke, so this does not halt the engine.
    expect(res.blind).toBe(false);
  });

  it('a late fill still beats three healthy zeros', async () => {
    // Ordering guard: the wallet-zero rule must never outrank a confirmed fill.
    const { sleep } = fakeClock();
    let probe = 0;
    const res = await reconcileArbLeg({
      orderId: null, tokenId: 'tok-up', depositWallet: '0xdead',
      expectedShares: GHOST.expectedShares, price: GHOST.price, tolerance: GHOST.tolerance,
      getWalletShares: async () => (++probe === 3 ? GHOST.actualShares : 0),
      sleep,
    });

    expect(res.outcome).toBe('filled');
    expect(res.shares).toBeCloseTo(GHOST.actualShares, 6);
  });
});

/**
 * The sweep. This is the part that makes the softened halt safe: reconciliation
 * is a window and windows can be raced, but this re-reads ground truth forever.
 */
describe('INVARIANT: a holding the bot cannot account for does not survive', () => {
  const row = (over = {}) => ({
    asset: 'tok-ghost', size: 4.682223, curPrice: 0.2648,
    slug: 'btc-updown-15m-1789097400', outcome: 'Up', redeemable: false, currentValue: 1.24, ...over,
  });

  it('finds the 2026-09-11 ghost — a balance no position claims', () => {
    const found = findUnrecordedHoldings({
      walletRows: [row()],
      botPositions: [{ tokenId: 'tok-something-else', closed: false }],
      now: 2_000_000,
      inFlight: new Map(),
    });

    expect(found).toHaveLength(1);
    expect(found[0].asset).toBe('tok-ghost');
  });

  it('leaves holdings the bot does know about alone', () => {
    // Including closed ones: a closed position whose shares are still held is a
    // different divergence, and selling on a guess is how you realise a loss
    // that was about to settle at $1.00.
    expect(findUnrecordedHoldings({
      walletRows: [row()],
      botPositions: [{ tokenId: 'tok-ghost', closed: false }],
      now: 2_000_000, inFlight: new Map(),
    })).toHaveLength(0);

    expect(findUnrecordedHoldings({
      walletRows: [row()],
      botPositions: [{ tokenId: 'tok-ghost', closed: true }],
      now: 2_000_000, inFlight: new Map(),
    })).toHaveLength(0);
  });

  it('will not sweep a fill that is still being written', () => {
    // The race the grace window exists for: between the venue confirming and
    // `botState.positions.push`, the wallet holds shares no position claims yet.
    const inFlight = new Map([['tok-ghost', 1_995_000]]);

    expect(findUnrecordedHoldings({
      walletRows: [row()], botPositions: [], now: 2_000_000, graceMs: 10_000, inFlight,
    })).toHaveLength(0);

    // Once the grace window has passed, it is fair game again.
    expect(findUnrecordedHoldings({
      walletRows: [row()], botPositions: [], now: 2_010_001, graceMs: 10_000, inFlight,
    })).toHaveLength(1);
  });

  it('ignores resolved worthless tokens', () => {
    // Item 68: a losing token sits in the feed with size > 0 and value $0.
    // There is nothing to sell and an order for it is pure noise.
    expect(findUnrecordedHoldings({
      walletRows: [row({ redeemable: true, currentValue: 0 })],
      botPositions: [], now: 2_000_000, inFlight: new Map(),
    })).toHaveLength(0);
  });

  it('treats an unavailable positions feed as no information', () => {
    // Must never read "the endpoint is down" as "the wallet is empty" — that
    // direction is harmless here, but the opposite reading would make the sweep
    // fire blind orders during an outage.
    expect(findUnrecordedHoldings({ walletRows: null, botPositions: [] })).toEqual([]);
    expect(findUnrecordedHoldings({ walletRows: [], botPositions: [] })).toEqual([]);
  });
});

/**
 * Door A's HTTP contract. The entire softening rests on one distinction — a
 * wallet that ANSWERS "nothing" versus one that does not answer — and that
 * distinction is made in exactly one place, here. If a failed request ever
 * returns an empty list instead of null, three dead responses resolve to
 * `unfilled` and the bot is back to abandoning live legs silently.
 *
 * Found by mutation: the reconciler tests all inject `getWalletShares`, so none
 * of them exercised this boundary at all.
 */
describe('INVARIANT: a failed request is never an answer of "nothing"', () => {
  const ok = (body) => ({ ok: true, json: async () => body });
  const row = { asset: 'tok-up', size: 4.682223 };

  it('returns null — not zero — on a non-200', async () => {
    for (const status of [{ ok: false, status: 500 }, { ok: false, status: 429 }, { ok: false, status: 403 }]) {
      expect(await fetchWalletShares('0xdead', 'tok-up', { fetchImpl: async () => status })).toBeNull();
    }
  });

  it('returns null when the request throws outright', async () => {
    const boom = async () => { throw new Error('ECONNRESET'); };
    expect(await fetchWalletShares('0xdead', 'tok-up', { fetchImpl: boom })).toBeNull();
    expect(await fetchWalletPositions('0xdead', { fetchImpl: boom })).toBeNull();
  });

  it('returns null when the body is not the list it claims to be', async () => {
    expect(await fetchWalletShares('0xdead', 'tok-up', { fetchImpl: async () => ok({ error: 'nope' }) })).toBeNull();
    expect(await fetchWalletShares('0xdead', 'tok-up', { fetchImpl: async () => ok(null) })).toBeNull();
  });

  it('returns 0 only when the endpoint really said so', async () => {
    // A 200 with the token absent is a genuine answer: you hold nothing.
    expect(await fetchWalletShares('0xdead', 'tok-up', { fetchImpl: async () => ok([]) })).toBe(0);
    expect(await fetchWalletShares('0xdead', 'tok-up', { fetchImpl: async () => ok([{ asset: 'other', size: 9 }]) })).toBe(0);
  });

  it('reads the holding when there is one', async () => {
    expect(await fetchWalletShares('0xdead', 'tok-up', { fetchImpl: async () => ok([row]) })).toBeCloseTo(4.682223, 6);
  });
});
