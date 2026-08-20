// @ts-nocheck
/**
 * SQLite-backed persistence for Zinger Core.
 *
 * Uses Node 22's built-in `node:sqlite` (DatabaseSync) so the docker image
 * needs no native module compilation. Mirrors the persistence.js API surface
 * (load / persist / persistSync) keyed by the JSON store's relative path.
 *
 * Backend selection (backlog item 15). `ZINGER_SQLITE`:
 *   unset        — auto: use sqlite when `node:sqlite` loads, else JSON files
 *   1/true/on    — require sqlite; **throws at import** if unavailable
 *   0/false/off  — force the JSON fallback even where sqlite would work
 *
 * The explicit-but-unavailable case is fatal on purpose. Persistence silently
 * changing under a live-money bot — a Node downgrade swapping `zinger.db` for
 * whatever stale JSON is on disk — is the failure this switch exists to stop.
 * Set `ZINGER_DB_PATH` to move the .db file itself.
 *
 * The `node:sqlite` built-in is loaded lazily through createRequire so the
 * module can be imported on Node 20/21 — SQLITE_AVAILABLE is false there and
 * callers (persistence.ts) transparently fall back to JSON files on disk.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { getDataDir } from './dataDir.js';

const require = createRequire(import.meta.url);

let _DatabaseSync = null;
try {
  _DatabaseSync = require('node:sqlite').DatabaseSync ?? null;
} catch {
  _DatabaseSync = null;
}

const MODULE_AVAILABLE = _DatabaseSync !== null;

/** 'on' | 'off' | 'auto' — the operator's stated intent, from ZINGER_SQLITE. */
function readBackendPreference() {
  const raw = process.env.ZINGER_SQLITE;
  if (raw == null || String(raw).trim() === '') return 'auto';
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(v)) return 'on';
  if (['0', 'false', 'off', 'no'].includes(v)) return 'off';
  throw new Error(
    `[sqlite] ZINGER_SQLITE="${raw}" is not a recognised value — use 1/true/on, 0/false/off, or leave it unset.`,
  );
}

const BACKEND_PREFERENCE = readBackendPreference();

if (BACKEND_PREFERENCE === 'on' && !MODULE_AVAILABLE) {
  throw new Error(
    '[sqlite] ZINGER_SQLITE=1 requires the node:sqlite built-in, which this runtime ' +
      `does not provide (Node ${process.version}; needs 22+). Refusing to fall back to JSON ` +
      'silently — unset ZINGER_SQLITE to allow the fallback, or run on Node 22+.',
  );
}

export const SQLITE_AVAILABLE = MODULE_AVAILABLE && BACKEND_PREFERENCE !== 'off';

const DATA_DIR = getDataDir();

export const DB_PATH = process.env.ZINGER_DB_PATH
  ? path.resolve(process.env.ZINGER_DB_PATH)
  : path.join(DATA_DIR, 'zinger.db');

let _db = null;
let _migrated = false;

export function getDb() {
  if (!SQLITE_AVAILABLE) return null;
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new _DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  _db = db;
  ensureAutoMigrate();
  return db;
}

/** One-time import of any existing JSON files left on disk (idempotent). */
function ensureAutoMigrate() {
  if (_migrated) return;
  _migrated = true;
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    const res = migrateDir(DATA_DIR);
    if (res.imported > 0) {
      console.log(`[sqlite] imported ${res.imported} legacy JSON stores into ${DB_PATH}`);
    }
  } catch (err) {
    console.error(`[sqlite] auto-migrate skipped: ${err.message}`);
  }
}

/** Derive the stable sqlite key from an absolute file path. */
export function keyFromPath(file) {
  const abs = path.resolve(String(file || ''));
  if (abs.startsWith(DATA_DIR + path.sep)) {
    return abs.slice(DATA_DIR.length + 1);
  }
  return path.basename(abs);
}

export function sqliteLoad(key) {
  const db = getDb();
  if (!db) return null;
  const row = db.prepare('SELECT value FROM docs WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function sqlitePersistSync(key, data) {
  const db = getDb();
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO docs (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  stmt.run(key, JSON.stringify(data), Date.now());
}

export async function sqlitePersist(key, data) {
  sqlitePersistSync(key, data);
}

export function sqliteDelete(key) {
  const db = getDb();
  if (!db) return;
  db.prepare('DELETE FROM docs WHERE key = ?').run(key);
}

/**
 * Drop-in helpers for modules that historically read/wrote JSON with fs directly.
 * SQLite is the primary backend — the docs table is keyed by the file's path
 * relative to the data dir, so call sites keep their filename. On Node 20/21
 * (no `node:sqlite`) these transparently fall back to JSON files on disk.
 */
export function loadFileOrStore(file, fallback = null) {
  if (!SQLITE_AVAILABLE) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return fallback;
    }
  }
  const v = sqliteLoad(keyFromPath(file));
  return v != null ? v : fallback;
}

export function saveFileOrStore(file, data) {
  if (!SQLITE_AVAILABLE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    return;
  }
  sqlitePersistSync(keyFromPath(file), data);
}

/** Import all existing JSON files under a directory into sqlite (idempotent, recursive). */
export function migrateDir(dir = DATA_DIR, { overwrite = false } = {}) {
  if (!SQLITE_AVAILABLE) return { imported: 0, skipped: 0 };
  if (!fs.existsSync(dir)) return { imported: 0, skipped: 0 };
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO docs (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const hasRow = db.prepare('SELECT 1 FROM docs WHERE key = ?');
  let imported = 0;
  let skipped = 0;
  const files = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (name.endsWith('.json')) {
        files.push(full);
      }
    }
  })(dir);
  for (const file of files) {
    const key = keyFromPath(file);
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      if (!overwrite && hasRow.get(key)) {
        skipped += 1;
        continue;
      }
      const existing = db.prepare('SELECT value FROM docs WHERE key = ?').get(key);
      if (existing && existing.value === raw) {
        skipped += 1;
        continue;
      }
      upsert.run(key, raw, Date.now());
      imported += 1;
    } catch (err) {
      console.error(`[sqlite] migrate ${key}: ${err.message}`);
    }
  }
  return { imported, skipped };
}

/** Total rows currently stored in sqlite. */
export function docCount() {
  const db = getDb();
  if (!db) return 0;
  const row = db.prepare('SELECT COUNT(*) AS n FROM docs').get();
  return row?.n ?? 0;
}

/**
 * Which store is actually in force, and why (backlog item 15).
 * Surfaced on /api/ops/status and logged once at boot so an operator never has
 * to infer the persistence backend from the Node version.
 */
export function describeBackend() {
  const active = SQLITE_AVAILABLE && getDb() != null ? 'sqlite' : 'json';
  return {
    backend: active,
    preference: BACKEND_PREFERENCE,
    moduleAvailable: MODULE_AVAILABLE,
    nodeVersion: process.version,
    dataDir: DATA_DIR,
    dbPath: active === 'sqlite' ? DB_PATH : null,
    docCount: active === 'sqlite' ? docCount() : null,
    reason:
      active === 'sqlite'
        ? BACKEND_PREFERENCE === 'on'
          ? 'ZINGER_SQLITE=1 (explicitly required)'
          : 'node:sqlite available'
        : BACKEND_PREFERENCE === 'off'
          ? 'ZINGER_SQLITE=0 (explicitly disabled) — writing JSON files'
          : `node:sqlite unavailable on Node ${process.version} — writing JSON files`,
  };
}
