import { describe, expect, it } from 'vitest';
import { CANARY_LIMITS, MmLiveExecutor, type DesiredQuote, type JournalRow } from '../../src/research/mm/live/executor.js';
import { DryRunVenue } from '../../src/research/mm/live/venue.js';
import { evaluateGate, limitsHash } from '../../src/research/mm/live/gate.js';

const q = (over: Partial<DesiredQuote> = {}): DesiredQuote => ({ tokenId: 'T', conditionId: 'C', event: 'E', side: 'BUY', price: 0.4, shares: 10, tick: 0.01, tickSize: '0.01', negRisk: false, ...over });
const marks = new Map([['T', 0.4]]);
function setup(kill: () => string | null = () => null) {
  let now = 1_000;
  const venue = new DryRunVenue(() => now);
  const rows: JournalRow[] = [];
  const ex = new MmLiveExecutor(venue, CANARY_LIMITS, (r) => rows.push(r), () => now, kill);
  venue.onFill = (f) => { void ex.onFill(f); };
  return { venue, ex, rows, tick: (ms: number) => { now += ms; } };
}

describe('MM live executor', () => {
  it('places once, keeps within tolerance, replaces only after cancel', async () => {
    const { venue, ex } = setup();
    await ex.step([q()], marks);
    await ex.step([q({ price: 0.41 })], marks);
    expect(venue.sent).toHaveLength(1);
    await ex.step([q({ price: 0.45 })], marks);
    expect(ex.liveOrders().map((o) => o.price)).toEqual([0.45]);
    expect((await venue.openOrders()).map((o) => o.price)).toEqual([0.45]);
  });

  it('counts a fill once across stream duplicates and reconciliation', async () => {
    const { venue, ex } = setup();
    await ex.step([q()], marks);
    const id = ex.liveOrders()[0].venueOrderId!;
    venue.fillOrder(id, 4);
    await ex.onFill({ tradeId: 'dry-trade-1', venueOrderId: id, tokenId: 'T', side: 'BUY', price: 0.4, shares: 4, status: 'confirmed', at: 0 });
    await ex.reconcile();
    expect(ex.position.get('T')).toBeCloseTo(4);
    expect(ex.cash).toBeCloseTo(-1.6);
    expect(ex.halted).toBeNull();
  });

  it('applies a late fill after cancel and reverses a failed trade', async () => {
    const { venue, ex } = setup();
    await ex.step([q()], marks);
    const id = ex.liveOrders()[0].venueOrderId!;
    await ex.step([], marks);
    await ex.onFill({ tradeId: 'x', venueOrderId: id, tokenId: 'T', side: 'BUY', price: 0.4, shares: 2, status: 'matched', at: 0 });
    expect(ex.position.get('T')).toBeCloseTo(2);
    await ex.onFill({ tradeId: 'x', venueOrderId: id, tokenId: 'T', side: 'BUY', price: 0.4, shares: 2, status: 'failed', at: 0 });
    expect(ex.position.get('T')).toBeCloseTo(0);
    expect(venue.sent).toHaveLength(1);
  });

  it('resolves a lost acknowledgement by adopting the resting order instead of resubmitting', async () => {
    const { venue, ex } = setup();
    venue.loseNextAck = true;
    await ex.step([q()], marks);
    expect(ex.liveOrders()[0].state).toBe('unknown');
    await ex.step([q()], marks);
    expect(venue.sent).toHaveLength(1);
    await ex.reconcile();
    expect(ex.liveOrders()[0].state).toBe('open');
    expect(ex.halted).toBeNull();
  });

  it('refuses naked sells and bids beyond the portfolio cap', async () => {
    const { ex } = setup();
    expect(ex.preTradeCheck(q({ side: 'SELL' }))).toBe('sell_without_inventory');
    expect(ex.preTradeCheck(q({ shares: 50, price: 0.9 }))).toBe('market_usd_limit');
  });

  it('halts and cancels everything on orphans, kill and loss limit', async () => {
    const a = setup();
    await a.venue.place({ clientKey: 'foreign', tokenId: 'T', side: 'BUY', price: 0.3, shares: 5, tickSize: '0.01', negRisk: false });
    await a.ex.reconcile();
    expect(a.ex.halted).toBe('orphan_venue_orders');
    expect(await a.venue.openOrders()).toHaveLength(0);

    let k: string | null = null;
    const b = setup(() => k);
    await b.ex.step([q()], marks);
    k = 'kill_file';
    await b.ex.step([q()], marks);
    expect(b.ex.halted).toBe('kill:kill_file');
    expect(await b.venue.openOrders()).toHaveLength(0);

    const c = setup();
    await c.ex.step([q({ shares: 25, price: 0.5 })], marks);
    c.venue.fillOrder(c.ex.liveOrders()[0].venueOrderId!, 25);
    await c.ex.step([], new Map([['T', 0.0]]));
    expect(c.ex.halted).toMatch(/^loss_limit/);
  });

  it('halts after repeated missed heartbeats', async () => {
    const { venue, ex } = setup();
    venue.heartbeatOk = false;
    await ex.heartbeat(); await ex.heartbeat();
    expect(ex.halted).toBe('heartbeat_missed');
  });

  it('restores ledger and open orders from the journal', async () => {
    const { venue, ex, rows } = setup();
    await ex.step([q()], marks);
    venue.fillOrder(ex.liveOrders()[0].venueOrderId!, 3);
    const back = MmLiveExecutor.restore(rows, venue, CANARY_LIMITS);
    expect(back.position.get('T')).toBeCloseTo(3);
    expect(back.liveOrders()).toHaveLength(1);
    await back.reconcile();
    expect(back.halted).toBeNull();
  });
});

describe('review fixes: executor', () => {
  it('a failed trade reverses a quantity already taken from reconciliation', async () => {
    const { venue, ex } = setup();
    await ex.step([q()], marks);
    const id = ex.liveOrders()[0].venueOrderId!;
    await ex.onFill({ tradeId: 'x', venueOrderId: id, tokenId: 'T', side: 'BUY', price: 0.4, shares: 4, status: 'matched', at: 0 });
    venue.openOrders = async () => [{ id, tokenId: 'T', side: 'BUY', price: 0.4, originalShares: 10, matchedShares: 4, status: 'open' }];
    await ex.reconcile();
    await ex.onFill({ tradeId: 'x', venueOrderId: id, tokenId: 'T', side: 'BUY', price: 0.4, shares: 4, status: 'failed', at: 0 });
    expect(ex.position.get('T')).toBeCloseTo(0);
    expect(ex.cash).toBeCloseTo(0);
  });
  it('a halt during a submit stops later submits and cancels what rested', async () => {
    let k: string | null = null;
    const { venue, ex } = setup(() => k);
    const place = venue.place.bind(venue);
    venue.place = async (r) => { const res = await place(r); k = 'SIGTERM'; return res; };
    await ex.step([q(), q({ tokenId: 'U' })], new Map([['T', 0.4], ['U', 0.4]]));
    expect(venue.sent).toHaveLength(1);
    expect(ex.halted).toBe('kill:SIGTERM');
    expect(await venue.openOrders()).toHaveLength(0);
  });
  it('enforces the event cap across markets', async () => {
    const { ex } = setup();
    // $25 per market, $50 per event: two markets of one event fill the event allowance.
    await ex.step([q({ shares: 50, price: 0.45, conditionId: 'C1' }), q({ tokenId: 'U', shares: 50, price: 0.45, conditionId: 'C2' })], new Map([['T', 0.45], ['U', 0.45]]));
    expect(ex.liveOrders()).toHaveLength(2);
    expect(ex.preTradeCheck(q({ tokenId: 'V', shares: 50, price: 0.45, conditionId: 'C3' }))).toBe('event_usd_limit');
    expect(ex.preTradeCheck(q({ tokenId: 'V', shares: 50, price: 0.45, conditionId: 'C3', event: 'Other' }))).toBeNull();
  });
  it('counts earlier sessions against the loss limit', async () => {
    const { ex } = setup();
    ex.priorPnlUsd = -9.5;
    await ex.step([q({ shares: 10 })], marks);
    ex.cash = -1; // a one-dollar loss now crosses the $10 limit with the earlier -$9.50
    await ex.step([], marks);
    expect(ex.halted).toMatch(/^loss_limit/);
  });
});

describe('MM live gate', () => {
  const base = { mode: 'live' as const, limits: CANARY_LIMITS, killFile: '/nonexistent/kill', collateralUsd: 500,
    geoblock: { checked: true, blocked: false, viaProxy: false, country: 'XX' }, evidence: { positiveOutOfSampleDays: 3, portfolioNetUsdPerDay: 1 } };
  it('dry-run never arms', () => { expect(evaluateGate({ ...base, mode: 'dry-run', env: {} }).armed).toBe(false); });
  it('arms only with flag, hash ack and every check', () => {
    const env = { ZINGER_MM_LIVE: '1', ZINGER_MM_LIVE_ACK: limitsHash(CANARY_LIMITS) };
    expect(evaluateGate({ ...base, env }).armed).toBe(true);
    expect(evaluateGate({ ...base, env: { ...env, HTTPS_PROXY: 'x' } }).armed).toBe(false);
    expect(evaluateGate({ ...base, env: { ...env, CLOB_PROXY_API_URL: 'https://relay.example' } }).armed).toBe(false);
    expect(evaluateGate({ ...base, env: { ...env, CLOB_API_URL: 'http://clob.example' } }).armed).toBe(false);
    expect(evaluateGate({ ...base, env: { ...env, CLOB_API_URL: 'https://clob.polymarket.com/' } }).armed).toBe(true);
    expect(evaluateGate({ ...base, env, evidence: null }).armed).toBe(false);
    expect(evaluateGate({ ...base, env, limits: { ...CANARY_LIMITS, maxPortfolioUsd: 1000 } }).armed).toBe(false);
  });
});
