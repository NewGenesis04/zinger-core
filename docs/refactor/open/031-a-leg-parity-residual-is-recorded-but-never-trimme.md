> Open item 31 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

### 31. A leg-parity residual is recorded but never trimmed

`arbEngine.ts:215-244` detects when the two entry legs come back holding
different share counts, records `residualShares` / `residualOutcome`, logs, and
locks the package on `min(up, down)`. It does not *sell* the surplus, so a
breach leaves a small unhedged directional position open to settlement.

Should be unreachable today — both entry legs are fill-or-kill as of the
`placeMarketBuy` change, and FOK cannot partially fill, so the only drift
sources are tick rounding and price improvement. The gap is that the handler
exists to catch the case where that reasoning is wrong, and in that case it only
reports. Trimming needs a position-level sell path that does not exist yet;
`unwindLeg` (`arbEngine.ts:402`) closes a whole leg, not a fraction of one.
