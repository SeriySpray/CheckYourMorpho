import assert from 'node:assert/strict';

// Раннер підміняє CONFIG.db.path на тимчасову копію data/morpho.db, тому оригінал не змінюється.
export default {
  getDatabase: [
    ['повертає той самий екземпляр (singleton)', ({ getDatabase }) => assert.equal(getDatabase(), getDatabase())],
    ['foreign_keys увімкнено', ({ getDatabase }) =>
      assert.equal(getDatabase().prepare('PRAGMA foreign_keys').get().foreign_keys, 1)],
    ['схема містить основні таблиці', ({ getDatabase }) => {
      const names = getDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
      for (const t of ['vaults', 'markets', 'vault_allocations']) assert.ok(names.includes(t), t);
    }],
    ['дані читаються (COUNT вольтів >= 0)', ({ getDatabase }) =>
      assert.ok(getDatabase().prepare('SELECT COUNT(*) AS c FROM vaults').get().c >= 0)],
  ],
  checkpointDatabase: [
    ['не кидає виняток при відкритій БД', ({ getDatabase, checkpointDatabase }) => { getDatabase(); checkpointDatabase(); }],
  ],
  checkpointDatabaseTruncate: [
    ['не кидає виняток при відкритій БД', ({ getDatabase, checkpointDatabaseTruncate }) => { getDatabase(); checkpointDatabaseTruncate(); }],
  ],
  closeDatabase: [
    ['закриває БД, а наступний getDatabase відкриває нову', ({ getDatabase, closeDatabase }) => {
      const first = getDatabase(); closeDatabase(); const second = getDatabase();
      assert.notEqual(first, second); assert.ok(second.prepare('SELECT 1 AS x').get().x === 1);
    }],
    ['повторне закриття безпечне', ({ closeDatabase }) => { closeDatabase(); closeDatabase(); }],
  ],
};
