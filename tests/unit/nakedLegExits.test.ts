// @ts-nocheck
/**
 * INVARIANT: the exemption from risk exits belongs to a hedge, not to a label
 * (item 74a).
 *
 * `holdsToSettlement` exempts arb legs from every mid-window exit — stop-loss,
 * trailing, drawdown close. That is correct for a real pair: it redeems to
 * exactly $1.00 at settlement, so closing early forfeits the edge for nothing.
 *
 * The property belongs to the PAIR. Before this fix the exemption keyed on
 * structural markers (`packageId`, `isArbLeg`, `arb`) — and those markers
 * SURVIVE the abort. So a leg whose sibling never filled kept the exemption and
 * rode to settlement with no stop of any kind: the single position that most
 * needed managing was the one guaranteed not to be. That is the 2026-08-28
 * −$12.83 loss, where 26.33 DOWN shares sat naked and expired at zero.
 *
 * The second group below is the harder half. Every "cannot tell" must still
 * return exempt, because the opposite error is worse: closing one side of an
 * intact pair MANUFACTURES the naked leg this item exists to prevent. The
 * exemption is withdrawn only on positive evidence.
 */
import { describe, it, expect } from 'vitest';
import { holdsToSettlement, hedgeIsIntact } from '../../src/polymarket/positions/policy.js';

const leg = (outcome, over = {}) => ({
  id: `p-${outcome}`,
  packageId: 'pkg-1',
  isArbLeg: true,
  engine: 'arb',
  outcome,
  shares: 26.33,
  closed: false,
  mode: 'live',
  ...over,
});

const pkg = (status) => ({ packageId: 'pkg-1', status });

describe('INVARIANT: a naked leg is exit-managed', () => {
  it('withdraws the exemption when the package aborted and no sibling survives', () => {
    // The 2026-08-28 shape exactly: one leg held, sibling killed, package
    // aborted, markers intact.
    const up = leg('up');
    const ctx = { packages: [pkg('ABORTED')], positions: [up] };

    expect(holdsToSettlement(up, ctx)).toBe(false);
    expect(hedgeIsIntact(up, ctx)).toBe(false);
  });

  it('still exempts it when the sibling is alive despite the abort', () => {
    // A package can abort with both legs held — the parity-breach path does
    // exactly that. Force-closing a real pair is the expensive error.
    const up = leg('up');
    const down = leg('down');
    const ctx = { packages: [pkg('ABORTED')], positions: [up, down] };

    expect(holdsToSettlement(up, ctx)).toBe(true);
  });

  it('does not count a closed or empty sibling as a hedge', () => {
    const up = leg('up');
    for (const dead of [leg('down', { closed: true }), leg('down', { shares: 0 })]) {
      const ctx = { packages: [pkg('ABORTED')], positions: [up, dead] };
      expect(holdsToSettlement(up, ctx)).toBe(false);
    }
  });

  it('does not mistake a leg on another package for the sibling', () => {
    const up = leg('up');
    const stranger = leg('down', { packageId: 'pkg-2' });
    const ctx = { packages: [pkg('ABORTED')], positions: [up, stranger] };

    expect(holdsToSettlement(up, ctx)).toBe(false);
  });

  it('does not accept a same-side position as its own hedge', () => {
    // Two UP legs are not a pair. Only the complement redeems the set to $1.00.
    const up = leg('up');
    const alsoUp = leg('up', { id: 'p-up-2' });
    const ctx = { packages: [pkg('ABORTED')], positions: [up, alsoUp] };

    expect(holdsToSettlement(up, ctx)).toBe(false);
  });
});

describe('INVARIANT: an intact pair is never exposed to a mid-window exit', () => {
  it('exempts every non-aborted package status', () => {
    // LOCKED/SETTLED/MERGED are intact by definition; PENDING_FILL is still in
    // flight and must not be touched mid-dispatch.
    for (const status of ['LOCKED', 'SETTLED', 'MERGED', 'PENDING_FILL']) {
      const up = leg('up');
      expect(holdsToSettlement(up, { packages: [pkg(status)], positions: [up] }), status).toBe(true);
    }
  });

  it('stays exempt when the package record cannot be found', () => {
    // Cannot disprove the hedge, so do not act on a guess. Closing one side of
    // a pair manufactures the naked leg this whole item is about.
    const up = leg('up');
    expect(holdsToSettlement(up, { packages: [], positions: [up] })).toBe(true);
    expect(holdsToSettlement(up, { packages: [pkg('ABORTED')], positions: null })).toBe(true);
  });

  it('preserves the old behaviour when no context is supplied', () => {
    // Call sites asking "is this engine exit-managed" rather than "may this
    // position be closed now" must not change meaning.
    expect(holdsToSettlement(leg('up'))).toBe(true);
    expect(holdsToSettlement({ isArbLeg: true })).toBe(true);
    expect(holdsToSettlement({ packageId: 'pkg-9' })).toBe(true);
  });

  it('leaves directional positions exactly where they were', () => {
    const directional = { id: 'd1', engine: 'directional', outcome: 'up', shares: 10, closed: false };
    const ctx = { packages: [pkg('ABORTED')], positions: [directional] };
    expect(holdsToSettlement(directional, ctx)).toBe(false);
  });

  it('keeps a marker-only leg exempt when it has no package key to check', () => {
    // `isArbLeg` with no packageId cannot be checked against anything.
    const orphanMarker = { id: 'x', isArbLeg: true, outcome: 'up', shares: 5, closed: false };
    const ctx = { packages: [pkg('ABORTED')], positions: [orphanMarker] };
    expect(holdsToSettlement(orphanMarker, ctx)).toBe(true);
  });
});
