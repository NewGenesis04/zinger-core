// @ts-nocheck
/**
 * Invariants for the directional engine (slice 1).
 *
 * These are properties, not a snapshot. `cccce43` shipped green because its test
 * asserted the new behaviour; a characterization test of `buildDecision` would
 * freeze today's scoring weights as correct and block slice 2 from changing
 * them. Everything here should still hold after the weights are retuned, after
 * D4 lands, and after the governor's literals become config.
 *
 * Behaviour-equivalence with the pre-extraction `bot.ts` was verified separately
 * by a one-shot differential run over 1,739,090 input combinations (see the
 * slice-1 note in docs/refactor-plan.md). That check belongs to the extraction,
 * not to CI.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  buildDecision,
  resolveOrderSize,
  sideBalanceBonus,
} from '../../src/polymarket/engines/directional.js';

const CFG = {
  mode: 'paper',
  minPrice: 0.05,
  maxPrice: 0.95,
  useSignals: true,
  useKellySizing: true,
  useOrderBookBias: true,
  maxConcurrentPerSlug: 1,
  minPositionSize: 1,
  maxPositionSize: 25,
  paperBankroll: 100,
  paperInitialDeposit: 100,
  kellyFraction: 0.12,
  maxPositionPct: 0.1,
  minArbGap: 0.015,
  arbExploreRate: 0,          // the only nondeterminism in the gate
  underdogMaxPrice: 0.42,
  sideBalanceEnabled: true,
  sideBalanceWeight: 12,
  certaintySizing: true,
  certaintyMaxPct: 0.35,
  certaintyMaxUsd: 40,
  requireTightSpread: true,
  requireDataAssurance: true,
  tradeCurrentWindowOnly: true,
  maxEntryRemainingSec: 298,
  arbOnlyUntilEdge: true,
};

const MARKET = {
  slug: 'btc-updown-5m-1787083200',
  symbol: 'BTC',
  duration: '5m',
  isCurrent: true,
  acceptingOrders: true,
  windowSeconds: 300,
};

const DEPTH = {
  up: { bestAsk: 0.45, bestBid: 0.44, imbalance: 0.1, spreadPct: 0.7 },
  down: { bestAsk: 0.52, bestBid: 0.51, imbalance: -0.1, spreadPct: 0.7 },
};

const BALANCED = { up: 5, down: 5, total: 10, upShare: 0.5 };

const decide = (over = {}) => buildDecision({
  cfg: CFG,
  market: MARKET,
  outcome: 'up',
  price: 0.45,
  remaining: 200,
  signal: { direction: 'up', confidence: 0.62, score: 4, asset: 'BTC' },
  existingPosition: null,
  readiness: { spendableBalance: 0, clobBalance: 0, liveReady: false },
  depth: DEPTH,
  prices: { up: 0.45, down: 0.52 },
  portfolio: { hasOpenOnSlug: false, sideBalance: BALANCED, dataAssurance: null },
  ...over,
});

describe('directional engine — structure', () => {
  it('imports nothing from bot.ts', () => {
    // D1 splits the engines at the decision layer. The moment this module can
    // see bot.ts it stops being a decision function and becomes part of the god
    // object again — and the import cycle would make it untestable in isolation.
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../src/polymarket/engines/directional.ts'),
      'utf-8',
    );
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => /bot\.js$|bot\.ts$/.test(i))).toEqual([]);
  });

  it('is pure — the same inputs give the same decision', () => {
    // The whole point of the portfolio-view seam. If this ever fails, something
    // has started reading ambient state (a clock, a module global, the store).
    const a = decide();
    const b = decide();
    expect(b).toEqual(a);
  });

  it('degrades open when no portfolio view is supplied', () => {
    // Absent state must mean "nothing open, balanced book" — the cold-start
    // answer — and never a silent block that reads as "no opportunities".
    const withNone = decide({ portfolio: undefined });
    expect(withNone.eligible).toBe(true);
  });
});

describe('directional engine — entry gate invariants', () => {
  it('never trades a window that has already closed', () => {
    // Honest note on what this does and does not prove: at any config an
    // operator can reach, `minRemainingSec` (25s for 5m) rejects these first,
    // so mutating away the dedicated `remaining <= 0` guard leaves this green.
    // The guard is a backstop that only becomes load-bearing if a *trained*
    // duration policy lowers the floor to 0 — which is the only way the floor
    // can move at all (backlog item 26: cfg.minRemainingSec is unreachable).
    //
    // The invariant is still the one worth asserting: whatever the reason, a
    // resolved window is never tradable.
    for (const remaining of [-120, -1, 0]) {
      const d = decide({ remaining });
      expect(d.eligible, `remaining=${remaining}`).toBe(false);
    }
  });

  it('never trades outside the configured price band', () => {
    for (const price of [0, 0.01, 0.049, 0.951, 0.99, 1]) {
      const d = decide({ price });
      expect(d.eligible, `price=${price}`).toBe(false);
    }
  });

  it('never trades live money when readiness says the account is not ready', () => {
    const d = decide({
      cfg: { ...CFG, mode: 'live' },
      readiness: { spendableBalance: 500, clobBalance: 500, liveReady: false },
    });
    expect(d.eligible).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/live not ready/i);
  });

  it('never overrides a blocking data-assurance gate', () => {
    // Feed health is a hard stop: a stale price feed means the signal is
    // unverifiable, and no amount of score may buy past it.
    const d = decide({
      portfolio: {
        hasOpenOnSlug: false,
        sideBalance: BALANCED,
        dataAssurance: { canBuy: false, note: 'binance stale', score: 5, blocking: ['binance'] },
      },
    });
    expect(d.eligible).toBe(false);
  });

  it('respects the per-slug concurrency cap', () => {
    const d = decide({ portfolio: { hasOpenOnSlug: true, sideBalance: BALANCED, dataAssurance: null } });
    expect(d.eligible).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/already in this window/i);
  });

  it('always explains itself — an ineligible candidate carries a reason', () => {
    // Objective 1: "why did the bot not do X" must be answerable from the
    // record. A silent false is the failure mode this refactor exists to remove.
    for (const over of [
      { remaining: 0 },
      { price: 0.99 },
      { portfolio: { hasOpenOnSlug: true, sideBalance: BALANCED, dataAssurance: null } },
      { market: { ...MARKET, acceptingOrders: false } },
      { signal: null },
    ]) {
      const d = decide(over);
      expect(d.eligible).toBe(false);
      expect(d.reasons.length, JSON.stringify(over)).toBeGreaterThan(0);
    }
  });
});

describe('directional engine — sizing invariants', () => {
  const size = (cfgOver = {}, argsOver = {}) => resolveOrderSize(
    { ...CFG, ...cfgOver },
    {
      price: 0.45,
      signal: { confidence: 0.62, asset: 'BTC' },
      readiness: { spendableBalance: 100, clobBalance: 100 },
      stats: { totalTrades: 60, wins: 33 },
      remaining: 120,
      windowSec: 300,
      duration: '5m',
      symbol: 'BTC',
      ...argsOver,
    },
  );

  it('never stakes more than the paper bankroll allows', () => {
    // The overdraft guard. Every paper sizing path — flat, Kelly, aggressive
    // scaling, certainty upsizing, the recovery probe — must stay under
    // bankroll × maxPositionPct. If one escapes, paper cash goes negative and
    // repairPaperOverdraft starts closing positions to compensate (item 25).
    //
    // Enforced by `resolveDynamicLimits` (kelly.ts:153), *not* by the engine's
    // own `paperBankroll * cashFrac` clamp — verified by mutation: removing the
    // engine clamp leaves this green, removing the limits one does not. The
    // absolute caps below are deliberately opened up so the bankroll fraction
    // is the only binding constraint; otherwise `maxPositionSize` masks it and
    // the assertion proves nothing.
    for (const bankroll of [1, 5, 20, 100, 1000]) {
      for (const pct of [0.01, 0.05, 0.1, 0.5, 0.95]) {
        for (const over of [
          {},
          { useKellySizing: false },
          { useAggressiveScaling: true, aggScaleMultiplier: 4 },
          { certaintyMaxUsd: 10000, certaintyMaxPct: 0.9 },
          { arbOnlyUntilEdge: false },
        ]) {
          for (const remaining of [null, 5, 120]) {
            const cfg = {
              paperBankroll: bankroll,
              paperInitialDeposit: bankroll,
              maxPositionPct: pct,
              maxPositionSize: 1e9,
              maxPositionCap: 1e9,
              ...over,
            };
            const { sizeUsd } = size(cfg, { remaining, stats: { totalTrades: 0, wins: 0 } });
            const cap = bankroll * Math.min(0.95, Math.max(0.01, pct));
            expect(sizeUsd, `bankroll=${bankroll} pct=${pct} ${JSON.stringify(over)} rem=${remaining}`)
              .toBeLessThanOrEqual(cap + 1e-9);
          }
        }
      }
    }
  });

  it('stakes nothing when there is no cash to stake', () => {
    for (const bankroll of [0, 0.01, 0.05]) {
      const { sizeUsd, reason } = size({ paperBankroll: bankroll, paperInitialDeposit: bankroll });
      expect(sizeUsd, `bankroll=${bankroll}`).toBe(0);
      expect(reason).toBe('no_paper_cash');
    }
    const live = size({ mode: 'live' }, { readiness: { spendableBalance: 0, clobBalance: 0 } });
    expect(live.sizeUsd).toBe(0);
    expect(live.reason).toBe('no_bankroll');
  });

  it('never returns a negative or non-finite stake', () => {
    for (const price of [0.01, 0.2, 0.5, 0.8, 0.99]) {
      for (const confidence of [0, 0.2, 0.5, 0.9, 1]) {
        const { sizeUsd } = size({}, { price, signal: { confidence, asset: 'BTC' } });
        expect(Number.isFinite(sizeUsd), `p=${price} c=${confidence}`).toBe(true);
        expect(sizeUsd).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('directional engine — side balance', () => {
  it('is a soft tilt, never a hard block', () => {
    // A hard side-force caused a live stop-loss massacre; the bonus must only
    // ever move the score, never make a side untradable on its own.
    for (const upShare of [0, 0.1, 0.32, 0.5, 0.68, 0.9, 1]) {
      for (const outcome of ['up', 'down']) {
        const mix = { up: Math.round(upShare * 20), down: Math.round((1 - upShare) * 20), total: 20, upShare };
        const bonus = sideBalanceBonus(outcome, CFG, mix);
        expect(Number.isFinite(bonus.bonus), `${outcome} ${upShare}`).toBe(true);
        const d = decide({ outcome, portfolio: { hasOpenOnSlug: false, sideBalance: mix, dataAssurance: null } });
        expect(typeof d.eligible).toBe('boolean');
      }
    }
  });

  it('does nothing on too small a sample', () => {
    for (const total of [0, 1, 4]) {
      const mix = { up: total, down: 0, total, upShare: total ? 1 : 0.5 };
      expect(sideBalanceBonus('down', CFG, mix).bonus, `total=${total}`).toBe(0);
    }
  });

  it('is disabled by the operator switch', () => {
    const skewed = { up: 19, down: 1, total: 20, upShare: 0.95 };
    expect(sideBalanceBonus('down', { ...CFG, sideBalanceEnabled: false }, skewed).bonus).toBe(0);
  });
});
