import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from '../../server/config.js';
import { SCHEMA_SQL } from '../../server/db/schema.js';
import { withFetch, jsonResponse } from '../fixtures.js';

const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const WETH = addr(0xa1), WSTETH = addr(0xa2), FAKE = addr(0xa3), USDC = addr(0xa4), PT = addr(0xa5), YT = addr(0xa6), SY = addr(0xa7), LP = addr(0xa8), BASE = addr(0xa9), UNSEEN = addr(0xaa);
const NOW = 1_800_000_000;
const mixed = a => '0x' + a.slice(2).toUpperCase();

// Без реального очікування між запитами, без ретраїв і без шуму в консолі; мережа підмінена в кожному тесті.
async function quiet(fn) {
  const saved = { p: CONFIG.api.pageThrottleMs, r: CONFIG.api.maxRetries }, warn = console.warn;
  CONFIG.api.pageThrottleMs = 0; CONFIG.api.maxRetries = 0; console.warn = () => {};
  try { return await fn(); } finally { CONFIG.api.pageThrottleMs = saved.p; CONFIG.api.maxRetries = saved.r; console.warn = warn; }
}

// Мок обох джерел: morpho[chain][addr] -> {tags, priceUsd} (відсутній = Morpho токен не знає),
// pendle[chain] -> масив ринків, число (HTTP-статус) або відсутній ключ (400, мережа без Pendle).
function mockNet({ morpho = {}, pendle = {}, morphoFails = false } = {}) {
  const calls = { morpho: [], pendle: [] };
  const impl = async (url, init) => {
    if (String(url).includes('pendle.finance')) {
      calls.pendle.push(String(url));
      const p = pendle[String(url).split('/v1/')[1].split('/')[0]];
      if (p === undefined) return jsonResponse({}, 400);
      if (typeof p === 'number') return jsonResponse({}, p);
      return jsonResponse({ markets: String(url).endsWith('/active') ? p : [] });
    }
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
const ptMarket = { address: LP, expiry: '2030-01-01T00:00:00.000Z', pt: `1-${PT}`, yt: `1-${YT}`, sy: `1-${SY}`, underlyingAsset: `1-${BASE}` };
const EXPIRY = Date.parse('2030-01-01T00:00:00.000Z') / 1000;

function freshDb(tokens = []) {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA_SQL);
  const ins = db.prepare('INSERT INTO markets (unique_key, chain_id, collateral_asset_address) VALUES (?, ?, ?)');
  tokens.forEach(([chain, a], i) => ins.run(`m${i}`, chain, a));
  return db;
}
const rowOf = (db, a, chain = 1) => ({ ...db.prepare('SELECT * FROM token_classes WHERE chain_id = ? AND address = ?').get(chain, a) });
const refresh = (f, db, net, now = NOW) => quiet(() => withFetch(net, () => f(db, now)));

export default {
  TAGS_TTL_SEC: [['доба', ({ TAGS_TTL_SEC: v }) => assert.equal(v, 86400)]],
  PENDLE_TTL_SEC: [['тиждень', ({ PENDLE_TTL_SEC: v }) => assert.equal(v, 604800)]],
  CG_TTL_SEC: [['тиждень', ({ CG_TTL_SEC: v }) => assert.equal(v, 604800)]],
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
  fetchPendleMarkets: [
    ['розбирає pt, yt, sy, LP та базовий актив з expiry в секундах', async ({ fetchPendleMarkets: f }) => {
      const net = mockNet({ pendle: { 1: [ptMarket] } });
      const r = await quiet(() => withFetch(net, () => f(1)));
      assert.deepEqual(r.get(PT), { type: 'PT', expiry: EXPIRY, underlying: BASE });
      assert.equal(r.get(YT).type, 'YT'); assert.equal(r.get(SY).type, 'SY'); assert.equal(r.get(LP).type, 'LP');
      assert.deepEqual(net.calls.pendle.map(u => u.split('/').slice(-3).join('/')), ['1/markets/active', '1/markets/inactive']);
    }],
    ['HTTP 400 (мережа без Pendle) -> null', async ({ fetchPendleMarkets: f }) => {
      assert.equal(await quiet(() => withFetch(mockNet({ pendle: {} }), () => f(130))), null);
    }],
    ['HTTP 500 кидає виняток', async ({ fetchPendleMarkets: f }) => {
      await quiet(() => assert.rejects(withFetch(mockNet({ pendle: { 1: 500 } }), () => f(1)), /500/));
    }],
    ['відповідь без markets кидає виняток', async ({ fetchPendleMarkets: f }) => {
      await quiet(() => assert.rejects(withFetch(async () => jsonResponse({}), () => f(1)), /Malformed/));
    }],
  ],
  familyMedians: [
    ['медіана непарної й парної кількості цін окремо для eth і btc', ({ familyMedians: f }) => {
      const r = f([{ tags: ['eth'], priceUsd: 3000 }, { tags: ['eth', 'lst'], priceUsd: 3600 }, { tags: ['eth'], priceUsd: 1 }, { tags: ['btc'], priceUsd: 60000 }, { tags: ['btc'], priceUsd: 62000 }]);
      assert.deepEqual(r, { eth: 3000, btc: 61000 });
    }],
    ['привʼязані, eth+btc, без ціни, без тегів і з нульовою ціною не враховуються; порожньо -> null', ({ familyMedians: f }) => {
      assert.deepEqual(f([{ tags: ['eth', 'usd-pegged'], priceUsd: 1 }, { tags: ['eth', 'btc'], priceUsd: 5 }, { tags: ['eth'], priceUsd: null }, { tags: null, priceUsd: 9 }, { tags: ['btc'], priceUsd: 0 }]), { eth: null, btc: null });
      assert.deepEqual(f([]), { eth: null, btc: null });
    }],
  ],
  refreshTokenClasses: [
    ['адреси в нижньому регістрі, токен відсутній у відповіді -> рядок null і UNKNOWN', async ({ refreshTokenClasses: f }) => {
      const db = freshDb([[1, mixed(WETH)], [1, UNSEEN]]);
      const stats = await refresh(f, db, mockNet({ pendle: { 1: [] }, morpho: { 1: { [WETH]: { tags: ['eth'], priceUsd: 3000 } } } }));
      assert.deepEqual(db.prepare('SELECT address FROM token_classes ORDER BY address').all().map(r => r.address), [WETH, UNSEEN]);
      const missing = rowOf(db, UNSEEN);
      assert.equal(missing.tags_json, 'null'); assert.equal(missing.pendle_json, 'null'); assert.equal(missing.derived_class, 'UNKNOWN');
      assert.equal(rowOf(db, WETH).tags_json, '["eth"]'); assert.equal(stats.tagsFetched, 2); assert.deepEqual(stats.failed, []);
    }],
    ['порожні адреси ринків ігноруються', async ({ refreshTokenClasses: f }) => {
      const db = freshDb([[1, ''], [1, null]]);
      const stats = await refresh(f, db, mockNet());
      assert.equal(db.prepare('SELECT COUNT(*) c FROM token_classes').get().c, 0); assert.equal(stats.derived, 0);
    }],
    ['класи за тегами: ETH за ціною відносно медіани сімʼї, підробка з ціною 1 -> OTHER, stablecoin -> STABLE', async ({ refreshTokenClasses: f }) => {
      const db = freshDb([[1, WETH], [1, WSTETH], [1, FAKE], [1, USDC]]);
      await refresh(f, db, mockNet({ pendle: { 1: [] }, morpho: { 1: {
        [WETH]: { tags: ['eth'], priceUsd: 3000 }, [WSTETH]: { tags: ['eth', 'lst'], priceUsd: 3600 },
        [FAKE]: { tags: ['eth'], priceUsd: 1 }, [USDC]: { tags: ['stablecoin', 'usd-pegged'], priceUsd: 1 }
      } } }));
      assert.deepEqual([WETH, WSTETH, FAKE, USDC].map(a => rowOf(db, a).derived_class), ['ETH', 'ETH', 'OTHER', 'STABLE']);
      assert.equal(rowOf(db, WETH).source, 'morpho-tags');
    }],
    ['PT: Pendle розпізнає токен, теги бази запитуються, клас бази і дата у рядку PT', async ({ refreshTokenClasses: f }) => {
      const db = freshDb([[1, PT], [1, YT]]);
      const net = mockNet({ pendle: { 1: [ptMarket] }, morpho: { 1: { [PT]: { tags: ['eth'], priceUsd: 2900 }, [BASE]: { tags: ['eth', 'lst'], priceUsd: 3000 } } } });
      await refresh(f, db, net);
      assert.ok(net.calls.morpho.some(c => c.asked.includes(BASE)));
      const pt = rowOf(db, PT);
      assert.equal(pt.derived_class, 'PT'); assert.equal(pt.underlying_class, 'ETH'); assert.equal(pt.source, 'pendle'); assert.equal(pt.maturity, EXPIRY);
      assert.equal(rowOf(db, YT).derived_class, 'OTHER'); assert.equal(rowOf(db, BASE).derived_class, 'ETH');
    }],
    ['PT без даних про базу -> underlying_class UNKNOWN', async ({ refreshTokenClasses: f }) => {
      const db = freshDb([[1, PT]]);
      await refresh(f, db, mockNet({ pendle: { 1: [ptMarket] }, morphoFails: true }));
      const pt = rowOf(db, PT); assert.equal(pt.derived_class, 'PT'); assert.equal(pt.underlying_class, 'UNKNOWN');
    }],
    ['Pendle 400 для мережі -> рядок null усім токенам мережі, теги працюють', async ({ refreshTokenClasses: f }) => {
      const db = freshDb([[130, USDC]]);
      const stats = await refresh(f, db, mockNet({ pendle: {}, morpho: { 130: { [USDC]: { tags: ['stablecoin'], priceUsd: 1 } } } }));
      const r = rowOf(db, USDC, 130);
      assert.equal(r.pendle_json, 'null'); assert.equal(r.derived_class, 'STABLE'); assert.equal(stats.pendleChains, 1); assert.deepEqual(stats.failed, []);
    }],
    ['свіжі токени не запитуються повторно, прострочені запитуються', async ({ refreshTokenClasses: f }) => {
      const db = freshDb([[1, WETH]]);
      const morpho = { 1: { [WETH]: { tags: ['eth'], priceUsd: 3000 } } };
      const counts = async (now) => {
        const net = mockNet({ pendle: { 1: [] }, morpho });
        await refresh(f, db, net, now);
        return [net.calls.morpho.length, net.calls.pendle.length];
      };
      assert.deepEqual(await counts(NOW), [1, 2]);
      assert.deepEqual(await counts(NOW + 3600), [0, 0]);
      assert.deepEqual(await counts(NOW + 86400 + 1), [1, 0]);
      assert.deepEqual(await counts(NOW + 7 * 86400 + 86400 + 2), [1, 2]);
    }],
    ['збій Morpho і Pendle зберігає старі tags_json, pendle_json і клас', async ({ refreshTokenClasses: f }) => {
      const db = freshDb([[1, WETH], [1, WSTETH]]);
      const morpho = { 1: { [WETH]: { tags: ['eth'], priceUsd: 3000 }, [WSTETH]: { tags: ['eth', 'lst'], priceUsd: 3600 } } };
      await refresh(f, db, mockNet({ pendle: { 1: [] }, morpho }));
      const before = rowOf(db, WSTETH);
      const later = NOW + 8 * 86400;
      const stats = await refresh(f, db, mockNet({ pendle: { 1: 500 }, morphoFails: true }), later);
      assert.deepEqual(stats.failed.sort(), ['pendle:1', 'tags:1']);
      assert.deepEqual(rowOf(db, WSTETH), { ...before, derived_at: later });
      assert.equal(rowOf(db, WSTETH).derived_class, 'ETH');
    }],
    ['без кешу і зі збоєм джерел -> UNKNOWN', async ({ refreshTokenClasses: f }) => {
      const db = freshDb([[1, WETH]]);
      const stats = await refresh(f, db, mockNet({ pendle: { 1: 500 }, morphoFails: true }));
      const r = rowOf(db, WETH);
      assert.equal(r.derived_class, 'UNKNOWN'); assert.equal(r.tags_json, null); assert.equal(r.tags_fetched_at, null);
      assert.deepEqual(stats.failed.sort(), ['pendle:1', 'tags:1']);
    }],
    ['токен з eth-тегом без медіани сімʼї зберігає попередній клас', async ({ refreshTokenClasses: f }) => {
      const db = freshDb([[1, WETH]]);
      await refresh(f, db, mockNet({ pendle: { 1: [] }, morpho: { 1: { [WETH]: { tags: ['eth'], priceUsd: null } } } }));
      const r = rowOf(db, WETH); assert.equal(r.derived_class, 'UNKNOWN'); assert.equal(r.derived_at, null);
    }],
  ],
};
