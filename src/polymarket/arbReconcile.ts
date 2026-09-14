/**
 * Did the leg fill? — the dual-door reconciler (backlog item 80).
 *
 * WHO OWNS THIS: `executePendingTrade` owns the answer to "did this arb leg
 * fill". The rule this module exists to enforce is that it may never return
 * `{ ok: false }` without having asked the venue. Before item 80, a thrown
 * `placeMarketBuy` became `{ ok: false, error }` (bot.ts:1105), which
 * `arbEngine.ts:631` reads as "zero shares" — an assumption, made about money,
 * with no evidence behind it.
 *
 * The 2026-09-11 ghost is what that costs. `pkg-btc-mtwep5v2` aborted at
 * 03:38:25.612 with `legs.up.shares = 0`; the chain shows 4.682223 UP shares
 * bought at 03:38:27 and redeemed at 03:46:39 for $4.682223. The bot held a
 * naked position for 8.2 minutes and had no record of it. It won $3.38. That is
 * the problem, not the consolation: the same coin flip pays -$1.24 just as
 * easily, and nothing in the engine would have noticed either way.
 *
 * TWO DOORS, because the two failure shapes leave different evidence:
 *
 *   Door B — the venue's own record of our order (`getOrder(id).size_matched`).
 *            Exact when we have an orderID. Says "0 matched" on a clean FOK
 *            kill, which is the only *positive* evidence of not-filled we get.
 *   Door A — the wallet's token balance (data-api `/positions`). Works when the
 *            transport dropped before any orderID came back, which is the case
 *            Door B structurally cannot cover.
 *
 * WHY POLLING, AND WHY 4.5 SECONDS. The chain settled the ghost 2.9s after the
 * order was signed. The existing defensive flatten (bot.ts:1083) fired at
 * ~1.5s — before the match — and was rejected for shares that did not exist
 * yet, then logged "likely never filled". A single probe is not a reconciler,
 * it is a coin toss against indexing lag. Probes are spread so the last one
 * lands comfortably past the observed settle latency.
 *
 * WHY THE BAND IS ASYMMETRIC. A fixed-dollar FOK buy commits `amount / price`
 * shares at the *limit* price, and the book may fill it better — the ghost paid
 * 0.26483 against a 0.27 bound and received 4.682 shares against 4.59 expected.
 * Fills can only ever come in ABOVE the expected count, never below (FOK does
 * not partially fill). The symmetric ±2% band in `verifyFilledShares` rejected
 * the real fill by 0.0004 shares. Here the upper bound is derived from what the
 * venue could actually have done: at best one tick per share.
 */
import { getOrderMatchedShares } from './trade.js';

/** Probe offsets from the throw, in ms. Last probe clears the observed 2.9s settle. */
export const PROBE_SCHEDULE_MS = [0, 2250, 4500];

const SHARE_SCALE = 1_000_000;

/* ------------------------------------------------------------------ *
 * Halt state
 *
 * A single flag, owned here because this module is the only thing that can
 * raise it: the engine halts precisely when reconciliation came back blind.
 * In memory deliberately — it must not survive a restart as a silent config
 * change the operator never made, and a restart is itself an operator action.
 * ------------------------------------------------------------------ */
let _halt: { reason: string; detail: any; at: number } | null = null;

export function haltArb(reason, detail = null) {
  if (_halt) return _halt;
  _halt = { reason: String(reason), detail, at: Date.now() };
  return _halt;
}
export function isArbHalted() { return _halt !== null; }
export function arbHaltState() { return _halt ? { ..._halt } : null; }
export function clearArbHalt() { const prev = _halt; _halt = null; return prev; }

/**
 * The share count band a fill could legitimately land in.
 *
 *   lo = expected − tolerance         (rounding on our side of the arithmetic)
 *   hi = expected × (price / tick)    (every share filled a full tick better)
 *
 * `hi` is generous — 27× at $0.27 against a $0.01 tick — and that is fine,
 * because the only thing the band has to discriminate is wire scale, and the
 * two candidate readings differ by 1e6.
 */
export function shareBand({ expectedShares, price, tickSize = 0.01, tolerance = 0.05 }) {
  const exp = Number(expectedShares);
  const px = Number(price);
  const tick = Number(tickSize) || 0.01;
  const tol = Math.max(Number(tolerance) || 0, 0.001);
  const lo = exp - tol;
  const hi = px > 0 && tick > 0 ? exp * (px / tick) + tol : exp + tol;
  return { lo, hi, tolerance: tol };
}

/** Resolve a raw wire number to shares, or null when the scale is ambiguous. */
export function resolveInBand(rawValue, band) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const fits = [raw, raw / SHARE_SCALE].filter((c) => c >= band.lo && c <= band.hi);
  return fits.length === 1 ? fits[0] : null;
}

/**
 * Door A: what the wallet actually holds of this token, right now.
 *
 * Deliberately NOT `readiness.positions`. That feed is TTL-cached for 60s
 * (`readiness.ts:88`) and truncated to 10 rows for display (`:386`) — reading it
 * here would answer a post-trade question with a pre-trade snapshot, which is
 * the same trap item 61 documents on the balance side.
 */
export async function fetchWalletPositions(depositWallet, { timeoutMs = 4000, fetchImpl = fetch } = {}) {
  if (!depositWallet) return null;
  try {
    const res = await fetchImpl(`https://data-api.polymarket.com/positions?user=${depositWallet}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    // A non-200 is the endpoint declining to answer, not an answer of "nothing".
    // The whole design turns on that distinction, so it is made here once.
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/** null = the endpoint did not answer. 0 = it answered, and you hold nothing. */
export async function fetchWalletShares(depositWallet, tokenId, opts = {}) {
  if (!depositWallet || !tokenId) return null;
  const rows = await fetchWalletPositions(depositWallet, opts);
  if (rows == null) return null;
  const row = rows.find((r) => String(r?.asset || '') === String(tokenId));
  return row ? Number(row.size) || 0 : 0;
}

/**
 * Ask both doors, on a schedule, and return one of three answers.
 *
 *   filled    — shares are in the wallet. Caller hedges leg 2 against `shares`.
 *   unfilled  — the venue acknowledges our order matched nothing. Clean abort.
 *   unknown   — neither door answered. Caller flattens defensively AND halts.
 *
 * WHAT COUNTS AS `unfilled`. Two things, and nothing else:
 *
 *   - Door B's explicit `size_matched: 0` on the final probe. The venue talking
 *     about our own order id.
 *   - Door A answering on EVERY probe, each time reporting no shares. Not one
 *     answer — every one. A single reading could be a wallet that has not
 *     indexed the fill yet; three healthy readings spanning a window that
 *     outlasts the observed settle latency is a different claim.
 *
 * Wallet *silence* still never counts. A request that failed has not told us
 * anything, and an earlier version of this function treated a failed request
 * and an empty wallet identically — which meant an ordinary network blip on the
 * order POST halted the engine. That was too blunt: the common case (nothing
 * filled, connection hiccupped) is not the dangerous case.
 *
 * `blind` is the dangerous case, reported separately: no door answered at any
 * probe. Only that halts. Everything else the caller can act on, because the
 * housekeeping sweep (`findUnrecordedHoldings`) re-checks the wallet against the
 * bot's records on a schedule and catches whatever this window got wrong.
 * Reconciliation is the fast path; the sweep is the one that cannot be raced.
 */
export async function reconcileArbLeg({
  orderId = null,
  tokenId,
  depositWallet = null,
  expectedShares,
  price,
  tickSize = 0.01,
  tolerance = 0.05,
  baselineShares = 0,
  probeScheduleMs = PROBE_SCHEDULE_MS,
  getMatched = getOrderMatchedShares,
  getWalletShares = fetchWalletShares,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (..._a) => {},
}) {
  const band = shareBand({ expectedShares, price, tickSize, tolerance });
  const probes: any[] = [];
  // Tracked separately from the readings themselves: "answered zero" and
  // "did not answer" are different facts and the resolution below needs both.
  let walletAnswers = 0;
  let walletZeros = 0;
  let orderAnswers = 0;
  const schedule = Array.isArray(probeScheduleMs) && probeScheduleMs.length
    ? probeScheduleMs
    : PROBE_SCHEDULE_MS;

  for (let i = 0; i < schedule.length; i++) {
    const wait = i === 0 ? schedule[0] : schedule[i] - schedule[i - 1];
    if (wait > 0) await sleep(wait);

    // Both doors concurrently — they are independent, and the window is the
    // budget. Neither is allowed to reject: a door that throws has not spoken.
    const [matchedRaw, walletRaw] = await Promise.all([
      orderId ? Promise.resolve(getMatched(orderId, band)).catch(() => null) : Promise.resolve(null),
      depositWallet ? Promise.resolve(getWalletShares(depositWallet, tokenId)).catch(() => null) : Promise.resolve(null),
    ]);

    const matched = matchedRaw == null ? null : Number(matchedRaw);
    const walletDelta = walletRaw == null ? null : Number(walletRaw) - Number(baselineShares || 0);
    if (matched != null) orderAnswers++;
    if (walletDelta != null) {
      walletAnswers++;
      if (walletDelta <= band.tolerance) walletZeros++;
    }
    const probe = { at: schedule[i], matched, walletDelta };
    probes.push(probe);
    log(`🔎 reconcile probe +${schedule[i]}ms · order=${matched ?? 'n/a'} wallet=${walletDelta ?? 'n/a'}`);

    // FILLED wins the moment either door says so — holding shares is ground
    // truth and there is nothing to gain by finishing the schedule.
    if (matched != null && matched > 0) {
      return { outcome: 'filled', shares: matched, door: 'order', probes, band, blind: false };
    }
    if (walletDelta != null && walletDelta >= band.lo) {
      return { outcome: 'filled', shares: walletDelta, door: 'wallet', probes, band, blind: false };
    }

    // A clean FOK kill, stated by the venue about our own order id. Accepted
    // only on the last probe: an order record can read 0 while the match is
    // still being written.
    if (matched === 0 && i === schedule.length - 1) {
      return { outcome: 'unfilled', shares: 0, door: 'order', probes, band, blind: false };
    }
  }

  // Door A answered every time and never saw the shares. Treated as a clean
  // abort so a hiccup on the order POST does not stop the engine — the sweep is
  // what covers the residual risk that the wallet was simply slow.
  if (walletAnswers === schedule.length && walletZeros === schedule.length) {
    return { outcome: 'unfilled', shares: 0, door: 'wallet', probes, band, blind: false };
  }

  return {
    outcome: 'unknown',
    shares: null,
    door: null,
    probes,
    band,
    // Nothing anywhere would speak to us. This is the only condition that halts.
    blind: orderAnswers === 0 && walletAnswers === 0,
  };
}

/* ------------------------------------------------------------------ *
 * The sweep
 *
 * Reconciliation is a 4.5-second window and every window can be raced. This is
 * the part that cannot be: it re-reads what the wallet holds against what the
 * bot thinks it holds, on a schedule, forever. If a fill materialises after
 * reconciliation gave up — the exact 2026-09-11 shape — the next sweep sees a
 * token balance nothing in the process claims, and sells it back to cash.
 *
 * This gap had no backstop before item 80. The existing orphan sweep
 * (`arbEngine.ts:825`) iterates `botState.positions`, so it can only find legs
 * the bot already recorded; a ghost fill is by definition one it did not.
 * ------------------------------------------------------------------ */

/** Tokens with an order in flight, so the sweep cannot race a fill being booked. */
const _inFlight = new Map<string, number>();

export function markOrderInFlight(tokenId) {
  if (tokenId) _inFlight.set(String(tokenId), Date.now());
}
export function clearInFlight(tokenId) {
  if (tokenId) _inFlight.delete(String(tokenId));
}
export function __inFlightForTest() { return _inFlight; }

/**
 * Wallet holdings that no bot position accounts for.
 *
 * Pure, so the decision is testable without a network or a live botState.
 *
 * Deliberately conservative — a row is only reported when every one of these
 * says it is genuinely unaccounted for:
 *
 *   - it has a positive balance
 *   - it is not resolved-and-worthless (item 68: a losing token sits in the
 *     feed with size > 0 and value $0; there is nothing to sell)
 *   - NO bot position references the token, open or closed. A closed position
 *     whose shares are somehow still held is a different divergence and this is
 *     not the function to guess about it
 *   - no order for that token was submitted within the grace window, so a fill
 *     still being written into `botState.positions` is never swept out from
 *     under itself
 */
export function findUnrecordedHoldings({
  walletRows,
  botPositions = [],
  graceMs = 10_000,
  now = Date.now(),
  inFlight = _inFlight,
}) {
  if (!Array.isArray(walletRows)) return [];
  const known = new Set(
    botPositions
      .map((p) => String(p?.tokenId || ''))
      .filter(Boolean),
  );

  return walletRows.filter((row) => {
    const tokenId = String(row?.asset || '');
    if (!tokenId) return false;
    if (!(Number(row.size) > 0)) return false;
    if (row.redeemable && Number(row.currentValue ?? 0) < 0.01) return false;
    if (known.has(tokenId)) return false;
    const sentAt = inFlight.get(tokenId);
    if (sentAt != null && now - sentAt < graceMs) return false;
    return true;
  });
}
