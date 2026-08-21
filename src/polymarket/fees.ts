// @ts-nocheck
/**
 * Polymarket CLOB taker fees — same math the order client uses.
 *
 * Platform fee (clob-client-v2 adjustBuyAmountForFees):
 *   platformFee = shares × rate × (p × (1 − p))^exponent
 * where rate/exponent come from GET /clob-markets/{conditionId} → fd.r / fd.e.
 *
 * Order signing uses GET /fee-rate?token_id=… → base_fee (bps), separate from USDC fee.
 *
 * Paper assumes aggressive (taker) fills. Settlement / redemption is NOT a CLOB sell.
 */

const CLOB_HOST = String(process.env.CLOB_API_URL || process.env.CLOB_HOST || 'https://clob.polymarket.com').replace(/\/$/, '');

/** Category fallbacks when token fee params are unavailable (docs schedule). */
export const FEE_RATES = Object.freeze({
  crypto: 0.07,
  sports: 0.05,
  finance: 0.04,
  politics: 0.04,
  economics: 0.05,
  culture: 0.05,
  weather: 0.05,
  other: 0.05,
  mentions: 0.04,
  tech: 0.04,
  geopolitics: 0,
});

/** Exits that resolve via redeem / window end — not a taker CLOB sell. */
export const FEE_FREE_EXIT_REASONS = Object.freeze(new Set([
  'settle',
  'window_close',
  'redeem',
  'resolution',
  'orphan_settle',
]));

const feeCache = new Map(); // tokenId -> { rate, exponent, feeRateBps, takerOnly, at }
const FEE_CACHE_TTL_MS = 10 * 60 * 1000;

/** Round to 5 decimal places (protocol precision). */
export function roundFeeUsdc(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rounded = Math.round(n * 1e5) / 1e5;
  return rounded < 0.00001 ? 0 : rounded;
}

function categoryParams(categoryOrRate = 'crypto') {
  if (categoryOrRate && typeof categoryOrRate === 'object') {
    const rate = Number(categoryOrRate.rate ?? categoryOrRate.r ?? 0);
    const exponent = Number(categoryOrRate.exponent ?? categoryOrRate.e ?? 1);
    return {
      rate: Number.isFinite(rate) ? rate : 0,
      exponent: Number.isFinite(exponent) ? exponent : 1,
      feeRateBps: Number(categoryOrRate.feeRateBps ?? categoryOrRate.base_fee ?? 0) || 0,
      takerOnly: categoryOrRate.takerOnly !== false && categoryOrRate.to !== false,
      source: categoryOrRate.source || 'inline',
    };
  }
  if (typeof categoryOrRate === 'number') {
    return { rate: categoryOrRate, exponent: 1, feeRateBps: 0, takerOnly: true, source: 'rate' };
  }
  const key = String(categoryOrRate || 'crypto');
  return {
    rate: FEE_RATES[key] ?? FEE_RATES.crypto,
    exponent: 1,
    feeRateBps: 0,
    takerOnly: true,
    source: `category:${key}`,
  };
}

/**
 * Taker USDC fee for C shares at price p.
 * Matches @polymarket/clob-client-v2: shares * rate * (p*(1-p))^exponent
 */
export function takerFeeUsdc(shares, price, categoryOrRate = 'crypto') {
  const C = Number(shares);
  const p = Number(price);
  if (!(C > 0) || !(p > 0) || !(p < 1)) return 0;
  const { rate, exponent } = categoryParams(categoryOrRate);
  if (!(rate > 0)) return 0;
  const curve = (p * (1 - p)) ** Math.max(0, exponent);
  return roundFeeUsdc(C * rate * curve);
}

/**
 * Live fee params for a token **only if already cached** — never fetches.
 *
 * For use on hot paths that must not block. The arb gap gate is the motivating
 * caller: it runs per market per scan, and the 2026-08-12 outage was caused by
 * exactly this shape — a network fetch sitting in `scan()` upstream of the arb
 * engine, which needs nothing but the order book. A 4s timeout per market per
 * window rollover is not worth trading for parameters that are, on every market
 * this bot touches, identical to the category schedule (verified live:
 * `{"r":0.07,"e":1,"to":true}` vs `FEE_RATES.crypto = 0.07`, exponent 1).
 *
 * The fill path already calls `takerFeeUsdcForToken`, so the cache warms itself
 * and later scans in the same window get the live numbers for free.
 */
export function peekClobFeeParams(tokenId) {
  const id = String(tokenId || '').trim();
  if (!id) return null;
  const hit = feeCache.get(id);
  if (!hit || (Date.now() - hit.at) >= FEE_CACHE_TTL_MS) return null;
  return hit;
}

/**
 * The book gap at which an arb pair exactly breaks even, per share.
 *
 * A full set redeems exactly $1.00, so profit per share **is** the gap
 * (1 − upPrice − downPrice). Each leg is a taker buy paying
 * `rate × (p(1−p))^exponent` per share, at its own price. Hence:
 *
 *   break-even gap = rate × [ (u(1−u))^e + (d(1−d))^e ]
 *
 * which is **price-dependent, not flat**. Verified against the recomputed
 * 2026-08-18 overnight sample (backlog item 7):
 *
 *   0.50 / 0.50 → 3.50%      0.23 / 0.77 → 2.48%      0.10 / 0.90 → 1.26%
 *
 * Exit is free — settlement/redemption is not a CLOB sell, see
 * FEE_FREE_EXIT_REASONS — so the two entry fees are the whole cost.
 *
 * The legs are deliberately *not* assumed symmetric. In a tradable book they
 * sum to under $1.00 (that gap is the entire point), so `d != 1 − u` and each
 * leg's curve is evaluated at its own price.
 *
 * Returns Infinity for an unpriceable book, so a caller comparing
 * `gap > breakEven` fails closed.
 */
export function arbBreakEvenGap(upPrice, downPrice, categoryOrRate = 'crypto') {
  const u = Number(upPrice);
  const d = Number(downPrice);
  if (!(u > 0 && u < 1) || !(d > 0 && d < 1)) return Infinity;
  const { rate, exponent } = categoryParams(categoryOrRate);
  if (!(rate > 0)) return 0;
  const e = Math.max(0, exponent);
  const curve = (p) => (p * (1 - p)) ** e;
  // Deliberately NOT passed through roundFeeUsdc: this is a price *fraction*,
  // not a USDC amount. Rounding it to the protocol's 5dp money precision puts
  // an error into the rate itself, which then scales with share count — at 500
  // shares it drifts a tenth of a cent away from the fees actually charged.
  return rate * (curve(u) + curve(d));
}

async function clobGet(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${CLOB_HOST}${path}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`clob ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve live CLOB fee params for a token (same path order-builder uses).
 * @returns {Promise<{rate:number,exponent:number,feeRateBps:number,takerOnly:boolean,source:string}>}
 */
export async function resolveClobFeeParams(tokenId, fallbackCategory = 'crypto') {
  const id = String(tokenId || '').trim();
  const fallback = categoryParams(fallbackCategory);
  if (!id) return fallback;

  const hit = feeCache.get(id);
  if (hit && (Date.now() - hit.at) < FEE_CACHE_TTL_MS) {
    return hit;
  }

  try {
    const byToken = await clobGet(`/markets-by-token/${encodeURIComponent(id)}`);
    const conditionId = byToken?.condition_id || byToken?.conditionId;
    if (!conditionId) throw new Error('no condition_id');

    const [market, feeRate] = await Promise.all([
      clobGet(`/clob-markets/${encodeURIComponent(conditionId)}`),
      clobGet(`/fee-rate?token_id=${encodeURIComponent(id)}`).catch(() => null),
    ]);

    const fd = market?.fd || {};
    const rate = Number(fd.r);
    const exponent = Number(fd.e);
    const params = {
      rate: Number.isFinite(rate) ? rate : fallback.rate,
      exponent: Number.isFinite(exponent) ? exponent : 1,
      feeRateBps: Number(feeRate?.base_fee ?? market?.tbf ?? 0) || 0,
      takerOnly: fd.to !== false,
      source: 'clob-markets',
      conditionId,
      at: Date.now(),
    };
    feeCache.set(id, params);
    return params;
  } catch {
    const miss = { ...fallback, at: Date.now(), source: `${fallback.source}:fallback` };
    feeCache.set(id, miss);
    return miss;
  }
}

/** Async fee using live CLOB market schedule when tokenId is known. */
export async function takerFeeUsdcForToken(shares, price, tokenId, fallbackCategory = 'crypto') {
  const params = await resolveClobFeeParams(tokenId, fallbackCategory);
  return takerFeeUsdc(shares, price, params);
}

/** Effective cost to open a long (premium + taker fee). */
export function openCostWithFee(shares, price, category = 'crypto') {
  const premium = Math.round(shares * price * 100) / 100;
  const fee = takerFeeUsdc(shares, price, category);
  return { premium, fee, total: Math.round((premium + fee) * 100) / 100 };
}

export async function openCostWithFeeForToken(shares, price, tokenId, fallbackCategory = 'crypto') {
  const premium = Math.round(shares * price * 100) / 100;
  const fee = await takerFeeUsdcForToken(shares, price, tokenId, fallbackCategory);
  return { premium, fee, total: Math.round((premium + fee) * 100) / 100 };
}

/**
 * Net proceeds after selling shares on the CLOB (premium − taker fee).
 * Pass exitReason so settle/redeem skips the exit fee.
 */
export function closeProceedsWithFee(shares, price, category = 'crypto', exitReason = 'clob_sell') {
  const premium = Math.round(shares * price * 100) / 100;
  const fee = isFeeFreeExit(exitReason) ? 0 : takerFeeUsdc(shares, price, category);
  return { premium, fee, net: Math.round((premium - fee) * 100) / 100 };
}

export async function closeProceedsWithFeeForToken(shares, price, tokenId, exitReason = 'clob_sell', fallbackCategory = 'crypto') {
  const premium = Math.round(shares * price * 100) / 100;
  const fee = isFeeFreeExit(exitReason)
    ? 0
    : await takerFeeUsdcForToken(shares, price, tokenId, fallbackCategory);
  return { premium, fee, net: Math.round((premium - fee) * 100) / 100 };
}

export function isFeeFreeExit(exitReason) {
  const reason = String(exitReason || '').toLowerCase().trim();
  if (!reason) return false;
  if (FEE_FREE_EXIT_REASONS.has(reason)) return true;
  if (reason.includes('settle') || reason.includes('redeem')) return true;
  return false;
}

/** Expected round-trip fee if entry is taker and exit is a mid-window CLOB sell. */
export function expectedRoundTripFeeUsdc(shares, entryPrice, exitPrice, category = 'crypto') {
  return Math.round(
    (takerFeeUsdc(shares, entryPrice, category) + takerFeeUsdc(shares, exitPrice, category)) * 1e5,
  ) / 1e5;
}

export function clearFeeCache() {
  feeCache.clear();
}
