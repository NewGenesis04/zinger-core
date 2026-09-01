import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeCertaintyKelly,
  computeKellySize,
  resolveIdioVolTilt,
  setKellyTradeHistory,
} from '../../src/polymarket/kelly.js';

/**
 * Volatility-tilted Kelly sizing, ported from the David-glitc/Zinger fork.
 *
 * The tilt shrinks position size as realized volatility climbs above a calm
 * baseline (low-vol anomaly, Ang–Hodrick–Xing–Zhang 2006). It touches the two
 * functions that decide how much real money goes on every directional trade,
 * so the properties below are about *safety of the port*, not about whether the
 * academic effect is real.
 *
 * The load-bearing one is the first: with no vol reading, sizing must be
 * bit-identical to what it was before the tilt existed. Nothing in this repo
 * passes realizedVol yet (that is step 3 of the integration), so if that
 * identity ever breaks, the tilt has silently started resizing live trades
 * from a code path no caller opted into.
 */

const POSITIVE_EDGE_HISTORY = [
  ...Array.from({ length: 14 }, () => ({ pnl: 3 })),
  ...Array.from({ length: 6 }, () => ({ pnl: -1 })),
];

describe('INVARIANT: an absent vol reading changes nothing', () => {
  beforeEach(() => {
    setKellyTradeHistory(POSITIVE_EDGE_HISTORY);
  });

  it('is the identity scale when no vol is supplied', () => {
    // Not "close to 1" — exactly 1, so `x * volScale === x` in floating point.
    for (const args of [
      undefined,
      {},
      { realizedVol: undefined, calmBaseline: undefined },
      { realizedVol: 0, calmBaseline: 0.008 },
      { realizedVol: null, calmBaseline: null },
      { realizedVol: Number.NaN, calmBaseline: 0.008 },
      { realizedVol: -0.5, calmBaseline: 0.008 },
    ]) {
      const tilt = resolveIdioVolTilt(args as never);
      expect(tilt.volScale, `volScale for ${JSON.stringify(args)}`).toBe(1);
      expect(tilt.method).toBe('no_vol');
    }
  });

  it('sizes computeKellySize identically with and without the new params', () => {
    const base = {
      bankroll: 100, price: 0.55, signalConfidence: 0.6,
      historicalWinRate: 0.7, tradeCount: 20, minUsd: 1, maxUsd: 20,
    };
    const before = computeKellySize(base);
    const after = computeKellySize({ ...base, realizedVol: undefined, calmBaseline: undefined });

    expect(after.method).toBe('kelly');
    expect(after.sizeUsd).toBe(before.sizeUsd);
    expect(after.kellyFraction).toBe(before.kellyFraction);
  });

  it('sizes computeCertaintyKelly identically with and without the new params', () => {
    const base = {
      price: 0.72, confidence: 0.8, remaining: 60,
      windowSec: 300, bankroll: 100, maxUsd: 20,
    };
    const before = computeCertaintyKelly(base);
    const after = computeCertaintyKelly({ ...base, realizedVol: undefined, calmBaseline: undefined });

    expect(before).not.toBeNull();
    expect(after.sizeUsd).toBe(before!.sizeUsd);
    expect(after.betPct).toBe(before!.betPct);
  });
});

/**
 * The tilt may only ever *reduce* size. A guardrail that can enlarge a position
 * during a volatility spike is not a guardrail — and `Math.exp(-(ratio-1)/knee)`
 * exceeds 1 for any ratio below 1, which is exactly what the `Math.min(1, …)`
 * exists to stop. Delete that clamp and the calmest markets get the biggest bets.
 */
describe('INVARIANT: the vol tilt only ever de-risks', () => {
  it('never scales above 1, however calm the market is', () => {
    for (const realizedVol of [0.0001, 0.001, 0.004, 0.008]) {
      expect(resolveIdioVolTilt({ realizedVol, calmBaseline: 0.008 }).volScale)
        .toBeLessThanOrEqual(1);
    }
  });

  it('never scales below the floor, however violent the market is', () => {
    for (const realizedVol of [0.05, 0.5, 5, 500]) {
      const { volScale } = resolveIdioVolTilt({ realizedVol, calmBaseline: 0.008 });
      expect(volScale).toBeGreaterThanOrEqual(0.35);
      expect(Number.isFinite(volScale)).toBe(true);
    }
  });

  it('is monotonically non-increasing in realized vol', () => {
    // The whole economic claim of the tilt. If a higher vol reading ever
    // produced a larger scale, the sign of the effect would be inverted —
    // the exact class of bug that inverted cluster labels in the jump model.
    const scales = [0.004, 0.008, 0.012, 0.02, 0.05, 0.2]
      .map((realizedVol) => resolveIdioVolTilt({ realizedVol, calmBaseline: 0.008 }).volScale);
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i], `vol step ${i} scaled up instead of down`).toBeLessThanOrEqual(scales[i - 1]);
    }
    // …and it must actually move, or the tilt is decorative.
    expect(scales.at(-1)).toBeLessThan(scales[0]);
  });

  it('is exactly 1 at the baseline, so a calm market is untouched', () => {
    expect(resolveIdioVolTilt({ realizedVol: 0.008, calmBaseline: 0.008 }).volScale).toBe(1);
  });
});

/**
 * INVARIANT: both branches read the same unit (backlog 39, fixed).
 *
 * The ratio branch divides, so units cancel. The no-baseline branch compares
 * against absolute constants and therefore has to agree with the producer.
 * `ml/regime_emit.py` derives both numbers from the model's own downside-
 * deviation feature and stamps `volUnit: "decimal_return"` — measured on real
 * cached BTC 1h data the low-vol state sits near 0.012, and on synthetic calm
 * data near 0.006.
 *
 * The fork's constants were `1.5` and `0.8`: the same thresholds on a *percent*
 * scale, inherited from `atrPct`. Fed decimals they never tripped, so the
 * branch silently never de-risked.
 */
describe('INVARIANT: the absolute branch is calibrated to the emitter', () => {
  const scale = (realizedVol: number) => resolveIdioVolTilt({ realizedVol }).volScale;

  it('de-risks on the decimal readings the emitter actually produces', () => {
    // The regression: on percent-scale constants every one of these was 1.
    expect(scale(0.004)).toBe(1);      // calm
    expect(scale(0.012)).toBe(0.6);    // elevated — a real BTC 1h low-vol read
    expect(scale(0.02)).toBe(0.35);    // extreme
  });

  it('crosses at the documented thresholds, not somewhere near them', () => {
    expect(scale(0.00799)).toBe(1);
    expect(scale(0.008)).toBe(0.6);
    expect(scale(0.01499)).toBe(0.6);
    expect(scale(0.015)).toBe(0.35);
  });

  it('reports which branch it took, so a wrong-units call site is diagnosable', () => {
    expect(resolveIdioVolTilt({ realizedVol: 0.012 }).method).toBe('vol_absolute');
    expect(resolveIdioVolTilt({ realizedVol: 0.012, calmBaseline: 0.008 }).method).toBe('vol_ratio');
  });

  it('flags a reading that is almost certainly percent-scaled', () => {
    // A 50%-per-bar downside deviation is not a market, it is a unit error.
    // Flagged rather than corrected — guessing at the caller's scale is how the
    // mismatch got in, and the flag lands in the trade record.
    expect(resolveIdioVolTilt({ realizedVol: 0.012 }).unitSuspect).toBe(false);
    expect(resolveIdioVolTilt({ realizedVol: 1.2 }).unitSuspect).toBe(true);
    expect(resolveIdioVolTilt({ realizedVol: 1.2, calmBaseline: 0.8 }).unitSuspect).toBe(true);
  });

  it('stays unit-invariant on the ratio branch', () => {
    // Same ratio, three scales — the branch that divides must not care.
    const decimal = resolveIdioVolTilt({ realizedVol: 0.016, calmBaseline: 0.008 });
    const percent = resolveIdioVolTilt({ realizedVol: 1.6, calmBaseline: 0.8 });
    const bps = resolveIdioVolTilt({ realizedVol: 160, calmBaseline: 80 });
    expect(percent.volScale).toBe(decimal.volScale);
    expect(bps.volScale).toBe(decimal.volScale);
  });
});

describe('a live vol reading actually shrinks the position', () => {
  beforeEach(() => {
    setKellyTradeHistory(POSITIVE_EDGE_HISTORY);
  });

  it('cuts computeKellySize during a vol spike', () => {
    const base = {
      bankroll: 100, price: 0.55, signalConfidence: 0.6,
      historicalWinRate: 0.7, tradeCount: 20, minUsd: 0.4, maxUsd: 50,
    };
    const calm = computeKellySize({ ...base, realizedVol: 0.008, calmBaseline: 0.008 });
    const spike = computeKellySize({ ...base, realizedVol: 0.04, calmBaseline: 0.008 });

    expect(spike.sizeUsd).toBeLessThan(calm.sizeUsd);
    expect(spike.volTilt.method).toBe('vol_ratio');
  });

  it('cuts computeCertaintyKelly during a vol spike', () => {
    const base = {
      price: 0.72, confidence: 0.8, remaining: 60,
      windowSec: 300, bankroll: 100, maxUsd: 50,
    };
    const calm = computeCertaintyKelly({ ...base, realizedVol: 0.008, calmBaseline: 0.008 });
    const spike = computeCertaintyKelly({ ...base, realizedVol: 0.04, calmBaseline: 0.008 });

    expect(spike!.sizeUsd).toBeLessThan(calm!.sizeUsd);
  });

  it('cuts the cold-start path too — the canary lives there', () => {
    // backlog 40: the fork resolved volTilt before the `tradeCount < 10` early
    // return and never applied it, leaving the path with the least history —
    // and so the least justification for size — completely untilted.
    const base = {
      bankroll: 100, price: 0.55, signalConfidence: 0.6,
      historicalWinRate: 0.55, tradeCount: 3, minUsd: 1, maxUsd: 20,
    };
    const calm = computeKellySize({ ...base, realizedVol: 0.008, calmBaseline: 0.008 });
    const spike = computeKellySize({ ...base, realizedVol: 0.04, calmBaseline: 0.008 });

    expect(calm.method).toBe('confidence_scaling');
    expect(spike.method).toBe('confidence_scaling');
    expect(spike.sizeUsd).toBeLessThan(calm.sizeUsd);
  });

  it('never tilts the cold-start path below the exchange minimum', () => {
    // The tilt shrinks the discretionary part above minUsd, so however violent
    // the market gets, the order still clears the venue's floor. A guardrail
    // that produces an unfillable order is not a guardrail.
    const base = {
      bankroll: 100, price: 0.55, signalConfidence: 0.6,
      historicalWinRate: 0.55, tradeCount: 3, minUsd: 1, maxUsd: 20,
    };
    for (const realizedVol of [0.02, 0.5, 50]) {
      const out = computeKellySize({ ...base, realizedVol, calmBaseline: 0.008 });
      expect(out.sizeUsd, `sized below minUsd at rv=${realizedVol}`).toBeGreaterThanOrEqual(1);
      expect(out.sizeUsd).toBeLessThanOrEqual(20);
    }
  });

  it('leaves the cold-start path untouched when no vol is supplied', () => {
    // The identity property has to survive the cold-start change too — this is
    // the path the canary is on right now, and nothing feeds it vol yet.
    const base = {
      bankroll: 100, price: 0.55, signalConfidence: 0.6,
      historicalWinRate: 0.55, tradeCount: 3, minUsd: 1, maxUsd: 20,
    };
    expect(computeKellySize({ ...base, realizedVol: undefined }).sizeUsd)
      .toBe(computeKellySize(base).sizeUsd);
  });
});
