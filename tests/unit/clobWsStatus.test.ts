// @ts-nocheck
/**
 * INVARIANT: every outage of the book feed is reported once when it begins and
 * once when it ends, with its cause and its length (item 111).
 *
 * Disconnects and errors used to close and reconnect without a word, so a
 * socket drop that pushed book reads onto the metered REST proxy left no
 * trace, which may be how item 112's slowdown went unexplained. A reconnect
 * loop retries every 2.5s, so the report is per outage, not per attempt.
 */
import { describe, it, expect } from 'vitest';
import { wsTransition } from '../../src/polymarket/clobWs.js';

/** Runs events through the transition, collecting reports. */
function run(events, start = 1_000_000) {
  let state = {};
  const reports = [];
  for (const [dt, ev] of events) {
    const out = wsTransition(state, ev, start + dt);
    state = out.state;
    if (out.report) reports.push(out.report);
  }
  return { state, reports };
}

describe('INVARIANT: one report per outage, whatever the retry count', () => {
  it('reports a drop once, then the recovery with downtime and attempts', () => {
    const { reports } = run([
      [0, { type: 'error', message: 'ECONNRESET' }],
      [0, { type: 'close', code: 1006, lastMsgAt: 1_000_000 - 4_000 }],
      [2_500, { type: 'error', message: 'ECONNREFUSED' }],
      [2_500, { type: 'close', code: 1006 }],
      [5_000, { type: 'close', code: 1006 }],
      [7_600, { type: 'open' }],
    ]);
    expect(reports).toEqual([
      { kind: 'down', cause: 'error: ECONNRESET', code: 1006, sinceLastMsgMs: 4_000 },
      { kind: 'up', downMs: 7_600, attempts: 3 },
    ]);
  });

  it('names a silent feed as the cause of the close it triggers', () => {
    const { reports } = run([
      [0, { type: 'stale', silentMs: 125_000 }],
      [0, { type: 'close', code: 1005 }],
      [3_000, { type: 'open' }],
    ]);
    expect(reports[0]).toMatchObject({ kind: 'down', cause: 'feed silent 125s while connected' });
    expect(reports[1]).toMatchObject({ kind: 'up', downMs: 3_000, attempts: 1 });
  });

  it('describes a plain close by its code and reason', () => {
    const { reports } = run([[0, { type: 'close', code: 1001, reason: 'going away' }]]);
    expect(reports[0].cause).toBe('closed (code 1001, going away)');
  });

  it('reports nothing for a first connection, and nothing while healthy', () => {
    expect(run([[0, { type: 'open' }]]).reports).toEqual([]);
    expect(run([[0, { type: 'open' }], [10, { type: 'open' }]]).reports).toEqual([]);
  });

  it('reports every separate outage', () => {
    const { reports } = run([
      [0, { type: 'close', code: 1006 }], [2_500, { type: 'open' }],
      [60_000, { type: 'close', code: 1006 }], [65_000, { type: 'open' }],
    ]);
    expect(reports.map((r) => r.kind)).toEqual(['down', 'up', 'down', 'up']);
  });
});

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

function checkHandlers(src) {
  for (const [name, pattern] of [
    ['open', /ws\.on\('open'[\s\S]*?noteWs\(\{ type: 'open' \}\)/],
    // The window is generous because the handler also marks the book cache
    // invalid on the way through (item 118); what is pinned is that a close
    // still reports, not where the line sits.
    ['close', /ws\.on\('close', \(code, reason\) => \{[\s\S]{0,600}?noteWs\(\{ type: 'close'/],
    ['error', /ws\.on\('error', \(err\) => \{\s*noteWs\(\{ type: 'error'/],
    ['stale', /isStreamStale\([\s\S]*?noteWs\(\{ type: 'stale'/],
  ]) {
    if (!pattern.test(src)) throw new Error(`the ${name} handler does not report`);
  }
}

describe('INVARIANT: every socket event reaches the status reporter', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/polymarket/clobWs.ts', import.meta.url)), 'utf8');
  it('holds for the real source', () => expect(() => checkHandlers(src)).not.toThrow());
  it('fails when a handler stops reporting', () => {
    const broken = src.replace("noteWs({ type: 'error', message: err?.message });", '');
    expect(broken).not.toBe(src);
    expect(() => checkHandlers(broken)).toThrow(/error handler/);
  });
});
