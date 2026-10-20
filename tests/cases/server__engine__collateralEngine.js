import assert from 'node:assert/strict';
import { vault, alloc, idle, unrated } from '../fixtures.js';

const NOW = 1_800_000_000;
const DAY = 86400;
// Allocation of one token with a research record; tier/confidence/age/status are parameters
const rated = (sym, usd, tier, over = {}) => alloc({
  market_unique_key: `1:${sym}`, collateral_asset_address: `0x${sym}`, collateral_asset_symbol: sym, supply_assets_usd: usd,
  collateral_risk_tier: tier, collateral_confidence: 'high', collateral_research_status: 'rated', collateral_researched_at: NOW - DAY, collateral_category: 'other', ...over
});
const none = (sym, usd) => unrated({ market_unique_key: `1:${sym}`, collateral_asset_address: `0x${sym}`, collateral_asset_symbol: sym, supply_assets_usd: usd });

export default {
  COLLATERAL_MODEL: [['model id', ({ COLLATERAL_MODEL: v }) => assert.equal(v, 'ai-research-1')]],
  RESEARCH_MAX_AGE_SEC: [['60 days', ({ RESEARCH_MAX_AGE_SEC: v }) => assert.equal(v, 60 * DAY)]],
  parseTagsJson: [
    ['an array is returned; null, the string null, objects and garbage give null', ({ parseTagsJson: f }) => {
      assert.deepEqual(f('["eth","lst"]'), ['eth', 'lst']);
      for (const v of [null, undefined, 'null', '{"a":1}', '{', '']) assert.equal(f(v), null);
    }],
  ],
  isResearchRated: [
    ['rated, tier 1..5, fresh: usable', ({ isResearchRated: f }) => {
      for (const t of [1, 2, 3, 4, 5]) assert.equal(f(rated('A', 1, t), NOW), true, String(t));
    }],
    ['unrated status, missing record, out-of-range tier and null tier are not usable', ({ isResearchRated: f }) => {
      assert.equal(f(rated('A', 1, 3, { collateral_research_status: 'unrated' }), NOW), false);
      assert.equal(f(none('A', 1), NOW), false);
      for (const t of [0, 6, 2.5, null, 'x']) assert.equal(f(rated('A', 1, t), NOW), false, String(t));
    }],
    ['a record older than 60 days is stale, exactly 60 days is still fresh, a missing date is not usable', ({ isResearchRated: f }) => {
      assert.equal(f(rated('A', 1, 2, { collateral_researched_at: NOW - 60 * DAY }), NOW), true);
      assert.equal(f(rated('A', 1, 2, { collateral_researched_at: NOW - 60 * DAY - 1 }), NOW), false);
      assert.equal(f(rated('A', 1, 2, { collateral_researched_at: null }), NOW), false);
    }],
    ['the clock defaults to now', ({ isResearchRated: f }) => {
      assert.equal(f(alloc()), true); assert.equal(f(alloc({ collateral_researched_at: 1 })), false);
    }],
  ],
  researchTierOf: [
    ['the tier of a usable record, null otherwise', ({ researchTierOf: f }) => {
      assert.equal(f(rated('A', 1, 4), NOW), 4); assert.equal(f(none('A', 1), NOW), null);
      assert.equal(f(rated('A', 1, 4, { collateral_researched_at: NOW - 61 * DAY }), NOW), null);
      assert.equal(f(alloc()), 1);
    }],
  ],
  isImpairedCollateral: [
    ['tier 5 with confidence medium or high only; stale, unrated and lower tiers are not impaired', ({ isImpairedCollateral: f }) => {
      assert.equal(f(rated('A', 1, 5), NOW), true);
      assert.equal(f(rated('A', 1, 5, { collateral_confidence: 'medium' }), NOW), true);
      assert.equal(f(rated('A', 1, 5, { collateral_confidence: 'low' }), NOW), false);
      assert.equal(f(rated('A', 1, 4), NOW), false);
      assert.equal(f(rated('A', 1, 5, { collateral_researched_at: NOW - 70 * DAY }), NOW), false);
      assert.equal(f(none('A', 1), NOW), false);
    }],
  ],
  calculateResearchMix: [
    ['shares per tier, low risk (1+2), high risk (4+5), impaired (5) and unrated', ({ calculateResearchMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6 }), [rated('a', 30e6, 1), rated('b', 20e6, 2), rated('c', 15e6, 3), rated('d', 10e6, 4), rated('e', 5e6, 5), none('f', 20e6)], NOW);
      assert.equal(r.tier, 'CLASSIFIED');
      assert.deepEqual(r.byRiskTier, { 1: 30, 2: 20, 3: 15, 4: 10, 5: 5 });
      assert.deepEqual([r.lowRiskPercent, r.highRiskPercent, r.impairedPercent, r.unratedPercent], [50, 15, 5, 20]);
      assert.deepEqual(r.tokens.map(t => [t.symbol, t.tier, t.percent]), [['a', 1, 30], ['b', 2, 20], ['f', null, 20], ['c', 3, 15], ['d', 4, 10], ['e', 5, 5]]);
      assert.equal(r.tokens.find(t => t.symbol === 'e').confidence, 'high'); assert.equal(r.tokens.find(t => t.symbol === 'f').confidence, null);
    }],
    ['no record, a stale record and an unrated status are all unrated, never safe', ({ calculateResearchMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6 }), [none('a', 25e6), rated('b', 25e6, 1, { collateral_researched_at: NOW - 61 * DAY }),
        rated('c', 25e6, 1, { collateral_research_status: 'unrated', collateral_risk_tier: null }), rated('d', 25e6, 1)], NOW);
      assert.deepEqual([r.unratedPercent, r.lowRiskPercent], [75, 25]);
    }],
    ['records stored by the fact-collecting agent (tier null, status unrated, fresh) count as unrated, nothing is low or high risk', ({ calculateResearchMix: f }) => {
      const facts = (k, usd) => rated(k, usd, 1, { collateral_risk_tier: null, collateral_research_status: 'unrated', collateral_confidence: 'high', collateral_researched_at: NOW });
      const r = f(vault({ total_assets_usd: 100e6 }), [facts('a', 60e6), facts('b', 40e6)], NOW);
      assert.deepEqual([r.tier, r.unratedPercent, r.lowRiskPercent, r.highRiskPercent, r.impairedPercent], ['CLASSIFIED', 100, 0, 0, 0]);
      assert.ok(r.tokens.every(t => t.tier === null && t.confidence === null));
    }],
    ['allocations of one token are merged, with their shares summed', ({ calculateResearchMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6 }), [rated('a', 30e6, 3, { market_unique_key: '1:m1' }), rated('a', 20e6, 3, { market_unique_key: '1:m2' })], NOW);
      assert.equal(r.tokens.length, 1); assert.deepEqual([r.tokens[0].usd, r.tokens[0].percent, r.byRiskTier[3]], [50e6, 50, 50]);
    }],
    ['idle markets are separate and not rated; undeployed capital is reported', ({ calculateResearchMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6 }), [idle({ supply_assets_usd: 50e6 }), rated('a', 30e6, 1)], NOW);
      assert.deepEqual([r.idlePercent, r.undeployedPercent, r.unratedPercent, r.lowRiskPercent], [50, 20, 0, 30]);
    }],
    ['tiers: no capital is UNKNOWN, only idle is UNALLOCATED', ({ calculateResearchMix: f }) => {
      assert.equal(f(vault({ total_assets_usd: 0 }), [], NOW).tier, 'UNKNOWN');
      assert.equal(f(vault({ total_assets_usd: 10e6 }), [idle({ supply_assets_usd: 10e6 })], NOW).tier, 'UNALLOCATED');
    }],
    ['unverified capital leaves the percent base', ({ calculateResearchMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6, unresolved_exposure_usd: 50e6 }), [rated('e', 50e6, 2)], NOW);
      assert.equal(r.unverifiedPercent, 50); assert.equal(r.lowRiskPercent, 100);
    }],
    ['zero or invalid supply is ignored; the clock defaults to now', ({ calculateResearchMix: f }) => {
      const r = f(vault({ total_assets_usd: 10e6 }), [alloc({ supply_assets_usd: 0 }), alloc({ supply_assets_usd: 'x' }), alloc({ supply_assets_usd: 10e6 })]);
      assert.deepEqual([r.tokens.length, r.lowRiskPercent], [1, 100]);
      assert.equal(f(vault(), undefined, NOW).tier, 'UNALLOCATED');
    }],
  ],
};
