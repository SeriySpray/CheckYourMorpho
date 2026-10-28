import assert from 'node:assert/strict';
import { vault, alloc, diversified } from '../fixtures.js';

const titles = r => r.redFlags.map(x => x.title);
const flag = (r, title) => r.redFlags.find(x => x.title === title);
const apyFlag = r => r.redFlags.find(x => x.title.startsWith('Negative Net APY'));

const mkt = (i, supply, free) => alloc({
  market_unique_key: `1:0xm${i}`, collateral_asset_address: `0xc${i}`, collateral_asset_symbol: `C${i}`,
  supply_assets_usd: supply, total_supply_assets_usd: Math.max(1e9, free / 0.03), total_borrow_assets_usd: Math.max(1e9, free / 0.03) - free
});

export default {
  generateVaultVerdict: [
    ['дрібний нерозкритий капітал ($200K із $100M) однаково враховується в MQI, HHI і виході, але не дає червоного прапорця', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ total_assets_usd: 100e6, unresolved_exposure_usd: 200e3 }), []);
      assert.equal(r.mqi.unverifiedPercent, 0.2); assert.equal(r.hhi.unverifiedPercent, 0.2); assert.equal(r.liquidity.unverifiedPercent, 0.2);
      assert.equal(flag(r, 'Unresolved Exposure'), undefined);
      const big = f(vault({ total_assets_usd: 100e6, unresolved_exposure_usd: 30e6 }), []);
      assert.equal(big.hhi.unverifiedPercent, 30); assert.equal(big.liquidity.unverifiedPercent, 30);
    }],
    ['MQI поряд з брудним ринком не округлюється до 100, малий відсоток не стає 0', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ total_assets_usd: 10e9 }), [alloc({ is_listed: 0, supply_assets_usd: 250e3, market_unique_key: '1:0xbad' })]);
      assert.equal(r.mqi.mqiPercent, 99.9);
      assert.ok(!flag(r, 'Compromised Market Exposure').message.startsWith('0%'));
    }],
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
      assert.match(r.summary, /^MQI: 100% of capital has no defect found\. Exit Liquidity: 100%\.$/);
    }],
    ['vault без активної застави -> summary без застав', ({ generateVaultVerdict: f }) =>
      assert.match(f(vault({ liquidity_usd: 100e6 }), []).summary, /^MQI: .*\. Exit Liquidity: 100%\.$/)],
    ['брудний ринок -> CRITICAL Compromised Market Exposure', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [alloc({ is_listed: 0, supply_assets_usd: 50e6 })]);
      assert.equal(flag(r, 'Compromised Market Exposure').level, 'CRITICAL');
    }],
    ['частка брудного капіталу в повідомленні: 1.25M із 100M -> "1.25%"', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [...diversified().slice(0, 9), alloc({ is_listed: 0, supply_assets_usd: 1.25e6, market_unique_key: '1:0xbad', collateral_asset_symbol: 'BAD' })]);
      assert.match(flag(r, 'Compromised Market Exposure').message, /^1\.25% of capital .*BAD\/USDC \([\d.]+% TVL\): Unlisted market/);
    }],
    ['мала, але суттєва брудна позиція у vault $10B дає CRITICAL, а MQI 99.9, не 100%', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ total_assets_usd: 10e9 }), [alloc({ supply_assets_usd: 300e3, bad_debt_usd: 1e6 })]);
      assert.equal(r.mqi.mqiPercent, 99.9);
      assert.equal(flag(r, 'Compromised Market Exposure').level, 'CRITICAL');
    }],
    ['брудні $145 у vault $112K: MQI знижується (99.9), але червоного прапорця немає (нижче суттєвості)', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ total_assets_usd: 112e3 }), [alloc({ is_listed: 0, supply_assets_usd: 145 })]);
      assert.equal(r.mqi.mqiPercent, 99.9); assert.equal(r.mqi.compromisedMarkets.length, 1);
      assert.equal(flag(r, 'Compromised Market Exposure'), undefined);
    }],
    ["п'ять рівних застав -> жодного прапорця застав", ({ generateVaultVerdict: f }) =>
      assert.deepEqual(f(vault(), diversified().slice(0, 5).map(a => ({ ...a, supply_assets_usd: 20e6 }))).redFlags, [])],
    ['вердикт містить розбивку застав за токенами без жодної оцінки токена', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 100e6 })]);
      assert.equal(r.collateral.tier, 'ALLOCATED'); assert.deepEqual(r.collateral.tokens.map(t => [t.symbol, t.percent]), [['WETH', 100]]);
      assert.deepEqual(Object.keys(r.collateral).sort(), ['idlePercent', 'tier', 'tokens', 'undeployedPercent', 'unverifiedPercent']);
    }],
    ['вихід нижче 5% -> MEDIUM Restricted Exit Liquidity з сумою у $K або $M', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 100e6, total_supply_assets_usd: 200e6, total_borrow_assets_usd: 196e6 })]);
      const x = flag(r, 'Restricted Exit Liquidity');
      assert.equal(x.level, 'MEDIUM'); assert.match(x.message, /^Only 4% \(\$4\.00M\)/);
      const tiny = f(vault({ total_assets_usd: 178e3 }), [mkt(0, 178e3, 2.5e3)]);
      assert.match(flag(tiny, 'Restricted Exit Liquidity').message, /^Only 1\.4% \(\$2\.5K\)/);
    }],
    ['межа: рівно 5% -> без прапорця, 4.9% -> є; великий vault з 4.9% теж', ({ generateVaultVerdict: f }) => {
      const small = vault({ total_assets_usd: 50e6 });
      assert.ok(!titles(f(small, [mkt(0, 50e6, 2.5e6)])).includes('Restricted Exit Liquidity'));
      assert.ok(titles(f(small, [mkt(0, 50e6, 2.45e6)])).includes('Restricted Exit Liquidity'));
      assert.ok(titles(f(vault(), [mkt(0, 100e6, 4.9e6)])).includes('Restricted Exit Liquidity'));
    }],
    ['10-20% виходу це норма: без прапорця; пил (TVL до $10K) теж без прапорця', ({ generateVaultVerdict: f }) => {
      assert.ok(!titles(f(vault(), [mkt(0, 100e6, 15e6)])).includes('Restricted Exit Liquidity'));
      assert.ok(!titles(f(vault({ total_assets_usd: 5e3 }), [mkt(0, 5e3, 0)])).includes('Restricted Exit Liquidity'));
    }],
    ['net APY нижче -5% при негативному валовому -> CRITICAL', ({ generateVaultVerdict: f }) =>
      assert.equal(apyFlag(f(vault({ net_apy: -0.1, apy: -0.08 }), diversified())).level, 'CRITICAL')],
    ['net APY рівно -5% -> HIGH (межа не включно)', ({ generateVaultVerdict: f }) =>
      assert.equal(apyFlag(f(vault({ net_apy: -0.05, apy: -0.04 }), diversified())).level, 'HIGH')],
    ['net APY -1% при негативному валовому -> HIGH з "-1.00%" і словами про збитки', ({ generateVaultVerdict: f }) => {
      const x = apyFlag(f(vault({ net_apy: -0.01, apy: -0.005 }), diversified()));
      assert.equal(x.level, 'HIGH'); assert.match(x.message, /-1\.00%/); assert.match(x.message, /gross yield itself is negative/);
    }],
    ['мінус через плату за управління (валовий дохід вище нуля): MEDIUM, причина названа, без слів про bad debt і втрату капіталу', ({ generateVaultVerdict: f }) => {
      const x = apyFlag(f(vault({ apy: 0.00036645, net_apy: -0.00013360, management_fee: 0.0005 }), diversified()));
      assert.equal(x.level, 'MEDIUM'); assert.match(x.message, /gross yield of 0\.04% is below the 0\.05% management fee/); assert.doesNotMatch(x.message, /bad debt|principal|decay/i);
      assert.equal(apyFlag(f(vault({ apy: 0.01, net_apy: -0.02, management_fee: 0.03 }), diversified())).level, 'HIGH', 'fees above 1% of the yield stay HIGH');
    }],
    ['net APY рівно 0 або нечисловий -> без прапорця APY', ({ generateVaultVerdict: f }) => {
      assert.equal(apyFlag(f(vault({ net_apy: 0 }), diversified())), undefined);
      assert.equal(apyFlag(f(vault({ net_apy: 'abc' }), diversified())), undefined);
    }],
    ['ринок без даних: MEDIUM Unverified Markets, MQI за перевіреною частиною, summary показує частку непідтвердженого', ({ generateVaultVerdict: f }) => {
      const r = f(vault(), [alloc({ supply_assets_usd: 50e6 }), alloc({ supply_assets_usd: 50e6, bad_debt_usd: null, market_unique_key: '1:0xnodata', collateral_asset_symbol: 'ABC' })]);
      assert.equal(flag(r, 'Unverified Markets').level, 'MEDIUM');
      assert.equal(flag(r, 'Compromised Market Exposure'), undefined);
      assert.equal(r.mqi.mqiPercent, 100);
      assert.match(r.summary, /MQI: 100% of the checked capital has no defect found \(50% of capital unchecked\)/);
    }],
    ['частково нерозкрито: summary та Restricted Exit позначають "перевіреного капіталу"', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ unresolved_exposure_usd: 40e6 }), [alloc({ supply_assets_usd: 60e6, total_supply_assets_usd: 100e6, total_borrow_assets_usd: 99e6, collateral_asset_address: '0xc0' })]);
      assert.match(r.summary, /Exit Liquidity: [\d.]+% of verified capital/);
      assert.match(flag(r, 'Restricted Exit Liquidity').message, /of the verified deposits/);
    }],
    ['нічого перевірити (усе нерозкрите): MQI null, summary "not available", а не 0 і не 100', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ unresolved_exposure_usd: 100e6 }), []);
      assert.equal(r.mqi.mqiPercent, null); assert.match(r.summary, /MQI: not available \(no capital could be verified\)/);
    }],
    ['C1: V2 $10M без алокацій із нерозкритою експозицією -> HIGH Unresolved Exposure, MQI null, вихід 0', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ version: 'v2', total_assets_usd: 10e6, liquidity_usd: 10e6, unresolved_exposure_usd: 10e6 }), []);
      const x = flag(r, 'Unresolved Exposure');
      assert.equal(x.level, 'HIGH'); assert.match(x.message, /^100% of capital \(\$10\.00M\) /);
      assert.equal(r.mqi.mqiPercent, null); assert.equal(r.mqi.isAllClean, false);
      assert.equal(r.liquidity.instantExitCapacityPercent, null); assert.equal(r.liquidity.exitUnknownReason, 'unresolved');
      assert.equal(flag(r, 'Unknown Exit Liquidity'), undefined); // the Unresolved Exposure flag already carries the reason
      assert.equal(r.hhi.tier, 'UNKNOWN'); assert.equal(r.collateral.tier, 'UNKNOWN'); assert.match(r.summary, /Exit Liquidity: unknown/);
    }],
    ['C1: нерозкрита експозиція нижче порогу суттєвості -> без прапорця', ({ generateVaultVerdict: f }) =>
      assert.equal(flag(f(vault({ unresolved_exposure_usd: 200e3 }), diversified()), 'Unresolved Exposure'), undefined)],
    ['C2: невідома ліквідність -> MEDIUM Unknown Exit Liquidity, summary "unknown", без "Only null%"', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ liquidity_usd: null }), diversified());
      assert.equal(flag(r, 'Unknown Exit Liquidity').level, 'MEDIUM');
      assert.equal(flag(r, 'Restricted Exit Liquidity'), undefined);
      assert.match(r.summary, /Exit Liquidity: unknown\.$/);
    }],
    ['C2: невідома ліквідність -> без "null" у тексті прапорців', ({ generateVaultVerdict: f }) => {
      const r = f(vault({ liquidity_usd: null }), [mkt(0, 30e6, 30e6)]);
      assert.ok(r.redFlags.every(x => !/null/.test(x.message)));
    }],
  ],
};
