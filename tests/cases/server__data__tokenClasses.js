import assert from 'node:assert/strict';

const CATEGORIES = ['native_or_wrapped', 'stablecoin', 'pendle_pt', 'real_world_asset', 'vault_or_lp_share', 'other_crypto'];

export default {
  TOKEN_CLASSES: [['every key is "chainId:lower-case address", every record has a known category and confidence, and subtype is a string or null', ({ TOKEN_CLASSES: m }) => {
    assert.ok(m.size > 300);
    for (const [k, v] of m) {
      assert.match(k, /^\d+:0x[0-9a-f]{40}$/, k);
      assert.ok(CATEGORIES.includes(v.category), `${k} ${v.category}`);
      assert.ok(['high', 'medium', 'low'].includes(v.confidence), `${k} ${v.confidence}`);
      assert.ok(v.subtype === null || typeof v.subtype === 'string', k);
    }
  }]]
};
