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
