// @ts-nocheck
/**
 * INVARIANT: a live hedged leg is never market-sold at window end (item 114).
 *
 * The per-market loop's settle branch sells a position when its window has
 * ended, or in the last 8s when the bid is at an extreme. It used to run
 * *before* the hold-to-settle exemption, so an intact live pair could be sold
 * at roughly 0.98 + 0.01 less two taker fees, instead of redeemed fee-free for
 * exactly $1.00 (domain facts §2, §3). Item 113's fix widened its reach: a leg
 * whose snapshot row was missing used to be written off, and is now found in
 * the wallet and sold.
 *
 * `bot.ts` cannot be imported here (see invariants.scanWiring), so the wiring
 * is checked against source, with a checker that is itself run on broken
 * sources to prove it can fail.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { skipsWindowEndSale } from '../../src/polymarket/positions/policy.js';

const leg = (over = {}) => ({
  mode: 'live', engine: 'arb', isArbLeg: true, packageId: 'pkg-1', outcome: 'up', shares: 4.5, closed: false, ...over,
});
const sibling = (over = {}) => leg({ outcome: 'down', ...over });

describe('INVARIANT: only a live, intact hedge leg skips the window-end sale', () => {
  it('skips a live leg of a LOCKED package', () => {
    const ctx = { packages: [{ packageId: 'pkg-1', status: 'LOCKED' }], positions: [leg(), sibling()] };
    expect(skipsWindowEndSale(leg(), ctx)).toBe(true);
  });

  it('does not change paper, whose window-end close is its settlement model', () => {
    const ctx = { packages: [{ packageId: 'pkg-1', status: 'LOCKED' }], positions: [leg(), sibling()] };
    expect(skipsWindowEndSale(leg({ mode: 'paper' }), ctx)).toBe(false);
  });

  it('keeps a naked live leg exit-managed', () => {
    const ctx = { packages: [{ packageId: 'pkg-1', status: 'ABORTED' }], positions: [leg()] };
    expect(skipsWindowEndSale(leg(), ctx)).toBe(false);
  });

  it('keeps a live directional position exit-managed', () => {
    const pos = { mode: 'live', engine: 'directional', outcome: 'up', shares: 5, closed: false };
    expect(skipsWindowEndSale(pos, { packages: [], positions: [pos] })).toBe(false);
  });
});

const SETTLE_MARKER = 'Force settle only when THIS market window is done';

/** Throws unless the skip is checked, and acted on, before the window-end sale. */
function checkWindowEndWiring(src: string): void {
  const settleAt = src.indexOf(SETTLE_MARKER);
  if (settleAt < 0) throw new Error('window-end settle branch not found');
  const loopAt = src.lastIndexOf('const win = marketWindow(market);', settleAt);
  if (loopAt < 0) throw new Error('window computation not found before the settle branch');
  const between = src.slice(loopAt, settleAt);
  if (!/if \(skipsWindowEndSale\(pos,[^\n]*\)\) \{\s*continue;\s*\}/.test(between)) {
    throw new Error('skipsWindowEndSale is not checked, and continued on, before the window-end sale');
  }
}

describe('INVARIANT: bot.ts checks the skip before it sells', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/polymarket/bot.ts', import.meta.url)), 'utf8');

  it('holds for the real source', () => {
    expect(() => checkWindowEndWiring(src)).not.toThrow();
  });

  it('fails when the check is removed', () => {
    const broken = src.replace(/if \(skipsWindowEndSale\(pos,[^\n]*\)\) \{\s*continue;\s*\}/, '');
    expect(broken).not.toBe(src);
    expect(() => checkWindowEndWiring(broken)).toThrow(/not checked/);
  });

  it('fails when the check sits after the sale', () => {
    const call = src.match(/if \(skipsWindowEndSale\(pos,[^\n]*\)\) \{\s*continue;\s*\}/)[0];
    const moved = src.replace(call, '').replace(SETTLE_MARKER, `${SETTLE_MARKER}\n${call}`);
    expect(() => checkWindowEndWiring(moved)).toThrow(/not checked/);
  });

  it('fails when the check does not continue', () => {
    const broken = src.replace(/(if \(skipsWindowEndSale\(pos,[^\n]*\)\) \{)\s*continue;/, '$1');
    expect(() => checkWindowEndWiring(broken)).toThrow(/not checked/);
  });
});
