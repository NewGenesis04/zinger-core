import { savePackage, loadPackages, getActivePackages, getSlotHoldingPackages, resetPackages } from './arbPersistence.js';
import {
  closeProceedsWithFee,
  takerFeeUsdc,
  arbBreakEvenGap,
  peekClobFeeParams,
} from './fees.js';
import { buyCeiling } from './trade.js';
import { getDepthForMarket } from './clob.js';
import { getClobWsBook } from './clobWs.js';
import { emitEvent } from './telemetry/events.js';
import { isArbHalted } from './arbReconcile.js';
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
  // Item 97. Injected so the leg-2 re-read is deterministic under test; in
  // production this is the same book reader the scan used.
  refetchDepth = getDepthForMarket,
  // Item 109. The book as the socket last saw it, read after a kill. Cache
  // only, never a network call. Injected for the same reason as above.
  peekBook = getClobWsBook,
}) {
  if (cfg.clobArbEnabled === false) return null;
  /**
   * Item 80. A leg whose outcome could not be established either way halts the
   * engine (`arbReconcile.ts:reconcileArbLeg`). Placed beside the config gate
   * and deliberately silent per scan: the halt announces itself once, loudly,
   * at the moment it is raised, and again on the dashboard. Re-emitting it on
   * every book every 250ms would bury the decision log it exists to protect.
   */
  if (isArbHalted()) return null;
  /**
   * Item 74b. Read from the per-scan snapshot rather than recomputed: this line
   * runs on every market on every 250ms tick, and the authoritative check
   * happens again inside `executePendingTrade` before any money moves. Cheap
   * here, correct there.
   */
  if (botState?._lossCap?.tripped) return null;
  // Never execute arb packages on markets where both legs could lose.
  if (!isComplementaryBinary(market)) return null;

  /*
   * These two numbers become the `maxPrice` of a live fill-or-kill order
   * (`bot.ts:1011`), so they must be ASKS. `prices.up` is a MID (`clob.ts:118`
   * assigns it `wsMid`) and must never stand in for one.
   *
   * That is not a rounding concern. With a mid on one leg,
   *   computed_sum = mid_up + ask_down = true_sum − spread_up/2
   * so the "gap" the detector sees is half the spread of that leg. The wider
   * the spread, the bigger the phantom edge — a mid fallback would make the gate
   * *select for* the most broken books, and sign orders at a price nothing
   * rests at (item 70).
   *
   * `clob.ts:120` publishes the real ask as `prices.upAsk`. Use that, and when
   * there is no ask from either source, refuse: no ask → no trade. An arb leg
   * cannot be priced off anything but an ask.
   */
  const upAsk = Number(depth?.up?.bestAsk || prices?.upAsk || 0);
  const downAsk = Number(depth?.down?.bestAsk || prices?.downAsk || 0);
  if (!(upAsk > 0.01 && downAsk > 0.01 && upAsk < 0.99 && downAsk < 0.99)) return null;

  const sum = upAsk + downAsk;
  const gap = 1 - sum;

  /**
   * `arb.decision` (item 48 step E). Emitted from the point where a real
   * evaluation happened — both asks are live and in range — so the record shows
   * every book that was genuinely considered and which gate turned it down.
   * Earlier returns (arb disabled, non-complementary market, asks out of range)
   * are deliberately silent: they fire every scan on markets that never had a
   * chance, and would bury the decisions that matter.
   *
   * Rule (iii): the skip is a code plus the operands that produced it.
   */
  const arbDecision = (action, skipCode, operands = null, extra = {}) => {
    emitEvent('arb.decision', {
      symbol: market.symbol,
      slug: market.slug,
      mode,
      upAsk,
      downAsk,
      asksSum: sum,
      arbGap: gap,
      minArbGap: Number(cfg.minArbGap ?? 0.015),
      ...extra,
      output: {
        action,
        skipReason: skipCode ? { code: skipCode, operands } : null,
      },
    });
  };

  // Fee-aware threshold (backlog item 7). Profit per share IS the gap, because
  // a full set redeems exactly $1.00 — and each leg pays a taker fee of
  // rate × (p(1−p))^e per share. So break-even is a function of the book, not a
  // constant: 3.5% at 50/50, 1.88% at 0.83/0.15, 1.26% at 0.10/0.90.
  //
  // A flat threshold is wrong in *both* directions: 0.015 loses money on any
  // book between roughly $0.12 and $0.88, and 0.035 is right at 50/50 but
  // throws away profitable skewed books.
  //
  // Live params when they are already cached, category schedule otherwise —
  // `peekClobFeeParams` never fetches. Deliberate: this gate runs per market
  // per scan, and a network call with a timeout here would stall the scan loop
  // behind it. The fallback is not a compromise
  // on these markets anyway — crypto reports {"r":0.07,"e":1} live, which is
  // exactly FEE_RATES.crypto with exponent 1. Both legs share one conditionId,
  // so one lookup covers the pair, and the fill path warms the cache for the
  // scans that follow.
  const feeParams = (cfg.useClobMarketFees !== false && peekClobFeeParams(market.tokenIds?.up))
    || (cfg.feeCategory || 'crypto');
  const breakEvenGap = arbBreakEvenGap(upAsk, downAsk, feeParams);
  const marginPct = Number(cfg.arbMinMarginPct ?? 0.005);

  /*
   * Item 97. Leg 2 is signed a tick above the ask so transit drift cannot kill
   * it, and that tick has to be *budgeted here* rather than discovered at the
   * fill. Spending it after the gate has already approved the package is how a
   * trade that cleared break-even by half a cent fills below it.
   *
   * It is a ceiling on what leg 2 may pay, not a fee: when the book has not
   * moved the fill is at the ask and the buffer costs nothing (`buyCeiling`).
   * Requiring the package to absorb it regardless is the conservative reading —
   * the worst case is the one that has to be affordable.
   *
   * `arbLeg2BufferTicks: 0` restores the old zero-tolerance behaviour exactly.
   */
  const tickSize = Number(market.tickSize || 0.01) || 0.01;
  const bufferTicks = Math.max(0, Math.floor(Number(cfg.arbLeg2BufferTicks ?? 1)));
  const leg2Buffer = Math.round(tickSize * bufferTicks * 1e6) / 1e6;
  const requiredGap = breakEvenGap + marginPct + leg2Buffer;
  if (!(gap > requiredGap)) {
    arbDecision('skip', 'gap_below_breakeven',
      { gap, breakEvenGap, requiredGap, marginPct, leg2Buffer },
      { breakEvenGap, requiredGap, fees: { feeParams } });
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
  if (gap < minGap) {
    arbDecision('skip', 'gap_below_operator_floor', { gap, minGap },
      { breakEvenGap, requiredGap });
    return null;
  }

  /*
   * Live readiness (item 63b). `liveReady` is the single answer to "can this
   * bot execute live orders right now" — proxy route, API key, deposit-wallet
   * owner, region, balance — and it gates arb exactly as it gates directional
   * (`engines/directional.ts`). No engine sends live orders the readiness check
   * has refused.
   *
   * Placed after the gap gates so the code is counted only for books that were
   * genuinely tradable, which is when "why didn't arb trade?" gets asked.
   * Fails closed: no readiness snapshot yet is not readiness.
   */
  if (mode === 'live' && !readiness?.liveReady) {
    arbDecision('skip', 'live_not_ready',
      {
        readinessKnown: readiness != null,
        proxyDown: readiness?.proxyHealth ? readiness.proxyHealth.ok === false : null,
      },
      { breakEvenGap, requiredGap });
    return null;
  }

  // Capacity: packages still holding exposure, not packages still awaiting
  // settlement (decision D-B). A LOCKED package past its window end has a fixed
  // payout, so it stops holding a slot there.
  const activePkgs = getActivePackages(mode);
  const slotPkgs = getSlotHoldingPackages(mode);
  const maxPkgs = Number(cfg.maxArbPackages ?? 4);
  if (slotPkgs.length >= maxPkgs) {
    arbDecision('skip', 'package_capacity_full',
      {
        active: slotPkgs.length, max: maxPkgs, awaitingSettlement: activePkgs.length - slotPkgs.length,
        bookAgeMs: {
          up: depth?.up?.bookTs ? Date.now() - Number(depth.up.bookTs) : null,
          down: depth?.down?.bookTs ? Date.now() - Number(depth.down.bookTs) : null,
        },
      },
      { breakEvenGap, requiredGap });
    return null;
  }

  // Verify no active package on this market slug
  if (activePkgs.some((p) => p.slug === market.slug)) {
    arbDecision('skip', 'package_already_on_slug', { slug: market.slug },
      { breakEvenGap, requiredGap });
    return null;
  }

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

  /*
   * ── Unified share gate (item 73) ────────────────────────────────────────
   *
   * Three constraints act on one number, and they pull against each other.
   * They are resolved together on purpose: applying them as independent
   * patches is how an arb package turns into a naked directional bet.
   *
   *   floor    shares ≥ MIN_LEG_NOTIONAL / min(upAsk, downAsk)   pushes UP
   *   depth    shares ≤ min(upAskSize, downAskSize)              pushes DOWN
   *   budget   shares ≤ shareBudget / sum                        pushes DOWN
   *
   * The floor exists because the exchange rejects a marketable BUY under
   * $1.00 notional (domain facts §5). Share parity means the *cheap* leg
   * sets it for the whole package: a $0.04 leg needs 25 shares, so the package
   * costs ~$24.50 however small the expensive side would rather be.
   *
   * The depth ceiling exists because `maxPrice` is signed at exactly the best
   * ask (`bot.ts:1011`); every deeper level is priced above it and therefore
   * unreachable, so only top-of-book size can fill. This is why the ladder is
   * not consulted.
   *
   * Why together: capping to depth *alone* can drag the cheap leg back under
   * $1.00, which fills leg one and gets leg two rejected — the unhedged
   * position this whole package design exists to prevent. When floor > either
   * ceiling there is no valid
   * size and the only correct action is to skip.
   */
  const MIN_LEG_NOTIONAL_USD = 1.0;

  /*
   * Fraction of top-of-book this bot is willing to ask for (item 76).
   *
   * Orders are fill-or-kill and `maxPrice` is signed at exactly the best ask
   * (`bot.ts:1011`), so only the top level is reachable. Asking for 100% of it
   * is the most race-prone size that exists: one other participant taking a
   * single share leaves the level short, the FOK cannot fill in full, and the
   * package dies with zero fills.
   *
   * **This factor is a hypothesis, not a measurement** (item 76). The cushion
   * is held because it is cheap, not because a size race has been observed:
   * on any book deep enough for the budget to bind it changes nothing at all. `arb.decision` records
   * `restingShares` alongside `depthShares` on every attempt so the assumption
   * can eventually be tested against real fills rather than re-asserted.
   */
  const DEPTH_UTILISATION = 0.90;

  /*
   * Item 97. Every money figure below is computed against `downCeiling` — the
   * highest price leg 2 is allowed to pay — not against the quote. The buffer
   * would otherwise be spendable money that no gate had seen: sizing to the
   * quote and signing a tick higher lets a package pass the affordability check
   * at one number and commit a larger one.
   *
   * `sum` stays what it was, a statement about the *book*. `gap` is derived from
   * it and must keep describing the dislocation that was observed.
   */
  const downCeiling = bufferTicks > 0 ? buyCeiling(downAsk, { tickSize, bufferTicks }) : downAsk;
  const costSum = upAsk + downCeiling;

  const budgetShares = shareBudget / costSum;
  const floorShares = MIN_LEG_NOTIONAL_USD / Math.min(upAsk, downAsk);

  // `bestAskSize` is published by both branches of `getDepthForMarket`
  // (`clob.ts`). Absent means "no depth information", not "infinite depth" —
  // a fill-or-kill order sized blind is a rejection waiting to happen — but the
  // *refusal* is deferred until after the
  // affordability gate below. An account that cannot fund the trade is refused
  // for that reason whatever the book looks like; money first, microstructure
  // second. `Infinity` here only lets sizing proceed to the point where those
  // gates can speak.
  const upAskSize = Number(depth?.up?.bestAskSize ?? NaN);
  const downAskSize = Number(depth?.down?.bestAskSize ?? NaN);
  const depthKnown = Number.isFinite(upAskSize) && Number.isFinite(downAskSize);
  // `restingShares` is what the book shows; `depthShares` is what this bot will
  // ask for. The clamp is applied HERE, on the ceiling itself, not inside the
  // `Math.min` below — sizing at 90% while the gate at :282 still compared
  // against 100% would mean the gate never fires and the cushion never appears
  // in telemetry. One value, used by both.
  const restingShares = depthKnown ? Math.min(upAskSize, downAskSize) : Infinity;
  const depthShares = depthKnown ? restingShares * DEPTH_UTILISATION : Infinity;

  // Round DOWN to the 3-decimal share grid so rounding can never re-breach a
  // ceiling, then lift to the floor. Rounding *to nearest* at the floor can
  // shave a hair off, which on a cheap leg is the difference between $1.00 and
  // $0.999 — and the exchange rejects the latter. Lifting above a ceiling here
  // is intentional: the gates below then refuse it by name rather than the
  // package silently coming out the wrong size.
  let shares = Math.floor(Math.min(budgetShares, depthShares) * 1000) / 1000;
  // Which constraint actually set the size, decided here where all three are in
  // scope. Derived at the emit site instead, it reads as `shares >= depthShares`
  // — false whenever the grid floor shaved a fraction off, so a depth-bound
  // package would report itself budget-bound.
  let sizeBoundBy = depthShares < budgetShares ? 'depth' : 'arbBankrollFrac/arbMaxUsd';
  if (shares < floorShares) {
    shares = Math.ceil(floorShares * 1000) / 1000;
    sizeBoundBy = 'minLegNotional';
  }

  const costUp = Math.round(shares * upAsk * 100) / 100;
  // At the ceiling, not the quote — see `downCeiling`. A better fill is upside,
  // and reporting the worst case means `lockedProfitUsd` is a floor rather than
  // a figure that a one-tick move turns into a lie.
  const costDown = Math.round(shares * downCeiling * 100) / 100;
  const totalCost = Math.round((costUp + costDown) * 100) / 100;

  /*
   * Affordability gate — both modes.
   *
   * This read `mode === 'paper' && ...`, so live sizing took
   * `readiness.spendableBalance` (:157) and then never checked it covered the
   * cost. `shareBudget` floors at `minPositionSize * 2` (:159), so even a zero
   * balance still produced an order.
   *
   * That was survivable only because readiness was refetched every scan tick.
   * Once it is cached (backlog item 60) a stale-high balance can fill leg one
   * and have leg two rejected for collateral — an UNHEDGED directional position,
   * which is the one outcome an arb package exists to prevent. `arbBank` already
   * holds the right number per mode, so the gate is the same expression for both.
   */
  if (arbBank < totalCost + 0.01) {
    arbDecision('skip',
      mode === 'paper' ? 'insufficient_paper_cash' : 'insufficient_live_cash',
      { totalCost, available: arbBank, mode },
      { breakEvenGap, requiredGap, sizing: { shares, costUp, costDown, capitalUsd: totalCost } });
    return null;
  }

  /*
   * ── Microstructure gates (item 73) ───────────────────────────────────────
   *
   * The account can fund this. Whether the *market* can fill it is a separate
   * question, and these are the three ways it cannot. Each carries its own
   * skip code so the dashboard can tell "book too thin" from "budget too
   * small" from "we are flying blind" — without them all three look like a
   * generic rejection.
   */
  if (!depthKnown) {
    arbDecision('skip', 'depth_unknown',
      { upAskSize: depth?.up?.bestAskSize ?? null, downAskSize: depth?.down?.bestAskSize ?? null },
      { breakEvenGap, requiredGap, sizing: { shares, costUp, costDown, capitalUsd: totalCost } });
    return null;
  }
  if (shares > depthShares) {
    // Only top-of-book is reachable: `maxPrice` is signed at exactly the best
    // ask, so every deeper level is priced out of range. Taking less than the
    // floor is not an option — it would put the cheap leg under $1.00 and get
    // it rejected *after* the first leg filled.
    arbDecision('skip', 'depth_below_min_size',
      {
        shares, depthShares, restingShares, utilisation: DEPTH_UTILISATION,
        upAskSize, downAskSize, floorShares, cheapAsk: Math.min(upAsk, downAsk),
      },
      { breakEvenGap, requiredGap, sizing: { shares, costUp, costDown, capitalUsd: totalCost } });
    return null;
  }
  if (shares > budgetShares) {
    // The configured budget cannot reach $1.00 on the cheap leg. Skewed books
    // are the expensive ones: at a $0.04 leg the floor is 25 shares, so the
    // package costs ~$24.50 no matter how small `arbMaxUsd` is set.
    arbDecision('skip', 'budget_below_min_notional',
      {
        shares,
        budgetShares,
        floorShares,
        shareBudget,
        cheapAsk: Math.min(upAsk, downAsk),
        minPackageUsd: Math.round(floorShares * sum * 100) / 100,
      },
      { breakEvenGap, requiredGap, sizing: { shares, costUp, costDown, capitalUsd: totalCost } });
    return null;
  }
  if (costUp < MIN_LEG_NOTIONAL_USD || costDown < MIN_LEG_NOTIONAL_USD) {
    // Belt and braces against the share-grid rounding above. The rejection this
    // gate exists to prevent is stated by the exchange in dollars, so the last
    // word on it is in dollars.
    arbDecision('skip', 'leg_below_min_notional',
      { shares, costUp, costDown, min: MIN_LEG_NOTIONAL_USD },
      { breakEvenGap, requiredGap, sizing: { shares, costUp, costDown, capitalUsd: totalCost } });
    return null;
  }

  const packageId = `pkg-${market.symbol.toLowerCase()}-${Date.now().toString(36)}`;
  const expectedPayout = Math.round(shares * 1.00 * 100) / 100;

  // The plan's profit, NET of both entry fees (backlog item 7, second half). It
  // stands only until the fills arrive: `lockFromFills` replaces it with the
  // guaranteed figure and keeps this one as `plannedProfitUsd`. It is never
  // reported as realized (`realizedPnlFor`).
  //
  // Only the two entry fees apply. Holding to settlement redeems the set
  // fee-free (FEE_FREE_EXIT_REASONS), which is exactly why the strategy works.
  const feesEstUsd = Math.round(
    (takerFeeUsdc(shares, upAsk, feeParams) + takerFeeUsdc(shares, downAsk, feeParams)) * 100,
  ) / 100;
  const lockedProfitUsd = Math.round((expectedPayout - totalCost - feesEstUsd) * 100) / 100;
  const lockedProfitPct = Math.round((lockedProfitUsd / totalCost) * 10000) / 100;

  // Every gate passed — this is the open decision, recorded before execution so
  // the intent survives even if the legs then fail (backlog 43/27 territory).
  arbDecision('open', null, null, {
    breakEvenGap,
    requiredGap,
    fees: { takerFeeUsdc: feesEstUsd, feeParams },
    sizing: {
      shares, costUp, costDown, capitalUsd: totalCost,
      expectedPayout, lockedProfitUsd, lockedProfitPct,
      // What the book had vs what we asked for. Item 76's cushion is a
      // hypothesis; this pair is the evidence that will confirm or kill it.
      restingShares, depthShares, utilisation: DEPTH_UTILISATION,
      boundBy: sizeBoundBy,
    },
    packageId,
  });

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
    plannedProfitUsd: lockedProfitUsd,
    profitSource: 'plan',
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
    upShares = await executeArbLeg({ outcome: 'up', price: upAsk, cost: costUp, shares, pkg, market, executeTrade, mode, depth, peekBook });

    if (upShares > 0) {
      // 40ms interval ensures distinct millisecond timestamps and strictly increasing nonces on CLOB
      await new Promise((r) => setTimeout(r, 40));

      /*
       * ── Leg 2 is priced here, not at the scan (item 97) ──────────────────
       *
       * `downAsk` was quoted before leg 1 was dispatched, so by this line it is
       * stale by leg 1's entire round trip — ~750ms through the proxy plus the
       * nonce gap — and leg 2 then pays its own transit on top. Signing that
       * quote as a hard bound is why every live leg 2 died: a FOK bounded at a
       * price the book has left has zero reachable shares.
       *
       * Two independent defences, because they fail differently:
       *
       *   re-read   removes the staleness that already happened. Free when the
       *             WS book is live (`clob.ts:179` reads the socket cache, and
       *             that feed is direct, not proxied), and when it is not, the
       *             REST fallback is the same call the scan would have made.
       *
       *   buffer    covers the drift still to come, which no re-read can see.
       *
       * A failed re-read is not a failure: the scan quote remains the fallback,
       * which is exactly the behaviour that shipped before this.
       */
      let freshDownAsk = downAsk;
      let leg2Depth = depth;
      let bookRefreshed = false;
      // The unwind's price: what leg 1 would sell for right now (item 106).
      let upBid = Number(depth?.up?.bestBid) || null;
      if (cfg.arbLeg2RereadBook !== false) {
        try {
          // Both books: DOWN to price the hedge, UP's bid to price the unwind it
          // is compared against. Free from the WS cache; one REST call when cold.
          //
          // Typed `any` locally because `getDepthForMarket` builds its result
          // from an empty literal and so has no inferred keys. Giving it a real
          // return type is backlog work, not this change.
          const reread: any = await refetchDepth({
            ...market,
            tokenIds: { up: market.tokenIds?.up, down: market.tokenIds?.down },
          });
          const a = Number(reread?.down?.bestAsk);
          if (a > 0.01 && a < 0.99) {
            freshDownAsk = a;
            // Merge rather than replace: the UP side of `depth` is still the
            // book leg 1 was sized from, and `executeArbLeg` stamps leg
            // diagnostics (`bookAgeMs`, `bookSource`) off whichever entry it is
            // given. Dropping UP here would blank leg 1's provenance.
            leg2Depth = { ...(depth || {}), down: reread.down };
            bookRefreshed = true;
          }
          const b = Number(reread?.up?.bestBid);
          if (b > 0.01 && b < 0.99) upBid = b;
        } catch { /* stale quotes are the documented fallback */ }
      }

      const signedDownAsk = bufferTicks > 0
        ? buyCeiling(freshDownAsk, { tickSize, bufferTicks })
        : freshDownAsk;

      const exit = chooseLeg2Exit({
        signedDownAsk,
        upBid,
        tickSize,
        premiumTicks: Number(cfg.arbUnwindPremiumTicks ?? 1),
      });

      // `upAsk` stands in for leg 1's fill: it is the bound leg 1 was signed at,
      // and a FOK fills at or below it (§9b), so this overstates the loss.
      const lockedLossUsd = Math.round(upShares * ((upAsk + signedDownAsk) - 1.00) * 100) / 100;
      // Item 106: an alert threshold, not a decision. Once leg 1 has filled,
      // one of the two exits has to be taken, and `chooseLeg2Exit` picks the
      // cheaper one. The cap only says when the price of doing so is worth a
      // human's attention.
      const hedgeLossPct = Math.max(0, Number(cfg.arbMaxHedgeLossPct ?? 0.03));
      const hedgeLossCapUsd = Math.max(0.05, Math.round(totalCost * hedgeLossPct * 100) / 100);
      const exitDetail = {
        packageId, slug: market.slug, quotedDownAsk: downAsk, freshDownAsk, signedDownAsk,
        upBid, unwindEquivalent: exit.unwindEquivalent, threshold: exit.threshold,
        lockedLossUsd, hedgeLossCapUsd, upShares, bookRefreshed,
      };
      if (lockedLossUsd > hedgeLossCapUsd && log) {
        log(
          `⚠️ ARB EXIT OVER CAP ${market.symbol} — DOWN moved $${downAsk.toFixed(3)} → $${freshDownAsk.toFixed(3)}; the cheaper exit (${exit.action}) still costs about -$${lockedLossUsd.toFixed(2)}, over the $${hedgeLossCapUsd.toFixed(2)} alert`,
          'error',
          exitDetail,
        );
      }

      if (exit.action === 'unwind') {
        pkg.legs.down.error = `unwind chosen: hedge at $${signedDownAsk.toFixed(3)} > sell UP at bid $${Number(upBid).toFixed(3)} (≡ DOWN $${exit.unwindEquivalent.toFixed(3)}) + ${exit.premiumTicks} tick`;
        if (log) {
          log(
            `↩️ ARB UNWIND CHOSEN ${market.symbol} — hedging at $${signedDownAsk.toFixed(3)} costs more than selling UP at $${Number(upBid).toFixed(3)} (≡ $${exit.unwindEquivalent.toFixed(3)}) plus ${exit.premiumTicks} tick for the naked window. Leg 1 goes to the unwind path.`,
            'error',
            exitDetail,
          );
        }
      } else {
      // Size leg 2 from what leg 1 ACTUALLY matched, not from the plan.
      //
      // A CLOB market buy is denominated in dollars, not shares
      // (`UserMarketOrderV2.amount` — "BUY orders: $$$ Amount to buy"). Equal
      // budgets therefore do not buy equal share counts. And it is *share
      // parity* that makes this strategy work: a full set redeems to exactly
      // $1.00 because one token pays $1 and its complement pays $0. Shares held
      // on one side beyond the matched pair are not arbitrage at all — they are
      // an unhedged directional bet.
      // Dollars at the signed ceiling, not the quote. `original_size` is
      // `amountUsd / maxPrice` (§9b), so funding the quote while bounding a tick
      // higher would sign *fewer* shares than leg 1 matched and break parity in
      // the one direction that leaves a naked UP leg. At the ceiling the signed
      // size is exactly `upShares`, and a better fill buys a small DOWN excess
      // instead — a complete hedge plus a residual, which the parity check below
      // now expects.
      const downCostActual = Math.round(upShares * signedDownAsk * 100) / 100;
      if (log && bookRefreshed && Math.abs(freshDownAsk - downAsk) >= tickSize) {
        log(
          `🔄 ARB LEG 2 REPRICED ${market.symbol} DOWN $${downAsk.toFixed(3)} → $${freshDownAsk.toFixed(3)} (signing $${signedDownAsk.toFixed(3)})`,
          'system',
          { packageId, slug: market.slug, quotedDownAsk: downAsk, freshDownAsk, signedDownAsk },
        );
      }
      downShares = await executeArbLeg({
        outcome: 'down', price: signedDownAsk, cost: downCostActual, shares: upShares, pkg, market, executeTrade, mode, depth: leg2Depth, peekBook,
      });
      }
    }
  } catch (err) {
    if (log) log(`⚠️ Arb leg execution error: ${err.message}`, 'error', { packageId, error: err.message });
  } finally {
    if (botState?.config && prevMax != null) botState.config.maxConcurrentPerSlug = prevMax;
  }

  // Record what actually matched *before* branching. `abortReason` below is
  // built from `upShares > 0`, so if the flags were only written on the LOCKED
  // path the two would disagree on exactly the case that matters — an aborted
  // package with a filled leg recorded as unfilled, which every reconciler that
  // reads the flag would see as nothing to unwind.
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
      /*
       * Item 97 widened what "expected drift" means. Leg 2 is funded at the
       * signed ceiling and the engine fills the best price first, so when the
       * book has not moved the same dollars buy `tick / price` extra shares —
       * 2.2% on a $0.46 leg, 7.1% on a $0.14 one. That is the buffer working,
       * not a parity fault, and a threshold that flags it would fire on exactly
       * the skewed books this strategy exists to trade.
       *
       * The 2% floor is retained for the pre-existing source of drift: a fixed
       * dollar FOK matching above its signed size on price improvement (§9b, the
       * 2026-09-11 leg that took 4.682223 against a signed 4.5925). The 1.1
       * factor is rounding headroom on the grid, not a risk allowance.
       */
      const bufferFraction = (leg2Buffer > 0 && downAsk > 0) ? (leg2Buffer / downAsk) : 0;
      const legTolerance = Math.max(0.05, matched * Math.max(0.02, bufferFraction * 1.1));

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
      lockFromFills(pkg, matched);
      savePackage(pkg);

      if (log) {
        const up = pkg.legs.up.fill;
        const dn = pkg.legs.down.fill;
        const legTxt = (f, name, fallback) => (f
          ? `${name} ${f.shares}sh@$${f.avgPrice.toFixed(3)}`
          : `${name}@$${fallback.toFixed(3)}`);
        const net = pkg.lockedProfitUsd;
        log(
          `📦 ATOMIC ARB PACKAGE LOCKED ${market.symbol} ${legTxt(up, 'UP', upAsk)} + ${legTxt(dn, 'DN', Number(pkg.legs.down.signedPrice ?? downAsk))}`
            + ` (DN quoted $${downAsk.toFixed(3)}, signed ≤$${Number(pkg.legs.down.signedPrice ?? downAsk).toFixed(3)})`
            + ` · ${pkg.profitSource === 'fills' ? 'guaranteed' : 'planned'} ${net >= 0 ? '+' : '-'}$${Math.abs(net).toFixed(2)}`
            + (pkg.profitSource === 'fills' ? ` (plan ${pkg.plannedProfitUsd >= 0 ? '+' : '-'}$${Math.abs(pkg.plannedProfitUsd).toFixed(2)})` : '')
            + (pkg.residualShares ? ` · residual ${pkg.residualShares}sh ${String(pkg.residualOutcome).toUpperCase()}` : ''),
          'buy',
          {
            packageId, slug: market.slug, totalCost, expectedPayout: pkg.expectedPayout,
            lockedProfitUsd: pkg.lockedProfitUsd, lockedProfitPct: pkg.lockedProfitPct,
            plannedProfitUsd: pkg.plannedProfitUsd, slippageUsd: pkg.slippageUsd ?? null,
            entryCostUsd: pkg.entryCostUsd ?? null, entryFeesUsd: pkg.entryFeesUsd ?? null,
            profitSource: pkg.profitSource,
          },
        );
      }

      // A locked package exits through the account's auto-redeem once the
      // market resolves, and `closeResolvedPositions` closes its books. The bot
      // performs no on-chain merge (item 107): that would be a new signing path.
      return pkg;
    }

    // Emergency Rollback Handler if one leg failed
    pkg.status = 'ABORTED';
    pkg.unwoundAt = Date.now();
    /*
     * UP executes first and DOWN only runs `if (upShares > 0)`, so a failed UP
     * leaves DOWN *never attempted* rather than rejected. The status string
     * says so, instead of reporting both as FAIL, which would make a one-sided
     * rejection indistinguishable from a two-sided one.
     */
    const upState = upShares > 0 ? 'OK' : 'FAIL';
    const downState = upShares > 0 ? (downShares > 0 ? 'OK' : 'FAIL') : 'NOT_ATTEMPTED';
    // Item 79. The state pair alone is what 21 aborted packages recorded, and it
    // cannot distinguish a FOK kill from a $1.00-notional rejection from a
    // transport drop — three failures with three different fixes. Append
    // whatever the venue actually said.
    const why = [
      pkg.legs.up.error ? `UP: ${pkg.legs.up.error}` : null,
      pkg.legs.down.error ? `DOWN: ${pkg.legs.down.error}` : null,
    ].filter(Boolean).join(' · ');
    const age = [
      pkg.legs.up.bookAgeMs != null ? `up book ${pkg.legs.up.bookAgeMs}ms old` : null,
      pkg.legs.down.bookAgeMs != null ? `down book ${pkg.legs.down.bookAgeMs}ms old` : null,
    ].filter(Boolean).join(', ');
    pkg.abortReason = [
      `Leg execution mismatch: UP=${upState}, DOWN=${downState}`,
      why || null,
      age || null,
    ].filter(Boolean).join(' — ');

    let unwound = false;
    if (upShares > 0 && downShares <= 0) {
      await unwindLeg({ outcome: 'up', pkg, market, mode, cfg, botState, log, adjustPaperCash, saveTrade });
      unwound = true;
    } else if (downShares > 0 && upShares <= 0) {
      await unwindLeg({ outcome: 'down', pkg, market, mode, cfg, botState, log, adjustPaperCash, saveTrade });
      unwound = true;
    }

    savePackage(pkg);
    if (log) {
      // Item 73(b). This suffix was unconditional, so an abort with nothing
      // filled still claimed an emergency unwind had run — the loudest line in
      // the feed describing an event that did not happen. Neither leg filled is
      // the *safe* outcome; say that.
      const suffix = unwound
        ? '— emergency unwound filled leg'
        : '— no leg filled, nothing to unwind';
      log(`⚠️ ABORTED ARB PACKAGE ${market.symbol} (${pkg.abortReason}) ${suffix}`, 'sl', { packageId, slug: market.slug, unwound });
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

async function executeArbLeg({ outcome, price, cost, shares, pkg, market, executeTrade, mode = 'paper', depth = null, peekBook = null }) {
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
  //
  // Item 79: stamp the leg before dispatch and record the venue's answer after,
  // whichever way it goes. The book age is computed here rather than at the
  // sizing gate because the interval that matters is snapshot → dispatch, and
  // dispatch is here.
  const leg = pkg.legs?.[outcome];
  const bookTs = Number(depth?.[outcome]?.bookTs) || null;
  const submittedAt = Date.now();
  if (leg) {
    leg.submittedAt = submittedAt;
    leg.requestedShares = Number(shares) || null;
    // The bound this leg was signed at. For leg 2 that is the re-read ask plus
    // the buffer (item 97), which `entryPrice` (the scan quote) does not show.
    leg.signedPrice = Number(price) || null;
    leg.bookSource = depth?.[outcome]?.source || null;
    leg.bookAgeMs = bookTs ? Math.max(0, submittedAt - bookTs) : null;
  }

  const res = await executeTrade(pending);

  if (leg) {
    // `rawError` is the venue's own text where `executePendingTrade` could
    // isolate it; `error` is the wrapped message. Recording the wrapped one as
    // a fallback is deliberate — a generic string beats the `undefined` these
    // records have carried through 21 aborted packages.
    leg.error = res?.ok === true ? null : (res?.rawError || res?.error || 'unknown');
    leg.reconcile = res?.reconcile || null;
    leg.orderId = res?.position?.orderId ?? res?.orderId ?? leg.orderId ?? null;
    // Item 109: how long the venue took to answer, and, when it refused, what
    // the book looked like just after. Live only: this is about the venue.
    const respondedAt = Date.now();
    leg.transitMs = respondedAt - submittedAt;
    if (mode === 'live' && res?.ok !== true) {
      let after = null;
      try { after = peekBook ? peekBook(leg.tokenId) : null; } catch { after = null; }
      const snap = after && Number(after.bestAsk) > 0
        ? {
          bestAsk: Number(after.bestAsk),
          bestAskSize: Number(after.bestAskSize) || 0,
          bestBid: Number(after.bestBid) || null,
          bookTs: Number(after.ts) || null,
          ageMs: after.ts ? respondedAt - Number(after.ts) : null,
          stale: !!after.stale,
        }
        : null;
      const before = depth?.[outcome]
        ? { bestAsk: Number(depth[outcome].bestAsk) || null, bestAskSize: Number(depth[outcome].bestAskSize) || null }
        : null;
      leg.kill = {
        before,
        after: snap,
        cause: classifyKill({ after: snap, signedPrice: price, requestedShares: shares, submittedAt }),
      };
    }
    // Item 105: what this leg actually cost, as the fill path recorded it.
    leg.fill = res?.ok === true ? (res?.position?.fill ?? null) : null;
  }
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

/**
 * Why a refused leg was refused, as far as the book the bot can see says
 * (item 109).
 *
 * 2026-09-22's package records rule out a stale snapshot: leg 1 is killed on
 * books a few tens of milliseconds old. The ask goes somewhere between dispatch
 * and the venue. This names where, from the socket's book just after the kill:
 *
 *   ask_moved_up    best ask now above the bound: the price moved in transit
 *   size_thinned    best ask still within the bound, but less size than asked
 *                   for: someone else took it first
 *   unchanged       the book shows enough size at a price within the bound:
 *                   the ask was not executable, or the book is not what the
 *                   venue matched against
 *   no_book_update  the socket has delivered nothing since dispatch, so the
 *                   "after" book is the "before" book and says nothing
 *   unknown         no socket book at all
 *
 * Leg 1 is signed at the ask with no buffer, so only the best level can fill
 * it, which is why best-level size is the test. The socket lags the venue, so
 * a single classification is weak evidence. The distribution over many kills
 * is the measurement.
 */
export function classifyKill({ after, signedPrice, requestedShares, submittedAt = null }) {
  if (!after || !(Number(after.bestAsk) > 0)) return 'unknown';
  if (submittedAt != null && after.bookTs != null && after.bookTs <= submittedAt) return 'no_book_update';
  if (Number(after.bestAsk) > Number(signedPrice) + 1e-9) return 'ask_moved_up';
  if (Number(after.bestAskSize) < Number(requestedShares)) return 'size_thinned';
  return 'unchanged';
}

/**
 * After leg 1 fills, the cheaper of the two ways out (item 106).
 *
 * Buying DOWN at `p` and selling UP at `1 − p` are the same trade: a full set
 * redeems to exactly $1.00 (domain facts §2), so a held UP share plus a DOWN
 * share bought at `p` is worth `1 − p` at resolution, which is what selling UP
 * at a bid of `1 − p` pays now. The taker fee is `rate·p(1−p)` on both, so fees
 * drop out of the comparison. What is left is two books quoting the same exit.
 *
 * The unwind is charged `premiumTicks` for the one risk the hedge does not
 * carry: a bought token cannot be sold until it settles on-chain (§9d, ~2–3s,
 * variance unmeasured), so leg 1 is naked for that long. Ties go to the hedge.
 *
 * No UP bid means the unwind cannot be priced. The hedge is then the only exit
 * with a price on it.
 */
export function chooseLeg2Exit({ signedDownAsk, upBid, tickSize = 0.01, premiumTicks = 1 }) {
  const tick = Number(tickSize) || 0.01;
  const premium = Math.max(0, Number(premiumTicks) || 0);
  const bid = Number(upBid);
  if (!(bid > 0 && bid < 1)) {
    return { action: 'hedge', reason: 'no_up_bid', unwindEquivalent: null, threshold: null, premiumTicks: premium };
  }
  const unwindEquivalent = Math.round((1 - bid) * 1e6) / 1e6;
  const threshold = Math.round((unwindEquivalent + premium * tick) * 1e6) / 1e6;
  const hedge = Number(signedDownAsk) <= threshold + 1e-9;
  return {
    action: hedge ? 'hedge' : 'unwind',
    reason: hedge ? 'hedge_not_dearer' : 'unwind_cheaper',
    unwindEquivalent,
    threshold,
    premiumTicks: premium,
  };
}

/**
 * Replace the plan's profit with the fills' profit, once both legs are in (item 105).
 *
 * `lockedProfitUsd` is first computed from scan quotes before either leg is
 * sent, and it is what the lock line, the dashboard and the metrics fallback
 * report. A leg that fills worse than its quote makes that figure a profit on a
 * package that loses. After this, it is the **guaranteed** outcome of the
 * fills: `matched` full sets
 * redeem to exactly $1.00 each whatever the resolution (domain facts §2), less
 * what both legs cost and the taker fee charged on top of each (§10e).
 *
 * A residual on one side is upside that depends on the outcome, so it is left
 * out of the guaranteed figure and paid out at settlement. The plan figure is
 * kept as `plannedProfitUsd`, and the difference is the execution slippage D11
 * asks to measure.
 *
 * Without a fill on both legs (a test double, or a pre-105 record), the plan
 * figure stands, and `profitSource: 'plan'` says so.
 */
export function lockFromFills(pkg: ArbPackage, matched: number): ArbPackage {
  const planned = pkg.plannedProfitUsd ?? pkg.lockedProfitUsd;
  pkg.plannedProfitUsd = planned;
  const up = pkg.legs?.up?.fill;
  const down = pkg.legs?.down?.fill;
  if (!up || !down) {
    pkg.profitSource = 'plan';
    return pkg;
  }
  const entryCostUsd = Math.round((up.costUsd + down.costUsd) * 1e6) / 1e6;
  const entryFeesUsd = Math.round((up.feeUsd + down.feeUsd) * 1e6) / 1e6;
  const guaranteed = Math.round((matched * 1.00 - entryCostUsd - entryFeesUsd) * 100) / 100;
  pkg.entryCostUsd = entryCostUsd;
  pkg.entryFeesUsd = entryFeesUsd;
  pkg.lockedProfitUsd = guaranteed;
  pkg.lockedProfitPct = entryCostUsd > 0 ? Math.round((guaranteed / entryCostUsd) * 10000) / 100 : 0;
  pkg.slippageUsd = Math.round((planned - guaranteed) * 100) / 100;
  pkg.profitSource = 'fills';
  return pkg;
}

/**
 * Is this refusal the venue not having credited the shares yet (item 101)?
 *
 * A bought token is not sellable until on-chain settlement (domain facts §9d),
 * so a SELL issued in the seconds after a matched BUY is refused with
 * `balance: 0`. That is **transient** — it clears on its own, with no action
 * available to us but waiting.
 *
 * It has to be told apart from a permanently unsellable leg (no bid at any
 * price, an expired window), because the attempt budget exists for that case
 * and only that case: `arbUnwindMaxAttempts` is what stops the bot emitting a
 * live order every housekeeping tick forever (backlog 34). Spending a
 * permanent-failure budget on a condition that resolves in seconds is how a
 * two-minute delay becomes a naked position held to expiry.
 *
 * Matched on the venue's own wording rather than a status code, because the
 * refusal arrives as an HTTP 400 like every other rejection. Deliberately
 * narrow: an unrecognised message is treated as permanent, which costs a
 * retry rather than an unbounded loop.
 */
export function isSettlementCreditRefusal(message): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  const noBalance = /not enough balance\s*\/\s*allowance|balance is not enough/.test(m);
  // `balance: 0` is the distinguishing part. A *partial* balance means the
  // shares exist and something else is wrong, which is not this case.
  return noBalance && /balance:\s*0(\D|$)/.test(m);
}

async function unwindLeg({ outcome, pkg, market, mode, cfg, botState, log, adjustPaperCash, saveTrade }) {
  const pos = botState.positions.find((p) => p.packageId === pkg.packageId && p.outcome === outcome && !p.closed);
  if (!pos) return { ok: false, closed: false, missing: true };

  const shares = Number(pos.shares || 0);
  const price = Number(pos.entryPrice || 0);
  // The price the close is actually booked at. Stays null until a live receipt
  // says otherwise; paper has no receipt and models the refund at entry.
  let realisedExit = null;
  const feeOn = cfg?.simulateClobFees !== false;

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
      // Item 101: the credit-refusal grace clock is per unwind, not per
      // position. A sell that succeeded proves the shares were credited, so a
      // later refusal is a different fault and gets its own window.
      pos.unwindCreditRefusals = 0;
      pos.firstCreditRefusalAt = null;
      // Backlog 44. The book pays what it pays; copying the entry price here
      // booked every live rollback as break-even-minus-fees. `fillPrice` comes
      // from the receipt (`readSellFill`); `sellRes.price` is the slippage
      // floor we signed and would overstate the loss just as badly.
      if (Number(sellRes?.fillPrice) > 0) {
        realisedExit = Number(sellRes.fillPrice);
        pos.exitFillSource = 'receipt';
      } else {
        // No usable receipt: fall back to the entry price, but say so rather
        // than presenting a fabricated break-even as a measurement.
        pos.exitFillSource = 'unverified';
        pos.exitPriceUnverified = true;
      }
      if (log) {
        log(`⚡ LIVE ARB UNWIND: Sold ${shares}sh back to CLOB cash @ ${realisedExit != null ? `$${realisedExit.toFixed(4)}` : 'unverified price'} (order: ${sellRes?.id || 'ok'})`, 'system', { orderId: sellRes?.id, fillPrice: sellRes?.fillPrice ?? null, floorPrice: sellRes?.floorPrice ?? null });
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
      const now = Date.now();
      pos.lastUnwindError = String(err?.message || err).slice(0, 200);
      pos.lastUnwindAt = now;

      if (isSettlementCreditRefusal(pos.lastUnwindError)) {
        /*
         * Item 101. The venue has not credited the shares yet. Nothing about
         * retrying sooner or later changes that, so this must not consume the
         * attempt budget — but it cannot retry forever either, because a
         * balance that is zero for a reason *other* than settlement lag looks
         * identical from here.
         *
         * Bounded on wall clock rather than attempts, deliberately: the length
         * of the credit gap is not known. §9d measured ~2.15s on one order and
         * the 2026-09-18 canary was still refused at 2.85s, so any fixed
         * attempt count is a guess about a distribution we have not sampled.
         * A grace window only has to be comfortably longer than the gap, and
         * `arbUnwindCreditGraceMs` is ~20x the largest seen while staying well
         * inside a 5-minute window.
         */
        const graceMs = Math.max(0, Number(cfg?.arbUnwindCreditGraceMs ?? 60_000));
        pos.unwindCreditRefusals = Number(pos.unwindCreditRefusals || 0) + 1;
        if (pos.firstCreditRefusalAt == null) pos.firstCreditRefusalAt = now;
        const waitedMs = now - Number(pos.firstCreditRefusalAt);
        pos.unwindBlocked = waitedMs > graceMs;

        if (log) {
          log(
            pos.unwindBlocked
              ? `🛑 LIVE ARB UNWIND GAVE UP — ${pos.symbol} ${outcome.toUpperCase()} ${shares}sh: venue still reports balance 0 after ${(waitedMs / 1000).toFixed(1)}s (grace ${(graceMs / 1000).toFixed(0)}s). STILL HELD and will settle at expiry · ${pos.lastUnwindError}`
              : `⏳ LIVE ARB UNWIND DEFERRED — shares not credited yet (${pos.unwindCreditRefusals} refusal${pos.unwindCreditRefusals === 1 ? '' : 's'}, ${(waitedMs / 1000).toFixed(1)}s waited). Attempt budget untouched, retrying.`,
            pos.unwindBlocked ? 'error' : 'system',
            {
              packageId: pkg.packageId, slug: market?.slug, outcome,
              creditRefusals: pos.unwindCreditRefusals, waitedMs, graceMs,
              attempts: Number(pos.unwindAttempts || 0), blocked: pos.unwindBlocked,
              err: pos.lastUnwindError,
            },
          );
        }
        return {
          ok: false, closed: false, transient: true,
          attempts: Number(pos.unwindAttempts || 0), blocked: pos.unwindBlocked,
        };
      }

      pos.unwindAttempts = Number(pos.unwindAttempts || 0) + 1;
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

  // Priced from the receipt when there is one, from the entry otherwise.
  // 'arb_rollback' is deliberately not in FEE_FREE_EXIT_REASONS — unwinding is
  // a real mid-window sell, unlike settlement/redemption which is fee-free.
  const exitPx = realisedExit != null ? realisedExit : price;
  const pack = closeProceedsWithFee(shares, exitPx, cfg?.feeCategory || 'crypto', 'arb_rollback');
  const exitFee = feeOn ? pack.fee : 0;
  // Live entries carry what they actually cost (item 105): the signed limit is
  // not the price paid, and live positions record no `entryFee`. Paper keeps
  // its model, where the two agree by construction.
  const fill = mode === 'live' && Number(pos.fill?.shares) > 0 ? pos.fill : null;
  const fillShare = fill ? shares / Number(fill.shares) : null;
  const entryCost = fill ? Number(fill.costUsd) * fillShare : price * shares;
  const entryFee = fill ? Number(fill.feeUsd || 0) * fillShare : Number(pos.entryFee || 0);

  pos.closed = true;
  pos.exitPrice = exitPx;
  pos.exitReason = 'arb_rollback';
  pos.exitFee = exitFee;
  pos.feesPaid = Math.round((entryFee + exitFee) * 1e5) / 1e5;
  // The spread between entry and exit is a real loss, not a rounding artefact:
  // 26 shares bought at $0.33 and sold at $0.32 is -$0.26 before either fee.
  pos.pnl = Math.round((exitPx * shares - entryCost - entryFee - exitFee) * 100) / 100;

  if (mode === 'paper' && typeof adjustPaperCash === 'function') {
    const refund = Math.round((pack.premium - exitFee) * 100) / 100;
    adjustPaperCash(refund, `ROLLBACK ${pos.symbol} ${outcome.toUpperCase()}`);
  }

  if (saveTrade) {
    saveTrade({ ...pos, timestamp: Date.now() });
  }

  // The unwind's loss belongs to the package (item 116), on the record that
  // outlives the capped trade log. Saved here because not every caller saves
  // the package after an unwind.
  pkg.realizedPnlUsd = Math.round((Number(pkg.realizedPnlUsd || 0) + pos.pnl) * 100) / 100;
  savePackage(pkg);

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
  orphanMinAgeMs = 5_000,
  cfg = {},
  botState = null,
  log = null,
  adjustPaperCash = null,
  saveTrade = null,
}: any = {}) {
  const now = Date.now();
  const mine = loadPackages().filter((p) => p.mode === mode);
  const ageMs = (p) => now - Number(p.createdAt || 0);

  /*
   * Two age gates, because the two jobs below have different safety
   * requirements (item 100). One predicate served both, and the orphan case
   * inherited a threshold that belongs to the other.
   *
   *   PENDING_FILL  → minAgeMs (120s). The interlock described above: the
   *                   package may still have legs in flight, and promoting it
   *                   early could abort a live dispatch.
   *
   *   ABORTED       → orphanMinAgeMs (5s). Nothing is in flight. The dispatch
   *                   path already ran, already failed, and already wrote the
   *                   status. The only thing a long wait buys here is a longer
   *                   naked position — measured at ~121s on 2026-09-18, on a
   *                   five-minute window.
   *
   * The orphan gate is not zero: the inline unwind at the end of dispatch runs
   * first, and this sweep exists to catch what that left behind. A few seconds
   * keeps the two from racing for the same leg.
   */
  const stuck = mine.filter((p) => p.status === 'PENDING_FILL' && ageMs(p) > minAgeMs);
  const orphanAgeMs = Math.max(0, Number(orphanMinAgeMs));
  const settled = mine.filter((p) => p.status === 'ABORTED' && ageMs(p) > orphanAgeMs);

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
    const pkg = settled.find((p) => p.packageId === pos.packageId);
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
  // `closed` is the idempotence latch: `unwindLeg` sets it only once a sell has
  // succeeded, so a leg is never sold twice. A refused sell leaves the position
  // open with `unwindAttempts` incremented, and this sweep retries it until
  // `unwindBlocked` (backlog 34).
  // The abort path unwinds inline; this sweep catches any leg that inline unwind
  // left behind. Both legs open is deliberately left alone — that is a hedge
  // that was mislabelled, not an orphan, and selling both would realise a loss.
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

/** A trade's P/L to the micro-dollar where the close recorded it, else to the cent. */
function tradePnl(t): number {
  const exact = Number(t?.pnlExactUsd);
  return Number.isFinite(exact) ? exact : Number(t?.pnl || 0);
}

/**
 * The closed trades that finish each leg, or null if either leg is still open.
 *
 * Both outcomes have to be present. Two closed trades on one leg (a partial and
 * its remainder) are not a settled package while the other leg is still held.
 */
function finishingTrades(pkg, trades = []) {
  const mine = trades.filter((t) => t.packageId === pkg.packageId && t.closed);
  const done = (o) => mine.some((t) => String(t.outcome).toLowerCase() === o && t.exitReason !== 'partial');
  return done('up') && done('down') ? mine : null;
}

/**
 * A package's realized P/L, or null when nothing on record says what it was
 * (item 105).
 *
 * Order: the figure written at settlement, then the sum of its closed leg
 * trades (packages settled before that field existed, while the trades are
 * still in the capped trade log). Never the plan: `lockedProfitUsd` was once
 * computed from quotes before execution, and reporting it as a result is how a
 * losing package showed as a win. Unknown is shown as unknown.
 */
export function realizedPnlFor(pkg, trades = []): number | null {
  const recorded = Number(pkg?.realizedPnlUsd);
  if (pkg?.realizedPnlUsd != null && Number.isFinite(recorded)) return recorded;
  if (pkg?.status === 'ABORTED') {
    // An abort's cost is whatever its unwinds realized. With no leg filled
    // there was nothing to unwind: zero, and known. A filled leg with no
    // closed trade is still held, or its trade has left the log: unknown.
    const closed = trades.filter((t) => t.packageId === pkg.packageId && t.closed);
    if (closed.length) return Math.round(closed.reduce((s, t) => s + tradePnl(t), 0) * 100) / 100;
    return pkg.legs?.up?.filled || pkg.legs?.down?.filled ? null : 0;
  }
  const legs = finishingTrades(pkg, trades);
  if (!legs) return null;
  return Math.round(legs.reduce((s, t) => s + tradePnl(t), 0) * 100) / 100;
}

/**
 * LOCKED → SETTLED once both legs have closed, recording what the package
 * realized (item 105).
 *
 * `realizedPnlUsd` is written here, on the package, because the trade log is
 * capped (`bot.ts:saveTrade`), so a package that outlives its leg trades would
 * otherwise have no realized figure at all. `payout` is recorded when both legs
 * closed by resolution, so the result can be audited against Gamma.
 */
export function syncPackageSettlements(trades = [], mode = 'paper') {
  const packages = loadPackages().filter((p) => p.mode === mode && p.status === 'LOCKED');
  let updated = false;

  for (const pkg of packages) {
    const legs = finishingTrades(pkg, trades);
    if (!legs) continue;
    const exact = legs.reduce((s, t) => s + tradePnl(t), 0);
    pkg.status = 'SETTLED';
    pkg.settledAt = Date.now();
    pkg.realizedPnlUsd = Math.round(exact * 100) / 100;
    const redeemed = (o) => legs.find((t) => String(t.outcome).toLowerCase() === o && t.exitReason === 'redeem');
    const up = redeemed('up');
    const down = redeemed('down');
    if (up && down) pkg.payout = { up: Number(up.exitPrice), down: Number(down.exitPrice) };
    savePackage(pkg);
    updated = true;

    emitEvent('package.settlement', {
      packageId: pkg.packageId,
      symbol: pkg.symbol,
      slug: pkg.slug,
      action: up && down ? 'resolved' : 'settled',
      mode,
      shares: pkg.shares,
      netPnl: pkg.realizedPnlUsd,
      netPnlExactUsd: Math.round(exact * 1e6) / 1e6,
      lockedProfitUsd: pkg.lockedProfitUsd,
      plannedProfitUsd: pkg.plannedProfitUsd ?? null,
      slippageUsd: pkg.slippageUsd ?? null,
      profitSource: pkg.profitSource ?? null,
      payout: pkg.payout ?? null,
    });
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

  const realized = settled.map((p) => realizedPnlFor(p, trades));
  const known = realized.filter((v): v is number => v != null);
  // Item 116: an aborted package that unwound a leg lost real money. It used to
  // count as a non-win in the win rate while its loss never reached net profit.
  const abortRealized = aborted.map((p) => realizedPnlFor(p, trades));
  const abortKnown = abortRealized.filter((v): v is number => v != null);

  const concludedCount = settled.length + aborted.length;
  // An unknown result is not a loss, so it stays out of the win-rate denominator.
  const judgedCount = known.length + aborted.length;
  const settledProfitUsd = Math.round(known.reduce((sum, v) => sum + v, 0) * 100) / 100;
  const abortCostUsd = Math.round(abortKnown.reduce((sum, v) => sum + v, 0) * 100) / 100;
  const netProfitUsd = Math.round((settledProfitUsd + abortCostUsd) * 100) / 100;
  const winCount = known.filter((v) => v > 0).length;
  const winRatePct = judgedCount > 0 ? Math.round((winCount / judgedCount) * 1000) / 10 : 0;

  return {
    totalPackages: all.length,
    activeLocked: locked.length,
    settledCount: settled.length,
    abortedCount: aborted.length,
    concludedCount,
    winCount,
    winRatePct,
    // Net = what settled packages made + what aborted packages cost to unwind.
    // Kept apart so the arb edge and the execution cost stay distinguishable.
    netProfitUsd,
    settledProfitUsd,
    abortCostUsd,
    // Packages with no realized figure on record: left out of the sums rather
    // than counted at their planned profit (settled) or at zero (aborted).
    unknownRealizedCount: (realized.length - known.length) + (abortRealized.length - abortKnown.length),
  };
}
