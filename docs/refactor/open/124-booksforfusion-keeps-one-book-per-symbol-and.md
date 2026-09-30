> Open item 124 — filed 2026-09-30.

### 124. booksForFusion keeps one book per symbol, and the last market scanned wins

**Found 2026-09-30**, while reading `bot.ts` for item 41. Not fixed inline.

`bot.ts:3090-3099` writes `botState.booksForFusion[sym]` inside the per-market loop, one slot per symbol (`btc` / `eth`), built from `depth.up ?? depth.down` of the market being processed. With several windows scanned per symbol (5m, 15m, 4h), whichever market the loop reaches last overwrites the others. `scan/inputs.ts:68-69` then hands that single book to `refreshFusionContext` for every signal of that symbol, so the ORDER_FLOW vote for a 5m entry can be computed from a 4h market's book.

The book is also the UP side's (`depth.up` first); DOWN's imbalance mirrors it on a shared book (research §11), so that part is consistent.

**Not fixed.** Direction: key the book by market, or select the market the signal is for. Which one is a design choice because the signal object is per symbol, not per market, so a fix needs to decide which window's book represents the symbol. Matters more now that item 41 makes the imbalance non-zero.
