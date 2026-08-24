// @ts-nocheck
import { POLY_WINDOW_SECONDS } from '../config.js';
import { currentWallWindow, computeWindowStats } from '../windows.js';

export function formatRemainingMs(nowMs = Date.now(), windowSec = POLY_WINDOW_SECONDS): string {
  const wall = currentWallWindow(windowSec, nowMs);
  const rem = Math.max(0, Math.floor(wall.remainingMs / 1000));
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function prunePendingTrades(botState, timeoutMs = 45_000): { pruned: number } {
  if (!botState || !Array.isArray(botState.pendingTrades)) return { pruned: 0 };
  const now = Date.now();
  const initial = botState.pendingTrades.length;
  botState.pendingTrades = botState.pendingTrades.filter((t) => {
    if (t.status === 'executed' || t.status === 'rejected' || t.status === 'cancelled') return false;
    return now - (t.createdAt || t.announcedAt || 0) < timeoutMs;
  });
  return { pruned: initial - botState.pendingTrades.length };
}

export function updateBotTradeStats(botState): void {
  if (!botState || !Array.isArray(botState.trades)) return;
  const t = botState.trades;
  botState.stats = botState.stats || {};
  botState.stats.totalTrades = t.length;
  botState.stats.totalPnl = Math.round(t.reduce((s, x) => s + (x.pnl || 0), 0) * 100) / 100;
  botState.stats.wins = t.filter((x) => (x.pnl || 0) > 0).length;
  botState.stats.losses = t.filter((x) => (x.pnl || 0) <= 0).length;
}

export function bookWindowExit(cycleAccum, exitReason: string, pnl: number): void {
  if (!cycleAccum) return;
  const reward = Number(pnl || 0);
  cycleAccum.pnl = Math.round(((cycleAccum.pnl || 0) + reward) * 100) / 100;
  cycleAccum.closes = (cycleAccum.closes || 0) + 1;
  if (reward > 0) {
    cycleAccum.rewards = Math.round(((cycleAccum.rewards || 0) + reward) * 100) / 100;
  }
  const key = exitReason === 'tp' ? 'tp'
    : exitReason === 'partial' ? 'partial'
      : exitReason === 'sl' ? 'sl'
        : exitReason === 'trail' ? 'trail'
          : exitReason === 'settle' ? 'settle'
            : null;
  if (key && typeof cycleAccum[key] === 'number') {
    cycleAccum[key] += 1;
  }
}

export function evaluateCycleBoundary({
  botState,
  buildPortfolio,
  recordCycleSession,
  log,
  stopBot,
  optimizeNow,
  notifyStateChange,
  windowSec = POLY_WINDOW_SECONDS,
  nowMs = Date.now(),
}) {
  const wall = currentWallWindow(windowSec, nowMs);
  const cycleKey = String(wall.startSec);

  if (botState._cycleKey == null) {
    botState._cycleKey = cycleKey;
    botState.windows.current = {
      ...wall,
      ...computeWindowStats(botState.trades, botState.positions, wall, botState.config?.mode),
    };
    return null;
  }

  if (botState._cycleKey === cycleKey) {
    // Live-refresh current window stats without rolling
    botState.windows.current = {
      ...wall,
      ...computeWindowStats(botState.trades, botState.positions, wall, botState.config?.mode),
      accum: { ...botState._cycleSettleAccum },
    };
    return null;
  }

  const prevStart = Number(botState._cycleKey);
  const prevWindow = {
    startSec: prevStart,
    endSec: prevStart + windowSec,
    startAtMs: prevStart * 1000,
    endAtMs: (prevStart + windowSec) * 1000,
    key: `wall-${windowSec}-${prevStart}`,
    windowSec,
  };
  const accum = { ...botState._cycleSettleAccum };
  const wstats = computeWindowStats(botState.trades, botState.positions, prevWindow, botState.config?.mode);
  const portfolio = typeof buildPortfolio === 'function'
    ? buildPortfolio(botState.readiness, botState.config?.mode || 'paper')
    : { equity: 0, netPnl: 0, cash: 0, unrealizedPnl: 0, realizedPnl: 0, openCount: 0 };

  const entry = {
    cycleEndAt: prevWindow.endAtMs,
    cycleStartAt: prevWindow.startAtMs,
    cycleKey: String(prevStart),
    openAt: prevWindow.startAtMs,
    endAt: prevWindow.endAtMs,
    pnl: wstats.pnl || accum.pnl || 0,
    closes: wstats.closes || accum.closes || 0,
    rewards: accum.rewards || 0,
    tpFull: wstats.tpFull || accum.tp || 0,
    tpPartial: wstats.tpPartial || accum.partial || 0,
    tpHits: wstats.tpHits || 0,
    sl: wstats.byReason?.sl || accum.sl || 0,
    trail: wstats.byReason?.trail || accum.trail || 0,
    settle: wstats.byReason?.settle || accum.settle || 0,
    byReason: wstats.byReason,
    wr: wstats.wr,
    equity: portfolio.equity,
    netPnl: portfolio.netPnl,
    cash: portfolio.cash,
    unrealizedPnl: portfolio.unrealizedPnl,
    realizedPnl: portfolio.realizedPnl,
    openCount: portfolio.openCount,
    mode: botState.config?.mode,
  };

  if (typeof recordCycleSession === 'function') {
    recordCycleSession(entry);
  }

  botState.cycleReward = { ...entry, at: Date.now() };
  botState.settle.lastCycle = entry;
  botState.settle.history = [entry, ...(botState.settle.history || [])].slice(0, 40);
  botState.windows.history = [entry, ...(botState.windows.history || [])].slice(0, 40);
  botState._cycleSettleAccum = { pnl: 0, closes: 0, rewards: 0, tp: 0, sl: 0, trail: 0, settle: 0, partial: 0 };
  botState._cycleKey = cycleKey;
  botState.windows.current = {
    ...wall,
    ...computeWindowStats(botState.trades, botState.positions, wall, botState.config?.mode),
    accum: { ...botState._cycleSettleAccum },
  };

  if (typeof log === 'function') {
    log(
      `🏁 WINDOW ${new Date(prevWindow.startAtMs).toISOString().slice(11, 16)}→${new Date(prevWindow.endAtMs).toISOString().slice(11, 16)} · closes ${entry.closes} · TP ${entry.tpHits} · PnL $${Number(entry.pnl || 0).toFixed(2)} · cash $${Number(entry.cash || 0).toFixed(2)}`,
      'system',
      entry,
    );
  }

  if (botState.stopRequest?.status === 'queued') {
    const request = { ...botState.stopRequest };
    if (typeof stopBot === 'function') {
      stopBot({ immediate: true, reason: 'queued_window_end' });
    }
    if (typeof log === 'function') {
      log(
        `⏹️ QUEUED STOP COMPLETE · requested ${new Date(request.requestedAt).toLocaleTimeString()} · window closed`,
        'system',
        request,
      );
    }
  } else if (botState.config?.llmOptimize !== false && botState.running && typeof optimizeNow === 'function') {
    optimizeNow({ apply: true, useLlm: true }).catch((err) => {
      if (typeof log === 'function') {
        log(`⚠️ Optimizer after cycle: ${err.message?.slice(0, 100) || err}`, 'error');
      }
    });
  }

  if (typeof notifyStateChange === 'function') {
    notifyStateChange();
  }

  return entry;
}
