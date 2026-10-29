/**
 * Collects Morpho asset tags and USD prices of collateral tokens into the token_tags table. Tags are cached with a TTL;
 * a failing request keeps the cached row.
 */
import { fetchMorphoGraphQL } from './morphoApi.js';

export const TAGS_TTL_SEC = 86400;

const MORPHO_BATCH = 100;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const lower = a => String(a || '').trim().toLowerCase();

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
      `{ assets(first: ${MORPHO_BATCH}, where: { chainId_in: [${Number(chainId)}], address_in: ${JSON.stringify(batch)} }) { items { address tags price { usd } } } }`
    );
    const items = data?.assets?.items;
    if (!Array.isArray(items)) throw new Error('Malformed assets response');
    for (const it of items) {
      const price = Number(it.price?.usd);
      found.set(lower(it.address), { tags: Array.isArray(it.tags) ? it.tags : [], priceUsd: it.price?.usd != null && Number.isFinite(price) ? price : null });
    }
  }
  return found;
}

const isStale = (at, ttl, now) => at == null || at < now - ttl;
const key = (chain, addr) => `${chain}:${addr}`;

/**
 * Fetches Morpho tags and price for every collateral token that has none yet or whose tags are past the TTL.
 * A failing chain is reported in `failed` and leaves its cached rows untouched.
 * @returns {Promise<{tagsFetched:number, failed:string[]}>}
 */
export async function refreshTokenTags(db, nowSec = Math.floor(Date.now() / 1000)) {
  const stats = { tagsFetched: 0, failed: [] };
  const rows = new Map(db.prepare('SELECT * FROM token_tags').all().map(r => [key(r.chain_id, r.address), { ...r }]));
  const wanted = new Set();
  for (const r of db.prepare("SELECT DISTINCT chain_id, collateral_asset_address AS address FROM markets WHERE collateral_asset_address <> ''").all()) {
    const k = key(r.chain_id, lower(r.address));
    if (!rows.has(k)) rows.set(k, { chain_id: r.chain_id, address: lower(r.address), tags_json: null, price_usd: null, tags_fetched_at: null });
    wanted.add(k);
  }

  // Batched per chain; 'null' tags_json means Morpho does not know the token
  const byChain = new Map();
  for (const k of wanted) {
    const r = rows.get(k);
    if (isStale(r.tags_fetched_at, TAGS_TTL_SEC, nowSec)) byChain.set(r.chain_id, [...(byChain.get(r.chain_id) || []), r.address]);
  }
  for (const [chain, addrs] of byChain) {
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
      console.warn(`[TokenTags] Morpho tags chain ${chain}: ${err.message}`);
    }
  }

  const upsert = db.prepare(`
    INSERT INTO token_tags (chain_id, address, tags_json, price_usd, tags_fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chain_id, address) DO UPDATE SET tags_json = excluded.tags_json, price_usd = excluded.price_usd, tags_fetched_at = excluded.tags_fetched_at
  `);
  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    for (const k of wanted) { const r = rows.get(k); upsert.run(r.chain_id, r.address, r.tags_json, r.price_usd, r.tags_fetched_at); }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return stats;
}
