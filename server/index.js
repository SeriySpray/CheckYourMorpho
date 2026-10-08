import http from 'node:http';
import { CONFIG } from './config.js';
import { getDatabase, closeDatabase } from './db/database.js';
import { handleRequest } from './api/routes.js';
import { syncAllVaults, isSyncing } from './services/syncEngine.js';

// Global process error safety guards
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Initialize Database connection and verify WAL mode
const db = getDatabase();
const walStatus = db.prepare('PRAGMA journal_mode;').get()?.journal_mode || 'wal';
console.log(`[Database] SQLite initialized in ${String(walStatus).toUpperCase()} mode.`);

// Create native HTTP Server with Slowloris and socket exhaustion protection
const server = http.createServer(handleRequest);
server.requestTimeout = 15000;      // 15s total request timeout
server.headersTimeout = 8000;       // 8s headers reception timeout
server.keepAliveTimeout = 5000;     // 5s keep-alive timeout
server.timeout = 20000;             // 20s socket idle timeout
server.maxHeadersCount = 100;

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : CONFIG.server.port;
const HOST = process.env.HOST || CONFIG.server.host;

server.listen(PORT, HOST, () => {
  console.log(`[Server] CheckYourMorpho REST API running at http://${HOST}:${PORT}`);
  console.log(`[Server] Endpoints:`);
  console.log(`  - GET  /api/status`);
  console.log(`  - GET  /api/vaults (default limit: 300, sorted by liquidity)`);
  console.log(`  - GET  /api/vaults/:address`);
  console.log(`  - POST /api/sync`);
  console.log(`  - Static frontend assets served from client/`);
});

// Background recurring synchronization
let syncIntervalTimer = null;

async function runBackgroundSync() {
  if (isSyncing()) {
    console.log('[Scheduler] Background sync skipped (synchronization already in progress).');
    return;
  }
  try {
    console.log('[Scheduler] Running scheduled background synchronization...');
    const result = await syncAllVaults({ fetchHistoryForTop: false });
    const totalVaults = (result.v1Count || 0) + (result.v2Count || 0);
    console.log(`[Scheduler] Background synchronization completed in ${result.durationSec}s: ${totalVaults} vaults (${result.v1Count} V1, ${result.v2Count} V2), ${result.marketsCount} markets, ${result.allocationsCount} allocations.`);
  } catch (err) {
    console.error('[Scheduler] Background sync failed:', err.message);
  }
}

// Start recurring background sync timer
if (CONFIG.sync.intervalMs && CONFIG.sync.intervalMs > 0) {
  syncIntervalTimer = setInterval(runBackgroundSync, CONFIG.sync.intervalMs);
  console.log(`[Scheduler] Background synchronization scheduled every ${CONFIG.sync.intervalMs / 1000}s.`);
}

// Graceful shutdown handling
function handleShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
  if (syncIntervalTimer) {
    clearInterval(syncIntervalTimer);
    syncIntervalTimer = null;
  }
  server.close(() => {
    console.log('[Server] HTTP server closed.');
    try {
      closeDatabase();
      console.log('[Database] SQLite connection closed.');
    } catch (err) {
      console.error('[Database] Error closing database:', err.message);
    }
    process.exit(0);
  });

  // Force exit after 5 seconds if hanging
  setTimeout(() => {
    console.error('[Server] Forced exit after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
