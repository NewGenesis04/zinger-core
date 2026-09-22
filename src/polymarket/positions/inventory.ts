// @ts-nocheck
/**
 * May a live exit sell, how much, and is the position a ghost? (item 113)
 *
 * The inputs are three answers to "does the wallet hold this token?", and they
 * are not equally trustworthy:
 *
 *   snapshotShares  `readiness.positions`: up to a minute old, cut to ten rows,
 *                   and `[]` when the fetch failed. A row that is present is
 *                   evidence. A row that is absent is not.
 *   walletShares    a fresh, untruncated read. `null` means the endpoint did
 *                   not answer, and `0` means it answered and nothing is held
 *                   (`arbReconcile.fetchWalletShares`).
 *   ageMs           how long ago the position was opened. A fill the wallet
 *                   feed has not indexed yet also reads as `0`.
 *
 * Only a fresh `0` on a position old enough to have been indexed makes it a
 * ghost, meaning the bot recorded a holding the wallet never had. Every other
 * miss sells the bot's own count and lets the venue decide: a sell of shares
 * that are not there is refused and costs nothing, while not selling shares
 * that are there leaves a stop unexecuted. That fallback is rate-limited,
 * because each attempt is a live order.
 */

export const GHOST_MIN_AGE_MS = 120_000;
export const UNCONFIRMED_EXIT_INTERVAL_MS = 30_000;

/** The snapshot alone, before any fetch. `null` means ask the wallet. */
export function exitSharesFromSnapshot(sellShares, snapshotShares) {
  return snapshotShares > 0
    ? { action: 'sell', shares: Math.min(sellShares, snapshotShares), pmShares: snapshotShares, source: 'snapshot' }
    : null;
}

export function decideExitShares({
  sellShares,
  snapshotShares = 0,
  walletShares = null,
  ageMs = 0,
  msSinceUnconfirmed = Infinity,
  ghostMinAgeMs = GHOST_MIN_AGE_MS,
  retryMs = UNCONFIRMED_EXIT_INTERVAL_MS,
}) {
  const fromSnapshot = exitSharesFromSnapshot(sellShares, snapshotShares);
  if (fromSnapshot) return fromSnapshot;
  if (walletShares > 0) {
    return { action: 'sell', shares: Math.min(sellShares, walletShares), pmShares: walletShares, source: 'wallet' };
  }
  if (walletShares === 0 && ageMs >= ghostMinAgeMs) return { action: 'ghost', pmShares: 0, source: 'wallet' };
  if (msSinceUnconfirmed < retryMs) return { action: 'wait', pmShares: walletShares, source: 'throttled' };
  return { action: 'sell', shares: sellShares, pmShares: walletShares, source: 'unconfirmed' };
}
