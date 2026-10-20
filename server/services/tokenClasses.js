/**
 * Collects platform data about collateral tokens (Morpho asset tags, Pendle markets) into the token_classes table
 * and derives each token's risk class from it. Each source is cached with a TTL; a failing source keeps the cache.
 */
import { CONFIG } from '../config.js';
import { fetchMorphoGraphQL } from './morphoApi.js';
import { deriveTokenClass } from '../engine/collateralEngine.js';

export const TAGS_TTL_SEC = 86400;
export const PENDLE_TTL_SEC = 7 * 86400;
export const CG_TTL_SEC = 7 * 86400;

const PENDLE_API = 'https://api-v2.pendle.finance/core/v1';
const MORPHO_BATCH = 100;
const PEG_TAGS = ['stablecoin', 'usd-pegged', 'eur-pegged', 'EUR'];
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lower = a => String(a || '').trim().toLowerCase();
// Pendle writes tokens as "chainId-0x..." (a plain object with id/address is accepted too)
const pendleAddress = v => lower(String((typeof v === 'string' ? v : v?.address ?? v?.id) ?? '').split('-').pop());

/**
 * Tags and USD price of tokens on one chain. A token Morpho does not know is absent from the result.
 * @returns {Promise<Map<string, {tags:string[], priceUsd:number|null}>>} keys are lowercase addresses; throws when a request fails
 */
export async function fetchMorphoAssets(chainId, addresses) {
  const found = new Map();
  const valid = [...new Set(addresses.map(lower))].filter(a => ADDRESS_RE.test(a));
  for (let i = 0; i < valid.length; i += MORPHO_BATCH) {
    // Addresses are validated above, so inlining them is safe; assetByAddress is not used because one unknown token nulls its whole batch
    const batch = valid.slice(i, i + MORPHO_BATCH);
    const data = await fetchMorphoGraphQL(
      `{ assets(first: ${MORPHO_BATCH}, where: { chainId_in: [${Number(chainId)}], address_in: ${JSON.stringify(batch)} }) { items { address tags priceUsd } } }`
    );
    const items = data?.assets?.items;
    if (!Array.isArray(items)) throw new Error('Malformed assets response');
    for (const it of items) {
      const price = Number(it.priceUsd);
      found.set(lower(it.address), { tags: Array.isArray(it.tags) ? it.tags : [], priceUsd: it.priceUsd != null && Number.isFinite(price) ? price : null });
    }
  }
  return found;
}

/**
 * Pendle token roles on one chain (active and inactive markets).
 * @returns {Promise<Map<string, {type:'PT'|'YT'|'SY'|'LP', expiry:number|null, underlying:string|null}>|null>}
 *   null when Pendle does not support the chain (HTTP 400); throws on any other failure. expiry is unix seconds.
 */
export async function fetchPendleMarkets(chainId) {
  const roles = new Map();
  for (const kind of ['active', 'inactive']) {
    const res = await fetch(`${PENDLE_API}/${Number(chainId)}/markets/${kind}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CONFIG.api.requestTimeoutMs)
    });
    if (res.status === 400) return null;
    if (!res.ok) throw new Error(`Pendle HTTP ${res.status} on chain ${chainId}`);
    const markets = (await res.json())?.markets;
    if (!Array.isArray(markets)) throw new Error('Malformed Pendle markets response');
    for (const m of markets) {
      const expiry = Date.parse(m.expiry) / 1000;
      const info = { expiry: Number.isFinite(expiry) ? Math.round(expiry) : null, underlying: pendleAddress(m.underlyingAsset) || null };
      for (const [type, addr] of [['PT', pendleAddress(m.pt)], ['YT', pendleAddress(m.yt)], ['SY', pendleAddress(m.sy)], ['LP', lower(m.address)]]) {
        if (ADDRESS_RE.test(addr) && !roles.has(addr)) roles.set(addr, { type, ...info });
      }
    }
    if (kind === 'active') await sleep(CONFIG.api.pageThrottleMs);
  }
  return roles;
}

/**
 * Median USD price of the ETH and BTC token families, from tokens that carry exactly one of the two tags and no peg tag.
 * @param {Array<{tags:string[]|null, priceUsd:number|null}>} rows
 * @returns {{eth:number|null, btc:number|null}}
 */
export function familyMedians(rows) {
  const prices = { eth: [], btc: [] };
  for (const { tags, priceUsd } of rows) {
    if (!tags || !(priceUsd > 0) || tags.some(t => PEG_TAGS.includes(t))) continue;
    const eth = tags.includes('eth');
    if (eth !== tags.includes('btc')) prices[eth ? 'eth' : 'btc'].push(priceUsd);
  }
  const median = list => {
    if (!list.length) return null;
    const s = list.sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  return { eth: median(prices.eth), btc: median(prices.btc) };
}

const parse = json => { try { return json == null ? null : JSON.parse(json); } catch { return null; } };
const isStale = (at, ttl, now) => at == null || at < now - ttl;
const key = (chain, addr) => `${chain}:${addr}`;

/**
 * Refreshes stale platform data of every collateral token (and the base assets of Pendle PTs) and re-derives all classes.
 * A failing source is reported in `failed` and leaves the cached fields untouched.
 * @returns {Promise<{tagsFetched:number, pendleChains:number, failed:string[], derived:number}>}
 */
export async function refreshTokenClasses(db, nowSec = Math.floor(Date.now() / 1000)) {
  const stats = { tagsFetched: 0, pendleChains: 0, failed: [], derived: 0 };
  const rows = new Map(db.prepare('SELECT * FROM token_classes').all().map(r => [key(r.chain_id, r.address), { ...r }]));
  const ensure = (chain, addr) => {
    if (!rows.has(key(chain, addr))) {
      rows.set(key(chain, addr), {
        chain_id: chain, address: addr, tags_json: null, price_usd: null, tags_fetched_at: null, pendle_json: null, pendle_fetched_at: null,
        coingecko_json: null, coingecko_fetched_at: null, derived_class: 'UNKNOWN', underlying_class: null, maturity: null, source: 'none', derived_at: null
      });
    }
    return rows.get(key(chain, addr));
  };
  const groupByChain = list => {
    const m = new Map();
    for (const r of list) m.set(r.chain_id, [...(m.get(r.chain_id) || []), r.address]);
    return m;
  };

  const wanted = new Set();
  for (const r of db.prepare("SELECT DISTINCT chain_id, collateral_asset_address AS address FROM markets WHERE collateral_asset_address <> ''").all()) {
    ensure(r.chain_id, lower(r.address));
    wanted.add(key(r.chain_id, lower(r.address)));
  }

  // Pendle: one pair of requests per chain that has a new or expired token
  const pendleMaps = new Map();
  const applyPendle = row => {
    const roles = pendleMaps.get(row.chain_id);
    row.pendle_json = JSON.stringify(roles?.get(row.address) ?? null);
    row.pendle_fetched_at = nowSec;
  };
  const needPendle = [...wanted].map(k => rows.get(k)).filter(r => isStale(r.pendle_fetched_at, PENDLE_TTL_SEC, nowSec));
  for (const [chain, addrs] of groupByChain(needPendle)) {
    try {
      pendleMaps.set(chain, await fetchPendleMarkets(chain));
    } catch (err) {
      stats.failed.push(`pendle:${chain}`);
      console.warn(`[TokenClasses] Pendle chain ${chain}: ${err.message}`);
      continue;
    }
    stats.pendleChains++;
    for (const addr of addrs) applyPendle(rows.get(key(chain, addr)));
  }

  // A PT is as risky as its base asset, so the base needs data too (from the same Pendle answers when they exist)
  for (const k of [...wanted]) {
    const r = rows.get(k);
    const pendle = parse(r.pendle_json);
    if (pendle?.type !== 'PT' || !pendle.underlying) continue;
    const base = ensure(r.chain_id, pendle.underlying);
    wanted.add(key(base.chain_id, base.address));
    if (isStale(base.pendle_fetched_at, PENDLE_TTL_SEC, nowSec) && pendleMaps.has(base.chain_id)) applyPendle(base);
  }

  // Morpho tags: batched per chain, only tokens never fetched or past the TTL
  const needTags = [...wanted].map(k => rows.get(k)).filter(r => isStale(r.tags_fetched_at, TAGS_TTL_SEC, nowSec));
  for (const [chain, addrs] of groupByChain(needTags)) {
    try {
      const assets = await fetchMorphoAssets(chain, addrs);
      for (const addr of addrs) {
        const row = rows.get(key(chain, addr));
        const asset = assets.get(addr);
        row.tags_json = JSON.stringify(asset?.tags ?? null);
        row.price_usd = asset?.priceUsd ?? null;
        row.tags_fetched_at = nowSec;
        stats.tagsFetched++;
      }
    } catch (err) {
      stats.failed.push(`tags:${chain}`);
      console.warn(`[TokenClasses] Morpho tags chain ${chain}: ${err.message}`);
    }
  }

  // Derive: non-PT first, then PT (needs the base class). Pendle tokens are left out of the family medians.
  const all = [...rows.values()];
  const medians = familyMedians(all.filter(r => parse(r.pendle_json) == null).map(r => ({ tags: parse(r.tags_json), priceUsd: r.price_usd })));
  const derive = row => {
    const tags = parse(row.tags_json), pendle = parse(row.pendle_json);
    const median = tags?.includes('eth') ? medians.eth : tags?.includes('btc') ? medians.btc : null;
    const priceRatio = median && row.price_usd > 0 ? row.price_usd / median : null;
    const underlyingClass = pendle?.underlying ? rows.get(key(row.chain_id, pendle.underlying))?.derived_class ?? null : null;
    const res = deriveTokenClass({ tags, pendle, priceRatio, underlyingClass });
    if (!res) return; // price ratio unknown: keep the previous class (UNKNOWN for a new token)
    Object.assign(row, { derived_class: res.class, underlying_class: res.underlyingClass ?? null, maturity: res.maturity ?? null, source: res.source, derived_at: nowSec });
    stats.derived++;
  };
  const isPt = r => parse(r.pendle_json)?.type === 'PT';
  all.filter(r => !isPt(r)).forEach(derive);
  all.filter(isPt).forEach(derive);

  const upsert = db.prepare(`
    INSERT INTO token_classes (chain_id, address, tags_json, price_usd, tags_fetched_at, pendle_json, pendle_fetched_at,
      coingecko_json, coingecko_fetched_at, derived_class, underlying_class, maturity, source, derived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chain_id, address) DO UPDATE SET
      tags_json = excluded.tags_json, price_usd = excluded.price_usd, tags_fetched_at = excluded.tags_fetched_at,
      pendle_json = excluded.pendle_json, pendle_fetched_at = excluded.pendle_fetched_at,
      coingecko_json = excluded.coingecko_json, coingecko_fetched_at = excluded.coingecko_fetched_at,
      derived_class = excluded.derived_class, underlying_class = excluded.underlying_class, maturity = excluded.maturity,
      source = excluded.source, derived_at = excluded.derived_at
  `);
  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    for (const r of all) {
      upsert.run(r.chain_id, r.address, r.tags_json, r.price_usd, r.tags_fetched_at, r.pendle_json, r.pendle_fetched_at,
        r.coingecko_json, r.coingecko_fetched_at, r.derived_class, r.underlying_class, r.maturity, r.source, r.derived_at);
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return stats;
}
