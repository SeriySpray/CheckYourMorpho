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
  'idx_allocations_vault', 'idx_allocations_vault_supply', 'idx_allocations_market', 'idx_daily_apys_vault', 'idx_snapshots_vault_time',
  'idx_vault_events_vault_occurred', 'idx_vault_events_occurred', 'idx_vault_events_status_valid'
];

export default {
  SCHEMA_SQL: [
    ['створює всі вісім таблиць', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name).sort();
      db.close();
      assert.deepEqual(names, ['daily_apys', 'markets', 'sync_state', 'vault_allocations', 'vault_events', 'vault_snapshots', 'vault_watch_state', 'vaults']);
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
      ins(db, 'daily_apys', { vault_address: '0xa', date: '2026-01-01' });
      assert.throws(() => ins(db, 'daily_apys', { vault_address: '0xa', date: '2026-01-01' }), /UNIQUE/);
      const ev = { vault_address: '0xa', chain_id: 1, kind: 'k', source: 's', severity: 'info', title: 't', details_json: '{}', dedupe_key: 'dup-1', occurred_at: 1, detected_at: 1 };
      ins(db, 'vault_events', ev);
      assert.throws(() => ins(db, 'vault_events', ev), /UNIQUE/);
      ins(db, 'vault_watch_state', { vault_address: '0xa', state_json: '{}', updated_at: 1 });
      assert.throws(() => ins(db, 'vault_watch_state', { vault_address: '0xa', state_json: '{}', updated_at: 2 }), /UNIQUE/);
      db.close();
    }],
    ['NOT NULL: vault без chain_id і алокація без ринку відхиляються', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      assert.throws(() => ins(db, 'vaults', { address: '0xa' }), /NOT NULL/);
      ins(db, 'vaults', { address: '0xb', chain_id: 1 });
      assert.throws(() => ins(db, 'vault_allocations', { vault_address: '0xb' }), /NOT NULL/);
      db.close();
    }],
    ['зовнішні ключі увімкнені самою схемою: алокації, APY і знімки неіснуючого vault відхиляються', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      for (const [t, row] of [['vault_allocations', { vault_address: '0xnone', market_unique_key: 'm' }],
        ['daily_apys', { vault_address: '0xnone', date: 'd' }], ['vault_snapshots', { vault_address: '0xnone', timestamp: 1 }]]) {
        assert.throws(() => ins(db, t, row), /FOREIGN KEY/, t);
      }
      db.close();
    }],
    ['ON DELETE CASCADE: видалення vault прибирає алокації, APY і знімки, але зберігає ринки, інші vaults, події та watch_state', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      for (const a of ['0xa', '0xb']) {
        ins(db, 'vaults', { address: a, chain_id: 1 });
        ins(db, 'vault_allocations', { vault_address: a, market_unique_key: 'm' });
        ins(db, 'daily_apys', { vault_address: a, date: 'd' });
        ins(db, 'vault_snapshots', { vault_address: a, timestamp: 1 });
        ins(db, 'vault_events', { vault_address: a, chain_id: 1, kind: 'k', source: 's', severity: 'info', title: 't', details_json: '{}', dedupe_key: `k-${a}`, occurred_at: 1, detected_at: 1 });
        ins(db, 'vault_watch_state', { vault_address: a, state_json: '{}', updated_at: 1 });
      }
      ins(db, 'markets', { unique_key: 'm', chain_id: 1 });
      db.prepare("DELETE FROM vaults WHERE address = '0xa'").run();
      const left = ['vault_allocations', 'daily_apys', 'vault_snapshots', 'vault_events', 'vault_watch_state', 'markets', 'vaults'].map(t => count(db, t));
      db.close();
      assert.deepEqual(left, [1, 1, 1, 2, 2, 1, 1]);
    }],
    ['upsert vault (ON CONFLICT DO UPDATE) не видаляє його алокації', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      ins(db, 'vaults', { address: '0xa', chain_id: 1 });
      ins(db, 'vault_allocations', { vault_address: '0xa', market_unique_key: 'm' });
      db.prepare("INSERT INTO vaults (address, chain_id, name) VALUES ('0xa', 1, 'n') ON CONFLICT(address) DO UPDATE SET name = excluded.name").run();
      const c = count(db, 'vault_allocations'); db.close();
      assert.equal(c, 1);
    }],
    ['знімки отримують автоінкрементний id', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      ins(db, 'vaults', { address: '0xa', chain_id: 1 });
      ins(db, 'vault_snapshots', { vault_address: '0xa', timestamp: 1 }); ins(db, 'vault_snapshots', { vault_address: '0xa', timestamp: 2 });
      const idsList = db.prepare('SELECT id FROM vault_snapshots ORDER BY id').all().map(r => r.id); db.close();
      assert.deepEqual(idsList, [1, 2]);
    }],
    ['повторне виконання ідемпотентне і зберігає дані', ({ SCHEMA_SQL }) => {
      const db = fresh(SCHEMA_SQL);
      ins(db, 'vaults', { address: '0xa', chain_id: 1, name: 'keep' });
      db.exec(SCHEMA_SQL);
      const name = db.prepare('SELECT name FROM vaults').get().name; db.close();
      assert.equal(name, 'keep');
    }],
    ['на файловій БД вмикає WAL', ({ SCHEMA_SQL }) => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cym-schema-')), 's.db');
      const db = new DatabaseSync(file); db.exec(SCHEMA_SQL);
      const mode = db.prepare('PRAGMA journal_mode').get().journal_mode; db.close();
      assert.equal(mode, 'wal');
    }],
  ],
};
