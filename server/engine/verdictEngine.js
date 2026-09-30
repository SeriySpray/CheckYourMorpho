import { calculateMQI } from './mqiEngine.js';
import { calculateHHI } from './hhiEngine.js';
import { calculateLiquidityMetrics } from './liquidityEngine.js';

/**
 * Synthesizes the institutional vault audit based strictly on:
 * 1. Market Quality Index (MQI)
 * 2. Herfindahl-Hirschman Index (HHI) Collateral Concentration
 * 3. Instant Exit Capacity
 * 
 * @param {object} vault Vault row from database
 * @param {Array<object>} allocations Active allocations joined with markets
 * @returns {object} Clean institutional audit verdict
 */
export function generateVaultVerdict(vault, allocations = []) {
  // 1. Market Quality Index (MQI) [0% - 100%]
  const mqi = calculateMQI(vault, allocations);

  // 2. Herfindahl-Hirschman Concentration Index (HHI) [0.00 - 1.00]
  const hhi = calculateHHI(vault, allocations);

  // 3. Instant Exit Liquidity
  const liquidity = calculateLiquidityMetrics(vault, allocations);

  // 4. Objective, Fact-Based Audit Flags
  const redFlags = [];

  // Flag 1: Compromised or Defaulted Markets
  if (mqi.mqiPercent < 100) {
    const compromisedPct = Math.round((100 - mqi.mqiPercent) * 10) / 10;
    const reasonsSummary = mqi.compromisedMarkets.map(m => `${m.collateralSymbol}/${m.loanSymbol}: ${m.reasons.join(', ')}`).join('; ');
    redFlags.push({
      level: 'CRITICAL',
      title: 'Compromised Market Exposure',
      message: `${compromisedPct}% of capital is deployed in markets with verification issues or bad debt (${reasonsSummary}).`
    });
  }

  // Flag 2: Extreme Collateral Concentration (SPOF)
  if (hhi.tier !== 'UNALLOCATED' && hhi.hhi > 0.50 && hhi.topCollateral.sharePercent >= 40) {
    redFlags.push({
      level: 'HIGH',
      title: 'Extreme Collateral Concentration',
      message: `${hhi.topCollateral.sharePercent}% of vault capital is backed by a single collateral asset (${hhi.topCollateral.symbol}), creating a Single Point of Failure (HHI: ${hhi.hhi}).`
    });
  } else if (hhi.tier !== 'UNALLOCATED' && (hhi.hhi >= 0.25 || (hhi.hhi > 0.50 && hhi.topCollateral.sharePercent < 40)) && hhi.topCollateral.sharePercent >= 20) {
    redFlags.push({
      level: 'MEDIUM',
      title: 'Elevated Collateral Concentration',
      message: `Top collateral asset ${hhi.topCollateral.symbol} accounts for ${hhi.topCollateral.sharePercent}% of backing (HHI: ${hhi.hhi}).`
    });
  }

  // Flag 3: Severe Exit Liquidity Lockup
  if (liquidity.instantExitCapacityPercent < 20) {
    redFlags.push({
      level: 'HIGH',
      title: 'Restricted Exit Liquidity',
      message: `Only ${liquidity.instantExitCapacityPercent}% ($${(liquidity.instantExitCapacityUsd / 1e6).toFixed(2)}M) of deposits can be withdrawn immediately without waiting for borrower repayments.`
    });
  }

  // 5. Plaintext Objective Summary
  let summary = hhi.tier === 'UNALLOCATED'
    ? `MQI: ${mqi.mqiPercent}% clean capital. Concentration: Немає застави (100% кеш). Exit Liquidity: ${liquidity.instantExitCapacityPercent}%.`
    : `MQI: ${mqi.mqiPercent}% clean capital. Concentration HHI: ${hhi.hhi} (${hhi.tierLabel}, top: ${hhi.topCollateral.symbol} ${hhi.topCollateral.sharePercent}%). Exit Liquidity: ${liquidity.instantExitCapacityPercent}%.`;

  return {
    vaultAddress: vault.address,
    vaultName: vault.name,
    version: vault.version,
    chainId: vault.chain_id,
    summary,
    redFlags,
    mqi,
    hhi,
    liquidity
  };
}
