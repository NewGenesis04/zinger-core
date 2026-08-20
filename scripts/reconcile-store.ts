#!/usr/bin/env node
// @ts-nocheck
/**
 * Item 14 cleanup — reconcile `session_perf`, then stop the JSON files
 * shadowing the store.
 *
 * This is NOT the D9 archive. D9 (archive everything, start empty) belongs to
 * slice 3, when the new lifecycle lands — see the D9 note in the plan. This
 * script only removes the *ambiguity* about which copy of state is real, which
 * is the part that gates D8.
 *
 * Two jobs:
 *   1. `session_perf.json` — where the disk copy is newer than its row.
 *      `migrateDir()` skips keys that already have a row
 *      (`sqliteStore.ts`), so this cannot self-heal. Union-merged by session
 *      id; nothing is dropped from either side.
 *   2. Every other top-level `.json` that has been migrated is moved to
 *      `data/migrated/<timestamp>/`. Moved, never deleted.
 *
 * Safety:
 *   - dry run by default; `--apply` is required to change anything
 *   - `zinger.db` is copied to `data/backups/` before any write
 *   - `data/ml/**` is left alone — Python writes those directly (item 17)
 *   - a file with no corresponding row is left alone and reported
 *
 * Usage:
 *   npx tsx scripts/reconcile-store.ts                        # dry run
 *   npx tsx scripts/reconcile-store.ts --apply
 *   ZINGER_DATA_DIR=/srv/zinger/data npx tsx scripts/reconcile-store.ts --apply
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { getDataDir } from '../src/polymarket/dataDir.js';

const require = createRequire(import.meta.url);
const APPLY = process.argv.includes('--apply');
const DATA_DIR = getDataDir();
const DB_PATH = process.env.ZINGER_DB_PATH
  ? path.resolve(process.env.ZINGER_DB_PATH)
  : path.join(DATA_DIR, 'zinger.db');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const say = (s = '') => console.log(s);

say(`\nZinger store reconciliation — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
say(`  data dir : ${DATA_DIR}`);
say(`  database : ${DB_PATH}\n`);

if (!fs.existsSync(DB_PATH)) {
  say('No zinger.db at that path — nothing to reconcile against. Aborting.');
  process.exit(1);
}

const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(DB_PATH, { readOnly: !APPLY });

const rowOf = (key) => {
  const r = db.prepare('SELECT value FROM docs WHERE key = ?').get(key);
  if (!r) return null;
  try {
    return JSON.parse(r.value);
  } catch {
    return null;
  }
};

// ------------------------------------------------- backup before any write

if (APPLY) {
  const backupDir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, `zinger-${STAMP}.db`);
  // Use sqlite's own backup so a concurrent writer can't tear the copy.
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch {
    fs.copyFileSync(DB_PATH, dest);
  }
  say(`✅ database backed up → ${path.relative(DATA_DIR, dest)}\n`);
}

// ------------------------------------------------- 1. session_perf reconcile

{
  const KEY = 'session_perf.json';
  const file = path.join(DATA_DIR, KEY);
  const row = rowOf(KEY);
  const disk = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;

  const listOf = (v) => (Array.isArray(v) ? v : Array.isArray(v?.sessions) ? v.sessions : null);
  const rowList = listOf(row);
  const diskList = listOf(disk);

  say('1. session_perf');
  if (!diskList) {
    say('   no session_perf.json on disk — nothing to reconcile\n');
  } else if (!rowList) {
    say('   no session_perf row in the store — the file will be imported as-is\n');
  } else {
    const byId = new Map();
    // Row first, then disk: identical ids keep one copy, disk-only ids append.
    for (const s of rowList) byId.set(s.id ?? JSON.stringify(s), s);
    let addedFromDisk = 0;
    for (const s of diskList) {
      const k = s.id ?? JSON.stringify(s);
      if (!byId.has(k)) {
        byId.set(k, s);
        addedFromDisk += 1;
      }
    }
    const onlyInRow = rowList.filter(
      (s) => !diskList.some((d) => (d.id ?? JSON.stringify(d)) === (s.id ?? JSON.stringify(s))),
    ).length;

    say(`   store row : ${rowList.length} sessions`);
    say(`   disk file : ${diskList.length} sessions`);
    say(`   union     : ${byId.size} sessions  (+${addedFromDisk} recovered from disk, ${onlyInRow} store-only preserved)`);

    if (byId.size === rowList.length) {
      say('   store already contains everything — no change needed\n');
    } else {
      const merged = Array.isArray(row)
        ? [...byId.values()]
        : { ...row, sessions: [...byId.values()], updatedAt: Date.now() };
      if (APPLY) {
        db.prepare(
          'INSERT INTO docs (key, value, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        ).run(KEY, JSON.stringify(merged), Date.now());
        say(`   ✅ store updated to ${byId.size} sessions\n`);
      } else {
        say(`   would update the store to ${byId.size} sessions\n`);
      }
    }
  }
}

// ------------------------------------ 2. move migrated JSON out of the way

{
  say('2. unshadow the store');
  const entries = fs
    .readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name);

  const movable = [];
  const skipped = [];
  for (const name of entries) {
    const row = db.prepare('SELECT length(value) AS n FROM docs WHERE key = ?').get(name);
    if (!row) {
      skipped.push({ name, why: 'no row in the store — this file IS the only copy' });
      continue;
    }
    movable.push(name);
  }

  if (skipped.length) {
    say('   left in place:');
    for (const s of skipped) say(`     ⚠️  ${s.name} — ${s.why}`);
  }
  say(`   (data/ml/** is untouched — Python writes those directly, item 17)`);

  if (!movable.length) {
    say('   nothing to move — the data dir already has one representation of state\n');
  } else {
    const dest = path.join(DATA_DIR, 'migrated', STAMP);
    say(`   ${movable.length} migrated file(s) → data/migrated/${STAMP}/`);
    for (const name of movable) {
      const note = name === 'wallet.json' ? '   ← hot key; kept, not deleted' : '';
      say(`     ${APPLY ? 'moved' : 'would move'}  ${name}${note}`);
    }
    if (APPLY) {
      fs.mkdirSync(dest, { recursive: true });
      for (const name of movable) {
        fs.renameSync(path.join(DATA_DIR, name), path.join(dest, name));
      }
      fs.writeFileSync(
        path.join(dest, 'README.txt'),
        'Migrated-away JSON stores (backlog item 14).\n\n' +
          'These were imported into zinger.db and are kept only as a rollback copy.\n' +
          'They are NOT read by the bot on Node 22+. Do not edit them expecting an\n' +
          'effect — edit the store instead. Safe to delete once the db is trusted.\n' +
          `Moved ${new Date().toISOString()}\n`,
      );
      say(`   ✅ moved, with a README explaining what they are\n`);
    } else {
      say('');
    }
  }
}

// ------------------------------------------------------------- verification

if (APPLY) {
  const remaining = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  say('verification:');
  say(`  top-level .json remaining in data/: ${remaining.length}${remaining.length ? ' — ' + remaining.join(', ') : ''}`);
  const n = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
  say(`  docs rows in store: ${n}`);
  say('\nRun `npx tsx scripts/audit-store.ts` to confirm the shadowing findings clear.\n');
} else {
  say('Dry run — nothing was changed. Re-run with --apply to perform the above.\n');
}
