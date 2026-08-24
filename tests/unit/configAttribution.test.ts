import { describe, expect, it } from 'vitest';
import {
  WRITER_TIERS, MAX_RECENT, diffStores, stamp, record,
  writerOf, recentChanges, writerSummary, normalizeAttribution,
} from '../../src/polymarket/config/attribution.js';
import { normalizeConfigStore, applyConfigPatch } from '../../src/polymarket/modeConfig.js';

/**
 * D3 · reading C — every config write is attributed.
 *
 * Motivating measurement (2026-08-21): the real paper profile held five fields
 * matching the `arb-only` overlay and five matching `trend-ride`, two regimes
 * that cannot both have been active, plus fields the optimizer also writes. The
 * profile was sediment and nothing could separate it. These invariants are
 * about being able to.
 */

const store = (over: any = {}) => ({
  mode: 'paper',
  enabled: false,
  paperBankroll: 100,
  paperInitialDeposit: 100,
  profiles: { paper: { kellyFraction: 0.12, slPct: 8 }, live: { kellyFraction: 0.05 } },
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: attribution is derived from the diff, not the caller\'s claim', () => {
  it('records only fields that actually changed', () => {
    const before = store();
    const after = store({ profiles: { paper: { kellyFraction: 0.1, slPct: 8 }, live: { kellyFraction: 0.05 } } });
    const changes = diffStores(before, after);
    expect(changes).toEqual([{ scope: 'paper', field: 'kellyFraction', from: 0.12, to: 0.1 }]);
  });

  it('records nothing when a write sets a field to the value it already had', () => {
    // Otherwise the governor's ~120s tick would log 19 phantom changes forever.
    expect(diffStores(store(), store())).toEqual([]);
    const attr = record(store(), store(), { tier: 'automation', source: 'governor' }, 1000);
    expect(attr.recent).toEqual([]);
  });

  it('catches an in-place mutation that no patch object mentions', () => {
    // The forceArbOnly guard and the edge-gate mode lock both mutate the store
    // directly inside saveConfig. A patch-based implementation would miss them,
    // and they are the writes most worth having a name on.
    const before = store({ profiles: { paper: { forceArbOnly: true, clobArbEnabled: false }, live: {} } });
    const after = JSON.parse(JSON.stringify(before));
    after.profiles.paper.clobArbEnabled = true;   // no patch, direct mutation
    const changes = diffStores(before, after);
    expect(changes).toEqual([{ scope: 'paper', field: 'clobArbEnabled', from: false, to: true }]);
  });

  it('tracks paper and live separately — they are different settings', () => {
    const before = store();
    const after = store({ profiles: { paper: { kellyFraction: 0.12, slPct: 8 }, live: { kellyFraction: 0.09 } } });
    const changes = diffStores(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0].scope).toBe('live');
  });

  it('does not report an array as changed when its contents are equal', () => {
    // enabledDurations is rebuilt by every overlay application. Reference
    // inequality would make it look like a change on every governor tick.
    const a = store({ profiles: { paper: { enabledDurations: ['5m', '15m'] }, live: {} } });
    const b = store({ profiles: { paper: { enabledDurations: ['5m', '15m'] }, live: {} } });
    expect(diffStores(a, b)).toEqual([]);
    const c = store({ profiles: { paper: { enabledDurations: ['5m'] }, live: {} } });
    expect(diffStores(a, c)).toHaveLength(1);
  });

  it('tracks the root keys, not only profile fields', () => {
    const changes = diffStores(store(), store({ mode: 'live', enabled: true }));
    expect(changes.map((c) => c.field).sort()).toEqual(['enabled', 'mode']);
    expect(changes.every((c) => c.scope === 'root')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: every write carries a named writer', () => {
  it('keeps the writer of the value currently in force', () => {
    const before = store();
    const after = { ...store({ profiles: { paper: { kellyFraction: 0.1, slPct: 8 }, live: { kellyFraction: 0.05 } } }) };
    after.attribution = record(before, after, { tier: 'automation', source: 'governor', reason: 'regime arb-only' }, 5000);
    const w = writerOf(after, 'paper', 'kellyFraction');
    expect(w).toMatchObject({ tier: 'automation', source: 'governor', from: 0.12, to: 0.1, at: 5000 });
    expect(w.reason).toBe('regime arb-only');
  });

  it('labels an untagged writer rather than guessing the operator', () => {
    // Mislabelling an automated write as the operator is worse than admitting
    // ignorance — it would make the sediment look like deliberate choices.
    const attr = stamp(null, [{ scope: 'paper', field: 'slPct', from: 8, to: 9 }], {}, 1);
    expect(attr.fields.paper.slPct.source).toBe('unattributed');
    expect(attr.fields.paper.slPct.tier).toBe('system');
  });

  it('rejects a tier it does not recognise', () => {
    const attr = stamp(null, [{ scope: 'paper', field: 'slPct', from: 8, to: 9 }], { tier: 'boss', source: 'x' }, 1);
    expect(WRITER_TIERS).not.toContain('boss');
    expect(attr.fields.paper.slPct.tier).toBe('system');
  });

  it('overwrites the current writer but keeps the change in recent', () => {
    let attr = stamp(null, [{ scope: 'paper', field: 'slPct', from: 8, to: 9 }], { tier: 'operator', source: 'dashboard' }, 1);
    attr = stamp(attr, [{ scope: 'paper', field: 'slPct', from: 9, to: 10 }], { tier: 'automation', source: 'optimizer' }, 2);
    expect(attr.fields.paper.slPct.source).toBe('optimizer');
    expect(attr.recent).toHaveLength(2);
    expect(attr.recent[0].source).toBe('optimizer');
    expect(attr.recent[1].source).toBe('dashboard');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: the record stays bounded', () => {
  it('never grows past MAX_RECENT', () => {
    // This store is loaded and rewritten on every config write, and the
    // governor ticks every ~120s. Unbounded growth would be a slow leak.
    let attr: any = null;
    for (let i = 0; i < MAX_RECENT + 50; i += 1) {
      attr = stamp(attr, [{ scope: 'paper', field: `f${i}`, from: i, to: i + 1 }], { tier: 'automation', source: 'governor' }, i);
    }
    expect(attr.recent).toHaveLength(MAX_RECENT);
    expect(attr.recent[0].field).toBe(`f${MAX_RECENT + 49}`);
  });

  it('truncates an oversized record loaded from disk', () => {
    const fat = { fields: {}, recent: Array.from({ length: 900 }, (_, i) => ({ field: `f${i}` })) };
    expect(normalizeAttribution(fat).recent).toHaveLength(MAX_RECENT);
  });

  it('survives junk on disk', () => {
    for (const junk of [null, undefined, 42, 'x', [], { fields: 'no' }]) {
      const n = normalizeAttribution(junk as any);
      expect(n.fields).toEqual({});
      expect(Array.isArray(n.recent)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: attribution survives a store round-trip', () => {
  it('is preserved by normalizeConfigStore on load', () => {
    // Dropped on load means the record resets on every restart, which makes it
    // useless for exactly the slow accumulation it exists to expose.
    const raw = {
      mode: 'paper',
      profiles: { paper: { kellyFraction: 0.1 }, live: {} },
      attribution: { fields: { paper: { kellyFraction: { tier: 'automation', source: 'governor', at: 7 } } }, recent: [] },
    };
    const loaded: any = normalizeConfigStore(raw);
    expect(writerOf(loaded, 'paper', 'kellyFraction')).toMatchObject({ source: 'governor' });
  });

  it('is preserved by applyConfigPatch', () => {
    const before: any = normalizeConfigStore({
      profiles: { paper: { kellyFraction: 0.1 }, live: {} },
      attribution: { fields: { paper: { kellyFraction: { tier: 'operator', source: 'dashboard', at: 3 } } }, recent: [] },
    });
    const after: any = applyConfigPatch(before, { slPct: 9 });
    expect(writerOf(after, 'paper', 'kellyFraction')).toMatchObject({ source: 'dashboard' });
  });

  it('starts empty rather than undefined on a fresh store', () => {
    const fresh: any = normalizeConfigStore({});
    expect(fresh.attribution).toEqual({ fields: {}, recent: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: the sediment is countable', () => {
  it('reports how much of a profile each writer set', () => {
    // The question the store could not answer: how much of this did I choose?
    let attr: any = null;
    attr = stamp(attr, [
      { scope: 'paper', field: 'kellyFraction', from: 0.12, to: 0.1 },
      { scope: 'paper', field: 'minConfidence', from: 0.38, to: 0.5 },
    ], { tier: 'automation', source: 'governor' }, 1);
    attr = stamp(attr, [{ scope: 'paper', field: 'slPct', from: 12, to: 8 }], { tier: 'automation', source: 'optimizer' }, 2);
    attr = stamp(attr, [{ scope: 'paper', field: 'minPrice', from: 0.42, to: 0.44 }], { tier: 'operator', source: 'dashboard' }, 3);

    const s = writerSummary({ attribution: attr }, 'paper');
    expect(s.total).toBe(4);
    expect(s.bySource).toEqual({ governor: 2, optimizer: 1, dashboard: 1 });
    expect(s.byTier).toEqual({ automation: 3, operator: 1 });
  });

  it('answers "what did the governor change recently"', () => {
    let attr: any = null;
    attr = stamp(attr, [{ scope: 'paper', field: 'kellyFraction', from: 0.12, to: 0.1 }], { tier: 'automation', source: 'governor' }, 100);
    attr = stamp(attr, [{ scope: 'paper', field: 'slPct', from: 12, to: 8 }], { tier: 'automation', source: 'optimizer' }, 200);
    const s: any = { attribution: attr };
    expect(recentChanges(s, { source: 'governor' })).toHaveLength(1);
    expect(recentChanges(s, { since: 150 })).toHaveLength(1);
    expect(recentChanges(s, { field: 'slPct' })[0].source).toBe('optimizer');
    expect(recentChanges(s, { limit: 1 })).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT: the record never disagrees with the stored value', () => {
  // The bug this catches, found by an end-to-end probe rather than by any unit
  // test here: `saveConfig` diffed the post-guard store against a SPREAD COPY of
  // itself. A spread shares the same `profiles` object, so when the forceArbOnly
  // guard mutated `clobArbEnabled` in place the diff saw nothing — and the
  // record claimed the OPERATOR had set it false while the stored value was
  // true. An attribution record that lies is worse than none.
  //
  // Tested here on the primitive: diffing against an aliased snapshot must be
  // impossible to do accidentally, so the invariant is stated on the outcome.

  it('sees an in-place mutation when the snapshot is a real copy', () => {
    const base: any = {
      mode: 'paper', enabled: false, paperBankroll: 100, paperInitialDeposit: 100,
      profiles: { paper: { forceArbOnly: true, clobArbEnabled: false }, live: {} },
    };
    const snapshot = { ...base, profiles: { paper: { ...base.profiles.paper }, live: { ...base.profiles.live } } };
    base.profiles.paper.clobArbEnabled = true;             // the guard, in place
    const changes = diffStores(snapshot, base);
    expect(changes).toEqual([{ scope: 'paper', field: 'clobArbEnabled', from: false, to: true }]);
  });

  it('sees NOTHING when the snapshot is a shallow spread — the trap', () => {
    // Documents why the snapshot above must be deep. If this ever starts
    // reporting a change, JS object semantics changed and the guard in
    // saveConfig can be simplified.
    const base: any = {
      mode: 'paper', enabled: false, paperBankroll: 100, paperInitialDeposit: 100,
      profiles: { paper: { forceArbOnly: true, clobArbEnabled: false }, live: {} },
    };
    const aliased = { ...base };                            // shares `profiles`
    base.profiles.paper.clobArbEnabled = true;
    expect(diffStores(aliased, base)).toEqual([]);
  });

  it('attributes a guardrail correction to the guardrail, not the caller', () => {
    const afterPatch: any = {
      mode: 'paper', enabled: false, paperBankroll: 100, paperInitialDeposit: 100,
      profiles: { paper: { forceArbOnly: true, clobArbEnabled: false }, live: {} },
      attribution: null,
    };
    afterPatch.attribution = record(
      { profiles: { paper: { forceArbOnly: false, clobArbEnabled: true }, live: {} } },
      afterPatch, { tier: 'operator', source: 'dashboard' }, 1,
    );
    const snapshot = { ...afterPatch, profiles: { paper: { ...afterPatch.profiles.paper }, live: {} } };
    afterPatch.profiles.paper.clobArbEnabled = true;
    afterPatch.attribution = record(snapshot, afterPatch,
      { tier: 'guardrail', source: 'forceArbOnly-guard', reason: 'forceArbOnly requires clobArbEnabled' }, 2);

    const w = writerOf(afterPatch, 'paper', 'clobArbEnabled');
    expect(w.source).toBe('forceArbOnly-guard');
    expect(w.tier).toBe('guardrail');
    // and the record agrees with reality
    expect(w.to).toBe(afterPatch.profiles.paper.clobArbEnabled);
  });
});
