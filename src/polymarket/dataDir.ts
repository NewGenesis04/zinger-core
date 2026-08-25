// @ts-nocheck
/**
 * The one place that decides where Zinger's data directory is.
 *
 * Every store path in the repo must be built from `getDataDir()` or
 * `dataPath()`. No module derives its own — that is backlog item 16, and it is
 * what makes `ZINGER_DATA_DIR` (and therefore test isolation, item 12)
 * trustworthy.
 *
 * This module deliberately imports nothing from the codebase, so it can be
 * pulled in from any layer — store, engine, lib, telegram — without a cycle.
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_DATA_DIR = path.resolve(import.meta.dirname, '../../data');

const DATA_DIR = process.env.ZINGER_DATA_DIR
  ? path.resolve(process.env.ZINGER_DATA_DIR)
  : DEFAULT_DATA_DIR;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Absolute path to the active data directory. */
export function getDataDir() {
  return DATA_DIR;
}

/** Absolute path to `name` inside the active data directory. */
export function dataPath(name) {
  return path.join(DATA_DIR, name);
}

/** True when the data directory came from ZINGER_DATA_DIR rather than the default. */
export function dataDirIsOverridden() {
  return DATA_DIR !== DEFAULT_DATA_DIR;
}
