import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CTF_ADDRESS,
  formatCtfMergeParams,
  executeCtfMerge,
} from '../../src/polymarket/ctf/merge.js';
import { detectAndExecuteArbPackage } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages } from '../../src/polymarket/arbPersistence.js';
import { queryEvents } from '../../src/polymarket/telemetry/events.js';

describe('Feature: Instant On-Chain CTF Merge (mergePositions)', () => {
  beforeEach(() => {
    saveAllPackages([]);
  });

  describe('formatCtfMergeParams()', () => {
    it('correctly formats partition [1, 2] and 6-decimal token amounts', () => {
      const conditionId = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const shares = 10.875;
      const params = formatCtfMergeParams({ conditionId, shares });

      expect(params.ctfAddress.toLowerCase()).toBe(CTF_ADDRESS.toLowerCase());
      expect(params.conditionId).toBe(conditionId);
      expect(params.partition).toEqual([1n, 2n]);
      expect(params.amount).toBe(10875000n); // 10.875 * 1e6
    });
  });

  describe('executeCtfMerge()', () => {
    it('invokes mergePositions on wallet client and waits for receipt', async () => {
      const mockWalletClient = {
        account: { address: '0x1111111111111111111111111111111111111111' },
        writeContract: vi.fn().mockResolvedValue('0xtxhash123'),
      };
      const mockPublicClient = {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', blockNumber: 123456n }),
      };

      const result = await executeCtfMerge({
        conditionId: '0xabcdef',
        shares: 5.0,
        walletClient: mockWalletClient,
        publicClient: mockPublicClient,
      });

      expect(result.ok).toBe(true);
      expect(result.txHash).toBe('0xtxhash123');
      expect(mockWalletClient.writeContract).toHaveBeenCalledTimes(1);
      expect(mockPublicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: '0xtxhash123' });
    });
  });

  describe('arbEngine instant merge integration & telemetry', () => {
    it('executes instant CTF merge and emits package.settlement event upon fill', async () => {
      const market = {
        symbol: 'BTC',
        slug: 'btc-updown-5m-1787000000',
        conditionId: '0xcondition123',
        outcomes: ['Up', 'Down'],
        tokenIds: { up: 'token-up', down: 'token-down' },
        acceptingOrders: true,
      };

      // Models a full live fill: executePendingTrade always returns a position
      // carrying the matched share count, because the arb path proves that count
      // against the order receipt before building one. Echoing the requested
      // size is what "both legs filled completely" looks like.
      const executeTrade = vi.fn().mockImplementation(
        async (pending) => ({ ok: true, position: { shares: pending.plan.shares } }),
      );
      const adjustPaperCash = vi.fn();
      const saveTrade = vi.fn();
      const mockWalletClient = {
        account: { address: '0x1111111111111111111111111111111111111111' },
        writeContract: vi.fn().mockResolvedValue('0xtxhash456'),
      };
      const botState = { positions: [], walletClient: mockWalletClient };

      const pkg = await detectAndExecuteArbPackage({
        market,
        depth: { up: { bestAsk: 0.35 }, down: { bestAsk: 0.55 } },
        prices: { up: 0.35, down: 0.55 },
        cfg: {
          clobArbEnabled: true,
          minArbGap: 0.01,
          simulateClobFees: true,
          instantCtfMerge: true,
          paperBankroll: 100,
          arbBankrollFrac: 0.1,
          arbMaxUsd: 10,
        },
        mode: 'live',
        log: () => {},
        executeTrade,
        adjustPaperCash,
        saveTrade,
        botState,
      });

      expect(pkg).not.toBeNull();
      expect(pkg?.status).toBe('MERGED');
      expect(pkg?.mergedAt).toBeDefined();
      expect(pkg?.mergeTxHash).toBe('0xtxhash456');

      // Check telemetry event bus
      const settlementEvents = queryEvents({ type: 'package.settlement', limit: 5 });
      expect(settlementEvents.length).toBeGreaterThan(0);
      const latest = settlementEvents[settlementEvents.length - 1];
      expect(latest.data.action).toBe('instant_ctf_merge');
      expect(latest.data.packageId).toBe(pkg.packageId);
    });
  });
});
