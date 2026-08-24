import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { importWalletKey, setDepositWallet, tryLoadWallet } from '../../src/lib/wallet.js';

describe('Chunk 4: Live Wallet Configuration & Key Import (Item 18)', () => {
  it('imports a live signer private key and calculates the correct address', () => {
    const testKey = generatePrivateKey();
    const expectedAccount = privateKeyToAccount(testKey);

    const wallet = importWalletKey(testKey, {
      polymarketDepositWallet: '0x1111111111111111111111111111111111111111',
      instance: 'live-test',
    });

    expect(wallet.address).toBe(expectedAccount.address);
    expect(wallet.privateKey).toBe(testKey);
    expect(wallet.polymarketDepositWallet).toBe('0x1111111111111111111111111111111111111111');
    expect(wallet.instance).toBe('live-test');
  });

  it('updates the Polymarket proxy deposit wallet cleanly', () => {
    const updated = setDepositWallet('0x2222222222222222222222222222222222222222');
    expect(updated.polymarketDepositWallet).toBe('0x2222222222222222222222222222222222222222');
    expect(updated.updatedAt).toBeDefined();
  });
});
