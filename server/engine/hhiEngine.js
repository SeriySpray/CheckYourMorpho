/**
 * Herfindahl-Hirschman Index (HHI) Concentration Engine
 * Evaluates portfolio diversification across underlying collateral assets.
 * 
 * Formula:
 * HHI = sum_{k=1}^M (c_k)^2
 * 
 * where c_k is the fraction of total vault capital backed by collateral asset k.
 * 
 * Standards:
 * - HHI < 0.15: DIVERSIFIED (High diversification)
 * - 0.15 <= HHI < 0.25: MODERATE (Moderate concentration)
 * - 0.25 <= HHI <= 0.50: CONCENTRATED (High concentration)
 * - HHI > 0.50: EXTREME (Single Point of Failure / Tail risk)
 */

/**
 * Calculates HHI and collateral concentration metrics for a vault.
 * 
 * @param {object} vault Vault row from database
 * @param {Array<object>} allocations Array of vault allocations joined with markets
 * @returns {object} HHI audit metrics
 */
export function calculateHHI(vault, allocations = []) {
  const totalAssetsUsd = Number(vault.total_assets_usd) || 0;
  const directLiquidityUsd = Number(vault.liquidity_usd) || 0;

  // Group allocations by unique collateral asset symbol
  // Exclude NONE collateral, 0-LLTV markets, and empty collateral addresses (these are idle/cash holding markets)
  const collateralMap = new Map();
  let totalActiveCollateralUsd = 0;
  let idleAllocationsUsd = 0;

  for (const alloc of allocations) {
    const symbol = (alloc.collateral_asset_symbol || '').trim().toUpperCase();
    const lltvNum = Number(alloc.lltv) || Number(alloc.lltv_percent) || 0;
    const supplyUsd = Number(alloc.supply_assets_usd) || 0;

    // Check if this market has active collateral backing
    const isIdleMarket = !symbol || symbol === 'NONE' || lltvNum === 0 || !alloc.collateral_asset_address || alloc.collateral_asset_address === '0x0000000000000000000000000000000000000000';

    if (isIdleMarket) {
      idleAllocationsUsd += supplyUsd;
    } else if (supplyUsd > 0) {
      const current = collateralMap.get(symbol) || 0;
      collateralMap.set(symbol, current + supplyUsd);
      totalActiveCollateralUsd += supplyUsd;
    }
  }

  // Any vault capital not deployed into active collateral is unallocated cash / idle reserve
  const unallocatedCashUsd = Math.max(0, totalAssetsUsd - totalActiveCollateralUsd);

  // If there is no active collateral backing at all (100% idle cash or empty vault)
  if (totalAssetsUsd <= 0 || totalActiveCollateralUsd <= 0 || collateralMap.size === 0) {
    return {
      hhi: 0,
      effectiveAssets: 0,
      tier: 'UNALLOCATED',
      tierLabel: 'Немає застави (100% кеш)',
      isExtremeConcentration: false,
      topCollateral: {
        symbol: 'CASH (UNALLOCATED)',
        sharePercent: 100,
        usd: Math.max(0, Math.round(totalAssetsUsd * 100) / 100)
      },
      breakdown: [
        {
          symbol: 'CASH (UNALLOCATED)',
          usd: Math.max(0, Math.round(totalAssetsUsd * 100) / 100),
          sharePercent: 100
        }
      ]
    };
  }

  let hhiSum = 0;
  const breakdown = [];

  // HHI is calculated across the active collateral portfolio:
  // c_k = collateral_usd_k / totalActiveCollateralUsd
  // HHI = sum(c_k^2)
  for (const [symbol, usd] of collateralMap.entries()) {
    const collateralShare = Math.max(0, Math.min(1.0, usd / totalActiveCollateralUsd));
    hhiSum += collateralShare * collateralShare;

    // In breakdown, show the fraction of total vault capital (TVL)
    const tvlShare = Math.max(0, Math.min(1.0, usd / totalAssetsUsd));
    breakdown.push({
      symbol,
      usd: Math.round(usd * 100) / 100,
      sharePercent: Math.round(tvlShare * 1000) / 10
    });
  }

  // Top collateral asset by USD volume
  const sortedCollateral = [...collateralMap.entries()].sort((a, b) => b[1] - a[1]);
  const topCollatSymbol = sortedCollateral[0][0];
  const topCollatUsd = sortedCollateral[0][1];
  const topCollatShare = Math.max(0, Math.min(100, Math.round((topCollatUsd / totalAssetsUsd) * 1000) / 10));

  // If there is cash or idle buffer, add CASH (UNALLOCATED) to breakdown
  const cashShare = Math.max(0, Math.min(1.0, unallocatedCashUsd / totalAssetsUsd));
  if (cashShare > 0.005) {
    breakdown.push({
      symbol: 'CASH (UNALLOCATED)',
      usd: Math.round(unallocatedCashUsd * 100) / 100,
      sharePercent: Math.round(cashShare * 1000) / 10
    });
  }

  // Sort breakdown descending by share of vault capital
  breakdown.sort((a, b) => b.sharePercent - a.sharePercent);

  const hhi = Math.min(1.0, Math.max(0, Math.round(hhiSum * 1000) / 1000));
  const effectiveAssets = hhi > 0 ? Math.round((1 / hhi) * 10) / 10 : 0;

  // Determine concentration tier
  let tier = 'DIVERSIFIED';
  let tierLabel = 'Висока диверсифікація';

  if (hhi > 0.50) {
    tier = 'EXTREME';
    tierLabel = 'Критична концентрація (SPOF)';
  } else if (hhi >= 0.25) {
    tier = 'CONCENTRATED';
    tierLabel = 'Висока концентрація';
  } else if (hhi >= 0.15) {
    tier = 'MODERATE';
    tierLabel = 'Помірна концентрація';
  }

  const topCollateral = {
    symbol: topCollatSymbol,
    usd: Math.round(topCollatUsd * 100) / 100,
    sharePercent: topCollatShare
  };

  return {
    hhi,
    effectiveAssets,
    tier,
    tierLabel,
    isExtremeConcentration: hhi > 0.50,
    topCollateral,
    breakdown
  };
}
