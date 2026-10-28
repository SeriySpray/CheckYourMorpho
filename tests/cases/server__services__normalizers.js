import assert from 'node:assert/strict';

const rawVault = (over = {}) => ({
  address: '0xABC', name: 'V', symbol: 'v', listed: true, chain: { id: 8453 },
  asset: { address: '0xUSDC', symbol: 'USDC', decimals: 6, priceUsd: 1 },
  state: { totalAssets: '2000000000', curator: '0x0000000000000000000000000000000000000000', netApy: 0.04 },
  liquidity: { usd: 500 }, ...over
});

export default {
  positivePrice: [
    ['перша ціна понад нуль виграє; нуль, null, негативні й нечислові пропускаються', ({ positivePrice: f }) => {
      assert.equal(f(0, null, -3, 'abc', 2, 5), 2); assert.equal(f('4'), 4);
    }],
    ['цін немає або всі нульові -> 0, а не вигадана 1', ({ positivePrice: f }) => {
      assert.equal(f(), 0); assert.equal(f(null, undefined, 0), 0);
    }],
  ],
  formatUnits: [
    ['1000000 при 6 знаках = 1', ({ formatUnits: f }) => assert.equal(f('1000000', 6), 1)],
    ['порожнє/null/undefined = 0', ({ formatUnits: f }) => {
      assert.equal(f(''), 0); assert.equal(f(null), 0); assert.equal(f(undefined), 0);
    }],
    ['від\'ємне значення зберігає знак', ({ formatUnits: f }) => assert.equal(f('-1500000', 6), -1.5)],
    ['1 при 18 знаках = 1e-18', ({ formatUnits: f }) => assert.equal(f('1', 18), 1e-18)],
    ['нескінченне число і NaN = 0', ({ formatUnits: f }) => {
      assert.equal(f(Infinity, 6), 0); assert.equal(f(-Infinity, 6), 0); assert.equal(f(NaN, 6), 0);
    }],
    ['decimals = 0 повертає ціле', ({ formatUnits: f }) => assert.equal(f('42', 0), 42)],
    ['дробова частина відкидається', ({ formatUnits: f }) => assert.equal(f('1000000.9', 6), 1)],
    ['BigInt-вхід', ({ formatUnits: f }) => assert.equal(f(5000000n, 6), 5)],
    ['30-значне число (понад 2^53) при 18 знаках = 123456789012.3456789... з точністю double', ({ formatUnits: f }) => {
      assert.equal(f('123456789012345678901234567890', 18), 123456789012.34567890123456789);
      assert.equal(f('-123456789012345678901234567890', 18), -123456789012.34567890123456789);
    }],
    ['2^64 як BigInt при 0 знаках = 18446744073709551616', ({ formatUnits: f }) =>
      assert.equal(f(2n ** 64n, 0), 18446744073709551616)],
    ['звичайне число ділиться на 10^decimals: 2500000 при 6 знаках = 2.5, -2500000 = -2.5', ({ formatUnits: f }) => {
      assert.equal(f(2500000, 6), 2.5); assert.equal(f(-2500000, 6), -2.5);
    }],
    ['велике число (>= 1e15) йде через BigInt: 2e21 при 18 = 2000, 2^60 при 18 = 1.152921504606846976', ({ formatUnits: f }) => {
      assert.equal(f(2e21, 18), 2000); assert.equal(f(1e15, 6), 1e9); assert.equal(f(2 ** 60, 18), 1.152921504606846976);
    }],
    ['нечисловий рядок або об\'єкт дає 0, а не NaN ("safe formatting")', ({ formatUnits: f }) => {
      assert.equal(f('abc', 6), 0); assert.equal(f('12abc', 6), 0); assert.equal(f({}, 6), 0);
    }],
  ],
  parseLltv: [
    ['0.86e18 = 86', ({ parseLltv: f }) => assert.equal(f('860000000000000000'), 86)],
    ['0.945e18 = 94.5', ({ parseLltv: f }) => assert.equal(f('945000000000000000'), 94.5)],
    ['0/null/порожнє = 0', ({ parseLltv: f }) => { assert.equal(f(0), 0); assert.equal(f(null), 0); assert.equal(f(''), 0); }],
    ['округлення до сотих: 0.8612345e18 = 86.12, 1e18 = 100', ({ parseLltv: f }) => {
      assert.equal(f('861234500000000000'), 86.12); assert.equal(f('1000000000000000000'), 100);
    }],
    ['BigInt-вхід 0.915e18 = 91.5', ({ parseLltv: f }) => assert.equal(f(915000000000000000n), 91.5)],
    ['нечисловий LLTV дає 0, а не NaN', ({ parseLltv: f }) => assert.equal(f('abc'), 0)],
  ],
  marketKey: [
    ['формат chainId:marketId у нижньому регістрі', ({ marketKey: f }) => assert.equal(f(1, '0xABC'), '1:0xabc')],
    ['порожній marketId не падає', ({ marketKey: f }) => assert.equal(f(1, null), '1:')],
    ['той самий id на різних мережах дає різні ключі', ({ marketKey: f }) => assert.notEqual(f(1, '0xa'), f(8453, '0xa'))],
  ],
  normalizeVault: [
    ['C2: liquidity відсутня або usd null -> liquidity_usd null (невідомо), справжній 0 лишається 0', ({ normalizeVault: f }) => {
      assert.equal(f(rawVault({ liquidity: undefined })).liquidity_usd, null);
      assert.equal(f(rawVault({ liquidity: { usd: null } })).liquidity_usd, null);
      assert.equal(f(rawVault({ liquidity: { usd: 0 } })).liquidity_usd, 0);
    }],
    ['адреса в нижньому регістрі, мережа з chain.id', ({ normalizeVault: f }) => {
      const r = f(rawVault()); assert.equal(r.address, '0xabc'); assert.equal(r.chain_id, 8453); assert.equal(r.version, 'v1');
    }],
    ['TVL = totalAssets * ціна, коли totalAssetsUsd відсутній: 2000 USDC по 2$ = 4000', ({ normalizeVault: f }) =>
      assert.equal(f(rawVault({ asset: { decimals: 6, priceUsd: 2 } })).total_assets_usd, 4000)],
    ['TVL береться з totalAssetsUsd, коли він є', ({ normalizeVault: f }) =>
      assert.equal(f(rawVault({ state: { totalAssets: '2000000000', totalAssetsUsd: 1234 } })).total_assets_usd, 1234)],
    ['без asset.decimals використовується 18: 3e18 по 1$ = 3', ({ normalizeVault: f }) => {
      const r = f(rawVault({ asset: { priceUsd: 1 }, state: { totalAssets: '3000000000000000000' } }));
      assert.equal(r.asset_decimals, 18); assert.equal(r.total_assets_usd, 3);
    }],
    ['net_apy береться з netApy, apy з apy', ({ normalizeVault: f }) => {
      const r = f(rawVault({ state: { totalAssets: '1', apy: 0.05, netApy: 0.04 } }));
      assert.equal(r.apy, 0.05); assert.equal(r.net_apy, 0.04);
    }],
    ['нульовий curator -> Independent', ({ normalizeVault: f }) => assert.equal(f(rawVault()).curator_name, 'Independent')],
    ['curator підставляється з мапи', ({ normalizeVault: f }) => {
      const r = f(rawVault({ state: { totalAssets: '1', curator: '0xCAFE' } }), new Map([['0xcafe', 'Gauntlet']]));
      assert.equal(r.curator_name, 'Gauntlet');
    }],
    ['curator, якого немає в мапі, лишається сирою адресою', ({ normalizeVault: f }) => {
      const r = f(rawVault({ state: { totalAssets: '1', curator: '0xBEEF' } }), new Map([['0xcafe', 'Gauntlet']]));
      assert.equal(r.curator_name, '0xBEEF');
    }],
    ['owner і pending_owner у нижньому регістрі', ({ normalizeVault: f }) => {
      const r = f(rawVault({ state: { totalAssets: '1', owner: '0xOWN', pendingOwner: '0xPEND' } }));
      assert.equal(r.owner, '0xown'); assert.equal(r.pending_owner, '0xpend');
    }],
    ['порожній об\'єкт не падає і дає значення за замовчуванням', ({ normalizeVault: f }) => {
      const r = f({}); assert.equal(r.name, 'Unknown Vault'); assert.equal(r.chain_id, 1); assert.equal(r.is_listed, 0);
      assert.equal(r.total_assets, '0'); assert.equal(r.total_assets_usd, 0);
    }],
  ],
  maxForceDeallocatePenalty: [
    ['без адаптерів -> 0', ({ maxForceDeallocatePenalty: f }) => assert.equal(f({}), 0)],
    ['бере максимальний штраф серед адаптерів', ({ maxForceDeallocatePenalty: f }) =>
      assert.equal(f({ adapters: { items: [{ forceDeallocatePenalty: '10000000000000000' }, { forceDeallocatePenalty: '30000000000000000' }] } }), 0.03)],
    ['штраф обмежений 1', ({ maxForceDeallocatePenalty: f }) =>
      assert.equal(f({ adapters: { items: [{ forceDeallocatePenalty: '5000000000000000000' }] } }), 1)],
    ['від\'ємний штраф обмежується знизу 0', ({ maxForceDeallocatePenalty: f }) =>
      assert.equal(f({ adapters: { items: [{ forceDeallocatePenalty: '-1000000000000000000' }] } }), 0)],
  ],
  cleanDescription: [
    ['звичайний текст куратора: пробіли й переноси зводяться до одного абзацу, керівні символи прибрано', ({ cleanDescription: f }) => {
      assert.equal(f('  The vault\n\nlends   USDC.\u0000 '), 'The vault lends USDC.');
      assert.equal(f('x'.repeat(2000)).length, 700);
    }],
    ['відсутнє або не текст -> порожній рядок', ({ cleanDescription: f }) => { for (const v of [undefined, null, 5, {}, '']) assert.equal(f(v), ''); }],
  ],
  normalizeVaultV2: [
    ['опис V2 і V1 береться з metadata.description', ({ normalizeVaultV2: f, normalizeVault: g }) => {
      assert.equal(f({ metadata: { description: ' Lends USDC. ' } }).description, 'Lends USDC.'); assert.equal(f({}).description, '');
      assert.equal(g({ metadata: { description: 'V1 text' }, state: {} }).description, 'V1 text');
    }],
    ['version = v2', ({ normalizeVaultV2: f }) => assert.equal(f({ address: '0xA' }).version, 'v2')],
    ['ім\'я куратора з curators.items', ({ normalizeVaultV2: f }) =>
      assert.equal(f({ curators: { items: [{ name: 'Steakhouse' }] } }).curator_name, 'Steakhouse')],
    ['curators.items має пріоритет над адресою з мапи', ({ normalizeVaultV2: f }) =>
      assert.equal(f({ curators: { items: [{ name: 'Steakhouse' }] }, curator: { address: '0xCAFE' } }, new Map([['0xcafe', 'Gauntlet']])).curator_name, 'Steakhouse')],
    ['адреса куратора з мапи; без збігу лишається сира адреса', ({ normalizeVaultV2: f }) => {
      const map = new Map([['0xcafe', 'Gauntlet']]);
      assert.equal(f({ curator: { address: '0xCAFE' } }, map).curator_name, 'Gauntlet');
      assert.equal(f({ curator: { address: '0xBEEF' } }, map).curator_name, '0xBEEF');
    }],
    ['без куратора і з назвою HyperEVM... -> HyperEVM, інакше Independent', ({ normalizeVaultV2: f }) => {
      assert.equal(f({ name: 'HyperEVM USDC' }).curator_name, 'HyperEVM');
      assert.equal(f({ name: 'Other USDC' }).curator_name, 'Independent');
    }],
    ['ліквідність обмежена TVL', ({ normalizeVaultV2: f }) => {
      const r = f({ totalAssetsUsd: 100, liquidityUsd: 500, asset: { decimals: 6 } });
      assert.equal(r.liquidity_usd, 100);
    }],
    ['штраф forceDeallocate зменшує ліквідність', ({ normalizeVaultV2: f }) => {
      const r = f({ totalAssetsUsd: 1000, forceDeallocatableLiquidityUsd: 100, adapters: { items: [{ forceDeallocatePenalty: '500000000000000000' }] } });
      assert.equal(r.liquidity_usd, 50);
    }],
    ['ліквідність = liquidityUsd + forceDeallocatable * (1 - штраф): 100 + 200 * 0.75 = 250', ({ normalizeVaultV2: f }) => {
      const r = f({ totalAssetsUsd: 1000, liquidityUsd: 100, forceDeallocatableLiquidityUsd: 200, adapters: { items: [{ forceDeallocatePenalty: '250000000000000000' }] } });
      assert.equal(r.liquidity_usd, 250);
    }],
    ['TVL рахується з totalAssets * ціна (5 USDC по 2$ = 10) і обмежує ліквідність', ({ normalizeVaultV2: f }) => {
      const r = f({ totalAssets: '5000000', asset: { decimals: 6, priceUsd: 2 }, liquidityUsd: 50 });
      assert.equal(r.total_assets_usd, 10); assert.equal(r.liquidity_usd, 10);
    }],
    ['net_apy повертається до apy, коли netApy відсутній', ({ normalizeVaultV2: f }) =>
      assert.equal(f({ apy: 0.07 }).net_apy, 0.07)],
    ['некоректний штраф адаптера не робить ліквідність NaN', ({ normalizeVaultV2: f }) => {
      const r = f({ totalAssetsUsd: 1000, liquidityUsd: 100, adapters: { items: [{ forceDeallocatePenalty: 'abc' }] } });
      assert.ok(Number.isFinite(r.liquidity_usd), `liquidity_usd = ${r.liquidity_usd}`);
    }],
    ['C2: без liquidityUsd і forceDeallocatableLiquidityUsd -> null (невідомо), а не 0; одне з них є -> число', ({ normalizeVaultV2: f }) => {
      assert.equal(f({ totalAssetsUsd: 1000 }).liquidity_usd, null);
      assert.equal(f({ totalAssetsUsd: 1000, liquidityUsd: 0 }).liquidity_usd, 0);
      assert.equal(f({ totalAssetsUsd: 1000, forceDeallocatableLiquidityUsd: 40 }).liquidity_usd, 40);
    }],
  ],
  normalizeMarket: [
    ['застава із символом, але без адреси -> адреса null (невідомо); ринок без застави -> порожня', ({ normalizeMarket: f }) => {
      assert.equal(f({ marketId: '0xM', collateralAsset: { symbol: 'WETH' } }).collateral_asset_address, null);
      assert.equal(f({ marketId: '0xM' }).collateral_asset_address, '');
      assert.equal(f({ marketId: '0xM', collateralAsset: { symbol: 'WETH', address: '0xABC' } }).collateral_asset_address, '0xabc');
    }],
    ['bad debt і попередження, яких API не повернуло, -> null (невідомо), а не 0 / "[]"', ({ normalizeMarket: f }) => {
      const r = f({ marketId: '0xM' });
      assert.equal(r.bad_debt_usd, null); assert.equal(r.realized_bad_debt_usd, null); assert.equal(r.warnings_json, null);
    }],
    ['повернуті bad debt 0 і порожні попередження -> 0 і "[]"', ({ normalizeMarket: f }) => {
      const r = f({ marketId: '0xM', badDebt: { usd: 0 }, realizedBadDebt: { usd: 5 }, warnings: [] });
      assert.equal(r.bad_debt_usd, 0); assert.equal(r.realized_bad_debt_usd, 5); assert.equal(r.warnings_json, '[]');
    }],
    ['ціна позичального активу не повернута -> 0 USD вільної ліквідності, не вигадані $1', ({ normalizeMarket: f }) => {
      const r = f({ marketId: '0xM', loanAsset: { decimals: 6 }, state: { supplyAssets: '2000000', borrowAssets: '1000000' } });
      assert.equal(r.loan_asset_price_usd, 0); assert.equal(r.free_liquidity_usd, 0);
    }],
    ['USD постачання/боргу не повернуті, але ціна відома -> рахуються з кількості (2 * 3 = 6, 1 * 3 = 3)', ({ normalizeMarket: f }) => {
      const r = f({ marketId: '0xM', loanAsset: { decimals: 6, priceUsd: 3 }, state: { supplyAssets: '2000000', borrowAssets: '1000000' } });
      assert.equal(r.total_supply_assets_usd, 6); assert.equal(r.total_borrow_assets_usd, 3);
    }],
    ['повернуті USD постачання лишаються як є, навіть 0', ({ normalizeMarket: f }) =>
      assert.equal(f({ marketId: '0xM', loanAsset: { decimals: 6, priceUsd: 3 }, state: { supplyAssets: '2000000', supplyAssetsUsd: 0 } }).total_supply_assets_usd, 0)],
    ['застава з адресою, але без символу -> UNKNOWN, не NONE (інакше стала б резервом)', ({ normalizeMarket: f }) =>
      assert.equal(f({ marketId: '0xM', collateralAsset: { address: '0xABC' } }).collateral_asset_symbol, 'UNKNOWN')],
    ['ринок без застави -> NONE', ({ normalizeMarket: f }) =>
      assert.equal(f({ marketId: '0xM' }).collateral_asset_symbol, 'NONE')],
    ['LLTV, якого API не повернуло, лишається порожнім (невідомим), справжній 0 лишається "0"', ({ normalizeMarket: f }) => {
      assert.equal(f({ marketId: '0xM' }).lltv, ''); assert.equal(f({ marketId: '0xM', lltv: '0' }).lltv, '0');
    }],
    ['утилізація = borrow / supply', ({ normalizeMarket: f }) => {
      const r = f({ marketId: '0xM', lltv: '860000000000000000', loanAsset: { decimals: 6 }, state: { supplyAssets: '1000000', borrowAssets: '250000' } });
      assert.equal(r.utilization, 0.25); assert.equal(r.lltv_percent, 86); assert.equal(r.free_liquidity_assets, 0.75);
    }],
    ['утилізація обмежена 1', ({ normalizeMarket: f }) => {
      const r = f({ loanAsset: { decimals: 6 }, state: { supplyAssets: '1000000', borrowAssets: '9000000' } });
      assert.equal(r.utilization, 1); assert.equal(r.free_liquidity_assets, 0);
    }],
    ['нульовий supply: утилізація 0 (без ділення на нуль), вільна ліквідність 0', ({ normalizeMarket: f }) => {
      const r = f({ loanAsset: { decimals: 6 }, state: { supplyAssets: '0', borrowAssets: '0' } });
      assert.equal(r.utilization, 0); assert.equal(r.free_liquidity_assets, 0); assert.equal(r.free_liquidity_usd, 0);
    }],
    ['вільна ліквідність у USD: без ціни 0 (невідомо), з ціною 2$ (4), з нульовою ціною 0', ({ normalizeMarket: f }) => {
      const st = { supplyAssets: '3000000', borrowAssets: '1000000' };
      const a = f({ loanAsset: { decimals: 6 }, state: st });
      assert.equal(a.free_liquidity_usd, 0); assert.equal(a.loan_asset_price_usd, 0); assert.equal(a.utilization, 1 / 3);
      assert.equal(f({ loanAsset: { decimals: 6, priceUsd: 2 }, state: st }).free_liquidity_usd, 4);
      assert.equal(f({ loanAsset: { decimals: 6, priceUsd: 0 }, state: st }).free_liquidity_usd, 0);
    }],
    ['без decimals використовується 18 (для loan і collateral)', ({ normalizeMarket: f }) => {
      const r = f({ state: { supplyAssets: '5000000000000000000', borrowAssets: '0' } });
      assert.equal(r.free_liquidity_assets, 5); assert.equal(r.loan_asset_decimals, 18); assert.equal(r.collateral_asset_decimals, 18);
    }],
    ['bad debt парситься з рядка, null -> null (не повернуто)', ({ normalizeMarket: f }) => {
      const r = f({ badDebt: { usd: '12.5' }, realizedBadDebt: { usd: null } });
      assert.equal(r.bad_debt_usd, 12.5); assert.equal(r.realized_bad_debt_usd, null);
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
    ['ціна ринку відсутня, ціна vault 0 -> 0 USD (невідомо), не вигадана ціна', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '1000000', market: { loanAsset: {} } }, '0xV', 6, 1000, 0).supply_assets_usd, 0)],
    ['нульова ціна ринку замінюється ціною vault (1 * 2 = 2)', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '1000000', market: { loanAsset: { priceUsd: 0 } } }, '0xV', 6, 1000, 2).supply_assets_usd, 2)],
    ['вага = частка в TVL', ({ normalizeAllocation: f }) => {
      const r = f({ supplyAssets: '250000000', supplyCap: '0', market: { marketId: '0xM' } }, '0xV', 6, 1000, 1, 1);
      assert.equal(r.weight, 0.25); assert.equal(r.vault_address, '0xv'); assert.equal(r.market_unique_key, '1:0xm'); assert.equal(r.via_vault, null);
    }],
    ['вага обмежена 1', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '9000000000' }, '0xV', 6, 1000).weight, 1)],
    ['нульовий TVL vault: вага 0 (без ділення на нуль)', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '1000000' }, '0xV', 6, 0).weight, 0)],
    ['cap переводиться в людські одиниці: 5e9 при 6 знаках = 5000', ({ normalizeAllocation: f }) => {
      const r = f({ supplyAssets: '0', supplyCap: '5000000000' }, '0xV', 6, 1000);
      assert.equal(r.supply_cap_human, 5000); assert.equal(r.supply_cap, '5000000000');
    }],
    ['USD береться з supplyAssetsUsd, якщо > 0', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '1000000', supplyAssetsUsd: 42 }, '0xV', 6, 1000).supply_assets_usd, 42)],
    ['USD рахується з ціни ринку, коли supplyAssetsUsd відсутній', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '2000000', market: { loanAsset: { priceUsd: 3 } } }, '0xV', 6, 1000).supply_assets_usd, 6)],
    ['supplyAssetsUsd = 0 вважається відсутнім: 2 * ціна ринку 3 = 6', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '2000000', supplyAssetsUsd: 0, market: { loanAsset: { priceUsd: 3 } } }, '0xV', 6, 1000).supply_assets_usd, 6)],
    ['без ціни ринку USD = кількість * ціна активу vault (1 * 2 = 2)', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '1000000' }, '0xV', 6, 1000, 2).supply_assets_usd, 2)],
    ['ключ ринку містить chainId vault', ({ normalizeAllocation: f }) =>
      assert.equal(f({ supplyAssets: '0', market: { marketId: '0xM' } }, '0xV', 6, 1000, 1, 8453).market_unique_key, '8453:0xm')],
  ],
  normalizeAllocationV2: [
    ['вага і via_vault', ({ normalizeAllocationV2: f }) => {
      const r = f({ allocation: '500000000', absoluteCap: '1000000000', viaVault: '0xP', data: { market: { marketId: '0xM' } } }, '0xV', 6, 1000);
      assert.equal(r.weight, 0.5); assert.equal(r.via_vault, '0xP'); assert.equal(r.supply_cap_human, 1000);
    }],
    ['вага обмежена 1 і дорівнює 0 при нульовому TVL', ({ normalizeAllocationV2: f }) => {
      assert.equal(f({ allocation: '3000000000' }, '0xV', 6, 1000).weight, 1);
      assert.equal(f({ allocation: '3000000000' }, '0xV', 6, 0).weight, 0);
    }],
    ['ціна ринку має пріоритет над ціною vault (1 * 3 = 3)', ({ normalizeAllocationV2: f }) =>
      assert.equal(f({ allocation: '1000000', data: { market: { loanAsset: { priceUsd: 3 } } } }, '0xV', 6, 1000, 2).supply_assets_usd, 3)],
    ['нульова ціна ринку замінюється ціною vault (1 * 2 = 2)', ({ normalizeAllocationV2: f }) =>
      assert.equal(f({ allocation: '1000000', data: { market: { loanAsset: { priceUsd: 0 } } } }, '0xV', 6, 1000, 2).supply_assets_usd, 2)],
    ['ціна береться з ціни активу vault, коли ціни ринку немає', ({ normalizeAllocationV2: f }) =>
      assert.equal(f({ allocation: '1000000' }, '0xV', 6, 1000, 2).supply_assets_usd, 2)],
    ['невідома ціна лишається невідомою: 0 USD, а не вигадана 1', ({ normalizeAllocationV2: f }) =>
      assert.equal(f({ allocation: '1000000' }, '0xV', 6, 1000, 0).supply_assets_usd, 0)],
    ['без viaVault -> null, ключ ринку з chainId', ({ normalizeAllocationV2: f }) => {
      const r = f({ allocation: '0', data: { market: { marketId: '0xM' } } }, '0xV', 6, 1000, 1, 8453);
      assert.equal(r.via_vault, null); assert.equal(r.market_unique_key, '8453:0xm');
    }],
  ],
};
