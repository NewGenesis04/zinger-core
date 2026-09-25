// @ts-nocheck
/**
 * INVARIANTS: every live leg the venue refuses records how long it was in
 * flight and what the book looked like just after (item 109).
 *
 * The VPS package records (2026-09-22) ruled out a stale snapshot: leg 1 is
 * killed on books 17-60 ms old, and 56 of 59 packages failed regardless of gap
 * width. The ask goes somewhere between dispatch and the venue. These fields
 * are what tell "the price moved in transit" from "someone took it first" from
 * "it was never executable", and each points at a different fix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { detectAndExecuteArbPackage, classifyKill } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages } from '../../src/polymarket/arbPersistence.js';

/**
 * Item 99: a package only opens with at least `arbMinWindowSecondsLeft` (60s)
 * of window left, so the dispatch fixtures below carry a window that is still
 * open. Nothing here is about entry timing — that rule is pinned in
 * `invariants.windowTiming.test.ts`.
 */
const OPEN_WINDOW = (asset) => `${asset}-updown-5m-${Math.floor(Date.now() / 1000 / 300) * 300 + 300}`;

describe('classifyKill', () => {
  const t0 = 1_000_000;
  const after = (o) => ({ bestAsk: 0.46, bestAskSize: 100, bookTs: t0 + 300, ...o });

  it('names each cause from the book just after the refusal', () => {
    expect(classifyKill({ after: after({ bestAsk: 0.48 }), signedPrice: 0.46, requestedShares: 10, submittedAt: t0 })).toBe('ask_moved_up');
    expect(classifyKill({ after: after({ bestAskSize: 4 }), signedPrice: 0.46, requestedShares: 10, submittedAt: t0 })).toBe('size_thinned');
    expect(classifyKill({ after: after(), signedPrice: 0.46, requestedShares: 10, submittedAt: t0 })).toBe('unchanged');
  });

  it('refuses to judge a book the socket has not updated since dispatch', () => {
    // Otherwise the "after" book is the "before" book, and every kill would
    // read as `unchanged`.
    expect(classifyKill({ after: after({ bookTs: t0 - 50 }), signedPrice: 0.46, requestedShares: 10, submittedAt: t0 })).toBe('no_book_update');
  });

  it('says unknown with no socket book', () => {
    expect(classifyKill({ after: null, signedPrice: 0.46, requestedShares: 10 })).toBe('unknown');
    expect(classifyKill({ after: { bestAsk: 0 }, signedPrice: 0.46, requestedShares: 10 })).toBe('unknown');
  });
});

describe('INVARIANT: a refused live leg carries its transit time and post-kill book', () => {
  beforeEach(() => saveAllPackages([]));

  const market = {
    symbol: 'ETH', slug: OPEN_WINDOW('eth'), conditionId: '0xkill', outcomes: ['Up', 'Down'],
    tokenIds: { up: 'tok-up', down: 'tok-down' }, acceptingOrders: true, tickSize: '0.01',
  };
  const run = ({ mode = 'live', peekBook }) => detectAndExecuteArbPackage({
    market,
    depth: {
      up: { bestAsk: 0.34, bestAskSize: 200, bookTs: Date.now() },
      down: { bestAsk: 0.58, bestAskSize: 200, bookTs: Date.now() },
    },
    prices: { up: 0.34, down: 0.58 },
    cfg: {
      clobArbEnabled: true, minArbGap: 0.01, maxArbPackages: 4, paperBankroll: 500, arbBankrollFrac: 0.2,
      arbMaxUsd: 50, minPositionSize: 0.5, arbLeg2RereadBook: false, mode,
    },
    mode,
    readiness: { spendableBalance: 500, liveReady: true },
    log: () => {},
    executeTrade: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: false, error: 'killed', rawError: "order couldn't be fully filled. FOK orders are fully filled or killed." };
    },
    adjustPaperCash: () => {},
    saveTrade: () => {},
    botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
    peekBook,
  });

  it('records the book the socket shows for the refused token', async () => {
    const asked = [];
    const pkg = await run({
      peekBook: (id) => { asked.push(id); return { bestAsk: 0.36, bestAskSize: 50, bestBid: 0.33, ts: Date.now(), stale: false }; },
    });
    expect(pkg.status).toBe('ABORTED');
    expect(asked).toEqual(['tok-up']);
    const leg = pkg.legs.up;
    expect(leg.transitMs).toBeGreaterThanOrEqual(15);
    expect(leg.kill.before).toEqual({ bestAsk: 0.34, bestAskSize: 200 });
    expect(leg.kill.after).toMatchObject({ bestAsk: 0.36, bestAskSize: 50, bestBid: 0.33, stale: false });
    expect(leg.kill.cause).toBe('ask_moved_up');
  });

  it('records `unknown`, and still aborts cleanly, when the book read fails', async () => {
    const pkg = await run({ peekBook: () => { throw new Error('no socket'); } });
    expect(pkg.status).toBe('ABORTED');
    expect(pkg.legs.up.kill).toMatchObject({ after: null, cause: 'unknown' });
  });

  it('records nothing for paper, which has no venue', async () => {
    const pkg = await run({ mode: 'paper', peekBook: () => { throw new Error('must not be read'); } });
    expect(pkg.legs.up.kill).toBeUndefined();
  });
});

describe('INVARIANT: the analysis script reports kill causes from package records', () => {
  it('tabulates causes and transit from a store', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zinger-kill-'));
    try {
      const dbFile = path.join(dir, 'zinger.db');
      const db = new DatabaseSync(dbFile);
      db.exec('CREATE TABLE docs (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const pkg = (id, cause, transitMs) => ({
        packageId: id, mode: 'live', status: 'ABORTED', slug: `eth-updown-5m-${id}`, gap: 0.05, createdAt: 1,
        legs: { up: { filled: false, bookAgeMs: 40, transitMs, kill: { cause } }, down: { filled: false } },
      });
      db.prepare('INSERT INTO docs VALUES (?, ?)').run('poly_packages.json', JSON.stringify([
        pkg('a', 'ask_moved_up', 700), pkg('b', 'ask_moved_up', 800), pkg('c', 'size_thinned', 750),
      ]));
      db.close();
      const script = fileURLToPath(new URL('../../scripts/arb-book-age.mjs', import.meta.url));
      const out = execFileSync(process.execPath, ['--no-warnings', script, dbFile], { encoding: 'utf8' });
      expect(out).toMatch(/ask_moved_up\s+2\s+67%/);
      expect(out).toMatch(/size_thinned\s+1\s+33%/);
      expect(out).toMatch(/killed 750 ms over 3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
