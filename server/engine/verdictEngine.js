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
  if (hhi.tier !== 'UNALLOCATED' && hhi.hhi > 0.50 && hhi.topCollateral.sharePercent >= 40) {
    redFlags.push({
      level: 'HIGH',
      title: 'Extreme Collateral Concentration',
      message: `${hhi.topCollateral.sharePercent}% of vault capital is backed by a single collateral asset (${hhi.topCollateral.symbol}), creating critical concentration risk (HHI: ${hhi.hhi}).`
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

  // Flag 4: Crowded Exit Contagion / Shared Market Overhang
  if (liquidity.crowdedMarkets && liquidity.crowdedMarkets.length > 0) {
    const totalCrowdedSupplyUsd = liquidity.crowdedMarkets.reduce((sum, m) => sum + m.vaultSupplyUsd, 0);
    const totalAssetsUsd = Number(vault.total_assets_usd) || 0;
    const crowdedSharePercent = totalAssetsUsd > 0 ? Math.round((totalCrowdedSupplyUsd / totalAssetsUsd) * 1000) / 10 : 0;
    const dropPct = Math.round((liquidity.instantExitCapacityPercent - liquidity.stressedExitCapacityPercent) * 10) / 10;

    // Critical trigger: severe liquidity cliff (normal >= 20% but drops to < 10% in a run, or >= 35% TVL in crowded markets with >= 15% drop)
    const isCritical = (liquidity.instantExitCapacityPercent >= 20 && liquidity.stressedExitCapacityPercent < 10)
      || (crowdedSharePercent >= 35 && dropPct >= 15);

    // High trigger: material crowded exposure (>= 10% TVL or >= $2M in crowded markets with >= 10% drop)
    const isHigh = !isCritical && (crowdedSharePercent >= 10 || totalCrowdedSupplyUsd >= 2e6) && (dropPct >= 10 || liquidity.stressedExitCapacityPercent < 20);

    const topMarket = liquidity.crowdedMarkets[0];
    const topPeersStr = topMarket.topPeers && topMarket.topPeers.length > 0 ? topMarket.topPeers.join(', ') : 'peer vaults';

    if (isCritical) {
      redFlags.push({
        level: 'CRITICAL',
        title: 'Critical Crowded Exit Deficit',
        message: `${crowdedSharePercent}% ($${(totalCrowdedSupplyUsd / 1e6).toFixed(1)}M) of deposits share markets with competing peer vaults (${topPeersStr}) whose claims exceed available free cash. In a concurrent run, exit capacity crashes from ${liquidity.instantExitCapacityPercent}% to ${liquidity.stressedExitCapacityPercent}%.`
      });
    } else if (isHigh) {
      redFlags.push({
        level: 'HIGH',
        title: 'Elevated Crowded Exit Contagion',
        message: `Vault shares material allocations with ${topPeersStr} in markets where competing supply exceeds free cash. Under a concurrent exit, pro-rata capacity drops from ${liquidity.instantExitCapacityPercent}% to ${liquidity.stressedExitCapacityPercent}%.`
      });
    }
  }

  // 5. Plaintext Objective Summary
  let exitSummary = `Exit Liquidity: ${liquidity.instantExitCapacityPercent}%`;
  if (liquidity.isCrowded) {
    exitSummary += ` (stressed pro-rata: ${liquidity.stressedExitCapacityPercent}%)`;
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
