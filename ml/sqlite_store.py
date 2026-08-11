"""
Shared SQLite store for the ML pipeline.

Zinger Core persists ALL data in a single SQLite database (data/zinger.db)
with a docs table keyed by the JSON store's path relative to the data dir.
The Node app writes via src/polymarket/sqliteStore.js; Python scripts must
write through the same table so the two sides stay in sync.

Usage:
    from sqlite_store import store_save, store_load
    store_save('ml/models/onnx/manifest.json', results)
    rows = store_load('ml/models/onnx/manifest.json', [])
"""
import json
import os
import sqlite3

_ML_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_ML_DIR)
_DATA_DIR = os.environ.get('ZINGER_DATA_DIR', os.path.join(_ROOT, 'data'))
_DB_PATH = os.environ.get('ZINGER_DB_PATH', os.path.join(_DATA_DIR, 'zinger.db'))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
"""


def _connect():
    os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
    conn = sqlite3.connect(_DB_PATH)
    conn.execute('PRAGMA journal_mode = WAL;')
    conn.execute('PRAGMA synchronous = NORMAL;')
    conn.execute(_SCHEMA)
    return conn


def store_save(key, data):
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO docs (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (key, json.dumps(data, default=str), int(os.path.getmtime(_DB_PATH)) if os.path.exists(_DB_PATH) else int(__import__('time').time() * 1000)),
        )
        conn.commit()
    finally:
        conn.close()


def store_load(key, fallback=None):
    conn = _connect()
    try:
        row = conn.execute('SELECT value FROM docs WHERE key = ?', (key,)).fetchone()
        if not row:
            return fallback
        return json.loads(row[0])
    finally:
        conn.close()


def store_delete(key):
    conn = _connect()
    try:
        conn.execute('DELETE FROM docs WHERE key = ?', (key,))
        conn.commit()
    finally:
        conn.close()


def doc_count():
    conn = _connect()
    try:
        row = conn.execute('SELECT COUNT(*) AS n FROM docs').fetchone()
        return row[0] if row else 0
    finally:
        conn.close()
