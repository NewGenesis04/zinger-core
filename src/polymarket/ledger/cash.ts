// @ts-nocheck
/**
 * Paper cash — one owner (D5).
 *
 * D5 says the two engines share a single cash pool. Before this module, three
 * places computed cash and two decided when to write it:
 *
 *   paperBooksCash()       derive from the books        bot.ts:315
 *   reconcilePaperCash()   recompute and overwrite      bot.ts:327
 *   adjustPaperCash()      move it incrementally        bot.ts:339
 *   repairPaperOverdraft() a third copy of the formula  bot.ts:424 (item 23)
 *
 * Item 23 collapsed the *formula* to one place. It left the *writers* split,
 * which is the half that matters: `reconcile` recomputes from scratch and
 * overwrites, so whenever the two disagree reconcile wins silently. That is
 * exactly how the fee-refund bug hid — the incremental ledger charged fees
 * correctly, the derivation omitted them, and every reconcile handed them back.
 * Measured on production before the fix: $100.70 → $102.66, a phantom gain
 * equal to fees paid.
 *
 * So the shape here is deliberate: the arithmetic is pure and exported for
 * tests, and there is exactly one function that assigns to the balance
 * (`commit`). `adjust` and `reconcile` are both routed through it. A future
 * third caller cannot invent a fourth way to move cash without going through
 * the same door.
 *
 * ## The invariant
 *
 *   cash = initialDeposit
 *        + Σ net realized P/L over closed trades      (gross − entry fee − exit fee)
 *        − Σ (cost basis + entry fee) over open positions
 *
 * Both fee terms are load-bearing. An open position's entry fee left the
 * account alongside the premium, so it is part of what that position has tied
 * up — not a cost still to come.
 *
 * Realized P/L is recomputed from primitives via `tradeNetPnl` rather than read
 * from `trade.pnl`, because records written before the fee fix carry a *gross*
 * `pnl` and nothing marks them as such. Recomputing makes the ledger correct
 * over existing history with no migration.
 */

import { dedupeTrades, tradeNetPnl } from '../audit.js';
import { getDefaultPaperBankroll } from '../modeConfig.js';

/** Money precision — cents. The protocol's 5dp applies to fees, not balances. */
export function roundCash(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Cash implied by the books. Pure — no module state, no clock, no store.
 *
 * `mode` filters both trades and positions. Passing trades from one mode and
 * positions from another would silently mix two accounts, so the filter lives
 * here rather than at the call site.
 */
export function booksCash({ trades = [], positions = [], initialDeposit = 100, mode = 'paper' } = {}) {
  const initial = Number(initialDeposit);
  const base = Number.isFinite(initial) ? initial : getDefaultPaperBankroll();

  const realized = dedupeTrades(trades)
    .filter((t) => !mode || t.mode === mode)
    .reduce((sum, t) => sum + tradeNetPnl(t), 0);

  const openCost = positions
    .filter((p) => !p.closed && (!mode || p.mode === mode))
    .reduce(
      (sum, p) => sum + Number(p.costBasis || p.size || 0) + Number(p.entryFee || 0),
      0,
    );

  return roundCash(base + realized - openCost);
}

/** Drift below this is noise from cent-rounding, not a real disagreement. */
export const RECONCILE_EPSILON = 0.01;

/**
 * The paper cash ledger. `deps` binds it to a store without this module
 * importing one:
 *
 *   readBalance()      current spendable cash, or null/undefined if unset
 *   readInitial()      the opening deposit
 *   readBooks()        { trades, positions } as they stand now
 *   writeBalance(n)    persist — the ONLY side effect this module performs
 *   isPaper()          false short-circuits everything (live cash is on-chain)
 *   log(msg, level)    optional
 */
export function createPaperCashLedger(deps = {}) {
  const {
    readBalance,
    readInitial,
    readBooks,
    writeBalance,
    isPaper = () => true,
    log = null,
  } = deps;

  const note = (msg) => { if (typeof log === 'function') log(msg, 'system'); };

  const initialDeposit = () => {
    const n = Number(readInitial?.());
    return Number.isFinite(n) ? n : 100;
  };

  /**
   * Current balance, falling back to the opening deposit.
   *
   * The fallback matters: the old `reconcilePaperCash` read
   * `botState.config.paperBankroll ?? initial` where `initial` was a free
   * variable declared inside a *different* function (bot.ts:316 vs :330).
   * `??` short-circuits, and `resolveActiveConfig` (modeConfig.ts:250) always
   * seeds a numeric balance, so the right-hand side never evaluated and the
   * ReferenceError never fired. `bot.ts` carries `@ts-nocheck`, so nothing
   * flagged it. It was one nullish balance away from throwing inside
   * `startBot`.
   */
  const balance = () => {
    const raw = readBalance?.();
    const n = Number(raw ?? initialDeposit());
    return Number.isFinite(n) ? n : initialDeposit();
  };

  /** The single assignment point. Everything that moves cash comes through here. */
  const commit = (next, message) => {
    const value = roundCash(next);
    writeBalance(value);
    if (message) note(message);
    return value;
  };

  return {
    balance,

    /** Cash the books imply right now, without writing anything. */
    books() {
      const { trades = [], positions = [] } = readBooks?.() || {};
      return booksCash({ trades, positions, initialDeposit: initialDeposit(), mode: 'paper' });
    },

    /** Move cash by `delta`. Returns the new balance, or null outside paper. */
    adjust(delta, reason = '') {
      if (!isPaper()) return null;
      const d = Number(delta || 0);
      const next = balance() + d;
      const message = reason
        ? `💵 PAPER CASH ${d >= 0 ? '+' : ''}${d.toFixed(2)} → $${roundCash(next).toFixed(2)} · ${reason}`
        : '';
      return commit(next, message);
    },

    /**
     * Rebuild the balance from the books, but only if it actually disagrees.
     *
     * The epsilon guard is not cosmetic. Without it every call rewrites config
     * and emits a log line, which is what turns a reconciliation into a noise
     * source — and a noisy reconcile is one nobody reads when it finally
     * reports something real.
     */
    reconcile(reason = 'reconcile') {
      if (!isPaper()) return null;
      const prev = balance();
      const next = this.books();
      if (Math.abs(prev - next) < RECONCILE_EPSILON) return prev;
      return commit(
        next,
        `💵 PAPER CASH reconcile $${prev.toFixed(2)} → $${next.toFixed(2)} · ${reason}`,
      );
    },
  };
}
