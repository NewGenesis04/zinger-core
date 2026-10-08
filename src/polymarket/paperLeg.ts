/**
 * Paper exit booking — the one owner of "what a paper exit leg did to cash and
 * to realized P/L" (backlog items 129, 130).
 *
 * Before this module the paper ledger had two conventions: cash moved net of
 * fees while stats and the session reconciler summed gross P/L, and the two stop
 * paths credited raw proceeds with no exit fee at all. Every number here is
 * derived from the cash that actually moved, in whole cents, so a leg's P/L
 * cannot disagree with the cash ledger by construction:
 *
 *   leg P/L = proceeds credited − cost allocated − entry fee allocated
 *
 * A position's cost and entry fee are debited once, at the buy. Each exit leg
 * (a partial, then the final) takes its share of what is still outstanding; the
 * final leg takes all of it, so the legs sum to the buy debit exactly.
 */

const cents = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
const fivedp = (n: number): number => Math.round((Number(n) || 0) * 1e5) / 1e5;

/**
 * Take `sell / held` of an outstanding amount. The final leg (sell >= held)
 * takes all of it, which is what makes the legs sum to the original exactly.
 */
export function allocateOutstanding(left: number, held: number, sell: number) {
  const outstanding = cents(left);
  if (!(held > 0) || !(sell > 0)) return { share: 0, remaining: outstanding };
  const frac = sell / held;
  if (frac >= 1 - 1e-9) return { share: outstanding, remaining: 0 };
  const share = cents(outstanding * frac);
  return { share, remaining: cents(outstanding - share) };
}

/** Cost still outstanding on a position. Falls back for records written before the field existed. */
export function costOutstanding(pos: any): number {
  const v = Number(pos?.costBasisRemaining);
  if (Number.isFinite(v)) return cents(v);
  return cents(Number(pos?.costBasis) || Number(pos?.size) || 0);
}

/** Entry fee still outstanding on a position (cash terms, cents). */
export function entryFeeOutstanding(pos: any): number {
  const v = Number(pos?.entryFeeRemaining);
  if (Number.isFinite(v)) return cents(v);
  return cents(Number(pos?.entryFee) || 0);
}

/**
 * Fields set on a paper position when it is bought. `debit` is the cash that
 * left the account (premium + fee, rounded once, as cash is).
 */
export function paperEntryFields(premium: number, debit: number) {
  const cost = cents(premium);
  return {
    costBasisRemaining: cost,
    entryFeeRemaining: cents(cents(debit) - cost),
  };
}

export interface PaperLegInput {
  pos: any;
  heldShares: number;
  sellShares: number;
  /** Net cash credited for this leg (premium − exit fee), cents. */
  proceeds: number;
  /** Exit taker fee for this leg. */
  exitFee: number;
}

/**
 * Compute one exit leg. Pure: returns the fields to merge onto the position
 * and onto the trade record. The caller credits `proceeds` to cash.
 */
export function bookPaperLeg({ pos, heldShares, sellShares, proceeds, exitFee }: PaperLegInput) {
  const cost = allocateOutstanding(costOutstanding(pos), heldShares, sellShares);
  const entryFee = allocateOutstanding(entryFeeOutstanding(pos), heldShares, sellShares);
  const legProceeds = cents(proceeds);
  const pnl = cents(legProceeds - cost.share - entryFee.share);
  const startFees = Number.isFinite(Number(pos?.feesPaid)) ? Number(pos.feesPaid) : Number(pos?.entryFee) || 0;
  return {
    pnl,
    // Per-leg primitives. `tradeNetPnl` recomputes the leg's P/L from these.
    record: {
      legProceeds,
      legCost: cost.share,
      entryFeeShare: entryFee.share,
      exitFee: fivedp(exitFee),
    },
    // Running position state after this leg.
    state: {
      costBasisRemaining: cost.remaining,
      entryFeeRemaining: entryFee.remaining,
      // Lifetime fees, accumulated — a final leg must not overwrite a partial's fee.
      feesPaid: fivedp(startFees + exitFee),
    },
  };
}

/**
 * Where a paper stop fills. The real bid, as live does.
 *
 * This used to floor paper fills at `entry × (1 − (stop + slippage))`, so a
 * gap through the stop booked the stop price, not the price the book paid —
 * paper losses were bounded and live losses were not. `cfg` is kept in the
 * signature so callers need not change.
 */
export function resolveSlFillPrice(pos: any, markBid: number, _effectiveSl?: number, _cfg?: any): number {
  const entry = Number(pos?.entryPrice || 0);
  const mark = Number(markBid || 0);
  if (!(entry > 0)) return mark;
  return Math.round(Math.max(0.01, mark) * 1000) / 1000;
}
