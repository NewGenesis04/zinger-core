import { describe, expect, it } from 'vitest';
import {
  defaultLiveStrategy,
  normalizeConfigStore,
  assertLiveSafetyCaps,
} from '../../src/polymarket/modeConfig.js';

describe('Chunk 4: Live Safety Caps & Migration Defense (D11, Items 19, 28)', () => {
  it('defaultLiveStrategy requires manual trade approval by default (Item 28)', () => {
    const live = defaultLiveStrategy();
    expect(live.autoApproveLive).toBe(false);
    expect(live.announceBeforeTrade).toBe(true);
    expect(live.requireEdgeForLive).toBe(true);
    expect(live.maxPositionCap).toBe(1.0);
  });

  it('normalizeConfigStore protects live caps from legacy flat config inflation (Item 19)', () => {
    const legacyFlat = {
      mode: 'live',
      maxPositionCap: 100, // Paper-shaped
      certaintyMaxUsd: 100,
      arbMaxUsd: 50,
      maxOpenPositions: 4,
    };

    const normalized = normalizeConfigStore(legacyFlat);
    const liveProfile = normalized.profiles.live;

    // Live profile must preserve safety caps instead of inflating 100x
    expect(liveProfile.maxPositionCap).toBe(1.0);
    expect(liveProfile.certaintyMaxUsd).toBe(2.0);
    expect(liveProfile.arbMaxUsd).toBe(1.0);
    expect(liveProfile.maxOpenPositions).toBe(1);
    expect(liveProfile.autoApproveLive).toBe(false);
  });

  it('assertLiveSafetyCaps validates live blast radius limits (D11)', () => {
    const safeLive = defaultLiveStrategy();
    expect(assertLiveSafetyCaps(safeLive).ok).toBe(true);

    const dangerousLive = {
      ...safeLive,
      maxPositionCap: 500, // Dangerous
      autoApproveLive: true,
    };
    const check = assertLiveSafetyCaps(dangerousLive);
    expect(check.ok).toBe(false);
    expect(check.violations.length).toBeGreaterThan(0);
    expect(check.violations[0]).toContain('maxPositionCap');
  });
});
