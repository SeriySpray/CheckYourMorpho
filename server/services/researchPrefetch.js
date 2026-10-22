/**
 * Pre-fetches verifiable evidence from allowlisted public sources for token research.
 * Runs on the host PC before sending the prompt to the agy agent, keeping web data
 * untrusted and rate-limited.
 */
import { isSafeUrl, isAllowedSourceUrl } from './tokenResearch.js';

export const MAX_EVIDENCE_BYTES = 70_000;
export const MAX_ITEM_CHARS = 6_000;
const MAX_BODY_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; CheckYourMorpho-research/1.0)',
  accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5'
};

const CHAINS = {
  1: {
    name: 'ethereum',
    blockscout: 'eth',
    llama: 'ethereum',
    gecko: 'eth',
    explorer: 'etherscan.io',
    n: 'mainnet',
    kyber: 'ethereum',
    safe: 'eth',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  },
  8453: {
    name: 'base',
    blockscout: 'base',
    llama: 'base',
    gecko: 'base',
    explorer: 'basescan.org',
    n: 'base',
    kyber: 'base',
    safe: 'base',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  },
  42161: {
    name: 'arbitrum',
    blockscout: 'arbitrum',
    llama: 'arbitrum',
    gecko: 'arbitrum',
    explorer: 'arbiscan.io',
    n: 'arbitrum',
    kyber: 'arbitrum',
    safe: 'arb1',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
  }
};

function getHostDelay(host) {
  if (host.includes('geckoterminal.com')) return 6000;
  if (host.includes('safe.global')) return 1500;
  if (host.includes('kyberswap.com')) return 1000;
  return 300;
}

class HostRateLimiter {
  constructor(sleep) {
    this.sleep = sleep;
    this.chains = new Map();
  }

  async run(url, fn) {
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { host = 'unknown'; }
    const delay = getHostDelay(host);
    const prev = this.chains.get(host) || Promise.resolve();
    let resolveNext;
    const current = new Promise(r => { resolveNext = r; });
    this.chains.set(host, current);

    await prev;
    try {
      return await fn();
    } finally {
      try {
        if (delay > 0) await this.sleep(delay);
      } finally {
        resolveNext();
      }
    }
  }
}

async function readLimited(res) {
  if (!res.body?.getReader) return String(await res.text?.() ?? '').slice(0, MAX_BODY_BYTES);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8');
}

/**
 * Calculates raw amountIn string for Kyber swap: USD / priceUsd * 10^decimals.
 * @returns {string|null}
 */
export function calcAmountIn(usd, priceUsd, decimals) {
  if (!usd || !priceUsd || priceUsd <= 0 || decimals == null || !Number.isFinite(priceUsd)) return null;
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) return null;
  const tokens = (Number(usd) / priceUsd).toFixed(Math.min(dec, 8));
  const [whole, frac = ''] = tokens.split('.');
  const fracPadded = frac.padEnd(dec, '0').slice(0, dec);
  const raw = BigInt(whole) * (10n ** BigInt(dec)) + BigInt(fracPadded || 0);
  return raw > 0n ? raw.toString() : null;
}

function pruneJson(val) {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  if (Array.isArray(val)) {
    const pruned = [];
    for (const item of val.slice(0, 12)) {
      const p = pruneJson(item);
      if (p !== undefined) pruned.push(p);
    }
    return pruned.length === 0 ? undefined : pruned;
  }
  if (typeof val === 'object') {
    const pruned = {};
    let hasKeys = false;
    for (const [k, v] of Object.entries(val)) {
      const p = pruneJson(v);
      if (p !== undefined) {
        pruned[k] = p;
        hasKeys = true;
      }
    }
    return hasKeys ? pruned : undefined;
  }
  return val;
}

/**
 * Trims evidence text to compact form and limits it to MAX_ITEM_CHARS.
 * @param {string|object} body
 * @param {string} contentType
 * @returns {string}
 */
export function trimEvidence(body, contentType = '') {
  if (body == null) return '';
  const isJson = String(contentType).toLowerCase().includes('json') || (typeof body === 'object');
  if (isJson) {
    let parsed;
    if (typeof body === 'string') {
      try { parsed = JSON.parse(body); } catch { parsed = null; }
    } else {
      parsed = body;
    }
    if (parsed && typeof parsed === 'object') {
      const pruned = pruneJson(parsed);
      const str = pruned === undefined ? '{}' : JSON.stringify(pruned);
      return str.slice(0, MAX_ITEM_CHARS);
    }
  }

  const isHtml = String(contentType).toLowerCase().includes('html') || /<[a-z][\s\S]*>/i.test(String(body));
  if (isHtml) {
    let s = String(body);
    s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
    s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&nbsp;/gi, ' ')
         .replace(/&amp;/gi, '&')
         .replace(/&lt;/gi, '<')
         .replace(/&gt;/gi, '>')
         .replace(/&quot;/gi, '"')
         .replace(/&#39;/gi, "'");
    s = s.replace(/\s+/g, ' ').trim();
    return s.slice(0, MAX_ITEM_CHARS);
  }

  return String(body).replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS);
}

/**
 * Returns static plan of evidence queries for supported chains.
 * Pure function, makes no network requests.
 * @param {{chainId:number, address:string, symbol?:string}} token
 * @returns {Array<{label:string, url:string, phase:number}>}
 */
export function buildEvidencePlan(token) {
  const chainId = Number(token?.chainId);
  const addr = String(token?.address || '').toLowerCase();
  if (![1, 8453, 42161].includes(chainId) || !ADDR_RE.test(addr)) {
    return [];
  }
  const c = CHAINS[chainId];
  const plan = [
    {
      label: 'sourcify: contract',
      url: `https://sourcify.dev/server/v2/contract/${chainId}/${addr}?fields=compilation,proxyResolution,deployment`,
      phase: 1
    },
    {
      label: 'blockscout: token info',
      url: `https://${c.blockscout}.blockscout.com/api/v2/tokens/${addr}`,
      phase: 1
    },
    {
      label: 'blockscout: address info',
      url: `https://${c.blockscout}.blockscout.com/api/v2/addresses/${addr}`,
      phase: 1
    },
    {
      label: 'blockscout: holders',
      url: `https://${c.blockscout}.blockscout.com/api/v2/tokens/${addr}/holders`,
      phase: 1
    },
    {
      label: 'defillama: price',
      url: `https://coins.llama.fi/prices/current/${c.llama}:${addr}`,
      phase: 1
    },
    {
      label: 'defillama: chart',
      url: `https://coins.llama.fi/chart/${c.llama}:${addr}?span=30&period=1d`,
      phase: 1
    },
    {
      label: 'geckoterminal: token info',
      url: `https://api.geckoterminal.com/api/v2/networks/${c.gecko}/tokens/${addr}/info`,
      phase: 1
    },
    {
      label: 'geckoterminal: pools',
      url: `https://api.geckoterminal.com/api/v2/networks/${c.gecko}/tokens/${addr}/pools`,
      phase: 1
    },
    {
      label: 'explorer: read contract',
      url: `https://${c.explorer}/readContract?m=light&a=${addr}&n=${c.n}`,
      phase: 1
    }
  ];
  if (token?.symbol && String(token.symbol).toUpperCase().startsWith('PT-')) {
    plan.push({
      label: 'pendle: active markets',
      url: `https://api-v2.pendle.finance/core/v1/${chainId}/markets/active`,
      phase: 2
    });
  }
  return plan;
}

function findOwnerAddresses(tokenAddr, ...texts) {
  const found = new Set();
  const lowerToken = tokenAddr.toLowerCase();
  for (const text of texts) {
    if (!text) continue;
    const re = /\b(?:owner|admin)\b/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = Math.max(0, m.index - 100);
      const end = Math.min(text.length, m.index + 100);
      const window = text.slice(start, end);
      const addrMatches = window.match(/0x[0-9a-fA-F]{40}/g) || [];
      for (const a of addrMatches) {
        const lower = a.toLowerCase();
        if (lower !== '0x0000000000000000000000000000000000000000' && lower !== lowerToken) {
          found.add(lower);
        }
      }
    }
  }
  return [...found].slice(0, 2);
}

/**
 * Pre-fetches evidence from public APIs and block explorers according to policy.
 * @param {{chainId:number, address:string, symbol?:string}} token
 * @param {{fetchImpl?:Function, sleep?:Function, log?:Function}} deps
 * @returns {Promise<Array<{id:number, label:string, url:string, status:number, text:string}>>}
 */
export async function prefetchEvidence(token, { fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {} } = {}) {
  const chainId = Number(token?.chainId);
  const addr = String(token?.address || '').toLowerCase();
  if (![1, 8453, 42161].includes(chainId) || !ADDR_RE.test(addr)) {
    return [];
  }
  const c = CHAINS[chainId];
  const hostLimiter = new HostRateLimiter(sleep);

  async function fetchUrl(url) {
    if (!isSafeUrl(url) || !isAllowedSourceUrl(url)) {
      return { status: 0, contentType: '', body: 'disallowed or unsafe URL' };
    }
    return hostLimiter.run(url, async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await fetchImpl(url, {
            headers: HEADERS,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
          });
          if (res.status === 429) {
            if (attempt === 1) {
              await sleep(5000);
              continue;
            }
            return { status: 429, contentType: '', body: 'rate limited' };
          }
          const contentType = res.headers?.get?.('content-type') || '';
          const body = await readLimited(res);
          return { status: res.status, contentType, body };
        } catch (err) {
          return { status: 0, contentType: '', body: err.message || 'network error' };
        }
      }
      return { status: 429, contentType: '', body: 'rate limited' };
    });
  }

  // --- Phase 1: parallel across hosts, sequential per host with pause ---
  const results = {};

  // 1. Sourcify
  const sourcifyUrl = `https://sourcify.dev/server/v2/contract/${chainId}/${addr}?fields=compilation,proxyResolution,deployment`;
  const sourcifyPromise = (async () => {
    const res = await fetchUrl(sourcifyUrl);
    results.sourcify = { url: sourcifyUrl, res };
  })();

  // 2. Blockscout (3 endpoints)
  const bsTokenUrl = `https://${c.blockscout}.blockscout.com/api/v2/tokens/${addr}`;
  const bsAddrUrl = `https://${c.blockscout}.blockscout.com/api/v2/addresses/${addr}`;
  const bsHoldersUrl = `https://${c.blockscout}.blockscout.com/api/v2/tokens/${addr}/holders`;
  const blockscoutPromise = (async () => {
    const r1 = await fetchUrl(bsTokenUrl);
    results.bsToken = { url: bsTokenUrl, res: r1 };
    const r2 = await fetchUrl(bsAddrUrl);
    results.bsAddr = { url: bsAddrUrl, res: r2 };
    const r3 = await fetchUrl(bsHoldersUrl);
    results.bsHolders = { url: bsHoldersUrl, res: r3 };
  })();

  // 3. DefiLlama (price + chart)
  const dlPriceUrl = `https://coins.llama.fi/prices/current/${c.llama}:${addr}`;
  const dlChartUrl = `https://coins.llama.fi/chart/${c.llama}:${addr}?span=30&period=1d`;
  const defillamaPromise = (async () => {
    const r1 = await fetchUrl(dlPriceUrl);
    results.dlPrice = { url: dlPriceUrl, res: r1 };
    const r2 = await fetchUrl(dlChartUrl);
    results.dlChart = { url: dlChartUrl, res: r2 };
  })();

  // 4. GeckoTerminal (info + pools)
  const gtInfoUrl = `https://api.geckoterminal.com/api/v2/networks/${c.gecko}/tokens/${addr}/info`;
  const gtPoolsUrl = `https://api.geckoterminal.com/api/v2/networks/${c.gecko}/tokens/${addr}/pools`;
  const geckoPromise = (async () => {
    const r1 = await fetchUrl(gtInfoUrl);
    results.gtInfo = { url: gtInfoUrl, res: r1 };
    const r2 = await fetchUrl(gtPoolsUrl);
    results.gtPools = { url: gtPoolsUrl, res: r2 };
  })();

  // 5. Explorer readContract
  const expReadUrl = `https://${c.explorer}/readContract?m=light&a=${addr}&n=${c.n}`;
  const explorerPromise = (async () => {
    const r = await fetchUrl(expReadUrl);
    results.expRead = { url: expReadUrl, res: r };
  })();

  await Promise.all([sourcifyPromise, blockscoutPromise, defillamaPromise, geckoPromise, explorerPromise]);

  // Extract decimals from Blockscout and price from DefiLlama
  let decimals = null;
  if (results.bsToken?.res?.status === 200) {
    try {
      const p = JSON.parse(results.bsToken.res.body);
      if (p.decimals != null) decimals = Number(p.decimals);
    } catch {}
  }
  let priceUsd = null;
  if (results.dlPrice?.res?.status === 200) {
    try {
      const p = JSON.parse(results.dlPrice.res.body);
      const coinKey = `${c.llama}:${addr}`;
      const coin = p.coins?.[coinKey] || p.coins?.[Object.keys(p.coins || {})[0]];
      if (coin?.price != null && Number.isFinite(coin.price)) priceUsd = Number(coin.price);
    } catch {}
  }

  // 6. Kyber routes (for 100 000 and 1 000 000 USD)
  const kyberItems = [];
  if (decimals != null && priceUsd != null && priceUsd > 0) {
    for (const usd of [100_000, 1_000_000]) {
      const raw = calcAmountIn(usd, priceUsd, decimals);
      if (!raw) continue;
      const kyberUrl = `https://aggregator-api.kyberswap.com/${c.kyber}/api/v1/routes?tokenIn=${addr}&tokenOut=${c.usdc}&amountIn=${raw}&source=cym`;
      const res = await fetchUrl(kyberUrl);
      let text;
      if (res.status === 200) {
        try {
          const d = JSON.parse(res.body);
          if (d.data) {
            const rs = d.data.routeSummary ?? d.data;
            const dexes = [];
            for (const leg of Array.isArray(rs.route) ? rs.route : []) {
              for (const sw of Array.isArray(leg) ? leg : [leg]) dexes.push(sw.exchange || sw.pool);
            }
            const keep = {
              amountInUsd: rs.amountInUsd,
              amountOutUsd: rs.amountOutUsd,
              gasUsd: rs.gasUsd,
              routes: [...new Set(dexes.filter(Boolean))]
            };
            text = trimEvidence(JSON.stringify(keep), 'application/json');
          } else {
            text = trimEvidence(JSON.stringify({ error: d.message || d.error || 'route not found' }), 'application/json');
          }
        } catch {
          text = trimEvidence(res.body, res.contentType);
        }
      } else {
        text = res.body;
      }
      kyberItems.push({
        label: `kyber: swap ${usd >= 1e6 ? '1M' : '100k'} USD`,
        url: kyberUrl,
        status: res.status,
        text
      });
    }
  } else {
    kyberItems.push({
      label: 'skipped: no price or decimals',
      url: `https://aggregator-api.kyberswap.com/${c.kyber}/api/v1/routes`,
      status: 0,
      text: 'skipped: no price or decimals'
    });
  }

  // --- Process Phase 1 outputs ---
  const allItems = [];

  // Item 1: Sourcify
  if (results.sourcify) {
    const { url, res } = results.sourcify;
    let text;
    if (res.status === 200) {
      try {
        const j = JSON.parse(res.body);
        const name = j.compilation?.name ?? j.name;
        const isProxy = j.proxyResolution?.isProxy ?? j.isProxy;
        const proxyType = j.proxyResolution?.proxyType ?? j.proxyType;
        const implementations = j.proxyResolution?.implementations ?? j.implementations;
        const deployer = j.deployment?.deployer ?? j.deployer;
        const match = j.match?.match ?? j.match;
        const keep = {};
        if (name !== undefined) keep.name = name;
        if (isProxy !== undefined) keep.isProxy = isProxy;
        if (proxyType !== undefined) keep.proxyType = proxyType;
        if (implementations !== undefined) keep.implementations = implementations;
        if (deployer !== undefined) keep.deployer = deployer;
        if (match !== undefined) keep.match = match;
        text = trimEvidence(JSON.stringify(keep), 'application/json');
      } catch {
        text = trimEvidence(res.body, res.contentType);
      }
    } else {
      text = res.body;
    }
    allItems.push({ label: 'sourcify: contract', url, status: res.status, text });
  }

  // Item 2: Blockscout token info
  if (results.bsToken) {
    const { url, res } = results.bsToken;
    allItems.push({
      label: 'blockscout: token info',
      url,
      status: res.status,
      text: res.status === 200 ? trimEvidence(res.body, 'application/json') : res.body
    });
  }

  // Item 3: Blockscout address info
  if (results.bsAddr) {
    const { url, res } = results.bsAddr;
    let text;
    if (res.status === 200) {
      try {
        const j = JSON.parse(res.body);
        const keep = {};
        if (j.proxy_type !== undefined) keep.proxy_type = j.proxy_type;
        if (j.implementations !== undefined) keep.implementations = j.implementations;
        if (j.creator_address_hash !== undefined) keep.creator_address_hash = j.creator_address_hash;
        if (j.is_verified !== undefined) keep.is_verified = j.is_verified;
        if (j.name !== undefined) keep.name = j.name;
        text = trimEvidence(JSON.stringify(keep), 'application/json');
      } catch {
        text = trimEvidence(res.body, res.contentType);
      }
    } else {
      text = res.body;
    }
    allItems.push({ label: 'blockscout: address info', url, status: res.status, text });
  }

  // Item 4: Blockscout holders
  if (results.bsHolders) {
    const { url, res } = results.bsHolders;
    let text;
    if (res.status === 200) {
      try {
        const j = JSON.parse(res.body);
        const raw = Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : []);
        const holders = raw.slice(0, 10).map(h => ({
          address: {
            hash: h.address?.hash ?? h.address,
            name: h.address?.name ?? null,
            is_contract: h.address?.is_contract ?? null
          },
          value: h.value
        }));
        text = trimEvidence(JSON.stringify({ holders }), 'application/json');
      } catch {
        text = trimEvidence(res.body, res.contentType);
      }
    } else {
      text = res.body;
    }
    allItems.push({ label: 'blockscout: holders', url, status: res.status, text });
  }

  // Item 5: DefiLlama price
  if (results.dlPrice) {
    const { url, res } = results.dlPrice;
    allItems.push({
      label: 'defillama: price',
      url,
      status: res.status,
      text: res.status === 200 ? trimEvidence(res.body, 'application/json') : res.body
    });
  }

  // Item 6: DefiLlama chart
  if (results.dlChart) {
    const { url, res } = results.dlChart;
    let text;
    if (res.status === 200) {
      try {
        const j = JSON.parse(res.body);
        const coinKey = `${c.llama}:${addr}`;
        const obj = j.coins?.[coinKey] || j;
        const pricesList = Array.isArray(obj.prices) ? obj.prices : (Array.isArray(j.prices) ? j.prices : []);
        if (pricesList.length) {
          const vals = pricesList.map(p => (typeof p === 'number' ? p : p.price)).filter(Number.isFinite);
          if (vals.length) {
            const min = Math.min(...vals);
            const max = Math.max(...vals);
            const last = vals[vals.length - 1];
            const count = vals.length;
            const relative_range = min > 0 ? (max - min) / min : 0;
            text = trimEvidence(JSON.stringify({ chart: { min, max, last, count, relative_range } }), 'application/json');
          } else {
            text = trimEvidence(JSON.stringify({ chart: { count: 0 } }), 'application/json');
          }
        } else {
          text = trimEvidence(JSON.stringify({ chart: { count: 0 } }), 'application/json');
        }
      } catch {
        text = trimEvidence(res.body, res.contentType);
      }
    } else {
      text = res.body;
    }
    allItems.push({ label: 'defillama: chart', url, status: res.status, text });
  }

  // Item 7: GeckoTerminal info
  if (results.gtInfo) {
    const { url, res } = results.gtInfo;
    allItems.push({
      label: 'geckoterminal: token info',
      url,
      status: res.status,
      text: res.status === 200 ? trimEvidence(res.body, 'application/json') : res.body
    });
  }

  // Item 8: GeckoTerminal pools
  if (results.gtPools) {
    const { url, res } = results.gtPools;
    let text;
    if (res.status === 200) {
      try {
        const j = JSON.parse(res.body);
        const raw = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
        const pools = raw.slice(0, 5).map(p => {
          const attrs = p.attributes || {};
          return {
            dex: p.relationships?.dex?.data?.id ?? attrs.dex ?? p.dex ?? null,
            reserve_in_usd: attrs.reserve_in_usd ?? p.reserve_in_usd ?? null,
            volume_usd_h24: attrs.volume_usd?.h24 ?? attrs.volume_usd_h24 ?? p.volume_usd?.h24 ?? null,
            pool_created_at: attrs.pool_created_at ?? p.pool_created_at ?? null
          };
        });
        text = trimEvidence(JSON.stringify({ pools }), 'application/json');
      } catch {
        text = trimEvidence(res.body, res.contentType);
      }
    } else {
      text = res.body;
    }
    allItems.push({ label: 'geckoterminal: pools', url, status: res.status, text });
  }

  // Item 9: Explorer readContract
  let readContractHtml = '';
  if (results.expRead) {
    const { url, res } = results.expRead;
    readContractHtml = res.body;
    allItems.push({
      label: 'explorer: read contract',
      url,
      status: res.status,
      text: res.status === 200 ? trimEvidence(res.body, 'text/html') : res.body
    });
  }

  // Items 10 & 11: Kyber
  for (const item of kyberItems) {
    allItems.push(item);
  }

  // --- Phase 2: Follow-ups based on Phase 1 ---

  // 7. Implementation readContract
  const implAddresses = new Set();
  const inspectImpls = list => {
    for (const item of list || []) {
      const a = typeof item === 'string' ? item : (item?.address || item?.hash);
      if (typeof a === 'string' && ADDR_RE.test(a) && a.toLowerCase() !== addr) {
        implAddresses.add(a.toLowerCase());
      }
    }
  };
  if (results.sourcify?.res?.status === 200) {
    try {
      const j = JSON.parse(results.sourcify.res.body);
      inspectImpls(j.proxyResolution?.implementations ?? j.implementations);
    } catch {}
  }
  if (results.bsAddr?.res?.status === 200) {
    try {
      const j = JSON.parse(results.bsAddr.res.body);
      inspectImpls(j.implementations);
    } catch {}
  }

  let implReadHtml = '';
  for (const impl of [...implAddresses].slice(0, 1)) {
    const implUrl = `https://${c.explorer}/readContract?m=light&a=${addr}&n=${c.n}&v=${impl}`;
    const res = await fetchUrl(implUrl);
    implReadHtml = res.body;
    allItems.push({
      label: `explorer: read implementation ${impl}`,
      url: implUrl,
      status: res.status,
      text: res.status === 200 ? trimEvidence(res.body, 'text/html') : res.body
    });
  }

  // 8. Owner / admin addresses check (Blockscout + Safe multisig)
  const bsAddrBody = results.bsAddr?.res?.body || '';
  const ownerAddresses = findOwnerAddresses(addr, readContractHtml, implReadHtml, bsAddrBody);
  for (const owner of ownerAddresses) {
    const ownerBsUrl = `https://${c.blockscout}.blockscout.com/api/v2/addresses/${owner}`;
    const bsRes = await fetchUrl(ownerBsUrl);
    let bsText;
    if (bsRes.status === 200) {
      try {
        const j = JSON.parse(bsRes.body);
        const keep = {
          name: j.name ?? null,
          implementations: Array.isArray(j.implementations) ? j.implementations.map(i => ({ name: i.name })) : [],
          is_contract: j.is_contract ?? null
        };
        bsText = trimEvidence(JSON.stringify(keep), 'application/json');
      } catch {
        bsText = trimEvidence(bsRes.body, bsRes.contentType);
      }
    } else {
      bsText = bsRes.body;
    }
    allItems.push({
      label: `blockscout: address ${owner}`,
      url: ownerBsUrl,
      status: bsRes.status,
      text: bsText
    });

    const safeUrl = `https://api.safe.global/tx-service/${c.safe}/api/v1/safes/${owner}/`;
    const safeRes = await fetchUrl(safeUrl);
    let safeText;
    if (safeRes.status === 200) {
      try {
        const j = JSON.parse(safeRes.body);
        const keep = {
          threshold: j.threshold,
          owners: j.owners,
          version: j.version
        };
        safeText = trimEvidence(JSON.stringify(keep), 'application/json');
      } catch {
        safeText = trimEvidence(safeRes.body, safeRes.contentType);
      }
    } else if (safeRes.status === 404) {
      safeText = 'not a Safe multisig';
    } else {
      safeText = safeRes.body;
    }
    allItems.push({
      label: `safe: ${owner}`,
      url: safeUrl,
      status: safeRes.status,
      text: safeText
    });
  }

  // 9. Pendle principal token markets
  let sourcifyName = '';
  if (results.sourcify?.res?.status === 200) {
    try {
      const j = JSON.parse(results.sourcify.res.body);
      sourcifyName = j.compilation?.name ?? j.name ?? '';
    } catch {}
  }
  const isPendle = sourcifyName === 'PendlePrincipalToken' || String(token.symbol || '').toUpperCase().startsWith('PT-');
  if (isPendle) {
    const pendleUrl = `https://api-v2.pendle.finance/core/v1/${chainId}/markets/active`;
    const res = await fetchUrl(pendleUrl);
    let text;
    if (res.status === 200) {
      try {
        const j = JSON.parse(res.body);
        const list = Array.isArray(j) ? j : (Array.isArray(j.results) ? j.results : (Array.isArray(j.markets) ? j.markets : []));
        const found = list.find(m => {
          const ptAddr = typeof m.pt === 'string' ? m.pt : (m.pt?.address || m.ptAddress);
          // Pendle writes ids as "<chainId>-<address>"
          return typeof ptAddr === 'string' && ptAddr.toLowerCase().replace(/^\d+-/, '') === addr;
        });
        if (found) {
          const keep = {
            expiry: found.expiry,
            underlying: found.underlying,
            details: {
              liquidity: found.details?.liquidity,
              impliedApy: found.details?.impliedApy
            }
          };
          text = trimEvidence(JSON.stringify(keep), 'application/json');
        } else {
          text = 'no active Pendle market for this PT';
        }
      } catch {
        text = trimEvidence(res.body, res.contentType);
      }
    } else {
      text = res.body;
    }
    allItems.push({
      label: 'pendle: market',
      url: pendleUrl,
      status: res.status,
      text
    });
  }

  // Limit total text bytes to MAX_EVIDENCE_BYTES; excess dropped from the end
  let totalBytes = 0;
  const finalItems = [];
  for (const item of allItems) {
    const b = Buffer.byteLength(item.text, 'utf8');
    if (totalBytes + b > MAX_EVIDENCE_BYTES) {
      break;
    }
    finalItems.push({
      id: finalItems.length + 1,
      label: item.label,
      url: item.url,
      status: item.status,
      text: item.text
    });
    totalBytes += b;
  }

  return finalItems;
}
