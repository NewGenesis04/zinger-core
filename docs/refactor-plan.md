# Zinger refactor plan (backlog)

Running list of structural work identified while debugging the Aug 2026 "bot ran
for days without trading" investigation. Nothing here is scheduled yet — this is
the input to a planning pass, not a plan.

See `docs/architecture.md` for the current module map.

## Why this exists

Two live bugs were traced to the same underlying shape: behaviour that spans
several modules with no single owner, so a wrong assumption in one place goes
unnoticed everywhere else.

- **`negRisk` arb gate.** A review fix (`cccce43`, 2026-08-12) gated arbitrage on
  `market.negRisk === true`. Polymarket reports `negRisk: false` on every
  `*-updown-*` market the bot trades, so arb was disabled outright from that
  commit until 2026-08-18. The shipped test asserted the new behaviour, so CI
  stayed green on the regression. Fixed by checking the invariant that actually
  guarantees the $1.00 payout (one `conditionId`, two complementary outcome
  tokens) via `isComplementaryBinary` in `arbEngine.ts`.
- **Signal-feed outage aborting whole scans.** `getSignalForBoth()` in `scan()`
  was unguarded, so a Binance timeout threw out of the entire pass — including
  the arb engine 250 lines below, which needs only the Polymarket order book.
  Fixed with a local `.catch()` that reuses the last known signals.

Both fixes are in; the items below are the structural work they point at.

## Backlog

### 1. Market duration coverage

`ALL_ASSETS` (`config.ts:31-39`) declares `btc/eth-updown-30m` and `-1h`
prefixes, and `getCurrentSlug` builds every slug as `<prefix>-<epoch aligned to
windowSeconds>`. Gamma publishes the epoch-suffixed series **only at 5m and 15m**:

```
btc-updown-5m-<epoch>   200
btc-updown-15m-<epoch>  200
btc-updown-30m-<epoch>  404   (series does not exist)
btc-updown-1h-<epoch>   404   (different slug scheme)
```

Hourly and daily up/down markets do exist, under an ET wall-clock scheme —
`bitcoin-up-or-down-august-18-9pm-et`, `bitcoin-up-or-down-on-august-18-2026`.
They are `["Up","Down"]` binaries with `negRisk: false`, i.e. valid arb targets
under the corrected gate, but unreachable because slug generation is epoch-only.

Two separable pieces:

- **Cheap:** drop `'30m'`/`'1h'` from the three default arrays
  (`modeConfig.ts:80`, `bot.ts:165`, `config.ts:52`) so nothing requests a slug
  that cannot exist. Low value — `enabledDurations` is a persisted
  `STRATEGY_KEYS` field, so this only affects newly seeded profiles. Current
  local config: `paper` is already `['5m','15m']`; `live` still lists all four.
  Confirm the VPS `paper` profile separately.
- **Real work:** support the ET wall-clock series. Needs DST-aware slug
  generation and a window-boundary model that no longer assumes epoch alignment
  (`getRemainingMs`, `getCycleEndMs`, `getIntervalBoundary`, `windows.ts` slug
  regex). This is the piece with actual upside.

### 2. `bot.ts` decomposition

~3,900 lines carrying scan orchestration, trade execution, sizing, persistence,
telemetry and logging at once. Direct consequence: an unrelated failure early in
`scan()` silently kills strategy paths later in the same pass. Candidate seams:
market discovery → candidate scoring → execution → reconciliation/telemetry.

### 3. Config validity has no owner

Rules are spread across `modeConfig.ts` (shape/defaults), `edge.ts` (gating),
`ai/governor.ts` (regime overlays) and the dashboard, with no single validation
point. This is how `forceArbOnly: true` + `clobArbEnabled: false` — a combination
that mutes directional trading *and* the arb engine, leaving the bot trading
nothing while the UI shows "Force Pure Arb Active" — could be set at all.
Guarded for now in `saveConfig` (`bot.ts:187-198`) plus a UI-side patch, but the
invariant belongs somewhere declarative alongside the field definitions.

### 4. Arb legs pollute the directional edge gate

`closedPnls` (`edge.ts:7-19`) selects every closed paper trade with no filter on
`isArbLeg` / `packageId`, so arb legs feed the expectancy, win-rate and Kelly
figures that `evaluateEdgeGate` uses to decide whether *directional* trading has
proven itself. Arb legs are structurally paired (one leg near +$1/share, the
other near -$1/share) and say nothing about directional skill — e.g. the six
legs currently on record read as 50% WR with ~$2 average win and ~$1.94 average
loss, which is arb mechanics, not signal quality.

Consequences both ways: in `forceArbOnly` mode the 40-close `edgeMinTrades`
sample fills up with arb noise and can unlock directional trading (or live, via
`requireEdgeForLive`) on evidence that never tested a directional signal; and a
run of arb legs can equally suppress a genuine directional edge. The gate should
either exclude arb legs or score them in a separate bucket.

### 5. Tests write to the live data store

`tests/unit/arbEngine.test.ts` fixtures persisted into the real `data/` store —
a package with `slug: "eth-plan-test"` and tokenIds `"u"`/`"d"` ended up in
production package history and skewed `arbMetrics`. Tests need an isolated
`ZINGER_DATA_DIR`.

### 6. Observability gaps

- Skip/decline reasons log under types `'scan'` and `'signal'`, but the
  notifications panel only offers `all/buy/arb/sl/tp/announce/error`
  (`NotificationsPanel.tsx:80`) — the lines that explain "why no trades" are
  effectively invisible unless viewing "all".
- Window summary lines render UTC (`toISOString`, `bot.ts:494`) next to
  local-time log timestamps, which reads as a 1-hour skew during BST.
- `poly_actions.json` caps at 300 entries, so `'scan'`-type history is evicted
  quickly and multi-day investigations have nothing to work from.
