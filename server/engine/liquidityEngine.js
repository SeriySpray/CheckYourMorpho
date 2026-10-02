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

  for (const alloc of allocations) {
    const supplyUsd = Number(alloc.supply_assets_usd) || 0;
    totalAllocatedUsd += supplyUsd;

    const lltvNum = Number(alloc.lltv) || Number(alloc.lltv_percent) || 0;
    const isIdle = lltvNum === 0 && (!alloc.collateral_asset_symbol || alloc.collateral_asset_symbol === 'NONE');

    if (isIdle) {
      idleAllocationsUsd += supplyUsd;
    } else {
      const marketTotalSupplyUsd = Number(alloc.total_supply_assets_usd) || 0;
      const marketTotalBorrowUsd = Number(alloc.total_borrow_assets_usd) || 0;
      const marketFreeLiquidityUsd = Math.max(0, marketTotalSupplyUsd - marketTotalBorrowUsd);

      // Normal instant exit capacity
      const canExitUsd = Math.min(supplyUsd, marketFreeLiquidityUsd);
      loanMarketsExitUsd += canExitUsd;

      // Stressed pro-rata exit capacity considering competing peer vaults
      const peerSupplyUsd = Number(alloc.peer_supply_usd) || 0;
      const totalVaultCompetitionUsd = supplyUsd + peerSupplyUsd;

      let stressedExitUsd = canExitUsd;
      if (totalVaultCompetitionUsd > 0 && marketFreeLiquidityUsd > 0) {
        const proRataShare = supplyUsd / totalVaultCompetitionUsd;
        stressedExitUsd = Math.min(supplyUsd, marketFreeLiquidityUsd * proRataShare);
      } else if (marketFreeLiquidityUsd <= 0) {
        stressedExitUsd = 0;
      }
      loanMarketsStressedExitUsd += stressedExitUsd;

      // Crowded market detection: Peer supply >= market free liquidity
      // (peer vaults alone hold enough capital to drain 100% of market free liquidity)
      const isCrowded = peerSupplyUsd > 0 && (peerSupplyUsd >= marketFreeLiquidityUsd || (marketFreeLiquidityUsd === 0 && supplyUsd > 0));
      if (isCrowded && supplyUsd > 1000) {
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
  // either in a 0-LLTV idle market, directly on the vault contract, or unallocated difference
  const trueIdleCashUsd = Math.max(
    directLiquidityUsd,
    idleAllocationsUsd,
    Math.max(0, totalAssetsUsd - totalAllocatedUsd)
  );

  // Combined normal exit capacity = true idle cash + loan markets free cash (cannot exceed totalAssetsUsd)
  const totalEffectiveExitUsd = Math.min(totalAssetsUsd, trueIdleCashUsd + loanMarketsExitUsd);
  const instantExitCapacityPercent = Math.min(100, Math.max(0, Math.round((totalEffectiveExitUsd / totalAssetsUsd) * 1000) / 10));

  // Combined stressed exit capacity = true idle cash + loan markets stressed pro-rata cash
  const totalStressedExitUsd = Math.min(totalAssetsUsd, trueIdleCashUsd + loanMarketsStressedExitUsd);
  const stressedExitCapacityPercent = Math.min(100, Math.max(0, Math.round((totalStressedExitUsd / totalAssetsUsd) * 1000) / 10));

  // Sort crowded markets descending by vault's exposed capital
  crowdedMarkets.sort((a, b) => b.vaultSupplyUsd - a.vaultSupplyUsd);

  return {
    directLiquidityUsd: Math.round(trueIdleCashUsd * 100) / 100,
    marketExitCapacityUsd: Math.round(loanMarketsExitUsd * 100) / 100,
    instantExitCapacityUsd: Math.round(totalEffectiveExitUsd * 100) / 100,
    instantExitCapacityPercent,
    stressedExitCapacityUsd: Math.round(totalStressedExitUsd * 100) / 100,
    stressedExitCapacityPercent,
    crowdedMarkets,
    isIlliquid: instantExitCapacityPercent < 20,
    isCrowded: crowdedMarkets.length > 0 && (instantExitCapacityPercent - stressedExitCapacityPercent >= 10)
  };
}
