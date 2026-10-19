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
    ['актив без USD-ціни: немає й Restricted Exit Liquidity з "Only null%" (null < 20 у JS true)', ({ generateVaultVerdict: f }) => {
      for (const liquidity_usd of [null, 0, 5]) {
        const r = f(vault({ total_assets_usd: 0, total_assets: '1000000', liquidity_usd }), []);
        assert.equal(flag(r, 'Restricted Exit Liquidity'), undefined);
        assert.ok(!r.redFlags.some(x => x.message.includes('null%')));
      }
    }],
    ['актив без USD-ціни: немає окремого Unknown Exit Liquidity з хибною причиною "not reported"', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ total_assets_usd: 0, total_assets: '1000000' }), []);
      assert.equal(flag(r, 'Unknown Exit Liquidity'), undefined);
    }],
    ['актив без USD-ціни -> прапорець Unpriced Vault, MQI та вихід unknown, жодного "100% clean"', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ total_assets_usd: 0, total_assets: '1000000' }), []);
      assert.equal(flag(r, 'Unpriced Vault').level, 'HIGH');
      assert.match(r.summary, /MQI: unknown \(no USD price\)/); assert.match(r.summary, /Exit Liquidity: unknown/);
      assert.doesNotMatch(r.summary, /100%/);
    }],
    ['брудне і нерозкрите в одному вердикті рахуються від спільного знаменника (20% і 30% зі 100M)', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ unresolved_exposure_usd: 30e6 }), [alloc({ supply_assets_usd: 50e6 }), alloc({ is_listed: 0, supply_assets_usd: 20e6, market_unique_key: '1:0xbad' })]);
      assert.match(flag(r, 'Compromised Market Exposure').message, /^20% of capital .*\(20% TVL\)/);
      assert.match(flag(r, 'Unresolved Exposure').message, /^30% of capital/);
    }],
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
    // Частка crowded рахується від TVL (vault capital); 10M нерозподіленого кешу розводять TVL і розподілений капітал (90M).
    ['HIGH crowded: 40M із TVL 100M (90M розподілено), 50% -> 20% -> текст "40% of vault capital", не "allocated"', ({ generateVaultVerdict: f }) => {
      // норма: 10 + 40 = 50; стрес: 10 + 40*40/160 = 20; падіння 30; частка 40/100 = 40 (від розподіленого було б 44.4)
      const r = f(vault(), [mkt(0, 40e6, 40e6, 120e6), mkt(1, 50e6, 0)]);
      assert.equal(crowdLevel(r), 'HIGH');
      assert.match(flag(r, 'Elevated Crowded Exit Contagion').message, /from 50% to 20% across 40% of vault capital during/);
      assert.doesNotMatch(flag(r, 'Elevated Crowded Exit Contagion').message, /allocated/);
    }],
    ['поріг частки з кешем: 15M із TVL 100M, 25% -> 11.5% -> HIGH, "15% of vault capital"', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [mkt(0, 15e6, 15e6, 135e6), mkt(1, 75e6, 0)]);
      assert.equal(crowdLevel(r), 'HIGH'); assert.match(flag(r, 'Elevated Crowded Exit Contagion').message, /across 15% of vault capital/);
    }],
    ['до порогу з кешем: 14M із TVL 100M (14%, від розподілених 90M було б 15.6%) -> без прапорця crowded', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [mkt(0, 14e6, 14e6, 126e6), mkt(1, 76e6, 0)]);
      assert.equal(r.liquidity.stressedExitCapacityPercent, 11.4); assert.equal(crowdLevel(r), null);
    }],
    ['CRITICAL crowded з кешем: 40M із TVL 100M, 50% -> 14% -> "(40% of vault capital in heavily contested markets)"', ({ generateVaultVerdict: f }) => {
      // стрес: 10 + 40*40/400 = 14
      const r = f(vault(), [mkt(0, 40e6, 40e6, 360e6), mkt(1, 50e6, 0)]);
      assert.equal(crowdLevel(r), 'CRITICAL');
      assert.match(flag(r, 'Critical Crowded Exit Deficit').message, /from 50% to 14% \(40% of vault capital in heavily contested markets\)\.$/);
    }],
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
    ['C1: V2 $10M без алокацій із нерозкритою експозицією -> HIGH Unresolved Exposure, MQI 0, вихід 0', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ version: 'v2', total_assets_usd: 10e6, liquidity_usd: 10e6, unresolved_exposure_usd: 10e6 }), []);
      const x = flag(r, 'Unresolved Exposure');
      assert.equal(x.level, 'HIGH'); assert.match(x.message, /^100% of capital \(\$10\.00M\) /);
      assert.equal(r.mqi.mqiPercent, 0); assert.equal(r.mqi.isAllClean, false);
      assert.equal(r.liquidity.instantExitCapacityPercent, 0);
    }],
    ['C1: нерозкрита експозиція нижче порогу суттєвості -> без прапорця', ({ generateVaultVerdict: f }) =>
      assert.equal(flag(f(vault({ unresolved_exposure_usd: 200e3 }), diversified()), 'Unresolved Exposure'), undefined)],
    ['C2: невідома ліквідність -> MEDIUM Unknown Exit Liquidity, summary "unknown", без "Only null%"', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ liquidity_usd: null }), diversified());
      assert.equal(flag(r, 'Unknown Exit Liquidity').level, 'MEDIUM');
      assert.equal(flag(r, 'Restricted Exit Liquidity'), undefined);
      assert.match(r.summary, /Exit Liquidity: unknown\.$/);
    }],
    ['C2: невідома ліквідність і crowded-ринок -> без crowded-прапорців з null у тексті', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ liquidity_usd: null }), crowd(30e6, 30e6, 90e6));
      assert.equal(crowdLevel(r), null); assert.ok(r.redFlags.every(x => !/null/.test(x.message)));
    }],
  ],
};
