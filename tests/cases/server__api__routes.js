import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mockReq, mockRes } from '../fixtures.js';

const call = (handleRequest, method, url, headers) => {
  const res = mockRes(); handleRequest(mockReq(method, url, headers), res); return res;
};
const callAsync = async (handleRequest, method, url, headers) => {
  const res = mockRes(); handleRequest(mockReq(method, url, headers), res); return res.done;
};
const URL_ = path => new URL(path, 'http://localhost');
const withEnv = async (name, value, fn) => {
  const saved = process.env[name]; process.env[name] = value;
  try { return await fn(); } finally { saved === undefined ? delete process.env[name] : process.env[name] = saved; }
};
const peerRow = (over = {}) => ({ vault_address: '0xp1', vault_name: 'P1', supply_assets_usd: 5000, via_vault: null, ...over });

export default {
  handleRequest: [
    ['OPTIONS -> 204 з CORS', ({ handleRequest }) => {
      const r = call(handleRequest, 'OPTIONS', '/api/vaults'); assert.equal(r.statusCode, 204); assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
    }],
    ['зворотний слеш у URL -> 400', ({ handleRequest }) => assert.equal(call(handleRequest, 'GET', '/api\\vaults').statusCode, 400)],
    ['невідомий /api/ маршрут -> 404', ({ handleRequest }) => assert.equal(call(handleRequest, 'GET', '/api/nope').statusCode, 404)],
    ['некоректна адреса вольта -> 400', ({ handleRequest }) => assert.equal(call(handleRequest, 'GET', '/api/vaults/0x123').statusCode, 400)],
    ['/api/status -> 200 зі статистикою', ({ handleRequest }) => {
      const r = call(handleRequest, 'GET', '/api/status'); const body = JSON.parse(r.body);
      assert.equal(r.statusCode, 200); assert.equal(body.status, 'ok'); assert.ok(body.stats.vaultsCount >= 0);
    }],
    ['HEAD /api/status -> 200 без тіла', ({ handleRequest }) => {
      const r = call(handleRequest, 'HEAD', '/api/status'); assert.equal(r.statusCode, 200); assert.equal(r.body, '');
    }],
    ['/api/vaults -> 200 і валідний JSON', ({ handleRequest }) => {
      const r = call(handleRequest, 'GET', '/api/vaults'); assert.equal(r.statusCode, 200); JSON.parse(r.body);
    }],
    ['відповіді API мають захисні заголовки', ({ handleRequest }) => {
      const h = call(handleRequest, 'GET', '/api/status').headers;
      assert.equal(h['X-Content-Type-Options'], 'nosniff'); assert.equal(h['X-Frame-Options'], 'DENY');
    }],
    ['невідома адреса вольта (валідний формат) -> 404', ({ handleRequest }) => {
      const r = call(handleRequest, 'GET', '/api/vaults/0x' + '0'.repeat(40)); assert.equal(r.statusCode, 404);
    }],
    ['статичний / віддає client/index.html', async ({ handleRequest }) => {
      const r = await callAsync(handleRequest, 'GET', '/'); assert.equal(r.statusCode, 200); assert.match(r.headers['Content-Type'], /text\/html/);
    }],
  ],
  summarizePeers: [
    ['порожні рядки -> total 0', ({ summarizePeers: f }) => assert.deepEqual(f(null, '0xv', {}), { total: 0, peers: [] })],
    ['власні позиції пропускаються', ({ summarizePeers: f }) =>
      assert.equal(f([peerRow({ vault_address: '0xv' })], '0xv', {}).peers.length, 0)],
    ['дрібні позиції (<= $1K) ігноруються', ({ summarizePeers: f }) =>
      assert.equal(f([peerRow({ supply_assets_usd: 1000 })], '0xv', {}).peers.length, 0)],
    ['look-through позиції (via_vault) пропускаються', ({ summarizePeers: f }) =>
      assert.equal(f([peerRow({ via_vault: '0xu' })], '0xv', {}).peers.length, 0)],
    ['пірів відсортовано за спаданням і обрізано до 5', ({ summarizePeers: f }) => {
      const rows = Array.from({ length: 7 }, (_, i) => peerRow({ vault_address: `0x${i}`, supply_assets_usd: 2000 + i * 100 }));
      const r = f(rows, '0xv', {});
      assert.equal(r.peers.length, 5); assert.equal(r.peers[0].supplyUsd, 2600);
      assert.equal(r.total, rows.reduce((s, x) => s + x.supply_assets_usd, 0));
    }],
    ['частка V2-вольта віднімається від базового V1', ({ summarizePeers: f }) => {
      const r = f([peerRow({ vault_address: '0xunder', supply_assets_usd: 10000 })], '0xv2', { via_vault: '0xunder', supply_assets_usd: 4000 });
      assert.equal(r.total, 6000);
    }],
  ],
  withEffectiveTotal: [
    ['додатний TVL повертає той самий вольт', ({ withEffectiveTotal: f }) => {
      const v = { total_assets_usd: 5 }; assert.equal(f(v, [{ supply_assets_usd: 100 }]), v);
    }],
    ['нульовий TVL замінюється сумою алокацій', ({ withEffectiveTotal: f }) =>
      assert.equal(f({ total_assets_usd: 0 }, [{ supply_assets_usd: 100 }, { supply_assets_usd: 50 }]).total_assets_usd, 150)],
    ['без алокацій вольт не змінюється', ({ withEffectiveTotal: f }) => {
      const v = { total_assets_usd: 0 }; assert.equal(f(v, []), v);
    }],
  ],
  safeEqual: [
    ['однакові секрети -> true', ({ safeEqual: f }) => assert.equal(f('abc', 'abc'), true)],
    ['різні секрети -> false', ({ safeEqual: f }) => assert.equal(f('abc', 'abd'), false)],
    ['різна довжина не кидає виняток', ({ safeEqual: f }) => assert.equal(f('a', 'abcdef'), false)],
    ['число і рядок порівнюються як рядки', ({ safeEqual: f }) => assert.equal(f(123, '123'), true)],
  ],
  sendJson: [
    ['пише статус, JSON і Content-Length', ({ sendJson: f }) => {
      const res = mockRes(); f(res, 201, { a: 1 });
      assert.equal(res.statusCode, 201); assert.equal(res.body, '{"a":1}'); assert.equal(res.headers['Content-Length'], 7);
    }],
    ['HEAD-запит не отримує тіла', ({ sendJson: f }) => {
      const res = mockRes(); f(res, 200, { a: 1 }, { method: 'HEAD' }); assert.equal(res.body, '');
    }],
    ['кирилиця рахується в байтах', ({ sendJson: f }) => {
      const res = mockRes(); f(res, 200, { t: 'я' }); assert.equal(res.headers['Content-Length'], Buffer.byteLength('{"t":"я"}'));
    }],
  ],
  handleCors: [
    ['відповідає 204 з дозволеними методами', ({ handleCors: f }) => {
      const res = mockRes(); f({}, res); assert.equal(res.statusCode, 204); assert.match(res.headers['Access-Control-Allow-Methods'], /GET/);
    }],
  ],
  serveStaticFile: [
    ['POST -> 405', ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('POST', '/'), res, '/'); assert.equal(res.statusCode, 405);
    }],
    ['null-байт у шляху -> 400', ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/'), res, '/a%00b'); assert.equal(res.statusCode, 400);
    }],
    ['битий URI-компонент -> 400', ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/'), res, '/%E0%A4%A'); assert.equal(res.statusCode, 400);
    }],
    ['dot-файли заборонені -> 403', ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/'), res, '/.env'); assert.equal(res.statusCode, 403);
    }],
    ['вихід за межі client/ не віддає файл', async ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/', {}), res, '/..%2f..%2fpackage.json'); await res.done;
      assert.ok([403, 404].includes(res.statusCode), String(res.statusCode));
    }],
    ['/ -> index.html', async ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/', {}), res, '/'); await res.done; assert.equal(res.statusCode, 200);
    }],
    ['неіснуючий файл з розширенням -> 404', async ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/', {}), res, '/nope.js'); await res.done; assert.equal(res.statusCode, 404);
    }],
    ['SPA-маршрут без розширення з Accept: text/html -> index.html', async ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/', { accept: 'text/html' }), res, '/vault/abc'); await res.done; assert.equal(res.statusCode, 200);
    }],
  ],
  serveFile: [
    ['існуючий файл -> 200 з правильним Content-Type', async ({ serveFile: f }) => {
      const res = mockRes(); f(fileURLToPath(new URL('../../client/index.html', import.meta.url)), mockReq('GET', '/'), res);
      await res.done; assert.equal(res.statusCode, 200); assert.match(res.headers['Content-Type'], /text\/html/);
    }],
    ['відсутній файл -> 500', async ({ serveFile: f }) => {
      const res = mockRes(); f('/definitely/missing.html', mockReq('GET', '/'), res); await res.done; assert.equal(res.statusCode, 500);
    }],
  ],
  handleGetStatus: [
    ['200 і status ok', ({ handleGetStatus: f }) => {
      const res = mockRes(); f(mockReq('GET', '/api/status'), res); assert.equal(JSON.parse(res.body).status, 'ok');
    }],
    ['HEAD без тіла', ({ handleGetStatus: f }) => {
      const res = mockRes(); f(mockReq('HEAD', '/api/status'), res); assert.equal(res.body, '');
    }],
  ],
  handlePostSync: [
    ['без SYNC_TOKEN синхронізація вимкнена -> 403', async ({ handlePostSync: f }) => withEnv('SYNC_TOKEN', '', async () => {
      const res = mockRes(); await f(mockReq('POST', '/api/sync'), res, URL_('/api/sync')); assert.equal(res.statusCode, 403);
    })],
    ['неправильний токен -> 401', async ({ handlePostSync: f }) => withEnv('SYNC_TOKEN', 'secret', async () => {
      const res = mockRes(); await f(mockReq('POST', '/api/sync', { authorization: 'Bearer wrong' }), res, URL_('/api/sync')); assert.equal(res.statusCode, 401);
    })],
    ['занадто велике тіло -> 413', async ({ handlePostSync: f }) => withEnv('SYNC_TOKEN', 'secret', async () => {
      const res = mockRes(); await f(mockReq('POST', '/api/sync', { authorization: 'Bearer secret', 'content-length': '5000' }), res, URL_('/api/sync')); assert.equal(res.statusCode, 413);
    })],
  ],
  handleGetVaults: [
    ['200 з total/limit/offset/vaults', ({ handleGetVaults: f }) => {
      const res = mockRes(); f(mockReq('GET', '/api/vaults'), res, URL_('/api/vaults'));
      const b = JSON.parse(res.body); assert.equal(res.statusCode, 200); assert.ok(Array.isArray(b.vaults)); assert.equal(typeof b.total, 'number');
    }],
    ['limit обмежує кількість вольтів', ({ handleGetVaults: f }) => {
      const res = mockRes(); f(mockReq('GET', '/api/vaults?limit=2'), res, URL_('/api/vaults?limit=2'));
      const b = JSON.parse(res.body); assert.equal(b.limit, 2); assert.ok(b.vaults.length <= 2);
    }],
    ['limit > 1000 обрізається до 1000', ({ handleGetVaults: f }) => {
      const res = mockRes(); f(mockReq('GET', '/api/vaults?limit=99999'), res, URL_('/api/vaults?limit=99999')); assert.equal(JSON.parse(res.body).limit, 1000);
    }],
    ['нечисловий limit -> значення за замовчуванням 500', ({ handleGetVaults: f }) => {
      const res = mockRes(); f(mockReq('GET', '/api/vaults?limit=abc'), res, URL_('/api/vaults?limit=abc')); assert.equal(JSON.parse(res.body).limit, 500);
    }],
    ['від\'ємний offset -> 0', ({ handleGetVaults: f }) => {
      const res = mockRes(); f(mockReq('GET', '/api/vaults?offset=-5'), res, URL_('/api/vaults?offset=-5')); assert.equal(JSON.parse(res.body).offset, 0);
    }],
  ],
  handleGetVaultByAddress: [
    ['невідомий вольт -> 404', ({ handleGetVaultByAddress: f }) => {
      const res = mockRes(); f(mockReq('GET', '/'), res, '0x' + '0'.repeat(40)); assert.equal(res.statusCode, 404);
    }],
    ['існуючий вольт -> vault, verdict, allocations', async ({ handleGetVaultByAddress: f }) => {
      const { getDatabase } = await import('../../server/db/database.js');
      const row = getDatabase().prepare('SELECT address FROM vaults LIMIT 1').get();
      if (!row) return; // порожня БД: нічого перевіряти
      const res = mockRes(); f(mockReq('GET', '/'), res, row.address);
      assert.deepEqual(Object.keys(JSON.parse(res.body)).sort(), ['allocations', 'vault', 'verdict']);
    }],
  ],
};
