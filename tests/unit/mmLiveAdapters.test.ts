import { describe, expect, it } from 'vitest';
import { ClobVenue, mapOrderStatus, toVenueOrder, type ClobLike } from '../../src/research/mm/live/clobVenue.js';
import { parseUserMessage } from '../../src/research/mm/live/userChannel.js';
import { CANARY_LIMITS, MmLiveExecutor } from '../../src/research/mm/live/executor.js';

const enums = { buy: 'BUY', sell: 'SELL', gtc: 'GTC', conditional: 'CONDITIONAL' };
function fake(over: Partial<ClobLike> = {}) {
  const calls: any[] = [];
  const c: ClobLike = {
    createAndPostOrder: async (...a) => { calls.push(['post', ...a]); return { success: true, orderID: '0xabc', status: 'live' }; },
    cancelOrders: async (ids) => { calls.push(['cancel', ids]); return { canceled: ids.slice(0, 1), not_canceled: {} }; },
    cancelAll: async () => ({ canceled: [] }),
    getOpenOrders: async () => [{ id: '0xabc', asset_id: 'T', side: 'BUY', price: '0.4', original_size: '10', size_matched: '3', status: 'LIVE' }],
    getOrder: async () => ({ id: '0xabc', asset_id: 'T', side: 'BUY', price: '0.4', original_size: '10', size_matched: '10', status: 'MATCHED' }),
    postHeartbeat: async (id) => ({ heartbeat_id: `${id}x` }),
    getBalanceAllowance: async () => ({ balance: '3000000' }),
    ...over,
  };
  return { c, calls };
}

describe('CLOB venue adapter', () => {
  it('posts GTC post-only orders with tick and neg-risk options', async () => {
    const { c, calls } = fake();
    const v = new ClobVenue(c, enums, () => ['T']);
    const r = await v.place({ clientKey: 'k', tokenId: 'T', side: 'BUY', price: 0.4, shares: 10, tickSize: '0.01', negRisk: true });
    expect(r).toEqual({ ok: true, venueOrderId: '0xabc' });
    expect(calls[0]).toEqual(['post', { tokenID: 'T', price: 0.4, size: 10, side: 'BUY' }, { tickSize: '0.01', negRisk: true }, 'GTC', true]);
  });

  it('treats SDK error objects and success:false as rejects, never as acks', async () => {
    const a = new ClobVenue(fake({ createAndPostOrder: async () => ({ error: 'not enough balance', status: 400 }) }).c, enums, () => []);
    expect(await a.place({ clientKey: 'k', tokenId: 'T', side: 'BUY', price: 0.4, shares: 10, tickSize: '0.01', negRisk: false })).toEqual({ ok: false, error: 'not enough balance' });
    const b = new ClobVenue(fake({ createAndPostOrder: async () => ({ success: false, errorMsg: 'post only order would cross' }) }).c, enums, () => []);
    expect((await b.place({ clientKey: 'k', tokenId: 'T', side: 'BUY', price: 0.4, shares: 10, tickSize: '0.01', negRisk: false })).ok).toBe(false);
    const c = new ClobVenue(fake({ cancelAll: async () => ({ error: 'unauthorized' }) }).c, enums, () => []);
    await expect(c.cancelAll()).rejects.toThrow(/cancel_all_failed/);
  });

  it('splits partial cancels and maps orders, balances and heartbeats', async () => {
    const v = new ClobVenue(fake().c, enums, () => ['T']);
    expect(await v.cancel(['a', 'b'])).toEqual({ cancelled: ['a'], failed: ['b'] });
    expect((await v.openOrders())[0]).toMatchObject({ id: '0xabc', matchedShares: 3, status: 'open' });
    expect((await v.getOrder('0xabc'))!.status).toBe('filled');
    expect((await v.positions()).get('T')).toBe(3);
    expect(await v.heartbeat()).toBe(true);
    expect(mapOrderStatus('CANCELED_MARKET_RESOLVED', 0, 10)).toBe('cancelled');
    expect(mapOrderStatus('SOMETHING_NEW', 0, 10)).toBe('unknown');
    expect(toVenueOrder({ id: 1, asset_id: 2, side: 'sell', price: '0.5', original_size: '5', size_matched: '0', status: 'LIVE', created_at: 1700000000 }).createdAt).toBe(1700000000000);
  });

  it('a failed heartbeat reports false and the executor halts after the limit', async () => {
    const v = new ClobVenue(fake({ postHeartbeat: async () => ({ error_msg: 'invalid heartbeat id' }) as any }).c, enums, () => []);
    const ex = new MmLiveExecutor(v, CANARY_LIMITS);
    await ex.heartbeat(); await ex.heartbeat();
    expect(ex.halted).toBe('heartbeat_missed');
  });
});

describe('user channel parsing', () => {
  const ours = (id: string) => id === 'O1';
  it('extracts our maker fills with status mapping and ignores others', () => {
    const msg = { event_type: 'trade', id: 'TR', status: 'MATCHED', side: 'SELL', asset_id: 'T', price: '0.41', size: '30', taker_order_id: 'X',
      maker_orders: [{ order_id: 'O1', matched_amount: '7', price: '0.4', asset_id: 'T' }, { order_id: 'O2', matched_amount: '23', price: '0.4', asset_id: 'T' }] };
    expect(parseUserMessage(msg, ours, 5)).toEqual([{ tradeId: 'TR', venueOrderId: 'O1', tokenId: 'T', side: 'BUY', price: 0.4, shares: 7, status: 'matched', at: 5 }]);
    expect(parseUserMessage([{ ...msg, status: 'CONFIRMED' }], ours, 5)[0].status).toBe('confirmed');
    expect(parseUserMessage({ ...msg, status: 'FAILED' }, ours, 5)[0].status).toBe('failed');
    expect(parseUserMessage({ event_type: 'order', id: 'O1' }, ours, 5)).toEqual([]);
  });

  it('matched then confirmed counts once in the executor', async () => {
    const { DryRunVenue } = await import('../../src/research/mm/live/venue.js');
    const venue = new DryRunVenue();
    const ex = new MmLiveExecutor(venue, CANARY_LIMITS);
    await ex.step([{ tokenId: 'T', conditionId: 'C', event: 'E', side: 'BUY', price: 0.4, shares: 10, tick: 0.01, tickSize: '0.01', negRisk: false }], new Map([['T', 0.4]]));
    const id = ex.liveOrders()[0].venueOrderId!;
    const base = { event_type: 'trade', id: 'TR', side: 'SELL', asset_id: 'T', maker_orders: [{ order_id: id, matched_amount: '4', price: '0.4', asset_id: 'T' }] };
    for (const status of ['MATCHED', 'MINED', 'CONFIRMED']) for (const f of parseUserMessage({ ...base, status }, (x) => x === id, 1)) await ex.onFill(f);
    expect(ex.position.get('T')).toBeCloseTo(4);
  });
});
