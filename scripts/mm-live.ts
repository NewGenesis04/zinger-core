/**
 * MM execution runner.
 *
 *   npx tsx scripts/mm-live.ts preflight --markets=<conditionId,...> [--auth] [--evidence=file.json]
 *   npx tsx scripts/mm-live.ts run --markets=<conditionId,...> [--mode=dry-run|live] [--minutes=10] [--sides=both|yes]
 *
 * dry-run (default): public books, in-memory venue, nothing is signed or sent.
 * live: refused unless every gate check in src/research/mm/live/gate.ts passes, the account
 * has no open orders and holds none of the quoted tokens (a dedicated, flat wallet).
 * Stop: Ctrl-C, SIGTERM or create the kill file. Every path cancels all orders first.
 *
 * --quote-type=quote (default; GTC post-only) or quote-until (GTD post-only, renewed before it
 * lapses; --quote-ttl-s, default 180) sets how quotes rest. Exits are fill-and-kill sells with a
 * worst price exitSlippageTicks under the bid; see OrderKind in src/research/mm/live/venue.ts.
 *
 * --sides=both (default) bids YES and NO, the two sides Polymarket's reward scores together
 * (a NO bid counts as a YES ask). --sides=yes bids YES only, as before.
 * A market whose result passes -maxMarketLossUsd stops for the rest of the UTC day, across
 * restarts (tmp/mm-live/market-stops-<mode>.json), and its shares are sold at the best bid.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planMmQuote, DEFAULT_MM_CONFIG, type MmConfig, type MidObservation } from '../src/research/mm/strategy.js';
import { LIMIT_PROFILES, MmLiveExecutor, type DesiredQuote, type ExecLimits, type JournalRow } from '../src/research/mm/live/executor.js';
import { DryRunVenue, type MmVenue, type TickSize } from '../src/research/mm/live/venue.js';
import { marketRewardShare, markouts, midAfter, type FillMark } from '../src/research/mm/live/evaluation.js';
import { checkGeoblock, evaluateGate, killSwitch, limitsHash, readEvidence } from '../src/research/mm/live/gate.js';
import { POLY } from '../src/polymarket/config.js';

const [cmd = 'run', ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : 'true']; }));
const allowed = ['markets', 'universe', 'mode', 'minutes', 'out', 'auth', 'evidence', 'kill-file', 'offset-ticks', 'max-markets', 'budget', 'sides', 'quote-type', 'quote-ttl-s', 'max-net-shares'];
if (!['preflight', 'run'].includes(cmd) || Object.keys(args).some((k) => !allowed.includes(k))) {
  console.error(`usage: mm-live.ts preflight|run --markets=<ids> [--${allowed.slice(1).join(' --')}]`); process.exit(2);
}
const mode = (args.mode ?? 'dry-run') as 'dry-run' | 'live';
if (!['dry-run', 'live'].includes(mode)) throw Error('mode must be dry-run or live');
const killFile = args['kill-file'] ?? 'tmp/mm-live.KILL';
if (!LIMIT_PROFILES[args.budget ?? '100']) throw Error(`--budget must be one of ${Object.keys(LIMIT_PROFILES).join(', ')}`);
const limits: ExecLimits = { ...LIMIT_PROFILES[args.budget ?? '100'] };
// Optional tighter inventory cap. In the 28 Oct replay, 50 shares cut the worst day from -$6.76
// to -$4.27 for about $4.50 less over four days. It can only lower the profile's cap.
if (args['max-net-shares'] != null) {
  const n = Number(args['max-net-shares']);
  if (!(n > 0 && n <= limits.maxNetSharesPerToken)) throw Error(`--max-net-shares must be above 0 and at most ${limits.maxNetSharesPerToken}`);
  limits.maxNetSharesPerToken = n;
}
const offsetTicks = Number(args['offset-ticks'] ?? 1);
const sides = (args.sides ?? 'both') as 'both' | 'yes';
if (!['both', 'yes'].includes(sides)) throw Error('--sides must be both or yes');
const quoteType = (args['quote-type'] ?? 'quote') as 'quote' | 'quote-until';
if (!['quote', 'quote-until'].includes(quoteType)) throw Error('--quote-type must be quote or quote-until');
const quoteTtlMs = Number(args['quote-ttl-s'] ?? 180) * 1000;
if (quoteType === 'quote-until' && !(quoteTtlMs >= 120_000)) throw Error('--quote-ttl-s must be at least 120 (the exchange adds a one-minute threshold)');
const CLOB = 'https://clob.polymarket.com';

async function get(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw Error(`${url.split('?')[0]} HTTP ${r.status}`);
  return r.json() as Promise<any>;
}

interface Market { conditionId: string; question: string; event: string; yes: string; no: string; tick: number; tickSize: TickSize; minShares: number; negRisk: boolean; fee: { rate: number; exponent: number }; endAt: number; rewardMinSize: number; rewardMaxSpread: number; dailyPool: number }

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
      rewardMinSize: Number(m.rewards?.min_size ?? 0), rewardMaxSpread: Number(m.rewards?.max_spread ?? 0),
      dailyPool: (m.rewards?.rates ?? []).reduce((s: number, r: any) => s + Number(r.rewards_daily_rate ?? 0), 0) });
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
  return { client, creds, enums: { buy: sdk.Side.BUY, sell: sdk.Side.SELL, gtc: sdk.OrderType.GTC, conditional: sdk.AssetType.CONDITIONAL, fak: sdk.OrderType.FAK, fok: sdk.OrderType.FOK, gtd: sdk.OrderType.GTD }, trade };
}

async function preflight(markets: Market[]) {
  const geoblock = await checkGeoblock();
  let collateralUsd: number | undefined, account: Record<string, unknown> = { checked: false };
  if (args.auth === 'true') {
    const { client, trade } = await liveClient();
    const bal = await trade.getClobBalance();
    collateralUsd = Math.min(bal.balance, bal.allowance);
    const open = await client.getOpenOrders();
    const held: Record<string, number | null> = {}, balanceErrors: string[] = [];
    const conditional = (await import('@polymarket/clob-client-v2')).AssetType.CONDITIONAL;
    for (const m of markets) for (const t of [m.yes, m.no]) {
      const r = await client.getBalanceAllowance({ asset_type: conditional, token_id: t });
      const v = Number(r?.balance);
      // A missing or malformed balance is unknown, never zero: the wallet does not count as flat.
      if (r?.error || r?.balance == null || !Number.isFinite(v) || v < 0) { held[t] = null; balanceErrors.push(t); } else held[t] = v / 1e6;
    }
    account = { checked: true, collateralUsd, openOrders: Array.isArray(open) ? open.length : null, heldShares: held, balanceErrors,
      flat: balanceErrors.length === 0 && Object.values(held).every((v) => v === 0), noOpenOrders: Array.isArray(open) && open.length === 0 };
  }
  const gate = evaluateGate({ mode: 'live', limits, env: process.env, geoblock, collateralUsd, evidence: readEvidence(args.evidence), killFile });
  // Polymarket runs on Polygon mainnet (chain 137) only; a different chain id means a misconfigured client.
  const network = { chainId: POLY.chainId, mainnet: POLY.chainId === 137, clobHost: process.env.CLOB_API_URL?.trim() || CLOB };
  return { limitsHash: limitsHash(limits), limits, network, gate, account, markets: markets.map((m) => ({ id: m.conditionId, q: m.question, tick: m.tick, minShares: m.minShares, rewardMinSize: m.rewardMinSize, negRisk: m.negRisk })) };
}

async function run(markets: Market[]) {
  const out = args.out ?? join('tmp', 'mm-live', `${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(out, { recursive: true });
  const journalPath = join(out, 'journal.jsonl');
  const journal = (r: JournalRow) => appendFileSync(journalPath, JSON.stringify(r) + '\n');
  const kill = killSwitch(killFile);
  // One runner per wallet on this host, held until shutdown has confirmed nothing rests.
  // Another host on the same wallet is caught by reconciliation (its orders are orphans: halt).
  const lockPath = `tmp/mm-live.${mode}.lock`;
  mkdirSync('tmp', { recursive: true });
  let lockFd: number;
  try { lockFd = openSync(lockPath, 'wx'); } catch { throw Error(`${lockPath} exists: another ${mode} runner is active, or an earlier one did not confirm a clean shutdown. Check the venue for open orders, then delete it.`); }
  writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), out }));
  // Loss ledger: results of earlier sessions count against the loss limit.
  const ledgerPath = join('tmp', 'mm-live', `loss-ledger-${mode}.json`);
  const ledger: { sessions: { endedAt: string; pnlUsd: number; out: string }[] } = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { sessions: [] };
  const priorPnlUsd = ledger.sessions.reduce((t, x) => t + x.pnlUsd, 0);
  if (limits.maxLossUsd + priorPnlUsd <= 0) { closeSync(lockFd); unlinkSync(lockPath); throw Error(`loss ledger ${ledgerPath}: earlier sessions lost $${(-priorPnlUsd).toFixed(2)}, the full $${limits.maxLossUsd} limit`); }
  // Market stops last the UTC day, so a restart does not resume a market that was stopped out.
  const stopsPath = join('tmp', 'mm-live', `market-stops-${mode}.json`);
  const today = new Date().toISOString().slice(0, 10);
  const stopsFile: { date: string; markets: Record<string, { at: number; lossUsd: number }> } = existsSync(stopsPath) ? JSON.parse(readFileSync(stopsPath, 'utf8')) : { date: today, markets: {} };
  const priorStops = stopsFile.date === today ? stopsFile.markets : {};

  const fills: FillMark[] = [];
  const series = new Map<string, { at: number; mid: number }[]>();
  let venue: MmVenue, dry: DryRunVenue | null = null, channel: { stop(): void } | null = null;
  let ex: MmLiveExecutor | null = null;
  let clean = false, failure: unknown = null;
  const stats = { cycles: 0, bookErrors: 0, placed: 0, cancelled: 0, reasons: {} as Record<string, number> };
  const marks = new Map<string, number>();
  const reward = new Map<string, { usd: number; quotedMs: number; eligibleMs: number }>();
  // Live status for the Command Center (/api/mm), rewritten atomically every cycle.
  let writeStatus: (final?: Record<string, unknown>) => void = () => {};
  try {
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
    const live = new MmLiveExecutor(venue, limits, journal, Date.now, kill);
    ex = live;
    channel = connectUserChannel({ creds, markets: () => markets.map((m) => m.conditionId), WebSocketImpl: WebSocket as any,
      ours: (id) => [...live.orders.values()].some((o) => o.venueOrderId === id),
      onFill: (f) => { void live.onFill(f); }, onState: (s, d) => journal({ at: Date.now(), type: `user_channel:${s}`, detail: d }) });
  } else {
    dry = new DryRunVenue();
    venue = dry;
    const sim = new MmLiveExecutor(venue, limits, journal, Date.now, kill);
    ex = sim;
    dry.onFill = (f) => { fills.push({ side: f.side, price: f.price, shares: f.shares, at: f.at, token: f.tokenId }); void sim.onFill(f); };
  }
  ex.priorPnlUsd = priorPnlUsd;
  for (const [c, st] of Object.entries(priorStops)) ex.stoppedMarkets.set(c, st);
  writeFileSync(join(out, 'config.json'), JSON.stringify({ mode, sides, quoteType, quoteTtlMs: quoteType === 'quote-until' ? quoteTtlMs : null, limits, limitsHash: limitsHash(limits), offsetTicks, priorStops, markets }, null, 1));

  const cfg: MmConfig = { ...DEFAULT_MM_CONFIG, maxAgeMs: 5000, maxSpread: 0.2, quoteLifetimeMs: 10_000, feeReserveLegs: 1, quoteOffsetTicks: offsetTicks,
    maxNetShares: limits.maxNetSharesPerToken, maxMarketUsd: limits.maxMarketUsd, maxEventUsd: limits.maxEventUsd, maxPortfolioUsd: limits.maxPortfolioUsd };
  const history = new Map<string, MidObservation[]>();
  const endAt = Date.now() + Number(args.minutes ?? 10) * 60_000;
  let lastReconcile = 0, lastHeartbeat = 0, bookDownSince: number | null = null;
  const x = ex;
  // Reconciliation and heartbeats run every cycle, including cycles without fresh books.
  const service = async () => {
    if (Date.now() - lastReconcile > 5000) { await x.reconcile(); lastReconcile = Date.now(); }
    if (mode === 'live' && Date.now() - lastHeartbeat > 5000) { await x.heartbeat(); lastHeartbeat = Date.now(); }
  };
  console.log(`mm-live ${mode}: ${markets.length} markets, journal ${journalPath}`);
  const startedAt = Date.now();
  writeStatus = (final) => {
    const elapsedDays = Math.max(1e-9, stats.cycles / 86_400);
    const eq = x.equity(marks);
    const status = {
      at: Date.now(), pid: process.pid, mode, sides, quoteType, budget: args.budget ?? '100', limitsHash: limitsHash(limits), startedAt, endsAt: endAt, killFile,
      running: !final, halted: x.halted, cycles: stats.cycles, bookErrors: stats.bookErrors, placed: stats.placed, cancelled: stats.cancelled, reasons: stats.reasons,
      cashUsd: round(x.cash), equityUsd: eq == null ? null : round(eq), priorPnlUsd: round(priorPnlUsd),
      lossRoomUsd: eq == null ? null : round(limits.maxLossUsd + priorPnlUsd + eq), maxLossUsd: limits.maxLossUsd, maxMarketLossUsd: limits.maxMarketLossUsd, maxPortfolioUsd: limits.maxPortfolioUsd,
      fills: fills.length,
      estRewardUsdPerDay: 0,
      markets: markets.map((m) => {
        const r = reward.get(m.conditionId) ?? { usd: 0, quotedMs: 0, eligibleMs: 0 };
        const pnl = x.marketPnl(m.conditionId, marks);
        return { conditionId: m.conditionId, question: m.question, yesMid: marks.get(m.yes) ?? null, noMid: marks.get(m.no) ?? null,
          yesShares: round(x.position.get(m.yes) ?? 0), noShares: round(x.position.get(m.no) ?? 0), pnlUsd: pnl == null ? null : round(pnl),
          stopped: x.stoppedMarkets.get(m.conditionId) ?? null, estRewardUsdPerDay: round(r.usd / elapsedDays), quotedPct: round(r.quotedMs / 10 / Math.max(1, stats.cycles)),
          orders: x.liveOrders().filter((o) => o.tokenId === m.yes || o.tokenId === m.no).map((o) => ({ outcome: o.tokenId === m.yes ? 'YES' : 'NO', side: o.side, price: o.price, shares: o.shares, filled: round(o.filled), state: o.state, exit: !!o.exit, kind: o.kind ?? 'quote', expiresAt: o.expiresAt ?? null })) };
      }),
      ...final,
    };
    status.estRewardUsdPerDay = round(status.markets.reduce((t, m) => t + m.estRewardUsdPerDay, 0));
    const tmpPath = join(out, 'status.json.tmp');
    writeFileSync(tmpPath, JSON.stringify(status));
    renameSync(tmpPath, join(out, 'status.json'));
  };

  while (!ex.halted && Date.now() < endAt) {
    const t0 = Date.now();
    let bk: Awaited<ReturnType<typeof books>>;
    try { bk = await books(quotedTokens); bookDownSince = null; } catch (e) {
      stats.bookErrors++; bookDownSince ??= t0;
      journal({ at: t0, type: 'book_error', error: String(e?.message ?? e), downMs: t0 - bookDownSince });
      const stop = kill();
      // Quotes cannot be repriced without books: after 30 s, pull them rather than leave them stale.
      if (stop) await x.halt(`kill:${stop}`);
      else if (t0 - bookDownSince > 30_000) await x.halt('book_outage_30s');
      else await service();
      await sleep(Math.max(0, 1000 - (Date.now() - t0)));
      continue;
    }
    const desired: DesiredQuote[] = [];
    const tops = new Map<string, { bid: number; ask: number }>();
    for (const m of markets) {
      const top = new Map<string, { bid: number; ask: number }>();
      for (const token of [m.yes, m.no]) {
        const b = bk.get(token);
        if (!b?.bids.length || !b.asks.length) { marks.delete(token); continue; }
        const bid = Math.max(...b.bids.map((l) => l.price)), ask = Math.min(...b.asks.map((l) => l.price)), mid = (bid + ask) / 2;
        top.set(token, { bid, ask });
        marks.set(token, mid);
        tops.set(token, { bid, ask });
        if (!series.has(token)) series.set(token, []);
        series.get(token)!.push({ at: b.receivedAt, mid });
        const h = (history.get(token) ?? []).filter((p) => p.at > t0 - 60_000); h.push({ at: b.receivedAt, mid }); history.set(token, h);
        dry?.touch(token, bid, ask);
      }
      // Reward estimate on the YES book: our YES orders as they are, NO orders mirrored (NO bid p = YES ask 1-p).
      const yb = bk.get(m.yes);
      if (yb?.bids.length && yb.asks.length) {
        const r = reward.get(m.conditionId) ?? { usd: 0, quotedMs: 0, eligibleMs: 0 };
        const ours = ex.liveOrders().filter((o) => o.state === 'open' && (o.tokenId === m.yes || o.tokenId === m.no)).map((o) => o.tokenId === m.yes
          ? { side: o.side, price: o.price, shares: o.shares - o.filled }
          : { side: (o.side === 'BUY' ? 'SELL' : 'BUY') as 'BUY' | 'SELL', price: 1 - o.price, shares: o.shares - o.filled });
        if (ours.length) {
          const share = marketRewardShare(ours, yb, m.rewardMaxSpread, m.rewardMinSize);
          r.quotedMs += 1000; if (share > 0) r.eligibleMs += 1000;
          r.usd += share * m.dailyPool / 86_400;
        }
        reward.set(m.conditionId, r);
      }
      if (ex.stoppedMarkets.has(m.conditionId)) { stats.reasons.market_stopped = (stats.reasons.market_stopped ?? 0) + 1; continue; }
      for (const token of sides === 'both' ? [m.yes, m.no] : [m.yes]) {
        const b = bk.get(token);
        if (!top.has(token) || !b) continue;
        const other = token === m.yes ? m.no : m.yes;
        const held = ex.position.get(token) ?? 0;
        // Net exposure to this outcome: holding the other outcome offsets it (a YES+NO pair redeems for $1).
        const net = held - (ex.position.get(other) ?? 0);
        const shares = Math.max(m.minShares, m.rewardMinSize || 0);
        const plan = planMmQuote({ now: Date.now(), receivedAt: b.receivedAt, serverAt: b.serverAt, usable: true, book: { bids: b.bids, asks: b.asks }, history: history.get(token) ?? [],
          tick: m.tick, minShares: m.minShares, fee: m.fee, accepting: true, eventAt: Number.isFinite(m.endAt) ? m.endAt : null, eventTimeRequired: false,
          cashAvailableUsd: Math.max(0, limits.maxPortfolioUsd + ex.cash), ownedShares: Math.max(0, held), netOutcomeShares: net,
          marketCommittedUsd: 0, eventCommittedUsd: 0, portfolioCommittedUsd: 0 }, { ...cfg, maxOrderShares: shares }, 'touch');
        stats.reasons[plan.reason] = (stats.reasons[plan.reason] ?? 0) + 1;
        for (const q of plan.quotes) desired.push({ tokenId: token, conditionId: m.conditionId, event: m.event, side: q.side, price: q.price, shares: q.shares, tick: m.tick, tickSize: m.tickSize, negRisk: m.negRisk, kind: quoteType, ...(quoteType === 'quote-until' ? { ttlMs: quoteTtlMs } : {}) });
      }
    }
    const r = await ex.step(desired, marks, tops);
    stats.placed += r.placed; stats.cancelled += r.cancelled; stats.cycles++;
    await service();
    try { writeStatus(); } catch (e) { journal({ at: Date.now(), type: 'status_error', error: String(e?.message ?? e) }); }
    await sleep(Math.max(0, 1000 - (Date.now() - t0)));
  }

  } catch (e) { failure = e; }
  finally {
    // Every exit path, including a thrown error, cancels and verifies before leaving.
    if (ex) { try { clean = await ex.shutdown(ex.halted ?? (failure ? `runner_error:${String((failure as any)?.message ?? failure)}` : 'run_complete')); } catch (e) { journal({ at: Date.now(), type: 'shutdown_error', error: String(e?.message ?? e) }); } }
    else clean = true;
    channel?.stop();
    if (ex) {
      const eq = ex.equity(marks);
      ledger.sessions.push({ endedAt: new Date().toISOString(), pnlUsd: round(eq ?? ex.cash), out });
      mkdirSync(join('tmp', 'mm-live'), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1));
      const kept = stopsFile.date === today ? stopsFile.markets : {};
      writeFileSync(stopsPath, JSON.stringify({ date: today, markets: { ...kept, ...Object.fromEntries(ex.stoppedMarkets) } }, null, 1));
    }
    try { writeStatus({ cleanShutdown: clean, endedAt: Date.now(), failure: failure ? String((failure as any)?.message ?? failure) : null }); } catch { /* status is advisory */ }
    closeSync(lockFd);
    if (clean) unlinkSync(lockPath); else console.error(`shutdown not confirmed clean; ${lockPath} kept`);
  }
  if (!ex) throw failure;
  const elapsedDays = Math.max(1e-9, stats.cycles / 86_400);
  const rewardRows = markets.map((m) => { const r = reward.get(m.conditionId) ?? { usd: 0, quotedMs: 0, eligibleMs: 0 }; return { market: m.question.slice(0, 60), dailyPool: m.dailyPool, rewardMinSize: m.rewardMinSize, quotedPct: round(r.quotedMs / 10 / Math.max(1, stats.cycles)), eligiblePct: round(r.eligibleMs / 10 / Math.max(1, stats.cycles)), estRewardUsd: round(r.usd), estRewardUsdPerDay: round(r.usd / elapsedDays) }; });
  const evaluation = { fills: fills.length, filledShares: round(fills.reduce((s, f) => s + f.shares, 0)), markouts: markouts(fills, (t, at) => midAfter(series.get(t) ?? [], at)),
    estRewardUsdPerDay: round(rewardRows.reduce((s, r) => s + r.estRewardUsdPerDay, 0)), rewardByMarket: rewardRows };
  const summary = { mode, sides, budget: args.budget ?? '100', halted: ex.halted, stoppedMarkets: Object.fromEntries(ex.stoppedMarkets), cleanShutdown: clean, ...stats, evaluation, positions: Object.fromEntries(ex.position), cash: round(ex.cash),
    equityUsd: round(ex.equity(marks) ?? NaN), orders: [...ex.orders.values()].reduce((s, o) => ({ ...s, [o.state]: (s[o.state] ?? 0) + 1 }), {} as Record<string, number>) };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  if (!clean) process.exitCode = 1;
  if (failure) throw failure;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number) => Math.round(n * 1e4) / 1e4;

const markets = await loadMarkets();
if (cmd === 'preflight') console.log(JSON.stringify(await preflight(markets), null, 1));
else await run(markets);
