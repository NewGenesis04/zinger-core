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
    expect(refreshTelemetry).toHaveBeenCalled();
    expect(findMarkets).toHaveBeenCalled();
    expect(processMarketExitsAndEntries).toHaveBeenCalled();
    expect(saveStateSpy).toHaveBeenCalled();
    expect(logScanSpy).toHaveBeenCalled();
  });
});
