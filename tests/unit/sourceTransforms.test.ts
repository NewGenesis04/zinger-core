// @ts-nocheck
/**
 * INVARIANT: every source file the runtime will load actually parses.
 *
 * This exists because of a live boot failure on 2026-09-15:
 *
 *   Error: Transform failed with 2 errors:
 *     src/polymarket/bot.ts:3295:43: ERROR: Cannot use "continue" here
 *     src/polymarket/bot.ts:3378:41: ERROR: Cannot use "continue" here
 *
 * Both `npx tsc --noEmit` and the full vitest suite passed on that code. Two
 * independent reasons, and together they left the largest and most
 * safety-critical file in the repo with no syntax check at all:
 *
 *   1. `bot.ts` opens with `// @ts-nocheck`, so tsc skips the file entirely.
 *   2. No test IMPORTS `bot.ts`. The tests that mention it read it as TEXT
 *      (`repoFile(...)`) to assert on source patterns, so esbuild never
 *      transforms it and the parse error never surfaces.
 *
 * A green suite therefore said nothing whatsoever about whether the bot could
 * start. This test closes that by running the same transform the runtime uses
 * (`tsx` → esbuild) over every file, so a parse error fails here instead of at
 * boot on the VPS.
 *
 * It deliberately checks PARSING only. Type errors are tsc's job, and files
 * carrying `@ts-nocheck` have opted out of that on purpose — but nothing opts
 * out of having to parse.
 */
import { describe, it, expect } from 'vitest';
import { transformSync } from 'esbuild';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (['.ts', '.tsx'].includes(extname(entry))) out.push(full);
  }
  return out;
}

const files = [...collect(join(ROOT, 'src')), join(ROOT, 'index.ts')];

describe('INVARIANT: the runtime can parse every file it will load', () => {
  it('finds the source tree', () => {
    // Guard against the sweep silently covering nothing — an empty list would
    // make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(30);
  });

  it('transforms every source file the way tsx does', () => {
    const failures = [];
    for (const file of files) {
      try {
        transformSync(readFileSync(file, 'utf8'), {
          loader: extname(file) === '.tsx' ? 'tsx' : 'ts',
          sourcefile: file,
        });
      } catch (err) {
        failures.push(`${relative(ROOT, file)}: ${String(err?.message || err).split('\n').slice(0, 3).join(' ')}`);
      }
    }
    expect(failures, `files that will not parse at boot:\n${failures.join('\n')}`).toEqual([]);
  });

  it('covers the files tsc cannot see', () => {
    // The specific blind spot: @ts-nocheck files are invisible to the
    // typechecker, so this sweep is their only syntax gate. If that stops being
    // true — nobody uses @ts-nocheck any more — this test is not wrong, but the
    // reason it exists has changed and the comment above should be revisited.
    const nocheck = files.filter((f) => readFileSync(f, 'utf8').startsWith('// @ts-nocheck'));
    expect(nocheck.length).toBeGreaterThan(0);
    expect(nocheck.some((f) => f.endsWith('bot.ts'))).toBe(true);
  });
});
