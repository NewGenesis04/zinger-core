// @ts-nocheck
/**
 * INVARIANT: the bulk migration never imports a credential.
 *
 * `migrateDir` walks `data/` and imports every `.json` it finds. That is how a
 * `wallet.json` carrying a live `privateKey` came to sit in the `docs` table,
 * where it stayed inert until a read endpoint nearly made it reachable
 * (backlog 52/53).
 *
 * The store is shared state — read by the dashboard, backed up, copied off the
 * VPS for analysis. A secret in it is a secret in all of those, so the walk is
 * the one place a single filter covers every future consumer.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { migrateDir, sqliteLoad } from '../../src/polymarket/sqliteStore.js';
import { dataPath } from '../../src/polymarket/dataDir.js';

const FAKE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('INVARIANT: migrateDir refuses credentials', () => {
  let dir: string;
  let rel: string;

  beforeEach(() => {
    rel = `migrate-secret-test-${Math.random().toString(36).slice(2, 8)}`;
    dir = dataPath(rel);
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, obj: unknown) =>
    fs.writeFileSync(path.join(dir, name), JSON.stringify(obj), 'utf-8');

  it('refuses a credential FILENAME without reading it', () => {
    write('wallet.json', { address: '0xabc', privateKey: FAKE_KEY });
    write('poly_ok.json', { trades: [1, 2, 3] });

    const res = migrateDir(dir);

    expect(res.refused).toBe(1);
    expect(sqliteLoad(`${rel}/wallet.json`)).toBeNull();
    // and the innocent file beside it still imported
    expect(sqliteLoad(`${rel}/poly_ok.json`)).toEqual({ trades: [1, 2, 3] });
  });

  it('refuses a credential filename even when the content scan cannot see the key', () => {
    // Found by mutation testing: with only the two cases above, disabling the
    // filename filter changed nothing — `wallet.json` also carries a top-level
    // `privateKey`, so the content check caught it either way, and the filename
    // filter was untested (convention 6: believe the surviving mutant).
    //
    // This is the shape only the filename filter covers. `carriesSecret`
    // inspects TOP-LEVEL keys, so a key nested one level down is invisible to
    // it. The two guards are not redundant; they cover different misses.
    write('secrets.json', { vault: { privateKey: FAKE_KEY } });

    const res = migrateDir(dir);

    expect(res.refused).toBe(1);
    expect(sqliteLoad(`${rel}/secrets.json`)).toBeNull();
  });

  it('refuses a credential FIELD in an innocently-named file', () => {
    // The case a filename filter alone would miss, and the one that matters:
    // nothing about `config.json` warns you.
    write('config.json', { mode: 'live', privateKey: FAKE_KEY });

    const res = migrateDir(dir);

    expect(res.refused).toBe(1);
    expect(sqliteLoad(`${rel}/config.json`)).toBeNull();
  });

  it('never lets the key value reach the store by any path', () => {
    // Property form: whatever migrateDir decides to import, no stored document
    // may contain the key. Survives changes to which files it accepts.
    write('wallet.json', { privateKey: FAKE_KEY });
    write('nested_creds.json', { mnemonic: 'abandon abandon ability' });
    write('harmless.json', { note: 'nothing secret here' });

    migrateDir(dir);

    for (const name of ['wallet.json', 'nested_creds.json', 'harmless.json']) {
      const stored = sqliteLoad(`${rel}/${name}`);
      expect(JSON.stringify(stored ?? {})).not.toContain(FAKE_KEY);
      expect(JSON.stringify(stored ?? {})).not.toContain('abandon');
    }
  });

  it('still imports ordinary state documents', () => {
    // The filter must not become a reason the migration stops working.
    write('poly_trades.json', [{ id: 't1', pnl: 1.25 }]);
    write('session_perf.json', { wins: 3, losses: 1 });

    const res = migrateDir(dir);

    expect(res.refused).toBe(0);
    expect(res.imported).toBe(2);
    expect(sqliteLoad(`${rel}/poly_trades.json`)).toEqual([{ id: 't1', pnl: 1.25 }]);
  });

  it('does not mistake an array or a scalar document for a credential', () => {
    // `carriesSecret` inspects object keys; a JSON array has numeric ones.
    write('list.json', [{ privateKeyish: 'not a field name' }]);

    const res = migrateDir(dir);

    expect(res.refused).toBe(0);
    expect(sqliteLoad(`${rel}/list.json`)).toEqual([{ privateKeyish: 'not a field name' }]);
  });
});
