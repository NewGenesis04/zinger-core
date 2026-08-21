// @ts-nocheck
/**
 * Config precedence — operator > guardrail > automation (D3).
 *
 * Zinger has three kinds of writer and, until this module, no way to tell them
 * apart:
 *
 *   operator     a human set it in the UI
 *   guardrail    safety code clamping something (edge gate, forceArbOnly)
 *   automation   the governor's regime profiles, trained heuristics, optimizer
 *
 * Everything wrote through the same door and the store kept only the value, so
 * the question "who put this here, and may it be overwritten?" had no answer.
 * Three backlog items are the same disease:
 *
 *   item 19  migration widened every live cap to paper values
 *   item 26  a hardcoded prior beat an explicitly set operator threshold
 *   items 3/4/5  the governor rewrites ~20 operator-editable keys per regime
 *                switch, including kellyFraction and minArbGap
 *
 * ## What this module does and does not do
 *
 * It resolves a **read**: given candidate values from several tiers, which one
 * wins and which tier supplied it. That is what item 26 needs, and it makes
 * "why is this threshold what it is?" answerable from the return value instead
 * of by log archaeology.
 *
 * It does **not** yet police writes. Making automation *refuse* to overwrite
 * operator intent changes how the governor behaves — regime adaptation works by
 * writing exactly those keys — and that is a live-behaviour decision, not a
 * refactor. `TIERS` and `compareTiers` are here so the write side can be built
 * on the same ordering when that is agreed.
 *
 * ## Nullish means unset; 0 and false do not
 *
 * The single most important rule here. `minRemainingSec: 0` and
 * `adaptiveSl: false` are real operator choices, and a `||` chain silently
 * discards both. Item 26's own measurement used `minRemainingSec: 0` as the
 * probe value. Every check in this file uses nullish semantics, and there is an
 * invariant pinning it.
 */

/**
 * Authority order. Higher wins.
 *
 * `default` is not a writer — it is the shipped fallback when nobody has an
 * opinion. It sits below automation so a trained value beats a hardcoded prior,
 * which is the whole point of training.
 */
export const TIERS = Object.freeze({
  default: 0,
  automation: 1,
  guardrail: 2,
  operator: 3,
});

export const TIER_NAMES = Object.freeze(
  Object.keys(TIERS).sort((a, b) => TIERS[a] - TIERS[b]),
);

/** Negative if a is weaker than b, positive if stronger, 0 if equal. */
export function compareTiers(a, b) {
  return (TIERS[a] ?? -1) - (TIERS[b] ?? -1);
}

/** A value counts as set unless it is null or undefined. NaN is not a value. */
export function isSet(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number' && Number.isNaN(value)) return false;
  return true;
}

/**
 * Pick the winning candidate from a list of `{ tier, value, source }`.
 *
 * Highest tier with a set value wins. Ties go to the earlier candidate, so
 * callers can order within a tier — e.g. a per-duration operator key ahead of
 * the generic one.
 *
 * Returns the winner plus every candidate that was considered, which is what
 * makes the decision auditable rather than merely correct.
 */
export function resolveTiered(candidates = []) {
  const considered = candidates
    .filter((c) => c && isSet(c.value))
    .map((c) => ({ tier: c.tier || 'default', value: c.value, source: c.source || c.tier || 'unknown' }));

  let winner = null;
  for (const c of considered) {
    if (!winner || compareTiers(c.tier, winner.tier) > 0) winner = c;
  }

  return {
    value: winner ? winner.value : undefined,
    tier: winner ? winner.tier : null,
    source: winner ? winner.source : null,
    considered,
    // True when a weaker tier also had an opinion — i.e. something was
    // overridden. Useful for explaining a threshold to an operator who set it
    // and is wondering why it did not take effect.
    overrode: considered.filter((c) => c !== winner).map((c) => ({ tier: c.tier, source: c.source, value: c.value })),
  };
}

/**
 * `resolveTiered` for a numeric field, coerced once at the end.
 *
 * Coercing per-candidate would turn a non-numeric operator value into NaN and
 * then treat it as set, which is how a typo silently removes a threshold.
 */
export function resolveNumber(candidates = [], fallback = undefined) {
  const hit = resolveTiered(candidates);
  const n = Number(hit.value);
  if (!Number.isFinite(n)) {
    return { ...hit, value: fallback, tier: hit.tier, coerceFailed: isSet(hit.value) };
  }
  return { ...hit, value: n, coerceFailed: false };
}
