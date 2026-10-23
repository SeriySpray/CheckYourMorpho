import crypto from 'node:crypto';
import { isUrgent, formatUrgentGroup, formatUpcoming, countChanges, groupChanges, message, vaultBlock, paginate } from '../engine/notifyRules.js';
import { buildDigest, formatDigest, digestDue } from './digestService.js';
import { describeRisk } from '../engine/digestEngine.js';

const SUB_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_VAULTS_PER_SUBSCRIPTION = 100;
const MAX_URGENT_PER_CHAT_PER_ROUND = 10;
const URGENT_LOOKBACK_SECONDS = 2 * 86400;
const SEND_GAP_MS = 1100;
const POLL_TIMEOUT_SECONDS = 25;

const SITE_URL = process.env.SITE_URL || 'https://checkyourmorpho.duckdns.org';
const SITE_BUTTON = { inline_keyboard: [[{ text: 'Open CheckYourMorpho', url: SITE_URL }]] };

/** The site opened from the bot: the code in the link makes the browser push its favorites to this chat. */
export const pairingUrl = subId => `${SITE_URL}/?tg=${encodeURIComponent(subId)}`;
const pairingButton = subId => ({ inline_keyboard: [[{ text: 'Open CheckYourMorpho and pick vaults', url: pairingUrl(subId) }]] });

const COMMANDS = [
  { command: 'status', description: 'Alert status' },
  { command: 'upcoming', description: 'Pin pending changes of your vaults' },
  { command: 'list', description: 'Vaults you follow' },
  { command: 'help', description: 'What the bot sends' },
  { command: 'pause', description: 'Pause alerts' },
  { command: 'resume', description: 'Resume alerts' },
  { command: 'stop', description: 'Unsubscribe completely' }
];

const COMMAND_LINES = '/upcoming  pinned pending changes\n/list  vaults you follow\n/status  alert status\n/pause  pause alerts';

const HELP_TEXT = message('CheckYourMorpho alerts',
  'Alerts for the vaults you star on the site. The list updates by itself when you star or unstar a vault.',
  '<b>Sent immediately</b>\n- A cap increase that adds 5% or more of vault assets, or opens a new cap\n- A market added or removed\n- A guardian change or a shorter timelock\n- Bad debt appearing in a market\n- A sharp TVL outflow (15% or more in 24 hours, at least $500K)',
  '<b>Daily digest, 09:00 Kyiv time</b>\n- Risk level and market quality changes\n- A Net APY drop against the 7-day average\n- Fee changes and delisting\n- A summary of reallocations',
  '<b>Pinned message</b>\nUpcoming changes: pending timelock changes of your vaults, grouped by vault. It stays at the top of the chat and updates itself, /upcoming refreshes it.',
  `${COMMAND_LINES}\n/resume  resume alerts\n/stop  unsubscribe completely`);

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let botUsername = null;
let liveTg = null; // the running bot's client, so the site can refresh a chat the moment its favorites change

/** Public bot info for the client: whether alerts are available and the bot to open. */
export function getBotInfo() {
  return { enabled: botUsername !== null, username: botUsername };
}

/** Minimal Telegram Bot API client (global fetch, no dependencies). A failed call throws an error with `code`. */
export function createTelegram(token, fetchImpl = globalThis.fetch) {
  async function call(method, payload = {}) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout((POLL_TIMEOUT_SECONDS + 10) * 1000)
    });
    const body = await res.json().catch(() => null);
    if (!body?.ok) throw Object.assign(new Error(body?.description || `Telegram HTTP ${res.status}`), { code: body?.error_code ?? res.status });
    return body.result;
  }
  return { call };
}

const getState = (db, key) => db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value ?? null;
const setState = (db, key, value, nowSec) => db.prepare(`
  INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`).run(key, String(value), nowSec);

/** Creates or updates a subscription from the browser. Returns { ok: false, error } for invalid input. */
export function upsertSubscription(db, subId, vaults, nowSec = Math.floor(Date.now() / 1000), replace = true) {
  if (typeof subId !== 'string' || !SUB_ID_RE.test(subId)) return { ok: false, error: 'Invalid sub_id' };
  if (!Array.isArray(vaults) || vaults.length > MAX_VAULTS_PER_SUBSCRIPTION) return { ok: false, error: `vaults must be an array of at most ${MAX_VAULTS_PER_SUBSCRIPTION} addresses` };
  if (!vaults.every(v => typeof v === 'string' && ADDRESS_RE.test(v))) return { ok: false, error: 'Invalid vault address' };
  const unique = [...new Set(vaults.map(v => v.toLowerCase()))];
  db.prepare(`
    INSERT INTO tg_subscriptions (sub_id, vaults_json, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(sub_id) DO UPDATE SET vaults_json = CASE WHEN ? THEN excluded.vaults_json ELSE vaults_json END, updated_at = excluded.updated_at
  `).run(subId, JSON.stringify(unique), nowSec, nowSec, replace ? 1 : 0);
  const row = db.prepare('SELECT chat_id FROM tg_subscriptions WHERE sub_id = ?').get(subId);
  // The favorites belong to the chat: every browser bound to it sees the change
  if (replace && row.chat_id !== null) {
    db.prepare('UPDATE tg_subscriptions SET vaults_json = ?, updated_at = ? WHERE chat_id = ? AND sub_id != ?').run(JSON.stringify(unique), nowSec, row.chat_id, subId);
  }
  return { ok: true, vaults: unique.length, connected: row.chat_id !== null };
}

/** What a browser pulls to catch up with its chat: { ok, connected, vaults } (vaults is null while the code is not bound to a chat). */
export function getSubscription(db, subId) {
  if (typeof subId !== 'string' || !SUB_ID_RE.test(subId)) return { ok: false, error: 'Invalid sub_id' };
  const row = db.prepare('SELECT chat_id, vaults_json FROM tg_subscriptions WHERE sub_id = ?').get(subId);
  const connected = Boolean(row && row.chat_id !== null);
  return { ok: true, connected, vaults: connected ? JSON.parse(row.vaults_json) : null };
}

/** Handles one Telegram update: /start <sub_id> binds the chat; /status, /list, /upcoming, /help, /pause, /resume and /stop manage it. */
export async function handleBotUpdate(db, tg, update, nowSec = Math.floor(Date.now() / 1000)) {
  const msg = update?.message;
  const chatId = msg?.chat?.id;
  const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
  if (!Number.isSafeInteger(chatId) || !text) return;
  const [command, arg] = text.split(/\s+/);
  const say = (body, markup) => tg.call('sendMessage', { chat_id: chatId, text: body, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
  const latest = () => db.prepare('SELECT * FROM tg_subscriptions WHERE chat_id = ? ORDER BY active DESC, bound_at DESC LIMIT 1').get(chatId);
  // A chat that is not connected to the site gets its own code (one per chat) and a link that carries it: the site stores it and syncs the favorites
  const pairing = () => {
    let sub = latest();
    if (!sub) {
      const subId = crypto.randomBytes(16).toString('base64url');
      upsertSubscription(db, subId, [], nowSec, false);
      db.prepare('UPDATE tg_subscriptions SET chat_id = ?, active = 1, bound_at = ? WHERE sub_id = ?').run(chatId, nowSec, subId);
      sub = { sub_id: subId };
    }
    return pairingButton(sub.sub_id);
  };
  const notConnected = () => say(message('CheckYourMorpho alerts', 'Open the site with the button below, star the vaults you follow and they sync here by themselves. Nothing else to set up.', '/help shows what the bot sends.'), pairing());

  if (/^\/start(@\w+)?$/.test(command)) {
    if (!arg || !SUB_ID_RE.test(arg)) {
      const sub = latest();
      if (sub && JSON.parse(sub.vaults_json).length) { await say(statusText(db, sub, nowSec), SITE_BUTTON); return; }
      await notConnected();
      return;
    }
    // A device joining a chat that already has favorites brings them along: the chat's list and the device's own are merged
    const previous = db.prepare('SELECT vaults_json FROM tg_subscriptions WHERE chat_id = ? AND sub_id != ? ORDER BY active DESC, bound_at DESC LIMIT 1').get(chatId, arg);
    // Another browser of the same person must not duplicate alerts: the newest binding wins
    db.prepare('UPDATE tg_subscriptions SET active = 0 WHERE chat_id = ? AND sub_id != ?').run(chatId, arg);
    // An unknown code is the browser's id whose first PUT has not arrived (or was lost): keep the chat, the next sync fills the list
    upsertSubscription(db, arg, [], nowSec, false);
    db.prepare('UPDATE tg_subscriptions SET chat_id = ?, active = 1, bound_at = ? WHERE sub_id = ?').run(chatId, nowSec, arg);
    const own = JSON.parse(db.prepare('SELECT vaults_json FROM tg_subscriptions WHERE sub_id = ?').get(arg).vaults_json);
    const merged = [...new Set([...(previous ? JSON.parse(previous.vaults_json) : []), ...own])].slice(0, MAX_VAULTS_PER_SUBSCRIPTION);
    db.prepare('UPDATE tg_subscriptions SET vaults_json = ?, updated_at = ? WHERE chat_id = ?').run(JSON.stringify(merged), nowSec, chatId);
    const n = merged.length;
    await say(message('Connected',
      `You follow ${n} vault${n === 1 ? '' : 's'}. The list follows your stars on the site.`,
      'Urgent changes arrive immediately. The daily digest comes at 09:00 Kyiv time.',
      n > 0 && 'Pending changes of your vaults are pinned at the top of this chat.',
      `${COMMAND_LINES}\n/help  what the bot sends`), SITE_BUTTON);
    if (n > 0) await syncUpcomingPin(db, tg, latest(), nowSec, true);
  } else if (/^\/help(@\w+)?$/.test(command)) {
    await say(HELP_TEXT, SITE_BUTTON);
  } else if (/^\/status(@\w+)?$/.test(command)) {
    const sub = latest();
    if (sub && JSON.parse(sub.vaults_json).length) await say(statusText(db, sub, nowSec), SITE_BUTTON); else await notConnected();
  } else if (/^\/upcoming(@\w+)?$/.test(command)) {
    const sub = latest();
    if (!sub || JSON.parse(sub.vaults_json).length === 0) { await notConnected(); return; }
    const res = await syncUpcomingPin(db, tg, sub, nowSec, true);
    if (res === 'retry') await say(message('Could not update the pinned message', 'Try /upcoming again in a minute.'));
  } else if (/^\/list(@\w+)?$/.test(command)) {
    const row = db.prepare('SELECT vaults_json FROM tg_subscriptions WHERE chat_id = ? AND active = 1').get(chatId);
    const addrs = row ? JSON.parse(row.vaults_json) : [];
    if (addrs.length === 0) {
      await say(message('No vaults followed', 'Open the site with the button below and star vaults: they appear here by themselves.'), pairing());
    } else {
      for (const page of listPages(db, addrs)) await say(page);
    }
  } else if (/^\/pause(@\w+)?$/.test(command)) {
    db.prepare('UPDATE tg_subscriptions SET active = 0 WHERE chat_id = ?').run(chatId);
    await say(message('Alerts paused', 'Nothing will be sent and the pinned Upcoming changes message stops updating.', '/resume turns alerts back on.'));
  } else if (/^\/stop(@\w+)?$/.test(command)) {
    await unsubscribe(db, tg, chatId);
    await say(message('Unsubscribed', 'The chat is disconnected, the pinned message is removed and nothing more will be sent.', 'To follow vaults again, use the Telegram button on the site: it reconnects the same list of favorites. A plain /start creates a separate list that the site does not know about.'), SITE_BUTTON);
  } else if (/^\/resume(@\w+)?$/.test(command)) {
    const sub = latest();
    if (!sub) { await notConnected(); return; }
    db.prepare('UPDATE tg_subscriptions SET active = 0 WHERE chat_id = ? AND sub_id != ?').run(chatId, sub.sub_id);
    // Resuming starts fresh: events from the pause are not replayed
    db.prepare('UPDATE tg_subscriptions SET active = 1, bound_at = ? WHERE sub_id = ?').run(nowSec, sub.sub_id);
    await say(message('Alerts resumed', 'Events from the pause are not replayed.', '/status shows the current state.'));
    if (JSON.parse(sub.vaults_json).length > 0) await syncUpcomingPin(db, tg, { ...sub, active: 1 }, nowSec);
  } else if (command.startsWith('/')) {
    await say(message('Unknown command', '/help lists what the bot can do.'));
  } else if (!latest()) {
    await notConnected();
  }
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** Pending changes (status pending, a known time) of the given vaults, soonest first. */
function pendingFor(db, addrs) {
  if (addrs.length === 0) return [];
  return db.prepare(`
    SELECT ve.*, v.name AS vault_name FROM vault_events ve LEFT JOIN vaults v ON v.address = ve.vault_address
    WHERE ve.status = 'pending' AND ve.valid_at IS NOT NULL AND lower(ve.vault_address) IN (SELECT value FROM json_each(?))
    ORDER BY ve.valid_at, ve.id
  `).all(JSON.stringify(addrs));
}

function statusText(db, sub, nowSec) {
  const addrs = JSON.parse(sub.vaults_json);
  const n = addrs.length;
  const { total, ready } = countChanges(pendingFor(db, addrs), nowSec);
  const lastDigest = getState(db, 'last_digest_date');
  return message(`Alerts ${sub.active ? 'on' : 'paused'}`,
    `Following ${n} vault${n === 1 ? '' : 's'}.`,
    `Pending changes: ${total}${ready > 0 ? ` (${ready} can be applied now)` : ''}. /upcoming shows them.`,
    `Urgent changes are sent immediately, the digest at 09:00 Kyiv time.${lastDigest ? ` Last digest: ${lastDigest}.` : ''}`,
    `${sub.active ? '/pause pauses alerts.' : '/resume turns them back on.'} /list shows the vaults.`);
}

/** The followed vaults as messages: name, chain, short address, then risk, market quality and pending changes. */
function listPages(db, addrs) {
  const meta = db.prepare('SELECT name, chain_id FROM vaults WHERE address = ?');
  const sample = db.prepare('SELECT verdict_level, verdict_reasons, mqi_percent FROM vault_samples WHERE vault_address = ? ORDER BY hour_bucket DESC LIMIT 1');
  const pending = new Map();
  for (const [addr, groups] of groupChanges(pendingFor(db, addrs))) pending.set(addr.toLowerCase(), groups.size);
  const blocks = addrs.map(a => {
    const v = meta.get(a);
    const sm = sample.get(a);
    const parts = [];
    if (sm?.verdict_level) parts.push(`Risk: ${describeRisk(String(sm.verdict_level).toLowerCase(), sm.verdict_reasons).label}`);
    if (isNum(sm?.mqi_percent)) parts.push(`Market quality ${sm.mqi_percent}%`);
    if (pending.get(a)) parts.push(`${pending.get(a)} pending change${pending.get(a) === 1 ? '' : 's'}`);
    return [vaultBlock(v?.name, v?.chain_id, a), parts.join('  |  ')].filter(Boolean).join('\n');
  });
  return paginate(message(`You follow ${addrs.length} vault${addrs.length === 1 ? '' : 's'}`), blocks);
}

/** Drops everything the bot keeps for a chat: its subscriptions, what was sent to them and the pinned Upcoming message (unpinned, left in the history). */
async function unsubscribe(db, tg, chatId) {
  const key = `tg_pin:${chatId}`;
  const saved = JSON.parse(getState(db, key) || 'null');
  if (saved?.pinned) await tg.call('unpinChatMessage', { chat_id: chatId, message_id: saved.message_id }).catch(err => console.error('[Telegram] Unpinning failed:', err.message));
  db.prepare('DELETE FROM tg_sent WHERE sub_id IN (SELECT sub_id FROM tg_subscriptions WHERE chat_id = ?)').run(chatId);
  db.prepare('DELETE FROM tg_subscriptions WHERE chat_id = ?').run(chatId);
  db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
}

const isBlocked = err => err.code === 403 || (err.code === 400 && /chat not found/i.test(err.message));
// The pinned message was deleted by the user or can no longer be edited: a new one replaces it
const isGone = err => err.code === 400 && /message to (edit|pin) not found|message can't be edited|MESSAGE_ID_INVALID/i.test(err.message);

/**
 * Keeps one pinned "Upcoming changes" message per chat: sent and pinned the first time, edited in place when the
 * set of pending changes changes, sent again if the user deleted it. The text carries absolute times only, so an
 * unchanged set costs no API call. `force` (/start and /upcoming) replaces the message with a fresh one even when nothing
 * changed: a user who cleared the chat still has the old message on Telegram's side, so the API cannot tell it is gone.
 * Returns 'skipped', 'unchanged', 'edited', 'sent', 'blocked' or 'retry'.
 */
export async function syncUpcomingPin(db, tg, sub, nowSec = Math.floor(Date.now() / 1000), force = false) {
  const addrs = JSON.parse(sub.vaults_json);
  const key = `tg_pin:${sub.chat_id}`;
  const saved = JSON.parse(getState(db, key) || 'null');
  // Without vaults nothing is sent, but a message that is already pinned must stop showing the last vaults
  if (addrs.length === 0 && !saved) return 'skipped';
  const text = formatUpcoming(addrs.length ? pendingFor(db, addrs) : [], addrs.length, nowSec);
  const hash = crypto.createHash('sha1').update(text).digest('hex');
  if (saved?.hash === hash && saved.pinned && !force) return 'unchanged';
  if (force && saved?.message_id) await tg.call('deleteMessage', { chat_id: sub.chat_id, message_id: saved.message_id }).catch(() => {});
  const payload = { chat_id: sub.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: SITE_BUTTON };
  const save = (messageId, pinned) => setState(db, key, JSON.stringify({ message_id: messageId, hash, pinned }), nowSec);
  const pin = async messageId => {
    try { await tg.call('pinChatMessage', { chat_id: sub.chat_id, message_id: messageId, disable_notification: true }); return true; } catch (err) {
      if (isBlocked(err)) throw err;
      if (isGone(err)) return 'gone'; // the chat was deleted and started again: the saved message no longer exists
      console.error('[Telegram] Pinning failed, will retry:', err.message);
      return false;
    }
  };
  try {
    if (saved && !force) {
      let result = 'unchanged';
      try {
        if (saved.hash !== hash) { await tg.call('editMessageText', { ...payload, message_id: saved.message_id }); result = 'edited'; }
      } catch (err) {
        if (isGone(err)) saved.message_id = null;
        else if (!/not modified/i.test(err.message)) throw err;
      }
      if (saved.message_id !== null) {
        const pinned = saved.pinned || await pin(saved.message_id);
        if (pinned !== 'gone') { save(saved.message_id, pinned); return result; }
      }
    }
    const sent = await tg.call('sendMessage', payload);
    save(sent.message_id, false); // remembered before pinning, so a failed pin never leads to a duplicate message
    save(sent.message_id, (await pin(sent.message_id)) === true);
    return 'sent';
  } catch (err) {
    if (isBlocked(err)) {
      db.prepare('UPDATE tg_subscriptions SET active = 0 WHERE sub_id = ?').run(sub.sub_id);
      return 'blocked';
    }
    console.error('[Telegram] Updating the pinned message failed, will retry:', err.message);
    return 'retry';
  }
}

/** One long-poll round: fetches updates after the stored offset, handles each, stores the next offset. */
export async function pollBotOnce(db, tg, nowSec = Math.floor(Date.now() / 1000)) {
  const offset = Number(getState(db, 'tg_offset') ?? 0);
  const updates = await tg.call('getUpdates', { offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['message'] });
  for (const u of updates) {
    try { await handleBotUpdate(db, tg, u, nowSec); } catch (err) { console.error('[Telegram] Update failed:', err.message); }
    setState(db, 'tg_offset', u.update_id + 1, nowSec);
  }
  return updates.length;
}

const activeSubscriptions = db => db.prepare('SELECT * FROM tg_subscriptions WHERE active = 1 AND chat_id IS NOT NULL AND bound_at IS NOT NULL').all();

// Sends one message and records it. Returns 'sent', 'blocked' (user stopped the bot, subscription is switched off) or 'retry'.
async function sendOnce(db, tg, sub, key, text, nowSec) {
  try {
    await tg.call('sendMessage', { chat_id: sub.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: SITE_BUTTON });
    db.prepare('INSERT OR IGNORE INTO tg_sent (sub_id, message_key, sent_at) VALUES (?, ?, ?)').run(sub.sub_id, key, nowSec);
    return 'sent';
  } catch (err) {
    if (isBlocked(err)) {
      db.prepare('UPDATE tg_subscriptions SET active = 0 WHERE sub_id = ?').run(sub.sub_id);
      return 'blocked';
    }
    console.error('[Telegram] Send failed, will retry:', err.message);
    return 'retry';
  }
}

/**
 * Sends urgent events detected after the notifier first started and after the subscription was bound.
 * The first start only sets the watermark, so events that already existed are never sent as news.
 */
export async function dispatchUrgent(db, tg, nowSec = Math.floor(Date.now() / 1000), sleep = defaultSleep) {
  let started = getState(db, 'notify_started_at');
  if (started === null) { setState(db, 'notify_started_at', nowSec, nowSec); started = nowSec; }
  started = Number(started);

  const events = db.prepare(`
    SELECT ve.*, v.name AS vault_name FROM vault_events ve LEFT JOIN vaults v ON v.address = ve.vault_address
    WHERE ve.detected_at >= ? ORDER BY ve.id
  `).all(Math.max(started, nowSec - URGENT_LOOKBACK_SECONDS)).filter(isUrgent);
  if (events.length === 0) return 0;

  const sentStmt = db.prepare('SELECT 1 FROM tg_sent WHERE sub_id = ? AND message_key = ?');
  let sent = 0;
  for (const sub of activeSubscriptions(db)) {
    const followed = new Set(JSON.parse(sub.vaults_json));
    let inRound = 0;
    // Events of the same vault and kind that are not sent yet go out as one message
    const groups = new Map();
    for (const ev of events) {
      if (!followed.has(String(ev.vault_address).toLowerCase()) || ev.detected_at < sub.bound_at || sentStmt.get(sub.sub_id, ev.dedupe_key)) continue;
      const gk = `${ev.vault_address}:${ev.kind}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(ev);
    }
    for (const group of groups.values()) {
      if (inRound >= MAX_URGENT_PER_CHAT_PER_ROUND) break;
      if (inRound > 0) await sleep(SEND_GAP_MS);
      const [first, ...rest] = group;
      const res = await sendOnce(db, tg, sub, first.dedupe_key, formatUrgentGroup(group, first.vault_name, nowSec), nowSec);
      if (res !== 'sent') break;
      for (const ev of rest) db.prepare('INSERT OR IGNORE INTO tg_sent (sub_id, message_key, sent_at) VALUES (?, ?, ?)').run(sub.sub_id, ev.dedupe_key, nowSec);
      inRound++; sent++;
    }
  }
  return sent;
}

/** Sends the daily digest once per Kyiv date from 09:00; a transient failure keeps the date open for the next tick. */
export async function dispatchDigest(db, tg, nowSec = Math.floor(Date.now() / 1000), sleep = defaultSleep) {
  const date = digestDue(nowSec, getState(db, 'last_digest_date'));
  if (date === null) return 0;
  const key = `digest:${date}`;
  const sentStmt = db.prepare('SELECT 1 FROM tg_sent WHERE sub_id = ? AND message_key = ?');
  let sent = 0;
  let pending = false;
  for (const sub of activeSubscriptions(db)) {
    const entries = buildDigest(db, JSON.parse(sub.vaults_json), nowSec);
    if (entries.length === 0) continue;
    let res = 'sent';
    for (const [i, text] of formatDigest(entries, date).entries()) {
      const partKey = `${key}:${i}`;
      if (sentStmt.get(sub.sub_id, partKey)) continue;
      if (i > 0) await sleep(SEND_GAP_MS);
      res = await sendOnce(db, tg, sub, partKey, text, nowSec);
      if (res !== 'sent') break;
      sent++;
    }
    if (res === 'retry') pending = true;
  }
  if (!pending) setState(db, 'last_digest_date', date, nowSec);
  return sent;
}

/** Brings every active chat's pinned Upcoming changes message up to date; a tick where no set of changes moved sends nothing. */
export async function dispatchPins(db, tg, nowSec = Math.floor(Date.now() / 1000), sleep = defaultSleep) {
  let touched = 0;
  for (const sub of activeSubscriptions(db)) {
    const res = await syncUpcomingPin(db, tg, sub, nowSec);
    if (res === 'sent' || res === 'edited') { touched++; await sleep(SEND_GAP_MS); }
  }
  return touched;
}

const pinBusy = new Set();
const pinAgain = new Set();
const RETRY_PIN_MS = 4000;

/**
 * Called when the site saves a subscription: brings the pinned Upcoming message of that code's chat up to date at once
 * instead of waiting for the next tick. The code may belong to any device of the chat, the message follows the chat's
 * active code. Does nothing without a running bot or for an unbound or paused chat. A call that arrives while the chat is
 * being updated runs once more afterwards, and a failed update is tried again after a few seconds.
 * Returns the syncUpcomingPin result or 'skipped'.
 */
export async function refreshPinnedFor(db, subId, retryMs = RETRY_PIN_MS) {
  const row = liveTg && db.prepare('SELECT chat_id FROM tg_subscriptions WHERE sub_id = ? AND chat_id IS NOT NULL').get(subId);
  const sub = row && db.prepare('SELECT * FROM tg_subscriptions WHERE chat_id = ? AND active = 1 ORDER BY bound_at DESC LIMIT 1').get(row.chat_id);
  if (!sub) return 'skipped';
  if (pinBusy.has(sub.chat_id)) { pinAgain.add(sub.chat_id); return 'skipped'; }
  pinBusy.add(sub.chat_id);
  let res;
  try { res = await syncUpcomingPin(db, liveTg, sub); } finally { pinBusy.delete(sub.chat_id); }
  if (pinAgain.delete(sub.chat_id)) return refreshPinnedFor(db, subId, retryMs);
  if (res === 'retry') setTimeout(() => refreshPinnedFor(db, subId, retryMs).catch(() => {}), retryMs).unref?.();
  return res;
}

/**
 * Starts the bot (long polling) and the dispatch timer. Without a token it only logs once and does nothing.
 * Returns { stop } or null.
 */
export async function startNotifications(db, { token = process.env.TELEGRAM_BOT_TOKEN, fetchImpl, sleep = defaultSleep, tickMs = 60000 } = {}) {
  if (!token) { console.log('[Telegram] TELEGRAM_BOT_TOKEN is not set, notifications are disabled.'); return null; }
  const tg = createTelegram(token, fetchImpl);
  try {
    await tg.call('deleteWebhook');
    botUsername = (await tg.call('getMe')).username;
  } catch (err) {
    console.error('[Telegram] Start failed, notifications are disabled:', err.message);
    return null;
  }
  try { await tg.call('setMyCommands', { commands: COMMANDS }); } catch (err) { console.error('[Telegram] Setting the command menu failed:', err.message); }
  console.log(`[Telegram] Bot @${botUsername} started.`);
  liveTg = tg;

  let running = true;
  (async () => {
    while (running) {
      try { await pollBotOnce(db, tg); } catch (err) {
        console.error('[Telegram] Polling failed:', err.message);
        await sleep(err.code === 409 ? 30000 : 5000);
      }
    }
  })();

  const tick = async () => {
    try { await dispatchUrgent(db, tg, undefined, sleep); await dispatchDigest(db, tg, undefined, sleep); await dispatchPins(db, tg, undefined, sleep); } catch (err) { console.error('[Telegram] Dispatch failed:', err.message); }
  };
  const timer = setInterval(tick, tickMs);
  return { stop() { running = false; liveTg = null; botUsername = null; clearInterval(timer); } };
}
