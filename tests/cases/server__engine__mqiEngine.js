import assert from 'node:assert/strict';
import { vault, alloc, idle } from '../fixtures.js';

const warn = (...list) => alloc({ warnings_json: JSON.stringify(list.map(([type, level]) => ({ type, level }))) });
const dirty = (usd, over = {}) => alloc({ is_listed: 0, supply_assets_usd: usd, market_unique_key: `1:0xbad${usd}`, ...over });

export default {
  getMaterialityThresholdUsd: [
    ['1% TVL для малого vault', ({ getMaterialityThresholdUsd: f }) => assert.equal(f(1e6), 10000)],
    ['рівно на межі стелі: TVL 25M -> 250K', ({ getMaterialityThresholdUsd: f }) => assert.equal(f(25e6), 250000)],
    ['стеля 250K для великого vault', ({ getMaterialityThresholdUsd: f }) => assert.equal(f(1e9), 250000)],
    ['рядок з числом приймається: "2000000" -> 20000', ({ getMaterialityThresholdUsd: f }) => assert.equal(f('2000000'), 20000)],
    ['нечислове значення -> 0', ({ getMaterialityThresholdUsd: f }) => {
      assert.equal(f(undefined), 0); assert.equal(f('abc'), 0); assert.equal(f(0), 0);
    }],
  ],
  isMarketClean: [
    ['базовий ринок чистий', ({ isMarketClean: f }) => assert.deepEqual(f(alloc()), { isClean: true, reasons: [] })],
    ['нелістингований ринок брудний з однією причиною', ({ isMarketClean: f }) => {
      const r = f(alloc({ is_listed: 0 }));
      assert.equal(r.isClean, false); assert.deepEqual(r.reasons, ['Unlisted market (not verified by Morpho)']);
    }],
    ['відсутній is_listed (undefined або null) вважається лістингованим', ({ isMarketClean: f }) => {
      assert.equal(f(alloc({ is_listed: undefined })).isClean, true);
      assert.equal(f(alloc({ is_listed: null })).isClean, true);
    }],
    ['значна bad debt робить ринок брудним', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ bad_debt_usd: 1e6 })).isClean, false)],
    ['копійчана bad debt (нижче пилу) ігнорується', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ bad_debt_usd: 5 })).isClean, true)],
    ['поріг пилу для порожнього ринку $10: bad debt рівно 10 -> чистий, 10.01 -> брудний', ({ isMarketClean: f }) => {
      assert.equal(f(alloc({ total_supply_assets_usd: 0, bad_debt_usd: 10 })).isClean, true);
      assert.equal(f(alloc({ total_supply_assets_usd: 0, bad_debt_usd: 10.01 })).isClean, false);
    }],
    ['поріг пилу для realized bad debt той самий: 10 -> чистий, 11 -> брудний', ({ isMarketClean: f }) => {
      assert.equal(f(alloc({ total_supply_assets_usd: 0, realized_bad_debt_usd: 10 })).isClean, true);
      assert.equal(f(alloc({ total_supply_assets_usd: 0, realized_bad_debt_usd: 11 })).isClean, false);
    }],
    ['пил масштабується як 0.01% ринку: ринок $1B, 99 999 -> чистий, 100 001 -> брудний', ({ isMarketClean: f }) => {
      assert.equal(f(alloc({ total_supply_assets_usd: 1e9, bad_debt_usd: 99999 })).isClean, true);
      assert.equal(f(alloc({ total_supply_assets_usd: 1e9, realized_bad_debt_usd: 100001 })).isClean, false);
    }],
    ['причина bad debt містить суму обох видів: 100 + 50 -> "$150"', ({ isMarketClean: f }) =>
      assert.deepEqual(f(alloc({ total_supply_assets_usd: 0, bad_debt_usd: 100, realized_bad_debt_usd: 50 })).reasons, ['Bad debt detected ($150)'])],
    ['відсутній oracle для ринку із заставою', ({ isMarketClean: f }) =>
      assert.deepEqual(f(alloc({ oracle_address: '' })).reasons, ['Missing oracle contract address'])],
    ['нульова адреса oracle (і у верхньому регістрі) -> брудний', ({ isMarketClean: f }) => {
      assert.equal(f(alloc({ oracle_address: '0x0000000000000000000000000000000000000000' })).isClean, false);
      assert.equal(f(alloc({ oracle_address: '0X0000000000000000000000000000000000000000' })).isClean, false);
    }],
    ['ДЕФЕКТ: oracle "0x" (порожня адреса) має вважатися відсутнім', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ oracle_address: '0x' })).isClean, false)],
    ['відсутній oracle в резерві допустимий', ({ isMarketClean: f }) =>
      assert.equal(f(idle()).isClean, true)],
    ['not_whitelisted YELLOW компрометує ринок', ({ isMarketClean: f }) =>
      assert.equal(f(warn(['not_whitelisted', 'YELLOW'])).isClean, false)],
    ['NOT_WHITELISTED у верхньому регістрі теж компрометує', ({ isMarketClean: f }) =>
      assert.equal(f(warn(['NOT_WHITELISTED', 'YELLOW'])).isClean, false)],
    ['RED bad_debt_unrealized компрометує, і рівень "red" у нижньому регістрі теж', ({ isMarketClean: f }) => {
      const r = f(warn(['bad_debt_unrealized', 'RED']));
      assert.equal(r.isClean, false); assert.deepEqual(r.reasons, ['Critical protocol security warning flagged by Morpho']);
      assert.equal(f(warn(['bad_debt_unrealized', 'red'])).isClean, false);
    }],
    ['RED попередження про ліквідність не компрометує (це ризик виходу, не цілісності)', ({ isMarketClean: f }) => {
      assert.equal(f(warn(['sustained_low_liquidity', 'RED'])).isClean, true);
      assert.equal(f(warn(['low_liquidity', 'RED'])).isClean, true);
    }],
    ['YELLOW попередження (не not_whitelisted) не компрометує', ({ isMarketClean: f }) =>
      assert.equal(f(warn(['unrecognized_collateral_asset', 'YELLOW'])).isClean, true)],
    ['warnings_json як масив (не рядок) теж перевіряється', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ warnings_json: [{ type: 'not_whitelisted', level: 'YELLOW' }] })).isClean, false)],
    ['зіпсований JSON попереджень не кидає виняток і ринок чистий', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ warnings_json: '{bad' })).isClean, true)],
    ['warnings_json "null" не має кидати виняток, ринок чистий', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ warnings_json: 'null' })).isClean, true)],
    ['warnings_json "{}" не має кидати виняток, ринок чистий', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ warnings_json: '{}' })).isClean, true)],
    ['null-елемент у масиві попереджень не має кидати виняток', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ warnings_json: '[null]' })).isClean, true)],
    ['усі чотири порушення -> чотири причини', ({ isMarketClean: f }) => {
      const r = f(alloc({ is_listed: 0, bad_debt_usd: 1e6, oracle_address: '', warnings_json: JSON.stringify([{ type: 'not_whitelisted' }]) }));
      assert.equal(r.isClean, false); assert.equal(r.reasons.length, 4);
    }],
  ],
  calculateMQI: [
    ['нульовий TVL -> 100%, isAllClean', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 0 }), []); assert.equal(r.mqiPercent, 100); assert.equal(r.isAllClean, true);
    }],
    ['нечисловий TVL -> 100%, нуль ринків', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 'abc' }), [dirty(50e6)]); assert.equal(r.mqiPercent, 100); assert.equal(r.totalMarketsCount, 0);
    }],
    ['усі ринки чисті -> 100%', ({ calculateMQI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 50e6 })]);
      assert.equal(r.mqiPercent, 100); assert.equal(r.cleanMarketsCount, 1); assert.equal(r.cleanAssetsUsd, 100e6); assert.equal(r.isAllClean, true);
    }],
    ['половина капіталу в брудному ринку -> 50%', ({ calculateMQI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 50e6 }), alloc({ is_listed: 0, supply_assets_usd: 50e6, market_unique_key: '1:0xbad' })]);
      assert.equal(r.mqiPercent, 50); assert.equal(r.compromisedMarkets.length, 1); assert.equal(r.compromisedMarkets[0].weightPercent, 50);
    }],
    ['10M брудних із 100M (решта нерозподілений кеш) -> 90%, кеш рахується чистим', ({ calculateMQI: f }) => {
      const r = f(vault(), [dirty(10e6, { market_unique_key: '1:0xbad' })]);
      assert.equal(r.mqiPercent, 90); assert.equal(r.cleanAssetsUsd, 90e6); assert.equal(r.compromisedAssetsUsd, 10e6);
      assert.equal(r.isAllClean, false);
      assert.deepEqual(r.compromisedMarkets, [{
        marketUniqueKey: '1:0xbad', collateralSymbol: 'WETH', loanSymbol: 'USDC', supplyAssetsUsd: 10e6, weightPercent: 10,
        reasons: ['Unlisted market (not verified by Morpho)']
      }]);
    }],
    ['брудна позиція рівно на порозі (1% TVL) суттєва -> 99%', ({ calculateMQI: f }) => {
      const r = f(vault(), [dirty(1e6)]); assert.equal(r.mqiPercent, 99); assert.equal(r.compromisedMarkets.length, 1);
    }],
    ['дві брудні по 0.5% TVL разом рівно 1% -> обидві суттєві, 99%', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 1e6 }), [dirty(5e3), dirty(5e3, { market_unique_key: '1:0xbad2' })]);
      assert.equal(r.mqiPercent, 99); assert.equal(r.compromisedMarkets.length, 2); assert.equal(r.compromisedAssetsUsd, 1e4);
    }],
    ['дві брудні по 0.49% TVL (разом 0.98%) -> пил, 100%, рахуються чистими ринками', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 1e6 }), [dirty(4.9e3), dirty(4.9e3, { market_unique_key: '1:0xbad2' })]);
      assert.equal(r.mqiPercent, 100); assert.equal(r.compromisedMarkets.length, 0); assert.equal(r.cleanMarketsCount, 2);
      assert.equal(r.isAllClean, true);
    }],
    ['несуттєвий брудний пил вважається чистим', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 1e9 }), [alloc({ is_listed: 0, supply_assets_usd: 100e3 })]);
      assert.equal(r.mqiPercent, 100); assert.equal(r.compromisedMarkets.length, 0);
    }],
    ['стеля 250K: у vault $1B брудні 250K суттєві, хоча mqiPercent округлюється до 100', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 1e9 }), [dirty(250e3)]);
      assert.equal(r.compromisedMarkets.length, 1); assert.equal(r.mqiPercent, 100); assert.equal(r.isAllClean, false);
    }],
    ['брудна позиція з bad debt у vault $1B не "відмивається" правилом 1%', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 1e9 }), [alloc({ supply_assets_usd: 9.9e6, bad_debt_usd: 5e6 })]);
      assert.equal(r.compromisedMarkets.length, 1); assert.equal(r.mqiPercent, 99);
    }],
    ['алокації більші за TVL: 100M чистих + 100M брудних при TVL 100M -> 50%', ({ calculateMQI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 100e6 }), dirty(100e6)]);
      assert.equal(r.mqiPercent, 50); assert.equal(r.cleanAssetsUsd + r.compromisedAssetsUsd, 200e6);
    }],
    ['cleanMarketsCount не рахує чисті ринки з постачанням < $1', ({ calculateMQI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 0.5 }), alloc({ supply_assets_usd: 1 })]);
      assert.equal(r.cleanMarketsCount, 1); assert.equal(r.totalMarketsCount, 2);
    }],
    ['totalMarketsCount дорівнює кількості алокацій', ({ calculateMQI: f }) =>
      assert.equal(f(vault(), [alloc(), alloc()]).totalMarketsCount, 2)],
    ['інваріант: clean + compromised = max(TVL, сума алокацій), mqi у [0, 100]', ({ calculateMQI: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 30e6 }), dirty(20e6), dirty(0.2e6, { market_unique_key: '1:0xdust' })]);
      assert.equal(r.cleanAssetsUsd + r.compromisedAssetsUsd, 100e6);
      // кумулятивно 20.2M >= 1M, тож і 0.2M-пил стає суттєвим: 79.8%
      assert.equal(r.mqiPercent, 79.8); assert.equal(r.compromisedMarkets.length, 2);
    }],
  ],
};
