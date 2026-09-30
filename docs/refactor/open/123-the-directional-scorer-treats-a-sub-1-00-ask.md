> Open item 123 — filed 2026-09-30.

### 123. The directional scorer treats a sub-$1.00 ask sum as an edge, and it is a stale read

**Found 2026-09-30**, while reading the scorer for item 41. Not fixed inline.

`engines/directional.ts:364` computes `arbGap = 1 - upAsk - downAsk` and uses it three ways:

- `:369-372` adds `arbGap * 160` to a side's score when `arbGap > 0.01`.
- `:440` lets a neutral-signal entry with `edge < 0.02` stay eligible when `arbGap > 0.012`; without it the entry is refused as `neutral_no_edge`.
- `:453-460` (`arbRescue`) adds `arbGap * 200` and reports `arb overrides mismatch` when the signal disagrees with the side, once `arbGap >= minArbGap` (0.015).

`docs/research/polymarket-domain-facts.md` §11 (High confidence): the two tokens of a binary share one order book, so `ask_up + ask_down = 1 + spread >= 1.00` in any coherent snapshot. A positive `arbGap` is therefore a stale or desynchronised read, not an opportunity. This is the same artefact that produced the arb phantoms (item 121), and here it can turn an ineligible entry eligible or override the signal.

Exposure: WS books are read from one cache at one moment, so a real positive gap should be rare after item 121's parallel read, but nothing measures how often it occurs, and `arbOnlyUntilEdge` no longer keeps the arb terms out of paper directional.

**Not decided.** Direction: treat `arbGap > 0` as a fault counter and remove it from scoring, eligibility and rescue. That changes entry behaviour, so it is the operator's call. First step is measuring: the `arb_gap` / `arb_overrides_mismatch` reason codes are already emitted in `trade.decision` events, so their frequency over the paper run says whether it matters.
