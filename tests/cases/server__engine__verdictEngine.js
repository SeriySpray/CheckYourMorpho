import assert from 'node:assert/strict';
import { vault, alloc, diversified } from '../fixtures.js';

const titles = r => r.redFlags.map(x => x.title);
const flag = (r, title) => r.redFlags.find(x => x.title === title);
const apyFlag = r => r.redFlags.find(x => x.title.startsWith('Negative Net APY'));
const crowdLevel = r => (flag(r, 'Critical Crowded Exit Deficit') ? 'CRITICAL' : flag(r, 'Elevated Crowded Exit Contagion') ? 'HIGH' : null);

const mkt = (i, supply, free, peer = 0) => alloc({
  market_unique_key: `1:0xm${i}`, collateral_asset_address: `0xc${i}`, collateral_asset_symbol: `C${i}`,
  supply_assets_usd: supply, total_supply_assets_usd: 1e9, total_borrow_assets_usd: 1e9 - free, peer_supply_usd: peer
});
// Vault 100M: crowded-ринок (S, F вільних, P пірів) + решта TVL у неліквідному ринку без пірів (не crowded).
// Тоді норма = min(S, F)/TVL, стрес = F*S/(S+P)/TVL, частка crowded = S/TVL.
const crowd = (S, F, P) => (S < 100e6 ? [mkt(0, S, F, P), mkt(1, 100e6 - S, 0)] : [mkt(0, S, F, P)]);

export default {
  generateVaultVerdict: [
    ['здоровий vault без прапорців', ({ generateVaultVerdict: f }) =>
      assert.deepEqual(f(vault(), diversified()).redFlags, [])],
    ['повертає метадані vault і точний summary', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), diversified());
      assert.equal(r.vaultAddress, '0xvault'); assert.equal(r.vaultName, 'Test Vault'); assert.equal(r.version, 'v1'); assert.equal(r.chainId, 1);
      assert.equal(r.summary, 'MQI: 100% clean capital. Concentration HHI: 0.1 (High Diversification, top: C0 10%). Exit Liquidity: 100%.');
    }],
    ['vault без активної застави -> summary "Concentration: N/A"', ({ generateVaultVerdict: f }) =>
      assert.match(f(vault({ liquidity_usd: 100e6 }), []).summary, /Concentration: N\/A\. Exit Liquidity: 100%\.$/)],
    ['брудний ринок -> CRITICAL Compromised Market Exposure', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [alloc({ is_listed: 0, supply_assets_usd: 50e6 })]);
      assert.equal(flag(r, 'Compromised Market Exposure').level, 'CRITICAL');
    }],
    ['частка брудного капіталу в повідомленні: 1.25M із 100M -> "1.25%"', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [...diversified().slice(0, 9), alloc({ is_listed: 0, supply_assets_usd: 1.25e6, market_unique_key: '1:0xbad', collateral_asset_symbol: 'BAD' })]);
      assert.match(flag(r, 'Compromised Market Exposure').message, /^1\.25% of capital .*BAD\/USDC \([\d.]+% TVL\): Unlisted market/);
    }],
    ['мала, але суттєва брудна позиція у vault $10B дає CRITICAL, хоча MQI округлюється до 100%', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ total_assets_usd: 10e9 }), [alloc({ supply_assets_usd: 300e3, bad_debt_usd: 1e6 })]);
      assert.equal(r.mqi.mqiPercent, 100);
      assert.equal(flag(r, 'Compromised Market Exposure').level, 'CRITICAL');
    }],
    ['єдина застава -> HIGH Extreme Collateral Concentration', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 100e6 })]);
      assert.equal(flag(r, 'Extreme Collateral Concentration').level, 'HIGH');
      assert.ok(!titles(r).includes('Elevated Collateral Concentration'));
    }],
    ['дві рівні застави (CONCENTRATED) -> MEDIUM Elevated Collateral Concentration', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [mkt(0, 50e6, 500e6), mkt(1, 50e6, 500e6)]);
      assert.equal(flag(r, 'Elevated Collateral Concentration').level, 'MEDIUM');
      assert.ok(!titles(r).includes('Extreme Collateral Concentration'));
    }],
    ['п\'ять рівних застав (MODERATE) -> жодного прапорця концентрації', ({ generateVaultVerdict: f }) =>
      assert.deepEqual(f(vault(), [0, 1, 2, 3, 4].map(i => mkt(i, 20e6, 500e6))).redFlags, [])],
    ['низька миттєва ліквідність -> HIGH Restricted Exit Liquidity з сумою', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 100e6, total_supply_assets_usd: 200e6, total_borrow_assets_usd: 190e6 })]);
      const x = flag(r, 'Restricted Exit Liquidity');
      assert.equal(x.level, 'HIGH'); assert.match(x.message, /^Only 10% \(\$10\.00M\)/);
    }],
    ['миттєвий вихід рівно 20% -> без Restricted, 19.9% -> є', ({ generateVaultVerdict: f }) => {
      assert.ok(!titles(f(vault(), [mkt(0, 100e6, 20e6)])).includes('Restricted Exit Liquidity'));
      assert.ok(titles(f(vault(), [mkt(0, 100e6, 19.9e6)])).includes('Restricted Exit Liquidity'));
    }],
    ['crowded: 30% капіталу, 30% -> 7.5% -> CRITICAL (стрес < 15, падіння >= 15, норма >= 20)', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), crowd(30e6, 30e6, 90e6));
      assert.equal(r.liquidity.stressedExitCapacityPercent, 7.5); assert.equal(crowdLevel(r), 'CRITICAL');
    }],
    ['crowded: падіння рівно 15 п.п. (25% -> 10%) -> CRITICAL', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), crowd(100e6, 25e6, 150e6));
      assert.equal(r.liquidity.stressedExitCapacityPercent, 10); assert.equal(crowdLevel(r), 'CRITICAL');
    }],
    ['crowded: норма рівно 20% при частці 20% (20% -> 5%) -> CRITICAL', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), crowd(20e6, 20e6, 60e6));
      assert.equal(r.liquidity.instantExitCapacityPercent, 20); assert.equal(crowdLevel(r), 'CRITICAL');
    }],
    ['crowded: норма 19% і частка 20% (< 25) -> лише HIGH', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), crowd(20e6, 19e6, 180e6));
      assert.equal(r.liquidity.stressedExitCapacityPercent, 1.9); assert.equal(crowdLevel(r), 'HIGH');
    }],
    ['crowded: норма 19% і частка рівно 25% -> CRITICAL', ({ generateVaultVerdict: f }) =>
      assert.equal(crowdLevel(f(vault(), crowd(25e6, 19e6, 225e6))), 'CRITICAL')],
    ['crowded: стрес 17% (>= 15) при частці 34% (< 35) -> HIGH, не CRITICAL', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), crowd(34e6, 34e6, 34e6));
      assert.equal(r.liquidity.stressedExitCapacityPercent, 17); assert.equal(crowdLevel(r), 'HIGH');
    }],
    ['crowded: частка 40% (>= 35), падіння 24, стрес 16% (< 20) -> CRITICAL', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), crowd(40e6, 40e6, 60e6));
      assert.equal(r.liquidity.stressedExitCapacityPercent, 16); assert.equal(crowdLevel(r), 'CRITICAL');
    }],
    ['crowded: стрес рівно 20% (50% -> 20%) -> HIGH, не CRITICAL', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), crowd(100e6, 50e6, 150e6));
      assert.equal(r.liquidity.stressedExitCapacityPercent, 20); assert.equal(crowdLevel(r), 'HIGH');
    }],
    ['crowded: 60% -> 30% (стрес < 35, падіння >= 20) -> HIGH', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), crowd(100e6, 60e6, 100e6));
      assert.equal(r.liquidity.stressedExitCapacityPercent, 30); assert.equal(crowdLevel(r), 'HIGH');
    }],
    ['crowded: 80% -> 40% (стрес >= 35) -> без прапорця, але summary показує worst-case', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), crowd(100e6, 80e6, 100e6));
      assert.equal(crowdLevel(r), null); assert.equal(r.liquidity.isCrowded, true);
      assert.match(r.summary, /Exit Liquidity: 80% \(worst-case: 40%\)\.$/);
    }],
    ['crowded: частка рівно 15% (15% -> 1.5%, падіння 13.5) -> HIGH', ({ generateVaultVerdict: f }) =>
      assert.equal(crowdLevel(f(vault(), crowd(15e6, 15e6, 135e6))), 'HIGH')],
    ['crowded: частка 14% (< 15) -> без прапорця crowded', ({ generateVaultVerdict: f }) =>
      assert.equal(crowdLevel(f(vault(), crowd(14e6, 14e6, 126e6))), null)],
    ['не crowded vault -> summary без worst-case', ({ generateVaultVerdict: f }) =>
      assert.doesNotMatch(f(vault(), [mkt(0, 100e6, 20e6)]).summary, /worst-case/)],
    ['net APY нижче -5% -> CRITICAL', ({ generateVaultVerdict: f }) =>
      assert.equal(apyFlag(f(vault({ net_apy: -0.1 }), diversified())).level, 'CRITICAL')],
    ['net APY рівно -5% -> HIGH (межа не включно)', ({ generateVaultVerdict: f }) =>
      assert.equal(apyFlag(f(vault({ net_apy: -0.05 }), diversified())).level, 'HIGH')],
    ['net APY -1% -> HIGH з "-1.00%" у повідомленні', ({ generateVaultVerdict: f }) => {
      const x = apyFlag(f(vault({ net_apy: -0.01 }), diversified()));
      assert.equal(x.level, 'HIGH'); assert.match(x.message, /-1\.00%/);
    }],
    ['net APY рівно 0 або нечисловий -> без прапорця APY', ({ generateVaultVerdict: f }) => {
      assert.equal(apyFlag(f(vault({ net_apy: 0 }), diversified())), undefined);
      assert.equal(apyFlag(f(vault({ net_apy: 'abc' }), diversified())), undefined);
    }],
  ],
};
