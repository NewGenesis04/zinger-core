/**
 * Dual-door reconciler for live arbitrage buy legs.
 *
 * Guarantees that `executePendingTrade` never reports `{ ok: false }` without
 * verifying directly with the venue whether an order actually matched.
 *
 * TWO DOORS (covering distinct transport failure modes):
 *   Door B — Venue Order Record (`getOrder(id).size_matched`).
 *            Primary check when an orderId exists. Returns positive confirmation
 *            of matched shares, or confirms "0 matched" on a clean FOK kill.
 *   Door A — Wallet Token Balance (Data API `/positions`).
 *            Fallback check when transport dropped before an orderId was returned.
 *
 * POLLING WINDOW (4.5s):
 *   Door B resolves immediately via the CLOB API.
 *   Door A relies on on-chain token settlement, which takes ~2-3 seconds on Polygon.
 *   Probes are scheduled across 4.5s so the final probe lands comfortably past
 *   the on-chain settlement and indexing window.
 *
 * ASYMMETRIC SHARE BAND:
 *   Fixed-dollar FOK buy orders commit `amount / price` shares at the limit price.
 *   Because books can fill at price improvements, fills may yield more shares than
 *   expected, but never fewer (FOK does not partially fill). The verification band
 *   is asymmetric at the top to accept legitimate price improvements.
 */
import { getOrderMatchedShares, shareBand, resolveInBand } from './trade.js';

/** Probe offsets from the throw in milliseconds, spanning the on-chain settlement window. */
export const PROBE_SCHEDULE_MS = [0, 2250, 4500];


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
 * The band and its scale resolution are owned by `trade.ts` (item 81): the fill
 * path and this reconciler must answer "how many shares?" with one band, not
 * two. Re-exported so callers of this module need not know that.
 */
export { shareBand, resolveInBand };

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
 * Backstop for unrecorded wallet holdings. If an order fill confirms on-chain
 * after reconciliation has concluded, this background sweep detects the unclaimed
 * token balance in the wallet and liquidates it back to cash.
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
