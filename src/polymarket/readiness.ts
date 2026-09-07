// @ts-nocheck
import { createPublicClient, http, formatUnits } from 'viem';
import { polygon } from 'viem/chains';
import { getWallet } from '../lib/wallet.js';
import { POLY, POLY_MIN_ORDER_USD } from './config.js';
import { ensureApiKey, getClobBalance, getWalletAddress, getFunderAddress } from './trade.js';
import { resolveDynamicLimits } from './kelly.js';
import { checkGeoblock, getClobProxyUrl, redactProxy } from './proxyEnv.js';

const ERC20_ABI = [{
  inputs: [{ name: 'owner', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}];

let _client;
function getClient() {
  if (!_client) {
    _client = createPublicClient({
      chain: polygon,
      transport: http('https://polygon-bor.publicnode.com', { timeout: 8000 }),
    });
  }
  return _client;
}

async function readDepositWalletOwner(depositWallet) {
  try {
    const data = await getClient().call({ to: depositWallet, data: '0x8da5cb5b' });
    if (!data?.data || data.data.length < 42) return null;
    return `0x${data.data.slice(-40)}`;
  } catch {
    return null;
  }
}

async function fetchDepositPositions(depositWallet) {
  try {
    // Backlog item 55 — every other outbound call in this file is bounded (the
    // viem transport at :23, the geoblock check at proxyEnv.ts:121). This one was
    // not, so a connection that opened and never answered could hold the whole
    // readiness chain for minutes. The catch below already returns [] on an HTTP
    // error, so an abort lands on the identical path.
    const res = await fetch(`https://data-api.polymarket.com/positions?user=${depositWallet}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Capture a promise's outcome instead of letting it reject.
 *
 * `checkReadiness` starts every leg before it awaits any of them, so a rejection
 * that lands before its `await` would surface as an unhandledRejection
 * (`index.ts:18`) — a real log line for an error that is already handled. This
 * keeps each call site's original try/catch semantics while the work overlaps.
 */
function capture(p) {
  return p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
}

/* ------------------------------------------------------------------ *
 * Tiered TTL cache — backlog item 60/61
 *
 * `checkReadiness` runs on a background timer, and two of its legs go through a
 * metered CLOB proxy. Before this, every pass refetched all eight legs, which
 * drained a 1 GB/month Webshare quota in ~9 days at ~10 KB/request.
 *
 * The lifetime is chosen from the OUTCOME, not the call site, because the three
 * cases have genuinely different costs:
 *
 *   - a good answer      → cache long; it is what we wanted
 *   - a bad-but-true answer ("you are blocked") → cache briefly, so recovery is
 *     noticed quickly once the proxy is restored
 *   - a failed check     → cache briefly WITH BACKOFF. This is the subtle one:
 *     "never cache failures" means "retry every time", which is precisely the
 *     hammering that exhausted the quota while the proxy was dead.
 * ------------------------------------------------------------------ */

const MINUTE = 60_000;
export const TTL = {
  geoblockAllowed: 4 * 60 * MINUTE,
  geoblockBlocked: 10 * MINUTE,
  depositOwner: 60 * MINUTE,
  gas: 10 * MINUTE,
  balances: MINUTE,
  failBase: MINUTE,
  failCap: 15 * MINUTE,
};

const _memo = new Map();

/** Backoff for a leg that keeps failing: 1m → 2m → 4m → 8m → 15m (capped). */
function failTtl(streak) {
  return Math.min(TTL.failBase * 2 ** Math.max(0, streak - 1), TTL.failCap);
}

/**
 * Run `fn`, caching its settled outcome for `ttlFor(value, error)` ms.
 *
 * Caches the in-flight promise, not just the result, so concurrent callers share
 * one network call — `checkReadiness` starts all legs at once and the background
 * timer can overlap an operator-triggered sync.
 */
function leased(key, fn, ttlFor) {
  const now = Date.now();
  const hit = _memo.get(key);
  if (hit && now < hit.expires) return hit.promise;

  const streak = hit?.streak ?? 0;
  const entry = { promise: null, expires: Infinity, streak };
  entry.promise = Promise.resolve()
    .then(fn)
    .then(
      (value) => {
        if (_memo.get(key) === entry) {
          entry.streak = 0;
          entry.expires = Date.now() + ttlFor(value, null);
        }
        return value;
      },
      (error) => {
        if (_memo.get(key) === entry) {
          entry.streak = streak + 1;
          entry.expires = Date.now() + failTtl(entry.streak);
        }
        throw error;
      },
    );
  _memo.set(key, entry);
  return entry.promise;
}

/**
 * Expire the balance-derived legs immediately.
 *
 * Called after a fill so the next sizing read cannot be based on money already
 * spent. Deliberately does NOT touch geoblock or the API key: a trade changes
 * balances, not your region or your credentials.
 */
export function invalidateBalanceCache() {
  for (const key of ['clobBalance', 'depositPusd', 'positions']) _memo.delete(key);
}

/** Test seam — drop every cached leg. */
export function resetReadinessCache() {
  _memo.clear();
}

/**
 * Apply a fill to an in-memory readiness snapshot, then expire the cached legs.
 *
 * `arbEngine.ts:157` sizes live packages straight off `spendableBalance`, which
 * is TTL-cached above. A post-trade refresh would hand back the PRE-trade
 * number, and waiting for the TTL to lapse leaves a window in which the 250ms
 * scan loop sizes further orders against money already committed — a second leg
 * rejected for collateral leaves the first UNHEDGED.
 *
 * So the deduction is synchronous and local; the network round trip that
 * follows is a truth-up, not the mechanism. Clamped at zero because a balance
 * cannot go negative, and a negative here would size the *next* trade wrongly in
 * the opposite direction.
 */
export function applyBalanceDelta(readiness, deltaUsd) {
  const delta = Number(deltaUsd) || 0;
  if (!delta || !readiness) return readiness;
  for (const field of ['spendableBalance', 'clobBalance']) {
    const raw = readiness[field];
    // `Number(null)` is 0, which is finite — so a plain isFinite check would
    // turn "balance unknown" into a fabricated "balance zero". Leave unknown
    // alone; a caller that has never read a balance must not be handed one.
    if (raw == null) continue;
    const current = Number(raw);
    if (!Number.isFinite(current)) continue;
    readiness[field] = Math.max(0, Math.round((current + delta) * 100) / 100);
  }
  invalidateBalanceCache();
  return readiness;
}

export async function checkReadiness(config = {}) {
  const wallet = getWallet();
  const address = wallet.address;
  const depositWallet = wallet.polymarketDepositWallet || null;
  const checks = [];
  let apiReady = false;
  let clobBalance = 0;
  let clobAllowance = 0;
  let onchainUsdc = 0;
  let depositPusd = 0;
  let polyBalance = 0;
  let depositOwner = null;
  let ownerMatches = false;
  let clobError = null;
  let positions = [];
  /*
   * Backlog item 55 — these eight calls share no input data; only the assembly
   * of `checks` below is ordered. Run sequentially the worst case was the SUM of
   * eight independent timeouts (~55s), which sits past the 25s response deadline
   * that item 54 documents, so `/api/poly/sync` could not answer inside its own
   * budget. Started together, the worst case is the MAX of one (~8s).
   *
   * Two invariants this must preserve, and does: `checks` is pushed in exactly
   * the previous order (the dashboard renders the array as-is), and every leg
   * keeps its original failure branch. Only the waiting overlaps.
   *
   * Cost of the change: four concurrent calls to polygon-bor.publicnode.com
   * instead of four sequential ones. Agreed with the operator 2026-09-07.
   */
  const geoblockP = leased('geoblock', checkGeoblock,   // never rejects — proxyEnv.ts:180
    (v) => (v?.ok && !v.blocked ? TTL.geoblockAllowed : TTL.geoblockBlocked));
  // `ensureApiKey` owns its own success/backoff memo (trade.ts), so it is not
  // leased here — double-caching would only delay its recovery.
  const apiP = capture(ensureApiKey());
  const ownerP = depositWallet
    ? leased('depositOwner', () => readDepositWalletOwner(depositWallet), () => TTL.depositOwner)
    : null;   // never rejects — :34
  const pusdP = depositWallet
    ? capture(leased('depositPusd', () => getClient().readContract({
      address: POLY.pUsd,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [depositWallet],
    }), () => TTL.balances))
    : null;
  const positionsP = depositWallet
    ? leased('positions', () => fetchDepositPositions(depositWallet), () => TTL.balances)
    : null; // never rejects — :50
  const clobP = capture(leased('clobBalance', getClobBalance, () => TTL.balances));
  const usdcP = capture(leased('onchainUsdc', () => getClient().readContract({
    address: POLY.usdc,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  }), () => TTL.balances));
  const polP = capture(leased('polBalance', () => getClient().getBalance({ address }), () => TTL.gas));

  const geoblock = await geoblockP;
  checks.push({
    id: 'geoblock',
    ok: geoblock.ok && !geoblock.blocked,
    detail: geoblock.blocked
      ? `Trading restricted from ${geoblock.country || 'current region'}${geoblock.region ? `/${geoblock.region}` : ''}`
      : (geoblock.ok ? `Trading region allowed (${geoblock.country || 'unknown'})` : `Region check failed: ${geoblock.error || 'unknown error'}`),
  });

  const api = await apiP;
  if (api.ok) {
    apiReady = !!api.value?.key;
    checks.push({ id: 'api', ok: apiReady, detail: apiReady ? 'CLOB API key derived from wallet' : 'API key missing' });
  } else {
    checks.push({ id: 'api', ok: false, detail: `API auth failed: ${api.error.message}` });
  }

  if (depositWallet) {
    depositOwner = await ownerP;
    ownerMatches = !!depositOwner && depositOwner.toLowerCase() === address.toLowerCase();
    checks.push({
      id: 'deposit_owner',
      ok: ownerMatches,
      detail: ownerMatches
        ? `Deposit wallet owned by bot signer ${address.slice(0, 6)}…${address.slice(-4)}`
        : `Deposit wallet owner ${depositOwner?.slice(0, 6)}…${depositOwner?.slice(-4)} ≠ bot ${address.slice(0, 6)}…${address.slice(-4)}`,
    });

    const pusd = await pusdP;
    if (pusd.ok) {
      depositPusd = Number(formatUnits(pusd.value, 6));
      checks.push({
        id: 'deposit_pusd',
        ok: depositPusd > 0,
        detail: `Deposit wallet pUSD $${depositPusd.toFixed(2)} at ${depositWallet.slice(0, 6)}…${depositWallet.slice(-4)}`,
      });
    } else {
      checks.push({ id: 'deposit_pusd', ok: false, detail: `Deposit pUSD check failed: ${pusd.error.message}` });
    }

    positions = await positionsP;
    if (positions.length) {
      const openPnl = positions.reduce((sum, p) => sum + Number(p.cashPnl || 0), 0);
      checks.push({
        id: 'open_positions',
        ok: true,
        detail: `${positions.length} open position(s) · unrealized PnL ${openPnl >= 0 ? '+' : ''}$${openPnl.toFixed(2)}`,
      });
    }
  }

  const clob = await clobP;
  if (clob.ok) {
    clobBalance = clob.value.balance;
    clobAllowance = clob.value.allowance;
    clobError = clob.value.clobError;
    const effectiveBalance = clobBalance > 0 ? clobBalance : depositPusd;
    checks.push({
      id: 'clob_balance',
      ok: effectiveBalance >= POLY_MIN_ORDER_USD,
      detail: clobError
        ? `CLOB cache $0 (${clobError}) · on-chain pUSD $${depositPusd.toFixed(2)}`
        : `CLOB pUSD $${clobBalance.toFixed(2)} (need $${POLY_MIN_ORDER_USD}+)`,
    });
    checks.push({
      id: 'allowance',
      ok: clobAllowance > 0 || effectiveBalance === 0,
      detail: clobAllowance > 0 ? `Allowance $${clobAllowance.toFixed(2)}` : 'No exchange allowance yet',
    });
  } else {
    checks.push({ id: 'clob_balance', ok: depositPusd >= POLY_MIN_ORDER_USD, detail: `CLOB balance check failed: ${clob.error.message}` });
  }

  const usdc = await usdcP;
  if (usdc.ok) {
    onchainUsdc = Number(formatUnits(usdc.value, 6));
    checks.push({
      id: 'wallet_usdc',
      ok: onchainUsdc > 0,
      detail: `Signer wallet USDC $${onchainUsdc.toFixed(2)}`,
    });
  } else {
    checks.push({ id: 'wallet_usdc', ok: false, detail: `Wallet USDC check failed: ${usdc.error.message}` });
  }

  const pol = await polP;
  if (pol.ok) {
    polyBalance = Number(formatUnits(pol.value, 18));
    // CLOB trades via deposit wallet — POL on signer is optional, not a live blocker
    checks.push({
      id: 'gas',
      ok: true,
      detail: polyBalance > 0.01 ? `Signer POL ${polyBalance.toFixed(4)} (optional)` : 'CLOB uses deposit wallet — no POL needed',
    });
  } else {
    checks.push({ id: 'gas', ok: true, detail: 'Gas check skipped (CLOB path)' });
  }

  const spendable = Math.max(clobBalance, depositPusd);
  const limits = resolveDynamicLimits(config, spendable);
  const minBet = limits.minUsd;
  const maxBet = limits.maxUsd;
  const sizeOk = maxBet >= minBet && minBet >= POLY_MIN_ORDER_USD;
  checks.push({
    id: 'position_size',
    ok: sizeOk,
    detail: config.useKellySizing
      ? `Kelly $${minBet}–$${maxBet} dynamic (${Math.round((config.maxPositionPct ?? 0.4) * 100)}% bankroll)`
      : `Fixed $${minBet}–$${maxBet}`,
  });

  const minRequired = minBet;
  const regionAllowed = geoblock.ok && !geoblock.blocked;
  const clobWorks = apiReady && !clobError;
  const liveReady = (regionAllowed || clobWorks) && apiReady && ownerMatches && spendable >= minRequired && sizeOk && (!clobError || spendable >= minRequired);
  const walletFunded = onchainUsdc >= minRequired || depositPusd >= minRequired;
  const paperReady = true;

  return {
    wallet: address,
    signer: getWalletAddress(),
    funder: getFunderAddress(),
    depositWallet,
    depositOwner,
    ownerMatches,
    clobError,
    geoblock,
    proxy: redactProxy(getClobProxyUrl()),
    openPositions: positions.length,
    positions: positions.slice(0, 10),
    apiReady,
    liveReady,
    walletFunded,
    needsDeposit: walletFunded && spendable < minRequired,
    paperReady,
    clobBalance,
    depositPusd,
    spendableBalance: spendable,
    clobAllowance,
    onchainUsdc,
    polyBalance,
    minOrderUsd: minBet,
    maxOrderUsd: maxBet,
    useKellySizing: !!config.useKellySizing,
    needs: [
      depositWallet && !ownerMatches && `Deposit wallet owner ${depositOwner} is not bot signer ${address} — export that wallet’s private key into Zinger`,
      clobError && `CLOB registry: ${clobError} (website balance may still work)`,
      !apiReady && 'Wallet must sign CLOB API auth (automatic on first live trade)',
      !regionAllowed && clobWorks && `Polymarket region check says blocked (${geoblock.country || 'FR'}) but CLOB API works — live trading allowed`,
      !regionAllowed && !clobWorks && (geoblock.blocked
        ? `Polymarket trading is restricted in ${geoblock.country || 'this region'}`
        : `Unable to verify trading region: ${geoblock.error || 'unknown error'}`),
      spendable < minRequired && `Need $${minRequired}+ trading balance (have $${spendable.toFixed(2)} pUSD)`,
      !sizeOk && `Bet range invalid — min $${minBet} max $${maxBet}`,
    ].filter(Boolean),
    checks,
  };
}
