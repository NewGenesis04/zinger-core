# Live-data facts + domain facts pointer

- **Polymarket semantics: `docs/research/polymarket-domain-facts.md` is the authority.** Anything not in there is unverified — check the live API before relying on it.
- State source of truth: `data/zinger.db` (SQLite `docs` table). Local `data/` is NOT the VPS instance.

> --- STALE SNAPSHOT (2026-08-20 audit, kept so numbers are not re-derived) ---

### Known live-data facts (do not re-derive)

- VPS: 31 packages · 13 trades · 13 positions. Paper bankroll $100.70, which is
  **correct** — it is the pre-reconcile fee-aware value.
- `pkg-btc-msyglw8m` is stuck `PENDING_FILL` with a naked UP leg, 40h+ as of the
  audit. It is the live instance of items 8 and 9.
- 24 of 31 packages are orphaned from their trades (item 24); 15 settled orphans
  report $4.65 of fee-blind profit via the `lockedProfitUsd` fallback.
- The VPS sets no `ZINGER_DATA_DIR`, `ZINGER_DB_PATH` or `ZINGER_SQLITE`.
