import { calculateMQI, withMaterialUnresolved } from './mqiEngine.js';
import { calculateHHI } from './hhiEngine.js';
import { calculateCollateralMix } from './collateralEngine.js';
import { calculateLiquidityMetrics } from './liquidityEngine.js';

/**
 * Synthesizes the institutional vault audit based strictly on:
 * 1. Market Quality Index (MQI)
 * 2. Collateral class mix (share of capital per risk class of the collateral); the HHI is still returned for reference
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
  const hhi = calculateHHI(withMaterialUnresolved(vault, mqi), allocations);
  const collateral = calculateCollateralMix(withMaterialUnresolved(vault, mqi), allocations);

  // 3. Instant Exit Liquidity
  const liquidity = calculateLiquidityMetrics(withMaterialUnresolved(vault, mqi), allocations);

  // 4. Objective, Fact-Based Audit Flags
  const redFlags = [];

  // Flag 1: Compromised or Defaulted Markets (material allocations, see mqiEngine materiality rule).
  // Tested on the list itself: mqiPercent is rounded to 0.1 and can read 100 for a real but small share.
  if (mqi.unpriced) {
    redFlags.push({
      level: 'HIGH',
      title: 'Unpriced Vault',
      message: 'The vault holds assets but no USD price is available for them, so market quality, concentration and exit liquidity cannot be measured.'
    });
  }

  if (mqi.compromisedMarkets.length > 0) {
    const compromisedPct = mqi.compromisedPercent;
    const reasonsSummary = mqi.compromisedMarkets.map(m => `${m.collateralSymbol}/${m.loanSymbol} (${m.weightPercent}% TVL): ${m.reasons.join(', ')}`).join('; ');
    redFlags.push({
      level: 'CRITICAL',
      title: 'Compromised Market Exposure',
      message: `${compromisedPct}% of capital is deployed in markets with verification issues or bad debt (${reasonsSummary}).`
    });
  }

  // Flag 1b: Material capital behind V2 adapters whose markets could not be resolved (see mqiEngine)
  if (mqi.unresolvedAssetsUsd > 0) {
    const unresolvedPct = mqi.unresolvedPercent;
    redFlags.push({
      level: 'HIGH',
      title: 'Unresolved Exposure',
      message: `${unresolvedPct}% of capital ($${(mqi.unresolvedAssetsUsd / 1e6).toFixed(2)}M) sits in positions whose underlying markets could not be resolved; its quality, concentration and exit liquidity are unknown. It is left out of the MQI score until the data is available.`
    });
  }

  // Flag 1c: Markets whose bad debt or warnings data did not come back from the API
  if (mqi.unverifiedMarkets.length > 0) {
    const marketsSummary = mqi.unverifiedMarkets.map(m => `${m.collateralSymbol}/${m.loanSymbol} (${m.weightPercent}%): ${m.reasons.join(', ')}`).join('; ');
    redFlags.push({
      level: 'MEDIUM',
      title: 'Unverified Markets',
      message: `Markets holding capital the API returned incomplete data for (${marketsSummary}) are not confirmed clean or compromised and are left out of the MQI score until the data is available.`
    });
  }

  // Flag 2: Collateral class mix. Tokens are grouped by what can go wrong with them, so the share in high-risk
  // classes (off-chain credit, volatile alts, unclassified) says more than how many different tokens there are.
  if (collateral.level) {
    const riskyClasses = collateral.classes.filter(c => c.weight !== 'low').map(c => `${c.label} ${c.percent}%`).join(', ');
    redFlags.push(collateral.level === 'RED'
      ? { level: 'HIGH', title: 'High-Risk Collateral', message: `${collateral.highPercent}% of vault capital is lent against high-risk collateral classes (${riskyClasses}).` }
      : { level: 'MEDIUM', title: 'Elevated-Risk Collateral', message: `${collateral.mediumPlusPercent}% of vault capital is lent against synthetic, fixed-maturity or higher-risk collateral (${riskyClasses}).` });
  }

  // Flag 3: Severe Exit Liquidity Lockup (null < 20 is true in JS, so unknown exit is handled first)
  if (liquidity.exitUnknown) {
    // unpriced and unexpanded capital already carry their own flag with the real reason
    if (liquidity.exitUnknownReason === 'not_reported') {
      redFlags.push({
        level: 'MEDIUM',
        title: 'Unknown Exit Liquidity',
        message: 'Withdrawable liquidity was not reported for this vault, so how much of the deposits can be withdrawn immediately is unknown.'
      });
    }
  } else if (liquidity.instantExitCapacityPercent < 20) {
    redFlags.push({
      level: 'HIGH',
      title: 'Restricted Exit Liquidity',
      message: `Only ${liquidity.instantExitCapacityPercent}% ($${(liquidity.instantExitCapacityUsd / 1e6).toFixed(2)}M) of ${liquidity.unverifiedPercent > 0 ? 'the verified deposits' : 'deposits'} can be withdrawn immediately without waiting for borrower repayments.`
    });
  }

  // Flag 4: Crowded Exit Contagion / Shared Market Overhang
  if (!liquidity.exitUnknown && liquidity.crowdedMarkets && liquidity.crowdedMarkets.length > 0) {
    const totalCrowdedSupplyUsd = liquidity.crowdedMarkets.reduce((sum, m) => sum + m.vaultSupplyUsd, 0);
    const totalAssetsUsd = Number(vault.total_assets_usd) || 0;
    // Частка від TVL (vault capital), а не від розподіленого капіталу: на цю базу відкалібровані пороги 15/25/35
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
        message: `Competing peer vaults (${topPeersStr}) reduce available exit from ${liquidity.instantExitCapacityPercent}% to ${liquidity.stressedExitCapacityPercent}% across ${crowdedSharePercent}% of vault capital during a mass withdrawal.`
      });
    }
  }

  // 5. Negative Net APY (Capital Decay / Yield Deficit)
  const netApy = Number(vault.net_apy) || 0;
  if (netApy < 0) {
    const netApyPct = (netApy * 100).toFixed(2);
    redFlags.push({
      level: netApy < -0.05 ? 'CRITICAL' : 'HIGH',
      title: 'Negative Net APY (Capital Decay)',
      message: `Vault has a negative net yield of ${netApyPct}%, indicating active loss of depositor principal due to realized bad debt or excessive curator fees.`
    });
  }

  // 6. Plaintext Objective Summary
  let exitSummary = liquidity.exitUnknown ? 'Exit Liquidity: unknown' : `Exit Liquidity: ${liquidity.instantExitCapacityPercent}%${liquidity.unverifiedPercent > 0 ? ' of verified capital' : ''}`;
  if (liquidity.isCrowded) {
    exitSummary += ` (worst-case: ${liquidity.stressedExitCapacityPercent}%)`;
  }
  let mqiText = mqi.mqiPercent == null
    ? (mqi.unpriced ? 'unknown (no USD price)' : 'not available (no capital could be verified)')
    : mqi.unverifiedAssetsUsd > 0
      ? `${mqi.mqiPercent}% of verified capital is clean (${mqi.unverifiedPercent}% of capital unverified)`
      : `${mqi.mqiPercent}% clean capital`;
  // A rounded 100 next to a real defect must not read as fully clean
  if (mqi.compromisedMarkets.length > 0 && mqi.mqiPercent === 100) mqiText += ` (${mqi.compromisedPercent}% in compromised markets)`;
  const top = collateral.classes[0];
  let summary = collateral.tier === 'CLASSIFIED'
    ? `MQI: ${mqiText}. Collateral: ${top.label} ${top.percent}%, high-risk ${collateral.highPercent}%. ${exitSummary}.`
    : `MQI: ${mqiText}. Collateral: N/A. ${exitSummary}.`;

  return {
    vaultAddress: vault.address,
    vaultName: vault.name,
    version: vault.version,
    chainId: vault.chain_id,
    summary,
    redFlags,
    mqi,
    hhi,
    collateral,
    liquidity
  };
}
