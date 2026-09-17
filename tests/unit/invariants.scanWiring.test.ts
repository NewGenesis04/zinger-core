// @ts-nocheck
/**
 * INVARIANT: `bot.ts` actually uses the scan guard.
 *
 * `scanGuard` is only worth what the call sites do with it, and none of them can
 * be exercised here: `bot.ts` builds a CLOB client through its import graph and
 * no test in this file mocks a module. So these read the source — and a source
 * check fails open, because a regex that matches nothing yields an empty string
 * and asserting on it passes forever.
 *
 * The checkers are therefore pure functions, run against deliberately broken
 * sources as well as the real one. A checker that cannot fail is worth nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const botSrc = () => readFileSync(fileURLToPath(new URL('../../src/polymarket/bot.ts', import.meta.url)), 'utf8');

/** Throws unless the scan loop has a watchdog, a pass identity, and a guarded release. */
function checkScanWiring(src: string): void {
  const start = src.indexOf('export async function scan()');
  if (start < 0) throw new Error('scan() not found');
  const body = src.slice(start, src.indexOf('\nasync function fetchSpotTicker', start));
  if (!body) throw new Error('scan() body not delimited');

  if (!/shouldAbandonCurrentPass\(/.test(body)) {
    throw new Error('scan() never asks whether the holding pass has stalled');
  }
  // Progress, not duration: without a heartbeat the watchdog abandons healthy
  // passes whenever the network is slow, which is precisely when it fires.
  if (!/notePassProgress\(/.test(body)) {
    throw new Error('scan() never reports progress — the watchdog would judge it on total duration');
  }
  if (!/for \(const market of tradableMarkets\) \{\s*(\/\/[^\n]*\n\s*)*notePassProgress\(\)/.test(body)) {
    throw new Error('the market loop does not report progress — a slow pass looks identical to a stuck one');
  }
  if (!/runAsPass\(/.test(body)) {
    throw new Error('scan() does not run its body as an identified pass');
  }
  // The load-bearing one: an abandoned pass must not clear the flag a newer pass holds.
  if (!/if\s*\(ownsLoop\([^)]*\)\)\s*botState\._scanning\s*=\s*false/.test(body)) {
    throw new Error('scan() clears _scanning unconditionally — an abandoned pass would unlock a live one');
  }
}

/** Throws unless the order funnel refuses a pass the watchdog abandoned. */
function checkStaleGuard(src: string): void {
  const start = src.indexOf('async function executePendingTrade(');
  if (start < 0) throw new Error('executePendingTrade not found');
  const body = src.slice(start, start + 4000);

  const guardAt = body.search(/isStalePass\(\)/);
  if (guardAt < 0) throw new Error('executePendingTrade never checks for a stale pass');

  // Order matters: the check is worthless after the order has gone out.
  const firstOrder = body.search(/place(MarketBuy|MarketSell|Order)\(|placeLimitFokBuy\(/);
  if (firstOrder >= 0 && guardAt > firstOrder) {
    throw new Error('the stale-pass check sits AFTER an order call');
  }
}

describe('INVARIANT: the scan loop cannot freeze silently or be unlocked by a zombie', () => {
  it('holds in bot.ts today', () => {
    expect(() => checkScanWiring(botSrc())).not.toThrow();
    expect(() => checkStaleGuard(botSrc())).not.toThrow();
  });

  describe('the checkers reject what they are meant to reject', () => {
    const scanOf = (body: string) => `export async function scan() {${body}}\nasync function fetchSpotTicker(symbol) {`;

    it('accepts a correctly wired source, so it is not simply throwing on everything', () => {
      expect(() => checkScanWiring(scanOf(`
        if (botState._scanning) { if (shouldAbandonCurrentPass(true)) { botState._scanning = false; } else { return; } }
        try { return await runAsPass(passGen, async () => { for (const market of tradableMarkets) { notePassProgress(); } }); } finally { if (ownsLoop(passGen)) botState._scanning = false; }
      `))).not.toThrow();
    });

    it('catches the watchdog being removed', () => {
      expect(() => checkScanWiring(scanOf(`
        if (botState._scanning) return;
        try { return await runAsPass(passGen, async () => { for (const market of tradableMarkets) { notePassProgress(); } }); } finally { if (ownsLoop(passGen)) botState._scanning = false; }
      `))).toThrow(/stalled/);
    });

    it('catches an unconditional unlock — the regression that lets two passes run', () => {
      expect(() => checkScanWiring(scanOf(`
        if (botState._scanning) { if (shouldAbandonCurrentPass(true)) { botState._scanning = false; } else { return; } }
        try { return await runAsPass(passGen, async () => { for (const market of tradableMarkets) { notePassProgress(); } }); } finally { botState._scanning = false; }
      `))).toThrow(/unlock a live one/);
    });

    it('catches the pass identity being dropped', () => {
      expect(() => checkScanWiring(scanOf(`
        if (botState._scanning) { if (shouldAbandonCurrentPass(true)) { botState._scanning = false; } else { return; } }
        try { return await doTheWork(); notePassProgress(); for (const market of tradableMarkets) { notePassProgress(); } } finally { if (ownsLoop(passGen)) botState._scanning = false; }
      `))).toThrow(/identified pass/);
    });

    it('catches the heartbeat being dropped, which makes a slow pass look stuck', () => {
      expect(() => checkScanWiring(scanOf(`
        if (botState._scanning) { if (shouldAbandonCurrentPass(true)) { botState._scanning = false; } else { return; } }
        try { return await runAsPass(passGen, async () => {}); } finally { if (ownsLoop(passGen)) botState._scanning = false; }
      `))).toThrow(/never reports progress/);
    });

    it('catches the heartbeat being left out of the market loop', () => {
      expect(() => checkScanWiring(scanOf(`
        if (botState._scanning) { if (shouldAbandonCurrentPass(true)) { botState._scanning = false; } else { return; } }
        try { return await runAsPass(passGen, async () => { notePassProgress(); for (const market of tradableMarkets) { await handle(market); } }); } finally { if (ownsLoop(passGen)) botState._scanning = false; }
      `))).toThrow(/market loop does not report progress/);
    });

    it('catches the stale guard being removed from the order funnel', () => {
      const src = `async function executePendingTrade(pending) {\n  const cfg = botState.config;\n  const r = await placeMarketBuy({});\n}`;
      expect(() => checkStaleGuard(src)).toThrow(/never checks/);
    });

    it('catches the stale guard being placed after the order goes out', () => {
      const src = `async function executePendingTrade(pending) {\n  const r = await placeMarketBuy({});\n  if (isStalePass()) return { ok: false };\n}`;
      expect(() => checkStaleGuard(src)).toThrow(/AFTER an order/);
    });
  });
});
