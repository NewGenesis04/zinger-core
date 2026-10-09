import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  MIN_ELAPSED_S,
  MIN_REMAINING_S,
  SHADOW_INTERVAL_MS,
  __resetShadowMinutes,
  buildShadowRow,
  closesBefore,
  minuteOpen,
  dueForSample,
  normalCdf,
  parseResolution,
  realizedSigma,
  recordSpotTick,
  resolvePending,
  shadowObserve,
  signalShadowStatus,
  startSignalShadow,
  stopSignalShadow,
  strikeProbability,
} from '../../src/polymarket/signalShadow.js';
import { getDb } from '../../src/polymarket/sqliteStore.js';

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/**
 * INVARIANT: the shadow log observes and never acts (backlog item 132).
 *
 * It exists to answer "does any signal beat the price?" on every window, not
 * just the ones the bot traded. That answer is only worth having if (a) the
 * probability model is a probability, (b) no row can use information from after
 * its timestamp, (c) the log cannot change a trade, a cash balance or a position,
 * and (d) a recorded outcome is the settled one, not a live quote.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const deepFreeze = <T,>(o: T): T => {
  if (o && typeof o === 'object') {
    Object.values(o as any).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
};

// Recent and 300-aligned: rows older than the retention window are pruned at start.
const START = Math.floor(Date.now() / 300_000) * 300 - 7200;
const SLUG = `btc-updown-5m-${START}`;
const at = (elapsedS: number) => (START + elapsedS) * 1000;

function warm(asset = 'btc', fromMs = at(0) - 70 * 60_000, minutes = 72, base = 80_000, wiggle = 0.0008) {
  const rand = rng(7);
  let p = base;
  for (let i = 0; i < minutes; i += 1) {
    p *= 1 + (rand() - 0.5) * 2 * wiggle;
    recordSpotTick(asset, p, fromMs + i * 60_000 + 500);
    recordSpotTick(asset, p * 1.0001, fromMs + i * 60_000 + 30_000);
  }
  return p;
}

const side = (bid: number, ask: number, ts: number) => ({
  bestBid: bid, bestAsk: ask, bestBidSize: 120, bestAskSize: 90, bookTs: ts, source: 'clob-ws',
});
const mk = (nowMs: number, over: any = {}) => ({
  nowMs,
  mode: 'paper',
  market: { slug: SLUG, symbol: 'BTC', priceToBeat: 80_000 },
  depth: { up: side(0.5, 0.51, nowMs - 100), down: side(0.49, 0.5, nowMs - 120) },
  signal: { direction: 'down', confidence: 0.65, score: -3.1 },
  mlPoints: [{ label: '5m', direction: 'up', confidence: 0.55, expectedReturn: 0.0004 }],
  spot: 80_050,
  ...over,
});

beforeEach(() => __resetShadowMinutes());

describe('INVARIANT: the strike-distance model is a probability', () => {
  it('normalCdf matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 5);
  });

  it('stays in [0,1], is 0.5 at the strike, rises with spot, and mirrors under swapping spot and strike', () => {
    const rand = rng(3);
    for (let i = 0; i < 3000; i += 1) {
      const strike = 100 + rand() * 90_000;
      const spot = strike * (1 + (rand() - 0.5) * 0.02);
      const sigma = 0.0001 + rand() * 0.003;
      const left = 1 + rand() * 899;
      const p = strikeProbability({ spot, strike, sigmaPerMin: sigma, secondsLeft: left })!;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      const mirror = strikeProbability({ spot: strike, strike: spot, sigmaPerMin: sigma, secondsLeft: left })!;
      expect(p + mirror).toBeCloseTo(1, 6);
      const higher = strikeProbability({ spot: spot * 1.001, strike, sigmaPerMin: sigma, secondsLeft: left })!;
      expect(higher).toBeGreaterThanOrEqual(p - 1e-12);
    }
    expect(strikeProbability({ spot: 100, strike: 100, sigmaPerMin: 0.001, secondsLeft: 120 })).toBeCloseTo(0.5, 7);
  });

  it('matches a hand-worked value: a 0.1% lead, 0.1%/min volatility, one minute left is z = 1, P = 0.841', () => {
    const p = strikeProbability({ spot: 100.1, strike: 100, sigmaPerMin: 0.001, secondsLeft: 60 })!;
    expect(p).toBeCloseTo(0.8412, 3);
    // Four minutes left halves the z (the square root of time), P = Φ(0.5) = 0.691.
    const q = strikeProbability({ spot: 100.1, strike: 100, sigmaPerMin: 0.001, secondsLeft: 240 })!;
    expect(q).toBeCloseTo(0.6914, 3);
  });

  it('gets surer as time runs out: a lead is worth more with less time left', () => {
    for (const lead of [0.0003, 0.001, 0.004]) {
      let prev = 0.5;
      for (const left of [600, 300, 120, 60, 20, 5]) {
        const p = strikeProbability({ spot: 100 * (1 + lead), strike: 100, sigmaPerMin: 0.001, secondsLeft: left })!;
        expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = p;
      }
    }
  });

  it('settles to a step at zero seconds and refuses inputs it cannot price', () => {
    expect(strikeProbability({ spot: 101, strike: 100, sigmaPerMin: 0.001, secondsLeft: 0 })).toBe(1);
    expect(strikeProbability({ spot: 100, strike: 100, sigmaPerMin: 0.001, secondsLeft: 0 })).toBe(1); // >= resolves Up
    expect(strikeProbability({ spot: 99, strike: 100, sigmaPerMin: 0.001, secondsLeft: 0 })).toBe(0);
    for (const bad of [
      { spot: 0, strike: 100, sigmaPerMin: 0.001, secondsLeft: 60 },
      { spot: 100, strike: NaN, sigmaPerMin: 0.001, secondsLeft: 60 },
      { spot: 100, strike: 100, sigmaPerMin: null, secondsLeft: 60 },
      { spot: 100, strike: 100, sigmaPerMin: 0, secondsLeft: 60 },
      { spot: 100, strike: 100, sigmaPerMin: 0.001, secondsLeft: -5 },
    ]) expect(strikeProbability(bad as any)).toBeNull();
  });

  it('realizedSigma is scale-free, needs enough history, and is null on a flat series', () => {
    const a = Array.from({ length: 40 }, (_, i) => 100 * (1 + 0.01 * (i % 2 === 0 ? 1 : -1)) ** 1);
    const s = realizedSigma(a)!;
    expect(s).toBeGreaterThan(0);
    expect(realizedSigma(a.map((x) => x * 37.5))).toBeCloseTo(s, 9);
    expect(realizedSigma(a.slice(0, 15))).toBeNull();
    expect(realizedSigma(Array(40).fill(100))).toBeNull();
  });
});

describe('INVARIANT: no row can use information from after its timestamp', () => {
  it('closesBefore ignores the current minute and everything later', () => {
    const base = at(120);
    recordSpotTick('btc', 100, base - 90_000);
    recordSpotTick('btc', 101, base - 30_000);
    recordSpotTick('btc', 777, base + 5_000);
    recordSpotTick('btc', 888, base + 400_000);
    const closes = closesBefore('btc', base, 5);
    expect(closes).not.toContain(777);
    expect(closes).not.toContain(888);
  });

  it('minuteOpen is the first price seen in the minute, and closes are the last', () => {
    const m = at(60);
    recordSpotTick('eth', 10, m + 1_000);
    recordSpotTick('eth', 12, m + 20_000);
    recordSpotTick('eth', 11, m + 50_000);
    expect(minuteOpen('eth', m + 55_000)).toBe(10);
    expect(closesBefore('eth', m + 60_000, 1)).toEqual([11]);
  });

  it('adding ticks after a row\'s time never changes that row', () => {
    warm();
    const now = at(150);
    const before = buildShadowRow(mk(now) as any);
    for (let i = 0; i < 20; i += 1) recordSpotTick('btc', 70_000 + i * 900, now + 1_000 + i * 20_000);
    const after = buildShadowRow(mk(now) as any);
    expect(after).toEqual(before);
    expect(before!.p_up_spot).not.toBeNull();
  });

  it('is deterministic: the same inputs give the same row', () => {
    warm();
    expect(buildShadowRow(mk(at(90)) as any)).toEqual(buildShadowRow(mk(at(90)) as any));
  });
});

describe('INVARIANT: a row is only written inside the window\'s sampling band', () => {
  it('no row in the first or last seconds, none for a slug that is not an up/down window', () => {
    warm();
    expect(buildShadowRow(mk(at(MIN_ELAPSED_S - 1)) as any)).toBeNull();
    expect(buildShadowRow(mk(at(MIN_ELAPSED_S)) as any)).not.toBeNull();
    expect(buildShadowRow(mk(at(300 - MIN_REMAINING_S + 1)) as any)).toBeNull();
    expect(buildShadowRow(mk(at(300 - MIN_REMAINING_S)) as any)).not.toBeNull();
    expect(buildShadowRow(mk(at(-30)) as any)).toBeNull();
    expect(buildShadowRow(mk(at(150), { market: { slug: 'will-it-rain', symbol: 'BTC' } }) as any)).toBeNull();
  });

  it('keeps both strike variants, the model\'s probability for each, and the book on both sides', () => {
    warm();
    const row = buildShadowRow(mk(at(150)) as any)!;
    expect(row.strike_oracle).toBe(80_000);
    expect(row.strike_spot).not.toBeNull();
    expect(row.p_up_oracle).toBeGreaterThan(0.5); // spot 80,050 above the 80,000 strike
    expect(row.up_ask).toBe(0.51);
    expect(row.down_ask).toBe(0.5);
    expect(row.ta_dir).toBe('down');
    expect(JSON.parse(row.ml_json as string)[0][1]).toBe('up');
    expect(row.dur_s).toBe(300);
    expect(row.end_ms).toBe((START + 300) * 1000);
  });

  it('records the model as unknown, not as 50%, until volatility has enough history', () => {
    const row = buildShadowRow(mk(at(150)) as any)!;
    expect(row.sigma_1m).toBeNull();
    expect(row.p_up_oracle).toBeNull();
  });

  it('samples a slug at most once per interval', () => {
    const rand = rng(11);
    const last = new Map<string, number>();
    const fired: number[] = [];
    let t = at(0);
    for (let i = 0; i < 2000; i += 1) {
      t += Math.floor(rand() * 4000);
      if (dueForSample(last, SLUG, t)) fired.push(t);
    }
    expect(fired.length).toBeGreaterThan(5);
    for (let i = 1; i < fired.length; i += 1) expect(fired[i] - fired[i - 1]).toBeGreaterThanOrEqual(SHADOW_INTERVAL_MS);
  });
});

describe('INVARIANT: an outcome is recorded only when the market has settled', () => {
  const settled = (outcomes: string, prices: string, meta: any = { finalPrice: 82434.87, priceToBeat: 82432.77 }) =>
    [{ eventMetadata: meta, markets: [{ outcomes, outcomePrices: prices }] }];

  it('reads the real Gamma shape (taken from a resolved btc-updown-5m market)', () => {
    expect(parseResolution(settled('["Up", "Down"]', '["1", "0"]'))).toEqual({ outcomeUp: true, finalPrice: 82434.87, openPrice: 82432.77 });
    expect(parseResolution(settled('["Up", "Down"]', '["0", "1"]'))!.outcomeUp).toBe(false);
  });

  it('follows the outcome label, not the position', () => {
    expect(parseResolution(settled('["Down", "Up"]', '["1", "0"]'))!.outcomeUp).toBe(false);
  });

  it('refuses a live book, a half-settled one and malformed payloads', () => {
    for (const bad of [
      settled('["Up", "Down"]', '["0.55", "0.45"]'),
      settled('["Up", "Down"]', '["0.995", "0.2"]'),
      settled('["Up", "Down"]', '["0.6", "0"]'),
      settled('["Up", "Down"]', '["0.02", "0.5"]'),
      settled('["Up", "Down"]', '["1"]'),
      settled('["Yes", "No"]', '["1", "0"]'),
      settled('not json', '["1","0"]'),
      [], null, undefined, [{ markets: [] }],
    ]) expect(parseResolution(bad as any)).toBeNull();
  });
});

describe('INVARIANT: the shadow log writes only its own table and never throws', () => {
  let db: any;
  const rows = () => db.prepare('SELECT COUNT(*) AS n FROM signal_shadow').get().n;
  const docs = () => db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(value)),0) AS b FROM docs').get();

  beforeAll(() => {
    expect(startSignalShadow()).toBe(true);
    db = getDb();
  });
  afterAll(() => stopSignalShadow());
  beforeEach(() => {
    db.exec('DELETE FROM signal_shadow');
    stopSignalShadow();
    startSignalShadow();
  });

  it('writes a row, once per interval, and leaves every other table as it was', () => {
    warm();
    const before = docs();
    expect(shadowObserve({ ...mk(at(100)) } as any)).toBe(true);
    expect(shadowObserve({ ...mk(at(105)) } as any)).toBe(false);
    expect(shadowObserve({ ...mk(at(100) + SHADOW_INTERVAL_MS + 1) } as any)).toBe(true);
    expect(rows()).toBe(2);
    expect(docs()).toEqual(before);
  });

  it('does nothing when switched off by config', () => {
    warm();
    expect(shadowObserve({ ...mk(at(100)), cfg: { signalShadow: false } } as any)).toBe(false);
    expect(rows()).toBe(0);
  });

  it('does not modify its inputs, even frozen ones', () => {
    warm();
    const input = deepFreeze(mk(at(100)));
    expect(() => shadowObserve(input as any)).not.toThrow();
    expect(rows()).toBe(1);
  });

  it('survives garbage without throwing', () => {
    const cyc: any = {}; cyc.self = cyc;
    for (const bad of [
      {}, { nowMs: NaN }, { nowMs: at(100), market: null }, { nowMs: at(100), market: cyc },
      { ...mk(at(100)), depth: 'x', signal: 5, mlPoints: 'nope', spot: 'abc' },
    ]) expect(() => shadowObserve(bad as any)).not.toThrow();
  });

  it('resolves ended windows from the injected feed, and only after the grace period', async () => {
    warm();
    shadowObserve(mk(at(100)) as any);
    const feed = async () => ({
      ok: true,
      json: async () => [{ eventMetadata: { finalPrice: 80_100, priceToBeat: 80_000 }, markets: [{ outcomes: '["Up","Down"]', outcomePrices: '["1","0"]' }] }],
    }) as any;
    const endMs = (START + 300) * 1000;
    expect(await resolvePending({ nowMs: endMs + 10_000, fetchImpl: feed })).toBe(0); // inside grace
    expect(db.prepare('SELECT outcome_up FROM signal_shadow').get().outcome_up).toBeNull();
    stopSignalShadow(); startSignalShadow(); // reset the resolver's run gate
    expect(await resolvePending({ nowMs: endMs + 200_000, fetchImpl: feed })).toBe(1);
    const row = db.prepare('SELECT outcome_up, final_price, open_price FROM signal_shadow').get();
    expect(row).toEqual({ outcome_up: 1, final_price: 80_100, open_price: 80_000 });
  });

  it('does not record an outcome from a live quote, and backs off a window that will not settle', async () => {
    warm();
    shadowObserve(mk(at(100)) as any);
    let calls = 0;
    const live = async () => { calls += 1; return { ok: true, json: async () => [{ markets: [{ outcomes: '["Up","Down"]', outcomePrices: '["0.6","0.4"]' }] }] } as any; };
    const endMs = (START + 300) * 1000;
    await resolvePending({ nowMs: endMs + 200_000, fetchImpl: live });
    expect(db.prepare('SELECT outcome_up FROM signal_shadow').get().outcome_up).toBeNull();
    expect(calls).toBe(1);
    // A second pass a minute on must not hammer the same slug at full rate.
    await resolvePending({ nowMs: endMs + 262_000, fetchImpl: live });
    expect(calls).toBe(1);
  });

  it('reports its own health without throwing', () => {
    const s = signalShadowStatus();
    expect(s.started).toBe(true);
    expect(s.writeErrors).toBe(0);
  });
});

describe('INVARIANT: the shadow module cannot reach money', () => {
  const src = repoFile('src/polymarket/signalShadow.ts');
  const botSrc = repoFile('src/polymarket/bot.ts');

  it('imports nothing from the ledger, the position store or the bot', () => {
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    for (const forbidden of ['ledger', 'paperLeg', 'positions', 'bot.js', 'trade.js', 'kelly', 'clob.js', 'withdraw', 'swap']) {
      expect(imports, forbidden).not.toContain(forbidden);
    }
  });

  it('is called from the market loop before any exit logic, and never awaited', () => {
    const call = botSrc.indexOf('shadowObserve({');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(botSrc.indexOf('const buildLiveSellDebug'));
    expect(botSrc).toMatch(/void resolveShadowPending\(\)/);
    expect(botSrc).not.toMatch(/await (shadowObserve|resolveShadowPending)/);
  });
});
