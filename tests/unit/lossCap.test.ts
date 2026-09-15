// @ts-nocheck
/**
 * INVARIANT: a losing loop stops itself (item 74b).
 *
 * The finding this encodes: nothing in the bot could stop a bleed.
 * `grep -riE 'maxDailyLoss|lossLimit|circuitBreak|killSwitch'` across `src/`
 * returned nothing, and the three mechanisms that looked like brakes were not:
 *
 *   1. `maxArbPackages` caps CONCURRENT packages. An aborted package frees its
 *      slot at once (`arbEngine.ts:139-145`), so fail → unwind → retry can run
 *      every window indefinitely.
 *   2. The governor's drawdown breaker forces `arb-only` (`governor.ts:390`) —
 *      if arb is losing, the safety mechanism aims at it.
 *   3. The portfolio breaker measures UNREALISED loss on OPEN positions
 *      (`bot.ts:2782-2799`). A loop that realises its losses and closes leaves
 *      nothing where that breaker looks.
 *
 * The properties below are about the SHAPE of the loss, not a fixture of one:
 * many small realised losses must trip the cap exactly as one large one does,
 * because that is the case every existing mechanism misses.
 */
import { describe, it, expect } from 'vitest';
import { lossCapStatus, LOSS_WINDOW_MS } from '../../src/polymarket/lossCap.js';

const NOW = 1_800_000_000_000;

/**
 * A closed trade worth `netPnl` dollars.
 *
 * Expressed as entry/exit/shares rather than as a `pnl` field, because
 * `tradeRealizedPnl` (`audit.ts:29`) deliberately recomputes from those
 * primitives and ignores a stored `pnl` whenever they are present — records
 * written before item 23 carry a GROSS `pnl` and nothing distinguishes them
 * from net ones. A fixture that sets `pnl` directly would therefore test a code
 * path the live ledger never takes. (Learned by writing it the wrong way first:
 * every loss silently evaluated to $0 and the cap never tripped.)
 */
const SHARES = 10;
const trade = (netPnl, over = {}) => ({
  id: `t-${Math.random()}`,
  mode: 'live',
  timestamp: NOW - 60_000,
  entryPrice: 0.5,
  exitPrice: Math.round((0.5 + netPnl / SHARES) * 1e6) / 1e6,
  shares: SHARES,
  feesPaid: 0,
  ...over,
});

const status = (trades, capUsd = 10, now = NOW) =>
  lossCapStatus({ trades, mode: 'live', capUsd, now, resetAt: 0 });

describe('INVARIANT: death by a thousand cuts trips the cap', () => {
  it('accumulates many small realised losses — the case every other breaker misses', () => {
    // Forty aborted round trips eating $0.30 of spread each. No position stays
    // open, so portfolio drawdown reads zero the whole way down.
    const s = status(Array.from({ length: 40 }, () => trade(-0.30)));

    expect(s.lossUsd).toBeCloseTo(12, 2);
    expect(s.tripped).toBe(true);
    expect(s.tradesCounted).toBe(40);
  });

  it('treats one big loss and many small ones identically at the same total', () => {
    const many = status(Array.from({ length: 40 }, () => trade(-0.25)));
    const one = status([trade(-10)]);
    expect(many.lossUsd).toBeCloseTo(one.lossUsd, 2);
    expect(many.tripped).toBe(one.tripped);
  });

  it('nets wins against losses rather than counting gross losses', () => {
    // A strategy that loses $12 and makes $11 has lost $1, and a cap that read
    // $12 would stop a profitable bot.
    const s = status([trade(-12), trade(11)]);
    expect(s.realisedUsd).toBeCloseTo(-1, 2);
    expect(s.tripped).toBe(false);
  });
});

describe('INVARIANT: the window is rolling, and only the window counts', () => {
  it('drops losses older than 24 hours', () => {
    const old = trade(-50, { timestamp: NOW - LOSS_WINDOW_MS - 1000 });
    const recent = trade(-1);
    const s = status([old, recent]);

    expect(s.tradesCounted).toBe(1);
    expect(s.lossUsd).toBeCloseTo(1, 2);
    expect(s.tripped).toBe(false);
  });

  it('keeps a loss that is just inside the window', () => {
    const s = status([trade(-11, { timestamp: NOW - LOSS_WINDOW_MS + 1000 })]);
    expect(s.tripped).toBe(true);
  });

  it('does not hand out a fresh budget at midnight', () => {
    // Rolling, not calendar-day: a loop starting at 23:00 must not be given a
    // clean slate an hour later.
    const evening = Array.from({ length: 5 }, (_, i) =>
      trade(-2.5, { timestamp: NOW - (60 * 60 * 1000) - i * 1000 }));
    expect(status(evening).tripped).toBe(true);
  });

  it('ignores trades from the other mode', () => {
    // Paper losses must never brake live trading, or vice versa.
    const s = status([trade(-50, { mode: 'paper' }), trade(-1)]);
    expect(s.tradesCounted).toBe(1);
    expect(s.tripped).toBe(false);
  });
});

describe('INVARIANT: an operator reset clears it, and nothing else does', () => {
  it('excludes everything before the reset marker', () => {
    const losses = Array.from({ length: 40 }, () => trade(-0.30));
    expect(status(losses).tripped).toBe(true);

    const after = lossCapStatus({
      trades: losses, mode: 'live', capUsd: 10, now: NOW, resetAt: NOW - 1000,
    });
    expect(after.tradesCounted).toBe(0);
    expect(after.tripped).toBe(false);
  });

  it('is derived from the ledger, so a restart cannot clear it', () => {
    // The whole reason the cap reads trades instead of holding a counter: an
    // in-memory tally is wiped by the crash-loop it exists to stop.
    const losses = Array.from({ length: 40 }, () => trade(-0.30));
    const first = status(losses);
    const afterRestart = status(losses);   // same ledger, fresh process
    expect(afterRestart.lossUsd).toBeCloseTo(first.lossUsd, 2);
    expect(afterRestart.tripped).toBe(true);
  });
});

describe('INVARIANT: the cap says which engine did the damage', () => {
  it('attributes the loss so the alert points somewhere', () => {
    const s = status([
      trade(-9, { isArbLeg: true, packageId: 'pkg-1' }),
      trade(-2),
    ]);
    expect(s.byEngine.arb).toBeCloseTo(-9, 2);
    expect(s.byEngine.directional).toBeCloseTo(-2, 2);
    expect(s.worstEngine).toBe('arb');
    expect(s.tripped).toBe(true);
  });

  it('points at directional when directional is the loser', () => {
    // Found by mutation: hard-coding `worstEngine: 'arb'` passed every other
    // test here. An alert that names the wrong engine is worse than one that
    // names none — it sends the operator to read the innocent ledger.
    const s = status([
      trade(-9),
      trade(-2, { isArbLeg: true, packageId: 'pkg-1' }),
    ]);
    expect(s.byEngine.directional).toBeCloseTo(-9, 2);
    expect(s.byEngine.arb).toBeCloseTo(-2, 2);
    expect(s.worstEngine).toBe('directional');
  });

  it('reports no worst engine when nothing is losing', () => {
    expect(status([trade(5)]).worstEngine).toBeNull();
  });
});

describe('INVARIANT: a cap of zero is off, not instantly tripped', () => {
  it('disables cleanly so paper runs produce their evidence', () => {
    // Paper ships with the cap off on purpose — a paper run exists to find out
    // how bad a defect gets, and a brake there truncates the evidence.
    const s = status([trade(-500)], 0);
    expect(s.enabled).toBe(false);
    expect(s.tripped).toBe(false);
    expect(s.remainingUsd).toBeNull();
  });

  it('still reports the loss while disabled', () => {
    // Off must mean "does not stop trading", never "does not look".
    expect(status([trade(-500)], 0).lossUsd).toBeCloseTo(500, 2);
  });
});
