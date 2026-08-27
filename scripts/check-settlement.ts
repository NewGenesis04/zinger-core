// @ts-nocheck
import { createPublicClient, http, getAddress } from 'viem';
import { polygon } from 'viem/chains';
import { getWallet } from '../src/lib/wallet.js';
import { getTradingClient } from '../src/polymarket/trade.js';

import 'dotenv/config';
import { checkReadiness } from '../src/polymarket/readiness.js';

const conditionId = process.argv[2];
if (conditionId === 'auth' || !conditionId) {
  const w = getWallet();
  console.log('==========================================');
  console.log('  🔍 LOCAL AUTHENTICATION & READINESS AUDIT');
  console.log('==========================================\n');
  console.log('• Signer Address:       ', w.address);
  console.log('• Deposit Safe:         ', w.polymarketDepositWallet || '(none)');
  console.log('• Instance:             ', w.instance);

  const res = await checkReadiness();
  console.log('\n• Spendable Balance:     $' + (res.spendableBalance || 0).toFixed(2));
  console.log('• Deposit pUSD:          $' + (res.depositPusd || 0).toFixed(2));
  console.log('\nIndividual Security Checks:');
  for (const c of res.checks || []) {
    console.log(`  [${c.ok ? '✅ PASS' : '❌ FAIL'}] ${c.id.padEnd(16)}: ${c.detail}`);
  }
  console.log('\n==========================================\n');
  process.exit(0);
}

const client = createPublicClient({
  chain: polygon,
  transport: http('https://polygon-bor.publicnode.com', { timeout: 15000 }),
});

const CONDITIONAL_TOKENS = getAddress('0x4D97DCd97eC945f40cF65F87097ACe5EA0476045');
const CLOB = await getTradingClient();

// Check CLOB balance first
const bal = await CLOB.getBalanceAllowance({ asset_type: 'COLLATERAL' });
console.log('CLOB balance:', (Number(bal.balance || 0) / 1e6).toFixed(2));

// Check if condition exists on-chain
try {
  const result = await client.call({
    to: CONDITIONAL_TOKENS,
    data: '0x2934a0ee' + conditionId.slice(2).padStart(64, '0'),
  });
  if (result?.data && result.data !== '0x' && result.data.length > 138) {
    const payout = BigInt('0x' + result.data.slice(-64));
    if (payout > 0n) {
      console.log('✅ Condition resolved! Payout available.');
      process.exit(0);
    }
  }
  console.log('⏳ Condition not yet on-chain');
  process.exit(1);
} catch {
  console.log('⏳ Condition not yet on-chain');
  process.exit(1);
}
