import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from '../db/database.js';
import { CONFIG } from '../config.js';
import { generateVaultVerdict } from '../engine/verdictEngine.js';
import { calculateMQI, isMarketClean } from '../engine/mqiEngine.js';
import { calculateHHI } from '../engine/hhiEngine.js';
import { calculateLiquidityMetrics } from '../engine/liquidityEngine.js';
import { syncAllVaults, isSyncing, getLastSyncResult, onSyncSuccess } from '../services/syncEngine.js';
import { formatUnits } from '../services/normalizers.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');
const clientDir = path.resolve(rootDir, 'client');

// In-memory cache for instant 0ms vault audit responses (30s TTL, bounded to 500 entries)
const AUDIT_CACHE_TTL_MS = 30000;
const AUDIT_CACHE_MAX_SIZE = 500;
const vaultAuditCache = new Map();

// Engine metrics for the whole catalogue, computed once per sync epoch; /api/vaults filters this in memory.
// The TTL only covers writers outside this process (the server/sync.js CLI), whose syncs fire no listener here.
const CATALOG_TTL_MS = 60000;
let vaultCatalog = null;

export const DEFAULT_VAULTS_LIMIT = 500;

// Every successful sync (manual or scheduled) invalidates both caches
onSyncSuccess(() => {
  vaultAuditCache.clear();
  vaultCatalog = null;
});

// Sliding-window counter per client IP for /api/* (two fixed windows, weighted): O(1) memory per IP
const RATE_LIMIT_MAX_TRACKED_IPS = 10000;
const rateHits = new Map();

/** Client IP: the peer address, or nginx's appended X-Forwarded-For entry when the peer is the local proxy. */
export function clientIp(req) {
  const peer = req.socket?.remoteAddress || '';
  if (!/^(127\.|::1$|::ffff:127\.)/.test(peer)) return ipv6Prefix(peer);
  // nginx appends $remote_addr last; earlier entries come from the client and can be forged
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length > 0 ? ipv6Prefix(forwarded[forwarded.length - 1]) : peer;
}

/** Rate-limit key: an IPv6 client owns a whole /64, so rotating addresses inside it does not reset the budget. */
function ipv6Prefix(ip) {
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Counts one request for ip; returns seconds to wait when over budget, otherwise 0. */
export function checkRateLimit(ip, now = Date.now()) {
  const { windowMs, maxRequests } = CONFIG.server.rateLimit;
  const win = Math.floor(now / windowMs);
  let entry = rateHits.get(ip);
  if (!entry || entry.win < win - 1) entry = { win, cur: 0, prev: 0 };
  else if (entry.win === win - 1) entry = { win, cur: 0, prev: entry.cur };
  const elapsed = (now % windowMs) / windowMs;
  if (entry.prev * (1 - elapsed) + entry.cur >= maxRequests) {
    rateHits.set(ip, entry);
    return Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
  }
  entry.cur++;
  rateHits.set(ip, entry);
  if (rateHits.size > RATE_LIMIT_MAX_TRACKED_IPS) {
    for (const [k, e] of rateHits) if (e.win < win - 1) rateHits.delete(k);
    // Trim to 90% (oldest first) so a flood of new IPs does not pay for a full sweep on every request
    for (const k of rateHits.keys()) {
      if (rateHits.size <= RATE_LIMIT_MAX_TRACKED_IPS * 0.9) break;
      rateHits.delete(k);
    }
  }
  return 0;
}

/**
 * Peer supply for one allocation: other vaults' positions in the same market (> $1K).
 * Look-through positions of V2 vaults (via_vault set) are skipped because they are already part of the
 * underlying V1 vault's own position; when the audited vault is such a V2 vault, its slice is removed
 * from that underlying vault's position so it does not appear as its own competitor.
 */
export function summarizePeers(marketRows, vaultAddress, alloc) {
  let total = 0;
  const peers = [];
  for (const r of marketRows || []) {
    if (r.vault_address === vaultAddress || r.via_vault) continue;
    let supply = Number(r.supply_assets_usd) || 0;
    if (alloc.via_vault && r.vault_address === alloc.via_vault) {
      supply -= Number(alloc.supply_assets_usd) || 0;
    }
    if (supply <= 1000) continue;
    total += supply;
    peers.push({ vaultAddress: r.vault_address, vaultName: r.vault_name, supplyUsd: supply });
  }
  peers.sort((a, b) => b.supplyUsd - a.supplyUsd);
  return { total, peers: peers.slice(0, 5) };
}

/**
 * A vault the API reports with 0 USD total but with priced allocations would otherwise score as perfectly
 * clean (MQI 100%, exit 100%); fall back to the sum of its allocations.
 */
export function withEffectiveTotal(vault, allocations) {
  if ((Number(vault.total_assets_usd) || 0) > 0) return vault;
  const sum = allocations.reduce((acc, a) => acc + (Number(a.supply_assets_usd) || 0), 0);
  return sum > 0 ? { ...vault, total_assets_usd: sum } : vault;
}

/** Constant-time comparison of a presented secret against the expected one. */
export function safeEqual(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

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
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

// style 'unsafe-inline' is needed for style="" attributes in index.html and innerHTML templates; scripts stay 'self' only
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

/**
 * Sends a standardized JSON response.
 */
export function sendJson(res, statusCode, data, req = null, extraHeaders = {}) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  if (req && req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(json);
}

/**
 * Handles CORS preflight requests.
 */
export function handleCors(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  });
  res.end();
}

/**
 * Serves static assets from the client directory safely.
 */
export function serveStaticFile(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  // Null byte or poison injection check
  if (!pathname || pathname.includes('\0') || pathname.includes('%00')) {
    sendJson(res, 400, { error: 'Bad Request' });
    return;
  }

  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: 'Bad Request: Malformed URI component' });
    return;
  }

  let relativePath = decodedPathname === '/' || decodedPathname === '' ? 'index.html' : decodedPathname;
  
  // Normalize and prevent path traversal or dotfiles (.git, .env)
  const normalized = path.normalize(relativePath);
  const segments = normalized.split(path.sep);
  if (segments.some(s => s.startsWith('.'))) {
    sendJson(res, 403, { error: 'Access denied' });
    return;
  }

  const filePath = path.resolve(clientDir, '.' + path.sep + normalized);
  const relFromClient = path.relative(clientDir, filePath);
  if (relFromClient.startsWith('..') || path.isAbsolute(relFromClient)) {
    sendJson(res, 403, { error: 'Access denied' });
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const ext = path.extname(pathname);
      const acceptsHtml = (req.headers.accept || '').includes('text/html');
      if (!ext && acceptsHtml) {
        const fallbackPath = path.join(clientDir, 'index.html');
        fs.stat(fallbackPath, (fbErr, fbStats) => {
          if (!fbErr && fbStats.isFile()) {
            serveFile(fallbackPath, req, res);
          } else {
            sendJson(res, 404, { error: 'Resource not found' }, req);
          }
        });
        return;
      }
      sendJson(res, 404, { error: 'Resource not found' }, req);
      return;
    }

    serveFile(filePath, req, res);
  });
}

export function serveFile(filePath, req, res) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJson(res, 500, { error: 'Internal server error reading asset' }, req);
      return;
    }
    // Code and markup must update on deploy; images and fonts rarely change and are safe to cache for a day
    const longLived = contentType.startsWith('image/') || contentType.startsWith('font/');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Permissions-Policy': PERMISSIONS_POLICY,
      ...(longLived
        ? { 'Cache-Control': 'public, max-age=86400' }
        : { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' })
    });
    if (req && req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(content);
  });
}

/**
 * Handler for GET /api/status
 */
export function handleGetStatus(req, res) {
  try {
    const db = getDatabase();
    const syncRow = db.prepare("SELECT value, updated_at FROM sync_state WHERE key = 'last_sync_all'").get();
    const vaultsCount = db.prepare('SELECT COUNT(*) as count FROM vaults').get()?.count || 0;
    const listedVaultsCount = db.prepare('SELECT COUNT(*) as count FROM vaults WHERE is_listed = 1').get()?.count || 0;
    const marketsCount = db.prepare('SELECT COUNT(*) as count FROM markets').get()?.count || 0;
    const allocationsCount = db.prepare('SELECT COUNT(*) as count FROM vault_allocations').get()?.count || 0;
    // last_sync_all is written only by a committed full sync, and survives restarts unlike lastSyncResult
    const lastSuccessSec = syncRow ? Number(syncRow.value) : NaN;
    const hasSucceeded = Number.isFinite(lastSuccessSec) && lastSuccessSec > 0;

    sendJson(res, 200, {
      status: 'ok',
      stale: !hasSucceeded || Date.now() - lastSuccessSec * 1000 > 3 * CONFIG.sync.intervalMs,
      lastSuccessAt: hasSucceeded ? new Date(lastSuccessSec * 1000).toISOString() : null,
      isSyncInProgress: isSyncing(),
      lastSync: {
        timestamp: syncRow ? Number(syncRow.value) : null,
        updatedAt: syncRow ? syncRow.updated_at : null
      },
      lastSyncResult: getLastSyncResult(),
      stats: {
        vaultsCount,
        listedVaultsCount,
        marketsCount,
        allocationsCount
      }
    }, req);
  } catch (err) {
    console.error('[API] Failed to retrieve system status:', err);
    sendJson(res, 500, { error: 'Failed to retrieve system status' });
  }
}

/**
 * Handler for POST /api/sync
 */
export async function handlePostSync(req, res, url) {
  // Manual sync is an operator action: disabled unless SYNC_TOKEN is configured, and always token-protected
  const expectedToken = process.env.SYNC_TOKEN || '';
  const givenToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expectedToken || !safeEqual(givenToken, expectedToken)) {
    sendJson(res, expectedToken ? 401 : 403, { error: expectedToken ? 'Unauthorized' : 'Manual sync is disabled' });
    return;
  }

  if (isSyncing()) {
    sendJson(res, 409, { error: 'Synchronization is already in progress' });
    return;
  }

  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > 1024) {
    sendJson(res, 413, { error: 'Payload Too Large' });
    req.destroy();
    return;
  }
  req.resume();

  const awaitSync = url.searchParams.get('await') === '1' || url.searchParams.get('await') === 'true';
  const fetchHistory = url.searchParams.get('fetchHistory') === '1' || url.searchParams.get('fetchHistory') === 'true';

  const runSync = async () => {
    try {
      await syncAllVaults({
        fetchHistoryForTop: fetchHistory,
        minAssetsUsdForHistory: 50000
      });
      return getLastSyncResult();
    } catch (err) {
      console.error('[API] Synchronization failed:', err);
      throw err;
    }
  };

  if (awaitSync) {
    req.socket.setTimeout(0); // a full sync outlasts the default 20s idle timeout
    try {
      const result = await runSync();
      sendJson(res, 200, { status: 'sync_completed', result });
    } catch (err) {
      sendJson(res, 500, { status: 'sync_failed', error: 'Synchronization failed' });
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

// Map, not an object: sortBy=constructor or __proto__ must not resolve to a prototype property
const SORT_FIELDS = new Map([
  ['liquidity_usd', 'liquidityUsd'],
  ['total_assets_usd', 'totalAssetsUsd'],
  ['net_apy', 'netApy'],
  ['apy', 'apy'],
  ['name', 'name']
]);
const MAX_SEARCH_LENGTH = 64;

// SQLite ordering: NULL sorts below every value
function compareNullsFirst(a, b) {
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Handler for GET /api/vaults
 */
export function handleGetVaults(req, res, url) {
  try {
    // Query parameters with strict validation
    const rawLimit = parseInt(url.searchParams.get('limit') || String(DEFAULT_VAULTS_LIMIT), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(1000, Math.max(1, rawLimit)) : DEFAULT_VAULTS_LIMIT;
    const rawOffset = parseInt(url.searchParams.get('offset') || '0', 10);
    const offset = Number.isFinite(rawOffset) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, rawOffset)) : 0;
    const rawChainId = url.searchParams.get('chainId');
    const parsedChainId = rawChainId ? parseInt(rawChainId, 10) : null;
    const chainId = (parsedChainId !== null && Number.isFinite(parsedChainId) && parsedChainId > 0) ? parsedChainId : null;
    const listedOnly = url.searchParams.get('listedOnly') === '1' || url.searchParams.get('listedOnly') === 'true';
    const search = (url.searchParams.get('search') || '').trim().slice(0, MAX_SEARCH_LENGTH).toLowerCase();
    const sortField = SORT_FIELDS.get(url.searchParams.get('sortBy')) || 'liquidityUsd';
    const direction = (url.searchParams.get('sortOrder') || 'desc').toUpperCase() === 'ASC' ? 1 : -1;

    const matches = getVaultCatalog().filter(v =>
      (chainId === null || v.chainId === chainId) &&
      (!listedOnly || v.isListed) &&
      (!search || [v.name, v.symbol, v.address, v.curatorName, v.asset.symbol]
        .some(f => f != null && String(f).toLowerCase().includes(search)))
    );
    matches.sort((a, b) => direction * compareNullsFirst(a[sortField], b[sortField]));

    sendJson(res, 200, { total: matches.length, limit, offset, vaults: matches.slice(offset, offset + limit) }, req);
  } catch (err) {
    console.error('[API] Failed to fetch vaults list:', err);
    sendJson(res, 500, { error: 'Failed to fetch vaults list' });
  }
}

/** List entries with MQI/HHI/liquidity for every vault, ordered by address so sort ties stay stable. */
export function getVaultCatalog() {
  if (vaultCatalog && Date.now() - vaultCatalog.timestamp < CATALOG_TTL_MS) return vaultCatalog.vaults;
  const db = getDatabase();
  // SELECT * like the audit endpoint, so engines see the same vault fields in the list and in the audit
  const rows = db.prepare('SELECT * FROM vaults ORDER BY address').all();

  const allocRows = db.prepare(`
    SELECT va.*, m.*
    FROM vault_allocations va
    JOIN markets m ON va.market_unique_key = m.unique_key
  `).all();

  // Peer supplies per market come from the same rows: every allocation of every vault is loaded anyway
  const peerRowsByMarket = new Map();
  for (const a of allocRows) {
    if (!peerRowsByMarket.has(a.market_unique_key)) peerRowsByMarket.set(a.market_unique_key, []);
    peerRowsByMarket.get(a.market_unique_key).push(a);
  }
  const allocMap = new Map();
  for (const a of allocRows) {
    a.peer_supply_usd = summarizePeers(peerRowsByMarket.get(a.market_unique_key), a.vault_address, a).total;
    const k = a.vault_address.toLowerCase();
    if (!allocMap.has(k)) allocMap.set(k, []);
    allocMap.get(k).push(a);
  }

  const vaults = rows.map(row => {
    const allocs = allocMap.get(row.address.toLowerCase()) || [];
    const scored = withEffectiveTotal(row, allocs);
    const mqi = calculateMQI(scored, allocs);
    const hhi = calculateHHI(scored, allocs);
    const liq = calculateLiquidityMetrics(scored, allocs);

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
      stressedExitCapPercent: liq.stressedExitCapacityPercent,
      stressedExitCapUsd: liq.stressedExitCapacityUsd,
      isCrowded: liq.isCrowded,
      crowdedMarketsCount: liq.crowdedMarkets?.length || 0,
      apy: row.apy,
      netApy: row.net_apy,
      fee: row.fee,
      mqiPercent: mqi.mqiPercent,
      isAllClean: mqi.isAllClean,
      compromisedCount: mqi.compromisedMarkets?.length || 0,
      unresolvedPercent: mqi.unresolvedPercent,
      hhi: hhi.hhi,
      hhiTier: hhi.tier,
      effectiveAssets: hhi.effectiveAssets,
      updatedAt: row.metadata_updated_at
    };
  });

  vaultCatalog = { timestamp: Date.now(), vaults };
  return vaults;
}

/**
 * Handler for GET /api/vaults/:address
 * Employs Stale-While-Revalidate: returns local SQLite audit metrics immediately (<1ms)
 * and dispatches lightweight non-blocking revalidation for the latest 10 transactions.
 */
export function handleGetVaultByAddress(req, res, address) {
  try {
    const cleanAddress = address.toLowerCase();
    const cached = vaultAuditCache.get(cleanAddress);
    if (cached && (Date.now() - cached.timestamp < AUDIT_CACHE_TTL_MS)) {
      sendJson(res, 200, cached.data, req);
      return;
    }

    const db = getDatabase();

    // Direct index seek on primary key
    const vault = db.prepare('SELECT * FROM vaults WHERE address = ?').get(cleanAddress);
    if (!vault) {
      sendJson(res, 404, { error: `Vault with address '${address}' not found` });
      return;
    }

    // Active allocations joined with market data (uses index seek on vault_address)
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
        va.via_vault,
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
      WHERE va.vault_address = ?
      ORDER BY va.supply_assets_usd DESC
    `).all(cleanAddress);

    // Aggregate competing peer vaults across shared markets for Crowded Exit analysis
    const marketKeys = allocations.map(a => a.market_unique_key);
    const peerRowsByMarket = new Map();
    if (marketKeys.length > 0) {
      const peerRows = db.prepare(`
        SELECT va.market_unique_key, va.vault_address, v.name AS vault_name, va.supply_assets_usd, va.via_vault
        FROM vault_allocations va
        JOIN vaults v ON va.vault_address = v.address
        WHERE va.market_unique_key IN (SELECT value FROM json_each(?))
      `).all(JSON.stringify(marketKeys));
      for (const r of peerRows) {
        if (!peerRowsByMarket.has(r.market_unique_key)) peerRowsByMarket.set(r.market_unique_key, []);
        peerRowsByMarket.get(r.market_unique_key).push(r);
      }
    }

    for (const alloc of allocations) {
      const peerData = summarizePeers(peerRowsByMarket.get(alloc.market_unique_key), cleanAddress, alloc);
      alloc.peer_supply_usd = peerData.total;
      alloc.peer_vaults = peerData.peers;
    }

    // Compute comprehensive institutional audit verdict (MQI + HHI + Exit Liquidity)
    const verdict = generateVaultVerdict(withEffectiveTotal(vault, allocations), allocations);
    const compromisedKeys = new Set(verdict.mqi.compromisedMarkets.map(m => m.marketUniqueKey));

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
        // Same decision as the MQI engine (materiality incl. cumulative rule), so table and score agree
        const isFlagged = !test.isClean && compromisedKeys.has(a.market_unique_key);

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

    if (vaultAuditCache.size >= AUDIT_CACHE_MAX_SIZE) {
      const oldestKey = vaultAuditCache.keys().next().value;
      if (oldestKey) vaultAuditCache.delete(oldestKey);
    }
    vaultAuditCache.set(cleanAddress, { timestamp: Date.now(), data: responsePayload });
    sendJson(res, 200, responsePayload, req);
  } catch (err) {
    console.error('[API] Failed to compute vault audit report:', err);
    sendJson(res, 500, { error: 'Failed to compute vault audit report' });
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

  // WHATWG URL turns "\\" into "/", which would let /api\vaults slip past a reverse proxy matching /api/
  // A leading // would be parsed by WHATWG URL as a protocol-relative host and skip the /api/ matching
  if (req.url.includes('\\') || req.url.startsWith('//')) {
    sendJson(res, 400, { error: 'Bad Request' });
    return;
  }

  let parsedUrl;
  try {
    const rawHost = req.headers.host || 'localhost';
    const sanitizedHost = /^[a-zA-Z0-9.:_-]+$/.test(rawHost) ? rawHost : 'localhost';
    parsedUrl = new URL(req.url, `http://${sanitizedHost}`);
  } catch {
    sendJson(res, 400, { error: 'Bad Request: Malformed URL or Host header' });
    return;
  }

  const pathname = parsedUrl.pathname;

  // REST API Routes
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (pathname.startsWith('/api/')) {
    const retryAfterSec = checkRateLimit(clientIp(req));
    if (retryAfterSec > 0) {
      sendJson(res, 429, { error: 'Too Many Requests' }, req, { 'Retry-After': String(retryAfterSec) });
      return;
    }
  }

  if (pathname === '/api/status' && isRead) {
    handleGetStatus(req, res);
    return;
  }

  if (pathname === '/api/sync' && req.method === 'POST') {
    handlePostSync(req, res, parsedUrl).catch(err => {
      console.error('[API] Sync request handler failed:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    });
    return;
  }

  if (pathname === '/api/vaults' && isRead) {
    handleGetVaults(req, res, parsedUrl);
    return;
  }

  const vaultMatch = pathname.match(/^\/api\/vaults\/([^/]+)$/);
  if (vaultMatch && isRead) {
    const address = vaultMatch[1].trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      sendJson(res, 400, { error: 'Invalid Ethereum address format (must be 0x followed by 40 hex characters)' });
      return;
    }
    handleGetVaultByAddress(req, res, address.toLowerCase());
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
