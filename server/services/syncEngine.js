import { getDatabase } from '../db/database.js';
import { CONFIG } from '../config.js';
import { fetchAllVaults, fetchAllVaultV2s, fetchVaultReallocates, fetchVaultV2AllocationTransactions } from './morphoApi.js';
import {
  normalizeVault,
  normalizeVaultV2,
  normalizeMarket,
  normalizeAllocation,
  normalizeAllocationV2,
  normalizeReallocation,
  normalizeReallocationV2,
  formatUnits
} from './normalizers.js';

/**
 * Synchronizes the latest 10 reallocation transactions for a specific vault,
 * strictly filtering for material actions where Volume USD >= 1.0% of vault TVL.
 * 
 * @param {object} vault Vault object from database
 * @param {object} options Optional parameters (fetchLimit = 10, thresholdPct = 1.0)
 * @returns {Promise<Array>} Array of material reallocation events stored
 */
export async function syncVaultReallocations(vault, options = {}) {
  const fetchLimit = options.fetchLimit || CONFIG.sync.reallocationFetchLimit || 10;
  const thresholdPct = options.thresholdPct ?? CONFIG.sync.reallocationThresholdPct ?? 1.0;
  const db = getDatabase();

  const upsertReallocation = db.prepare(`
    INSERT INTO reallocations (
      id, vault_address, tx_hash, block_number, timestamp,
      type, market_unique_key, assets, assets_human, shares, created_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      block_number = excluded.block_number,
      timestamp = excluded.timestamp,
      type = excluded.type,
      assets = excluded.assets,
      assets_human = excluded.assets_human,
      shares = excluded.shares
  `);

  let rawEvents = [];
  try {
    if (vault.version === 'v2') {
      rawEvents = await fetchVaultV2AllocationTransactions(vault.address, vault.chain_id, fetchLimit);
    } else {
      rawEvents = await fetchVaultReallocates(vault.address, fetchLimit);
    }
  } catch (err) {
    console.warn(`[SyncEngine] Failed to fetch reallocations for ${vault.address}: ${err.message}`);
    return [];
  }

  const materialEvents = [];
  const vaultTvl = Number(vault.total_assets_usd) || 0;
  const assetPrice = Number(vault.asset_price_usd) || 1;

  if (rawEvents.length > 0) {
    db.exec('BEGIN TRANSACTION;');
    try {
      for (const rawEv of rawEvents) {
        const ev = vault.version === 'v2'
          ? normalizeReallocationV2(rawEv, vault.address, vault.asset_decimals)
          : normalizeReallocation(rawEv, vault.asset_decimals);

        const eventVolumeUsd = Number(ev.assets_human || 0) * assetPrice;
        const volumePct = vaultTvl > 0 ? (eventVolumeUsd / vaultTvl) * 100 : 0;

        // Strictly Volume USD >= 1.0% of vault TVL (no $10k threshold)
        if (volumePct >= thresholdPct) {
          upsertReallocation.run(
            ev.id, ev.vault_address, ev.tx_hash, ev.block_number, ev.timestamp,
            ev.type, ev.market_unique_key, ev.assets, ev.assets_human, ev.shares, ev.created_at
          );
          materialEvents.push({ ...ev, eventVolumeUsd, volumePct });
        }
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      console.warn(`[SyncEngine] Transaction error for ${vault.address}: ${err.message}`);
    }
  }

  return materialEvents;
}

/**
 * Performs a complete synchronization of vaults (both V1 and V2), markets, and allocations.
 * Optionally fetches reallocation history for top vaults.
 */
export async function syncAllVaults(options = { fetchHistoryForTop: true, minAssetsUsdForHistory: 10000 }) {
  console.log('[SyncEngine] Starting full synchronization from Morpho GraphQL API (V1 and V2)...');
  const startTime = Date.now();
  const db = getDatabase();

  // Prepared statements for upserts
  const upsertVault = db.prepare(`
    INSERT INTO vaults (
      address, chain_id, name, symbol, curator_name, asset_address,
      asset_symbol, asset_decimals, asset_price_usd, total_assets,
      total_assets_usd, liquidity_usd, apy, net_apy, fee, owner, pending_owner,
      version, is_listed, metadata_updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?
    )
    ON CONFLICT(address) DO UPDATE SET
      name = excluded.name,
      symbol = excluded.symbol,
      curator_name = excluded.curator_name,
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
      metadata_updated_at = excluded.metadata_updated_at
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
      supply_cap_human, weight, updated_at
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
    ON CONFLICT(vault_address, market_unique_key) DO UPDATE SET
      supply_assets = excluded.supply_assets,
      supply_assets_human = excluded.supply_assets_human,
      supply_assets_usd = excluded.supply_assets_usd,
      supply_cap = excluded.supply_cap,
      supply_cap_human = excluded.supply_cap_human,
      weight = excluded.weight,
      updated_at = excluded.updated_at
  `);

  const upsertReallocation = db.prepare(`
    INSERT INTO reallocations (
      id, vault_address, tx_hash, block_number, timestamp,
      type, market_unique_key, assets, assets_human, shares, created_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      assets = excluded.assets,
      assets_human = excluded.assets_human,
      shares = excluded.shares
  `);

  const updateSyncState = db.prepare(`
    INSERT INTO sync_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);

  // --- STEP 1: Sync MetaMorpho V1 Vaults ---
  console.log('[SyncEngine] Fetching MetaMorpho V1 vaults...');
  const rawVaultsV1 = await fetchAllVaults(options.chainIds ?? null);
  console.log(`[SyncEngine] Fetched ${rawVaultsV1.length} V1 vaults from Morpho GraphQL.`);

  let v1Count = 0;
  let v2Count = 0;
  let marketsCount = 0;
  let allocationsCount = 0;
  const topVaultsForHistory = [];

  db.exec('BEGIN TRANSACTION;');
  try {
    for (const rawV of rawVaultsV1) {
      const v = normalizeVault(rawV);
      upsertVault.run(
        v.address, v.chain_id, v.name, v.symbol, v.curator_name, v.asset_address,
        v.asset_symbol, v.asset_decimals, v.asset_price_usd, v.total_assets,
        v.total_assets_usd, v.liquidity_usd, v.apy, v.net_apy, v.fee, v.owner, v.pending_owner,
        'v1', v.is_listed, v.metadata_updated_at
      );
      v1Count++;

      if (v.total_assets_usd >= (options.minAssetsUsdForHistory ?? 1000) || v.is_listed) {
        topVaultsForHistory.push(v);
      }

      const rawAllocations = rawV.state?.allocation || [];
      const vaultTotalAssetsHuman = formatUnits(v.total_assets, v.asset_decimals);

      for (const rawAlloc of rawAllocations) {
        if (!rawAlloc.market) continue;

        const m = normalizeMarket(rawAlloc.market);
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
        marketsCount++;

        const alloc = normalizeAllocation(rawAlloc, v.address, v.asset_decimals, vaultTotalAssetsHuman);
        upsertAllocation.run(
          alloc.vault_address, alloc.market_unique_key, alloc.supply_assets,
          alloc.supply_assets_human, alloc.supply_assets_usd, alloc.supply_cap,
          alloc.supply_cap_human, alloc.weight, alloc.updated_at
        );
        allocationsCount++;
      }
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  // --- STEP 2: Sync Morpho Vaults V2 ---
  console.log('[SyncEngine] Fetching Morpho Vaults V2...');
  const rawVaultsV2 = await fetchAllVaultV2s(options.chainIds ?? null);
  console.log(`[SyncEngine] Fetched ${rawVaultsV2.length} V2 vaults from Morpho GraphQL.`);

  db.exec('BEGIN TRANSACTION;');
  try {
    for (const rawV2 of rawVaultsV2) {
      const v = normalizeVaultV2(rawV2);
      upsertVault.run(
        v.address, v.chain_id, v.name, v.symbol, v.curator_name, v.asset_address,
        v.asset_symbol, v.asset_decimals, v.asset_price_usd, v.total_assets,
        v.total_assets_usd, v.liquidity_usd, v.apy, v.net_apy, v.fee, v.owner, v.pending_owner,
        'v2', v.is_listed, v.metadata_updated_at
      );
      v2Count++;

      if (v.total_assets_usd >= (options.minAssetsUsdForHistory ?? 1000) || v.is_listed) {
        topVaultsForHistory.push(v);
      }

      const caps = rawV2.caps?.items || [];
      const vaultTotalAssetsHuman = formatUnits(v.total_assets, v.asset_decimals);

      for (const cap of caps) {
        const rawMarket = cap.data?.market;
        if (!rawMarket) continue;

        const m = normalizeMarket(rawMarket);
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
        marketsCount++;

        const alloc = normalizeAllocationV2(cap, v.address, v.asset_decimals, vaultTotalAssetsHuman);
        upsertAllocation.run(
          alloc.vault_address, alloc.market_unique_key, alloc.supply_assets,
          alloc.supply_assets_human, alloc.supply_assets_usd, alloc.supply_cap,
          alloc.supply_cap_human, alloc.weight, alloc.updated_at
        );
        allocationsCount++;
      }
    }

    updateSyncState.run('last_sync_all', String(Math.floor(Date.now() / 1000)), Math.floor(Date.now() / 1000));
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  console.log(`[SyncEngine] Committed: ${v1Count} V1 vaults, ${v2Count} V2 vaults, ${allocationsCount} allocations total.`);

  // --- Clean up unlisted vaults & orphan data from database ---
  console.log('[SyncEngine] Purging unlisted vaults and orphan data from database...');
  db.exec(`
    DELETE FROM vaults WHERE is_listed = 0 OR is_listed IS NULL;
    DELETE FROM vault_allocations WHERE vault_address NOT IN (SELECT address FROM vaults);
    DELETE FROM reallocations WHERE vault_address NOT IN (SELECT address FROM vaults);
    DELETE FROM markets WHERE unique_key NOT IN (SELECT market_unique_key FROM vault_allocations);
  `);

  // --- STEP 3: Fetch material reallocations for published vaults on the site ---
  let reallocationsCount = 0;
  if (options.fetchHistoryForTop && topVaultsForHistory.length > 0) {
    topVaultsForHistory.sort((a, b) => (b.total_assets_usd || 0) - (a.total_assets_usd || 0));
    const activeVaultsToProcess = topVaultsForHistory.filter(v => (v.total_assets_usd || 0) > 100 || v.is_listed);
    console.log(`[SyncEngine] Checking latest 10 transactions for ${activeVaultsToProcess.length} vaults (threshold: >= ${CONFIG.sync.reallocationThresholdPct || 1.0}% TVL)...`);

    for (const v of activeVaultsToProcess) {
      try {
        const saved = await syncVaultReallocations(v, {
          fetchLimit: CONFIG.sync.reallocationFetchLimit || 10,
          thresholdPct: CONFIG.sync.reallocationThresholdPct || 1.0
        });
        reallocationsCount += saved.length;
      } catch (err) {
        console.warn(`[SyncEngine] Could not fetch reallocations for vault ${v.name} (${v.address}): ${err.message}`);
      }
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[SyncEngine] Synchronization completed in ${durationSec}s. Summary:`);
  console.log(`- V1 Vaults: ${v1Count}`);
  console.log(`- V2 Vaults: ${v2Count}`);
  console.log(`- Markets: ${marketsCount}`);
  console.log(`- Allocations: ${allocationsCount}`);
  console.log(`- Reallocations processed: ${reallocationsCount}`);

  return {
    v1Count,
    v2Count,
    marketsCount,
    allocationsCount,
    reallocationsCount,
    durationSec
  };
}

// Allow direct CLI execution
if (process.argv[1] && process.argv[1].endsWith('syncEngine.js')) {
  syncAllVaults({ fetchHistoryForTop: true, minAssetsUsdForHistory: 100 })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[SyncEngine] Fatal error during sync:', err);
      process.exit(1);
    });
}
