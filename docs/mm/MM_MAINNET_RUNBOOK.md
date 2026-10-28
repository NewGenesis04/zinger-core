# MM mainnet runbook — $200 canary

**Status on 28 October 2026: not armed.** The code path, controls and Command Center watch are ready. Live orders stay blocked until every gate check passes. Five fail today: live flag, limits ack, region, collateral and evidence.

Polymarket runs on Polygon mainnet only (chain 137). `preflight` prints the chain id and the CLOB host it will use.

## 1. What has to be true first

| Gate check | How it passes | Today |
|---|---|---|
| `evidence` | `tmp/mm-live/evidence.json` shows ≥ 3 positive out-of-sample days and a positive mean | 0 days. A 4-day recording started 2026-10-28 15:35 UTC and ends about 2026-11-01 15:40 UTC |
| `geoblock` | Run from a host whose egress is in an allowed region, with no proxy or VPN. The gate refuses proxies by design | This host reports FR, which is restricted |
| `collateral` | A new dedicated wallet with at least $200 pUSD on the CLOB and allowance set | $0 |
| `live_flag`, `limits_ack` | Set on the day: see step 4 | Not set |
| `market_stop`, `canary_ceiling`, `kill_file`, `clob_host`, `no_proxy` | Already pass at `--budget=200` | Pass |

Also before the first live order:
- **Use a dedicated wallet.** A fresh wallet that holds nothing else, never a key that has been stored in plaintext.
- **Review.** NewGenesis04/zinger-core#2 has the live adapter and review fixes. The market stop, two-sided quoting and this watch come after it and need review too.

## 2. Build the evidence

After each recorded day ends, rebuild the evidence file:

```bash
python3 scripts/mm_evidence.py --out tmp/mm-live/evidence.json
```

- Only days recorded after `FIXED_AT` (2026-10-28 12:00 UTC) count. The settings were picked on the days before that, so those days can't vouch for them.
- A day needs at least 1,380 minutes to count.
- The settings are fixed in the script: both sides, $50 and 200 shares per market, competition ≥ 10,000, $5 market stop. Changing any of them means restarting the evidence count, with a new `FIXED_AT`.
- It's a replay of public trades at the touch, sampled once a minute. The live runner quotes one tick behind, so expect fewer fills live.

Recording status: `tmp/commercial-evidence/record-days-20261028.log`. Each day line now records the real exit code.

## 3. Dry run with the Command Center watching

```bash
npx tsx scripts/mm-live.ts run --budget=200 --sides=both --minutes=60 --max-markets=9 \
  --universe=tmp/commercial-evidence/mm-live-universe-20261025.json
```

Open the Command Center (operator login) → **MM Live** (`/#mm`). It updates every 2 seconds and shows:
- mode (LIVE in red, DRY-RUN outlined), state (running, stale, halted, finished), sides, budget and limits hash
- session P&L, loss room against the $20 limit, estimated reward per day, fills, stopped markets
- each market: YES mid, YES and NO shares held, P&L against the $5 stop, resting quotes, reward per day, state
- the action feed: submits, acks, fills, cancels, market stops, halts and rejects, newest first
- **Kill run**: creates the kill file, and the runner cancels every order and stops. **Clear kill file** appears once nothing is running.

Viewer logins can't see this page; it is operator only.

Deploying the page: the dashboard serves `frontend/dist`, so the MM Live tab appears after `npm --prefix frontend run build` and a restart of the dashboard server.

## 4. Arm and start (only when step 1 is all green)

```bash
# 1. Read-only check with the wallet: balances, open orders, holdings in the quoted tokens
npx tsx scripts/mm-live.ts preflight --auth --budget=200 --evidence=tmp/mm-live/evidence.json \
  --universe=tmp/commercial-evidence/mm-live-universe-20261025.json --max-markets=9

# 2. Arm this exact limit set (the hash is printed by preflight; 80c9fa483ecbab48 for --budget=200 today)
export ZINGER_MM_LIVE=1
export ZINGER_MM_LIVE_ACK=<limitsHash from preflight>

# 3. Start live, short first: 30 minutes
npx tsx scripts/mm-live.ts run --mode=live --budget=200 --sides=both --minutes=30 \
  --evidence=tmp/mm-live/evidence.json --universe=tmp/commercial-evidence/mm-live-universe-20261025.json --max-markets=9
```

The runner refuses to start if the gate isn't armed, the wallet has open orders or holds any quoted token, or another runner holds the lock.

## 5. Stopping

Any of these makes the runner cancel all orders and confirm nothing rests before it exits:
- the **Kill run** button on MM Live
- `touch tmp/mm-live.KILL`
- Ctrl-C or SIGTERM

It also stops by itself on:
- a $20 session loss, counting earlier sessions in the loss ledger
- missed heartbeats, repeated rejects, unknown fills, orphan orders or position drift
- a 30-second book outage

A market that loses $5 stops alone for the rest of the UTC day. Its shares are sold at the best bid.

After a halt: read the action feed, check the venue for resting orders if shutdown wasn't confirmed clean (the lock file is then kept), clear the kill file, and restart by hand.

## Order types

Every order carries a limit price, so nothing fills worse than the price it was sent with. Types are set per order (`DesiredQuote.kind`) and mapped to the exchange in `clobVenue.ts`.

| Type | What it does | Exchange | Used for |
|---|---|---|---|
| `quote` | Rests, never takes; refused if it would cross | GTC post-only | MM quotes (default) |
| `quote-until` | Same, and expires on its own; renewed a minute before it lapses | GTD post-only | `--quote-type=quote-until --quote-ttl-s=180`: quotes clean themselves up if everything else fails |
| `limit` | Takes up to its price, rests the rest | GTC | Working an order |
| `ioc` | Takes up to its price, cancels the rest | FAK | "Market" orders with a worst price; market-stop exits |
| `fok` | All at its price or better, or nothing | FOK | All-or-nothing |

Guards on anything that takes liquidity:
- It is refused if priced more than `maxTakerSlippageTicks` (3) through the best price, or if there is no book to compare against.
- Exits are fill-and-kill sells priced `exitSlippageTicks` (1) under the best bid, and fill at the best price available.
- A taker fill is booked at the price it actually got.

`--max-net-shares=50` lowers the inventory cap below the profile's 200. In the replay that cut the worst day from −$6.76 to −$4.27, for about $4.50 less over four days.

## Proxies and region

The gate refuses to arm when a proxy or relay is configured, and it checks the region from the machine that actually sends the orders. That is deliberate: a proxy that changes where orders appear to come from would get around Polymarket's regional restriction, and the runner won't trade that way. Live has to be run by an eligible operator, from an eligible location, with direct egress.

## 6. Limits at `--budget=200`

| Limit | Value |
|---|---|
| Portfolio | $200 (bids valued at cost, inventory at $1 per share) |
| Per market / per event | $50 / $100 |
| Order size / net shares per token | 100 / 200 |
| Session loss halt | $20, including earlier sessions |
| Market stop | $5, flatten and stop for the UTC day |
| Open orders / orders per minute | 20 / 60 |
