import { calculateMarketRisk } from './riskMetrics.js';

/**
 * Calculates current instantaneous risk of a vault given its active allocations.
 * 
 * @param {Array<object>} allocations Array of allocations with joined market data
 * @param {number} totalAssetsUsd
 * @returns {object} { currentRiskScore, marketRiskBreakdown }
 */
export function calculateInstantRisk(allocations = [], totalAssetsUsd = 0) {
  if (!allocations.length || totalAssetsUsd <= 0) {
    return {
      currentRiskScore: 0,
      marketRiskBreakdown: []
    };
  }

  let weightedRiskSum = 0;
  const breakdown = [];

  for (const alloc of allocations) {
    const supplyUsd = Number(alloc.supply_assets_usd) || 0;
    const lltvPercent = Number(alloc.lltv_percent) || 0;
    const collateralSymbol = alloc.collateral_asset_symbol || '';
    const oracleAddress = alloc.oracle_address || '';

    const risk = calculateMarketRisk(lltvPercent, collateralSymbol, oracleAddress);
    const weight = Math.max(0, Math.min(1, supplyUsd / totalAssetsUsd));
    const contribution = risk.normalizedScore * weight;

    weightedRiskSum += contribution;

    breakdown.push({
      marketUniqueKey: alloc.market_unique_key,
      collateralSymbol,
      loanSymbol: alloc.loan_asset_symbol,
      lltvPercent: risk.lltvPercent,
      bufferPercent: risk.bufferPercent,
      assetMultiplier: risk.assetMultiplier,
      supplyUsd: Math.round(supplyUsd * 100) / 100,
      weight: Math.round(weight * 1000) / 1000,
      marketRiskScore: risk.normalizedScore,
      riskContribution: Math.round(contribution * 100) / 100
    });
  }

  // Sort breakdown by risk contribution descending
  breakdown.sort((a, b) => b.riskContribution - a.riskContribution);

  return {
    currentRiskScore: Math.min(100, Math.round(weightedRiskSum * 10) / 10),
    marketRiskBreakdown: breakdown
  };
}

/**
 * Calculates Time-Weighted Risk (TWR) for 30d, 90d, and All-Time,
 * and detects Peak Risk Spikes from historical reallocation logs.
 * 
 * @param {object} instantRisk Current instant risk result
 * @param {Array<object>} historicalReallocations Events from reallocations table
 * @param {number} nowSeconds Current timestamp in seconds
 * @returns {object} { twr30d, twr90d, twrAllTime, peakRiskSpikes, totalReallocationsCount }
 */
export function calculateTimeWeightedRisk(instantRisk, historicalReallocations = [], nowSeconds = Math.floor(Date.now() / 1000)) {
  const currentRisk = instantRisk.currentRiskScore || 0;

  if (!historicalReallocations || historicalReallocations.length === 0) {
    return {
      twr30d: currentRisk,
      twr90d: currentRisk,
      twrAllTime: currentRisk,
      peakRiskSpikes: [],
      totalReallocationsCount: 0
    };
  }

  const SECONDS_30D = 30 * 86400;
  const SECONDS_90D = 90 * 86400;

  const sortedEvents = [...historicalReallocations].sort((a, b) => a.timestamp - b.timestamp);

  const peakRiskSpikes = [];
  let risk30dAccum = 0;
  let time30dAccum = 0;
  let risk90dAccum = 0;
  let time90dAccum = 0;
  let riskAllAccum = 0;
  let timeAllAccum = 0;

  // Track risk state over timeline
  let runningRisk = currentRisk;
  let lastTimestamp = sortedEvents[0]?.timestamp || (nowSeconds - SECONDS_90D);

  for (const ev of sortedEvents) {
    const evTime = Number(ev.timestamp);
    const timeDelta = Math.max(0, evTime - lastTimestamp);

    // Accumulate time-weighted risk
    if (timeDelta > 0) {
      riskAllAccum += runningRisk * timeDelta;
      timeAllAccum += timeDelta;

      if (nowSeconds - lastTimestamp <= SECONDS_90D) {
        risk90dAccum += runningRisk * timeDelta;
        time90dAccum += timeDelta;
      }

      if (nowSeconds - lastTimestamp <= SECONDS_30D) {
        risk30dAccum += runningRisk * timeDelta;
        time30dAccum += timeDelta;
      }
    }

    // Inspect if this event caused a risk spike
    const lltv = Number(ev.lltv_percent) || 0;
    const colSymbol = ev.collateral_asset_symbol || '';
    const movedUsd = Number(ev.assets_human) * (Number(ev.loan_asset_price_usd) || 1);

    if (lltv >= 88.0 || colSymbol.includes('eETH') || colSymbol.includes('ezETH') || colSymbol.includes('rsETH')) {
      // High-risk reallocation event
      const eventRisk = calculateMarketRisk(lltv, colSymbol).normalizedScore;
      if (eventRisk > 45) {
        peakRiskSpikes.push({
          timestamp: evTime,
          txHash: ev.tx_hash,
          marketUniqueKey: ev.market_unique_key,
          collateralSymbol: colSymbol,
          lltvPercent: lltv,
          assetsMovedUsd: Math.round(movedUsd * 100) / 100,
          peakRiskScore: eventRisk,
          type: ev.type
        });
      }
    }

    lastTimestamp = evTime;
  }

  // Account for tail time until now
  const tailDelta = Math.max(0, nowSeconds - lastTimestamp);
  if (tailDelta > 0) {
    riskAllAccum += runningRisk * tailDelta;
    timeAllAccum += tailDelta;

    risk90dAccum += runningRisk * Math.min(tailDelta, SECONDS_90D);
    time90dAccum += Math.min(tailDelta, SECONDS_90D);

    risk30dAccum += runningRisk * Math.min(tailDelta, SECONDS_30D);
    time30dAccum += Math.min(tailDelta, SECONDS_30D);
  }

  const twr30d = time30dAccum > 0 ? Math.round((risk30dAccum / time30dAccum) * 10) / 10 : currentRisk;
  const twr90d = time90dAccum > 0 ? Math.round((risk90dAccum / time90dAccum) * 10) / 10 : currentRisk;
  const twrAllTime = timeAllAccum > 0 ? Math.round((riskAllAccum / timeAllAccum) * 10) / 10 : currentRisk;

  return {
    twr30d,
    twr90d,
    twrAllTime,
    peakRiskSpikes: peakRiskSpikes.slice(-10), // keep top 10 most recent spikes
    totalReallocationsCount: sortedEvents.length
  };
}
