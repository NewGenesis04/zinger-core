import { describe, expect, it, vi } from 'vitest';
import { executeScanCycle } from '../../src/polymarket/scan/index.js';

describe('scan/index.ts Orchestrator', () => {
  it('skips scan when bot is disabled', async () => {
    const refreshTelemetry = vi.fn();
    const botState = { config: { enabled: false } };

    await executeScanCycle({ botState, refreshTelemetry });
    expect(refreshTelemetry).not.toHaveBeenCalled();
  });

  it('executes scan phases sequentially when enabled', async () => {
    const botState = {
      config: { enabled: true, mode: 'paper', useSignals: false },
      _scanning: false,
      _cycleKey: null,
      _cycleSettleAccum: { pnl: 0, closes: 0, rewards: 0, tp: 0, sl: 0, trail: 0, settle: 0, partial: 0 },
      windows: { current: null, history: [] },
      settle: { lastCycle: null, history: [] },
      trades: [],
      positions: [],
      signals: {},
    };

    botState.readiness = { clobBalance: 100, spendableBalance: 100 };

    const logSpy = vi.fn();
    const logScanSpy = vi.fn();
    const saveStateSpy = vi.fn();
    const refreshTelemetry = vi.fn().mockResolvedValue({ clobBalance: 100 });
    const findMarkets = vi.fn().mockResolvedValue({
      markets: [
        { symbol: 'BTC', slug: 'btc-updown-5m-1700000000', isCurrent: true, endTime: 1700000300 },
      ],
      diagnostics: [],
    });
    const processMarketExitsAndEntries = vi.fn().mockResolvedValue([
      { symbol: 'BTC', slug: 'btc-updown-5m-1700000000', action: 'hold', remaining: 150 },
    ]);

    await executeScanCycle({
      botState,
      log: logSpy,
      logScan: logScanSpy,
      saveState: saveStateSpy,
      refreshTelemetry,
      findMarkets,
      resolveMarketDurations: () => ['5m'],
      processMarketExitsAndEntries,
    });

    expect(botState._scanning).toBe(false);
    expect(botState.stats.scansDone).toBe(1);
    expect(findMarkets).toHaveBeenCalled();
    expect(processMarketExitsAndEntries).toHaveBeenCalled();
    expect(saveStateSpy).toHaveBeenCalled();
    expect(logScanSpy).toHaveBeenCalled();

    /*
     * INVARIANT (backlog item 60): the scan loop is a READER of readiness.
     *
     * This assertion used to be `expect(refreshTelemetry).toHaveBeenCalled()`,
     * which froze the defect in place: refreshing readiness here ran eight
     * network calls — two of them through the metered CLOB proxy — on every tick
     * of a 250ms timer, making the trading hot loop the largest consumer of a
     * 1GB/month quota. Ownership sits with the background `syncBalances` timer.
     */
    expect(refreshTelemetry).not.toHaveBeenCalled();
  });

  it('passes the cached readiness through to the entry path, not a fresh fetch', async () => {
    const botState = {
      config: { enabled: true, mode: 'paper', useSignals: false },
      _scanning: false,
      _cycleKey: null,
      _cycleSettleAccum: { pnl: 0, closes: 0, rewards: 0, tp: 0, sl: 0, trail: 0, settle: 0, partial: 0 },
      windows: { current: null, history: [] },
      settle: { lastCycle: null, history: [] },
      trades: [],
      positions: [],
      signals: {},
      readiness: { spendableBalance: 42, clobBalance: 42 },
    };

    const processMarketExitsAndEntries = vi.fn().mockResolvedValue([]);
    // Resolves to a DIFFERENT balance, so a stray refresh would be visible.
    const refreshTelemetry = vi.fn().mockResolvedValue({ spendableBalance: 999 });

    await executeScanCycle({
      botState,
      log: vi.fn(),
      logScan: vi.fn(),
      saveState: vi.fn(),
      refreshTelemetry,
      findMarkets: vi.fn().mockResolvedValue({
        markets: [{ symbol: 'BTC', slug: 'btc-updown-5m-1700000000', isCurrent: true, endTime: 1700000300 }],
        diagnostics: [],
      }),
      resolveMarketDurations: () => ['5m'],
      processMarketExitsAndEntries,
    });

    expect(refreshTelemetry).not.toHaveBeenCalled();
    expect(processMarketExitsAndEntries).toHaveBeenCalledWith(
      expect.objectContaining({ readiness: botState.readiness }),
    );
  });

  it('hands down a null readiness rather than inventing one on cold start', async () => {
    // Nothing has populated botState.readiness yet. The entry path must see the
    // absence and decline (arbEngine refuses an unfunded package; resolveOrderSize
    // returns no_bankroll) rather than receive a fabricated balance.
    const botState = {
      config: { enabled: true, mode: 'live', useSignals: false },
      _scanning: false,
      _cycleKey: null,
      _cycleSettleAccum: { pnl: 0, closes: 0, rewards: 0, tp: 0, sl: 0, trail: 0, settle: 0, partial: 0 },
      windows: { current: null, history: [] },
      settle: { lastCycle: null, history: [] },
      trades: [],
      positions: [],
      signals: {},
    };

    const processMarketExitsAndEntries = vi.fn().mockResolvedValue([]);

    await executeScanCycle({
      botState,
      log: vi.fn(),
      logScan: vi.fn(),
      saveState: vi.fn(),
      refreshTelemetry: vi.fn(),
      findMarkets: vi.fn().mockResolvedValue({
        markets: [{ symbol: 'BTC', slug: 'btc-updown-5m-1700000000', isCurrent: true, endTime: 1700000300 }],
        diagnostics: [],
      }),
      resolveMarketDurations: () => ['5m'],
      processMarketExitsAndEntries,
    });

    expect(processMarketExitsAndEntries).toHaveBeenCalledWith(
      expect.objectContaining({ readiness: null }),
    );
  });
});
