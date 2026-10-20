/**
 * Collateral Class Mix Engine
 * Groups the capital a vault has lent out by the risk class of the collateral behind it (BTC, ETH, synthetic
 * dollars, off-chain credit funds, Pendle PT, volatile assets, unknown), instead of counting every token as its own
 * asset. Tokens that move together (wstETH, weETH, WETH) share one source of risk, so they share one class.
 *
 * Classes and their weights come from server/data/collateralClasses.json, one entry per (chainId, address).
 * Only that file can grant a low-weight class, so a token that copies a blue-chip symbol can never look safe.
 * A token that is not listed falls through the symbol rules in collateralRules.json, which may assign medium or
 * high weight only; anything unmatched is UNKNOWN, which counts as high weight.
 *
 * Shares are measured against the verified capital (TVL minus capital behind adapters that could not be
 * expanded), the same base the other engines use.
 * Flag: RED when 25% or more of it sits in high-weight classes; YELLOW when no RED and 50% or more sits in
 * medium- or high-weight classes.
 */
import fs from 'node:fs';
import { isIdleReserveMarket } from './hhiEngine.js';

const readJson = name => JSON.parse(fs.readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const DATA = readJson('collateralClasses.json');
const RULES = readJson('collateralRules.json').rules.map(r => ({ ...r, re: new RegExp(r.pattern, r.flags || '') }));

export const COLLATERAL_CLASSES = DATA.classes;
export const RED_HIGH_SHARE_PERCENT = 25;
export const YELLOW_MEDIUM_PLUS_SHARE_PERCENT = 50;

const RANK = { low: 0, medium: 1, high: 2 };
const keyOf = (chainId, address) => `${Number(chainId)}:${String(address || '').trim().toLowerCase()}`;
const BY_ADDRESS = new Map(DATA.entries.map(e => [keyOf(e.chainId, e.address), e]));
// Same-chain symbol index, used only to find what a PT is a bond on
const BY_SYMBOL = new Map(DATA.entries.map(e => [`${e.chainId}:${e.symbol.toLowerCase()}`, e]));

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

export function parseMaturity(text) {
  let m = /^(\d{1,2})([A-Z]{3})(\d{4})$/.exec(text || '');
  if (m && m[2] in MONTHS) return new Date(Date.UTC(+m[3], MONTHS[m[2]], +m[1]));
  m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(text || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}

export function classOf(name) {
  return COLLATERAL_CLASSES[name] ? name : 'UNKNOWN';
}

export function describe(cls, extra = {}) {
  const name = classOf(cls);
  const weight = COLLATERAL_CLASSES[name].weight;
  return { class: name, weight, effectiveWeight: weight, ...extra };
}

/** A bond token is as risky as the asset it is a bond on, and never below its own class. */
export function ptDescription(underlyingClass, maturity, now) {
  const base = COLLATERAL_CLASSES.PT.weight;
  const underlying = classOf(underlyingClass);
  const uWeight = COLLATERAL_CLASSES[underlying].weight;
  return {
    class: 'PT', weight: base, effectiveWeight: RANK[uWeight] > RANK[base] ? uWeight : base,
    underlyingClass: underlying, matured: maturity ? maturity < now : null
  };
}

/**
 * Class of one collateral asset.
 * @param {{chainId:number, address:string, symbol:string}} token
 * @param {Date} [now] only for the matured flag of PT tokens
 * @returns {{class:string, weight:string, effectiveWeight:string, source:'address'|'rule', underlyingClass?:string, matured?:boolean|null}}
 */
export function classifyCollateral(token, now = new Date()) {
  const entry = BY_ADDRESS.get(keyOf(token.chainId, token.address));
  if (entry) {
    if (entry.class === 'PT') return { ...ptDescription(entry.underlyingClass, entry.maturity ? new Date(entry.maturity) : null, now), source: 'address' };
    return { ...describe(entry.class), source: 'address' };
  }

  const symbol = String(token.symbol || '').trim();
  for (const rule of RULES) {
    const m = rule.re.exec(symbol);
    if (!m) continue;
    if (rule.class === 'PT') {
      const underlying = (m[rule.underlyingGroup] || '').replace(/\(.*\)$/, '');
      const hit = BY_SYMBOL.get(`${Number(token.chainId)}:${underlying.toLowerCase()}`);
      const underlyingClass = hit ? hit.class : classifyCollateral({ chainId: token.chainId, address: '', symbol: underlying }, now).class;
      return { ...ptDescription(underlyingClass, parseMaturity(m[rule.maturityGroup]), now), source: 'rule' };
    }
    // a rule can only produce medium or high weight, whatever the file says
    const found = describe(rule.class);
    return { ...(found.weight === 'low' ? describe('UNKNOWN') : found), source: 'rule' };
  }
  return { ...describe('UNKNOWN'), source: 'none' };
}

/**
 * Class mix of a vault.
 * @param {object} vault Vault row (call with the vault from withMaterialUnresolved so dust is not counted as unverified)
 * @param {Array<object>} allocations Allocations joined with markets
 */
export function calculateCollateralMix(vault, allocations = []) {
  const totalUsd = Number(vault.total_assets_usd) || 0;
  const unresolvedUsd = Math.min(totalUsd, Math.max(0, Number(vault.unresolved_exposure_usd) || 0));
  const knownUsd = totalUsd - unresolvedUsd;
  const unverifiedPercent = totalUsd > 0 ? Math.round((unresolvedUsd / totalUsd) * 10000) / 100 : 0;
  const pct = usd => (knownUsd > 0 ? Math.round((usd / knownUsd) * 10000) / 100 : 0);

  const byClass = new Map();
  let idleUsd = 0;
  let deployedUsd = 0;
  let highUsd = 0;
  let mediumPlusUsd = 0;
  let maturedPtUsd = 0;
  for (const alloc of allocations) {
    const usd = Math.max(0, Number(alloc.supply_assets_usd) || 0);
    if (usd <= 0) continue;
    if (isIdleReserveMarket(alloc)) { idleUsd += usd; continue; }
    const c = classifyCollateral({ chainId: alloc.chain_id, address: alloc.collateral_asset_address, symbol: alloc.collateral_asset_symbol });
    byClass.set(c.class, (byClass.get(c.class) || 0) + usd);
    deployedUsd += usd;
    if (c.effectiveWeight === 'high') highUsd += usd;
    if (c.effectiveWeight !== 'low') mediumPlusUsd += usd;
    if (c.matured) maturedPtUsd += usd;
  }

  const classes = [...byClass.entries()].sort((a, b) => b[1] - a[1]).map(([name, usd]) => ({
    class: name, label: COLLATERAL_CLASSES[name].label, weight: COLLATERAL_CLASSES[name].weight,
    usd: Math.round(usd * 100) / 100, percent: pct(usd)
  }));
  const highPercent = pct(highUsd);
  const mediumPlusPercent = pct(mediumPlusUsd);

  let level = null;
  if (knownUsd > 0) {
    if (highPercent >= RED_HIGH_SHARE_PERCENT) level = 'RED';
    else if (mediumPlusPercent >= YELLOW_MEDIUM_PLUS_SHARE_PERCENT) level = 'YELLOW';
  }
  const tier = knownUsd <= 0 ? 'UNKNOWN' : deployedUsd <= 0 ? 'UNALLOCATED' : 'CLASSIFIED';

  return {
    tier,
    level,
    classes,
    topClass: classes[0]?.class ?? null,
    highPercent,
    mediumPlusPercent,
    unknownPercent: pct(byClass.get('UNKNOWN') || 0),
    idlePercent: pct(idleUsd),
    undeployedPercent: pct(Math.max(0, knownUsd - idleUsd - deployedUsd)),
    maturedPtPercent: pct(maturedPtUsd),
    unverifiedPercent
  };
}

/**
 * Collateral assets in UNKNOWN that hold at least minUsd of vault capital, largest first.
 * @param {Array<{chain_id:number, collateral_asset_address:string, collateral_asset_symbol:string, supply_assets_usd:number}>} rows
 */
export function findUnknownCollateral(rows, minUsd = 1e6) {
  const found = new Map();
  for (const row of rows) {
    const usd = Math.max(0, Number(row.supply_assets_usd) || 0);
    if (usd <= 0 || isIdleReserveMarket(row)) continue;
    if (classifyCollateral({ chainId: row.chain_id, address: row.collateral_asset_address, symbol: row.collateral_asset_symbol }).class !== 'UNKNOWN') continue;
    const key = keyOf(row.chain_id, row.collateral_asset_address);
    const item = found.get(key) || { chainId: row.chain_id, address: String(row.collateral_asset_address || '').toLowerCase(), symbol: row.collateral_asset_symbol, usd: 0 };
    item.usd += usd;
    found.set(key, item);
  }
  return [...found.values()].filter(i => i.usd >= minUsd).sort((a, b) => b.usd - a.usd);
}

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

const parseTags = json => { try { const v = JSON.parse(json); return Array.isArray(v) ? v : null; } catch { return null; } };

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
    const tags = parseTags(alloc.collateral_tags_json);
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
