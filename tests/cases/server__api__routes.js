import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../../server/config.js';
import { mockReq, mockRes, withFetch, jsonResponse } from '../fixtures.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'client', 'index.html'));
const PACKAGE_JSON = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');

const call = (handleRequest, method, url, headers) => {
  const res = mockRes(); handleRequest(mockReq(method, url, headers), res); return res;
};
const callAsync = async (handleRequest, method, url, headers) => {
  const res = mockRes(); handleRequest(mockReq(method, url, headers), res); return res.done;
};
const getJson = (mod, url, headers) => {
  const r = call(mod.handleRequest, 'GET', url, headers); return { status: r.statusCode, body: JSON.parse(r.body), res: r };
};
const URL_ = p => new URL(p, 'http://localhost');
const withEnv = async (name, value, fn) => {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return await fn(); } finally { saved === undefined ? delete process.env[name] : process.env[name] = saved; }
};
// Real token records of the risk golden set (tests/data/risk), stored the way the collector stores them
const riskRecord = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'data', 'risk', `${name}.json`), 'utf8'));
const putToken = (db, r) => db.prepare('INSERT OR REPLACE INTO token_data (chain_id, address, symbol, collected_at, status, coverage, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(r.chainId, r.address, r.symbol, r.data?.meta?.collected_at ?? 1, r.status, r.coverage, JSON.stringify(r.data));
const peerRow = (over = {}) => ({ vault_address: '0xp1', vault_name: 'P1', supply_assets_usd: 5000, via_vault: null, ...over });

// Моки без сокета мають один ключ ліміту на весь набір: знімаємо ліміт, його кейси вмикають свій через withLimit.
CONFIG.server.rateLimit.maxRequests = Number.MAX_SAFE_INTEGER;
const withLimit = async (maxRequests, fn, windowMs = 60000) => {
  const saved = { ...CONFIG.server.rateLimit };
  Object.assign(CONFIG.server.rateLimit, { maxRequests, windowMs });
  try { return await fn(); } finally { Object.assign(CONFIG.server.rateLimit, saved); }
};
const fromIp = (method, url, remoteAddress, headers = {}) => ({ ...mockReq(method, url, headers), socket: { remoteAddress } });
// Початок вікна ліміту, кратний 60 с, щоб зважування попереднього вікна було передбачуваним.
const W0 = 60000 * 1e6;

// --- Контрольована БД ---
const addr = n => '0x' + n.toString(16).padStart(40, '0');
const ins = (db, table, row) => db.prepare(
  `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`
).run(...Object.values(row));
const V = (n, over = {}) => ({
  address: addr(n), chain_id: 1, name: `Vault ${n}`, symbol: 'v', curator_name: 'Cur', asset_address: '0xusdc', asset_symbol: 'USDC',
  asset_decimals: 6, asset_price_usd: 1, total_assets: '1000000000', total_assets_usd: 1000, liquidity_usd: 0, apy: 0.05, net_apy: 0.04,
  fee: 0.1, is_listed: 1, version: 'v1', metadata_updated_at: 123, ...over
});
const M = (key, over = {}) => ({
  unique_key: key, chain_id: 1, loan_asset_symbol: 'USDC', collateral_asset_address: '0xweth', collateral_asset_symbol: 'WETH',
  oracle_address: '0xoracle', lltv: '860000000000000000', lltv_percent: 86, total_supply_assets_usd: 2e6, total_borrow_assets_usd: 1.5e6, is_listed: 1,
  warnings_json: '[]', ...over
});
const A = (vaultN, market, usd, over = {}) => ({ vault_address: addr(vaultN), market_unique_key: market, supply_assets_usd: usd, supply_assets_human: usd, ...over });

// Порожня відповідь Morpho API: успішна синхронізація без змін. Через onSyncSuccess вона скидає обидва кеші routes.
const emptyApi = async (_url, init) => {
  const { query } = JSON.parse(init.body);
  if (query.includes('GetCurators')) return jsonResponse({ data: { curators: { items: [] } } });
  const key = query.includes('GetVaultV2s') ? 'vaultV2s' : 'vaults';
  return jsonResponse({ data: { [key]: { items: [], pageInfo: { countTotal: 0 } } } });
};
const syncMod = () => import('../../server/services/syncEngine.js');
async function resetCaches() {
  const { syncAllVaults } = await syncMod();
  await withFetch(emptyApi, () => syncAllVaults());
}

// Свіжа порожня БД з чистими кешами на час одного тесту; без шуму в консолі.
async function sandbox(fn) {
  const { getDatabase, closeDatabase } = await import('../../server/db/database.js');
  const savedPath = CONFIG.db.path, log = console.log, warn = console.warn, err = console.error;
  console.log = console.warn = console.error = () => {};
  closeDatabase();
  CONFIG.db.path = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cym-routes-')), 'routes.db');
  try {
    await resetCaches();
    return await fn(getDatabase());
  } finally {
    try { getDatabase().exec('DELETE FROM vaults; DELETE FROM markets;'); await resetCaches(); } finally {
      console.log = log; console.warn = warn; console.error = err;
      closeDatabase(); CONFIG.db.path = savedPath;
    }
  }
}

// Керований годинник для перевірки TTL кешів.
async function withClock(fn) {
  const real = Date.now; let t = real();
  Date.now = () => t;
  try { return await fn({ advance: ms => { t += ms; } }); } finally { Date.now = real; }
}

// Набір для пошуку, фільтрів і сортування (значення підібрані так, щоб кожне сортування давало інший порядок).
function seedCatalog(db) {
  ins(db, 'vaults', V(1, { name: 'Alpha USDC', symbol: 'aUSDC', curator_name: 'Gauntlet', asset_symbol: 'USDC', chain_id: 1, liquidity_usd: 300, total_assets_usd: 1000, net_apy: 0.05, apy: 0.10, is_listed: 1 }));
  ins(db, 'vaults', V(2, { name: 'beta_eth', symbol: 'bETH', curator_name: 'Steakhouse', asset_symbol: 'WETH', chain_id: 8453, liquidity_usd: 200, total_assets_usd: 3000, net_apy: 0.02, apy: 0.30, is_listed: 0 }));
  ins(db, 'vaults', V(3, { name: '100% Yield', symbol: 'yUSDT', curator_name: 'Re7', asset_symbol: 'USDT', chain_id: 1, liquidity_usd: 100, total_assets_usd: 2000, net_apy: 0.09, apy: 0.20, is_listed: 1 }));
  ins(db, 'vaults', V(4, { name: 'Back\\Slash', symbol: 'bs', curator_name: 'MEV', asset_symbol: 'DAI', chain_id: 1, liquidity_usd: 400, total_assets_usd: 500, net_apy: 0.01, apy: 0.40, is_listed: 1 }));
}
const ids = body => body.vaults.map(v => parseInt(v.address, 16));
const list = (mod, qs = '') => getJson(mod, '/api/vaults' + qs).body;

// Ринок mk1: вільна ліквідність 2M - 1.5M = 500K. P і Q мають по 1M, R - дрібна позиція, S - look-through V2 через Q.
function seedCrowded(db) {
  ins(db, 'markets', M('mk1'));
  ins(db, 'vaults', V(0x10, { name: 'Vault P', total_assets_usd: 1e6, liquidity_usd: 1e6 }));
  ins(db, 'vaults', V(0x11, { name: 'Peer Q', total_assets_usd: 1e6 }));
  ins(db, 'vaults', V(0x12, { name: 'Peer R', total_assets_usd: 900 }));
  ins(db, 'vaults', V(0x13, { name: 'Look S', total_assets_usd: 4e5, liquidity_usd: 4e5, version: 'v2' }));
  ins(db, 'vault_allocations', A(0x10, 'mk1', 1e6));
  ins(db, 'vault_allocations', A(0x11, 'mk1', 1e6));
  ins(db, 'vault_allocations', A(0x12, 'mk1', 900));
  ins(db, 'vault_allocations', A(0x13, 'mk1', 4e5, { via_vault: addr(0x11) }));
}

// F: 60% у чистому ринку, 39.5% + 0.5% у нелістингованих (сукупно матеріально). G: лише 0.5% пилу в нелістингованому.
function seedQuality(db) {
  ins(db, 'markets', M('clean', { total_supply_assets_usd: 1e9, total_borrow_assets_usd: 0, oracle_type: null }));
  ins(db, 'markets', M('unl', { is_listed: 0, total_supply_assets_usd: 1e9, total_borrow_assets_usd: 0 }));
  ins(db, 'markets', M('unl2', { is_listed: 0, total_supply_assets_usd: 1e9, total_borrow_assets_usd: 0 }));
  ins(db, 'vaults', V(0x20, { total_assets_usd: 1e6 }));
  ins(db, 'vaults', V(0x21, { total_assets_usd: 1e6 }));
  ins(db, 'vault_allocations', A(0x20, 'unl', 3.95e5));
  ins(db, 'vault_allocations', A(0x20, 'clean', 6e5));
  ins(db, 'vault_allocations', A(0x20, 'unl2', 5e3));
  ins(db, 'vault_allocations', A(0x21, 'clean', 9.95e5));
  ins(db, 'vault_allocations', A(0x21, 'unl2', 5e3));
}

// Справжній HTTP-сервер на випадковому порту: перевіряє поведінку Node (HEAD, сирі шляхи), яку мок не моделює.
async function withServer(handleRequest, fn) {
  const srv = http.createServer(handleRequest);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try { return await fn(srv.address().port); } finally { await new Promise(r => srv.close(r)); }
}
const rawHttp = (port, method, p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, r => {
    let body = ''; r.setEncoding('utf8'); r.on('data', c => { body += c; });
    r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
  });
  req.on('error', reject); req.end();
});

// Request with a streamed body; destroyCalls counts destroy() calls
const bodyReq = (method, url, chunks, headers = {}) => {
  const req = Readable.from(chunks, { objectMode: false, autoDestroy: false });
  Object.assign(req, { method, url, headers, destroyCalls: 0 }); req.destroy = () => { req.destroyCalls++; };
  return req;
};
const jsonChunks = (obj, size = 1000) => { const b = Buffer.from(JSON.stringify(obj)); const out = []; for (let i = 0; i < b.length; i += size) out.push(b.subarray(i, i + size)); return out; };
const auth = { authorization: 'Bearer rsecret' };

// Запит до /api/sync з сокетом (await=1 вимикає таймаут сокета) і лічильником destroy().
const syncReq = (headers = {}) => {
  const req = { ...mockReq('POST', '/api/sync', headers), socket: { setTimeout() {} }, destroyed: 0 };
  req.destroy = () => { req.destroyed++; };
  return req;
};
const rawV1 = a => ({
  address: a, name: 'Synced', symbol: 's', listed: true, chain: { id: 1 }, asset: { address: '0xusdc', symbol: 'USDC', decimals: 6, priceUsd: 1 },
  state: { totalAssets: '1000000', totalAssetsUsd: 1, curator: '0x0', allocation: [] }
});
const apiWith = (v1, counter = { n: 0 }, gate = null) => async (_url, init) => {
  counter.n++;
  if (gate) await gate;
  const { query } = JSON.parse(init.body);
  if (query.includes('GetCurators')) return jsonResponse({ data: { curators: { items: [] } } });
  const [key, items] = query.includes('GetVaultV2s') ? ['vaultV2s', []] : ['vaults', v1];
  return jsonResponse({ data: { [key]: { items, pageInfo: { countTotal: items.length } } } });
};
const waitIdle = async isSyncing => { for (let i = 0; i < 200 && isSyncing(); i++) await new Promise(r => setTimeout(r, 10)); };

export default {
  ipv6Prefix: [
    ['IPv4 і IPv4-mapped IPv6 повертаються без змін', ({ ipv6Prefix: f }) => {
      assert.equal(f('1.2.3.4'), '1.2.3.4'); assert.equal(f('::ffff:1.2.3.4'), '::ffff:1.2.3.4');
    }],
    ['повна адреса зводиться до /64 без провідних нулів', ({ ipv6Prefix: f }) =>
      assert.equal(f('2001:0db8:0000:0042:aaaa:bbbb:cccc:dddd'), '2001:db8:0:42::/64')],
    ['скорочена форма з :: розгортається; різні хвости одного /64 дають один ключ', ({ ipv6Prefix: f }) => {
      assert.equal(f('2001:db8::1'), '2001:db8:0:0::/64');
      assert.equal(f('2001:db8:1:2::5'), f('2001:db8:1:2:ffff::9'));
    }],
    ['регістр не впливає на ключ', ({ ipv6Prefix: f }) => assert.equal(f('2001:DB8::1'), f('2001:db8::1'))],
  ],
  compareNullsFirst: [
    ['null менший за будь-яке значення, два null рівні', ({ compareNullsFirst: f }) => {
      assert.equal(f(null, 1), -1); assert.equal(f(1, null), 1); assert.equal(f(null, undefined), 0);
    }],
    ['числа й рядки порівнюються за зростанням, рівні дають 0', ({ compareNullsFirst: f }) => {
      assert.equal(f(1, 2), -1); assert.equal(f(2, 1), 1); assert.equal(f(2, 2), 0); assert.equal(f('a', 'b'), -1);
    }],
    ['0 не плутається з null', ({ compareNullsFirst: f }) => { assert.equal(f(0, null), 1); assert.equal(f(null, 0), -1); }],
  ],
  handleRequest: [
    ['OPTIONS на будь-який шлях -> 204, CORS-заголовки, порожнє тіло', ({ handleRequest }) => {
      const r = call(handleRequest, 'OPTIONS', '/api/vaults');
      assert.equal(r.statusCode, 204); assert.equal(r.body, '');
      assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
      assert.equal(r.headers['Access-Control-Allow-Methods'], 'GET, HEAD, OPTIONS');
      assert.equal(r.headers['Access-Control-Max-Age'], '86400');
    }],
    ['зворотний слеш у URL -> 400 (і в API, і в статиці)', ({ handleRequest }) => {
      assert.equal(call(handleRequest, 'GET', '/api\\vaults').statusCode, 400);
      assert.equal(call(handleRequest, 'GET', '/..\\package.json').statusCode, 400);
    }],
    ['невідомий /api/ маршрут -> 404 з JSON-помилкою', ({ handleRequest }) => {
      const r = call(handleRequest, 'GET', '/api/nope');
      assert.equal(r.statusCode, 404); assert.equal(JSON.parse(r.body).error, 'API endpoint not found');
    }],
    ['методи, що не читають, на GET-маршрутах -> 404, а GET /api/sync -> 404', ({ handleRequest }) => {
      assert.equal(call(handleRequest, 'POST', '/api/vaults').statusCode, 404);
      assert.equal(call(handleRequest, 'DELETE', '/api/status').statusCode, 404);
      assert.equal(call(handleRequest, 'GET', '/api/sync').statusCode, 404);
    }],
    ['некоректні адреси vault -> 400', ({ handleRequest }) => {
      for (const a of ['0x123', '0x' + 'g'.repeat(40), '0x' + '1'.repeat(41), '1'.repeat(42), '%200x' + '1'.repeat(40)]) {
        assert.equal(call(handleRequest, 'GET', '/api/vaults/' + a).statusCode, 400, a);
      }
    }],
    ['адреса з кінцевим слешем або вкладеним шляхом -> 404', ({ handleRequest }) => {
      assert.equal(call(handleRequest, 'GET', '/api/vaults/0x' + '1'.repeat(40) + '/').statusCode, 404);
      assert.equal(call(handleRequest, 'GET', '/api/vaults/0x' + '1'.repeat(40) + '/x').statusCode, 404);
    }],
    ['/api/status -> 200, лічильники збігаються з COUNT у БД', async mod => sandbox(async db => {
      seedCatalog(db); ins(db, 'markets', M('m1')); ins(db, 'vault_allocations', A(1, 'm1', 5));
      const { status, body } = getJson(mod, '/api/status');
      assert.equal(status, 200); assert.equal(body.status, 'ok'); assert.equal(body.isSyncInProgress, false);
      assert.deepEqual(body.stats, { vaultsCount: 4, listedVaultsCount: 3, marketsCount: 1, allocationsCount: 1 });
      const ts = Number(db.prepare("SELECT value FROM sync_state WHERE key = 'last_sync_all'").get().value);
      assert.equal(body.lastSync.timestamp, ts); assert.equal(body.lastSyncResult.success, true);
    })],
    ['HEAD /api/status -> 200 без тіла, але з Content-Length як у GET', ({ handleRequest }) => {
      const h = call(handleRequest, 'HEAD', '/api/status'), g = call(handleRequest, 'GET', '/api/status');
      assert.equal(h.statusCode, 200); assert.equal(h.body, '');
      assert.equal(h.headers['Content-Length'], Buffer.byteLength(g.body));
    }],
    ['відповіді API мають захисні та CORS-заголовки', ({ handleRequest }) => {
      const h = call(handleRequest, 'GET', '/api/status').headers;
      assert.equal(h['Content-Type'], 'application/json; charset=utf-8');
      assert.equal(h['X-Content-Type-Options'], 'nosniff'); assert.equal(h['X-Frame-Options'], 'DENY');
      assert.equal(h['Referrer-Policy'], 'strict-origin-when-cross-origin'); assert.equal(h['Access-Control-Allow-Origin'], '*');
    }],
    ['невідома адреса vault (валідний формат) -> 404', ({ handleRequest }) => {
      const r = call(handleRequest, 'GET', '/api/vaults/0x' + '0'.repeat(40)); assert.equal(r.statusCode, 404);
    }],
    ['адреса у верхньому регістрі знаходить vault, записаний у нижньому', async mod => sandbox(async db => {
      ins(db, 'vaults', V(0xabcdef, { name: 'Upper' }));
      const { status, body } = getJson(mod, '/api/vaults/' + addr(0xabcdef).replace('abcdef', 'ABCDEF'));
      assert.equal(status, 200); assert.equal(body.vault.name, 'Upper'); assert.equal(body.vault.address, addr(0xabcdef));
    })],
    ['некоректний Host не ламає маршрутизацію (підміняється на localhost)', ({ handleRequest }) => {
      assert.equal(call(handleRequest, 'GET', '/api/status', { host: 'evil host/<x>' }).statusCode, 200);
      assert.equal(call(handleRequest, 'GET', '/api/status', { host: 'example.com:8080' }).statusCode, 200);
    }],
    ['шлях //x/api/status не має трактуватися як /api/status (протокол-відносний URL)', ({ handleRequest }) => {
      const r = call(handleRequest, 'GET', '//x/api/status');
      assert.notEqual(r.statusCode, 200, 'запит //x/api/status потрапив у обробник /api/status');
    }],
    ['статичний / віддає client/index.html байт-у-байт', async ({ handleRequest }) => {
      const r = await callAsync(handleRequest, 'GET', '/');
      assert.equal(r.statusCode, 200); assert.match(r.headers['Content-Type'], /text\/html/); assert.equal(r.body, INDEX_HTML.toString());
    }],
    ['/js/../index.html нормалізується і віддає index.html', async ({ handleRequest }) => {
      const r = await callAsync(handleRequest, 'GET', '/js/../index.html'); assert.equal(r.statusCode, 200);
    }],
    ['обхід шляху в усіх варіантах не віддає файли поза client/', async ({ handleRequest }) => {
      const attempts = ['/../package.json', '/%2e%2e/package.json', '/%2E%2E/%2e%2e/package.json', '/..%2fpackage.json',
        '/%2e%2e%2fpackage.json', '/js/../../package.json', '/%252e%252e/package.json', '/..%5cpackage.json', '/%5c..%5cpackage.json',
        '/..%2f..%2fserver%2fconfig.js', '/..%2fdata%2fmorpho.db', '/C:/Windows/win.ini', '/%2e%2e%5cpackage.json'];
      for (const a of attempts) {
        const r = await callAsync(handleRequest, 'GET', a, { accept: 'application/json' });
        assert.notEqual(r.statusCode, 200, a); assert.notEqual(r.body, PACKAGE_JSON, a); assert.ok(!r.body.includes('"scripts"'), a);
      }
    }],
    ['dot-файли і їх закодовані варіанти -> 403', async ({ handleRequest }) => {
      for (const a of ['/.env', '/js/.env', '/%2eenv', '/.git/config', '/%2egit/config', '/css/%2e%2e%2f.env']) {
        const r = await callAsync(handleRequest, 'GET', a); assert.equal(r.statusCode, 403, a);
      }
    }],
    ['null-байт у статичному шляху -> 400', async ({ handleRequest }) => {
      for (const a of ['/a%00b', '/%00', '/index.html%00.js']) assert.equal((await callAsync(handleRequest, 'GET', a)).statusCode, 400, a);
    }],
    ['PUT на статику -> 405', ({ handleRequest }) => assert.equal(call(handleRequest, 'PUT', '/index.html').statusCode, 405)],
    ['справжній HTTP: HEAD-відповіді без тіла навіть для помилок', async ({ handleRequest }) => withServer(handleRequest, async port => {
      for (const p of ['/api/status', '/api/nope', '/api/vaults/0x123', '/', '/nope.js']) {
        const r = await rawHttp(port, 'HEAD', p); assert.equal(r.body, '', p);
      }
    })],
    ['справжній HTTP: сирі шляхи обходу не віддають package.json', async ({ handleRequest }) => withServer(handleRequest, async port => {
      for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/..%5cpackage.json', '/js/../../package.json']) {
        const r = await rawHttp(port, 'GET', p); assert.notEqual(r.status, 200, p); assert.ok(!r.body.includes('"scripts"'), p);
      }
    })],
    ['ліміт /api/*: понад бюджет -> 429 з Retry-After і JSON, інший IP не зачеплений', async ({ handleRequest }) => withLimit(3, async () => {
      for (let i = 0; i < 3; i++) {
        const r = mockRes(); handleRequest(fromIp('GET', '/api/nope', '203.0.113.10'), r); assert.equal(r.statusCode, 404, `запит ${i + 1}`);
      }
      const r = mockRes(); handleRequest(fromIp('GET', '/api/status', '203.0.113.10'), r);
      assert.equal(r.statusCode, 429); assert.deepEqual(JSON.parse(r.body), { error: 'Too Many Requests' });
      assert.ok(Number(r.headers['Retry-After']) >= 1, r.headers['Retry-After']);
      const other = mockRes(); handleRequest(fromIp('GET', '/api/nope', '203.0.113.11'), other); assert.equal(other.statusCode, 404);
    })],
    ['ліміт не стосується статики, а зворотний слеш як і раніше -> 400', async ({ handleRequest }) => withLimit(1, async () => {
      const first = mockRes(); handleRequest(fromIp('GET', '/api/nope', '203.0.113.20'), first); assert.equal(first.statusCode, 404);
      const blocked = mockRes(); handleRequest(fromIp('GET', '/api/nope', '203.0.113.20'), blocked); assert.equal(blocked.statusCode, 429);
      const page = mockRes(); handleRequest(fromIp('GET', '/', '203.0.113.20'), page); await page.done; assert.equal(page.statusCode, 200);
      const slash = mockRes(); handleRequest(fromIp('GET', '/api\\vaults', '203.0.113.20'), slash); assert.equal(slash.statusCode, 400);
    })],
    ['за nginx ліміт рахується по X-Forwarded-For, підробка заголовка ззовні не обходить ліміт', async ({ handleRequest }) => withLimit(1, async () => {
      const proxied = ip => { const r = mockRes(); handleRequest(fromIp('GET', '/api/nope', '127.0.0.1', { 'x-forwarded-for': ip }), r); return r.statusCode; };
      assert.equal(proxied('198.51.100.1'), 404); assert.equal(proxied('198.51.100.1'), 429); assert.equal(proxied('198.51.100.2'), 404);
      const direct = xff => { const r = mockRes(); handleRequest(fromIp('GET', '/api/nope', '198.51.100.9', { 'x-forwarded-for': xff }), r); return r.statusCode; };
      assert.equal(direct('10.0.0.1'), 404); assert.equal(direct('10.0.0.2'), 429, 'чужий XFF не має давати новий ключ');
    })],
    ['відмова обробника POST /api/sync перехоплюється: 500, а не необроблений проміс', async ({ handleRequest }) => withEnv('SYNC_TOKEN', 'secret', async () => {
      const err = console.error; console.error = () => {};
      try {
        const headers = { get authorization() { throw new Error('boom'); } };
        const res = mockRes(); handleRequest(mockReq('POST', '/api/sync', headers), res);
        await res.done; assert.equal(res.statusCode, 500); assert.deepEqual(JSON.parse(res.body), { error: 'Internal server error' });
      } finally { console.error = err; }
    })],
  ],
  clientIp: [
    ['прямий клієнт: адреса сокета, X-Forwarded-For ігнорується', ({ clientIp: f }) => {
      assert.equal(f(fromIp('GET', '/', '203.0.113.5', { 'x-forwarded-for': '1.2.3.4' })), '203.0.113.5');
    }],
    ['від loopback (nginx): останній запис X-Forwarded-For, підроблені ліві записи відкидаються', ({ clientIp: f }) => {
      for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        assert.equal(f(fromIp('GET', '/', peer, { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' })), '203.0.113.7', peer);
      }
    }],
    ['від loopback без X-Forwarded-For або з порожнім -> адреса сокета', ({ clientIp: f }) => {
      assert.equal(f(fromIp('GET', '/', '127.0.0.1')), '127.0.0.1');
      assert.equal(f(fromIp('GET', '/', '127.0.0.1', { 'x-forwarded-for': ' , ' })), '127.0.0.1');
    }],
    ['адреса, що лише починається з 127 у тексті, не вважається loopback', ({ clientIp: f }) => {
      assert.equal(f(fromIp('GET', '/', '::1:5', { 'x-forwarded-for': '1.2.3.4' })), '0:0:0:0::/64');
    }],
    ['IPv6-клієнт ключується за /64: ротація в межах префікса не змінює ключ', ({ clientIp: f }) => {
      const key = a => f(fromIp('GET', '/', a));
      assert.equal(key('2001:db8:1:2::1'), key('2001:DB8:1:2:ffff:aaaa:bbbb:cccc'));
      assert.notEqual(key('2001:db8:1:2::1'), key('2001:db8:1:3::1'));
      assert.equal(f(fromIp('GET', '/', '127.0.0.1', { 'x-forwarded-for': '2001:db8:1:2:3:4:5:6' })), '2001:db8:1:2::/64');
    }],
    ['запит без сокета -> порожній ключ, без винятку', ({ clientIp: f }) => assert.equal(f(mockReq('GET', '/')), '')],
  ],
  checkRateLimit: [
    ['рівно maxRequests дозволено, наступний -> секунди до кінця вікна', async ({ checkRateLimit: f }) => withLimit(3, () => {
      for (let i = 0; i < 3; i++) assert.equal(f('rl-a', W0 + 1000), 0);
      assert.equal(f('rl-a', W0 + 1000), 59);
      assert.equal(f('rl-b', W0 + 1000), 0, 'інший IP має власний бюджет');
    })],
    ['відхилені запити не з\'їдають бюджет наступного вікна; через два вікна лічильник скинуто', async ({ checkRateLimit: f }) => withLimit(2, () => {
      for (let i = 0; i < 2; i++) f('rl-c', W0 + 59999);
      for (let i = 0; i < 50; i++) assert.ok(f('rl-c', W0 + 59999) > 0);
      assert.equal(f('rl-c', W0 + 90000), 0, 'на половині наступного вікна 2 * 0.5 = 1 < 2');
      assert.ok(f('rl-c', W0 + 90000) > 0);
      assert.equal(f('rl-c', W0 + 60000 * 3), 0);
    })],
    ['ковзне вікно: одразу після межі попереднє вікно ще важить, на половині - вдвічі менше', async ({ checkRateLimit: f }) => withLimit(10, () => {
      for (let i = 0; i < 10; i++) assert.equal(f('rl-d', W0 + 59000), 0);
      assert.ok(f('rl-d', W0 + 60000) > 0,'стрибок через межу вікна не має обнуляти ліміт');
      let allowed = 0; for (let i = 0; i < 10; i++) if (f('rl-d', W0 + 90000) === 0) allowed++;
      assert.equal(allowed, 5);
    })],
    ['кількість IP обмежена: при переповненні найстаріші записи витісняються', async ({ checkRateLimit: f }) => withLimit(1, () => {
      assert.equal(f('rl-old', W0), 0); assert.ok(f('rl-old', W0) > 0);
      for (let i = 0; i < 10001; i++) f(`rl-flood-${i}`, W0);
      assert.equal(f('rl-old', W0), 0, 'найстаріший запис мав бути витіснений');
    })],
  ],
  summarizePeers: [
    ['порожні рядки -> total 0', ({ summarizePeers: f }) => assert.deepEqual(f(null, '0xv', {}), { total: 0, peers: [] })],
    ['власні позиції пропускаються', ({ summarizePeers: f }) =>
      assert.deepEqual(f([peerRow({ vault_address: '0xv' }), peerRow()], '0xv', {}), { total: 5000, peers: [{ vaultAddress: '0xp1', vaultName: 'P1', supplyUsd: 5000 }] })],
    ['межа $1K: рівно 1000 ігнорується, 1000.01 враховується', ({ summarizePeers: f }) => {
      assert.equal(f([peerRow({ supply_assets_usd: 1000 })], '0xv', {}).total, 0);
      assert.equal(f([peerRow({ supply_assets_usd: 1000.01 })], '0xv', {}).total, 1000.01);
    }],
    ['look-through позиції (via_vault) пропускаються', ({ summarizePeers: f }) =>
      assert.equal(f([peerRow({ via_vault: '0xu' })], '0xv', {}).peers.length, 0)],
    ['пірів відсортовано за спаданням і обрізано до 5, total рахує всіх', ({ summarizePeers: f }) => {
      const rows = Array.from({ length: 7 }, (_, i) => peerRow({ vault_address: `0x${i}`, supply_assets_usd: 2000 + i * 100 }));
      const r = f(rows, '0xv', {});
      assert.deepEqual(r.peers.map(p => p.supplyUsd), [2600, 2500, 2400, 2300, 2200]);
      assert.equal(r.total, 7 * 2000 + 100 * (0 + 1 + 2 + 3 + 4 + 5 + 6));
    }],
    ['частка V2-vault віднімається від базового V1', ({ summarizePeers: f }) => {
      const r = f([peerRow({ vault_address: '0xunder', supply_assets_usd: 10000 })], '0xv2', { via_vault: '0xunder', supply_assets_usd: 4000 });
      assert.equal(r.total, 6000); assert.equal(r.peers[0].supplyUsd, 6000);
    }],
    ['після віднімання частки V2 залишок <= $1K не вважається піром', ({ summarizePeers: f }) =>
      assert.equal(f([peerRow({ vault_address: '0xu', supply_assets_usd: 4500 })], '0xv2', { via_vault: '0xu', supply_assets_usd: 4000 }).total, 0)],
    ['віднімання стосується лише базового vault, не інших пірів', ({ summarizePeers: f }) =>
      assert.equal(f([peerRow({ vault_address: '0xother', supply_assets_usd: 10000 })], '0xv2', { via_vault: '0xu', supply_assets_usd: 4000 }).total, 10000)],
  ],
  withEffectiveTotal: [
    ['додатний TVL повертає той самий vault', ({ withEffectiveTotal: f }) => {
      const v = { total_assets_usd: 5 }; assert.equal(f(v, [{ supply_assets_usd: 100 }]), v);
    }],
    ['нульовий TVL замінюється сумою алокацій, оригінал не мутується', ({ withEffectiveTotal: f }) => {
      const v = { total_assets_usd: 0, name: 'x' };
      const r = f(v, [{ supply_assets_usd: 100 }, { supply_assets_usd: 50 }, { supply_assets_usd: null }]);
      assert.equal(r.total_assets_usd, 150); assert.equal(r.name, 'x'); assert.equal(v.total_assets_usd, 0);
    }],
    ['null/рядковий TVL трактується як число', ({ withEffectiveTotal: f }) => {
      assert.equal(f({ total_assets_usd: null }, [{ supply_assets_usd: 7 }]).total_assets_usd, 7);
      const v = { total_assets_usd: '12' }; assert.equal(f(v, [{ supply_assets_usd: 7 }]), v);
    }],
    ['без алокацій vault не змінюється', ({ withEffectiveTotal: f }) => {
      const v = { total_assets_usd: 0 }; assert.equal(f(v, []), v);
    }],
  ],
  safeEqual: [
    ['однакові секрети -> true', ({ safeEqual: f }) => assert.equal(f('abc', 'abc'), true)],
    ['різні секрети -> false', ({ safeEqual: f }) => assert.equal(f('abc', 'abd'), false)],
    ['різна довжина не кидає виняток', ({ safeEqual: f }) => assert.equal(f('a', 'abcdef'), false)],
    ['префікс секрету не приймається', ({ safeEqual: f }) => assert.equal(f('secre', 'secret'), false)],
    ['число і рядок порівнюються як рядки', ({ safeEqual: f }) => assert.equal(f(123, '123'), true)],
  ],
  sendJson: [
    ['пише статус, JSON і Content-Length', ({ sendJson: f }) => {
      const res = mockRes(); f(res, 201, { a: 1 });
      assert.equal(res.statusCode, 201); assert.equal(res.body, '{"a":1}'); assert.equal(res.headers['Content-Length'], 7);
    }],
    ['HEAD-запит не отримує тіла, Content-Length як у GET', ({ sendJson: f }) => {
      const res = mockRes(); f(res, 200, { a: 1 }, { method: 'HEAD' }); assert.equal(res.body, ''); assert.equal(res.headers['Content-Length'], 7);
    }],
    ['кирилиця рахується в байтах', ({ sendJson: f }) => {
      const res = mockRes(); f(res, 200, { t: 'я' }); assert.equal(res.headers['Content-Length'], Buffer.byteLength('{"t":"я"}'));
    }],
    ['повний набір заголовків безпеки і CORS', ({ sendJson: f }) => {
      const res = mockRes(); f(res, 200, {});
      assert.deepEqual(res.headers, {
        'Content-Type': 'application/json; charset=utf-8', 'Content-Length': 2, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin', 'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'
      });
    }],
  ],
  handleCors: [
    ['відповідає 204 з дозволеними методами без POST', ({ handleCors: f }) => {
      const res = mockRes(); f({}, res);
      assert.equal(res.statusCode, 204); assert.equal(res.headers['Access-Control-Allow-Methods'], 'GET, HEAD, OPTIONS');
      assert.equal(res.headers['Access-Control-Allow-Headers'], 'Content-Type');
    }],
  ],
  serveStaticFile: [
    ['POST -> 405', ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('POST', '/'), res, '/'); assert.equal(res.statusCode, 405);
    }],
    ['null-байт (сирий і %00) -> 400', ({ serveStaticFile: f }) => {
      for (const p of ['/a%00b', '/a\0b']) { const res = mockRes(); f(mockReq('GET', '/'), res, p); assert.equal(res.statusCode, 400, p); }
    }],
    ['битий URI-компонент -> 400', ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/'), res, '/%E0%A4%A'); assert.equal(res.statusCode, 400);
    }],
    ['dot-файли (і закодовані) заборонені -> 403', ({ serveStaticFile: f }) => {
      for (const p of ['/.env', '/%2Eenv', '/js/.secret.js']) { const res = mockRes(); f(mockReq('GET', '/'), res, p); assert.equal(res.statusCode, 403, p); }
    }],
    ['відносний шлях з .. (без провідного /) -> 403', ({ serveStaticFile: f }) => {
      for (const p of ['../package.json', '..%2fpackage.json', 'js/../../package.json']) {
        const res = mockRes(); f(mockReq('GET', '/'), res, p); assert.equal(res.statusCode, 403, p);
      }
    }],
    ['вихід за межі client/ не віддає файл', async ({ serveStaticFile: f }) => {
      for (const p of ['/..%2f..%2fpackage.json', '/../package.json', '/%2e%2e%2fpackage.json']) {
        const res = mockRes(); f(mockReq('GET', '/', {}), res, p); await res.done;
        assert.notEqual(res.statusCode, 200, p); assert.ok(!res.body.includes('"scripts"'), p);
      }
    }],
    ['/ -> index.html з тілом файлу', async ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/', {}), res, '/'); await res.done;
      assert.equal(res.statusCode, 200); assert.equal(res.body, INDEX_HTML.toString());
    }],
    ['неіснуючий файл з розширенням -> 404 навіть з Accept: text/html', async ({ serveStaticFile: f }) => {
      for (const h of [{}, { accept: 'text/html' }]) {
        const res = mockRes(); f(mockReq('GET', '/', h), res, '/nope.js'); await res.done; assert.equal(res.statusCode, 404);
      }
    }],
    ['SPA-маршрут без розширення з Accept: text/html -> вміст index.html', async ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/', { accept: 'text/html' }), res, '/vault/abc'); await res.done;
      assert.equal(res.statusCode, 200); assert.equal(res.body, INDEX_HTML.toString());
    }],
    ['SPA-маршрут без Accept: text/html -> 404', async ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/', { accept: 'application/json' }), res, '/vault/abc'); await res.done; assert.equal(res.statusCode, 404);
    }],
    ['каталог без Accept: text/html -> 404, а не лістинг', async ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('GET', '/', {}), res, '/js'); await res.done; assert.equal(res.statusCode, 404);
    }],
    ['HEAD на статику -> 200, Content-Length файлу, без тіла', async ({ serveStaticFile: f }) => {
      const res = mockRes(); f(mockReq('HEAD', '/', {}), res, '/index.html'); await res.done;
      assert.equal(res.statusCode, 200); assert.equal(res.body, ''); assert.equal(res.headers['Content-Length'], INDEX_HTML.length);
    }],
  ],
  serveFile: [
    ['існуючий файл -> 200, Content-Type, заголовки no-store і SAMEORIGIN', async ({ serveFile: f }) => {
      const res = mockRes(); f(path.join(ROOT, 'client', 'index.html'), mockReq('GET', '/'), res);
      await res.done; assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8'); assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(res.headers['X-Frame-Options'], 'SAMEORIGIN'); assert.match(res.headers['Cache-Control'], /no-store/);
      assert.equal(res.headers['Content-Length'], INDEX_HTML.length);
    }],
    ['MIME за розширенням без урахування регістру, невідоме -> octet-stream', async ({ serveFile: f }) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cym-mime-'));
      const cases = { 'a.CSS': 'text/css; charset=utf-8', 'b.js': 'application/javascript; charset=utf-8', 'c.svg': 'image/svg+xml', 'd.xyz': 'application/octet-stream' };
      for (const [name, type] of Object.entries(cases)) {
        fs.writeFileSync(path.join(dir, name), 'x');
        const res = mockRes(); f(path.join(dir, name), mockReq('GET', '/'), res); await res.done;
        assert.equal(res.headers['Content-Type'], type, name); assert.equal(res.body, 'x');
      }
    }],
    ['HTML/JS/CSS: no-store, зображення і шрифти: public на добу без Pragma/Expires', async ({ serveFile: f }) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cym-cache-'));
      const cases = { 'a.html': false, 'b.js': false, 'c.css': false, 'd.png': true, 'e.svg': true, 'f.woff2': true, 'g.json': false, 'h.xyz': false };
      for (const [name, cached] of Object.entries(cases)) {
        fs.writeFileSync(path.join(dir, name), 'x');
        const res = mockRes(); f(path.join(dir, name), mockReq('GET', '/'), res); await res.done;
        if (cached) {
          assert.equal(res.headers['Cache-Control'], 'public, max-age=86400', name);
          assert.equal(res.headers.Pragma, undefined, name); assert.equal(res.headers.Expires, undefined, name);
        } else {
          assert.match(res.headers['Cache-Control'], /no-store/, name); assert.equal(res.headers.Pragma, 'no-cache', name);
        }
      }
    }],
    ['статика має CSP, Permissions-Policy, nosniff і Referrer-Policy', async ({ serveFile: f }) => {
      const res = mockRes(); f(path.join(ROOT, 'client', 'index.html'), mockReq('GET', '/'), res); await res.done;
      const csp = res.headers['Content-Security-Policy'];
      assert.match(csp, /default-src 'self'/); assert.match(csp, /script-src 'self'(;|$)/, 'скрипти без unsafe-inline/eval');
      assert.match(csp, /object-src 'none'/); assert.match(csp, /frame-ancestors 'self'/);
      assert.match(res.headers['Permissions-Policy'], /camera=\(\)/);
      assert.equal(res.headers['X-Content-Type-Options'], 'nosniff'); assert.equal(res.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
    }],
    ['client/index.html сумісний з CSP: немає inline-скриптів, обробників on*= і зовнішніх ресурсів', () => {
      const html = INDEX_HTML.toString();
      for (const tag of html.match(/<script\b[^>]*>/gi) || []) assert.match(tag, /\ssrc=/, tag);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
      assert.doesNotMatch(html, /<(script|link|img)\b[^>]*(src|href)=["']?(https?:)?\/\//i);
    }],
    ['відсутній файл -> 500', async ({ serveFile: f }) => {
      const res = mockRes(); f('/definitely/missing.html', mockReq('GET', '/'), res); await res.done; assert.equal(res.statusCode, 500);
    }],
  ],
  handleGetStatus: [
    ['200 і status ok', ({ handleGetStatus: f }) => {
      const res = mockRes(); f(mockReq('GET', '/api/status'), res); assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).status, 'ok');
    }],
    ['HEAD без тіла', ({ handleGetStatus: f }) => {
      const res = mockRes(); f(mockReq('HEAD', '/api/status'), res); assert.equal(res.body, '');
    }],
    ['до першої синхронізації lastSync.timestamp = null', async mod => sandbox(async db => {
      db.exec('DELETE FROM sync_state');
      const res = mockRes(); mod.handleGetStatus(mockReq('GET', '/api/status'), res);
      assert.deepEqual(JSON.parse(res.body).lastSync, { timestamp: null, updatedAt: null });
    })],
    ['до першої успішної синхронізації stale = true, lastSuccessAt = null', async mod => sandbox(async db => {
      db.exec('DELETE FROM sync_state');
      const body = getJson(mod, '/api/status').body;
      assert.equal(body.stale, true); assert.equal(body.lastSuccessAt, null);
    })],
    ['stale: межа рівно 3 інтервали ще свіжа, на 1 мс більше - застаріла; lastSuccessAt в ISO', async mod => sandbox(async db => withClock(async clock => {
      const sec = Math.floor(Date.now() / 1000);
      db.prepare("UPDATE sync_state SET value = ? WHERE key = 'last_sync_all'").run(String(sec));
      const at = () => getJson(mod, '/api/status').body;
      clock.advance(sec * 1000 - Date.now());
      assert.equal(at().stale, false); assert.equal(at().lastSuccessAt, new Date(sec * 1000).toISOString());
      clock.advance(3 * CONFIG.sync.intervalMs); assert.equal(at().stale, false);
      clock.advance(1); assert.equal(at().stale, true);
    }))],
    ['нові поля додано, наявні поля відповіді збережено', async mod => sandbox(async () => {
      const body = getJson(mod, '/api/status').body;
      assert.deepEqual(Object.keys(body).sort(), ['isSyncInProgress', 'lastSuccessAt', 'lastSync', 'lastSyncResult', 'stale', 'stats', 'status']);
      assert.equal(typeof body.stale, 'boolean'); assert.equal(body.stale, false, 'щойно виконана синхронізація свіжа');
      assert.equal(Date.parse(body.lastSuccessAt) / 1000, body.lastSync.timestamp);
    })],
  ],
  handlePostSync: [
    ['без SYNC_TOKEN синхронізація вимкнена -> 403 навіть з будь-яким токеном', async ({ handlePostSync: f, }) => {
      for (const env of ['', undefined]) await withEnv('SYNC_TOKEN', env, async () => {
        const counter = { n: 0 };
        await withFetch(apiWith([], counter), async () => {
          const res = mockRes(); await f(syncReq({ authorization: 'Bearer ' }), res, URL_('/api/sync'));
          assert.equal(res.statusCode, 403); assert.equal(JSON.parse(res.body).error, 'Manual sync is disabled'); assert.equal(counter.n, 0);
        });
      });
    }],
    ['неправильний, відсутній або префіксний токен -> 401, синхронізація не стартує', async ({ handlePostSync: f }) => withEnv('SYNC_TOKEN', 'secret', async () => {
      const counter = { n: 0 };
      await withFetch(apiWith([], counter), async () => {
        for (const h of [{ authorization: 'Bearer wrong' }, {}, { authorization: 'Bearer secre' }, { authorization: 'Bearer secret2' }, { authorization: 'Basic secret' }]) {
          const res = mockRes(); await f(syncReq(h), res, URL_('/api/sync')); assert.equal(res.statusCode, 401, JSON.stringify(h));
        }
      });
      assert.equal(counter.n, 0);
    })],
    ['перевірка токена йде раніше за ліміт тіла: чужий запит з великим тілом -> 401', async ({ handlePostSync: f }) => withEnv('SYNC_TOKEN', 'secret', async () => {
      const res = mockRes(); await f(syncReq({ authorization: 'Bearer wrong', 'content-length': '5000' }), res, URL_('/api/sync')); assert.equal(res.statusCode, 401);
    })],
    ['занадто велике тіло (1025 байт) -> 413 і з\'єднання закривається', async ({ handlePostSync: f }) => withEnv('SYNC_TOKEN', 'secret', async () => {
      const req = syncReq({ authorization: 'Bearer secret', 'content-length': '1025' }), res = mockRes();
      await f(req, res, URL_('/api/sync')); assert.equal(res.statusCode, 413); assert.equal(req.destroyed, 1);
    })],
    ['тіло рівно 1024 байти приймається -> 202, фонова синхронізація виконується', async mod => sandbox(async () => withEnv('SYNC_TOKEN', 'secret', async () => {
      const { isSyncing } = await syncMod(); const counter = { n: 0 };
      await withFetch(apiWith([rawV1(addr(0x77))], counter), async () => {
        const res = mockRes(); await mod.handlePostSync(syncReq({ authorization: 'Bearer secret', 'content-length': '1024' }), res, URL_('/api/sync'));
        assert.equal(res.statusCode, 202);
        assert.deepEqual(JSON.parse(res.body), { status: 'sync_started', message: 'Vault synchronization started in background', fetchHistory: false });
        await waitIdle(isSyncing);
      });
      assert.ok(counter.n > 0, 'фонова синхронізація не звернулася до API');
    }))],
    ['префікс Bearer нечутливий до регістру, fetchHistory=1 відбивається у відповіді', async mod => sandbox(async () => withEnv('SYNC_TOKEN', 'secret', async () => {
      const { isSyncing } = await syncMod();
      await withFetch(apiWith([]), async () => {
        const res = mockRes(); await mod.handlePostSync(syncReq({ authorization: 'bearer secret' }), res, URL_('/api/sync?fetchHistory=1'));
        assert.equal(res.statusCode, 202); assert.equal(JSON.parse(res.body).fetchHistory, true);
        await waitIdle(isSyncing);
      });
    }))],
    ['поки триває синхронізація -> 409', async mod => sandbox(async () => withEnv('SYNC_TOKEN', 'secret', async () => {
      const { syncAllVaults } = await syncMod();
      let release; const gate = new Promise(r => { release = r; });
      await withFetch(apiWith([], { n: 0 }, gate), async () => {
        const first = syncAllVaults();
        const res = mockRes(); await mod.handlePostSync(syncReq({ authorization: 'Bearer secret' }), res, URL_('/api/sync'));
        assert.equal(res.statusCode, 409);
        release(); await first;
      });
    }))],
    ['await=1 -> 200 sync_completed з підсумком і даними у БД', async mod => sandbox(async db => withEnv('SYNC_TOKEN', 'secret', async () => {
      await withFetch(apiWith([rawV1(addr(0x77)), rawV1(addr(0x78))]), async () => {
        const res = mockRes(); await mod.handlePostSync(syncReq({ authorization: 'Bearer secret' }), res, URL_('/api/sync?await=1'));
        const body = JSON.parse(res.body);
        assert.equal(res.statusCode, 200); assert.equal(body.status, 'sync_completed');
        assert.equal(body.result.success, true); assert.equal(body.result.summary.v1Count, 2);
      });
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vaults').get().c, 2);
    }))],
    ['await=true при збої API -> 500 sync_failed', async mod => sandbox(async () => withEnv('SYNC_TOKEN', 'secret', async () => {
      const saved = CONFIG.api.maxRetries; CONFIG.api.maxRetries = 0;
      try {
        await withFetch(async () => jsonResponse({}, 500), async () => {
          const res = mockRes(); await mod.handlePostSync(syncReq({ authorization: 'Bearer secret' }), res, URL_('/api/sync?await=true'));
          assert.equal(res.statusCode, 500); assert.deepEqual(JSON.parse(res.body), { status: 'sync_failed', error: 'Synchronization failed' });
        });
      } finally { CONFIG.api.maxRetries = saved; }
    }))],
  ],
  readJsonBody: [
    ['JSON, розбитий на кілька чанків (і багатобайтовий символ посередині), розбирається', async ({ readJsonBody: f }) => {
      const bytes = Buffer.from(JSON.stringify({ a: 'щ', n: [1, 2] }));
      const req = bodyReq('POST', '/x', [bytes.subarray(0, 9), bytes.subarray(9)]);
      assert.deepEqual(await f(req), { a: 'щ', n: [1, 2] });
    }],
    ['тіло більше за ліміт без content-length -> помилка 413', async ({ readJsonBody: f }) => {
      await assert.rejects(() => f(bodyReq('POST', '/x', [Buffer.alloc(6), Buffer.alloc(6)]), 10), e => e.status === 413);
      assert.deepEqual(await f(bodyReq('POST', '/x', [Buffer.from('[1,2,3,4]')]), 9), [1, 2, 3, 4]);
    }],
    ['content-length понад ліміт -> 413 ще до читання', async ({ readJsonBody: f }) => {
      await assert.rejects(() => f(bodyReq('POST', '/x', [Buffer.from('{}')], { 'content-length': '300000' })), e => e.status === 413);
    }],
    ['некоректний або порожній JSON -> 400', async ({ readJsonBody: f }) => {
      await assert.rejects(() => f(bodyReq('POST', '/x', [Buffer.from('{"a":')])), e => e.status === 400);
      await assert.rejects(() => f(bodyReq('POST', '/x', [])), e => e.status === 400);
    }],
    ['помилка потоку -> 400', async ({ readJsonBody: f }) => {
      const req = new Readable({ read() { this.destroy(new Error('boom')); } }); req.headers = {};
      await assert.rejects(() => f(req), e => e.status === 400);
    }],
  ],
  handleGetVaults: [
    ['нерозкрита експозиція: список і детальний ендпоінт дають однаковий MQI (null: нічого перевірити)', async mod => sandbox(async db => {
      ins(db, 'vaults', V(0x30, { version: 'v2', total_assets_usd: 1e6, liquidity_usd: 1e6, unresolved_exposure_usd: 1e6 }));
      const inList = list(mod).vaults.find(v => v.address === addr(0x30));
      const detail = getJson(mod, '/api/vaults/' + addr(0x30)).body;
      assert.equal(inList.mqiPercent, null); assert.equal(inList.unverifiedPercent, 100); assert.equal(inList.isUnpriced, false);
      assert.equal(detail.verdict.mqi.mqiPercent, inList.mqiPercent);
    })],
    ['ринок без даних bad debt: у деталях isUnverified, не isFlagged, MQI 100, у списку unverifiedPercent', async mod => sandbox(async db => {
      ins(db, 'markets', M('ok', { total_supply_assets_usd: 1e9, total_borrow_assets_usd: 0 }));
      ins(db, 'markets', M('nodata', { total_supply_assets_usd: 1e9, total_borrow_assets_usd: 0, bad_debt_usd: null }));
      ins(db, 'vaults', V(0x33, { total_assets_usd: 1e6 }));
      ins(db, 'vault_allocations', A(0x33, 'ok', 5e5));
      ins(db, 'vault_allocations', A(0x33, 'nodata', 5e5));
      const body = getJson(mod, '/api/vaults/' + addr(0x33)).body;
      const row = body.allocations.find(a => a.marketUniqueKey === 'nodata');
      assert.equal(row.isUnverified, true); assert.equal(row.isFlagged, false); assert.equal(row.isClean, false);
      assert.deepEqual(row.warnings, ['Bad debt data not reported']);
      assert.equal(body.verdict.mqi.mqiPercent, 100);
      const inList = list(mod).vaults.find(v => v.address === addr(0x33));
      assert.equal(inList.mqiPercent, 100); assert.equal(inList.unverifiedPercent, 50); assert.equal(inList.isAllClean, false);
    })],
    ['vault без USD-ціни: у списку mqiPercent і exitCapPercent null, isAllClean false, у JSON null (не 100)', async mod => sandbox(async db => {
      ins(db, 'vaults', V(0x31, { version: 'v1', total_assets: '5000000', total_assets_usd: 0, liquidity_usd: null }));
      const inList = list(mod).vaults.find(v => v.address === addr(0x31));
      assert.equal(inList.mqiPercent, null); assert.equal(inList.exitCapPercent, null); assert.equal(inList.isAllClean, false);
      const detail = getJson(mod, '/api/vaults/' + addr(0x31)).body;
      assert.equal(detail.verdict.mqi.mqiPercent, null);
      assert.ok(detail.verdict.redFlags.some(x => x.title === 'Unpriced Vault'));
    })],
    ['список віддає unresolvedPercent для vault з нерозкритим капіталом', async mod => sandbox(async db => {
      ins(db, 'vaults', V(0x32, { version: 'v2', total_assets_usd: 1e6, liquidity_usd: 1e6, unresolved_exposure_usd: 4e5 }));
      assert.equal(list(mod).vaults.find(v => v.address === addr(0x32)).unresolvedPercent, 40);
    })],
    ['відповідь містить total/limit/offset/vaults; за замовчуванням limit 500, offset 0', async mod => sandbox(async db => {
      seedCatalog(db);
      const b = list(mod); assert.equal(b.total, 4); assert.equal(b.limit, 500); assert.equal(b.offset, 0); assert.equal(b.vaults.length, 4);
    })],
    ['поля vault відображаються з рядка БД без втрат', async mod => sandbox(async db => {
      seedCatalog(db);
      const v = list(mod, '?search=Alpha').vaults[0];
      assert.equal(v.address, addr(1)); assert.equal(v.chainId, 1); assert.equal(v.name, 'Alpha USDC'); assert.equal(v.symbol, 'aUSDC');
      assert.equal(v.curatorName, 'Gauntlet'); assert.equal(v.version, 'v1'); assert.equal(v.isListed, true);
      assert.deepEqual(v.asset, { address: '0xusdc', symbol: 'USDC', decimals: 6, priceUsd: 1 });
      assert.equal(v.totalAssets, '1000000000'); assert.equal(v.totalAssetsHuman, 1000); assert.equal(v.totalAssetsUsd, 1000);
      assert.equal(v.liquidityUsd, 300); assert.equal(v.apy, 0.10); assert.equal(v.netApy, 0.05); assert.equal(v.fee, 0.1); assert.equal(v.updatedAt, 123);
      assert.equal(list(mod, '?search=beta').vaults[0].isListed, false);
    })],
    ['сортування за замовчуванням: liquidity_usd за спаданням', async mod => sandbox(async db => {
      seedCatalog(db); assert.deepEqual(ids(list(mod)), [4, 1, 2, 3]);
    })],
    ['сортування за кожною дозволеною колонкою', async mod => sandbox(async db => {
      seedCatalog(db);
      assert.deepEqual(ids(list(mod, '?sortBy=total_assets_usd&sortOrder=asc')), [4, 1, 3, 2]);
      assert.deepEqual(ids(list(mod, '?sortBy=net_apy')), [3, 1, 2, 4]);
      assert.deepEqual(ids(list(mod, '?sortBy=apy')), [4, 2, 3, 1]);
      assert.deepEqual(ids(list(mod, '?sortBy=name&sortOrder=asc')), [3, 1, 4, 2]);
      assert.deepEqual(ids(list(mod, '?sortBy=liquidity_usd&sortOrder=aSc')), [3, 2, 1, 4]);
    })],
    ['недозволений sortBy (у т.ч. SQL і constructor) -> liquidity_usd, недійсний sortOrder -> DESC', async mod => sandbox(async db => {
      seedCatalog(db);
      for (const s of ['constructor', 'name;DROP TABLE vaults', 'chain_id', '__proto__']) {
        const { status, body } = getJson(mod, '/api/vaults?sortBy=' + encodeURIComponent(s));
        assert.equal(status, 200, s); assert.deepEqual(ids(body), [4, 1, 2, 3], s);
      }
      assert.deepEqual(ids(list(mod, '?sortOrder=up')), [4, 1, 2, 3]);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vaults').get().c, 4);
    })],
    ['chainId фільтрує; нуль, від\'ємний і нечисловий chainId ігноруються', async mod => sandbox(async db => {
      seedCatalog(db);
      assert.deepEqual(ids(list(mod, '?chainId=8453')), [2]);
      assert.deepEqual(ids(list(mod, '?chainId=1')), [4, 1, 3]);
      for (const c of ['0', '-1', 'abc', '']) assert.equal(list(mod, '?chainId=' + c).total, 4, c);
    })],
    ['listedOnly=1 і listedOnly=true лишають тільки лістинговані, інші значення - усі', async mod => sandbox(async db => {
      seedCatalog(db);
      assert.deepEqual(ids(list(mod, '?listedOnly=1')), [4, 1, 3]);
      assert.deepEqual(ids(list(mod, '?listedOnly=true')), [4, 1, 3]);
      assert.equal(list(mod, '?listedOnly=0').total, 4); assert.equal(list(mod, '?listedOnly=yes').total, 4);
    })],
    ['пошук нечутливий до регістру і йде по name, symbol, address, curator, asset_symbol', async mod => sandbox(async db => {
      seedCatalog(db);
      assert.deepEqual(ids(list(mod, '?search=ALPHA')), [1]);
      assert.deepEqual(ids(list(mod, '?search=ausdc')), [1]);
      assert.deepEqual(ids(list(mod, '?search=steak')), [2]);
      assert.deepEqual(ids(list(mod, '?search=dai')), [4]);
      assert.deepEqual(ids(list(mod, '?search=' + addr(3).slice(-6))), [3]);
      assert.deepEqual(ids(list(mod, '?search=%20%20alpha%20')), [1], 'пробіли навколо мають обрізатися');
    })],
    ['символи %, _ і \\ у пошуку шукаються буквально (ESCAPE)', async mod => sandbox(async db => {
      seedCatalog(db);
      assert.deepEqual(ids(list(mod, '?search=%25')), [3]);
      assert.deepEqual(ids(list(mod, '?search=_')), [2]);
      assert.deepEqual(ids(list(mod, '?search=%5C')), [4]);
      assert.deepEqual(ids(list(mod, '?search=alph_')), [], '_ не має працювати як шаблон одного символу');
      assert.deepEqual(ids(list(mod, '?search=al%25ha')), [], '% не має працювати як шаблон');
    })],
    ['SQL-ін\'єкція в пошуку не змінює запит і не ламає БД', async mod => sandbox(async db => {
      seedCatalog(db);
      for (const s of ["' OR 1=1 --", "x'); DROP TABLE vaults; --", '" OR ""="']) {
        const { status, body } = getJson(mod, '/api/vaults?search=' + encodeURIComponent(s));
        assert.equal(status, 200, s); assert.equal(body.total, 0, s);
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vaults').get().c, 4);
    })],
    ['пошук обрізається рівно до 64 символів', async mod => sandbox(async db => {
      const name = 'N'.repeat(60) + 'ABCD';
      ins(db, 'vaults', V(9, { name }));
      ins(db, 'vaults', V(10, { name: 'N'.repeat(40) }));
      assert.deepEqual(ids(list(mod, '?search=' + name + 'ZZZ')), [9], 'зайве відкидається, але перші 64 символи шукаються повністю');
    })],
    ['фільтри поєднуються через AND', async mod => sandbox(async db => {
      seedCatalog(db);
      assert.deepEqual(ids(list(mod, '?chainId=1&listedOnly=1&search=a')), [4, 1]);
      assert.deepEqual(ids(list(mod, '?chainId=8453&listedOnly=1')), []);
    })],
    ['пагінація: limit/offset ріжуть сторінку, total рахує всі збіги', async mod => sandbox(async db => {
      seedCatalog(db);
      const b = list(mod, '?limit=2&offset=1'); assert.deepEqual(ids(b), [1, 2]); assert.equal(b.total, 4);
      const tail = list(mod, '?limit=2&offset=10'); assert.deepEqual(tail.vaults, []); assert.equal(tail.total, 4);
      assert.equal(list(mod, '?listedOnly=1&limit=1').total, 3);
    })],
    ['межі limit: 0 і від\'ємний -> 1, 1000 лишається, >1000 -> 1000, нечисловий -> 500', async mod => sandbox(async db => {
      seedCatalog(db);
      const l0 = list(mod, '?limit=0'); assert.equal(l0.limit, 1); assert.deepEqual(ids(l0), [4]);
      assert.equal(list(mod, '?limit=-3').limit, 1);
      assert.equal(list(mod, '?limit=1000').limit, 1000);
      assert.equal(list(mod, '?limit=1001').limit, 1000);
      assert.equal(list(mod, '?limit=99999').limit, 1000);
      assert.equal(list(mod, '?limit=abc').limit, 500);
    })],
    ['межі offset: від\'ємний і нечисловий -> 0', async mod => sandbox(async db => {
      seedCatalog(db);
      assert.equal(list(mod, '?offset=-5').offset, 0); assert.equal(list(mod, '?offset=abc').offset, 0);
      assert.deepEqual(ids(list(mod, '?offset=-5')), [4, 1, 2, 3]);
    })],
    ['дуже великий offset -> не 5xx (порожня сторінка або 400)', async mod => sandbox(async db => {
      seedCatalog(db);
      for (const o of ['99999999999999999999', '9223372036854775807']) {
        const r = call(mod.handleRequest, 'GET', '/api/vaults?offset=' + o);
        assert.ok([200, 400].includes(r.statusCode), `offset=${o} -> ${r.statusCode}`);
      }
    })],
    ['метрики ризику враховують пірів: exit 50%, stressed 25%, ринок переповнений', async mod => sandbox(async db => {
      seedCrowded(db);
      const p = list(mod, '?search=Vault%20P').vaults[0];
      assert.equal(p.exitCapPercent, 50); assert.equal(p.exitCapUsd, 5e5);
      assert.equal(p.stressedExitCapPercent, 25); assert.equal(p.stressedExitCapUsd, 2.5e5);
      assert.equal(p.isCrowded, true); assert.equal(p.crowdedMarketsCount, 1);
      assert.equal(p.mqiPercent, 100); assert.equal(p.isAllClean, true); assert.equal(p.compromisedCount, 0);
    })],
    ['метрики якості: 40% у нелістингованих ринках -> MQI 60, два скомпрометовані ринки', async mod => sandbox(async db => {
      seedQuality(db);
      const [f, g] = [list(mod, '?search=' + addr(0x20).slice(-4)).vaults[0], list(mod, '?search=' + addr(0x21).slice(-4)).vaults[0]];
      assert.equal(f.mqiPercent, 60); assert.equal(f.compromisedCount, 2); assert.equal(f.isAllClean, false);
      assert.equal(g.mqiPercent, 100); assert.equal(g.compromisedCount, 0);
    })],
    ['нульовий TVL з алокаціями не дає 100% виходу (ефективний TVL = сума алокацій)', async mod => sandbox(async db => {
      ins(db, 'markets', M('full', { total_supply_assets_usd: 1000, total_borrow_assets_usd: 1000 }));
      ins(db, 'vaults', V(0x30, { total_assets_usd: 0 }));
      ins(db, 'vault_allocations', A(0x30, 'full', 1000));
      const z = list(mod).vaults[0];
      assert.equal(z.exitCapPercent, 0); assert.equal(z.stressedExitCapPercent, 0);
    })],
    ['каталог без синхронізації живе 60 с (запасний TTL для CLI-синхронізації в іншому процесі)', async mod => sandbox(async db => withClock(async clock => {
      seedCatalog(db);
      assert.equal(list(mod, '?search=Alpha').vaults[0].name, 'Alpha USDC');
      db.prepare("UPDATE vaults SET name = 'Alpha NEW' WHERE address = ?").run(addr(1));
      clock.advance(59999); assert.equal(list(mod, '?search=Alpha').vaults[0].name, 'Alpha USDC');
      clock.advance(2); assert.equal(list(mod, '?search=Alpha').vaults[0].name, 'Alpha NEW');
    }))],
    ['рушії рахуються раз на епоху: будь-які нові фільтри, пошук і сторінки беруть той самий знімок', async mod => sandbox(async db => {
      seedCatalog(db);
      list(mod, '?limit=1');
      db.prepare("UPDATE vaults SET name = 'Changed', liquidity_usd = 0 WHERE address = ?").run(addr(4));
      ins(db, 'vaults', V(5, { name: 'Late' }));
      for (const qs of ['?search=back', '?offset=0&limit=3&junk=1', '?sortBy=name&sortOrder=asc', '?chainId=1&listedOnly=1', '?search=x' + 'y'.repeat(500)]) {
        const b = list(mod, qs);
        assert.ok(!b.vaults.some(v => v.name === 'Changed' || v.name === 'Late'), qs);
      }
      assert.equal(list(mod).total, 4);
    })],
    ['однакові значення сортування впорядковуються за адресою; NULL - найменше значення', async mod => sandbox(async db => {
      for (const n of [3, 1, 2]) ins(db, 'vaults', V(n, { liquidity_usd: 50 }));
      ins(db, 'vaults', V(4, { liquidity_usd: null }));
      assert.deepEqual(ids(list(mod)), [1, 2, 3, 4], 'DESC: NULL останнім');
      assert.deepEqual(ids(list(mod, '?sortOrder=asc')), [4, 1, 2, 3], 'ASC: NULL першим');
    })],
    ['кожен параметр застосовується до кешованого каталогу', async mod => sandbox(async db => {
      seedCatalog(db);
      assert.deepEqual(ids(list(mod)), [4, 1, 2, 3]);
      assert.deepEqual(ids(list(mod, '?sortOrder=asc')), [3, 2, 1, 4]);
      assert.deepEqual(ids(list(mod, '?sortBy=net_apy')), [3, 1, 2, 4]);
      assert.deepEqual(ids(list(mod, '?chainId=8453')), [2]);
      assert.deepEqual(ids(list(mod, '?listedOnly=1')), [4, 1, 3]);
      assert.deepEqual(ids(list(mod, '?search=beta')), [2]);
      assert.deepEqual(ids(list(mod, '?limit=1')), [4]);
      assert.deepEqual(ids(list(mod, '?offset=3')), [3]);
    })],
    ['успішна синхронізація інвалідує кеш списку', async mod => sandbox(async db => {
      seedCatalog(db);
      assert.equal(list(mod, '?search=Alpha').vaults[0].name, 'Alpha USDC');
      db.prepare("UPDATE vaults SET name = 'Alpha AFTER' WHERE address = ?").run(addr(1));
      assert.equal(list(mod, '?search=Alpha').vaults[0].name, 'Alpha USDC');
      await resetCaches();
      assert.equal(list(mod, '?search=Alpha').vaults[0].name, 'Alpha AFTER');
    })],
    ['HEAD /api/vaults -> 200 без тіла', async mod => sandbox(async db => {
      seedCatalog(db);
      const r = call(mod.handleRequest, 'HEAD', '/api/vaults'); assert.equal(r.statusCode, 200); assert.equal(r.body, '');
    })],
  ],
  handleGetToken: [
    ['no record -> 404; a stored record -> 200 with data and the stale flag; the route is wired, a bad address or chain is not', async mod => sandbox(async db => {
      const A = '0x' + 'ab'.repeat(20);
      let r = mockRes(); mod.handleGetToken(mockReq('GET', '/'), r, 1, A); assert.equal(r.statusCode, 404);
      db.prepare('INSERT INTO token_data (chain_id, address, symbol, collected_at, status, coverage, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(1, A, 'TKN', Math.floor(Date.now() / 1000), 'ok', 0.8, JSON.stringify({ identity: { symbol: 'TKN' } }));
      const { status, body } = getJson(mod, '/api/tokens/1/' + A);
      assert.equal(status, 200); assert.deepEqual([body.chainId, body.address, body.status, body.coverage, body.stale, body.data.identity.symbol], [1, A, 'ok', 0.8, false, 'TKN']);
      assert.deepEqual([body.risk.model, body.risk.grade, body.risk.not_rated_reason], ['token-risk-3', 'NR', 'no price'], 'the rating rides along; a record without a price is not rated');
      assert.equal(getJson(mod, '/api/tokens/1/0xnothex').status, 404); assert.equal(getJson(mod, '/api/tokens/x/' + A).status, 404);
    })],
    ['a vault share is rated against the stored price of its asset', async mod => sandbox(async db => {
      const susde = riskRecord('1_sUSDe');
      putToken(db, susde);
      assert.equal(getJson(mod, '/api/tokens/1/' + susde.address).body.risk.flags.find(f => f.id === 'share_price_gap').state, 'unknown');
      putToken(db, { chainId: 1, address: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', symbol: 'USDe', status: 'ok', coverage: 0.9, data: { price: { usd: 0.9997 } } });
      const r = getJson(mod, '/api/tokens/1/' + susde.address).body.risk;
      assert.deepEqual([r.grade, r.flags.find(f => f.id === 'share_price_gap').state], ['A', 'clear']);
    })],
    ['a broken database -> 500 without details', async mod => sandbox(async db => {
      db.exec('DROP TABLE token_data');
      const r = mockRes(); mod.handleGetToken(mockReq('GET', '/'), r, 1, '0x' + 'ab'.repeat(20));
      assert.equal(r.statusCode, 500); assert.ok(!/token_data/.test(r.body));
    })]
  ],
  handleGetTokenRanking: [
    ['safest first, NR last; pagination, chain and grade filters keep the global rank; an unknown grade is 400', async mod => sandbox(async db => {
      for (const name of ['1_WETH', '1_USDC', '1_kBTC', '4663_USDe', '8453_cbBTC']) putToken(db, riskRecord(name));
      const all = getJson(mod, '/api/tokens/ranking').body;
      assert.deepEqual([all.model, all.total, all.limit, all.offset], ['token-risk-3', 5, 100, 0]);
      assert.deepEqual(all.tokens.map(t => t.symbol), ['USDC', 'cbBTC', 'WETH', 'kBTC', 'USDe']);
      assert.deepEqual(all.tokens.map(t => t.rank), [1, 2, 3, 4, 5]); assert.equal(all.tokens.at(-1).grade, 'NR');
      const page = getJson(mod, '/api/tokens/ranking?limit=2&offset=1').body;
      assert.deepEqual([page.total, page.limit, page.offset, page.tokens.map(t => t.symbol)], [5, 2, 1, ['cbBTC', 'WETH']]);
      assert.deepEqual(getJson(mod, '/api/tokens/ranking?chainId=8453').body.tokens.map(t => [t.symbol, t.rank]), [['cbBTC', 2]]);
      assert.deepEqual(getJson(mod, '/api/tokens/ranking?grade=nr').body.tokens.map(t => t.symbol), ['USDe']);
      assert.equal(getJson(mod, '/api/tokens/ranking?limit=9999').body.limit, 500); assert.equal(getJson(mod, '/api/tokens/ranking?limit=abc').body.limit, 100);
      const bad = getJson(mod, '/api/tokens/ranking?grade=Z'); assert.equal(bad.status, 400); assert.match(bad.body.error, /grade/);
      const t = all.tokens[0];
      assert.ok(Array.isArray(t.top_flags) && 'stability_score' in t && 'control_score' in t && 'confidence' in t);
    })],
    ['the ranking is cached until the next sync clears the caches', async mod => sandbox(async db => {
      putToken(db, riskRecord('1_WETH'));
      assert.equal(getJson(mod, '/api/tokens/ranking').body.total, 1);
      putToken(db, riskRecord('1_USDC'));
      assert.equal(getJson(mod, '/api/tokens/ranking').body.total, 1, 'served from the cache');
      await resetCaches();
      assert.equal(getJson(mod, '/api/tokens/ranking').body.total, 2);
    })],
    ['an empty table gives an empty list; a broken database -> 500 without details', async mod => sandbox(async db => {
      assert.deepEqual(getJson(mod, '/api/tokens/ranking').body.tokens, []);
      await resetCaches(); db.exec('DROP TABLE token_data');
      const r = mockRes(); mod.handleGetTokenRanking(mockReq('GET', '/'), r, URL_('/api/tokens/ranking'));
      assert.equal(r.statusCode, 500); assert.ok(!/token_data/.test(r.body));
    })]
  ],
  handleGetVaultByAddress: [
    ['невідомий vault -> 404 з адресою в повідомленні', ({ handleGetVaultByAddress: f }) => {
      const a = '0x' + '0'.repeat(40), res = mockRes(); f(mockReq('GET', '/'), res, a);
      assert.equal(res.statusCode, 404); assert.ok(JSON.parse(res.body).error.includes(a));
    }],
    ['структура відповіді: vault, verdict, allocations з полями з БД', async mod => sandbox(async db => {
      seedQuality(db);
      const { status, body } = getJson(mod, '/api/vaults/' + addr(0x20));
      assert.equal(status, 200); assert.deepEqual(Object.keys(body).sort(), ['allocations', 'vault', 'verdict']);
      assert.equal(body.vault.address, addr(0x20)); assert.equal(body.vault.totalAssetsUsd, 1e6); assert.equal(body.vault.isListed, true);
      assert.equal(body.vault.totalAssetsHuman, 1000); assert.deepEqual(body.vault.asset, { address: '0xusdc', symbol: 'USDC', decimals: 6, priceUsd: 1 });
      assert.equal(body.verdict.vaultAddress, addr(0x20));
      assert.deepEqual(body.allocations.map(a => a.marketUniqueKey), ['clean', 'unl', 'unl2'], 'сортування за supply_assets_usd DESC');
      const c = body.allocations[0];
      assert.equal(c.supplyAssetsUsd, 6e5); assert.equal(c.loanSymbol, 'USDC'); assert.equal(c.collateralSymbol, 'WETH');
      assert.equal(c.lltvPercent, 86); assert.equal(c.marketTotalSupplyUsd, 1e9); assert.equal(c.isListed, true);
      assert.equal(c.oracleType, 'Unknown'); assert.equal(c.badDebtUsd, 0); assert.deepEqual(c.warnings, []);
      assert.equal(body.allocations[1].isListed, false);
    })],
    ['матеріальні скомпрометовані ринки позначені, MQI = 60%', async mod => sandbox(async db => {
      seedQuality(db);
      const { body } = getJson(mod, '/api/vaults/' + addr(0x20));
      assert.deepEqual(body.allocations.map(a => a.isFlagged), [false, true, true]);
      assert.deepEqual(body.allocations.map(a => a.isClean), [true, false, false]);
      assert.equal(body.verdict.mqi.mqiPercent, 60);
      assert.ok(body.allocations[1].warnings.some(w => /Unlisted/.test(w)));
    })],
    ['пил (<1% TVL) у нелістингованому ринку не позначається, але попередження лишається', async mod => sandbox(async db => {
      seedQuality(db);
      const { body } = getJson(mod, '/api/vaults/' + addr(0x21));
      const dust = body.allocations.find(a => a.marketUniqueKey === 'unl2');
      assert.equal(dust.isFlagged, false); assert.equal(dust.isClean, true); assert.ok(dust.warnings.length > 0);
      assert.equal(body.verdict.mqi.mqiPercent, 100);
    })],
    ['піри з інших vaults формують stressed exit і переповнений ринок', async mod => sandbox(async db => {
      seedCrowded(db);
      const liq = getJson(mod, '/api/vaults/' + addr(0x10)).body.verdict.liquidity;
      assert.equal(liq.instantExitCapacityPercent, 50); assert.equal(liq.stressedExitCapacityPercent, 25);
      assert.equal(liq.crowdedMarkets.length, 1); assert.equal(liq.crowdedMarkets[0].peerSupplyUsd, 1e6);
      assert.deepEqual(liq.crowdedMarkets[0].topPeers, ['Peer Q ($1.0M)']);
    })],
    ['V2 через базовий V1: власна частка віднімається від базового, піри P і Q(600K)', async mod => sandbox(async db => {
      seedCrowded(db);
      const liq = getJson(mod, '/api/vaults/' + addr(0x13)).body.verdict.liquidity;
      assert.equal(liq.instantExitCapacityPercent, 100); assert.equal(liq.stressedExitCapacityPercent, 25);
      assert.equal(liq.crowdedMarkets[0].peerSupplyUsd, 1.6e6);
      assert.deepEqual(liq.crowdedMarkets[0].topPeers, ['Vault P ($1.0M)', 'Peer Q ($600K)']);
    })],
    ['кеш аудиту: у межах 30 с віддає збережене, після 30 с - свіже', async mod => sandbox(async db => withClock(async clock => {
      ins(db, 'vaults', V(0x40, { name: 'Before' }));
      const get = () => getJson(mod, '/api/vaults/' + addr(0x40)).body.vault.name;
      assert.equal(get(), 'Before');
      db.prepare("UPDATE vaults SET name = 'After' WHERE address = ?").run(addr(0x40));
      clock.advance(29999); assert.equal(get(), 'Before');
      clock.advance(2); assert.equal(get(), 'After');
    }))],
    ['404 не кешується: vault, що з\'явився, одразу доступний', async mod => sandbox(async db => {
      assert.equal(call(mod.handleRequest, 'GET', '/api/vaults/' + addr(0x41)).statusCode, 404);
      ins(db, 'vaults', V(0x41));
      const { status, body } = getJson(mod, '/api/vaults/' + addr(0x41));
      assert.equal(status, 200); assert.equal(body.vault?.address, addr(0x41));
    })],
    ['нульовий TVL з алокаціями: вихід рахується від суми алокацій (0%, а не 100%)', async mod => sandbox(async db => {
      ins(db, 'markets', M('full', { total_supply_assets_usd: 1000, total_borrow_assets_usd: 1000 }));
      ins(db, 'vaults', V(0x43, { total_assets_usd: 0 }));
      ins(db, 'vault_allocations', A(0x43, 'full', 1000));
      const liq = getJson(mod, '/api/vaults/' + addr(0x43)).body.verdict.liquidity;
      assert.equal(liq.instantExitCapacityPercent, 0); assert.equal(liq.stressedExitCapacityPercent, 0);
    })],
    ['успішна синхронізація інвалідує кеш аудиту', async mod => sandbox(async db => {
      ins(db, 'vaults', V(0x42, { name: 'Before' }));
      const get = () => getJson(mod, '/api/vaults/' + addr(0x42)).body.vault.name;
      assert.equal(get(), 'Before');
      db.prepare("UPDATE vaults SET name = 'After' WHERE address = ?").run(addr(0x42));
      assert.equal(get(), 'Before');
      await resetCaches(); assert.equal(get(), 'After');
    })],
    ['кеш аудиту обмежений 500 записами: 501-й витісняє найстаріший', async mod => sandbox(async db => {
      db.exec('BEGIN'); for (let i = 0; i <= 500; i++) ins(db, 'vaults', V(0x1000 + i, { name: 'Old' })); db.exec('COMMIT');
      const get = i => getJson(mod, '/api/vaults/' + addr(0x1000 + i)).body.vault.name;
      for (let i = 0; i < 500; i++) get(i);
      db.exec("UPDATE vaults SET name = 'New'");
      get(500);
      assert.equal(get(1), 'Old', 'другий запис мав лишитися в кеші');
      assert.equal(get(0), 'New', 'найстаріший запис мав бути витіснений');
    })],
  ],
  getVaultCatalog: [
    ['усі vaults (і нелістинговані) з метриками, впорядковані за адресою', async mod => sandbox(async db => {
      seedCatalog(db);
      const c = mod.getVaultCatalog();
      assert.deepEqual(c.map(v => parseInt(v.address, 16)), [1, 2, 3, 4]);
      for (const v of c) assert.ok('mqiPercent' in v && 'hhi' in v && 'exitCapPercent' in v, v.address);
    })],
    ['повторний виклик повертає той самий масив до синхронізації, після неї - новий', async mod => sandbox(async db => {
      seedCatalog(db);
      const first = mod.getVaultCatalog();
      assert.equal(mod.getVaultCatalog(), first);
      await resetCaches();
      assert.notEqual(mod.getVaultCatalog(), first);
    })],
  ],
  DEFAULT_VAULTS_LIMIT: [
    ['збігається з фактичним дефолтом /api/vaults і з логом старту index.js (C8)', async mod => sandbox(async () => {
      assert.equal(list(mod).limit, mod.DEFAULT_VAULTS_LIMIT);
      const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
      assert.match(index, /default limit: \$\{DEFAULT_VAULTS_LIMIT\}/);
    })],
  ],
  validateEventQueryParams: [
    ['приймає коректні параметри (address, addresses, since, before, limit, kinds, severity, status)', ({ validateEventQueryParams: f }) => {
      const upperHex = '0x' + 'A'.repeat(40);
      const sp = new URLSearchParams({
        address: upperHex,
        addresses: `${addr(2)},${addr(3)}`,
        since: '1700000000',
        before: '42',
        limit: '100',
        kinds: 'fee_changed,tvl_drop',
        severity: 'warning',
        status: 'final'
      });
      const r = f(sp);
      assert.equal(r.ok, true);
      assert.deepEqual(r.addresses, [upperHex.toLowerCase(), addr(2), addr(3)]);
      assert.equal(r.since, 1700000000);
      assert.equal(r.before, 42);
      assert.equal(r.limit, 100);
      assert.deepEqual(r.kinds, ['fee_changed', 'tvl_drop']);
      assert.deepEqual(r.severities, ['warning', 'critical']);
      assert.equal(r.status, 'final');
    }],
    ['відхиляє >50 адрес, невалідні адреси, невідомі kinds, некоректні severity/status та limit > 200', ({ validateEventQueryParams: f }) => {
      const over50 = Array.from({ length: 51 }, (_, i) => addr(i + 1)).join(',');
      assert.equal(f(new URLSearchParams({ addresses: over50 })).ok, false);
      assert.equal(f(new URLSearchParams({ address: '0x123' })).ok, false);
      assert.equal(f(new URLSearchParams({ addresses: `${addr(1)},not-an-address` })).ok, false);
      assert.equal(f(new URLSearchParams({ kinds: 'fee_changed,not_a_real_kind' })).ok, false);
      assert.equal(f(new URLSearchParams({ severity: 'fatal' })).ok, false);
      assert.equal(f(new URLSearchParams({ status: 'archived' })).ok, false);
      assert.equal(f(new URLSearchParams({ limit: '201' })).ok, false);
      assert.equal(f(new URLSearchParams({ limit: '0' })).ok, false);
      assert.equal(f(new URLSearchParams({ since: '-5' })).ok, false);
      assert.equal(f(new URLSearchParams({ before: '0' })).ok, false);
    }],
  ],
  formatEventRow: [
    ['парсить details_json у details та повертає нормалізовані поля події', ({ formatEventRow: f }) => {
      const r = f({
        id: 7,
        vault_address: addr(1),
        vault_name: 'Alpha',
        vault_symbol: 'aUSDC',
        chain_id: 1,
        kind: 'fee_changed',
        source: 'admin_event',
        severity: 'warning',
        status: 'final',
        title: 'Fee changed',
        details_json: '{"newFee":0.1}',
        dedupe_key: 'admin:0x1:0xh:setFee',
        occurred_at: 1700000100,
        valid_at: null,
        detected_at: 1700000200
      });
      assert.equal(r.id, 7);
      assert.deepEqual(r.details, { newFee: 0.1 });
      assert.equal(r.vault_address, addr(1));
      assert.equal(r.vaultAddress, addr(1));
    }],
  ],
  handleGetEvents: [
    ['фільтрує за address, addresses, since, kinds, severity, status та підтримує пагінацію before/limit', async mod => sandbox(async db => {
      ins(db, 'vaults', V(1, { name: 'Vault One' }));
      ins(db, 'vaults', V(2, { name: 'Vault Two' }));
      const baseEv = {
        chain_id: 1, source: 'admin_event', status: 'final',
        title: 'Event', details_json: '{"x":1}', valid_at: null, detected_at: 2000
      };
      ins(db, 'vault_events', { ...baseEv, vault_address: addr(1), kind: 'skim', severity: 'info', dedupe_key: 'k1', occurred_at: 1000 });
      ins(db, 'vault_events', { ...baseEv, vault_address: addr(1), kind: 'fee_changed', severity: 'warning', dedupe_key: 'k2', occurred_at: 1200 });
      ins(db, 'vault_events', { ...baseEv, vault_address: addr(2), kind: 'bad_debt_appeared', source: 'derived', severity: 'critical', dedupe_key: 'k3', occurred_at: 1400 });

      const page1 = getJson(mod, '/api/events?limit=2');
      assert.equal(page1.status, 200);
      assert.equal(page1.body.events.length, 2);
      assert.deepEqual(page1.body.events.map(e => e.dedupe_key), ['k3', 'k2']);
      assert.deepEqual(page1.body.events[0].details, { x: 1 });
      assert.ok(page1.body.nextBefore != null);

      const page2 = getJson(mod, `/api/events?limit=2&before=${page1.body.nextBefore}`);
      assert.equal(page2.status, 200);
      assert.deepEqual(page2.body.events.map(e => e.dedupe_key), ['k1']);
      assert.equal(page2.body.nextBefore, null);

      const filtered = getJson(mod, `/api/events?address=${addr(1)}&severity=warning&since=1100&kinds=fee_changed&status=final`);
      assert.equal(filtered.status, 200);
      assert.deepEqual(filtered.body.events.map(e => e.dedupe_key), ['k2']);
    })],
    ['повертає 400 при >50 адресах, невалідній адресі, невідомому kind або limit > 200', async mod => sandbox(async () => {
      const over50 = Array.from({ length: 51 }, (_, i) => addr(i + 1)).join(',');
      assert.equal(getJson(mod, `/api/events?addresses=${over50}`).status, 400);
      assert.equal(getJson(mod, '/api/events?address=0xbad').status, 400);
      assert.equal(getJson(mod, '/api/events?kinds=unknown_kind').status, 400);
      assert.equal(getJson(mod, '/api/events?limit=250').status, 400);
    })],
  ],
  handleGetPendingEvents: [
    ['повертає лише події зі status=pending та valid_at > now, впорядковані за valid_at ASC', async mod => sandbox(async db => {
      const nowSec = Math.floor(Date.now() / 1000);
      ins(db, 'vaults', V(1, { name: 'Vault One' }));
      ins(db, 'vaults', V(2, { name: 'Vault Two' }));
      const base = { chain_id: 1, source: 'pending_config', severity: 'warning', title: 'Pending', details_json: '{}', occurred_at: nowSec - 100, detected_at: nowSec - 100 };
      ins(db, 'vault_events', { ...base, vault_address: addr(1), kind: 'pending_timelock_change', status: 'pending', dedupe_key: 'p-later', valid_at: nowSec + 7200 });
      ins(db, 'vault_events', { ...base, vault_address: addr(2), kind: 'pending_cap_increase', status: 'pending', dedupe_key: 'p-sooner', valid_at: nowSec + 1800 });
      ins(db, 'vault_events', { ...base, vault_address: addr(1), kind: 'pending_cap_increase', status: 'pending', dedupe_key: 'p-expired', valid_at: nowSec - 10 });
      ins(db, 'vault_events', { ...base, vault_address: addr(1), kind: 'pending_cap_increase', status: 'applied', dedupe_key: 'p-applied', valid_at: nowSec + 3600 });

      const all = getJson(mod, '/api/events/pending');
      assert.equal(all.status, 200);
      assert.deepEqual(all.body.events.map(e => e.dedupe_key), ['p-sooner', 'p-later']);

      const v1Only = getJson(mod, `/api/events/pending?address=${addr(1)}`);
      assert.equal(v1Only.status, 200);
      assert.deepEqual(v1Only.body.events.map(e => e.dedupe_key), ['p-later']);
    })],
  ],
  handleGetTelegramConfig: [
    ['віддає стан бота; /api/tg/config доступний через маршрутизатор і лише на читання', async mod => {
      const r = getJson(mod, '/api/tg/config');
      assert.equal(r.status, 200); assert.deepEqual(r.body, { enabled: false, username: null });
      const direct = mockRes(); mod.handleGetTelegramConfig(mockReq('GET', '/api/tg/config'), direct);
      assert.deepEqual(JSON.parse(direct.body), { enabled: false, username: null });
    }],
  ],
  handlePutTelegramSubscription: [
    ['зберігає підписку за sub_id і віддає кількість vault-ів; повторний PUT оновлює список', async mod => sandbox(async db => {
      const put = async body => { const res = mockRes(); await mod.handlePutTelegramSubscription(bodyReq('PUT', '/api/tg/subscription', jsonChunks(body)), res); return { status: res.statusCode, body: JSON.parse(res.body) }; };
      const subId = 'abcdefghijklmnopqrstuv';
      assert.deepEqual(await put({ sub_id: subId, vaults: [addr(1), addr(2)] }), { status: 200, body: { vaults: 2, connected: false } });
      assert.deepEqual(await put({ sub_id: subId, vaults: [addr(3)] }), { status: 200, body: { vaults: 1, connected: false } });
      assert.equal(JSON.parse(db.prepare('SELECT vaults_json FROM tg_subscriptions WHERE sub_id = ?').get(subId).vaults_json)[0], addr(3));
    })],
    ['некоректне тіло, sub_id або адреса -> 400; тіло понад 8 КБ -> 413 і закриття з\'єднання', async mod => sandbox(async db => {
      const send = async (chunks, headers) => { const req = bodyReq('PUT', '/api/tg/subscription', chunks, headers); const res = mockRes(); await mod.handlePutTelegramSubscription(req, res); return { status: res.statusCode, req }; };
      assert.equal((await send([Buffer.from('{"sub_id":')])).status, 400);
      assert.equal((await send(jsonChunks({ sub_id: 'short', vaults: [] }))).status, 400);
      assert.equal((await send(jsonChunks({ sub_id: 'abcdefghijklmnopqrstuv', vaults: ['0xbad'] }))).status, 400);
      const big = await send([Buffer.alloc(9000, 97)], { 'content-length': '9000' });
      assert.equal(big.status, 413); assert.equal(big.req.destroyCalls, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tg_subscriptions').get().c, 0);
    })],
  ],
};
