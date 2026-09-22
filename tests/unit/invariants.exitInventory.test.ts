// @ts-nocheck
/**
 * INVARIANTS: a live exit only writes a position off as a ghost when the wallet
 * has positively said it holds nothing (item 113).
 *
 * The snapshot the exit paths read (`readiness.positions`) is `[]` when its
 * fetch fails, cut to ten rows, and up to a minute old. Before this, a missing
 * row sent the position to `reconcileLiveGhostPosition`, which closes it with
 * no sell and no trade, while the tokens stayed in the wallet unmanaged.
 *
 * The property: `ghost` requires a fresh answer of zero on a position old
 * enough to have been indexed. Every other miss sells, because a refused sell
 * costs nothing and a skipped one leaves a stop unexecuted.
 */
import { describe, it, expect } from 'vitest';
import {
  decideExitShares,
  GHOST_MIN_AGE_MS,
  UNCONFIRMED_EXIT_INTERVAL_MS,
} from '../../src/polymarket/positions/inventory.js';

const OLD = GHOST_MIN_AGE_MS + 1;
const NEW = 5_000;

describe('INVARIANT: only a fresh zero on an indexed position is a ghost', () => {
  it('writes off nothing on a missing snapshot row alone', () => {
    // The pre-113 behaviour: snapshot empty, so reconciled away. For every
    // wallet answer other than a fresh zero on an old position, not a ghost.
    for (const walletShares of [null, 3, 0]) {
      for (const ageMs of [NEW, OLD]) {
        const d = decideExitShares({ sellShares: 5, snapshotShares: 0, walletShares, ageMs });
        const ghost = walletShares === 0 && ageMs === OLD;
        expect(d.action === 'ghost', `wallet=${walletShares} age=${ageMs}`).toBe(ghost);
      }
    }
  });

  it('sells when the wallet does not answer, and lets the venue decide', () => {
    const d = decideExitShares({ sellShares: 5, snapshotShares: 0, walletShares: null, ageMs: OLD });
    expect(d).toMatchObject({ action: 'sell', shares: 5, source: 'unconfirmed' });
  });

  it('sells, rather than writing off, a fill the wallet has not indexed yet', () => {
    const d = decideExitShares({ sellShares: 5, snapshotShares: 0, walletShares: 0, ageMs: NEW });
    expect(d).toMatchObject({ action: 'sell', shares: 5, source: 'unconfirmed' });
  });

  it('rate-limits the unconfirmed sell, since each attempt is a live order', () => {
    const d = decideExitShares({
      sellShares: 5, snapshotShares: 0, walletShares: null, ageMs: OLD,
      msSinceUnconfirmed: UNCONFIRMED_EXIT_INTERVAL_MS - 1,
    });
    expect(d.action).toBe('wait');
  });
});

describe('INVARIANT: a sell is clamped to what the wallet is known to hold', () => {
  it('trusts a snapshot row that is present', () => {
    expect(decideExitShares({ sellShares: 5, snapshotShares: 3 })).toMatchObject({ action: 'sell', shares: 3, source: 'snapshot' });
    expect(decideExitShares({ sellShares: 2, snapshotShares: 3 })).toMatchObject({ action: 'sell', shares: 2 });
  });

  it('falls through to the fresh wallet read when the row is missing', () => {
    expect(decideExitShares({ sellShares: 5, snapshotShares: 0, walletShares: 4, ageMs: OLD }))
      .toMatchObject({ action: 'sell', shares: 4, source: 'wallet' });
  });

  it('never sells more than the bot recorded', () => {
    for (const snapshotShares of [0, 1, 10]) {
      for (const walletShares of [null, 0, 1, 10]) {
        const d = decideExitShares({ sellShares: 5, snapshotShares, walletShares, ageMs: OLD });
        if (d.action === 'sell') expect(d.shares).toBeLessThanOrEqual(5);
      }
    }
  });
});
