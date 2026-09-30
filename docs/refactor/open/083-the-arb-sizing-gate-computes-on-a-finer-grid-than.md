> Open item 83 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

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
