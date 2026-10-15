import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Раннер переписує CONFIG.db.path на тимчасову копію; окремий екземпляр модуля зберігає вихідні значення.
const original = () => import('../../server/config.js?original').then(m => m.CONFIG);

// Ідентифікатори мереж з незалежного джерела: перелік підтримуваних мереж Morpho (morpho_get_supported_chains).
const MORPHO_CHAIN_IDS = {
  ethereum: 1, optimism: 10, unichain: 130, polygon: 137, monad: 143, worldchain: 480, stable: 988, hyperevm: 999,
  tempo: 4217, robinhood: 4663, arc: 5042, base: 8453, arbitrum: 42161, katana: 747474
};

export default {
  CONFIG: [
    ['має секції api, chains, db, server, sync', ({ CONFIG }) => {
      for (const k of ['api', 'chains', 'db', 'server', 'sync']) assert.ok(CONFIG[k], k);
    }],
    ['мережі точно збігаються з переліком Morpho (назви та chainId)', ({ CONFIG }) => {
      assert.deepEqual({ ...CONFIG.chains }, MORPHO_CHAIN_IDS);
    }],
    ['ідентифікатори мереж унікальні додатні цілі', ({ CONFIG }) => {
      const ids = Object.values(CONFIG.chains); assert.equal(new Set(ids).size, ids.length);
      for (const id of ids) assert.ok(Number.isInteger(id) && id > 0, String(id));
    }],
    ['вихідний шлях БД: <корінь>/data/morpho.db', async () => {
      assert.equal((await original()).db.path, path.join(ROOT, 'data', 'morpho.db'));
    }],
    ['сервер слухає лише localhost:3000, саме туди проксіює nginx', ({ CONFIG }) => {
      assert.equal(CONFIG.server.host, 'localhost');
      const nginx = fs.readFileSync(path.join(ROOT, 'nginx_checkyourmorpho.conf'), 'utf8');
      const ports = [...nginx.matchAll(/proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)/g)].map(m => Number(m[1]));
      assert.ok(ports.length > 0); for (const p of ports) assert.equal(p, CONFIG.server.port);
    }],
    ['API Morpho: HTTPS-ендпоінт GraphQL', ({ CONFIG }) => {
      assert.equal(CONFIG.api.morphoGraphqlUrl, 'https://api.morpho.org/graphql');
    }],
    ['таймаути й повтори в розумних межах: запит коротший за інтервал синхронізації', ({ CONFIG }) => {
      assert.ok(Number.isInteger(CONFIG.api.maxRetries) && CONFIG.api.maxRetries >= 1);
      assert.ok(CONFIG.api.requestTimeoutMs > 0 && CONFIG.api.requestTimeoutMs < CONFIG.sync.intervalMs);
      assert.ok(CONFIG.api.pageThrottleMs >= 0);
      assert.ok(CONFIG.sync.intervalMs >= 60000, 'частіше ніж раз на хвилину перевантажить API');
    }],
  ],
};
