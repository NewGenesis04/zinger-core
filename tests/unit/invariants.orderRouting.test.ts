import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { placeMarketBuy, placeMarketSell, sellFloor } from '../../src/polymarket/trade.js';

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/**
 * INVARIANT: an arbitrage leg is fill-or-kill, never a resting limit order.
 *
 * The 2026-08-28 -$12.83 loss: leg 1 (UP @ $0.33) went out as a GTC limit, the
 * ask moved to $0.34, and the order rested on the book as a bid. `createAndPostOrder`
 * still returned an orderID, the engine read that as a fill, and hedged leg 2
 * against a position it did not hold. The DOWN leg expired worthless.
 *
 * Two things have to hold for that to stay impossible, and they live in
 * different modules:
 *   1. the arb path must call an order function that cannot rest  (bot.ts routing)
 *   2. that function must price its slippage bound                (trade.ts guard)
 *
 * (2) is checked by calling the real function. (1) cannot be: `bot.ts` runs
 * `installClobProxy()` through its import graph and no test here mocks a module,
 * so it is checked by reading the source. That style of check fails open — a
 * regex that matches nothing yields an empty string, and asserting on an empty
 * string passes silently forever. So the checkers below are pure functions,
 * exercised against deliberately broken sources as well as the real one. A
 * checker that cannot fail is worth nothing, and these prove they can.
 */

/** Throws unless the live entry path sends arb legs to FOK and everything else to GTC. */
function checkArbRouting(src: string): void {
  const branch = src.match(/plan\.isArbLeg\s*\?([\s\S]*?):\s*await\s+(\w+)\(/);
  if (!branch) throw new Error('live entry does not branch on plan.isArbLeg');

  const [, arbBranch, directionalFn] = branch;
  if (!arbBranch.includes('placeMarketBuy')) {
    throw new Error('arb branch does not call placeMarketBuy');
  }
  if (/\bplaceOrder\(/.test(arbBranch)) {
    throw new Error('arb branch calls placeOrder — a GTC limit can rest on the book');
  }
  if (directionalFn !== 'placeOrder') {
    throw new Error(`directional branch calls ${directionalFn}, not placeOrder`);
  }
  // Without this the maxPrice guard is satisfiable by any constant, and the
  // slippage bound stops tracking the price the edge was computed from.
  if (!/maxPrice:\s*entryPx\b/.test(arbBranch)) {
    throw new Error('arb branch does not pass entryPx as maxPrice');
  }
}

/** Throws unless placeMarketBuy is built on the market endpoint rather than the GTC one. */
function checkFokEndpoint(src: string): void {
  const start = src.indexOf('export async function placeMarketBuy');
  if (start < 0) throw new Error('placeMarketBuy not found');

  const body = src.slice(start).split(/\nexport /)[0];
  // Order matters: a swapped endpoint also fails the second check, but "you are
  // on the GTC path" names the actual regression where "market order missing"
  // only describes a symptom.
  if (/createAndPostOrder\b/.test(body)) {
    throw new Error('placeMarketBuy calls createAndPostOrder — that is the GTC path');
  }
  if (!body.includes('createAndPostMarketOrder')) {
    throw new Error('placeMarketBuy does not call createAndPostMarketOrder');
  }
}

describe('INVARIANT: the arb path routes to FOK, the directional path to GTC', () => {
  it('holds in the live entry path today', () => {
    expect(() => checkArbRouting(repoFile('src/polymarket/bot.ts'))).not.toThrow();
  });

  it('holds in placeMarketBuy today', () => {
    expect(() => checkFokEndpoint(repoFile('src/polymarket/trade.ts'))).not.toThrow();
  });

  // Everything below proves the two checkers above can actually fail. Each
  // fixture is a regression someone could plausibly introduce in one edit.
  describe('the checkers reject what they are meant to reject', () => {
    const routing = (arm: string, directional = 'placeOrder') => `
      const orderResult = plan.isArbLeg
        ? await ${arm}
        : await ${directional}({
          tokenId: pending.tokenId,
          side: 'buy',
          price: entryPx,
        });
    `;
    const FOK_ARM = `placeMarketBuy({
          tokenId: pending.tokenId,
          amountUsd: plan.sizeUsd,
          maxPrice: entryPx,
        })`;

    it('accepts a correctly routed source, so it is not simply throwing on everything', () => {
      expect(() => checkArbRouting(routing(FOK_ARM))).not.toThrow();
    });

    it('catches the arb branch reverted to a GTC limit — the Aug-28 bug itself', () => {
      const reverted = routing(`placeOrder({
          tokenId: pending.tokenId,
          amountUsd: plan.sizeUsd,
          maxPrice: entryPx,
        })`);
      expect(() => checkArbRouting(reverted)).toThrow(/does not call placeMarketBuy/);
    });

    it('catches an arb leg sent with no slippage bound', () => {
      const unpriced = routing(`placeMarketBuy({
          tokenId: pending.tokenId,
          amountUsd: plan.sizeUsd,
        })`);
      expect(() => checkArbRouting(unpriced)).toThrow(/entryPx as maxPrice/);
    });

    it('catches a slippage bound pinned to a constant instead of the entry price', () => {
      const pinned = routing(`placeMarketBuy({
          tokenId: pending.tokenId,
          maxPrice: 0.99,
        })`);
      expect(() => checkArbRouting(pinned)).toThrow(/entryPx as maxPrice/);
    });

    it('catches directional entries being switched to market orders', () => {
      expect(() => checkArbRouting(routing(FOK_ARM, 'placeMarketBuy')))
        .toThrow(/directional branch calls placeMarketBuy/);
    });

    it('catches the branch being removed or renamed entirely', () => {
      expect(() => checkArbRouting('const orderResult = await placeOrder({});'))
        .toThrow(/does not branch on plan\.isArbLeg/);
    });

    it('catches placeMarketBuy rebuilt on the GTC endpoint', () => {
      const gtc = `
export async function placeMarketBuy({ tokenId, amountUsd, maxPrice }) {
  const result = await client.createAndPostOrder({ tokenID: tokenId }, {});
  return result;
}
`;
      expect(() => checkFokEndpoint(gtc)).toThrow(/that is the GTC path/);
    });

    it('catches placeMarketBuy disappearing', () => {
      expect(() => checkFokEndpoint('export async function placeOrder() {}'))
        .toThrow(/not found/);
    });
  });
});

/**
 * Behavioural, not source-scanned: these call the real function. Both guards sit
 * above `getProxyTradingClient()` in `placeMarketBuy` (trade.ts:251-261), so
 * they reject with no signer, credentials, or network. If a future edit moves
 * client construction above them, these start requiring a wallet and fail — the
 * correct outcome, since the contract would no longer hold offline.
 */
describe('INVARIANT: a market buy is never sent unpriced', () => {
  const validCall = {
    tokenId: 'token-up',
    amountUsd: 10,
    maxPrice: 0.33,
    tickSize: '0.01',
    minShares: 5,
  };

  // `buildMarketOrderCreationArgs.js:8` signs with `userMarketOrder.price || 1`.
  // A market buy with no price is therefore signed at an implied $1.00/share
  // limit — it would pay away the entire arbitrage edge on one leg and still
  // report success. The price is the slippage bound, not a hint.
  for (const [label, maxPrice] of [
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -0.5],
    ['NaN', Number.NaN],
    ['empty string', ''],
  ] as const) {
    it(`refuses a buy whose maxPrice is ${label}`, async () => {
      await expect(placeMarketBuy({ ...validCall, maxPrice })).rejects.toThrow(/maxPrice/);
    });
  }

  it('refuses a non-positive order amount', async () => {
    await expect(
      placeMarketBuy({ ...validCall, amountUsd: 0, minShares: 0 }),
    ).rejects.toThrow(/non-positive amount/);
  });
});

/**
 * INVARIANT: a market sell is never sent unpriced.
 *
 * The mirror of the buy-side guard, and the more dangerous of the two. For a
 * SELL `getMarketOrderRawAmounts.js` computes taker = maker x price, so the
 * `price || 1` default demands $1.00/share — an order that fails the exchange's
 * slippage check on every book this bot trades. It shipped that way in 72c27ac
 * (2026-08-27), one day before the live canary, across every exit path.
 */
describe('INVARIANT: a market sell is never sent unpriced', () => {
  for (const [label, minPrice] of [
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -0.5],
    ['NaN', Number.NaN],
  ] as const) {
    it(`refuses a sell whose minPrice is ${label}`, async () => {
      await expect(
        placeMarketSell({ tokenId: 'token-up', shares: 26, minPrice, tickSize: '0.01' }),
      ).rejects.toThrow(/minPrice/);
    });
  }

  it('no live sell call site omits minPrice', () => {
    // The regression this file exists to prevent: a new exit path added later
    // that calls placeMarketSell the old way. Every call must carry the floor.
    for (const rel of ['src/polymarket/bot.ts', 'src/polymarket/arbEngine.ts', 'src/api/publicPredictions.ts']) {
      const src = repoFile(rel);
      const calls = src.match(/placeMarketSell\(\{[\s\S]*?\}\)/g) || [];
      expect(calls.length, `${rel} has no placeMarketSell calls — did it move?`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, `unpriced placeMarketSell in ${rel}`).toMatch(/minPrice:/);
      }
    }
  });
});

/**
 * The floor must track the *current* mark. Anchoring it to the entry price
 * reintroduces the same unfillable-order bug in the one place it costs most: a
 * stop-loss fires because the mark fell, so a floor derived from entry sits
 * above the book exactly when getting out matters.
 */
describe('INVARIANT: the sell floor tracks the mark, not the entry', () => {
  it('sits below a crashed mark, not below the entry price', () => {
    const entry = 0.50;
    const crashedMark = 0.20;
    const floor = sellFloor(crashedMark, { tickSize: 0.01 });

    expect(floor).toBeLessThan(crashedMark);
    expect(floor).toBeGreaterThan(0);
    // The bug being guarded: entry * 0.90 = $0.45, far above a $0.20 book.
    expect(floor).toBeLessThan(entry * 0.90);
  });

  it('never returns a price the exchange would reject as out of range', () => {
    for (const mark of [0.99, 0.5, 0.02, 0.01, 0.001]) {
      const floor = sellFloor(mark, { tickSize: 0.01 });
      expect(floor).toBeGreaterThanOrEqual(0.01);
      expect(floor).toBeLessThanOrEqual(0.99);
    }
  });

  it('falls back to the minimum tick when no mark is known', () => {
    // An untracked wallet asset. A wide floor risks a poor fill; no floor means
    // $1.00/share and no fill at all.
    for (const missing of [null, undefined, 0, Number.NaN, -1]) {
      expect(sellFloor(missing, { tickSize: 0.01 })).toBe(0.01);
    }
  });

  it('rounds down to the tick, so the floor is never nudged above the book', () => {
    const floor = sellFloor(0.337, { tickSize: 0.01, slippagePct: 0 });
    expect(floor).toBe(0.33);
  });
});
