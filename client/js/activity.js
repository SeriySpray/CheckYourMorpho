/**
 * CheckYourMorpho: Vault Activity Panel Controller
 * Handles bell button, unread counts, upcoming timelocked changes, and past event history.
 */

// Mirrors server/engine/eventsEngine.js EVENT_KINDS
const EVENT_KINDS = Object.freeze([
  // Admin events (V1)
  'fee_changed',
  'timelock_changed',
  'cap_changed',
  'guardian_changed',
  'curator_changed',
  'owner_changed',
  'allocator_changed',
  'skim_recipient_changed',
  'supply_queue_changed',
  'withdraw_queue_changed',
  'reallocation',
  'market_removal_revoked',
  'cap_revoked',
  'skim',
  // Pending timelock configs (V1 and V2)
  'pending_cap_increase',
  'pending_market_removal',
  'pending_timelock_change',
  'pending_guardian_change',
  'pending_fee_change',
  'pending_adapter_change',
  'pending_allocator_change',
  'pending_gate_change',
  'pending_force_deallocate_penalty',
  'pending_abdicate',
  // Derived state transitions (V1 and V2)
  'verdict_worsened',
  'verdict_improved',
  'mqi_dropped',
  'bad_debt_appeared',
  'flagged_collateral_added',
  'tvl_drop',
  'exit_liquidity_low',
  'vault_delisted',
  'collateral_class_share_crossed',
  'collateral_tier_changed'
]);

const STORAGE_KEY_SEEN = 'cym_activity_seen_ts';
const STORAGE_KEY_SHOW_REALLOC = 'cym_activity_show_reallocations';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let seenTsMemoryFallback = null;
let showReallocMemoryFallback = null;

// External dependencies injected by app.js
let deps = {
  apiFetch: null,
  getPinnedAddresses: () => [],
  openVaultAudit: () => {},
  getVault: () => null,
  formatChainName: (id) => `CHAIN ${id}`,
  getChainClass: () => '',
  escapeHtml: (s) => String(s ?? ''),
  DOM: {},
  getSphereParticlePos: () => null
};

// Panel runtime state
let isPanelOpen = false;
let activeTab = 'upcoming'; // 'upcoming' | 'history'
let activeScope = 'favorites'; // 'favorites' | 'all'
let cachedPendingEvents = [];
let cachedHistoryEvents = [];
let lastFetchTs = 0;
let fetchToken = 0;
let isLoading = false;
let fetchError = null;
let eventsBound = false;
let periodicTimer = null;

/**
 * Formats countdown string for pending timelocked events.
 * Returns 'executable now' if valid_at <= now, otherwise 'in 1d 14h', 'in 3h 20m', 'in 12m', 'in 59s'.
 */
function formatCountdown(validAt, nowSec = Math.floor(Date.now() / 1000)) {
  if (validAt === null || validAt === undefined || validAt === '') return '';
  const diff = Number(validAt) - Number(nowSec);
  if (!Number.isFinite(diff) || diff <= 0) return 'executable now';
  if (diff < 60) return `in ${diff}s`;
  if (diff < 3600) return `in ${Math.floor(diff / 60)}m`;
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  return h > 0 ? `in ${d}d ${h}h` : `in ${d}d`;
}

/**
 * Formats local activation timestamp, e.g. "Active 21 Oct 08:12".
 */
function formatActiveTime(validAt) {
  if (validAt === null || validAt === undefined || validAt === '') return '';
  const d = new Date(Number(validAt) * 1000);
  if (isNaN(d.getTime())) return '';
  const day = d.getDate();
  const month = MONTHS[d.getMonth()] || '';
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `Active ${day} ${month} ${hours}:${mins}`;
}

/**
 * Formats past event age, e.g. "3h ago", "2d ago".
 */
function formatRelativeTime(occurredAt, nowSec = Math.floor(Date.now() / 1000)) {
  if (occurredAt === null || occurredAt === undefined || occurredAt === '') return '';
  const diff = Math.max(0, Number(nowSec) - Number(occurredAt));
  if (!Number.isFinite(diff)) return '';
  if (diff < 60) return `${diff}s ago`;
  const min = Math.floor(diff / 60);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Formats full local date/time for title tooltips.
 */
function formatFullDateTime(ts) {
  if (ts === null || ts === undefined || ts === '') return '';
  const d = new Date(Number(ts) * 1000);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/**
 * Checks if address is null, empty or zero address.
 */
function isZeroAddress(addr) {
  return !addr || /^0x0+$/i.test(String(addr).trim());
}

/**
 * Formats address or bytes32 hash to short form: 0xaa80...8281.
 */
function formatAddress(addr) {
  if (!addr) return '';
  const s = String(addr).trim();
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

/**
 * Formats compact numbers, e.g. 1.0M, 10.0M, 500.0K.
 */
function formatCompactNumber(val, decimals = 1) {
  if (val === null || val === undefined || val === '') return '';
  const n = Number(val);
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(decimals)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(decimals)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(decimals)}K`;
  if (abs === 0) return '0';
  return `${sign}${Math.round(abs * 100) / 100}`;
}

/**
 * Formats fee fractions to percentage string, e.g. 0.1 -> "10%", 0.15 -> "15%".
 */
function formatFee(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '';
  const pct = n <= 1 ? n * 100 : n;
  const rounded = Math.round(pct * 100) / 100;
  return `${rounded}%`;
}

/**
 * Formats seconds into human duration, e.g. 604800 -> "7d", 86400 -> "1d".
 */
function formatSeconds(sec) {
  if (sec === null || sec === undefined || sec === '') return '';
  const s = Number(sec);
  if (!Number.isFinite(s)) return '';
  if (s === 0) return '0s';
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }
  return `${s}s`;
}

/**
 * Formats supply cap details, e.g. "Cap 1.0M to 10.0M (x10)" or "New cap 10.0M".
 */
function formatCapDetails(details) {
  if (!details || typeof details !== 'object') return '';
  const fn = String(details.functionName || '');
  const isRelative = fn === 'IncreaseRelativeCap' || details.configType === 'RelativeCap';

  let text = '';
  if (isRelative) {
    const newPct = formatFee(details.newCap);
    if (details.oldCap !== null && details.oldCap !== undefined && details.oldCap !== '') {
      text = `Relative cap ${formatFee(details.oldCap)} to ${newPct}`;
    } else {
      text = `Relative cap to ${newPct}`;
    }
  } else {
    const oldCap = details.oldCap !== null && details.oldCap !== undefined && details.oldCap !== '' ? Number(details.oldCap) : null;
    const newCap = details.newCap !== null && details.newCap !== undefined && details.newCap !== '' ? Number(details.newCap) : null;

    if (oldCap !== null && newCap !== null) {
      let multStr = '';
      if (oldCap > 0 && newCap > 0 && newCap > oldCap) {
        const ratio = newCap / oldCap;
        const multVal = ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10;
        multStr = ` (x${multVal})`;
      }
      text = `Cap ${formatCompactNumber(oldCap)} to ${formatCompactNumber(newCap)}${multStr}`;
    } else if (newCap !== null) {
      text = `New cap ${formatCompactNumber(newCap)}`;
    }
  }

  return text;
}

/**
 * Builds a human-readable one-line text summary from event details object covering all 34 kinds.
 * Never outputs technical keys (functionName, txHash, validAt, configId, rawCap).
 * Returns empty string if no human details can be composed.
 */
function formatEventDetails(details, kind = '') {
  if (!details || typeof details !== 'object') return '';
  const k = String(kind || '').toLowerCase();

  // 1. Cap events
  if (k === 'pending_cap_increase' || k === 'cap_changed') {
    return formatCapDetails(details);
  }

  // 2. Fee events
  if (k === 'fee_changed' || k === 'pending_fee_change') {
    if (details.feeRecipient || details.recipient) {
      return `Recipient ${formatAddress(details.feeRecipient || details.recipient)}`;
    }
    if (details.newFee !== undefined && details.newFee !== null && details.newFee !== '') {
      if (details.oldFee !== undefined && details.oldFee !== null && details.oldFee !== '') {
        return `Fee ${formatFee(details.oldFee)} to ${formatFee(details.newFee)}`;
      }
      return `Fee ${formatFee(details.newFee)}`;
    }
    return '';
  }

  // 3. Timelock events
  if (k === 'timelock_changed' || k === 'pending_timelock_change') {
    let tlText = '';
    if (details.newTimelock !== undefined && details.newTimelock !== null && details.newTimelock !== '') {
      if (details.oldTimelock !== undefined && details.oldTimelock !== null && details.oldTimelock !== '') {
        tlText = `Timelock ${formatSeconds(details.oldTimelock)} to ${formatSeconds(details.newTimelock)}`;
      } else {
        tlText = `Timelock ${formatSeconds(details.newTimelock)}`;
      }
    }
    if (details.targetFunction) {
      return tlText ? `${details.targetFunction}: ${tlText}` : details.targetFunction;
    }
    return tlText;
  }

  // 4. Guardian events
  if (k === 'guardian_changed' || k === 'pending_guardian_change') {
    if (details.guardian && !isZeroAddress(details.guardian)) {
      return `Guardian ${formatAddress(details.guardian)}`;
    }
    return 'Guardian removed';
  }

  // 5. Curator events
  if (k === 'curator_changed') {
    return details.curator ? `Curator ${formatAddress(details.curator)}` : '';
  }

  // 6. Owner events
  if (k === 'owner_changed') {
    return details.owner ? `Owner ${formatAddress(details.owner)}` : '';
  }

  // 7. Allocator events
  if (k === 'allocator_changed' || k === 'pending_allocator_change') {
    if (details.allocator) {
      return `${details.isAllocator ? 'Enabled' : 'Removed'} ${formatAddress(details.allocator)}`;
    }
    return '';
  }

  // 8. Skim recipient events
  if (k === 'skim_recipient_changed') {
    return details.skimRecipient ? `Recipient ${formatAddress(details.skimRecipient)}` : '';
  }

  // 9. Queue events
  if (k === 'supply_queue_changed' || k === 'withdraw_queue_changed') {
    const q = details.supplyQueue || details.withdrawQueue;
    if (Array.isArray(q)) return `${q.length} market${q.length === 1 ? '' : 's'}`;
    return '';
  }

  // 10. Reallocation
  if (k === 'reallocation') {
    if (details.volumeUsd) {
      return `$${formatCompactNumber(details.volumeUsd)} volume across ${details.marketsCount || 0} markets`;
    }
    if (details.marketsCount) return `${details.marketsCount} markets`;
    return '';
  }

  // 11. Market removal / cap revoked
  if (k === 'market_removal_revoked' || k === 'cap_revoked' || k === 'pending_market_removal') {
    return details.marketLabel || (details.marketId ? formatAddress(details.marketId) : '');
  }

  // 12. Skim
  if (k === 'skim') {
    if (details.amount !== undefined && details.amount !== null && details.amount !== '') {
      return `${formatCompactNumber(details.amount)} ${details.assetSymbol || ''}`.trim();
    }
    return '';
  }

  // 13. Adapter
  if (k === 'pending_adapter_change') {
    return details.adapterAddress ? `Adapter ${formatAddress(details.adapterAddress)}` : '';
  }

  // 14. Gate
  if (k === 'pending_gate_change') {
    if (details.gate && !isZeroAddress(details.gate)) {
      return `Gate ${formatAddress(details.gate)}`;
    }
    return 'Gate disabled';
  }

  // 15. Penalty
  if (k === 'pending_force_deallocate_penalty') {
    if (details.penalty !== null && details.penalty !== undefined && details.penalty !== '') {
      const pen = `Penalty ${formatFee(details.penalty)}`;
      return details.adapterAddress ? `${pen} (${formatAddress(details.adapterAddress)})` : pen;
    }
    return '';
  }

  // 16. Abdicate
  if (k === 'pending_abdicate') {
    return details.targetFunction || (details.selector ? formatAddress(details.selector) : '');
  }

  // 17. Verdict transitions
  if (k === 'verdict_worsened' || k === 'verdict_improved') {
    if (details.previousVerdict && details.currentVerdict) {
      return `${String(details.previousVerdict).toUpperCase()} to ${String(details.currentVerdict).toUpperCase()}`;
    }
    return '';
  }

  // 18. MQI dropped
  if (k === 'mqi_dropped') {
    if (details.previousMqi !== undefined && details.currentMqi !== undefined) {
      const dropStr = details.drop !== undefined ? ` (-${details.drop}%)` : '';
      return `${details.previousMqi}% to ${details.currentMqi}%${dropStr}`;
    }
    return '';
  }

  // 19. Bad debt
  if (k === 'bad_debt_appeared') {
    const bd = formatCompactNumber(details.badDebtUsd);
    const m = details.marketLabel || (details.marketKey ? formatAddress(details.marketKey) : '');
    return bd ? `$${bd} bad debt${m ? ` (${m})` : ''}` : m;
  }

  // 20. Flagged collateral
  if (k === 'flagged_collateral_added') {
    const sym = details.collateralSymbol || 'Flagged';
    const sup = formatCompactNumber(details.supplyUsd);
    return sup ? `${sym} ($${sup} supply)` : sym;
  }

  // 21. TVL drop
  if (k === 'tvl_drop') {
    if (details.previousTvlUsd !== undefined && details.currentTvlUsd !== undefined) {
      return `$${formatCompactNumber(details.previousTvlUsd)} to $${formatCompactNumber(details.currentTvlUsd)} (-${details.dropPercent}%)`;
    }
    return '';
  }

  // 22. Exit liquidity low
  if (k === 'exit_liquidity_low') {
    if (details.previousExitPercent !== undefined && details.currentExitPercent !== undefined) {
      return `${details.previousExitPercent}% to ${details.currentExitPercent}%`;
    }
    return '';
  }

  // 23. Delisted
  if (k === 'vault_delisted') {
    return 'Delisted from Morpho registry';
  }

  // 24. Collateral class share crossed
  if (k === 'collateral_class_share_crossed') {
    if (details.previousLevel && details.currentLevel) {
      return `${details.previousLevel} to ${details.currentLevel}`;
    }
    return '';
  }

  // 25. Collateral research tier changed
  if (k === 'collateral_tier_changed') {
    if (details.previousTier !== undefined && details.currentTier !== undefined) {
      return `${details.collateralSymbol || 'Collateral'}: tier ${details.previousTier} to ${details.currentTier} (AI research)`;
    }
    return '';
  }

  // Semantic fallbacks if kind was omitted or unrecognized
  if (details.summary) return String(details.summary);
  if (details.message) return String(details.message);
  if (details.newCap !== undefined || details.oldCap !== undefined) {
    return formatCapDetails(details);
  }
  if (details.newFee !== undefined || details.oldFee !== undefined || details.feeRecipient || details.recipient) {
    if (details.feeRecipient || details.recipient) return `Recipient ${formatAddress(details.feeRecipient || details.recipient)}`;
    if (details.oldFee !== undefined && details.newFee !== undefined) return `Fee ${formatFee(details.oldFee)} to ${formatFee(details.newFee)}`;
    return `Fee ${formatFee(details.newFee)}`;
  }
  if (details.newTimelock !== undefined || details.oldTimelock !== undefined) {
    if (details.oldTimelock !== undefined && details.newTimelock !== undefined) {
      return `Timelock ${formatSeconds(details.oldTimelock)} to ${formatSeconds(details.newTimelock)}`;
    }
    return `Timelock ${formatSeconds(details.newTimelock)}`;
  }
  if (details.previousVerdict && details.currentVerdict) {
    return `${String(details.previousVerdict).toUpperCase()} to ${String(details.currentVerdict).toUpperCase()}`;
  }
  if (details.oldVerdict && details.newVerdict) {
    return `${String(details.oldVerdict).toUpperCase()} to ${String(details.newVerdict).toUpperCase()}`;
  }
  if (details.marketLabel) {
    if (details.deltaPercentagePoints !== undefined) {
      const sign = Number(details.deltaPercentagePoints) > 0 ? '+' : '';
      return `${details.marketLabel} (${sign}${details.deltaPercentagePoints}%)`;
    }
    return String(details.marketLabel);
  }
  if (details.guardian) return `Guardian ${formatAddress(details.guardian)}`;
  if (details.curator) return `Curator ${formatAddress(details.curator)}`;
  if (details.owner) return `Owner ${formatAddress(details.owner)}`;

  return '';
}

/**
 * Formats human readable age since last fetch.
 */
function formatUpdatedAge(lastFetchTimestamp, nowMs = Date.now()) {
  if (!lastFetchTimestamp) return '';
  const min = Math.max(0, Math.floor((nowMs - lastFetchTimestamp) / 60000));
  if (min <= 0) return 'Updated just now';
  if (min === 1) return 'Updated 1 min ago';
  return `Updated ${min} min ago`;
}

/**
 * Returns allowed event kinds list. Reallocations are excluded by default.
 */
export function getEventKinds(includeReallocation = false) {
  return includeReallocation ? [...EVENT_KINDS] : EVENT_KINDS.filter(k => k !== 'reallocation');
}

/**
 * Validates canonical 0x-prefixed 40-character hex address.
 */
function isValidAddress(address) {
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address.trim());
}

/**
 * Splits an array into chunks of specified size.
 */
function chunkArray(array, size = 50) {
  if (!Array.isArray(array) || array.length === 0) return [];
  const s = Math.max(1, Number(size) || 50);
  const chunks = [];
  for (let i = 0; i < array.length; i += s) {
    chunks.push(array.slice(i, i + s));
  }
  return chunks;
}

/**
 * Merges multiple lists of event objects, deduplicating by event ID and sorting.
 */
function mergeEvents(listOfArrays, isUpcoming = false) {
  const byId = new Map();
  for (const arr of (listOfArrays || [])) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item && item.id !== undefined && item.id !== null) {
        byId.set(item.id, item);
      }
    }
  }
  const merged = [...byId.values()];
  if (isUpcoming) {
    merged.sort((a, b) => {
      const va = Number(a.valid_at ?? a.validAt ?? 0);
      const vb = Number(b.valid_at ?? b.validAt ?? 0);
      return va !== vb ? va - vb : Number(a.id) - Number(b.id);
    });
  } else {
    merged.sort((a, b) => {
      const oa = Number(a.occurred_at ?? a.occurredAt ?? 0);
      const ob = Number(b.occurred_at ?? b.occurredAt ?? 0);
      return oa !== ob ? ob - oa : Number(b.id) - Number(a.id);
    });
  }
  return merged;
}

/**
 * Excludes events with status 'pending' from History (keeps 'final', 'applied', 'revoked').
 */
function filterHistoryEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.filter(e => e && String(e.status || '').toLowerCase() !== 'pending');
}

const SEVERITY_RANK = Object.freeze({
  critical: 3,
  warning: 2,
  info: 1
});

/**
 * Groups events with identical vault + kind + status + details.txHash into a single row.
 * Title has suffix ' xN', severity is highest in group, details are from worst event,
 * time is nearest validAt or newest occurred_at.
 */
function groupEvents(events, isUpcoming = false) {
  if (!Array.isArray(events) || events.length === 0) return [];

  const groups = new Map();

  for (const ev of events) {
    if (!ev) continue;
    const vault = String(ev.vault_address || ev.vaultAddress || '').trim().toLowerCase();
    const kind = String(ev.kind || '');
    const status = String(ev.status || '');
    const txHash = String(ev.details?.txHash || ev.tx_hash || ev.txHash || '').trim().toLowerCase();

    const groupKey = txHash
      ? `${vault}:${kind}:${status}:${txHash}`
      : `single:${ev.id ?? Math.random()}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(ev);
  }

  const result = [];
  for (const grp of groups.values()) {
    if (grp.length === 1) {
      result.push(grp[0]);
      continue;
    }

    const grpSorted = [...grp].sort((a, b) => {
      const ra = SEVERITY_RANK[String(a.severity || 'info').toLowerCase()] || 1;
      const rb = SEVERITY_RANK[String(b.severity || 'info').toLowerCase()] || 1;
      return rb - ra;
    });

    const worstEvent = grpSorted[0];
    const count = grp.length;

    const validAts = grp.map(e => Number(e.valid_at ?? e.validAt)).filter(Number.isFinite);
    const nearestValidAt = validAts.length > 0 ? Math.min(...validAts) : (worstEvent.valid_at ?? null);

    const occurredAts = grp.map(e => Number(e.occurred_at ?? e.occurredAt)).filter(Number.isFinite);
    const newestOccurredAt = occurredAts.length > 0 ? Math.max(...occurredAts) : (worstEvent.occurred_at ?? null);

    const detectedAts = grp.map(e => Number(e.detected_at ?? e.detectedAt)).filter(Number.isFinite);
    const newestDetectedAt = detectedAts.length > 0 ? Math.max(...detectedAts) : (worstEvent.detected_at ?? null);

    const rawTitle = worstEvent.title || grp[0].title || '';
    const cleanTitle = rawTitle.replace(/\s+x\d+$/, '');
    const title = `${cleanTitle} x${count}`;

    result.push({
      ...worstEvent,
      id: worstEvent.id,
      title,
      severity: worstEvent.severity,
      details: worstEvent.details,
      valid_at: nearestValidAt,
      occurred_at: newestOccurredAt,
      detected_at: newestDetectedAt,
      groupedCount: count
    });
  }

  return result;
}

/**
 * Retrieves the last seen timestamp (unix seconds). On first visit, sets it to now.
 */
function getSeenTs() {
  let ts = seenTsMemoryFallback;
  if (ts === null) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SEEN);
      if (raw !== null) {
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed)) ts = parsed;
      }
    } catch {}
  }
  if (ts === null) {
    ts = Math.floor(Date.now() / 1000);
    setSeenTs(ts);
  }
  return ts;
}

/**
 * Stores the last seen timestamp.
 */
function setSeenTs(ts) {
  const n = Number(ts);
  seenTsMemoryFallback = n;
  try {
    localStorage.setItem(STORAGE_KEY_SEEN, String(n));
  } catch {}
}

/**
 * Retrieves show reallocations preference from localStorage.
 */
function getShowReallocations() {
  if (showReallocMemoryFallback !== null) return showReallocMemoryFallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SHOW_REALLOC);
    return raw === '1' || raw === 'true';
  } catch {
    return false;
  }
}

/**
 * Saves show reallocations preference.
 */
function setShowReallocations(show) {
  const val = Boolean(show);
  showReallocMemoryFallback = val;
  try {
    localStorage.setItem(STORAGE_KEY_SHOW_REALLOC, val ? '1' : '0');
  } catch {}
}

/**
 * Counts unseen events (detected_at > seenTs, critical/warning, non-hidden kinds).
 * Deduplicates pending and past events by id so pending items are not counted twice.
 */
function countUnseenEvents(events, seenTs, includeReallocation = false) {
  const byId = new Map();
  for (const e of (events || [])) {
    if (e && e.id !== undefined && e.id !== null) byId.set(e.id, e);
  }
  let count = 0;
  let hasCritical = false;
  const cutoff = Number(seenTs);

  for (const ev of byId.values()) {
    const detectedAt = Number(ev.detected_at ?? ev.detectedAt ?? 0);
    if (detectedAt <= cutoff) continue;
    const sev = String(ev.severity || '').toLowerCase();
    if (sev !== 'critical' && sev !== 'warning') continue;
    if (!includeReallocation && ev.kind === 'reallocation') continue;
    count++;
    if (sev === 'critical') hasCritical = true;
  }

  return {
    count,
    hasCritical,
    highestSeverity: hasCritical ? 'critical' : (count > 0 ? 'warning' : null)
  };
}

/**
 * Builds URL query for GET /api/events.
 */
export function buildEventsUrl({ addresses = [], kinds = [], limit = null, before = null } = {}) {
  const params = new URLSearchParams();
  const validAddrs = (Array.isArray(addresses) ? addresses : []).filter(isValidAddress);
  if (validAddrs.length > 0) {
    params.set('addresses', validAddrs.join(','));
  }
  if (Array.isArray(kinds) && kinds.length > 0) {
    params.set('kinds', kinds.join(','));
  }
  if (limit) params.set('limit', String(limit));
  if (before) params.set('before', String(before));
  const qs = params.toString();
  return `/api/events${qs ? '?' + qs : ''}`;
}

/**
 * Builds URL query for GET /api/events/pending.
 */
export function buildPendingEventsUrl({ addresses = [], kinds = [], limit = null } = {}) {
  const params = new URLSearchParams();
  const validAddrs = (Array.isArray(addresses) ? addresses : []).filter(isValidAddress);
  if (validAddrs.length > 0) {
    params.set('addresses', validAddrs.join(','));
  }
  if (Array.isArray(kinds) && kinds.length > 0) {
    params.set('kinds', kinds.join(','));
  }
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return `/api/events/pending${qs ? '?' + qs : ''}`;
}

/**
 * Builds URL for GET /api/events/feed.atom with at most 50 favorites.
 */
export function buildAtomFeedUrl(addresses = []) {
  const valid = (Array.isArray(addresses) ? addresses : []).filter(isValidAddress).slice(0, 50);
  if (valid.length === 0) return '';
  return `/api/events/feed.atom?addresses=${valid.join(',')}`;
}

/**
 * Pure row view-model creator.
 */
function buildEventRowViewModel(event, vaultLookup, nowSec = Math.floor(Date.now() / 1000), isUpcoming = false) {
  if (!event) return null;
  const addr = event.vault_address || event.vaultAddress || '';
  const vault = typeof vaultLookup === 'function' ? vaultLookup(addr) : null;
  const sevRaw = String(event.severity || 'info').toLowerCase();
  const sev = (sevRaw === 'critical' || sevRaw === 'warning') ? sevRaw.toUpperCase() : 'INFO';
  const chainId = Number(vault?.chainId ?? event.chain_id ?? event.chainId ?? 1);
  const chainName = deps.formatChainName ? deps.formatChainName(chainId) : `CHAIN ${chainId}`;
  const chainClass = deps.getChainClass ? deps.getChainClass(chainId) : '';
  const vaultName = vault?.name || event.vault_name || event.vaultName || 'Unknown Vault';
  const title = String(event.title || '');
  const detail = formatEventDetails(event.details, event.kind);
  const validAt = event.valid_at ?? event.validAt ?? null;
  const occurredAt = event.occurred_at ?? event.occurredAt ?? null;
  const statusRaw = String(event.status || 'final').toLowerCase();
  const statusLabel = (statusRaw === 'applied' || statusRaw === 'revoked') ? statusRaw : '';

  return {
    id: event.id,
    vault,
    vaultAddress: addr,
    isClickable: Boolean(vault),
    severity: sev,
    severityRaw: sevRaw,
    status: statusRaw,
    statusLabel,
    chainId,
    chainName,
    chainClass,
    vaultName,
    title,
    detail,
    isUpcoming,
    isExecutable: isUpcoming && validAt !== null && Number(validAt) <= Number(nowSec),
    countdown: isUpcoming ? formatCountdown(validAt, nowSec) : '',
    activeTime: isUpcoming ? formatActiveTime(validAt) : '',
    relativeTime: !isUpcoming ? formatRelativeTime(occurredAt, nowSec) : '',
    fullTime: !isUpcoming ? formatFullDateTime(occurredAt) : ''
  };
}

/**
 * Renders a single focusable li row with safe HTML escaping.
 */
function renderActivityRow(vm, onRowClick) {
  if (!vm) return document.createElement('li');
  const li = document.createElement('li');
  const escape = deps.escapeHtml || (s => String(s ?? ''));

  if (vm.isClickable) {
    li.className = 'activity-row is-clickable';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', `${vm.severity}: ${vm.vaultName} - ${vm.title}`);
    li.addEventListener('click', () => {
      if (onRowClick) onRowClick(vm.vault);
    });
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (onRowClick) onRowClick(vm.vault);
      }
    });
  } else {
    li.className = 'activity-row not-clickable';
    li.removeAttribute('tabindex');
  }

  const rightHtml = vm.isUpcoming
    ? (vm.isExecutable
        ? `<span class="activity-time-countdown executable">executable now</span><span class="activity-time-sub">${escape(vm.activeTime)}</span>`
        : `<span class="activity-time-countdown">${escape(vm.countdown)}</span><span class="activity-time-sub">${escape(vm.activeTime)}</span>`)
    : `<span class="activity-time-rel" title="${escape(vm.fullTime)}">${escape(vm.relativeTime)}</span>`;

  li.innerHTML = `
    <div class="activity-row-left">
      <div class="activity-row-header">
        <span class="activity-severity activity-sev-${escape(vm.severityRaw)}">
          <span class="activity-sev-dot" aria-hidden="true"></span>
          <span class="activity-sev-label">${escape(vm.severity)}</span>
        </span>
        <span class="vault-chain-badge ${escape(vm.chainClass)}">${escape(vm.chainName)}</span>
        <span class="activity-vault-name" title="${escape(vm.vaultName)}">${escape(vm.vaultName)}</span>
        ${vm.statusLabel ? `<span class="activity-status-tag status-${escape(vm.statusLabel)}">${escape(vm.statusLabel)}</span>` : ''}
      </div>
      <div class="activity-event-title">${escape(vm.title)}</div>
      ${vm.detail ? `<div class="activity-event-detail" title="${escape(vm.detail)}">${escape(vm.detail)}</div>` : ''}
    </div>
    <div class="activity-row-right">
      ${rightHtml}
    </div>
  `;

  return li;
}

/**
 * Updates unread badge on the bell button.
 */
function updateActivityBadge(unseenInfo) {
  const badge = deps.DOM.activityBadge || document.getElementById('explorer-activity-badge');
  const btn = deps.DOM.activityBtn || document.getElementById('explorer-activity-btn');
  if (!btn) return;

  if (isPanelOpen || !unseenInfo || unseenInfo.count === 0) {
    if (badge) {
      badge.textContent = '0';
      badge.classList.add('hidden');
      badge.classList.remove('critical');
    }
    btn.setAttribute('aria-label', 'Vault activity');
    btn.title = 'Vault activity';
    return;
  }

  const { count, highestSeverity, hasCritical } = unseenInfo;
  if (badge) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
    if (hasCritical) badge.classList.add('critical');
    else badge.classList.remove('critical');
  }
  const label = `Vault activity, ${count} unseen, ${highestSeverity}`;
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

/**
 * Renders the contents of the activity panel according to current state.
 */
function renderActivityPanel() {
  const list = document.getElementById('activity-events-list');
  const container = document.getElementById('activity-list-container');
  const upcomingCount = document.getElementById('activity-upcoming-count');
  const scopeFav = document.getElementById('activity-scope-fav');
  const scopeAll = document.getElementById('activity-scope-all');
  const tabUpcoming = document.getElementById('activity-tab-upcoming');
  const tabHistory = document.getElementById('activity-tab-history');
  const updatedAt = document.getElementById('activity-updated-at');
  const atomLink = document.getElementById('activity-atom-link');
  const reallocCb = document.getElementById('activity-show-realloc-cb');

  if (upcomingCount) {
    upcomingCount.textContent = `(${cachedPendingEvents.length})`;
  }

  // Synchronize scope buttons
  if (scopeFav && scopeAll) {
    const isFav = activeScope === 'favorites';
    scopeFav.classList.toggle('active', isFav);
    scopeFav.setAttribute('aria-pressed', isFav ? 'true' : 'false');
    scopeAll.classList.toggle('active', !isFav);
    scopeAll.setAttribute('aria-pressed', !isFav ? 'true' : 'false');
  }

  // Synchronize tabs
  if (tabUpcoming && tabHistory) {
    const isUp = activeTab === 'upcoming';
    tabUpcoming.classList.toggle('active', isUp);
    tabUpcoming.setAttribute('aria-selected', isUp ? 'true' : 'false');
    tabHistory.classList.toggle('active', !isUp);
    tabHistory.setAttribute('aria-selected', !isUp ? 'true' : 'false');
  }

  // Footer state
  if (reallocCb) {
    reallocCb.checked = getShowReallocations();
  }
  if (updatedAt) {
    updatedAt.textContent = formatUpdatedAge(lastFetchTs);
  }
  if (atomLink) {
    const favs = (deps.getPinnedAddresses ? deps.getPinnedAddresses() : []).filter(isValidAddress);
    if (activeScope === 'favorites' && favs.length > 0) {
      atomLink.href = buildAtomFeedUrl(favs);
      atomLink.classList.remove('hidden');
    } else {
      atomLink.classList.add('hidden');
      atomLink.removeAttribute('href');
    }
  }

  if (!list) return;
  list.innerHTML = '';

  // 1. Loading state
  if (isLoading && cachedPendingEvents.length === 0 && cachedHistoryEvents.length === 0) {
    list.innerHTML = '<li class="activity-state-loading">Loading activity...</li>';
    return;
  }

  // 2. Error state
  if (fetchError && cachedPendingEvents.length === 0 && cachedHistoryEvents.length === 0) {
    list.innerHTML = `
      <li class="activity-state-error">
        <span class="activity-error-msg">${(deps.escapeHtml || String)(fetchError)}</span>
        <button type="button" class="activity-retry-btn">Retry</button>
      </li>
    `;
    const btn = list.querySelector('.activity-retry-btn');
    if (btn) btn.addEventListener('click', () => fetchActivityData(true));
    return;
  }

  // 3. Empty favorites state
  const pinned = (deps.getPinnedAddresses ? deps.getPinnedAddresses() : []).filter(isValidAddress);
  if (activeScope === 'favorites' && pinned.length === 0) {
    list.innerHTML = `
      <li class="activity-state-empty">
        <p class="activity-empty-title">Pin vaults with the star to follow them here</p>
        <button type="button" class="activity-switch-scope-btn">Browse all vaults</button>
      </li>
    `;
    const btn = list.querySelector('.activity-switch-scope-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        activeScope = 'all';
        fetchActivityData(true);
      });
    }
    return;
  }

  // 4. Data lists
  const rawEvents = activeTab === 'upcoming' ? cachedPendingEvents : cachedHistoryEvents;
  const currentEvents = groupEvents(rawEvents, activeTab === 'upcoming');
  if (currentEvents.length === 0) {
    const emptyMsg = activeTab === 'upcoming' ? 'No upcoming changes' : 'No events yet';
    list.innerHTML = `<li class="activity-state-empty"><p class="activity-empty-title">${emptyMsg}</p></li>`;
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const isUpcoming = activeTab === 'upcoming';
  const frag = document.createDocumentFragment();

  for (const ev of currentEvents) {
    const vm = buildEventRowViewModel(ev, deps.getVault, nowSec, isUpcoming);
    const rowEl = renderActivityRow(vm, (vault) => {
      const pos = deps.getSphereParticlePos ? deps.getSphereParticlePos(vault.address) : null;
      if (deps.openVaultAudit) deps.openVaultAudit(vault, pos);
    });
    frag.appendChild(rowEl);
    list.appendChild(rowEl);
  }
  if (!list.innerHTML && currentEvents.length > 0) {
    list.innerHTML = currentEvents.map(ev => {
      const vm = buildEventRowViewModel(ev, deps.getVault, nowSec, isUpcoming);
      return `<li class="activity-row">${(deps.escapeHtml || String)(vm.title)}</li>`;
    }).join('');
  }
}

/**
 * Opens the activity panel, replaces explorer filters & list, and marks all items seen.
 */
export function openActivityPanel() {
  isPanelOpen = true;
  const btn = deps.DOM.activityBtn || document.getElementById('explorer-activity-btn');
  const panel = deps.DOM.activityPanel || document.getElementById('activity-panel');
  const heading = deps.DOM.explorerHeading || document.querySelector('.explorer-heading');

  if (btn) {
    btn.classList.add('on');
    btn.setAttribute('aria-expanded', 'true');
  }
  if (panel) panel.classList.remove('hidden');
  if (heading) heading.textContent = 'Vault Activity';

  // Hide search, filter grid, chips, and vaults list
  if (deps.DOM.explorerSearchBox) deps.DOM.explorerSearchBox.classList.add('hidden');
  if (deps.DOM.explorerFiltersGrid) deps.DOM.explorerFiltersGrid.classList.add('hidden');
  if (deps.DOM.activeFilterChips) deps.DOM.activeFilterChips.classList.add('hidden');
  if (deps.DOM.explorerVaultsList) deps.DOM.explorerVaultsList.classList.add('hidden');

  // Mark all unread seen upon opening
  setSeenTs(Math.floor(Date.now() / 1000));
  updateActivityBadge({ count: 0, highestSeverity: null, hasCritical: false });

  // If data is older than 60s or empty, refetch
  if (Date.now() - lastFetchTs > 60000 || (cachedPendingEvents.length === 0 && cachedHistoryEvents.length === 0)) {
    fetchActivityData();
  } else {
    renderActivityPanel();
  }
}

/**
 * Closes the activity panel and returns focus to the bell button.
 */
export function closeActivityPanel() {
  isPanelOpen = false;
  const btn = deps.DOM.activityBtn || document.getElementById('explorer-activity-btn');
  const panel = deps.DOM.activityPanel || document.getElementById('activity-panel');
  const heading = deps.DOM.explorerHeading || document.querySelector('.explorer-heading');

  if (btn) {
    btn.classList.remove('on');
    btn.setAttribute('aria-expanded', 'false');
  }
  if (panel) panel.classList.add('hidden');
  if (heading) heading.textContent = 'Vaults Explorer';

  // Restore search, filter grid, and vaults list
  if (deps.DOM.explorerSearchBox) deps.DOM.explorerSearchBox.classList.remove('hidden');
  if (deps.DOM.explorerFiltersGrid) deps.DOM.explorerFiltersGrid.classList.remove('hidden');
  if (deps.DOM.explorerVaultsList) deps.DOM.explorerVaultsList.classList.remove('hidden');

  // Return focus to the bell button
  if (btn && typeof btn.focus === 'function') {
    btn.focus();
  }
}

/**
 * Toggles the open/closed state of the activity panel.
 */
export function toggleActivityPanel() {
  if (isPanelOpen) closeActivityPanel();
  else openActivityPanel();
}

/**
 * Fetches events from API for current scope (Favorites or All).
 * Chunked at 50 addresses when more than 50 favorites.
 */
async function fetchActivityData(forceRefetch = false) {
  if (!deps.apiFetch) return;
  const token = ++fetchToken;
  isLoading = true;
  fetchError = null;

  if (isPanelOpen) renderActivityPanel();

  try {
    const showRealloc = getShowReallocations();
    const kinds = getEventKinds(showRealloc);

    if (activeScope === 'favorites') {
      const allPins = (deps.getPinnedAddresses ? deps.getPinnedAddresses() : []).filter(isValidAddress);
      if (allPins.length === 0) {
        if (token !== fetchToken) return;
        cachedPendingEvents = [];
        cachedHistoryEvents = [];
        isLoading = false;
        lastFetchTs = Date.now();
        updateActivityBadge({ count: 0, highestSeverity: null, hasCritical: false });
        if (isPanelOpen) renderActivityPanel();
        return;
      }

      const chunks = chunkArray(allPins, 50);
      const pendingReqs = [];
      const historyReqs = [];

      for (const chunk of chunks) {
        const pendingUrl = buildPendingEventsUrl({ addresses: chunk, kinds, limit: 200 });
        const historyUrl = buildEventsUrl({ addresses: chunk, kinds, limit: 100 });
        pendingReqs.push(deps.apiFetch(pendingUrl).then(r => r.ok ? r.json() : { events: [] }));
        historyReqs.push(deps.apiFetch(historyUrl).then(r => r.ok ? r.json() : { events: [] }));
      }

      const [pendingResList, historyResList] = await Promise.all([
        Promise.all(pendingReqs),
        Promise.all(historyReqs)
      ]);

      if (token !== fetchToken) return;

      const mergedPending = mergeEvents(pendingResList.map(r => r.events || []), true);
      const mergedHistory = mergeEvents(historyResList.map(r => r.events || []), false);

      cachedPendingEvents = mergedPending;
      cachedHistoryEvents = filterHistoryEvents(mergedHistory);
      lastFetchTs = Date.now();
      isLoading = false;

      // Update badge from favorites events
      const allFavEvents = [...mergedPending, ...cachedHistoryEvents];
      const seenTs = getSeenTs();
      const unseenInfo = countUnseenEvents(allFavEvents, seenTs, showRealloc);
      updateActivityBadge(unseenInfo);

      if (isPanelOpen) renderActivityPanel();
    } else {
      // Scope: All
      const pendingUrl = buildPendingEventsUrl({ kinds, limit: 100 });
      const historyUrl = buildEventsUrl({ kinds, limit: 100 });

      const [pendingRes, historyRes] = await Promise.all([
        deps.apiFetch(pendingUrl).then(r => r.ok ? r.json() : { events: [] }),
        deps.apiFetch(historyUrl).then(r => r.ok ? r.json() : { events: [] })
      ]);

      if (token !== fetchToken) return;

      cachedPendingEvents = Array.isArray(pendingRes.events) ? pendingRes.events : [];
      cachedHistoryEvents = filterHistoryEvents(historyRes.events);
      lastFetchTs = Date.now();
      isLoading = false;

      if (isPanelOpen) renderActivityPanel();
    }
  } catch (err) {
    if (token !== fetchToken) return;
    isLoading = false;
    fetchError = 'Failed to load activity. Check your network connection.';
    if (isPanelOpen) renderActivityPanel();
  }
}

/**
 * Called when pinned favorites change in app.js.
 */
export function onFavoritesChanged() {
  fetchActivityData(true);
}

/**
 * Binds UI event listeners for the activity panel and bell button.
 */
function setupActivityEvents() {
  if (eventsBound) return;
  eventsBound = true;

  const btn = deps.DOM.activityBtn || document.getElementById('explorer-activity-btn');
  if (btn) {
    btn.addEventListener('click', () => toggleActivityPanel());
  }

  const closeBtn = document.getElementById('activity-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeActivityPanel());
  }

  // Scope selectors
  const scopeFav = document.getElementById('activity-scope-fav');
  const scopeAll = document.getElementById('activity-scope-all');
  if (scopeFav) {
    scopeFav.addEventListener('click', () => {
      if (activeScope === 'favorites') return;
      activeScope = 'favorites';
      fetchActivityData(true);
    });
  }
  if (scopeAll) {
    scopeAll.addEventListener('click', () => {
      if (activeScope === 'all') return;
      activeScope = 'all';
      fetchActivityData(true);
    });
  }

  // Tabs
  const tabUpcoming = document.getElementById('activity-tab-upcoming');
  const tabHistory = document.getElementById('activity-tab-history');

  const switchTab = (newTab) => {
    if (activeTab === newTab) return;
    activeTab = newTab;
    renderActivityPanel();
  };

  if (tabUpcoming) {
    tabUpcoming.addEventListener('click', () => switchTab('upcoming'));
    tabUpcoming.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        tabHistory?.focus();
        switchTab('history');
      }
    });
  }
  if (tabHistory) {
    tabHistory.addEventListener('click', () => switchTab('history'));
    tabHistory.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        tabUpcoming?.focus();
        switchTab('upcoming');
      }
    });
  }

  // Reallocations checkbox
  const reallocCb = document.getElementById('activity-show-realloc-cb');
  if (reallocCb) {
    reallocCb.addEventListener('change', () => {
      setShowReallocations(reallocCb.checked);
      fetchActivityData(true);
    });
  }

  // Global Esc key to close panel
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isPanelOpen) {
      e.preventDefault();
      closeActivityPanel();
    }
  });

  // Background pause & refetch on visibility change
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      const threshold = isPanelOpen ? 60000 : 300000;
      if (Date.now() - lastFetchTs > threshold) {
        fetchActivityData();
      }
    }
  });

  // Periodic polling every 5 minutes (300,000 ms)
  const scheduleTimer = () => {
    if (periodicTimer) clearTimeout(periodicTimer);
    periodicTimer = setTimeout(async () => {
      if (!document.hidden) {
        await fetchActivityData();
      }
      scheduleTimer();
    }, 300000);
  };
  scheduleTimer();
}

/**
 * Initializes activity controller with runtime dependencies.
 */
export async function initActivity(dependencies = {}) {
  deps = Object.assign(deps, dependencies);
  setupActivityEvents();
  // Initial fetch for unseen count badge
  return fetchActivityData();
}
