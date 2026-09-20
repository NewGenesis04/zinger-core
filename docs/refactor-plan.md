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

### 33. The CLOB order-response wire format is inferred, not verified ✅ CLOSED 2026-09-17

**CLOSED from primary source** (VPS receipts for the 2026-09-11 ghost order,
domain facts §9a). BUY response `takingAmount: "4.682223"` (shares) and
`makingAmount: "1.24"` (dollars) are **decimal, human units, not 1e6-scaled**;
`getOrder().size_matched` likewise. Only the *signed* order is 6-decimal
(`order amount: 4590000`). The `takingAsShares` derived field (÷1e6) recorded
0.0000046 — the wrong guess, which is why resolving against a band rather than
assuming a scale was the right design. No code change: the 1e6 branch stays as a
defence. Status vocabulary also observed (§9e): POST `"matched"`, `getOrder`
`"MATCHED"`. Still not gated on.

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

### 47. `useAlphaFusion` is a kill switch with no writer

The only read is `scan/inputs.ts:67` — `enabled: cfg.useAlphaFusion !== false`.
Nothing else in the repo mentions the key except the comment at `signal.ts:75`.
There is no UI control, no default in `defaultLiveStrategy()` /
`defaultPaperStrategy()`, and no entry in `STRATEGY_KEYS` (`modeConfig.ts:24`).
So the value is `undefined`, `undefined !== false` is `true`, and fusion is
**on** with nothing on the dashboard to say so.

It is not cleanly settable either. An unrecognised key does persist —
`modeConfig.ts:304-306` stashes unknown keys on the active profile rather than
dropping them — but `pickStrategy()` (`:189`) copies `STRATEGY_KEYS` only, and
it runs whenever profiles are rebuilt or normalised (`:232-237`, `:322-323`).
A `useAlphaFusion: false` set today therefore survives some paths and is
silently discarded by others. A kill switch that can quietly re-arm itself is
worse than no kill switch.

Inert while `forceArbOnly` holds: `arbEngine.ts:35` bypasses directional
signals, so fusion cannot reach an entry decision. It still overwrites
`direction` / `confidence` / `score` / `edge` on signal objects that feed the
governor and dashboard, but that is display, not execution. **It becomes
load-bearing the moment directional is re-enabled** — see item 42 for the blast
radius.

**TODO, to land with the directional dial changes, not before:** add
`'useAlphaFusion'` to `STRATEGY_KEYS`, seed it in both mode defaults, and add a
checkbox beside the existing `useSignals` / `useML` / `useOrderBookBias`
toggles, which are the same shape of flag and already wired end to end.
Roughly 15 lines across three files.

---

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

### 49. A deleted variable shipped to live and crashed every live-mode portfolio read ✅ FIXED

*Found 2026-09-04 from a VPS crash log, fixed the same day.*

`79ad823` (2026-08-28, "compute netPnl without double-counting") rewrote
`netPnl` in `buildPortfolio` to be equity-based and deleted the helper it no
longer needed:

```diff
   const baselineUsd = loadBaseline();
-  const cashPnl = baselineUsd != null ? Math.round((cash - baselineUsd) * 100) / 100 : null;
   const equity = Math.round((cash + openMarkValue) * 100) / 100;
-  const netPnl = cashPnl != null
-    ? Math.round((cashPnl + pmUnrealized) * 100) / 100
+  const netPnl = baselineUsd != null
+    ? Math.round((equity - baselineUsd) * 100) / 100
```

It left `cashPnl,` in the returned object (`bot.ts:1367`). ES modules are strict
mode, so reading an undeclared identifier throws rather than yielding
`undefined` — `ReferenceError: cashPnl is not defined`.

**Only the live branch.** The paper branch returns early (`bot.ts:1296-1317`)
with `cashPnl: netPnl` properly bound and never reaches the faulty line. So the
defect was invisible for six days of paper trading and fired the moment the
instance ran in live mode.

Six call sites, one of them guarded — so this was never merely "the dashboard is
down":

| Site | Guard | Effect in live mode |
|---|---|---|
| `getState()` `:1440` | none | `/api/poly/state` 500s; `[sse] serialize fail` |
| `getAudit()` `:1905` | none | audit endpoint broken |
| `governorNow()` `:1933` | none | governor broken |
| `startBot()` `:3500` | none | starting the bot throws |
| `completeSession()` `:3566` | none | clean stop throws |
| session reconcile `:3392` | inside `try` | silently stops reconciling every 20s |

*Fix:* restore the deleted declaration in place. `netPnl` is untouched, so
`79ad823`'s double-count fix stands; `cashPnl` returns to being a standalone
reported figure — cash movement against the run baseline, excluding open
position value, which is what `:1367` and the consumer at `:1612` expect.

**Two conventions this confirms, both already written down.**

*`@ts-nocheck` is not cosmetic debt.* `bot.ts:1` is `// @ts-nocheck`, and a
dangling reference to a deleted variable is exactly what `tsc` catches for free.
This is item 32's family reaching the live path, and it arrived as finding (e)
of item 48 three weeks before that finding was scheduled to matter. The 3,900-
line file the compiler is not allowed to read is the one running live money.

*Green tests prove consistency, not correctness.* The suite was green for the
entire six days the bug was live, and is green after the fix — 28 files, 360
tests. Nothing covered it, because nothing exercises `buildPortfolio`'s live
branch. The passing run after the fix proves only that nothing else broke; the
actual evidence is that `cashPnl` now has a binding in scope.

*Not done:* `buildPortfolio` is module-private, so the invariant worth having —
"both branches return a complete portfolio without throwing, for any readiness
shape" — is not expressible as a test without exporting it. That belongs with
the D4 position-manager work rather than as a keyhole export now.

---

### 50. The receipt log keeps two generations and silently discards the third

`clobReceipts.ts` is the only immediate, durable, append-only writer in the
system — `fs.appendFileSync` per receipt (`:109`), synchronous, inside live order
execution, wrapped in a deliberately silent `catch` (`:113`; the reasoning there
is sound and should stay — a diagnostic that can break a trade is worse than a
missing diagnostic).

Rotation is the problem. At `ROTATE_BYTES` = 4 MB (`:36`):

```js
if (fs.statSync(RECEIPT_LOG).size > ROTATE_BYTES) {
  fs.renameSync(RECEIPT_LOG, `${RECEIPT_LOG}.1`);
}
```

`renameSync` onto an existing `.1` overwrites it. So retention is exactly two
generations, ~8 MB of traffic, and the third-oldest is destroyed with no record
that it existed. Found while tracing what the D8 tees would feed (item 48).

Tolerable while receipts are a debugging aid. Not tolerable once they are an
input to a permanent forensic record, which is what item 48's PR-1 tee makes
them. Fix is a rotation count (`.1`, `.2`, … `.N`) or handing rotation to
`logrotate` on the VPS; either way the decision to discard should be explicit
and configurable rather than a side effect of `rename`.

---

### 51. `persist` and `persistSync` are the same function

`persistence.ts:21-27`:

```js
export function persist(file, data)     { saveFileOrStore(file, data); }
export function persistSync(file, data) { saveFileOrStore(file, data); }
```

Byte-identical bodies. There is no async variant, no debounce, no batching — the
naming advertises a choice that does not exist, and every call site that reached
for `persist()` believing it was the cheap one got a full synchronous write.

That matters most at `bot.ts:1093`, where `saveState()` runs on **every** `log()`
call and re-serialises the whole capped actions array each time — the cost model
documented at `bot.ts:335-338`. Item 21 addressed the cap; the misleading pair is
still here.

Not fixed inline: collapsing them is a one-line change but it touches every
caller's meaning, and if a genuinely deferred writer is wanted later, this is
where it belongs. Belongs with the D5/D4 store work rather than as a rename now.

---

### 52. `/api/ops/dump` as specified would have served the wallet private key to the viewer password ✅ FIXED

*Found 2026-09-04 while implementing item 48 step F. Not shipped — the endpoint
was built with guards instead.*

The ask was `GET /api/ops/dump?key=` → `sqliteLoad(key)` + `updated_at`. Written
literally that is an **arbitrary read primitive over the whole `docs` table**.
Two facts make that unsafe here, and neither is visible from the endpoint:

1. **The store holds a private key.** `data/zinger.db` contains a
   `migrated/<ts>/wallet.json` doc whose top-level fields are `address`,
   **`privateKey`**, `polymarketDepositWallet`, `createdAt`, `importedAt`,
   `instance`. Verified by listing the table's keys and that doc's field names
   locally — the value was never read or printed.
2. **`/ops/` is the viewer-readable prefix.** `viewerDenial` (`lib/auth.ts`)
   allows *any* GET whose path starts with `/ops/`. Its own docstring says
   viewers get "no writes, and no reads of operator internals (state, streams,
   wallet, audit, traces)" — but it enforces that by prefix, and `dump` sitting
   beside `status` inherits the allowance.

So `GET /api/ops/dump?key=migrated/<ts>/wallet.json`, authenticated with the
**read-only viewer password**, would have returned the live wallet key. Nothing
about the route would have looked wrong in review: it is one line, it reuses an
existing store function, and it sits under a prefix already documented as
read-only.

*Not a git exposure:* `.gitignore` carries `data/**` and `data/zinger.db` has
never been tracked. The risk was the endpoint, not the repository.

**Shipped instead**, three independent guards:

1. `req.auth?.role !== 'operator'` → 403. The role is checked directly, never
   inferred from the path prefix.
2. `DUMPABLE_KEYS`, an explicit allowlist of fifteen state docs. An allowlist,
   not a denylist — a denylist can only exclude the secrets already thought of,
   which is the same reasoning `clobReceipts` uses for not whitelisting fields.
   Everything under `migrated/` is excluded; that subtree is where the wallet
   snapshot lives.
3. A `SECRET_SHAPED` pattern check that refuses wallet/key/seed-shaped key names
   even if one is ever mistakenly added to the allowlist.

A request with no `key` returns the allowlist, so the endpoint is still
discoverable without being enumerable.

**The general lesson, and it outlives this endpoint.** Any read primitive over
the store is a wallet-key primitive for as long as the key lives there. Chasing
*why* it lives there turned up the actual defect — see **item 53**, which is the
one to read. This entry is the symptom; 53 is the cause.

---

### 53. `tryLoadWallet` wrote the `.env` private key into the state store, on a timer ✅ FIXED

*Found 2026-09-04 while implementing item 48 step F; fixed the same day.*

The operator's private key lives in `.env`, which is correct and was never in
doubt. What nothing in `.env` reveals is that **reading it persisted it**:

```
refreshTelemetry()   ── on a timer ──>  checkReadiness()          readiness.ts:50
                                          └── getWallet()                    :51
                                                └── tryLoadWallet()      wallet.ts
                                                      ├── reads POLYMARKET_PRIVATE_KEY
                                                      └── importWalletKey(envKey)
                                                            └── saveFileOrStore(WALLET_FILE)
                                                                  └── docs table, key
                                                                      `wallet.json`,
                                                                      privateKey included
```

`importWalletKey` persists — that is its job on the operator import path (item
18). `tryLoadWallet` called it unconditionally, so a function named "load"
performed a write, of a secret, into shared state. With no caching, every
`getWallet()` re-imported and re-saved, and `checkReadiness` runs on the
telemetry timer. The live key was therefore rewritten into `data/zinger.db`
continuously for the life of the process.

**Why it was invisible.** No call site looks wrong. `readiness.ts` asks for the
wallet, which is exactly what a readiness check should do. `.env` is genuinely
the source of truth, so an operator reasoning about where the key lives gets the
right answer and still misses this. The write is three frames below a function
whose name promises a read.

**Blast radius beyond the endpoint.** `data/zinger.db` is a secret-bearing file.
Any copy of it carries a live key — a backup, a debug pull to a laptop, a
database shared for analysis. The dump endpoint was one exposure; the file is
the general one.

*Fix:* `importWalletKey` takes `persist` (default `true`, preserving item 18's
import path) and a `source` tag. `tryLoadWallet` passes `persist: false` for
env-sourced keys — `.env` is already the durable home, so copying it into the
store buys no recoverability. `setDepositWallet` spread `current` wholesale and
would have re-persisted the key, so it now strips `privateKey` when the wallet
came from env. `loadOrCreateWallet` still persists, deliberately: a generated
key exists nowhere else and not writing it strands any funds sent to that
address.

*Invariants:* `tests/unit/walletKeyPersistence.test.ts` — five, in a separate
file from `wallet.test.ts` because they mock the store and that mock would
change the meaning of item 18's existing tests. The load-bearing one is a
property, not a shape assertion: *no argument this module passes to the store
may contain the key*, which survives a refactor that changes what gets saved.
Mutation-checked — restoring the unconditional persist kills three.

**Operator actions, neither of which is code:**

1. **Purge the stored copies on the VPS.** The fix stops new writes; it does not
   remove what is already in `data/zinger.db`. Both `wallet.json` and
   `migrated/<ts>/wallet.json` should be deleted from the `docs` table.
2. **Consider the key exposed and rotate it** if that database has ever left the
   VPS — a backup, a copy pulled for debugging, anything.

*Mechanism fixed too, 2026-09-05.* `migrateDir` walked `data/` and imported
**every** `.json` with no filter — how `wallet.json` entered the store in the
first place, and what would have done the same to the next credential-shaped
file. It now refuses on two independent checks, and returns a `refused` count
alongside `imported`/`skipped`:

| Guard | Catches | Misses |
|---|---|---|
| `SECRET_FILENAMES` on the walk | anything named `wallet`/`secret`/`key`/`credential`.json, without reading it | a key inside `config.json` |
| `carriesSecret` on the content | a top-level `privateKey`/`mnemonic`/`seed`/… in any file, whatever its name | a key nested below the top level |

Neither subsumes the other, which is the point — the case that actually happened
(`wallet.json`) is caught by both, and each covers a shape the other cannot see.
Refusals `console.warn` the filename and the offending **field name**, never the
value, so a skipped file is visible rather than a silent gap.

Scope, deliberately: the filter is on the bulk walk only, not `saveFileOrStore`.
`loadOrCreateWallet` must still be able to persist a generated key — that one
exists nowhere else. A considered write is different from a directory sweep.

*Convention 6 earned its place here.* The first version of the test suite passed
with the filename filter disabled — `wallet.json` carries a top-level
`privateKey`, so the content check caught it either way and the filename guard
was never exercised. The surviving mutant was the finding: the test was wrong
about *where* the property was enforced, exactly as the convention predicts. A
case only the filename filter can catch (`secrets.json` with the key nested one
level down, invisible to a top-level scan) now covers it, and disabling either
guard fails a test.

---

### 54. The request timeout has two writers and no owner ✅ CLOSED (Neutralized by items 55, 57, 60, 61)

*Found 2026-09-07 diagnosing an `ERR_HTTP_HEADERS_SENT` on the live VPS run.
Resolved in code by bounding all CLOB reads (57), parallelizing readiness (55),
and decoupling the scan loop (60) so response latency is consistently <= 2s.*

The observed stack:

```
Error [ERR_HTTP_HEADERS_SENT]: Cannot set headers after they are sent to the client
    at ServerResponse.json (express/lib/response.js:252:15)
    at <anonymous> (/opt/apps/ZINGER/src/server.ts:459:23)
    at process.processTicksAndRejections
```

`server.ts:459:23` is exact — column 23 lands on the `json` of
`res.status(500).json(...)` in the `POST /api/poly/sync` catch, and the
`processTicksAndRejections` frame places it in the post-`await` continuation.

Two things write to the same response. The timeout middleware (`server.ts:122-129`):

```js
res.setTimeout(long ? 90000 : 25000, () => {
  if (!res.headersSent) res.status(503).json({ error: 'timeout' });
});
```

and the route handler itself (`server.ts:455-461`). Because a callback is passed,
`res.setTimeout` overrides Node's default socket-destroy: at 25 s the middleware
sends a complete 503 and **leaves the handler running**. Nothing cancels the work
behind it. When it finishes, it writes to a committed response.

The sequence is not the obvious one. `syncBalances` (`bot.ts:2079`) does not
reject on a network fault — `syncClobBalance` is wrapped in a bare
`try {} catch {}` (`bot.ts:2080-2082`) and `refreshTelemetry`
(`bot.ts:2060-2073`) catches everything and returns a degraded readiness object.
So under a stall it **resolves**, line 457's `res.json(result)` throws first, its
own catch swallows that, and line 459 throws again and escapes. Express 5.2.1
forwards the escaped rejection to `finalhandler`, which finds `headersSent` and
can only log the stack and destroy the socket.

**The consequence worth naming: the dashboard was told `503 timeout` for a
balance sync that succeeded.** The result was computed and discarded. The stack
trace is currently the only evidence that happened.

Scale of the exposure, counted rather than estimated:

```
67   route handlers in server.ts
34   res.status(500).json sites
 3   guarded with `if (res.headersSent) return`  (:1072, :1087, :1096)
```

Those three are `/api/poly/depth`, `/api/poly/charts` and `/api/poly/ml-refresh`
— the slowest routes, two of which the middleware already special-cases to 90 s.
Someone hit this race there and guarded the symptom. Note what the guard does:
it silences the log while still returning a 503 for work that completed.

**Do not fix this by scattering `headersSent` checks, and do not fix it by
monkey-patching `res.json` to no-op** (both were proposed; the second was
proposed as the "clean" option). Every `headersSent` check is a negotiation
between two writers — none of them makes one the owner, and the global wrapper
version turns a loud bug into a silent one: the sync still reports a timeout it
did not have, and now nothing logs it. A wrapper of that shape would also cover
`json`/`status` but not `send`/`end`/`redirect`/`sendFile`/`setHeader`, so
`express.static` and `finalhandler` bypass it. (`server.ts:1` is `// @ts-nocheck`,
so any claim that such a patch is "type-safe" is vacuous — TS is not checking
this file.)

The owner-shaped fix: one `AbortController` per request; the middleware aborts the
signal and is the **sole** responder on timeout; handlers observe the signal and
return without writing. Then `headersSent` never needs checking, because there is
only one writer — and you get real cancellation, which is what sheds load during a
stall. A `Promise.race` deadline does not cancel: the underlying fetch keeps
running with its socket open, so a sustained stall accumulates in-flight work
instead of shedding it.

Blocked on item 55: no deadline is defensible while the worst case is unbounded.

---

### 55. `checkReadiness` has one outbound call with no timeout at all ✅ FIXED

`readiness.ts:41`, inside `fetchDepositPositions`:

```js
const res = await fetch(`https://data-api.polymarket.com/positions?user=${depositWallet}`);
```

No `AbortSignal`. Every other remote call in that file is bounded — the viem
transport at `:23` (8 s), the geoblock check at `proxyEnv.ts:121` (8 s). This one
falls back to undici's dispatcher defaults, which is minutes, not seconds, on a
connection that opens and never answers.

It sits in the middle of a **strictly sequential** chain (`readiness.ts:50`):
geoblock `:65` → `ensureApiKey` `:75` → `readDepositWalletOwner` `:83` →
`readContract` pUSD `:94` → **`fetchDepositPositions` `:41`** → `getClobBalance`
`:122` → `readContract` USDC `:144` → `getBalance` `:161`. The bounded steps
alone sum past the 25 s deadline that item 54's middleware enforces on
`/api/poly/sync`, so the collision there is structural, not unlucky. The unbounded
step makes the worst case unknowable, which is why item 54 cannot be closed by
picking a larger number.

Two candidate fixes, and they are not equivalent: bound the call and keep the
chain sequential, or bound it *and* parallelise the independent legs (the two
`readContract` calls and `getBalance` share no data). The second changes the RPC
burst profile against `polygon-bor.publicnode.com`, so it is a decision, not a
cleanup.

Blast radius is smaller than it looks: `refreshTelemetry` swallows the failure and
`liveReady` is not a runtime order gate — its only consumer is a start-time log
line at `bot.ts:3800`. What a stall produces is a spurious
`system.alert` "live readiness lost"/"restored" pair (`bot.ts:2040-2058`), not a
halted bot.

---

### 56. `publishPublicSignals` runs a 5 s operation on a 2 s interval ✅ FIXED

`bot.ts:3708`:

```js
setInterval(() => { publishPublicSignals().catch(() => {}); }, 2000);
```

No in-flight guard. `publishPublicSignals` → `getSignalForBoth` (`signal.ts:343`)
→ `Promise.all` over two `fetchCandles`, each `AbortSignal.timeout(5000)`
(`signal.ts:86`). When Binance is slow, the interval keeps firing into a stalled
predecessor and concurrent fetches accumulate — the opposite of the retry it reads
as. Observed on the VPS as two consecutive
`[public-signals] The operation was aborted due to timeout` lines (`bot.ts:3704`;
that string is the verbatim `AbortSignal.timeout` `DOMException` message, and
`fetchFunding` at `:100` swallows its own errors, so the throw is `fetchCandles`).

Harmless at two ticks. The failure mode to avoid is a longer Binance outage, where
the pile-up is bounded only by how long the stall lasts. A single in-flight flag,
or replacing the interval with a self-rescheduling timer, closes it.

Worth recording alongside: Binance egress does **not** ride the CLOB proxy.
`installClobProxy` sets axios defaults and nothing calls `setGlobalDispatcher`, so
native `fetch` goes direct. The Binance path and the Polymarket path share only the
VPS's own egress — which is why both symptoms appearing together points at the host
network rather than at the proxy.

---

### 57. `ensureApiKey` was unbounded, and cached a failure as a success ✅ FIXED

*Found 2026-09-07 tracing a 25 s `/api/poly/sync`. Root cause was billing, not code.*

`trade.ts:67` read:

```js
export async function ensureApiKey() {
  if (_creds) return _creds;
  _creds = await client.createOrDeriveApiKey();
  return _creds;
}
```

Three defects behind one line:

1. **Unbounded.** `@polymarket/clob-client-v2` calls the *global* axios instance
   (`dist/http-helpers/index.js:18`) and sets no timeout of its own;
   `installClobProxy` set `axios.defaults.httpAgent/httpsAgent/proxy` but never
   `timeout`. On a dead proxy this hung past the 25 s response deadline.
2. **A falsy result never memoised**, so every readiness pass re-derived — an
   unbounded proxied call, on a timer.
3. **Credentials returned *without a key* were cached as success.** The panel
   then reported `API key missing` and the balance check
   `buildPolyHmacSignature: secret is empty`. Both read as a credential bug. The
   actual cause was an exhausted proxy quota, and that misdirection cost six
   rounds of diagnosis.

Fixed: success caches for the process lifetime, keyless credentials are a
failure with a message that says so, and failure backs off 1m→15m so the bot
heals on its own once the proxy returns.

**The timeout fix is not `axios.defaults.timeout`.** That would also cap order
submission, and an order POST that times out is *not* a cancelled order — it may
have reached the book, leaving money in a state the bot has no record of, which
is what `assertOrderAccepted` and the receipt log exist to prevent. A request
interceptor bounds reads only, matching money paths exactly. Substring matching
is wrong: the SDK's *reads* include `/data/order/`, `/data/orders`,
`/order-scoring`, `/orders-scoring`, and `createOrDeriveApiKey` POSTs to
`/auth/api-key` — so a "leave POSTs alone" rule leaves the hang exactly where it
was.

*A caution worth keeping.* The first version of that interceptor shipped green
and did nothing: axios merges its defaults (`timeout: 0`) **before** request
interceptors run, so the `config.timeout == null` guard never fired and no read
was ever bounded. Every predicate test passed, because the predicate was right —
only the application was dead. It was caught by an assertion on
`res.config.timeout`, not by review. Test the effect, not the helper.

---

### 58. Cache policy: "never cache failures" means "retry every time" ✅ FIXED

The instinct is that failures must not be cached, or a transient error gets
locked in. Taken literally it produces the opposite of what you want: a dead
dependency is re-probed on **every** pass, which is precisely the hammering that
drained the proxy quota *after* it had already stopped working.

The three cases have genuinely different costs, so lifetime is chosen from the
outcome rather than the call site (`readiness.ts`):

| outcome | TTL | why |
|---|---|---|
| `ok && !blocked` | 4 h | a good answer; cache long |
| `ok && blocked` | 10 min | a *true* answer — recover fast when the proxy returns |
| check failed | 1m → 15m backoff | rate-limit a dead dependency |

Recovery stays immediate: the streak resets on the first success.

`deposit_owner` was proposed as a permanent cache on the grounds that "contract
ownership is immutable". That is not verified in
`docs/research/polymarket-domain-facts.md`, and Ownable contracts have
`transferOwnership` — the exact shape of the negRisk incident in CLAUDE.md. It is
also a *direct RPC* call, so caching it saves no proxy bandwidth at all. Given a
1 h TTL instead: no upside to the risk.

---

### 59. Readiness cannot say "the proxy is down" ✅ FIXED 2026-09-17

**FIXED 2026-09-17** (`readiness.ts`), design agreed with the operator the same
day. Departs from the original proposal below on two points, deliberately: no
probe-first ordering and no short-circuit.

**What the code did before, traced from source** (`readiness.ts`,
`proxyEnv.ts:checkGeoblock`, `trade.ts:ensureApiKey`, SDK
`http-helpers/index.js:74`, which returns transport errors as `{ error }` values
rather than throwing):

| | restart with the proxy dead | proxy dies while running |
|---|---|---|
| geoblock | proxied call throws → silent DIRECT fallback → *"restricted in FR"* | green from a **4 h** cache (`TTL.geoblockAllowed`) |
| api | *"Wallet must sign CLOB API auth"* | green — key memoised for process life |
| clob_balance | *"CLOB registry: timeout of 10000ms exceeded (website balance may still work)"* | same |
| `liveReady` | false | **true** — cached region + memoised key + on-chain pUSD fallback |

`geoblock.proxyError`, which names the cause, was computed and discarded. In the
mid-run case directional live entries (`directional.ts:353`) stayed enabled with
no route to the CLOB.

**Why not the original proposal.** A probe on every pass is a proxied request
every 30 s (`syncBalances`, `bot.ts`) — about 28 MB/day at the ~10 KB/request
measured in item 61, a large share of the 1 GB/month quota. Probe-first
sequencing would also undo item 55's overlap. The "25 s hang" premise is stale:
items 55/57 bound every read at 10 s and overlap the legs.

**What it does now.**
- **Conditional probe.** `checkProxyHealth` (GET `clob/time` through the proxy,
  6 s) runs only when a proxied leg failed: `geoblock.proxyError`, a failed
  proxied geoblock answer, `api` rejected, or the CLOB balance leg threw or
  returned `clobError`. A healthy pass spends zero proxy requests on diagnosis.
- **Cached like every other leg.** Healthy verdict `TTL.proxyHealthOk` (10 min);
  failed verdict rejects inside `leased`, so it gets the 1→2→4→8→15 min backoff.
  Dropped on the first pass with no proxied failure, so a restored proxy is not
  reported down from cache.
- **`proxy` row, first in `checks`.** Red: *"CLOB proxy unreachable (…) — CLOB
  auth, balance and region checks cannot pass until it is restored"*. Green:
  *"… the CLOB failures below are not the proxy"*.
- **`liveReady = false` when the probe confirms the proxy down** (operator
  decision). A probe blip blocks directional live entries for one backoff step,
  1 min at first — accepted as the safe side.
- **`needs`:** proxy line first; the registry, API-auth and region lines are
  suppressed while the proxy is confirmed down, since they are its consequences.
- **geoblock row** no longer reports this host's direct egress as the trading
  region when `proxyError` is set (independent of the probe). Its `ok` value and
  `regionAllowed` are unchanged.
- `readiness.proxyHealth` exposes the verdict (null when not probed).

**Tests** — `tests/unit/readinessProxyHealth.test.ts` (14): zero probes on a
healthy pass and with no proxy configured; each of five triggers probes exactly
once; mid-run shape flips `liveReady` only on a down verdict (control run with a
reachable proxy stays true); proxy row first, other checks intact; misleading
needs removed; geoblock wording; a reachable proxy is not blamed; bounded probes
during an outage; fresh probe after a clean pass. `readinessChecks.test.ts`
gains `proxy` at the head of `CANONICAL_ORDER`. Mutation-checked, 7 mutants, all
killed: liveReady ignoring the verdict (2 fail), probing every pass (2), never
forgetting a down verdict (1), uncached probe (1), old geoblock wording (1),
misleading needs kept (1), `clobError` not a trigger (5).

**Not covered here:** the arb engine does not read `liveReady` at all — filed as
item 63b.

---

*Original filing follows.*


**OPEN.** `checkProxyHealth()` already exists (`proxyEnv.ts:191`), is bounded, and
is cheap — but `checkReadiness` never consults it. So a dead egress proxy
surfaces as `API key missing` plus `secret is empty`, which reads as an auth
problem three layers away from the cause.

Item 57 improves the message (`CLOB auth backoff (Ns left): …`), but the
diagnosis is still indirect. A `proxy` check consulted first, short-circuiting
the CLOB legs when it fails, would turn a 25 s hang and two misleading checks
into one accurate check in ~2 s.

This is the highest-value remaining item in the group. It is the difference
between an outage that diagnoses itself and one that takes six rounds.

---

### 60. `checkReadiness` ran on the 250 ms trading hot loop ✅ FIXED

`scan/index.ts:75` awaited `refreshTelemetry()` — the full eight-call
`checkReadiness()` — on every tick of `setInterval(scan, POLY_SCAN_INTERVAL_MS)`
where `POLY_SCAN_INTERVAL_MS = 250` (`config.ts:19`). Two of those calls egress
through the metered CLOB proxy.

Two costs, not one. The obvious one is bandwidth. The other is that every cycle
blocked on remote I/O before doing any trading work, and `_scanning` serialises
cycles — so a slow proxy throttled the scan rate itself. During the outage the
loop likely fell from ~4/s to roughly one per 25–30 s.

Fixed: the background `syncBalances` timer owns `botState.readiness`; the scan
loop is a reader and writes nothing.

*The test froze the bug.* `scanOrchestrator.test.ts` asserted
`expect(refreshTelemetry).toHaveBeenCalled()` — a characterization test that made
the defect a requirement. Inverted to `not.toHaveBeenCalled()`. This is the
failure mode CLAUDE.md describes: a snapshot of current behaviour freezes the
bugs too.

---

### 61. The always-on timer drank a 1 GB/month quota in nine days ✅ FIXED

*Measured, not estimated.* Webshare dashboard, cycle 26 Aug – 25 Sep 2026:
**105,125 requests / 1.01 GB**, exhausted ~3 Sep.

`setInterval(syncBalances, 30000)` (`bot.ts:3637`) ran whether or not the bot
traded, at 4 proxied requests per tick:

```
syncClobBalance()   → updateBalanceAllowance + getBalanceAllowance   = 2
refreshTelemetry()  → checkGeoblock + getBalanceAllowance            = 2
```

2,880 ticks/day × 4 × ~10 KB ≈ **116 MB/day → 1 GB in ~8.8 days.** Cycle opened
26 Aug 21:07; the dashboard shows bandwidth flatlining 1–3 Sep. The arithmetic
matches the outage to the day.

Note the *scan loop was not the dominant consumer* despite being the far larger
ceiling — at 8 req/s it would have burned 1 GB in ~1.5 days, and only 105k
requests were made in total. The boring always-on timer was the drain. Worth
remembering when triaging by theoretical rate rather than measurement.

Three of the four requests per tick were waste:

- `getBalanceAllowance` was called **twice**: `syncClobBalance` ended with
  `return getClobBalance()` (a value all seven call sites discarded), then
  `checkReadiness` called `getClobBalance()` again.
- `checkGeoblock` ran every 30 s. Your country does not change every 30 s.
- `updateBalanceAllowance` ran every 30 s with no trading in flight.

Fixed via items 58 and 60 plus the dedupe. Projected ~1,500 req/day (~35 days
per GB) — **a projection from the timers, not a measurement.** The counter added
in this work (`getProxyRequestStats`, exposed as `proxyUsage` on
`/api/v1/data-health`) is what makes it checkable; `perHour` is the number to
watch, and it should agree with the Webshare dashboard within a few percent.

---

### 62. Live arb had no affordability gate ✅ FIXED

`arbEngine.ts:172` read `mode === 'paper' && ...`. Paper refused to size beyond
its bankroll; **live had no equivalent anywhere.** Live sizing took
`readiness.spendableBalance` (`:157`), computed a cost, and never checked the
balance covered it — and `shareBudget` floors at `minPositionSize * 2` (`:159`),
so even a zero balance produced an order.

Survivable only while readiness was refetched every scan tick. Item 60 makes it
load-bearing: a stale-high balance fills leg one and has leg two rejected for
collateral, leaving an **unhedged directional position** — the one outcome an arb
package exists to prevent. The risk is never an overdraft (Polymarket will not
fill what you cannot fund); it is always a broken hedge.

Fixed: one expression for both modes, live skips emitting
`insufficient_live_cash` so the refusal is visible in telemetry.

Paired with `applyBalanceDelta` (`readiness.ts`), which deducts a fill in memory
*synchronously* — the TTL cache means a post-trade refresh returns the pre-trade
number, so waiting for the network would leave the same window open.

---

### 63. A failed CLOB balance read never sets `clobError` ❌ CLOSED 2026-09-17 — covered by items 57, 59, 63b

**CLOSED, no code change** (operator decision). Re-traced against current code:

- **A dead proxy mid-run does not take this branch.** The SDK returns transport
  errors as values (`clob-client-v2/dist/http-helpers/index.js:74`), so
  `getClobBalance` resolves with `clobError` set rather than throwing.
- **The throw branch needs `getTradingClient` to fail**, which means
  `ensureApiKey` failed, which already fails `api` and forces `liveReady` false.
- **Item 59** probes the proxy after any proxied failure and forces `liveReady`
  false when it is down; **item 63b** makes arb obey `liveReady`.
- **The one remaining window** — API key recovers while the balance leg still
  serves a cached failure (backoff up to 15 min) — is a window in which the CLOB
  *is* reachable again, so `liveReady: true` there is correct. Item 59's cached
  down verdict holds it false until the proxy is re-probed anyway.

**Residual, unverified, not acted on:** `ensureApiKey` requires `creds.key` but
not `creds.secret` (`trade.ts:104`). Credentials with a key and an empty secret
would make every L2-signed call throw. Whether the CLOB can return that shape is
unknown.


**OPEN — behavioural, needs a decision.** In `checkReadiness`, the failure branch
for `getClobBalance` pushes a `clob_balance` check but leaves `clobError` null.
So `clobWorks = apiReady && !clobError` stays true, and `liveReady` can remain
**true while the CLOB is unreachable**, provided on-chain pUSD is visible.

It may well be deliberate — the check falls back to `depositPusd`, and there is a
`needs` message about "website balance may still work". In practice a dead proxy
also fails `ensureApiKey`, which does force `liveReady: false`, so the state is
hard to reach. Left alone because changing it is a design call on the live gate,
not a cleanup.

---

### 63b. The arb engine never consults `liveReady` ✅ FIXED 2026-09-17

**FIXED 2026-09-17 — Option 1, operator's choice: gate arb on `liveReady`
directly.** One answer to "can this bot execute live orders" for both engines.
Accepted cost: a blip in any readiness condition (the region heuristic included)
pauses live arb until it recovers.

**Where** — `arbEngine.ts:detectAndExecuteArbPackage`, after the two gap gates
and before capacity, sizing and execution: `mode === 'live' &&
!readiness?.liveReady` → skip `live_not_ready`, operands `{ readinessKnown,
proxyDown }`.
- *After the gap gates* so the code is counted only for books that were
  genuinely tradable — the case where "why didn't arb trade?" gets asked.
- *Fails closed* on a missing snapshot. Directional's gate is written fail-open
  (`readiness && !readiness.liveReady`, `engines/directional.ts:353`), but not
  reachably: `botState.readiness` starts `null` (`bot.ts:143`) and directional's
  bankroll gate (`:328`) reads that as $0 and refuses first. Noted, not changed.
- `live_not_ready` is added to the decision sink's `COUNTED_CODES`: standing
  state, hourly counts, no per-scan rows.
- Paper mode is untouched.

**Tests** — `tests/unit/arbLiveReady.test.ts` (6): not-ready live sends no leg
while the same book trades when ready; missing snapshot fails closed;
`proxyDown` operand recorded; paper unaffected; a no-gap book keeps its gap code;
sink classification. Mutation-checked, 5 mutants, all killed: no gate (4 fail),
fail-open on a missing snapshot (2), gating paper too (2), dropped `proxyDown`
operand (1), code persisted per row (1).

**Existing tests touched.** Six live-mode arb fixtures (`arbDecisionSink`,
`arbDepthUtilisation`, `arbEngine`, `arbReconcile`, `arbSizingGate`, `ctfMerge`)
gained `liveReady: true` — each tests something else and models a live-ready
bot. `arbAffordability` sets `liveReady: true` explicitly to isolate the
affordability gate; its "readiness missing entirely" case now expects the
earlier `live_not_ready` refusal, and a new case (`{ liveReady: true }`, no
balance) keeps the "absent balance reads as zero" invariant on the
affordability gate itself.

---

*Original filing follows.*


**Filed 2026-09-17** while fixing item 59, at the operator's direction, as a
separate item under 63 (both concern what gates live execution).

`liveReady` gates directional live entries (`engines/directional.ts:353`) and a
session-start warning (`bot.ts`, `refreshTelemetry().then`). Nothing on the arb
path reads it. `grep liveReady` over `arbEngine.ts`, `arbReconcile.ts` and
`scan/` returns nothing. The arb call site runs on `cfg.clobArbEnabled` and
`isArbOnlyMode || arb` alone (`bot.ts:2949`) and passes `readiness` through only
for `spendableBalance`.

**Consequence.** Every condition `liveReady` encodes is invisible to arb:
deposit-wallet owner mismatch, missing API key, unverified region, and — since
item 59 — a confirmed-dead CLOB proxy. With the proxy down, `spendableBalance`
still includes on-chain pUSD read directly, so the affordability gate passes and
arb legs are sent into a dead route. Each fails and is contained (FOK, item 80
reconciliation, item 84 abort), so this costs failed attempts and proxy-backoff
noise rather than exposure — but it is the same "firing doomed orders" item 59
removed for directional.

**Not fixed.** Adding `liveReady` to the arb gate changes when live arb trades,
so it is a decision on the live gate alongside item 63. Two shapes to choose
between: gate arb on `liveReady` as a whole, or on the specific conditions that
make an arb order undeliverable (proxy down, no API key, owner mismatch) while
leaving e.g. the region heuristic out.

---

### 64. Directional live sizing has the same staleness gap, bounded

**OPEN, low severity.** `bot.ts:2703` gates affordability on
`cfg.mode === 'paper'` exactly as arb did (item 62), and `resolveOrderSize`
takes `readiness` directly (`bot.ts:2678`).

Materially safer than arb was, for three reasons: `engines/directional.ts:78`
already returns `no_bankroll` when the balance is absent or zero, so cold start
is covered; it is a single leg, so a rejection is just a rejected order with no
hedge to break; and `maxUsd` caps exposure at `bankroll × maxPositionPct`
(default 10%) of the *stale* number.

Worth closing for symmetry with item 62, but it does not gate item 60.

### 65. SSE reconnect loses the middle, and `dropped` stays false ✅ FIXED

**Found 2026-09-08** while closing item 48 step B on the VPS. The live sync frame
reported `hasMore: true`, which is the bug condition, not an edge case.

`/api/poly/events/stream` replays with a hard-coded `limit: 1000`
(`server.ts:771-775`) against a 30,000-event buffer
(`DEFAULT_EVENT_BUFFER_CAP`, `events.ts:28`). The replay is a *front* slice —
correct for a catch-up read, and `events.ts:478-481` deliberately guards against
a tail slice skipping the middle. But the stream then goes live from the queue,
which only holds events emitted after the subscribe at `server.ts:760`. So when
`hasMore` is true, everything between replay-end and connect-time is never
framed:

```
subscribe (server.ts:760) ──────────────┐  queue starts HERE
queryPage(after=cursor, limit=1000)     │
  └─ front slice: the OLDEST 1,000 ─────┤
     ╔══════════════════════════════╗   │
     ║  up to 29,000 events         ║   │  ← never framed, dropped:false
     ╚══════════════════════════════╝   │
flush queue (server.ts:802-806) ────────┘
```

`dropped` is false because the cursor *was* found (`events.ts:490-499`), so the
one gap signal step B exists to provide does not fire on this gap. `hasMore` in
the sync frame is the only indication, and a consumer that treats the stream as
self-sufficient has no reason to read it.

Measured on the live instance: 30,000 events span 46.7 minutes (~10.7 events/s,
~2.7 per 250 ms scan cycle — `scan.cycle` at `bot.ts:1309` plus one
`arb.decision` per symbol at `arbEngine.ts:72`). **A 1,000-event replay is
therefore a 94-second reconnect horizon.** Any consumer away longer comes back
holed and cannot tell.

Three candidate fixes, cheapest first:

1. Set `dropped: true` whenever `hasMore` is true on a stream replay. One line,
   turns a silent hole into the loud one the consumer already handles.
2. Page the replay to the head before flushing the queue, rather than a single
   1,000 slice. Correct, but unbounded work on a cold cursor.
3. Raise the replay limit toward the buffer cap. Only moves the cliff.

(1) is right on its own merits: the consumer contract already says a true
`dropped` means resync. Do not do (3) alone.

**Fixed with (1).** `buildSyncFrame` (`events.ts:583-594`) now reports
`dropped: page.dropped || page.hasMore`, and `server.ts:779-782` calls it
instead of assembling the frame inline. Put in the leaf telemetry module rather
than in `server.ts` deliberately: importing `server.ts` from a test pulls in the
whole bot, which is why this layer had no coverage and why the bug survived
review. Four invariants in `tests/unit/events.test.ts` — the truncated case
reports a gap, the complete case stays quiet (over-reporting on every connect
would train the consumer to ignore the flag), an evicted cursor still reports
even when the head *is* reached, and `replayed` matches the frames actually
sent. Mutation-checked: reverting the `|| page.hasMore` fails the first with
`expected false to be true`. 457/457, `tsc` clean.

Widening `dropped` is the safe direction but it is not free — it is a **contract
change** for any consumer already written against the old meaning. Today there
is none (`grep` finds no in-repo reader of `/api/poly/events/stream`; the
Forensics Truth Engine is external and unbuilt), so the cost is zero now and
would not have been later. Note that a *cursorless* connect on a busy instance
now reports `dropped: true`, because it genuinely is missing history — a fresh
consumer that wants the backlog must page `/api/poly/events`, not trust the
replay.

**Note the emission rate independently.** 396,283 events in ~10.3 hours is
~2.7 per scan cycle, almost all of them `arb.decision` skips recording the same
`gap_below_breakeven`. That is not wrong — the bus is additive and the DB is the
system of record — but it is what reduces the buffer's useful horizon to 47
minutes, and it is worth asking whether a repeated skip on an unchanged quote
needs its own event.

### 66. The instant CTF merge has never executed — dead guard on the money path

**OPEN, high severity.** Found 2026-09-08 chasing why arb redemption had to be done
by hand in the Polymarket web app.

`arbEngine.ts:337-374` implements exactly the right thing: on a locked package it
calls `executeCtfMerge` (`ctf/merge.ts:46`), burning the matched UP+DOWN pair back
to collateral on-chain. **Merge, not redeem** — a complete set converts to $1.00 of
USDC immediately, with no oracle, no resolution wait and no claim step. That is
strictly better than `redeemPositions` for arb and the implementation looks correct
(CTF `0x4D97DC…6045`, partition `[1,2]`, 6-decimal amount).

It has never run. The guard is:

```js
if (cfg?.instantCtfMerge !== false && mode === 'live'
    && (botState?.walletClient || botState?.signer)) {
```

`botState.walletClient` and `botState.signer` are **read at `arbEngine.ts:338,345`
and assigned nowhere in the tree.** `grep -rn "walletClient\|botState.signer" src/
scripts/` returns hits only in `pons.ts`, `swap.ts` and `trade.ts`, each of which
builds its own local client; none of them writes to `botState`. Both properties are
permanently `undefined`, so the condition is always false.

**It fails silently in two layers.** The guard has no `else`, so a skip is never
logged. And if it ever did run, `if (mergeRes?.ok)` at `:349` also has no `else` —
a reverted merge leaves `pkg.status` at `LOCKED`, emits nothing, and logs nothing.
Nothing sweeps for `LOCKED` packages to retry (`grep` for `pkg.status` shows no
retry path). Capital sits in unredeemed tokens until someone opens the web app.

**The unresolved question gates the fix.** `walletClient.account` would sign as the
EOA, but Polymarket trades settle through the deposit/proxy wallet
(`getFunderAddress()`, `trade.ts:143`) which is a different address from
`getWalletAddress()`. If the ERC-1155 outcome tokens are held by the proxy, a direct
EOA `mergePositions` reverts on balance and wiring a viem wallet client fixes
nothing — the call has to go through the relayer instead
(`@polymarket/builder-relayer-client`, already a dependency at `package.json:25`).

Check before building anything: `balanceOf(address, positionId)` on the CTF
contract for both the signer and the deposit wallet, for a known held position.
That single reading decides between a ten-line fix and a relayer integration.

Note the directional path has no equivalent at all: merge needs a complete set, so
a directional position that expires in the money requires `redeemPositions` after
resolution, or a CLOB exit before expiry. Not currently biting because
`forceArbOnly` is on.

**Second defect in the same path: the collateral token is wrong.** `ctf/merge.ts:5`
defaults to `DEFAULT_COLLATERAL_USDC = 0x2791Bca1…4174` (USDC.e). Polymarket's
[CTF docs](https://docs.polymarket.com/trading/ctf/redeem) state the collateral is
**pUSD** at `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` — "Splitting converts pUSD
into a complete set of outcome tokens". Zinger already has that exact address in
`config.ts:7` as `POLY.pUsd` and uses it throughout `swap.ts`.

`arbEngine.ts:344` passes `collateralToken: market.collateralToken`, which would
override the default — except `collateralToken` is **read there and assigned
nowhere**; `grep -rn "collateralToken" src/` returns that one line plus `merge.ts`
itself. So the call would fall back to USDC.e and compute the wrong collection id.

That is three independent faults on one path, each sufficient to break it: the
guard never passes, the collateral is never supplied, and the fallback collateral is
the wrong token. Wiring only the wallet client would produce a revert, not a merge —
worth knowing before anyone "fixes" this in one line.

**Mitigation available today, no code:** Polymarket ships an Auto-Redeem toggle
(Settings → Trading, one-time gasless approval) that redeems winnings after
resolution. It is not a substitute for merge — it waits for the oracle where merge
does not — but it returns arb capital without manual clicking, which downgrades this
item from *capital gets stuck* to *capital returns slower than it could*.

**Resolved 2026-09-08: use Auto-Redeem, leave merge unbuilt.** The case for merge is
capital recycling — a $30 bankroll turning over many times an hour instead of once
per window. That argument is only worth anything if **capital is the binding
constraint, and it is not.** Live `arb.decision` events show `asksSum` at 1.01
against a `requiredGap` of 0.0399, i.e. the pair must price at ≤ 0.96 before a
trade fires, and observed decisions are `skip · gap_below_breakeven` by a wide
margin. The bot is idle for want of opportunities, not for want of free cash.
Faster recycling multiplies a number near zero.

**Revisit only when this is measurably false:** if `arb.decision` events start
showing `insufficient_live_cash` skips at a meaningful rate while gaps are clearing,
capital has become the constraint and merge earns its cost. Until then this item
stays open as a recorded defect, not as scheduled work.

**Verified 2026-09-08:** On-chain `eth_call` and Polymarket Data API balance check
confirmed: Signer EOA `0x2FA8…125d` holds **0 tokens**, while Deposit Safe `0x77AD…d8B0`
holds 100% of ERC-1155 outcome tokens. Any future merge implementation must use the
`@polymarket/builder-relayer-client` path.

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

### 68. Near-miss: filtering the wallet scan would have booked real losses as phantoms ✅ CAUGHT BEFORE MERGE

**2026-09-09.** Two resolved 27-August tokens (worth $0.00) were showing in the
positions table with a stale −$15.24, and a `Dump` button that could not work —
`/api/poly/sell-pm` sells on the CLOB and those books are gone. The display fix was
correct. A second change, made at the same time, was not.

**What was proposed:** filter `readiness.positions` inside `checkReadiness`, on
`redeemable && currentValue < 0.01`, so the readiness summary would read
`0 open position(s)` instead of counting the dead tokens.

**Why that is wrong.** `readiness.positions` is not a display feed — it is the bot's
ground truth for *does the wallet actually hold this*. Two live exit paths gate on it
through `pmSharesForPosition` (`bot.ts:1350`, which reads `row.size`):

```
bot.ts:2464   early-SL   pmShares = pmSharesForPosition(pos, readiness.positions)
bot.ts:2865   exit path  if (!(pmShares > 0)) → reconcileLiveGhostPosition(...)
```

An **absent** row means "you never held it", and `reconcileLiveGhostPosition`
(`bot.ts:1355-1367`) acts on that reading:

```js
position.closed     = true;
position.exitReason = 'sync_stale';
position.exitPrice  = Number(position.currentPrice || position.entryPrice || 0);
position.unrealizedPnl = 0;
```

A resolved *losing* token is **present** with `size > 0` and `currentValue = 0`.
Filtering it out makes it look absent, so a real loss closes at **entry price with
zero PnL** — silently. The two states the reconciler exists to tell apart:

| wallet row | meaning | correct action |
|---|---|---|
| present, value $0 | held it, it lost | book the loss at $0.00 |
| absent | never held it | phantom, clear the row |

The filter collapses them. It also trades a loud failure for a quiet one: before it,
a resolved token made the bot attempt a sell that failed visibly; after it, the bot
writes a wrong number and logs nothing.

**Severity if it had shipped:** latent, not active. `forceArbOnly` mutes directional,
and arb legs are hold-to-settle with no stop (`bot.ts:519-521`), so neither trigger
site fires often today. It arms the moment directional is re-enabled.

**Resolution.** Ground truth left whole; the summary line filters a local copy
(`readiness.ts:285-303`). Two invariants added in `tests/unit/readinessCache.test.ts`
— a resolved zero-value position survives into `readiness.positions`, and the
operator-facing line still counts only unresolved ones. Mutation-checked:
reintroducing the filter fails the first with `expected [ 'token-live' ] to deeply
equal [ 'token-dead', 'token-live' ]` while the second still passes, which is what
proves the two concerns are actually separated.

**Why this is recorded rather than just fixed.** It is the CLAUDE.md opening rule
almost exactly — fluent, plausible, reviewed, `tsc` clean, 457/457 green, and wrong
in the reconciliation layer. The tests passed because nothing covered the property.
The display half of the same change was correct and was kept; the lesson is the
boundary, not the author.

### 69. A deleted variable blanked the whole dashboard — and nothing could have caught it ✅ FIXED

**2026-09-09.** The terminal rendered a black page after login. The bot process was
healthy throughout: `/api/auth/login` returned `operator`, `/api/poly/state?lean=1`
returned 112 KB of well-formed JSON, and every field the dashboard calls an array
method on was the right type.

**Cause.** Commit `555ca01` (the item 68 display filter) replaced the
`openPositions` line and deleted the line below it as collateral:

```diff
-  const openPositions = poly.positions || []
+  const openPositions = (poly.positions || []).filter(
+    (p) => !(p.redeemable && Number(p.currentValue ?? 0) < 0.01),
+  )
   const botPositions = poly.botPositions || []
-  const pending = poly.pendingTrades || []        ← collateral deletion
   const openBot = botPositions.filter((p) => !p.closed)
```

`pending` is still read at `PolyDashboard.tsx:1198, 1288, 1368, 1370, 1454`. First
render hit `pending.length` → `ReferenceError: pending is not defined`. Fixed by
restoring the declaration.

**This is item 49 a second time** — "a deleted variable shipped to live and crashed
every live-mode portfolio read". Same shape: a binding removed while editing an
adjacent line, invisible to the toolchain, found only by loading the page.

#### Why four layers all missed it

| layer | why |
|---|---|
| `tsc --noEmit` | `tsconfig.json:35` **excludes `frontend`** — the root typecheck never reads this file |
| the file itself | `// @ts-nocheck` on line 1 |
| `vite build` | bundlers do no undefined-variable analysis; a bare identifier is legal JS |
| `oxlint` | the script existed (`frontend/package.json:10`) but ran in no pipeline, and `no-undef` was not enabled |

The frontend had **no static check whatsoever** on the file being edited. Human
review missed it too, twice: the diff was read for what it *added* and not for what
it *removed*, two lines away.

#### Why the failure was silent

`main.tsx` rendered `PolyDashboard` bare. React unmounts the tree on an uncaught
render error, `#root` empties, and `index.html`'s inline `background: #000000`
paints the result black — indistinguishable from "still loading" or "logged out".
Diagnosis took a full session of eliminating the server, the assets, the cache and
the auth layer before the error was even visible.

#### Resolution

1. **`frontend/src/ErrorBoundary.tsx`** (new), wired in `main.tsx`. Renders the
   error and component stack on screen with a reload button, and states that the
   bot process is unaffected. It located this bug in minutes once installed.
2. **`no-undef` enabled** in `frontend/.oxlintrc.json`, with `env.browser` /
   `env.es2024` so `window` and friends are not false positives.
3. **`lint:frontend` added to `ci`** — `npm run typecheck && npm run lint:frontend
   && npm test && npm run test:perf`.

Verified by mutation, not assumption: with the declaration restored, lint exits 0
with zero `no-undef`; with it deleted again, lint exits 1 and names
`'pending' is not defined` at `PolyDashboard.tsx:1198`. 459/459 tests, `tsc` clean.

**Open follow-up.** `@ts-nocheck` at the top of `PolyDashboard.tsx` still disables
type checking on a 2,900-line file, and `typecheck:frontend` exists but is not in
`ci` either. Removing the pragma is a large mechanical job and is not this item;
adding `typecheck:frontend` to the pipeline first would at least cover the files
that are already clean.

---

### 70. The WS book maintainer reported no ask on a book 1,386 shares deep ✅ FIXED

**2026-09-09/10.** The first live arb canary placed nine orders across BTC and
ETH over ~6 hours. **Every one was rejected.** Cash never moved from $275.16.

```
❌ LIVE BUY FAILED BTC: CLOB FOK buy $4.01 @<=0.73: order couldn't be fully filled.
❌ LIVE BUY FAILED ETH: CLOB FOK buy $2.42 @<=0.45: order couldn't be fully filled.
❌ LIVE BUY FAILED BTC: CLOB FOK buy $0.21 @<=0.04: invalid amount ($0.21), min size: 1
```

The obvious reading is thin depth, and it is wrong. A REST read of the book —
`GET /book?token_id=…` — returned **1,386 shares resting at $0.97**, 1,517 at
$0.98, 9,722 at $0.99, against bids at $0.02/$0.01. The book was deep. The bot
was bidding a price nothing rested at.

**Cause.** `clobWs.ts` maintained `bestBid`/`bestAsk` as two bare scalars,
carried forward across deltas. Two scalars cannot answer "what is underneath the
top level", so a `price_change` removing the best ask set it to `null` even with
size still resting one tick down:

```js
} else if (side === 'SELL' || side === 'ASK') {
  if (!Number.isFinite(size) || size <= 0) {
    if (bestAsk === price) bestAsk = null;      // ← no next-best to fall to
  } else if (bestAsk == null || price <= bestAsk) {
    bestAsk = price;
  }
}
```

**A theory that the evidence killed.** The first diagnosis was a *ratchet* —
that `bestAsk` could only move downward and was locked at a stale low. Two of
the five tests written to demonstrate it **passed**: a worse ask does not
overwrite a better resting one, and a re-quote above a removed level *is*
accepted. The lock does not exist. What exists is the `null`, and the null is
enough. Recorded because the wrong theory was fluent and would have produced a
fix aimed at the wrong line.

**Fix.** `clobWs.ts:35-73` — a per-level `Map<price, size>` per side per token,
keyed as integer ten-thousandths (prices are tick-aligned; float keys make
`delete` unreliable). Best-of-book is *derived* from the map on every update
(`bestOf`, `:50`), never carried forward. `setClobMarketTokens` prunes level
maps for unsubscribed tokens, since windows rotate every 5 minutes and the maps
would otherwise grow without bound over a multi-day run.

`tests/unit/clobWsBook.test.ts` — 6 invariants. `upsertFromBook` and
`applyPriceChange` are exported as a test seam; this layer had no coverage
because reaching it required a live WebSocket, same problem and same remedy as
`buildSyncFrame` in item 65. Mutation-verified: inverting `bestAskOf` to pick the
highest resting ask kills 3 tests; dropping the `size > 0` filter in `bestOf`
initially killed **none** — the delta path deletes zero-size keys, so only a
snapshot row can carry a zero into it — which is why `ignores zero-size rows
carried in a snapshot` exists.

### 71. `upAsk` was a midpoint, and the gap filter selected for it ✅ FIXED

**Where item 70 became money.** `arbEngine.ts:54` read:

```js
const upAsk = Number(depth?.up?.bestAsk || prices?.up || 0);
```

`prices.up` is **not an ask**. `clob.ts:118` assigns it `wsMid`. So the moment
the book maintainer had no ask, a midpoint was substituted into a variable named
`upAsk` — and that number becomes the `maxPrice` of a live fill-or-kill order at
`bot.ts:1011`.

```
clobWs.ts:86     top ask removed              →  bestAsk = null
clob.ts:180      `bestBid || bestAsk` truthy  →  WS branch taken anyway
clob.ts:183      `wsBook.bestAsk || 0`        →  emits 0
arbEngine.ts:54  `0 || prices?.up`            →  substitutes the MID
bot.ts:1011      maxPrice: entryPx            →  FOK signed at the mid
```

**This is worse than a bad price — the gate selects for it.** With the fallback
on one leg:

```
computed_sum = mid_up + ask_down = (ask_up − spread_up/2) + ask_down
             = true_sum − spread_up/2
```

so the "gap" is half the spread of whichever leg fell back. The wider the
spread, the larger the phantom edge, the more attractive the opportunity looks.
The detector was **biased toward the most broken books it could find**, which is
why the failure rate was 100% rather than intermittent. Back-solving the live
log (`shares = budget / sum`) gives implied sums of 0.910–0.952 against true
sums of ~1.00 — spreads of 0.10–0.18, ordinary for a 5-minute window. The 4¢
BTC leg is the midpoint of a book quoted bid 0.01 / ask 0.07.

**Fix.** `arbEngine.ts:73` reads `prices?.upAsk` / `prices?.downAsk` — which
`clob.ts:120` has published all along and **nothing in the repo ever read** —
and refuses when neither source yields an ask. No ask → no trade. An arb leg
cannot be priced off anything but an ask.

### 72. `getDepthForMarket` laundered a missing ask into a real-looking `0` ✅ FIXED

`clob.ts:171` gated the WS branch on `(wsBook.bestBid || wsBook.bestAsk)`, so a
book with a bid and no ask still took it, and `bestAsk: wsBook.bestAsk || 0`
turned the absence into a number. Every downstream consumer sees a `0` it cannot
distinguish from a real quote. Fixed at `clob.ts:180-184`: both sides required,
no coercion — fall through to the REST branch, which returns a full
`normalizeLevels` book, or return nothing, which is the honest answer.

**Still open (structural).** The two branches return **different shapes**: the WS
branch emits `{bestBid, bestAsk, mid, spread, source}` with no `bids[]`/`asks[]`,
while the REST branch returns the full ladder with per-level `size` and `cum`.
Any depth-aware consumer written against `depth.up.asks[0].size` is reading
`undefined` on the live path. This blocks any future depth-aware sizing and
should be unified before that is attempted. Note the tension: falling through to
REST more often costs metered proxy bandwidth (items 57–64), though after item 70
a null ask should be rare.

### 73. Arb legs have no minimum-notional gate, and the abort log lies ✅ FIXED

**Two separate defects, both from the same live run.**

**(a) No $1 leg-notional gate.** `arbEngine.ts:452` passes `minShares: 1`, so the
floor at `trade.ts:364` (`max(amountUsd, minShares * px)`) evaluates to $0.13 on
a 4¢ leg and does nothing. The exchange rejects it: `invalid amount for a
marketable BUY order ($0.21), min size: 1`. The bot should skip the package
rather than send an order it can know is invalid.

The three constraints are one gate, not three patches — and they can be mutually
unsatisfiable, in which case the answer is *skip*:

```
shares ≥ 1 / min(upAsk, downAsk)         ← notional floor, pushes size UP
shares ≤ min(upAskSize, downAskSize)     ← depth ceiling, pushes size DOWN   (blocked on item 72)
shares ≤ budget / (upAsk + downAsk)      ← budget ceiling, pushes size DOWN
```

Treating them independently is actively dangerous: capping to available depth
alone can push the *cheap* leg under $1, which fills leg one and rejects leg
two — the unhedged position the package design exists to prevent (2026-08-28,
−$12.83).

Consequence for config: with `arbMaxUsd: 5`, no book with a leg under ~$0.20 is
tradeable at all, because 5 shares is the most the budget buys. A 4¢ leg needs
25 shares — a **$24.50** package — since share parity, not dollar parity, is what
makes a set redeem to $1.00.

**(b) `arbEngine.ts:411` logs `emergency unwound filled leg` unconditionally**,
while the unwind at `:403-407` only runs when *exactly one* leg filled. Every
abort in the live run printed it with nothing filled and nothing unwound. Also
`:401`: UP executes first and DOWN only runs `if (upShares > 0)`, so `DOWN=FAIL`
conflates "rejected" with "never attempted". The ordering is correct — it is
what kept the run at zero risk — but the log misreports it.

**Fix — the unified gate.** `arbEngine.ts:186-250` computes the three bounds
together and resolves them once. Rounding is directional: `Math.floor` onto the
3-decimal share grid so no ceiling is re-breached, then `Math.ceil` up to the
floor — rounding *to nearest* at the floor shaves a cheap leg from $1.00 to
$0.999, which the exchange rejects.

**Gate order is load-bearing: money first, microstructure second.** The
affordability gate keeps its position ahead of all three, and `depthShares`
falls back to `Infinity` when unknown purely so sizing can reach it. An account
that cannot fund the trade is refused as `insufficient_*_cash` whatever the book
looks like; putting the new gates first silently usurped that code and broke the
item 62 invariant, which is how the ordering was found.

Four skip codes, so the dashboard can tell the cases apart — during the
2026-09-09 run all four were indistinguishable from a generic rejection:

| Code | Meaning |
|---|---|
| `depth_unknown` | no `bestAskSize` from either source — absent is not infinite |
| `depth_below_min_size` | top-of-book cannot cover the $1.00 floor |
| `budget_below_min_notional` | `arbMaxUsd`/`arbBankrollFrac` cannot reach $1.00 on the cheap leg |
| `leg_below_min_notional` | dollar-denominated backstop against share-grid rounding |

**Depth plumbing (closes the operative half of item 72).** `clobWs.ts` publishes
`bestBidSize`/`bestAskSize` off the item 70 level maps, and `normalizeLevels`
publishes the same two scalars, so both branches of `getDepthForMarket` hand the
gate one field name. Only *top-of-book* size is published, and that is not a
shortcut: `maxPrice` is signed at exactly the best ask (`bot.ts:1011`), so every
deeper level is priced out of reach and cannot fill. The full-ladder shape
mismatch in item 72 remains open for anything that needs more than top-of-book.

**(b)** `arbEngine.ts:481-511` — `DOWN=NOT_ATTEMPTED` replaces `DOWN=FAIL` when
UP never filled, and the unwind suffix is conditional on an unwind having run
(`unwound` also lands in the event payload).

**Tests.** `tests/unit/arbSizingGate.test.ts` — 7 invariants stated over the
*pair*, so no future edit can satisfy a ceiling by breaching the floor.
Mutation-verified, six mutations, all killed: dropping the floor lift (2),
`MIN_LEG_NOTIONAL_USD = 0` (2), unknown-depth skip disabled (1), depth ceiling
gate removed (1), budget gate removed (1), depth dropped from the sizing `min`
(1). The 24 pre-existing arb fixtures gained `bestAskSize: 5000` — deep enough
that depth is not the constraint under test in files testing parity and fees.

### 74. Nothing stops a losing arb loop — the breakers exempt it, and there is no session cap ✅ FIXED (a + b)

**Found 2026-09-10** while answering "can I leave this running overnight?". The
answer is no, and the reason is not the sizing gate — it is that if the gate is
wrong, **no mechanism in the bot would stop it.** Two independent gaps.

**(a) `holdsToSettlement` cannot tell a hedged pair from an orphaned leg.**

```js
// positions/policy.ts:108-110
function hasHedgeMarkers(posOrPlan) {
  return !!(posOrPlan?.packageId || posOrPlan?.isArbLeg || posOrPlan?.arb);
}
```

Every one of those markers **survives the abort**. A leg that filled while its
complement was killed — and whose `unwindLeg` then failed (`arbEngine.ts:485-492`
logs and continues) — still carries `packageId` and `isArbLeg`, so
`holdsToSettlement` returns `true` and it is exempt from every risk exit that
consults it:

| Site | Exit it skips |
|---|---|
| `bot.ts:2802` | portfolio max-drawdown close (`if (holdsToSettlement(op)) continue;`) |
| `bot.ts:2776` | mid-window exits |
| `bot.ts:1916` | exit management (stop-loss, trailing, TP) |
| `bot.ts:408` | overdraft repair |

The exemption is **correct for a real pair** — a hedged set redeems to exactly
$1.00 and force-closing mid-window forfeits the edge and books the spread, which
is what the comment at `bot.ts:2800-2801` says. But it is applied on a
*structural marker*, not on whether the hedge exists. So the single position that
most needs closing — a naked directional leg the operator never intended to
hold — is the one position guaranteed to ride to settlement untouched. That is
the exact shape of the 2026-08-28 −$12.83 loss.

The information to tell them apart already exists and is not consulted:
`pkg.legs.up.filled` / `pkg.legs.down.filled` (written unconditionally at
`arbEngine.ts:296-299`, item 27) and `pkg.residualShares` / `pkg.residualOutcome`
on the parity-breach path. The fix is for the exemption to require a *live
complement*, not a marker. Belongs with the D4 position manager, which is what
would own "is this leg still hedged".

> **(a) FIXED 2026-09-15.** `hedgeIsIntact` + a `context` parameter on
> `holdsToSettlement` (`positions/policy.ts`), supplied at the three risk-exit
> call sites in `bot.ts`. 10 invariant tests in
> `tests/unit/nakedLegExits.test.ts`, 7 mutations killed.
>
> **The exemption now belongs to the hedge, not to the label.** A leg is immune
> from mid-window exits only while its pair actually exists. Positive evidence
> that it does not — the package is `ABORTED` **and** no live sibling on the
> opposite outcome remains — withdraws the immunity and the position becomes
> exit-managed like any other directional holding.
>
> `ABORTED` alone is deliberately not enough: a package can abort with both legs
> held (the parity-breach path does exactly that), and force-closing a real pair
> is the expensive error.
>
> **Every "cannot tell" still returns exempt, and that is not timidity.** The
> two errors are asymmetric, and the asymmetry runs opposite to intuition:
>
> | error | consequence |
> |---|---|
> | wrongly **expose** an intact pair | a stop loss closes one side, forfeits the locked edge, and **manufactures** the naked leg this item exists to prevent |
> | wrongly **exempt** a naked leg | one unmanaged directional position — which is what we had before this fix |
>
> The first error *creates* the problem; the second merely fails to fix it. So an
> absent package record, a missing context, a `PENDING_FILL` mid-dispatch and a
> marker with no package key all stay exempt.
>
> **Call sites updated** (the ones that decide "may this position be closed
> now"): the fast stop-loss (`scanOpenExitsFast`), the portfolio drawdown close,
> and in-scan exit management. Deliberately **not** updated: `manager.ts:69` and
> the paper-cash unwind, which ask "is this engine exit-managed" rather than
> "may this position be closed", and where the marker-only reading remains
> correct. The context parameter is optional precisely so that distinction stays
> visible in the code rather than being flattened.
>
> **Operational consequence:** a naked leg now gets a stop loss. Combined with
> item 80 (fewer naked legs created) and item 74b (a cap on what a loop can
> cost), the 2026-08-28 failure — 26.33 DOWN shares, sibling killed, exempt from
> every exit, expired at zero for −$12.83 — now has three independent things
> that would each have caught it.


**(b) No cumulative loss cap of any kind.**

- `maxArbPackages` caps **concurrent** packages, not attempts. An aborted package
  frees its slot immediately (`getActivePackages`, `arbEngine.ts:139-145`), so a
  systematic defect can fail → unwind → retry every window indefinitely.
  `maxArbPackages: 1` bounds a single package's size; it bounds nothing about a
  night of them.
- The **governor drawdown breaker forces the profile to `arb-only`**
  (`governor.ts:387-406`). If arb is the strategy losing money, the breaker aims
  the bot harder at it.
- The **portfolio drawdown breaker** (`bot.ts:2782-2799`) measures unrealised
  loss on *open* positions. Repeated small realised losses — abort, unwind,
  spread — never accumulate into an open-position drawdown, so it never fires.

`grep` for `maxDailyLoss|dailyLoss|lossLimit|circuitBreak|killSwitch|maxLossUsd`
across `src/` returns nothing. There is no session-level or daily brake.

> **(b) FIXED 2026-09-14.** `src/polymarket/lossCap.ts`, gated at
> `bot.ts:executePendingTrade` (both engines) and `arbEngine.ts:60` (per-scan
> snapshot), governor loop broken at `governor.ts:387`, 14 invariant tests in
> `tests/unit/lossCap.test.ts`, 8 mutations killed.
>
> **Design, as decided with the operator:**
>
> | decision | choice |
> |---|---|
> | basis | realised P&L net of fees, rolling 24h |
> | trip action | halt **all** new entries, both engines |
> | governor | suppress the arb-only forcing while tripped |
> | persistence | survives restart; explicit operator reset |
>
> **Derived, not counted.** The cap reads closed trades rather than
> incrementing a tally. A counter is a second source of truth that drifts from
> the ledger the moment anything is replayed, deduped or reconciled — silently,
> and in the direction of not firing. Deriving also makes it restart-proof for
> free: the trades outlive the process, so a crash-loop cannot wipe the window.
> What persists is the *reset marker* (`zinger.db`, key `loss_cap_reset`), not
> the figure — the window is `max(now − 24h, resetAt)`.
>
> **The governor loop is the part that was not just a missing feature.** While
> the cap is tripped no new entries happen anyway, so the profile switch is
> cosmetic *at that moment*. The damage is later: the profile would still read
> `arb-only` when an operator clears the cap, so trading resumes aimed at the
> engine that caused the loss without anyone having chosen that. The breaker now
> holds the profile and records `breaker_suppressed` with the reason.
>
> **Defaults.** Live `maxDailyLossUsd: 10` — about 3.6% of the ~$278 balance,
> and at live `arbMaxUsd: 1` that is dozens of consecutive losing round trips
> rather than one bad trade, which is the failure shape this exists for. Paper
> ships at `0` (disabled) **on purpose**: a paper run exists to find out how bad
> a defect gets and to produce the distribution that sizes the live dials, and a
> brake there truncates the evidence it is being run to collect. `0` disables
> stopping, never reporting — `lossCapStatus` still computes the loss.
>
> Reset: `POST /api/poly/trading/resume`. Deliberately separate from
> `/api/poly/arb/resume` (item 80): one says "I checked a leg whose fate was
> unknown", the other says "I accept the last 24 hours of losses". Collapsing
> them would let an operator dismiss the second while intending only the first.
>
> **Status visible at** `getState().limits.lossCap`, reported whether or not it
> has fired — `remainingUsd` is the number worth watching before it does.
>
> **(a) remains open.** `holdsToSettlement` still exempts a naked leg from every
> risk exit on a structural marker rather than on whether the hedge exists.


**Operational consequence, stated plainly:** live arb should not run unattended
until (b) exists. Paper mode exercises the identical sizing gate — `mode` only
selects the bankroll source and whether orders reach the exchange — so an
unattended overnight run belongs in paper, where it also yields the skip-code
distribution needed to set `arbMaxUsd` from evidence rather than arithmetic.

### 75. `arb.decision` is unrecoverable after ~45 minutes — the ring buffer is its only sink ✅ FIXED

**Found 2026-09-10**, forensics on the overnight paper run
(`docs/overnight-paper-forensics-2026-09-10.html`). The run existed to produce a
skip-code distribution. It did not produce one.

The telemetry bus is a bounded in-memory ring and nothing else:

```ts
// telemetry/events.ts:28
export const DEFAULT_EVENT_BUFFER_CAP = Number(process.env.EVENT_BUFFER_CAP) || 30_000;

// telemetry/events.ts:423-427
this.buffer.push(event as BaseTelemetryEvent);
if (this.buffer.length > this.maxCap) {
  this.buffer.shift();   // Evict oldest
  this.evicted += 1;
}
```

The export showed **`evicted: 354266`**. At 11.06 events/s a 30,000-slot buffer
retains ~45 minutes, so a 9-hour run yielded 90 seconds of history. Roughly 80%
of all events are `gap_below_breakeven` (`arbEngine.ts:133`) — the code that
fires on every market on every scan that finds nothing.

**Read the right field.** `dropped` and `hasMore` were both correctly `false`;
`evicted` (`events.ts:350`, surfaced at `server.ts:687`) is the field that
carries the loss. A consumer checking only the first two concludes the export is
complete.

**Ten skip codes exist, and a sink must not whitelist two of them.**
`arbEngine.ts:133` `gap_below_breakeven`, `:152` `gap_below_operator_floor`,
`:161` `package_capacity_full`, `:168` `package_already_on_slug`, `:260`
`insufficient_paper_cash`/`insufficient_live_cash`, `:277` `depth_unknown`,
`:287` `depth_below_min_size`, `:296` `budget_below_min_notional`, `:312`
`leg_below_min_notional`, plus `'open'` at `:338`.

`depth_unknown` is the one that must survive the filter regardless of volume: it
is the regression canary for item 70. If the per-level WS book maps ever go back
to publishing no ask, that code is the signal, and a sink that keeps only the
budget and depth codes would show nothing at all.

**Interaction with item 77.** Raising `minArbGap` moves the noise floor from
`gap_below_breakeven` to `gap_below_operator_floor` (`:152`) — the same volume
under a different code. A *whitelist* survives that change; a blacklist of
`gap_below_breakeven` would silently begin recording ~350k rows a night. The
sink must whitelist deliberately, and must keep a periodic **count** of what it
suppressed, or the denominator is lost and no skip *rate* can ever be computed.

**Placement.** `data/zinger.db` already has an open WAL handle and a data
directory contract (`sqliteStore.ts:65` `DB_PATH`, `:72` `getDb()`,
`ZINGER_DB_PATH` to relocate). A second `.db` file would be a second backup
target and a second thing to point at a VPS volume. The existing `docs` table is
key/value (`:80`), so an append-only decision log is a new table shape either
way — it belongs in the same file.

**What shipped.** `telemetry/decisionSink.ts`, subscribed at `index.ts` (not in
`createApp()`, so building the app in a test attaches no writer to the
operator's `zinger.db`). Two tables in the existing DB:

- `arb_decisions` — one row per actionable decision, extracted columns for
  querying plus the verbatim payload for questions nobody has thought of yet.
- `arb_decision_counts` — hourly `(bucket, code, mode)` counts.

Persisted codes are **also** counted, so `rows + counts` reconstructs the true
event total whatever the whitelist says. `'open'` is never throttled and never
merely counted — that record has to reconcile against the cash ledger. Other
persisted codes get one row per `(code, slug)` per `ARB_SINK_THROTTLE_MS`
(default 300s, one per window rotation); the duplicates are counted, so a
condition that persists for hours reads as a series, not a stale single row.
Retention `ARB_SINK_RETENTION_DAYS` (default 90), pruned at startup.

11 tests, `tests/unit/arbDecisionSink.test.ts`. Mutation-verified, seven
mutations, all killed: persisted codes not counted (4 tests), throttle disabled
(3), throttle key dropping slug (1), `open` routed through the throttle (2),
unknown code dropped (1), `depth_unknown` off the whitelist (1), local `catch`
removed (1).

**One test had to be rewritten — it passed against its own bug.** "absorbs a
write failure instead of throwing" asserted only `not.toThrow()`, which the bus
already guarantees for every subscriber (`events.ts:393-408`) — deleting the
sink's own `catch` left it green. What the local handler actually adds is
*attribution*: a fault counted against the sink by name rather than one
anonymous subscriber error. The test now asserts that, and the mutation dies.

The last test in the file is the only one that drives a real package through
`detectAndExecuteArbPackage` rather than hand-building the payload. Renaming
`sizing` → `sizingInfo` on the producer leaves all ten synthetic tests green and
kills exactly that one, which is the point of it: it is the producer/consumer
contract, and without it a rename would ship a sink writing NULL columns.

---

### 76. The depth gate asks for 100% of top-of-book, the most race-prone size available ✅ FIXED

**Found 2026-09-10.** Sizing takes every resting share at the best ask:

```js
// arbEngine.ts:230
const depthShares = depthKnown ? Math.min(upAskSize, downAskSize) : Infinity;
// arbEngine.ts:238
let shares = Math.floor(Math.min(budgetShares, depthShares) * 1000) / 1000;
```

Orders are fill-or-kill and `maxPrice` is signed at exactly the best ask
(`bot.ts:1011`), so only top-of-book is reachable — established in item 73. A
request for 100% of that level therefore has zero tolerance: one other
participant taking a single share leaves the level short, the FOK cannot fill in
full, and the whole package dies. **10 of the 15 sampled packages in the
overnight run were sized this way.**

**What this item is not.** The 2026-09-09 run's nine rejections were *not* this.
Root cause was a midpoint reaching `maxPrice` (items 70/71). **No size-race kill
has ever been observed on this bot**, in paper or live — paper fills by
definition and the one live attempt failed earlier in the chain. A utilisation
factor is therefore a *hypothesis*, cheap to hold and not yet evidence-backed.
It ships as a named constant with that stated, and item 75's sink records
requested-vs-available size on every attempt so it can eventually be measured.

**Two implementation traps.**

- The factor belongs at `:230`, on `depthShares` itself. Applying it inside the
  `Math.min` at `:238` would size at 90% while the skip gate at `:282`
  (`if (shares > depthShares)`) still tested against 100% — the gate would never
  fire and the clamp would be invisible in telemetry.
- Rounding stays on the **3-decimal share grid** (`:238`). Flooring the clamped
  depth to whole shares is a second, unrelated behaviour change.

**Expected cost.** On deep books the budget binds and nothing changes. On thin
books this converts some fills into `depth_below_min_size` skips — intended, as
those are exactly the race-prone ones — which means it compounds with any
`minArbGap` raise. The two cannot be estimated independently and multiplied.

**What shipped.** `DEPTH_UTILISATION = 0.90` at `arbEngine.ts:214+`, applied on
the ceiling at `:256-257`: `restingShares` is what the book shows, `depthShares`
is what this bot will ask for. Both the sizing `min` and the
`depth_below_min_size` gate read the same clamped value, so the gate still
fires. `arb.decision` now carries `restingShares`, `depthShares` and
`utilisation` on both the open and the skip, which is what makes the constant
falsifiable later.

`boundBy` is now decided at the sizing site (`sizeBoundBy`) rather than derived
at the emit site. The obvious derivation, `shares >= depthShares`, reads *false*
whenever the 3-decimal share grid shaves a fraction off — so a depth-bound
package reported itself budget-bound. Caught by mutation, not by review.

6 tests, `tests/unit/arbDepthUtilisation.test.ts`. Mutation-verified, five
mutations, all killed: clamp removed (5 tests), `DEPTH_UTILISATION = 1.0` (5),
`boundBy` derived naively (1), integer share grid instead of 3-decimal (1), and
the documented trap — clamp moved inside the sizing `min` so the skip gate still
compares against 100% (2, via the "refuses a book that only clears the floor at
100% depth" case).

**Still a hypothesis.** Nothing here is evidence that a size race was ever
killing orders. Item 75's sink records requested-vs-available on every attempt;
revisit the constant once a live run has produced fills to measure against.

---

### 77. Raising `arbMaxUsd` alone cannot raise the arb budget — `arbBankrollFrac` binds first

**Found 2026-09-10**, checking a proposal to lift live `arbMaxUsd` $5 → $15 to
"unlock trades down to 7c".

```js
// arbEngine.ts:178-184
const shareBudget = Math.max(
  Number(cfg.minPositionSize ?? 0.5) * 2,
  Math.min(
    arbBank * Number(cfg.arbBankrollFrac ?? 0.10),
    Number(cfg.arbMaxUsd ?? 50),
  ),
);
```

The two caps are a `min`, so the smaller wins. Live is `arbBankrollFrac: 0.03`
(`modeConfig.ts:163`) against a $275.16 balance:

| `arbMaxUsd` | `arbBank × frac` | `shareBudget` | cheapest reachable leg |
|---|---|---|---|
| $5 (today) | $8.25 | **$5.00** | `sum/5` ≈ 19c |
| $15 | $8.25 | **$8.25** | `sum/8.25` ≈ 11.5c |
| $15 + frac 0.0545 | $15.00 | **$15.00** | `sum/15` ≈ 6.3c |

The floor follows from item 73: the package needs `budgetShares ≥ floorShares`,
i.e. `shareBudget/sum ≥ $1.00/cheapAsk`, so `cheapAsk ≥ sum/shareBudget`.
Raising `arbMaxUsd` to $15 buys $8.25 and an 11.5c floor, **not the 7c the
proposal assumed**. Both dials have to move together, and they are not
interchangeable: `arbBankrollFrac` scales with the wallet, `arbMaxUsd` is a flat
backstop that stops the fraction running away as the balance grows. The
validator ceiling is $50 (`modeConfig.ts:360-362`), so neither value is near a
guard.

**Not scheduled.** This is sizing, and it is gated behind item 74(b): it raises
per-package exposure on a system where **no live arb order has ever filled**
(9/9 rejected, 2026-09-09) and where no session loss cap exists. Sequence is
item 75 (measure) → 76 (fill probability) → 74(b) (brake) → one attended live
fill → then this.

---

### 78. The arb order is sized in shares and submitted in dollars, and the round trip does not close ❌ CLOSED 2026-09-16 — WON'T FIX

**CODE REMOVED 2026-09-16.** `placeLimitFokBuy`, `venueShareCount`,
`VENUE_SHARE_DECIMALS`, the `arbExactShareRouting` flag and its branches in
`bot.ts`, `scripts/probe-limit-fok.ts` and `tests/unit/arbExactShareRouting.test.ts`
are deleted — recoverable from `7ae2450`. A stored VPS config may still carry
`arbExactShareRouting: true`; `normalizeConfigStore` → `pickStrategy` drops
unlisted keys on every load path (`bot.ts:214, 220, 4442`), so it is inert.

**CLOSED.** The share-denominated route is abandoned; `arbExactShareRouting`
stays `false` permanently. The unit round-trip described below is real, but it
was measured at **~0.014 shares per package** (worst case $0.09, total worst-case
stranded value **$0.25** across all 21 canary packages) — and every route that
removes it costs more than that. See item 89 for the measurement and the
decision. Everything from here down is retained as the record of why, not as
work to be picked up.

**Found 2026-09-11** in `docs/live_canary_packages.json` (21 live packages,
2026-09-09 → 2026-09-11, all ABORTED, no leg ever filled).

The sizing gate (item 73) computes a **share** count against a **share** depth
ceiling. The order is then submitted as a **dollar** amount, and the exchange
converts it back to shares at the signed price:

```
arbEngine.ts:238   shares   = floor(min(budgetShares, depthShares) * 1000)/1000
arbEngine.ts:276   costUp   = Math.round(shares * upAsk * 100) / 100    ← to NEAREST cent
arbEngine.ts:597   plan.sizeUsd = cost
bot.ts:1011        placeMarketBuy({ amountUsd: plan.sizeUsd, maxPrice: entryPx })
trade.ts:364       amount   = Math.round(max(amountUsd, minShares*px) * 100)/100
                   → SDK: rawTakerAmt = rawMakerAmt / rawPrice   (shares demanded)
```

The last step is confirmed against vendored SDK source in
`research/polymarket-domain-facts.md` §7: for a BUY, `getMarketOrderRawAmounts`
sets `rawTakerAmt = rawMakerAmt / rawPrice`, and both are `parseUnits(…, 6)`
into the signed order — **the share count is cryptographically committed to
`amount / price`, not to the number the sizing gate computed.**

`Math.round` at `:276` is round-to-*nearest*, so the committed share count lands
either side of the planned one. Measured across all 21 packages:

| | packages | worst case |
|---|---|---|
| demanded **more** shares than planned | 14 | +0.0950 (2026-09-10 00:53) |
| demanded **exactly** the planned count | 1 | 0 |
| demanded **fewer** shares than planned | 6 | −0.0059 |

Worked example, the 2026-09-11 06:27 BTC package: `shares 4.500 × $0.59 =
$2.655`, rounded to `$2.66`, committed as `2.66 / 0.59 = 4.5085` shares. If that
package was depth-bound at 4.500 the book was 0.0085 shares short and the FOK
had to die.

**The defect is the unit change, not the rounding.** Flooring the cents would
bias the error one way; it would not make the submitted share count equal the
computed one, because a 2-decimal dollar amount divided by a 2-decimal price is
not generally a 3-decimal share count. The structural fix is to stop round
tripping — submit the arb leg by share count against a limit FOK, so the number
the depth gate computed is the number that reaches the book. That is an
execution-path change, so it belongs to whoever owns order routing, not to a
patch at `:276`.

**Do not treat this as the explanation for the canary failures — see item 79.**

**VERIFIED AND ENABLED 2026-09-15.** The live probe answered in the venue's own
words, at zero cost — a limit FOK bid far below the market, on a book whose best
ask was $1.00:

```
{ "error":   "order couldn't be fully filled. FOK orders are fully filled or killed.",
  "orderID": "0xf01fbbee3188825dfcaef47e3be2f0a51d4075bb67077d95e9a97b0e9358eeb1",
  "status":  400 }
```

Nothing rested, $0.00 moved. Of the three outcomes specified in advance —
honoured / silently downgraded to a resting order / order type rejected — this is
the first. Recorded as **fact 8** in
`docs/research/polymarket-domain-facts.md`; `arbExactShareRouting` is now `true`
for live.

**Scope limit, because it is easy to over-read.** The probe proves FOK is
honoured when the order **cannot** fill. It does not exercise the branch where a
limit FOK **can** fill — that `roundDown(size, 2)` delivers that exact share
count on a real match is still SDK-source inference. The first live fill is the
observation, and item 79's `requestedShares` records it beside what came back.
`placeLimitFokBuy` still treats a resting response as a failure; that check is
now a contradiction-detector rather than a live hazard, and is kept for exactly
this reason.

**Follow-on: see item 84.** Making kills a correctly-reported outcome exposed
that reconciliation stalls the scan loop for 4.5s on every one of them.

**BUILT 2026-09-14, ORIGINALLY GATED OFF.** `placeLimitFokBuy` + `venueShareCount`
(`trade.ts`), wired at `bot.ts` behind `cfg.arbExactShareRouting`, default
`false` (`modeConfig.ts`). 6 tests in `tests/unit/arbExactShareRouting.test.ts`,
4 mutations killed.

**The mechanism is confirmed from primary source.** The two SDK amount builders
are mirror images:

```js
// getMarketOrderRawAmounts.js — what we use today. Dollars in, shares derived.
const rawMakerAmt = roundDown(amount, roundConfig.size);   // dollars, 2dp
let   rawTakerAmt = rawMakerAmt / rawPrice;                // shares FALL OUT

// getOrderRawAmounts.js — the limit builder. Shares in, dollars derived.
const rawTakerAmt = roundDown(size, roundConfig.size);     // shares, CONTROLLED
let   rawMakerAmt = rawTakerAmt * rawPrice;                // dollars fall out
```

So the fix works, and the 2026-09-11 06:27 package is the worked example:
`$2.66 / 0.59 = 4.5085` shares demanded against a plan of `4.500` — versus
`roundDown(4.500, 2) = 4.50` on the limit route. Zero excess.

**⚠️ WHY IT IS OFF.** `createAndPostOrder` is typed
`OrderType.GTC | OrderType.GTD` in this SDK version (`client.d.ts:127`). FOK on
a limit order is only reachable as `createOrder` + `postOrder(order,
OrderType.FOK)`, which `postOrder`'s signature accepts (`client.d.ts:139`).
**Nothing in this repo or in `docs/research/polymarket-domain-facts.md`
establishes that the exchange honours FOK on a limit order.** A confident
reading of an SDK type is precisely the shape of the Aug 2026 `negRisk`
regression, and the downside is not symmetric: if the venue silently downgrades
FOK to GTC the leg **rests** instead of dying, which is the -$12.83 orphan from
2026-08-28. `placeLimitFokBuy` returns `resting: true` rather than swallowing it,
and the existing cancel-on-rest path at `bot.ts` catches it — but that is a net,
not a verification.

**The zero-cost live probe that settles it.** Post a limit FOK far from the
market — buy 5 shares at $0.01 when the ask is $0.60. Nothing can match, so no
money moves either way. Three possible answers, and item 79's instrumentation
now records which:

| response | meaning |
|---|---|
| accepted, killed unmatched | FOK honoured on a limit order → turn the flag on |
| accepted, **rests on the book** | FOK silently downgraded → do NOT enable; cancel immediately |
| rejected, "unsupported order type" or similar | route unavailable in this SDK version |

Operator's to run; a VPS measurement.

---

### 79. Every live arb leg has been FOK-killed across two code versions, and nothing in the repo explains why ✅ INSTRUMENTED

**Found 2026-09-11.** `docs/live_canary_packages.json`: **21 packages, 21
aborted, zero legs filled, zero orphans, zero capital moved.** Two distinct eras
in one file:

| Era | n | `abortReason` | Notes |
|---|---|---|---|
| 09-09 19:59 → 09-10 01:05 | 14 | `UP=FAIL, DOWN=FAIL` | pre-item-73 label |
| 09-11 00:59 → 09-11 06:27 | 7 | `UP=FAIL, DOWN=NOT_ATTEMPTED` | item 73 labelling live |

Item 73's sequencing holds: **no leg has ever filled, so no orphan has ever been
created.** `legs.up.filled` and `legs.down.filled` are `false` on all 21.

**Why item 78 is not the answer.** The dollar round trip can only kill an order
that demands *more* shares than the book holds. It does not fit the data:

- **6 of 21 demanded fewer shares than planned** and still died — including
  **2026-09-11 01:38 BTC**, which planned 5.263 shares, committed 5.2571, and
  was *budget*-bound (`totalCost` exactly $5.00, so the depth ceiling was not
  binding and the book had slack above the order). An order asking for less than
  planned, against a book with room, was still killed.
- **2026-09-11 04:20 ETH** committed exactly 4.5000 shares — zero excess — and
  died.
- Failures span both code versions, both symbols, both bound types, and three
  days.

That is a systematic failure, not a sizing-precision race. Item 78 explains at
most 14 of 21 and at most 5 of the recent 7.

**What is NOT yet known, and must not be guessed:**

1. Whether the item 76 depth clamp was deployed during the 09-11 run. It is
   committed (`a151ffe`) but the VPS runs its own checkout. If it *was* live,
   the depth-bound orders carried a 10% cushion — 0.5 shares on a 5-share
   level — which dwarfs the ~0.01-share round-trip error and rules item 78 out
   entirely for those. **One `git log -1` on the VPS settles this and nothing in
   this repo can.**
2. The exchange's error string per attempt. All 21 records carry the same
   generic `Leg execution mismatch`; the CLOB's actual response lives in the
   receipt capture (`captureClobCall`, `trade.ts:371`), which is not in this
   export. At least two *different* rejections are known to be mixed into these
   21 — the $0.38 and $0.21 packages (09-09 21:37, 09-10 00:53) are the
   `invalid amount for a marketable BUY order … min size: 1` rejections that
   settled the $1.00 notional fact, **not** FOK kills. The abort reason hides
   the distinction.
3. Book age at submission. The size is computed from a WS snapshot and the order
   crosses a metered Webshare proxy before reaching the matching engine. Nothing
   records the interval between the book read and the order landing, so
   "the level was gone" is currently unfalsifiable.

**Prior art against a structural block:** the 2026-08-27/28 canary *did* fill a
hedged pair (`docs/live-canary-forensic-audit.md`, Episode 2: 27 UP @ $0.58 +
27 DN @ $0.21, +$5.56 net). Fills are possible on this account. Whatever changed
since is in the order path, not in the venue.

**Next step is instrumentation, not another fix.** The receipt capture already
exists; item 75's sink now persists `restingShares`/`depthShares` per decision.
Add the exchange's raw error and a book-age stamp to the package record so the
next attempt produces a diagnosis instead of a fourth theory.

> **SUPERSEDED IN PART, 2026-09-11 — see item 80.** The premise above ("zero
> legs filled") is **false**. On-chain activity shows the 03:38 package's UP leg
> *did* fill, 1.4 seconds after the bot had already aborted it. The question is
> not why nothing filled; it is how many of these 21 "failures" were real.

> **Narrowed, 2026-09-14.** The reconciliation the supersede note calls for has
> now been done, against the corrected chronology. **Exactly one of the 21
> filled.** The wallet's full on-chain history for the canary period is eight
> rows; between 2026-08-28 08:46 and 2026-09-11 03:38 there is nothing at all.
> So "how many of these 21 failures were real" has an answer: **20 of them.**
>
> The mechanism behind the one that was not real is item 81 — the fill came in
> 0.0004 shares outside a symmetric verification band, was thrown as
> `UNVERIFIED_FILL`, and the defensive flatten that followed raced the match and
> lost (item 80).
>
> **Item 81 cannot explain the other 20.** If they had filled and been flattened
> successfully, each flatten would appear on-chain as a sell. None do. Those 20
> legs genuinely never matched.
>
> **So item 79 stays open, and is now sharper rather than broader:** 20 live FOK
> buys, across two code versions, against books that REST showed were deep
> enough, matched nothing — and the repo still records no venue error string for
> any of them. That is what the raw-error and book-age instrumentation in this
> item is for, and it remains the only way to find out.
>
> **Sequencing note.** Item 78 (submit in shares rather than dollars) would
> dissolve item 81 rather than fix it: an order that specifies a share count has
> no dollars→shares round trip to verify, so the tolerance band has nothing to
> do. Worth resolving 78 before spending effort on 81.

**INSTRUMENTATION SHIPPED 2026-09-14.** The diagnosis this item asks for is now
recorded on the package itself, not only in the receipt log.

`ArbLegInfo` (`arbPersistence.ts`) gained, per leg:

| field | answers |
|---|---|
| `error` | what the venue actually said — a FOK kill, a $1.00-notional rejection and a transport drop are now distinguishable |
| `bookAgeMs` | snapshot → dispatch, so "the level was gone by the time we arrived" becomes falsifiable |
| `bookSource` | whether the size came from `clob-ws` or a REST fallback |
| `submittedAt` | dispatch wall-clock, so age can be recomputed against anything later |
| `requestedShares` | what the gate asked for, before the venue's rounding |
| `reconcile` | item 80's verdict: `filled` / `unfilled` / `unknown`, which door, how many probes |

Plumbing: `clob.ts` now carries `bookTs` on the depth object (the WS snapshot's
own `ts`, or `Date.now()` for a freshly fetched REST book — previously dropped
at the merge); `trade.ts:assertOrderAccepted` attaches `venueError`, `orderId`
and `venueStatus` to what it throws instead of flattening them into a message;
`bot.ts` returns `rawError` / `orderId` / `reconcile` alongside `{ ok: false }`;
`arbEngine.ts:executeArbLeg` stamps before dispatch and records after.
`abortReason` now reads e.g.

```
Leg execution mismatch: UP=FAIL, DOWN=NOT_ATTEMPTED — UP: invalid amount for a
marketable BUY order ($0.38), min size: 1 — up book 412ms old
```

**Side effect worth knowing:** `assertOrderAccepted` now attaches the `orderId`
even on a *failed* response. That is exactly what item 80's Door B needs — an
error-shaped reply that still carries an order id is now reconcilable by order
id rather than falling to the wallet door.

**Still open, and still the operator's:** whether the item 76 depth clamp was
deployed during the 09-11 run (`git log -1` on the VPS). Nothing in this repo
can answer it, and it decides whether item 78 was ever a candidate explanation
for the depth-bound kills.

---

### 80. GHOST FILL — the bot abandoned a leg that then filled on-chain, and held a naked position it had no record of ✅ FIXED

**Found 2026-09-11** by reconciling `docs/live_canary_packages.json` against the
Polymarket public activity API for the Safe wallet. **This is the most serious
finding in this document. Live arb must not run until it is addressed.**

**The package record and the chain disagree about whether money moved.**

```
03:38:24.114  package pkg-btc-mtwep5v2 created   btc-updown-15m-1789097400
                                                  UP $1.24 @ maxPrice 0.27
03:38:25.612  package ABORTED
                abortReason  "Leg execution mismatch: UP=FAIL, DOWN=NOT_ATTEMPTED"
                legs.up.filled = false     legs.up.shares = 0
03:38:27      ON-CHAIN BUY  4.682223 sh @ 0.26483147   ← 1.388 s AFTER the abort
03:46:39      ON-CHAIN REDEEM  4.682223 sh → $4.682223  (8.2 min unhedged)
```

**The identification is not circumstantial.** Same `slug`
(`btc-updown-15m-1789097400`), same side (`outcomeIndex: 0`, "Up"), three
seconds apart, and the money reconciles exactly:

| | |
|---|---|
| `size × price` = 4.682223 × 0.26483147 | **$1.24000** — the package's `upCost` to the cent |
| taker fee, `0.07 × p(1−p) × shares` | $0.06381 |
| sum | **$1.30381** — the reported `usdcSize` exactly |
| redeem − spend | **+$3.3784** — the $275.16 → $278.54 balance delta exactly |

**What actually happened.** The bot submitted the UP leg, concluded within 1.5
seconds that it had failed, aborted the package, and never attempted DOWN. The
order then matched. The result was a **4.682223-share naked directional
position, unhedged and absent from the local ledger, held for eight minutes to
settlement.** It won. Had BTC resolved DOWN it would have been −$1.30 against a
package whose entire purpose was a $0.27 locked profit.

**It also cuts against item 78.** The order was sized at 4.581 shares and filled
**4.682223** — *more* than planned, because the book was at $0.2648 against a
`maxPrice` of $0.27 and a dollar-denominated buy converts the whole amount at
the better price. So a market buy priced in dollars fills, and benefits from
price improvement; the round-trip precision loss is real but is demonstrably not
a blocker on its own. (The over-fill is handled: leg two is sized from
`res.position.shares`, `arbEngine.ts:635`, not from the plan — item 27.)

**This falsifies three standing claims:**

1. **"Zero orphans."** There was an orphan. It is the exact shape item 74(a)
   describes, reached by a different route — not a hedge that broke, but a leg
   the bot does not know it owns.
2. **Item 79's premise.** At least one of the 21 "failures" was a fill. The
   balance delta matches this trade alone, so probably only one — but *probably*
   is doing real work in that sentence and only a full activity-API
   reconciliation can replace it.
3. **"Nothing has ever been redeemed"** (handoff §6, never-validated list). This
   redemption is the first confirmed on-chain settlement: auto-redeem paid
   4.682223 shares → $4.682223, **fee-free and exactly 1:1**, which is the
   `$1.00`-per-set invariant holding against the chain.

**Bonus: the fee model is now validated against on-chain data.** `usdcSize`
carries the taker fee *on top of* notional, and the repo's
`0.07 × p(1−p) × shares` reproduces it to five decimal places. Two consequences:
`FEE_RATES.crypto = {r:0.07, e:1}` is confirmed live, and **the affordability
gate is understated** — `arbEngine.ts:294` tests `arbBank < totalCost + 0.01`
where `totalCost` is notional only, but the true debit is notional + fees
(`feesEstUsd` is computed at `:368` and not used in the check).

**Where the defect lives.** `arbEngine.ts:631`:

```js
const res = await executeTrade(pending);
if (res?.ok !== true) return 0;      // ← "not ok" is treated as "zero shares"
```

A refusal, an HTTP error and a timeout are all collapsed into "nothing filled".
That is sound for a refusal and **wrong for the other two**: a POST that errors
or times out may still have reached the matching engine. The previous session
recorded this exact hazard as a standing constraint — *"never set
`axios.defaults.timeout`; a timed-out order POST may have reached the book"* —
and the failure arrived through the same door anyway, because nothing
*confirms* the negative.

**The fix is not a longer timeout.** An order's outcome is a fact about the
exchange, not about our HTTP call. Before a package may be declared unfilled,
the leg's true state has to be read back — order status by `orderID`, or
positions for that `tokenId` — and a leg whose state cannot be established is
not "failed", it is **unknown**, which is a different and more dangerous
condition requiring an explicit reconcile-then-hedge-or-unwind path. That is an
execution-path ownership question (D4 position manager territory) and needs a
design decision, not a patch.

**Immediate operational consequence:** the ledger cannot currently be trusted to
say whether the bot owns a position. Reconcile local positions against the
activity API for the whole canary period before any further live run.

---

**RESOLVED 2026-09-14** — `src/polymarket/arbReconcile.ts`, wired at
`bot.ts:1074`, gated at `arbEngine.ts:51`, 13 invariant tests in
`tests/unit/arbReconcile.test.ts`, 9 mutations killed. See the addendum below;
the root cause turned out not to be the one described above.

**Plain-English write-up:** `docs/ghost-fill-and-reconciliation.md` — the
narrative version of this item, the amendment below, and items 81/82.

**Addendum — what actually happened, found while building the fix.**

The diagnosis above assumed the leg took the generic `{ ok: false }` path. It
did not. It took the `UNVERIFIED_FILL` path, and the defensive flatten at
`bot.ts:1083` *fired* — it just lost a race it could not have won.

```
expectedShares = 1.24 / 0.27          = 4.59
tolerance      = max(0.05, 4.59×0.02) = 0.09180
actual fill                           = 4.682223
|actual − expected|                   = 0.09222   ← over by 0.0004 shares
```

`resolveAgainstExpected` (`trade.ts:290`) therefore returned null,
`placeMarketBuy` threw `UNVERIFIED_FILL`, and the flatten submitted a sell at
~03:38:25.6 — **1.4 s before the venue matched the buy at 03:38:27**. It sold
shares that did not exist yet, was rejected, and logged *"likely never filled"*
about a leg that was about to fill.

So the machinery was not missing. It was early, and it was reading a band that
could not contain the fill. Both are fixed here: reconciliation probes at
0 / 2250 / 4500 ms so the last probe clears the observed 2.9 s settle latency,
and the band is one-sided (see item 81).

**Design as built.** Two doors, because the two failure shapes leave different
evidence: the venue's own record of our order (`getOrder(id).size_matched`,
exact but needs an orderID) and the wallet's token balance (uncached data-api
`/positions`, works when the transport dropped before any orderID came back).
Three answers:

| outcome | requires | action |
|---|---|---|
| `filled` | either door reports shares | book the position, `{ ok: true }`, `arbEngine.ts:635` hedges leg 2 against the confirmed count |
| `unfilled` | **only** `size_matched: 0` on the final probe | clean abort, unchanged behaviour |
| `unknown` | neither door answered | defensive flatten, then halt the engine |

**Wallet silence never resolves to `unfilled`.** A wallet that has not indexed
the fill is indistinguishable from a wallet with nothing to index, and guessing
between them is precisely what produced the ghost. Only the venue speaking about
our own order id is evidence of a kill.

**Stated consequence:** a transport failure that returns no orderID can never
resolve to `unfilled`, so it always halts. That is intended — without an order
id nothing in the world can say "your order did not reach the book" — but it
means proxy instability now stops the arb engine rather than silently retrying.
Cleared by an operator via `POST /api/poly/arb/resume`; state visible at
`getState().limits.arb.halt`. Paper mode is untouched (the path is gated on
`cfg.mode === 'live'`).

---

**Amended 2026-09-14 (same day), after operator review.** The first cut halted
arbitrage on *any* unresolved leg. The operator's objection was correct and the
design was too blunt: the commonest failure — a blip on the order POST where
nothing filled — is also the least dangerous one, and stopping the engine for it
trades a rare risk for a frequent outage.

Two changes:

**1. `unfilled` now has a second qualifying condition.** Door A answering on
*every* probe, each time reporting no shares, resolves to a clean abort. Not one
answer — every one, across a window that outlasts the observed settle latency.
Wallet *silence* still never qualifies: a request that failed has told us
nothing, and the distinction between "answered nothing" and "did not answer" is
made in exactly one place (`arbReconcile.ts:fetchWalletPositions`, on `res.ok`).
Only `blind` — no door answered at any probe — halts.

**2. The sweep, which is what makes that safe.** Reconciliation is a 4.5-second
window and any window can be raced. `findUnrecordedHoldings` +
`sweepUnrecordedHoldings` (`bot.ts`, called from `arbHousekeeping`, throttled to
30s, live mode only) re-read the wallet against `botState.positions` on a
schedule. A holding no position claims is sold back to cash. A fill that appears
after reconciliation gave up — the exact 2026-09-11 shape — is therefore caught
on the next pass rather than never.

**This gap had no backstop at all before now.** The pre-existing orphan sweep
(`arbEngine.ts:825`) iterates `botState.positions`, so it can only find legs the
bot already recorded; a ghost fill is by definition one it did not. Nothing in
the repo compared wallet ground truth against bot records.

Sweep guards, each pinned by a test: a 10s grace window keyed on order
submission (`markOrderInFlight`) so a fill still being written into
`botState.positions` is never swept out from under itself; resolved-worthless
tokens skipped (item 68 — they sit in the feed with size > 0 and value $0, and
there is nothing to sell); tokens referenced by any bot position, open *or
closed*, left alone; an unavailable feed treated as no information rather than
as an empty wallet. A holding with no usable price is not sold at all — it
halts for operator review, because an unbounded market sell of an unknown token
can give the book away.

Halt scope, stated precisely because the first write-up was vague about it: the
flag is read at `arbEngine.ts:51` only. It blocks opening new arb packages
across all symbols and windows. Directional trading, exits, settlement,
redemption and paper mode are unaffected — except in arb-only mode, where the
directional pipeline is skipped anyway (`bot.ts:2707`) and a halt therefore does
mean nothing new opens.

Tests: 27 invariants in `tests/unit/arbReconcile.test.ts`. 20 mutations applied,
20 killed. One mutation initially survived — Door A returning `[]` instead of
`null` on a non-200, which would have made three dead responses resolve to
`unfilled` and reintroduced silent abandonment. Every reconciler test injects
`getWalletShares`, so none of them reached that boundary; five tests were added
for the HTTP contract itself.

---

### 81. `verifyFilledShares` uses a symmetric tolerance for a one-sided quantity ✅ FIXED 2026-09-16

**FIXED 2026-09-16.** The fill path now resolves against the same one-sided band
as the reconciler — one function, one owner:

| piece | where | owner |
|---|---|---|
| quote (amount, expectedShares, tolerance) | `trade.ts:expectedSharesFor` | trade.ts — `placeMarketBuy` now calls it instead of re-deriving the same arithmetic inline |
| band | `trade.ts:shareBand` (moved from `arbReconcile.ts`) | trade.ts |
| scale resolution | `trade.ts:resolveInBand` → the existing `resolveScale` | trade.ts |
| readers | `verifyFilledShares` (fill path), `getOrderMatchedShares` and `reconcileArbLeg` (reconciler) | — `arbReconcile.ts` re-exports, does not copy |

The symmetric `resolveAgainstExpected` is deleted. `verifyFilledShares` is
exported and takes its `getOrder` round trip as an injected function, so it is
tested without a signer.

**A second defect in the band itself, found by the new sweep.** `hi` was
`expected × (price/tick) + tolerance`. `expected` is rounded to 2dp and
`price/tick` amplifies that rounding up to 98×, while the tolerance was added
unscaled — so the ceiling could sit up to **0.39 shares below** the physical
maximum `amount / tick` (e.g. $2.75 @≤$0.51: 274.9978 vs 275). Now
`(expected + tolerance) × (price/tick)`, zero shortfalls across the sweep. Only
reachable by a fill near the lowest tick on a high-bounded buy, so no observed
live effect; it was the band's own stated contract that was wrong.

**Tests** — `tests/unit/fillPathBand.test.ts`, as invariants: the 2026-09-11 fill
verifies on the fill path at both wire scales and via `size_matched`; every
achievable fill (97 limit prices × 4 amounts × every tick fill price × both
scales, >30k cases) resolves to exactly one reading; under-fills, over-ceiling
readings, zeros and an unreachable venue all return null (unknown), never a
number; and `arbReconcile.shareBand === trade.shareBand`. Mutation-checked:
restoring the symmetric band fails 3, the unscaled ceiling fails 1, reporting
unknown as zero fails 4.

**Residual cost from the 2026-09-16 status note below is gone:** a price-improved
fill now verifies synchronously, so it no longer takes the ~4.5s dual-door
reconciliation before leg 2 is sized.

---

*Superseded status notes follow.*


**STATUS 2026-09-16, supersedes the 2026-09-15 note below.** Items 78 and 89 are
CLOSED WON'T FIX, so `arbExactShareRouting` is `false` for good. The 2026-09-15
status said this defect was "one config flag away from being live again" — that
flag has now been thrown, deliberately and permanently. **The defective path at
`bot.ts:1139` is the only arb fill path there is.** It is no longer dormant and
never will be again.

Why that is nevertheless acceptable, traced rather than asserted
(`bot.ts:1293–1307`): on the dollar route `quote` is non-null via
`expectedSharesFor`, so an `UNVERIFIED_FILL` throw is caught by
`reconcileArbLeg`, which uses `arbReconcile.ts:shareBand` — the correct
one-sided ceiling. A confirmed fill is booked at `recon.shares` and
`arbEngine.ts:635` sizes leg 2 against the venue's count, not the plan. So the
symmetric band still misjudges every price-improved fill, but the misjudgement is
now absorbed rather than acted on. That containment is exactly what was missing
on 2026-09-11.

**The residual cost, which is real and permanent.** `err.fokKill`'s fast abort
does not apply here — an unverified fill is not a kill — so every price-improved
arb fill now takes the full dual-door reconciliation (~4.5s) before leg 2 is
sized. That is a one-sided exposure window on a leg that is already filled.
Frequency is unmeasured: one confirmed instance (2026-09-11, 0.0004 shares
outside the band). **Fixing the band at `trade.ts:293` to use `shareBand`'s
one-sided ceiling would remove that window**, and is now worth doing on its own
merits rather than being dissolved by item 78. Not scheduled; not attempted here.

Note the trap flagged at the end of this item still stands: `readGtcFill`'s
identical-looking symmetric band at `trade.ts:329` is **correct** and must not be
"fixed" by analogy.

---

*Original filing follows.*

**Found 2026-09-14** while building item 80. This is the root cause behind the
ghost fill. It was live on the fill path when filed; see the status note below
for what changed.

`placeMarketBuy` commits a fixed dollar `amount` at a limit `px`, so the share
count is `amount / fillPrice` where `fillPrice ≤ px`. The fill can therefore only
ever come in **at or above** `expectedShares = amount / px` — FOK does not
partially fill, and price improvement only adds shares. The verification band at
`trade.ts:293` is symmetric:

```js
const fits = [raw, raw / SHARE_SCALE].filter((c) => Math.abs(c - expectedShares) <= tolerance);
```

with `tolerance = max(0.05, expectedShares * 0.02)` (`trade.ts:369`). A fill
better than 2% of the limit price falls outside it and is reported as
unverifiable. At $0.27 against a $0.01 tick the achievable improvement reaches
27×; 2% is consumed by a single sub-tick of price improvement.

**Evidence it is not theoretical:** the 2026-09-11 fill (4.682223 against 4.59
expected) missed the band by 0.0004 shares and was thrown as `UNVERIFIED_FILL`.

The correct ceiling is what the venue could actually have done — every share
filling a full tick better — which is what `arbReconcile.ts:shareBand`
implements.

**STATUS 2026-09-15: DORMANT, NOT FIXED.** Item 78 shipped and
`arbExactShareRouting` is `true`, so the defective path is no longer reached —
but the code is untouched and one config flag away from being live again.

Reachability, traced rather than assumed:

```
resolveAgainstExpected (trade.ts:396)
  └── verifyFilledShares (trade.ts:419)          ← sole caller
        └── placeMarketBuy (trade.ts:554)        ← sole caller
              └── bot.ts:1139                    ← only when arbExactShareRouting !== true
```

Set the flag back to `false` and the 2026-09-11 ghost is re-armed. The comment
at `trade.ts:396` should say so; until it does, this item is the record.

**Why item 78 dissolved it rather than papering over it — and the trap this
creates for a future reader.** The symmetric band was wrong *because the share
count was derived*: a fixed-dollar market BUY gets `amount / fillPrice` shares,
and a better fill price means MORE shares than `amount / maxPrice`. One-sided
deviation, symmetric band, 0.0004 shares outside it.

Under limit + FOK the share count is the **input**, and fill-or-kill makes the
result `{ 0, size }` with nothing in between. So `readGtcFill`'s
identical-looking symmetric band (`trade.ts:329`) is **correct** on that path,
and correcting it "for consistency with item 81" would be a change made by
analogy rather than from the mechanism — the exact habit this file exists to
discourage.

The same band on the *GTC* path is wrong again, in the opposite direction. See
item 85.

Still not applied to `trade.ts` inline: that is the live fill path, and widening
its acceptance band changes what gets booked as a confirmed fill. Dormant code
does not earn a live-money edit.

---

### 82. `data/clob_receipts.jsonl` on the VPS is still the unread primary source ✅ CLOSED 2026-09-17

**CLOSED — read by the operator 2026-09-17.** Four receipts in the 03:38 window,
plus the settlement block fetched from Polygon. Full write-up: domain facts §9.

| time (UTC) | event |
|---|---|
| 03:38:24.848 | POST response: **`status: "matched"`, `takingAmount: "4.682223"`**, tx hash present |
| 03:38:25.025 | `getOrder`: **`MATCHED`, `size_matched: "4.682223"`**, `original_size: "4.5925"` |
| 03:38:25.026 | `placeMarketBuy/verified`: `resolvedShares: null`, **`UNVERIFIED_FILL`** |
| 03:38:25.241 | flatten SELL 4.59 sh → 400 **`balance: 0`** |
| 03:38:25.612 | package ABORTED |
| 03:38:27 | block 93,595,249 — settlement tx, `status 0x1` |

**What it confirms.** Everything item 80's reconstruction predicted about the
verification: `UNVERIFIED_FILL`, both rungs rejected, 4.682223 against 4.59.

**What it corrects — the causal story, in three places.**

1. **The venue did not match "at 03:38:27". It matched at 03:38:24.848, and said
   so, twice, with the exact count.** 03:38:27 is on-chain *settlement*. The
   addendum's "1.4 s before the venue matched the buy at 03:38:27" (above, in
   item 80) conflates the two. The bot held positive, exact proof of the fill
   0.18s before it discarded it.
2. **So item 81's band was the sole cause, not one of two.** There was no
   indexing lag for a poller to wait out on Door B: `getOrder` was exact at
   +0.18s. The 4.5s polling window is still right for **Door A** (wallet balance
   follows settlement, ~2s), but the recorded rationale for it is wrong.
3. **The flatten did not sell "shares that did not exist yet" in the sense of an
   unfilled order.** The order had filled; the tokens were not yet *settled*,
   and the venue's own balance check reads settled holdings (§9d).

The fix already shipped handles this exact receipt: checked 2026-09-17 against
the verbatim VPS JSON, `verifyFilledShares` resolves 4.682223 on the receipt
rung with zero `getOrder` calls. Old band missed by 0.000423.

**Stale comments carrying the wrong account — CORRECTED 2026-09-17** (comment-only change; the Door A / Door B polling rationale now rests on settlement lag, not match lag):
`arbReconcile.ts:27-31` and `:45` ("chain settled … 2.9s", "before the match",
"indexing lag"); `bot.ts:1236-1238` ("chain matched at +2.9s", "a leg that was
about to fill"). The first number is also off: match → settlement was 2.15s
(block timestamp, whole seconds), not 2.9s.

**Minor, noted not fixed.** The flatten sold `expectedShares` (4.59), not the
4.682223 actually matched. That sizing survives at `bot.ts:1332-1334`, now only
on the `unknown` branch after a 4.5s window; a shortfall is caught by
`sweepUnrecordedHoldings` (item 80).

**Filed 2026-09-14.** The item 80 addendum reconstructs the 03:38:24–27 sequence
from package JSON, the activity API and the verification arithmetic. It is
consistent to five decimals but it is still a reconstruction. `captureReceipt`
(`trade.ts:389`) wrote a `placeMarketBuy/verified` record for that call carrying
`verificationOutcome`, `takingAmountRaw` and `statusString` — the three fields
that would settle it outright.

Local `data/` is not the running instance, and VPS measurements are the
operator's to run. One `grep` on the 03:38 window closes this.

---

### 83. The arb sizing gate computes on a finer grid than the venue accepts — latent, no live defect

**Found 2026-09-14** while building item 78, from the vendored SDK.

`ROUNDING_CONFIG[tick].size` is **2** for *every* tick size
(`order-builder/helpers/roundingConfig.js`), and both amount builders
`roundDown` the share count to it. The arb sizing gate computes on a 3-decimal
grid:

```js
// arbEngine.ts:265
let shares = Math.floor(Math.min(budgetShares, depthShares) * 1000) / 1000;
```

The third decimal is discarded by the venue. It is not a finer order; it is the
same order with a digit nobody reads.

**Corrected on the same day it was filed.** The first draft of this item claimed
"the gate can believe it cleared a minimum it did not". That is **false**, and
the claim was made from the shape of the arithmetic rather than from running it.
Swept across every cent price from $0.02 to $0.98, at a leg sized exactly to the
minimum-notional floor:

| route | $1.00 breaches |
|---|---|
| dollar (current) | **0 of 97** — the notional is transmitted *as dollars*, so share-grid truncation never touches it |
| limit (item 78) | **0 of 97** — `venueShareCount` rounds up when truncation would breach |

So there is no live defect here. What remains is real but narrower:

1. **The third decimal is discarded.** The gate reasons on a grid finer than the
   venue's, so any argument that depends on the third digit — including the
   comment at `arbEngine.ts:268` about `$1.00` versus `$0.999` — is reasoning
   about a number that does not reach the book.
2. **The depth clamp is slightly more conservative than it says.** 3-decimal
   floor, then the venue truncates to 2 decimals. Both reductions, so the error
   is in the safe direction, but the effective utilisation is not exactly 90%.
3. **[MOOT 2026-09-16 — exact-share routing and `venueShareCount` removed, items 78/89.]** **Under exact-share routing the floor case rounds UP** — measured, the
   up-branch fires at **81 of 97** price points. At the minimum-notional floor,
   exact-share routing therefore asks for up to 0.0099 shares *more* than the
   gate computed. That is within behaviour the gate already accepts on purpose
   ("Lifting above a ceiling here is intentional: the gates below then refuse it
   by name", `arbEngine.ts:270`), but it is new, it only exists once item 78 is
   enabled, and it is the one interaction to watch on the first live run with
   the flag on.

Not fixed: changing the sizing grid touches item 73's unified gate and every
test that pins it, for no behavioural gain today. Filed so the next change to
that gate knows the constraint exists — and so point 3 is on the record before
item 78 is switched on, not after.

---

### 84. Reconciliation runs inside the scan loop, so every FOK kill stalls it for 4.5s ✅ FIXED

**NOTE 2026-09-16 — the fast abort may now never fire.** The only kill message
in `FOK_KILL_PATTERNS` (`trade.ts`) was observed on the **limit** route —
`placeLimitFokBuy/postOrder`, `data/clob_receipts.jsonl:2` — which is now
removed. What the **market** route (`createAndPostMarketOrder`, FOK) returns on a
kill has never been recorded. If it words it differently, every arb kill takes
the full ~4.5s reconciliation again. That is the safe direction (slower, not
wrong), and stop-losses no longer share the loop, so no code change. Settle it
from the live receipts: `unmatchedFailures` / the vocabulary map in
`fokKillStats()` will show the market route's actual string on the first kill.

**Found 2026-09-15**, immediately after the item 78 probe made FOK kills a
first-class, correctly-reported outcome rather than a mystery.

**Why kills are the common case** (moved here from a `bot.ts` comment,
2026-09-17): 20 of the 21 live canary packages never filled (item 79); the one
that did was the ghost fill (items 80, 82). A per-kill stall therefore lands on
nearly every live attempt.

The markets loop is sequential and the arb call is awaited inside it:

```js
// bot.ts:2675
for (const market of tradableMarkets) {
  ...
  // bot.ts:2874
  const pkg = await detectAndExecuteArbPackage({ ... });
```

A failed live arb leg now triggers `reconcileArbLeg` — three probes across
**4,500 ms** (`arbReconcile.ts:45`) — before the package aborts. That await is
inside the loop, so the rest of the cycle waits on it.

**Correction to the first draft of this item.** It claimed stop-losses stop
running during the stall. They do not. `scanOpenExitsFast()` runs at the *top*
of `scan()` (`bot.ts:2470`), before the markets loop, so exits are **delayed by
a cycle, not skipped**. The accurate statement is that a stall lengthens the
cycle, and exit frequency is the reciprocal of cycle length.

**That is still severe, because the stalls compound.** Default durations are
`['5m','15m','30m','1h']` (`bot.ts:208`) across two symbols — up to **eight
markets per cycle**, each able to burn its own 4.5 s:

| | exit checks |
|---|---|
| normal cycle (~250 ms) | ~4 per second |
| one failing market | one per ~4.75 s |
| eight failing markets | one per **~36 s** |

Over a 5-minute window that is roughly **8 exit checks instead of ~1,200**.
`botState._scanning` (`bot.ts:2575`) skips overlapping ticks, so the timer
cannot make up the difference.

**Why this is not a corner case.** Twenty of the twenty-one live canary packages
were genuine kills (item 79), and kills are exactly what triggers the stall.

**It is worse than "one extra call", because Door B probably cannot answer.**
The probe response was `status: 400` with an `error` — the order was *rejected*,
not accepted-then-killed. `getOrder(orderId)` on a rejected order most likely
returns nothing, so Door B is silent and resolution falls to Door A, which by
design requires an answer on **every** probe. So a routine kill costs the full
4.5 s *and* three `data-api /positions` calls, every time.

**Do not fix by weakening the reconciler.** It has already been softened once
(item 80 amendment) and the remaining strictness is what stops a ghost fill.

Two candidate fixes, in preference order:

1. **Short-circuit on a recorded venue string.** Fact 8 in
   `docs/research/polymarket-domain-facts.md` now records the exact wording:
   `"order couldn't be fully filled. FOK orders are fully filled or killed."`
   That is a definitive statement of no-fill from the venue about our own order,
   which is exactly the evidence `unfilled` requires — it just arrives in the
   rejection instead of from `getOrder`. Treating it as such skips
   reconciliation entirely for the common case.

   **Caveat that must not be skipped:** this is gating execution on an error
   string, which is the hazard `verifyFilledShares` documents at `trade.ts:311`
   and refuses to do. The difference is that this string is now *observed
   primary source* rather than assumed vocabulary — but it is **one** observation
   of **one** wording. Match it narrowly, treat any non-match as today's
   behaviour, and count non-matches so the vocabulary can be widened from
   evidence.

2. **Reconcile off the scan loop.** Leave the package `PENDING_FILL` and let
   housekeeping resolve it. Architecturally cleaner and removes the stall
   entirely, but it means a package exists in an unresolved state across scan
   cycles, which is the condition items 9 and 10 were about. Bigger change.

**Not fixed here:** both options change the behaviour of the safety mechanism
that was built this week, and the operator has already had to correct one
over-eager version of it. This wants a decision, not a patch.

**FIXED 2026-09-15.** Option A with the fallback preserved, plus the exit
decoupling, as specified by the operator.

**1. Fast abort on an announced kill.** `isSyncFokKill(status, message)`
(`trade.ts`) requires **both** HTTP 400 **and** a phrase this project has
observed from the live CLOB. On a match, `executePendingTrade` resolves the leg
as `unfilled` immediately — `door: 'venue_sync'`, zero probes, zero delay.

**2. Fallback preserved.** A 5xx, a timeout, a dropped connection, an
unrecognised message, or a 400 with different wording all take the full 4.5 s
dual-door path exactly as before.

**Why an error-string match is admissible here, when `verifyFilledShares`
refuses to gate on `status` (`trade.ts:311`) for the same reason the Aug 2026
`negRisk` regression happened:** the direction of failure. A match skips
reconciliation for a leg the venue has explicitly said did not fill. A non-match
changes nothing. If Polymarket rewords the message, the bot gets **slower, never
wrong**. That asymmetry is the entire justification and does not extend to any
other use of these strings — which is why the patterns live in exactly one
place and every other consumer reads the boolean, not the text.

**3. Vocabulary counters.** `fokKillStats()` reports `fastAborts`,
`unmatchedFailures`, and the top unrecognised messages by frequency; surfaced at
`getState().limits.fokKills`. **`unmatchedFailures` rising against a flat
`fastAborts` is the staleness alarm** — without it the fast path would silently
stop engaging and the 4.5 s cost would return unexplained.

**4. Exits decoupled.** `scanOpenExitsFast` now runs on its own
`POLY_SCAN_INTERVAL_MS` timer (`bot.ts`), not at the top of `scan()`. Risk
management is no longer downstream of order-dispatch latency.

**That move created a hazard that had to be closed first.** Every exit path
previously ran inside `scan()`, serialised by `_scanning`, so "two sellers for
one position" was impossible *by accident*. `scanOpenExitsFast` sets
`pos.closed = true` only AFTER awaiting `placeMarketSell`, so two overlapping
runs would both read `closed === false`, both dispatch, and the second would
sell shares the first had already sold — an unhedged short, the mirror image of
the ghost fill. `claimPositionExit` / `releasePositionExit` make **one position,
one exit in flight** an invariant rather than a side effect of the call graph;
claimed synchronously before any await, released on both success and rejection,
applied at all five position-closing sell sites plus `executeSell`. The timer
also carries its own re-entrancy guard and is cleared when the bot stops.

Tests: 10 invariants in `tests/unit/fokFastAbort.test.ts`. 5 mutations applied,
5 killed. **One survived the first pass and it was the important one:**
broadening the pattern to `/filled/i` passed every test, because no negative
case contained the word. That mutation reads a message saying the order *did*
fill as "confirmed nothing filled" — the 2026-09-11 ghost with the safety net
switched off. Three negative cases added (`order filled`, `order partially
filled…`, `order was fully filled`); it dies now.


---

### 85. A partially-filled directional entry is booked at its full requested size ✅ FIXED

**Found 2026-09-15** while confirming whether item 78 had made item 81
unreachable. Same family, different order type, opposite direction.

`readGtcFill` resolves the wire scale against a **symmetric** band:

```js
// trade.ts:329
const tolerance = Math.max(0.05, Math.abs(want) * 0.02);
const shares = [rawShares, rawShares / 1e6]
  .find((c) => Number.isFinite(want) && want > 0 && Math.abs(c - want) <= tolerance) ?? null;
```

For a **GTC limit** order — which is every directional entry (`placeOrder`,
`trade.ts:358`) — a partial fill is legitimate and can be arbitrarily smaller
than the request. Anything more than 2% short fails the band, so `filledShares`
comes back `null`, and:

```js
// bot.ts:1176
pos.shares = orderResult.filledShares ?? orderResult.size;   // `size` is what was ASKED for
```

**A 50%-filled entry is booked as 100% filled.** The position record then
overstates holdings until something else corrects it: mark-to-market, equity,
per-trade P&L and Kelly sizing all read the inflated number.

**Why this is not as bad as it sounds, and why it still matters.** The live exit
paths clamp against real inventory before selling
(`adjustedShares = Math.min(sellShares, pmShares)`, `bot.ts:2578` and the
in-scan exits), so the bot does not try to sell shares it never received — that
guard is item 68's. The damage is to the *ledger*, not the order: overstated
equity, overstated realised P&L on close, and a Kelly input computed from a
position size that never existed.

**The family, stated once so the next reader does not fix the wrong one:**

| path | order type | legitimate deviation | correct band |
|---|---|---|---|
| `placeMarketBuy` | market FOK, dollars in | fill can only be **larger** (price improvement) | one-sided **up** — item 81, dormant |
| `placeLimitFokBuy` | limit FOK, shares in | none; result is `{0, size}` | symmetric is **correct** |
| `placeOrder` | GTC limit | fill can be **smaller** (partial) | one-sided **down** — this item |


**FIXED 2026-09-15.** `readGtcFill` (`trade.ts`) + booking at `bot.ts`, 13
invariant tests in `tests/unit/gtcPartialFill.test.ts`, 6 mutations applied.

**The band is one-sided down, but widening it alone would have been wrong.**
Admitting anything smaller than the request also admits any small number that
happens to land in range — the degenerate receipt at
`tests/unit/invariants.fillAccounting.test.ts:127` (`makingAmount: 1,
takingAmount: 2` against 26 shares) would have started resolving as "2 shares
filled". That existing invariant caught the first version of this fix, which is
exactly what it was written for.

So the rule is split by what the reading claims:

| claim | accepted on | why |
|---|---|---|
| **full** — within the old symmetric tolerance of the request | itself | nothing to corroborate; this is the case the symmetric band was always right about, kept unchanged |
| **partial** — anything less | the implied price | `maker / taker` is collateral-per-share actually paid. Both amounts share a scale so the ratio is scale-free. A BUY can never pay above its own limit, a SELL never sell below its floor — a partial whose implied price is impossible is a reading we do not understand |
| **neither resolves** | nothing | `matched-unverified`, as before |

Floor is `0.01` shares — `ROUNDING_CONFIG[tick].size` is 2 for every tick
(item 83), so a sub-0.01 candidate is the other scale, not a fill. Ceiling is
`want × 1.02`: a GTC order cannot overfill.

**Booking.** A resolved partial is now booked at what filled, flagged
`pos.partialFill`, and logged with both numbers. When the size is still
unresolvable the request is booked *and said out loud* — between over- and
under-booking, over-booking is the safer error here, because the exit paths
clamp to real inventory before selling (`pmSharesForPosition`) whereas
under-booking would strand real shares nobody knows about, which is the
ghost-fill family. `pos.sharesUnverified` and `pos.requestedShares` make the
divergence auditable instead of silent.

**Mutation results: 6 applied, 5 killed, 1 equivalent.**

- One survivor was a **real gap**: relaxing `fits.length === 1` to "take the
  first match" passed every test, because scale ambiguity is unreachable below
  ~9,800 shares (the candidates differ by 1e6). At that size the two readings
  are 15,000 shares and 0.015 shares, and guessing books a million-fold error.
  Two tests added at that size — one that must refuse, one that must still
  resolve, so the guard refuses ambiguity rather than refusing size.
- One survivor is **equivalent, not a gap**: dropping the `Number(price) > 0`
  guard changes nothing, because a null price makes `limit` zero and the
  implied-price comparison fails anyway. The guard is defensive redundancy and
  is kept for readability.

**Also corrected during this work:** the first draft of the floor test asserted
that `makingAmount: 3, takingAmount: 6` must not resolve. It should — that is a
6-share partial at exactly the limit price, an ordinary outcome. The test was
wrong, not the code; rewritten to exercise the floor with a reading where
neither candidate is usable.


---

### 86. `tsc` and the test suite both pass on code the runtime cannot parse ✅ FIXED

**Found 2026-09-15** by a live boot failure on the VPS, not by any check in this
repo:

```
Error: Transform failed with 2 errors:
  src/polymarket/bot.ts:3295:43: ERROR: Cannot use "continue" here
  src/polymarket/bot.ts:3378:41: ERROR: Cannot use "continue" here
```

Two `continue` statements were added inside `closePosition` and the partial-sell
helper — **functions, not loops** — during the item 84 exit-claim work. Both
`npx tsc --noEmit -p .` and the full 569-test suite passed on that code.

**Why both checks were blind, which is the actual finding:**

1. `bot.ts` opens with `// @ts-nocheck` (line 1), so **tsc skips the file
   entirely**.
2. **No test imports `bot.ts` as a module.** The tests that mention it read it
   as *text* via `repoFile(...)` to assert on source patterns
   (`invariants.fillAccounting.test.ts:146`, `invariants.orderRouting.test.ts:72`),
   so esbuild never transforms it and a parse error never surfaces.

So the largest and most safety-critical file in the repo had **no syntax gate of
any kind**, and a green suite said nothing about whether the bot could start.
This is not specific to `continue`: any parse error in any `@ts-nocheck` file
that no test imports would have shipped the same way.

**Fix:** `tests/unit/sourceTransforms.test.ts` runs esbuild's `transformSync` —
the same transform `tsx` uses at boot — over every `.ts`/`.tsx` under `src/` plus
`index.ts`. Parse errors now fail in the suite instead of on the VPS. Verified by
reintroducing the exact bug: the new test fails with the venue's own message
while `tsc` still reports nothing.

Deliberately checks **parsing only**. Type errors are tsc's job, and
`@ts-nocheck` files have opted out of that on purpose — but nothing opts out of
having to parse. The sweep also asserts it found >30 files, so it cannot
silently cover nothing.

**Note on the fix to the original bug:** both sites now `return false`, matching
the convention every other refusal in those functions already used — not
`break`, which would have changed control flow.

---

### 87. `server.ts:359` assigns to a constant and will throw when reached ✅ FIXED 2026-09-17

**FIXED 2026-09-17.** Variable shadowing. `/api/pnl` declares the running total
`let totalReturn = 0` (`:349`), then inside the per-token `map` declares
`const totalReturn = feesCollected + currentValue` (`:354`). The accumulator line
`totalReturn += totalReturn` (`:359`) resolves to the inner constant, so it
throws `TypeError: Assignment to constant variable` on the first active token.

**Correction to the original filing below.** It said the intended value "is not
inferable from the line". It is: the stream path in the same file (`:74-84`)
computes the identical portfolio with a per-token `ret` and `totalReturn += ret`.
The fix follows that: the per-token value is renamed `tokenReturn` at its
declaration and its three uses (`netPnl`, `roi`, and the accumulator). Per-token
`netPnl`/`roi` values are unchanged; `totalReturn` now sums the per-token
returns instead of throwing.

**Blast radius, measured.** Contained: the handler's `try/catch` turned the throw
into an HTTP 500, not a process crash, and only when at least one token session
was active. Not Polymarket code — the ETH token-launch feature (`pons.ts`,
`/api/launch`). No caller in `src/` or `src/public/`; the dashboard's portfolio
comes from the correct stream path. External callers cannot be ruled out from
the repo.

**Verified:** esbuild's `assign-to-constant` warning is present on `HEAD`'s
`server.ts` and absent after the change.


**Found 2026-09-15** by esbuild's own warning during the item 86 sweep:

```
▲ [WARNING] This assignment will throw because "totalReturn" is a constant
    src/server.ts:359:8:
      359 │         totalReturn += totalReturn;
```

Pre-existing and unrelated to this week's work. It parses, so item 86's sweep
does not fail on it — esbuild reports it as a warning, and the throw happens at
runtime when that line executes.

Two things wrong independently: the assignment targets a `const`, and
`totalReturn += totalReturn` is a doubling that reads like a typo for something
else. Not fixed here because the correct value is not inferable from the line —
whoever owns that endpoint should say what it was meant to compute.

---

### 88. Every arb package raised a false stop-loss alert on routine settlement ✅ FIXED

**Found 2026-09-15** in the operator's paper-run log:

```
13:10:06.985  SL  ⚡ RAPID SELL BTC DOWN · settle · PnL $-5.25
13:10:07.155  SL  🏁 PAPER ORPHAN SETTLE BTC DOWN · $5.25 · btc-updown-5m-1789473900
```

A pair's legs settle separately. The leg bought above $0.50 books a per-leg loss
its sibling exactly offsets — this package netted **+$1.12**. But the line was
typed `'sl'`, and `PolyDashboard.tsx:2628` raises a **red error toast** for every
`'sl'`. So every profitable package produced one false stop-loss alert, which
trains an operator to ignore exactly the alerts a live run needs.

Three separate defects on those two lines:

1. `executeSell` (`bot.ts:4696`) typed **every** sale `'sl'` — settle, manual,
   rapid, panic — for both engines, and labelled a settlement "RAPID SELL".
2. The paper settle loop (`bot.ts:2718`) used `pnl >= 0 ? 'tp' : 'sl'` on a
   per-leg number that is meaningless for one half of a pair.
3. `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl)}` signed only gains and then took the
   absolute value, so **a $5.25 loss printed as "$5.25"** — for both engines.

**Scoped so directional trading is unaffected, and pinned by test rather than
asserted.** The rule lives in `positions/settleLog.ts:settleLogKind`:

| position | tone | why |
|---|---|---|
| arb leg, pair intact | `'settle'` (neutral, no toast) | per-leg P/L is meaningless |
| arb leg, pair **gone** | `'tp'` / `'sl'`, unchanged | a naked leg's loss is real — the alert the live watchlist needs |
| directional, any outcome | `'tp'` / `'sl'`, unchanged | exactly as before |

"Intact" reuses item 74a's `hedgeIsIntact` rather than a second definition, and
settlement order is safe with it: the second leg sees its sibling closed, but a
LOCKED/SETTLED package short-circuits to intact first.

The minus-sign fix applies to both engines. It is the one change directional
sees, and it is display text only.

**Display only.** Nothing here touches exit decisions, `exitReason`,
`bookWindowExit`, window stats, cash or the ledger. `pushTrace` now passes
`'settle'` through so arb settles stay in the exits trace bucket (`bot.ts:1514`
already listed it); the ChatPanel "sell" filter includes it so they do not
disappear from that view.

Tests: 10 in `tests/unit/settleLogTone.test.ts`. 4 mutations, 4 killed —
including the one that matters most to the operator's question: letting
directional positions also take the neutral tone fails three tests.

**Not fixed, noted for whoever owns it:**
- `scan/exits.ts` contains an identical copy of the paper settle block and is
  imported nowhere — dead code carrying the old sign bug.
- Directional settles through `executeSell` still show as `⚡ RAPID SELL … 'sl'`
  even when profitable, so a winning directional settlement raises a red error
  toast. Left alone deliberately: this fix was scoped to not change directional
  behaviour, and that change should be the directional owner's call.
- Window summary lines (`🏁 WINDOW … closes 0 · PnL $0.00`) are written at window
  end, but arb settlement waits `windowEnd + 5000ms`, so arb results are never
  counted in them.
- Log timestamps are local time (BST) while window labels are UTC.

---

### 89. Exact-share routing breaks venue precision on 96% of orders, and on 65% of second legs ❌ CLOSED 2026-09-16 — WON'T FIX

**CODE REMOVED 2026-09-16.** `placeLimitFokBuy`, `venueShareCount`,
`VENUE_SHARE_DECIMALS`, the `arbExactShareRouting` flag and its branches in
`bot.ts`, `scripts/probe-limit-fok.ts` and `tests/unit/arbExactShareRouting.test.ts`
are deleted — recoverable from `7ae2450`. A stored VPS config may still carry
`arbExactShareRouting: true`; `normalizeConfigStore` → `pickStrategy` drops
unlisted keys on every load path (`bot.ts:214, 220, 4442`), so it is inert.

**CLOSED together with item 78.** `arbExactShareRouting` stays `false`
permanently. The share-lattice fix sketched below is buildable and was costed:
it is **~2.4× more expensive than the defect it removes**. Retained as the
reason nobody should re-enable this route. See "Why this was closed" at the end.

**Found 2026-09-15** from live receipts, within hours of item 78 being enabled.
**`arbExactShareRouting` set back to `false`** in `modeConfig.ts`; the running
VPS config must be changed by the operator, since a code default does not
override a stored value.

Two live leg-1 orders, 27 minutes apart:

| time (UTC) | shares × price | signed maker | venue answer |
|---|---|---|---|
| 13:56:32 | 5.20 × $0.25 | 1300000 ($1.30, 2 dp) | FOK kill — valid order, nothing to match |
| 14:23:53 | 5.26 × $0.35 | 1841000 ($1.841, **3 dp**) | **"invalid amounts … maker amount supports a max accuracy of 2 decimals"** |

The first passed only because 5.2 × 0.25 happens to land on whole cents.

**Mechanism** (full write-up: domain facts §8 amendment). A crossing limit order
is validated under marketable-order precision — maker ≤ 2 dp, taker ≤ 4 dp. The
SDK's market builder rounds to that; its limit builder allows maker to 4 dp.
Measured with the SDK's own builders: **95.7%** of limit-route orders are
invalid, **0.0%** of market-route orders.

**Why it is worse than "most orders fail".** Share parity means leg 2 buys leg 1's
count at a *different* price. Of packages whose first leg passes validation,
**64.5%** would have the second leg rejected on precision. Leg 1 filled, leg 2
refused, and `arbEngine.ts:592` unwinds leg 1 — a realised loss of the spread plus
two taker fees, on every such package. Bounded: the unwind, item 74a's stop loss
and item 74b's $10 cap each limit it. But it is a systematic bleed on a route that
also almost never trades.

**What the new telemetry did right.** The precision rejection does not match
`isSyncFokKill` (verified), so it took the full reconciliation path rather than a
fast abort, and incremented `unmatchedFailures` with its text — item 84's
vocabulary counter surfacing a rejection nobody had seen, which is what it was
built for.

**Why turning it off is safe now, when it would not have been on 2026-09-11.**
With routing back on the dollar path, item 81's symmetric band is reachable
again. But item 80's reconciler resolves that exact case with `shareBand` — one-
sided, correct — and hedges leg 2 against the confirmed count. The ghost fill was
dangerous because nothing reconciled; now something does.

**The fix that was considered, costed, and rejected.** Choose the package share
count at sizing time (`arbEngine.ts`, item 73's gate) so it is valid for **both**
legs:

- per-leg step = `100 / gcd(c, 100)` hundredths of a share, for a price of `c` cents
- package step = `lcm(step_up, step_down)`
- round DOWN to the package step (depth-safe), then confirm both legs still clear
  the $1.00 notional floor

**Correction to the first draft of this item.** It claimed "at prices coprime to
100 that step is one whole share, so small packages will often be unbuildable."
The first half is right, the conclusion is wrong. Both per-leg steps divide 100,
so their `lcm` also divides 100 — **the package step can never exceed 1.00
share.** Swept over every tick-0.01 price pair summing under $1.00, the maximum
joint step is exactly 1.00 share. All 21 canary packages (2.808–5.495 shares) are
constructible. Buildability was never the obstacle.

**Why this was closed.** The obstacle is the *size* the lattice forces you to
give up. Snapping down to the joint step, priced at each package's own
`1 − (p_up + p_down)` margin:

| | gross locked profit, 21 canary packages |
|---|---|
| share counts as sized today | $6.73 |
| snapped down to the joint lattice | **$6.11** (−9.2%) |
| snapped to nearest within budget | $6.11 — snapping up never fits the budget |

Against a defect (item 78's unit round-trip) whose total worst-case cost over the
same 21 packages is **$0.25**, valuing every mismatched residual share at zero.
Mean residual 0.0121 shares/package; worst `pkg-btc-mtutdjae` at 0.0995 shares
($0.09). So the fix costs a **certain** $0.62 to remove an **upper-bound** $0.25
— and the residual is a naked fraction of a share that sometimes settles a
winner, so the true figure is lower still.

The staircase is worth naming, because each tread was individually reasonable:
the dollar route had a ~1¢/package flaw → item 78 moved to the share route to fix
it → the share route broke 96% of orders → item 89 proposed lattice machinery to
fix that → the machinery costs 9% of profit. Every step followed from the last
and the sequence ends below where it started. The correct move is to step back to
the dollar route and stop.

**Caveats on the numbers above, stated so they are not over-read.** All 21
packages ABORTED with no leg ever filled, so both columns are modelled on real
prices and hypothetical fills. Fees are excluded from both sides. Crucially, a
snapped-down package is *smaller*, so some would no longer clear the fee-aware
break-even gate (item 7) — not modelled, and it can only make the lattice route
look worse, never better. The comparison is thin evidence in absolute terms; it
is decisive only because the two figures differ by 2.4× in the direction of doing
nothing.

**If anyone reopens this**, the bar is: live fill data showing the dollar route's
leg-share mismatch costs materially more than $0.25 per 21 packages. Until then
the lattice is a correct piece of arithmetic in search of a problem.

**Process note.** The asymmetry was visible in vendored SDK source the whole time
— `getMarketOrderRawAmounts` rounds maker to `size`, `getOrderRawAmounts` to
`amount` — and was not cross-checked before the flag was turned on. The probe was
treated as sufficient evidence for a route whose validation it could not exercise.

---

### 90. An arb unwind issued within ~2s of leg 1's match is refused, and the retry is 2 minutes away

**Found 2026-09-17** from the item 82 receipts (domain facts §9d).

A SELL 0.39s after a matched BUY was refused: `not enough balance / allowance
… balance: 0`. The tokens settled on-chain 2.15s after the match response. For
about two seconds after "matched", the venue does not consider the shares held.

**Where that bites.** `arbEngine.ts:592-595` unwinds leg 1 inline when leg 2
fails. With leg 1 now verified synchronously (item 81) and a leg-2 FOK kill
fast-aborting (item 84), that unwind can plausibly land inside the settlement
gap:

```
leg 1 POST → "matched"            t = 0
leg 2 POST → rejected / killed    t ≈ 0.3–0.8s
unwindLeg(leg 1) → SELL           t ≈ 0.5–1.0s   ← venue: balance 0
settlement                        t ≈ 2.15s
```

`unwindLeg` handles the refusal safely (`arbEngine.ts:767-791`): position left
open, `unwindAttempts = 1`, nothing booked. But the retry comes from
`reconcilePendingPackages`, which only considers packages older than
`minAgeMs = 120_000` (`arbEngine.ts:856`, `bot.ts:661`). So a refused unwind
means **~2 minutes naked on a leg that was sellable 2 seconds later**, on 5- and
15-minute windows. Bounded: item 74a's stop-loss applies to it, item 74b's cap
covers the day, and 3 attempts (`arbUnwindMaxAttempts`) are not exhausted by
this since only the first lands in the gap.

**Uncertainty, stated.** The 2.15s gap is one sample. Timings of the leg-2
round trip are estimates, not measured. And item 84's note applies: if the
market route's kill wording isn't matched, leg 2 takes the 4.5s reconciliation
instead, which would *accidentally* push the unwind past settlement.

**Not fixed** — a timing change on the money path, needs a decision. Options,
none chosen: wait for settlement (poll wallet balance, Door A, before the
unwind sell); retry a `balance: 0` refusal inline after ~2.5s instead of
handing it to the 2-minute sweep; or lower `minAgeMs` for orphans only. The
first live leg-2 failure will show which case happens: look for `⚠️ LIVE ARB
UNWIND FAILED (attempt 1/3)` with `balance: 0`.

**Resolved by observation, 2026-09-20.** The 2026-09-18 canary produced exactly
the predicted signature — `⚠️ LIVE ARB UNWIND FAILED (attempt 1/3)` with
`balance: 0` — on both live packages, and both legs stayed naked ~121s. The
three options above are now decided against evidence: item 100 takes the third
(split the age gate), item 101 explains why the second is unsafe as stated, and
item 102 records why any fixed-interval sleep is a guess.

---

### 91. The scan loop froze for 13 hours and nothing noticed ✅ FIXED 2026-09-17 (cause unidentified)

**Found 2026-09-17** during an attended live canary. The loop stopped evaluating
markets at **05:43:39 UTC** and was still frozen 13 hours later.

**Evidence.** `arb_decision_counts` stops dead at the 05:00 bucket (counts are
written per event, so this is real, not a flush artefact). Two `/api/poly/state`
snapshots 10s apart: `scanning: true`, `scansDone: 16448` unchanged,
`lastScan: 1789623819480` (= 05:43:39Z), `halt: null`. Capital untouched: no
package opened, equity == cash.

**Mechanism.** `scan()` raises `botState._scanning` and lowers it in a `finally`.
A `finally` runs only when the pass settles, so an await that never settles holds
the flag for the life of the process; every later tick returns at the guard.

**The cause was never identified, and this item does not claim one.** Audited and
ruled out: every scan-path `fetch` (all bounded), viem RPC (8-15s), CLOB reads
(10s via the axios interceptor), the Python ML spawns (all SIGKILL on a timer),
the heuristics trainer (30s spawn timeout), and the announce path (synchronous,
no approval await). **CLOB writes are unbounded by design** and were the leading
theory — killed by `proxyUsage.writes: 0` for the whole run: the counter
increments when a request is *dispatched*, so a hung order would still have been
counted. Receipts cannot help either: `captureClobCall` writes only after a call
settles (see item 94).

**Fixed by containment, not by cure** (operator chose option B of three):

- **Watchdog** (`bot.ts:scan`): a tick finding the holding pass with no PROGRESS
  for `SCAN_STALL_MS` (30s, `ZINGER_SCAN_STALL_MS`) logs `🚨 SCAN WATCHDOG`,
  counts the stall, releases the flag and starts a fresh pass.
- **Progress, not duration** (added 2026-09-18, before deploy). The first cut
  measured total pass time, which is wrong for the situation it fires in: a pass
  covers every tradable market and each call is separately bounded (reads 10s),
  so on a degraded network a *healthy* pass can exceed any fixed total budget.
  It would have abandoned working passes exactly during a network wobble, and the
  replacement would meet the same network and be abandoned in turn. `scan()` now
  stamps a heartbeat after each phase and each market
  (`scanGuard.notePassProgress`), and the watchdog measures silence since the
  last one. Slow survives; stopped is caught within 30s of stopping. A pass the
  watchdog already abandoned cannot stamp a heartbeat — otherwise a waking zombie
  would hold the watchdog off the live pass that replaced it.
- **`/api/poly/state` exposes `passStartedAt`, `passIdleMs` and `scanStalls`**, so
  a stall is visible in one snapshot rather than two taken 10s apart.
- **Stale-pass guard** (`scanGuard.ts`): releasing the flag alone would be worse
  than the freeze — nothing can cancel the stalled pass, and it may wake holding
  pre-stall prices while a new pass sizes against the same account. Each pass
  runs inside an `AsyncLocalStorage` context carrying a generation;
  `executePendingTrade` — the funnel for every buy, arb legs included
  (`bot.ts:2958`) — refuses when its pass is no longer current. Work with no
  pass context (operator approval at `bot.ts:1440`, timers) is never stale.
- **Release is conditional**: only `ownsLoop(gen)` may clear the flag, or an
  abandoned pass finishing later would unlock the pass that replaced it.
- Sells inside `scan()` needed no new guard: `claimPositionExit` (item 84)
  already allows one sale per position.

**Rejected:** exiting on stall for a supervisor to restart — the VPS runs under
tmux with no process manager, so exiting would leave the bot dead until a human
noticed.

**Tests** — `tests/unit/scanGuard.test.ts` (9) on the policy and the zombie case;
`tests/unit/invariants.scanWiring.test.ts` (8) reads `bot.ts` to pin the wiring,
with checkers exercised against deliberately broken sources so they cannot fail
open. Mutation-checked, 9 mutants: unconditional unlock, watchdog removed, zombie
allowed to trade, no-context treated as stale, watchdog firing on an unstamped
pass, judging total duration again, zombie allowed to stamp progress, and the
market-loop heartbeat dropped — all killed. One survivor, equivalent rather than
untested: not clearing `_lastProgressAt` in `beginPass` changes nothing, because
a new pass's `startedAt` is always later than the previous pass's last
heartbeat, and the watchdog takes the max of the two.

**Still open:** the underlying hang (item 94 makes the next one diagnosable), and
the WebSocket reporting connected while silent for ~53 min (item 96).

---

### 92. A render path drained the metered proxy at ~3 requests/second ✅ FIXED 2026-09-17

**Found 2026-09-17** while diagnosing item 91. `proxyUsage.total` rose 171 in 60s
(~10,000/h) against a run average of ~350/h.

`updatePublicPaper` (`api/publicPredictions.ts`) called `syncClobBalance()`
whenever the running session was live, throttled only to 2/s. It is reached from
`buildPredictionResponse`, which serves `/api/v1/predictions`, `/paper`,
`/bot-paper`, `/pilot`, **`/data-health`** and every SSE tick — so page views and
health checks, including the ones used to diagnose item 91, spent proxy quota.

**Nothing was cached, because there is nothing to cache.** `syncClobBalance`
returns void (`trade.ts:844`): it asks the venue to re-read its own allowance.
The call site discarded the result. Removed from the render path; the bot still
makes it at startup, after every fill, and on the operator's manual sync.

At ~250k requests/day this alone would exhaust the 1 GB/month plan in well under
a week — item 61 fixed a 480/h drain, this was ~20× that.

---

### 93. A hung call is cached forever by the readiness lease ✅ FIXED 2026-09-18

**FIXED.** The in-flight entry now expires after `IN_FLIGHT_MAX_MS` (20s) instead
of `Infinity`, so a call that never settles stops being handed to every later
pass. 20s is above every leg's own timeout (reads 10s, geoblock 8s, chain 8–15s),
so a merely slow call is still shared rather than duplicated. Safe as designed:
both settle handlers write only while their entry is still current, so a
superseded call cannot clobber a newer answer. Tests in
`readinessCache.test.ts`: a never-settling leg is shared within the window, a
fresh call starts after it, and the leg recovers on the first good answer.


**Found 2026-09-17.** `leased()` (`readiness.ts:115-121`) caches the in-flight
promise with `expires: Infinity` and sets a real expiry only in the settle
handlers. Deliberate, so concurrent callers share one call — but a call that
never settles is cached forever and every later pass awaits the same dead
promise. Agreed fix: cap the in-flight lease (~20s) so a fresh call can start.
Safe as designed: a superseded entry only writes its outcome when
`_memo.get(key) === entry`, so a late zombie cannot clobber a newer answer.

---

### 94. A call in flight leaves no trace, and writes are unbounded ✅ FIXED 2026-09-18

**FIXED, both halves.**

- **`phase: 'request'` receipt before dispatch** (`clobReceipts.ts`). A request
  with no matching response or throw is now itself the diagnosis — the record
  item 91 needed and did not have.
- **Writes bounded** at `WRITE_TIMEOUT_MS` (15s, `CLOB_WRITE_TIMEOUT_MS`), vs 10s
  for reads. The old exemption traded "unknown fill" against "hangs forever";
  item 80's reconciler answers the first, and item 91 showed the second is not
  the safe end — there is no supervisor to notice.

**The exit-path check item 94 asked for, done:** every live sell clamps to actual
wallet inventory first (`pmSharesForPosition`), and a failed sell leaves the
position open. So a sell that times out but did fill leaves a position whose
inventory is now zero, and the next pass reconciles it
(`reconcileLiveGhostPosition`) instead of selling twice. `unwindLeg` already
retried on failure, and a duplicate sell is refused by the venue for shares no
longer held.

**Cost:** receipt volume roughly doubles on order paths (request + settle). These
are per-order, not per-scan, so the rate stays low — but it brings item 50's
rotation (two 4 MB generations, third discarded) closer.

Tests: `clobReceipts.test.ts` — a hung call leaves exactly one `request` receipt
and nothing else until it settles; request/throw pairing.
`proxyRequestCounter.test.ts` now pins that a write is bounded *more loosely*
than a read rather than left unbounded.


**Found 2026-09-17.** `captureClobCall` (`clobReceipts.ts:128`) writes a receipt
only on response or throw, so a hung call records nothing — which is why item
91's cause could not be found. Agreed fix: a `phase: 'request'` receipt before
dispatch, plus a ~15s timeout on CLOB writes (`MONEY_PATHS`, `proxyEnv.ts:63`).
Bounding writes was correctly refused before item 80: a timed-out order used to
mean "unknown fill". `reconcileArbLeg` now answers exactly that. **To verify when
implementing:** each exit path's behaviour when a sell times out but did in fact
fill — on the arb unwind the retry is refused for shares no longer held, but the
other sell sites need walking.

---

### 95. Two scan implementations, and the live one contradicts item 60 ✅ CLOSED 2026-09-18 — both decided, quarantine only

**CLOSED by operator decision, no behavioural change.**

**Decision 1 — do NOT wire `scan/index.ts`.** It stays quarantined behind the
header banner added 2026-09-18, which states it has no caller and that editing it
changes nothing at runtime. Deleting it remains available and is not urgent.

**Decision 2 — keep `refreshTelemetry()` in the scan loop** (`bot.ts:2655`),
despite item 60. Rationale: do not alter the money path immediately before a
canary run. The contradiction is recorded rather than resolved.

That call site is no longer able to hang the loop indefinitely, which is what
made keeping it acceptable: item 93 caps a shared in-flight leg at 20s, reads are
bounded at 10s, and item 91's watchdog takes the loop back at 30s.

**Revisit after the canary:** whether the loop should read readiness rather than
refresh it, as item 60 intends.


**Half done 2026-09-18.** `scan/index.ts` now carries a header saying it is not
wired and that editing it changes nothing at runtime — the trap was silent, and
it now announces itself. Deleting it is a decision about the refactor, not a
cleanup, so it stays.

**Decision 1: delete `scan/index.ts`, or wire it?** It is the finished slice-2
extraction. Leaving it costs nothing but confusion; wiring it would move the
watchdog and stale-pass guard (item 91) into it too.

**Decision 2: should `bot.ts:scan()` keep refreshing readiness every pass?**
`await refreshTelemetry()` at `bot.ts:2655` contradicts item 60 ("the scan loop
is a reader; the 30s timer owns readiness"). The lease absorbs the network cost,
so the quota is safe — but it puts a network call site *inside* the pass, which
is the class of thing that froze the loop, and since item 59 it can also await
the proxy probe. Removing it makes readiness up to 30s stale for sizing, which
item 60 says is intended and the affordability gates already handle. Not changed
here: it alters freshness on the money path.


**Found 2026-09-17.** `src/polymarket/scan/index.ts` (`executeScanCycle`) is
referenced nowhere; the live loop is `bot.ts:scan()`. Edits to the tidied module
change nothing. Separately, the live loop calls `await refreshTelemetry()` every
pass (`bot.ts:2655`), which item 60 states it must not: the lease cache absorbs
the network cost, so the quota is safe, but the design and the code disagree, and
since item 59 that call can also await the proxy probe.

---

### 96. The CLOB WebSocket reports connected while silent ✅ FIXED 2026-09-18

**FIXED.** `readyState` describes the socket, not the feed, and a half-open
connection stays OPEN indefinitely — so the stream reported `connected: true`
with its last message 53 minutes old while every book aged out. The existing
ping proved nothing, because nothing checked for a reply.

- `isStreamStale()` (pure, exported): connected **and** subscribed **and** silent
  longer than `STALE_MS` (120s, `CLOB_WS_STALE_MS`). A stream that just connected,
  one with nothing subscribed, and a disconnected one are each excluded — those
  are different faults.
- The existing ping timer now closes a stale socket, taking the existing
  reconnect path rather than adding a second one, and counts `staleReconnects`.
- `lastMsgAt` is stamped on open, so a fresh socket is not judged on the previous
  connection's traffic.
- `/api/v1/data-health` reports `stale` and `staleReconnects` beside `connected`.

Tests in `clobWsBook.test.ts`, including the observed 53-minute case.


**Found 2026-09-17.** `/api/v1/data-health` showed `connected: true`,
`subscribed: 24`, `books: 80`, `lastMsgAgeMs: 3192169` (~53 min). A silent socket
that still reports connected makes every book stale without anything saying so —
and stale books are what item 70 was about. The feed is direct, not proxied, so
this is independent of items 91/92. Needs a staleness threshold that marks the
feed unhealthy, and a reconnect.

---

### 97. Leg 2 is signed from a scan-time quote taken before leg 1 was dispatched

**Found 2026-09-20** from the 2026-09-18 canary. Both live packages filled UP
and lost DOWN. That is not symmetry — leg 2 is structurally the exposed one.

The legs are sequential, and the code says so (`arbEngine.ts:571-573`): *"UP
executes first and DOWN only runs `if (upShares > 0)`."* Leg 2 is then priced
from `downAsk`, the value captured during the scan, and the book is never
re-read before signing (`arbEngine.ts:467-469`). A 40ms nonce sleep sits between
them (`:456`).

```
t=0       scan quotes upAsk + downAsk
t=0       leg 1 (UP) dispatched        ─┐ full proxy round trip
t≈750ms   leg 1 returns "matched"      ─┘
t≈790ms   40ms nonce sleep (:456)
t≈790ms   leg 2 (DOWN) signed at downAsk  ← quote already ~800ms old
t≈1.5s    leg 2 reaches the matching engine
```

So DOWN carries leg 1's entire round trip as staleness *before* paying its own
transit: roughly 1.5s of drift exposure against leg 1's 0.75s. `maxPrice` is
signed at exactly that stale ask (`bot.ts:1143`, from `plan.entryPrice` at
`bot.ts:1055`) with no tolerance, so a single tick of upward drift leaves zero
shares at or below the bound and the FOK dies with the book untouched.

**This explains both failure shapes.** The 2026-09-18 BTC kill asked for 5.32
shares against a 109.3-share book — 5% of top of book. Depth cannot explain
that; price drift can. The ETH kills are the other shape: sized at exactly
`0.90 × bestAskSize` (`arbEngine.ts:262,284`) on 5–15 share books, where a
competing taker of half a share is enough.

**Three options, none chosen.** Each spends something different:
- *Price buffer* — sign leg 2 at `bestAsk + 1 tick`. Spends edge. Also lifts the
  reachable book past top-of-book, which is the premise `DEPTH_UTILISATION`
  rests on (`arbEngine.ts:248-262`), so it helps the thin-book case too.
- *Re-read the DOWN book after leg 1 fills.* Spends no edge; costs one more
  call on the metered proxy and still leaves leg 2's own transit exposed.
- *Both.*

**If a buffer is chosen, budget it at the gate.** The decision currently tests
`gap > breakEven + margin` before any buffer is spent. Spending a cent
afterwards can land the fill under break-even with nothing having re-checked.
The gate needs `gap − buffer > breakEven + margin`. Worked example, the
2026-09-18 BTC book (up $0.48, down $0.46): gap 6.00%, break-even 3.486%
(`arbBreakEvenGap`, `fees.ts:134-146`), live margin 1.0% (`modeConfig.ts:190`)
→ 1.5¢/share of headroom. One tick fits; two do not.

**Note the economics are asymmetric.** Once leg 1 has filled, the alternative to
paying up is not "no trade" — it is holding a naked directional leg. A cent of
edge is cheap against that, so the buffer should be sized by what it takes to
fill, not by what keeps the package nominally profitable.

**Stale references, while here.** `arbEngine.ts:234` and `:250` both cite
`bot.ts:1011` as where `maxPrice` is signed. It is `bot.ts:1143` now.

---

### 98. A post-close orphan is sold at a discount when it should be redeemed

**Found 2026-09-20** from the 2026-09-18 BTC trade (VPS ledger, secondary).

`btc-updown-5m-1789716600` ran 07:30:00–07:35:00 UTC — the slug epoch is the
window *start* (`windows.ts:4`) and 5m is 300s (`config.ts:22`). The orphan was
sold at 07:36:34, **94 seconds after the window closed**, at $0.99.

That $0.99 is not a price the unwind negotiated; it is a resolved market
converging on redemption. And `arb_rollback` is deliberately excluded from
`FEE_FREE_EXIT_REASONS` (`arbEngine.ts:801-803`), so the sale paid a taker fee
that redemption would not have. Holding 9.3472 shares to redemption pays exactly
$1.00/share, fee-free; selling paid $0.99 less $0.00648. Cost of the wrong
action: ~$0.10.

**The general case.** After window close an orphan is one of two things, and the
unwind is wrong for both:
- *winning* → worth $1.00 at redemption, sold at a discount plus fee
- *losing* → worth $0.00, and the sell is futile

`unwindLeg` has no notion of the window at all. `arbEngine.ts` contains no
reference to window end, time remaining, or `marketWindow()` — which
`windows.ts:48` already exports.

**Not fixed** — the branch is small (post-close orphans hold to redemption
rather than unwind) but it changes money-path behaviour and interacts with item
74a's stop-loss, which currently owns the orphan.

---

### 99. Nothing stops a package opening seconds before its window closes

**Found 2026-09-20.** The 2026-09-18 BTC package entered at 07:34:33 against a
window closing 07:35:00 — **27 seconds of window left**.

For a package that locks, this is harmless: both legs redeem to $1.00 whenever
the window ends. For a package that orphans, it is the worst possible moment.
The orphan path — abort, reconcile, unwind, retry — is built to manage exposure
over seconds to minutes, and there is no time for any of it. The position
resolves before the machinery can act, which converts a managed directional
exposure into an unmanaged coin flip.

Note what this means for the 2026-09-18 result: the +41.4% was a 70/30 bet
settling in 27 seconds, not a directional read. Fair odds, zero edge, full
variance — the opposite of what an arb package exists to produce.

`arbEngine.ts` has no time-to-close check (grepped 2026-09-20: no `windowEnd`,
`secondsLeft`, `windowSeconds` or `marketWindow` reference).

**Not fixed.** A minimum-seconds-remaining gate is a few lines, but the
threshold is a real decision and should be derived from the orphan path's
actual latency — abort plus settlement-credit plus one retry — not guessed.

**Unblocked 2026-09-20** by items 100 and 101. That latency is no longer ~121s;
it is the orphan gate (5s) plus however long the venue takes to credit, retried
until it does. The next live orphan measures it, and the gate should be set from
that measurement rather than from the old figure.

---

### 100. One age gate serves two jobs with different safety requirements ✅ FIXED 2026-09-20

**FIXED.** The predicate is split. `reconcilePendingPackages` now filters twice
from one unfiltered `mine` list: `PENDING_FILL` against `minAgeMs` (120s,
unchanged — it is a real interlock), `ABORTED` against a new `orphanMinAgeMs`
(5s, `arbOrphanReconcileMs`, wired at `bot.ts:656-660`).

Not zero, deliberately: the inline unwind at the end of dispatch runs first, and
the gate keeps the sweep from racing it for the same leg.

Invariants in `tests/unit/invariants.orphanUnwind.test.ts` — the orphan is
reconciled without serving the interlock, a fresh abort is still left alone, and
a young `PENDING_FILL` package is still untouched. Verified load-bearing: with
the gate restored to 120s the first of those fails.

**Found 2026-09-20.** This is the measured cause of the 121s and 123s orphan
hold times on 2026-09-18, and it refines item 90.

`reconcilePendingPackages` filters every package through one predicate
(`arbEngine.ts:870-872`):

```js
const all = loadPackages().filter((p) => (
  p.mode === mode && (now - Number(p.createdAt || 0)) > minAgeMs
));
```

`minAgeMs` is `arbPendingReconcileMs ?? 120_000` (`bot.ts:656`); no config sets
it, so it is 120s. Both consumers read from `all`:

1. **`PENDING_FILL` promotion.** Here 120s is correct and the comment says why
   (`arbEngine.ts:854-856`): it must outlast a dispatch, or the sweep could
   abort a package whose legs are still in flight.
2. **Orphan retry on an `ABORTED` package.** Here the rationale does not apply
   at all. The package has already resolved; nothing is in flight. It is held
   naked for 120s for a reason that belongs to the other case.

The sweep cadence is not the delay. `arbHousekeeping('scan')` runs on every scan
pass (`bot.ts:2710`) and calls `reconcilePendingPackages` unthrottled — the 30s
`SWEEP_INTERVAL_MS` (`bot.ts:579`) gates only `sweepUnrecordedHoldings`, the item
80 wallet sweep. At ~1.35 passes/sec the reconciler therefore ran some 160 times
during the 121s hold and declined to act every time, because the age filter hid
the package from it. The gate is the entire delay.

*(Corrected 2026-09-20: first written as though the 30s throttle applied to the
reconciler. It does not. The conclusion is unchanged and the mechanism is
simpler — nothing was waiting on a timer.)*

**Fix shape.** Split the predicate: keep 120s for `PENDING_FILL`, use a short
age (~5s) for orphan candidates. No new timing assumption, no blocking inside
the dispatch path. This is item 90's third option and, with item 101, the
reason the first two are not needed.

---

### 101. `unwindAttempts` spends a permanent-failure budget on a transient one ✅ FIXED 2026-09-20

**FIXED.** The refusal is classified before it is charged.

- `isSettlementCreditRefusal()` (pure, exported): the venue's `balance: 0`
  wording specifically. A *partial* balance is not it — shares exist and
  something else is wrong — and an unrecognised message is treated as permanent,
  which costs a retry rather than an unbounded loop.
- A credit refusal no longer touches `unwindAttempts`. It increments
  `unwindCreditRefusals` and is bounded on **wall clock** instead
  (`arbUnwindCreditGraceMs`, 60s) — deliberately not on attempts, because the
  length of the credit gap is unmeasured (item 102), and any attempt count would
  encode a guess about a distribution we have not sampled.
- A successful sell clears the grace clock, so a later refusal is judged as its
  own fault rather than inheriting a spent window.
- New log line `⏳ LIVE ARB UNWIND DEFERRED` at `system`, not `error`: waiting
  for settlement is expected behaviour, and the existing `error` line was what
  made a normal credit gap read as a failure.

Invariants in `tests/unit/invariants.orphanUnwind.test.ts`, including the
property this must not weaken — an unsellable leg still spends the budget and
still stops emitting live orders (backlog 34). Verified load-bearing: with the
classifier forced to `false`, the retry invariant fails.

**Found 2026-09-20.** This is why the obvious fast-retry fix is unsafe, and it
should be settled before item 100 is implemented.

`arbUnwindMaxAttempts` defaults to 3 (`arbEngine.ts:781`). Every refusal
increments the counter (`:782`), `unwindBlocked` latches at 3 (`:785`), and the
orphan sweep then skips the position permanently (`:885`), logging *"STILL HELD
and will settle at expiry"* (`:790`).

That cap exists for a genuinely unsellable leg — no bid at any price, an expired
window — which is a **permanent** condition where emitting a live order every
tick forever is the failure being prevented (backlog 34).

`balance: 0` is a **transient** condition. Domain facts §9d: the venue does not
treat bought shares as held until on-chain settlement, and it clears on its own
in seconds.

Both consume the same budget. So the fix that suggests itself — an inline
backoff at 3s/6s/10s — would have destroyed both 2026-09-18 wins:

```
1.9s   attempt 1 → balance: 0
3.0s   attempt 2 → balance: 0
6.0s   attempt 3 → balance: 0   → unwindBlocked
                                → sweep skips it forever
                                → naked leg held to expiry
```

The observed runs survived *because* only one attempt was burned, leaving two in
the budget for the sweep at 121s. A retry loop that exhausts the budget inside
the credit window disables the fallback that worked.

Two further reasons not to take that shape: `unwindLeg` is called inline from
the dispatch path, so a 3+6+10 backoff puts up to 19s of blocking sleep back
into the scan loop — which is what item 84 removed. And "the tokens will have
settled by second 5" is a guess; see item 102.

**Fix shape.** Classify the refusal. A `balance: 0` rejection should not count
against `unwindAttempts`, or better, the retry should be gated on *observed*
balance via the Door A/B machinery item 80 already built (`arbReconcile.ts`) —
evidence rather than a sleep.

---

### 102. The settlement-credit gap is wider than §9d's single sample ✅ CLOSED 2026-09-20

**CLOSED.** Both samples are folded into §9d's confidence note in
`docs/research/polymarket-domain-facts.md`, where the fact lives. Item 101 acts
on the consequence: the credit wait is bounded on wall clock rather than on any
assumption about how long the gap is.

Note `docs/research/` is gitignored (`.gitignore:53`), so that edit is on disk
but untracked — it will not survive a fresh clone and appears in no diff.

**Found 2026-09-20.** Domain facts §9d rests on one observation — a SELL 0.39s
after a match refused with `balance: 0`, settling on-chain 2.15s after the match
response — and states the limit plainly: *"Confidence: High for this order; the
length of the gap is one sample."*

The 2026-09-18 canary adds two refusals (VPS ledger, secondary source):

| package | entry | first unwind | Δ | result |
|---|---|---|---|---|
| `pkg-btc-mu6n7tdc` | 07:34:33.075 | 07:34:34.982 | 1.91s | `balance: 0` |
| `pkg-eth-mu6onvgn` | 08:15:01.898 | 08:15:04.745 | 2.85s | `balance: 0` |

Both are *failure* timestamps, so the requests left earlier — but the ETH
refusal was recorded 0.7s past §9d's settlement time, which the single sample
does not account for.

This does not overturn 9d. It does mean any fix that sleeps a fixed interval and
then sells is guessing, including item 90's "retry inline after ~2.5s" — which
would have failed on ETH. Argues for item 101's balance-gated retry over any
timer.

**Action:** fold these two samples into §9d's confidence note in
`docs/research/polymarket-domain-facts.md` so the band is recorded where the
fact is, not only here.

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
