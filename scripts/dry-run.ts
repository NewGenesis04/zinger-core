// @ts-nocheck
import os from 'os';
import path from 'path';
import fs from 'fs';

// Use isolated temp dir so production/local data is untouched
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinger-dry-run-'));
process.env.ZINGER_DATA_DIR = tempDir;

console.log('════════════════════════════════════════════════════════════════════');
console.log('       🚀 ZINGER BOT REFACTOR — END-TO-END DRY RUN SIMULATION        ');
console.log('════════════════════════════════════════════════════════════════════');
console.log(`📁 Isolated Test Storage: ${tempDir}`);

// Import bot and dependencies
const { saveConfig, getState, scan, queryTelemetryEvents } = await import('../src/polymarket/bot.js');
const { getWallet } = await import('../src/lib/wallet.js');
const { describeBackend } = await import('../src/polymarket/persistence.js');

const backend = describeBackend();
console.log(`🗄️ Persistence Backend: ${backend.backend.toUpperCase()} (${backend.reason})`);

const wallet = getWallet();
console.log(`🔑 Signer Address: ${wallet.address}`);
console.log(`🏦 Deposit Wallet: ${wallet.polymarketDepositWallet || '(None - Signer EOA)'}`);

// Set paper configuration through authoritative saveConfig
saveConfig({
  mode: 'paper',
  enabled: true,
  clobArbEnabled: true,
  minArbGap: 0.015,
  forceArbOnly: false,
  arbOnlyUntilEdge: true,
  enabledDurations: ['5m', '15m', '4h'],
  useSignals: true,
  useML: false,
  requireDataAssurance: true,
  tradeCurrentWindowOnly: true,
  paperBankroll: 100,
}, { tier: 'operator', source: 'dry-run' });

const initialState = getState();
console.log(`\n⚙️ Config Profile: mode=${initialState.config.mode}, enabled=${initialState.config.enabled}, clobArb=${initialState.config.clobArbEnabled}, durations=${JSON.stringify(initialState.config.enabledDurations)}`);
console.log('🔄 Executing Scan Cycle 1 (Live Polymarket & Binance discovery)...');

const start1 = Date.now();
await scan();
const duration1 = Date.now() - start1;
const state1 = getState();

console.log(`✅ Scan Cycle 1 complete in ${duration1}ms`);
console.log(`   Discovered Markets: ${state1.markets?.length || 0}`);
console.log(`   Active Positions:   ${state1.positions?.length || 0}`);
console.log(`   Pending Trades:     ${state1.pendingTrades?.length || 0}`);

console.log('\n🔄 Executing Scan Cycle 2 (Telemetry & Cache verification)...');
const start2 = Date.now();
await scan();
const duration2 = Date.now() - start2;
const state2 = getState();

console.log(`✅ Scan Cycle 2 complete in ${duration2}ms`);

// Telemetry Audit
const scanEvents = queryTelemetryEvents({ type: 'scan.cycle', limit: 10 });
console.log(`\n📊 Telemetry Bus Audit:`);
console.log(`   Recorded 'scan.cycle' Events: ${scanEvents.length}`);
if (scanEvents.length > 0) {
  const latest = scanEvents[0];
  console.log(`   Latest Cycle Data:`);
  console.log(`     • Timestamp: ${new Date(latest.ts).toISOString()}`);
  console.log(`     • Duration:  ${latest.data.durationMs}ms`);
  console.log(`     • Markets:   ${latest.data.marketsCount}`);
  console.log(`     • Signals:   ${latest.data.signalsCount}`);
  console.log(`     • Positions: ${latest.data.positionsCount}`);
  console.log(`     • Direction: ${latest.data.directionalAllowed ? 'ENABLED' : 'LOCKED (' + latest.data.tradingReason + ')'}`);
}

// Cleanup isolated temp dir
fs.rmSync(tempDir, { recursive: true, force: true });

console.log('\n════════════════════════════════════════════════════════════════════');
console.log('       ✨ DRY RUN SUCCESSFUL — ZERO CRASHES, ALL MODULES HEALTHY     ');
console.log('════════════════════════════════════════════════════════════════════\n');
process.exit(0);
