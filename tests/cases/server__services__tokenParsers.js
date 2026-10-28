import assert from 'node:assert/strict';
import fs from 'node:fs';

// Real responses saved from the public sources (tests/data/collector)
const dir = new URL('../data/collector/', import.meta.url);
const text = name => fs.readFileSync(new URL(name, dir), 'utf8');
const fx = name => JSON.parse(text(name));
const SUSDE = 'ethereum:0x9D39A5DE30e57443BfF2A8307A4256c8797A3497';
const PT = '0xb253eff1104802b97ac7e3ac9fdd73aece295a2c';

export default {
  MORPHO_BLUE: [['the singleton address in lower case', ({ MORPHO_BLUE: m }) => assert.equal(m, '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb')]],
  PROTOCOL_NAME_RE: [['pool and protocol names from real holder lists match; plain names and treasuries do not', ({ PROTOCOL_NAME_RE: re }) => {
    for (const n of ['StakedUSDeOFTAdapter', 'PendleSUSDESY', 'RedemptionVault', 'CurveStableSwapNG', 'Morpho', 'UniswapV3Pool', 'BalancerVault', 'L1StandardBridge', 'InitializableImmutableAdminUpgradeabilityProxy', 'MErc20Delegator', 'DolomiteMargin', 'Volatile AMM - YFI/wstETH', 'Staked USDe']) assert.ok(re.test(n), n);
    for (const n of ['OlympusTreasury', 'TransparentUpgradeableProxy', 'GnosisSafeProxy', '']) assert.ok(!re.test(n), n);
  }]],
  num: [['numbers and numeric strings pass, everything else is null', ({ num: f }) => {
    assert.equal(f(1.5), 1.5); assert.equal(f('42'), 42); assert.equal(f('0'), 0);
    for (const bad of [null, undefined, '', 'abc', NaN, Infinity, true, {}, []]) assert.equal(f(bad), null, String(bad));
  }]],
  cleanText: [
    ['strips tags and control characters, collapses spaces, cuts to the limit', ({ cleanText: f }) => {
      assert.equal(f('  <b>Staked</b>\n\tUSDe\u0007  '), 'Staked USDe');
      assert.equal(f('x'.repeat(500)).length, 300); assert.equal(f('abcdef', 3), 'abc');
    }],
    ['empty, null and objects give null', ({ cleanText: f }) => { for (const v of ['', '   ', null, undefined, {}, []]) assert.equal(f(v), null); assert.equal(f(0), '0'); }]
  ],
  parseJson: [['valid JSON is parsed, anything else is null', ({ parseJson: f }) => { assert.deepEqual(f('{"a":1}'), { a: 1 }); assert.equal(f('<html>'), null); assert.equal(f(''), null); }]],

  parseSourcify: [
    ['a non-proxy contract (sUSDe)', ({ parseSourcify: f }) => {
      const r = f(fx('sourcify_susde.json'));
      assert.deepEqual([r.contract_name, r.sourcify_match, r.is_proxy, r.proxy_type, r.implementations, r.deployer], ['StakedUSDeV2', 'exact_match', false, null, [], '0x8de54b1cefedeab1766b947c7d9a9963436e8fae']);
      assert.ok(Array.isArray(r.abi) && r.abi.length > 10);
    }],
    ['a proxy lists its implementation (cbBTC on Base)', ({ parseSourcify: f }) => {
      const r = f(fx('sourcify_cbbtc_base.json'));
      assert.deepEqual([r.contract_name, r.is_proxy, r.proxy_type], ['FiatTokenProxy', true, 'ZeppelinOSProxy']);
      assert.deepEqual(r.implementations, [{ address: '0x7458bfdc30034eb860b265e6068121d18fa5aa72', name: 'FiatTokenV2_1' }]);
    }],
    ['an error body, null and junk give null', ({ parseSourcify: f }) => { for (const v of [{ customCode: 'x', message: 'bad' }, null, 'x', []]) assert.equal(f(v), null); }]
  ],
  parseAbiFlags: [
    ['sUSDe: blacklist, owner, roles, permit and ERC-4626; mint stays false because mint is the user deposit there', ({ parseAbiFlags: f }) => {
      const abi = fx('sourcify_susde.json').abi;
      assert.deepEqual(f(abi), { mint: false, burn: false, pause: false, blacklist: true, freeze: false, upgrade: false, owner: true, roles: true, erc4626: true, permit: true });
    }],
    ['a proxy ABI has upgrade and admin functions', ({ parseAbiFlags: f }) => {
      const r = f(fx('sourcify_cbbtc_base.json').abi);
      assert.equal(r.upgrade, true); assert.equal(r.owner, true); assert.equal(r.mint, false);
    }],
    ['flags of the proxy and the implementation are merged', ({ parseAbiFlags: f }) => {
      const r = f([{ name: 'upgradeTo' }], [{ name: 'mint' }, { name: 'blacklist' }, { name: 'pause' }, { name: 'burn' }, { name: 'freeze' }]);
      assert.deepEqual([r.upgrade, r.mint, r.blacklist, r.pause, r.burn, r.freeze], [true, true, true, true, true, true]);
    }],
    ['with no ABI every flag is null', ({ parseAbiFlags: f }) => {
      for (const r of [f(), f(null, null), f(undefined)]) assert.ok(Object.values(r).every(v => v === null) && Object.keys(r).length === 10);
    }],
    ['with an empty ABI every flag is false', ({ parseAbiFlags: f }) => assert.ok(Object.values(f([])).every(v => v === false))]
  ],

  parseBlockscoutToken: [
    ['sUSDe token record', ({ parseBlockscoutToken: f }) => {
      const r = f(fx('blockscout_token_susde.json'));
      assert.deepEqual([r.name, r.symbol, r.decimals, r.token_type, r.holders_count, r.reputation], ['Ethena Staked USDe', 'SUSDE', 18, 'ERC-20', 11748, 'ok']);
      assert.equal(r.total_supply, '949498109855597571967773552'); assert.equal(r.market_cap_usd, 1191097704.58742);
    }],
    ['a bad decimals value or supply is null; junk gives null', ({ parseBlockscoutToken: f }) => {
      const r = f({ address_hash: '0x1', decimals: '99', total_supply: 'abc', holders_count: null });
      assert.deepEqual([r.decimals, r.total_supply, r.holders_count], [null, null, null]);
      for (const v of [null, {}, 'x']) assert.equal(f(v), null);
    }]
  ],
  parseBlockscoutAddress: [
    ['sUSDe address record', ({ parseBlockscoutAddress: f }) => {
      const r = f(fx('blockscout_address_susde.json'));
      assert.deepEqual([r.address, r.name, r.is_contract, r.verified, r.proxy_type, r.implementations], ['0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', 'Staked USDe', true, true, null, []]);
      assert.equal(r.creator, '0x8de54b1cefedeab1766b947c7d9a9963436e8fae'); assert.equal(r.creation_tx, '0x9b099ba3c8e64ea8904cc6de83f2245e309e0f91c3ce1f976328b601e4dda314');
    }],
    ['implementations are read from address_hash and a bad tx hash is dropped', ({ parseBlockscoutAddress: f }) => {
      const r = f({ hash: '0x1', creation_transaction_hash: 'nope', implementations: [{ address_hash: '0x' + 'A'.repeat(40), name: 'Impl' }, { address_hash: 'bad' }] });
      assert.equal(r.creation_tx, null); assert.deepEqual(r.implementations, [{ address: '0x' + 'a'.repeat(40), name: 'Impl' }]);
      assert.equal(f({}), null);
    }]
  ],
  parseBlockscoutCounters: [['holders count, null for junk', ({ parseBlockscoutCounters: f }) => { assert.equal(f(fx('blockscout_counters_susde.json')), 11748); assert.equal(f(null), null); assert.equal(f({}), null); }]],
  parseCreationTx: [['ISO time of the transaction, null for junk', ({ parseCreationTx: f }) => { assert.equal(f(fx('blockscout_tx_creation.json')), '2023-11-14T16:32:47.000Z'); assert.equal(f({ timestamp: 'x' }), null); assert.equal(f(null), null); }]],
  parseHolders: [
    ['shares of the supply for the top holders, Morpho Blue found by address', ({ parseHolders: f }) => {
      const r = f(fx('blockscout_holders_susde.json'), '949498109855597571967773552');
      assert.equal(r.top1_pct, 26.402); assert.equal(r.top10_pct, 72.97); assert.equal(r.top10_contracts, 7); assert.equal(r.morpho_blue_pct, 9.816);
      assert.equal(r.top.length, 5); assert.equal(r.top[0].name, 'StakedUSDeOFTAdapter');
    }],
    ['Morpho Blue is found at the address of the token chain (Robinhood Chain), not only at the Ethereum one', ({ parseHolders: f }) => {
      const blue = '0x9d53d5e3bd5e8d4cbfa6db1ca238aea02e651010';
      const j = { items: [{ address: { hash: blue, name: 'Morpho', is_contract: true }, value: '99' }, { address: { hash: '0x' + '1'.repeat(40), is_contract: false }, value: '1' }] };
      assert.equal(f(j, '100', 4663).morpho_blue_pct, 99); assert.equal(f(j, '100', 1).morpho_blue_pct, 0);
      assert.equal(f(j, '100').morpho_blue_pct, 0, 'unknown chain falls back to the Ethereum address');
    }],
    ['without a supply the shares are null', ({ parseHolders: f }) => {
      const r = f(fx('blockscout_holders_susde.json'), null);
      assert.deepEqual([r.top1_pct, r.top10_pct, r.morpho_blue_pct], [null, null, null]); assert.ok(r.top10_contracts > 0);
    }],
    ['shares without Morpho Blue and contracts named as a pool or protocol (adapter, Pendle SY, vault, Curve)', ({ parseHolders: f }) => {
      const r = f(fx('blockscout_holders_susde.json'), '949498109855597571967773552');
      assert.equal(r.top1_nonprotocol_pct, 11.786, 'the first own holder is the EOA behind StakedUSDeOFTAdapter');
      assert.equal(r.top10_nonprotocol_pct, 23.531, 'the Aave aToken proxy (InitializableImmutableAdminUpgradeabilityProxy, 10.3%) is left out too'); assert.ok(r.top10_nonprotocol_pct < r.top10_pct);
      const a = n => ({ hash: '0x' + String(n).repeat(40) });
      const only = f({ items: [{ address: { ...a(1), name: 'Uniswap V3 Pool', is_contract: true }, value: '60' }, { address: { ...a(2), name: 'Pool', is_contract: false }, value: '40' }] }, '100');
      assert.deepEqual([only.top1_pct, only.top1_nonprotocol_pct, only.top10_nonprotocol_pct], [60, 40, 40], 'a pool name on an EOA does not make it a protocol');
      assert.equal(f({ items: [{ address: { hash: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', is_contract: true }, value: '5' }] }, '10').top1_nonprotocol_pct, null);
    }],
    ['a share is cut to 100 and an empty list gives null counts', ({ parseHolders: f }) => {
      const r = f({ items: [{ address: { hash: '0x' + '1'.repeat(40), is_contract: false }, value: '500' }] }, '100');
      assert.equal(r.top1_pct, 100); assert.equal(r.morpho_blue_pct, 0);
      const e = f({ items: [] }, '100'); assert.deepEqual([e.top1_pct, e.top10_pct, e.top10_contracts, e.morpho_blue_pct], [null, null, null, null]);
      assert.equal(f(null, '1'), null); assert.equal(f({}, '1'), null);
    }]
  ],

  parseLlamaPrice: [['price, confidence and time by coin key; null when there is no price', ({ parseLlamaPrice: f }) => {
    assert.deepEqual(f(fx('llama_price_susde.json'), SUSDE), { usd: 1.2537625656596842, confidence: 1, price_ts: 1792661098, decimals: 18, symbol: 'sUSDe' });
    assert.equal(f({ coins: {} }, SUSDE), null); assert.equal(f(null, SUSDE), null);
  }]],
  parseLlamaChart: [['min, max, last and range of the 30 daily prices', ({ parseLlamaChart: f }) => {
    const r = f(fx('llama_chart_susde.json'), SUSDE);
    assert.equal(r.count, 30); assert.equal(r.min, 1.2490834217781712); assert.equal(r.range_pct, 0.375); assert.ok(r.last >= r.min && r.last <= r.max);
    assert.equal(f({ coins: {} }, SUSDE), null); assert.equal(f({ coins: { [SUSDE]: { prices: [] } } }, SUSDE), null);
  }]],

  parseGeckoInfo: [['holders, top-10 share, websites and score', ({ parseGeckoInfo: f }) => {
    assert.deepEqual(f(fx('gecko_info_susde.json')), { holders_count: 11714, top10_pct: 72.9719, websites: ['https://app.ethena.fi'], gt_score: 90.47619047619048 });
    assert.equal(f({ data: {} }), null); assert.equal(f(null), null);
  }], ['a top-10 share above 100 (seen: 560768 for a PT) or below 0 is junk and becomes null', ({ parseGeckoInfo: f }) => {
    const g = pct => f({ data: { attributes: { address: '0x1', holders: { count: 5, distribution_percentage: { top_10: pct } } } } }).top10_pct;
    assert.deepEqual([g('560768.5973'), g('101.1'), g('-1'), g('100'), g('0')], [null, null, null, 100, 0]);
  }]],
  parseGeckoPools: [['pools sorted by reserve with totals; at most 5 are kept', ({ parseGeckoPools: f }) => {
    const r = f(fx('gecko_pools_susde.json'));
    assert.equal(r.pools_count, 3); assert.equal(r.pools[0].dex, 'curve'); assert.equal(r.pools[0].reserve_usd, 60652431.7235);
    assert.ok(r.pools[0].reserve_usd >= r.pools[1].reserve_usd); assert.equal(r.total_reserve_usd, Math.round(r.pools.reduce((s, p) => s + p.reserve_usd, 0) * 100) / 100);
    const many = f({ data: Array.from({ length: 8 }, (_, i) => ({ attributes: { reserve_in_usd: String(i) } })) }); assert.equal(many.pools.length, 5); assert.equal(many.pools_count, 8);
    assert.equal(f({}), null); assert.equal(f(null), null);
  }]],

  parseKyber: [
    ['a real quote: impact against the requested size (an output above the request is 0, not negative); Kyber\'s own input value kept apart', ({ parseKyber: f }) => {
      const r = f(200, fx('kyber_susde_100k.json'), 100000);
      assert.deepEqual([r.status, r.price_impact_pct, r.out_usd, r.kyber_in_usd], ['ok', 0, 100028.32, 100077.79]);
      assert.deepEqual(r.dexes, ['uniswap-v4', 'metric-propamm/fluid-dex-t1']);
    }],
    ['a thin pool: the impact follows from the requested size, not from Kyber\'s own input value', ({ parseKyber: f }) => {
      const r = f(200, fx('kyber_noroute.json'), 100000);
      assert.equal(r.price_impact_pct, 89.572); assert.equal(r.kyber_in_usd, 68961.49, 'Kyber priced the input at 69K: 1 - out/in would say 84.9%');
      assert.equal(f(200, fx('kyber_noroute.json'), 10427.69).price_impact_pct, 0);
      assert.deepEqual([f(200, fx('kyber_noroute.json')).status, f(200, fx('kyber_noroute.json')).reason], ['error', 'no requested size']);
    }],
    ['a real HTTP 400 "route not found" is no_route with the code and message as the reason', ({ parseKyber: f }) => {
      const r = f(400, fx('kyber_400_route_not_found.json'), 100000);
      assert.deepEqual([r.status, r.reason, r.price_impact_pct, r.out_usd], ['no_route', '4008 route not found', null, null]);
    }],
    ['token not found is no_route; a bad request is an error with the field violation; no body keeps the HTTP code', ({ parseKyber: f }) => {
      assert.deepEqual([f(400, { code: 4011, message: 'token not found', details: null }, 1).status, f(400, { code: 4011, message: 'token not found' }, 1).reason], ['no_route', '4011 token not found']);
      const bad = f(400, { code: 4000, message: 'bad request', details: [{ fieldViolations: [{ field: 'tokenIn', description: 'identical with tokenOut' }] }] }, 1);
      assert.deepEqual([bad.status, bad.reason], ['error', '4000 bad request tokenIn identical with tokenOut']);
      assert.deepEqual([f(400, { code: 4009, message: 'amountIn is greater than max allowed' }, 1).status], ['error']);
      assert.ok(f(400, { code: 1, message: 'x'.repeat(500) }, 1).reason.length <= 120);
      assert.deepEqual([f(500, null, 1).status, f(500, null, 1).reason], ['error', 'HTTP 500']); assert.equal(f(0, null, 1).reason, 'no response');
      assert.equal(f(404, null, 1).status, 'no_route'); assert.equal(f(200, { data: {} }, 1).status, 'error');
      assert.equal(f(200, { data: { routeSummary: { amountInUsd: '0', amountOutUsd: '0' } } }, 1).status, 'no_route');
    }],
    ['a route with output but no USD value for it is an error, not a 100% impact', ({ parseKyber: f }) => {
      const r = f(200, { data: { routeSummary: { amountIn: '1239406155', amountOut: '959165120000', amountInUsd: '0', amountOutUsd: '0' } } }, 1000000);
      assert.deepEqual([r.status, r.price_impact_pct, r.reason], ['error', null, 'output has no USD value']);
    }]
  ],

  parseReadContract: [
    ['sUSDe page: zero-argument views only', ({ parseReadContract: f }) => {
      const r = f(text('readcontract_susde.html'));
      assert.equal(r.owner, '0xE8Dc0Fab349EA169283C48Ccfd09d797E6DB7c94'); assert.equal(r.cooldownDuration, '86400'); assert.equal(r.symbol, 'sUSDe');
      assert.equal(r.asset, '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3');
      for (const withArgs of ['allowance', 'balanceOf', 'convertToAssets', 'cooldowns']) assert.ok(!(withArgs in r), withArgs);
    }],
    ['proxy page of cbBTC on Base: admin and implementation', ({ parseReadContract: f }) => {
      const r = f(text('readcontract_cbbtc_base.html'));
      assert.equal(r.admin, '0x42D90b3faF2287475cdc863706Bd7cc3E938C2Af'); assert.equal(r.implementation, '0x7458bfDC30034EB860B265E6068121D18Fa5Aa72');
    }],
    ['at most 40 values; a page without functions gives null', ({ parseReadContract: f }) => {
      const fn = i => `contract-fn-title small py-1.5 me-1">${i}. f${i}<span class="text-muted ms-1">(0x1)</span></span><div class="accordion-body"><div class="row gx-1"></div>v${i} <span class="badge">uint8</span>`;
      assert.equal(Object.keys(f(Array.from({ length: 60 }, (_, i) => fn(i + 1)).join(''))).length, 40);
      assert.equal(f('<html>nothing</html>'), null); assert.equal(f(null), null);
    }]
  ],
  parseBlockscoutContract: [['name and ABI of a contract that Sourcify does not know; null for junk', ({ parseBlockscoutContract: f }) => {
    const r = f(fx('blockscout_contract_pt.json'));
    assert.equal(r.contract_name, 'PendlePrincipalToken'); assert.ok(Array.isArray(r.abi) && r.abi.length > 10);
    assert.deepEqual(f({ name: 'X' }), { contract_name: 'X', abi: null });
    for (const v of [null, {}, 'x', []]) assert.equal(f(v), null);
  }]],
  controllerAddresses: [['control roles with an address, deduplicated; zero and non-addresses are skipped; at most 4', ({ controllerAddresses: f }) => {
    const a = n => '0x' + String(n).repeat(40);
    assert.deepEqual(f({ owner: a(1), admin: a(1), pauser: a(2), blacklister: '0x' + '0'.repeat(40), minter: 'not an address', decimals: '18' }),
      [{ address: a(1), role: 'owner,admin' }, { address: a(2), role: 'pauser' }]);
    assert.equal(f({ owner: a(1), admin: a(2), pauser: a(3), blacklister: a(4), masterMinter: a(5) }).length, 4);
    assert.deepEqual(f(null), []);
    const mixed = '0xE8Dc0Fab349EA169283C48Ccfd09d797E6DB7c94';
    assert.deepEqual(f({ owner: mixed, admin: mixed.toLowerCase() }), [{ address: mixed, role: 'owner,admin' }], 'the spelling of the page is kept: Safe wants EIP-55');
  }], ['authority, accessControl, governor and getCCIPAdmin are control roles too, ranked before pauser and minter', ({ controllerAddresses: f }) => {
    const a = n => '0x' + String(n).repeat(40);
    assert.deepEqual(f({ minter: a(9), authority: a(1), accessControl: a(2), governor: a(3), getCCIPAdmin: a(4) }).map(x => x.role), ['authority', 'accessControl', 'governor', 'getCCIPAdmin']);
  }]],
  parseRpcAddress: [['an address from a storage word; zero, errors, "0x" and a word with high bytes are null', ({ parseRpcAddress: f }) => {
    assert.equal(f({ jsonrpc: '2.0', id: 1, result: '0x000000000000000000000000836263AE83750cd981aa9594002cd045bea08173' }), '0x836263ae83750cd981aa9594002cd045bea08173');
    for (const j of [{ result: '0x' + '0'.repeat(64) }, { result: '0x' }, { error: { code: 3, message: 'execution reverted' } }, { result: '0x' + 'f'.repeat(64) }, null]) assert.equal(f(j), null);
  }]],
  parseRpcUint: [['a delay in seconds from a call result (real getMinDelay of the Ethena timelock: 1 day); errors and "0x" are null', ({ parseRpcUint: f }) => {
    assert.equal(f({ jsonrpc: '2.0', id: 1, result: '0x0000000000000000000000000000000000000000000000000000000000015180' }), 86400);
    assert.equal(f({ result: '0x000000000000000000000000000000000000000000000000000000000002a300' }), 172800);
    for (const j of [{ result: '0x' }, { error: { code: 3 } }, { result: '0x' + 'f'.repeat(64) }, null]) assert.equal(f(j), null);
  }]],
  parseRpcString: [['a name from an ABI string or a bytes32; errors, "0x" and junk are null', ({ parseRpcString: f }) => {
    const abi = text => '0x' + '20'.padStart(64, '0') + text.length.toString(16).padStart(64, '0') + Buffer.from(text).toString('hex').padEnd(64, '0');
    assert.equal(f({ result: abi('Spark Savings USDG') }), 'Spark Savings USDG');
    assert.equal(f({ result: '0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0') }), 'MKR');
    for (const j of [{ result: '0x' }, { error: { code: 3 } }, { result: '0x' + '0'.repeat(128) }, { result: '0x1234' }, null]) assert.equal(f(j), null);
  }]],
  parseRpcBigUint: [['a total supply as a decimal string without losing digits; errors are null', ({ parseRpcBigUint: f }) => {
    assert.equal(f({ result: '0x' + (41511432704122776916612747n).toString(16).padStart(64, '0') }), '41511432704122776916612747');
    for (const j of [{ result: '0x' }, { error: { code: 3 } }, null]) assert.equal(f(j), null);
  }]],
  parseRpcArrayLength: [['the length of an address array (Safe getOwners); junk is null', ({ parseRpcArrayLength: f }) => {
    const arr = n => '0x' + '20'.padStart(64, '0') + n.toString(16).padStart(64, '0') + '0'.repeat(64 * n);
    assert.equal(f({ result: arr(3) }), 3);
    for (const j of [{ result: '0x' }, { error: { code: 3 } }, { result: '0x' + '0'.repeat(64) }, null]) assert.equal(f(j), null);
  }]],
  parseSharePrice: [['assets per share from the vault\'s own values; an 18-decimal share of a 6-decimal asset is scaled by the offset', ({ parseSharePrice: f }) => {
    const susde = f({ totalAssets: '1190889257600593627486331890', totalSupply: '949468438374510151496210215', asset: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3' });
    assert.ok(Math.abs(susde - 1.25427) < 1e-4, String(susde));
    const steak = { totalAssets: '1037000', totalSupply: '1000000000000000000', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' };
    assert.equal(f(steak), 1.037); assert.equal(f({ ...steak, DECIMALS_OFFSET: '12' }), 1.037);
    assert.equal(f({ ...steak, totalAssets: '66', totalSupply: '10000' }), 0.0066, 'a ratio near 1/100 is kept as it is');
    assert.equal(f({ ...steak, totalAssets: '1', totalSupply: '1' + '0'.repeat(25) }), null, 'no common offset fits');
    for (const v of [null, {}, { totalAssets: '1', totalSupply: '0', asset: steak.asset }, { totalAssets: 'x', totalSupply: '1', asset: steak.asset }, { totalAssets: '1', totalSupply: '1' }]) assert.equal(f(v), null);
  }]],
  parsePtExpiry: [['expiry from the market, else from the PT contract; expired against the given time', ({ parsePtExpiry: f }) => {
    const now = Date.parse('2026-10-22T00:00:00Z');
    assert.deepEqual(f({ expiry: '2027-12-30T00:00:00.000Z' }, { expiry: '1' }, now), { expiry: '2027-12-30T00:00:00.000Z', expired: false });
    assert.deepEqual(f(null, { expiry: '1753920000', isExpired: 'True' }, now), { expiry: '2025-07-31T00:00:00.000Z', expired: true }, 'PT-USDe-31JUL2025');
    assert.deepEqual(f(null, { isExpired: 'False' }, now), { expiry: null, expired: false });
    assert.deepEqual(f(null, null, now), { expiry: null, expired: null });
  }]],

  parseSafe: [['threshold and owner count; any non-200 means not a Safe', ({ parseSafe: f }) => {
    assert.deepEqual(f(200, fx('safe_morpho_dao.json')), { threshold: 6, owner_count: 10 });
    assert.equal(f(404, null), null); assert.equal(f(422, {}), null); assert.equal(f(200, {}), null);
  }]],
  parsePendleMarket: [['finds the market of a PT through the "<chainId>-" prefix', ({ parsePendleMarket: f }) => {
    const r = f(fx('pendle_active_sample.json'), PT, Date.parse('2026-10-22T00:00:00Z'));
    assert.deepEqual([r.market, r.expiry, r.days_to_expiry, r.active], ['0x34280882267ffa6383b363e278b027be083bbe3b', '2027-12-30T00:00:00.000Z', 434, true]);
    assert.equal(r.underlying, '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'); assert.equal(r.liquidity_usd, 4925241.3176204935);
    assert.equal(f(fx('pendle_active_sample.json'), '0xdead'), null); assert.equal(f(null, PT), null);
  }]],
  parseFeeds: [['feeds of a symbol and the Proof of Reserve flag', ({ parseFeeds: f }) => {
    const r = f(fx('rdd_feeds_sample.json'), 'FBTC');
    assert.equal(r.feeds[0].name, 'FBTC Proof of Reserves'); assert.equal(r.feeds[0].heartbeat_sec, 86400); assert.equal(r.feeds[0].deviation_pct, 0.5); assert.equal(r.has_por_feed, true);
    assert.deepEqual(f(fx('rdd_feeds_sample.json'), 'NOSUCH'), { feeds: [], has_por_feed: false });
    assert.equal(f(null, 'X'), null); assert.equal(f([], ''), null);
  }], ['a pair feed belongs only to the base of the pair (real catalog: "nvPRIME / PRIME" is filed under baseAsset PRIME)', ({ parseFeeds: f }) => {
    const cat = fx('rdd_feeds_pairs.json'), names = s => f(cat, s).feeds.map(x => x.name);
    assert.deepEqual(names('PRIME'), []); assert.deepEqual(names('nvprime'), ['nvPRIME / PRIME Exchange Rate']);
    assert.deepEqual(names('LBTC'), ['LBTC / BTC', 'Lombard Proof of Reserves'], 'a non-pair name matches on baseAsset'); assert.equal(f(cat, 'LBTC').has_por_feed, true);
    assert.deepEqual(names('sUSDat'), ['Saturn sUSDat NAV']); assert.deepEqual(names('ETH+'), ['Calculated ETH+/USD']); assert.deepEqual(names('SPYon'), ['SPYon-USD (Calculated)']);
    assert.deepEqual(names('ETH'), []); assert.deepEqual(names('USD'), [], 'the quote side never matches');
  }]],
  parseRwa: [['issuer, NAV and redemption terms, accepted only for a listed contract address', ({ parseRwa: f }) => {
    const r = f(text('rwa_mfone.html'), '0x238a700eD6165261Cf8b2e544ba797BC11e466Ba');
    assert.deepEqual([r.ticker, r.issuer, r.manager, r.redemption_frequency, r.redemption_fee_bps, r.min_subscription_usd, r.kyc_required, r.bankruptcy_remote, r.holders_count],
      ['mF-ONE', 'Midas', 'Fasanara', 'Instant', 100, 150000, false, false, 39]);
    assert.equal(r.nav_usd, 1.13135894); assert.equal(r.custodian, null);
    assert.equal(f(text('rwa_mfone.html'), '0x' + '1'.repeat(40)), null); assert.equal(f('<html></html>', '0x1'), null); assert.equal(f(null, '0x1'), null);
  }]]
};
