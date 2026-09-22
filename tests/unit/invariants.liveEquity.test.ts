// @ts-nocheck
/**
 * INVARIANTS: live equity is cash plus what the wallet holds, and nothing the
 * bot merely remembers (item 104, decision D-C).
 *
 * After `pkg-eth-mu9ef745` was auto-redeemed, Polymarket correctly reported no
 * inventory for it (domain facts §10c). The bot read that as "no answer", fell
 * back to its own stale marks ($1.53 + $3.10), and reported $288.60 against
 * real cash of $283.96. The governor ratcheted its drawdown peak off the
 * phantom and saved it to disk.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { liveEquity } from '../../src/polymarket/ledger/equity.js';

const tracked = new Set(['up-token', 'down-token']);

describe('INVARIANT: an empty wallet answer means nothing is held', () => {
  it('reports the incident account at its real cash', () => {
    const eq = liveEquity({ cash: 283.96, walletRows: [], trackedTokenIds: tracked });
    expect(eq.equity).toBe(283.96);
    expect(eq).toMatchObject({ stale: false, holdingsKnown: true, openMarkValue: 0 });
  });

  it('never adds value for a token the wallet did not list, whatever the bot remembers', () => {
    // The bot's open positions are not an input at all. That is the property.
    for (const cash of [0, 1.5, 283.96]) {
      expect(liveEquity({ cash, walletRows: [], trackedTokenIds: tracked }).equity).toBe(cash);
    }
  });
});

describe('INVARIANT: every wallet row counts at the wallet\'s own value', () => {
  it('counts unredeemed winners and untracked holdings, and losers at $0', () => {
    const rows = [
      { asset: 'up-token', currentValue: 0, cashPnl: -1.6, redeemable: true },       // resolved loser
      { asset: 'down-token', currentValue: 4.567163, cashPnl: 1.5, redeemable: true }, // unredeemed winner
      { asset: 'legacy-aug27', currentValue: 2.1, cashPnl: -0.4 },                     // nobody's record
    ];
    const eq = liveEquity({ cash: 279.39, walletRows: rows, trackedTokenIds: tracked });
    expect(eq.openMarkValue).toBeCloseTo(6.67, 2);
    expect(eq.equity).toBeCloseTo(286.06, 2);
    expect(eq.untrackedValue).toBe(2.1);
    expect(eq.walletRows).toBe(3);
  });

  it('ignores values that are not a non-negative number', () => {
    const rows = [{ currentValue: 'n/a' }, { currentValue: -3 }, { currentValue: null }, { currentValue: 1 }];
    expect(liveEquity({ cash: 10, walletRows: rows }).equity).toBe(11);
  });
});

describe('INVARIANT: no wallet answer reports a whole earlier snapshot, flagged', () => {
  it('returns the last good figure, not today\'s cash plus old holdings', () => {
    const lastGood = liveEquity({ cash: 279.39, walletRows: [{ currentValue: 4.57 }], now: 1_000 });
    // Redemption lands; cash rises. Adding the old holdings to it would count
    // the $4.57 twice.
    const eq = liveEquity({ cash: 283.96, walletRows: null, lastGood });
    expect(eq.equity).toBe(283.96);
    expect(eq).toMatchObject({ stale: true, asOf: 1_000, holdingsKnown: true });
  });

  it('falls back to cash alone, and says holdings are unknown, with no snapshot yet', () => {
    const eq = liveEquity({ cash: 283.96, walletRows: null });
    expect(eq).toMatchObject({ equity: 283.96, stale: true, holdingsKnown: false, asOf: null });
  });
});

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Throws unless buildPortfolio takes live equity from the wallet, with no marks fallback. */
function checkPortfolioWiring(bot) {
  const start = bot.indexOf('function buildPortfolio(readiness, mode) {');
  if (start < 0) throw new Error('buildPortfolio not found');
  const body = bot.slice(start, bot.indexOf('\nfunction summarizeMarketDecision', start));
  if (!/liveEquity\(\{[\s\S]*?walletRows: readiness\?\.walletPositions \?\? null/.test(body)) {
    throw new Error('live equity is not computed from readiness.walletPositions');
  }
  if (/\.reduce\([\s\S]{0,120}?markValue/.test(body.slice(body.indexOf('const liveBotOpen')))) {
    throw new Error('live equity still falls back to the bot\'s own marks');
  }
}

/** Throws unless a stale equity can neither raise the peak nor move the breaker. */
function checkGovernorGuard(gov) {
  if (!/const equityTrusted = portfolio\.equityStale !== true;/.test(gov)) throw new Error('no staleness check');
  if (!/if \(equityTrusted && equity > 0 &&/.test(gov)) throw new Error('stale equity can raise the peak');
  if (!/const dd = !equityTrusted \? null :/.test(gov)) throw new Error('stale equity yields a drawdown');
  const unguarded = gov.match(/if \((?!dd != null)[^)]*\bdd\b[^)]*breakerPct/g);
  if (unguarded) throw new Error(`breaker condition without the staleness guard: ${unguarded[0]}`);
}

describe('INVARIANT: the portfolio and the governor use the wallet figure correctly', () => {
  const bot = src('../../src/polymarket/bot.ts');
  const gov = src('../../src/ai/governor.ts');

  it('holds for the real sources', () => {
    expect(() => checkPortfolioWiring(bot)).not.toThrow();
    expect(() => checkGovernorGuard(gov)).not.toThrow();
  });

  it('fails if the marks fallback comes back', () => {
    const broken = bot.replace(
      '  const openMarkValue = eq.openMarkValue;',
      '  const openMarkValue = liveBotOpen.reduce((sum, p) => sum + Number(p.markValue || 0), 0);',
    );
    expect(broken).not.toBe(bot);
    expect(() => checkPortfolioWiring(broken)).toThrow(/own marks/);
  });

  it('fails if a stale figure can release the breaker', () => {
    const broken = gov.replace(
      'if (dd != null && _state.breakerActiveByMode?.[mode] && dd < breakerPct * 0.5)',
      'if (_state.breakerActiveByMode?.[mode] && dd < breakerPct * 0.5)',
    );
    expect(broken).not.toBe(gov);
    expect(() => checkGovernorGuard(broken)).toThrow(/without the staleness guard/);
  });

  it('fails if a stale figure can raise the peak', () => {
    const broken = gov.replace('if (equityTrusted && equity > 0 &&', 'if (equity > 0 &&');
    expect(() => checkGovernorGuard(broken)).toThrow(/raise the peak/);
  });
});
