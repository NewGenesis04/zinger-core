> Item 129 — filed 2026-10-08. **Fixed in the working tree 2026-10-08 (uncommitted); live only for sessions started after deploy.** See "What was changed" at the end.

### 129. Paper PnL is kept in two ledgers that use different conventions, and the stop path never charges its exit fee

The title of this file is from the first reading ("no fee term"). That was wrong; the evidence below shows two separate defects.

**Symptom.** On the running paper session, summed trade PnL (`session.pnl`, `stats.totalPnl`, `portfolio.realizedPnl`) is $10,174.14 and the cash gain is $4,411.04: a **$5,763.10 drift**. The reconcile trace reports `ok: false` on every pass (`equity drift`, `cash drift`, `session books Δ vs equity Δ`), while the `cashAudit` object served in the same `/api/poly/state` response reports `ok: true, issues: []`.

#### Defect A — two ledgers, two PnL conventions

| | Ledger 1: paper cash | Ledger 2: session/stats PnL |
|---|---|---|
| Owner | `ledger/cash.ts` (`createPaperCashLedger`), driven by `adjustPaperCash` (`bot.ts:434`) | `computeTradeStats` / `normalizeTrade` (`audit.ts`), `reconcileSession` (`sessionLedger.ts:134`) |
| PnL definition | **net**: `tradeNetPnl` = `(exit − entry) × shares − feesPaid` (`audit.ts:60`) | **gross**: `normalizeTrade` sets `pnl = tradeRealizedPnl` = `(exit − entry) × shares`, no fees (`audit.ts:28-37`) |
| Feeds | cash, `netPnl`, `cashPnl`, equity | `portfolio.realizedPnl` (`bot.ts:2031`, from `paperStats.totalPnl`), `session.pnl`, dashboard win rate |

`reconcileSession` compares **cash (net)** against `bankroll + portfolio.realizedPnl (gross) − openCost` (`sessionLedger.ts:155-157`). The gap is the fee total by construction, so the check cannot pass while `simulateClobFees` is on. The `cashAudit` flag (`bot.ts:2301`, `audit?.ok !== false`) does not read the reconcile result, which is why the two disagree. `sessionLedger.latest.feesPaid` is `0` on the host (`bot.ts:2329` passes `portfolio.feesPaid ?? null`; the paper portfolio never sets it).

The cash ledger's own documentation (`ledger/cash.ts:25-43`, item 23) states the intended convention: net, derived from primitives, because "records written before the fix carry a gross `pnl`". Ledger 2 was never moved onto it.

#### Defect B — the two stop paths charge no exit fee in paper

Stop-losses are 75% of paper exits (4,294 of 5,743 positions this session). Two of the three stop paths bypass `closePosition` and book the exit themselves:
- fast-SL (`bot.ts:~2884`): `adjustPaperCash(round(sellShares × fillPrice), …)`
- early-SL (`bot.ts:~3183`): same.
Neither computes an exit fee, sets `exitFee`, or recomputes `pnl`; `pnl` stays as `markPosition` left it, `(price − entry) × shares`. The third path, `closePosition` (`bot.ts:3702-3709`), charges the fee and writes a net `pnl`. Settle/other closes at `bot.ts:~5005` also charge it.

Host data (`poly_positions.json`, 5,743 paper positions this session):

| exit | positions | `pnl` equals gross | `pnl` equals net of entry+exit fee | Σ entryFee | Σ exitFee recorded |
|---|---|---|---|---|---|
| sl | 4,294 | **4,277** | 27 | $3,063 | $16.30 |
| tp | 972 | 1 | 972 | $1,122 | $468 |
| trail | 473 | 1 | 473 | $453 | $287 |
| settle | 4 | 0 | 4 | $6 | $0 |

Only 17 of 4,294 stop records carry an `exitFee`. The taker fee a stop would have paid at its fill price, `0.07 × p(1−p) × shares`, sums to **about $3,058** (estimate from recorded exit price and remaining shares). Live pays this fee; paper never debited it. This is paper optimism in the cash figure itself, not just in a report, and it is separate from the stop-fill cap in item 130.

The entry fee of every stop position, $3,063, is debited from cash at the buy (`bot.ts:1543-1544`) but never appears in the stop's `pnl`. That alone is $3,063 of the $5,763 drift. The remainder is not fully accounted for (see Defect C).

#### Defect C — a partial position's two records each carried the whole entry fee

`paperCash.reconcile` rebuilds paper cash from records (`booksCash`, `ledger/cash.ts`) and **overwrites the balance when it disagrees**; it is called at `bot.ts:4351` (feeds start), `4516` (bot start) and `561` (repair). So at each restart, cash becomes whatever the records imply.

For a position with a partial exit there are two records, and `tradeNetPnl` subtracts `feesPaid` from each. Both carried the **full** entry fee (`bot.ts:3611` accumulated the partial exit fee onto `pos.feesPaid`, then `bot.ts:3707` overwrote it with `entryFeeAlloc + exitFee`, where `entryFeeAlloc` was the whole `pos.entryFee`).

On the 98 partial/final pairs readable on the host (`poly_trades.json` joined to `poly_positions.json`): Σ recorded leg PnL $1,795.44 against Σ `tradeNetPnl` of both records $1,532.64, a **−$262.80** difference. The entry fee of those 98 positions sums to **$191.69**, so the double-counted entry fee explains about 73% of it. The rest (about $71) is not attributed; the partial PnL also pro-rated the entry fee with the wrong denominator (`positionShares(pos) + sellShares` evaluated before the share count was reduced, `bot.ts:3605`), which is a candidate, but it was not isolated.

Correction to an earlier draft of this item: it said the final record carries the original share count. It does not: `shares × entryPrice` equals the remaining `costBasis` on 98 of 98 final records, so final shares are the remaining shares.

Whether any restart this session actually shifted cash is **unverified**.

#### Drift behaviour

223 reconcile traces over 74 minutes (`session_ledger.json`): drift moved −$5,876.72 → −$5,972.54, no jump above $200, while realized PnL rose about $200. About 48% of each increment of recorded profit never reaches cash. This is consistent with Defect A+B (a per-trade cost missing from the gross figure), not with a one-time event.

#### What is and is not closed

- Established: Defect A and B from code and host data. Fees: Σ final-leg `feesPaid` $5,436 (53% of $10,174).
- Not established: the full split of the $5,763 across entry fees on stops ($3,063), partial-leg fees, and the Defect C artefacts. The older partial records are not in the tables I could read (`poly_trades.json` holds the latest 500; the 1,007 partial records are not otherwise stored).

#### Why it matters

Any PnL, win rate or profit factor computed from `session.pnl` or `trade.pnl` overstates the result by at least 57% of itself on this session, and by the missing stop exit fees on top of that. The conventions file requires the invariant "cash reconciles to trades + fees + open cost", and the ledger that should prove it is the one that fails.

#### Fix direction (as proposed; implemented below)

Single owner of "realized PnL of a position": one function over primitives, used by cash, stats, session and reconcile. Specifically:
1. Move `normalizeTrade`/`computeTradeStats` onto `tradeNetPnl`, or have both read one shared function.
2. Route the two stop paths through the same exit booking as `closePosition` so the exit fee is charged and `exitFee` recorded. This **changes paper cash and every paper figure downward**.
3. Record fees per leg (entry, each partial, final) so `feesPaid` cannot be overwritten, and allocate the entry fee by sold fraction.
4. Make the reconcile result the input to the `cashAudit` flag.
5. Invariant test: for any sequence of paper entries, partials and exits, cash equals initial + Σ proceeds − Σ costs − Σ fees, and `Σ record PnL` equals the cash change.



**Report:** `docs/paper-trader-performance-and-liquidity-report.md` §1B and §7.

#### What was changed (working tree, uncommitted)

One owner, `src/polymarket/paperLeg.ts`. Every paper exit leg is booked through `bookPaperExit` in `bot.ts`, which is now the only code besides the buy that moves paper cash.
- **Per-leg primitives in whole cents.** Each leg records `legProceeds` (the cash credited), `legCost` and `entryFeeShare` (the shares of the position's cost and entry fee it was allocated) and `exitFee`. Leg P/L = proceeds − cost − entry fee share, so it equals the cash ledger's movement for that leg exactly. The final leg takes whatever is outstanding, so the legs sum to the buy debit.
- **Entry state at the buy:** `costBasisRemaining` and `entryFeeRemaining` (cash terms: `round2(premium + fee) − premium`).
- **All paper exits routed through it:** fast-SL, early-SL, `closePosition` partial and final, the generic close, drawdown close and both repair closes. The two stop paths now charge the taker exit fee.
- **Defect A:** `normalizeTrade` returns net P/L for paper (`audit.ts`); `tradeNetPnl` uses the per-leg primitives when present, else the old formula, so historical records are read as before. `tradeFeesPaid` counts a leg's own entry share + exit fee.
- **Defect C:** per-leg allocation replaces the whole-fee-on-every-record; `feesPaid` accumulates instead of being overwritten. `booksCash` subtracts the outstanding (not original) cost and entry fee of open positions.
- **Reconciler:** `reconcileSession` takes `openEntryFees` and subtracts them from both expectations (an open position's entry fee has left cash but is in no closed trade yet); the paper portfolio now supplies `openEntryFees` and `feesPaid`.
- **Test:** `tests/unit/invariants.paperCashLedger.test.ts` (10 tests): for 60 random histories of entries, partials, stops, tp/trail/settle/dd/repair exits and open positions, `booksCash` equals simulated cash exactly, headline P/L equals the cash change plus what is tied up, stored leg P/L equals its recomputation from primitives, entry-fee shares sum to the fee that left cash, and legs sum to the whole. A source-level test pins that `bot.ts` has exactly two `adjustPaperCash` call sites (the buy and `bookPaperExit`).
- **Mutation check:** of six deliberate breaks, five are caught by the tests; the sixth (final leg not taking the remainder) survives because rounding to cents makes it equivalent at fractions within 1e-9 of 1. A direct allocation-sum property test was added for that function.

**Not changed, on purpose:**
- Live partial exits keep the old PnL expression (live money; not in scope). `normalizeTrade` keeps the gross definition for live.
- The `cashAudit.ok` flag (`bot.ts:2301`) still does not read the reconcile result, so the two audits can still disagree. Left as a follow-up.
- Historical records are not migrated. The running session keeps its old drift; new sessions are clean.
- Behaviour change to expect: dashboard realized PnL, win rate and profit factor are now net of fees and will be lower; stops now cost their exit fee.
