// @ts-nocheck
/**
 * Directional engine — the gate and the sizing for signal-driven trades.
 *
 * D1 splits the two strategies at the *decision* layer: this module owns whether
 * a directional trade is taken and how large it is. The arb engine
 * (`arbEngine.ts`) owns its own equivalents. They share market discovery, order
 * execution, the cash ledger and persistence, and nothing else.
 *
 * **Both exports are pure functions.** They read no module state, no clock and
 * no store — same inputs, same answer, every time. That is the property that
 * makes them testable against fixtures rather than against whatever happens to
 * be in `data/` (slice 0's first convention), and it is why `buildDecision`
 * takes a `portfolio` argument instead of reaching into `botState`: the three
 * facts it needs about the book are supplied by the caller, which owns that
 * state.
 *
 * Extracted verbatim from `bot.ts` in slice 1. The scoring weights, thresholds
 * and reason strings are unchanged — that commit was deliberately
 * behaviour-neutral, so a regression in the paper run could only be an
 * extraction bug.
 */
import {
  computeKellySize,
  computeCertaintyKelly,
  resolveDynamicLimits,
} from '../kelly.js';
import {
  heuristicForTrade,
  resolveEntryWindows,
} from '../heuristics/fundHeuristics.js';
import { dataAssuranceBuyBlockReason } from '../dataAssurance.js';
import { POLY_MIN_ORDER_USD, POLY_WINDOW_SECONDS } from '../config.js';

/**
 * Soft tilt against a chronically one-sided book.
 *
 * Takes the side mix as an argument rather than computing it, because deriving
 * it means reading open positions and recent trades — state this module
 * deliberately does not own.
 */
export function sideBalanceBonus(outcome, cfg, stats) {
  if (cfg.sideBalanceEnabled === false) return { bonus: 0, note: null };
  const weight = Number(cfg.sideBalanceWeight ?? 12);
  const { up = 0, down = 0, total = 0, upShare = 0.5 } = stats || {};
  if (total < 5) return { bonus: 0, note: null, up, down, upShare };

  // Soft tilt only — never hard-force a side (FORCE DOWN caused live SL massacre)
  if (outcome === 'down' && upShare > 0.62) {
    return { bonus: weight * (upShare - 0.5) * 1.6, note: `soft-balance DOWN (+${((upShare - 0.5) * 100).toFixed(0)}% UP skew)`, up, down, upShare };
  }
  if (outcome === 'up' && upShare < 0.38) {
    return { bonus: weight * (0.5 - upShare) * 1.6, note: `soft-balance UP`, up, down, upShare };
  }
  if (outcome === 'up' && upShare > 0.70) {
    return { bonus: -weight * (upShare - 0.5) * 1.2, note: `UP overtraded soft`, up, down, upShare };
  }
  if (outcome === 'down' && (1 - upShare) > 0.70) {
    return { bonus: -weight * ((1 - upShare) - 0.5) * 1.2, note: `DOWN overtraded soft`, up, down, upShare };
  }
  return { bonus: 0, note: null, up, down, upShare };
}

/**
 * How much to stake on a directional entry.
 *
 * Already pure before the extraction — every input it reads (`cfg`, `readiness`,
 * `stats`) was passed in. Moved unchanged.
 */
export function resolveOrderSize(cfg, { price, signal, readiness, stats, remaining, windowSec, duration, symbol }) {
  const paperBankroll = Number(cfg.paperBankroll ?? cfg.paperInitialDeposit ?? 100);
  const liveBankroll = readiness?.spendableBalance ?? readiness?.clobBalance ?? 0;
  // Never pretend cash is $100 when paper ledger is empty/negative — that over-bought to -cash
  if (cfg.mode === 'paper' && !(paperBankroll > 0.05)) {
    return { sizeUsd: 0, kelly: null, limits: resolveDynamicLimits(cfg, 0), reason: 'no_paper_cash' };
  }
  const bankroll = cfg.mode === 'paper' ? paperBankroll : liveBankroll;
  if (!(bankroll > 0)) {
    return { sizeUsd: 0, kelly: null, limits: resolveDynamicLimits(cfg, 0), reason: 'no_bankroll' };
  }

  // Offline-trained duration/conf/price heuristics (when available)
  const heur = heuristicForTrade({
    duration: duration || (windowSec >= 3600 ? '1h' : windowSec >= 1800 ? '30m' : windowSec >= 900 ? '15m' : '5m'),
    confidence: signal?.confidence,
    entryPrice: price,
    symbol: symbol || signal?.asset,
  });
  const kellyFraction = Number(
    heur?.kellyFraction ?? cfg.kellyFraction ?? 0.50,
  );
  const maxPositionPct = Number(
    heur?.maxPositionPct ?? cfg.maxPositionPct ?? 0.10,
  );

  const limits = resolveDynamicLimits(cfg, bankroll);
  const { minUsd, maxUsd } = limits;
  const cashFrac = Math.min(0.95, Math.max(0.01, maxPositionPct));
  const hardCap = cfg.mode === 'paper'
    ? Math.min(maxUsd, Math.max(0, paperBankroll * cashFrac))
    : maxUsd;

  if (!cfg.useKellySizing) {
    return {
      sizeUsd: Math.min(hardCap, maxUsd),
      kelly: null,
      limits,
      heuristic: heur?.source || null,
    };
  }

  const kelly = computeKellySize({
    bankroll: limits.spendable || bankroll,
    price,
    signalConfidence: signal?.confidence ?? 0.35,
    historicalWinRate: stats?.totalTrades > 0 ? stats.wins / stats.totalTrades : null,
    tradeCount: stats?.totalTrades ?? 0,
    minUsd,
    maxUsd: hardCap,
    kellyFraction,
    maxPositionPct,
  });

  let sizeUsd = kelly.sizeUsd;
  if (cfg.useAggressiveScaling && sizeUsd > 0) {
    const mul = Number(cfg.aggScaleMultiplier ?? 1.0);
    sizeUsd = Math.min(sizeUsd * mul, hardCap);
  }
  sizeUsd = Math.min(sizeUsd, hardCap);

  // Certainty-aware upsizing: near-guaranteed favorites late in the window earn a
  // bigger stake than flat historical Kelly allows. This runs its own, higher cap
  // (certaintyMaxPct of bankroll) so a "10% away, 20s left" entry can be $10–30 on
  // a $100 book instead of a $2 token bet — while ordinary trades stay conservative.
  let certainty = null;
  if (cfg.certaintySizing !== false && remaining != null) {
    const certMaxPct = Number(cfg.certaintyMaxPct ?? 0.35);
    const certCap = Math.min(
      Math.max(maxUsd, bankroll * certMaxPct),
      Number(cfg.certaintyMaxUsd ?? 40),
      cfg.mode === 'paper' ? paperBankroll * cashFrac : bankroll,
    );
    certainty = computeCertaintyKelly({
      price,
      confidence: signal?.confidence,
      remaining,
      windowSec: Number(windowSec) || POLY_WINDOW_SECONDS,
      bankroll: limits.spendable || bankroll,
      kellyFraction,
      minUsd,
      maxUsd: certCap,
      maxPct: certMaxPct,
    });
    if (certainty && certainty.sizeUsd > sizeUsd) {
      sizeUsd = Math.min(certainty.sizeUsd, certCap);
    }
  }

  // Paper directional recovery: if historical Kelly is negative, still allow tiny probes
  // (live stays blocked by edge gate / zero size)
  if ((!sizeUsd || sizeUsd <= 0) && cfg.mode === 'paper' && cfg.arbOnlyUntilEdge === false && hardCap >= minUsd) {
    const conf = Math.min(0.65, Number(signal?.confidence || 0.35));
    sizeUsd = Math.round(Math.max(minUsd, Math.min(hardCap, 1.2 + conf * 2.5)) * 100) / 100;
    return {
      sizeUsd,
      kelly: { ...(kelly || {}), limits, method: 'paper_probe' },
      limits,
      reason: 'paper_probe',
    };
  }

  if (!sizeUsd || sizeUsd <= 0) {
    return { sizeUsd: 0, kelly: { ...kelly, limits }, limits, reason: kelly?.method || 'zero_size' };
  }

  const usedCertainty = certainty && Math.abs(sizeUsd - certainty.sizeUsd) < 0.005;
  return {
    sizeUsd,
    kelly: {
      ...kelly,
      ...(usedCertainty ? { method: 'certainty_kelly' } : {}),
      certainty: certainty || null,
      limits,
      heuristic: heur?.source || null,
    },
    limits,
    heuristic: heur,
  };
}

/**
 * Score one side of one market, and say whether it is tradable.
 *
 * `portfolio` carries the three facts about current holdings this decision
 * depends on. Supplying them rather than reading them is what keeps this
 * function pure:
 *
 *   hasOpenOnSlug   bool    already at the per-slug concurrency cap
 *   sideBalance     { up, down, total, upShare }   recent UP/DOWN mix
 *   dataAssurance   { canBuy, note, ... } | null   feed-health gate
 *
 * Absent, the gate degrades open: an omitted `portfolio` means "nothing open,
 * balanced book, no assurance signal", which is the same answer `botState` gives
 * on a cold start.
 */
export function buildDecision({
  cfg,
  market,
  outcome,
  price,
  remaining,
  signal,
  existingPosition,
  readiness,
  depth = null,
  prices = null,
  portfolio = null,
}) {
  const hasOpenOnSlug = portfolio?.hasOpenOnSlug === true;
  const sideBalance = portfolio?.sideBalance || null;
  const dataAssurance = portfolio?.dataAssurance || null;

  const reasons = [];
  let eligible = true;
  let score = 0;

  if (cfg.tradeCurrentWindowOnly && !market.isCurrent) {
    eligible = false;
    reasons.push('next window — watch only');
  }

  if (!market.acceptingOrders) {
    eligible = false;
    reasons.push('not accepting orders');
  }

  if (!price || price === 0) {
    eligible = false;
    reasons.push('no price');
  }

  if (eligible && price < cfg.minPrice) {
    eligible = false;
    reasons.push(`below min $${cfg.minPrice.toFixed(2)}`);
  }

  if (eligible && price > cfg.maxPrice) {
    eligible = false;
    reasons.push(`above max $${cfg.maxPrice.toFixed(2)}`);
  }

  const entryWin = resolveEntryWindows(market?.duration || '5m', cfg);
  if (eligible && remaining < entryWin.minRemainingSec) {
    eligible = false;
    reasons.push(`${remaining}s left < ${entryWin.minRemainingSec}s min (${entryWin.duration})`);
  }

  // Hard stop on expired / resolved windows (slug clock can lag a few seconds)
  if (eligible && remaining <= 0) {
    eligible = false;
    reasons.push('window expired');
  }

  if (
    eligible
    && cfg.requireDataAssurance !== false
    && dataAssurance
    && !dataAssurance.canBuy
  ) {
    eligible = false;
    reasons.push(dataAssuranceBuyBlockReason(dataAssurance) || 'data assurance blocked');
  }

  const maxEntry = entryWin.maxEntryRemainingSec ?? cfg.maxEntryRemainingSec ?? 298;
  if (eligible && remaining > maxEntry) {
    eligible = false;
    reasons.push(`${remaining}s left > ${maxEntry}s entry window (${entryWin.duration})`);
  }

  if (eligible && remaining >= 180) {
    const earlyBoost = Math.min(18, ((remaining - 180) / 120) * 18);
    score += earlyBoost;
    reasons.push(`early entry +${earlyBoost.toFixed(0)} (${remaining}s left)`);
  } else if (eligible && remaining >= 120) {
    score += 6;
    reasons.push(`mid-early ${remaining}s`);
  }

  if (eligible && cfg.minPositionSize != null && cfg.maxPositionSize < cfg.minPositionSize) {
    eligible = false;
    reasons.push(`max $${cfg.maxPositionSize} < min $${cfg.minPositionSize}`);
  }

  const minBet = Number(cfg.minPositionSize ?? POLY_MIN_ORDER_USD);
  if (eligible && (readiness?.spendableBalance ?? 0) < minBet && cfg.mode === 'live') {
    eligible = false;
    reasons.push(`bankroll $${(readiness?.spendableBalance ?? 0).toFixed(2)} < min bet $${minBet}`);
  }

  const maxConcurrent = cfg.maxConcurrentPerSlug ?? 1;
  const allowScaleIn = cfg.allowScaleIn !== false && maxConcurrent > 1;
  if (eligible && existingPosition && !allowScaleIn) {
    eligible = false;
    reasons.push('position already open');
  }
  if (eligible && existingPosition && allowScaleIn) {
    reasons.push('scale-in allowed');
    score += 4;
  }

  if (eligible && hasOpenOnSlug) {
    eligible = false;
    reasons.push('already in this window');
  }

  if (cfg.mode === 'live' && readiness && !readiness.liveReady) {
    eligible = false;
    reasons.push('live not ready — fund CLOB USDC');
  }

  // Order book / arb: YES+NO ask sum < 1 → free edge; imbalance biases direction
  let bookMeta = null;
  if (cfg.useOrderBookBias !== false && depth) {
    const side = depth[outcome];
    const upAsk = depth.up?.bestAsk || prices?.up;
    const downAsk = depth.down?.bestAsk || prices?.down;
    const arbGap = (upAsk > 0 && downAsk > 0) ? (1 - upAsk - downAsk) : null;
    const imbalance = side?.imbalance ?? 0;
    const spreadPct = side?.spreadPct ?? null;
    bookMeta = { arbGap, imbalance, spreadPct, bestBid: side?.bestBid, bestAsk: side?.bestAsk };

    if (arbGap != null && arbGap > 0.01) {
      score += arbGap * 160;
      reasons.push(`arb gap +${(arbGap * 100).toFixed(1)}c`);
    }
    // Absolute cents also matter — mid-% can look fine while book is untradeable
    const spreadCents = side?.bestBid > 0 && side?.bestAsk > 0
      ? (side.bestAsk - side.bestBid) * 100
      : null;
    if (spreadPct != null && spreadPct < 0.8) {
      score += 12;
      reasons.push(`ultra-tight spread ${spreadPct.toFixed(2)}%`);
    } else if (spreadPct != null && spreadPct < 1.5) {
      score += 7;
      reasons.push(`tight spread ${spreadPct.toFixed(2)}%`);
    } else if (spreadPct != null && spreadPct > 3) {
      score -= 14;
      reasons.push(`wide spread ${spreadPct.toFixed(2)}%`);
      const blockPct = cfg.mode === 'paper' ? 12 : 6;
      if (spreadPct > blockPct && cfg.requireTightSpread !== false) {
        eligible = false;
        reasons.push('spread too wide — blocked');
      }
    }
    if (spreadCents != null && spreadCents > 8 && cfg.requireTightSpread !== false && cfg.mode !== 'paper') {
      eligible = false;
      reasons.push(`spread ${spreadCents.toFixed(1)}c too wide`);
    }
    const imbHelps = (outcome === 'up' && imbalance > 0.15) || (outcome === 'down' && imbalance < -0.15);
    const imbHurts = (outcome === 'up' && imbalance < -0.25) || (outcome === 'down' && imbalance > 0.25);
    if (imbHelps) {
      score += Math.abs(imbalance) * 18;
      reasons.push(`book ${imbalance > 0 ? 'bid' : 'ask'} heavy`);
    } else if (imbHurts) {
      score -= Math.abs(imbalance) * 12;
      reasons.push('book against');
    }
  }

  if (cfg.useSignals) {
    if (!signal) {
      eligible = false;
      reasons.push('signal unavailable');
    } else if (signal.tooVolatile || signal.skipTrade) {
      eligible = false;
      reasons.push(`volatility high (${signal.volatility?.atrPct?.toFixed?.(2) || 'n/a'}% ATR)`);
    } else if (signal.direction === 'neutral') {
      // Neutral: still allow book/arb-driven trades on either side
      const edge = Math.max(0, 0.55 - price);
      score += edge * 35;
      reasons.push('signal neutral — book/arb may lead');
      if (edge < 0.02 && !(bookMeta?.arbGap > 0.012)) {
        eligible = false;
        reasons.push('neutral + no edge');
      }
    } else {
      const expectedDirection = outcome === 'up' ? 'up' : 'down';
      const agrees = signal.direction === expectedDirection;
      const edge = Math.max(0, 0.55 - price);
      const skewSoft = cfg.sideBalanceEnabled !== false && Number(sideBalance?.upShare ?? 0.5) >= 0.68;
      if (!agrees) {
        // Soft mismatch ONLY — never hard-lock; explore lightly when skewed
        const arbRescue = bookMeta?.arbGap != null && bookMeta.arbGap >= Number(cfg.minArbGap ?? 0.015);
        const explore = (cfg.arbExploreRate > 0 && Math.random() < Number(cfg.arbExploreRate));
        score -= 22;
        reasons.push(`signal says ${signal.direction.toUpperCase()} (counter)`);
        if (arbRescue) {
          score += bookMeta.arbGap * 200;
          reasons.push('arb overrides mismatch');
        } else if (explore || skewSoft) {
          score += skewSoft ? 8 : 6;
          reasons.push(skewSoft ? 'soft skew explore' : 'explore opposite side');
        }
        // Counter without arb/edge stays eligible only if price is a clear underdog
        if (!arbRescue && !(price > 0 && price <= Number(cfg.underdogMaxPrice ?? 0.42))) {
          eligible = false;
          reasons.push('counter needs arb or underdog price');
        }
      } else if (signal.confidence < entryWin.minConfidence && !skewSoft) {
        eligible = false;
        reasons.push(
          `confidence ${(signal.confidence * 100).toFixed(0)}% < ${(entryWin.minConfidence * 100).toFixed(0)}% (${entryWin.source})`,
        );
      } else {
        // Cap signal score contribution so soft balance can still nudge
        const confCap = Math.min(Number(signal.confidence || 0), 0.65);
        score += (confCap * 40) + (edge * 45) + Math.min(Number(signal.score || 0), 6);
        reasons.push(`signal ${signal.direction.toUpperCase()} ${(confCap * 100).toFixed(0)}%`);
        if (edge > 0) reasons.push(`price edge +${(edge * 100).toFixed(1)}c`);
        if (price > 0 && price <= Number(cfg.underdogMaxPrice ?? 0.42)) {
          score += 12;
          reasons.push('underdog hold-to-settle candidate');
        }
        if (signal.confidenceBiasUsed && signal.confidenceBias?.traceAgree === true) {
          score += 3;
          reasons.push('ML short-trace agrees');
        } else if (signal.confidenceBias?.traceAgree === false) {
          score -= 8;
          reasons.push('ML short-trace disagrees');
        }
      }
    }
  } else {
    score += Math.max(0, 0.55 - price) * 40;
    reasons.push('signals disabled');
  }

  // Break chronic single-side bias
  const bal = sideBalanceBonus(outcome, cfg, sideBalance);
  if (bal.bonus) {
    score += bal.bonus;
    if (bal.note) reasons.push(bal.note);
  }

  if (eligible) reasons.push('tradable now');

  return {
    outcome,
    price,
    eligible,
    score,
    reasons,
    book: bookMeta,
  };
}
