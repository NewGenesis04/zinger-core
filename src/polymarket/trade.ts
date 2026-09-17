// @ts-nocheck
import { ClobClient, AssetType, Side, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getWallet } from '../lib/wallet.js';
import { POLY } from './config.js';
import { installClobProxy, getClobProxyUrl } from './proxyEnv.js';
import { captureReceipt, captureClobCall } from './clobReceipts.js';

const CLOB_WRITE_RELAY = process.env.CLOB_PROXY_API_URL?.trim() || '';

// Optional HTTP/SOCKS egress for CLOB writes. Reads stay direct in clob.js.
installClobProxy();

/** Prefer proxied direct CLOB when CLOB_PROXY_URL is set; else optional write relay; else direct. */
function resolveWriteHost() {
  if (getClobProxyUrl()) return POLY.clobApi;
  if (CLOB_WRITE_RELAY) return CLOB_WRITE_RELAY;
  return POLY.clobApi;
}

const HOST = process.env.CLOB_API_URL?.trim() || POLY.clobApi;
const WRITE_HOST = resolveWriteHost();
const RPC = 'https://polygon-bor.publicnode.com';

let _signer = null;
let _account = null;
let _creds = null;
let _client = null;
let _proxyCreds = null;
let _proxyClient = null;

function getAccount() {
  if (!_account) {
    const wallet = getWallet();
    _account = privateKeyToAccount(wallet.privateKey);
  }
  return _account;
}

function getSigner() {
  if (!_signer) {
    const account = getAccount();
    _signer = createWalletClient({ account, chain: polygon, transport: http(RPC, { timeout: 10000 }) });
  }
  return _signer;
}

function getDepositWalletAddress() {
  return getWallet().polymarketDepositWallet || null;
}

function getClientOptions() {
  const depositWallet = getDepositWalletAddress();
  if (!depositWallet) return {};
  return {
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: depositWallet,
  };
}

function baseClient() {
  return new ClobClient({ host: HOST, chain: POLY.chainId, signer: getSigner(), ...getClientOptions() });
}

/**
 * Derive CLOB L2 credentials once, and fail loudly rather than silently.
 *
 * Backlog items 57/58. Three defects lived in `if (_creds) return _creds`:
 *
 *  1. A falsy result never memoised, so every readiness pass re-derived — an
 *     unbounded proxied call, on a timer.
 *  2. A rejection never memoised either, so a dead proxy was retried on every
 *     pass rather than backed off.
 *  3. Credentials that came back *without a key* were cached as success. The
 *     readiness panel then said "API key missing" and the balance check said
 *     `buildPolyHmacSignature: secret is empty` — both of which read as a
 *     credential bug. The actual cause was an exhausted proxy quota, and that
 *     misdirection cost six rounds of diagnosis. Unusable credentials are now a
 *     failure with a message that says so.
 *
 * Success is cached for the process lifetime; failure is cached briefly with
 * exponential backoff so the bot heals on its own once the proxy returns,
 * without hammering it in the meantime.
 */
const AUTH_FAIL_BASE_MS = 60_000;
const AUTH_FAIL_CAP_MS = 15 * 60_000;

let _credsFailUntil = 0;
let _credsFailStreak = 0;
let _credsLastError = null;

export async function ensureApiKey() {
  if (_creds) return _creds;
  if (Date.now() < _credsFailUntil) {
    const waitS = Math.ceil((_credsFailUntil - Date.now()) / 1000);
    throw new Error(`CLOB auth backoff (${waitS}s left): ${_credsLastError}`);
  }
  try {
    const creds = await baseClient().createOrDeriveApiKey();
    // Resolved-but-keyless is a failure, not a cacheable success: an empty
    // secret cannot sign an L2 header, so every downstream call would throw.
    if (!creds?.key) throw new Error('CLOB returned credentials without an API key');
    _creds = creds;
    _credsFailStreak = 0;
    _credsLastError = null;
    return _creds;
  } catch (err) {
    _credsFailStreak = Math.min(_credsFailStreak + 1, 5);
    _credsFailUntil = Date.now()
      + Math.min(AUTH_FAIL_BASE_MS * 2 ** (_credsFailStreak - 1), AUTH_FAIL_CAP_MS);
    _credsLastError = err?.message || String(err);
    throw err;
  }
}

export async function getTradingClient() {
  if (_client) return _client;
  const creds = await ensureApiKey();
  _client = new ClobClient({ host: HOST, chain: POLY.chainId, signer: getSigner(), creds, ...getClientOptions() });
  return _client;
}

async function ensureProxyApiKey() {
  if (_proxyCreds) return _proxyCreds;
  const client = new ClobClient({ host: WRITE_HOST, chain: POLY.chainId, signer: getSigner(), ...getClientOptions() });
  _proxyCreds = await client.createOrDeriveApiKey();
  return _proxyCreds;
}

async function getProxyTradingClient() {
  if (_proxyClient) return _proxyClient;
  const creds = await ensureProxyApiKey();
  _proxyClient = new ClobClient({ host: WRITE_HOST, chain: POLY.chainId, signer: getSigner(), creds, ...getClientOptions() });
  return _proxyClient;
}

export function getWalletAddress() {
  return getAccount().address;
}

export function getFunderAddress() {
  return getDepositWalletAddress() || getWalletAddress();
}

function parseClobBalanceResult(result) {
  if (result?.error) {
    return { balance: 0, allowance: 0, raw: result, clobError: result.error };
  }
  const balance = Number(result.balance || 0) / 1_000_000;
  const allowances = Object.values(result.allowances || {}).map((value) => Number(value || 0) / 1_000_000);
  const allowance = allowances.length ? Math.max(...allowances) : 0;
  return { balance, allowance, raw: result, clobError: null };
}

export async function getClobBalance() {
  const client = await getTradingClient();
  const result = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return parseClobBalanceResult(result);
}

export async function getOrders() {
  try {
    const client = await getTradingClient();
    const result = await client.getOpenOrders();
    return result?.data || result || [];
  } catch {
    return [];
  }
}

function roundPrice(price, tickSize = 0.01) {
  const ticks = Math.round(price / tickSize);
  return Math.min(0.99, Math.max(0.01, ticks * tickSize));
}

function sharesForUsd(usd, price, minShares = 5) {
  const shares = Math.max(minShares, Math.ceil((usd / price) * 100) / 100);
  return Number(shares.toFixed(2));
}

/**
 * The venue's own way of saying "your fill-or-kill matched nothing" — item 84.
 *
 * Every pattern here is a string this project has OBSERVED from the live CLOB,
 * not one it expects (domain facts §8):
 *
 *   "order couldn't be fully filled. FOK orders are fully filled or killed."
 *
 * This is deliberately the ONE place in the codebase that reads meaning out of
 * an error string, and it is worth naming why that is normally forbidden.
 * `verifyFilledShares` refuses to gate on `status` because a status vocabulary
 * is an assumption about venue behaviour, and an unverified assumption about
 * venue behaviour is the failure CLAUDE.md warns about.
 *
 * What makes it acceptable here is the direction of failure. A match skips a
 * 4.5-second reconciliation for a leg the venue has explicitly said did not
 * fill. A NON-match changes nothing: the leg takes the full dual-door path as
 * before. So if Polymarket rewords this tomorrow, the bot gets slower, not
 * wrong. That asymmetry is the whole justification — it does not extend to any
 * other use of these strings.
 */
const FOK_KILL_PATTERNS = [
  /fok orders are fully filled or killed/i,
  /could\s*n.?.?t be fully filled/i,
];

const _fokStats = { fastAborts: 0, unmatchedFailures: 0, vocabulary: new Map<string, number>() };

/**
 * Did the venue synchronously tell us this fill-or-kill matched nothing?
 *
 * Requires BOTH an HTTP 400 and a recognised phrase. The status alone is far too
 * broad — a 400 also covers malformed orders, insufficient balance and the
 * $1.00-notional rejection, none of which say anything about whether shares
 * moved.
 */
export function isSyncFokKill(status, message) {
  if (Number(status) !== 400) return false;
  const msg = String(message || '');
  return FOK_KILL_PATTERNS.some((re) => re.test(msg));
}

/**
 * Counters, so the vocabulary is learned from evidence rather than assumed.
 *
 * `unmatchedFailures` and `vocabulary` are the important half: they are what
 * reveal a reworded kill message, or a second phrasing nobody anticipated. A
 * rising `unmatchedFailures` against a flat `fastAborts` is the signal that this
 * pattern list has gone stale.
 */
export function fokKillStats() {
  return {
    fastAborts: _fokStats.fastAborts,
    unmatchedFailures: _fokStats.unmatchedFailures,
    vocabulary: [..._fokStats.vocabulary.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([text, n]) => ({ text, n })),
  };
}

export function __resetFokStats() {
  _fokStats.fastAborts = 0;
  _fokStats.unmatchedFailures = 0;
  _fokStats.vocabulary.clear();
}

/**
 * Classify a rejected order response, and record what we learned from it.
 *
 * Split out from `assertOrderAccepted` so the classification has a seam that is
 * exercisable without a signer, a client or a network — the counters are the
 * early-warning system for this whole optimisation going stale, and an
 * early-warning system nobody can test is decoration.
 */
export function classifyOrderFailure(result) {
  const msg = result?.errorMsg || result?.error || null;
  const fokKill = isSyncFokKill(result?.status, msg);
  if (fokKill) {
    _fokStats.fastAborts++;
  } else {
    _fokStats.unmatchedFailures++;
    const key = String(msg || 'unknown').slice(0, 120);
    _fokStats.vocabulary.set(key, (_fokStats.vocabulary.get(key) || 0) + 1);
  }
  return {
    fokKill,
    venueError: msg == null ? null : String(msg).slice(0, 300),
    venueStatus: result?.status ?? null,
  };
}

/** CLOB returns {success:false, errorMsg} instead of throwing — surface it. */
function assertOrderAccepted(result, context) {
  const id = result?.orderID || result?.orderId || result?.id;
  const failed = result?.success === false || result?.error || result?.errorMsg;
  if (failed || !id) {
    const msg = result?.errorMsg || result?.error || (id ? 'order rejected' : 'no orderID in response');
    const err: any = new Error(`${context}: ${String(msg).slice(0, 200)}`);
    // Item 79. The venue's own words, kept separable from our framing of them.
    // Twenty-one live packages recorded `Leg execution mismatch` and nothing
    // else; at least two of those were a $1.00-notional rejection rather than a
    // FOK kill, and the record could not tell them apart.
    // Item 84. Classified here, at the one place that sees the venue's raw
    // response, rather than re-parsed downstream from a wrapped message.
    const verdict = classifyOrderFailure(result);
    err.venueError = verdict.venueError;
    err.venueStatus = verdict.venueStatus;
    err.fokKill = verdict.fokKill;
    err.orderId = id || null;
    throw err;
  }
  return id;
}

/**
 * Did a GTC limit order actually match, or is it resting on the book?
 *
 * `assertOrderAccepted` passes on orderID presence alone, and the CLOB returns
 * an orderID for a resting order just as it does for a matched one, so an
 * orderID alone would record an unmatched bid as a fill. Directional entries use
 * GTC deliberately (a resting bid is a missed trade, not a naked position), so
 * this read applies to them.
 *
 * Detection is quantitative, not status-string based: the exact status vocabulary
 * is still an open question in the research doc, but "no collateral moved" is
 * unambiguous in any vocabulary. `tradeIDs` is the SDK's own documented signal
 * ("IDs of the trades created when the order matched"), used as corroboration.
 *
 * BUY:  makingAmount = collateral paid, takingAmount = tokens received.
 * SELL: makingAmount = tokens given up, takingAmount = collateral received.
 */
/**
 * Resolve a wire amount to a real quantity — item 85.
 *
 * The only ambiguity is scale: the SDK signs with `parseUnits(…, 6)`, so a
 * reading is either the quantity itself or that quantity × 1e6. Both candidates
 * are tested against a band, and **exactly one** must fit; two fits is as
 * unresolved as none, because picking the first would be a guess.
 *
 * The floor is not arbitrary. `ROUNDING_CONFIG[tick].size` is 2 for every tick
 * size in this SDK, so the venue cannot represent a quantity below 0.01 — a
 * candidate under that is not a fill, it is the other scale.
 */
function resolveScale(raw, { min, max }) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const fits = [n, n / SHARE_SCALE].filter((c) => c >= min && c <= max);
  return fits.length === 1 ? fits[0] : null;
}

/** The smallest share count the venue can express (see `roundingConfig.js`). */
const MIN_REPRESENTABLE_SHARES = 0.01;

export function readGtcFill(result, side, requestedSize, price = null) {
  const maker = Number(result?.makingAmount);
  const taker = Number(result?.takingAmount);
  const tradeCount = Array.isArray(result?.tradeIDs) ? result.tradeIDs.length : null;
  const moved = Number.isFinite(maker) && maker > 0 && Number.isFinite(taker) && taker > 0;
  const matched = moved || (tradeCount != null && tradeCount > 0);

  if (!matched) {
    return { filledShares: 0, resting: true, fillSource: tradeCount === 0 || moved === false ? 'no-fill' : 'unknown' };
  }

  const isBuy = String(side).toLowerCase() === 'buy';
  const want = Number(requestedSize);
  if (!(want > 0)) {
    return { filledShares: null, resting: false, fillSource: 'matched-unverified' };
  }

  /**
   * ITEM 85 — the band is one-sided DOWN, because a GTC limit order can
   * legitimately fill for less than it asked for and can never fill for more.
   *
   * The previous band was symmetric: `|c − want| ≤ max(0.05, want × 2%)`. That
   * is the right shape for a fill-or-kill order, where the answer is 0 or
   * exactly `want` — and it is the WRONG shape here, where a partial fill is an
   * ordinary outcome. Anything more than 2% short failed to resolve, came back
   * null, and `bot.ts` then booked the full requested size: a 50%-filled entry
   * recorded as 100% filled, with equity, realised P/L and Kelly sizing all
   * reading the inflated number.
   *
   * Note this is the mirror image of item 81, which had the same symmetric band
   * failing in the *opposite* direction on the market-order path. Same
   * arithmetic, three different correct answers — see the table in item 85.
   */
  const ceiling = want * 1.02;
  const candidate = resolveScale(isBuy ? taker : maker, {
    min: MIN_REPRESENTABLE_SHARES,
    max: ceiling,
  });

  /**
   * A FULL fill is self-evident: the count matches what was asked for, and no
   * corroboration adds anything. This is the original symmetric test, kept
   * exactly, for exactly the case it was right about.
   */
  const fullFillTolerance = Math.max(0.05, Math.abs(want) * 0.02);
  const looksFull = candidate != null && Math.abs(candidate - want) <= fullFillTolerance;

  /**
   * A PARTIAL claim is not self-evident and is NOT accepted on its own.
   *
   * Widening the band downward to admit partials also admits any small number
   * that happens to land in range — and a receipt of `makingAmount: 1,
   * takingAmount: 2` against a 26-share request would read as "2 shares filled"
   * rather than as the unresolvable garbage it is. That is the invariant at
   * `tests/unit/invariants.fillAccounting.test.ts:127`, and it is correct.
   *
   * So a partial must corroborate itself with the implied price. `maker / taker`
   * is the collateral-per-share actually paid; both amounts share a scale, so
   * the ratio is scale-free and needs no unit guessing. For a BUY it can never
   * legitimately exceed the limit price — you cannot pay more than your own
   * ceiling — and for a SELL it can never fall below the floor. A partial whose
   * implied price is impossible is a reading we do not understand, and an
   * unresolved fill is the honest answer.
   */
  let shares = looksFull ? candidate : null;
  let source = shares == null ? null : 'receipt';

  if (shares == null && candidate != null && Number(price) > 0 && taker > 0 && maker > 0) {
    const impliedPrice = isBuy ? maker / taker : taker / maker;
    const limit = Number(price);
    const withinLimit = isBuy
      ? impliedPrice <= limit * 1.001
      : impliedPrice >= limit * 0.999;
    if (withinLimit && impliedPrice > 0) {
      shares = candidate;
      source = 'receipt-partial';
    }
  }

  return {
    // A matched order whose size cannot be resolved is reported as unverified
    // rather than assumed complete — null, never the requested size.
    filledShares: shares,
    resting: false,
    partial: shares != null && shares < want - MIN_REPRESENTABLE_SHARES,
    requestedShares: want,
    fillSource: shares == null ? 'matched-unverified' : source,
  };
}

export async function placeOrder({ tokenId, side, amountUsd, price, negRisk = false, tickSize = '0.01', minShares = 5 }) {
  const client = await getProxyTradingClient();
  const px = roundPrice(price, Number(tickSize));
  const size = sharesForUsd(amountUsd, px, minShares);
  const orderSide = side === 'buy' ? Side.BUY : Side.SELL;

  const result = await captureClobCall(
    'placeOrder/createAndPostOrder',
    { tokenId: String(tokenId), side, price: px, size, tickSize, negRisk: !!negRisk, orderType: 'GTC' },
    () => client.createAndPostOrder(
      { tokenID: String(tokenId), price: px, size, side: orderSide },
      { tickSize: String(tickSize), negRisk: !!negRisk },
    ),
  );

  const id = assertOrderAccepted(result, `CLOB ${side} ${size}sh @ ${px}`);
  const fill = readGtcFill(result, side, size, px);
  captureReceipt({
    fn: 'placeOrder/verified',
    phase: 'response',
    request: { tokenId: String(tokenId), side, price: px, size },
    raw: result,
    derived: { orderId: id, requestedSize: size, ...fill, statusString: result?.status ?? null },
  });

  return {
    id,
    order: result,
    price: px,
    // `size` is what was ASKED for. `filledShares` is what the book gave, and
    // `resting` says the order is live on the book with nothing matched — an
    // orderID alone never meant shares in hand (backlog: assertOrderAccepted).
    size,
    ...fill,
    side: orderSide,
    status: result?.status || null,
  };
}

/**
 * Polymarket scales conditional-token amounts by COLLATERAL_TOKEN_DECIMALS (6),
 * the same as USDC — verified in the SDK at
 * `order-builder/helpers/buildMarketOrderCreationArgs.js`, which runs both
 * `makerAmount` and `takerAmount` through `parseUnits(..., 6)`. That is the
 * SIGNED order.
 *
 * The OrderResponse coming back is a different matter: the SDK types
 * `makingAmount`/`takingAmount` as bare `string` with no documented units.
 * Observed responses carry decimal human units (domain facts §9a), but that is
 * an observation, not a contract — and guessing wrong mis-sizes the sibling arb
 * leg. So readings are resolved against a band derived from our own order,
 * accepting either scale, rather than assuming one.
 */
const SHARE_SCALE = 1_000_000;

/**
 * Share count band for fixed-dollar FOK buy fills.
 *
 *   lo = expected − tolerance
 *   hi = (expected + tolerance) × (price / tick)
 *
 * Why one-sided:
 * The order commits a fixed dollar amount at a limit price (`amount / fillPrice`
 * where `fillPrice <= maxPrice`). Price improvements increase the shares received,
 * while FOK never partially fills. Thus, valid fills can legitimately exceed
 * `expected`, but will not fall below `expected - tolerance`.
 *
 * The tolerance is scaled into `hi` rather than added after to prevent rounding
 * distortions when multiplying by `(price / tick)`.
 *
 * Owned here and shared by both the immediate fill path (`verifyFilledShares`)
 * and the dual-door reconciler (`arbReconcile.ts`).
 */
export function shareBand({ expectedShares, price, tickSize = 0.01, tolerance = 0.05 }) {
  const exp = Number(expectedShares);
  const px = Number(price);
  const tick = Number(tickSize) || 0.01;
  const tol = Math.max(Number(tolerance) || 0, 0.001);
  const lo = exp - tol;
  const hi = px > 0 && tick > 0 ? (exp + tol) * (px / tick) : exp + tol;
  return { lo, hi, tolerance: tol };
}

/** Resolve a raw wire number to shares within `band`, or null when the scale is ambiguous. */
export function resolveInBand(rawValue, band) {
  return resolveScale(rawValue, { min: band.lo, max: band.hi });
}

/**
 * How many shares did this order actually match?
 *
 * Deliberately never gated on `status`. The SDK does not document its
 * vocabulary, and a handful of observed values (domain facts §9e) is not a
 * vocabulary. Gating live execution on unverified venue semantics is the
 * failure CLAUDE.md warns about. Every rung below is numeric.
 *
 *   1. the receipt's own takingAmount (shares, for a BUY), free
 *   2. getOrder(id).size_matched, authoritative, one extra round trip
 *
 * Returns null when neither rung resolves. Null means "unknown", never "zero".
 *
 * Both rungs resolve against `band` — `shareBand`, one-sided, the same band the
 * reconciler uses (item 81). `getSizeMatched` is the second rung's round trip,
 * injected so the resolution can be exercised without a signer or a network.
 */
export async function verifyFilledShares(result, band, getSizeMatched) {
  const fromReceipt = resolveInBand(result?.takingAmount, band);
  if (fromReceipt != null) return fromReceipt;

  try {
    const orderId = String(result?.orderID || result?.orderId || result?.id);
    return resolveInBand(await getSizeMatched(orderId), band);
  } catch {
    return null;
  }
}

/**
 * The dollars, price and share count this module will commit to for a plan.
 *
 * Exported because item 80's reconciler has to ask "how many shares should be
 * in the wallet?" at a call site that never saw these numbers —
 * `placeMarketBuy` threw before returning them. Re-deriving them there would
 * fork the arithmetic the order is signed against (`getMarketOrderRawAmounts`
 * commits `rawTakerAmt = rawMakerAmt / rawPrice`), and a fork that drifts by a
 * tick makes the reconciler compare the venue's answer to a number the venue
 * never used. One owner, two readers.
 */
export function expectedSharesFor({ amountUsd, maxPrice, tickSize = '0.01', minShares = 5, shareTolerance = 0.05 }) {
  const px = roundPrice(Number(maxPrice), Number(tickSize));
  if (!(px > 0)) return null;
  const amount = Math.round(Math.max(Number(amountUsd) || 0, Number(minShares) * px) * 100) / 100;
  if (!(amount > 0)) return null;
  const expectedShares = Number((amount / px).toFixed(2));
  return {
    price: px,
    amountUsd: amount,
    expectedShares,
    tolerance: Math.max(Number(shareTolerance) || 0, expectedShares * 0.02),
  };
}

/**
 * Tri-state: how many shares did this order match, per the venue's own record?
 *
 * Deliberately NOT `verifyFilledShares` above. That contract is "null means
 * unknown, never zero" (:311), which is right for the fill path — there a zero
 * reading is indistinguishable from one it could not scale, and calling it zero
 * abandons a filled leg.
 *
 * Reconciliation needs the opposite resolution. `size_matched: 0` on an order
 * the venue acknowledges is evidence, not absence: a FOK matches in full or is
 * killed, so an acknowledged order with nothing matched IS the kill. Refusing
 * to read it would leave every clean kill stuck in UNKNOWN, and UNKNOWN halts
 * the engine — the bot would stop itself every time an order was correctly
 * rejected. So this returns a number (0 included) when the venue answered, and
 * null only when it did not.
 *
 * The caller supplies the band because the acceptable range is one-sided; see
 * `arbReconcile.ts:shareBand`.
 */
export async function getOrderMatchedShares(orderId, band) {
  if (!orderId) return null;
  try {
    const client = await getProxyTradingClient();
    const open = await captureClobCall(
      'reconcileArbLeg/getOrder',
      { orderId: String(orderId), band },
      () => client.getOrder(String(orderId)),
    );
    if (open == null) return null;
    const raw = Number(open?.size_matched);
    if (!Number.isFinite(raw) || raw < 0) return null;
    if (raw === 0) return 0;
    return resolveInBand(raw, band);
  } catch {
    return null;
  }
}

/**
 * Fill-or-kill buy at a bounded price, for arbitrage entry legs.
 *
 * Why this exists: `placeOrder` posts a GTC limit order. If the ask ticks up
 * between the scan and the post, the order does not match — it *rests* on the
 * book as a bid, and the CLOB still returns an orderID. `assertOrderAccepted`
 * sees that ID and reports success, so the arb engine would buy the second leg
 * against a first leg that never filled — leaving an unhedged position.
 *
 * `maxPrice` is required, and that is not a stylistic preference.
 * `buildMarketOrderCreationArgs` computes the signed amounts with
 * `userMarketOrder.price || 1` — omit the price and the order is signed at an
 * implied limit of $1.00 per share. An arb package needs up + down to cost less
 * than $1.00 *combined*, so an unpriced market buy can pay away the entire edge
 * on a single leg. The price is the slippage bound, not a hint.
 */
export async function placeMarketBuy({
  tokenId,
  amountUsd,
  maxPrice,
  negRisk = false,
  tickSize = '0.01',
  minShares = 5,
  shareTolerance = 0.05,
}) {
  // Both guards run before any client is built, so the contract is enforceable
  // without a network or a signer.
  if (!(Number(maxPrice) > 0)) {
    throw new Error('placeMarketBuy requires maxPrice — an unpriced market buy signs at $1.00/share');
  }
  // Same derivation the reconciler reads (`expectedSharesFor`), so the fill path
  // and reconciliation build their band from one set of numbers — item 81.
  const quote = expectedSharesFor({ amountUsd, maxPrice, tickSize, minShares, shareTolerance });
  if (!quote) throw new Error(`placeMarketBuy: non-positive amount (amountUsd=${amountUsd}, minShares=${minShares})`);
  const { price: px, amountUsd: amount, expectedShares, tolerance } = quote;
  const band = shareBand({ expectedShares, price: px, tickSize: Number(tickSize), tolerance });

  const client = await getProxyTradingClient();
  const result = await captureClobCall(
    'placeMarketBuy/createAndPostMarketOrder',
    { tokenId: String(tokenId), side: 'BUY', amountUsd: amount, maxPrice: px, tickSize,
      negRisk: !!negRisk, orderType: 'FOK', expectedShares },
    () => client.createAndPostMarketOrder(
      { tokenID: String(tokenId), amount, price: px, side: Side.BUY },
      { tickSize: String(tickSize), negRisk: !!negRisk },
    ),
  );

  const id = assertOrderAccepted(result, `CLOB FOK buy $${amount} @<=${px}`);
  const shares = await verifyFilledShares(result, band, async (orderId) => {
    const open = await captureClobCall(
      'verifyFilledShares/getOrder',
      { orderId, expectedShares, band },
      () => client.getOrder(orderId),
    );
    return open?.size_matched;
  });

  // Backlog 33 answered in one line: `expectedShares` was derived from our own
  // arithmetic, so whichever of takingAmount / takingAmount/1e6 sits beside it
  // reveals the wire scale. Recorded whether or not verification succeeded —
  // the null case is the one that most needs explaining.
  captureReceipt({
    fn: 'placeMarketBuy/verified',
    phase: 'response',
    request: { tokenId: String(tokenId), amountUsd: amount, maxPrice: px, expectedShares, tolerance, band },
    raw: result,
    derived: {
      orderId: id,
      expectedShares,
      resolvedShares: shares,
      takingAmountRaw: result?.takingAmount ?? null,
      makingAmountRaw: result?.makingAmount ?? null,
      takingAsShares: Number(result?.takingAmount) / 1_000_000 || null,
      statusString: result?.status ?? null,
      verificationOutcome: shares == null ? 'UNVERIFIED_FILL' : 'verified',
    },
  });

  if (shares == null) {
    // The order was accepted but we cannot prove what it matched. Do NOT report
    // this as a plain failure: if it did fill, the caller abandons shares that
    // are already in the wallet, which is the orphan this function exists to
    // prevent — just on the other side. Carry the ambiguity to the caller so it
    // can flatten defensively.
    const err: any = new Error(
      `CLOB FOK buy ${id}: fill unverified (status=${result?.status ?? 'n/a'} `
      + `taking=${result?.takingAmount ?? 'n/a'} making=${result?.makingAmount ?? 'n/a'} expected≈${expectedShares}sh)`,
    );
    err.code = 'UNVERIFIED_FILL';
    err.orderId = id;
    err.tokenId = String(tokenId);
    err.expectedShares = expectedShares;
    throw err;
  }

  return {
    id,
    order: result,
    price: px,
    size: shares,
    expectedShares,
    costUsd: amount,
    side: Side.BUY,
    status: result?.status || null,
  };
}

/**
 * Worst price an exit will accept, as a tick-aligned floor.
 *
 * Derived from the **current** mark, never the entry price. An exit fires
 * precisely when the mark has moved against us: a stop-loss on a position
 * entered at $0.50 and now bid $0.20 needs a floor near $0.20, and anything
 * anchored to entry would sit above the book and fail to fill exactly when
 * getting out matters most.
 *
 * `slippagePct` is how far below the mark the sweep may run before the order is
 * killed. It bounds the worst tranche, not the average fill — the exchange still
 * matches the top of book first.
 */
export function sellFloor(mark, { tickSize = 0.01, slippagePct = 0.25 } = {}) {
  const tick = Number(tickSize) || 0.01;
  const m = Number(mark);
  // No usable mark (an untracked wallet asset, a position never marked): fall
  // back to the minimum tick. A wide floor risks a poor fill; no floor at all
  // means price || 1 and an order that cannot fill. The former is recoverable.
  if (!Number.isFinite(m) || m <= 0) return tick;
  const floor = m * (1 - Math.min(Math.max(Number(slippagePct) || 0, 0), 0.95));
  return Math.max(tick, Math.floor(floor / tick) * tick);
}

/**
 * The realised price of a market SELL, read from its receipt.
 *
 * For a SELL the CLOB reports `makingAmount` = tokens given up and
 * `takingAmount` = collateral received. Their **ratio** is the fill price, and
 * a ratio is scale-invariant: it is correct whether those fields are raw units
 * or 1e6-scaled, so this does not depend on backlog 33 being settled.
 *
 * Absolute share/proceeds figures do need the scale, so they are resolved
 * against the share count we asked for and returned only when one reading
 * matches — the same approach `verifyFilledShares` takes, and for the same
 * reason: guessing the scale on a live sell is how ledgers drift.
 */
export function readSellFill(result, requestedShares) {
  const maker = Number(result?.makingAmount);
  const taker = Number(result?.takingAmount);
  const none = { fillPrice: null, filledShares: null, proceedsUsd: null, fillSource: 'unavailable' };
  if (!(Number.isFinite(maker) && maker > 0 && Number.isFinite(taker) && taker > 0)) return none;

  const fillPrice = Math.round((taker / maker) * 1e6) / 1e6;
  if (!(fillPrice > 0) || fillPrice > 1) return { ...none, fillPrice: null, fillSource: 'implausible' };

  const want = Number(requestedShares);
  const tolerance = Math.max(0.05, Math.abs(want) * 0.02);
  const candidates = [maker, maker / 1e6];
  const shares = candidates.find((c) => Number.isFinite(want) && want > 0 && Math.abs(c - want) <= tolerance) ?? null;

  return {
    fillPrice,
    filledShares: shares,
    proceedsUsd: shares == null ? null : Math.round(shares * fillPrice * 100) / 100,
    fillSource: 'receipt',
  };
}

export async function placeMarketSell({
  tokenId, shares, minPrice, negRisk = false, tickSize = '0.01',
}) {
  // Mirrors the maxPrice guard on placeMarketBuy, for the same reason and with
  // the sign flipped. `buildMarketOrderCreationArgs.js:8` signs with
  // `userMarketOrder.price || 1`, and for a SELL `getMarketOrderRawAmounts.js`
  // computes taker = maker x price — so an unpriced sell demands $1.00/share and
  // fails the exchange's slippage check on every book this bot trades.
  if (!(Number(minPrice) > 0)) {
    throw new Error('placeMarketSell requires minPrice — an unpriced market sell demands $1.00/share');
  }
  const px = roundPrice(Number(minPrice), Number(tickSize));

  const client = await getProxyTradingClient();
  const result = await captureClobCall(
    'placeMarketSell/createAndPostMarketOrder',
    { tokenId: String(tokenId), side: 'SELL', shares, minPrice: px, tickSize, negRisk: !!negRisk },
    () => client.createAndPostMarketOrder(
      { tokenID: String(tokenId), amount: shares, price: px, side: Side.SELL },
      { tickSize: String(tickSize), negRisk: !!negRisk },
    ),
  );
  const id = assertOrderAccepted(result, `CLOB market sell ${shares}sh @>=${px}`);
  const fill = readSellFill(result, shares);
  captureReceipt({
    fn: 'placeMarketSell/verified',
    phase: 'response',
    request: { tokenId: String(tokenId), shares, minPrice: px },
    raw: result,
    derived: { orderId: id, ...fill, floorPrice: px },
  });
  return {
    id,
    order: result,
    size: shares,
    // `price` is the slippage FLOOR we signed, not what the book paid. Callers
    // booking a realised exit must use `fillPrice` — recording the floor would
    // overstate the loss exactly as copying the entry price understated it
    // (backlog 44).
    price: px,
    floorPrice: px,
    ...fill,
    status: result?.status || null,
  };
}

export async function cancelOrder(orderId) {
  try {
    const client = await getProxyTradingClient();
    await client.cancelOrder({ orderID: orderId });
    return true;
  } catch {
    return false;
  }
}

export const deriveApiKey = ensureApiKey;

/**
 * Ask the CLOB to refresh its cached allowance. Returns nothing on purpose.
 *
 * This used to end with `return getClobBalance()` — a second proxied round trip
 * whose result every one of its seven call sites discarded, and which five of
 * them immediately duplicated by calling `refreshTelemetry()` (which reads the
 * balance again via `readiness.ts`). `getClobBalance` is pure, so the read had
 * no side effect worth keeping either. Backlog item 61: that one line was 25% of
 * the bot's steady-state proxy traffic.
 *
 * Callers that need the balance should call `getClobBalance()` themselves.
 */
export async function syncClobBalance() {
  const client = await getProxyTradingClient();
  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
}

export function resetTradingClient() {
  _creds = null;
  _client = null;
  _proxyCreds = null;
  _proxyClient = null;
  // Clear the auth backoff too: an explicit reset is the operator saying "try
  // again now", which a lingering backoff window would silently ignore.
  _credsFailUntil = 0;
  _credsFailStreak = 0;
  _credsLastError = null;
}
