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

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

/**
 * Item 108. `executeSell` (dashboard sell, Sell All) placed a live sell with no
 * inventory check, and against a redeemed token the venue answered
 * `invalid token id` and the position stayed open for good. It now makes the
 * same check as every other exit, and leaves anything past its window end to
 * the resolution closer.
 */
function checkManualSell(src) {
  const start = src.indexOf('async function executeSell(pos, reason');
  if (start < 0) throw new Error('executeSell not found');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const sellAt = body.indexOf('placeMarketSell(');
  if (sellAt < 0) throw new Error('executeSell no longer sells');
  const guardAt = body.indexOf('Date.now() >= windowEndMs');
  const checkAt = body.indexOf('await resolveExitShares(');
  if (guardAt < 0 || guardAt > sellAt) throw new Error('no window-end guard before the sell');
  if (checkAt < 0 || checkAt > sellAt) throw new Error('no inventory check before the sell');
  if (!/shares: held\.shares,/.test(body.slice(sellAt, sellAt + 200))) throw new Error('the sell is not clamped to what is held');
}

describe('INVARIANT: a manual sell checks the wallet first (item 108)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/polymarket/bot.ts', import.meta.url)), 'utf8');

  it('holds for the real source', () => {
    expect(() => checkManualSell(src)).not.toThrow();
  });

  it('fails without the inventory check, the guard, or the clamp', () => {
    const noCheck = src.replace(
      "const held = await resolveExitShares(pos, positionShares(pos), botState.readiness?.positions || []);",
      "const held = { action: 'sell', shares: positionShares(pos) };",
    );
    expect(noCheck).not.toBe(src);
    expect(() => checkManualSell(noCheck)).toThrow(/inventory check/);
    const noGuard = src.replace('if (windowEndMs != null && Date.now() >= windowEndMs) {', 'if (false) {');
    expect(() => checkManualSell(noGuard)).toThrow(/window-end guard/);
    const noClamp = src.replace(/(placeMarketSell\(\{\s*tokenId: pos\.tokenId,\s*)shares: held\.shares,/, '$1shares: positionShares(pos),');
    expect(noClamp).not.toBe(src);
    expect(() => checkManualSell(noClamp)).toThrow(/clamped/);
  });
});
