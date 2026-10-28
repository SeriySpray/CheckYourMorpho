import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../server/db/schema.js';
import { CONFIG } from '../../server/config.js';

const dir = new URL('../data/collector/', import.meta.url);
const text = name => fs.readFileSync(new URL(name, dir), 'utf8');
const SUSDE = '0x9d39a5de30e57443bff2a8307a4256c8797a3497';
const OWNER = '0xe8dc0fab349ea169283c48ccfd09d797e6db7c94';
const NOW = 1_792_660_000_000;

const word = hex => '0x' + hex.replace(/^0x/, '').padStart(64, '0');
// JSON-RPC answers by request: the EIP-1967 slots (zero by default) and eth_call by selector ("0x", a revert, by default)
function rpcAnswer(body, rpc) {
  const { method, params } = JSON.parse(body);
  const key = method === 'eth_getStorageAt' ? (params[1].startsWith('0xb531') ? 'admin' : 'impl') : params[0].data;
  const v = rpc[key] ?? (method === 'eth_getStorageAt' ? word('0') : '0x');
  return { status: 200, body: JSON.stringify(typeof v === 'string' ? { jsonrpc: '2.0', id: 1, result: v } : { jsonrpc: '2.0', id: 1, error: v }) };
}

// A fetch answering from the saved real responses. `over` replaces the answer for URLs matching a regexp; `rpc` sets JSON-RPC results.
function mockFetch(over = [], rpc = {}) {
  const calls = [];
  const answer = (url, init) => {
    for (const [re, r] of over) if (re.test(url)) return r;
    if (url.includes('publicnode.com') || url.includes('chain.robinhood.com')) return rpcAnswer(init.body, rpc);
    const body = (name, status = 200) => ({ status, body: name === null ? '' : text(name) });
    if (url.includes('sourcify.dev')) return body('sourcify_susde.json');
    if (/blockscout\.com\/(?:\d+\/)?api\/v2\/tokens\/0x\w+\/holders/.test(url)) return body('blockscout_holders_susde.json');
    if (/blockscout\.com\/(?:\d+\/)?api\/v2\/tokens\/0x\w+\/counters/.test(url)) return body('blockscout_counters_susde.json');
    if (/blockscout\.com\/(?:\d+\/)?api\/v2\/tokens\/0x\w+(?:\?.*)?$/.test(url)) return body('blockscout_token_susde.json');
    if (/blockscout\.com\/(?:\d+\/)?api\/v2\/addresses\//.test(url)) return body('blockscout_address_susde.json');
    if (/blockscout\.com\/(?:\d+\/)?api\/v2\/transactions\//.test(url)) return body('blockscout_tx_creation.json');
    if (url.includes('prices/current')) return body('llama_price_susde.json');
    if (url.includes('llama.fi/chart')) return body('llama_chart_susde.json');
    if (url.endsWith('/info')) return body('gecko_info_susde.json');
    if (url.endsWith('/pools')) return body('gecko_pools_susde.json');
    if (url.includes('readContract')) return body('readcontract_susde.html');
    if (url.includes('kyberswap')) return body('kyber_susde_100k.json');
    if (url.includes('safe.global')) return body(null, 404);
    if (url.includes('reference-data-directory')) return body('rdd_feeds_sample.json');
    if (url.includes('pendle.finance')) return body('pendle_active_sample.json');
    if (url.includes('rwa.xyz')) return body('rwa_mfone.html');
    return { status: 404, body: '' };
  };
  const impl = async (url, init = {}) => {
    calls.push(init.body ? `${url} ${init.body}` : url);
    const r = answer(url, init);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => r.body };
  };
  return { impl, calls };
}
const run = (mod, token, over = [], rpc = {}) => {
  mod.clearFeedCache();
  const net = mockFetch(over, rpc);
  const fetcher = mod.createFetcher({ fetchImpl: net.impl, sleep: async () => {} });
  return mod.collectTokenData(token, { fetcher, now: () => NOW }).then(r => ({ ...r, net }));
};
const freshDb = () => { const db = new DatabaseSync(':memory:'); db.exec(SCHEMA_SQL); db.exec('PRAGMA foreign_keys=OFF'); return db; };
const seedMarket = (db, key, chain, addr, symbol, supply) => {
  db.prepare('INSERT INTO markets (unique_key, chain_id, collateral_asset_address, collateral_asset_symbol) VALUES (?, ?, ?, ?)').run(key, chain, addr, symbol);
  if (supply) db.prepare('INSERT INTO vault_allocations (vault_address, market_unique_key, supply_assets_usd) VALUES (?, ?, ?)').run('0xv', key, supply);
};
const result = (over = {}) => ({ status: 'ok', coverage: 0.9, data: { identity: { symbol: 'TKN' }, meta: {} }, ...over });
const withEnv = (v, fn) => {
  const saved = process.env.TOKEN_DATA_DISABLED;
  if (v === undefined) delete process.env.TOKEN_DATA_DISABLED; else process.env.TOKEN_DATA_DISABLED = v;
  try { return fn(); } finally { if (saved === undefined) delete process.env.TOKEN_DATA_DISABLED; else process.env.TOKEN_DATA_DISABLED = saved; }
};

export default {
  CHAINS: [['ethereum, base and arbitrum with all source names', ({ CHAINS: c }) => {
    assert.deepEqual(Object.keys(c).map(Number).sort((a, b) => a - b), [1, 10, 130, 137, 143, 480, 988, 999, 4217, 4663, 5042, 8453, 42161, 747474]);
    for (const id of Object.values(CONFIG.chains)) assert.ok(c[id], `chain ${id} synced from Morpho has collector sources`);
    assert.ok(c[5042].kyber === 'arc' && /^0x[0-9a-fA-F]{40}$/.test(c[5042].usdc), 'Arc swaps are routed to its USDC');
    for (const id of [1, 8453, 42161]) { const v = c[id]; assert.ok(v.blockscout && v.llama && v.gecko && v.kyber && v.safe && v.explorer && v.n && v.feeds && /^0x[0-9a-fA-F]{40}$/.test(v.usdc), String(id)); }
    for (const v of Object.values(c)) assert.ok(v.llama, 'every listed chain has a price source');
    assert.equal(c[42161].safe, 'arb1');
    assert.ok(!c[143].blockscout && !c[143].explorer && !c[747474].kyber);
    assert.deepEqual(Object.keys(c).filter(id => c[id].rpc).map(Number).sort((a, b) => a - b), [1, 10, 130, 137, 988, 4217, 4663, 5042, 8453, 42161], 'public JSON-RPC for the EIP-1967 slots');
  }]],
  isCollectorUrl: [['https on the listed hosts and Blockscout instances only', ({ isCollectorUrl: f }) => {
    for (const u of ['https://sourcify.dev/x', 'https://base.blockscout.com/api/v2/tokens/0x1', 'https://etherscan.io/readContract', 'https://api.geckoterminal.com/a', 'https://ethereum-rpc.publicnode.com/']) assert.ok(f(u), u);
    assert.ok(!f('https://evil-rpc.publicnode.com/'), 'only the listed RPC hosts');
    for (const u of ['http://sourcify.dev/x', 'https://evil.com/x', 'https://blockscout.com.evil.com/x', 'https://u:p@sourcify.dev/x', 'https://api.coingecko.com/x', 'junk']) assert.ok(!f(u), u);
  }]],
  calcAmountIn: [
    ['USD over price times 10^decimals as an integer string', ({ calcAmountIn: f }) => {
      assert.equal(f(100000, 1.25, 18), '80000000000000000000000'); assert.equal(f(1000000, 80000, 8), '1250000000'); assert.equal(f(100, 1, 6), '100000000');
    }],
    ['no price, decimals or amount -> null', ({ calcAmountIn: f }) => {
      for (const a of [[100, 0, 18], [100, NaN, 18], [100, null, 18], [100, 1, 40], [100, 1, 1.5], [100, 1, undefined], [0, 1, 18]]) assert.equal(f(...a), null, String(a));
    }]
  ],
  sourceUrls: [
    ['every URL of a supported chain is built from the lower-case address and passes the host check', ({ sourceUrls: f, isCollectorUrl }) => {
      const impl = '0x' + '2'.repeat(40);
      const u = f(8453, '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', { implementation: impl, amountIn: '5' });
      for (const [k, x] of Object.entries(u)) if (typeof x === 'string') assert.ok(isCollectorUrl(x), k);
      assert.ok(u.bsToken.startsWith('https://base.blockscout.com/api/v2/tokens/0xabcdef')); assert.ok(u.explorerImpl.endsWith('&v=' + impl));
      assert.ok(u.kyber.includes('/base/api/v1/routes') && u.kyber.includes('amountIn=5')); assert.ok(u.sourcify.includes('/contract/8453/') && u.sourcify.includes('fields=abi,compilation,proxyResolution,deployment'));
    }],
    ['an unsupported chain gets only Sourcify', ({ sourceUrls: f }) => assert.deepEqual(Object.keys(f(56, '0x' + '1'.repeat(40))), ['sourcify'])]
  ],
  createFetcher: [
    ['a host that is not allowed is refused without a request', async ({ createFetcher: f }) => {
      const net = mockFetch(); const r = await f({ fetchImpl: net.impl, sleep: async () => {} }).get('https://evil.com/x');
      assert.deepEqual([r.status, r.error, net.calls.length], [0, 'url is not allowed', 0]);
    }],
    ['a pause follows every request, a long one for GeckoTerminal', async ({ createFetcher: f }) => {
      const net = mockFetch(), slept = [], g = f({ fetchImpl: net.impl, sleep: async ms => { slept.push(ms); } });
      await g.get('https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x1/info'); await g.get('https://sourcify.dev/x');
      assert.deepEqual(slept, [6000, 300]);
    }],
    ['502/503/504 are retried once after 3 s', async ({ createFetcher: f }) => {
      let n = 0; const slept = [];
      const r = await f({ fetchImpl: async () => (++n === 1 ? { status: 503, text: async () => 'busy' } : { status: 200, text: async () => 'fine' }), sleep: async ms => { slept.push(ms); } }).get('https://sourcify.dev/x');
      assert.deepEqual([r.status, r.text, slept[0], n], [200, 'fine', 3000, 2]);
      assert.equal((await f({ fetchImpl: async () => ({ status: 500, text: async () => '' }), sleep: async () => {} }).get('https://sourcify.dev/x')).status, 500);
    }],
    ['429 is retried once after a wait, a second 429 is reported', async ({ createFetcher: f }) => {
      let n = 0; const slept = [];
      const ok = await f({ fetchImpl: async () => (++n === 1 ? { status: 429 } : { status: 200, text: async () => 'fine' }), sleep: async ms => { slept.push(ms); } }).get('https://sourcify.dev/x');
      assert.deepEqual([ok.status, ok.text, slept[0]], [200, 'fine', 10000]);
      const bad = await f({ fetchImpl: async () => ({ status: 429 }), sleep: async () => {} }).get('https://sourcify.dev/x');
      assert.deepEqual([bad.status, bad.error], [429, 'rate limited']);
    }],
    ['a network error is a result with status 0, never an exception', async ({ createFetcher: f }) => {
      const r = await f({ fetchImpl: async () => { throw new Error('boom'); }, sleep: async () => {} }).get('https://sourcify.dev/x');
      assert.deepEqual([r.status, r.error], [0, 'boom']);
    }],
    ['with a body the request is a JSON POST to an allowed host; a POST elsewhere is refused', async ({ createFetcher: f }) => {
      const seen = [];
      const g = f({ fetchImpl: async (url, init) => { seen.push(init); return { status: 200, text: async () => '{"result":"0x"}' }; }, sleep: async () => {} });
      const r = await g.get('https://ethereum-rpc.publicnode.com/', { body: '{"method":"eth_call"}' });
      assert.deepEqual([r.status, seen[0].method, seen[0].body, seen[0].headers['content-type']], [200, 'POST', '{"method":"eth_call"}', 'application/json']);
      await g.get('https://sourcify.dev/x'); assert.equal(seen[1].method, undefined, 'a GET without a body');
      assert.equal((await g.get('https://evil.com/', { body: '{}' })).error, 'url is not allowed'); assert.equal(seen.length, 2);
    }],
    ['the body is cut at the limit', async ({ createFetcher: f }) => {
      const r = await f({ fetchImpl: async () => ({ status: 200, text: async () => 'x'.repeat(5000) }), sleep: async () => {} }).get('https://sourcify.dev/x', { maxBytes: 100 });
      assert.equal(r.text.length, 100);
    }]
  ],
  clearFeedCache: [['the feed catalog is read once, then cached until cleared', async mod => {
    const feedCalls = async () => {
      const net = mockFetch();
      await mod.collectTokenData({ chainId: 1, address: SUSDE }, { fetcher: mod.createFetcher({ fetchImpl: net.impl, sleep: async () => {} }), now: () => NOW });
      return net.calls.filter(u => u.includes('reference-data-directory')).length;
    };
    mod.clearFeedCache();
    assert.equal(await feedCalls(), 1); assert.equal(await feedCalls(), 0, 'cached'); mod.clearFeedCache(); assert.equal(await feedCalls(), 1);
  }]],
  countFields: [['counts filled leaves, treats empty arrays as empty and leaves out null pendle and rwa', ({ countFields: f }) => {
    assert.deepEqual(f({ a: { b: 1, c: null }, d: [], e: [1], pendle: null, rwa: null }), { filled: 2, total: 4, coverage: 0.5 });
    assert.deepEqual(f({ pendle: { x: 1 } }), { filled: 1, total: 1, coverage: 1 }); assert.deepEqual(f({}), { filled: 0, total: 0, coverage: 0 });
  }]],

  collectTokenData: [
    ['Robinhood Chain (no Blockscout): name, decimals and supply, the owner and the proxy admin are read over JSON-RPC', async mod => {
      const text = t => '0x' + '20'.padStart(64, '0') + t.length.toString(16).padStart(64, '0') + Buffer.from(t).toString('hex').padEnd(64, '0');
      const SAFE = '0x' + 'a'.repeat(40), PROXY_ADMIN = '0x' + 'b'.repeat(40);
      const rpc = { '0x06fdde03': text('Spark Savings USDG'), '0x313ce567': word('6'), '0x18160ddd': word((13514517459885n).toString(16)), '0x8da5cb5b': word(SAFE),
        '0xe75235b8': word('2'), '0xa0e67e2b': '0x' + '20'.padStart(64, '0') + '3'.padStart(64, '0') + '0'.repeat(192), undefined: '0x6080604052' };
      const r = await run(mod, { chainId: 4663, address: '0x' + 'c'.repeat(40), symbol: 'spUSDG' }, [], { ...rpc });
      const d = r.data;
      assert.deepEqual([d.identity.name, d.identity.decimals, d.identity.total_supply], ['Spark Savings USDG', 6, '13514517459885']);
      assert.equal(d.control.controllers.length, 1);
      assert.deepEqual([d.control.controllers[0].role, d.control.controllers[0].is_contract, d.control.controllers[0].safe, d.control.controllers[0].is_multisig], ['owner', true, { threshold: 2, owner_count: 3 }, true]);
      assert.ok(r.net.calls.every(u => !u.includes('blockscout.com')), 'no Blockscout request for this chain');
      const withAdmin = await run(mod, { chainId: 4663, address: '0x' + 'c'.repeat(40), symbol: 'x' }, [], { '0x8da5cb5b': '0x', undefined: '0x' });
      assert.deepEqual(withAdmin.data.control.controllers, [], 'no owner and no proxy slot: nothing to read');
      assert.equal(withAdmin.data.identity.name, null);
    }],
    ['Robinhood Chain with a PRO key: Blockscout holders and source come from api.blockscout.com/4663, the key is sent but never stored; the owner is still read over JSON-RPC', async mod => {
      const KEY = 'proapi_' + 'A1b2C3d4E5'.repeat(4), saved = process.env.BLOCKSCOUT_API_KEY;
      process.env.BLOCKSCOUT_API_KEY = KEY;
      try {
        const OWNER_EOA = '0x' + 'd'.repeat(40);
        const r = await run(mod, { chainId: 4663, address: '0x' + 'c'.repeat(40), symbol: 'x' }, [], { '0x8da5cb5b': word(OWNER_EOA), undefined: '0x' });
        const pro = r.net.calls.filter(u => u.includes('api.blockscout.com'));
        assert.ok(pro.length >= 3 && pro.every(u => u.includes('/4663/api/v2/') && u.includes(`apikey=${KEY}`)), 'every PRO request carries the key');
        assert.ok(pro.some(u => u.includes('/holders')) && !r.net.calls.some(u => u.includes('robinhoodchain.blockscout.com')));
        assert.ok(r.data.holders.count > 0, 'holders come from the PRO API');
        assert.equal(JSON.stringify(r.data).includes(KEY), false, 'the key is not part of the stored record');
        assert.ok(r.data.meta.sources.every(x => !x.url.includes('apikey')));
        assert.deepEqual([r.data.control.controllers[0].address, r.data.control.controllers[0].role], [OWNER_EOA, 'owner']);
      } finally {
        if (saved === undefined) delete process.env.BLOCKSCOUT_API_KEY; else process.env.BLOCKSCOUT_API_KEY = saved;
      }
    }],
    ['a missing or malformed key means no PRO request at all', async mod => {
      const saved = process.env.BLOCKSCOUT_API_KEY;
      try {
        for (const v of [undefined, '', 'not-a-key']) {
          if (v === undefined) delete process.env.BLOCKSCOUT_API_KEY; else process.env.BLOCKSCOUT_API_KEY = v;
          const r = await run(mod, { chainId: 4663, address: '0x' + 'c'.repeat(40), symbol: 'x' }, [], { undefined: '0x' });
          assert.ok(r.net.calls.every(u => !u.includes('blockscout.com')), String(v));
        }
      } finally {
        if (saved === undefined) delete process.env.BLOCKSCOUT_API_KEY; else process.env.BLOCKSCOUT_API_KEY = saved;
      }
    }],
    ['a plain address owner on a JSON-RPC-only chain is a single account, not a contract', async mod => {
      const OWNER_EOA = '0x' + 'd'.repeat(40);
      const r = await run(mod, { chainId: 4663, address: '0x' + 'c'.repeat(40), symbol: 'x' }, [], { '0x8da5cb5b': word(OWNER_EOA), undefined: '0x' });
      const c = r.data.control.controllers[0];
      assert.deepEqual([c.address, c.is_contract, c.safe, c.safe_checked, c.is_eoa_delegated], [OWNER_EOA, false, null, true, false]);
      const delegated = await run(mod, { chainId: 4663, address: '0x' + 'c'.repeat(40), symbol: 'x' }, [], { '0x8da5cb5b': word(OWNER_EOA), undefined: '0xef0100' + 'e'.repeat(40) });
      assert.deepEqual([delegated.data.control.controllers[0].is_contract, delegated.data.control.controllers[0].is_eoa_delegated], [false, true]);
    }],
    ['sUSDe: every group is filled from the sources and the status is ok', async mod => {
      const r = await run(mod, { chainId: 1, address: SUSDE.toUpperCase().replace('0X', '0x'), symbol: 'sUSDe' });
      const d = r.data;
      assert.equal(r.status, 'ok'); assert.ok(r.coverage > 0.6 && r.coverage <= 1, String(r.coverage));
      assert.deepEqual([d.identity.symbol, d.identity.decimals, d.identity.contract_name], ['sUSDe', 18, 'StakedUSDeV2']);
      assert.deepEqual([d.contract.sourcify_match, d.contract.is_proxy, d.contract.fn.blacklist, d.contract.fn.erc4626, d.contract.deployed_at], ['exact_match', false, true, true, '2023-11-14T16:32:47.000Z']);
      assert.equal(d.control.read_values.cooldownDuration, '86400'); assert.equal(d.control.controllers[0].address.toLowerCase(), OWNER); assert.ok(r.net.calls.some(u => u.includes('safe.global') && u.includes('0xE8Dc0Fab349EA169283C48Ccfd09d797E6DB7c94')), 'Safe asked with the EIP-55 spelling'); assert.equal(d.control.controllers[0].role, 'owner'); assert.equal(d.control.controllers[0].safe, null);
      assert.deepEqual([d.holders.count, d.holders.top10_pct, d.holders.morpho_blue_pct], [11748, 72.97, 9.816]);
      assert.deepEqual([d.price.usd, d.price.chart.count], [1.2537625656596842, 30]);
      assert.equal(d.liquidity.pools_count, 3); assert.equal(d.liquidity.kyber['100000'].status, 'ok'); assert.equal(d.liquidity.kyber['1000000'].status, 'ok');
      assert.deepEqual([d.pendle, d.rwa], [null, null]); assert.equal(d.meta.collected_at, Math.floor(NOW / 1000));
      assert.ok(d.meta.sources.some(x => x.key === 'chainlink_feeds' && x.status === 200));
      assert.ok(r.net.calls.every(u => u.startsWith('https://')), 'all URLs are https');
      assert.ok(r.net.calls.some(u => /amountIn=797\d{20}&/.test(u)), '100k USD of sUSDe at 1.2538 is about 79760 tokens');
      assert.deepEqual([d.liquidity.kyber['100000'].price_impact_pct, d.liquidity.kyber['100000'].kyber_in_usd], [0, 100077.79], 'impact against the requested 100K');
      assert.deepEqual([d.holders.top1_nonprotocol_pct, d.holders.top10_nonprotocol_pct], [11.786, 23.531], 'the Aave aToken proxy (10.3%) is a pool, not an owner');
      assert.equal(d.price.share_price_assets, 1.25426308, 'totalAssets / totalSupply of the vault');
      assert.deepEqual([d.contract.fn.upgrade_via_proxy, d.contract.is_proxy], [false, false], 'Sourcify says it is not a proxy and the EIP-1967 slots are empty');
      assert.ok(r.net.calls.some(u => u.includes('ethereum-rpc.publicnode.com') && u.includes('eth_getStorageAt')));
      assert.deepEqual([d.control.controllers[0].safe_checked, d.control.controllers[0].is_multisig, d.control.controllers[0].is_eoa_delegated, d.control.controllers[0].timelock_delay_sec], [true, false, false, null]);
    }],
    ['the EIP-1967 admin becomes a proxy_admin controller (Blockscout type, Safe with the EIP-55 spelling); a timelock owner gets its delay', async mod => {
      const admin = '0x836263AE83750cd981aa9594002cd045bea08173';
      const addrJson = (hash, name, extra = {}) => ({ status: 200, body: JSON.stringify({ hash, name, is_contract: true, implementations: [], ...extra }) });
      const r = await run(mod, { chainId: 1, address: SUSDE }, [
        [new RegExp(`addresses/${admin.toLowerCase()}`), addrJson(admin, 'GnosisSafeProxy')],
        [new RegExp(`addresses/${OWNER}`, 'i'), addrJson('0xE8Dc0Fab349EA169283C48Ccfd09d797E6DB7c94', 'EthenaTimelockController')],
        [new RegExp(`safes/${admin}/`), { status: 200, body: text('safe_morpho_dao.json') }]
      ], { admin: word(admin.toLowerCase()), '0xf27a0c92': word('15180') });
      const [owner, pa] = r.data.control.controllers;
      assert.deepEqual([owner.name, owner.timelock_delay_sec, owner.role], ['EthenaTimelockController', 86400, 'owner']);
      assert.deepEqual([pa.address, pa.role, pa.name, pa.is_multisig, pa.safe], [admin.toLowerCase(), 'proxy_admin', 'GnosisSafeProxy', true, { threshold: 6, owner_count: 10 }]);
      assert.ok(r.net.calls.some(u => u.includes(`safes/${admin}/`)), 'the Safe is asked with the explorer spelling');
    }],
    ['a chain with Blockscout but no Safe service (Optimism): the slot admin is typed, the Safe is not asked and stays unchecked', async mod => {
      const admin = '0x' + '4'.repeat(40);
      const r = await run(mod, { chainId: 10, address: SUSDE }, [], { admin: word(admin) });
      assert.ok(!r.net.calls.some(u => u.includes('safe.global')) && r.net.calls.some(u => u.includes('optimism-rpc.publicnode.com')));
      assert.deepEqual(r.data.control.controllers.map(c => [c.address, c.role, c.safe, c.safe_checked]), [[admin, 'proxy_admin', null, false]]);
      const limited = await run(mod, { chainId: 1, address: SUSDE }, [[/safe\.global/, { status: 429, body: '' }]]);
      assert.equal(limited.data.control.controllers[0].safe_checked, false, 'a rate-limited Safe service is not an answer');
    }],
    ['a Compound timelock answers delay() when getMinDelay reverts; an EIP-7702 delegated EOA is marked', async mod => {
      const r = await run(mod, { chainId: 1, address: SUSDE }, [
        [new RegExp(`addresses/${OWNER}`, 'i'), { status: 200, body: JSON.stringify({ hash: OWNER, name: 'Timelock', is_contract: true, implementations: [] }) }]
      ], { '0xf27a0c92': { code: 3, message: 'execution reverted' }, '0x6a42b8f8': word('2a300') });
      assert.equal(r.data.control.controllers[0].timelock_delay_sec, 172800);
      const d = await run(mod, { chainId: 1, address: SUSDE }, [
        [new RegExp(`addresses/${OWNER}`, 'i'), { status: 200, body: JSON.stringify({ hash: OWNER, name: null, is_contract: true, implementations: [{ address_hash: '0x' + '6'.repeat(40), name: 'EIP7702StatelessDeleGator' }] }) }]
      ]);
      assert.deepEqual([d.data.control.controllers[0].is_eoa_delegated, d.data.control.controllers[0].implementation_names], [true, ['EIP7702StatelessDeleGator']]);
    }],
    ['an implementation in the EIP-1967 slot makes the token a proxy that can be upgraded, even with no upgrade function in the ABI', async mod => {
      const impl = '0x' + '5'.repeat(40);
      const r = await run(mod, { chainId: 1, address: SUSDE }, [], { impl: word(impl) });
      assert.deepEqual([r.data.contract.is_proxy, r.data.contract.fn.upgrade, r.data.contract.fn.upgrade_via_proxy, r.data.contract.proxy_type], [true, false, true, 'EIP1967']);
      assert.deepEqual(r.data.contract.implementations, [{ address: impl, name: null }]);
      assert.ok(r.net.calls.some(u => u.includes(`contract/1/${impl}`)), 'the implementation is read too');
    }],
    ['USDC itself is the quote asset: no swap is asked and the quote is na; a Kyber 400 keeps its reason', async mod => {
      const usdc = await run(mod, { chainId: 1, address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' });
      assert.deepEqual([usdc.data.liquidity.kyber['100000'].status, usdc.data.liquidity.kyber['100000'].reason], ['na', 'token is the quote asset (USDC)']);
      assert.ok(!usdc.net.calls.some(u => u.includes('kyberswap')));
      const r = await run(mod, { chainId: 1, address: SUSDE }, [[/kyberswap/, { status: 400, body: text('kyber_400_route_not_found.json') }]]);
      assert.deepEqual([r.data.liquidity.kyber['1000000'].status, r.data.liquidity.kyber['1000000'].reason], ['no_route', '4008 route not found']);
    }],
    ['status: ok needs a price, a token source (Blockscout or GeckoTerminal) and coverage of at least 0.4', async mod => {
      const noToken = await run(mod, { chainId: 1, address: SUSDE }, [[/blockscout\.com\/api\/v2\/tokens\/0x\w+$|geckoterminal/, { status: 404, body: '' }]]);
      assert.equal(noToken.status, 'partial', 'a price alone is not enough');
      const geckoOnly = await run(mod, { chainId: 1, address: SUSDE }, [[/blockscout\.com\/api\/v2\/tokens\/0x\w+$/, { status: 404, body: '' }]]);
      assert.equal(geckoOnly.status, 'ok');
      const identityOnly = await run(mod, { chainId: 1, address: SUSDE }, [[/prices\/current|llama\.fi\/chart/, { status: 404, body: '' }]]);
      assert.equal(identityOnly.status, 'partial');
    }],
    ['a proxy token: the implementation ABI and its read page are collected too', async mod => {
      const impl = '0x' + '7'.repeat(40);
      const proxy = JSON.stringify({ ...JSON.parse(text('sourcify_cbbtc_base.json')), address: SUSDE });
      const implJson = JSON.stringify({ ...JSON.parse(text('sourcify_susde.json')), address: impl, abi: [{ type: 'function', name: 'mint' }, { type: 'function', name: 'pause' }, { type: 'function', name: 'burn' }] });
      const r = await run(mod, { chainId: 1, address: SUSDE }, [[new RegExp(`contract/1/${impl}`), { status: 200, body: implJson }], [/sourcify\.dev/, { status: 200, body: proxy }]]);
      assert.equal(r.data.contract.is_proxy, true);
      assert.ok(r.net.calls.some(u => u.includes('sourcify.dev') && u.includes(r.data.contract.implementations[0].address)), 'implementation fetched from Sourcify');
    }],
    ['a Pendle PT: the active market is found; an unlisted PT is marked inactive', async mod => {
      const pt = '0xb253eff1104802b97ac7e3ac9fdd73aece295a2c';
      const sy = JSON.stringify({ ...JSON.parse(text('sourcify_susde.json')), compilation: { name: 'PendlePrincipalToken' } });
      const over = [[/sourcify\.dev/, { status: 200, body: sy }]];
      const found = (await run(mod, { chainId: 1, address: pt }, over)).data.pendle;
      assert.deepEqual([found.active, found.market, found.expiry, found.expired], [true, '0x34280882267ffa6383b363e278b027be083bbe3b', '2027-12-30T00:00:00.000Z', false]);
      assert.deepEqual((await run(mod, { chainId: 1, address: '0x' + '9'.repeat(40) }, over)).data.pendle, { active: false, expiry: null, expired: null }, 'no market and no expiry on the contract page');
    }],
    ['an RWA token: rwa.xyz data is taken only when the address is in the page', async mod => {
      assert.equal((await run(mod, { chainId: 1, address: '0x238a700ed6165261cf8b2e544ba797bc11e466ba' })).data.rwa.issuer, 'Midas');
      assert.equal((await run(mod, { chainId: 1, address: SUSDE })).data.rwa, null);
    }],
    ['no price -> the swap is not asked for and the status is partial', async mod => {
      const r = await run(mod, { chainId: 1, address: SUSDE }, [[/prices\/current/, { status: 200, body: '{"coins":{}}' }]]);
      assert.equal(r.data.liquidity.kyber['100000'].status, 'error'); assert.equal(r.data.liquidity.kyber['100000'].reason, 'no price or decimals');
      assert.ok(!r.net.calls.some(u => u.includes('kyberswap'))); assert.equal(r.status, 'partial');
    }],
    ['one failing source leaves its group empty, the rest is kept', async mod => {
      const r = await run(mod, { chainId: 1, address: SUSDE }, [[/geckoterminal/, { status: 429, body: '' }], [/aggregator-api/, new Error('down')]]);
      assert.equal(r.status, 'ok'); assert.equal(r.data.liquidity.pools_count, null); assert.equal(r.data.holders.gecko_count, null); assert.equal(r.data.holders.count, 11748);
      assert.equal(r.data.liquidity.kyber['100000'].status, 'error'); assert.ok(r.data.meta.sources.some(x => x.key === 'gecko_info' && x.status === 429));
    }],
    ['everything down -> failed with empty groups; an unsupported chain asks only Sourcify and is never ok', async mod => {
      const r = await run(mod, { chainId: 1, address: SUSDE }, [[/./, { status: 500, body: 'oops' }]]);
      assert.equal(r.status, 'failed'); assert.equal(r.data.identity.name, null); assert.equal(r.data.contract.fn.mint, null); assert.deepEqual(r.data.control.controllers, []);
      const o = await run(mod, { chainId: 56, address: SUSDE });
      assert.equal(o.net.calls.length, 1); assert.equal(o.status, 'partial'); assert.equal(o.data.contract.sourcify_match, 'exact_match');
      assert.equal((await run(mod, { chainId: 56, address: SUSDE }, [[/./, { status: 500, body: '' }]])).status, 'partial');
    }],
    ['Sourcify does not know the contract: name and ABI come from Blockscout, a Pendle PT is still recognised, the status stays ok', async mod => {
      const pt = '0xecfafdc7741323a945a163ed068b5a3c43483957';
      const r = await run(mod, { chainId: 1, address: pt }, [[/sourcify\.dev/, { status: 404, body: '' }], [/smart-contracts\//, { status: 200, body: text('blockscout_contract_pt.json') }]]);
      assert.equal(r.status, 'ok'); assert.equal(r.data.identity.contract_name, 'PendlePrincipalToken'); assert.equal(r.data.contract.sourcify_match, null);
      assert.equal(typeof r.data.contract.fn.permit, 'boolean'); assert.ok(r.net.calls.some(u => u.includes('pendle.finance')));
      assert.ok(r.data.meta.sources.some(x => x.key === 'blockscout_contract' && x.status === 200));
    }],
    ['a chain without Blockscout (Monad): price, pools and swap come from Llama, GeckoTerminal and Kyber; decimals and symbol come from the price record', async mod => {
      const r = await run(mod, { chainId: 143, address: SUSDE }, [[/smart-contracts|blockscout|etherscan|safe\.global/, { status: 500, body: 'must not be asked' }]]);
      assert.ok(!r.net.calls.some(u => /blockscout|etherscan|safe\.global/.test(u)), r.net.calls.join('\n'));
      assert.equal(r.status, 'ok'); assert.deepEqual([r.data.identity.decimals, r.data.identity.symbol], [18, 'sUSDe']);
      assert.equal(r.data.liquidity.kyber['100000'].status, 'ok'); assert.equal(r.data.meta.chain_supported, true);
      assert.ok(r.net.calls.some(u => u.includes('/monad/api/v1/routes')));
    }],
    ['a chain without a Kyber route (Katana) leaves the swap empty and does not ask Kyber', async mod => {
      const r = await run(mod, { chainId: 747474, address: SUSDE });
      assert.ok(!r.net.calls.some(u => u.includes('kyberswap'))); assert.deepEqual(r.data.liquidity.kyber, {});
    }],
    ['an unsupported chain is marked, and a Sourcify 404 there is still an answer', async mod => {
      const r = await run(mod, { chainId: 56, address: SUSDE }, [[/sourcify\.dev/, { status: 404, body: '' }]]);
      assert.deepEqual([r.status, r.data.meta.chain_supported, r.net.calls.length], ['partial', false, 1]);
    }],
    ['rwa.xyz is asked for every token, whatever its category', async mod => {
      const asked = async (chainId, address) => (await run(mod, { chainId, address })).net.calls.some(u => u.includes('rwa.xyz'));
      for (const a of ['0x238a700ed6165261cf8b2e544ba797bc11e466ba', '0x' + '5'.repeat(40), SUSDE, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']) assert.equal(await asked(1, a), true, a);
    }],
    ['a good record younger than a week with the same change signals keeps its slow facts: Sourcify, creation, controllers and rwa.xyz are not read again', async mod => {
      const first = await run(mod, { chainId: 1, address: SUSDE });
      const again = await run(mod, { chainId: 1, address: SUSDE, previous: first.data });
      for (const part of ['sourcify.dev', 'api/v2/addresses/', 'api/v2/transactions/', 'safe.global', 'rwa.xyz']) assert.ok(!again.net.calls.some(u => u.includes(part)), part);
      for (const part of ['coins.llama.fi', 'geckoterminal', 'kyberswap', '/holders', 'readContract', 'rpc']) assert.ok(again.net.calls.some(u => u.includes(part)), `${part} still fresh`);
      assert.deepEqual(again.data.contract, first.data.contract); assert.deepEqual(again.data.control.controllers, first.data.control.controllers); assert.equal(again.data.rwa, first.data.rwa);
      assert.equal(again.data.meta.stable_at, first.data.meta.stable_at); assert.equal(again.data.meta.stable_fp, first.data.meta.stable_fp);
      assert.ok(again.net.calls.length < first.net.calls.length);
    }],
    ['the slow facts are read again when the record is a week old or a change signal moved', async mod => {
      const first = await run(mod, { chainId: 1, address: SUSDE });
      const old = { ...first.data, meta: { ...first.data.meta, stable_at: first.data.meta.stable_at - 8 * 86400 } };
      assert.ok((await run(mod, { chainId: 1, address: SUSDE, previous: old })).net.calls.some(u => u.includes('sourcify.dev')), 'a week old');
      const moved = { ...first.data, meta: { ...first.data.meta, stable_fp: '[null,null,null,[]]' } };
      const r = await run(mod, { chainId: 1, address: SUSDE, previous: moved });
      assert.ok(r.net.calls.some(u => u.includes('sourcify.dev')), 'signals differ');
      assert.equal(r.data.meta.stable_fp, first.data.meta.stable_fp); assert.ok(r.data.meta.stable_at > old.meta.stable_at);
    }],
    ['an invalid address is refused before any request', async ({ collectTokenData: f }) => {
      await assert.rejects(f({ chainId: 1, address: '0xnope' }, { fetcher: { get: async () => { throw new Error('no request expected'); } } }), /invalid token address/);
    }]
  ],

  applyTokenData: [
    ['insert, then replace the current record; each collection is appended to the history', ({ applyTokenData: f }) => {
      const db = freshDb(); const t = { chainId: 1, address: '0xAA' };
      f(db, t, result({ status: 'partial', coverage: 0.5 }), 100); f(db, t, result(), 200);
      const cur = db.prepare('SELECT * FROM token_data').get();
      assert.deepEqual([cur.chain_id, cur.address, cur.symbol, cur.collected_at, cur.status, cur.coverage], [1, '0xaa', 'TKN', 200, 'ok', 0.9]);
      assert.deepEqual(db.prepare('SELECT collected_at, status FROM token_data_history ORDER BY id').all().map(r => `${r.collected_at}:${r.status}`), ['100:partial', '200:ok']);
    }],
    ['the history keeps the last 20 records of a token and leaves other tokens alone', ({ applyTokenData: f }) => {
      const db = freshDb();
      f(db, { chainId: 1, address: '0xbb' }, result(), 1);
      for (let i = 1; i <= 25; i++) f(db, { chainId: 1, address: '0xaa' }, result(), 1000 + i);
      const n = a => db.prepare('SELECT COUNT(*) AS c FROM token_data_history WHERE address = ?').get(a).c;
      assert.deepEqual([n('0xaa'), n('0xbb')], [20, 1]); assert.equal(db.prepare("SELECT MIN(collected_at) AS m FROM token_data_history WHERE address = '0xaa'").get().m, 1006);
    }],
    ['a failure rolls everything back', ({ applyTokenData: f }) => {
      const db = freshDb(); db.exec('DROP TABLE token_data_history');
      assert.throws(() => f(db, { chainId: 1, address: '0xaa' }, result(), 1));
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM token_data').get().c, 0);
    }]
  ],
  getTokenData: [['returns the stored record with parsed data and a stale flag after two refresh periods', ({ getTokenData: f, applyTokenData: apply }) => {
    const db = freshDb(); apply(db, { chainId: 1, address: '0xaa' }, result({ coverage: 0.7 }), 1000);
    const fresh = f(db, 1, '0xAA', 1100);
    assert.deepEqual([fresh.chainId, fresh.address, fresh.status, fresh.coverage, fresh.collectedAt, fresh.stale, fresh.data.identity.symbol], [1, '0xaa', 'ok', 0.7, 1000, false, 'TKN']);
    assert.equal(f(db, 1, '0xaa', 1000 + 2 * CONFIG.tokenData.refreshSec + 1).stale, true);
    assert.equal(f(db, 1, '0xnone'), null);
  }]],
  listTokenData: [['every stored record with parsed data, ordered by chain and address; an empty table gives []', ({ listTokenData: f, applyTokenData: apply }) => {
    const db = freshDb(); assert.deepEqual(f(db), []);
    apply(db, { chainId: 8453, address: '0xbb' }, result(), 5); apply(db, { chainId: 1, address: '0xcc' }, result({ status: 'partial', coverage: 0.5 }), 6); apply(db, { chainId: 1, address: '0xaa' }, result(), 7);
    const all = f(db);
    assert.deepEqual(all.map(r => `${r.chainId}:${r.address}`), ['1:0xaa', '1:0xcc', '8453:0xbb']);
    assert.deepEqual([all[1].status, all[1].coverage, all[1].collectedAt, all[1].symbol, all[1].data.identity.symbol], ['partial', 0.5, 6, 'TKN', 'TKN']);
  }]],
  tokenDataQueue: [
    ['never collected first (biggest capital first), then expired records; fresh ones and idle markets are left out', ({ tokenDataQueue: q, applyTokenData: apply }) => {
      const db = freshDb(); const { refreshSec, retrySec } = CONFIG.tokenData; const now = 1_000_000;
      seedMarket(db, 'm1', 1, '0xAAaa', 'SMALL', 10); seedMarket(db, 'm2', 1, '0xbb', 'BIG', 500); seedMarket(db, 'm3', 1, '0xcc', 'OLD', 1);
      seedMarket(db, 'm4', 1, '0xdd', 'FRESH', 1); seedMarket(db, 'm5', 1, '0xee', 'RETRY', 1); seedMarket(db, 'm6', 1, '0xff', 'RETRYSOON', 1);
      seedMarket(db, 'm7', 1, '', 'EMPTY', 1); seedMarket(db, 'm8', 1, '0x' + '0'.repeat(40), 'ZERO', 1);
      apply(db, { chainId: 1, address: '0xcc' }, result(), now - refreshSec - 5);
      apply(db, { chainId: 1, address: '0xdd' }, result(), now - 100);
      apply(db, { chainId: 1, address: '0xee' }, result({ status: 'partial' }), now - retrySec - 5);
      apply(db, { chainId: 1, address: '0xff' }, result({ status: 'failed' }), now - 100);
      assert.deepEqual(q(db, now).map(t => t.symbol), ['BIG', 'SMALL', 'OLD', 'RETRY']);
      assert.equal(q(db, now)[1].address, '0xaaaa', 'addresses come back in lower case');
      assert.equal(q(db, now, { limit: 2 }).length, 2);
    }],
    ['an empty database gives an empty queue', ({ tokenDataQueue: q }) => assert.deepEqual(q(freshDb(), 1), [])]
  ],
  isTokenDataRunning: [['false when idle, true while a tick runs', async ({ isTokenDataRunning: f, runTokenDataTick: tick }) => {
    assert.equal(f(), false); const db = freshDb(); seedMarket(db, 'm1', 1, '0xaa', 'A', 1);
    let during; await tick(db, { collect: async () => { during = f(); return result(); }, log: () => {} });
    assert.equal(during, true); assert.equal(f(), false);
  }]],
  runTokenDataTick: [
    ['collects queued tokens, stores them and counts failures; a failing token does not stop the tick', async ({ runTokenDataTick: tick }) => {
      const db = freshDb(); seedMarket(db, 'm1', 1, '0xaa', 'A', 3); seedMarket(db, 'm2', 1, '0xbb', 'B', 2); seedMarket(db, 'm3', 1, '0xcc', 'C', 1);
      const logs = [];
      const out = await tick(db, { collect: async t => { if (t.address === '0xbb') throw new Error('bad'); return result(); }, now: () => 5_000_000, log: m => logs.push(m) });
      assert.deepEqual([out.collected, out.failed, out.skipped], [2, 1, false]);
      assert.deepEqual(db.prepare('SELECT address FROM token_data ORDER BY address').all().map(r => r.address), ['0xaa', '0xcc']); assert.ok(logs.some(l => /0xbb failed: bad/.test(l)));
    }],
    ['stops starting new tokens when the time budget is used up', async ({ runTokenDataTick: tick }) => {
      const db = freshDb(); for (let i = 0; i < 5; i++) seedMarket(db, `m${i}`, 1, '0x' + String(i).repeat(2), `T${i}`, 10 - i);
      let clock = 0; const out = await tick(db, { collect: async () => { clock += 100; return result(); }, now: () => clock, budgetMs: 250, log: () => {} });
      assert.equal(out.collected, 3);
    }],
    ['a good stored record is given to the collector as `previous`; a partial one is not', async ({ runTokenDataTick: tick }) => {
      const db = freshDb(); seedMarket(db, 'm1', 1, '0xaa', 'A', 2); seedMarket(db, 'm2', 1, '0xbb', 'B', 1);
      const rec = (status) => db.prepare('INSERT INTO token_data (chain_id, address, symbol, collected_at, status, coverage, data_json) VALUES (1, ?, ?, 0, ?, 0.9, ?)');
      rec().run('0xaa', 'A', 'ok', JSON.stringify({ marker: 'good' })); rec().run('0xbb', 'B', 'partial', JSON.stringify({ marker: 'thin' }));
      const seen = {}; await tick(db, { collect: async t => { seen[t.address] = t.previous; return result(); }, now: () => 200_000_000, log: () => {} });
      assert.deepEqual(seen, { '0xaa': { marker: 'good' }, '0xbb': null });
    }],
    ['a second tick started while one is running is skipped', async ({ runTokenDataTick: tick }) => {
      const db = freshDb(); seedMarket(db, 'm1', 1, '0xaa', 'A', 1); let release; const gate = new Promise(r => { release = r; });
      const first = tick(db, { collect: async () => { await gate; return result(); }, log: () => {} });
      const second = await tick(db, { collect: async () => result(), log: () => {} });
      release(); assert.deepEqual(second, { collected: 0, failed: 0, skipped: true }); assert.equal((await first).collected, 1);
    }]
  ],
  startTokenDataLoop: [['starts once, refuses a second start, and is off when TOKEN_DATA_DISABLED=1', ({ startTokenDataLoop: start, stopTokenDataLoop: stop }) => {
    try {
      withEnv('1', () => assert.equal(start(freshDb()), false));
      withEnv(undefined, () => { assert.equal(start(freshDb()), true); assert.equal(start(freshDb()), false); stop(); assert.equal(start(freshDb()), true); });
    } finally { stop(); }
  }]],
  stopTokenDataLoop: [['is harmless when nothing runs and lets the loop start again', ({ stopTokenDataLoop: stop, startTokenDataLoop: start }) => {
    try { stop(); stop(); withEnv(undefined, () => assert.equal(start(freshDb()), true)); } finally { stop(); }
  }]]
};
