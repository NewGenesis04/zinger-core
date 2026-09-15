// @ts-nocheck
/**
 * INVARIANT: a kill the venue has already announced costs nothing to confirm,
 * and everything else still pays full price (item 84).
 *
 * This is the one place in the codebase that reads meaning out of an error
 * string. `verifyFilledShares` refuses to (`trade.ts:311`) because the venue's
 * vocabulary was never recorded, and the Aug 2026 `negRisk` regression was
 * exactly that shape — a plausible assumption about venue behaviour, shipped
 * green.
 *
 * What makes it admissible here is the DIRECTION OF FAILURE, and that is what
 * these tests pin. A match skips a 4.5s reconciliation for a leg the venue has
 * explicitly said did not fill. A non-match changes nothing — full dual-door
 * path, as before. If Polymarket rewords the message tomorrow the bot gets
 * slower, never wrong. Any change that makes a non-match do something OTHER
 * than fall back has broken the justification, not just the optimisation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { isSyncFokKill, fokKillStats, classifyOrderFailure, __resetFokStats } from '../../src/polymarket/trade.js';

/** The exact response from the 2026-09-15 live probe (domain facts §8). */
const OBSERVED = "order couldn't be fully filled. FOK orders are fully filled or killed.";

beforeEach(() => { __resetFokStats(); });

describe('INVARIANT: only an observed kill message takes the fast path', () => {
  it('recognises the string the live venue actually returned', () => {
    expect(isSyncFokKill(400, OBSERVED)).toBe(true);
  });

  it('requires the status as well as the words', () => {
    // A 400 covers malformed orders, insufficient balance and the $1.00
    // notional rejection too. The status alone says nothing about whether
    // shares moved, so it can never be sufficient on its own.
    expect(isSyncFokKill(500, OBSERVED)).toBe(false);
    expect(isSyncFokKill(200, OBSERVED)).toBe(false);
    expect(isSyncFokKill(null, OBSERVED)).toBe(false);
    expect(isSyncFokKill(undefined, OBSERVED)).toBe(false);
  });

  it('refuses every other 400 the venue is known to send', () => {
    // Real strings from docs/research/polymarket-domain-facts.md:759-760.
    // These are rejections BEFORE matching, not statements about a fill — and
    // treating them as "confirmed unfilled" would skip reconciliation on an
    // error whose fill status is genuinely unknown.
    for (const msg of [
      'invalid amount for a marketable BUY order ($0.38), min size: 1',
      'invalid amount for a marketable BUY order ($0.21), min size: 1',
      'not enough balance / allowance',
      'order rejected',
      'internal server error',
      '',
      null,
      undefined,
    ]) {
      expect(isSyncFokKill(400, msg)).toBe(false);
    }
  });

  it('never fast-aborts a message that says the order DID fill', () => {
    // Found by mutation: broadening the pattern to /filled/i passed every other
    // test here. This is the direction that actually costs money — reading
    // "filled" as "confirmed nothing filled" abandons a live leg without
    // reconciling, which is precisely the 2026-09-11 ghost with the safety net
    // switched off. The word "filled" appears in both answers; only the whole
    // phrase distinguishes them.
    expect(isSyncFokKill(400, 'order filled')).toBe(false);
    expect(isSyncFokKill(400, 'order partially filled, remainder cancelled')).toBe(false);
    expect(isSyncFokKill(400, 'order was fully filled')).toBe(false);
  });

  it('degrades to the slow path if the venue rewords the message', () => {
    // The safety property stated as a test. A reworded kill must NOT match —
    // that is what sends it to the 4.5s dual-door check, which is correct, just
    // slower. This test failing means the pattern list grew loose enough to
    // guess, which is the thing being guarded against.
    expect(isSyncFokKill(400, 'order was cancelled because it could not be completely executed')).toBe(false);
    expect(isSyncFokKill(400, 'fill-or-kill: no match')).toBe(false);
  });

  it('tolerates the apostrophe the wire may or may not use', () => {
    // "couldn't" can arrive straight or curly depending on the encoder, and a
    // pattern that only matched one would silently stop working.
    expect(isSyncFokKill(400, 'order couldn’t be fully filled.')).toBe(true);
    expect(isSyncFokKill(400, "order couldn't be fully filled.")).toBe(true);
  });
});

describe('INVARIANT: the vocabulary is learned, not assumed', () => {
  it('counts what it did not recognise, which is the half that matters', () => {
    // A rising unmatched count against a flat fast-abort count is the only
    // signal that this pattern list has gone stale. Without it the bot quietly
    // returns to paying 4.5s per kill and nobody finds out why.
    classifyOrderFailure({ status: 400, error: OBSERVED });
    classifyOrderFailure({ status: 400, error: OBSERVED });
    classifyOrderFailure({ status: 400, error: 'some new wording nobody has seen' });
    classifyOrderFailure({ status: 503, error: 'upstream unavailable' });

    const s = fokKillStats();
    expect(s.fastAborts).toBe(2);
    expect(s.unmatchedFailures).toBe(2);
  });

  it('records the unrecognised text so the vocabulary can be widened from evidence', () => {
    classifyOrderFailure({ status: 400, error: 'a brand new rejection' });
    classifyOrderFailure({ status: 400, error: 'a brand new rejection' });
    classifyOrderFailure({ status: 400, error: 'a different one' });

    const { vocabulary } = fokKillStats();
    expect(vocabulary[0]).toEqual({ text: 'a brand new rejection', n: 2 });
    expect(vocabulary.map((v) => v.text)).toContain('a different one');
  });

  it('does not record a recognised kill as unknown vocabulary', () => {
    classifyOrderFailure({ status: 400, error: OBSERVED });
    expect(fokKillStats().vocabulary).toHaveLength(0);
  });

  it('exposes counters shaped for the dashboard', () => {
    const s = fokKillStats();
    expect(s).toHaveProperty('fastAborts');
    expect(s).toHaveProperty('unmatchedFailures');
    expect(Array.isArray(s.vocabulary)).toBe(true);
  });
});
