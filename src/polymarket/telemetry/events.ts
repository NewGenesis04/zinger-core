import { EventEmitter } from 'node:events';

/**
 * D8 typed event bus.
 *
 * Events are the record; the human-readable line is a rendering of an event,
 * not where the data lives (`formatEventAsLog`, bottom of file).
 *
 * Two rules govern the payload shapes below, both settled in backlog item 48:
 *
 *   (ii) No rendered string is stored in an event. A rendering is derivable
 *        from a complete payload at any time; a field never captured is gone
 *        forever. All effort goes on payload completeness.
 *
 *  (iii) No prose inside payload fields. A field whose value is a sentence can
 *        be displayed but not filtered, counted, aggregated or diffed. Reasons
 *        are `{code, value, delta}`; skip reasons are a code plus the operands
 *        that produced it — never `'confidence 41% < 45%'`. Clients render.
 *
 * Version 2 adds `trade.execution.receipt`, `account.cash`, `account.reset`
 * and `arb.decision`, and replaces the former `data: Record<string, any>` with
 * a payload interface per event type.
 *
 * Imports nothing but `node:events` — safe to pull into any layer without a
 * cycle, which is what lets the order path emit without a dependency loop.
 */
export const TELEMETRY_SCHEMA_VERSION = 2;
export const DEFAULT_EVENT_BUFFER_CAP = Number(process.env.EVENT_BUFFER_CAP) || 30_000;

/* ------------------------------------------------------------------ *
 * Shared shapes
 * ------------------------------------------------------------------ */

/**
 * Rule (iii): a scoring reason is a code, the number that triggered it, and
 * its contribution to the score. `'arb gap +0.4c'` is a rendering of
 * `{code: 'arb_gap', value: 0.004, delta: 0.64}`, not a substitute for it.
 */
export interface DecisionReason {
  code: string;
  /** The measured number this reason fired on. */
  value?: number | null;
  /** Its contribution to the score, where it has one. */
  delta?: number | null;
  /**
   * The other side of a comparison, so `confidence_below_min` carries both the
   * 0.41 and the 0.45 rather than a client having to know the threshold — or
   * worse, parse it back out of a sentence.
   */
  operands?: Record<string, number | string | boolean | null>;
}

/** Rule (iii) for the negative case: why no order was placed. */
export interface SkipReason {
  code: string;
  /** The numbers that produced the skip, e.g. `{confidence: 0.41, min: 0.45}`. */
  operands?: Record<string, number | string | boolean | null>;
}

/**
 * Transitional escape hatch.
 *
 * The payloads that `log()` still feeds (`bot.ts:1053-1058`) spread an
 * arbitrary `meta` object, so a closed interface would be a lie about what is
 * actually on the bus today. These carry an index signature so the declared
 * type stays honest, and it comes off per event type as each explicit tee
 * lands in item 48 steps C-E and becomes the single writer.
 *
 * The four types introduced in v2 have no index signature: nothing legacy
 * emits them, so their contract is closed from the start.
 */
export interface LegacyMeta {
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Payloads
 * ------------------------------------------------------------------ */

export interface ScanCyclePayload extends LegacyMeta {
  scan?: number;
  scanNumber?: number;
  buyCount?: number;
  marketCount?: number;
  markets?: Array<{
    symbol?: string;
    slug?: string;
    action?: string;
    remaining?: number | null;
    [key: string]: unknown;
  }>;
  remainingFormatted?: string;
}

export interface TradeDecisionPayload extends LegacyMeta {
  engine?: string;
  symbol?: string;
  slug?: string;
  outcome?: string;
  mode?: string;
  action?: string;
  confidence?: number | null;
  /** Model inputs the decision was taken on — prices, book, signal, regime. */
  inputs?: Record<string, number | string | boolean | null>;
  scoring?: {
    score?: number;
    eligible?: boolean;
    reasons?: DecisionReason[];
  };
  /** The kelly chain and every cap, plus which bound actually applied. */
  sizing?: {
    kellyFraction?: number | null;
    kellyRaw?: number | null;
    volTilt?: number | null;
    bankroll?: number | null;
    uncappedUsd?: number | null;
    sizeUsd?: number | null;
    caps?: Record<string, number | null>;
    boundBy?: string | null;
  };
  output?: {
    action?: string;
    skipReason?: SkipReason | null;
  };
}

export interface TradeExecutionPayload extends LegacyMeta {
  id?: string;
  mode?: string;
  symbol?: string;
  slug?: string;
  outcome?: string;
  size?: number | null;
  price?: number | null;
  shares?: number | null;
  orderId?: string | null;
  fee?: number | null;
  engine?: string;
  timestamp?: number;
}

/**
 * The whole `ClobReceipt` record, structurally.
 *
 * Declared here rather than imported from `clobReceipts.ts` so this module
 * keeps its single `node:events` import. `clobReceipts` satisfies this shape;
 * it does not depend on it.
 */
export interface TradeExecutionReceiptPayload {
  at: string;
  fn: string;
  phase: 'response' | 'throw';
  request: Record<string, unknown>;
  raw?: unknown;
  rawKeys?: string[];
  rawType?: string;
  derived?: Record<string, unknown>;
  error?: {
    message: string;
    name?: string;
    code?: unknown;
    status?: unknown;
    body?: unknown;
  };
}

export interface PositionExitPayload extends LegacyMeta {
  exitReason?: string;
  symbol?: string;
  slug?: string;
  outcome?: string;
  mode?: string;
  entryPrice?: number | null;
  exitPrice?: number | null;
  pnl?: number | null;
  netPnl?: number | null;
  gainPct?: number | null;
  shares?: number | null;
  fee?: number | null;
}

export interface PackageSettlementPayload extends LegacyMeta {
  packageId?: string;
  symbol?: string;
  slug?: string;
  action?: string;
  mode?: string;
  shares?: number | null;
  lockedProfitUsd?: number | null;
  grossPnl?: number | null;
  netPnl?: number | null;
  fees?: number | null;
  txHash?: string | null;
}

/** The arb variant of a decision: why a package was or was not opened. */
export interface ArbDecisionPayload {
  symbol?: string;
  slug?: string;
  mode?: string;
  upAsk?: number | null;
  downAsk?: number | null;
  asksSum?: number | null;
  arbGap?: number | null;
  minArbGap?: number | null;
  breakEvenGap?: number | null;
  requiredGap?: number | null;
  fees?: {
    takerFeeUsdc?: number | null;
    feeParams?: Record<string, number | null>;
  };
  sizing?: {
    shares?: number | null;
    costUp?: number | null;
    costDown?: number | null;
    capitalUsd?: number | null;
    boundBy?: string | null;
  };
  output?: {
    action?: 'open' | 'skip';
    skipReason?: SkipReason | null;
  };
}

/** Cash state at a `saveStore` boundary, with the reconcile that produced it. */
export interface AccountCashPayload {
  mode?: string;
  clob?: number | null;
  lifetimeBaseline?: number | null;
  baselineUsd?: number | null;
  pmRealizedSum?: number | null;
  botVerifiedSum?: number | null;
  reconcile?: Record<string, number | string | boolean | null> | null;
  mismatches?: Array<Record<string, unknown>>;
  mismatchCount?: number;
  ok?: boolean;
}

/** What a reset cleared — the archive entry built at the reset site. */
export interface AccountResetPayload {
  at?: number;
  mode?: string;
  reason?: string;
  baselineUsd?: number | null;
  clearedTrades?: number;
  clearedPositions?: number;
  clearedPackages?: number;
  archive?: Record<string, unknown>;
}

export interface DataAssurancePayload extends LegacyMeta {
  canBuy?: boolean;
  score?: number;
  blocking?: string[] | null;
  /** Rule (iii): `note` is legacy prose, kept while `log()` still writes it. */
  note?: string;
}

export interface SystemAlertPayload extends LegacyMeta {
  /** lifecycle | health | data_gate | config — added with item 48 step D. */
  kind?: string;
  level?: string;
  message?: string;
  detail?: Record<string, unknown> | null;
}

export interface ConfigAttributedPayload extends LegacyMeta {
  key?: string;
  from?: unknown;
  to?: unknown;
  tier?: string;
  source?: string;
}

/**
 * The single registry. `EventType` is derived from it, so a new event type
 * cannot be added without a payload, and the two cannot drift apart.
 */
export interface TelemetryEventPayloads {
  'scan.cycle': ScanCyclePayload;
  'trade.decision': TradeDecisionPayload;
  'trade.execution': TradeExecutionPayload;
  'trade.execution.receipt': TradeExecutionReceiptPayload;
  'position.exit': PositionExitPayload;
  'package.settlement': PackageSettlementPayload;
  'arb.decision': ArbDecisionPayload;
  'account.cash': AccountCashPayload;
  'account.reset': AccountResetPayload;
  'data.assurance': DataAssurancePayload;
  'system.alert': SystemAlertPayload;
  'config.attributed': ConfigAttributedPayload;
}

export type EventType = keyof TelemetryEventPayloads;

export interface BaseTelemetryEvent<T extends EventType = EventType> {
  id: string;
  type: T;
  v: number;
  ts: number;
  data: TelemetryEventPayloads[T];
}

export interface EventQueryFilter {
  type?: EventType | EventType[];
  symbol?: string;
  slug?: string;
  since?: number;
  limit?: number;
  level?: string;
  /** Return events strictly after this event id, in buffer order. */
  after?: string;
}

/**
 * A cursor-addressed page of events.
 *
 * The ring buffer evicts silently (`shift()`), so a cursor that has fallen off
 * the back is indistinguishable from a cursor that is simply current — both
 * would yield an empty list. That ambiguity is the whole defect: a consumer
 * cannot tell "you are up to date" from "you have a hole". Hence `dropped`,
 * `oldestId` and `evicted`, which make the lossy case explicit.
 */
export interface EventPage {
  events: BaseTelemetryEvent[];
  /** Oldest id still retained. A cursor older than this is unrecoverable. */
  oldestId: string | null;
  /** Newest id retained — what a caller should store as its next cursor. */
  newestId: string | null;
  /**
   * The supplied cursor was not found in the buffer: evicted, from a previous
   * process, or malformed. All three mean continuity cannot be assumed.
   */
  dropped: boolean;
  /** Events evicted since process start. Monotonic; resets only on `clear()`. */
  evicted: number;
  /** More events match beyond this page — call again with the new cursor. */
  hasMore: boolean;
}

/* ------------------------------------------------------------------ *
 * Bus
 * ------------------------------------------------------------------ */

class TelemetryBus extends EventEmitter {
  private buffer: BaseTelemetryEvent[] = [];
  private maxCap: number = DEFAULT_EVENT_BUFFER_CAP;
  private seq: number = 0;
  /** Count of events dropped off the back. Without this, loss is invisible. */
  private evicted: number = 0;
  private subscriberErrors: number = 0;
  private lastSubscriberError: string | null = null;

  constructor(maxCap: number = DEFAULT_EVENT_BUFFER_CAP) {
    super();
    this.maxCap = maxCap;
  }

  public setCapacity(newCap: number): void {
    this.maxCap = Math.max(100, newCap);
    if (this.buffer.length > this.maxCap) {
      const overflow = this.buffer.length - this.maxCap;
      this.evicted += overflow;
      this.buffer = this.buffer.slice(-this.maxCap);
    }
  }

  public getEvicted(): number {
    return this.evicted;
  }

  public getSubscriberErrors(): { count: number; last: string | null } {
    return { count: this.subscriberErrors, last: this.lastSubscriberError };
  }

  /**
   * Deliver to one channel's subscribers, isolating each from the others.
   *
   * A plain `this.emit(type, …)` would propagate the first listener's throw,
   * so the subsequent `emit('*', …)` never ran — one bad consumer silently cut
   * the feed to every other consumer, including the SSE stream. Worse, the
   * throw surfaced on whatever stack emitted, which for the receipt tee is live
   * order execution.
   *
   * `rawListeners()` returns a copy, so a handler that unsubscribes mid-fan-out
   * cannot shift the array underneath the loop, and Node's `once` wrapper
   * self-removes when invoked directly, so `once()` semantics survive.
   *
   * Subscriber faults are counted and reported rather than silently eaten — a
   * swallowed exception with no trace is how a dead consumer stays invisible.
   * Reporting is throttled because emission runs at scan-loop rate.
   */
  private fanOut(channel: EventType | '*', event: BaseTelemetryEvent): void {
    for (const listener of this.rawListeners(channel)) {
      try {
        (listener as (e: BaseTelemetryEvent) => void)(event);
      } catch (err) {
        this.subscriberErrors += 1;
        this.lastSubscriberError = `${channel}: ${(err as Error)?.message || String(err)}`;
        if (this.subscriberErrors === 1 || this.subscriberErrors % 100 === 0) {
          console.error(
            `[telemetry] subscriber threw on '${channel}' (${this.subscriberErrors} total):`,
            (err as Error)?.message || err,
          );
        }
      }
    }
  }

  public emitEvent<T extends EventType>(
    type: T,
    data: TelemetryEventPayloads[T],
  ): BaseTelemetryEvent<T> {
    this.seq += 1;
    const event: BaseTelemetryEvent<T> = {
      id: `evt-${Date.now()}-${this.seq}`,
      type,
      v: TELEMETRY_SCHEMA_VERSION,
      ts: Date.now(),
      data: data || ({} as TelemetryEventPayloads[T]),
    };

    this.buffer.push(event as BaseTelemetryEvent);
    if (this.buffer.length > this.maxCap) {
      this.buffer.shift(); // Evict oldest
      this.evicted += 1;
    }

    this.fanOut(type, event);
    this.fanOut('*', event);
    return event;
  }

  private applyFilters(
    source: BaseTelemetryEvent[],
    filter: EventQueryFilter,
  ): BaseTelemetryEvent[] {
    const { type, symbol, slug, since, level } = filter;
    const types = type ? (Array.isArray(type) ? type : [type]) : null;

    let res = source;

    if (types && types.length > 0) {
      res = res.filter((e) => types.includes(e.type));
    }
    if (since != null) {
      res = res.filter((e) => e.ts >= since);
    }
    if (symbol != null) {
      const symUpper = symbol.toUpperCase();
      res = res.filter((e) => {
        const d = e.data as Record<string, any>;
        return typeof d?.symbol === 'string' && d.symbol.toUpperCase() === symUpper;
      });
    }
    if (slug != null) {
      res = res.filter((e) => (e.data as Record<string, any>)?.slug === slug);
    }
    if (level != null) {
      res = res.filter((e) => (e.data as Record<string, any>)?.level === level);
    }
    return res;
  }

  public queryEvents(filter: EventQueryFilter = {}): BaseTelemetryEvent[] {
    const { limit = 100 } = filter;
    const res = this.applyFilters(this.buffer, filter);

    // Tail slice: no cursor means "the most recent N".
    if (limit > 0 && res.length > limit) {
      return res.slice(-limit);
    }
    return [...res];
  }

  /**
   * Cursor-addressed read. Unlike `queryEvents`, the limit takes from the
   * FRONT — events strictly after the cursor, oldest first. A tail slice here
   * would silently skip the middle of the backlog, which is precisely the
   * failure a catch-up read exists to avoid.
   */
  public queryPage(filter: EventQueryFilter = {}): EventPage {
    const { after, limit = 100 } = filter;
    const oldestId = this.buffer.length ? this.buffer[0].id : null;
    const newestId = this.buffer.length ? this.buffer[this.buffer.length - 1].id : null;

    let startIdx = 0;
    let dropped = false;

    if (after) {
      const idx = this.buffer.findIndex((e) => e.id === after);
      if (idx >= 0) {
        startIdx = idx + 1;
      } else {
        // Not found: evicted, from a previous process, or malformed. Report the
        // gap and hand back everything retained so the caller can resync —
        // returning an empty page here would read as "you are up to date".
        dropped = true;
      }
    }

    const matched = this.applyFilters(this.buffer.slice(startIdx), filter);
    const events = limit > 0 && matched.length > limit ? matched.slice(0, limit) : [...matched];

    return {
      events,
      oldestId,
      newestId,
      dropped,
      evicted: this.evicted,
      hasMore: matched.length > events.length,
    };
  }

  public getLatest(type?: EventType): BaseTelemetryEvent | null {
    if (!type) {
      return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
    }
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].type === type) {
        return this.buffer[i];
      }
    }
    return null;
  }

  public size(): number {
    return this.buffer.length;
  }

  public clear(): void {
    this.buffer = [];
    this.seq = 0;
    this.evicted = 0;
  }
}

export const telemetryBus = new TelemetryBus();

export function emitEvent<T extends EventType>(
  type: T,
  data: TelemetryEventPayloads[T],
): BaseTelemetryEvent<T> {
  return telemetryBus.emitEvent(type, data);
}

export function queryEvents(filter?: EventQueryFilter): BaseTelemetryEvent[] {
  return telemetryBus.queryEvents(filter);
}

/** Cursor-addressed read with an explicit gap signal. See `EventPage`. */
export function queryEventsPage(filter?: EventQueryFilter): EventPage {
  return telemetryBus.queryPage(filter);
}

/** Events dropped off the back of the buffer since process start. */
export function evictedCount(): number {
  return telemetryBus.getEvicted();
}

/** Subscriber faults absorbed by the fan-out, so they are not invisible. */
export function subscriberErrors(): { count: number; last: string | null } {
  return telemetryBus.getSubscriberErrors();
}

export function setEventBufferCapacity(cap: number): void {
  telemetryBus.setCapacity(cap);
}

export function getLatestEvent(type?: EventType): BaseTelemetryEvent | null {
  return telemetryBus.getLatest(type);
}

export function clearEvents(): void {
  telemetryBus.clear();
}

export function onEvent(
  type: EventType | '*',
  handler: (event: BaseTelemetryEvent) => void,
): () => void {
  telemetryBus.on(type, handler);
  return () => telemetryBus.off(type, handler);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Format a typed event into a human-readable log string (D8 rendering layer).
 *
 * Per rule (ii) this output is NOT stored on the event — it is derived on
 * demand, and it serves Zinger's own dashboard as one client's projection. It
 * does not define the record, and other clients are expected to render these
 * payloads differently.
 */
export function formatEventAsLog(event: BaseTelemetryEvent): { text: string; level: string } {
  if (!event || !event.type) return { text: '', level: 'info' };
  const d = (event.data || {}) as Record<string, any>;

  switch (event.type) {
    case 'scan.cycle': {
      const buyCount = d.buyCount || 0;
      const mkts = d.marketCount || d.markets?.length || 0;
      const rem = d.remainingFormatted || '';
      return {
        text: `🔎 Scan #${d.scanNumber || d.scan || 0} — ${mkts} mkts · ${buyCount} buy signals · cycle ${rem}`,
        level: 'scan',
      };
    }
    case 'trade.decision': {
      const sym = d.symbol || 'UNK';
      const outcome = String(d.outcome || '').toUpperCase();
      const action = String(d.output?.action || d.action || 'HOLD').toUpperCase();
      const conf = d.confidence != null ? `${(d.confidence * 100).toFixed(0)}%` : '';
      // Rule (iii): reasons are codes now, so the line is assembled here.
      const reasons: DecisionReason[] = d.scoring?.reasons || [];
      const why = reasons.length
        ? reasons.map((r) => r.code).join(', ')
        : (d.output?.skipReason?.code || d.reason || d.summary || '');
      return {
        text: `🎯 DECISION [${d.engine || 'dir'}] ${sym} ${outcome} -> ${action} ${conf} · ${why}`,
        level: action === 'BUY' ? 'signal' : 'info',
      };
    }
    case 'trade.execution': {
      const mode = String(d.mode || 'paper').toUpperCase();
      const sym = d.symbol || '';
      const outcome = String(d.outcome || '').toUpperCase();
      const size = d.size != null ? `$${Number(d.size).toFixed(2)}` : '';
      const price = d.price != null ? `@ $${Number(d.price).toFixed(3)}` : '';
      return {
        text: `🚀 ${mode} EXECUTE ${sym} ${outcome} ${size} ${price} · ${d.slug || ''}`,
        level: 'trade',
      };
    }
    case 'trade.execution.receipt': {
      const shape = d.phase === 'throw'
        ? `threw ${d.error?.name || ''} ${String(d.error?.message || '').slice(0, 60)}`.trim()
        : `keys [${(d.rawKeys || []).join(',')}]`;
      return {
        text: `📼 RECEIPT ${d.fn || '?'} · ${d.phase || '?'} · ${shape}`,
        level: d.phase === 'throw' ? 'error' : 'system',
      };
    }
    case 'position.exit': {
      const reason = String(d.exitReason || 'close').toUpperCase();
      const sym = d.symbol || '';
      const outcome = String(d.outcome || '').toUpperCase();
      const pnlVal = Number(d.netPnl ?? d.pnl ?? 0);
      const pnlTxt = `${pnlVal >= 0 ? '+' : ''}$${pnlVal.toFixed(2)}`;
      return {
        text: `🏁 EXIT [${reason}] ${sym} ${outcome} · PnL ${pnlTxt} · ${d.slug || ''}`,
        level: pnlVal >= 0 ? 'tp' : 'sl',
      };
    }
    case 'package.settlement': {
      const pnlVal = Number(d.netPnl ?? d.grossPnl ?? d.lockedProfitUsd ?? 0);
      const pnlTxt = `${pnlVal >= 0 ? '+' : ''}$${pnlVal.toFixed(2)}`;
      return {
        text: `📦 ARB SETTLED [${d.packageId || ''}] · ${d.mode || 'paper'} · Net PnL ${pnlTxt}`,
        level: 'arb',
      };
    }
    case 'arb.decision': {
      const act = String(d.output?.action || 'skip').toUpperCase();
      // Both gaps in cents — mixing cents and raw probability here reads as a
      // 100x discrepancy that isn't there.
      const cents = (v: unknown) => (v != null ? `${(Number(v) * 100).toFixed(2)}c` : '?');
      const sum = d.asksSum != null ? `$${Number(d.asksSum).toFixed(3)}` : '?';
      const why = d.output?.skipReason?.code || '';
      return {
        text: `⚖️ ARB ${act} ${d.symbol || ''} · sum ${sum} · gap ${cents(d.arbGap)} (min ${cents(d.minArbGap)}) ${why}`,
        level: act === 'OPEN' ? 'arb' : 'info',
      };
    }
    case 'account.cash': {
      const clob = d.clob != null ? `$${Number(d.clob).toFixed(2)}` : '?';
      const mism = d.mismatchCount ?? (d.mismatches?.length || 0);
      return {
        text: `💵 CASH ${d.mode || ''} · clob ${clob} · pm realized $${Number(d.pmRealizedSum ?? 0).toFixed(2)} · ${mism} mismatch${mism === 1 ? '' : 'es'}`,
        level: mism > 0 ? 'warn' : 'system',
      };
    }
    case 'account.reset': {
      return {
        text: `♻️ RESET ${d.mode || ''} · ${d.clearedTrades ?? 0} trades · ${d.clearedPositions ?? 0} positions · ${d.clearedPackages ?? 0} packages · baseline $${Number(d.baselineUsd ?? 0).toFixed(2)}`,
        level: 'system',
      };
    }
    case 'data.assurance': {
      return {
        text: `🛡️ DATA GATE · ${d.note || (d.canBuy ? 'PASS' : 'BLOCK')} (score ${d.score || 0})`,
        level: d.canBuy ? 'scan' : 'error',
      };
    }
    case 'system.alert': {
      const lvl = d.level || 'info';
      const icon = lvl === 'error' ? '⚠️' : lvl === 'warn' ? '🧭' : 'ℹ️';
      const kind = d.kind ? `[${d.kind}] ` : '';
      return {
        text: `${icon} ${kind}${d.message || ''}`,
        level: lvl,
      };
    }
    case 'config.attributed': {
      return {
        text: `🔧 CONFIG ${d.key || ''} ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)} · ${d.tier || ''}/${d.source || ''}`,
        level: 'system',
      };
    }
    default:
      return {
        text: `[${event.type}] ${JSON.stringify(d)}`,
        level: 'info',
      };
  }
}
