import assert from 'node:assert/strict';
import fs from 'node:fs';
import { vault, alloc, idle } from '../fixtures.js';

const tok = (address, symbol, usd, over = {}) => alloc({
  market_unique_key: `1:${symbol}`, collateral_asset_address: address, collateral_asset_symbol: symbol, supply_assets_usd: usd, ...over
});
const unknown = (usd, sym = 'NEWCOIN') => tok(`0x${sym.toLowerCase()}`, sym, usd, { collateral_tags_json: null });

export default {
  COLLATERAL_MODEL: [['model id', ({ COLLATERAL_MODEL: v }) => assert.equal(v, 'morpho-tags-2')]],
  TAG_KIND: [
    ['every entry has a valid kind and a note', ({ TAG_KIND: t }) => {
      for (const [tag, v] of Object.entries(t)) { assert.ok(['base', 'neutral', 'special'].includes(v.kind), tag); assert.ok(v.note, tag); }
      assert.equal(t.rwa.kind, 'special'); assert.equal(t.yield.kind, 'neutral'); assert.equal(t.eth.kind, 'base');
    }],
  ],
  tokenState: [
    ['wstETH [yield,lst,eth] is base', ({ tokenState: f }) => assert.deepEqual(f(['yield', 'lst', 'eth']), { state: 'base', reason: null })],
    ['only [yield] is unclassified: no base tag', ({ tokenState: f }) => assert.deepEqual(f(['yield']), { state: 'unclassified', reason: 'no base tag' })],
    ['USDe [stablecoin,usd-pegged,rwa] is special', ({ tokenState: f }) => assert.equal(f(['stablecoin', 'usd-pegged', 'rwa']).state, 'special')],
    ['[] and null are untagged', ({ tokenState: f }) => {
      assert.deepEqual(f([]), { state: 'unclassified', reason: 'untagged' }); assert.deepEqual(f(null), { state: 'unclassified', reason: 'untagged' });
    }],
    ['unknown tag is unlisted, unless a special tag decides first', ({ tokenState: f }) => {
      assert.deepEqual(f(['foo', 'eth']), { state: 'unclassified', reason: 'unlisted:foo' });
      assert.equal(f(['foo', 'rwa']).state, 'special');
    }],
  ],
  parseTagsJson: [
    ['an array is returned; null, the string null, objects and garbage give null', ({ parseTagsJson: f }) => {
      assert.deepEqual(f('["eth","lst"]'), ['eth', 'lst']);
      for (const v of [null, undefined, 'null', '{"a":1}', '{', '']) assert.equal(f(v), null);
    }],
  ],
  tagKindMarkdown: [
    ['README contains the generated table', ({ tagKindMarkdown: f }) => {
      const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      assert.ok(readme.includes(f()));
    }],
    ['one row per tag plus a two-line header', ({ tagKindMarkdown: f, TAG_KIND: t }) => {
      const lines = f().split('\n');
      assert.equal(lines.length, Object.keys(t).length + 2); assert.ok(lines.some(l => l.startsWith('| `rwa` | special')));
    }],
  ],
  calculateTagMix: [
    ['three baskets and overlapping tag shares', ({ calculateTagMix: f }) => {
      const t = (sym, usd, tags) => tok(`0x${sym}`, sym, usd, { collateral_tags_json: JSON.stringify(tags) });
      const r = f(vault({ total_assets_usd: 100e6 }), [
        t('a', 40e6, ['eth', 'lst']), t('b', 30e6, ['stablecoin', 'usd-pegged', 'rwa']), t('c', 10e6, ['eth', 'rwa']), t('d', 20e6, ['yield'])
      ]);
      assert.equal(r.tier, 'CLASSIFIED');
      assert.deepEqual([r.basePercent, r.specialPercent, r.unclassifiedPercent], [40, 40, 20]);
      assert.deepEqual(r.tags.map(x => [x.tag, x.percent]), [['eth', 50], ['rwa', 40], ['stablecoin', 30], ['usd-pegged', 30]]);
      assert.equal(r.tokens[0].symbol, 'a'); assert.equal(r.tokens.find(x => x.symbol === 'd').reason, 'no base tag');
    }],
    ['idle markets are separate, untagged tokens are unclassified, bad JSON is untagged', ({ calculateTagMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6 }), [idle({ supply_assets_usd: 50e6 }), unknown(30e6), tok('0xbad', 'BAD', 20e6, { collateral_tags_json: '{' })]);
      assert.equal(r.idlePercent, 50); assert.equal(r.unclassifiedPercent, 50); assert.equal(r.tokens[0].reason, 'untagged');
    }],
    ['tiers: no capital is UNKNOWN, only idle is UNALLOCATED', ({ calculateTagMix: f }) => {
      assert.equal(f(vault({ total_assets_usd: 0 }), []).tier, 'UNKNOWN');
      assert.equal(f(vault({ total_assets_usd: 10e6 }), [idle({ supply_assets_usd: 10e6 })]).tier, 'UNALLOCATED');
    }],
    ['unverified capital leaves the percent base', ({ calculateTagMix: f }) => {
      const r = f(vault({ total_assets_usd: 100e6, unresolved_exposure_usd: 50e6 }), [tok('0xe', 'E', 50e6, { collateral_tags_json: '["eth"]' })]);
      assert.equal(r.unverifiedPercent, 50); assert.equal(r.basePercent, 100);
    }],
  ],
};
