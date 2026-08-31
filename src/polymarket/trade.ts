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

export async function ensureApiKey() {
  if (_creds) return _creds;
  const client = baseClient();
  _creds = await client.createOrDeriveApiKey();
  return _creds;
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

/** CLOB returns {success:false, errorMsg} instead of throwing — surface it. */
function assertOrderAccepted(result, context) {
  const id = result?.orderID || result?.orderId || result?.id;
  const failed = result?.success === false || result?.error || result?.errorMsg;
  if (failed || !id) {
    const msg = result?.errorMsg || result?.error || (id ? 'order rejected' : 'no orderID in response');
    throw new Error(`${context}: ${String(msg).slice(0, 200)}`);
  }
  return id;
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

  return {
    id,
    order: result,
    price: px,
    size,
    side: orderSide,
    status: result?.status || null,
  };
}

/**
 * Polymarket scales conditional-token amounts by COLLATERAL_TOKEN_DECIMALS (6),
 * the same as USDC — verified in the SDK at
 * `order-builder/helpers/buildMarketOrderCreationArgs.js`, which runs both
 * `makerAmount` and `takerAmount` through `parseUnits(..., 6)`. The live
 * settlement receipts agree: `26330000` is 26.33 shares.
 *
 * What the SDK does NOT pin down is the scale of `makingAmount`/`takingAmount`
 * on the OrderResponse coming back over the wire — both are typed bare `string`
 * with no documented units. Guessing wrong mis-sizes the sibling arb leg, which
 * is the failure this whole path exists to prevent, so resolve the scale
 * against a share count we derived ourselves instead of assuming one.
 */
const SHARE_SCALE = 1_000_000;

function resolveAgainstExpected(rawValue, expectedShares, tolerance) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const fits = [raw, raw / SHARE_SCALE].filter((c) => Math.abs(c - expectedShares) <= tolerance);
  // Exactly one reading may fit. Zero means the fill is not what we asked for;
  // two means the two scales are indistinguishable here. Both are unresolved.
  return fits.length === 1 ? fits[0] : null;
}

/**
 * How many shares did this order actually match?
 *
 * Deliberately never gated on `status`. Nothing in the SDK, the research doc, or
 * this codebase records what strings the CLOB returns there, and gating live
 * execution on an unverified vocabulary is exactly the shape of the Aug 2026
 * `negRisk` regression — fluent, plausible, and silently fatal for days. Every
 * rung below is numeric.
 *
 *   1. the receipt's own takingAmount (shares, for a BUY), free
 *   2. getOrder(id).size_matched, authoritative, one extra round trip
 *
 * Returns null when neither rung resolves. Null means "unknown", never "zero".
 */
async function verifyFilledShares(result, expectedShares, tolerance) {
  const fromReceipt = resolveAgainstExpected(result?.takingAmount, expectedShares, tolerance);
  if (fromReceipt != null) return fromReceipt;

  try {
    const client = await getProxyTradingClient();
    const orderId = String(result?.orderID || result?.orderId || result?.id);
    const open = await captureClobCall(
      'verifyFilledShares/getOrder',
      { orderId, expectedShares, tolerance },
      () => client.getOrder(orderId),
    );
    return resolveAgainstExpected(open?.size_matched, expectedShares, tolerance);
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
 * sees that ID and reports success, so the arb engine proceeds to buy the
 * second leg against a first leg that never filled. On 2026-08-28 that left
 * 26.33 unhedged DOWN shares which expired at zero (-$12.83).
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
  const px = roundPrice(Number(maxPrice), Number(tickSize));
  const amount = Math.round(Math.max(Number(amountUsd) || 0, minShares * px) * 100) / 100;
  if (!(amount > 0)) throw new Error(`placeMarketBuy: non-positive amount $${amount}`);

  const expectedShares = Number((amount / px).toFixed(2));
  const tolerance = Math.max(Number(shareTolerance) || 0, expectedShares * 0.02);

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
  const shares = await verifyFilledShares(result, expectedShares, tolerance);

  // Backlog 33 answered in one line: `expectedShares` was derived from our own
  // arithmetic, so whichever of takingAmount / takingAmount/1e6 sits beside it
  // reveals the wire scale. Recorded whether or not verification succeeded —
  // the null case is the one that most needs explaining.
  captureReceipt({
    fn: 'placeMarketBuy/verified',
    phase: 'response',
    request: { tokenId: String(tokenId), amountUsd: amount, maxPrice: px, expectedShares, tolerance },
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
  return {
    id,
    order: result,
    size: shares,
    price: px,
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

export async function syncClobBalance() {
  const client = await getProxyTradingClient();
  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return getClobBalance();
}

export function resetTradingClient() {
  _creds = null;
  _client = null;
  _proxyCreds = null;
  _proxyClient = null;
}
