/**
 * Market Quality Index (MQI) Engine
 * Evaluates the strict, objective, on-chain cleanliness of capital allocation.
 * 
 * Formula:
 * MQI = clean / (clean + compromised), measured on the capital that could be verified.
 * Clean capital includes idle cash on the vault contract and idle (0-LLTV) reserve markets.
 *
 * A market is clean if:
 *   - it is officially listed in Morpho (is_listed == 1)
 *   - it has no material active or realized bad debt (above a dust threshold scaled to market size)
 *   - it has a valid oracle contract address (borrowing markets only)
 *   - it has no critical protocol security warnings (not_whitelisted, or a RED integrity warning)
 * It is compromised if any of these is violated (a known defect), and unverified if the API did not
 * report the data to decide. Unverified markets and unexpanded adapters leave the denominator and are
 * reported separately. A defective position counts once it is material (see getMaterialityThresholdUsd);
 * small ones count together once their sum reaches the threshold. MQI is null if nothing could be verified.
 */


import { isIdleReserveMarket } from './hhiEngine.js';

/**
 * Minimum allocation (USD) that counts as material for a vault: 1% of TVL, but never more
 * than $250K, so a flagged position in a very large vault cannot hide below a percentage cut.
 * shortcut: fixed $250K cap, make it configurable if vault sizes shift by orders of magnitude.
 */
export function getMaterialityThresholdUsd(totalAssetsUsd) {
  return Math.min((Number(totalAssetsUsd) || 0) * 0.01, 250000);
}

/** A vault that holds assets but has no USD value (the asset price is unknown): its USD metrics cannot be trusted. */
export function isUnpricedVault(vault) {
  return (Number(vault.total_assets_usd) || 0) <= 0 && (Number(vault.total_assets) || 0) > 0;
}

/**
 * Evaluates whether a market passes the strict binary clean test.
 * @param {object} market Market record from database
 * @returns {object} { isClean: boolean, reasons: string[] }
 */
export function isMarketClean(market) {
  const reasons = [];
  // Data the API did not return: the market is unverified (not clean, not known to be defective)
  const unverifiedReasons = [];

  // Check 1: Listed status
  const isListed = Number(market.is_listed ?? 1) === 1;
  if (!isListed) {
    reasons.push('Unlisted market (not verified by Morpho)');
  }

  // Check 2: Bad Debt & Realized Bad Debt. Dust threshold scales with market size (min $10, 0.01% of
  // market supply) so a historical sub-0.01% write-off does not taint a large market forever.
  const badDebtUsd = Math.max(0, Number(market.bad_debt_usd || 0));
  const realizedBadDebtUsd = Math.max(0, Number(market.realized_bad_debt_usd || 0));
  // null = the API did not report it (an absent field on a plain object, as in fixtures, is not reported either way);
  // a value that is not a number is unreadable, which is the same thing
  if (market.bad_debt_usd === null || market.realized_bad_debt_usd === null
    || !Number.isFinite(badDebtUsd) || !Number.isFinite(realizedBadDebtUsd)) {
    unverifiedReasons.push('Bad debt data not reported');
  }
  const badDebtDustUsd = Math.max(10, (Number(market.total_supply_assets_usd) || 0) * 0.0001);
  const totalBadDebt = badDebtUsd + realizedBadDebtUsd;
  if (totalBadDebt > badDebtDustUsd) {
    reasons.push(`Bad debt detected ($${totalBadDebt.toLocaleString('en-US', { maximumFractionDigits: 0 })})`);
  }

  // Check 3: Oracle Verification (only required for borrowing markets with collateral, not 0-LLTV idle cash)
  const isIdleReserve = isIdleReserveMarket(market);
  if (!isIdleReserve) {
    const oracleAddr = (market.oracle_address || '').toLowerCase();
    const isZeroAddress = !oracleAddr || oracleAddr === '0x' || oracleAddr === '0x0000000000000000000000000000000000000000';

    if (isZeroAddress) {
      reasons.push('Missing oracle contract address');
    }
  }


  // Check 4: Protocol Warnings
  const warningsCount = Number(market.warnings_count || 0);
  let warningsJson = [];
  let warningsUnreadable = market.warnings_json === null;
  try {
    if (typeof market.warnings_json === 'string' && market.warnings_json) {
      warningsJson = JSON.parse(market.warnings_json);
      warningsUnreadable = !Array.isArray(warningsJson);
    } else if (Array.isArray(market.warnings_json)) {
      warningsJson = market.warnings_json;
    }
  } catch {
    warningsUnreadable = true;
  }
  if (warningsUnreadable) unverifiedReasons.push('Protocol warnings not available');

  // Liquidity warnings (low_liquidity, sustained_low_liquidity) describe exit risk, not market integrity,
  // and are covered by the liquidity engine. Only RED integrity warnings or non-whitelisted markets compromise.
  const hasCriticalWarning = (Array.isArray(warningsJson) ? warningsJson : []).some(w => {
    const type = (w?.type || '').toLowerCase();
    const level = (w?.level || '').toUpperCase();
    return type === 'not_whitelisted' || (level === 'RED' && !type.includes('liquidity'));
  });

  if (hasCriticalWarning) {
    reasons.push('Critical protocol security warning flagged by Morpho');
  }

  // Known defects (reasons) make a market compromised; only missing data makes it unverified
  const isClean = reasons.length === 0 && unverifiedReasons.length === 0;

  return {
    isClean,
    reasons,
    unverifiedReasons
  };
}

/**
 * The vault as the concentration and exit engines should see it: unexpanded capital below the materiality
 * threshold is dust there too, so all three metrics agree on what is unverified.
 */
export function withMaterialUnresolved(vault, mqi) {
  return { ...vault, unresolved_exposure_usd: mqi.unresolvedAssetsUsd };
}

/**
 * Calculates Market Quality Index (MQI) for a vault and its allocations.
 * 
 * @param {object} vault Vault row from database
 * @param {Array<object>} allocations Array of vault allocations joined with markets
 * @returns {object} MQI audit metrics
 */
export function calculateMQI(vault, allocations = []) {
  const totalAssetsUsd = Number(vault.total_assets_usd) || 0;

  if (totalAssetsUsd <= 0) {
    // Assets without a USD value are unknown, not clean; a truly empty vault has nothing at risk
    const unpriced = isUnpricedVault(vault);
    return {
      mqiPercent: unpriced ? null : 100,
      unpriced,
      cleanAssetsUsd: 0,
      compromisedAssetsUsd: 0,
      unresolvedAssetsUsd: 0,
      compromisedPercent: 0,
      unresolvedPercent: 0,
      unverifiedAssetsUsd: 0,
      unverifiedPercent: 0,
      effectiveTotalUsd: 0,
      isAllClean: !unpriced,
      cleanMarketsCount: 0,
      totalMarketsCount: 0,
      compromisedMarkets: [],
      unverifiedMarkets: []
    };
  }

  let cleanSupplyUsd = 0;
  let compromisedSupplyUsd = 0;
  let unverifiedMarketsUsd = 0;
  let cleanMarketsCount = 0;
  const compromisedMarkets = [];
  const unverifiedMarkets = [];
  const minMaterialThresholdUsd = getMaterialityThresholdUsd(totalAssetsUsd);
  const rawCompromisedItems = [];
  let totalCompromisedRawUsd = 0;

  let hasUnreadableSupply = false;
  for (const alloc of allocations) {
    // A position whose size is missing or not a non-negative number is unknown, not zero
    if (alloc.supply_assets_usd == null || !(Number(alloc.supply_assets_usd) >= 0)) hasUnreadableSupply = true;
    const supplyUsd = Math.max(0, Number(alloc.supply_assets_usd) || 0);
    const test = isMarketClean(alloc);

    if (test.isClean) {
      cleanSupplyUsd += supplyUsd;
      if (supplyUsd >= 1) cleanMarketsCount++;
    } else {
      rawCompromisedItems.push({ alloc, supplyUsd, test });
      totalCompromisedRawUsd += supplyUsd;
    }
  }

  // Capital behind V2 adapters we could not look through is unknown, not clean cash
  const unresolvedRawUsd = Math.max(0, Number(vault.unresolved_exposure_usd) || 0);

  // Materiality evaluation: a defective or unresolved position counts on its own above 1% TVL (capped), and
  // all of them count once their combined size passes that threshold. Isolated sub-threshold dust stays clean.
  const isCumulativeMaterial = totalCompromisedRawUsd + unresolvedRawUsd >= minMaterialThresholdUsd;
  // Even then, a position under a tenth of the threshold (at least $1) is dust: it adds a flag, not information.
  // Unless that would leave the flagged positions below the threshold they were flagged for (many small ones):
  // then every position from $1 counts.
  const individuallyMaterialUsd = rawCompromisedItems.filter(i => i.supplyUsd >= minMaterialThresholdUsd).reduce((acc, i) => acc + i.supplyUsd, 0)
    + (unresolvedRawUsd >= minMaterialThresholdUsd ? unresolvedRawUsd : 0);
  const countedAboveFloor = floor => rawCompromisedItems.filter(i => i.supplyUsd < minMaterialThresholdUsd && i.supplyUsd >= floor).reduce((acc, i) => acc + i.supplyUsd, 0)
    + (unresolvedRawUsd < minMaterialThresholdUsd && unresolvedRawUsd >= floor ? unresolvedRawUsd : 0);
  let dustFloorUsd = Math.max(1, minMaterialThresholdUsd * 0.1);
  // Also when the positions dropped as dust add up to the threshold themselves: dust must not hide a material total.
  const droppedAsDustUsd = countedAboveFloor(1) - countedAboveFloor(dustFloorUsd);
  if (individuallyMaterialUsd + countedAboveFloor(dustFloorUsd) < minMaterialThresholdUsd || droppedAsDustUsd >= minMaterialThresholdUsd) dustFloorUsd = 1;

  for (const item of rawCompromisedItems) {
    const isMaterial = item.supplyUsd >= minMaterialThresholdUsd || (isCumulativeMaterial && item.supplyUsd >= dustFloorUsd);
    if (isMaterial) {
      const isCompromised = item.test.reasons.length > 0;
      if (isCompromised) compromisedSupplyUsd += item.supplyUsd; else unverifiedMarketsUsd += item.supplyUsd;
      (isCompromised ? compromisedMarkets : unverifiedMarkets).push({
        marketUniqueKey: item.alloc.market_unique_key,
        collateralSymbol: item.alloc.collateral_asset_symbol || 'None',
        loanSymbol: item.alloc.loan_asset_symbol || '',
        supplyAssetsUsd: Math.round(item.supplyUsd * 100) / 100,
        reasons: isCompromised ? [...item.test.reasons, ...item.test.unverifiedReasons] : item.test.unverifiedReasons
      });
    } else {
      cleanSupplyUsd += item.supplyUsd;
      if (item.supplyUsd >= 1) cleanMarketsCount++;
    }
  }

  let unresolvedUsd = unresolvedRawUsd >= minMaterialThresholdUsd || (isCumulativeMaterial && unresolvedRawUsd >= dustFloorUsd)
    ? unresolvedRawUsd : 0;

  // Any other vault capital not allocated to borrowing markets is unallocated idle cash on contract (clean),
  // unless a position of unknown size could be hiding in it: then the remainder is unknown too
  const totalAllocated = cleanSupplyUsd + compromisedSupplyUsd + unverifiedMarketsUsd;
  const remainderUsd = Math.max(0, totalAssetsUsd - totalAllocated - unresolvedUsd);
  const idleCashUsd = hasUnreadableSupply ? 0 : remainderUsd;
  if (hasUnreadableSupply) unresolvedUsd += remainderUsd;
  const totalCleanAssetsUsd = cleanSupplyUsd + idleCashUsd;

  // MQI is the clean share of the capital we could verify. Capital whose data is missing (unverified markets,
  // unexpanded adapters) is reported separately and does not move the score: no data is not bad data.
  const verifiedTotalUsd = totalCleanAssetsUsd + compromisedSupplyUsd;
  const unverifiedUsd = unverifiedMarketsUsd + unresolvedUsd;
  const effectiveTotalUsd = verifiedTotalUsd + unverifiedUsd;

  // null = nothing could be verified, so there is nothing to score
  // A verified remainder below the materiality threshold next to unverified capital is residue, not a basis for a score.
  const mqiPercent = verifiedTotalUsd > 0 && Number.isFinite(verifiedTotalUsd) && (unverifiedUsd === 0 || verifiedTotalUsd >= minMaterialThresholdUsd)
    ? Math.min(100, Math.max(0, Math.round((totalCleanAssetsUsd / verifiedTotalUsd) * 1000) / 10))
    : null;

  // One denominator for every share reported below: the capital the verdict is measured against
  // A positive amount never rounds to 0%: the smallest share reported is one unit of the last digit
  const pctOfTotal = (usd, digits = 100) => effectiveTotalUsd > 0 ? Math.max(usd > 0 ? 1 / digits : 0, Math.round((usd / effectiveTotalUsd) * 100 * digits) / digits) : 0;
  for (const m of [...compromisedMarkets, ...unverifiedMarkets]) m.weightPercent = pctOfTotal(m.supplyAssetsUsd);

  return {
    mqiPercent,
    unpriced: false,
    effectiveTotalUsd: Math.round(effectiveTotalUsd * 100) / 100,
    compromisedPercent: pctOfTotal(compromisedSupplyUsd, 100),
    unresolvedPercent: pctOfTotal(unresolvedUsd, 100),
    unverifiedAssetsUsd: Math.round(unverifiedUsd * 100) / 100,
    unverifiedPercent: pctOfTotal(unverifiedUsd, 100),
    cleanAssetsUsd: Math.round(totalCleanAssetsUsd * 100) / 100,
    compromisedAssetsUsd: Math.round(compromisedSupplyUsd * 100) / 100,
    unresolvedAssetsUsd: Math.round(unresolvedUsd * 100) / 100,
    isAllClean: compromisedMarkets.length === 0 && unverifiedUsd === 0 && mqiPercent === 100,
    cleanMarketsCount,
    totalMarketsCount: allocations.length,
    compromisedMarkets,
    unverifiedMarkets
  };
}

