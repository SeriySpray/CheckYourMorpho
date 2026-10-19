import { isIdleReserveMarket } from './hhiEngine.js';
import { isUnpricedVault } from './mqiEngine.js';

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
  const totalAssetsUsd = Number(vault.total_assets_usd ?? vault.totalAssetsUsd) || 0;
  // Absent or non-numeric = the API did not report it, so exit is unknown; 0 = nothing withdrawable right now
  const reportedLiquidity = vault.liquidity_usd ?? vault.liquidityUsd;
  const exitUnknown = reportedLiquidity == null || reportedLiquidity === '' || !Number.isFinite(Number(reportedLiquidity));
  const directLiquidityUsd = exitUnknown ? 0 : Math.max(0, Number(reportedLiquidity));

  if (totalAssetsUsd <= 0) {
    // Assets without a USD value: how much can be withdrawn is unknown, not 100%
    const unpriced = isUnpricedVault(vault);
    return {
      directLiquidityUsd: 0,
      marketExitCapacityUsd: 0,
      instantExitCapacityUsd: unpriced ? null : 0,
      instantExitCapacityPercent: unpriced ? null : 100,
      stressedExitCapacityUsd: unpriced ? null : 0,
      stressedExitCapacityPercent: unpriced ? null : 100,
      crowdedMarkets: [],
      isIlliquid: unpriced ? null : false,
      isCrowded: false,
      exitUnknown: unpriced
    };
  }

  let loanMarketsExitUsd = 0;
  let loanMarketsStressedExitUsd = 0;
  let idleAllocationsUsd = 0;
  let totalAllocatedUsd = 0;
  const crowdedMarkets = [];
  const minMaterialThresholdUsd = totalAssetsUsd * 0.01;

  for (const alloc of allocations) {
    const supplyUsd = Math.max(0, Number(alloc.supply_assets_usd) || 0);
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

      // Stressed pro-rata exit capacity: every vault with a position in this market runs for the exit at once,
      // so free liquidity is shared pro rata with the other vaults (direct lenders are not part of this scenario,
      // they are already reflected in the market's utilization and therefore in the normal exit)
      const peerSupplyUsd = Number(alloc.peer_supply_usd) || 0;
      const totalCompetitionUsd = supplyUsd + peerSupplyUsd;

      let stressedExitUsd = canExitUsd;
      if (totalCompetitionUsd > 0 && marketFreeLiquidityUsd > 0) {
        const proRataShare = supplyUsd / totalCompetitionUsd;
        stressedExitUsd = Math.min(supplyUsd, marketFreeLiquidityUsd * proRataShare);
      } else if (marketFreeLiquidityUsd <= 0) {
        stressedExitUsd = 0;
      }
      loanMarketsStressedExitUsd += stressedExitUsd;

      // Crowded market detection:
      // 1. Competing peer vaults' supply >= market free liquidity
      // 2. Peers materially dilute our exit capacity (by >= 30%) or market has 0 free liquidity
      // 3. Materiality check: vault capital must exceed 1.0% of total vault assets
      const totalContestedClaimsUsd = peerSupplyUsd;
      const hasSignificantDilution = (marketFreeLiquidityUsd === 0 && supplyUsd > 0) ||
        (canExitUsd > 0 && stressedExitUsd < canExitUsd * 0.70);
      const isCrowded = totalContestedClaimsUsd > 0 &&
        (totalContestedClaimsUsd >= marketFreeLiquidityUsd) &&
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
  // (і без жодної алокації: результат той самий, що й для рядків із нульовим постачанням).
  // Exposure behind V2 adapters we could not look through is not cash: its exit is unknown, counted as none.
  const unresolvedUsd = Math.max(0, Number(vault.unresolved_exposure_usd) || 0);
  const unallocatedCashUsd = Math.max(0, totalAssetsUsd - totalAllocatedUsd - unresolvedUsd);
  const trueIdleCashUsd = idleAllocationsUsd + unallocatedCashUsd;

  // Combined normal exit capacity = true idle cash + loan markets free cash (cannot exceed totalAssetsUsd),
  // capped by the API-reported withdrawable liquidity (V2: idle + liquidity adapter + force-deallocatable
  // liquidity net of its penalty), which can be lower than the market-based figure.
  const totalEffectiveExitUsd = Math.min(totalAssetsUsd, directLiquidityUsd, trueIdleCashUsd + loanMarketsExitUsd);
  const instantExitCapacityPercent = Math.min(100, Math.max(0, Math.round((totalEffectiveExitUsd / totalAssetsUsd) * 1000) / 10));

  // Combined stressed exit capacity = true idle cash + loan markets stressed pro-rata cash
  const totalStressedExitUsd = Math.min(totalAssetsUsd, directLiquidityUsd, trueIdleCashUsd + loanMarketsStressedExitUsd);
  const stressedExitCapacityPercent = Math.min(100, Math.max(0, Math.round((totalStressedExitUsd / totalAssetsUsd) * 1000) / 10));

  // Sort crowded markets descending by vault's exposed capital
  crowdedMarkets.sort((a, b) => b.vaultSupplyUsd - a.vaultSupplyUsd);

  const capacityDrop = instantExitCapacityPercent - stressedExitCapacityPercent;
  const relativeDrop = instantExitCapacityPercent > 0 ? capacityDrop / instantExitCapacityPercent : 0;
  const isCrowded = !exitUnknown && crowdedMarkets.length > 0 && (
    capacityDrop >= 15 ||
    (instantExitCapacityPercent >= 10 && stressedExitCapacityPercent < 10) ||
    (instantExitCapacityPercent > 0 && relativeDrop >= 0.50)
  );

  // Without reported liquidity the exit figures stay null instead of an optimistic market-only estimate
  const known = value => (exitUnknown ? null : value);
  return {
    directLiquidityUsd: Math.round(trueIdleCashUsd * 100) / 100,
    marketExitCapacityUsd: Math.round(loanMarketsExitUsd * 100) / 100,
    instantExitCapacityUsd: known(Math.round(totalEffectiveExitUsd * 100) / 100),
    instantExitCapacityPercent: known(instantExitCapacityPercent),
    stressedExitCapacityUsd: known(Math.round(totalStressedExitUsd * 100) / 100),
    stressedExitCapacityPercent: known(stressedExitCapacityPercent),
    crowdedMarkets,
    isIlliquid: known(instantExitCapacityPercent < 20),
    isCrowded,
    exitUnknown
  };
}
