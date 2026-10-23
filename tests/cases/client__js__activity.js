import assert from 'node:assert/strict';
import { makeElement, makeClassList } from '../clientEnv.js';
import { jsonResponse, withFetch } from '../fixtures.js';

// Setup fake DOM helper for activity tests
function setupFakeDom(m) {
  const elements = globalThis.__cymClientEnv.elements;
  for (const el of elements.values()) {
    el.classList = makeClassList();
    el.dataset = {};
    el.textContent = '';
    el.innerHTML = '';
    el.value = '';
    el.title = '';
    el.className = '';
    el.hidden = false;
  }

  const getOrMake = (id, tag = 'div') => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement(tag);
      el.id = id;
      elements.set(id, el);
    }
    return el;
  };

  const btn = getOrMake('explorer-activity-btn', 'button');
  const badge = getOrMake('explorer-activity-badge', 'span');
  const panel = getOrMake('activity-panel', 'div');
  const heading = getOrMake('explorer-heading', 'h3');
  const list = getOrMake('activity-events-list', 'ul');
  const container = getOrMake('activity-list-container', 'div');
  const upcomingCount = getOrMake('activity-upcoming-count', 'span');
  const scopeFav = getOrMake('activity-scope-fav', 'button');
  const scopeAll = getOrMake('activity-scope-all', 'button');
  const tabUpcoming = getOrMake('activity-tab-upcoming', 'button');
  const tabHistory = getOrMake('activity-tab-history', 'button');
  const updatedAt = getOrMake('activity-updated-at', 'span');
  const reallocCb = getOrMake('activity-show-realloc-cb', 'input');
  const closeBtn = getOrMake('activity-close-btn', 'button');

  const searchBox = getOrMake('explorer-search-box', 'div');
  const filtersGrid = getOrMake('explorer-filters-grid', 'div');
  const chips = getOrMake('active-filter-chips', 'div');
  const vaultsList = getOrMake('explorer-vaults-list', 'ul');

  heading.textContent = 'Vaults Explorer';
  badge.classList.add('hidden');
  panel.classList.add('hidden');

  document.querySelector = (sel) => {
    if (sel === '.explorer-heading') return heading;
    if (sel === '.explorer-search-box') return searchBox;
    if (sel === '.explorer-filters-grid') return filtersGrid;
    return makeElement();
  };

  return {
    btn, badge, panel, heading, explorerHeading: heading, list, container, upcomingCount,
    scopeFav, scopeAll, tabUpcoming, tabHistory, updatedAt,
    reallocCb, closeBtn,
    searchBox, explorerSearchBox: searchBox,
    filtersGrid, explorerFiltersGrid: filtersGrid,
    chips, activeFilterChips: chips,
    vaultsList, explorerVaultsList: vaultsList
  };
}

export default {
  formatCountdown: [
    ['countdown edges: 59s, 60s, 59min, 23h59m, 3d, 1d 14h, exactly now, negative', ({ formatCountdown }) => {
      const now = 1_700_000_000;
      assert.equal(formatCountdown(now + 59, now), 'in 59s');
      assert.equal(formatCountdown(now + 60, now), 'in 1m');
      assert.equal(formatCountdown(now + 59 * 60, now), 'in 59m');
      assert.equal(formatCountdown(now + 23 * 3600 + 59 * 60, now), 'in 23h 59m');
      assert.equal(formatCountdown(now + 3 * 86400, now), 'in 3d');
      assert.equal(formatCountdown(now + 86400 + 14 * 3600, now), 'in 1d 14h');
      assert.equal(formatCountdown(now, now), 'executable now');
      assert.equal(formatCountdown(now - 10, now), 'executable now');
      assert.equal(formatCountdown(now - 3600, now), 'executable now');
    }],
    ['повертає порожній рядок для порожнього або невалідного valid_at', ({ formatCountdown }) => {
      assert.equal(formatCountdown(null), '');
      assert.equal(formatCountdown(undefined), '');
      assert.equal(formatCountdown(''), '');
    }]
  ],

  formatActiveTime: [
    ['форматує дату у вигляді Active 21 Oct 08:12', ({ formatActiveTime }) => {
      // 1729506720 UTC = Mon Oct 21 2024 07:52 or similar; check format
      const ts = 1729507920;
      const res = formatActiveTime(ts);
      assert.ok(res.startsWith('Active '));
      const parts = res.split(' ');
      assert.equal(parts.length, 4);
      assert.equal(parts[0], 'Active');
      assert.ok(parts[2].length === 3); // Month name e.g. Oct
      assert.ok(parts[3].includes(':')); // Time HH:MM
    }],
    ['повертає порожній рядок на невалідні мітки', ({ formatActiveTime }) => {
      assert.equal(formatActiveTime(null), '');
      assert.equal(formatActiveTime(undefined), '');
      assert.equal(formatActiveTime('invalid'), '');
    }]
  ],

  formatRelativeTime: [
    ['відносний час: секунди, хвилини, години, дні', ({ formatRelativeTime }) => {
      const now = 1_700_000_000;
      assert.equal(formatRelativeTime(now - 30, now), '30s ago');
      assert.equal(formatRelativeTime(now - 120, now), '2m ago');
      assert.equal(formatRelativeTime(now - 3 * 3600, now), '3h ago');
      assert.equal(formatRelativeTime(now - 2 * 86400, now), '2d ago');
    }],
    ['порожній ввід', ({ formatRelativeTime }) => {
      assert.equal(formatRelativeTime(null), '');
      assert.equal(formatRelativeTime(''), '');
    }]
  ],

  formatFullDateTime: [
    ['форматує повну дату для title', ({ formatFullDateTime }) => {
      const res = formatFullDateTime(1_700_000_000);
      assert.ok(typeof res === 'string');
      assert.ok(res.length > 0);
      assert.equal(formatFullDateTime(null), '');
      assert.equal(formatFullDateTime(''), '');
    }]
  ],

  isZeroAddress: [
    ['розпізнає порожні, null та нульові адреси', ({ isZeroAddress }) => {
      assert.equal(isZeroAddress('0x0000000000000000000000000000000000000000'), true);
      assert.equal(isZeroAddress('0x0'), true);
      assert.equal(isZeroAddress(''), true);
      assert.equal(isZeroAddress(null), true);
      assert.equal(isZeroAddress(undefined), true);
      assert.equal(isZeroAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'), false);
    }]
  ],

  formatAddress: [
    ['форматує довгу адресу або marketId у вигляд 0xaa80...8281', ({ formatAddress }) => {
      assert.equal(formatAddress('0xaa80145be93ccfb0ebc25d8b7ea87588b3f78281'), '0xaa80...8281');
      assert.equal(formatAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'), '0x7099...79C8');
      assert.equal(formatAddress('0x123'), '0x123');
      assert.equal(formatAddress(''), '');
      assert.equal(formatAddress(null), '');
    }]
  ],

  formatCompactNumber: [
    ['компактні числа: M, B, K, десяткові та нуль', ({ formatCompactNumber }) => {
      assert.equal(formatCompactNumber(1000000), '1.0M');
      assert.equal(formatCompactNumber(10000000), '10.0M');
      assert.equal(formatCompactNumber(1500000), '1.5M');
      assert.equal(formatCompactNumber(2500000000), '2.5B');
      assert.equal(formatCompactNumber(500000), '500.0K');
      assert.equal(formatCompactNumber(12500), '12.5K');
      assert.equal(formatCompactNumber(100), '100');
      assert.equal(formatCompactNumber(0), '0');
      assert.equal(formatCompactNumber(null), '');
      assert.equal(formatCompactNumber(undefined), '');
    }]
  ],

  formatFee: [
    ['частка або відсоток у рядок з відсотком', ({ formatFee }) => {
      assert.equal(formatFee(0.1), '10%');
      assert.equal(formatFee(0.15), '15%');
      assert.equal(formatFee(0.0525), '5.25%');
      assert.equal(formatFee(1), '100%');
      assert.equal(formatFee(null), '');
      assert.equal(formatFee(''), '');
    }]
  ],

  formatSeconds: [
    ['секунди у дні, години, хвилини', ({ formatSeconds }) => {
      assert.equal(formatSeconds(604800), '7d');
      assert.equal(formatSeconds(86400), '1d');
      assert.equal(formatSeconds(172800), '2d');
      assert.equal(formatSeconds(3600), '1h');
      assert.equal(formatSeconds(90000), '1d 1h');
      assert.equal(formatSeconds(7260), '2h 1m');
      assert.equal(formatSeconds(0), '0s');
      assert.equal(formatSeconds(null), '');
    }]
  ],

  formatCapDetails: [
    ['форматування абсолютного та відносного cap', ({ formatCapDetails }) => {
      assert.equal(formatCapDetails({ oldCap: 1000000, newCap: 10000000 }), 'Cap 1.0M to 10.0M (x10)');
      assert.equal(formatCapDetails({ oldCap: null, newCap: 10000000 }), 'New cap 10.0M');
      assert.equal(formatCapDetails({ functionName: 'IncreaseRelativeCap', newCap: 1 }), 'Relative cap to 100%');
      assert.equal(formatCapDetails({ functionName: 'IncreaseRelativeCap', oldCap: 0.2, newCap: 0.5 }), 'Relative cap 20% to 50%');
      assert.equal(formatCapDetails(null), '');
      assert.equal(formatCapDetails({}), '');
    }]
  ],

  formatEventDetails: [
    ['людські деталі для 33 видів подій', ({ formatEventDetails }) => {
      // 1. fee_changed
      assert.equal(formatEventDetails({ oldFee: 0.10, newFee: 0.15 }, 'fee_changed'), 'Fee 10% to 15%');
      assert.equal(formatEventDetails({ feeRecipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'fee_changed'), 'Recipient 0x7099...79C8');

      // 2. timelock_changed
      assert.equal(formatEventDetails({ oldTimelock: 604800, newTimelock: 86400 }, 'timelock_changed'), 'Timelock 7d to 1d');
      assert.equal(formatEventDetails({ newTimelock: 86400 }, 'timelock_changed'), 'Timelock 1d');

      // 3. cap_changed
      assert.equal(formatEventDetails({ oldCap: 1000000, newCap: 10000000 }, 'cap_changed'), 'Cap 1.0M to 10.0M (x10)');
      assert.equal(formatEventDetails({ oldCap: null, newCap: 5000000 }, 'cap_changed'), 'New cap 5.0M');

      // 4. guardian_changed
      assert.equal(formatEventDetails({ guardian: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'guardian_changed'), 'Guardian 0x7099...79C8');
      assert.equal(formatEventDetails({ guardian: '0x0000000000000000000000000000000000000000' }, 'guardian_changed'), 'Guardian removed');

      // 5. curator_changed
      assert.equal(formatEventDetails({ curator: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'curator_changed'), 'Curator 0x7099...79C8');

      // 6. owner_changed
      assert.equal(formatEventDetails({ owner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'owner_changed'), 'Owner 0x7099...79C8');

      // 7. allocator_changed
      assert.equal(formatEventDetails({ allocator: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', isAllocator: true }, 'allocator_changed'), 'Enabled 0x7099...79C8');
      assert.equal(formatEventDetails({ allocator: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', isAllocator: false }, 'allocator_changed'), 'Removed 0x7099...79C8');

      // 8. skim_recipient_changed
      assert.equal(formatEventDetails({ skimRecipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'skim_recipient_changed'), 'Recipient 0x7099...79C8');

      // 9 & 10. supply_queue_changed & withdraw_queue_changed
      assert.equal(formatEventDetails({ supplyQueue: ['0x1', '0x2', '0x3'] }, 'supply_queue_changed'), '3 markets');
      assert.equal(formatEventDetails({ withdrawQueue: ['0x1'] }, 'withdraw_queue_changed'), '1 market');

      // 11. reallocation
      assert.equal(formatEventDetails({ volumeUsd: 1200000, marketsCount: 3 }, 'reallocation'), '$1.2M volume across 3 markets');

      // 12 & 13. market_removal_revoked & cap_revoked
      assert.equal(formatEventDetails({ marketLabel: 'WETH / USDC' }, 'market_removal_revoked'), 'WETH / USDC');
      assert.equal(formatEventDetails({ marketId: '0xaa80145be93ccfb0ebc25d8b7ea87588b3f78281' }, 'cap_revoked'), '0xaa80...8281');

      // 14. skim
      assert.equal(formatEventDetails({ amount: 1500000, assetSymbol: 'USDC' }, 'skim'), '1.5M USDC');

      // 15. pending_cap_increase
      assert.equal(formatEventDetails({ oldCap: 1000000, newCap: 10000000, functionName: 'IncreaseAbsoluteCap' }, 'pending_cap_increase'), 'Cap 1.0M to 10.0M (x10)');
      assert.equal(formatEventDetails({ newCap: 1, functionName: 'IncreaseRelativeCap' }, 'pending_cap_increase'), 'Relative cap to 100%');

      // 16. pending_market_removal
      assert.equal(formatEventDetails({ marketId: '0xaa80145be93ccfb0ebc25d8b7ea87588b3f78281' }, 'pending_market_removal'), '0xaa80...8281');

      // 17. pending_timelock_change
      assert.equal(formatEventDetails({ oldTimelock: 604800, newTimelock: 86400 }, 'pending_timelock_change'), 'Timelock 7d to 1d');

      // 18. pending_guardian_change
      assert.equal(formatEventDetails({ guardian: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'pending_guardian_change'), 'Guardian 0x7099...79C8');

      // 19. pending_fee_change
      assert.equal(formatEventDetails({ oldFee: 0.10, newFee: 0.15 }, 'pending_fee_change'), 'Fee 10% to 15%');
      assert.equal(formatEventDetails({ recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'pending_fee_change'), 'Recipient 0x7099...79C8');

      // 20. pending_adapter_change
      assert.equal(formatEventDetails({ adapterAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'pending_adapter_change'), 'Adapter 0x7099...79C8');

      // 21. pending_allocator_change
      assert.equal(formatEventDetails({ allocator: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', isAllocator: true }, 'pending_allocator_change'), 'Enabled 0x7099...79C8');

      // 22. pending_gate_change
      assert.equal(formatEventDetails({ gate: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'pending_gate_change'), 'Gate 0x7099...79C8');

      // 23. pending_force_deallocate_penalty
      assert.equal(formatEventDetails({ penalty: 0.05, adapterAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, 'pending_force_deallocate_penalty'), 'Penalty 5% (0x7099...79C8)');

      // 24. pending_abdicate
      assert.equal(formatEventDetails({ targetFunction: 'setCurator' }, 'pending_abdicate'), 'setCurator');

      // 25 & 26. verdict_worsened & verdict_improved
      assert.equal(formatEventDetails({ previousVerdict: 'yellow', currentVerdict: 'red' }, 'verdict_worsened'), 'YELLOW to RED');
      assert.equal(formatEventDetails({ previousVerdict: 'red', currentVerdict: 'green' }, 'verdict_improved'), 'RED to GREEN');

      // 27. mqi_dropped
      assert.equal(formatEventDetails({ previousMqi: 100, currentMqi: 85, drop: 15 }, 'mqi_dropped'), '100% to 85% (-15%)');

      // 28. bad_debt_appeared
      assert.equal(formatEventDetails({ badDebtUsd: 12500, marketKey: '0xaa80145be93ccfb0ebc25d8b7ea87588b3f78281' }, 'bad_debt_appeared'), '$12.5K bad debt (0xaa80...8281)');
      assert.equal(formatEventDetails({ badDebtUsd: 12500, marketLabel: 'wstETH/USDC', afterDataGap: true }, 'bad_debt_appeared'), '$12.5K bad debt (wstETH/USDC) (after a data gap)');

      // 29. flagged_collateral_added
      assert.equal(formatEventDetails({ collateralSymbol: 'USDe', supplyUsd: 1500000 }, 'flagged_collateral_added'), 'USDe ($1.5M supply)');

      // 30. tvl_drop
      assert.equal(formatEventDetails({ previousTvlUsd: 10000000, currentTvlUsd: 7000000, dropPercent: 30 }, 'tvl_drop'), '$10.0M to $7.0M (-30%)');

      // 31. exit_liquidity_low
      assert.equal(formatEventDetails({ previousExitPercent: 25, currentExitPercent: 15 }, 'exit_liquidity_low'), '25% to 15%');

      // 32. vault_delisted
      assert.equal(formatEventDetails({ vaultName: 'Morpho Vault' }, 'vault_delisted'), 'Delisted from Morpho registry');

      // 33. collateral_class_share_crossed
      assert.equal(formatEventDetails({ previousLevel: 'GREEN', currentLevel: 'YELLOW' }, 'collateral_class_share_crossed'), 'GREEN to YELLOW');
    }],
    ['ніколи не виводить технічні ключі і повертає порожній рядок при відсутності людських деталей', ({ formatEventDetails }) => {
      const technicalOnly = {
        functionName: 'IncreaseAbsoluteCap',
        txHash: '0x1234567890abcdef',
        validAt: 1792649891,
        configId: 'cfg_123',
        rawCap: '1000000000000000000',
        rawType: 'admin'
      };
      assert.equal(formatEventDetails(technicalOnly), '');
      assert.equal(formatEventDetails(technicalOnly, 'pending_cap_increase'), '');
      assert.equal(formatEventDetails({ unknownProp: 'foo' }), '');
      assert.equal(formatEventDetails(null), '');
      assert.equal(formatEventDetails('string'), '');
    }]
  ],

  formatUpdatedAge: [
    ['форматує вік останнього запиту', ({ formatUpdatedAge }) => {
      const now = Date.now();
      assert.equal(formatUpdatedAge(now, now), 'Updated just now');
      assert.equal(formatUpdatedAge(now - 30000, now), 'Updated just now');
      assert.equal(formatUpdatedAge(now - 65000, now), 'Updated 1 min ago');
      assert.equal(formatUpdatedAge(now - 5 * 60000, now), 'Updated 5 min ago');
      assert.equal(formatUpdatedAge(0), '');
      assert.equal(formatUpdatedAge(null), '');
    }]
  ],

  getEventKinds: [
    ['за замовчуванням виключає reallocation зі списку', ({ getEventKinds }) => {
      const kindsWithout = getEventKinds(false);
      assert.equal(kindsWithout.includes('reallocation'), false);
      assert.equal(kindsWithout.length, 32);
      assert.ok(kindsWithout.includes('fee_changed'));
      assert.ok(kindsWithout.includes('pending_cap_increase'));
      assert.ok(kindsWithout.includes('verdict_worsened'));
    }],
    ['якщо увімкнено, включає reallocation', ({ getEventKinds }) => {
      const kindsWith = getEventKinds(true);
      assert.equal(kindsWith.includes('reallocation'), true);
      assert.equal(kindsWith.length, 33);
    }]
  ],

  isValidAddress: [
    ['валідує 0x + 40 hex адрес', ({ isValidAddress }) => {
      assert.equal(isValidAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'), true);
      assert.equal(isValidAddress('0x1111111111111111111111111111111111111111'), true);
      assert.equal(isValidAddress('0x123'), false);
      assert.equal(isValidAddress('0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'), false);
      assert.equal(isValidAddress(''), false);
      assert.equal(isValidAddress(null), false);
      assert.equal(isValidAddress(12345), false);
    }]
  ],

  chunkArray: [
    ['розбиття на чанки по 50, 51, 120 елементів', ({ chunkArray }) => {
      const arr50 = Array.from({ length: 50 }, (_, i) => i);
      const c50 = chunkArray(arr50, 50);
      assert.equal(c50.length, 1);
      assert.equal(c50[0].length, 50);

      const arr51 = Array.from({ length: 51 }, (_, i) => i);
      const c51 = chunkArray(arr51, 50);
      assert.equal(c51.length, 2);
      assert.equal(c51[0].length, 50);
      assert.equal(c51[1].length, 1);

      const arr120 = Array.from({ length: 120 }, (_, i) => i);
      const c120 = chunkArray(arr120, 50);
      assert.equal(c120.length, 3);
      assert.equal(c120[0].length, 50);
      assert.equal(c120[1].length, 50);
      assert.equal(c120[2].length, 20);

      assert.deepEqual(chunkArray([]), []);
      assert.deepEqual(chunkArray(null), []);
    }]
  ],

  mergeEvents: [
    ['дедуплікація за id та сортування upcoming vs history', ({ mergeEvents }) => {
      const e1 = { id: 1, valid_at: 100, occurred_at: 500 };
      const e2 = { id: 2, valid_at: 200, occurred_at: 400 };
      const e3 = { id: 1, valid_at: 100, occurred_at: 500 }; // duplicate id 1
      const e4 = { id: 3, valid_at: 50, occurred_at: 600 };

      const upcoming = mergeEvents([[e1, e2], [e3, e4]], true);
      assert.equal(upcoming.length, 3);
      assert.deepEqual(upcoming.map(e => e.id), [3, 1, 2]); // sorted valid_at ASC: 50, 100, 200

      const history = mergeEvents([[e1, e2], [e3, e4]], false);
      assert.equal(history.length, 3);
      assert.deepEqual(history.map(e => e.id), [3, 1, 2]); // sorted occurred_at DESC: 600, 500, 400
    }],
    ['обробка порожніх або невалідних масивів', ({ mergeEvents }) => {
      assert.deepEqual(mergeEvents([]), []);
      assert.deepEqual(mergeEvents([null, [null, {}]]), []);
    }]
  ],

  filterHistoryEvents: [
    ['виключає події зі статусом pending та залишає final, applied, revoked', ({ filterHistoryEvents }) => {
      const list = [
        { id: 1, status: 'pending' },
        { id: 2, status: 'final' },
        { id: 3, status: 'applied' },
        { id: 4, status: 'revoked' },
        { id: 5, status: 'PENDING' }
      ];
      const res = filterHistoryEvents(list);
      assert.equal(res.length, 3);
      assert.deepEqual(res.map(e => e.id), [2, 3, 4]);
    }],
    ['обробляє порожні масиви та невалідні вхідні дані', ({ filterHistoryEvents }) => {
      assert.deepEqual(filterHistoryEvents([]), []);
      assert.deepEqual(filterHistoryEvents(null), []);
      assert.deepEqual(filterHistoryEvents('invalid'), []);
    }]
  ],

  groupEvents: [
    ['групує події з однаковими vault + kind + status + details.txHash з суфіксом xN', ({ groupEvents }) => {
      const v = '0x1111111111111111111111111111111111111111';
      const events = [
        { id: 1, vault_address: v, kind: 'pending_cap_increase', status: 'pending', title: 'Pending cap increase', severity: 'warning', details: { txHash: '0xabc', oldCap: 100, newCap: 200 }, valid_at: 1000, occurred_at: 500 },
        { id: 2, vault_address: v, kind: 'pending_cap_increase', status: 'pending', title: 'Pending cap increase', severity: 'critical', details: { txHash: '0xabc', oldCap: 100, newCap: 1000 }, valid_at: 900, occurred_at: 600 }
      ];
      const grouped = groupEvents(events, true);
      assert.equal(grouped.length, 1);
      assert.equal(grouped[0].title, 'Pending cap increase x2');
      assert.equal(grouped[0].severity, 'critical'); // highest severity in group
      assert.deepEqual(grouped[0].details, { txHash: '0xabc', oldCap: 100, newCap: 1000 }); // worst event details
      assert.equal(grouped[0].valid_at, 900); // nearest validAt
      assert.equal(grouped[0].occurred_at, 600); // newest occurredAt
    }],
    ['поодинокі події не змінюються та не отримують суфікс', ({ groupEvents }) => {
      const v = '0x1111111111111111111111111111111111111111';
      const single = [{ id: 1, vault_address: v, kind: 'fee_changed', status: 'final', title: 'Fee changed', severity: 'info', details: { txHash: '0x1' } }];
      const res = groupEvents(single, false);
      assert.equal(res.length, 1);
      assert.equal(res[0].title, 'Fee changed');
      assert.equal(res[0], single[0]);
    }],
    ['події без txHash не групуються між собою', ({ groupEvents }) => {
      const v = '0x1111111111111111111111111111111111111111';
      const events = [
        { id: 1, vault_address: v, kind: 'mqi_dropped', status: 'final', title: 'MQI dropped', details: {} },
        { id: 2, vault_address: v, kind: 'mqi_dropped', status: 'final', title: 'MQI dropped', details: {} }
      ];
      const res = groupEvents(events, false);
      assert.equal(res.length, 2);
    }],
    ['обробляє порожні та невалідні масиви', ({ groupEvents }) => {
      assert.deepEqual(groupEvents([]), []);
      assert.deepEqual(groupEvents(null), []);
      assert.deepEqual(groupEvents('invalid'), []);
    }]
  ],

  getSeenTs: [
    ['перший візит встановлює seenTs на поточний час', ({ getSeenTs, __state: s }) => {
      localStorage.clear();
      s.seenTsMemoryFallback = null;
      const t0 = Math.floor(Date.now() / 1000);
      const res = getSeenTs();
      assert.ok(res >= t0);
      assert.equal(localStorage.getItem('cym_activity_seen_ts'), String(res));
    }],
    ['читає раніше збережене значення', ({ getSeenTs, __state: s }) => {
      localStorage.setItem('cym_activity_seen_ts', '1699999999');
      s.seenTsMemoryFallback = null;
      assert.equal(getSeenTs(), 1699999999);
    }]
  ],

  setSeenTs: [
    ['зберігає seenTs у памʼять і localStorage', ({ setSeenTs, getSeenTs }) => {
      setSeenTs(1750000000);
      assert.equal(localStorage.getItem('cym_activity_seen_ts'), '1750000000');
      assert.equal(getSeenTs(), 1750000000);
    }]
  ],

  getShowReallocations: [
    ['дефолт false, повертає збережений прапорець', ({ getShowReallocations, __state: s }) => {
      localStorage.clear();
      s.showReallocMemoryFallback = null;
      assert.equal(getShowReallocations(), false);
      localStorage.setItem('cym_activity_show_reallocations', '1');
      assert.equal(getShowReallocations(), true);
    }]
  ],

  setShowReallocations: [
    ['зберігає showReallocations у памʼять і localStorage', ({ setShowReallocations, getShowReallocations }) => {
      setShowReallocations(true);
      assert.equal(localStorage.getItem('cym_activity_show_reallocations'), '1');
      assert.equal(getShowReallocations(), true);
      setShowReallocations(false);
      assert.equal(localStorage.getItem('cym_activity_show_reallocations'), '0');
      assert.equal(getShowReallocations(), false);
    }]
  ],

  countUnseenEvents: [
    ['гранична умова: detected_at == seenTs не вважається unseen', ({ countUnseenEvents }) => {
      const seenTs = 1000;
      const events = [
        { id: 1, detected_at: 1000, severity: 'critical', kind: 'fee_changed' },
        { id: 2, detected_at: 999, severity: 'warning', kind: 'cap_changed' }
      ];
      const res = countUnseenEvents(events, seenTs, false);
      assert.equal(res.count, 0);
      assert.equal(res.highestSeverity, null);
      assert.equal(res.hasCritical, false);
    }],
    ['фільтр серйозності: лише critical і warning, info ігнорується', ({ countUnseenEvents }) => {
      const seenTs = 1000;
      const events = [
        { id: 1, detected_at: 1050, severity: 'info', kind: 'fee_changed' },
        { id: 2, detected_at: 1060, severity: 'warning', kind: 'cap_changed' }
      ];
      const res = countUnseenEvents(events, seenTs, false);
      assert.equal(res.count, 1);
      assert.equal(res.highestSeverity, 'warning');
      assert.equal(res.hasCritical, false);
    }],
    ['критична подія задає highestSeverity critical та hasCritical true', ({ countUnseenEvents }) => {
      const seenTs = 1000;
      const events = [
        { id: 1, detected_at: 1050, severity: 'warning', kind: 'fee_changed' },
        { id: 2, detected_at: 1060, severity: 'critical', kind: 'verdict_worsened' }
      ];
      const res = countUnseenEvents(events, seenTs, false);
      assert.equal(res.count, 2);
      assert.equal(res.highestSeverity, 'critical');
      assert.equal(res.hasCritical, true);
    }],
    ['приховані типи: reallocation не враховується, якщо вимкнено', ({ countUnseenEvents }) => {
      const seenTs = 1000;
      const events = [
        { id: 1, detected_at: 1050, severity: 'warning', kind: 'reallocation' },
        { id: 2, detected_at: 1060, severity: 'critical', kind: 'fee_changed' }
      ];
      const withoutRealloc = countUnseenEvents(events, seenTs, false);
      assert.equal(withoutRealloc.count, 1);

      const withRealloc = countUnseenEvents(events, seenTs, true);
      assert.equal(withRealloc.count, 2);
    }],
    ['дедуплікує події за id', ({ countUnseenEvents }) => {
      const seenTs = 1000;
      const events = [
        { id: 1, detected_at: 1050, severity: 'critical', kind: 'fee_changed' },
        { id: 1, detected_at: 1050, severity: 'critical', kind: 'fee_changed' }
      ];
      const res = countUnseenEvents(events, seenTs, false);
      assert.equal(res.count, 1);
    }]
  ],

  buildEventsUrl: [
    ['будує GET /api/events з адресами, типами, лімітом, before', ({ buildEventsUrl }) => {
      const addrs = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];
      const url = buildEventsUrl({ addresses: addrs, kinds: ['fee_changed', 'cap_changed'], limit: 100, before: 42 });
      assert.ok(url.startsWith('/api/events?'));
      assert.ok(url.includes('addresses=' + encodeURIComponent(addrs.join(','))));
      assert.ok(url.includes('kinds=' + encodeURIComponent('fee_changed,cap_changed')));
      assert.ok(url.includes('limit=100'));
      assert.ok(url.includes('before=42'));
    }],
    ['для scope All будує URL без addresses', ({ buildEventsUrl }) => {
      const url = buildEventsUrl({ kinds: ['fee_changed'], limit: 100 });
      assert.equal(url.includes('addresses'), false);
      assert.ok(url.includes('kinds=fee_changed'));
      assert.ok(url.includes('limit=100'));
    }]
  ],

  buildPendingEventsUrl: [
    ['будує GET /api/events/pending', ({ buildPendingEventsUrl }) => {
      const addrs = ['0x1111111111111111111111111111111111111111'];
      const url = buildPendingEventsUrl({ addresses: addrs, kinds: ['pending_cap_increase'], limit: 200 });
      assert.ok(url.startsWith('/api/events/pending?'));
      assert.ok(url.includes('addresses=' + encodeURIComponent(addrs[0])));
      assert.ok(url.includes('kinds=pending_cap_increase'));
      assert.ok(url.includes('limit=200'));
    }]
  ],

  buildEventRowViewModel: [
    ['будує view-model з ворожими рядками, зберігаючи їх безпечними', ({ buildEventRowViewModel }) => {
      const hostileEvent = {
        id: 1,
        vault_address: '0x1111111111111111111111111111111111111111',
        title: '<img src=x onerror=alert(1)>',
        details: { message: '<script>alert("xss")</script>' },
        severity: 'critical',
        occurred_at: 1000
      };
      const vaultLookup = () => ({
        address: '0x1111111111111111111111111111111111111111',
        name: '<b>Injected Vault</b>',
        chainId: 1
      });
      const vm = buildEventRowViewModel(hostileEvent, vaultLookup, 2000, false);
      assert.equal(vm.title, '<img src=x onerror=alert(1)>');
      assert.equal(vm.vaultName, '<b>Injected Vault</b>');
      assert.equal(vm.detail, '<script>alert("xss")</script>');
      assert.equal(vm.isClickable, true);
      assert.equal(vm.severity, 'CRITICAL');
    }],
    ['обробка відсутніх опціональних полів та невідомого сховища', ({ buildEventRowViewModel }) => {
      const event = { id: 2, vault_address: '0xunknown', severity: 'info' };
      const vm = buildEventRowViewModel(event, () => null, 1000, true);
      assert.equal(vm.vault, null);
      assert.equal(vm.isClickable, false);
      assert.equal(vm.vaultName, 'Unknown Vault');
      assert.equal(vm.title, '');
      assert.equal(vm.detail, '');
      assert.equal(vm.severity, 'INFO');
      assert.equal(buildEventRowViewModel(null), null);
    }],
    ['визначає statusLabel для applied і revoked, порожній для final/pending', ({ buildEventRowViewModel }) => {
      assert.equal(buildEventRowViewModel({ id: 1, status: 'applied' }, () => null).statusLabel, 'applied');
      assert.equal(buildEventRowViewModel({ id: 2, status: 'revoked' }, () => null).statusLabel, 'revoked');
      assert.equal(buildEventRowViewModel({ id: 3, status: 'final' }, () => null).statusLabel, '');
      assert.equal(buildEventRowViewModel({ id: 4, status: 'pending' }, () => null).statusLabel, '');
    }]
  ],

  renderActivityRow: [
    ['створює клікабельний focusable li для відомого сховища', ({ renderActivityRow }) => {
      const vm = {
        id: 1,
        vault: { address: '0x1' },
        isClickable: true,
        severity: 'CRITICAL',
        severityRaw: 'critical',
        chainName: 'ETH',
        chainClass: 'ethereum',
        vaultName: 'Test Vault',
        title: 'Fee increased',
        detail: '0% -> 5%',
        isUpcoming: false,
        relativeTime: '2h ago',
        fullTime: '2024-10-21 10:00'
      };
      let clickedVault = null;
      const el = renderActivityRow(vm, v => { clickedVault = v; });
      assert.equal(el.tagName, 'LI');
      assert.equal(el.className.includes('is-clickable'), true);
      assert.equal(el.tabIndex, 0);
      assert.equal(el.getAttribute('role'), 'button');
      assert.ok(el.innerHTML.includes('CRITICAL'));
      assert.ok(el.innerHTML.includes('Test Vault'));
      assert.ok(el.innerHTML.includes('2h ago'));
    }],
    ['екранує ворожі рядки в innerHTML', ({ renderActivityRow, __state: s }) => {
      s.deps.escapeHtml = str => String(str).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const vm = {
        id: 2,
        vault: null,
        isClickable: false,
        severity: 'WARNING',
        severityRaw: 'warning',
        chainName: 'BASE',
        chainClass: 'base',
        vaultName: '<script>alert(1)</script>',
        title: '<img onerror=x>',
        detail: '"><b onmouseover=alert(2)>hover</b>',
        isUpcoming: true,
        isExecutable: true,
        countdown: 'executable now',
        activeTime: 'Active now'
      };
      const el = renderActivityRow(vm);
      assert.equal(el.className.includes('not-clickable'), true);
      assert.ok(el.innerHTML.includes('&lt;script&gt;'));
      assert.ok(el.innerHTML.includes('&lt;img'));
      assert.ok(el.innerHTML.includes('executable now'));
    }],
    ['відображає бейдж статусу для applied та revoked', ({ renderActivityRow }) => {
      const vmApplied = {
        id: 1, vault: null, isClickable: false, severity: 'INFO', severityRaw: 'info',
        chainName: 'ETH', chainClass: 'ethereum', vaultName: 'Vault', title: 'Cap changed',
        statusLabel: 'applied', detail: ''
      };
      const el = renderActivityRow(vmApplied);
      assert.ok(el.innerHTML.includes('activity-status-tag status-applied'));
      assert.ok(el.innerHTML.includes('applied'));
    }]
  ],

  updateActivityBadge: [
    ['оновлює бейдж та aria-label дзвіночка', ({ updateActivityBadge, __state: s }) => {
      const dom = setupFakeDom();
      s.deps.DOM.activityBtn = dom.btn;
      s.deps.DOM.activityBadge = dom.badge;
      s.isPanelOpen = false;

      // 0 unseen
      updateActivityBadge({ count: 0, highestSeverity: null, hasCritical: false });
      assert.equal(dom.badge.classList.contains('hidden'), true);
      assert.equal(dom.btn.getAttribute('aria-label'), 'Vault activity');

      // 2 unseen, warning
      updateActivityBadge({ count: 2, highestSeverity: 'warning', hasCritical: false });
      assert.equal(dom.badge.textContent, '2');
      assert.equal(dom.badge.classList.contains('hidden'), false);
      assert.equal(dom.badge.classList.contains('critical'), false);
      assert.equal(dom.btn.getAttribute('aria-label'), 'Vault activity, 2 unseen, warning');

      // 1 unseen, critical
      updateActivityBadge({ count: 1, highestSeverity: 'critical', hasCritical: true });
      assert.equal(dom.badge.textContent, '1');
      assert.equal(dom.badge.classList.contains('critical'), true);
      assert.equal(dom.btn.getAttribute('aria-label'), 'Vault activity, 1 unseen, critical');

      // When panel is open, badge is always hidden
      s.isPanelOpen = true;
      updateActivityBadge({ count: 5, highestSeverity: 'critical', hasCritical: true });
      assert.equal(dom.badge.classList.contains('hidden'), true);
    }]
  ],

  renderActivityPanel: [
    ['рендерить стан завантаження, помилку, порожні обрані та список подій', ({ renderActivityPanel, __state: s }) => {
      const dom = setupFakeDom();
      s.deps.DOM = dom;
      s.deps.getPinnedAddresses = () => [];

      // 1. Loading state
      s.isLoading = true;
      s.cachedPendingEvents = [];
      s.cachedHistoryEvents = [];
      renderActivityPanel();
      assert.ok(dom.list.innerHTML.includes('Loading activity'));

      // 2. Error state
      s.isLoading = false;
      s.fetchError = 'Network error';
      renderActivityPanel();
      assert.ok(dom.list.innerHTML.includes('Network error'));
      assert.ok(dom.list.innerHTML.includes('Retry'));

      // 3. Empty favorites
      s.fetchError = null;
      s.activeScope = 'favorites';
      renderActivityPanel();
      assert.ok(dom.list.innerHTML.includes('Pin vaults with the star to follow them here'));
      assert.ok(dom.list.innerHTML.includes('Browse all vaults'));

      // 4. Empty result
      s.deps.getPinnedAddresses = () => ['0x1111111111111111111111111111111111111111'];
      s.activeTab = 'upcoming';
      renderActivityPanel();
      assert.ok(dom.list.innerHTML.includes('No upcoming changes'));

      s.activeTab = 'history';
      renderActivityPanel();
      assert.ok(dom.list.innerHTML.includes('No events yet'));

      // 5. Normal events rendering
      s.cachedHistoryEvents = [{
        id: 1, vault_address: '0x1111111111111111111111111111111111111111',
        title: 'Cap updated', severity: 'info', occurred_at: 1000
      }];
      renderActivityPanel();
      assert.ok(dom.list.innerHTML.includes('Cap updated'));
    }],
    ['лічильник Upcoming рахує показані рядки: події однієї транзакції зливаються в один', ({ renderActivityPanel, __state: s }) => {
      const dom = setupFakeDom();
      s.deps.DOM = dom;
      s.deps.getPinnedAddresses = () => [];
      s.activeScope = 'all';
      const ev = (id, tx) => ({ id, vault_address: '0x1111111111111111111111111111111111111111', kind: 'pending_cap_increase', status: 'pending', title: 'Cap', severity: 'warning', valid_at: 2000000000, details: { txHash: tx } });
      s.cachedPendingEvents = [ev(1, '0xaa'), ev(2, '0xaa'), ev(3, '0xbb')];
      renderActivityPanel();
      assert.equal(dom.upcomingCount.textContent, '(2)');
    }]
  ],

  openActivityPanel: [
    ['відкриває панель, приховує пошук і фільтри, скидає unread', ({ openActivityPanel, __state: s }) => {
      const dom = setupFakeDom();
      s.deps.DOM = dom;
      s.lastFetchTs = Date.now(); // fresh data so no auto-fetch in test
      openActivityPanel();

      assert.equal(s.isPanelOpen, true);
      assert.equal(dom.btn.classList.contains('on'), true);
      assert.equal(dom.btn.getAttribute('aria-expanded'), 'true');
      assert.equal(dom.panel.classList.contains('hidden'), false);
      assert.equal(dom.heading.textContent, 'Vault Activity');
      assert.equal(dom.searchBox.classList.contains('hidden'), true);
      assert.equal(dom.filtersGrid.classList.contains('hidden'), true);
      assert.equal(dom.vaultsList.classList.contains('hidden'), true);
    }]
  ],

  closeActivityPanel: [
    ['закриває панель, повертає заголовок, показує список, фокусує кнопку', ({ closeActivityPanel, __state: s }) => {
      const dom = setupFakeDom();
      s.deps.DOM = dom;
      let focused = false;
      dom.btn.focus = () => { focused = true; };
      s.isPanelOpen = true;

      closeActivityPanel();

      assert.equal(s.isPanelOpen, false);
      assert.equal(dom.btn.classList.contains('on'), false);
      assert.equal(dom.btn.getAttribute('aria-expanded'), 'false');
      assert.equal(dom.panel.classList.contains('hidden'), true);
      assert.equal(dom.heading.textContent, 'Vaults Explorer');
      assert.equal(dom.searchBox.classList.contains('hidden'), false);
      assert.equal(dom.vaultsList.classList.contains('hidden'), false);
      assert.equal(focused, true);
    }]
  ],

  toggleActivityPanel: [
    ['перемикає відкритий/закритий стан', ({ toggleActivityPanel, __state: s }) => {
      setupFakeDom();
      s.isPanelOpen = false;
      s.lastFetchTs = Date.now();
      toggleActivityPanel();
      assert.equal(s.isPanelOpen, true);
      toggleActivityPanel();
      assert.equal(s.isPanelOpen, false);
    }]
  ],

  fetchActivityData: [
    ['завантажує події для обраних, оновлює кеші та бейдж', async ({ fetchActivityData, __state: s }) => {
      setupFakeDom();
      const addr = '0x1111111111111111111111111111111111111111';
      s.deps.getPinnedAddresses = () => [addr];
      s.activeScope = 'favorites';

      const calls = [];
      s.deps.apiFetch = async (url) => {
        calls.push(url);
        if (url.includes('/api/events/pending')) {
          return jsonResponse({
            events: [{ id: 10, vault_address: addr, title: 'Pending cap', valid_at: 1800000000, detected_at: 1700000000, severity: 'warning' }]
          });
        }
        return jsonResponse({
          events: [{ id: 20, vault_address: addr, title: 'Verdict dropped', occurred_at: 1690000000, detected_at: 1700000000, severity: 'critical' }]
        });
      };

      await fetchActivityData(true);
      assert.equal(calls.length, 2);
      assert.equal(s.cachedPendingEvents.length, 1);
      assert.equal(s.cachedHistoryEvents.length, 1);
      assert.equal(s.isLoading, false);
      assert.equal(s.fetchError, null);
    }],
    ['обробляє помилку мережі без викидання винятку', async ({ fetchActivityData, __state: s }) => {
      setupFakeDom();
      s.deps.getPinnedAddresses = () => ['0x1111111111111111111111111111111111111111'];
      s.activeScope = 'favorites';
      s.deps.apiFetch = async () => { throw new Error('offline'); };

      await fetchActivityData(true);
      assert.ok(s.fetchError.includes('Failed to load activity'));
      assert.equal(s.isLoading, false);
    }]
  ],

  loadMoreHistory: [
    ['довантажує наступну сторінку за курсором, зливає з кешем і закриває курсор, коли подій більше немає', async ({ loadMoreHistory, __state: s }) => {
      const dom = setupFakeDom();
      s.deps.DOM = dom;
      s.deps.getPinnedAddresses = () => [];
      s.isPanelOpen = true;
      s.activeScope = 'all';
      s.activeTab = 'history';
      s.cachedHistoryEvents = [{ id: 20, title: 'Newer', severity: 'info', occurred_at: 2000 }];
      s.historyCursors = [{ addresses: [], before: 20 }];

      const urls = [];
      s.deps.apiFetch = async (url) => {
        urls.push(url);
        return jsonResponse({ events: [{ id: 10, title: 'Older', severity: 'info', occurred_at: 1000 }], nextBefore: null });
      };

      const appended = [];
      dom.list.appendChild = el => appended.push(el);
      await loadMoreHistory();
      assert.equal(urls.length, 1);
      assert.match(urls[0], /before=20/);
      assert.deepEqual(s.cachedHistoryEvents.map(e => e.id), [20, 10]);
      assert.deepEqual(s.historyCursors.map(c => c.before), [null]);
      assert.equal(s.isLoadingMore, false);
      assert.notEqual(appended.at(-1).className, 'activity-more'); // the last render ends with a row, not the button
    }],
    ['невдала сторінка лишає курсор і кеш без змін, а кнопка показується далі', async ({ loadMoreHistory, __state: s }) => {
      const dom = setupFakeDom();
      s.deps.DOM = dom;
      s.deps.getPinnedAddresses = () => [];
      s.isPanelOpen = true;
      s.activeScope = 'all';
      s.activeTab = 'history';
      s.cachedHistoryEvents = [{ id: 20, title: 'Newer', severity: 'info', occurred_at: 2000 }];
      s.historyCursors = [{ addresses: [], before: 20 }];
      s.deps.apiFetch = async () => { throw new Error('offline'); };
      const appended = [];
      dom.list.appendChild = el => appended.push(el);

      await loadMoreHistory();
      assert.deepEqual(s.cachedHistoryEvents.map(e => e.id), [20]);
      assert.deepEqual(s.historyCursors.map(c => c.before), [20]);
      assert.ok(appended.some(el => el.className === 'activity-more' && el.innerHTML.includes('Show older events')));
    }],
  ],

  onFavoritesChanged: [
    ['викликає fetchActivityData при зміні обраних', async ({ onFavoritesChanged, __state: s }) => {
      let fetched = false;
      s.deps.apiFetch = async () => {
        fetched = true;
        return jsonResponse({ events: [] });
      };
      s.deps.getPinnedAddresses = () => ['0x1111111111111111111111111111111111111111'];
      await onFavoritesChanged();
      assert.equal(fetched, true);
    }]
  ],

  newSubId: [
    ['22 символи base64url без доповнення, придатні для параметра start (до 64 символів [A-Za-z0-9_-]); два виклики різні', ({ newSubId }) => {
      const a = newSubId(); const b = newSubId();
      assert.match(a, /^[A-Za-z0-9_-]{22}$/);
      assert.notEqual(a, b);
    }],
    ['кодує байти джерела випадковості (0xff.. -> "_" без "+", "/" і "=")', ({ newSubId }) => {
      const id = newSubId({ getRandomValues: arr => arr.fill(0xfb) });
      assert.equal(id, '-_v7-_v7-_v7-_v7-_v7-w');
      assert.ok(!/[+/=]/.test(id));
    }],
  ],

  readTelegramPairing: [
    ['code from ?tg= when it is 16-64 characters of [A-Za-z0-9_-]; anything else (absent, short, long, other characters) gives null', ({ readTelegramPairing: f }) => {
      assert.equal(f('?tg=abcdefghijklmnopqrstuv'), 'abcdefghijklmnopqrstuv'); assert.equal(f('?x=1&tg=A_b-C1234567890123'), 'A_b-C1234567890123');
      for (const bad of ['', '?tg=', '?tg=short', '?tg=' + 'a'.repeat(65), '?tg=has%20space1234567890', '?tg=<script>alert(1)</script>', '?other=abcdefghijklmnopqrstuv']) assert.equal(f(bad), null, bad);
    }],
  ],

  buildTelegramUrl: [
    ['посилання на бота з кодом підписки, спецсимволи екрануються', ({ buildTelegramUrl }) => {
      assert.equal(buildTelegramUrl('cym_bot', 'abc-_123'), 'https://t.me/cym_bot?start=abc-_123');
      assert.equal(buildTelegramUrl('a b', 'x&y'), 'https://t.me/a%20b?start=x%26y');
    }],
  ],

  readSubId: [
    ['повертає збережений id або null; недоступне сховище не кидає виняток', ({ readSubId }) => {
      localStorage.removeItem('cym_tg_sub');
      assert.equal(readSubId(), null);
      localStorage.setItem('cym_tg_sub', 'abc');
      assert.equal(readSubId(), 'abc');
      localStorage.removeItem('cym_tg_sub');
      const saved = localStorage.getItem;
      localStorage.getItem = () => { throw new Error('blocked'); };
      try { assert.equal(readSubId(), null); } finally { localStorage.getItem = saved; }
    }],
  ],

  loadTelegramConfig: [
    ['бот увімкнено -> tgUsername; вимкнено, не ok, не JSON або мережева помилка -> null', async ({ loadTelegramConfig, __state: s }) => {
      const fake = body => ({ apiFetch: async () => body });
      s.deps.apiFetch = async () => jsonResponse({ enabled: true, username: 'cym_bot' });
      await loadTelegramConfig(); assert.equal(s.tgUsername, 'cym_bot');
      s.deps.apiFetch = async () => jsonResponse({ enabled: false, username: null });
      await loadTelegramConfig(); assert.equal(s.tgUsername, null);
      s.tgUsername = 'x'; s.deps.apiFetch = async () => ({ ok: false });
      await loadTelegramConfig(); assert.equal(s.tgUsername, null);
      s.tgUsername = 'x'; s.deps.apiFetch = async () => { throw new Error('offline'); };
      await loadTelegramConfig(); assert.equal(s.tgUsername, null);
      s.tgUsername = 'x'; s.deps.apiFetch = async () => jsonResponse({ enabled: true, username: 42 });
      await loadTelegramConfig(); assert.equal(s.tgUsername, null);
      void fake;
    }],
  ],

  syncTelegram: [
    ['без імені бота нічого не відправляє і повертає null', async ({ syncTelegram, __state: s }) => {
      let calls = 0;
      s.tgUsername = null;
      const r = await withFetch(async () => { calls++; return jsonResponse({}); }, () => syncTelegram());
      assert.equal(r, null); assert.equal(calls, 0);
    }],
    ['створює і зберігає id, PUT з валідними адресами; наступний виклик використовує той самий id', async ({ syncTelegram, __state: s }) => {
      localStorage.removeItem('cym_tg_sub');
      s.tgUsername = 'cym_bot';
      s.deps.getPinnedAddresses = () => ['0x1111111111111111111111111111111111111111', 'not-an-address'];
      let put;
      const subId = await withFetch(async (url, init) => { put = { url, init }; return jsonResponse({ vaults: 1 }); }, () => syncTelegram());
      assert.match(subId, /^[A-Za-z0-9_-]{22}$/);
      assert.equal(localStorage.getItem('cym_tg_sub'), subId);
      assert.equal(put.url, '/api/tg/subscription'); assert.equal(put.init.method, 'PUT');
      assert.deepEqual(JSON.parse(put.init.body), { sub_id: subId, vaults: ['0x1111111111111111111111111111111111111111'] });
      assert.equal(await withFetch(async () => jsonResponse({}), () => syncTelegram()), subId);
    }],
    ['мережева помилка не кидає виняток, id усе одно повертається', async ({ syncTelegram, __state: s }) => {
      localStorage.setItem('cym_tg_sub', 'existing-subscription-id');
      s.tgUsername = 'cym_bot';
      s.deps.getPinnedAddresses = () => [];
      assert.equal(await withFetch(async () => { throw new Error('offline'); }, () => syncTelegram()), 'existing-subscription-id');
    }],
  ],

  scheduleTelegramSync: [
    ['ставить відкладену синхронізацію лише коли бот увімкнено і в браузері є id підписки', ({ scheduleTelegramSync, __state: s }) => {
      s.tgSyncTimer = null;
      localStorage.removeItem('cym_tg_sub');
      s.tgUsername = 'cym_bot'; scheduleTelegramSync();
      assert.equal(s.tgSyncTimer, null);
      localStorage.setItem('cym_tg_sub', 'existing-subscription-id');
      s.tgUsername = null; scheduleTelegramSync();
      assert.equal(s.tgSyncTimer, null);
      s.tgUsername = 'cym_bot'; scheduleTelegramSync();
      assert.notEqual(s.tgSyncTimer, null);
      clearTimeout(s.tgSyncTimer); s.tgSyncTimer = null;
    }],
  ],

  setupActivityEvents: [
    ['підключає обробники подій для дзвіночка, закриття, вкладок і чекбокса', ({ setupActivityEvents, __state: s }) => {
      const dom = setupFakeDom();
      s.deps.DOM = dom;
      s.eventsBound = false;
      setupActivityEvents();

      assert.equal(s.eventsBound, true);
      // Re-calling does not bind again
      setupActivityEvents();
      assert.equal(s.eventsBound, true);
    }]
  ],

  initActivity: [
    ['ініціалізує залежності та запускає первинний fetch', async ({ initActivity, __state: s }) => {
      setupFakeDom();
      let fetchCalled = false;
      await initActivity({
        apiFetch: async () => {
          fetchCalled = true;
          return jsonResponse({ events: [] });
        },
        getPinnedAddresses: () => ['0x1111111111111111111111111111111111111111']
      });
      assert.equal(typeof s.deps.apiFetch, 'function');
      assert.equal(fetchCalled, true);
    }]
  ]
};
