// @ts-nocheck
/**
 * INVARIANT: a private key that came from `.env` is never written to the store.
 *
 * `tryLoadWallet` used to call `importWalletKey` unconditionally, and that
 * function persists. So a read copied the live key into the sqlite `docs`
 * table — and because `checkReadiness` calls `getWallet()` on the readiness
 * timer, it did so continuously (backlog 53). Nothing about the call sites
 * looked wrong; `readiness.ts` just asks for the wallet.
 *
 * These assert the property rather than the current shape of the code, so they
 * still hold if the wallet module is restructured.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const saveSpy = vi.fn();
const loadSpy = vi.fn(() => null);

vi.mock('../../src/polymarket/sqliteStore.js', () => ({
  saveFileOrStore: (...args: unknown[]) => saveSpy(...args),
  loadFileOrStore: (...args: unknown[]) => loadSpy(...args),
}));

const { tryLoadWallet, getWallet, importWalletKey, setDepositWallet } =
  await import('../../src/lib/wallet.js');

// Throwaway key — a well-known Hardhat test account, never funded on mainnet.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('INVARIANT: an env-sourced private key never reaches the store', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    saveSpy.mockClear();
    loadSpy.mockClear();
    loadSpy.mockReturnValue(null);
    delete process.env.POLYMARKET_PRIVATE_KEY;
    delete process.env.PRIVATE_KEY;
    delete process.env.POLYMARKET_DEPOSIT_WALLET;
    delete process.env.DEPOSIT_WALLET;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('does not persist anything when the key comes from .env', () => {
    process.env.POLYMARKET_PRIVATE_KEY = TEST_KEY;

    const wallet = tryLoadWallet();

    expect(wallet.privateKey).toBe(TEST_KEY);   // still usable in-process
    expect(wallet.source).toBe('env');
    expect(saveSpy).not.toHaveBeenCalled();     // and never written down
  });

  it('stays read-only across repeated loads, which is how the timer hits it', () => {
    process.env.POLYMARKET_PRIVATE_KEY = TEST_KEY;

    // checkReadiness -> getWallet() runs on the refreshTelemetry timer.
    for (let i = 0; i < 25; i += 1) getWallet();

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('never hands a private key to the store in ANY call it makes', () => {
    // Property form: whatever this module chooses to persist, no argument to
    // the store may carry a key. Survives refactors that change what is saved.
    process.env.POLYMARKET_PRIVATE_KEY = TEST_KEY;
    process.env.POLYMARKET_DEPOSIT_WALLET = '0x000000000000000000000000000000000000dEaD';

    getWallet();
    setDepositWallet('0x000000000000000000000000000000000000bEEF');

    for (const call of saveSpy.mock.calls) {
      const payload = call[1];
      expect(JSON.stringify(payload ?? {})).not.toContain(TEST_KEY);
      expect(payload?.privateKey).toBeUndefined();
    }
  });

  it('STILL persists a generated key — losing it would strand funds', () => {
    // The env path is what must not write. A generated key exists nowhere else,
    // so the opposite mistake is just as bad.
    loadSpy.mockReturnValue(null);
    const wallet = getWallet();

    expect(wallet.source).toBe('generated');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][1].privateKey).toBe(wallet.privateKey);
  });

  it('STILL persists an explicit operator import', () => {
    // Item 18's path: a key pasted once must survive a restart.
    const wallet = importWalletKey(TEST_KEY, { instance: 'live' });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][1].privateKey).toBe(wallet.privateKey);
  });
});
