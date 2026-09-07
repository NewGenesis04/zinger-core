// @ts-nocheck
/**
 * INVARIANT: a cached readiness leg costs no network call, and a failing leg is
 * retried with backoff rather than on every pass.
 *
 * Backlog item 61. `checkReadiness` runs on a background timer and two of its
 * legs egress through a metered CLOB proxy. Refetching everything each pass
 * drained a 1 GB/month Webshare quota in ~9 days at ~10 KB/request.
 *
 * The subtle half is the failure policy. "Never cache failures" sounds correct
 * and means "retry every time" — which is exactly the hammering that burned the
 * quota *while the proxy was already dead*. A failed leg therefore gets a short
 * negative cache with exponential backoff, and recovery must still be immediate
 * on the first success.
 *
 * These assert the policy (call counts and recovery), not the durations, so
 * retuning a TTL does not require editing a test — but removing the cache, or
 * caching a failure as though it were a success, does fail.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const SIGNER = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x2222222222222222222222222222222222222222';
const OWNER_WORD = `0x${'0'.repeat(24)}${SIGNER.slice(2)}`;

const geoblockSpy = vi.fn();
const apiKeySpy = vi.fn();
const clobBalanceSpy = vi.fn();
const callSpy = vi.fn();
const readContractSpy = vi.fn();
const getBalanceSpy = vi.fn();
const fetchSpy = vi.fn();

vi.mock('../../src/lib/wallet.js', () => ({
  getWallet: () => ({ address: SIGNER, polymarketDepositWallet: DEPOSIT }),
}));
vi.mock('../../src/polymarket/trade.js', () => ({
  ensureApiKey: (...a) => apiKeySpy(...a),
  getClobBalance: (...a) => clobBalanceSpy(...a),
  getWalletAddress: () => SIGNER,
  getFunderAddress: () => DEPOSIT,
}));
vi.mock('../../src/polymarket/proxyEnv.js', () => ({
  checkGeoblock: (...a) => geoblockSpy(...a),
  getClobProxyUrl: () => null,
  redactProxy: () => null,
}));
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    http: () => ({}),
    createPublicClient: () => ({
      call: (...a) => callSpy(...a),
      readContract: (...a) => readContractSpy(...a),
      getBalance: (...a) => getBalanceSpy(...a),
    }),
  };
});

const { checkReadiness, resetReadinessCache, invalidateBalanceCache, applyBalanceDelta } =
  await import('../../src/polymarket/readiness.js');

function allLegsHealthy() {
  geoblockSpy.mockResolvedValue({ ok: true, blocked: false, country: 'IE' });
  apiKeySpy.mockResolvedValue({ key: 'api-key' });
  clobBalanceSpy.mockResolvedValue({ balance: 25, allowance: 100, clobError: null });
  callSpy.mockResolvedValue({ data: OWNER_WORD });
  readContractSpy.mockResolvedValue(30_000_000n);
  getBalanceSpy.mockResolvedValue(5_000_000_000_000_000_000n);
  fetchSpy.mockResolvedValue({ ok: true, json: async () => [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resetReadinessCache();
  globalThis.fetch = fetchSpy;
  allLegsHealthy();
});

describe('INVARIANT: a warm readiness cache makes no network calls', () => {
  it('hits the proxy-backed legs once across repeated passes', async () => {
    await checkReadiness({});
    await checkReadiness({});
    await checkReadiness({});

    // These two are the metered ones. Everything else is direct egress.
    expect(geoblockSpy).toHaveBeenCalledTimes(1);
    expect(clobBalanceSpy).toHaveBeenCalledTimes(1);
  });

  it('caches the direct-RPC legs too, so a pass can be fully offline', async () => {
    await checkReadiness({});
    vi.clearAllMocks();
    allLegsHealthy();

    const readiness = await checkReadiness({});

    for (const spy of [geoblockSpy, clobBalanceSpy, callSpy, readContractSpy, getBalanceSpy, fetchSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
    // ...and still returns a complete, usable answer from cache.
    expect(readiness.checks.map((c) => c.id)).toContain('clob_balance');
    expect(readiness.spendableBalance).toBeGreaterThan(0);
  });

  it('shares one in-flight call between concurrent passes', async () => {
    // The background timer can overlap an operator-triggered sync. Without
    // promise-level caching that doubles the proxy traffic at exactly the moment
    // the proxy is already slow.
    let release;
    clobBalanceSpy.mockImplementation(() => new Promise((r) => { release = () => r({ balance: 25, allowance: 100, clobError: null }); }));

    const both = Promise.all([checkReadiness({}), checkReadiness({})]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await both;

    expect(clobBalanceSpy).toHaveBeenCalledTimes(1);
  });
});

describe('INVARIANT: failures are retried with backoff, not on every pass', () => {
  it('does not refetch a failed leg on the very next pass', async () => {
    clobBalanceSpy.mockRejectedValue(new Error('proxy timeout'));

    await checkReadiness({});
    await checkReadiness({});
    await checkReadiness({});

    // The bug this replaces: a dead proxy re-probed every pass, forever.
    expect(clobBalanceSpy).toHaveBeenCalledTimes(1);
  });

  it('still reports the failure while backing off, rather than hiding it', async () => {
    // A dead proxy takes down both CLOB legs together — auth and balance share
    // the egress. Failing only one is not a state the real system produces.
    apiKeySpy.mockRejectedValue(new Error('proxy timeout'));
    clobBalanceSpy.mockRejectedValue(new Error('proxy timeout'));

    await checkReadiness({});
    const readiness = await checkReadiness({});

    const clob = readiness.checks.find((c) => c.id === 'clob_balance');
    expect(clob?.detail).toMatch(/proxy timeout/);
    expect(readiness.checks.find((c) => c.id === 'api')?.detail).toMatch(/proxy timeout/);
    // Cached failure must still refuse live trading, not go quiet.
    expect(readiness.liveReady).toBe(false);
    expect(readiness.needs.length).toBeGreaterThan(0);
  });

  it('recovers immediately on the first success after a failure', async () => {
    clobBalanceSpy.mockRejectedValue(new Error('proxy timeout'));
    await checkReadiness({});

    // Simulate the operator topping the proxy back up, then the backoff lapsing.
    resetReadinessCache();
    allLegsHealthy();
    const readiness = await checkReadiness({});

    expect(readiness.clobBalance).toBe(25);
    const clob = readiness.checks.find((c) => c.id === 'clob_balance');
    expect(clob?.detail).not.toMatch(/proxy timeout/);
  });
});

describe('INVARIANT: a fill expires the balance legs but nothing else', () => {
  it('refetches balances after invalidation', async () => {
    await checkReadiness({});
    vi.clearAllMocks();
    allLegsHealthy();

    invalidateBalanceCache();
    await checkReadiness({});

    // Sizing must never be based on money already spent.
    expect(clobBalanceSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves geoblock alone — a trade changes balances, not your region', async () => {
    await checkReadiness({});
    vi.clearAllMocks();
    allLegsHealthy();

    invalidateBalanceCache();
    await checkReadiness({});

    // The whole point of the tiering: a fill must not cost a proxied geo check.
    expect(geoblockSpy).not.toHaveBeenCalled();
  });
});

describe('INVARIANT: a fill is deducted synchronously, before the next sizing read', () => {
  it('reduces the balance immediately, without waiting for a refresh', async () => {
    const readiness = { spendableBalance: 100, clobBalance: 100 };

    applyBalanceDelta(readiness, -12.34);

    // arbEngine.ts:157 reads this field. It must be current the instant the fill
    // lands — a refresh takes hundreds of ms, during which the 250ms scan loop
    // could size more orders against money already committed.
    expect(readiness.spendableBalance).toBe(87.66);
    expect(readiness.clobBalance).toBe(87.66);
  });

  it('clamps at zero rather than going negative', async () => {
    const readiness = { spendableBalance: 5, clobBalance: 5 };

    applyBalanceDelta(readiness, -20);

    // A negative balance would size the NEXT trade wrongly in the other
    // direction, which is worse than reporting zero.
    expect(readiness.spendableBalance).toBe(0);
    expect(readiness.clobBalance).toBe(0);
  });

  it('credits on a sale as readily as it debits on a buy', async () => {
    const readiness = { spendableBalance: 10, clobBalance: 10 };
    applyBalanceDelta(readiness, 4.5);
    expect(readiness.spendableBalance).toBe(14.5);
  });

  it('leaves fields it cannot parse alone', async () => {
    const readiness = { spendableBalance: 50, clobBalance: null };
    applyBalanceDelta(readiness, -10);

    expect(readiness.spendableBalance).toBe(40);
    expect(readiness.clobBalance).toBeNull();   // not coerced to -10
  });

  it('is a no-op on a zero delta or a missing snapshot', async () => {
    const readiness = { spendableBalance: 50, clobBalance: 50 };
    applyBalanceDelta(readiness, 0);
    expect(readiness.spendableBalance).toBe(50);

    expect(() => applyBalanceDelta(null, -5)).not.toThrow();
    expect(() => applyBalanceDelta(undefined, -5)).not.toThrow();
  });

  it('expires the cached balance legs so the truth-up actually refetches', async () => {
    await checkReadiness({});
    vi.clearAllMocks();
    allLegsHealthy();

    applyBalanceDelta({ spendableBalance: 100, clobBalance: 100 }, -1);
    await checkReadiness({});

    // Without this the post-fill refresh silently returns the pre-trade cache.
    expect(clobBalanceSpy).toHaveBeenCalledTimes(1);
  });
});
