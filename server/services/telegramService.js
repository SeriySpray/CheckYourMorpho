import crypto from 'node:crypto';
import { isUrgent, formatUrgentGroup, escapeHtml } from '../engine/notifyRules.js';
import { buildDigest, formatDigest, digestDue } from './digestService.js';

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
  { command: 'list', description: 'Vaults you follow' },
  { command: 'help', description: 'What the bot sends' },
  { command: 'pause', description: 'Pause alerts' },
  { command: 'resume', description: 'Resume alerts' }
];

const HELP_TEXT = [
  '<b>CheckYourMorpho alerts</b>',
  'Alerts for the vaults you star on the site. The list updates by itself when you star or unstar a vault.',
  '<b>Sent immediately</b>\n- A cap increase that adds 5% or more of vault assets, or opens a new cap\n- A market added or removed\n- A guardian change or a shorter timelock\n- Bad debt appearing in a market\n- A sharp TVL outflow (15% or more in 24 hours, at least $500K)',
  '<b>Daily digest, 09:00 Kyiv time</b>\n- Verdict and MQI changes\n- A Net APY drop against the 7-day average\n- Fee changes and delisting\n- A summary of reallocations',
  '/status  alert status\n/list  vaults you follow\n/pause  pause alerts\n/resume  resume alerts'
].join('\n\n');

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let botUsername = null;

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
  const row = db.prepare('SELECT chat_id, active FROM tg_subscriptions WHERE sub_id = ?').get(subId);
  return { ok: true, vaults: unique.length, connected: row.chat_id !== null && row.active === 1 };
}

/** Handles one Telegram update: /start <sub_id> binds the chat; /status, /list, /help, /pause and /resume manage it. */
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
  const notConnected = () => say('<b>CheckYourMorpho alerts</b>\n\nOpen the site with the button below, star the vaults you follow and they sync here by themselves. Nothing else to set up.\n\n/help shows what the bot sends.', pairing());

  if (/^\/start(@\w+)?$/.test(command)) {
    if (!arg || !SUB_ID_RE.test(arg)) {
      const sub = latest();
      if (sub && JSON.parse(sub.vaults_json).length) { await say(statusText(db, sub), SITE_BUTTON); return; }
      await notConnected();
      return;
    }
    // Another browser of the same person must not duplicate alerts: the newest binding wins
    db.prepare('UPDATE tg_subscriptions SET active = 0 WHERE chat_id = ? AND sub_id != ?').run(chatId, arg);
    // An unknown code is the browser's id whose first PUT has not arrived (or was lost): keep the chat, the next sync fills the list
    upsertSubscription(db, arg, [], nowSec, false);
    db.prepare('UPDATE tg_subscriptions SET chat_id = ?, active = 1, bound_at = ? WHERE sub_id = ?').run(chatId, nowSec, arg);
    const n = JSON.parse(db.prepare('SELECT vaults_json FROM tg_subscriptions WHERE sub_id = ?').get(arg).vaults_json).length;
    await say(`<b>Connected</b>\n\nYou follow ${n} vault${n === 1 ? '' : 's'}. The list follows your stars on the site.\n\nUrgent changes arrive immediately. The daily digest comes at 09:00 Kyiv time.\n\n/list  vaults you follow\n/help  what the bot sends\n/pause  pause alerts`, SITE_BUTTON);
  } else if (/^\/help(@\w+)?$/.test(command)) {
    await say(HELP_TEXT, SITE_BUTTON);
  } else if (/^\/status(@\w+)?$/.test(command)) {
    const sub = latest();
    if (sub && JSON.parse(sub.vaults_json).length) await say(statusText(db, sub), SITE_BUTTON); else await notConnected();
  } else if (/^\/list(@\w+)?$/.test(command)) {
    const row = db.prepare('SELECT vaults_json FROM tg_subscriptions WHERE chat_id = ? AND active = 1').get(chatId);
    const addrs = row ? JSON.parse(row.vaults_json) : [];
    const name = db.prepare('SELECT name FROM vaults WHERE address = ?');
    await say(addrs.length
      ? `<b>You follow ${addrs.length} vault${addrs.length === 1 ? '' : 's'}</b>\n\n${addrs.map(a => `${escapeHtml(name.get(a)?.name || 'Vault')}\n<code>${a}</code>`).join('\n\n')}`
      : '<b>No vaults followed</b>\n\nOpen the site with the button below and star vaults: they appear here by themselves.', addrs.length ? undefined : pairing());
  } else if (/^\/(pause|stop)(@\w+)?$/.test(command)) {
    db.prepare('UPDATE tg_subscriptions SET active = 0 WHERE chat_id = ?').run(chatId);
    await say('<b>Alerts paused</b>\n\nNothing will be sent. /resume turns them back on.');
  } else if (/^\/resume(@\w+)?$/.test(command)) {
    const sub = latest();
    if (!sub) { await notConnected(); return; }
    db.prepare('UPDATE tg_subscriptions SET active = 0 WHERE chat_id = ? AND sub_id != ?').run(chatId, sub.sub_id);
    // Resuming starts fresh: events from the pause are not replayed
    db.prepare('UPDATE tg_subscriptions SET active = 1, bound_at = ? WHERE sub_id = ?').run(nowSec, sub.sub_id);
    await say('<b>Alerts resumed</b>\n\n/status shows the current state.');
  } else if (command.startsWith('/')) {
    await say('Unknown command. /help lists what the bot can do.');
  } else if (!latest()) {
    await notConnected();
  }
}

function statusText(db, sub) {
  const n = JSON.parse(sub.vaults_json).length;
  return `<b>Alerts ${sub.active ? 'on' : 'paused'}</b>\n\nFollowing ${n} vault${n === 1 ? '' : 's'}.\nUrgent changes are sent immediately, the digest at 09:00 Kyiv time.\n\n${sub.active ? '/pause pauses alerts.' : '/resume turns them back on.'} /list shows the vaults.`;
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
    if (err.code === 403 || (err.code === 400 && /chat not found/i.test(err.message))) {
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
    try { await dispatchUrgent(db, tg, undefined, sleep); await dispatchDigest(db, tg, undefined, sleep); } catch (err) { console.error('[Telegram] Dispatch failed:', err.message); }
  };
  const timer = setInterval(tick, tickMs);
  return { stop() { running = false; clearInterval(timer); } };
}
