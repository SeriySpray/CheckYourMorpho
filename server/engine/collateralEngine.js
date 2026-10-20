/**
 * Collateral tag model. A token is judged only by the tags Morpho gave it, and risk is set per tag in the open
 * TAG_RISK table (see the README). Tokens with an elevated tag are elevated; tokens with no tags, an unlisted tag or no
 * base tag stay unclassified; the rest are ordinary. There are no weights or thresholds, only shares.
 *
 * Shares are measured against the verified capital (TVL minus capital behind adapters that could not be expanded),
 * the same base the other engines use.
 */
import { isIdleReserveMarket } from './hhiEngine.js';

const keyOf = (chainId, address) => `${Number(chainId)}:${String(address || '').trim().toLowerCase()}`;

// --- Morpho-tag model: risk is set per tag in one open table, a token is judged only by the tags Morpho gave it. ---
export const COLLATERAL_MODEL = 'morpho-tags-1';
export const TAG_RISK = {
  btc: { risk: 'ordinary', note: 'BTC or a BTC wrapper' },
  eth: { risk: 'ordinary', note: 'ETH or an ETH wrapper' },
  stablecoin: { risk: 'ordinary', note: 'Stablecoin' },
  'usd-pegged': { risk: 'ordinary', note: 'Pegged to USD' },
  'eur-pegged': { risk: 'ordinary', note: 'Pegged to EUR' },
  EUR: { risk: 'ordinary', note: 'EUR base asset or peg' },
  'simple-permit': { risk: 'neutral', note: 'Gasless signature approvals' },
  permit: { risk: 'neutral', note: 'Gasless signature approvals' },
  erc4626: { risk: 'neutral', note: 'Vault share' },
  'vault-v1': { risk: 'neutral', note: 'Vault share' },
  'vault-v2': { risk: 'neutral', note: 'Vault share' },
  yield: { risk: 'neutral', note: 'Token pays yield, the source is not named' },
  lst: { risk: 'neutral', note: 'Liquid staking token' },
  lrt: { risk: 'neutral', note: 'Liquid restaking token' },
  rwa: { risk: 'elevated', note: 'Off-chain assets or claims' },
  stocks: { risk: 'elevated', note: 'Tokenized shares' },
  'governance-token': { risk: 'elevated', note: 'Price is not anchored to anything' }
};

/**
 * Risk state of one token from its Morpho tags.
 * @param {string[]|null} tags
 * @returns {{state:'ordinary'|'elevated'|'unclassified', reason:null|'untagged'|'no base tag'|string}} reason is 'unlisted:<tag>' for a tag outside TAG_RISK
 */
export function tokenState(tags) {
  if (!Array.isArray(tags) || !tags.length) return { state: 'unclassified', reason: 'untagged' };
  const risks = tags.map(t => TAG_RISK[t]?.risk);
  if (risks.includes('elevated')) return { state: 'elevated', reason: null };
  const unlisted = tags.find(t => !TAG_RISK[t]);
  if (unlisted !== undefined) return { state: 'unclassified', reason: `unlisted:${unlisted}` };
  if (!risks.includes('ordinary')) return { state: 'unclassified', reason: 'no base tag' };
  return { state: 'ordinary', reason: null };
}

/** The tag table as a markdown table, the single source for the README. */
export function tagRiskMarkdown() {
  const rows = Object.entries(TAG_RISK).map(([tag, v]) => `| \`${tag}\` | ${v.risk} | ${v.note} |`);
  return ['| Tag | Risk | Meaning |', '| --- | --- | --- |', ...rows].join('\n');
}

/** Tags from a token_tags JSON string; null when missing, 'null' or malformed. */
export function parseTagsJson(json) {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : null; } catch { return null; }
}

/**
 * Tag mix of a vault. Same percent base as the other engines (TVL minus unverified capital).
 * @param {object} vault Vault row (use the one from withMaterialUnresolved)
 * @param {Array<object>} allocations Allocations joined with markets and token_tags (collateral_tags_json)
 */
export function calculateTagMix(vault, allocations = []) {
  const totalUsd = Number(vault.total_assets_usd) || 0;
  const unresolvedUsd = Math.min(totalUsd, Math.max(0, Number(vault.unresolved_exposure_usd) || 0));
  const knownUsd = totalUsd - unresolvedUsd;
  const unverifiedPercent = totalUsd > 0 ? Math.round((unresolvedUsd / totalUsd) * 10000) / 100 : 0;
  const pct = usd => (knownUsd > 0 ? Math.round((usd / knownUsd) * 10000) / 100 : 0);
  const round = usd => Math.round(usd * 100) / 100;

  const byToken = new Map();
  const byTag = new Map();
  const byState = { ordinary: 0, elevated: 0, unclassified: 0 };
  let idleUsd = 0;
  let deployedUsd = 0;
  for (const alloc of allocations) {
    const usd = Math.max(0, Number(alloc.supply_assets_usd) || 0);
    if (usd <= 0) continue;
    if (isIdleReserveMarket(alloc)) { idleUsd += usd; continue; }
    const tags = parseTagsJson(alloc.collateral_tags_json);
    const { state, reason } = tokenState(tags);
    const key = keyOf(alloc.chain_id, alloc.collateral_asset_address);
    const t = byToken.get(key) || {
      chainId: alloc.chain_id, address: String(alloc.collateral_asset_address || '').toLowerCase(),
      symbol: alloc.collateral_asset_symbol, tags: tags || [], state, reason, usd: 0
    };
    t.usd += usd;
    byToken.set(key, t);
    byState[state] += usd;
    deployedUsd += usd;
    for (const tag of new Set(tags || [])) {
      const risk = TAG_RISK[tag]?.risk;
      if (risk && risk !== 'neutral') byTag.set(tag, (byTag.get(tag) || 0) + usd);
    }
  }

  return {
    tier: knownUsd <= 0 ? 'UNKNOWN' : deployedUsd <= 0 ? 'UNALLOCATED' : 'CLASSIFIED',
    ordinaryPercent: pct(byState.ordinary),
    elevatedPercent: pct(byState.elevated),
    unclassifiedPercent: pct(byState.unclassified),
    tags: [...byTag.entries()].sort((a, b) => b[1] - a[1]).map(([tag, usd]) => ({ tag, risk: TAG_RISK[tag].risk, usd: round(usd), percent: pct(usd) })),
    tokens: [...byToken.values()].sort((a, b) => b.usd - a.usd).map(t => ({ ...t, usd: round(t.usd), percent: pct(t.usd) })),
    idlePercent: pct(idleUsd),
    undeployedPercent: pct(Math.max(0, knownUsd - idleUsd - deployedUsd)),
    unverifiedPercent
  };
}
