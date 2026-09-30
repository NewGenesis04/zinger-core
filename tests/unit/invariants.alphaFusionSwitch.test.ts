// @ts-nocheck
/**
 * Item 47. `useAlphaFusion` is the kill switch for the alpha-fusion layer, which
 * overwrites direction/confidence/score/edge on every signal. The scan reads it
 * as `cfg.useAlphaFusion !== false`, so the only way to turn fusion off is to
 * get a literal `false` into config and have it STAY there.
 *
 * It used to not stay. A key outside `STRATEGY_KEYS` is stashed on the profile
 * by `applyConfigPatch` but dropped whenever `pickStrategy` rebuilds the profile
 * (`normalizeConfigStore`), so `false` silently reverted to on.
 *
 * Property: a `false` written through the config patch survives every rebuild,
 * in both modes, and the default is an explicit `true`.
 */
import { describe, it, expect } from 'vitest';
import {
  STRATEGY_KEYS,
  defaultPaperStrategy,
  defaultLiveStrategy,
  normalizeConfigStore,
  applyConfigPatch,
  resolveActiveConfig,
} from '../../src/polymarket/modeConfig.js';

const freshStore = (mode = 'paper') => normalizeConfigStore({ mode, enabled: false }, {});

describe('INVARIANT: the fusion kill switch cannot re-arm itself (item 47)', () => {
  it('is a strategy key, so profile rebuilds keep it', () => {
    expect(STRATEGY_KEYS).toContain('useAlphaFusion');
  });

  it('defaults to an explicit true in both profiles', () => {
    expect(defaultPaperStrategy().useAlphaFusion).toBe(true);
    expect(defaultLiveStrategy().useAlphaFusion).toBe(true);
    const store = freshStore();
    expect(store.profiles.paper.useAlphaFusion).toBe(true);
    expect(store.profiles.live.useAlphaFusion).toBe(true);
  });

  for (const mode of ['paper', 'live']) {
    it(`a false patched in ${mode} mode survives normalisation and stays off`, () => {
      const patched = applyConfigPatch(freshStore(mode), { useAlphaFusion: false });
      expect(resolveActiveConfig(patched).useAlphaFusion).toBe(false);

      // The rebuild path that used to drop it: store in, store out.
      const rebuilt = normalizeConfigStore(patched, {});
      expect(resolveActiveConfig(rebuilt).useAlphaFusion).toBe(false);

      // ...and again, since it must be stable rather than merely lucky once.
      const twice = normalizeConfigStore(rebuilt, {});
      expect(resolveActiveConfig(twice).useAlphaFusion).toBe(false);

      // What the scan evaluates (`scan/inputs.ts`).
      expect(resolveActiveConfig(twice).useAlphaFusion !== false).toBe(false);
    });
  }

  it('does not leak across modes: switching off in paper leaves live on', () => {
    const patched = applyConfigPatch(freshStore('paper'), { useAlphaFusion: false });
    const rebuilt = normalizeConfigStore(patched, {});
    expect(rebuilt.profiles.paper.useAlphaFusion).toBe(false);
    expect(rebuilt.profiles.live.useAlphaFusion).toBe(true);
  });
});
