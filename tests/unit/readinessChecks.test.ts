// @ts-nocheck
/**
 * INVARIANT: `checkReadiness` reports the same checks, in the same order, no
 * matter which of its legs fail or how long each takes.
 *
 * Backlog item 55 turned this function from eight sequential network calls into
 * eight concurrent ones, because the sum of their timeouts (~55s) sat past the
 * 25s response deadline on `/api/poly/sync` (item 54). That rewrite could break
 * three things that no other test would notice:
 *
 *   1. **Order.** The dashboard renders `checks` as an array, in array order.
 *      Assembling results as they arrive rather than in a fixed order would
 *      silently reshuffle the operator's readiness panel.
 *   2. **Independence.** Sequentially, a failing leg could not stop a later one
 *      because each had its own try/catch. That has to stay true now that they
 *      are started together.
 *   3. **Concurrency itself.** Nothing about the code's *shape* forces the legs
 *      to overlap — someone tidying the `await`s back into a chain would restore
 *      the original bug with every test still green.
 *
 * These assert properties, not a snapshot: a new check can be added anywhere in
 * CANONICAL_ORDER without editing an expectation, but reordering or dropping one
 * fails. Per CLAUDE.md, a characterization test here would freeze the bug too.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Every check `checkReadiness` can emit, in the order it must emit them. */
const CANONICAL_ORDER = [
  'geoblock',
  'api',
  'deposit_owner',
  'deposit_pusd',
  'open_positions',
  'clob_balance',
  'allowance',
  'wallet_usdc',
  'gas',
  'position_size',
];

const SIGNER = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x2222222222222222222222222222222222222222';
const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

/** Owner slot read back as a 32-byte word, which is what `call` returns. */
const OWNER_WORD = `0x${'0'.repeat(24)}${SIGNER.slice(2)}`;

const resolveAfter = (ms, value) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));
const rejectAfter = (ms, message) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

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

// `formatUnits` stays real — the legs hand it BigInt words and the assertions
// below depend on it decoding them.
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

const { checkReadiness } = await import('../../src/polymarket/readiness.js');

/** Every leg succeeds, each after `delayMs`. Individual legs overridden per test. */
function allLegsHealthy(delayMs = 0) {
  geoblockSpy.mockImplementation(() =>
    resolveAfter(delayMs, { ok: true, blocked: false, country: 'GB' }));
  apiKeySpy.mockImplementation(() => resolveAfter(delayMs, { key: 'api-key' }));
  clobBalanceSpy.mockImplementation(() =>
    resolveAfter(delayMs, { balance: 25, allowance: 100, clobError: null }));
  callSpy.mockImplementation(() => resolveAfter(delayMs, { data: OWNER_WORD }));
  readContractSpy.mockImplementation(({ address }) =>
    resolveAfter(delayMs, address === PUSD ? 30_000_000n : 12_000_000n));
  getBalanceSpy.mockImplementation(() => resolveAfter(delayMs, 5_000_000_000_000_000_000n));
  fetchSpy.mockImplementation(() =>
    resolveAfter(delayMs, {
      ok: true,
      json: async () => [{ cashPnl: 1.5 }],
    }));
}

const idsOf = (readiness) => readiness.checks.map((c) => c.id);

/** True when `ids` appears in CANONICAL_ORDER order, gaps allowed. */
function isSubsequenceOfCanonical(ids) {
  let cursor = -1;
  return ids.every((id) => {
    const next = CANONICAL_ORDER.indexOf(id, cursor + 1);
    if (next === -1) return false;
    cursor = next;
    return true;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = fetchSpy;
  allLegsHealthy(0);
});

describe('INVARIANT: readiness checks keep their order and their independence', () => {
  it('emits every check exactly once, in canonical order, when all legs succeed', async () => {
    const readiness = await checkReadiness({});
    const ids = idsOf(readiness);

    expect(ids).toEqual(CANONICAL_ORDER);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the order when only some legs report', async () => {
    // No open positions and no deposit wallet balance to report: two checks
    // drop out. The survivors must not reshuffle to close the gaps.
    fetchSpy.mockImplementation(async () => ({ ok: true, json: async () => [] }));

    const ids = idsOf(await checkReadiness({}));

    expect(ids).not.toContain('open_positions');
    expect(isSubsequenceOfCanonical(ids)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not let one leg failing remove any other leg', async () => {
    // Property form: fail each failable leg on its own, and assert the other
    // checks still arrive. Sequentially this held because every leg had its own
    // try/catch; concurrently it has to keep holding.
    const failable = {
      api: () => apiKeySpy.mockRejectedValue(new Error('auth down')),
      clob: () => clobBalanceSpy.mockRejectedValue(new Error('clob down')),
      chain: () => readContractSpy.mockRejectedValue(new Error('rpc down')),
      gas: () => getBalanceSpy.mockRejectedValue(new Error('rpc down')),
      positions: () => fetchSpy.mockRejectedValue(new Error('data-api down')),
    };

    for (const [name, breakIt] of Object.entries(failable)) {
      vi.clearAllMocks();
      allLegsHealthy(0);
      breakIt();

      const ids = idsOf(await checkReadiness({}));

      expect(isSubsequenceOfCanonical(ids), `${name}: order broke`).toBe(true);
      expect(new Set(ids).size, `${name}: duplicate check`).toBe(ids.length);
      // The legs that did not fail must all still be present.
      expect(ids, `${name}: unrelated check vanished`).toContain('geoblock');
      expect(ids, `${name}: unrelated check vanished`).toContain('deposit_owner');
      expect(ids, `${name}: position_size is computed last and must survive`)
        .toContain('position_size');
    }
  });

  it('still answers when every failable leg rejects at once', async () => {
    apiKeySpy.mockRejectedValue(new Error('auth down'));
    clobBalanceSpy.mockRejectedValue(new Error('clob down'));
    readContractSpy.mockRejectedValue(new Error('rpc down'));
    getBalanceSpy.mockRejectedValue(new Error('rpc down'));
    fetchSpy.mockRejectedValue(new Error('data-api down'));

    const readiness = await checkReadiness({});

    // Degraded, not thrown: `refreshTelemetry` depends on this resolving.
    expect(readiness.liveReady).toBe(false);
    expect(readiness.paperReady).toBe(true);
    expect(isSubsequenceOfCanonical(idsOf(readiness))).toBe(true);
    expect(readiness.needs.length).toBeGreaterThan(0);
  });
});

describe('INVARIANT: the readiness legs overlap rather than queue', () => {
  it('finishes in about one leg-time, not eight', async () => {
    // This is the property backlog item 55 bought. Re-chaining the awaits would
    // pass every assertion above and fail here.
    const LEG_MS = 150;
    const LEG_COUNT = 8;
    allLegsHealthy(LEG_MS);

    const started = Date.now();
    await checkReadiness({});
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(LEG_MS * 0.5); // the delays did apply
    expect(elapsed).toBeLessThan((LEG_MS * LEG_COUNT) / 2); // nowhere near the sum
  });

  it('attaches a handler to every leg at start time, not at await time', async () => {
    /*
     * The legs are started before any is awaited. A leg that rejects early,
     * while an earlier-awaited leg is still pending, therefore has no handler
     * attached yet — an unhandledRejection, which `index.ts:18` would print as a
     * bare "Unhandled:" line for an error the function already handles.
     * `capture()` in readiness.ts exists to close that window.
     *
     * Measured by *when a handler is attached*, not by listening for
     * `unhandledRejection`: that event is not observable inside the vitest
     * worker, and an earlier version of this test passed happily against the
     * bug. The probe below is a thenable, so `await` cannot bypass it the way it
     * bypasses `.then` on a native promise.
     */
    const attachedAt: number[] = [];
    const probed = (inner: Promise<unknown>) => {
      inner.catch(() => {}); // measuring the consumer, not making real noise
      return {
        then(onFulfilled: unknown, onRejected: unknown) {
          attachedAt.push(Date.now());
          return inner.then(onFulfilled as never, onRejected as never);
        },
      };
    };

    allLegsHealthy(0);
    // Awaited first, resolves last — this is the window a late handler falls into.
    geoblockSpy.mockImplementation(() =>
      resolveAfter(300, { ok: true, blocked: false, country: 'GB' }));
    // Awaited last, rejects immediately.
    getBalanceSpy.mockImplementation(() => probed(rejectAfter(10, 'rpc down')));

    const started = Date.now();
    const readiness = await checkReadiness({});

    expect(attachedAt).toHaveLength(1);
    // Attached while the function was still starting legs, not 300ms later when
    // the geoblock leg finally resolved and the awaits began landing.
    expect(attachedAt[0] - started).toBeLessThan(100);
    expect(idsOf(readiness)).toContain('gas'); // and the leg still reports
  });
});
