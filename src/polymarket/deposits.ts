// @ts-nocheck
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { getWallet } from '../lib/wallet.js';
import { POLY } from './config.js';
import { swapUsdcToPusd, depositPusdToDepositWallet, checkPusdBalance } from './swap.js';
import { syncClobBalance } from './trade.js';

const RPC = POLY.polygonRpc;
const SCAN_INTERVAL = Number(process.env.DEPOSIT_SCAN_INTERVAL_MS || 30_000);

const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

let _lastScannedBlock = 0;
let _scanTimer = null;
let _depositListeners = [];

export function onDeposit(listener) {
  _depositListeners.push(listener);
  return () => { _depositListeners = _depositListeners.filter(l => l !== listener); };
}

export function getLastScannedBlock() {
  return _lastScannedBlock;
}

async function getUsdcTransferLogs(fromBlock, toBlock) {
  const client = createPublicClient({ chain: polygon, transport: http(RPC, { timeout: 10000 }) });
  const wallet = getWallet();

  const logs = await client.getLogs({
    address: POLY.usdc,
    event: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']),
    args: { to: wallet.address },
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
  });

  return logs.map(l => ({
    from: l.args.from,
    value: l.args.value,
    txHash: l.transactionHash,
    blockNumber: Number(l.blockNumber),
  }));
}

export async function scanForDeposits() {
  const client = createPublicClient({ chain: polygon, transport: http(RPC, { timeout: 10000 }) });

  // Item 122. Inside the try, not above it. A public RPC answering with a
  // Cloudflare error page rejects here, and this function is dispatched
  // fire-and-forget on a timer, so the rejection had nowhere to go but the
  // process-level handler — one `Unhandled:` line per tick for as long as the
  // endpoint was down. Returning [] is the same answer a failed log fetch
  // already gives: no deposits seen this pass, try again next tick.
  let currentBlock;
  try {
    currentBlock = Number(await client.getBlockNumber());
  } catch {
    return [];
  }

  if (_lastScannedBlock === 0) {
    _lastScannedBlock = currentBlock - 100;
    return [];
  }

  if (currentBlock <= _lastScannedBlock) return [];

  const fromBlock = _lastScannedBlock + 1;
  const toBlock = currentBlock;

  try {
    const deposits = await getUsdcTransferLogs(fromBlock, toBlock);
    _lastScannedBlock = currentBlock;

    for (const dep of deposits) {
      const usdcAmount = Number(dep.value) / 1_000_000;
      const result = await processDeposit(dep.from, usdcAmount, dep.txHash);
      for (const listener of _depositListeners) {
        try { listener(dep, result); } catch {}
      }
    }

    return deposits.map(d => ({ ...d, usdcAmount: Number(d.value) / 1_000_000 }));
  } catch (err) {
    return [];
  }
}

export async function processDeposit(userAddress, usdcAmount, txHash) {
  const wallet = getWallet();
  const depositWallet = wallet.polymarketDepositWallet;

  if (!depositWallet) {
    return { ok: false, error: 'no deposit wallet configured', txHash };
  }

  try {
    const swapResult = await swapUsdcToPusd(usdcAmount);
    if (!swapResult.ok) {
      return { ok: false, error: `swap failed: ${swapResult.error}`, txHash };
    }

    const depositResult = await depositPusdToDepositWallet(depositWallet);
    if (!depositResult.ok) {
      return { ok: false, error: `deposit failed: ${depositResult.error}`, txHash, swapTx: swapResult.tx };
    }

    await syncClobBalance();

    return {
      ok: true,
      txHash,
      swapTx: swapResult.tx,
      depositTx: depositResult.tx,
      usdcAmount,
      pUsdAmount: Number(swapResult.buyAmount) / 1_000_000,
      depositWallet,
    };
  } catch (err) {
    return { ok: false, error: err.message?.slice(0, 300) || 'unknown error', txHash };
  }
}

export function startDepositScanner() {
  if (_scanTimer) return;
  // `setInterval` discards the promise its callback returns, so a rejection
  // that escapes `scanForDeposits` is unobservable here. Both dispatch sites
  // swallow it explicitly rather than relying on the process-level handler
  // in `index.ts` to keep the run alive (item 122).
  const tick = () => { scanForDeposits().catch(() => {}); };
  tick();
  _scanTimer = setInterval(tick, SCAN_INTERVAL);
  return () => { clearInterval(_scanTimer); _scanTimer = null; };
}

export function stopDepositScanner() {
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
}
