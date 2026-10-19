import assert from 'node:assert/strict';
import { CONFIG } from '../../server/config.js';
import { withFetch, jsonResponse } from '../fixtures.js';

// Без ретраїв, щоб помилкові сценарії не чекали на backoff; мережа підмінена.
async function noRetries(fn) {
  const saved = CONFIG.api.maxRetries; CONFIG.api.maxRetries = 0;
  const warn = console.warn; console.warn = () => {};
  try { return await fn(); } finally { CONFIG.api.maxRetries = saved; console.warn = warn; }
}

// Ретраї без реального очікування: усі setTimeout, крім таймера запиту (timeoutMs), спрацьовують одразу,
// а їхні затримки записуються в delays, щоб перевіряти backoff.
async function fastTimers({ retries = 3, timeoutMs = 15001 } = {}, fn) {
  const real = globalThis.setTimeout, delays = [];
  const saved = { r: CONFIG.api.maxRetries, t: CONFIG.api.requestTimeoutMs, p: CONFIG.api.pageThrottleMs };
  CONFIG.api.maxRetries = retries; CONFIG.api.requestTimeoutMs = timeoutMs; CONFIG.api.pageThrottleMs = 0;
  globalThis.setTimeout = (cb, ms, ...a) => {
    if (ms === timeoutMs) return real(cb, ms, ...a);
    delays.push(ms); return real(cb, 0, ...a);
  };
  const warn = console.warn; console.warn = () => {};
  try { return await fn(delays); } finally {
    globalThis.setTimeout = real; console.warn = warn;
    CONFIG.api.maxRetries = saved.r; CONFIG.api.requestTimeoutMs = saved.t; CONFIG.api.pageThrottleMs = saved.p;
  }
}

// Послідовність відповідей: i-й виклик отримує seq[i] (останній повторюється).
function sequence(seq) {
  const s = { calls: 0 };
  s.impl = async (...args) => { const r = seq[Math.min(s.calls++, seq.length - 1)]; return typeof r === 'function' ? r(...args) : r; };
  return s;
}

const page = (key, items, countTotal = items.length) => jsonResponse({ data: { [key]: { items, pageInfo: { countTotal } } } });

export default {
  fetchMorphoGraphQL: [
    ['повертає json.data при успіху', async ({ fetchMorphoGraphQL: f }) => {
      const data = await withFetch(async () => jsonResponse({ data: { ok: 1 } }), () => f('query'));
      assert.deepEqual(data, { ok: 1 });
    }],
    ['надсилає query і variables у тілі POST на URL з конфігу', async ({ fetchMorphoGraphQL: f }) => {
      let body, url, method;
      await withFetch(async (u, init) => { url = u; method = init.method; body = JSON.parse(init.body); return jsonResponse({ data: {} }); }, () => f('q', { a: 1 }));
      assert.deepEqual(body, { query: 'q', variables: { a: 1 } }); assert.equal(url, CONFIG.api.morphoGraphqlUrl); assert.equal(method, 'POST');
    }],
    ['часткова відповідь (errors + data) повертає data', async ({ fetchMorphoGraphQL: f }) => {
      const data = await noRetries(() => withFetch(async () => jsonResponse({ data: { x: 1 }, errors: [{ message: 'p' }] }), () => f('q')));
      assert.deepEqual(data, { x: 1 });
    }],
    ['порожній масив errors з data -> data', async ({ fetchMorphoGraphQL: f }) => {
      const data = await noRetries(() => withFetch(async () => jsonResponse({ data: { y: 2 }, errors: [] }), () => f('q')));
      assert.deepEqual(data, { y: 2 });
    }],
    ['фатальна GraphQL-помилка не ретраїться навіть при maxRetries = 3 (рівно 1 запит)', async ({ fetchMorphoGraphQL: f }) => {
      const s = sequence([jsonResponse({ errors: [{ message: 'bad field' }], data: null })]);
      await fastTimers({ retries: 3 }, () => assert.rejects(withFetch(s.impl, () => f('q')), /Fatal GraphQL Error: bad field/));
      assert.equal(s.calls, 1);
    }],
    ['перехідна GraphQL-помилка (Rate limited / TIMEOUT / try again / overloaded) ретраїться, потім data', async ({ fetchMorphoGraphQL: f }) => {
      for (const message of ['Rate limited', 'Upstream TIMEOUT', 'please Try Again', 'Service overloaded']) {
        const s = sequence([jsonResponse({ errors: [{ message }] }), jsonResponse({ data: { ok: message } })]);
        const data = await fastTimers({ retries: 3 }, () => withFetch(s.impl, () => f('q')));
        assert.deepEqual(data, { ok: message }); assert.equal(s.calls, 2, message);
      }
    }],
    ['перехідна помилка, що не минає: maxRetries + 1 запитів і помилка Transient', async ({ fetchMorphoGraphQL: f }) => {
      const s = sequence([jsonResponse({ errors: [{ message: 'timeout' }] })]);
      await fastTimers({ retries: 2 }, () => assert.rejects(withFetch(s.impl, () => f('q')), /failed after 2 retries: Transient GraphQL Error: timeout/));
      assert.equal(s.calls, 3);
    }],
    ['HTTP 500 після вичерпання ретраїв -> помилка', async ({ fetchMorphoGraphQL: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse({}, 500), () => f('q'))), /failed after 0 retries: HTTP 500/);
    }],
    ['стійкий HTTP 500 при maxRetries = 2: рівно 3 запити, backoff 2-2.5 с і 4-4.5 с', async ({ fetchMorphoGraphQL: f }) => {
      const s = sequence([jsonResponse({}, 500)]);
      const delays = await fastTimers({ retries: 2 }, async d => {
        await assert.rejects(withFetch(s.impl, () => f('q')), /failed after 2 retries: HTTP 500/); return d;
      });
      assert.equal(s.calls, 3); assert.equal(delays.length, 2);
      assert.ok(delays[0] >= 2000 && delays[0] < 2500, `перша пауза ${delays[0]}`);
      assert.ok(delays[1] >= 4000 && delays[1] < 4500, `друга пауза ${delays[1]}`);
    }],
    ['HTTP 500, потім успіх -> data', async ({ fetchMorphoGraphQL: f }) => {
      const s = sequence([jsonResponse({}, 500), jsonResponse({ data: { ok: 1 } })]);
      assert.deepEqual(await fastTimers({ retries: 1 }, () => withFetch(s.impl, () => f('q'))), { ok: 1 });
    }],
    ['невалідний JSON ретраїться, потім data', async ({ fetchMorphoGraphQL: f }) => {
      const bad = { ok: true, status: 200, statusText: '200', headers: new Headers(), json: async () => { throw new SyntaxError('Unexpected token <'); } };
      const s = sequence([bad, jsonResponse({ data: { ok: 1 } })]);
      assert.deepEqual(await fastTimers({ retries: 1 }, () => withFetch(s.impl, () => f('q'))), { ok: 1 }); assert.equal(s.calls, 2);
    }],
    ['HTTP 429 -> помилка rate limit', async ({ fetchMorphoGraphQL: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse({}, 429), () => f('q'))), /rate limit/);
    }],
    ['429 з Retry-After: 2 чекає рівно 2000 мс, потім повертає data', async ({ fetchMorphoGraphQL: f }) => {
      const s = sequence([jsonResponse({}, 429, { 'Retry-After': '2' }), jsonResponse({ data: { ok: 1 } })]);
      const [data, delays] = await fastTimers({ retries: 3 }, async d => [await withFetch(s.impl, () => f('q')), d]);
      assert.deepEqual(data, { ok: 1 }); assert.deepEqual(delays, [2000]); assert.equal(s.calls, 2);
    }],
    ['429 без Retry-After: експоненційний backoff 2-2.5 с, потім 4-4.5 с', async ({ fetchMorphoGraphQL: f }) => {
      const s = sequence([jsonResponse({}, 429), jsonResponse({}, 429), jsonResponse({ data: { ok: 1 } })]);
      const delays = await fastTimers({ retries: 3 }, async d => { await withFetch(s.impl, () => f('q')); return d; });
      assert.equal(delays.length, 2);
      assert.ok(delays[0] >= 2000 && delays[0] < 2500, `перша пауза ${delays[0]}`);
      assert.ok(delays[1] >= 4000 && delays[1] < 4500, `друга пауза ${delays[1]}`);
    }],
    ['стійкий 429 при maxRetries = 2: 3 запити і помилка rate limit', async ({ fetchMorphoGraphQL: f }) => {
      const s = sequence([jsonResponse({}, 429)]);
      await fastTimers({ retries: 2 }, () => assert.rejects(withFetch(s.impl, () => f('q')), /rate limit \(429\) exceeded after 2 retries/));
      assert.equal(s.calls, 3);
    }],
    ['завислий запит обривається за requestTimeoutMs і ретраїться, друга спроба повертає data', async ({ fetchMorphoGraphQL: f }) => {
      const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
      const s = sequence([hang, jsonResponse({ data: { ok: 1 } })]);
      let t;
      const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('таймаут запиту не спрацював за 3 с')), 3000); });
      try {
        const data = await Promise.race([fastTimers({ retries: 1, timeoutMs: 20 }, () => withFetch(s.impl, () => f('q'))), guard]);
        assert.deepEqual(data, { ok: 1 }); assert.equal(s.calls, 2);
      } finally { clearTimeout(t); }
    }],
  ],
  fetchPaginatedVaults: [
    ['збирає одну неповну сторінку', async ({ fetchPaginatedVaults: f }) => {
      const r = await withFetch(async () => page('vs', [{ a: 1 }]), () => f('q', 'vs', {}, 10, () => true));
      assert.deepEqual(r, [{ a: 1 }]);
    }],
    ['передає first, skip і where у змінних запиту', async ({ fetchPaginatedVaults: f }) => {
      let vars;
      await withFetch(async (_u, init) => { vars = JSON.parse(init.body).variables; return page('vs', []); }, () => f('q', 'vs', { listed: true }, 7, () => true));
      assert.deepEqual(vars, { first: 7, skip: 0, where: { listed: true } });
    }],
    ['неповний елемент -> помилка Incomplete', async ({ fetchPaginatedVaults: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => page('vs', [{ address: '0x1' }]), () => f('q', 'vs', {}, 10, () => false))), /Incomplete vs item 0x1/);
    }],
    ['відсутній countTotal -> помилка', async ({ fetchPaginatedVaults: f }) => {
      const p = { data: { vs: { items: [], pageInfo: {} } } };
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse(p), () => f('q', 'vs', {}, 10, () => true))), /Missing countTotal/);
    }],
    ['items не масив -> помилка Malformed', async ({ fetchPaginatedVaults: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse({ data: { vs: { items: null, pageInfo: { countTotal: 0 } } } }), () => f('q', 'vs', {}, 10, () => true))), /Malformed vs response/);
    }],
    ['отримано на 1 елемент менше за countTotal -> помилка неповного завантаження', async ({ fetchPaginatedVaults: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => page('vs', [{ i: 1 }, { i: 2 }], 3), () => f('q', 'vs', {}, 10, () => true))), /Incomplete vs fetch: got 2 of 3/);
    }],
    ['пагінація: друга сторінка запитується зі skip', async ({ fetchPaginatedVaults: f }) => {
      const skips = []; const saved = CONFIG.api.pageThrottleMs; CONFIG.api.pageThrottleMs = 0;
      const impl = async (_u, init) => {
        const { skip } = JSON.parse(init.body).variables; skips.push(skip);
        return page('vs', skip === 0 ? [{ i: 1 }, { i: 2 }] : [{ i: 3 }], 3);
      };
      try {
        const r = await withFetch(impl, () => f('q', 'vs', {}, 2, () => true));
        assert.deepEqual(skips, [0, 2]); assert.equal(r.length, 3);
      } finally { CONFIG.api.pageThrottleMs = saved; }
    }],
    ['кількість кратна розміру сторінки (4 по 2): skip 0 і 2 (зайвої порожньої сторінки немає), рівно 4 елементи в порядку', async ({ fetchPaginatedVaults: f }) => {
      const skips = [], all = [1, 2, 3, 4].map(i => ({ i }));
      const impl = async (_u, init) => {
        const { skip, first } = JSON.parse(init.body).variables; skips.push(skip);
        return page('vs', all.slice(skip, skip + first), 4);
      };
      const r = await fastTimers({}, () => withFetch(impl, () => f('q', 'vs', {}, 2, () => true)));
      assert.deepEqual(skips, [0, 2]); assert.deepEqual(r, all);
    }],
    ['API ігнорує skip і віддає повні сторінки: пагінація зупиняється на countTotal, а не зациклюється', async ({ fetchPaginatedVaults: f }) => {
      let calls = 0;
      const impl = async () => {
        if (++calls > 5) throw new Error(`зациклення пагінації: ${calls} запитів при countTotal = 2`);
        return page('vs', [{ i: 1 }, { i: 2 }], 2);
      };
      const r = await fastTimers({ retries: 0 }, () => withFetch(impl, () => f('q', 'vs', {}, 2, () => true)));
      assert.equal(r.length, 2);
    }],
  ],
  fetchAllVaults: [
    ['некоректна відповідь -> Malformed vaults', async ({ fetchAllVaults: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse({ data: {} }), () => f())), /Malformed vaults/);
    }],
    ['порожня повна сторінка -> порожній список', async ({ fetchAllVaults: f }) => {
      const r = await noRetries(() => withFetch(async () => page('vaults', []), () => f()));
      assert.deepEqual(r, []);
    }],
    ['countTotal більший за отримане -> помилка неповного завантаження', async ({ fetchAllVaults: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => page('vaults', [], 5), () => f())), /Incomplete vaults fetch/);
    }],
    ['фільтр listed: true, сторінка 100; chainId_in лише коли мережі задано', async ({ fetchAllVaults: f }) => {
      const vars = [];
      const impl = async (_u, init) => { vars.push(JSON.parse(init.body).variables); return page('vaults', []); };
      await withFetch(impl, async () => { await f(); await f([1, 8453]); await f([]); });
      assert.deepEqual(vars.map(v => v.where), [{ listed: true }, { listed: true, chainId_in: [1, 8453] }, { listed: true }]);
      assert.equal(vars[0].first, 100);
    }],
    ['vault без state або asset -> помилка Incomplete (часткова відповідь)', async ({ fetchAllVaults: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => page('vaults', [{ address: '0xa', asset: {} }]), () => f())), /Incomplete vaults item 0xa/);
      await assert.rejects(noRetries(() => withFetch(async () => page('vaults', [{ address: '0xb', state: {} }]), () => f())), /Incomplete vaults item 0xb/);
    }],
    ['vault без chain.id -> помилка Incomplete, а не мовчазна Ethereum', async ({ fetchAllVaults: f }) => {
      const item = { address: '0xc', state: {}, asset: {} };
      await assert.rejects(noRetries(() => withFetch(async () => page('vaults', [item]), () => f())), /Incomplete vaults item 0xc/);
      assert.equal((await noRetries(() => withFetch(async () => page('vaults', [{ ...item, chain: { id: 8453 } }]), () => f()))).length, 1);
    }],
  ],
  fetchAllVaultV2s: [
    ['некоректна відповідь -> Malformed vaultV2s', async ({ fetchAllVaultV2s: f }) => {
      await assert.rejects(noRetries(() => withFetch(async () => jsonResponse({ data: {} }), () => f())), /Malformed vaultV2s/);
    }],
    ['порожня повна сторінка -> порожній список', async ({ fetchAllVaultV2s: f }) => {
      const r = await noRetries(() => withFetch(async () => page('vaultV2s', []), () => f()));
      assert.deepEqual(r, []);
    }],
    ['сторінка по 10 (ліміт складності запиту), фільтр listed: true і chainId_in', async ({ fetchAllVaultV2s: f }) => {
      let vars;
      await withFetch(async (_u, init) => { vars = JSON.parse(init.body).variables; return page('vaultV2s', []); }, () => f([999]));
      assert.equal(vars.first, 10); assert.deepEqual(vars.where, { listed: true, chainId_in: [999] });
    }],
    ['V2 без totalAssets, caps, adapters, asset або chain -> помилка Incomplete; totalAssets "0" допустимий', async ({ fetchAllVaultV2s: f }) => {
      const ok = { address: '0xok', asset: {}, chain: { id: 1 }, totalAssets: '0', caps: { items: [] }, adapters: { items: [] } };
      for (const miss of ['asset', 'chain', 'totalAssets', 'caps', 'adapters']) {
        const item = { ...ok, address: `0x${miss}`, [miss]: null };
        await assert.rejects(noRetries(() => withFetch(async () => page('vaultV2s', [item]), () => f())), new RegExp(`Incomplete vaultV2s item 0x${miss}`));
      }
      assert.equal((await noRetries(() => withFetch(async () => page('vaultV2s', [ok]), () => f()))).length, 1);
    }],
  ],
  fetchCuratorDirectory: [
    ['будує мапу адреса -> ім\'я і додає HyperEVM', async ({ fetchCuratorDirectory: f }) => {
      const m = await withFetch(async () => jsonResponse({ data: { curators: { items: [{ name: 'Gauntlet', addresses: [{ address: '0xABC' }] }] } } }), () => f());
      assert.equal(m.get('0xabc'), 'Gauntlet'); assert.equal(m.get('0xdd00059904ddf45e30b4131345957f76f26b8f6c'), 'HyperEVM');
    }],
    ['кілька адрес одного куратора; куратор без імені і порожні адреси пропускаються', async ({ fetchCuratorDirectory: f }) => {
      const items = [
        { name: 'Steakhouse', addresses: [{ address: '0xA1' }, { address: '0xA2' }, null, { address: '' }] },
        { name: '', addresses: [{ address: '0xB1' }] },
        { name: 'NoAddr' }
      ];
      const m = await withFetch(async () => jsonResponse({ data: { curators: { items } } }), () => f());
      assert.deepEqual([...m.entries()].sort(), [['0xa1', 'Steakhouse'], ['0xa2', 'Steakhouse'], ['0xdd00059904ddf45e30b4131345957f76f26b8f6c', 'HyperEVM']]);
    }],
    ['повна сторінка (100) тягне наступну: skip 0 і 100, усі 101 куратор у мапі', async ({ fetchCuratorDirectory: f }) => {
      const skips = [];
      const mk = (n, from) => Array.from({ length: n }, (_, i) => ({ name: `C${from + i}`, addresses: [{ address: `0xc${from + i}` }] }));
      const impl = async (_u, init) => {
        const { skip } = JSON.parse(init.body).variables; skips.push(skip);
        return jsonResponse({ data: { curators: { items: skip === 0 ? mk(100, 0) : mk(1, 100) } } });
      };
      const m = await withFetch(impl, () => f());
      assert.deepEqual(skips, [0, 100]); assert.equal(m.size, 102); assert.equal(m.get('0xc100'), 'C100');
    }],
    ['мережева помилка -> порожня Map без винятку', async ({ fetchCuratorDirectory: f }) => {
      const m = await noRetries(() => withFetch(async () => jsonResponse({}, 500), () => f()));
      assert.equal(m.size, 0);
    }],
  ],
};
