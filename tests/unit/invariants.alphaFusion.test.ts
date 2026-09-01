import { describe, expect, it } from 'vitest';
import { applyAlphaFusion, fuseAlpha } from '../../src/polymarket/alphaFusion.js';
import { analyze } from '../../src/polymarket/signal.js';

/**
 * INVARIANT: no modality is silently dead.
 *
 * The fusion blends seven votes. Each reads its inputs with `?? <neutral>`, so a
 * field that does not exist produces a neutral vote and no error — the modality
 * keeps its weight in the denominator while contributing nothing. Green tests,
 * plausible output, a quietly weaker signal. That is exactly how `negRisk` and
 * the $1.00 sell floor got in.
 *
 * Three were dead on arrival when this was ported (see backlog 36):
 *   TA_MEANREV  — read `analysis.bb.pos`, which `analyze()` never attached
 *   ORDER_FLOW  — the fusion context carried no book
 *   POSITIONING — read `funding.fundingRate`, which `analyze()` renames to `rate`
 *
 * So these tests do not check the fusion's arithmetic. They check that each
 * modality is *wired to something real* — the vote must move when its own input
 * moves. The arithmetic is a modelling choice; a disconnected input is a bug.
 */

/** Synthetic candles with a controllable drift, enough bars for every indicator. */
function candles({ drift = 0, n = 120, start = 100 } = {}) {
  const out = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    price *= 1 + drift;
    // A deterministic wobble so std-dev based indicators (Bollinger, ATR) are
    // non-degenerate; without it the bands collapse and `pos` divides by zero.
    const wobble = price * 0.002 * Math.sin(i / 3);
    out.push({
      time: i * 60_000,
      open: price - wobble,
      high: price + Math.abs(wobble) * 2,
      low: price - Math.abs(wobble) * 2,
      close: price + wobble,
      volume: 1000 + (i % 7) * 50,
      takerBuyBase: 500 + (i % 5) * 20,
    });
  }
  return out;
}

const voteFor = (fused: any, id: string) =>
  (fused?.components || []).find((c: any) => c.id === id) ?? null;

describe('INVARIANT: analyze() exports every field the fusion reads', () => {
  it('attaches the Bollinger band position, not just the raw bands', () => {
    // backlog 36: `bbPos` was computed and used for scoring, then dropped on the
    // way out, so TA_MEANREV's Bollinger half read the 0.5 fallback forever.
    const a = analyze(candles({ drift: 0.002 }));
    expect(a.bb, 'analyze() no longer returns bb').toBeDefined();
    expect(a.bb.pos, 'bb.pos is missing — TA_MEANREV is back on its fallback').toBeTypeOf('number');
    expect(a.bb.pos).toBeGreaterThanOrEqual(0);
    expect(a.bb.pos).toBeLessThanOrEqual(1);
    // The raw bands must survive alongside it.
    expect(a.bb.upper).toBeGreaterThan(a.bb.lower);
  });

  it('keeps bb.pos finite when the band has zero width', () => {
    // A perfectly flat series divides by zero. An Infinity here saturates the
    // vote to -1 on every bar, which is worse than the neutral fallback.
    const flat = Array.from({ length: 120 }, (_, i) => ({
      time: i * 60_000, open: 100, high: 100, low: 100, close: 100, volume: 1000, takerBuyBase: 500,
    }));
    const a = analyze(flat);
    expect(Number.isFinite(a.bb.pos)).toBe(true);
    expect(a.bb.pos).toBe(0.5);
  });

  it('exposes the momentum and macd shapes TA_MOMENTUM reads', () => {
    const a = analyze(candles({ drift: 0.002 }));
    expect(a.momentum?.m1).toBeTypeOf('number');
    expect(a.momentum?.m5).toBeTypeOf('number');
    expect(a.macd?.hist).toBeTypeOf('number');
  });
});

describe('INVARIANT: every modality with data casts a vote', () => {
  const base = () => analyze(candles({ drift: 0.002 }));

  it('TA_MEANREV moves with the band position', () => {
    const a = base();
    const low = fuseAlpha({ analysis: { ...a, bb: { ...a.bb, pos: 0.05 } } });
    const high = fuseAlpha({ analysis: { ...a, bb: { ...a.bb, pos: 0.95 } } });

    const lowVote = voteFor(low, 'TA_MEANREV');
    const highVote = voteFor(high, 'TA_MEANREV');
    expect(lowVote, 'TA_MEANREV cast no vote at all').not.toBeNull();
    // Mean reversion: at the lower band it wants up, at the upper band it wants down.
    expect(lowVote.vote).toBeGreaterThan(highVote.vote);
  });

  it('ORDER_FLOW moves with book imbalance', () => {
    const a = base();
    const bid = fuseAlpha({ analysis: a, book: { imbalance: 0.8, spreadPct: 0.4 } });
    const ask = fuseAlpha({ analysis: a, book: { imbalance: -0.8, spreadPct: 0.4 } });

    expect(voteFor(bid, 'ORDER_FLOW'), 'ORDER_FLOW cast no vote — is the book reaching it?').not.toBeNull();
    expect(voteFor(bid, 'ORDER_FLOW').vote).toBeGreaterThan(voteFor(ask, 'ORDER_FLOW').vote);
  });

  it('ORDER_FLOW is absent, not neutral, when no book is supplied', () => {
    // The distinction that matters: a missing book must not be recorded as a
    // balanced one. `components` is the operator's "why did this fire" log.
    expect(voteFor(fuseAlpha({ analysis: base() }), 'ORDER_FLOW')).toBeNull();
  });

  it('POSITIONING reads fundingRate, the key fetchFunding actually returns', () => {
    // backlog 36 sibling: `analyze()` renames fundingRate -> rate on the way out,
    // so passing the analysis's own funding object here would zero the vote.
    const a = base();
    const crowdedLong = fuseAlpha({ analysis: a, funding: { fundingRate: 0.0008, premium: 0.0006 } });
    const crowdedShort = fuseAlpha({ analysis: a, funding: { fundingRate: -0.0008, premium: -0.0006 } });

    expect(voteFor(crowdedLong, 'POSITIONING'), 'POSITIONING cast no vote').not.toBeNull();
    // Positive funding = crowded longs = fade them.
    expect(voteFor(crowdedLong, 'POSITIONING').vote).toBeLessThan(0);
    expect(voteFor(crowdedShort, 'POSITIONING').vote).toBeGreaterThan(0);
  });

  it('POSITIONING stays silent on the renamed key, so a regression is visible', () => {
    // If someone wires `analysis.funding` straight through again, this is what
    // it looks like: an object arrives, and the vote is still zero.
    const withRenamedKey = fuseAlpha({
      analysis: base(),
      funding: { rate: 0.0008, premium: 0 },
    });
    expect(voteFor(withRenamedKey, 'POSITIONING')).toBeNull();
  });

  it('CROSS_ASSET votes for ETH only, and follows the BTC lead', () => {
    const a = base();
    const up = fuseAlpha({ analysis: a, leadMom1: 0.06, isEth: true });
    const down = fuseAlpha({ analysis: a, leadMom1: -0.06, isEth: true });
    const btc = fuseAlpha({ analysis: a, leadMom1: 0.06, isEth: false });

    expect(voteFor(up, 'CROSS_ASSET')).not.toBeNull();
    expect(voteFor(up, 'CROSS_ASSET').vote).toBeGreaterThan(voteFor(down, 'CROSS_ASSET').vote);
    expect(voteFor(btc, 'CROSS_ASSET'), 'BTC voted on its own lead').toBeNull();
  });

  it('REGIME de-risks on the high-vol reading', () => {
    const a = base();
    const hot = fuseAlpha({ analysis: a, regimeSignal: { highVol: true } });
    expect(voteFor(hot, 'REGIME')).not.toBeNull();
    expect(hot!.regimePenalty).toBeLessThan(0);
    expect(hot!.alpha).toBeLessThan(fuseAlpha({ analysis: a })!.alpha);
  });

  it('VOL_TILT shrinks confidence as realized vol runs above baseline', () => {
    const a = base();
    const calm = fuseAlpha({ analysis: a, regimeSignal: { realizedVol: 0.008, calmBaseline: 0.008 } });
    const spike = fuseAlpha({ analysis: a, regimeSignal: { realizedVol: 0.03, calmBaseline: 0.008 } });

    expect(calm!.volScale).toBe(1);
    expect(spike!.volScale).toBeLessThan(1);
    expect(spike!.confidence).toBeLessThan(calm!.confidence);
  });
});

describe('applyAlphaFusion replaces the fields the pipeline trades on', () => {
  it('overwrites direction, confidence, score and edge', () => {
    // Stated as an invariant because it is the blast radius: fusion does not
    // annotate the analysis, it *replaces* the numbers every entry gate reads.
    const a = analyze(candles({ drift: 0.002 }));
    const fused = applyAlphaFusion(a, {});
    expect(fused.alphaFusion).not.toBeNull();
    for (const k of ['direction', 'confidence', 'score', 'edge']) {
      expect(fused[k], `${k} was not taken over by the fusion`).toBe(fused.alphaFusion[k]);
    }
  });

  it('passes a null analysis straight through', () => {
    expect(applyAlphaFusion(null, {})).toBeNull();
  });
});
