import { savePackage, loadPackages, getActivePackages } from './arbPersistence.js';
import type { ArbPackage } from './arbPersistence.js';

export type { ArbPackage };
export { getActivePackages, loadPackages };

/**
 * Detects an orderbook gap and executes an atomic ArbPackage.
 * Completely bypasses directional signals, indicator filters, ML overlays, and ATR stop-losses.
 */
export async function detectAndExecuteArbPackage({
  market,
  depth,
  prices,
  cfg,
  mode = 'paper',
  readiness,
  log,
  executeTrade,
  adjustPaperCash,
  saveTrade,
  botState,
}) {
  if (cfg.clobArbEnabled === false) return null;

  const upAsk = Number(depth?.up?.bestAsk || prices?.up || 0);
  const downAsk = Number(depth?.down?.bestAsk || prices?.down || 0);
  if (!(upAsk > 0.01 && downAsk > 0.01 && upAsk < 0.99 && downAsk < 0.99)) return null;

  const sum = upAsk + downAsk;
  const gap = 1 - sum;
  const minGap = Number(cfg.minArbGap ?? 0.015);
  if (gap < minGap) return null;

  // Capacity check against dedicated maxArbPackages setting
  const activePkgs = getActivePackages(mode);
  const maxPkgs = Number(cfg.maxArbPackages ?? 4);
  if (activePkgs.length >= maxPkgs) return null;

  // Verify no active package on this market slug
  if (activePkgs.some((p) => p.slug === market.slug)) return null;

  // Bankroll allocation
  const arbBank = mode === 'paper'
    ? Number(cfg.paperBankroll ?? 0)
    : Number(readiness?.spendableBalance ?? readiness?.clobBalance ?? 0);

  const shareBudget = Math.max(
    Number(cfg.minPositionSize ?? 0.5) * 2,
    Math.min(
      arbBank * Number(cfg.arbBankrollFrac ?? 0.10),
      Number(cfg.arbMaxUsd ?? 50),
    ),
  );

  const shares = Math.max(0.5, Math.round((shareBudget / sum) * 1000) / 1000);
  const costUp = Math.round(shares * upAsk * 100) / 100;
  const costDown = Math.round(shares * downAsk * 100) / 100;
  const totalCost = Math.round((costUp + costDown) * 100) / 100;

  if (mode === 'paper' && Number(cfg.paperBankroll ?? 0) < totalCost + 0.01) {
    return null;
  }

  const packageId = `pkg-${market.symbol.toLowerCase()}-${Date.now().toString(36)}`;
  const expectedPayout = Math.round(shares * 1.00 * 100) / 100;
  const lockedProfitUsd = Math.round((expectedPayout - totalCost) * 100) / 100;
  const lockedProfitPct = Math.round((lockedProfitUsd / totalCost) * 10000) / 100;

  const pkg: ArbPackage = {
    packageId,
    symbol: market.symbol,
    slug: market.slug,
    windowKey: market.windowKey || `slug-${market.slug}`,
    shares,
    upCost: costUp,
    downCost: costDown,
    totalCost,
    expectedPayout,
    lockedProfitUsd,
    lockedProfitPct,
    status: 'PENDING_FILL',
    mode,
    createdAt: Date.now(),
    legs: {
      up: { outcome: 'up', tokenId: market.tokenIds?.up || null, entryPrice: upAsk, cost: costUp, shares, filled: false },
      down: { outcome: 'down', tokenId: market.tokenIds?.down || null, entryPrice: downAsk, cost: costDown, shares, filled: false },
    },
  };

  savePackage(pkg);

  // Execution: Dispatch both legs concurrently
  try {
    const results = await Promise.allSettled([
      executeArbLeg({ outcome: 'up', price: upAsk, cost: costUp, shares, pkg, market, cfg, mode, executeTrade, botState }),
      executeArbLeg({ outcome: 'down', price: downAsk, cost: costDown, shares, pkg, market, cfg, mode, executeTrade, botState }),
    ]);

    const upRes = results[0];
    const downRes = results[1];

    const upSuccess = upRes.status === 'fulfilled' && upRes.value;
    const downSuccess = downRes.status === 'fulfilled' && downRes.value;

    if (upSuccess && downSuccess) {
      pkg.legs.up.filled = true;
      pkg.legs.down.filled = true;
      pkg.status = 'LOCKED';
      savePackage(pkg);

      if (log) {
        log(
          `📦 ATOMIC ARB PACKAGE LOCKED ${market.symbol} UP@$${upAsk.toFixed(3)} + DN@$${downAsk.toFixed(3)} = $${sum.toFixed(3)} · Net +$${lockedProfitUsd.toFixed(2)} (+${lockedProfitPct.toFixed(1)}%) · ${shares} sh/leg`,
          'buy',
          { packageId, slug: market.slug, totalCost, expectedPayout, lockedProfitUsd, lockedProfitPct },
        );
      }
      return pkg;
    }

    // Emergency Rollback Handler if one leg failed
    pkg.status = 'ABORTED';
    pkg.unwoundAt = Date.now();
    pkg.abortReason = `Leg execution mismatch: UP=${upSuccess ? 'OK' : 'FAIL'}, DOWN=${downSuccess ? 'OK' : 'FAIL'}`;

    if (upSuccess && !downSuccess) {
      await unwindLeg({ outcome: 'up', pkg, market, mode, botState, log, adjustPaperCash });
    } else if (downSuccess && !upSuccess) {
      await unwindLeg({ outcome: 'down', pkg, market, mode, botState, log, adjustPaperCash });
    }

    savePackage(pkg);
    if (log) {
      log(`⚠️ ABORTED ARB PACKAGE ${market.symbol} (${pkg.abortReason}) — emergency unwound filled leg`, 'sl', { packageId, slug: market.slug });
    }
    return pkg;
  } catch (err) {
    pkg.status = 'ABORTED';
    pkg.abortReason = err.message;
    savePackage(pkg);
    if (log) log(`⚠️ ABORTED ARB PACKAGE ${market.symbol} error: ${err.message}`, 'error');
    return pkg;
  }
}

async function executeArbLeg({ outcome, price, cost, shares, pkg, market, cfg, mode, executeTrade, botState }) {
  const plan = {
    symbol: market.symbol,
    slug: market.slug,
    outcome,
    price,
    entryPrice: price,
    shares,
    costEst: cost,
    sizeUsd: cost,
    packageId: pkg.packageId,
    isArbLeg: true,
    holdToSettle: true,
    adaptiveSlEnabled: false,
    slPct: 999,
    targetTp: 999,
    partialTpPct: 999,
    trailActivatePct: 999,
  };

  const pending = {
    id: `${pkg.packageId}-${outcome}`,
    status: 'pending',
    symbol: market.symbol,
    slug: market.slug,
    outcome,
    tokenId: market.tokenIds?.[outcome] || null,
    negRisk: !!market.negRisk,
    tickSize: market.tickSize || '0.01',
    minShares: 1,
    plan,
  };

  const prevMax = botState.config.maxConcurrentPerSlug;
  botState.config.maxConcurrentPerSlug = 2;

  try {
    const res = await executeTrade(pending);
    botState.config.maxConcurrentPerSlug = prevMax;
    return !!res;
  } catch (err) {
    botState.config.maxConcurrentPerSlug = prevMax;
    throw err;
  }
}

async function unwindLeg({ outcome, pkg, market, mode, botState, log, adjustPaperCash }) {
  const pos = botState.positions.find((p) => p.packageId === pkg.packageId && p.outcome === outcome && !p.closed);
  if (!pos) return;

  pos.closed = true;
  pos.exitPrice = pos.entryPrice;
  pos.exitReason = 'arb_rollback';
  pos.pnl = 0;

  if (mode === 'paper') {
    const refund = Math.round((Number(pos.costBasis || (pos.shares * pos.entryPrice)) + Number(pos.entryFee || 0)) * 100) / 100;
    if (adjustPaperCash) {
      adjustPaperCash(refund, `ROLLBACK ${pos.symbol} ${outcome.toUpperCase()}`);
    } else {
      // Fallback if not injected directly
      const bot = await import('./bot.js').catch(() => ({ adjustPaperCash: () => {} }));
      if (bot.adjustPaperCash) bot.adjustPaperCash(refund, `ROLLBACK ${pos.symbol} ${outcome.toUpperCase()}`);
    }
  }

  if (log) {
    log(`🔄 ROLLBACK UNWIND ${pos.symbol} ${outcome.toUpperCase()} · refunded $${pos.costBasis}`, 'system', { packageId: pkg.packageId });
  }
}

/**
 * Scans active packages and transitions settled ones on market window completion.
 */
export function syncPackageSettlements(trades = [], mode = 'paper') {
  const packages = loadPackages().filter((p) => p.mode === mode && p.status === 'LOCKED');
  let updated = false;

  for (const pkg of packages) {
    const pkgTrades = trades.filter((t) => t.packageId === pkg.packageId && t.closed);
    if (pkgTrades.length >= 2) {
      pkg.status = 'SETTLED';
      pkg.settledAt = Date.now();
      savePackage(pkg);
      updated = true;
    }
  }

  return updated;
}

/**
 * Computes package-level metrics for dashboard header KPI card.
 */
export function getArbPackageMetrics(mode = 'paper') {
  const all = loadPackages().filter((p) => p.mode === mode);
  const settled = all.filter((p) => p.status === 'SETTLED');
  const locked = all.filter((p) => p.status === 'LOCKED');
  const aborted = all.filter((p) => p.status === 'ABORTED');

  const concludedCount = settled.length + aborted.length;
  const netProfitUsd = settled.reduce((sum, p) => sum + Number(p.lockedProfitUsd || 0), 0);
  const winCount = settled.length;
  const winRatePct = concludedCount > 0 ? Math.round((winCount / concludedCount) * 1000) / 10 : 100;

  return {
    totalPackages: all.length,
    activeLocked: locked.length,
    settledCount: settled.length,
    abortedCount: aborted.length,
    concludedCount,
    winCount,
    winRatePct,
    netProfitUsd: Math.round(netProfitUsd * 100) / 100,
  };
}
