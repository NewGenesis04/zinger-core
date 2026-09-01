import { beforeEach, describe, expect, it } from 'vitest';
import {
  REGIME_LIST,
  REGIME_PROFILES,
  detectRegime,
  detectRegimeFromModel,
} from '../../src/ai/governor.js';
import { loadFusionContext, resolveFusionRegime } from '../../src/polymarket/signal.js';
import {
  REGIME_SIGNAL_FILE,
  REGIME_SIGNAL_MAX_AGE_MS,
  isHighVol,
  loadRegimeSignal,
} from '../../src/polymarket/regimeSignal.js';
import { saveFileOrStore } from '../../src/polymarket/sqliteStore.js';

/**
 * Every regime must stay *reachable*, not merely defined.
 *
 * Two ways a profile silently dies:
 *
 *   1. The heuristic stops being able to name it. `scalp` is the else-branch, so
 *      it dies if the arb/trend guards ever widen to cover the whole input space.
 *   2. An overlay answers on an axis it cannot see. The jump model is
 *      `n_states=2` — high-vol or not — so if a calm reading is allowed to name
 *      `trend-ride`, then `scalp` becomes unreachable for as long as the ML side
 *      keeps emitting. That regression shipped once in the fork's fusion wiring
 *      (backlog 37); the last block here pins both consumers against it.
 */

/** Shape `detectRegime` reads: per-asset ADX and ATR%. */
function signalsFor({ adx, atrPct, trend = 'up' }: { adx: number; atrPct: number; trend?: string }) {
  return { btc: { adx: { adx, trend }, volatility: { atrPct } } };
}

const TRENDING = signalsFor({ adx: 34, atrPct: 0.2 });
const CHOPPY = signalsFor({ adx: 12, atrPct: 0.2, trend: 'range' });
const HOT = signalsFor({ adx: 15, atrPct: 0.8 });

function writeSignal(regime: string, at = new Date().toISOString()) {
  saveFileOrStore(REGIME_SIGNAL_FILE, {
    regime,
    highVol: regime === 'high-vol',
    at,
    flips: 3,
    // Decimal per-bar downside deviation, the unit ml/regime_emit.py emits.
    realizedVol: 0.012,
    calmBaseline: 0.008,
    volUnit: 'decimal_return',
    source: 'statistical-jump-model',
  });
}

describe('INVARIANT: all three regimes stay reachable', () => {
  it('defines exactly the three profiles the bot switches between', () => {
    expect(REGIME_LIST).toEqual(['trend-ride', 'scalp', 'arb-only']);
  });

  it('reaches every profile from the ADX/ATR heuristic alone', () => {
    const reached = new Set([
      detectRegime({ signals: HOT }).regime,      // hot vol → out of directional
      detectRegime({ signals: TRENDING }).regime, // calm and trending → ride it
      detectRegime({ signals: CHOPPY }).regime,   // calm and directionless → scalp
    ]);
    for (const name of REGIME_LIST) {
      expect(reached, `regime '${name}' is unreachable from the heuristic`).toContain(name);
    }
  });

  it('gives every profile a non-empty overlay', () => {
    for (const name of REGIME_LIST) {
      expect(Object.keys(REGIME_PROFILES[name]).length, `'${name}' overlay is empty`).toBeGreaterThan(0);
    }
  });
});

/**
 * `regimeSignal.ts` is the single owner of the jump-model reading. Its whole
 * reason for existing is that two consumers must agree on where it lives and
 * when it is too old to trust — so freshness is enforced there, once, rather
 * than in each consumer.
 */
describe('the regime signal is read through one owner, with one staleness rule', () => {
  it('reads a fresh reading back through the shared store', () => {
    writeSignal('high-vol');
    const signal = loadRegimeSignal();
    expect(signal, 'regime signal did not round-trip through the store').not.toBeNull();
    expect(isHighVol(signal)).toBe(true);
  });

  it('ignores a reading older than the max age', () => {
    writeSignal('high-vol', new Date(Date.now() - (REGIME_SIGNAL_MAX_AGE_MS + 60_000)).toISOString());
    expect(loadRegimeSignal()).toBeNull();
  });

  it('ignores a malformed reading rather than trusting a partial one', () => {
    for (const junk of [null, {}, { at: new Date().toISOString() }, { regime: '' }]) {
      saveFileOrStore(REGIME_SIGNAL_FILE, junk);
      expect(loadRegimeSignal(), `accepted junk: ${JSON.stringify(junk)}`).toBeNull();
    }
  });

  it('ignores an unparseable timestamp instead of treating it as age zero', () => {
    writeSignal('high-vol', 'not-a-date');
    expect(loadRegimeSignal()).toBeNull();
  });

  it('reports high-vol only for the label the model actually emits', () => {
    // `ml/regime_jump.py` label_regime() emits exactly 'high-vol' or 'trend'.
    expect(isHighVol({ regime: 'high-vol' })).toBe(true);
    expect(isHighVol({ regime: 'trend' })).toBe(false);
    expect(isHighVol({ regime: 'highvol' })).toBe(false);
    expect(isHighVol(null)).toBe(false);
  });
});

describe('the jump model overlays risk-on/off without collapsing the regime set', () => {
  beforeEach(() => {
    writeSignal('trend');
  });

  it('forces arb-only when the model reports high volatility', () => {
    writeSignal('high-vol');
    expect(detectRegimeFromModel()?.regime).toBe('arb-only');
  });

  it('names no regime on a calm reading, leaving trend-ride and scalp to ADX', () => {
    // The regression: a two-state model must not answer the trend/chop question.
    const verdict = detectRegimeFromModel();
    expect(verdict).not.toBeNull();
    expect(verdict!.regime).toBeNull();
    // …but it must still record that it was consulted.
    expect(verdict!.reasons.join(' ')).toMatch(/jump-model/i);
  });

  it('keeps scalp and trend-ride reachable while a fresh calm signal exists', () => {
    const overlay = detectRegimeFromModel();
    const resolve = (signals: unknown) => {
      const base = detectRegime({ signals });
      return overlay?.regime ? overlay.regime : base.regime;
    };
    expect(resolve(TRENDING)).toBe('trend-ride');
    expect(resolve(CHOPPY)).toBe('scalp');
  });

  it('feeds the same reading to the alpha fusion, not just the governor', async () => {
    // Both consumers must go through regimeSignal.ts. The fusion once called
    // loadRegimeSignal without importing it — inside a bare catch, so it went
    // silently blind while the governor kept working.
    writeSignal('high-vol');
    const ctx = await loadFusionContext();
    expect(ctx, 'alpha fusion is blind to the regime signal').not.toBeNull();
    expect(ctx!.btc.regime).toBe('highvol');
    expect(detectRegimeFromModel()?.regime).toBe('arb-only');
  });

  it('ignores a stale reading in both consumers at once', async () => {
    writeSignal('high-vol', new Date(Date.now() - 7 * 3600_000).toISOString());
    expect(loadRegimeSignal()).toBeNull();
    expect(detectRegimeFromModel()).toBeNull();
    expect(await loadFusionContext()).toBeNull();
  });
});

/**
 * INVARIANT: the fusion asks the model only what a two-state model can answer.
 *
 * Backlog 37. `label_regime()` spells the calm state 'trend' — a state name, not
 * a verdict. Mapping it straight through made every calm minute select
 * `REGIME_WEIGHTS.trend` (momentum 0.45 vs chop's 0.20) and add a +0.4 "ride"
 * vote, so `chop` was unreachable in the fusion whenever the ML side emitted.
 */
describe('INVARIANT: the fusion regime matches the governor split', () => {
  it('never lets the model name trend, however its calm state is spelled', () => {
    for (const adxRegime of [null, 'scalp', 'trend-ride', 'arb-only']) {
      // A calm model reading contributes nothing; only ADX can say 'trend'.
      const withModel = resolveFusionRegime({ regime: 'trend' }, adxRegime);
      const withoutModel = resolveFusionRegime(null, adxRegime);
      expect(withModel, `calm model changed the verdict under ADX '${adxRegime}'`)
        .toBe(withoutModel);
    }
  });

  it('lets the model force high-vol over any ADX opinion', () => {
    for (const adxRegime of [null, 'scalp', 'trend-ride', 'arb-only']) {
      expect(resolveFusionRegime({ regime: 'high-vol' }, adxRegime)).toBe('highvol');
    }
  });

  it('keeps all three fusion weight profiles reachable', () => {
    const reached = new Set([
      resolveFusionRegime({ regime: 'high-vol' }, null),
      resolveFusionRegime(null, 'trend-ride'),
      resolveFusionRegime(null, 'scalp'),
    ]);
    for (const name of ['highvol', 'trend', 'chop']) {
      expect(reached, `fusion regime '${name}' is unreachable`).toContain(name);
    }
  });

  it('defers trend-vs-chop to ADX on a calm reading, end to end', async () => {
    writeSignal('trend');
    expect((await loadFusionContext({ adxRegime: 'scalp' }))!.btc.regime).toBe('chop');
    expect((await loadFusionContext({ adxRegime: 'trend-ride' }))!.btc.regime).toBe('trend');
    // The bug: a calm model reading forcing momentum weighting on its own.
    expect((await loadFusionContext({ adxRegime: null }))!.btc.regime).toBe('chop');
  });

  it('still carries the vol magnitudes on a calm reading', async () => {
    // The regime label and the vol tilt are different axes. Deferring the label
    // to ADX must not throw away the numbers the tilt needs.
    writeSignal('trend');
    const ctx = await loadFusionContext({ adxRegime: 'scalp' });
    expect(ctx!.btc.regimeSignal.realizedVol).toBe(0.012);
    expect(ctx!.btc.regimeSignal.calmBaseline).toBe(0.008);
    expect(ctx!.btc.regimeSignal.highVol).toBe(false);
  });

  it('still returns a context from ADX alone when the model is stale', async () => {
    writeSignal('high-vol', new Date(Date.now() - 7 * 3600_000).toISOString());
    const ctx = await loadFusionContext({ adxRegime: 'trend-ride' });
    expect(ctx, 'ADX-only context was dropped with the stale model reading').not.toBeNull();
    expect(ctx!.btc.regime).toBe('trend');
    expect(ctx!.btc.regimeSignal).toBeNull();
  });
});
