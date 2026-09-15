// @ts-nocheck
/**
 * INVARIANT: settlement tone changes for intact arb pairs and NOTHING else
 * (item 88).
 *
 * Every arb package used to raise one false stop-loss alert: a pair's legs
 * settle separately, the leg bought above $0.50 books a per-leg loss its sibling
 * exactly offsets, and that line was tagged `'sl'` — which the dashboard turns
 * into a red error toast.
 *
 * The operator's first question about this fix was whether it would break
 * directional trading, which shares both log sites. That question is the first
 * describe block, stated as a test rather than as a reassurance.
 */
import { describe, it, expect } from 'vitest';
import { settleLogKind, formatSignedUsd } from '../../src/polymarket/positions/settleLog.js';

const directional = (pnl) => ({ id: 'd', engine: 'directional', outcome: 'up', shares: 10, pnl, closed: true });
const arbLeg = (outcome, pnl, over = {}) => ({
  id: `a-${outcome}`, engine: 'arb', isArbLeg: true, packageId: 'pkg-1',
  outcome, shares: 26.88, pnl, closed: true, ...over,
});
const pkg = (status) => ({ packageId: 'pkg-1', status });

describe('INVARIANT: directional settlement is presented exactly as before', () => {
  it('a directional win is still TP and a directional loss is still SL', () => {
    // With or without package context, whatever package list happens to exist.
    for (const ctx of [{}, { packages: [pkg('LOCKED')], positions: [] }, { packages: [pkg('ABORTED')], positions: [] }]) {
      expect(settleLogKind(directional(3.10), ctx)).toBe('tp');
      expect(settleLogKind(directional(-2.40), ctx)).toBe('sl');
      expect(settleLogKind(directional(0), ctx)).toBe('tp');
    }
  });

  it('never gives a directional position the neutral settle tone', () => {
    // The one outcome that would actually hide a real directional loss.
    for (const pnl of [-50, -0.01, 0, 0.01, 50]) {
      expect(settleLogKind(directional(pnl), { packages: [pkg('LOCKED')], positions: [] })).not.toBe('settle');
    }
  });

  it('leaves a position with no engine tag on the old rule', () => {
    // Untagged history classifies as directional in `tradeEngine`.
    expect(settleLogKind({ outcome: 'up', pnl: -1 }, {})).toBe('sl');
  });
});

describe('INVARIANT: an intact pair settles without alarming', () => {
  it('both legs of the logged 2026-09-15 package read as neutral settlement', () => {
    // btc-updown-5m-1789473900: UP +$6.37, DOWN −$5.25, package net +$1.12.
    // Before this fix the DOWN leg raised a red stop-loss toast.
    const up = arbLeg('up', 6.37);
    const down = arbLeg('down', -5.25);
    const ctx = { packages: [pkg('LOCKED')], positions: [up, down] };

    expect(settleLogKind(up, ctx)).toBe('settle');
    expect(settleLogKind(down, ctx)).toBe('settle');
  });

  it('is unaffected by which leg happens to settle first', () => {
    // The second leg to settle sees its sibling already closed. A LOCKED or
    // SETTLED package must still read as intact for it.
    for (const status of ['LOCKED', 'SETTLED', 'MERGED']) {
      const down = arbLeg('down', -5.25);
      const ctx = { packages: [pkg(status)], positions: [arbLeg('up', 6.37, { closed: true }), down] };
      expect(settleLogKind(down, ctx), status).toBe('settle');
    }
  });
});

describe('INVARIANT: a naked leg still alarms', () => {
  it('keeps the SL tone for a loss on a leg whose pair is gone', () => {
    // This is the alert the live watchlist needs. Silencing it would be the
    // expensive mistake — a naked leg's loss is real directional exposure.
    const alone = arbLeg('down', -12.83);
    const ctx = { packages: [pkg('ABORTED')], positions: [alone] };
    expect(settleLogKind(alone, ctx)).toBe('sl');
  });

  it('shows a naked leg that happened to win as TP, not as neutral', () => {
    const alone = arbLeg('up', 3.38);
    const ctx = { packages: [pkg('ABORTED')], positions: [alone] };
    expect(settleLogKind(alone, ctx)).toBe('tp');
  });
});

describe('INVARIANT: a loss is printed as a loss', () => {
  it('signs negative amounts', () => {
    // The old inline form printed a −$5.25 loss as "$5.25".
    expect(formatSignedUsd(-5.25)).toBe('−$5.25');
    expect(formatSignedUsd(6.37)).toBe('+$6.37');
    expect(formatSignedUsd(0)).toBe('+$0.00');
  });

  it('never prints a negative number without a minus sign', () => {
    for (const n of [-0.01, -1, -5.25, -1234.5]) {
      expect(formatSignedUsd(n).startsWith('−')).toBe(true);
    }
  });

  it('survives junk input', () => {
    expect(formatSignedUsd(undefined)).toBe('+$0.00');
    expect(formatSignedUsd(null)).toBe('+$0.00');
    expect(formatSignedUsd('nope')).toBe('+$0.00');
  });
});
