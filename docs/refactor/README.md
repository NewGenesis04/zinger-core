# Refactor — index (hot: read this, not the archive)

The old `docs/refactor-plan.md` (7,100+ lines) is split so context stays small.
**This file + the map are the only things to load by default.**

## Where to look

| Question | Open |
|---|---|
| What are the settled decisions / objectives? | `docs/refactor/charter.md` — Why + Objectives 1–4 + D1–D11. **Settled.** Do not re-derive or quietly diverge. |
| What rules prevent repeats of `cccce43`? | `docs/refactor/conventions.md` — fixtures vs audits, `it.fails()`, derive money from primitives, prove behaviour-neutral moves, mutation-test invariants. |
| What is verified Polymarket truth? | `docs/research/polymarket-domain-facts.md` (authority) + `docs/refactor/live-facts.md` (pointer + stale 2026-08-20 snapshot). Anything not in the research doc is unverified. |
| What work is still open? | `docs/refactor/open-backlog.md` — map of 12 open items (sorted 2026-09-30: directional / infrastructure / arb-parked). Open only the per-item file you need in `docs/refactor/open/`. |
| What did we already fix, and why? | `docs/refactor/archive/` — `fixed-items.md` (114 closed), `slices.md`, `handoff-2026-08-20.md` (stale). Grep here before re-deriving; never load whole. |

## Context budget

Hot set: this file (~2KB) + `open-backlog.md` (~6KB) + `conventions.md` (~2KB) ≈ 10KB.
Charter (~20KB) on planning tasks. Per-item files (~2–30KB) one at a time.
Archive (~250KB) never loads whole — grep it.

## Adding findings

Structural findings go to `docs/refactor/open/` as a new per-item file (with `file:line` evidence) + one row in `open-backlog.md`'s map. When fixed, move the file's content to `archive/fixed-items.md`. Do not append to the archive directly and do not fix inline.
