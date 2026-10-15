import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

export default {
  SCHEMA_SQL: [
    ['виконується на порожній БД у пам\'яті', ({ SCHEMA_SQL }) => {
      const db = new DatabaseSync(':memory:'); db.exec(SCHEMA_SQL); db.close();
    }],
    ['створює таблиці vaults, markets, vault_allocations, sync_state', ({ SCHEMA_SQL }) => {
      const db = new DatabaseSync(':memory:'); db.exec(SCHEMA_SQL);
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
      db.close();
      for (const t of ['vaults', 'markets', 'vault_allocations', 'sync_state']) assert.ok(names.includes(t), t);
    }],
    ['повторне виконання ідемпотентне', ({ SCHEMA_SQL }) => {
      const db = new DatabaseSync(':memory:'); db.exec(SCHEMA_SQL); db.exec(SCHEMA_SQL); db.close();
    }],
  ],
};
