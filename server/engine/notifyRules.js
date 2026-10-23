import { CONFIG } from '../config.js';

const CAP_TVL_SHARE_ALERT = 0.05;
const SEVERITY_LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info' };
const MESSAGE_LIMIT = 3800;

const CHAIN_NAMES = Object.fromEntries(Object.entries(CONFIG.chains).map(([name, id]) => [id, name[0].toUpperCase() + name.slice(1)]));
/** Display name of a chain id, or null when the chain is unknown. */
export const chainName = id => CHAIN_NAMES[id] ?? null;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
export const shortAddr = a => `${a.slice(0, 6)}...${a.slice(-4)}`;
const percent = fraction => `${Math.round(fraction * 1000) / 10}%`;
// A share of vault assets above 1000% is a cap set to "no limit", not a number worth printing
const shareText = share => (share >= 10 ? 'over 1000%' : percent(share));

/** Escapes text for Telegram's HTML parse mode. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Every bot message has this shape: a bold title, then short paragraphs separated by a blank line. */
export const message = (title, ...blocks) => [`<b>${escapeHtml(title)}</b>`, ...blocks.filter(Boolean)].join('\n\n');

/**
 * Splits a long list into messages that each fit one Telegram message. Every part starts with `header`;
 * a block is never cut in half.
 */
export function paginate(header, blocks) {
  const messages = [];
  let current = header;
  for (const block of blocks) {
    if (current.length + block.length + 2 > MESSAGE_LIMIT && current !== header) {
      messages.push(current);
      current = header;
    }
    current += `

${block}`;
  }
  messages.push(current);
  return messages;
}

/** Vault name with its chain on the first line, short address on the second. */
export const vaultBlock = (name, chainId, address) => `<b>${escapeHtml(name || 'Vault')}</b>${chainName(chainId) ? `  |  ${escapeHtml(chainName(chainId))}` : ''}\n<code>${shortAddr(address)}</code>`;

/** Kyiv wall-clock time, the zone of the daily digest: 2026-10-23 09:00 */
export function kyivTime(seconds) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(seconds * 1000)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function compact(n) {
  if (!isNum(n)) return 'unknown';
  if (n >= 1e15) return 'unlimited';
  const one = x => x.toFixed(1).replace(/\.0$/, '');
  if (n >= 1e9) return `${one(n / 1e9)}B`;
  if (n >= 1e6) return `${one(n / 1e6)}M`;
  if (n >= 1e3) return `${one(n / 1e3)}K`;
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

const KIND_TITLE = {
  pending_cap_increase: 'Cap increase pending',
  pending_market_removal: 'Market removal pending',
  pending_guardian_change: 'Guardian change pending',
  pending_timelock_change: 'Timelock change pending',
  bad_debt_appeared: 'Bad debt appeared',
  tvl_drop: 'Large TVL outflow'
};

// One sentence on why the change matters to a depositor
const KIND_MEANING = {
  pending_cap_increase: 'The curator is raising how much the vault may put into this market. Once applied, more deposits can flow there.',
  pending_market_removal: 'The curator wants to remove this market from the vault.',
  pending_guardian_change: 'A different address would get the power to veto pending changes.',
  pending_timelock_change: 'A shorter timelock leaves depositors less time to react to future changes.',
  bad_debt_appeared: 'Borrowers owe more than their collateral covers in this market, so lenders, including this vault, can lose part of it.',
  tvl_drop: 'Depositors withdrew a large part of the vault in 24 hours.'
};

// The kind-specific line: what changes and by how much
function detailLine(event, d) {
  if (event.kind === 'pending_cap_increase') {
    const rel = d.capKind === 'relative';
    const fmt = v => (v === null || v === undefined ? 'not set' : rel ? percent(v) : compact(v));
    // A relative cap is already a share of vault assets, so it needs no "adds" part
    return `Cap: from ${fmt(d.oldCap)} to ${fmt(d.newCap)}${rel ? ' of vault assets' : isNum(d.tvlShareAdded) ? `, adds ${shareText(d.tvlShareAdded)} of vault assets` : ''}`;
  }
  if (event.kind === 'pending_timelock_change') return `Timelock: ${duration(d.oldTimelock)} to ${duration(d.newTimelock)}`;
  if (event.kind === 'bad_debt_appeared') return `Bad debt: $${compact(d.badDebtUsd)} in a market holding $${compact(d.supplyUsd)} of the vault${d.afterDataGap ? ' (first seen after a gap in data, may be older)' : ''}`;
  if (event.kind === 'tvl_drop') return `TVL: $${compact(d.previousTvlUsd)} to $${compact(d.currentTvlUsd)}${isNum(d.dropPercent) ? ` (-${Math.round(d.dropPercent * 10) / 10}%)` : ''}`;
  return '';
}

function deadlineBlock(validAt, nowSec) {
  const left = validAt - nowSec;
  return left > 0
    ? `<b>Takes effect</b> ${kyivTime(validAt)} Kyiv time (in ${duration(left)}).\nDepositors can still withdraw until then.`
    : '<b>The timelock has passed.</b> The change can be applied at any moment.';
}

const severityLine = event => `Severity: ${SEVERITY_LABEL[event.severity] || 'Info'}`;

/** Telegram HTML message for an urgent event. `vaultName` may be null. */
export function formatUrgent(event, vaultName, nowSec = Math.floor(Date.now() / 1000)) {
  const detail = detailLine(event, parseDetails(event));
  const blocks = [
    vaultBlock(vaultName, event.chain_id, event.vault_address),
    [detail && escapeHtml(detail), KIND_MEANING[event.kind], severityLine(event)].filter(Boolean).join('\n')
  ];
  if (event.status === 'pending' && isNum(event.valid_at)) blocks.push(deadlineBlock(event.valid_at, nowSec));
  return message(KIND_TITLE[event.kind] || event.title, ...blocks);
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
    // The message title already says "pending", so the line starts with the change itself
    const title = String(e.title).replace(/^Pending\s+/i, '').replace(/^./, c => c.toUpperCase());
    return `<b>${escapeHtml(title)}</b>${detail ? `\n${escapeHtml(detail)}` : ''}`;
  });
  if (events.length > GROUP_LINES_SHOWN) items.push(`and ${events.length - GROUP_LINES_SHOWN} more`);
  const blocks = [vaultBlock(vaultName, worst.chain_id, worst.vault_address), items.join('\n\n'), [KIND_MEANING[worst.kind], severityLine(worst)].filter(Boolean).join('\n')];
  const deadlines = events.filter(e => e.status === 'pending' && isNum(e.valid_at)).map(e => e.valid_at);
  if (deadlines.length > 0) blocks.push(deadlineBlock(Math.min(...deadlines), nowSec));
  return message(`${KIND_TITLE[worst.kind] || worst.title} (${events.length} changes)`, ...blocks);
}

// Short label of a pending change in the Upcoming list; unknown kinds fall back to the stored title
const upcomingLabel = e => KIND_TITLE[e.kind]?.replace(/ pending$/, '') || String(e.title || e.kind).replace(/^Pending\s+/i, '').replace(/\s*\(.*\)$/, '');

function upcomingItem(group, nowSec) {
  const first = group[0];
  // The change that adds the most vault assets describes the group (a relative and an absolute cap come in one transaction)
  const shares = group.map(e => parseDetails(e).tvlShareAdded).filter(isNum);
  let note = '';
  if (first.kind === 'pending_cap_increase') {
    note = group.some(e => parseDetails(e).capWasZero === true) ? 'opens a new cap' : (shares.length ? `adds ${shareText(Math.max(...shares))} of vault assets` : '');
  } else if (first.kind === 'pending_timelock_change') {
    note = detailLine(first, parseDetails(first)).replace('Timelock: ', '');
  }
  const when = first.valid_at <= nowSec ? '' : `takes effect ${kyivTime(first.valid_at)}`;
  return `- ${escapeHtml(upcomingLabel(first))}${[note, when].filter(Boolean).map(x => `, ${escapeHtml(x)}`).join('')}`;
}

// Identical lines (a collateral cap and a market cap read the same) become one line with a count
function collapse(lines) {
  const counts = new Map();
  for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);
  return [...counts].map(([l, n]) => (n > 1 ? `${l} (x${n})` : l));
}

/** Pending events by vault, then by change: one transaction (or one event without a hash) is one change. */
export function groupChanges(events) {
  const vaults = new Map();
  for (const e of events) {
    if (!vaults.has(e.vault_address)) vaults.set(e.vault_address, new Map());
    const key = `${e.kind}:${parseDetails(e).txHash || e.id}`;
    const groups = vaults.get(e.vault_address);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return vaults;
}

/** How many changes are pending and how many of them can be applied right now. */
export function countChanges(events, nowSec = Math.floor(Date.now() / 1000)) {
  let total = 0;
  let ready = 0;
  for (const groups of groupChanges(events).values()) {
    for (const g of groups.values()) { total++; if (g[0].valid_at <= nowSec) ready++; }
  }
  return { total, ready };
}

/**
 * The pinned "Upcoming changes" message: pending timelock changes of the followed vaults, grouped by vault,
 * split into changes that can be applied now and changes still waiting. Times are absolute, so the text only
 * changes when the set of changes does, and the bot edits it in place instead of resending.
 * `events` are vault_events rows (status pending) with vault_name; one transaction counts as one change.
 */
export function formatUpcoming(events, followedCount, nowSec = Math.floor(Date.now() / 1000)) {
  const followed = `${followedCount} vault${followedCount === 1 ? '' : 's'} you follow`;
  if (followedCount === 0) return message('Upcoming changes', 'No vaults are selected, so there are no upcoming changes for now.', 'Star vaults on the site and their pending changes appear here. This message updates itself.');
  if (events.length === 0) return message('Upcoming changes', `Nothing is waiting for a timelock in the ${followed}. This message updates itself.`);

  const vaults = groupChanges(events);
  const earliest = groups => Math.min(...[...groups.values()].map(g => g[0].valid_at));
  const blocks = [];
  let total = 0;
  for (const groups of [...vaults.values()].sort((a, b) => earliest(a) - earliest(b))) {
    const all = [...groups.values()].sort((a, b) => a[0].valid_at - b[0].valid_at);
    const ready = all.filter(g => g[0].valid_at <= nowSec);
    const waiting = all.filter(g => g[0].valid_at > nowSec);
    const lines = [vaultBlock(all[0][0].vault_name, all[0][0].chain_id, all[0][0].vault_address)];
    if (ready.length) lines.push('<b>Can be applied now</b>', ...collapse(ready.map(g => upcomingItem(g, nowSec))));
    if (waiting.length) lines.push('<b>Waiting for the timelock</b>', ...collapse(waiting.map(g => upcomingItem(g, nowSec))));
    blocks.push(lines.join('\n'));
    total += all.length;
  }

  let text = message('Upcoming changes', `${total} pending change${total === 1 ? '' : 's'} in the ${followed}. This message updates itself.`);
  let shown = 0;
  for (const block of blocks) {
    if (text.length + block.length + 2 > MESSAGE_LIMIT) break;
    text += `\n\n${block}`;
    shown++;
  }
  if (shown < blocks.length) text += `\n\nand ${blocks.length - shown} more vault${blocks.length - shown === 1 ? '' : 's'}, see the site.`;
  return text;
}
