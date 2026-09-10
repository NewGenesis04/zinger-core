// @ts-nocheck
/**
 * INVARIANT: an arb package is sized so both legs can actually be filled, or it
 * is not opened at all.
 *
 * Three constraints act on one share count and pull against each other:
 *
 *   floor    shares >= $1.00 / min(upAsk, downAsk)      (exchange minimum)
 *   depth    shares <= min(upAskSize, downAskSize)      (top-of-book only)
 *   budget   shares <= shareBudget / (upAsk + downAsk)  (operator cap)
 *
 * The floor is an exchange rule settled on 2026-09-10 by live rejection
 * ("invalid amount for a marketable BUY order ($0.21), min size: 1") — see
 * research/polymarket-domain-facts.md. The depth ceiling exists because
 * `maxPrice` is signed at exactly the best ask (`bot.ts:1011`), so every deeper
 * level is priced out of reach and only top-of-book size can fill.
 *
 * Why they are one gate and not three: capping to available depth on its own
 * can drag the CHEAP leg back under $1.00. That fills leg one and gets leg two
 * rejected — the unhedged directional position an arb package exists to
 * prevent, and the one that cost -$12.83 on 2026-08-28. The properties below
 * are stated over the pair, so no future edit can satisfy one ceiling by
 * breaching the floor.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectAndExecuteArbPackage } from '../../src/polymarket/arbEngine.js';
import { saveAllPackages } from '../../src/polymarket/arbPersistence.js';
import { queryEvents, clearEvents } from '../../src/polymarket/telemetry/events.js';

const market = {
  symbol: 'BTC',
  slug: 'btc-updown-sizing',
  conditionId: '0xsizing',
  outcomes: ['Up', 'Down'],
  tokenIds: { up: 'tok-up-s', down: 'tok-down-s' },
  acceptingOrders: true,
};

const baseCfg = {
  clobArbEnabled: true,
  minArbGap: 0.01,
  maxArbPackages: 4,
  arbBankrollFrac: 1.0,
  arbMaxUsd: 50,
  minPositionSize: 0.5,
  instantCtfMerge: false,
};

/**
 * @param upAsk/downAsk   leg prices; their sum must clear the fee gate
 * @param size            top-of-book resting shares, or null to omit the field
 * @param arbMaxUsd       operator budget cap
 * @param bank            spendable balance (live)
 */
function run({ upAsk, downAsk, size = 5000, arbMaxUsd = 50, bank = 10_000, executeTrade } = {}) {
  const leg = (ask) => (size == null ? { bestAsk: ask } : { bestAsk: ask, bestAskSize: size });
  return detectAndExecuteArbPackage({
    market,
    depth: { up: leg(upAsk), down: leg(downAsk) },
    prices: { upAsk, downAsk },
    cfg: { ...baseCfg, arbMaxUsd },
    mode: 'live',
    readiness: { spendableBalance: bank },
    log: () => {},
    executeTrade: executeTrade ?? (async (p) => ({ ok: true, position: { shares: p.plan.shares } })),
    adjustPaperCash: () => {},
    saveTrade: () => {},
    botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
  });
}

const skipCodes = () => queryEvents({ types: ['arb.decision'] })
  .map((e) => (e.data as any)?.output?.skipReason?.code)
  .filter(Boolean);

beforeEach(() => { clearEvents(); saveAllPackages([]); });

describe('INVARIANT: an arb package is fillable or it is not opened', () => {
  it('never signs a leg below the $1.00 exchange minimum', async () => {
    // The live-run shape: a 4c leg against a deep book and a budget that can
    // afford the real package. 25 shares are needed to put $1.00 on the cheap
    // leg, so the package costs ~$24.50 whatever the expensive leg would prefer.
    const pkg = await run({ upAsk: 0.04, downAsk: 0.94, arbMaxUsd: 50 });
    expect(pkg).not.toBeNull();
    expect(pkg.upCost).toBeGreaterThanOrEqual(1.0);
    expect(pkg.downCost).toBeGreaterThanOrEqual(1.0);
    expect(pkg.shares).toBeGreaterThanOrEqual(25);
  });

  it('refuses when the budget cannot put $1.00 on the cheap leg', async () => {
    // arbMaxUsd $5 buys ~5 shares; the 4c leg needs 25. This is the config the
    // 2026-09-09 canary ran, and it produced `$0.21, min size: 1` nine times.
    const pkg = await run({ upAsk: 0.04, downAsk: 0.94, arbMaxUsd: 5 });
    expect(pkg).toBeNull();
    expect(skipCodes()).toContain('budget_below_min_notional');
  });

  it('refuses when top-of-book cannot cover the minimum, rather than sizing down into it', async () => {
    // 3 shares resting; the 4c leg needs 25 to clear $1.00. Taking the 3 would
    // put $0.12 on that leg -> rejected AFTER the first leg filled.
    const pkg = await run({ upAsk: 0.04, downAsk: 0.94, size: 3 });
    expect(pkg).toBeNull();
    expect(skipCodes()).toContain('depth_below_min_size');
  });

  it('sizes down to available depth when the floor still clears', async () => {
    // 12 shares resting, floor is 1/0.30 = 3.34, budget allows far more.
    // Depth binds, and both legs stay above $1.00.
    const pkg = await run({ upAsk: 0.30, downAsk: 0.62, size: 12, arbMaxUsd: 50 });
    expect(pkg).not.toBeNull();
    expect(pkg.shares).toBeLessThanOrEqual(12);
    expect(pkg.upCost).toBeGreaterThanOrEqual(1.0);
    expect(pkg.downCost).toBeGreaterThanOrEqual(1.0);
  });

  it('refuses to size blind when depth is unknown', async () => {
    // Absent is not infinite. Sizing a fill-or-kill order against a book you
    // cannot see is what the 2026-09-09 run did.
    const executeTrade = vi.fn();
    const pkg = await run({ upAsk: 0.34, downAsk: 0.62, size: null, executeTrade });
    expect(pkg).toBeNull();
    expect(executeTrade).not.toHaveBeenCalled();
    expect(skipCodes()).toContain('depth_unknown');
  });

  it('holds both legs above the minimum across the skew range', async () => {
    // The property, not a sample: for every skew the gate admits, BOTH legs
    // clear $1.00 and the share counts match. Where it refuses, nothing opens.
    for (const [up, down] of [[0.04, 0.94], [0.10, 0.87], [0.25, 0.71], [0.45, 0.52], [0.49, 0.49]]) {
      clearEvents();
      saveAllPackages([]);
      const pkg = await run({ upAsk: up, downAsk: down, arbMaxUsd: 50, bank: 10_000 });
      if (pkg == null) continue;
      expect(pkg.upCost, `up leg at ask ${up}`).toBeGreaterThanOrEqual(1.0);
      expect(pkg.downCost, `down leg at ask ${down}`).toBeGreaterThanOrEqual(1.0);
      // Share parity is what makes the set redeem to exactly $1.00.
      expect(pkg.legs.up.shares).toBe(pkg.legs.down.shares);
    }
  });

  it('reports insufficient cash before it reports anything about the book', async () => {
    // Money first, microstructure second: an account that cannot fund the trade
    // is refused for that reason whatever the book looks like.
    const pkg = await run({ upAsk: 0.04, downAsk: 0.94, size: null, bank: 0.05 });
    expect(pkg).toBeNull();
    const codes = skipCodes();
    expect(codes).toContain('insufficient_live_cash');
    expect(codes).not.toContain('depth_unknown');
  });
});
