/**
 * The brake — a rolling 24-hour realised-loss cap (backlog item 74b).
 *
 * WHO OWNS THIS: this module owns the answer to "may the bot open anything new
 * right now". Nothing else in the process could answer it before, which is the
 * whole finding. `grep -riE 'maxDailyLoss|lossLimit|circuitBreak|killSwitch'`
 * across `src/` returned nothing.
 *
 * THREE THINGS LOOKED LIKE BRAKES AND NONE WERE:
 *
 *   1. `maxArbPackages` caps CONCURRENT packages, not attempts. An aborted
 *      package frees its slot immediately (`arbEngine.ts:139-145`), so a
 *      systematic defect can fail → unwind → retry every window, all night.
 *   2. The governor's drawdown breaker forces the `arb-only` profile
 *      (`governor.ts:390`). If arb is what is losing, the safety mechanism aims
 *      the bot harder at it.
 *   3. The portfolio drawdown breaker measures UNREALISED loss on OPEN
 *      positions (`bot.ts:2782-2799`). A loop that opens, aborts, unwinds and
 *      eats the spread realises its loss and closes the position — so nothing
 *      accumulates where that breaker is looking, and it reads 0% the whole way
 *      down.
 *
 * DERIVED, NOT COUNTED. The cap reads closed trades rather than incrementing a
 * running total. A separate counter is a second source of truth that drifts
 * from the ledger the moment anything is replayed, deduped or reconciled — and
 * this one would drift silently, in the direction of not firing. Deriving also
 * makes it restart-proof for free: the trades outlive the process, so the
 * window survives a crash-loop that would reset any in-memory tally.
 *
 * WHAT PERSISTS IS THE RESET, NOT THE TALLY. `resetLossCap()` stamps a marker
 * in `zinger.db`; the window is then `max(now - 24h, resetAt)`. An operator
 * clearing the brake is a deliberate act that has to survive a restart, whereas
 * the loss figure should always be recomputable from the ledger.
 */
import { tradeNetPnl, tradeEngine } from './audit.js';
import { sqliteLoad, sqlitePersistSync } from './sqliteStore.js';

export const LOSS_WINDOW_MS = 24 * 60 * 60 * 1000;

const RESET_KEY = 'loss_cap_reset';

/** Close time. `timestamp` is stamped by every `saveTrade` call on exit. */
function closedAt(trade) {
  return Number(trade?.timestamp ?? trade?.exitTime ?? trade?.closedAt ?? trade?.entryTime ?? 0) || 0;
}

export function readResetAt(mode) {
  try {
    const doc = sqliteLoad(RESET_KEY) || {};
    return Number(doc?.[mode]) || 0;
  } catch {
    return 0;
  }
}

export function writeResetAt(mode, ts) {
  try {
    const doc = sqliteLoad(RESET_KEY) || {};
    sqlitePersistSync(RESET_KEY, { ...doc, [mode]: Number(ts) || 0 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Realised P&L over the live window, and whether that trips the cap.
 *
 * Pure apart from the reset lookup, which is injectable — the whole point of a
 * brake is that its behaviour is testable without a database or a live account.
 *
 * `capUsd <= 0` disables the cap. That is deliberate rather than an oversight:
 * paper mode ships with it off, because a paper run exists precisely to
 * discover how bad a defect gets, and a brake there would truncate the evidence.
 */
export function lossCapStatus({
  trades = [],
  mode = 'live',
  capUsd = 0,
  now = Date.now(),
  resetAt = null,
}) {
  const cap = Number(capUsd) || 0;
  const reset = resetAt == null ? readResetAt(mode) : Number(resetAt) || 0;
  const windowStart = Math.max(now - LOSS_WINDOW_MS, reset);

  let realised = 0;
  let worst = { arb: 0, directional: 0 };
  let counted = 0;
  for (const t of trades) {
    if (!t || t.mode !== mode) continue;
    const at = closedAt(t);
    if (!(at >= windowStart) || at > now) continue;
    const pnl = tradeNetPnl(t);
    if (!Number.isFinite(pnl)) continue;
    realised += pnl;
    counted++;
    const engine = tradeEngine(t);
    if (engine === 'arb' || engine === 'directional') worst[engine] += pnl;
  }

  realised = Math.round(realised * 100) / 100;
  const lossUsd = realised < 0 ? -realised : 0;
  const tripped = cap > 0 && lossUsd >= cap;

  return {
    mode,
    capUsd: cap,
    enabled: cap > 0,
    windowStart,
    resetAt: reset,
    realisedUsd: realised,
    lossUsd,
    remainingUsd: cap > 0 ? Math.round(Math.max(0, cap - lossUsd) * 100) / 100 : null,
    tradesCounted: counted,
    byEngine: {
      arb: Math.round(worst.arb * 100) / 100,
      directional: Math.round(worst.directional * 100) / 100,
    },
    // Which engine did the damage, so an operator reading the alert knows where
    // to look without opening the ledger. Null when nothing is losing.
    worstEngine: worst.arb < 0 || worst.directional < 0
      ? (worst.arb <= worst.directional ? 'arb' : 'directional')
      : null,
    tripped,
  };
}

/**
 * Clear the brake. Returns the state that was tripped, so the operator action
 * and the thing it dismissed are recorded together rather than the reason
 * vanishing at the moment somebody overrides it.
 */
export function resetLossCap({ trades = [], mode = 'live', capUsd = 0, now = Date.now() } = {}) {
  const before = lossCapStatus({ trades, mode, capUsd, now });
  writeResetAt(mode, now);
  return { ok: true, cleared: before, resetAt: now };
}
