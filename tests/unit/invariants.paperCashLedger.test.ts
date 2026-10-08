import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { allocateOutstanding, bookPaperLeg, paperEntryFields, resolveSlFillPrice } from '../../src/polymarket/paperLeg.js';
import { closeProceedsWithFee, takerFeeUsdc } from '../../src/polymarket/fees.js';
import { booksCash } from '../../src/polymarket/ledger/cash.js';
import { computeTradeStats, normalizeTrade, tradeFeesPaid, tradeNetPnl } from '../../src/polymarket/audit.js';

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/**
 * INVARIANT: paper cash reconciles to the penny (backlog items 129, 130).
 *
 *   cash = initial + Σ P/L of closed legs − Σ (cost + entry fee) still open
 *
 * and every closed leg's P/L is the cash that actually moved for it, so the
 * headline P/L, the per-trade P/L and the cash ledger cannot disagree. Before
 * the fix the stop paths credited raw proceeds with no exit fee, partial and
 * final records each carried the whole entry fee, and the headline summed gross
 * P/L against net cash.
 *
 * The simulator below does exactly what bot.ts does at each step (debit
 * `round2(premium + fee)`, credit `pack.net`, book through `bookPaperLeg`); it
 * uses the same pure functions, so a change to the booking changes this test's
 * subject, not a copy of it. The source-level test at the bottom pins that
 * bot.ts really does route every paper exit through that one door.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

// Small seeded PRNG so a failure is reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EXITS = ['sl', 'tp', 'trail', 'settle', 'dd', 'repair'] as const;

function simulate(seed: number, positions = 40, initial = 100) {
  const rand = rng(seed);
  let cash = initial;
  const adjust = (d: number) => { cash = r2(cash + d); };
  const trades: any[] = [];
  const open: any[] = [];
  const entryFeeCash = new Map<string, number>();

  for (let i = 0; i < positions; i += 1) {
    const entry = r2(0.15 + rand() * 0.7);
    const premium = r2(1 + rand() * 99);
    const shares = Math.round((premium / entry) * 1000) / 1000;
    const entryFee = takerFeeUsdc(shares, entry, 'crypto');
    const debit = r2(premium + entryFee);
    const pos: any = {
      id: `p${seed}-${i}`, mode: 'paper', slug: `s${i}`, outcome: 'up',
      entryPrice: entry, shares, costBasis: premium, size: premium, entryFee, feesPaid: entryFee,
      ...paperEntryFields(premium, debit),
    };
    adjust(-debit);
    entryFeeCash.set(pos.id, pos.entryFeeRemaining);

    const book = (sell: number, price: number, reason: string) => {
      const pack = closeProceedsWithFee(sell, price, 'crypto', reason);
      const leg = bookPaperLeg({ pos, heldShares: pos.shares, sellShares: sell, proceeds: pack.net, exitFee: pack.fee });
      adjust(pack.net);
      return { leg, pack };
    };

    // Optional partial exit.
    if (rand() < 0.45) {
      const sell = Math.round(pos.shares * (0.3 + rand() * 0.4) * 1000) / 1000;
      const price = r2(0.05 + rand() * 0.94);
      const { leg } = book(sell, price, 'partial');
      trades.push({
        ...pos, ...leg.record, id: `partial-${pos.id}`, shares: sell, exitPrice: price,
        exitReason: 'partial', pnl: leg.pnl, closed: true,
      });
      Object.assign(pos, leg.state);
      pos.shares = Math.round((pos.shares - sell) * 1000) / 1000;
    }

    // Leave some positions open.
    if (rand() < 0.15) { open.push(pos); continue; }

    const reason = EXITS[Math.floor(rand() * EXITS.length)];
    const price = reason === 'settle' ? (rand() < 0.5 ? 1 : 0) : r2(0.02 + rand() * 0.96);
    const { leg, pack } = book(pos.shares, price, reason);
    Object.assign(pos, leg.record, leg.state, { pnl: leg.pnl });
    trades.push({ ...pos, exitPrice: price, exitReason: reason, closed: true });
    // The exit fee is charged on every taker exit and only on those.
    expect(pack.fee > 0).toBe(reason !== 'settle');
  }
  return { cash, trades, open, entryFeeCash };
}

describe('INVARIANT: paper cash reconciles to the penny', () => {
  const seeds = Array.from({ length: 60 }, (_, i) => 1000 + i);

  it('cash equals what the books imply, exactly, for every random history', () => {
    for (const seed of seeds) {
      const { cash, trades, open } = simulate(seed);
      const books = booksCash({ trades, positions: open, initialDeposit: 100, mode: 'paper' });
      expect(books, `seed ${seed}`).toBe(cash);
    }
  });

  it('the headline P/L is cash-based: Σ trade P/L equals the cash change plus what is tied up open', () => {
    for (const seed of seeds) {
      const { cash, trades, open } = simulate(seed);
      const tiedUp = open.reduce((s, p) => s + p.costBasisRemaining + p.entryFeeRemaining, 0);
      const headline = computeTradeStats(trades).totalPnl;
      expect(r2(headline), `seed ${seed}`).toBe(r2(cash - 100 + tiedUp));
    }
  });

  it('a stored leg P/L equals the P/L recomputed from its primitives, and is never gross', () => {
    for (const seed of seeds.slice(0, 20)) {
      const { trades } = simulate(seed);
      for (const t of trades) {
        expect(normalizeTrade(t).pnl).toBe(t.pnl);
        expect(tradeNetPnl(t)).toBe(t.pnl);
      }
    }
  });

  it('fees are counted once per leg: a position\'s entry-fee shares sum to the fee that left cash', () => {
    for (const seed of seeds.slice(0, 20)) {
      const { trades, open, entryFeeCash } = simulate(seed);
      const sums = new Map<string, number>();
      // A position still open holds the rest of its entry fee, not yet in any trade record.
      for (const p of open) sums.set(p.id, p.entryFeeRemaining);
      for (const t of trades) {
        const id = String(t.id).replace(/^partial-/, '');
        sums.set(id, r2((sums.get(id) || 0) + t.entryFeeShare));
        expect(tradeFeesPaid(t)).toBeCloseTo(t.entryFeeShare + t.exitFee, 5);
      }
      for (const [id, total] of sums) expect(total, `seed ${seed} ${id}`).toBe(entryFeeCash.get(id));
    }
  });
});

describe('INVARIANT: split legs sum to the whole, to the cent', () => {
  it('any sequence of partial legs followed by the final leg allocates exactly what was outstanding', () => {
    const rand = rng(42);
    for (let i = 0; i < 500; i += 1) {
      const total = r2(0.01 + rand() * 120);
      const held = Math.round((1 + rand() * 300) * 1000) / 1000;
      let left = total;
      let remainingShares = held;
      let allocated = 0;
      const legs = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < legs; k += 1) {
        const last = k === legs - 1;
        const sell = last ? remainingShares : Math.round(remainingShares * (0.2 + rand() * 0.5) * 1000) / 1000;
        const { share, remaining } = allocateOutstanding(left, remainingShares, sell);
        allocated = r2(allocated + share);
        left = remaining;
        remainingShares = Math.round((remainingShares - sell) * 1000) / 1000;
      }
      expect(allocated, `total ${total} held ${held}`).toBe(total);
      expect(left).toBe(0);
    }
  });
});

describe('INVARIANT: a paper stop fills at the bid the book showed (item 130)', () => {
  const pos = { mode: 'paper', entryPrice: 0.47 };
  const cfg = { slMaxSlippagePct: 2 };

  it('does not floor a gap-through at the stop price', () => {
    // Stop at 6% would floor a clamped fill near 0.4324; the book bid was 0.26.
    expect(resolveSlFillPrice(pos, 0.26, 6, cfg)).toBe(0.26);
  });

  it('never fills above the observed bid, for any bid and stop width', () => {
    for (let bid = 0.02; bid < 0.99; bid += 0.01) {
      for (const sl of [6, 9, 12]) {
        expect(resolveSlFillPrice(pos, bid, sl, cfg)).toBeLessThanOrEqual(Math.round(bid * 1000) / 1000 + 1e-9);
      }
    }
  });

  it('paper and live fill identically', () => {
    expect(resolveSlFillPrice({ ...pos, mode: 'live' }, 0.26, 6, cfg)).toBe(resolveSlFillPrice(pos, 0.26, 6, cfg));
  });
});

describe('INVARIANT: every paper exit moves cash through one door', () => {
  const src = repoFile('src/polymarket/bot.ts');

  it('bot.ts credits or debits paper cash only at the buy and inside bookPaperExit', () => {
    const calls = src.split('\n').filter((l) => l.includes('adjustPaperCash(') && !l.includes('function adjustPaperCash'));
    expect(calls).toHaveLength(2);
    expect(calls.some((l) => l.includes('BUY '))).toBe(true);
    expect(calls.some((l) => l.includes('pack.net'))).toBe(true);
  });

  it('bot.ts no longer carries its own stop-fill clamp', () => {
    expect(src).not.toMatch(/function resolveSlFillPrice/);
  });
});
