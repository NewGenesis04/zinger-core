> Open item 77 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

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
