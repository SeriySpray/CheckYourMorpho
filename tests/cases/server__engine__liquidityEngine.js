import assert from 'node:assert/strict';
import { vault, alloc, idle } from '../fixtures.js';

export default {
  calculateLiquidityMetrics: [
    ['нульовий TVL -> 100% і не crowded', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault({ total_assets_usd: 0 }), []); assert.equal(r.instantExitCapacityPercent, 100); assert.equal(r.isCrowded, false);
    }],
    ['ринок із повною ліквідністю -> 100% виходу', ({ calculateLiquidityMetrics: f }) =>
      assert.equal(f(vault(), [alloc({ supply_assets_usd: 100e6 })]).instantExitCapacityPercent, 100)],
    ['вихід обмежений вільною ліквідністю ринку', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 100e6, total_supply_assets_usd: 200e6, total_borrow_assets_usd: 190e6 })]);
      assert.equal(r.instantExitCapacityPercent, 10);
    }],
    ['конкуренція піров знижує стресовий вихід', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 50e6, total_supply_assets_usd: 300e6, total_borrow_assets_usd: 260e6, peer_supply_usd: 150e6 })]);
      assert.ok(r.stressedExitCapacityPercent < r.instantExitCapacityPercent);
      assert.equal(r.isCrowded, true);
    }],
    ['резервний ринок не потрапляє в crowdedMarkets', ({ calculateLiquidityMetrics: f }) => {
      const r = f(vault(), [idle({ supply_assets_usd: 50e6 })]);
      assert.deepEqual(r.crowdedMarkets, []);
    }],
  ],
};
