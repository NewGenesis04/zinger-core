# $200 live MM readiness — 25 October 2026

**Status: not ready to go live.** The code path is built and was tested in dry-run. Four blockers remain, and they are listed below. Nothing was signed or sent.

## What was run

| Check | Result |
|---|---|
| $200 limit profile (`--budget=200`) | $200 portfolio, $50 per market, 100 shares per order, $20 loss halt. Canary ceiling raised to match. |
| Market rule (fixed before the run) | Fresh reward scan: non-thin books, pool ≥ $20/day, reward minimum ≤ 50 shares, ≥ 30 days to end, mid 0.15–0.85, top 10 by estimated reward per $100. 9 markets qualified. |
| 60-minute dry run, public books | 3,560 one-second cycles, 3 book errors, 28 orders placed and acknowledged, no unexplained cancels, no halts, clean shutdown with nothing resting. |
| Quote coverage | 7 of 9 markets were quoted 95% of the time and were reward-eligible whenever quoted. 2 markets (Vance 2028, Ocasio-Cortez 2028) were never quoted: the book was too tight to clear the risk buffer. |
| Fills | 0 in 60 minutes at 1 tick behind the touch. No adverse selection was seen, and no spread was earned. |
| Estimated liquidity reward | **$0.46/day** in total (about 0.23%/day on $200), against the visible book. It is estimated only and is not booked. |
| Capital simulation, recorded 24 h (train half → test half) | $200 → 3 markets, **+$2.46/day** (+1.26%/day) on the test half. One day and three markets: weak evidence. |
| Preflight (no credentials) | Not armed: no live flag or limits ack, **region FR is restricted**, no collateral, no evidence file. |

## Blockers before any live order

1. **Region.** This host's egress reports France, which Polymarket restricts for new orders. Live trading has to run from an eligible location and operator. Do not route around this with a proxy or VPN; the gate fails closed on proxies.
2. **Evidence gate.** At least 3 positive day-N → day-N+1 out-of-sample days are needed. A 3-day recording of 64 liquid markets started at 2026-10-25 18:58 UTC and finishes around 2026-10-28 19:00 UTC (`tmp/commercial-evidence/record-3days.log`).
3. **Wallet.** Use a new dedicated wallet, with the plaintext key in `data/zinger.db` (`docs.wallet.json`) rotated. It must hold no open orders and no holdings in the quoted tokens, and its pUSD collateral must reach the CLOB with enough allowance for $200.
4. **Review.** The adapter is in NewGenesis04/zinger-core#2, which is still open.

## What to expect at $200 with the current design

- The reward income is small: about $0.46/day, because a single YES bid scores only a third under the one-sided rule.
- Quoting both sides (YES bid and NO bid) removes that penalty, and the estimate would be roughly ×3, about $1.40/day. This is next-steps item 4 in `MM_README.md`.
- Fills are rare at 1 tick behind. The main risk is a few sharp moves; on the recorded day, three markets lost $71 at $13k scale.
- The $20 loss halt caps a bad session at 10% of the budget.

## Run it again

```bash
npx tsx scripts/mm-live.ts run --mode=dry-run --budget=200 --minutes=60 --max-markets=10 --universe=tmp/commercial-evidence/mm-live-universe-20261025.json
npx tsx scripts/mm-live.ts preflight --budget=200 --universe=tmp/commercial-evidence/mm-live-universe-20261025.json
```
