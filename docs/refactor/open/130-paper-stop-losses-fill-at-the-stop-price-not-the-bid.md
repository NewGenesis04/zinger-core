> Item 130 — filed 2026-10-08. **Fixed in the working tree 2026-10-08 (uncommitted); live only for sessions started after deploy.**

### 130. Paper stop-losses fill at the stop price, not the bid

**Symptom.** Paper stops book losses of at most stop% + `slMaxSlippagePct` regardless of the book, so paper losses are bounded and live losses are not. The paper result is optimistic by an amount the ledger cannot show.

**Evidence.**
- `bot.ts:1933-1945` (`resolveSlFillPrice`): paper returns `max(markBid, entry × (1 − (effectiveSl + slip)/100))`; live returns the real bid. The comment states the intent ("so gaps can't book -56% on a 10% stop").
- `bot.ts:3535-3537`: the stop exit records `markBid: price` and `fillCapped: fillPrice > price + 0.0005`.
- Host data, latest 500 closed trades (`poly_trades.json`, 2026-10-08): 292 stop exits, all with `markBid`. Exit price exceeded the recorded bid by 7.2 cents on average (median 4.4), by more than 2 cents on 193 and more than 10 cents on 76; 268 of 292 exited exactly at the stop floor. Re-pricing at the recorded bid removes about $1,591 from a window that shows +$1,351.74 gross (about -$239 gross, before fees).
- `fillCapped` is true on 254 of 500 trades.

**Caveats.** `markBid` is the bid on the triggering 250 ms tick; real fills could be better (bounce) or worse (thin top bid swept by a large position). The window is recent and large-ticket heavy.

**Related, same code path: the stop never pays an exit fee (item 129, Defect B).** Fast-SL and early-SL (`bot.ts:~2884`, `~3183`) credit raw proceeds and charge no exit fee; 4,277 of 4,294 stop records are gross, with about $3,058 of fees never debited. Together with the fill cap, a paper stop is cheaper than a live stop by both the price (this item) and the fee (item 129). The two should be fixed in one change, since both live in the stop-booking code.

**Fix direction (proposed, then implemented).** Fill paper stops at the observed bid, or by walking the recorded book for the position size, and report `fillCapped` exits as a separate loss bucket until removed. Add an invariant: a paper sell never fills above the best bid on the tick that triggered it. 

**Report:** `docs/paper-trader-performance-and-liquidity-report.md` §7A.

#### What was changed (working tree, uncommitted)

- `resolveSlFillPrice` moved out of `bot.ts` into `src/polymarket/paperLeg.ts` and returns the observed bid for paper and live alike; the `entry × (1 − (stop + slip)%)` floor is gone. `slMaxSlippagePct` is now unused by the fill (left in config).
- The stop-fee defect (item 129, Defect B) was fixed in the same change: both stop paths now go through `bookPaperExit` and charge the exit fee.
- Tests: `invariants.paperCashLedger.test.ts` asserts that a gap-through bid of 0.26 fills at 0.26 (not at the stop floor), that no fill exceeds the observed bid for any bid and stop width, and that paper and live fill identically. A mutation that restored the clamp is caught.
- `fillCapped` is now always false for new records; it is left in the record shape.
- Expect a large drop in paper PnL on the next session: the latest 500 trades lose about $1,591 from the fill price alone, before the exit fee.
