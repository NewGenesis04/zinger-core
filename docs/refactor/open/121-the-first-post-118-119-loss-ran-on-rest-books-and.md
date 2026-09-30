> Open item 121 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

### 121. The first post-118/119 loss ran on REST books, and the residual now carries the P&L

**Found 2026-09-28**, from the two settled live packages on the VPS —
`pkg-eth-mugxs3bm` (2026-09-25 12:27 UTC, -$0.68) and `pkg-btc-muj6vasf`
(2026-09-27 02:17 UTC, -$0.59). Two things in those records contradict
assumptions written above.

**1. `pkg-btc-muj6vasf` was not a socket phantom.** Both of its leg records
carry `bookSource: null` alongside a non-null `bookAgeMs` (51ms UP, 421ms
DOWN). `leg.bookSource` is `depth[outcome].source` (`arbEngine.ts:1029`), and
only two paths write that field: the WS branch (`clob.ts:196`, `'clob-ws'`) and
item 119's forced read (`arbEngine.ts:723`, `'clob-rest-forced'`). The REST
branch stamps `bookTs` and no `source` (`clob.ts:210`). A null source with a
real age therefore means the book came from the **direct, unproxied venue REST
read** — the same call item 118's candidate direction 3 proposes to add before
leg 1. For contrast, `pkg-eth-mugxs3bm` carries `'clob-ws'` on both legs.

So the quote that cost $0.59 came from the venue endpoint. This does not kill
candidate 3, but it removes its assumed mechanism: "read the venue instead of
the socket" is not a control when the phantom came from the venue.

**Confirmed by the action log** (`poly_actions.json`, same packageId). The
re-read logged `bookRefreshed: true` with `freshDownAsk: 0.52`, and the leg
record carries no `'clob-rest-forced'` source — so `cacheUnmoved` was false and
`getDepthForMarket` returned a genuinely newer REST book. Item 119's forced
path neither fired nor needed to. The logged `tolerance`,
`0.23571428571428577`, equals `max(0.05, 9 × max(0.02, (0.01/0.42) × 1.1))`
exactly, which independently pins `arbLeg2BufferTicks: 1` and the reading of
`arbEngine.ts:852-853`.

Reconstructed from `bookAgeMs` and the log stamps (ms after 1790475475000):

| t | event | book |
|---|---|---|
| 516 | scan books stamped, REST | UP ask 0.50 · DOWN ask 0.42 (gap 0.08) |
| 567 | leg 1 dispatch | UP @ 0.50, $4.50 |
| 1471 | leg 1 filled | 9.00 sh @ 0.50 |
| 1938 | re-read, REST; exit decision | UP **bid 0.48** · DOWN ask 0.52 |
| 2359 | leg 2 dispatch | DOWN @ 0.53, $4.77 |
| 2771 | leg 2 filled | 9.54 sh @ 0.50 |

**2a. The scan gap is not consistent with UP's own book.** At t=1938 the venue
reported UP bid 0.48 against DOWN ask 0.52. UP's ask was 0.50 at t=516, so UP
sat at roughly 0.49 mid across the whole 1.4s and DOWN's fair value was
therefore roughly 0.51 throughout. A DOWN ask of 0.42 is nine ticks under that.
Two readings remain, and they have opposite fixes:

- **The 0.42 was never resting.** Then the phantom came out of the venue REST
  endpoint, candidate 3 reads the source that produced it, and the fix is a
  cross-leg coherence gate at scan — the depth object already carries
  `bestBid` on both sides (`clob.ts:195`, `clob.ts:210`), so comparing what
  DOWN's ask implies about UP against UP's own book costs nothing and needs no
  extra round trip.
- **The 0.42 was real and someone else took it** in the 1.4s leg 1 spent in
  transit. Then this is a latency loss, not a feed loss, and the fix is in
  dispatch time or depth sizing. Nothing the bot did consumed that ask — leg 1
  bought UP.

**ANSWERED 2026-09-28 — reading one is right, and it is worse than it looks.**
Measured live against the CLOB and written up as
`docs/research/polymarket-domain-facts.md` §11, confidence High: the two tokens
of a binary **share one order book**. `DOWN.ask(p)` and `UP.bid(1−p)` are the
same resting orders — exact to the size, over up to 143 levels, on both assets,
including a 50/50 book. Therefore

    ask_up + ask_down = 1 + spread >= 1.00 + one tick

in any snapshot read at a single moment; 20 parallel snapshots across two
captures, none below $1.00. Reproducible read-only via
`scripts/verify-complementary-books.mjs`; its `--sequential` control manufactured
a 0.980 sum on a live BTC book, with the ladder mirror at 0/84 flagging it. `ask_up + ask_down < 1.00` is **not an opportunity, it is a
stale read**, and the taker arb strategy has no positive-expectancy state on
this venue.

**Root cause, now located.** `getDepthForMarket` (`clob.ts:185-211`) fetches the
two tokens in a sequential `for` loop with an `await` inside, so the REST branch
reads UP and DOWN hundreds of ms apart by construction; `getPricesForMarket`
(`clob.ts:108-146`) has the same shape. Repeating the mirror test with the two
books fetched ~0.4s apart instead of in parallel drops the match rate from
143/143 to 0/5. The engine manufactures its own signal. Item 118's
`arbMaxBookSkewMs: 500` (`arbEngine.ts:261`) tolerates far more skew than it
takes to produce a ten-tick phantom.

This retires item 118 candidate direction 3: a pre-leg-1 venue read does not
help, because a second sequential read has the same defect. What it replaces it
with, cheapest first (2 is applied; 1, 3 and 4 remain operator decisions on
live money):

1. **Stop live arb firing.** Zero wins in 44 packages is what §11 predicts, not
   bad luck. Paper keeps running as the regression detector (D6/D7).
2. **Read both books in parallel** (`Promise.all` in `getDepthForMarket`). One
   change, removes most of the skew, and benefits every consumer of depth.
   **Applied 2026-09-29, operator go-ahead.** The REST fallback now issues both
   reads in one batch and gives them a single shared `bookTs`, since separate
   stamps would imply a skew that did not happen and would defeat the bound at
   `arbEngine.ts:261`. REST entries also carry `source: 'clob-rest'`; the branch
   previously set none, which is why `pkg-btc-muj6vasf` recorded
   `bookSource: null` and a REST book was indistinguishable from a missing one.
   Pinned by `tests/unit/invariants.bookSynchrony.test.ts`, mutation-checked
   against both a reverted await-in-loop and per-call timestamping. This also
   de-skews the directional path's order-book bias (`bot.ts:3073`), which read
   the same function.
3. **Gate on coherence, not on the gap.** `|UP.bid − (1 − DOWN.ask)| <= 1 tick`
   and its mirror, using `bestBid`/`bestAsk` already present in the depth object
   (`clob.ts:195`, `clob.ts:210`). Costs nothing, no extra round trip, and it
   catches exactly the desynchronised pair that §11's 1.040 outlier showed
   (ladder mirror 0/32 on a book whose sum had drifted).
4. **Treat `asksSum < 1.00` as a fault counter**, not a trade signal. The
   `arb.decision` events already carry `asksSum` (`arbEngine.ts:152`), so the
   distribution over the existing paper run measures how often the feed
   desynchronises — which is now the useful thing that number means.

**2b. Hedge vs unwind was an exact tie, broken toward hedging.** The exit
decision logged `upBid: 0.48` → `unwindEquivalent: 0.52` → `threshold: 0.53`
against `signedDownAsk: 0.53`, and `chooseLeg2Exit` takes
`signed <= threshold + 1e-9` (`arbEngine.ts:1166`), so the tie hedged. The
engine also logged `ARB EXIT OVER CAP ... -$0.27, over the $0.25 alert` 421ms
before the leg-2 order went out: the loss was announced in advance and the
alert is advisory by design (item 106).

The tie-break is nonetheless **correct here**, and the reason should be on the
record so it is not "fixed" later: §9d measured a SELL refused with
`balance: 0` 0.39s after a match, with settlement 2.15s after. The unwind would
have been dispatched 0.47s after leg 1 filled, almost certainly refused, and
leg 1 left naked while it retried. What is worth revisiting is that
`lockedLossUsd` (`arbEngine.ts:754`) omits both fees and the residual, so its
-$0.27 understated the realised -$0.59 by more than half — the alert threshold
is calibrated against a figure that is not the loss.

Note also that both re-read asks were stale **high**, not low: signed 0.53 /
filled 0.50, and signed 0.36 / filled 0.32. Book error here is two-sided, which
is evidence against any model of the form "the feed under-quotes leg 2".

**2. Item 31's premise is stale, and the residual is no longer sub-share.**
Item 31 reasons that a residual "should be unreachable today ... the only drift
sources are tick rounding and price improvement", and item 89's closure measured
a mean of 0.0121 shares/package. Leg 2 is now funded in dollars at the signed
ceiling by design (`arbEngine.ts:800`), so price improvement converts directly
into excess shares rather than saved cash:

| package | matched | residual | share of position | signed -> filled |
|---|---|---|---|---|
| `pkg-eth-mugxs3bm` | 15.862 | 1.982 DOWN | 12.5% | 0.36 -> 0.32 |
| `pkg-btc-muj6vasf` | 9.000 | 0.540 DOWN | 6.0% | 0.53 -> 0.50 |

Both exceed `legTolerance` (`arbEngine.ts:853`) and logged a parity breach.

This changes how the two packages should be read. `lockFromFills`
(`arbEngine.ts:1195`) books the guaranteed figure on `matched` only, which is
correct, but it makes `lockedProfitUsd` a **floor**, not an outcome:

- `pkg-eth-mugxs3bm`: $16.544 committed, payout $15.86 if UP resolves and
  $17.84 if DOWN does. **-$0.68 or +$1.30.** It was a 12.5% directional long
  DOWN that lost, not a locked loss.
- `pkg-btc-muj6vasf`: $9.594 committed, payout $9.00 or $9.54. **Unprofitable
  either way** — a genuine locked loss.

Reading the two as the same failure conflates a coin flip with an execution
loss, and the aggregate `settledProfitUsd` of -$1.27 hides that only $0.59 of
it was unavoidable once leg 2 signed.

**Not fixed.** The trimming question is item 31; what is new is that it now has
live P&L attached and its "should be unreachable" note should be struck. The
book-source question belongs to item 118 candidate 3, which should record that
a venue read is not a clean control for this defect.

**Status 2026-09-30.** Only step 2 (parallel reads) is applied. Arb has been
abandoned by the operator, so steps 1, 3 and 4 (stop live arb, coherence gate,
`asksSum` fault counter) are moot until arb is revisited; they are left
unapplied rather than closed. What survives for the directional path is the
parallel read: `bot.ts:2826`, `bot.ts:3074` and `bot.ts:4138` all call
`getDepthForMarket`, so the order-book bias and exit marks no longer read the
two sides at different moments. `scan/index.ts` destructured
`getDepthForMarket` without using it and `bot.ts` never passed it; the unused
name is removed.

---
