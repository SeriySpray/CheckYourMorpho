import { generateVaultVerdict } from '../engine/verdictEngine.js';
import {
  buildDedupeKey,
  diffAdminEvents,
  diffPendingConfigs,
  buildWatchState,
  diffDerivedState,
  detectTvlOutflow
} from '../engine/eventsEngine.js';
import { formatUnits } from './normalizers.js';

const DEFAULT_RETENTION_DAYS = 180;
const SAMPLE_RETENTION_SECONDS = 8 * 86400;

const computePeerSupplyUsd = (marketRows, vaultAddress, alloc) => {
  let total = 0;
  for (const r of marketRows || []) {
    if (r.vault_address === vaultAddress || r.via_vault) continue;
    let supply = Number(r.supply_assets_usd) || 0;
    if (alloc.via_vault && r.vault_address === alloc.via_vault) {
      supply -= Number(alloc.supply_assets_usd) || 0;
    }
    if (supply > 1000) total += supply;
  }
  return total;
};

const withEffectiveTotal = (vault, allocations) => {
  if ((Number(vault.total_assets_usd) || 0) > 0) return vault;
  const sum = allocations.reduce((acc, a) => acc + (Number(a.supply_assets_usd) || 0), 0);
  return sum > 0 ? { ...vault, total_assets_usd: sum } : vault;
};

/**
 * Deletes non-pending events older than retentionDays (default 180 days).
 * Pending events are never deleted by retention cleanup.
 */
export function pruneOldEvents(db, nowSec = Math.floor(Date.now() / 1000), retentionDays = DEFAULT_RETENTION_DAYS) {
  const cutoff = nowSec - (Number(retentionDays) * 86400);
  const res = db.prepare(`
    DELETE FROM vault_events
    WHERE occurred_at < ? AND status != 'pending'
  `).run(cutoff);
  return Number(res?.changes || 0);
}

/**
 * Computes and persists vault events (admin events, pending timelock configs, bad debt, delisting and 24h TVL outflow),
 * hourly vault samples
 * and updates vault_watch_state in a single SQLite transaction.
 */
export function syncVaultEvents(db, rawVaultsV1 = [], rawVaultsV2 = [], options = {}) {
  const nowSec = options.nowSec !== undefined ? Number(options.nowSec) : Math.floor(Date.now() / 1000);
  const chainFilter = Array.isArray(options.chainIds) && options.chainIds.length > 0
    ? new Set(options.chainIds.map(Number))
    : null;

  const v1Map = new Map();
  for (const rv of (Array.isArray(rawVaultsV1) ? rawVaultsV1 : [])) {
    if (rv?.address) v1Map.set(String(rv.address).toLowerCase(), rv);
  }
  const v2Map = new Map();
  for (const rv2 of (Array.isArray(rawVaultsV2) ? rawVaultsV2 : [])) {
    if (rv2?.address) v2Map.set(String(rv2.address).toLowerCase(), rv2);
  }

  const allVaults = db.prepare('SELECT * FROM vaults ORDER BY address').all();
  const vaults = chainFilter
    ? allVaults.filter(v => chainFilter.has(Number(v.chain_id)))
    : allVaults;

  const allocRows = db.prepare(`
    SELECT va.*, m.*
    FROM vault_allocations va
    JOIN markets m ON va.market_unique_key = m.unique_key
  `).all();

  const peerRowsByMarket = new Map();
  for (const a of allocRows) {
    if (!peerRowsByMarket.has(a.market_unique_key)) peerRowsByMarket.set(a.market_unique_key, []);
    peerRowsByMarket.get(a.market_unique_key).push(a);
  }

  const allocsByVault = new Map();
  for (const a of allocRows) {
    a.peer_supply_usd = computePeerSupplyUsd(peerRowsByMarket.get(a.market_unique_key), a.vault_address, a);
    const k = String(a.vault_address || '').toLowerCase();
    if (!allocsByVault.has(k)) allocsByVault.set(k, []);
    allocsByVault.get(k).push(a);
  }

  const watchRows = db.prepare('SELECT vault_address, state_json FROM vault_watch_state').all();
  const watchMap = new Map();
  for (const r of watchRows) {
    try {
      watchMap.set(String(r.vault_address).toLowerCase(), JSON.parse(r.state_json));
    } catch {
      watchMap.set(String(r.vault_address).toLowerCase(), null);
    }
  }

  const pendingRows = db.prepare("SELECT id, vault_address, dedupe_key, status, valid_at FROM vault_events WHERE status = 'pending'").all();
  const pendingByVault = new Map();
  for (const r of pendingRows) {
    const k = String(r.vault_address).toLowerCase();
    if (!pendingByVault.has(k)) pendingByVault.set(k, []);
    pendingByVault.get(k).push(r);
  }

  const windowMaxStmt = db.prepare(`
    SELECT total_assets AS assets, total_assets_usd AS usd
    FROM vault_samples
    WHERE vault_address = ? AND sampled_at >= ? AND total_assets > 0
    ORDER BY total_assets DESC LIMIT 1
  `);
  const samplesToWrite = [];
  const eventsToInsert = [];
  const statusUpdates = [];
  const nextWatchStates = [];
  const watchAddressesToDelete = [];

  for (const vault of vaults) {
    const addr = String(vault.address).toLowerCase();
    const allocs = allocsByVault.get(addr) || [];
    const prevState = watchMap.get(addr) || null;
    const rawV1 = v1Map.get(addr) || null;
    const rawV2 = v2Map.get(addr) || null;

    const capsMap = { ...(prevState?.caps || {}) };
    for (const a of allocs) {
      if (a.market_unique_key && a.supply_cap_human !== null && a.supply_cap_human !== undefined) {
        capsMap[a.market_unique_key] = Number(a.supply_cap_human);
      }
    }
    const capsById = {};
    if (Array.isArray(rawV2?.caps?.items)) {
      for (const capItem of rawV2.caps.items) {
        if (capItem?.id) {
          capsById[capItem.id] = {
            absolute: formatUnits(capItem.absoluteCap ?? 0, vault.asset_decimals ?? 18),
            relative: Number(capItem.relativeCap ?? 0) / 1e18
          };
        }
        const mId = capItem?.data?.market?.marketId;
        const decimals = capItem?.data?.market?.loanAsset?.decimals ?? vault.asset_decimals ?? 18;
        if (mId && capItem.absoluteCap !== undefined && capItem.absoluteCap !== null) {
          capsMap[mId] = formatUnits(capItem.absoluteCap, decimals);
        }
      }
    }

    const vaultContext = {
      address: vault.address,
      chainId: vault.chain_id,
      name: vault.name,
      assetSymbol: vault.asset_symbol,
      assetDecimals: vault.asset_decimals,
      assetPriceUsd: vault.asset_price_usd,
      fee: vault.fee,
      performanceFee: rawV2?.performanceFee ?? vault.fee,
      managementFee: rawV2?.managementFee ?? null,
      timelock: rawV1?.state?.timelock !== undefined ? Number(rawV1.state.timelock) : (prevState?.timelock ?? null),
      guardian: rawV1?.state?.guardian ?? prevState?.guardian ?? null,
      timelocks: rawV2?.timelocks || [],
      caps: capsMap,
      capsById,
      assetsHuman: Number(vault.total_assets || 0) / (10 ** (Number.isFinite(Number(vault.asset_decimals)) ? Number(vault.asset_decimals) : 18)),
      allocations: allocs
    };

    // Only diff adminEvents when rawV1 is present and contains adminEvents.items; never move lastAdminEventTs backwards
    let lastAdminEventTs = prevState?.last_admin_event_ts ?? null;
    if (rawV1 && Array.isArray(rawV1.adminEvents?.items)) {
      const adminDiff = diffAdminEvents(vaultContext, rawV1.adminEvents.items, prevState, nowSec);
      eventsToInsert.push(...adminDiff.events);
      lastAdminEventTs = lastAdminEventTs !== null && lastAdminEventTs !== undefined
        ? Math.max(Number(lastAdminEventTs), Number(adminDiff.lastAdminEventTs ?? 0))
        : adminDiff.lastAdminEventTs;
    }

    // Only diff pendingConfigs when the vault was returned in rawV1 or rawV2 AND its response includes pendingConfigs.items
    const hasV1Pending = Boolean(rawV1 && Array.isArray(rawV1.state?.pendingConfigs?.items));
    const hasV2Pending = Boolean(rawV2 && Array.isArray(rawV2.pendingConfigs?.items));
    if (hasV1Pending || hasV2Pending) {
      const rawPendingConfigs = hasV1Pending
        ? rawV1.state.pendingConfigs.items
        : rawV2.pendingConfigs.items;
      const existingPending = pendingByVault.get(addr) || [];
      const pendingDiff = diffPendingConfigs(vaultContext, rawPendingConfigs, existingPending, nowSec);
      eventsToInsert.push(...pendingDiff.events);
      statusUpdates.push(...pendingDiff.statusUpdates);
    }

    const scoredVault = withEffectiveTotal(vault, allocs);
    const verdict = generateVaultVerdict(scoredVault, allocs, nowSec);
    const nextState = buildWatchState(vault, allocs, verdict, {
      fee: vault.fee,
      timelock: vaultContext.timelock,
      guardian: vaultContext.guardian,
      lastAdminEventTs,
      nowSec
    });

    const derivedEvents = diffDerivedState(prevState, nextState, vaultContext, nowSec);
    eventsToInsert.push(...derivedEvents);

    const decimals = Number.isFinite(Number(vault.asset_decimals)) ? Number(vault.asset_decimals) : 18;
    const assetsTokens = vault.total_assets !== null && vault.total_assets !== undefined ? Number(vault.total_assets) / (10 ** decimals) : null;
    const priced = !nextState.unpriced;
    if (priced && assetsTokens !== null && Number.isFinite(assetsTokens)) {
      const win = windowMaxStmt.get(vault.address, nowSec - 86400);
      if (win) {
        const outflow = detectTvlOutflow({ ...vaultContext, unpriced: false }, assetsTokens, win.assets, win.usd, nowSec);
        if (outflow) eventsToInsert.push(outflow);
      }
    }
    samplesToWrite.push([
      vault.address, Math.floor(nowSec / 3600), nowSec,
      assetsTokens !== null && Number.isFinite(assetsTokens) ? assetsTokens : null,
      priced ? nextState.total_assets_usd : null,
      vault.net_apy ?? null, nextState.mqi_percent, nextState.verdict_level, nextState.fee, nextState.is_listed
    ]);

    nextWatchStates.push({
      vaultAddress: vault.address,
      stateJson: JSON.stringify(nextState)
    });
  }

  // Detect vaults that were removed from the vaults table (delisted or missed >= 3 syncs) on full syncs only
  if (!chainFilter) {
    const activeVaultAddresses = new Set(allVaults.map(v => String(v.address).toLowerCase()));
    for (const r of watchRows) {
      const lowerAddr = String(r.vault_address).toLowerCase();
      if (!activeVaultAddresses.has(lowerAddr)) {
        const savedState = watchMap.get(lowerAddr) || {};
        const chainId = Number(savedState.chain_id ?? 1);
        const vaultName = savedState.name ?? null;
        eventsToInsert.push({
          vault_address: r.vault_address,
          chain_id: chainId,
          kind: 'vault_delisted',
          source: 'derived',
          severity: 'warning',
          status: 'final',
          title: vaultName
            ? `Vault ${vaultName} was delisted from Morpho registry`
            : 'Vault was delisted from Morpho registry',
          details_json: JSON.stringify({
            vaultName,
            previousListed: 1,
            currentListed: 0
          }),
          dedupe_key: buildDedupeKey('derived', {
            vaultAddress: r.vault_address,
            kind: 'vault_delisted',
            bucket: 'delisted'
          }),
          occurred_at: nowSec,
          valid_at: null,
          detected_at: nowSec
        });
        watchAddressesToDelete.push(r.vault_address);
      }
    }
  }

  const insertEventStmt = db.prepare(`
    INSERT OR IGNORE INTO vault_events (
      vault_address, chain_id, kind, source, severity, status,
      title, details_json, dedupe_key, occurred_at, valid_at, detected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updatePendingStmt = db.prepare(`
    UPDATE vault_events
    SET status = ?
    WHERE id = ?
  `);

  const upsertWatchStmt = db.prepare(`
    INSERT INTO vault_watch_state (vault_address, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(vault_address) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `);

  const upsertSampleStmt = db.prepare(`
    INSERT OR REPLACE INTO vault_samples (
      vault_address, hour_bucket, sampled_at, total_assets, total_assets_usd, net_apy, mqi_percent, verdict_level, fee, is_listed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteWatchStmt = db.prepare(`
    DELETE FROM vault_watch_state
    WHERE vault_address = ?
  `);

  let insertedCount = 0;
  let updatedPendingCount = 0;
  let prunedCount = 0;

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    for (const ev of eventsToInsert) {
      const res = insertEventStmt.run(
        ev.vault_address,
        ev.chain_id,
        ev.kind,
        ev.source,
        ev.severity,
        ev.status || 'final',
        ev.title,
        ev.details_json,
        ev.dedupe_key,
        ev.occurred_at,
        ev.valid_at ?? null,
        ev.detected_at
      );
      insertedCount += Number(res?.changes || 0);
    }

    for (const upd of statusUpdates) {
      const res = updatePendingStmt.run(upd.status, upd.id);
      updatedPendingCount += Number(res?.changes || 0);
    }

    for (const ws of nextWatchStates) {
      upsertWatchStmt.run(ws.vaultAddress, ws.stateJson, nowSec);
    }

    for (const sample of samplesToWrite) upsertSampleStmt.run(...sample);
    db.prepare('DELETE FROM vault_samples WHERE sampled_at < ?').run(nowSec - SAMPLE_RETENTION_SECONDS);

    for (const delAddr of watchAddressesToDelete) {
      deleteWatchStmt.run(delAddr);
    }

    prunedCount = pruneOldEvents(db, nowSec, options.retentionDays ?? DEFAULT_RETENTION_DAYS);

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return {
    insertedCount,
    updatedPendingCount,
    prunedCount,
    vaultsProcessed: vaults.length,
    samplesWritten: samplesToWrite.length
  };
}
