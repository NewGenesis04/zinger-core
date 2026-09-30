> Open item 122 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

### 122. The Polygon RPC host is hardcoded in six places and the env override reaches only three

**Found 2026-09-29**, from a VPS log showing a Cloudflare 520 from
`polygon-bor-rpc.publicnode.com` on an `eth_blockNumber` call.

**a. `POLYGON_RPC_URL` does not reach the paths that matter.** Three modules
honour it — `deposits.ts:9`, `swap.ts:8`, `pilotLedger.ts:16`. Three hardcode
the host and ignore it entirely:

| site | what it serves |
|---|---|
| `server.ts:110` | the app's shared `publicClient` |
| `trade.ts:25` | the wallet client built at `trade.ts:45` (order *signing* is local EIP-712, so this transport is only exercised by chain-level calls — narrower than "the order path", but still unconfigurable) |
| `readiness.ts:23` | the live-readiness gate (four concurrent calls, `readiness.ts:242`) |

`frontend/src/walletAuth.tsx:21` hardcodes it too. So the single most obvious
mitigation for a flaky public RPC — repoint it — cannot be applied by
configuration to the order path or the readiness gate. Note the two spellings
now in play: the hardcoded sites use `polygon-bor.publicnode.com`, while
`.env.example:37` suggests `polygon-bor-rpc.publicnode.com`, which is what the
VPS is evidently set to. That mismatch is how the log identifies which call
failed.

**b. The deposit scanner turns every RPC blip into an unhandled rejection.**
`scanForDeposits` (`deposits.ts:50`) has a try/catch, but it starts at line 59 —
`await client.getBlockNumber()` on line 52 is **outside** it. And
`startDepositScanner` (`deposits.ts:118-121`) dispatches it fire-and-forget:

```js
scanForDeposits();                                 // no await, no .catch()
_scanTimer = setInterval(scanForDeposits, SCAN_INTERVAL);
```

`setInterval` discards the returned promise, so each failing tick produces one
unhandled rejection. Consequence today is **log noise, not a crash**:
`index.ts:16-21` installs `uncaughtException` and `unhandledRejection` handlers
that log and continue. The VPS log proves it — the 520 is followed by six more
socket reconnects from the same process.

Worth fixing anyway: `Unhandled:` lines in the log train the operator to ignore
the one category of message that should never appear, and the fix is to move
line 52 inside the try and attach a `.catch()` at both dispatch sites.

**Not an arb defect** — this is infrastructure, unaffected by item 121, and it
applies equally to whatever strategy the bot runs next.

**Fixed 2026-09-29 (uncommitted), operator go-ahead.** Two parts:

- `POLY.polygonRpc` (`config.ts`) is now the single owner of the endpoint,
  reading `POLYGON_RPC_URL` with the same override shape `clobApi` already
  used. All six call sites import it: `server.ts:111`, `trade.ts:25`,
  `readiness.ts:23`, `deposits.ts:9`, `swap.ts:8`, `pilotLedger.ts:16`. The
  readiness gate and the order path can now be repointed to a paid RPC by
  configuration alone. `frontend/src/walletAuth.tsx:21` is left hardcoded —
  it is a browser bundle and needs a `VITE_`-prefixed build-time variable,
  which is a separate change.
- `scanForDeposits` wraps the block-number read in its own try (`deposits.ts`),
  and `startDepositScanner` dispatches through a `tick()` wrapper that attaches
  `.catch()` at both the immediate call and the interval. An RPC outage now
  costs a skipped pass instead of one `Unhandled:` line per tick.
