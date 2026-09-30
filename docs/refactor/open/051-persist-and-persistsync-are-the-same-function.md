> Open item 51 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

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
