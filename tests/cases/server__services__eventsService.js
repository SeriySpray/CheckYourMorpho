import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../server/db/schema.js';

const NOW = 1_750_000_000;
const DAY = 86400;
const V1_ADDR = '0x1111111111111111111111111111111111111111';
const V2_ADDR = '0x2222222222222222222222222222222222222222';
const MKT_KEY = '0xmarket1';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare(`
    INSERT INTO vaults (
      address, chain_id, name, symbol, curator_name, asset_address,
      asset_symbol, asset_decimals, asset_price_usd, total_assets,
      total_assets_usd, liquidity_usd, apy, net_apy, fee, version, is_listed
    ) VALUES (?, 1, ?, ?, 'Gauntlet', '0xusdc', 'USDC', 6, 1.0, '1000000000000', 1000000, 500000, 0.05, 0.045, 0.05, ?, 1)
  `).run(V1_ADDR, 'Gauntlet USDC Prime', 'gtUSDC', 'v1');

  db.prepare(`
    INSERT INTO vaults (
      address, chain_id, name, symbol, curator_name, asset_address,
      asset_symbol, asset_decimals, asset_price_usd, total_assets,
      total_assets_usd, liquidity_usd, apy, net_apy, fee, version, is_listed
    ) VALUES (?, 1, ?, ?, 'Steakhouse', '0xusdc', 'USDC', 6, 1.0, '2000000000000', 2000000, 800000, 0.06, 0.055, 0.05, ?, 1)
  `).run(V2_ADDR, 'Steakhouse USDC V2', 'stUSDC', 'v2');

  db.prepare(`
    INSERT INTO markets (
      unique_key, chain_id, loan_asset_address, loan_asset_symbol, loan_asset_decimals, loan_asset_price_usd,
      collateral_asset_address, collateral_asset_symbol, collateral_asset_decimals, collateral_asset_price_usd,
      oracle_address, lltv, lltv_percent, total_supply_assets_usd, total_borrow_assets_usd,
      free_liquidity_usd, utilization, is_listed, bad_debt_usd, realized_bad_debt_usd, warnings_count, warnings_json
    ) VALUES (?, 1, '0xusdc', 'USDC', 6, 1.0, '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', 'wstETH', 18, 3000,
      '0x1234567890123456789012345678901234567890', '860000000000000000', 86, 5000000, 3000000,
      2000000, 0.6, 1, 0, 0, 0, '[]')
  `).run(MKT_KEY);

  db.prepare(`
    INSERT INTO vault_allocations (
      vault_address, market_unique_key, supply_assets, supply_assets_human, supply_assets_usd,
      supply_cap, supply_cap_human, weight
    ) VALUES (?, ?, '800000000000', 800000, 800000, '2000000000000', 2000000, 0.8)
  `).run(V1_ADDR, MKT_KEY);

  return db;
}

export default {
  pruneOldEvents: [
    ['видаляє завершені події старіші за 180 днів, але зберігає свіжі та усі зі статусом pending', ({ pruneOldEvents }) => {
      const db = makeDb();
      const ins = db.prepare(`
        INSERT INTO vault_events (
          vault_address, chain_id, kind, source, severity, status,
          title, details_json, dedupe_key, occurred_at, valid_at, detected_at
        ) VALUES (?, 1, ?, ?, 'warning', ?, 'title', '{}', ?, ?, ?, ?)
      `);
      ins.run(V1_ADDR, 'fee_changed', 'admin_event', 'final', 'k-old-final', NOW - 190 * DAY, null, NOW - 190 * DAY);
      ins.run(V1_ADDR, 'pending_cap_increase', 'pending_config', 'applied', 'k-old-applied', NOW - 185 * DAY, NOW - 184 * DAY, NOW - 185 * DAY);
      ins.run(V1_ADDR, 'pending_cap_increase', 'pending_config', 'pending', 'k-old-pending', NOW - 200 * DAY, NOW + DAY, NOW - 200 * DAY);
      ins.run(V1_ADDR, 'fee_changed', 'admin_event', 'final', 'k-recent', NOW - 10 * DAY, null, NOW - 10 * DAY);

      const deleted = pruneOldEvents(db, NOW, 180);
      const remaining = db.prepare('SELECT dedupe_key FROM vault_events ORDER BY dedupe_key').all().map(r => r.dedupe_key);
      db.close();

      assert.equal(deleted, 2);
      assert.deepEqual(remaining, ['k-old-pending', 'k-recent']);
    }],
  ],
  syncVaultEvents: [
    ['перший прохід створює watch_state без похідних подій, зберігає свіжі адмін-події (<7д) і активні pendingConfigs', ({ syncVaultEvents }) => {
      const db = makeDb();
      const rawV1 = [{
        address: V1_ADDR,
        state: {
          timelock: 86400,
          guardian: '0x3333333333333333333333333333333333333333',
          pendingConfigs: {
            items: [{
              validAt: NOW + 3600,
              functionName: 'SetTimelock',
              txHash: '0xpend1',
              decodedData: { __typename: 'VaultSetTimelockPendingData', timelock: 172800 }
            }]
          }
        },
        adminEvents: {
          items: [
            { hash: '0xold', timestamp: NOW - 10 * DAY, type: 'setCurator', data: { curatorAddress: '0xc0' } },
            { hash: '0xrecent', timestamp: NOW - 2 * DAY, type: 'setCurator', data: { curatorAddress: '0xc1' } }
          ]
        }
      }];
      const rawV2 = [{
        address: V2_ADDR,
        performanceFee: 0.05,
        managementFee: 0,
        timelocks: [{ functionName: 'addAdapter', selector: '0x60d54d41', duration: 86400 }],
        pendingConfigs: {
          items: [{
            validAt: NOW + 7200,
            functionName: 'AddAdapter',
            txHash: '0xpend2',
            data: '0x60d54d41',
            decodedData: { __typename: 'VaultV2AdapterPendingData', adapterAddress: '0x4444444444444444444444444444444444444444' }
          }]
        }
      }];

      const res1 = syncVaultEvents(db, rawV1, rawV2, { nowSec: NOW });
      assert.equal(res1.vaultsProcessed, 2);
      assert.equal(res1.insertedCount, 3); // 1 recent admin event + 1 V1 pending + 1 V2 pending; 0 derived

      const events = db.prepare('SELECT kind, source, status FROM vault_events ORDER BY id').all();
      assert.deepEqual(events.map(e => ({ ...e })), [
        { kind: 'curator_changed', source: 'admin_event', status: 'final' },
        { kind: 'pending_timelock_change', source: 'pending_config', status: 'pending' },
        { kind: 'pending_adapter_change', source: 'pending_config', status: 'pending' }
      ]);

      // Другий прохід із тими самими даними не дублює жодної події
      const res2 = syncVaultEvents(db, rawV1, rawV2, { nowSec: NOW + 60 });
      assert.equal(res2.insertedCount, 0);
      assert.equal(res2.updatedPendingCount, 0);
      db.close();
    }],
    ['переводить pendingConfigs у applied або revoked після зникнення та виявляє похідні події при зміні стану', ({ syncVaultEvents }) => {
      const db = makeDb();
      db.prepare("UPDATE vaults SET total_assets = '4000000000000', total_assets_usd = 4000000 WHERE address = ?").run(V1_ADDR);
      const rawV1Pass1 = [{
        address: V1_ADDR,
        state: {
          timelock: 86400,
          pendingConfigs: {
            items: [
              {
                validAt: NOW + 100,
                functionName: 'SetTimelock',
                txHash: '0xapply',
                decodedData: { __typename: 'VaultSetTimelockPendingData', timelock: 172800 }
              },
              {
                validAt: NOW + 10000,
                functionName: 'RemoveMarket',
                txHash: '0xrevoke',
                decodedData: { __typename: 'VaultRemoveMarketPendingData', market: { marketId: MKT_KEY } }
              }
            ]
          }
        },
        adminEvents: { items: [] }
      }];

      syncVaultEvents(db, rawV1Pass1, [], { nowSec: NOW });

      // Змінюємо стан у БД: TVL падає на 40% (у токенах), у ринку з'являється bad debt, а обидва pendingConfigs зникають на NOW + 500
      db.prepare("UPDATE vaults SET total_assets = '2400000000000', total_assets_usd = 2400000 WHERE address = ?").run(V1_ADDR);
      db.prepare('UPDATE markets SET bad_debt_usd = 25000 WHERE unique_key = ?').run(MKT_KEY);

      const rawV1Pass2 = [{
        address: V1_ADDR,
        state: { timelock: 172800, pendingConfigs: { items: [] } },
        adminEvents: { items: [] }
      }];

      const res2 = syncVaultEvents(db, rawV1Pass2, [], { nowSec: NOW + 500 });
      assert.equal(res2.updatedPendingCount, 2);

      const pendingStatuses = db.prepare("SELECT kind, status FROM vault_events WHERE source = 'pending_config' ORDER BY id").all();
      assert.deepEqual(pendingStatuses.map(r => ({ ...r })), [
        { kind: 'pending_timelock_change', status: 'applied' },
        { kind: 'pending_market_removal', status: 'revoked' }
      ]);

      const derived = db.prepare("SELECT kind, severity FROM vault_events WHERE source = 'derived' ORDER BY id").all();
      const derivedKinds = derived.map(r => r.kind);
      assert.ok(derivedKinds.includes('tvl_drop'));
      assert.ok(derivedKinds.includes('bad_debt_appeared'));
      assert.ok(!derivedKinds.includes('verdict_worsened'));
      db.close();
    }],
    ['знімок vaults пишеться раз на годину (повторний синк тієї ж години замінює), а старші за 8 діб видаляються', ({ syncVaultEvents }) => {
      const db = makeDb();
      const r1 = syncVaultEvents(db, [], [], { nowSec: NOW });
      assert.equal(r1.samplesWritten, 2);
      syncVaultEvents(db, [], [], { nowSec: NOW + 180 });
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vault_samples').get().c, 2);
      syncVaultEvents(db, [], [], { nowSec: NOW + 3600 });
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vault_samples').get().c, 4);
      const s = db.prepare('SELECT total_assets, total_assets_usd, net_apy, is_listed FROM vault_samples WHERE vault_address = ? ORDER BY hour_bucket LIMIT 1').get(V1_ADDR);
      assert.deepEqual({ ...s }, { total_assets: 1_000_000, total_assets_usd: 1_000_000, net_apy: 0.045, is_listed: 1 });
      syncVaultEvents(db, [], [], { nowSec: NOW + 9 * DAY });
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vault_samples WHERE sampled_at < ?').get(NOW + DAY).c, 0);
      db.close();
    }],
    ['tvl_drop: без знімка у вікні 24 год події немає; з вікном - рахується в токенах, падіння ціни не є відтоком, малий vault нижче $500k ігнорується', ({ syncVaultEvents }) => {
      const db = makeDb();
      const setVault = (addr, tokens, usd, price = 1) => db.prepare('UPDATE vaults SET total_assets = ?, total_assets_usd = ?, asset_price_usd = ? WHERE address = ?').run(String(tokens * 1e6), usd, price, addr);
      const drops = () => db.prepare("SELECT vault_address, severity FROM vault_events WHERE kind = 'tvl_drop' ORDER BY id").all().map(r => ({ ...r }));
      setVault(V1_ADDR, 10_000_000, 10_000_000); setVault(V2_ADDR, 100_000, 100_000);
      syncVaultEvents(db, [], [], { nowSec: NOW });
      assert.deepEqual(drops(), []);
      // V1: -40% токенів; V2: -50%, але лише $50k; після цього падіння ціни ETH-подібного активу без зміни токенів
      setVault(V1_ADDR, 6_000_000, 6_000_000); setVault(V2_ADDR, 50_000, 50_000);
      syncVaultEvents(db, [], [], { nowSec: NOW + 7200 });
      assert.deepEqual(drops(), [{ vault_address: V1_ADDR, severity: 'critical' }]);
      // той самий день і рівень: повторний синк не дублює
      syncVaultEvents(db, [], [], { nowSec: NOW + 7380 });
      assert.equal(drops().length, 1);
      // вікно 24 год минуло: порівняння з пізнішими знімками, а не з відтоком дворічної давності
      setVault(V1_ADDR, 6_000_000, 3_000_000, 0.5);
      syncVaultEvents(db, [], [], { nowSec: NOW + 2 * DAY });
      assert.equal(drops().length, 1);
      db.close();
    }],
    ['pending не закривається і last_admin_event_ts не рухається назад, коли vault відсутній у відповіді API або поле pendingConfigs відсутнє', ({ syncVaultEvents }) => {
      const db = makeDb();
      const rawV1Pass1 = [{
        address: V1_ADDR,
        state: {
          timelock: 86400,
          pendingConfigs: {
            items: [{
              validAt: NOW + 100,
              functionName: 'SetTimelock',
              txHash: '0xkeep',
              decodedData: { __typename: 'VaultSetTimelockPendingData', timelock: 172800 }
            }]
          }
        },
        adminEvents: {
          items: [{ hash: '0xadm1', timestamp: NOW - 50, type: 'setCurator', data: { curatorAddress: '0xc1' } }]
        }
      }];

      syncVaultEvents(db, rawV1Pass1, [], { nowSec: NOW });

      // Прохід 2: vault взагалі відсутній у rawVaultsV1 та rawVaultsV2 (навіть після validAt)
      const resMissing = syncVaultEvents(db, [], [], { nowSec: NOW + 500 });
      assert.equal(resMissing.updatedPendingCount, 0);
      const st1 = db.prepare("SELECT status FROM vault_events WHERE source = 'pending_config'").get();
      assert.equal(st1.status, 'pending');
      const ws1 = JSON.parse(db.prepare('SELECT state_json FROM vault_watch_state WHERE vault_address = ?').get(V1_ADDR).state_json);
      assert.equal(ws1.last_admin_event_ts, NOW - 50);

      // Прохід 3: vault присутній у rawVaultsV1, але поле pendingConfigs = undefined (не повернуто)
      const resNoField = syncVaultEvents(db, [{ address: V1_ADDR, state: { timelock: 86400 } }], [], { nowSec: NOW + 600 });
      assert.equal(resNoField.updatedPendingCount, 0);
      const st2 = db.prepare("SELECT status FROM vault_events WHERE source = 'pending_config'").get();
      assert.equal(st2.status, 'pending');
      db.close();
    }],
    ['vault_delisted генерується рівно один раз після видалення vault (зберігаючи історію подій) і не генерується при chainIds', ({ syncVaultEvents }) => {
      const db = makeDb();
      const rawV1 = [{
        address: V1_ADDR,
        state: { timelock: 86400, pendingConfigs: { items: [] } },
        adminEvents: {
          items: [{ hash: '0xadm1', timestamp: NOW - 100, type: 'setCurator', data: { curatorAddress: '0xc1' } }]
        }
      }];

      // Прохід 1: початкова фіксація обох vaults у vault_watch_state та події для V1
      syncVaultEvents(db, rawV1, [], { nowSec: NOW });
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vault_watch_state').get().c, 2);

      // Видаляємо V1 із таблиці vaults (як робить syncEngine при is_listed=0 або missed_syncs>=3)
      db.prepare('DELETE FROM vaults WHERE address = ?').run(V1_ADDR);

      // Часткова синхронізація з chainIds НЕ повинна генерувати vault_delisted і видаляти watch_state
      syncVaultEvents(db, [], [], { nowSec: NOW + 60, chainIds: [1] });
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM vault_events WHERE kind = 'vault_delisted'").get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vault_watch_state WHERE vault_address = ?').get(V1_ADDR).c, 1);

      // Повна синхронізація без chainIds генерує vault_delisted (з chain_id та name із state_json) і прибирає watch_state
      syncVaultEvents(db, [], [], { nowSec: NOW + 120 });
      const delistedRows = db.prepare("SELECT * FROM vault_events WHERE kind = 'vault_delisted'").all();
      assert.equal(delistedRows.length, 1);
      assert.equal(delistedRows[0].vault_address, V1_ADDR);
      assert.equal(delistedRows[0].chain_id, 1);
      assert.equal(delistedRows[0].severity, 'warning');
      assert.match(delistedRows[0].title, /Gauntlet USDC Prime/);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vault_watch_state WHERE vault_address = ?').get(V1_ADDR).c, 0);

      // Попередня історія подій видаленого vault збережена у vault_events
      const allV1Events = db.prepare('SELECT kind FROM vault_events WHERE vault_address = ? ORDER BY id').all(V1_ADDR).map(r => r.kind);
      assert.deepEqual(allV1Events, ['curator_changed', 'vault_delisted']);

      // Повторна повна синхронізація НЕ генерує вдруге vault_delisted
      syncVaultEvents(db, [], [], { nowSec: NOW + 180 });
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM vault_events WHERE kind = 'vault_delisted'").get().c, 1);
      db.close();
    }],
  ],
  vaultsWithTruncatedAdminEvents: [
    ['повна сторінка, що не дістає до watermark, потребує догрузки; неповна або та, що дістає, - ні', ({ vaultsWithTruncatedAdminEvents: f }) => {
      const db = makeDb();
      db.prepare('INSERT INTO vault_watch_state (vault_address, state_json, updated_at) VALUES (?, ?, ?)').run(V1_ADDR, JSON.stringify({ last_admin_event_ts: NOW - 1000 }), NOW);
      const items = (from, n) => Array.from({ length: n }, (_, i) => ({ timestamp: from + i }));
      const cut = { address: V1_ADDR, adminEvents: { items: items(NOW - 500, 25) } };
      const reaches = { address: V1_ADDR.toUpperCase(), adminEvents: { items: items(NOW - 1000, 25) } };
      const short = { address: V1_ADDR, adminEvents: { items: items(NOW - 500, 24) } };
      const fresh = { address: V2_ADDR, adminEvents: { items: items(NOW - 500, 25) } };
      const out = f(db, [cut, reaches, short, fresh, { address: V2_ADDR }], 25, NOW);
      assert.deepEqual(out.map(o => [o.rawVault, o.sinceTs]), [[cut, NOW - 1000], [fresh, NOW - 7 * DAY]]);
      db.close();
    }]
  ],

  dropRepeatEvents: [
    ['відкидає повтор останньої збереженої події і повтор усередині пакета, порядок решти зберігає', ({ dropRepeatEvents }) => {
      const db = makeDb();
      const q = (id, list, at) => ({ vault_address: V1_ADDR, chain_id: 1, kind: 'supply_queue_changed', source: 'admin_event', severity: 'info', status: 'final',
        title: 'Supply queue updated', details_json: JSON.stringify({ supplyQueue: list }), dedupe_key: `q${id}`, occurred_at: at, valid_at: null, detected_at: at });
      const stored = q(1, ['0xa', '0xb'], NOW - 600);
      db.prepare(`INSERT INTO vault_events (vault_address, chain_id, kind, source, severity, status, title, details_json, dedupe_key, occurred_at, valid_at, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...Object.values(stored));
      const same = q(2, ['0xA', '0xb'], NOW);
      const changed = q(3, ['0xb', '0xc'], NOW + 60);
      const backAgain = q(4, ['0xc', '0xb'], NOW + 120);
      const otherVault = { ...q(5, ['0xa', '0xb'], NOW), vault_address: V2_ADDR };
      assert.deepEqual(dropRepeatEvents(db, [otherVault, backAgain, changed, same]).map(e => e.dedupe_key), ['q5', 'q3']);
      assert.deepEqual(dropRepeatEvents(db, []), []);
      db.close();
    }]
  ],

  removeRepeatEvents: [
    ['dryRun лише рахує, звичайний запуск видаляє повтори і лишає першу подію', ({ removeRepeatEvents }) => {
      const db = makeDb();
      const ins = db.prepare(`INSERT INTO vault_events (vault_address, chain_id, kind, source, severity, status, title, details_json, dedupe_key, occurred_at, valid_at, detected_at)
        VALUES (?, 1, ?, 'x', ?, ?, ?, ?, ?, ?, NULL, ?)`);
      const add = (key, kind, severity, details, at, status = 'final') => ins.run(V1_ADDR, kind, severity, status, kind, JSON.stringify(details), key, at, at);
      add('a', 'withdraw_queue_changed', 'info', { withdrawQueue: ['0x1'] }, NOW);
      add('b', 'withdraw_queue_changed', 'info', { withdrawQueue: ['0x1'] }, NOW + 100);
      add('c', 'withdraw_queue_changed', 'info', { withdrawQueue: ['0x1'] }, NOW + 200);
      add('d', 'tvl_drop', 'warning', {}, NOW);
      add('e', 'tvl_drop', 'critical', {}, NOW + 100);
      add('f', 'tvl_drop', 'warning', {}, NOW + 200);
      add('g', 'pending_cap_increase', 'warning', {}, NOW, 'pending');
      add('h', 'pending_cap_increase', 'warning', {}, NOW + 1, 'pending');
      const dry = removeRepeatEvents(db, { dryRun: true });
      assert.deepEqual(dry, { total: 3, byKind: { withdraw_queue_changed: 2, tvl_drop: 1 } });
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vault_events').get().c, 8, 'dryRun нічого не видаляє');
      removeRepeatEvents(db);
      assert.deepEqual(db.prepare('SELECT dedupe_key AS k FROM vault_events ORDER BY k').all().map(r => r.k), ['a', 'd', 'e', 'g', 'h']);
      assert.equal(removeRepeatEvents(db).total, 0, 'повторний запуск нічого не знаходить');
      db.close();
    }]
  ],
};
