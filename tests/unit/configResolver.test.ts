import { describe, expect, it } from 'vitest';
import {
  TIERS, TIER_NAMES, compareTiers, isSet, resolveTiered, resolveNumber,
} from '../../src/polymarket/config/resolver.js';
import {
  resolveEntryWindows, DURATION_ENTRY_DEFAULTS,
} from '../../src/polymarket/heuristics/fundHeuristics.js';

/**
 * D3 — config precedence: operator > guardrail > automation.
 *
 * The read side. Item 26 is the motivating defect: `resolveEntryWindows` put
 * the heuristic first in a `??` chain, and because heuristicForTrade merges
 * DURATION_ENTRY_DEFAULTS in before returning, every operator fallback below it
 * was unreachable. Measured on the real store — where no trained policy exists
 * at all — an operator asking for a 50% confidence floor got 38%, the hardcoded
 * 5m prior, and 42%/49% signals passed.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: authority order is operator > guardrail > automation', () => {
  it('orders the tiers as D3 specifies', () => {
    expect(TIERS.operator).toBeGreaterThan(TIERS.guardrail);
    expect(TIERS.guardrail).toBeGreaterThan(TIERS.automation);
    // A default is not a writer — a trained value must beat a hardcoded prior.
    expect(TIERS.automation).toBeGreaterThan(TIERS.default);
    expect(TIER_NAMES).toEqual(['default', 'automation', 'guardrail', 'operator']);
  });

  it('lets the operator win over every automated writer', () => {
    const hit = resolveTiered([
      { tier: 'automation', value: 0.38, source: 'prior' },
      { tier: 'operator', value: 0.5, source: 'cfg' },
      { tier: 'guardrail', value: 0.45, source: 'clamp' },
    ]);
    expect(hit.value).toBe(0.5);
    expect(hit.tier).toBe('operator');
  });

  it('lets a guardrail win over automation', () => {
    const hit = resolveTiered([
      { tier: 'automation', value: 0.38, source: 'governor' },
      { tier: 'guardrail', value: 0.45, source: 'edge gate' },
    ]);
    expect(hit.tier).toBe('guardrail');
  });

  it('falls to the default only when nobody has an opinion', () => {
    const hit = resolveTiered([
      { tier: 'operator', value: null, source: 'cfg' },
      { tier: 'automation', value: undefined, source: 'trained' },
      { tier: 'default', value: 0.38, source: 'prior' },
    ]);
    expect(hit.value).toBe(0.38);
    expect(hit.tier).toBe('default');
  });

  it('breaks ties by candidate order, so specific beats generic', () => {
    // cfg.minRemainingSec_15m is more specific than cfg.minRemainingSec, and
    // both are operator intent.
    const hit = resolveTiered([
      { tier: 'operator', value: 60, source: 'cfg.x_15m' },
      { tier: 'operator', value: 30, source: 'cfg.x' },
    ]);
    expect(hit.value).toBe(60);
    expect(hit.source).toBe('cfg.x_15m');
  });

  it('reports what it overrode, so an ignored setting is explainable', () => {
    const hit = resolveTiered([
      { tier: 'operator', value: 0.5, source: 'cfg.minConfidence' },
      { tier: 'default', value: 0.38, source: 'prior' },
    ]);
    expect(hit.overrode).toEqual([{ tier: 'default', source: 'prior', value: 0.38 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: nullish means unset — 0 and false do not', () => {
  // The bug class this whole module exists to prevent. A `||` chain discards
  // `minRemainingSec: 0` and `adaptiveSl: false`, both real operator choices.
  it('treats 0, false and empty string as set', () => {
    expect(isSet(0)).toBe(true);
    expect(isSet(false)).toBe(true);
    expect(isSet('')).toBe(true);
  });

  it('treats null, undefined and NaN as unset', () => {
    expect(isSet(null)).toBe(false);
    expect(isSet(undefined)).toBe(false);
    // NaN would compare false against every threshold, silently removing it.
    expect(isSet(NaN)).toBe(false);
  });

  it('honours an operator zero over a non-zero default', () => {
    const hit = resolveTiered([
      { tier: 'operator', value: 0, source: 'cfg' },
      { tier: 'default', value: 25, source: 'prior' },
    ]);
    expect(hit.value).toBe(0);
    expect(hit.tier).toBe('operator');
  });

  it('honours an operator false over a true default', () => {
    const hit = resolveTiered([
      { tier: 'operator', value: false, source: 'cfg' },
      { tier: 'default', value: true, source: 'prior' },
    ]);
    expect(hit.value).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: a non-numeric setting falls back rather than becoming NaN', () => {
  it('rejects a typo instead of silently removing the threshold', () => {
    // Number('lots') is NaN, and `confidence < NaN` is always false — the gate
    // would disappear entirely.
    const hit = resolveNumber([
      { tier: 'operator', value: 'lots', source: 'cfg' },
      { tier: 'default', value: 0.38, source: 'prior' },
    ], 0.38);
    expect(hit.value).toBe(0.38);
    expect(hit.coerceFailed).toBe(true);
  });

  it('still coerces a numeric string, which is what a form posts', () => {
    const hit = resolveNumber([{ tier: 'operator', value: '0.5', source: 'cfg' }], 0.38);
    expect(hit.value).toBe(0.5);
    expect(hit.coerceFailed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: an explicit entry threshold beats the prior (item 26)', () => {
  const prior5m = DURATION_ENTRY_DEFAULTS['5m'];

  it('uses the prior when the operator has set nothing', () => {
    const r = resolveEntryWindows('5m', {});
    expect(r.minConfidence).toBe(prior5m.minConfidence);
    expect(r.minRemainingSec).toBe(prior5m.minRemainingSec);
    expect(r.source).toBe('prior');
  });

  it('honours the operator confidence floor over the prior', () => {
    // The measured defect: operator asked 0.5, gate ran at 0.38.
    const r = resolveEntryWindows('5m', { minConfidence: 0.5 });
    expect(r.minConfidence).toBe(0.5);
    expect(r.resolved.minConfidence.tier).toBe('operator');
    expect(r.resolved.minConfidence.overrode).toEqual([
      { tier: 'default', source: 'prior', value: prior5m.minConfidence },
    ]);
  });

  it('honours an operator zero for minRemainingSec', () => {
    // The probe value from item 26's own measurement.
    expect(resolveEntryWindows('5m', { minRemainingSec: 0 }).minRemainingSec).toBe(0);
  });

  it('honours the per-duration key on a non-5m market', () => {
    const r = resolveEntryWindows('15m', { maxEntryRemainingSec_15m: 600 });
    expect(r.maxEntryRemainingSec).toBe(600);
    expect(r.resolved.maxEntryRemainingSec.tier).toBe('operator');
  });

  it('attributes every threshold to the tier that supplied it', () => {
    // The D3 gate: "why is this threshold what it is" answered from the value.
    const r = resolveEntryWindows('5m', { minConfidence: 0.5 });
    expect(r.resolved.minConfidence.source).toBe('cfg.minConfidence');
    expect(r.resolved.minRemainingSec.source).toBe('prior');
    expect(Object.keys(r.resolved).sort())
      .toEqual(['maxEntryRemainingSec', 'minConfidence', 'minRemainingSec']);
  });

  it('keeps the generic timing keys scoped to 5m, as before (item 30)', () => {
    // Deliberately unchanged. The stored maxEntryRemainingSec is 270 — a
    // 5m-shaped number — and applying it to 15m would cut that window from
    // 800s to 270s. That is a trading change, not a precedence fix.
    const r = resolveEntryWindows('15m', { maxEntryRemainingSec: 270, minRemainingSec: 30 });
    expect(r.maxEntryRemainingSec).toBe(DURATION_ENTRY_DEFAULTS['15m'].maxEntryRemainingSec);
    expect(r.minRemainingSec).toBe(DURATION_ENTRY_DEFAULTS['15m'].minRemainingSec);
    // minConfidence was always generic-for-all-durations; that stays true.
    expect(resolveEntryWindows('15m', { minConfidence: 0.6 }).minConfidence).toBe(0.6);
  });

  it('prefers a trained stratum over the prior but not over the operator', () => {
    // Ordering check that does not depend on a trained store existing: the
    // candidate list must place automation between operator and default.
    const hit = resolveTiered([
      { tier: 'operator', value: 0.5, source: 'cfg' },
      { tier: 'automation', value: 0.44, source: 'stratum' },
      { tier: 'default', value: 0.38, source: 'prior' },
    ]);
    expect(hit.value).toBe(0.5);
    const noOperator = resolveTiered([
      { tier: 'automation', value: 0.44, source: 'stratum' },
      { tier: 'default', value: 0.38, source: 'prior' },
    ]);
    expect(noOperator.value).toBe(0.44);
    expect(noOperator.tier).toBe('automation');
  });
});
