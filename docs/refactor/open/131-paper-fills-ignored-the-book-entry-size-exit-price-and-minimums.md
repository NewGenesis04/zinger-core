> Item 131 — filed 2026-10-08. **Implemented in the working tree 2026-10-08 (uncommitted); live only for sessions started after deploy.**

### 131. Paper fills ignored the order book: entry size, exit price, take-profit at the ask, and the 5-share minimum

**Symptom.** Paper booked any size at the best price. A ticket was `sizeUsd / ask` shares whatever was resting; exits filled at one price whatever the position size; and full take-profits filled at the **best ask** — a price a seller cannot get. The 5-share exchange minimum was enforced for live and ignored for paper.

**Evidence.**
- Entry: `bot.ts` `buildTradePlan` paper branch, `shares = sizeUsd / entry` with no depth input (line moved by this change).
- Take-profit fills at the ask: the full-TP call passes `fillPrice: tpMark`, where `tpMark = depth?.[outcome]?.bestAsk || prices?.[outcome] || price` (`bot.ts:~3873-3877`, original numbering). A sell hits the bid; the trigger may use the ask, the fill may not.
- Host data, 5,743 paper entries this session: median 20.8 shares; **1,534 (27%) under the 5-share minimum**; 1,177 tickets over $50 with a median of 175 shares (about 74% of gross profit). Of 1,064 partial exits, **170 (16%)** sold or left under 5 shares.
- Live public CLOB `/book`, 16 token books (BTC/ETH 5m, 4 snapshots, late window): best-ask size median 115 shares (5.2 to 1,520), 1 of 16 under 13; best-bid size median 118 (40 to 5,073); 12 to 87 levels per side. Small and late-window; indicative only.
- The WS depth shape carried top-of-book size only (`clobWs.ts`, `getClobWsAggregate`), so a ladder walk was impossible on the common branch.

**What was changed (working tree, uncommitted).**
- `src/polymarket/depthRealism.ts` (new, pure):
  - `planDepthEntry`: shares ≤ `floor(bestAskSize × participation)`; skip `thin_book` when that is under the minimum (a resting ask under 13 shares at 0.4); a sub-minimum budget is lifted to the minimum when affordable (mirrors the live guard at `bot.ts:~1282`), else `min_order_exceeds_cap`; an entry price that is not the best ask is refused (`no_executable_ask`).
  - `walkBook` / `paperSellFill`: a paper exit fills by walking the bid ladder. Size beyond the visible ladder fills 5 ticks below the worst visible level and is flagged `exhausted` (an assumption).
  - `planPartialExit`: neither the sale nor the remainder is under the minimum; a position under two minimums takes no partial.
  - `depthSnapshot`: the book as it was at the fill.
- `clobWs.ts`: `getClobWsAggregate` now also returns the bid and ask ladders, so both depth branches carry them.
- `bot.ts`: the paper entry is sized by `planDepthEntry` before the plan is built, with skip reasons recorded; stops (fast-SL, early-SL) and every `closePosition` exit except settle/redeem are priced by `paperSellFill`, **including full take-profits, which no longer fill at the ask**; partials use `planPartialExit` and the remaining share count is `held − sold` (it assumed the configured fraction); a skipped partial sets `partialSkipped` so it is not retried every tick (`kelly.ts` `checkPartialProfit`).
- Records now carry `entryDepth` (book and plan at entry, including `cappedBy`) and `exitBook` (book and walk at exit), so depth can be measured on every trade.
- Config (`modeConfig.ts`): `depthRealism` (true), `depthParticipation` (0.4), `enforceMinShareExits` (true). Setting `depthRealism` to false restores the old fills.
- Tests: `tests/unit/invariants.depthRealism.test.ts`, 19 tests; eight deliberate mutations are all caught.

**Assumptions, not facts.** The 0.4 participation fraction and the 5-tick exhaust price are modelling choices. Whether the 5-share minimum binds a **sell** is unverified (research doc §5, "Open: does `min_order_size` bind a SELL?"); the exit rule is behind `enforceMinShareExits` and applies to live too, where its worst case is a skipped partial. It needs a small live canary to settle.

**Not changed.** Settle/redeem exits (resolution price, fee-free), the drawdown and repair closes (rare, forced), the manual close path, and live entries. Arb entries are untouched. Entry realism applies to paper only.

**Expect.** Large tickets fall from ~175 shares to roughly 46 at the sampled median depth; combined with items 129 and 130 the next session's paper PnL will be well below this one. The first question it answers is whether the strategy is positive at that size after fees, bid-walked exits and the cap.
