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
 */
import type { MmVenue, PlaceRequest, Side, TickSize, VenueFill, VenueOrder } from './venue.js';

export interface DesiredQuote {
  tokenId: string; conditionId: string; event: string; side: Side; price: number; shares: number;
  tick: number; tickSize: TickSize; negRisk: boolean;
}
export interface ExecLimits {
  maxOrderShares: number; maxNetSharesPerToken: number; maxMarketUsd: number; maxPortfolioUsd: number;
  maxOpenOrders: number; maxOrdersPerMinute: number; maxLossUsd: number; restToleranceTicks: number;
  maxConsecutiveRejects: number; maxHeartbeatMisses: number; ackTimeoutMs: number; maxPositionDriftShares: number;
  /** Venue balances settle after a match; skip drift checks on a token this long after its last fill. */
  driftGraceMs: number;
}
export const CANARY_LIMITS: ExecLimits = {
  maxOrderShares: 50, maxNetSharesPerToken: 100, maxMarketUsd: 25, maxPortfolioUsd: 100,
  maxOpenOrders: 20, maxOrdersPerMinute: 60, maxLossUsd: 10, restToleranceTicks: 1,
  maxConsecutiveRejects: 5, maxHeartbeatMisses: 2, ackTimeoutMs: 15_000, maxPositionDriftShares: 0.01,
  driftGraceMs: 120_000,
};

export type OrderState = 'submitting' | 'open' | 'cancel_pending' | 'unknown' | 'filled' | 'cancelled' | 'rejected';
const LIVE: OrderState[] = ['submitting', 'open', 'cancel_pending', 'unknown'];
export interface TrackedOrder {
  clientKey: string; venueOrderId?: string; tokenId: string; conditionId: string; event: string; side: Side;
  price: number; shares: number; state: OrderState; filled: number; fillSeen: number; venueMatched: number; submittedAt: number; error?: string;
}
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

  async halt(reason: string) {
    if (!this.halted) { this.halted = reason; this.log('halt', { reason }); }
    try { await this.venue.cancelAll(); this.log('cancel_all', { ok: true }); }
    catch (e) { this.log('cancel_all', { ok: false, error: String(e?.message ?? e) }); }
    for (const o of this.liveOrders()) if (o.state === 'open' || o.state === 'submitting') o.state = 'cancel_pending';
  }

  /** One control cycle: kill checks, then move venue orders toward the desired quotes. */
  async step(desired: DesiredQuote[], marks: Map<string, number>) {
    const kill = this.killRequested();
    if (kill) await this.halt(`kill:${kill}`);
    const eq = this.equity(marks);
    if (eq == null) await this.halt('missing_mark_for_inventory');
    else if (-eq > this.limits.maxLossUsd) await this.halt(`loss_limit:${(-eq).toFixed(2)}`);
    if (this.halted) return { placed: 0, cancelled: 0 };

    const want = new Map<string, DesiredQuote>();
    for (const d of desired) {
      const key = `${d.tokenId}:${d.side}`;
      if (want.has(key)) { await this.halt(`duplicate_desired_quote:${key}`); return { placed: 0, cancelled: 0 }; }
      want.set(key, d);
      this.meta.set(d.tokenId, { conditionId: d.conditionId, event: d.event });
    }

    // Cancel what is no longer wanted or has moved outside tolerance.
    const toCancel: TrackedOrder[] = [];
    for (const o of this.liveOrders()) {
      if (o.state !== 'open') continue;
      const d = want.get(`${o.tokenId}:${o.side}`);
      const keep = d && Math.abs(d.price - o.price) <= this.limits.restToleranceTicks * d.tick + 1e-9 && d.shares === o.shares;
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

    // Place where the slot is empty.
    let placed = 0;
    for (const [key, d] of want) {
      if (this.slot(d.tokenId, d.side).length) continue;
      const why = this.preTradeCheck(d);
      if (why) { this.log('skip', { key, reason: why }); continue; }
      const now = this.clock();
      this.submits = this.submits.filter((t) => now - t < 60_000);
      if (this.submits.length >= this.limits.maxOrdersPerMinute) { this.log('skip', { key, reason: 'rate_limit' }); break; }
      this.submits.push(now);
      const clientKey = `${key}:${now}:${++this.seq}`;
      const o: TrackedOrder = { clientKey, tokenId: d.tokenId, conditionId: d.conditionId, event: d.event, side: d.side, price: d.price, shares: d.shares, state: 'submitting', filled: 0, fillSeen: 0, venueMatched: 0, submittedAt: now };
      this.orders.set(clientKey, o);
      const req: PlaceRequest = { clientKey, tokenId: d.tokenId, side: d.side, price: d.price, shares: d.shares, tickSize: d.tickSize, negRisk: d.negRisk };
      this.log('submit', { ...req });
      try {
        const r = await this.venue.place(req);
        if (r.ok && r.venueOrderId) {
          o.venueOrderId = r.venueOrderId; o.state = 'open'; this.rejects = 0; placed++;
          this.log('ack', { clientKey, venueOrderId: r.venueOrderId });
        } else {
          o.state = 'rejected'; o.error = r.error; this.rejects++;
          this.log('reject', { clientKey, error: r.error });
          if (this.rejects >= this.limits.maxConsecutiveRejects) { await this.halt(`consecutive_rejects:${r.error}`); break; }
        }
      } catch (e) {
        // The order may or may not be live. Never resubmit blind: reconciliation resolves it.
        o.state = 'unknown'; o.error = String(e?.message ?? e);
        this.log('ack_unknown', { clientKey, error: o.error });
      }
    }
    return { placed, cancelled };
  }

  /** Worst case if every open bid (and this one) fills. Null means OK. */
  preTradeCheck(d: DesiredQuote): string | null {
    const L = this.limits;
    if (!(d.price > 0 && d.price < 1) || !(d.shares > 0)) return 'invalid_quote';
    if (d.shares > L.maxOrderShares) return 'order_shares_limit';
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
    const allHeld = [...this.position.values()].reduce((s, n) => s + Math.max(0, n), 0);
    if (allHeld + bidsOn(() => true) + cost > L.maxPortfolioUsd + 1e-9) return 'portfolio_usd_limit';
    return null;
  }

  /** Apply a venue fill. Unknown order ids halt: some exposure is not ours to explain. */
  async onFill(f: VenueFill) {
    const o = [...this.orders.values()].find((x) => x.venueOrderId === f.venueOrderId);
    if (!o) { this.log('fill_unknown_order', { ...f }); await this.halt(`fill_for_unknown_order:${f.venueOrderId}`); return; }
    const key = `${f.tradeId}:${f.venueOrderId}`;
    const prev = this.fills.get(key);
    if (f.status === 'failed') {
      if (prev == null) return;
      this.fills.delete(key); o.fillSeen -= prev;
    } else {
      if (prev != null) return; // MATCHED then CONFIRMED for the same trade: count once
      this.fills.set(key, f.shares); o.fillSeen += f.shares;
    }
    this.log('fill', { ...f, clientKey: o.clientKey });
    this.setFilled(o, Math.max(o.fillSeen, o.venueMatched), 'stream');
  }

  private venueMatch(o: TrackedOrder, matched: number) {
    if (!Number.isFinite(matched)) return;
    o.venueMatched = matched;
    this.setFilled(o, Math.max(o.fillSeen, o.venueMatched), 'reconcile');
  }

  private setFilled(o: TrackedOrder, filled: number, source: string) {
    const next = Math.min(o.shares, Math.max(0, filled));
    const delta = next - o.filled;
    if (Math.abs(delta) < 1e-9) return;
    o.filled = next;
    this.lastFillAt.set(o.tokenId, this.clock());
    const sign = o.side === 'BUY' ? 1 : -1;
    this.position.set(o.tokenId, (this.position.get(o.tokenId) ?? 0) + sign * delta);
    this.cash -= sign * delta * o.price;
    if (o.filled >= o.shares - 1e-9 && LIVE.includes(o.state)) o.state = 'filled';
    this.log('position', { clientKey: o.clientKey, source, delta: sign * delta, token: o.tokenId, position: this.position.get(o.tokenId), cash: this.cash });
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
      let final: VenueOrder | null = null;
      try { final = await this.venue.getOrder(o.venueOrderId); } catch { /* treat as gone */ }
      if (final) this.venueMatch(o, final.matchedShares);
      if (LIVE.includes(o.state)) o.state = o.filled >= o.shares - 1e-9 ? 'filled' : 'cancelled';
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
        ex.orders.set(x.clientKey, { clientKey: x.clientKey, tokenId: x.tokenId, conditionId: '', event: '', side: x.side, price: x.price, shares: x.shares, state: 'unknown', filled: 0, fillSeen: 0, venueMatched: 0, submittedAt: r.at });
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
