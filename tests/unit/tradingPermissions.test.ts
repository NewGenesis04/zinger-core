import { describe, expect, it } from 'vitest';
import { resolveTradingPermissions } from '../../src/polymarket/config/resolver.js';
import { validateConfig } from '../../src/polymarket/modeConfig.js';

describe('Chunk 3: Governor Advice & Trading Permissions Resolver (D3, Items 3, 4, 5)', () => {
  describe('resolveTradingPermissions()', () => {
    it('operator tier forceArbOnly outranks edgeOk and governor regime', () => {
      const result = resolveTradingPermissions({
        cfg: { forceArbOnly: true, arbOnlyUntilEdge: true, mode: 'paper' },
        edgeState: { edgeOk: true, sampleOk: true, n: 50 },
        governorDecision: { regime: 'trend-ride', drawdownBreakerActive: false },
      });

      expect(result.arbOnly).toBe(true);
      expect(result.directionalAllowed).toBe(false);
      expect(result.tier).toBe('operator');
      expect(result.reason).toContain('forceArbOnly');
    });

    it('guardrail tier drawdown breaker forces arb-only even when operator has not forced it', () => {
      const result = resolveTradingPermissions({
        cfg: { forceArbOnly: false, arbOnlyUntilEdge: false, mode: 'paper' },
        edgeState: { edgeOk: true },
        governorDecision: { regime: 'arb-only', drawdownBreakerActive: true, reason: 'drawdown breaker -14%' },
      });

      expect(result.arbOnly).toBe(true);
      expect(result.directionalAllowed).toBe(false);
      expect(result.tier).toBe('guardrail');
      expect(result.reason).toContain('drawdown breaker');
    });

    it('automation tier edge gate locks directional when sample size is insufficient', () => {
      const result = resolveTradingPermissions({
        cfg: { forceArbOnly: false, arbOnlyUntilEdge: true, mode: 'paper' },
        edgeState: { edgeOk: false, sampleOk: false, reason: 'need 40 directional closes (have 5)' },
        governorDecision: { regime: 'scalp', drawdownBreakerActive: false },
      });

      expect(result.arbOnly).toBe(true);
      expect(result.directionalAllowed).toBe(false);
      expect(result.tier).toBe('automation');
      expect(result.reason).toContain('need 40 directional closes');
    });

    it('allows directional when edge is proven and no breaker is active', () => {
      const result = resolveTradingPermissions({
        cfg: { forceArbOnly: false, arbOnlyUntilEdge: true, mode: 'paper' },
        edgeState: { edgeOk: true, sampleOk: true, reason: 'edge ok' },
        governorDecision: { regime: 'trend-ride', drawdownBreakerActive: false },
      });

      expect(result.arbOnly).toBe(false);
      expect(result.directionalAllowed).toBe(true);
      expect(result.tier).toBe('automation');
    });
  });

  describe('validateConfig() (Item 5)', () => {
    it('prevents invalid mute-all state (forceArbOnly true + clobArbEnabled false)', () => {
      const invalid = { forceArbOnly: true, clobArbEnabled: false };
      const validated = validateConfig(invalid);
      expect(validated.clobArbEnabled).toBe(true);
    });

    it('clamps entryWindowFrac within valid range (0.1 to 1.0)', () => {
      expect(validateConfig({ entryWindowFrac: 1.5 }).entryWindowFrac).toBe(1.0);
      expect(validateConfig({ entryWindowFrac: -0.2 }).entryWindowFrac).toBe(0.1);
    });
  });
});
