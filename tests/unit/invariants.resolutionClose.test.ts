// @ts-nocheck
/**
 * INVARIANTS: a live position whose market has resolved is closed at its payout,
 * by a pass indexed on positions rather than on scanned markets (item 103).
 *
 * `pkg-eth-mu9ef745` (slug `eth-updown-5m-1789883400`) resolved DOWN at 05:55:54
 * and was redeemed at 05:56:06. The bot's package stayed LOCKED for nine hours,
 * held the only arb slot, and reported a profit. Every path that could close
 * it was keyed on the market being scanned, and that market had left the scan.
 *
 * The fixtures are the real records: Gamma's resolved market (domain facts
 * §10a) and the fills from `/activity` (§10e). The realized figure is checked to
 * the micro-dollar against the account's cash move.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  payoutVectorFromGamma,
  resolutionPollDue,
  resolutionOverdue,
  resolvedExit,
  FIRST_POLL_MS,
  SECOND_POLL_MS,
  OVERDUE_MS,
} from '../../src/polymarket/positions/resolution.js';
import { fetchResolvedMarket } from '../../src/polymarket/markets.js';
import { syncPackageSettlements, getArbPackageMetrics } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages, loadPackages } from '../../src/polymarket/arbPersistence.js';
import { queryEvents } from '../../src/polymarket/telemetry/events.js';

const UP = '4358423192852515013701738197390464484651307449418190740448803850674061229771';
const DOWN = '96154369864317434635402224600454667570692140241787438521444451063067899726389';

/** Gamma, `GET /markets?slug=eth-updown-5m-1789883400&closed=true`, 2026-09-22. */
const gammaResolved = () => ({
  slug: 'eth-updown-5m-1789883400',
  closed: true,
  umaResolutionStatus: 'resolved',
  outcomes: '["Up", "Down"]',
  outcomePrices: '["0", "1"]',
  clobTokenIds: `["${UP}", "${DOWN}"]`,
  endDate: '2026-09-20T05:55:00Z',
});

const fills = {
  up: { shares: 4.5, costUsd: 1.53, avgPrice: 0.34, feeUsd: 0.07068, priceSource: 'venue_making' },
  down: { shares: 4.567163, costUsd: 3.06, avgPrice: 0.67, feeUsd: 0.07068, priceSource: 'venue_making' },
};

describe('INVARIANT: a payout is read from a resolution, never inferred', () => {
  it('maps the real resolved record by token id', () => {
    expect(payoutVectorFromGamma(gammaResolved())).toEqual({ [UP]: 0, [DOWN]: 1 });
  });

  it('pairs by position in clobTokenIds, not by outcome label', () => {
    const row = { ...gammaResolved(), outcomes: '["Down", "Up"]' };
    expect(payoutVectorFromGamma(row)).toEqual({ [UP]: 0, [DOWN]: 1 });
  });

  it('accepts a 50/50 resolution (§2)', () => {
    expect(payoutVectorFromGamma({ ...gammaResolved(), outcomePrices: '["0.5", "0.5"]' }))
      .toEqual({ [UP]: 0.5, [DOWN]: 0.5 });
  });

  it('refuses everything that is not a payout vector', () => {
    const cases = {
      'open market': { closed: false },
      'closed, not resolved': { umaResolutionStatus: 'proposed' },
      'resolution status absent': { umaResolutionStatus: undefined },
      'live prices': { outcomePrices: '["0.99", "0.01"]' },
      'near-certain price': { outcomePrices: '["0.999", "0.001"]' },
      'sums above 1': { outcomePrices: '["1", "1"]' },
      'sums below 1': { outcomePrices: '["0", "0"]' },
      'blank price': { outcomePrices: '["", "1"]' },
      'length mismatch': { outcomePrices: '["0", "1", "0"]' },
      'unparseable': { outcomePrices: 'nope' },
      'missing tokens': { clobTokenIds: undefined },
    };
    for (const [name, patch] of Object.entries(cases)) {
      expect(payoutVectorFromGamma({ ...gammaResolved(), ...patch }), name).toBeNull();
    }
    expect(payoutVectorFromGamma(null)).toBeNull();
  });
});

describe('INVARIANT: Gamma is asked on the measured schedule, and never before resolution can land', () => {
  const end = 1_000_000_000_000;
  const due = (since, lastSince = null) => resolutionPollDue({
    windowEndMs: end, now: end + since, lastPollAt: lastSince == null ? null : end + lastSince,
  });

  it('does not poll before the earliest observed resolution (§6: 52s)', () => {
    expect(due(0)).toBe(false);
    expect(due(FIRST_POLL_MS - 1)).toBe(false);
    expect(due(FIRST_POLL_MS)).toBe(true);
  });

  it('polls once per mode, then every minute, then every five', () => {
    expect(due(70_000, 55_000)).toBe(false);          // first mode already asked
    expect(due(SECOND_POLL_MS, 55_000)).toBe(true);    // second mode
    expect(due(120_000, 95_000)).toBe(false);
    expect(due(155_000, 95_000)).toBe(true);           // +60s
    expect(due(OVERDUE_MS + 60_000, OVERDUE_MS)).toBe(false);
    expect(due(OVERDUE_MS + 300_000, OVERDUE_MS)).toBe(true);
  });

  it('calls a resolution overdue at fifteen minutes', () => {
    expect(resolutionOverdue({ windowEndMs: end, now: end + OVERDUE_MS - 1 })).toBe(false);
    expect(resolutionOverdue({ windowEndMs: end, now: end + OVERDUE_MS })).toBe(true);
  });

  it('asks for the resolved record, and treats any failure as "not yet"', async () => {
    let url = '';
    const ok = async (u) => { url = u; return { ok: true, json: async () => [gammaResolved()] }; };
    expect(await fetchResolvedMarket('eth-updown-5m-1789883400', { fetchImpl: ok })).toMatchObject({ closed: true });
    expect(url).toContain('closed=true');
    expect(url).toContain('slug=eth-updown-5m-1789883400');
    expect(await fetchResolvedMarket('x', { fetchImpl: async () => ({ ok: false }) })).toBeNull();
    expect(await fetchResolvedMarket('x', { fetchImpl: async () => { throw new Error('down'); } })).toBeNull();
    // A row for some other slug is not this market's resolution.
    expect(await fetchResolvedMarket('x', { fetchImpl: ok })).toBeNull();
  });
});

describe('INVARIANT: a resolved close realizes what the account\'s cash says', () => {
  it('reproduces pkg-eth-mu9ef745 to the micro-dollar', () => {
    const up = resolvedExit({ shares: 4.5, payout: 0, fill: fills.up });
    const down = resolvedExit({ shares: 4.567163, payout: 1, fill: fills.down });
    expect(up.pnlExactUsd).toBeCloseTo(-1.60068, 6);
    expect(down.pnlExactUsd).toBeCloseTo(1.436483, 6);
    // $284.12 → $283.96 on the account: −0.164197 (domain facts §10e).
    expect(up.pnlExactUsd + down.pnlExactUsd).toBeCloseTo(-0.164197, 6);
    expect(up.feeKnown && down.feeKnown).toBe(true);
    expect(down.proceedsUsd).toBeCloseTo(4.567163, 6);
  });

  it('pro-rates cost and fee when some shares were already sold', () => {
    const v = resolvedExit({ shares: 2.25, payout: 1, fill: fills.up });
    expect(v.costUsd).toBeCloseTo(0.765, 6);
    expect(v.feeUsd).toBeCloseTo(0.03534, 6);
  });

  it('falls back to cost basis, and says the fee is unknown, without a fill', () => {
    const v = resolvedExit({ shares: 4.5, payout: 1, fill: null, costBasis: 1.53 });
    expect(v).toMatchObject({ costSource: 'cost_basis', feeKnown: false, feeUsd: 0 });
    expect(v.pnl).toBe(2.97);
  });
});

describe('INVARIANT: two resolved legs settle the package, at the realized figure', () => {
  beforeEach(() => saveAllPackages([]));

  it('moves LOCKED → SETTLED and reports the loss, not the plan', () => {
    saveAllPackages([{
      packageId: 'pkg-eth-mu9ef745', mode: 'live', status: 'LOCKED', slug: 'eth-updown-5m-1789883400',
      lockedProfitUsd: 0.16, plannedProfitUsd: 0.16, legs: { up: {}, down: {} },
    }]);
    const trade = (outcome, fill, payout) => {
      const v = resolvedExit({ shares: fill.shares, payout, fill });
      return {
        id: `pos-${outcome}-resolved`, packageId: 'pkg-eth-mu9ef745', mode: 'live', outcome,
        closed: true, exitReason: 'redeem', exitPrice: payout, pnl: v.pnl, pnlExactUsd: v.pnlExactUsd,
      };
    };
    const trades = [trade('up', fills.up, 0), trade('down', fills.down, 1)];
    expect(syncPackageSettlements(trades, 'live')).toBe(true);
    const settled = loadPackages()[0];
    expect(settled.status).toBe('SETTLED');
    // Summed from the exact leg figures, then rounded once: −0.164197 → −0.16.
    expect(settled.realizedPnlUsd).toBe(-0.16);
    expect(settled.payout).toEqual({ up: 0, down: 1 });
    const ev = queryEvents({ type: 'package.settlement' }).filter((e) => e.data?.packageId === 'pkg-eth-mu9ef745').pop();
    expect(ev?.data).toMatchObject({ action: 'resolved', netPnl: -0.16, plannedProfitUsd: 0.16 });
    expect(ev?.data.netPnlExactUsd).toBeCloseTo(-0.164197, 6);
    // The figure is on the package, so it survives the trades leaving the capped log.
    expect(getArbPackageMetrics('live', []).netProfitUsd).toBe(-0.16);
    const m = getArbPackageMetrics('live', trades);
    // −1.60 + 1.44: per-leg cent rounding, within a cent of −0.164197.
    expect(m.netProfitUsd).toBe(-0.16);
  });
});

const botSrc = () => readFileSync(fileURLToPath(new URL('../../src/polymarket/bot.ts', import.meta.url)), 'utf8');
const resolutionSrc = () => readFileSync(fileURLToPath(new URL('../../src/polymarket/positions/resolution.ts', import.meta.url)), 'utf8');

function bodyOf(src, header, nextHeader) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error(`${header} not found`);
  const end = src.indexOf(nextHeader, start + header.length);
  if (end < 0) throw new Error(`${header} not delimited`);
  return src.slice(start, end);
}

/** Throws unless the closer is wired into the scan and can never trade or move cash. */
function checkCloserWiring(src) {
  const scan = bodyOf(src, 'export async function scan()', '\nasync function fetchSpotTicker');
  const call = scan.indexOf("closeResolvedPositions('scan')");
  if (call < 0) throw new Error('scan() never runs the resolution closer');
  const house = scan.indexOf("await arbHousekeeping('scan')");
  if (house < 0 || call > house) throw new Error('the closer must run before package housekeeping');
  const closer = bodyOf(src, 'async function closeResolvedPositions(', '\nasync function arbHousekeeping(');
  for (const forbidden of ['placeMarketSell', 'placeOrder', 'placeMarketBuy', 'executeSell', 'applyLiveCashDelta', 'adjustPaperCash', 'market.slug']) {
    if (closer.includes(forbidden)) throw new Error(`the closer must not use ${forbidden}`);
  }
  if (!/for \(const pos of botState\.positions\)/.test(closer)) {
    throw new Error('the closer must walk the positions, not the scanned markets');
  }
}

describe('INVARIANT: the closer runs every pass, walks positions, and never trades', () => {
  it('holds for the real source', () => {
    expect(() => checkCloserWiring(botSrc())).not.toThrow();
  });

  it('fails when the scan no longer calls it', () => {
    const broken = botSrc().replace("void closeResolvedPositions('scan').catch(() => {});", '');
    expect(() => checkCloserWiring(broken)).toThrow(/never runs/);
  });

  it('fails if the closer ever sells', () => {
    for (const call of ['placeMarketSell({});', 'executeSell(pos);', 'applyLiveCashDelta(1);']) {
      const broken = botSrc().replace(
        'function closeAtResolution(pos, payout) {',
        `function closeAtResolution(pos, payout) {\n  ${call}`,
      );
      expect(broken).not.toBe(botSrc());
      expect(() => checkCloserWiring(broken), call).toThrow(/must not use/);
    }
  });

  it('fails if the closer is keyed on the scanned market', () => {
    const broken = botSrc().replace(
      'for (const pos of botState.positions) {\n      if (pos.closed || pos.mode !== \'live\'',
      'for (const pos of botState.positions.filter((p) => p.slug === market.slug)) {\n      if (pos.closed || pos.mode !== \'live\'',
    );
    expect(broken).not.toBe(botSrc());
    expect(() => checkCloserWiring(broken)).toThrow();
  });

  it('keeps strategy out of the valuation module (D4)', () => {
    expect(resolutionSrc()).not.toMatch(/isArbLeg|packageId|clobArb/);
  });
});
