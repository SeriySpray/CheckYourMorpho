import { fetchVaultAdminEvents } from './morphoApi.js';
import { diffAdminEvents } from '../engine/eventsEngine.js';

const PASS_KEY = 'admin_history_pass';
const PASS = 1;
const PAUSE_MS = 250;
let running = false;

// What can raise a warning. Reallocations and queue changes are left out: hundreds per vault, severity info
export const HISTORY_ADMIN_TYPES = Object.freeze([
  'setFee', 'setFeeRecipient', 'setTimelock', 'submitTimelock', 'revokePendingTimelock', 'setCap',
  'setGuardian', 'submitGuardian', 'revokePendingGuardian', 'setCurator', 'ownershipTransferred',
  'ownershipTransferStarted', 'setOwner', 'transferOwnership', 'setIsAllocator', 'setSkimRecipient',
  'revokePendingMarketRemoval', 'revokeMarketRemoval',
  'revokePendingCap', 'revokeCap', 'skim'
]);

/**
 * Loads the whole admin history (fees, caps, guardian, owner, allocators, queues) of every V1 vault from the Morpho API, once.
 * V2 vaults have no admin history in the API, and derived events (TVL drop, low exit) cannot be rebuilt: they stay as the server saw them.
 * Events already stored are kept (same dedupe_key); the repeat filter of live sync is skipped because it compares with the newest stored event.
 */
export async function backfillAdminEvents(db, nowSec = Math.floor(Date.now() / 1000)) {
  if (running) return 0;
  if (Number(db.prepare('SELECT value FROM sync_state WHERE key = ?').get(PASS_KEY)?.value) === PASS) return 0;
  running = true;
  let added = 0;
  let failed = 0;
  try {
    const vaults = db.prepare("SELECT address, chain_id, name, asset_symbol, asset_decimals, asset_price_usd FROM vaults WHERE version = 'v1'").all();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO vault_events (
        vault_address, chain_id, kind, source, severity, status, title, details_json, dedupe_key, occurred_at, valid_at, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const v of vaults) {
      try {
        const items = await fetchVaultAdminEvents(v.address, v.chain_id, 0, 100, HISTORY_ADMIN_TYPES);
        const ctx = { address: v.address, chainId: v.chain_id, name: v.name, assetSymbol: v.asset_symbol, assetDecimals: v.asset_decimals, assetPriceUsd: v.asset_price_usd, allocations: [] };
        const { events: all } = diffAdminEvents(ctx, items, { last_admin_event_ts: 0, caps: {} }, nowSec);
        const events = all.filter(e => e.severity !== 'info'); // decreases and the like are routine: only warnings fill the history
        db.exec('BEGIN;');
        try {
          for (const e of events) {
            added += Number(insert.run(e.vault_address, e.chain_id, e.kind, e.source, e.severity, e.status || 'final', e.title, e.details_json, e.dedupe_key, e.occurred_at, e.valid_at ?? null, e.detected_at).changes || 0);
          }
          db.exec('COMMIT;');
        } catch (err) {
          db.exec('ROLLBACK;');
          throw err;
        }
      } catch (err) {
        failed++;
        console.warn(`[History] Admin events skipped ${v.address}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, PAUSE_MS));
    }
    if (failed === 0) {
      db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(PASS_KEY, String(PASS), nowSec);
    }
    console.log(`[History] Admin events backfill done: ${added} events added from ${vaults.length} V1 vaults, ${failed} failed.`);
  } finally {
    running = false;
  }
  return added;
}
