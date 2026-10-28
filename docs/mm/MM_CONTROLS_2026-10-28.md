# MM controls from the five-day replay — 28 October 2026

**Status: built and tested in dry-run. Not live.** Nothing was signed or sent. The live gate still needs 3 positive out-of-sample days, an allowed region, a dedicated wallet and review.

## What the replay found

Fills from five recordings (18, 20, 25, 26 Oct, and a partial 27 Oct) were replayed under 3,564 settings, with the $200 inventory limits (200 shares, $50 per market). Totals for 20 Oct and 25–27 Oct. 18 Oct is left out: it is an older recorder version and one market dominates it.

| Setting | Reward | Inventory | Net |
|---|---|---|---|
| Both sides, no filters | +$27.27 | −$55.17 | −$27.90 |
| Both sides + $5 market stop | +$27.19 | +$2.98 | **+$30.17** |
| + jump filter | +$27.18 | +$2.75 | +$29.94 |
| YES bid only + $5 stop | +$15.21 | +$6.62 | +$21.82 |
| NO bid only, no stop | +$15.86 | −$57.07 | −$41.21 |

- The **$5 per-market stop** is the only control that clearly helps. It cut the 27 Oct Likud jump (0.32 → 0.83 in 3 minutes) from −$63.51 to −$5.44 and triggered once in about 250 market-days.
- **Both sides** roughly doubles reward. YES-bid-only only looked safe because prices happened to rise: the mirrored NO side loses without a stop.
- The jump filter, volatility filter, tighter price bands, smaller caps and a higher competition floor did not help. The Likud inventory built up over two hours of drift before the jump.
- Walk-forward (settings chosen on earlier days only): +$2.85, +$9.19, +$11.80, −$7.04. That is 3 of 4 days positive, +$16.80 in total.
- Expected reward at $200 is about $0.17 per market per day, roughly $0.60–0.90/day. One stop-out costs about 6–8 days of reward.

Replay limits: fills come from public trades checked once a minute, inventory is marked at mid, and a real stop during a jump can sell worse than the replay assumes.

## What was built

| Control | Where | Behaviour |
|---|---|---|
| Both sides | `scripts/mm-live.ts --sides=both` (default) | Bids YES and NO. A NO bid counts as a YES ask for rewards. Skew uses net exposure (YES held − NO held). `--sides=yes` keeps the old behaviour |
| Two-sided reward estimate | `evaluation.ts` `marketRewardShare` | max(min(Qbid, Qask), max(Qbid, Qask)/3) inside 0.1–0.9; only the two-sided min outside it |
| Market stop | `executor.ts` `maxMarketLossUsd` | $5 at `--budget=200`, $2.50 at `--budget=100`. Stops only that market, cancels its quotes, then sells held shares at the best bid in order-size chunks once nothing of the token rests. An exit stays tracked until reconciliation confirms the venue closed it, so no share is sold twice |
| Exit order | `venue.ts` / `clobVenue.ts` | `PlaceRequest.exit`: fill-and-kill sell (`createAndPostMarketOrder`, FAK) with the bid as the worst price. Exit buys are refused |
| Early fills | `executor.ts` | A fill that arrives before its order's acknowledgement is held and applied on the ack, instead of halting as an unknown order |
| Day-long stops | `tmp/mm-live/market-stops-<mode>.json` | A stopped market stays stopped for the rest of the UTC day, across restarts; also restored from the journal |
| Gate | `gate.ts` | New check `market_stop` (must be above 0); ceiling `maxMarketLossUsd ≤ 5`. The limits hash changes with the new field |

Tests: `tests/unit/mmMarketStop.test.ts` (12 tests) and `tests/unit/mmLiveWatch.test.ts` (3 tests).

## Dry run, live public books

`npx tsx scripts/mm-live.ts run --universe=tmp/commercial-evidence/mm-live-universe-20261025.json --max-markets=9 --budget=200 --sides=both --minutes=10`

| | Result |
|---|---|
| Cycles | 589 (1 book error), clean shutdown, nothing left resting, no halt or stop |
| Orders | 22 placed and acknowledged: 12 YES bids, 10 NO bids |
| Coverage | 6 of 9 markets quoted 88% of the time, all of it reward-eligible. Vance 2028 (200-share minimum), Ocasio-Cortez 2028 and Fed Jan +25 bp were not quoted |
| Cap | 1,557 skips on `portfolio_usd_limit`: two bids per market fill the $200 cap at about 6 markets |
| Fills | 0 in 10 minutes |
| Estimated reward | **$2.49/day** (10 minutes; estimate only), against $0.46/day for YES-only on 25 Oct |

## Not built

- Merging YES+NO pairs back to collateral. Held pairs are counted at $1 per share against the caps, which is conservative.
- A taker exit in the replay is filled at the best bid. A real exit in a fast book can fill worse or only partly.

## Protection rules tested later on 28 Oct

These were added on top of both sides plus the $5 stop, and replayed on 20 Oct and 25–27 Oct. Total net is $30.17 without them.

| Rule | Total | Worst day | Note |
|---|---|---|---|
| Pause a side after 2 same-side fills (60 min) | +$30.44 | −$6.79 | No real change; fills are sparse |
| Pause after 3 | +$30.04 | −$6.78 | Same |
| Close a position 2 / 3 / 5 cents against entry | +$25.61 / +$25.70 / +$29.56 | about −$7 to −$8 | Pays the spread more often |
| Close after holding 30 / 60 / 120 min | +$21.11 / +$11.40 / +$25.65 | +$1.83 / −$12.88 / −$4.66 | 30 min saves 27 Oct but costs the rest |
| Cap at 100 / 50 shares | +$26.88 / +$25.63 | −$5.06 / −$4.27 | Smaller worst day for a little less |

Picking rules on three days and scoring on the fourth gave $16.21, against $30.17 for the plain stop. None is on by default. The 50-share cap is available as `--max-net-shares=50`.

