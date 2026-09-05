import { afterEach, describe, expect, it } from 'vitest';
import {
  isAuthConfigured,
  passwordsMatch,
  passwordRole,
  issueToken,
  verifyToken,
  viewerDenial,
  parseCookies,
} from '../../src/lib/auth.js';

const PREV = {
  AUTH_PASSWORD: process.env.AUTH_PASSWORD,
  AUTH_SECRET: process.env.AUTH_SECRET,
  ZINGER_PASSWORD: process.env.ZINGER_PASSWORD,
  READONLY_PASSWORD: process.env.READONLY_PASSWORD,
};

afterEach(() => {
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('auth', () => {
  it('reports configured only when password is set', () => {
    delete process.env.AUTH_PASSWORD;
    delete process.env.ZINGER_PASSWORD;
    delete process.env.AUTH_SECRET;
    expect(isAuthConfigured()).toBe(false);

    process.env.AUTH_PASSWORD = 'test-pass';
    expect(isAuthConfigured()).toBe(true);
  });

  it('matches passwords with timing-safe compare', () => {
    process.env.AUTH_PASSWORD = 'correct-horse';
    expect(passwordsMatch('correct-horse')).toBe(true);
    expect(passwordsMatch('wrong')).toBe(false);
  });

  it('issues and verifies HMAC tokens', () => {
    process.env.AUTH_PASSWORD = 'correct-horse';
    process.env.AUTH_SECRET = 'unit-test-secret';
    const token = issueToken();
    expect(verifyToken(token)).toMatchObject({ v: 1 });
    expect(verifyToken('not.a.token')).toBeNull();
    expect(verifyToken(`${token}x`)).toBeNull();
  });

  it('resolves password roles, preferring operator', () => {
    process.env.AUTH_PASSWORD = 'operator-pass';
    process.env.READONLY_PASSWORD = 'viewer-pass';
    expect(passwordRole('operator-pass')).toBe('operator');
    expect(passwordRole('viewer-pass')).toBe('viewer');
    expect(passwordRole('neither')).toBeNull();
    expect(passwordRole('')).toBeNull();

    // A shared value must not silently downgrade the operator login
    process.env.READONLY_PASSWORD = 'operator-pass';
    expect(passwordRole('operator-pass')).toBe('operator');
  });

  it('grants no viewer role when READONLY_PASSWORD is unset', () => {
    process.env.AUTH_PASSWORD = 'operator-pass';
    delete process.env.READONLY_PASSWORD;
    expect(passwordRole('')).toBeNull();
    expect(passwordRole('anything')).toBeNull();
  });

  it('round-trips the role through the token', () => {
    process.env.AUTH_PASSWORD = 'correct-horse';
    process.env.AUTH_SECRET = 'unit-test-secret';
    expect(verifyToken(issueToken('viewer'))).toMatchObject({ role: 'viewer' });
    expect(verifyToken(issueToken())).toMatchObject({ role: 'operator' });
  });

  it('scopes viewers to read-only /ops routes', () => {
    expect(viewerDenial('GET', '/ops/status')).toBeNull();

    // Writes are rejected even on the allowed surface
    expect(viewerDenial('POST', '/ops/status')).toBe('read-only');
    expect(viewerDenial('DELETE', '/ops/status')).toBe('read-only');
    expect(viewerDenial('POST', '/poly/start')).toBe('read-only');

    // Operator internals stay hidden from viewer reads
    expect(viewerDenial('GET', '/poly/state')).toBe('forbidden');
    expect(viewerDenial('GET', '/poly/stream')).toBe('forbidden');
    expect(viewerDenial('GET', '/wallet')).toBe('forbidden');
    expect(viewerDenial('GET', '/poly/audit')).toBe('forbidden');
    expect(viewerDenial('GET', '/opsimposter')).toBe('forbidden');
    expect(viewerDenial('GET', '')).toBe('forbidden');
  });

  it('parses cookie headers', () => {
    expect(parseCookies('a=1; b=two%20parts')).toEqual({ a: '1', b: 'two parts' });
    expect(parseCookies('')).toEqual({});
  });

  /**
   * `viewerDenial` gates on the path PREFIX, so it opens every GET under
   * `/ops/` to the read-only viewer role. That is fine for the curated status
   * page it was written for, and a trap for anything added beside it.
   *
   * `/api/ops/dump` reads the sqlite `docs` table, which holds `wallet.json`
   * with a `privateKey` field. If that route ever relies on the path prefix for
   * protection instead of checking `req.auth.role === 'operator'` itself, the
   * viewer password reads the live wallet key.
   *
   * This asserts the hazard rather than the fix, deliberately: it fails the day
   * someone "simplifies" the route by trusting the prefix.
   */
  it('does NOT protect /ops/dump — the route must check the role itself', () => {
    expect(viewerDenial('GET', '/ops/dump')).toBeNull();
    expect(viewerDenial('GET', '/ops/dump?key=poly_trades.json')).toBeNull();
    // Writes are still refused, so the exposure is read-only — which is exactly
    // enough to exfiltrate a private key.
    expect(viewerDenial('POST', '/ops/dump')).toBe('read-only');
  });
});
