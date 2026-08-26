// @ts-nocheck
/**
 * Position settlement valuation and window duration resolution (D4, items 8 & 11).
 *
 * ## Backlog Item 8: Naked leg settlement
 * An intact arb package consists of two complementary outcome tokens (UP and DOWN)
 * that together redeem to exactly $1.00 at resolution ($0.50 per share).
 *
 * If a leg is left naked (due to a partial fill, aborted rollback, or orphan),
 * valuing it at $0.50 is a fabrication — it guarantees a phantom profit or loss
 * regardless of the real underlying price action. A naked leg must resolve
 * against the real market outcome: $1.00 if it won, $0.00 if it lost.
 *
 * ## Backlog Item 11: Duration-aware orphan settlement
 * Slug durations vary (5m = 300s, 15m = 900s, 30m = 1800s, 1h = 3600s, 4h = 14400s).
 * Hardcoding 300s causes longer-duration positions to be prematurely settled.
 * Window end is derived from the slug's parsed duration.
 */

import { POLY_WINDOW_SECONDS } from '../config.js';
import { parseSlugWindow } from '../windows.js';

/**
 * Checks if a position is part of an intact, currently open arb hedge.
 *
 * An arb hedge is intact if both legs (UP and DOWN) for the same `packageId`
 * are present in the open positions list.
 */
export function isHedgeIntact(pos, openPositions = []) {
  if (!pos?.packageId && !pos?.isArbLeg) return false;
  const pkgId = pos?.packageId;
  if (!pkgId) return false;

  const outcome = String(pos.outcome || '').toLowerCase();
  const siblingOutcome = outcome === 'up' ? 'down' : outcome === 'down' ? 'up' : null;
  if (!siblingOutcome) return false;

  return openPositions.some((p) => {
    if (p.packageId !== pkgId) return false;
    if (String(p.outcome || '').toLowerCase() !== siblingOutcome) return false;
    // Sibling is currently open
    if (!p.closed) return true;
    // Sibling was settled as part of the hedged pair settlement pass ($0.50 per share)
    if (p.exitReason === 'settle' || p.exitPrice === 0.50) return true;
    return false;
  });
}

/**
 * Resolves the winning outcome of a binary market ('up' | 'down' | null).
 *
 * Evaluates in order:
 *  1. Explicit market winner / resolved outcome fields
 *  2. Price-To-Beat oracle data (closePrice vs openPrice)
 *  3. Final price vs market priceToBeat
 */
export function resolveMarketWinner({ market = null, ptb = null, finalPrice = null } = {}) {
  // 1. Direct market resolution metadata
  const explicitWinner = market?.winner || market?.resolvedOutcome;
  if (explicitWinner) {
    const norm = String(explicitWinner).toLowerCase();
    if (norm === 'up' || norm === 'down') return norm;
  }

  // 2. PTB oracle open vs close price
  const openPrice = Number(ptb?.openPrice ?? market?.priceToBeat);
  const closePrice = Number(ptb?.closePrice ?? finalPrice ?? market?.priceToBeatMeta?.closePrice);

  if (Number.isFinite(openPrice) && openPrice > 0 && Number.isFinite(closePrice) && closePrice > 0) {
    if (closePrice > openPrice) return 'up';
    if (closePrice < openPrice) return 'down';
    // Exact tie: Polymarket resolves tie as Down/No in standard binaries
    return 'down';
  }

  return null;
}

/**
 * Resolves the settlement exit price for a position.
 *
 * Rules:
 *  - Intact Arb Pair: returns $0.50 (each leg pays half of the $1.00 total payout).
 *  - Naked Arb Leg or Directional:
 *      • Market Won: $1.00
 *      • Market Lost: $0.00
 *      • Market Unresolved: falls back to pos.currentPrice or pos.entryPrice
 */
export function resolveSettlementPrice({
  pos,
  openPositions = [],
  market = null,
  ptb = null,
  finalPrice = null,
} = {}) {
  if (!pos) return { price: 0, isPairSettled: false, winner: null, reason: 'invalid_position' };

  const isArb = !!(pos.packageId || pos.isArbLeg);
  const hedgeIntact = isArb && isHedgeIntact(pos, openPositions);

  // Intact hedged pair: valid $0.50 per-leg payout
  if (hedgeIntact) {
    return {
      price: 0.50,
      isPairSettled: true,
      winner: null,
      reason: 'intact_arb_pair',
    };
  }

  // Naked arb leg or directional position: resolve against real market outcome
  const winner = resolveMarketWinner({ market, ptb, finalPrice });
  const posOutcome = String(pos.outcome || '').toLowerCase();

  if (winner != null && (posOutcome === 'up' || posOutcome === 'down')) {
    const won = posOutcome === winner;
    const price = won ? 1.00 : 0.00;
    const reason = isArb
      ? (won ? 'naked_arb_won' : 'naked_arb_lost')
      : (won ? 'directional_won' : 'directional_lost');

    return {
      price,
      isPairSettled: false,
      winner,
      reason,
    };
  }

  // Unresolved outcome fallback: mark/entry price
  const fallbackPrice = Number(pos.currentPrice || pos.entryPrice || 0);
  return {
    price: fallbackPrice,
    isPairSettled: false,
    winner: null,
    reason: 'unresolved_market_mark',
  };
}

/**
 * Calculates the exact window end timestamp in ms from the position's slug and duration.
 *
 * Fixes Item 11: uses the parsed duration (5m, 15m, 30m, 1h, 4h) rather than
 * hardcoding POLY_WINDOW_SECONDS (300s).
 */
export function positionWindowEndMs(pos) {
  if (!pos?.slug) return null;

  const parsed = parseSlugWindow(pos.slug);
  if (parsed?.endAtMs) {
    return parsed.endAtMs;
  }

  // Fallback for non-standard slugs: parse epoch timestamp
  const slugTs = Number(String(pos.slug).split('-').pop());
  if (Number.isFinite(slugTs) && slugTs > 1e9) {
    const windowSec = Number(pos.windowSeconds) || POLY_WINDOW_SECONDS;
    return (slugTs + windowSec) * 1000;
  }

  return null;
}
