import { getDatabase, checkpointDatabase } from '../db/database.js';
import { CONFIG } from '../config.js';
import { fetchAllVaults, fetchAllVaultV2s, fetchCuratorDirectory } from './morphoApi.js';
import {
  normalizeVault,
  normalizeVaultV2,
  normalizeMarket,
  normalizeAllocation,
  normalizeAllocationV2,
  formatUnits
} from './normalizers.js';

// A vault must be absent from this many consecutive syncs before it is deleted (with its history rows)
const MISSED_SYNCS_BEFORE_DELETE = 3;

let isSyncLocked = false;
let lastSyncResult = null;
const syncSuccessListeners = [];

/**
 * Returns true if synchronization is currently active.
 */
export function isSyncing() {
  return isSyncLocked;
}

/** Outcome of the most recent sync (manual or scheduled), or null before the first one. */
export function getLastSyncResult() {
  return lastSyncResult;
}

/** Registers a callback that runs after every successful sync (used to drop API caches). */
export function onSyncSuccess(listener) {
  syncSuccessListeners.push(listener);
}

/** BigInt() that treats malformed input as 0 instead of aborting the whole sync. */
export function toBigInt(value) {
  try {
    return BigInt(value || '0');
  } catch {
    return 0n;
  }
}

/** Underlying V1 vault of a MetaMorpho adapter, or null when it is not listed or empty. */
export function lookThroughVault(adapter, v1ByAddress, chainId) {
  const under = v1ByAddress.get((adapter.metaMorpho?.address || '').toLowerCase());
  // the same address on another chain is a different vault: its markets are not this vault's
  if (under?.chain?.id != null && chainId != null && Number(under.chain.id) !== Number(chainId)) return null;
  return toBigInt(under?.state?.totalAssets) > 0n ? under : null;
}

/**
 * Raw assets a V2 vault holds through adapters whose markets cannot be resolved:
 * MetaMorpho adapters without a listed, non-empty underlying vault (or whose underlying positions have no market),
 * adapter types we cannot look through, and MorphoMarketV1 assets that the market caps do not account for.
 */
export function unresolvedAdapterAssets(rawV2, v1ByAddress) {
  let sum = 0n;
  let marketV1Assets = 0n;
  for (const adapter of rawV2.adapters?.items || []) {
    const assets = toBigInt(adapter.assets);
    if (assets <= 0n) continue;
    if (adapter.type === 'MorphoMarketV1') {
      marketV1Assets += assets;
      continue;
    }
    const under = adapter.type === 'MetaMorpho' ? lookThroughVault(adapter, v1ByAddress, rawV2.chain?.id) : null;
    if (!under || !Array.isArray(under.state.allocation)) {
      sum += assets;
      continue;
    }
    // Underlying positions the API reports without a market cannot be attributed: their share of the adapter is unknown
    const { denominator } = underlyingTotals(under);
    const noMarket = under.state.allocation.filter(a => !a.market).reduce((acc, a) => acc + toBigInt(a.supplyAssets), 0n);
    if (noMarket > 0n) sum += (noMarket * assets) / denominator;
  }
  // MorphoMarketV1 positions arrive as market caps; whatever they do not cover is unknown. A cap's allocation
  // is only refreshed on allocate/deallocate while the adapter's assets accrue interest, so a gap of up to 0.5%
  // is interest, not hidden capital. The Morpho API currently reports no gap at all (checked on all 207 live
  // MorphoMarketV1 vaults), so the tolerance only guards against a source that lags.
  // shortcut: fixed 0.5% tolerance, widen it if a real vault shows a larger accrual gap.
  const capsAllocated = (rawV2.caps?.items || [])
    .filter(cap => cap.data?.market)
    .reduce((acc, cap) => acc + toBigInt(cap.allocation), 0n);
  const gap = marketV1Assets - capsAllocated;
  if (gap * 200n > marketV1Assets) sum += gap;
  return sum;
}

/** Sum of an underlying vault's reported positions and the denominator its shares are split by. */
export function underlyingTotals(under) {
  const underTotal = toBigInt(under.state.totalAssets);
  const allocSum = (under.state.allocation || []).reduce((acc, a) => acc + toBigInt(a.supplyAssets), 0n);
  // Inconsistent API data (allocations above totalAssets) must not push the shares above the adapter's assets
  return { allocSum, denominator: allocSum > underTotal ? allocSum : underTotal };
}

/** Raw assets of a V1 vault that the API reports without any market: unknown, not idle cash. */
export function unresolvedV1Assets(rawV) {
  const allocation = rawV.state?.allocation;
  if (!Array.isArray(allocation)) return toBigInt(rawV.state?.totalAssets);
  return allocation.filter(a => !a.market).reduce((acc, a) => acc + toBigInt(a.supplyAssets), 0n);
}

/** Unresolved raw assets priced as a share of the vault's own TVL, in the units the engines compare with. */
export function unresolvedUsd(unresolvedRaw, v) {
  const totalHuman = formatUnits(v.total_assets, v.asset_decimals);
  if (!(totalHuman > 0)) return 0;
  const share = Math.min(1, formatUnits(String(unresolvedRaw), v.asset_decimals) / totalHuman);
  return share * (Number(v.total_assets_usd) || 0);
}

/**
 * The API sometimes omits the price of a vault's asset. Its markets lend that same token, so their loan price
 * is the vault's price; without any, the vault stays unpriced (0 USD) and the engines report it as unknown.
 */
export function withResolvedPrice(v, rawMarkets) {
  if (Number(v.asset_price_usd) > 0) return v;
  // The API priced the vault total but not the token: the price it implies prices the positions too, so they
  // do not fall to 0 USD and read as clean cash.
  const totalUsd = Number(v.total_assets_usd) || 0;
  const totalHuman = formatUnits(v.total_assets, v.asset_decimals);
  if (totalUsd > 0) return totalHuman > 0 ? { ...v, asset_price_usd: totalUsd / totalHuman } : v;
  const price = rawMarkets.map(m => Number(m?.loanAsset?.priceUsd)).find(p => p > 0);
  if (!price) return v;
  // A reported USD liquidity of 0 for an asset the API could not price is "not priced", not "nothing withdrawable"
  return {
    ...v, asset_price_usd: price, total_assets_usd: formatUnits(v.total_assets, v.asset_decimals) * price,
    liquidity_usd: v.liquidity_usd === 0 ? null : v.liquidity_usd
  };
}

/**
 * A V2 vault may hold its assets in MetaMorpho (V1) vaults through an adapter instead of direct market caps.
 * Look through each such adapter: split its assets across the underlying vault's markets pro rata,
 * and merge the result with the vault's direct market caps.
 */
export function expandMetaMorphoAdapters(rawV2, v1ByAddress) {
  const merged = new Map();
  const add = (market, allocation, absoluteCap, via = null) => {
    const key = (market.marketId || '').toLowerCase();
    let entry = merged.get(key);
    if (!entry) {
      entry = { allocation: '0', absoluteCap, data: { market }, viaShares: new Map() };
      merged.set(key, entry);
    }
    entry.allocation = String(toBigInt(entry.allocation) + toBigInt(allocation));
    if (via) entry.viaShares.set(via, (entry.viaShares.get(via) || 0n) + toBigInt(allocation));
  };

  for (const cap of rawV2.caps?.items || []) {
    const market = cap.data?.market;
    if (market) add(market, cap.allocation || '0', cap.absoluteCap || '0');
  }

  for (const adapter of rawV2.adapters?.items || []) {
    if (adapter.type !== 'MetaMorpho') continue;
    const adapterAssets = toBigInt(adapter.assets);
    if (adapterAssets <= 0n) continue;
    const under = lookThroughVault(adapter, v1ByAddress, rawV2.chain?.id);
    if (!under) {
      console.warn(`[SyncEngine] V2 vault ${rawV2.name}: MetaMorpho adapter not resolved (underlying vault not listed or empty).`);
      continue;
    }
    const { denominator } = underlyingTotals(under);
    for (const alloc of under.state.allocation || []) {
      if (!alloc.market) continue;
      const share = (toBigInt(alloc.supplyAssets) * adapterAssets) / denominator;
      if (share > 0n) add(alloc.market, share, '0', under.address.toLowerCase());
    }
  }

  // Tag a position with the underlying vault it sits inside when that look-through is the majority of it,
  // so peer-supply aggregation does not count the same capital twice.
  // shortcut: mixed direct + look-through positions are tagged by majority only.
  return [...merged.values()].map(({ viaShares, ...cap }) => {
    const total = toBigInt(cap.allocation);
    for (const [via, share] of viaShares) {
      if (share * 2n > total) return { ...cap, viaVault: via };
    }
    return cap;
  });
}

/**
 * Performs a complete synchronization of vaults (both V1 and V2), markets, and allocations.
 */
export async function syncAllVaults(options = {}) {
  if (isSyncLocked) {
    throw new Error('Synchronization is already in progress');
  }
  isSyncLocked = true;

  try {
    console.log('[SyncEngine] Starting full synchronization from Morpho GraphQL API (V1 and V2)...');
    const startTime = Date.now();
    const db = getDatabase();

    // Prepared statements for upserts and allocation purging
    const deleteVaultAllocations = db.prepare('DELETE FROM vault_allocations WHERE vault_address = ?');
    const upsertVault = db.prepare(`
      INSERT INTO vaults (
        address, chain_id, name, symbol, curator_name, asset_address,
        asset_symbol, asset_decimals, asset_price_usd, total_assets,
        total_assets_usd, liquidity_usd, apy, net_apy, fee, owner, pending_owner,
        version, is_listed, metadata_updated_at, unresolved_exposure_usd
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(address) DO UPDATE SET
        chain_id = excluded.chain_id,
        asset_address = excluded.asset_address,
        asset_symbol = excluded.asset_symbol,
        asset_decimals = excluded.asset_decimals,
        missed_syncs = 0,
        name = excluded.name,
        symbol = excluded.symbol,
        curator_name = CASE
          WHEN excluded.curator_name LIKE '0x%' AND vaults.curator_name NOT LIKE '0x%' AND vaults.curator_name != 'Independent' THEN vaults.curator_name
          ELSE excluded.curator_name END,
        asset_price_usd = excluded.asset_price_usd,
        total_assets = excluded.total_assets,
        total_assets_usd = excluded.total_assets_usd,
        liquidity_usd = excluded.liquidity_usd,
        apy = excluded.apy,
        net_apy = excluded.net_apy,
        fee = excluded.fee,
        owner = excluded.owner,
        pending_owner = excluded.pending_owner,
        version = excluded.version,
        is_listed = excluded.is_listed,
        metadata_updated_at = excluded.metadata_updated_at,
        unresolved_exposure_usd = excluded.unresolved_exposure_usd
    `);

    const upsertMarket = db.prepare(`
      INSERT INTO markets (
        unique_key, chain_id, loan_asset_address, loan_asset_symbol,
        loan_asset_decimals, loan_asset_price_usd, collateral_asset_address,
        collateral_asset_symbol, collateral_asset_decimals, collateral_asset_price_usd,
        oracle_address, irm_address, lltv, lltv_percent, total_supply_assets,
        total_supply_assets_usd, total_borrow_assets, total_borrow_assets_usd,
        free_liquidity_assets, free_liquidity_usd, utilization, borrow_apy,
        supply_apy, is_listed, oracle_type, bad_debt_usd, realized_bad_debt_usd,
        warnings_count, warnings_json, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?
      )
      ON CONFLICT(unique_key) DO UPDATE SET
        chain_id = excluded.chain_id,
        loan_asset_address = excluded.loan_asset_address,
        loan_asset_symbol = excluded.loan_asset_symbol,
        loan_asset_decimals = excluded.loan_asset_decimals,
        collateral_asset_address = excluded.collateral_asset_address,
        collateral_asset_symbol = excluded.collateral_asset_symbol,
        collateral_asset_decimals = excluded.collateral_asset_decimals,
        oracle_address = excluded.oracle_address,
        irm_address = excluded.irm_address,
        loan_asset_price_usd = excluded.loan_asset_price_usd,
        collateral_asset_price_usd = excluded.collateral_asset_price_usd,
        lltv = excluded.lltv,
        lltv_percent = excluded.lltv_percent,
        total_supply_assets = excluded.total_supply_assets,
        total_supply_assets_usd = excluded.total_supply_assets_usd,
        total_borrow_assets = excluded.total_borrow_assets,
        total_borrow_assets_usd = excluded.total_borrow_assets_usd,
        free_liquidity_assets = excluded.free_liquidity_assets,
        free_liquidity_usd = excluded.free_liquidity_usd,
        utilization = excluded.utilization,
        borrow_apy = excluded.borrow_apy,
        supply_apy = excluded.supply_apy,
        is_listed = excluded.is_listed,
        oracle_type = excluded.oracle_type,
        bad_debt_usd = excluded.bad_debt_usd,
        realized_bad_debt_usd = excluded.realized_bad_debt_usd,
        warnings_count = excluded.warnings_count,
        warnings_json = excluded.warnings_json,
        updated_at = excluded.updated_at
    `);

    const upsertAllocation = db.prepare(`
      INSERT INTO vault_allocations (
        vault_address, market_unique_key, supply_assets,
        supply_assets_human, supply_assets_usd, supply_cap,
        supply_cap_human, weight, updated_at, via_vault
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(vault_address, market_unique_key) DO UPDATE SET
        supply_assets = excluded.supply_assets,
        supply_assets_human = excluded.supply_assets_human,
        supply_assets_usd = excluded.supply_assets_usd,
        supply_cap = excluded.supply_cap,
        supply_cap_human = excluded.supply_cap_human,
        weight = excluded.weight,
        updated_at = excluded.updated_at,
        via_vault = excluded.via_vault
    `);

    const updateSyncState = db.prepare(`
      INSERT INTO sync_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);

    // --- STEP 0: Fetch Curator Directory (Network) ---
    console.log('[SyncEngine] Fetching official curator directory from Morpho GraphQL...');
    const curatorMap = await fetchCuratorDirectory();
    console.log(`[SyncEngine] Loaded ${curatorMap.size} curator address mappings.`);

    // --- STEP 1: Fetch MetaMorpho V1 Vaults (Network) ---
    console.log('[SyncEngine] Fetching MetaMorpho V1 vaults...');
    const rawVaultsV1 = await fetchAllVaults(options.chainIds ?? null);
    console.log(`[SyncEngine] Fetched ${rawVaultsV1.length} V1 vaults from Morpho GraphQL.`);

    // --- STEP 2: Fetch Morpho Vaults V2 (Network) ---
    console.log('[SyncEngine] Fetching Morpho Vaults V2...');
    const rawVaultsV2 = await fetchAllVaultV2s(options.chainIds ?? null);
    console.log(`[SyncEngine] Fetched ${rawVaultsV2.length} V2 vaults from Morpho GraphQL.`);

    const v1ByAddress = new Map(rawVaultsV1.map(rv => [(rv.address || '').toLowerCase(), rv]));

    // Guard against purging the catalogue on a truncated API answer
    const fetchedTotal = rawVaultsV1.filter(rv => rv.listed).length + rawVaultsV2.filter(rv => rv.listed).length;
    const knownListed = db.prepare('SELECT COUNT(*) AS c FROM vaults WHERE is_listed = 1').get()?.c || 0;
    if (!options.chainIds && knownListed > 20 && fetchedTotal < knownListed * 0.5) {
      throw new Error(`Suspicious sync: API returned ${fetchedTotal} listed vaults, DB has ${knownListed}. Aborting before purge.`);
    }

    let v1Count = 0;
    let v2Count = 0;
    let marketsCount = 0;
    let allocationsCount = 0;
    const fetchedListedAddresses = new Set();
    const seenMarketKeys = new Set();

    // --- STEP 3: Single Atomic Transaction for All Mutations ---
    db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      // 3A. Write V1 Vaults & Allocations
      for (const rawV of rawVaultsV1) {
        const rawAllocations = rawV.state?.allocation || [];
        const v = withResolvedPrice(normalizeVault(rawV, curatorMap), rawAllocations.map(a => a.market));
        upsertVault.run(
          v.address, v.chain_id, v.name, v.symbol, v.curator_name, v.asset_address,
          v.asset_symbol, v.asset_decimals, v.asset_price_usd, v.total_assets,
          v.total_assets_usd, v.liquidity_usd, v.apy, v.net_apy, v.fee, v.owner, v.pending_owner,
          'v1', v.is_listed, v.metadata_updated_at, unresolvedUsd(unresolvedV1Assets(rawV), v)
        );
        v1Count++;
        if (v.is_listed) {
          fetchedListedAddresses.add(v.address.toLowerCase());
        }

        deleteVaultAllocations.run(v.address);

        const vaultTotalAssetsHuman = formatUnits(v.total_assets, v.asset_decimals);

        for (const rawAlloc of rawAllocations) {
          if (!rawAlloc.market) continue;

          const m = normalizeMarket(rawAlloc.market, v.chain_id);
          if (!seenMarketKeys.has(m.unique_key)) {
            upsertMarket.run(
              m.unique_key, m.chain_id, m.loan_asset_address, m.loan_asset_symbol,
              m.loan_asset_decimals, m.loan_asset_price_usd, m.collateral_asset_address,
              m.collateral_asset_symbol, m.collateral_asset_decimals, m.collateral_asset_price_usd,
              m.oracle_address, m.irm_address, m.lltv, m.lltv_percent, m.total_supply_assets,
              m.total_supply_assets_usd, m.total_borrow_assets, m.total_borrow_assets_usd,
              m.free_liquidity_assets, m.free_liquidity_usd, m.utilization, m.borrow_apy,
              m.supply_apy, m.is_listed, m.oracle_type, m.bad_debt_usd, m.realized_bad_debt_usd,
              m.warnings_count, m.warnings_json, m.updated_at
            );
            seenMarketKeys.add(m.unique_key);
            marketsCount++;
          }

          const alloc = normalizeAllocation(rawAlloc, v.address, v.asset_decimals, vaultTotalAssetsHuman, v.asset_price_usd, v.chain_id);
          upsertAllocation.run(
            alloc.vault_address, alloc.market_unique_key, alloc.supply_assets,
            alloc.supply_assets_human, alloc.supply_assets_usd, alloc.supply_cap,
            alloc.supply_cap_human, alloc.weight, alloc.updated_at, alloc.via_vault
          );
          allocationsCount++;
        }
      }

      // 3B. Write V2 Vaults & Allocations
      for (const rawV2 of rawVaultsV2) {
        const caps = expandMetaMorphoAdapters(rawV2, v1ByAddress);
        const v = withResolvedPrice(normalizeVaultV2(rawV2, curatorMap), caps.map(c => c.data?.market));
        const vaultTotalAssetsHuman = formatUnits(v.total_assets, v.asset_decimals);
        upsertVault.run(
          v.address, v.chain_id, v.name, v.symbol, v.curator_name, v.asset_address,
          v.asset_symbol, v.asset_decimals, v.asset_price_usd, v.total_assets,
          v.total_assets_usd, v.liquidity_usd, v.apy, v.net_apy, v.fee, v.owner, v.pending_owner,
          'v2', v.is_listed, v.metadata_updated_at, unresolvedUsd(unresolvedAdapterAssets(rawV2, v1ByAddress), v)
        );
        v2Count++;
        if (v.is_listed) {
          fetchedListedAddresses.add(v.address.toLowerCase());
        }

        deleteVaultAllocations.run(v.address);

        for (const cap of caps) {
          const rawMarket = cap.data?.market;
          if (!rawMarket) continue;

          const m = normalizeMarket(rawMarket, v.chain_id);
          if (!seenMarketKeys.has(m.unique_key)) {
            upsertMarket.run(
              m.unique_key, m.chain_id, m.loan_asset_address, m.loan_asset_symbol,
              m.loan_asset_decimals, m.loan_asset_price_usd, m.collateral_asset_address,
              m.collateral_asset_symbol, m.collateral_asset_decimals, m.collateral_asset_price_usd,
              m.oracle_address, m.irm_address, m.lltv, m.lltv_percent, m.total_supply_assets,
              m.total_supply_assets_usd, m.total_borrow_assets, m.total_borrow_assets_usd,
              m.free_liquidity_assets, m.free_liquidity_usd, m.utilization, m.borrow_apy,
              m.supply_apy, m.is_listed, m.oracle_type, m.bad_debt_usd, m.realized_bad_debt_usd,
              m.warnings_count, m.warnings_json, m.updated_at
            );
            seenMarketKeys.add(m.unique_key);
            marketsCount++;
          }

          const alloc = normalizeAllocationV2(cap, v.address, v.asset_decimals, vaultTotalAssetsHuman, v.asset_price_usd, v.chain_id);
          upsertAllocation.run(
            alloc.vault_address, alloc.market_unique_key, alloc.supply_assets,
            alloc.supply_assets_human, alloc.supply_assets_usd, alloc.supply_cap,
            alloc.supply_cap_human, alloc.weight, alloc.updated_at, alloc.via_vault
          );
          allocationsCount++;
        }
      }

      // 3C. Update sync timestamp (a chain-restricted sync must not make the whole catalogue look fresh)
      const nowSec = Math.floor(Date.now() / 1000);
      updateSyncState.run(options.chainIds ? 'last_sync_partial' : 'last_sync_all', String(nowSec), nowSec);

      // 3D. Purge unlisted / delisted vaults
      if (!options.chainIds && fetchedListedAddresses.size > 0) {
        const activeAddressesJson = JSON.stringify(Array.from(fetchedListedAddresses));
        db.prepare(`
          UPDATE vaults
          SET missed_syncs = missed_syncs + 1
          WHERE LOWER(address) NOT IN (SELECT value FROM json_each(?))
        `).run(activeAddressesJson);
      }

      db.exec(`
        DELETE FROM vaults WHERE is_listed = 0 OR is_listed IS NULL OR missed_syncs >= ${MISSED_SYNCS_BEFORE_DELETE};
        DELETE FROM vault_allocations WHERE vault_address NOT IN (SELECT address FROM vaults);
        DELETE FROM markets WHERE unique_key NOT IN (SELECT market_unique_key FROM vault_allocations);
      `);

      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    console.log(`[SyncEngine] Committed: ${v1Count} V1 vaults, ${v2Count} V2 vaults, ${allocationsCount} allocations total.`);

    // Perform non-blocking WAL maintenance checkpoint
    checkpointDatabase();

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SyncEngine] Synchronization completed in ${durationSec}s. Summary:`);
    console.log(`- V1 Vaults: ${v1Count}`);
    console.log(`- V2 Vaults: ${v2Count}`);
    console.log(`- Markets: ${marketsCount}`);
    console.log(`- Allocations: ${allocationsCount}`);

    const summary = {
      v1Count,
      v2Count,
      marketsCount,
      allocationsCount,
      durationSec
    };
    lastSyncResult = {
      success: true,
      completedAt: Math.floor(Date.now() / 1000),
      durationSec,
      summary
    };
    for (const listener of syncSuccessListeners) listener();
    return summary;
  } catch (err) {
    lastSyncResult = { success: false, failedAt: Math.floor(Date.now() / 1000), error: 'Synchronization failed' };
    throw err;
  } finally {
    isSyncLocked = false;
  }
}

// Allow direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('syncEngine.js')) {
  syncAllVaults()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[SyncEngine] Fatal error during sync:', err);
      process.exit(1);
    });
}
