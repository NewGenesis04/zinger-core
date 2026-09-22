// @ts-nocheck
/**
 * Live equity: cash plus what the wallet holds (item 104, decision D-C).
 *
 * ## Who owns "this position still exists"
 *
 * The wallet, always. Bot memory never does. The bot's marks describe what it
 * believes it holds, and they are exactly wrong in the cases that matter: after
 * a redemption burns the tokens, and after any close the bot missed. So open
 * value is the sum of the wallet's own `currentValue` over **every** row,
 * whoever opened it. A resolved loser is worth $0 and adds nothing. An
 * unredeemed winner, or a holding the bot has no record of, is real money and
 * counts.
 *
 * ## When the wallet does not answer
 *
 * "No answer" is not "holds nothing" (`readiness.walletPositions` is null, not
 * `[]`). The last good figure is reported, flagged `stale`, with its time.
 * Combining current cash with old holdings would double-count any redemption
 * that landed in between, which is the phantom this module exists to remove.
 * So the fallback is a whole earlier snapshot, cash and holdings from the same
 * moment. With no earlier snapshot, equity is cash alone, flagged
 * `holdingsKnown: false`.
 *
 * A stale figure must not drive a decision. The governor's drawdown breaker
 * skips it (`ai/governor.ts`).
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function liveEquity({ cash, walletRows = null, trackedTokenIds = null, lastGood = null, now = Date.now() }) {
  const c = Number(cash) || 0;
  if (Array.isArray(walletRows)) {
    let value = 0;
    let unrealized = 0;
    let untracked = 0;
    for (const row of walletRows) {
      const v = Number(row?.currentValue);
      const worth = Number.isFinite(v) && v > 0 ? v : 0;
      value += worth;
      unrealized += Number(row?.cashPnl) || 0;
      if (trackedTokenIds && !trackedTokenIds.has(String(row?.asset || ''))) untracked += worth;
    }
    return {
      equity: round2(c + value),
      cash: round2(c),
      openMarkValue: round2(value),
      untrackedValue: round2(untracked),
      pmUnrealized: round2(unrealized),
      walletRows: walletRows.length,
      stale: false,
      holdingsKnown: true,
      asOf: now,
    };
  }
  if (lastGood) return { ...lastGood, stale: true };
  return {
    equity: round2(c),
    cash: round2(c),
    openMarkValue: 0,
    untrackedValue: 0,
    pmUnrealized: 0,
    walletRows: null,
    stale: true,
    holdingsKnown: false,
    asOf: null,
  };
}
