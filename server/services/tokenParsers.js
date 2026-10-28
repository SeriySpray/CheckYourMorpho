/**
 * Pure parsers of the public sources that describe one token (Sourcify, Blockscout, DefiLlama, GeckoTerminal, Kyber,
 * block-explorer "Read Contract" pages, Safe, Pendle, Chainlink feeds, rwa.xyz). Each takes the response body that
 * was already read and returns plain data; a missing or malformed value becomes null and nothing here throws.
 * The parsers only extract: they never judge. Shapes come from real responses (tests/data/collector).
 */

export const MORPHO_BLUE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Finite number from a number or a numeric string, else null. */
export function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean' || typeof v === 'object') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Text from a third-party site: tags and control characters removed, whitespace collapsed, cut to `max` characters. */
export function cleanText(v, max = 300) {
  if (v === null || v === undefined || typeof v === 'object') return null;
  const s = String(v).replace(/<[^>]*>/g, ' ').replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

const isAddr = a => typeof a === 'string' && ADDR_RE.test(a);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** JSON text to a value, or null when it is not valid JSON. */
export function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// --- Sourcify ---------------------------------------------------------------------------------------------------

/** @returns {{contract_name, sourcify_match, is_proxy, proxy_type, implementations:Array<{address,name}>, deployer, abi:Array|null}|null} */
export function parseSourcify(j) {
  if (!j || typeof j !== 'object' || !j.address) return null;
  const pr = obj(j.proxyResolution);
  return {
    contract_name: cleanText(obj(j.compilation).name, 100),
    sourcify_match: typeof j.match === 'string' ? j.match : null,
    is_proxy: typeof pr.isProxy === 'boolean' ? pr.isProxy : null,
    proxy_type: cleanText(pr.proxyType, 60),
    implementations: (Array.isArray(pr.implementations) ? pr.implementations : []).filter(i => isAddr(i?.address))
      .slice(0, 3).map(i => ({ address: i.address.toLowerCase(), name: cleanText(i.name, 100) })),
    deployer: isAddr(obj(j.deployment).deployer) ? j.deployment.deployer.toLowerCase() : null,
    abi: Array.isArray(j.abi) ? j.abi : null
  };
}

/**
 * Contract record of Blockscout (used when Sourcify does not know the contract): name and ABI.
 * @returns {{contract_name:string|null, abi:Array|null}|null}
 */
export function parseBlockscoutContract(j) {
  if (!j || typeof j !== 'object' || (!('abi' in j) && !('name' in j))) return null;
  return { contract_name: cleanText(j.name, 100), abi: Array.isArray(j.abi) ? j.abi : null };
}

/**
 * Which kinds of functions the contract has, by function NAME only (a fact about the code, not a judgement).
 * With no ABI every flag is null. In an ERC-4626 vault `mint` and `redeem` are ordinary user functions, so they do not count as minting.
 * @param {Array<Array<{name?:string}>|null>} abis ABIs of the proxy and its implementation
 */
export function parseAbiFlags(...abis) {
  const lists = abis.filter(Array.isArray);
  const keys = ['mint', 'burn', 'pause', 'blacklist', 'freeze', 'upgrade', 'owner', 'roles', 'erc4626', 'permit'];
  if (!lists.length) return Object.fromEntries(keys.map(k => [k, null]));
  const names = new Set(lists.flat().map(f => String(f?.name ?? '')).filter(Boolean));
  const has = re => [...names].some(n => re.test(n));
  const erc4626 = names.has('asset') && names.has('convertToAssets');
  return {
    mint: erc4626 ? has(/^(mintTo|configureMinter|setMinter|addMinter|issue)$/i) : has(/^(mint|mintTo|configureMinter|setMinter|addMinter|issue)$/i),
    burn: has(/^(burn|burnFrom)$/i),
    pause: has(/^(pause|unpause|setPaused)$/i),
    blacklist: has(/blacklist|denylist|blocklist|^ban|^isBlocked$/i),
    freeze: has(/freeze|frozen/i),
    upgrade: has(/^(upgradeTo|upgradeToAndCall|setImplementation|upgrade|changeAdmin)$/i),
    owner: has(/^(owner|admin|transferOwnership|DEFAULT_ADMIN_ROLE)$/),
    roles: has(/^(grantRole|hasRole|getRoleAdmin)$/),
    erc4626,
    permit: has(/^(permit|DOMAIN_SEPARATOR)$/)
  };
}

// --- Blockscout -------------------------------------------------------------------------------------------------

/** @returns {{name, symbol, decimals, total_supply, token_type, holders_count, market_cap_usd, volume_24h_usd, reputation}|null} */
export function parseBlockscoutToken(j) {
  if (!j || typeof j !== 'object' || !j.address_hash) return null;
  const decimals = num(j.decimals);
  return {
    name: cleanText(j.name, 100), symbol: cleanText(j.symbol, 40),
    decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null,
    total_supply: typeof j.total_supply === 'string' && /^\d+$/.test(j.total_supply) ? j.total_supply : null,
    token_type: cleanText(j.type, 20),
    holders_count: num(j.holders_count),
    market_cap_usd: num(j.circulating_market_cap), volume_24h_usd: num(j.volume_24h),
    reputation: cleanText(j.reputation, 30)
  };
}

/** @returns {{address, name, is_contract, verified, creator, creation_tx, proxy_type, implementations:Array<{address,name}>}|null} `address` keeps the EIP-55 spelling */
export function parseBlockscoutAddress(j) {
  if (!j || typeof j !== 'object' || !j.hash) return null;
  return {
    address: isAddr(j.hash) ? j.hash : null,
    name: cleanText(j.name, 100),
    is_contract: typeof j.is_contract === 'boolean' ? j.is_contract : null,
    verified: typeof j.is_verified === 'boolean' ? j.is_verified : null,
    creator: isAddr(j.creator_address_hash) ? j.creator_address_hash.toLowerCase() : null,
    creation_tx: typeof j.creation_transaction_hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(j.creation_transaction_hash) ? j.creation_transaction_hash : null,
    proxy_type: cleanText(j.proxy_type, 60),
    implementations: (Array.isArray(j.implementations) ? j.implementations : []).filter(i => isAddr(i?.address_hash ?? i?.address))
      .slice(0, 3).map(i => ({ address: String(i.address_hash ?? i.address).toLowerCase(), name: cleanText(i.name, 100) }))
  };
}

/** @returns {number|null} holders count from /tokens/{a}/counters */
export function parseBlockscoutCounters(j) {
  return num(obj(j).token_holders_count);
}

/** @returns {string|null} ISO time of a transaction (the contract creation) */
export function parseCreationTx(j) {
  const t = obj(j).timestamp;
  return typeof t === 'string' && Number.isFinite(Date.parse(t)) ? new Date(t).toISOString() : null;
}

// A holder contract whose explorer name says it is a pool or a protocol: its balance belongs to many users, not to one owner.
// Limit: a protocol contract without a name (or with a generic proxy name) still counts as a single holder. Named proxies that are
// protocols: the Aave and Spark aToken proxy (InitializableImmutableAdminUpgradeabilityProxy), Compound-fork markets (*Erc20Delegator),
// margin and AMM pools, staking wrappers.
export const PROTOCOL_NAME_RE = /pool|vault|morpho|aave|uniswap|curve|balancer|gauge|router|bridge|adapter|escrow|locker|pendle|euler|silo|fluid|compound|immutableadminupgradeabilityproxy|erc20delegator|margin|\bamm\b|staked/i;

/**
 * Concentration of the first page of holders (Blockscout sorts by balance). A share is the balance over the total supply, cut to 100.
 * The `_nonprotocol` shares leave out Morpho Blue and contracts named as a pool or protocol (PROTOCOL_NAME_RE), taken from the same page of 50.
 * @param {*} j /tokens/{a}/holders response
 * @param {string|null} totalSupply Raw supply string
 */
export function parseHolders(j, totalSupply) {
  const items = Array.isArray(obj(j).items) ? j.items : null;
  if (!items) return null;
  let supply = null;
  try { supply = totalSupply ? BigInt(totalSupply) : null; } catch { supply = null; }
  const pctOf = v => {
    try { return supply && supply > 0n ? Math.min(100, Number((BigInt(v) * 100000n) / supply) / 1000) : null; } catch { return null; }
  };
  const rows = items.slice(0, 50).map(h => ({
    address: isAddr(obj(h.address).hash) ? h.address.hash.toLowerCase() : null,
    name: cleanText(obj(h.address).name ?? obj(obj(h.address).metadata).tags?.[0]?.name, 100),
    is_contract: typeof obj(h.address).is_contract === 'boolean' ? h.address.is_contract : null,
    pct: pctOf(h.value)
  })).filter(h => h.address);
  const sum = list => (list.some(r => r.pct === null) || !list.length ? null : Math.min(100, Math.round(list.reduce((a, r) => a + r.pct, 0) * 1000) / 1000));
  const morpho = rows.find(r => r.address === MORPHO_BLUE);
  const own = rows.filter(r => r.address !== MORPHO_BLUE && !(r.is_contract && PROTOCOL_NAME_RE.test(r.name ?? '')));
  return {
    top1_pct: rows[0]?.pct ?? null,
    top10_pct: sum(rows.slice(0, 10)),
    top1_nonprotocol_pct: own[0]?.pct ?? null,
    top10_nonprotocol_pct: sum(own.slice(0, 10)),
    top10_contracts: rows.length ? rows.slice(0, 10).filter(r => r.is_contract).length : null,
    morpho_blue_pct: rows.length && supply ? (morpho?.pct ?? 0) : null,
    top: rows.slice(0, 5)
  };
}

// --- DefiLlama --------------------------------------------------------------------------------------------------

/** @returns {{usd, confidence, price_ts}|null} price of the coin `key` ("ethereum:0x...") */
export function parseLlamaPrice(j, key) {
  const c = obj(obj(obj(j).coins)[key] ?? Object.values(obj(obj(j).coins))[0]);
  const usd = num(c.price);
  const decimals = num(c.decimals);
  return usd === null ? null : { usd, confidence: num(c.confidence), price_ts: num(c.timestamp),
    decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null, symbol: cleanText(c.symbol, 40) };
}

/** @returns {{min, max, last, count, range_pct}|null} summary of the daily price chart */
export function parseLlamaChart(j, key) {
  const c = obj(obj(obj(j).coins)[key] ?? Object.values(obj(obj(j).coins))[0]);
  const vals = (Array.isArray(c.prices) ? c.prices : []).map(p => num(p?.price)).filter(v => v !== null);
  if (!vals.length) return null;
  const min = Math.min(...vals), max = Math.max(...vals);
  return { min, max, last: vals[vals.length - 1], count: vals.length, range_pct: min > 0 ? Math.round(((max - min) / min) * 100000) / 1000 : null };
}

// --- GeckoTerminal ----------------------------------------------------------------------------------------------

/** @returns {{holders_count, top10_pct, websites:string[], gt_score}|null} */
export function parseGeckoInfo(j) {
  const a = obj(obj(obj(j).data).attributes);
  if (!a.address) return null;
  const top10 = num(obj(obj(a.holders).distribution_percentage).top_10);
  return {
    holders_count: num(obj(a.holders).count),
    top10_pct: top10 !== null && top10 >= 0 && top10 <= 100 ? top10 : null, // GeckoTerminal sometimes reports shares far above 100: junk

    websites: (Array.isArray(a.websites) ? a.websites : []).filter(w => typeof w === 'string' && /^https:\/\//.test(w)).slice(0, 3).map(w => w.slice(0, 200)),
    gt_score: num(a.gt_score)
  };
}

/** @returns {{pools_count, total_reserve_usd, total_volume_24h_usd, pools:Array}|null} the 5 biggest pools by reserve */
export function parseGeckoPools(j) {
  const data = Array.isArray(obj(j).data) ? j.data : null;
  if (!data) return null;
  const pools = data.map(p => {
    const a = obj(p.attributes);
    return { dex: cleanText(obj(obj(obj(p.relationships).dex).data).id, 60), reserve_usd: num(a.reserve_in_usd), volume_24h_usd: num(obj(a.volume_usd).h24), created_at: cleanText(a.pool_created_at, 30) };
  }).sort((x, y) => (y.reserve_usd ?? 0) - (x.reserve_usd ?? 0));
  const sum = key => Math.round(pools.reduce((s, p) => s + (p[key] ?? 0), 0) * 100) / 100;
  return { pools_count: pools.length, total_reserve_usd: sum('reserve_usd'), total_volume_24h_usd: sum('volume_24h_usd'), pools: pools.slice(0, 5) };
}

// --- Kyber ------------------------------------------------------------------------------------------------------

// Kyber error codes that mean "there is no way to sell this token" rather than a broken request
const KYBER_NO_ROUTE_CODES = [4008, 4010, 4011];

/**
 * One swap quote of `requestedUsd` dollars of the token (the amount was computed from the DefiLlama price).
 * price_impact_pct = (1 - out_usd / requestedUsd) * 100, never below 0. Kyber's own `amountInUsd` prices the input with its
 * own (often wrong) token price, so it is kept only as `kyber_in_usd` for comparison.
 * A refused request keeps a short reason from the body (code, message and field violation).
 * @param {number} httpStatus
 * @param {*} j Parsed body
 * @param {number} requestedUsd Size of the request in USD (100000 or 1000000)
 * @returns {{status:'ok'|'no_route'|'error', price_impact_pct, out_usd, kyber_in_usd, gas_usd, dexes:string[], reason?:string}}
 */
export function parseKyber(httpStatus, j, requestedUsd) {
  const empty = (status, reason) => ({ status, price_impact_pct: null, out_usd: null, kyber_in_usd: null, gas_usd: null, dexes: [], reason });
  const body = obj(j);
  const rs = obj(body.data).routeSummary;
  if (httpStatus !== 200 || !rs) {
    const code = num(body.code);
    const violation = (Array.isArray(body.details) ? body.details : []).flatMap(d => obj(d).fieldViolations ?? []).map(v => [obj(v).field, obj(v).description].filter(Boolean).join(' '))[0];
    const reason = cleanText([code, body.message, violation].filter(x => x !== null && x !== undefined && x !== '').join(' '), 120) ?? (httpStatus ? `HTTP ${httpStatus}` : 'no response');
    const noRoute = httpStatus === 404 || KYBER_NO_ROUTE_CODES.includes(code) || /route not found|token not found/i.test(String(body.message ?? ''));
    return empty(noRoute ? 'no_route' : 'error', reason);
  }
  if (!(requestedUsd > 0)) return empty('error', 'no requested size');
  const inUsd = num(rs.amountInUsd), outUsd = num(rs.amountOutUsd);
  if (outUsd === null || !(num(rs.amountOut) > 0)) return empty('no_route', 'empty route');
  // a USDC output Kyber left unpriced is not a 100% loss
  if (!(outUsd > 0)) return empty('error', 'output has no USD value');
  const dexes = [];
  for (const leg of Array.isArray(rs.route) ? rs.route : []) {
    for (const swap of Array.isArray(leg) ? leg : [leg]) { const d = cleanText(swap?.exchange ?? swap?.pool, 60); if (d && !dexes.includes(d)) dexes.push(d); }
  }
  return { status: 'ok', price_impact_pct: Math.max(0, Math.round((1 - outUsd / requestedUsd) * 100000) / 1000), out_usd: Math.round(outUsd * 100) / 100,
    kyber_in_usd: inUsd === null ? null : Math.round(inUsd * 100) / 100, gas_usd: num(rs.gasUsd), dexes: dexes.slice(0, 8) };
}

// --- Block explorer "Read Contract" page ------------------------------------------------------------------------

/**
 * Values of the zero-argument view functions from an Etherscan-family "Read Contract" page (m=light).
 * Each function sits in an accordion: `N. name (0xselector)`, then parameter badges when it takes arguments, then the value and a type badge.
 * @returns {Record<string,string>|null} name to value (at most 40), null when the page has no functions
 */
export function parseReadContract(html) {
  if (typeof html !== 'string' || !html.includes('contract-fn-title')) return null;
  const out = {};
  for (const chunk of html.split('contract-fn-title small py-1.5 me-1">').slice(1)) {
    const name = /^\d+\.\s*([A-Za-z_$][\w$]*)/.exec(chunk)?.[1];
    if (!name || Object.keys(out).length >= 40) continue;
    const body = chunk.indexOf('accordion-body');
    if (body < 0 || chunk.slice(0, body).includes('data-notes-id="function-params"')) continue; // takes arguments
    const rest = chunk.slice(body).split('<div class="row gx-1"></div>')[1];
    if (rest === undefined) continue;
    const value = cleanText(rest.split('<span class="badge')[0].replace(/&#39;/g, "'").replace(/&amp;/g, '&'), 200);
    if (value && !/^Query\b/.test(value)) out[name] = value;
  }
  return Object.keys(out).length ? out : null;
}

// Most powerful roles first: only the first 4 distinct addresses are looked up
const CONTROL_KEYS = ['owner', 'admin', 'proxyAdmin', 'authority', 'accessControl', 'governor', 'getCCIPAdmin', 'pauser', 'blacklister', 'masterMinter', 'minter',
  'curator', 'guardian'];

/** @returns {Array<{address, role}>} addresses that hold a control role in the view values, deduplicated, at most 4 */
export function controllerAddresses(values) {
  const byAddr = new Map();
  for (const key of CONTROL_KEYS) {
    const v = obj(values)[key];
    if (!isAddr(v) || v.toLowerCase() === ZERO_ADDRESS) continue;
    const a = v.toLowerCase();
    const seen = byAddr.get(a);
    byAddr.set(a, { address: seen?.address ?? v, role: seen ? `${seen.role},${key}` : key });
  }
  return [...byAddr.values()].slice(0, 4);
}

// --- Safe -------------------------------------------------------------------------------------------------------

/** @returns {{threshold, owner_count}|null} null for an address that is not a Safe (the service answers 404) */
export function parseSafe(httpStatus, j) {
  if (httpStatus !== 200) return null;
  const threshold = num(obj(j).threshold);
  return threshold === null || !Array.isArray(obj(j).owners) ? null : { threshold, owner_count: j.owners.length };
}

// --- JSON-RPC ---------------------------------------------------------------------------------------------------

const rpcWord = j => {
  const r = obj(j).result;
  return typeof r === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r) ? r.toLowerCase() : null;
};

/** Address held in a 32-byte storage word or call result; null for zero, an error, an empty result ("0x") or junk. */
export function parseRpcAddress(j) {
  const w = rpcWord(j);
  if (!w || !/^0x0{24}/.test(w)) return null;
  const a = '0x' + w.slice(26);
  return a === ZERO_ADDRESS ? null : a;
}

/** Unsigned integer of a call result as a number (seconds of a delay); null for an error, "0x" or a value above 2^53. */
export function parseRpcUint(j) {
  const w = rpcWord(j);
  if (!w) return null;
  const v = BigInt(w);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}

/** Text of a name()/symbol() call result: an ABI string, or a bytes32 for old tokens; null for an error, "0x" or junk. */
export function parseRpcString(j) {
  const r = obj(j).result;
  if (typeof r !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(r)) return null;
  const b = Buffer.from(r.slice(2), 'hex');
  let raw = null;
  if (b.length === 32) raw = b.toString('utf8');
  else if (b.length >= 64 && BigInt('0x' + b.subarray(0, 32).toString('hex')) === 32n) {
    const len = Number(BigInt('0x' + b.subarray(32, 64).toString('hex')));
    if (len > 0 && len <= 200 && b.length >= 64 + len) raw = b.subarray(64, 64 + len).toString('utf8');
  }
  return raw === null ? null : cleanText(raw.replace(/\0/g, ''), 100);
}

/** Unsigned integer of a call result as a decimal string (a total supply does not fit a number); null for an error, "0x" or junk. */
export function parseRpcBigUint(j) {
  const w = rpcWord(j);
  return w ? BigInt(w).toString() : null;
}

/** Length of a dynamic array in a call result (getOwners of a Safe); null for an error or junk. */
export function parseRpcArrayLength(j) {
  const r = obj(j).result;
  if (typeof r !== 'string' || !/^0x[0-9a-fA-F]{128,}$/.test(r)) return null;
  const n = BigInt('0x' + r.slice(66, 130));
  return n <= 1000n ? Number(n) : null;
}

// --- ERC-4626 share price ---------------------------------------------------------------------------------------

/**
 * Underlying assets per share from the vault's own totalAssets and totalSupply (Read Contract values), in asset units.
 * The asset's decimals are not in the record, so a ratio far from 1 is scaled by the decimals offset: DECIMALS_OFFSET when the
 * contract shows it, else the power of ten among 6, 8, 10, 12 that brings it closest to 1.
 * shortcut: the guessed offset is wrong for a vault that lost over 99.9% of its value; read the asset's decimals when that matters.
 * @returns {number|null}
 */
export function parseSharePrice(values) {
  const v = obj(values);
  let assets, supply;
  try { assets = BigInt(v.totalAssets); supply = BigInt(v.totalSupply); } catch { return null; }
  if (supply <= 0n || assets < 0n || !isAddr(v.asset)) return null;
  const raw = Number((assets * 10n ** 36n) / supply) / 1e36;
  if (!(raw > 0)) return raw === 0 ? 0 : null;
  const exp = -Math.log10(raw);
  let k = 0;
  if (Math.abs(exp) >= 3) {
    k = num(v.DECIMALS_OFFSET ?? v.decimalsOffset) ?? [6, 8, 10, 12].find(d => Math.abs(exp - d) < 1.5) ?? null;
    if (k === null) return null;
  }
  return Math.round(raw * 10 ** k * 1e8) / 1e8;
}

// --- Pendle -----------------------------------------------------------------------------------------------------

/**
 * Expiry of a principal token: from its active market, else from the PT contract itself (`expiry` in unix seconds, `isExpired`).
 * @returns {{expiry:string|null, expired:boolean|null}}
 */
export function parsePtExpiry(market, values, nowMs = Date.now()) {
  const v = obj(values);
  const sec = num(v.expiry);
  const ms = Date.parse(obj(market).expiry ?? '') || (sec > 0 ? sec * 1000 : NaN);
  if (Number.isFinite(ms)) return { expiry: new Date(ms).toISOString(), expired: nowMs >= ms };
  const flag = String(v.isExpired ?? '').toLowerCase();
  return { expiry: null, expired: flag === 'true' ? true : flag === 'false' ? false : null };
}

/**
 * The active market of a principal token. Pendle writes ids as "<chainId>-<address>".
 * @returns {{market, expiry, days_to_expiry, underlying, liquidity_usd, implied_apy, active:true}|null} null when no active market has this PT
 */
export function parsePendleMarket(j, ptAddress, nowMs = Date.now()) {
  const list = Array.isArray(obj(j).results) ? j.results : Array.isArray(obj(j).markets) ? j.markets : Array.isArray(j) ? j : [];
  const strip = v => String(typeof v === 'string' ? v : obj(v).address ?? '').toLowerCase().replace(/^\d+-/, '');
  const m = list.find(x => strip(x?.pt) === String(ptAddress).toLowerCase());
  if (!m) return null;
  const expiry = Date.parse(m.expiry);
  return {
    market: isAddr(m.address) ? m.address.toLowerCase() : null,
    expiry: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null,
    days_to_expiry: Number.isFinite(expiry) ? Math.floor((expiry - nowMs) / 86400000) : null,
    underlying: strip(m.underlyingAsset) || null,
    liquidity_usd: num(obj(m.details).liquidity), implied_apy: num(obj(m.details).impliedApy), active: true
  };
}

// --- Chainlink feed catalog -------------------------------------------------------------------------------------

/** Base side of a pair in a feed name ("nvPRIME / PRIME Exchange Rate" -> "nvprime", "cbETH-ETH Exchange Rate" -> "cbeth"), else null. */
const feedPairBase = name => (/([A-Za-z0-9.+_]+)\s*\/\s*[A-Za-z0-9]/.exec(name) ?? /^([A-Za-z0-9.+_]+)-[A-Za-z0-9]+\b/.exec(name))?.[1].toLowerCase() ?? null;

/**
 * Feeds of the Chainlink reference-data directory that belong to a token symbol, compared whole and case-insensitively.
 * A feed whose name is a pair belongs to the token only when the base of the pair is the symbol: the catalog's docs.baseAsset is
 * sometimes wrong ("nvPRIME / PRIME" is filed under PRIME). Other feeds match on docs.baseAsset or the first word of the name.
 * @returns {{feeds:Array, has_por_feed:boolean}|null}
 */
export function parseFeeds(j, symbol) {
  if (!Array.isArray(j) || !symbol) return null;
  const sym = String(symbol).toLowerCase();
  const own = j.filter(f => {
    const name = String(f?.name ?? '');
    const pair = feedPairBase(name);
    if (pair) return pair === sym;
    return String(obj(f?.docs).baseAsset ?? '').toLowerCase() === sym || name.toLowerCase().split(/\s/)[0] === sym;
  });
  const feeds = own.slice(0, 3).map(f => ({
    name: cleanText(f.name, 100), category: cleanText(f.feedCategory, 20), heartbeat_sec: num(f.heartbeat), deviation_pct: num(f.threshold),
    proxy_address: isAddr(f.proxyAddress) ? f.proxyAddress.toLowerCase() : null, product_type: cleanText(obj(f.docs).productType, 40)
  }));
  return { feeds, has_por_feed: own.some(f => /proof of reserve/i.test(String(obj(f.docs).productType ?? f.name ?? ''))) };
}

// --- rwa.xyz ----------------------------------------------------------------------------------------------------

/**
 * The asset JSON of an rwa.xyz page (`__NEXT_DATA__`), accepted only when one of its tokens has this contract address.
 * @returns {object|null}
 */
export function parseRwa(html, address) {
  const m = typeof html === 'string' ? /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html) : null;
  const asset = obj(obj(obj(parseJson(m?.[1])).props).pageProps).asset;
  if (!asset || !Array.isArray(asset.tokens) || !asset.tokens.some(t => String(t?.address ?? '').toLowerCase() === String(address).toLowerCase())) return null;
  const val = x => num(obj(x).val ?? x);
  return {
    ticker: cleanText(asset.ticker, 40), issuer: cleanText(obj(asset.issuer).name, 100), manager: cleanText(obj(asset.manager).name, 100),
    custodian: cleanText(obj(asset.traditional_custodian).name, 100), transfer_agent: cleanText(obj(asset.transfer_agent).name, 100),
    administrator: cleanText(obj(asset.fund_administrator).name, 100), auditor: cleanText(obj(asset.auditor).name, 100),
    nav_usd: val(asset.net_asset_value_dollar), redemption_frequency: cleanText(asset.primary_market__redemption_frequency, 40),
    redemption_fee_bps: num(asset.primary_market__redemption_fee_bps), min_subscription_usd: num(asset.primary_market__minimum_subscription_amt),
    kyc_required: typeof asset.primary_market__is_kyc_required === 'boolean' ? asset.primary_market__is_kyc_required : null,
    bankruptcy_remote: typeof asset.are_holdings_bankruptcy_remote === 'boolean' ? asset.are_holdings_bankruptcy_remote : null,
    regulatory_framework: cleanText(asset.regulatory_framework, 100), jurisdiction: cleanText(asset.jurisdiction_country_name ?? asset.jurisdiction_country, 100),
    holders_count: val(asset.holding_addresses_count)
  };
}
