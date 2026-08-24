// @ts-nocheck
import {
  evaluateCycleBoundary,
  prunePendingTrades,
  updateBotTradeStats,
  formatRemainingMs,
} from './cycle.js';
import {
  collectSignals,
  enrichMarketsWithOracle,
} from './inputs.js';
import { settlePaperOrphans } from './exits.js';

/**
 * Lean sequential scan orchestrator (~80 lines of control flow).
 * Calls the phase modules in strict sequence (D10).
 */
export async function executeScanCycle({
  botState,
  log,
  logScan,
  saveState,
  notifyStateChange,
  refreshTelemetry,
  getSignalForBoth,
  getMLSignalForBoth,
  addMLPrediction,
  getConfidenceBias,
  findMarkets,
  resolveMarketDurations,
  fetchPriceToBeat,
  buildDataAssurance,
  getPricesForMarket,
  getDepthForMarket,
  recordChartTick,
  detectAndExecuteArbPackage,
  buildDecision,
  executeTrade,
  executeSell,
  scanOpenExitsFast,
  processMarketExitsAndEntries,
  buildPortfolio,
  recordCycleSession,
  stopBot,
  optimizeNow,
  arbHousekeeping,
}) {
  const cfg = botState?.config;
  if (!cfg?.enabled) return;
  if (botState._scanning) {
    if (typeof scanOpenExitsFast === 'function') {
      await scanOpenExitsFast().catch(() => {});
    }
    return;
  }
  botState._scanning = true;

  try {
    // 1. Housekeeping & window cycle boundaries
    evaluateCycleBoundary({
      botState,
      buildPortfolio,
      recordCycleSession,
      log,
      stopBot,
      optimizeNow,
      notifyStateChange,
    });
    prunePendingTrades(botState);
    if (typeof arbHousekeeping === 'function') {
      await arbHousekeeping('scan');
    }
    botState.stats = botState.stats || {};
    botState.stats.scansDone = (botState.stats.scansDone || 0) + 1;
    const readiness = typeof refreshTelemetry === 'function'
      ? await refreshTelemetry()
      : null;

    // 2. Refresh signals & market inputs
    await collectSignals({
      cfg,
      botState,
      getSignalForBoth,
      getMLSignalForBoth,
      addMLPrediction,
      getConfidenceBias,
      log,
    });

    const { markets = [], diagnostics = [] } = typeof findMarkets === 'function'
      ? await findMarkets(resolveMarketDurations(cfg))
      : { markets: [], diagnostics: [] };
    botState.diagnostics = diagnostics;

    const tradableMarkets = cfg.tradeCurrentWindowOnly
      ? markets.filter((market) => market.isCurrent)
      : markets;

    if (markets.length === 0) {
      if (typeof log === 'function') log(`🧯 Discovery miss — 0 BTC/ETH markets`, 'error', { diagnostics });
    } else if (diagnostics.length > 0 && typeof log === 'function') {
      log(`🧭 Discovery partial — ${markets.length} live · ${diagnostics.length} missing`, 'scan', { diagnostics });
    }

    // 3. Open paper orphans settlement (runs early, doesn't block on CLOB depth)
    await settlePaperOrphans(botState.positions, { executeSell, log });

    // 4. Enrich markets with Price-to-Beat
    await enrichMarketsWithOracle(tradableMarkets, { fetchPriceToBeat, timeoutMs: 3500 });

    // 5. Data assurance quality check
    if (typeof buildDataAssurance === 'function') {
      const signalTs = Math.max(
        Number(botState.signals?.btc?.timestamp || 0),
        Number(botState.signals?.eth?.timestamp || 0),
      );
      botState._dataAssurance = buildDataAssurance({
        spotPrices: botState.spotPrices,
        signals: botState.signals,
        feed: { status: signalTs ? 'live' : 'stale', lastSignalAt: signalTs || null },
        markets: tradableMarkets.map((m) => ({
          symbol: m.symbol,
          slug: m.slug,
          isCurrent: m.isCurrent,
          prices: m.gammaPrices || {},
          priceToBeat: m.priceToBeat,
          eventStartTime: m.eventStartTime,
          endTime: m.endTime,
        })),
        positions: botState.positions,
        cashAudit: {
          ok: true,
          cash: botState.config?.paperBankroll,
          equity: botState.config?.paperBankroll,
          issues: [],
        },
        lastScan: botState.lastScan,
        botRunning: true,
      });
      if (!botState._dataAssurance.canBuy && cfg.requireDataAssurance !== false && typeof log === 'function') {
        log(`🛡️ DATA GATE · ${botState._dataAssurance.note}`, 'scan', {
          score: botState._dataAssurance.score,
          blocking: botState._dataAssurance.blocking,
        });
      }
    }

    // 6. Market loop: process exits, arb checks, and directional entries
    const enriched = [];
    if (typeof processMarketExitsAndEntries === 'function') {
      const results = await processMarketExitsAndEntries({
        tradableMarkets,
        readiness,
        cfg,
        botState,
      });
      if (Array.isArray(results)) {
        enriched.push(...results);
      }
    }

    // 7. Cycle finalization & reporting
    updateBotTradeStats(botState);
    if (typeof saveState === 'function') saveState();

    const buyCount = enriched.filter((market) => market.action === 'buy').length;
    if (typeof logScan === 'function') {
      logScan(
        `🔎 Scan #${botState.stats.scansDone} — ${enriched.length} mkts · ${buyCount} buy signals · cycle ${formatRemainingMs()}`,
        {
          scan: botState.stats.scansDone,
          markets: enriched.map((market) => ({
            symbol: market.symbol,
            slug: market.slug,
            action: market.action,
            summary: market.decision?.summary,
            remaining: market.remaining,
          })),
        },
      );
    }
  } catch (err) {
    if (typeof log === 'function') {
      log(`⚠️ Scan error: ${err.message}`, 'error');
    }
  } finally {
    botState._scanning = false;
  }
}
