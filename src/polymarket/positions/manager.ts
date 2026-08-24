// @ts-nocheck
/**
 * Position queries — one owner for "what is open right now" (D4).
 *
 * Every function here is pure: it takes the state it reads as an argument and
 * touches no module-level anything. `bot.ts` holds the array; this module holds
 * the questions asked of it. That split is what lets the answers be tested
 * against fixtures instead of against whatever happens to be in `data/`.
 *
 * ## Scope, honestly
 *
 * The plan's target for `positions/manager.ts` is *lifecycle* — open, close,
 * mark, settle. This is the query half. Mutation still lives in `bot.ts`
 * (`botState.positions.push` at :954, the two mode-wide resets at :3663/:3723),
 * and settlement valuation is slice 3 with item 8. So the honest description
 * today is: **this module owns every read; bot.ts still owns the writes.**
 *
 * That is a real seam, not a cosmetic one — the reads are where the strategy
 * conditionals lived, and they are what the directional engine's `portfolioView`
 * depends on. But do not read the file name as a promise that lifecycle has
 * moved. It has not yet.
 */

import { dedupeTrades } from '../audit.js';
import { holdsToSettlement, policyFor } from './policy.js';

/**
 * Open positions, optionally narrowed to one mode and/or one engine.
 *
 * Omitting `engine` returns every engine's positions — correct for reporting,
 * wrong for a capacity gate. See `countOpen`.
 */
export function openPositions(positions = [], { mode = null, engine = null } = {}) {
  return positions.filter((p) => (
    !p.closed
    && (!mode || p.mode === mode)
    && (!engine || policyFor(p).engine === engine)
  ));
}

/**
 * How many positions an engine has open (D5).
 *
 * `engine` omitted counts all of them, which is a reporting number, not a
 * capacity number. The two dials are independent by decision:
 *
 *   directional   maxOpenPositions   risk dial: slots x size x SL%
 *   arb           maxArbPackages     2 positions per package, hold-to-settle
 *
 * They were cross-wired: `maxOpenPositions` counted arb legs, so a hedged pair
 * consumed two directional slots and the settings contradicted each other
 * outright — the VPS runs `maxArbPackages` 40 (authorising 80 legs) against
 * `maxOpenPositions` 4. Arb was capped at two packages regardless of its own
 * setting, and the boot-time trim closed arb legs to satisfy a limit that was
 * never meant to govern them.
 */
export function countOpen(positions = [], { mode = null, engine = null } = {}) {
  return openPositions(positions, { mode, engine }).length;
}

/**
 * Open positions that mid-window exit logic may act on.
 *
 * The filter is the policy predicate, not an engine name — so a new engine gets
 * the right treatment by declaring a policy rather than by being added to a
 * condition in five places (D4).
 */
export function exitManagedPositions(positions = [], { mode = null } = {}) {
  return openPositions(positions, { mode }).filter((p) => !holdsToSettlement(p));
}

/**
 * Is this slug already taken?
 *
 * Spans three pieces of state, not one: a filled position, a pending trade
 * awaiting approval, and an in-flight buy lock all occupy the slug. Counting
 * only positions is what allows a double-open in the gap between dispatch and
 * fill, so all three are required arguments rather than optional extras.
 *
 * `maxConcurrentPerSlug === 0` returns true — that is "none allowed", i.e.
 * always occupied. Zero as a disable-everything sentinel is surprising, but it
 * is the shipped meaning and callers depend on it.
 */
export function isSlugOccupied({
  positions = [],
  pendingTrades = [],
  buyLocks = null,
  slug,
  cfg = {},
} = {}) {
  if (cfg.maxConcurrentPerSlug === 0) return true;
  const maxConcurrent = cfg.maxConcurrentPerSlug || 1;

  const openCount = positions.filter((p) => !p.closed && p.slug === slug).length;
  if (openCount >= maxConcurrent) return true;

  const pendingCount = pendingTrades.filter((p) => p.slug === slug && p.status === 'pending').length;
  if (openCount + pendingCount >= maxConcurrent) return true;

  return buyLocks ? buyLocks.has(slug) : false;
}

/**
 * Recent outcome mix, used to break a chronic one-sided bias.
 *
 * Open positions count double: an open UP is a live commitment to that side,
 * while a closed one is history. The weighting is the shipped behaviour.
 */
export function sideBalance({ positions = [], trades = [], mode = 'paper' } = {}) {
  const recent = dedupeTrades(trades)
    .filter((t) => t.mode === mode)
    .slice(0, 50);
  const open = openPositions(positions, { mode });

  let up = 0;
  let down = 0;
  for (const t of recent) {
    if (t.outcome === 'up') up += 1;
    else if (t.outcome === 'down') down += 1;
  }
  for (const p of open) {
    if (p.outcome === 'up') up += 2;
    else if (p.outcome === 'down') down += 2;
  }

  const total = up + down;
  return { up, down, total, upShare: total > 0 ? up / total : 0.5 };
}

/**
 * The slice of portfolio state the directional engine's entry gate depends on.
 *
 * The engine is a pure function (`engines/directional.ts`) that deliberately
 * cannot see `botState`. This is the translation layer — and it lives here
 * rather than in `bot.ts` because these are position questions, which is what
 * D4 says this module owns.
 */
export function portfolioView({
  slug,
  cfg = {},
  positions = [],
  trades = [],
  pendingTrades = [],
  buyLocks = null,
  dataAssurance = null,
} = {}) {
  return {
    hasOpenOnSlug: isSlugOccupied({ positions, pendingTrades, buyLocks, slug, cfg }),
    sideBalance: sideBalance({ positions, trades, mode: cfg.mode || 'paper' }),
    dataAssurance,
  };
}
