import { describe, expect, it, vi } from 'vitest';
import { settlePaperOrphans } from '../../src/polymarket/scan/exits.js';

describe('scan/exits.ts', () => {
  it('settles expired paper orphans and leaves active/live positions untouched', async () => {
    const executeSell = vi.fn().mockResolvedValue({ ok: true });
    const logSpy = vi.fn();

    const positions = [
      // Expired 5m paper position
      {
        id: '1',
        mode: 'paper',
        closed: false,
        symbol: 'BTC',
        slug: 'btc-updown-5m-1700000000', // Ended at 1700000300 (past)
        outcome: 'up',
        pnl: 2.5,
      },
      // Already closed paper position
      {
        id: '2',
        mode: 'paper',
        closed: true,
        symbol: 'BTC',
        slug: 'btc-updown-5m-1700000000',
      },
      // Live position (should never be settled by paper orphan loop)
      {
        id: '3',
        mode: 'live',
        closed: false,
        symbol: 'BTC',
        slug: 'btc-updown-5m-1700000000',
      },
      // Future paper position (not expired)
      {
        id: '4',
        mode: 'paper',
        closed: false,
        symbol: 'BTC',
        slug: `btc-updown-5m-${Math.floor(Date.now() / 1000) + 1000}`,
      },
    ];

    const { settled } = await settlePaperOrphans(positions, { executeSell, log: logSpy });
    expect(settled).toBe(1);
    expect(executeSell).toHaveBeenCalledTimes(1);
    expect(executeSell).toHaveBeenCalledWith(positions[0], 'settle');
    expect(logSpy).toHaveBeenCalled();
  });
});
