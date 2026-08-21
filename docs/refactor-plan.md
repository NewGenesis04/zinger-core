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

### 1. Market duration coverage

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

### 2. `bot.ts` decomposition

~3,900 lines carrying scan orchestration, trade execution, sizing, persistence,
telemetry and logging at once. Direct consequence: an unrelated failure early in
`scan()` silently kills strategy paths later in the same pass. Candidate seams:
market discovery → candidate scoring → execution → reconciliation/telemetry.

**Guiding constraint (owner's, 2026-08-18):** each file should map to exactly
one thing it does — the split is by behaviour, not by line count. A module whose
name does not predict its contents is not done. Test of success: for any
"why didn't the bot do X?" question, there is one obvious file to open.

Note this directly caused the 2026-08-12 outage's blast radius: arb needs only
the Polymarket order book, but lived downstream of a Binance signal fetch inside
the same function, so an unrelated network timeout took it out. Separating by
behaviour would have made that coupling impossible to write by accident.

### 3. Rule interaction is convoluted — trim to the minimum useful set

**Owner's framing (2026-08-18):** the individual rules are fine; how they
*compose* is the problem. Goal is to trim, not to add — fewest rules that still
express the intent, each answering a question no other rule answers.

Two concrete symptoms.

**a. Five writers to one config, no precedence model.** `saveConfig` is called
from `bot.ts` (8×), `server.ts` (3×, the UI/API), `ai/optimizer.ts`,
`ai/governor.ts` and `telegram/bot.ts`. The governor rewrites knobs every
~120s and the optimizer every ~180s, both silently overwriting whatever the
operator set in the dashboard. Nothing records who last wrote a field or
whether a human's choice should outrank an automated one. `LIVE_PROTECTED`
(`governor.ts:77`) is the only precedence rule that exists, and it applies only
in live mode.

**b. At least five mechanisms answer "should we trade directionally?"**
  1. `cfg.forceArbOnly` — operator switch
  2. `cfg.arbOnlyUntilEdge` + `edgeOk` — the edge gate (`edge.ts:85`)
  3. `evaluateEdgeGate(...).arbOnly` — same computation, read separately
  4. governor regime `arb-only` — writes `arbOnlyUntilEdge: true`
  5. governor drawdown breaker — applies the `arb-only` profile as a guardrail

  and `isArbOnlyMode` (`bot.ts:2528`) recomputes 1+2 inline rather than using
  the gate's own answer. One question, five ways to reach it, no single place
  that reports *which* one is currently in force. This is why "why is it
  arb-only right now?" took log archaeology to answer.

Direction: one resolver that takes config + edge stats + governor state and
returns a single decision plus the reason for it, with an explicit precedence
order (operator > guardrail > automation). Everything else reads that answer
instead of re-deriving it.

### 4. The governor hardcodes what it governs, and ignores the mode it is in

A concrete instance of item 3, bad enough to stand alone. Three defects.

**a. 54 hardcoded knobs, none operator-reachable.** `REGIME_PROFILES`
(`governor.ts:23-72`) holds 23 literals for `trend-ride`, 23 for `scalp`, 8 for
`arb-only`. Changing any of them requires editing TypeScript and redeploying.
The dashboard cannot reach them, yet they overwrite the dashboard every ~120s.
For a non-TypeScript operator this inverts the whole control surface: the only
values you cannot edit are the ones that overrule the values you can. They also
duplicate defaults already defined in `modeConfig.ts` — two sources of truth for
the same knobs.

**b. It silently reverts the operator's arb threshold.** `minArbGap: 0.012`
sits inside the `arb-only` profile (`governor.ts:68`) and is written via
`saveConfig` whenever the regime switches — triggered at `maxAtr >= 0.5%`
(`governor.ts:181`), ordinary crypto volatility, or by the drawdown breaker
(`governor.ts:315`). Observed 2026-08-18: the operator raised `minArbGap` to
0.035 to clear the ~3% fee floor (item 7); the governor would have reverted it
to a loss-making 0.012 with no log line and no way to notice. `LIVE_PROTECTED`
(`governor.ts:77`) does not include it, and applies only in live mode anyway.

**c. `forceArbOnly` does not stop it.** `ensureGovernorTimer`
(`bot.ts:3656-3663`) checks only `botState.running` and `governorEnabled`, and
`runGovernor` has no `forceArbOnly` awareness at all. So in pure-arb mode the
governor keeps writing directional knobs that `forceArbOnly` already bypasses —
no effect where it is aimed — while still overwriting `minArbGap` and
`clobArbEnabled`, the only two fields that reach arb. Exactly inverted.

**Origin:** `governor.ts` predates `arbEngine.ts` by ten days (2026-07-31 vs
2026-08-10). It was built to switch between *directional* profiles; `arb-only`
was retrofitted as a third profile inside a mechanism designed to bulk-overwrite
directional knobs, and the scope question was never revisited.

**Direction:** profiles become data (operator-visible and editable), not source
literals. The governor emits a *decision* — "regime = scalp, because ADX 21" —
and the item 3 resolver applies it under explicit precedence, instead of the
governor writing config directly. Under `forceArbOnly` it should be a no-op or
restricted to guardrails.

### 5. Config validity has no owner

Rules are spread across `modeConfig.ts` (shape/defaults), `edge.ts` (gating),
`ai/governor.ts` (regime overlays) and the dashboard, with no single validation
point. This is how `forceArbOnly: true` + `clobArbEnabled: false` — a combination
that mutes directional trading *and* the arb engine, leaving the bot trading
nothing while the UI shows "Force Pure Arb Active" — could be set at all.
Guarded for now in `saveConfig` (`bot.ts:187-198`) plus a UI-side patch, but the
invariant belongs somewhere declarative alongside the field definitions.

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

### 8. A surviving single leg settles at a fabricated $0.50

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

### 11. Orphan settle assumes every window is 5 minutes

`bot.ts:2312` computes window end as `slugTs + POLY_WINDOW_SECONDS` with the
constant hardcoded to 300, ignoring the position's actual duration. A 15m
position is therefore settled ~10 minutes early. For arb legs this is
P/L-neutral (they settle at a flat $0.50 via `bot.ts:3986` regardless of
timing), but a directional 15m position gets sold at mid before its window
resolves. Should use the position's `windowSeconds` / `durationFromSlug`.

### 12. Tests write to the live data store

`tests/unit/arbEngine.test.ts` fixtures persisted into the real `data/` store —
a package with `slug: "eth-plan-test"` and tokenIds `"u"`/`"d"` ended up in
production package history and skewed `arbMetrics`. Tests need an isolated
`ZINGER_DATA_DIR`.

### 13. Observability gaps

- Skip/decline reasons log under types `'scan'` and `'signal'`, but the
  notifications panel only offers `all/buy/arb/sl/tp/announce/error`
  (`NotificationsPanel.tsx:80`) — the lines that explain "why no trades" are
  effectively invisible unless viewing "all".
- Window summary lines render UTC (`toISOString`, `bot.ts:494`) next to
  local-time log timestamps, which reads as a 1-hour skew during BST.
- `poly_actions.json` caps at 300 entries, so `'scan'`-type history is evicted
  quickly and multi-day investigations have nothing to work from.

### 14. Migrated-away JSON files still sit in `data/`, and one of them shadows the store

Diagram: `docs/persistence-explained.png` (source `.excalidraw` alongside).

The sqlite port (`87f53e7`, completed in `f84d02e` 2026-08-17) is genuinely
finished — no module in `src/` writes state with `fs` any more; the only
`writeFileSync` calls left are `logo.ts` (SVGs) and `sqliteStore.ts`'s own
Node 20/21 fallback branch. But the original JSON files were never deleted, and
nothing distinguishes a live store from a frozen one. Local `data/` currently
holds 30 `.json` files, **not one of which has been modified since the port
commit landed**, sitting next to `zinger.db` where the real state lives. 24 of
the db's 30 rows carry
`updated_at = 2026-08-14T12:45:22` — all within 200ms, i.e. the one-shot
`migrateDir()` sweep. Only six rows have moved since.

**The live divergence.** `session_perf.json` is the one file whose disk copy is
*newer* than its row:

```
data/session_perf.json      193 sessions   (mtime 2026-08-16 17:55)
docs['session_perf.json']   152 sessions   (row   2026-08-14 12:45)
```

`migrateDir()` imported the file on Aug 14; `ai/optimizer.ts` was not routed
through the store until `f84d02e` on Aug 17, so it kept writing to disk for two
more days. It now reads the row, so **41 sessions of performance history are
invisible to the optimizer** — the component that tunes `kellyFraction`,
`slPct`, `minConfidence` and the rest of `BOUNDS`.

This cannot self-heal: `migrateDir()` skips any key that already has a row
(`sqliteStore.ts:172-180`), so a newer file on disk can never overwrite an
older row. The `overwrite` option exists but no caller passes it.

Two further consequences of leaving the files in place:

- Anything reading the repo — a person, or an agent — that opens
  `data/poly_trades.json` gets Aug-11 data that looks current.
- Delete or lose `zinger.db` and every frozen file is re-imported as truth on
  the next boot.

Fix: reconcile `session_perf` as a one-off data decision (not a refactor), then
have the migration delete or rename what it imported — e.g. move consumed files
to `data/migrated/` — so the data dir has exactly one representation of state.

### 15. The persistence backend is chosen silently, and the docstring is wrong

`sqliteStore.ts:9` says "Enable with `ZINGER_SQLITE=1` (or set `ZINGER_DB_PATH`
to the .db file path)". There is no `ZINGER_SQLITE` check anywhere in the
module. `SQLITE_AVAILABLE` is set purely by whether `require('node:sqlite')`
succeeds (`sqliteStore.ts:22-28`), so the backend is a function of the Node
version and nothing else.

Practical effects: there is no way to opt out on Node 22+, and no way to opt in
on Node 20/21. A Node downgrade silently switches the entire persistence layer
from `zinger.db` to whatever stale JSON is on disk (item 14) with no log line
and no readiness check. `sqliteEnabled()` exists in `persistence.ts:53` but
nothing surfaces it to the operator — including the `/ops` status page.

Fix: honour the documented env var, or delete the claim from the docstring, and
report the active backend + `docCount()` somewhere an operator can see.

### 16. `DATA_DIR` is re-derived per module, and two copies ignore the override

`persistence.ts:12-15` and `sqliteStore.ts:30-33` both respect
`ZINGER_DATA_DIR`. `ai/optimizer.ts:6` and `lib/chain.ts:14` hardcode
`../../data` instead, so with `ZINGER_DATA_DIR` set they build paths pointing at
the repo tree rather than the configured data dir.

**Scope correction, 2026-08-20 — resolved.** The two files named above were an
undercount. A grep at execution time found **nine** modules deriving the data
directory independently, of which **seven ignored the override**:
`ai/optimizer.ts`, `ai/governor.ts`, `polymarket/audit.ts`, `telegram/bot.ts`,
`heuristics/tradeCollector.ts`, `heuristics/trainFundHeuristics.ts` and
`lib/chain.ts`. (`lib/wallet.ts` honoured it but was a third derivation.)

`getDataDir()` existed at `persistence.ts:44` but had **zero callers**. Note
also that `persistence.ts` could not have been the single owner as this item
assumed: it imports `sqliteStore.ts`, which needs `DATA_DIR` itself for
`DB_PATH` and `keyFromPath`, so the lower layer would still have computed its
own. Resolved by giving the fact its own owner — `polymarket/dataDir.ts`, which
imports nothing from the codebase and so can be read from any layer without a
cycle. `persistence.ts` re-exports `getDataDir`/`dataPath` for existing callers.

This is currently harmless only by accident: `keyFromPath()` falls back to
`path.basename()` for any path outside the data dir (`sqliteStore.ts:77-83`), so
the wrong absolute path still resolves to the right row key. The moment two
stores share a basename across subdirectories, or the fallback branch is taken
on Node 20/21 (where the path is used literally), it stops being harmless.

Fix: one exported `getDataDir()` — it already exists in `persistence.ts:44` —
and no module computing its own.

### 17. ML artifacts still bypass the store

`f84d02e` migrated the TS↔Python *heuristics* handoff, but four Python writers
still `json.dump` straight to disk: `ml/train_rl.py:171`,
`ml/train_rl_fuser.py:188`, `ml/benchmark.py:303`, `ml/rl_fuser_env.py:287`.
Model weights and benchmark output are arguably fine as files, but it means
"all state lives in `zinger.db`" is not quite true, and the boundary is
undocumented — `ml/sqlite_store.py` exists and is used elsewhere in the same
tree, so which side of the line a new artifact belongs on is left to guesswork.

Fix: decide the rule explicitly (artifacts on disk, state in the store), write
it in `ml/sqlite_store.py`'s docstring, and move anything that is state.

### 18. Live wallet configuration has readers but no writer

`getWallet()` (`lib/wallet.ts:46`) auto-creates a fresh random signer via
`generatePrivateKey()` whenever no wallet record exists, so any call path can
silently mint a new wallet. Beyond that, the live path has no configuration
surface at all.

**a. `polymarketDepositWallet` is read in six places and written in none.**
`trade.ts:50`, `readiness.ts:53`, `liveAccount.ts:52`, `deposits.ts:84` and
`publicPredictions.ts:1313,1316` all read it; nothing in the repo sets it. It
decides real behaviour — with it, `trade.ts:53-60` switches the CLOB client to
`SignatureTypeV2.POLY_1271` with the proxy as `funderAddress`; without it,
`getFunderAddress()` silently falls back to the signer EOA. So the difference
between "trading the proxy account" and "trading the bot's own EOA" hangs on a
field that has to be inserted by hand.

**b. Hand-editing `data/wallet.json` no longer works.** Since the port, that
file is not read on Node 22+ — `loadFileOrStore` goes to the `docs` row keyed
`wallet.json`. An operator following the obvious path edits the file, sees no
effect, and gets no error. This is item 14's ambiguity landing on the one store
where being wrong costs money.

**c. There is no key import path.** `readiness.ts:220` instructs the operator to
"export that wallet's private key into Zinger" when the deposit-wallet owner
check fails, but `loadOrCreateWallet` only generates — there is no import
endpoint, script, or env override to act on that instruction.

**d. No file mode is set.** `saveFileOrStore` writes with default permissions
(`0644` locally) and never `chmod`s. The key is never logged or exposed over the
API (`/api/wallet`, `server.ts:246`, returns address and chain only) and
`data/**` is gitignored, so exposure is filesystem-local — but the mode is
looser than a hot key warrants.

Fix: one owner for wallet configuration — an explicit "configure live signer"
path that imports a key, sets the deposit wallet, verifies the `owner()` check
that `readiness.ts:29-37` already performs, and writes through the store rather
than assuming a file. Auto-generation should be opt-in, not the fallback.

### 19. The flat→profiles migration wipes every live safety cap

`normalizeConfigStore` (`modeConfig.ts:213-222`) seeds the live profile as:

```js
const live = {
  ...defaultLiveStrategy(),
  ...pickStrategy(defaultsFlat),
  ...(hasProfiles ? pickStrategy(raw.profiles.live || {}) : pickStrategy(base)),
```

When migrating a legacy flat config (no `profiles` key), `pickStrategy(base)`
copies the flat — paper-shaped — strategy values over every conservative live
default. Verified against the live store on 2026-08-19: **10 of 10 sampled
fields match `defaultPaperStrategy()`, none match `defaultLiveStrategy()`.**

| field | actual | live default | inflation |
|---|---|---|---|
| `maxPositionCap` | 100 | 1 | **100×** |
| `certaintyMaxUsd` | 100 | 2 | **50×** |
| `arbMaxUsd` | 50 | 1 | **50×** |
| `maxOpenPositions` | 4 | 1 | 4× |
| `kellyFraction` | 0.12 | 0.05 | 2.4× |
| `minConfidence` | 0.38 | 0.50 | looser |

The author anticipated this exact hazard — `arbOnlyUntilEdge` and
`requireEdgeForLive` are explicitly pinned two lines below — but only the gate
flags were protected, not the size caps. The sole remaining guard is
`autoApproveLive: false` + `announceBeforeTrade: true`, i.e. a manual approval
prompt, not a limit.

Fix: live caps are a floor, not a seed. Never let a migration or a patch widen a
live risk limit beyond `defaultLiveStrategy()` without an explicit, logged,
operator action — and assert it continuously as D11 dimension 4, not once at
migration time.

### 20. Scan history is single-slot, so no retention change can reach it

Found while executing slice 0's log-cap item (2026-08-20).

`logScan` (`bot.ts:1001`) is the per-cycle "why didn't the bot trade" summary.
It writes to `botState.executionLog` and `botState.lastScanLog` **only** —
never to `botState.actions` — and its first act is:

```js
botState.executionLog = botState.executionLog.filter(
  (e) => e.type !== 'scan' && e.level !== 'scan' && e.id !== 'latest-scan');
```

so every prior scan entry is deleted on every cycle. Exactly one survives, under
the fixed id `'latest-scan'`. Two consequences:

- **Item 13's framing is incomplete.** Scan history is not "evicted quickly by
  the 300-entry cap" — it is overwritten by design, and never persisted at all,
  since `poly_actions.json` is written from `botState.actions` which `logScan`
  does not touch. Raising retention cannot recover it. The skip/decline reasons
  that *are* retained come from `log(..., 'signal')` (6+ sites) and
  `log(..., 'scan')` (`bot.ts:2318,2392`), which do route through `actions`.
- **It also capped the whole log.** `logScan` truncated `executionLog` to a
  literal 500 every cycle, so raising the cap in `log()` alone would have been
  silently undone within one scan. Both now read `EXECUTION_LOG_CAP`.

Under D8 this becomes a non-issue — a scan emits a typed event per cycle and the
"latest" view is a query, not a storage decision. Recorded so D8 does not
reproduce the single-slot behaviour by copying the current shape.

### 21. `saveState()` re-serialises every log on every call

The retention cap raised in slice 0 is bounded by serialisation cost, not
memory: `saveState()` (`bot.ts:250`) writes `botState.actions.slice(0, CAP)`
through `persist()` in full, and is called from 9 sites including the per-cycle
scan path. Measured on live entries (~351 B each): ~111 ms to serialise 10,000.

That is why the cap landed at 5,000 rather than something larger. The ceiling is
the full-array rewrite, not the data volume — an append-only event table (D8)
removes it entirely, at which point retention becomes a query/pruning policy
instead of a per-write cost. Do not raise the cap much further before D8 lands.

### 22. Store paths are positional, and a bare filename escapes the data dir

Found while verifying item 15 (2026-08-20).

`persist()` / `load()` accept whatever path they are handed. Under sqlite,
`keyFromPath()` reduces anything outside the data dir to `path.basename()`
(`sqliteStore.ts:77-83`), so a bare `'foo.json'` silently resolves to the right
row. Under the JSON fallback the same call writes to `path.resolve('foo.json')`
— i.e. `process.cwd()`, outside the data dir entirely. Verified: with
`ZINGER_SQLITE=0`, `persistSync('escaped.json', …)` wrote to the process's
working directory while the configured data dir stayed empty.

No current caller passes a bare name — every one goes through `FILES.*` or
`dataPath()` — so this is latent, not an active bug. It is the same shape as
item 16 though: correct only because of a fallback that happens to agree, and it
diverges precisely on the Node 20/21 path where item 15's silent-backend-swap
already bites.

Fix: make the store key an explicit argument rather than a filesystem path —
`persist('poly_trades', data)` — so there is no path to get wrong. Fits the D8
event/store work; not worth a standalone pass before it.

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

### 24. `resetPaperData` clears trades but not arb packages

Found by the VPS audit, 2026-08-20.

`resetPaperData` clears `botState.trades`, `positions`, `actions`,
`pendingTrades`, `announcements`, `session`, `sessionHistory` and `windows`. It
never mentions packages, and neither does `resetLiveData`. `loadPackages()`
reads its own store (`arbPersistence.ts:53`), which no reset path touches.

So every paper reset detaches the surviving `ArbPackage` records from the fills
that produced them. Measured on the VPS: **24 of 31 packages have no leg trades
at all**, split cleanly by date — orphans created 2026-08-10 to 08-12, while
every surviving trade is from 08-18.

The consequence is a reporting one, and it compounds item 7.
`getArbPackageMetrics` falls back to `pkg.lockedProfitUsd` whenever a package
has fewer than two leg trades (`arbEngine.ts:272-278`), and `lockedProfitUsd` is
recorded gross of fees at execution time. So orphaned packages report their
*nominal entry edge* forever, with no fee deduction and no way to correct it:
**15 SETTLED orphans contribute $4.65** of fee-blind profit against $2.66 of
genuinely recorded P/L. The dashboard's arb P/L is therefore majority phantom,
and it cannot self-heal because the trades are gone.

This is the mechanism behind D9's "packages orphaned from their trades", which
was recorded as a symptom without a cause. It also means the pre-refactor arb
track record cannot be reconstructed — which strengthens the D9 archive
decision rather than weakening it.

Fix: packages are position state and belong to whatever owns the position
lifecycle (D4). A reset must clear them with everything else, or explicitly
archive them. Until then, treat any `arbMetrics` figure spanning a reset as
unreliable. Slice 3, with the D4 manager.

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

### 26. The entry-gate thresholds ignore every writer except the trained policy

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

### 28. Item 19's "remaining guard" does not exist — live trades auto-approve

Found 2026-08-20 while confirming which safeguards bind in paper and which are
notional.

Item 19 concludes: *"The sole remaining guard is `autoApproveLive: false` +
`announceBeforeTrade: true`, i.e. a manual approval prompt, not a limit."*

There is no prompt. `defaultLiveStrategy()` sets **`autoApproveLive: true`**
(`modeConfig.ts:158`), inverting the paper default of `false`
(`modeConfig.ts:92`). The approval branch is:

```js
const autoApproved = (cfg.mode === 'paper' && cfg.autoApprovePaper)
  || (cfg.mode === 'live' && cfg.autoApproveLive);
const shouldAnnounce = cfg.announceBeforeTrade !== false && !autoApproved;
```

so `announceBeforeTrade: true` is dead weight in live — `autoApproved` short-
circuits it and the order is dispatched in the same pass. Verified across every
path that produces a live profile:

| Live profile from | `autoApproveLive` | Prompts? |
|---|---|---|
| `defaultLiveStrategy()` | `true` | **no — fires immediately** |
| legacy flat migration (item 19's path) | `true` | **no** |
| a store that already has `profiles` | `true` | **no** |

Note the pair is also inverted the other way: live sets
`autoApprovePaper: false` while paper sets it `true`. The two flags read as
copy-paste transposed.

**Why this matters more than item 19 alone.** Item 19 establishes that migration
widens every live size cap to paper values — `maxPositionCap` 100 against a
default of 1. Its stated mitigation was that a human still has to approve each
trade. Combined with this item, the real posture on a first switch to live is
**inflated caps with no approval step**: the bot would dispatch at 100× the
intended position cap, unattended, on the first eligible signal.

It also means item 19's audit was optimistic in a way an audit should never be —
it verified the caps and *assumed* the guard.

Fix: this is D11 dimension 4 (blast radius asserted against
`defaultLiveStrategy()`), and the assertion must cover the approval flags, not
just the numeric caps. Decide deliberately whether live auto-approves; if it
does, that is a ramp decision and belongs behind the confidence-driven sizing of
D11, not a default. Until then treat `autoApproveLive` as the single most
dangerous field in the config.

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
