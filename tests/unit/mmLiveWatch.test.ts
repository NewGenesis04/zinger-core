import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearKill, journalTail, killFileState, listMmRuns, readMmRun, requestKill } from '../../src/research/mm/live/watch.js';

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'mm-watch-'));
  const root = join(tmp, 'mm-live');
  const run = (id: string, status: Record<string, unknown> | null, summary: Record<string, unknown> | null = null, rows: object[] = []) => {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, 'config.json'), JSON.stringify({ mode: 'dry-run', sides: 'both', limitsHash: 'abc', limits: {}, markets: [{ conditionId: 'C', question: 'Q?' }] }));
    if (status) writeFileSync(join(root, id, 'status.json'), JSON.stringify(status));
    if (summary) writeFileSync(join(root, id, 'summary.json'), JSON.stringify(summary));
    for (const r of rows) appendFileSync(join(root, id, 'journal.jsonl'), JSON.stringify(r) + '\n');
  };
  return { tmp, root, run, kill: join(tmp, 'mm-live.KILL') };
}

describe('MM watch read model', () => {
  it('orders runs live first and tells running, stale, halted and finished apart', () => {
    const { root, run } = fixture();
    const now = 1_000_000;
    run('a-finished', { running: false, halted: 'run_complete', startedAt: 1, at: 2 });
    run('b-running', { running: true, pid: process.pid, startedAt: 5, at: now - 1000 });
    run('c-stale', { running: true, pid: process.pid, startedAt: 4, at: now - 60_000 });
    run('d-dead', { running: true, pid: 2 ** 22 + 12345, startedAt: 3, at: now });
    run('e-old', null, { halted: 'run_complete', equityUsd: 0 });
    const rows = listMmRuns(root, now);
    expect(rows.map((r) => [r.id, r.state])).toEqual([['b-running', 'running'], ['c-stale', 'stale'], ['d-dead', 'halted'], ['a-finished', 'finished'], ['e-old', 'finished']]);
  });

  it('returns the journal tail and keeps only operator events, newest first', () => {
    const { root, run } = fixture();
    const rows = [{ at: 1, type: 'submit', side: 'BUY' }, { at: 2, type: 'position', delta: 1 }, { at: 3, type: 'skip', reason: 'portfolio_usd_limit' }, { at: 4, type: 'market_stop', conditionId: 'C', lossUsd: 5.2 }];
    run('r', { running: false, at: 5 }, null, rows);
    const r = readMmRun('r', root)!;
    expect(r.events.map((e: any) => e.type)).toEqual(['market_stop', 'submit']);
    expect(r.recentSkips).toEqual({ portfolio_usd_limit: 1 });
    expect(journalTail(join(root, 'r', 'journal.jsonl'), 2).map((e: any) => e.at)).toEqual([3, 4]);
    expect(readMmRun('../etc', root)).toBeNull();
  });

  it('kills only a live run, only through a kill file under tmp/, and clears it once nothing runs', () => {
    const { tmp, root, run, kill } = fixture();
    run('live', { running: true, pid: process.pid, at: Date.now(), killFile: kill });
    run('done', { running: false, at: 1, killFile: kill });
    run('escape', { running: true, pid: process.pid, at: Date.now(), killFile: '/etc/mm.KILL' });
    expect(requestKill('done', root, tmp)).toMatchObject({ ok: false });
    expect(requestKill('escape', root, tmp)).toEqual({ ok: false, error: 'kill file outside tmp/' });
    expect(requestKill('live', root, tmp)).toEqual({ ok: true, killFile: kill });
    expect(killFileState(kill).present).toBe(true);
    expect(clearKill(root, kill)).toMatchObject({ ok: false });
    writeFileSync(join(root, 'live', 'status.json'), JSON.stringify({ running: false, halted: 'kill:kill_file', at: 2 }));
    writeFileSync(join(root, 'escape', 'status.json'), JSON.stringify({ running: false, at: 2 }));
    expect(clearKill(root, kill)).toEqual({ ok: true, removed: true });
    expect(existsSync(kill)).toBe(false);
  });
});
