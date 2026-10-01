/**
 * Safe formatting of BigInt string with decimals into floating number
 * @param {string|number|bigint} raw
 * @param {number} decimals
 * @returns {number}
 */
export function formatUnits(raw, decimals = 18) {
  if (raw === null || raw === undefined || raw === '') return 0;
  try {
    const str = String(raw).trim();
    if (str === '0') return 0;
    
    // For small decimals and standard numbers
    if (decimals === 0) return Number(str);
    
    const isNegative = str.startsWith('-');
    const cleanStr = isNegative ? str.slice(1) : str;
    
    const padded = cleanStr.padStart(decimals + 1, '0');
    const integerPart = padded.slice(0, padded.length - decimals);
    const fractionPart = padded.slice(padded.length - decimals).slice(0, 8); // limit precision for float
    
    const num = Number(`${integerPart}.${fractionPart}`);
    return isNegative ? -num : num;
  } catch (err) {
    return 0;
  }
}

/**
 * Converts 1e18 LLTV string to percentage (0 - 100)
 * @param {string|number} rawLltv
 * @returns {number} e.g. 86.0
 */
export function parseLltv(rawLltv) {
  if (!rawLltv) return 0;
  try {
    // 1e18 = 100% -> divide by 1e16 to get percentage
    const val = formatUnits(rawLltv, 16);
    return Math.round(val * 100) / 100;
  } catch {
    return 0;
  }
}

/**
 * Normalizes vault object from GraphQL response (MetaMorpho V1)
 */
export function normalizeVault(raw, curatorMap = null) {
  const asset = raw.asset || {};
  const state = raw.state || {};
  const chain = raw.chain || {};

  const decimals = asset.decimals ?? 18;
  const totalAssetsHuman = formatUnits(state.totalAssets, decimals);

  const rawCuratorAddr = (state.curator || '').toLowerCase();
  let curatorName = 'Independent';
  if (rawCuratorAddr && rawCuratorAddr !== '0x0000000000000000000000000000000000000000') {
    curatorName = curatorMap?.get(rawCuratorAddr) || state.curator || 'Independent';
  }

  return {
    address: (raw.address || '').toLowerCase(),
    chain_id: chain.id || 1,
    name: raw.name || raw.symbol || 'Unknown Vault',
    symbol: raw.symbol || '',
    curator_name: curatorName,
    asset_address: (asset.address || '').toLowerCase(),
    asset_symbol: asset.symbol || 'ASSET',
    asset_decimals: decimals,
    asset_price_usd: asset.priceUsd ?? 0,
    total_assets: String(state.totalAssets || '0'),
    total_assets_usd: state.totalAssetsUsd ?? 0,
    liquidity_usd: raw.liquidity?.usd ?? 0,
    apy: state.apy ?? 0,
    net_apy: state.netApy ?? 0,
    fee: state.fee ?? 0,
    owner: (state.owner || '').toLowerCase(),
    pending_owner: (state.pendingOwner || '').toLowerCase(),
    version: 'v1',
    is_listed: raw.listed ? 1 : 0,
    metadata_updated_at: Math.floor(Date.now() / 1000)
  };
}

/**
 * Normalizes vault object from GraphQL response (Morpho Vaults V2)
 */
export function normalizeVaultV2(raw, curatorMap = null) {
  const asset = raw.asset || {};
  const chain = raw.chain || {};

  const decimals = asset.decimals ?? 18;
  const totalAssetsHuman = formatUnits(raw.totalAssets, decimals);

  const v2CuratorItemName = raw.curators?.items?.[0]?.name;
  const rawCuratorAddr = (raw.curator?.address || '').toLowerCase();
  let curatorName = 'Independent';
  if (v2CuratorItemName) {
    curatorName = v2CuratorItemName;
  } else if (rawCuratorAddr && rawCuratorAddr !== '0x0000000000000000000000000000000000000000') {
    curatorName = curatorMap?.get(rawCuratorAddr) || raw.curator?.address || 'Independent';
  } else if ((raw.name || '').toLowerCase().startsWith('hyperevm')) {
    curatorName = 'HyperEVM';
  }

  return {
    address: (raw.address || '').toLowerCase(),
    chain_id: chain.id || 1,
    name: raw.name || raw.symbol || 'Unknown Vault V2',
    symbol: raw.symbol || '',
    curator_name: curatorName,
    asset_address: (asset.address || '').toLowerCase(),
    asset_symbol: asset.symbol || 'ASSET',
    asset_decimals: decimals,
    asset_price_usd: asset.priceUsd ?? 0,
    total_assets: String(raw.totalAssets || '0'),
    total_assets_usd: raw.totalAssetsUsd ?? 0,
    liquidity_usd: (raw.liquidityUsd ?? 0) + (raw.forceDeallocatableLiquidityUsd ?? 0),
    apy: raw.apy ?? 0,
    net_apy: raw.netApy ?? raw.apy ?? 0,
    fee: raw.performanceFee ?? 0,
    owner: (raw.owner?.address || '').toLowerCase(),
    pending_owner: '',
    version: 'v2',
    is_listed: raw.listed ? 1 : 0,
    metadata_updated_at: Math.floor(Date.now() / 1000)
  };
}

/**
 * Normalizes market object from GraphQL response
 */
export function normalizeMarket(raw) {
  const chain = raw.chain || {};
  const loanAsset = raw.loanAsset || {};
  const collateralAsset = raw.collateralAsset || {};
  const oracle = raw.oracle || {};
  const state = raw.state || {};

  const loanDecimals = loanAsset.decimals ?? 18;
  const lltvPercent = parseLltv(raw.lltv);

  const supplyHuman = formatUnits(state.supplyAssets, loanDecimals);
  const borrowHuman = formatUnits(state.borrowAssets, loanDecimals);
  const freeLiquidityAssets = Math.max(0, supplyHuman - borrowHuman);

  const loanPrice = loanAsset.priceUsd ?? 1;
  const freeLiquidityUsd = freeLiquidityAssets * loanPrice;

  let utilization = 0;
  if (supplyHuman > 0) {
    utilization = Math.min(1, borrowHuman / supplyHuman);
  }

  return {
    unique_key: (raw.marketId || '').toLowerCase(),
    chain_id: chain.id || 1,
    loan_asset_address: (loanAsset.address || '').toLowerCase(),
    loan_asset_symbol: loanAsset.symbol || 'LOAN',
    loan_asset_decimals: loanDecimals,
    loan_asset_price_usd: loanPrice,
    collateral_asset_address: (collateralAsset.address || '').toLowerCase(),
    collateral_asset_symbol: collateralAsset.symbol || 'NONE',
    collateral_asset_decimals: collateralAsset.decimals ?? 18,
    collateral_asset_price_usd: collateralAsset.priceUsd ?? 0,
    oracle_address: (oracle.address || '').toLowerCase(),
    irm_address: (raw.irmAddress || '').toLowerCase(),
    lltv: String(raw.lltv || '0'),
    lltv_percent: lltvPercent,
    total_supply_assets: String(state.supplyAssets || '0'),
    total_supply_assets_usd: state.supplyAssetsUsd ?? 0,
    total_borrow_assets: String(state.borrowAssets || '0'),
    total_borrow_assets_usd: state.borrowAssetsUsd ?? 0,
    free_liquidity_assets: freeLiquidityAssets,
    free_liquidity_usd: freeLiquidityUsd,
    utilization: utilization,
    borrow_apy: state.borrowApy ?? 0,
    supply_apy: state.supplyApy ?? 0,
    is_listed: raw.listed !== false ? 1 : 0,
    oracle_type: oracle.type || 'ChainlinkOracleV2',
    bad_debt_usd: Number(raw.badDebt?.usd) || 0,
    realized_bad_debt_usd: Number(raw.realizedBadDebt?.usd) || 0,
    warnings_count: Array.isArray(raw.warnings) ? raw.warnings.length : 0,
    warnings_json: JSON.stringify(raw.warnings || []),
    updated_at: Math.floor(Date.now() / 1000)
  };
}

/**
 * Normalizes vault allocation item
 */
export function normalizeAllocation(rawAlloc, vaultAddress, vaultDecimals, vaultTotalAssetsHuman) {
  const supplyHuman = formatUnits(rawAlloc.supplyAssets, vaultDecimals);
  const capHuman = formatUnits(rawAlloc.supplyCap, vaultDecimals);

  let weight = 0;
  if (vaultTotalAssetsHuman > 0) {
    weight = Math.min(1, supplyHuman / vaultTotalAssetsHuman);
  }

  return {
    vault_address: vaultAddress.toLowerCase(),
    market_unique_key: (rawAlloc.market?.marketId || '').toLowerCase(),
    supply_assets: String(rawAlloc.supplyAssets || '0'),
    supply_assets_human: supplyHuman,
    supply_assets_usd: rawAlloc.supplyAssetsUsd ?? 0,
    supply_cap: String(rawAlloc.supplyCap || '0'),
    supply_cap_human: capHuman,
    weight: weight,
    updated_at: Math.floor(Date.now() / 1000)
  };
}

/**
 * Normalizes VaultV2 allocation from caps
 */
export function normalizeAllocationV2(cap, vaultAddress, vaultDecimals, vaultTotalAssetsHuman) {
  const supplyHuman = formatUnits(cap.allocation, vaultDecimals);
  const capHuman = formatUnits(cap.absoluteCap, vaultDecimals);

  let weight = 0;
  if (vaultTotalAssetsHuman > 0) {
    weight = Math.min(1, supplyHuman / vaultTotalAssetsHuman);
  }

  const market = cap.data?.market;

  return {
    vault_address: vaultAddress.toLowerCase(),
    market_unique_key: (market?.marketId || '').toLowerCase(),
    supply_assets: String(cap.allocation || '0'),
    supply_assets_human: supplyHuman,
    supply_assets_usd: supplyHuman * (market?.loanAsset?.priceUsd ?? 1),
    supply_cap: String(cap.absoluteCap || '0'),
    supply_cap_human: capHuman,
    weight: weight,
    updated_at: Math.floor(Date.now() / 1000)
  };
}

