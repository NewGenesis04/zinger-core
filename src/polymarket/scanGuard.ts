// @ts-nocheck
/**
 * Scan-pass ownership: the watchdog and the stale-pass guard.
 *
 * WHO OWNS THIS: `scan()` owns "is a pass running". This module owns "WHICH
 * pass, and is it still the current one" — the part the lock flag alone cannot
 * express.
 *
 * THE PROBLEM. One pass runs at a time, enforced by a flag raised at the start
 * and lowered in a `finally`. A `finally` only runs when the pass settles, so an
 * await that never settles holds the flag for the life of the process and every
 * later tick returns immediately. The loop stops without stopping.
 *
 * THE RESPONSE, IN TWO HALVES, because releasing the flag is not enough:
 *
 *   1. WATCHDOG — after `stallMs`, a later tick declares the holding pass
 *      abandoned, releases the flag and starts a fresh pass.
 *   2. GUARD — the abandoned pass is NOT cancelled; nothing can cancel a pending
 *      promise. It is still sitting inside an await and may wake at any time,
 *      holding prices and balances from before the stall. So each pass runs
 *      inside an `AsyncLocalStorage` context carrying its generation number, and
 *      anything that moves money asks `isStalePass()` first. A woken zombie sees
 *      its generation is no longer current and refuses.
 *
 * Without (2), (1) is worse than the freeze: two passes running at once on the
 * order path is exactly what the flag exists to prevent.
 *
 * The context propagates across awaits, so a pass deep inside the arb engine is
 * still identifiable without threading a parameter through every call. Work with
 * no context — an operator approving a trade by hand, a timer — has no store and
 * is never treated as stale.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** How long a pass may hold the loop before a later tick abandons it. */
export const SCAN_STALL_MS = Number(process.env.ZINGER_SCAN_STALL_MS) || 30_000;

const passContext = new AsyncLocalStorage();

let _generation = 0;
let _stalls = 0;
let _passStartedAt = 0;
let _lastProgressAt = 0;

/** The generation of the pass that currently owns the loop. */
export function currentGeneration() {
  return _generation;
}

export function scanStallCount() {
  return _stalls;
}

/**
 * Should a tick take the loop away from the pass holding it?
 *
 * Measures time since the pass last made PROGRESS, not since it started. A pass
 * covers every tradable market, and each market's calls are individually bounded
 * (reads 10s) — so on a degraded network a perfectly healthy pass can run far
 * past any fixed total budget. Judging it on total duration would abandon
 * working passes exactly during a network wobble, and the replacement pass would
 * meet the same slow network and be abandoned in turn.
 *
 * Progress is therefore the signal: slow is fine, stopped is not. A pass that is
 * genuinely stuck is still caught within `stallMs` of the moment it stopped,
 * however long it had been running beforehand.
 *
 * Pure, so the policy is testable without a running bot. A start time of 0 or
 * null means "holding but never stamped" — treated as not yet stalled rather
 * than instantly abandoned, because a missing timestamp is not evidence of age.
 */
export function shouldAbandonPass({
  scanning, startedAt, lastProgressAt = 0, now = Date.now(), stallMs = SCAN_STALL_MS,
}) {
  if (!scanning) return false;
  const since = Math.max(Number(startedAt) || 0, Number(lastProgressAt) || 0);
  if (!(since > 0)) return false;
  return now - since >= Number(stallMs);
}

/** Take ownership for a new pass. Any earlier pass is stale from this moment. */
export function beginPass(now = Date.now()) {
  _generation += 1;
  _passStartedAt = now;
  _lastProgressAt = 0;
  return _generation;
}

/**
 * Mark that the current pass got something done — one market handled, one phase
 * finished. Cheap enough to call often, and the watchdog reads nothing else.
 *
 * A pass the watchdog already abandoned cannot stamp progress. It may wake at any
 * time, and letting it do so would hold the watchdog off the pass that replaced
 * it — a stuck live pass kept alive on a zombie's heartbeat.
 */
export function notePassProgress(now = Date.now()) {
  if (isStalePass()) return false;
  _lastProgressAt = now;
  return true;
}

/** When the current pass started, and when it last got something done. */
export function passTimings() {
  return { startedAt: _passStartedAt, lastProgressAt: _lastProgressAt };
}

/** Has the pass holding the loop stopped making progress? */
export function shouldAbandonCurrentPass(scanning, now = Date.now(), stallMs = SCAN_STALL_MS) {
  return shouldAbandonPass({
    scanning, startedAt: _passStartedAt, lastProgressAt: _lastProgressAt, now, stallMs,
  });
}

/** Record that a pass was taken away from its owner (telemetry only). */
export function recordStall() {
  _stalls += 1;
  return _stalls;
}

/** Run `fn` as the pass identified by `gen`. */
export function runAsPass(gen, fn) {
  return passContext.run({ gen }, fn);
}

/**
 * Is the caller running inside a pass that has since been abandoned?
 *
 * `false` when there is no pass context at all: a manual approval or a timer is
 * not a scan pass and must not be blocked by this.
 */
export function isStalePass() {
  const store = passContext.getStore();
  if (!store) return false;
  return store.gen !== _generation;
}

/** The generation of the calling pass, or null outside one. */
export function callingGeneration() {
  return passContext.getStore()?.gen ?? null;
}

/**
 * Does this pass still own the loop, and may it therefore lower the flag?
 *
 * A pass taken away by the watchdog must NOT clear `_scanning` when it finally
 * finishes — a newer pass owns it by then, and clearing it would let a third
 * pass start alongside that one.
 */
export function ownsLoop(gen) {
  return gen === _generation;
}

/** Test seam. */
export function __resetScanGuard() {
  _generation = 0;
  _stalls = 0;
  _passStartedAt = 0;
  _lastProgressAt = 0;
}
