import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  POLICIES,
  policyFor,
  holdsToSettlement,
  isExitManaged,
  capacityFor,
  policyForEngine,
} from '../../src/polymarket/positions/policy.js';
import {
  openPositions,
  countOpen,
  exitManagedPositions,
  isSlugOccupied,
  sideBalance,
  portfolioView,
} from '../../src/polymarket/positions/manager.js';

/**
 * D4 — the shared position layer.
 *
 * The rule under test is "shared position code contains zero strategy
 * conditionals". Five places in bot.ts asked "is this arb?" in five different
 * spellings; item 25 was what happens when one of them is updated and the next
 * one eighteen lines down is not.
 *
 * These are invariants, not characterization tests: each states a property that
 * must hold for any engine, including one that does not exist yet.
 */

const leg = (over: any = {}) => ({
  mode: 'paper', closed: false, outcome: 'up', slug: 's1',
  packageId: 'pkg-1', isArbLeg: true, engine: 'arb', ...over,
});
const directional = (over: any = {}) => ({
  mode: 'paper', closed: false, outcome: 'up', slug: 's1', engine: 'directional', ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: hold-to-settlement is one predicate, not five spellings', () => {
  it('protects an arb leg however it is marked', () => {
    // Each of these is a form the five old conditionals disagreed about.
    expect(holdsToSettlement(leg())).toBe(true);
    expect(holdsToSettlement({ packageId: 'pkg-1' })).toBe(true);
    expect(holdsToSettlement({ isArbLeg: true })).toBe(true);
    expect(holdsToSettlement({ arb: true })).toBe(true);
    expect(holdsToSettlement({ engine: 'arb' })).toBe(true);
  });

  it('leaves a directional position under exit management', () => {
    expect(holdsToSettlement(directional())).toBe(false);
    expect(holdsToSettlement({})).toBe(false);
    expect(isExitManaged(directional())).toBe(true);
  });

  it('protects a contradictory record rather than exposing it', () => {
    // `engine: 'directional'` + a packageId is data this code cannot create
    // (bot.ts stamps engine from tradeEngine(plan)). If it ever appears, the
    // asymmetry decides: exposing a real leg to a stop forfeits the locked
    // edge, strands the sibling and feeds item 8's fabricated $0.50 settle.
    // Leaving one directional position unmanaged is a smaller loss.
    expect(holdsToSettlement({ engine: 'directional', packageId: 'pkg-1' })).toBe(true);
    expect(holdsToSettlement({ engine: 'directional', isArbLeg: true })).toBe(true);
  });

  it('treats an unrecognised tag as managed, not immune', () => {
    // tradeEngine already defaults an unknown tag to 'directional', so this
    // asserts that composition — not policyFor's fallback, which that default
    // makes unreachable. The fallback is covered below.
    expect(holdsToSettlement({ engine: 'something-new' })).toBe(false);
    expect(policyFor({ engine: 'something-new' })).toBe(POLICIES.directional);
  });

  it('gives an undeclared engine the managed policy, not hold-to-settle', () => {
    // The real hazard: someone teaches tradeEngine a third engine and forgets
    // to declare its policy. Inheriting hold-to-settlement would remove the
    // stop loss from every position that engine opens, silently.
    expect(policyForEngine('scalper')).toBe(POLICIES.directional);
    expect(policyForEngine(undefined)).toBe(POLICIES.directional);
    expect(policyForEngine(null)).toBe(POLICIES.directional);
    expect(policyForEngine('scalper').holdsToSettlement).toBe(false);
  });

  it('declares a policy for every engine tradeEngine can return', () => {
    // If this fails, policyFor returns undefined and the next property access
    // throws inside the scan loop.
    for (const p of [{ isArbLeg: true }, {}, { engine: 'arb' }, { engine: 'directional' }]) {
      expect(policyFor(p), JSON.stringify(p)).toBeTruthy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: engine capacity comes from the engine\'s own dial (D5)', () => {
  it('charges arb legs against maxArbPackages, two per package', () => {
    const cap = capacityFor(leg(), { maxArbPackages: 40, maxOpenPositions: 4 });
    expect(cap.engine).toBe('arb');
    expect(cap.slots).toBe(40);
    // The cross-wiring bug: 40 packages authorised, but maxOpenPositions 4
    // capped arb at two packages.
    expect(cap.max).toBe(80);
  });

  it('charges directional positions against maxOpenPositions, one each', () => {
    const cap = capacityFor(directional(), { maxArbPackages: 40, maxOpenPositions: 4 });
    expect(cap.engine).toBe('directional');
    expect(cap.max).toBe(4);
  });

  it('never lets one engine\'s dial move the other\'s budget', () => {
    const cfg = { maxArbPackages: 4, maxOpenPositions: 6 };
    const arbBefore = capacityFor(leg(), cfg).max;
    const dirBefore = capacityFor(directional(), cfg).max;
    expect(capacityFor(leg(), { ...cfg, maxOpenPositions: 999 }).max).toBe(arbBefore);
    expect(capacityFor(directional(), { ...cfg, maxArbPackages: 999 }).max).toBe(dirBefore);
  });

  it('falls back to the policy default when the dial is unset', () => {
    expect(capacityFor(leg(), {}).max).toBe(POLICIES.arb.slotDefault * 2);
    expect(capacityFor(directional(), {}).max).toBe(POLICIES.directional.slotDefault);
    // A non-numeric dial must not produce NaN — that comparison is always false,
    // which silently removes the cap entirely.
    expect(capacityFor(directional(), { maxOpenPositions: 'lots' }).max)
      .toBe(POLICIES.directional.slotDefault);
  });

  it('respects an explicit zero as a real cap', () => {
    // 0 must mean "none", not "fall back to the default".
    expect(capacityFor(directional(), { maxOpenPositions: 0 }).max).toBe(0);
    expect(capacityFor(leg(), { maxArbPackages: 0 }).max).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: position queries count the right set', () => {
  const positions = [
    leg({ id: 'a' }),
    leg({ id: 'b', outcome: 'down' }),
    directional({ id: 'c' }),
    directional({ id: 'd', mode: 'live' }),
    directional({ id: 'e', closed: true }),
    leg({ id: 'f', closed: true }),
  ];

  it('separates the two engines\' slot counts', () => {
    expect(countOpen(positions, { mode: 'paper', engine: 'arb' })).toBe(2);
    expect(countOpen(positions, { mode: 'paper', engine: 'directional' })).toBe(1);
    // Omitting engine is a reporting number, not a capacity number.
    expect(countOpen(positions, { mode: 'paper' })).toBe(3);
  });

  it('never counts a closed position as open', () => {
    expect(openPositions(positions).every((p: any) => !p.closed)).toBe(true);
    expect(countOpen(positions, { mode: null, engine: null })).toBe(4);
  });

  it('excludes hedges from the exit-managed set', () => {
    const managed = exitManagedPositions(positions, { mode: 'paper' });
    expect(managed.map((p: any) => p.id)).toEqual(['c']);
    expect(managed.some((p: any) => holdsToSettlement(p))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: a slug is occupied by positions, pendings AND locks', () => {
  const base = { positions: [directional({ slug: 'taken' })], pendingTrades: [], buyLocks: new Set(), cfg: {} };

  it('counts a filled position', () => {
    expect(isSlugOccupied({ ...base, slug: 'taken' })).toBe(true);
    expect(isSlugOccupied({ ...base, slug: 'free' })).toBe(false);
  });

  it('counts a pending trade, so dispatch-then-fill cannot double-open', () => {
    // The gap between dispatch and fill is real; counting only positions is
    // what lets two orders land on one slug.
    expect(isSlugOccupied({
      ...base, positions: [], slug: 'free',
      pendingTrades: [{ slug: 'free', status: 'pending' }],
    })).toBe(true);
    // A trade that is no longer pending does not hold the slug.
    expect(isSlugOccupied({
      ...base, positions: [], slug: 'free',
      pendingTrades: [{ slug: 'free', status: 'expired' }],
    })).toBe(false);
  });

  it('counts an in-flight buy lock', () => {
    expect(isSlugOccupied({ ...base, positions: [], slug: 'free', buyLocks: new Set(['free']) })).toBe(true);
  });

  it('treats maxConcurrentPerSlug 0 as "none allowed"', () => {
    // Surprising, but the shipped meaning — callers depend on it.
    expect(isSlugOccupied({ ...base, positions: [], slug: 'free', cfg: { maxConcurrentPerSlug: 0 } })).toBe(true);
  });

  it('allows a second position when the operator raised the limit', () => {
    const cfg = { maxConcurrentPerSlug: 2 };
    expect(isSlugOccupied({ ...base, slug: 'taken', cfg })).toBe(false);
    expect(isSlugOccupied({
      ...base, slug: 'taken', cfg,
      positions: [directional({ slug: 'taken' }), directional({ slug: 'taken' })],
    })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: side balance weights open exposure over closed history', () => {
  it('counts an open position double a closed trade', () => {
    const s = sideBalance({
      positions: [directional({ outcome: 'up' })],
      trades: [{ id: 't1', mode: 'paper', outcome: 'down', closed: true }],
      mode: 'paper',
    });
    expect(s.up).toBe(2);
    expect(s.down).toBe(1);
    expect(s.upShare).toBeCloseTo(2 / 3, 6);
  });

  it('reports a neutral 0.5 on an empty book rather than dividing by zero', () => {
    expect(sideBalance({ positions: [], trades: [], mode: 'paper' }).upShare).toBe(0.5);
  });

  it('ignores the other mode entirely', () => {
    const s = sideBalance({
      positions: [directional({ outcome: 'up', mode: 'live' })],
      trades: [{ id: 't1', mode: 'live', outcome: 'up', closed: true }],
      mode: 'paper',
    });
    expect(s.total).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: the portfolio view is assembled from position state only', () => {
  it('returns the three facts the directional gate depends on', () => {
    const view = portfolioView({
      slug: 'taken',
      cfg: { mode: 'paper' },
      positions: [directional({ slug: 'taken' })],
      trades: [],
      pendingTrades: [],
      buyLocks: new Set(),
      dataAssurance: { ok: true },
    });
    expect(view.hasOpenOnSlug).toBe(true);
    expect(view.sideBalance.upShare).toBeCloseTo(1, 6);
    expect(view.dataAssurance).toEqual({ ok: true });
  });

  it('is pure — the same inputs give the same view', () => {
    const args: any = {
      slug: 's1', cfg: { mode: 'paper' },
      positions: [directional()], trades: [], pendingTrades: [], buyLocks: new Set(),
    };
    expect(portfolioView(args)).toEqual(portfolioView(args));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: shared position code holds zero strategy conditionals (D4)', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../../src/polymarket', p), 'utf8');

  it('keeps the manager free of engine names and arb flags', () => {
    // The manager must ask the policy, never test for arb itself. This is the
    // CI grep the plan calls for.
    const src = read('positions/manager.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/isArbLeg|packageId|\.arb\b/);
    expect(code).not.toMatch(/===\s*'arb'/);
  });

  it('leaves bot.ts no mid-window exit conditional of its own', () => {
    const code = read('bot.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The five spellings that used to gate exits, drawdown, trim and repair.
    expect(code).not.toMatch(/pos\.packageId \|\| pos\.isArbLeg/);
    expect(code).not.toMatch(/op\.packageId \|\| op\.isArbLeg/);
    expect(code).not.toMatch(/!p\.packageId && !p\.isArbLeg/);
    // Item 8's settle branch is the one remaining conditional, scheduled for
    // slice 3. If this count changes, a new one was added.
    const remaining = code.match(/\b(?:pos|p|op)\.isArbLeg\b/g) || [];
    expect(remaining).toHaveLength(1);
  });

  it('routes capacity through the policy, not an inline ternary', () => {
    const code = read('bot.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/capacityFor\(plan, cfg\)/);
    expect(code).not.toMatch(/engine === 'arb'\s*\n?\s*\?/);
  });
});
