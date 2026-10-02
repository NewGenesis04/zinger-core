> Open item 125 — filed 2026-09-30.

### 125. A failed deposit-wallet owner read blocks live for an hour, and the message blames the key

**Found 2026-09-30**, from the live dashboard: `Live blocked — Deposit wallet owner null is not bot signer 0x2FA8…125d — export that wallet's private key into Zinger`.

Three defects on one path, each sufficient to produce that banner with nothing wrong in the wallet.

**1. "No answer" is reported as "not the owner".** `readDepositWalletOwner` (`readiness.ts:29-37`) returns `null` on any exception (RPC error, timeout, a Cloudflare error page) and also when the reply is empty or shorter than 42 characters (`:32`). `checkReadiness` then computes `ownerMatches = !!depositOwner && ...` (`:298`), so `null` is `false`, and `liveReady` requires it (`:451`). The blocker text at `:491` interpolates the raw value, which is how `owner null` and the instruction to export a private key reach the operator. A genuine mismatch prints an address; `null` means the read produced nothing. This is the same class as items 104 and 113 ("no answer" turned into a fact), on the readiness gate.

**2. The failure is cached for 60 minutes.** The read is wrapped in `leased('depositOwner', ...)` with `() => TTL.depositOwner` (`:251`, `TTL.depositOwner = 60 * MINUTE` at `:96`). `leased` sets the expiry from the settled *value* (`:150-155`), and the failure backoff (1m → 15m, `:156-161`) only runs when the promise *rejects*. `readDepositWalletOwner` never rejects, so a `null` counts as a success and is held for the full hour. Compare `positions` at `:262`, which does `v == null ? POSITIONS_RETRY_MS : TTL.balances`; `depositOwner` has no equivalent.

**3. The Sync button cannot clear it.** `POST /api/poly/sync` calls `syncBalances({ force: true })`, which calls `invalidateBalanceCache` (`bot.ts:2699`); that deletes only `clobBalance`, `depositPusd` and `positions` (`readiness.ts:176`). The `depositOwner` entry survives, so the operator's only recovery inside the app is waiting out the hour. A process restart clears it (the memo is in memory), and the bot runs under tmux with no supervisor.

**What can make the read null** (not yet distinguished for the 2026-09-30 occurrence): the Polygon RPC failing or timing out (`getClient()` uses `POLY.polygonRpc`, the public endpoint that returned a Cloudflare 520 in item 122), or `owner()` (selector `0x8da5cb5b`) returning empty because the address has no contract answering it. `GET /api/poly/readiness` and one `eth_call` against the configured RPC tell them apart.

**Not fixed.** This is the live readiness gate, so the change is the operator's call. Direction: make the read return a distinct "unknown" instead of `null`; on unknown, hold `liveReady` false but with a message that says the read failed and is being retried, and cache it briefly with the existing backoff; have `force` delete `depositOwner`. The invariant to pin: a failed read is never reported as a mismatch and is never cached longer than the failure backoff.
