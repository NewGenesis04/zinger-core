import { describe, expect, it } from 'vitest';
import { CANARY_LIMITS, MmLiveExecutor, type DesiredQuote } from '../../src/research/mm/live/executor.js';
import { DryRunVenue, type PlaceRequest } from '../../src/research/mm/live/venue.js';
import { ClobVenue, type ClobLike } from '../../src/research/mm/live/clobVenue.js';

const base: Omit<PlaceRequest, 'clientKey'> = { tokenId: 'T', side: 'BUY', price: 0.4, shares: 10, tickSize: '0.01', negRisk: false };
const q = (over: Partial<DesiredQuote> = {}): DesiredQuote => ({ tokenId: 'T', conditionId: 'C', event: 'E', side: 'BUY', price: 0.4, shares: 10, tick: 0.01, tickSize: '0.01', negRisk: false, ...over });
const tops = (bid: number, ask: number) => new Map([['T', { bid, ask }]]);

describe('order kinds in the dry-run venue', () => {
  it('rejects a quote that would cross, and lets a non-crossing quote rest', async () => {
    const v = new DryRunVenue();
    v.touch('T', 0.4, 0.42);
    expect(await v.place({ ...base, clientKey: 'a', price: 0.42 })).toEqual({ ok: false, error: 'post_only_would_cross' });
    expect((await v.place({ ...base, clientKey: 'b', price: 0.41 })).ok).toBe(true);
    expect(await v.openOrders()).toHaveLength(1);
  });

  it('expires a quote-until at its time and refuses one shorter than the exchange threshold', async () => {
    let now = 0;
    const v = new DryRunVenue(() => now);
    expect((await v.place({ ...base, clientKey: 'a', kind: 'quote-until', expiresAt: 30_000 })).error).toBe('expiry_too_soon');
    const r = await v.place({ ...base, clientKey: 'b', kind: 'quote-until', expiresAt: 120_000 });
    now = 119_999; expect(await v.openOrders()).toHaveLength(1);
    now = 120_000; expect(await v.openOrders()).toHaveLength(0);
    expect((await v.getOrder(r.venueOrderId!))!.status).toBe('cancelled');
  });

  it('fills an ioc at the touch up to the visible size and cancels the rest', async () => {
    const v = new DryRunVenue();
    const fills: number[][] = [];
    v.onFill = (f) => fills.push([f.price, f.shares]);
    v.touch('T', 0.4, 0.42);
    v.takerFillShares = 6;
    const r = await v.place({ ...base, clientKey: 'a', kind: 'ioc', price: 0.44 });
    expect(fills).toEqual([[0.42, 6]]);
    expect((await v.getOrder(r.venueOrderId!))!.status).toBe('cancelled');
  });

  it('fok fills all or nothing', async () => {
    const v = new DryRunVenue();
    v.touch('T', 0.4, 0.42);
    v.takerFillShares = 6;
    expect(await v.place({ ...base, clientKey: 'a', kind: 'fok', price: 0.44 })).toEqual({ ok: false, error: 'fok_not_filled' });
    v.takerFillShares = null;
    expect((await v.place({ ...base, clientKey: 'b', kind: 'fok', price: 0.44 })).ok).toBe(true);
    expect(await v.place({ ...base, clientKey: 'c', kind: 'fok', price: 0.41 })).toEqual({ ok: false, error: 'fok_not_filled' });
  });

  it('a crossing limit takes what it can and rests the rest', async () => {
    const v = new DryRunVenue();
    v.touch('T', 0.4, 0.42);
    v.takerFillShares = 4;
    const r = await v.place({ ...base, clientKey: 'a', kind: 'limit', price: 0.43 });
    const o = (await v.getOrder(r.venueOrderId!))!;
    expect([o.status, o.matchedShares]).toEqual(['open', 4]);
  });
});

describe('order kinds in the executor', () => {
  function setup() {
    let now = 1_000_000;
    const venue = new DryRunVenue(() => now);
    const ex = new MmLiveExecutor(venue, CANARY_LIMITS, () => {}, () => now, () => null);
    venue.onFill = (f) => { void ex.onFill(f); };
    return { venue, ex, advance: (ms: number) => { now += ms; } };
  }

  it('refuses a taker priced more than maxTakerSlippageTicks through the touch, or with no book', async () => {
    const { venue, ex } = setup();
    venue.touch('T', 0.4, 0.42);
    await ex.step([q({ kind: 'ioc', price: 0.46 })], new Map([['T', 0.41]]), tops(0.4, 0.42));
    expect(venue.sent).toHaveLength(0);
    await ex.step([q({ kind: 'ioc', price: 0.45 })], new Map([['T', 0.41]]));
    expect(venue.sent).toHaveLength(0);
    await ex.step([q({ kind: 'ioc', price: 0.45 })], new Map([['T', 0.41]]), tops(0.4, 0.42));
    expect(venue.sent).toHaveLength(1);
  });

  it('books a taker fill at the price it got, not its limit', async () => {
    const { venue, ex } = setup();
    venue.touch('T', 0.4, 0.42);
    await ex.step([q({ kind: 'ioc', price: 0.44 })], new Map([['T', 0.41]]), tops(0.4, 0.42));
    expect(ex.position.get('T')).toBeCloseTo(10);
    expect(ex.cash).toBeCloseTo(-4.2);
  });

  it('renews a quote-until a minute before it lapses', async () => {
    const { venue, ex, advance } = setup();
    const want = [q({ kind: 'quote-until', ttlMs: 180_000 })];
    await ex.step(want, new Map([['T', 0.41]]));
    expect(venue.sent[0]).toMatchObject({ kind: 'quote-until', expiresAt: 1_180_000 });
    advance(100_000);
    await ex.step(want, new Map([['T', 0.41]]));
    expect(venue.sent).toHaveLength(1);
    advance(30_000);
    await ex.step(want, new Map([['T', 0.41]])); // 50 s left: cancel, then place a fresh one
    await ex.step(want, new Map([['T', 0.41]]));
    expect(venue.sent).toHaveLength(2);
    expect(venue.sent[1].expiresAt).toBe(1_310_000);
  });

  it('replaces an order whose type changed', async () => {
    const { venue, ex } = setup();
    await ex.step([q()], new Map([['T', 0.41]]));
    await ex.step([q({ kind: 'quote-until', ttlMs: 180_000 })], new Map([['T', 0.41]]));
    await ex.step([q({ kind: 'quote-until', ttlMs: 180_000 })], new Map([['T', 0.41]]));
    expect(venue.sent.map((r) => r.kind)).toEqual(['quote', 'quote-until']);
  });
});

describe('order kinds on the CLOB', () => {
  const enums = { buy: 'BUY', sell: 'SELL', gtc: 'GTC', conditional: 'CONDITIONAL', fak: 'FAK', fok: 'FOK', gtd: 'GTD' };
  function fake() {
    const calls: any[] = [];
    const c: ClobLike = {
      createAndPostOrder: async (...a) => { calls.push(['order', ...a]); return { orderID: 'o' }; },
      createAndPostMarketOrder: async (...a) => { calls.push(['market', ...a]); return { orderID: 'm' }; },
      cancelOrders: async () => ({}), cancelAll: async () => ({}), getOpenOrders: async () => [], getOrder: async () => null,
      postHeartbeat: async () => ({}), getBalanceAllowance: async () => ({ balance: '0' }),
    };
    return { v: new ClobVenue(c, enums, () => []), calls };
  }
  const opts = { tickSize: '0.01', negRisk: false };
  it('maps quote, quote-until and limit to GTC post-only, GTD post-only and GTC', async () => {
    const { v, calls } = fake();
    const expiresAt = Date.now() + 300_000;
    await v.place({ ...base, clientKey: 'a' });
    await v.place({ ...base, clientKey: 'b', kind: 'quote-until', expiresAt });
    await v.place({ ...base, clientKey: 'c', kind: 'limit' });
    expect(calls).toEqual([
      ['order', { tokenID: 'T', price: 0.4, size: 10, side: 'BUY' }, opts, 'GTC', true],
      ['order', { tokenID: 'T', price: 0.4, size: 10, side: 'BUY', expiration: Math.floor(expiresAt / 1000) }, opts, 'GTD', true],
      ['order', { tokenID: 'T', price: 0.4, size: 10, side: 'BUY' }, opts, 'GTC', false],
    ]);
  });
  it('sends ioc and fok as FAK and FOK market orders; a buy amount is dollars, a sell amount is shares', async () => {
    const { v, calls } = fake();
    await v.place({ ...base, clientKey: 'a', kind: 'ioc', price: 0.45 });
    await v.place({ ...base, clientKey: 'b', kind: 'fok', side: 'SELL', price: 0.38 });
    expect(calls).toEqual([
      ['market', { tokenID: 'T', price: 0.45, amount: 4.5, side: 'BUY', orderType: 'FAK' }, opts, 'FAK'],
      ['market', { tokenID: 'T', price: 0.38, amount: 10, side: 'SELL', orderType: 'FOK' }, opts, 'FOK'],
    ]);
  });
  it('refuses a GTD that would lapse inside the exchange threshold', async () => {
    const { v, calls } = fake();
    expect((await v.place({ ...base, clientKey: 'a', kind: 'quote-until', expiresAt: Date.now() + 30_000 })).error).toBe('expiry_too_soon');
    expect(calls).toEqual([]);
  });
});
