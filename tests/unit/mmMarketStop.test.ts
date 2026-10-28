import { describe, expect, it } from 'vitest';
import { BUDGET_200_LIMITS, CANARY_LIMITS, MmLiveExecutor, type DesiredQuote, type JournalRow } from '../../src/research/mm/live/executor.js';
import { DryRunVenue } from '../../src/research/mm/live/venue.js';
import { ClobVenue, type ClobLike } from '../../src/research/mm/live/clobVenue.js';
import { evaluateGate, limitsHash } from '../../src/research/mm/live/gate.js';
import { levelScore, marketRewardShare, rewardShare } from '../../src/research/mm/live/evaluation.js';

const q = (over: Partial<DesiredQuote> = {}): DesiredQuote => ({ tokenId: 'Y', conditionId: 'C', event: 'E', side: 'BUY', price: 0.4, shares: 10, tick: 0.01, tickSize: '0.01', negRisk: false, ...over });
const other = q({ tokenId: 'Z', conditionId: 'D', event: 'F', price: 0.3 });
function setup() {
  let now = 1_000;
  const venue = new DryRunVenue(() => now);
  const rows: JournalRow[] = [];
  const ex = new MmLiveExecutor(venue, CANARY_LIMITS, (r) => rows.push(r), () => now, () => null);
  venue.onFill = (f) => { void ex.onFill(f); };
  return { venue, ex, rows, tick: (ms: number) => { now += ms; } };
}

describe('per-market stop', () => {
  it('stops only the losing market, cancels its quotes and sells its shares at the best bid', async () => {
    const { venue, ex, rows } = setup();
    await ex.step([q(), other], new Map([['Y', 0.4], ['Z', 0.3]]));
    venue.fillOrder(ex.liveOrders().find((o) => o.tokenId === 'Y')!.venueOrderId!, 10);
    // 10 shares bought at 0.40 now mark at 0.10: market C is down $3, past the $2.50 stop.
    const marks = new Map([['Y', 0.1], ['Z', 0.3]]);
    venue.touch('Y', 0.09, 0.11);
    await ex.step([q({ price: 0.09 }), other], marks, new Map([['Y', 0.09]]));
    expect(ex.stoppedMarkets.has('C')).toBe(true);
    expect(ex.halted).toBeNull();
    const exit = venue.sent.find((r) => r.exit)!;
    // Priced one tick under the bid (exitSlippageTicks), filled at the bid.
    expect(exit).toMatchObject({ tokenId: 'Y', side: 'SELL', price: 0.08, shares: 10, kind: 'ioc' });
    expect(ex.position.get('Y')).toBeCloseTo(0);
    expect(ex.marketPnl('C', marks)).toBeCloseTo(-3.1);
    expect(ex.liveOrders().map((o) => o.tokenId)).toEqual(['Z']);
    // Later cycles never quote C again, even when asked.
    const sent = venue.sent.length;
    await ex.step([q({ price: 0.09 }), other], marks, new Map([['Y', 0.09]]));
    expect(venue.sent.length).toBe(sent);
    expect(rows.some((r) => r.type === 'market_stop' && r.conditionId === 'C')).toBe(true);
  });

  it('waits for the market\'s resting orders to be gone before selling', async () => {
    const { venue, ex } = setup();
    await ex.step([q(), q({ tokenId: 'N', price: 0.5 })], new Map([['Y', 0.4], ['N', 0.5]]));
    venue.fillOrder(ex.liveOrders().find((o) => o.tokenId === 'Y')!.venueOrderId!, 10);
    const nId = ex.liveOrders().find((o) => o.tokenId === 'N')!.venueOrderId!;
    const realCancel = venue.cancel.bind(venue);
    venue.cancel = async (ids) => ({ cancelled: [], failed: ids }); // cancel lost: the N bid stays cancel_pending
    await ex.step([], new Map([['Y', 0.1], ['N', 0.5]]), new Map([['Y', 0.09]]));
    expect(ex.stoppedMarkets.has('C')).toBe(true);
    // Y has nothing resting, so it exits; N's bid is still unresolved and N holds nothing.
    expect(venue.sent.filter((r) => r.exit).map((r) => r.tokenId)).toEqual(['Y']);
    venue.cancel = realCancel;
    expect(ex.liveOrders().some((o) => o.venueOrderId === nId && o.state === 'cancel_pending')).toBe(true);
  });

  it('sells in order-size chunks and finishes a partial exit on the next cycle', async () => {
    let now = 1_000;
    const venue = new DryRunVenue(() => now);
    const ex = new MmLiveExecutor(venue, { ...BUDGET_200_LIMITS, maxOrderShares: 100 }, () => {}, () => now, () => null);
    venue.onFill = (f) => { void ex.onFill(f); };
    await ex.step([q({ shares: 100, price: 0.2 })], new Map([['Y', 0.2]]));
    venue.fillOrder(ex.liveOrders()[0].venueOrderId!, 100);
    venue.touch('Y', 0.1, 0.12);
    venue.exitFillShares = 60;
    await ex.step([], new Map([['Y', 0.1]]), new Map([['Y', 0.1]]));
    expect(ex.position.get('Y')).toBeCloseTo(40);
    // The first exit stays open until reconciliation confirms the venue killed the rest, so no share is sold twice.
    await ex.step([], new Map([['Y', 0.1]]), new Map([['Y', 0.1]]));
    expect(venue.sent.filter((r) => r.exit)).toHaveLength(1);
    await ex.reconcile();
    now += 1000;
    venue.exitFillShares = null;
    await ex.step([], new Map([['Y', 0.1]]), new Map([['Y', 0.1]]));
    expect(ex.position.get('Y')).toBeCloseTo(0);
    expect(ex.cash).toBeCloseTo(-20 + 10);
  });

  it('holds when there is no bid to sell into, and keeps the stop after a restart', async () => {
    const { venue, ex, rows } = setup();
    await ex.step([q()], new Map([['Y', 0.4]]));
    venue.fillOrder(ex.liveOrders()[0].venueOrderId!, 10);
    await ex.step([], new Map([['Y', 0.1]]));
    expect(venue.sent.some((r) => r.exit)).toBe(false);
    expect(rows.some((r) => r.type === 'skip' && r.reason === 'no_bid_for_exit')).toBe(true);
    const back = MmLiveExecutor.restore(rows, venue, CANARY_LIMITS);
    expect(back.stoppedMarkets.has('C')).toBe(true);
    expect(back.marketPnl('C', new Map([['Y', 0.1]]))).toBeCloseTo(-3);
  });

  it('applies a fill that arrives before its order is acknowledged', async () => {
    const { venue, ex } = setup();
    await ex.step([q()], new Map([['Y', 0.4]]));
    const id = ex.liveOrders()[0].venueOrderId!;
    venue.fillOrder(id, 10);
    // The exit fills inside place(), before the executor has its venue id.
    await ex.step([], new Map([['Y', 0.1]]), new Map([['Y', 0.1]]));
    expect(ex.halted).toBeNull();
    expect(ex.position.get('Y')).toBeCloseTo(0);
  });

  it('the portfolio loss limit still halts everything', async () => {
    const { venue, ex } = setup();
    const many = ['A', 'B', 'G', 'H', 'I'].map((t) => q({ tokenId: t, conditionId: t, price: 0.5, shares: 10 }));
    await ex.step(many, new Map(many.map((d) => [d.tokenId, 0.5])));
    for (const o of ex.liveOrders()) venue.fillOrder(o.venueOrderId!, 10);
    // Each market is down $2.40 (inside its $2.50 stop); together $12 passes the $10 limit.
    await ex.step(many, new Map(many.map((d) => [d.tokenId, 0.26])));
    expect(ex.stoppedMarkets.size).toBe(0);
    expect(ex.halted).toMatch(/^loss_limit/);
  });
});

describe('exit orders on the CLOB', () => {
  const enums = { buy: 'BUY', sell: 'SELL', gtc: 'GTC', conditional: 'CONDITIONAL', fak: 'FAK' };
  const base = (calls: any[]): ClobLike => ({
    createAndPostOrder: async (...a) => { calls.push(['post', ...a]); return { orderID: 'm' }; },
    createAndPostMarketOrder: async (...a) => { calls.push(['market', ...a]); return { success: true, orderID: '0xexit', status: 'matched' }; },
    cancelOrders: async () => ({}), cancelAll: async () => ({}), getOpenOrders: async () => [], getOrder: async () => null,
    postHeartbeat: async () => ({}), getBalanceAllowance: async () => ({ balance: '0' }),
  });
  it('sends a fill-and-kill sell with the bid as its worst price', async () => {
    const calls: any[] = [];
    const v = new ClobVenue(base(calls), enums, () => []);
    const r = await v.place({ clientKey: 'k', tokenId: 'Y', side: 'SELL', price: 0.09, shares: 10, tickSize: '0.01', negRisk: false, exit: true });
    expect(r).toEqual({ ok: true, venueOrderId: '0xexit' });
    expect(calls).toEqual([['market', { tokenID: 'Y', price: 0.09, amount: 10, side: 'SELL', orderType: 'FAK' }, { tickSize: '0.01', negRisk: false }, 'FAK']]);
  });
  it('refuses exit buys and a client without market orders', async () => {
    const calls: any[] = [];
    const v = new ClobVenue(base(calls), enums, () => []);
    expect(await v.place({ clientKey: 'k', tokenId: 'Y', side: 'BUY', price: 0.5, shares: 10, tickSize: '0.01', negRisk: false, exit: true })).toEqual({ ok: false, error: 'exit_must_sell' });
    const noFak = new ClobVenue(base(calls), { ...enums, fak: undefined }, () => []);
    expect((await noFak.place({ clientKey: 'k', tokenId: 'Y', side: 'SELL', price: 0.5, shares: 10, tickSize: '0.01', negRisk: false, exit: true })).error).toBe('exit_unsupported');
    expect(calls).toEqual([]);
  });
});

describe('live gate and the market stop', () => {
  const env = (limits: typeof BUDGET_200_LIMITS) => ({ ZINGER_MM_LIVE: '1', ZINGER_MM_LIVE_ACK: limitsHash(limits) });
  const input = (limits: typeof BUDGET_200_LIMITS) => ({ mode: 'live' as const, limits, env: env(limits), geoblock: { checked: true, blocked: false, viaProxy: false }, collateralUsd: 500, evidence: { positiveOutOfSampleDays: 3, portfolioNetUsdPerDay: 1 }, killFile: '/nonexistent/kill' });
  it('needs a market stop above zero and at most $5', () => {
    expect(evaluateGate(input(BUDGET_200_LIMITS)).armed).toBe(true);
    const off = evaluateGate(input({ ...BUDGET_200_LIMITS, maxMarketLossUsd: 0 }));
    expect(off.checks.find((c) => c.id === 'market_stop')!.ok).toBe(false);
    const high = evaluateGate(input({ ...BUDGET_200_LIMITS, maxMarketLossUsd: 6 }));
    expect(high.checks.find((c) => c.id === 'canary_ceiling')!.detail).toMatch(/maxMarketLossUsd/);
  });
});

describe('two-sided reward estimate', () => {
  const book = { bids: [{ price: 0.48, size: 100 }], asks: [{ price: 0.52, size: 100 }] };
  const others = levelScore(0.48, 100, 0.5, 0.03);
  it('matches the one-sided third for a lone bid', () => {
    expect(marketRewardShare([{ side: 'BUY', price: 0.49, shares: 60 }], book, 3, 50)).toBeCloseTo(rewardShare({ side: 'BUY', price: 0.49, shares: 60 }, book, 3, 50));
  });
  it('scores the smaller side in full when both sides rest (a NO bid enters as a YES ask)', () => {
    const qs = levelScore(0.49, 60, 0.5, 0.03);
    // NO bid at 0.49 = YES ask at 0.51, same distance from the mid.
    const share = marketRewardShare([{ side: 'BUY', price: 0.49, shares: 60 }, { side: 'SELL', price: 1 - 0.49, shares: 60 }], book, 3, 50);
    expect(share).toBeCloseTo(qs / (qs + others));
    expect(share).toBeGreaterThan(rewardShare({ side: 'BUY', price: 0.49, shares: 60 }, book, 3, 50));
  });
  it('outside 0.1-0.9 only two-sided quotes earn', () => {
    const low = { bids: [{ price: 0.04, size: 100 }], asks: [{ price: 0.06, size: 100 }] };
    expect(marketRewardShare([{ side: 'BUY', price: 0.05, shares: 60 }], low, 3, 50)).toBe(0);
    expect(marketRewardShare([{ side: 'BUY', price: 0.05, shares: 60 }, { side: 'SELL', price: 0.05, shares: 60 }], low, 3, 50)).toBeGreaterThan(0);
  });
});
