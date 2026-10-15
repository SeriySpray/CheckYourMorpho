import assert from 'node:assert/strict';
import { CONFIG } from '../../server/config.js';
import { withFetch, jsonResponse } from '../fixtures.js';

// Без ретраїв, щоб помилкові сценарії не чекали на backoff; мережа підмінена.
async function noRetries(fn) {
  const saved = CONFIG.api.maxRetries; CONFIG.api.maxRetries = 0;
  const warn = console.warn; console.warn = () => {};
  try { return await fn(); } finally { CONFIG.api.maxRetries = saved; console.warn = warn; }
}

export default {
  fetchMorphoGraphQL: [
    ['повертає json.data при успіху', async ({ fetchMorphoGraphQL: f }) => {
      const data = await withFetch(async () => jsonResponse({ data: { ok: 1 } }), () => f('query'));
      assert.deepEqual(data, { ok: 1 });
    }],
    ['надсилає query і variables у тілі POST', async ({ fetchMorphoGraphQL: f }) => {
      let body;
      await withFetch(async (_u, init) => { body = JSON.parse(init.body); return jsonResponse({ data: {} }); }, () => f('q', { a: 1 }));
      assert.deepEqual(body, { query: 'q', variables: { a: 1 } });
    }],
    ['часткова відповідь (errors + data) повертає data', async ({ fetchMorphoGraphQL: f }) => {
      const data = await noRetries(() => withFetch(async () => jsonResponse({ data: { x: 1 }, errors: [{ message: 'p' }] }), () => f('q')));
      assert.deepEqual(data, { x: 1 });
    }],
    ['фатальна GraphQL-помилка не ретраїться', async ({ fetchMorphoGraphQL: f }) => {
      let calls = 0;
      await assert.rejects(noRetries(() => withFetch(async () => { calls++; return jsonResponse({ errors: [{ message: 'bad field' }] }); }, () => f('q'))), /Fatal GraphQL Error: bad field/);
      assert.equal(calls, 1);
    }],
    ['HTTP 500 після вичерпання ретраїв -> помилка', async ({ fetchMorphoGraphQL: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse({}, 500), () => f('q'))), /failed after 0 retries: HTTP 500/);
    }],
    ['HTTP 429 -> помилка rate limit', async ({ fetchMorphoGraphQL: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse({}, 429), () => f('q'))), /rate limit/);
    }],
  ],
  fetchPaginatedVaults: [
    ['збирає одну неповну сторінку', async ({ fetchPaginatedVaults: f }) => {
      const page = { data: { vs: { items: [{ a: 1 }], pageInfo: { countTotal: 1 } } } };
      const r = await withFetch(async () => jsonResponse(page), () => f('q', 'vs', {}, 10, () => true));
      assert.deepEqual(r, [{ a: 1 }]);
    }],
    ['неповний елемент -> помилка Incomplete', async ({ fetchPaginatedVaults: f }) => {
      const page = { data: { vs: { items: [{ address: '0x1' }], pageInfo: { countTotal: 1 } } } };
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse(page), () => f('q', 'vs', {}, 10, () => false))), /Incomplete vs item 0x1/);
    }],
    ['відсутній countTotal -> помилка', async ({ fetchPaginatedVaults: f }) => {
      const page = { data: { vs: { items: [], pageInfo: {} } } };
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse(page), () => f('q', 'vs', {}, 10, () => true))), /Missing countTotal/);
    }],
    ['пагінація: друга сторінка запитується зі skip', async ({ fetchPaginatedVaults: f }) => {
      const skips = []; const saved = CONFIG.api.pageThrottleMs; CONFIG.api.pageThrottleMs = 0;
      const impl = async (_u, init) => {
        const { skip } = JSON.parse(init.body).variables; skips.push(skip);
        return jsonResponse({ data: { vs: { items: skip === 0 ? [{ i: 1 }, { i: 2 }] : [{ i: 3 }], pageInfo: { countTotal: 3 } } } });
      };
      try {
        const r = await withFetch(impl, () => f('q', 'vs', {}, 2, () => true));
        assert.deepEqual(skips, [0, 2]); assert.equal(r.length, 3);
      } finally { CONFIG.api.pageThrottleMs = saved; }
    }],
  ],
  fetchAllVaults: [
    ['некоректна відповідь -> Malformed vaults', async ({ fetchAllVaults: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse({ data: {} }), () => f())), /Malformed vaults/);
    }],
    ['порожня повна сторінка -> порожній список', async ({ fetchAllVaults: f }) => {
      const r = await noRetries(() => withFetch(async () => jsonResponse({ data: { vaults: { items: [], pageInfo: { countTotal: 0 } } } }), () => f()));
      assert.deepEqual(r, []);
    }],
    ['countTotal більший за отримане -> помилка неповного завантаження', async ({ fetchAllVaults: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse({ data: { vaults: { items: [], pageInfo: { countTotal: 5 } } } }), () => f())), /Incomplete vaults fetch/);
    }],
  ],
  fetchAllVaultV2s: [
    ['некоректна відповідь -> Malformed vaultV2s', async ({ fetchAllVaultV2s: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse({ data: {} }), () => f())), /Malformed vaultV2s/);
    }],
    ['порожня повна сторінка -> порожній список', async ({ fetchAllVaultV2s: f }) => {
      const r = await noRetries(() => withFetch(async () => jsonResponse({ data: { vaultV2s: { items: [], pageInfo: { countTotal: 0 } } } }), () => f()));
      assert.deepEqual(r, []);
    }],
  ],
  fetchCuratorDirectory: [
    ['будує мапу адреса -> ім\'я і додає HyperEVM', async ({ fetchCuratorDirectory: f }) => {
      const m = await withFetch(async () => jsonResponse({ data: { curators: { items: [{ name: 'Gauntlet', addresses: [{ address: '0xABC' }] }] } } }), () => f());
      assert.equal(m.get('0xabc'), 'Gauntlet'); assert.equal(m.get('0xdd00059904ddf45e30b4131345957f76f26b8f6c'), 'HyperEVM');
    }],
    ['мережева помилка -> порожня Map', async ({ fetchCuratorDirectory: f }) => {
      const m = await noRetries(() => withFetch(async () => jsonResponse({}, 500), () => f()));
      assert.equal(m.size, 0);
    }],
  ],
};
