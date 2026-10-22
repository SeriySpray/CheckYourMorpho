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
    ['cap V2 relative: частки у відсотках, скільки додає, коли набуде чинності і що ще можна вийти', ({ formatUrgent }) => {
      const e = ev('pending_cap_increase', { row: { title: 'Pending cap increase (IncreaseRelativeCap)' }, details: { capKind: 'relative', oldCap: 0.1, newCap: 0.25, tvlShareAdded: 0.15 } });
      const m = formatUrgent(e, 'Alpha USDC', NOW);
      assert.equal(m, [
        '<b>WARNING</b>  |  Alpha USDC\n<code>0x1111...1111</code>',
        '<b>Pending cap increase (IncreaseRelativeCap)</b>\nCap: 10% to 25%, adds 15% of vault assets',
        `<b>Takes effect</b> ${new Date((NOW + 7200) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC (in 2h)\nDepositors can still withdraw until then.`
      ].join('\n\n'));
    }],
    ['cap absolute без старого значення: none, компактні числа', ({ formatUrgent }) => {
      const m = formatUrgent(ev('pending_cap_increase', { details: { capKind: 'absolute', oldCap: null, newCap: 2_500_000, tvlShareAdded: 0.2 } }), null, NOW);
      assert.match(m, /^<b>WARNING<\/b>  \|  Vault\n<code>0x1111\.\.\.1111<\/code>/);
      assert.match(m, /Cap: none to 2\.5M, adds 20% of vault assets/);
    }],
    ['timelock, bad debt, відтік TVL; не pending-події без рядка про набуття чинності', ({ formatUrgent }) => {
      assert.match(formatUrgent(ev('pending_timelock_change', { row: { severity: 'critical' }, details: { oldTimelock: 172800, newTimelock: 3600 } }), 'V', NOW), /^<b>CRITICAL<\/b>.*\nTimelock: 2d to 1h/s);
      const bd = formatUrgent(ev('bad_debt_appeared', { row: { status: 'final', severity: 'critical', valid_at: null }, details: { badDebtUsd: 12_000, supplyUsd: 3_400_000 } }), 'V', NOW);
      assert.match(bd, /Bad debt: \$12\.0K in a market holding \$3\.4M of the vault/);
      assert.ok(!bd.includes('Takes effect'));
      assert.match(formatUrgent(ev('tvl_drop', { row: { status: 'final', valid_at: null }, details: { previousTvlUsd: 10_000_000, currentTvlUsd: 7_000_000 } }), 'V', NOW), /TVL: \$10\.0M to \$7\.0M/);
    }],
    ['timelock уже минув: повідомляє, що змінити можна будь-коли', ({ formatUrgent }) => {
      const m = formatUrgent(ev('pending_market_removal', { row: { valid_at: NOW - 5 } }), 'V', NOW);
      assert.match(m, /<b>The timelock has passed\.<\/b> The change can be applied at any moment\./);
    }],
  ],
  formatUrgentGroup: [
    ['одна подія - звичайний текст; кілька - один заголовок з найвищою серйозністю, рядки з деталями і найближчий дедлайн', ({ formatUrgentGroup, formatUrgent }) => {
      const one = ev('pending_cap_increase', { details: { capKind: 'relative', oldCap: null, newCap: 0.5, tvlShareAdded: 0.5 } });
      assert.equal(formatUrgentGroup([one], 'Alpha', NOW), formatUrgent(one, 'Alpha', NOW));
      const a = ev('pending_cap_increase', { row: { title: 'Pending relative cap increase for cbBTC collateral', valid_at: NOW + 7200 }, details: { capKind: 'relative', oldCap: null, newCap: 0.5, tvlShareAdded: 0.5 } });
      const b = ev('pending_cap_increase', { row: { title: 'Pending absolute cap increase for cbBTC/USDC', severity: 'critical', valid_at: NOW + 3600 }, details: { capKind: 'absolute', oldCap: null, newCap: 5_000_000, tvlShareAdded: 0.56 } });
      const m = formatUrgentGroup([a, b], 'Alpha', NOW);
      assert.equal(m.split('\n')[0], '<b>CRITICAL</b>  |  Alpha');
      assert.match(m, /\n2 changes at once\n/);
      assert.match(m, /<b>Pending relative cap increase for cbBTC collateral<\/b>\nCap: none to 50%, adds 50% of vault assets/);
      assert.match(m, /<b>Pending absolute cap increase for cbBTC\/USDC<\/b>\nCap: none to 5\.0M, adds 56% of vault assets/);
      assert.ok(m.includes(`<b>Takes effect</b> ${new Date((NOW + 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC (in 1h)`));
    }],
    ['понад 6 подій: показано 6 і "and N more"; без pending-подій немає рядка про дедлайн', ({ formatUrgentGroup }) => {
      const many = Array.from({ length: 9 }, (_, i) => ev('tvl_drop', { row: { status: 'final', valid_at: null, title: `Drop ${i}` }, details: { previousTvlUsd: 2e6, currentTvlUsd: 1e6 } }));
      const m = formatUrgentGroup(many, null, NOW);
      assert.equal(m.match(/^<b>Drop/gm).length, 6);
      assert.match(m, /\nand 3 more/);
      assert.ok(!m.includes('Takes effect'));
    }],
  ],
};
