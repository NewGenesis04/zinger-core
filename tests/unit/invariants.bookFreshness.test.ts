// @ts-nocheck
/**
 * INVARIANTS: the engine acts on prices, not on memories of prices
 * (items 118, 119, 120).
 *
 * Measured over 33 live packages on 2026-09-25 — 1 filled, 32 killed:
 *
 *   no_book_update  18   the socket delivered nothing between dispatch and kill
 *   unchanged        7   the book still showed the ask the venue had refused
 *   unknown          6   no socket book at all
 *   ask_moved_up     1   the price moved in transit
 *   size_thinned     0   (only observable in the 8 cases where the book moved)
 *
 * One refusal in thirty-two is the transit story. The rest are a gate reading a
 * book the venue is not matching against. Three mechanisms produced that, and
 * each gets its own section below:
 *
 *   118  a cached book was usable for 15s, ages were never checked, the two
 *        sides aged independently, and a disconnect invalidated nothing.
 *   119  the leg-2 "re-read" asks the same cache, so an un-ticked socket
 *        returns the identical numbers and signs against them twice.
 *   120  an abort frees the slug at once, so the next 250ms pass rebuilds the
 *        same order from the same snapshot — 25 live orders in 35 seconds.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  detectAndExecuteArbPackage, __resetRefusedBooks,
} from '../../src/polymarket/arbEngine.js';
import { saveAllPackages, loadPackages } from '../../src/polymarket/arbPersistence.js';
import {
  upsertFromBook, getClobWsBook, getClobWsMid, __setFeedDownAt,
} from '../../src/polymarket/clobWs.js';
import { onEvent } from '../../src/polymarket/telemetry/events.js';

const slug = () => `eth-updown-5m-${Math.floor(Date.now() / 1000 / 300) * 300 + 300}`;

const market = (over = {}) => ({
  symbol: 'ETH', slug: slug(), conditionId: '0xfresh', outcomes: ['Up', 'Down'],
  tokenIds: { up: 'tok-up', down: 'tok-down' }, acceptingOrders: true, tickSize: '0.01',
  ...over,
});

/** An 8c gap: past break-even by a distance, so only freshness can refuse it. */
const books = ({ upAge = 0, downAge = null, ts = null } = {}) => {
  const now = ts ?? Date.now();
  return {
    up: { bestAsk: 0.34, bestAskSize: 500, bookTs: now - upAge, source: 'clob-ws' },
    down: { bestAsk: 0.58, bestAskSize: 500, bookTs: now - (downAge ?? upAge), source: 'clob-ws' },
  };
};

const baseCfg = {
  clobArbEnabled: true, minArbGap: 0.01, maxArbPackages: 4, paperBankroll: 500,
  arbBankrollFrac: 0.2, arbMaxUsd: 50, minPositionSize: 0.5, arbLeg2RereadBook: false,
};

/** Runs the detector and collects the skip codes it emitted. */
async function detect({ depth, cfg = {}, mode = 'paper', mkt = null, fills = true, ...rest }) {
  const codes = [];
  const off = onEvent('arb.decision', (e) => codes.push({
    code: e?.data?.output?.skipReason?.code ?? null,
    operands: e?.data?.output?.skipReason?.operands ?? null,
  }));
  try {
    const pkg = await detectAndExecuteArbPackage({
      market: mkt || market(),
      depth,
      prices: { up: 0.34, down: 0.58 },
      cfg: { ...baseCfg, mode, ...cfg },
      mode,
      readiness: { spendableBalance: 500, liveReady: true },
      log: () => {},
      executeTrade: async (pending) => (fills
        ? { ok: true, position: { shares: pending.plan.shares } }
        : { ok: false, error: 'killed', rawError: 'FOK orders are fully filled or killed.' }),
      adjustPaperCash: () => {},
      saveTrade: () => {},
      botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
      peekBook: () => null,
      ...rest,
    });
    return { pkg, codes, skips: codes.filter((c) => c.code).map((c) => c.code) };
  } finally {
    off();
  }
}

beforeEach(() => {
  saveAllPackages([]);
  __resetRefusedBooks();
  __setFeedDownAt(0);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: a gap is only a gap if both quotes were true at once (item 118)', () => {
  it('takes two fresh, synchronised books', () => detect({ depth: books({ upAge: 100 }) })
    .then(({ pkg, skips }) => {
      expect(skips).not.toContain('book_stale');
      expect(pkg?.status).toBe('LOCKED');
    }));

  it('refuses a book older than the bound, and names the age', async () => {
    // The 05:01 burst ran on books that aged to 6.2s between socket updates
    // while the scan loop ran every 250ms.
    const { pkg, codes } = await detect({ depth: books({ upAge: 6_227 }) });
    expect(pkg).toBeNull();
    const skip = codes.find((c) => c.code === 'book_stale');
    expect(skip.operands).toMatchObject({ reason: 'age', maxBookAgeMs: 1500 });
    expect(skip.operands.upAgeMs).toBeGreaterThanOrEqual(6_227);
  });

  it('refuses two fresh books taken at different moments', async () => {
    // THE PHANTOM. Both sides inside the age bound, four seconds apart: the
    // "gap" is the market having moved in between. Nothing compared these.
    const { pkg, codes } = await detect({
      depth: books({ upAge: 0, downAge: 4_000 }),
      cfg: { arbMaxBookAgeMs: 10_000 },
    });
    expect(pkg).toBeNull();
    const skip = codes.find((c) => c.code === 'book_stale');
    expect(skip.operands).toMatchObject({ reason: 'skew', maxBookSkewMs: 500 });
    expect(skip.operands.skewMs).toBeGreaterThanOrEqual(4_000);
  });

  it('refuses a book whose age it cannot establish', async () => {
    // Every production path stamps `bookTs` — the socket from the snapshot it
    // received, the REST fallback from the moment of the call. A book without
    // one came from neither, and "I cannot tell" is not a basis for an order.
    const depth = books();
    delete depth.down.bookTs;
    const { pkg, codes } = await detect({ depth });
    expect(pkg).toBeNull();
    expect(codes.find((c) => c.code === 'book_stale').operands.downAgeMs).toBeNull();
  });

  it('is the operator\'s dial on both halves', async () => {
    const stale = await detect({ depth: books({ upAge: 6_000 }), cfg: { arbMaxBookAgeMs: 0 } });
    expect(stale.pkg?.status, 'age bound not disengaged by 0').toBe('LOCKED');

    saveAllPackages([]);
    const skewed = await detect({
      depth: books({ upAge: 0, downAge: 4_000 }),
      cfg: { arbMaxBookAgeMs: 10_000, arbMaxBookSkewMs: 0 },
    });
    expect(skewed.pkg?.status, 'skew bound not disengaged by 0').toBe('LOCKED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: a book from before a disconnect is not a price (item 118)', () => {
  const TOK = 'tok-outage';
  // Explicit stamps: a book written in the same millisecond as the close counts
  // as predating it (the comparison is `<=`, deliberately — a snapshot racing a
  // disconnect is not evidence of anything), and `Date.now()` on both sides
  // would make that a coin flip rather than a test.
  const seed = (ts) => upsertFromBook(TOK, [{ price: '0.40', size: '10' }], [{ price: '0.42', size: '10' }], ts);

  it('withdraws every snapshot the outage predates, and keeps the ones it does not', () => {
    // THE REGRESSION. Neither handler touched the book map, so after a drop —
    // ~1.5 a minute on code 1013 — the bot read pre-disconnect quotes and
    // scored them fresh for the next 15 seconds.
    const droppedAt = Date.now();
    seed(droppedAt - 200);
    expect(getClobWsBook(TOK).stale).toBe(false);

    __setFeedDownAt(droppedAt);
    expect(getClobWsBook(TOK)).toMatchObject({ stale: true, predatesOutage: true });
    expect(getClobWsMid(TOK), 'a mid survived the outage its book did not').toBeNull();

    // The resubscribe snapshot lands: this book is current again, on its own
    // merits. The outage mark is per snapshot, not a global switch.
    seed(droppedAt + 1);
    expect(getClobWsBook(TOK).stale).toBe(false);
    expect(getClobWsMid(TOK)).toBeCloseTo(0.41, 6);
  });

  it('leaves books alone when the feed has never dropped', () => {
    seed(Date.now());
    __setFeedDownAt(0);
    expect(getClobWsBook(TOK).stale).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: a re-read that returns the same book is not a re-read (item 119)', () => {
  const runLeg2 = async ({ cacheTs, snapshotTs, venueAsk = 0.32, venue = null }) => {
    const calls = { venue: 0 };
    const depth = {
      up: { bestAsk: 0.34, bestAskSize: 500, bestBid: 0.33, bookTs: snapshotTs },
      down: { bestAsk: 0.58, bestAskSize: 500, bookTs: snapshotTs },
    };
    const signed = [];
    const { pkg } = await detect({
      depth,
      cfg: { arbLeg2RereadBook: true, arbLeg2BufferTicks: 1 },
      mode: 'live',
      refetchDepth: async () => ({
        up: { bestAsk: 0.34, bestBid: 0.33, bestAskSize: 500, bookTs: cacheTs },
        down: { bestAsk: 0.58, bestAskSize: 500, bookTs: cacheTs },
      }),
      refetchBook: venue || (async () => {
        calls.venue += 1;
        return { bestAsk: venueAsk, bestAskSize: 500, bestBid: venueAsk - 0.01 };
      }),
      executeTrade: async (pending) => {
        signed.push({ outcome: pending.outcome, price: pending.plan.price });
        return { ok: true, position: { shares: pending.plan.shares } };
      },
    });
    return { pkg, signed, calls };
  };

  it('goes to the venue when the cache has not moved since the snapshot', async () => {
    // `pkg-eth-mugxs3bm`: DOWN re-read at 513ms of age, signed 0.36, filled
    // 0.32. The re-read returned the same cache the scan had already used.
    const now = Date.now();
    const { signed, calls } = await runLeg2({ snapshotTs: now - 500, cacheTs: now - 500, venueAsk: 0.32 });

    expect(calls.venue, 'signed leg 2 off the cache twice').toBe(1);
    const leg2 = signed.find((s) => s.outcome === 'down');
    // The venue's 0.32 plus the one-tick buffer, not the cache's 0.58.
    expect(leg2.price).toBeCloseTo(0.33, 6);
  });

  it('does not call the venue when the socket has genuinely ticked', async () => {
    const now = Date.now();
    const { signed, calls } = await runLeg2({ snapshotTs: now - 800, cacheTs: now - 50 });

    expect(calls.venue, 'paid for a read it did not need').toBe(0);
    expect(signed.find((s) => s.outcome === 'down').price).toBeCloseTo(0.59, 6);
  });

  it('falls back to the quote rather than not trading when the venue read fails', async () => {
    const now = Date.now();
    const { pkg, signed } = await runLeg2({
      snapshotTs: now - 500, cacheTs: now - 500,
      venue: async () => { throw new Error('venue unreachable'); },
    });

    expect(pkg.status, 'a failed read left leg 1 naked').toBe('LOCKED');
    expect(signed.find((s) => s.outcome === 'down').price).toBeCloseTo(0.59, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: one refusal per book (item 120)', () => {
  it('will not re-send the same signal against the same two snapshots', async () => {
    // THE REGRESSION: 25 live FOK orders in 35 seconds, one slug, one price,
    // one unchanged book.
    const mkt = market();
    const depth = books({ upAge: 100 });
    const first = await detect({ mkt, depth, mode: 'live', fills: false });
    expect(first.pkg.status).toBe('ABORTED');

    for (let pass = 0; pass < 5; pass += 1) {
      const again = await detect({ mkt, depth, mode: 'live', fills: false });
      expect(again.pkg, `pass ${pass} re-sent a refused signal`).toBeNull();
      expect(again.skips).toContain('awaiting_book_update');
    }
    // One package, not six: the aborted one.
    expect(loadPackages().filter((p) => p.status === 'ABORTED')).toHaveLength(1);
  });

  it('clears as soon as both books carry new data', async () => {
    const mkt = market();
    await detect({ mkt, depth: books({ upAge: 100 }), mode: 'live', fills: false });

    const ticked = books({ upAge: 0, ts: Date.now() + 1 });
    const { pkg, skips } = await detect({ mkt, depth: ticked, mode: 'live' });
    expect(skips).not.toContain('awaiting_book_update');
    expect(pkg?.status).toBe('LOCKED');
  });

  it('does not clear when only one side ticks, because the phantom is one stale leg', async () => {
    const mkt = market();
    const at = Date.now();
    await detect({ mkt, depth: books({ upAge: 100, ts: at }), mode: 'live', fills: false });

    const half = books({ upAge: 100, ts: at });
    half.up.bookTs = at + 50; // UP moved, DOWN is the same snapshot as before
    const { pkg, skips } = await detect({ mkt, depth: half, mode: 'live' });
    expect(skips).toContain('awaiting_book_update');
    expect(pkg).toBeNull();
  });

  it('remembers per slug, so one market does not mute another', async () => {
    const at = Date.now();
    await detect({ mkt: market(), depth: books({ upAge: 100, ts: at }), mode: 'live', fills: false });

    const other = market({ slug: `btc-updown-5m-${Math.floor(at / 1000 / 300) * 300 + 300}`, symbol: 'BTC' });
    const { pkg } = await detect({ mkt: other, depth: books({ upAge: 100, ts: at }), mode: 'live' });
    expect(pkg?.status).toBe('LOCKED');
  });

  it('is the operator\'s dial', async () => {
    const mkt = market();
    const depth = books({ upAge: 100 });
    await detect({ mkt, depth, mode: 'live', fills: false });

    const { pkg, skips } = await detect({
      mkt, depth, mode: 'live', fills: false, cfg: { arbRefuseRefireOnSameBook: false },
    });
    // It asked the venue again on the same book: the pre-120 behaviour.
    expect(skips).not.toContain('awaiting_book_update');
    expect(pkg?.status).toBe('ABORTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Throws unless a close withdraws the books it predates. */
function checkOutageWiring(ws) {
  if (!/ws\.on\('close'[\s\S]{0,400}?feedDownAt = Date\.now\(\);/.test(ws)) {
    throw new Error('a disconnect does not invalidate cached books');
  }
  if (!/function predatesOutage\(snap\) \{[\s\S]{0,160}?feedDownAt > 0 && Number\(snap\?\.ts\) <= feedDownAt/.test(ws)) {
    throw new Error('the outage test is not per snapshot');
  }
  for (const reader of ['getClobWsMid', 'getClobWsBook']) {
    const body = ws.slice(ws.indexOf(`export function ${reader}(`), ws.indexOf('\n}', ws.indexOf(`export function ${reader}(`)));
    if (!body.includes('predatesOutage(snap)')) throw new Error(`${reader} ignores the outage`);
  }
}

/** Throws unless both gates run before anything is dispatched. */
function checkGateOrder(engine) {
  const dispatch = engine.indexOf('Promise.allSettled') > 0
    ? engine.indexOf('Promise.allSettled')
    : engine.indexOf('executeArbLeg({ outcome: \'up\'');
  for (const code of ["'book_stale'", "'awaiting_book_update'"]) {
    const at = engine.indexOf(code);
    if (at < 0) throw new Error(`${code} is gone`);
    if (at > dispatch) throw new Error(`${code} runs after dispatch`);
  }
  if (!/if \(upShares <= 0\) rememberRefusal\(market\.slug, upBookTs, downBookTs\);/.test(engine)) {
    throw new Error('a refused leg is not remembered');
  }
}

describe('INVARIANT: the checks sit where they can still change the outcome', () => {
  const ws = src('../../src/polymarket/clobWs.ts');
  const engine = src('../../src/polymarket/arbEngine.ts');

  it('holds for the real sources', () => {
    expect(() => checkOutageWiring(ws)).not.toThrow();
    expect(() => checkGateOrder(engine)).not.toThrow();
  });

  it('fails if the close stops marking the outage', () => {
    const broken = ws.replace('    feedDownAt = Date.now();\n', '');
    expect(broken).not.toBe(ws);
    expect(() => checkOutageWiring(broken)).toThrow(/does not invalidate/);
  });

  it('fails if a reader stops asking', () => {
    const broken = ws.replace('  if (predatesOutage(snap)) return null;\n', '');
    expect(broken).not.toBe(ws);
    expect(() => checkOutageWiring(broken)).toThrow(/getClobWsMid ignores/);
  });

  it('fails if refusals stop being remembered', () => {
    const broken = engine.replace('if (upShares <= 0) rememberRefusal(market.slug, upBookTs, downBookTs);', '');
    expect(broken).not.toBe(engine);
    expect(() => checkGateOrder(broken)).toThrow(/not remembered/);
  });
});
