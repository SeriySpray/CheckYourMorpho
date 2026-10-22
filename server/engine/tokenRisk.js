/**
 * Risk rating of a collateral token from the facts the collector stored (token_data). Pure: no database, no network, no clock
 * (the reference time is the record's own meta.collected_at). The collector never judges; this engine does, with fixed rules.
 *
 * Every rule (FLAG_RULES) reads named paths of the record and returns one state:
 *   flag    the fact is present and costs `points`
 *   clear   the fact was checked and is fine
 *   unknown an input was null: costs a share of the rule's maximum (RISK.unknownShare), never counts as fine
 *   na      the rule does not apply to this kind of token
 * score = 100 - sum over the stability pillars of (pillar weight * points of that pillar), cut to 0..100. Higher is steadier.
 * control_score is the same kind of number for the control and transparency pillars and is shown next to the score, not ranked by.
 * A record with too little data or no price is not rated (stability `insufficient_data`) and goes after the rated ones.
 * The result is shown as a neutral stability level (high, medium, low), never as a safety grade: it says how steady the price and the exit look, not that the token is safe.
 *
 * Old records (collected before the impact, holder and PT fixes) are read through the primitives: the swap impact is computed
 * from out_usd and the requested size, the PT expiry from the contract values, the own-holder shares from the top list.
 */
import { parsePtExpiry, parseSharePrice, PROTOCOL_NAME_RE, MORPHO_BLUE } from '../services/tokenParsers.js';
import { CHAINS } from '../services/tokenCollector.js';

export const RISK_MODEL = 'token-risk-4';

/** Levels shown to people; `insufficient_data` is a record that cannot be rated. */
export const STABILITY_LEVELS = ['high', 'medium', 'low', 'insufficient_data'];
export const STABILITY_LABELS = {
  high: 'Stability: high', medium: 'Stability: medium', low: 'Stability: low', insufficient_data: 'Stability: insufficient data'
};

// Calibration: every threshold and weight lives here. The rank is about STABILITY only: how well the token holds its price, how
// deep its exit is, how spread its holders are and how big and old the market is. Who controls the contract (control, transparency)
// is a separate metric (control_score) and does not move the rank. Reviewed token by token on 336 real records (October 2026).
// After a change rerun `node scripts/token-ranking.mjs --file <batch.jsonl>` and the golden tests (tests/data/risk).
// token-risk-3 (second review of the same 336 records, top 100 and the grade edges token by token):
//  - exits, pool depth, volume, market cap and Pendle liquidity are curves, not steps (MORPHO lost 0 at 0.9% and 18 at 3.6%);
//  - market cap reaches 16 under $1M (a $1.9M tokenized S&P 500 was an A above WETH) and still grades $1B against $10B;
//  - pool depth grades up to $100M and the $1M exit up to 18 (a 70% loss cost the same 12 as 25%);
//  - a live PT has no measured volume (its Pendle AMM is not in the pool index): volume is na and the Pendle curve is stricter;
//  - the 30-day range is no longer rounded to 0 under 0.6% (it breaks the tie of the three 100s) and caps at 45, not 35;
//  - unknown holder shares are bounded by the known top-10 share and cost 0.2 of the maximum (L2 explorers give no list);
//  - an old record's own top-10 leaves out the pools and protocols of its top list (USDe paid for sUSDe holding its supply);
//  - Morpho Blue concentration costs up to 25 (kBTC at 86%, USDe on Base at 99.6%).
const RISK = {
  pillars: { liquidity: 1.0, price: 1.0, holders: 0.6, scale: 0.6, control: 0, transparency: 0 }, // weight 0: scored, but not part of the rank
  controlWeights: { control: 1.0, transparency: 0.6 },
  unknownShare: 0.35,
  // An exit or a price history nobody could measure is closer to a bad one than to a good one (a missing 30-day range must cost
  // more than a normal ETH swing). A missing holder list is common on L2 explorers (WBTC and WETH on Arbitrum and Base): it lowers
  // the confidence and costs a little, it is not a fault of the market
  unknownShareByPillar: { liquidity: 0.6, price: 0.5, holders: 0.2 },
  levels: [['high', 70], ['medium', 40]], // below the last one: low
  minCoverage: 0.4,
  confidence: { high: { coverage: 0.75, unknown: 0.15 }, medium: { coverage: 0.5, unknown: 0.35 } },
  // Curves: [x, points] knots, linear between them (log10 x for dollar amounts), so one cent more never jumps a grade
  exit100k: [[0.3, 0], [1, 6], [3, 16], [10, 30]], // price impact % of a $100K sale -> points
  exit1m: [[1, 0], [3, 2], [8, 6], [25, 12], [60, 18]], // and of a $1M sale
  noRoute100k: 30, noRoute1m: 18,
  // Live PT: Pendle market liquidity $ -> points. Its one AMM is the whole exit (no other pools, no measured volume), so it carries
  // what exit_1m, dex_depth and volume_24h carry for other tokens
  ptLiquidityUsd: [[1e6, 24], [5e6, 12], [2e7, 6], [1e8, 0]],
  dexReserveUsd: [[1e5, 10], [1e6, 6], [1e7, 2.5], [1e8, 0]], // DEX pool reserves $ -> points: $100M of pools is deep, $2M is thin for a $100M token
  holdersCount: [[100, 'high', 8], [1000, 'medium', 4]],
  top1Pct: [[50, 'high', 10], [25, 'medium', 5]],
  top10Pct: [[90, 'medium', 5], [75, 'info', 2]],
  morphoPct: [[75, 'high', 25], [50, 'high', 15], [25, 'medium', 6]],
  minPriceConfidence: 0.9,
  priceAgeSec: [[3 * 86400, 'high', 12], [86400, 'medium', 5]],
  navGapPct: [[5, 'high', 10], [1.5, 'medium', 4]],
  sharePriceGapPct: [[5, 'high', 6], [1.5, 'medium', 3]],
  ptSoonDays: 14,
  ageDays: [[30, 'high', 8], [180, 'medium', 4], [365, 'info', 1]],
  marketCapUsd: [[1e6, 16], [1e7, 10], [1e8, 5], [1e9, 2], [1e10, 0]],
  volume24hUsd: [[1e3, 20], [1e4, 8], [1e5, 2], [1e6, 0]], // a market with no trades has no price discovery, whatever an aggregator quotes
  timelockMinDelaySec: 86400,
  ptMaturedPoints: 35, // a matured PT is redeemed 1:1 but its market is closed and its price stops being discovered
  lowConfidenceMaxScore: 69.9, // a record with many unknowns cannot be level high
  volatilityPerPct: 0.8, volatilityExtraPerPct: 0.6, volatilityExtraFromPct: 20, volatilityMaxPoints: 45, // points per percent of the 30-day price range (a peg at 0.1% costs 0.08, ETH at 16% costs 13), steeper above 20%; a 40% month costs 44 (it was capped at 35, which left 44% movers at C)
  ptSingleVenuePoints: 4 // a live PT trades on one Pendle pool only
};

const LEVEL_ORDER = { critical: 4, high: 3, medium: 2, info: 1 };
const CONF_ORDER = { high: 3, medium: 2, low: 1 };
const ZERO = '0x0000000000000000000000000000000000000000';
const TIMELOCK_RE = /timelock/i;

const at = (obj, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const fmtUsd = v => (v >= 1e9 ? `$${round(v / 1e9, 1)}B` : v >= 1e6 ? `$${round(v / 1e6, 1)}M` : v >= 1e3 ? `$${round(v / 1e3, 1)}K` : `$${round(v, 0)}`);

/** First band whose bound the value reaches (`desc`: value >= bound is bad) or stays under (`asc`: value < bound is bad). */
function band(value, bands, dir = 'desc') {
  for (const [bound, level, points] of bands) if (dir === 'desc' ? value >= bound : value < bound) return { level, points };
  return null;
}

/** Points on a curve of [x, points] knots (x ascending), linear between them (in log10 x when `log`), flat beyond the ends. */
function curve(value, knots, log = false) {
  const t = v => (log ? Math.log10(Math.max(v, 1e-9)) : v);
  if (value <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [x0, p0] = knots[i - 1], [x1, p1] = knots[i];
    if (value <= x1) return round(p0 + ((p1 - p0) * (t(value) - t(x0))) / (t(x1) - t(x0)), 2);
  }
  return knots.at(-1)[1];
}
const levelOf = (points, max, top = 'high') => (points >= max ? top : points >= max * 0.5 ? 'high' : points >= max * 0.2 ? 'medium' : 'info');

// --- Derived facts (from primitives, so old records read the same way as new ones) --------------------------------

const isPt = d => Boolean(d.pendle) || at(d, 'identity.contract_name') === 'PendlePrincipalToken';

function ptExpired(d, refSec) {
  if (!isPt(d)) return null;
  if (typeof d.pendle?.expired === 'boolean') return d.pendle.expired;
  return parsePtExpiry(d.pendle, at(d, 'control.read_values'), (refSec ?? 0) * 1000).expired;
}

/** Swap quote of one size: impact from what came out against what was asked (old records stored a wrong impact). */
function kyberQuote(d, size, x = {}) {
  // The chain's USDC is the quote asset: selling it for itself means nothing (older records hold a 400 error there)
  if (x.isQuoteAsset) return { status: 'na', impact: null, path: `liquidity.kyber.${size}` };
  const q = at(d, `liquidity.kyber.${size}`);
  if (!q || typeof q !== 'object') return { status: null, impact: null, path: `liquidity.kyber.${size}` };
  const out = n(q.out_usd);
  const impact = q.status === 'ok' && out !== null ? Math.max(0, round((1 - out / size) * 100, 3)) : null;
  return { status: q.status ?? null, impact, out, reason: q.reason ?? null, path: `liquidity.kyber.${size}` };
}

/** Own-holder shares: the stored ones, else recomputed from the top list (Morpho Blue and named pools left out). */
function ownHolders(d) {
  const h = d.holders ?? {};
  if (h.top1_nonprotocol_pct !== undefined && h.top1_nonprotocol_pct !== null) return { top1: n(h.top1_nonprotocol_pct), top10: n(h.top10_nonprotocol_pct), path: 'holders.top1_nonprotocol_pct' };
  const rows = Array.isArray(h.top) ? h.top.filter(r => n(r?.pct) !== null) : [];
  const own = rows.filter(r => r.address !== MORPHO_BLUE && !(r.is_contract && PROTOCOL_NAME_RE.test(r.name ?? '')));
  // Own top-10 of an old record (it stored only the top 5 and the all-holder top-10): the top-10 share less the pools and protocols
  // seen in the list, plus what own holders below the tenth place could add in their seats (each holds no more than the tenth)
  const all = n(h.top10_pct) ?? n(h.gecko_top10_pct);
  let top10 = null;
  if (all !== null && all <= 100 && rows.length && rows.length < 10) {
    const sum = list => list.reduce((s, r) => s + n(r.pct), 0);
    const tenth = Math.min(...rows.map(r => n(r.pct)), Math.max(0, all - sum(rows)) / (10 - rows.length));
    const gecko = n(h.gecko_top10_pct) <= 100 ? n(h.gecko_top10_pct) : 100; // the other source of the all-holder top-10 caps it too
    top10 = round(Math.min(all, gecko, Math.max(sum(own), all - (sum(rows) - sum(own)) + (rows.length - own.length) * tenth)), 3);
  }
  return { top1: own.length ? n(own[0].pct) : null, top10, path: 'holders.top' };
}

function marketCap(d) {
  const mc = n(at(d, 'price.market_cap_usd'));
  if (mc > 0) return { value: mc, path: 'price.market_cap_usd' }; // Blockscout writes 0 when it has no market data
  const supply = at(d, 'identity.total_supply'), dec = n(at(d, 'identity.decimals')), usd = n(at(d, 'price.usd'));
  if (typeof supply !== 'string' || !/^\d+$/.test(supply) || dec === null || usd === null) return { value: null, path: 'price.market_cap_usd' };
  return { value: (Number(supply) / 10 ** dec) * usd, path: 'identity.total_supply*price.usd' };
}

const isUpgradeable = d => {
  const fn = at(d, 'contract.fn') ?? {};
  if (fn.upgrade === true || fn.upgrade_via_proxy === true || at(d, 'contract.is_proxy') === true) return true;
  if (fn.upgrade === false && (fn.upgrade_via_proxy === false || at(d, 'contract.is_proxy') === false)) return false;
  return null;
};
const controllers = d => (Array.isArray(at(d, 'control.controllers')) ? d.control.controllers : []);
const ctlNames = c => [c?.name, ...(Array.isArray(c?.implementation_names) ? c.implementation_names : [])].filter(Boolean).join(' ');
const isEoaLike = c => c?.is_contract === false || c?.is_eoa_delegated === true || /7702|delegator/i.test(ctlNames(c));
const isMultisig = c => Boolean(c?.safe) || c?.is_multisig === true || /multisig|gnosis|\bsafe/i.test(ctlNames(c));
const isTimelock = c => TIMELOCK_RE.test(ctlNames(c));

/** Whether the token has privileged roles at all: true, false (none in the ABI and nothing to upgrade) or null (no ABI). */
function hasPrivilege(d) {
  const fn = at(d, 'contract.fn') ?? {};
  const keys = ['owner', 'roles', 'mint', 'pause', 'blacklist', 'freeze'];
  if (keys.some(k => fn[k] === true) || isUpgradeable(d) === true) return true;
  if (keys.every(k => fn[k] === false) && isUpgradeable(d) === false) return false;
  return null;
}
const renounced = d => String(at(d, 'control.read_values.owner') ?? '').toLowerCase() === ZERO;

/** Address of the vault asset an ERC-4626 token holds (lower case), or null. */
export function assetAddressOf(record) {
  const a = at(record, 'data.control.read_values.asset');
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
}

// --- Rules ----------------------------------------------------------------------------------------------------------

const ev = (d, ...paths) => paths.map(p => ({ path: p, value: at(d, p) ?? null }));
const R = (state, message, evidence, level = null, points = 0) => ({ state, message, evidence, level, points });
const unknown = (message, evidence) => R('unknown', message, evidence);
const na = (message, evidence = []) => R('na', message, evidence);

/**
 * An unknown holder share that the known top-10 share bounds: neither the largest own holder nor Morpho Blue can hold more than
 * the ten largest holders together, so the unknown costs a share of the worst band still reachable, not of the rule's maximum.
 */
function unknownUnder(message, evidence, d, bands) {
  const g = n(at(d, 'holders.gecko_top10_pct'));
  const [ceil, path] = g !== null && g <= 100 ? [g, 'holders.gecko_top10_pct'] : [n(at(d, 'holders.top10_pct')), 'holders.top10_pct'];
  if (ceil === null) return unknown(message, evidence);
  const worst = band(ceil, bands);
  if (!worst) return R('clear', `${message}, but at most ${ceil}% (the top-10 share)`, [...evidence, ...ev(d, path)]);
  return { ...unknown(`${message} (at most ${ceil}%, the top-10 share)`, [...evidence, ...ev(d, path)]), max: worst.points };
}

function fnRule(id, keys, level, points, label) {
  return {
    id, pillar: 'control', max: points,
    evaluate(d) {
      const e = ev(d, ...keys.map(k => `contract.fn.${k}`));
      const vals = keys.map(k => at(d, `contract.fn.${k}`));
      if (vals.some(v => v === true)) return R('flag', `The contract has ${label} functions`, e, level, points);
      if (vals.every(v => v === false)) return R('clear', `No ${label} functions in the ABI`, e);
      return unknown(`No ABI: ${label} functions unknown`, e);
    }
  };
}

export const FLAG_RULES = [
  fnRule('fn_blacklist', ['blacklist', 'freeze'], 'medium', 4, 'blacklist or freeze'),
  fnRule('fn_pause', ['pause'], 'info', 2, 'pause'),
  fnRule('fn_mint', ['mint'], 'medium', 3, 'privileged mint'),
  {
    id: 'upgradeable', pillar: 'control', max: 6,
    evaluate(d) {
      const e = ev(d, 'contract.fn.upgrade', 'contract.fn.upgrade_via_proxy', 'contract.is_proxy', 'contract.proxy_type');
      const u = isUpgradeable(d);
      if (u === true) return R('flag', 'The code can be replaced (upgrade function or proxy)', e, 'medium', 6);
      if (u === false) return R('clear', 'Not a proxy and no upgrade function', e);
      return unknown('Unknown whether the code can be replaced', e);
    }
  },
  {
    id: 'controller_eoa', pillar: 'control', max: 24,
    evaluate(d) {
      const ctl = controllers(d);
      const eoa = ctl.filter(isEoaLike);
      const e = ctl.length ? ctl.slice(0, 5).flatMap((c, i) => ev(d, `control.controllers.${i}.role`, `control.controllers.${i}.is_contract`)) : ev(d, 'control.controllers', 'contract.fn.owner', 'contract.fn.roles');
      if (eoa.length) {
        const up = isUpgradeable(d) === true;
        const delegated = eoa.some(c => c.is_eoa_delegated || /7702|delegator/i.test(ctlNames(c)));
        return R('flag', `A single key (${delegated ? 'EIP-7702 delegated EOA' : 'EOA'}) holds ${eoa.map(c => c.role).join(', ')}${up ? ' of an upgradeable token' : ''}`, e,
          up ? 'critical' : 'high', up ? 24 : 18);
      }
      if (ctl.length) return R('clear', 'Every controller found is a contract', e);
      if (renounced(d)) return R('clear', 'Ownership renounced (owner is the zero address)', ev(d, 'control.read_values.owner'));
      const p = hasPrivilege(d);
      if (p === false) return na('No privileged roles to hold', e);
      return unknown(p ? 'The token has privileged roles but their holders were not found' : 'No ABI and no controllers: control unknown', e);
    }
  },
  {
    id: 'controller_safe_threshold', pillar: 'control', max: 12,
    evaluate(d) {
      const ms = controllers(d).map((c, i) => ({ c, i })).filter(({ c }) => isMultisig(c));
      if (!ms.length) return na('No multisig among the controllers');
      const e = ms.flatMap(({ i }) => ev(d, `control.controllers.${i}.safe`, `control.controllers.${i}.name`));
      const known = ms.filter(({ c }) => c.safe && n(c.safe.threshold) !== null);
      if (!known.length) return unknown('A multisig controls the token but its threshold is unknown', e);
      const min = Math.min(...known.map(({ c }) => n(c.safe.threshold)));
      const of = known.find(({ c }) => n(c.safe.threshold) === min).c.safe.owner_count;
      if (min <= 1) return R('flag', `Safe with threshold ${min}/${of}: one signer is enough`, e, 'high', 12);
      if (min === 2) return R('flag', `Safe with a low threshold ${min}/${of}`, e, 'medium', 4);
      return R('clear', `Safe threshold ${min}/${of}`, e);
    }
  },
  {
    id: 'controller_timelock', pillar: 'control', max: 5,
    evaluate(d) {
      const ctl = controllers(d);
      const tl = ctl.map((c, i) => ({ c, i })).filter(({ c }) => isTimelock(c));
      if (tl.length) {
        const e = tl.flatMap(({ i }) => ev(d, `control.controllers.${i}.name`, `control.controllers.${i}.timelock_delay_sec`));
        const delays = tl.map(({ c }) => n(c.timelock_delay_sec)).filter(v => v !== null);
        if (!delays.length) return unknown('Timelock found, its delay unknown', e);
        const min = Math.min(...delays);
        if (min < RISK.timelockMinDelaySec) return R('flag', `Timelock delay only ${round(min / 3600, 1)} h`, e, 'medium', 5);
        return R('clear', `Timelock with a ${round(min / 3600, 1)} h delay`, e);
      }
      if (!ctl.length) return na('No controllers to put behind a timelock');
      return R('flag', 'No timelock between the controllers and the token', ev(d, 'control.controllers'), 'info', 3);
    }
  },
  {
    id: 'controller_unrecognized', pillar: 'control', max: 3,
    evaluate(d) {
      const ctl = controllers(d);
      if (!ctl.length) return na('No controllers');
      const odd = ctl.map((c, i) => ({ c, i })).filter(({ c }) => c.is_contract === true && !isEoaLike(c) && !isMultisig(c) && !isTimelock(c));
      if (!odd.length) return R('clear', 'Every controller is a multisig, a timelock or an EOA', []);
      return R('flag', `Controlled by a contract of unchecked kind: ${odd.map(({ c }) => c.name ?? 'unnamed').join(', ')}`,
        odd.flatMap(({ i }) => ev(d, `control.controllers.${i}.name`, `control.controllers.${i}.role`)), 'info', 3);
    }
  },
  {
    id: 'exit_100k', pillar: 'liquidity', max: RISK.noRoute100k,
    evaluate(d, x) {
      if (x.ptExpired === true) return na('Matured PT: redeemed 1:1 through Pendle, swap liquidity ignored', ev(d, 'pendle.expired', 'pendle.expiry'));
      if (isPt(d)) {
        const liq = n(at(d, 'pendle.liquidity_usd'));
        const e = ev(d, 'pendle.liquidity_usd', 'pendle.active');
        if (liq === null) return unknown('Live PT without Pendle market liquidity', e);
        const p = curve(liq, RISK.ptLiquidityUsd, true);
        return p > 0 ? R('flag', `Pendle market liquidity ${fmtUsd(liq)} (deep from $100M)`, e, levelOf(p, RISK.noRoute100k, 'critical'), p) : R('clear', `Pendle market liquidity ${fmtUsd(liq)}`, e);
      }
      const q = kyberQuote(d, 100000, x);
      const e = ev(d, `${q.path}.status`, `${q.path}.out_usd`, `${q.path}.reason`);
      if (q.status === 'na') return na('The token is the quote asset of the swap', e);
      if (q.status === 'no_route') return R('flag', `No swap route for $100K${q.reason ? ` (${q.reason})` : ''}`, e, 'critical', RISK.noRoute100k);
      if (q.impact === null) return unknown('No $100K swap quote', e);
      const p = curve(q.impact, RISK.exit100k);
      return p > 0 ? R('flag', `Selling $100K loses ${q.impact}%`, e, levelOf(p, RISK.noRoute100k, 'critical'), p) : R('clear', `Selling $100K loses ${q.impact}%`, e);
    }
  },
  {
    id: 'exit_1m', pillar: 'liquidity', max: RISK.noRoute1m,
    evaluate(d, x) {
      if (x.ptExpired === true) return na('Matured PT: swap liquidity ignored');
      if (isPt(d)) return na('Live PT: judged by Pendle market liquidity (exit_100k)');
      const q = kyberQuote(d, 1000000, x);
      const e = ev(d, `${q.path}.status`, `${q.path}.out_usd`, `${q.path}.reason`);
      if (q.status === 'na') return na('The token is the quote asset of the swap', e);
      if (q.status === 'no_route') return R('flag', `No swap route for $1M${q.reason ? ` (${q.reason})` : ''}`, e, 'high', RISK.noRoute1m);
      if (q.impact === null) return unknown('No $1M swap quote', e);
      const p = curve(q.impact, RISK.exit1m);
      return p > 0 ? R('flag', `Selling $1M loses ${q.impact}%`, e, levelOf(p, RISK.noRoute1m), p) : R('clear', `Selling $1M loses ${q.impact}%`, e);
    }
  },
  {
    id: 'dex_depth', pillar: 'liquidity', max: RISK.dexReserveUsd[0][1],
    evaluate(d, x) {
      if (x.ptExpired === true) return na('Matured PT: pools ignored');
      if (isPt(d)) return na('Live PT: judged by Pendle market liquidity (exit_100k)');
      const v = n(at(d, 'liquidity.total_reserve_usd'));
      const e = ev(d, 'liquidity.total_reserve_usd', 'liquidity.pools_count');
      if (v === null) return unknown('DEX pool reserves unknown', e);
      // A vault share or wrapper may be sold through its own contract (a cheap aggregator quote), but that exit is the redemption of
      // the underlying asset, not a market: thin pools stay flagged
      const p = curve(v, RISK.dexReserveUsd, true);
      return p > 0 ? R('flag', `DEX pools hold ${fmtUsd(v)} (deep from $100M)`, e, levelOf(p, RISK.dexReserveUsd[0][1]), p) : R('clear', `DEX pools hold ${fmtUsd(v)}`, e);
    }
  },
  {
    id: 'pt_single_venue', pillar: 'liquidity', max: RISK.ptSingleVenuePoints,
    evaluate(d, x) {
      if (!isPt(d) || x.ptExpired === true) return na('Not a live PT');
      return R('flag', 'A live PT trades on one Pendle pool: its price and exit depend on that pool', ev(d, 'pendle.liquidity_usd', 'pendle.active'), 'info', RISK.ptSingleVenuePoints);
    }
  },
  {
    id: 'volume_24h', pillar: 'liquidity', max: RISK.volume24hUsd[0][1],
    evaluate(d, x) {
      if (x.ptExpired === true) return na('Matured PT: volume ignored');
      // A PT trades in its Pendle AMM, which the pool index does not cover: its "0" is unmeasured, not a dead market
      if (isPt(d)) return na('Live PT: judged by Pendle market liquidity (exit_100k)');
      const own = n(at(d, 'price.volume_24h_usd'));
      const pools = n(at(d, 'liquidity.total_volume_24h_usd'));
      // Blockscout's 0 usually means "no market data": take the larger of the two sources
      const v = own === null && pools === null ? null : Math.max(own ?? 0, pools ?? 0);
      const e = ev(d, 'price.volume_24h_usd', 'liquidity.total_volume_24h_usd');
      if (v === null) return unknown('24 h volume unknown', e);
      const p = curve(v, RISK.volume24hUsd, true);
      return p > 0 ? R('flag', `24 h volume ${fmtUsd(v)}`, e, levelOf(p, RISK.volume24hUsd[0][1], 'critical'), p) : R('clear', `24 h volume ${fmtUsd(v)}`, e);
    }
  },
  {
    id: 'holders_count', pillar: 'holders', max: 8,
    evaluate(d) {
      const c = n(at(d, 'holders.count')) ?? n(at(d, 'holders.gecko_count'));
      const e = ev(d, 'holders.count', 'holders.gecko_count');
      if (c === null) return unknown('Holder count unknown', e);
      const b = band(c, RISK.holdersCount, 'asc');
      return b ? R('flag', `Only ${c} holders`, e, b.level, b.points) : R('clear', `${c} holders`, e);
    }
  },
  {
    id: 'holder_top1', pillar: 'holders', max: 10,
    evaluate(d) {
      const o = ownHolders(d);
      const e = ev(d, o.path);
      if (o.top1 === null) return unknownUnder('Largest own holder unknown', e, d, RISK.top1Pct);
      const b = band(o.top1, RISK.top1Pct);
      return b ? R('flag', `One holder (not a pool or protocol) has ${o.top1}%`, e, b.level, b.points) : R('clear', `Largest own holder ${o.top1}%`, e);
    }
  },
  {
    id: 'holder_top10', pillar: 'holders', max: 5,
    evaluate(d) {
      const o = ownHolders(d);
      const g = n(at(d, 'holders.gecko_top10_pct'));
      const derived = o.top10 !== null && o.path === 'holders.top';
      const [v, path] = o.top10 !== null ? [o.top10, derived ? 'holders.top' : 'holders.top10_nonprotocol_pct'] : g !== null && g <= 100 ? [g, 'holders.gecko_top10_pct'] : [n(at(d, 'holders.top10_pct')), 'holders.top10_pct'];
      const e = derived ? ev(d, 'holders.top10_pct', 'holders.gecko_top10_pct', 'holders.top') : ev(d, path);
      if (v === null) return unknown('Top-10 share unknown', e);
      const what = derived ? `Top 10 own holders (pools and protocols left out) have at most ${v}%` : `Top 10 holders have ${v}%`;
      const b = band(v, RISK.top10Pct);
      return b ? R('flag', what, e, b.level, b.points) : R('clear', what, e);
    }
  },
  {
    id: 'morpho_dependency', pillar: 'holders', max: 25,
    evaluate(d) {
      const v = n(at(d, 'holders.morpho_blue_pct'));
      const e = ev(d, 'holders.morpho_blue_pct');
      if (v === null) return unknownUnder('Share held in Morpho Blue unknown', e, d, RISK.morphoPct);
      const b = band(v, RISK.morphoPct);
      return b ? R('flag', `${v}% of the supply sits in Morpho Blue: liquidations need buyers outside it`, e, b.level, b.points) : R('clear', `${v}% of the supply in Morpho Blue`, e);
    }
  },
  {
    id: 'price_confidence', pillar: 'price', max: 5,
    evaluate(d) {
      const v = n(at(d, 'price.confidence'));
      const e = ev(d, 'price.confidence');
      if (v === null) return unknown('Price confidence unknown', e);
      return v < RISK.minPriceConfidence ? R('flag', `DefiLlama price confidence ${v}`, e, 'medium', 5) : R('clear', `Price confidence ${v}`, e);
    }
  },
  {
    id: 'price_stale', pillar: 'price', max: 12,
    evaluate(d, x) {
      const ts = n(at(d, 'price.price_ts'));
      const e = ev(d, 'price.price_ts', 'meta.collected_at');
      if (ts === null || x.refSec === null) return unknown('Price time unknown', e);
      const age = x.refSec - ts;
      const b = band(age, RISK.priceAgeSec);
      return b ? R('flag', `Price not updated for ${round(age / 86400, 1)} days`, e, b.level, b.points) : R('clear', 'Fresh price', e);
    }
  },
  {
    id: 'volatility_30d', pillar: 'price', max: RISK.volatilityMaxPoints,
    evaluate(d) {
      const v = n(at(d, 'price.chart.range_pct'));
      const e = ev(d, 'price.chart.range_pct', 'price.chart.count');
      if (v === null) return unknown('No 30-day price history', e);
      const points = Math.min(RISK.volatilityMaxPoints, round(v * RISK.volatilityPerPct + Math.max(0, v - RISK.volatilityExtraFromPct) * RISK.volatilityExtraPerPct, 2));
      if (!(points > 0)) return R('clear', `30-day price range ${v}%`, e); // even a tight peg's 0.1% costs its 0.08: the steadiest goes first
      return R('flag', `30-day price range ${v}%`, e, points >= 20 ? 'critical' : points >= 8 ? 'high' : points >= 4 ? 'medium' : 'info', points);
    }
  },
  {
    id: 'nav_gap', pillar: 'price', max: 10,
    evaluate(d) {
      const nav = n(at(d, 'rwa.nav_usd')), p = n(at(d, 'price.usd'));
      const e = ev(d, 'rwa.nav_usd', 'price.usd');
      if (nav === null || !(nav > 0)) return na('No published NAV');
      if (p === null) return unknown('No price to compare with the NAV', e);
      const gap = round((Math.abs(p - nav) / nav) * 100, 2);
      const b = band(gap, RISK.navGapPct);
      return b ? R('flag', `Market price is ${gap}% away from the NAV`, e, b.level, b.points) : R('clear', `Market price within ${gap}% of the NAV`, e);
    }
  },
  {
    id: 'share_price_gap', pillar: 'price', max: 6,
    evaluate(d, x) {
      const share = n(at(d, 'price.share_price_assets')) ?? parseSharePrice(at(d, 'control.read_values'));
      const p = n(at(d, 'price.usd'));
      const e = [...ev(d, 'price.share_price_assets', 'control.read_values.asset', 'price.usd'), { path: 'asset.price.usd', value: x.assetPriceUsd ?? null }];
      if (share === null) return na('Not a vault share');
      if (!(x.assetPriceUsd > 0) || p === null) return unknown('Vault share: the asset price is not known here', e);
      const implied = share * x.assetPriceUsd;
      const gap = round((Math.abs(p - implied) / implied) * 100, 2);
      const b = band(gap, RISK.sharePriceGapPct);
      return b ? R('flag', `Market price is ${gap}% away from the vault's own share value`, e, b.level, b.points) : R('clear', `Market price within ${gap}% of the share value`, e);
    }
  },
  {
    id: 'pt_state', pillar: 'price', max: 40,
    evaluate(d, x) {
      if (!isPt(d)) return na('Not a Pendle PT');
      const e = ev(d, 'pendle.expired', 'pendle.expiry', 'pendle.days_to_expiry', 'control.read_values.expiry', 'control.read_values.isExpired');
      if (x.ptExpired === true) return R('flag', 'Matured PT: its market is closed and its price can freeze; holders must redeem through Pendle', e, 'critical', RISK.ptMaturedPoints);
      if (x.ptExpired === null) return unknown('PT expiry unknown', e);
      const days = n(at(d, 'pendle.days_to_expiry'));
      if (days !== null && days < RISK.ptSoonDays) return R('flag', `PT matures in ${days} days`, e, 'info', 2);
      return R('clear', 'Live PT', e);
    }
  },
  {
    id: 'source_verified', pillar: 'transparency', max: 10,
    evaluate(d) {
      const s = at(d, 'contract.sourcify_match'), b = at(d, 'contract.blockscout_verified');
      const e = ev(d, 'contract.sourcify_match', 'contract.blockscout_verified');
      if (s || b === true) return R('clear', 'Source code verified', e);
      if (b === false) return R('flag', 'Source code not verified', e, 'high', 10);
      return unknown('Verification unknown', e);
    }
  },
  {
    id: 'contract_age', pillar: 'scale', max: 8,
    evaluate(d, x) {
      const t = Date.parse(at(d, 'contract.deployed_at') ?? '');
      const e = ev(d, 'contract.deployed_at', 'meta.collected_at');
      if (!Number.isFinite(t) || x.refSec === null) return unknown('Deployment date unknown', e);
      const days = Math.floor((x.refSec * 1000 - t) / 86400000);
      const b = band(days, RISK.ageDays, 'asc');
      return b ? R('flag', `Contract deployed ${days} days ago`, e, b.level, b.points) : R('clear', `Contract deployed ${days} days ago`, e);
    }
  },
  {
    id: 'oracle_feed', pillar: 'transparency', max: 2,
    evaluate(d) {
      const feeds = at(d, 'oracle_feeds.feeds'), por = at(d, 'oracle_feeds.has_por_feed');
      const e = ev(d, 'oracle_feeds.feeds', 'oracle_feeds.has_por_feed');
      if (Array.isArray(feeds) && feeds.length) return R('clear', `Chainlink feed for the token${por ? ' including Proof of Reserve' : ''}`, e);
      if (por === null || por === undefined) return unknown('Chainlink catalog not read for this chain', e);
      return R('flag', 'No Chainlink feed for the token', e, 'info', 2);
    }
  },
  {
    id: 'market_cap', pillar: 'scale', max: RISK.marketCapUsd[0][1],
    evaluate(d) {
      const m = marketCap(d);
      const e = m.path === 'price.market_cap_usd' ? ev(d, m.path) : [...ev(d, 'identity.total_supply', 'identity.decimals', 'price.usd'), { path: m.path, value: round(m.value) }];
      if (m.value === null) return unknown('Market cap unknown', e);
      const p = curve(m.value, RISK.marketCapUsd, true);
      return p > 0 ? R('flag', `Market cap ${fmtUsd(m.value)}`, e, levelOf(p, RISK.marketCapUsd[0][1]), p) : R('clear', `Market cap ${fmtUsd(m.value)}`, e);
    }
  }
];

const notRatedReason = rec => {
  const d = rec?.data ?? {};
  const why = [];
  if (rec?.status === 'failed') why.push('collection failed');
  if (at(d, 'meta.chain_supported') === false) why.push('chain not supported by the collector');
  const cov = n(rec?.coverage) ?? n(at(d, 'meta.coverage'));
  if (cov === null || cov < RISK.minCoverage) why.push(`coverage ${cov ?? 'unknown'} below ${RISK.minCoverage}`);
  if (!(n(at(d, 'price.usd')) > 0)) why.push('no price');
  return why.length ? why.join('; ') : null;
};

/**
 * Rating of one token record ({chainId, address, symbol, status, coverage, data} as getTokenData returns it).
 * @param {object} record
 * @param {{assetPriceUsd?:number|null, nowSec?:number}} [ctx] price of the vault asset (from its own record) and a reference time override
 * @returns {{model, score:number|null, stability, stability_label, confidence, stability_score, control_score, not_rated_reason, penalty:number, flags:Array, pillars:object}}
 * `penalty` is the weighted sum before the 0..100 cut: it still orders the tokens that all score 0
 */
export function evaluateToken(record, ctx = {}) {
  const d = record?.data && typeof record.data === 'object' ? record.data : {};
  const refSec = n(ctx.nowSec) ?? n(at(d, 'meta.collected_at'));
  const quote = CHAINS[Number(record?.chainId)]?.usdc;
  const x = { refSec, assetPriceUsd: n(ctx.assetPriceUsd), ptExpired: null, isQuoteAsset: Boolean(quote) && String(record?.address ?? '').toLowerCase() === quote.toLowerCase() };
  x.ptExpired = ptExpired(d, refSec);
  const flags = [];
  const pillars = Object.fromEntries(Object.entries(RISK.pillars).map(([k, w]) => [k, { weight: w, points: 0, score: 100, flagged: 0, unknown: 0 }]));
  for (const rule of FLAG_RULES) {
    let r;
    try { r = rule.evaluate(d, x); } catch { r = unknown('Rule could not read the record', []); }
    const points = r.state === 'flag' ? r.points : r.state === 'unknown' ? round((r.max ?? rule.max) * (RISK.unknownShareByPillar[rule.pillar] ?? RISK.unknownShare), 2) : 0;
    const level = r.state === 'flag' ? r.level : r.state === 'unknown' ? (rule.max >= 10 ? 'medium' : 'info') : 'info';
    flags.push({ id: rule.id, pillar: rule.pillar, state: r.state, level, points, message: r.message, evidence: r.evidence });
    const p = pillars[rule.pillar];
    p.points = round(p.points + points, 2);
    if (r.state === 'flag') p.flagged++;
    if (r.state === 'unknown') p.unknown++;
  }
  for (const p of Object.values(pillars)) p.score = Math.max(0, round(100 - p.points, 1));
  const penalty = Object.values(pillars).reduce((s, p) => s + p.weight * p.points, 0);
  const applicable = flags.filter(f => f.state !== 'na');
  const unknownShare = applicable.length ? flags.filter(f => f.state === 'unknown').length / applicable.length : 1;
  const coverage = n(record?.coverage) ?? n(at(d, 'meta.coverage')) ?? 0;
  const c = RISK.confidence;
  const confidence = coverage >= c.high.coverage && unknownShare <= c.high.unknown ? 'high' : coverage >= c.medium.coverage && unknownShare <= c.medium.unknown ? 'medium' : 'low';
  const cw = RISK.controlWeights;
  const controlScore = Math.max(0, round(100 - cw.control * pillars.control.points - cw.transparency * pillars.transparency.points, 1));
  const nr = notRatedReason(record);
  const raw = Math.max(0, Math.min(100, round(100 - penalty, 1)));
  const cap = confidence === 'low' ? RISK.lowConfidenceMaxScore : 100;
  const capped = !nr && raw > cap;
  const score = nr ? null : capped ? cap : raw;
  const stability = nr ? 'insufficient_data' : (RISK.levels.find(([, min]) => score >= min)?.[0] ?? 'low');
  return {
    model: RISK_MODEL, score, stability, stability_label: STABILITY_LABELS[stability], confidence: nr ? 'low' : confidence, stability_score: score, control_score: controlScore,
    not_rated_reason: nr, score_before_cap: capped ? raw : null, penalty: round(penalty, 1), unknown_share: round(unknownShare, 3), flags, pillars
  };
}

/** The flagged rules that cost the most (weighted), at most `k`; `control` picks the control and transparency rules, which are not ranked by. */
function topFlags(result, k = 3, control = false) {
  return result.flags.filter(f => f.state === 'flag' && (RISK.controlWeights[f.pillar] !== undefined) === control)
    .sort((a, b) => b.points * (RISK.pillars[b.pillar] || 1) - a.points * (RISK.pillars[a.pillar] || 1) || LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] || a.id.localeCompare(b.id))
    .slice(0, k).map(f => ({ id: f.id, level: f.level, points: f.points, message: f.message }));
}

/**
 * Ranks token records from the safest to the riskiest: rated ones by score (then confidence, the uncut penalty, market cap), then the not rated (NR)
 * by coverage. Ties end on chain id and address, so the order is the same on every run. The price of an ERC-4626 vault's asset is
 * taken from the asset's own record when it is in the list.
 * @param {object[]} records
 * @returns {Array<{rank, chainId, address, symbol, score, stability, stability_label, confidence, stability_score, control_score, market_cap_usd, top_flags, not_rated_reason}>}
 */
export function rankTokens(records) {
  const list = Array.isArray(records) ? records.filter(r => r && typeof r === 'object') : [];
  const prices = new Map(list.map(r => [`${Number(r.chainId)}:${String(r.address).toLowerCase()}`, n(at(r, 'data.price.usd'))]));
  const rows = list.map(r => {
    const asset = assetAddressOf(r);
    const e = evaluateToken(r, { assetPriceUsd: asset ? prices.get(`${Number(r.chainId)}:${asset}`) ?? null : null });
    return {
      chainId: Number(r.chainId), address: String(r.address).toLowerCase(), symbol: r.symbol ?? at(r, 'data.identity.symbol') ?? null,
      score: e.score, stability: e.stability, stability_label: e.stability_label, confidence: e.confidence, stability_score: e.stability_score, control_score: e.control_score,
      market_cap_usd: round(marketCap(r.data ?? {}).value, 0), penalty: e.penalty, coverage: n(r.coverage), top_flags: topFlags(e), control_flags: topFlags(e, 2, true), not_rated_reason: e.not_rated_reason
    };
  });
  rows.sort((a, b) => {
    const nrA = a.stability === 'insufficient_data', nrB = b.stability === 'insufficient_data';
    if (nrA !== nrB) return nrA ? 1 : -1;
    if (!nrA && a.score !== b.score) return b.score - a.score;
    if (!nrA && a.confidence !== b.confidence) return CONF_ORDER[b.confidence] - CONF_ORDER[a.confidence];
    if (!nrA && a.penalty !== b.penalty) return a.penalty - b.penalty; // the many dead markets at 0 still differ in how dead
    if (nrA && a.coverage !== b.coverage) return (b.coverage ?? 0) - (a.coverage ?? 0);
    if (a.market_cap_usd !== b.market_cap_usd) return (b.market_cap_usd ?? -1) - (a.market_cap_usd ?? -1);
    return a.chainId - b.chainId || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  });
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}
