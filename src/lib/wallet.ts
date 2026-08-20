// @ts-nocheck
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadFileOrStore, saveFileOrStore } from '../polymarket/sqliteStore.js';
import { dataPath } from '../polymarket/dataDir.js';

const WALLET_FILE = dataPath('wallet.json');

export function loadOrCreateWallet() {
  const existing = tryLoadWallet();
  if (existing) return existing;

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const wallet = {
    address: account.address,
    privateKey,
    createdAt: new Date().toISOString(),
    instance: process.env.ZINGER_INSTANCE || 'experiment',
  };

  saveFileOrStore(WALLET_FILE, wallet);
  console.log(`\n🔐 Generated new wallet`);
  console.log(`   Instance: ${wallet.instance}`);
  console.log(`   Address: ${wallet.address}`);
  console.log(`   Key saved to: ${WALLET_FILE}\n`);

  return wallet;
}

export function tryLoadWallet() {
  return loadFileOrStore(WALLET_FILE, null);
}

export function getWallet() {
  const wallet = tryLoadWallet();
  if (!wallet) return loadOrCreateWallet();
  return wallet;
}
