// @ts-nocheck
import path from 'path';
import {
  SQLITE_AVAILABLE,
  loadFileOrStore,
  saveFileOrStore,
  getDb,
  migrateDir,
  describeBackend,
} from './sqliteStore.js';

export { describeBackend } from './sqliteStore.js';
import { getDataDir } from './dataDir.js';

// `dataDir.ts` owns where the data directory is; re-exported here so existing
// callers of persistence.ts keep working (backlog item 16).
export { getDataDir, dataPath } from './dataDir.js';

const DATA_DIR = getDataDir();

export function persist(file, data) {
  saveFileOrStore(file, data);
}

export function persistSync(file, data) {
  saveFileOrStore(file, data);
}

export function load(file, fallback = null) {
  return loadFileOrStore(file, fallback);
}

export function loadWithDefault(file, defaults) {
  const existing = load(file, null);
  if (existing) return existing;
  persistSync(file, defaults);
  return defaults;
}

export function migrateLegacyStores() {
  if (!SQLITE_AVAILABLE) return { imported: 0, skipped: 0 };
  return migrateDir(DATA_DIR);
}

export function sqliteEnabled() {
  return SQLITE_AVAILABLE && getDb() != null;
}

export const FILES = {
  CONFIG: path.join(DATA_DIR, 'poly_config.json'),
  TRADES: path.join(DATA_DIR, 'poly_trades.json'),
  POSITIONS: path.join(DATA_DIR, 'poly_positions.json'),
  ACTIONS: path.join(DATA_DIR, 'poly_actions.json'),
  PACKAGES: path.join(DATA_DIR, 'poly_packages.json'),
};

