import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../server/db/schema.js';

// 2026-01-15 10:00 Kyiv (08:00 UTC): digest hour has passed
const NOW = Date.UTC(2026, 0, 15, 8, 0) / 1000;
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const SUB = 'abcdefghijklmnopqrstuv';
const noSleep = async () => {};
let messageSeq = 1000;

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const v = db.prepare('INSERT INTO vaults (address, chain_id, name) VALUES (?, 1, ?)');
  v.run(A, 'Alpha USDC'); v.run(B, 'Beta WETH');
  return db;
}
// Fake Telegram: records every call; `fail` maps a method to a queue of { code, message } errors thrown by its next calls
function makeTg({ updates = [], fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    sent: () => calls.filter(c => c.method === 'sendMessage').map(c => c.payload),
    async call(method, payload = {}) {
      calls.push({ method, payload });
      const err = fail[method]?.shift();
      if (err) throw Object.assign(new Error(err.message), { code: err.code });
      if (method === 'getUpdates') return updates.splice(0);
      if (method === 'sendMessage') return { message_id: ++messageSeq };
      return {};
    }
  };
}
const bound = (db, { sub = SUB, chat = 777, vaults = [A], at = NOW - 100 } = {}) => db.prepare(
  'INSERT INTO tg_subscriptions (sub_id, chat_id, vaults_json, active, created_at, bound_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)'
).run(sub, chat, JSON.stringify(vaults), at, at, at);
let seq = 0;
const urgent = (db, o = {}) => db.prepare(`
  INSERT INTO vault_events (vault_address, chain_id, kind, source, severity, status, title, details_json, dedupe_key, occurred_at, valid_at, detected_at)
  VALUES (?, 1, ?, 'derived', 'critical', ?, 'Event title', ?, ?, ?, ?, ?)`).run(o.vault ?? A, o.kind ?? 'tvl_drop', o.status ?? 'final', JSON.stringify(o.details ?? { previousTvlUsd: 2e6, currentTvlUsd: 1e6 }), o.key ?? `k${seq++}`, o.at ?? NOW, o.validAt ?? null, o.at ?? NOW);
const update = (id, chatId, text) => ({ update_id: id, message: { chat: { id: chatId }, text } });

export default {
  getBotInfo: [
    ['до запуску бота вимкнено, username порожній', ({ getBotInfo }) => {
      assert.deepEqual(getBotInfo(), { enabled: false, username: null });
    }],
  ],
  createTelegram: [
    ['викликає методи Bot API через fetch з токеном в адресі і JSON-тілом, повертає result', async ({ createTelegram }) => {
      let seen;
      const tg = createTelegram('TOKEN', async (url, init) => { seen = { url, init }; return { status: 200, json: async () => ({ ok: true, result: { id: 5 } }) }; });
      assert.deepEqual(await tg.call('getMe', { a: 1 }), { id: 5 });
      assert.equal(seen.url, 'https://api.telegram.org/botTOKEN/getMe');
      assert.equal(seen.init.method, 'POST'); assert.equal(seen.init.body, '{"a":1}');
    }],
    ['відповідь ok:false або не JSON -> помилка з кодом', async ({ createTelegram }) => {
      const tg403 = createTelegram('T', async () => ({ status: 403, json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked' }) }));
      await assert.rejects(() => tg403.call('sendMessage'), e => e.code === 403 && /blocked/.test(e.message));
      const tgHtml = createTelegram('T', async () => ({ status: 502, json: async () => { throw new Error('not json'); } }));
      await assert.rejects(() => tgHtml.call('getMe'), e => e.code === 502);
    }],
  ],
  pairingUrl: [['the site link carries the code, URL-encoded', ({ pairingUrl: f }) => {
    assert.equal(f('abcDEF123_-xyzABC9876'), 'https://checkyourmorpho.duckdns.org/?tg=abcDEF123_-xyzABC9876'); assert.equal(f('a b'), 'https://checkyourmorpho.duckdns.org/?tg=a%20b');
  }]],
  getSubscription: [
    ['невалідний код - помилка; невідомий або непідключений - connected false без списку; підключений віддає список', ({ getSubscription, upsertSubscription }) => {
      const db = makeDb();
      assert.deepEqual(getSubscription(db, 'short'), { ok: false, error: 'Invalid sub_id' });
      assert.deepEqual(getSubscription(db, null), { ok: false, error: 'Invalid sub_id' });
      assert.deepEqual(getSubscription(db, SUB), { ok: true, connected: false, vaults: null });
      upsertSubscription(db, SUB, [A, B], NOW);
      assert.deepEqual(getSubscription(db, SUB), { ok: true, connected: false, vaults: null });
      db.prepare('UPDATE tg_subscriptions SET chat_id = 9, bound_at = ?').run(NOW);
      assert.deepEqual(getSubscription(db, SUB), { ok: true, connected: true, vaults: [A, B] });
      db.close();
    }],
  ],
  upsertSubscription: [
    ['список належить чату: зміна з одного коду оновлює всі коди цього чату, але не чужі', ({ upsertSubscription }) => {
      const db = makeDb();
      const other = 'zyxwvutsrqponmlkjihgfe';
      upsertSubscription(db, SUB, [A], NOW); upsertSubscription(db, other, [A], NOW);
      db.prepare('UPDATE tg_subscriptions SET chat_id = 9, bound_at = ?').run(NOW);
      upsertSubscription(db, 'strangerstrangerstranger', [A], NOW);
      db.prepare("UPDATE tg_subscriptions SET chat_id = 10 WHERE sub_id = 'strangerstrangerstranger'").run();
      assert.equal(upsertSubscription(db, SUB, [A, B], NOW + 5).connected, true);
      const lists = Object.fromEntries(db.prepare('SELECT sub_id, vaults_json FROM tg_subscriptions').all().map(r => [r.sub_id, JSON.parse(r.vaults_json)]));
      assert.deepEqual(lists[other], [A, B]);
      assert.deepEqual(lists.strangerstrangerstranger, [A]);
      db.close();
    }],
    ['створює підписку з унікальними адресами в нижньому регістрі; повторний виклик оновлює список і зберігає прив\'язку чату', ({ upsertSubscription }) => {
      const db = makeDb();
      assert.deepEqual(upsertSubscription(db, SUB, [A.toUpperCase().replace('0X', '0x'), A, B], NOW), { ok: true, vaults: 2, connected: false });
      db.prepare('UPDATE tg_subscriptions SET chat_id = 9, bound_at = ? WHERE sub_id = ?').run(NOW, SUB);
      assert.deepEqual(upsertSubscription(db, SUB, [B], NOW + 5), { ok: true, vaults: 1, connected: true });
      const r = db.prepare('SELECT vaults_json, created_at, updated_at, chat_id FROM tg_subscriptions').get();
      assert.deepEqual({ ...r }, { vaults_json: JSON.stringify([B]), created_at: NOW, updated_at: NOW + 5, chat_id: 9 });
      db.close();
    }],
    ['відхиляє некоректний sub_id, не масив, понад 100 адрес і невалідну адресу', ({ upsertSubscription }) => {
      const db = makeDb();
      assert.equal(upsertSubscription(db, 'short', [A]).ok, false);
      assert.equal(upsertSubscription(db, 'has space in the id!!', [A]).ok, false);
      assert.equal(upsertSubscription(db, undefined, [A]).ok, false);
      assert.equal(upsertSubscription(db, SUB, 'x').ok, false);
      assert.equal(upsertSubscription(db, SUB, [A, '0xbad']).ok, false);
      assert.equal(upsertSubscription(db, SUB, Array.from({ length: 101 }, (_, i) => '0x' + i.toString(16).padStart(40, '0'))).ok, false);
      assert.equal(upsertSubscription(db, SUB, Array.from({ length: 100 }, (_, i) => '0x' + i.toString(16).padStart(40, '0'))).ok, true);
      db.close();
    }],
  ],
  handleBotUpdate: [
    ['/start з іншого браузера того ж чату вимикає попередню підписку (без подвійних сповіщень)', async ({ handleBotUpdate, upsertSubscription }) => {
      const db = makeDb(); const tg = makeTg();
      const other = 'zyxwvutsrqponmlkjihgfe';
      upsertSubscription(db, SUB, [A], NOW - 50); upsertSubscription(db, other, [A], NOW - 50);
      await handleBotUpdate(db, tg, update(1, 55, `/start ${SUB}`), NOW);
      await handleBotUpdate(db, tg, update(2, 55, `/start ${other}`), NOW + 5);
      const active = id => db.prepare('SELECT active FROM tg_subscriptions WHERE sub_id = ?').get(id).active;
      assert.equal(active(SUB), 0); assert.equal(active(other), 1);
      db.close();
    }],
    ['/start <sub_id> прив\'язує чат, вмикає підписку і відповідає кількістю vault-ів', async ({ handleBotUpdate, upsertSubscription }) => {
      const db = makeDb(); const tg = makeTg();
      upsertSubscription(db, SUB, [A, B], NOW - 50);
      db.prepare('UPDATE tg_subscriptions SET active = 0').run();
      await handleBotUpdate(db, tg, update(1, 55, `/start ${SUB}`), NOW);
      const r = db.prepare('SELECT chat_id, active, bound_at FROM tg_subscriptions').get();
      assert.deepEqual({ ...r }, { chat_id: 55, active: 1, bound_at: NOW });
      assert.match(tg.sent()[0].text, /^<b>Connected<\/b>\n\nYou follow 2 vaults\./);
      assert.match(tg.sent()[0].text, /pinned at the top of this chat/);
      assert.equal(tg.sent()[0].chat_id, 55);
      db.close();
    }],
    ['/start без коду підказує що робити; невідомий код створює порожню підписку чату, а наступний PUT з браузера наповнює її', async ({ handleBotUpdate, upsertSubscription }) => {
      const db = makeDb(); const tg = makeTg();
      await handleBotUpdate(db, tg, update(1, 55, '/start'), NOW);
      assert.match(tg.sent()[0].text, /sync here by themselves/);
      const rows = db.prepare('SELECT sub_id, chat_id, active, bound_at, vaults_json FROM tg_subscriptions').all();
      assert.equal(rows.length, 1); assert.deepEqual({ ...rows[0], sub_id: undefined }, { sub_id: undefined, chat_id: 55, active: 1, bound_at: NOW, vaults_json: '[]' });
      assert.equal(tg.sent()[0].reply_markup.inline_keyboard[0][0].url, `https://checkyourmorpho.duckdns.org/?tg=${rows[0].sub_id}`, 'the link carries the new code');
      await handleBotUpdate(db, tg, update(2, 55, '/start'), NOW + 5);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tg_subscriptions').get().c, 1, 'one code per chat');
      assert.equal(tg.sent()[1].reply_markup.inline_keyboard[0][0].url, tg.sent()[0].reply_markup.inline_keyboard[0][0].url);
      await handleBotUpdate(db, tg, update(3, 66, `/start ${SUB}`), NOW);
      assert.match(tg.sent()[2].text, /You follow 0 vaults\./);
      assert.deepEqual(upsertSubscription(db, SUB, [A], NOW + 5), { ok: true, vaults: 1, connected: true });
      const r = db.prepare('SELECT chat_id, active FROM tg_subscriptions WHERE sub_id = ?').get(SUB);
      assert.equal(r.chat_id, 66); assert.equal(r.active, 1);
      db.close();
    }],
    ['/start з нового пристрою об\'єднує список чату зі списком пристрою і віддає його всім кодам чату', async ({ handleBotUpdate, upsertSubscription }) => {
      const db = makeDb(); const tg = makeTg();
      const second = 'zyxwvutsrqponmlkjihgfe';
      bound(db, { chat: 55, vaults: [A] });
      upsertSubscription(db, second, [B], NOW);
      await handleBotUpdate(db, tg, update(1, 55, `/start ${second}`), NOW + 5);
      const lists = Object.fromEntries(db.prepare('SELECT sub_id, vaults_json, active FROM tg_subscriptions').all().map(r => [r.sub_id, { v: JSON.parse(r.vaults_json), a: r.active }]));
      assert.deepEqual(lists[second], { v: [A, B], a: 1 });
      assert.deepEqual(lists[SUB], { v: [A, B], a: 0 });
      assert.match(tg.sent()[0].text, /You follow 2 vaults/);
      db.close();
    }],
    ['/list показує vault-и чату, /stop вимикає підписку, після чого /list порожній', async ({ handleBotUpdate }) => {
      const db = makeDb(); const tg = makeTg();
      bound(db, { chat: 55, vaults: [A, B] });
      await handleBotUpdate(db, tg, update(1, 55, '/list'), NOW);
      assert.equal(tg.sent()[0].text, '<b>You follow 2 vaults</b>\n\n<b>Alpha USDC</b>  |  Ethereum\n<code>0x1111...1111</code>\n\n<b>Beta WETH</b>  |  Ethereum\n<code>0x2222...2222</code>');
      await handleBotUpdate(db, tg, update(2, 55, '/pause'), NOW);
      assert.equal(db.prepare('SELECT active FROM tg_subscriptions').get().active, 0);
      await handleBotUpdate(db, tg, update(3, 55, '/list'), NOW);
      assert.match(tg.sent()[2].text, /No vaults followed/);
      db.close();
    }],
    ['/upcoming: без vault-ів підказка підключитись; з vault-ами оновлює закріплене повідомлення і відповідає, що воно актуальне', async ({ handleBotUpdate }) => {
      const db = makeDb(); const tg = makeTg();
      await handleBotUpdate(db, tg, update(1, 55, '/upcoming'), NOW);
      assert.match(tg.sent()[0].text, /sync here by themselves/);
      db.prepare('DELETE FROM tg_subscriptions').run();
      bound(db, { chat: 55, vaults: [A] });
      tg.calls.length = 0;
      await handleBotUpdate(db, tg, update(2, 55, '/upcoming'), NOW);
      assert.deepEqual(tg.calls.map(c => c.method), ['sendMessage', 'pinChatMessage']);
      assert.match(tg.sent()[0].text, /^<b>Upcoming changes<\/b>/);
      tg.calls.length = 0;
      await handleBotUpdate(db, tg, update(3, 55, '/upcoming'), NOW + 5);
      assert.deepEqual(tg.calls.map(c => c.method), ['deleteMessage', 'sendMessage', 'pinChatMessage']);
      assert.match(tg.sent()[0].text, /^<b>Upcoming changes<\/b>/);
      db.close();
    }],
    ['/list додає вердикт, MQI і кількість очікуваних змін; /status рахує зміни, які вже можна застосувати', async ({ handleBotUpdate }) => {
      const db = makeDb(); const tg = makeTg();
      bound(db, { chat: 55, vaults: [A, B] });
      db.prepare('INSERT INTO vault_samples (vault_address, hour_bucket, sampled_at, mqi_percent, verdict_level, verdict_reasons) VALUES (?, ?, ?, 98, ?, ?)').run(A, Math.floor(NOW / 3600), NOW, 'red', 'Critical Crowded Exit Deficit');
      urgent(db, { kind: 'pending_guardian_change', status: 'pending', validAt: NOW - 60, key: 'pg-ready', details: {} });
      urgent(db, { kind: 'pending_market_removal', status: 'pending', validAt: NOW + 600, key: 'pm-wait', details: {} });
      await handleBotUpdate(db, tg, update(1, 55, '/list'), NOW);
      assert.match(tg.sent()[0].text, /<b>Alpha USDC<\/b>  \|  Ethereum\n<code>0x1111\.\.\.1111<\/code>\nRisk: exit risk under stress  \|  Market quality 98%  \|  2 pending changes/);
      assert.match(tg.sent()[0].text, /<code>0x2222\.\.\.2222<\/code>\n\n?$|<code>0x2222\.\.\.2222<\/code>$/);
      await handleBotUpdate(db, tg, update(2, 55, '/status'), NOW);
      assert.match(tg.sent()[1].text, /Pending changes: 2 \(1 can be applied now\)\. \/upcoming shows them\./);
      db.close();
    }],
    ['/help і невідома команда: опис без прив\'язки до підписки', async ({ handleBotUpdate }) => {
      const db = makeDb(); const tg = makeTg();
      await handleBotUpdate(db, tg, update(1, 55, '/help'), NOW);
      await handleBotUpdate(db, tg, update(2, 55, '/nope'), NOW);
      assert.match(tg.sent()[0].text, /<b>Sent immediately<\/b>[\s\S]*<b>Daily digest, 09:00 Kyiv time<\/b>/);
      assert.equal(tg.sent()[0].parse_mode, 'HTML');
      assert.match(tg.sent()[1].text, /Unknown command/);
      db.close();
    }],
    ['/status: без підписки підказка, з підпискою стан і кількість; /start без коду для підключеного чату показує стан', async ({ handleBotUpdate }) => {
      const db = makeDb(); const tg = makeTg();
      await handleBotUpdate(db, tg, update(1, 55, '/status'), NOW);
      assert.match(tg.sent()[0].text, /sync here by themselves/); assert.match(tg.sent()[0].reply_markup.inline_keyboard[0][0].url, /\/\?tg=/);
      db.prepare('DELETE FROM tg_subscriptions').run();
      bound(db, { chat: 55, vaults: [A, B] });
      await handleBotUpdate(db, tg, update(2, 55, '/status'), NOW);
      assert.match(tg.sent()[1].text, /^<b>Alerts on<\/b>\n\nFollowing 2 vaults\.\n\nPending changes: 0\. \/upcoming shows them\./);
      await handleBotUpdate(db, tg, update(3, 55, '/start'), NOW);
      assert.match(tg.sent()[2].text, /<b>Alerts on<\/b>/);
      db.close();
    }],
    ['/stop повністю відписує: знімає закріплення, видаляє підписку, надіслане і стан закріпленого; чужі чати не чіпає; після нього /list веде на сайт', async ({ handleBotUpdate }) => {
      const db = makeDb(); const tg = makeTg();
      bound(db, { chat: 55, vaults: [A] });
      bound(db, { sub: 'zyxwvutsrqponmlkjihgfe', chat: 66, vaults: [B] });
      await handleBotUpdate(db, tg, update(1, 55, '/upcoming'), NOW);
      db.prepare("INSERT INTO tg_sent (sub_id, message_key, sent_at) VALUES (?, 'k', ?)").run(SUB, NOW);
      tg.calls.length = 0;
      await handleBotUpdate(db, tg, update(2, 55, '/stop'), NOW + 1);
      assert.deepEqual(tg.calls.map(c => c.method), ['unpinChatMessage', 'sendMessage']);
      assert.equal(tg.calls[0].payload.chat_id, 55);
      assert.match(tg.sent()[0].text, /^<b>Unsubscribed<\/b>/);
      assert.deepEqual(db.prepare('SELECT chat_id FROM tg_subscriptions').all().map(r => r.chat_id), [66]);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tg_sent').get().c, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sync_state WHERE key = 'tg_pin:55'").get().c, 0);
      await handleBotUpdate(db, tg, update(3, 55, '/list'), NOW + 2);
      assert.match(tg.sent()[1].text, /No vaults followed/);
      db.close();
    }],
    ['/stop без закріпленого повідомлення і з помилкою unpin все одно відписує', async ({ handleBotUpdate }) => {
      const db = makeDb();
      bound(db, { chat: 55, vaults: [A] });
      const plain = makeTg();
      await handleBotUpdate(db, plain, update(1, 55, '/stop'), NOW);
      assert.deepEqual(plain.calls.map(c => c.method), ['sendMessage']);
      bound(db, { chat: 55, vaults: [A] });
      db.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES ('tg_pin:55', ?, ?)").run(JSON.stringify({ message_id: 5, hash: 'x', pinned: true }), NOW);
      const failing = makeTg({ fail: { unpinChatMessage: [{ code: 400, message: 'Bad Request: message to unpin not found' }] } });
      await handleBotUpdate(db, failing, update(2, 55, '/stop'), NOW);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tg_subscriptions').get().c, 0);
      assert.match(failing.sent()[0].text, /^<b>Unsubscribed<\/b>/);
      db.close();
    }],
    ['/pause вимикає, /resume вмикає знову і починає з чистого аркуша (bound_at оновлюється)', async ({ handleBotUpdate }) => {
      const db = makeDb(); const tg = makeTg();
      bound(db, { chat: 55, at: NOW - 1000 });
      await handleBotUpdate(db, tg, update(1, 55, '/pause'), NOW);
      assert.equal(db.prepare('SELECT active FROM tg_subscriptions').get().active, 0);
      assert.match(tg.sent()[0].text, /<b>Alerts paused<\/b>/);
      await handleBotUpdate(db, tg, update(2, 55, '/status'), NOW);
      assert.match(tg.sent()[1].text, /<b>Alerts paused<\/b>/);
      await handleBotUpdate(db, tg, update(3, 55, '/resume'), NOW + 5);
      const r = db.prepare('SELECT active, bound_at FROM tg_subscriptions').get();
      assert.equal(r.active, 1); assert.equal(r.bound_at, NOW + 5);
      await handleBotUpdate(db, tg, update(5, 99, '/resume'), NOW);
      assert.match(tg.sent().at(-1).text, /sync here by themselves/);
      db.close();
    }],
    ['звичайний текст від непідключеного чату отримує посилання на сайт, від підключеного ігнорується; не повідомлення і неціле chat id ігноруються', async ({ handleBotUpdate }) => {
      const db = makeDb(); const tg = makeTg();
      await handleBotUpdate(db, tg, { update_id: 2 }, NOW);
      await handleBotUpdate(db, tg, update(3, 'x', '/list'), NOW);
      await handleBotUpdate(db, tg, null, NOW);
      assert.equal(tg.calls.length, 0);
      await handleBotUpdate(db, tg, update(1, 55, 'hello'), NOW);
      assert.equal(tg.sent().length, 1); assert.match(tg.sent()[0].reply_markup.inline_keyboard[0][0].url, /\/\?tg=/);
      await handleBotUpdate(db, tg, update(4, 55, 'hello again'), NOW + 1);
      assert.equal(tg.sent().length, 1, 'a connected chat is not answered');
      db.close();
    }],
    ['/list без vault-ів дає кнопку з кодом чату; з vault-ами кнопки немає', async ({ handleBotUpdate }) => {
      const db = makeDb(); const tg = makeTg();
      await handleBotUpdate(db, tg, update(1, 55, '/list'), NOW);
      assert.match(tg.sent()[0].text, /No vaults followed/);
      const code = db.prepare('SELECT sub_id FROM tg_subscriptions WHERE chat_id = 55').get().sub_id;
      assert.ok(tg.sent()[0].reply_markup.inline_keyboard[0][0].url.endsWith(`/?tg=${code}`));
      bound(db, { chat: 77, vaults: [A] });
      await handleBotUpdate(db, tg, update(2, 77, '/list'), NOW);
      assert.equal(tg.sent()[1].reply_markup, undefined);
      db.close();
    }],
  ],
  syncUpcomingPin: [
    ['перший раз надсилає і закріплює, без змін нічого не викликає, зі зміною редагує те саме повідомлення', async ({ syncUpcomingPin }) => {
      const db = makeDb(); const tg = makeTg();
      bound(db, { chat: 55, vaults: [A] });
      const sub = () => db.prepare('SELECT * FROM tg_subscriptions').get();
      assert.equal(await syncUpcomingPin(db, tg, sub(), NOW), 'sent');
      assert.deepEqual(tg.calls.map(c => c.method), ['sendMessage', 'pinChatMessage']);
      assert.match(tg.sent()[0].text, /^<b>Upcoming changes<\/b>\n\nNothing is waiting for a timelock in the 1 vault you follow\./);
      const id = JSON.parse(db.prepare("SELECT value FROM sync_state WHERE key = 'tg_pin:55'").get().value).message_id;
      assert.deepEqual(tg.calls[1].payload, { chat_id: 55, message_id: id, disable_notification: true });

      tg.calls.length = 0;
      assert.equal(await syncUpcomingPin(db, tg, sub(), NOW + 60), 'unchanged');
      assert.equal(tg.calls.length, 0);

      urgent(db, { kind: 'pending_guardian_change', status: 'pending', validAt: NOW + 7200, key: 'pg1', details: {} });
      assert.equal(await syncUpcomingPin(db, tg, sub(), NOW + 120), 'edited');
      assert.deepEqual(tg.calls.map(c => c.method), ['editMessageText']);
      assert.equal(tg.calls[0].payload.message_id, id);
      assert.match(tg.calls[0].payload.text, /1 pending change in the 1 vault you follow/);
      db.close();
    }],
    ['force замінює повідомлення новим навіть без змін (чат міг бути очищений у користувача): видаляє старе, надсилає і закріплює; без vault-ів нічого не шле', async ({ syncUpcomingPin }) => {
      const db = makeDb(); const tg = makeTg();
      bound(db, { chat: 55, vaults: [A] });
      const sub = db.prepare('SELECT * FROM tg_subscriptions').get();
      await syncUpcomingPin(db, tg, sub, NOW);
      tg.calls.length = 0;
      assert.equal(await syncUpcomingPin(db, tg, sub, NOW + 5, true), 'sent');
      assert.deepEqual(tg.calls.map(c => c.method), ['deleteMessage', 'sendMessage', 'pinChatMessage']);
      assert.equal(await syncUpcomingPin(db, tg, { ...sub, vaults_json: '[]' }, NOW), 'skipped');
      db.close();
    }],
    ['"message is not modified" - не помилка; видалене користувачем повідомлення замінюється новим і закріплюється', async ({ syncUpcomingPin }) => {
      const db = makeDb();
      bound(db, { chat: 55, vaults: [A] });
      const sub = () => db.prepare('SELECT * FROM tg_subscriptions').get();
      const tg = makeTg({ fail: { editMessageText: [{ code: 400, message: 'Bad Request: message is not modified' }, { code: 400, message: 'Bad Request: message to edit not found' }] } });
      await syncUpcomingPin(db, tg, sub(), NOW);
      urgent(db, { kind: 'pending_guardian_change', status: 'pending', validAt: NOW + 7200, key: 'pg1', details: {} });
      assert.equal(await syncUpcomingPin(db, tg, sub(), NOW + 60), 'unchanged');
      urgent(db, { kind: 'pending_market_removal', status: 'pending', validAt: NOW + 9000, key: 'pm1', details: {} });
      tg.calls.length = 0;
      assert.equal(await syncUpcomingPin(db, tg, sub(), NOW + 120), 'sent');
      assert.deepEqual(tg.calls.map(c => c.method), ['editMessageText', 'sendMessage', 'pinChatMessage']);
      assert.equal(JSON.parse(db.prepare("SELECT value FROM sync_state WHERE key = 'tg_pin:55'").get().value).message_id, tg.calls[2].payload.message_id);
      db.close();
    }],
    ['чат видалено і запущено знову: закріплення старого повідомлення дає "not found", бот надсилає нове і закріплює його (ні на /start, ні в тіку не залишається без закріплення)', async ({ syncUpcomingPin }) => {
      const db = makeDb();
      bound(db, { chat: 55, vaults: [A] });
      const sub = () => db.prepare('SELECT * FROM tg_subscriptions').get();
      const tg = makeTg();
      await syncUpcomingPin(db, tg, sub(), NOW);
      const first = JSON.parse(db.prepare("SELECT value FROM sync_state WHERE key = 'tg_pin:55'").get().value).message_id;
      const again = makeTg({ fail: { pinChatMessage: [{ code: 400, message: 'Bad Request: message to pin not found' }] } });
      const st = JSON.parse(db.prepare("SELECT value FROM sync_state WHERE key = 'tg_pin:55'").get().value);
      db.prepare("UPDATE sync_state SET value = ? WHERE key = 'tg_pin:55'").run(JSON.stringify({ ...st, pinned: false }));
      assert.equal(await syncUpcomingPin(db, again, sub(), NOW + 60), 'sent');
      assert.deepEqual(again.calls.map(c => c.method), ['pinChatMessage', 'sendMessage', 'pinChatMessage']);
      const saved = JSON.parse(db.prepare("SELECT value FROM sync_state WHERE key = 'tg_pin:55'").get().value);
      assert.notEqual(saved.message_id, first); assert.equal(saved.pinned, true);
      db.close();
    }],
    ['невдале закріплення не дублює повідомлення: наступний виклик лише закріплює; 403 вимикає підписку', async ({ syncUpcomingPin }) => {
      const db = makeDb();
      bound(db, { chat: 55, vaults: [A] });
      const sub = () => db.prepare('SELECT * FROM tg_subscriptions').get();
      const tg = makeTg({ fail: { pinChatMessage: [{ code: 400, message: 'Bad Request: not enough rights' }] } });
      assert.equal(await syncUpcomingPin(db, tg, sub(), NOW), 'sent');
      tg.calls.length = 0;
      assert.equal(await syncUpcomingPin(db, tg, sub(), NOW + 60), 'unchanged');
      assert.deepEqual(tg.calls.map(c => c.method), ['pinChatMessage']);
      const blocked = makeTg({ fail: { sendMessage: [{ code: 403, message: 'Forbidden: bot was blocked by the user' }] } });
      db.prepare("DELETE FROM sync_state WHERE key = 'tg_pin:55'").run();
      assert.equal(await syncUpcomingPin(db, blocked, sub(), NOW + 120), 'blocked');
      assert.equal(sub().active, 0);
      db.close();
    }],
  ],
  refreshPinnedFor: [
    ['без запущеного бота нічого не робить', async ({ refreshPinnedFor }) => {
      const db = makeDb();
      bound(db, { chat: 55, vaults: [A] });
      assert.equal(await refreshPinnedFor(db, SUB), 'skipped');
      db.close();
    }],
    ['з ботом: одразу оновлює закріплене повідомлення чату після зміни списку; призупинена або непідключена підписка пропускається', async ({ refreshPinnedFor, startNotifications, upsertSubscription }) => {
      const db = makeDb();
      const tg = makeTg();
      const fetchImpl = async (url, init) => { const m = url.split('/').pop(); if (m === 'getUpdates') { await new Promise(x => setTimeout(x, 15)); return { status: 200, json: async () => ({ ok: true, result: [] }) }; } const r = await tg.call(m, JSON.parse(init.body)); return { status: 200, json: async () => ({ ok: true, result: m === 'getMe' ? { username: 'bot' } : r }) }; };
      const handle = await startNotifications(db, { token: 'T', fetchImpl, sleep: noSleep, tickMs: 3600000 });
      try {
        bound(db, { chat: 55, vaults: [A] });
        assert.equal(await refreshPinnedFor(db, SUB), 'sent');
        assert.match(tg.sent().at(-1).text, /1 vault you follow/);
        upsertSubscription(db, SUB, [A, B], NOW);
        assert.equal(await refreshPinnedFor(db, SUB), 'edited');
        assert.match(tg.calls.findLast(c => c.method === 'editMessageText').payload.text, /2 vaults you follow/);
        assert.equal(await refreshPinnedFor(db, SUB), 'unchanged');
        db.prepare('UPDATE tg_subscriptions SET active = 0').run();
        assert.equal(await refreshPinnedFor(db, SUB), 'skipped');
        assert.equal(await refreshPinnedFor(db, 'unknownunknownunknownun'), 'skipped');
      } finally { handle.stop(); }
      db.close();
    }],
  ],
  dispatchPins: [
    ['оновлює закріплене повідомлення всіх активних чатів, лічить лише надіслані чи змінені, пропускає вимкнені', async ({ dispatchPins }) => {
      const db = makeDb(); const tg = makeTg();
      bound(db, { chat: 55, vaults: [A] });
      bound(db, { sub: 'zyxwvutsrqponmlkjihgfe', chat: 66, vaults: [B] });
      db.prepare("UPDATE tg_subscriptions SET active = 0 WHERE chat_id = 66").run();
      assert.equal(await dispatchPins(db, tg, NOW, noSleep), 1);
      assert.equal(await dispatchPins(db, tg, NOW + 60, noSleep), 0);
      assert.equal(tg.sent().length, 1);
      db.close();
    }],
  ],
  pollBotOnce: [
    ['обробляє оновлення, зберігає offset = останній update_id + 1 і передає його в наступний запит', async ({ pollBotOnce }) => {
      const db = makeDb();
      const tg = makeTg({ updates: [update(10, 55, '/list'), update(11, 55, '/list')] });
      assert.equal(await pollBotOnce(db, tg, NOW), 2);
      assert.equal(db.prepare("SELECT value FROM sync_state WHERE key = 'tg_offset'").get().value, '12');
      await pollBotOnce(db, tg, NOW);
      const polls = tg.calls.filter(c => c.method === 'getUpdates');
      assert.equal(polls[0].payload.offset, 0); assert.equal(polls[1].payload.offset, 12);
      db.close();
    }],
    ['збій обробки одного оновлення не зупиняє решту і offset рухається далі', async ({ pollBotOnce }) => {
      const db = makeDb();
      const tg = makeTg({ updates: [update(1, 55, '/list'), update(2, 55, '/list')], fail: { sendMessage: [{ code: 500, message: 'boom' }] } });
      assert.equal(await pollBotOnce(db, tg, NOW), 2);
      assert.equal(tg.sent().length, 2);
      assert.equal(db.prepare("SELECT value FROM sync_state WHERE key = 'tg_offset'").get().value, '3');
      db.close();
    }],
  ],
  dispatchUrgent: [
    ['перший запуск лише ставить позначку часу: події, що вже були, не йдуть; нові після неї надсилаються рівно один раз', async ({ dispatchUrgent }) => {
      const db = makeDb(); const tg = makeTg();
      bound(db, { at: NOW - 500 });
      urgent(db, { at: NOW - 10, key: 'old' });
      assert.equal(await dispatchUrgent(db, tg, NOW, noSleep), 0);
      assert.equal(db.prepare("SELECT value FROM sync_state WHERE key = 'notify_started_at'").get().value, String(NOW));
      urgent(db, { at: NOW + 30, key: 'fresh' });
      assert.equal(await dispatchUrgent(db, tg, NOW + 60, noSleep), 1);
      assert.equal(await dispatchUrgent(db, tg, NOW + 120, noSleep), 0);
      assert.equal(tg.sent().length, 1);
      assert.match(tg.sent()[0].text, /^<b>Large TVL outflow<\/b>\n\n<b>Alpha USDC<\/b>  \|  Ethereum\n<code>0x1111\.\.\.1111<\/code>\n\nTVL: \$2M to \$1M/);
      assert.equal(tg.sent()[0].chat_id, 777);
      db.close();
    }],
    ['чужий vault, подія до прив\'язки чату, неважливий тип і вимкнена підписка - нічого не надсилають', async ({ dispatchUrgent }) => {
      const db = makeDb(); const tg = makeTg();
      await dispatchUrgent(db, tg, NOW, noSleep);
      bound(db, { at: NOW + 50 });
      urgent(db, { vault: B, at: NOW + 60 });
      urgent(db, { at: NOW + 10, key: 'before-bind' });
      urgent(db, { kind: 'reallocation', at: NOW + 60 });
      urgent(db, { kind: 'owner_changed', at: NOW + 60 });
      assert.equal(await dispatchUrgent(db, tg, NOW + 100, noSleep), 0);
      urgent(db, { at: NOW + 70, key: 'ok' });
      db.prepare('UPDATE tg_subscriptions SET active = 0').run();
      assert.equal(await dispatchUrgent(db, tg, NOW + 100, noSleep), 0);
      assert.equal(tg.calls.length, 0);
      db.close();
    }],
    ['події одного vault і типу йдуть одним повідомленням, усі їх ключі позначаються надісланими', async ({ dispatchUrgent }) => {
      const db = makeDb(); const tg = makeTg();
      await dispatchUrgent(db, tg, NOW, noSleep);
      bound(db, { at: NOW });
      urgent(db, { at: NOW + 1, key: 'g1' }); urgent(db, { at: NOW + 2, key: 'g2' }); urgent(db, { at: NOW + 3, key: 'g3', kind: 'bad_debt_appeared', details: { badDebtUsd: 5000, supplyUsd: 90000 } });
      assert.equal(await dispatchUrgent(db, tg, NOW + 10, noSleep), 2);
      assert.equal(tg.sent().length, 2);
      assert.match(tg.sent()[0].text, /^<b>Large TVL outflow \(2 changes\)<\/b>/);
      assert.equal(tg.sent()[0].parse_mode, 'HTML');
      assert.equal(tg.sent()[0].reply_markup.inline_keyboard[0][0].text, 'Open CheckYourMorpho');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tg_sent').get().c, 3);
      assert.equal(await dispatchUrgent(db, tg, NOW + 20, noSleep), 0);
      db.close();
    }],
    ['не більше 10 повідомлень на чат за раунд, решта наступного; між повідомленнями пауза 1.1 с', async ({ dispatchUrgent }) => {
      const db = makeDb(); const tg = makeTg(); const naps = [];
      const vaults = Array.from({ length: 12 }, (_, i) => '0x' + (100 + i).toString(16).padStart(40, '0'));
      for (const v of vaults) db.prepare('INSERT INTO vaults (address, chain_id, name) VALUES (?, 1, ?)').run(v, 'V' + v.slice(-3));
      await dispatchUrgent(db, tg, NOW, noSleep);
      bound(db, { at: NOW, vaults });
      vaults.forEach((v, i) => urgent(db, { vault: v, at: NOW + 1 + i, key: `e${i}` }));
      assert.equal(await dispatchUrgent(db, tg, NOW + 100, async ms => { naps.push(ms); }), 10);
      assert.deepEqual(naps, Array(9).fill(1100));
      assert.equal(await dispatchUrgent(db, tg, NOW + 200, noSleep), 2);
      assert.equal(tg.sent().length, 12);
      db.close();
    }],
    ['403 вимикає підписку; тимчасова помилка лишає її активною і повторює у наступному раунді', async ({ dispatchUrgent }) => {
      const db = makeDb();
      await dispatchUrgent(db, makeTg(), NOW, noSleep);
      bound(db, { at: NOW });
      urgent(db, { at: NOW + 1, key: 'a' }); urgent(db, { at: NOW + 2, key: 'b', kind: 'bad_debt_appeared', details: { badDebtUsd: 1, supplyUsd: 2 } });
      const flaky = makeTg({ fail: { sendMessage: [{ code: 500, message: 'down' }] } });
      assert.equal(await dispatchUrgent(db, flaky, NOW + 10, noSleep), 0);
      assert.equal(db.prepare('SELECT active FROM tg_subscriptions').get().active, 1);
      const ok = makeTg();
      assert.equal(await dispatchUrgent(db, ok, NOW + 20, noSleep), 2);
      urgent(db, { at: NOW + 30, key: 'c' });
      const blocked = makeTg({ fail: { sendMessage: [{ code: 403, message: 'Forbidden: bot was blocked by the user' }] } });
      assert.equal(await dispatchUrgent(db, blocked, NOW + 40, noSleep), 0);
      assert.equal(db.prepare('SELECT active FROM tg_subscriptions').get().active, 0);
      db.close();
    }],
  ],
  dispatchDigest: [
    ['до 09:00 за Києвом нічого; після - один дайджест зі змінами за добу, повторно того ж дня не надсилається', async ({ dispatchDigest }) => {
      const db = makeDb(); const tg = makeTg();
      bound(db);
      const sample = (t, verdict) => db.prepare('INSERT INTO vault_samples (vault_address, hour_bucket, sampled_at, verdict_level) VALUES (?, ?, ?, ?)').run(A, Math.floor(t / 3600), t, verdict);
      sample(NOW - 86400, 'green'); sample(NOW, 'red');
      const early = Date.UTC(2026, 0, 15, 6, 0) / 1000;
      assert.equal(await dispatchDigest(db, tg, early, noSleep), 0);
      assert.equal(await dispatchDigest(db, tg, NOW, noSleep), 1);
      assert.match(tg.sent()[0].text, /^<b>Daily digest<\/b>\n\n2026-01-15  \|  1 vault with changes\n\n<b>Alpha USDC<\/b>  \|  Ethereum\n<code>0x1111\.\.\.1111<\/code>\n- Risk worsened: no risk flags changed to risk flags$/);
      assert.equal(await dispatchDigest(db, tg, NOW + 600, noSleep), 0);
      assert.equal(tg.sent().length, 1);
      assert.equal(db.prepare("SELECT value FROM sync_state WHERE key = 'last_digest_date'").get().value, '2026-01-15');
      db.close();
    }],
    ['без змін нічого не шле, але день вважається виконаним', async ({ dispatchDigest }) => {
      const db = makeDb(); const tg = makeTg();
      bound(db);
      assert.equal(await dispatchDigest(db, tg, NOW, noSleep), 0);
      assert.equal(tg.calls.length, 0);
      assert.equal(db.prepare("SELECT value FROM sync_state WHERE key = 'last_digest_date'").get().value, '2026-01-15');
      db.close();
    }],
    ['тимчасова помилка залишає дату відкритою і наступний тік досилає без дублів; 403 вимикає підписку', async ({ dispatchDigest }) => {
      const db = makeDb();
      bound(db); bound(db, { sub: 'second-subscription-id', chat: 888, vaults: [B] });
      const ev = (v, k) => db.prepare("INSERT INTO vault_events (vault_address, chain_id, kind, source, severity, status, title, details_json, dedupe_key, occurred_at, detected_at) VALUES (?, 1, 'vault_delisted', 'derived', 'warning', 'final', 't', '{}', ?, ?, ?)").run(v, k, NOW - 60, NOW - 60);
      ev(A, 'd1'); ev(B, 'd2');
      const tg = makeTg({ fail: { sendMessage: [{ code: 500, message: 'down' }] } });
      assert.equal(await dispatchDigest(db, tg, NOW, noSleep), 1); // перша підписка впала, друга пройшла
      assert.equal(db.prepare("SELECT value FROM sync_state WHERE key = 'last_digest_date'").get(), undefined);
      assert.equal(await dispatchDigest(db, tg, NOW + 60, noSleep), 1); // досилається лише перша
      assert.deepEqual(tg.sent().map(m => m.chat_id), [777, 888, 777]);
      assert.equal(db.prepare("SELECT value FROM sync_state WHERE key = 'last_digest_date'").get().value, '2026-01-15');
      const db2 = makeDb(); bound(db2);
      db2.prepare("INSERT INTO vault_events (vault_address, chain_id, kind, source, severity, status, title, details_json, dedupe_key, occurred_at, detected_at) VALUES (?, 1, 'vault_delisted', 'derived', 'warning', 'final', 't', '{}', 'x', ?, ?)").run(A, NOW - 60, NOW - 60);
      await dispatchDigest(db2, makeTg({ fail: { sendMessage: [{ code: 403, message: 'Forbidden' }] } }), NOW, noSleep);
      assert.equal(db2.prepare('SELECT active FROM tg_subscriptions').get().active, 0);
      assert.equal(db2.prepare("SELECT value FROM sync_state WHERE key = 'last_digest_date'").get().value, '2026-01-15');
      db.close(); db2.close();
    }],
  ],
  startNotifications: [
    ['без токена нічого не запускає і повертає null', async ({ startNotifications, getBotInfo }) => {
      const db = makeDb();
      let called = 0;
      assert.equal(await startNotifications(db, { token: '', fetchImpl: async () => { called++; } }), null);
      assert.equal(called, 0); assert.equal(getBotInfo().enabled, false);
      db.close();
    }],
    ['з токеном знімає вебхук, запитує getMe, вмикає getBotInfo і зупиняється через stop()', async ({ startNotifications, getBotInfo }) => {
      const db = makeDb(); const methods = [];
      const fetchImpl = async url => {
        const method = url.split('/').pop(); methods.push(method);
        if (method === 'getUpdates') await new Promise(r => setTimeout(r, 15));
        return { status: 200, json: async () => ({ ok: true, result: method === 'getMe' ? { username: 'cym_bot' } : [] }) };
      };
      const h = await startNotifications(db, { token: 'T', fetchImpl, sleep: noSleep, tickMs: 1e9 });
      assert.deepEqual(methods.slice(0, 3), ['deleteWebhook', 'getMe', 'setMyCommands']);
      assert.deepEqual(getBotInfo(), { enabled: true, username: 'cym_bot' });
      await new Promise(r => setTimeout(r, 40));
      h.stop();
      await new Promise(r => setTimeout(r, 40));
      const after = methods.length;
      await new Promise(r => setTimeout(r, 60));
      assert.ok(methods.includes('getUpdates')); assert.equal(methods.length, after);
      db.close();
    }],
    ['збій запуску (getMe) -> null, а не виняток', async ({ startNotifications }) => {
      const db = makeDb();
      const fetchImpl = async () => ({ status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) });
      assert.equal(await startNotifications(db, { token: 'bad', fetchImpl }), null);
      db.close();
    }],
  ],
};
