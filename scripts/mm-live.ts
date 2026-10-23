/**
 * MM execution runner.
 *
 *   npx tsx scripts/mm-live.ts preflight --markets=<conditionId,...> [--auth] [--evidence=file.json]
 *   npx tsx scripts/mm-live.ts run --markets=<conditionId,...> [--mode=dry-run|live] [--minutes=10]
 *
 * dry-run (default): public books, in-memory venue, nothing is signed or sent.
 * live: refused unless every gate check in src/research/mm/live/gate.ts passes, the account
 * has no open orders and holds none of the quoted tokens (a dedicated, flat wallet).
 * Stop: Ctrl-C, SIGTERM or create the kill file. Every path cancels all orders first.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planMmQuote, DEFAULT_MM_CONFIG, type MmConfig, type MidObservation } from '../src/research/mm/strategy.js';
import { CANARY_LIMITS, MmLiveExecutor, type DesiredQuote, type ExecLimits, type JournalRow } from '../src/research/mm/live/executor.js';
import { DryRunVenue, type MmVenue, type TickSize } from '../src/research/mm/live/venue.js';
import { checkGeoblock, evaluateGate, killSwitch, limitsHash, readEvidence } from '../src/research/mm/live/gate.js';

const [cmd = 'run', ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : 'true']; }));
const allowed = ['markets', 'universe', 'mode', 'minutes', 'out', 'auth', 'evidence', 'kill-file', 'offset-ticks', 'max-markets'];
if (!['preflight', 'run'].includes(cmd) || Object.keys(args).some((k) => !allowed.includes(k))) {
  console.error(`usage: mm-live.ts preflight|run --markets=<ids> [--${allowed.slice(1).join(' --')}]`); process.exit(2);
}
const mode = (args.mode ?? 'dry-run') as 'dry-run' | 'live';
if (!['dry-run', 'live'].includes(mode)) throw Error('mode must be dry-run or live');
const killFile = args['kill-file'] ?? 'tmp/mm-live.KILL';
const limits: ExecLimits = { ...CANARY_LIMITS };
const offsetTicks = Number(args['offset-ticks'] ?? 1);
const CLOB = 'https://clob.polymarket.com';

async function get(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw Error(`${url.split('?')[0]} HTTP ${r.status}`);
  return r.json() as Promise<any>;
}

interface Market { conditionId: string; question: string; event: string; yes: string; no: string; tick: number; tickSize: TickSize; minShares: number; negRisk: boolean; fee: { rate: number; exponent: number }; endAt: number; rewardMinSize: number; rewardMaxSpread: number }

async function loadMarkets(): Promise<Market[]> {
  let ids = (args.markets ?? '').split(',').filter(Boolean);
  if (args.universe) ids = ids.concat(JSON.parse((await import('node:fs')).readFileSync(args.universe, 'utf8')).selected.map((c: any) => c.conditionId));
  ids = [...new Set(ids)].slice(0, Number(args['max-markets'] ?? 5));
  if (!ids.length) throw Error('no markets: pass --markets or --universe');
  const out: Market[] = [];
  for (const id of ids) {
    const [d, m] = await Promise.all([get(`${CLOB}/clob-markets/${id}`), get(`${CLOB}/markets/${id}`)]);
    const tokens = d.t?.map((t: any) => String(t.t));
    if (d.ao !== true || tokens?.length !== 2) { console.warn(`skip ${id}: not accepting orders`); continue; }
    let fee = d.fd ? { rate: Number(d.fd.r), exponent: Number(d.fd.e) } : null;
    if (!fee) { const r = await get(`${CLOB}/fee-rate?token_id=${tokens[0]}`); if (Number(r.base_fee) !== 0) { console.warn(`skip ${id}: unknown fee curve`); continue; } fee = { rate: 0, exponent: 1 }; }
    const tick = Number(d.mts);
    out.push({ conditionId: id, question: m.question ?? '', event: m.market_slug ?? id, yes: tokens[0], no: tokens[1], tick, tickSize: String(tick) as TickSize,
      minShares: Number(d.mos), negRisk: d.nr === true, fee, endAt: Date.parse(m.end_date_iso ?? d.gst ?? ''),
      rewardMinSize: Number(m.rewards?.min_size ?? 0), rewardMaxSpread: Number(m.rewards?.max_spread ?? 0) });
  }
  return out;
}

async function books(tokens: string[]) {
  const rows: any[] = await get(`${CLOB}/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tokens.map((t) => ({ token_id: t }))) });
  const at = Date.now();
  return new Map(rows.map((b) => [String(b.asset_id), {
    // `timestamp` is the book's last change, not its age; a successful fetch is current as of `at`.
    receivedAt: at, serverAt: at, changedAt: Number(b.timestamp) || null,
    bids: (b.bids ?? []).map((l: any) => ({ price: Number(l.price), size: Number(l.size) })),
    asks: (b.asks ?? []).map((l: any) => ({ price: Number(l.price), size: Number(l.size) })),
  }]));
}

/** Live client and SDK enums, loaded only after the gate passes. */
async function liveClient() {
  const sdk = await import('@polymarket/clob-client-v2');
  const trade: any = await import('../src/polymarket/trade.js');
  const client = await trade.getTradingClient();
  const creds = await trade.ensureApiKey();
  return { client, creds, enums: { buy: sdk.Side.BUY, sell: sdk.Side.SELL, gtc: sdk.OrderType.GTC, conditional: sdk.AssetType.CONDITIONAL }, trade };
}

async function preflight(markets: Market[]) {
  const geoblock = await checkGeoblock();
  let collateralUsd: number | undefined, account: Record<string, unknown> = { checked: false };
  if (args.auth === 'true') {
    const { client, trade } = await liveClient();
    const bal = await trade.getClobBalance();
    collateralUsd = Math.min(bal.balance, bal.allowance);
    const open = await client.getOpenOrders();
    const held: Record<string, number> = {};
    for (const m of markets) for (const t of [m.yes, m.no]) {
      const r = await client.getBalanceAllowance({ asset_type: (await import('@polymarket/clob-client-v2')).AssetType.CONDITIONAL, token_id: t });
      held[t] = Number(r?.balance ?? 0) / 1e6;
    }
    account = { checked: true, collateralUsd, openOrders: Array.isArray(open) ? open.length : null, heldShares: held,
      flat: Object.values(held).every((v) => v === 0), noOpenOrders: Array.isArray(open) && open.length === 0 };
  }
  const gate = evaluateGate({ mode: 'live', limits, env: process.env, geoblock, collateralUsd, evidence: readEvidence(args.evidence), killFile });
  return { limitsHash: limitsHash(limits), limits, gate, account, markets: markets.map((m) => ({ id: m.conditionId, q: m.question, tick: m.tick, minShares: m.minShares, rewardMinSize: m.rewardMinSize, negRisk: m.negRisk })) };
}

async function run(markets: Market[]) {
  const out = args.out ?? join('tmp', 'mm-live', `${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(out, { recursive: true });
  const journalPath = join(out, 'journal.jsonl');
  const journal = (r: JournalRow) => appendFileSync(journalPath, JSON.stringify(r) + '\n');
  const kill = killSwitch(killFile);

  let venue: MmVenue, dry: DryRunVenue | null = null, channel: { stop(): void } | null = null;
  let ex: MmLiveExecutor;
  const quotedTokens = markets.flatMap((m) => [m.yes, m.no]);
  if (mode === 'live') {
    const pf = await preflight(markets);
    if (!pf.gate.armed) { console.error(JSON.stringify(pf.gate.checks.filter((c) => !c.ok), null, 1)); throw Error('live gate not armed; nothing was sent'); }
    if (!(pf.account as any).flat || !(pf.account as any).noOpenOrders) throw Error('live needs a dedicated wallet with no open orders and no holdings in the quoted tokens; run preflight --auth');
    const { client, creds, enums } = await liveClient();
    const { ClobVenue } = await import('../src/research/mm/live/clobVenue.js');
    const { connectUserChannel } = await import('../src/research/mm/live/userChannel.js');
    const WebSocket = (await import('ws')).default;
    venue = new ClobVenue(client, enums, () => quotedTokens, (msg, data) => journal({ at: Date.now(), type: `venue:${msg}`, data }));
    ex = new MmLiveExecutor(venue, limits, journal, Date.now, kill);
    channel = connectUserChannel({ creds, markets: () => markets.map((m) => m.conditionId), WebSocketImpl: WebSocket as any,
      ours: (id) => [...ex.orders.values()].some((o) => o.venueOrderId === id),
      onFill: (f) => { void ex.onFill(f); }, onState: (s, d) => journal({ at: Date.now(), type: `user_channel:${s}`, detail: d }) });
  } else {
    dry = new DryRunVenue();
    venue = dry;
    ex = new MmLiveExecutor(venue, limits, journal, Date.now, kill);
    dry.onFill = (f) => { void ex.onFill(f); };
  }
  writeFileSync(join(out, 'config.json'), JSON.stringify({ mode, limits, limitsHash: limitsHash(limits), offsetTicks, markets }, null, 1));

  const cfg: MmConfig = { ...DEFAULT_MM_CONFIG, maxAgeMs: 5000, maxSpread: 0.2, quoteLifetimeMs: 10_000, feeReserveLegs: 1, quoteOffsetTicks: offsetTicks,
    maxNetShares: limits.maxNetSharesPerToken, maxMarketUsd: limits.maxMarketUsd, maxEventUsd: limits.maxMarketUsd, maxPortfolioUsd: limits.maxPortfolioUsd };
  const history = new Map<string, MidObservation[]>();
  const marks = new Map<string, number>();
  const stats = { cycles: 0, bookErrors: 0, placed: 0, cancelled: 0, reasons: {} as Record<string, number> };
  const endAt = Date.now() + Number(args.minutes ?? 10) * 60_000;
  let lastReconcile = 0, lastHeartbeat = 0;
  console.log(`mm-live ${mode}: ${markets.length} markets, journal ${journalPath}`);

  while (!ex.halted && Date.now() < endAt) {
    const t0 = Date.now();
    let bk: Awaited<ReturnType<typeof books>>;
    try { bk = await books(quotedTokens); } catch (e) { stats.bookErrors++; journal({ at: t0, type: 'book_error', error: String(e?.message ?? e) }); await sleep(1000); continue; }
    const desired: DesiredQuote[] = [];
    for (const m of markets) {
      for (const token of [m.yes, m.no]) {
        const b = bk.get(token);
        if (!b?.bids.length || !b.asks.length) { marks.delete(token); continue; }
        const mid = (Math.max(...b.bids.map((l) => l.price)) + Math.min(...b.asks.map((l) => l.price))) / 2;
        marks.set(token, mid);
        const h = (history.get(token) ?? []).filter((p) => p.at > t0 - 60_000); h.push({ at: b.receivedAt, mid }); history.set(token, h);
        dry?.touch(token, Math.max(...b.bids.map((l) => l.price)), Math.min(...b.asks.map((l) => l.price)));
        if (token !== m.yes) continue; // one outcome per market; the NO side is the mirror book
        const held = ex.position.get(token) ?? 0;
        const shares = Math.max(m.minShares, m.rewardMinSize || 0);
        const plan = planMmQuote({ now: Date.now(), receivedAt: b.receivedAt, serverAt: b.serverAt, usable: true, book: { bids: b.bids, asks: b.asks }, history: h,
          tick: m.tick, minShares: m.minShares, fee: m.fee, accepting: true, eventAt: Number.isFinite(m.endAt) ? m.endAt : null, eventTimeRequired: false,
          cashAvailableUsd: Math.max(0, limits.maxPortfolioUsd + ex.cash), ownedShares: Math.max(0, held), netOutcomeShares: held,
          marketCommittedUsd: 0, eventCommittedUsd: 0, portfolioCommittedUsd: 0 }, { ...cfg, maxOrderShares: shares }, 'touch');
        stats.reasons[plan.reason] = (stats.reasons[plan.reason] ?? 0) + 1;
        for (const q of plan.quotes) desired.push({ tokenId: token, conditionId: m.conditionId, event: m.event, side: q.side, price: q.price, shares: q.shares, tick: m.tick, tickSize: m.tickSize, negRisk: m.negRisk });
      }
    }
    const r = await ex.step(desired, marks);
    stats.placed += r.placed; stats.cancelled += r.cancelled; stats.cycles++;
    if (Date.now() - lastReconcile > 5000) { await ex.reconcile(); lastReconcile = Date.now(); }
    if (mode === 'live' && Date.now() - lastHeartbeat > 5000) { await ex.heartbeat(); lastHeartbeat = Date.now(); }
    await sleep(Math.max(0, 1000 - (Date.now() - t0)));
  }

  const clean = await ex.shutdown(ex.halted ?? 'run_complete');
  channel?.stop();
  const summary = { mode, halted: ex.halted, cleanShutdown: clean, ...stats, positions: Object.fromEntries(ex.position), cash: round(ex.cash),
    equityUsd: round(ex.equity(marks) ?? NaN), orders: [...ex.orders.values()].reduce((s, o) => ({ ...s, [o.state]: (s[o.state] ?? 0) + 1 }), {} as Record<string, number>) };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  if (!clean) process.exitCode = 1;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number) => Math.round(n * 1e4) / 1e4;

const markets = await loadMarkets();
if (cmd === 'preflight') console.log(JSON.stringify(await preflight(markets), null, 1));
else await run(markets);
