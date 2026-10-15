import assert from 'node:assert/strict';

const rawVault = (over = {}) => ({
  address: '0xABC', name: 'V', symbol: 'v', listed: true, chain: { id: 8453 },
  asset: { address: '0xUSDC', symbol: 'USDC', decimals: 6, priceUsd: 1 },
  state: { totalAssets: '2000000000', curator: '0x0000000000000000000000000000000000000000', netApy: 0.04 },
  liquidity: { usd: 500 }, ...over
});

export default {
  formatUnits: [
    ['1000000 при 6 знаках = 1', ({ formatUnits: f }) => assert.equal(f('1000000', 6), 1)],
    ['порожнє/null/undefined = 0', ({ formatUnits: f }) => {
      assert.equal(f(''), 0); assert.equal(f(null), 0); assert.equal(f(undefined), 0);
    }],
    ['від\'ємне значення зберігає знак', ({ formatUnits: f }) => assert.equal(f('-1500000', 6), -1.5)],
    ['1 при 18 знаках = 1e-18', ({ formatUnits: f }) => assert.equal(f('1', 18), 1e-18)],
    ['нескінченне число = 0', ({ formatUnits: f }) => assert.equal(f(Infinity, 6), 0)],
    ['decimals = 0 повертає ціле', ({ formatUnits: f }) => assert.equal(f('42', 0), 42)],
    ['дробова частина відкидається', ({ formatUnits: f }) => assert.equal(f('1000000.9', 6), 1)],
    ['BigInt-вхід', ({ formatUnits: f }) => assert.equal(f(5000000n, 6), 5)],
  ],
  parseLltv: [
    ['0.86e18 = 86', ({ parseLltv: f }) => assert.equal(f('860000000000000000'), 86)],
    ['0.945e18 = 94.5', ({ parseLltv: f }) => assert.equal(f('945000000000000000'), 94.5)],
    ['0/null/порожнє = 0', ({ parseLltv: f }) => { assert.equal(f(0), 0); assert.equal(f(null), 0); assert.equal(f(''), 0); }],
  ],
  marketKey: [
    ['формат chainId:marketId у нижньому регістрі', ({ marketKey: f }) => assert.equal(f(1, '0xABC'), '1:0xabc')],
    ['порожній marketId не падає', ({ marketKey: f }) => assert.equal(f(1, null), '1:')],
    ['той самий id на різних мережах дає різні ключі', ({ marketKey: f }) => assert.notEqual(f(1, '0xa'), f(8453, '0xa'))],
  ],
  normalizeVault: [
    ['адреса в нижньому регістрі, мережа з chain.id', ({ normalizeVault: f }) => {
      const r = f(rawVault()); assert.equal(r.address, '0xabc'); assert.equal(r.chain_id, 8453); assert.equal(r.version, 'v1');
    }],
    ['TVL рахується з totalAssets * ціна, коли totalAssetsUsd відсутній', ({ normalizeVault: f }) =>
      assert.equal(f(rawVault()).total_assets_usd, 2000)],
    ['нульовий curator -> Independent', ({ normalizeVault: f }) => assert.equal(f(rawVault()).curator_name, 'Independent')],
    ['curator підставляється з мапи', ({ normalizeVault: f }) => {
      const r = f(rawVault({ state: { totalAssets: '1', curator: '0xCAFE' } }), new Map([['0xcafe', 'Gauntlet']]));
      assert.equal(r.curator_name, 'Gauntlet');
    }],
    ['порожній об\'єкт не падає і дає значення за замовчуванням', ({ normalizeVault: f }) => {
      const r = f({}); assert.equal(r.name, 'Unknown Vault'); assert.equal(r.chain_id, 1); assert.equal(r.is_listed, 0);
    }],
  ],
  maxForceDeallocatePenalty: [
    ['без адаптерів -> 0', ({ maxForceDeallocatePenalty: f }) => assert.equal(f({}), 0)],
    ['бере максимальний штраф серед адаптерів', ({ maxForceDeallocatePenalty: f }) =>
      assert.equal(f({ adapters: { items: [{ forceDeallocatePenalty: '10000000000000000' }, { forceDeallocatePenalty: '30000000000000000' }] } }), 0.03)],
    ['штраф обмежений 1', ({ maxForceDeallocatePenalty: f }) =>
      assert.equal(f({ adapters: { items: [{ forceDeallocatePenalty: '5000000000000000000' }] } }), 1)],
  ],
  normalizeVaultV2: [
    ['version = v2', ({ normalizeVaultV2: f }) => assert.equal(f({ address: '0xA' }).version, 'v2')],
    ['ім\'я куратора з curators.items', ({ normalizeVaultV2: f }) =>
      assert.equal(f({ curators: { items: [{ name: 'Steakhouse' }] } }).curator_name, 'Steakhouse')],
    ['ліквідність обмежена TVL', ({ normalizeVaultV2: f }) => {
      const r = f({ totalAssetsUsd: 100, liquidityUsd: 500, asset: { decimals: 6 } });
      assert.equal(r.liquidity_usd, 100);
    }],
    ['штраф forceDeallocate зменшує ліквідність', ({ normalizeVaultV2: f }) => {
      const r = f({ totalAssetsUsd: 1000, forceDeallocatableLiquidityUsd: 100, adapters: { items: [{ forceDeallocatePenalty: '500000000000000000' }] } });
      assert.equal(r.liquidity_usd, 50);
    }],
    ['net_apy повертається до apy, коли netApy відсутній', ({ normalizeVaultV2: f }) =>
      assert.equal(f({ apy: 0.07 }).net_apy, 0.07)],
  ],
  normalizeMarket: [
    ['утилізація = borrow / supply', ({ normalizeMarket: f }) => {
      const r = f({ marketId: '0xM', lltv: '860000000000000000', loanAsset: { decimals: 6 }, state: { supplyAssets: '1000000', borrowAssets: '250000' } });
      assert.equal(r.utilization, 0.25); assert.equal(r.lltv_percent, 86); assert.equal(r.free_liquidity_assets, 0.75);
    }],
    ['утилізація обмежена 1', ({ normalizeMarket: f }) => {
      const r = f({ loanAsset: { decimals: 6 }, state: { supplyAssets: '1000000', borrowAssets: '9000000' } });
      assert.equal(r.utilization, 1); assert.equal(r.free_liquidity_assets, 0);
    }],
    ['ключ ринку містить chainId', ({ normalizeMarket: f }) => assert.equal(f({ marketId: '0xAB' }, 8453).unique_key, '8453:0xab')],
    ['warnings рахуються і серіалізуються', ({ normalizeMarket: f }) => {
      const r = f({ warnings: [{ type: 'x', level: 'RED' }] });
      assert.equal(r.warnings_count, 1); assert.deepEqual(JSON.parse(r.warnings_json), [{ type: 'x', level: 'RED' }]);
    }],
    ['listed лише при строгому true', ({ normalizeMarket: f }) => {
      assert.equal(f({ listed: true }).is_listed, 1); assert.equal(f({ listed: 'yes' }).is_listed, 0);
    }],
  ],
  normalizeAllocation: [
    ['вага = частка в TVL', ({ normalizeAllocation: f }) => {
      const r = f({ supplyAssets: '250000000', supplyCap: '0', market: { marketId: '0xM' } }, '0xV', 6, 1000, 1, 1);
      assert.equal(r.weight, 0.25); assert.equal(r.vault_address, '0xv'); assert.equal(r.market_unique_key, '1:0xm'); assert.equal(r.via_vault, null);
    }],
    ['вага обмежена 1', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '9000000000' }, '0xV', 6, 1000).weight, 1)],
    ['USD береться з supplyAssetsUsd, якщо > 0', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '1000000', supplyAssetsUsd: 42 }, '0xV', 6, 1000).supply_assets_usd, 42)],
    ['USD рахується з ціни ринку, коли supplyAssetsUsd відсутній', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '2000000', market: { loanAsset: { priceUsd: 3 } } }, '0xV', 6, 1000).supply_assets_usd, 6)],
  ],
  normalizeAllocationV2: [
    ['вага і via_vault', ({ normalizeAllocationV2: f }) => {
      const r = f({ allocation: '500000000', absoluteCap: '1000000000', viaVault: '0xP', data: { market: { marketId: '0xM' } } }, '0xV', 6, 1000);
      assert.equal(r.weight, 0.5); assert.equal(r.via_vault, '0xP'); assert.equal(r.supply_cap_human, 1000);
    }],
    ['ціна береться з ціни активу вольта, коли ціни ринку немає', ({ normalizeAllocationV2: f }) =>
      assert.equal(f({ allocation: '1000000' }, '0xV', 6, 1000, 2).supply_assets_usd, 2)],
    ['ціна за замовчуванням 1', ({ normalizeAllocationV2: f }) =>
      assert.equal(f({ allocation: '1000000' }, '0xV', 6, 1000, 0).supply_assets_usd, 1)],
  ],
};
