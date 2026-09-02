import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { readGtcFill, readSellFill } from '../../src/polymarket/trade.js';

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/**
 * INVARIANT: a recorded fill is a measurement, never an assumption.
 *
 * Three ways this system has booked a number nobody observed:
 *   - a live rollback recorded `exitPrice = entryPrice`      (backlog 44)
 *   - a resting GTC order recorded its requested size as held (the -$12.83 leg)
 *   - an unpriced sell recorded the floor it signed, not the fill
 *
 * All three produce a plausible figure that no receipt supports, so the tests
 * below assert on what the *receipt* says and on what happens when it says
 * nothing — the fallback must be labelled, never silently invented.
 */

describe('INVARIANT: a sell books the price the book paid', () => {
  // Live canary scale, confirmed on-chain: 26330000 == 26.33 shares.
  const receipt = (shares: number, price: number) => ({
    orderID: '0xabc',
    makingAmount: String(Math.round(shares * 1e6)),
    takingAmount: String(Math.round(shares * price * 1e6)),
  });

  it('derives the fill price from makingAmount / takingAmount', () => {
    const fill = readSellFill(receipt(26.33, 0.32), 26.33);
    expect(fill.fillPrice).toBeCloseTo(0.32, 4);
    expect(fill.filledShares).toBeCloseTo(26.33, 3);
    expect(fill.proceedsUsd).toBeCloseTo(8.43, 2);
    expect(fill.fillSource).toBe('receipt');
  });

  it('is scale-invariant, so it does not depend on backlog 33 being settled', () => {
    // The ratio cancels the unit. Raw and 1e6-scaled receipts must agree.
    const scaled = readSellFill({ makingAmount: '26330000', takingAmount: '8425600' }, 26.33);
    const raw = readSellFill({ makingAmount: '26.33', takingAmount: '8.4256' }, 26.33);
    expect(raw.fillPrice).toBeCloseTo(scaled.fillPrice!, 6);
  });

  it('reports no price rather than a wrong one when the receipt is silent', () => {
    for (const r of [{}, { makingAmount: '0', takingAmount: '0' }, null, { makingAmount: 'x' }]) {
      const fill = readSellFill(r, 26.33);
      expect(fill.fillPrice, `invented a price from ${JSON.stringify(r)}`).toBeNull();
      expect(fill.fillSource).toBe('unavailable');
    }
  });

  it('rejects an implausible price rather than booking it', () => {
    // taker > maker on a SELL implies more than $1.00 a share — not a market.
    expect(readSellFill({ makingAmount: '1000000', takingAmount: '9000000' }, 1).fillPrice).toBeNull();
  });

  it('withholds share counts when the scale cannot be resolved', () => {
    // Price is still safe (it is a ratio); absolute size is not, so it is null.
    const fill = readSellFill(receipt(26.33, 0.32), 999);
    expect(fill.fillPrice).toBeCloseTo(0.32, 4);
    expect(fill.filledShares).toBeNull();
    expect(fill.proceedsUsd).toBeNull();
  });

  it('the unwind books fillPrice, not the entry and not the floor', () => {
    // `placeMarketSell` returns `price` = the slippage FLOOR it signed. Booking
    // that would overstate the loss as badly as the entry price understated it.
    //
    // Comments are stripped first: the negative assertion below is about what
    // the code does, and prose that merely *names* `sellRes.price` (this file
    // included) is not a defect. A source-text check that cannot tell code from
    // commentary fails on documentation, which trains people to delete the
    // documentation.
    const src = repoFile('src/polymarket/arbEngine.ts');
    const fn = src.slice(src.indexOf('async function unwindLeg'));
    // End at the next top-level declaration. A fixed character budget silently
    // truncates the function as it grows, and an assertion on a truncated body
    // passes for the wrong reason.
    const end = fn.slice(10).search(/\n(?:export |async function |function |\/\*\*)/);
    const body = (end > 0 ? fn.slice(0, end + 10) : fn)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    // Guard the guard: the slice must reach the end of the function, or the
    // negative assertions below are vacuous.
    expect(body, 'slice truncated before the close block').toMatch(/pos\.exitReason = 'arb_rollback'/);
    expect(body).toMatch(/sellRes\??\.fillPrice/);
    expect(body, 'still copies the entry price into the exit').not.toMatch(/exitPrice = price\b/);
    expect(body, 'books the signed floor as the exit price').not.toMatch(/sellRes\??\.price\b/);
    // And the close must be priced off the realised figure, not the entry.
    expect(body).toMatch(/realisedExit != null \? realisedExit : price/);
  });
});

/**
 * INVARIANT: an orderID is not a fill.
 *
 * `assertOrderAccepted` passes on orderID presence alone, and the CLOB returns
 * one for a resting order too. That read cost the -$12.83 leg on 2026-08-28.
 * Arb entries moved to FOK, which cannot rest — directional entries keep GTC on
 * purpose, so the same response shape still reaches them.
 */
describe('INVARIANT: a resting GTC order is never counted as shares held', () => {
  it('flags an order that moved no collateral as resting', () => {
    for (const r of [
      { orderID: '0xabc', status: 'live', makingAmount: '0', takingAmount: '0' },
      { orderID: '0xabc', status: 'live', tradeIDs: [] },
      { orderID: '0xabc' },
    ]) {
      const fill = readGtcFill(r, 'buy', 26);
      expect(fill.resting, `not flagged resting: ${JSON.stringify(r)}`).toBe(true);
      expect(fill.filledShares).toBe(0);
    }
  });

  it('reads a matched buy from takingAmount, and a matched sell from makingAmount', () => {
    // BUY: maker = collateral out, taker = tokens in. SELL is the mirror.
    const buy = readGtcFill({ orderID: '0x1', makingAmount: '8580000', takingAmount: '26000000', tradeIDs: ['t1'] }, 'buy', 26);
    expect(buy.resting).toBe(false);
    expect(buy.filledShares).toBeCloseTo(26, 3);

    const sell = readGtcFill({ orderID: '0x1', makingAmount: '26000000', takingAmount: '8580000', tradeIDs: ['t1'] }, 'sell', 26);
    expect(sell.filledShares).toBeCloseTo(26, 3);
  });

  it('does not fall back to the requested size when a matched fill cannot be verified', () => {
    // The failure that started all this: assuming the ask equals the fill.
    const fill = readGtcFill({ orderID: '0x1', makingAmount: '1', takingAmount: '2', tradeIDs: ['t1'] }, 'buy', 26);
    expect(fill.resting).toBe(false);
    expect(fill.filledShares, 'assumed the requested size was filled').toBeNull();
    expect(fill.fillSource).toBe('matched-unverified');
  });

  it('does not key off status strings, whose vocabulary is still unverified', () => {
    // Research doc open question: the exact status values are unconfirmed. The
    // check must be quantitative, or it is another negRisk-shaped guess.
    const src = repoFile('src/polymarket/trade.ts');
    const fn = src.slice(src.indexOf('export function readGtcFill'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    expect(body).not.toMatch(/status\s*===\s*['"]/);
    expect(body).toMatch(/makingAmount/);
  });

  it('the live entry path refuses to open a position on a resting order', () => {
    const src = repoFile('src/polymarket/bot.ts');
    expect(src).toMatch(/if \(orderResult\.resting\)/);
    // …and cancels it, so an untracked bid cannot fill later unattended.
    const branch = src.slice(src.indexOf('if (orderResult.resting)'), src.indexOf('if (orderResult.resting)') + 900);
    expect(branch).toMatch(/cancelOrder\(/);
    expect(branch).toMatch(/pending\.status = 'failed'/);
    // cancelOrder must actually be imported — bot.ts is @ts-nocheck, so the
    // compiler will not catch a missing name here (backlog 32).
    expect(src).toMatch(/import \{[^}]*\bcancelOrder\b[^}]*\} from '\.\/trade\.js'/);
  });

  it('books what the book gave, not what was asked for', () => {
    const src = repoFile('src/polymarket/bot.ts');
    expect(src).toMatch(/pos\.shares = orderResult\.filledShares \?\? orderResult\.size/);
  });
});

/**
 * INVARIANT: a reset can hide a session, never the account's whole history.
 *
 * `resetLiveData` rebases `baselineUsd` to current cash, so `netPnl` reads
 * $0.00 afterwards. After the Aug-27 canary that erased a real -$10.13 from the
 * header. `lifetimeBaseline` is set once, on first observed cash, and is never
 * rebased — so it remains the honest figure.
 */
describe('INVARIANT: lifetime PnL survives a reset', () => {
  it('resetLiveData rebases the session baseline but never the lifetime one', () => {
    const src = repoFile('src/polymarket/bot.ts');
    const fn = src.slice(src.indexOf('export function resetLiveData'));
    const body = fn.slice(0, fn.indexOf('\nasync function ') + 1 || undefined).slice(0, 6000);
    expect(body).toMatch(/saveBaseline\(/);
    expect(body, 'a reset must not touch the lifetime baseline').not.toMatch(/lifetimeBaseline/);
  });

  it('lifetimeBaseline is written once and never overwritten', () => {
    const src = repoFile('src/polymarket/liveAccount.ts');
    expect(src).toMatch(/if \(store\.cash\.lifetimeBaseline == null && cash > 0\)/);
    // One writer, guarded. Any unguarded assignment would let it drift.
    expect(src.match(/store\.cash\.lifetimeBaseline\s*=(?!=)/g) ?? []).toHaveLength(1);
  });

  it('the portfolio reports lifetime PnL alongside the session figure', () => {
    const src = repoFile('src/polymarket/bot.ts');
    expect(src).toMatch(/lifetimeBaseline,\n\s*lifetimePnl,/);
    expect(src).toMatch(/lifetimePnl = lifetimeBaseline != null/);
  });

  it('the audit names a rebased drawdown as a drawdown, not a deposit', () => {
    // The old note said "rebase baseline after deposits" in both directions, so
    // a $10.13 loss was filed as a bookkeeping chore.
    const src = repoFile('src/polymarket/audit.ts');
    expect(src).toMatch(/BELOW lifetime/);
    expect(src).toMatch(/drawdown was rebased over/);
    expect(src).toMatch(/delta < 0/);
  });
});
