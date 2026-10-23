/**
 * Polymarket CLOB adapter for the MM executor. Every order is GTC and post-only, so a
 * quote that would cross is rejected by the exchange instead of taking liquidity.
 *
 * The client is passed in (structurally typed) so tests run against a fake. The SDK can
 * return `{ error, status }` instead of throwing; every call here treats that as a failure.
 * Constructing this adapter does not arm anything: the script only builds it after the
 * gate in gate.ts passes.
 */
import type { MmVenue, PlaceRequest, PlaceResult, Side, VenueOrder } from './venue.js';

export interface ClobLike {
  createAndPostOrder(order: { tokenID: string; price: number; size: number; side: any }, options: { tickSize: any; negRisk?: boolean }, orderType?: any, postOnly?: boolean): Promise<any>;
  cancelOrders(ids: string[]): Promise<any>;
  cancelAll(): Promise<any>;
  getOpenOrders(params?: { market?: string; asset_id?: string }): Promise<any>;
  getOrder(id: string): Promise<any>;
  postHeartbeat(heartbeatId?: string): Promise<any>;
  getBalanceAllowance(params: { asset_type: any; token_id?: string }): Promise<any>;
}

/** SDK enum values, injected so this file does not import the SDK at load time. */
export interface ClobEnums { buy: any; sell: any; gtc: any; conditional: any }

const errorOf = (r: any): string | null => {
  if (r == null) return 'empty_response';
  if (typeof r === 'object' && 'error' in r && r.error) return typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
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
    const res = await this.client.createAndPostOrder(
      { tokenID: r.tokenId, price: r.price, size: r.shares, side: r.side === 'BUY' ? this.enums.buy : this.enums.sell },
      { tickSize: r.tickSize, negRisk: r.negRisk },
      this.enums.gtc,
      true,
    );
    const err = errorOf(res) ?? (res.success === false ? res.errorMsg || 'rejected' : null);
    if (err) return { ok: false, error: err };
    if (!res.orderID) return { ok: false, error: 'no_order_id' };
    // A post-only order that matched on arrival would be a venue bug; surface it to reconciliation.
    if (String(res.status ?? '').toLowerCase() === 'matched') this.log('post_only_matched_on_arrival', res);
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
    if (errorOf(res) || !res?.id) return null;
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
      out.set(token, Number(res.balance ?? 0) / 1e6);
    }
    return out;
  }
}
