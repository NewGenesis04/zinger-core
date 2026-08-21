// @ts-nocheck
/**
 * Who changed this setting, when, and why (D3 · reading C).
 *
 * The config store has always kept a *value* and never a *writer*, so
 * "why is kellyFraction 0.1?" had no answer anywhere in the system. Measured on
 * the real store 2026-08-21: the paper profile held five fields matching the
 * `arb-only` overlay and five matching `trend-ride` — two regimes that cannot
 * both have been active — plus values the optimizer also writes. The profile was
 * sediment, and nothing could separate it.
 *
 * There are three automated writers and one human:
 *
 *   governor    ~120s          19 keys      governorEnabled
 *   optimizer   ~180s + cycle   9 keys      llmOptimize
 *   llm         on demand       any         llmOptimize
 *   operator    on demand       any         —
 *
 * Five keys have two automated writers plus the operator: kellyFraction,
 * minConfidence, adaptiveSl, partialTpFrac, tpPctLow.
 *
 * ## Derived from the diff, not from the caller's claim
 *
 * `record()` takes the store before and after and works out what actually
 * changed. It does not trust a patch object. That matters because two writers
 * bypass the patch entirely and mutate the store in place inside `saveConfig`:
 * the `forceArbOnly` guard and the edge-gate mode lock. A patch-based
 * implementation would miss both — exactly the writes most worth attributing.
 *
 * ## Bounded on purpose
 *
 * `fields` keeps one record per field: the write that produced the value in
 * force. `recent` keeps the last MAX_RECENT changes across all fields, newest
 * first, which is what answers "what has the governor been doing". Neither grows
 * without limit; this store is loaded and rewritten on every config write.
 *
 * This module records. It does not decide anything — nothing here can refuse a
 * write or change a value. That is deliberate: attribution had to be able to
 * land without touching behaviour.
 */

/**
 * Writer tiers.
 *
 * The first three are D3's precedence order. `system` is for derived facts
 * rather than policy — the paper cash balance is a consequence of trades, not a
 * setting someone chose — and it deliberately sits outside that ordering.
 */
export const WRITER_TIERS = Object.freeze(['operator', 'guardrail', 'automation', 'system']);

export const MAX_RECENT = 200;

/** Root keys that live on the store rather than inside a profile. */
const ROOT_KEYS = Object.freeze(['mode', 'enabled', 'paperBankroll', 'paperInitialDeposit']);

const EMPTY = Object.freeze({ fields: Object.freeze({}), recent: Object.freeze([]) });

/** Normalize whatever is on disk into the shape the rest of this module expects. */
export function normalizeAttribution(raw) {
  if (!raw || typeof raw !== 'object') return { fields: {}, recent: [] };
  const fields = {};
  for (const [scope, byField] of Object.entries(raw.fields || {})) {
    if (!byField || typeof byField !== 'object') continue;
    fields[scope] = { ...byField };
  }
  const recent = Array.isArray(raw.recent) ? raw.recent.slice(0, MAX_RECENT) : [];
  return { fields, recent };
}

function sameValue(a, b) {
  if (a === b) return true;
  // enabledDurations is an array; a fresh array with equal contents is not a change.
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  // NaN === NaN is false, but NaN -> NaN is not a change worth recording.
  if (typeof a === 'number' && typeof b === 'number'
      && Number.isNaN(a) && Number.isNaN(b)) return true;
  return false;
}

/**
 * Every field whose value differs between two stores.
 *
 * Scope is `root` for store-level keys and the profile name otherwise, so
 * `paper.kellyFraction` and `live.kellyFraction` are tracked separately — they
 * are different settings with different writers.
 */
export function diffStores(before, after) {
  const out = [];
  const b = before || {};
  const a = after || {};

  for (const key of ROOT_KEYS) {
    if (!sameValue(b[key], a[key])) {
      out.push({ scope: 'root', field: key, from: b[key], to: a[key] });
    }
  }

  for (const profile of ['paper', 'live']) {
    const bp = b.profiles?.[profile] || {};
    const ap = a.profiles?.[profile] || {};
    for (const field of new Set([...Object.keys(bp), ...Object.keys(ap)])) {
      if (!sameValue(bp[field], ap[field])) {
        out.push({ scope: profile, field, from: bp[field], to: ap[field] });
      }
    }
  }

  return out;
}

/**
 * Stamp a set of changes onto an attribution record.
 *
 * `at` is passed in rather than read from the clock so this stays pure and the
 * tests do not depend on timing.
 */
export function stamp(attribution, changes, origin = {}, at = 0) {
  const next = normalizeAttribution(attribution);
  if (!changes?.length) return next;

  const tier = WRITER_TIERS.includes(origin.tier) ? origin.tier : 'system';
  const source = String(origin.source || 'unattributed');
  const reason = origin.reason ? String(origin.reason) : null;

  const entries = [];
  for (const c of changes) {
    const rec = { tier, source, at, from: c.from, to: c.to };
    if (reason) rec.reason = reason;
    next.fields[c.scope] = next.fields[c.scope] || {};
    next.fields[c.scope][c.field] = rec;
    entries.push({ scope: c.scope, field: c.field, ...rec });
  }

  next.recent = [...entries.reverse(), ...next.recent].slice(0, MAX_RECENT);
  return next;
}

/**
 * The one call a writer needs: diff the stores and stamp what changed.
 *
 * Returns the attribution record for the *after* store. No-op when nothing
 * changed, so a write that patches a field to the value it already held does
 * not generate a misleading entry.
 */
export function record(before, after, origin = {}, at = 0) {
  return stamp(after?.attribution, diffStores(before, after), origin, at);
}

/** Who set the value currently in force for one field. */
export function writerOf(store, scope, field) {
  return store?.attribution?.fields?.[scope]?.[field] || null;
}

/**
 * Recent changes, newest first, optionally narrowed.
 *
 * `since` is a timestamp; `source` and `tier` filter by writer. This is what a
 * "why did this change?" panel reads.
 */
export function recentChanges(store, { scope = null, field = null, source = null, tier = null, since = 0, limit = 50 } = {}) {
  const rows = store?.attribution?.recent || [];
  return rows
    .filter((r) => (!scope || r.scope === scope)
      && (!field || r.field === field)
      && (!source || r.source === source)
      && (!tier || r.tier === tier)
      && (!since || (r.at || 0) >= since))
    .slice(0, limit);
}

/**
 * Per-writer change counts — the sediment made visible.
 *
 * Answers "how much of my profile did I actually choose", which is the question
 * the store could not answer before this existed.
 */
export function writerSummary(store, scope = null) {
  const fields = store?.attribution?.fields || {};
  const scopes = scope ? [scope] : Object.keys(fields);
  const bySource = {};
  const byTier = {};
  let total = 0;
  for (const s of scopes) {
    for (const rec of Object.values(fields[s] || {})) {
      total += 1;
      bySource[rec.source] = (bySource[rec.source] || 0) + 1;
      byTier[rec.tier] = (byTier[rec.tier] || 0) + 1;
    }
  }
  return { total, bySource, byTier };
}

export { EMPTY as EMPTY_ATTRIBUTION };
