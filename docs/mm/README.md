# Polymarket market-making research: where it stands and where to go next

Paper trading and public data only. Nothing here places live orders or spends funds.

## What is in this branch

| Area | Files |
|---|---|
| Strategy, paper session, inventory, recovery, journal | `src/research/mm/*`, `src/research/bookArbitrage.ts`, `src/research/depthState.ts` |
| Paper runner (resting quotes, connection-health freshness, reward accrual, caps, watchdogs, single-run lock) | `scripts/paper-mm.ts` |
| Reward-market scan, triage, universe, 24 h projection recorder | `scripts/mm-reward-{scan,triage,universe,projection}.mts` |
| Offline parameter sweep, walk-forward and capital simulation | `scripts/mm_param_optimiser.py`, `scripts/mm_walkforward_capital.py` |
| Independent auditors | `scripts/audit-mm-*.py`, `scripts/mm_*_audit.py` |
| Charts | `scripts/plot_*.py`, `scripts/build_mm_*.py` |
| Tests (227) | `tests/unit/mm*.test.ts`, `tests/unit/researchDepth.test.ts` |
| Reports | `docs/reports/ZINGER_MM_REPORT_2026-10-22.pdf` (positives first), `..._2026-10-21.pdf` (full 24 h + capital simulation), LaTeX sources in `docs/reports/latex/` |
| Design notes and run logs | `docs/mm/MM_*.md` |

## Results so far (24 h recording, 80 reward markets, split into train and test halves)

What worked:
- Reward qualification: our quotes were eligible for rewards in 7 of 7 markets; poly-maker managed 2 of 7 on the same data (`MM_POLYMAKER_BENCHMARK_2026-10-20.md`).
- Quote freshness: stale time fell from 72% to 0.7% after adding resting quotes and connection-health freshness.
- Positive markets: 29 of 40 liquid markets were positive on the test half, +$44.61/day on $9,874. These were selected after the fact.
- Spread of results: the median market made +$0.53/day. Settings with fewer than 0.5 fills/day were positive in 95% of markets.
- Small budgets: $100 to $1,000 allocations were positive in the capital simulation, but they rest on only 2 to 9 markets.

What did not:
- The liquid portfolio on the test half lost $42.44/day (−0.33%/day) on $12,975. Three markets with sharp price moves lost $71.44; the other 37 together made $29.00.
- A single setting applied to every market was negative at every quote distance.
- Thin-book markets lost 2.77%/day.
- Budgets of $2,500 and above were negative in the capital simulation.

There is no portfolio-level edge yet. There is a reward-capture edge, but adverse fills on sharp moves eat it.

## Directions (in order)

1. **Jump/news filter.** Pull quotes when the midpoint moves more than a set number of ticks inside a short window, or the touch empties. Rerun `mm_walkforward_capital.py` on the same split. Pass bar: the test-half portfolio is ≥ 0 with no single market below −$10/day.
2. **Multi-day out-of-sample test.** Record at least three more 24 h days with `mm-reward-projection.mts` and choose settings on day N, then test them on day N+1. One day is not enough to choose markets.
3. **Market selection rule set before testing.** Turn the low-interaction finding (under 0.5 fills/day) and the thin-book floor (competition ≥ 10,000) into a fixed filter, chosen before any test data is seen.
4. **Two-outcome quoting.** Quote YES and NO bids (and merge pairs), as poly-maker does, and model single-sided scoring at 1/3 when the midpoint is between 0.1 and 0.9. *Built 2026-10-28 (`--sides=both`, the default); merging pairs is not built. See `MM_CONTROLS_2026-10-28.md`.*
5. **Auditor update.** Teach `audit-mm-paper.py` the `resting-tolerance-v1` expiry policy and `connection-health` freshness.
6. **Forward paper run.** Only after 1 to 3 pass: a predeclared paper run (plan created before capture) with a $1,000 baseline, then $5,000.

Real capital stays conditional on a positive multi-day out-of-sample portfolio result. The risks are set out in the 2026-10-22 report.

## Live execution (built, locked)

`src/research/mm/live/` holds the order path the paper engine never had. It runs end to end in dry-run today. Live mode stays locked until the evidence gate passes.

| Piece | File | What it does |
|---|---|---|
| Executor | `executor.ts` | Post-only quotes, one order per token and side, cancel-before-replace, worst-case exposure caps, fill accounting (deduplicated; late, reversed and reconciled fills counted once), reconciliation (lost acks, closed orders, orphans, balance drift after a settlement grace window), heartbeat, latched kill switch, journal restore |
| Dry-run venue | `venue.ts` | In-memory exchange. Resting orders fill only when the public book trades through them |
| CLOB adapter | `clobVenue.ts` | `@polymarket/clob-client-v2`: GTC post-only orders, batch cancel, cancel-all, open orders, order status, server heartbeat (the exchange cancels our orders if heartbeats stop), conditional token balances. SDK error objects count as failures, never as acks |
| User channel | `userChannel.ts` | Our trade events from the user WebSocket. MATCHED/MINED/CONFIRMED count once; FAILED reverses. Missed messages are recovered by reconciliation |
| Arming gate | `gate.ts` | All checks must pass: `ZINGER_MM_LIVE=1`; `ZINGER_MM_LIVE_ACK` set to the hash of the exact limits; limits within the canary ceiling ($200 portfolio, $50/market, 100 shares/order, $20 loss; `--budget=100|200` picks the profile); no kill file; no proxy; region allowed from the real egress; collateral covers the cap; ≥3 positive out-of-sample days with a positive portfolio result |
| Market stop | `executor.ts` | A market whose cash plus marked inventory falls below `-maxMarketLossUsd` ($2.50 at `--budget=100`, $5 at `--budget=200`) stops for the UTC day: quotes cancelled, held shares sold by fill-and-kill at the best bid once nothing of it rests. Other markets keep quoting. Live needs it on (gate check `market_stop`) |
| Command Center watch | `watch.ts`, `/api/mm/*`, `frontend/src/components/MmLivePanel.tsx` | Operator-only **MM Live** tab: run state, P&L against the loss limit and each market stop, resting quotes, action feed, kill button. The runner writes `status.json` every cycle |
| Evidence | `scripts/mm_evidence.py` | Replays days recorded after the settings were fixed and writes `tmp/mm-live/evidence.json` for the gate |
| Runner | `scripts/mm-live.ts` | `preflight` (read-only; `--auth` adds balance, open orders and holdings) and `run` (dry-run by default) |

```bash
npx tsx scripts/mm-live.ts preflight --markets=<conditionId,...>
npx tsx scripts/mm-live.ts run --markets=<conditionId,...> --minutes=10
```

Safety behaviour added after review (NewGenesis04/zinger-core#2):
- Every exit path cancels and then checks that nothing rests, including thrown errors.
- A halt that lands mid-cycle stops further submits.
- Reconciliation and heartbeats keep running while public books are down, and quotes are pulled after 30 s without books.
- An order is closed only on a terminal venue status. Three failed lookups halt.
- A failed trade reverses quantity already taken from reconciliation.
- There is a per-event cap.
- A lock file (`tmp/mm-live.<mode>.lock`) allows one runner at a time. It is kept if shutdown is not confirmed clean.
- A loss ledger (`tmp/mm-live/loss-ledger-<mode>.json`) makes earlier sessions count against the loss limit.
- The gate also rejects a non-default `CLOB_API_URL` and every write relay variable.
- Malformed balances fail preflight and reconciliation instead of reading as zero.

Live mode also needs a dedicated wallet with no open orders and no holdings in the quoted tokens. Any order the executor did not place is treated as an orphan: it is cancelled and the executor halts. To stop, press Ctrl-C, send SIGTERM or create `tmp/mm-live.KILL`. Every stop cancels all orders and then checks that none rest.

First dry run (2026-10-23, 5 House-seat markets, 3 minutes, 1 tick behind the touch): 3 quotes placed and held with no churn, and a clean shutdown. The other two markets were held back because their 50-share reward minimum costs more than the $25 per-market cap.

Known limits: one outcome is quoted per market (YES bid, plus a YES ask when shares are held). Maker rebates and rewards are not booked. The dry-run fill rule is conservative and shows nothing about live queue priority.

## Reproduce

```bash
npx tsx scripts/mm-reward-scan.mts
npx tsx scripts/mm-reward-projection.mts --universe=<universe.json>
python3 scripts/mm_param_optimiser.py <run-dir> <universe.json>   # run on train-half and test-half dirs
python3 scripts/mm_walkforward_capital.py <dir-with-train-and-test> <run-dir>
npx vitest run tests/unit/mm*.test.ts
```

Mainnet steps, checks and stopping: `MM_MAINNET_RUNBOOK.md`.
