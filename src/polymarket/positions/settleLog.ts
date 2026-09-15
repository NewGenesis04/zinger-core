/**
 * How a settlement is PRESENTED in the action log. Display only.
 *
 * Nothing here feeds an exit decision, `exitReason`, window stats, cash or the
 * ledger. It decides one thing: which tone a settle line carries, and therefore
 * whether it raises a red error toast (`PolyDashboard.tsx:2628` toasts every
 * `'sl'`).
 *
 * The defect it fixes: every arb package produced one false stop-loss alert. A
 * pair's legs settle separately, and the leg bought above $0.50 books a per-leg
 * loss that its sibling exactly offsets. Tagged `'sl'`, routine profitable
 * settlement looked like a stop being hit — noise that trains an operator to
 * ignore the alerts that matter.
 *
 * Directional trading shares both log sites, so the scope is deliberately
 * narrow and pinned by tests:
 *
 *   arb leg, pair intact     → 'settle'   per-leg P/L is meaningless
 *   arb leg, pair GONE       → 'tp'/'sl'  a naked leg's loss is real exposure
 *   directional, any outcome → 'tp'/'sl'  exactly as before
 */
import { tradeEngine } from '../audit.js';
import { hedgeIsIntact } from './policy.js';

export function settleLogKind(pos, { packages = null, positions = null } = {}) {
  // Reuses item 74a's definition of "intact" rather than a second one. The
  // settlement order is safe with it: the second leg to settle finds its
  // sibling already closed, but a LOCKED/SETTLED package short-circuits to
  // intact before the sibling check, so both legs of a real pair match.
  if (tradeEngine(pos) === 'arb' && hedgeIsIntact(pos, { packages, positions })) {
    return 'settle';
  }
  return (Number(pos?.pnl) || 0) >= 0 ? 'tp' : 'sl';
}

/**
 * Signed dollars for log text. The inline form it replaces —
 * `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl)}` — signed only gains and then took
 * the absolute value, so a $5.25 LOSS printed as "$5.25".
 */
export function formatSignedUsd(n) {
  const v = Number(n) || 0;
  return `${v < 0 ? '−' : '+'}$${Math.abs(v).toFixed(2)}`;
}
