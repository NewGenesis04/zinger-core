> Open item 50 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

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
