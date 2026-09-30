# Zinger refactor — charter (settled, do not re-derive)

> Verbatim extract from `docs/refactor-plan.md` (Why + Objectives + D1–D11). Decisions are settled — to change one, say so explicitly and get agreement.

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
