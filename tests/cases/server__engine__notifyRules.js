import assert from 'node:assert/strict';

const NOW = 1_750_000_000;
const ADDR = '0x1111111111111111111111111111111111111111';
const ev = (kind, o = {}) => ({
  vault_address: ADDR, kind, severity: 'warning', status: 'pending', title: 'Title', valid_at: NOW + 7200,
  details_json: JSON.stringify(o.details ?? {}), ...o.row
});

export default {
  isUrgent: [
    ['cap: приріст >= 5% активів або cap був 0 - так; 4.9% - ні; пусті деталі - ні', ({ isUrgent }) => {
      assert.equal(isUrgent(ev('pending_cap_increase', { details: { tvlShareAdded: 0.05 } })), true);
      assert.equal(isUrgent(ev('pending_cap_increase', { details: { tvlShareAdded: 0.049 } })), false);
      assert.equal(isUrgent(ev('pending_cap_increase', { details: { tvlShareAdded: 0.001, capWasZero: true } })), true);
      assert.equal(isUrgent(ev('pending_cap_increase', { details: {} })), false);
    }],
    ['pending-події лише у статусі pending: applied і revoked не надсилаються', ({ isUrgent }) => {
      for (const kind of ['pending_cap_increase', 'pending_market_removal', 'pending_guardian_change']) {
        assert.equal(isUrgent(ev(kind, { details: { capWasZero: true }, row: { status: 'pending' } })), true, kind);
        assert.equal(isUrgent(ev(kind, { details: { capWasZero: true }, row: { status: 'applied' } })), false, kind);
        assert.equal(isUrgent(ev(kind, { details: { capWasZero: true }, row: { status: 'revoked' } })), false, kind);
      }
    }],
    ['timelock: лише critical (скорочення або нуль); збільшення - ні', ({ isUrgent }) => {
      assert.equal(isUrgent(ev('pending_timelock_change', { row: { severity: 'critical' } })), true);
      assert.equal(isUrgent(ev('pending_timelock_change', { row: { severity: 'warning' } })), false);
    }],
    ['bad debt і відтік TVL - завжди; усе інше з узгодженого списку "не надсилати" - ні', ({ isUrgent }) => {
      assert.equal(isUrgent(ev('bad_debt_appeared', { row: { status: 'final' } })), true);
      assert.equal(isUrgent(ev('tvl_drop', { row: { status: 'final' } })), true);
      for (const kind of ['owner_changed', 'allocator_changed', 'skim_recipient_changed', 'curator_changed', 'reallocation', 'supply_queue_changed',
        'verdict_worsened', 'exit_liquidity_low', 'pending_fee_change', 'vault_delisted', 'cap_changed']) {
        assert.equal(isUrgent(ev(kind, { row: { status: 'final', severity: 'critical' } })), false, kind);
      }
    }],
    ['V2: gate, adapter, abdicate, penalty - у статусі pending; fee лише critical (підвищення більш ніж на 5 пунктів)', ({ isUrgent }) => {
      for (const kind of ['pending_gate_change', 'pending_adapter_change', 'pending_abdicate', 'pending_force_deallocate_penalty']) {
        assert.equal(isUrgent(ev(kind, { row: { status: 'pending' } })), true, kind);
        assert.equal(isUrgent(ev(kind, { row: { status: 'applied' } })), false, kind);
      }
      assert.equal(isUrgent(ev('pending_fee_change', { row: { status: 'pending', severity: 'critical' } })), true);
      assert.equal(isUrgent(ev('pending_fee_change', { row: { status: 'pending', severity: 'warning' } })), false);
    }],
    ['приймає розібрані details і не падає на битому JSON або null', ({ isUrgent }) => {
      assert.equal(isUrgent({ kind: 'pending_cap_increase', status: 'pending', details: { capWasZero: true } }), true);
      assert.equal(isUrgent({ kind: 'pending_cap_increase', status: 'pending', details_json: '{broken' }), false);
      assert.equal(isUrgent(null), false);
    }],
  ],
  escapeHtml: [
    ['екранує &, < і >, null/undefined дають порожній рядок', ({ escapeHtml }) => {
      assert.equal(escapeHtml('A & B <b>x</b>'), 'A &amp; B &lt;b&gt;x&lt;/b&gt;');
      assert.equal(escapeHtml(null), ''); assert.equal(escapeHtml(undefined), '');
    }],
    ['назва vault у повідомленні екранується, щоб розмітка не ламалась', ({ formatUrgent }) => {
      const m = formatUrgent(ev('bad_debt_appeared', { row: { status: 'final', valid_at: null }, details: { badDebtUsd: 1, supplyUsd: 2 } }), 'A <i>&</i> B', NOW);
      assert.ok(m.includes('A &lt;i&gt;&amp;&lt;/i&gt; B'));
    }],
  ],
  formatUrgent: [
    ['cap V2 relative: заголовок з типу, vault, сума, пояснення, серйозність і час набуття чинності за Києвом', ({ formatUrgent, kyivTime }) => {
      const e = ev('pending_cap_increase', { row: { title: 'Pending cap increase (IncreaseRelativeCap)', chain_id: 8453 }, details: { capKind: 'relative', oldCap: 0.1, newCap: 0.25, tvlShareAdded: 0.15 } });
      const m = formatUrgent(e, 'Alpha USDC', NOW);
      assert.equal(m, [
        '<b>Cap increase pending</b>',
        '<b>Alpha USDC</b>  |  Base\n<code>0x1111...1111</code>',
        'Cap: from 10% to 25% of vault assets\nThe curator is raising how much the vault may put into this market. Once applied, more deposits can flow there.\nSeverity: Warning',
        `<b>Takes effect</b> ${kyivTime(NOW + 7200)} Kyiv time (in 2h).`
      ].join('\n\n'));
    }],
    ['час набуття чинності: замість обіцянки "можна вивести" - скільки можна вивести зараз; без даних про вихід рядка немає; нижче 20% додається пояснення', ({ formatUrgent }) => {
      const withExit = percentValue => formatUrgent(ev('pending_gate_change', { details: { gate: ADDR, exitPercent: percentValue, exitUsd: 61_500_000 } }), 'V', NOW);
      assert.match(withExit(11.5), /Withdrawable right now: 11\.5% of the vault \(\$61\.5M\)\. Most of it is lent out\./);
      assert.match(withExit(45), /Withdrawable right now: 45% of the vault \(\$61\.5M\)\.$/);
      assert.doesNotMatch(formatUrgent(ev('pending_gate_change', { details: { gate: ADDR } }), 'V', NOW), /Withdrawable/);
      assert.doesNotMatch(withExit(11.5), /can still withdraw/);
    }],
    ['V2-зміни: заголовок, зміст і рядок про що саме', ({ formatUrgent }) => {
      const gate = formatUrgent(ev('pending_gate_change', { details: { gate: ADDR } }), 'V', NOW);
      assert.match(gate, /^<b>Gate change pending<\/b>/);
      assert.match(gate, /New gate: 0x1111\.\.\.1111/);
      assert.match(formatUrgent(ev('pending_abdicate', { details: { targetFunction: 'setCurator' } }), 'V', NOW), /Gives up: setCurator[\s\S]*cannot be undone/);
      assert.match(formatUrgent(ev('pending_force_deallocate_penalty', { details: { penalty: 0.02 } }), 'V', NOW), /Penalty: 2%/);
      assert.match(formatUrgent(ev('pending_fee_change', { details: { oldFee: 0.1, newFee: 0.3 } }), 'V', NOW), /Fee: 10% to 30%/);
      assert.match(formatUrgent(ev('pending_adapter_change', { details: { functionName: 'AddAdapter', adapterAddress: ADDR } }), 'V', NOW), /Add Adapter: 0x1111\.\.\.1111/);
    }],
    ['cap absolute без старого значення: none, компактні числа; cap без ліміту читається як unlimited', ({ formatUrgent }) => {
      const m = formatUrgent(ev('pending_cap_increase', { details: { capKind: 'absolute', oldCap: null, newCap: 2_500_000, tvlShareAdded: 0.2 } }), null, NOW);
      assert.match(m, /^<b>Cap increase pending<\/b>\n\n<b>Vault<\/b>\n<code>0x1111\.\.\.1111<\/code>/);
      assert.match(m, /Cap: from not set to 2\.5M, adds 20% of vault assets/);
      const open = formatUrgent(ev('pending_cap_increase', { details: { capKind: 'absolute', oldCap: null, newCap: 3.4e32, tvlShareAdded: 9e23 } }), 'V', NOW);
      assert.match(open, /Cap: from not set to unlimited, adds over 1000% of vault assets/);
    }],
    ['timelock, bad debt, відтік TVL; не pending-події без рядка про набуття чинності', ({ formatUrgent }) => {
      const tl = formatUrgent(ev('pending_timelock_change', { row: { severity: 'critical' }, details: { oldTimelock: 172800, newTimelock: 3600 } }), 'V', NOW);
      assert.match(tl, /^<b>Timelock change pending<\/b>[\s\S]*\nTimelock: 2d to 1h\n[\s\S]*Severity: Critical/);
      const bd = formatUrgent(ev('bad_debt_appeared', { row: { status: 'final', severity: 'critical', valid_at: null }, details: { badDebtUsd: 12_000, supplyUsd: 3_400_000 } }), 'V', NOW);
      assert.match(bd, /^<b>Bad debt appeared<\/b>/);
      assert.match(bd, /Bad debt: \$12K in a market holding \$3\.4M of the vault/);
      assert.ok(!bd.includes('Takes effect'));
      const tvl = formatUrgent(ev('tvl_drop', { row: { status: 'final', valid_at: null }, details: { previousTvlUsd: 10_000_000, currentTvlUsd: 7_000_000 } }), 'V', NOW);
      assert.match(tvl, /^<b>Large TVL outflow<\/b>/);
      assert.match(tvl, /TVL: \$10M to \$7M/);
    }],
    ['невідомий тип лишає заголовок події; timelock уже минув: повідомляє, що змінити можна будь-коли', ({ formatUrgent }) => {
      assert.match(formatUrgent(ev('pending_unknown_kind', { row: { title: 'Stored title' } }), 'V', NOW), /^<b>Stored title<\/b>/);
      const m = formatUrgent(ev('pending_market_removal', { row: { valid_at: NOW - 5 } }), 'V', NOW);
      assert.match(m, /<b>The timelock has passed\.<\/b> The change can be applied at any moment\./);
    }],
  ],
  formatUrgentGroup: [
    ['одна подія - звичайний текст; кілька - один заголовок з кількістю, рядки з деталями, найвища серйозність і найближчий дедлайн', ({ formatUrgentGroup, formatUrgent, kyivTime }) => {
      const one = ev('pending_cap_increase', { details: { capKind: 'relative', oldCap: null, newCap: 0.5, tvlShareAdded: 0.5 } });
      assert.equal(formatUrgentGroup([one], 'Alpha', NOW), formatUrgent(one, 'Alpha', NOW));
      const a = ev('pending_cap_increase', { row: { title: 'Pending relative cap increase for cbBTC collateral', valid_at: NOW + 7200 }, details: { capKind: 'relative', oldCap: null, newCap: 0.5, tvlShareAdded: 0.5 } });
      const b = ev('pending_cap_increase', { row: { title: 'Pending absolute cap increase for cbBTC/USDC', severity: 'critical', valid_at: NOW + 3600 }, details: { capKind: 'absolute', oldCap: null, newCap: 5_000_000, tvlShareAdded: 0.56 } });
      const m = formatUrgentGroup([a, b], 'Alpha', NOW);
      assert.equal(m.split('\n')[0], '<b>Cap increase pending (2 changes)</b>');
      assert.match(m, /<b>Relative cap increase for cbBTC collateral<\/b>\nCap: from not set to 50% of vault assets/);
      assert.match(m, /<b>Absolute cap increase for cbBTC\/USDC<\/b>\nCap: from not set to 5M, adds 56% of vault assets/);
      assert.match(m, /Severity: Critical/);
      assert.ok(m.includes(`<b>Takes effect</b> ${kyivTime(NOW + 3600)} Kyiv time (in 1h)`));
    }],
    ['понад 6 подій: показано 6 і "and N more"; без pending-подій немає рядка про дедлайн', ({ formatUrgentGroup }) => {
      const many = Array.from({ length: 9 }, (_, i) => ev('tvl_drop', { row: { status: 'final', valid_at: null, title: `Drop ${i}` }, details: { previousTvlUsd: 2e6, currentTvlUsd: 1e6 } }));
      const m = formatUrgentGroup(many, null, NOW);
      assert.equal(m.match(/^<b>Drop/gm).length, 6);
      assert.match(m, /\nand 3 more/);
      assert.ok(!m.includes('Takes effect'));
    }],
  ],
  chainName: [
    ['відомі мережі за id, невідома - null', ({ chainName }) => {
      assert.equal(chainName(1), 'Ethereum');
      assert.equal(chainName(8453), 'Base');
      assert.equal(chainName(999999), null);
    }],
  ],
  shortAddr: [
    ['перші 6 і останні 4 символи', ({ shortAddr }) => { assert.equal(shortAddr(ADDR), '0x1111...1111'); }],
  ],
  message: [
    ['жирний заголовок, абзаци через порожній рядок, порожні блоки пропускаються, заголовок екранується', ({ message }) => {
      assert.equal(message('T', 'a', null, false, 'b'), '<b>T</b>\n\na\n\nb');
      assert.equal(message('A & <B>'), '<b>A &amp; &lt;B&gt;</b>');
    }],
  ],
  vaultBlock: [
    ['назва, мережа через риску, скорочена адреса; без мережі і без імені', ({ vaultBlock }) => {
      assert.equal(vaultBlock('Alpha', 8453, ADDR), '<b>Alpha</b>  |  Base\n<code>0x1111...1111</code>');
      assert.equal(vaultBlock(null, null, ADDR), '<b>Vault</b>\n<code>0x1111...1111</code>');
      assert.ok(vaultBlock('A <i>&</i>', 1, ADDR).startsWith('<b>A &lt;i&gt;&amp;&lt;/i&gt;</b>'));
    }],
  ],
  kyivTime: [
    ['зимовий і літній час Києва', ({ kyivTime }) => {
      assert.equal(kyivTime(Date.UTC(2026, 0, 15, 7, 0) / 1000), '2026-01-15 09:00');
      assert.equal(kyivTime(Date.UTC(2026, 6, 15, 6, 0) / 1000), '2026-07-15 09:00');
      assert.equal(kyivTime(Date.UTC(2026, 0, 15, 22, 30) / 1000), '2026-01-16 00:30');
    }],
  ],
  paginate: [
    ['короткий список - одне повідомлення; довгий ділиться, кожна частина з заголовком, блок не розривається', ({ paginate }) => {
      assert.deepEqual(paginate('H', ['a', 'b']), ['H\n\na\n\nb']);
      const blocks = Array.from({ length: 80 }, (_, i) => `block ${i} ${'x'.repeat(100)}`);
      const parts = paginate('H', blocks);
      assert.ok(parts.length > 1);
      for (const part of parts) { assert.ok(part.length <= 4096); assert.ok(part.startsWith('H\n\n')); }
      assert.equal(parts.join('\n').match(/block \d+ /g).length, 80);
    }],
  ],
  groupChanges: [
    ['зміни однієї транзакції і типу - одна зміна; різні транзакції і vault-и окремо', ({ groupChanges }) => {
      const d = tx => ({ details: { txHash: tx } });
      const events = [
        ev('pending_cap_increase', { ...d('0xaa'), row: { id: 1 } }), ev('pending_cap_increase', { ...d('0xaa'), row: { id: 2 } }),
        ev('pending_cap_increase', { ...d('0xbb'), row: { id: 3 } }), ev('pending_cap_increase', { ...d('0xaa'), row: { id: 4, vault_address: '0x2222222222222222222222222222222222222222' } })
      ];
      const g = groupChanges(events);
      assert.equal(g.size, 2);
      assert.deepEqual([...g.get(ADDR).values()].map(x => x.length), [2, 1]);
    }],
  ],
  countChanges: [
    ['скільки змін чекає і скільки з них можна застосувати зараз', ({ countChanges }) => {
      const events = [ev('pending_cap_increase', { row: { id: 1, valid_at: NOW - 10 } }), ev('pending_guardian_change', { row: { id: 2, valid_at: NOW + 10 } }), ev('pending_market_removal', { row: { id: 3, valid_at: NOW + 20 } })];
      assert.deepEqual(countChanges(events, NOW), { total: 3, ready: 1 });
      assert.deepEqual(countChanges([], NOW), { total: 0, ready: 0 });
    }],
  ],
  formatUpcoming: [
    ['без обраних vault-ів: повідомлення, що vault-и не вибрано і змін поки немає', ({ formatUpcoming }) => {
      const m = formatUpcoming([], 0, NOW);
      assert.match(m, /^<b>Upcoming changes<\/b>\n\nNo vaults are selected, so there are no upcoming changes for now\.\n\nStar vaults on the site/);
    }],
    ['порожній список - окреме повідомлення про те, що нічого не чекає', ({ formatUpcoming }) => {
      const m = formatUpcoming([], 3, NOW);
      assert.match(m, /^<b>Upcoming changes<\/b>\n\nNothing is waiting for a timelock in the 3 vaults you follow\./);
    }],
    ['блок на vault: що можна застосувати зараз і що чекає, однакові рядки зливаються з x2, час абсолютний за Києвом', ({ formatUpcoming, kyivTime }) => {
      const tx = h => ({ details: { txHash: h, capWasZero: true } });
      const row = (id, extra) => ({ id, chain_id: 1, vault_name: 'Alpha USDC', ...extra });
      const events = [
        ev('pending_cap_increase', { ...tx('0xaa'), row: row(1, { valid_at: NOW - 86400 }) }),
        ev('pending_cap_increase', { ...tx('0xbb'), row: row(2, { valid_at: NOW - 86400 }) }),
        ev('pending_guardian_change', { row: row(3, { valid_at: NOW + 7200 }) })
      ];
      const m = formatUpcoming(events, 2, NOW);
      assert.match(m, /^<b>Upcoming changes<\/b>\n\n3 pending changes in the 2 vaults you follow\. This message updates itself\./);
      assert.match(m, /<b>Alpha USDC<\/b>  \|  Ethereum\n<code>0x1111\.\.\.1111<\/code>\n<b>Can be applied now<\/b>\n- Cap increase, opens a new cap \(x2\)\n<b>Waiting for the timelock<\/b>\n- Guardian change, takes effect /);
      assert.ok(m.includes(`takes effect ${kyivTime(NOW + 7200)}`));
      assert.ok(!/in \d+h/.test(m)); // no countdowns: the text only changes when the set of changes does
      assert.equal(formatUpcoming(events, 2, NOW), formatUpcoming(events, 2, NOW + 600));
    }],
    ['дуже довгий список обрізається до ліміту з рядком "and N more vaults"', ({ formatUpcoming }) => {
      const events = Array.from({ length: 150 }, (_, i) => ev('pending_guardian_change', {
        row: { id: i + 1, vault_address: `0x${String(i).padStart(40, '0')}`, vault_name: `Vault number ${i}`, valid_at: NOW + 1000 + i }
      }));
      const m = formatUpcoming(events, 150, NOW);
      assert.ok(m.length <= 4096);
      assert.match(m, /\nand \d+ more vaults, see the site\.$/);
    }],
  ],
};
