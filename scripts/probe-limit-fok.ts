// @ts-nocheck
/**
 * Zero-cost live venue probe for Item 78.
 *
 * Tests whether Polymarket's CLOB backend honours `OrderType.FOK` on a limit order
 * or silently downgrades it to a resting `GTC` bid.
 *
 * Sizing: 100 shares @ $0.01 = $1.00 notional (satisfies the $1.00 minimum notional floor).
 * Market condition: Placed far below best ask (unmatchable), so $0.00 is spent.
 *
 * Usage:
 *   npx tsx scripts/probe-limit-fok.ts [optionalTokenId]
 */
import 'dotenv/config';
import { getWallet } from '../src/lib/wallet.js';
import { getTradingClient, placeLimitFokBuy, cancelOrder } from '../src/polymarket/trade.js';
import { getOrderBook } from '../src/polymarket/clob.js';

console.log('════════════════════════════════════════════════════════════════════');
console.log('       🎯 ITEM 78 ZERO-COST LIVE VENUE PROBE (LIMIT + FOK)          ');
console.log('════════════════════════════════════════════════════════════════════\n');

const wallet = getWallet();
if (!wallet?.privateKey) {
  console.error('❌ Error: No wallet private key found in environment.');
  process.exit(1);
}

console.log(`• Signer Address: ${wallet.address}`);
console.log(`• Safe / Deposit: ${wallet.polymarketDepositWallet || '(None - Signer EOA)'}`);

// 1. Resolve Target Token ID
let targetTokenId = process.argv[2];
let targetMarketName = 'Manual Token';

if (!targetTokenId) {
  console.log('\n🔍 Discovering active binary market on Polymarket...');
  try {
    const res = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=15');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const markets = await res.json();
    const candidate = markets.find((m) => {
      if (!m.acceptingOrders || !m.clobTokenIds) return false;
      try {
        const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        return Array.isArray(tokens) && tokens.length === 2;
      } catch {
        return false;
      }
    });

    if (candidate) {
      const tokens = typeof candidate.clobTokenIds === 'string' ? JSON.parse(candidate.clobTokenIds) : candidate.clobTokenIds;
      targetTokenId = tokens[0];
      targetMarketName = candidate.question || candidate.slug || targetTokenId;
      console.log(`✅ Selected market: "${targetMarketName}"`);
      console.log(`• Token ID: ${targetTokenId}`);
    }
  } catch (err) {
    console.warn(`⚠️ Gamma API discovery failed: ${err.message}`);
  }
}

if (!targetTokenId) {
  console.error('❌ Error: Could not automatically discover a market. Pass a token ID:');
  console.error('   npx tsx scripts/probe-limit-fok.ts <tokenId>');
  process.exit(1);
}

// 2. Fetch current book to verify safety
console.log('\n📖 Inspecting orderbook depth to ensure order cannot match...');
const book = await getOrderBook(targetTokenId);
const bestAsk = Number(book?.asks?.[0]?.price || 0.50);
const bestBid = Number(book?.bids?.[0]?.price || 0.00);

console.log(`• Current Best Bid: $${bestBid.toFixed(2)}`);
console.log(`• Current Best Ask: $${bestAsk.toFixed(2)}`);

// Probe parameters: 100 shares @ $0.01 = $1.00 notional
const probePrice = 0.01;
const probeShares = 100;
const probeNotional = probePrice * probeShares;

if (bestAsk <= probePrice) {
  console.error(`❌ Abort: Best ask is $${bestAsk} <= probe price $${probePrice}. Safety check failed.`);
  process.exit(1);
}

console.log(`\n🛡️ Safety Check Passed: Best ask ($${bestAsk.toFixed(2)}) is well above probe price ($${probePrice.toFixed(2)}).`);
console.log(`• Order Spec: BUY ${probeShares} shares @ $${probePrice.toFixed(2)} (Notional: $${probeNotional.toFixed(2)})`);
console.log(`• Order Type: Limit + OrderType.FOK`);
console.log('\n🚀 Dispatching probe order to CLOB...\n');

const client = await getTradingClient();

try {
  const result = await placeLimitFokBuy({
    tokenId: targetTokenId,
    shares: probeShares,
    maxPrice: probePrice,
    minNotionalUsd: 1,
  });

  console.log('📡 Response received:', JSON.stringify(result, null, 2));

  if (result.resting) {
    console.log('\n⚠️ ORDER RESTS ON THE BOOK!');
    console.log(`🚨 Cancelling order ${result.id} immediately...`);
    try {
      await cancelOrder(result.id);
      console.log(`✅ Order ${result.id} cancelled successfully.`);
    } catch (cErr) {
      console.error(`❌ Failed to cancel order ${result.id}: ${cErr.message}`);
    }

    console.log('\n════════════════════════════════════════════════════════════════════');
    console.log('❌ VERDICT: DOWNGRADED_TO_GTC');
    console.log('Polymarket silently downgraded FOK on a limit order to a resting GTC bid.');
    console.log('DO NOT enable arbExactShareRouting: true. Keep it gated OFF.');
    console.log('════════════════════════════════════════════════════════════════════\n');
    process.exit(0);
  }

  // If result returned with 0 filled shares and not resting
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('✅ VERDICT: HONORED');
  console.log('Polymarket accepted the order and killed it immediately as FOK without resting.');
  console.log('Safe to enable arbExactShareRouting: true!');
  console.log('════════════════════════════════════════════════════════════════════\n');
} catch (err: any) {
  console.log('📡 Response received (thrown):', err.message);
  if (err.venueError) console.log(`• Raw Venue Error: "${err.venueError}"`);
  if (err.orderId) console.log(`• Associated Order ID: ${err.orderId}`);

  const msg = (err.venueError || err.message || '').toLowerCase();

  // If order was rejected because it couldn't fill immediately (classic FOK kill)
  if (
    msg.includes('kill') ||
    msg.includes('could not be filled') ||
    msg.includes('unfilled') ||
    msg.includes('match') ||
    msg.includes('canceled')
  ) {
    console.log('\n════════════════════════════════════════════════════════════════════');
    console.log('✅ VERDICT: HONORED');
    console.log(`The exchange acknowledged FOK and killed the order: "${err.venueError || err.message}"`);
    console.log('Safe to enable arbExactShareRouting: true!');
    console.log('════════════════════════════════════════════════════════════════════\n');
  } else if (msg.includes('unsupported') || msg.includes('invalid ordertype') || msg.includes('order type')) {
    console.log('\n════════════════════════════════════════════════════════════════════');
    console.log('⚠️ VERDICT: REJECTED_UNSUPPORTED');
    console.log(`The exchange does not support FOK on limit orders: "${err.venueError || err.message}"`);
    console.log('DO NOT enable arbExactShareRouting: true.');
    console.log('════════════════════════════════════════════════════════════════════\n');
  } else {
    console.log('\n════════════════════════════════════════════════════════════════════');
    console.log(`❓ VERDICT: AMBIGUOUS (${err.venueError || err.message})`);
    console.log('Inspect raw error above to determine venue behavior.');
    console.log('════════════════════════════════════════════════════════════════════\n');
  }
}
