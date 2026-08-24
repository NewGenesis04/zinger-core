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
