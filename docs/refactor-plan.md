# Zinger refactor plan (backlog)

Running list of structural work identified while debugging the Aug 2026 "bot ran
for days without trading" investigation. Nothing here is scheduled yet — this is
the input to a planning pass, not a plan.

See `docs/architecture.md` for the current module map.

## Why this exists

Two live bugs were traced to the same underlying shape: behaviour that spans
several modules with no single owner, so a wrong assumption in one place goes
unnoticed everywhere else.

- **`negRisk` arb gate.** A review fix (`cccce43`, 2026-08-12) gated arbitrage on
  `market.negRisk === true`. Polymarket reports `negRisk: false` on every
  `*-updown-*` market the bot trades, so arb was disabled outright from that
  commit until 2026-08-18. The shipped test asserted the new behaviour, so CI
  stayed green on the regression. Fixed by checking the invariant that actually
  guarantees the $1.00 payout (one `conditionId`, two complementary outcome
  tokens) via `isComplementaryBinary` in `arbEngine.ts`.
- **Signal-feed outage aborting whole scans.** `getSignalForBoth()` in `scan()`
  was unguarded, so a Binance timeout threw out of the entire pass — including
  the arb engine 250 lines below, which needs only the Polymarket order book.
  Fixed with a local `.catch()` that reuses the last known signals.

Both fixes are in; the items below are the structural work they point at.

The first overnight run after those fixes (2026-08-18, paper) then surfaced a
second cluster — items 7–9 — all in arb accounting rather than arb detection.
The engine now finds gaps correctly; what it does with the money afterwards is
where the remaining defects live.

Items 14–18 came from a read-through of the persistence and wallet paths on
2026-08-18 rather than from a failure. They share a shape with the rest of the
list: state that is written in one place and read from another, with no single
owner to notice when the two disagree.

## Objectives

Owner's framing, 2026-08-18. Provisional — expected to sharpen once the work
starts. These are the standard each backlog item is judged against: an item is
done when it advances one of these, not when the code reads better.

The four are not peers. **Single responsibility is load-bearing** — observability
and config coherence are both downstream of it, and clarity is a constraint on
how it is done rather than separate work. Sequencing that ignores this produces
motion without progress: instrumenting a system with five competing writers
yields five log lines and still no answer.

**1. Observability — every action traceable.** Any question of the form "why did
the bot do X / not do X" should be answerable from recorded events, without log
archaeology or a code read. Today it is not. Three independent event logs exist,
with three retention policies, three schemas and no unified view:

```
botState.actions    poly_actions.json    cap 300       bot.ts:238
session traces      per session          cap 500 × 40  sessionLedger.ts:93
liveAccount traces  live_account.json    cap 400       liveAccount.ts:61
```

Reconstructing one incident means reading all three and merging by timestamp —
assuming the 300-entry cap has not already evicted it (item 13).

A dedicated event-logging system is planned. **It should be the persistence
layer, not a fourth log beside it.** The event tables discussed under item 14
and the event log are the same object: one append path, one schema, one query
surface, with the three existing trace stores becoming views over it. Built
separately, it reproduces precisely the defect this document exists to remove.

**2. Single responsibility — one owner per behaviour.** Each module owns one
thing, and anything wanting to affect that thing routes through its owner rather
than reaching around it. Stated as a test in item 2: a module whose name does not
predict its contents is not done, and the split is by behaviour, not by size. A
large module doing one thing is fine; `bot.ts` is a problem because it does five
things at once, not because of its length.

**3. Ease of change — clarity over structural strength.** The system should be
easy to extend and modify, and clarity is the goal rather than architectural
rigour for its own sake. This is the guard on objective 2: "route through the
owner" fails when the owner is a thin pass-through, because every call site then
pays indirection and gets nothing back. A boundary must *absorb* complexity so
callers get simpler — if it makes the calling code harder to read, it is the
wrong boundary however correct it looks. This objective is also what keeps the
refactor from becoming an architecture project.

**4. Config coherence — configurable toward a goal.** It should be possible to
aim the bot at an objective without landing in configuration hell: parameters
that cancel each other out, several knobs for one outcome, or no way to tell
which is in force. Note this is not achievable directly — "configs conflict" is
an ownership symptom, not a schema problem. `saveConfig` currently has five
writers with no precedence model (item 3a), so the governor overwrites operator
choices every ~120s. Give each decision one owner and this objective largely
resolves; tidy the schema first and nothing changes.

## Decisions (2026-08-19)

Settled in a design session. These are load-bearing — most backlog items are
downstream of them.

**D1 · Two engines, shared plumbing.** Arb and directional split at the
*decision* layer. Each owns its gate, sizing, exits, capacity and stats. They
share market discovery, order execution, the cash ledger and persistence.
Rationale: items 3, 4, 5, 6 and half of 11 all trace to these two strategies
sharing machinery they have nothing in common in — different inputs (book vs
signals), risk (hedged vs directional), exits (hold-to-settle vs TP/SL) and
sizing (fixed fraction vs Kelly).

**D2 · Directional is first-class.** Explicitly *not* deprioritised. It has never
passed its edge gate only because the gate needs 40 paper closes and the bot has
been in arb-only mode — not because the strategy is weak. Arb is capacity-limited
by how often books dislocate; directional is the engine that can deploy capital
continuously. Plan for both.

**D3 · Governor kept and rebuilt.** Regime adaptation is a sound idea with a
flawed implementation. The 54 literals move into operator-editable config, and
config writes gain explicit precedence: **operator > guardrail > automation**.
Nothing silently overwrites a human setting again. Closes items 3, 4 and 5
together.

**D4 · Shared position manager with per-engine policy hooks.** One lifecycle
manager; each engine supplies exits, settlement valuation and sizing through a
defined interface.
*Hard rule:* the manager contains **zero strategy conditionals**. All variance
goes through the interface. `grep -n "isArbLeg\|packageId\|clobArb"` over the
manager returning anything is a defect — cheap enough to enforce in CI. If a
behaviour cannot be expressed through the interface, the interface is wrong;
do not reach for an `if`.

**D5 · Shared cash pool, separate slot counts.**
- *Cash: one pool.* Live reads a single real balance
  (`readiness.spendableBalance`), so virtual per-engine pots are a bookkeeping
  fiction that drifts against reality on every unmodelled fill, fee or deposit.
- *Slots: separate per engine.* Slots are internal counters — nothing to
  reconcile — and in the owner's risk model they **are** the directional risk
  dial: `worst case = slots × position size × SL%`. Measured today: 3 slots ×
  $10.15 × 8% = **$2.44** (2.4% of book); at 8 slots, **$6.49** (6.4%).
  A single shared count makes one number serve two unrelated jobs — raising it
  for arb headroom silently authorises that much more directional exposure.
  Arb legs contribute ~nothing to worst-case drawdown anyway (hold-to-settle,
  no meaningful stop), so the two dials are genuinely independent.
- Consequence: "take every arb, be selective on directional" is not a special
  rule — it is simply what the two slot numbers say.
- Per-engine P/L comes from **tagging trades by engine**, not from segregating
  capital. Same mechanism fixes the item 6 edge-gate contamination.

**D6 · Sequencing: invariants → directional → shared layer → arb.**
Invariants first because they are structure-independent, survive the whole
refactor, and are what would have caught `cccce43` where a characterization test
could not (a snapshot test of wrong behaviour just freezes the bug). Directional
second because it is not trading — zero live risk, and it is the larger mess, so
the shared layer gets designed against the harder case. Arb last, so the only
working strategy and only data generator stays untouched longest.
*Hard constraint:* the bot keeps paper trading every day throughout. It is the
only regression detector, and it enforces incrementalism by construction.
*Prerequisite:* item 12 (test isolation) comes **before** the invariant suite —
tests currently write into the live `data/` store, and an invariant suite
exercising cash reconciliation against production data would corrupt it far more
thoroughly than the one stray `eth-plan-test` fixture already did.

**D7 · Scope.** *Revised 2026-08-20 — the original settled when the backlog was
13 items; 14–19 were added afterwards and were unassigned.*

**In:** the structural split (2), everything downstream of D1–D5 (3, 4, 5, 6),
all arb correctness (7, 8, 9, 10, 11), test isolation (12), log retention, and
the persistence foundation (14, 15, 16).

**Out / relocated:**
- **1** — 4h/hourly duration work, and dashboard UI polish.
- **13** — dissolves into D8 rather than being scheduled. Its UI-filter gap and
  UTC/BST skew both become client concerns once events carry structured
  timestamps and payloads; the 300-entry cap is already in scope.
- **17** — ML artifact boundary. A documentation decision ("artifacts on disk,
  state in the store"), blocks nothing, and it is the only item touching the
  Python tree. Deferred.
- **18** — wallet configuration moves to the **D11 live track**. It is a missing
  *capability* that blocks going live, not a structural defect: no writer for
  `polymarketDepositWallet`, no key import path, and hand-editing `wallet.json`
  silently does nothing since the port. Cleaning up `bot.ts` does not help it.
- **19** — one-line config correction now, plus continuous assertion as D11
  dimension 4.

**Why 14–16 are slice 0, not optional:** these are hard dependencies, not
preferences.
- **16 gates 12.** Test isolation works via `ZINGER_DATA_DIR`, but
  `ai/optimizer.ts:6` and `lib/chain.ts:14` hardcode `../../data` and ignore it.
  Without 16, slice 0's isolation is incomplete and the invariant suite still
  reaches production paths through those two modules.
- **14 gates D8.** Events need a settled store to land in. It is also an active
  data bug — 41 sessions of performance history invisible to the optimizer, the
  component tuning `kellyFraction`, `slPct` and `minConfidence`. D9 already
  archives `data/`; deleting the migrated-away JSON is the same job.
- **15 gates everything.** The backend is currently selected by Node version
  alone, with a docstring documenting a `ZINGER_SQLITE` env var that does not
  exist in the module. A Node downgrade silently swaps persistence to stale JSON
  with no log line — under which every invariant above it is meaningless.

**D8 · Events are the source of truth; logs are an interface.** Zinger's job is
to emit a complete structured record of every process it performs. A separate
client for viewing, analysing and interacting with that record is planned and is
**out of scope here** — but the emission side is in scope, because the refactor
already touches every call site and retrofitting means a second full pass.

Today: `log(msg, type, meta)` has 52 call sites across `polymarket/` and `ai/`,
of which only 29 pass `meta` — **44% carry their data solely inside a prose
string** (`🏁 WINDOW 23:55→00:00 · closes 0 · TP 0 · PnL $0.00`), which a client
would have to regex. Caps are 300 entries in memory (`bot.ts:924`) and 500 for
`executionLog` — far too small once this is the system of record.

Target: every process emits a typed event with a stable name and a complete
payload; the human-readable string becomes a *rendering* of the event, not where
the data lives. Schema versioned so a client can depend on it.

This converges with decisions already taken rather than adding scope — D3's
attributed config writes, item 3's "why is it arb-only" resolver decision, D4's
position lifecycle transitions, and D1's per-engine take/skip decisions are all
already events by nature.

**D9 · Clean data cut.** Archive `data/` to a dated folder; start empty when the
new lifecycle lands. The existing store cannot answer "is this strategy
working" — packages orphaned from their trades, one permanently stuck
`PENDING_FILL`, one fabricated settlement, and every package P/L recorded gross
of fees. No live money is at stake, and under D8 those records carry no events,
so a client could not read them anyway. Migration code for data known to be
wrong is pure cost.

*Scheduling clarified 2026-08-20 (operator).* "When the new lifecycle lands"
means **slice 3, not slice 0** — the earlier slice-0 step 5 contradicted this
decision and has been removed. Three reasons, and they are why D9's own wording
wins:

- The data format does not change until the lifecycle does.
- The bot keeps paper trading through slices 1–2 (D6), so archiving now means
  the store refills in the *old* format and is archived again at slice 3. Two
  archives, no benefit.
- Archiving now removes real-state regression detection across exactly the two
  slices that move the most code.

Slice 0 therefore performs **item 14's cleanup only** — move the migrated-away
JSON aside so nothing shadows the store, which is the part that gates D8. The
full archive-and-reset moves to slice 3.

Item 24 (below) strengthens this decision: the pre-refactor arb record cannot be
reconstructed even in principle, because `resetPaperData` detached the packages
from their trades.

**D10 · Decompose by behaviour; LOC is a symptom, not the target.**

Measured 2026-08-19 — the file is not uniformly bloated:

```
 LOC  line  function
1035  2227  scan            ← 26% of the file, one function
 394  1653  getState
 247  1358  buildDecision
                 top 3 = 1,676 lines = 41% of the file
                 other 83 functions average ~29 lines
```

86 functions across 4,052 lines averages 47 each, which is healthy. The problem
is **three god-functions plus 83 reasonable ones**. Splitting the file without
decomposing `scan` just relocates the monolith into a `scan.ts`.

On seams: most already exist — `markets.ts`, `signal.ts`, `trade.ts`, `fees.ts`,
`persistence.ts` are real modules with real boundaries. `bot.ts` is a god object
holding both orchestration *and* policy. The work is moving policy out to the
modules that own it, not carving new interfaces.

`scan` currently performs seven responsibilities in sequence. Five already have
an owner from decisions above:

| `scan` phase | Owner | Slice |
|---|---|---|
| housekeeping (prune, cycle finalize) | `scan/cycle.ts` | 2 |
| input refresh (telemetry, signals, markets, depth) | `scan/inputs.ts` | 2 |
| orphan settlement | item 10 — off the read path | 3 |
| data assurance | `dataAssurance.ts` (exists) | 2 |
| open-position exits | **D4** position manager | 2 |
| entry decisions ×2 | **D1** arb + directional engines | 1, 3 |
| cycle reporting | **D8** events | 1–3 |

Target shape (proposal, adjust freely):

```
scan/
  index.ts        the loop: call phases in order, nothing else (~80 lines)
  inputs.ts       telemetry, signals, markets, prices, depth
  cycle.ts        window boundaries, session bookkeeping
engines/
  arb.ts          arb decision + policy
  directional.ts  directional decision + policy (buildDecision, resolveOrderSize)
positions/
  manager.ts      lifecycle — zero strategy conditionals (D4)
  policy.ts       the interface both engines implement
  settle.ts       settlement, duration-aware (item 11)
ledger/cash.ts    paper cash, reconciliation, audit
config/resolver.ts  precedence: operator > guardrail > automation (D3)
events/emit.ts    typed emission, replaces log() (D8)
```

`bot.ts` ends as a thin lifecycle shell (`startBot`, `stopBot`, timers) or
disappears.

**Acceptance is behavioural, not numeric.** A 600-line file owning exactly one
behaviour passes; ten 200-line files carved arbitrarily out of `scan` fail. The
test is D6's: for any "why didn't the bot do X?" question, one obvious file to
open.

`getState` (394 lines) is a separate offender — it currently performs
`syncPackageSettlements` as a side effect (item 10). Splitting its read path from
its mutation is part of slice 3.

**D11 · Live-readiness is a four-dimension gate, enforced in code, with a
confidence-driven ramp.**

The current gate (`requireEdgeForLive` + 40 paper closes) tests one dimension and
tests it wrong. Replace with four, all mechanically checked on every mode switch
*and* periodically while live — a gate that cannot re-verify itself is a
checklist, and item 19 is what happens to checklists.

1. **Correctness** — the slice-0 invariants pass. Binary, objective.
2. **Evidence** — differs per engine (below).
3. **Operational** — runs unattended (item 10), recovers from a mid-flight
   restart (item 9), emits enough to diagnose (D8), stops fast.
4. **Blast radius** — live caps asserted against `defaultLiveStrategy()` so
   silent drift is impossible. This is the one that already failed (item 19).

**Evidence differs by engine, and this falls out of D1.**

*Arb's edge is arithmetic* — `gap − fees = profit`, guaranteed by the maths.
Trading it repeatedly does not "prove" it; you would be re-proving subtraction.
What needs proving is **execution**: half-fill rate, realized vs quoted slippage,
fill latency. That is answerable in ~10–20 live packages, i.e. days.

*Directional's edge is statistical.* Required sample size:

```
SE = σ / √n        n ≈ (2σ / e)²
```

With current config — ~$10 positions, TP 18–36%, SL 8–12% → σ ≈ $1.75/trade —
and a claimed 2% edge (e ≈ $0.20):

```
n ≈ (2 × 1.75 / 0.20)²  ≈  306 trades
```

**`edgeMinTrades: 40` is roughly an order of magnitude too low** and would clear
on noise routinely. Duration is *unknown until entry frequency is measured* —
at 50 trades/day that is under a week, at 10/day it is a month. Measure it on
the first day directional runs rather than guessing.

**The ramp does not accelerate the statistics.** $1 trades and $100 trades carry
identical information about win rate and edge percentage; n is n. What it does is
remove the requirement that the statistics complete *before* going live:

| Question | Type | Trades | Answerable in paper? |
|---|---|---|---|
| Does live execution match paper? | operational | ~10–20 | **No** — needs real fills |
| Does the strategy have edge? | statistical | ~300 | Yes, but paper lies |

Clear the operational question in days at minimum size, go live small, and
accumulate the statistical sample **on live data** — strictly better evidence,
since it contains real fills, slippage and fees rather than simulated ones.

**The scale-up rule is Kelly one level up.** Trade-level Kelly sizes on the edge;
strategy-level sizing should track *the uncertainty in the edge estimate*. Size
as a function of the lower bound of the edge confidence interval: at n=20 that
bound is deeply negative → stay at minimum; at n=300 with a real edge it is
comfortably positive → full size. The ladder falls out of the data instead of
being hand-picked, and it reuses the existing `kellyFraction` machinery.

Arb-first and ramping are **not exclusive** — arb clearing its execution gate
early while directional accumulates is the likely landing point.

## The plan

Four slices. Each ends shippable, and the bot paper-trades throughout.

### Slice 0 — Safety net (prerequisite)

1. ✅ Item 16: one exported `getDataDir()`; no module computes its own. **Must
   precede item 12.** *Scope corrected 2026-08-20: **seven** modules ignored the
   override, not the two originally listed — see the item.*
2. ✅ Item 12: tests get an isolated data dir (per-worker, or parallel workers
   deadlock on one sqlite file).
3. ✅ Item 15: honour the documented backend env var, and surface the active
   backend + `docCount()` at boot and on `/api/ops/status`.
4. ✅ Raise the 300/500 log caps (`bot.ts`).
5. ✅ One-shot audit of the current store — local **and** VPS (below).
6. ✅ Item 14 cleanup: reconcile `session_perf.json`, then move the
   migrated-away JSON aside so nothing shadows the store.
   (`scripts/reconcile-store.ts`, dry-run by default.)
7. ✅ The permanent invariant suite (below).

*(The former step 5, "archive `data/`, start fresh", contradicted D9's own
scheduling and has moved to slice 3. See D9.)*

#### Two different things, deliberately separated

Recorded 2026-08-20 (operator), because the original single "invariant suite"
step conflated them — and conflated, the permanent suite's result depends on
whatever happens to be in `data/`, so a failure cannot be attributed to a code
defect rather than a data artifact.

**a. Permanent invariants — run against fixtures.** They test *code behaviour*:
"does `executeSell` settle a naked leg at $0.50?" No production data involved.
These are the acceptance criteria for slices 1–3 and they run in CI forever.

- a full set redeems to exactly $1.00
- cash reconciles to trades + fees + open cost
- every package reaches a terminal state
- arb legs are paired or unwound — never left naked
- operator settings are never silently overwritten

**Expect several to fail immediately.** That is the point — they are the
acceptance criteria for slices 1–3, not a regression signal. Record which fail
and why.

Implemented as two files, so CI stays green (the bot must keep paper trading,
D6) without pretending the defects are fixed:

- `tests/unit/invariants.test.ts` — invariants that **hold today**. Green
  forever; real regression detection.
- `tests/unit/invariants.pending.test.ts` — those that **do not hold**, each
  wrapped in vitest's `it.fails()`, which asserts the test currently fails. When
  someone fixes the underlying defect the file goes **red** with "expected to
  fail but passed" — the signal to promote the test into the main file.

`it.fails()` earns its place here specifically because it inverts the
`cccce43` failure mode: a characterization test would have frozen the bug as
correct, whereas this states what *should* be true, records that it is not, and
alarms the moment reality changes.

Each pending invariant was verified to fail **on its own assertion**, not on an
error — an `it.fails()` passing because of a typo would be worthless:

| Pending invariant | Item | Measured failure |
|---|---|---|
| an accepted package is profitable after fees | 7 | 1.6% gap package nets **−$0.38** |
| locked profit is reported net of fees | 7 | reports **$0.83**, true net **$0.16** (5.2× over) |
| no stale `PENDING_FILL` consumes capacity | 9 | 48h-old package still counted active |
| migration never widens a live risk cap | 19 | `maxPositionCap` **100** vs default **1** |
| naked leg settles against the real outcome | 8 | `it.todo` — needs `positions/settle.ts` (slice 3) |

**b. A one-shot audit — run against the real store.** It tests *current state*:
"does cash actually reconcile right now?" Read-only, run once, numbers recorded
in this document, then done. It is not a test and does not belong in CI.

Implemented as `scripts/audit-store.ts`. Read-only (sqlite opened
`readOnly:true`; verified byte-identical across a run — only the `-shm` sidecar
mtime moves, which SQLite touches on any connection). Honours
`ZINGER_DATA_DIR`.

The distinction matters beyond tidiness: **invariants against an empty store
pass trivially** — "cash reconciles" holds perfectly with zero trades. A green
suite that proves nothing is precisely the failure mode this plan exists to
prevent. This is also why the audit runs *before* any archive.

#### Audit results — VPS (production), 2026-08-20

Run against a consistent `VACUUM INTO` snapshot taken while the bot was running
(`integrity_check: ok`, 33 rows). Read-only throughout; nothing written to the
VPS. Contents: **31 packages · 13 trades · 13 positions**.

| Invariant | VPS | Local |
|---|---|---|
| a full set redeems to exactly $1.00 | ✅ 31 packages | ✅ |
| cash reconciles to trades + fees + open cost | ✅ drift −$0.01 | ❌ $1.17 |
| fees are recorded on trades | ✅ 13/13 | ✅ |
| every package reaches a terminal state | ❌ 1 `PENDING_FILL`, 40.5h | ❌ |
| arb legs are paired or unwound | ❌ 1 naked + 24 orphaned | ❌ |
| operator settings never silently overwritten | ❌ 9 live caps | ❌ |
| session_perf not shadowed | ✅ 200 = 200 | ❌ (now fixed) |
| data dir has one representation of state | ❌ 13 JSON files | ❌ (now fixed) |

Three things the local rehearsal could not have told us:

- **The 41-session `session_perf` divergence is local-only.** Production is
  200 = 200. Item 14's *data-loss* half does not apply to the VPS; only the
  shadowing half (13 stale JSON files) does. Run the reconcile script there as
  cleanup, not recovery.
- **`pkg-btc-msyglw8m` is real and still stuck**, 40.5 hours on, exactly as
  items 8 and 9 describe — one naked UP leg, `PENDING_FILL`, holding a
  `maxArbPackages` slot nothing can free.
- **Item 23 was armed but had not yet fired** — see the item. That is what made
  it urgent rather than historical.

### Slice 1 — Directional engine

Extract directional decision logic out of `bot.ts` into its own engine with its
own slot budget (D5) — `buildDecision` (247 lines) and `resolveOrderSize` (121)
move to `engines/directional.ts`, taking ~370 lines of the entry path out of
`scan` with them. Tag every trade with its engine — this alone fixes item 6,
since the edge gate then filters to directional trades only. Emit decision events
(D8): took / skipped, and why.

*Gate:* arb continues trading nightly, untouched. Zero live risk — directional is
not currently trading.

#### Progress, 2026-08-20

| Step | State |
|---|---|
| extract `buildDecision` + `resolveOrderSize` | ✅ `engines/directional.ts`, `bot.ts` 4105 → 3733 |
| tag trades by engine · item 6 | ✅ `engine` field + `tradeEngine()` + `closedPnls` filter |
| per-engine slot budget (D5) | ✅ four cross-wirings fixed; closes item 25 |
| decision events (D8) | ⬜ **deliberately not started — see below** |

Committed as two commits on purpose: the extraction changes no behaviour, the
item 6 fix changes what the gate reads. Split so a regression in the nightly
paper run attributes to one or the other rather than to "slice 1".

**The extraction was verified equivalent, not assumed.** A one-shot differential
run drove the pre-extraction copies (lifted from `bot.ts` @ `e710de2`) and the
new module over **1,739,090** input combinations — 0 mismatches. The harness was
itself mutation-checked: changing one scoring weight from `160` to `161`
produced 1,128,960 mismatches, so the zero means something. Throwaway, under
`tmp/diffcheck/` (gitignored); re-creatable from the commit message.

**The seam.** The two exports are pure functions — no module state, no clock, no
store. The three `botState` reads `buildDecision` needed became a `portfolio`
argument assembled by `portfolioView()` in `bot.ts`:

```
bot.ts (scan)                        engines/directional.ts
─────────────                        ──────────────────────
botState ──> portfolioView(slug,cfg) ──> buildDecision({ …, portfolio })
               hasOpenOnSlug                   ↑ imports nothing from bot.ts
               sideBalance                     ↑ same inputs → same decision
               dataAssurance
```

`portfolioView` is a seam, not a home — the D4 position manager owns those three
facts in slice 2.

**Why D8 events are not in this slice.** D8 is explicit that the event system
"should be the persistence layer, not a fourth log beside it", and that building
it separately reproduces the defect this document exists to remove. Emitting
took/skipped from the directional engine before that schema exists means writing
a fifth event path (`actions`, session traces, `liveAccount` traces,
`executionLog`, and now decisions) and migrating it later. Deferred to land with
the D8 emitter rather than ahead of it. Recorded here so the omission is a
decision, not a gap.

### Slice 2 — Shared layer

Position manager plus the policy interface (D4), with the zero-strategy-
conditional rule enforced by CI grep. Config resolver with explicit precedence —
operator > guardrail > automation (D3). Governor profiles move from 54 source
literals into operator-editable config.

*Gate:* every config write is attributed, and "why is it arb-only right now?" is
answerable from a single event rather than log archaeology.

### Slice 3 — Arb onto the new shape

Move `arbEngine` onto the position manager and policy hooks. Fix items 7
(fee-aware gap threshold), 8 (settle at $0.50 only when the pair is intact), 9
(boot-time `PENDING_FILL` reconciliation), 10 (settlement driven off a timer, not
`getState`), 11 (window duration from the slug, not hardcoded 300s).

*Gate:* the invariants that failed in slice 0 now pass.

### Done means

- Every slice-0 invariant passes.
- **The question-to-file test:** "why is it arb-only?", "why no trades?", "why
  did equity drop?", "why didn't the package settle?" — each answerable by
  opening one file. Measure before (3–5 files today) and after.

## Backlog

### 1. Market duration coverage ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Added `ASSETS_4H` (`windowSeconds: 14400`) and `'4h'` to `DURATION_SECONDS`, `windows.ts` regex, and `fundHeuristics.ts`. Pruned non-existent 30m series and set default `enabledDurations` to `['5m', '15m', '4h']`.

`ALL_ASSETS` (`config.ts:31-39`) declares `btc/eth-updown-30m` and `-1h`
prefixes, and `getCurrentSlug` builds every slug as `<prefix>-<epoch aligned to
windowSeconds>`. Gamma publishes the epoch-suffixed series **only at 5m and 15m**:

```
btc-updown-5m-<epoch>   200
btc-updown-15m-<epoch>  200
btc-updown-30m-<epoch>  404   (series does not exist)
btc-updown-1h-<epoch>   404   (different slug scheme)
```

Hourly and daily up/down markets do exist, under an ET wall-clock scheme —
`bitcoin-up-or-down-august-18-9pm-et`, `bitcoin-up-or-down-on-august-18-2026`.
They are `["Up","Down"]` binaries with `negRisk: false`, i.e. valid arb targets
under the corrected gate, but unreachable because slug generation is epoch-only.

Two separable pieces:

- **Cheap:** drop `'30m'`/`'1h'` from the three default arrays
  (`modeConfig.ts:80`, `bot.ts:165`, `config.ts:52`) so nothing requests a slug
  that cannot exist. Low value — `enabledDurations` is a persisted
  `STRATEGY_KEYS` field, so this only affects newly seeded profiles. Current
  local config: `paper` is already `['5m','15m']`; `live` still lists all four.
  Confirm the VPS `paper` profile separately.
- **Free win — a 4h epoch series exists and is unreachable.** Verified live
  2026-08-19: `btc-updown-4h-<epoch>` and `eth-updown-4h-<epoch>` both return
  200, `negRisk: false`, `["Up","Down"]` — valid arb targets under the corrected
  gate. It uses the **same `-updown-<epoch>` convention as 5m/15m and is
  UTC-aligned** (`1787083200 % 14400 == 0`; window 20:00→00:00 UTC exactly). So
  this needs no DST work and no new window model — it is two entries in
  `ASSETS_4H` plus `'4h'` in `DURATION_SECONDS`/`durationFromSlug`. Longer
  windows also mean wider books, which is where the profitable gaps were.
- **Real work:** the ET wall-clock hourly/daily series
  (`bitcoin-up-or-down-...-et`) remains genuinely awkward — DST-aware slug
  generation plus a window model that drops the epoch-alignment assumption
  (`getRemainingMs`, `getCycleEndMs`, `getIntervalBoundary`, `windows.ts` regex).
  Lower priority than the 4h series, which needs none of it.

Confirmed no 30m series exists in any naming scheme.

### 2. `bot.ts` decomposition ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Decomposed monolithic `scan()` into single-responsibility phase modules: `scan/cycle.ts` (window rollover, accumulator resets, session stats), `scan/inputs.ts` (outage-resilient Binance signals, ML ladder merging, Chainlink Price-to-Beat oracle enrichment), `scan/exits.ts` (orphan paper settlement), and `scan/index.ts` (~80-line sequential loop). An outage on Binance signals no longer blocks downstream CLOB Arb.

### 3. Rule interaction is convoluted — trim to the minimum useful set ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Created unified trading permissions resolver `resolveTradingPermissions()` in `src/polymarket/config/resolver.ts` enforcing strict D3 precedence: Operator (`forceArbOnly`) > Guardrail (Drawdown breaker & live edge lock) > Automation (Paper edge sample requirements). Replaced 5 fragmented ad-hoc checks with a single audited resolver.

### 4. The governor hardcodes what it governs, and ignores the mode it is in ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Bounded governor profile interactions and prohibited forbidden arb dial overwrites (`GOVERNOR_FORBIDDEN_KEYS`). The governor emits regime decisions rather than mutating operator configuration, and `resolveTradingPermissions` evaluates decisions under D3 authority.

### 5. Config validity has no owner ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Added declarative `validateConfig()` in `src/polymarket/modeConfig.ts`. Enforces invariant consistency (e.g. automatically ensuring `clobArbEnabled: true` if `forceArbOnly: true`, and clamping fractional window bounds between 0.1 and 1.0).

### 6. Arb legs pollute the directional edge gate ✅ FIXED

*Fixed in slice 1, 2026-08-20.* Trades now carry an explicit
`engine: 'arb' | 'directional'` tag and `closedPnls` filters on it. Two
corrections to the write-up below, both found while fixing it:

- **The tag already existed, negatively.** `bot.ts` wrote `isArbLeg` /
  `packageId` / `arb` onto every position and all nine `saveTrade` call sites
  spread the position, so the data was on the record all along — the fix was a
  filter, not a tagging project. What was missing was the *positive* direction:
  nothing said "directional", only "not arb", so a third engine would have
  silently inherited the directional bucket. `tradeEngine()` in `audit.ts` now
  answers it, with legacy records classified from the old markers.
- **The measured pollution was worse than "six legs".** On the local store
  **6 of 7** paper trades were arb legs: 3 artificial wins, 3 artificial losses,
  expectancy **−$0.010**. That near-zero is not a measurement — it is three
  hedges cancelling. The gate was judging a directional signal it had tested
  exactly once. After the fix: 1 of 7 scored, expectancy −$0.72, arb-only.

The live-money exposure was concrete: 20 packages is 40 rows, which clears the
default `edgeMinTrades: 40`. Armed but not fired — n was 7.

---

*Original write-up:*


`closedPnls` (`edge.ts:7-19`) selects every closed paper trade with no filter on
`isArbLeg` / `packageId`, so arb legs feed the expectancy, win-rate and Kelly
figures that `evaluateEdgeGate` uses to decide whether *directional* trading has
proven itself. Arb legs are structurally paired (one leg near +$1/share, the
other near -$1/share) and say nothing about directional skill — e.g. the six
legs currently on record read as 50% WR with ~$2 average win and ~$1.94 average
loss, which is arb mechanics, not signal quality.

Consequences both ways: in `forceArbOnly` mode the 40-close `edgeMinTrades`
sample fills up with arb noise and can unlock directional trading (or live, via
`requireEdgeForLive`) on evidence that never tested a directional signal; and a
run of arb legs can equally suppress a genuine directional edge. The gate should
either exclude arb legs or score them in a separate bucket.

### 7. The arb gap check is fee-blind — it takes losing trades on purpose ✅ FIXED

*Fixed 2026-08-20 (`ccfa54e`).* The gate is now
`gap > rate × [(u(1−u))^e + (d(1−d))^e] + margin`, evaluated per leg at its own
price, and `lockedProfitUsd` is reported net.

**Correction to the table below: the 09:57 break-even cell said 1.35%; it is
1.88%.** Five of the six rows match the implemented formula to the basis point,
and that row's own fee ($0.193) and net (+$0.01) figures are consistent with
1.88% rather than 1.35% — so it was a bad cell, not a bad model. The conclusion
is unchanged and if anything stronger: 1.88% is still far under the 3.5% a
50/50 book needs, and a flat 0.035 still refuses a 2.0% gap that pays.

`minArbGap` keeps its exact meaning and default — it is now purely an absolute
floor ("how big a dislocation is worth the trouble"), while the fee gate owns
"can this trade make money at all" and cannot be disabled. No existing config
value is reinterpreted. New `arbMinMarginPct` is the required profit above
break-even: paper 0.005, live 0.010, because a quoted ask is not a fill price.

*Operator note:* a stored `minArbGap` of 0.035 will now be the binding
constraint on skewed books, re-imposing the flat floor the fee gate replaced.
Lowering it to the 0.015 default (or below) is safe — losses are no longer this
field's responsibility.

Two things the mutation pass turned up, neither visible to a green suite:

- The reference books used to state break-even — 0.50/0.50, 0.23/0.77,
  0.10/0.90 — **all sum to exactly $1.00**, which is the single case where
  assuming `d = 1 − u` is correct. A symmetry shortcut passed every one of them.
  A tradable book sums to *under* $1.00 by definition, so the binding invariant
  is now "break-even × shares equals the two leg fees actually charged" — the
  gate cannot price a different trade than the ledger books.
- Break-even is a **rate, not a money amount**. Rounding it to the protocol's
  5dp USDC precision puts error into the rate itself, which then scales with
  share count.

The gate deliberately does **not** call `resolveClobFeeParams`: that is a
4s-timeout fetch, the gate runs per market per scan, and window tokens rotate
every 5 minutes. A network call in the arb path is the exact shape of the
2026-08-12 outage. `peekClobFeeParams` reads the cache without fetching and the
fill path warms it; the category fallback is numerically identical on these
markets anyway (`{"r":0.07,"e":1}` = `FEE_RATES.crypto`, exponent 1).

---

*Original write-up:*

`arbEngine.ts:52-53` compares the raw book gap against `minArbGap` with no fee
term at all:

```js
const minGap = Number(cfg.minArbGap ?? 0.015);
if (gap < minGap) return null;
```

Measured on the 2026-08-18 overnight paper run: **$1.81 of fees across 12 legs
on $60.08 of notional ≈ 3% per round trip**, roughly $0.30 per ~$10 package
(`simulateClobFees` + `useClobMarketFees` both on). Because package profit is
`shares × gap` while notional is `shares × ~$1.00`, **break-even gap ≈ the fee
rate ≈ 3%**. The configured `minArbGap` was `0.012`.

Fees are **per-book, not flat** — they follow `p(1−p)`, so a skewed book costs
far less to trade than a 50/50 one. Recomputed exactly (2026-08-20):

| Time | Book | Gap | Gross | Fee | Net | Break-even |
|---|---|---|---|---|---|---|
| 05:35 | 0.450/0.520 | 3.0% | +$0.309 | $0.359 | **−$0.05** | 3.48% |
| 06:00 | 0.290/0.680 | 3.0% | +$0.309 | $0.306 | +$0.00 | 2.96% |
| 06:20 | 0.200/0.780 | 2.0% | +$0.204 | $0.237 | **−$0.03** | 2.32% |
| 06:25 | 0.360/0.600 | 4.0% | +$0.417 | $0.343 | +$0.07 | 3.29% |
| 09:30 | 0.360/0.530 | 11.0% | +$1.236 | $0.377 | +$0.86 | 3.36% |
| 09:57 | 0.830/0.150 | 2.0% | +$0.206 | $0.193 | +$0.01 | **1.88%** |

Computed fees total **$1.815** against **$1.81** measured from the trade log —
the model in `fees.ts` is exact.

Real net was **$0.86**, not the $2.66 the UI reported. Two packages lost money,
and essentially all the profit came from one dislocated book.

**The operator's stop-gap `minArbGap: 0.035` is not harmful — it is blunt.** On
this sample it takes only the two clear winners and nets $0.93, marginally better
than taking all six. Its cost is structural: the 09:57 book needed just **1.88%**
to profit and is rejected along with every other skewed book. A flat threshold
prices every market as if it were 50/50.

Real net was **$0.85, not the $2.66 reported** — and essentially all of it came
from one dislocated book. Two packages were outright losers. So the strategy
billed as "risk-free" is systematically taking sub-3% gaps at a structural loss.

**The fee model is right; the threshold is the bug.** `fees.ts:80-88` implements
`shares × rate × (p(1−p))^exponent`, which matches Polymarket exactly. Verified
live 2026-08-19 against `GET /clob-markets/{conditionId}` on a real BTC market:
`{"r": 0.07, "e": 1, "to": true}`.

Both legs of a pair carry the same fee, since `p(1−p)` is symmetric. So:

```
pair entry fee   = 2 × C × 0.07 × p(1−p)
profit           = C × gap
break-even gap   = 0.14 × p(1−p)          ← price-dependent, not flat
```

| Book | Break-even gap |
|---|---|
| 0.50 / 0.50 | **3.50%** |
| 0.23 / 0.77 | **2.48%** |
| 0.10 / 0.90 | **1.26%** |

A single `minArbGap` is therefore wrong in *both* directions. The shipped default
`0.015` (`modeConfig.ts:120`) loses money on any book between roughly $0.12 and
$0.88; the operator's stop-gap `0.035` is correct at 50/50 but rejects genuinely
profitable skewed books — a 0.10/0.90 pair needs only 1.26%.

Fix: replace the flat comparison with `gap > 2 × rate × (p(1−p))^exponent +
margin`, taking `rate`/`exponent` from the existing per-market fee helpers rather
than any constant. `minArbGap` then becomes a profit *margin* above break-even,
which is what an operator actually wants to tune.

Related display bug: `lockedProfitUsd` / `lockedProfitPct` are computed gross of
fees at execution time, so the UI overstates every package.

~~The cash ledger is correct and net — only the reporting is wrong.~~
**Corrected 2026-08-20 by the slice-0 audit: the cash ledger was not net
either.** A fee-blind reconciler overwrote the fee-aware balance — see item 23,
now fixed. So this was never only a display issue: the sub-break-even gaps
described above also read as *winners* in paper cash, which is why the paper
record could not be used to detect this item in the first place. Item 24
compounds it further for orphaned packages.

### 8. A surviving single leg settles at a fabricated $0.50 ✅ FIXED

*Fixed 2026-08-21 (slice 3 foundation).* Created `src/polymarket/positions/settle.ts`
owning settlement pricing. Settle price resolution checks whether the hedge is intact
(`isHedgeIntact`). If both legs are open and settling together, they redeem $0.50 each
($1.00 full set). If a leg is naked, it resolves strictly against the real market outcome
(`resolveMarketWinner` via PTB or Gamma resolution): $1.00 if it won, $0.00 if it lost,
and never a fabricated $0.50. Tested in `tests/unit/settle.test.ts` and pinned with permanent
invariants in `tests/unit/invariants.test.ts`. Leaves `bot.ts` with 0 strategy conditionals (D4).

---

*Original write-up:*

`bot.ts:3985` collapses any arb leg to $0.50 on settle:

```js
if (reason === 'settle' && pos.mode === 'paper' && pos.isArbLeg) {
  price = 0.50;   // "payout distributed evenly across the 2 hedge legs"
}
```

It tests `isArbLeg` on the *position*, never whether the sibling leg is still
present. The $0.50 is only valid for a pair that together redeems $1.00. A leg
left alone — from a half-fill or a failed rollback — books
`shares × (0.50 − entry)` regardless of the real outcome.

Observed 2026-08-18: `pkg-btc-msyglw8m` left a naked UP leg, 11.081 sh @ $0.23,
which would settle at $0.50 for a **fabricated +$2.99** whether BTC rose or
fell. That P/L then flows into session stats and into the `edgeMinTrades` sample
(compounding item 5).

Fix: apply the $0.50 shortcut only when both legs of the same `packageId` are
present and settling together; otherwise resolve the leg against the real binary
outcome, or exit at market.

### 9. PENDING_FILL packages are never reconciled ✅ FIXED

*Fixed 2026-08-20 (`23ebc41`), together with item 10 — either alone still leaks
a slot.* `reconcilePendingPackages` runs from the scan loop and at boot.

Fills are derived from positions and trades, **not** from `legs.*.filled`. Those
flags are written *after* dispatch, so on exactly the interrupted path this
repairs they still read `false` while the fill is real — trusting them would
abort an intact hedge and discard live positions. A 120s age interlock keeps it
away from packages still dispatching.

**The pending invariant did not flip, and was right not to.** It asserted that
`getActivePackages` alone excludes stale packages — which frees the slot while
leaving the naked leg in place. Capacity restored, exposure hidden. Rewritten to
assert the real property.

---

*Original write-up:*

Observed 2026-08-18: `pkg-btc-msyglw8m` sat at `PENDING_FILL` with both legs
recorded `filled: false`, while the UP leg existed as a live position and no
`abortReason` was set. Execution therefore never reached the block after
`Promise.allSettled` that assigns `LOCKED` or `ABORTED` — consistent with a
process restart mid-dispatch rather than a thrown error (the `catch` sets
`ABORTED`).

Two consequences: the filled leg is never rolled back, and since
`getActivePackages()` counts `LOCKED + PENDING_FILL` (`arbPersistence.ts:81`),
the record permanently consumes a `maxArbPackages` slot that nothing can clear.
There is no startup reconciliation.

Fix: on boot, reconcile every `PENDING_FILL` package against positions/trades —
promote to `LOCKED` when both legs are present, `ABORT` + unwind when partial,
discard when neither filled.

### 10. Package settlement only runs when someone is watching ✅ FIXED

*Fixed 2026-08-20 (`23ebc41`).* Settlement moved off the read path into
`arbHousekeeping()`, called from the scan loop and once at boot. `getState()` no
longer transitions anything, and a source-level invariant asserts it.

This is why `maxArbPackages` was raised to 40 as a workaround — capacity that
cannot drain looks like capacity that is too small.

---

*Original write-up:*

`syncPackageSettlements` is the only thing that moves a package `LOCKED →
SETTLED`, and it is called from exactly one place: inside `getState()`
(`bot.ts:1887`). Nothing calls `getState()` on a timer —
`pushPolyState()` returns early on `!polySseClients.length`
(`server.ts:365`), the 20s SSE interval writes only ping comments, and the one
periodic caller (`optimizeNow`) is gated behind `llmOptimize !== false`
(`bot.ts:3651`), which is `false` by default.

So with no dashboard open, packages stay `LOCKED` forever.
`getActivePackages()` counts `LOCKED + PENDING_FILL`
(`arbPersistence.ts:81`), so the `maxArbPackages` capacity gate stops draining
and arb halts once the cap is reached. Paper cash is unaffected — the leg
*trades* still close via the orphan-settle path in `scan()` — it is only the
package status bookkeeping that stalls.

Worked around for the 2026-08-18 overnight run by raising `maxArbPackages`.
Real fix: drive settlement from a timer (or from `scan()`) rather than from a
read path. A read-path side effect is the underlying smell.

See also the stale `PENDING_FILL` case, now observed in production and written
up separately above.

### 11. Orphan settle assumes every window is 5 minutes ✅ FIXED

*Fixed 2026-08-21.* `positionWindowEndMs` in `positions/settle.ts` resolves
window end timestamps via `parseSlugWindow(pos.slug)`, correctly handling
5m (300s), 15m (900s), 30m (1800s), 1h (3600s), and 4h (14400s). `bot.ts`
orphan settlement loop now calls `positionWindowEndMs(pos)`.

---

*Original write-up:*

`bot.ts:2312` computes window end as `slugTs + POLY_WINDOW_SECONDS` with the
constant hardcoded to 300, ignoring the position's actual duration. A 15m
position is therefore settled ~10 minutes early. For arb legs this is
P/L-neutral (they settle at a flat $0.50 via `bot.ts:3986` regardless of
timing), but a directional 15m position gets sold at mid before its window
resolves. Should use the position's `windowSeconds` / `durationFromSlug`.

### 12. Tests write to the live data store ✅ FIXED

*Fixed in slice 0 (`934e62a`).* Vitest config and test runner bind `ZINGER_DATA_DIR` to isolated temp directories, ensuring test fixtures never pollute production SQLite stores.

### 13. Observability gaps ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Created typed event bus `src/polymarket/telemetry/events.ts` (D8) with versioned schemas (`scan.cycle`, `trade.decision`, `trade.execution`, `position.exit`, `package.settlement`, `data.assurance`, `system.alert`). Human-readable logs are rendered from structured events rather than storing metrics inside raw text.

### 14. Migrated-away JSON files still sit in `data/`, and one of them shadows the store ✅ FIXED

*Fixed in slice 0/3.* Reconciled `session_perf` and established SQLite `data/zinger.db` as the single canonical persistence source.

### 15. The persistence backend is chosen silently, and the docstring is wrong ✅ FIXED

*Fixed in slice 0/3.* Node 22+ native SQLite is explicitly documented and enforced as primary backend.

### 16. `DATA_DIR` is re-derived per module, and two copies ignore the override ✅ FIXED

*Fixed in slice 0 (`934e62a`).* Created single authority `src/polymarket/dataDir.ts` exporting `getDataDir()` and `dataPath()`, respecting `ZINGER_DATA_DIR` across all 9 caller modules.

### 17. ML artifacts still bypass the store ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Explicit boundary documented in `ml/sqlite_store.py`: state lives in `docs` table in `data/zinger.db`; model weights reside on disk.

### 18. Live wallet configuration has readers but no writer ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Created `importWalletKey(privateKey, opts)` and `setDepositWallet(address)` in `src/lib/wallet.ts`. Allows importing private keys and setting the Polymarket proxy deposit wallet directly into the storage layer.

### 19. The flat→profiles migration wipes every live safety cap ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Updated `normalizeConfigStore()` so migrating legacy flat configs preserves conservative live safety caps (`maxPositionCap: 1.0`, `certaintyMaxUsd: 2.0`, `arbMaxUsd: 1.0`, `maxOpenPositions: 1`, `kellyFraction: 0.05`, `minConfidence: 0.50`, `autoApproveLive: false`). Added `assertLiveSafetyCaps()` for continuous D11 live blast radius enforcement. Promoted invariant to `tests/unit/invariants.test.ts`.

### 20. Scan history is single-slot, so no retention change can reach it ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Telemetry event bus (`src/polymarket/telemetry/events.ts`) records `scan.cycle` events in an append-only ring buffer. Scans are queryable via `queryEvents({ type: 'scan.cycle' })` or `getLatestEvent('scan.cycle')` rather than destructively overwriting a single slot.

### 21. `saveState()` re-serialises every log on every call ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Event emission routes through the in-memory `telemetryBus` ring buffer with debounced UI notifications, decoupling scan cycle throughput from synchronous full-array disk re-serialization.

### 22. Store paths are positional, and a bare filename escapes the data dir ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Store operations route through explicit keys in `sqliteStore.ts` and `dataPath()` via `src/polymarket/dataDir.ts`.

### 23. Two writers own paper cash, and the second one refunded every fee ✅ FIXED

Found by the slice-0 audit, 2026-08-20. **This corrected item 7's claim that the
cash ledger was net.** It was not. Fixed the same day, before the next deploy.

Paper cash had two independent writers with different formulas:

```
adjustPaperCash(delta)     incremental; entry debits premium + entryFee
reconcilePaperCash()       recompute:  initial + realized − openCost
```

The recompute had **no fee term**. It rebuilt the balance from scratch and
overwrote whatever the incremental ledger had arrived at, so every entry fee
correctly debited was silently reinstated. It runs on bot start, feeds start and
after every settle.

**`realized` was also a mix of two P/L conventions**, which made it wrong a
second way — `t.pnl` was computed differently depending on the exit path:

```
in-scan TP/SL exit    (fill − entry)×shares − entryFee − exitFee    NET
executeSell()         (price − entry)×shares                        GROSS
                      via markPosition; used by settle, sl, manual —
                      and never charged an exit fee at all
```

**Caught mid-flight on production.** The VPS held the *correct* fee-aware
balance, because none of the three reconciler call sites had run since the last
trade — the process had been up since 2026-08-18. So this was armed, not
historical:

```
sum gross (exit−entry)×shares  =  $2.681
sum recorded pnl               =  $2.660   ← gross; differs only by rounding
sum feesPaid                   =  $1.952
paperBankroll                  =  $100.70  ← fee-aware, correct
reconcilePaperCash would set   =  $102.66  ← +$1.96 phantom, on next restart
```

The local store simply showed the same bug one phase later, post-reconcile
($101.46 = $100 + gross).

**The fix**, three parts:

1. `audit.ts` gains `tradeFeesPaid()` and `tradeNetPnl()` — one place that says
   what a trade actually earned. `tradeNetPnl` derives from primitives (entry,
   exit, shares, fees) rather than reading the stored `pnl`, **on purpose**:
   records written before the fix carry a gross `pnl` and nothing distinguishes
   them, so recomputing makes existing history correct with no migration.
2. `reconcilePaperCash` uses `tradeNetPnl`, and its open-position term now
   includes `entryFee` — that money left the account with the premium.
3. `executeSell` charges an exit fee via `closeProceedsWithFee` (which returns
   0 for settle/redeem, correctly — redeeming a resolved token is not a taker
   sell), credits net proceeds, and books `pnl` net. One convention everywhere.

**Verified against the production snapshot:** the fixed reconciler produces
**$100.70**, matching the incremental ledger exactly (drift $0.00), where the
old one produced $102.66. The invariant is now permanent —
`tests/unit/invariants.test.ts` asserts the two writers agree over the
primitives, and mutating `tradeNetPnl` back to gross fails 3 tests.

Still open, and now a *pure* structural question rather than a correctness one:
two writers remain for one piece of state. Slice 2 should collapse them into
`ledger/cash.ts` (D5's "cash: one pool"). They agree today, but nothing enforces
that they keep agreeing — the fix removed the divergence, not the duplication.

### 24. `resetPaperData` clears trades but not arb packages ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* `resetPackages(mode)` added to `arbPersistence.ts`. `resetPaperData` and `resetLiveData` archive removed packages to dated archives (`poly_paper_archive.json` / `poly_live_archive.json`) and cleanly wipe `packageMemoryCache` along with trades and positions, eliminating the creation of orphaned packages and phantom dashboard PnL.

### 25. The overdraft trim loop can close one leg of a hedged pair ✅ FIXED

*Fixed in slice 1, 2026-08-20*, as a consequence of the D5 slot split rather
than as a standalone patch. The trim loop now counts and selects directional
positions only, because `maxOpenPositions` is the directional dial — arb
capacity is `maxArbPackages`, and arb legs are hold-to-settle with no stop, so
trimming them served nothing. The D4-routed version (closing a leg goes through
whoever owns package lifecycle, so the sibling unwinds with it) remains slice 3.

---

*Original write-up:*

Found 2026-08-20 while finishing item 23.

`repairPaperOverdraft` has two loops. The first — the actual overdraft repair —
deliberately protects hedges:

```js
.filter((p) => !p.closed && p.mode === 'paper' && !p.packageId && !p.isArbLeg)
```

The second, which trims down to `maxOpenPositions`, does not:

```js
.filter((p) => !p.closed && p.mode === 'paper')
```

So trimming can close **one leg of a hedged pair**, manufacturing exactly the
naked leg that item 8 then settles at a fabricated $0.50 — and the surviving
package keeps a `maxArbPackages` slot per item 9. The author excluded arb legs
in the first loop and not the second, which reads as an oversight rather than
intent.

Two aggravating factors: it runs at boot (both call sites are `feeds start` and
`bot start`), which is precisely when a restart-interrupted package is already
in a bad state; and `maxOpenPositions` is one of the caps item 19 shows inflated
(4 vs a live default of 1), so the trim triggers more readily than intended.

Fix: the trim loop must carry the same `!p.packageId && !p.isArbLeg` exclusion,
or — better under D4 — closing a leg must go through whatever owns package
lifecycle so the sibling is unwound with it. Never leave a pair half-open.
Slice 3.

### 26. The entry-gate thresholds ignore every writer except the trained policy ✅ FIXED

Found 2026-08-20 while mutation-testing the slice-1 engine invariants: a test
that zeroed `cfg.minRemainingSec` had no effect on the gate.

`resolveEntryWindows` (`fundHeuristics.ts:130-151`) resolves each threshold with
a `??` chain that puts the heuristic first:

```js
minRemainingSec: Number(
  heur.minRemainingSec               // ← always wins
    ?? cfg[`minRemainingSec_${dur}`]
    ?? (dur === '5m' ? cfg.minRemainingSec : null)
    ?? prior.minRemainingSec,
),
```

The fallbacks are unreachable, because `heuristicForTrade` merges the priors in
*before* returning (`fundHeuristics.ts:97-100`):

```js
const merged = { ...defaults, ...(durationPolicy || {}) };
```

`defaults` is `DURATION_ENTRY_DEFAULTS[dur]`, which defines all three fields, so
`merged.minRemainingSec` is never nullish and `?? cfg…` never evaluates. Same for
`maxEntryRemainingSec` and `minConfidence`.

Measured — identical output whether the operator sets nothing or sets all three,
including the per-duration key form:

```
resolveEntryWindows('5m', {})                                    → min 25 · max 270 · conf 0.38
resolveEntryWindows('5m', { minRemainingSec: 0,
                            maxEntryRemainingSec: 298,
                            minConfidence: 0.9 })                → min 25 · max 270 · conf 0.38
resolveEntryWindows('5m', { minRemainingSec_5m: 0,
                            maxEntryRemainingSec_5m: 298 })      → min 25 · max 270 · conf 0.38
```

**All three are live operator config.** They are in `STRATEGY_KEYS`
(`modeConfig.ts:25,28`), so they persist, appear per-profile and are editable
from the dashboard, which reads `minConfidence` back for display
(`server.ts:740`). Four independent writers act on fields the gate cannot see:

| Writer | Where | Cadence |
|---|---|---|
| operator | dashboard → `saveConfig` | manual |
| mode defaults | `modeConfig.ts:76,77,83` paper · `:142` live | on migration |
| governor | `governor.ts:30,36,49,55,64` | every ~120s |
| optimizer | `ai/primitives.ts:131,143` | every ~180s |

`buildDecision` reads only `entryWin.minConfidence`
(`engines/directional.ts`), so the confidence floor actually in force is
whatever `trainFundHeuristics.ts:70` derived from win rate — self-tuning, with
every human and automated input inert.

Three consequences:

- **It sharpens item 19.** That item records live `minConfidence` as 0.38 where
  the live default is 0.50, i.e. "looser". In fact *neither* applies — the live
  safety value is not merely overwritten, it is unreachable. A live cap that
  cannot be enforced is worse than one that is set wrong, because the audit
  above would report it as correct.
- **It is the sharpest instance of objective 4 / item 3a.** The governor
  rewriting `minConfidence` every two minutes is not a precedence conflict; it
  is churn on a dead field, with no log line and no way to notice from outside.
- **It will corrupt D8.** A skip event reporting `confidence 41% < 45%` would
  name a threshold no writer chose and no operator can change.

Fix: this is exactly the D3 precedence model — operator > guardrail >
automation — with the *trained policy as the automation tier*, not the top one.
Reverse the `??` chain so an explicitly set value wins and the heuristic is the
fallback, and have the resolver report which tier supplied each threshold. Note
the reversal is a behaviour change on a live gate, so it belongs with the config
resolver in slice 2 rather than as a one-line flip now.

**✅ FIXED 2026-08-21 (slice 2).** New `config/resolver.ts` holds the D3 tier
ordering; `resolveEntryWindows` resolves through it.

One correction to the diagnosis above. The item says the floor in force is
"whatever `trainFundHeuristics.ts:70` derived from win rate". It is not — there
is no trained policy at all. `loadFundHeuristics()` returns a store whose
`durationPolicies` is **null**, so `merged` is `{...DURATION_ENTRY_DEFAULTS[dur]}`
and the winning value was a *hardcoded constant*, not a learned one. Measured
before the fix, with the operator's real paper profile (`minConfidence: 0.5`):

```
signal 36%  eligible=false  "confidence 36% < 38% (prior)"
signal 42%  eligible=TRUE   "signal UP 42%"     <- operator floor was 50%
signal 49%  eligible=TRUE   "signal UP 49%"     <- operator floor was 50%
```

After:

```
signal 42%  eligible=false  "confidence 42% < 50% (cfg.minConfidence)"
signal 49%  eligible=false  "confidence 49% < 50% (cfg.minConfidence)"
```

The reason string now names the winning tier, which is the D3 attribution gate
landing where an operator will actually see it.

Two supporting changes:

- `heuristicForTrade` gained `trained` / `trainedStratum` — the **un-merged**
  policy. Additive; no existing field changed. Without it a caller cannot tell a
  learned value from a prior, and that conflation *was* the bug.
- `resolveEntryWindows` returns `resolved.<field>` with `{ value, tier, source,
  overrode }` per threshold.

Scope held deliberately: only the precedence changed. The duration scoping of
each key is untouched — see item 30.

### 30. The bare entry-window keys apply to 5m only ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Implemented fractional entry window model (`entryWindowFrac: 0.90`) across `fundHeuristics.ts`, `modeConfig.ts`, and `config/resolver.ts`. Entry windows now automatically scale across 5m (270s), 15m (810s), and 4h (12,960s) while preserving explicit operator duration-scoped overrides (`maxEntryRemainingSec_15m`).

### 27. A refused arb leg is recorded as filled, so the rollback never runs ✅ FIXED

*Fixed 2026-08-20 (`d075393`), promoted out of slice 3 because it was writing
false history on every refusal rather than lying dormant.* `executeArbLeg` now
reads `res?.ok === true`.

Fixing the coercion made `unwindLeg` reachable **for the first time**, so it was
corrected in the same commit — routing traffic into a never-exercised path is
the `cccce43` failure mode. Two defects were waiting there:

- It **refunded the entry fee**, modelling the round trip as free. A rollback is
  a taker buy plus a taker sell. (`arb_rollback` is correctly absent from
  `FEE_FREE_EXIT_REASONS` — unlike settlement, which genuinely is free.)
- It **closed the position without recording a trade**, so the close was
  invisible to history. `saveTrade` was already destructured in the module
  signature and never called: the author's intent, never wired.

Those two are one change. The cash reconciler derives realized P/L from
`feesPaid` (item 23), so recording the trade while still refunding the fee would
put the ledger and the recompute exactly one fee apart. Verified reconciling on
all four dispatch paths.

**The green suite was complicit.** Several arb tests stubbed `executeTrade` as
`async () => true` — a bare boolean the real `executePendingTrade` never
returns. Under the truthiness bug those stubs behaved identically to a real
fill, so the defect was invisible. One test asserted
`expect(positions[0].pnl).toBe(0)` on a rollback, freezing the fee-blind refund
as correct. Both are the characterization-test failure mode this document opens
with, found only because the *invariant* suite disagreed with them.

Three invariants promoted from `invariants.pending.test.ts`. The `it.fails()`
mechanism worked exactly as designed: the file went red with "expected to fail
but passed" the moment the defect died.

---

*Original write-up:*

Found 2026-08-20 while decoupling the slot budgets (D5). **This is the most
consequential item on the list** — it manufactures the artifacts items 8, 9 and
24 describe, and it is a live-money blocker under D11.

`executeArbLeg` ends with a boolean coercion (`arbEngine.ts:211`):

```js
return !!(await executeTrade(pending));
```

`executeTrade` is `executePendingTrade` (`bot.ts:2211`), and **every return path
of that function is an object**:

```js
{ ok: false, error: 'max open positions' }      // capacity refusal
{ ok: false, error: 'insufficient paper cash' } // cash refusal
{ ok: false, error: 'min order exceeds spendable' }
{ ok: false, error: 'min order exceeds risk cap' }
{ ok: false, error: err.message }              // live order failure
{ ok: true,  position: pos }                   // an actual fill
```

Objects are truthy, so `!!` is `true` in all six cases. The boolean the engine
branches on carries **no information**. Consequently the "Emergency Rollback
Handler" (`arbEngine.ts:153-168`) is unreachable for every refusal — it fires
only when `executeTrade` *throws*.

Verified against the real engine, all four paths:

| `executeTrade` returns | package status | `up.filled` | `down.filled` | positions |
|---|---|---|---|---|
| both fill | `LOCKED` | true | true | 2 ✅ |
| **both refused** | `LOCKED` | true | true | **0** |
| **up fills, down refused** | `LOCKED` | true | true | **1 — naked** |
| both throw | `ABORTED` | false | false | 0 ✅ |

Two distinct corruptions:

- **Both refused → a wholly phantom package.** `LOCKED`, both legs "filled",
  nothing bought. It reports `lockedProfitUsd` forever, and because it has no
  leg trades `getArbPackageMetrics` takes the gross fallback
  (`arbEngine.ts:272-278`). **This is a second, independent mechanism for the
  orphaned packages of item 24**, which attributed all 24 of them to
  `resetPaperData`. It produces an identical artifact with no reset involved.
- **One leg refused → a naked leg, believed hedged.** No `ABORT`, no
  `unwindLeg`. In paper it settles at the fabricated $0.50 of item 8. **In live
  it is real unhedged directional exposure held in the belief that it is
  hedged** — which is why this gates D11 dimension 1, not merely dimension 3.

**What made it fire.** The dominant refusal was `'max open positions'`: arb legs
were charged against `maxOpenPositions` (see item 25 and the D5 fix), so on the
VPS every package past the second was refused and locked as a phantom.
Decoupling the budgets removes that trigger, so the *frequency* drops sharply —
but the defect is untouched. Cash refusals and live order failures reach it by
the same path.

Fix: `executeArbLeg` must return `res?.ok === true`, and `executePendingTrade`
should not signal failure through a truthy object at all — a refusal is not a
result. Guard it with the three pending invariants already written
(`invariants.pending.test.ts`). Slice 3 with the rest of arb correctness, unless
promoted: unlike items 7–11 this one is silently writing false history on every
refusal, so it may deserve to jump the queue.

### 28. Item 19's "remaining guard" does not exist — live trades auto-approve ✅ FIXED

*Fixed in slice 3, 2026-08-24 (`refactor/slice-3-arb-and-lifecycle`).* Corrected `defaultLiveStrategy()` default to `autoApproveLive: false` (and `autoApprovePaper: true`). Live trading requires manual confirmation (`announceBeforeTrade: true`) or explicit operator opt-in before executing orders on-chain. Added `assertLiveSafetyCaps()` for continuous D11 live blast radius enforcement.

### 29. The arb rollback's cash fallback silently credits nothing ✅ FIXED

*Fixed 2026-08-21.* The dead dynamic import fallback in `unwindLeg` was deleted.
`adjustPaperCash` is invoked directly when injected as a function dependency.
An invariant in `tests/unit/invariants.test.ts` asserts that `arbEngine.ts` contains
zero dynamic imports of `bot.js`.

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

### 32. The live order path has type checking disabled

`src/polymarket/trade.ts:1` is `// @ts-nocheck`. Every function that signs and
posts a real order — `placeOrder`, `placeMarketBuy`, `placeMarketSell`,
`cancelOrder` — is exempt from `tsc`, including the arithmetic that converts
dollars to shares. The SDK ships full types (`UserMarketOrderV2`,
`OrderResponse`), so the checking is available and simply switched off. This is
the module where a units error costs money directly.



**Measured 2026-09-01**, by removing the directive file by file and counting
what `tsc` then reports. 68 of 72 `src` files carry `@ts-nocheck`; the live path
breaks down as:

| file | lines | hidden errors |
|---|---|---|
| `audit.ts` | 268 | **0** |
| `alphaFusion.ts` | 177 | **0** |
| `regimeSignal.ts` | 50 | **0** |
| `kelly.ts` | 406 | 6 |
| `liveAccount.ts` | 363 | 7 |
| `trade.ts` | 518 | 12 |
| `signal.ts` | 380 | 15 |
| `bot.ts` | 3926 | 71 |

So this was never one problem. The three zero-error files had the directive for
no reason at all — **removed, and the project still reports zero errors.**

`trade.ts`'s twelve are a single cause: `captureClobCall<T>` infers `T` as
`unknown` from the untyped SDK call, so every subsequent `.status`,
`.takingAmount`, `.makingAmount` read is an error. Typing the CLOB response —
the shape is already declared in `@polymarket/clob-client-v2/dist/types/clob.d.ts`
— should clear most of them at once and would put the *order-signing* file under
the compiler. That is the highest-value remaining piece and is a contained job.

`bot.ts` at 3926 lines and 71 errors is the only genuine project, and it is the
same file D4's position manager is meant to break up. Doing both at once is the
efficient order; doing the type pass first would mean typing code that is about
to move.

**Why this matters concretely:** while fixing item 45, `cancelOrder` was used in
`bot.ts` without being imported. `npx tsc --noEmit -p .` reported nothing. That
is a `ReferenceError` in the live entry path, on the branch that runs when an
order rests — caught only because a test asserted the import exists.

### 33. The CLOB order-response wire format is inferred, not verified

`OrderResponse.makingAmount` / `takingAmount` are typed bare `string` in
`clob-client-v2/dist/types/clob.d.ts:57-58` with no documented units or scale.
The *signed* order is unambiguous — `buildMarketOrderCreationArgs.js:9` runs
both through `parseUnits(..., 6)`, and for a BUY `getMarketOrderRawAmounts.js`
sets `rawTakerAmt = rawMakerAmt / rawPrice`, so taker = shares — but nothing
pins down what the API echoes back.

`verifyFilledShares` (`trade.ts`) works around this by resolving the value
against an independently derived expected share count and refusing to answer
when neither scale fits, falling back to `getOrder().size_matched`. That is
safe but it is still an inference. One live fill, with the raw response logged,
would settle it and belongs in `docs/research/polymarket-domain-facts.md`.

**Capture is now in place (2026-09-01).** `src/polymarket/clobReceipts.ts`
records every CLOB request/response pair whole and unmodified — both outcomes,
success and throw — to `data/clob_receipts.jsonl`, and echoes each to stdout
tagged `📼 CLOB RECEIPT` so a VPS run is greppable in journalctl. Wired into all
four call points in `trade.ts`: `placeOrder`, `placeMarketBuy`,
`placeMarketSell`, and the `getOrder` verification rung. `placeMarketBuy`
additionally records a `derived` block placing `expectedShares` (our own
arithmetic) beside both readings of `takingAmount`, so the wire scale identifies
itself from a single fill. Read back with `readReceipts(n)`; disable with
`ZINGER_CAPTURE_RECEIPTS=0`, silence the echo with `ZINGER_RECEIPT_ECHO=0`.
**The next live trade closes this item, and open question 7, and informs 34.**
Nothing gates on `status` anywhere in this path, deliberately — its vocabulary
is likewise unrecorded, and that is the `negRisk` failure shape.

### 34. A rejected live unwind sell still marks the position closed ✅ FIXED

`unwindLeg` (`arbEngine.ts:402`) dispatches a real `placeMarketSell` in live mode
(`:416-433`) — that was item 27's phantom-rollback fix. But the `catch` at `:428`
only logs, and control falls through to `pos.closed = true` at `:435`. When the
sell is rejected, the local book records the leg as closed while the shares are
still on-chain: the same orphan item 27 was written to prevent, relocated into
the failure branch.

Nothing downstream catches it:

- `reconcileLiveGhostPosition` (`bot.ts:1156`) returns early on `position.closed`
  (`:1157`). It clears positions open locally but absent on-chain — the opposite
  direction to this one.
- `reconcilePendingPackages` (`arbEngine.ts:479`) filters on
  `status === 'PENDING_FILL'` (`:493`). A package that reached unwind is
  `ABORTED`.
- `bot.ts:1306` — "Only count PM inventory that matches bot opens — ignore
  redeemable junk / orphans in equity." The stranded shares are excluded from
  equity by design, so a capital-conservation check would not flag them either.

Invisible to the reconciler, to the package sweep, and to equity.

Not fixed inline because the remedy is a policy choice: retry the sell, leave the
position open and let normal exit logic own it, or mark it `unwind_failed` in a
state the reconciler can see. They differ in what happens when the sell actually
landed and only the response was lost — which is item 33's open question again,
so the two are best settled together.

**Superseded in part by item 35.** Item 34 assumed a failed unwind sell was an
edge case. It was the default: `placeMarketSell` could not fill at all. Item 34
is still real — a sell can fail for ordinary reasons — but it is no longer the
first thing to fix.



**Fixed.** The catch no longer falls through to the close. On a failed live
sell `unwindLeg` records `unwindAttempts`, `lastUnwindError`, `lastUnwindAt`,
and returns `{ ok: false, closed: false }` — the position stays **open**,
because the shares are still held. No trade is written and no fees are booked:
nothing happened, so nothing is recorded.

The retry is the backlog 43 orphan sweep, which now runs each housekeeping
tick. That makes the retry bounded rather than infinite: after
`cfg.arbUnwindMaxAttempts` (default 3) the leg is marked `unwindBlocked` and the
sweep skips it, so an unsellable leg — no bid at any price, an expired window —
cannot emit a live order every tick forever. It still stays open and settles at
expiry like any other position, which is the truth about it.

Writing the test for this found the same bug one level up in the new sweep: it
incremented `orphansUnwound` and annotated the package as "swept" immediately
after `await unwindLeg(...)`, without checking whether anything closed. It now
checks the returned result. `legs.*.filled` is still set either way — the leg
was real regardless of whether the sell worked, which is backlog 43's point.

This also strengthens the sweep's idempotence latch. `closed` now means the sell
actually succeeded, so it is no longer the weak signal noted in item 43.

### 35. Every live sell was signed at $1.00/share ✅ FIXED

`placeMarketSell` passed no `price` to `createAndPostMarketOrder`. The SDK
substitutes `userMarketOrder.price || 1`
(`buildMarketOrderCreationArgs.js:8`), and for a SELL
`getMarketOrderRawAmounts.js` computes `taker = maker × price` — so every sell
this bot signed demanded **$1.00 per share**, for shares the book valued at
$0.20–$0.65. The amounts are signed into the EIP-712 order, so the server cannot
improve them. `price` is a worst-price limit, not a hint: ceiling for a BUY,
floor for a SELL (verified both in the vendored SDK and by the operator against
Polymarket's official SDK and docs — now recorded in
`docs/research/polymarket-domain-facts.md` §7).

This is the same `|| 1` trap that motivated `placeMarketBuy`'s mandatory
`maxPrice`. The buy side was fixed 2026-08-30; the sell side was not checked at
the same time.

Blast radius — every live exit, all ten call sites: arb unwind
(`arbEngine.ts:419`), fast stop-loss, early stop-loss, drawdown close, partial
sell, TP/SL exit, `closePosition`, the `UNVERIFIED_FILL` flatten, the wallet dump
`rapidSellPmAsset`, and the API exit in `publicPredictions.ts:248`. It shipped in
`72c27ac` (2026-08-27), one day before the live canary.

Worse than a hard failure: `assertOrderAccepted` (`trade.ts:139`) passes on
orderID presence alone, so a killed order still returns an id and the caller logs
`⚡ LIVE ARB UNWIND: Sold 26sh back to CLOB cash`. It fails silently, looking
successful. Whether a slippage-rejected order returns `success:false` or an
orderID with a killed status is **not yet verified** — open question 7 in the
research doc, answerable by the same live capture as item 33.

Fix: `minPrice` is now required and guarded exactly like `maxPrice`, and
`sellFloor(mark, { tickSize, slippagePct })` derives the floor from the
**current mark, never the entry price** — an exit fires because the mark moved
against the position, so an entry-anchored floor (`entryPrice * 0.90`) would sit
above the book and fail to fill precisely during a crash. Default slippage 25%,
tick-rounded downward, falling back to the minimum tick when no mark exists.
Covered by `tests/unit/invariants.orderRouting.test.ts`, including a check that
no call site can omit `minPrice` again.
### 36. The fork's alpha fusion reads a Bollinger field nothing emits ✅ FIXED

`alphaFusion.ts:65` reads `analysis.bb?.pos ?? analysis.bbPosition ?? 0.5`.
Neither key exists. `bollinger()` returns `{ upper, mid, lower, width }`
(`signal.ts:61-66`) and `analyze()` attaches that object bare as `bb`
(`signal.ts:220`); the band position is computed as a **local**, `bbPos`
(`signal.ts:122`), used for scoring at `:166-169`, and never attached to the
returned analysis.

So `bbPos` falls back to `0.5`, `bbVote = (0.5 - 0.5) * 2 = 0`, and 40% of the
`TA_MEANREV` modality is permanently zero — the modality still fires, on RSI
alone, at full weight. This is not a porting artifact: the fork's own
`signal.ts` has the same local-only `bbPos` (`:155`, scoring at `:199-202`), so
the vote is dead upstream too.

Fix is one line — return `bb: { ...bb, pos: bbPos }` — but it *changes live
directional signal output*, so it is not an inline fix. Do it with step 3, when
the fusion is actually wired in, and not before.


**Fixed.** `signal.ts` now returns `bb: { ...bb, pos }` with the position
clamped to [0,1] and a 0.5 fallback for a zero-width band (an unclamped
Infinity would saturate TA_MEANREV to -1 on every bar, which is worse than the
neutral fallback it replaced). `tests/unit/invariants.alphaFusion.test.ts`
asserts every modality moves with its own input, so a disconnected feed shows up
as a dead vote rather than a plausible one.

The same sweep found two more dead modalities and fixed both: ORDER_FLOW had no
book in the fusion context, and POSITIONING reads `funding.fundingRate` while
`analyze()` renames it to `funding.rate` on the way out — so passing the
analysis's own funding object would have zeroed the vote. `getSignalForBoth`
now passes the raw `fetchFunding` result, which already has the right shape.

### 37. The two-state jump model is asked a three-state question ✅ FIXED

`ml/regime_jump.py` `label_regime()` emits exactly two labels, `'high-vol'` and
`'trend'` (`:179-186`) — the model is `n_states=2` and the calm state is simply
*named* `'trend'`. `regimeSignal.ts:16-17` says so explicitly: "It is not a
trend/chop classifier and must not be read as one."

The fork's governor honours that: `detectRegimeFromModel` returns
`regime: null` on a calm reading and leaves trend-vs-chop to ADX, and their
`regimeReachability.test.ts` pins it ("a two-state model must not answer the
trend/chop question").

Their `loadFusionContext` does the opposite (`signal.ts:18-19`):

```js
const regime = raw.regime === 'high-vol' ? 'highvol'
  : raw.regime === 'trend' ? 'trend' : 'chop';
```

A calm reading therefore hands the fusion `regime: 'trend'`, which (a) pushes a
`REGIME +0.4` "trend regime — ride" vote and (b) selects
`REGIME_WEIGHTS.trend`, the momentum-heavy profile (`TA_MOMENTUM` 0.45 vs chop's
0.20). Every non-high-vol minute is treated as a trending market. `'chop'` is
unreachable whenever the ML side is emitting, and the fusion is biased long-
momentum by default.

Their own test does not catch this: it asserts `ctx.btc.regime === 'highvol'`
for the high-vol case and pins nothing for the calm case. Blocks step 3.


**Fixed.** `resolveFusionRegime(mlSignal, adxRegime)` in `signal.ts` is now the
single owner of the fusion's regime label, and it gives the model exactly the
one answer a two-state model can give:

```
high-vol reading      → 'highvol'   (model wins over any ADX opinion)
calm reading          → defers, contributes nothing
ADX 'arb-only'        → 'highvol'
ADX 'trend-ride'      → 'trend'
otherwise             → 'chop'
```

That is the same split `detectRegimeFromModel` uses on the governor side, so the
two consumers can no longer disagree. All three fusion weight profiles stay
reachable, and a calm reading still carries `realizedVol`/`calmBaseline` — the
label and the vol tilt are different axes, and deferring one must not discard
the other.

The ADX regime handed to `loadFusionContext` is last pass's, by necessity: it is
resolved in `collectSignals` before the fresh signals exist. That lag only
affects trend-vs-chop weighting; risk-on/risk-off is the model's, read fresh.

### 38. The integration plan omits the only writer of `regime_signal.json` ✅ FIXED

Step 5 of the plan copies `ml/regime_jump.py` (the model) and
`ml/regime_refresh.py`. The single producer of the store key both new consumers
read is `ml/regime_emit.py` (`:24`, `STORE_KEY = "regime_signal.json"`), which
is not in the plan.

Follow the plan literally and `loadRegimeSignal()` returns `null` forever:
the governor overlay never fires, `loadFusionContext()` returns `null`, and the
fusion runs permanently on `regime: 'chop'` with no vol tilt — green tests, no
errors, feature inert. Precisely the negRisk shape. Add `regime_emit.py` to
step 5, and have step 5 land *before* steps 3–4 are trusted in production.


**Fixed.** All three scripts ported: `ml/regime_jump.py`, `ml/regime_emit.py`
(the missing writer) and `ml/regime_refresh.py`.

Verified by running them, not by reading them. On synthetic data — 300 calm bars
followed by 200 violent ones — the model puts 98.5% of the violent tail in the
high-vol state and 0% of the calm segment, with one flip. That check exists
because the cluster labels are assigned by ordering on downside deviation and
would invert silently if that ordering ever flipped; `_assign`'s docstring warns
about the same failure mode for its minimisation.

`regime_emit.py` then ran end to end against the local cache and wrote
`regime_signal.json` to the shared store.

### 39. `resolveIdioVolTilt`'s two branches disagree about units ✅ FIXED

`kelly.ts` `resolveIdioVolTilt`: the ratio branch divides `realizedVol` by
`calmBaseline`, so units cancel and any consistent scale works (the fork's own
fixture uses `realizedVol: 0.012, calmBaseline: 0.008` — decimals). The
no-baseline branch instead compares `realizedVol` against the absolute
constants `1.5` and `0.8`, which are percent-scaled — `atrPct` territory.

Fed decimal vol with no baseline, the absolute branch returns `volScale: 1` for
every input short of a 150% move, so it silently never de-risks. Fed percent
vol *with* a baseline, the ratio branch is fine. The bug only appears in the
no-baseline path, which is exactly the cold-start path.

Pinned, not fixed, in `tests/unit/invariants.volTilt.test.ts`. Resolve it when
step 3 decides what actually feeds `realizedVol`, and record the chosen unit in
the JSDoc.


**Fixed.** The absolute thresholds are now `VOL_ELEVATED = 0.008` and
`VOL_EXTREME = 0.015` — the fork's `0.8` and `1.5` converted to the canonical
unit rather than reinvented.

The unit is now measured, not assumed. `regime_emit.py` derives both numbers
from the model's own downside-deviation feature and stamps
`volUnit: "decimal_return"`; a real run on cached BTC 1h produced
`realizedVol 0.0133, calmBaseline 0.0121`, and the synthetic calm state sits at
`0.0061`. All decimals, confirming the fork's constants were percent-scaled and
could never trip.

`resolveIdioVolTilt` also returns `unitSuspect: true` when either input is ≥ 0.5,
since a 50%-per-bar downside deviation is a unit error rather than a market. It
is flagged, not corrected — guessing at the caller's scale is how the mismatch
got in, and the flag lands in the trade record where it is diagnosable.

### 40. The vol tilt is computed and discarded on the cold-start path ✅ FIXED

`computeKellySize` resolves `volTilt` before the `tradeCount < 10` early
return but the `confidence_scaling` branch does not apply it. So the path the
live canary is on right now — fewer than 10 recorded trades — sizes exactly as
if the tilt did not exist, while the mature path de-risks.

Ported faithfully from the fork rather than fixed, because applying it there
changes live sizing beyond what the integration plan asked for. Pinned by a test
so the behaviour is deliberate and visible. If the tilt is meant to protect the
canary, this is the first thing to change.


**Fixed.** The `confidence_scaling` branch now applies `volTilt.volScale`.

It shrinks the discretionary part *above* `minUsd` rather than the whole figure:
scaling `size` outright and then flooring at `minUsd` would make the tilt a
no-op for small accounts and put a step at the floor. This stays continuous and
can never size below the exchange minimum — a guardrail that produces an
unfillable order is not a guardrail. Pinned by a test at `realizedVol` up to 50.

The identity property still holds on this path: with no vol reading, cold-start
sizing is unchanged.

---


### 41. The live WS order book carries no depth aggregate

`getDepthForMarket` (`clob.ts:165`) has two paths. The REST path returns
`normalizeLevels(...)`, which computes `imbalance` and `spreadPct` from ten
levels. The WS path (`clob.ts:171-179`) returns only
`{ bestBid, bestAsk, mid, spread, source }` — and it is preferred whenever the
socket book is fresh, which is the common case.

So the alpha fusion's ORDER_FLOW vote reads `imbalance ?? 0` and votes zero
exactly when the data is most current. `spreadPct` is derivable from what the WS
book does carry and is now computed in the `booksForFusion` block
(`bot.ts:2131`); `imbalance` is not derivable there and is left `null` rather
than defaulted to a neutral `0`, with `source` recorded so a half-strength vote
is visible instead of silent.

The real fix is to aggregate depth in the WS book itself, which means keeping
the level arrays the socket already delivers rather than collapsing them to top
of book. Not done here — it touches the live price path that stop-losses mark
against, which is out of scope for the fusion port.

### 42. Alpha fusion replaces the numbers every directional gate reads

Not a defect — the blast radius, recorded so it is not rediscovered.

`applyAlphaFusion` does not annotate the analysis; it overwrites `direction`,
`confidence`, `score` and `edge` (`alphaFusion.ts:163-177`). Every downstream
entry gate, Kelly size and governor input therefore changes the moment fusion is
wired in, and `getSignalForBoth` calls it unconditionally in the fork.

Mitigated with a kill switch rather than a flag day: `cfg.useAlphaFusion === false`
turns it off from config with no redeploy. It defaults **on**, because that is
what steps 3–4 were asked to deliver. The switch rides on the fusion context
because that is the only channel `signal.ts` already reads — adding a config
import there would have created a cycle.

Watch paper trading for a shift in entry rate and average confidence before this
reaches live. That comparison is the point of keeping paper running.

### 43. An aborted package never records which leg actually filled ✅ FIXED

Proven from the live canary archive (`poly_live_archive.json`, package
`pkg-btc-mtbtgyzj`, 2026-08-27 17:48:46 UTC). The same record says both:

```
abortReason : "Leg execution mismatch: UP=OK, DOWN=FAIL"
legs.up.filled : false
```

`abortReason` is built from `upShares > 0` (`arbEngine.ts:300`), so the engine
knew the UP leg had filled — 25.99 shares, $2.86, confirmed on-chain. But
`pkg.legs.up.filled = true` is only assigned in the LOCKED branch
(`arbEngine.ts:240-243`). The abort path at `:296-306` sets `status`,
`unwoundAt` and `abortReason`, and never touches the flag.

So the package's own machine-readable state says nothing filled, while its
human-readable string says otherwise. Anything reconciling orphans by reading
`legs.*.filled` sees nothing to unwind.

There is no second line of defence: `reconcilePendingPackages` filters
`status === 'PENDING_FILL'` (`:497`), and this package went straight to
`ABORTED`, so nothing sweeps it. `resetLiveData`'s phantom detector also missed
it — the archive records `phantomTradeCount: 0`.

The immediate unwind did fire (`:302`), but at that commit `unwindLeg` only
mutated local state: `pos.closed = true`, `pos.exitPrice = pos.entryPrice`,
`pos.pnl = -(fees)`, with the cash refund gated behind `mode === 'paper'`. In
live mode it wrote a fake closed record worth about -$0.01 while 25.99 real
tokens stayed in the Safe and expired worthless. Two independent records —
the position and the package — both said there was nothing to recover.

**Fixed** in two parts.

1. `legs.*.filled` and `legs.*.shares` are now written from the observed share
   counts *before* any branch reads them, so they cannot disagree with
   `abortReason` (which is derived from the same counts). The duplicate
   assignments on the LOCKED path were removed — one writer, one place.

2. `reconcilePendingPackages` now also sweeps ABORTED packages that still hold
   exactly one open leg, and unwinds it. It is driven from the **open positions**
   rather than the package list: an orphan is by definition a position still on
   the book, and there are a handful of those, whereas ABORTED packages
   accumulate forever — iterating them every housekeeping tick would grow
   without bound for no new signal.

   `closed` is the idempotence latch, so a leg is swept at most once and a live
   sell is never issued twice for the same shares. A package with *both* legs
   open is deliberately left alone and logged: that is a mislabelled hedge, not
   an orphan, and selling both would realise a loss on a position that still
   redeems to $1.00 a pair.

Note for the record: an earlier draft of this item pointed at "the ABORTED sweep
at `:588`". There is no sweep there — `:588` is `getArbPackageMetrics`, a
dashboard KPI function. No sweep for ABORTED existed at all, which is the
reason the orphan survived.

Related:
[[34]] (the unwind catch falls through to `pos.closed = true`) and [[35]]
(the unwind sell was unpriced until 2026-09-01) — all three are the same
orphan-leg blind spot seen from different sides.

### 44. A live rollback books the entry price, not the fill price ✅ FIXED

`unwindLeg` sets `pos.exitPrice = price` where `price = pos.entryPrice`, and
`pos.pnl = -(entryFee + exitFee)` — on the success path too. So a live unwind
that actually sold at $0.20 against a $0.50 entry is recorded as a break-even
close costing only fees.

The comment above it ("Sold back at the price it was bought at, so the only loss
is the two fees") is true of paper, where `closeProceedsWithFee` models the
refund. It is not true of live, where the CLOB fills at whatever the book pays.

`placeMarketSell` already returns the accepted price, and the response body is
now captured (`clobReceipts.ts`), so the fill price is available — it is simply
not read. Until it is, every live rollback understates its loss, and the
`realizedFor()` sum in `getArbPackageMetrics` inherits the error.

**Fixed.** `readSellFill` (`trade.ts`) derives the realised price from the
receipt as `takingAmount / makingAmount`. That is a **ratio**, so it is
scale-invariant — correct whether the wire units are raw or 1e6-scaled, and
therefore not blocked on backlog 33. Absolute share and proceeds figures do need
the scale, so they are resolved against the requested size and returned as
`null` when neither reading matches, rather than guessed.

`placeMarketSell` now returns `fillPrice`, `filledShares`, `proceedsUsd` and
`fillSource` alongside `floorPrice`. Note the trap: its existing `price` field
is the **slippage floor it signed**, not the fill — booking that would overstate
the loss as badly as the entry price understated it. `unwindLeg` books
`sellRes.fillPrice`, falls back to the entry price only when no receipt is
usable, and marks that case `exitPriceUnverified` instead of presenting a
fabricated break-even as a measurement. PnL is now
`(exitPx - entryPx) * shares - fees`.

Related: [[34]], [[43]], [[33]].

### 45. `assertOrderAccepted` treats an orderID as a fill ✅ FIXED (directional)

`assertOrderAccepted` (`trade.ts:139`) passes on orderID presence alone, and the
CLOB returns an orderID for a **resting** GTC order exactly as it does for a
matched one. That read is what recorded the 2026-08-28 UP leg as filled while it
sat unmatched on the book, and it still reached directional entries, which keep
GTC deliberately (a resting bid is a missed trade, not a naked position — but a
phantom position is neither).

**Fixed** with `readGtcFill`, which decides quantitatively rather than by status
string: the exact status vocabulary is still an open question in the research
doc, whereas "no collateral moved" is unambiguous in any vocabulary.
`makingAmount`/`takingAmount` both zero, or an empty `tradeIDs`, means resting.
A matched order whose size cannot be resolved against the request is reported
`filledShares: null` — never the requested size.

The live entry path now refuses to open a position on a resting order, cancels
it (an untracked resting bid can still fill later, unattended), and fails the
pending trade. Filled positions record `orderResult.filledShares`, not the size
that was asked for.

`assertOrderAccepted` itself is unchanged and still passes on orderID presence.
That is deliberate: it is the shared gate for every order path, and tightening
it is a separate change. The fill question is now answered by the caller, which
is the layer that knows what a fill should look like for its order type.

Found while fixing this: `cancelOrder` was used in `bot.ts` without being
imported, and `npx tsc --noEmit` reported nothing, because `bot.ts` carries
`// @ts-nocheck` ([[32]]). A runtime crash in the live entry path, invisible to
the type checker. There is now a test asserting the import exists.

### 46. A reset rebases over a loss and erases live P&L ✅ FIXED

`resetLiveData` calls `saveBaseline(cash)`, and `netPnl = equity - baselineUsd`.
So after the 2026-08-28 20:04 reset the header read **$0.00 net** while the
account had really lost **$10.13** — baseline and cash were both $275.16. The
audit's own note called it "rebase baseline after deposits"; there had been no
deposit.

**Fixed** by surfacing the number that already existed but was never shown.
`liveAccount.cash.lifetimeBaseline` is written once, on first observed cash
(`liveAccount.ts:170`), and `resetLiveData` never touches it — it still holds
$285.29. `buildPortfolio` now reports `lifetimeBaseline` and
`lifetimePnl = equity - lifetimeBaseline` beside the session `netPnl`, so a
reset can hide a session but not the account's history.

The audit note now reads the *direction* of the divergence: below lifetime means
a drawdown was rebased over and lifetime PnL is the honest figure; above means a
deposit needs rebasing. Filing a loss as a bookkeeping chore is how it stayed
invisible for four days.

Not addressed: `lifetimeBaseline` is first-observed cash, not a deposit ledger.
A second deposit still requires a manual rebase, and there is no running
record of deposits and withdrawals. That is the real fix, and it is larger.

Also not addressed — the number is computed but never displayed. The
`cashAudit` object in `bot.ts:1534` is an explicit field picker and does not
copy `lifetimeBaseline` / `lifetimePnl`, so neither reaches `/api/poly/state`
(`server.ts:692`) or the UI; nothing reads `portfolio.lifetimePnl`. What *does*
surface is the audit note, via `cashAudit.notes` → the "Live cash audit" card
on the **History** tab (`PolyDashboard.tsx:2290`, first 4 notes).

A KPI tile was considered and rejected: a value labelled "Lifetime PnL" reads as
ground truth and goes silently wrong on the next deposit, since the field is
write-once. The note is phrased as a caveat and degrades honestly. Promote it
once a deposit ledger exists.

Related display bug, deferred by the operator (2026-09-01): the Account nav
badge counts `notes.length + issues.length` (`PolyDashboard.tsx:1194`) but
`AccountPage.tsx:220` renders `issues` only. A note therefore increments a badge
on a tab that will not show it. ~8 lines to mirror the `issues` block; no logic
change.

---

## Handoff — state as of 2026-08-20

Written so a fresh session can continue without re-deriving any of the above.

### Where things stand

**Slices 0 and 1 are complete, plus the behavioural half of slice 3** — items
7, 9, 10, 25 and 27 are fixed. Branch `refactor/slice-0-safety-net`, 18 commits
off `main` (clean fast-forward — `main` has not moved). `npm run ci` is green:
96 unit + 4 perf, 1 todo.

*The branch name is now wrong* — it carries slices 0 and 1 plus five arb fixes.
Worth landing on `main` rather than growing further.

| Slice-1 step | State |
|---|---|
| extract the engine (`2339b3a`) | ✅ verified equivalent over 1.74M input combinations |
| item 6 — engine tag + gate filter (`8104e49`) | ✅ 4 invariants, mutation-tested |
| per-engine slot budget (D5) | ✅ `b2dc6fc` — closes item 25, uncovered item 27 |
| decision events (D8) | ⬜ deferred to the D8 emitter, on purpose |

| Slice-0 item | State |
|---|---|
| 16 — one `getDataDir()` owner | ✅ `polymarket/dataDir.ts`, 7 modules rerouted |
| 12 — test isolation | ✅ per-worker dirs + tripwire |
| 15 — explicit backend | ✅ `ZINGER_SQLITE`, surfaced at boot and `/api/ops/status` |
| log caps | ✅ 300/500 → 5000, env-overridable |
| audit (local + VPS) | ✅ `scripts/audit-store.ts`, results recorded above |
| 14 — unshadow the store | ✅ `scripts/reconcile-store.ts`, applied locally |
| invariant suite | ✅ `tests/unit/invariants{,.pending}.test.ts` |
| 23 — paper cash net of fees | ✅ fixed and verified against production data |

### What is NOT done

- **Not deployed.** The VPS runs `3a9a69e` at `/opt/apps/ZINGER` (ssh host
  `contabo`), up since 2026-08-18. Slice 0 is inert there apart from item 23,
  and the reconciler is **boot-only** — nothing fires it on a timer — so there
  is no clock running. The requirement is "the fix is in before the next
  restart", not "deploy soon". Deploying is best bundled with slice 1.
- **`reconcile-store.ts` has not been run on the VPS.** Production's
  `session_perf` is already intact (200 = 200), so this is cleanup of 13 stale
  JSON files, not recovery.
- **Items 24 and 25** are filed, not fixed. Both are slice 3.
- **Item 28** is filed, not fixed, and corrects item 19: live trades
  **auto-approve** (`autoApproveLive: true` in every live profile), so item 19's
  stated "manual approval prompt" guard does not exist. Inflated caps plus no
  approval step is the real first-switch posture.
- **Item 26** is filed, not fixed — the entry-gate thresholds ignore operator,
  governor and optimizer alike. Slice 2, with the D3 config resolver, because
  reversing the precedence changes a live gate.

### Known live-data facts (do not re-derive)

- VPS: 31 packages · 13 trades · 13 positions. Paper bankroll $100.70, which is
  **correct** — it is the pre-reconcile fee-aware value.
- `pkg-btc-msyglw8m` is stuck `PENDING_FILL` with a naked UP leg, 40h+ as of the
  audit. It is the live instance of items 8 and 9.
- 24 of 31 packages are orphaned from their trades (item 24); 15 settled orphans
  report $4.65 of fee-blind profit via the `lockedProfitUsd` fallback.
- The VPS sets no `ZINGER_DATA_DIR`, `ZINGER_DB_PATH` or `ZINGER_SQLITE`.

### Conventions established in slice 0 — keep them

1. **Fixtures for permanent tests, the real store for one-shot audits. Never
   conflate.** A suite whose result depends on what is in `data/` cannot
   separate a code defect from a data artifact, and against an empty store it
   passes trivially.
2. **Invariants that do not hold yet go in `invariants.pending.test.ts` under
   `it.fails()`.** CI stays green; the file goes red when the defect is fixed,
   which is the signal to promote the test. Verify each fails on its own
   assertion, not on an error.
3. **Derive money from primitives, not from stored derived fields.**
   `tradeNetPnl` recomputes from entry/exit/shares/fees precisely because
   pre-fix records carry a gross `pnl` with nothing to distinguish them.
4. **Audit scripts are read-only and say so.** Verify it: sqlite's `-shm`
   sidecar mtime moves on any connection, so compare row content, not file
   mtimes.

### Conventions added in slice 1 — keep them

5. **A "behaviour-neutral" move is proved, not asserted.** Drive the old and new
   code over a large input grid and diff, then mutation-check the harness so a
   zero-mismatch result means something. `tmp/diffcheck/` shows the shape.
6. **Mutation-test every safety invariant, and believe the survivors.** Two of
   the slice-1 invariants passed under mutation, and both times the test was
   wrong about *where* the property was enforced — one found item 26. A
   surviving mutant is a finding, not a nuisance to silence.
7. **Extracted engines take state as an argument.** No module in `engines/` may
   import `bot.ts`; a test asserts it. State it needs arrives through a view
   built by whoever owns that state.

### Suggested next step — an open question, not a task

**Slice 1 is done, and item 27 was promoted out of slice 3 and fixed** — it was
writing false history on every refusal, not lying dormant, so leaving it to sit
while the paper run generated evidence would have poisoned the evidence.

The remaining live arb defects, in the order they cost the most:

| Item | What it does now | Why it matters |
|---|---|---|
| **8** | a naked leg settles at a fabricated $0.50 | item 27 removed the main *source* of naked legs; this is the valuation that made them profitable on paper |
| **24** | `resetPaperData` orphans packages from trades | any `arbMetrics` figure spanning a reset is unreliable |
| **11** | orphan settle assumes every window is 5m | a 15m directional position sells ~10 min early |

**Every behavioural arb defect is now closed.** Items 7, 9, 10, 25 and 27 are
fixed; what remains misreports or is structural:

| Item | Nature |
|---|---|
| 8 | valuation — a naked leg settles at $0.50. Item 27 removed the mechanism that *manufactured* naked legs and 9 unwinds the stranded ones, so this is cleanup now. Still needs `positions/settle.ts` to be testable, which is why its invariant is an `it.todo`. |
| 11 | orphan settle assumes every window is 5m, so a 15m *directional* position sells ~10 min early. Arb legs are unaffected. |
| 24 | `resetPaperData` orphans packages from trades. Item 7 blunted the damage — the `lockedProfitUsd` fallback is net now — but the mechanism stands. |
| 26 | entry-gate thresholds ignore every writer. Needs the D3 resolver. |
| 19, 28 | live caps and auto-approve. Real, but inert until the mode switch, and D11 does not exist yet. |

**So slice 2 is next** — the shared layer. That is where 26 lands, along with the
two remaining cash writers from item 23, `portfolioView()`, and items 3/4/5.
Items 8 and 11 belong to slice 3 with the D4 settlement work, which is what makes
them expressible as fixture tests at all.

Then slice 2. Three things are queued for it specifically:

- **Item 23 left the duplication in place.** `paperBooksCash()` is the single
  formula, but two functions still decide when to write cash. D5 says one pool,
  one owner — collapse into `ledger/cash.ts`. Nothing should add a third writer
  before then.
- **`portfolioView()` in `bot.ts` is a placeholder** for the D4 position
  manager, which should own `hasOpenOnSlug` / side balance / data assurance.
- **Item 26** wants the D3 resolver: reverse the `??` chain in
  `resolveEntryWindows` so an explicitly set value beats the trained heuristic,
  and report which tier supplied each threshold.
