/**
 * Polymarket CLOB adapter for the MM executor. Order kinds (see venue.ts) map to:
 * quote → GTC post-only, quote-until → GTD post-only, limit → GTC, ioc → FAK, fok → FOK.
 * A quote that would cross is rejected by the exchange instead of taking liquidity, and
 * every taker carries a worst price.
 *
 * The client is passed in (structurally typed) so tests run against a fake. The SDK can
 * return `{ error, status }` instead of throwing; every call here treats that as a failure.
 * Constructing this adapter does not arm anything: the script only builds it after the
 * gate in gate.ts passes.
 */
import { kindOf, MIN_GTD_LIFETIME_MS, type MmVenue, type PlaceRequest, type PlaceResult, type Side, type VenueOrder } from './venue.js';

export interface ClobLike {
  createAndPostOrder(order: { tokenID: string; price: number; size: number; side: any; expiration?: number }, options: { tickSize: any; negRisk?: boolean }, orderType?: any, postOnly?: boolean): Promise<any>;
  createAndPostMarketOrder?(order: { tokenID: string; price: number; amount: number; side: any; orderType?: any }, options: { tickSize: any; negRisk?: boolean }, orderType?: any): Promise<any>;
  cancelOrders(ids: string[]): Promise<any>;
  cancelAll(): Promise<any>;
  getOpenOrders(params?: { market?: string; asset_id?: string }): Promise<any>;
  getOrder(id: string): Promise<any>;
  postHeartbeat(heartbeatId?: string): Promise<any>;
  getBalanceAllowance(params: { asset_type: any; token_id?: string }): Promise<any>;
}

/** SDK enum values, injected so this file does not import the SDK at load time. */
export interface ClobEnums { buy: any; sell: any; gtc: any; conditional: any; fak?: any; fok?: any; gtd?: any }

const errorOf = (r: any): string | null => {
  if (r == null) return 'empty_response';
  if (typeof r === 'object' && 'error' in r && r.error) return typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
  if (typeof r === 'object' && (r.success === false || (typeof r.errorMsg === 'string' && r.errorMsg))) return r.errorMsg || 'success_false';
  return null;
};

/** CLOB order status → executor status. Unrecognised values stay 'unknown' so nothing is assumed. */
export function mapOrderStatus(status: string | undefined, matched: number, original: number): VenueOrder['status'] {
  const s = String(status ?? '').toUpperCase();
  if (s === 'LIVE' || s === 'DELAYED' || s === 'UNMATCHED') return 'open';
  if (s === 'MATCHED' || (original > 0 && matched >= original - 1e-9)) return 'filled';
  if (s.startsWith('CANCELED') || s.startsWith('CANCELLED') || s === 'INVALID') return 'cancelled';
  return 'unknown';
}

export function toVenueOrder(o: any): VenueOrder {
  const original = Number(o.original_size), matched = Number(o.size_matched ?? 0);
  return {
    id: String(o.id), tokenId: String(o.asset_id), side: String(o.side).toUpperCase() as Side,
    price: Number(o.price), originalShares: original, matchedShares: matched,
    status: mapOrderStatus(o.status, matched, original),
    createdAt: o.created_at ? Number(o.created_at) * (Number(o.created_at) < 1e12 ? 1000 : 1) : undefined,
  };
}

export class ClobVenue implements MmVenue {
  readonly kind = 'clob' as const;
  private heartbeatId = '';

  constructor(private client: ClobLike, private enums: ClobEnums, private tokens: () => string[], private log: (msg: string, data?: unknown) => void = () => {}) {}

  async place(r: PlaceRequest): Promise<PlaceResult> {
    const kind = kindOf(r);
    if (r.exit && r.side !== 'SELL') return { ok: false, error: 'exit_must_sell' };
    if (kind === 'ioc' || kind === 'fok') return this.taker(r, kind);
    const resting = { tokenID: r.tokenId, price: r.price, size: r.shares, side: r.side === 'BUY' ? this.enums.buy : this.enums.sell };
    let res: any;
    if (kind === 'quote-until') {
      if (this.enums.gtd == null) return { ok: false, error: 'gtd_unsupported' };
      if (!(Number(r.expiresAt) >= Date.now() + MIN_GTD_LIFETIME_MS)) return { ok: false, error: 'expiry_too_soon' };
      res = await this.client.createAndPostOrder({ ...resting, expiration: Math.floor(r.expiresAt! / 1000) }, { tickSize: r.tickSize, negRisk: r.negRisk }, this.enums.gtd, true);
    } else {
      // quote: GTC post-only; limit: GTC that may take liquidity up to its price.
      res = await this.client.createAndPostOrder(resting, { tickSize: r.tickSize, negRisk: r.negRisk }, this.enums.gtc, kind === 'quote');
    }
    const err = errorOf(res);
    if (err) return { ok: false, error: err };
    if (!res.orderID) return { ok: false, error: 'no_order_id' };
    // A post-only order that matched on arrival would be a venue bug; surface it to reconciliation.
    if (kind !== 'limit' && String(res.status ?? '').toLowerCase() === 'matched') this.log('post_only_matched_on_arrival', res);
    return { ok: true, venueOrderId: res.orderID };
  }

  /**
   * Fill-and-kill (ioc) or fill-or-kill (fok) with `price` as the worst accepted. The SDK's
   * market-order `amount` is dollars for a buy and shares for a sell.
   */
  private async taker(r: PlaceRequest, kind: 'ioc' | 'fok'): Promise<PlaceResult> {
    const type = kind === 'ioc' ? this.enums.fak : this.enums.fok;
    if (!this.client.createAndPostMarketOrder || type == null) return { ok: false, error: r.exit ? 'exit_unsupported' : `${kind}_unsupported` };
    const amount = r.side === 'BUY' ? Math.floor(r.shares * r.price * 100) / 100 : r.shares;
    const res = await this.client.createAndPostMarketOrder(
      { tokenID: r.tokenId, price: r.price, amount, side: r.side === 'BUY' ? this.enums.buy : this.enums.sell, orderType: type },
      { tickSize: r.tickSize, negRisk: r.negRisk },
      type,
    );
    const err = errorOf(res);
    if (err) return { ok: false, error: err };
    if (!res.orderID) return { ok: false, error: 'no_order_id' };
    return { ok: true, venueOrderId: res.orderID };
  }

  async cancel(ids: string[]) {
    if (!ids.length) return { cancelled: [], failed: [] };
    const res = await this.client.cancelOrders(ids);
    const err = errorOf(res);
    if (err) return { cancelled: [], failed: ids };
    const cancelled: string[] = (res.canceled ?? res.cancelled ?? []).map(String);
    return { cancelled, failed: ids.filter((id) => !cancelled.includes(id)) };
  }

  async cancelAll() {
    const err = errorOf(await this.client.cancelAll());
    if (err) throw new Error(`cancel_all_failed: ${err}`);
  }

  async openOrders() {
    const res = await this.client.getOpenOrders();
    const err = errorOf(res);
    if (err) throw new Error(`open_orders_failed: ${err}`);
    const rows: any[] = Array.isArray(res) ? res : res.data ?? [];
    return rows.map(toVenueOrder).filter((o) => o.status === 'open' || o.status === 'unknown');
  }

  async getOrder(id: string) {
    const res = await this.client.getOrder(id);
    const err = errorOf(res);
    // A failed lookup throws so the executor keeps the order; null only means the venue returned no order.
    if (err && err !== 'empty_response') throw new Error(`get_order_failed:${id}: ${err}`);
    if (!res?.id) return null;
    if (String(res.id) !== id) throw new Error(`get_order_mismatch:${id}`);
    return toVenueOrder(res);
  }

  /** Server-side dead-man switch: if heartbeats stop, the exchange cancels our orders. */
  async heartbeat() {
    const res = await this.client.postHeartbeat(this.heartbeatId);
    const err = errorOf(res) ?? (res?.error_msg || null);
    if (err) { this.log('heartbeat_error', err); this.heartbeatId = ''; return false; }
    this.heartbeatId = res.heartbeat_id ?? this.heartbeatId;
    return true;
  }

  /** Conditional token balances for the tokens we quote (6 decimals on the CLOB). */
  async positions() {
    const out = new Map<string, number>();
    for (const token of this.tokens()) {
      const res = await this.client.getBalanceAllowance({ asset_type: this.enums.conditional, token_id: token });
      const err = errorOf(res);
      if (err) throw new Error(`balance_failed:${token}: ${err}`);
      const balance = Number(res?.balance);
      if (res?.balance == null || !Number.isFinite(balance) || balance < 0) throw new Error(`balance_invalid:${token}`);
      out.set(token, balance / 1e6);
    }
    return out;
  }
}
