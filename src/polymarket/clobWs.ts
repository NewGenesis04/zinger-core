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
/**
 * Total silence after which the stream is treated as dead — backlog 96.
 *
 * `readyState` only reports the socket, not the feed: a half-open connection
 * stays OPEN indefinitely, so the stream can report connected while delivering
 * nothing and every book quietly ages out. Pings alone do not detect it, because
 * nothing checks that anything comes back.
 *
 * Well above the gaps a live book actually shows (updates arrive many times a
 * minute across the subscribed set), so this fires on a dead feed, not a quiet
 * one.
 */
const STALE_MS = Number(process.env.CLOB_WS_STALE_MS) || 120_000;

/** @type {Map<string, { bestBid:number|null, bestAsk:number|null, mid:number|null, lastTrade:number|null, ts:number, source:string }>} */
const books = new Map();

/*
 * Per-level resting size, one map per side per token. Item 70.
 *
 * Two bare `bestBid`/`bestAsk` scalars cannot answer "what is underneath the top
 * level": a `price_change` removing the best ask would null it even with size
 * still resting one tick down, and a missing ask lets downstream code price an
 * order off something that is not an ask. Keeping every level means removing
 * the top one reveals the next.
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
let staleReconnects = 0;

/**
 * Feed status, reported as transitions rather than attempts (item 111).
 *
 * While the socket is down, book reads fall back to REST through the metered
 * proxy (items 92, 96), so when an outage began, why, and how long it lasted
 * are what cost money. A reconnect loop retries every `RECONNECT_MS`, and
 * logging each attempt would bury that. So this reports two things: the drop,
 * with its cause and how long the feed had been silent, and the recovery, with
 * the downtime and the number of attempts.
 *
 * Pure, so the transitions are testable without a socket.
 */
export function wsTransition(state, ev, now = Date.now()) {
  const st = { downSince: null, attempts: 0, pendingCause: null, ...state };
  switch (ev.type) {
    case 'stale':
      return { state: { ...st, pendingCause: `feed silent ${Math.round((ev.silentMs || 0) / 1000)}s while connected` }, report: null };
    case 'error':
      // The library closes after an error; the close carries the report.
      return { state: { ...st, pendingCause: st.pendingCause || `error: ${String(ev.message || 'unknown').slice(0, 120)}` }, report: null };
    case 'close': {
      const cause = st.pendingCause || `closed (code ${ev.code ?? '?'}${ev.reason ? `, ${ev.reason}` : ''})`;
      if (st.downSince == null) {
        return {
          state: { downSince: now, attempts: 1, pendingCause: null },
          report: { kind: 'down', cause, code: ev.code ?? null, sinceLastMsgMs: ev.lastMsgAt ? now - ev.lastMsgAt : null },
        };
      }
      return { state: { ...st, attempts: st.attempts + 1, pendingCause: null }, report: null };
    }
    case 'open':
      if (st.downSince == null) return { state: st, report: null };
      return {
        state: { downSince: null, attempts: 0, pendingCause: null },
        report: { kind: 'up', downMs: now - st.downSince, attempts: st.attempts },
      };
    default:
      return { state: st, report: null };
  }
}

const statusListeners = new Set();
let wsStatus = { downSince: null, attempts: 0, pendingCause: null };

function noteWs(ev) {
  const { state, report } = wsTransition(wsStatus, ev);
  wsStatus = state;
  if (!report) return;
  for (const fn of statusListeners) {
    try { fn(report); } catch {}
  }
}

/** Subscribe to feed drops and recoveries. Returns an unsubscribe function. */
export function onClobWsStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

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
    // A fresh socket has delivered nothing yet; without this the staleness check
    // would judge it on the previous connection's last message.
    lastMsgAt = Date.now();
    noteWs({ type: 'open' });
    sendSubscribe([...desired]);
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      try { ws.ping(); } catch {}
      // A ping proves nothing on its own — nothing checks for a reply. Silence
      // across the whole subscribed set is the signal (backlog 96). Closing
      // takes the existing reconnect path rather than adding a second one.
      if (isStreamStale({ connected: true, subscribed: desired.size, lastMsgAt })) {
        staleReconnects += 1;
        console.warn(`[clob-ws] feed silent ${Math.round((Date.now() - lastMsgAt) / 1000)}s while connected — reconnecting (${staleReconnects})`);
        noteWs({ type: 'stale', silentMs: Date.now() - lastMsgAt });
        try { ws.close(); } catch {}
      }
    }, PING_MS);
  });
  ws.on('message', handleMessage);
  ws.on('close', (code, reason) => {
    ws = null;
    if (running) noteWs({ type: 'close', code, reason: reason ? String(reason) : '', lastMsgAt });
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (!running) return;
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });
  ws.on('error', (err) => {
    noteWs({ type: 'error', message: err?.message });
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

/**
 * Has the feed gone silent while claiming to be connected?
 *
 * Pure so the policy is testable without a socket. Silence only counts when
 * something is subscribed and at least one message has ever arrived: a stream
 * that has just connected, or one with nothing to deliver, is not stale.
 */
export function isStreamStale({ connected, subscribed, lastMsgAt: last, now = Date.now(), staleMs = STALE_MS }) {
  if (!connected || !subscribed) return false;
  if (!(Number(last) > 0)) return false;
  return now - Number(last) > Number(staleMs);
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
    // Connected is about the socket; this is about the feed (backlog 96).
    stale: isStreamStale({
      connected: !!(ws && ws.readyState === WebSocket.OPEN),
      subscribed: desired.size,
      lastMsgAt,
    }),
    staleReconnects,
    tokens: out,
  };
}
