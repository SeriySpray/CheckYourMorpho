/**
 * Liquidity & Exit Capacity Engine
 * Calculates the exact amount and percentage of vault capital available for immediate withdrawal.
 * 
 * Total Available Exit = Direct Idle Cash + sum(min(Vault Supply in Market_i, Free Liquidity in Market_i))
 * Instant Exit Capacity % = (Total Available Exit / Total Vault Assets) * 100%
 */

/**
 * Calculates exit liquidity metrics for a vault.
 * 
 * @param {object} vault Vault row from database
 * @param {Array<object>} allocations Array of vault allocations joined with market data
 * @returns {object} Liquidity analytics
 */
export function calculateLiquidityMetrics(vault, allocations = []) {
  const totalAssetsUsd = Number(vault.total_assets_usd) || 0;
  const directLiquidityUsd = Number(vault.liquidity_usd) || 0;

  if (totalAssetsUsd <= 0) {
    return {
      directLiquidityUsd: 0,
      marketExitCapacityUsd: 0,
      instantExitCapacityUsd: 0,
      instantExitCapacityPercent: 100,
      isIlliquid: false
    };
  }

  let totalMarketAvailableUsd = 0;

  for (const alloc of allocations) {
    const supplyUsd = Number(alloc.supply_assets_usd) || 0;
    const marketTotalSupplyUsd = Number(alloc.total_supply_assets_usd) || 0;
    const marketTotalBorrowUsd = Number(alloc.total_borrow_assets_usd) || 0;
    const marketFreeLiquidityUsd = Math.max(0, marketTotalSupplyUsd - marketTotalBorrowUsd);

    // Instant exit from this market: can withdraw up to vault supply OR market free cash
    const canExitUsd = Math.min(supplyUsd, marketFreeLiquidityUsd);
    totalMarketAvailableUsd += canExitUsd;
  }

  // Combined exit capacity = direct unallocated cash + market free cash
  const totalEffectiveExitUsd = Math.min(totalAssetsUsd, directLiquidityUsd + totalMarketAvailableUsd);
  const instantExitCapacityPercent = Math.min(100, Math.max(0, Math.round((totalEffectiveExitUsd / totalAssetsUsd) * 1000) / 10));

  return {
    directLiquidityUsd: Math.round(directLiquidityUsd * 100) / 100,
    marketExitCapacityUsd: Math.round(totalMarketAvailableUsd * 100) / 100,
    instantExitCapacityUsd: Math.round(totalEffectiveExitUsd * 100) / 100,
    instantExitCapacityPercent,
    isIlliquid: instantExitCapacityPercent < 20
  };
}
