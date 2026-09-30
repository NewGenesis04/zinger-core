# Refactor slices 0–3 (historical narrative)

> Verbatim extract. Slices are complete; kept for history, not loaded by default.

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
