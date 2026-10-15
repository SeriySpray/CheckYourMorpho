import assert from 'node:assert/strict';

export default {
  CONFIG: [
    ['має секції api, chains, db, server, sync', ({ CONFIG }) => {
      for (const k of ['api', 'chains', 'db', 'server', 'sync']) assert.ok(CONFIG[k], k);
    }],
    ['ідентифікатори мереж унікальні', ({ CONFIG }) => {
      const ids = Object.values(CONFIG.chains); assert.equal(new Set(ids).size, ids.length);
    }],
    ['ethereum = 1, base = 8453', ({ CONFIG }) => {
      assert.equal(CONFIG.chains.ethereum, 1); assert.equal(CONFIG.chains.base, 8453);
    }],
    ['шлях БД закінчується на morpho.db', ({ CONFIG }) => assert.match(CONFIG.db.path, /morpho\.db$/)],
    ['інтервали й таймаути додатні', ({ CONFIG }) => {
      assert.ok(CONFIG.api.requestTimeoutMs > 0); assert.ok(CONFIG.sync.intervalMs > 0); assert.ok(CONFIG.sync.pageSize > 0);
    }],
  ],
};
