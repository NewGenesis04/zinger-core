// @ts-nocheck
import { positionWindowEndMs } from '../positions/settle.js';

export async function settlePaperOrphans(positions, { executeSell, log } = {}) {
  if (!Array.isArray(positions) || typeof executeSell !== 'function') return { settled: 0 };
  const nowMs = Date.now();
  let settledCount = 0;

  for (const pos of [...positions]) {
    if (pos.closed || pos.mode !== 'paper') continue;
    const windowEndMs = positionWindowEndMs(pos);
    if (windowEndMs == null || nowMs < windowEndMs + 5000) continue;

    try {
      const result = await executeSell(pos, 'settle');
      if (result?.ok) {
        settledCount += 1;
        if (typeof log === 'function') {
          const pnlTxt = `${(pos.pnl || 0) >= 0 ? '+' : ''}$${Math.abs(pos.pnl || 0).toFixed(2)}`;
          log(
            `🏁 PAPER ORPHAN SETTLE ${pos.symbol} ${String(pos.outcome || '').toUpperCase()} · ${pnlTxt} · ${pos.slug}`,
            (pos.pnl || 0) >= 0 ? 'tp' : 'sl',
            { market: pos.symbol, slug: pos.slug, outcome: pos.outcome, pnl: pos.pnl, exitPrice: pos.exitPrice },
          );
        }
      }
    } catch (err) {
      if (typeof log === 'function') {
        log(`⚠️ Orphan settle failed ${pos.slug}: ${String(err?.message || err).slice(0, 120)}`, 'error');
      }
    }
  }

  return { settled: settledCount };
}
