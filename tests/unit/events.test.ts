import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emitEvent,
  queryEvents,
  getLatestEvent,
  clearEvents,
  onEvent,
  formatEventAsLog,
  telemetryBus,
  TELEMETRY_SCHEMA_VERSION,
  queryEventsPage,
  buildSyncFrame,
  evictedCount,
  setEventBufferCapacity,
  DEFAULT_EVENT_BUFFER_CAP,
  subscriberErrors,
} from '../../src/polymarket/telemetry/events.js';

describe('telemetry/events.ts (D8 Event System)', () => {
  beforeEach(() => {
    clearEvents();
  });

  it('emits typed events with version and timestamp', () => {
    const event = emitEvent('trade.decision', {
      symbol: 'BTC',
      slug: 'btc-updown-5m-1700000000',
      action: 'buy',
      outcome: 'up',
      confidence: 0.62,
      reason: 'signal UP 62%',
      engine: 'directional',
    });

    expect(event.id).toMatch(/^evt-\d+-\d+$/);
    expect(event.v).toBe(TELEMETRY_SCHEMA_VERSION);
    expect(event.type).toBe('trade.decision');
    expect(event.data.symbol).toBe('BTC');
    expect(telemetryBus.size()).toBe(1);
  });

  it('queries events with multi-field filtering', () => {
    emitEvent('scan.cycle', { scanNumber: 1, marketCount: 2, buyCount: 0 });
    emitEvent('trade.decision', { symbol: 'BTC', slug: 'btc-updown-5m-1', action: 'buy' });
    emitEvent('trade.decision', { symbol: 'ETH', slug: 'eth-updown-5m-1', action: 'skip' });
    emitEvent('position.exit', { symbol: 'BTC', slug: 'btc-updown-5m-0', exitReason: 'tp', netPnl: 4.5 });

    const btcDecisions = queryEvents({ type: 'trade.decision', symbol: 'BTC' });
    expect(btcDecisions).toHaveLength(1);
    expect(btcDecisions[0].data.slug).toBe('btc-updown-5m-1');

    const exits = queryEvents({ type: 'position.exit' });
    expect(exits).toHaveLength(1);
    expect(exits[0].data.netPnl).toBe(4.5);

    const limited = queryEvents({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('retrieves the latest event by type', () => {
    emitEvent('scan.cycle', { scanNumber: 1 });
    emitEvent('trade.decision', { symbol: 'BTC', action: 'hold' });
    emitEvent('scan.cycle', { scanNumber: 2 });

    const latestScan = getLatestEvent('scan.cycle');
    expect(latestScan).not.toBeNull();
    expect(latestScan?.data.scanNumber).toBe(2);

    const latestDec = getLatestEvent('trade.decision');
    expect(latestDec?.data.symbol).toBe('BTC');
  });

  it('notifies subscribers on event emission', () => {
    const subscriber = vi.fn();
    const unsubscribe = onEvent('trade.execution', subscriber);

    emitEvent('trade.execution', {
      symbol: 'BTC',
      outcome: 'up',
      size: 10,
      price: 0.52,
      mode: 'paper',
    });

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'trade.execution',
        data: expect.objectContaining({ symbol: 'BTC', size: 10 }),
      }),
    );

    unsubscribe();
    emitEvent('trade.execution', { symbol: 'ETH' });
    expect(subscriber).toHaveBeenCalledTimes(1); // No second call
  });

  it('formats events into human-readable log strings without data loss', () => {
    const scanLog = formatEventAsLog({
      id: '1',
      type: 'scan.cycle',
      v: 1,
      ts: Date.now(),
      data: { scanNumber: 42, marketCount: 6, buyCount: 2, remainingFormatted: '3m 15s' },
    });
    expect(scanLog.text).toBe('🔎 Scan #42 — 6 mkts · 2 buy signals · cycle 3m 15s');
    expect(scanLog.level).toBe('scan');

    const exitLog = formatEventAsLog({
      id: '2',
      type: 'position.exit',
      v: 1,
      ts: Date.now(),
      data: { symbol: 'BTC', outcome: 'up', exitReason: 'tp', netPnl: 3.25, slug: 'btc-5m-1' },
    });
    expect(exitLog.text).toBe('🏁 EXIT [TP] BTC UP · PnL +$3.25 · btc-5m-1');
    expect(exitLog.level).toBe('tp');
  });
});

/**
 * The cursor read exists so a consumer that disconnects can resume without a
 * hole. These are invariants of that guarantee, not a snapshot of behaviour:
 * each one fails if the feed can lose an event without saying so.
 */
describe('telemetry cursor reads (item 48 step B)', () => {
  beforeEach(() => {
    clearEvents();
    setEventBufferCapacity(DEFAULT_EVENT_BUFFER_CAP);
  });

  const emitN = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) =>
      emitEvent('system.alert', { message: `m${from + i}`, level: 'info' }),
    );

  it('INVARIANT: a cursor read returns every event after the cursor, in order', () => {
    const all = emitN(5);
    const page = queryEventsPage({ after: all[1].id });

    expect(page.events.map((e) => e.id)).toEqual([all[2].id, all[3].id, all[4].id]);
    expect(page.dropped).toBe(false);
  });

  it('INVARIANT: a limited page takes from the front, never the tail', () => {
    // A tail slice would return the NEWEST two and silently skip the middle —
    // the exact failure a catch-up read exists to prevent.
    const all = emitN(6);
    const page = queryEventsPage({ after: all[0].id, limit: 2 });

    expect(page.events.map((e) => e.id)).toEqual([all[1].id, all[2].id]);
    expect(page.hasMore).toBe(true);
  });

  it('INVARIANT: paging with the returned cursor visits every event exactly once', () => {
    const all = emitN(10);
    const seen: string[] = [];
    let cursor = all[0].id;

    for (let guard = 0; guard < 20; guard += 1) {
      const page = queryEventsPage({ after: cursor, limit: 3 });
      expect(page.dropped).toBe(false);
      if (!page.events.length) break;
      seen.push(...page.events.map((e) => e.id));
      cursor = page.events[page.events.length - 1].id;
      if (!page.hasMore) break;
    }

    expect(seen).toEqual(all.slice(1).map((e) => e.id));
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
  });

  it('INVARIANT: an evicted cursor reports dropped rather than looking current', () => {
    setEventBufferCapacity(100); // floor enforced by setCapacity
    const first = emitN(1)[0];
    emitN(150); // pushes `first` off the back

    const page = queryEventsPage({ after: first.id });

    expect(page.dropped).toBe(true);
    expect(page.evicted).toBeGreaterThan(0);
    expect(page.oldestId).not.toBe(first.id);
    // and it hands back what remains so the consumer can resync
    expect(page.events.length).toBeGreaterThan(0);
  });

  it('distinguishes "up to date" from "you lost data"', () => {
    const all = emitN(3);

    const current = queryEventsPage({ after: all[2].id });
    expect(current.events).toEqual([]);
    expect(current.dropped).toBe(false); // caught up

    const bogus = queryEventsPage({ after: 'evt-0-0' });
    expect(bogus.dropped).toBe(true); // cannot prove continuity
  });

  it('counts evictions and resets the count on clear', () => {
    setEventBufferCapacity(100);
    emitN(130);
    expect(evictedCount()).toBe(30);

    clearEvents();
    expect(evictedCount()).toBe(0);
  });

  it('leaves the legacy tail-slice read untouched', () => {
    const all = emitN(5);
    // No cursor: still "the most recent N", as every existing caller expects.
    expect(queryEvents({ limit: 2 }).map((e) => e.id)).toEqual([all[3].id, all[4].id]);
  });
});

/**
 * Emission is synchronous and runs on the emitting caller's stack — for the
 * receipt tee that is live order execution. So a subscriber must not be able to
 * reach the trading loop, and must not be able to starve other subscribers.
 */
describe('INVARIANT: one subscriber cannot break the bus for anyone else', () => {
  beforeEach(() => clearEvents());

  it('delivers to the wildcard even when a typed subscriber throws', () => {
    // The real case: the SSE stream subscribes to '*'. Before the fan-out
    // isolated subscribers, a throw here meant emit('*') never ran at all.
    const wildcard: string[] = [];
    const offBad = onEvent('system.alert', () => { throw new Error('boom'); });
    const offGood = onEvent('*', (e) => wildcard.push(e.id));

    try {
      const event = emitEvent('system.alert', { message: 'x', level: 'info' });
      expect(wildcard).toEqual([event.id]);
    } finally {
      offBad();
      offGood();
    }
  });

  it('delivers to later subscribers on the same channel', () => {
    const seen: string[] = [];
    const offBad = onEvent('system.alert', () => { throw new Error('boom'); });
    const offGood = onEvent('system.alert', (e) => seen.push(e.id));

    try {
      const event = emitEvent('system.alert', { message: 'x', level: 'info' });
      expect(seen).toEqual([event.id]);
    } finally {
      offBad();
      offGood();
    }
  });

  it('never lets a subscriber throw reach the emitter', () => {
    const off = onEvent('*', () => { throw new Error('boom'); });
    try {
      expect(() => emitEvent('system.alert', { message: 'x', level: 'info' })).not.toThrow();
    } finally {
      off();
    }
  });

  it('counts subscriber faults rather than swallowing them silently', () => {
    const before = subscriberErrors().count;
    const off = onEvent('system.alert', () => { throw new Error('a distinctive failure'); });

    try {
      emitEvent('system.alert', { message: 'x', level: 'info' });
      const after = subscriberErrors();
      expect(after.count).toBe(before + 1);
      expect(after.last).toContain('a distinctive failure');
    } finally {
      off();
    }
  });

  it('preserves once() semantics through the fan-out', () => {
    // The fan-out invokes rawListeners directly; Node's once wrapper
    // self-removes when called, and this proves it still does.
    let calls = 0;
    telemetryBus.once('system.alert', () => { calls += 1; });

    emitEvent('system.alert', { message: 'one', level: 'info' });
    emitEvent('system.alert', { message: 'two', level: 'info' });

    expect(calls).toBe(1);
  });
});

/**
 * INVARIANT: a consumer is never told it is current when it has a hole.
 *
 * Item 65. `/api/poly/events/stream` replays a front slice capped at 1,000
 * events, then goes live from connect time. When the replay is truncated, the
 * events between replay-end and connect-time are never framed — and
 * `EventPage.dropped` stays false, because the cursor WAS found. Measured on the
 * live VPS instance the buffer turns over in ~47 minutes, making the reconnect
 * horizon ~94 seconds, so this is the steady state rather than an edge case.
 *
 * These assert the reporting contract, not the cap: raising the replay limit
 * moves the cliff without changing what a truncated replay must say.
 */
describe('INVARIANT: a truncated stream replay reports a gap (item 65)', () => {
  beforeEach(() => {
    clearEvents();
    setEventBufferCapacity(DEFAULT_EVENT_BUFFER_CAP);
  });

  const emitN = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      emitEvent('system.alert', { message: `m${i}`, level: 'info' }),
    );

  it('reports dropped when the replay could not reach the head', () => {
    const all = emitN(6);
    const page = queryEventsPage({ after: all[0].id, limit: 2 });

    // The page itself is honest: the cursor resolved, so nothing was evicted.
    expect(page.dropped).toBe(false);
    expect(page.hasMore).toBe(true);

    // On a stream that is still a hole, because the live feed resumes from
    // connect time rather than from where the replay stopped.
    expect(buildSyncFrame(page, page.events.length).dropped).toBe(true);
  });

  it('stays quiet when the replay did reach the head', () => {
    // The other half: over-reporting on every connect would train the consumer
    // to ignore the flag, which costs exactly as much as never setting it.
    const all = emitN(4);
    const page = queryEventsPage({ after: all[0].id });

    expect(page.hasMore).toBe(false);
    expect(buildSyncFrame(page, page.events.length).dropped).toBe(false);
  });

  it('still reports an evicted cursor even when the replay reached the head', () => {
    setEventBufferCapacity(100);
    const first = emitN(1)[0];
    emitN(150); // pushes `first` off the back

    const page = queryEventsPage({ after: first.id, limit: 1000 });

    expect(page.hasMore).toBe(false); // the head IS reached
    expect(page.dropped).toBe(true);  // but the cursor is gone
    // `hasMore` must widen the signal, never narrow it.
    expect(buildSyncFrame(page, page.events.length).dropped).toBe(true);
  });

  it('passes the replayed count through as the frame reports it', () => {
    const all = emitN(6);
    const page = queryEventsPage({ after: all[0].id, limit: 2 });
    const frame = buildSyncFrame(page, page.events.length);

    // A consumer filling the hole pages from the last id it actually received,
    // so a replayed count that disagrees with the frames sent is unrecoverable.
    expect(frame.replayed).toBe(2);
    expect(frame.newestId).toBe(all[5].id);
    expect(frame.hasMore).toBe(true);
  });
});
