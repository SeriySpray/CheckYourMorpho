import assert from 'node:assert/strict';
import fs from 'node:fs';

// Golden set: real records from a full collection (October 2026), minimised (tests/data/risk)
const dir = new URL('../data/risk/', import.meta.url);
const golden = Object.fromEntries(fs.readdirSync(dir).map(f => [f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'))]));
const g = name => structuredClone(golden[name]);
const flag = (res, id) => res.flags.find(f => f.id === id);
const with_ = (rec, fn) => { const r = structuredClone(rec); fn(r.data); return r; };

export default {
  RISK_MODEL: [['a named version string', ({ RISK_MODEL: m }) => assert.match(m, /^token-risk-\d+$/)]],
  FLAG_RULES: [
    ['unique ids, a known pillar and a positive maximum for every rule', ({ FLAG_RULES: rules }) => {
      assert.equal(new Set(rules.map(r => r.id)).size, rules.length);
      for (const r of rules) { assert.ok(['control', 'liquidity', 'holders', 'price', 'transparency', 'scale'].includes(r.pillar), r.id); assert.ok(r.max > 0 && typeof r.evaluate === 'function', r.id); }
      for (const p of ['control', 'liquidity', 'holders', 'price', 'transparency', 'scale']) assert.ok(rules.some(r => r.pillar === p), p);
    }],
    ['with no data a rule never says clear or flag: missing input is unknown (or the rule does not apply)', ({ FLAG_RULES: rules }) => {
      for (const r of rules) {
        const out = r.evaluate({}, { refSec: null, assetPriceUsd: null, ptExpired: null });
        assert.ok(['unknown', 'na'].includes(out.state), `${r.id}: ${out.state}`);
      }
    }]
  ],
  assetAddressOf: [['the vault asset from the Read Contract values, lower case; null otherwise', ({ assetAddressOf: f }) => {
    assert.equal(f(g('1_sUSDe')), '0x4c9edd5852cd905f086c759e8383e09bff1e68b3');
    for (const r of [g('1_WETH'), null, {}, { data: { control: { read_values: { asset: 'nope' } } } }]) assert.equal(f(r), null);
  }]],
  evaluateToken: [
    ['golden grades: the rank is stability only, so WETH, sUSDe, USDC, USDe and cbBTC (Base) are A and kBTC B (control does not move it); WETH on Base B (no holder list), the $1.9M tokenized S&P 500 B; EIGEN, the 7702-controlled vault, stakedao and mF-ONE E', ({ evaluateToken: f }) => {
      const grade = name => f(g(name)).grade;
      assert.deepEqual(['1_WETH', '1_sUSDe', '1_USDC', '1_USDe', '8453_cbBTC', '1_kBTC', '8453_WETH', '8453_deSPXA', '1_EIGEN', '1_aguaUSDCgc', '1_stakedao-frxsUSDS', '1_mF-ONE'].map(grade),
        ['A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'E', 'E', 'E', 'E']);
    }],
    ['live PT: the pool index does not see its Pendle AMM, so volume is not judged (na); the Pendle liquidity carries the exit on a curve', ({ evaluateToken: f }) => {
      const live = g('1_PT-sUSDE-26NOV2026');
      assert.equal(flag(f(live), 'volume_24h').state, 'na');
      assert.equal(flag(f(g('1_PT-USDe-25SEP2025')), 'volume_24h').state, 'na', 'matured: ignored as before');
      const at = usd => flag(f(with_(live, d => { d.pendle.liquidity_usd = usd; })), 'exit_100k');
      assert.deepEqual([at(5e5).points, at(5e6).points, at(2e7).points, at(1e8).state], [24, 12, 6, 'clear']);
      assert.ok(at(5.2e6).points < 12 && at(5.2e6).points > at(1.3e7).points && at(1.3e7).points > 6, 'more liquidity costs less, no step at the old $5M edge');
      assert.equal(at(5e5).level, 'high'); assert.match(at(5.2e6).message, /\$5\.2M/);
    }],
    ['curves: a worse exit, thinner pools, less volume and a smaller market cost more, without a jump at the old band edges', ({ evaluateToken: f }) => {
      const sell = (size, impact) => flag(f(with_(g('1_WETH'), d => { d.liquidity.kyber[String(size)] = { status: 'ok', out_usd: size * (1 - impact / 100) }; })), size === 100000 ? 'exit_100k' : 'exit_1m');
      assert.equal(sell(100000, 0.2).state, 'clear');
      assert.ok(sell(100000, 0.9).points > 0 && sell(100000, 1.1).points - sell(100000, 0.9).points < 2, 'the old 1% edge was a jump from 0 to 8');
      assert.ok(Math.abs(sell(100000, 3.1).points - sell(100000, 2.9).points) < 1.5);
      assert.deepEqual([sell(100000, 10).points, sell(100000, 10).level, sell(100000, 40).points], [30, 'critical', 30]);
      assert.deepEqual([sell(1000000, 0.5).state, sell(1000000, 3).points, sell(1000000, 25).points, sell(1000000, 70).points], ['clear', 2, 12, 18]);
      const noRoute = f(with_(g('1_WETH'), d => { d.liquidity.kyber['1000000'] = { status: 'no_route' }; }));
      assert.equal(flag(noRoute, 'exit_1m').points, 18, 'no route is as bad as the worst quote');
      const pools = usd => flag(f(with_(g('1_WETH'), d => { d.liquidity.total_reserve_usd = usd; })), 'dex_depth');
      assert.deepEqual([pools(5e4).points, pools(1e6).points, pools(1e7).points, pools(2e8).state], [10, 6, 2.5, 'clear']);
      assert.ok(pools(2.3e6).points > 2.5 && pools(2.3e6).points < 6);
      const vol = usd => flag(f(with_(g('1_WETH'), d => { d.price.volume_24h_usd = usd; d.liquidity.total_volume_24h_usd = usd; })), 'volume_24h');
      assert.deepEqual([vol(0).points, vol(0).level, vol(1e4).points, vol(2e6).state], [20, 'critical', 8, 'clear']);
      assert.ok(vol(2e4).points > 2 && vol(2e4).points < 8);
      const cap = r => flag(f(r), 'market_cap');
      assert.ok(cap(g('8453_deSPXA')).points > 14 && cap(g('1_WETH')).points < 1, 'a $1.9M token against a $5.3B one');
      assert.equal(cap(with_(g('1_WETH'), d => { d.price.market_cap_usd = 2e10; })).state, 'clear');
      assert.ok(f(g('8453_deSPXA')).score < f(g('8453_WETH')).score, 'a tiny tokenized stock ranks under WETH on Base');
    }],
    ['volatility: even a tight peg costs a little, so the steadiest goes first; a 40% month is near the 45 cap', ({ evaluateToken: f }) => {
      const vol = range => flag(f(with_(g('1_WETH'), d => { d.price.chart.range_pct = range; })), 'volatility_30d');
      const usdc = flag(f(g('1_USDC')), 'volatility_30d');
      assert.deepEqual([usdc.state, usdc.level], ['flag', 'info']); assert.ok(usdc.points > 0 && usdc.points < 0.1);
      assert.equal(vol(0).state, 'clear');
      assert.deepEqual([vol(16).points, vol(40).points, vol(44).points, vol(44).level], [12.8, 44, 45, 'critical']);
      assert.ok(f(g('1_USDC')).score > f(g('1_USDe')).score, 'USDC (0.054%) over USDe (0.064%)');
    }],
    ['holder facts an L2 explorer did not give: the known top-10 share bounds the unknown, which then costs less but never nothing', ({ evaluateToken: f }) => {
      const r = f(g('8453_WETH'));
      for (const [id, pts] of [['holder_top1', 1], ['morpho_dependency', 1.2]]) {
        assert.deepEqual([flag(r, id).state, flag(r, id).points], ['unknown', pts], id);
        assert.match(flag(r, id).message, /at most 45\.3732%/); assert.ok(flag(r, id).evidence.some(e => e.path === 'holders.gecko_top10_pct'), id);
      }
      const open = f(with_(g('8453_WETH'), d => { d.holders.gecko_top10_pct = null; }));
      assert.deepEqual([flag(open, 'holder_top1').points, flag(open, 'morpho_dependency').points], [2, 5], 'without a bound: a share of the rule maximum');
      const spread = f(with_(g('8453_WETH'), d => { d.holders.gecko_top10_pct = 20; }));
      assert.deepEqual([flag(spread, 'holder_top1').state, flag(spread, 'morpho_dependency').state], ['clear', 'clear'], 'under the first band nothing is left unknown');
      assert.equal(f(with_(g('8453_WETH'), d => { d.holders.gecko_top10_pct = 120; })).flags.find(x => x.id === 'holder_top1').points, 2, 'a share over 100% is not a bound');
      assert.equal(r.confidence, 'medium');
    }],
    ['old record: own top-10 is the top-10 share less the pools and protocols in the top list plus what holders below the tenth could add', ({ evaluateToken: f }) => {
      const r = flag(f(g('1_USDe')), 'holder_top10');
      assert.deepEqual([r.state, r.message], ['clear', 'Top 10 own holders (pools and protocols left out) have at most 21.404%']);
      assert.deepEqual(r.evidence.map(e => e.path), ['holders.top10_pct', 'holders.gecko_top10_pct', 'holders.top']);
      const noNames = f(with_(g('1_USDe'), d => { for (const h of d.holders.top) h.name = null; }));
      assert.deepEqual([flag(noNames, 'holder_top10').state, flag(noNames, 'holder_top10').points], ['flag', 5], 'nobody to leave out: the all-holder share');
      const stored = f(with_(g('1_USDe'), d => { d.holders.top1_nonprotocol_pct = 4.37; d.holders.top10_nonprotocol_pct = 30; }));
      assert.equal(flag(stored, 'holder_top10').message, 'Top 10 holders have 30%', 'a new record keeps its stored share');
    }],
    ['USDC and cbBTC: an EOA holds the keys of an upgradeable token with blacklist; USDC itself has no swap to judge', ({ evaluateToken: f }) => {
      for (const name of ['1_USDC', '8453_cbBTC']) {
        const r = f(g(name));
        assert.deepEqual([flag(r, 'controller_eoa').state, flag(r, 'controller_eoa').level, flag(r, 'fn_blacklist').state, flag(r, 'upgradeable').state], ['flag', 'critical', 'flag', 'flag'], name);
        assert.ok(r.control_score < 60 && r.stability_score >= 85, `${name}: dangerous keys, steady market`);
      }
      assert.deepEqual([flag(f(g('1_USDC')), 'exit_100k').state, flag(f(g('1_USDC')), 'exit_1m').state], ['na', 'na'], 'old record held a 400 "identical with tokenOut"');
      assert.ok(flag(f(g('1_USDC')), 'controller_eoa').evidence.some(e => e.path === 'control.controllers.0.is_contract' && e.value === false));
    }],
    ['sUSDe: the Timelock owner is a contract, no EOA flag; only blacklist is flagged', ({ evaluateToken: f }) => {
      const r = f(g('1_sUSDe'));
      assert.deepEqual([flag(r, 'controller_eoa').state, flag(r, 'controller_unrecognized').state, flag(r, 'fn_blacklist').state], ['clear', 'clear', 'flag']);
      assert.equal(flag(r, 'controller_timelock').state, 'unknown', 'the old record has no delay: unknown, not clear');
      const withDelay = d => with_(g('1_sUSDe'), x => { x.control.controllers[0].timelock_delay_sec = d; });
      assert.equal(flag(f(withDelay(86400)), 'controller_timelock').state, 'clear');
      assert.deepEqual([flag(f(withDelay(3600)), 'controller_timelock').state, flag(f(withDelay(3600)), 'controller_timelock').level], ['flag', 'medium']);
      assert.ok(f(withDelay(86400)).control_score > f(g('1_sUSDe')).control_score && f(withDelay(3600)).control_score < f(withDelay(86400)).control_score, 'the delay moves the control score, not the rank');
      assert.equal(f(withDelay(3600)).score, f(g('1_sUSDe')).score);
    }],
    ['kBTC: an EOA owner and 85% of the supply in Morpho Blue', ({ evaluateToken: f }) => {
      const r = f(g('1_kBTC'));
      assert.deepEqual([flag(r, 'controller_eoa').state, flag(r, 'morpho_dependency').state, flag(r, 'morpho_dependency').level], ['flag', 'flag', 'high']);
      assert.deepEqual(flag(r, 'morpho_dependency').evidence, [{ path: 'holders.morpho_blue_pct', value: 85.718 }]);
      assert.equal(flag(r, 'morpho_dependency').points, 25, 'from 75% in Morpho Blue: 25 points (15 from 50%, 6 from 25%)');
      assert.equal(flag(r, 'holder_top1').state, 'clear', 'Morpho Blue is not counted as an own holder');
    }],
    ['EIGEN: a Safe with threshold 1/2 is flagged high; the swap impact is computed from out_usd, not the stored value', ({ evaluateToken: f }) => {
      const r = f(g('1_EIGEN'));
      assert.deepEqual([flag(r, 'controller_safe_threshold').state, flag(r, 'controller_safe_threshold').level], ['flag', 'high']);
      assert.match(flag(r, 'controller_safe_threshold').message, /1\/2/);
      const out = g('1_EIGEN').data.liquidity.kyber['100000'].out_usd;
      assert.match(flag(r, 'exit_100k').message, new RegExp(String(Math.round((1 - out / 100000) * 100000) / 1000).replace('.', '\\.')));
    }],
    ['the 7702 delegated EOA counts as a single key even though Blockscout calls it a contract', ({ evaluateToken: f }) => {
      const r = f(g('1_aguaUSDCgc'));
      assert.equal(g('1_aguaUSDCgc').data.control.controllers[0].is_contract, true);
      assert.equal(flag(r, 'controller_eoa').state, 'flag'); assert.match(flag(r, 'controller_eoa').message, /7702/);
      assert.equal(flag(r, 'controller_unrecognized').state, 'clear');
    }],
    ['matured PT: swap liquidity ignored, pt_state critical; live PT judged by Pendle liquidity', ({ evaluateToken: f }) => {
      const old = f(g('1_PT-USDe-25SEP2025'));
      assert.deepEqual([flag(old, 'pt_state').state, flag(old, 'pt_state').level, flag(old, 'exit_100k').state, flag(old, 'exit_1m').state, flag(old, 'dex_depth').state], ['flag', 'critical', 'na', 'na', 'na']);
      assert.ok(flag(old, 'pt_state').evidence.some(e => e.path === 'control.read_values.isExpired' && e.value === 'True'), 'the old record carries only the contract values');
      const live = f(g('1_PT-sUSDE-26NOV2026'));
      assert.equal(flag(live, 'pt_state').state, 'clear'); assert.equal(flag(live, 'exit_1m').state, 'na');
      assert.deepEqual(flag(live, 'exit_100k').evidence[0], { path: 'pendle.liquidity_usd', value: g('1_PT-sUSDE-26NOV2026').data.pendle.liquidity_usd });
      assert.ok(live.score > old.score);
    }],
    ['a token on a chain without collector support and without a price is not rated, with the reason', ({ evaluateToken: f }) => {
      const r = f(g('4663_USDe'));
      assert.deepEqual([r.score, r.grade, r.confidence], [null, 'NR', 'low']);
      assert.match(r.not_rated_reason, /chain not supported/); assert.match(r.not_rated_reason, /no price/);
      const noPrice = with_(g('1_WETH'), d => { d.price.usd = null; });
      assert.deepEqual([f(noPrice).grade, f(noPrice).not_rated_reason], ['NR', 'no price']);
      assert.equal(f({ ...g('1_WETH'), coverage: 0.3 }).grade, 'NR', 'low coverage');
    }],
    ['Monad: no explorer, so the confidence is not high', ({ evaluateToken: f }) => assert.equal(f(g('143_cbBTC')).confidence, 'medium')],
    ['RWA: the market price is compared with the published NAV', ({ evaluateToken: f }) => {
      const r = f(g('1_mF-ONE'));
      assert.equal(flag(r, 'nav_gap').state, 'clear');
      const off = with_(g('1_mF-ONE'), d => { d.price.usd = d.rwa.nav_usd * 0.9; });
      assert.deepEqual([flag(f(off), 'nav_gap').state, flag(f(off), 'nav_gap').level], ['flag', 'high']);
      assert.equal(flag(f(g('1_WETH')), 'nav_gap').state, 'na');
    }],
    ['ERC-4626: the share value times the asset price is compared with the market price; without the asset price it is unknown', ({ evaluateToken: f }) => {
      assert.equal(flag(f(g('1_sUSDe')), 'share_price_gap').state, 'unknown');
      assert.equal(flag(f(g('1_sUSDe'), { assetPriceUsd: 0.9997 }), 'share_price_gap').state, 'clear');
      assert.equal(flag(f(g('1_sUSDe'), { assetPriceUsd: 1.2 }), 'share_price_gap').level, 'high');
    }],
    ['new collector fields: upgrade_via_proxy, the quote asset marker, a 7702 marker, an expired flag on a PT', ({ evaluateToken: f }) => {
      assert.equal(flag(f(with_(g('1_WETH'), d => { d.contract.fn.upgrade_via_proxy = true; })), 'upgradeable').state, 'flag');
      assert.equal(flag(f(with_(g('1_sUSDe'), d => { d.liquidity.kyber['100000'] = { status: 'na', reason: 'token is the quote asset (USDC)' }; })), 'exit_100k').state, 'na');
      assert.equal(flag(f(with_(g('1_sUSDe'), d => { d.control.controllers[0].is_eoa_delegated = true; })), 'controller_eoa').state, 'flag');
      assert.equal(flag(f(with_(g('1_PT-sUSDE-26NOV2026'), d => { d.pendle.expired = true; })), 'pt_state').level, 'critical');
      const noRoute = f(with_(g('1_WETH'), d => { d.liquidity.kyber['100000'] = { status: 'no_route', reason: '4008 route not found' }; }));
      assert.deepEqual([flag(noRoute, 'exit_100k').state, flag(noRoute, 'exit_100k').level], ['flag', 'critical']); assert.match(flag(noRoute, 'exit_100k').message, /4008/);
    }],
    ['an unknown input never counts as fine: it scores below the same record with the fact checked and clear', ({ evaluateToken: f }) => {
      const base = f(g('1_WETH'));
      for (const path of ['holders.morpho_blue_pct', 'contract.fn.blacklist', 'price.chart', 'contract.deployed_at', 'holders', 'price.price_ts', 'liquidity.kyber']) {
        const r = f(with_(g('1_WETH'), d => { const k = path.split('.'); k.slice(0, -1).reduce((o, x) => o[x], d)[k.at(-1)] = null; }));
        const key = path.startsWith('contract.fn') ? 'control_score' : 'score'; // control facts move the control score, the rest the rank
        assert.ok(r[key] < base[key], `${path}: ${r[key]} >= ${base[key]}`);
        assert.ok(r.flags.some(x => x.state === 'unknown' && x.points > 0), path);
      }
      const noCtl = with_(g('1_WETH'), d => { d.contract.fn = Object.fromEntries(Object.keys(d.contract.fn).map(k => [k, null])); d.contract.is_proxy = null; });
      assert.ok(f(noCtl).control_score < f(g('1_WETH')).control_score); assert.equal(flag(f(noCtl), 'controller_eoa').state, 'unknown');
    }],
    ['little data: low confidence and the score is capped below B', ({ evaluateToken: f }) => {
      const r = f({ ...g('1_WETH'), coverage: 0.45 });
      assert.equal(r.confidence, 'low'); assert.ok(r.score <= 69.9 && r.score_before_cap > r.score, JSON.stringify([r.score, r.score_before_cap]));
    }],
    ['every flagged rule carries evidence paths; pillars add up to the score; deterministic', ({ evaluateToken: f }) => {
      for (const name of Object.keys(golden)) {
        const r = f(g(name));
        for (const x of r.flags.filter(x => x.state === 'flag')) assert.ok(x.evidence.length && x.evidence.every(e => typeof e.path === 'string'), `${name} ${x.id}`);
        if (r.score !== null && r.score_before_cap === null) {
          const pen = Object.values(r.pillars).reduce((s, p) => s + p.weight * p.points, 0);
          assert.ok(Math.abs(Math.max(0, 100 - pen) - r.score) < 0.11, name);
        }
        assert.deepEqual(f(g(name)), r);
      }
    }],
    ['an empty or broken record does not throw and is not rated', ({ evaluateToken: f }) => {
      for (const rec of [{ data: {} }, {}, null, { data: { contract: 'x', control: { controllers: 'no' } } }]) assert.equal(f(rec).grade, 'NR');
    }]
  ],
  rankTokens: [
    ['golden order: steadiest first, the matured PT below the live PT, the illiquid below both, the not rated last', ({ rankTokens: f }) => {
      const out = f(Object.keys(golden).map(g));
      const pos = (chainId, symbol) => out.find(r => r.chainId === chainId && r.symbol === symbol).rank;
      assert.deepEqual(out.map(r => r.rank), out.map((_, i) => i + 1));
      assert.deepEqual([out[0].symbol, out.at(-1).symbol, out.at(-1).grade], ['USDC', 'USDe', 'NR']);
      assert.ok(pos(1, 'USDC') < pos(1, 'kBTC') && pos(1, 'kBTC') < pos(1, 'PT-sUSDE-26NOV2026'), 'control does not move the rank: the EOA-held USDC is on top');
      assert.ok(pos(1, 'PT-sUSDE-26NOV2026') < pos(1, 'PT-USDe-25SEP2025') && pos(1, 'kBTC') < pos(1, 'EIGEN') && pos(1, 'EIGEN') < pos(1, 'mF-ONE'));
      for (let i = 1; i < out.length; i++) if (out[i].grade !== 'NR' && out[i - 1].grade !== 'NR') assert.ok(out[i - 1].score >= out[i].score);
    }],
    ['top flags: at most 3, the costliest first; the not rated carry their reason', ({ rankTokens: f }) => {
      const out = f(Object.keys(golden).map(g));
      const usdc = out.find(r => r.symbol === 'USDC');
      assert.ok(usdc.top_flags.length <= 3 && usdc.top_flags.every(f => f.id !== 'controller_eoa'), 'control flags are listed apart');
      assert.equal(usdc.control_flags[0].id, 'controller_eoa');
      assert.match(out.at(-1).not_rated_reason, /no price/); assert.deepEqual(out.at(-1).top_flags, []);
    }],
    ['the order does not depend on the input order; equal scores fall back to confidence, market cap, chain and address', ({ rankTokens: f }) => {
      const recs = Object.keys(golden).map(g);
      assert.deepEqual(f([...recs].reverse()), f(recs));
      const twin = { ...g('1_WETH'), address: '0x' + '0'.repeat(39) + '1' };
      const t = f([g('1_WETH'), twin]);
      assert.deepEqual(t.map(r => r.address), [twin.address, g('1_WETH').address]);
      assert.deepEqual(f([]), []); assert.deepEqual(f(null), []);
    }],
    ['the CLI report (scripts/token-ranking.mjs) counts grades and lists the safest, the riskiest and the not rated with reasons', async ({ rankTokens: f }) => {
      const { rankingReport } = await import('../../scripts/token-ranking.mjs');
      const md = rankingReport(f(Object.keys(golden).map(g)), { source: 'golden', generatedAt: 'T' });
      assert.match(md, /\| A \| 5 \|/); assert.match(md, /\| NR \| 1 \|/); assert.match(md, /## 20 safest[\s\S]*\| 1 \| ethereum \| USDC \|/);
      assert.match(md, /## Not rated \(1\)[\s\S]*\| 4663 \| USDe \| - \| NR \| low \| [\d.]+ \| chain not supported/);
      assert.ok(!/[–—]/.test(md), 'no long dashes');
    }],
    ['tokens cut to 0 are ordered by their uncut penalty: the deader market goes last', ({ rankTokens: f, evaluateToken: ev }) => {
      const dead = g('1_stakedao-frxsUSDS');
      const worse = with_({ ...dead, address: '0x' + '0'.repeat(39) + '1' }, d => { d.price.chart.range_pct = 40; });
      assert.deepEqual([ev(dead).score, ev(worse).score], [0, 0]); assert.ok(ev(worse).penalty > ev(dead).penalty);
      assert.deepEqual(f([worse, dead]).map(r => r.address), [dead.address, worse.address], 'the lower address would win a plain tie');
    }],
    ['a vault share is compared with the price of its asset when the asset is in the list', ({ rankTokens: f }) => {
      const usde = { chainId: 1, address: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', symbol: 'USDe', coverage: 0.9, data: { price: { usd: 0.9997 } } };
      const alone = f([g('1_sUSDe')])[0].score, paired = f([g('1_sUSDe'), usde]).find(r => r.symbol === 'sUSDe').score;
      assert.ok(paired > alone, `${paired} > ${alone}: the share check moves from unknown to clear`);
    }]
  ]
};
