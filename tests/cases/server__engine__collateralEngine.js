import assert from 'node:assert/strict';
import { vault, alloc, idle } from '../fixtures.js';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const PRIME = '0x19ebb35279a16207ec4ba82799cc64715065f7f6';
const tok = (address, symbol, usd, over = {}) => alloc({
  market_unique_key: `1:${symbol}`, collateral_asset_address: address, collateral_asset_symbol: symbol, supply_assets_usd: usd, ...over
});
const unknown = (usd, sym = 'NEWCOIN') => tok(`0x${sym.toLowerCase()}`, sym, usd);

export default {
  COLLATERAL_CLASSES: [
    ['є всі класи зі вказаною вагою, UNKNOWN має високу вагу', ({ COLLATERAL_CLASSES: c }) => {
      for (const name of ['FIAT_STABLE', 'ETH', 'BTC', 'SYNTH_USD', 'CREDIT_FUND', 'PT', 'VOLATILE', 'UNKNOWN']) assert.ok(c[name].weight && c[name].label, name);
      assert.equal(c.UNKNOWN.weight, 'high'); assert.equal(c.BTC.weight, 'low'); assert.equal(c.CREDIT_FUND.weight, 'high');
    }],
  ],
  RED_HIGH_SHARE_PERCENT: [['поріг червоного 25%', ({ RED_HIGH_SHARE_PERCENT: v }) => assert.equal(v, 25)]],
  YELLOW_MEDIUM_PLUS_SHARE_PERCENT: [['поріг жовтого 50%', ({ YELLOW_MEDIUM_PLUS_SHARE_PERCENT: v }) => assert.equal(v, 50)]],
  parseMaturity: [
    ['формати 26NOV2026 і 2026/11/26 дають одну дату', ({ parseMaturity: f }) => {
      assert.equal(f('26NOV2026').toISOString().slice(0, 10), '2026-11-26'); assert.equal(f('2026/11/26').toISOString().slice(0, 10), '2026-11-26');
    }],
    ['невідомий формат, невідомий місяць, порожнє -> null', ({ parseMaturity: f }) => {
      assert.equal(f('soon'), null); assert.equal(f('26XXX2026'), null); assert.equal(f(''), null); assert.equal(f(undefined), null);
    }],
  ],
  classOf: [
    ['відомий клас повертається, невідомий і порожній -> UNKNOWN', ({ classOf: f }) => {
      assert.equal(f('ETH'), 'ETH'); assert.equal(f('SAFE'), 'UNKNOWN'); assert.equal(f(undefined), 'UNKNOWN');
    }],
  ],
  describe: [
    ['клас, вага й ефективна вага збігаються; невідомий клас -> UNKNOWN high', ({ describe: f }) => {
      assert.deepEqual(f('BTC'), { class: 'BTC', weight: 'low', effectiveWeight: 'low' });
      assert.equal(f('nonsense').class, 'UNKNOWN'); assert.equal(f('nonsense').weight, 'high');
    }],
  ],
  ptDescription: [
    ['ефективна вага PT - більша з власної (medium) і ваги базового активу', ({ ptDescription: f }) => {
      const now = new Date('2026-10-19');
      assert.equal(f('ETH', null, now).effectiveWeight, 'medium'); assert.equal(f('CREDIT_FUND', null, now).effectiveWeight, 'high');
      assert.equal(f('SYNTH_USD', null, now).effectiveWeight, 'medium');
    }],
    ['погашення: дата в минулому -> matured true, у майбутньому false, без дати null', ({ ptDescription: f }) => {
      const now = new Date('2026-10-19');
      assert.equal(f('ETH', new Date('2026-10-15'), now).matured, true); assert.equal(f('ETH', new Date('2026-12-01'), now).matured, false);
      assert.equal(f('ETH', null, now).matured, null);
    }],
  ],
  classifyCollateral: [
    ['токен з довідника: клас за (мережа, адреса), регістр адреси не важливий', ({ classifyCollateral: f }) => {
      assert.equal(f({ chainId: 1, address: WETH.toUpperCase().replace('0X', '0x'), symbol: 'x' }).class, 'ETH');
      assert.equal(f({ chainId: 1, address: WSTETH, symbol: 'wstETH' }).class, 'ETH'); assert.equal(f({ chainId: 8453, address: CBBTC, symbol: 'cbBTC' }).class, 'BTC');
      assert.equal(f({ chainId: 1, address: PRIME, symbol: 'PRIME' }).class, 'CREDIT_FUND');
    }],
    ['та сама адреса в іншій мережі не успадковує клас', ({ classifyCollateral: f }) =>
      assert.equal(f({ chainId: 137, address: WETH, symbol: 'ZZZ' }).class, 'UNKNOWN')],
    ['підроблений символ без адреси з довідника ніколи не отримує низьку вагу', ({ classifyCollateral: f }) => {
      for (const symbol of ['wstETH', 'WETH', 'cbBTC', 'USDC', 'wstETH2', 'cbBTCx']) {
        const r = f({ chainId: 1, address: '0xfake', symbol });
        assert.notEqual(r.weight, 'low', symbol);
      }
    }],
    ['PT: клас PT, база знаходиться за символом тієї ж мережі, ефективна вага не нижча за базову', ({ classifyCollateral: f }) => {
      const r = f({ chainId: 1, address: '0xnewpt', symbol: 'PT-sUSDE-26NOV2026' }, new Date('2026-10-19'));
      assert.equal(r.class, 'PT'); assert.equal(r.underlyingClass, 'SYNTH_USD'); assert.equal(r.effectiveWeight, 'medium'); assert.equal(r.matured, false);
      assert.equal(f({ chainId: 1, address: '0xnewpt2', symbol: 'PT-reUSD-10DEC2026' }).effectiveWeight, 'high');
      assert.equal(f({ chainId: 1, address: '0xnewpt3', symbol: 'PT-USDG-28MAY2026' }, new Date('2026-10-19')).matured, true);
    }],
    ['правила за символом: Midas m-токен -> кредитний фонд; акція -> волатильні; невідомий символ -> UNKNOWN', ({ classifyCollateral: f }) => {
      assert.equal(f({ chainId: 1, address: '0xm', symbol: 'mNEWFUND' }).class, 'CREDIT_FUND');
      assert.equal(f({ chainId: 1, address: '0xs', symbol: 'TSLAon' }).class, 'VOLATILE');
      assert.equal(f({ chainId: 1, address: '0xn', symbol: 'FOO' }).class, 'UNKNOWN'); assert.equal(f({ chainId: 1, address: '0xn' }).class, 'UNKNOWN');
    }],
    ['джерело класу: address або rule (невідомий символ теж іде через останнє правило)', ({ classifyCollateral: f }) => {
      assert.equal(f({ chainId: 1, address: WETH, symbol: 'WETH' }).source, 'address'); assert.equal(f({ chainId: 1, address: '0xm', symbol: 'mXYZ' }).source, 'rule');
      assert.equal(f({ chainId: 1, address: '0xq', symbol: 'QQQ' }).source, 'rule');
    }],
  ],
  calculateCollateralMix: [
    ['100% WETH: клас ETH, без прапорця', ({ calculateCollateralMix: f }) => {
      const r = f(vault(), [tok(WETH, 'WETH', 100e6)]);
      assert.equal(r.tier, 'CLASSIFIED'); assert.equal(r.level, null); assert.equal(r.topClass, 'ETH'); assert.equal(r.classes[0].percent, 100);
    }],
    ['токени одного класу (WETH + wstETH) зливаються в один клас', ({ calculateCollateralMix: f }) => {
      const r = f(vault(), [tok(WETH, 'WETH', 60e6), tok(WSTETH, 'wstETH', 40e6)]);
      assert.equal(r.classes.length, 1); assert.equal(r.classes[0].class, 'ETH'); assert.equal(r.classes[0].percent, 100);
    }],
    ['25% у класах високої ваги -> RED; 24% -> без прапорця', ({ calculateCollateralMix: f }) => {
      assert.equal(f(vault(), [tok(PRIME, 'PRIME', 25e6), tok(WETH, 'WETH', 75e6)]).level, 'RED');
      assert.equal(f(vault(), [tok(PRIME, 'PRIME', 24e6), tok(WETH, 'WETH', 76e6)]).level, null);
    }],
    ['невідомий токен рахується як висока вага: 30% невідомого -> RED, unknownPercent 30', ({ calculateCollateralMix: f }) => {
      const r = f(vault(), [unknown(30e6), tok(WETH, 'WETH', 70e6)]);
      assert.equal(r.level, 'RED'); assert.equal(r.unknownPercent, 30); assert.equal(r.highPercent, 30);
    }],
    ['без червоного: 50% середніх класів (PT на ETH і PT на синтетичному) -> YELLOW, 49% -> без прапорця', ({ calculateCollateralMix: f }) => {
      const usde = tok('0x4c9edd5852cd905f086c759e8383e09bff1e68b3', 'USDe', 50e6);
      assert.equal(f(vault(), [usde, tok(WETH, 'WETH', 50e6)]).level, 'YELLOW');
      assert.equal(f(vault(), [{ ...usde, supply_assets_usd: 49e6 }, tok(WETH, 'WETH', 51e6)]).level, null);
    }],
    ['PT на кредитному активі важить як високий; PT на ETH - як середній', ({ calculateCollateralMix: f }) => {
      const pt = (symbol, usd) => tok(`0x${symbol}`, symbol, usd);
      assert.equal(f(vault(), [pt('PT-reUSD-10DEC2026', 30e6), tok(WETH, 'WETH', 70e6)]).level, 'RED');
      const eth = f(vault(), [pt('PT-wstETH-26NOV2099', 30e6), tok(WETH, 'WETH', 70e6)]);
      assert.equal(eth.level, null); assert.equal(eth.classes.find(c => c.class === 'PT').percent, 30);
    }],
    ['idle-ринки не є заставою: рахуються окремо, частки від перевіреного капіталу', ({ calculateCollateralMix: f }) => {
      const r = f(vault(), [idle({ supply_assets_usd: 50e6 }), tok(WETH, 'WETH', 50e6)]);
      assert.equal(r.idlePercent, 50); assert.equal(r.classes[0].percent, 50); assert.equal(r.undeployedPercent, 0);
    }],
    ['нерозміщений капітал vault-а видно окремо', ({ calculateCollateralMix: f }) => {
      const r = f(vault(), [tok(WETH, 'WETH', 40e6)]);
      assert.equal(r.undeployedPercent, 60);
    }],
    ['нерозкритий капітал виходить зі знаменника і показується як unverifiedPercent', ({ calculateCollateralMix: f }) => {
      const r = f(vault({ unresolved_exposure_usd: 50e6 }), [tok(PRIME, 'PRIME', 25e6), tok(WETH, 'WETH', 25e6)]);
      assert.equal(r.unverifiedPercent, 50); assert.equal(r.highPercent, 50); assert.equal(r.level, 'RED');
    }],
    ['усе нерозкрито -> tier UNKNOWN без прапорця; порожній vault без застави -> UNALLOCATED', ({ calculateCollateralMix: f }) => {
      const a = f(vault({ unresolved_exposure_usd: 100e6 }), []); assert.equal(a.tier, 'UNKNOWN'); assert.equal(a.level, null);
      const b = f(vault(), [idle({ supply_assets_usd: 100e6 })]); assert.equal(b.tier, 'UNALLOCATED'); assert.equal(b.level, null);
    }],
    ['від\'ємні й нульові суми ігноруються, vault без алокацій не кидає', ({ calculateCollateralMix: f }) => {
      assert.equal(f(vault(), [tok(WETH, 'WETH', -5e6), tok(PRIME, 'PRIME', 0)]).classes.length, 0);
      assert.equal(f(vault({ total_assets_usd: 0 }), []).tier, 'UNKNOWN');
    }],
    ['погашений PT: частка в maturedPtPercent', ({ calculateCollateralMix: f }) => {
      const r = f(vault(), [tok('0xold', 'PT-USDG-28MAY2026', 20e6), tok(WETH, 'WETH', 80e6)]);
      assert.equal(r.maturedPtPercent, 20);
    }],
  ],
  findUnknownCollateral: [
    ['невідомі застави від порога, найбільші першими, відомі й idle пропускаються', ({ findUnknownCollateral: f }) => {
      const rows = [unknown(3e6, 'AAA'), unknown(5e6, 'BBB'), unknown(0.5e6, 'CCC'), tok(WETH, 'WETH', 9e6), idle({ supply_assets_usd: 9e6 })];
      const r = f(rows, 1e6);
      assert.deepEqual(r.map(x => x.symbol), ['BBB', 'AAA']);
    }],
    ['капітал одного токена з кількох ринків сумується', ({ findUnknownCollateral: f }) => {
      const r = f([unknown(0.6e6, 'AAA'), { ...unknown(0.6e6, 'AAA'), market_unique_key: '1:other' }], 1e6);
      assert.equal(r.length, 1); assert.equal(r[0].usd, 1.2e6);
    }],
  ],
  COLLATERAL_MODEL: [['model id', ({ COLLATERAL_MODEL: v }) => assert.equal(v, 'morpho-tags-1')]],
  TAG_RISK: [
    ['every entry has a valid risk and a note', ({ TAG_RISK: t }) => {
      for (const [tag, v] of Object.entries(t)) { assert.ok(['ordinary', 'neutral', 'elevated'].includes(v.risk), tag); assert.ok(v.note, tag); }
      assert.equal(t.rwa.risk, 'elevated'); assert.equal(t.yield.risk, 'neutral'); assert.equal(t.eth.risk, 'ordinary');
    }],
  ],
  tokenState: [
    ['wstETH [yield,lst,eth] is ordinary', ({ tokenState: f }) => assert.deepEqual(f(['yield', 'lst', 'eth']), { state: 'ordinary', reason: null })],
    ['only [yield] is unclassified: no base tag', ({ tokenState: f }) => assert.deepEqual(f(['yield']), { state: 'unclassified', reason: 'no base tag' })],
    ['USDe [stablecoin,usd-pegged,rwa] is elevated', ({ tokenState: f }) => assert.equal(f(['stablecoin', 'usd-pegged', 'rwa']).state, 'elevated')],
    ['[] and null are untagged', ({ tokenState: f }) => {
      assert.deepEqual(f([]), { state: 'unclassified', reason: 'untagged' }); assert.deepEqual(f(null), { state: 'unclassified', reason: 'untagged' });
    }],
    ['unknown tag is unlisted, unless an elevated tag decides first', ({ tokenState: f }) => {
      assert.deepEqual(f(['foo', 'eth']), { state: 'unclassified', reason: 'unlisted:foo' });
      assert.equal(f(['foo', 'rwa']).state, 'elevated');
    }],
  ],
  tagRiskMarkdown: [
    ['one row per tag plus a two-line header', ({ tagRiskMarkdown: f, TAG_RISK: t }) => {
      const lines = f().split('\n');
      assert.equal(lines.length, Object.keys(t).length + 2); assert.ok(lines.some(l => l.startsWith('| `rwa` | elevated')));
    }],
  ],
  calculateTagMix: [
    ['three baskets and overlapping tag shares', ({ calculateTagMix: f }) => {
      const t = (sym, usd, tags) => tok(`0x${sym}`, sym, usd, { collateral_tags_json: JSON.stringify(tags) });
      const r = f(vault({ total_assets_usd: 100e6 }), [
        t('a', 40e6, ['eth', 'lst']), t('b', 30e6, ['stablecoin', 'usd-pegged', 'rwa']), t('c', 10e6, ['eth', 'rwa']), t('d', 20e6, ['yield'])
      ]);
      assert.equal(r.tier, 'CLASSIFIED');
      assert.deepEqual([r.ordinaryPercent, r.elevatedPercent, r.unclassifiedPercent], [40, 40, 20]);
      assert.deepEqual(r.tags.map(x => [x.tag, x.percent]), [['eth', 50], ['rwa', 40], ['stablecoin', 30], ['usd-pegged', 30]]);
      assert.equal(r.tokens[0].symbol, 'a'); assert.equal(r.tokens.find(x => x.symbol === 'd').reason, 'no base tag');
    }],
    ['idle markets are separate, untagged tokens are unclassified, bad JSON is untagged', ({ calculateTagMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6 }), [idle({ supply_assets_usd: 50e6 }), unknown(30e6), tok('0xbad', 'BAD', 20e6, { collateral_tags_json: '{' })]);
      assert.equal(r.idlePercent, 50); assert.equal(r.unclassifiedPercent, 50); assert.equal(r.tokens[0].reason, 'untagged');
    }],
    ['tiers: no capital is UNKNOWN, only idle is UNALLOCATED', ({ calculateTagMix: f }) => {
      assert.equal(f(vault({ total_assets_usd: 0 }), []).tier, 'UNKNOWN');
      assert.equal(f(vault({ total_assets_usd: 10e6 }), [idle({ supply_assets_usd: 10e6 })]).tier, 'UNALLOCATED');
    }],
    ['unverified capital leaves the percent base', ({ calculateTagMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6, unresolved_exposure_usd: 50e6 }), [tok('0xe', 'E', 50e6, { collateral_tags_json: '["eth"]' })]);
      assert.equal(r.unverifiedPercent, 50); assert.equal(r.ordinaryPercent, 100);
    }],
  ],
};
