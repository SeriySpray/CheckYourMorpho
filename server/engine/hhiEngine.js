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
 * Checks if an allocation points to an idle/cash reserve market: nobody can borrow from it, because either
 * there is no collateral asset or the LLTV is 0 (an unknown LLTV is not treated as 0).
 * @param {object} alloc Allocation record
 * @returns {boolean}
 */
export function isIdleReserveMarket(alloc) {
  const lltvNum = Number(alloc.lltv) || Number(alloc.lltv_percent) || 0;
  const lltvKnown = (alloc.lltv ?? alloc.lltv_percent) != null && (alloc.lltv ?? alloc.lltv_percent) !== '';
  // An absent address field is unknown; a present empty or zero address means the market has no collateral
  const colAddr = alloc.collateral_asset_address == null ? null : alloc.collateral_asset_address.trim().toLowerCase();
  const noCollateralAddress = colAddr !== null && (!colAddr || colAddr === '0x' || colAddr === '0x0000000000000000000000000000000000000000');
  const symbol = (alloc.collateral_asset_symbol || '').trim().toUpperCase();
  return noCollateralAddress || symbol === 'NONE' || symbol === 'IDLE' || (lltvKnown && lltvNum === 0);
}

/**
 * Calculates HHI and collateral concentration metrics for a vault.
 * 
 * @param {object} vault Vault row from database
 * @param {Array<object>} allocations Array of vault allocations joined with markets
 * @returns {object} HHI audit metrics
 */
export function calculateHHI(vault, allocations = []) {
  const totalAssetsUsd = Number(vault.total_assets_usd) || 0;

  // Group allocations by unique collateral asset contract address (with symbol label)
  // Exclude NONE collateral, 0-LLTV markets, and empty collateral addresses (these are idle/cash holding markets)
  const collateralMap = new Map();
  let totalActiveCollateralUsd = 0;
  let idleAllocationsUsd = 0;

  for (const alloc of allocations) {
    const colAddr = (alloc.collateral_asset_address || '').trim().toLowerCase();
    const symbol = (alloc.collateral_asset_symbol || 'UNKNOWN').trim().toUpperCase();
    const supplyUsd = Number(alloc.supply_assets_usd) || 0;

    // Check if this market has active collateral backing
    const isIdle = isIdleReserveMarket(alloc);

    if (isIdle) {
      idleAllocationsUsd += supplyUsd;
    } else if (supplyUsd > 0) {
      const key = colAddr || symbol;
      if (!collateralMap.has(key)) {
        collateralMap.set(key, { symbol, usd: 0 });
      }
      collateralMap.get(key).usd += supplyUsd;
      totalActiveCollateralUsd += supplyUsd;
    }
  }

  // Materiality threshold: at least 1.0% of total vault capital must be deployed into active collateral
  const minMaterialThresholdUsd = totalAssetsUsd * 0.01;

  // If there is no material active collateral backing (< 1.0% of TVL, 100% idle cash or empty vault)
  if (totalAssetsUsd <= 0 || totalActiveCollateralUsd < minMaterialThresholdUsd || collateralMap.size === 0) {
    return {
      hhi: 0,
      effectiveAssets: 0,
      tier: 'UNALLOCATED',
      tierLabel: 'N/A',
      isExtremeConcentration: false,
      topCollateral: {
        symbol: 'None',
        sharePercent: 0,
        usd: 0
      },
      breakdown: []
    };
  }

  let hhiSum = 0;
  const breakdown = [];

  // HHI is calculated across the active collateral portfolio:
  // c_k = collateral_usd_k / totalActiveCollateralUsd
  // HHI = sum(c_k^2)
  for (const item of collateralMap.values()) {
    const usd = item.usd;
    const symbol = item.symbol;
    const collateralShare = Math.max(0, Math.min(1.0, usd / totalActiveCollateralUsd));
    hhiSum += collateralShare * collateralShare;

    // In breakdown, show the fraction of total vault capital (TVL)
    const tvlShare = Math.max(0, Math.min(1.0, usd / totalAssetsUsd));
    const sharePercent = Math.round(tvlShare * 1000) / 10;
    if (usd >= 0.01 || sharePercent > 0) {
      breakdown.push({
        symbol,
        usd: Math.round(usd * 100) / 100,
        sharePercent
      });
    }
  }

  // Top collateral asset by USD volume
  const sortedCollateral = [...collateralMap.values()].sort((a, b) => b.usd - a.usd);
  const topCollatSymbol = sortedCollateral[0]?.symbol || 'Unknown';
  const topCollatUsd = sortedCollateral[0]?.usd || 0;
  // Пороги tier порівнюються з точними значеннями; округлені (hhi, sharePercent) лише для відповіді
  const topCollatShareRaw = Math.max(0, Math.min(100, (topCollatUsd / totalAssetsUsd) * 100));
  const topCollatShare = Math.round(topCollatShareRaw * 10) / 10;

  // Sort breakdown descending by share of vault capital
  breakdown.sort((a, b) => b.sharePercent - a.sharePercent);

  const hhiRaw = Math.min(1.0, Math.max(0, hhiSum));
  const hhi = Math.round(hhiRaw * 1000) / 1000;
  const effectiveAssets = hhi > 0 ? Math.round((1 / hhi) * 10) / 10 : 0;
  // Measured against known capital: exposure behind unresolved V2 adapters is not cash
  const knownAssetsUsd = totalAssetsUsd - Math.max(0, Number(vault.unresolved_exposure_usd) || 0);
  const activeCollateralExposure = knownAssetsUsd > 0 ? totalActiveCollateralUsd / knownAssetsUsd : 1;

  // Determine concentration tier taking into account both internal collateral distribution
  // and overall portfolio exposure (to prevent false critical alarms when vault is 70%+ cash)
  let tier = 'DIVERSIFIED';
  let tierLabel = 'High Diversification';

  if (activeCollateralExposure < 0.30) {
    // Very low active collateral exposure (e.g. >70% cash reserves)
    tier = 'DIVERSIFIED';
    tierLabel = 'Low Exposure (High Cash)';
  } else if (hhiRaw > 0.50 && topCollatShareRaw >= 40) {
    tier = 'EXTREME';
    tierLabel = 'Critical Concentration';
  } else if ((hhiRaw > 0.50 && topCollatShareRaw >= 20) || (hhiRaw >= 0.25 && topCollatShareRaw >= 20)) {
    tier = 'CONCENTRATED';
    tierLabel = 'High Concentration';
  } else if (hhiRaw >= 0.15 && topCollatShareRaw >= 10) {
    tier = 'MODERATE';
    tierLabel = 'Moderate Concentration';
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
    activeCollateralExposure: Math.round(activeCollateralExposure * 1000) / 10,
    isExtremeConcentration: tier === 'EXTREME',
    topCollateral,
    breakdown
  };
}
