/**
 * Raw CLOB response capture.
 *
 * Three open items all reduce to one missing observation — nobody has ever
 * recorded what Polymarket actually sends back when an order is placed:
 *
 *   backlog 33  are `makingAmount`/`takingAmount` raw units or 1e6-scaled?
 *               Both are typed bare `string` in the SDK with no documented
 *               scale. `verifyFilledShares` resolves it against an
 *               independently derived share count precisely because we do not
 *               know, which is safe but is still an inference.
 *   open q. 7   does a slippage-rejected order come back `success:false`, or
 *               with an orderID and a killed status? This matters because
 *               `assertOrderAccepted` passes on orderID presence alone, so the
 *               second shape would report a dead order as a fill.
 *   backlog 34  distinguishing "the sell was rejected" from "the sell landed
 *               and the response was lost" needs to know what each looks like.
 *
 * So this captures the response **whole and unmodified**. No field whitelist —
 * a whitelist can only preserve fields we already thought of, and the entire
 * point is that we do not know what is there. `liveAccount.traceLiveFill` has
 * such a whitelist, which is why this does not route through it (it also
 * imports `trade.js`, so the dependency would be circular).
 *
 * Captures both outcomes. The rejection shape is the more valuable of the two
 * and is the one a success-only capture would miss.
 *
 * Imports nothing but `fs` and `dataDir` — safe to pull into the order path
 * from any layer without a cycle.
 */
import fs from 'fs';
import { dataPath } from './dataDir.js';

/** Append-only JSONL: one self-contained record per line, no read-modify-write. */
const RECEIPT_LOG = dataPath('clob_receipts.jsonl');
const ROTATE_BYTES = 4 * 1024 * 1024;

/** Escape hatch, but on by default — an off-by-default capture records nothing. */
const ENABLED = process.env.ZINGER_CAPTURE_RECEIPTS !== '0';
/** Echo to stdout so a VPS run is greppable in journalctl without pulling files. */
const ECHO = process.env.ZINGER_RECEIPT_ECHO !== '0';

export interface ClobReceipt {
  at: string;
  fn: string;
  phase: 'response' | 'throw';
  /** What we asked for — needed to interpret what came back. */
  request: Record<string, unknown>;
  /** The response object exactly as received. The whole point of this file. */
  raw?: unknown;
  /** Top-level key names, so the shape is scannable without parsing `raw`. */
  rawKeys?: string[];
  rawType?: string;
  /** Our own reading of `raw`, recorded so the two can be compared later. */
  derived?: Record<string, unknown>;
  error?: { message: string; name?: string; code?: unknown; status?: unknown; body?: unknown };
}

/**
 * BigInt- and cycle-tolerant. A plain `JSON.stringify` throws on the BigInts
 * viem returns, and throwing here would take the order down with it.
 *
 * Note: a value referenced twice but not circular is also reported as
 * `[circular]`. Acceptable for a diagnostic record; worth knowing when reading.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return `${val.toString()}n`;
    if (typeof val === 'function') return '[function]';
    if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[circular]';
      seen.add(val);
    }
    return val;
  });
}

function describe(raw: unknown): { rawKeys?: string[]; rawType: string } {
  const rawType = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { rawKeys: Object.keys(raw as Record<string, unknown>), rawType };
  }
  return { rawType };
}

/**
 * Record one CLOB interaction. Never throws — a capture failure must not be
 * able to fail a live order.
 */
export function captureReceipt(entry: Omit<ClobReceipt, 'at'>): void {
  if (!ENABLED) return;
  try {
    const record: ClobReceipt = {
      at: new Date().toISOString(),
      ...entry,
      ...('raw' in entry ? describe(entry.raw) : { rawType: 'absent' }),
    };
    const line = safeStringify(record);
    if (typeof line !== 'string') return;

    try {
      if (fs.statSync(RECEIPT_LOG).size > ROTATE_BYTES) {
        fs.renameSync(RECEIPT_LOG, `${RECEIPT_LOG}.1`);
      }
    } catch { /* no log yet, or rotate raced — appending is still correct */ }

    fs.appendFileSync(RECEIPT_LOG, `${line}\n`);
    if (ECHO) console.log(`📼 CLOB RECEIPT ${line}`);
  } catch {
    // Deliberately silent. This path runs inside live order execution; a
    // diagnostic that can break a trade is worse than a missing diagnostic.
  }
}

/**
 * Wrap a CLOB call so both outcomes are captured, then pass the result or the
 * throw through untouched. Callers behave exactly as they did without it.
 */
export async function captureClobCall<T>(
  fn: string,
  request: Record<string, unknown>,
  call: () => Promise<T>,
): Promise<T> {
  try {
    const raw = await call();
    captureReceipt({ fn, phase: 'response', request, raw });
    return raw;
  } catch (err: any) {
    captureReceipt({
      fn,
      phase: 'throw',
      request,
      error: {
        message: String(err?.message ?? err),
        name: err?.name,
        code: err?.code,
        // Axios-shaped HTTP errors carry the exchange's actual reason here,
        // which is the answer to open question 7 when a rejection throws.
        status: err?.status ?? err?.response?.status,
        body: err?.response?.data ?? err?.body ?? null,
      },
    });
    throw err;
  }
}

export function receiptLogPath(): string {
  return RECEIPT_LOG;
}

/** Most recent captures, newest last. For an operator reading back a live run. */
export function readReceipts(limit = 50): ClobReceipt[] {
  try {
    const lines = fs.readFileSync(RECEIPT_LOG, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).flatMap((l) => {
      try { return [JSON.parse(l) as ClobReceipt]; } catch { return []; }
    });
  } catch {
    return [];
  }
}
