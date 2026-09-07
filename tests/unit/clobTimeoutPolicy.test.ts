// @ts-nocheck
/**
 * INVARIANT: every CLOB read is bounded; only order-mutating writes are not.
 *
 * `@polymarket/clob-client-v2` routes through the *global* axios instance
 * (`dist/http-helpers/index.js:18`), so the tempting fix —
 * `axios.defaults.timeout = 10000` — would also cap order submission. An order
 * POST that times out is NOT a cancelled order: it may have reached the book,
 * leaving real money in a state the bot has no record of. That is the failure
 * `assertOrderAccepted` (`trade.ts:140`) and the receipt log exist to prevent.
 *
 * The opposite error is just as real and was the first version of this fix.
 * A `/\/order/` substring test plus "leave POSTs alone" exempts:
 *   - `/data/order/`, `/data/orders`, `/order-scoring`, `/orders-scoring` (reads)
 *   - `/auth/api-key` (POST) — `createOrDeriveApiKey`, the call that actually
 *     hung for 25s on a dead proxy and started backlog items 57–61
 * ...which would have shipped a fix that fixed nothing.
 *
 * Endpoint paths below are transcribed from
 * `node_modules/@polymarket/clob-client-v2/dist/endpoints.cjs`. This asserts the
 * policy, not the implementation: a new read endpoint is bounded by default and
 * needs no edit here, while anything newly exempted must be added deliberately.
 */
import { describe, it, expect } from 'vitest';
import { movesMoney } from '../../src/polymarket/proxyEnv.js';

const HOST = 'https://clob.polymarket.com';

/** Requests that must stay UNBOUNDED — a timeout here risks unknown order state. */
const MONEY = [
  ['POST', '/order'],
  ['POST', '/orders'],
  ['DELETE', '/order'],
  ['DELETE', '/orders'],
  ['POST', '/cancel-market-orders'],
  ['DELETE', '/cancel-market-orders'],
];

/** Requests that must be BOUNDED — hanging on these is what drained the quota. */
const READS = [
  ['POST', '/auth/api-key'],          // createOrDeriveApiKey — the 25s hang
  ['GET', '/auth/derive-api-key'],
  ['GET', '/auth/api-keys'],
  ['GET', '/data/orders'],            // getOpenOrders
  ['GET', '/data/order/0xabc123'],
  ['GET', '/order-scoring'],
  ['GET', '/orders-scoring'],
  ['GET', '/balance-allowance'],
  ['GET', '/book'],
  ['GET', '/books'],
  ['GET', '/time'],
  ['GET', '/markets'],
  ['GET', '/midpoint'],
  ['GET', '/price'],
  ['GET', '/tick-size'],
  ['GET', '/neg-risk'],
  ['GET', '/fee-rate'],
  ['GET', '/cancel-market-orders'],   // method matters, not just the path
  ['GET', '/order'],                  // a GET on the order path is a read
];

describe('INVARIANT: only order-mutating writes escape the read timeout', () => {
  it.each(MONEY)('%s %s moves money and stays unbounded', (method, path) => {
    expect(movesMoney(`${HOST}${path}`, method)).toBe(true);
  });

  it.each(READS)('%s %s is a read and gets bounded', (method, path) => {
    expect(movesMoney(`${HOST}${path}`, method)).toBe(false);
  });

  it('bounds the auth POST that actually hung — the regression this replaced', () => {
    // Guarded on its own because the first implementation got exactly this wrong:
    // `config.method === 'post'` classified the API-key derive as a write.
    expect(movesMoney(`${HOST}/auth/api-key`, 'POST')).toBe(false);
  });

  it('does not exempt a read whose path merely contains an order path', () => {
    // The substring-matching failure, stated as a property.
    for (const [method, path] of READS) {
      expect(movesMoney(`${HOST}${path}`, method), `${method} ${path}`).toBe(false);
    }
  });

  it('ignores query strings when classifying', () => {
    expect(movesMoney(`${HOST}/data/orders?market=0xabc`, 'GET')).toBe(false);
    expect(movesMoney(`${HOST}/order?foo=1`, 'POST')).toBe(true);
  });

  it('defaults to bounded for anything it cannot parse', () => {
    // Fail safe: an unrecognised request is a read, so it can never hang.
    expect(movesMoney(undefined, undefined)).toBe(false);
    expect(movesMoney('', 'POST')).toBe(false);
    expect(movesMoney('not a url', 'POST')).toBe(false);
  });

  it('treats a relative path the same as an absolute one', () => {
    expect(movesMoney('/order', 'POST')).toBe(true);
    expect(movesMoney('/auth/api-key', 'POST')).toBe(false);
  });
});
