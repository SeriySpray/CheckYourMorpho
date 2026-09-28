import { calculateInstantRisk, calculateTimeWeightedRisk } from './twrCalculator.js';
import { calculateLiquidityMetrics } from './liquidityEngine.js';

/**
 * Assigns an investment grade based on Safety Score (0 - 100).
 * @param {number} score
 * @returns {string}
 */
export function getGradeFromScore(score) {
  if (score >= 90) return 'AAA';
  if (score >= 82) return 'AA';
  if (score >= 74) return 'A';
  if (score >= 65) return 'BBB';
  if (score >= 55) return 'BB';
  if (score >= 45) return 'B';
  if (score >= 35) return 'CCC';
  return 'D';
}

/**
 * Synthesizes a comprehensive audit verdict, safety score, and red flags for a vault.
 * 
 * @param {object} vault Vault row from database
 * @param {Array<object>} allocations Active allocations joined with markets
 * @param {Array<object>} reallocations Historical reallocation events
 * @returns {object} Complete audit analysis
 */
export function generateVaultVerdict(vault, allocations = [], reallocations = []) {
  const totalAssetsUsd = Number(vault.total_assets_usd) || 0;
  
  // 1. Liquidity & Exit Analytics
  const liquidity = calculateLiquidityMetrics(vault, allocations);

  // 2. Risk & TWR Analytics
  const instantRisk = calculateInstantRisk(allocations, totalAssetsUsd);
  const twr = calculateTimeWeightedRisk(instantRisk, reallocations);

  // 3. Curator Discipline Score (0 - 100)
  let disciplineScore = 85; // baseline good curator score
  const spikeCount = twr.peakRiskSpikes.length;
  disciplineScore -= spikeCount * 8; // penalty for dangerous spikes
  if (twr.totalReallocationsCount > 20) disciplineScore += 5; // bonus for active management
  if (liquidity.maxMarketDominancePercent > 70) disciplineScore -= 10; // penalty for illiquid traps
  disciplineScore = Math.min(100, Math.max(10, disciplineScore));

  // 4. Composite Safety Score (0 - 100)
  // 40% Risk Protection + 35% Exit Liquidity + 25% Curator Discipline
  const riskComponent = Math.max(0, 100 - (twr.twr30d * 1.1));
  const exitComponent = liquidity.instantExitCapacityPercent;
  const rawSafetyScore = (0.40 * riskComponent) + (0.35 * exitComponent) + (0.25 * disciplineScore);
  const safetyScore = Math.min(100, Math.max(5, Math.round(rawSafetyScore)));
  const grade = getGradeFromScore(safetyScore);

  // 5. Red Flags Detection
  const redFlags = [];

  // Check 1: Extreme LLTV
  const extremeLltvMarket = instantRisk.marketRiskBreakdown.find(m => m.lltvPercent >= 91.5 && m.weight > 0.05);
  if (extremeLltvMarket) {
    redFlags.push({
      level: 'CRITICAL',
      title: 'Extreme LLTV Exposure',
      message: `${Math.round(extremeLltvMarket.weight * 100)}% of vault capital is exposed to ${extremeLltvMarket.collateralSymbol} at ${extremeLltvMarket.lltvPercent}% LLTV (only ${extremeLltvMarket.bufferPercent}% liquidation buffer).`
    });
  }

  // Check 2: Liquidity Crunch Risk
  if (liquidity.instantExitCapacityPercent < 30) {
    redFlags.push({
      level: 'HIGH',
      title: 'Restricted Exit Capacity',
      message: `Only ${liquidity.instantExitCapacityPercent}% ($${(liquidity.instantExitCapacityUsd / 1e6).toFixed(2)}M) of deposits can be withdrawn immediately without market utilization locking up.`
    });
  }

  // Check 3: Vault Market Dominance
  if (liquidity.maxMarketDominancePercent >= 60) {
    redFlags.push({
      level: 'HIGH',
      title: 'High Market Dominance',
      message: `Vault supplies ${liquidity.maxMarketDominancePercent}% of its largest market. A major withdrawal will spike borrow utilization to 100%.`
    });
  }

  // Check 4: Single Market Concentration
  const highestWeightMarket = instantRisk.marketRiskBreakdown[0];
  if (highestWeightMarket && highestWeightMarket.weight > 0.75 && instantRisk.marketRiskBreakdown.length > 1) {
    redFlags.push({
      level: 'MEDIUM',
      title: 'High Market Concentration',
      message: `${Math.round(highestWeightMarket.weight * 100)}% of assets are concentrated in a single market (${highestWeightMarket.collateralSymbol}/${highestWeightMarket.loanSymbol}).`
    });
  }

  // Check 5: Recent Peak Risk Spikes
  if (spikeCount > 0) {
    const recentSpike = twr.peakRiskSpikes[twr.peakRiskSpikes.length - 1];
    redFlags.push({
      level: 'MEDIUM',
      title: 'Curator Risk Spike Detected',
      message: `Curator executed a high-risk reallocation to ${recentSpike.collateralSymbol} at ${recentSpike.lltvPercent}% LLTV ($${(recentSpike.assetsMovedUsd / 1e6).toFixed(2)}M).`
    });
  }

  // 6. Natural Language Verdict Summary
  let summary = '';
  if (safetyScore >= 80) {
    summary = 'Prime institutional quality. Robust liquidation buffers, strong instant exit capacity, and a disciplined curation track record.';
  } else if (safetyScore >= 65) {
    summary = 'Moderate risk profile with attractive yield. Suitable for core allocations, though monitoring of underlying market utilization is advised.';
  } else if (safetyScore >= 50) {
    summary = 'Elevated risk exposure. High LLTV collateral or concentrated market positions require continuous exit liquidity monitoring.';
  } else {
    summary = 'High speculative risk. Tight liquidation buffers and severe withdrawal friction if market conditions deteriorate rapidly.';
  }

  return {
    vaultAddress: vault.address,
    vaultName: vault.name,
    version: vault.version,
    chainId: vault.chain_id,
    safetyScore,
    grade,
    summary,
    redFlags,
    risk: {
      currentRiskScore: instantRisk.currentRiskScore,
      twr30d: twr.twr30d,
      twr90d: twr.twr90d,
      twrAllTime: twr.twrAllTime,
      peakRiskSpikes: twr.peakRiskSpikes,
      breakdown: instantRisk.marketRiskBreakdown
    },
    liquidity: {
      directLiquidityUsd: liquidity.directLiquidityUsd,
      liquidityCoverageRatio: liquidity.liquidityCoverageRatio,
      instantExitCapacityUsd: liquidity.instantExitCapacityUsd,
      instantExitCapacityPercent: liquidity.instantExitCapacityPercent,
      maxMarketDominancePercent: liquidity.maxMarketDominancePercent,
      weightedMarketDominancePercent: liquidity.weightedMarketDominancePercent,
      concentratedMarketsCount: liquidity.concentratedMarketsCount,
      isIlliquid: liquidity.isIlliquid
    },
    curator: {
      curatorName: vault.curator_name,
      disciplineScore,
      totalReallocationsRecorded: twr.totalReallocationsCount
    }
  };
}
