import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from '../../server/config.js';

// Раннер підміняє CONFIG.db.path на тимчасову копію data/morpho.db, тому оригінал не змінюється.

// Найстаріша схема: без колонок, які потім додавалися через ALTER TABLE (version, liquidity_usd, is_listed,
// missed_syncs, via_vault, ринкові is_listed/oracle_type/bad_debt/warnings) і з давно видаленою таблицею reallocations.
const OLD_SCHEMA = `
CREATE TABLE vaults (address TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, name TEXT, symbol TEXT, curator_name TEXT,
  asset_address TEXT, asset_symbol TEXT, asset_decimals INTEGER, asset_price_usd REAL, total_assets TEXT, total_assets_usd REAL,
  apy REAL, net_apy REAL, fee REAL, owner TEXT, pending_owner TEXT, metadata_updated_at INTEGER);
CREATE TABLE markets (unique_key TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, loan_asset_address TEXT, loan_asset_symbol TEXT,
  loan_asset_decimals INTEGER, loan_asset_price_usd REAL, collateral_asset_address TEXT, collateral_asset_symbol TEXT,
  collateral_asset_decimals INTEGER, collateral_asset_price_usd REAL, oracle_address TEXT, irm_address TEXT, lltv TEXT,
  lltv_percent REAL, total_supply_assets TEXT, total_supply_assets_usd REAL, total_borrow_assets TEXT, total_borrow_assets_usd REAL,
  free_liquidity_assets REAL, free_liquidity_usd REAL, utilization REAL, borrow_apy REAL, supply_apy REAL, updated_at INTEGER);
CREATE TABLE vault_allocations (vault_address TEXT NOT NULL, market_unique_key TEXT NOT NULL, supply_assets TEXT,
  supply_assets_human REAL, supply_assets_usd REAL, supply_cap TEXT, supply_cap_human REAL, weight REAL, updated_at INTEGER,
  PRIMARY KEY (vault_address, market_unique_key), FOREIGN KEY (vault_address) REFERENCES vaults(address) ON DELETE CASCADE);
CREATE TABLE reallocations (id TEXT PRIMARY KEY, vault_address TEXT NOT NULL, tx_hash TEXT NOT NULL, timestamp INTEGER NOT NULL,
  market_unique_key TEXT NOT NULL, FOREIGN KEY (vault_address) REFERENCES vaults(address) ON DELETE CASCADE);
INSERT INTO vaults (address, chain_id, name) VALUES ('0xold', 1, 'Legacy');
INSERT INTO markets (unique_key, chain_id, loan_asset_symbol) VALUES ('m-old', 1, 'USDC');
INSERT INTO vault_allocations (vault_address, market_unique_key, supply_assets_usd) VALUES ('0xold', 'm-old', 42);
`;

// Підставляє інший файл БД на час тесту і повертає попередній стан.
async function withDbAt(file, fn) {
  const mod = await import('../../server/db/database.js');
  const saved = CONFIG.db.path;
  mod.closeDatabase(); CONFIG.db.path = file;
  try { return await fn(mod); } finally { mod.closeDatabase(); CONFIG.db.path = saved; }
}
const tmpDb = (name = 'x.db') => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cym-db-')), name);
const oldDbFile = () => { const f = tmpDb('old.db'); const d = new DatabaseSync(f); d.exec(OLD_SCHEMA); d.close(); return f; };
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
const indexes = db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all().map(r => r.name);

export default {
  getDatabase: [
    ['стара БД: таблиці AI research видаляються, події collateral_tier_changed стираються, token_data створюється, інші події лишаються', async ({ getDatabase }) => {
      const f = oldDbFile(); const d = new DatabaseSync(f);
      d.exec(`CREATE TABLE token_research (chain_id INTEGER, address TEXT); CREATE TABLE token_research_history (id INTEGER PRIMARY KEY, chain_id INTEGER);
        CREATE TABLE vault_events (id INTEGER PRIMARY KEY AUTOINCREMENT, vault_address TEXT NOT NULL, chain_id INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
          severity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'final', title TEXT NOT NULL, details_json TEXT, dedupe_key TEXT NOT NULL UNIQUE,
          occurred_at INTEGER, valid_at INTEGER, detected_at INTEGER NOT NULL);
        INSERT INTO vault_events (vault_address, chain_id, kind, source, severity, title, dedupe_key, detected_at) VALUES
          ('0xold', 1, 'collateral_tier_changed', 'derived', 'info', 't', 'k1', 1), ('0xold', 1, 'tvl_drop', 'derived', 'info', 't', 'k2', 1);`);
      d.close();
      await withDbAt(f, mod => {
        const db = mod.getDatabase();
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
        assert.ok(!tables.includes('token_research') && !tables.includes('token_research_history'));
        assert.ok(tables.includes('token_data') && tables.includes('token_data_history'));
        assert.deepEqual(db.prepare('SELECT kind FROM vault_events').all().map(r => r.kind), ['tvl_drop']);
      });
    }],
    ['повертає той самий екземпляр (singleton)', ({ getDatabase }) => assert.equal(getDatabase(), getDatabase())],
    ['foreign_keys увімкнено, busy_timeout 5000, журнал WAL', ({ getDatabase }) => {
      const db = getDatabase();
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    }],
    ['схема містить усі таблиці', ({ getDatabase }) => {
      const names = getDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
      for (const t of ['vaults', 'markets', 'vault_allocations', 'sync_state', 'vault_events', 'vault_watch_state', 'vault_samples']) assert.ok(names.includes(t), t);
    }],
    ['створює відсутню вкладену теку для файлу БД', async () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cym-db-')), 'a', 'b', 'new.db');
      await withDbAt(file, async ({ getDatabase }) => { getDatabase(); assert.ok(fs.existsSync(file)); });
    }],
    ['видаляє застарілу token_classes і створює token_tags', async () => {
      const f = tmpDb('legacy.db'); const d = new DatabaseSync(f); d.exec('CREATE TABLE token_classes (chain_id INTEGER, address TEXT)'); d.close();
      await withDbAt(f, async ({ getDatabase }) => {
        const names = getDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
        assert.ok(!names.includes('token_classes')); assert.ok(names.includes('token_tags'));
      });
    }],
    ['мігрує стару схему: додає всі нові колонки', async () => withDbAt(oldDbFile(), async ({ getDatabase }) => {
      const db = getDatabase();
      for (const c of ['version', 'liquidity_usd', 'is_listed', 'missed_syncs', 'unresolved_exposure_usd']) assert.ok(cols(db, 'vaults').includes(c), `vaults.${c}`);
      for (const c of ['is_listed', 'oracle_type', 'bad_debt_usd', 'realized_bad_debt_usd', 'warnings_count', 'warnings_json']) {
        assert.ok(cols(db, 'markets').includes(c), `markets.${c}`);
      }
      assert.ok(cols(db, 'vault_allocations').includes('via_vault'));
      for (const t of ['sync_state', 'vault_events', 'vault_watch_state', 'vault_samples']) assert.ok(cols(db, t).length > 0, t);
    })],
    ['мігрує стару схему: наявні рядки отримують значення за замовчуванням (liquidity і bad debt невідомі, null), дані збережено', async () => withDbAt(oldDbFile(), async ({ getDatabase }) => {
      const db = getDatabase();
      assert.deepEqual({ ...db.prepare("SELECT name, version, liquidity_usd, is_listed, missed_syncs, unresolved_exposure_usd FROM vaults WHERE address = '0xold'").get() },
        { name: 'Legacy', version: 'v1', liquidity_usd: null, is_listed: 0, missed_syncs: 0, unresolved_exposure_usd: 0 });
      assert.deepEqual({ ...db.prepare("SELECT is_listed, oracle_type, bad_debt_usd, realized_bad_debt_usd, warnings_count, warnings_json FROM markets").get() },
        { is_listed: 1, oracle_type: 'ChainlinkOracleV2', bad_debt_usd: null, realized_bad_debt_usd: null, warnings_count: 0, warnings_json: null });
      assert.deepEqual({ ...db.prepare('SELECT supply_assets_usd, via_vault FROM vault_allocations').get() }, { supply_assets_usd: 42, via_vault: null });
    })],
    ['мігрує стару схему: індекси на нових колонках створено', async () => withDbAt(oldDbFile(), async ({ getDatabase }) => {
      const idx = indexes(getDatabase());
      for (const i of ['idx_vaults_version', 'idx_vaults_is_listed', 'idx_vaults_liquidity', 'idx_vaults_listed_liq', 'idx_vaults_listed_chain_assets', 'idx_allocations_market', 'idx_vault_events_vault_occurred', 'idx_vault_events_occurred', 'idx_vault_events_status_valid']) {
        assert.ok(idx.includes(i), i);
      }
    })],
    ['повторне відкриття мігрованої БД ідемпотентне, колонки не дублюються', async () => {
      const file = oldDbFile();
      let first;
      await withDbAt(file, async ({ getDatabase }) => { first = cols(getDatabase(), 'vaults'); });
      await withDbAt(file, async ({ getDatabase }) => {
        const again = cols(getDatabase(), 'vaults');
        assert.deepEqual(again, first); assert.equal(new Set(again).size, again.length);
      });
    }],
    ['після міграції каскадне видалення vault прибирає його алокації', async () => withDbAt(oldDbFile(), async ({ getDatabase }) => {
      const db = getDatabase();
      db.prepare("DELETE FROM vaults WHERE address = '0xold'").run();
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vault_allocations').get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM markets').get().c, 1, 'ринки не залежать від vault');
    })],
    ['зовнішній ключ блокує алокацію неіснуючого vault', async () => withDbAt(tmpDb(), async ({ getDatabase }) => {
      assert.throws(() => getDatabase().prepare("INSERT INTO vault_allocations (vault_address, market_unique_key) VALUES ('0xnone', 'm')").run(), /FOREIGN KEY/);
    })],
  ],
  checkpointDatabase: [
    ['не кидає виняток при відкритій БД', ({ getDatabase, checkpointDatabase }) => {
      getDatabase(); const log = console.log; console.log = () => {};
      try { checkpointDatabase(); } finally { console.log = log; }
    }],
    ['при закритій БД нічого не робить і не відкриває її', async () => withDbAt(tmpDb(), async ({ checkpointDatabase }) => {
      const log = console.log; let logged = 0; console.log = () => { logged++; };
      try { checkpointDatabase(); } finally { console.log = log; }
      assert.equal(logged, 0); assert.equal(fs.existsSync(CONFIG.db.path), false);
    })],
  ],
  checkpointDatabaseTruncate: [
    ['після запису обрізає WAL-файл до 0 байт', async () => withDbAt(tmpDb(), async ({ getDatabase, checkpointDatabaseTruncate }) => {
      const db = getDatabase();
      db.prepare("INSERT INTO vaults (address, chain_id) VALUES ('0xw', 1)").run();
      assert.ok(fs.statSync(CONFIG.db.path + '-wal').size > 0, 'WAL мав містити запис');
      checkpointDatabaseTruncate();
      assert.equal(fs.statSync(CONFIG.db.path + '-wal').size, 0);
    })],
    ['при закритій БД не кидає виняток', ({ closeDatabase, checkpointDatabaseTruncate }) => { closeDatabase(); checkpointDatabaseTruncate(); }],
  ],
  closeDatabase: [
    ['закриває БД: старий дескриптор непридатний, новий getDatabase відкриває інший', ({ getDatabase, closeDatabase }) => {
      const first = getDatabase(); closeDatabase();
      assert.throws(() => first.prepare('SELECT 1').get());
      const second = getDatabase();
      assert.notEqual(first, second); assert.equal(second.prepare('SELECT 1 AS x').get().x, 1);
    }],
    ['після закриття getDatabase бере новий CONFIG.db.path', async () => {
      const file = tmpDb('switch.db');
      await withDbAt(file, async ({ getDatabase }) => {
        getDatabase().prepare("INSERT INTO sync_state (key, value) VALUES ('k', 'v')").run();
      });
      const d = new DatabaseSync(file); const row = d.prepare("SELECT value FROM sync_state WHERE key = 'k'").get(); d.close();
      assert.equal(row.value, 'v');
    }],
    ['повторне закриття безпечне', ({ closeDatabase }) => { closeDatabase(); closeDatabase(); }],
  ],
};
