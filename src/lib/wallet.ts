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
    source: 'generated',
  };

  // This one MUST persist — the key exists nowhere else, so not writing it
  // loses any funds sent to the address. The env path is what does not.
  saveFileOrStore(WALLET_FILE, wallet);
  console.log(`\n🔐 Generated new wallet`);
  console.log(`   Instance: ${wallet.instance}`);
  console.log(`   Address: ${wallet.address}`);
  console.log(`   Key saved to: ${WALLET_FILE}\n`);

  return wallet;
}

/**
 * Resolve the active wallet. **Read-only when the key comes from `.env`.**
 *
 * This used to call `importWalletKey` unconditionally, which persists — so a
 * function named "load" copied the `.env` private key into the sqlite `docs`
 * table on every call. `checkReadiness` calls `getWallet()`, and
 * `refreshTelemetry` calls that on a timer, so the live key was being rewritten
 * into shared state continuously (backlog 53).
 *
 * `.env` is already the durable home for a key that came from `.env`. Copying
 * it into the state store adds no recoverability and makes `data/zinger.db` a
 * secret-bearing file — every backup, every debug pull, every future store
 * reader inherits it.
 *
 * The generated-key path is different and still persists: see
 * `loadOrCreateWallet`, where not writing would lose the key outright.
 */
export function tryLoadWallet() {
  const envKey = process.env.POLYMARKET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (envKey && typeof envKey === 'string' && envKey.trim().length > 20) {
    const deposit = process.env.POLYMARKET_DEPOSIT_WALLET || process.env.DEPOSIT_WALLET || null;
    return importWalletKey(envKey.trim(), {
      polymarketDepositWallet: deposit ? deposit.trim() : null,
      instance: process.env.ZINGER_INSTANCE || 'live',
      persist: false,
      source: 'env',
    });
  }
  const stored = loadFileOrStore(WALLET_FILE, null);
  return stored ? { ...stored, source: stored.source || 'store' } : null;
}

export function getWallet() {
  const wallet = tryLoadWallet();
  if (!wallet) return loadOrCreateWallet();
  return wallet;
}

/**
 * Explicit key import path for live trading (Item 18).
 * Derives account address from private key and records optional deposit proxy.
 *
 * `persist` defaults true because the operator-facing import is the case that
 * needs remembering — a key pasted once must survive a restart. Callers whose
 * key already has a durable home pass `persist: false`; see `tryLoadWallet`.
 */
export function importWalletKey(privateKey: string, {
  polymarketDepositWallet = null,
  instance = 'live',
  persist = true,
  source = 'import',
} = {}) {
  const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(cleanKey);

  const wallet = {
    address: account.address,
    privateKey: cleanKey,
    polymarketDepositWallet: polymarketDepositWallet || null,
    createdAt: new Date().toISOString(),
    importedAt: new Date().toISOString(),
    instance: instance || process.env.ZINGER_INSTANCE || 'live',
    source,
  };

  if (persist) saveFileOrStore(WALLET_FILE, wallet);
  return wallet;
}

/**
 * Configure Polymarket proxy deposit wallet (Item 18).
 */
export function setDepositWallet(depositWalletAddress: string) {
  const current = getWallet();
  const updated = {
    ...current,
    polymarketDepositWallet: depositWalletAddress,
    updatedAt: new Date().toISOString(),
  };
  // Writing `updated` wholesale would re-persist the private key, undoing the
  // point of `tryLoadWallet`'s `persist: false` — this spreads `current`, and
  // for an env-sourced wallet `current.privateKey` is the live `.env` key.
  // Strip it: the deposit address is the only thing this call needs to remember,
  // and an env key is re-read from `.env` on the next load anyway.
  const { privateKey, ...safe } = updated;
  saveFileOrStore(WALLET_FILE, current.source === 'env' ? safe : updated);
  return updated;
}

