// @ts-nocheck
/**
 * INVARIANTS: an arb slot is held by exposure, not by settlement bookkeeping
 * (decision D-B, item 103).
 *
 * `pkg-eth-mu9ef745` held the account's only slot (`maxArbPackages: 1`) for
 * nine hours after its window ended, and 7 books that passed every gate were
 * refused for capacity. From window end its payout could not move. It was
 * waiting on resolution and redemption, neither of which carries market risk.
 *
 * There are two capacity gates, and they must agree: the package gate
 * (`maxArbPackages`) and the leg gate (`maxArbPackages × 2` open arb positions,
 * `bot.ts:executePendingTrade`). Freeing only the first would let a package open
 * and then refuse its first leg.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { getSlotHoldingPackages, saveAllPackages } from '../../src/polymarket/arbPersistence.js';
import { detectAndExecuteArbPackage } from '../../src/polymarket/arbEngine.js';
import { capacityHoldingCount } from '../../src/polymarket/positions/manager.js';

const FIVE_MIN = 300;
const nowSec = () => Math.floor(Date.now() / 1000);
/** A 5m slug whose window ended `agoSec` seconds ago (negative: still open). */
const slugEnded = (agoSec, asset = 'eth') => {
  const start = nowSec() - FIVE_MIN - agoSec;
  return `${asset}-updown-5m-${start}`;
};

const pkg = (over) => ({ packageId: 'p', mode: 'live', status: 'LOCKED', slug: slugEnded(60), legs: {}, ...over });
const leg = (over) => ({ id: 'l', mode: 'live', engine: 'arb', isArbLeg: true, packageId: 'p', outcome: 'up', shares: 4.5, closed: false, slug: slugEnded(60), ...over });

describe('INVARIANT: a package stops holding a slot at its window end', () => {
  beforeEach(() => saveAllPackages([]));

  it('counts only packages whose exposure can still move', () => {
    saveAllPackages([
      pkg({ packageId: 'ended', slug: slugEnded(60) }),
      pkg({ packageId: 'open', slug: slugEnded(-60) }),
      pkg({ packageId: 'inflight', status: 'PENDING_FILL', slug: slugEnded(600) }),
      pkg({ packageId: 'unparseable', slug: 'eth-5m-test' }),
      pkg({ packageId: 'settled', status: 'SETTLED', slug: slugEnded(-60) }),
      pkg({ packageId: 'aborted', status: 'ABORTED', slug: slugEnded(-60) }),
      pkg({ packageId: 'paper', mode: 'paper', slug: slugEnded(-60) }),
    ]);
    const ids = getSlotHoldingPackages('live').map((p) => p.packageId).sort();
    // PENDING_FILL has legs in flight whatever the clock says; a slug that will
    // not parse keeps its slot, because in doubt the gate stays shut.
    expect(ids).toEqual(['inflight', 'open', 'unparseable']);
  });
});

describe('INVARIANT: the leg gate releases at the same moment', () => {
  it('stops counting a hold-to-settle position at window end', () => {
    const positions = [leg({ id: 'a' }), leg({ id: 'b', outcome: 'down' })];
    expect(capacityHoldingCount(positions, { mode: 'live', engine: 'arb' })).toBe(0);
    const open = positions.map((p) => ({ ...p, slug: slugEnded(-60) }));
    expect(capacityHoldingCount(open, { mode: 'live', engine: 'arb' })).toBe(2);
  });

  it('leaves exit-managed positions counted while they are open', () => {
    const dir = { id: 'd', mode: 'live', engine: 'directional', outcome: 'up', shares: 5, closed: false, slug: slugEnded(60) };
    expect(capacityHoldingCount([dir], { mode: 'live', engine: 'directional' })).toBe(1);
  });

  it('keeps the slot when the window end cannot be read', () => {
    expect(capacityHoldingCount([leg({ slug: 'eth-5m-test' })], { mode: 'live', engine: 'arb' })).toBe(1);
  });

  it('agrees with the package gate on the same package', () => {
    // maxArbPackages 1 → 1 package, 2 legs.
    for (const agoSec of [-120, -1, 1, 60, 32_400]) {
      const slug = slugEnded(agoSec);
      saveAllPackages([pkg({ slug })]);
      const legs = [leg({ id: 'a', slug }), leg({ id: 'b', outcome: 'down', slug })];
      const packageFull = getSlotHoldingPackages('live').length >= 1;
      const legsFull = capacityHoldingCount(legs, { mode: 'live', engine: 'arb' }) >= 2;
      expect(legsFull, `window ended ${agoSec}s ago`).toBe(packageFull);
    }
  });
});

describe('INVARIANT: an ended package does not block the next one', () => {
  beforeEach(() => saveAllPackages([]));

  async function tryOpen() {
    const lines = [];
    const out = await detectAndExecuteArbPackage({
      market: {
        symbol: 'ETH', slug: slugEnded(-200), conditionId: '0xnext', outcomes: ['Up', 'Down'],
        tokenIds: { up: 'u', down: 'd' }, acceptingOrders: true, tickSize: '0.01',
      },
      depth: { up: { bestAsk: 0.46, bestAskSize: 5000, bookTs: Date.now() }, down: { bestAsk: 0.46, bestAskSize: 5000, bookTs: Date.now() } },
      prices: { up: 0.46, down: 0.46 },
      cfg: {
        clobArbEnabled: true, minArbGap: 0.01, maxArbPackages: 1, paperBankroll: 500, arbBankrollFrac: 0.2,
        arbMaxUsd: 50, minPositionSize: 0.5, instantCtfMerge: false, arbLeg2RereadBook: false, mode: 'paper',
      },
      mode: 'paper',
      log: (m) => lines.push(m),
      executeTrade: async () => ({ ok: true }),
      adjustPaperCash: () => {},
      saveTrade: () => {},
      botState: { config: { maxConcurrentPerSlug: 1 }, positions: [] },
    });
    return out;
  }

  it('opens once the previous package\'s window has ended', async () => {
    saveAllPackages([pkg({ packageId: 'old', mode: 'paper', slug: slugEnded(30) })]);
    expect((await tryOpen())?.status).toBe('LOCKED');
  });

  it('still refuses while the previous package\'s window is open', async () => {
    saveAllPackages([pkg({ packageId: 'old', mode: 'paper', slug: slugEnded(-400, 'btc') })]);
    expect(await tryOpen()).toBeNull();
  });
});

/** Throws unless the leg gate counts capacity-holding positions. */
function checkLegGate(src) {
  const start = src.indexOf('const budget = capacityFor(plan, cfg);');
  if (start < 0) throw new Error('leg capacity gate not found');
  const gate = src.slice(start, src.indexOf('return { ok: false, error: `${engine} capacity` };', start));
  if (!/capacityHoldingCount\(botState\.positions, \{ mode: cfg\.mode, engine \}\) >= budget\.max/.test(gate)) {
    throw new Error('the leg gate does not count capacity-holding positions');
  }
}

describe('INVARIANT: bot.ts gates legs on the same rule', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/polymarket/bot.ts', import.meta.url)), 'utf8');

  it('holds for the real source', () => {
    expect(() => checkLegGate(src)).not.toThrow();
  });

  it('fails if the gate goes back to counting every open position', () => {
    const broken = src.replace(
      'capacityHoldingCount(botState.positions, { mode: cfg.mode, engine }) >= budget.max',
      'countOpenPositions(cfg.mode, engine) >= budget.max',
    );
    expect(broken).not.toBe(src);
    expect(() => checkLegGate(broken)).toThrow(/does not count/);
  });
});
