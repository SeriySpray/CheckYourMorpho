import assert from 'node:assert/strict';

const VAULT_ADDR = '0x1111111111111111111111111111111111111111';
const NOW = 1_750_000_000;
const DAY = 86400;
const M = {};

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
    ['reallocation: LLTV ринку у відсотках для кожного руху, реалокація на $0.00 не стає подією, а 50 центів лишаються', ({ diffAdminEvents }) => {
      const leg = (hash, type, amount, marketId, lltv) => ({
        hash, timestamp: NOW - 100, type,
        data: { [type === 'reallocateSupply' ? 'suppliedAssets' : 'withdrawnAssets']: amount, market: { marketId, lltv, collateralAsset: { symbol: 'cbBTC' }, loanAsset: { symbol: 'USDC', decimals: 6 } } }
      });
      const raw = [
        leg('0xbig', 'reallocateWithdraw', '2000000000', '0xa', '860000000000000000'),
        leg('0xbig', 'reallocateSupply', '2000000000', '0xb', '915000000000000000'),
        leg('0xdust', 'reallocateWithdraw', '4854', '0xa', '860000000000000000'),
        leg('0xdust', 'reallocateSupply', '4854', '0xb', '915000000000000000'),
        leg('0xcents', 'reallocateWithdraw', '500000', '0xa', '860000000000000000'),
        leg('0xcents', 'reallocateSupply', '500000', '0xb', '915000000000000000')
      ];
      const { events } = diffAdminEvents(baseCtx(), raw, { last_admin_event_ts: NOW - 500 }, NOW);
      assert.deepEqual(events.map(e => JSON.parse(e.details_json).volumeUsd).sort((a, b) => a - b), [0.5, 2000]);
      const d = JSON.parse(events.find(e => JSON.parse(e.details_json).volumeUsd === 2000).details_json);
      assert.deepEqual(d.movements.map(m => [m.marketLabel, m.lltvPercent]), [['cbBTC/USDC', 86], ['cbBTC/USDC', 91.5]]);
    }],
    ['submitCap лише ставить збільшення cap у чергу: final-події немає, setCap після acceptCap - є', ({ diffAdminEvents }) => {
      const market = { marketId: '0xm1', loanAsset: { symbol: 'USDC', decimals: 6 }, collateralAsset: { symbol: 'PT-x' } };
      const raw = [
        { hash: '0xs', timestamp: NOW - 200, type: 'submitCap', data: { cap: '4000000000000', market } },
        { hash: '0xa', timestamp: NOW - 100, type: 'setCap', data: { cap: '4000000000000', market } }
      ];
      const { events } = diffAdminEvents(baseCtx(), raw, { last_admin_event_ts: NOW - 500 }, NOW);
      assert.deepEqual(events.map(e => [e.kind, JSON.parse(e.details_json).rawType]), [['cap_changed', 'setCap']]);
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
          ['skim_recipient_changed', 'info'],
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
    ['occurred_at - це час подачі (valid_at мінус timelock), а не час першої синхронізації', ({ diffPendingConfigs }) => {
      const v1 = { functionName: 'SetGuardian', validAt: NOW - 30 * DAY, txHash: '0xg', decodedData: { __typename: 'VaultSetGuardianPendingData', guardian: { address: '0x3333333333333333333333333333333333333333' } } };
      const v2 = { functionName: 'IncreaseAbsoluteCap', validAt: NOW + DAY, txHash: '0xc', decodedData: { cap: '1000000', config: { id: '0xcfg', type: 'MarketV1', data: {} } } };
      const ctx = baseCtx({ timelock: 3 * DAY, timelocks: [{ functionName: 'increaseAbsoluteCap', selector: '0xf6f98fd5', duration: 7 * DAY }] });
      const { events } = diffPendingConfigs(ctx, [v1, v2], [], NOW);
      assert.equal(events[0].occurred_at, NOW - 33 * DAY);
      assert.equal(events[1].occurred_at, NOW - 6 * DAY);
      const unknown = diffPendingConfigs(baseCtx({ timelock: null }), [v1], [], NOW).events[0];
      assert.equal(unknown.occurred_at, NOW);
    }],
    ['relative cap понад 100% як старе значення - це не реальне значення: oldCap = null', ({ diffPendingConfigs }) => {
      const item = { functionName: 'IncreaseRelativeCap', validAt: NOW + DAY, txHash: '0xr', decodedData: { cap: '1000000000000000000', config: { id: '0xcfg', type: 'MarketV1', data: {} } } };
      const { events } = diffPendingConfigs(baseCtx({ capsById: { '0xcfg': { absolute: 50000, relative: 50000 } } }), [item], [], NOW);
      const d = JSON.parse(events[0].details_json);
      assert.equal(d.oldCap, null);
      assert.equal(d.newCap, 1);
    }],
    ['cap V2: частка TVL, що додається, рахується від старого cap за config.id (relative - різниця часток, absolute - від активів vault-а)', ({ diffPendingConfigs }) => {
      const ctx = baseCtx({ assetsHuman: 1_000_000, capsById: { c1: { absolute: 100_000, relative: 0.1 }, c2: { absolute: 0, relative: 0 } } });
      const item = (fn, id, cap) => ({ functionName: fn, validAt: NOW + 3600, txHash: '0xh' + id, decodedData: { __typename: 'VaultV2IncreaseCapPendingData', cap, config: { id, type: 'Collateral', data: { collateralToken: { symbol: 'cbBTC' } } } } });
      const { events } = diffPendingConfigs(ctx, [
        item('IncreaseRelativeCap', 'c1', '250000000000000000'),
        item('IncreaseAbsoluteCap', 'c1', String(300_000 * 1e6)),
        item('IncreaseAbsoluteCap', 'c2', String(50_000 * 1e6)),
        item('IncreaseAbsoluteCap', 'cX', String(50_000 * 1e6))
      ], [], NOW);
      assert.deepEqual(events.slice(0, 2).map(e => e.title), ['Pending relative cap increase for cbBTC collateral', 'Pending absolute cap increase for cbBTC collateral']);
      const d = events.map(e => JSON.parse(e.details_json));
      assert.equal(d[0].capKind, 'relative'); assert.ok(Math.abs(d[0].tvlShareAdded - 0.15) < 1e-9); assert.equal(d[0].capWasZero, false);
      assert.equal(d[1].capKind, 'absolute'); assert.ok(Math.abs(d[1].tvlShareAdded - 0.2) < 1e-9);
      assert.equal(d[2].capWasZero, true); assert.ok(Math.abs(d[2].tvlShareAdded - 0.05) < 1e-9);
      assert.equal(d[3].oldCap, null); assert.equal(d[3].capWasZero, true);
    }],
    ['cap V1 (SetCap): старе значення з caps vault-а, частка від активів, новий ринок = cap був 0', ({ diffPendingConfigs }) => {
      const ctx = baseCtx({ assetsHuman: 1_000_000, caps: { '0xm1': 100_000 } });
      const item = (m, cap) => ({ functionName: 'SetCap', validAt: NOW + 3600, txHash: '0xh' + m, decodedData: { __typename: 'VaultSetCapPendingData', supplyCap: String(cap * 1e6), market: { marketId: m, loanAsset: { symbol: 'USDC', decimals: 6 }, collateralAsset: { symbol: 'wstETH' } } } });
      const { events } = diffPendingConfigs(ctx, [item('0xm1', 400_000), item('0xnew', 200_000)], [], NOW);
      const d = events.map(e => JSON.parse(e.details_json));
      assert.ok(Math.abs(d[0].tvlShareAdded - 0.3) < 1e-9); assert.equal(d[0].capWasZero, false);
      assert.equal(d[1].capWasZero, true); assert.ok(Math.abs(d[1].tvlShareAdded - 0.2) < 1e-9);
    }],
    ['cap V1: caps vault-а зберігаються за market_unique_key (chain:marketId), тож старе значення знаходиться за ним, а не лишається null', ({ diffPendingConfigs }) => {
      const ctx = baseCtx({ chainId: 1, assetsHuman: 1_000_000, caps: { '1:0xm1': 2_500_000 } });
      const item = { functionName: 'SetCap', validAt: NOW + 3600, txHash: '0xh', decodedData: { __typename: 'VaultSetCapPendingData', supplyCap: String(4_000_000 * 1e6), market: { marketId: '0xM1', loanAsset: { symbol: 'USDC', decimals: 6 }, collateralAsset: { symbol: 'wstETH' } } } };
      const d = JSON.parse(diffPendingConfigs(ctx, [item], [], NOW).events[0].details_json);
      assert.equal(d.oldCap, 2_500_000); assert.equal(d.capWasZero, false);
    }],
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
        { id: 10, dedupe_key: 'pending:0x1:SetCap:0xa:1749990000:0xm1:200', status: 'pending', valid_at: NOW - 10, title: 'Pending supply cap increase for WETH/USDC' },
        { id: 11, dedupe_key: 'pending:0x1:SetCap:0xb:1750090000:0xm1:300', status: 'pending', valid_at: NOW + 5000, title: 'Pending guardian change' }
      ];
      const { events, statusUpdates } = diffPendingConfigs(baseCtx(), [], existing, NOW);
      assert.equal(events.length, 0);
      assert.deepEqual(statusUpdates, [
        { id: 10, dedupe_key: existing[0].dedupe_key, status: 'applied', title: 'Supply cap increase for WETH/USDC executed' },
        { id: 11, dedupe_key: existing[1].dedupe_key, status: 'revoked', title: 'Guardian change revoked' }
      ]);
    }],
  ],
  settledTitle: [
    ['прибирає "Pending" і додає executed або revoked; інші заголовки й статуси не чіпає', ({ settledTitle }) => {
      assert.equal(settledTitle('Pending absolute cap increase for mGLO collateral', 'applied'), 'Absolute cap increase for mGLO collateral executed');
      assert.equal(settledTitle('Pending guardian change', 'revoked'), 'Guardian change revoked');
      assert.equal(settledTitle('Pending guardian change', 'pending'), 'Pending guardian change');
      assert.equal(settledTitle('Supply cap updated for X', 'applied'), 'Supply cap updated for X');
      assert.equal(settledTitle(null, 'applied'), '');
    }]
  ],
  flagTier: [
    ['CRITICAL і HIGH - red, MEDIUM - yellow, невідоме - null', ({ flagTier }) => {
      assert.equal(flagTier({ level: 'CRITICAL', title: 'Compromised Market Exposure' }), 'red');
      assert.equal(flagTier({ level: 'HIGH', title: 'Restricted Exit Liquidity' }), 'red');
      assert.equal(flagTier({ level: 'MEDIUM', title: 'Unverified Markets' }), 'yellow');
      assert.equal(flagTier({ level: 'LOW', title: 'x' }), null);
      assert.equal(flagTier(null), null);
    }],
  ],
  verdictReasons: [
    ['red бере CRITICAL і HIGH, yellow - MEDIUM; інші рівні й порожні прапорці дають null', ({ verdictReasons }) => {
      const verdict = { redFlags: [{ level: 'HIGH', title: 'A' }, { level: 'CRITICAL', title: 'B' }, { level: 'MEDIUM', title: 'C' }] };
      assert.equal(verdictReasons(verdict, 'red'), 'A; B');
      assert.equal(verdictReasons(verdict, 'yellow'), 'C');
      assert.equal(verdictReasons(verdict, 'green'), null);
      assert.equal(verdictReasons({ redFlags: [] }, 'red'), null);
      assert.equal(verdictReasons(null, 'red'), null);
    }],
  ],
  buildWatchState: [
    ['flagged_markets: лише брудний ринок з суттєвою часткою позначається, чистий і дрібний ні', ({ buildWatchState }) => {
      const vault = { address: VAULT_ADDR, chain_id: 1, total_assets_usd: 1_000_000, liquidity_usd: 1e9 };
      const mk = (key, over = {}) => ({ market_unique_key: key, supply_assets_usd: 100_000, bad_debt_usd: 0, realized_bad_debt_usd: 0, is_listed: 1,
        oracle_address: '0x1', lltv_percent: 86, collateral_asset_symbol: key, loan_asset_symbol: 'USDC', warnings_json: '[]', chain_id: 1,
        collateral_asset_address: `0x${key}`, ...over });
      const st = buildWatchState(vault, [mk('clean'), mk('unlisted', { is_listed: 0 }), mk('tiny', { is_listed: 0, supply_assets_usd: 10 })], null);
      assert.deepEqual(Object.keys(st.flagged_markets), ['unlisted']);
      assert.equal(st.flagged_markets.unlisted.collateralSymbol, 'unlisted'); assert.ok(st.flagged_markets.unlisted.reasons.length > 0);
    }],
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
      const st = buildWatchState(vault, allocs, verdict, { timelock: 86400, lastAdminEventTs: NOW });
      assert.equal(st.chain_id, 8453);
      assert.equal(st.name, 'Base USDC Vault');
      assert.equal(st.verdict_level, 'red');
      assert.equal(st.mqi_percent, 50);
      assert.equal(st.instant_exit_percent, 40);
      assert.equal(st.is_listed, 1);
      assert.ok(st.bad_debt_markets['0xm1']);
      assert.equal(st.last_admin_event_ts, NOW);
      assert.equal('collateral_level' in st, false); assert.equal('collateral_model' in st, false); assert.equal('collateral_tiers' in st, false);
    }],
    ['MQI null, але є перевірена частина з красним прапорцем -> рівень red, а не null', ({ buildWatchState }) => {
      const vault = { address: VAULT_ADDR, chain_id: 1, name: 'V', total_assets_usd: 10e6, is_listed: 1 };
      const verdict = {
        redFlags: [{ level: 'CRITICAL', title: 'Compromised Market Exposure' }],
        mqi: { mqiPercent: null, unpriced: false, cleanAssetsUsd: 3e6, compromisedAssetsUsd: 1e6, unverifiedAssetsUsd: 6e6 },
        liquidity: { exitUnknown: true }
      };
      assert.equal(buildWatchState(vault, [], verdict, {}).verdict_level, 'red');
    }],
    ['MQI null і нічого не перевірено (чисте + брудне = 0) -> рівень null, навіть з прапорцем Unresolved', ({ buildWatchState }) => {
      const vault = { address: VAULT_ADDR, chain_id: 1, name: 'V', total_assets_usd: 10e6, is_listed: 1 };
      const verdict = {
        redFlags: [{ level: 'HIGH', title: 'Unresolved Exposure' }],
        mqi: { mqiPercent: null, unpriced: false, cleanAssetsUsd: 0, compromisedAssetsUsd: 0, unverifiedAssetsUsd: 10e6 },
        liquidity: { exitUnknown: true }
      };
      assert.equal(buildWatchState(vault, [], verdict, {}).verdict_level, null);
    }],
  ],
  diffDerivedState: [
    ['повертає порожній масив на першому спостереженні (prevState = null)', ({ diffDerivedState }) => {
      const next = { verdict_level: 'red', mqi_percent: 40, total_assets_usd: 1000 };
      assert.deepEqual(diffDerivedState(null, next, baseCtx(), NOW), []);
    }],
    ['зміни verdict, MQI, TVL, exit і flagged-ринків більше не створюють подій (їх бере дайджест зі знімків)', ({ diffDerivedState }) => {
      const prev = { verdict_level: 'green', mqi_percent: 95, total_assets_usd: 1_000_000, instant_exit_percent: 25, flagged_markets: {}, unpriced: false, exit_unknown: false };
      const next = { verdict_level: 'red', mqi_percent: 60, total_assets_usd: 500_000, instant_exit_percent: 5, flagged_markets: { '0xm2': { label: 'x', supplyUsd: 1 } }, unpriced: false, exit_unknown: false };
      assert.deepEqual(diffDerivedState(prev, next, baseCtx(), NOW), []);
    }],
    ['exit_liquidity_low: одна подія при переході з 5% і вище під 5%, лише для vault від $10K; без події при 4.9 -> 4.5, при падінні 8 -> 6 і для пилу', ({ diffDerivedState }) => {
      const st = (exit, tvl = 500_000) => ({ ...M, instant_exit_percent: exit, total_assets_usd: tvl, bad_debt_markets: {}, unverified_bad_debt_markets: [], flagged_markets: {}, is_listed: 1 });
      const evs = diffDerivedState(st(6), st(1.4), baseCtx(), NOW);
      assert.deepEqual(evs.map(e => [e.kind, e.severity]), [['exit_liquidity_low', 'warning']]);
      assert.deepEqual(JSON.parse(evs[0].details_json), { previousExitPercent: 6, currentExitPercent: 1.4 });
      assert.deepEqual(diffDerivedState(st(4.9), st(4.5), baseCtx(), NOW), []);
      assert.deepEqual(diffDerivedState(st(8), st(6), baseCtx(), NOW), []);
      assert.deepEqual(diffDerivedState(st(6, 5_000), st(1, 5_000), baseCtx(), NOW), []);
      assert.deepEqual(diffDerivedState(st(null), st(1), baseCtx(), NOW), []);
    }],
    ['виявляє bad_debt_appeared і vault_delisted; вдруге ту саму подію не створює (стабільний dedupe_key)', ({ diffDerivedState }) => {
      const prev = { ...M, bad_debt_markets: {}, unverified_bad_debt_markets: [], flagged_markets: {}, is_listed: 1 };
      const next = {
        ...M,
        bad_debt_markets: { '0xm1': { label: 'wstETH/USDC', badDebtUsd: 12000, supplyUsd: 200000 } },
        unverified_bad_debt_markets: [],
        flagged_markets: { '0xm2': { label: 'sUSDe/USDC', collateralSymbol: 'sUSDe', reasons: [], supplyUsd: 300000 } },
        is_listed: 0
      };
      const evs = diffDerivedState(prev, next, baseCtx(), NOW);
      assert.deepEqual(evs.map(e => [e.kind, e.severity]), [['bad_debt_appeared', 'critical'], ['vault_delisted', 'warning']]);
      const again = diffDerivedState(prev, next, baseCtx(), NOW + 3 * 3600);
      assert.deepEqual(again.map(e => e.dedupe_key), evs.map(e => e.dedupe_key));
    }],
    ['bad debt, про який вже сповіщали, але він виріс удвічі і більш ніж на $1000: нова подія раз на подвоєння; дрібне зростання мовчить', ({ diffDerivedState }) => {
      const st = usd => ({ ...M, bad_debt_markets: { '0xm1': { label: 'wstETH/USDC', badDebtUsd: usd, supplyUsd: 4e7 } }, unverified_bad_debt_markets: [], flagged_markets: {}, is_listed: 1 });
      const grown = diffDerivedState(st(6000), st(2e7), baseCtx(), NOW);
      assert.deepEqual(grown.map(e => [e.kind, e.severity]), [['bad_debt_appeared', 'critical']]);
      assert.match(grown[0].title, /grew in wstETH\/USDC from \$6000 to \$20000000/);
      assert.notEqual(grown[0].dedupe_key, diffDerivedState({ ...M, bad_debt_markets: {}, unverified_bad_debt_markets: [], flagged_markets: {}, is_listed: 1 }, st(6000), baseCtx(), NOW)[0].dedupe_key);
      assert.deepEqual(diffDerivedState(st(6000), st(8000), baseCtx(), NOW), []);
      assert.deepEqual(diffDerivedState(st(500), st(1200), baseCtx(), NOW), []);
    }],
    ['bad debt після пропуску даних: подія виходить один раз з afterDataGap, далі тиша', ({ diffDerivedState }) => {
      const debt = { '0xm1': { label: 'wstETH/USDC', badDebtUsd: 5e6, supplyUsd: 200000 } };
      const s1 = { ...M, bad_debt_markets: {}, unverified_bad_debt_markets: ['0xm1'], flagged_markets: {}, is_listed: 1 };
      const s2 = { ...M, bad_debt_markets: debt, unverified_bad_debt_markets: [], flagged_markets: {}, is_listed: 1 };
      const evs = diffDerivedState(s1, s2, baseCtx(), NOW);
      assert.deepEqual(evs.map(e => [e.kind, e.severity]), [['bad_debt_appeared', 'critical']]);
      assert.equal(JSON.parse(evs[0].details_json).afterDataGap, true); assert.match(evs[0].title, /after a gap in data/);
      assert.deepEqual(diffDerivedState(s2, s2, baseCtx(), NOW + 3 * 3600), []);
    }],
    ['звичайна поява bad debt (маркет був перевірений) іде без afterDataGap', ({ diffDerivedState }) => {
      const s1 = { ...M, bad_debt_markets: {}, unverified_bad_debt_markets: [], flagged_markets: {}, is_listed: 1 };
      const s2 = { ...s1, bad_debt_markets: { '0xm1': { label: 'x', badDebtUsd: 1e4, supplyUsd: 1e5 } } };
      const d = JSON.parse(diffDerivedState(s1, s2, baseCtx(), NOW)[0].details_json);
      assert.equal('afterDataGap' in d, false);
    }],
    ['маркет лишається непідтвердженим -> події немає', ({ diffDerivedState }) => {
      const s = { ...M, bad_debt_markets: {}, unverified_bad_debt_markets: ['0xm1'], flagged_markets: {}, is_listed: 1 };
      assert.deepEqual(diffDerivedState(s, s, baseCtx(), NOW), []);
    }],
  ],
  detectTvlOutflow: [
    ['падіння 20% у токенах і >= $500k -> warning з деталями для клієнта', ({ detectTvlOutflow }) => {
      const e = detectTvlOutflow(baseCtx(), 8_000_000, 10_000_000, 10_000_000, NOW);
      assert.equal(e.kind, 'tvl_drop'); assert.equal(e.severity, 'warning'); assert.equal(e.source, 'derived');
      assert.deepEqual(JSON.parse(e.details_json), { previousTvlUsd: 10_000_000, currentTvlUsd: 8_000_000, dropPercent: 20 });
    }],
    ['падіння 30% і більше -> critical', ({ detectTvlOutflow }) => {
      assert.equal(detectTvlOutflow(baseCtx(), 6_900_000, 10_000_000, 10_000_000, NOW).severity, 'critical');
    }],
    ['14.9% нижче порога, а 15% на порозі', ({ detectTvlOutflow }) => {
      assert.equal(detectTvlOutflow(baseCtx(), 8_510_000, 10_000_000, 10_000_000, NOW), null);
      assert.ok(detectTvlOutflow(baseCtx(), 8_500_000, 10_000_000, 10_000_000, NOW));
    }],
    ['менше $500k втрачено -> null, навіть якщо відсоток великий', ({ detectTvlOutflow }) => {
      assert.equal(detectTvlOutflow(baseCtx(), 1_000, 2_000_000 / 1000, 2_000_000 / 1000, NOW), null);
      assert.ok(detectTvlOutflow(baseCtx(), 1_000_000, 2_000_000, 2_000_000, NOW));
    }],
    ['падіння ціни активу не рахується: токенів стільки ж -> null', ({ detectTvlOutflow }) => {
      assert.equal(detectTvlOutflow(baseCtx(), 10_000_000, 10_000_000, 30_000_000, NOW), null);
    }],
    ['без вікна, unpriced, без ціни або нечислові значення -> null', ({ detectTvlOutflow }) => {
      assert.equal(detectTvlOutflow(baseCtx(), 5, 0, 0, NOW), null);
      assert.equal(detectTvlOutflow(baseCtx(), 5, NaN, 10, NOW), null);
      assert.equal(detectTvlOutflow(baseCtx({ unpriced: true }), 5_000_000, 10_000_000, 10_000_000, NOW), null);
      assert.equal(detectTvlOutflow(baseCtx({ assetPriceUsd: 0 }), 5_000_000, 10_000_000, 10_000_000, NOW), null);
      assert.equal(detectTvlOutflow(null, 5, 10, 10, NOW), null);
    }],
    ['dedupe: той самий рівень у ту саму добу має однаковий ключ, критичний - інший', ({ detectTvlOutflow }) => {
      const a = detectTvlOutflow(baseCtx(), 8_000_000, 10_000_000, 10_000_000, NOW);
      const b = detectTvlOutflow(baseCtx(), 7_900_000, 10_000_000, 10_000_000, NOW + 3600);
      const c = detectTvlOutflow(baseCtx(), 6_000_000, 10_000_000, 10_000_000, NOW + 7200);
      assert.equal(a.dedupe_key, b.dedupe_key); assert.notEqual(a.dedupe_key, c.dedupe_key);
    }],
  ],
  isRepeatEvent: [
    ['черга з тим самим набором ринків - повтор, навіть у іншому порядку; інший склад - ні', ({ isRepeatEvent }) => {
      const q = (list, t = NOW) => ({ kind: 'supply_queue_changed', status: 'final', title: 'Supply queue updated (2 markets)', occurred_at: t, details_json: JSON.stringify({ txHash: '0x' + t, supplyQueue: list }) });
      assert.equal(isRepeatEvent(q(['0xA', '0xb'], NOW + 30 * DAY), q(['0xa', '0xB'])), true, 'регістр і час не важать');
      assert.equal(isRepeatEvent(q(['0xb', '0xa']), q(['0xa', '0xb'])), true, 'перестановка тих самих ринків - не нова інформація');
      assert.equal(isRepeatEvent(q(['0xa', '0xc']), q(['0xa', '0xb'])), false, 'інший ринок у черзі');
      assert.equal(isRepeatEvent(q(['0xa']), q(['0xa', '0xb'])), false);
      assert.equal(isRepeatEvent(q(['0xa']), null), false);
    }],
    ['відтік TVL: повтор, якщо за добу вже був не менш серйозний; ескалація до critical і нова доба - ні', ({ isRepeatEvent }) => {
      const t = (severity, at) => ({ kind: 'tvl_drop', status: 'final', severity, title: `Vault TVL dropped`, occurred_at: at, details_json: '{}' });
      assert.equal(isRepeatEvent(t('warning', NOW + 3600), t('warning', NOW)), true);
      assert.equal(isRepeatEvent(t('warning', NOW + 3600), t('critical', NOW)), true);
      assert.equal(isRepeatEvent(t('critical', NOW + 3600), t('warning', NOW)), false, 'ескалація - нова інформація');
      assert.equal(isRepeatEvent(t('warning', NOW + DAY), t('warning', NOW)), false, 'через добу - нове вікно');
    }],
    ['інші події: той самий заголовок і деталі без txHash за добу; парні переходи, pending і реалокації - ніколи', ({ isRepeatEvent }) => {
      const e = (kind, title, details, at = NOW, status = 'final') => ({ kind, status, title, occurred_at: at, details_json: JSON.stringify(details) });
      assert.equal(isRepeatEvent(e('fee_changed', 'Fee 10%', { txHash: '0x2', newFee: 0.1 }, NOW + 60), e('fee_changed', 'Fee 10%', { txHash: '0x1', newFee: 0.1 })), true);
      assert.equal(isRepeatEvent(e('fee_changed', 'Fee 20%', { newFee: 0.2 }, NOW + 60), e('fee_changed', 'Fee 10%', { newFee: 0.1 })), false);
      assert.equal(isRepeatEvent(e('verdict_worsened', 'G to R', {}, NOW + 60), e('verdict_worsened', 'G to R', {})), false);
      assert.equal(isRepeatEvent(e('pending_cap_increase', 'Cap', {}, NOW + 60, 'pending'), e('pending_cap_increase', 'Cap', {}, NOW, 'pending')), false);
      assert.equal(isRepeatEvent(e('reallocation', 'R', {}, NOW + 60), e('reallocation', 'R', {})), false);
      assert.equal(isRepeatEvent(e('fee_changed', 'Fee 10%', {}, NOW + 60), e('curator_changed', 'Fee 10%', {})), false, 'різні типи');
      assert.equal(isRepeatEvent({ ...e('fee_changed', 'F', {}), details_json: 'not json' }, e('fee_changed', 'F', {}, NOW + 60)), true, 'зламаний JSON = порожні деталі');
    }]
  ],
};
