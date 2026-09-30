# Refactor conventions (keep these — load-bearing)

> Verbatim from the 2026-08-20 handoff. They prevent repeats of `cccce43` (fluent, plausible, green, wrong).

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
