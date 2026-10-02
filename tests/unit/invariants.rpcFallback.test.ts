// @ts-nocheck
/**
 * The readiness gate reads chain state through one viem client. One shared
 * public RPC shedding load must not block it while another endpoint answers.
 * Properties: the configured endpoint is always first, the list never holds
 * duplicates or blanks, and the client is built from every endpoint.
 */
import { describe, it, expect, vi } from 'vitest';

const built = [];
const fallbackSpy = vi.fn((ts) => ({ fallbackOf: ts }));
vi.mock('viem', async (orig) => {
  const actual = await orig<typeof import('viem')>();
  return {
    ...actual,
    http: (url) => ({ url }),
    fallback: (...a) => fallbackSpy(...a),
    createPublicClient: (cfg) => { built.push(cfg); return { call: async () => ({ data: '0x' }) }; },
  };
});
vi.mock('../../src/lib/wallet.js', () => ({ getWallet: () => ({ address: '0x1', polymarketDepositWallet: '0x2' }) }));
vi.mock('../../src/polymarket/trade.js', () => ({
  ensureApiKey: async () => ({}), getClobBalance: async () => ({}),
  getWalletAddress: () => '0x1', getFunderAddress: () => '0x2',
}));
vi.mock('../../src/polymarket/proxyEnv.js', () => ({
  checkGeoblock: async () => ({ ok: true }), checkProxyHealth: async () => ({}),
  getClobProxyUrl: () => null, redactProxy: () => null,
}));

const { buildPolygonRpcUrls, POLY } = await import('../../src/polymarket/config.js');

describe('INVARIANT: the RPC endpoint list (item 127)', () => {
  it('puts the primary first and drops duplicates and blanks', () => {
    const urls = buildPolygonRpcUrls('https://a', ' https://b , ,https://a', ['https://b', 'https://c']);
    expect(urls).toEqual(['https://a', 'https://b', 'https://c']);
  });
  it('is never empty, even with no primary', () => {
    expect(buildPolygonRpcUrls('', '').length).toBeGreaterThan(0);
  });
  it('has the configured endpoint first in the real config', () => {
    expect(POLY.polygonRpcUrls[0]).toBe(POLY.polygonRpc);
    expect(POLY.polygonRpcUrls.length).toBeGreaterThan(1);
  });
});

describe('INVARIANT: the readiness client tries every endpoint (item 127)', () => {
  it('builds one transport per endpoint, in order', async () => {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const { checkReadiness } = await import('../../src/polymarket/readiness.js');
    await checkReadiness({}).catch(() => {});
    expect(fallbackSpy).toHaveBeenCalled();
    const transports = fallbackSpy.mock.calls[0][0];
    expect(transports.map((t) => t.url)).toEqual(POLY.polygonRpcUrls);
  });
});
