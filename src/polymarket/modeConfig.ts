// @ts-nocheck
/**
 * Paper / live strategy isolation.
 * Shared: mode, enabled, paper cash ledger fields.
 * Everything else lives under profiles.paper / profiles.live.
 */

import { normalizeAttribution } from './config/attribution.js';
export const SHARED_KEYS = new Set([
  'mode',
  'enabled',
  'paperBankroll',
  'paperInitialDeposit',
]);

/** Default paper bankroll from environment variable (ZINGER_DEFAULT_PAPER_BANKROLL / PAPER_BANKROLL) defaulting to 100 */
export function getDefaultPaperBankroll(): number {
  const envVal = process.env.ZINGER_DEFAULT_PAPER_BANKROLL || process.env.PAPER_BANKROLL;
  const parsed = Number(envVal);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

/** Strategy knobs that must NOT leak across modes */
export const STRATEGY_KEYS = [
  'minPrice', 'maxPrice',
  'tpPctLow', 'tpPctHigh', 'slPct',
  'maxPositionSize', 'minPositionSize', 'maxPositionPct', 'maxPositionCap',
  'bankrollReservePct',
  'useKellySizing', 'kellyFraction',
  'certaintySizing', 'certaintyMaxPct', 'certaintyMaxUsd',
  'arbBankrollFrac', 'arbMaxUsd',
  'useAggressiveScaling', 'aggScaleMultiplier',
  'minRemainingSec', 'maxEntryRemainingSec', 'entryWindowFrac',
  'assets', 'use15m', 'enabledDurations',
  'maxConcurrentPerSlug', 'maxOpenPositions',
  'minConfidence',
  'useSignals', 'useML', 'useOrderBookBias', 'requireTightSpread',
  'tradeCurrentWindowOnly',
  'announceBeforeTrade', 'announceTimeoutSec',
  'autoApprovePaper', 'autoApproveLive',
  'partialTpFrac', 'partialSellPct', 'trailActivateFrac', 'trailDistanceCap',
  'adaptiveSl', 'minAdaptiveSlPct',
  'llmOptimize', 'optimizeIntervalMs',
  'governorEnabled', 'governorIntervalMs', 'governorCooldownMs',
  'governorDrawdownPct', 'governorRevertTrades',
  'evalBothSides', 'sideBalanceEnabled', 'sideBalanceWeight',
  'preferShortTf', 'shortTfWeight',
  'clobArbEnabled', 'minArbGap', 'arbMinMarginPct', 'arbExploreRate', 'maxArbPackages',
  'arbExactShareRouting', 'maxDailyLossUsd',
  'arbOnlyUntilEdge', 'forceArbOnly', 'requireEdgeForLive',
  'edgeLookback', 'edgeMinTrades', 'edgeMinExpectancy',
  'holdToSettleUnderdogs', 'underdogMaxPrice', 'holdToSettleDisasterSlPct',
  'holdToSettleFavorites', 'favoriteMinPrice', 'favoriteMaxPrice',
  'slMaxSlippagePct',
  'allowScaleIn',
  'maxOpenDrawdownPct',
  'simulateClobFees',
  'useClobMarketFees',
  'feeCategory',
  'minTpUsd',
  'requireDataAssurance',
  'instantCtfMerge',
];

export function defaultPaperStrategy() {
  return {
    // Pilot paper book ($1k): sweet entry band + 10% cash max ticket.
    // Sweet spots from thesis/dev: mid-priced 0.42–0.68, conf ~0.35–0.55; avoid ≥0.70 favorites.
    minPrice: 0.42, maxPrice: 0.68,
    tpPctLow: 18, tpPctHigh: 36, slPct: 12,
    maxPositionSize: 100,
    minPositionSize: 5,
    maxPositionPct: 0.10,
    maxPositionCap: 100,
    bankrollReservePct: 0.05,
    useKellySizing: true,
    kellyFraction: 0.12,
    certaintySizing: true,
    certaintyMaxPct: 0.10,
    certaintyMaxUsd: 100,
    arbBankrollFrac: 0.10,
    arbMaxUsd: 50,
    maxArbPackages: 4,
    useAggressiveScaling: false,
    aggScaleMultiplier: 1.0,
    minRemainingSec: 30,
    maxEntryRemainingSec: 270,
    entryWindowFrac: 0.90,
    assets: ['BTC', 'ETH'],
    use15m: true,
    enabledDurations: ['5m', '15m', '4h'],
    maxConcurrentPerSlug: 1,
    maxOpenPositions: 4,
    minConfidence: 0.38,
    useSignals: true,
    useML: true,
    useOrderBookBias: true,
    requireTightSpread: true,
    tradeCurrentWindowOnly: true,
    announceBeforeTrade: true,
    announceTimeoutSec: 28,
    autoApprovePaper: true,
    autoApproveLive: false,
    partialTpFrac: 0.78,
    partialSellPct: 0.28,
    trailActivateFrac: 0.72,
    trailDistanceCap: 10,
    minTpUsd: 5,
    adaptiveSl: false,
    minAdaptiveSlPct: 10,
    slMaxSlippagePct: 2,
    // Live CLOB schedule via /clob-markets fd.r/e (fallback category crypto).
    simulateClobFees: true,
    useClobMarketFees: true,
    feeCategory: 'crypto',
    // Skip buys when spot/signal/mids/to-beat/ledger fail freshness checks.
    requireDataAssurance: true,
    llmOptimize: false,
    optimizeIntervalMs: 180000,
    governorEnabled: true,
    governorIntervalMs: 120000,
    governorCooldownMs: 240000,
    governorDrawdownPct: 0.12,
    governorRevertTrades: 6,
    evalBothSides: true,
    sideBalanceEnabled: true,
    sideBalanceWeight: 12,
    preferShortTf: true,
    shortTfWeight: 2.0,
    clobArbEnabled: true,
    /**
     * Item 74b — rolling 24h realised-loss brake, in dollars. 0 disables it.
     *
     * OFF in paper deliberately. A paper run exists to find out how bad a
     * defect gets and to produce the skip-code distribution that sizes the live
     * dials; a brake there would truncate the evidence it is being run to
     * collect. Live sets a real number below.
     */
    maxDailyLossUsd: 0,
    /**
     * Item 78 — submit arb legs by exact share count (limit + FOK) instead of by
     * dollar amount. OFF by design, not by caution-as-habit.
     *
     * The SDK routes it via `createOrder` + `postOrder(order, OrderType.FOK)`;
     * its own typing restricts the one-call helper to GTC/GTD
     * (`clob-client-v2/dist/client.d.ts:127`). Nothing in this repo or in
     * `docs/research/polymarket-domain-facts.md` establishes that the *exchange*
     * honours FOK on a limit order — and if it silently downgrades to GTC the
     * leg RESTS, which is the -$12.83 orphan from 2026-08-28.
     *
     * VERIFIED AND ENABLED 2026-09-15. The live probe answered in the venue's
     * own words: `"order couldn't be fully filled. FOK orders are fully filled
     * or killed."` — status 400, order id returned, nothing rested, $0.00 moved.
     * Recorded as fact 8 in `docs/research/polymarket-domain-facts.md`.
     *
     * Scope limit kept deliberately in view: the probe proved the KILL branch.
     * That a limit FOK which *can* fill delivers exactly `roundDown(size, 2)`
     * shares is still SDK-source inference, and the first live fill is the
     * observation. `placeLimitFokBuy` therefore still treats a resting response
     * as a failure — now a contradiction-detector rather than a live hazard.
     */
    /**
     * DISABLED PERMANENTLY 2026-09-16 — items 78 and 89 both CLOSED, WON'T FIX.
     * Leave this `false`. The route below is not "off pending a fix"; the fix
     * was costed and rejected.
     *
     * DISABLED 2026-09-15 — item 89. The live probe proved the venue
     * honours FOK on a limit order; it could not reveal that a CROSSING limit
     * order is validated under MARKETABLE-order precision:
     *
     *   "invalid amounts, the market buy orders maker amount supports a max
     *    accuracy of 2 decimals, taker amount a max of 4 decimals"
     *
     * The limit builder signs maker = shares × price to up to 4 decimals
     * (`ROUNDING_CONFIG['0.01'].amount`). Swept against the SDK's own builders:
     * 95.7% of limit-route orders break that rule; 0% of market-route orders
     * do. And of the packages whose FIRST leg happens to pass, 64.5% would have
     * the second leg rejected — leg 1 filled, leg 2 refused, leg 1 unwound at
     * the cost of the spread plus two taker fees.
     *
     * The probe's own order (100 × $0.01 = $1.00) is exactly the kind that
     * avoids the rule, which is why it passed.
     *
     * With this off, item 81's symmetric-tolerance path is live again — but item
     * 80's reconciler now resolves that exact case with an asymmetric band and
     * hedges the second leg, which is what was missing on 2026-09-11.
     *
     * WHY NOT JUST FIX THE SIZING. You can: pick a share count valid at both
     * legs' prices. Per-leg step is `100/gcd(cents, 100)` hundredths of a share,
     * package step is their `lcm`, and since both divide 100 the package step
     * never exceeds 1.00 share — always constructible. It was measured on the 21
     * canary packages and it costs 9.2% of gross locked profit ($6.73 -> $6.11)
     * to remove a defect whose total WORST-CASE cost over the same packages is
     * $0.25. The fix is 2.4x the flaw. Item 89 has the full workings.
     */
    arbExactShareRouting: false,
    // Absolute floor: "how big a dislocation is worth the trouble". Profitability
    // is no longer this field's job — the fee-aware break-even gate owns that
    // (item 7), and it cannot be turned off. Safe to lower to capture skewed
    // books, which need far less gap than a 50/50 one.
    minArbGap: 0.015,
    // Required profit *above* break-even, in gap terms. Profit = shares x this.
    arbMinMarginPct: 0.005,
    arbExploreRate: 0.08,
    arbOnlyUntilEdge: false,
    forceArbOnly: false,
    requireEdgeForLive: true,
    edgeLookback: 100,
    edgeMinTrades: 40,
    edgeMinExpectancy: 0,
    holdToSettleUnderdogs: false,
    underdogMaxPrice: 0.42,
    holdToSettleDisasterSlPct: 42,
    allowScaleIn: false,
    instantCtfMerge: true,
  };
}

export function defaultLiveStrategy() {
  return {
    ...defaultPaperStrategy(),
    maxPositionSize: 1.0,
    maxPositionPct: 0.05,
    maxPositionCap: 1.0,
    maxOpenPositions: 1,
    minConfidence: 0.50,
    kellyFraction: 0.05,
    certaintyMaxPct: 0.05,
    certaintyMaxUsd: 2.0,
    arbBankrollFrac: 0.03,
    arbMaxUsd: 1,
    /**
     * Item 74b. $10 against the ~$278 live balance — roughly 3.6%, and about
     * eight times the largest single realised arb loss on record (the
     * 2026-08-28 orphan was -$12.83, but that was one unhedged leg at the old
     * sizing, not the current $1 cap). Sized to stop a *loop*, which is the
     * failure this exists for: at live `arbMaxUsd: 1`, ten dollars is dozens of
     * consecutive losing round trips, not one bad trade.
     *
     * This is a starting number, not a derived one. It should be re-set from
     * the realised-loss distribution once a paper run has produced one.
     */
    maxDailyLossUsd: 10,
    // Wider than paper on purpose: a quoted ask is not a fill price, and this
    // margin is what absorbs the difference when real money is at stake.
    arbMinMarginPct: 0.010,
    autoApprovePaper: true,
    autoApproveLive: false,
    slPct: 8,
    adaptiveSl: true,
    minAdaptiveSlPct: 6,
    slMaxSlippagePct: 1,
    // Live stays locked until paper edge proves out
    arbOnlyUntilEdge: true,
    forceArbOnly: false,
    requireEdgeForLive: true,
    announceBeforeTrade: true,
    minTpUsd: 3,
    minPrice: 0.35,
    maxPrice: 0.65,
    requireTightSpread: true,
    useAggressiveScaling: false,
    maxOpenDrawdownPct: 0.05,
    instantCtfMerge: true,
  };
}

function pickStrategy(src = {}) {
  const out = {};
  for (const k of STRATEGY_KEYS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

function pickShared(src = {}) {
  const out = {};
  for (const k of SHARED_KEYS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

function normalizeSizing(strategy = {}) {
  const next = { ...strategy };
  const minRaw = Number(next.minPositionSize);
  const maxRaw = Number(next.maxPositionSize);
  const hasMin = Number.isFinite(minRaw) && minRaw > 0;
  const hasMax = Number.isFinite(maxRaw) && maxRaw > 0;

  if (hasMin) next.minPositionSize = minRaw;
  if (hasMax) next.maxPositionSize = maxRaw;

  if (hasMin && hasMax && next.maxPositionSize < next.minPositionSize) {
    next.maxPositionSize = next.minPositionSize;
  }
  return next;
}

/**
 * Migrate legacy flat config → dual-profile shape.
 * Flat strategy keys seed the paper profile; live profile strictly preserves
 * conservative safety caps (Items 19 & 28).
 */
export function normalizeConfigStore(raw, defaultsFlat = {}) {
  const base = { ...defaultsFlat, ...(raw || {}) };
  const hasProfiles = raw?.profiles && (raw.profiles.paper || raw.profiles.live);

  const paper = {
    ...defaultPaperStrategy(),
    ...pickStrategy(defaultsFlat),
    ...(hasProfiles ? pickStrategy(raw.profiles.paper || {}) : pickStrategy(base)),
  };
  const live = {
    ...defaultLiveStrategy(),
    ...(hasProfiles ? pickStrategy(raw.profiles.live || {}) : {}),
    // Always keep live gate strict even if migrating from flat paper-ish config
    arbOnlyUntilEdge: hasProfiles
      ? (raw.profiles.live?.arbOnlyUntilEdge !== false)
      : true,
    requireEdgeForLive: true,
    autoApproveLive: hasProfiles ? (raw.profiles.live?.autoApproveLive === true) : false,
  };

  return {
    mode: base.mode === 'live' ? 'live' : 'paper',
    enabled: !!base.enabled,
    paperBankroll: Number(base.paperBankroll ?? base.paperInitialDeposit ?? getDefaultPaperBankroll()),
    paperInitialDeposit: Number(base.paperInitialDeposit ?? getDefaultPaperBankroll()),
    profiles: { paper, live },
    // Carried through load, or this record resets on every restart (D3 · C).
    attribution: normalizeAttribution(raw?.attribution),
  };
}

/** Flat runtime config the bot scan loop expects */
export function resolveActiveConfig(store) {
  const mode = store?.mode === 'live' ? 'live' : 'paper';
  const strat = store?.profiles?.[mode] || (mode === 'live' ? defaultLiveStrategy() : defaultPaperStrategy());
  const defaultBankroll = getDefaultPaperBankroll();
  return {
    ...strat,
    mode,
    enabled: !!store?.enabled,
    paperBankroll: Number(store?.paperBankroll ?? store?.paperInitialDeposit ?? defaultBankroll),
    paperInitialDeposit: Number(store?.paperInitialDeposit ?? defaultBankroll),
  };
}

/**
 * Apply a patch. Strategy keys go into the active (or explicit) profile.
 * Shared keys update the store root.
 */
export function applyConfigPatch(store, patch = {}, opts = {}) {
  const next = {
    mode: store.mode === 'live' ? 'live' : 'paper',
    enabled: !!store.enabled,
    paperBankroll: store.paperBankroll,
    paperInitialDeposit: store.paperInitialDeposit,
    // Preserved, never written here — saveConfig stamps it from the diff.
    attribution: store.attribution,
    profiles: {
      paper: { ...(store.profiles?.paper || defaultPaperStrategy()) },
      live: { ...(store.profiles?.live || defaultLiveStrategy()) },
    },
  };

  const explicitPatchMode = patch.mode === 'live' || patch.mode === 'paper' ? patch.mode : null;
  const targetMode = opts.targetMode || explicitPatchMode || next.mode;

  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'profiles') continue;
    if (SHARED_KEYS.has(k)) {
      next[k] = v;
      continue;
    }
    if (STRATEGY_KEYS.includes(k)) {
      const m = targetMode || next.mode;
      next.profiles[m][k] = v;
      continue;
    }
    // Unknown keys: stash on active profile so we don't lose LLM knobs
    const m = targetMode || next.mode;
    next.profiles[m][k] = v;
  }

  if (patch.mode === 'live' || patch.mode === 'paper') {
    next.mode = patch.mode;
  }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;

  next.profiles.paper = normalizeSizing(next.profiles.paper);
  next.profiles.live = normalizeSizing(next.profiles.live);

  return next;
}

export function profilesSummary(store) {
  return {
    mode: store?.mode || 'paper',
    paper: pickStrategy(store?.profiles?.paper || {}),
    live: pickStrategy(store?.profiles?.live || {}),
  };
}

/**
 * Declarative validation of strategy configurations (Item 5).
 * Enforces valid combinations and bounds dangerous settings.
 */
export function validateConfig(cfg = {}) {
  const next = { ...cfg };
  // Can't force pure arb while turning off the arb engine
  if (next.forceArbOnly === true && next.clobArbEnabled === false) {
    next.clobArbEnabled = true;
  }
  if (typeof next.entryWindowFrac === 'number') {
    next.entryWindowFrac = Math.max(0.1, Math.min(1.0, next.entryWindowFrac));
  }
  if (typeof next.minArbGap === 'number') {
    next.minArbGap = Math.max(0.005, next.minArbGap);
  }
  return next;
}

/**
 * Continuous live risk cap assertion (D11 Dimension 4 & Item 19/28).
 * Ensures live blast radius does not exceed safety ceilings without explicit authorization.
 */
export function assertLiveSafetyCaps(liveCfg = {}) {
  const violations = [];
  const maxCap = Number(liveCfg.maxPositionCap ?? 1);
  if (maxCap > 50) {
    violations.push(`maxPositionCap $${maxCap} exceeds safety ceiling ($50)`);
  }
  const maxUsd = Number(liveCfg.certaintyMaxUsd ?? 2);
  if (maxUsd > 100) {
    violations.push(`certaintyMaxUsd $${maxUsd} exceeds safety ceiling ($100)`);
  }
  const maxArb = Number(liveCfg.arbMaxUsd ?? 1);
  if (maxArb > 50) {
    violations.push(`arbMaxUsd $${maxArb} exceeds safety ceiling ($50)`);
  }
  const maxOpen = Number(liveCfg.maxOpenPositions ?? 1);
  if (maxOpen > 5) {
    violations.push(`maxOpenPositions ${maxOpen} exceeds safety ceiling (5)`);
  }
  return {
    ok: violations.length === 0,
    violations,
  };
}


