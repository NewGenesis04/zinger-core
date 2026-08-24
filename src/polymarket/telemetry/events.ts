// @ts-nocheck
import { EventEmitter } from 'node:events';

export const TELEMETRY_SCHEMA_VERSION = 1;
export const DEFAULT_EVENT_BUFFER_CAP = 5000;

export type EventType =
  | 'scan.cycle'
  | 'trade.decision'
  | 'trade.execution'
  | 'position.exit'
  | 'package.settlement'
  | 'data.assurance'
  | 'system.alert'
  | 'config.attributed';

export interface BaseTelemetryEvent {
  id: string;
  type: EventType;
  v: number;
  ts: number;
  data: Record<string, any>;
}

class TelemetryBus extends EventEmitter {
  private buffer: BaseTelemetryEvent[] = [];
  private maxCap: number = DEFAULT_EVENT_BUFFER_CAP;
  private seq: number = 0;

  constructor(maxCap: number = DEFAULT_EVENT_BUFFER_CAP) {
    super();
    this.maxCap = maxCap;
  }

  public setCapacity(newCap: number): void {
    this.maxCap = Math.max(100, newCap);
    if (this.buffer.length > this.maxCap) {
      this.buffer = this.buffer.slice(-this.maxCap);
    }
  }

  public emitEvent<T = Record<string, any>>(type: EventType, data: T): BaseTelemetryEvent {
    this.seq += 1;
    const event: BaseTelemetryEvent = {
      id: `evt-${Date.now()}-${this.seq}`,
      type,
      v: TELEMETRY_SCHEMA_VERSION,
      ts: Date.now(),
      data: data || {},
    };

    this.buffer.push(event);
    if (this.buffer.length > this.maxCap) {
      this.buffer.shift(); // Evict oldest
    }

    this.emit(type, event);
    this.emit('*', event);
    return event;
  }

  public queryEvents(filter: {
    type?: EventType | EventType[];
    symbol?: string;
    slug?: string;
    since?: number;
    limit?: number;
    level?: string;
  } = {}): BaseTelemetryEvent[] {
    const { type, symbol, slug, since, limit = 100, level } = filter;
    const types = type ? (Array.isArray(type) ? type : [type]) : null;

    let res = this.buffer;

    if (types && types.length > 0) {
      res = res.filter((e) => types.includes(e.type));
    }
    if (since != null) {
      res = res.filter((e) => e.ts >= since);
    }
    if (symbol != null) {
      const symUpper = symbol.toUpperCase();
      res = res.filter((e) => e.data?.symbol?.toUpperCase() === symUpper);
    }
    if (slug != null) {
      res = res.filter((e) => e.data?.slug === slug);
    }
    if (level != null) {
      res = res.filter((e) => e.data?.level === level);
    }

    if (limit > 0 && res.length > limit) {
      return res.slice(-limit);
    }
    return [...res];
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
  }
}

export const telemetryBus = new TelemetryBus();

export function emitEvent<T = Record<string, any>>(type: EventType, data: T): BaseTelemetryEvent {
  return telemetryBus.emitEvent(type, data);
}

export function queryEvents(filter?: Parameters<TelemetryBus['queryEvents']>[0]): BaseTelemetryEvent[] {
  return telemetryBus.queryEvents(filter);
}

export function getLatestEvent(type?: EventType): BaseTelemetryEvent | null {
  return telemetryBus.getLatest(type);
}

export function clearEvents(): void {
  telemetryBus.clear();
}

export function onEvent(type: EventType | '*', handler: (event: BaseTelemetryEvent) => void): () => void {
  telemetryBus.on(type, handler);
  return () => telemetryBus.off(type, handler);
}

/**
 * Format a typed event into a clean human-readable log string (D8 rendering layer).
 * The string is derived from the event, ensuring data lives in the payload.
 */
export function formatEventAsLog(event: BaseTelemetryEvent): { text: string; level: string } {
  if (!event || !event.type) return { text: '', level: 'info' };
  const d = event.data || {};

  switch (event.type) {
    case 'scan.cycle': {
      const buyCount = d.buyCount || 0;
      const mkts = d.marketCount || d.markets?.length || 0;
      const rem = d.remainingFormatted || '';
      return {
        text: `🔎 Scan #${d.scanNumber || 0} — ${mkts} mkts · ${buyCount} buy signals · cycle ${rem}`,
        level: 'scan',
      };
    }
    case 'trade.decision': {
      const sym = d.symbol || 'UNK';
      const outcome = String(d.outcome || '').toUpperCase();
      const action = String(d.action || 'HOLD').toUpperCase();
      const conf = d.confidence != null ? `${(d.confidence * 100).toFixed(0)}%` : '';
      const reason = d.reason || d.summary || '';
      return {
        text: `🎯 DECISION [${d.engine || 'dir'}] ${sym} ${outcome} -> ${action} ${conf} · ${reason}`,
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
      const pnlVal = Number(d.netPnl ?? d.grossPnl ?? 0);
      const pnlTxt = `${pnlVal >= 0 ? '+' : ''}$${pnlVal.toFixed(2)}`;
      return {
        text: `📦 ARB SETTLED [${d.packageId || ''}] · ${d.mode || 'paper'} · Net PnL ${pnlTxt}`,
        level: 'arb',
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
      return {
        text: `${icon} ${d.message || ''}`,
        level: lvl,
      };
    }
    default:
      return {
        text: `[${event.type}] ${JSON.stringify(d)}`,
        level: 'info',
      };
  }
}
