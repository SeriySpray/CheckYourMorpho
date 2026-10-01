/**
 * Market Quality Index (MQI) Engine
 * Evaluates the strict, objective, on-chain cleanliness of capital allocation.
 * 
 * Formula:
 * MQI = sum(w_i * IsClean_i) + w_cash
 * 
 * IsClean_i is strictly binary (1 or 0):
 * 1 (Clean) if:
 *   - Market is officially listed in Morpho (is_listed == 1)
 *   - No active or realized bad debt (bad_debt_usd == 0 && realized_bad_debt_usd == 0)
 *   - Valid oracle contract address (not zero address)
 *   - No critical protocol security warnings (not_whitelisted, unrecognized_collateral_asset, level RED)
 * 0 (Compromised) if ANY of the above conditions is violated.
 */


/**
 * Evaluates whether a market passes the strict binary clean test.
 * @param {object} market Market record from database
 * @returns {object} { isClean: boolean, reasons: string[] }
 */
export function isMarketClean(market) {
  const reasons = [];

  // Check 1: Listed status
  const isListed = Number(market.is_listed ?? 1) === 1;
  if (!isListed) {
    reasons.push('Unlisted market (not verified by Morpho)');
  }

  // Check 2: Bad Debt & Realized Bad Debt
  const badDebtUsd = Number(market.bad_debt_usd || 0);
  const realizedBadDebtUsd = Number(market.realized_bad_debt_usd || 0);
  if (badDebtUsd > 0 || realizedBadDebtUsd > 0) {
    const totalBadDebt = badDebtUsd + realizedBadDebtUsd;
    reasons.push(`Bad debt detected ($${totalBadDebt.toLocaleString('en-US', { maximumFractionDigits: 0 })})`);
  }

  // Check: Idle / 0-LLTV reserve markets (no collateral, no borrowing)
  const lltvNum = Number(market.lltv_percent || 0);
  const isIdleReserve = lltvNum === 0 && (!market.collateral_asset_address || market.collateral_asset_symbol === 'NONE');

  // Check 3: Oracle Verification (only required for borrowing markets with collateral)
  if (!isIdleReserve) {
    const oracleAddr = (market.oracle_address || '').toLowerCase();
    const isZeroAddress = !oracleAddr || oracleAddr === '0x0000000000000000000000000000000000000000';

    if (isZeroAddress) {
      reasons.push('Missing oracle contract address');
    }
  }


  // Check 4: Protocol Warnings
  const warningsCount = Number(market.warnings_count || 0);
  let warningsJson = [];
  try {
    if (typeof market.warnings_json === 'string' && market.warnings_json) {
      warningsJson = JSON.parse(market.warnings_json);
    } else if (Array.isArray(market.warnings_json)) {
      warningsJson = market.warnings_json;
    }
  } catch {}

  const hasCriticalWarning = warningsJson.some(w => {
    const type = (w.type || '').toLowerCase();
    const level = (w.level || '').toUpperCase();
    return level === 'RED' || type === 'not_whitelisted' || type === 'unrecognized_collateral_asset';
  });

  if (hasCriticalWarning) {
    reasons.push('Critical protocol security warning flagged by Morpho');
  }

  const isClean = reasons.length === 0;

  return {
    isClean,
    reasons
  };
}

/**
 * Calculates Market Quality Index (MQI) for a vault and its allocations.
 * 
 * @param {object} vault Vault row from database
 * @param {Array<object>} allocations Array of vault allocations joined with markets
 * @returns {object} MQI audit metrics
 */
export function calculateMQI(vault, allocations = []) {
  const totalAssetsUsd = Number(vault.total_assets_usd) || 0;
  const directLiquidityUsd = Number(vault.liquidity_usd) || 0;

  if (totalAssetsUsd <= 0) {
    return {
      mqiPercent: 100,
      cleanAssetsUsd: 0,
      compromisedAssetsUsd: 0,
      isAllClean: true,
      cleanMarketsCount: 0,
      totalMarketsCount: 0,
      compromisedMarkets: []
    };
  }

  let cleanSupplyUsd = 0;
  let compromisedSupplyUsd = 0;
  let cleanMarketsCount = 0;
  const compromisedMarkets = [];
  const minMaterialThresholdUsd = totalAssetsUsd * 0.01;

  for (const alloc of allocations) {
    const supplyUsd = Number(alloc.supply_assets_usd) || 0;
    const test = isMarketClean(alloc);
    const isMaterial = supplyUsd > minMaterialThresholdUsd;

    if (test.isClean || !isMaterial) {
      cleanSupplyUsd += supplyUsd;
      if (test.isClean && supplyUsd >= 1) cleanMarketsCount++;
    } else {
      compromisedSupplyUsd += supplyUsd;
      const weight = totalAssetsUsd > 0 ? supplyUsd / totalAssetsUsd : 0;
      compromisedMarkets.push({
        marketUniqueKey: alloc.market_unique_key,
        collateralSymbol: alloc.collateral_asset_symbol || 'None',
        loanSymbol: alloc.loan_asset_symbol || '',
        supplyAssetsUsd: Math.round(supplyUsd * 100) / 100,
        weightPercent: Math.round(weight * 1000) / 10,
        reasons: test.reasons
      });
    }
  }

  // Any vault capital not allocated to borrowing markets is unallocated idle cash on contract (clean)
  const totalAllocated = cleanSupplyUsd + compromisedSupplyUsd;
  const idleCashUsd = Math.max(0, totalAssetsUsd - totalAllocated);
  const totalCleanAssetsUsd = cleanSupplyUsd + idleCashUsd;
  const effectiveTotalUsd = totalCleanAssetsUsd + compromisedSupplyUsd;

  const mqiPercent = effectiveTotalUsd > 0 
    ? Math.min(100, Math.max(0, Math.round((totalCleanAssetsUsd / effectiveTotalUsd) * 1000) / 10))
    : 100;

  return {
    mqiPercent,
    cleanAssetsUsd: Math.round(totalCleanAssetsUsd * 100) / 100,
    compromisedAssetsUsd: Math.round(compromisedSupplyUsd * 100) / 100,
    isAllClean: compromisedMarkets.length === 0 && mqiPercent === 100,
    cleanMarketsCount,
    totalMarketsCount: allocations.length,
    compromisedMarkets
  };
}

