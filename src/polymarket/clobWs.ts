// @ts-nocheck
/**
 * Polymarket CLOB market WebSocket — live UP/DOWN book + mid stream.
 * Direct egress only (no order-write proxy) — saves paid-proxy bandwidth.
 *
 * Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * Subscribe: { type: "market", assets_ids: [tokenId, ...] }
 */
import WebSocket from 'ws';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const MAX_BOOK_AGE_MS = 15_000;
const RECONNECT_MS = 2500;
const PING_MS = 20_000;

/** @type {Map<string, { bestBid:number|null, bestAsk:number|null, mid:number|null, lastTrade:number|null, ts:number, source:string }>} */
const books = new Map();

/*
 * Per-level resting size, one map per side per token. Item 70.
 *
 * `bestBid`/`bestAsk` used to be maintained as two bare scalars, which cannot
 * answer "what is underneath the top level" — so a `price_change` removing the
 * best ask set it to `null` even with size still resting one tick down. That
 * null was coerced to 0 by `clob.ts:174` and then replaced with a MID by
 * `arbEngine.ts:54`, which is how a live FOK order came to be signed at a price
 * nothing rested at (2026-09-09 run: every leg rejected against a 1,386-share
 * book).
 *
 * Prices are tick-aligned (0.001 minimum), so they are keyed as integer
 * ten-thousandths — float keys would make `delete` unreliable.
 *
 * @type {Map<string, { bids: Map<number, number>, asks: Map<number, number> }>}
 */
const levels = new Map();

const pxKey = (px) => Math.round(px * 10_000);
const keyPx = (k) => k / 10_000;

function sideMaps(assetId) {
  let m = levels.get(assetId);
  if (!m) {
    m = { bids: new Map(), asks: new Map() };
    levels.set(assetId, m);
  }
  return m;
}

/** Best resting price on a side, or null when the side is empty. */
function bestOf(map, pick) {
  let best = null;
  for (const [k, size] of map.entries()) {
    if (!(size > 0)) continue;
    if (best === null || pick(k, best)) best = k;
  }
  return best === null ? null : keyPx(best);
}

const bestBidOf = (m) => bestOf(m.bids, (k, b) => k > b);
const bestAskOf = (m) => bestOf(m.asks, (k, b) => k < b);

/*
 * Resting size at a given price. Published as `bestBidSize`/`bestAskSize` for
 * the arb depth gate (item 73): a marketable FOK is signed with `maxPrice` set
 * to exactly the best ask (`bot.ts:1011`), and every other level is by
 * definition priced above it, so **only top-of-book size is reachable**. The
 * deeper ladder is irrelevant to that order and is deliberately not published
 * here.
 */
function sizeAt(map, px) {
  if (px == null) return 0;
  const s = map.get(pxKey(px));
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/** Replace one side's levels from a snapshot array of {price,size} or [price,size]. */
function loadSide(map, rows) {
  map.clear();
  for (const r of rows || []) {
    const px = parseFloat(r?.price ?? r?.[0]);
    const size = parseFloat(r?.size ?? r?.[1]);
    if (!Number.isFinite(px) || px <= 0) continue;
    // A snapshot row with no parseable size is still a resting level; treat the
    // price as present rather than dropping it, or a snapshot in an unexpected
    // shape would silently empty the book.
    map.set(pxKey(px), Number.isFinite(size) ? size : 1);
  }
}
const listeners = new Set();
/** @type {Set<string>} */
let desired = new Set();
let ws = null;
let running = false;
let reconnectTimer = null;
let pingTimer = null;
let lastMsgAt = 0;
let connectCount = 0;
let msgCount = 0;

function emit(tokenId, snap) {
  for (const fn of listeners) {
    try { fn(tokenId, snap); } catch {}
  }
}

function usablePx(px) {
  const n = Number(px);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

/*
 * Exported as a test seam only — no call site outside this module and
 * `handleMessage`. The book maintainer is the price source every live arb leg
 * is signed against, and it had no coverage because reaching it required a live
 * WebSocket. Same reasoning as `buildSyncFrame` in telemetry/events.ts.
 */
export function upsertFromBook(assetId, bids, asks, ts) {
  if (!assetId) return;
  const m = sideMaps(String(assetId));
  loadSide(m.bids, bids);
  loadSide(m.asks, asks);
  const bidPx = bestBidOf(m);
  const askPx = bestAskOf(m);
  const rawMid = bidPx != null && askPx != null
    ? (bidPx + askPx) / 2
    : (bidPx ?? askPx ?? null);
  const prev = books.get(String(assetId)) || {};
  const snap = {
    bestBid: bidPx,
    bestAsk: askPx,
    bestBidSize: sizeAt(m.bids, bidPx),
    bestAskSize: sizeAt(m.asks, askPx),
    mid: usablePx(rawMid) ?? usablePx(prev.mid) ?? usablePx(prev.lastTrade),
    lastTrade: prev.lastTrade ?? null,
    ts: Number(ts) || Date.now(),
    source: 'clob-ws',
  };
  books.set(String(assetId), snap);
  emit(String(assetId), snap);
}

/** Test seam — see `upsertFromBook`. */
export function applyPriceChange(change, ts) {
  const assetId = String(change.asset_id || change.assetId || '');
  if (!assetId) return;
  const price = parseFloat(change.price);
  const size = parseFloat(change.size);
  const side = String(change.side || '').toUpperCase();
  const prev = books.get(assetId) || {
    bestBid: null, bestAsk: null, mid: null, lastTrade: null, ts: 0, source: 'clob-ws',
  };
  const m = sideMaps(assetId);
  /*
   * A delta sets or clears exactly one level; best-of-book is then *derived*,
   * never carried forward. Carrying it forward is what produced the null on a
   * still-deep book — see the `levels` comment above.
   */
  if (Number.isFinite(price) && price > 0) {
    const isBid = side === 'BUY' || side === 'BID';
    const isAsk = side === 'SELL' || side === 'ASK';
    if (isBid || isAsk) {
      const map = isBid ? m.bids : m.asks;
      const k = pxKey(price);
      if (!Number.isFinite(size) || size <= 0) map.delete(k);
      else map.set(k, size);
    }
  }
  const bestBid = bestBidOf(m);
  const bestAsk = bestAskOf(m);
  const rawMid = bestBid != null && bestAsk != null
    ? (bestBid + bestAsk) / 2
    : (bestBid ?? bestAsk ?? prev.mid);
  const snap = {
    bestBid,
    bestAsk,
    bestBidSize: sizeAt(m.bids, bestBid),
    bestAskSize: sizeAt(m.asks, bestAsk),
    mid: usablePx(rawMid) ?? usablePx(prev.mid) ?? usablePx(prev.lastTrade),
    lastTrade: prev.lastTrade,
    ts: Number(ts) || Date.now(),
    source: 'clob-ws',
  };
  books.set(assetId, snap);
  emit(assetId, snap);
}

function handleMessage(raw) {
  lastMsgAt = Date.now();
  msgCount += 1;
  let data;
  try { data = JSON.parse(raw.toString()); } catch { return; }

  // Initial snapshot can be an array of books
  if (Array.isArray(data)) {
    for (const item of data) {
      const assetId = item.asset_id || item.assetId || item.payload?.tokenId;
      upsertFromBook(assetId, item.bids || item.payload?.bids, item.asks || item.payload?.asks, item.timestamp || item.payload?.timestamp);
    }
    return;
  }

  const type = data.event_type || data.type || data.payload?.type;
  if (type === 'book' || data.bids || data.asks) {
    const assetId = data.asset_id || data.assetId || data.payload?.tokenId;
    upsertFromBook(
      assetId,
      data.bids || data.payload?.bids,
      data.asks || data.payload?.asks,
      data.timestamp || data.payload?.timestamp,
    );
    return;
  }

  if (type === 'price_change' || data.price_changes) {
    const changes = data.price_changes || data.payload?.price_changes || [];
    const ts = data.timestamp || data.payload?.timestamp;
    for (const c of changes) applyPriceChange(c, ts);
    return;
  }

  if (type === 'last_trade_price' || data.last_trade_price != null || data.payload?.lastTradePrice != null) {
    const assetId = String(data.asset_id || data.assetId || data.payload?.tokenId || '');
    const px = parseFloat(data.last_trade_price ?? data.price ?? data.payload?.lastTradePrice);
    if (!assetId || !Number.isFinite(px)) return;
    const prev = books.get(assetId) || {};
    const snap = {
      ...prev,
      lastTrade: px,
      mid: prev.mid ?? px,
      ts: Number(data.timestamp || data.payload?.timestamp) || Date.now(),
      source: 'clob-ws',
    };
    books.set(assetId, snap);
    emit(assetId, snap);
  }
}

function sendSubscribe(ids) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !ids.length) return;
  ws.send(JSON.stringify({ type: 'market', assets_ids: ids }));
}

function connect() {
  if (!running) return;
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  connectCount += 1;
  ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    sendSubscribe([...desired]);
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch {}
      }
    }, PING_MS);
  });
  ws.on('message', handleMessage);
  ws.on('close', () => {
    ws = null;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (!running) return;
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });
  ws.on('error', () => {
    try { ws?.close(); } catch {}
  });
}

export function onClobBook(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function startClobMarketStream(tokenIds = []) {
  running = true;
  if (tokenIds?.length) setClobMarketTokens(tokenIds);
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
}

export function stopClobMarketStream() {
  running = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

/** Replace subscribed token set (BTC/ETH up+down current + next). */
export function setClobMarketTokens(tokenIds = []) {
  const next = new Set(
    (tokenIds || []).map((id) => String(id)).filter(Boolean),
  );
  const same = next.size === desired.size && [...next].every((id) => desired.has(id));
  desired = next;
  // Windows rotate every 5 minutes, so `levels` holds a price→size map per side
  // per token and would grow without bound over a multi-day run. Drop the
  // level maps for tokens no longer subscribed; their `books` snapshot ages out
  // via MAX_BOOK_AGE_MS and is already ignored by every consumer.
  for (const id of levels.keys()) if (!desired.has(id)) levels.delete(id);
  if (!running) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
    return;
  }
  if (!same) sendSubscribe([...desired]);
}

export function getClobWsMid(tokenId) {
  const snap = books.get(String(tokenId));
  if (!snap) return null;
  if (Date.now() - snap.ts > MAX_BOOK_AGE_MS) return null;
  return Number.isFinite(snap.mid) ? snap.mid : null;
}

export function getClobWsBook(tokenId) {
  const snap = books.get(String(tokenId));
  if (!snap) return null;
  if (Date.now() - snap.ts > MAX_BOOK_AGE_MS) return { ...snap, stale: true };
  return { ...snap, stale: false };
}

export function getClobWsSnapshot() {
  const out = {};
  for (const [id, snap] of books.entries()) {
    out[id] = {
      ...snap,
      ageMs: Math.max(0, Date.now() - snap.ts),
      stale: Date.now() - snap.ts > MAX_BOOK_AGE_MS,
    };
  }
  return {
    connected: !!(ws && ws.readyState === WebSocket.OPEN),
    running,
    subscribed: desired.size,
    books: Object.keys(out).length,
    msgCount,
    connectCount,
    lastMsgAt,
    lastMsgAgeMs: lastMsgAt ? Date.now() - lastMsgAt : null,
    tokens: out,
  };
}
