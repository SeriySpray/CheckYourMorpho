import { isIdleReserveMarket } from './hhiEngine.js';
import { isUnpricedVault } from './mqiEngine.js';

// Morpho keeps markets near 90% utilization, so a vault with 10-20% instant exit is the normal state. Under 5% means the
// markets are past 95% utilization (borrow rates already well above target). Dust vaults are left out.
export const LOW_EXIT_PERCENT = 5;
export const LOW_EXIT_MIN_TVL_USD = 10e3;

/**
 * Liquidity & Exit Capacity Engine
 * Calculates the instant exit capacity of a vault.
 *
 * Total Available Exit = Direct Idle Cash + sum(min(Vault Supply in Market_i, Free Liquidity in Market_i))
 * Instant Exit Capacity % = (Total Available Exit / Verified Vault Assets) * 100%
 * Verified assets exclude capital behind adapters that could not be expanded: with no data about it, it neither
 * lowers nor raises the figure, and is reported as unverifiedPercent instead.
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
      isIlliquid: unpriced ? null : false,
      exitUnknown: unpriced,
      exitUnknownReason: unpriced ? 'unpriced' : null,
      unverifiedPercent: 0
    };
  }

  // Capital behind adapters we could not look through: its exit is unknown, so it is not part of the base
  const unresolvedUsd = Math.min(totalAssetsUsd, Math.max(0, Number(vault.unresolved_exposure_usd) || 0));
  const knownAssetsUsd = totalAssetsUsd - unresolvedUsd;
  const unverifiedPercent = Math.round((unresolvedUsd / totalAssetsUsd) * 10000) / 100;
  if (knownAssetsUsd <= 0) {
    return {
      directLiquidityUsd: 0,
      marketExitCapacityUsd: 0,
      instantExitCapacityUsd: null,
      instantExitCapacityPercent: null,
      isIlliquid: null,
      exitUnknown: true,
      exitUnknownReason: 'unresolved',
      unverifiedPercent
    };
  }

  let loanMarketsExitUsd = 0;
  let idleAllocationsUsd = 0;
  let totalAllocatedUsd = 0;
  let sharedExitUsd = 0;
  let sharedMarkets = 0;
  let proportionalMarketsUsd = 0;

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

      const canExitUsd = Math.min(supplyUsd, marketFreeLiquidityUsd);
      loanMarketsExitUsd += canExitUsd;
      // If every other lender withdraws first, the vault keeps only supply - borrow; the free cash they can take ahead of it is
      // min(exit, what the others supplied). With everyone leaving together each gets the free cash in proportion to its supply.
      const othersSupplyUsd = Math.max(0, marketTotalSupplyUsd - supplyUsd);
      const contestedUsd = Math.min(canExitUsd, othersSupplyUsd);
      if (contestedUsd > 0) {
        sharedExitUsd += contestedUsd;
        sharedMarkets++;
      }
      proportionalMarketsUsd += marketTotalSupplyUsd > 0 ? Math.min(supplyUsd, marketFreeLiquidityUsd * supplyUsd / marketTotalSupplyUsd) : canExitUsd;
    }
  }

  // True unallocated cash (not at risk in loan markets):
  // either in a 0-LLTV idle market or unallocated cash difference on the vault contract
  // (і без жодної алокації: результат той самий, що й для рядків із нульовим постачанням).
  const unallocatedCashUsd = Math.max(0, totalAssetsUsd - totalAllocatedUsd - unresolvedUsd);
  const trueIdleCashUsd = idleAllocationsUsd + unallocatedCashUsd;

  // Combined exit capacity = true idle cash + loan markets free cash (cannot exceed totalAssetsUsd),
  // capped by the API-reported withdrawable liquidity (V2: idle + liquidity adapter + force-deallocatable
  // liquidity net of its penalty), which can be lower than the market-based figure.
  const totalEffectiveExitUsd = Math.min(knownAssetsUsd, directLiquidityUsd, trueIdleCashUsd + loanMarketsExitUsd);
  const instantExitCapacityPercent = Math.min(100, Math.max(0, Math.round((totalEffectiveExitUsd / knownAssetsUsd) * 1000) / 10));
  // The reported-liquidity cap shrinks the exit, so it shrinks the shared part by the same factor
  const capFactor = trueIdleCashUsd + loanMarketsExitUsd > 0 ? totalEffectiveExitUsd / (trueIdleCashUsd + loanMarketsExitUsd) : 0;
  const proportionalExitUsd = Math.min(knownAssetsUsd, directLiquidityUsd, trueIdleCashUsd + proportionalMarketsUsd);

  // Without reported liquidity the exit figures stay null instead of an optimistic market-only estimate
  const known = value => (exitUnknown ? null : value);
  return {
    directLiquidityUsd: Math.round(trueIdleCashUsd * 100) / 100,
    marketExitCapacityUsd: Math.round(loanMarketsExitUsd * 100) / 100,
    instantExitCapacityUsd: known(Math.round(totalEffectiveExitUsd * 100) / 100),
    instantExitCapacityPercent: known(instantExitCapacityPercent),
    isIlliquid: known(instantExitCapacityPercent < LOW_EXIT_PERCENT),
    exitUnknown,
    exitUnknownReason: exitUnknown ? 'not_reported' : null,
    unverifiedPercent,
    // Part of the exit that rests on free cash shared with other lenders (an upper bound for each of them), as a share of the exit
    sharedExitPercent: known(totalEffectiveExitUsd > 0 ? Math.min(100, Math.round((sharedExitUsd * capFactor / totalEffectiveExitUsd) * 100)) : 0),
    sharedMarkets,
    // The exit if every lender of the shared markets left at once: free cash split by supply, so it is never counted twice
    proportionalExitPercent: known(Math.min(100, Math.max(0, Math.round((proportionalExitUsd / knownAssetsUsd) * 1000) / 10)))
  };
}
