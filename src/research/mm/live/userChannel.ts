/**
 * Polymarket user channel: our own trade and order events. Parsing is pure and tested;
 * the connector only handles the socket. Fills that the socket misses while it is down
 * are recovered by the executor's reconciliation (venue size_matched), so a reconnect
 * never needs replaying.
 */
import type { Side, VenueFill } from './venue.js';

export const USER_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';

const STATUS: Record<string, VenueFill['status']> = { MATCHED: 'matched', MINED: 'matched', RETRYING: 'matched', CONFIRMED: 'confirmed', FAILED: 'failed' };
const flip = (s: string): Side => (String(s).toUpperCase() === 'BUY' ? 'SELL' : 'BUY');

/** Reduce one user-channel message to fills on orders in `ours`. Anything else is ignored. */
export function parseUserMessage(raw: unknown, ours: (venueOrderId: string) => boolean, now: number): VenueFill[] {
  const items = Array.isArray(raw) ? raw : [raw];
  const out: VenueFill[] = [];
  for (const m of items as any[]) {
    if (!m || m.event_type !== 'trade') continue;
    const status = STATUS[String(m.status ?? '').toUpperCase()];
    if (!status || !m.id) continue;
    const at = Number(m.match_time ?? m.timestamp ?? 0) ? Number(m.match_time ?? m.timestamp) * (Number(m.match_time ?? m.timestamp) < 1e12 ? 1000 : 1) : now;
    for (const mo of m.maker_orders ?? []) {
      if (!mo?.order_id || !ours(String(mo.order_id))) continue;
      const shares = Number(mo.matched_amount), price = Number(mo.price);
      if (!(shares > 0) || !(price > 0 && price < 1)) continue;
      out.push({ tradeId: String(m.id), venueOrderId: String(mo.order_id), tokenId: String(mo.asset_id ?? m.asset_id), side: mo.side ? (String(mo.side).toUpperCase() as Side) : flip(m.side), price, shares, status, at });
    }
    if (m.taker_order_id && ours(String(m.taker_order_id))) {
      const shares = Number(m.size), price = Number(m.price);
      if (shares > 0 && price > 0 && price < 1) out.push({ tradeId: String(m.id), venueOrderId: String(m.taker_order_id), tokenId: String(m.asset_id), side: String(m.side).toUpperCase() as Side, price, shares, status, at });
    }
  }
  return out;
}

export interface UserChannelOptions {
  creds: { key: string; secret: string; passphrase: string };
  markets: () => string[];
  ours: (venueOrderId: string) => boolean;
  onFill: (fill: VenueFill) => void;
  onState?: (state: 'open' | 'closed' | 'error', detail?: string) => void;
  WebSocketImpl: new (url: string) => any;
  url?: string;
  clock?: () => number;
}

/** Connects, authenticates, pings every 10 s and reconnects with backoff until stopped. */
export function connectUserChannel(o: UserChannelOptions) {
  let ws: any = null, ping: NodeJS.Timeout | null = null, stopped = false, attempt = 0, lastMessageAt = 0;
  const clock = o.clock ?? Date.now;
  const open = () => {
    if (stopped) return;
    ws = new o.WebSocketImpl(o.url ?? USER_WS_URL);
    ws.on('open', () => {
      attempt = 0; lastMessageAt = clock();
      ws.send(JSON.stringify({ auth: { apiKey: o.creds.key, secret: o.creds.secret, passphrase: o.creds.passphrase }, markets: o.markets(), type: 'user' }));
      ping = setInterval(() => { try { ws.send('PING'); } catch { /* close handler reconnects */ } }, 10_000);
      o.onState?.('open');
    });
    ws.on('message', (data: any) => {
      lastMessageAt = clock();
      const text = String(data);
      if (text === 'PONG') return;
      let msg: unknown;
      try { msg = JSON.parse(text); } catch { return; }
      for (const f of parseUserMessage(msg, o.ours, clock())) o.onFill(f);
    });
    ws.on('error', (e: any) => o.onState?.('error', String(e?.message ?? e)));
    ws.on('close', () => {
      if (ping) clearInterval(ping);
      o.onState?.('closed');
      if (!stopped) setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt++));
    });
  };
  open();
  return {
    lastMessageAt: () => lastMessageAt,
    stop() { stopped = true; if (ping) clearInterval(ping); try { ws?.close(); } catch { /* already closed */ } },
  };
}
