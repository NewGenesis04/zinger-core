// @ts-nocheck
/**
 * Expectancy / edge gate for directional trading vs arb-only.
 * Live mode stays locked until recent paper expectancy is positive.
 *
 * **This gate scores directional trades only** (backlog item 6). Arb legs are
 * structurally paired — the engine buys both sides, and paper settlement books
 * one leg near +$1/share and the other near −$1/share — so which leg "wins" is
 * fixed at purchase time, before the market resolves. Feeding them to an
 * expectancy calculation measures nothing about whether a *signal* predicts
 * direction; it measures that the two halves of a hedge cancel.
 *
 * Measured on the local store 2026-08-20, before the filter: 6 of 7 paper
 * trades were arb legs, giving 3 artificial wins, 3 artificial losses and an
 * expectancy of −$0.010 — arithmetic noise around zero, from a sample that had
 * tested a directional signal exactly once. Since `requireEdgeForLive` gates
 * real money on this number, a run of lucky packages could have unlocked live
 * trading on evidence that never tested the strategy.
 */
import { tradeEngine } from './audit.js';

function closedPnls(trades, { mode = 'paper', lookback = 100, engine = 'directional' } = {}) {
  const list = (trades || [])
    .filter((t) => t && (t.closed !== false) && (t.exitReason || t.exitPrice != null || t.pnl != null))
    .filter((t) => !mode || t.mode === mode)
    .filter((t) => !engine || tradeEngine(t) === engine)
    .slice()
    .sort((a, b) => (b.timestamp || b.entryTime || 0) - (a.timestamp || a.entryTime || 0))
    .slice(0, Math.max(1, lookback));
  return list.map((t) => ({
    pnl: Number(t.pnl || 0),
    outcome: t.outcome,
    exitReason: t.exitReason,
  }));
}

export function computeRecentExpectancy(trades, opts = {}) {
  const lookback = Number(opts.lookback ?? 100);
  const mode = opts.mode ?? 'paper';
  // `engine: null` scores every trade — for reporting total P/L, never for the
  // gate. Arb's edge is arithmetic and does not need proving by sample (D11).
  const engine = opts.engine === undefined ? 'directional' : opts.engine;
  const rows = closedPnls(trades, { mode, lookback, engine });
  const n = rows.length;
  if (n === 0) {
    return {
      n: 0,
      wins: 0,
      losses: 0,
      wr: 0,
      avgWin: 0,
      avgLoss: 0,
      expectancy: 0,
      breakEvenWr: 0.5,
      kelly: 0,
      totalPnl: 0,
      lookback,
      mode,
      engine,
    };
  }

  const wins = rows.filter((r) => r.pnl > 0);
  const losses = rows.filter((r) => r.pnl < 0);
  const wr = wins.length / n;
  const avgWin = wins.length ? wins.reduce((s, r) => s + r.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, r) => s + r.pnl, 0) / losses.length) : 0;
  const ratio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const kelly = ratio > 0 ? (wr * ratio - (1 - wr)) / ratio : 0;
  const expectancy = wr * avgWin - (1 - wr) * avgLoss;
  const breakEvenWr = avgWin + avgLoss > 0 ? avgLoss / (avgWin + avgLoss) : 0.5;
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);

  return {
    n,
    wins: wins.length,
    losses: losses.length,
    wr: Math.round(wr * 1000) / 1000,
    avgWin: Math.round(avgWin * 1000) / 1000,
    avgLoss: Math.round(avgLoss * 1000) / 1000,
    expectancy: Math.round(expectancy * 1000) / 1000,
    breakEvenWr: Math.round(breakEvenWr * 1000) / 1000,
    kelly: Math.round(kelly * 1000) / 1000,
    totalPnl: Math.round(totalPnl * 100) / 100,
    lookback,
    mode,
    engine,
  };
}

/**
 * Evaluate trading permissions from recent paper expectancy.
 * arbOnly: block directional buys (CLOB arb still allowed)
 * liveAllowed: paper lock until expectancy > 0 over enough trades
 */
export function evaluateEdgeGate(trades, cfg = {}) {
  const lookback = Number(cfg.edgeLookback ?? 100);
  const minTrades = Number(cfg.edgeMinTrades ?? 40);
  const minExpectancy = Number(cfg.edgeMinExpectancy ?? 0);
  const stats = computeRecentExpectancy(trades, { mode: 'paper', lookback });

  const sampleOk = stats.n >= minTrades;
  const edgeOk = sampleOk && stats.expectancy > minExpectancy && stats.kelly > 0;
  const arbOnlyForced = cfg.forceArbOnly === true;
  const arbOnlyUntilEdge = cfg.arbOnlyUntilEdge !== false;
  const arbOnly = arbOnlyForced || (arbOnlyUntilEdge && !edgeOk);
  const requireEdgeForLive = cfg.requireEdgeForLive !== false;
  const liveAllowed = !requireEdgeForLive || edgeOk || arbOnlyForced;

  let reason = 'edge ok — directional + live unlocked';
  if (arbOnlyForced) reason = 'forceArbOnly — live arb active';
  // Say "directional" out loud: the count dropped when item 6 stopped arb legs
  // padding the sample, and an operator watching the number needs to know why.
  else if (!sampleOk) reason = `need ${minTrades} directional paper closes (have ${stats.n}) — arb-only`;
  else if (!(stats.expectancy > minExpectancy)) reason = `expectancy ${stats.expectancy} ≤ ${minExpectancy} — arb-only`;
  else if (!(stats.kelly > 0)) reason = `kelly ${stats.kelly} ≤ 0 — arb-only`;
  else if (!liveAllowed) reason = 'live locked';

  return {
    ...stats,
    minTrades,
    minExpectancy,
    edgeOk,
    arbOnly,
    directionalAllowed: !arbOnly,
    liveAllowed,
    reason,
  };
}

/** Soft side-balance only when candidate already has a real edge reason. */
export function passesEdgeFilter(candidate, signal) {
  if (!candidate?.eligible) return false;
  const reasons = candidate.reasons || [];
  const hasBookEdge = reasons.some((r) => /price edge|arb|book favor|underdog/i.test(String(r)));
  const agrees = signal?.direction
    && signal.direction !== 'neutral'
    && signal.direction === candidate.outcome
    && Number(signal.confidence || 0) >= 0.35;
  const scoreOk = Number(candidate.score || 0) > 8;
  return Boolean(hasBookEdge || agrees || scoreOk);
}
