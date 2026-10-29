import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Кожен тест - окрема БД у пам'яті (або файл, де потрібен WAL), незалежна від getDatabase().
// node:sqlite вмикає foreign_keys за замовчуванням; вимикаємо, щоб перевіряти саме PRAGMA зі схеми.
const fresh = SCHEMA_SQL => { const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false }); db.exec(SCHEMA_SQL); return db; };
const ins = (db, table, row) => db.prepare(
  `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`
).run(...Object.values(row));
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;

// Індекси, на які спираються запити routes.js і syncEngine.js (переписано зі схеми вручну).
const EXPECTED_INDEXES = [
  'idx_vaults_version', 'idx_vaults_chain', 'idx_vaults_curator', 'idx_vaults_is_listed', 'idx_vaults_total_assets',
  'idx_vaults_liquidity', 'idx_vaults_listed_liq', 'idx_vaults_listed_assets', 'idx_vaults_listed_net_apy',
  'idx_vaults_listed_chain_liq', 'idx_vaults_listed_chain_assets', 'idx_markets_chain', 'idx_markets_loan_collateral',
  'idx_allocations_vault', 'idx_allocations_vault_supply', 'idx_allocations_market',
  'idx_vault_events_vault_occurred', 'idx_vault_events_occurred', 'idx_vault_events_status_valid', 'idx_tg_subscriptions_chat', 'idx_token_data_history_token'
];

export default {
  SCHEMA_SQL: [
    ['створює всі 12 таблиць', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name).sort();
      db.close();
      assert.deepEqual(names, ['markets', 'sync_state', 'tg_sent', 'tg_subscriptions', 'token_data', 'token_data_history', 'token_tags', 'vault_allocations', 'vault_daily', 'vault_events', 'vault_samples', 'vault_watch_state', 'vaults']);
    }],
    ['створює всі очікувані індекси', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all().map(r => r.name).sort();
      db.close();
      assert.deepEqual(idx, [...EXPECTED_INDEXES].sort());
    }],
    ['значення за замовчуванням для vault, ринку та події', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      ins(db, 'vaults', { address: '0xa', chain_id: 1 }); ins(db, 'markets', { unique_key: 'm', chain_id: 1 });
      ins(db, 'vault_events', {
        vault_address: '0xa', chain_id: 1, kind: 'fee_changed', source: 'admin_event',
        severity: 'warning', title: 't', details_json: '{}', dedupe_key: 'k1', occurred_at: 1, detected_at: 1
      });
      const v = db.prepare('SELECT version, liquidity_usd, is_listed, missed_syncs FROM vaults').get();
      const m = db.prepare('SELECT is_listed, oracle_type, bad_debt_usd, realized_bad_debt_usd, warnings_count FROM markets').get();
      const e = db.prepare('SELECT status, valid_at FROM vault_events').get();
      db.close();
      assert.deepEqual({ ...v }, { version: 'v1', liquidity_usd: 0, is_listed: 0, missed_syncs: 0 });
      assert.deepEqual({ ...m }, { is_listed: 1, oracle_type: 'ChainlinkOracleV2', bad_debt_usd: 0, realized_bad_debt_usd: 0, warnings_count: 0 });
      assert.deepEqual({ ...e }, { status: 'final', valid_at: null });
    }],
    ['первинні ключі та UNIQUE: дубль адреси vault, пари (vault, ринок) і dedupe_key події відхиляються', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      ins(db, 'vaults', { address: '0xa', chain_id: 1 });
      assert.throws(() => ins(db, 'vaults', { address: '0xa', chain_id: 8453 }), /UNIQUE/);
      ins(db, 'vault_allocations', { vault_address: '0xa', market_unique_key: 'm1' });
      ins(db, 'vault_allocations', { vault_address: '0xa', market_unique_key: 'm2' });
      assert.throws(() => ins(db, 'vault_allocations', { vault_address: '0xa', market_unique_key: 'm1' }), /UNIQUE/);
      const ev = { vault_address: '0xa', chain_id: 1, kind: 'k', source: 's', severity: 'info', title: 't', details_json: '{}', dedupe_key: 'dup-1', occurred_at: 1, detected_at: 1 };
      ins(db, 'vault_events', ev);
      assert.throws(() => ins(db, 'vault_events', ev), /UNIQUE/);
      ins(db, 'vault_watch_state', { vault_address: '0xa', state_json: '{}', updated_at: 1 });
      assert.throws(() => ins(db, 'vault_watch_state', { vault_address: '0xa', state_json: '{}', updated_at: 2 }), /UNIQUE/);
      db.close();
    }],
    ['vault_samples: один запис на vault і годину, повторний запис тієї ж години замінює попередній', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      const row = (t, assets) => ({ vault_address: '0xa', hour_bucket: 100, sampled_at: t, total_assets: assets });
      ins(db, 'vault_samples', row(1, 5));
      assert.throws(() => ins(db, 'vault_samples', row(2, 6)), /UNIQUE/);
      db.prepare('INSERT OR REPLACE INTO vault_samples (vault_address, hour_bucket, sampled_at, total_assets) VALUES (?, ?, ?, ?)').run('0xa', 100, 3, 7);
      const r = db.prepare('SELECT COUNT(*) AS c, MAX(total_assets) AS a FROM vault_samples').get(); db.close();
      assert.deepEqual({ ...r }, { c: 1, a: 7 });
    }],
    ['vault_daily: один запис на vault і добу, повторний запис тієї ж доби замінює попередній', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      ins(db, 'vault_daily', { vault_address: '0xa', day: 10, net_apy: 0.04 });
      assert.throws(() => ins(db, 'vault_daily', { vault_address: '0xa', day: 10, net_apy: 0.05 }), /UNIQUE/);
      db.prepare('INSERT OR REPLACE INTO vault_daily (vault_address, day, net_apy) VALUES (?, ?, ?)').run('0xa', 10, 0.06);
      const r = db.prepare('SELECT COUNT(*) AS c, MAX(net_apy) AS a FROM vault_daily').get(); db.close();
      assert.deepEqual({ ...r }, { c: 1, a: 0.06 });
    }],
    ['tg_sent: одне повідомлення на підписку, видалення підписки прибирає її журнал відправок', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      ins(db, 'tg_subscriptions', { sub_id: 's1', vaults_json: '[]', created_at: 1, updated_at: 1 });
      ins(db, 'tg_sent', { sub_id: 's1', message_key: 'k', sent_at: 1 });
      assert.throws(() => ins(db, 'tg_sent', { sub_id: 's1', message_key: 'k', sent_at: 2 }), /UNIQUE/);
      assert.throws(() => ins(db, 'tg_sent', { sub_id: 'nope', message_key: 'k', sent_at: 2 }), /FOREIGN KEY/);
      const s = db.prepare('SELECT active, chat_id, bound_at FROM tg_subscriptions').get();
      assert.deepEqual({ ...s }, { active: 1, chat_id: null, bound_at: null });
      db.prepare("DELETE FROM tg_subscriptions WHERE sub_id = 's1'").run();
      assert.equal(count(db, 'tg_sent'), 0); db.close();
    }],
    ['NOT NULL: vault без chain_id і алокація без ринку відхиляються', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      assert.throws(() => ins(db, 'vaults', { address: '0xa' }), /NOT NULL/);
      ins(db, 'vaults', { address: '0xb', chain_id: 1 });
      assert.throws(() => ins(db, 'vault_allocations', { vault_address: '0xb' }), /NOT NULL/);
      db.close();
    }],
    ['зовнішні ключі увімкнені самою схемою: алокація неіснуючого vault відхиляється', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      assert.throws(() => ins(db, 'vault_allocations', { vault_address: '0xnone', market_unique_key: 'm' }), /FOREIGN KEY/);
      db.close();
    }],
    ['ON DELETE CASCADE: видалення vault прибирає алокації, але зберігає ринки, інші vaults, події та watch_state', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      for (const a of ['0xa', '0xb']) {
        ins(db, 'vaults', { address: a, chain_id: 1 });
        ins(db, 'vault_allocations', { vault_address: a, market_unique_key: 'm' });
        ins(db, 'vault_events', { vault_address: a, chain_id: 1, kind: 'k', source: 's', severity: 'info', title: 't', details_json: '{}', dedupe_key: `k-${a}`, occurred_at: 1, detected_at: 1 });
        ins(db, 'vault_watch_state', { vault_address: a, state_json: '{}', updated_at: 1 });
      }
      ins(db, 'markets', { unique_key: 'm', chain_id: 1 });
      db.prepare("DELETE FROM vaults WHERE address = '0xa'").run();
      const left = ['vault_allocations', 'vault_events', 'vault_watch_state', 'markets', 'vaults'].map(t => count(db, t));
      db.close();
      assert.deepEqual(left, [1, 2, 2, 1, 1]);
    }],
    ['upsert vault (ON CONFLICT DO UPDATE) не видаляє його алокації', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      ins(db, 'vaults', { address: '0xa', chain_id: 1 });
      ins(db, 'vault_allocations', { vault_address: '0xa', market_unique_key: 'm' });
      db.prepare("INSERT INTO vaults (address, chain_id, name) VALUES ('0xa', 1, 'n') ON CONFLICT(address) DO UPDATE SET name = excluded.name").run();
      const c = count(db, 'vault_allocations'); db.close();
      assert.equal(c, 1);
    }],
    ['повторне виконання ідемпотентне і зберігає дані', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      ins(db, 'vaults', { address: '0xa', chain_id: 1, name: 'keep' });
      db.exec(SCHEMA_SQL);
      const name = db.prepare('SELECT name FROM vaults').get().name; db.close();
      assert.equal(name, 'keep');
    }],
    ['token_data: PRIMARY KEY (chain_id, address), NOT NULL для статусу і даних; history має автоінкрементний id', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      const row = { chain_id: 1, address: '0xa', collected_at: 1, status: 'ok', data_json: '{}' };
      ins(db, 'token_data', row);
      assert.throws(() => ins(db, 'token_data', row), /UNIQUE/);
      assert.throws(() => ins(db, 'token_data', { ...row, address: '0xb', status: null }), /NOT NULL/);
      assert.throws(() => ins(db, 'token_data', { ...row, address: '0xb', data_json: null }), /NOT NULL/);
      const h = { chain_id: 1, address: '0xa', collected_at: 1, status: 'ok', data_json: '{}' };
      ins(db, 'token_data_history', h); ins(db, 'token_data_history', h);
      assert.deepEqual(db.prepare('SELECT id FROM token_data_history ORDER BY id').all().map(r => r.id), [1, 2]);
      db.close();
    }],
    ['на файловій БД вмикає WAL', ({ SCHEMA_SQL }) => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cym-schema-')), 's.db');
      const db = new DatabaseSync(file); db.exec(SCHEMA_SQL);
      const mode = db.prepare('PRAGMA journal_mode').get().journal_mode; db.close();
      assert.equal(mode, 'wal');
    }],
  ],
};
