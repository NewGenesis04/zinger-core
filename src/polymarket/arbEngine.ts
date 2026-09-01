import { savePackage, loadPackages, getActivePackages, resetPackages } from './arbPersistence.js';
import {
  closeProceedsWithFee,
  takerFeeUsdc,
  arbBreakEvenGap,
  peekClobFeeParams,
} from './fees.js';
import { executeCtfMerge } from './ctf/merge.js';
import { emitEvent } from './telemetry/events.js';
import type { ArbPackage } from './arbPersistence.js';

export type { ArbPackage };
export { getActivePackages, loadPackages, resetPackages };

/**
 * True when both legs are complementary outcomes of one binary condition, so
 * holding the pair to settlement redeems exactly $1.00 — precisely one token
 * resolves to $1 and the other to $0.
 *
 * This is a property of the CTF binary split, NOT of `negRisk`. That flag marks
 * the NegRiskAdapter used to bundle multi-outcome events, and Polymarket reports
 * it false on every btc/eth-updown market this bot trades — gating arb on it
 * disabled the strategy outright.
 */
export function isComplementaryBinary(market): boolean {
  if (!market?.conditionId) return false;
  if (!Array.isArray(market.outcomes) || market.outcomes.length !== 2) return false;
  const up = market.tokenIds?.up;
  const down = market.tokenIds?.down;
  return Boolean(up && down && up !== down);
}

/**
 * Detects an orderbook gap and executes an atomic ArbPackage.
 * Completely bypasses directional signals, indicator filters, ML overlays, and ATR stop-losses.
 */
export async function detectAndExecuteArbPackage({
  market,
  depth,
  prices,
  cfg,
  mode = 'paper' as 'paper' | 'live',
  readiness,
  log,
  executeTrade,
  adjustPaperCash,
  saveTrade,
  botState,
}) {
  if (cfg.clobArbEnabled === false) return null;
  // Never execute arb packages on markets where both legs could lose.
  if (!isComplementaryBinary(market)) return null;

  const upAsk = Number(depth?.up?.bestAsk || prices?.up || 0);
  const downAsk = Number(depth?.down?.bestAsk || prices?.down || 0);
  if (!(upAsk > 0.01 && downAsk > 0.01 && upAsk < 0.99 && downAsk < 0.99)) return null;

  const sum = upAsk + downAsk;
  const gap = 1 - sum;

  // Fee-aware threshold (backlog item 7). Profit per share IS the gap, because
  // a full set redeems exactly $1.00 — and each leg pays a taker fee of
  // rate × (p(1−p))^e per share. So break-even is a function of the book, not a
  // constant: 3.5% at 50/50, 1.88% at 0.83/0.15, 1.26% at 0.10/0.90.
  //
  // A flat threshold is wrong in *both* directions. The shipped 0.015 default
  // loses money on any book between roughly $0.12 and $0.88; a 0.035 stop-gap
  // is right at 50/50 but throws away profitable skewed books. Measured on the
  // 2026-08-18 overnight run, this gate rejects both losing packages and keeps
  // all four winners, including one a flat 0.035 would have refused.
  //
  // Live params when they are already cached, category schedule otherwise —
  // `peekClobFeeParams` never fetches. Deliberate: this gate runs per market
  // per scan, and putting a 4s-timeout network call in the arb path is the
  // shape that caused the 2026-08-12 outage. The fallback is not a compromise
  // on these markets anyway — crypto reports {"r":0.07,"e":1} live, which is
  // exactly FEE_RATES.crypto with exponent 1. Both legs share one conditionId,
  // so one lookup covers the pair, and the fill path warms the cache for the
  // scans that follow.
  const feeParams = (cfg.useClobMarketFees !== false && peekClobFeeParams(market.tokenIds?.up))
    || (cfg.feeCategory || 'crypto');
  const breakEvenGap = arbBreakEvenGap(upAsk, downAsk, feeParams);
  const marginPct = Number(cfg.arbMinMarginPct ?? 0.005);
  const requiredGap = breakEvenGap + marginPct;
  if (!(gap > requiredGap)) {
    if (log && gap > 0) {
      log(
        `⏭️ ARB SKIP ${market.symbol} gap ${(gap * 100).toFixed(2)}% ≤ break-even ${(breakEvenGap * 100).toFixed(2)}%${marginPct ? ` + margin ${(marginPct * 100).toFixed(2)}%` : ''} — would not cover its own fees`,
        'scan',
        { slug: market.slug, gap, breakEvenGap, requiredGap, upAsk, downAsk },
      );
    }
    return null;
  }

  // The operator's absolute floor. Semantics unchanged, and kept separate on
  // purpose: this answers "how big a dislocation is worth the trouble", the
  // gate above answers "can this trade make money at all". Setting it below
  // break-even is now safe — the fee gate is not optional.
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

  // Locked profit is reported NET (backlog item 7, second half). It used to be
  // `expectedPayout − totalCost`, gross of fees, so the UI overstated every
  // package — the 2026-08-18 run reported $2.66 against a real $0.85. That also
  // fed item 24: `getArbPackageMetrics` falls back to `lockedProfitUsd` for any
  // package whose leg trades are gone, so the gross figure became permanent,
  // uncorrectable phantom profit.
  //
  // Only the two entry fees apply. Holding to settlement redeems the set
  // fee-free (FEE_FREE_EXIT_REASONS), which is exactly why the strategy works.
  const feesEstUsd = Math.round(
    (takerFeeUsdc(shares, upAsk, feeParams) + takerFeeUsdc(shares, downAsk, feeParams)) * 100,
  ) / 100;
  const lockedProfitUsd = Math.round((expectedPayout - totalCost - feesEstUsd) * 100) / 100;
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
    feesEstUsd,
    breakEvenGap,
    gap: Math.round(gap * 100000) / 100000,
    status: 'PENDING_FILL',
    mode,
    createdAt: Date.now(),
    legs: {
      up: { outcome: 'up', tokenId: market.tokenIds?.up || null, entryPrice: upAsk, cost: costUp, shares, filled: false },
      down: { outcome: 'down', tokenId: market.tokenIds?.down || null, entryPrice: downAsk, cost: costDown, shares, filled: false },
    },
  };

  savePackage(pkg);

  // Execution: Dispatch both legs concurrently.
  // Both legs share the same slug, so raise the per-slug concurrency cap for
  // the duration of the atomic dispatch and restore it once — doing this inside
  // Execute legs sequentially with monotonic nonces to prevent CLOB 400 nonce collisions
  const prevMax = botState?.config?.maxConcurrentPerSlug;
  if (botState?.config) botState.config.maxConcurrentPerSlug = 2;
  let upShares = 0;
  let downShares = 0;

  try {
    upShares = await executeArbLeg({ outcome: 'up', price: upAsk, cost: costUp, shares, pkg, market, executeTrade, mode });

    if (upShares > 0) {
      // 40ms interval ensures distinct millisecond timestamps and strictly increasing nonces on CLOB
      await new Promise((r) => setTimeout(r, 40));
      // Size leg 2 from what leg 1 ACTUALLY matched, not from the plan.
      //
      // A CLOB market buy is denominated in dollars, not shares
      // (`UserMarketOrderV2.amount` — "BUY orders: $$$ Amount to buy"). Equal
      // budgets therefore do not buy equal share counts. And it is *share
      // parity* that makes this strategy work: a full set redeems to exactly
      // $1.00 because one token pays $1 and its complement pays $0. Shares held
      // on one side beyond the matched pair are not arbitrage at all — they are
      // an unhedged directional bet, which is the position that expired at zero
      // on 2026-08-28.
      const downCostActual = Math.round(upShares * downAsk * 100) / 100;
      downShares = await executeArbLeg({
        outcome: 'down', price: downAsk, cost: downCostActual, shares: upShares, pkg, market, executeTrade, mode,
      });
    }
  } catch (err) {
    if (log) log(`⚠️ Arb leg execution error: ${err.message}`, 'error', { packageId, error: err.message });
  } finally {
    if (botState?.config && prevMax != null) botState.config.maxConcurrentPerSlug = prevMax;
  }

  // Record what actually matched *before* branching. `abortReason` below is
  // built from `upShares > 0`, so if the flags are only written on the LOCKED
  // path the two disagree on exactly the case that matters: package
  // pkg-btc-mtbtgyzj (2026-08-27) carried `abortReason: "UP=OK, DOWN=FAIL"`
  // beside `legs.up.filled: false`, and 25.99 real UP shares expired worthless
  // because every reconciler that reads the flag saw nothing to unwind.
  pkg.legs.up.filled = upShares > 0;
  pkg.legs.up.shares = upShares;
  pkg.legs.down.filled = downShares > 0;
  pkg.legs.down.shares = downShares;

  try {
    if (upShares > 0 && downShares > 0) {
      // Share-parity invariant. With both legs fill-or-kill a partial cannot
      // happen — each leg matches its full signed amount or is killed outright —
      // so the only expected sources of drift are tick rounding and price
      // improvement, both sub-share. This should never fire. If it does, the
      // model of FOK encoded here is wrong, and that is worth knowing loudly
      // rather than discovering it in a settlement statement.
      const matched = Math.min(upShares, downShares);
      const residual = Math.round(Math.abs(upShares - downShares) * 1000) / 1000;
      const legTolerance = Math.max(0.05, matched * 0.02);

      if (residual > legTolerance) {
        pkg.residualShares = residual;
        pkg.residualOutcome = upShares > downShares ? 'up' : 'down';
        if (log) {
          log(
            `⚠️ ARB LEG PARITY BREACH ${market.symbol} — UP ${upShares}sh vs DOWN ${downShares}sh · ${residual}sh unhedged ${pkg.residualOutcome.toUpperCase()} (backlog: trim residual)`,
            'error',
            { packageId, slug: market.slug, upShares, downShares, residual, tolerance: legTolerance },
          );
        }
      }

      // Only the matched pair is arbitrage, so that is what the package records.
      pkg.shares = matched;
      pkg.expectedPayout = Math.round(matched * 1.00 * 100) / 100;
      pkg.status = 'LOCKED';
      savePackage(pkg);

      if (log) {
        log(
          `📦 ATOMIC ARB PACKAGE LOCKED ${market.symbol} UP@$${upAsk.toFixed(3)} + DN@$${downAsk.toFixed(3)} = $${sum.toFixed(3)} · Net +$${lockedProfitUsd.toFixed(2)} (+${lockedProfitPct.toFixed(1)}%) · ${shares} sh/leg`,
          'buy',
          { packageId, slug: market.slug, totalCost, expectedPayout, lockedProfitUsd, lockedProfitPct },
        );
      }

      // Instant On-Chain CTF Merge / Burn Trigger (Live Mode)
      if (cfg?.instantCtfMerge !== false && mode === 'live' && (botState?.walletClient || botState?.signer)) {
        const mergeRes = await executeCtfMerge({
          conditionId: market.conditionId,
          // Only the matched pair can be merged back to collateral; any residual
          // on one side has no complement to burn against.
          shares: matched,
          collateralToken: market.collateralToken,
          walletClient: botState.walletClient || botState.signer,
          publicClient: botState.publicClient,
        });

        if (mergeRes?.ok) {
          pkg.status = 'MERGED';
          pkg.mergedAt = Date.now();
          pkg.mergeTxHash = mergeRes.txHash;
          savePackage(pkg);

          emitEvent('package.settlement', {
            packageId,
            symbol: market.symbol,
            slug: market.slug,
            action: 'instant_ctf_merge',
            shares,
            lockedProfitUsd,
            txHash: mergeRes.txHash,
            mode: 'live',
          });

          if (log) {
            log(
              `📦 INSTANT CTF MERGE: ${shares} sh burned on-chain → $${shares.toFixed(2)} USDC returned (tx: ${mergeRes.txHash})`,
              'system',
              { packageId, txHash: mergeRes.txHash, shares },
            );
          }
        }
      }

      return pkg;
    }

    // Emergency Rollback Handler if one leg failed
    pkg.status = 'ABORTED';
    pkg.unwoundAt = Date.now();
    pkg.abortReason = `Leg execution mismatch: UP=${upShares > 0 ? 'OK' : 'FAIL'}, DOWN=${downShares > 0 ? 'OK' : 'FAIL'}`;

    if (upShares > 0 && downShares <= 0) {
      await unwindLeg({ outcome: 'up', pkg, market, mode, cfg, botState, log, adjustPaperCash, saveTrade });
    } else if (downShares > 0 && upShares <= 0) {
      await unwindLeg({ outcome: 'down', pkg, market, mode, cfg, botState, log, adjustPaperCash, saveTrade });
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

async function executeArbLeg({ outcome, price, cost, shares, pkg, market, executeTrade, mode = 'paper' }) {
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

  // Backlog item 27. This used to be `!!(await executeTrade(pending))`, and
  // every return path of executePendingTrade is an *object* — a refusal
  // (`{ ok: false, error: 'max open positions' }`) is as truthy as a fill
  // (`{ ok: true, position }`). So the boolean carried no information: a
  // declined leg was recorded as filled, the package locked with both legs
  // marked `filled: true`, and the rollback below was unreachable for anything
  // short of a thrown exception.
  //
  // Read `ok` explicitly. A refusal is not a result.
  const res = await executeTrade(pending);
  if (res?.ok !== true) return 0;

  // Returns *matched shares*, not a boolean, because the sibling leg has to be
  // sized against this number rather than against the plan (see the call site).
  const reported = Number(res?.position?.shares);
  if (Number.isFinite(reported) && reported > 0) return reported;

  // A live fill always carries a position whose share count `placeMarketBuy`
  // proved against the receipt, so a live `ok` with no share count is a
  // contradiction — refuse it rather than substituting the planned size and
  // hedging against a quantity nobody confirmed. Paper mode and the test doubles
  // legitimately report `{ ok: true }` with no position; there the planned size
  // is exact by construction.
  return mode === 'live' ? 0 : Number(shares) || 0;
}

/**
 * Sell a filled leg straight back out when its sibling did not fill.
 *
 * Reachable for the first time as of the item 27 fix — before that only a
 * *thrown* executeTrade reached it, so every ordinary refusal left the leg
 * naked. Two things were wrong with it in consequence, both fixed here because
 * shipping traffic into an unexercised path is how the `cccce43` class of bug
 * happens:
 *
 *   1. It refunded the entry fee, modelling the round trip as free. A rollback
 *      is a taker buy followed by a taker sell — it costs both fees.
 *   2. It closed the position without recording a trade, so the close was
 *      invisible to history. `saveTrade` was already destructured in this
 *      module's signature and never called.
 *
 * The two are coupled: the cash reconciler derives realized P/L from
 * `feesPaid` (item 23), so recording a trade while still refunding the fee
 * would make the ledger and the recompute disagree by exactly that fee. They
 * have to change together, and the invariant that catches it is
 * "cash reconciles to trades + fees + open cost".
 */
async function unwindLeg({ outcome, pkg, market, mode, cfg, botState, log, adjustPaperCash, saveTrade }) {
  const pos = botState.positions.find((p) => p.packageId === pkg.packageId && p.outcome === outcome && !p.closed);
  if (!pos) return { ok: false, closed: false, missing: true };

  const shares = Number(pos.shares || 0);
  const price = Number(pos.entryPrice || 0);
  const feeOn = cfg?.simulateClobFees !== false;
  // 'arb_rollback' is deliberately not in FEE_FREE_EXIT_REASONS — unwinding is
  // a real mid-window sell, unlike settlement/redemption which is fee-free.
  const pack = closeProceedsWithFee(shares, price, cfg?.feeCategory || 'crypto', 'arb_rollback');
  const exitFee = feeOn ? pack.fee : 0;
  const entryFee = Number(pos.entryFee || 0);

  // Live Mode: Execute an immediate Market Sell on CLOB so capital is returned to cash
  if (mode === 'live' && pos.tokenId) {
    try {
      const { placeMarketSell, sellFloor } = await import('./trade.js');
      const sellRes = await placeMarketSell({
        tokenId: pos.tokenId,
        shares,
        // An unwind is a forced exit of an unhedged leg — the mark is what the
        // book will pay now, not what we paid. `price` here is pos.entryPrice,
        // used only as the fallback when the position was never marked.
        minPrice: sellFloor(pos.currentPrice || price, { tickSize: pos.tickSize || '0.01' }),
        negRisk: !!pos.negRisk,
        tickSize: pos.tickSize || '0.01',
      });
      pos.unwindAttempts = 0;
      if (log) {
        log(`⚡ LIVE ARB UNWIND: Sold ${shares}sh back to CLOB cash (order: ${sellRes?.id || 'ok'})`, 'system', { orderId: sellRes?.id });
      }
    } catch (err) {
      // Backlog 34. The sell did not happen, so the shares are still held and
      // the position is still open — closing it here would book a rollback that
      // never occurred, at a price nobody paid, and hide a live exposure.
      // Leave it open and let the orphan sweep retry on the next housekeeping
      // tick. That is only safe because the retry is bounded: an unsellable leg
      // (no bid at any price, an expired window) would otherwise emit a live
      // order every tick forever.
      const maxAttempts = Math.max(1, Number(cfg?.arbUnwindMaxAttempts ?? 3));
      pos.unwindAttempts = Number(pos.unwindAttempts || 0) + 1;
      pos.lastUnwindError = String(err?.message || err).slice(0, 200);
      pos.lastUnwindAt = Date.now();
      pos.unwindBlocked = pos.unwindAttempts >= maxAttempts;

      if (log) {
        log(
          pos.unwindBlocked
            ? `🛑 LIVE ARB UNWIND GAVE UP after ${pos.unwindAttempts} attempts — ${pos.symbol} ${outcome.toUpperCase()} ${shares}sh STILL HELD and will settle at expiry · ${pos.lastUnwindError}`
            : `⚠️ LIVE ARB UNWIND FAILED (attempt ${pos.unwindAttempts}/${maxAttempts}) — position left open for retry: ${pos.lastUnwindError}`,
          'error',
          { packageId: pkg.packageId, slug: market?.slug, outcome, attempts: pos.unwindAttempts, blocked: pos.unwindBlocked, err: pos.lastUnwindError },
        );
      }
      // Not closed, no trade written, no fees booked — nothing happened.
      return { ok: false, closed: false, attempts: pos.unwindAttempts, blocked: pos.unwindBlocked };
    }
  }

  pos.closed = true;
  pos.exitPrice = price;
  pos.exitReason = 'arb_rollback';
  pos.exitFee = exitFee;
  pos.feesPaid = Math.round((entryFee + exitFee) * 1e5) / 1e5;
  pos.pnl = Math.round(-(entryFee + exitFee) * 100) / 100;

  if (mode === 'paper' && typeof adjustPaperCash === 'function') {
    const refund = Math.round((pack.premium - exitFee) * 100) / 100;
    adjustPaperCash(refund, `ROLLBACK ${pos.symbol} ${outcome.toUpperCase()}`);
  }

  if (saveTrade) {
    saveTrade({ ...pos, timestamp: Date.now() });
  }

  if (log) {
    log(
      `🔄 ROLLBACK UNWIND ${pos.symbol} ${outcome.toUpperCase()} · returned $${pack.premium.toFixed(2)} − fee $${exitFee.toFixed(4)} · cost $${(entryFee + exitFee).toFixed(4)}`,
      'system',
      { packageId: pkg.packageId, slug: market?.slug, outcome, entryFee, exitFee, pnl: pos.pnl },
    );
  }

  return { ok: true, closed: true };
}

/**
 * Reconcile packages the dispatch path could not finish cleanly —
 * PENDING_FILL (backlog item 9) and ABORTED-with-an-orphan-leg (backlog 43).
 *
 * A package is written PENDING_FILL, both legs are dispatched, and the block
 * after `Promise.allSettled` promotes it to LOCKED or ABORTED. A process
 * restart between those two points leaves it PENDING_FILL forever — and
 * `getActivePackages` counts PENDING_FILL toward `maxArbPackages`
 * (`arbPersistence.ts`), so the record permanently consumes a slot nothing can
 * free. Observed in production: `pkg-btc-msyglw8m`, 40.5 hours, one naked UP leg.
 *
 * Leg presence is derived from positions and trades rather than from
 * `legs.*.filled`, on purpose. Those flags are written *after* dispatch, so on
 * exactly the interrupted path this exists to repair they are still `false`
 * while the fill is real — trusting them would mean discarding a live position.
 *
 * `minAgeMs` is the safety interlock: it must be comfortably longer than a
 * dispatch, or this could abort a package whose legs are still in flight. A
 * live CLOB round trip is seconds; the default is two minutes.
 */
export async function reconcilePendingPackages({
  mode = 'paper',
  positions = [],
  trades = [],
  minAgeMs = 120_000,
  cfg = {},
  botState = null,
  log = null,
  adjustPaperCash = null,
  saveTrade = null,
}: any = {}) {
  const now = Date.now();
  const all = loadPackages().filter((p) => (
    p.mode === mode && (now - Number(p.createdAt || 0)) > minAgeMs
  ));
  const stuck = all.filter((p) => p.status === 'PENDING_FILL');

  // Driven from open positions, not from the package list. An orphan is by
  // definition a position still on the book, and there are at most a handful of
  // those — whereas ABORTED packages accumulate forever, and scanning all of
  // them on every housekeeping tick would grow without bound for no new signal.
  const orphanCandidates = new Map();
  for (const pos of positions) {
    if (pos.closed || !pos.packageId || !(Number(pos.shares || 0) > 0)) continue;
    // Retries exhausted (backlog 34): the leg is genuinely stuck, so stop
    // issuing live orders for it. It stays open because it is still held, and
    // will settle at expiry like any other position.
    if (pos.unwindBlocked) continue;
    const pkg = all.find((p) => p.packageId === pos.packageId && p.status === 'ABORTED');
    if (!pkg) continue;
    const seen = orphanCandidates.get(pkg.packageId) || { pkg, outcomes: new Set() };
    seen.outcomes.add(pos.outcome);
    orphanCandidates.set(pkg.packageId, seen);
  }

  if (!stuck.length && !orphanCandidates.size) {
    return { checked: 0, locked: 0, aborted: 0, discarded: 0, orphansUnwound: 0 };
  }

  const present = (pkg, outcome) => (
    positions.some((p) => p.packageId === pkg.packageId && p.outcome === outcome)
    || trades.some((t) => t.packageId === pkg.packageId && t.outcome === outcome)
  );

  const result = { checked: stuck.length, locked: 0, aborted: 0, discarded: 0, orphansUnwound: 0 };

  // ── ABORTED packages holding exactly one open leg (backlog 43) ────────────
  // `closed` is the idempotence latch: `unwindLeg` sets it, so a leg is swept at
  // most once and a live sell can never be issued twice for the same shares.
  // (A weak latch — backlog 34 lets a *failed* unwind set it too — but
  // re-selling shares we no longer hold is the worse error, so this under-acts.)
  // The abort path unwinds inline, but that unwind could not fill for the whole
  // of the live canary: it wrote local state only until 72c27ac, then issued an
  // unpriced sell (backlog 35) until 2026-09-01. Nothing swept the leftovers,
  // because the only reconciler here filtered on PENDING_FILL. This is that
  // sweep. Both legs open is deliberately left alone — that is a hedge that was
  // mislabelled, not an orphan, and selling both would realise a loss.
  for (const { pkg, outcomes } of orphanCandidates.values()) {
    if (outcomes.size !== 1) {
      if (log) log(`⚠️ ARB RECONCILE ${pkg.symbol} ${pkg.packageId} — ABORTED but both legs still open · left intact for review`, 'error', { packageId: pkg.packageId, slug: pkg.slug });
      continue;
    }
    const orphan = [...outcomes][0];
    const ageH = ((now - Number(pkg.createdAt || 0)) / 3_600_000).toFixed(1);
    if (log) log(`🔧 ARB RECONCILE ${pkg.symbol} ${pkg.packageId} → naked ${orphan.toUpperCase()} leg still open ${ageH}h after abort — unwinding`, 'sl', { packageId: pkg.packageId, slug: pkg.slug });
    try {
      const unwound = await unwindLeg({ outcome: orphan, pkg, market: { slug: pkg.slug }, mode, cfg, botState, log, adjustPaperCash, saveTrade });
      // The leg was real either way — that is backlog 43, and it must be
      // recorded even when the sell fails, or the next pass forgets again.
      pkg.legs[orphan].filled = true;
      // But only claim it was swept if it actually closed. Counting a refused
      // sell as a sweep is the same lie backlog 34 was about, one level up.
      if (unwound?.closed) {
        result.orphansUnwound += 1;
        pkg.abortReason = `${pkg.abortReason || 'aborted'} · orphan ${orphan.toUpperCase()} swept after ${ageH}h`;
      }
      savePackage(pkg);
    } catch (err) {
      if (log) log(`⚠️ ARB RECONCILE orphan unwind failed ${pkg.packageId}: ${err?.message}`, 'error');
    }
  }

  if (!stuck.length) return result;

  for (const pkg of stuck) {
    const upOk = present(pkg, 'up');
    const downOk = present(pkg, 'down');
    const ageH = ((now - Number(pkg.createdAt || 0)) / 3_600_000).toFixed(1);

    if (upOk && downOk) {
      // Both fills landed; only the bookkeeping was lost. This is a real hedge.
      pkg.legs.up.filled = true;
      pkg.legs.down.filled = true;
      pkg.status = 'LOCKED';
      savePackage(pkg);
      result.locked += 1;
      if (log) log(`🔧 ARB RECONCILE ${pkg.symbol} ${pkg.packageId} → LOCKED · both legs found after ${ageH}h stuck`, 'system', { packageId: pkg.packageId, slug: pkg.slug });
      continue;
    }

    if (upOk !== downOk) {
      // Half a hedge. Unwind the survivor rather than hold a naked leg that
      // item 8 would later settle at a fabricated $0.50.
      const filledLeg = upOk ? 'up' : 'down';
      pkg.status = 'ABORTED';
      pkg.unwoundAt = now;
      pkg.abortReason = `Reconciled after ${ageH}h PENDING_FILL: only the ${filledLeg.toUpperCase()} leg filled`;
      savePackage(pkg);
      result.aborted += 1;
      if (log) log(`🔧 ARB RECONCILE ${pkg.symbol} ${pkg.packageId} → ABORTED · naked ${filledLeg.toUpperCase()} leg after ${ageH}h — unwinding`, 'sl', { packageId: pkg.packageId, slug: pkg.slug });
      // Awaited, not fired and forgotten: the caller needs to know the leg is
      // actually closed before it reports capacity as freed, and a caller that
      // cannot observe completion cannot be tested deterministically either.
      // Caught per package so one bad unwind does not strand the rest.
      try {
        await unwindLeg({ outcome: filledLeg, pkg, market: { slug: pkg.slug }, mode, cfg, botState, log, adjustPaperCash, saveTrade });
      } catch (err) {
        if (log) log(`⚠️ ARB RECONCILE unwind failed ${pkg.packageId}: ${err?.message}`, 'error');
      }
      continue;
    }

    // Neither leg exists. Nothing was bought, so there is nothing to unwind —
    // ABORTED rather than deleted, so the attempt stays auditable. Either way
    // it stops counting against capacity.
    pkg.status = 'ABORTED';
    pkg.unwoundAt = now;
    pkg.abortReason = `Reconciled after ${ageH}h PENDING_FILL: neither leg filled`;
    savePackage(pkg);
    result.discarded += 1;
    if (log) log(`🔧 ARB RECONCILE ${pkg.symbol} ${pkg.packageId} → ABORTED · no legs filled after ${ageH}h · capacity freed`, 'system', { packageId: pkg.packageId, slug: pkg.slug });
  }

  return result;
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
export function getArbPackageMetrics(mode = 'paper', trades = []) {
  const all = loadPackages().filter((p) => p.mode === mode);
  const settled = all.filter((p) => p.status === 'SETTLED' || p.status === 'MERGED');
  const locked = all.filter((p) => p.status === 'LOCKED');
  const aborted = all.filter((p) => p.status === 'ABORTED');

  // Realized PnL is truth: sum the closed leg trades when available (covers
  // force-closed / rolled-back legs), falling back to the nominal entry edge.
  const realizedFor = (pkg) => {
    const legTrades = trades.filter((t) => t.packageId === pkg.packageId && t.closed && t.pnl != null);
    if (legTrades.length >= 2) {
      return Math.round(legTrades.reduce((s, t) => s + Number(t.pnl || 0), 0) * 100) / 100;
    }
    return Number(pkg.lockedProfitUsd || 0);
  };

  const concludedCount = settled.length + aborted.length;
  const netProfitUsd = Math.round(settled.reduce((sum, p) => sum + realizedFor(p), 0) * 100) / 100;
  const winCount = settled.filter((p) => realizedFor(p) > 0).length;
  const winRatePct = concludedCount > 0 ? Math.round((winCount / concludedCount) * 1000) / 10 : 0;

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
