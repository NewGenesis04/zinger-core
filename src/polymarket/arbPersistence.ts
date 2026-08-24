// @ts-nocheck
import fs from 'fs';
import { load, persistSync, FILES } from './persistence.js';

export interface ArbLegInfo {
  outcome: 'up' | 'down';
  tokenId: string | null;
  entryPrice: number;
  cost: number;
  shares: number;
  filled: boolean;
  orderId?: string | null;
}

export interface ArbPackage {
  packageId: string;
  symbol: string;
  slug: string;
  windowKey: string;
  shares: number;
  upCost: number;
  downCost: number;
  totalCost: number;
  expectedPayout: number;
  /** Net of both entry taker fees. Was gross until backlog item 7. */
  lockedProfitUsd: number;
  lockedProfitPct: number;
  /** The two entry fees this package expects to pay. */
  feesEstUsd?: number;
  /** Gap at which this book would exactly break even — rate x [u(1-u)^e + d(1-d)^e]. */
  breakEvenGap?: number;
  /** The book gap actually taken, so the margin over break-even is auditable. */
  gap?: number;
  status: 'PENDING_FILL' | 'LOCKED' | 'SETTLED' | 'MERGED' | 'ABORTED';
  mode: 'paper' | 'live';
  createdAt: number;
  settledAt?: number;
  mergedAt?: number;
  mergeTxHash?: string;
  unwoundAt?: number;
  abortReason?: string;
  legs: {
    up: ArbLegInfo;
    down: ArbLegInfo;
  };
}

let packageMemoryCache: ArbPackage[] | null = null;
let cacheFileState = 0;

// Cheap staleness check so the in-memory cache still picks up external writes
// (e.g. a second instance sharing the data dir) without a full read each tick.
function fileState(): number {
  try {
    const st = fs.statSync(FILES.PACKAGES);
    return st.mtimeMs + st.size;
  } catch {
    return -1;
  }
}

export function loadPackages(): ArbPackage[] {
  const state = fileState();
  if (packageMemoryCache && state === cacheFileState) return packageMemoryCache;
  const raw = load(FILES.PACKAGES, []);
  packageMemoryCache = Array.isArray(raw) ? raw : [];
  cacheFileState = state;
  return packageMemoryCache;
}

export function savePackage(pkg: ArbPackage): ArbPackage {
  const list = loadPackages();
  const index = list.findIndex((p) => p.packageId === pkg.packageId);
  if (index >= 0) {
    list[index] = pkg;
  } else {
    list.push(pkg);
  }
  packageMemoryCache = list;
  persistSync(FILES.PACKAGES, list);
  return pkg;
}

export function saveAllPackages(packages: ArbPackage[]): void {
  packageMemoryCache = packages;
  persistSync(FILES.PACKAGES, packages);
}

export function getActivePackages(mode: string = 'paper'): ArbPackage[] {
  return loadPackages().filter((p) => p.mode === mode && (p.status === 'LOCKED' || p.status === 'PENDING_FILL'));
}

export function resetPackages(mode?: string): { removed: number } {
  const current = loadPackages();
  const keep = mode ? current.filter((p) => p.mode !== mode) : [];
  const removed = current.length - keep.length;
  saveAllPackages(keep);
  return { removed };
}
