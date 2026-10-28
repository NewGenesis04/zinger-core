/**
 * Read model for the Command Center's MM page: runs under tmp/mm-live, their live status,
 * journal tail, loss ledger and day stops. Filesystem only; it never builds a venue or
 * loads a wallet. The one write is requestKill, which creates the run's kill file: the
 * runner then cancels everything and stops, the same as Ctrl-C.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const read = (p: string) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const alive = (pid: unknown) => { try { return typeof pid === 'number' && pid > 0 && (process.kill(pid, 0), true); } catch (e: any) { return e?.code === 'EPERM'; } };
/** A status older than this, from a runner that is still up, is reported as stale. */
export const STALE_MS = 15_000;

export interface MmRunRow {
  id: string; mode: string; sides: string | null; budget: string | null; startedAt: number | null; endedAt: number | null;
  state: 'running' | 'stale' | 'halted' | 'finished' | 'unknown'; halted: string | null; equityUsd: number | null; fills: number | null; estRewardUsdPerDay: number | null;
}

function runState(status: any, summary: any, now: number): MmRunRow['state'] {
  if (status?.running) {
    if (!alive(status.pid)) return 'halted';
    return now - status.at > STALE_MS ? 'stale' : 'running';
  }
  const h = status?.halted ?? summary?.halted;
  if (h && h !== 'run_complete') return 'halted';
  return status || summary ? 'finished' : 'unknown';
}

export function listMmRuns(root = 'tmp/mm-live', now = Date.now()): MmRunRow[] {
  if (!existsSync(root)) return [];
  const rows: MmRunRow[] = [];
  for (const id of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const dir = join(root, id), config = read(join(dir, 'config.json'));
    if (!config) continue;
    const status = read(join(dir, 'status.json')), summary = read(join(dir, 'summary.json'));
    rows.push({ id, mode: config.mode ?? 'unknown', sides: config.sides ?? null, budget: status?.budget ?? summary?.budget ?? null,
      startedAt: status?.startedAt ?? null, endedAt: status?.endedAt ?? null, state: runState(status, summary, now), halted: status?.halted ?? summary?.halted ?? null,
      equityUsd: status?.equityUsd ?? summary?.equityUsd ?? null, fills: status?.fills ?? summary?.evaluation?.fills ?? null,
      estRewardUsdPerDay: status?.estRewardUsdPerDay ?? summary?.evaluation?.estRewardUsdPerDay ?? null });
  }
  const order = { running: 0, stale: 1, halted: 2, finished: 3, unknown: 4 };
  return rows.sort((a, b) => order[a.state] - order[b.state] || (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.id.localeCompare(a.id));
}

/** Last `n` journal rows, read from the end of the file so a long run stays cheap. */
export function journalTail(path: string, n = 150, maxBytes = 512 * 1024) {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size, len = Math.min(size, maxBytes), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (len < size) lines.shift(); // first line may be cut
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } finally { closeSync(fd); }
}

/** Journal row types worth showing an operator; the rest (position bookkeeping, skips) is summarised. */
const EVENT_TYPES = new Set(['submit', 'ack', 'reject', 'ack_unknown', 'fill', 'fill_before_ack', 'cancel', 'cancel_error', 'closed', 'adopt', 'market_stop', 'halt', 'cancel_all', 'orphans', 'drift', 'heartbeat_miss', 'book_error', 'order_unconfirmed', 'restored', 'shutdown_error']);

export function readMmRun(id: string, root = 'tmp/mm-live', now = Date.now()) {
  if (!/^[\w.-]+$/.test(id)) return null;
  const dir = join(root, id), config = read(join(dir, 'config.json'));
  if (!config) return null;
  const status = read(join(dir, 'status.json')), summary = read(join(dir, 'summary.json'));
  // Skip rows can dominate a busy journal, so read a deep tail before filtering to operator events.
  const tail = journalTail(join(dir, 'journal.jsonl'), 5000, 2 * 1024 * 1024);
  const skips: Record<string, number> = {};
  for (const r of tail) if (r.type === 'skip') skips[r.reason] = (skips[r.reason] ?? 0) + 1;
  const mode = config.mode ?? 'dry-run';
  return {
    id, state: runState(status, summary, now), config: { mode, sides: config.sides ?? null, limits: config.limits, limitsHash: config.limitsHash, offsetTicks: config.offsetTicks,
      markets: (config.markets ?? []).map((m: any) => ({ conditionId: m.conditionId, question: m.question, rewardMinSize: m.rewardMinSize, dailyPool: m.dailyPool })) },
    status, summary, events: tail.filter((r) => EVENT_TYPES.has(r.type)).slice(-120).reverse(), recentSkips: skips,
    lossLedger: read(join(root, `loss-ledger-${mode}.json`)), dayStops: read(join(root, `market-stops-${mode}.json`)),
  };
}

/** Create the kill file of a running run. Only a path inside the repo's tmp directory is accepted. */
export function requestKill(id: string, root = 'tmp/mm-live', tmpRoot = 'tmp') {
  const run = readMmRun(id, root);
  if (!run?.status) return { ok: false as const, error: 'run has no live status' };
  if (!['running', 'stale'].includes(run.state)) return { ok: false as const, error: `run is ${run.state}` };
  const file = String(run.status.killFile ?? '');
  const rel = relative(resolve(tmpRoot), resolve(file));
  if (!file || rel.startsWith('..') || resolve(file) === resolve(tmpRoot)) return { ok: false as const, error: 'kill file outside tmp/' };
  writeFileSync(file, JSON.stringify({ requestedAt: new Date().toISOString(), by: 'command-center', run: id }));
  return { ok: true as const, killFile: file };
}

/** The default kill file is shared by every run; it stays until an operator removes it. */
export function killFileState(file = 'tmp/mm-live.KILL') {
  return { path: file, present: existsSync(file), content: existsSync(file) ? readFileSync(file, 'utf8').slice(0, 500) : null };
}

/** Remove the kill file, only while no run is up: a present kill file also blocks the next start. */
export function clearKill(root = 'tmp/mm-live', file = 'tmp/mm-live.KILL') {
  const up = listMmRuns(root).filter((r) => r.state === 'running' || r.state === 'stale');
  if (up.length) return { ok: false as const, error: `run ${up[0].id} is still ${up[0].state}` };
  if (!existsSync(file)) return { ok: true as const, removed: false };
  unlinkSync(file);
  return { ok: true as const, removed: true };
}
