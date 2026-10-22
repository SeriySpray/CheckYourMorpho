import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CONFIG } from '../../server/config.js';
import { withFetch, jsonResponse } from '../fixtures.js';

// Імпорт server/index.js запускає HTTP-сервер і таймер фонової синхронізації. Щоб це було безпечно
// (зокрема на Oracle, де порт 3000 зайнятий живою службою), порт випадковий, мережа відрізана.
// Цей код виконується під час сканування, до імпорту index.js раннером.
process.env.PORT = '0';
process.env.TOKEN_DATA_DISABLED = '1'; // the collector must not start its loop under test
process.env.HOST = '127.0.0.1';
globalThis.fetch = async () => { throw new Error('мережу вимкнено в тестах'); };

const realSetTimeout = setTimeout;

// Перехоплює process.exit, setTimeout (таймер примусового виходу на 5 с) і clearInterval на час одного виклику handleShutdown.
async function shutdownWith(handleShutdown, signal) {
  const exitCalls = [], timers = [], cleared = [], realExit = process.exit, timeoutFn = globalThis.setTimeout, clearFn = globalThis.clearInterval;
  let onExit; const exited = new Promise(r => { onExit = r; });
  process.exit = code => { exitCalls.push(code); onExit(code); };
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return { unref() {}, ref() {} }; };
  globalThis.clearInterval = t => { cleared.push(t); clearFn(t); };
  const log = console.log; console.log = () => {};
  try {
    handleShutdown(signal);
    await Promise.race([exited, new Promise(r => realSetTimeout(r, 2000))]);
    return { exitCalls, timers, cleared };
  } finally { process.exit = realExit; globalThis.setTimeout = timeoutFn; globalThis.clearInterval = clearFn; console.log = log; }
}

// Сервер, створений імпортом index.js (не експортується, тому шукаємо серед активних дескрипторів).
// listen() завершується лише на наступному оберті циклу подій, тож чекаємо події listening.
async function findServer() {
  // Відрізняємо від тимчасових серверів інших тестів: лише index.js вішає обробник 'error'.
  // До першого виклику listen ще немає дескриптора, тому опитуємо до 2 с.
  for (let i = 0; i < 200; i++) {
    const srv = process._getActiveHandles().find(h => h instanceof http.Server && h.listenerCount('error') > 0);
    if (srv?.listening) return srv;
    await new Promise(r => realSetTimeout(r, 10));
  }
  return undefined;
}

// Свіжа порожня БД на час тесту; лог перехоплюється, щоб перевірити повідомлення планувальника.
async function sandbox(fn) {
  const { getDatabase, closeDatabase } = await import('../../server/db/database.js');
  const savedPath = CONFIG.db.path, log = console.log, warn = console.warn, err = console.error, logs = [];
  closeDatabase();
  CONFIG.db.path = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cym-index-')), 'index.db');
  console.log = (...a) => { logs.push(a.join(' ')); }; console.warn = console.error = () => {};
  try { return await fn(getDatabase(), logs); } finally {
    console.log = log; console.warn = warn; console.error = err;
    closeDatabase(); CONFIG.db.path = savedPath;
  }
}
const mockApi = (v1, counter, gate) => async (_url, init) => {
  counter.n++;
  if (gate) await gate;
  const { query } = JSON.parse(init.body);
  if (query.includes('GetCurators')) return jsonResponse({ data: { curators: { items: [] } } });
  const [key, items] = query.includes('GetVaultV2s') ? ['vaultV2s', []] : ['vaults', v1];
  return jsonResponse({ data: { [key]: { items, pageInfo: { countTotal: items.length } } } });
};
const rawV1 = a => ({
  address: a, name: 'Bg', symbol: 'b', listed: true, chain: { id: 1 }, asset: { address: '0xusdc', symbol: 'USDC', decimals: 6, priceUsd: 1 },
  state: { totalAssets: '1000000', totalAssetsUsd: 1, curator: '0x0', allocation: [] }
});

export default {
  runBackgroundSync: [
    ['збій мережі не кидає виняток', async ({ runBackgroundSync: f }) => {
      const saved = CONFIG.api.maxRetries, err = console.error, log = console.log, warn = console.warn;
      CONFIG.api.maxRetries = 0; console.error = console.log = console.warn = () => {};
      try { await f(); } finally { CONFIG.api.maxRetries = saved; console.error = err; console.log = log; console.warn = warn; }
    }],
    ['після збою синхронізація не залишається заблокованою', async ({ runBackgroundSync: f }) => {
      const { isSyncing } = await import('../../server/services/syncEngine.js');
      const saved = CONFIG.api.maxRetries, err = console.error, log = console.log, warn = console.warn;
      CONFIG.api.maxRetries = 0; console.error = console.log = console.warn = () => {};
      try { await f(); } finally { CONFIG.api.maxRetries = saved; console.error = err; console.log = log; console.warn = warn; }
      assert.equal(isSyncing(), false);
    }],
    ['успішна фонова синхронізація записує vaults і логує підсумок', async ({ runBackgroundSync: f }) => sandbox(async (db, logs) => {
      const counter = { n: 0 };
      await withFetch(mockApi([rawV1('0xaaa'), rawV1('0xbbb')], counter), () => f());
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vaults').get().c, 2);
      assert.ok(logs.some(l => l.includes('2 vaults (2 V1, 0 V2)')), logs.join('\n'));
    })],
    ['під час активної синхронізації пропускається і не звертається до API', async ({ runBackgroundSync: f }) => sandbox(async (_db, logs) => {
      const { syncAllVaults } = await import('../../server/services/syncEngine.js');
      let release; const gate = new Promise(r => { release = r; }); const counter = { n: 0 };
      await withFetch(mockApi([], counter, gate), async () => {
        const first = syncAllVaults();
        const before = counter.n;
        await f();
        assert.equal(counter.n, before, 'пропущена синхронізація не мала робити запитів');
        assert.ok(logs.some(l => l.includes('skipped')));
        release(); await first;
      });
    })],
  ],
  handleShutdown: [
    ['до зупинки сервер слухає HOST/PORT з env і має захист від Slowloris', async () => {
      const srv = await findServer(); assert.ok(srv?.listening, 'сервер index.js не знайдено або не слухає');
      const a = srv.address();
      assert.equal(a.address, '127.0.0.1'); assert.notEqual(a.port, 3000);
      assert.equal(srv.requestTimeout, 15000); assert.equal(srv.headersTimeout, 8000);
      assert.equal(srv.keepAliveTimeout, 5000); assert.equal(srv.timeout, 20000); assert.equal(srv.maxHeadersCount, 100);
    }],
    ['закриває сервер, зупиняє таймер синхронізації і завершує процес з кодом 0', async ({ handleShutdown: f }) => {
      const srv = await findServer();
      const { exitCalls, cleared } = await shutdownWith(f, 'SIGTERM');
      assert.deepEqual(exitCalls, [0]); assert.equal(cleared.length, 1); assert.equal(srv.listening, false);
    }],
    ['повторний виклик теж завершується з кодом 0 і не чіпає вже зупинений таймер', async ({ handleShutdown: f }) => {
      const { exitCalls, cleared } = await shutdownWith(f, 'SIGINT');
      assert.deepEqual(exitCalls, [0]); assert.equal(cleared.length, 0);
    }],
    ['ставить таймер примусового виходу на 5 с з кодом 1', async ({ handleShutdown: f }) => {
      const { timers } = await shutdownWith(f, 'SIGTERM');
      const forced = timers.find(t => t.ms === 5000); assert.ok(forced, 'таймер на 5000 мс не встановлено');
      const realExit = process.exit, calls = []; process.exit = c => calls.push(c);
      const err = console.error; console.error = () => {};
      try { forced.fn(); } finally { process.exit = realExit; console.error = err; }
      assert.deepEqual(calls, [1]);
    }],
  ],
};
