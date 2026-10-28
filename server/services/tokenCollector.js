/**
 * Collector of public facts about collateral tokens. For each token it downloads pages and JSON from a fixed set of public
 * sources, parses them (tokenParsers.js) into one data object and stores it in token_data. It makes no judgement: an unknown
 * value stays null. Everything that touches the outside (network, clock, sleeping) comes in through `deps`, so tests never use the network.
 */
import { CONFIG } from '../config.js';
import {
  parseJson, parseSourcify, parseAbiFlags, parseBlockscoutToken, parseBlockscoutAddress, parseBlockscoutCounters, parseBlockscoutContract, parseCreationTx,
  parseHolders, parseLlamaPrice, parseLlamaChart, parseGeckoInfo, parseGeckoPools, parseKyber, parseReadContract, controllerAddresses,
  parseSafe, parsePendleMarket, parseFeeds, parseRwa, parseRpcAddress, parseRpcUint, parseRpcString, parseRpcBigUint, parseRpcArrayLength, parseSharePrice, parsePtExpiry
} from './tokenParsers.js';

const HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; CheckYourMorpho/1.0)', accept: 'text/html,application/json;q=0.9,*/*;q=0.5' };
const FETCH_TIMEOUT_MS = 30000; // Blockscout answers slowly for some chains
const MAX_BODY_BYTES = 1024 * 1024;
const CONTRACT_MAX_BYTES = 4 * 1024 * 1024; // a Blockscout contract record carries the whole source code
const FEEDS_MAX_BYTES = 6 * 1024 * 1024; // the Arbitrum feed catalog is about 3 MB
const FEEDS_TTL_MS = 6 * 3600e3;
const HISTORY_KEEP = 20;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const KYBER_SIZES_USD = [100000, 1000000];
// EIP-1967 storage slots of a proxy: keccak256('eip1967.proxy.admin') - 1 and keccak256('eip1967.proxy.implementation') - 1
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
// Delay of a timelock: getMinDelay() of OpenZeppelin TimelockController, then delay() of the Compound Timelock
const TIMELOCK_SELECTORS = ['0xf27a0c92', '0x6a42b8f8'];
const MIN_STATUS_OK_COVERAGE = 0.4;
// eth_call selectors read on a chain that has a public JSON-RPC but no Blockscout (the explorer pages are not reachable there)
const SEL = { name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', totalSupply: '0x18160ddd', owner: '0x8da5cb5b', getThreshold: '0xe75235b8', getOwners: '0xa0e67e2b' };
// EIP-7702 delegation: the account code is 0xef0100 followed by the delegate address
const EIP7702_PREFIX = '0xef0100';

// Blockscout PRO API (api.blockscout.com/<chainId>/api/v2): the way to a chain whose own Blockscout sits behind a Cloudflare challenge.
// It needs a free key, read from BLOCKSCOUT_API_KEY; without it such a chain keeps only its JSON-RPC and the other sources.
const PRO_KEY_RE = /^proapi_[A-Za-z0-9_-]{20,}$/;
const blockscoutKey = () => (PRO_KEY_RE.test(process.env.BLOCKSCOUT_API_KEY ?? '') ? process.env.BLOCKSCOUT_API_KEY : null);
const PRO_HOST = 'api.blockscout.com';
/** Base URL of a chain's Blockscout REST API, or null when it has none the collector may reach. */
const bsBase = c => (c?.blockscoutPro ? (blockscoutKey() ? `https://${PRO_HOST}/${c.blockscoutPro}/api/v2` : null) : c?.blockscout ? `https://${c.blockscout}.blockscout.com/api/v2` : null);
/** True when the owner and the proxy admin are read over JSON-RPC: a chain without an explorer, or one that asks for it. */
const readsOverRpc = c => Boolean(c?.rpc && (c.rpcControl || !bsBase(c)));

// Names the sources use for each supported chain. A missing key means the chain has no such source and that part stays unknown.
// Chains not listed here get Sourcify only.
export const CHAINS = {
  1: { blockscout: 'eth', llama: 'ethereum', gecko: 'eth', kyber: 'ethereum', safe: 'eth', explorer: 'etherscan.io', n: 'mainnet', feeds: 'feeds-mainnet.json',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', rpc: 'ethereum-rpc.publicnode.com' },
  8453: { blockscout: 'base', llama: 'base', gecko: 'base', kyber: 'base', safe: 'base', explorer: 'basescan.org', n: 'base', feeds: 'feeds-ethereum-mainnet-base-1.json',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', rpc: 'base-rpc.publicnode.com' },
  42161: { blockscout: 'arbitrum', llama: 'arbitrum', gecko: 'arbitrum', kyber: 'arbitrum', safe: 'arb1', explorer: 'arbiscan.io', n: 'arbitrum', feeds: 'feeds-ethereum-mainnet-arbitrum-1.json',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', rpc: 'arbitrum-one-rpc.publicnode.com' },
  10: { blockscout: 'optimism', llama: 'optimism', gecko: 'optimism', kyber: 'optimism', usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', rpc: 'optimism-rpc.publicnode.com' },
  137: { blockscout: 'polygon', llama: 'polygon', gecko: 'polygon_pos', kyber: 'polygon', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', rpc: 'polygon-bor-rpc.publicnode.com' },
  130: { blockscout: 'unichain', llama: 'unichain', gecko: 'unichain', kyber: 'unichain', usdc: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', rpc: 'unichain-rpc.publicnode.com' },
  143: { llama: 'monad', gecko: 'monad', kyber: 'monad', usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' },
  999: { llama: 'hyperliquid', gecko: 'hyperevm', kyber: 'hyperevm', usdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f' },
  747474: { llama: 'katana', gecko: 'katana' },
  4663: { llama: 'robinhood', gecko: 'robinhood', rpc: 'rpc.mainnet.chain.robinhood.com', blockscoutPro: 4663, rpcControl: true }, // Robinhood Chain: its own Blockscout is behind a Cloudflare challenge; holders and source come from the PRO API when a key is set, the owner and proxy admin over JSON-RPC
  480: { llama: 'wc', gecko: 'world-chain' },
  988: { llama: 'stable', gecko: 'stable', rpc: 'rpc.stable.xyz' },
  4217: { llama: 'tempo', gecko: 'tempo', rpc: 'tempo-rpc.publicnode.com' },
  // Arc pays gas in USDC; its ERC-20 face sits at the 0x36.. system address
  5042: { llama: 'arc', gecko: 'arc', kyber: 'arc', usdc: '0x3600000000000000000000000000000000000000', rpc: 'arc-rpc.publicnode.com' }
};

const HOSTS = ['sourcify.dev', 'coins.llama.fi', 'api.geckoterminal.com', 'aggregator-api.kyberswap.com', 'api.safe.global', 'api-v2.pendle.finance',
  'reference-data-directory.vercel.app', 'app.rwa.xyz', 'etherscan.io', 'basescan.org', 'arbiscan.io', ...Object.values(CHAINS).map(c => c.rpc).filter(Boolean)];

/** True for an https URL on one of the collector's hosts (Blockscout instances included). */
export function isCollectorUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && (HOSTS.includes(u.hostname) || u.hostname.endsWith('.blockscout.com'));
}

// Pause between two requests to one host, so a free API does not answer 429
const HOST_DELAY_MS = { 'api.geckoterminal.com': 6000, 'api.safe.global': 1500, 'aggregator-api.kyberswap.com': 1000 };

/** Raw amount of a token worth `usd` dollars: usd / price * 10^decimals as an integer string, or null when it cannot be computed. */
export function calcAmountIn(usd, priceUsd, decimals) {
  const dec = Number(decimals);
  if (!(usd > 0) || !(priceUsd > 0) || !Number.isFinite(priceUsd) || !Number.isInteger(dec) || dec < 0 || dec > 36) return null;
  const [whole, frac = ''] = (usd / priceUsd).toFixed(Math.min(dec, 8)).split('.');
  const raw = BigInt(whole) * 10n ** BigInt(dec) + BigInt(frac.padEnd(dec, '0').slice(0, dec) || 0);
  return raw > 0n ? raw.toString() : null;
}

/** Every source URL of a token. Built only from templates and a checked address, never from data read from a page. */
export function sourceUrls(chainId, address, { implementation = null, amountIn = null } = {}) {
  const c = CHAINS[chainId];
  const a = String(address).toLowerCase();
  const fields = 'abi,compilation,proxyResolution,deployment';
  const out = { sourcify: `https://sourcify.dev/server/v2/contract/${chainId}/${a}?fields=${fields}` };
  if (implementation) out.sourcifyImpl = `https://sourcify.dev/server/v2/contract/${chainId}/${implementation}?fields=${fields}`;
  if (!c) return out;
  const bs = bsBase(c);
  if (bs) {
    Object.assign(out, { bsToken: `${bs}/tokens/${a}`, bsAddress: `${bs}/addresses/${a}`, bsHolders: `${bs}/tokens/${a}/holders`, bsCounters: `${bs}/tokens/${a}/counters`,
      bsContract: `${bs}/smart-contracts/${a}` });
    if (implementation) out.bsContractImpl = `${bs}/smart-contracts/${implementation}`;
  }
  Object.assign(out, { llamaPrice: `https://coins.llama.fi/prices/current/${c.llama}:${a}`, llamaChart: `https://coins.llama.fi/chart/${c.llama}:${a}?span=30&period=1d`,
    pendle: `https://api-v2.pendle.finance/core/v1/${chainId}/markets/active` });
  if (c.gecko) {
    out.geckoInfo = `https://api.geckoterminal.com/api/v2/networks/${c.gecko}/tokens/${a}/info`;
    out.geckoPools = `https://api.geckoterminal.com/api/v2/networks/${c.gecko}/tokens/${a}/pools`;
  }
  if (c.explorer) {
    out.explorer = `https://${c.explorer}/readContract?m=light&a=${a}&n=${c.n}`;
    if (implementation) out.explorerImpl = `${out.explorer}&v=${implementation}`;
  }
  if (c.feeds) out.feeds = `https://reference-data-directory.vercel.app/${c.feeds}`;
  if (c.rpc) out.rpc = `https://${c.rpc}/`;
  if (amountIn && c.kyber && c.usdc) out.kyber = `https://aggregator-api.kyberswap.com/${c.kyber}/api/v1/routes?tokenIn=${a}&tokenOut=${c.usdc}&amountIn=${amountIn}&source=cym`;
  return out;
}

const bsAddressUrl = (chainId, a) => `${bsBase(CHAINS[chainId])}/addresses/${a}`;
const bsTxUrl = (chainId, h) => `${bsBase(CHAINS[chainId])}/transactions/${h}`;
// The Safe service refuses an address that is not in EIP-55 form (422), so a controller keeps the spelling the explorer page gave
const safeUrl = (chainId, a) => `https://api.safe.global/tx-service/${CHAINS[chainId].safe}/api/v1/safes/${a}/`;
const rwaUrl = symbol => `https://app.rwa.xyz/assets/${encodeURIComponent(symbol)}`;

async function readLimited(res, max) {
  if (!res.body?.getReader) return String(await res.text?.() ?? '').slice(0, max);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

/**
 * Network layer: one request at a time per host with a pause after it, a timeout, a body limit and one retry after a 429 or a 502/503/504.
 * A GET by default; with `body` a JSON POST (JSON-RPC). A failure is a result (`status` 0 and `error`), never an exception.
 * @returns {{get(url:string, opts?:{maxBytes?:number, body?:string}):Promise<{status:number, text:string, ms:number, error?:string}>}}
 */
export function createFetcher({ fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), hostDelayMs = HOST_DELAY_MS } = {}) {
  const tails = new Map();
  async function once(url, maxBytes, body) {
    const init = body === undefined ? { headers: HEADERS } : { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body };
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return { status: res.status, text: res.status === 429 ? '' : await readLimited(res, maxBytes) };
  }
  async function get(url, { maxBytes = MAX_BODY_BYTES, body } = {}) {
    const t0 = Date.now();
    if (!isCollectorUrl(url)) return { status: 0, text: '', ms: 0, error: 'url is not allowed' };
    const host = new URL(url).hostname;
    // The PRO key is added here, at the last moment, so it never reaches a stored source URL or a log line
    const reqUrl = host === PRO_HOST && blockscoutKey() ? `${url}${url.includes('?') ? '&' : '?'}apikey=${blockscoutKey()}` : url;
    const prev = tails.get(host) ?? Promise.resolve();
    let release;
    tails.set(host, new Promise(r => { release = r; }));
    await prev;
    try {
      let r = await once(reqUrl, maxBytes, body);
      if (r.status === 429) { await sleep(10000); r = await once(reqUrl, maxBytes, body); }
      else if ([502, 503, 504].includes(r.status)) { await sleep(3000); r = await once(reqUrl, maxBytes, body); }
      return { ...r, ms: Date.now() - t0, ...(r.status === 429 ? { error: 'rate limited' } : {}) };
    } catch (err) {
      return { status: 0, text: '', ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 120) };
    } finally {
      try { await sleep(hostDelayMs[host] ?? 300); } finally { release(); }
    }
  }
  return { get };
}

// Feed catalogs are big and change rarely: keep only what the parser needs, for a few hours
const feedCache = new Map();

async function loadFeeds(chainId, fetcher, nowMs) {
  const hit = feedCache.get(chainId);
  if (hit && nowMs - hit.at < FEEDS_TTL_MS) return { feeds: hit.feeds, status: 200, ms: 0 };
  const r = await fetcher.get(sourceUrls(chainId, ZERO_ADDRESS).feeds, { maxBytes: FEEDS_MAX_BYTES });
  const j = r.status === 200 ? parseJson(r.text) : null;
  if (!Array.isArray(j)) return { feeds: null, status: r.status, ms: r.ms, error: r.error };
  const feeds = j.map(f => ({ name: f.name, feedCategory: f.feedCategory, heartbeat: f.heartbeat, threshold: f.threshold, proxyAddress: f.proxyAddress,
    docs: { baseAsset: f.docs?.baseAsset, productType: f.docs?.productType } }));
  feedCache.set(chainId, { at: nowMs, feeds });
  return { feeds, status: 200, ms: r.ms };
}

/** Empties the in-memory feed catalog cache (used by tests). */
export function clearFeedCache() { feedCache.clear(); }

/** Counts the leaf slots of a data object and how many of them hold a value; a group that does not apply to the token (null pendle or rwa) is left out. */
export function countFields(data) {
  let total = 0, filled = 0;
  const walk = v => {
    if (v && typeof v === 'object' && !Array.isArray(v)) { for (const x of Object.values(v)) walk(x); return; }
    total++;
    if (Array.isArray(v) ? v.length : v !== null && v !== undefined) filled++;
  };
  for (const [k, v] of Object.entries(data)) if (!(v === null && (k === 'pendle' || k === 'rwa'))) walk(v);
  return { filled, total, coverage: total ? Math.round((filled / total) * 1000) / 1000 : 0 };
}

/**
 * Collects the data of one token.
 * @param {{chainId:number, address:string, symbol?:string|null}} token
 * @param {{fetcher?:object, now?:()=>number, log?:Function}} deps
 * @returns {Promise<{status:'ok'|'partial'|'failed', coverage:number, data:object}>}
 */
export async function collectTokenData(token, { fetcher = createFetcher(), now = Date.now, log = () => {} } = {}) {
  const chainId = Number(token.chainId);
  const address = String(token.address ?? '').toLowerCase();
  if (!ADDR_RE.test(address)) throw new Error('invalid token address');
  const c = CHAINS[chainId];
  const bs = bsBase(c);
  const rpcRead = readsOverRpc(c);
  const urls = sourceUrls(chainId, address);
  const sources = [];
  const fetchSource = async (key, url, opts) => {
    const r = await fetcher.get(url, opts);
    sources.push({ key, url, status: r.status, ms: r.ms, error: r.error ?? (r.status && r.status !== 200 ? `HTTP ${r.status}` : null) });
    return r;
  };
  const json = r => (r?.status === 200 ? parseJson(r.text) : null);
  const rpc = (key, method, params) => fetchSource(key, urls.rpc, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const prev = token.previous && typeof token.previous === 'object' ? token.previous : null;

  // Phase 1: independent sources; one host is read in order, different hosts at the same time.
  // A good record younger than `stableRefreshSec` is first checked by the cheap signals of a change (proxy slots, read page, who holds the keys);
  // when they are the same, the slow facts (source, creation, controllers, RWA) are taken from the stored record instead of being read again.
  const p1 = {};
  let reuse = false;
  const group = {
    rpc: async () => {
      if (!c?.rpc) return;
      p1.slotAdmin = await rpc('rpc_admin_slot', 'eth_getStorageAt', [address, ADMIN_SLOT, 'latest']);
      p1.slotImpl = await rpc('rpc_impl_slot', 'eth_getStorageAt', [address, IMPL_SLOT, 'latest']);
      if (!rpcRead) return;
      const call = (key, data) => rpc(key, 'eth_call', [{ to: address, data }, 'latest']);
      p1.rpcOwner = await call('rpc_owner', SEL.owner);
      p1.rpcName = await call('rpc_name', SEL.name);
      p1.rpcDecimals = await call('rpc_decimals', SEL.decimals);
      p1.rpcSupply = await call('rpc_total_supply', SEL.totalSupply);
    },
    sourcify: async () => { if (!reuse) p1.sourcify = await fetchSource('sourcify', urls.sourcify); },
    blockscout: async () => {
      if (!bs) return;
      p1.bsToken = await fetchSource('blockscout_token', urls.bsToken);
      if (!reuse) p1.bsAddress = await fetchSource('blockscout_address', urls.bsAddress);
      p1.bsHolders = await fetchSource('blockscout_holders', urls.bsHolders);
      p1.bsCounters = await fetchSource('blockscout_counters', urls.bsCounters);
    },
    llama: async () => {
      if (!c) return;
      p1.llamaPrice = await fetchSource('llama_price', urls.llamaPrice);
      p1.llamaChart = await fetchSource('llama_chart', urls.llamaChart);
    },
    gecko: async () => {
      if (!c?.gecko) return;
      p1.geckoInfo = await fetchSource('gecko_info', urls.geckoInfo);
      p1.geckoPools = await fetchSource('gecko_pools', urls.geckoPools);
    },
    explorer: async () => { if (c?.explorer) p1.explorer = await fetchSource('explorer_read', urls.explorer); }
  };
  const fingerprint = () => {
    const rv = parseReadContract(p1.explorer?.status === 200 ? p1.explorer.text : '') ?? {};
    const key = [parseRpcAddress(json(p1.slotAdmin)), parseRpcAddress(json(p1.slotImpl)), rv.implementation ?? null, controllerAddresses(rv).map(x => `${x.role}:${x.address}`)];
    return JSON.stringify(rpcRead ? [...key, parseRpcAddress(json(p1.rpcOwner))] : key);
  };
  const cheap = ['rpc', 'explorer'];
  if (prev) {
    await Promise.all(cheap.map(k => group[k]()));
    // shortcut: a controller that changes only on the implementation's read page is noticed at the weekly refresh
    reuse = Boolean(c && prev.contract && prev.control && prev.meta?.stable_fp && Math.floor(now() / 1000) - (prev.meta.stable_at ?? 0) < CONFIG.tokenData.stableRefreshSec && fingerprint() === prev.meta.stable_fp);
  }
  await Promise.all(Object.entries(group).filter(([k]) => !(prev && cheap.includes(k))).map(([, f]) => f()));
  const stableFp = fingerprint();

  const llamaKey = `${c?.llama}:${address}`;
  const sourcify = parseSourcify(json(p1.sourcify));
  const bsToken = parseBlockscoutToken(json(p1.bsToken));
  const bsAddress = parseBlockscoutAddress(json(p1.bsAddress));
  const price = parseLlamaPrice(json(p1.llamaPrice), llamaKey);
  const chart = parseLlamaChart(json(p1.llamaChart), llamaKey);
  const gInfo = parseGeckoInfo(json(p1.geckoInfo));
  const gPools = parseGeckoPools(json(p1.geckoPools));
  const holders = parseHolders(json(p1.bsHolders), bsToken?.total_supply ?? null);
  const readValues = { ...(parseReadContract(p1.explorer?.status === 200 ? p1.explorer.text : '') ?? {}) };
  const slotAdmin = parseRpcAddress(json(p1.slotAdmin));
  const slotImpl = parseRpcAddress(json(p1.slotImpl));
  const impl = (reuse ? prev.contract.implementations?.[0]?.address ?? slotImpl : sourcify?.implementations?.[0]?.address ?? bsAddress?.implementations?.[0]?.address ?? slotImpl) || null;
  const symbol = token.symbol || bsToken?.symbol || price?.symbol || null;
  const rpcDecimals = parseRpcUint(json(p1.rpcDecimals));
  const decimals = bsToken?.decimals ?? (rpcDecimals !== null && rpcDecimals <= 36 ? rpcDecimals : null) ?? price?.decimals ?? null;

  // A contract Sourcify does not know: take the name and ABI from Blockscout, which verifies on its own
  let contractName = reuse ? prev.identity?.contract_name ?? null : sourcify?.contract_name ?? null;
  let abi = sourcify?.abi ?? null;
  if (!reuse && !abi && bs) {
    const bc = parseBlockscoutContract(json(await fetchSource('blockscout_contract', urls.bsContract, { maxBytes: CONTRACT_MAX_BYTES })));
    contractName ??= bc?.contract_name ?? null;
    abi = bc?.abi ?? null;
  }

  // Phase 2: sources that depend on phase 1
  const p2 = {};
  const kyber = {};
  const tasks = [];
  const implUrls = impl && ADDR_RE.test(impl) ? sourceUrls(chainId, address, { implementation: impl }) : null;
  if (implUrls) {
    if (!reuse) tasks.push(async () => { p2.sourcifyImpl = await fetchSource('sourcify_impl', implUrls.sourcifyImpl); });
    if (c?.explorer) tasks.push(async () => { p2.explorerImpl = await fetchSource('explorer_read_impl', implUrls.explorerImpl); });
  }
  if (!reuse && bs && bsAddress?.creation_tx) tasks.push(async () => { p2.creationTx = await fetchSource('blockscout_creation_tx', bsTxUrl(chainId, bsAddress.creation_tx)); });
  if (c?.kyber && c.usdc) {
    tasks.push(async () => {
      const skip = (status, reason) => ({ status, price_impact_pct: null, out_usd: null, kyber_in_usd: null, gas_usd: null, dexes: [], reason });
      for (const usd of KYBER_SIZES_USD) {
        // USDC is the quote asset of the swap, so selling it for itself means nothing
        if (address === c.usdc.toLowerCase()) { kyber[usd] = skip('na', 'token is the quote asset (USDC)'); continue; }
        const amountIn = calcAmountIn(usd, price?.usd, decimals);
        if (!amountIn) { kyber[usd] = skip('error', 'no price or decimals'); continue; }
        const r = await fetchSource(`kyber_${usd}`, sourceUrls(chainId, address, { amountIn }).kyber);
        kyber[usd] = parseKyber(r.status, parseJson(r.text), usd);
        if (r.status === 0 && r.error) kyber[usd].reason = r.error;
      }
    });
  }
  if (c && contractName === 'PendlePrincipalToken') tasks.push(async () => { p2.pendle = await fetchSource('pendle_markets', urls.pendle); });
  if (c?.feeds) tasks.push(async () => { p2.feeds = await loadFeeds(chainId, fetcher, now()); sources.push({ key: 'chainlink_feeds', url: urls.feeds, status: p2.feeds.status, ms: p2.feeds.ms, error: p2.feeds.error ?? null }); });
  if (!reuse && c && symbol) tasks.push(async () => { p2.rwa = await fetchSource('rwa_xyz', rwaUrl(symbol)); });
  await Promise.all(tasks.map(t => t()));

  const implSourcify = parseSourcify(json(p2.sourcifyImpl));
  let implAbi = implSourcify?.abi ?? null;
  if (!reuse && !implAbi && implUrls?.bsContractImpl) implAbi = parseBlockscoutContract(json(await fetchSource('blockscout_contract_impl', implUrls.bsContractImpl, { maxBytes: CONTRACT_MAX_BYTES })))?.abi ?? null;
  const implValues = parseReadContract(p2.explorerImpl?.status === 200 ? p2.explorerImpl.text : '') ?? {};
  Object.assign(readValues, Object.fromEntries(Object.entries(implValues).filter(([k]) => !(k in readValues))));

  // Phase 3: who controls the contract (owner, admin, the EIP-1967 proxy admin, ...): what kind of address it is, whether it is a Safe,
  // and the delay of a timelock. The Safe service is asked only where it exists (`safe_checked`).
  const controllers = [];
  if (reuse) controllers.push(...prev.control.controllers);
  else if (rpcRead) {
    // No explorer: the owner() and the EIP-1967 proxy admin, each read over JSON-RPC (kind of account, Safe threshold, timelock delay)
    const owner = parseRpcAddress(json(p1.rpcOwner));
    const list = owner ? [{ address: owner, role: 'owner' }] : [];
    if (slotAdmin) {
      const same = list.find(x => x.address === slotAdmin);
      if (same) same.role += ',proxy_admin'; else list.push({ address: slotAdmin, role: 'proxy_admin' });
    }
    for (const ctl of list) {
      const n = controllers.length;
      const call = (key, data) => rpc(`${key}_${n}`, 'eth_call', [{ to: ctl.address, data }, 'latest']);
      const codeRes = json(await rpc(`rpc_code_${n}`, 'eth_getCode', [ctl.address, 'latest']));
      const code = typeof codeRes?.result === 'string' ? codeRes.result : null;
      const delegated = code?.startsWith(EIP7702_PREFIX) ?? false;
      const isContract = code === null ? null : code !== '0x' && !delegated;
      let name = null, safe = null, delay = null;
      if (isContract) {
        name = parseRpcString(json(await call('rpc_account_name', SEL.name)));
        const threshold = parseRpcUint(json(await call('rpc_threshold', SEL.getThreshold)));
        const owners = threshold ? parseRpcArrayLength(json(await call('rpc_owners', SEL.getOwners))) : null;
        safe = threshold && owners ? { threshold, owner_count: owners } : null;
        if (!safe) for (const [i, data] of TIMELOCK_SELECTORS.entries()) {
          delay = parseRpcUint(json(await call(`rpc_timelock_${i}`, data)));
          if (delay !== null) break;
        }
      }
      controllers.push({ address: ctl.address, role: ctl.role, name, is_contract: isContract, implementation_names: [], safe, safe_checked: isContract !== null,
        is_multisig: Boolean(safe), is_eoa_delegated: delegated, timelock_delay_sec: delay });
    }
  } else if (bs) {
    const list = controllerAddresses(readValues);
    if (slotAdmin) {
      const same = list.find(x => x.address.toLowerCase() === slotAdmin);
      if (same) same.role += ',proxy_admin'; else list.push({ address: slotAdmin, role: 'proxy_admin' });
    }
    for (const ctl of list) {
      const n = controllers.length;
      const info = parseBlockscoutAddress(json(await fetchSource(`blockscout_controller_${n}`, bsAddressUrl(chainId, ctl.address))));
      // The Safe service refuses a lower-case address: use the explorer's EIP-55 spelling when it is the same address
      const spelled = info?.address?.toLowerCase() === ctl.address.toLowerCase() ? info.address : ctl.address;
      const s = c.safe ? await fetchSource(`safe_${n}`, safeUrl(chainId, spelled)) : null;
      const implNames = (info?.implementations ?? []).map(i => i.name).filter(Boolean);
      const names = [info?.name, ...implNames].filter(Boolean).join(' ');
      const safe = s ? parseSafe(s.status, parseJson(s.text)) : null;
      let delay = null;
      if (c.rpc && /timelock/i.test(names)) {
        for (const [i, data] of TIMELOCK_SELECTORS.entries()) {
          delay = parseRpcUint(json(await rpc(`rpc_timelock_${n}_${i}`, 'eth_call', [{ to: ctl.address.toLowerCase(), data }, 'latest'])));
          if (delay !== null) break;
        }
      }
      controllers.push({ address: ctl.address, role: ctl.role, name: info?.name ?? null, is_contract: info?.is_contract ?? null,
        implementation_names: implNames, safe, safe_checked: s?.status === 200 || s?.status === 404, is_multisig: Boolean(safe) || /multisig|gnosis|\bsafe/i.test(names),
        is_eoa_delegated: /7702|delegator/i.test(names), timelock_delay_sec: delay });
    }
  }

  const feedData = p2.feeds?.feeds ? parseFeeds(p2.feeds.feeds, symbol) : null;
  const implementations = sourcify?.implementations?.length ? sourcify.implementations : bsAddress?.implementations?.length ? bsAddress.implementations
    : slotImpl ? [{ address: slotImpl, name: null }] : [];
  // A proxy can be upgraded by its admin even when the ABI has no upgrade function (Transparent proxy): known proxy -> true, known plain contract -> false
  const anyProxy = Boolean(sourcify?.is_proxy || slotImpl || bsAddress?.proxy_type || bsAddress?.implementations?.length);
  const upgradeViaProxy = anyProxy ? true : sourcify?.is_proxy === false ? false : null;
  const isPt = contractName === 'PendlePrincipalToken';
  const ptMarket = isPt ? parsePendleMarket(p2.pendle?.status === 200 ? parseJson(p2.pendle.text) : null, address, now()) : null;
  const data = {
    identity: { name: bsToken?.name ?? parseRpcString(json(p1.rpcName)) ?? null, symbol, decimals, total_supply: bsToken?.total_supply ?? parseRpcBigUint(json(p1.rpcSupply)),
      token_type: bsToken?.token_type ?? null, contract_name: contractName },
    contract: reuse ? prev.contract : {
      sourcify_match: sourcify?.sourcify_match ?? null, blockscout_verified: bsAddress?.verified ?? null, is_proxy: anyProxy ? true : sourcify?.is_proxy ?? null,
      proxy_type: sourcify?.proxy_type ?? bsAddress?.proxy_type ?? (slotImpl ? 'EIP1967' : null), implementations,
      deployer: sourcify?.deployer ?? null, creator: bsAddress?.creator ?? null, deployed_at: parseCreationTx(json(p2.creationTx)),
      fn: { ...parseAbiFlags(abi, implAbi), upgrade_via_proxy: upgradeViaProxy }
    },
    control: { read_values: Object.keys(readValues).length ? readValues : null, controllers },
    holders: {
      count: parseBlockscoutCounters(json(p1.bsCounters)) ?? bsToken?.holders_count ?? null,
      top1_pct: holders?.top1_pct ?? null, top10_pct: holders?.top10_pct ?? null, top10_contracts: holders?.top10_contracts ?? null,
      top1_nonprotocol_pct: holders?.top1_nonprotocol_pct ?? null, top10_nonprotocol_pct: holders?.top10_nonprotocol_pct ?? null,
      morpho_blue_pct: holders?.morpho_blue_pct ?? null, top: holders?.top ?? [], gecko_count: gInfo?.holders_count ?? null, gecko_top10_pct: gInfo?.top10_pct ?? null
    },
    price: { usd: price?.usd ?? null, confidence: price?.confidence ?? null, price_ts: price?.price_ts ?? null, chart,
      market_cap_usd: bsToken?.market_cap_usd ?? null, volume_24h_usd: bsToken?.volume_24h_usd ?? null, share_price_assets: parseSharePrice(readValues) },
    liquidity: { pools_count: gPools?.pools_count ?? null, total_reserve_usd: gPools?.total_reserve_usd ?? null, total_volume_24h_usd: gPools?.total_volume_24h_usd ?? null,
      pools: gPools?.pools ?? [], kyber },
    pendle: isPt ? { ...(ptMarket ?? { active: false }), ...parsePtExpiry(ptMarket, readValues, now()) } : null,
    rwa: reuse ? prev.rwa ?? null : p2.rwa?.status === 200 ? parseRwa(p2.rwa.text, address) : null,
    oracle_feeds: { feeds: feedData?.feeds ?? [], has_por_feed: feedData?.has_por_feed ?? null }
  };
  const counts = countFields(data);
  // ok = a price, at least one source about the token itself (Blockscout or GeckoTerminal) and enough of the record filled.
  // partial = a price or at least the identity of the contract; a chain the collector does not support is never ok.
  // A partial or failed token is collected again sooner.
  const hasPrice = price?.usd > 0;
  const hasIdentity = Boolean(data.identity.name || contractName || decimals !== null);
  const status = c && hasPrice && (bsToken || gInfo) && counts.coverage >= MIN_STATUS_OK_COVERAGE ? 'ok'
    : !c || hasPrice || hasIdentity ? 'partial' : 'failed';
  data.meta = { collected_at: Math.floor(now() / 1000), stable_at: reuse ? prev.meta.stable_at : Math.floor(now() / 1000), stable_fp: reuse ? prev.meta.stable_fp : stableFp, chain_supported: Boolean(c), sources, filled: counts.filled, total: counts.total, coverage: counts.coverage };
  log(`  ${chainId}:${address} ${status}, coverage ${counts.coverage}`);
  return { status, coverage: counts.coverage, data };
}

// --- Storage ----------------------------------------------------------------------------------------------------

/** Stores the result as the current record of the token and appends it to the history (the last 20 are kept). */
export function applyTokenData(db, token, result, nowSec) {
  const chainId = Number(token.chainId), address = String(token.address).toLowerCase();
  const json = JSON.stringify(result.data);
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO token_data (chain_id, address, symbol, collected_at, status, coverage, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, address) DO UPDATE SET symbol = excluded.symbol, collected_at = excluded.collected_at, status = excluded.status,
        coverage = excluded.coverage, data_json = excluded.data_json`).run(chainId, address, result.data.identity?.symbol ?? token.symbol ?? null, nowSec, result.status, result.coverage, json);
    db.prepare('INSERT INTO token_data_history (chain_id, address, collected_at, status, data_json) VALUES (?, ?, ?, ?, ?)').run(chainId, address, nowSec, result.status, json);
    db.prepare(`DELETE FROM token_data_history WHERE chain_id = ? AND address = ? AND id NOT IN
      (SELECT id FROM token_data_history WHERE chain_id = ? AND address = ? ORDER BY collected_at DESC, id DESC LIMIT ?)`).run(chainId, address, chainId, address, HISTORY_KEEP);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** @returns {{chainId, address, symbol, status, coverage, collectedAt, stale:boolean, data:object}|null} */
export function getTokenData(db, chainId, address, nowSec = Math.floor(Date.now() / 1000)) {
  const r = db.prepare('SELECT * FROM token_data WHERE chain_id = ? AND address = ?').get(Number(chainId), String(address).toLowerCase());
  if (!r) return null;
  return { chainId: r.chain_id, address: r.address, symbol: r.symbol, status: r.status, coverage: r.coverage, collectedAt: r.collected_at,
    stale: r.collected_at < nowSec - 2 * CONFIG.tokenData.refreshSec, data: JSON.parse(r.data_json) };
}

/** Every stored token record as {chainId, address, symbol, status, coverage, collectedAt, data}, in chain and address order. */
export function listTokenData(db) {
  return db.prepare('SELECT chain_id, address, symbol, status, coverage, collected_at, data_json FROM token_data ORDER BY chain_id, address').all()
    .map(r => ({ chainId: r.chain_id, address: r.address, symbol: r.symbol, status: r.status, coverage: r.coverage, collectedAt: r.collected_at, data: JSON.parse(r.data_json) }));
}

/**
 * Collateral tokens of the markets that need collecting: never collected first (biggest capital first), then the oldest.
 * A good record is refreshed after `refreshSec`, a partial or failed one after `retrySec`.
 */
export function tokenDataQueue(db, nowSec, { limit = 20 } = {}) {
  const { refreshSec, retrySec } = CONFIG.tokenData;
  return db.prepare(`
    WITH tok AS (
      SELECT m.chain_id AS chain_id, lower(m.collateral_asset_address) AS address, MAX(m.collateral_asset_symbol) AS symbol,
             COALESCE(SUM(a.supply_assets_usd), 0) AS capital
      FROM markets m LEFT JOIN vault_allocations a ON a.market_unique_key = m.unique_key
      WHERE m.collateral_asset_address <> '' AND lower(m.collateral_asset_address) <> '${ZERO_ADDRESS}'
      GROUP BY m.chain_id, lower(m.collateral_asset_address)
    )
    SELECT tok.chain_id AS chainId, tok.address, tok.symbol
    FROM tok LEFT JOIN token_data d ON d.chain_id = tok.chain_id AND d.address = tok.address
    WHERE d.collected_at IS NULL
       OR (d.status = 'ok' AND d.collected_at < ?)
       OR (d.status <> 'ok' AND d.collected_at < ?)
    ORDER BY (d.collected_at IS NULL) DESC, tok.capital DESC, d.collected_at ASC
    LIMIT ?`).all(nowSec - refreshSec, nowSec - retrySec, Math.max(1, Math.floor(Number(limit)) || 20));
}

// --- Background loop --------------------------------------------------------------------------------------------

let ticking = false;

/** True while a tick is running. */
export function isTokenDataRunning() { return ticking; }

/**
 * One tick: collects queued tokens one after another until the time budget is used up. One token's failure does not stop the tick.
 * @param {*} db
 * @param {{collect?:Function, now?:()=>number, log?:Function, budgetMs?:number, limit?:number}} deps
 * @returns {Promise<{collected:number, failed:number, skipped:boolean}>}
 */
export async function runTokenDataTick(db, { collect = collectTokenData, now = Date.now, log = console.log, budgetMs = CONFIG.tokenData.budgetMs, limit = 40 } = {}) {
  if (ticking) return { collected: 0, failed: 0, skipped: true };
  ticking = true;
  const deadline = now() + budgetMs;
  const out = { collected: 0, failed: 0, skipped: false };
  try {
    for (const token of tokenDataQueue(db, Math.floor(now() / 1000), { limit })) {
      if (now() >= deadline) break;
      try {
        const stored = getTokenData(db, token.chainId, token.address);
        applyTokenData(db, token, await collect({ ...token, previous: stored?.status === 'ok' ? stored.data : null }, { now, log }), Math.floor(now() / 1000));
        out.collected++;
      } catch (err) {
        out.failed++;
        log(`[TokenData] ${token.chainId}:${token.address} failed: ${err.message}`);
      }
    }
  } finally {
    ticking = false;
  }
  if (out.collected || out.failed) log(`[TokenData] tick done: ${out.collected} collected, ${out.failed} failed.`);
  return out;
}

let loopTimer = null, firstTimer = null;

/** Starts the recurring collection. Off when `TOKEN_DATA_DISABLED=1`. */
export function startTokenDataLoop(db, deps = {}) {
  if (process.env.TOKEN_DATA_DISABLED === '1' || loopTimer || firstTimer) return false;
  const tick = () => runTokenDataTick(db, deps).catch(err => console.error('[TokenData] tick crashed:', err.message));
  firstTimer = setTimeout(() => { firstTimer = null; tick(); loopTimer = setInterval(tick, CONFIG.tokenData.intervalMs); }, CONFIG.tokenData.firstDelayMs);
  return true;
}

/** Stops the recurring collection. */
export function stopTokenDataLoop() {
  if (firstTimer) clearTimeout(firstTimer);
  if (loopTimer) clearInterval(loopTimer);
  firstTimer = loopTimer = null;
}
