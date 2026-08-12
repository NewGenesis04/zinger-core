// @ts-nocheck
import fs from 'fs';
import path from 'path';
import {
  SQLITE_AVAILABLE,
  loadFileOrStore,
  saveFileOrStore,
  getDb,
  migrateDir,
} from './sqliteStore.js';

const DEFAULT_DATA_DIR = path.resolve(import.meta.dirname, '../../data');
const DATA_DIR = process.env.ZINGER_DATA_DIR
  ? path.resolve(process.env.ZINGER_DATA_DIR)
  : DEFAULT_DATA_DIR;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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

export function dataPath(name) {
  return path.join(DATA_DIR, name);
}

export function getDataDir() {
  return DATA_DIR;
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

