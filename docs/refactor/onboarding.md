# Operator onboarding — deploying and monitoring Zinger on the VPS

For a second operator with sudo on the VPS. The bot is currently in **paper**
mode. This file is in a **public** repo: it names where secrets live, never
their values, and never the host address. Get those from the operator's
password-manager share.

## 1. Who owns what

```
                         ┌──────────────── VPS: /opt/apps/ZINGER ────────────────┐
                         │                                                       │
  tmux session "zinger" ─┼─► npm start (tsx index.ts) ── one Node process        │
                         │      │                                                │
                         │      ├─ reads  .env               (all API secrets)   │
                         │      ├─ reads  data/wallet.json   (signer private key)│
                         │      ├─ owns   data/zinger.db     (all bot state)     │
                         │      └─ serves :3000  (/ops viewer, operator console) │
                         └──────┬───────────────┬───────────────┬────────────────┘
                                │               │               │
               CLOB API via Webshare proxy   direct:          Telegram bot
               (CLOB_PROXY_URL; the VPS is   Polygon RPC,     (alerts + commands,
               geoblocked without it)        Binance, market  calls back into :3000)
                                             WebSocket
```

- **The Node process owns all state.** `data/zinger.db` (SQLite, `docs`
  table of key/value JSON) is the source of truth. The `.json` files beside
  it are stale leftovers (backlog item 14). Don't edit the DB while the bot
  runs.
- **Nothing supervises the process.** There is no systemd unit and no pm2.
  If it crashes, exits or the box reboots, it stays down until someone
  restarts it in tmux. Stalls are recovered in-process by a watchdog, so
  don't add `process.exit`-and-restart logic unless a supervisor is added
  first. That would be a separate decision.
- The VPS sets no `ZINGER_DATA_DIR` / `ZINGER_DB_PATH`, so data lives in
  `/opt/apps/ZINGER/data/`.

## 2. Credentials: where each one lives

You have sudo, so everything on the box is readable. The table says where to
look. Accounts **off** the box come from the operator.

| Credential | Lives in | Notes |
|---|---|---|
| Dashboard operator password | `.env` `AUTH_PASSWORD` (alias `ZINGER_PASSWORD`) | Full console. Zinger-only, not a system login (`src/lib/auth.ts:11`) |
| Dashboard viewer password | `.env` `READONLY_PASSWORD` | `/ops` only: no writes, no wallet/state/audit reads (`src/lib/auth.ts:15-40`) |
| Session signing secret | `.env` `AUTH_SECRET` | Rotating it logs everyone out |
| Signer private key | `data/wallet.json` (`src/lib/wallet.ts:6`); env `POLYMARKET_PRIVATE_KEY` / `PRIVATE_KEY` | Controls real funds. Never copy off the box |
| CLOB proxy | `.env` `CLOB_PROXY_URL` (user:pass in URL) | Webshare account login comes from the operator |
| Telegram | `.env` `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Ask to be added to the alert chat. `TELEGRAM_DISABLED=1` silences it |
| LLM | `.env` `OPENROUTER_API_KEY` | |
| Polygon RPC | `.env` `POLYGON_RPC_URL`, `POLYGON_RPC_FALLBACK_URLS` | |

**From the operator, off the box:** Webshare login (to check proxy quota),
Polymarket account access, the Telegram chat, GitHub collaborator access to
`NewGenesis04/zinger-core`, and the private docs in §6.

`.env.example` lists only 8 of the roughly 50 variables the code reads. To see
the full set, run `grep -rhoE 'process\.env\.[A-Z_]+' src index.ts | sort -u`.
If anyone leaves, rotate using `docs/CREDENTIAL_ROTATION.md`.

## 3. Deploy

```bash
tmux attach -t zinger            # Ctrl-C the running bot
cd /opt/apps/ZINGER
git pull
npm ci
npx tsc --noEmit -p .            # must be clean
npx vitest run                   # must be green (but see §5: green ≠ correct)
npm start                        # then Ctrl-B, D to detach
```

On restart the bot re-reads its mode from the DB. If the mode is `live` and
the edge gate fails, it **forces itself back to paper**
(`src/polymarket/bot.ts:4586-4588`).

## 4. Monitor

| Check | How |
|---|---|
| Is it alive / what is it doing | `tmux attach -t zinger` (detach with Ctrl-B, D) |
| Dashboard | `http://<vps>:3000/ops` (viewer) or the operator console, logged in with the passwords above |
| Feed health, including the CLOB proxy | `curl -s localhost:3000/api/v1/data-health \| jq '.feeds.clob.writeProxy'` |
| Cash reconciles to trades | `GET /api/poly/audit` with an operator session cookie. See handbook §7.3 |
| Alerts | Telegram chat |

## 5. Traps that have already cost days

- **Broken-looking CLOB auth is usually the proxy quota.** Webshare's free
  tier is 1 GB/month and the 30 s balance sync drains it in about 9 days. When
  the quota runs out the proxy times out instead of returning an error, and
  the readiness panel reports "API key missing". Check the Webshare quota
  before touching credentials. Paper trading is unaffected.
- **Arbitrage is structurally dead.** UP and DOWN are one order book seen from
  both sides, so the pair always costs $1 plus the spread. Don't try to "fix"
  arb execution. You can re-verify with
  `scripts/verify-complementary-books.mjs`.
- **Redemption is done by the Polymarket account, not the bot.** Auto-redeem
  is on. The merge path in the code is dead
  (`executeCtfMerge` needs `botState.walletClient`, which nothing assigns).
  After a lock, the bot's job is to notice the cash and close its books.
- **Live is gated by paper results.** The edge gate
  (`src/polymarket/bot.ts:299-310`) checks paper expectancy before allowing
  live directional trading.
- **Verify Polymarket behaviour; never infer it.** A plausible, reviewed,
  test-green change that gated arb on `negRisk` killed it for six days. Rules:
  `docs/refactor/conventions.md`.

## 6. Reading order

1. This file.
2. `docs/ENGINEERING_HANDBOOK.md`: the system end to end (pipeline, sizing,
   exits, regimes, circuit breakers, telemetry, runbook). It was written in
   August 2026 and two parts have been overtaken:
   - **§7.2** recommends pm2, but the VPS runs bare tmux (§1 above).
   - **§5.2** "Instant On-Chain Merge Execution" isn't a live path
     (§5 above).
3. `docs/refactor/README.md`: index to the refactor (the full history of the
   work).
   - `charter.md`: decisions D1–D11. **These are settled.** Raise a change
     explicitly; don't diverge quietly.
   - `open-backlog.md`: what's still open. New structural findings go in
     `open/`.
   - `archive/`: 115 fixed items. Grep it rather than reading it whole.
4. `docs/architecture.md`: module map.
5. `docs/mm/README.md`: market-making research and the gated live
   execution core.

**Private docs (not in git).** `.gitignore` keeps `docs/*.md`, `docs/research/`
and `CLAUDE.md` out of this public repo. The most important are
`docs/research/polymarket-domain-facts.md` (verified Polymarket semantics; the
authority for any domain claim), `CLAUDE.md` (hard rules),
`docs/OPERATOR_CODEBASE_FIELD_GUIDE.md`, the latest `docs/status-brief-*.md`,
`docs/live-settlement-design.md` and `docs/arb-viability-decision-2026-09-28.md`.
The operator copies these into `/opt/apps/ZINGER/` on the VPS, where the same
ignore rules keep them out of git.
