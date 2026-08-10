// @ts-nocheck
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
  lockedProfitUsd: number;
  lockedProfitPct: number;
  status: 'PENDING_FILL' | 'LOCKED' | 'SETTLED' | 'ABORTED';
  mode: 'paper' | 'live';
  createdAt: number;
  settledAt?: number;
  unwoundAt?: number;
  abortReason?: string;
  legs: {
    up: ArbLegInfo;
    down: ArbLegInfo;
  };
}

let packageMemoryCache: ArbPackage[] | null = null;

export function loadPackages(): ArbPackage[] {
  if (packageMemoryCache) return packageMemoryCache;
  const raw = load(FILES.PACKAGES, []);
  packageMemoryCache = Array.isArray(raw) ? raw : [];
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
