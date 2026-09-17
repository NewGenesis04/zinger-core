// @ts-nocheck
/**
 * INVARIANT: a stalled scan pass loses the loop, and can never trade again.
 *
 * The loop runs one pass at a time behind a flag lowered in a `finally`. A
 * `finally` only runs when the pass settles, so an await that never settles
 * holds the flag for the life of the process — the loop stops without stopping,
 * and every later tick returns immediately.
 *
 * Releasing the flag is only half a fix, and the dangerous half on its own:
 * nothing can cancel the stalled pass, so it may wake at any time holding prices
 * and a balance from before the stall, while a newer pass is live and sizing
 * against the same account. These tests pin both halves — the loop is taken
 * back, AND the abandoned pass is refused when it wakes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SCAN_STALL_MS,
  shouldAbandonPass,
  shouldAbandonCurrentPass,
  notePassProgress,
  passTimings,
  beginPass,
  runAsPass,
  ownsLoop,
  isStalePass,
  callingGeneration,
  currentGeneration,
  recordStall,
  scanStallCount,
  __resetScanGuard,
} from '../../src/polymarket/scanGuard.js';

beforeEach(() => { __resetScanGuard(); });

describe('INVARIANT: the watchdog fires only on a pass that is actually stuck', () => {
  // A real epoch time: "13 hours before now" must still be a positive timestamp,
  // since a non-positive one means "never stamped" and is handled separately.
  const now = Date.UTC(2026, 8, 17, 18, 0, 0);

  it('leaves a healthy pass alone', () => {
    expect(shouldAbandonPass({ scanning: true, startedAt: now - 1_000, now })).toBe(false);
    expect(shouldAbandonPass({ scanning: true, startedAt: now - (SCAN_STALL_MS - 1), now })).toBe(false);
  });

  it('abandons one held past the deadline', () => {
    expect(shouldAbandonPass({ scanning: true, startedAt: now - SCAN_STALL_MS, now })).toBe(true);
    expect(shouldAbandonPass({ scanning: true, startedAt: now - 13 * 3_600_000, now })).toBe(true);
  });

  it('never fires when no pass holds the loop', () => {
    expect(shouldAbandonPass({ scanning: false, startedAt: now - 13 * 3_600_000, now })).toBe(false);
  });

  it('treats a missing start time as "not yet stalled", not as instantly stale', () => {
    // A pass holding the flag with no timestamp is unexplained, not old. Firing
    // here would abandon a pass that started microseconds ago.
    for (const startedAt of [0, null, undefined, NaN]) {
      expect(shouldAbandonPass({ scanning: true, startedAt, now }), String(startedAt)).toBe(false);
    }
  });
});

describe('INVARIANT: an abandoned pass cannot act, and a live one can', () => {
  it('refuses the zombie and allows the pass that replaced it', async () => {
    const stalled = beginPass();
    let zombieSawStale = null;
    let zombieGen = null;

    // The stalled pass is parked mid-await, exactly as a hung network call parks it.
    let wake;
    const parked = new Promise((resolve) => { wake = resolve; });
    const zombie = runAsPass(stalled, async () => {
      await parked;
      zombieSawStale = isStalePass();
      zombieGen = callingGeneration();
    });

    // The watchdog hands the loop to a new pass.
    const fresh = beginPass();
    const freshSawStale = await runAsPass(fresh, async () => isStalePass());

    wake();
    await zombie;

    expect(freshSawStale).toBe(false);   // the live pass may trade
    expect(zombieSawStale).toBe(true);   // the woken zombie may not
    expect(zombieGen).toBe(stalled);
    expect(currentGeneration()).toBe(fresh);
  });

  it('keeps the pass identity across awaits, so a guard deep in a call chain still sees it', async () => {
    const gen = beginPass();
    const seen = await runAsPass(gen, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      const deeper = async () => async () => callingGeneration();
      return (await (await deeper())());
    });
    expect(seen).toBe(gen);
  });

  it('treats work outside any pass as never stale', async () => {
    // An operator approving a trade by hand, or a timer, is not a scan pass.
    beginPass();
    beginPass();
    expect(isStalePass()).toBe(false);
    expect(callingGeneration()).toBeNull();
  });
});

describe('INVARIANT: only the pass that owns the loop may release it', () => {
  it('lets the current pass release and refuses a superseded one', () => {
    const first = beginPass();
    expect(ownsLoop(first)).toBe(true);

    const second = beginPass();
    // The abandoned pass finishing later must not clear the flag: a third pass
    // would then start alongside the one that replaced it.
    expect(ownsLoop(first)).toBe(false);
    expect(ownsLoop(second)).toBe(true);
  });

  it('counts stalls so repeats are visible rather than silent', () => {
    expect(scanStallCount()).toBe(0);
    recordStall();
    recordStall();
    expect(scanStallCount()).toBe(2);
  });
});

/**
 * INVARIANT: the watchdog abandons a STOPPED pass, never a merely slow one.
 *
 * A pass covers every tradable market and each call inside it is separately
 * bounded, so on a degraded network a healthy pass can run far past any fixed
 * total budget. Judging by total duration would abandon working passes exactly
 * when the network is bad, and the replacement would meet the same network and
 * be abandoned in turn.
 */
describe('INVARIANT: slow is not stuck', () => {
  const t0 = Date.UTC(2026, 8, 18, 12, 0, 0);

  it('keeps a pass that is crawling but still finishing markets', () => {
    // Running 5 minutes, but did something 1 second ago.
    expect(shouldAbandonPass({
      scanning: true,
      startedAt: t0 - 300_000,
      lastProgressAt: t0 - 1_000,
      now: t0,
    })).toBe(false);
  });

  it('abandons a pass that has stopped, however briefly it had been running', () => {
    expect(shouldAbandonPass({
      scanning: true,
      startedAt: t0 - (SCAN_STALL_MS + 5_000),
      lastProgressAt: t0 - (SCAN_STALL_MS + 1),
      now: t0,
    })).toBe(true);
  });

  it('falls back to the start time before the first heartbeat', () => {
    // A pass that stalls in its first phase has no progress stamp at all.
    expect(shouldAbandonPass({ scanning: true, startedAt: t0 - SCAN_STALL_MS, lastProgressAt: 0, now: t0 })).toBe(true);
    expect(shouldAbandonPass({ scanning: true, startedAt: t0 - 1_000, lastProgressAt: 0, now: t0 })).toBe(false);
  });

  it('tracks the live pass through the module, not just the pure helper', () => {
    const gen = beginPass(t0);
    expect(passTimings().startedAt).toBe(t0);
    expect(shouldAbandonCurrentPass(true, t0 + SCAN_STALL_MS)).toBe(true);

    notePassProgress(t0 + SCAN_STALL_MS - 1);
    expect(shouldAbandonCurrentPass(true, t0 + SCAN_STALL_MS)).toBe(false);
    expect(ownsLoop(gen)).toBe(true);
  });

  it('refuses a heartbeat from a pass that was already abandoned', async () => {
    // Otherwise a zombie waking up would hold the watchdog off the live pass
    // that replaced it — a stuck pass kept alive on someone else's pulse.
    const stalled = beginPass(t0);
    let wake;
    const parked = new Promise((resolve) => { wake = resolve; });
    let zombieStamped = null;
    const zombie = runAsPass(stalled, async () => {
      await parked;
      zombieStamped = notePassProgress(t0 + 10_000);
    });

    beginPass(t0 + 1_000);
    wake();
    await zombie;

    expect(zombieStamped).toBe(false);
    expect(passTimings().lastProgressAt).toBe(0);
  });
});
