import { describe, expect, it } from 'vitest';
import {
  isHedgeIntact,
  resolveMarketWinner,
  resolveSettlementPrice,
  positionWindowEndMs,
} from '../../src/polymarket/positions/settle.js';

describe('isHedgeIntact', () => {
  const upLeg = { id: 'p-1', packageId: 'pkg-1', outcome: 'up', isArbLeg: true, closed: false };
  const downLeg = { id: 'p-2', packageId: 'pkg-1', outcome: 'down', isArbLeg: true, closed: false };

  it('returns true when both legs of the package are open and present', () => {
    expect(isHedgeIntact(upLeg, [upLeg, downLeg])).toBe(true);
    expect(isHedgeIntact(downLeg, [upLeg, downLeg])).toBe(true);
  });

  it('returns false when the sibling leg is closed', () => {
    const closedDown = { ...downLeg, closed: true };
    expect(isHedgeIntact(upLeg, [upLeg, closedDown])).toBe(false);
  });

  it('returns false when only the single leg exists (naked leg)', () => {
    expect(isHedgeIntact(upLeg, [upLeg])).toBe(false);
    expect(isHedgeIntact(upLeg, [])).toBe(false);
  });

  it('returns false for directional positions without a packageId', () => {
    const directionalPos = { id: 'p-3', outcome: 'up', isArbLeg: false, closed: false };
    expect(isHedgeIntact(directionalPos, [directionalPos])).toBe(false);
  });
});

describe('resolveMarketWinner', () => {
  it('resolves from explicit market winner or resolvedOutcome fields', () => {
    expect(resolveMarketWinner({ market: { winner: 'Up' } })).toBe('up');
    expect(resolveMarketWinner({ market: { resolvedOutcome: 'DOWN' } })).toBe('down');
  });

  it('resolves from PTB oracle prices (closePrice vs openPrice)', () => {
    expect(
      resolveMarketWinner({ ptb: { openPrice: 65000, closePrice: 65100 } }),
    ).toBe('up');
    expect(
      resolveMarketWinner({ ptb: { openPrice: 65000, closePrice: 64900 } }),
    ).toBe('down');
    // Exact tie resolves to down
    expect(
      resolveMarketWinner({ ptb: { openPrice: 65000, closePrice: 65000 } }),
    ).toBe('down');
  });

  it('resolves from finalPrice vs market priceToBeat', () => {
    expect(
      resolveMarketWinner({ market: { priceToBeat: 3000 }, finalPrice: 3050 }),
    ).toBe('up');
    expect(
      resolveMarketWinner({ market: { priceToBeat: 3000 }, finalPrice: 2950 }),
    ).toBe('down');
  });

  it('returns null when outcome is undetermined', () => {
    expect(resolveMarketWinner({})).toBeNull();
    expect(resolveMarketWinner({ market: { priceToBeat: 0 } })).toBeNull();
  });
});

describe('resolveSettlementPrice (Item 8: naked leg vs intact pair)', () => {
  const upLeg = {
    id: 'p-1',
    packageId: 'pkg-1',
    outcome: 'up',
    isArbLeg: true,
    entryPrice: 0.23,
    currentPrice: 0.25,
    closed: false,
  };
  const downLeg = {
    id: 'p-2',
    packageId: 'pkg-1',
    outcome: 'down',
    isArbLeg: true,
    entryPrice: 0.74,
    currentPrice: 0.72,
    closed: false,
  };

  it('settles intact pairs at $0.50 each (guaranteed $1.00 full set payout)', () => {
    const resUp = resolveSettlementPrice({
      pos: upLeg,
      openPositions: [upLeg, downLeg],
      market: { winner: 'down' }, // even if market resolved down, pair redeems 0.50 each
    });
    expect(resUp.price).toBe(0.50);
    expect(resUp.isPairSettled).toBe(true);
    expect(resUp.reason).toBe('intact_arb_pair');

    const resDown = resolveSettlementPrice({
      pos: downLeg,
      openPositions: [upLeg, downLeg],
    });
    expect(resDown.price).toBe(0.50);
    expect(resDown.isPairSettled).toBe(true);
  });

  it('settles a naked UP leg at $1.00 when market won (UP)', () => {
    const res = resolveSettlementPrice({
      pos: upLeg,
      openPositions: [upLeg], // no sibling
      market: { winner: 'up' },
    });
    expect(res.price).toBe(1.00);
    expect(res.isPairSettled).toBe(false);
    expect(res.reason).toBe('naked_arb_won');
  });

  it('settles a naked UP leg at $0.00 when market lost (DOWN)', () => {
    const res = resolveSettlementPrice({
      pos: upLeg,
      openPositions: [upLeg], // no sibling
      market: { winner: 'down' },
    });
    expect(res.price).toBe(0.00);
    expect(res.isPairSettled).toBe(false);
    expect(res.reason).toBe('naked_arb_lost');
  });

  it('settles a naked DOWN leg at $1.00 when market won (DOWN)', () => {
    const res = resolveSettlementPrice({
      pos: downLeg,
      openPositions: [downLeg],
      market: { winner: 'down' },
    });
    expect(res.price).toBe(1.00);
    expect(res.isPairSettled).toBe(false);
    expect(res.reason).toBe('naked_arb_won');
  });

  it('settles a naked DOWN leg at $0.00 when market lost (UP)', () => {
    const res = resolveSettlementPrice({
      pos: downLeg,
      openPositions: [downLeg],
      market: { winner: 'up' },
    });
    expect(res.price).toBe(0.00);
    expect(res.isPairSettled).toBe(false);
    expect(res.reason).toBe('naked_arb_lost');
  });

  it('settles directional positions against market outcome ($1.00 win, $0.00 loss)', () => {
    const dirPos = { id: 'p-dir', outcome: 'up', entryPrice: 0.45, isArbLeg: false, closed: false };
    const winRes = resolveSettlementPrice({
      pos: dirPos,
      openPositions: [dirPos],
      ptb: { openPrice: 50000, closePrice: 50200 },
    });
    expect(winRes.price).toBe(1.00);
    expect(winRes.reason).toBe('directional_won');

    const lossRes = resolveSettlementPrice({
      pos: dirPos,
      openPositions: [dirPos],
      ptb: { openPrice: 50000, closePrice: 49800 },
    });
    expect(lossRes.price).toBe(0.00);
    expect(lossRes.reason).toBe('directional_lost');
  });

  it('falls back to current mark price when outcome is unresolved (never fabricated 0.50)', () => {
    const res = resolveSettlementPrice({
      pos: upLeg,
      openPositions: [upLeg],
      market: null, // no winner info
    });
    expect(res.price).toBe(0.25); // currentPrice
    expect(res.isPairSettled).toBe(false);
    expect(res.reason).toBe('unresolved_market_mark');
  });
});

describe('positionWindowEndMs (Item 11: duration-aware window ends)', () => {
  it('correctly calculates 5m window end (300s)', () => {
    const end = positionWindowEndMs({ slug: 'btc-updown-5m-1787000000' });
    expect(end).toBe((1787000000 + 300) * 1000);
  });

  it('correctly calculates 15m window end (900s, not 300s)', () => {
    const end = positionWindowEndMs({ slug: 'eth-updown-15m-1787000000' });
    expect(end).toBe((1787000000 + 900) * 1000);
  });

  it('correctly calculates 1h window end (3600s, not 300s)', () => {
    const end = positionWindowEndMs({ slug: 'btc-updown-1h-1787000000' });
    expect(end).toBe((1787000000 + 3600) * 1000);
  });

  it('falls back to windowSeconds property if slug is custom', () => {
    const end = positionWindowEndMs({ slug: 'custom-series-1787000000', windowSeconds: 1800 });
    expect(end).toBe((1787000000 + 1800) * 1000);
  });
});
