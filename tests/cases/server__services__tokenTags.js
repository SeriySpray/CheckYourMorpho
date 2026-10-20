import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from '../../server/config.js';
import { SCHEMA_SQL } from '../../server/db/schema.js';
import { withFetch, jsonResponse } from '../fixtures.js';

const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const WETH = addr(0xa1), WSTETH = addr(0xa2), USDC = addr(0xa4), UNSEEN = addr(0xaa);
const NOW = 1_800_000_000;
const mixed = a => '0x' + a.slice(2).toUpperCase();

// Без реального очікування між запитами, без ретраїв і без шуму в консолі; мережа підмінена в кожному тесті.
async function quiet(fn) {
  const saved = { p: CONFIG.api.pageThrottleMs, r: CONFIG.api.maxRetries }, warn = console.warn;
  CONFIG.api.pageThrottleMs = 0; CONFIG.api.maxRetries = 0; console.warn = () => {};
  try { return await fn(); } finally { CONFIG.api.pageThrottleMs = saved.p; CONFIG.api.maxRetries = saved.r; console.warn = warn; }
}

// Мок Morpho: morpho[chain][addr] -> {tags, priceUsd} (відсутній = Morpho токен не знає).
function mockNet({ morpho = {}, morphoFails = false } = {}) {
  const calls = { morpho: [] };
  const impl = async (url, init) => {
    const query = JSON.parse(init.body).query;
    const chain = /chainId_in: \[(\d+)\]/.exec(query)[1];
    const asked = JSON.parse(/address_in: (\[.*?\])/.exec(query)[1]);
    calls.morpho.push({ chain, asked });
    if (morphoFails) return jsonResponse({}, 500);
    // адреси віддаються у змішаному регістрі
    const items = asked.filter(a => morpho[chain]?.[a]).map(a => ({ address: mixed(a), ...morpho[chain][a] }));
    return jsonResponse({ data: { assets: { items } } });
  };
  impl.calls = calls;
  return impl;
}

function freshDb(tokens = []) {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA_SQL);
  const ins = db.prepare('INSERT INTO markets (unique_key, chain_id, collateral_asset_address) VALUES (?, ?, ?)');
  tokens.forEach(([chain, a], i) => ins.run(`m${i}`, chain, a));
  return db;
}
const rowOf = (db, a, chain = 1) => ({ ...db.prepare('SELECT * FROM token_tags WHERE chain_id = ? AND address = ?').get(chain, a) });
const refresh = (f, db, net, now = NOW) => quiet(() => withFetch(net, () => f(db, now)));

export default {
  TAGS_TTL_SEC: [['доба', ({ TAGS_TTL_SEC: v }) => assert.equal(v, 86400)]],
  fetchMorphoAssets: [
    ['ключі в нижньому регістрі, відсутній токен не повертається, ціна числом', async ({ fetchMorphoAssets: f }) => {
      const net = mockNet({ morpho: { 1: { [WETH]: { tags: ['eth'], priceUsd: 3000 } } } });
      const r = await withFetch(net, () => f(1, [mixed(WETH), UNSEEN]));
      assert.deepEqual([...r.keys()], [WETH]); assert.deepEqual(r.get(WETH), { tags: ['eth'], priceUsd: 3000 });
      assert.deepEqual(net.calls.morpho[0].asked, [WETH, UNSEEN]);
    }],
    ['порціями по 100 адрес, дублікати й некоректні адреси відкидаються', async ({ fetchMorphoAssets: f }) => {
      const list = Array.from({ length: 250 }, (_, i) => addr(i + 0x1000));
      const net = mockNet();
      await withFetch(net, () => f(1, [...list, list[0], 'not-an-address']));
      assert.deepEqual(net.calls.morpho.map(c => c.asked.length), [100, 100, 50]);
      const none = mockNet(); await withFetch(none, () => f(1, ['0xabc'])); assert.equal(none.calls.morpho.length, 0);
    }],
    ['null у tags і priceUsd -> порожні теги і ціна null', async ({ fetchMorphoAssets: f }) => {
      const r = await withFetch(mockNet({ morpho: { 1: { [WETH]: { tags: null, priceUsd: null } } } }), () => f(1, [WETH]));
      assert.deepEqual(r.get(WETH), { tags: [], priceUsd: null });
    }],
    ['збій запиту кидає виняток', async ({ fetchMorphoAssets: f }) => {
      await quiet(() => assert.rejects(withFetch(mockNet({ morphoFails: true }), () => f(1, [WETH])), /500|failed/));
    }],
  ],
  refreshTokenTags: [
    ['адреси в нижньому регістрі, токен відсутній у відповіді -> рядок з тегами null', async ({ refreshTokenTags: f }) => {
      const db = freshDb([[1, mixed(WETH)], [1, UNSEEN]]);
      const stats = await refresh(f, db, mockNet({ morpho: { 1: { [WETH]: { tags: ['eth'], priceUsd: 3000 } } } }));
      assert.deepEqual(db.prepare('SELECT address FROM token_tags ORDER BY address').all().map(r => r.address), [WETH, UNSEEN]);
      assert.equal(rowOf(db, UNSEEN).tags_json, 'null');
      assert.deepEqual([rowOf(db, WETH).tags_json, rowOf(db, WETH).price_usd], ['["eth"]', 3000]);
      assert.equal(stats.tagsFetched, 2); assert.deepEqual(stats.failed, []);
    }],
    ['порожні адреси ринків ігноруються', async ({ refreshTokenTags: f }) => {
      const db = freshDb([[1, ''], [1, null]]);
      const net = mockNet();
      await refresh(f, db, net);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM token_tags').get().c, 0); assert.equal(net.calls.morpho.length, 0);
    }],
    ['токени різних мереж запитуються окремо', async ({ refreshTokenTags: f }) => {
      const db = freshDb([[1, WETH], [130, USDC]]);
      const net = mockNet({ morpho: { 130: { [USDC]: { tags: ['stablecoin'], priceUsd: 1 } } } });
      await refresh(f, db, net);
      assert.deepEqual(net.calls.morpho.map(c => c.chain).sort(), ['1', '130']); assert.equal(rowOf(db, USDC, 130).tags_json, '["stablecoin"]');
    }],
    ['свіжі токени не запитуються повторно, прострочені запитуються', async ({ refreshTokenTags: f }) => {
      const db = freshDb([[1, WETH]]);
      const morpho = { 1: { [WETH]: { tags: ['eth'], priceUsd: 3000 } } };
      const counts = async now => { const net = mockNet({ morpho }); await refresh(f, db, net, now); return net.calls.morpho.length; };
      assert.equal(await counts(NOW), 1);
      assert.equal(await counts(NOW + 3600), 0);
      assert.equal(await counts(NOW + 86400 + 1), 1);
    }],
    ['збій Morpho зберігає старі теги, без кешу рядок лишається без тегів', async ({ refreshTokenTags: f }) => {
      const db = freshDb([[1, WSTETH]]);
      const first = await refresh(f, freshDb([[1, WETH]]), mockNet({ morphoFails: true }));
      assert.deepEqual(first.failed, ['tags:1']);
      await refresh(f, db, mockNet({ morpho: { 1: { [WSTETH]: { tags: ['eth', 'lst'], priceUsd: 3600 } } } }));
      const before = rowOf(db, WSTETH);
      const stats = await refresh(f, db, mockNet({ morphoFails: true }), NOW + 2 * 86400);
      assert.deepEqual(stats.failed, ['tags:1']); assert.deepEqual(rowOf(db, WSTETH), before);
      const fresh = freshDb([[1, WETH]]); await refresh(f, fresh, mockNet({ morphoFails: true }));
      assert.equal(rowOf(fresh, WETH).tags_json, null); assert.equal(rowOf(fresh, WETH).tags_fetched_at, null);
    }],
  ],
};
