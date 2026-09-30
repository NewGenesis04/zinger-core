> Open item 48 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

### 48. The D8 decision-emitter tee plan, checked against the code ✅ IMPLEMENTED (Steps A–F shipped in `c7e53d1` & `9d2667e`)

**Status 2026-09-08 — implemented, one verification gap left.** Step B's HTTP and
SSE layer is now verified on the VPS (see "Step B — what is verified and what is
not" below). Step C's gap stands: the trade and exit tees still have no unit
tests, and the invariant *exactly one `position.exit` per exit, one
`trade.execution` per trade* is unproven. That is blocked on the D4 position
manager owning the exit path, not on effort here. **Do not mark this FIXED until
that invariant is testable.**

Proposed 2026-09-03: execute D8's deferred decision emitter (slice 1 progress
table, `docs/refactor-plan.md:508`) as five tees plus four interface additions,
feeding an external "Forensics Truth Engine" that permanently records the event
stream. Every tee is additive — `emitEvent(...)` *beside* the existing
`persist()` / `log()` / `appendFileSync()`, never instead of it — so paper
trading keeps running unchanged.

The anchors were checked. Most hold: `clobReceipts.ts:109`
(`fs.appendFileSync(RECEIPT_LOG…)`), `bot.ts:377`
(`botState.trades.unshift(normalized)`), `liveAccount.ts:282,298,316,338`
(the four `saveStore` calls), `bot.ts:3767` (`persistSync(archiveFile…)` in
`resetLiveData`), `bot.ts:2371` (`buildDecision`), `bot.ts:2450`
(`resolveOrderSize`), `directional.ts:322-330` (`bookMeta`). The event bus is
`src/polymarket/telemetry/events.ts`, not `src/lib/events.ts`; auth is
`src/lib/auth.ts`, not `.js`.

Seven findings. Two change the shape of the work; the rest are corrections.

**a. Every fact the tees emit already emits once.** `log()` maps the log `type`
onto an `EventType` (`bot.ts:1053-1058`):

```
type 'sl' | 'tp'          -> position.exit
type 'buy'                -> trade.execution
meta.arb | type 'arb'     -> package.settlement
type 'signal'             -> trade.decision
everything else           -> system.alert
```

So a rich `emitEvent('trade.execution', normalized)` at `bot.ts:377` does not
*add* the trade event — it adds a **second** one, with a different shape, beside
the message-shaped one every `log(…, 'buy', meta)` already produces. Same for
`position.exit` and `trade.decision`. A truth engine that counts events would
double-count every trade and every exit, and the two records would disagree.

This is the decision the plan has to make before any tee lands: **who owns each
event type**. Recommended — the explicit tee owns the typed types, and the
`log()` mapping collapses to `system.alert` for everything. That keeps one
writer per type, which is the same rule D5 applies to cash. The alternative
(a discriminator field on each event) leaves two writers and asks the consumer
to reconcile them.

**b. The exit sites are undercounted, and there is a better seam.** The plan
names three (`~2030-2045`, `~2284-2298`, TP `~2108`). There are at least twelve
`log(…, 'sl'|'tp', …)` calls: `bot.ts:937, 2045, 2108, 2299, 2676, 2812, 2831,
2840, 2854, 2866, 2891, 3885, 3919`. Teeing per-site means thirteen edits that
drift apart.

Six of them are already funnelled through one helper —
`closePosition(exitReason, extraMeta)` (`bot.ts:2583`), called at `:2810, 2830,
2839, 2853, 2865, 2878, 2890`. That is the single owner for the settle/TP/SL/
trail/partial family. The fast-SL paths (`:2044`, `:2298`) and the flatten path
(`:937`) bypass it and would need their own tee, or to be routed through it.

While counting: `bot.ts:3919` logs a PM-wallet asset sell as type `'sl'`, so it
currently emits a `position.exit` carrying `{assetId, size, orderId}` and no
symbol, slug, or PnL. That is a phantom exit in the event stream today,
independent of this work.

**c. The buffer wraps faster than any poller can drain it — this is the
load-bearing constraint.** `TelemetryBus` is an in-memory ring of 5000
(`events.ts:5, 52-55`) with no persistence and no drop counter. `scan()` is
driven by `setInterval(scan, POLY_SCAN_INTERVAL_MS)` where the interval is
**250 ms** (`bot.ts:3545`, `config.ts:19`), and PR-4 emits one `trade.decision`
per market per outcome inside `for (const market of tradableMarkets)`
(`bot.ts:2155`) × `for (const outcome of targetOutcomes)` (`bot.ts:2362`).

At *M* tradable markets, 2 outcomes, and *S* completed scans per second, the
ring holds `5000 / (2·M·S)` seconds of history. Even at a conservative M=4, S=1
that is ~10 minutes; at S=4 it is ~2.6 minutes. **M and S have not been measured
on the VPS — measure before sizing anything.** The consequence either way: any
Truth Engine outage longer than the wrap window loses decisions *silently*,
because the buffer exposes no oldest-id and no eviction count.

Three ways out, in increasing order of work: raise the cap via `setCapacity`
(`events.ts:35`) and accept a bounded window; have the bus append to a JSONL
sink the way `clobReceipts.ts:109` does, and let the engine tail the file;
or emit decisions at a lower rate than the scan loop. Not a detail to settle
during PR-4 — it decides whether the transport can carry PR-4 at all.

**d. `after=<event_id>` needs a gap signal, and ids are not durable.** The
existing `since` filter compares `e.ts >= since` (`events.ts:79`) with
millisecond stamps, so a poller either re-reads or skips events sharing a
millisecond — the ask is correct that a cursor is needed. But on a ring buffer,
a cursor whose id has been evicted is indistinguishable from "nothing new".
`after=` must return the oldest retained id and an explicit dropped flag, or the
lossy case is invisible. Also `clear()` resets `seq` to 0 (`events.ts:116`),
and ids are `evt-${Date.now()}-${seq}` (`events.ts:45`) — after a clear, ids can
repeat. Only tests call `clearEvents()` today, but a cursor makes that a
correctness property, not a curiosity.

**e. Typed payload interfaces buy almost nothing where they are aimed.**
`events.ts:1` is `// @ts-nocheck`, as are `bot.ts:1`, `directional.ts:1`,
`liveAccount.ts:1` and `server.ts:1`. Five of the seven emit sites are in files
the compiler does not check; only `arbEngine.ts` and `clobReceipts.ts` are
checked. Replacing `data: Record<string, any>` (`events.ts:22`) with per-type
interfaces is worth doing as documentation, but it will not catch a malformed
payload at `bot.ts:2371`. If the schema needs to actually hold, it needs a
runtime check in `emitEvent` — related to item 32.

**f. Widening `bookMeta` is not low-risk, and collides with open item 41.**
`getDepthForMarket` (`clob.ts:165`) has two paths. The REST path returns
`normalizeLevels(...)`, which does carry `bids`/`asks` ladders with cumulative
size (`clob.ts:43-57, 73-75`) — so on that path the ladder genuinely is already
fetched. The WS path (`clob.ts:171-179`) returns
`{bestBid, bestAsk, mid, spread, source}` and **no ladder at all**, and it is
preferred whenever the socket book is fresh, which is the common case. So the
tee would emit a ladder exactly when data is stalest and omit it when data is
freshest — the inverse of what a forensic record wants, and easy to misread as
"the book was empty". The real fix is item 41, which the backlog already records
as touching the live price path stop-losses mark against.

**g. Interface ask #4 is already implemented.** `extractToken`
(`auth.ts:110-119`) already reads `Authorization: Bearer <token>` before falling
back to `?token=` / `?auth=` and then the cookie, and `requireAuth`
(`auth.ts:165`) uses it for every `/api/*` route. The Truth Engine needs an
`issueToken()`-signed token, not a code change. Zero work.

#### Settled in review with the operator, 2026-09-03

**The consumer is a client, not a component.** The Forensics Truth Engine is one
client of the event stream, on the same footing as Zinger's own dashboard and
any future reader. Nothing in `polymarket/` may reference it, be shaped around
it, or special-case it. The emitter's obligation is a complete record of what
the process did; what any client does with that is the client's business. This
is D8's own split — the viewing/analysis client is explicitly out of scope
(`plan:198-202`) — restated because the tee plan arrived from the client side
and could easily drag client concerns across the line.

**i. Ownership: the explicit tee owns each typed event; `log()` keeps only
`system.alert`.** Resolves finding (a). One writer per event type, the rule D5
applies to cash. The `bot.ts:1053-1058` type-guessing mapping is deleted, not
extended — it reconstructs an `EventType` from a human-chosen string tag and
ships prose as the payload, which is the pre-D8 direction wearing an event
costume. Any `log()` call whose fact deserves a typed event gets an explicit
`emitEvent` beside it; everything else is an alert.

**ii. No rendered string is stored in the event.** Considered and rejected.
A rendering is derivable from a complete payload at any time, so it can be added
later for nothing; a payload field never captured is unrecoverable forever. That
asymmetry puts all the effort on payload completeness. Storing the line also
weakens the incentive that D8 exists to create — if the readable line is already
in the record, an author has less reason to care whether the payload is whole,
which is how 44% of `log()` call sites came to pass no `meta` at all.
`formatEventAsLog` (`events.ts:147`) stays, serving Zinger's own dashboard as
one client's projection. It does not define the record.

**iii. No prose inside payload fields — code plus value, the client renders.**
The direct consequence of (ii), and the substantive schema rule for step A.
A field whose value is a sentence is a string that a client can display but
cannot filter, count, aggregate, or diff. Two live instances, both inside what
PR-4 would emit:

- `directional.ts:334` — ``reasons.push(`arb gap +${(arbGap*100).toFixed(1)}c`)``
  and `:342` ``  `ultra-tight spread ${spreadPct.toFixed(2)}%` ``. `reasons[]`
  looks structured and is an array of sentences.
- `bot.ts:3057` — `summary: market.decision?.summary`, prose inside the
  `scan.cycle` markets array.

The rule: every reason is `{code, value, delta}` — a stable enum code, the
number that triggered it, and its score contribution. Every `skipReason` is an
enum plus the operands that produced it, never `'confidence 41% < 45%'`. The
client turns those into whatever text, table or chart suits it.

**iv. Transport before volume.** The Truth Engine reads from source over SSE
(ask #3), subscribing via `onEvent('*')` (`events.ts:138`), which delivers at
emit time and never touches the ring buffer. While connected it cannot lose
events at any buffer size. The buffer therefore sizes **disconnect tolerance**,
not history — "how long may the client be away before reconnecting loses data"
— which is a far smaller number than "how much history do we keep". The JSONL
sink floated under (c) is demoted to a possible crash backstop for events lost
when the process itself dies; it is not the read path, and it may not be needed.

Two constraints this puts on the SSE route: writes must be non-blocking or
drop-on-backpressure, because `emitEvent` notifies subscribers **synchronously
on the scan loop's stack** (`events.ts:57-58`) and a stalled socket would stall
scanning; and reconnect must be able to catch up, which is what makes the
`after=` cursor with its gap signal (d) part of the same step rather than a
later nicety.

**v. Interface ask #4 is dropped as already implemented** — see (g).

**Sequencing, as amended:**

| Step | Content | Gate |
|---|---|---|
| 0 | ~~measure M and S~~ — done 2026-09-04, see *Buffer sizing* below; **not a gate**, the cap is an env var tuned against (d)'s gap signal | operator sign-off on (i)-(v) |
| A | ✅ **done 2026-09-04.** Four new union members, a payload interface per event type under rule (iii), `formatEventAsLog` cases for all four plus `config.attributed` (which had none and fell through to raw JSON), `TELEMETRY_SCHEMA_VERSION` 1 → 2. `EventType` is now `keyof TelemetryEventPayloads`, so the union cannot drift from the registry. **`// @ts-nocheck` removed** — the file is type-checked, without which the interfaces would be decoration (finding e). Transitional `LegacyMeta` index signature on the payloads `log()` still feeds, documented to come off per type as each tee takes ownership in C-E. | `tsc` clean · 360/360 tests · smoke run of all four new types; runtime inert, nothing emits them yet |
| B | ✅ **done 2026-09-04.** `GET /api/poly/events/stream` (event-native SSE, one frame per event at emit time) + `after=` on `/api/poly/events`. Bus gained an eviction counter and `queryEventsPage` returning `{events, oldestId, newestId, dropped, evicted, hasMore}`. Reconnect is lossless: subscribe → queue → replay from cursor → drain queue, deduped. Cursor reads front-slice, never tail-slice. `res.write` buffers rather than blocking, so a client is dropped past 1 MB unflushed (`SSE_MAX_BUFFERED_BYTES`) instead of growing the heap. | `tsc` clean · 367/367 · 7 new invariants, both key ones mutation-checked (front-slice→tail-slice and `dropped=false` each killed 2 tests). **HTTP layer not yet exercised against a running instance** — see below |
| C | ✅ **done 2026-09-04.** Receipts tee in `clobReceipts.captureReceipt` (second sink, JSONL still the durable copy). `trade.execution` tee in `saveTrade`, placed after both dedupe guards so a suppressed duplicate write emits nothing. `position.exit` routed through one new `emitPositionExit` helper called from all four real exit paths — `closePosition` full close, its early-returning partial branch, fast-SL and early-SL, the last two of which bypass `closePosition` entirely. `log()`'s type-guessing map collapsed per (i): it now emits only `system.alert`, plus `trade.decision` until step E. | `tsc` clean · 369/369 · 2 new invariants on the receipt tee. **The exit and trade tees are not unit-tested** — see below |
| D | ✅ **done 2026-09-04.** `account.cash` teed inside `liveAccount.saveStore` — one site, not the four `saveStore` callers, since the persist boundary *is* the cash-state transition. `account.reset` at both resets, live and paper, emitted after `saveBaseline` so it carries the baseline actually written. `system.alert` gained `kind`, taken from `meta.kind` and never inferred from message text; `lifecycle` on start/stop, `health` on readiness **transitions only** (the check runs on a timer — emitting every cycle would drown the edge that matters), `data_gate` on the assurance block. Bus fan-out now isolates subscribers. | `tsc` clean · 374/374 · 5 new invariants on subscriber isolation, mutation-checked (reverting `fanOut` to `emit` killed 4) |
| E | ✅ **done 2026-09-04.** `trade.decision` via `emitDecisionEvent`, once per market per scan at `enriched.push` where candidates, selection, sizing and action are all known — carrying inputs, scoring with `reasonCodes`, the losing outcome's score and reasons, the kelly chain with caps, and `output.skipReason`. Six post-scoring gates now record *why* an eligible candidate did not trade. `arb.decision` in `detectAndExecuteArbPackage` at five skip gates plus the open. Rule (iii) applied to all 43 `reasons.push` sites in `directional.ts` via an `addReason` helper that records prose and `{code, value, delta, operands}` together. `log()`'s last typed arm removed — it emits `system.alert` unconditionally now, handover complete. | **0 mismatches over 300,000 combinations**, harness mutation-checked (altered string → 2,091; weight 160→161 → 15,504; dropped reason → 12,094). `tsc` clean · 378/378 · 4 new reason-code invariants, mutation-checked |
| F | ✅ **done 2026-09-04, but NOT as specified.** `GET /api/ops/dump?key=` returns a doc plus its `updated_at` via a new `sqliteLoadWithMeta`. It is **allowlisted and operator-only**, not the general key reader the ask described — see item 52 for why that version would have handed the wallet private key to the read-only viewer password. No key returns the allowlist. | `tsc` clean · 379/379 · a regression test asserting `viewerDenial` does *not* cover `/ops/dump`, so the in-route role check cannot be "simplified" away |

New `EventType` members: `trade.execution.receipt`, `account.cash`,
`account.reset`, `arb.decision`. Bump `TELEMETRY_SCHEMA_VERSION`
(`events.ts:4`, currently `1`) once, at step A, not per PR.

The book-widen tee (f) is dropped from step E and folded into item 41.

#### Buffer sizing — measured 2026-09-04, no longer a gate

Step 0 was originally written to block on measuring M and S. It does not: an
upper bound is all a cap needs, and the VPS samples give one.

**M ≤ 4** — BTC/ETH × 5m/15m. **S ≤ 0.81 scans/sec** — measured on the live
instance (26 scans in 32.166 s) while discovery was active but zero markets were
tradable, so it is a ceiling; scan rate only falls once each scan does per-market
price and depth fetches. Therefore:

```
2 · M · S  ≤  2 × 4 × 0.81  =  6.5 decision events/sec
```

Per-event retained heap, measured with `--expose-gc` over 30k live objects on
Node v24.19.0:

| Event | JSON | Retained heap | Ratio |
|---|---|---|---|
| `trade.decision` (structured reasons, rule iii) | 1,059 B | 1,610 B | 1.5× |
| `scan.cycle` (M=4, embeds the markets array) | 758 B | 1,274 B | 1.7× |
| **Mix at M=4** (8 decisions : 1 scan.cycle per scan) | — | **1,572 B** | — |

| Cap | Memory | Disconnect tolerance at the 6.5/s ceiling |
|---|---|---|
| 5,000 (today) | 7.5 MB | 13 min |
| 30,000 | 45.0 MB | 77 min |
| 50,000 | 75.0 MB | 128 min |
| 100,000 | 150.0 MB | 256 min |

Tolerances are floors, since 6.5/s is a ceiling; at a realistic 3-4/s they roughly
double. Caveats: measured on a dev machine's V8, so expect ±10-15% on the VPS,
not a different order of magnitude; assumes 8 decisions per scan, which halves to
4 when `evalBothSides === false` and a signal has a direction (`bot.ts:2308`),
doubling every tolerance figure again.

45 MB would make the buffer the largest single structure in the process —
`actions` and `executionLog` are ~2.5 MB each at their 5,000 caps. In absolute
terms it is still modest against a `tsx` process already at 80-150 MB RSS, and
there are no heap flags anywhere (`npm start` is bare `tsx index.ts`, nothing in
`docker/`), so Node's default limit applies.

**Why this is not a gate.** `setCapacity` already exists (`events.ts`, clamps to
a 100 floor), so the cap can be an env var tuned live rather than a code change.
More importantly, finding (d)'s gap signal makes sizing *empirical*: once a
reconnect can report that it missed events, you ship a cap, watch whether a gap
is ever reported, and raise it if so. Predicting the cap correctly in advance
only mattered while drops were silent — which was the actual defect.

Steps A-D are unaffected either way. Receipts, trades, exits, cash writes and
resets are human-scale — a handful an hour. 5,000 is already oversized for them.
Only step E emits at scan rate.

#### Step E — the differential check, and what it does and does not prove

Convention 5, applied to the `reasons.push` → `addReason` conversion. The
harness (`tmp/diffcheck/`, throwaway) drove the pre-change `buildDecision` from
`HEAD` and the new one over **300,000** randomised input combinations and
diffed `reasons`, `eligible`, `score` and `book`. `reasonCodes` is new and is
not compared — the claim under test is that adding it changed nothing else.

`buildDecision` calls `Math.random()` on the counter-signal path, so the draw is
pinned to the same value for both sides of each comparison; without that the
harness would report phantom mismatches and be tuned into uselessness.

**0 mismatches.** Mutation-checked so the zero means something:

| Mutation | Mismatches / 50,000 |
|---|---|
| one prose string altered (`'tradable now'` → `'tradable now.'`) | 2,091 |
| one score weight altered (`arbGap * 160` → `* 161`) | 15,504 |
| one reason suppressed (`book_imbalance_hurts`) | 12,094 |

What it proves: the prose array, the eligibility flag, the score and the book
summary are byte-identical for every input tried, so the dashboard, the trace
and the summary see exactly what they saw before. What it does **not** prove:
that `reasonCodes` is correct — the four new invariants in
`directionalEngine.test.ts` cover its alignment, non-emptiness and operand
carriage, and those are mutation-checked too (a bare `reasons.push` and a
prose-shaped code each kill one).

**Volume, against the estimate.** The tee emits one `trade.decision` per market
per scan rather than one per outcome, so directional is `M·S ≈ 3.2/s` rather
than `2·M·S`. `arb.decision` adds roughly another `M·S`, plus one `scan.cycle`.
Total lands near **7/s**, marginally above the 6.5/s ceiling derived earlier —
the ceiling held as an order-of-magnitude figure, and the buffer sizing table is
unaffected at that precision.

#### Step C — three findings that came out of doing it

**a. Two phantom exits stopped being exits, for free.** The collapse in (i)
means `log(…, 'sl', …)` no longer produces a `position.exit`. Two call sites
were tagged `'sl'` without being position exits at all — the unverified-fill
flatten (`bot.ts`, `UNVERIFIED FILL FLATTENED`) and the PM wallet asset sell
(`PM WALLET SELL asset …`). Both were emitting exits carrying no symbol, slug
or PnL. They are now `system.alert`, which is what they always were.

**b. `package.settlement` only ever fires on one of several settlement paths.**
Checked before collapsing the `meta.arb` arm, to be sure nothing was lost:
nothing is. `arbEngine.ts:280` is the *only* emitter in the repo, and it sits on
the instant-CTF-merge branch. `syncPackageSettlements` and
`reconcilePendingPackages` settle packages and emit nothing. So a consumer
counting settlements sees a fraction of them. Pre-existing, not introduced here,
and it belongs with the arb decision tee in step E.

**c. One throwing subscriber can starve every other subscriber.** ✅ *Fixed in
step D — `TelemetryBus.fanOut` now invokes each subscriber via `rawListeners()`
in its own `try/catch`, so a throw cannot reach the emitting stack, cannot skip
the wildcard fan-out, and cannot skip later subscribers on the same channel.
Faults are counted and surfaced (`subscriberErrors()`, plus a throttled
`console.error`) rather than silently eaten — a swallowed exception with no
trace is how a dead consumer stays invisible. `rawListeners()` returns a copy so
a handler that unsubscribes mid-fan-out cannot shift the array underneath the
loop, and Node's `once` wrapper self-removes when invoked directly, so `once()`
semantics survive; there is a test for that. Five invariants, mutation-checked:
reverting `fanOut` to a plain `emit` kills four of them.* Original finding:
`emitEvent`
does `this.emit(type, …)` then `this.emit('*', …)`, both synchronous. A
type-specific listener that throws propagates out of the first call, so the
wildcard emit never runs — and the wildcard is what step B's SSE stream
subscribes to. So a single bad consumer silently cuts the event feed to all the
others, and the throw lands on whatever call stack emitted, which for the
receipt tee is live order execution.

`captureReceipt`'s own `try/catch` absorbs it, so an order cannot be broken —
there is a test for exactly that — and the SSE handler wraps its writes. But the
protection is incidental to each call site rather than a property of the bus.
The fix is for the bus to isolate subscribers, invoking each in its own
`try/catch` so one cannot starve the rest. Not done here: it changes
`EventEmitter` semantics for every consumer and swallows subscriber bugs unless
they are surfaced somewhere, which is a design call, not a step-C detail.

#### Step C — what is verified and what is not

The receipt tee has two invariants: the record reaches the JSONL and the bus
identically (not a summary — the whole premise of that capture is that we do not
know what fields matter), and a throwing subscriber still cannot break a trade.

**The trade and exit tees have no unit tests.** `saveTrade`, `closePosition` and
the two SL passes are all module-private and reachable only through `scan()`,
which needs a whole `botState`, `readiness` and market fixtures. This is the same
wall item 49 hit with `buildPortfolio`, and it has the same answer: it becomes
expressible when the D4 position manager owns the exit path. Recorded so the gap
is a known one rather than an assumed pass.

The invariant that matters and is currently unproven is **exactly one
`position.exit` per exit, and one `trade.execution` per trade** — the property
decision (i) exists to guarantee. Until it can be tested, the nightly paper cycle
is the check: count `position.exit` events against closed trades over a window
and they should agree.

#### Step B — what is verified and what is not

Verified locally: the bus. `queryEventsPage`'s cursor semantics, the `dropped`
signal, the eviction counter and the front-slice guarantee are covered by seven
invariants in `tests/unit/events.test.ts`, two of them mutation-checked.

**Not verified locally: the HTTP and SSE layer.** Exercising it means booting the
server, and this checkout is not the running instance — starting a live-money
process locally to test a read endpoint is the wrong trade. `tsc` passes and the
handler was reviewed, but no connection has been made to it. Confirm on the VPS
after deploy:

```sh
# live tail — should print a `sync` frame, then one frame per event
curl -N -H "Authorization: Bearer $ZINGER_TOKEN" \
  'https://<host>/api/poly/events/stream'

# cursor read — `dropped` must be false, and `newestId` is the next cursor
curl -s -H "Authorization: Bearer $ZINGER_TOKEN" \
  'https://<host>/api/poly/events?after=<id>&limit=10' | jq '{count,dropped,evicted,hasMore,newestId}'

# gap signal — a bogus cursor must report dropped:true, not an empty page
curl -s -H "Authorization: Bearer $ZINGER_TOKEN" \
  'https://<host>/api/poly/events?after=evt-0-0' | jq '.dropped'
```

The third is the one worth running deliberately: an empty page and a gap read
identically to a naive consumer, and telling them apart is the entire point of
the step.

**✅ Verified on the VPS 2026-09-08** (localhost:3000, cookie auth). All three:

- Stream: `event: sync` → `{"dropped":false,"evicted":366229,"hasMore":true,
  "replayed":1000}`, then one `id:`-tagged frame per event. Leading sync and
  per-event framing both confirmed live.
- Cursor at head: `{"count":0,"dropped":false,"hasMore":false}`. Not a vacuous
  pass — `events.ts:490-499` leaves `dropped` false *only* when `findIndex`
  resolves the cursor inside the buffer, so this proves the id was located and
  the front slice was correctly empty.
- Bogus cursor `evt-0-0`: `dropped: true`.

The last two together are the invariant: two responses carrying zero usable
events, told apart by one flag, against a buffer that had already evicted
366,283 events.

The `hasMore: true` in that sync frame is not benign — see **item 65**. The
replay is capped at 1,000 events against a 30,000 buffer, and on this instance
that is a 94-second horizon, after which a reconnecting consumer silently loses
the middle with `dropped: false`.

Note `X-Accel-Buffering: no` is set on the stream because nginx will otherwise
buffer SSE and the feed appears dead. If the stream connects but no frames
arrive on the VPS while `/api/poly/events` works, that header not surviving the
proxy is the first thing to check.

**Measuring M and S needs no new instrumentation, but it needs the VPS running.**
Nothing about scans is persisted: `botState.stats` (`bot.ts:135`) and
`botState.executionLog` (`bot.ts:139`) are in-memory only — `saveState()`
(`bot.ts:348-349`) writes positions and actions and neither of those — and
`logScan` keeps exactly one scan row, filtering every prior one out of
`executionLog` before unshifting (`bot.ts:1124`). The event buffer is memory-only
too. So `data/` answers nothing here and a restart erases the window; the numbers
have to be read off the live instance.

Both are already on the dashboard, which is served from `getState()` via
`GET /api/poly/state` (`server.ts:393`):

- **S** — the scan counter, `stats.scansDone` in the state payload
  (`bot.ts:1610`). Read it twice with the clock times noted;
  `S = Δscans ÷ Δseconds`. Any window; a restart is self-announcing because the
  counter goes backwards.
- **M** — the latest-scan line, `🔎 Scan #1234 — 6 mkts · …`, which is
  `enriched.length` (`bot.ts:3051`). Sample across a quiet hour and an active
  window, since M varies with how many markets are tradable at the time.

S is **not** 4/sec. `scan()` early-returns while `_scanning` holds
(`bot.ts:2058-2062`), so the 250 ms interval is a polling tick, not a completion
rate. Caveat in the conservative direction: `scansDone` increments at the top of
a scan (`bot.ts:2070`) while `scan.cycle` fires at the end (`bot.ts:3050`), so a
scan that throws counts in the counter and not in the event stream — the counter
slightly overstates completions, which is the safe way to be wrong when sizing a
buffer.

The Telegram `/status` reply also prints `Scans:` (`telegram/bot.ts:349`), but
that surface is optional — `startBot()` returns early without
`TELEGRAM_BOT_TOKEN` (`:93`) or under `TELEGRAM_DISABLED` (`:81`) — so the
dashboard is the route to rely on.

**Unresolved, and it decides where the step E tee goes.** There appear to be two
scan implementations: `bot.ts:2055` and `scan/index.ts:74`. Both increment
`scansDone` and both call `logScan`. `bot.ts:3545` wires the interval to the
`bot.ts` one, so `scan/index.ts` looks like an extraction that is not live yet —
but that was not chased down, and it must be settled before the decision tee is
written into either file.

---
