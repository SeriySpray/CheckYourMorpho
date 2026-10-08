import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from '../db/database.js';
import { CONFIG } from '../config.js';
import { generateVaultVerdict } from '../engine/verdictEngine.js';
import { calculateMQI, isMarketClean } from '../engine/mqiEngine.js';
import { calculateHHI } from '../engine/hhiEngine.js';
import { calculateLiquidityMetrics } from '../engine/liquidityEngine.js';
import { syncAllVaults } from '../services/syncEngine.js';
import { formatUnits } from '../services/normalizers.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');
const clientDir = path.resolve(rootDir, 'client');

// Global synchronization state flag
let isSyncInProgress = false;
let lastSyncResult = null;

// In-memory cache for instant 0ms vault audit responses (30s TTL)
const AUDIT_CACHE_TTL_MS = 30000;
const vaultAuditCache = new Map();

// MIME types dictionary for static file serving
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Sends a standardized JSON response.
 */
function sendJson(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(json);
}

/**
 * Handles CORS preflight requests.
 */
function handleCors(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  });
  res.end();
}

/**
 * Serves static assets from the client directory.
 */
function serveStaticFile(req, res, pathname) {
  let relativePath = pathname === '/' || pathname === '' ? 'index.html' : pathname;
  
  // Normalize and prevent path traversal
  const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(clientDir, safePath);

  if (!filePath.startsWith(clientDir)) {
    sendJson(res, 403, { error: 'Access denied' });
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback: if requesting non-existent path and not starting with /api, serve index.html if it exists
      const fallbackPath = path.join(clientDir, 'index.html');
      fs.stat(fallbackPath, (fbErr, fbStats) => {
        if (!fbErr && fbStats.isFile()) {
          serveFile(fallbackPath, res);
        } else {
          sendJson(res, 404, { error: 'Resource not found' });
        }
      });
      return;
    }

    serveFile(filePath, res);
  });
}

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJson(res, 500, { error: 'Internal server error reading asset' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(content);
  });
}

/**
 * Handler for GET /api/status
 */
function handleGetStatus(req, res) {
  try {
    const db = getDatabase();
    const syncRow = db.prepare("SELECT value, updated_at FROM sync_state WHERE key = 'last_sync_all'").get();
    const vaultsCount = db.prepare('SELECT COUNT(*) as count FROM vaults').get()?.count || 0;
    const listedVaultsCount = db.prepare('SELECT COUNT(*) as count FROM vaults WHERE is_listed = 1').get()?.count || 0;
    const marketsCount = db.prepare('SELECT COUNT(*) as count FROM markets').get()?.count || 0;
    const allocationsCount = db.prepare('SELECT COUNT(*) as count FROM vault_allocations').get()?.count || 0;

    sendJson(res, 200, {
      status: 'ok',
      isSyncInProgress,
      lastSync: {
        timestamp: syncRow ? Number(syncRow.value) : null,
        updatedAt: syncRow ? syncRow.updated_at : null
      },
      lastSyncResult,
      stats: {
        vaultsCount,
        listedVaultsCount,
        marketsCount,
        allocationsCount
      }
    });
  } catch (err) {
    sendJson(res, 500, { error: 'Failed to retrieve system status', details: err.message });
  }
}

/**
 * Handler for POST /api/sync
 */
async function handlePostSync(req, res, url) {
  if (isSyncInProgress) {
    sendJson(res, 409, { error: 'Synchronization is already in progress' });
    return;
  }

  const awaitSync = url.searchParams.get('await') === '1' || url.searchParams.get('await') === 'true';
  const fetchHistory = url.searchParams.get('fetchHistory') === '1' || url.searchParams.get('fetchHistory') === 'true';

  isSyncInProgress = true;

  const runSync = async () => {
    try {
      const result = await syncAllVaults({
        fetchHistoryForTop: fetchHistory,
        minAssetsUsdForHistory: 50000
      });
      lastSyncResult = {
        success: true,
        completedAt: Math.floor(Date.now() / 1000),
        durationSec: result.durationSec,
        summary: result
      };
      vaultAuditCache.clear();
      return lastSyncResult;
    } catch (err) {
      lastSyncResult = {
        success: false,
        failedAt: Math.floor(Date.now() / 1000),
        error: err.message
      };
      console.error('[API] Synchronization failed:', err);
      throw err;
    } finally {
      isSyncInProgress = false;
    }
  };

  if (awaitSync) {
    try {
      const result = await runSync();
      sendJson(res, 200, { status: 'sync_completed', result });
    } catch (err) {
      sendJson(res, 500, { status: 'sync_failed', error: err.message });
    }
  } else {
    // Run in background
    runSync().catch(() => {});
    sendJson(res, 202, {
      status: 'sync_started',
      message: 'Vault synchronization started in background',
      fetchHistory
    });
  }
}

/**
 * Handler for GET /api/vaults
 */
function handleGetVaults(req, res, url) {
  try {
    const db = getDatabase();

    // Query parameters
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '500', 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
    const chainId = url.searchParams.get('chainId') ? parseInt(url.searchParams.get('chainId'), 10) : null;
    const listedOnly = url.searchParams.get('listedOnly') === '1' || url.searchParams.get('listedOnly') === 'true';
    const search = (url.searchParams.get('search') || '').trim();
    const sortBy = url.searchParams.get('sortBy') || 'liquidity_usd';
    const sortOrder = (url.searchParams.get('sortOrder') || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Whitelist sort columns
    const allowedSortColumns = {
      liquidity_usd: 'liquidity_usd',
      total_assets_usd: 'total_assets_usd',
      net_apy: 'net_apy',
      apy: 'apy',
      name: 'name'
    };
    const orderColumn = allowedSortColumns[sortBy] || 'liquidity_usd';

    // Build filter query
    const whereConditions = [];
    const params = [];

    if (chainId) {
      whereConditions.push('chain_id = ?');
      params.push(chainId);
    }

    if (listedOnly) {
      whereConditions.push('is_listed = 1');
    }

    if (search) {
      whereConditions.push('(name LIKE ? OR symbol LIKE ? OR address LIKE ? OR curator_name LIKE ? OR asset_symbol LIKE ?)');
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern, pattern, pattern);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Count matching rows
    const countSql = `SELECT COUNT(*) as count FROM vaults ${whereClause}`;
    const totalCount = db.prepare(countSql).get(...params)?.count || 0;

    // Fetch vaults
    const selectSql = `
      SELECT 
        address,
        chain_id,
        name,
        symbol,
        curator_name,
        asset_address,
        asset_symbol,
        asset_decimals,
        asset_price_usd,
        total_assets,
        total_assets_usd,
        liquidity_usd,
        apy,
        net_apy,
        fee,
        owner,
        pending_owner,
        version,
        is_listed,
        metadata_updated_at
      FROM vaults
      ${whereClause}
      ORDER BY ${orderColumn} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    const rows = db.prepare(selectSql).all(...params, limit, offset);

    // Batch load allocations for returned vaults to compute MQI & HHI
    const vaultAddresses = rows.map(r => r.address);
    const allocMap = new Map();
    if (vaultAddresses.length > 0) {
      const placeholders = vaultAddresses.map(() => '?').join(',');
      const allocRows = db.prepare(`
        SELECT va.*, m.* 
        FROM vault_allocations va 
        JOIN markets m ON va.market_unique_key = m.unique_key 
        WHERE va.vault_address IN (${placeholders})
      `).all(...vaultAddresses);
      for (const a of allocRows) {
        const k = a.vault_address.toLowerCase();
        if (!allocMap.has(k)) allocMap.set(k, []);
        allocMap.get(k).push(a);
      }
    }

    const vaults = rows.map(row => {
      const allocs = allocMap.get(row.address.toLowerCase()) || [];
      const mqi = calculateMQI(row, allocs);
      const hhi = calculateHHI(row, allocs);
      const liq = calculateLiquidityMetrics(row, allocs);

      return {
        address: row.address,
        chainId: row.chain_id,
        name: row.name,
        symbol: row.symbol,
        curatorName: row.curator_name,
        version: row.version,
        isListed: Boolean(row.is_listed),
        asset: {
          address: row.asset_address,
          symbol: row.asset_symbol,
          decimals: row.asset_decimals,
          priceUsd: row.asset_price_usd
        },
        totalAssets: row.total_assets,
        totalAssetsHuman: formatUnits(row.total_assets, row.asset_decimals),
        totalAssetsUsd: row.total_assets_usd,
        liquidityUsd: row.liquidity_usd,
        exitCapPercent: liq.instantExitCapacityPercent,
        exitCapUsd: liq.instantExitCapacityUsd,
        apy: row.apy,
        netApy: row.net_apy,
        fee: row.fee,
        mqiPercent: mqi.mqiPercent,
        isAllClean: mqi.isAllClean,
        compromisedCount: mqi.compromisedMarkets?.length || 0,
        hhi: hhi.hhi,
        hhiTier: hhi.tier,
        effectiveAssets: hhi.effectiveAssets,
        updatedAt: row.metadata_updated_at
      };
    });


    sendJson(res, 200, {
      total: totalCount,
      limit,
      offset,
      vaults
    });
  } catch (err) {
    sendJson(res, 500, { error: 'Failed to fetch vaults list', details: err.message });
  }
}

/**
 * Handler for GET /api/vaults/:address
 * Employs Stale-While-Revalidate: returns local SQLite audit metrics immediately (<1ms)
 * and dispatches lightweight non-blocking revalidation for the latest 10 transactions.
 */
function handleGetVaultByAddress(req, res, address) {
  try {
    const cacheKey = address.toLowerCase();
    const cached = vaultAuditCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < AUDIT_CACHE_TTL_MS)) {
      sendJson(res, 200, cached.data);
      return;
    }

    const db = getDatabase();

    const vault = db.prepare('SELECT * FROM vaults WHERE LOWER(address) = LOWER(?)').get(address);
    if (!vault) {
      sendJson(res, 404, { error: `Vault with address '${address}' not found` });
      return;
    }

    // Active allocations joined with market data
    const allocations = db.prepare(`
      SELECT 
        va.vault_address,
        va.market_unique_key,
        va.supply_assets,
        va.supply_assets_human,
        va.supply_assets_usd,
        va.supply_cap,
        va.supply_cap_human,
        va.weight,
        m.chain_id,
        m.loan_asset_address,
        m.loan_asset_symbol,
        m.loan_asset_decimals,
        m.loan_asset_price_usd,
        m.collateral_asset_address,
        m.collateral_asset_symbol,
        m.collateral_asset_decimals,
        m.collateral_asset_price_usd,
        m.oracle_address,
        m.irm_address,
        m.lltv,
        m.lltv_percent,
        m.total_supply_assets,
        m.total_supply_assets_usd,
        m.total_borrow_assets,
        m.total_borrow_assets_usd,
        m.free_liquidity_assets,
        m.free_liquidity_usd,
        m.utilization,
        m.borrow_apy,
        m.supply_apy,
        m.is_listed,
        m.oracle_type,
        m.bad_debt_usd,
        m.realized_bad_debt_usd,
        m.warnings_count,
        m.warnings_json
      FROM vault_allocations va
      JOIN markets m ON va.market_unique_key = m.unique_key
      WHERE LOWER(va.vault_address) = LOWER(?)
      ORDER BY va.supply_assets_usd DESC
    `).all(vault.address);

    // Aggregate competing peer vaults across shared markets for Crowded Exit analysis
    const marketKeys = allocations.map(a => a.market_unique_key);
    const peerMap = new Map();
    if (marketKeys.length > 0) {
      const placeholders = marketKeys.map(() => '?').join(',');
      const peerRows = db.prepare(`
        SELECT 
          va.market_unique_key,
          va.vault_address,
          v.name as vault_name,
          va.supply_assets_usd
        FROM vault_allocations va
        JOIN vaults v ON va.vault_address = v.address
        WHERE va.market_unique_key IN (${placeholders})
          AND LOWER(va.vault_address) != LOWER(?)
          AND va.supply_assets_usd > 1000
        ORDER BY va.supply_assets_usd DESC
      `).all(...marketKeys, vault.address);

      for (const row of peerRows) {
        const k = row.market_unique_key.toLowerCase();
        if (!peerMap.has(k)) {
          peerMap.set(k, { totalPeerSupplyUsd: 0, peers: [] });
        }
        const entry = peerMap.get(k);
        entry.totalPeerSupplyUsd += Number(row.supply_assets_usd) || 0;
        if (entry.peers.length < 5) {
          entry.peers.push({
            vaultAddress: row.vault_address,
            vaultName: row.vault_name,
            supplyUsd: Number(row.supply_assets_usd) || 0
          });
        }
      }
    }

    for (const alloc of allocations) {
      const k = (alloc.market_unique_key || '').toLowerCase();
      const peerData = peerMap.get(k) || { totalPeerSupplyUsd: 0, peers: [] };
      alloc.peer_supply_usd = peerData.totalPeerSupplyUsd;
      alloc.peer_vaults = peerData.peers;
    }

    // Compute comprehensive institutional audit verdict (MQI + HHI + Exit Liquidity)
    const verdict = generateVaultVerdict(vault, allocations);

    const responsePayload = {
      vault: {
        address: vault.address,
        chainId: vault.chain_id,
        name: vault.name,
        symbol: vault.symbol,
        curatorName: vault.curator_name,
        version: vault.version,
        isListed: Boolean(vault.is_listed),
        owner: vault.owner,
        pendingOwner: vault.pending_owner,
        asset: {
          address: vault.asset_address,
          symbol: vault.asset_symbol,
          decimals: vault.asset_decimals,
          priceUsd: vault.asset_price_usd
        },
        totalAssets: vault.total_assets,
        totalAssetsHuman: formatUnits(vault.total_assets, vault.asset_decimals),
        totalAssetsUsd: vault.total_assets_usd,
        liquidityUsd: vault.liquidity_usd,
        apy: vault.apy,
        netApy: vault.net_apy,
        fee: vault.fee,
        updatedAt: vault.metadata_updated_at
      },
      verdict,
      allocations: allocations.map(a => {
        const test = isMarketClean(a);
        const supplyUsd = Number(a.supply_assets_usd) || 0;
        const minMaterialThresholdUsd = (Number(vault.total_assets_usd) || 0) * 0.01;
        const isMaterial = supplyUsd > minMaterialThresholdUsd;
        const isFlagged = !test.isClean && isMaterial;

        return {
          marketUniqueKey: a.market_unique_key,
          loanSymbol: a.loan_asset_symbol,
          collateralSymbol: a.collateral_asset_symbol,
          lltvPercent: a.lltv_percent,
          supplyAssetsHuman: a.supply_assets_human,
          supplyAssetsUsd: a.supply_assets_usd,
          weight: a.weight,
          marketTotalSupplyUsd: a.total_supply_assets_usd,
          marketTotalBorrowUsd: a.total_borrow_assets_usd,
          marketFreeLiquidityUsd: a.free_liquidity_usd,
          marketUtilization: a.utilization,
          supplyApy: a.supply_apy,
          borrowApy: a.borrow_apy,
          isListed: a.is_listed !== 0,
          isClean: !isFlagged,
          isFlagged,
          oracleType: a.oracle_type || 'Unknown',
          badDebtUsd: a.bad_debt_usd || 0,
          warnings: test.reasons
        };
      })
    };

    vaultAuditCache.set(cacheKey, { timestamp: Date.now(), data: responsePayload });
    sendJson(res, 200, responsePayload);
  } catch (err) {
    sendJson(res, 500, { error: 'Failed to compute vault audit report', details: err.message });
  }
}

/**
 * Main HTTP request router.
 */
export function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    handleCors(req, res);
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // REST API Routes
  if (pathname === '/api/status' && req.method === 'GET') {
    handleGetStatus(req, res);
    return;
  }

  if (pathname === '/api/sync' && req.method === 'POST') {
    handlePostSync(req, res, parsedUrl);
    return;
  }

  if (pathname === '/api/vaults' && req.method === 'GET') {
    handleGetVaults(req, res, parsedUrl);
    return;
  }

  const vaultMatch = pathname.match(/^\/api\/vaults\/([0-9a-zA-Z]+)$/);
  if (vaultMatch && req.method === 'GET') {
    handleGetVaultByAddress(req, res, vaultMatch[1]);
    return;
  }

  // Any other /api/* request is a 404
  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'API endpoint not found' });
    return;
  }

  // Static files serving from client/
  serveStaticFile(req, res, pathname);
}
