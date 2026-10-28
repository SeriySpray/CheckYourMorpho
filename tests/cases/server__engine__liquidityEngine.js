import assert from 'node:assert/strict';
import { vault, alloc, idle } from '../fixtures.js';

// Ринок i: наше постачання supply, вільна ліквідність free, постачання vaults-конкурентів peer.
const mkt = (i, supply, free, peer = 0, over = {}) => alloc({
  market_unique_key: `1:0xm${i}`, collateral_asset_address: `0xc${i}`, collateral_asset_symbol: `C${i}`,
  supply_assets_usd: supply, total_supply_assets_usd: Math.max(1e9, free / 0.03), total_borrow_assets_usd: Math.max(1e9, free / 0.03) - free, peer_supply_usd: peer, ...over
});

export default {
  calculateLiquidityMetrics: [
    ['актив без USD-ціни -> вихід невідомий (null), не 100%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ total_assets_usd: 0, total_assets: '1000' }), []);
      assert.equal(r.exitUnknown, true); assert.equal(r.instantExitCapacityPercent, null); assert.equal(r.stressedExitCapacityPercent, null);
    }],
    ['порожній vault (total_assets 0) лишається 100% і відомим', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ total_assets_usd: 0, total_assets: '0' }), []);
      assert.equal(r.exitUnknown, false); assert.equal(r.instantExitCapacityPercent, 100);
    }],
    ['нульовий TVL -> 100% і не crowded', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ total_assets_usd: 0 }), []);
      assert.equal(r.instantExitCapacityPercent, 100); assert.equal(r.stressedExitCapacityPercent, 100);
      assert.equal(r.isCrowded, false); assert.equal(r.isIlliquid, false);
    }],
    ['нечисловий TVL -> 100%', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f(vault({ total_assets_usd: 'abc' }), [mkt(0, 50e6, 0)]).instantExitCapacityPercent, 100)],
    ['camelCase-поля vault теж приймаються', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f({ totalAssetsUsd: 100e6, liquidityUsd: 50e6 }, [mkt(0, 100e6, 30e6)]).instantExitCapacityPercent, 30)],
    ['ринок із повною ліквідністю -> 100% виходу', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f(vault(), [alloc({ supply_assets_usd: 100e6 })]).instantExitCapacityPercent, 100)],
    ['вихід обмежений вільною ліквідністю ринку', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 100e6, total_supply_assets_usd: 200e6, total_borrow_assets_usd: 190e6 })]);
      assert.equal(r.instantExitCapacityPercent, 10); assert.equal(r.isIlliquid, true);
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
    ['резервний ринок не потрапляє в crowdedMarkets', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [idle({ supply_assets_usd: 50e6, peer_supply_usd: 500e6, total_borrow_assets_usd: 1e9 })]);
      assert.deepEqual(r.crowdedMarkets, []);
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
    ['стрес: 50M кешу + 40M вільних, частка проти піра 50/(50+150) -> стресовий 60%, нормальний 90%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [mkt(0, 50e6, 40e6, 150e6)]);
      assert.equal(r.instantExitCapacityPercent, 90); assert.equal(r.stressedExitCapacityPercent, 60);
      assert.equal(r.stressedExitCapacityUsd, 60e6); assert.equal(r.isCrowded, true);
      const m = r.crowdedMarkets[0];
      assert.deepEqual([m.marketUniqueKey, m.vaultSupplyUsd, m.peerSupplyUsd, m.freeLiquidityUsd, m.normalExitUsd, m.stressedExitUsd],
        ['1:0xm0', 50e6, 150e6, 40e6, 40e6, 10e6]);
    }],
    ['стресова частка не перевищує власного постачання: min(10M, 100M*0.5) = 10M', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [mkt(0, 10e6, 100e6, 10e6), mkt(1, 90e6, 0)]);
      assert.equal(r.stressedExitCapacityPercent, 10); assert.equal(r.instantExitCapacityPercent, 10);
    }],
    ['прямі кредитори не розбавляють стресовий вихід: без vaults-конкурентів стрес = норма', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ total_assets_usd: 1e6 }), [mkt(0, 1e6, 10e6, 0)]);
      assert.equal(r.stressedExitCapacityPercent, r.instantExitCapacityPercent); assert.equal(r.isCrowded, false);
    }],
    ['піри рівно дорівнюють вільній ліквідності -> ринок crowded', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f(vault(), [mkt(0, 50e6, 60e6, 60e6)]).crowdedMarkets.length, 1)],
    ['піри менші за вільну ліквідність -> не crowded, навіть при падінні 22.5 п.п.', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [mkt(0, 50e6, 60e6, 59e6)]);
      assert.deepEqual(r.crowdedMarkets, []); assert.equal(r.isCrowded, false);
      assert.ok(r.instantExitCapacityPercent - r.stressedExitCapacityPercent >= 15);
    }],
    ['розбавлення 25% (< 30%) -> не crowded', ({ calculateLiquidityMetrics: f }) =>
      assert.deepEqual(f(vault(), [mkt(0, 60e6, 20e6, 20e6)]).crowdedMarkets, [])],
    ['розбавлення 40% (>= 30%) -> crowded', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f(vault(), [mkt(0, 60e6, 40e6, 40e6)]).crowdedMarkets.length, 1)],
    ['нульова вільна ліквідність і є піри -> crowded, стресовий вихід 0', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [mkt(0, 50e6, 0, 10e6)]);
      assert.equal(r.crowdedMarkets.length, 1); assert.equal(r.crowdedMarkets[0].stressedExitUsd, 0);
    }],
    ['нульова вільна ліквідність без пірів -> не crowded', ({ calculateLiquidityMetrics: f }) =>
      assert.deepEqual(f(vault(), [mkt(0, 50e6, 0, 0)]).crowdedMarkets, [])],
    ['суттєвість: позиція рівно 1% TVL не потрапляє в crowded, 1.5% - потрапляє', ({ calculateLiquidityMetrics: f }) => {
      assert.deepEqual(f(vault(), [mkt(0, 1e6, 1e6, 10e6)]).crowdedMarkets, []);
      assert.equal(f(vault(), [mkt(0, 1.5e6, 1e6, 10e6)]).crowdedMarkets.length, 1);
    }],
    ['crowdedMarkets відсортовані за нашим постачанням за спаданням', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [mkt(0, 10e6, 5e6, 50e6), mkt(1, 30e6, 5e6, 50e6)]);
      assert.deepEqual(r.crowdedMarkets.map(m => m.vaultSupplyUsd), [30e6, 10e6]);
    }],
    ['topPeers: до трьох, формат M/K', ({ calculateLiquidityMetrics: f }) => {
      const peers = [{ vaultName: 'A', supplyUsd: 2.5e6 }, { vaultName: 'B', supplyUsd: 400e3 }, { supplyUsd: 1e6 }, { vaultName: 'D', supplyUsd: 1e6 }];
      const r = f(vault(), [mkt(0, 50e6, 0, 10e6, { peer_vaults: peers })]);
      assert.deepEqual(r.crowdedMarkets[0].topPeers, ['A ($2.5M)', 'B ($400K)', 'Vault ($1.0M)']);
    }],
    ['crowded-ринок з малим падінням (100% -> 98.4%) не робить vault isCrowded', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [mkt(0, 2e6, 2e6, 8e6)]);
      assert.equal(r.crowdedMarkets.length, 1); assert.equal(r.stressedExitCapacityPercent, 98.4); assert.equal(r.isCrowded, false);
    }],
    ['isCrowded через абсолютне падіння: 80% -> 64% (16 п.п., відносне 20%)', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [mkt(0, 60e6, 40e6, 40e6)]);
      assert.equal(r.instantExitCapacityPercent, 80); assert.equal(r.stressedExitCapacityPercent, 64); assert.equal(r.isCrowded, true);
    }],
    ['isCrowded через перехід нижче 10%: 11% -> 9%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [mkt(0, 83e6, 0), mkt(1, 12e6, 6e6, 6e6)]);
      assert.equal(r.instantExitCapacityPercent, 11); assert.equal(r.stressedExitCapacityPercent, 9); assert.equal(r.isCrowded, true);
    }],
    ['isCrowded через відносне падіння рівно 50%: 8% -> 4%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [mkt(0, 92e6, 0), mkt(1, 8e6, 8e6, 8e6)]);
      assert.equal(r.instantExitCapacityPercent, 8); assert.equal(r.stressedExitCapacityPercent, 4); assert.equal(r.isCrowded, true);
    }],
    ['isIlliquid: рівно 20% -> false, 19.9% -> true', ({ calculateLiquidityMetrics: f }) => {
      assert.equal(f(vault(), [mkt(0, 100e6, 20e6)]).isIlliquid, false);
      assert.equal(f(vault(), [mkt(0, 100e6, 19.9e6)]).isIlliquid, true);
    }],
    ['інваріант: 0 <= стресовий <= нормальний <= 100 на змішаному наборі', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [idle({ supply_assets_usd: 5e6 }), mkt(0, 30e6, 10e6, 90e6), mkt(1, 40e6, 100e6, 5e6), mkt(2, 25e6, 0, 3e6)]);
      assert.ok(r.stressedExitCapacityPercent >= 0 && r.stressedExitCapacityPercent <= r.instantExitCapacityPercent && r.instantExitCapacityPercent <= 100);
      // норма: 5 + 10 + 40 + 0 = 55; стрес: 5 + 10*30/120 + min(40, 100*40/45) + 0 = 47.5
      assert.equal(r.instantExitCapacityPercent, 55); assert.equal(r.stressedExitCapacityPercent, 47.5);
    }],
    // Vault без жодної реальної позиції: капітал лежить на контракті і доступний миттєво,
    // обмеження - лише liquidity_usd (V2 завжди, V1 коли API його повідомив).
    ['регрес: V1 без алокацій, ліквідність не обмежує -> 100% (капітал на контракті), а не 0%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), []);
      assert.equal(r.instantExitCapacityPercent, 100); assert.equal(r.stressedExitCapacityPercent, 100);
      assert.equal(r.instantExitCapacityUsd, 100e6); assert.equal(r.directLiquidityUsd, 100e6); assert.equal(r.isIlliquid, false);
    }],
    ['порожній список і рядок із нульовим постачанням дають однаковий вихід: V1/V2 x liquidity_usd 0/30M -> 0/30/0/30', ({ calculateLiquidityMetrics: f }) => {
      const cases = [['v1', 0, 0], ['v1', 30e6, 30], ['v2', 0, 0], ['v2', 30e6, 30]];
      for (const [version, liq, expected] of cases) {
        const v = vault({ version, liquidity_usd: liq });
        for (const allocs of [[], [alloc({ supply_assets_usd: 0 })]]) {
          const r = f(v, allocs);
          const label = `${version}, liquidity ${liq}, рядків ${allocs.length}`;
          assert.equal(r.instantExitCapacityPercent, expected, label); assert.equal(r.stressedExitCapacityPercent, expected, label);
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
      assert.equal(r.instantExitCapacityPercent, 50); assert.equal(r.stressedExitCapacityPercent, 50);
      assert.equal(r.marketExitCapacityUsd, 0); assert.deepEqual(r.crowdedMarkets, []);
    }],
    ['від\'ємний liquidity_usd у V2 -> 0 USD виходу, а не від\'ємна сума; нечисловий у V1 -> невідомо (null)', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ version: 'v2', liquidity_usd: -5e6 }), [mkt(0, 100e6, 500e6)]);
      assert.equal(r.instantExitCapacityUsd, 0); assert.equal(r.stressedExitCapacityUsd, 0); assert.equal(r.instantExitCapacityPercent, 0);
      assert.equal(f(vault({ liquidity_usd: 'abc' }), [mkt(0, 100e6, 500e6)]).instantExitCapacityPercent, null);
    }],
    // C2: null = API не повідомив ліквідність, 0 = справжній нуль
    ['C2: V1 з liquidity_usd 0 (справжній нуль) -> 0%, а не 100%', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ total_assets_usd: 1e6, liquidity_usd: 0 }), [mkt(0, 1e6, 500e6)]);
      assert.equal(r.instantExitCapacityPercent, 0); assert.equal(r.stressedExitCapacityPercent, 0); assert.equal(r.isIlliquid, true);
      assert.equal(r.exitUnknown, false);
    }],
    ['C2: liquidity_usd null/undefined/нечисловий (V1 і V2) -> вихід невідомий (null), а не 100%', ({ calculateLiquidityMetrics: f }) => {
      for (const version of ['v1', 'v2']) for (const liq of [null, undefined, 'abc']) {
        const r = f(vault({ version, liquidity_usd: liq }), [mkt(0, 100e6, 500e6)]);
        const label = `${version}, liquidity ${liq}`;
        assert.equal(r.exitUnknown, true, label);
        assert.deepEqual([r.instantExitCapacityPercent, r.instantExitCapacityUsd, r.stressedExitCapacityPercent, r.stressedExitCapacityUsd, r.isIlliquid, r.isCrowded],
          [null, null, null, null, null, false], label);
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
    ['нерозкрите не знижує stressed exit: ті самі 30 із 60 перевіреного -> stressed рахується від 60M', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ unresolved_exposure_usd: 40e6 }), [mkt(0, 60e6, 30e6, 60e6)]);
      assert.equal(r.instantExitCapacityPercent, 50); assert.equal(r.stressedExitCapacityPercent, 25);
    }],
    ['причина невідомого виходу: не повернуто ліквідність -> not_reported', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ liquidity_usd: null }), [mkt(0, 50e6, 50e6)]);
      assert.equal(r.exitUnknown, true); assert.equal(r.exitUnknownReason, 'not_reported'); assert.equal(r.unverifiedPercent, 0);
    }],
    ['причина невідомого виходу: vault без ціни -> unpriced', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f(vault({ total_assets_usd: 0, total_assets: '5' }), []).exitUnknownReason, 'unpriced')],
  ],
};
