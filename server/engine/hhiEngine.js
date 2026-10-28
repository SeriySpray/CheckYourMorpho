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
 *
 * Shares are measured against the verified capital: what sits behind adapters that could not be expanded is
 * unknown, so it is left out of the base and reported as unverifiedPercent instead of diluting every share.
 */

// Wrappers of one underlying fail together (a BTC or ETH depeg hits all of them), so they count as one asset
const UNDERLYING_FAMILIES = {
  ETH: ['ETH', 'WETH', 'STETH', 'WSTETH', 'WEETH', 'EETH', 'RETH', 'CBETH', 'EZETH', 'RSETH', 'OSETH', 'WRSETH', 'PUFETH', 'SWETH', 'ETHX', 'METH', 'LSETH', 'WEETHS'],
  BTC: ['WBTC', 'CBBTC', 'KBTC', 'BTC.B', 'TBTC', 'LBTC', 'SOLVBTC', 'SOLVBTC.BBN', 'XSOLVBTC', 'FBTC', 'UNIBTC', 'EBTC', 'MBTC']
};
const FAMILY_BY_SYMBOL = new Map(Object.entries(UNDERLYING_FAMILIES).flatMap(([family, symbols]) => symbols.map(sym => [sym, family])));

/**
 * Checks if an allocation points to an idle/cash reserve market: nobody can borrow from it, because either
 * there is no collateral asset or the LLTV is 0 (an unknown LLTV is not treated as 0).
 * @param {object} alloc Allocation record
 * @returns {boolean}
 */
export function isIdleReserveMarket(alloc) {
  const lltvNum = Number(alloc.lltv) || Number(alloc.lltv_percent) || 0;
  const lltvRaw = alloc.lltv ?? alloc.lltv_percent;
  const lltvKnown = lltvRaw != null && lltvRaw !== '' && Number.isFinite(Number(lltvRaw));
  // An absent address field is unknown; a present empty or zero address means the market has no collateral
  const colAddr = alloc.collateral_asset_address == null ? null : alloc.collateral_asset_address.trim().toLowerCase();
  const noCollateralAddress = colAddr !== null && (!colAddr || colAddr === '0x' || colAddr === '0x0000000000000000000000000000000000000000');
  const symbol = (alloc.collateral_asset_symbol || '').trim().toUpperCase();
  // The NONE/IDLE symbol only counts when the address is not known: the normalizer also writes NONE for a missing symbol
  const placeholderSymbol = colAddr === null && (symbol === 'NONE' || symbol === 'IDLE');
  return noCollateralAddress || placeholderSymbol || (lltvKnown && lltvNum === 0);
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
  const unresolvedUsd = Math.min(totalAssetsUsd, Math.max(0, Number(vault.unresolved_exposure_usd) || 0));
  const knownAssetsUsd = totalAssetsUsd - unresolvedUsd;
  const unverifiedPercent = totalAssetsUsd > 0 ? Math.round((unresolvedUsd / totalAssetsUsd) * 10000) / 100 : 0;

  // Group allocations by underlying family (ETH, BTC wrappers) or else by collateral contract address (with symbol label)
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
      const family = FAMILY_BY_SYMBOL.get(symbol);
      const key = family || colAddr || symbol;
      if (!collateralMap.has(key)) {
        collateralMap.set(key, { symbol, usd: 0 });
      }
      const entry = collateralMap.get(key);
      if (family && entry.symbol !== symbol) entry.symbol = family;
      entry.usd += supplyUsd;
      totalActiveCollateralUsd += supplyUsd;
    }
  }

  // Nothing about the vault's capital is known: no collateral picture at all (not "no collateral")
  if (totalAssetsUsd > 0 && knownAssetsUsd <= 0) {
    return {
      hhi: 0,
      effectiveAssets: 0,
      tier: 'UNKNOWN',
      tierLabel: 'N/A',
      isExtremeConcentration: false,
      unverifiedPercent,
      topCollateral: { symbol: 'None', sharePercent: 0, usd: 0 },
      breakdown: []
    };
  }

  // Materiality threshold: at least 1.0% of the verified vault capital must be deployed into active collateral
  const minMaterialThresholdUsd = knownAssetsUsd * 0.01;

  // If there is no material active collateral backing (< 1.0% of TVL, 100% idle cash or empty vault)
  if (totalAssetsUsd <= 0 || totalActiveCollateralUsd < minMaterialThresholdUsd || collateralMap.size === 0) {
    return {
      hhi: 0,
      effectiveAssets: 0,
      tier: 'UNALLOCATED',
      tierLabel: 'N/A',
      isExtremeConcentration: false,
      unverifiedPercent,
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
    const tvlShare = Math.max(0, Math.min(1.0, usd / knownAssetsUsd));
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
  const topCollatShareRaw = Math.max(0, Math.min(100, (topCollatUsd / knownAssetsUsd) * 100));
  const topCollatShare = Math.round(topCollatShareRaw * 10) / 10;

  // Sort breakdown descending by share of vault capital
  breakdown.sort((a, b) => b.sharePercent - a.sharePercent);

  const hhiRaw = Math.min(1.0, Math.max(0, hhiSum));
  const hhi = Math.round(hhiRaw * 1000) / 1000;
  const effectiveAssets = hhi > 0 ? Math.round((1 / hhi) * 10) / 10 : 0;
  const activeCollateralExposure = totalActiveCollateralUsd / knownAssetsUsd;

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
    unverifiedPercent,
    isExtremeConcentration: tier === 'EXTREME',
    topCollateral,
    breakdown
  };
}
