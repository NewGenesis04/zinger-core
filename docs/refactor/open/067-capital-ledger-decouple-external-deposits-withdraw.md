> Open item 67 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

### 67. Capital Ledger: Decouple external deposits/withdrawals from trading PnL & remove `lifetimeBaseline` UI alarms

**OPEN, UX / Accounting improvement.** Found 2026-09-08 after operator noticed the live
dashboard card rendering a prominent warning note:
`Baseline $275.16 is $10.13 BELOW lifetime $285.29 — a past drawdown was rebased over...`.

**The Defect in `lifetimeBaseline`:**
1. `lifetimeBaseline` (`liveAccount.ts:203`) records only the very first dollar balance seen
   on the wallet (`$285.29`). Any subsequent deposit (e.g., adding $500) or withdrawal
   corrupts the calculation, falsely attributing external cash flows to trading profit/loss.
2. Surfacing forensic rebase notes in the primary operational dashboard card causes severe
   alarm fatigue—an operator sees red/yellow text and assumes the ledger is broken when
   `books clean` is true and trading is healthy.
3. External capital flows (deposits/withdrawals) are currently conflated with strategy
   alpha.

**The Architecture: Dedicated Capital Ledger & 3-Layer Flow Detection:**

1. **UI Cleanup:** Strip `lifetimeBaseline` warning strings from the live execution header.
   The main dashboard card reports pure operational metrics: `Spendable Cash`,
   `Session Realized PnL`, `Realized Trade PnL (closed trades sum)`, and `Open PnL`.
   Forensic rebase provenance is relegated strictly to `/api/poly/audit`.
2. **Three-Layer Flow Detection Mechanism:**
   - **Mechanism 1 (On-Chain ERC-20 Logs):** Query Polygon bor RPC for `Transfer(to: Safe)`
     and `Transfer(from: Safe)` for USDC (`0x3c49…`) and pUSD (`0xC011…`) (scaffolded in
     `src/polymarket/deposits.ts:30-48`). Cryptographic proof of on-chain funding.
   - **Mechanism 2 (Polymarket Activity API):** Query
     `GET https://data-api.polymarket.com/activity?user=${depositWallet}&type=DEPOSIT,WITHDRAWAL`
     to capture web UI card/moonpay/bridge transactions.
   - **Mechanism 3 (Delta Reconciler Fail-Safe):** On every balance sync tick, compute
     `Unexplained Delta = (Cash_now - Cash_prev) - sum(Trade Fills & Fees)`.
     Any discrepancy > $5 with 0 trade fills automatically categorizes as `CAPITAL_DEPOSIT`
     or `CAPITAL_WITHDRAWAL` in SQLite (`data/zinger.db`).
3. **Account Size Time-Series (Equity Curve):**
   Record periodic snapshots of `(timestamp, cash, openPositionsValue, equity, netDeposits, cumulativeTradePnl)`
   allowing an institutional equity curve that separates account size growth from pure
   time-weighted trading alpha.
