import assert from 'node:assert/strict';
import { vault, alloc, idle } from '../fixtures.js';

export default {
  getMaterialityThresholdUsd: [
    ['1% TVL для малого вольта', ({ getMaterialityThresholdUsd: f }) => assert.equal(f(1e6), 10000)],
    ['стеля 250K для великого вольта', ({ getMaterialityThresholdUsd: f }) => assert.equal(f(1e9), 250000)],
    ['нечислове значення -> 0', ({ getMaterialityThresholdUsd: f }) => {
      assert.equal(f(undefined), 0); assert.equal(f('abc'), 0); assert.equal(f(0), 0);
    }],
  ],
  isMarketClean: [
    ['базовий ринок чистий', ({ isMarketClean: f }) => assert.deepEqual(f(alloc()), { isClean: true, reasons: [] })],
    ['нелістингований ринок брудний', ({ isMarketClean: f }) => {
      const r = f(alloc({ is_listed: 0 })); assert.equal(r.isClean, false); assert.equal(r.reasons.length, 1);
    }],
    ['значна bad debt робить ринок брудним', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ bad_debt_usd: 1e6 })).isClean, false)],
    ['копійчана bad debt (нижче пилу) ігнорується', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ bad_debt_usd: 5 })).isClean, true)],
    ['відсутній oracle для ринку із заставою', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ oracle_address: '' })).isClean, false)],
    ['відсутній oracle в резерві допустимий', ({ isMarketClean: f }) =>
      assert.equal(f(idle()).isClean, true)],
    ['not_whitelisted YELLOW компрометує ринок', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ warnings_json: JSON.stringify([{ type: 'not_whitelisted', level: 'YELLOW' }]) })).isClean, false)],
  ],
  calculateMQI: [
    ['нульовий TVL -> 100%, isAllClean', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 0 }), []); assert.equal(r.mqiPercent, 100); assert.equal(r.isAllClean, true);
    }],
    ['усі ринки чисті -> 100%', ({ calculateMQI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 50e6 })]); assert.equal(r.mqiPercent, 100); assert.equal(r.cleanMarketsCount, 1);
    }],
    ['половина капіталу в брудному ринку -> 50%', ({ calculateMQI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 50e6 }), alloc({ is_listed: 0, supply_assets_usd: 50e6, market_unique_key: '1:0xbad' })]);
      assert.equal(r.mqiPercent, 50); assert.equal(r.compromisedMarkets.length, 1); assert.equal(r.compromisedMarkets[0].weightPercent, 50);
    }],
    ['несуттєвий брудний пил вважається чистим', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 1e9 }), [alloc({ is_listed: 0, supply_assets_usd: 100e3 })]);
      assert.equal(r.mqiPercent, 100); assert.equal(r.compromisedMarkets.length, 0);
    }],
    ['totalMarketsCount дорівнює кількості алокацій', ({ calculateMQI: f }) =>
      assert.equal(f(vault(), [alloc(), alloc()]).totalMarketsCount, 2)],
  ],
};
