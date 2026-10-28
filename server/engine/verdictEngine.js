import { calculateMQI, withMaterialUnresolved, getMaterialityThresholdUsd } from './mqiEngine.js';
import { calculateHHI } from './hhiEngine.js';
import { calculateCollateralMix } from './collateralEngine.js';
import { calculateLiquidityMetrics, LOW_EXIT_PERCENT, LOW_EXIT_MIN_TVL_USD } from './liquidityEngine.js';

const exitUsdText = usd => (usd >= 1e6 ? `$${(usd / 1e6).toFixed(2)}M` : usd >= 1e3 ? `$${(usd / 1e3).toFixed(1)}K` : `$${Math.round(usd)}`);

/**
 * Synthesizes the institutional vault audit based strictly on:
 * 1. Market Quality Index (MQI)
 * 2. Collateral breakdown by token (no judgement of tokens here, see token_data); the HHI is still returned for reference
 * 3. Instant Exit Capacity
 * 
 * @param {object} vault Vault row from database
 * @param {Array<object>} allocations Active allocations joined with markets
 * @returns {object} Clean institutional audit verdict
 */
export function generateVaultVerdict(vault, allocations = []) {
  // 1. Market Quality Index (MQI) [0% - 100%]
  const mqi = calculateMQI(vault, allocations);
  // Red flags need their capital to be material; the score above counts every dollar
  const materialUsd = getMaterialityThresholdUsd(vault.total_assets_usd);

  // 2. Herfindahl-Hirschman Concentration Index (HHI) [0.00 - 1.00]
  const hhi = calculateHHI(withMaterialUnresolved(vault, mqi), allocations);
  const collateral = calculateCollateralMix(withMaterialUnresolved(vault, mqi), allocations);

  // 3. Instant Exit Liquidity
  const liquidity = calculateLiquidityMetrics(withMaterialUnresolved(vault, mqi), allocations);

  // 4. Objective, Fact-Based Audit Flags
  const redFlags = [];

  // Flag 1: Compromised or Defaulted Markets. The score counts every position; the red flag needs their sum to be
  // material (getMaterialityThresholdUsd), so a few dollars in a defective market do not turn a vault red.
  if (mqi.unpriced) {
    redFlags.push({
      level: 'HIGH',
      title: 'Unpriced Vault',
      message: 'The vault holds assets but no USD price is available for them, so market quality, concentration and exit liquidity cannot be measured.'
    });
  }

  if (mqi.compromisedAssetsUsd >= materialUsd && mqi.compromisedMarkets.length > 0) {
    const compromisedPct = mqi.compromisedPercent;
    const reasonsSummary = mqi.compromisedMarkets.map(m => `${m.collateralSymbol}/${m.loanSymbol} (${m.weightPercent}% TVL): ${m.reasons.join(', ')}`).join('; ');
    redFlags.push({
      level: 'CRITICAL',
      title: 'Compromised Market Exposure',
      message: `${compromisedPct}% of capital is deployed in markets with verification issues or bad debt (${reasonsSummary}).`
    });
  }

  // Flag 1b: Material capital behind V2 adapters whose markets could not be resolved (see mqiEngine)
  if (mqi.unresolvedAssetsUsd > 0 && mqi.unresolvedAssetsUsd >= materialUsd) {
    const unresolvedPct = mqi.unresolvedPercent;
    redFlags.push({
      level: 'HIGH',
      title: 'Unresolved Exposure',
      message: `${unresolvedPct}% of capital ($${(mqi.unresolvedAssetsUsd / 1e6).toFixed(2)}M) sits in positions whose underlying markets could not be resolved; its quality, concentration and exit liquidity are unknown. It is left out of the MQI score until the data is available.`
    });
  }

  // Flag 1c: Markets whose bad debt or warnings data did not come back from the API
  if (mqi.unverifiedMarkets.length > 0 && mqi.unverifiedMarkets.reduce((acc, m) => acc + m.supplyAssetsUsd, 0) >= materialUsd) {
    const marketsSummary = mqi.unverifiedMarkets.map(m => `${m.collateralSymbol}/${m.loanSymbol} (${m.weightPercent}%): ${m.reasons.join(', ')}`).join('; ');
    redFlags.push({
      level: 'MEDIUM',
      title: 'Unverified Markets',
      message: `Markets holding capital the API returned incomplete data for (${marketsSummary}) are not confirmed clean or compromised and are left out of the MQI score until the data is available.`
    });
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
  } else if (liquidity.instantExitCapacityPercent < LOW_EXIT_PERCENT && Number(vault.total_assets_usd) >= LOW_EXIT_MIN_TVL_USD) {
    redFlags.push({
      level: 'MEDIUM',
      title: 'Restricted Exit Liquidity',
      message: `Only ${liquidity.instantExitCapacityPercent}% (${exitUsdText(liquidity.instantExitCapacityUsd)}) of ${liquidity.unverifiedPercent > 0 ? 'the verified deposits' : 'deposits'} can be withdrawn immediately without waiting for borrower repayments.`
    });
  }

  // 5. Negative Net APY (Capital Decay / Yield Deficit)
  const netApy = Number(vault.net_apy) || 0;
  if (netApy < 0) {
    const pct = x => `${(x * 100).toFixed(2)}%`;
    const grossApy = Number(vault.apy) || 0;
    const managementFee = Number(vault.management_fee) || 0;
    // A non-negative gross yield with a negative net one means the fees eat it: small and not a loss of principal. A negative gross yield can come from realized losses.
    const feeDriven = grossApy >= 0;
    redFlags.push({
      level: feeDriven ? (netApy < -0.01 ? 'HIGH' : 'MEDIUM') : (netApy < -0.05 ? 'CRITICAL' : 'HIGH'),
      title: 'Negative Net APY (Capital Decay)',
      message: feeDriven
        ? `Net yield is ${pct(netApy)}: the gross yield of ${pct(grossApy)} is below ${managementFee > 0 ? `the ${pct(managementFee)} management fee` : 'the fees charged'}.`
        : `Net yield is ${pct(netApy)} and the gross yield itself is negative (${pct(grossApy)}), which can come from realized losses.`
    });
  }

  // 6. Plaintext Objective Summary
  const exitSummary = liquidity.exitUnknown ? 'Exit Liquidity: unknown' : `Exit Liquidity: ${liquidity.instantExitCapacityPercent}%${liquidity.unverifiedPercent > 0 ? ' of verified capital' : ''}`;
  let mqiText = mqi.mqiPercent == null
    ? (mqi.unpriced ? 'unknown (no USD price)' : 'not available (no capital could be verified)')
    : mqi.unverifiedAssetsUsd > 0
      ? `${mqi.mqiPercent}% of the checked capital has no defect found (${mqi.unverifiedPercent}% of capital unchecked)`
      : `${mqi.mqiPercent}% of capital has no defect found`;
  // A rounded 100 next to a real defect must not read as fully clean
  const summary = `MQI: ${mqiText}. ${exitSummary}.`;

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
