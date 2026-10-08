# Open backlog — map (hot: load this, not the items)

New structural findings append as new per-item files in `docs/refactor/open/` (with `file:line` evidence) plus one row here. When fixed, move the content to `archive/fixed-items.md`.
16 open items, sorted 2026-09-30 by an audit of every `open/` file against `git log` and the code. Read the row you need, then open that file — do not load the whole set.

Strategy focus: **directional** (operator abandoned arb, 2026-09-30). Arb items are parked, not closed.

## A. Directional — do these first

| Item | Title | State | File |
|---|---|---|---|
| 42 | Alpha fusion replaces the numbers every directional gate reads | Watch note, not a defect. Items 41, 123 and 124 have each changed what directional entries score on (real book imbalance, no arb terms, one deterministic fusion book). Compare paper entry rate and confidence before/after and record it here before live | `docs/refactor/open/042-alpha-fusion-replaces-the-numbers-every-directiona.md` |

## B. Live-money infrastructure and accounting

| Item | Title | State | File |
|---|---|---|---|
| 131 | Paper fills ignored the order book: entry size, exit price, take-profit at the ask, 5-share minimum | Implemented in the working tree (uncommitted), filed 2026-10-08; live from the next session. Residual: sell-minimum unverified (needs a live canary); 0.4 participation and 5-tick exhaust are assumptions | `docs/refactor/open/131-paper-fills-ignored-the-book-entry-size-exit-price-and-minimums.md` |
| 130 | Paper stop-losses fill at the stop price, not the bid | Fixed in the working tree (uncommitted), filed 2026-10-08; live from the next session. `bot.ts:1933-1945`, `3535-3537`. Re-pricing the latest 500 trades' stops at the recorded bid removes ~$1,591 against +$1,352 gross | `docs/refactor/open/130-paper-stop-losses-fill-at-the-stop-price-not-the-bid.md` |
| 129 | Paper PnL is kept in two ledgers with different conventions, and paper stops never pay an exit fee | Fixed in the working tree (uncommitted), filed 2026-10-08; live from the next session. Residuals: `cashAudit.ok` still independent of the reconcile; live partial PnL unchanged. `audit.ts:28-37` vs `:60`, `sessionLedger.ts:155-157`, `bot.ts:~2884`/`~3183` (no exit fee on stops, ~$3,058), `bot.ts:3605-3611`/`3707` (partial fee overwrite). $5,763 drift on the live paper session | `docs/refactor/open/129-paper-pnl-lives-in-two-ledgers-and-stops-pay-no-exit-fee.md` |
| 128 | Other chain callers still use a single RPC endpoint | Open, filed 2026-10-02. `server.ts:111`, `trade.ts:25`, `swap.ts:8`, `deposits.ts:9`, `api/pilotLedger.ts:16` | `docs/refactor/open/128-other-chain-callers-still-use-a-single-rpc-endpoint.md` |
| 32 | The live order path has type checking disabled | Open. `trade.ts:1` still `// @ts-nocheck`; 69 `src` files carry it | `docs/refactor/open/032-the-live-order-path-has-type-checking-disabled.md` |
| 122 | The Polygon RPC host is hardcoded in six places and the env override reaches only three | Residual only. Server side fixed in `591ec65`; `frontend/src/walletAuth.tsx:21` still hardcodes it (needs a `VITE_` variable) | `docs/refactor/open/122-the-polygon-rpc-host-is-hardcoded-in-six-places-an.md` |
| 48 | The D8 decision-emitter tee plan, checked against the code | Implemented (Steps A–F). Stays here for one verification gap: nothing proves exactly one `position.exit` per exit and one `trade.execution` per trade. Blocked on D4 | `docs/refactor/open/048-the-d8-decision-emitter-tee-plan-checked-against-t.md` |
| 50 | The receipt log keeps two generations and silently discards the third | Open. `clobReceipts.ts:106-107` renames onto `.1` | `docs/refactor/open/050-the-receipt-log-keeps-two-generations-and-silently.md` |
| 51 | `persist` and `persistSync` are the same function | Open. Belongs with the D5/D4 store work | `docs/refactor/open/051-persist-and-persistsync-are-the-same-function.md` |
| 67 | Capital Ledger: decouple deposits/withdrawals from trading PnL | Open. UX and accounting design, nothing built | `docs/refactor/open/067-capital-ledger-decouple-external-deposits-withdraw.md` |
| 112 | Scan throughput fell to a third mid-run, cause unknown | Open investigation. Proxy ruled out; awaits next occurrence with item-111 socket lines | `docs/refactor/open/112-scan-throughput-fell-to-a-third-mid-run-cause-unkn.md` |

## C. Arb — parked (operator abandoned arb, 2026-09-30)

Paper keeps running as the regression detector (D6/D7). Revisit only if arb returns.

| Item | Title | State | File |
|---|---|---|---|
| 121 | The first post-118/119 loss ran on REST books, and the residual now carries the P&L | Parallel read applied (`591ec65`), which also serves directional. Stop-arb, coherence gate and fault counter are moot. Structural conclusion: arb has no positive-expectancy state (research §11) | `docs/refactor/open/121-the-first-post-118-119-loss-ran-on-rest-books-and.md` |
| 31 | A leg-parity residual is recorded but never trimmed | Parked. The residual is no longer sub-share (item 121 §2) | `docs/refactor/open/031-a-leg-parity-residual-is-recorded-but-never-trimme.md` |
| 77 | Raising `arbMaxUsd` alone cannot raise the arb budget | Parked. Sizing note | `docs/refactor/open/077-raising-arbmaxusd-alone-cannot-raise-the-arb-budge.md` |
| 83 | The arb sizing gate computes on a finer grid than the venue accepts | Parked. Latent; point 3 moot | `docs/refactor/open/083-the-arb-sizing-gate-computes-on-a-finer-grid-than.md` |

## Gaps found by the audit

- **Item 117 has no write-up anywhere.** Items 118 and 111's commit (`23dd2ca`, 'Item 117') cite it (socket drops ~1.5x/minute), but there is no `open/` or archive entry. Either write it up or note that it lives only in the commit.
- Every 'Fixed … (uncommitted)' note in the moved items is now committed; the archive note records the commit for each.
