// @ts-nocheck
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadFileOrStore, saveFileOrStore } from '../polymarket/sqliteStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = process.env.ZINGER_DATA_DIR
  ? path.resolve(process.env.ZINGER_DATA_DIR)
  : path.join(ROOT, 'data');
const WALLET_FILE = path.join(DATA_DIR, 'wallet.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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
