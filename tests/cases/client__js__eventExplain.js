import assert from 'node:assert/strict';

const NOW = 1_800_000_000;
const vault = { address: '0x1', chainId: 1, asset: { symbol: 'USDC', priceUsd: 1 }, totalAssetsUsd: 10_000_000, liquidityUsd: 2_000_000, apy: 0.05 };

export default {
  usd: [
    ['компактні долари, порожньо для відсутніх значень', ({ usd }) => {
      assert.equal(usd(1_234_000_000), '$1.23B'); assert.equal(usd(2_500_000), '$2.5M'); assert.equal(usd(950), '$950');
      assert.equal(usd(-1500), '-$1.5K'); assert.equal(usd(null), ''); assert.equal(usd('x'), '');
    }]
  ],
  amount: [
    ['кількість токенів у компактному вигляді', ({ amount }) => {
      assert.equal(amount(2_000_000), '2.0M'); assert.equal(amount(0.123), '0.12'); assert.equal(amount('abc'), '');
    }]
  ],
  percent: [
    ['частка або відсоток у рядок', ({ percent }) => {
      assert.equal(percent(0.25), '25%'); assert.equal(percent(37.7, false), '37.7%'); assert.equal(percent(0.003), '0.3%'); assert.equal(percent(null), '');
    }]
  ],
  duration: [
    ['секунди у людську тривалість', ({ duration }) => {
      assert.equal(duration(604800), '7 days'); assert.equal(duration(90000), '1 day 1 hour'); assert.equal(duration(1800), '30 minutes');
      assert.equal(duration(0), 'no delay'); assert.equal(duration(''), '');
    }]
  ],
  formatEventDate: [
    ['дата з роком, порожньо для нуля і сміття', ({ formatEventDate }) => {
      assert.match(formatEventDate(NOW), /2027/); assert.equal(formatEventDate(0), ''); assert.equal(formatEventDate('x'), '');
    }]
  ],
  shortAddress: [
    ['скорочує довгі адреси', ({ shortAddress }) => {
      assert.equal(shortAddress('0x1234567890abcdef1234'), '0x1234...1234'); assert.equal(shortAddress('0x12'), '0x12'); assert.equal(shortAddress(null), '');
    }]
  ],
  has: [
    ['число, включно з нулем; порожні значення і сміття - ні', ({ has }) => {
      assert.equal(has(0), true); assert.equal(has('12.5'), true);
      assert.equal(has(null), false); assert.equal(has(''), false); assert.equal(has('x'), false); assert.equal(has(undefined), false);
    }]
  ],
  isZero: [
    ['нульова або порожня адреса', ({ isZero }) => {
      assert.equal(isZero('0x0000000000000000000000000000000000000000'), true); assert.equal(isZero(null), true); assert.equal(isZero('0x5B71'), false);
    }]
  ],
  roleOf: [
    ['відома функція V2 описується словами, невідома - назвою', ({ roleOf }) => {
      assert.equal(roleOf('setSendAssetsGate'), 'restricting who can deposit'); assert.equal(roleOf('foo'), 'calling foo'); assert.equal(roleOf(null), 'this function');
    }]
  ],
  collateralOf: [
    ['застава з мітки ринку', ({ collateralOf }) => {
      assert.equal(collateralOf('cbBTC/USDC'), 'cbBTC'); assert.equal(collateralOf('wmGLO collateral'), 'wmGLO'); assert.equal(collateralOf(''), '');
    }]
  ],
  explainCap: [
    ['новий ринок: частка від розміру vault, застава і оракул у наслідках', ({ explainCap }) => {
      const x = explainCap({ marketLabel: 'RLP/USDT', oldCap: null, newCap: 2_000_000, tvlShareAdded: 8.017, capWasZero: true }, { sym: 'USDT', price: 1, tvl: 250_000 }, true);
      assert.equal(x.summary, "New exposure: up to 8x the vault's current size can go to RLP/USDT");
      assert.match(x.impact, /^Once executed/); assert.match(x.impact, /RLP and on the oracle/);
    }],
    ['idle-ринок без ліміту: без ризику застави', ({ explainCap }) => {
      const x = explainCap({ marketLabel: 'Idle/EURC', newCap: 2e15 }, { sym: 'EURC', price: 1, tvl: 1 }, true);
      assert.equal(x.summary, 'Limit on idle cash removed'); assert.match(x.impact, /no collateral risk/);
      assert.deepEqual(x.facts[0], { label: 'Supply cap', value: 'No practical limit' });
    }],
    ['відносний ліміт без мітки: ціль розподілу, без вигаданої застави', ({ explainCap }) => {
      const x = explainCap({ capKind: 'relative', newCap: 1, oldCap: null }, { sym: 'USDC', price: 1, tvl: 1 }, true);
      assert.equal(x.summary, "Up to 100% of the vault's deposits can go to one allocation target");
      assert.match(x.impact, /open the vault audit/);
    }],
    ['частка менше одиниці у відсотках, розмір у доларах за ціною активу', ({ explainCap }) => {
      const x = explainCap({ marketLabel: 'cbBTC/USDC', oldCap: 1_000_000, newCap: 3_000_000, tvlShareAdded: 0.2 }, { sym: 'USDC', price: 1, tvl: 10_000_000 }, false);
      assert.equal(x.summary, "Cap on cbBTC/USDC grows by 20% of the vault's current size", 'tvlShareAdded - це приріст, а не весь cap');
      assert.match(x.impact, /3\.0M USDC \(about \$3\.0M\)/); assert.match(x.impact, /^The allocator/); assert.match(x.impact, /more than before/);
    }]
  ],
  explainTimelock: [
    ['зменшення до нуля - зміни миттєво; збільшення - добре для вкладників', ({ explainTimelock }) => {
      const dec = explainTimelock({ functionName: 'DecreaseTimelock', targetFunction: 'setForceDeallocatePenalty', oldTimelock: 259200, newTimelock: 0 }, {}, true);
      assert.equal(dec.summary, 'Changing the emergency exit penalty would take effect instantly, with no warning');
      const inc = explainTimelock({ functionName: 'IncreaseTimelock', targetFunction: 'decreaseTimelock', oldTimelock: 0, newTimelock: 604800 }, {}, true);
      assert.equal(inc.summary, 'More warning before shortening timelocks: 7 days'); assert.match(inc.impact, /good for depositors/);
      const v1 = explainTimelock({ oldTimelock: 86400 * 3, newTimelock: 86400 }, {}, false);
      assert.equal(v1.summary, 'Less warning before risky curator changes: 1 day');
    }]
  ],
  explainGuardian: [
    ['зняття гардіана і новий гардіан', ({ explainGuardian }) => {
      assert.match(explainGuardian({ guardian: null }, {}, true).summary, /No one would be able to veto/);
      const x = explainGuardian({ guardian: '0x5B710010586C1b728B047c3E42473c700eeA4026' }, {}, true);
      assert.equal(x.facts[0].mono, true); assert.match(x.what, /0x5B71\.\.\.4026/);
    }]
  ],
  explainFee: [
    ['отримувач не змінює дохідність; зростання комісії рахує чистий APY', ({ explainFee }) => {
      assert.match(explainFee({ feeRecipient: '0xabc' }, { vault }, false).impact, /stay the same/);
      const x = explainFee({ oldFee: 0.1, newFee: 0.2 }, { vault }, true);
      assert.equal(x.summary, 'Fee rises to 20% of the interest you earn'); assert.match(x.impact, /keep about 4%/);
      assert.equal(explainFee({}, { vault }, true), null);
    }]
  ],
  explainAllocator: [
    ['додано або знято алокатора', ({ explainAllocator }) => {
      assert.match(explainAllocator({ allocator: '0xabc', isAllocator: true }, {}, false).summary, /can move deposits/);
      assert.match(explainAllocator({ allocator: '0xabc', isAllocator: false }, {}, false).summary, /loses the right/);
    }]
  ],
  describeTiming: [
    ['pending у майбутньому, прострочений, applied, revoked, final', ({ describeTiming }) => {
      assert.match(describeTiming({ status: 'pending', valid_at: NOW + 3600 }, NOW), /in 1 hour/);
      assert.match(describeTiming({ status: 'pending', valid_at: NOW - 10 }, NOW), /executed at any moment/);
      assert.match(describeTiming({ status: 'applied' }, NOW), /in effect/);
      assert.match(describeTiming({ status: 'revoked' }, NOW), /Nothing changed/);
      assert.equal(describeTiming({ status: 'final' }, NOW), '');
      assert.equal(describeTiming(null, NOW), '');
    }]
  ],
  explainEvent: [
    ['відтік TVL: сума, ліквідність зараз; невідомий тип - заголовок; зламані details не падають', ({ explainEvent }) => {
      const x = explainEvent({ kind: 'tvl_drop', status: 'final', details: { previousTvlUsd: 10_000_000, currentTvlUsd: 6_000_000, dropPercent: 40 } }, vault, NOW);
      assert.equal(x.summary, '$4.0M left the vault in 24 hours'); assert.match(x.impact, /\$2\.0M \(20% of the vault\)/);
      const unknown = explainEvent({ kind: 'something_new', title: 'Raw title', details: {} }, null, NOW);
      assert.deepEqual([unknown.summary, unknown.what, unknown.impact], ['', 'Raw title', '']);
      const broken = explainEvent({ kind: 'reallocation', title: 'T', details: { movements: 'oops' } }, null, NOW);
      assert.deepEqual(broken.movements, []);
      assert.ok(explainEvent({ kind: 'bad_debt_appeared', title: 'T', details: null }, null, NOW).what.length > 0);
    }],
    ['текст іде за статусом: pending - "Once executed", applied - минулий час, revoked - скасовано без наслідків', ({ explainEvent }) => {
      const ev = status => ({ kind: 'pending_cap_increase', status, title: 'T', valid_at: NOW + 60, details: { marketLabel: 'cbBTC/USDC', oldCap: null, newCap: 1_000_000, capWasZero: true } });
      const pending = explainEvent(ev('pending'), vault, NOW);
      assert.match(pending.impact, /^Once executed/); assert.match(pending.what, /submitted/);
      const applied = explainEvent(ev('applied'), vault, NOW);
      assert.match(applied.impact, /^The allocator/); assert.match(applied.what, /The curator set/); assert.match(applied.timing, /in effect/);
      const revoked = explainEvent({ ...ev('revoked'), kind: 'pending_market_removal' }, vault, NOW);
      assert.match(revoked.summary, /^Cancelled: cbBTC\/USDC leaves the vault/);
      assert.equal(revoked.impact, 'It never took effect, so nothing changed for depositors.');
    }],
    ['усі типи з бази без потрібних полів не друкують порожніх місць, undefined чи NaN', ({ explainEvent }) => {
      const kinds = ['pending_cap_increase', 'cap_changed', 'pending_market_removal', 'market_removal_revoked', 'cap_revoked', 'pending_timelock_change',
        'timelock_changed', 'pending_guardian_change', 'guardian_changed', 'curator_changed', 'owner_changed', 'skim_recipient_changed', 'skim',
        'pending_adapter_change', 'pending_gate_change', 'pending_force_deallocate_penalty', 'pending_abdicate', 'verdict_worsened', 'verdict_improved',
        'mqi_dropped', 'bad_debt_appeared', 'flagged_collateral_added', 'tvl_drop', 'exit_liquidity_low', 'vault_delisted',
        'collateral_class_share_crossed', 'reallocation', 'supply_queue_changed', 'withdraw_queue_changed', 'pending_allocator_change', 'allocator_changed'];
      // Without the fields a kind needs, it must fall back to the title rather than print empty slots
      for (const kind of kinds) {
        for (const details of [{}, { marketLabel: 'A/B', newCap: 0, newTimelock: 0 }]) {
          const x = explainEvent({ kind, title: 'T', status: 'final', details }, vault, NOW);
          const text = `${x.summary} | ${x.what} | ${x.impact}`;
          assert.ok(x.what, kind);
          assert.ok(!/undefined|NaN|null|\$ |  |\(-%\)|from  to/.test(text), `${kind}: ${text}`);
        }
      }
    }]
  ]
};
