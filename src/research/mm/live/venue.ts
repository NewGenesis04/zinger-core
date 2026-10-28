/**
 * Venue boundary for MM execution. The executor only talks to an MmVenue, so the same
 * order lifecycle runs against the in-memory dry-run venue (default) or the CLOB adapter.
 */
export type Side = 'BUY' | 'SELL';
export type TickSize = '0.1' | '0.01' | '0.005' | '0.0025' | '0.001' | '0.0001';

/**
 * Order types, in plain terms. Every one carries a limit price, so no order can fill
 * worse than the price it was sent with.
 *
 * | kind        | Takes liquidity? | Rests?             | CLOB          | Use                                  |
 * |-------------|------------------|--------------------|---------------|--------------------------------------|
 * | quote       | never (rejected) | until cancelled    | GTC post-only | market-making quotes (default)       |
 * | quote-until | never (rejected) | until `expiresAt`  | GTD post-only | quotes that expire on their own      |
 * | limit       | yes, at ≤ price  | the rest, GTC      | GTC           | work an order, accept some crossing  |
 * | ioc         | yes, at ≤ price  | no: rest cancelled | FAK           | "market" order with a worst price    |
 * | fok         | all or nothing   | no                 | FOK           | all-or-nothing at a worst price      |
 */
export type OrderKind = 'quote' | 'quote-until' | 'limit' | 'ioc' | 'fok';
export const TAKER_KINDS: readonly OrderKind[] = ['limit', 'ioc', 'fok'];
export const RESTING_KINDS: readonly OrderKind[] = ['quote', 'quote-until', 'limit'];
/** Polymarket applies a one-minute security threshold to GTD expiries; shorter ones are refused here. */
export const MIN_GTD_LIFETIME_MS = 90_000;

export interface PlaceRequest {
  clientKey: string; tokenId: string; side: Side; price: number; shares: number;
  tickSize: TickSize; negRisk: boolean;
  /** Defaults to 'quote'. */
  kind?: OrderKind;
  /** Epoch ms; required for 'quote-until'. */
  expiresAt?: number;
  /** Exit sell after a market stop (an 'ioc' sell that may only reduce inventory). */
  exit?: boolean;
}
export const kindOf = (r: { kind?: OrderKind; exit?: boolean }): OrderKind => r.kind ?? (r.exit ? 'ioc' : 'quote');

export interface PlaceResult { ok: boolean; venueOrderId?: string; error?: string }
export interface VenueOrder {
  id: string; tokenId: string; side: Side; price: number; originalShares: number; matchedShares: number;
  status: 'open' | 'filled' | 'cancelled' | 'unknown'; createdAt?: number;
}
/** One fill, already reduced to our order. `failed` reverses an earlier match. */
export interface VenueFill {
  tradeId: string; venueOrderId: string; tokenId: string; side: Side; price: number; shares: number;
  status: 'matched' | 'confirmed' | 'failed'; at: number;
}

export interface MmVenue {
  readonly kind: 'dry-run' | 'clob';
  place(request: PlaceRequest): Promise<PlaceResult>;
  cancel(ids: string[]): Promise<{ cancelled: string[]; failed: string[] }>;
  cancelAll(): Promise<void>;
  openOrders(): Promise<VenueOrder[]>;
  getOrder(id: string): Promise<VenueOrder | null>;
  /** Dead-man switch. False (or a throw) counts as a missed heartbeat. */
  heartbeat(): Promise<boolean>;
  /** Venue-side token balances, for drift checks. Optional. */
  positions?(): Promise<Map<string, number>>;
}

/**
 * In-memory venue that behaves like the CLOB for each order kind, against the last book
 * top fed by `touch()`:
 * - quotes that would cross are rejected (post-only), and rest until the book trades
 *   through them (a resting bid fills only when the best ask drops below it);
 * - 'quote-until' orders expire at `expiresAt`;
 * - takers fill at the touch when marketable (never worse than their limit), up to
 *   `takerFillShares` if set; 'ioc' cancels the rest, 'fok' fills fully or not at all,
 *   'limit' rests the rest.
 * Failure hooks exist for tests.
 */
export class DryRunVenue implements MmVenue {
  readonly kind = 'dry-run' as const;
  private orders = new Map<string, VenueOrder & { expiresAt?: number }>();
  private seq = 0;
  private fillSeq = 0;
  private held = new Map<string, number>();
  private tops = new Map<string, { bid: number; ask: number }>();
  readonly sent: PlaceRequest[] = [];
  failNextPlace: string | null = null;
  throwNextPlace = false;
  /** Accept the order but throw before returning, as a lost acknowledgement would. */
  loseNextAck = false;
  heartbeatOk = true;
  /** Visible size available to a taker (tests of a thin book). Null fills it all. */
  takerFillShares: number | null = null;
  /** Older name for takerFillShares. */
  get exitFillShares() { return this.takerFillShares; }
  set exitFillShares(v: number | null) { this.takerFillShares = v; }
  onFill: (fill: VenueFill) => void = () => {};

  constructor(private clock: () => number = Date.now) {}

  async place(r: PlaceRequest): Promise<PlaceResult> {
    this.sent.push(r);
    if (this.throwNextPlace) { this.throwNextPlace = false; throw new Error('network: request timed out'); }
    if (this.failNextPlace) { const error = this.failNextPlace; this.failNextPlace = null; return { ok: false, error }; }
    const kind = kindOf(r), top = this.tops.get(r.tokenId);
    const crosses = !!top && (r.side === 'BUY' ? r.price >= top.ask - 1e-9 : r.price <= top.bid + 1e-9);
    if ((kind === 'quote' || kind === 'quote-until') && crosses) return { ok: false, error: 'post_only_would_cross' };
    if (kind === 'quote-until' && !(Number(r.expiresAt) >= this.clock() + MIN_GTD_LIFETIME_MS)) return { ok: false, error: 'expiry_too_soon' };
    // With no book top fed yet (unit tests), a taker is assumed marketable at its own limit.
    const marketable = top ? crosses : true;
    const available = Math.min(r.shares, this.takerFillShares ?? r.shares);
    if (kind === 'fok' && (!marketable || available < r.shares - 1e-9)) return { ok: false, error: 'fok_not_filled' };
    const id = `dry-${++this.seq}`;
    this.orders.set(id, { id, tokenId: r.tokenId, side: r.side, price: r.price, originalShares: r.shares, matchedShares: 0, status: 'open', createdAt: this.clock(), expiresAt: r.expiresAt });
    if (this.loseNextAck) { this.loseNextAck = false; throw new Error('network: connection reset after send'); }
    if (TAKER_KINDS.includes(kind)) {
      // Takers fill at the touch, which is never worse than their limit when they cross.
      if (marketable && available > 0) this.fillOrder(id, available, 'matched', top ? (r.side === 'BUY' ? top.ask : top.bid) : r.price);
      const o = this.orders.get(id)!;
      if (o.status === 'open' && kind !== 'limit') o.status = 'cancelled';
    }
    return { ok: true, venueOrderId: id };
  }

  async cancel(ids: string[]) {
    const cancelled: string[] = [], failed: string[] = [];
    for (const id of ids) {
      const o = this.orders.get(id);
      if (o && o.status === 'open') { o.status = 'cancelled'; cancelled.push(id); } else failed.push(id);
    }
    return { cancelled, failed };
  }

  async cancelAll() { for (const o of this.orders.values()) if (o.status === 'open') o.status = 'cancelled'; }
  async openOrders() { this.expire(); return [...this.orders.values()].filter((o) => o.status === 'open').map(({ expiresAt: _e, ...o }) => ({ ...o })); }
  async getOrder(id: string) { this.expire(); const o = this.orders.get(id); if (!o) return null; const { expiresAt: _e, ...rest } = o; return { ...rest }; }
  async heartbeat() { if (!this.heartbeatOk) await this.cancelAll(); return this.heartbeatOk; }
  async positions() { return new Map(this.held); }

  private expire() { const now = this.clock(); for (const o of this.orders.values()) if (o.status === 'open' && o.expiresAt != null && now >= o.expiresAt) o.status = 'cancelled'; }

  /** Feed a public book top; fills our resting orders that the book has traded through. */
  touch(tokenId: string, bestBid: number, bestAsk: number, maxShares = Infinity) {
    this.tops.set(tokenId, { bid: bestBid, ask: bestAsk });
    this.expire();
    for (const o of this.orders.values()) {
      if (o.status !== 'open' || o.tokenId !== tokenId) continue;
      const through = o.side === 'BUY' ? bestAsk < o.price - 1e-9 : bestBid > o.price + 1e-9;
      if (!through) continue;
      this.fillOrder(o.id, Math.min(maxShares, o.originalShares - o.matchedShares));
    }
  }

  /** Fill part or all of an order directly (tests, replay). `price` defaults to the order's limit. */
  fillOrder(id: string, shares: number, status: VenueFill['status'] = 'matched', price?: number) {
    const o = this.orders.get(id);
    if (!o || shares <= 0) return;
    o.matchedShares = Math.min(o.originalShares, o.matchedShares + shares);
    if (o.matchedShares >= o.originalShares - 1e-9) o.status = 'filled';
    const sign = o.side === 'BUY' ? 1 : -1;
    this.held.set(o.tokenId, (this.held.get(o.tokenId) ?? 0) + sign * shares);
    this.onFill({ tradeId: `dry-trade-${++this.fillSeq}`, venueOrderId: id, tokenId: o.tokenId, side: o.side, price: price ?? o.price, shares, status, at: this.clock() });
  }
}
