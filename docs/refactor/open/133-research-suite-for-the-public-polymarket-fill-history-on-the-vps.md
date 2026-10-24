> Item 133 — filed 2026-10-10. **PLAN ONLY. Nothing is built, nothing is pulled, nothing on the VPS has been touched. Draft for a grill session; every number below is an assumption until that session settles it.**

### 133. A research and backtest suite, run on the VPS, over the public Polymarket fill history

**Why.** The shadow log (item 132) answers "can any signal beat the ask" going forward, from 2026-10-09 on, at a few hundred windows a day. A public dataset covers the whole CLOB history, so questions that need months of fills (who profits and how, whether prices are calibrated by category, whether any flow signal predicts results) can be asked now, on far more data. The operator's laptop is too slow for it; the VPS is the intended place.

**The dataset (read from its README and file listing only; nothing downloaded).** `SII-WANGZJ/Polymarket_data` on Hugging Face, MIT licence, 279 GB, 6.6 billion records, CLOB `OrderFilled` events from 2022-11-21 to **2026-10-04 23:59:59 UTC**, verified against Polygon RPC by its authors. Five Parquet files:

| File | Size | Rows | Content |
|---|---|---|---|
| `markets.parquet` | 0.55 GB | 4.05M | one row per market: `slug`, `condition_id`, `token1`/`token2`, `answer1`/`answer2`, `closed`, `outcome_prices`, `volume`, `created_at`, `end_date`, `neg_risk` |
| `trades.parquet` | 45.8 GB | 1.27B | **recommended.** One row per matched fill: `timestamp` (s), `maker`, `taker`, `price`, `usd_amount`, `token_amount`, `maker_direction`, `taker_direction`, `nonusdc_side`, `market_id`, `condition_id`, `contract` |
| `quant.parquet` | 44.7 GB | 1.27B | the same trades normalised to the YES price (NO trades become `1 - price`, direction flipped) |
| `users.parquet` | 60.8 GB | 2.03B | every fill keyed by wallet `address` with `role` (maker/taker) |
| `orderfilled.parquet` | 127.2 GB | 2.03B | raw chain events; amounts and fees are 32-byte little-endian uint256 |

**What it cannot show.** No order-book snapshots, so no resting asks or sizes, no queue position, and no way to say what a resting order would have filled. A fill price is a price someone traded at, not a price a particular order could have had. Fees and rebates are only in `orderfilled.parquet`, in binary. Pre-CLOB trades (2020 to Nov 2022) are not included. Whether the 5m and 15m crypto up/down markets are present by slug has **not been checked**; the README says all Gamma-listed markets are, so it should be.

**Resources (operator-reported 2026-10-10).** 12 GB RAM (51% in use), 6 CPUs (load about 3, the live bot), 192.7 GB disk (49% used, about 98 GB free), **200 Mbit/s link, no monthly cap**. At about 25 MB/s: `markets` 25 s, `trades` about 30 minutes in theory (1 to 2 hours in practice), the full set about 3 hours in theory. Bandwidth is not the constraint; RAM, disk and the bot's own CPU are.

**Proposed budget (assumption).** 3 GB memory cap, 2 threads, 20 GB scratch, 5 GB of kept derived results, one job at a time, lowest CPU and disk priority, stop automatically when the load rises or a time limit is hit.

**Proposed design (assumption).** Who owns what:
- *Loader*: owns what leaves the network. Reads Parquet over HTTP with DuckDB so only the needed pieces move, or stages one file or time slice into scratch and always deletes it. Never writes raw data anywhere else.
- *Feature builders*: pure, tested; produce small derived tables (per window, per wallet, per day). These are the only data that persists, in their own store, never in `zinger.db`.
- *Hypothesis files and runner*: each question is written down before it runs; results go to `docs/research/` with the exact data cut.
- *Isolation*: a folder outside `/opt/apps/ZINGER`, its own tmux window, read-only on `zinger.db`, no write to the repo directory, and **none of the bot's CLOB proxy variables in the job's environment** (that proxy is metered at about 1 GB a month).
- *Install*: DuckDB as a single binary or a virtual environment, under the normal user, no sudo.

**What it can test with fills only.**
1. Price calibration by price, time in window and category, across all markets (is any category systematically off; the published political-market underconfidence finding is the model).
2. Maker economics: the price move after a maker fill at 10, 30 and 60 seconds (adverse selection, measured directly), and the maker/taker profit split on 5m and 15m crypto, to check the vendor-reported one-week result (`docs/research/who-profits-on-polymarket-and-known-biases.md`, A3) on months of data.
3. Order-flow imbalance early in a window as a predictor of the result beyond the price.
4. Wallet persistence: do profitable wallets stay profitable out of sample, and could they be followed with a realistic delay.
5. Time-of-day and day-of-week effects; late-window favourites using fill prices.
6. The strike-distance model over months, if Binance candles for the same period are added.

**The main risk.** Four million markets and many hypotheses will produce patterns that are not real. The suite needs these built in from the start: every hypothesis written and counted before it runs; a correction for how many were tried; a time holdout (fit on earlier months, test on the latest period the idea never saw); no result accepted unless it holds there.

**Open questions for the grill session.**
1. Pull pattern: remote streaming against staging a slice, and what the first probe of the Parquet footers (row-group order and statistics) says about how well remote pruning will work.
2. First period and first markets (one recent month of crypto up/down is the likely start).
3. First question: calibration across categories or maker economics (they need different features).
4. Where derived tables live, how results return to the repo, and how big the derived store may grow.
5. Automatic stops: memory ceiling, wall-clock limit, load threshold.
6. Hugging Face access: whether anonymous downloads are rate-limited and a token is needed.
7. Whether `orderfilled.parquet` fee columns are worth decoding for net-of-fee maker results.
8. How the hypothesis registry is stored and who may change a hypothesis after data is seen.

**Not decided and not started.** No code, no install on the VPS, no download. Per `CLAUDE.md`, this is an architectural addition and needs operator agreement before any build.

**Research update (2026-10-13).** `docs/research/prediction-market-data-tools-fees-and-inefficiency.md` records: fees are per market (verified live; geopolitics and world-event markets have none), vendors that sell or give book-level history from about September 2025 and March to April 2026 (claimed, untested), NautilusTrader and a Polymarket backtesting framework built on it (mixed GPL/LGPL/MIT licence), and the documented inefficiencies that suggest hypothesis families: tail and longshot overpricing in Bitcoin threshold markets, fee-free geopolitical markets, and time-structure effects. The Kalshi data in the other public repo is out of scope (the operator cannot use Kalshi). A separate, earlier experiment (predstrat) measured passive 47c bids at -2.8c to -3.4c a share against the price paid on 15m markets, which closes the passive-bid idea at that price.

## Decisions (grill session, 2026-10-19)

**Status: decisions made; nothing built, installed or downloaded yet.**

1. **Data: the SII-WANGZJ Polymarket dataset.** The data itself is on Hugging Face (`SII-WANGZJ/Polymarket_data`); the GitHub repo of the same name is the open-source collection toolkit and documentation, not the data. First load: `markets.parquet` (0.55 GB) and `trades.parquet` (45.8 GB) only, staged once on the VPS disk (about 97 GB free), deletable at any time. Not downloaded: `quant`, `users`, `orderfilled` (127 GB raw). Becker's repo is not used (Kalshi is out of scope, and its scripts are third-party code).
2. **Isolation: same user, `nice` and a memory cap** (operator's choice; a separate Unix user remains the safer option and can be adopted later). Conditions that go with this choice: only our own code runs; no third-party scripts (no `make setup`, no `make index`); no `.env`, wallet path or proxy variable in the job's environment; the Python environment lives in its own folder outside `/opt/apps/ZINGER`; dependency versions pinned; the cap is 3 GB memory and 2 threads; one job at a time.
3. **First real hypothesis: Bitcoin threshold tail overpricing**, after two controls (below).
4. **Time box: three weeks from the day the first data is loaded.** If no hypothesis passes dev, one confirm run and the forward test by then, the push stops and "no retail edge found on this platform with these methods" is reported as the finding.

### The two controls (run with every batch)
- **Accuracy control (known positive):** in 5m and 15m crypto windows, the token priced above 50c at 80-95% of the window wins more than 50% of the time. If this fails, the market-to-outcome join or the direction is broken and nothing is trusted.
- **Calibration control (known null):** buying any 5m crypto token at first sight in a price bucket nets about minus the fee. If this shows an edge, the estimator or the data is biased.

### H-first: Bitcoin threshold tail overpricing (draft contract)
- **Claim:** very unlikely "Bitcoin above X / reach X / dip to X" outcomes are priced above their true chance, so the favourite side (the NO of a tail) earns slightly more than its price after fees.
- **Universe:** resolved Polymarket markets whose question and slug identify a Bitcoin price threshold (above, reach, dip) with at least 24 hours to resolution at first sight. The pattern list is written in the contract before any result is seen.
- **Entry:** first fill in which the tail token's price is at or below a bucket edge (for example 0.02, 0.05, 0.10), taking the other token at its implied price; entry price is that fill's price plus a fixed spread.
- **Exit:** hold to resolution. No stops, no partials.
- **Costs:** today's crypto fee schedule applied to every period (the fee only began in January 2026, so applying it throughout is deliberately conservative), plus 1c spread and an extra 0.5c slippage stress.
- **Estimator:** first-sight per market, with pooled printed alongside; standard errors cluster by market and also by day, because many threshold markets share one Bitcoin path.
- **Periods:** dev = markets resolving before 2026-04-01; confirm = markets resolving 2026-04-01 to 2026-10-04, run once on the frozen contract.
- **Pass:** net per share above twice its error, positive in both halves of dev, positive on confirm, survives the cost stress, pooled and first-sight agree, at least 200 markets.
- **Limits stated up front:** these markets resolve over days to months and are strongly correlated through one price path, so the effective sample is smaller than the market count; the dataset has fills, not asks, so entry price is a fill price plus an assumed spread.

### First work packages (each needs the operator's go before it runs)
1. Read the Parquet footers of `trades.parquet` (a few KB by range request) to learn how it is sorted and whether remote reads can skip data.
2. Read-only check of the VPS: free disk and memory, and whether DuckDB is present.
3. Create the research folder and Python environment (DuckDB, PyArrow), pinned.
4. Download and stage `markets` and `trades`, with the memory cap and `nice` in place.
5. Build the runner and registry, then the two controls, then H-first.

### Work package 1 result: Parquet layout (2026-10-19, read-only; footers only, about 2.8 MB fetched)
Read by range request with a small purpose-written Thrift decoder (no libraries installed). Its output agrees with the dataset README on row count and time range, which is a check that the decoder works.

| | `markets.parquet` | `trades.parquet` |
|---|---|---|
| Size | 0.55 GB | 45.85 GB |
| Rows | 4,049,900 | 1,266,885,846 |
| Row groups | 4 | 1,261 (typically 1,048,576 rows each) |
| Compression | zstd | zstd |
| Footer | 0.01 MB | 2.77 MB |
| Time range | n/a | 2022-11-21 19:49 to 2026-10-04 23:59 UTC |

- **Time filters prune well.** `timestamp` min/max statistics are usable, and a lookup on one timestamp touches about 1.1% of the row groups (data is roughly time ordered, with a small overlap between neighbouring groups). `timestamp` is in seconds and present in `trades` directly, so no block lookup is needed.
- **Market filters do not prune.** A lookup on `market_id` touches about 34% of the row groups, `condition_id` 57%, `asset_id` 56%, `maker` and `taker` about 50%. Reading "only the BTC threshold markets" remotely would re-read about half the file on every query.
- **Decision this supports: stage `trades.parquet` once on the VPS disk (45.85 GB) and query it locally.** Remote streaming is not worth it for market-based questions. Time-sliced questions (dev and confirm periods) are cheap even then.
- **Data note:** the `price` column's statistics show a minimum of about -0.0000, so some prices are tiny negatives (float noise). Queries must keep only prices strictly between 0 and 1.
- **Schema matches the README:** 17 columns, `price`, `usd_amount` and `token_amount` as doubles, `timestamp` and `block_number` as 64-bit integers.
- `markets.parquet` is 4 row groups with no useful pruning; load it whole (0.55 GB).


### Work package 2 result: VPS check (2026-10-19, read-only; nothing changed on the server)
- **Resources match what the operator reported:** 6 CPUs, 11 GB RAM (about 10 GB available), 193 GB disk with **97 GB free**. Load average 0.4 with the Zinger bot stopped (expect about 3 when it runs).
- **There is no swap.** An overrun means an out-of-memory kill, not slowdown, so the cap is essential. Plan: DuckDB `memory_limit` 3 GB and 2 threads; raise the research process's `oom_score_adj` with `choom -n 1000` so it is the first thing the kernel kills; test `systemd-run --user --scope -p MemoryMax=3G` in work package 3 (user systemd is running, linger is off, cgroup v2 has the memory controller).
- **Tools present:** Python 3.12.3 with working `venv`, `uv`, `zstd`, `tmux`, `git`, `curl`, `nice`, `ionice`, `choom`. **Not installed:** DuckDB, PyArrow (they go into a research-only environment).
- **Network:** `huggingface.co` reachable from the VPS (redirect to the CDN as expected).
- **`~/research` does not exist yet.** The home folder holds only the operator's `trader` project (108 MB, port 8001) and `trader-backups` (about 1 GB).
- **This is a shared server.** Other users run their own services (a Next.js app under PM2, Docker, a FastAPI service, other processes). Resource caps matter for them too.
- **Disk risk to watch:** only about 16 GB of the 96 GB in use is visible to the operator's user (`/opt` 8 GB incl. 7.9 GB for `/opt/apps/ZINGER`, `/usr` 3.2 GB, `/var` 2.3 GB, `/home` 2 GB). About 80 GB sits where this user cannot read, possibly including `/data/parquet/market_ts.sqlite` written every 5 seconds by `/ops/market-track.py`. Whether that grows is unknown, so staging 46 GB needs a guard: refuse to start if free space is under 60 GB, check again during the download, and never leave less than about 15 GB free.
- The Zinger bot is not running (nothing listens on port 3000).


### Work package 3 result: `~/research` and the environment (2026-10-19)
- Created `/home/o_omorose/research/` with `data/raw`, `data/derived`, `hypotheses`, `runner`, `registry`, `reports`, `logs` and a README that says how to stop and remove it. Nothing under `/opt/apps/ZINGER` was touched. No proxy variable is set in the shell used.
- Private environment: `uv venv .venv --python 3.12`, installed at low priority. **Pinned in `~/research/requirements.lock.txt`: `duckdb==1.5.6`, `pyarrow==26.0.0`, `pyyaml==6.0.3`.** The environment is 224 MB; the folder is otherwise empty.
- **Memory guards, all tested:**
  - DuckDB `SET memory_limit='3GB'` and `threads=2` apply (it reports 2.7 GiB, which is 3 GB in decimal units).
  - With a 200 MB limit and a 1 GB spill cap, a 150-million-row sort was stopped with an out-of-memory error, not allowed to grow.
  - `systemd-run --user --scope -p MemoryMax=150M -p MemorySwapMax=0` killed a 400 MB allocation (exit 137), so the operating-system cap works under the user's systemd.
  - `choom -n 1000` sets the oom score to 1000, so the research job can be made the first thing the kernel kills.
- **Disk puzzle, before staging data:** `/data` does not exist on the host (the `market-track.py` process runs in a container) and Docker is only 2.2 GB. About 80 GB of the 97 GB in use is unaccounted for from this user's view, and used space went from 94 GB (Oct 12) to 72 GB (Oct 13, after predstrat was deleted) to 97 GB (Oct 19), about 4 GB a day. The download stays blocked until the source of that growth is known.

### Work package 4 result: slim extraction (2026-10-19)
- Decision changed from "stage all 46 GB" to a **column-only streaming pass**: it needed only 5.3 GB of the 45.8 GB (the transaction hashes alone are 26 GB). Finished in 26.1 minutes, exit 0, **31,989,950 rows in 124 MB** at `~/research/data/derived/slim_trades.parquet`, for 97,785 selected markets (frozen rules in `ZINGER_RESEARCH/extract/universe.sql`). Free disk stayed at 96 GB. Full detail and the sanity checks are in `ZINGER_RESEARCH/docs/SETUP_LOG.md`.
- **Data quirks that change the draft contract:** `end_date` is overwritten for about 2% of markets (derive up/down windows from the slug); reach and dip markets resolve when touched, so `end_date` is only a horizon and there is no resolution timestamp; some trades fall before creation or after the end; taker and maker directions are unverified; `bitcoin_above` is thin (median 3 trades).
- **Contract refinements before it is frozen (still a draft, nothing has been run):**
  - **Primary family: `above_on`** (daily markets: 2,352 dev and 2,021 confirm markets with at least 20 trades; about 215 and 190 distinct days, so the most power). `reach` and `dip` are secondary (about 600 and 1,300 markets but only about 20 and 6 independent months). `bitcoin_above` is dropped from the primary test because it is thin.
  - **Clustering:** by day for `above_on`, by calendar month for `reach` and `dip`.
  - **Eligibility:** exclude markets whose `end_date` equals a repeated bulk stamp; entries only when `created - 1h <= timestamp < end`.
  - The controls take their windows from the slug epoch, not from `end_date`.
- The pass criteria (above twice its error, positive in both halves of dev and on confirm, survives the cost stress, pooled and first-sight agree) are unchanged.

### Work package 5 result: runner, registry and controls built (2026-10-19)
Code lives in `ZINGER_RESEARCH/runner/` and is deployed to `~/research` on the VPS; the full description is in `ZINGER_RESEARCH/docs/SETUP_LOG.md` section 5. Summary: entry SQL sees no outcomes; fixed first-sight and pooled estimators with clustered errors; an append-only registry that enforces freeze-before-run and confirm-once and raises the pass bar with the number of ideas tried; two controls that mark a batch UNTRUSTED if they fail. **28 tests pass**, including regression tests for both earlier mistakes. **The controls pass on the real extraction** (accuracy 86.1% win rate, z 94.7; calibration net -3.5c per share with error 0.08c). Two real-data problems were found and fixed while building (duplicate market ids; `outcome_prices` in single-quoted form). The mutation check (19 deliberate breakages) was running detached at the time of writing. Drafts `H001` (above_on, cluster by day) and `H002` (reach and dip, cluster by month) await the operator's review; neither has been frozen or run.
