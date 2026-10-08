import { isIdleReserveMarket } from './hhiEngine.js';

/**
 * Liquidity & Exit Capacity Engine
 * Calculates both normal instant exit capacity and stressed pro-rata exit capacity
 * under concurrent multi-vault withdrawal runs on shared markets.
 * 
 * Normal Exit:
 * Total Available Exit = Direct Idle Cash + sum(min(Vault Supply in Market_i, Free Liquidity in Market_i))
 * Instant Exit Capacity % = (Total Available Exit / Total Vault Assets) * 100%
 * 
 * Stressed Pro-Rata Exit:
 * In a simultaneous bank run, Free Liquidity in Market_i is contested by all competing vaults:
 * Stressed Exit_i = min(Vault Supply_i, Free Liquidity_i * (Vault Supply_i / Total Vault Supply_i))
 */

/**
 * Calculates exit liquidity metrics for a vault.
 * 
 * @param {object} vault Vault row from database
 * @param {Array<object>} allocations Array of vault allocations joined with market data
 * @returns {object} Liquidity analytics
 */
export function calculateLiquidityMetrics(vault, allocations = []) {
  const totalAssetsUsd = Number(vault.total_assets_usd) || 0;
  const directLiquidityUsd = Number(vault.liquidity_usd) || 0;

  if (totalAssetsUsd <= 0) {
    return {
      directLiquidityUsd: 0,
      marketExitCapacityUsd: 0,
      instantExitCapacityUsd: 0,
      instantExitCapacityPercent: 100,
      stressedExitCapacityUsd: 0,
      stressedExitCapacityPercent: 100,
      crowdedMarkets: [],
      isIlliquid: false,
      isCrowded: false
    };
  }

  let loanMarketsExitUsd = 0;
  let loanMarketsStressedExitUsd = 0;
  let idleAllocationsUsd = 0;
  let totalAllocatedUsd = 0;
  const crowdedMarkets = [];
  const minMaterialThresholdUsd = totalAssetsUsd * 0.01;

  for (const alloc of allocations) {
    const supplyUsd = Number(alloc.supply_assets_usd) || 0;
    totalAllocatedUsd += supplyUsd;

    const isIdle = isIdleReserveMarket(alloc);

    if (isIdle) {
      idleAllocationsUsd += supplyUsd;
    } else {
      const marketTotalSupplyUsd = Number(alloc.total_supply_assets_usd) || 0;
      const marketTotalBorrowUsd = Number(alloc.total_borrow_assets_usd) || 0;
      const marketFreeLiquidityUsd = Math.max(0, marketTotalSupplyUsd - marketTotalBorrowUsd);

      // Normal instant exit capacity
      const canExitUsd = Math.min(supplyUsd, marketFreeLiquidityUsd);
      loanMarketsExitUsd += canExitUsd;

      // Stressed pro-rata exit capacity considering competing peer vaults and direct market lenders
      const peerSupplyUsd = Number(alloc.peer_supply_usd) || 0;
      const totalCompetitionUsd = Math.max(supplyUsd + peerSupplyUsd, marketTotalSupplyUsd);

      let stressedExitUsd = canExitUsd;
      if (totalCompetitionUsd > 0 && marketFreeLiquidityUsd > 0) {
        const proRataShare = supplyUsd / totalCompetitionUsd;
        stressedExitUsd = Math.min(supplyUsd, marketFreeLiquidityUsd * proRataShare);
      } else if (marketFreeLiquidityUsd <= 0) {
        stressedExitUsd = 0;
      }
      loanMarketsStressedExitUsd += stressedExitUsd;

      // Crowded market detection:
      // 1. Peer supply alone >= market free liquidity (competing claims exceed cash)
      // 2. Competing vaults materially dilute our exit capacity (by >= 30%) or market has 0 free liquidity
      // 3. Materiality check: vault capital must exceed 1.0% of total vault assets
      const hasSignificantDilution = (marketFreeLiquidityUsd === 0 && supplyUsd > 0) ||
        (canExitUsd > 0 && stressedExitUsd < canExitUsd * 0.70);
      const isCrowded = peerSupplyUsd > 0 &&
        (peerSupplyUsd >= marketFreeLiquidityUsd) &&
        hasSignificantDilution;

      if (isCrowded && supplyUsd > minMaterialThresholdUsd) {
        const topPeersList = (alloc.peer_vaults || []).slice(0, 3).map(p => {
          const m = p.supplyUsd >= 1e6 ? `$${(p.supplyUsd / 1e6).toFixed(1)}M` : `$${(p.supplyUsd / 1e3).toFixed(0)}K`;
          return `${p.vaultName || 'Vault'} (${m})`;
        });

        crowdedMarkets.push({
          marketUniqueKey: alloc.market_unique_key,
          collateralSymbol: alloc.collateral_asset_symbol || 'None',
          loanSymbol: alloc.loan_asset_symbol || '',
          vaultSupplyUsd: supplyUsd,
          peerSupplyUsd,
          freeLiquidityUsd: marketFreeLiquidityUsd,
          normalExitUsd: canExitUsd,
          stressedExitUsd: Math.round(stressedExitUsd * 100) / 100,
          topPeers: topPeersList
        });
      }
    }
  }

  // True unallocated cash (not at risk in loan markets):
  // either in a 0-LLTV idle market or unallocated cash difference on the vault contract
  const unallocatedCashUsd = Math.max(0, totalAssetsUsd - totalAllocatedUsd);
  const trueIdleCashUsd = allocations.length > 0
    ? idleAllocationsUsd + unallocatedCashUsd
    : (directLiquidityUsd > 0 ? Math.min(totalAssetsUsd, directLiquidityUsd) : totalAssetsUsd);

  // Combined normal exit capacity = true idle cash + loan markets free cash (cannot exceed totalAssetsUsd)
  const totalEffectiveExitUsd = Math.min(totalAssetsUsd, trueIdleCashUsd + loanMarketsExitUsd);
  const instantExitCapacityPercent = Math.min(100, Math.max(0, Math.round((totalEffectiveExitUsd / totalAssetsUsd) * 1000) / 10));

  // Combined stressed exit capacity = true idle cash + loan markets stressed pro-rata cash
  const totalStressedExitUsd = Math.min(totalAssetsUsd, trueIdleCashUsd + loanMarketsStressedExitUsd);
  const stressedExitCapacityPercent = Math.min(100, Math.max(0, Math.round((totalStressedExitUsd / totalAssetsUsd) * 1000) / 10));

  // Sort crowded markets descending by vault's exposed capital
  crowdedMarkets.sort((a, b) => b.vaultSupplyUsd - a.vaultSupplyUsd);

  const capacityDrop = instantExitCapacityPercent - stressedExitCapacityPercent;
  const relativeDrop = instantExitCapacityPercent > 0 ? capacityDrop / instantExitCapacityPercent : 0;
  const isCrowded = crowdedMarkets.length > 0 && (
    capacityDrop >= 15 ||
    (instantExitCapacityPercent >= 10 && stressedExitCapacityPercent < 10) ||
    (instantExitCapacityPercent > 0 && relativeDrop >= 0.50)
  );

  return {
    directLiquidityUsd: Math.round(trueIdleCashUsd * 100) / 100,
    marketExitCapacityUsd: Math.round(loanMarketsExitUsd * 100) / 100,
    instantExitCapacityUsd: Math.round(totalEffectiveExitUsd * 100) / 100,
    instantExitCapacityPercent,
    stressedExitCapacityUsd: Math.round(totalStressedExitUsd * 100) / 100,
    stressedExitCapacityPercent,
    crowdedMarkets,
    isIlliquid: instantExitCapacityPercent < 20,
    isCrowded
  };
}
