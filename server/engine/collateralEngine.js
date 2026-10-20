/**
 * Collateral model "ai-research-1". Every collateral token has an optional risk tier 1..5 from the AI research table
 * (token_research, see services/tokenResearch.js). A token with no usable record is unrated, and unrated is never treated
 * as safe. A record is usable when it is rated, has a tier and is not older than RESEARCH_MAX_AGE_SEC.
 *
 * Shares are measured against the verified capital (TVL minus capital behind adapters that could not be expanded),
 * the same base the other engines use. There are no weights; the tier is a judgement of an AI agent, not a measured value.
 */
import { isIdleReserveMarket } from './hhiEngine.js';

const keyOf = (chainId, address) => `${Number(chainId)}:${String(address || '').trim().toLowerCase()}`;

export const COLLATERAL_MODEL = 'ai-research-1';
// A research record older than this counts as unrated
export const RESEARCH_MAX_AGE_SEC = 60 * 86400;

/** Tags from a token_tags JSON string; null when missing, 'null' or malformed. */
export function parseTagsJson(json) {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : null; } catch { return null; }
}

/** True when the allocation's collateral has a usable research record (rated, tier 1..5, fresh). */
export function isResearchRated(alloc, nowSec = Math.floor(Date.now() / 1000)) {
  const tier = Number(alloc.collateral_risk_tier);
  return alloc.collateral_research_status === 'rated' && Number.isInteger(tier) && tier >= 1 && tier <= 5
    && Number(alloc.collateral_researched_at) >= nowSec - RESEARCH_MAX_AGE_SEC;
}

/** Tier 1..5 of the allocation's collateral, or null when it is unrated. */
export function researchTierOf(alloc, nowSec = Math.floor(Date.now() / 1000)) {
  return isResearchRated(alloc, nowSec) ? Number(alloc.collateral_risk_tier) : null;
}

/** Tier 5 with a confidence above low: the only state that raises a flag. */
export function isImpairedCollateral(alloc, nowSec = Math.floor(Date.now() / 1000)) {
  return researchTierOf(alloc, nowSec) === 5 && alloc.collateral_confidence !== 'low';
}

/**
 * Tier mix of a vault. Same percent base as the other engines (TVL minus unverified capital).
 * @param {object} vault Vault row (use the one from withMaterialUnresolved)
 * @param {Array<object>} allocations Allocations joined with markets and token_research (collateral_risk_tier, collateral_confidence,
 *   collateral_researched_at, collateral_research_status, collateral_category)
 * @param {number} nowSec Clock for the freshness rule
 */
export function calculateResearchMix(vault, allocations = [], nowSec = Math.floor(Date.now() / 1000)) {
  const totalUsd = Number(vault.total_assets_usd) || 0;
  const unresolvedUsd = Math.min(totalUsd, Math.max(0, Number(vault.unresolved_exposure_usd) || 0));
  const knownUsd = totalUsd - unresolvedUsd;
  const unverifiedPercent = totalUsd > 0 ? Math.round((unresolvedUsd / totalUsd) * 10000) / 100 : 0;
  const pct = usd => (knownUsd > 0 ? Math.round((usd / knownUsd) * 10000) / 100 : 0);
  const round = usd => Math.round(usd * 100) / 100;

  const byToken = new Map();
  const tierUsd = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let unratedUsd = 0;
  let idleUsd = 0;
  let deployedUsd = 0;
  for (const alloc of allocations) {
    const usd = Math.max(0, Number(alloc.supply_assets_usd) || 0);
    if (usd <= 0) continue;
    if (isIdleReserveMarket(alloc)) { idleUsd += usd; continue; }
    const tier = researchTierOf(alloc, nowSec);
    const key = keyOf(alloc.chain_id, alloc.collateral_asset_address);
    const t = byToken.get(key) || {
      chainId: alloc.chain_id, address: String(alloc.collateral_asset_address || '').toLowerCase(),
      symbol: alloc.collateral_asset_symbol, tier, confidence: tier === null ? null : alloc.collateral_confidence ?? null,
      category: alloc.collateral_category ?? null, usd: 0
    };
    t.usd += usd;
    byToken.set(key, t);
    if (tier === null) unratedUsd += usd; else tierUsd[tier] += usd;
    deployedUsd += usd;
  }

  return {
    tier: knownUsd <= 0 ? 'UNKNOWN' : deployedUsd <= 0 ? 'UNALLOCATED' : 'CLASSIFIED',
    byRiskTier: Object.fromEntries(Object.entries(tierUsd).map(([k, usd]) => [k, pct(usd)])),
    lowRiskPercent: pct(tierUsd[1] + tierUsd[2]),
    highRiskPercent: pct(tierUsd[4] + tierUsd[5]),
    impairedPercent: pct(tierUsd[5]),
    unratedPercent: pct(unratedUsd),
    tokens: [...byToken.values()].sort((a, b) => b.usd - a.usd).map(t => ({ ...t, usd: round(t.usd), percent: pct(t.usd) })),
    idlePercent: pct(idleUsd),
    undeployedPercent: pct(Math.max(0, knownUsd - idleUsd - deployedUsd)),
    unverifiedPercent
  };
}
