import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../../server/config.js';
import { withFetch, jsonResponse } from '../fixtures.js';

// --- Фікстури сирих відповідей Morpho GraphQL ---
const asset = (symbol, decimals = 6) => ({ address: `0x${symbol}`, symbol, decimals, price: { usd: 1 } });
const rawMarket = (id, over = {}) => ({
  marketId: id, lltv: '860000000000000000', listed: true, loanAsset: asset('USDC'), collateralAsset: asset('WETH', 18),
  oracle: { address: '0xoracle' }, irmAddress: '0xirm',
  state: { supplyAssets: '2000000000', borrowAssets: '1000000000', supplyAssetsUsd: 2000, borrowAssetsUsd: 1000 }, ...over
});
const rawV1 = (addr, over = {}) => ({
  address: addr, name: `V1 ${addr}`, symbol: 'v', listed: true, chain: { id: 1 }, asset: asset('USDC'),
  state: { totalAssets: '1000000000', totalAssetsUsd: 1000, curator: '0x0', allocation: [{ supplyAssets: '600000000', supplyAssetsUsd: 600, supplyCap: '0', market: rawMarket('0xm1') }] },
  ...over
});
const rawV2 = (addr, marketId = '0xm2', over = {}) => ({
  address: addr, name: `V2 ${addr}`, symbol: 'v2', listed: true, chain: { id: 1 }, asset: asset('USDC'),
  totalAssets: '500000000', totalAssetsUsd: 500, caps: { items: [{ allocation: '500000000', absoluteCap: '0', data: { market: rawMarket(marketId) } }] },
  adapters: { items: [] }, ...over
});

// Мок Morpho GraphQL: відповідає за назвою запиту; api.v1/v2 можна міняти між синхронізаціями.
function mockApi(api, hook = async () => {}) {
  return async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    api.calls.push(variables);
    await hook();
    if (query.includes('GetCurators')) return jsonResponse({ data: { curators: { items: api.curators } } });
    const [key, all] = query.includes('GetVaultV2s') ? ['vaultV2s', api.v2] : ['vaults', api.v1];
    const items = all.slice(variables.skip, variables.skip + variables.first);
    return jsonResponse({ data: { [key]: { items, pageInfo: { countTotal: all.length } } } });
  };
}
const newApi = (v1 = [], v2 = [], curators = []) => ({ v1, v2, curators, calls: [] });
// Каталог кураторів Morpho: [[ім'я, адреса], ...]
const dir = (...pairs) => pairs.map(([name, address]) => ({ name, addresses: [{ address }] }));
const v1Curated = (addr, curator) => rawV1(addr, { state: { ...rawV1(addr).state, curator } });
const curatorOf = (db, addr) => db.prepare('SELECT curator_name AS c FROM vaults WHERE address = ?').get(addr).c;
const keys = (db, sql) => db.prepare(sql).all().map(r => Object.values(r).join('|'));
const v1s = (n, chain = 1) => Array.from({ length: n }, (_, i) => rawV1(`0xa${String(i).padStart(2, '0')}`, { chain: { id: chain } }));
const v2s = n => Array.from({ length: n }, (_, i) => rawV2(`0xb${String(i).padStart(2, '0')}`));
const missed = (db, addr) => db.prepare('SELECT missed_syncs AS m FROM vaults WHERE address = ?').get(addr)?.m;

// Свіжа порожня БД на час одного тесту; без шуму в консолі.
async function sandbox(fn) {
  const { getDatabase, closeDatabase } = await import('../../server/db/database.js');
  const savedPath = CONFIG.db.path, log = console.log, warn = console.warn, err = console.error;
  closeDatabase();
  CONFIG.db.path = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cym-sync-')), 'sync.db');
  console.log = console.warn = console.error = () => {};
  try { return await fn(getDatabase()); } finally {
    console.log = log; console.warn = warn; console.error = err;
    closeDatabase(); CONFIG.db.path = savedPath;
  }
}
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
const sync = (mod, api, options) => withFetch(mockApi(api), () => mod.syncAllVaults(options));

export default {
  lookThroughVault: [
    ['порожній або відсутній базовий vault -> null, непорожній -> він сам', ({ lookThroughVault: f }) => {
      const m = new Map([['0xa', { state: { totalAssets: '10' } }], ['0xb', { state: { totalAssets: '0' } }]]);
      assert.equal(f({ metaMorpho: { address: '0xA' } }, m), m.get('0xa'));
      assert.equal(f({ metaMorpho: { address: '0xB' } }, m), null); assert.equal(f({ metaMorpho: { address: '0xC' } }, m), null);
      assert.equal(f({}, m), null);
    }],
    ['інша мережа -> null; невідома мережа з будь-якого боку не блокує', ({ lookThroughVault: f }) => {
      const m = new Map([['0xa', { chain: { id: 1 }, state: { totalAssets: '10' } }]]);
      assert.equal(f({ metaMorpho: { address: '0xa' } }, m, 8453), null);
      assert.ok(f({ metaMorpho: { address: '0xa' } }, m, 1));
      assert.ok(f({ metaMorpho: { address: '0xa' } }, m, undefined));
    }],
  ],
  underlyingTotals: [
    ['знаменник - більше з totalAssets і суми позицій', ({ underlyingTotals: f }) => {
      assert.deepEqual(f({ state: { totalAssets: '100', allocation: [{ supplyAssets: '30' }, { supplyAssets: '20' }] } }), { allocSum: 50n, denominator: 100n });
      assert.equal(f({ state: { totalAssets: '40', allocation: [{ supplyAssets: '30' }, { supplyAssets: '20' }] } }).denominator, 50n);
    }],
    ['без allocation сума 0, знаменник totalAssets', ({ underlyingTotals: f }) =>
      assert.deepEqual(f({ state: { totalAssets: '7' } }), { allocSum: 0n, denominator: 7n })],
  ],
  unresolvedUsd: [
    ['сума в токенах переводиться в USD пропорційно TVL і не перевищує TVL', ({ unresolvedUsd: f }) => {
      const v = { total_assets: '1000000', asset_decimals: 6, total_assets_usd: 200 };
      assert.equal(f(250000n, v), 50); assert.equal(f(5000000n, v), 200);
    }],
    ['TVL без токенів -> 0', ({ unresolvedUsd: f }) => assert.equal(f(1n, { total_assets: '0', asset_decimals: 6, total_assets_usd: 5 }), 0)],
  ],
  syncAllVaults: [
    ['записує V1 і V2 vaults, ринки та алокації і повертає підсумок', async mod => sandbox(async db => {
      const r = await sync(mod, newApi([rawV1('0xaaa')], [rawV2('0xbbb')]));
      assert.deepEqual([r.v1Count, r.v2Count, r.marketsCount, r.allocationsCount], [1, 1, 2, 2]);
      assert.deepEqual(db.prepare('SELECT address, version FROM vaults ORDER BY address').all().map(x => [x.address, x.version]), [['0xaaa', 'v1'], ['0xbbb', 'v2']]);
      assert.equal(count(db, 'markets'), 2); assert.equal(count(db, 'vault_allocations'), 2);
    })],
    ['синк не ламається через теги токенів, токени застави потрапляють у token_tags', async mod => sandbox(async db => {
      // у моку Morpho не знає токен, тож рядок отримує теги 'null'
      const r = await sync(mod, newApi([rawV1('0xaaa')]));
      assert.equal(r.v1Count, 1);
      assert.deepEqual(db.prepare('SELECT chain_id, address, tags_json FROM token_tags').all().map(x => ({ ...x })), [{ chain_id: 1, address: '0xweth', tags_json: 'null' }]);
    })],
    ['спільний ринок двох vaults записується один раз', async mod => sandbox(async db => {
      const r = await sync(mod, newApi([rawV1('0xaaa')], [rawV2('0xbbb', '0xm1')]));
      assert.equal(r.marketsCount, 1); assert.equal(r.allocationsCount, 2); assert.equal(count(db, 'markets'), 1);
    })],
    ['оновлює last_sync_all у sync_state', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa')]));
      const row = db.prepare("SELECT value FROM sync_state WHERE key = 'last_sync_all'").get();
      assert.ok(Math.abs(Number(row.value) - Date.now() / 1000) < 60);
    })],
    ['після успіху getLastSyncResult містить success і підсумок', async mod => sandbox(async () => {
      await sync(mod, newApi([rawV1('0xaaa')]));
      const r = mod.getLastSyncResult(); assert.equal(r.success, true); assert.equal(r.summary.v1Count, 1);
    })],
    ['слухач onSyncSuccess викликається один раз на успішну синхронізацію', async mod => sandbox(async () => {
      let calls = 0; mod.onSyncSuccess(() => { calls++; });
      await sync(mod, newApi([rawV1('0xaaa')])); assert.equal(calls, 1);
    })],
    ['під час роботи isSyncing = true, після завершення false', async mod => sandbox(async () => {
      let during; const api = newApi([rawV1('0xaaa')]);
      await withFetch(mockApi(api, async () => { during = mod.isSyncing(); }), () => mod.syncAllVaults());
      assert.equal(during, true); assert.equal(mod.isSyncing(), false);
    })],
    ['паралельний виклик відхиляється, перший завершується', async mod => sandbox(async () => {
      let release; const gate = new Promise(r => { release = r; }); const api = newApi([rawV1('0xaaa')]);
      await withFetch(mockApi(api, () => gate), async () => {
        const first = mod.syncAllVaults();
        await assert.rejects(mod.syncAllVaults(), /already in progress/);
        release(); await first;
      });
      assert.equal(mod.isSyncing(), false);
    })],
    ['збій мережі: помилка, success=false, БД порожня, блокування знято', async mod => sandbox(async db => {
      await withFetch(async () => jsonResponse({}, 500), async () => {
        const saved = CONFIG.api.maxRetries; CONFIG.api.maxRetries = 0;
        try { await assert.rejects(mod.syncAllVaults(), /failed after 0 retries/); } finally { CONFIG.api.maxRetries = saved; }
      });
      assert.equal(mod.getLastSyncResult().success, false); assert.equal(mod.isSyncing(), false); assert.equal(count(db, 'vaults'), 0);
    })],
    ['слухач не викликається при збої', async mod => sandbox(async () => {
      let calls = 0; mod.onSyncSuccess(() => { calls++; });
      await withFetch(async () => jsonResponse({}, 500), async () => {
        const saved = CONFIG.api.maxRetries; CONFIG.api.maxRetries = 0;
        try { await assert.rejects(mod.syncAllVaults()); } finally { CONFIG.api.maxRetries = saved; }
      });
      assert.equal(calls, 0);
    })],
    ['нелістинговані vaults не зберігаються', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa', { listed: false })], [rawV2('0xbbb')]));
      assert.deepEqual(db.prepare('SELECT address FROM vaults').all().map(x => x.address), ['0xbbb']);
    })],
    ['vault, що зник з API, видаляється лише після 3 пропусків', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa'), rawV1('0xbbb')]));
      const gone = () => db.prepare("SELECT missed_syncs AS m FROM vaults WHERE address = '0xbbb'").get();
      await sync(mod, newApi([rawV1('0xaaa')])); assert.equal(gone().m, 1);
      await sync(mod, newApi([rawV1('0xaaa')])); assert.equal(gone().m, 2);
      await sync(mod, newApi([rawV1('0xaaa')])); assert.equal(gone(), undefined);
      assert.equal(count(db, 'vaults'), 1);
    })],
    ['обірвана відповідь API (<50% відомих) скасовує синхронізацію без видалень', async mod => sandbox(async db => {
      const many = Array.from({ length: 25 }, (_, i) => rawV1(`0x${String(i).padStart(3, '0')}`));
      await sync(mod, newApi(many));
      await assert.rejects(sync(mod, newApi([many[0]])), /Suspicious sync/);
      assert.equal(count(db, 'vaults'), 25);
    })],
    ['chainIds передаються в запит і пишуть last_sync_partial', async mod => sandbox(async db => {
      const api = newApi([rawV1('0xaaa')]);
      await sync(mod, api, { chainIds: [8453] });
      assert.ok(api.calls.some(v => v.where?.chainId_in?.[0] === 8453));
      assert.ok(db.prepare("SELECT 1 FROM sync_state WHERE key = 'last_sync_partial'").get());
      assert.equal(db.prepare("SELECT 1 FROM sync_state WHERE key = 'last_sync_all'").get(), undefined);
    })],
    ['повторна синхронізація не дублює алокації', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa')])); await sync(mod, newApi([rawV1('0xaaa')]));
      assert.equal(count(db, 'vault_allocations'), 1); assert.equal(count(db, 'vaults'), 1);
    })],
    ['V2 з MetaMorpho-адаптером розкладає актив по ринках базового V1', async mod => sandbox(async db => {
      const v2 = rawV2('0xbbb', '0xm9', { caps: { items: [] }, adapters: { items: [{ type: 'MetaMorpho', assets: '500000000', metaMorpho: { address: '0xaaa' } }] } });
      await sync(mod, newApi([rawV1('0xaaa')], [v2]));
      const row = db.prepare("SELECT via_vault FROM vault_allocations WHERE vault_address = '0xbbb'").get();
      assert.equal(row.via_vault, '0xaaa');
    })],
    ['look-through у БД: 500 з 1000 базового vault (600 у 0xm1) = 300 USDC, вага 0.6, адреса V1 у верхньому регістрі', async mod => sandbox(async db => {
      const v2 = rawV2('0xbbb', '0xm9', { caps: { items: [] }, adapters: { items: [{ type: 'MetaMorpho', assets: '500000000', metaMorpho: { address: '0xaaa' } }] } });
      await sync(mod, newApi([rawV1('0xAAA')], [v2]));
      const row = db.prepare("SELECT * FROM vault_allocations WHERE vault_address = '0xbbb'").get();
      assert.equal(row.market_unique_key, '1:0xm1'); assert.equal(row.supply_assets, '300000000');
      assert.equal(row.supply_assets_human, 300); assert.equal(row.supply_assets_usd, 300); assert.equal(row.weight, 0.6);
      assert.equal(row.via_vault, '0xaaa');
    })],
    ['спільний ринок двох V1-vaults записується один раз (marketsCount = 1)', async mod => sandbox(async db => {
      const r = await sync(mod, newApi([rawV1('0xaaa'), rawV1('0xccc')]));
      assert.equal(r.marketsCount, 1); assert.equal(r.allocationsCount, 2); assert.equal(count(db, 'markets'), 1);
    })],
    ['той самий marketId у мережах 1 і 8453 дає два ринки, алокації V1 і V2 посилаються на ключ своєї мережі', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa', { chain: { id: 8453 } }), rawV1('0xccc')], [rawV2('0xbbb', '0xm2', { chain: { id: 8453 } })]));
      assert.deepEqual(keys(db, 'SELECT unique_key, chain_id FROM markets ORDER BY unique_key'), ['1:0xm1|1', '8453:0xm1|8453', '8453:0xm2|8453']);
      assert.deepEqual(keys(db, 'SELECT vault_address, market_unique_key FROM vault_allocations ORDER BY vault_address'),
        ['0xaaa|8453:0xm1', '0xbbb|8453:0xm2', '0xccc|1:0xm1']);
    })],
    ['ринок, що випав з алокацій, видаляється разом зі старою алокацією (V1 і V2)', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa')], [rawV2('0xbbb', '0xm2')]));
      const a2 = rawV1('0xaaa', { state: { ...rawV1('0xaaa').state, allocation: [{ supplyAssets: '100000000', supplyCap: '0', market: rawMarket('0xm3') }] } });
      await sync(mod, newApi([a2], [rawV2('0xbbb', '0xm4')]));
      assert.deepEqual(keys(db, 'SELECT unique_key FROM markets ORDER BY 1'), ['1:0xm3', '1:0xm4']);
      assert.deepEqual(keys(db, 'SELECT vault_address, market_unique_key FROM vault_allocations ORDER BY 1'), ['0xaaa|1:0xm3', '0xbbb|1:0xm4']);
    })],
    ['лічильник пропусків скидається, коли vault повертається: 1, 2, потім 0, потім 1', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa'), rawV1('0xbbb')]));
      const seq = [];
      for (const list of [['0xaaa'], ['0xaaa'], ['0xaaa', '0xbbb'], ['0xaaa']]) {
        await sync(mod, newApi(list.map(a => rawV1(a)))); seq.push(missed(db, '0xbbb'));
      }
      assert.deepEqual(seq, [1, 2, 0, 1]); assert.equal(missed(db, '0xaaa'), 0);
    })],
    ['синхронізація по мережах (chainIds) не збільшує missed_syncs відсутніх vaults', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa'), rawV1('0xbbb')]));
      for (let i = 0; i < 3; i++) await sync(mod, newApi([rawV1('0xaaa')]), { chainIds: [1] });
      assert.equal(missed(db, '0xbbb'), 0);
    })],
    ['порожня відповідь API (0 лістингованих) не збільшує missed_syncs і нічого не видаляє', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa')]));
      for (let i = 0; i < 3; i++) await sync(mod, newApi([]));
      assert.equal(missed(db, '0xaaa'), 0); assert.equal(count(db, 'vaults'), 1); assert.equal(count(db, 'markets'), 1);
    })],
    ['межа захисту від обірваної відповіді: 22 відомих, 11 отриманих (6 V1 + 5 V2) проходить, 10 скасовує', async mod => sandbox(async db => {
      await sync(mod, newApi(v1s(11), v2s(11)));
      await sync(mod, newApi(v1s(6), v2s(5)));
      assert.equal(count(db, 'vaults'), 22); assert.equal(missed(db, '0xa10'), 1);
      await assert.rejects(sync(mod, newApi(v1s(5), v2s(5))), /Suspicious sync: API returned 10 listed vaults, DB has 22/);
      assert.equal(missed(db, '0xa10'), 1);
    })],
    ['захист не діє при 20 відомих (потрібно > 20) і для синхронізації по мережах', async mod => sandbox(async db => {
      await sync(mod, newApi(v1s(20)));
      await sync(mod, newApi(v1s(1)));
      assert.equal(missed(db, '0xa05'), 1);
      await sync(mod, newApi(v1s(22)));
      const r = await sync(mod, newApi(v1s(1)), { chainIds: [1] });
      assert.equal(r.v1Count, 1);
    })],
    ['збій запису посеред транзакції (true не біндиться в SQLite) відкочує все: БД як до синхронізації', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa'), rawV1('0xbbb')], [rawV2('0xccc')]));
      db.prepare("UPDATE sync_state SET value = '1', updated_at = 1 WHERE key = 'last_sync_all'").run();
      const snap = () => ['vaults', 'markets', 'vault_allocations', 'sync_state'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all());
      const before = snap();
      let heard = 0; mod.onSyncSuccess(() => { heard++; });
      const changed = rawV1('0xaaa', { state: { ...rawV1('0xaaa').state, totalAssets: '9000000000', totalAssetsUsd: 9000, allocation: [{ supplyAssets: '1', supplyCap: '0', market: rawMarket('0xm7') }] } });
      // 0xbbb відсутній (missed_syncs), 0xeee новий, 0xccc оновлюється, і лише останній V2 ламає запис
      await assert.rejects(sync(mod, newApi([changed, rawV1('0xeee')], [rawV2('0xccc', '0xm5'), rawV2('0xddd', '0xm8', { apy: Symbol('x') })])), /bound|bind/i);
      assert.deepEqual(snap(), before);
      assert.equal(mod.getLastSyncResult().success, false); assert.equal(mod.isSyncing(), false); assert.equal(heard, 0);
      // транзакція не лишилась відкритою: наступна синхронізація комітиться
      await sync(mod, newApi([changed], [rawV2('0xccc')]));
      assert.equal(db.prepare("SELECT total_assets FROM vaults WHERE address = '0xaaa'").get().total_assets, '9000000000');
      assert.equal(heard, 1);
    })],
    ['куратор: ім\'я з каталогу зберігається, коли каталог його вже не знає, і оновлюється на нове ім\'я', async mod => sandbox(async db => {
      const api = c => newApi([v1Curated('0xaaa', '0xCAFE')], [], c);
      await sync(mod, api(dir(['Gauntlet', '0xcafe']))); assert.equal(curatorOf(db, '0xaaa'), 'Gauntlet');
      await sync(mod, api([])); assert.equal(curatorOf(db, '0xaaa'), 'Gauntlet');
      await sync(mod, api(dir(['Steakhouse', '0xcafe']))); assert.equal(curatorOf(db, '0xaaa'), 'Steakhouse');
    })],
    ['куратор: сира адреса замінюється іменем, щойно воно з\'являється в каталозі; адреса -> інша адреса оновлюється', async mod => sandbox(async db => {
      await sync(mod, newApi([v1Curated('0xaaa', '0xCAFE'), v1Curated('0xccc', '0xCAFE')]));
      assert.equal(curatorOf(db, '0xaaa'), '0xCAFE');
      await sync(mod, newApi([v1Curated('0xaaa', '0xCAFE'), v1Curated('0xccc', '0xBEEF')], [], dir(['Gauntlet', '0xcafe'])));
      assert.equal(curatorOf(db, '0xaaa'), 'Gauntlet'); assert.equal(curatorOf(db, '0xccc'), '0xBEEF');
    })],
    ['vault без куратора (Independent), що отримав куратора поза каталогом, не лишається Independent', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa', { state: { ...rawV1('0xaaa').state, curator: '0x0000000000000000000000000000000000000000' } })]));
      assert.equal(curatorOf(db, '0xaaa'), 'Independent');
      await sync(mod, newApi([v1Curated('0xaaa', '0xBEEF')]));
      assert.equal(curatorOf(db, '0xaaa'), '0xBEEF');
    })],
    ['C1: нерозв\'язаний адаптер V2 зберігається як unresolved_exposure_usd (300 із 500), у V1 - 0', async mod => sandbox(async db => {
      const v2 = rawV2('0xbbb', '0xm9', { caps: { items: [] }, adapters: { items: [{ type: 'MetaMorpho', assets: '300000000', metaMorpho: { address: '0xnone' } }] } });
      await sync(mod, newApi([rawV1('0xaaa')], [v2]));
      const u = a => db.prepare('SELECT unresolved_exposure_usd AS u FROM vaults WHERE address = ?').get(a).u;
      assert.equal(u('0xbbb'), 300); assert.equal(u('0xaaa'), 0);
    })],
    ['V1 з allocation: null -> увесь TVL нерозкритий (1000), а не чистий кеш', async mod => sandbox(async db => {
      const noAlloc = rawV1('0xaaa', { state: { ...rawV1('0xaaa').state, allocation: null } });
      await sync(mod, newApi([noAlloc]));
      assert.equal(db.prepare('SELECT unresolved_exposure_usd AS u FROM vaults WHERE address = ?').get('0xaaa').u, 1000);
    })],
    ['V1 з позицією без ринку (400 із 1000) -> 400 нерозкрито', async mod => sandbox(async db => {
      const base = rawV1('0xaaa').state;
      const v = rawV1('0xaaa', { state: { ...base, allocation: [...base.allocation, { supplyAssets: '400000000', supplyAssetsUsd: 400, market: null }] } });
      await sync(mod, newApi([v]));
      assert.equal(db.prepare('SELECT unresolved_exposure_usd AS u FROM vaults WHERE address = ?').get('0xaaa').u, 400);
    })],
    ['V2 з MorphoMarketV1-адаптером на 500 без caps -> 500 нерозкрито', async mod => sandbox(async db => {
      const v2 = rawV2('0xbbb', '0xm9', { caps: { items: [] }, adapters: { items: [{ type: 'MorphoMarketV1', assets: '500000000' }] } });
      await sync(mod, newApi([], [v2]));
      assert.equal(db.prepare('SELECT unresolved_exposure_usd AS u FROM vaults WHERE address = ?').get('0xbbb').u, 500);
    })],
    ['V2 без ціни активу бере ціну з ринків і рахує нерозкрите в USD (500 * 1)', async mod => sandbox(async db => {
      const v2 = rawV2('0xbbb', '0xm9', {
        asset: { ...asset('USDC'), price: null }, totalAssetsUsd: null, totalAssets: '1000000000',
        caps: { items: [{ allocation: '500000000', absoluteCap: '0', data: { market: rawMarket('0xm9') } }] },
        adapters: { items: [{ type: 'MorphoMarketV1', assets: '1000000000' }] }
      });
      await sync(mod, newApi([], [v2]));
      const row = db.prepare('SELECT asset_price_usd AS p, total_assets_usd AS t, unresolved_exposure_usd AS u FROM vaults WHERE address = ?').get('0xbbb');
      assert.equal(row.p, 1); assert.equal(row.t, 1000); assert.equal(row.u, 500);
    })],
    ['V1 без жодної ціни лишається з total_assets_usd 0 (unpriced), алокації 0 USD', async mod => sandbox(async db => {
      const noPrice = { ...asset('USDC'), price: null };
      const v = rawV1('0xaaa', { asset: noPrice, state: { totalAssets: '1000000000', curator: '0x0', allocation: [{ supplyAssets: '600000000', market: rawMarket('0xm1', { loanAsset: noPrice }) }] } });
      await sync(mod, newApi([v]));
      assert.equal(db.prepare('SELECT total_assets_usd AS t FROM vaults WHERE address = ?').get('0xaaa').t, 0);
      assert.equal(db.prepare('SELECT supply_assets_usd AS s FROM vault_allocations WHERE vault_address = ?').get('0xaaa').s, 0);
    })],
    ['C2: V1 без liquidity в API -> liquidity_usd NULL, із liquidity.usd 0 -> 0', async mod => sandbox(async db => {
      await sync(mod, newApi([rawV1('0xaaa'), rawV1('0xccc', { liquidity: { usd: 0 } })]));
      const l = a => db.prepare('SELECT liquidity_usd AS l FROM vaults WHERE address = ?').get(a).l;
      assert.equal(l('0xaaa'), null); assert.equal(l('0xccc'), 0);
    })],
    ['синхронізація записує vault_watch_state і події з adminEvents/pendingConfigs у vault_events', async mod => sandbox(async db => {
      const nowSec = Math.floor(Date.now() / 1000);
      const v1WithEvents = rawV1('0xaaa', {
        adminEvents: {
          items: [{ hash: '0xh1', timestamp: nowSec - 300, type: 'setCurator', data: { curatorAddress: '0xc1' } }]
        }
      });
      await sync(mod, newApi([v1WithEvents]));
      const watchCount = db.prepare('SELECT COUNT(*) AS c FROM vault_watch_state WHERE vault_address = ?').get('0xaaa').c;
      const evs = db.prepare('SELECT kind, source, status FROM vault_events WHERE vault_address = ?').all('0xaaa');
      assert.equal(watchCount, 1);
      assert.deepEqual(evs.map(e => ({ ...e })), [{ kind: 'curator_changed', source: 'admin_event', status: 'final' }]);
    })],
  ],
  unresolvedAdapterAssets: [
    ['MetaMorpho поза v1ByAddress, MetaMorpho з порожнім базовим, невідомий тип і MorphoMarketV1 без caps рахуються; розв\'язаний - ні', ({ unresolvedAdapterAssets: f }) => {
      const under = { address: '0xu', state: { totalAssets: '100', allocation: [{ supplyAssets: '100', market: { marketId: '0xA' } }] } };
      const empty = { address: '0xe', state: { totalAssets: '0', allocation: [] } };
      const items = [
        { type: 'MetaMorpho', assets: '10', metaMorpho: { address: '0xnone' } },
        { type: 'MetaMorpho', assets: '20', metaMorpho: { address: '0xE' } },
        { type: 'MorphoVaultV2', assets: '40' },
        { type: 'MorphoMarketV1', assets: '1000' },
        { type: 'MetaMorpho', assets: '500', metaMorpho: { address: '0xU' } },
        { type: 'Other', assets: '0' },
      ];
      assert.equal(f({ adapters: { items } }, new Map([['0xu', under], ['0xe', empty]])), 1070n);
    }],
    ['без адаптерів -> 0n', ({ unresolvedAdapterAssets: f }) => assert.equal(f({}, new Map()), 0n)],
    ['MorphoMarketV1: caps покривають усі активи -> 0, покривають частину -> лишок', ({ unresolvedAdapterAssets: f }) => {
      const cap = a => ({ allocation: a, data: { market: { marketId: '0xA' } } });
      const adapters = { items: [{ type: 'MorphoMarketV1', assets: '1000' }] };
      assert.equal(f({ adapters, caps: { items: [cap('1000')] } }, new Map()), 0n);
      assert.equal(f({ adapters, caps: { items: [cap('600')] } }, new Map()), 400n);
    }],
    ['MorphoMarketV1: розрив до 0.5% (нараховані відсотки) не є нерозкритим капіталом, понад 0.5% є', ({ unresolvedAdapterAssets: f }) => {
      const cap = a => ({ allocation: a, data: { market: { marketId: '0xA' } } });
      const adapters = { items: [{ type: 'MorphoMarketV1', assets: '10000' }] };
      assert.equal(f({ adapters, caps: { items: [cap('9950')] } }, new Map()), 0n);
      assert.equal(f({ adapters, caps: { items: [cap('9949')] } }, new Map()), 51n);
    }],
    ['MorphoMarketV1: caps більші за активи адаптера (від\'ємний розрив) і кілька адаптерів сумуються без нерозкритого', ({ unresolvedAdapterAssets: f }) => {
      const cap = a => ({ allocation: a, data: { market: { marketId: '0xA' } } });
      const two = { items: [{ type: 'MorphoMarketV1', assets: '600' }, { type: 'MorphoMarketV1', assets: '400' }] };
      assert.equal(f({ adapters: two, caps: { items: [cap('700'), cap('500')] } }, new Map()), 0n);
      assert.equal(f({ adapters: two, caps: { items: [cap('500')] } }, new Map()), 500n);
    }],
    ['MorphoMarketV1: cap з data: null не покриває нічого, активи нерозкриті', ({ unresolvedAdapterAssets: f }) =>
      assert.equal(f({ adapters: { items: [{ type: 'MorphoMarketV1', assets: '1000' }] }, caps: { items: [{ allocation: '1000', data: null }] } }, new Map()), 1000n)],
    ['базовий V1 з allocation: null -> увесь актив адаптера нерозкритий', ({ unresolvedAdapterAssets: f }) => {
      const under = { address: '0xu', state: { totalAssets: '100', allocation: null } };
      assert.equal(f({ adapters: { items: [{ type: 'MetaMorpho', assets: '40', metaMorpho: { address: '0xu' } }] } }, new Map([['0xu', under]])), 40n);
    }],
    ['позиції базового V1 без ринку: їхня частка адаптера нерозкрита (25 зі 100 -> 10 із 40)', ({ unresolvedAdapterAssets: f }) => {
      const under = { address: '0xu', state: { totalAssets: '100', allocation: [{ supplyAssets: '75', market: { marketId: '0xA' } }, { supplyAssets: '25', market: null }] } };
      assert.equal(f({ adapters: { items: [{ type: 'MetaMorpho', assets: '40', metaMorpho: { address: '0xu' } }] } }, new Map([['0xu', under]])), 10n);
    }],
  ],
  unresolvedV1Assets: [
    ['allocation: null -> увесь totalAssets нерозкритий', ({ unresolvedV1Assets: f }) =>
      assert.equal(f({ state: { totalAssets: '900', allocation: null } }), 900n)],
    ['allocation відсутня -> увесь totalAssets', ({ unresolvedV1Assets: f }) =>
      assert.equal(f({ state: { totalAssets: '900' } }), 900n)],
    ['порожній масив allocation -> увесь totalAssets (API не дав позицій: невідомість, а не кеш)', ({ unresolvedV1Assets: f }) =>
      assert.equal(f({ state: { totalAssets: '900', allocation: [] } }), 900n)],
    ['порожній масив allocation і нульовий totalAssets -> 0 (порожній vault)', ({ unresolvedV1Assets: f }) =>
      assert.equal(f({ state: { totalAssets: '0', allocation: [] } }), 0n)],
    ['є позиції з ринком, решта TVL -> 0 (справжній idle на контракті)', ({ unresolvedV1Assets: f }) =>
      assert.equal(f({ state: { totalAssets: '900', allocation: [{ supplyAssets: '500', market: { marketId: '0xA' } }] } }), 0n)],
    ['позиції без ринку сумуються, позиції з ринком ні', ({ unresolvedV1Assets: f }) =>
      assert.equal(f({ state: { totalAssets: '900', allocation: [{ supplyAssets: '100', market: null }, { supplyAssets: '50', market: { marketId: '0xA' } }, { supplyAssets: '30', market: null }] } }), 130n)],
  ],
  withResolvedPrice: [
    ['є TVL у USD, а ціни токена немає -> ціна виводиться з TVL (6 / 3 токени = 2)', ({ withResolvedPrice: f }) => {
      const r = f({ total_assets: '3000000', asset_decimals: 6, total_assets_usd: 6, asset_price_usd: 0 }, []);
      assert.equal(r.asset_price_usd, 2); assert.equal(r.total_assets_usd, 6);
    }],
    ['є total_assets_usd -> vault без змін', ({ withResolvedPrice: f }) => {
      const v = { total_assets: '1000000', asset_decimals: 6, total_assets_usd: 5, asset_price_usd: 5 };
      assert.equal(f(v, [{ loanAsset: { price: { usd: 9 } } }]), v);
    }],
    ['ціни немає, але ринок кредитує той самий токен -> ціна й TVL з ринку (2 * 3 = 6)', ({ withResolvedPrice: f }) => {
      const r = f({ total_assets: '2000000', asset_decimals: 6, total_assets_usd: 0, asset_price_usd: 0 }, [null, { loanAsset: { price: { usd: 0 } } }, { loanAsset: { price: { usd: 3 } } }]);
      assert.equal(r.asset_price_usd, 3); assert.equal(r.total_assets_usd, 6);
    }],
    ['нульова USD-ліквідність непризначеного активу стає невідомою (null), ненульова лишається', ({ withResolvedPrice: f }) => {
      const base = { total_assets: '2000000', asset_decimals: 6, total_assets_usd: 0, asset_price_usd: 0 };
      const markets = [{ loanAsset: { price: { usd: 3 } } }];
      assert.equal(f({ ...base, liquidity_usd: 0 }, markets).liquidity_usd, null);
      assert.equal(f({ ...base, liquidity_usd: 4 }, markets).liquidity_usd, 4);
      assert.equal(f({ ...base, liquidity_usd: null }, markets).liquidity_usd, null);
    }],
    ['жодного ринку з ціною -> vault лишається без ціни', ({ withResolvedPrice: f }) => {
      const v = { total_assets: '2000000', asset_decimals: 6, total_assets_usd: 0, asset_price_usd: 0 };
      assert.equal(f(v, [{ loanAsset: {} }]).total_assets_usd, 0);
    }],
  ],
  toBigInt: [
    ['рядок -> BigInt', ({ toBigInt: f }) => assert.equal(f('123'), 123n)],
    ['порожнє/null -> 0n', ({ toBigInt: f }) => { assert.equal(f(''), 0n); assert.equal(f(null), 0n); }],
    ['некоректний рядок -> 0n', ({ toBigInt: f }) => assert.equal(f('abc'), 0n)],
    ['дробове число -> 0n', ({ toBigInt: f }) => assert.equal(f(1.5), 0n)],
  ],
  expandMetaMorphoAdapters: [
    ['базовий vault з тією ж адресою в іншій мережі не розкриває адаптер', ({ expandMetaMorphoAdapters: f, unresolvedAdapterAssets: u }) => {
      const under = { address: '0xunder', chain: { id: 1 }, state: { totalAssets: '1000', allocation: [{ supplyAssets: '1000', market: { marketId: '0xA' } }] } };
      const v2 = { chain: { id: 8453 }, adapters: { items: [{ type: 'MetaMorpho', assets: '500', metaMorpho: { address: '0xUNDER' } }] } };
      assert.equal(f(v2, new Map([['0xunder', under]])).length, 0);
      assert.equal(u(v2, new Map([['0xunder', under]])), 500n);
      assert.equal(f({ ...v2, chain: { id: 1 } }, new Map([['0xunder', under]])).length, 1);
    }],
    ['прямі caps переносяться як є', ({ expandMetaMorphoAdapters: f }) => {
      const r = f({ caps: { items: [{ allocation: '100', absoluteCap: '500', data: { market: { marketId: '0xA' } } }] } }, new Map());
      assert.equal(r.length, 1); assert.equal(r[0].allocation, '100'); assert.equal(r[0].viaVault, undefined);
    }],
    ['MetaMorpho-адаптер розкладається пропорційно', ({ expandMetaMorphoAdapters: f }) => {
      const under = { address: '0xUnder', state: { totalAssets: '1000', allocation: [{ supplyAssets: '600', market: { marketId: '0xA' } }, { supplyAssets: '400', market: { marketId: '0xB' } }] } };
      const r = f({ adapters: { items: [{ type: 'MetaMorpho', assets: '500', metaMorpho: { address: '0xUNDER' } }] } }, new Map([['0xunder', under]]));
      const byKey = Object.fromEntries(r.map(c => [c.data.market.marketId, c]));
      assert.equal(byKey['0xA'].allocation, '300'); assert.equal(byKey['0xB'].allocation, '200');
      assert.equal(byKey['0xA'].viaVault, '0xunder');
    }],
    ['нерозв\'язаний адаптер пропускається', ({ expandMetaMorphoAdapters: f }) => {
      const warn = console.warn; console.warn = () => {};
      try {
        assert.deepEqual(f({ name: 'V', adapters: { items: [{ type: 'MetaMorpho', assets: '500', metaMorpho: { address: '0xnone' } }] } }, new Map()), []);
      } finally { console.warn = warn; }
    }],
    ['адаптер іншого типу ігнорується', ({ expandMetaMorphoAdapters: f }) =>
      assert.deepEqual(f({ adapters: { items: [{ type: 'Other', assets: '5' }] } }, new Map()), [])],
    ['пряма алокація і look-through в одному ринку сумуються', ({ expandMetaMorphoAdapters: f }) => {
      const under = { address: '0xu', state: { totalAssets: '100', allocation: [{ supplyAssets: '100', market: { marketId: '0xA' } }] } };
      const r = f({ caps: { items: [{ allocation: '10', absoluteCap: '0', data: { market: { marketId: '0xA' } } }] },
        adapters: { items: [{ type: 'MetaMorpho', assets: '50', metaMorpho: { address: '0xu' } }] } }, new Map([['0xu', under]]));
      assert.equal(r.length, 1); assert.equal(r[0].allocation, '60'); assert.equal(r[0].viaVault, '0xu');
      assert.equal(r[0].absoluteCap, '0');
    }],
    ['marketId у різному регістрі зводиться в одну позицію (0xA + 0xa), absoluteCap прямого cap зберігається', ({ expandMetaMorphoAdapters: f }) => {
      const under = { address: '0xu', state: { totalAssets: '100', allocation: [{ supplyAssets: '100', market: { marketId: '0xa' } }] } };
      const r = f({ caps: { items: [{ allocation: '10', absoluteCap: '777', data: { market: { marketId: '0xA' } } }] },
        adapters: { items: [{ type: 'MetaMorpho', assets: '5', metaMorpho: { address: '0xu' } }] } }, new Map([['0xu', under]]));
      assert.equal(r.length, 1); assert.equal(r[0].allocation, '15'); assert.equal(r[0].absoluteCap, '777'); assert.equal(r[0].viaVault, undefined);
    }],
    ['мажоритарний via_vault: рівно 50/50 не позначається, 51 з 100 позначається', ({ expandMetaMorphoAdapters: f }) => {
      const under = { address: '0xu', state: { totalAssets: '100', allocation: [{ supplyAssets: '100', market: { marketId: '0xA' } }] } };
      const run = (direct, viaAssets) => f({ caps: { items: [{ allocation: direct, absoluteCap: '0', data: { market: { marketId: '0xA' } } }] },
        adapters: { items: [{ type: 'MetaMorpho', assets: viaAssets, metaMorpho: { address: '0xu' } }] } }, new Map([['0xu', under]]))[0];
      const tie = run('50', '50'); assert.equal(tie.allocation, '100'); assert.equal(tie.viaVault, undefined);
      const major = run('49', '51'); assert.equal(major.allocation, '100'); assert.equal(major.viaVault, '0xu');
    }],
    ['округлення вниз: базовий 3 = [2, 1], адаптер 2 -> частки 1 і 0, нульова частка не додається', ({ expandMetaMorphoAdapters: f }) => {
      const under = { address: '0xu', state: { totalAssets: '3', allocation: [{ supplyAssets: '2', market: { marketId: '0xA' } }, { supplyAssets: '1', market: { marketId: '0xB' } }] } };
      const r = f({ adapters: { items: [{ type: 'MetaMorpho', assets: '2', metaMorpho: { address: '0xu' } }] } }, new Map([['0xu', under]]));
      assert.deepEqual(r.map(c => [c.data.market.marketId, c.allocation]), [['0xA', '1']]);
    }],
    ['сума часток не перевищує актив адаптера: 3 рівні ринки, адаптер 100 -> по 33 (разом 99)', ({ expandMetaMorphoAdapters: f }) => {
      const alloc = ['0xA', '0xB', '0xC'].map(id => ({ supplyAssets: '1', market: { marketId: id } }));
      const r = f({ adapters: { items: [{ type: 'MetaMorpho', assets: '100', metaMorpho: { address: '0xu' } }] } },
        new Map([['0xu', { address: '0xu', state: { totalAssets: '3', allocation: alloc } }]]));
      assert.deepEqual(r.map(c => c.allocation), ['33', '33', '33']);
    }],
    ['точна BigInt-арифметика понад 2^53: 1e24+1 по 75%/25% від 2e24 -> 7.5e23 і 2.5e23', ({ expandMetaMorphoAdapters: f }) => {
      const under = { address: '0xu', state: { totalAssets: '2000000000000000000000000', allocation: [
        { supplyAssets: '1500000000000000000000000', market: { marketId: '0xA' } }, { supplyAssets: '500000000000000000000000', market: { marketId: '0xB' } }] } };
      const r = f({ adapters: { items: [{ type: 'MetaMorpho', assets: '1000000000000000000000001', metaMorpho: { address: '0xu' } }] } }, new Map([['0xu', under]]));
      assert.deepEqual(r.map(c => c.allocation), ['750000000000000000000000', '250000000000000000000000']);
    }],
    ['базовий vault з нульовим totalAssets пропускається без ділення на нуль', ({ expandMetaMorphoAdapters: f }) => {
      const warn = console.warn; console.warn = () => {};
      try {
        const under = { address: '0xu', state: { totalAssets: '0', allocation: [{ supplyAssets: '5', market: { marketId: '0xA' } }] } };
        assert.deepEqual(f({ adapters: { items: [{ type: 'MetaMorpho', assets: '10', metaMorpho: { address: '0xu' } }] } }, new Map([['0xu', under]])), []);
      } finally { console.warn = warn; }
    }],
    ['адаптер не MetaMorpho ігнорується, навіть якщо має metaMorpho-адресу відомого vault', ({ expandMetaMorphoAdapters: f }) => {
      const under = { address: '0xu', state: { totalAssets: '100', allocation: [{ supplyAssets: '100', market: { marketId: '0xA' } }] } };
      assert.deepEqual(f({ adapters: { items: [{ type: 'MorphoMarketV1', assets: '50', metaMorpho: { address: '0xu' } }] } }, new Map([['0xu', under]])), []);
    }],
    ['алокації базового vault більші за його totalAssets (80 + 40 > 100): частки не перевищують актив адаптера 50', ({ expandMetaMorphoAdapters: f }) => {
      const under = { address: '0xu', state: { totalAssets: '100', allocation: [{ supplyAssets: '80', market: { marketId: '0xA' } }, { supplyAssets: '40', market: { marketId: '0xB' } }] } };
      const r = f({ adapters: { items: [{ type: 'MetaMorpho', assets: '50', metaMorpho: { address: '0xu' } }] } }, new Map([['0xu', under]]));
      const sum = r.reduce((s, c) => s + BigInt(c.allocation), 0n);
      assert.ok(sum <= 50n, `сума часток ${sum} > 50`);
    }],
  ],
  isSyncing: [
    ['після імпорту синхронізація не активна', ({ isSyncing }) => assert.equal(isSyncing(), false)],
  ],
  getLastSyncResult: [
    ['після збою: success=false, failedAt = поточний час, загальне повідомлення без деталей помилки', async mod => sandbox(async () => {
      await withFetch(async () => jsonResponse({}, 500), async () => {
        const saved = CONFIG.api.maxRetries; CONFIG.api.maxRetries = 0;
        try { await assert.rejects(mod.syncAllVaults()); } finally { CONFIG.api.maxRetries = saved; }
      });
      const r = mod.getLastSyncResult();
      assert.equal(r.success, false); assert.equal(r.error, 'Synchronization failed');
      assert.ok(Math.abs(r.failedAt - Date.now() / 1000) < 60);
    })],
    ['після успіху summary збігається з поверненим підсумком', async mod => sandbox(async () => {
      const summary = await sync(mod, newApi([rawV1('0xaaa')], [rawV2('0xbbb')]));
      const r = mod.getLastSyncResult();
      assert.equal(r.success, true); assert.deepEqual(r.summary, summary); assert.equal(r.durationSec, summary.durationSec);
      assert.ok(Math.abs(r.completedAt - Date.now() / 1000) < 60);
    })],
  ],
  onSyncSuccess: [
    ['усі зареєстровані слухачі викликаються по разу в порядку реєстрації', async mod => sandbox(async () => {
      const order = [];
      mod.onSyncSuccess(() => order.push('a')); mod.onSyncSuccess(() => order.push('b'));
      await sync(mod, newApi([rawV1('0xaaa')]));
      assert.deepEqual(order, ['a', 'b']);
    })],
  ],
};
