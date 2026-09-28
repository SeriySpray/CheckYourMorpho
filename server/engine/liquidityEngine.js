/**
 * Calculates liquidity and exit capacity metrics for a vault and its allocations.
 * 
 * @param {object} vault
 * @param {Array<object>} allocations Array of vault allocations joined with market data
 * @returns {object} Liquidity analytics
 */
export function calculateLiquidityMetrics(vault, allocations = []) {
  const totalAssetsUsd = Number(vault.total_assets_usd) || 0;
  const directLiquidityUsd = Number(vault.liquidity_usd) || 0;

  if (totalAssetsUsd === 0) {
    return {
      directLiquidityUsd: 0,
      liquidityCoverageRatio: 1.0,
      instantExitCapacityUsd: 0,
      instantExitCapacityPercent: 100,
      maxMarketDominancePercent: 0,
      weightedMarketDominancePercent: 0,
      concentratedMarketsCount: 0,
      isIlliquid: false
    };
  }

  // Liquidity Coverage Ratio (LCR): direct cash / total deposits
  const liquidityCoverageRatio = Math.min(1.0, directLiquidityUsd / totalAssetsUsd);

  let totalAvailableExitUsd = 0;
  let maxMarketDominance = 0;
  let weightedDominanceSum = 0;
  let concentratedMarketsCount = 0;

  for (const alloc of allocations) {
    const supplyUsd = Number(alloc.supply_assets_usd) || 0;
    const marketTotalSupplyUsd = Number(alloc.total_supply_assets_usd) || 0;
    const marketTotalBorrowUsd = Number(alloc.total_borrow_assets_usd) || 0;
    const marketFreeLiquidityUsd = Math.max(0, marketTotalSupplyUsd - marketTotalBorrowUsd);

    // Instant exit from this market: can withdraw up to what vault has supplied OR what market has free
    const canExitUsd = Math.min(supplyUsd, marketFreeLiquidityUsd);
    totalAvailableExitUsd += canExitUsd;

    // Vault Dominance in this market
    if (marketTotalSupplyUsd > 0) {
      const dominance = (supplyUsd / marketTotalSupplyUsd) * 100;
      if (dominance > maxMarketDominance) {
        maxMarketDominance = dominance;
      }
      if (dominance >= 50) {
        concentratedMarketsCount++;
      }
      const weight = supplyUsd / totalAssetsUsd;
      weightedDominanceSum += dominance * weight;
    }
  }

  // If vault has unallocated cash (direct liquidity), add it to exit capacity
  const totalEffectiveExitUsd = Math.min(totalAssetsUsd, Math.max(directLiquidityUsd, totalAvailableExitUsd));
  const instantExitCapacityPercent = Math.min(100, Math.round((totalEffectiveExitUsd / totalAssetsUsd) * 1000) / 10);

  return {
    directLiquidityUsd: Math.round(directLiquidityUsd * 100) / 100,
    liquidityCoverageRatio: Math.round(liquidityCoverageRatio * 1000) / 1000,
    instantExitCapacityUsd: Math.round(totalEffectiveExitUsd * 100) / 100,
    instantExitCapacityPercent,
    maxMarketDominancePercent: Math.round(maxMarketDominance * 10) / 10,
    weightedMarketDominancePercent: Math.round(weightedDominanceSum * 10) / 10,
    concentratedMarketsCount,
    isIlliquid: instantExitCapacityPercent < 25
  };
}
