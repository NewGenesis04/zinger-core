// @ts-nocheck
/**
 * The policy interface both engines implement (D4).
 *
 * D4's rule is that shared position code contains **zero strategy
 * conditionals**. Before this module, five places in `bot.ts` asked the same
 * question in five different phrasings:
 *
 *   bot.ts:408   `!p.packageId && !p.isArbLeg`             overdraft repair
 *   bot.ts:440   `tradeEngine(p) === 'directional'`        slot trim
 *   bot.ts:1916  `pos.closed || pos.packageId || pos.isArbLeg`  exit management
 *   bot.ts:2488  `op.packageId || op.isArbLeg`             max-drawdown close
 *   bot.ts:2776  `pos.packageId || pos.isArbLeg`           mid-window exits
 *
 * Every one of them means: *does this position's payoff only exist at
 * settlement?* An arb leg is half of a hedge that redeems to exactly $1.00 as a
 * pair, so closing it early does not protect anything — it forfeits the locked
 * edge, books the spread, and strands the sibling. A directional position is the
 * opposite: mid-window exits are the entire risk control.
 *
 * Five spellings of one predicate is how a rule gets applied in four places and
 * forgotten in the fifth. That is not hypothetical here — item 25 was exactly
 * that: the overdraft loop at :408 excluded hedges and the trim loop at :440,
 * eighteen lines below, did not.
 *
 * ## One predicate, deliberately
 *
 * `holdsToSettlement` covers both "may risk machinery force-close this?" and
 * "does normal SL/TP/trail logic run on this?". Those are different questions
 * that happen to have the same answer for both engines today. Splitting them
 * into two predicates that always agree would add a rule answering no question
 * the other doesn't — which the owner's guidance on backlog item 3 rules out
 * ("fewest rules that still express the intent, each answering a question no
 * other rule answers"). If they ever diverge, split them then.
 *
 * Note `pos.holdToSettle` is a *different, weaker* flag: a directional underdog
 * that skips trailing exits but still takes a full TP near resolution and a
 * disaster SL (`bot.ts:2780`). It is not this predicate and must not be merged
 * with it — arb legs take no mid-window exit at all.
 *
 * ## Capacity
 *
 * The engines' slot dials live here too, because "which dial governs this
 * position" is the same kind of question. They were cross-wired until D5: arb
 * legs charged against `maxOpenPositions`, so a hedged pair ate two directional
 * slots and arb's real capacity was `maxOpenPositions / 2` regardless of
 * `maxArbPackages`.
 */

import { tradeEngine } from '../audit.js';

export const POLICIES = Object.freeze({
  directional: Object.freeze({
    engine: 'directional',
    // Mid-window exits ARE the risk control: stop loss, take profit, trailing,
    // partial. Force-closing one is a loss being cut, which is the point.
    holdsToSettlement: false,
    slotKey: 'maxOpenPositions',
    slotDefault: 6,
    // One slot, one position.
    positionsPerSlot: 1,
  }),
  arb: Object.freeze({
    engine: 'arb',
    // A leg is half a hedge that redeems to exactly $1.00 as a pair. Any
    // mid-window exit destroys the edge instead of protecting it.
    holdsToSettlement: true,
    slotKey: 'maxArbPackages',
    slotDefault: 4,
    // A package is two positions — up and down — filling one slot.
    positionsPerSlot: 2,
  }),
});

/**
 * The policy for an engine *name*.
 *
 * Split out from `policyFor` so the undeclared-engine branch is reachable, and
 * therefore testable. It is not reachable through `policyFor`: `tradeEngine`
 * returns only `'arb'` or `'directional'`, both of which are keys here, so a
 * fallback exercised only through `policyFor` is dead code that asserts
 * nothing. Verified by mutation — flipping the default to `POLICIES.arb` passed
 * the whole suite until this seam existed.
 *
 * The default is directional, the *managed* policy. An engine nobody has
 * declared a policy for must not inherit hold-to-settlement, because that
 * silently removes the stop loss from every position it opens.
 */
export function policyForEngine(engine) {
  return POLICIES[engine] || POLICIES.directional;
}

/**
 * The policy governing a position, plan, or trade.
 *
 * Dispatches through `tradeEngine`, which classifies untagged historical records
 * from `isArbLeg` / `packageId` rather than guessing — see audit.ts:79.
 */
export function policyFor(posOrPlan) {
  return policyForEngine(tradeEngine(posOrPlan));
}

/**
 * Structural evidence that this record is half of a hedge, independent of how
 * it is tagged. `packageId` is a real foreign key into `arbPersistence`, and
 * `isArbLeg` / `arb` are what `tradeEngine` classifies from for untagged history.
 */
function hasHedgeMarkers(posOrPlan) {
  return !!(posOrPlan?.packageId || posOrPlan?.isArbLeg || posOrPlan?.arb);
}

/**
 * True when this position's payoff only exists at settlement, so no mid-window
 * exit — risk-driven or otherwise — may touch it.
 *
 * ## Why this does not simply read the engine tag
 *
 * `tradeEngine` gives the explicit `engine` field priority over the structural
 * flags (audit.ts:80-82), which is right for P/L attribution. But it means a
 * record reading `{ engine: 'directional', packageId: 'pkg-…' }` classifies as
 * directional — and would then be exposed to stop-loss, drawdown and trim.
 *
 * That state is contradictory and this code cannot create it: position creation
 * stamps `engine: tradeEngine(plan)` (bot.ts:825), which returns `'arb'` for
 * anything carrying a `packageId`. It is guarded anyway because the two possible
 * misreadings are not symmetric:
 *
 *   treated as directional when it is a leg  ->  SL closes one side, forfeits the
 *                                               locked edge, stranks the sibling,
 *                                               and manufactures the naked leg
 *                                               item 8 settles at a fabricated
 *                                               $0.50
 *   treated as a leg when it is directional  ->  one position holds to window end
 *                                               without a stop
 *
 * The first corrupts a hedge and the accounting that depends on it; the second
 * is a single unmanaged position. So the structural markers win: any hedge
 * evidence at all means hold to settlement. Fail toward the intact pair.
 */
/**
 * Is the hedge this leg belongs to still actually a hedge? — backlog item 74a.
 *
 * The exemption above rests on a real property: a complementary pair redeems to
 * exactly $1.00 at settlement, so closing it early forfeits the edge for
 * nothing. That property belongs to the PAIR. A leg whose sibling never filled,
 * or was unwound, does not have it — it is an ordinary directional bet, and the
 * marker on it is a statement of intent, not of fact.
 *
 * If the markers alone decided, the one position that most needs a stop loss —
 * a naked leg the operator never chose to hold — would be the single position
 * guaranteed to ride to settlement untouched.
 *
 * ## Still failing toward the intact pair, and why that is not timidity
 *
 * Every "cannot tell" answer here returns `true` (stay exempt). The two errors
 * are not symmetric, and the asymmetry runs the opposite way to intuition:
 *
 *   wrongly EXPOSE an intact pair  ->  a stop loss closes one side, forfeits the
 *                                      locked edge, and MANUFACTURES the naked
 *                                      leg this item exists to protect against
 *   wrongly EXEMPT a naked leg     ->  one unmanaged directional position, which
 *                                      is what we had before this fix
 *
 * The first error creates the problem; the second merely fails to fix it. So the
 * exemption is withdrawn only on positive evidence that the hedge is gone —
 * never on an absent package record, never on a missing context.
 */
export function hedgeIsIntact(pos, { packages = null, positions = null } = {}) {
  const packageId = pos?.packageId;
  // A marker with no package key: nothing to check it against.
  if (!packageId) return true;
  if (!Array.isArray(packages)) return true;

  const pkg = packages.find((p) => p?.packageId === packageId);
  // Unknown package — cannot disprove the hedge, so do not act on a guess.
  if (!pkg) return true;

  // LOCKED / SETTLED / MERGED are intact by definition; PENDING_FILL is still
  // in flight and must not be touched mid-dispatch.
  if (pkg.status !== 'ABORTED') return true;

  /**
   * ABORTED does not by itself mean naked. A package can abort with both legs
   * held — the parity-breach path does exactly that — and force-closing a real
   * pair is the expensive error. So the question is narrower: is a live sibling
   * on the opposite outcome still open?
   */
  if (!Array.isArray(positions)) return true;
  const sibling = positions.find((p) => (
    p
    && !p.closed
    && p.packageId === packageId
    && String(p.outcome) !== String(pos?.outcome)
    && Number(p.shares || 0) > 0
  ));
  return !!sibling;
}

/**
 * @param context  Optional `{ packages, positions }`. Supplied by the risk-exit
 *   call sites so a naked leg can be told apart from a hedged one (item 74a).
 *   Omitted elsewhere, where the answer is "is this engine exit-managed" rather
 *   than "may this specific position be closed now" — and where the old
 *   marker-only reading is still the right one.
 */
export function holdsToSettlement(posOrPlan, context = null) {
  if (hasHedgeMarkers(posOrPlan)) {
    if (context) return hedgeIsIntact(posOrPlan, context);
    return true;
  }
  return policyFor(posOrPlan).holdsToSettlement === true;
}

/**
 * Does the window-end sale skip this position? (item 114)
 *
 * The per-market loop sells a position at, or in the last seconds before,
 * window end. For a live position that holds to settlement, the venue's exit is
 * redemption: fee-free, at the payout, exactly $1.00 for a full set (domain
 * facts §2, §3). A market sell there gets a bid below the payout and pays a
 * taker fee, so it is strictly worse, and it can only lose.
 *
 * Live only. Paper has no redemption, and its window-end close *is* its
 * settlement model.
 *
 * `context` is required for the same reason `hedgeIsIntact` wants it: a naked
 * leg is directional exposure and stays exit-managed.
 */
export function skipsWindowEndSale(pos, context) {
  return pos?.mode === 'live' && holdsToSettlement(pos, context);
}

/** The inverse, spelled out because it reads better at call sites that manage exits. */
export function isExitManaged(posOrPlan) {
  return !holdsToSettlement(posOrPlan);
}

/**
 * The capacity budget for whichever engine owns this plan (D5).
 *
 * `max` is in *positions*, not slots, because that is what a count of open
 * positions can be compared against. The labels are the operator-facing strings
 * from the skip log and are kept verbatim.
 */
export function capacityFor(posOrPlan, cfg = {}) {
  const policy = policyFor(posOrPlan);
  const raw = Number(cfg[policy.slotKey] ?? policy.slotDefault);
  const slots = Number.isFinite(raw) ? raw : policy.slotDefault;
  return {
    engine: policy.engine,
    slots,
    max: slots * policy.positionsPerSlot,
    label: policy.engine === 'arb'
      ? `max arb legs (${slots} packages)`
      : `max open directional positions (${slots})`,
  };
}
