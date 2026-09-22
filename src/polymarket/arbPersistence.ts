// @ts-nocheck
import fs from 'fs';
import { load, persistSync, FILES } from './persistence.js';
import { parseSlugWindow } from './windows.js';

export interface ArbLegInfo {
  outcome: 'up' | 'down';
  tokenId: string | null;
  entryPrice: number;
  cost: number;
  shares: number;
  filled: boolean;
  orderId?: string | null;
  /**
   * Item 79 diagnostics. Twenty-one live packages aborted across three days and
   * every one recorded the same generic `Leg execution mismatch` — the venue's
   * actual answer was captured in the receipt log and never reached the record
   * anyone reads. These fields exist so the next failure explains itself
   * instead of generating a fourth theory.
   */
  /** The venue's own rejection text, as close to raw as it reaches us. */
  error?: string | null;
  /** Milliseconds between the book snapshot this leg was sized from and dispatch. */
  bookAgeMs?: number | null;
  /** Which book fed the sizing gate — `clob-ws` or a REST fallback. */
  bookSource?: string | null;
  /** When the order was dispatched, so age can be recomputed against anything later. */
  submittedAt?: number | null;
  /** What the sizing gate asked for, before the venue's own rounding. */
  requestedShares?: number | null;
  /** The price bound this leg was signed at. Differs from `entryPrice` on leg 2 (item 97). */
  signedPrice?: number | null;
  /** Item 105: what the leg actually cost, copied from the position's `fill`. */
  fill?: {
    shares: number;
    costUsd: number;
    avgPrice: number;
    feeUsd: number;
    priceSource: string;
  } | null;
  /** Item 109: dispatch to response, in ms, as seen by the engine. */
  transitMs?: number | null;
  /** Item 109: the book before dispatch and just after a refusal, and what that implies. */
  kill?: {
    before: { bestAsk: number | null; bestAskSize: number | null } | null;
    after: { bestAsk: number; bestAskSize: number; bestBid: number | null; bookTs: number | null; ageMs: number | null; stale: boolean } | null;
    cause: string;
  } | null;
  /** Item 80: how an unconfirmed leg was resolved, if it had to be. */
  reconcile?: { outcome: string; door: string | null; probes: number } | null;
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
  /** The pre-execution figure, from scan quotes. Kept for slippage measurement (item 105). */
  plannedProfitUsd?: number;
  /** Whether `lockedProfitUsd` comes from the fills or still from the plan. */
  profitSource?: 'plan' | 'fills';
  /** Both legs' actual spend, excluding fees. Set when `profitSource` is 'fills'. */
  entryCostUsd?: number;
  /** Both legs' taker fees, charged on top of `entryCostUsd` (domain facts §10e). */
  entryFeesUsd?: number;
  /** `plannedProfitUsd − lockedProfitUsd`: what execution cost against the quote. */
  slippageUsd?: number;
  /** What the package realized, written when it settles (item 105). */
  realizedPnlUsd?: number;
  /** Per-leg payout when both legs closed by resolution. */
  payout?: { up: number; down: number };
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
  /**
   * Shares held on one side beyond the matched pair. Only `shares` of each leg
   * form complementary sets that redeem to $1.00; this remainder is unhedged
   * directional exposure and is recorded so it cannot go unnoticed. Absent on a
   * clean package, which is the normal case — both entry legs are fill-or-kill,
   * so a partial cannot arise.
   */
  residualShares?: number;
  /** Which side carries `residualShares`. */
  residualOutcome?: 'up' | 'down';
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

/**
 * The packages that hold an arb slot at `now` (decision D-B).
 *
 * PENDING_FILL always does, because its legs are in flight. LOCKED does until
 * its window ends. After that its payout can no longer move, so it is waiting
 * on bookkeeping rather than holding exposure. SETTLED is bookkeeping only.
 *
 * Only the capacity gate uses this. `getActivePackages` keeps its meaning for
 * everything else, including the one-package-per-slug check. A slug that does
 * not parse keeps its slot.
 */
export function getSlotHoldingPackages(mode: string = 'paper', now: number = Date.now()): ArbPackage[] {
  return loadPackages().filter((p) => {
    if (p.mode !== mode) return false;
    if (p.status === 'PENDING_FILL') return true;
    if (p.status !== 'LOCKED') return false;
    const end = parseSlugWindow(p.slug)?.endAtMs;
    return end == null || now < end;
  });
}

export function resetPackages(mode?: string): { removed: number } {
  const current = loadPackages();
  const keep = mode ? current.filter((p) => p.mode !== mode) : [];
  const removed = current.length - keep.length;
  saveAllPackages(keep);
  return { removed };
}
