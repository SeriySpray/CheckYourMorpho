import assert from 'node:assert/strict';
import { makeElement, makeClassList } from '../clientEnv.js';
import { jsonResponse } from '../fixtures.js';

// Справжній таймер для очікувань усередині кейсу (глобальний setTimeout у кейсах підмінюється).
const realSetTimeout = globalThis.setTimeout;
const sleep = ms => new Promise(r => realSetTimeout(r, ms));
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const DEFAULT_FILTERS = { query: '', network: 'all', asset: 'all', curator: 'all', sort: 'tvl_desc', pinnedOnly: false, showTiny: false };
const OVERRIDES = ['addEventListener', 'appendChild', 'querySelector', 'querySelectorAll', 'focus', 'blur', 'click', 'getContext', 'parentElement', 'scrollWidth'];

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
  s.isPollingActive = false; s.sphere = sphereStub(); s.pinnedSource = [];
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
  address: '0xAAA1', name: 'Steakhouse USDC', chainId: 1, version: 'v1', isListed: true, curatorName: 'Steakhouse Financial',
  asset: { symbol: 'USDC', decimals: 6, priceUsd: 1 }, totalAssetsUsd: 10e6, totalAssets: '10000000000000',
  liquidityUsd: 4e6, netApy: 0.05, fee: 0.1, mqiPercent: 100, isAllClean: true, exitCapPercent: 40,
  flagCount: 0, worstFlagLevel: null, worstFlagTitle: null, ...over
});
const verdictOf = (over = {}) => ({
  mqi: { mqiPercent: 100, isAllClean: true, compromisedMarkets: [], compromisedPercent: 0, unverifiedPercent: 0, unpriced: false, ...over.mqi },
  liquidity: { instantExitCapacityPercent: 40, instantExitCapacityUsd: 4e6, ...over.liquidity },
  collateral: {
    tier: 'ALLOCATED', unverifiedPercent: 0,
    tokens: [{ symbol: 'WETH', usd: 5e6, percent: 50 }, { symbol: 'NEW', usd: 2.5e6, percent: 25 }], ...over.collateral
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
  const trigger = capEl(), valEl = makeElement(), menu = capEl();
  valEl.textContent = 'initial';
  const items = entries.map(([value, label]) => {
    const item = capEl();
    item.setAttribute('data-value', value);
    const span = makeElement(); span.textContent = `  ${label}  `;
    item.querySelector = s => (s === '.item-text' ? span : null);
    return item;
  });
  menu.querySelectorAll = s => (s === '.dropdown-item' ? items : []);
  const clickItem = (item, ev) => menu.handlers.click({ ...ev, target: { closest: () => item } });
  const dd = fakeNode({ '.dropdown-trigger': trigger, '.trigger-value': valEl, '.dropdown-menu': menu, '.dropdown-item': items });
  dd.setAttribute('data-filter', filter);
  return { dd, trigger, valEl, items, clickItem };
}

const pin = (...addrs) => localStorage.setItem('cym_pinned_vaults', JSON.stringify(addrs));
const pinned = () => JSON.parse(localStorage.getItem('cym_pinned_vaults') || '[]');
const lastCall = (sphere, kind) => sphere.calls.filter(c => c[0] === kind).at(-1);

const base = {
  // ---------- Кеш аудитів ----------
  syncFavFilterButton: [
    T('зірка натиснута лише коли фільтр обраних увімкнено і видно таблицю, а не панель активності', ({ syncFavFilterButton: f, __state: s }) => {
      const btn = s.DOM.explorerFavFilterBtn;
      const pressed = () => [btn.classList.contains('active'), btn.getAttribute('aria-pressed')];
      s.DOM.activityPanel.classList.add('hidden');
      s.explorerFilters.pinnedOnly = false;
      f();
      assert.deepEqual(pressed(), [false, 'false']);
      s.explorerFilters.pinnedOnly = true;
      f();
      assert.deepEqual(pressed(), [true, 'true']);
      s.DOM.activityPanel.classList.remove('hidden');
      f();
      assert.deepEqual(pressed(), [false, 'false']);
    }),
  ],
  onActivityPanelToggle: [
    T('закриття панелі активності повертає чипи активних фільтрів, відкриття їх не чіпає', ({ onActivityPanelToggle: f, __state: s }) => {
      s.explorerFilters.pinnedOnly = true;
      s.DOM.activityPanel.classList.remove('hidden');
      s.DOM.activeFilterChips.classList.add('hidden');
      f();
      assert.ok(s.DOM.activeFilterChips.classList.contains('hidden'));
      s.DOM.activityPanel.classList.add('hidden');
      f();
      assert.ok(!s.DOM.activeFilterChips.classList.contains('hidden'));
      assert.match(s.DOM.chipsContainer.innerHTML, /Favorites/);
    }),
  ],
  renderHeaderStatus: [
    T('час від останнього синку: щойно, хвилини; без відповіді /api/status - лічильник vault', ({ renderHeaderStatus: f, __state: s }) => {
      s.allVaults = [cv(), cv()];
      s.lastSyncIso = null;
      f();
      assert.equal(s.DOM.headerStatusText.textContent, 'Live: 2 Vaults');
      s.lastSyncIso = new Date(Date.now() - 30000).toISOString();
      f();
      assert.equal(s.DOM.headerStatusText.textContent, 'Synced just now');
      s.lastSyncIso = new Date(Date.now() - 5 * 60000).toISOString();
      f();
      assert.equal(s.DOM.headerStatusText.textContent, 'Synced 5m ago');
      s.lastSyncIso = null;
    }),
  ],
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
      s.lastSyncIso = null; // module state survives between cases
      s.allVaults = [cv()];
      env.fetch(url => (url.startsWith('/api/vaults?') ? jsonResponse({ vaults: [cv(), cv({ address: '0xB' }), cv({ address: '0xC' })] }) : jsonResponse({})));
      f();
      s.DOM.vaultExplorerWidget.scrollTop = 123;
      await env.timers[0].fn();
      assert.equal(s.allVaults.length, 3);
      assert.equal(s.DOM.headerStatusText.textContent, 'Live: 3 Vaults');
      assert.deepEqual(lastCall(s.sphere, 'setVaults'), ['setVaults', 3]);
      assert.equal(s.DOM.vaultExplorerWidget.scrollTop, 123);
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
    ['назва куратора береться лише з API: назва vault її не підміняє', ({ formatCuratorName: f }) => {
      assert.equal(f('Anthias Labs'), 'Anthias Labs');
      assert.equal(f('Sentora'), 'Sentora');
      assert.equal(f('Gauntlet', 'Steakhouse USDC'), 'Gauntlet');
    }],
    ['порожній, Independent, Permissionless -> "Independent"', ({ formatCuratorName: f }) => {
      for (const n of [undefined, null, '', 'Independent', 'Permissionless']) assert.equal(f(n), 'Independent');
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
      Object.assign(s.explorerFilters, { network: '8453', asset: 'USDC', curator: 'Re7 Labs', sort: 'apy_desc' });
      f();
      const html = s.DOM.chipsContainer.innerHTML;
      assert.equal(s.DOM.activeFilterChips.classList.contains('hidden'), false);
      for (const t of ['>BASE<', '>USDC<', '>Re7 Labs<', '>APY: High to Low<', 'data-clear="network"', 'data-clear="sort"']) assert.ok(html.includes(t), t);
      assert.ok(!html.includes('Favorites'));
    }),
    T('значення фільтра екрануються (XSS), невідомий куратор показується як є', ({ updateActiveFilterChips: f, __state: s }) => {
      Object.assign(s.explorerFilters, { asset: '<img src=x onerror=alert(1)>', curator: 'MEV Capital' });
      f();
      const html = s.DOM.chipsContainer.innerHTML;
      assert.ok(!html.includes('<img'));
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
      assert.ok(html.includes('>MEV Capital<'));
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
    T('перемикач малих vault (switch): клік вмикає і вимикає показ, список перемальовується', ({ setupVaultExplorerEvents: f, __state: s }) => {
      const t = s.DOM.explorerTinyToggle;
      t.handlers = {}; t.addEventListener = (e, fn) => { t.handlers[e] = fn; };
      s.allVaults = [cv({ address: '0x1', totalAssetsUsd: 5 }), cv({ address: '0x2', totalAssetsUsd: 5e6 })];
      f();
      const count = () => { const rows = collectRows(); s.DOM.explorerTinyToggle.handlers.click(); return rows.length; };
      assert.equal(s.explorerFilters.showTiny, false);
      count();
      assert.equal(s.explorerFilters.showTiny, true);
      assert.equal(s.DOM.explorerCount.textContent, '2 Vaults');
      count();
      assert.equal(s.explorerFilters.showTiny, false);
      assert.equal(s.DOM.explorerCount.textContent, '1 Vaults');
    }),
    T('dropdown: тригер відкриває/закриває, пункт задає фільтр, клік поза меню закриває', ({ setupVaultExplorerEvents: f, __state: s }) => {
      const x = fakeDropdown('asset', [['all', 'All'], ['USDC', 'USDC']]);
      const docHandlers = {};
      document.addEventListener = (t, fn) => { docHandlers[t] = fn; };
      document.querySelectorAll = sel => (sel === '.custom-dropdown' ? [x.dd] : sel === '.custom-dropdown.open' && x.dd.classList.contains('open') ? [x.dd] : []);
      document.querySelector = sel => (sel.includes('data-filter="asset"') ? x.dd : null);
      s.allVaults = [cv({ asset: { symbol: 'USDC' } })]; // a value absent from the data is reset to 'all'
      f();
      const ev = { stopPropagation() {}, preventDefault() {}, detail: 1 };
      x.trigger.handlers.click(ev);
      assert.equal(x.dd.classList.contains('open'), true);
      assert.equal(x.trigger.getAttribute('aria-expanded'), 'true');
      x.trigger.handlers.click(ev);
      assert.equal(x.dd.classList.contains('open'), false);

      x.trigger.handlers.click(ev);
      x.clickItem(x.items[1], ev);
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
      Object.assign(s.explorerFilters, { query: 'keep', network: '1', asset: 'ETH', curator: 're7', sort: 'apy_desc', pinnedOnly: true, showTiny: true });
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
    ['ключ активу: регістр і знак Tether (USD₮0) нормалізуються, часткове входження не рахується', ({ matchesAssetFilter: f }) => {
      assert.equal(f('usdc', 'USDC'), true); assert.equal(f('USD₮0', 'USDT0'), true);
      assert.equal(f('wstETH', 'ETH'), false); assert.equal(f('USDC.e', 'USDC'), false);
    }],
    ['точний збіг ключа: різні активи не змішуються', ({ matchesAssetFilter: f }) => {
      assert.equal(f('USDT', 'USDC'), false); assert.equal(f('PYUSD', 'USDG'), false); assert.equal(f('USDC', 'USDC'), true);
    }],
  ],
  matchesCuratorFilter: [
    ['без фільтра або "all" -> true', ({ matchesCuratorFilter: f }) => {
      for (const filter of [undefined, '', 'all']) assert.equal(f({}, filter), true);
    }],
    ['збіг за відображуваним іменем куратора з API, назва vault не береться до уваги', ({ matchesCuratorFilter: f }) => {
      assert.equal(f({ curatorName: 'Gauntlet' }, 'Gauntlet'), true);
      assert.equal(f({ curatorName: 'Independent' }, 'Independent'), true);
      assert.equal(f({ curatorName: null }, 'Independent'), true);
      assert.equal(f({ name: 'Morpho USDC', curatorName: 'Anthias Labs' }, 'Morpho Flagship'), false);
    }],
    ['чужий куратор, порожній vault і невідомий фільтр -> false', ({ matchesCuratorFilter: f }) => {
      assert.equal(f({ curatorName: 'Gauntlet' }, 'Steakhouse Financial'), false);
      assert.equal(f({ curatorName: 'X' }, 'unknown'), false);
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
  applyPinnedAddresses: [
    T('записує список без дублів у нижньому регістрі і перемальовує', ({ applyPinnedAddresses: f }) => {
      f(['0xABC', '0xabc', '0xdef']);
      assert.equal(localStorage.getItem('cym_pinned_vaults'), '["0xabc","0xdef"]');
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
        liquidity: { instantExitCapacityPercent: 33, instantExitCapacityUsd: 660000 }
      });
      f('0xaaa1', data);
      assert.equal(s.clientAuditCache.get('0xaaa1'), data);
      assert.equal(data.cachedAt, 5000);
      assert.equal(item.totalAssetsUsd, 2e6); assert.equal(item.netApy, 0.07);
      assert.equal(item.mqiPercent, 87.5); assert.equal(item.isAllClean, false);
      assert.equal(item.compromisedCount, 2); assert.equal(item.compromisedPercent, 12.5); assert.equal(item.unverifiedPercent, 1);
      assert.equal(item.isUnpriced, false); assert.equal(item.exitCapPercent, 33); assert.equal(item.exitCapUsd, 660000);
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
    T('картка закріпленого vault отримує свіжі значення і бейдж без прапорців', ({ applyVaultAuditData: f, __state: s }) => {
      s.allVaults = [cv()];
      pin('0xaaa1');
      const p = fakePillCard();
      s.DOM.pinnedRichPills.querySelector = sel => (sel.includes('0xAAA1') ? p.card : null);
      f('0xAAA1', audit({ totalAssetsUsd: 2e6, liquidityUsd: 5e5, netApy: 0.0425, fee: 0.15, totalAssets: '2000000000000' }));
      assert.equal(p.badge.textContent, 'No flags');
      assert.equal(p.badge.className, 'rich-pill-mqi-badge none');
      assert.equal(p.val(0), '$2.00M'); assert.equal(p.sub(0), '2.00M USDC');
      assert.equal(p.val(1), '$500.0K'); assert.equal(p.sub(1), '40% Exit Cap');
      assert.equal(p.val(2), '4.25%'); assert.equal(p.sub(2), 'Fee: 15.0%');
    }),
    T('картка: прапорець Unpriced Vault -> "No price", невідомий вихід -> "Exit Cap N/A"', ({ applyVaultAuditData: f, __state: s }) => {
      s.allVaults = [cv()];
      pin('0xaaa1');
      const p = fakePillCard();
      s.DOM.pinnedRichPills.querySelector = () => p.card;
      f('0xAAA1', audit({}, { mqi: { mqiPercent: null, isAllClean: false, unpriced: true }, liquidity: { instantExitCapacityPercent: null }, redFlags: [{ level: 'HIGH', title: 'Unpriced Vault' }] }));
      assert.equal(p.badge.textContent, 'No price');
      assert.equal(p.badge.className, 'rich-pill-mqi-badge bad');
      assert.equal(p.sub(1), 'Exit Cap N/A');
    }),
    T('картка: найгірший із кількох прапорців і "+N"', ({ applyVaultAuditData: f, __state: s }) => {
      s.allVaults = [cv()];
      pin('0xaaa1');
      const p = fakePillCard();
      s.DOM.pinnedRichPills.querySelector = () => p.card;
      f('0xAAA1', audit({}, { redFlags: [{ level: 'MEDIUM', title: 'Unverified Markets' }, { level: 'HIGH', title: 'Restricted Exit Liquidity' }] }));
      assert.equal(p.badge.textContent, 'Low exit +1');
      assert.equal(p.badge.className, 'rich-pill-mqi-badge bad');
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
      for (const t of ['badge-chain base">BASE<', 'Steakhouse Financial', 'rich-pill-mqi-badge none">No flags<', '>$10.00M<',
        '>10.00M USDC<', '>$4.00M<', '>40% Exit Cap<', '>5.00%<', '>Fee: 10.0%<', 'data-unpin="0xAAA1"']) assert.ok(html.includes(t), t);
    }),
    T('невідома ліквідність: бейдж за прапорцем списку, "—" і "Exit Cap N/A"', ({ renderPinnedRichPills: f, __state: s }, env) => {
      env.fetch(() => jsonResponse({}, 404));
      s.allVaults = [cv({ address: '0xa', mqiPercent: null, isUnpriced: true, liquidityUsd: null, exitCapPercent: undefined, flagCount: 1, worstFlagLevel: 'high', worstFlagTitle: 'Unpriced Vault' }),
        cv({ address: '0xb', mqiPercent: null, flagCount: 1, worstFlagLevel: 'medium', worstFlagTitle: 'Unverified Markets' })];
      pin('0xa', '0xb');
      const cards = collect(s.DOM.pinnedRichPills);
      f();
      assert.ok(cards[0].innerHTML.includes('bad">No price<'));
      assert.ok(cards[0].innerHTML.includes('>—<'));
      assert.ok(cards[0].innerHTML.includes('>Exit Cap N/A<'));
      assert.ok(cards[1].innerHTML.includes('warn">Partial data<'));
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
    T('без анімації: картки одразу видимі, таймерів немає', ({ renderPinnedRichPills: f, __state: s }, env) => {
      env.fetch(() => jsonResponse({}, 404));
      s.allVaults = [cv({ address: '0xa' }), cv({ address: '0xb' })];
      pin('0xa', '0xb');
      const cards = collect(s.DOM.pinnedRichPills);
      f();
      assert.deepEqual(cards.map(c => c.style.opacity), [undefined, undefined]);
      assert.equal(env.timers.length, 0);
    }),
  ],
  bindPinnedCard: [
    T('картка отримує клік, наведення і вихід курсора', ({ bindPinnedCard: f }) => {
      const seen = [];
      f({ addEventListener: (t) => seen.push(t) }, cv({ address: '0xa' }));
      assert.deepEqual(seen, ['click', 'mouseenter', 'mouseleave']);
    }),
  ],
  updatePinnedCarousel: [
    T('без батьківського елемента або без переповнення копій немає', ({ updatePinnedCarousel: f, __state: s }) => {
      f(); // у фейковому DOM немає батька: не кидає
      const box = s.DOM.pinnedRichPills;
      box.parentElement = { clientWidth: 600 };
      box.scrollWidth = 400;
      s.pinnedSource = [{ card: makeElement(), v: cv({ address: '0xa' }) }];
      f();
      assert.equal(box.classList.contains('is-scrolling'), false);
    }),
    T('переповнення: додає копії, ставить петлю та тривалість і вмикає прокрутку', ({ updatePinnedCarousel: f, __state: s }) => {
      const box = s.DOM.pinnedRichPills;
      const props = {};
      box.style = { setProperty: (k, v) => { props[k] = v; } };
      box.parentElement = { clientWidth: 300 };
      box.scrollWidth = 440;
      const added = collect(box);
      s.pinnedSource = [{ card: makeElement(), v: cv({ address: '0xa' }) }, { card: makeElement(), v: cv({ address: '0xb' }) }];
      f();
      assert.equal(added.length, 2);
      assert.equal(box.classList.contains('is-scrolling'), true);
      assert.equal(props['--pin-loop'], '440px');
      assert.equal(props['--pin-dur'], '20s');
      s.REDUCED_MOTION.matches = true;
      f();
      assert.equal(box.classList.contains('is-scrolling'), false);
    }),
  ],
  nudgePinnedCarousel: [
    T('без працюючої каруселі нічого не робить; з нею зсуває годинник анімації з обгортанням', ({ nudgePinnedCarousel: f, __state: s }) => {
      assert.equal(f(10), false);
      const anim = { currentTime: 1000, effect: { getComputedTiming: () => ({ duration: 60000 }) } };
      s.DOM.pinnedRichPills.getAnimations = () => [anim];
      assert.equal(f(22), true);
      assert.equal(anim.currentTime, 2000);
      f(-100);
      assert.equal(anim.currentTime, 60000 - 2545.4545454545455);
      delete s.DOM.pinnedRichPills.getAnimations;
    }),
  ],
  syncPinnedClones: [
    T('без прокрутки нічого не робить', ({ syncPinnedClones: f, __state: s }) => {
      s.pinnedSource = [{ card: { innerHTML: 'x' } }];
      f();
    }),
  ],
  renderVaultExplorer: [
    T('без фільтрів: усі vault за TVL, лічильники, сфера без підсвічування', ({ renderVaultExplorer: f, __state: s }) => {
      s.allVaults = [cv({ address: '0xs', totalAssetsUsd: 1 }), cv({ address: '0xl', totalAssetsUsd: 9e9 }), cv({ address: '0xm', totalAssetsUsd: 5e6 })];
      pin('0xm');
      const rows = collectRows();
      s.DOM.vaultExplorerWidget.scrollTop = 77;
      f();
      assert.deepEqual(rows.map(r => r.getAttribute('data-address')), ['0xl', '0xm']); // $1 vault is hidden by default
      assert.equal(s.DOM.explorerCount.textContent, '2 Vaults');
      assert.equal(s.DOM.explorerTinyCount.textContent, '(1 vault)');
      assert.equal(s.DOM.explorerTinyToggle.getAttribute('aria-checked'), 'false');
      assert.equal(s.DOM.explorerTinyToggle.classList.contains('hidden'), false);
      assert.equal(s.DOM.explorerFavCount.textContent, 1);
      assert.equal(s.DOM.explorerFavFilterBtn.getAttribute('aria-pressed'), 'false');
      assert.deepEqual(s.sphere.calls.at(-1), ['highlight', null]);
      assert.equal(s.DOM.vaultExplorerWidget.scrollTop, 77);
      assert.ok(rows[1].innerHTML.includes('aria-pressed="true"'));
      assert.ok(rows[0].innerHTML.includes('aria-pressed="false"'));
      s.explorerFilters.showTiny = true;
      const all = collectRows();
      f();
      assert.deepEqual(all.map(r => r.getAttribute('data-address')), ['0xl', '0xm', '0xs']);
      assert.equal(s.DOM.explorerTinyToggle.getAttribute('aria-checked'), 'true');
      s.explorerFilters.showTiny = false;
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
      s.allVaults = [cv({ address: '0x1', chainId: 1, asset: { symbol: 'WETH' }, name: 'Re7 WETH', curatorName: 'Re7 Labs' }),
        cv({ address: '0x2', chainId: 8453, asset: { symbol: 'USDC' } }), cv({ address: '0x3', chainId: 8453, asset: { symbol: 'wstETH' }, name: 'Gauntlet', curatorName: 'Gauntlet' })];
      const run = filters => { Object.assign(s.explorerFilters, DEFAULT_FILTERS, filters); const rows = collectRows(); f(); return rows.map(r => r.getAttribute('data-address')); };
      assert.deepEqual(run({ network: '8453' }), ['0x2', '0x3']);
      assert.deepEqual(run({ asset: 'WSTETH' }), ['0x3']);
      assert.deepEqual(run({ curator: 'Re7 Labs' }), ['0x1']);
      pin('0x3');
      assert.deepEqual(run({ pinnedOnly: true }), ['0x3']);
      s.DOM.activityPanel.classList.add('hidden');
      f();
      assert.equal(s.DOM.explorerFavFilterBtn.getAttribute('aria-pressed'), 'true');
      assert.ok(s.DOM.explorerFavFilterBtn.classList.contains('active'));
      s.DOM.activityPanel.classList.remove('hidden'); // activity view open: the table is hidden, so the star is not pressed
      f();
      assert.equal(s.DOM.explorerFavFilterBtn.getAttribute('aria-pressed'), 'false');
      assert.ok(!s.DOM.explorerFavFilterBtn.classList.contains('active'));
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
    T('сортування за APY, ліквідністю і ризиком', ({ renderVaultExplorer: f, __state: s }) => {
      s.allVaults = [
        cv({ address: 'a', netApy: 0.01, liquidityUsd: 3, exitCapPercent: 50 }),
        cv({ address: 'b', netApy: 0.09, liquidityUsd: 1, exitCapPercent: null, flagCount: 1, worstFlagLevel: 'medium', worstFlagTitle: 'Unknown Exit Liquidity' }),
        cv({ address: 'c', netApy: 0.05, liquidityUsd: 2, exitCapPercent: 15, flagCount: 2, worstFlagLevel: 'high', worstFlagTitle: 'Restricted Exit Liquidity' }),
        cv({ address: 'd', netApy: undefined, liquidityUsd: undefined, exitCapPercent: 30, flagCount: 1, worstFlagLevel: 'critical', worstFlagTitle: 'Compromised Market Exposure' })
      ];
      const order = sort => { s.explorerFilters.sort = sort; const rows = collectRows(); f(); return rows.map(r => r.getAttribute('data-address')).join(''); };
      assert.equal(order('apy_desc'), 'bcad');
      assert.equal(order('liq_desc'), 'acbd');
    }),
    T('бейджі рядка: найгірший прапорець з "+N", підказка з назвою, рядок без прапорців без бейджа', ({ renderVaultExplorer: f, __state: s }) => {
      s.allVaults = [
        cv({ address: '1', totalAssetsUsd: 6, flagCount: 1, worstFlagLevel: 'high', worstFlagTitle: 'Unpriced Vault' }),
        cv({ address: '2', totalAssetsUsd: 5, flagCount: 3, worstFlagLevel: 'critical', worstFlagTitle: 'Compromised Market Exposure' }),
        cv({ address: '3', totalAssetsUsd: 4, flagCount: 1, worstFlagLevel: 'medium', worstFlagTitle: 'Unverified Markets' }),
        cv({ address: '4', totalAssetsUsd: 3 })
      ];
      s.explorerFilters.showTiny = true;
      const rows = collectRows();
      f();
      s.explorerFilters.showTiny = false;
      const badge = r => r.innerHTML.match(/vault-mini-badge (?:warn|bad)"[^>]*>([^<]*)</)?.[1] ?? null;
      assert.deepEqual(rows.map(badge), ['No price', 'Bad market +2', 'Partial data', null]);
      assert.match(rows[1].innerHTML, /title="Compromised Market Exposure and 2 more"/);
      assert.match(rows[0].innerHTML, /vault-mini-badge bad/); assert.match(rows[2].innerHTML, /vault-mini-badge warn/);
    }),
    T('відʼємний APY має клас negative, назва екранується, TVL падає на ліквідність', ({ renderVaultExplorer: f, __state: s }) => {
      s.allVaults = [cv({ name: '"><img onerror=1>', netApy: -0.02, totalAssetsUsd: 0, liquidityUsd: 2500, isUnpriced: true })];
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
      assert.ok(env.fetched.includes('/api/vaults/0xA?chainId=1'));
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
      assert.equal(D.modalGrade.textContent, '0'); assert.equal(D.modalGrade.dataset.tone, 'none');
    }),
    T('шапка за прапорцями списку: кількість і тон найгіршого', ({ populateBasicVaultInfo: f, __state: s }) => {
      const g = s.DOM.modalGrade;
      f(cv({ flagCount: 2, worstFlagLevel: 'critical', worstFlagTitle: 'X' })); assert.equal(g.textContent, '2'); assert.equal(g.dataset.tone, 'bad');
      assert.equal(s.DOM.modalScore.textContent, 'Worst: Critical');
      f(cv({ flagCount: 1, worstFlagLevel: 'medium', worstFlagTitle: 'X' })); assert.equal(g.dataset.tone, 'warn');
      f(cv({ flagCount: 0, worstFlagLevel: null })); assert.equal(g.textContent, '0'); assert.equal(g.dataset.tone, 'none');
      assert.equal(s.DOM.modalScore.textContent, 'None raised');
    }),
    T('відсутні поля прапорців і виходу не перезаписують попередні значення, null виходу -> N/A', ({ populateBasicVaultInfo: f, __state: s }) => {
      s.DOM.modalGrade.textContent = 'sentinel'; s.DOM.modalExitCapPct.textContent = 'sentinel';
      f(cv({ flagCount: undefined, exitCapPercent: undefined }));
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
      assert.equal(D.modalVaultName.textContent, 'Morpho Vault'); assert.equal(D.modalCuratorName.textContent, 'Independent');
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
      env.fetch(url => (url === '/api/vaults/0xAAA1?chainId=1' ? jsonResponse(audit({ name: 'Audited' })) : jsonResponse({}, 404)));
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
      assert.deepEqual(env.fetched, ['/api/vaults/0xAAA1?chainId=1']);
      resolve(jsonResponse(audit({ name: 'Revalidated' })));
      await tick();
      assert.equal(s.clientAuditCache.get('0xaaa1').vault.name, 'Revalidated');
      assert.equal(s.DOM.modalVaultName.textContent, 'Revalidated');
    }),
    T('попередній кеш (навіть застарілий) одразу заповнює шапку прапорцями аудиту', async ({ openVaultAuditFlow: f, __state: s }, env) => {
      s.REDUCED_MOTION.matches = true;
      s.clientAuditCache.set('0xaaa1', { ...audit({ name: 'Stale Cache' }, { redFlags: [{ level: 'HIGH', title: 'Restricted Exit Liquidity' }] }), cachedAt: 0 });
      let resolve;
      env.fetch(() => new Promise(r => { resolve = r; }));
      const p = f(cv({ mqiPercent: 100 }), null, s.auditOpenToken);
      assert.equal(s.DOM.modalVaultName.textContent, 'Stale Cache');
      assert.equal(s.DOM.modalGrade.textContent, '1');
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
      assert.equal(P.style.height, '400px');
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
      assert.equal(R.style.left, `${240}px`);
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
  getAuditPanelRect: [
    T('повертає виміряний прямокутник панелі з центром і радіусом', ({ getAuditPanelRect: f }) => {
      const r = f();
      assert.equal(r.width, 480);
      assert.equal(r.height, 400);
      assert.equal(r.cx, 240);
      assert.equal(r.cy, 200);
      assert.equal(r.radius, '16px');
    }),
  ],
  setLedgerCompact: [
    T('вмикає і вимикає клас audit-open на body', ({ setLedgerCompact: f }) => {
      f(true);
      assert.equal(document.body.classList.contains('audit-open'), true);
      f(false);
      assert.equal(document.body.classList.contains('audit-open'), false);
    }),
  ],
  setAuditLayout: [
    T('звужує таблицю і переставляє сферу в положення аудиту', ({ setAuditLayout: f, __state: s }) => {
      const calls = [];
      s.sphere.setLayout = (...a) => calls.push(a);
      f(true);
      assert.equal(document.body.classList.contains('audit-open'), true);
      assert.equal(calls.length, 1);
      f(false);
      assert.equal(document.body.classList.contains('audit-open'), false);
      assert.equal(calls.length, 2);
      assert.notDeepEqual(calls[0].slice(0, 3), calls[1].slice(0, 3));
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
    T('закриття на десктопі: вікно зникає одразу, кулька не летить, таблиця розширюється', ({ closeVaultAudit: f, __state: s }, env) => {
      s.selectedVaultAddress = '0xA';
      s.DOM.auditModal.classList.remove('hidden');
      document.body.classList.add('audit-open');
      f();
      assert.equal(s.DOM.auditModal.classList.contains('hidden'), true);
      assert.equal(s.DOM.morphProxy.style.left, undefined); // the proxy ball is never positioned
      assert.equal(document.body.classList.contains('audit-open'), false);
      assert.equal(s.selectedVaultAddress, null);
      assert.equal(s.isClosingAudit, false); assert.equal(s.isTransitioningVault, false);
      assert.deepEqual(s.sphere.calls.slice(0, 2), [['select', null], ['highlight', null]]);
      assert.equal(env.timers.length, 0);
    }),
  ],

  // ---------- Вихідна ліквідність ----------
  updateExitDisplay: [
    T('невідома ліквідність: порожня смуга і N/A', ({ updateExitDisplay: f, __state: s }) => {
      s.DOM.riskExitBar.style.width = '100%';
      f(null, 0);
      assert.equal(s.DOM.riskExitBar.style.width, '0%');
      assert.equal(s.DOM.riskExitPct.textContent, 'N/A');
      assert.match(s.DOM.riskExitDesc.textContent, /Exit liquidity unknown/);
    }),
    T('відомий вихід: відсоток, сума і ширина смуги з обмеженням 100%', ({ updateExitDisplay: f, __state: s }) => {
      f(40, 4e6);
      assert.equal(s.DOM.riskExitBar.style.width, '40%');
      assert.equal(s.DOM.riskExitPct.textContent, '40%');
      assert.equal(s.DOM.riskExitDesc.textContent, '$4.00M available for immediate withdrawal without locking markets.');
      f(40, 4e6, 24, 1);
      assert.ok(!s.DOM.riskExitDesc.textContent.includes('other lenders'), 'under the threshold: no note');
      f(40, 4e6, 60, 2);
      assert.match(s.DOM.riskExitDesc.textContent, /About 60% of this is free cash in 2 markets that other lenders can withdraw first\.$/);
      f(40, 4e6, 100, 1, 8);
      assert.match(s.DOM.riskExitDesc.textContent, /1 market that other lenders can withdraw first; if all of them leave together, the vault can count on about 8%\.$/);
      f(100, 4e6, 100, 1, 100);
      assert.ok(!s.DOM.riskExitDesc.textContent.includes('other lenders'), 'a fair share equal to the exit: nothing to warn about');
      f(150, 0);
      assert.equal(s.DOM.riskExitBar.style.width, '100%');
    }),
  ],

  // ---------- Модалка аудиту ----------
  populateAuditModal: [
    T('чистий vault: шапка, фінанси, MQI, класи застав, вихід і прапорці', ({ populateAuditModal: f, __state: s }) => {
      const D = s.DOM;
      const collateral = collect(D.riskCollateralList);
      pin('0xaaa1');
      f(audit({ chainId: 42161, version: 'v2', totalAssetsHuman: 1234567 }));
      assert.equal(D.modalChainBadge.textContent, 'ARB'); assert.equal(D.modalChainBadge.className, 'badge badge-chain arbitrum');
      assert.equal(D.modalVersionBadge.textContent, 'V2'); assert.equal(D.modalListedBadge.textContent, 'LISTED');
      assert.equal(D.modalFavBtn.classList.contains('active'), true);
      assert.equal(D.modalGrade.textContent, '0'); assert.equal(D.modalScore.textContent, 'None raised');
      assert.equal(D.modalGrade.dataset.tone, 'none');
      assert.equal(D.modalTvl.textContent, '$10.00M'); assert.equal(D.modalAssetsHuman.textContent, '1.23M USDC');
      assert.equal(D.modalExitCapPct.textContent, '40% Exit Cap');
      assert.equal(D.overviewMarketsCount.textContent, '0 MARKETS');
      assert.equal(D.riskMqiPct.textContent, '100%'); assert.equal(D.riskMqiBar.style.width, '100%');
      assert.match(D.riskMqiDesc.textContent, /^No listing problem, bad debt or protocol warning found in any market\./);
      assert.equal(D.riskEffectiveAssets.textContent, '2 tokens');
      assert.equal(collateral.length, 2); // two tokens
      assert.match(collateral[0].innerHTML, /WETH[\s\S]*\$5\.00M[\s\S]*50%/);
      assert.equal(D.riskFlagsList.innerHTML, '<div class="flag-item clear">No flags were raised. That is not a safety guarantee, see below.</div>');
      assert.match(D.allocationsTbody.innerHTML, /No active market allocations recorded/);
      assert.equal(D.riskExitPct.textContent, '40%');
    }),
    T('невідомий MQI: N/A і порожня смуга, прапорець Unpriced Vault в шапці', ({ populateAuditModal: f, __state: s }) => {
      const D = s.DOM;
      f(audit({}, { mqi: { mqiPercent: null, isAllClean: false, unpriced: true }, redFlags: [{ level: 'HIGH', title: 'Unpriced Vault', message: 'm' }] }));
      assert.equal(D.modalGrade.textContent, '1'); assert.equal(D.modalScore.textContent, 'Worst: High');
      assert.equal(D.modalGrade.dataset.tone, 'bad');
      assert.equal(D.riskMqiPct.textContent, 'N/A'); assert.equal(D.riskMqiBar.style.width, '0%');
      assert.match(D.riskMqiDesc.textContent, /no USD price/);
      f(audit({}, { mqi: { mqiPercent: null, isAllClean: false, unpriced: false } }));
      assert.equal(D.riskMqiDesc.textContent, 'None of the capital could be verified yet, so there is no score');
    }),
    T('позначені ринки: опис MQI, шапка за найгіршим прапорцем і підсумок вердикту', ({ populateAuditModal: f, __state: s }) => {
      const D = s.DOM;
      f(audit({}, {
        mqi: { mqiPercent: 87.5, isAllClean: false, compromisedMarkets: [{}, {}], compromisedPercent: 12.5 },
        redFlags: [{ level: 'MEDIUM', title: 'A' }, { level: 'CRITICAL', title: 'B' }]
      }));
      assert.equal(D.riskMqiDesc.textContent, '2 market(s) with verification or debt issues detected');
      assert.equal(D.modalGrade.textContent, '2'); assert.equal(D.modalScore.textContent, 'Worst: Critical');
      assert.equal(D.modalVerdictSummary.hidden, true);
      f({ ...audit(), verdict: { ...audit().verdict, summary: 'MQI: 100%. Exit Liquidity: 40%.' } });
      assert.equal(D.modalVerdictSummary.textContent, 'MQI: 100%.\nExit Liquidity: 40%.'); assert.equal(D.modalVerdictSummary.hidden, false);
    }),
    T('лише неперевірений капітал: сума поза оцінкою', ({ populateAuditModal: f, __state: s }) => {
      f(audit({}, { mqi: { mqiPercent: 100, isAllClean: false, unverifiedPercent: 3, unverifiedAssetsUsd: 300000 } }));
      assert.equal(s.DOM.riskMqiDesc.textContent, '$300.0K is unverified (data missing or not expanded) and left out of the score');
    }),
    T('розбивка застав по токенах: символ екранується, пустий символ - Unknown, однина для одного токена, без токенів - 0 tokens', ({ populateAuditModal: f, __state: s }) => {
      const D = s.DOM;
      const rows = collect(D.riskCollateralList);
      f(audit({}, { collateral: { tokens: [{ symbol: '<b>x</b>', usd: 1, percent: 1 }, { symbol: null, usd: 1, percent: 1 }] } }));
      assert.match(rows[0].innerHTML, /&lt;b&gt;x&lt;\/b&gt;/); assert.match(rows[1].innerHTML, /Unknown/); assert.doesNotMatch(rows[0].innerHTML, /unrated|T5/);
      f(audit({}, { collateral: { tokens: [{ symbol: 'A', usd: 1, percent: 1 }] } }));
      assert.equal(D.riskEffectiveAssets.textContent, '1 token');
      f(audit({}, { collateral: { tier: 'UNKNOWN', tokens: [] } }));
      assert.equal(D.riskEffectiveAssets.textContent, '0 tokens'); assert.match(D.riskCollateralList.innerHTML, /No active collateral backing recorded/);
    }),
    T('невідомий вихід: Exit Cap N/A і порожня смуга', ({ populateAuditModal: f, __state: s }) => {
      const D = s.DOM;
      f(audit({}, { liquidity: { instantExitCapacityPercent: null } }));
      assert.equal(D.modalExitCapPct.textContent, 'Exit Cap N/A');
      assert.equal(D.riskExitPct.textContent, 'N/A');
      assert.equal(D.riskExitBar.style.width, '0%');
    }),
    T('таблиця ринків: FLAGGED, UNVERIFIED, NO ISSUES, неявний прапорець і n/a для LLTV', ({ populateAuditModal: f, __state: s }) => {
      const rows = collect(s.DOM.allocationsTbody);
      const created = [];
      const origCreate = document.createElement;
      document.createElement = tag => { const e = origCreate(tag); created.push(e); return e; };
      f(audit({ totalAssetsUsd: 1e6 }, {}, [
        { collateralSymbol: 'WETH', collateralTags: ['eth', 'lst'], collateralAddress: '0x' + 'a'.repeat(40), lltvPercent: 86, weight: 0.5, supplyAssetsUsd: 5e5, marketFreeLiquidityUsd: 1e5, isFlagged: true, supplyApy: 0.0412 },
        { collateralSymbol: 'cbBTC', lltvPercent: null, weight: 0.2, supplyAssetsUsd: 2e5, isFlagged: false, isUnverified: true },
        { collateralSymbol: '<img src=x>', lltvPercent: 77, weight: 0.1, supplyAssetsUsd: 1e5, isClean: true },
        { collateralSymbol: 'PT', weight: 0.2, supplyAssetsUsd: 2e5, isClean: false },
        { weight: 0, supplyAssetsUsd: 5000, isClean: false }
      ]));
      assert.equal(s.DOM.overviewMarketsCount.textContent, '5 MARKETS');
      assert.equal(rows.length, 5);
      const status = r => r.innerHTML.match(/badge-status[^>]*>([\w ]+)</)[1];
      assert.deepEqual(rows.map(status), ['FLAGGED', 'UNVERIFIED', 'NO ISSUES', 'FLAGGED', 'NO ISSUES']);
      assert.match(rows[0].innerHTML, /<td>86%<\/td>[\s\S]*<td>50\.0%<\/td>[\s\S]*\$500\.0K[\s\S]*\$100\.0K[\s\S]*4\.12%/);
      assert.doesNotMatch(rows[0].innerHTML, /eth, lst|no tags|token-facts/); assert.doesNotMatch(rows[1].innerHTML, /no tags|token-facts/);
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
  renderCollateralFacts: [
    T('одна картка на токен без повторів, без картки для некоректної адреси, блок ховається без карток', ({ renderCollateralFacts: f, __state: s }) => {
      s.DOM.collateralFacts = makeElement();
      s.DOM.collateralFactsGrid = makeElement();
      s.DOM.collateralFactsGrid.querySelectorAll = () => [];
      const a = '0x' + 'A'.repeat(40);
      f(1, [{ collateralSymbol: 'USDe', collateralAddress: a }, { collateralSymbol: 'USDe', collateralAddress: a.toLowerCase() }, { collateralSymbol: 'X', collateralAddress: null }]);
      assert.equal(s.DOM.collateralFacts.hidden, false);
      assert.equal(s.DOM.collateralFactsGrid.innerHTML.match(/cf-item\"/g).length, 1);
      assert.ok(s.DOM.collateralFactsGrid.innerHTML.includes('USDe'));
      f(1, [{ collateralSymbol: 'X', collateralAddress: null }]);
      assert.equal(s.DOM.collateralFacts.hidden, true);
      assert.equal(s.DOM.collateralFactsGrid.innerHTML, '');
    }),
  ],
  tokenFactsPlaceholder: [
    T('слот лише для коректної адреси токена, значення екрануються', ({ tokenFactsPlaceholder: f }) => {
      const a = '0x' + 'b'.repeat(40);
      assert.equal(f(8453, a), `<div class="token-facts" data-chain="8453" data-address="${a}">token data loading</div>`);
      for (const bad of [null, undefined, '', '0x123', '<img>', 'x'.repeat(42)]) assert.equal(f(1, bad), '');
      assert.ok(f('<b>', a).includes('data-chain="&lt;b&gt;"'));
    }),
  ],
  describeTokenFacts: [
    T('без запису: примітка і hasData false', ({ describeTokenFacts: f }) => {
      for (const v of [null, {}]) { const r = f(v); assert.equal(r.summary, 'No data collected yet'); assert.equal(r.hasData, false); }
    }),
    T('факти складаються в речення за розділами, коротка фраза і штамп даних', ({ describeTokenFacts: f }) => {
      const r = f({ coverage: 0.95, collectedAt: 1792660000, stale: false, data: {
        contract: { sourcify_match: 'exact_match', is_proxy: false, fn: { mint: true, burn: true, blacklist: false, freeze: false, pause: null, upgrade: true } },
        holders: { count: 47161, top10_pct: 94.499, top10_contracts: 4, top10_nonprotocol_pct: 17.541, morpho_blue_pct: 1.138 },
        liquidity: { pools_count: 8, total_reserve_usd: 46366753, kyber: { 1000000: { status: 'ok', price_impact_pct: 0.031 } } },
        control: { controllers: [{ role: 'owner', name: 'Timelock', is_contract: true, timelock_delay_sec: 86400 }, { role: 'admin', is_contract: true, safe: { threshold: 6, owner_count: 10 } }] },
        price: { usd: 80392.589, market_cap_usd: 4540557194 }, rwa: { issuer: 'Midas' }, pendle: { days_to_expiry: 433 } } });
      assert.equal(r.hasData, true);
      for (const x of ['The contract code is public', 'can create new tokens, destroy tokens and change the code', 'When collected, 47,161 wallets held it', 'The 10 biggest holders own 94.5% of the supply, but 4 of them are protocol contracts',
        'Leaving out protocol contracts, the 10 biggest remaining holders own 17.5%', '1.1% of the supply is deposited in Morpho Blue', 'When collected, it traded at $80,392.59', 'When collected, it traded in 8 pools holding',
        'When collected, selling $1M worth would have moved the price by under 0.1%.', 'It is issued by Midas', 'It expires in 433 days', 'Collected 2026-10-22']) assert.ok(r.html.includes(x), x);
      assert.doesNotMatch(r.html, /out of date|Partial|Not found|market cap/);
      assert.equal(r.summary, 'Public code, can create new tokens, top holders outside protocols own 18%'); assert.doesNotMatch(r.html, /Who can change it|Timelock|shared wallet/);
    }),
    T('чого нема, про те сказано прямо: не перевірено, невідомий власник адреси, немає даних, 20 пулів як нижня межа, тонка ліквідність', ({ describeTokenFacts: f }) => {
      const r = f({ coverage: 0.5, collectedAt: 0, stale: true, data: { contract: { is_proxy: true, fn: { upgrade: true } }, holders: { count: 7, top10_pct: 99.5 },
        liquidity: { pools_count: 20, total_reserve_usd: 5e6, kyber: { 1000000: { status: 'ok', price_impact_pct: 41.3 } } },
        control: { controllers: [{ role: 'proxy_admin', is_contract: false, safe: null }] } } });
      for (const x of ['Our collector did not find verified source code', 'Its code can be swapped out later', 'When collected, only 7 wallets held it', 'its 20 biggest pools held $5.00M; there may be more', 'so it is hard to sell in size']) assert.ok(r.html.includes(x), x);
      assert.doesNotMatch(r.html, /99\.5|The 10 biggest/); assert.ok(r.html.includes('Our collector did not find: price'));
      assert.ok(r.html.includes('Partial data: 50% of the checks returned results. Collected 1970-01-01 (out of date)'));
      assert.equal(r.summary, 'Source code not found by us, can change the code, only 7 holders'); assert.doesNotMatch(r.html, /single address|proxy admin/);
      const none = f({ coverage: 1, collectedAt: 0, data: { contract: { sourcify_match: 'match', fn: { mint: true } }, control: { controllers: [] } } });
      assert.doesNotMatch(none.html, /who holds these rights/); assert.doesNotMatch(none.summary, /controls/);
      const thin = f({ data: { liquidity: { pools_count: 1, total_reserve_usd: 0.4 } } });
      assert.ok(thin.html.includes('Almost no trading liquidity when collected: its 1 pool held only $0.40'));
    }),
    T('невідомі значення пропускаються, no_route, чужий HTML екранується, увесь запас у протоколах', ({ describeTokenFacts: f }) => {
      const r = f({ coverage: 0.9, collectedAt: 0, data: { contract: { fn: {} }, holders: { count: 50, top10_pct: 100, top10_nonprotocol_pct: 0 }, liquidity: { pools_count: 3, total_reserve_usd: 1e6, kyber: { 1000000: { status: 'no_route' } } },
        control: { controllers: [{ role: '<b>', is_contract: true, name: 'Vault<i>', safe: null }] } } });
      assert.ok(r.html.includes('KyberSwap found no way to swap it')); assert.ok(f({ data: { rwa: { issuer: '<b>X</b>' } } }).html.includes('issued by &lt;b&gt;X&lt;/b&gt;'));
      assert.ok(r.html.includes('Almost the whole supply sits in protocol contracts')); assert.doesNotMatch(r.html, /100\.0|code is public/);
      assert.equal(f({ coverage: 1, collectedAt: 0, data: {} }).hasData, false);
      assert.equal(f({ coverage: 0, collectedAt: 0, stale: true, data: {} }).summary, 'Old data, almost nothing found');
    }),
    T('токен без DEX-пулів: пояснення за класом (PT, RWA, vault-частка, інше), без відповіді Gecko нічого не стверджується', ({ describeTokenFacts: f }) => {
      const tok = extra => f({ coverage: 1, collectedAt: 0, data: { liquidity: { pools_count: null, total_reserve_usd: null }, ...extra } }).html;
      assert.ok(tok({ pendle: { active: false, days_to_expiry: 40 } }).includes('Pendle principal tokens trade on Pendle and can be redeemed for the underlying asset at maturity'));
      assert.ok(tok({ rwa: { issuer: 'Midas' } }).includes('usually redeemed with the issuer instead of being sold on an exchange'));
      assert.ok(tok({ contract: { fn: { erc4626: true } } }).includes('This is a vault share: it is normally redeemed from the vault itself'));
      assert.ok(tok({}).includes('No DEX pools were found, so it may not be easy to sell on exchanges'));
      assert.ok(tok({ pendle: { days_to_expiry: 3 }, rwa: { issuer: 'X' } }).includes('Pendle principal tokens'), 'PT wins over RWA');
      assert.doesNotMatch(tok({ price: { usd: 1 } }), /Trading liquidity could not|trading liquidity could not/);
      const failed = f({ coverage: 1, collectedAt: 0, data: { price: { usd: 1 }, liquidity: { pools_count: null }, meta: { sources: [{ key: 'gecko_pools', status: 429 }] } } }).html;
      assert.doesNotMatch(failed, /No DEX pools/); assert.ok(failed.includes('trading liquidity'));
      const unknownToken = f({ coverage: 1, collectedAt: 0, data: { price: { usd: 1 }, liquidity: { pools_count: null }, meta: { sources: [{ key: 'gecko_pools', status: 404 }] } } }).html;
      assert.ok(unknownToken.includes('No DEX pools were found'));
      const thin = f({ coverage: 1, collectedAt: 0, data: { liquidity: { pools_count: 2, total_reserve_usd: 500 }, pendle: { days_to_expiry: 9 } } }).html;
      assert.ok(thin.includes('Almost no trading liquidity when collected: its 2 pools held only $500.00. Principal tokens usually trade on Pendle instead.'));
    }),
    T('кожен факт має пояснення простими словами, що залежить від значень токена', ({ describeTokenFacts: f }) => {
      const mean = html => [...html.matchAll(/<span class="cf-mean">(.*?)<\/span>/g)].map(m => m[1]);
      const risky = mean(f({ data: { contract: { is_proxy: true, fn: { mint: true, pause: true } }, holders: { count: 7 }, liquidity: { pools_count: 1, total_reserve_usd: 50 },
        control: { controllers: [{ role: 'owner', is_contract: false }] } } }).html).join('|');
      for (const x of ['change how it works', 'new tokens can dilute it', 'any sale by the vault', 'A few holders decide', 'Even a small sale']) assert.ok(risky.includes(x) || risky.includes(x.toLowerCase()), x);
      const calm = mean(f({ data: { contract: { sourcify_match: 'x', is_proxy: false, fn: {} }, holders: { count: 9000, top10_pct: 30, top10_nonprotocol_pct: 10 }, liquidity: { pools_count: 5, total_reserve_usd: 5e7, kyber: { 1000000: { status: 'ok', price_impact_pct: 0.1 } } },
        control: { controllers: [{ role: 'owner', is_contract: true, timelock_delay_sec: 86400 }] } } }).html).join('|');
      for (const x of ['fewer hidden surprises', 'Its rules are fixed', 'Many holders', 'Well spread', 'Deep pools: large sales are possible', 'A $1M forced sale was cheap']) assert.ok(calm.includes(x), x);
      assert.doesNotMatch(calm, /One key|few holders decide|hit the price hard/);
    }),
    T('калібрування: «контракти завищують концентрацію» лише коли протоколи справді тримають багато; глибина пулів і розмір продажу названі', ({ describeTokenFacts: f }) => {
      const holders = h => f({ data: { holders: { count: 500, top10_contracts: 3, ...h } } }).html;
      assert.ok(holders({ top10_pct: 90, top10_nonprotocol_pct: 20 }).includes('Protocol contracts hold much of it'));
      const little = holders({ top10_pct: 78, top10_nonprotocol_pct: 70 });
      assert.ok(little.includes('little of it sits in known protocol contracts')); assert.doesNotMatch(little, /overstates/);
      assert.ok(holders({ top10_pct: 90 }).includes('may overstate'));
      const pools = usd => f({ data: { liquidity: { pools_count: 3, total_reserve_usd: usd, kyber: { 1000000: { status: 'ok', price_impact_pct: 9 } } } } }).html;
      assert.ok(pools(2e7).includes('Deep pools')); assert.ok(pools(2e6).includes('small and mid-size sales')); assert.ok(pools(2e5).includes('large ones move the price'));
      assert.ok(pools(2e6).includes('A $1M sale would hit the price hard'));
    }),
    T('три й більше дірок зводяться в один рядок «Not found», без окремої примітки про код у розділі Contract', ({ describeTokenFacts: f }) => {
      const many = f({ coverage: 0.4, data: { contract: { is_proxy: null, fn: {} }, liquidity: { pools_count: null } } }).html;
      assert.ok(many.includes('Our collector did not find: verified source code, holders and price.'));
      assert.doesNotMatch(many.split('Not found by our collector')[0], /verified source code/);
      const two = f({ coverage: 0.4, data: { contract: { is_proxy: null, fn: {} }, holders: { count: 900, top10_pct: 20 }, price: { usd: 1 }, liquidity: { pools_count: null }, meta: { sources: [{ key: 'gecko_pools', status: 200 }] } } }).html;
      assert.ok(two.includes('Our collector did not find verified source code.'));
    }),
    T('суперечливі дані не стають твердженням: не-проксі з upgrade і лічильник менше 10 при топ-10 нижче 99%', ({ describeTokenFacts: f }) => {
      const r = f({ data: { contract: { sourcify_match: 'x', is_proxy: false, fn: { upgrade: true } } } }).html;
      assert.ok(r.includes('change the code')); assert.doesNotMatch(r, /cannot be swapped out/);
      const h = f({ data: { holders: { count: 4, top10_pct: 60, top10_nonprotocol_pct: 50 } } }).html;
      assert.doesNotMatch(h, /only 4 wallets|wallets held it/); assert.ok(h.includes('10 biggest holders own 60.0%'));
    }),
    T('$1M відхилено Kyber: показується $100K, а без жодного котирування речення немає', ({ describeTokenFacts: f }) => {
      const kyber = big => ({ data: { liquidity: { kyber: { 1000000: big, 100000: { status: 'ok', price_impact_pct: 77.5 } } } } });
      assert.ok(f(kyber({ status: 'error', reason: '4009 amountIn is greater than max allowed' })).html.includes('selling $100K worth would have moved the price by about 78%, so it is hard to sell in size'));
      assert.doesNotMatch(f(kyber({ status: 'ok', price_impact_pct: 0.2 })).html, /\$100K/);
      assert.doesNotMatch(f({ data: { liquidity: { kyber: { 1000000: { status: 'error' }, 100000: { status: 'error' } } } } }).html, /selling/);
    }),
  ],
  loadTokenFacts: [
    T('заповнює слоти й короткі фрази, один запит на токен, 404 і помилка читаються, помилка не кешується', async ({ loadTokenFacts: f }, env) => {
      env.quiet();
      const slot = (chain, address) => { const sum = { textContent: '' }; const cls = new Set(); return Object.assign(fakeNode(), { dataset: { chain, address }, sum, cls,
        parentElement: { querySelector: () => sum, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } } }); };
      const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
      const [s1, s2, s3, s4] = [slot('1', A), slot('1', A), slot('1', B), slot('1', C)];
      let failC = true;
      env.fetch(url => {
        if (url.endsWith(B)) return { status: 404, ok: false };
        if (url.endsWith(C) && failC) return { status: 500, ok: false };
        return { status: 200, ok: true, json: async () => ({ coverage: 0.5, collectedAt: 1792660000, stale: false, data: { holders: { top10_pct: 10 } } }) };
      });
      await f(fakeNode({ '.token-facts': [s1, s2, s3, s4] }));
      assert.deepEqual([...env.fetched].sort(), [`/api/tokens/1/${A}`, `/api/tokens/1/${B}`, `/api/tokens/1/${C}`]);
      assert.ok(s1.innerHTML.includes('own 10.0% of the supply') && s2.innerHTML === s1.innerHTML); assert.equal(s1.sum.textContent, '10 holders own 10%'); assert.equal(s1.cls.has('cf-empty'), false);
      assert.ok(s3.innerHTML.includes('No facts have been collected')); assert.equal(s3.sum.textContent, 'No data collected yet'); assert.equal(s3.cls.has('cf-empty'), true);
      assert.equal(s4.sum.textContent, 'Unavailable right now');
      failC = false; const s5 = slot('1', C); await f(fakeNode({ '.token-facts': [s5] }));
      assert.ok(s5.innerHTML.includes('own 10.0% of the supply'), 'a failed request is not cached');
    }),
  ],
  setupModalEvents: [
    T('кнопки модалки: закриття, обране', ({ setupModalEvents: f, closeVaultAudit, __state: s }) => {
      const D = s.DOM;
      for (const e of [D.closeBtn, D.modalFavBtn]) { e.handlers = {}; e.addEventListener = (t, fn) => { e.handlers[t] = fn; }; }
      f();
      assert.equal(D.closeBtn.handlers.click, closeVaultAudit);
      D.modalFavBtn.handlers.click();
      assert.equal(localStorage.getItem('cym_pinned_vaults'), null); // нічого не вибрано
      s.selectedVaultAddress = '0xA';
      D.modalFavBtn.handlers.click();
      assert.deepEqual(pinned(), ['0xa']);
    }),
    T('Escape закриває по одному шару: dropdown, пошук, очікуване відкриття, модалку', ({ setupModalEvents: f, __state: s }) => {
      const win = {};
      globalThis.addEventListener = (t, fn) => { win[t] = fn; };
      f();
      const esc = () => win.keydown({ key: 'Escape' });
      const D = s.DOM;

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
  vaultChainQuery: [
    ['мережа vault потрапляє в запит, без відомої мережі запит чистий', ({ vaultChainQuery: f }) => {
      assert.equal(f({ chainId: 8453 }), '?chainId=8453');
      for (const v of [{}, { chainId: '1' }, { chainId: null }, null, undefined]) assert.equal(f(v), '');
    }],
  ],
  summarizeFlags: [
    ['найгірший рівень, його назва і кількість; порожній список -> level null', ({ summarizeFlags: f }) => {
      assert.deepEqual(f([]), { level: null, title: null, count: 0 });
      assert.deepEqual(f(undefined), { level: null, title: null, count: 0 });
      assert.deepEqual(f([{ level: 'MEDIUM', title: 'A' }, { level: 'CRITICAL', title: 'B' }, { level: 'HIGH', title: 'C' }]), { level: 'critical', title: 'B', count: 3 });
    }],
  ],
  vaultRisk: [
    ['читає поля списку, відсутні -> без прапорців', ({ vaultRisk: f }) => {
      assert.deepEqual(f({ worstFlagLevel: 'high', worstFlagTitle: 'T', flagCount: 2 }), { level: 'high', title: 'T', count: 2 });
      assert.deepEqual(f({}), { level: null, title: null, count: 0 });
    }],
  ],
  riskBadgeInfo: [
    ['без прапорців - нейтральний "No flags", не зелений', ({ riskBadgeInfo: f }) => {
      assert.deepEqual(f({ level: null, title: null, count: 0 }), { text: 'No flags', tone: 'none' });
    }],
    ['коротка назва за заголовком, +N для решти, тон за рівнем', ({ riskBadgeInfo: f }) => {
      assert.deepEqual(f({ level: 'high', title: 'Restricted Exit Liquidity', count: 1 }), { text: 'Low exit', tone: 'bad' });
      assert.deepEqual(f({ level: 'critical', title: 'Compromised Market Exposure', count: 3 }), { text: 'Bad market +2', tone: 'bad' });
      assert.deepEqual(f({ level: 'medium', title: 'Unverified Markets', count: 1 }), { text: 'Partial data', tone: 'warn' });
      assert.deepEqual(f({ level: 'high', title: 'Some New Flag', count: 1 }), { text: 'High', tone: 'bad' });
    }],
  ],
  setRiskPill: [
    ['кількість і тон найгіршого прапорця, нуль - нейтральний', ({ setRiskPill: f, __state: s }) => {
      f({ level: 'high', title: 'X', count: 2 });
      assert.equal(s.DOM.modalGrade.textContent, '2'); assert.equal(s.DOM.modalGrade.dataset.tone, 'bad'); assert.equal(s.DOM.modalScore.textContent, 'Worst: High');
      f({ level: null, title: null, count: 0 });
      assert.equal(s.DOM.modalGrade.textContent, '0'); assert.equal(s.DOM.modalGrade.dataset.tone, 'none'); assert.equal(s.DOM.modalScore.textContent, 'None raised');
    }],
  ],
  populateFilterMenus: [
    T('меню мережі, активу і куратора будуються з даних, найбільші першими, USD₮0 зливається з USDT0', ({ populateFilterMenus: f, __state: s }) => {
      const menus = {};
      document.getElementById = id => {
        const m = id.startsWith('menu-') ? (menus[id] ||= (() => { const e = capEl(); const all = capEl(); all.setAttribute('data-value', 'all'); e.querySelector = sel => (sel === '[data-value="all"]' ? all : null); e.kids = []; e.appendChild = n => { e.kids.push(n); }; return e; })()) : null;
        return m;
      };
      document.createElement = () => { const e = capEl(); e.setAttribute = (k, v) => { e.attrs = { ...(e.attrs || {}), [k]: v }; }; return e; };
      s.allVaults = [
        cv({ address: '1', chainId: 1, totalAssetsUsd: 5, asset: { symbol: 'USDC' }, curatorName: 'A' }),
        cv({ address: '2', chainId: 8453, totalAssetsUsd: 9, asset: { symbol: 'USD₮0' }, curatorName: 'B' }),
        cv({ address: '3', chainId: 8453, totalAssetsUsd: 1, asset: { symbol: 'USDT0' }, curatorName: null })
      ];
      f();
      assert.deepEqual(menus['menu-network'].kids.slice(1).map(k => k.attrs['data-value']), ['8453', '1']);
      assert.deepEqual(menus['menu-asset'].kids.slice(1).map(k => k.attrs['data-value']), ['USDT0', 'USDC']);
      assert.deepEqual(menus['menu-curator'].kids.slice(1).map(k => k.attrs['data-value']), ['B', 'A', 'Independent']);
      assert.match(menus['menu-asset'].kids[1].innerHTML, /item-count">2</);
    }),
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

// Кейси для виправлених дефектів, злиті з основними за назвою функції
const fixed = {
  updateActiveFilterChips: [
        T('лише фільтр обраних показує чіп Favorites', ({ updateActiveFilterChips: f, __state: s }) => {
      s.explorerFilters.pinnedOnly = true;
      f();
      assert.equal(s.DOM.activeFilterChips.classList.contains('hidden'), false);
      assert.ok(s.DOM.chipsContainer.innerHTML.includes('Favorites'));
    }),
  ],
  applyVaultAuditData: [
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
        T('токен з 0 знаків: totalAssets "5" -> "5.00 X"', ({ populateBasicVaultInfo: f, __state: s }) => {
      f(cv({ totalAssets: '5', asset: { symbol: 'X', decimals: 0 } }));
      assert.equal(s.DOM.modalAssetsHuman.textContent, '5.00 X');
    }),
  ],
  escapeHtml: [
        ['0 -> "0"', ({ escapeHtml: f }) => assert.equal(f(0), '0')],
  ],
  formatSharePercent: [
    ['пил, що округлився до 0, але має гроші, дає <0.1%; справжній нуль і звичайні значення без змін', ({ formatSharePercent: f }) => {
      assert.equal(f(0), '0%'); assert.equal(f(0, true), '<0.1%'); assert.equal(f(0.01), '<0.1%');
      assert.equal(f(0.05), '0.05%'); assert.equal(f(66.35), '66.35%'); assert.equal(f(100), '100%');
    }],
  ],

  formatWeightPercent: [
    ['нуль і порожнє лишаються 0.0%, пил менше 0.05% дає <0.1%, решта округлюється до десятих', ({ formatWeightPercent: f }) => {
      assert.equal(f(0), '0.0%'); assert.equal(f(undefined), '0.0%');
      assert.equal(f(4.08e-9), '<0.1%'); assert.equal(f(0.0004), '<0.1%');
      assert.equal(f(0.0005), '0.1%'); assert.equal(f(0.663484), '66.3%'); assert.equal(f(1), '100.0%');
    }],
  ],

  formatCurrency: [
    ['негативна сума менша за цент за модулем: "> -$0.01", додатна: "< $0.01"', ({ formatCurrency: f }) => {
      assert.equal(f(-0.004), '> -$0.01'); assert.equal(f(0.004), '< $0.01'); assert.equal(f(-0.01), '-$0.01');
    }],
  ],
};

const merged = { ...base };
for (const [name, cases] of Object.entries(fixed)) merged[name] = [...(base[name] || []), ...cases];
export default merged;
