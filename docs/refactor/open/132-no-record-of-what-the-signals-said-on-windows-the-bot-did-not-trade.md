> Item 132 — filed 2026-10-09. **Implemented in the working tree 2026-10-09 (uncommitted); collects only while the bot is running, from the first session started after deploy.**

### 132. No record of what the signals said on windows the bot did not trade, so no signal could be tested

**Symptom.** Whether the directional signal has any edge could not be answered from stored data. The trade records hold only the windows the bot chose to enter, at prices that passed its gates, and carry the final `direction` and `confidence` but none of the inputs (no ML trace, no `confidenceBias`, no book). Every measurement below had to be reconstructed from outside (Gamma resolutions, Binance candles), and the one thing that could not be reconstructed was the market price at an arbitrary moment: the CLOB `prices-history` endpoint returns a point only when a trade happens (472 of 8,016 checkpoints had a price under 30 seconds old).

**Evidence (all measured 2026-10-08/09, scratch scripts, not committed).**
- Last paper session (352 trades, $100 to $2.27, fees $69.14): the side bought won at settlement **47.9%** against 50.3c paid (edge -2.5 pts, SE about 2.7). 89% of trades hit the stop.
- Earlier archive (5,847 trades, 2,543 windows): **50.7%** against 50.2c (edge +0.5, SE 0.7). The old +$11k came from the pre-129/130/131 accounting, not from direction.
- A strike-distance model, `P(up) = Φ(ln(S/K) / (σ√τ))`, with Binance spot against Binance's own window open, was right 58.7% / 66.2% / 74.3% at 1 / 2 / 3 minutes into a 5m window and 60.5% / 75.1% at 5 / 10 minutes into a 15m window. Against Gamma's `priceToBeat` as the strike it was less accurate (69.7% vs 74.3% at 3 minutes), consistent with a Chainlink/Binance basis.
- Accuracy is not edge. On the bot's own entries (where asks were available), cases where that model said about 75% while the ask was about 50c won 52% (n=642): the market was closer to right. Those entries are a biased sample (the bot trades near 50c), so the 60-85c mispricings, which are the interesting ones, were never observed.
- Books at entry were fresh (median age 0.1s, p99 1.0s), so the cheap asks were not stale quotes.
- ML: only `confidence.ts` (a bounded bias on confidence) and the regime flag consume it in the wired path; the `mlOverride` branch exists only in `scan/inputs.ts`, which is not wired (item 95). Stored validation accuracy for the 18 models is mostly 0.39-0.57 on validation sets of about 119 samples (0.4538 and 0.5462 are 54/119 and 65/119, exact complements, the signature of a constant predictor).

**What was added (working tree, uncommitted).**
- `src/polymarket/signalShadow.ts`: owns table `signal_shadow`. One row per window per 20 seconds (not in the first or last 10 seconds): TA direction, confidence and score; the ML trace points; the strike-distance probability against both the oracle strike (`market.priceToBeat`) and the Binance minute-open at window start; per-minute volatility from completed minutes strictly before the row; both tokens' bid, ask and sizes with the book timestamp and source; and, filled in later, `outcome_up`, `final_price`, `open_price`. A resolver reads the settled result from Gamma `/events?slug=` (8 windows per run, once a minute at most, backed off per window, abandoned after 6 hours) and records a result only when the market has settled to a clean 1/0.
- Hook in `bot.ts` `scan()`, directly after the per-market depth read and before any `continue`, so a market with an open position is sampled like any other. The call is synchronous and the resolver is `void`ed; neither is awaited.
- `index.ts`: `startSignalShadow(onSpotTick)` beside the arb sink; the spot tick stream feeds a 3-hour per-minute buffer.
- `modeConfig.ts`: `signalShadow` (true). `false` stops writes; nothing else changes.
- `scripts/signal-shadow-report.ts`: read-only report with pre-registered hypotheses H0 (TA direction), H1 (model accuracy by share of window elapsed), H2 (buy the model's side at the ask, hold to settlement, net of the taker fee, by gap over the ask), H3 (ML trace vote). Edge is computed per window, not per row, with the standard error across windows, and H2 is printed for the whole data and each half.
- Tests: `tests/unit/invariants.signalShadow.test.ts`, 26 tests; 14 deliberate mutations are all caught (one survived once, a half-settled price payload, and the test for it was added).

**How to read it.** Take a consistent snapshot from the VPS (VACUUM INTO, per `scripts/audit-store.ts`), then `npx tsx scripts/signal-shadow-report.ts snapshot.db`. A bucket counts only if it is positive in both halves and its net per share is more than twice its error. Break-even is the taker fee (about 3.5% of cost at 50c) plus the spread; hold-to-settle pays no exit fee.

**Storage.** About 16,500 rows a day for BTC and ETH on 5m and 15m, about 6 MB a day, 14 days retained (`SIGNAL_SHADOW_RETENTION_DAYS`). The table is separate from `docs`, so a failure cannot touch trade state.

**Residuals and assumptions.**
- It logs only while the bot is running (it rides the scan loop). A stopped bot logs nothing; a paper session is the intended way to collect, and it trades as it always did.
- Volatility needs about 20 completed minutes after a restart, so `p_up_*` is NULL (not 50%) until then. The buffer is in memory.
- `depth` is null when `useOrderBookBias` is false and no position is open; those rows carry no book and are excluded from H2.
- Spot is Binance, a proxy for the Chainlink 60s TWAP the market resolves on (research doc §4); the oracle-strike probability inherits a basis. A resolution-source feed would be a separate item.
- `ml_json` stores the trace points the confidence buffer already holds; it does not call the ML service.
- Nothing here changes a decision. Whether any signal should trade is a separate decision to be made from the report.
