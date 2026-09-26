import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CTF_ADDRESS,
  formatCtfMergeParams,
  executeCtfMerge,
} from '../../src/polymarket/ctf/merge.js';
import { detectAndExecuteArbPackage } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages } from '../../src/polymarket/arbPersistence.js';
import { queryEvents } from '../../src/polymarket/telemetry/events.js';

/**
 * Item 99: a package only opens with at least `arbMinWindowSecondsLeft` (60s)
 * of window left, so the dispatch fixtures below carry a window that is still
 * open. Nothing here is about entry timing — that rule is pinned in
 * `invariants.windowTiming.test.ts`.
 */
const OPEN_WINDOW = (asset) => `${asset}-updown-5m-${Math.floor(Date.now() / 1000 / 300) * 300 + 300}`;

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

  describe('item 107: the engine performs no on-chain merge', () => {
    it('locks a live package without calling the merge, even when handed a wallet client', async () => {
      const market = {
        symbol: 'BTC',
        slug: OPEN_WINDOW('btc'),
        conditionId: '0xcondition123',
        outcomes: ['Up', 'Down'],
        tokenIds: { up: 'token-up', down: 'token-down' },
        acceptingOrders: true,
      };
      const executeTrade = vi.fn().mockImplementation(
        async (pending) => ({ ok: true, position: { shares: pending.plan.shares } }),
      );
      const mockWalletClient = {
        account: { address: '0x1111111111111111111111111111111111111111' },
        writeContract: vi.fn().mockResolvedValue('0xtxhash456'),
      };
      const pkg = await detectAndExecuteArbPackage({
        market,
        depth: { up: { bestAsk: 0.35, bestAskSize: 5000, bookTs: Date.now() }, down: { bestAsk: 0.55, bestAskSize: 5000, bookTs: Date.now() } },
        prices: { up: 0.35, down: 0.55 },
        cfg: { clobArbEnabled: true, minArbGap: 0.01, simulateClobFees: true, paperBankroll: 100, arbBankrollFrac: 0.1, arbMaxUsd: 10 },
        mode: 'live',
        readiness: { spendableBalance: 500, liveReady: true },
        log: () => {},
        executeTrade,
        adjustPaperCash: vi.fn(),
        saveTrade: vi.fn(),
        botState: { positions: [], walletClient: mockWalletClient, signer: mockWalletClient },
      });
      expect(pkg?.status).toBe('LOCKED');
      expect(mockWalletClient.writeContract).not.toHaveBeenCalled();
      const merges = queryEvents({ type: 'package.settlement', limit: 50 })
        .filter((e) => e.data?.packageId === pkg?.packageId && e.data?.action === 'instant_ctf_merge');
      expect(merges).toHaveLength(0);
    });
  });
});
