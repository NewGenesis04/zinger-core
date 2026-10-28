/**
 * Arming gate for live MM execution. Dry-run needs nothing. Live needs every check to pass;
 * the gate reports all failures at once and never partially arms.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ExecLimits } from './executor.js';

/** Hard ceiling for a first funded canary. Raising it is a code change, reviewed like one. */
export const CANARY_CEILING = { maxPortfolioUsd: 200, maxMarketUsd: 50, maxEventUsd: 100, maxOrderShares: 100, maxLossUsd: 20, maxMarketLossUsd: 5, maxOpenOrders: 20 };
export const CLOB_HOST = 'https://clob.polymarket.com';
/** Anything that would route orders somewhere other than the egress the region check ran from. */
export const RELAY_VARS = ['CLOB_PROXY_URL', 'CLOB_PROXY_API_URL', 'PROXY_URL', 'PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
export const MIN_POSITIVE_OOS_DAYS = 3;

export interface Geoblock { checked: boolean; blocked: boolean; country?: string; viaProxy: boolean; error?: string }
export interface Evidence { positiveOutOfSampleDays: number; portfolioNetUsdPerDay: number; source?: string }
export interface GateInput {
  mode: 'dry-run' | 'live';
  limits: ExecLimits;
  env: Record<string, string | undefined>;
  geoblock?: Geoblock;
  collateralUsd?: number;
  evidence?: Evidence | null;
  killFile: string;
}
export interface GateCheck { id: string; ok: boolean; detail: string }

/** The operator arms a specific limits config by echoing its hash in ZINGER_MM_LIVE_ACK. */
export function limitsHash(limits: ExecLimits) {
  const canonical = JSON.stringify(Object.keys(limits).sort().map((k) => [k, (limits as any)[k]]));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function readEvidence(path: string | undefined): Evidence | null {
  if (!path || !existsSync(path)) return null;
  try {
    const x = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isFinite(x.positiveOutOfSampleDays) || !Number.isFinite(x.portfolioNetUsdPerDay)) return null;
    return { positiveOutOfSampleDays: x.positiveOutOfSampleDays, portfolioNetUsdPerDay: x.portfolioNetUsdPerDay, source: path };
  } catch { return null; }
}

export function evaluateGate(x: GateInput): { armed: boolean; checks: GateCheck[] } {
  if (x.mode === 'dry-run') return { armed: false, checks: [{ id: 'mode', ok: true, detail: 'dry-run: orders go to the in-memory venue, nothing is signed or sent' }] };
  const L = x.limits, C = CANARY_CEILING, hash = limitsHash(L);
  const over = (Object.keys(C) as (keyof typeof C)[]).filter((k) => !(L[k] <= C[k]));
  const proxyVars = RELAY_VARS.filter((k) => x.env[k]?.trim());
  const host = x.env.CLOB_API_URL?.trim().replace(/\/+$/, '') || CLOB_HOST;
  const g = x.geoblock, e = x.evidence;
  const checks: GateCheck[] = [
    { id: 'live_flag', ok: x.env.ZINGER_MM_LIVE === '1', detail: 'ZINGER_MM_LIVE=1 must be set for this process' },
    { id: 'limits_ack', ok: x.env.ZINGER_MM_LIVE_ACK === hash, detail: `ZINGER_MM_LIVE_ACK must equal ${hash} (hash of the exact limits being armed)` },
    { id: 'canary_ceiling', ok: over.length === 0, detail: over.length ? `limits above canary ceiling: ${over.join(', ')}` : 'limits within canary ceiling' },
    { id: 'market_stop', ok: L.maxMarketLossUsd > 0, detail: L.maxMarketLossUsd > 0 ? `each market stops and exits at -$${L.maxMarketLossUsd}` : 'maxMarketLossUsd must be above 0: live needs the per-market stop' },
    { id: 'kill_file', ok: !existsSync(x.killFile), detail: `kill file ${x.killFile} must be absent` },
    { id: 'clob_host', ok: host === CLOB_HOST, detail: host === CLOB_HOST ? `orders go to ${CLOB_HOST}` : `CLOB_API_URL=${host} is not ${CLOB_HOST}; credentials and orders would go to an unchecked host` },
    { id: 'no_proxy', ok: proxyVars.length === 0, detail: proxyVars.length ? `proxy/relay configured (${proxyVars.join(', ')}); region must be checked from the real order egress` : 'direct egress' },
    { id: 'geoblock', ok: !!g?.checked && !g.blocked && !g.viaProxy, detail: !g?.checked ? `region check failed: ${g?.error ?? 'not run'}` : g.blocked ? `trading restricted from ${g.country ?? 'this region'}` : `allowed from ${g.country ?? 'unknown'}` },
    { id: 'collateral', ok: (x.collateralUsd ?? 0) >= L.maxPortfolioUsd, detail: `spendable collateral $${(x.collateralUsd ?? 0).toFixed(2)} must cover maxPortfolioUsd $${L.maxPortfolioUsd}` },
    { id: 'evidence', ok: !!e && e.positiveOutOfSampleDays >= MIN_POSITIVE_OOS_DAYS && e.portfolioNetUsdPerDay > 0,
      detail: e ? `${e.positiveOutOfSampleDays} positive out-of-sample days, portfolio ${e.portfolioNetUsdPerDay.toFixed(2)} USD/day (need ≥${MIN_POSITIVE_OOS_DAYS} and > 0)` : 'no out-of-sample evidence file' },
  ];
  return { armed: checks.every((c) => c.ok), checks };
}

/** Process-wide kill: a file anyone on the host can create, plus SIGINT/SIGTERM. */
export function killSwitch(file: string) {
  let signal: string | null = null;
  const set = (s: string) => () => { signal = s; };
  process.once('SIGINT', set('SIGINT'));
  process.once('SIGTERM', set('SIGTERM'));
  return () => signal ?? (existsSync(file) ? 'kill_file' : null);
}

export async function checkGeoblock(fetcher: typeof fetch = fetch, env = process.env): Promise<Geoblock> {
  const viaProxy = RELAY_VARS.some((k) => env[k]?.trim());
  try {
    const r = await fetcher('https://polymarket.com/api/geoblock', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { checked: false, blocked: true, viaProxy, error: `HTTP ${r.status}` };
    const j: any = await r.json();
    return { checked: typeof j?.blocked === 'boolean', blocked: j?.blocked !== false, country: j?.country, viaProxy };
  } catch (e) { return { checked: false, blocked: true, viaProxy, error: String(e?.message ?? e) }; }
}
