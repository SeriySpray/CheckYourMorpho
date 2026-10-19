import assert from 'node:assert/strict';
import { makeElement, makeClassList } from '../clientEnv.js';
import { jsonResponse } from '../fixtures.js';

// Справжній таймер для очікувань усередині кейсу (глобальний setTimeout у кейсах підмінюється).
const realSetTimeout = globalThis.setTimeout;
const sleep = ms => new Promise(r => realSetTimeout(r, ms));
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const DEFAULT_FILTERS = { query: '', network: 'all', asset: 'all', curator: 'all', sort: 'tvl_desc', pinnedOnly: false };
const EXIT_STATE = { normalExitPct: 0, normalExitUsd: 0, stressedExitPct: 0, stressedExitUsd: 0, dropPct: 0, topPeer: '' };
const OVERRIDES = ['addEventListener', 'appendChild', 'querySelector', 'querySelectorAll', 'focus', 'blur', 'click', 'getContext'];

/** Заглушка сфери: записує виклики, щоб перевіряти підсвічування і вибір. */
function sphereStub() {
  const calls = [];
  return {
    calls,
    highlightVault: a => calls.push(['highlight', a]),
    setSelectedVault: a => calls.push(['select', a]),
    getParticleScreenPos: () => ({ x: 100, y: 200, radius: 4 }),
    setVaults: list => calls.push(['setVaults', list.length])
  };
}

/** Елемент, що запамʼятовує обробники подій: el.handlers[type]. */
function capEl(props = {}) {
  const e = makeElement();
  e.handlers = {};
  e.addEventListener = (t, fn) => { e.handlers[t] = fn; };
  return Object.assign(e, props);
}

/** Вузол із підготовленими відповідями на querySelector/querySelectorAll за селектором. */
function fakeNode(map = {}) {
  const e = makeElement();
  e.querySelector = s => map[s] ?? null;
  e.querySelectorAll = s => map[s] ?? [];
  return e;
}

/** Скидає стан app.js і всі DOM-елементи; модалка за замовчуванням закрита, як у index.html. */
function reset(m) {
  const s = m.__state;
  localStorage.clear();
  s.clientAuditCache.clear();
  Object.assign(s.explorerFilters, DEFAULT_FILTERS);
  s.allVaults = []; s.selectedVaultAddress = null; s.activeAuditData = null; s.focusBeforeAudit = null;
  s.auditAbort = null; s.pinnedMemoryFallback = null; s.isTransitioningVault = false; s.isClosingAudit = false;
  s.isPollingActive = false; s.currentModalExitState = { ...EXIT_STATE }; s.sphere = sphereStub();
  s.REDUCED_MOTION.matches = false;
  for (const el of globalThis.__cymClientEnv.elements.values()) {
    for (const k of OVERRIDES) delete el[k];
    delete el.handlers;
    Object.assign(el, {
      classList: makeClassList(), dataset: {}, style: { setProperty() {}, removeProperty() {} },
      textContent: '', innerHTML: '', value: '', title: '', className: '', hidden: false, scrollTop: 0
    });
  }
  s.DOM.auditModal.classList.add('hidden');
}

/**
 * Обгортка кейсу зі станом: скидання, підміна таймерів (виконуються лише вручну через env.flush),
 * fetch, Date.now, document і глобальних методів; усе відновлюється у finally.
 */
const T = (title, body) => [title, async m => {
  reset(m);
  const saved = {
    fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval, now: Date.now,
    addEventListener: globalThis.addEventListener, innerWidth: globalThis.innerWidth, doc: { ...document },
    getItem: localStorage.getItem, setItem: localStorage.setItem, Image: globalThis.Image, sphere: globalThis.sphere,
    warn: console.warn, error: console.error
  };
  const timers = [];
  let id = 0;
  globalThis.setTimeout = (fn, ms = 0) => { timers.push({ id: ++id, fn, ms, kind: 'timeout' }); return id; };
  globalThis.setInterval = (fn, ms) => { timers.push({ id: ++id, fn, ms, kind: 'interval' }); return id; };
  globalThis.clearTimeout = globalThis.clearInterval = x => {
    const i = timers.findIndex(t => t.id === x);
    if (i >= 0) timers.splice(i, 1);
  };
  const fetched = [];
  const env = {
    timers, fetched,
    quiet() { console.warn = console.error = () => {}; }, // очікувані повідомлення про помилки не засмічують вивід
    flush(limit = 50) {
      for (let n = 0; n < limit; n++) {
        const i = timers.findIndex(t => t.kind === 'timeout');
        if (i < 0) return;
        timers.splice(i, 1)[0].fn();
      }
    },
    // handler(url, opts) повертає відповідь або кидає; усі URL записуються в env.fetched
    fetch(handler) { globalThis.fetch = async (url, opts) => { fetched.push(url); return handler(url, opts); }; }
  };
  try {
    await body(m, env);
  } finally {
    Object.assign(globalThis, {
      fetch: saved.fetch, setTimeout: saved.setTimeout, setInterval: saved.setInterval, clearTimeout: saved.clearTimeout,
      clearInterval: saved.clearInterval, addEventListener: saved.addEventListener, innerWidth: saved.innerWidth, Image: saved.Image
    });
    if (saved.sphere === undefined) delete globalThis.sphere; else globalThis.sphere = saved.sphere;
    Date.now = saved.now;
    console.warn = saved.warn; console.error = saved.error;
    Object.assign(document, saved.doc);
    localStorage.getItem = saved.getItem; localStorage.setItem = saved.setItem;
    reset(m);
  }
}];

// Клієнтський vault (camelCase, як у /api/vaults) і повний аудит (/api/vaults/:address)
const cv = (over = {}) => ({
  address: '0xAAA1', name: 'Steakhouse USDC', chainId: 1, version: 'v1', isListed: true, curatorName: 'Steakhouse',
  asset: { symbol: 'USDC', decimals: 6, priceUsd: 1 }, totalAssetsUsd: 10e6, totalAssets: '10000000000000',
  liquidityUsd: 4e6, netApy: 0.05, fee: 0.1, mqiPercent: 100, isAllClean: true, exitCapPercent: 40, ...over
});
const verdictOf = (over = {}) => ({
  mqi: { mqiPercent: 100, isAllClean: true, compromisedMarkets: [], compromisedPercent: 0, unverifiedPercent: 0, unpriced: false, ...over.mqi },
  liquidity: { instantExitCapacityPercent: 40, instantExitCapacityUsd: 4e6, stressedExitCapacityPercent: 40, stressedExitCapacityUsd: 4e6, ...over.liquidity },
  hhi: {
    hhi: 0.25, tier: 'MODERATE', tierLabel: 'Moderate', effectiveAssets: 4, topCollateral: { symbol: 'WETH', sharePercent: 50 },
    breakdown: [{ symbol: 'WETH', usd: 5e6, sharePercent: 50 }, { symbol: 'wstETH', usd: 2.5e6, sharePercent: 25 }], ...over.hhi
  },
  redFlags: over.redFlags ?? []
});
const audit = (vaultOver = {}, verdictOver = {}, allocations = []) => ({ vault: cv(vaultOver), verdict: verdictOf(verdictOver), allocations });

/** Збирає елементи, які функція додає в контейнер через appendChild. */
function collect(el) {
  const out = [];
  el.appendChild = n => { out.push(n); };
  return out;
}

/** Рядки, які renderVaultExplorer додає у фрагмент. */
function collectRows() {
  const rows = [];
  document.createDocumentFragment = () => { const f = makeElement(); f.appendChild = n => { rows.push(n); }; return f; };
  return rows;
}

/** Фейкова картка закріпленого vault для applyVaultAuditData. */
function fakePillCard() {
  const badge = makeElement();
  const items = [0, 1, 2].map(() => fakeNode({ '.rich-pill-fin-val': makeElement(), '.rich-pill-fin-sub': makeElement() }));
  const card = fakeNode({ '.rich-pill-mqi-badge': badge, '.rich-pill-fin-item': items });
  const val = i => items[i].querySelector('.rich-pill-fin-val').textContent;
  const sub = i => items[i].querySelector('.rich-pill-fin-sub').textContent;
  return { card, badge, val, sub };
}

/** Фейковий dropdown з пунктами [value, label]. */
function fakeDropdown(filter, entries) {
  const trigger = capEl(), valEl = makeElement(), menu = makeElement();
  valEl.textContent = 'initial';
  const items = entries.map(([value, label]) => {
    const item = capEl();
    item.setAttribute('data-value', value);
    const span = makeElement(); span.textContent = `  ${label}  `;
    item.querySelector = s => (s === '.item-text' ? span : null);
    return item;
  });
  menu.querySelectorAll = s => (s === '.dropdown-item' ? items : []);
  const dd = fakeNode({ '.dropdown-trigger': trigger, '.trigger-value': valEl, '.dropdown-menu': menu, '.dropdown-item': items });
  dd.setAttribute('data-filter', filter);
  return { dd, trigger, valEl, items };
}

const pin = (...addrs) => localStorage.setItem('cym_pinned_vaults', JSON.stringify(addrs));
const pinned = () => JSON.parse(localStorage.getItem('cym_pinned_vaults') || '[]');
const lastCall = (sphere, kind) => sphere.calls.filter(c => c[0] === kind).at(-1);

export default {
  // ---------- Кеш аудитів ----------
  getFreshAudit: [
    T('свіжий запис повертається без урахування регістру адреси', ({ getFreshAudit: f, __state: s }) => {
      const entry = { cachedAt: Date.now() - 1000, vault: {} };
      s.clientAuditCache.set('0xabc', entry);
      assert.equal(f('0xABC'), entry);
    }),
    T('межа TTL 120 с: рівно 120000 мс - застарілий, 119999 - свіжий', ({ getFreshAudit: f, __state: s }) => {
      Date.now = () => 1e12;
      s.clientAuditCache.set('0xa', { cachedAt: 1e12 - 120000 });
      assert.equal(f('0xa'), null);
      s.clientAuditCache.set('0xa', { cachedAt: 1e12 - 119999 });
      assert.equal(f('0xa').cachedAt, 1e12 - 119999);
    }),
    T('запис без cachedAt вважається застарілим, відсутня адреса -> null', ({ getFreshAudit: f, __state: s }) => {
      s.clientAuditCache.set('0xa', { vault: {} });
      assert.equal(f('0xa'), null);
      for (const bad of [undefined, null, '']) assert.equal(f(bad), null);
    }),
  ],

  // ---------- Запуск ----------
  initApp: [
    T('успішне завантаження: лічильник у шапці, allVaults, сфера і таймер опитування', async (m, env) => {
      const { initApp: f, __state: s } = m;
      globalThis.Image = class {};
      env.quiet();
      s.DOM.sphereCanvas.getContext = () => null; // WebGL недоступний: сфера працює без GPU
      document.getElementById('overlay-canvas').getContext = () => null;
      env.fetch(url => (url.startsWith('/api/vaults?') ? jsonResponse({ vaults: [cv(), cv({ address: '0xBBB2' })] }) : jsonResponse({ stale: false })));
      try {
        await f();
        assert.equal(s.DOM.headerStatusText.textContent, 'Live: 2 Vaults');
        assert.equal(s.allVaults.length, 2);
        assert.equal(globalThis.sphere, s.sphere);
        assert.equal(s.sphere.vaults.length, 2);
        assert.equal(s.DOM.explorerCount.textContent, '2 Vaults');
        assert.deepEqual(env.timers.filter(t => t.kind === 'interval').map(t => t.ms), [60000]);
        assert.ok(env.fetched.includes('/api/status'));
      } finally {
        delete document.getElementById('overlay-canvas').getContext;
      }
    }),
    T('недоступний API: "API Offline", allVaults порожній, опитування все одно запущене', async (m, env) => {
      const { initApp: f, __state: s } = m;
      globalThis.Image = class {};
      env.quiet();
      s.DOM.sphereCanvas.getContext = () => null;
      document.getElementById('overlay-canvas').getContext = () => null;
      try {
        env.fetch(() => { throw new Error('offline'); });
        await f();
        assert.equal(s.DOM.headerStatusText.textContent, 'API Offline');
        assert.deepEqual(s.allVaults, []);
        assert.equal(env.timers.filter(t => t.kind === 'interval').length, 1);
        // HTTP-помилка теж вважається офлайном
        env.fetch(() => jsonResponse({}, 500));
        await f();
        assert.equal(s.DOM.headerStatusText.textContent, 'API Offline');
      } finally {
        delete document.getElementById('overlay-canvas').getContext;
      }
    }),
  ],

  apiFetch: [
    T('передає URL і AbortSignal у fetch та повертає його результат', async ({ apiFetch: f }, env) => {
      let opts;
      env.fetch((url, o) => { opts = o; return 'RESPONSE'; });
      assert.equal(await f('/api/x'), 'RESPONSE');
      assert.deepEqual(env.fetched, ['/api/x']);
      assert.ok(opts.signal instanceof AbortSignal);
      assert.equal(opts.signal.aborted, false);
    }),
    T('cancelSignal скасовує запит разом із таймаутом', async ({ apiFetch: f }, env) => {
      let opts;
      env.fetch((url, o) => { opts = o; return null; });
      const ctrl = new AbortController();
      await f('/api/x', 15000, ctrl.signal);
      assert.equal(opts.signal.aborted, false);
      ctrl.abort();
      assert.equal(opts.signal.aborted, true);
    }),
    T('таймаут обриває сигнал з TimeoutError', async ({ apiFetch: f }, env) => {
      let opts;
      env.fetch((url, o) => { opts = o; return null; });
      await f('/api/x', 5);
      await sleep(40);
      assert.equal(opts.signal.aborted, true);
      assert.equal(opts.signal.reason.name, 'TimeoutError');
    }),
    T('помилка мережі повертається як відхилений проміс', async ({ apiFetch: f }, env) => {
      env.fetch(() => { throw new Error('boom'); });
      await assert.rejects(f('/api/x'), /boom/);
    }),
  ],

  showStatusNotice: [
    T('показує текст одразу, через 4 с повертає лічильник vault', ({ showStatusNotice: f, __state: s }, env) => {
      s.allVaults = [cv(), cv()];
      f('Audit unavailable');
      assert.equal(s.DOM.headerStatusText.textContent, 'Audit unavailable');
      assert.deepEqual(env.timers.map(t => t.ms), [4000]);
      env.flush();
      assert.equal(s.DOM.headerStatusText.textContent, 'Live: 2 Vaults');
    }),
    T('без даних після паузи показує "API Offline"', ({ showStatusNotice: f, __state: s }, env) => {
      f('x');
      env.flush();
      assert.equal(s.DOM.headerStatusText.textContent, 'API Offline');
    }),
  ],

  formatDataAge: [
    T('хвилини, межа 60 хв, години і перехід у дні на 48 год', ({ formatDataAge: f }) => {
      const now = Date.parse('2026-01-10T12:00:00Z');
      Date.now = () => now;
      const ago = ms => new Date(now - ms).toISOString();
      assert.equal(f(ago(0)), '0m ago');
      assert.equal(f(ago(5 * 60000)), '5m ago');
      assert.equal(f(ago(60 * 60000 - 1)), '59m ago');
      assert.equal(f(ago(60 * 60000)), '1h ago');
      assert.equal(f(ago(47 * 3600000)), '47h ago');
      assert.equal(f(ago(48 * 3600000)), '2d ago');
      assert.equal(f(ago(10 * 86400000)), '10d ago');
    }),
    T('час у майбутньому (розсинхрон годинника) -> "0m ago", не відʼємне', ({ formatDataAge: f }) => {
      Date.now = () => Date.parse('2026-01-10T12:00:00Z');
      assert.equal(f('2026-01-10T12:30:00Z'), '0m ago');
    }),
    T('нерозпізнаний час -> порожній рядок', ({ formatDataAge: f }) => {
      for (const bad of [undefined, null, '', 'not a date', NaN]) assert.equal(f(bad), '', String(bad));
    }),
  ],

  refreshStaleIndicator: [
    T('stale === true: індикатор видимий, текст з віком і підказка', async ({ refreshStaleIndicator: f }, env) => {
      Date.now = () => Date.parse('2026-01-10T12:00:00Z');
      const text = makeElement(), ind = makeElement();
      ind.classList.add('hidden');
      ind.querySelector = s => (s === '.stale-text' ? text : null);
      document.querySelectorAll = s => (s === '.stale-indicator' ? [ind] : []);
      env.fetch(() => jsonResponse({ stale: true, lastSuccessAt: '2026-01-10T10:00:00Z' }));
      await f();
      assert.deepEqual(env.fetched, ['/api/status']);
      assert.equal(ind.classList.contains('hidden'), false);
      assert.equal(text.textContent, 'Stale data · last sync 2h ago');
      assert.match(ind.title, /^Last successful sync: /);
    }),
    T('stale без lastSuccessAt: "Stale data" без віку і без підказки', async ({ refreshStaleIndicator: f }, env) => {
      const text = makeElement(), ind = makeElement();
      ind.querySelector = () => text;
      document.querySelectorAll = () => [ind];
      env.fetch(() => jsonResponse({ stale: true }));
      await f();
      assert.equal(text.textContent, 'Stale data');
      assert.equal(ind.title, '');
    }),
    T('stale false, рядок "true", помилка мережі або HTTP 500 -> індикатор прихований', async ({ refreshStaleIndicator: f }, env) => {
      const text = makeElement(), ind = makeElement();
      ind.querySelector = () => text;
      document.querySelectorAll = () => [ind];
      for (const respond of [() => jsonResponse({ stale: false }), () => jsonResponse({ stale: 'true' }),
        () => { throw new Error('offline'); }, () => jsonResponse({ stale: true }, 500)]) {
        text.textContent = 'sentinel'; ind.title = 'sentinel';
        env.fetch(respond);
        await f();
        assert.equal(ind.classList.contains('hidden'), true);
        assert.equal(text.textContent, ''); assert.equal(ind.title, '');
      }
    }),
  ],

  startLivePolling: [
    T('ставить інтервал 60 с, повторний виклик замінює попередній', ({ startLivePolling: f, __state: s }, env) => {
      f();
      const first = s.livePollingTimer;
      assert.deepEqual(env.timers.map(t => [t.kind, t.ms]), [['interval', 60000]]);
      f();
      assert.equal(env.timers.length, 1);
      assert.notEqual(s.livePollingTimer, first);
      assert.equal(env.timers[0].id, s.livePollingTimer);
    }),
    T('опитування оновлює список, лічильник, сферу і зберігає прокрутку', async ({ startLivePolling: f, __state: s }, env) => {
      s.allVaults = [cv()];
      env.fetch(url => (url.startsWith('/api/vaults?') ? jsonResponse({ vaults: [cv(), cv({ address: '0xB' }), cv({ address: '0xC' })] }) : jsonResponse({})));
      f();
      s.DOM.explorerVaultsList.scrollTop = 123;
      await env.timers[0].fn();
      assert.equal(s.allVaults.length, 3);
      assert.equal(s.DOM.headerStatusText.textContent, 'Live: 3 Vaults');
      assert.deepEqual(lastCall(s.sphere, 'setVaults'), ['setVaults', 3]);
      assert.equal(s.DOM.explorerVaultsList.scrollTop, 123);
      assert.equal(s.isPollingActive, false);
    }),
    T('HTTP-помилка або виняток -> "Reconnecting...", старі дані лишаються', async ({ startLivePolling: f, __state: s }, env) => {
      s.allVaults = [cv()];
      f();
      env.fetch(() => jsonResponse({}, 503));
      await env.timers[0].fn();
      assert.equal(s.DOM.headerStatusText.textContent, 'Reconnecting...');
      s.DOM.headerStatusText.textContent = 'x';
      env.fetch(() => { throw new Error('offline'); });
      env.quiet();
      await env.timers[0].fn();
      assert.equal(s.DOM.headerStatusText.textContent, 'Reconnecting...');
      assert.equal(s.allVaults.length, 1);
      assert.equal(s.isPollingActive, false);
    }),
    T('порожній список від API не затирає наявні vault', async ({ startLivePolling: f, __state: s }, env) => {
      s.allVaults = [cv()];
      env.fetch(url => (url.startsWith('/api/vaults?') ? jsonResponse({ vaults: [] }) : jsonResponse({})));
      f();
      await env.timers[0].fn();
      assert.equal(s.allVaults.length, 1);
    }),
    T('прихована вкладка або вже активне опитування -> жодного запиту', async ({ startLivePolling: f, __state: s }, env) => {
      env.fetch(() => jsonResponse({}));
      f();
      document.hidden = true;
      await env.timers[0].fn();
      document.hidden = false;
      s.isPollingActive = true;
      await env.timers[0].fn();
      assert.deepEqual(env.fetched, []);
    }),
    T('оновлює аудити закріплених і відкритого vault', async ({ startLivePolling: f, __state: s }, env) => {
      s.allVaults = [cv({ address: '0xp1' }), cv({ address: '0xopen' })];
      pin('0xp1');
      s.selectedVaultAddress = '0xopen';
      s.DOM.auditModal.classList.remove('hidden');
      env.fetch(url => {
        if (url.startsWith('/api/vaults?')) return jsonResponse({ vaults: s.allVaults });
        if (url === '/api/vaults/0xp1') return jsonResponse(audit({ address: '0xp1' }));
        if (url === '/api/vaults/0xopen') return jsonResponse(audit({ address: '0xopen', name: 'Fresh Name' }));
        return jsonResponse({});
      });
      f();
      await env.timers[0].fn();
      await tick();
      assert.ok(env.fetched.includes('/api/vaults/0xp1'));
      assert.ok(s.clientAuditCache.has('0xp1'));
      assert.equal(s.activeAuditData.vault.name, 'Fresh Name');
      assert.equal(s.DOM.modalVaultName.textContent, 'Fresh Name');
    }),
    T('слухач visibilitychange реєструється лише один раз', ({ startLivePolling: f, __state: s }) => {
      const types = [];
      document.addEventListener = t => types.push(t);
      const was = s.visibilityPollingBound;
      s.visibilityPollingBound = false;
      try {
        f(); f();
        assert.deepEqual(types, ['visibilitychange']);
      } finally { s.visibilityPollingBound = was; }
    }),
  ],

  // ---------- Форматування ----------
  formatChainName: [
    ['усі відомі мережі', ({ formatChainName: f }) => {
      const map = { 1: 'ETH', 8453: 'BASE', 4663: 'ROBINHOOD', 42161: 'ARB', 137: 'POLYGON', 10: 'OP', 747474: 'KATANA',
        999: 'HYPEREVM', 130: 'UNICHAIN', 143: 'MONAD', 480: 'WORLD', 988: 'STABLE', 4217: 'TEMPO', 5042: 'ARC' };
      for (const [id, name] of Object.entries(map)) assert.equal(f(Number(id)), name);
    }],
    ['невідома мережа, рядок замість числа, undefined -> "CHAIN <id>"', ({ formatChainName: f }) => {
      assert.equal(f(12345), 'CHAIN 12345');
      assert.equal(f('1'), 'CHAIN 1');
      assert.equal(f(undefined), 'CHAIN undefined');
      assert.equal(f(-1), 'CHAIN -1');
    }],
  ],
  getChainClass: [
    ['CSS-класи відомих мереж', ({ getChainClass: f }) => {
      assert.deepEqual([1, 8453, 4663, 42161, 10, 137].map(f), ['ethereum', 'base', 'robinhood', 'arbitrum', 'optimism', 'polygon']);
    }],
    ['мережі без окремого стилю, рядки і null -> порожній клас', ({ getChainClass: f }) => {
      for (const id of [999, 747474, '1', null, undefined, NaN]) assert.equal(f(id), '', String(id));
    }],
  ],
  formatCuratorName: [
    ['відомі куратори впізнаються з назви vault без урахування регістру', ({ formatCuratorName: f }) => {
      assert.equal(f('0x1', 'STEAKHOUSE USDC'), 'Steakhouse Financial');
      assert.equal(f(null, 'Gauntlet WETH Prime'), 'Gauntlet');
      assert.equal(f('', 'Re7 USDT'), 'Re7 Labs');
      assert.equal(f('', 'PayPal PYUSD'), 'PayPal USD');
      assert.equal(f('', 'Flagship ETH'), 'Morpho Flagship');
      assert.equal(f('', 'BlockAnalitica USDC'), 'B.Protocol');
      assert.equal(f('', 'bprotocol vault'), 'B.Protocol');
    }],
    ['назва vault має пріоритет над полем curatorName', ({ formatCuratorName: f }) =>
      assert.equal(f('Gauntlet', 'Steakhouse USDC'), 'Steakhouse Financial')],
    ['порожній, Independent, Permissionless -> "Permissionless"', ({ formatCuratorName: f }) => {
      for (const n of [undefined, null, '', 'Independent', 'Permissionless']) assert.equal(f(n, 'Some Vault'), 'Permissionless');
      assert.equal(f(undefined), 'Permissionless');
    }],
    ['довга адреса скорочується, коротка і звичайна назва лишаються', ({ formatCuratorName: f }) => {
      assert.equal(f('0x1234567890abcdef'), '0x1234...cdef');
      assert.equal(f('0x12345678'), '0x12345678');
      assert.equal(f('MEV Capital', 'Plain vault'), 'MEV Capital');
    }],
  ],
  handleParticleHover: [
    T('підказка над сферою завжди лишається прихованою', ({ handleParticleHover: f, __state: s }) => {
      assert.equal(s.DOM.tooltip.classList.contains('hidden'), false);
      f(cv(), { screenX: 10 });
      assert.equal(s.DOM.tooltip.classList.contains('hidden'), true);
      f(null, null);
      assert.equal(s.DOM.tooltip.classList.contains('hidden'), true);
    }),
  ],

  // ---------- Фільтри ----------
  closeAllDropdowns: [
    T('закриває всі відкриті dropdown і скидає aria-expanded', ({ closeAllDropdowns: f }) => {
      const a = fakeDropdown('network', []), b = fakeDropdown('asset', []);
      for (const x of [a, b]) { x.dd.classList.add('open'); x.trigger.setAttribute('aria-expanded', 'true'); }
      let selector;
      document.querySelectorAll = s => { selector = s; return [a.dd, b.dd]; };
      f();
      assert.equal(selector, '.custom-dropdown.open');
      for (const x of [a, b]) {
        assert.equal(x.dd.classList.contains('open'), false);
        assert.equal(x.trigger.getAttribute('aria-expanded'), 'false');
      }
    }),
    T('без відкритих dropdown нічого не кидає', ({ closeAllDropdowns: f }) => {
      document.querySelectorAll = () => [];
      assert.doesNotThrow(() => f());
    }),
  ],
  updateDropdownUI: [
    T('позначає вибраний пункт, підпис тригера і активний стан', ({ updateDropdownUI: f }) => {
      const x = fakeDropdown('network', [['all', 'All Networks'], ['8453', 'Base'], ['1', 'Ethereum']]);
      let selector;
      document.querySelector = s => { selector = s; return x.dd; };
      f('network', '8453');
      assert.equal(selector, '.custom-dropdown[data-filter="network"]');
      assert.deepEqual(x.items.map(i => i.classList.contains('selected')), [false, true, false]);
      assert.deepEqual(x.items.map(i => i.getAttribute('aria-selected')), ['false', 'true', 'false']);
      assert.equal(x.valEl.textContent, 'Base');
      assert.equal(x.trigger.classList.contains('is-active'), true);
      f('network', 'all');
      assert.equal(x.valEl.textContent, 'All Networks');
      assert.equal(x.trigger.classList.contains('is-active'), false);
    }),
    T('для sort типовим є tvl_desc, а не all', ({ updateDropdownUI: f }) => {
      const x = fakeDropdown('sort', [['tvl_desc', 'TVL'], ['apy_desc', 'APY']]);
      document.querySelector = () => x.dd;
      f('sort', 'tvl_desc');
      assert.equal(x.trigger.classList.contains('is-active'), false);
      f('sort', 'apy_desc');
      assert.equal(x.trigger.classList.contains('is-active'), true);
    }),
    T('невідоме значення: жоден пункт не вибраний, підпис не змінюється', ({ updateDropdownUI: f }) => {
      const x = fakeDropdown('asset', [['all', 'All'], ['USDC', 'USDC']]);
      document.querySelector = () => x.dd;
      f('asset', 'DOGE');
      assert.ok(x.items.every(i => !i.classList.contains('selected')));
      assert.equal(x.valEl.textContent, 'initial');
    }),
    T('пункт без .item-text бере власний текст; відсутній dropdown не кидає', ({ updateDropdownUI: f }) => {
      const x = fakeDropdown('asset', [['ETH', 'x']]);
      x.items[0].querySelector = () => null;
      x.items[0].textContent = '  Ether  ';
      document.querySelector = () => x.dd;
      f('asset', 'ETH');
      assert.equal(x.valEl.textContent, 'Ether');
      document.querySelector = () => null;
      assert.doesNotThrow(() => f('asset', 'ETH'));
    }),
  ],
  setFilterValue: [
    T('записує фільтр, оновлює dropdown і перемальовує список', ({ setFilterValue: f, __state: s }) => {
      s.allVaults = [cv({ chainId: 1 }), cv({ address: '0xB', chainId: 8453 })];
      const seen = [];
      document.querySelector = sel => { seen.push(sel); return null; };
      const rows = collectRows();
      f('network', '8453');
      assert.equal(s.explorerFilters.network, '8453');
      assert.ok(seen.includes('.custom-dropdown[data-filter="network"]'));
      assert.equal(s.DOM.explorerCount.textContent, '1 / 2 Vaults');
      assert.deepEqual(rows.map(r => r.getAttribute('data-address')), ['0xB']);
    }),
  ],
  updateActiveFilterChips: [
    T('без фільтрів панель прихована і чіпи очищені', ({ updateActiveFilterChips: f, __state: s }) => {
      s.DOM.chipsContainer.innerHTML = 'old';
      f();
      assert.equal(s.DOM.activeFilterChips.classList.contains('hidden'), true);
      assert.equal(s.DOM.chipsContainer.innerHTML, '');
    }),
    T('чіпи мережі, активу, куратора і сортування з людськими підписами', ({ updateActiveFilterChips: f, __state: s }) => {
      s.DOM.activeFilterChips.classList.add('hidden');
      Object.assign(s.explorerFilters, { network: '8453', asset: 'USDC', curator: 're7', sort: 'apy_desc' });
      f();
      const html = s.DOM.chipsContainer.innerHTML;
      assert.equal(s.DOM.activeFilterChips.classList.contains('hidden'), false);
      for (const t of ['>BASE<', '>USDC<', '>Re7 Labs<', '>APY: High to Low<', 'data-clear="network"', 'data-clear="sort"']) assert.ok(html.includes(t), t);
      assert.ok(!html.includes('Favorites'));
    }),
    T('значення фільтра екрануються (XSS), невідомий куратор показується як є', ({ updateActiveFilterChips: f, __state: s }) => {
      Object.assign(s.explorerFilters, { asset: '<img src=x onerror=alert(1)>', curator: 'mev' });
      f();
      const html = s.DOM.chipsContainer.innerHTML;
      assert.ok(!html.includes('<img'));
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
      assert.ok(html.includes('>mev<'));
    }),
    T('кнопки видалення чіпів скидають свій фільтр', ({ updateActiveFilterChips: f, __state: s }) => {
      Object.assign(s.explorerFilters, { network: '1', sort: 'liq_desc', pinnedOnly: true });
      s.DOM.explorerFavFilterBtn.classList.add('active');
      const btns = ['network', 'sort', 'pinnedOnly'].map(k => { const b = capEl(); b.setAttribute('data-clear', k); return b; });
      s.DOM.chipsContainer.querySelectorAll = () => btns;
      f();
      assert.ok(s.DOM.chipsContainer.innerHTML.includes('Favorites'));
      const ev = { stopPropagation() {} };
      btns[0].handlers.click(ev);
      assert.equal(s.explorerFilters.network, 'all');
      btns[1].handlers.click(ev);
      assert.equal(s.explorerFilters.sort, 'tvl_desc');
      btns[2].handlers.click(ev);
      assert.equal(s.explorerFilters.pinnedOnly, false);
      assert.equal(s.DOM.explorerFavFilterBtn.classList.contains('active'), false);
    }),
  ],
  setupVaultExplorerEvents: [
    T('пошук з дебаунсом 120 мс, кнопка очищення стає видимою', ({ setupVaultExplorerEvents: f, __state: s }, env) => {
      const input = s.DOM.searchInput;
      input.handlers = {};
      input.addEventListener = (t, fn) => { input.handlers[t] = fn; };
      s.DOM.searchClearBtn.classList.add('hidden');
      f();
      input.value = '  Steak USDC ';
      input.handlers.input();
      assert.equal(s.DOM.searchClearBtn.classList.contains('hidden'), false);
      assert.equal(s.explorerFilters.query, '');
      assert.deepEqual(env.timers.map(t => t.ms), [120]);
      env.flush();
      assert.equal(s.explorerFilters.query, 'steak usdc');
    }),
    T('Enter застосовує запит без очікування і відкриває перший рядок', ({ setupVaultExplorerEvents: f, __state: s }, env) => {
      const input = s.DOM.searchInput;
      input.handlers = {};
      input.addEventListener = (t, fn) => { input.handlers[t] = fn; };
      let clicked = false;
      const first = makeElement(); first.click = () => { clicked = true; };
      s.DOM.explorerVaultsList.querySelector = sel => (sel === '.explorer-vault-item' ? first : null);
      f();
      input.value = 'ABC';
      input.handlers.input();
      input.handlers.keydown({ key: 'Enter' });
      assert.equal(s.explorerFilters.query, 'abc');
      assert.equal(clicked, true);
      assert.equal(env.timers.length, 0); // дебаунс скасовано
    }),
    T('кнопки очищення пошуку, Esc, обраного і скидання', ({ setupVaultExplorerEvents: f, __state: s }) => {
      const els = [s.DOM.searchClearBtn, s.DOM.searchShortcutEsc, s.DOM.explorerFavFilterBtn, s.DOM.explorerResetBtn, s.DOM.searchInput];
      for (const e of els) { e.handlers = {}; e.addEventListener = (t, fn) => { e.handlers[t] = fn; }; }
      let focused = 0, blurred = 0;
      s.DOM.searchInput.focus = () => { focused++; };
      s.DOM.searchInput.blur = () => { blurred++; };
      f();
      s.DOM.searchInput.value = 'x'; s.explorerFilters.query = 'x';
      s.DOM.searchClearBtn.handlers.click();
      assert.equal(s.DOM.searchInput.value, ''); assert.equal(s.explorerFilters.query, '');
      assert.equal(s.DOM.searchClearBtn.classList.contains('hidden'), true); assert.equal(focused, 1);

      s.DOM.searchInput.value = 'y'; s.explorerFilters.query = 'y';
      s.DOM.searchShortcutEsc.handlers.click();
      assert.equal(s.explorerFilters.query, ''); assert.equal(blurred, 1);
      assert.deepEqual(lastCall(s.sphere, 'highlight'), ['highlight', null]);

      s.DOM.explorerFavFilterBtn.handlers.click();
      assert.equal(s.explorerFilters.pinnedOnly, true);
      assert.equal(s.DOM.explorerFavFilterBtn.classList.contains('active'), true);
      s.DOM.explorerFavFilterBtn.handlers.click();
      assert.equal(s.explorerFilters.pinnedOnly, false);

      Object.assign(s.explorerFilters, { network: '1', query: 'q' });
      s.DOM.explorerResetBtn.handlers.click();
      assert.equal(s.explorerFilters.network, 'all'); assert.equal(s.explorerFilters.query, '');
    }),
    T('dropdown: тригер відкриває/закриває, пункт задає фільтр, клік поза меню закриває', ({ setupVaultExplorerEvents: f, __state: s }) => {
      const x = fakeDropdown('asset', [['all', 'All'], ['USDC', 'USDC']]);
      const docHandlers = {};
      document.addEventListener = (t, fn) => { docHandlers[t] = fn; };
      document.querySelectorAll = sel => (sel === '.custom-dropdown' ? [x.dd] : sel === '.custom-dropdown.open' && x.dd.classList.contains('open') ? [x.dd] : []);
      document.querySelector = () => x.dd;
      f();
      const ev = { stopPropagation() {}, preventDefault() {}, detail: 1 };
      x.trigger.handlers.click(ev);
      assert.equal(x.dd.classList.contains('open'), true);
      assert.equal(x.trigger.getAttribute('aria-expanded'), 'true');
      x.trigger.handlers.click(ev);
      assert.equal(x.dd.classList.contains('open'), false);

      x.trigger.handlers.click(ev);
      x.items[1].handlers.click(ev);
      assert.equal(s.explorerFilters.asset, 'USDC');
      assert.equal(x.items[1].classList.contains('selected'), true);
      assert.equal(x.dd.classList.contains('open'), false);
      assert.equal(x.items[0].tabIndex, 0);

      x.trigger.handlers.click(ev);
      docHandlers.click({ target: { closest: () => null } });
      assert.equal(x.dd.classList.contains('open'), false);
    }),
  ],
  resetDropdownFilters: [
    T('повертає фільтри списку до типових, пошуковий запит не чіпає', ({ resetDropdownFilters: f, __state: s }) => {
      Object.assign(s.explorerFilters, { query: 'keep', network: '1', asset: 'ETH', curator: 're7', sort: 'apy_desc', pinnedOnly: true });
      s.DOM.explorerFavFilterBtn.classList.add('active');
      f();
      assert.deepEqual({ ...s.explorerFilters }, { ...DEFAULT_FILTERS, query: 'keep' });
      assert.equal(s.DOM.explorerFavFilterBtn.classList.contains('active'), false);
    }),
  ],
  resetAllFilters: [
    T('скидає і пошук, і фільтри, знімає підсвічування сфери', ({ resetAllFilters: f, __state: s }) => {
      Object.assign(s.explorerFilters, { query: 'q', network: '1', pinnedOnly: true });
      s.DOM.searchInput.value = 'q';
      f();
      assert.deepEqual({ ...s.explorerFilters }, DEFAULT_FILTERS);
      assert.equal(s.DOM.searchInput.value, '');
      assert.equal(s.DOM.searchClearBtn.classList.contains('hidden'), true);
      assert.deepEqual(s.sphere.calls.at(-1), ['highlight', null]);
    }),
  ],
  matchesAssetFilter: [
    ['без фільтра або "all" підходить усе, навіть без символу', ({ matchesAssetFilter: f }) => {
      for (const filter of [undefined, null, '', 'all']) assert.equal(f(undefined, filter), true);
    }],
    ['символ відсутній при активному фільтрі -> false', ({ matchesAssetFilter: f }) => {
      for (const sym of [undefined, null, '']) assert.equal(f(sym, 'USDC'), false);
    }],
    ['ETH охоплює похідні ETH, USDE - sUSDe, EURC - будь-який EUR', ({ matchesAssetFilter: f }) => {
      assert.equal(f('WETH', 'ETH'), true); assert.equal(f('wstETH', 'eth'), true); assert.equal(f('USDC', 'ETH'), false);
      assert.equal(f('sUSDe', 'USDE'), true); assert.equal(f('USDC', 'USDE'), false);
      assert.equal(f('EURe', 'EURC'), true); assert.equal(f('USDC', 'EURC'), false);
    }],
    ['решта: точний збіг або входження без урахування регістру', ({ matchesAssetFilter: f }) => {
      assert.equal(f('usdc', 'USDC'), true); assert.equal(f('USDC.e', 'USDC'), true);
      assert.equal(f('USDT', 'USDC'), false); assert.equal(f('PYUSD', 'USDG'), false);
    }],
  ],
  matchesCuratorFilter: [
    ['без фільтра або "all" -> true', ({ matchesCuratorFilter: f }) => {
      for (const filter of [undefined, '', 'all']) assert.equal(f({}, filter), true);
    }],
    ['впізнає куратора з назви або поля curatorName', ({ matchesCuratorFilter: f }) => {
      assert.equal(f({ name: 'Steakhouse USDC' }, 'steakhouse'), true);
      assert.equal(f({ curatorName: 'Gauntlet' }, 'GAUNTLET'), true);
      assert.equal(f({ name: 'Re7 WETH' }, 're7'), true);
      assert.equal(f({ name: 'Morpho USDC' }, 'flagship'), true);
      assert.equal(f({ curatorName: 'Morpho Association' }, 'flagship'), true);
      assert.equal(f({ name: 'BlockAnalitica USDC' }, 'bprotocol'), true);
    }],
    ['чужий куратор, порожній vault і невідомий фільтр -> false', ({ matchesCuratorFilter: f }) => {
      assert.equal(f({ name: 'Gauntlet USDC' }, 'steakhouse'), false);
      assert.equal(f({}, 're7'), false);
      assert.equal(f({ name: 'Steakhouse' }, 'unknown'), false);
    }],
  ],

  // ---------- Обрані vault ----------
  getPinnedAddresses: [
    T('порожнє сховище -> [], збережені адреси переводяться в нижній регістр', ({ getPinnedAddresses: f }) => {
      assert.deepEqual(f(), []);
      pin('0xABC', '0xDef');
      assert.deepEqual(f(), ['0xabc', '0xdef']);
    }),
    T('зіпсований JSON, не масив, або виняток localStorage -> []', ({ getPinnedAddresses: f }) => {
      localStorage.setItem('cym_pinned_vaults', '{oops');
      assert.deepEqual(f(), []);
      localStorage.setItem('cym_pinned_vaults', '{"a":1}');
      assert.deepEqual(f(), []);
      localStorage.getItem = () => { throw new Error('SecurityError'); };
      assert.deepEqual(f(), []);
    }),
    T('visibleOnly показує лише vault з API, але не видаляє решту зі сховища', ({ getPinnedAddresses: f, __state: s }) => {
      s.allVaults = [cv({ address: '0xA' })];
      pin('0xa', '0xgone');
      assert.deepEqual(f(), ['0xa']);
      assert.deepEqual(f(false), ['0xa', '0xgone']);
      assert.deepEqual(pinned(), ['0xa', '0xgone']);
      s.allVaults = [];
      assert.deepEqual(f(), ['0xa', '0xgone']); // поки API нічого не повернуло, фільтрувати нема з чим
    }),
    T('копія в памʼяті має пріоритет, коли localStorage недоступний', ({ getPinnedAddresses: f, __state: s }) => {
      pin('0xstorage');
      s.pinnedMemoryFallback = ['0xmem'];
      assert.deepEqual(f(), ['0xmem']);
    }),
  ],
  savePinnedAddresses: [
    T('зберігає JSON і скидає копію в памʼяті', ({ savePinnedAddresses: f, __state: s }) => {
      s.pinnedMemoryFallback = ['0xold'];
      f(['0xa', '0xb']);
      assert.equal(localStorage.getItem('cym_pinned_vaults'), '["0xa","0xb"]');
      assert.equal(s.pinnedMemoryFallback, null);
    }),
    T('заблокований localStorage: список живе в памʼяті і читається назад', ({ savePinnedAddresses: f, getPinnedAddresses: g, __state: s }) => {
      localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
      const origError = console.error;
      console.error = () => {};
      try { f(['0xa']); } finally { console.error = origError; }
      assert.deepEqual(s.pinnedMemoryFallback, ['0xa']);
      assert.deepEqual(g(), ['0xa']);
    }),
  ],
  isVaultPinned: [
    T('порожня адреса -> false; перевірка за сховищем без урахування регістру', ({ isVaultPinned: f }) => {
      pin('0xabc');
      assert.equal(f(''), false); assert.equal(f(null), false);
      assert.equal(f('0xABC'), true); assert.equal(f('0xother'), false);
    }),
    T('переданий набір має пріоритет над сховищем', ({ isVaultPinned: f }) => {
      pin('0xabc');
      assert.equal(f('0xABC', new Set()), false);
      assert.equal(f('0xDEF', new Set(['0xdef'])), true);
    }),
  ],
  togglePinVault: [
    T('закріплює і відкріплює vault, оновлює зірку модалки і лічильник обраних', ({ togglePinVault: f, __state: s }) => {
      s.allVaults = [cv({ address: '0xA' })];
      f('0xA');
      assert.deepEqual(pinned(), ['0xa']);
      assert.equal(s.DOM.modalFavBtn.classList.contains('active'), true);
      assert.equal(s.DOM.modalFavBtn.getAttribute('aria-label'), 'Unpin from Favorites');
      assert.equal(s.DOM.explorerFavCount.textContent, 1);
      f('0xa');
      assert.deepEqual(pinned(), []);
      assert.equal(s.DOM.modalFavBtn.classList.contains('active'), false);
      assert.equal(s.DOM.explorerFavCount.textContent, 0);
    }),
    T('не губить закріплення vault, яких зараз немає у відповіді API', ({ togglePinVault: f, __state: s }) => {
      s.allVaults = [cv({ address: '0xA' })];
      pin('0xhidden');
      f('0xA');
      assert.deepEqual(pinned(), ['0xhidden', '0xa']);
    }),
    T('порожня адреса нічого не змінює', ({ togglePinVault: f }) => {
      f(''); f(undefined);
      assert.equal(localStorage.getItem('cym_pinned_vaults'), null);
    }),
  ],
  updateFavBtnUI: [
    T('стан зірки відповідає сховищу', ({ updateFavBtnUI: f, __state: s }) => {
      pin('0xa');
      f('0xA');
      assert.equal(s.DOM.modalFavBtn.classList.contains('active'), true);
      assert.equal(s.DOM.modalFavBtn.title, 'Unpin from Favorites');
      f('0xb');
      assert.equal(s.DOM.modalFavBtn.classList.contains('active'), false);
      assert.equal(s.DOM.modalFavBtn.title, 'Pin to Favorites');
      assert.equal(s.DOM.modalFavBtn.getAttribute('aria-label'), 'Pin to Favorites');
    }),
  ],

  // ---------- Синхронізація аудиту ----------
  applyVaultAuditData: [
    T('неповні дані (без vault, verdict чи адреси) ігноруються', ({ applyVaultAuditData: f, __state: s }) => {
      f('0xA', { vault: cv() });
      f('0xA', { verdict: verdictOf() });
      f('', audit());
      f('0xA', null);
      assert.equal(s.clientAuditCache.size, 0);
    }),
    T('кешує за адресою в нижньому регістрі та переносить поля у allVaults', ({ applyVaultAuditData: f, __state: s }) => {
      Date.now = () => 5000;
      const item = cv({ address: '0xAAA1', asset: { symbol: 'USDC', logo: 'keep' }, totalAssetsUsd: 1 });
      s.allVaults = [item];
      const data = audit({ totalAssetsUsd: 2e6, netApy: 0.07, asset: { symbol: 'USDC', decimals: 6 } }, {
        mqi: { mqiPercent: 87.5, isAllClean: false, compromisedMarkets: [{}, {}], compromisedPercent: 12.5, unverifiedPercent: 1, unpriced: false },
        liquidity: { instantExitCapacityPercent: 33, instantExitCapacityUsd: 660000 }, hhi: { hhi: 0.4, tier: 'HIGH' }
      });
      f('0xaaa1', data);
      assert.equal(s.clientAuditCache.get('0xaaa1'), data);
      assert.equal(data.cachedAt, 5000);
      assert.equal(item.totalAssetsUsd, 2e6); assert.equal(item.netApy, 0.07);
      assert.equal(item.mqiPercent, 87.5); assert.equal(item.isAllClean, false);
      assert.equal(item.compromisedCount, 2); assert.equal(item.compromisedPercent, 12.5); assert.equal(item.unverifiedPercent, 1);
      assert.equal(item.isUnpriced, false); assert.equal(item.exitCapPercent, 33); assert.equal(item.exitCapUsd, 660000);
      assert.equal(item.hhi, 0.4); assert.equal(item.hhiTier, 'HIGH');
      assert.deepEqual(item.asset, { symbol: 'USDC', logo: 'keep', decimals: 6 });
    }),
    T('відкрита модалка цього vault оновлюється, закрита - ні', ({ applyVaultAuditData: f, __state: s }) => {
      s.selectedVaultAddress = '0xAAA1';
      s.DOM.modalVaultName.textContent = 'sentinel';
      f('0xaaa1', audit({ name: 'Closed Update' }));
      assert.equal(s.DOM.modalVaultName.textContent, 'sentinel');
      assert.equal(s.activeAuditData, null);
      s.DOM.auditModal.classList.remove('hidden');
      const data = audit({ name: 'Open Update' });
      f('0xaaa1', data);
      assert.equal(s.activeAuditData, data);
      assert.equal(s.DOM.modalVaultName.textContent, 'Open Update');
    }),
    T('картка закріпленого vault отримує свіжі значення і чистий бейдж', ({ applyVaultAuditData: f, __state: s }) => {
      s.allVaults = [cv()];
      pin('0xaaa1');
      const p = fakePillCard();
      s.DOM.pinnedRichPills.querySelector = sel => (sel.includes('0xAAA1') ? p.card : null);
      f('0xAAA1', audit({ totalAssetsUsd: 2e6, liquidityUsd: 5e5, netApy: 0.0425, fee: 0.15, totalAssets: '2000000000000' }));
      assert.equal(p.badge.textContent, '100% Clean');
      assert.equal(p.badge.className, 'rich-pill-mqi-badge clean');
      assert.equal(p.val(0), '$2.00M'); assert.equal(p.sub(0), '2.00M USDC');
      assert.equal(p.val(1), '$500.0K'); assert.equal(p.sub(1), '40% Exit Cap');
      assert.equal(p.val(2), '4.25%'); assert.equal(p.sub(2), 'Fee: 15.0%');
    }),
    T('картка: unpriced -> "Unpriced", flagged, невідомий вихід -> "Exit Cap N/A"', ({ applyVaultAuditData: f, __state: s }) => {
      s.allVaults = [cv()];
      pin('0xaaa1');
      const p = fakePillCard();
      s.DOM.pinnedRichPills.querySelector = () => p.card;
      f('0xAAA1', audit({}, { mqi: { mqiPercent: null, isAllClean: false, unpriced: true }, liquidity: { instantExitCapacityPercent: null } }));
      assert.equal(p.badge.textContent, 'Unpriced');
      assert.equal(p.badge.className, 'rich-pill-mqi-badge flagged');
      assert.equal(p.sub(1), 'Exit Cap N/A');
    }),
    T('картка: 100% з позначеним ринком -> "Flagged", а не "Clean"', ({ applyVaultAuditData: f, __state: s }) => {
      s.allVaults = [cv()];
      pin('0xaaa1');
      const p = fakePillCard();
      s.DOM.pinnedRichPills.querySelector = () => p.card;
      f('0xAAA1', audit({}, { mqi: { mqiPercent: 100, isAllClean: false, compromisedMarkets: [{}] } }));
      assert.equal(p.badge.textContent, 'Flagged');
      assert.equal(p.badge.className, 'rich-pill-mqi-badge flagged');
    }),
    T('рядок у списку vault отримує нові TVL і APY', ({ applyVaultAuditData: f, __state: s }) => {
      const tvl = makeElement(), apy = makeElement();
      const row = fakeNode({ '.vault-item-tvl': tvl, '.vault-item-apy': apy });
      s.DOM.explorerVaultsList.querySelector = sel => (sel === '[data-address="0xAAA1"]' ? row : null);
      f('0xAAA1', audit({ totalAssetsUsd: 3.5e9, netApy: -0.001 }));
      assert.equal(tvl.textContent, '$3.50B');
      assert.equal(apy.textContent, '-0.10% APY');
    }),
  ],
  renderPinnedRichPills: [
    T('без закріплених або з відкритим аудитом контейнер прихований і порожній', ({ renderPinnedRichPills: f, __state: s }) => {
      s.DOM.pinnedRichPills.innerHTML = 'old';
      f();
      assert.equal(s.DOM.pinnedRichPills.classList.contains('hidden'), true);
      assert.equal(s.DOM.pinnedRichPills.innerHTML, '');
      s.allVaults = [cv()];
      pin('0xaaa1');
      s.selectedVaultAddress = '0xAAA1';
      s.DOM.auditModal.classList.remove('hidden');
      f();
      assert.equal(s.DOM.pinnedRichPills.classList.contains('hidden'), true);
    }),
    T('картка чистого vault: мережа, куратор, депозити, ліквідність, вихід, APY і комісія', ({ renderPinnedRichPills: f, __state: s }, env) => {
      env.fetch(() => jsonResponse({}, 404));
      s.allVaults = [cv({ chainId: 8453 })];
      pin('0xaaa1');
      s.DOM.pinnedRichPills.classList.add('hidden');
      const cards = collect(s.DOM.pinnedRichPills);
      f();
      assert.equal(s.DOM.pinnedRichPills.classList.contains('hidden'), false);
      assert.equal(cards.length, 1);
      assert.equal(cards[0].dataset.address, '0xAAA1');
      const html = cards[0].innerHTML;
      for (const t of ['badge-chain base">BASE<', 'Steakhouse Financial', 'rich-pill-mqi-badge clean">100% Clean<', '>$10.00M<',
        '>10.00M USDC<', '>$4.00M<', '>40% Exit Cap<', '>5.00%<', '>Fee: 10.0%<', 'data-unpin="0xAAA1"']) assert.ok(html.includes(t), t);
    }),
    T('невідомі MQI і ліквідність: "Unpriced"/"Unverified", "—" і "Exit Cap N/A"', ({ renderPinnedRichPills: f, __state: s }, env) => {
      env.fetch(() => jsonResponse({}, 404));
      s.allVaults = [cv({ address: '0xa', mqiPercent: null, isUnpriced: true, liquidityUsd: null, exitCapPercent: undefined }),
        cv({ address: '0xb', mqiPercent: null })];
      pin('0xa', '0xb');
      const cards = collect(s.DOM.pinnedRichPills);
      f();
      assert.ok(cards[0].innerHTML.includes('flagged">Unpriced<'));
      assert.ok(cards[0].innerHTML.includes('>—<'));
      assert.ok(cards[0].innerHTML.includes('>Exit Cap N/A<'));
      assert.ok(cards[1].innerHTML.includes('flagged">Unverified<'));
    }),
    T('назва з HTML екранується', ({ renderPinnedRichPills: f, __state: s }, env) => {
      env.fetch(() => jsonResponse({}, 404));
      s.allVaults = [cv({ name: '<script>x</script>' })];
      pin('0xaaa1');
      const cards = collect(s.DOM.pinnedRichPills);
      f();
      assert.ok(!cards[0].innerHTML.includes('<script>'));
      assert.ok(cards[0].innerHTML.includes('&lt;script&gt;x&lt;/script&gt;'));
    }),
    T('vault, якого немає в allVaults, береться з кешу аудиту; свіжий кеш не перезапитується', ({ renderPinnedRichPills: f, __state: s }, env) => {
      env.fetch(() => jsonResponse({}, 404));
      pin('0xcached');
      s.allVaults = []; // API ще нічого не повернуло: дані беруться з кешу аудиту
      s.clientAuditCache.set('0xcached', { ...audit({ address: '0xcached', name: 'From Cache' }), cachedAt: Date.now() });
      const cards = collect(s.DOM.pinnedRichPills);
      f();
      assert.equal(cards.length, 1);
      assert.ok(cards[0].innerHTML.includes('From Cache'));
      assert.deepEqual(env.fetched, []);
    }),
    T('фоновий запит аудиту для закріпленого vault без свіжого кешу', async ({ renderPinnedRichPills: f, __state: s }, env) => {
      s.allVaults = [cv()];
      pin('0xaaa1');
      env.fetch(url => (url === '/api/vaults/0xaaa1' ? jsonResponse(audit({ name: 'Prefetched' })) : jsonResponse({}, 404)));
      collect(s.DOM.pinnedRichPills);
      f();
      await tick();
      assert.deepEqual(env.fetched, ['/api/vaults/0xaaa1']);
      assert.equal(s.clientAuditCache.get('0xaaa1').vault.name, 'Prefetched');
      assert.equal(s.allVaults[0].name, 'Prefetched');
    }),
    T('анімація: картки стартують прозорими і ставлять таймери; reduced motion вимикає її', ({ renderPinnedRichPills: f, __state: s }, env) => {
      env.fetch(() => jsonResponse({}, 404));
      s.allVaults = [cv({ address: '0xa' }), cv({ address: '0xb' })];
      pin('0xa', '0xb');
      let cards = collect(s.DOM.pinnedRichPills);
      f(true);
      assert.deepEqual(cards.map(c => c.style.opacity), ['0', '0']);
      assert.deepEqual(env.timers.map(t => t.ms), [0, 80]);
      env.flush(); // політ кульки: не має кидати
      env.timers.length = 0;
      s.REDUCED_MOTION.matches = true;
      cards = collect(s.DOM.pinnedRichPills);
      f(true);
      assert.deepEqual(cards.map(c => c.style.opacity), [undefined, undefined]);
      assert.equal(env.timers.length, 0);
    }),
  ],
  renderVaultExplorer: [
    T('без фільтрів: усі vault за TVL, лічильники, сфера без підсвічування', ({ renderVaultExplorer: f, __state: s }) => {
      s.allVaults = [cv({ address: '0xs', totalAssetsUsd: 1 }), cv({ address: '0xl', totalAssetsUsd: 9e9 }), cv({ address: '0xm', totalAssetsUsd: 5e6 })];
      pin('0xm');
      const rows = collectRows();
      s.DOM.explorerVaultsList.scrollTop = 77;
      f();
      assert.deepEqual(rows.map(r => r.getAttribute('data-address')), ['0xl', '0xm', '0xs']);
      assert.equal(s.DOM.explorerCount.textContent, '3 Vaults');
      assert.equal(s.DOM.explorerFavCount.textContent, 1);
      assert.equal(s.DOM.explorerFavFilterBtn.getAttribute('aria-pressed'), 'false');
      assert.deepEqual(s.sphere.calls.at(-1), ['highlight', null]);
      assert.equal(s.DOM.explorerVaultsList.scrollTop, 77);
      assert.ok(rows[1].innerHTML.includes('aria-pressed="true"'));
      assert.ok(rows[0].innerHTML.includes('aria-pressed="false"'));
    }),
    T('пошук за кількома словами: лічильник "N / M", сфера підсвічує перший результат', ({ renderVaultExplorer: f, __state: s }) => {
      s.allVaults = [cv({ address: '0x1', name: 'Steakhouse USDC' }), cv({ address: '0x2', name: 'Gauntlet WETH', curatorName: 'Gauntlet', asset: { symbol: 'WETH' } })];
      s.explorerFilters.query = 'gauntlet weth';
      const rows = collectRows();
      f();
      assert.deepEqual(rows.map(r => r.getAttribute('data-address')), ['0x2']);
      assert.equal(s.DOM.explorerCount.textContent, '1 / 2 Vaults');
      assert.deepEqual(s.sphere.calls.at(-1), ['highlight', '0x2']);
    }),
    T('фільтри мережі, активу, куратора і обраних', ({ renderVaultExplorer: f, __state: s }) => {
      s.allVaults = [cv({ address: '0x1', chainId: 1, asset: { symbol: 'WETH' }, name: 'Re7 WETH', curatorName: '' }),
        cv({ address: '0x2', chainId: 8453, asset: { symbol: 'USDC' } }), cv({ address: '0x3', chainId: 8453, asset: { symbol: 'wstETH' }, name: 'Gauntlet', curatorName: '' })];
      const run = filters => { Object.assign(s.explorerFilters, DEFAULT_FILTERS, filters); const rows = collectRows(); f(); return rows.map(r => r.getAttribute('data-address')); };
      assert.deepEqual(run({ network: '8453' }), ['0x2', '0x3']);
      assert.deepEqual(run({ asset: 'ETH' }), ['0x1', '0x3']);
      assert.deepEqual(run({ curator: 're7' }), ['0x1']);
      pin('0x3');
      assert.deepEqual(run({ pinnedOnly: true }), ['0x3']);
      assert.equal(s.DOM.explorerFavFilterBtn.getAttribute('aria-pressed'), 'true');
    }),
    T('порожній результат: різні повідомлення для обраних і звичайних фільтрів', ({ renderVaultExplorer: f, __state: s }) => {
      s.allVaults = [cv()];
      s.explorerFilters.pinnedOnly = true;
      f();
      assert.match(s.DOM.explorerVaultsList.innerHTML, /No pinned vaults yet/);
      Object.assign(s.explorerFilters, { pinnedOnly: false, query: 'zzz' });
      f();
      assert.match(s.DOM.explorerVaultsList.innerHTML, /No vaults match your filter criteria/);
      assert.equal(s.DOM.explorerCount.textContent, '0 / 1 Vaults');
    }),
    T('сортування за APY, ліквідністю, MQI і HHI', ({ renderVaultExplorer: f, __state: s }) => {
      s.allVaults = [
        cv({ address: 'a', netApy: 0.01, liquidityUsd: 3, mqiPercent: 100, isAllClean: true, hhi: 0.2, hhiTier: 'LOW' }),
        cv({ address: 'b', netApy: 0.09, liquidityUsd: 1, mqiPercent: null, hhi: null, hhiTier: 'UNKNOWN' }),
        cv({ address: 'c', netApy: 0.05, liquidityUsd: 2, mqiPercent: 100, isAllClean: false, hhi: 0.9, hhiTier: 'HIGH' }),
        cv({ address: 'd', netApy: undefined, liquidityUsd: undefined, mqiPercent: 60, isAllClean: false, hhi: 0.5, hhiTier: 'MID' })
      ];
      const order = sort => { s.explorerFilters.sort = sort; const rows = collectRows(); f(); return rows.map(r => r.getAttribute('data-address')).join(''); };
      assert.equal(order('apy_desc'), 'bcad');
      assert.equal(order('liq_desc'), 'acbd');
      assert.equal(order('mqi_asc'), 'bdca'); // невідомий першим, позначений 100 - перед чистим
      assert.equal(order('mqi_desc'), 'acdb');
      assert.equal(order('hhi_desc'), 'cdab');
      assert.equal(order('hhi_asc'), 'adcb'); // UNKNOWN у кінці
    }),
    T('бейджі рядка: Unpriced, Unverified, % Flagged, кількість Flagged, % Unverified, чистий без бейджа', ({ renderVaultExplorer: f, __state: s }) => {
      s.allVaults = [
        cv({ address: '1', totalAssetsUsd: 6, mqiPercent: null, isUnpriced: true }),
        cv({ address: '2', totalAssetsUsd: 5, mqiPercent: null }),
        cv({ address: '3', totalAssetsUsd: 4, mqiPercent: 87.5, isAllClean: false, compromisedCount: 2, compromisedPercent: 12.5 }),
        cv({ address: '4', totalAssetsUsd: 3, mqiPercent: 100, isAllClean: false, compromisedCount: 1, compromisedPercent: 0 }),
        cv({ address: '5', totalAssetsUsd: 2, mqiPercent: 97, isAllClean: false, unverifiedPercent: 3 }),
        cv({ address: '6', totalAssetsUsd: 1, mqiPercent: 100, isAllClean: undefined })
      ];
      const rows = collectRows();
      f();
      const badge = r => r.innerHTML.match(/vault-mini-badge flagged">([^<]*)</)?.[1] ?? null;
      assert.deepEqual(rows.map(badge), ['Unpriced', 'Unverified', '12.5% Flagged', '1 Flagged', '3% Unverified', null]);
    }),
    T('відʼємний APY має клас negative, назва екранується, TVL падає на ліквідність', ({ renderVaultExplorer: f, __state: s }) => {
      s.allVaults = [cv({ name: '"><img onerror=1>', netApy: -0.02, totalAssetsUsd: 0, liquidityUsd: 2500 })];
      const rows = collectRows();
      f();
      const html = rows[0].innerHTML;
      assert.ok(html.includes('vault-item-apy negative">-2.00% APY<'));
      assert.ok(html.includes('vault-item-tvl">$2.5K<'));
      assert.ok(!html.includes('<img'));
      assert.ok(html.includes('&quot;&gt;&lt;img onerror=1&gt;'));
      assert.equal(rows[0].tabIndex, 0);
    }),
    T('зірка в рядку закріплює vault, клік по рядку відкриває аудит', async ({ renderVaultExplorer: f, __state: s }, env) => {
      env.fetch(() => { throw new Error('offline'); });
      s.allVaults = [cv({ address: '0xA' })];
      const star = capEl(), li = capEl();
      li.querySelector = sel => (sel === '.vault-item-star-btn' ? star : null);
      document.createElement = () => li;
      collectRows();
      f();
      star.handlers.click({ stopPropagation() {} });
      assert.deepEqual(pinned(), ['0xa']);
      s.REDUCED_MOTION.matches = true;
      const origError = console.error;
      console.error = () => {};
      try {
        li.handlers.click();
        await tick();
      } finally { console.error = origError; }
      assert.ok(env.fetched.includes('/api/vaults/0xA'));
      assert.equal(s.DOM.headerStatusText.textContent, 'Audit unavailable, try again'); // запит упав, стан скинуто
    }),
  ],
  populateBasicVaultInfo: [
    T('null нічого не змінює', ({ populateBasicVaultInfo: f, __state: s }) => {
      s.DOM.modalVaultName.textContent = 'sentinel';
      f(null);
      assert.equal(s.DOM.modalVaultName.textContent, 'sentinel');
    }),
    T('повний vault: бейджі, назва, куратор, фінанси, вихід і чистий MQI', ({ populateBasicVaultInfo: f, __state: s }) => {
      const D = s.DOM;
      f(cv({ chainId: 8453, version: 'v2' }));
      assert.equal(D.modalChainBadge.textContent, 'BASE'); assert.equal(D.modalChainBadge.className, 'badge badge-chain base');
      assert.equal(D.modalVersionBadge.textContent, 'V2');
      assert.equal(D.modalListedBadge.textContent, 'LISTED'); assert.equal(D.modalListedBadge.className, 'badge badge-listed');
      assert.equal(D.modalVaultName.textContent, 'Steakhouse USDC'); assert.equal(D.modalCuratorName.textContent, 'Steakhouse Financial');
      assert.equal(D.modalTvl.textContent, '$10.00M'); assert.equal(D.modalAssetsHuman.textContent, '10.00M USDC');
      assert.equal(D.modalLiq.textContent, '$4.00M'); assert.equal(D.modalExitCapPct.textContent, '40% Exit Cap');
      assert.equal(D.modalNetApy.textContent, '5.00%'); assert.equal(D.modalFee.textContent, 'Fee: 10.0%');
      assert.equal(D.modalGrade.textContent, '100%'); assert.equal(D.modalGrade.dataset.tone, 'ok');
    }),
    T('тон MQI: null -> N/A bad, 100 з прапорцем -> warn, 85 -> warn, 50 -> bad', ({ populateBasicVaultInfo: f, __state: s }) => {
      const g = s.DOM.modalGrade;
      f(cv({ mqiPercent: null })); assert.equal(g.textContent, 'N/A'); assert.equal(g.dataset.tone, 'bad');
      f(cv({ mqiPercent: 100, isAllClean: false })); assert.equal(g.dataset.tone, 'warn');
      f(cv({ mqiPercent: 85, isAllClean: undefined })); assert.equal(g.textContent, '85%'); assert.equal(g.dataset.tone, 'warn');
      f(cv({ mqiPercent: 50 })); assert.equal(g.dataset.tone, 'bad');
    }),
    T('відсутні поля MQI і виходу не перезаписують попередні значення, null виходу -> N/A', ({ populateBasicVaultInfo: f, __state: s }) => {
      s.DOM.modalGrade.textContent = 'sentinel'; s.DOM.modalExitCapPct.textContent = 'sentinel';
      f(cv({ mqiPercent: undefined, exitCapPercent: undefined }));
      assert.equal(s.DOM.modalGrade.textContent, 'sentinel');
      assert.equal(s.DOM.modalExitCapPct.textContent, 'sentinel');
      f(cv({ exitCapPercent: null }));
      assert.equal(s.DOM.modalExitCapPct.textContent, 'Exit Cap N/A');
    }),
    T('типові значення: V1, UNLISTED, "Morpho Vault", кількість з ціни, невідомі суми -> "—"', ({ populateBasicVaultInfo: f, __state: s }) => {
      const D = s.DOM;
      f({ address: '0x1', chainId: 999, totalAssetsUsd: 6000, asset: { symbol: 'WETH', priceUsd: 3000 } });
      assert.equal(D.modalVersionBadge.textContent, 'V1');
      assert.equal(D.modalListedBadge.textContent, 'UNLISTED'); assert.equal(D.modalListedBadge.className, 'badge badge-chain');
      assert.equal(D.modalChainBadge.className, 'badge badge-chain ');
      assert.equal(D.modalVaultName.textContent, 'Morpho Vault'); assert.equal(D.modalCuratorName.textContent, 'Permissionless');
      assert.equal(D.modalAssetsHuman.textContent, '2.00 WETH');
      assert.equal(D.modalLiq.textContent, '—');
      assert.equal(D.modalNetApy.textContent, '0.00%'); assert.equal(D.modalFee.textContent, 'Fee: 0.0%');
    }),
  ],

  // ---------- Відкриття і закриття аудиту ----------
  abortFailedAuditOpen: [
    T('скидає стан відкриття, сферу і показує повідомлення', ({ abortFailedAuditOpen: f, __state: s }, env) => {
      Object.assign(s, { selectedVaultAddress: '0xA', isTransitioningVault: true, isClosingAudit: true });
      f();
      assert.equal(s.selectedVaultAddress, null);
      assert.equal(s.isTransitioningVault, false);
      assert.equal(s.isClosingAudit, false);
      assert.deepEqual(s.sphere.calls, [['select', null], ['highlight', null]]);
      assert.equal(s.DOM.headerStatusText.textContent, 'Audit unavailable, try again');
      assert.ok(env.timers.some(t => t.ms === 4000));
    }),
  ],
  focusAuditModal: [
    T('переводить фокус на кнопку закриття модалки', ({ focusAuditModal: f, __state: s }) => {
      let focused = 0;
      s.DOM.closeBtn.focus = () => { focused++; };
      f();
      assert.equal(focused, 1);
    }),
  ],
  restoreFocusAfterAudit: [
    T('без збереженого фокуса нічого не робить', ({ restoreFocusAfterAudit: f, __state: s }) => {
      assert.doesNotThrow(() => f());
      assert.equal(s.focusBeforeAudit, null);
    }),
    T('повертає фокус на той самий елемент і очищає збережене', ({ restoreFocusAfterAudit: f, __state: s }) => {
      let focused = 0;
      const el = makeElement(); el.focus = () => { focused++; };
      s.focusBeforeAudit = { el, address: null };
      f();
      assert.equal(focused, 1);
      assert.equal(s.focusBeforeAudit, null);
      f();
      assert.equal(focused, 1);
    }),
    T('елемент перемальовано: шукає рядок з тією ж адресою у списку', ({ restoreFocusAfterAudit: f, __state: s }) => {
      document.contains = () => false;
      const focused = [];
      const mk = addr => { const r = makeElement(); r.dataset = { address: addr }; r.focus = () => focused.push(addr); return r; };
      s.DOM.explorerVaultsList.querySelectorAll = () => [mk('0x1'), mk('0x2')];
      s.focusBeforeAudit = { el: makeElement(), address: '0x2' };
      f();
      assert.deepEqual(focused, ['0x2']);
      s.focusBeforeAudit = { el: null, address: '0xmissing' };
      assert.doesNotThrow(() => f());
      assert.deepEqual(focused, ['0x2']);
    }),
  ],
  syncModalWithCache: [
    T('новіший запис у кеші замінює показані дані', ({ syncModalWithCache: f, __state: s }) => {
      const shown = audit({ name: 'Old' }), latest = audit({ name: 'New' });
      s.clientAuditCache.set('0xaaa1', latest);
      f('0xAAA1', shown);
      assert.equal(s.activeAuditData, latest);
      assert.equal(s.DOM.modalVaultName.textContent, 'New');
    }),
    T('той самий обʼєкт або відсутній запис - без змін', ({ syncModalWithCache: f, __state: s }) => {
      const shown = audit();
      s.clientAuditCache.set('0xaaa1', shown);
      s.DOM.modalVaultName.textContent = 'sentinel';
      f('0xAAA1', shown);
      f('0xnone', shown);
      f(undefined, shown);
      assert.equal(s.activeAuditData, null);
      assert.equal(s.DOM.modalVaultName.textContent, 'sentinel');
    }),
  ],
  cancelPendingAuditOpen: [
    T('скасовує запит, ховає проксі і модалку, скидає вибір і повертає фокус', ({ cancelPendingAuditOpen: f, __state: s }) => {
      const ctrl = new AbortController();
      let focused = 0;
      const el = makeElement(); el.focus = () => { focused++; };
      Object.assign(s, { auditAbort: ctrl, selectedVaultAddress: '0xA', isTransitioningVault: true, focusBeforeAudit: { el } });
      s.DOM.auditModal.classList.remove('hidden');
      const token = s.auditOpenToken;
      f();
      assert.equal(ctrl.signal.aborted, true);
      assert.equal(s.auditOpenToken, token + 1);
      for (const e of [s.DOM.morphProxy, s.DOM.morphProxyRetract, s.DOM.auditModal]) assert.equal(e.classList.contains('hidden'), true);
      assert.equal(s.selectedVaultAddress, null);
      assert.equal(s.isTransitioningVault, false);
      assert.deepEqual(s.sphere.calls, [['select', null], ['highlight', null]]);
      assert.equal(focused, 1);
    }),
  ],
  openVaultAudit: [
    T('під час переходу ігнорує повторне відкриття', async ({ openVaultAudit: f, __state: s }, env) => {
      s.isTransitioningVault = true;
      const token = s.auditOpenToken;
      await f(cv());
      assert.equal(s.auditOpenToken, token);
      assert.deepEqual(env.fetched, []);
    }),
    T('reduced motion: модалка показується з даними, стан переходу знято', async ({ openVaultAudit: f, __state: s }, env) => {
      s.REDUCED_MOTION.matches = true;
      let focused = 0;
      s.DOM.closeBtn.focus = () => { focused++; };
      env.fetch(url => (url === '/api/vaults/0xAAA1' ? jsonResponse(audit({ name: 'Audited' })) : jsonResponse({}, 404)));
      await f(cv());
      assert.equal(s.DOM.auditModal.classList.contains('hidden'), false);
      assert.equal(s.selectedVaultAddress, '0xAAA1');
      assert.equal(s.activeAuditData.vault.name, 'Audited');
      assert.equal(s.DOM.modalVaultName.textContent, 'Audited');
      assert.equal(s.isTransitioningVault, false);
      assert.ok(s.clientAuditCache.has('0xaaa1'));
      assert.deepEqual(s.sphere.calls.find(c => c[0] === 'select'), ['select', '0xAAA1']);
      assert.equal(focused, 1);
    }),
    T('помилка мережі, 404 або неповний аудит -> модалка закрита і повідомлення', async ({ openVaultAudit: f, __state: s }, env) => {
      s.REDUCED_MOTION.matches = true;
      const origError = console.error;
      console.error = () => {};
      try {
        for (const respond of [() => { throw new Error('offline'); }, () => jsonResponse({}, 404), () => jsonResponse({ vault: cv() })]) {
          env.fetch(respond);
          s.DOM.headerStatusText.textContent = '';
          await f(cv());
          assert.equal(s.DOM.auditModal.classList.contains('hidden'), true);
          assert.equal(s.selectedVaultAddress, null);
          assert.equal(s.isTransitioningVault, false);
          assert.equal(s.DOM.headerStatusText.textContent, 'Audit unavailable, try again');
        }
        assert.equal(s.clientAuditCache.size, 0);
      } finally { console.error = origError; }
    }),
    T('виняток усередині потоку (vault = null) не лишає UI в стані переходу', async ({ openVaultAudit: f, __state: s }) => {
      const origError = console.error;
      console.error = () => {};
      try {
        s.DOM.morphProxy.classList.remove('hidden');
        await f(null);
        assert.equal(s.isTransitioningVault, false);
        assert.equal(s.DOM.morphProxy.classList.contains('hidden'), true);
        assert.equal(s.DOM.headerStatusText.textContent, 'Audit unavailable, try again');
      } finally { console.error = origError; }
    }),
  ],
  openVaultAuditFlow: [
    T('повторний клік по вже відкритому vault нічого не робить', async ({ openVaultAuditFlow: f, __state: s }, env) => {
      s.selectedVaultAddress = '0xaaa1';
      s.DOM.auditModal.classList.remove('hidden');
      s.DOM.modalVaultName.textContent = 'sentinel';
      await f(cv(), null, s.auditOpenToken);
      assert.deepEqual(env.fetched, []);
      assert.equal(s.DOM.modalVaultName.textContent, 'sentinel');
    }),
    T('мобільний екран: без вибору на сфері, закріплені приховані, модалка відкрита', async ({ openVaultAuditFlow: f, __state: s }, env) => {
      globalThis.innerWidth = 500;
      env.fetch(() => jsonResponse(audit()));
      await f(cv(), null, s.auditOpenToken);
      assert.equal(s.sphere.calls.some(c => c[0] === 'select'), false);
      assert.equal(s.DOM.pinnedRichPills.classList.contains('hidden'), true);
      assert.equal(s.DOM.auditModal.classList.contains('hidden'), false);
    }),
    T('свіжий кеш показується одразу, у фоні йде повторна перевірка', async ({ openVaultAuditFlow: f, __state: s }, env) => {
      s.REDUCED_MOTION.matches = true;
      const cached = { ...audit({ name: 'Cached' }), cachedAt: Date.now() };
      s.clientAuditCache.set('0xaaa1', cached);
      let resolve;
      env.fetch(() => new Promise(r => { resolve = r; }));
      await f(cv(), null, s.auditOpenToken);
      assert.equal(s.activeAuditData, cached);
      assert.equal(s.DOM.auditModal.classList.contains('hidden'), false);
      assert.deepEqual(env.fetched, ['/api/vaults/0xAAA1']);
      resolve(jsonResponse(audit({ name: 'Revalidated' })));
      await tick();
      assert.equal(s.clientAuditCache.get('0xaaa1').vault.name, 'Revalidated');
      assert.equal(s.DOM.modalVaultName.textContent, 'Revalidated');
    }),
    T('попередній кеш (навіть застарілий) одразу заповнює шапку з MQI аудиту', async ({ openVaultAuditFlow: f, __state: s }, env) => {
      s.REDUCED_MOTION.matches = true;
      s.clientAuditCache.set('0xaaa1', { ...audit({ name: 'Stale Cache' }, { mqi: { mqiPercent: 42 } }), cachedAt: 0 });
      let resolve;
      env.fetch(() => new Promise(r => { resolve = r; }));
      const p = f(cv({ mqiPercent: 100 }), null, s.auditOpenToken);
      assert.equal(s.DOM.modalVaultName.textContent, 'Stale Cache');
      assert.equal(s.DOM.modalGrade.textContent, '42%');
      resolve(jsonResponse(audit()));
      await p;
    }),
    T('анімація на десктопі: проксі вилітає з точки частинки, модалка зʼявляється після таймерів', async ({ openVaultAuditFlow: f, __state: s }, env) => {
      env.fetch(() => jsonResponse(audit()));
      await f(cv(), { x: 300, y: 150 }, s.auditOpenToken);
      const P = s.DOM.morphProxy;
      assert.equal(P.style.left, '300px'); assert.equal(P.style.top, '150px');
      assert.equal(P.classList.contains('hidden'), false);
      assert.equal(s.DOM.auditModal.classList.contains('hidden'), true);
      assert.equal(s.isTransitioningVault, true);
      env.flush();
      assert.equal(P.style.width, '480px');
      assert.equal(P.style.height, '764px');
      assert.equal(s.DOM.auditModal.classList.contains('hidden'), false);
      assert.equal(P.classList.contains('hidden'), true);
      assert.equal(s.isTransitioningVault, false);
    }),
    T('без стартової точки бере позицію частинки зі сфери', async ({ openVaultAuditFlow: f, __state: s }, env) => {
      env.fetch(() => jsonResponse(audit()));
      await f(cv(), null, s.auditOpenToken);
      assert.equal(s.DOM.morphProxy.style.left, '100px');
      assert.equal(s.DOM.morphProxy.style.top, '200px');
      env.flush();
    }),
    T('інший vault уже відкритий: запускається згортання попереднього вікна', async ({ openVaultAuditFlow: f, __state: s }, env) => {
      s.selectedVaultAddress = '0xold';
      s.DOM.auditModal.classList.remove('hidden');
      s.DOM.morphProxyRetract.classList.add('hidden');
      env.fetch(() => jsonResponse(audit()));
      await f(cv(), { x: 1, y: 1 }, s.auditOpenToken);
      const R = s.DOM.morphProxyRetract;
      assert.equal(R.classList.contains('hidden'), false);
      assert.equal(R.style.width, '480px');
      assert.equal(R.style.left, `${20 + 240}px`);
      env.flush();
      assert.equal(R.classList.contains('hidden'), true);
      assert.equal(R.style.left, '100px'); // повернулась до частинки попереднього vault
    }),
    T('застарілий токен (Escape під час завантаження): дані не показуються', async ({ openVaultAuditFlow: f, __state: s }, env) => {
      s.REDUCED_MOTION.matches = true;
      env.fetch(() => jsonResponse(audit()));
      await f(cv(), null, s.auditOpenToken - 1);
      assert.equal(s.activeAuditData, null);
      assert.equal(s.DOM.auditModal.classList.contains('hidden'), true);
    }),
  ],
  getAuditPanelWidth: [
    T('десктоп 480, планшет 440, обидва обмежені половиною екрана', ({ getAuditPanelWidth: f }) => {
      const at = w => { globalThis.innerWidth = w; return f(); };
      assert.equal(at(2000), 480);
      assert.equal(at(1280), 480);
      assert.equal(at(1025), 480);
      assert.equal(at(1024), 440);
      assert.equal(at(800), 380);
      assert.equal(at(769), 364);
      assert.equal(at(768), 354);
    }),
  ],
  closeVaultAudit: [
    T('закрита модалка або закриття вже триває -> нічого', ({ closeVaultAudit: f, __state: s }) => {
      f();
      s.DOM.auditModal.classList.remove('hidden');
      s.isClosingAudit = true;
      f();
      assert.deepEqual(s.sphere.calls, []);
      assert.equal(s.DOM.auditModal.classList.contains('hidden'), false);
    }),
    T('reduced motion: миттєво ховає модалку, скидає вибір і повертає фокус', ({ closeVaultAudit: f, __state: s }) => {
      s.REDUCED_MOTION.matches = true;
      let focused = 0;
      const el = makeElement(); el.focus = () => { focused++; };
      Object.assign(s, { selectedVaultAddress: '0xA', isTransitioningVault: true, focusBeforeAudit: { el } });
      s.DOM.auditModal.classList.remove('hidden');
      f();
      assert.equal(s.DOM.auditModal.classList.contains('hidden'), true);
      assert.equal(s.selectedVaultAddress, null);
      assert.equal(s.isTransitioningVault, false);
      assert.deepEqual(s.sphere.calls, [['select', null], ['highlight', null]]);
      assert.equal(focused, 1);
    }),
    T('мобільний: без звернень до сфери', ({ closeVaultAudit: f, __state: s }) => {
      globalThis.innerWidth = 400;
      s.selectedVaultAddress = '0xA';
      s.DOM.auditModal.classList.remove('hidden');
      f();
      assert.equal(s.DOM.auditModal.classList.contains('hidden'), true);
      assert.deepEqual(s.sphere.calls, []);
    }),
    T('анімоване закриття: блокує нові відкриття до кінця, потім скидає все', ({ closeVaultAudit: f, __state: s }, env) => {
      s.selectedVaultAddress = '0xA';
      s.DOM.auditModal.classList.remove('hidden');
      f();
      const P = s.DOM.morphProxy;
      assert.equal(s.isClosingAudit, true); assert.equal(s.isTransitioningVault, true);
      assert.equal(s.DOM.auditModal.classList.contains('hidden'), true);
      assert.equal(P.classList.contains('hidden'), false);
      assert.equal(P.style.width, '480px');
      assert.equal(P.style.left, '260px');
      env.flush();
      assert.equal(P.classList.contains('hidden'), true);
      assert.equal(P.style.left, '100px');
      assert.equal(s.selectedVaultAddress, null);
      assert.equal(s.isClosingAudit, false); assert.equal(s.isTransitioningVault, false);
      assert.deepEqual(s.sphere.calls.slice(0, 2), [['select', null], ['highlight', null]]);
    }),
  ],

  // ---------- Вихідна ліквідність ----------
  setExitInfoActive: [
    T('вмикає і вимикає поповер, синхронізує aria-expanded і показ стресу', ({ setExitInfoActive: f, __state: s }) => {
      s.currentModalExitState = { normalExitPct: 40, normalExitUsd: 4e6, stressedExitPct: 25, stressedExitUsd: 2.5e6, dropPct: 15, topPeer: 'X' };
      f(true);
      assert.equal(s.DOM.riskExitInfoBtn.classList.contains('active'), true);
      assert.equal(s.DOM.riskExitInfoBtn.getAttribute('aria-expanded'), 'true');
      assert.match(s.DOM.riskExitPct.innerHTML, /STRESSED:<\/span>25%/);
      f(false);
      assert.equal(s.DOM.riskExitInfoBtn.classList.contains('active'), false);
      assert.equal(s.DOM.riskExitInfoBtn.getAttribute('aria-expanded'), 'false');
      assert.equal(s.DOM.riskExitPct.textContent, '40%');
    }),
  ],
  updateStressedExitDisplay: [
    T('невідома ліквідність: порожня нейтральна смуга і N/A в обох режимах', ({ updateStressedExitDisplay: f, __state: s }) => {
      s.currentModalExitState = { ...EXIT_STATE, normalExitPct: null, stressedExitPct: null };
      for (const stressed of [false, true]) {
        s.DOM.riskExitBar.style.width = '100%';
        f(stressed);
        assert.equal(s.DOM.riskExitBar.style.width, '0%');
        assert.equal(s.DOM.riskExitBar.dataset.tone, '');
        assert.equal(s.DOM.riskExitPct.textContent, 'N/A');
        assert.match(s.DOM.riskExitDesc.textContent, /Exit liquidity unknown/);
      }
    }),
    T('звичайний режим: відсоток, сума і ширина смуги з обмеженням 100%', ({ updateStressedExitDisplay: f, __state: s }) => {
      s.currentModalExitState = { ...EXIT_STATE, normalExitPct: 40, normalExitUsd: 4e6 };
      f(false);
      assert.equal(s.DOM.riskExitBar.style.width, '40%');
      assert.equal(s.DOM.riskExitPct.textContent, '40%');
      assert.equal(s.DOM.riskExitDesc.textContent, '$4.00M available for immediate withdrawal without locking markets');
      s.currentModalExitState = { ...EXIT_STATE, normalExitPct: 150 };
      f(false);
      assert.equal(s.DOM.riskExitBar.style.width, '100%');
    }),
    T('стрес із падінням: тег STRESSED, сума і тон warn; нижче 15% - bad', ({ updateStressedExitDisplay: f, __state: s }) => {
      s.currentModalExitState = { normalExitPct: 40, normalExitUsd: 4e6, stressedExitPct: 25, stressedExitUsd: 2.5e6, dropPct: 15, topPeer: '' };
      f(true);
      assert.equal(s.DOM.riskExitBar.style.width, '25%');
      assert.equal(s.DOM.riskExitBar.dataset.tone, 'warn');
      assert.equal(s.DOM.riskExitPct.innerHTML, '<span class="exit-stressed-tag">STRESSED:</span>25%');
      assert.match(s.DOM.riskExitDesc.innerHTML, /\$2\.50M<\/span> available during a mass withdrawal/);
      s.currentModalExitState = { ...s.currentModalExitState, stressedExitPct: 10, dropPct: 30 };
      f(true);
      assert.equal(s.DOM.riskExitBar.dataset.tone, 'bad');
    }),
    T('стрес без падіння: смуга без тону, текст відсотка не змінюється', ({ updateStressedExitDisplay: f, __state: s }) => {
      s.currentModalExitState = { ...EXIT_STATE, normalExitPct: 40, stressedExitPct: 40, dropPct: 0 };
      s.DOM.riskExitPct.textContent = 'sentinel';
      f(true);
      assert.equal(s.DOM.riskExitBar.style.width, '40%');
      assert.equal(s.DOM.riskExitBar.dataset.tone, '');
      assert.equal(s.DOM.riskExitPct.textContent, 'sentinel');
    }),
    T('невідомий лише стресовий вихід -> показується звичайний', ({ updateStressedExitDisplay: f, __state: s }) => {
      s.currentModalExitState = { ...EXIT_STATE, normalExitPct: 30, normalExitUsd: 1000, stressedExitPct: null };
      f(true);
      assert.equal(s.DOM.riskExitPct.textContent, '30%');
      assert.equal(s.DOM.riskExitBar.style.width, '30%');
    }),
  ],

  // ---------- Модалка аудиту ----------
  populateAuditModal: [
    T('чистий vault: шапка, фінанси, MQI, HHI, застава, вихід і прапорці', ({ populateAuditModal: f, __state: s }) => {
      const D = s.DOM;
      const collateral = collect(D.riskCollateralList);
      pin('0xaaa1');
      f(audit({ chainId: 42161, version: 'v2', totalAssetsHuman: 1234567 }));
      assert.equal(D.modalChainBadge.textContent, 'ARB'); assert.equal(D.modalChainBadge.className, 'badge badge-chain arbitrum');
      assert.equal(D.modalVersionBadge.textContent, 'V2'); assert.equal(D.modalListedBadge.textContent, 'LISTED');
      assert.equal(D.modalFavBtn.classList.contains('active'), true);
      assert.equal(D.modalGrade.textContent, '100%'); assert.equal(D.modalScore.textContent, 'Clean Capital');
      assert.equal(D.modalGrade.dataset.tone, 'ok');
      assert.equal(D.modalTvl.textContent, '$10.00M'); assert.equal(D.modalAssetsHuman.textContent, '1.23M USDC');
      assert.equal(D.modalExitCapPct.textContent, '40% Exit Cap');
      assert.equal(D.overviewMarketsCount.textContent, '0 MARKETS');
      assert.equal(D.riskMqiPct.textContent, '100%'); assert.equal(D.riskMqiBar.style.width, '100%');
      assert.equal(D.riskMqiDesc.textContent, '100% of capital is deployed in verified, non-defaulted markets');
      assert.equal(D.riskHhiVal.textContent, '0.25 (Moderate)'); assert.equal(D.riskHhiBar.style.width, '25%');
      assert.equal(D.riskHhiDesc.textContent, 'Top collateral: WETH (50% of total capital)');
      assert.equal(D.riskEffectiveAssets.textContent, '4 Effective Assets');
      assert.equal(collateral.length, 2);
      assert.match(collateral[0].innerHTML, /WETH[\s\S]*\$5\.00M[\s\S]*50%/);
      assert.equal(D.riskFlagsList.innerHTML, '<div class="flag-item clear">No critical risk flags detected for this vault.</div>');
      assert.match(D.allocationsTbody.innerHTML, /No active market allocations recorded/);
      assert.match(D.riskExitPopoverBody.innerHTML, /fully preserved at <strong>40%<\/strong> \(\$4\.00M\)/);
      assert.equal(D.riskExitPct.textContent, '40%');
    }),
    T('невідомий MQI: Unpriced Vault і Unverified, тон bad, N/A і порожня смуга', ({ populateAuditModal: f, __state: s }) => {
      const D = s.DOM;
      f(audit({}, { mqi: { mqiPercent: null, isAllClean: false, unpriced: true } }));
      assert.equal(D.modalGrade.textContent, 'N/A'); assert.equal(D.modalScore.textContent, 'Unpriced Vault');
      assert.equal(D.modalGrade.dataset.tone, 'bad');
      assert.equal(D.riskMqiPct.textContent, 'N/A'); assert.equal(D.riskMqiBar.style.width, '0%');
      assert.match(D.riskMqiDesc.textContent, /no USD price/);
      f(audit({}, { mqi: { mqiPercent: null, isAllClean: false, unpriced: false } }));
      assert.equal(D.modalScore.textContent, 'Unverified');
      assert.equal(D.riskMqiDesc.textContent, 'None of the capital could be verified yet, so there is no score');
    }),
    T('позначені ринки: відсоток або кількість, тон warn/bad', ({ populateAuditModal: f, __state: s }) => {
      const D = s.DOM;
      f(audit({}, { mqi: { mqiPercent: 87.5, isAllClean: false, compromisedMarkets: [{}, {}], compromisedPercent: 12.5 } }));
      assert.equal(D.modalScore.textContent, '12.5% Flagged'); assert.equal(D.modalGrade.dataset.tone, 'warn');
      assert.equal(D.riskMqiDesc.textContent, '2 market(s) with verification or debt issues detected');
      f(audit({}, { mqi: { mqiPercent: 100, isAllClean: false, compromisedMarkets: [{}], compromisedPercent: 0 } }));
      assert.equal(D.modalScore.textContent, '1 Flagged Market'); assert.equal(D.modalGrade.dataset.tone, 'warn');
      assert.equal(D.modalGrade.textContent, '100%');
      f(audit({}, { mqi: { mqiPercent: 70, isAllClean: false, compromisedMarkets: [{}, {}, {}], compromisedPercent: 0 } }));
      assert.equal(D.modalScore.textContent, '3 Flagged Markets'); assert.equal(D.modalGrade.dataset.tone, 'bad');
    }),
    T('лише неперевірений капітал: "% Unverified" і сума поза оцінкою', ({ populateAuditModal: f, __state: s }) => {
      f(audit({}, { mqi: { mqiPercent: 100, isAllClean: false, unverifiedPercent: 3, unverifiedAssetsUsd: 300000 } }));
      assert.equal(s.DOM.modalScore.textContent, '3% Unverified');
      assert.equal(s.DOM.riskMqiDesc.textContent, '$300.0K is unverified (data missing or not expanded) and left out of the score');
    }),
    T('HHI: UNKNOWN і UNALLOCATED -> N/A; при неперевіреній частці - "verified capital"', ({ populateAuditModal: f, __state: s }) => {
      const D = s.DOM;
      f(audit({}, { hhi: { tier: 'UNKNOWN', hhi: 0.9, breakdown: [] } }));
      assert.equal(D.riskHhiVal.textContent, 'N/A'); assert.equal(D.riskHhiBar.style.width, '0%');
      assert.equal(D.riskHhiDesc.textContent, 'No capital could be verified yet');
      assert.equal(D.riskEffectiveAssets.textContent, '0 Effective Assets');
      assert.match(D.riskCollateralList.innerHTML, /No active collateral backing recorded/);
      f(audit({}, { hhi: { tier: 'UNALLOCATED' } }));
      assert.equal(D.riskHhiDesc.textContent, 'No active collateral backing');
      f(audit({}, { hhi: { unverifiedPercent: 10, hhi: 1.5 } }));
      assert.equal(D.riskHhiDesc.textContent, 'Top collateral: WETH (50% of verified capital)');
      assert.equal(D.riskHhiBar.style.width, '100%');
      f(audit({}, { hhi: { topCollateral: { symbol: 'None' } } }));
      assert.equal(D.riskHhiDesc.textContent, 'Herfindahl-Hirschman single-asset concentration index');
    }),
    T('невідомий вихід: Exit Cap N/A, поповер без оцінки, стан виходу null', ({ populateAuditModal: f, __state: s }) => {
      const D = s.DOM;
      f(audit({}, { liquidity: { instantExitCapacityPercent: null, stressedExitCapacityPercent: undefined } }));
      assert.equal(D.modalExitCapPct.textContent, 'Exit Cap N/A');
      assert.equal(D.riskExitPopoverBody.textContent, 'Worst-case exit cannot be estimated: liquidity data for this vault is unavailable.');
      assert.equal(D.riskExitPct.textContent, 'N/A');
      assert.equal(s.currentModalExitState.normalExitPct, null);
      assert.equal(s.currentModalExitState.dropPct, 0);
    }),
    T('стресовий вихід: падіння, конкурент екранується, кнопка поповера скинута', ({ populateAuditModal: f, __state: s }) => {
      const D = s.DOM;
      D.riskExitInfoBtn.classList.add('active');
      f(audit({}, { liquidity: { instantExitCapacityPercent: 40, stressedExitCapacityPercent: 25.04, stressedExitCapacityUsd: 2.5e6,
        crowdedMarkets: [{ topPeers: ['<b>Peer</b>'] }] } }));
      assert.equal(s.currentModalExitState.dropPct, 15);
      assert.equal(s.currentModalExitState.topPeer, '<b>Peer</b>');
      const html = D.riskExitPopoverBody.innerHTML;
      assert.ok(html.includes('(&lt;b&gt;Peer&lt;/b&gt;)'));
      assert.ok(html.includes('<strong>40%</strong> to <strong>25.04%</strong> ($2.50M)'));
      assert.equal(D.riskExitInfoBtn.classList.contains('active'), false);
      assert.equal(D.riskExitInfoBtn.getAttribute('aria-expanded'), 'false');
    }),
    T('таблиця ринків: FLAGGED, UNVERIFIED, CLEAN, неявний прапорець і n/a для LLTV', ({ populateAuditModal: f, __state: s }) => {
      const rows = collect(s.DOM.allocationsTbody);
      const created = [];
      const origCreate = document.createElement;
      document.createElement = tag => { const e = origCreate(tag); created.push(e); return e; };
      f(audit({ totalAssetsUsd: 1e6 }, {}, [
        { collateralSymbol: 'WETH', lltvPercent: 86, weight: 0.5, supplyAssetsUsd: 5e5, marketFreeLiquidityUsd: 1e5, isFlagged: true, supplyApy: 0.0412 },
        { collateralSymbol: 'cbBTC', lltvPercent: null, weight: 0.2, supplyAssetsUsd: 2e5, isFlagged: false, isUnverified: true },
        { collateralSymbol: '<img src=x>', lltvPercent: 77, weight: 0.1, supplyAssetsUsd: 1e5, isClean: true },
        { collateralSymbol: 'PT', weight: 0.2, supplyAssetsUsd: 2e5, isClean: false },
        { weight: 0, supplyAssetsUsd: 5000, isClean: false }
      ]));
      assert.equal(s.DOM.overviewMarketsCount.textContent, '5 MARKETS');
      assert.equal(rows.length, 5);
      const status = r => r.innerHTML.match(/badge-status[^>]*>(\w+)</)[1];
      assert.deepEqual(rows.map(status), ['FLAGGED', 'UNVERIFIED', 'CLEAN', 'FLAGGED', 'CLEAN']);
      assert.match(rows[0].innerHTML, /<td>86%<\/td>[\s\S]*<td>50\.0%<\/td>[\s\S]*\$500\.0K[\s\S]*\$100\.0K[\s\S]*4\.12%/);
      assert.match(rows[1].innerHTML, /<td>n\/a<\/td>/);
      assert.match(rows[1].innerHTML, /<td>—<\/td>/); // невідома вільна ліквідність
      assert.ok(rows[2].innerHTML.includes('&lt;img src=x&gt;'));
      assert.ok(rows[4].innerHTML.includes('<strong>None</strong>'));
      assert.ok(created.length >= 5);
    }),
    T('червоні прапорці: рівень у класі, текст екранується, без рівня - info', ({ populateAuditModal: f, __state: s }) => {
      const flags = collect(s.DOM.riskFlagsList);
      f(audit({}, { redFlags: [{ level: 'CRITICAL', title: 'Bad <debt>', message: 'x & y' }, { title: 'Note' }] }));
      assert.equal(flags.length, 2);
      assert.equal(flags[0].className, 'flag-item critical');
      assert.equal(flags[0].innerHTML, '<strong>Bad &lt;debt&gt;:</strong> x &amp; y');
      assert.equal(flags[1].className, 'flag-item info');
    }),
    T('вкладки скидаються на Overview лише при першому відкритті, не при тихому оновленні', ({ populateAuditModal: f }) => {
      const tab = (id, active) => { const t = makeElement(); t.dataset = { tab: id }; if (active) t.classList.add('active'); return t; };
      const panel = (id, active) => { const p = makeElement(); p.id = id; if (active) p.classList.add('active'); return p; };
      const tabs = [tab('tab-overview'), tab('tab-risk', true)], panels = [panel('tab-overview'), panel('tab-risk', true)];
      document.querySelectorAll = sel => (sel === '.audit-nav-tab' ? tabs : sel === '.audit-tab-panel' ? panels : []);
      f(audit(), true);
      assert.equal(tabs[1].classList.contains('active'), true);
      f(audit());
      assert.deepEqual(tabs.map(t => t.classList.contains('active')), [true, false]);
      assert.deepEqual(tabs.map(t => t.getAttribute('aria-selected')), ['true', 'false']);
      assert.deepEqual(panels.map(p => p.classList.contains('active')), [true, false]);
    }),
    T('кількість токенів з totalAssets і decimals, якщо totalAssetsHuman відсутній', ({ populateAuditModal: f, __state: s }) => {
      f(audit({ totalAssets: '2500000000000000000', asset: { symbol: 'WETH', decimals: 18 } }));
      assert.equal(s.DOM.modalAssetsHuman.textContent, '2.50 WETH');
      f(audit({ totalAssets: undefined, asset: undefined }));
      assert.equal(s.DOM.modalAssetsHuman.textContent, '0.00 ');
    }),
  ],
  setupModalEvents: [
    T('кнопки модалки: закриття, обране, поповер стресового виходу', ({ setupModalEvents: f, closeVaultAudit, __state: s }) => {
      const D = s.DOM;
      for (const e of [D.closeBtn, D.modalFavBtn, D.riskExitInfoBtn, D.riskExitLabel]) { e.handlers = {}; e.addEventListener = (t, fn) => { e.handlers[t] = fn; }; }
      f();
      assert.equal(D.closeBtn.handlers.click, closeVaultAudit);
      D.modalFavBtn.handlers.click();
      assert.equal(localStorage.getItem('cym_pinned_vaults'), null); // нічого не вибрано
      s.selectedVaultAddress = '0xA';
      D.modalFavBtn.handlers.click();
      assert.deepEqual(pinned(), ['0xa']);

      s.currentModalExitState = { normalExitPct: 40, normalExitUsd: 1, stressedExitPct: 20, stressedExitUsd: 1, dropPct: 20, topPeer: '' };
      D.riskExitInfoBtn.handlers.mouseenter();
      assert.match(D.riskExitPct.innerHTML, /STRESSED/);
      D.riskExitInfoBtn.handlers.mouseleave();
      assert.equal(D.riskExitPct.textContent, '40%');
      D.riskExitInfoBtn.handlers.click({ stopPropagation() {} });
      assert.equal(D.riskExitInfoBtn.classList.contains('active'), true);
      D.riskExitPct.textContent = 'sticky';
      D.riskExitInfoBtn.handlers.mouseleave(); // активний поповер тримає стресовий показ
      assert.equal(D.riskExitPct.textContent, 'sticky');
      D.riskExitPct.innerHTML = '';
      D.riskExitLabel.handlers.mouseenter();
      assert.match(D.riskExitPct.innerHTML, /STRESSED/);
    }),
    T('клік поза поповером закриває його', ({ setupModalEvents: f, __state: s }) => {
      const docHandlers = {};
      document.addEventListener = (t, fn) => { docHandlers[t] = fn; };
      f();
      s.DOM.riskExitInfoBtn.classList.add('active');
      docHandlers.click({ target: { closest: () => ({}) } }); // клік усередині .info-circle-wrap
      assert.equal(s.DOM.riskExitInfoBtn.classList.contains('active'), true);
      docHandlers.click({ target: { closest: () => null } });
      assert.equal(s.DOM.riskExitInfoBtn.classList.contains('active'), false);
    }),
    T('Escape закриває по одному шару: поповер, dropdown, пошук, очікуване відкриття, модалку', ({ setupModalEvents: f, __state: s }) => {
      const win = {};
      globalThis.addEventListener = (t, fn) => { win[t] = fn; };
      f();
      const esc = () => win.keydown({ key: 'Escape' });
      const D = s.DOM;

      D.riskExitInfoBtn.classList.add('active');
      document.querySelector = () => { throw new Error('не мав дійти до dropdown'); };
      esc();
      assert.equal(D.riskExitInfoBtn.classList.contains('active'), false);

      const x = fakeDropdown('asset', []);
      x.dd.classList.add('open');
      let triggerFocused = 0;
      x.trigger.focus = () => { triggerFocused++; };
      document.querySelector = sel => (sel === '.custom-dropdown.open' ? x.dd : null);
      document.querySelectorAll = sel => (sel === '.custom-dropdown.open' ? [x.dd] : []);
      esc();
      assert.equal(x.dd.classList.contains('open'), false);
      assert.equal(triggerFocused, 1);

      document.querySelector = () => null;
      document.querySelectorAll = () => [];
      document.activeElement = D.searchInput;
      D.searchInput.value = 'abc'; s.explorerFilters.query = 'abc';
      esc();
      assert.equal(D.searchInput.value, ''); assert.equal(s.explorerFilters.query, '');

      document.activeElement = null;
      s.isTransitioningVault = true;
      const token = s.auditOpenToken;
      esc();
      assert.equal(s.auditOpenToken, token + 1);
      assert.equal(s.isTransitioningVault, false);

      s.REDUCED_MOTION.matches = true;
      s.selectedVaultAddress = '0xA';
      D.auditModal.classList.remove('hidden');
      esc();
      assert.equal(D.auditModal.classList.contains('hidden'), true);
      assert.equal(s.selectedVaultAddress, null);
    }),
    T('інші клавіші ігноруються', ({ setupModalEvents: f, __state: s }) => {
      const win = {};
      globalThis.addEventListener = (t, fn) => { win[t] = fn; };
      f();
      s.DOM.riskExitInfoBtn.classList.add('active');
      win.keydown({ key: 'Enter' });
      assert.equal(s.DOM.riskExitInfoBtn.classList.contains('active'), true);
    }),
  ],
  setupAuditNavTabs: [
    T('клік по вкладці активує її і панель, знімає активність з інших', ({ setupAuditNavTabs: f }) => {
      const mk = id => { const t = capEl(); t.dataset = { tab: id }; return t; };
      const tabs = [mk('tab-overview'), mk('tab-risk')];
      tabs[0].classList.add('active');
      const panels = [makeElement(), document.getElementById('tab-risk')];
      panels[0].classList.add('active');
      document.querySelectorAll = sel => (sel === '.audit-nav-tab' ? tabs : sel === '.audit-tab-panel' ? panels : []);
      f();
      tabs[1].handlers.click();
      assert.deepEqual(tabs.map(t => t.classList.contains('active')), [false, true]);
      assert.deepEqual(tabs.map(t => t.getAttribute('aria-selected')), ['false', 'true']);
      assert.equal(panels[0].classList.contains('active'), false);
      assert.equal(document.getElementById('tab-risk').classList.contains('active'), true);
    }),
    T('без вкладок нічого не реєструє і не кидає', ({ setupAuditNavTabs: f }) => {
      document.querySelectorAll = () => [];
      assert.doesNotThrow(() => f());
    }),
  ],

  // ---------- Чисті утиліти ----------
  formatCurrency: [
    ['межі одиниць: 999.95 -> K, 999950 -> M, 999.95M -> B, 999.95B -> T', ({ formatCurrency: f }) => {
      assert.equal(f(999.94), '$999.94');
      assert.equal(f(999.95), '$1.0K');
      assert.equal(f(1234.5), '$1.2K');
      assert.equal(f(999949), '$999.9K');
      assert.equal(f(999950), '$1.00M');
      assert.equal(f(2.5e9), '$2.50B');
      assert.equal(f(999.95e9), '$1.00T');
      assert.equal(f(1e15), '$1000.00T');
    }],
    ['нуль, -0, копійки і менше цента', ({ formatCurrency: f }) => {
      assert.equal(f(0), '$0.00'); assert.equal(f(-0), '$0.00');
      assert.equal(f(0.01), '$0.01'); assert.equal(f(0.004), '< $0.01');
      assert.equal(f(12.346), '$12.35');
    }],
    ['відʼємні суми зберігають знак перед $', ({ formatCurrency: f }) => {
      assert.equal(f(-1500), '-$1.5K'); assert.equal(f(-2e6), '-$2.00M'); assert.equal(f(-5), '-$5.00');
    }],
    ['null, undefined, порожній рядок, NaN, Infinity, текст -> fallback', ({ formatCurrency: f }) => {
      for (const bad of [null, undefined, '', NaN, Infinity, -Infinity, 'abc']) assert.equal(f(bad), '—', String(bad));
      assert.equal(f(null, 'n/a'), 'n/a');
    }],
    ['числовий рядок приймається', ({ formatCurrency: f }) => assert.equal(f('1000000'), '$1.00M')],
  ],
  formatNumber: [
    ['одиниці K/M/B/T і межі округлення', ({ formatNumber: f }) => {
      assert.equal(f(999.94), '999.94'); assert.equal(f(999.95), '1.0K'); assert.equal(f(1234567), '1.23M');
      assert.equal(f(999950), '1.00M'); assert.equal(f(3e9), '3.00B'); assert.equal(f(4e12), '4.00T');
    }],
    ['відʼємні, нуль і дрібні значення без префікса "<"', ({ formatNumber: f }) => {
      assert.equal(f(-2e6), '-2.00M'); assert.equal(f(-12.5), '-12.50');
      assert.equal(f(0), '0.00'); assert.equal(f(0.004), '0.00');
    }],
    ['некоректні значення -> fallback', ({ formatNumber: f }) => {
      for (const bad of [null, undefined, '', NaN, Infinity, 'x']) assert.equal(f(bad), '—', String(bad));
      assert.equal(f(undefined, '?'), '?');
      assert.equal(f('42'), '42.00');
    }],
  ],
  formatPercent: [
    ['частка -> відсотки з двома знаками за замовчуванням', ({ formatPercent: f }) => {
      assert.equal(f(0.05), '5.00%'); assert.equal(f(1), '100.00%'); assert.equal(f(0), '0.00%');
      assert.equal(f(-0.001), '-0.10%'); assert.equal(f('0.1'), '10.00%');
    }],
    ['кількість знаків задається, крихітний мінус не дає "-0"', ({ formatPercent: f }) => {
      assert.equal(f(0.123456, 1), '12.3%');
      assert.equal(f(-0.00001), '0.00%');
      assert.equal(f(-0.001, 0), '0%');
      assert.equal(f(-0.01, 0), '-1%');
    }],
    ['некоректні значення -> fallback', ({ formatPercent: f }) => {
      for (const bad of [null, undefined, '', NaN, Infinity, 'abc']) assert.equal(f(bad), '—', String(bad));
      assert.equal(f(null, 2, 'n/a'), 'n/a');
    }],
  ],
  exitMetric: [
    ['відсутнє поле -> undefined (можна брати запасне)', ({ exitMetric: f }) => assert.equal(f(undefined), undefined)],
    ['явно невідоме: null, "", "unknown", NaN, Infinity -> null', ({ exitMetric: f }) => {
      for (const v of [null, '', 'unknown', NaN, Infinity, -Infinity]) assert.equal(f(v), null, String(v));
    }],
    ['числа і числові рядки, включно з 0 і відʼємними', ({ exitMetric: f }) => {
      assert.equal(f(42.5), 42.5); assert.equal(f('42'), 42); assert.equal(f(0), 0); assert.equal(f(-5), -5);
    }],
  ],
  mqiSortKey: [
    ['невідомий MQI -> -1, відсутній -> 100', ({ mqiSortKey: f }) => {
      assert.equal(f({ mqiPercent: null }), -1);
      assert.equal(f({}), 100);
    }],
    ['100 з позначеним ринком -> 99.95 (нижче чистих), інакше саме значення', ({ mqiSortKey: f }) => {
      assert.equal(f({ mqiPercent: 100, isAllClean: false }), 99.95);
      assert.equal(f({ mqiPercent: 100, isAllClean: true }), 100);
      assert.equal(f({ mqiPercent: 100 }), 100);
      assert.equal(f({ mqiPercent: 87.5, isAllClean: false }), 87.5);
      assert.equal(f({ mqiPercent: 0 }), 0);
    }],
  ],
  firstDefined: [
    ['null - справжня відповідь, undefined пропускається', ({ firstDefined: f }) => {
      assert.equal(f(undefined, null, 1), null);
      assert.equal(f(undefined, 0, 1), 0);
      assert.equal(f(undefined, '', 'x'), '');
      assert.equal(f(undefined, false), false);
    }],
    ['усі undefined або без аргументів -> undefined', ({ firstDefined: f }) => {
      assert.equal(f(), undefined);
      assert.equal(f(undefined, undefined), undefined);
    }],
  ],
  mqiBadgeInfo: [
    ['невідомий MQI: Unpriced або Unverified, ніколи не clean', ({ mqiBadgeInfo: f }) => {
      assert.deepEqual(f(null, true, false, true), { text: 'Unpriced', clean: false });
      assert.deepEqual(f(undefined, true, false, false), { text: 'Unverified', clean: false });
      assert.deepEqual(f(null, true), { text: 'Unverified', clean: false });
    }],
    ['100 і не позначений (true або undefined) -> "100% Clean"', ({ mqiBadgeInfo: f }) => {
      assert.deepEqual(f(100, true), { text: '100% Clean', clean: true });
      assert.deepEqual(f(100, undefined), { text: '100% Clean', clean: true });
    }],
    ['100 з isAllClean false: Flagged або Unverified залежно від позначених ринків', ({ mqiBadgeInfo: f }) => {
      assert.deepEqual(f(100, false, true), { text: 'Flagged', clean: false });
      assert.deepEqual(f(100, false), { text: 'Flagged', clean: false });
      assert.deepEqual(f(100, false, false), { text: 'Unverified', clean: false });
    }],
    ['нижче 100 -> "<n>% MQI", навіть якщо isAllClean true; NaN не стає clean', ({ mqiBadgeInfo: f }) => {
      assert.deepEqual(f(87.5, false), { text: '87.5% MQI', clean: false });
      assert.deepEqual(f(99.9, true), { text: '99.9% MQI', clean: false });
      assert.deepEqual(f(0, true), { text: '0% MQI', clean: false });
      assert.equal(f(NaN, true).clean, false);
    }],
  ],
  pickExitMetric: [
    ['перше значення з полем; явне невідоме зупиняє ланцюжок', ({ pickExitMetric: f }) => {
      assert.equal(f(undefined, 33, 10), 33);
      assert.equal(f(undefined, null, 10), null);
      assert.equal(f('unknown', 10), null);
      assert.equal(f(0, 50), 0);
      assert.equal(f(undefined, '7'), 7);
    }],
    ['нічого не задано -> undefined', ({ pickExitMetric: f }) => {
      assert.equal(f(), undefined);
      assert.equal(f(undefined, undefined), undefined);
    }],
  ],
  formatExitCap: [
    ['число -> "<n>% Exit Cap", невідоме -> "Exit Cap N/A"', ({ formatExitCap: f }) => {
      assert.equal(f(40), '40% Exit Cap'); assert.equal(f(0), '0% Exit Cap'); assert.equal(f(12.5), '12.5% Exit Cap');
      assert.equal(f(null), 'Exit Cap N/A'); assert.equal(f(undefined), 'Exit Cap N/A');
    }],
  ],
  escapeHtml: [
    ['екранує всі пʼять спецсимволів', ({ escapeHtml: f }) => {
      assert.equal(f(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;&lt;/a&gt;');
    }],
    ['XSS-рядки не містять активних тегів чи лапок', ({ escapeHtml: f }) => {
      for (const xss of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', `' onmouseover='alert(1)`]) {
        const out = f(xss);
        assert.ok(!/[<>"']/.test(out), out);
      }
      assert.equal(f('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    }],
    ['вже екрановане екранується повторно (& першим)', ({ escapeHtml: f }) => assert.equal(f('&amp;'), '&amp;amp;')],
    ['порожні значення -> "", числа перетворюються на рядок', ({ escapeHtml: f }) => {
      for (const v of [null, undefined, '']) assert.equal(f(v), '');
      assert.equal(f(42), '42');
      assert.equal(f('plain text'), 'plain text');
    }],
  ],
};

// Знайдені дефекти: кейси правильної поведінки, які зараз падають. Не входять у default export.
export const knownBugs = {
  updateActiveFilterChips: [
    // BUG: sortLabels не знає сортувань mqi_asc/mqi_desc/hhi_desc/hhi_asc з dropdown, чіп показує сирий ключ
    T('чіп сортування mqi_asc має підпис з dropdown', ({ updateActiveFilterChips: f, __state: s }) => {
      s.explorerFilters.sort = 'mqi_asc';
      f();
      assert.ok(s.DOM.chipsContainer.innerHTML.includes('>Market Quality: Flagged First<'));
    }),
    // BUG: hasActiveFilters не враховує pinnedOnly, тож чіп "Favorites" не показується, коли це єдиний фільтр
    T('лише фільтр обраних показує чіп Favorites', ({ updateActiveFilterChips: f, __state: s }) => {
      s.explorerFilters.pinnedOnly = true;
      f();
      assert.equal(s.DOM.activeFilterChips.classList.contains('hidden'), false);
      assert.ok(s.DOM.chipsContainer.innerHTML.includes('Favorites'));
    }),
  ],
  applyVaultAuditData: [
    // BUG: liquidityUsd === null дає (null / tvl) * 100 = 0 -> "0% Exit Cap" замість "Exit Cap N/A" (renderPinnedRichPills це обробляє)
    T('невідома ліквідність без метрики виходу -> "Exit Cap N/A"', ({ applyVaultAuditData: f, __state: s }) => {
      s.allVaults = [cv({ exitCapPercent: undefined })];
      pin('0xaaa1');
      const p = fakePillCard();
      s.DOM.pinnedRichPills.querySelector = () => p.card;
      const data = audit({ liquidityUsd: null });
      data.verdict.liquidity = {};
      f('0xAAA1', data);
      assert.equal(p.sub(1), 'Exit Cap N/A');
    }),
  ],
  populateBasicVaultInfo: [
    // BUG: `v.asset?.decimals || 6` підставляє 6 для токена з 0 знаків (populateAuditModal використовує ?? 6)
    T('токен з 0 знаків: totalAssets "5" -> "5.00 X"', ({ populateBasicVaultInfo: f, __state: s }) => {
      f(cv({ totalAssets: '5', asset: { symbol: 'X', decimals: 0 } }));
      assert.equal(s.DOM.modalAssetsHuman.textContent, '5.00 X');
    }),
  ],
  escapeHtml: [
    // BUG: `if (!str) return ''` перетворює число 0 на порожній рядок
    ['0 -> "0"', ({ escapeHtml: f }) => assert.equal(f(0), '0')],
  ],
};
