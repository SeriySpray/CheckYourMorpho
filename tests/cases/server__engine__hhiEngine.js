import assert from 'node:assert/strict';
import { vault, alloc, idle, diversified } from '../fixtures.js';

const equal = (n, total = 100e6) => Array.from({ length: n }, (_, i) =>
  alloc({ market_unique_key: `1:0x${i}`, collateral_asset_address: `0xc${i}`, collateral_asset_symbol: `C${i}`, supply_assets_usd: total / n }));

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
  ],
  calculateHHI: [
    ['порожній вольт -> UNALLOCATED', ({ calculateHHI: f }) =>
      assert.equal(f(vault(), []).tier, 'UNALLOCATED')],
    ['уся алокація в резерві -> UNALLOCATED', ({ calculateHHI: f }) =>
      assert.equal(f(vault(), [idle()]).tier, 'UNALLOCATED')],
    ['одна застава на 100% TVL -> hhi 1, EXTREME', ({ calculateHHI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 100e6 })]);
      assert.equal(r.hhi, 1); assert.equal(r.tier, 'EXTREME'); assert.equal(r.isExtremeConcentration, true);
    }],
    ['дві рівні застави -> hhi 0.5, effectiveAssets 2, CONCENTRATED', ({ calculateHHI: f }) => {
      const r = f(vault(), equal(2));
      assert.equal(r.hhi, 0.5); assert.equal(r.effectiveAssets, 2); assert.equal(r.tier, 'CONCENTRATED');
    }],
    ['п\'ять рівних застав -> MODERATE', ({ calculateHHI: f }) =>
      assert.equal(f(vault(), equal(5)).tier, 'MODERATE')],
    ['десять рівних застав -> DIVERSIFIED', ({ calculateHHI: f }) =>
      assert.equal(f(vault(), diversified()).tier, 'DIVERSIFIED')],
    ['високий кеш (експозиція < 30%) -> DIVERSIFIED', ({ calculateHHI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 20e6 })]);
      assert.equal(r.tier, 'DIVERSIFIED'); assert.equal(r.tierLabel, 'Low Exposure (High Cash)');
    }],
    ['пил менше 1% TVL ігнорується', ({ calculateHHI: f }) =>
      assert.equal(f(vault({ total_assets_usd: 1e9 }), [alloc({ supply_assets_usd: 5e6 })]).tier, 'UNALLOCATED')],
    ['breakdown відсортований за спаданням частки', ({ calculateHHI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 20e6 }), alloc({ collateral_asset_address: '0xb', collateral_asset_symbol: 'B', supply_assets_usd: 60e6 })]);
      assert.equal(r.breakdown[0].symbol, 'B'); assert.equal(r.topCollateral.symbol, 'B');
    }],
  ],
};
