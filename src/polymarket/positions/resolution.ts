// @ts-nocheck
/**
 * Live settlement by resolution (item 103): when a market has resolved, what is
 * each token worth, when to ask, and what a position closed at that value
 * realized.
 *
 * ## The one source of a payout
 *
 * Gamma's resolved market record, and nothing else (domain facts §6, §10a).
 * A resolved market reports `closed: true`, `umaResolutionStatus: "resolved"`,
 * and `outcomePrices` as an exact payout vector in the same order as
 * `clobTokenIds`. Anything short of that is *not resolved yet*. A live price of
 * 0.99, a price-to-beat comparison, or a spot move is a guess about the
 * payout, not the payout. `settle.ts:resolveMarketWinner` makes those guesses
 * for paper. This module must not.
 *
 * ## Why books close at resolution, not at redemption
 *
 * Once `reportPayouts` lands, a token's value is fixed: redemption only turns it
 * into cash, at exactly that value and fee-free (§2, §3). So the position is
 * closed when the payout is known, and cash arrives whenever the account's
 * redemption runs. Neither the timing nor the mechanism of that redemption is
 * needed.
 *
 * Contains no strategy conditionals (D4). An arb leg and a directional position
 * resolve by the same rule.
 */

const SEC = 1000;
const MIN = 60 * SEC;

/** Resolution lands ~52-54s or ~85-93s after window end, nothing between (§6). */
export const FIRST_POLL_MS = 55 * SEC;
export const SECOND_POLL_MS = 95 * SEC;
export const POLL_INTERVAL_MS = MIN;
export const OVERDUE_MS = 15 * MIN;
export const OVERDUE_POLL_INTERVAL_MS = 5 * MIN;

function parseList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const PAYOUTS = new Set([0, 0.5, 1]);

/**
 * A Gamma market record → `{ [tokenId]: payout }`, or null if it is not a
 * resolution.
 *
 * Paired by position in `clobTokenIds` and `outcomePrices`, never by outcome
 * label, so no assumption about which index is Up is needed.
 */
export function payoutVectorFromGamma(row) {
  if (!row || row.closed !== true || row.umaResolutionStatus !== 'resolved') return null;
  const tokens = parseList(row.clobTokenIds);
  const prices = parseList(row.outcomePrices);
  if (!tokens || !prices || tokens.length < 2 || tokens.length !== prices.length) return null;
  const payouts = prices.map((p) => (typeof p === 'string' && p.trim() === '' ? NaN : Number(p)));
  if (!payouts.every((p) => PAYOUTS.has(p))) return null;
  const sum = payouts.reduce((s, p) => s + p, 0);
  if (Math.abs(sum - 1) > 1e-9) return null;
  const out = {};
  for (let i = 0; i < tokens.length; i++) {
    const id = String(tokens[i] ?? '');
    if (!id) return null;
    out[id] = payouts[i];
  }
  return out;
}

/**
 * Is a poll of this market due?
 *
 * Shaped to the measured distribution: one poll after the first mode, one after
 * the second, then every minute, and every five minutes once overdue. A day of
 * packages costs well under a hundred requests. Gamma is plain `fetch`, not the
 * metered CLOB proxy.
 */
export function resolutionPollDue({ windowEndMs, now, lastPollAt = null }) {
  const since = now - windowEndMs;
  if (!(since >= FIRST_POLL_MS)) return false;
  if (lastPollAt == null) return true;
  if (since < SECOND_POLL_MS) return false;
  if (lastPollAt < windowEndMs + SECOND_POLL_MS) return true;
  const interval = since < OVERDUE_MS ? POLL_INTERVAL_MS : OVERDUE_POLL_INTERVAL_MS;
  return now - lastPollAt >= interval;
}

export function resolutionOverdue({ windowEndMs, now }) {
  return now - windowEndMs >= OVERDUE_MS;
}

/**
 * What a position closed at `payout` realized.
 *
 * Cost and fee come from the entry's `fill` (item 105) and are pro-rated if
 * some shares were sold earlier. A position recorded before fill capture falls
 * back to `costBasis`, with the fee unknown, and says so. Redemption is
 * fee-free, so there is no exit fee.
 */
export function resolvedExit({ shares, payout, fill = null, costBasis = 0 }) {
  const held = Number(shares) || 0;
  const hasFill = !!fill && Number(fill.shares) > 0;
  const share = hasFill ? held / Number(fill.shares) : null;
  const cost = hasFill ? Number(fill.costUsd) * share : Number(costBasis) || 0;
  const fee = hasFill ? Number(fill.feeUsd || 0) * share : 0;
  const proceeds = held * payout;
  const exact = proceeds - cost - fee;
  return {
    shares: held,
    proceedsUsd: Math.round(proceeds * 1e6) / 1e6,
    costUsd: Math.round(cost * 1e6) / 1e6,
    feeUsd: Math.round(fee * 1e6) / 1e6,
    pnlExactUsd: Math.round(exact * 1e6) / 1e6,
    pnl: Math.round(exact * 100) / 100,
    gainPct: cost > 0 ? Math.round((exact / cost) * 10000) / 100 : 0,
    costSource: hasFill ? fill.priceSource || 'fill' : 'cost_basis',
    feeKnown: hasFill,
  };
}
