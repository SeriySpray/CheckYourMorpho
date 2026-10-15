import assert from 'node:assert/strict';
import { vault, alloc, diversified } from '../fixtures.js';

const titles = r => r.redFlags.map(x => x.title);
const apyFlag = r => r.redFlags.find(x => x.title.startsWith('Negative Net APY'));

export default {
  generateVaultVerdict: [
    ['здоровий вольт без прапорців', ({ generateVaultVerdict: f }) =>
      assert.deepEqual(f(vault(), diversified()).redFlags, [])],
    ['повертає метадані вольта і summary', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), diversified());
      assert.equal(r.vaultAddress, '0xvault'); assert.equal(r.version, 'v1'); assert.match(r.summary, /^MQI: 100% clean capital/);
    }],
    ['брудний ринок -> CRITICAL Compromised Market Exposure', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [alloc({ is_listed: 0, supply_assets_usd: 50e6 })]);
      assert.equal(r.redFlags.find(x => x.title === 'Compromised Market Exposure').level, 'CRITICAL');
    }],
    ['єдина застава -> Extreme Collateral Concentration', ({ generateVaultVerdict: f }) =>
      assert.ok(titles(f(vault(), [alloc({ supply_assets_usd: 100e6 })])).includes('Extreme Collateral Concentration'))],
    ['низька миттєва ліквідність -> Restricted Exit Liquidity', ({ generateVaultVerdict: f }) =>
      assert.ok(titles(f(vault(), [alloc({ supply_assets_usd: 100e6, total_supply_assets_usd: 200e6, total_borrow_assets_usd: 190e6 })])).includes('Restricted Exit Liquidity'))],
    ['net APY нижче -5% -> CRITICAL', ({ generateVaultVerdict: f }) =>
      assert.equal(apyFlag(f(vault({ net_apy: -0.1 }), diversified())).level, 'CRITICAL')],
    ['net APY -1% -> HIGH', ({ generateVaultVerdict: f }) =>
      assert.equal(apyFlag(f(vault({ net_apy: -0.01 }), diversified())).level, 'HIGH')],
  ],
};
