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

      // Змінюємо стан у БД: TVL падає на 40%, у ринку з'являється bad debt, а обидва pendingConfigs зникають на NOW + 500
      db.prepare('UPDATE vaults SET total_assets_usd = 600000 WHERE address = ?').run(V1_ADDR);
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
      assert.ok(derivedKinds.includes('verdict_worsened'));
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
    ['модель застави none до першого rated-запису, далі ai-research-1; зміна tier створює collateral_tier_changed', ({ syncVaultEvents }) => {
      const db = makeDb();
      const TOKEN = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';
      const setRecord = (tier, at) => db.prepare(`
        INSERT OR REPLACE INTO token_research (chain_id, address, category, risk_tier, confidence, facts_json, sources_json, checks_json, as_of, researched_at, run_id, model, prompt_version, status, raw_json)
        VALUES (1, ?, 'liquid-staking', ?, 'high', '{}', '[]', '[]', '2026-01-01', ?, 'r', 'm', 'p', 'rated', '{}')`).run(TOKEN, tier, at);
      const state = () => JSON.parse(db.prepare('SELECT state_json FROM vault_watch_state WHERE vault_address = ?').get(V1_ADDR).state_json);
      const kinds = () => db.prepare("SELECT kind, severity FROM vault_events WHERE kind = 'collateral_tier_changed'").all().map(r => [r.kind, r.severity]);

      syncVaultEvents(db, [], [], { nowSec: NOW });
      assert.equal(state().collateral_model, 'none'); assert.deepEqual(state().collateral_tiers, { [`1:${TOKEN}`]: null });

      setRecord(2, NOW - DAY);
      syncVaultEvents(db, [], [], { nowSec: NOW + 3600 });
      assert.equal(state().collateral_model, 'ai-research-1'); assert.deepEqual(state().collateral_tiers, { [`1:${TOKEN}`]: 2 });
      assert.deepEqual(kinds(), []);

      setRecord(4, NOW);
      syncVaultEvents(db, [], [], { nowSec: NOW + 7200 });
      assert.deepEqual(kinds(), [['collateral_tier_changed', 'warning']]);
      assert.equal(state().collateral_tiers[`1:${TOKEN}`], 4);

      // a record older than 60 days counts as unrated: no event for the drop to null
      syncVaultEvents(db, [], [], { nowSec: NOW + 61 * DAY });
      assert.equal(state().collateral_tiers[`1:${TOKEN}`], null); assert.equal(kinds().length, 1);
      db.close();
    }],
  ],
};
