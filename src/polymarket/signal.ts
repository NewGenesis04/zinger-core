// @ts-nocheck
const BINANCE = 'https://api.binance.com';
const BINANCE_FUTURES = 'https://fapi.binance.com';

import { applyAlphaFusion } from './alphaFusion.js';
import { isHighVol, loadRegimeSignal } from './regimeSignal.js';

/**
 * Which regime label the alpha fusion should run under.
 *
 * Two sources can name one, and they see different axes:
 *
 *   jump model (ml/regime_emit.py)   ADX/ATR heuristic (ai/governor.js)
 *   n_states=2 — high-vol or not     trend-ride / scalp / arb-only
 *
 * The model's calm state is *spelled* 'trend', but that is a state name, not a
 * verdict: a two-state volatility model cannot see trend versus chop, and
 * `regimeSignal.ts` says so outright. The fork's wiring mapped that label
 * straight through, so every calm minute selected `REGIME_WEIGHTS.trend`
 * (momentum 0.45 vs chop's 0.20) and added a +0.4 "ride" vote — leaving 'chop'
 * unreachable whenever the ML side was emitting (backlog 37).
 *
 * So the model owns exactly one answer, high-vol, and defers the rest to ADX —
 * the same split `detectRegimeFromModel` uses on the governor side.
 */
export function resolveFusionRegime(mlSignal, adxRegime = null) {
  if (isHighVol(mlSignal)) return 'highvol';
  if (adxRegime === 'arb-only') return 'highvol';
  if (adxRegime === 'trend-ride') return 'trend';
  return 'chop';
}

/**
 * Pull jump-model regime + idio-vol context from the shared store (see
 * `regimeSignal.ts`, the single owner of that reading) so the alpha fusion can
 * de-risk during high-vol regimes. Called by the scan each pass.
 * Falls back silently — fusion still works with base TA alone.
 */
export async function loadFusionContext({ adxRegime = null } = {}) {
  try {
    const raw = loadRegimeSignal();
    // Nothing to say: no live model reading and no heuristic to fall back on.
    if (!raw && !adxRegime) return null;

    // The vol tilt is a separate axis from the regime label — it needs raw
    // magnitudes, which only the model carries, and it stays meaningful on a
    // calm reading. `highVol` is derived here rather than trusted off disk so
    // there is one definition of the label.
    const regimeSignal = raw
      ? { highVol: isHighVol(raw), realizedVol: raw.realizedVol, calmBaseline: raw.calmBaseline }
      : null;
    const btc = { regime: resolveFusionRegime(raw, adxRegime), regimeSignal };
    const eth = { ...btc };
    globalThis.__zingerFusionCtx = { ...(globalThis.__zingerFusionCtx || {}), btc, eth };
    return { btc, eth };
  } catch { /* fusion context is best-effort; base TA still works */ }
  return null;
}

/** Merge per-pass context (order book, funding, kill switch) into the fusion ctx. */
export function refreshFusionContext(partialCtx) {
  if (!partialCtx || typeof partialCtx !== 'object') return;
  const prev = globalThis.__zingerFusionCtx || {};
  const { enabled, ...perAsset } = partialCtx;
  globalThis.__zingerFusionCtx = {
    ...prev,
    ...(enabled === undefined ? {} : { enabled }),
    btc: { ...(prev.btc || {}), ...(perAsset.btc || {}) },
    eth: { ...(prev.eth || {}), ...(perAsset.eth || {}) },
  };
}

/**
 * Fusion rewrites `direction`, `confidence`, `score` and `edge` on the analysis,
 * so it changes every directional entry decision. `cfg.useAlphaFusion === false`
 * turns it off from config without a redeploy; the switch lives on the context
 * because that is the only channel `signal.ts` already reads.
 */
function fuseIfEnabled(analysis, ctx) {
  if (!analysis || ctx?.enabled === false) return analysis;
  return applyAlphaFusion(analysis, ctx || {});
}

export async function fetchCandles(symbol = 'BTCUSDT', interval = '1m', limit = 200) {
  const url = `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const data = await res.json();
  return data.map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    takerBuyBase: parseFloat(k[9] || 0),
  }));
}

/** Perp funding + mark premium — short-horizon risk sentiment */
export async function fetchFunding(symbol = 'BTCUSDT') {
  try {
    const url = `${BINANCE_FUTURES}/fapi/v1/premiumIndex?symbol=${symbol}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const d = await res.json();
    return {
      fundingRate: Number(d.lastFundingRate || 0),
      markPrice: Number(d.markPrice || 0),
      indexPrice: Number(d.indexPrice || 0),
      premium: d.markPrice && d.indexPrice
        ? (Number(d.markPrice) - Number(d.indexPrice)) / Number(d.indexPrice)
        : 0,
    };
  } catch {
    return null;
  }
}

function ema(prices, period) {
  const k = 2 / (period + 1);
  let v = prices.slice(0, period).reduce((s, p) => s + p, 0) / period;
  for (let i = period; i < prices.length; i++) v = prices[i] * k + v * (1 - k);
  return v;
}

function rsi(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  const ag = g / period, al = l / period;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function macd(prices) {
  const f = ema(prices, 12), s = ema(prices, 26);
  const m = f - s, sig = ema([...prices.slice(-9), m], 9);
  return { macd: m, signal: sig, hist: m - sig };
}

function bollinger(prices, period = 20) {
  const sl = prices.slice(-period);
  const m = sl.reduce((s, p) => s + p, 0) / period;
  const std = Math.sqrt(sl.reduce((s, p) => s + (p - m) ** 2, 0) / period);
  return { upper: m + 2 * std, mid: m, lower: m - 2 * std, width: (m + 2 * std - (m - 2 * std)) / m * 100 };
}

function adx(candles, period = 14) {
  if (candles.length < period + 2) return 25;
  const tr = [], plus = [], minus = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  const atr = tr.slice(-period).reduce((s, v) => s + v, 0) / period;
  const avgPlus = plus.slice(-period).reduce((s, v) => s + v, 0) / period;
  const avgMinus = minus.slice(-period).reduce((s, v) => s + v, 0) / period;
  const pDI = 100 * avgPlus / atr, nDI = 100 * avgMinus / atr;
  const dx = Math.abs(pDI - nDI) / (pDI + nDI) * 100;
  return { adx: dx, pDI, nDI, trend: dx > 25 ? (pDI > nDI ? 'up' : 'down') : 'range' };
}

function volumeProfile(candles, bins = 10) {
  const recent = candles.slice(-20);
  const low = Math.min(...recent.map(c => c.low));
  const high = Math.max(...recent.map(c => c.high));
  const binSize = (high - low) / bins;
  const profile = Array(bins).fill(0);
  for (const c of recent) {
    const idx = Math.min(Math.floor((c.close - low) / binSize), bins - 1);
    profile[idx] += c.volume;
  }
  const maxIdx = profile.indexOf(Math.max(...profile));
  return { poc: low + binSize * (maxIdx + 0.5), pocIdx: maxIdx, valueHigh: low + binSize * bins };
}

export function analyze(candles, extras = {}) {
  if (!candles || candles.length < 50) return null;

  const c = candles.map(x => x.close);
  const cur = c[c.length - 1];
  const prev = c[c.length - 2];
  const o5 = candles[candles.length - 5]?.close || cur;

  const mom = {
    m1: (cur - prev) / prev * 100,
    m5: (cur - o5) / o5 * 100,
    m15: c.length >= 15 ? (cur - c[c.length - 15]) / c[c.length - 15] * 100 : 0,
  };

  const ranges = candles.slice(-10).map(x => x.high - x.low);
  const atr = ranges.reduce((s, r) => s + r, 0) / ranges.length;
  const atrPct = atr / cur * 100;

  const rsiVal = rsi(c, 14);
  const macdData = macd(c);
  const bb = bollinger(c);
  const bbPos = (cur - bb.lower) / (bb.upper - bb.lower);
  const adxData = adx(candles);

  const v3 = candles.slice(-3).reduce((s, x) => s + x.volume, 0) / 3;
  const v6 = candles.slice(-6, -3).reduce((s, x) => s + x.volume, 0) / 3;
  const volRatio = v6 > 0 ? v3 / v6 : 1;

  const recent5 = candles.slice(-5);
  const vol5 = recent5.reduce((s, x) => s + (x.volume || 0), 0);
  const takerBuy5 = recent5.reduce((s, x) => s + (x.takerBuyBase || 0), 0);
  const takerBuyRatio = vol5 > 0 ? takerBuy5 / vol5 : 0.5;

  const vp = volumeProfile(candles);
  const ema9 = ema(c, 9), ema21 = ema(c, 21);
  const emaBull = ema9 > ema21;

  const priceHigher = cur > c[c.length - 5];
  const rsiHigher = rsiVal > rsi(c.slice(0, -4), 14);
  const bearDiv = priceHigher && !rsiHigher;
  const bullDiv = !priceHigher && rsiHigher;

  let score = 0;
  const signals = [];
  const shortW = 2.0;

  if (rsiVal < 25) { score += 3; signals.push('RSI_OVERSOLD'); }
  else if (rsiVal < 40) { score += 1.5; signals.push('rsi_low'); }
  else if (rsiVal > 75) { score -= 3; signals.push('RSI_OVERBOUGHT'); }
  else if (rsiVal > 60) { score -= 1.5; signals.push('rsi_high'); }

  if (mom.m1 > 0.05) { score += 1.8 * shortW * 0.5; signals.push('mom1_up'); }
  else if (mom.m1 < -0.05) { score -= 1.8 * shortW * 0.5; signals.push('mom1_down'); }
  if (mom.m1 > 0.08 && mom.m5 > 0.12) { score += 2; signals.push('mom_confluence_up'); }
  else if (mom.m1 < -0.08 && mom.m5 < -0.12) { score -= 2; signals.push('mom_confluence_down'); }
  if (Math.abs(mom.m15) > 0.25) {
    score += Math.sign(mom.m15) * 0.25;
    signals.push(mom.m15 > 0 ? 'mom15_soft_up' : 'mom15_soft_down');
  }

  if (macdData.hist > 0 && macdData.macd > 0) { score += 0.75; signals.push('macd_bull_strong'); }
  else if (macdData.hist > 0) { score += 0.25; signals.push('macd_bull'); }
  else if (macdData.hist < 0 && macdData.macd < 0) { score -= 0.75; signals.push('macd_bear_strong'); }
  else if (macdData.hist < 0) { score -= 0.25; signals.push('macd_bear'); }

  if (bbPos < 0.15) { score += 2; signals.push('bb_lower_band'); }
  else if (bbPos < 0.3) { score += 1; signals.push('bb_low'); }
  else if (bbPos > 0.85) { score -= 2; signals.push('bb_upper_band'); }
  else if (bbPos > 0.7) { score -= 1; signals.push('bb_high'); }
  if (bb.width < 3) signals.push('BB_SQUEEZE');

  if (adxData.trend === 'up') { score += 0.4; signals.push('adx_up'); }
  else if (adxData.trend === 'down') { score -= 0.4; signals.push('adx_down'); }
  if (adxData.adx > 30) signals.push('strong_trend');

  if (cur > ema9 && ema9 > ema21) { score += 0.5; signals.push('ema_bull'); }
  else if (cur < ema9 && ema9 < ema21) { score -= 0.5; signals.push('ema_bear'); }

  if (volRatio > 1.5 && mom.m1 > 0) { score += 1.2; signals.push('vol_surge_up'); }
  else if (volRatio > 1.5 && mom.m1 < 0) { score -= 1.2; signals.push('vol_surge_down'); }

  if (takerBuyRatio >= 0.58) { score += 1.4; signals.push('taker_buy_dom'); }
  else if (takerBuyRatio <= 0.42) { score -= 1.4; signals.push('taker_sell_dom'); }

  if (bearDiv) { score -= 1.5; signals.push('BEAR_DIV'); }
  if (bullDiv) { score += 1.5; signals.push('BULL_DIV'); }

  if (cur < vp.poc * 0.98) { score += 0.5; signals.push('below_poc'); }
  else if (cur > vp.poc * 1.02) { score -= 0.5; signals.push('above_poc'); }

  const funding = extras?.funding || null;
  if (funding && Number.isFinite(funding.fundingRate)) {
    if (funding.fundingRate > 0.00015) { score -= 0.8; signals.push('funding_long_crowd'); }
    else if (funding.fundingRate < -0.00015) { score += 0.8; signals.push('funding_short_crowd'); }
    if (Math.abs(funding.premium || 0) > 0.0008) {
      score += funding.premium > 0 ? -0.5 : 0.5;
      signals.push(funding.premium > 0 ? 'mark_premium' : 'mark_discount');
    }
  }

  const lead = extras?.leadMom1;
  if (lead != null && Number.isFinite(lead) && Math.abs(lead) > 0.04) {
    score += Math.sign(lead) * 1.1;
    signals.push(lead > 0 ? 'btc_lead_up' : 'btc_lead_down');
  }

  const skipTrade = atrPct > 0.5;
  const direction = score > 2.5 ? 'up' : score < -2.5 ? 'down' : 'neutral';
  const absScore = Math.abs(score);
  const confidence = Math.min(0.65, Math.round((0.28 + absScore * 0.055) * 100) / 100);
  const edge = Math.sign(score) * confidence;

  return {
    score: Math.round(score * 10) / 10,
    direction,
    confidence: Math.round(confidence * 100) / 100,
    edge: Math.round(edge * 100) / 100,
    rsi: Math.round(rsiVal * 10) / 10,
    macd: macdData,
    bb: {
      ...bb,
      // Band position, exported so the fusion's TA_MEANREV vote is not stuck at
      // the 0.5 fallback — it was computed here and never attached (backlog 36).
      // Guarded: a zero-width band divides by zero, and an unclamped position
      // outside [0,1] would saturate the vote on a single wick.
      pos: Number.isFinite(bbPos) ? Math.round(Math.max(0, Math.min(1, bbPos)) * 1000) / 1000 : 0.5,
    },
    adx: adxData,
    momentum: mom,
    volatility: { atr: Math.round(atr * 100) / 100, atrPct: Math.round(atrPct * 100) / 100 },
    volume: { ratio: Math.round(volRatio * 10) / 10, takerBuyRatio: Math.round(takerBuyRatio * 100) / 100 },
    ema: { ema9: Math.round(ema9 * 10) / 10, ema21, emaBull },
    funding: funding ? {
      rate: Math.round(funding.fundingRate * 1e6) / 1e6,
      premium: Math.round((funding.premium || 0) * 1e6) / 1e6,
    } : null,
    skipTrade,
    tooVolatile: skipTrade,
    signals,
    shortTf: true,
    price: cur,
    timestamp: Date.now(),
  };
}

export async function getSignal(asset = 'BTC', extras = {}) {
  const symbol = asset === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';
  const [candles, funding] = await Promise.all([
    fetchCandles(symbol),
    fetchFunding(symbol),
  ]);
  if (!candles) return null;
  const analysis = analyze(candles, { ...extras, funding });
  const ctx = extras.fusionCtx || globalThis.__zingerFusionCtx?.[asset === 'BTC' ? 'btc' : 'eth'] || {};
  return fuseIfEnabled(analysis, {
    ...ctx,
    funding,
    isEth: asset !== 'BTC',
    enabled: globalThis.__zingerFusionCtx?.enabled,
  });
}

export async function getSignalForBoth() {
  const [btcCandles, ethCandles, btcFund, ethFund] = await Promise.all([
    fetchCandles('BTCUSDT'),
    fetchCandles('ETHUSDT'),
    fetchFunding('BTCUSDT'),
    fetchFunding('ETHUSDT'),
  ]);
  const btcBase = btcCandles ? analyze(btcCandles, { funding: btcFund }) : null;
  const ethBase = ethCandles
    ? analyze(ethCandles, {
      funding: ethFund,
      leadMom1: btcBase?.momentum?.m1 ?? null,
    })
    : null;

  const fusionCtx = globalThis.__zingerFusionCtx || {};
  // `funding` is passed explicitly: the fusion's POSITIONING vote reads
  // `funding.fundingRate`, while `analyze()` renames it to `funding.rate` on the
  // way out — so reading it off the analysis would zero the vote. `fetchFunding`
  // returns { fundingRate, premium, ... }, which is the shape fuseAlpha wants.
  const btc = fuseIfEnabled(btcBase, {
    ...(fusionCtx.btc || {}),
    funding: btcFund,
    isEth: false,
    enabled: fusionCtx.enabled,
  });
  const eth = fuseIfEnabled(ethBase, {
    ...(fusionCtx.eth || {}),
    funding: ethFund,
    leadMom1: btcBase?.momentum?.m1 ?? null,
    isEth: true,
    enabled: fusionCtx.enabled,
  });
  return { btc, eth };
}

export async function fetchPriceHistory(symbol = 'BTCUSDT', interval = '5m', limit = 100) {
  return fetchCandles(symbol, interval, limit);
}
