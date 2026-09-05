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
  const reasonCodes = [];
  let eligible = true;
  let score = 0;

  /**
   * Every reason is recorded twice (item 48 rule iii).
   *
   * `reasons` keeps the prose line the dashboard has always rendered, passed
   * through untouched — so the array stays byte-identical and every existing
   * consumer (`bot.ts` trace/summary, the dashboard's `reasons.join(' · ')`) is
   * unaffected. That is also what makes this differential-checkable: if the
   * prose is unchanged for every input, the scoring is unchanged.
   *
   * `reasonCodes` is the same fact as `{code, value, delta, operands}` — the
   * form a client can filter, count, aggregate and diff. A sentence can only be
   * displayed, or regexed, which is the defect D8 exists to remove.
   */
  const addReason = (text, code, extra = null) => {
    reasons.push(text);
    reasonCodes.push({ code, ...(extra || {}) });
  };

  if (cfg.tradeCurrentWindowOnly && !market.isCurrent) {
    eligible = false;
    addReason('next window — watch only', 'next_window');
  }

  if (!market.acceptingOrders) {
    eligible = false;
    addReason('not accepting orders', 'not_accepting_orders');
  }

  if (!price || price === 0) {
    eligible = false;
    addReason('no price', 'no_price', { value: price ?? null });
  }

  if (eligible && price < cfg.minPrice) {
    eligible = false;
    addReason(`below min $${cfg.minPrice.toFixed(2)}`, 'price_below_min', {
      value: price, operands: { min: cfg.minPrice },
    });
  }

  if (eligible && price > cfg.maxPrice) {
    eligible = false;
    addReason(`above max $${cfg.maxPrice.toFixed(2)}`, 'price_above_max', {
      value: price, operands: { max: cfg.maxPrice },
    });
  }

  const entryWin = resolveEntryWindows(market?.duration || '5m', cfg);
  if (eligible && remaining < entryWin.minRemainingSec) {
    eligible = false;
    addReason(`${remaining}s left < ${entryWin.minRemainingSec}s min (${entryWin.duration})`, 'remaining_below_min', {
      value: remaining, operands: { min: entryWin.minRemainingSec, duration: entryWin.duration },
    });
  }

  // Hard stop on expired / resolved windows (slug clock can lag a few seconds)
  if (eligible && remaining <= 0) {
    eligible = false;
    addReason('window expired', 'window_expired', { value: remaining });
  }

  if (
    eligible
    && cfg.requireDataAssurance !== false
    && dataAssurance
    && !dataAssurance.canBuy
  ) {
    eligible = false;
    addReason(dataAssuranceBuyBlockReason(dataAssurance) || 'data assurance blocked', 'data_assurance_blocked', {
      value: dataAssurance?.score ?? null,
    });
  }

  const maxEntry = entryWin.maxEntryRemainingSec ?? cfg.maxEntryRemainingSec ?? 298;
  if (eligible && remaining > maxEntry) {
    eligible = false;
    addReason(`${remaining}s left > ${maxEntry}s entry window (${entryWin.duration})`, 'remaining_above_entry_window', {
      value: remaining, operands: { max: maxEntry, duration: entryWin.duration },
    });
  }

  if (eligible && remaining >= 180) {
    const earlyBoost = Math.min(18, ((remaining - 180) / 120) * 18);
    score += earlyBoost;
    addReason(`early entry +${earlyBoost.toFixed(0)} (${remaining}s left)`, 'early_entry', {
      value: remaining, delta: earlyBoost,
    });
  } else if (eligible && remaining >= 120) {
    score += 6;
    addReason(`mid-early ${remaining}s`, 'mid_early_entry', { value: remaining, delta: 6 });
  }

  if (eligible && cfg.minPositionSize != null && cfg.maxPositionSize < cfg.minPositionSize) {
    eligible = false;
    addReason(`max $${cfg.maxPositionSize} < min $${cfg.minPositionSize}`, 'max_below_min_position', {
      operands: { max: cfg.maxPositionSize, min: cfg.minPositionSize },
    });
  }

  const minBet = Number(cfg.minPositionSize ?? POLY_MIN_ORDER_USD);
  if (eligible && (readiness?.spendableBalance ?? 0) < minBet && cfg.mode === 'live') {
    eligible = false;
    addReason(`bankroll $${(readiness?.spendableBalance ?? 0).toFixed(2)} < min bet $${minBet}`, 'bankroll_below_min_bet', {
      value: readiness?.spendableBalance ?? 0, operands: { minBet },
    });
  }

  const maxConcurrent = cfg.maxConcurrentPerSlug ?? 1;
  const allowScaleIn = cfg.allowScaleIn !== false && maxConcurrent > 1;
  if (eligible && existingPosition && !allowScaleIn) {
    eligible = false;
    addReason('position already open', 'position_already_open', {
      operands: { maxConcurrent },
    });
  }
  if (eligible && existingPosition && allowScaleIn) {
    addReason('scale-in allowed', 'scale_in_allowed', { delta: 4, operands: { maxConcurrent } });
    score += 4;
  }

  if (eligible && hasOpenOnSlug) {
    eligible = false;
    addReason('already in this window', 'already_in_window');
  }

  if (cfg.mode === 'live' && readiness && !readiness.liveReady) {
    eligible = false;
    addReason('live not ready — fund CLOB USDC', 'live_not_ready');
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
      addReason(`arb gap +${(arbGap * 100).toFixed(1)}c`, 'arb_gap', {
        value: arbGap, delta: arbGap * 160,
      });
    }
    // Absolute cents also matter — mid-% can look fine while book is untradeable
    const spreadCents = side?.bestBid > 0 && side?.bestAsk > 0
      ? (side.bestAsk - side.bestBid) * 100
      : null;
    if (spreadPct != null && spreadPct < 0.8) {
      score += 12;
      addReason(`ultra-tight spread ${spreadPct.toFixed(2)}%`, 'ultra_tight_spread', {
        value: spreadPct, delta: 12,
      });
    } else if (spreadPct != null && spreadPct < 1.5) {
      score += 7;
      addReason(`tight spread ${spreadPct.toFixed(2)}%`, 'tight_spread', {
        value: spreadPct, delta: 7,
      });
    } else if (spreadPct != null && spreadPct > 3) {
      score -= 14;
      addReason(`wide spread ${spreadPct.toFixed(2)}%`, 'wide_spread', {
        value: spreadPct, delta: -14,
      });
      const blockPct = cfg.mode === 'paper' ? 12 : 6;
      if (spreadPct > blockPct && cfg.requireTightSpread !== false) {
        eligible = false;
        addReason('spread too wide — blocked', 'spread_blocked', {
          value: spreadPct, operands: { blockPct },
        });
      }
    }
    if (spreadCents != null && spreadCents > 8 && cfg.requireTightSpread !== false && cfg.mode !== 'paper') {
      eligible = false;
      addReason(`spread ${spreadCents.toFixed(1)}c too wide`, 'spread_cents_too_wide', {
        value: spreadCents, operands: { maxCents: 8 },
      });
    }
    const imbHelps = (outcome === 'up' && imbalance > 0.15) || (outcome === 'down' && imbalance < -0.15);
    const imbHurts = (outcome === 'up' && imbalance < -0.25) || (outcome === 'down' && imbalance > 0.25);
    if (imbHelps) {
      score += Math.abs(imbalance) * 18;
      addReason(`book ${imbalance > 0 ? 'bid' : 'ask'} heavy`, 'book_imbalance_helps', {
        value: imbalance, delta: Math.abs(imbalance) * 18,
      });
    } else if (imbHurts) {
      score -= Math.abs(imbalance) * 12;
      addReason('book against', 'book_imbalance_hurts', {
        value: imbalance, delta: -Math.abs(imbalance) * 12,
      });
    }
  }

  if (cfg.useSignals) {
    if (!signal) {
      eligible = false;
      addReason('signal unavailable', 'signal_unavailable');
    } else if (signal.tooVolatile || signal.skipTrade) {
      eligible = false;
      addReason(`volatility high (${signal.volatility?.atrPct?.toFixed?.(2) || 'n/a'}% ATR)`, 'volatility_high', {
        value: signal.volatility?.atrPct ?? null,
        operands: { tooVolatile: !!signal.tooVolatile, skipTrade: !!signal.skipTrade },
      });
    } else if (signal.direction === 'neutral') {
      // Neutral: still allow book/arb-driven trades on either side
      const edge = Math.max(0, 0.55 - price);
      score += edge * 35;
      addReason('signal neutral — book/arb may lead', 'signal_neutral', {
        value: edge, delta: edge * 35,
      });
      if (edge < 0.02 && !(bookMeta?.arbGap > 0.012)) {
        eligible = false;
        addReason('neutral + no edge', 'neutral_no_edge', {
          value: edge, operands: { minEdge: 0.02, arbGap: bookMeta?.arbGap ?? null },
        });
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
        addReason(`signal says ${signal.direction.toUpperCase()} (counter)`, 'signal_counter', {
          delta: -22, operands: { signalDirection: signal.direction, expected: expectedDirection },
        });
        if (arbRescue) {
          score += bookMeta.arbGap * 200;
          addReason('arb overrides mismatch', 'arb_overrides_mismatch', {
            value: bookMeta.arbGap, delta: bookMeta.arbGap * 200,
          });
        } else if (explore || skewSoft) {
          score += skewSoft ? 8 : 6;
          addReason(
            skewSoft ? 'soft skew explore' : 'explore opposite side',
            skewSoft ? 'soft_skew_explore' : 'explore_opposite_side',
            { delta: skewSoft ? 8 : 6, operands: { upShare: sideBalance?.upShare ?? null } },
          );
        }
        // Counter without arb/edge stays eligible only if price is a clear underdog
        if (!arbRescue && !(price > 0 && price <= Number(cfg.underdogMaxPrice ?? 0.42))) {
          eligible = false;
          addReason('counter needs arb or underdog price', 'counter_needs_arb_or_underdog', {
            value: price, operands: { underdogMaxPrice: Number(cfg.underdogMaxPrice ?? 0.42) },
          });
        }
      } else if (signal.confidence < entryWin.minConfidence && !skewSoft) {
        eligible = false;
        addReason(
          `confidence ${(signal.confidence * 100).toFixed(0)}% < ${(entryWin.minConfidence * 100).toFixed(0)}% (${entryWin.source})`,
          'confidence_below_min',
          {
            value: signal.confidence,
            operands: { min: entryWin.minConfidence, source: entryWin.source },
          },
        );
      } else {
        // Cap signal score contribution so soft balance can still nudge
        const confCap = Math.min(Number(signal.confidence || 0), 0.65);
        const signalDelta = (confCap * 40) + (edge * 45) + Math.min(Number(signal.score || 0), 6);
        score += signalDelta;
        // One `score +=` above, so the whole contribution is attributed to this
        // reason. `price_edge` below carries its value but no delta — splitting
        // the sum across both would double-count it in any client that adds up
        // the deltas.
        addReason(`signal ${signal.direction.toUpperCase()} ${(confCap * 100).toFixed(0)}%`, 'signal_agrees', {
          value: confCap,
          delta: signalDelta,
          operands: { rawConfidence: Number(signal.confidence || 0), edge, signalScore: Number(signal.score || 0) },
        });
        if (edge > 0) {
          addReason(`price edge +${(edge * 100).toFixed(1)}c`, 'price_edge', { value: edge });
        }
        if (price > 0 && price <= Number(cfg.underdogMaxPrice ?? 0.42)) {
          score += 12;
          addReason('underdog hold-to-settle candidate', 'underdog_candidate', {
            value: price, delta: 12, operands: { underdogMaxPrice: Number(cfg.underdogMaxPrice ?? 0.42) },
          });
        }
        if (signal.confidenceBiasUsed && signal.confidenceBias?.traceAgree === true) {
          score += 3;
          addReason('ML short-trace agrees', 'ml_trace_agrees', { delta: 3 });
        } else if (signal.confidenceBias?.traceAgree === false) {
          score -= 8;
          addReason('ML short-trace disagrees', 'ml_trace_disagrees', { delta: -8 });
        }
      }
    }
  } else {
    const noSignalDelta = Math.max(0, 0.55 - price) * 40;
    score += noSignalDelta;
    addReason('signals disabled', 'signals_disabled', { value: price, delta: noSignalDelta });
  }

  // Break chronic single-side bias
  const bal = sideBalanceBonus(outcome, cfg, sideBalance);
  if (bal.bonus) {
    score += bal.bonus;
    if (bal.note) {
      addReason(bal.note, 'side_balance', {
        delta: bal.bonus, operands: { upShare: sideBalance?.upShare ?? null },
      });
    }
  }

  if (eligible) addReason('tradable now', 'tradable_now');

  return {
    outcome,
    price,
    eligible,
    score,
    reasons,
    reasonCodes,
    book: bookMeta,
  };
}
