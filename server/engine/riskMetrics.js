/**
 * Classifies collateral asset and returns risk multiplier.
 * @param {string} symbol
 * @returns {number}
 */
export function getCollateralMultiplier(symbol = '') {
  const sym = symbol.toUpperCase().trim();
  
  // Tier 1: Core Blue-chips and Stablecoins (Multiplier: 1.0)
  if (['USDC', 'USDT', 'DAI', 'WETH', 'ETH', 'WBTC', 'CBTC', 'EURC', 'EURCV', 'PYUSD', 'USDS'].includes(sym)) {
    return 1.0;
  }
  
  // Tier 2: Liquid Staking Tokens - LSTs (Multiplier: 1.2)
  if (['WSTETH', 'STETH', 'CBETH', 'RETH', 'OETH', 'WOETH', 'SFRXETH'].some(s => sym.includes(s))) {
    return 1.2;
  }
  
  // Tier 3: Liquid Restaking Tokens & Synthetic Yield Assets (Multiplier: 1.5)
  if (['EETH', 'WEETH', 'EZETH', 'RSETH', 'SUSDE', 'USDE', 'LBTC', 'EBTC', 'SUSD'].some(s => sym.includes(s))) {
    return 1.5;
  }
  
  // Tier 4: Exotic, Governance, or Long-tail Collateral (Multiplier: 2.0)
  return 2.0;
}

/**
 * Calculates Market Risk Score based on Liquidation Buffer and Collateral Multiplier.
 * Buffer = 1 - LLTV
 * RiskScore = (1 / Buffer) * AssetMultiplier
 * With Leverage Squeeze penalty for LLTV >= 90%.
 * Normalized to 0 - 100 range.
 * 
 * @param {number} lltvPercent LLTV in percentage, e.g. 86.0 or 91.5
 * @param {string} collateralSymbol e.g. 'wstETH', 'USDC'
 * @param {string} oracleAddress
 * @returns {object} { bufferPercent, multiplier, rawRisk, normalizedScore }
 */
export function calculateMarketRisk(lltvPercent, collateralSymbol = '', oracleAddress = '') {
  const lltv = Math.min(0.98, Math.max(0, (Number(lltvPercent) || 0) / 100));
  
  // Buffer: Distance between current loan and liquidation threshold
  const buffer = Math.max(0.02, 1 - lltv);
  const bufferPercent = Math.round(buffer * 10000) / 100; // e.g. 14.0%
  
  // Multiplier by collateral asset class
  const assetMultiplier = getCollateralMultiplier(collateralSymbol);
  
  // Base Risk from inverted buffer: 1 / buffer
  // E.g. 77% LLTV -> buffer 0.23 -> base = 4.35
  // E.g. 86% LLTV -> buffer 0.14 -> base = 7.14
  // E.g. 91.5% LLTV -> buffer 0.085 -> base = 11.76
  // E.g. 94.5% LLTV -> buffer 0.055 -> base = 18.18
  let baseRisk = (1 / buffer) * assetMultiplier;
  
  // Leverage Squeeze Penalty for high LLTV (>= 90%)
  // When LLTV >= 90%, liquidation cascades happen in minutes under slight volatility
  if (lltv >= 0.90) {
    const excess = lltv - 0.90;
    const squeezeMultiplier = 1 + (excess * 15); // e.g. 94.5% -> 1 + (0.045 * 15) = 1.675x penalty
    baseRisk *= squeezeMultiplier;
  }
  
  // Oracle penalty: if zero address or null
  if (!oracleAddress || oracleAddress === '0x0000000000000000000000000000000000000000') {
    baseRisk *= 1.3;
  }
  
  // Normalize rawRisk into a 0 - 100 scale
  // Calibrated: 70% blue-chip LLTV (~4.0 raw) -> ~15 score
  // 86% LST LLTV (~8.5 raw) -> ~35 score
  // 91.5% LRT LLTV (~21 raw) -> ~70 score
  // 94.5% Exotic LLTV (~40+ raw) -> ~95+ score
  const normalizedScore = Math.min(100, Math.max(0, Math.round((baseRisk / 35) * 100 * 10) / 10));
  
  return {
    lltvPercent: Math.round(lltv * 10000) / 100,
    bufferPercent,
    assetMultiplier,
    rawRisk: Math.round(baseRisk * 100) / 100,
    normalizedScore
  };
}
