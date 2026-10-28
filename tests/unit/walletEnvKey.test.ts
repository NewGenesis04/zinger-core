import { afterEach, describe, expect, it, vi } from 'vitest';

describe('wallet key from the environment', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.doUnmock('../../src/polymarket/sqliteStore.js'); });
  it('is used in memory and the private key never reaches the wallet store', async () => {
    const saved: any[] = [];
    vi.doMock('../../src/polymarket/sqliteStore.js', () => ({ loadFileOrStore: () => null, saveFileOrStore: (_f: string, v: unknown) => saved.push(v) }));
    vi.stubEnv('POLYMARKET_PRIVATE_KEY', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    vi.stubEnv('POLYMARKET_DEPOSIT_WALLET', '0x000000000000000000000000000000000000dEaD');
    const w = await import('../../src/lib/wallet.js');
    expect(w.getWallet().polymarketDepositWallet).toBe('0x000000000000000000000000000000000000dEaD');
    expect(saved).toEqual([]);
    w.setDepositWallet('0x0000000000000000000000000000000000000001');
    expect(saved.every((v) => !('privateKey' in v))).toBe(true);
  });
});
