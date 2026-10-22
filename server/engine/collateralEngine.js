/**
 * Collateral breakdown of a vault: how much of the verified capital is lent against each collateral token.
 * The engine makes no judgement about a token; the facts about each token are collected in token_data (services/tokenCollector.js).
 *
 * Shares are measured against the verified capital (TVL minus capital behind adapters that could not be expanded),
 * the same base the other engines use.
 */
import { isIdleReserveMarket } from './hhiEngine.js';

const keyOf = (chainId, address) => `${Number(chainId)}:${String(address || '').trim().toLowerCase()}`;

/** Tags from a token_tags JSON string; null when missing, 'null' or malformed. */
export function parseTagsJson(json) {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : null; } catch { return null; }
}

/**
 * @param {object} vault Vault row (use the one from withMaterialUnresolved)
 * @param {Array<object>} allocations Allocations joined with markets
 * @returns {{tier:'UNKNOWN'|'UNALLOCATED'|'ALLOCATED', tokens:Array, idlePercent:number, undeployedPercent:number, unverifiedPercent:number}}
 */
export function calculateCollateralMix(vault, allocations = []) {
  const totalUsd = Number(vault.total_assets_usd) || 0;
  const unresolvedUsd = Math.min(totalUsd, Math.max(0, Number(vault.unresolved_exposure_usd) || 0));
  const knownUsd = totalUsd - unresolvedUsd;
  const unverifiedPercent = totalUsd > 0 ? Math.round((unresolvedUsd / totalUsd) * 10000) / 100 : 0;
  const pct = usd => (knownUsd > 0 ? Math.round((usd / knownUsd) * 10000) / 100 : 0);
  const round = usd => Math.round(usd * 100) / 100;

  const byToken = new Map();
  let idleUsd = 0;
  let deployedUsd = 0;
  for (const alloc of allocations) {
    const usd = Math.max(0, Number(alloc.supply_assets_usd) || 0);
    if (usd <= 0) continue;
    if (isIdleReserveMarket(alloc)) { idleUsd += usd; continue; }
    const key = keyOf(alloc.chain_id, alloc.collateral_asset_address);
    const t = byToken.get(key) || {
      chainId: alloc.chain_id, address: String(alloc.collateral_asset_address || '').toLowerCase(), symbol: alloc.collateral_asset_symbol, usd: 0
    };
    t.usd += usd;
    byToken.set(key, t);
    deployedUsd += usd;
  }

  return {
    tier: knownUsd <= 0 ? 'UNKNOWN' : deployedUsd <= 0 ? 'UNALLOCATED' : 'ALLOCATED',
    tokens: [...byToken.values()].sort((a, b) => b.usd - a.usd).map(t => ({ ...t, usd: round(t.usd), percent: pct(t.usd) })),
    idlePercent: pct(idleUsd),
    undeployedPercent: pct(Math.max(0, knownUsd - idleUsd - deployedUsd)),
    unverifiedPercent
  };
}

/**
 * Adds the curated category of every token (server/data/tokenClasses.json, key "chainId:address") and the share of the collateral
 * in each category. A token with no record is `unclassified`. Shares use the same base as the mix; idle cash is in no category.
 * @returns {object} the mix with `category`/`subtype`/`categoryConfidence` on every token plus `categoryShares` ({ category: percent })
 */
export function withTokenClasses(mix, classByToken) {
  const categoryShares = {};
  const tokens = (mix.tokens || []).map(t => {
    const c = classByToken?.get(keyOf(t.chainId, t.address));
    const category = c?.category ?? 'unclassified';
    categoryShares[category] = Math.round(((categoryShares[category] ?? 0) + t.percent) * 100) / 100;
    return { ...t, category, subtype: c?.subtype ?? null, categoryConfidence: c?.confidence ?? null };
  });
  return { ...mix, tokens, categoryShares };
}
