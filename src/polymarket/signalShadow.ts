/**
 * Signal shadow log — what every signal said, and what the market paid, for
 * every window the bot is watching, traded or not (backlog item 132).
 *
 * The trade records cannot answer "is this signal any good?". They hold only the
 * windows the bot chose to enter, at the prices that passed its gates, and they
 * carry the final direction and confidence but none of the inputs. This module
 * owns a separate table, `signal_shadow`, with one row per window per sampling
 * tick: the TA signal, the ML trace, a strike-distance probability, and both
 * sides' resting book. A resolver later fills in how the window ended.
 *
 * It is an observer. It reads values the scan loop already holds, writes only its
 * own table, never mutates its inputs, never throws into the caller, and imports
 * nothing from the cash ledger or the position store (a test pins that).
 *
 * The strike-distance probability is
 *
 *   P(up) = Φ( ln(S / K) / (σ · √τ) )
 *
 * S spot, K the window's opening price, σ per-minute volatility from completed
 * minutes strictly before now, τ minutes left. It is a model of the contract,
 * not a claim that it is mispriced: the whole point of the log is to find out
 * whether it beats the price the book offers.
 */
import { getDb } from './sqliteStore.js';
import { parseSlugWindow } from './windows.js';

/** One row per window per this interval. */
export const SHADOW_INTERVAL_MS = 20_000;
/** No rows in the first or last seconds of a window. */
export const MIN_ELAPSED_S = 10;
export const MIN_REMAINING_S = 10;
/** Completed minutes needed before a volatility estimate is trusted. */
export const MIN_SIGMA_RETURNS = 19;
const SIGMA_WINDOW_MIN = 60;
const MAX_MINUTES_KEPT = 180;
const RETENTION_DAYS = Number(process.env.SIGNAL_SHADOW_RETENTION_DAYS) || 14;

const r = (n: number, dp: number) => {
  const k = 10 ** dp;
  return Math.round(n * k) / k;
};
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── Pure model ───────────────────────────────────────────────────────────────

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, abs. error < 1.5e-7). */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592;
  const erf = 1 - poly * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * erf);
}

/**
 * Probability the window resolves Up, from distance to the strike.
 * Returns null when any input cannot support an estimate.
 */
export function strikeProbability({ spot, strike, sigmaPerMin, secondsLeft }: {
  spot: number; strike: number; sigmaPerMin: number | null; secondsLeft: number;
}): number | null {
  if (!(spot > 0) || !(strike > 0)) return null;
  if (!(Number(secondsLeft) >= 0)) return null;
  if (secondsLeft === 0) return spot >= strike ? 1 : 0;
  if (!(Number(sigmaPerMin) > 0)) return null;
  const tauMin = secondsLeft / 60;
  const z = Math.log(spot / strike) / (Number(sigmaPerMin) * Math.sqrt(tauMin));
  return normalCdf(z);
}

/** Population std of log returns between consecutive closes. Null when too few. */
export function realizedSigma(closes: number[], minReturns = MIN_SIGMA_RETURNS): number | null {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < minReturns) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
  const sd = Math.sqrt(variance);
  return sd > 0 ? sd : null;
}

// ── Minute buffer (spot) ─────────────────────────────────────────────────────

interface Minute { open: number; close: number }
const minutes: Record<string, Map<number, Minute>> = { btc: new Map(), eth: new Map() };
const minuteStart = (tsMs: number) => tsMs - (tsMs % 60_000);

/** Feed one spot tick. Keeps the first and last price of each minute. */
export function recordSpotTick(asset: string, price: number, tsMs: number): void {
  const buf = minutes[String(asset).toLowerCase()];
  if (!buf || !(price > 0) || !Number.isFinite(tsMs)) return;
  const k = minuteStart(tsMs);
  const m = buf.get(k);
  if (m) m.close = price;
  else {
    buf.set(k, { open: price, close: price });
    if (buf.size > MAX_MINUTES_KEPT) {
      const oldest = [...buf.keys()].sort((a, b) => a - b).slice(0, buf.size - MAX_MINUTES_KEPT);
      for (const key of oldest) buf.delete(key);
    }
  }
}

/** Closes of the completed minutes strictly before `tsMs`, oldest first. */
export function closesBefore(asset: string, tsMs: number, n = SIGMA_WINDOW_MIN): number[] {
  const buf = minutes[String(asset).toLowerCase()];
  if (!buf) return [];
  const cur = minuteStart(tsMs);
  const out: number[] = [];
  for (let i = n; i >= 1; i -= 1) {
    const m = buf.get(cur - i * 60_000);
    if (m) out.push(m.close);
  }
  return out;
}

/** First price seen in the minute containing `tsMs` (the "open" known at that time). */
export function minuteOpen(asset: string, tsMs: number): number | null {
  return minutes[String(asset).toLowerCase()]?.get(minuteStart(tsMs))?.open ?? null;
}

export function __resetShadowMinutes(): void {
  minutes.btc.clear();
  minutes.eth.clear();
}

// ── Row ──────────────────────────────────────────────────────────────────────

export interface ShadowInput {
  nowMs: number;
  mode: string;
  market: any;
  depth: any;
  signal: any;
  /** Compact ML trace points: `[{ label|minutes, direction, confidence, expectedReturn }]`. */
  mlPoints?: any[] | null;
  /** Latest Binance spot for the market's asset. */
  spot: number | null;
}

const side = (d: any) => ({
  bid: num(d?.bestBid), ask: num(d?.bestAsk),
  bidSize: num(d?.bestBidSize), askSize: num(d?.bestAskSize),
  bookTs: num(d?.bookTs),
});

/**
 * Build one row from values already in hand. Pure: the same inputs give the same
 * row, nothing is read from a clock or a store, and no input is modified.
 * Returns null outside the sampling band of the window, or for a slug that is
 * not a recognised up/down window.
 */
export function buildShadowRow(inp: ShadowInput) {
  const win = parseSlugWindow(inp.market?.slug);
  if (!win) return null;
  const elapsed = (inp.nowMs - win.startAtMs) / 1000;
  const left = (win.endAtMs - inp.nowMs) / 1000;
  if (!(elapsed >= MIN_ELAPSED_S) || !(left >= MIN_REMAINING_S)) return null;

  const asset = win.asset.toLowerCase();
  const sigma = realizedSigma(closesBefore(asset, inp.nowMs));
  const spot = num(inp.spot);
  const strikeOracle = num(inp.market?.priceToBeat);
  const strikeSpot = minuteOpen(asset, win.startAtMs);
  const pOracle = spot && strikeOracle ? strikeProbability({ spot, strike: strikeOracle, sigmaPerMin: sigma, secondsLeft: left }) : null;
  const pSpot = spot && strikeSpot ? strikeProbability({ spot, strike: strikeSpot, sigmaPerMin: sigma, secondsLeft: left }) : null;

  const up = side(inp.depth?.up);
  const down = side(inp.depth?.down);
  const bookTs = [up.bookTs, down.bookTs].filter((x): x is number => x != null);
  const ml = Array.isArray(inp.mlPoints)
    ? inp.mlPoints.map((p) => [p?.label ?? p?.minutes ?? null, p?.direction ?? null, r(Number(p?.confidence) || 0, 3), r(Number(p?.expectedReturn) || 0, 5)])
    : null;

  return {
    ts: inp.nowMs,
    slug: win.slug,
    symbol: win.asset,
    dur_s: win.windowSec,
    end_ms: win.endAtMs,
    elapsed_s: r(elapsed, 1),
    mode: String(inp.mode || ''),
    spot,
    strike_oracle: strikeOracle,
    strike_spot: strikeSpot,
    sigma_1m: sigma == null ? null : r(sigma, 7),
    p_up_oracle: pOracle == null ? null : r(pOracle, 4),
    p_up_spot: pSpot == null ? null : r(pSpot, 4),
    up_bid: up.bid, up_ask: up.ask, up_bid_size: up.bidSize, up_ask_size: up.askSize,
    down_bid: down.bid, down_ask: down.ask, down_bid_size: down.bidSize, down_ask_size: down.askSize,
    book_ts: bookTs.length ? Math.min(...bookTs) : null,
    book_source: inp.depth?.up?.source ?? inp.depth?.down?.source ?? null,
    ta_dir: inp.signal?.direction ?? null,
    ta_conf: num(inp.signal?.confidence),
    ta_score: num(inp.signal?.score),
    ml_json: ml ? JSON.stringify(ml) : null,
  };
}

// ── Cadence ──────────────────────────────────────────────────────────────────

/** At most one row per slug per interval. State is the caller's map. */
export function dueForSample(last: Map<string, number>, slug: string, nowMs: number, intervalMs = SHADOW_INTERVAL_MS): boolean {
  const prev = last.get(slug);
  if (prev != null && nowMs - prev < intervalMs) return false;
  last.set(slug, nowMs);
  if (last.size > 64) {
    for (const [k, t] of last) if (nowMs - t > 3_600_000) last.delete(k);
  }
  return true;
}

// ── Resolution parsing ───────────────────────────────────────────────────────

/**
 * Read a Gamma `/events?slug=` payload. Returns the window's result only when
 * the market has settled to a clean 1/0; anything else is "not yet".
 */
export function parseResolution(events: any): { outcomeUp: boolean; finalPrice: number | null; openPrice: number | null } | null {
  const ev = Array.isArray(events) ? events[0] : null;
  const m = ev?.markets?.[0];
  if (!m) return null;
  let outcomes: any; let prices: any;
  try {
    outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
    prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
  } catch { return null; }
  if (!Array.isArray(outcomes) || !Array.isArray(prices) || outcomes.length !== prices.length) return null;
  const i = outcomes.findIndex((o: any) => String(o).toLowerCase() === 'up');
  if (i < 0) return null;
  const pUp = Number(prices[i]);
  const others = prices.filter((_: any, j: number) => j !== i).map(Number);
  // Settled means one side is ~1 and the other ~0. A live book (0.55/0.45) is not a result.
  const settled = (pUp >= 0.99 && others.every((x: number) => x <= 0.01)) || (pUp <= 0.01 && others.some((x: number) => x >= 0.99));
  if (!settled) return null;
  return {
    outcomeUp: pUp >= 0.99,
    finalPrice: num(ev?.eventMetadata?.finalPrice),
    openPrice: num(ev?.eventMetadata?.priceToBeat),
  };
}

// ── Store ────────────────────────────────────────────────────────────────────

let started = false;
let unsubscribe: (() => void) | null = null;
let writeErrors = 0;
let lastError: string | null = null;
let stmtInsert: any = null;
const lastSampled = new Map<string, number>();

const COLUMNS = [
  'ts', 'slug', 'symbol', 'dur_s', 'end_ms', 'elapsed_s', 'mode', 'spot', 'strike_oracle', 'strike_spot',
  'sigma_1m', 'p_up_oracle', 'p_up_spot',
  'up_bid', 'up_ask', 'up_bid_size', 'up_ask_size', 'down_bid', 'down_ask', 'down_bid_size', 'down_ask_size',
  'book_ts', 'book_source', 'ta_dir', 'ta_conf', 'ta_score', 'ml_json',
] as const;

function ensureSchema(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_shadow (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            INTEGER NOT NULL,
      slug          TEXT NOT NULL,
      symbol        TEXT NOT NULL,
      dur_s         INTEGER NOT NULL,
      end_ms        INTEGER NOT NULL,
      elapsed_s     REAL NOT NULL,
      mode          TEXT,
      spot          REAL,
      strike_oracle REAL,
      strike_spot   REAL,
      sigma_1m      REAL,
      p_up_oracle   REAL,
      p_up_spot     REAL,
      up_bid        REAL, up_ask  REAL, up_bid_size   REAL, up_ask_size   REAL,
      down_bid      REAL, down_ask REAL, down_bid_size REAL, down_ask_size REAL,
      book_ts       INTEGER,
      book_source   TEXT,
      ta_dir        TEXT,
      ta_conf       REAL,
      ta_score      REAL,
      ml_json       TEXT,
      outcome_up    INTEGER,
      resolved_at   INTEGER,
      final_price   REAL,
      open_price    REAL
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_signal_shadow_slug ON signal_shadow(slug);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_signal_shadow_ts ON signal_shadow(ts);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_signal_shadow_open ON signal_shadow(outcome_up, end_ms);');
}

function noteError(err: unknown) {
  writeErrors += 1;
  lastError = (err as Error)?.message || String(err);
  if (writeErrors === 1 || writeErrors % 100 === 0) {
    console.error(`[signal-shadow] write failed (${writeErrors} total): ${lastError}`);
  }
}

/** Idempotent. Returns false (and logs nothing further) when sqlite is unavailable. */
export function startSignalShadow(onSpotTick?: (fn: (asset: string, price: number, ts: number) => void) => () => void): boolean {
  if (started) return true;
  const db = getDb();
  if (!db) {
    console.log('[signal-shadow] sqlite unavailable — shadow log disabled');
    return false;
  }
  try {
    ensureSchema(db);
    stmtInsert = db.prepare(
      `INSERT INTO signal_shadow (${COLUMNS.join(',')}) VALUES (${COLUMNS.map(() => '?').join(',')})`,
    );
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    db.prepare('DELETE FROM signal_shadow WHERE ts < ?').run(cutoff);
  } catch (err) {
    console.error(`[signal-shadow] schema init failed, disabled: ${(err as Error)?.message}`);
    return false;
  }
  if (onSpotTick) unsubscribe = onSpotTick((asset, price, ts) => recordSpotTick(asset, price, ts));
  started = true;
  return true;
}

export function stopSignalShadow(): void {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  started = false;
  stmtInsert = null;
  lastSampled.clear();
  resolveState.attempts.clear();
  resolveState.running = false;
  resolveState.lastRunAt = 0;
}

/**
 * Observe one market in the scan loop. Cheap and synchronous; safe to call on
 * every pass. Returns true when a row was written. Never throws.
 */
export function shadowObserve(args: { cfg?: any } & ShadowInput): boolean {
  try {
    if (!started || args.cfg?.signalShadow === false) return false;
    if (!dueForSample(lastSampled, String(args.market?.slug || ''), args.nowMs)) return false;
    const row = buildShadowRow(args);
    if (!row) return false;
    stmtInsert.run(...COLUMNS.map((c) => (row as any)[c] ?? null));
    return true;
  } catch (err) {
    noteError(err);
    return false;
  }
}

// ── Resolver ─────────────────────────────────────────────────────────────────

const RESOLVE_GRACE_MS = 90_000;
const RESOLVE_GIVE_UP_MS = 6 * 3_600_000;
const RESOLVE_MIN_GAP_MS = 60_000;
const RESOLVE_BATCH = 8;
const resolveState = { running: false, lastRunAt: 0, attempts: new Map<string, { n: number; next: number }>() };

/**
 * Fill `outcome_up` for windows that have ended. One Gamma call per window, at
 * most RESOLVE_BATCH per run, backed off per slug, abandoned after six hours.
 * `fetchImpl` is injectable for tests. Never throws.
 */
export async function resolvePending(opts: { nowMs?: number; fetchImpl?: typeof fetch } = {}): Promise<number> {
  const nowMs = opts.nowMs ?? Date.now();
  const doFetch = opts.fetchImpl ?? fetch;
  const db = getDb();
  if (!db || !started || resolveState.running) return 0;
  if (nowMs - resolveState.lastRunAt < RESOLVE_MIN_GAP_MS) return 0;
  resolveState.running = true;
  resolveState.lastRunAt = nowMs;
  let resolved = 0;
  try {
    const slugs: string[] = db.prepare(
      `SELECT DISTINCT slug FROM signal_shadow
       WHERE outcome_up IS NULL AND end_ms < ? AND end_ms > ?
       ORDER BY end_ms LIMIT 200`,
    ).all(nowMs - RESOLVE_GRACE_MS, nowMs - RESOLVE_GIVE_UP_MS).map((x: any) => x.slug);
    const update = db.prepare(
      'UPDATE signal_shadow SET outcome_up = ?, resolved_at = ?, final_price = ?, open_price = ? WHERE slug = ? AND outcome_up IS NULL',
    );
    let tried = 0;
    for (const slug of slugs) {
      if (tried >= RESOLVE_BATCH) break;
      const st = resolveState.attempts.get(slug) || { n: 0, next: 0 };
      if (nowMs < st.next) continue;
      tried += 1;
      try {
        const res = await doFetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`, {
          signal: AbortSignal.timeout(8000),
          headers: { Accept: 'application/json', 'User-Agent': 'zinger-signal-shadow/1' },
        });
        const parsed = res.ok ? parseResolution(await res.json()) : null;
        if (parsed) {
          update.run(parsed.outcomeUp ? 1 : 0, nowMs, parsed.finalPrice, parsed.openPrice, slug);
          resolveState.attempts.delete(slug);
          resolved += 1;
          continue;
        }
      } catch { /* fall through to back-off */ }
      st.n += 1;
      st.next = nowMs + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(st.n, 5));
      resolveState.attempts.set(slug, st);
    }
  } catch (err) {
    noteError(err);
  } finally {
    resolveState.running = false;
  }
  return resolved;
}

export function signalShadowStatus() {
  const db = getDb();
  let rows: number | null = null;
  let resolved: number | null = null;
  try {
    if (db && started) {
      rows = db.prepare('SELECT COUNT(*) AS n FROM signal_shadow').get()?.n ?? null;
      resolved = db.prepare('SELECT COUNT(*) AS n FROM signal_shadow WHERE outcome_up IS NOT NULL').get()?.n ?? null;
    }
  } catch { /* status must never throw */ }
  return { started, writeErrors, lastError, rows, resolved, minutesBuffered: { btc: minutes.btc.size, eth: minutes.eth.size } };
}
