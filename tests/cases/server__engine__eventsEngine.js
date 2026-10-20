import assert from 'node:assert/strict';

const VAULT_ADDR = '0x1111111111111111111111111111111111111111';
const NOW = 1_750_000_000;
const DAY = 86400;
const M = { collateral_model: 'morpho-tags-2' };

const baseCtx = (overrides = {}) => ({
  address: VAULT_ADDR,
  chainId: 1,
  name: 'Test Vault',
  assetSymbol: 'USDC',
  assetDecimals: 6,
  assetPriceUsd: 1,
  fee: 0.05,
  timelock: 86400,
  guardian: '0x2222222222222222222222222222222222222222',
  caps: { '0xm1': 1000 },
  allocations: [],
  ...overrides
});

export default {
  EVENT_KINDS: [
    ['містить усі 33 дозволені типи подій (admin, pending, derived) і заморожений', ({ EVENT_KINDS }) => {
      assert.ok(Object.isFrozen(EVENT_KINDS));
      assert.equal(EVENT_KINDS.length, 33);
      for (const k of [
        'fee_changed', 'timelock_changed', 'cap_changed', 'guardian_changed', 'curator_changed',
        'owner_changed', 'allocator_changed', 'skim_recipient_changed', 'supply_queue_changed',
        'withdraw_queue_changed', 'reallocation', 'market_removal_revoked', 'cap_revoked', 'skim',
        'pending_cap_increase', 'pending_market_removal', 'pending_timelock_change', 'pending_guardian_change',
        'pending_fee_change', 'pending_adapter_change', 'pending_allocator_change', 'pending_gate_change',
        'pending_force_deallocate_penalty', 'pending_abdicate',
        'verdict_worsened', 'verdict_improved', 'mqi_dropped', 'bad_debt_appeared',
        'flagged_collateral_added', 'tvl_drop', 'exit_liquidity_low', 'vault_delisted',
        'collateral_class_share_crossed'
      ]) {
        assert.ok(EVENT_KINDS.includes(k), `missing kind: ${k}`);
      }
    }],
  ],
  SEVERITY_RANK: [
    ['впорядковує рівні серйозності як info < warning < critical і заморожений', ({ SEVERITY_RANK }) => {
      assert.ok(Object.isFrozen(SEVERITY_RANK));
      assert.ok(SEVERITY_RANK.info < SEVERITY_RANK.warning);
      assert.ok(SEVERITY_RANK.warning < SEVERITY_RANK.critical);
    }],
  ],
  buildDedupeKey: [
    ['будує детермінований ключ для admin_event та нормалізує регістр адрес і хешів', ({ buildDedupeKey }) => {
      const k1 = buildDedupeKey('admin_event', { vaultAddress: '0xABC', hash: '0xDEF', type: 'setFee' });
      assert.equal(k1, 'admin:0xabc:0xdef:setFee');
      const k2 = buildDedupeKey('admin_event', { vaultAddress: '0xABC', hash: '0xDEF', type: 'setCap', discriminator: '0xm1' });
      assert.equal(k2, 'admin:0xabc:0xdef:setCap:0xm1');
    }],
    ['будує детермінований ключ для pending_config і derived та кидає помилку на невідомий source', ({ buildDedupeKey }) => {
      const kp = buildDedupeKey('pending_config', {
        vaultAddress: '0xAAA',
        functionName: 'SetCap',
        txHash: '0x123',
        validAt: 1750090000,
        targetKey: '0xm1:5000'
      });
      assert.equal(kp, 'pending:0xaaa:SetCap:0x123:1750090000:0xm1:5000');
      const kd = buildDedupeKey('derived', { vaultAddress: '0xAAA', kind: 'tvl_drop', bucket: 'warning:20:486111' });
      assert.equal(kd, 'derived:0xaaa:tvl_drop:warning:20:486111');
      assert.throws(() => buildDedupeKey('unknown_source', {}), /Unsupported event source/);
    }],
  ],
  diffAdminEvents: [
    ['на першому проході (prevState = null) ігнорує події старіші за 7 днів і повертає ті, що молодші за 7 днів', ({ diffAdminEvents }) => {
      const raw = [
        { hash: '0xold', timestamp: NOW - 8 * DAY, type: 'setCurator', data: { curatorAddress: '0xc1' } },
        { hash: '0xnew', timestamp: NOW - 2 * DAY, type: 'setCurator', data: { curatorAddress: '0xc2' } }
      ];
      const { events, lastAdminEventTs } = diffAdminEvents(baseCtx(), raw, null, NOW);
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, 'curator_changed');
      assert.equal(events[0].dedupe_key, `admin:${VAULT_ADDR}:0xnew:setCurator`);
      assert.equal(lastAdminEventTs, NOW - 2 * DAY);
    }],
    ['на повторному проході з тим самим last_admin_event_ts не дублює події', ({ diffAdminEvents }) => {
      const raw = [
        { hash: '0xnew', timestamp: NOW - 2 * DAY, type: 'setCurator', data: { curatorAddress: '0xc2' } }
      ];
      const prev = { last_admin_event_ts: NOW - 2 * DAY };
      const { events, lastAdminEventTs } = diffAdminEvents(baseCtx(), raw, prev, NOW);
      assert.equal(events.length, 0);
      assert.equal(lastAdminEventTs, NOW - 2 * DAY);
    }],
    ['агрегує кілька reallocateSupply і reallocateWithdraw одного tx hash в одну подію reallocation', ({ diffAdminEvents }) => {
      const raw = [
        {
          hash: '0xrealloc1',
          timestamp: NOW - 100,
          type: 'reallocateWithdraw',
          data: {
            withdrawnAssets: '500000000',
            market: { marketId: '0xm1', collateralAsset: { symbol: 'wstETH' }, loanAsset: { symbol: 'USDC', decimals: 6 } }
          }
        },
        {
          hash: '0xrealloc1',
          timestamp: NOW - 100,
          type: 'reallocateSupply',
          data: {
            suppliedAssets: '500000000',
            market: { marketId: '0xm2', collateralAsset: { symbol: 'WBTC' }, loanAsset: { symbol: 'USDC', decimals: 6 } }
          }
        }
      ];
      const { events } = diffAdminEvents(baseCtx(), raw, { last_admin_event_ts: NOW - 500 }, NOW);
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, 'reallocation');
      assert.equal(events[0].severity, 'info');
      assert.equal(events[0].dedupe_key, `admin:${VAULT_ADDR}:0xrealloc1:reallocation`);
      const details = JSON.parse(events[0].details_json);
      assert.equal(details.marketsCount, 2);
      assert.equal(details.totalSuppliedAssets, 500);
      assert.equal(details.totalWithdrawnAssets, 500);
      assert.equal(details.volumeUsd, 500);
    }],
    ['класифікує setFee (WAD і частку): warning при прирості <= 5 в.п. і critical при прирості > 5 в.п.', ({ diffAdminEvents }) => {
      const rawWarn = [{ hash: '0xf1', timestamp: NOW - 50, type: 'setFee', data: { fee: '100000000000000000' } }]; // 10% (from 5% = +5pp)
      const r1 = diffAdminEvents(baseCtx(), rawWarn, { fee: 0.05, last_admin_event_ts: NOW - 100 }, NOW);
      assert.equal(r1.events[0].kind, 'fee_changed');
      assert.equal(r1.events[0].severity, 'warning');

      const rawCrit = [{ hash: '0xf2', timestamp: NOW - 40, type: 'setFee', data: { fee: '120000000000000000' } }]; // 12% (from 5% = +7pp)
      const r2 = diffAdminEvents(baseCtx(), rawCrit, { fee: 0.05, last_admin_event_ts: NOW - 100 }, NOW);
      assert.equal(r2.events[0].severity, 'critical');
    }],
    ['класифікує setTimelock (critical при зменшенні, warning при збільшенні) та setCap (warning при >2x, інакше info)', ({ diffAdminEvents }) => {
      const raw = [
        { hash: '0xt1', timestamp: NOW - 90, type: 'setTimelock', data: { timelock: 3600 } },
        { hash: '0xt2', timestamp: NOW - 80, type: 'setTimelock', data: { timelock: 172800 } },
        {
          hash: '0xc1',
          timestamp: NOW - 70,
          type: 'setCap',
          data: { cap: '1500000000', market: { marketId: '0xm1', collateralAsset: { symbol: 'WETH' }, loanAsset: { symbol: 'USDC', decimals: 6 } } }
        },
        {
          hash: '0xc2',
          timestamp: NOW - 60,
          type: 'setCap',
          data: { cap: '3500000000', market: { marketId: '0xm1', collateralAsset: { symbol: 'WETH' }, loanAsset: { symbol: 'USDC', decimals: 6 } } }
        }
      ];
      const prev = { timelock: 86400, caps: { '0xm1': 1000 }, last_admin_event_ts: NOW - 200 };
      const { events } = diffAdminEvents(baseCtx(), raw, prev, NOW);
      assert.equal(events.length, 4);
      assert.equal(events[0].kind, 'timelock_changed');
      assert.equal(events[0].severity, 'critical');
      assert.equal(events[1].kind, 'timelock_changed');
      assert.equal(events[1].severity, 'warning');
      assert.equal(events[2].kind, 'cap_changed');
      assert.equal(events[2].severity, 'info'); // 1000 -> 1500 (1.5x <= 2x)
      assert.equal(events[3].kind, 'cap_changed');
      assert.equal(events[3].severity, 'warning'); // 1500 -> 3500 (> 2x)
    }],
    ['мапить усі інші типи адмін-подій (guardian, owner, allocator, skimRecipient, queues, revokes, skim)', ({ diffAdminEvents }) => {
      const raw = [
        { hash: '0x1', timestamp: NOW - 10, type: 'setGuardian', data: { guardian: '0xg' } },
        { hash: '0x2', timestamp: NOW - 9, type: 'ownershipTransferred', data: { owner: '0xo' } },
        { hash: '0x3', timestamp: NOW - 8, type: 'setIsAllocator', data: { allocator: '0xa', isAllocator: true } },
        { hash: '0x4', timestamp: NOW - 7, type: 'setSkimRecipient', data: { skimRecipient: '0xs' } },
        { hash: '0x5', timestamp: NOW - 6, type: 'setSupplyQueue', data: { supplyQueue: [{ marketId: '0xm1' }] } },
        { hash: '0x6', timestamp: NOW - 5, type: 'setWithdrawQueue', data: { withdrawQueue: [{ marketId: '0xm1' }] } },
        { hash: '0x7', timestamp: NOW - 4, type: 'revokePendingMarketRemoval', data: { market: { marketId: '0xm1' } } },
        { hash: '0x8', timestamp: NOW - 3, type: 'revokePendingCap', data: { market: { marketId: '0xm1' } } },
        { hash: '0x9', timestamp: NOW - 2, type: 'skim', data: { amount: '2000000', asset: { symbol: 'USDC', decimals: 6 } } }
      ];
      const { events } = diffAdminEvents(baseCtx(), raw, { last_admin_event_ts: NOW - 50 }, NOW);
      assert.deepEqual(
        events.map(e => [e.kind, e.severity]),
        [
          ['guardian_changed', 'warning'],
          ['owner_changed', 'critical'],
          ['allocator_changed', 'warning'],
          ['skim_recipient_changed', 'critical'],
          ['supply_queue_changed', 'info'],
          ['withdraw_queue_changed', 'info'],
          ['market_removal_revoked', 'info'],
          ['cap_revoked', 'info'],
          ['skim', 'critical']
        ]
      );
    }],
  ],
  diffPendingConfigs: [
    ['мапить pendingConfigs для V1 і V2 та підвищує серйозність до critical при зниженні timelock, видаленні guardian або рості cap > 2x', ({ diffPendingConfigs }) => {
      const pending = [
        {
          validAt: NOW + 3600,
          functionName: 'SetCap',
          txHash: '0xp1',
          decodedData: {
            __typename: 'VaultSetCapPendingData',
            supplyCap: '3000000000', // 3000 USDC vs current 1000 USDC (>2x)
            market: { marketId: '0xm1', collateralAsset: { symbol: 'WETH' }, loanAsset: { symbol: 'USDC', decimals: 6 } }
          }
        },
        {
          validAt: NOW + 3600,
          functionName: 'SetGuardian',
          txHash: '0xp2',
          decodedData: {
            __typename: 'VaultSetGuardianPendingData',
            guardian: { address: '0x0000000000000000000000000000000000000000' }
          }
        },
        {
          validAt: NOW + 7200,
          functionName: 'DecreaseTimelock',
          txHash: '0xp3',
          decodedData: {
            __typename: 'VaultV2TimelockPendingData',
            timelock: 3600,
            selector: '0x70897b23',
            functionName: 'setPerformanceFee'
          }
        },
        {
          validAt: NOW + 7200,
          functionName: 'AddAdapter',
          txHash: '0xp4',
          decodedData: {
            __typename: 'VaultV2AdapterPendingData',
            adapterAddress: '0x3333333333333333333333333333333333333333'
          }
        }
      ];
      const ctx = baseCtx({ timelocks: [{ selector: '0x70897b23', functionName: 'setPerformanceFee', duration: 86400 }] });
      const { events, statusUpdates } = diffPendingConfigs(ctx, pending, [], NOW);
      assert.equal(statusUpdates.length, 0);
      assert.deepEqual(
        events.map(e => [e.kind, e.severity, e.status]),
        [
          ['pending_cap_increase', 'critical', 'pending'],
          ['pending_guardian_change', 'critical', 'pending'],
          ['pending_timelock_change', 'critical', 'pending'],
          ['pending_adapter_change', 'warning', 'pending']
        ]
      );
    }],
    ['переводить зниклі pending-події в applied (коли now >= valid_at) або revoked (коли now < valid_at)', ({ diffPendingConfigs }) => {
      const existing = [
        { id: 10, dedupe_key: 'pending:0x1:SetCap:0xa:1749990000:0xm1:200', status: 'pending', valid_at: NOW - 10 },
        { id: 11, dedupe_key: 'pending:0x1:SetCap:0xb:1750090000:0xm1:300', status: 'pending', valid_at: NOW + 5000 }
      ];
      const { events, statusUpdates } = diffPendingConfigs(baseCtx(), [], existing, NOW);
      assert.equal(events.length, 0);
      assert.deepEqual(statusUpdates, [
        { id: 10, dedupe_key: existing[0].dedupe_key, status: 'applied' },
        { id: 11, dedupe_key: existing[1].dedupe_key, status: 'revoked' }
      ]);
    }],
  ],
  buildWatchState: [
    ['будує знімок стану vault з chain_id, name, вердиктом, ліквідністю, bad debt і класами застави', ({ buildWatchState }) => {
      const vault = { address: VAULT_ADDR, chain_id: 8453, name: 'Base USDC Vault', total_assets_usd: 1_000_000, liquidity_usd: 400_000, is_listed: 1, missed_syncs: 0, fee: 0.05 };
      const allocs = [
        {
          market_unique_key: '0xm1',
          chain_id: 8453,
          supply_assets_usd: 500_000,
          supply_cap_human: 2_000_000,
          total_supply_assets_usd: 5_000_000,
          bad_debt_usd: 5000,
          realized_bad_debt_usd: 0,
          is_listed: 1,
          oracle_address: '0x1234567890123456789012345678901234567890',
          lltv_percent: 86,
          collateral_asset_symbol: 'wstETH',
          loan_asset_symbol: 'USDC',
          warnings_json: '[]'
        }
      ];
      const verdict = {
        redFlags: [{ level: 'CRITICAL', title: 'Compromised Market Exposure' }],
        mqi: { mqiPercent: 50, unpriced: false, verifiedAssetsUsd: 1_000_000 },
        liquidity: { exitUnknown: false, instantExitCapacityPercent: 40 },
        collateral: { tier: 'CLASSIFIED' }
      };
      const st = buildWatchState(vault, allocs, verdict, { timelock: 86400, lastAdminEventTs: NOW, collateralModel: 'morpho-tags-2' });
      assert.equal(st.chain_id, 8453);
      assert.equal(st.name, 'Base USDC Vault');
      assert.equal(st.verdict_level, 'red');
      assert.equal(st.mqi_percent, 50);
      assert.equal(st.instant_exit_percent, 40);
      assert.equal(st.is_listed, 1);
      assert.ok(st.bad_debt_markets['0xm1']);
      assert.equal(st.last_admin_event_ts, NOW);
      assert.equal(st.collateral_model, 'morpho-tags-2'); assert.equal('collateral_level' in st, false);
      assert.equal(buildWatchState(vault, allocs, verdict).collateral_model, 'none');
    }],
    ['flagged_markets: special-тег позначається, unclassified і base ні', ({ buildWatchState }) => {
      const vault = { address: VAULT_ADDR, chain_id: 1, total_assets_usd: 1_000_000, liquidity_usd: 1e9 };
      const mk = (key, tags) => ({ market_unique_key: key, supply_assets_usd: 500_000, bad_debt_usd: 0, realized_bad_debt_usd: 0, is_listed: 1,
        oracle_address: '0x1', lltv_percent: 86, collateral_asset_symbol: key, loan_asset_symbol: 'USDC', warnings_json: '[]',
        collateral_asset_address: `0x${key}`, collateral_tags_json: tags });
      const st = buildWatchState(vault, [mk('rwa', '["stablecoin","rwa"]'), mk('none', null), mk('eth', '["eth"]')], null);
      assert.deepEqual(Object.keys(st.flagged_markets), ['rwa']);
      assert.equal(st.flagged_markets.rwa.collateralState, 'special'); assert.deepEqual(st.flagged_markets.rwa.collateralTags, ['stablecoin', 'rwa']);
    }],
  ],
  diffDerivedState: [
    ['повертає порожній масив на першому спостереженні (prevState = null)', ({ diffDerivedState }) => {
      const next = { verdict_level: 'red', mqi_percent: 40, total_assets_usd: 1000 };
      assert.deepEqual(diffDerivedState(null, next, baseCtx(), NOW), []);
    }],
    ['виявляє verdict_worsened (warning для yellow, critical для red) і verdict_improved (info), ігноруючи unknown/null', ({ diffDerivedState }) => {
      const e1 = diffDerivedState({ ...M, verdict_level: 'green' }, { ...M, verdict_level: 'yellow' }, baseCtx(), NOW);
      assert.equal(e1.length, 1);
      assert.equal(e1[0].kind, 'verdict_worsened');
      assert.equal(e1[0].severity, 'warning');

      const e2 = diffDerivedState({ ...M, verdict_level: 'yellow' }, { ...M, verdict_level: 'red' }, baseCtx(), NOW);
      assert.equal(e2.length, 1);
      assert.equal(e2[0].kind, 'verdict_worsened');
      assert.equal(e2[0].severity, 'critical');

      const e3 = diffDerivedState({ ...M, verdict_level: 'red' }, { ...M, verdict_level: 'green' }, baseCtx(), NOW);
      assert.equal(e3.length, 1);
      assert.equal(e3[0].kind, 'verdict_improved');
      assert.equal(e3[0].severity, 'info');

      assert.deepEqual(diffDerivedState({ ...M, verdict_level: null }, { ...M, verdict_level: 'red' }, baseCtx(), NOW), []);
      // a changed or missing previous model keeps verdict events quiet
      assert.deepEqual(diffDerivedState({ collateral_model: 'none', verdict_level: 'green' }, { ...M, verdict_level: 'red' }, baseCtx(), NOW), []);
      assert.deepEqual(diffDerivedState({ verdict_level: 'green' }, { ...M, verdict_level: 'red' }, baseCtx(), NOW), []);
    }],
    ['виявляє mqi_dropped при падінні >= 10 п., tvl_drop (-15% warning, -30% critical) та exit_liquidity_low (<20%)', ({ diffDerivedState }) => {
      const prev = {
        mqi_percent: 95,
        total_assets_usd: 1_000_000,
        instant_exit_percent: 25,
        unpriced: false,
        exit_unknown: false
      };
      const next = {
        mqi_percent: 82, // -13 pts
        total_assets_usd: 680_000, // -32%
        instant_exit_percent: 14, // < 20%
        unpriced: false,
        exit_unknown: false
      };
      const evs = diffDerivedState(prev, next, baseCtx(), NOW);
      assert.deepEqual(
        evs.map(e => [e.kind, e.severity]),
        [
          ['mqi_dropped', 'warning'],
          ['tvl_drop', 'critical'],
          ['exit_liquidity_low', 'warning']
        ]
      );
    }],
    ['виявляє bad_debt_appeared, flagged_collateral_added і vault_delisted; collateral_class_share_crossed більше не створюється', ({ diffDerivedState }) => {
      const prev = { ...M, bad_debt_markets: {}, unverified_bad_debt_markets: [], flagged_markets: {}, is_listed: 1, collateral_tier: 'CLASSIFIED' };
      const next = {
        ...M,
        bad_debt_markets: { '0xm1': { label: 'wstETH/USDC', badDebtUsd: 12000, supplyUsd: 200000 } },
        unverified_bad_debt_markets: [],
        flagged_markets: { '0xm2': { label: 'sUSDe/USDC', collateralSymbol: 'sUSDe', collateralState: 'special', collateralTags: ['rwa'], reasons: [], supplyUsd: 300000 } },
        is_listed: 0,
        collateral_tier: 'CLASSIFIED'
      };
      const evs = diffDerivedState(prev, next, baseCtx(), NOW);
      assert.deepEqual(evs.map(e => [e.kind, e.severity]), [['bad_debt_appeared', 'critical'], ['flagged_collateral_added', 'warning'], ['vault_delisted', 'warning']]);
      assert.deepEqual(JSON.parse(evs[1].details_json).collateralTags, ['rwa']);
    }],
    ['під час зміни моделі застави flagged_collateral_added мовчить, bad_debt_appeared ні', ({ diffDerivedState }) => {
      const flagged = { '0xm2': { label: 'x', collateralState: 'special', collateralTags: ['rwa'], reasons: [], supplyUsd: 1 } };
      const evs = diffDerivedState({ bad_debt_markets: {}, flagged_markets: {} }, { ...M, bad_debt_markets: { '0xm1': { label: 'a', badDebtUsd: 1, supplyUsd: 1 } }, flagged_markets: flagged }, baseCtx(), NOW);
      assert.deepEqual(evs.map(e => e.kind), ['bad_debt_appeared']);
    }],
  ],
};
