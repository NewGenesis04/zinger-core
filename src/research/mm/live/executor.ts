/**
 * MM order lifecycle against an MmVenue: post-only quotes, cancel-before-replace, fill
 * accounting, reconciliation, risk limits and a latched kill switch.
 *
 * Invariants
 * - At most one non-terminal order per (token, side). A replacement is placed only after
 *   the previous order is confirmed gone, so a cancel/fill race never doubles exposure.
 * - Worst-case exposure (position plus every open bid filling) stays inside the limits
 *   before each submit. Sells are only placed against held shares.
 * - Maker fills happen at our limit price, so an order's filled size alone sets its cash
 *   effect. Filled size = max(deduplicated fills seen, venue size_matched), applied as a
 *   delta, so late, duplicate or reconciled fills are never double counted.
 * - Any unexplained state (orphan venue order, unknown order fill, position drift,
 *   repeated rejects, missed heartbeats, loss limit, kill file) halts: cancel all, stop
 *   quoting, and stay halted until a person restarts the process.
 * - Market stop: when one market's result (its cash plus marked inventory) falls below
 *   -maxMarketLossUsd, that market alone stops for the session. Its quotes are cancelled,
 *   and once nothing of it rests, held shares leave by fill-and-kill sells at the best bid.
 *   Other markets keep quoting; the portfolio loss limit still halts everything.
 */
import { TAKER_KINDS, type MmVenue, type OrderKind, type PlaceRequest, type Side, type TickSize, type VenueFill, type VenueOrder } from './venue.js';

export interface DesiredQuote {
  tokenId: string; conditionId: string; event: string; side: Side; price: number; shares: number;
  tick: number; tickSize: TickSize; negRisk: boolean;
  /** Order type (venue.ts); defaults to 'quote' (post-only, rests until cancelled). */
  kind?: OrderKind;
  /** 'quote-until' lifetime; the executor renews the order before it lapses. */
  ttlMs?: number;
}
/** Best bid and ask per token, for taker price guards and exits. A bare number is a best bid. */
export type BookTops = Map<string, number | { bid: number; ask: number }>;
export interface ExecLimits {
  maxOrderShares: number; maxNetSharesPerToken: number; maxMarketUsd: number; maxEventUsd: number; maxPortfolioUsd: number;
  maxOpenOrders: number; maxOrdersPerMinute: number; maxLossUsd: number; restToleranceTicks: number;
  /** Per-market stop: flatten and stop quoting that market for the session (0 disables). */
  maxMarketLossUsd: number;
  /** A taker (limit, ioc, fok) may not be priced more than this many ticks through the touch. */
  maxTakerSlippageTicks: number;
  /** Exit sells are priced this many ticks under the best bid, so a thin top level does not leave the exit unfilled. */
  exitSlippageTicks: number;
  maxConsecutiveRejects: number; maxHeartbeatMisses: number; ackTimeoutMs: number; maxPositionDriftShares: number;
  /** Venue balances settle after a match; skip drift checks on a token this long after its last fill. */
  driftGraceMs: number;
}
export const CANARY_LIMITS: ExecLimits = {
  maxOrderShares: 50, maxNetSharesPerToken: 100, maxMarketUsd: 25, maxEventUsd: 50, maxPortfolioUsd: 100,
  maxOpenOrders: 20, maxOrdersPerMinute: 60, maxLossUsd: 10, maxMarketLossUsd: 2.5, maxTakerSlippageTicks: 3, exitSlippageTicks: 1, restToleranceTicks: 1,
  maxConsecutiveRejects: 5, maxHeartbeatMisses: 2, ackTimeoutMs: 15_000, maxPositionDriftShares: 0.01,
  driftGraceMs: 120_000,
};

/**
 * $200 canary: reward minimums of 50 shares fit at any price inside a $50 market cap.
 * The $5 market stop is the one control that held up in the 2026-10-28 replay of five
 * recorded days (it cut the Likud jump from -$63.51 to -$5.44).
 */
export const BUDGET_200_LIMITS: ExecLimits = {
  ...CANARY_LIMITS, maxOrderShares: 100, maxNetSharesPerToken: 200, maxMarketUsd: 50, maxEventUsd: 100, maxPortfolioUsd: 200, maxLossUsd: 20, maxMarketLossUsd: 5,
};
export const LIMIT_PROFILES: Record<string, ExecLimits> = { '100': CANARY_LIMITS, '200': BUDGET_200_LIMITS };

export type OrderState = 'submitting' | 'open' | 'cancel_pending' | 'unknown' | 'filled' | 'cancelled' | 'rejected';
const LIVE: OrderState[] = ['submitting', 'open', 'cancel_pending', 'unknown'];
export interface TrackedOrder {
  clientKey: string; venueOrderId?: string; tokenId: string; conditionId: string; event: string; side: Side;
  price: number; shares: number; state: OrderState; filled: number; fillSeen: number; venueMatched: number; submittedAt: number; error?: string;
  exit?: boolean; kind?: OrderKind; expiresAt?: number;
}
export interface MarketStop { at: number; lossUsd: number }
export interface JournalRow { at: number; type: string; [k: string]: unknown }

const r0 = (x: number) => Math.round(x * 1e6) / 1e6;

export class MmLiveExecutor {
  readonly orders = new Map<string, TrackedOrder>();
  readonly position = new Map<string, number>();
  cash = 0;
  halted: string | null = null;
  private fills = new Map<string, number>();
  private submits: number[] = [];
  private rejects = 0;
  private heartbeatMisses = 0;
  private seq = 0;
  private meta = new Map<string, { conditionId: string; event: string }>();
  private lastFillAt = new Map<string, number>();
  private lookupMisses = new Map<string, number>();
  /** Net result of earlier sessions on this wallet (from the loss ledger); losses there use up the loss limit. */
  priorPnlUsd = 0;
  /** Markets stopped this session, by conditionId. The runner preloads stops from earlier today. */
  readonly stoppedMarkets = new Map<string, MarketStop>();
  /** Cash flow per market, so a market's result is its cash plus its marked inventory. */
  private marketCash = new Map<string, number>();
  /** Fills that arrived before their order's acknowledgement (an exit can fill on arrival). */
  private earlyFills: VenueFill[] = [];

  constructor(
    private venue: MmVenue,
    readonly limits: ExecLimits,
    private journal: (row: JournalRow) => void = () => {},
    private clock: () => number = Date.now,
    private killRequested: () => string | null = () => null,
  ) {
    for (const [k, v] of Object.entries(limits)) if (!Number.isFinite(v) || v < 0) throw Error(`Invalid execution limit ${k}`);
  }

  private log(type: string, data: Record<string, unknown> = {}) { this.journal({ at: this.clock(), type, ...data }); }
  liveOrders() { return [...this.orders.values()].filter((o) => LIVE.includes(o.state)); }
  private slot(tokenId: string, side: Side) { return this.liveOrders().filter((o) => o.tokenId === tokenId && o.side === side); }

  /** Cash plus marked inventory; the loss limit is measured from zero (session start). */
  equity(marks: Map<string, number>) {
    let v = this.cash;
    for (const [token, shares] of this.position) {
      const m = marks.get(token);
      if (shares !== 0 && m == null) return null;
      v += shares * (m ?? 0);
    }
    return v;
  }

  /** One market's cash plus marked inventory. Null if a held token has no mark. */
  marketPnl(conditionId: string, marks: Map<string, number>) {
    let v = this.marketCash.get(conditionId) ?? 0;
    for (const [token, shares] of this.position) {
      if (this.meta.get(token)?.conditionId !== conditionId || Math.abs(shares) < 1e-9) continue;
      const m = marks.get(token);
      if (m == null) return null;
      v += shares * m;
    }
    return v;
  }

  private tokensOf(conditionId: string) { return [...this.meta].filter(([, m]) => m.conditionId === conditionId).map(([t]) => t); }

  async halt(reason: string) {
    if (!this.halted) { this.halted = reason; this.log('halt', { reason }); }
    try { await this.venue.cancelAll(); this.log('cancel_all', { ok: true }); }
    catch (e) { this.log('cancel_all', { ok: false, error: String(e?.message ?? e) }); }
    for (const o of this.liveOrders()) if (o.state === 'open' || o.state === 'submitting') o.state = 'cancel_pending';
  }

  /**
   * One control cycle: kill and loss checks, market stops, then move venue orders toward the
   * desired quotes. `tops` (best bid and ask per token) guards taker prices and prices the
   * exit sells of stopped markets.
   */
  async step(desired: DesiredQuote[], marks: Map<string, number>, tops: BookTops = new Map()) {
    this.tops = tops;
    const kill = this.killRequested();
    if (kill) await this.halt(`kill:${kill}`);
    const eq = this.equity(marks);
    if (eq == null) await this.halt('missing_mark_for_inventory');
    else if (-(eq + this.priorPnlUsd) > this.limits.maxLossUsd) await this.halt(`loss_limit:${(-(eq + this.priorPnlUsd)).toFixed(2)}`);
    if (this.halted) return { placed: 0, cancelled: 0 };

    const want = new Map<string, DesiredQuote>();
    for (const d of desired) {
      const key = `${d.tokenId}:${d.side}`;
      if (want.has(key)) { await this.halt(`duplicate_desired_quote:${key}`); return { placed: 0, cancelled: 0 }; }
      this.meta.set(d.tokenId, { conditionId: d.conditionId, event: d.event });
      if (!this.stoppedMarkets.has(d.conditionId)) want.set(key, d);
    }

    // Market stops, checked on every market we have traded or quoted.
    if (this.limits.maxMarketLossUsd > 0) {
      const markets = new Set([...this.marketCash.keys(), ...[...this.meta.values()].map((m) => m.conditionId)]);
      for (const c of markets) {
        if (this.stoppedMarkets.has(c)) continue;
        const pnl = this.marketPnl(c, marks);
        if (pnl == null || -pnl <= this.limits.maxMarketLossUsd) continue;
        this.stoppedMarkets.set(c, { at: this.clock(), lossUsd: -pnl });
        this.log('market_stop', { conditionId: c, lossUsd: -pnl, positions: Object.fromEntries(this.tokensOf(c).map((t) => [t, this.position.get(t) ?? 0])) });
        for (const [k, d] of want) if (d.conditionId === c) want.delete(k);
      }
    }

    // Cancel what is no longer wanted or has moved outside tolerance.
    const toCancel: TrackedOrder[] = [];
    for (const o of this.liveOrders()) {
      if (o.state !== 'open') continue;
      const d = want.get(`${o.tokenId}:${o.side}`);
      // Same price (within tolerance), size and type; an expiring quote is renewed a minute before it lapses.
      const keep = d && Math.abs(d.price - o.price) <= this.limits.restToleranceTicks * d.tick + 1e-9 && d.shares === o.shares
        && (d.kind ?? 'quote') === (o.kind ?? 'quote') && !(o.expiresAt != null && o.expiresAt - this.clock() < 60_000);
      if (!keep) toCancel.push(o);
    }
    let cancelled = 0;
    if (toCancel.length) {
      for (const o of toCancel) o.state = 'cancel_pending';
      const ids = toCancel.map((o) => o.venueOrderId!);
      try {
        const r = await this.venue.cancel(ids);
        cancelled = r.cancelled.length;
        this.log('cancel', { ids, cancelled: r.cancelled, failed: r.failed });
        for (const o of toCancel) if (r.cancelled.includes(o.venueOrderId!)) o.state = 'cancelled';
        // A failed cancel stays cancel_pending; reconciliation decides whether it filled or is gone.
      } catch (e) { this.log('cancel_error', { ids, error: String(e?.message ?? e) }); }
    }

    // Place where the slot is empty. A halt can land during any awaited venue call
    // (signal, user-channel fill, heartbeat), so it is rechecked before every submit.
    let placed = 0;
    // Exits first: a stopped market's held shares, once nothing of that token rests.
    for (const c of this.stoppedMarkets.keys()) {
      for (const token of this.tokensOf(c)) {
        if (this.halted || this.killRequested()) break;
        // Shares go out in order-size chunks; whatever is left sells on the next cycle.
        const held = Math.min(this.limits.maxOrderShares, Math.floor((this.position.get(token) ?? 0) * 100 + 1e-6) / 100);
        if (held <= 0 || this.liveOrders().some((o) => o.tokenId === token)) continue;
        const bid = this.top(token)?.bid;
        if (!(bid != null && bid > 0 && bid < 1)) { this.log('skip', { key: `${token}:EXIT`, reason: 'no_bid_for_exit' }); continue; }
        const m = this.meta.get(token)!, last = desired.find((d) => d.tokenId === token);
        const tick = last?.tick ?? this.ticks.get(token) ?? 0.01;
        // Fill-and-kill a few ticks under the bid: the venue still fills at the best price available.
        const worst = Math.max(tick, Math.round((bid - this.limits.exitSlippageTicks * tick) / tick) * tick);
        const d: DesiredQuote = { tokenId: token, conditionId: c, event: m.event, side: 'SELL', price: +worst.toFixed(6), shares: held, tick, tickSize: last?.tickSize ?? this.tickSizes.get(token) ?? '0.01', negRisk: last?.negRisk ?? this.negRisk.get(token) ?? false, kind: 'ioc' };
        const r = await this.submit(`${token}:EXIT`, d, true);
        if (r === 'stop') break;
        if (r === 'placed') placed++;
      }
    }
    for (const [key, d] of want) {
      if (this.halted || this.killRequested()) break;
      if (this.slot(d.tokenId, d.side).length) continue;
      this.tickSizes.set(d.tokenId, d.tickSize); this.negRisk.set(d.tokenId, d.negRisk); this.ticks.set(d.tokenId, d.tick);
      const r = await this.submit(key, d, false);
      if (r === 'stop') break;
      if (r === 'placed') placed++;
    }
    const late = this.killRequested();
    if (late && !this.halted) await this.halt(`kill:${late}`);
    return { placed, cancelled };
  }

  private tickSizes = new Map<string, DesiredQuote['tickSize']>();
  private negRisk = new Map<string, boolean>();
  private ticks = new Map<string, number>();
  private tops: BookTops = new Map();
  private top(token: string) { const t = this.tops.get(token); return t == null ? null : typeof t === 'number' ? { bid: t, ask: NaN } : t; }

  /** Risk check, rate limit, submit and acknowledgement for one order. 'stop' ends the cycle. */
  private async submit(key: string, d: DesiredQuote, exit: boolean): Promise<'placed' | 'skipped' | 'rejected' | 'unknown' | 'stop'> {
    const why = this.preTradeCheck(d);
    if (why) { this.log('skip', { key, reason: why }); return 'skipped'; }
    const now = this.clock();
    this.submits = this.submits.filter((t) => now - t < 60_000);
    if (this.submits.length >= this.limits.maxOrdersPerMinute) { this.log('skip', { key, reason: 'rate_limit' }); return 'stop'; }
    this.submits.push(now);
    const clientKey = `${key}:${now}:${++this.seq}`;
    const kind = d.kind ?? 'quote';
    const expiresAt = kind === 'quote-until' ? now + (d.ttlMs ?? 180_000) : undefined;
    const o: TrackedOrder = { clientKey, tokenId: d.tokenId, conditionId: d.conditionId, event: d.event, side: d.side, price: d.price, shares: d.shares, state: 'submitting', filled: 0, fillSeen: 0, venueMatched: 0, submittedAt: now, kind, ...(expiresAt ? { expiresAt } : {}), ...(exit ? { exit: true } : {}) };
    this.orders.set(clientKey, o);
    const req: PlaceRequest = { clientKey, tokenId: d.tokenId, side: d.side, price: d.price, shares: d.shares, tickSize: d.tickSize, negRisk: d.negRisk, kind, ...(expiresAt ? { expiresAt } : {}), ...(exit ? { exit: true } : {}) };
    this.log('submit', { ...req });
    try {
      const r = await this.venue.place(req);
      if (r.ok && r.venueOrderId) {
        o.venueOrderId = r.venueOrderId; this.rejects = 0;
        if (o.state === 'submitting') o.state = 'open';
        this.log('ack', { clientKey, venueOrderId: r.venueOrderId });
        await this.replayEarlyFills(o);
        // Halted while this order was in flight: halt's cancel-all may have run before it rested.
        if (this.halted) { await this.halt(this.halted); return 'stop'; }
        return 'placed';
      }
      o.state = 'rejected'; o.error = r.error; this.rejects++;
      this.log('reject', { clientKey, error: r.error });
      if (this.rejects >= this.limits.maxConsecutiveRejects) { await this.halt(`consecutive_rejects:${r.error}`); return 'stop'; }
      return 'rejected';
    } catch (e) {
      // The order may or may not be live. Never resubmit blind: reconciliation resolves it.
      o.state = 'unknown'; o.error = String(e?.message ?? e);
      this.log('ack_unknown', { clientKey, error: o.error });
      return 'unknown';
    }
  }

  private async replayEarlyFills(o: TrackedOrder) {
    const mine = this.earlyFills.filter((f) => f.venueOrderId === o.venueOrderId);
    if (!mine.length) return;
    this.earlyFills = this.earlyFills.filter((f) => f.venueOrderId !== o.venueOrderId);
    for (const f of mine) await this.onFill(f);
  }

  /** Worst case if every open bid (and this one) fills. Null means OK. */
  preTradeCheck(d: DesiredQuote): string | null {
    const L = this.limits;
    if (!(d.price > 0 && d.price < 1) || !(d.shares > 0)) return 'invalid_quote';
    if (d.shares > L.maxOrderShares) return 'order_shares_limit';
    // A taker must name a worst price no further than maxTakerSlippageTicks through the touch.
    if (TAKER_KINDS.includes(d.kind ?? 'quote')) {
      const t = this.top(d.tokenId);
      const ref = d.side === 'BUY' ? t?.ask : t?.bid;
      if (ref == null || !Number.isFinite(ref)) return 'taker_without_book';
      const through = d.side === 'BUY' ? d.price - ref : ref - d.price;
      if (through > L.maxTakerSlippageTicks * d.tick + 1e-9) return 'taker_price_outside_guard';
    }
    if (this.liveOrders().length >= L.maxOpenOrders) return 'open_orders_limit';
    const live = this.liveOrders();
    const held = this.position.get(d.tokenId) ?? 0;
    if (d.side === 'SELL') {
      const selling = live.filter((o) => o.tokenId === d.tokenId && o.side === 'SELL').reduce((s, o) => s + o.shares - o.filled, 0);
      return held + 1e-9 >= selling + d.shares ? null : 'sell_without_inventory';
    }
    const bidsOn = (pred: (o: TrackedOrder) => boolean) => live.filter((o) => o.side === 'BUY' && pred(o)).reduce((s, o) => s + (o.shares - o.filled) * o.price, 0);
    const openBuyShares = live.filter((o) => o.tokenId === d.tokenId && o.side === 'BUY').reduce((s, o) => s + o.shares - o.filled, 0);
    if (held + openBuyShares + d.shares > L.maxNetSharesPerToken + 1e-9) return 'net_shares_limit';
    const cost = d.shares * d.price;
    const marketHeld = [...this.position].filter(([t]) => this.meta.get(t)?.conditionId === d.conditionId).reduce((s, [, n]) => s + Math.max(0, n), 0);
    // Inventory is valued at 1 per share (worst case) for the capital caps.
    if (marketHeld + bidsOn((o) => o.conditionId === d.conditionId) + cost > L.maxMarketUsd + 1e-9) return 'market_usd_limit';
    const eventHeld = [...this.position].filter(([t]) => this.meta.get(t)?.event === d.event).reduce((s, [, n]) => s + Math.max(0, n), 0);
    if (eventHeld + bidsOn((o) => o.event === d.event) + cost > L.maxEventUsd + 1e-9) return 'event_usd_limit';
    const allHeld = [...this.position.values()].reduce((s, n) => s + Math.max(0, n), 0);
    if (allHeld + bidsOn(() => true) + cost > L.maxPortfolioUsd + 1e-9) return 'portfolio_usd_limit';
    return null;
  }

  /** Apply a venue fill. Unknown order ids halt: some exposure is not ours to explain. */
  async onFill(f: VenueFill) {
    const o = [...this.orders.values()].find((x) => x.venueOrderId === f.venueOrderId);
    if (!o) {
      // An order still awaiting its ack on this token and side may own it: hold the fill until the ack.
      if (this.liveOrders().some((x) => x.state === 'submitting' && !x.venueOrderId && x.tokenId === f.tokenId && x.side === f.side)) {
        this.earlyFills.push(f); this.log('fill_before_ack', { ...f }); return;
      }
      this.log('fill_unknown_order', { ...f }); await this.halt(`fill_for_unknown_order:${f.venueOrderId}`); return;
    }
    const key = `${f.tradeId}:${f.venueOrderId}`;
    const prev = this.fills.get(key);
    if (f.status === 'failed') {
      if (prev == null) return;
      this.fills.delete(key); o.fillSeen -= prev;
      // A reconciled size_matched taken before the failure counted this trade too; drop it until the venue reports again.
      o.venueMatched = Math.max(0, o.venueMatched - prev);
    } else {
      if (prev != null) return; // MATCHED then CONFIRMED for the same trade: count once
      this.fills.set(key, f.shares); o.fillSeen += f.shares;
    }
    this.log('fill', { ...f, clientKey: o.clientKey });
    // A taker exit can fill better than its limit; maker quotes fill at their own price.
    // A taker can fill better than its limit; a resting quote fills at its own price.
    const taker = o.exit || TAKER_KINDS.includes(o.kind ?? 'quote');
    this.setFilled(o, Math.max(o.fillSeen, o.venueMatched), 'stream', taker && f.price > 0 && f.price < 1 ? f.price : o.price);
  }

  private venueMatch(o: TrackedOrder, matched: number) {
    if (!Number.isFinite(matched)) return;
    o.venueMatched = matched;
    this.setFilled(o, Math.max(o.fillSeen, o.venueMatched), 'reconcile');
  }

  /** `price` defaults to the order's limit, the worst case for a reconciled exit whose fill price is unknown. */
  private setFilled(o: TrackedOrder, filled: number, source: string, price = o.price) {
    const next = Math.min(o.shares, Math.max(0, filled));
    const delta = next - o.filled;
    if (Math.abs(delta) < 1e-9) return;
    o.filled = next;
    this.lastFillAt.set(o.tokenId, this.clock());
    const sign = o.side === 'BUY' ? 1 : -1;
    this.position.set(o.tokenId, (this.position.get(o.tokenId) ?? 0) + sign * delta);
    this.cash -= sign * delta * price;
    const market = o.conditionId || this.meta.get(o.tokenId)?.conditionId || '';
    this.marketCash.set(market, (this.marketCash.get(market) ?? 0) - sign * delta * price);
    if (o.filled >= o.shares - 1e-9 && LIVE.includes(o.state)) o.state = 'filled';
    this.log('position', { clientKey: o.clientKey, source, delta: sign * delta, price, token: o.tokenId, conditionId: market, position: this.position.get(o.tokenId), cash: this.cash, marketCash: this.marketCash.get(market) });
  }

  /**
   * Compare tracked orders with the venue. Resolves unknown acknowledgements, closes orders
   * the venue no longer has, raises filled size to venue size_matched, cancels and halts
   * on orphans, and checks inventory against venue balances when available.
   */
  async reconcile() {
    const now = this.clock();
    let open: VenueOrder[];
    try { open = await this.venue.openOrders(); }
    catch (e) { this.log('reconcile_error', { error: String(e?.message ?? e) }); return; }
    const byId = new Map(open.map((v) => [v.id, v]));
    const known = new Set([...this.orders.values()].map((o) => o.venueOrderId).filter(Boolean));

    for (const o of this.liveOrders()) {
      if (o.state === 'unknown' || (o.state === 'submitting' && !o.venueOrderId)) {
        const match = open.find((v) => !known.has(v.id) && v.tokenId === o.tokenId && v.side === o.side && Math.abs(v.price - o.price) < 1e-9 && Math.abs(v.originalShares - o.shares) < 1e-9);
        if (match) { o.venueOrderId = match.id; o.state = 'open'; known.add(match.id); this.log('adopt', { clientKey: o.clientKey, venueOrderId: match.id }); this.venueMatch(o, match.matchedShares); }
        else if (now - o.submittedAt > this.limits.ackTimeoutMs) {
          // Not resting. It may have filled instantly; post-only makes that unlikely, and the
          // position drift check below catches it if it did.
          o.state = 'rejected'; o.error = 'not_found_after_ack_timeout'; this.log('unknown_resolved', { clientKey: o.clientKey, state: o.state });
        }
        continue;
      }
      if (!o.venueOrderId) continue;
      const v = byId.get(o.venueOrderId);
      if (v) { this.venueMatch(o, v.matchedShares); continue; }
      // Missing from the open list is not proof it is gone: close only on a terminal status.
      let final: VenueOrder | null = null, lookupError: string | null = null;
      try { final = await this.venue.getOrder(o.venueOrderId); } catch (e) { lookupError = String(e?.message ?? e); }
      if (!final || final.status === 'open' || final.status === 'unknown') {
        if (final) this.venueMatch(o, final.matchedShares);
        const misses = (this.lookupMisses.get(o.clientKey) ?? 0) + 1;
        this.lookupMisses.set(o.clientKey, misses);
        this.log('order_unconfirmed', { clientKey: o.clientKey, venueOrderId: o.venueOrderId, misses, status: final?.status ?? null, error: lookupError });
        if (!final && misses >= 3) { await this.halt(`order_state_unconfirmed:${o.venueOrderId}`); break; }
        continue;
      }
      this.lookupMisses.delete(o.clientKey);
      this.venueMatch(o, final.matchedShares);
      if (LIVE.includes(o.state)) o.state = final.status === 'filled' || o.filled >= o.shares - 1e-9 ? 'filled' : 'cancelled';
      this.log('closed', { clientKey: o.clientKey, venueOrderId: o.venueOrderId, state: o.state, filled: o.filled });
    }

    const orphans = open.filter((v) => !known.has(v.id));
    if (orphans.length) {
      this.log('orphans', { ids: orphans.map((v) => v.id) });
      try { await this.venue.cancel(orphans.map((v) => v.id)); } catch { /* halt cancels all */ }
      await this.halt('orphan_venue_orders');
    }

    if (this.venue.positions) {
      let held: Map<string, number> | null = null;
      try { held = await this.venue.positions(); } catch (e) { this.log('positions_error', { error: String(e?.message ?? e) }); }
      if (held) {
        const tokens = new Set([...this.position.keys(), ...[...held.keys()].filter((t) => this.meta.has(t))]);
        for (const t of tokens) {
          if (this.clock() - (this.lastFillAt.get(t) ?? -Infinity) < this.limits.driftGraceMs) continue;
          const drift = (held.get(t) ?? 0) - (this.position.get(t) ?? 0);
          if (Math.abs(drift) > this.limits.maxPositionDriftShares) { this.log('drift', { token: t, venue: held.get(t) ?? 0, ledger: this.position.get(t) ?? 0 }); await this.halt(`position_drift:${t}`); break; }
        }
      }
    }
  }

  async heartbeat() {
    let ok = false;
    try { ok = await this.venue.heartbeat(); } catch { ok = false; }
    this.heartbeatMisses = ok ? 0 : this.heartbeatMisses + 1;
    if (!ok) this.log('heartbeat_miss', { misses: this.heartbeatMisses });
    if (this.heartbeatMisses >= this.limits.maxHeartbeatMisses) await this.halt('heartbeat_missed');
    return ok;
  }

  /** Clean stop: cancel everything, then confirm nothing rests. */
  async shutdown(reason = 'shutdown') {
    await this.halt(reason);
    await this.reconcile();
    return this.liveOrders().length === 0;
  }

  /** Rebuild ledger and order book state from journal rows after a restart. */
  static restore(rows: JournalRow[], venue: MmVenue, limits: ExecLimits, journal?: (r: JournalRow) => void, clock?: () => number, kill?: () => string | null) {
    const ex = new MmLiveExecutor(venue, limits, journal, clock, kill);
    for (const r of rows) {
      if (r.type === 'submit') {
        const x = r as any;
        ex.orders.set(x.clientKey, { clientKey: x.clientKey, tokenId: x.tokenId, conditionId: '', event: '', side: x.side, price: x.price, shares: x.shares, state: 'unknown', filled: 0, fillSeen: 0, venueMatched: 0, submittedAt: r.at, ...(x.kind ? { kind: x.kind } : {}), ...(x.expiresAt ? { expiresAt: x.expiresAt } : {}), ...(x.exit ? { exit: true } : {}) });
      } else if (r.type === 'ack') { const o = ex.orders.get(r.clientKey as string); if (o) { o.venueOrderId = r.venueOrderId as string; o.state = 'open'; } }
      else if (r.type === 'reject') { const o = ex.orders.get(r.clientKey as string); if (o) o.state = 'rejected'; }
      else if (r.type === 'adopt') { const o = ex.orders.get(r.clientKey as string); if (o) { o.venueOrderId = r.venueOrderId as string; o.state = 'open'; } }
      else if (r.type === 'closed') { const o = ex.orders.get(r.clientKey as string); if (o) o.state = r.state as OrderState; }
      else if (r.type === 'fill' && r.status !== 'failed') ex.fills.set(`${r.tradeId}:${r.venueOrderId}`, r.shares as number);
      else if (r.type === 'fill' && r.status === 'failed') ex.fills.delete(`${r.tradeId}:${r.venueOrderId}`);
      else if (r.type === 'position') {
        const o = ex.orders.get(r.clientKey as string);
        const delta = r.delta as number;
        if (o) o.filled += o.side === 'BUY' ? delta : -delta;
        ex.position.set(r.token as string, r.position as number);
        ex.cash = r.cash as number;
        if (typeof r.conditionId === 'string') {
          ex.marketCash.set(r.conditionId, r.marketCash as number);
          if (r.conditionId) ex.meta.set(r.token as string, { conditionId: r.conditionId, event: ex.meta.get(r.token as string)?.event ?? '' });
        }
      } else if (r.type === 'market_stop') {
        ex.stoppedMarkets.set(r.conditionId as string, { at: r.at, lossUsd: r.lossUsd as number });
      } else if (r.type === 'cancel') {
        for (const id of (r.cancelled as string[]) ?? []) { const o = [...ex.orders.values()].find((x) => x.venueOrderId === id); if (o) o.state = 'cancelled'; }
      }
    }
    for (const o of ex.orders.values()) {
      o.fillSeen = [...ex.fills].filter(([k]) => o.venueOrderId && k.endsWith(`:${o.venueOrderId}`)).reduce((s, [, n]) => s + n, 0);
      o.venueMatched = r0(o.filled - o.fillSeen) > 0 ? o.filled : 0;
      if (o.state === 'open' && o.filled >= o.shares - 1e-9) o.state = 'filled';
    }
    ex.log('restored', { orders: ex.liveOrders().length, positions: Object.fromEntries(ex.position), cash: ex.cash });
    return ex;
  }
}
