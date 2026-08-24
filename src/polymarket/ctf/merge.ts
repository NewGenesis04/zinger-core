// @ts-nocheck
import { getAddress, parseUnits, parseAbi } from 'viem';

export const CTF_ADDRESS = getAddress('0x4D97DCd97eC945f40cF65F87097ACe5EA0476045');
export const DEFAULT_COLLATERAL_USDC = getAddress('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'); // USDC.e on Polygon
export const ZERO_PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';

export const CTF_ABI = parseAbi([
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount) external',
]);

/**
 * Formats parameters for Gnosis Conditional Tokens mergePositions() call.
 */
export function formatCtfMergeParams({
  conditionId,
  shares,
  collateralToken = DEFAULT_COLLATERAL_USDC,
  parentCollectionId = ZERO_PARENT_COLLECTION_ID,
}) {
  const cleanConditionId = String(conditionId).startsWith('0x')
    ? String(conditionId)
    : `0x${conditionId}`;

  // Polymarket binary markets use partition [1, 2] (1 << 0 and 1 << 1)
  const partition = [1n, 2n];

  // Polymarket CTF shares use 6 decimals (matching USDC)
  const safeShares = Number(shares) || 0;
  const amount = parseUnits(safeShares.toFixed(6), 6);

  return {
    ctfAddress: CTF_ADDRESS,
    collateralToken: getAddress(collateralToken),
    parentCollectionId,
    conditionId: cleanConditionId,
    partition,
    amount,
  };
}

/**
 * Executes on-chain mergePositions() transaction to instantly burn complementary
 * binary tokens and reclaim full 1.00 USDC collateral.
 */
export async function executeCtfMerge({
  conditionId,
  shares,
  collateralToken = DEFAULT_COLLATERAL_USDC,
  walletClient,
  publicClient,
}) {
  if (!walletClient) {
    return { ok: false, error: 'walletClient required for on-chain CTF merge' };
  }

  try {
    const params = formatCtfMergeParams({ conditionId, shares, collateralToken });

    const txHash = await walletClient.writeContract({
      address: params.ctfAddress,
      abi: CTF_ABI,
      functionName: 'mergePositions',
      args: [
        params.collateralToken,
        params.parentCollectionId,
        params.conditionId,
        params.partition,
        params.amount,
      ],
      account: walletClient.account,
    });

    if (publicClient && typeof publicClient.waitForTransactionReceipt === 'function') {
      await publicClient.waitForTransactionReceipt({ hash: txHash });
    }

    return {
      ok: true,
      txHash,
      shares,
      amount: params.amount,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
    };
  }
}
