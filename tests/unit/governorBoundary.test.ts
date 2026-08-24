import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { REGIME_PROFILES, REGIME_LIST, GOVERNOR_FORBIDDEN_KEYS } from '../../src/ai/governor.js';

/**
 * The governor's write boundary (operator decision, 2026-08-21).
 *
 * The regime detector reads ADX/ATR on BTC/ETH spot — a directional signal. It
 * has no information about whether a Polymarket book is offering a mispriced
 * complementary pair, so it must not set arb thresholds or arb sizing.
 *
 * These are invariants on the boundary itself, not on today's overlay contents:
 * adding `minArbGap` back to a profile must fail this file.
 */

describe('INVARIANT: the governor cannot write arb thresholds or sizing', () => {
  it('declares no forbidden key in any regime overlay', () => {
    for (const name of REGIME_LIST) {
      for (const key of GOVERNOR_FORBIDDEN_KEYS) {
        expect(
          REGIME_PROFILES[name],
          `regime '${name}' must not declare '${key}'`,
        ).not.toHaveProperty(key);
      }
    }
  });

  it('enforces the boundary inside applyProfile, not by absence alone', () => {
    // `applyProfile` is module-internal, so this asserts the strip exists at the
    // source rather than re-implementing it here — a test that re-ran the same
    // delete loop would pass even with the real strip removed. Verified by
    // mutation: deleting the line below fails this test.
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/ai/governor.ts'), 'utf8');
    const body = src.slice(src.indexOf('function applyProfile'), src.indexOf('function persistState'));
    expect(body).toMatch(/for \(const k of GOVERNOR_FORBIDDEN_KEYS\) delete patch\[k\];/);
    // …and it must run before the live-only branch, so it applies in paper too.
    expect(body.indexOf('GOVERNOR_FORBIDDEN_KEYS'))
      .toBeLessThan(body.indexOf('LIVE_PROTECTED'));
  });

  it('still lets the governor turn arb on and off', () => {
    // on/off is the regime call the governor exists to make. Only how-much is
    // out of bounds. If this ever fails, the boundary was drawn too wide.
    expect(GOVERNOR_FORBIDDEN_KEYS.has('clobArbEnabled')).toBe(false);
    expect(GOVERNOR_FORBIDDEN_KEYS.has('arbOnlyUntilEdge')).toBe(false);
    expect(REGIME_PROFILES['arb-only'].clobArbEnabled).toBe(true);
  });

  it('covers every arb threshold and sizing key that exists', () => {
    // If a new arb dial is added to STRATEGY_KEYS, it belongs here too.
    for (const k of ['minArbGap', 'arbMinMarginPct', 'maxArbPackages', 'arbBankrollFrac', 'arbMaxUsd']) {
      expect(GOVERNOR_FORBIDDEN_KEYS.has(k), `${k} must be forbidden`).toBe(true);
    }
  });
});
