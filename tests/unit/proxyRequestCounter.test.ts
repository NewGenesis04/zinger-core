// @ts-nocheck
/**
 * INVARIANT: every proxied request is counted, and reads and writes are counted
 * apart.
 *
 * Backlog item 61. Before this the bandwidth budget was unmeasurable in-process:
 * nothing counted requests, so the first sign that the bot was draining a
 * metered 1GB/month proxy quota was the provider cutting it off — at which point
 * the symptoms (`ERR_HTTP_HEADERS_SENT`, a 25s `/api/poly/sync`, "API key
 * missing") pointed at credentials rather than billing.
 *
 * The counter is the gauge that makes the bandwidth invariant checkable at all,
 * so it has to see the same requests the interceptor does — which is why it
 * lives in the interceptor rather than alongside it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import axios from 'axios';
import {
  installAxiosReadTimeouts,
  getProxyRequestStats,
  resetProxyRequestStats,
} from '../../src/polymarket/proxyEnv.js';

const HOST = 'https://clob.polymarket.com';

/**
 * Run a request through the interceptor chain without touching the network:
 * an adapter that resolves immediately still executes every request interceptor.
 */
async function send(url, method) {
  return axios({
    url,
    method,
    adapter: async (config) => ({ data: null, status: 200, statusText: 'OK', headers: {}, config }),
  });
}

beforeEach(() => {
  installAxiosReadTimeouts();   // idempotent
  resetProxyRequestStats();
});

describe('INVARIANT: proxied requests are counted', () => {
  it('counts a read and applies the read timeout to it', async () => {
    const res = await send(`${HOST}/balance-allowance`, 'get');

    const stats = getProxyRequestStats();
    expect(stats.total).toBe(1);
    expect(stats.reads).toBe(1);
    expect(stats.writes).toBe(0);
    // Regression guard: this assertion caught the interceptor being a no-op.
    // axios merges its defaults (timeout: 0) before interceptors run, so the
    // original `config.timeout == null` check never fired and no read was ever
    // actually bounded — while every predicate test still passed.
    expect(res.config.timeout).toBeGreaterThan(0);
  });

  it('respects a timeout a caller set deliberately', async () => {
    const res = await axios({
      url: `${HOST}/balance-allowance`,
      method: 'get',
      timeout: 1234,
      adapter: async (config) => ({ data: null, status: 200, statusText: 'OK', headers: {}, config }),
    });

    expect(res.config.timeout).toBe(1234);
  });

  it('counts an order write and leaves it unbounded', async () => {
    const res = await send(`${HOST}/order`, 'post');

    const stats = getProxyRequestStats();
    expect(stats.total).toBe(1);
    expect(stats.writes).toBe(1);
    expect(stats.reads).toBe(0);
    // The whole point of the timeout policy: an order POST must not be capped.
    expect(res.config.timeout == null || res.config.timeout === 0).toBe(true);
  });

  it('accumulates across mixed traffic', async () => {
    await send(`${HOST}/balance-allowance`, 'get');
    await send(`${HOST}/auth/api-key`, 'post');     // a read despite being POST
    await send(`${HOST}/data/orders`, 'get');
    await send(`${HOST}/order`, 'post');

    const stats = getProxyRequestStats();
    expect(stats.total).toBe(4);
    expect(stats.reads).toBe(3);
    expect(stats.writes).toBe(1);
  });

  it('projects a burn rate, which is the number worth watching', async () => {
    for (let i = 0; i < 5; i += 1) await send(`${HOST}/time`, 'get');

    const stats = getProxyRequestStats();
    expect(stats.total).toBe(5);
    // Rate is derived, not stored; only its presence and sign are asserted so
    // the test does not depend on wall-clock timing.
    expect(stats.perHour).toBeGreaterThan(0);
    expect(stats.projectedPerDay).toBeGreaterThan(0);
    expect(Object.values(stats.byDay).reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('does not double-count when the installer is called again', async () => {
    // installClobProxy() calls this on every invocation; a second interceptor
    // would silently double every future count and halve the apparent quota.
    installAxiosReadTimeouts();
    installAxiosReadTimeouts();

    await send(`${HOST}/time`, 'get');

    expect(getProxyRequestStats().total).toBe(1);
  });
});
