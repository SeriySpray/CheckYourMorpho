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
    ['bad debt, якого API не повернуло (null), -> ринок не підтверджений, не "без боргу"', ({ isMarketClean: f }) => {
      assert.deepEqual(f(alloc({ bad_debt_usd: null })).reasons, ['Bad debt data not reported']);
      assert.equal(f(alloc({ realized_bad_debt_usd: null })).isClean, false);
    }],
    ['відсутнє поле bad debt у фікстурі (undefined) лишається чистим, 0 теж', ({ isMarketClean: f }) => {
      assert.equal(f(alloc()).isClean, true); assert.equal(f(alloc({ bad_debt_usd: 0, realized_bad_debt_usd: 0 })).isClean, true);
    }],
    ['попередження: null, зіпсований JSON і не масив -> не підтверджено; "[]" -> чисто', ({ isMarketClean: f }) => {
      for (const bad of [null, '{oops', '{"a":1}']) assert.deepEqual(f(alloc({ warnings_json: bad })).reasons, ['Protocol warnings not available']);
      assert.equal(f(alloc({ warnings_json: '[]' })).isClean, true);
    }],
    ['unrealized і realized bad debt сумуються: 6 + 6 при пилі 10 -> брудний, 5 + 4 -> чистий', ({ isMarketClean: f }) => {
      assert.equal(f(alloc({ total_supply_assets_usd: 0, bad_debt_usd: 6, realized_bad_debt_usd: 6 })).isClean, false);
      assert.equal(f(alloc({ total_supply_assets_usd: 0, bad_debt_usd: 5, realized_bad_debt_usd: 4 })).isClean, true);
    }],
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
    ['oracle "0x" (порожня адреса) має вважатися відсутнім', ({ isMarketClean: f }) =>
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
    ['зіпсований JSON попереджень не кидає виняток, але ринок не підтверджений', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ warnings_json: '{bad' })).isClean, false)],
    ['warnings_json "null" не кидає виняток, але ринок не підтверджений', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ warnings_json: 'null' })).isClean, false)],
    ['warnings_json "{}" не кидає виняток, але ринок не підтверджений', ({ isMarketClean: f }) =>
      assert.equal(f(alloc({ warnings_json: '{}' })).isClean, false)],
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
    ['C1: V2 $10M без алокацій, уся сума нерозкрита -> MQI 0, а не 100 (не чистий кеш)', ({ calculateMQI: f }) => {
      const r = f(vault({ version: 'v2', total_assets_usd: 10e6, unresolved_exposure_usd: 10e6 }), []);
      assert.equal(r.mqiPercent, 0); assert.equal(r.isAllClean, false);
      assert.equal(r.cleanAssetsUsd, 0); assert.equal(r.unresolvedAssetsUsd, 10e6); assert.deepEqual(r.compromisedMarkets, []);
    }],
    ['C1: 50M у чистому ринку + 50M нерозкрито -> MQI 50; clean + compromised + unresolved = TVL', ({ calculateMQI: f }) => {
      const r = f(vault({ unresolved_exposure_usd: 50e6 }), [alloc({ supply_assets_usd: 50e6 })]);
      assert.equal(r.mqiPercent, 50); assert.equal(r.cleanAssetsUsd + r.compromisedAssetsUsd + r.unresolvedAssetsUsd, 100e6);
    }],
    ['C1: нерозкрита сума нижче порогу суттєвості (200K із 100M, поріг 250K) рахується чистою, рівно на порозі - ні', ({ calculateMQI: f }) => {
      const below = f(vault({ unresolved_exposure_usd: 200e3 }), []);
      assert.equal(below.mqiPercent, 100); assert.equal(below.unresolvedAssetsUsd, 0); assert.equal(below.isAllClean, true);
      const at = f(vault({ total_assets_usd: 10e6, unresolved_exposure_usd: 100e3 }), []);
      assert.equal(at.mqiPercent, 99); assert.equal(at.isAllClean, false);
    }],
    ['актив без USD-ціни (total_assets > 0, USD 0) -> MQI невідомий (null), не 100%', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 0, total_assets: '1000000' }), []);
      assert.equal(r.mqiPercent, null); assert.equal(r.unpriced, true); assert.equal(r.isAllClean, false);
    }],
    ['справді порожній vault (total_assets 0) лишається 100% і чистим', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 0, total_assets: '0' }), []);
      assert.equal(r.mqiPercent, 100); assert.equal(r.unpriced, false); assert.equal(r.isAllClean, true);
    }],
    ['кумулятивний поріг: брудний 0.9% + нерозкритий 0.9% TVL (разом 1.8%) -> обидва суттєві, не чисто', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 10e6, unresolved_exposure_usd: 90e3 }), [dirty(90e3)]);
      assert.equal(r.compromisedMarkets.length, 1); assert.equal(r.unresolvedAssetsUsd, 90e3); assert.equal(r.isAllClean, false);
    }],
    ['окремо кожен під порогом (0.9% брудного або 0.9% нерозкритого) лишається пилом', ({ calculateMQI: f }) => {
      assert.equal(f(vault({ total_assets_usd: 10e6 }), [dirty(90e3)]).isAllClean, true);
      assert.equal(f(vault({ total_assets_usd: 10e6, unresolved_exposure_usd: 90e3 }), []).isAllClean, true);
    }],
    ['кумулятивний поріг не виводить у список ринок дешевший за $1', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 10e6, unresolved_exposure_usd: 90e3 }), [dirty(90e3), dirty(0.5, { market_unique_key: '1:0xdust' })]);
      assert.equal(r.compromisedMarkets.length, 1); assert.equal(r.compromisedMarkets[0].marketUniqueKey, '1:0xbad90000');
    }],
    ['кумулятивне правило: нерозкритий 300K (поріг 250K) робить суттєвим брудний ринок $1M, але не брудний пил $50', ({ calculateMQI: f }) => {
      const v = vault({ total_assets_usd: 100e6, unresolved_exposure_usd: 300e3 });
      const r = f(v, [dirty(1e6), dirty(50, { market_unique_key: '1:0xdust' })]);
      assert.deepEqual(r.compromisedMarkets.map(m => m.marketUniqueKey), ['1:0xbad1000000']);
      assert.equal(f(v, [dirty(50)]).compromisedMarkets.length, 0);
    }],
    ['кумулятивне правило: брудний $1M не робить суттєвим нерозкритий розрив $240 (нижче 10% порога)', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 100e6, unresolved_exposure_usd: 240 }), [dirty(1e6)]);
      assert.equal(r.compromisedMarkets.length, 1); assert.equal(r.unresolvedAssetsUsd, 0);
    }],
    ['20 брудних ринків по $24K у vault $100M (разом $480K > поріг $250K) усі позначаються, а не відсікаються межею пилу', ({ calculateMQI: f }) => {
      const dirtyList = Array.from({ length: 20 }, (_, i) => dirty(24e3, { market_unique_key: `1:0xd${i}` }));
      const r = f(vault({ total_assets_usd: 100e6 }), dirtyList);
      assert.equal(r.compromisedMarkets.length, 20); assert.equal(r.compromisedAssetsUsd, 480e3); assert.equal(r.isAllClean, false);
    }],
    ['15 брудних по $9.9K у vault $10M (разом 1.5% TVL) позначаються', ({ calculateMQI: f }) => {
      const dirtyList = Array.from({ length: 15 }, (_, i) => dirty(9.9e3, { market_unique_key: `1:0xd${i}` }));
      assert.equal(f(vault({ total_assets_usd: 10e6 }), dirtyList).compromisedMarkets.length, 15);
    }],
    ['нерозкритий $240K + брудний $24.9K у vault $100M: разом вище порога $250K, обидва позначаються', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 100e6, unresolved_exposure_usd: 240e3 }), [dirty(24.9e3)]);
      assert.equal(r.compromisedMarkets.length, 1); assert.equal(r.unresolvedAssetsUsd, 240e3);
    }],
    ['негативне постачання вважається нулем і не робить ринок суттєвим', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 10e6 }), [dirty(-5e6)]);
      assert.equal(r.compromisedMarkets.length, 0); assert.equal(r.compromisedAssetsUsd, 0);
    }],
    ['частки брудного і нерозкритого рахуються від одного знаменника: 100M = 50 чисто + 20 брудно + 30 нерозкрито', ({ calculateMQI: f }) => {
      const r = f(vault({ total_assets_usd: 100e6, unresolved_exposure_usd: 30e6 }), [alloc({ supply_assets_usd: 50e6 }), dirty(20e6)]);
      assert.equal(r.mqiPercent, 50); assert.equal(r.compromisedPercent, 20); assert.equal(r.unresolvedPercent, 30);
      assert.equal(r.effectiveTotalUsd, 100e6); assert.equal(r.compromisedMarkets[0].weightPercent, 20);
    }],
  ],
  isUnpricedVault: [
    ['USD 0 при ненульових активах -> без ціни', ({ isUnpricedVault: f }) => assert.equal(f({ total_assets_usd: 0, total_assets: '5' }), true)],
    ['є USD -> з ціною', ({ isUnpricedVault: f }) => assert.equal(f({ total_assets_usd: 1, total_assets: '5' }), false)],
    ['нуль активів -> не "без ціни", а порожній', ({ isUnpricedVault: f }) => assert.equal(f({ total_assets_usd: 0, total_assets: '0' }), false)],
    ['поля відсутні -> не без ціни', ({ isUnpricedVault: f }) => assert.equal(f({}), false)],
  ],
};
