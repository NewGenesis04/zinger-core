> Open item 32 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

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
