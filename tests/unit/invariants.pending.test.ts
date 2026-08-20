import { describe, expect, it, beforeEach } from 'vitest';
import { detectAndExecuteArbPackage } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages, savePackage, getActivePackages } from '../../src/polymarket/arbPersistence.js';
import { takerFeeUsdc } from '../../src/polymarket/fees.js';
import { normalizeConfigStore, defaultLiveStrategy } from '../../src/polymarket/modeConfig.js';

/**
 * Slice-0 invariants that do NOT hold yet.
 *
 * These are the acceptance criteria for slices 1–3, written now so the target
 * is fixed before the code moves. Each is wrapped in `it.fails()`, which asserts
 * the test currently fails — so:
 *
 *   - CI stays green while the defect exists (the bot keeps paper trading, D6)
 *   - the moment someone fixes the defect this file goes RED with "expected to
 *     fail but passed", which is the signal to move the test into
 *     `invariants.test.ts` and delete it here
 *
 * That is deliberately the opposite of a characterization test: nothing here
 * asserts current behaviour is correct. Each one states what *should* be true
 * and records that it is not.
 *
 * Do not "fix" a red test in this file by weakening the assertion. If it goes
 * red, the underlying defect was fixed — promote it.
 */

const market = (over = {}) => ({
  symbol: 'BTC',
  slug: 'btc-updown-5m-1787000000',
  conditionId: '0xcondition',
  outcomes: ['Up', 'Down'],
  tokenIds: { up: 'token-up', down: 'token-down' },
  acceptingOrders: true,
  negRisk: false,
  ...over,
});

const cfg = (over = {}) => ({
  clobArbEnabled: true,
  minArbGap: 0.015, // the shipped default — modeConfig.ts:120
  maxArbPackages: 4,
  paperBankroll: 100,
  arbBankrollFrac: 0.2,
  arbMaxUsd: 50,
  minPositionSize: 0.5,
  mode: 'paper',
  ...over,
});

beforeEach(() => {
  saveAllPackages([]);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PENDING INVARIANT: an accepted arb package is profitable after fees', () => {
  // Backlog item 7. `arbEngine.ts:52-53` compares the raw book gap against
  // minArbGap with no fee term. Break-even is 2 x rate x (p(1-p))^e — 3.5% at a
  // 50/50 book — so the shipped 0.015 default takes structural losers.
  it.fails('does not open a package whose gap cannot cover both legs\' fees', async () => {
    const up = 0.492;
    const down = 0.492; // gap = 1.6%, above minArbGap 1.5%, below break-even 3.5%

    const pkg = await detectAndExecuteArbPackage({
      market: market(),
      depth: { up: { bestAsk: up }, down: { bestAsk: down } },
      prices: { up, down },
      cfg: cfg(),
      mode: 'paper',
      log: () => {},
      executeTrade: async () => true,
      botState: { config: {}, positions: [] },
    });

    if (pkg) {
      const shares = pkg.shares;
      const grossProfit = pkg.expectedPayout - pkg.totalCost;
      const fees = takerFeeUsdc(shares, up, 'crypto') + takerFeeUsdc(shares, down, 'crypto');
      // The engine took this trade; it must at least make money.
      expect(grossProfit - fees).toBeGreaterThan(0);
    }
    expect(pkg).toBeNull();
  });

  it.fails('reports locked profit net of fees, not gross', async () => {
    const up = 0.34;
    const down = 0.62;
    const pkg = await detectAndExecuteArbPackage({
      market: market(),
      depth: { up: { bestAsk: up }, down: { bestAsk: down } },
      prices: { up, down },
      cfg: cfg(),
      mode: 'paper',
      log: () => {},
      executeTrade: async () => true,
      botState: { config: {}, positions: [] },
    });
    const fees = takerFeeUsdc(pkg.shares, up, 'crypto') + takerFeeUsdc(pkg.shares, down, 'crypto');
    const netProfit = pkg.expectedPayout - pkg.totalCost - fees;
    // lockedProfitUsd is what the UI and session stats report.
    expect(pkg.lockedProfitUsd).toBeCloseTo(netProfit, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PENDING INVARIANT: every package reaches a terminal state', () => {
  // Backlog item 9. A package interrupted mid-dispatch (process restart during
  // Promise.allSettled) stays PENDING_FILL forever. getActivePackages counts
  // LOCKED + PENDING_FILL (arbPersistence.ts:81), so it permanently consumes a
  // maxArbPackages slot that nothing can clear. There is no boot reconciliation.
  //
  // Confirmed in production 2026-08-20: pkg-btc-msyglw8m, 40.5h old.
  it.fails('does not let a stale PENDING_FILL package consume capacity forever', () => {
    savePackage({
      packageId: 'pkg-stuck',
      symbol: 'BTC',
      slug: 'btc-updown-5m-stuck',
      shares: 10,
      status: 'PENDING_FILL',
      mode: 'paper',
      createdAt: Date.now() - 48 * 3600 * 1000, // two days ago
      legs: {
        up: { outcome: 'up', shares: 10, filled: false },
        down: { outcome: 'down', shares: 10, filled: false },
      },
    } as any);

    // Nothing reconciles this on boot, so it still counts against capacity.
    expect(getActivePackages('paper')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PENDING INVARIANT: operator settings are never silently overwritten', () => {
  // Backlog item 19. normalizeConfigStore (modeConfig.ts:213-222) seeds the live
  // profile from `pickStrategy(base)` when migrating a legacy flat config, so
  // paper-shaped values overwrite every conservative live default. Only the gate
  // flags were protected, not the size caps.
  it.fails('never widens a live risk cap beyond defaultLiveStrategy() on migration', () => {
    const legacyFlatPaperConfig = {
      mode: 'paper',
      maxPositionCap: 100,
      maxPositionSize: 100,
      certaintyMaxUsd: 100,
      arbMaxUsd: 50,
      maxOpenPositions: 4,
      kellyFraction: 0.12,
      // no `profiles` key — this is what triggers the migration path
    };

    const migrated = normalizeConfigStore(legacyFlatPaperConfig);
    const defaults = defaultLiveStrategy();

    for (const field of [
      'maxPositionCap',
      'maxPositionSize',
      'certaintyMaxUsd',
      'arbMaxUsd',
      'maxOpenPositions',
      'kellyFraction',
    ]) {
      expect(
        migrated.profiles.live[field],
        `live ${field} was widened past its default by migration`,
      ).toBeLessThanOrEqual(defaults[field]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PENDING INVARIANT: settlement valuation depends on the sibling leg', () => {
  // Backlog item 8. `bot.ts` collapses any arb leg to $0.50 on settle, testing
  // isArbLeg on the position and never whether the sibling still exists. A leg
  // left alone books shares x (0.50 - entry) regardless of the real outcome —
  // observed as a fabricated +$2.99 on pkg-btc-msyglw8m, which is still stuck
  // in production as of 2026-08-20.
  //
  // executeSell is not exported; slice 3 moves settlement valuation to
  // `positions/settle.ts` behind the D4 policy interface, which is what makes
  // this expressible as a fixture test.
  it.todo('settles a naked arb leg against the real outcome, not $0.50 — needs positions/settle.ts (slice 3)');
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PENDING INVARIANT: a declined leg is never recorded as filled', () => {
  // Backlog item 27, found 2026-08-20 while decoupling the slot budgets (D5).
  //
  // `executeArbLeg` ends with `return !!(await executeTrade(pending))`
  // (arbEngine.ts:211), and `executePendingTrade` returns an *object* on every
  // path — `{ ok: false, error: 'max open positions' }` as readily as
  // `{ ok: true, position }`. Both are truthy, so `!!` is always true and the
  // engine cannot distinguish a fill from a refusal.
  //
  // Consequence: the "Emergency Rollback Handler" (arbEngine.ts:153-168) is
  // unreachable for every decline. It fires only when executeTrade *throws*.
  //
  // Verified against the real engine, 2026-08-20:
  //
  //   both legs fill           -> LOCKED   up=true  down=true   (correct)
  //   both legs DECLINED       -> LOCKED   up=true  down=true   (zero positions)
  //   up fills, down DECLINED  -> LOCKED   up=true  down=true   (naked leg)
  //   both legs throw          -> ABORTED  up=false down=false  (correct)

  const declined = { ok: false, error: 'max open positions' };
  const filled = { ok: true, position: {} };

  const run = (executeTrade) => detectAndExecuteArbPackage({
    market: market(),
    depth: { up: { bestAsk: 0.34 }, down: { bestAsk: 0.62 } },
    prices: { up: 0.34, down: 0.62 },
    cfg: cfg(),
    mode: 'paper',
    log: () => {},
    executeTrade,
    botState: { config: {}, positions: [] },
  });

  it.fails('does not lock a package when both legs were refused', async () => {
    const pkg = await run(async () => declined);
    // Nothing was bought. Locking this reports profit on a position that does
    // not exist, and getArbPackageMetrics then reads lockedProfitUsd gross of
    // fees because there are no leg trades to correct it (item 24).
    expect(pkg.status).not.toBe('LOCKED');
    expect(pkg.legs.up.filled).toBe(false);
    expect(pkg.legs.down.filled).toBe(false);
  });

  it.fails('aborts and unwinds when only one leg was accepted', async () => {
    let n = 0;
    const pkg = await run(async () => (++n === 1 ? filled : declined));
    // This is the naked leg of items 8 and 25 — real directional exposure held
    // in the belief that it is hedged. In live mode that is unhedged money.
    expect(pkg.status).toBe('ABORTED');
    expect(pkg.abortReason).toMatch(/mismatch/i);
  });

  it.fails('reports a refusal distinctly from a fill', async () => {
    // The root cause, isolated: the boolean the engine branches on carries no
    // information, because every return value of executePendingTrade is truthy.
    //
    // The reset between runs is load-bearing — the first package consumes a
    // maxArbPackages slot, so without it the second detection returns null and
    // this fails on a TypeError instead of on its own assertion, which would
    // make the it.fails() worthless.
    const both = await run(async () => declined);
    saveAllPackages([]);
    const good = await run(async () => filled);
    expect(both.status).not.toBe(good.status);
  });
});
