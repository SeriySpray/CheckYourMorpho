const CAP_TVL_SHARE_ALERT = 0.05;
const SEVERITY_LABEL = { critical: 'CRITICAL', warning: 'WARNING', info: 'INFO' };

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const shortAddr = a => `${a.slice(0, 6)}...${a.slice(-4)}`;
const percent = fraction => `${Math.round(fraction * 1000) / 10}%`;

function compact(n) {
  if (!isNum(n)) return 'unknown';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n * 100) / 100);
}

function duration(seconds) {
  if (!isNum(seconds)) return 'unknown';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}min` : `${hours}h`;
  return `${minutes}min`;
}

/**
 * True when an event is worth an immediate message: a risky change still waiting on its timelock
 * (cap increase that adds >= 5% of vault assets or opens a cap from zero, market added or removed,
 * shorter timelock, guardian change), bad debt, or a 24h TVL outflow.
 */
export function isUrgent(event) {
  if (!event) return false;
  const d = typeof event.details === 'object' && event.details ? event.details : (() => {
    try { return JSON.parse(event.details_json || '{}'); } catch { return {}; }
  })();
  switch (event.kind) {
    case 'pending_cap_increase':
      return event.status === 'pending' && (d.capWasZero === true || (isNum(d.tvlShareAdded) && d.tvlShareAdded >= CAP_TVL_SHARE_ALERT));
    case 'pending_market_removal':
    case 'pending_guardian_change':
      return event.status === 'pending';
    case 'pending_timelock_change':
      return event.status === 'pending' && event.severity === 'critical';
    case 'bad_debt_appeared':
    case 'tvl_drop':
      return true;
    default:
      return false;
  }
}

const parseDetails = event => { try { return JSON.parse(event.details_json || '{}'); } catch { return {}; } };

/** Escapes text for Telegram's HTML parse mode. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The kind-specific line: what changes and by how much
function detailLine(event, d) {
  if (event.kind === 'pending_cap_increase') {
    const rel = d.capKind === 'relative';
    const fmt = v => (v === null || v === undefined ? 'none' : rel ? percent(v) : compact(v));
    return `Cap: ${fmt(d.oldCap)} to ${fmt(d.newCap)}${isNum(d.tvlShareAdded) ? `, adds ${percent(d.tvlShareAdded)} of vault assets` : ''}`;
  }
  if (event.kind === 'pending_timelock_change') return `Timelock: ${duration(d.oldTimelock)} to ${duration(d.newTimelock)}`;
  if (event.kind === 'bad_debt_appeared') return `Bad debt: $${compact(d.badDebtUsd)} in a market holding $${compact(d.supplyUsd)} of the vault${d.afterDataGap ? ' (first seen after a gap in data, may be older)' : ''}`;
  if (event.kind === 'tvl_drop') return `TVL: $${compact(d.previousTvlUsd)} to $${compact(d.currentTvlUsd)}${isNum(d.dropPercent) ? ` (-${Math.round(d.dropPercent * 10) / 10}%)` : ''}`;
  return '';
}

function deadlineBlock(validAt, nowSec) {
  const left = validAt - nowSec;
  return left > 0
    ? `<b>Takes effect</b> ${new Date(validAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC (in ${duration(left)})\nDepositors can still withdraw until then.`
    : '<b>The timelock has passed.</b> The change can be applied at any moment.';
}

const header = (event, vaultName) => `<b>${SEVERITY_LABEL[event.severity] || 'INFO'}</b>  |  ${escapeHtml(vaultName || 'Vault')}\n<code>${shortAddr(event.vault_address)}</code>`;

/** Telegram HTML message for an urgent event. `vaultName` may be null. */
export function formatUrgent(event, vaultName, nowSec = Math.floor(Date.now() / 1000)) {
  const blocks = [header(event, vaultName), `<b>${escapeHtml(event.title)}</b>`];
  const detail = detailLine(event, parseDetails(event));
  if (detail) blocks[1] += `\n${escapeHtml(detail)}`;
  if (event.status === 'pending' && isNum(event.valid_at)) blocks.push(deadlineBlock(event.valid_at, nowSec));
  return blocks.join('\n\n');
}

const GROUP_LINES_SHOWN = 6;
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

/**
 * One message for several urgent events of the same vault and kind found together (a V2 market onboarding
 * submits a collateral cap and a market cap, each absolute and relative). A single event keeps its normal text.
 */
export function formatUrgentGroup(events, vaultName, nowSec = Math.floor(Date.now() / 1000)) {
  if (events.length === 1) return formatUrgent(events[0], vaultName, nowSec);
  const worst = events.reduce((a, e) => ((SEVERITY_RANK[e.severity] || 0) > (SEVERITY_RANK[a.severity] || 0) ? e : a));
  const items = events.slice(0, GROUP_LINES_SHOWN).map(e => {
    const detail = detailLine(e, parseDetails(e));
    return `<b>${escapeHtml(e.title)}</b>${detail ? `\n${escapeHtml(detail)}` : ''}`;
  });
  if (events.length > GROUP_LINES_SHOWN) items.push(`and ${events.length - GROUP_LINES_SHOWN} more`);
  const blocks = [header(worst, vaultName), `${events.length} changes at once`, items.join('\n\n')];
  const deadlines = events.filter(e => e.status === 'pending' && isNum(e.valid_at)).map(e => e.valid_at);
  if (deadlines.length > 0) blocks.push(deadlineBlock(Math.min(...deadlines), nowSec));
  return blocks.join('\n\n');
}
