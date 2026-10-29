import { fetchMorphoGraphQL } from './morphoApi.js';

const DAY_SEC = 86400;
const TRUNCATED_AT_DAYS = 400; // the first version of the backfill stopped here: such vaults are asked again for the older days
const MIN_DAYS_BEFORE_SKIP = 20; // a vault with this many daily rows already has a history
const PAUSE_MS = 250; // the API is shared with the sync: one request at a time with a short pause
const PASS_KEY = 'history_api_pass';
const PASS = 2; // 2: closed days take Net APY and TVL from the API for every vault (own samples measure another moment of the day)
const attempted = new Set(); // one try per vault and process: a vault the API cannot answer must not be asked on every sync
let running = false;

/** V1 and V2 name the same two time series differently. */
export function buildHistoryQuery(version) {
  const v2 = version === 'v2';
  const root = v2 ? 'vaultV2ByAddress' : 'vaultByAddress';
  const apy = v2 ? 'avgNetApy' : 'netApy';
  const opts = '(options: { startTimestamp: $start, endTimestamp: $end, interval: DAY })';
  return `query VaultHistory($address: String!, $chainId: Int!, $start: Int!, $end: Int!) {
    ${root}(address: $address, chainId: $chainId) {
      historicalState { apy: ${apy}${opts} { x y } tvl: totalAssetsUsd${opts} { x y } }
    }
  }`;
}

/** Joins the two series by day. Days before the vault held anything (TVL under $1) are skipped. */
export function parseHistory(data) {
  const state = data?.vaultByAddress?.historicalState || data?.vaultV2ByAddress?.historicalState;
  if (!state) return [];
  const byDay = new Map();
  for (const p of state.tvl || []) {
    const tvl = Number(p?.y);
    if (Number.isFinite(tvl) && tvl >= 1) byDay.set(Math.floor(Number(p.x) / DAY_SEC), { tvlUsd: tvl, netApy: null });
  }
  for (const p of state.apy || []) {
    const row = byDay.get(Math.floor(Number(p?.x) / DAY_SEC));
    const apy = Number(p?.y);
    if (row && p?.y !== null && Number.isFinite(apy)) row.netApy = apy;
  }
  return [...byDay].map(([day, r]) => ({ day, ...r })).sort((a, b) => a.day - b.day);
}

/**
 * Fills vault_daily for vaults that have little history (or stop at the old 400-day limit), from the Morpho API (daily Net APY and TVL, all it has).
 * Closed days take APY and TVL from the API, the exit and market counts of the server's own samples are kept.
 */
export async function backfillHistory(db, nowSec = Math.floor(Date.now() / 1000)) {
  if (running) return 0;
  running = true;
  let filled = 0;
  const today = Math.floor(nowSec / DAY_SEC);
  try {
    const fullPass = Number(db.prepare('SELECT value FROM sync_state WHERE key = ?').get(PASS_KEY)?.value) !== PASS;
    const vaults = db.prepare(fullPass ? 'SELECT address, chain_id, version FROM vaults' : `
      SELECT v.address, v.chain_id, v.version FROM vaults v
      WHERE (SELECT COUNT(*) FROM vault_daily d WHERE d.vault_address = v.address) < ?
         OR (SELECT MIN(d.day) FROM vault_daily d WHERE d.vault_address = v.address) >= ?
    `).all(...(fullPass ? [] : [MIN_DAYS_BEFORE_SKIP, today - TRUNCATED_AT_DAYS - 5])).filter(v => !attempted.has(v.address));
    // A closed day is replaced by the API value (keeping exit and market counts of our own sample); today belongs to the server's own sample
    const upsert = db.prepare(`
      INSERT INTO vault_daily (vault_address, day, net_apy, tvl_usd) VALUES (?, ?, ?, ?)
      ON CONFLICT(vault_address, day) DO UPDATE SET net_apy = COALESCE(excluded.net_apy, net_apy), tvl_usd = excluded.tvl_usd
    `);
    const insertToday = db.prepare('INSERT OR IGNORE INTO vault_daily (vault_address, day, net_apy, tvl_usd) VALUES (?, ?, ?, ?)');
    let failed = 0;

    for (const v of vaults) {
      attempted.add(v.address);
      try {
        const data = await fetchMorphoGraphQL(buildHistoryQuery(v.version), {
          address: v.address, chainId: Number(v.chain_id), start: 0, end: nowSec
        });
        const rows = parseHistory(data);
        db.exec('BEGIN;');
        try {
          for (const r of rows) (r.day < today ? upsert : insertToday).run(v.address, r.day, r.netApy, r.tvlUsd);
          db.exec('COMMIT;');
        } catch (err) {
          db.exec('ROLLBACK;');
          throw err;
        }
        if (rows.length > 0) filled++;
      } catch (err) {
        failed++;
        console.warn(`[History] Backfill skipped ${v.address}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, PAUSE_MS));
    }
    if (fullPass && failed === 0) {
      db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(PASS_KEY, String(PASS), nowSec);
    }
    if (vaults.length > 0) console.log(`[History] Backfill done: ${filled} of ${vaults.length} vaults filled.`);
  } finally {
    running = false;
  }
  return filled;
}
