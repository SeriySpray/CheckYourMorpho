import assert from 'node:assert/strict';
import fs from 'node:fs';

const readFix = name => fs.readFileSync(new URL(`../data/prefetch/${name}`, import.meta.url), 'utf8');

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const PROXY = '0x1111111111111111111111111111111111111111';
const OWNER = '0x5555555555555555555555555555555555555555';

function createMockFetch(routes = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) {
      // Default fallback based on pattern
      if (url.includes('sourcify.dev')) return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => readFix('sourcify_weth.json') };
      if (url.includes('/api/v2/tokens/') && url.includes('/holders')) return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => readFix('blockscout_holders.json') };
      if (url.includes('/api/v2/tokens/')) return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => readFix('blockscout_token.json') };
      if (url.includes('/api/v2/addresses/')) return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => readFix('blockscout_address.json') };
      if (url.includes('coins.llama.fi/prices/current')) return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => readFix('defillama_price.json') };
      if (url.includes('coins.llama.fi/chart')) return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => readFix('defillama_chart.json') };
      if (url.includes('geckoterminal.com') && url.includes('/info')) return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => readFix('gecko_info.json') };
      if (url.includes('geckoterminal.com') && url.includes('/pools')) return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => readFix('gecko_pools.json') };
      if (url.includes('readContract')) return { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<html><body><div>contract info</div></body></html>' };
      if (url.includes('kyberswap.com')) return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => readFix('kyber_route.json') };
      if (url.includes('pendle.finance')) return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => readFix('pendle_active.json') };
      if (url.includes('safe.global')) return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => readFix('safe_multisig.json') };
      return { status: 404, headers: new Headers(), text: async () => 'Not found' };
    }
    if (r.error) throw new Error(r.error);
    const bodyStr = r.body != null ? (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) : '';
    return {
      status: r.status ?? 200,
      headers: new Headers(r.headers || { 'content-type': 'application/json' }),
      text: async () => bodyStr,
      body: new Response(bodyStr).body
    };
  };
  fn.calls = calls;
  return fn;
}

export default {
  MAX_EVIDENCE_BYTES: [
    ['constant is 70,000 bytes', ({ MAX_EVIDENCE_BYTES: b }) => assert.equal(b, 70_000)]
  ],

  MAX_ITEM_CHARS: [
    ['constant is 6,000 chars', ({ MAX_ITEM_CHARS: c }) => assert.equal(c, 6_000)]
  ],

  calcAmountIn: [
    ['computes raw token amount for 18 decimals and given price', ({ calcAmountIn: f }) => {
      // 100,000 USD at $2,500/token with 18 decimals = 40 * 10^18
      assert.equal(f(100_000, 2500, 18), '40000000000000000000');
      // 1,000,000 USD at $2,500/token = 400 * 10^18
      assert.equal(f(1_000_000, 2500, 18), '400000000000000000000');
    }],
    ['computes raw token amount for 6 decimals (e.g. USDC)', ({ calcAmountIn: f }) => {
      // 100,000 USD at $1.00 = 100,000 * 10^6
      assert.equal(f(100_000, 1.0, 6), '100000000000');
    }],
    ['returns null on missing or invalid inputs', ({ calcAmountIn: f }) => {
      assert.equal(f(null, 2500, 18), null);
      assert.equal(f(100_000, 0, 18), null);
      assert.equal(f(100_000, -10, 18), null);
      assert.equal(f(100_000, 2500, null), null);
      assert.equal(f(100_000, NaN, 18), null);
      assert.equal(f(100_000, 2500, 1.5), null);
    }]
  ],

  trimEvidence: [
    ['JSON: removes null, undefined, and empty string properties', ({ trimEvidence: f }) => {
      const input = { a: 'ok', b: null, c: undefined, d: '', e: { sub: 'yes', empty: null } };
      const out = JSON.parse(f(input, 'application/json'));
      assert.deepEqual(out, { a: 'ok', e: { sub: 'yes' } });
    }],
    ['JSON: trims arrays longer than 12 items', ({ trimEvidence: f }) => {
      const arr = Array.from({ length: 20 }, (_, i) => ({ idx: i + 1 }));
      const out = JSON.parse(f({ items: arr }, 'application/json'));
      assert.equal(out.items.length, 12);
      assert.equal(out.items[0].idx, 1);
      assert.equal(out.items[11].idx, 12);
    }],
    ['HTML: strips script, style, tags and collapses whitespace', ({ trimEvidence: f }) => {
      const html = '<html><head><style>body { color: red; }</style><script>alert(1);</script></head><body><h1>Title</h1> <p>Hello   world &amp; friends &nbsp;!</p></body></html>';
      const out = f(html, 'text/html');
      assert.equal(out, 'Title Hello world & friends !');
    }],
    ['always enforces MAX_ITEM_CHARS limit', ({ trimEvidence: f, MAX_ITEM_CHARS: max }) => {
      const longText = 'x'.repeat(max + 1000);
      assert.equal(f(longText).length, max);
      const longJson = JSON.stringify({ a: 'y'.repeat(max + 500) });
      assert.equal(f(longJson, 'application/json').length, max);
    }],
    ['handles empty and null inputs safely', ({ trimEvidence: f }) => {
      assert.equal(f(null), '');
      assert.equal(f(undefined), '');
      assert.equal(f(''), '');
    }]
  ],

  buildEvidencePlan: [
    ['plan for chain 1 (ethereum) includes 9 phase 1 requests with correct host endpoints', ({ buildEvidencePlan: f }) => {
      const plan = f({ chainId: 1, address: WETH, symbol: 'WETH' });
      assert.equal(plan.length, 9);
      assert.ok(plan.every(p => p.phase === 1));
      assert.ok(plan[0].url.includes('sourcify.dev/server/v2/contract/1/' + WETH));
      assert.ok(plan[1].url.includes('eth.blockscout.com/api/v2/tokens/' + WETH));
      assert.ok(plan[2].url.includes('eth.blockscout.com/api/v2/addresses/' + WETH));
      assert.ok(plan[3].url.includes('eth.blockscout.com/api/v2/tokens/' + WETH + '/holders'));
      assert.ok(plan[4].url.includes('coins.llama.fi/prices/current/ethereum:' + WETH));
      assert.ok(plan[5].url.includes('coins.llama.fi/chart/ethereum:' + WETH));
      assert.ok(plan[6].url.includes('api.geckoterminal.com/api/v2/networks/eth/tokens/' + WETH + '/info'));
      assert.ok(plan[7].url.includes('api.geckoterminal.com/api/v2/networks/eth/tokens/' + WETH + '/pools'));
      assert.ok(plan[8].url.includes('etherscan.io/readContract?m=light&a=' + WETH + '&n=mainnet'));
    }],
    ['plan for chain 8453 (base) and chain 42161 (arbitrum) use respective host mappings', ({ buildEvidencePlan: f }) => {
      const basePlan = f({ chainId: 8453, address: WETH, symbol: 'WETH' });
      assert.ok(basePlan[1].url.includes('base.blockscout.com'));
      assert.ok(basePlan[8].url.includes('basescan.org/readContract?m=light&a=' + WETH + '&n=base'));

      const arbPlan = f({ chainId: 42161, address: WETH, symbol: 'WETH' });
      assert.ok(arbPlan[1].url.includes('arbitrum.blockscout.com'));
      assert.ok(arbPlan[8].url.includes('arbiscan.io/readContract?m=light&a=' + WETH + '&n=arbitrum'));
    }],
    ['PT tokens include Pendle active markets in phase 2', ({ buildEvidencePlan: f }) => {
      const plan = f({ chainId: 1, address: WETH, symbol: 'PT-ezETH-26DEC2024' });
      assert.equal(plan.length, 10);
      const pendle = plan[9];
      assert.equal(pendle.phase, 2);
      assert.equal(pendle.label, 'pendle: active markets');
      assert.ok(pendle.url.includes('api-v2.pendle.finance/core/v1/1/markets/active'));
    }],
    ['unknown chain returns empty plan []', ({ buildEvidencePlan: f }) => {
      assert.deepEqual(f({ chainId: 99999, address: WETH }), []);
      assert.deepEqual(f({ chainId: 10, address: WETH }), []);
      assert.deepEqual(f({ chainId: 137, address: WETH }), []);
    }],
    ['invalid address returns empty plan []', ({ buildEvidencePlan: f }) => {
      assert.deepEqual(f({ chainId: 1, address: '0xinvalid' }), []);
      assert.deepEqual(f({ chainId: 1, address: '0x123' }), []);
      assert.deepEqual(f({ chainId: 1, address: null }), []);
    }]
  ],

  prefetchEvidence: [
    ['full prefetch run on mock fetch produces ordered evidence items with IDs', async ({ prefetchEvidence: f }) => {
      const mockFetch = createMockFetch();
      const items = await f({ chainId: 1, address: WETH, symbol: 'WETH' }, {
        fetchImpl: mockFetch,
        sleep: async () => {},
        log: () => {}
      });
      assert.ok(items.length >= 9);
      assert.equal(items[0].id, 1);
      assert.equal(items[0].label, 'sourcify: contract');
      assert.equal(items[0].status, 200);
      assert.ok(items.every((it, idx) => it.id === idx + 1));
      // Kyber items produced since price and decimals are in fixtures
      const kyber = items.find(i => i.label.includes('kyber: swap 100k USD'));
      assert.ok(kyber);
      assert.equal(kyber.status, 200);
      assert.match(kyber.text, /"amountOutUsd":"?99873/); assert.match(kyber.text, /pmm-13\/uniswapv3/);
    }],
    ['pauses between requests to the same host respect host delay limits', async ({ prefetchEvidence: f }) => {
      const slept = [];
      const mockFetch = createMockFetch();
      await f({ chainId: 1, address: WETH, symbol: 'WETH' }, {
        fetchImpl: mockFetch,
        sleep: async ms => { slept.push(ms); },
        log: () => {}
      });
      // Blockscout has 3 requests in Phase 1 -> at least two 300ms delays
      assert.ok(slept.includes(300), 'includes 300ms delay');
      // GeckoTerminal has 2 requests in Phase 1 -> 6000ms delay
      assert.ok(slept.includes(6000), 'includes 6000ms delay for geckoterminal');
      // Kyber has 2 requests -> 1000ms delay
      assert.ok(slept.includes(1000), 'includes 1000ms delay for kyber');
    }],
    ['HTTP 429 retries once after 5s and sets rate limited status if persistent', async ({ prefetchEvidence: f }) => {
      const slept = [];
      const url429 = `https://sourcify.dev/server/v2/contract/1/${WETH}?fields=compilation,proxyResolution,deployment`;
      let attempts = 0;
      const mockFetch = createMockFetch({
        [url429]: {
          status: 429,
          get body() { attempts++; return 'rate limit exceeded'; }
        }
      });
      const items = await f({ chainId: 1, address: WETH, symbol: 'WETH' }, {
        fetchImpl: mockFetch,
        sleep: async ms => { slept.push(ms); },
        log: () => {}
      });
      assert.ok(slept.includes(5000), 'waited 5s on 429');
      const sourcifyItem = items.find(i => i.label === 'sourcify: contract');
      assert.equal(sourcifyItem.status, 429);
      assert.equal(sourcifyItem.text, 'rate limited');
    }],
    ['network error on one endpoint does not fail prefetch and sets status 0', async ({ prefetchEvidence: f }) => {
      const urlFail = `https://eth.blockscout.com/api/v2/tokens/${WETH}/holders`;
      const mockFetch = createMockFetch({
        [urlFail]: { error: 'connection reset by peer' }
      });
      const items = await f({ chainId: 1, address: WETH, symbol: 'WETH' }, {
        fetchImpl: mockFetch,
        sleep: async () => {},
        log: () => {}
      });
      const holderItem = items.find(i => i.label === 'blockscout: holders');
      assert.equal(holderItem.status, 0);
      assert.ok(holderItem.text.includes('connection reset'));
    }],
    ['Phase 2: implementation detection triggers implementation readContract', async ({ prefetchEvidence: f }) => {
      const sourcifyUrl = `https://sourcify.dev/server/v2/contract/1/${WETH}?fields=compilation,proxyResolution,deployment`;
      const implUrl = `https://etherscan.io/readContract?m=light&a=${WETH}&n=mainnet&v=${PROXY}`;
      const mockFetch = createMockFetch({
        [sourcifyUrl]: {
          status: 200,
          body: readFix('sourcify_proxy.json')
        },
        [implUrl]: {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html><body>impl logic</body></html>'
        }
      });
      const items = await f({ chainId: 1, address: WETH, symbol: 'PROXY' }, {
        fetchImpl: mockFetch,
        sleep: async () => {},
        log: () => {}
      });
      const implItem = items.find(i => i.label.includes('explorer: read implementation'));
      assert.ok(implItem);
      assert.equal(implItem.status, 200);
      assert.ok(implItem.url.includes(`&v=${PROXY}`));
    }],
    ['Phase 2: owner detection in readContract triggers Blockscout address and Safe multisig', async ({ prefetchEvidence: f }) => {
      const expUrl = `https://etherscan.io/readContract?m=light&a=${WETH}&n=mainnet`;
      const safeUrl = `https://api.safe.global/tx-service/eth/api/v1/safes/${OWNER}/`;
      const bsOwnerUrl = `https://eth.blockscout.com/api/v2/addresses/${OWNER}`;
      const mockFetch = createMockFetch({
        [expUrl]: {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `<div>Contract owner() returns (address ${OWNER})</div>`
        },
        [safeUrl]: {
          status: 200,
          body: readFix('safe_multisig.json')
        },
        [bsOwnerUrl]: {
          status: 200,
          body: JSON.stringify({ name: 'OwnerMultisig', implementations: [], is_contract: true })
        }
      });
      const items = await f({ chainId: 1, address: WETH, symbol: 'WETH' }, {
        fetchImpl: mockFetch,
        sleep: async () => {},
        log: () => {}
      });
      const bsItem = items.find(i => i.label === `blockscout: address ${OWNER}`);
      assert.ok(bsItem);
      assert.equal(bsItem.status, 200);

      const safeItem = items.find(i => i.label === `safe: ${OWNER}`);
      assert.ok(safeItem);
      assert.equal(safeItem.status, 200);
      assert.ok(safeItem.text.includes('"threshold":2'));
    }],
    ['Phase 2: Safe 404 is handled gracefully with status 404 and not a Safe multisig', async ({ prefetchEvidence: f }) => {
      const expUrl = `https://etherscan.io/readContract?m=light&a=${WETH}&n=mainnet`;
      const safeUrl = `https://api.safe.global/tx-service/eth/api/v1/safes/${OWNER}/`;
      const mockFetch = createMockFetch({
        [expUrl]: {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `<div>owner: ${OWNER}</div>`
        },
        [safeUrl]: {
          status: 404,
          body: 'Not found'
        }
      });
      const items = await f({ chainId: 1, address: WETH, symbol: 'WETH' }, {
        fetchImpl: mockFetch,
        sleep: async () => {},
        log: () => {}
      });
      const safeItem = items.find(i => i.label === `safe: ${OWNER}`);
      assert.ok(safeItem);
      assert.equal(safeItem.status, 404);
      assert.equal(safeItem.text, 'not a Safe multisig');
    }],
    ['Phase 2: Pendle market found vs not found', async ({ prefetchEvidence: f }) => {
      // 1. Found
      const sourcifyUrl = `https://sourcify.dev/server/v2/contract/1/${WETH}?fields=compilation,proxyResolution,deployment`;
      const mockFetchFound = createMockFetch({
        [sourcifyUrl]: { status: 200, body: readFix('sourcify_pendle.json') },
        'https://api-v2.pendle.finance/core/v1/1/markets/active': { status: 200, body: readFix('pendle_active.json') }
      });
      const items1 = await f({ chainId: 1, address: WETH, symbol: 'PT-WETH' }, {
        fetchImpl: mockFetchFound,
        sleep: async () => {},
        log: () => {}
      });
      const pendle1 = items1.find(i => i.label === 'pendle: market');
      assert.ok(pendle1);
      assert.equal(pendle1.status, 200);
      assert.ok(pendle1.text.includes('impliedApy'));

      // 2. Not found
      const mockFetchNotFound = createMockFetch({
        [sourcifyUrl]: { status: 200, body: readFix('sourcify_pendle.json') },
        'https://api-v2.pendle.finance/core/v1/1/markets/active': { status: 200, body: JSON.stringify([]) }
      });
      const items2 = await f({ chainId: 1, address: WETH, symbol: 'PT-WETH' }, {
        fetchImpl: mockFetchNotFound,
        sleep: async () => {},
        log: () => {}
      });
      const pendle2 = items2.find(i => i.label === 'pendle: market');
      assert.ok(pendle2);
      assert.equal(pendle2.status, 200);
      assert.equal(pendle2.text, 'no active Pendle market for this PT');
    }],
    ['skips Kyber with status 0 item if price or decimals is missing', async ({ prefetchEvidence: f }) => {
      const dlPriceUrl = `https://coins.llama.fi/prices/current/ethereum:${WETH}`;
      const mockFetch = createMockFetch({
        [dlPriceUrl]: { status: 404, body: 'price not found' }
      });
      const items = await f({ chainId: 1, address: WETH, symbol: 'WETH' }, {
        fetchImpl: mockFetch,
        sleep: async () => {},
        log: () => {}
      });
      const skippedKyber = items.find(i => i.label === 'skipped: no price or decimals');
      assert.ok(skippedKyber);
      assert.equal(skippedKyber.status, 0);
    }],
    ['drops excess items from end when cumulative bytes exceed MAX_EVIDENCE_BYTES', async ({ prefetchEvidence: f, MAX_EVIDENCE_BYTES: maxBytes }) => {
      // Mock sourcify returning nearly maxBytes
      const hugeText = 'z'.repeat(5000); // 5k per item
      const sourcifyUrl = `https://sourcify.dev/server/v2/contract/1/${WETH}?fields=compilation,proxyResolution,deployment`;
      const mockFetch = createMockFetch();
      const items = await f({ chainId: 1, address: WETH, symbol: 'WETH' }, {
        fetchImpl: mockFetch,
        sleep: async () => {},
        log: () => {}
      });
      const totalBytes = items.reduce((acc, it) => acc + Buffer.byteLength(it.text, 'utf8'), 0);
      assert.ok(totalBytes <= maxBytes);
    }],
    ['returns empty array for unknown chain or invalid address without making requests', async ({ prefetchEvidence: f }) => {
      const mockFetch = createMockFetch();
      const r1 = await f({ chainId: 99999, address: WETH }, { fetchImpl: mockFetch });
      assert.deepEqual(r1, []);
      const r2 = await f({ chainId: 1, address: '0xinvalid' }, { fetchImpl: mockFetch });
      assert.deepEqual(r2, []);
      assert.equal(mockFetch.calls.length, 0);
    }]
  ]
};
