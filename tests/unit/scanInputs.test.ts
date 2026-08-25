import { describe, expect, it, vi } from 'vitest';
import {
  collectSignals,
  enrichMarketsWithOracle,
} from '../../src/polymarket/scan/inputs.js';

describe('scan/inputs.ts', () => {
  it('collectSignals catches network errors gracefully and reuses existing signals', async () => {
    const logSpy = vi.fn();
    const botState = {
      signals: {
        btc: { direction: 'up', confidence: 0.55, timestamp: 1_700_000_000_000 },
      },
      _signalFailLoggedAt: 0,
    };

    const failingGetSignals = vi.fn().mockRejectedValue(new Error('504 Gateway Timeout'));

    const result = await collectSignals({
      cfg: { useSignals: true },
      botState,
      getSignalForBoth: failingGetSignals,
      log: logSpy,
    });

    expect(result).toBe(botState.signals);
    expect(result.btc.direction).toBe('up');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Signal feed unavailable'), 'error');
  });

  it('collectSignals merges ML predictions when enabled', async () => {
    const botState = {
      signals: {
        btc: { direction: 'neutral', confidence: 0.3, score: 0 },
      },
    };

    const mockML = vi.fn().mockResolvedValue({
      btc: { direction: 'up', confidence: 0.65 },
      eth: null,
    });

    const addMLPrediction = vi.fn();

    await collectSignals({
      cfg: { useSignals: true, useML: true, mode: 'paper' },
      botState,
      getSignalForBoth: vi.fn().mockResolvedValue({
        btc: { direction: 'neutral', confidence: 0.3, score: 0 },
      }),
      getMLSignalForBoth: mockML,
      addMLPrediction,
    });

    expect(addMLPrediction).toHaveBeenCalled();
    expect(botState.signals.btc.direction).toBe('up');
    expect(botState.signals.btc.mlOverride).toBe(true);
  });

  it('enrichMarketsWithOracle calculates window start/end and attaches Price-to-Beat', async () => {
    const markets = [
      {
        symbol: 'BTC',
        slug: 'btc-updown-5m-1700000000',
        endTime: 1700000300,
        windowSeconds: 300,
      },
    ];

    const fetchPriceToBeat = vi.fn().mockResolvedValue({
      openPrice: 65000,
      closePrice: 65100,
    });

    const enriched = await enrichMarketsWithOracle(markets, { fetchPriceToBeat });

    expect(enriched[0].eventStartTime).toBeDefined();
    expect(enriched[0].endDate).toBeDefined();
    expect(enriched[0].priceToBeat).toBe(65000);
    expect(enriched[0].priceToBeatMeta).toBeDefined();
  });
});
