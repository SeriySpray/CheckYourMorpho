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

  // Flag 1: Compromised or Defaulted Markets (> 1.0% TVL)
  if (mqi.mqiPercent < 100 && mqi.compromisedMarkets.length > 0) {
    const compromisedPct = Math.round((100 - mqi.mqiPercent) * 10) / 10;
    const reasonsSummary = mqi.compromisedMarkets.map(m => `${m.collateralSymbol}/${m.loanSymbol} (${m.weightPercent}% TVL): ${m.reasons.join(', ')}`).join('; ');
    redFlags.push({
      level: 'CRITICAL',
      title: 'Compromised Market Exposure (>1% TVL)',
      message: `${compromisedPct}% of capital is deployed in markets with verification issues or bad debt (${reasonsSummary}).`
    });
  }

  // Flag 2: Extreme Collateral Concentration
  if (hhi.tier === 'EXTREME') {
    redFlags.push({
      level: 'HIGH',
      title: 'Extreme Collateral Concentration',
      message: `${hhi.topCollateral.sharePercent}% of vault capital is backed by a single collateral asset (${hhi.topCollateral.symbol}), creating critical concentration risk (HHI: ${hhi.hhi}).`
    });
  } else if (hhi.tier === 'CONCENTRATED') {
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

  // Flag 4: Crowded Exit Contagion / Shared Market Overhang
  if (liquidity.crowdedMarkets && liquidity.crowdedMarkets.length > 0) {
    const totalCrowdedSupplyUsd = liquidity.crowdedMarkets.reduce((sum, m) => sum + m.vaultSupplyUsd, 0);
    const totalAssetsUsd = Number(vault.total_assets_usd) || 0;
    const crowdedSharePercent = totalAssetsUsd > 0 ? Math.round((totalCrowdedSupplyUsd / totalAssetsUsd) * 1000) / 10 : 0;
    const dropPct = Math.round((liquidity.instantExitCapacityPercent - liquidity.stressedExitCapacityPercent) * 10) / 10;

    // Critical trigger: Stressed pro-rata exit capacity collapses into true danger zone (< 15%)
    // with substantial drop (>= 15%) and material exposure to crowded markets
    const isCritical = (liquidity.stressedExitCapacityPercent < 15 && dropPct >= 15 && (liquidity.instantExitCapacityPercent >= 20 || crowdedSharePercent >= 25))
      || (crowdedSharePercent >= 35 && dropPct >= 20 && liquidity.stressedExitCapacityPercent < 20);

    // High trigger: Material reduction in exit capacity (stressed < 25% with drop >= 10%, or drop >= 20% with stressed < 35%)
    const isHigh = !isCritical && crowdedSharePercent >= 15 && (
      (liquidity.stressedExitCapacityPercent < 25 && dropPct >= 10) ||
      (dropPct >= 20 && liquidity.stressedExitCapacityPercent < 35)
    );

    const topMarket = liquidity.crowdedMarkets[0];
    const topPeersStr = topMarket.topPeers && topMarket.topPeers.length > 0 ? topMarket.topPeers.join(', ') : 'peer vaults';

    if (isCritical) {
      redFlags.push({
        level: 'CRITICAL',
        title: 'Critical Crowded Exit Deficit',
        message: `In a mass withdrawal by competing peer vaults (${topPeersStr}), available exit drops from ${liquidity.instantExitCapacityPercent}% to ${liquidity.stressedExitCapacityPercent}% (${crowdedSharePercent}% of vault capital in heavily contested markets).`
      });
    } else if (isHigh) {
      redFlags.push({
        level: 'HIGH',
        title: 'Elevated Crowded Exit Contagion',
        message: `Competing peer vaults (${topPeersStr}) reduce available exit from ${liquidity.instantExitCapacityPercent}% to ${liquidity.stressedExitCapacityPercent}% across ${crowdedSharePercent}% of allocated capital during a mass withdrawal.`
      });
    }
  }

  // 5. Plaintext Objective Summary
  let exitSummary = `Exit Liquidity: ${liquidity.instantExitCapacityPercent}%`;
  if (liquidity.isCrowded) {
    exitSummary += ` (worst-case: ${liquidity.stressedExitCapacityPercent}%)`;
  }
  let summary = hhi.tier === 'UNALLOCATED'
    ? `MQI: ${mqi.mqiPercent}% clean capital. Concentration: N/A. ${exitSummary}.`
    : `MQI: ${mqi.mqiPercent}% clean capital. Concentration HHI: ${hhi.hhi} (${hhi.tierLabel}, top: ${hhi.topCollateral.symbol} ${hhi.topCollateral.sharePercent}%). ${exitSummary}.`;

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
