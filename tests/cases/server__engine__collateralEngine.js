import assert from 'node:assert/strict';
import { vault, alloc, idle } from '../fixtures.js';

const token = (sym, usd, over = {}) => alloc({
  market_unique_key: `1:${sym}`, collateral_asset_address: `0x${sym}`, collateral_asset_symbol: sym, supply_assets_usd: usd, ...over
});

export default {
  parseTagsJson: [
    ['an array is returned; null, the string null, objects and garbage give null', ({ parseTagsJson: f }) => {
      assert.deepEqual(f('["eth","lst"]'), ['eth', 'lst']);
      for (const v of [null, undefined, 'null', '{"a":1}', '{', '']) assert.equal(f(v), null);
    }],
  ],
  calculateCollateralMix: [
    ['shares per token, biggest first', ({ calculateCollateralMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6 }), [token('a', 30e6), token('b', 50e6), token('c', 20e6)]);
      assert.equal(r.tier, 'ALLOCATED');
      assert.deepEqual(r.tokens.map(t => [t.symbol, t.percent, t.usd]), [['b', 50, 50e6], ['a', 30, 30e6], ['c', 20, 20e6]]);
      assert.deepEqual(r.tokens[0], { chainId: 1, address: '0xb', symbol: 'b', usd: 50e6, percent: 50 });
    }],
    ['allocations of one token are merged, with their shares summed', ({ calculateCollateralMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6 }), [token('a', 30e6, { market_unique_key: '1:m1' }), token('a', 20e6, { market_unique_key: '1:m2' })]);
      assert.equal(r.tokens.length, 1); assert.deepEqual([r.tokens[0].usd, r.tokens[0].percent], [50e6, 50]);
    }],
    ['idle markets are separate; undeployed capital is reported', ({ calculateCollateralMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6 }), [idle({ supply_assets_usd: 50e6 }), token('a', 30e6)]);
      assert.deepEqual([r.idlePercent, r.undeployedPercent, r.tokens.length], [50, 20, 1]);
    }],
    ['no capital is UNKNOWN, only idle is UNALLOCATED', ({ calculateCollateralMix: f }) => {
      assert.equal(f(vault({ total_assets_usd: 0 }), []).tier, 'UNKNOWN');
      assert.equal(f(vault({ total_assets_usd: 10e6 }), [idle({ supply_assets_usd: 10e6 })]).tier, 'UNALLOCATED');
    }],
    ['unverified capital leaves the percent base', ({ calculateCollateralMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6, unresolved_exposure_usd: 50e6 }), [token('e', 50e6)]);
      assert.equal(r.unverifiedPercent, 50); assert.equal(r.tokens[0].percent, 100);
    }],
    ['zero or invalid supply is ignored', ({ calculateCollateralMix: f }) => {
      const r = f(vault({ total_assets_usd: 10e6 }), [alloc({ supply_assets_usd: 0 }), alloc({ supply_assets_usd: 'x' }), alloc({ supply_assets_usd: 10e6 })]);
      assert.equal(r.tokens.length, 1);
      assert.equal(f(vault(), undefined).tier, 'UNALLOCATED');
    }],
  ],
};
