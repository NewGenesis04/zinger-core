import { describe, it, expect, beforeEach, vi } from 'vitest';

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


const { checkReadiness, resetReadinessCache, invalidateOwnerCache } = await import('../../src/polymarket/readiness.js');
const { handleMessage, getClobWsBook } = await import('../../src/polymarket/clobWs.js');

const owner = (r) => r.checks.find((c) => c.id === 'deposit_owner');

beforeEach(() => {
  vi.clearAllMocks();
  resetReadinessCache();
  globalThis.fetch = fetchSpy;
  geoblockSpy.mockResolvedValue({ ok: true, blocked: false, country: 'GB' });
  apiKeySpy.mockResolvedValue({ key: 'k' });
  clobBalanceSpy.mockResolvedValue({ balance: 25, allowance: 100, clobError: null });
  readContractSpy.mockImplementation(({ address }) => Promise.resolve(address === PUSD ? 30_000_000n : 12_000_000n));
  getBalanceSpy.mockResolvedValue(5_000_000_000_000_000_000n);
  fetchSpy.mockResolvedValue({ ok: true, json: async () => [] });
});

describe('INVARIANT: a failed owner read is unknown, never a mismatch (item 125)', () => {
  it('an RPC failure blocks live but does not claim the owner is wrong', async () => {
    callSpy.mockRejectedValue(new Error('rpc down'));
    const r = await checkReadiness({});
    expect(r.ownerUnknown).toBe(true);
    expect(r.liveReady).toBe(false);
    expect(owner(r).detail).toMatch(/could not be read/);
    expect(r.needs.join(' ')).not.toMatch(/export that wallet/);
  });

  it('a real mismatch still says so', async () => {
    callSpy.mockResolvedValue({ data: `0x${'0'.repeat(24)}${'9'.repeat(40)}` });
    const r = await checkReadiness({});
    expect(r.ownerUnknown).toBe(false);
    expect(r.ownerMatches).toBe(false);
    expect(r.needs.join(' ')).toMatch(/export that wallet/);
  });

  it('an answer with no owner is reported as that, not as an unreadable RPC', async () => {
    callSpy.mockResolvedValue({ data: '0x' });
    const r = await checkReadiness({});
    expect(r.ownerUnknown).toBe(false);
    expect(owner(r).detail).toMatch(/no owner/);
  });

  it('a failure is not held for the owner TTL: the next pass after backoff reads again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      callSpy.mockRejectedValueOnce(new Error('rpc down'));
      callSpy.mockResolvedValue({ data: `0x${'0'.repeat(24)}${SIGNER.slice(2)}` });
      expect((await checkReadiness({})).ownerMatches).toBe(false);
      vi.setSystemTime(Date.now() + 61_000);
      expect((await checkReadiness({})).ownerMatches).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidateOwnerCache forces a re-read inside the backoff', async () => {
    callSpy.mockRejectedValueOnce(new Error('rpc down'));
    callSpy.mockResolvedValue({ data: `0x${'0'.repeat(24)}${SIGNER.slice(2)}` });
    expect((await checkReadiness({})).ownerUnknown).toBe(true);
    invalidateOwnerCache();
    expect((await checkReadiness({})).ownerMatches).toBe(true);
  });
});

describe('INVARIANT: no socket frame can throw out of the message handler (item 126)', () => {
  it.each(['null', '"x"', '7', 'true', '[null]', '[1,null,"a"]', '[]', '{}', 'not json'])('frame %s', (frame) => {
    expect(() => handleMessage(Buffer.from(frame))).not.toThrow();
  });

  it('still applies a valid book after a null frame', () => {
    handleMessage(Buffer.from('null'));
    handleMessage(Buffer.from(JSON.stringify({ event_type: 'book', asset_id: 'frame-ok', bids: [{ price: '0.4', size: '10' }], asks: [{ price: '0.6', size: '10' }] })));
    expect(getClobWsBook('frame-ok')?.bestBid).toBe(0.4);
  });
});
