import assert from 'node:assert/strict';
import { vault, alloc, idle } from '../fixtures.js';

// Ринок i: наше постачання supply, вільна ліквідність free.
const mkt = (i, supply, free, over = {}) => alloc({
  market_unique_key: `1:0xm${i}`, collateral_asset_address: `0xc${i}`, collateral_asset_symbol: `C${i}`,
  supply_assets_usd: supply, total_supply_assets_usd: Math.max(1e9, free / 0.03), total_borrow_assets_usd: Math.max(1e9, free / 0.03) - free, ...over
});

export default {
  calculateLiquidityMetrics: [
    ['актив без USD-ціни -> вихід невідомий (null), не 100%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ total_assets_usd: 0, total_assets: '1000' }), []);
      assert.equal(r.exitUnknown, true); assert.equal(r.instantExitCapacityPercent, null);
    }],
    ['порожній vault (total_assets 0) лишається 100% і відомим', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ total_assets_usd: 0, total_assets: '0' }), []);
      assert.equal(r.exitUnknown, false); assert.equal(r.instantExitCapacityPercent, 100);
    }],
    ['нульовий TVL -> 100% виходу', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ total_assets_usd: 0 }), []);
      assert.equal(r.instantExitCapacityPercent, 100); assert.equal(r.isIlliquid, false);
    }],
    ['нечисловий TVL -> 100%', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f(vault({ total_assets_usd: 'abc' }), [mkt(0, 50e6, 0)]).instantExitCapacityPercent, 100)],
    ['camelCase-поля vault теж приймаються', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f({ totalAssetsUsd: 100e6, liquidityUsd: 50e6 }, [mkt(0, 100e6, 30e6)]).instantExitCapacityPercent, 30)],
    ['ринок із повною ліквідністю -> 100% виходу', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f(vault(), [alloc({ supply_assets_usd: 100e6 })]).instantExitCapacityPercent, 100)],
    ['вихід обмежений вільною ліквідністю ринку', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 100e6, total_supply_assets_usd: 200e6, total_borrow_assets_usd: 190e6 })]);
      assert.equal(r.instantExitCapacityPercent, 10); assert.equal(r.isIlliquid, false);
    }],
    ['формула: 40M кешу + min(60M, 30M вільних) = 70%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [mkt(0, 60e6, 30e6)]);
      assert.equal(r.instantExitCapacityPercent, 70); assert.equal(r.instantExitCapacityUsd, 70e6);
      assert.equal(r.marketExitCapacityUsd, 30e6); assert.equal(r.directLiquidityUsd, 40e6);
    }],
    ['вихід з ринку обмежений власним постачанням: 10M у ліквідному + 90M у неліквідному -> 10%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [mkt(0, 10e6, 500e6), mkt(1, 90e6, 0)]);
      assert.equal(r.instantExitCapacityPercent, 10); assert.equal(r.marketExitCapacityUsd, 10e6);
    }],
    ['позики більші за постачання ринку: вільна ліквідність 0, а не від\'ємна -> лишається 50% кешу', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 50e6, total_supply_assets_usd: 1e6, total_borrow_assets_usd: 60e6 })]);
      assert.equal(r.instantExitCapacityPercent, 50); assert.equal(r.marketExitCapacityUsd, 0);
    }],
    ['резервний ринок рахується як кеш: 50M резерв + 50M неліквідний ринок -> 50%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [idle({ supply_assets_usd: 50e6 }), mkt(1, 50e6, 0)]);
      assert.equal(r.instantExitCapacityPercent, 50); assert.equal(r.directLiquidityUsd, 50e6);
    }],
    ['порожні алокації: вихід = liquidity_usd vault (30M -> 30%)', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f(vault({ liquidity_usd: 30e6 }), []).instantExitCapacityPercent, 30)],
    ['порожні алокації: liquidity_usd більший за TVL обрізається до 100%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ liquidity_usd: 200e6 }), []);
      assert.equal(r.instantExitCapacityPercent, 100); assert.equal(r.instantExitCapacityUsd, 100e6);
    }],
    ['V2: вихід обмежений liquidity_usd vault (200K із 1M -> 20%)', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f(vault({ version: 'v2', total_assets_usd: 1e6, liquidity_usd: 200e3 }), [mkt(0, 1e6, 500e6)]).instantExitCapacityPercent, 20)],
    ['V2 з liquidity_usd 0 і алокаціями -> 0% (нічого не можна вивести зараз)', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ version: 'v2', liquidity_usd: 0 }), [mkt(0, 100e6, 500e6)]);
      assert.equal(r.instantExitCapacityPercent, 0); assert.equal(r.isIlliquid, true);
    }],
    ['V1 обмежується повідомленим liquidity_usd (200K -> 20%, справжній 0 -> 0%)', ({ calculateLiquidityMetrics: f }) => {
      assert.equal(f(vault({ total_assets_usd: 1e6, liquidity_usd: 200e3 }), [mkt(0, 1e6, 500e6)]).instantExitCapacityPercent, 20);
      assert.equal(f(vault({ total_assets_usd: 1e6, liquidity_usd: 0 }), [mkt(0, 1e6, 500e6)]).instantExitCapacityPercent, 0);
    }],
    ['спільна ліквідність: ринок, де vault має менше 90% пропозиції і вільна ліквідність обмежує вихід, рахується у sharedExitPercent', ({ calculateLiquidityMetrics: f }) => {
      const m = (supply, total, borrow) => alloc({ market_unique_key: '1:0xs', collateral_asset_address: '0xcs', collateral_asset_symbol: 'CS', supply_assets_usd: supply, total_supply_assets_usd: total, total_borrow_assets_usd: borrow });
      const shared = f(vault({ total_assets_usd: 100e6 }), [m(100e6, 400e6, 360e6)]);
      assert.deepEqual([shared.instantExitCapacityPercent, shared.sharedExitPercent, shared.sharedMarkets], [40, 100, 1]);
      assert.equal(shared.proportionalExitPercent, 10, 'free 40M split by supply 100 of 400');
      const own = f(vault({ total_assets_usd: 100e6 }), [m(100e6, 105e6, 65e6)]);
      assert.deepEqual([own.instantExitCapacityPercent, own.sharedExitPercent, own.sharedMarkets], [40, 13, 1], 'the others supplied 5M of the 40M');
      const sole = f(vault({ total_assets_usd: 100e6 }), [m(100e6, 100e6, 60e6)]);
      assert.deepEqual([sole.sharedExitPercent, sole.sharedMarkets, sole.proportionalExitPercent], [0, 0, 40], 'nobody else supplies the market');
      const roomy = f(vault({ total_assets_usd: 100e6 }), [m(100e6, 400e6, 0)]);
      assert.deepEqual([roomy.instantExitCapacityPercent, roomy.sharedExitPercent], [100, 100], 'free cash 400M: others could still take 300M of the vault 100M');
      const capped = f(vault({ total_assets_usd: 100e6, version: 'v2', liquidity_usd: 20e6 }), [m(100e6, 400e6, 360e6)]);
      assert.deepEqual([capped.instantExitCapacityPercent, capped.sharedExitPercent], [20, 100], 'the cap shrinks both the exit and the shared part');
      const none = f(vault({ total_assets_usd: 100e6, liquidity_usd: null }), [m(100e6, 400e6, 360e6)]);
      assert.equal(none.sharedExitPercent, null);
    }],
    ['isIlliquid: рівно 5% -> false, 4.9% -> true', ({ calculateLiquidityMetrics: f }) => {
      assert.equal(f(vault(), [mkt(0, 100e6, 5e6)]).isIlliquid, false);
      assert.equal(f(vault(), [mkt(0, 100e6, 4.9e6)]).isIlliquid, true);
    }],
    // Vault без жодної реальної позиції: капітал лежить на контракті і доступний миттєво,
    // обмеження - лише liquidity_usd (V2 завжди, V1 коли API його повідомив).
    ['регрес: V1 без алокацій, ліквідність не обмежує -> 100% (капітал на контракті), а не 0%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), []);
      assert.equal(r.instantExitCapacityPercent, 100);
      assert.equal(r.instantExitCapacityUsd, 100e6); assert.equal(r.directLiquidityUsd, 100e6); assert.equal(r.isIlliquid, false);
    }],
    ['порожній список і рядок із нульовим постачанням дають однаковий вихід: V1/V2 x liquidity_usd 0/30M -> 0/30/0/30', ({ calculateLiquidityMetrics: f }) => {
      const cases = [['v1', 0, 0], ['v1', 30e6, 30], ['v2', 0, 0], ['v2', 30e6, 30]];
      for (const [version, liq, expected] of cases) {
        const v = vault({ version, liquidity_usd: liq });
        for (const allocs of [[], [alloc({ supply_assets_usd: 0 })]]) {
          const r = f(v, allocs);
          const label = `${version}, liquidity ${liq}, рядків ${allocs.length}`;
          assert.equal(r.instantExitCapacityPercent, expected, label);
        }
      }
    }],
    ['без алокацій із liquidity_usd 30M: миттєвий вихід 30M, а directLiquidityUsd = 100M капіталу на контракті', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ liquidity_usd: 30e6 }), []);
      assert.equal(r.instantExitCapacityUsd, 30e6); assert.equal(r.directLiquidityUsd, 100e6);
    }],
    ['межа "немає позиції": 0 USD у неліквідному ринку -> 100%, 1 USD -> 100% (99.999999 округлюється), 50M -> 50%', ({ calculateLiquidityMetrics: f }) => {
      assert.equal(f(vault(), [mkt(0, 0, 0)]).instantExitCapacityPercent, 100);
      assert.equal(f(vault(), [mkt(0, 1, 0)]).instantExitCapacityPercent, 100);
      assert.equal(f(vault(), [mkt(0, 50e6, 0)]).instantExitCapacityPercent, 50);
    }],
    ['від\'ємне постачання рахується як 0: стресовий вихід не падає нижче нормального (50% і 50%, а не 50% і 0%)', ({ calculateLiquidityMetrics: f }) => {
      // ринок 0: -50M -> 0; ринок 1: 50M без ліквідності; на контракті 100 - 50 = 50M
      const r = f(vault(), [mkt(0, -50e6, 100e6, 100e6), mkt(1, 50e6, 0)]);
      assert.equal(r.instantExitCapacityPercent, 50);
      assert.equal(r.marketExitCapacityUsd, 0);
    }],
    ['від\'ємний liquidity_usd у V2 -> 0 USD виходу, а не від\'ємна сума; нечисловий у V1 -> невідомо (null)', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ version: 'v2', liquidity_usd: -5e6 }), [mkt(0, 100e6, 500e6)]);
      assert.equal(r.instantExitCapacityUsd, 0); assert.equal(r.instantExitCapacityPercent, 0);
      assert.equal(f(vault({ liquidity_usd: 'abc' }), [mkt(0, 100e6, 500e6)]).instantExitCapacityPercent, null);
    }],
    // C2: null = API не повідомив ліквідність, 0 = справжній нуль
    ['C2: V1 з liquidity_usd 0 (справжній нуль) -> 0%, а не 100%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ total_assets_usd: 1e6, liquidity_usd: 0 }), [mkt(0, 1e6, 500e6)]);
      assert.equal(r.instantExitCapacityPercent, 0); assert.equal(r.isIlliquid, true);
      assert.equal(r.exitUnknown, false);
    }],
    ['C2: liquidity_usd null/undefined/нечисловий (V1 і V2) -> вихід невідомий (null), а не 100%', ({ calculateLiquidityMetrics: f }) => {
      for (const version of ['v1', 'v2']) for (const liq of [null, undefined, 'abc']) {
        const r = f(vault({ version, liquidity_usd: liq }), [mkt(0, 100e6, 500e6)]);
        const label = `${version}, liquidity ${liq}`;
        assert.equal(r.exitUnknown, true, label);
        assert.deepEqual([r.instantExitCapacityPercent, r.instantExitCapacityUsd, r.isIlliquid], [null, null, null], label);
        assert.equal(r.marketExitCapacityUsd, 100e6, label);
      }
    }],
    // C1: нерозкрита експозиція V2-адаптерів не є кешем на контракті
    ['C1: V2 10M без алокацій, уся сума в нерозв\'язаному адаптері -> вихід невідомий (null), а не 100% і не 0%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ version: 'v2', total_assets_usd: 10e6, liquidity_usd: 10e6, unresolved_exposure_usd: 10e6 }), []);
      assert.equal(r.instantExitCapacityPercent, null); assert.equal(r.exitUnknown, true);
      assert.equal(r.exitUnknownReason, 'unresolved'); assert.equal(r.unverifiedPercent, 100); assert.equal(r.directLiquidityUsd, 0);
    }],
    ['C1: 40M нерозкрито + 60M у ринку з 30M вільних -> 50% від перевіреної частини (кешу на контракті 0), 40% непідтверджено', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ unresolved_exposure_usd: 40e6 }), [mkt(0, 60e6, 30e6)]);
      assert.equal(r.instantExitCapacityPercent, 50); assert.equal(r.instantExitCapacityUsd, 30e6);
      assert.equal(r.unverifiedPercent, 40); assert.equal(r.directLiquidityUsd, 0); assert.equal(r.exitUnknown, false);
    }],
    ['причина невідомого виходу: не повернуто ліквідність -> not_reported', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ liquidity_usd: null }), [mkt(0, 50e6, 50e6)]);
      assert.equal(r.exitUnknown, true); assert.equal(r.exitUnknownReason, 'not_reported'); assert.equal(r.unverifiedPercent, 0);
    }],
    ['причина невідомого виходу: vault без ціни -> unpriced', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f(vault({ total_assets_usd: 0, total_assets: '5' }), []).exitUnknownReason, 'unpriced')],
  ],
};
