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

  if (totalAssetsUsd <= 0 || allocations.length === 0) {
    return {
      hhi: 0,
      effectiveAssets: 0,
      tier: 'DIVERSIFIED',
      tierLabel: 'Висока диверсифікація',
      isExtremeConcentration: false,
      topCollateral: { symbol: 'None', sharePercent: 0, usd: 0 },
      breakdown: []
    };
  }

  // Group allocations by unique collateral asset symbol
  const collateralMap = new Map();

  for (const alloc of allocations) {
    const symbol = (alloc.collateral_asset_symbol || 'None').trim().toUpperCase();
    const supplyUsd = Number(alloc.supply_assets_usd) || 0;

    const current = collateralMap.get(symbol) || 0;
    collateralMap.set(symbol, current + supplyUsd);
  }

  let hhiSum = 0;
  const breakdown = [];

  for (const [symbol, usd] of collateralMap.entries()) {
    const share = Math.max(0, Math.min(1.0, usd / totalAssetsUsd));
    hhiSum += share * share;

    breakdown.push({
      symbol,
      usd: Math.round(usd * 100) / 100,
      sharePercent: Math.round(share * 1000) / 10
    });
  }

  // Sort breakdown descending by share
  breakdown.sort((a, b) => b.sharePercent - a.sharePercent);

  // If there is significant cash, also track it in the breakdown
  const cashShare = Math.max(0, Math.min(1.0, directLiquidityUsd / totalAssetsUsd));
  if (cashShare > 0.01) {
    breakdown.push({
      symbol: 'CASH (UNALLOCATED)',
      usd: Math.round(directLiquidityUsd * 100) / 100,
      sharePercent: Math.round(cashShare * 1000) / 10
    });
  }

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

  const topCollateral = breakdown[0] || { symbol: 'None', sharePercent: 0, usd: 0 };

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
