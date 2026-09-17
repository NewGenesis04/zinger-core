// @ts-nocheck
/**
 * INVARIANT: a dead CLOB proxy is reported as a dead proxy, blocks live trading,
 * and is diagnosed without spending proxy quota on a healthy pass (item 59).
 *
 * Every CLOB call egresses through a metered proxy. When it dies, the legs that
 * use it fail with auth, registry and region messages that do not name the
 * cause — and, while it is running, cached region + remembered API key +
 * on-chain pUSD can leave `liveReady` true with no route to the CLOB.
 *
 * The probe is itself a proxied request, so these tests pin WHEN it runs as
 * firmly as what it reports.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const SIGNER = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x2222222222222222222222222222222222222222';
const OWNER_WORD = `0x${'0'.repeat(24)}${SIGNER.slice(2)}`;

const geoblockSpy = vi.fn();
const proxyHealthSpy = vi.fn();
const apiKeySpy = vi.fn();
const clobBalanceSpy = vi.fn();
const callSpy = vi.fn();
const readContractSpy = vi.fn();
const getBalanceSpy = vi.fn();
const fetchSpy = vi.fn();
let proxyUrl = 'http://user:pass@proxy.example:8080';

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
  checkProxyHealth: (...a) => proxyHealthSpy(...a),
  getClobProxyUrl: () => proxyUrl,
  redactProxy: (u) => (u ? 'proxy.example:8080' : null),
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

const { checkReadiness, resetReadinessCache, invalidateBalanceCache } =
  await import('../../src/polymarket/readiness.js');

const PROXY_DOWN = { ok: false, configured: true, detail: 'timeout of 6000ms exceeded' };
const PROXY_UP = { ok: true, configured: true, latencyMs: 180, detail: 'CLOB reachable via proxy' };

function allLegsHealthy() {
  geoblockSpy.mockResolvedValue({ ok: true, blocked: false, country: 'IE', viaProxy: true });
  apiKeySpy.mockResolvedValue({ key: 'api-key' });
  clobBalanceSpy.mockResolvedValue({ balance: 25, allowance: 100, clobError: null });
  callSpy.mockResolvedValue({ data: OWNER_WORD });
  readContractSpy.mockResolvedValue(30_000_000n);
  getBalanceSpy.mockResolvedValue(5_000_000_000_000_000_000n);
  fetchSpy.mockResolvedValue({ ok: true, json: async () => [] });
  proxyHealthSpy.mockResolvedValue(PROXY_UP);
}

/**
 * The proxy dies while the bot is running: region still cached as allowed, API
 * key still remembered, the SDK returns the transport error as a value, and the
 * deposit wallet's pUSD is read on-chain without the proxy.
 */
function proxyDiedMidRun() {
  clobBalanceSpy.mockResolvedValue({ balance: 0, allowance: 0, clobError: 'timeout of 10000ms exceeded' });
}

/** The bot restarts while the proxy is dead. */
function proxyDeadAtStart() {
  geoblockSpy.mockResolvedValue({
    ok: true, blocked: true, country: 'FR', viaProxy: false, proxyError: 'timeout of 8000ms exceeded',
  });
  apiKeySpy.mockRejectedValue(new Error('CLOB auth backoff (60s left): timeout of 10000ms exceeded'));
  clobBalanceSpy.mockResolvedValue({ balance: 0, allowance: 0, clobError: 'timeout of 10000ms exceeded' });
}

const row = (r, id) => r.checks.find((c) => c.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  resetReadinessCache();
  globalThis.fetch = fetchSpy;
  proxyUrl = 'http://user:pass@proxy.example:8080';
  allLegsHealthy();
});

describe('INVARIANT: a healthy pass spends no proxy quota on diagnosis', () => {
  it('never probes the proxy when no proxied leg failed', async () => {
    for (let i = 0; i < 5; i++) {
      invalidateBalanceCache();
      const r = await checkReadiness({});
      expect(r.liveReady).toBe(true);
      expect(row(r, 'proxy')).toBeUndefined();
    }
    expect(proxyHealthSpy).not.toHaveBeenCalled();
  });

  it('never probes when no proxy is configured, whatever fails', async () => {
    proxyUrl = null;
    proxyDeadAtStart();
    const r = await checkReadiness({});
    expect(proxyHealthSpy).not.toHaveBeenCalled();
    expect(row(r, 'proxy')).toBeUndefined();
  });
});

describe('INVARIANT: any proxied-leg failure triggers exactly one probe', () => {
  const triggers = {
    'geoblock fell back past the proxy': () => geoblockSpy.mockResolvedValue({
      ok: true, blocked: true, country: 'FR', viaProxy: false, proxyError: 'socket hang up' }),
    'geoblock answered badly through the proxy': () => geoblockSpy.mockResolvedValue({
      ok: false, blocked: true, viaProxy: true, error: '<html>407</html>' }),
    'API key derivation failed': () => apiKeySpy.mockRejectedValue(new Error('timeout')),
    'CLOB balance threw': () => clobBalanceSpy.mockRejectedValue(new Error('timeout')),
    'CLOB balance returned an error value': () => proxyDiedMidRun(),
  };

  for (const [name, breakIt] of Object.entries(triggers)) {
    it(name, async () => {
      breakIt();
      await checkReadiness({});
      expect(proxyHealthSpy).toHaveBeenCalledTimes(1);
    });
  }
});

describe('INVARIANT: a confirmed-dead proxy blocks live trading and is named as the cause', () => {
  it('turns liveReady false in the mid-run shape, where it was otherwise true', async () => {
    proxyDiedMidRun();

    // Control: the same state with a reachable proxy. Proves the flip below is
    // the proxy verdict and nothing else.
    proxyHealthSpy.mockResolvedValue(PROXY_UP);
    const control = await checkReadiness({});
    expect(control.liveReady).toBe(true);

    resetReadinessCache();
    proxyHealthSpy.mockResolvedValue(PROXY_DOWN);
    const r = await checkReadiness({});

    expect(r.liveReady).toBe(false);
    expect(r.checks[0].id).toBe('proxy');
    expect(r.checks[0].ok).toBe(false);
    expect(r.checks[0].detail).toMatch(/unreachable/);
    expect(r.needs[0]).toMatch(/CLOB proxy unreachable/);
  });

  it('puts the proxy row first and leaves every other check in place', async () => {
    proxyDiedMidRun();
    proxyHealthSpy.mockResolvedValue(PROXY_DOWN);

    const ids = (await checkReadiness({})).checks.map((c) => c.id);

    expect(ids[0]).toBe('proxy');
    expect(ids.filter((id) => id === 'proxy')).toHaveLength(1);
    for (const id of ['geoblock', 'api', 'deposit_owner', 'clob_balance', 'position_size']) {
      expect(ids).toContain(id);
    }
  });

  it('drops the auth, registry and region leads that point away from the proxy', async () => {
    proxyDeadAtStart();
    proxyHealthSpy.mockResolvedValue(PROXY_DOWN);

    const r = await checkReadiness({});
    const needs = r.needs.join(' | ');

    expect(r.liveReady).toBe(false);
    expect(needs).not.toMatch(/CLOB registry/);
    expect(needs).not.toMatch(/must sign CLOB API auth/);
    expect(needs).not.toMatch(/restricted in/);
    expect(needs).toMatch(/CLOB proxy unreachable/);
  });

  it('does not report this host\'s direct egress as the trading region', async () => {
    proxyDeadAtStart();
    proxyHealthSpy.mockResolvedValue(PROXY_DOWN);

    const r = await checkReadiness({});

    expect(row(r, 'geoblock').detail).not.toMatch(/restricted/i);
    expect(row(r, 'geoblock').detail).toMatch(/through the CLOB proxy failed/);
  });

  it('does not blame the proxy when the probe reaches the CLOB', async () => {
    clobBalanceSpy.mockRejectedValue(new Error('500 internal'));
    proxyHealthSpy.mockResolvedValue(PROXY_UP);

    const r = await checkReadiness({});

    expect(row(r, 'proxy').ok).toBe(true);
    expect(row(r, 'proxy').detail).toMatch(/not the proxy/);
    expect(r.needs.join(' | ')).not.toMatch(/proxy unreachable/);
  });
});

describe('INVARIANT: the probe backs off during an outage and forgets on recovery', () => {
  it('does not re-probe on every pass while the failure persists', async () => {
    proxyDiedMidRun();
    proxyHealthSpy.mockResolvedValue(PROXY_DOWN);

    for (let i = 0; i < 5; i++) {
      invalidateBalanceCache();
      const r = await checkReadiness({});
      expect(r.liveReady).toBe(false);   // still blocked while cached, not silently re-armed
    }
    expect(proxyHealthSpy).toHaveBeenCalledTimes(1);
  });

  it('asks again after a clean pass, rather than replaying a stale "down"', async () => {
    proxyDiedMidRun();
    proxyHealthSpy.mockResolvedValue(PROXY_DOWN);
    await checkReadiness({});
    expect(proxyHealthSpy).toHaveBeenCalledTimes(1);

    // Proxy restored: a pass with no proxied failure.
    clobBalanceSpy.mockResolvedValue({ balance: 25, allowance: 100, clobError: null });
    invalidateBalanceCache();
    const clean = await checkReadiness({});
    expect(row(clean, 'proxy')).toBeUndefined();
    expect(clean.liveReady).toBe(true);

    // A later, unrelated CLOB failure must get a fresh probe, not the old verdict.
    clobBalanceSpy.mockRejectedValue(new Error('500 internal'));
    proxyHealthSpy.mockResolvedValue(PROXY_UP);
    invalidateBalanceCache();
    const later = await checkReadiness({});

    expect(proxyHealthSpy).toHaveBeenCalledTimes(2);
    expect(row(later, 'proxy').ok).toBe(true);
  });
});
