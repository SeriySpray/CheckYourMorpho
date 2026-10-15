import assert from 'node:assert/strict';
import { vault, alloc, idle, diversified } from '../fixtures.js';

// Застава з окремою адресою; usd - сума постачання в ринок.
const col = (i, usd, over = {}) => alloc({
  market_unique_key: `1:0x${i}`, collateral_asset_address: `0xc${i}`, collateral_asset_symbol: `C${i}`, supply_assets_usd: usd, ...over
});
const equal = (n, each = 100e6 / n) => Array.from({ length: n }, (_, i) => col(i, each));
const ZERO = '0x0000000000000000000000000000000000000000';

export default {
  isIdleReserveMarket: [
    ['NONE-застава з LLTV 0 є резервом', ({ isIdleReserveMarket: f }) =>
      assert.equal(f({ collateral_asset_symbol: 'NONE', lltv_percent: 0 }), true)],
    ['WETH з LLTV 86 не є резервом', ({ isIdleReserveMarket: f }) =>
      assert.equal(f(alloc()), false)],
    ['нульова адреса, але LLTV > 0 не є резервом', ({ isIdleReserveMarket: f }) =>
      assert.equal(f({ collateral_asset_address: '0x', lltv_percent: 86 }), false)],
    ['порожній об\'єкт вважається резервом', ({ isIdleReserveMarket: f }) =>
      assert.equal(f({}), true)],
    ['символ IDLE з реальною адресою і LLTV 0 -> резерв', ({ isIdleReserveMarket: f }) =>
      assert.equal(f({ collateral_asset_address: '0xabc', collateral_asset_symbol: 'IDLE', lltv_percent: 0 }), true)],
    ['адреса "0x" з символом WETH і LLTV 0 -> резерв', ({ isIdleReserveMarket: f }) =>
      assert.equal(f({ collateral_asset_address: '0x', collateral_asset_symbol: 'WETH', lltv_percent: 0 }), true)],
    ['повна нульова адреса у верхньому регістрі і LLTV 0 -> резерв', ({ isIdleReserveMarket: f }) =>
      assert.equal(f({ collateral_asset_address: ZERO.toUpperCase(), collateral_asset_symbol: 'WETH', lltv_percent: 0 }), true)],
    ['символ " none " з пробілами і LLTV-рядком "0" -> резерв', ({ isIdleReserveMarket: f }) =>
      assert.equal(f({ collateral_asset_symbol: ' none ', lltv: '0', lltv_percent: '0' }), true)],
    ['NONE-застава з LLTV у wei (0.86e18) не є резервом', ({ isIdleReserveMarket: f }) =>
      assert.equal(f({ collateral_asset_symbol: 'NONE', lltv: '860000000000000000', lltv_percent: 0 }), false)],
  ],
  calculateHHI: [
    ['порожній vault -> UNALLOCATED, hhi 0, порожній breakdown', ({ calculateHHI: f }) => {
      const r = f(vault(), []);
      assert.equal(r.tier, 'UNALLOCATED'); assert.equal(r.hhi, 0); assert.equal(r.effectiveAssets, 0);
      assert.deepEqual(r.breakdown, []); assert.equal(r.isExtremeConcentration, false);
    }],
    ['нечисловий total_assets_usd -> UNALLOCATED', ({ calculateHHI: f }) =>
      assert.equal(f(vault({ total_assets_usd: 'abc' }), [alloc({ supply_assets_usd: 100e6 })]).tier, 'UNALLOCATED')],
    ['уся алокація в резерві -> UNALLOCATED', ({ calculateHHI: f }) =>
      assert.equal(f(vault(), [idle()]).tier, 'UNALLOCATED')],
    ['активна застава рівно 1% TVL суттєва (не UNALLOCATED), DIVERSIFIED Low Exposure', ({ calculateHHI: f }) => {
      const r = f(vault(), [col(0, 1e6)]);
      assert.equal(r.tier, 'DIVERSIFIED'); assert.equal(r.tierLabel, 'Low Exposure (High Cash)'); assert.equal(r.hhi, 1);
    }],
    ['активна застава 0.99% TVL -> UNALLOCATED', ({ calculateHHI: f }) =>
      assert.equal(f(vault(), [col(0, 0.99e6)]).tier, 'UNALLOCATED')],
    ['пил менше 1% TVL ігнорується', ({ calculateHHI: f }) =>
      assert.equal(f(vault({ total_assets_usd: 1e9 }), [alloc({ supply_assets_usd: 5e6 })]).tier, 'UNALLOCATED')],
    ['одна застава на 100% TVL -> hhi 1, effectiveAssets 1, EXTREME', ({ calculateHHI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 100e6 })]);
      assert.equal(r.hhi, 1); assert.equal(r.effectiveAssets, 1); assert.equal(r.tier, 'EXTREME');
      assert.equal(r.tierLabel, 'Critical Concentration'); assert.equal(r.isExtremeConcentration, true);
      assert.deepEqual(r.topCollateral, { symbol: 'WETH', usd: 100e6, sharePercent: 100 });
      assert.deepEqual(r.breakdown, [{ symbol: 'WETH', usd: 100e6, sharePercent: 100 }]);
    }],
    ['частки 60/40 -> hhi 0.52 (> 0.5), effectiveAssets 1.9, EXTREME', ({ calculateHHI: f }) => {
      const r = f(vault(), [col(0, 60e6), col(1, 40e6)]);
      assert.equal(r.hhi, 0.52); assert.equal(r.effectiveAssets, 1.9); assert.equal(r.tier, 'EXTREME');
    }],
    ['дві рівні застави -> hhi рівно 0.5, effectiveAssets 2, CONCENTRATED (не EXTREME)', ({ calculateHHI: f }) => {
      const r = f(vault(), equal(2));
      assert.equal(r.hhi, 0.5); assert.equal(r.effectiveAssets, 2); assert.equal(r.tier, 'CONCENTRATED');
      assert.equal(r.tierLabel, 'High Concentration'); assert.equal(r.isExtremeConcentration, false);
    }],
    ['три рівні застави -> hhi 0.333, effectiveAssets 3, CONCENTRATED', ({ calculateHHI: f }) => {
      const r = f(vault(), equal(3, 100e6 / 3));
      assert.equal(r.hhi, 0.333); assert.equal(r.effectiveAssets, 3); assert.equal(r.tier, 'CONCENTRATED');
    }],
    ['чотири рівні застави -> hhi рівно 0.25, CONCENTRATED', ({ calculateHHI: f }) => {
      const r = f(vault(), equal(4));
      assert.equal(r.hhi, 0.25); assert.equal(r.effectiveAssets, 4); assert.equal(r.tier, 'CONCENTRATED');
    }],
    ['п\'ять рівних застав -> hhi 0.2, MODERATE', ({ calculateHHI: f }) => {
      const r = f(vault(), equal(5));
      assert.equal(r.hhi, 0.2); assert.equal(r.tier, 'MODERATE'); assert.equal(r.tierLabel, 'Moderate Concentration');
    }],
    ['частки 20/15/15/15/15/10/10 -> hhi рівно 0.15, MODERATE', ({ calculateHHI: f }) => {
      const r = f(vault(), [20, 15, 15, 15, 15, 10, 10].map((p, i) => col(i, p * 1e6)));
      assert.equal(r.hhi, 0.15); assert.equal(r.tier, 'MODERATE');
    }],
    ['сім рівних застав -> hhi 0.143 (< 0.15), DIVERSIFIED', ({ calculateHHI: f }) => {
      const r = f(vault(), equal(7, 100e6 / 7));
      assert.equal(r.hhi, 0.143); assert.equal(r.tier, 'DIVERSIFIED'); assert.equal(r.tierLabel, 'High Diversification');
    }],
    ['десять рівних застав -> hhi 0.1, effectiveAssets 10, DIVERSIFIED', ({ calculateHHI: f }) => {
      const r = f(vault(), diversified());
      assert.equal(r.hhi, 0.1); assert.equal(r.effectiveAssets, 10); assert.equal(r.tier, 'DIVERSIFIED');
    }],
    ['гейт коду (не заголовка): одна застава 30% TVL (експозиція рівно 30%, top < 40) -> CONCENTRATED, не Low Exposure', ({ calculateHHI: f }) => {
      const r = f(vault(), [col(0, 30e6)]);
      assert.equal(r.tier, 'CONCENTRATED'); assert.equal(r.activeCollateralExposure, 30); assert.equal(r.topCollateral.sharePercent, 30);
    }],
    ['одна застава 29.9% TVL -> DIVERSIFIED Low Exposure (High Cash)', ({ calculateHHI: f }) => {
      const r = f(vault(), [col(0, 29.9e6)]);
      assert.equal(r.tier, 'DIVERSIFIED'); assert.equal(r.tierLabel, 'Low Exposure (High Cash)'); assert.equal(r.hhi, 1);
    }],
    ['одна застава рівно 40% TVL -> EXTREME', ({ calculateHHI: f }) =>
      assert.equal(f(vault(), [col(0, 40e6)]).tier, 'EXTREME')],
    ['гейт коду (не заголовка): одна застава 39.9% TVL (hhi 1, top < 40) -> лише CONCENTRATED', ({ calculateHHI: f }) =>
      assert.equal(f(vault(), [col(0, 39.9e6)]).tier, 'CONCENTRATED')],
    ['дві застави по 20% TVL (top рівно 20) -> CONCENTRATED', ({ calculateHHI: f }) =>
      assert.equal(f(vault(), equal(2, 20e6)).tier, 'CONCENTRATED')],
    ['гейт коду (не заголовка): дві застави по 19.9% TVL (hhi 0.5, top < 20) -> MODERATE', ({ calculateHHI: f }) =>
      assert.equal(f(vault(), equal(2, 19.9e6)).tier, 'MODERATE')],
    ['гейт коду (не заголовка): три застави по 10% TVL (hhi 0.333, top рівно 10) -> MODERATE', ({ calculateHHI: f }) => {
      const r = f(vault(), equal(3, 10e6));
      assert.equal(r.hhi, 0.333); assert.equal(r.tier, 'MODERATE');
    }],
    ['гейт коду (не заголовка): чотири застави по 9.9% TVL (hhi 0.25, top < 10) -> DIVERSIFIED з міткою High Diversification', ({ calculateHHI: f }) => {
      const r = f(vault(), equal(4, 9.9e6));
      assert.equal(r.hhi, 0.25); assert.equal(r.tier, 'DIVERSIFIED'); assert.equal(r.tierLabel, 'High Diversification');
    }],
    ['дві застави по 25% TVL: hhi рахується від активної застави (0.5), частки в breakdown від TVL (25%)', ({ calculateHHI: f }) => {
      const r = f(vault(), equal(2, 25e6));
      assert.equal(r.hhi, 0.5); assert.equal(r.activeCollateralExposure, 50); assert.equal(r.topCollateral.sharePercent, 25);
      assert.deepEqual(r.breakdown.map(b => b.sharePercent), [25, 25]);
    }],
    ['резервний ринок не входить у HHI, але входить у TVL: 50% WETH + 50% резерв -> hhi 1, top 50%, EXTREME', ({ calculateHHI: f }) => {
      const r = f(vault(), [idle({ supply_assets_usd: 50e6 }), alloc({ supply_assets_usd: 50e6 })]);
      assert.equal(r.hhi, 1); assert.equal(r.topCollateral.sharePercent, 50); assert.equal(r.activeCollateralExposure, 50);
      assert.equal(r.tier, 'EXTREME'); assert.equal(r.breakdown.length, 1);
    }],
    ['одна застава в двох ринках (адреса в різному регістрі) зливається в одну позицію', ({ calculateHHI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 30e6, collateral_asset_address: '0xWETH' }), alloc({ market_unique_key: '1:0xdef', supply_assets_usd: 70e6 })]);
      assert.equal(r.hhi, 1); assert.deepEqual(r.breakdown, [{ symbol: 'WETH', usd: 100e6, sharePercent: 100 }]);
    }],
    ['від\'ємна і нечислова сума постачання ігноруються', ({ calculateHHI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 100e6 }), col(1, -50e6), col(2, 'abc')]);
      assert.equal(r.hhi, 1); assert.equal(r.breakdown.length, 1); assert.equal(r.activeCollateralExposure, 100);
    }],
    ['високий кеш (експозиція 20%) -> DIVERSIFIED Low Exposure', ({ calculateHHI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 20e6 })]);
      assert.equal(r.tier, 'DIVERSIFIED'); assert.equal(r.tierLabel, 'Low Exposure (High Cash)');
    }],
    ['breakdown відсортований за спаданням частки, top - найбільша застава', ({ calculateHHI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 20e6 }), alloc({ collateral_asset_address: '0xb', collateral_asset_symbol: 'B', supply_assets_usd: 60e6 })]);
      assert.deepEqual(r.breakdown.map(b => [b.symbol, b.sharePercent]), [['B', 60], ['WETH', 20]]);
      assert.deepEqual(r.topCollateral, { symbol: 'B', usd: 60e6, sharePercent: 60 });
    }],
    ['інваріант: частки breakdown + кеш = 100%, hhi у [1/n, 1]', ({ calculateHHI: f }) => {
      const allocs = [35, 25, 15, 5].map((p, i) => col(i, p * 1e6));
      const r = f(vault(), allocs);
      const sum = r.breakdown.reduce((s, b) => s + b.sharePercent, 0);
      assert.equal(Math.round((sum + (100 - r.activeCollateralExposure)) * 10) / 10, 100);
      assert.ok(r.hhi >= 1 / allocs.length && r.hhi <= 1);
      // (35²+25²+15²+5²)/80² = 2100/6400 = 0.328125
      assert.equal(r.hhi, 0.328);
    }],
  ],
};
