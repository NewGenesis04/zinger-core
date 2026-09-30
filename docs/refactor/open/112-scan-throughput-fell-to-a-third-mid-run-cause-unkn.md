> Open item 112 — from `docs/refactor-plan.md` backlog, verbatim. New findings append here.

### 112. Scan throughput fell to a third mid-run, cause unknown

**Found 2026-09-21.** Hourly `gap_below_breakeven` counts roughly measure scan
throughput (one per market per pass):

| hour (UTC) | 05 | 06 | 07 | 08 | 09 | 10 | 11 | 12 | 13 | 14* |
|---|---|---|---|---|---|---|---|---|---|---|
| count (k) | 53.6 | 53.0 | 45.8 | 46.8 | 33.6 | 17.8 | 17.5 | 17.7 | 17.8 | 13.5 |

*to 14:48. That's about 14/s falling to about 4.9/s, with the transition
partway through 09:00, and it held until the stop. So either fewer markets were
scanned, or passes took about three times as long. The table can't say which.

One candidate is a socket drop forcing REST reads, which are slower and
proxied. By item 111 that would leave no trace in the bot. The Webshare usage
graph for 09:00–10:00 on 2026-09-20 is the only independent record.

**Not fixed. Open investigation.** Relevant to item 92's quota concern if it's
the proxy.

**2026-09-22.** Nothing can be recovered from the bot for 2026-09-20, because
item 111 had not landed. From the next deploy, `📡 CLOB WS DOWN` lines in the
action log date any socket outage, and a slowdown that coincides with one
points at REST fallback. The Webshare usage graph for 09:00–10:00 on
2026-09-20 remains the only independent record for the original event
(operator).

**2026-09-22: proxy ruled out (operator).** The Webshare graph shows no spike
around 09:00–10:00 on 2026-09-20. REST fallback after a socket drop goes
through that proxy, so a drop severe enough to cut throughput by two thirds
would have shown up. Remaining candidates: fewer markets scanned, or passes
slowed for a reason that doesn't touch the proxy. The record from that day
can't distinguish them. Left open. The next occurrence will carry the
item-111 socket lines and the hourly counts.

---
