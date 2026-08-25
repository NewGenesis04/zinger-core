import { describe, expect, it, vi } from 'vitest';
import {
  formatRemainingMs,
  prunePendingTrades,
  updateBotTradeStats,
  bookWindowExit,
  evaluateCycleBoundary,
} from '../../src/polymarket/scan/cycle.js';

describe('scan/cycle.ts', () => {
  it('formats remaining window time string correctly', () => {
    const formatted = formatRemainingMs(1_700_000_000_000);
    expect(formatted).toMatch(/^\d+m \d{2}s$/);
  });

  it('prunes expired and terminal pending trades', () => {
    const now = Date.now();
    const botState = {
      pendingTrades: [
        { id: '1', status: 'pending', createdAt: now - 10_000 },
        { id: '2', status: 'executed', createdAt: now - 5_000 },
        { id: '3', status: 'rejected', createdAt: now - 5_000 },
        { id: '4', status: 'pending', createdAt: now - 60_000 }, // expired
      ],
    };

    const { pruned } = prunePendingTrades(botState, 45_000);
    expect(pruned).toBe(3);
    expect(botState.pendingTrades).toHaveLength(1);
    expect(botState.pendingTrades[0].id).toBe('1');
  });

  it('updates bot trade stats from trade history', () => {
    const botState = {
      trades: [
        { pnl: 5.5 },
        { pnl: -2.0 },
        { pnl: 10.0 },
        { pnl: 0 },
      ],
      stats: {},
    };

    updateBotTradeStats(botState);
    expect(botState.stats.totalTrades).toBe(4);
    expect(botState.stats.totalPnl).toBe(13.5);
    expect(botState.stats.wins).toBe(2);
    expect(botState.stats.losses).toBe(2);
  });

  it('accumulates window exit stats properly', () => {
    const accum = { pnl: 0, closes: 0, rewards: 0, tp: 0, sl: 0, trail: 0, settle: 0, partial: 0 };
    bookWindowExit(accum, 'tp', 3.5);
    expect(accum.pnl).toBe(3.5);
    expect(accum.closes).toBe(1);
    expect(accum.rewards).toBe(3.5);
    expect(accum.tp).toBe(1);

    bookWindowExit(accum, 'sl', -1.2);
    expect(accum.pnl).toBe(2.3);
    expect(accum.closes).toBe(2);
    expect(accum.rewards).toBe(3.5);
    expect(accum.sl).toBe(1);
  });

  it('initializes and updates cycle boundary cleanly', () => {
    const botState = {
      _cycleKey: null,
      _cycleSettleAccum: { pnl: 0, closes: 0, rewards: 0, tp: 0, sl: 0, trail: 0, settle: 0, partial: 0 },
      windows: { current: null, history: [] },
      settle: { lastCycle: null, history: [] },
      trades: [],
      positions: [],
      config: { mode: 'paper' },
    };

    // First call initializes current window without rolling
    const res1 = evaluateCycleBoundary({
      botState,
      buildPortfolio: () => ({ equity: 100, cash: 100 }),
      nowMs: 1_700_000_000_000,
    });
    expect(res1).toBeNull();
    expect(botState._cycleKey).toBeDefined();
    expect(botState.windows.current).toBeDefined();

    // Call within same cycle updates stats without rolling
    const res2 = evaluateCycleBoundary({
      botState,
      buildPortfolio: () => ({ equity: 100, cash: 100 }),
      nowMs: 1_700_000_000_000 + 50_000,
    });
    expect(res2).toBeNull();

    // Call in next window triggers rollover
    const logSpy = vi.fn();
    const res3 = evaluateCycleBoundary({
      botState,
      buildPortfolio: () => ({ equity: 105, cash: 105, netPnl: 5 }),
      log: logSpy,
      nowMs: 1_700_000_000_000 + 350_000, // 350s later -> next 300s bucket
    });

    expect(res3).not.toBeNull();
    expect(botState.windows.history).toHaveLength(1);
    expect(botState.settle.history).toHaveLength(1);
    expect(logSpy).toHaveBeenCalled();
  });
});
