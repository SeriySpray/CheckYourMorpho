import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../server/db/schema.js';

const NOW = 1_750_000_000;
const DAY = 86400;
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const v = db.prepare('INSERT INTO vaults (address, chain_id, name) VALUES (?, 1, ?)');
  v.run(A, 'Alpha USDC'); v.run(B, 'Beta WETH');
  return db;
}
const sample = (db, addr, t, o = {}) => db.prepare(`
  INSERT OR REPLACE INTO vault_samples (vault_address, hour_bucket, sampled_at, total_assets, total_assets_usd, net_apy, mqi_percent, verdict_level, fee, is_listed)
  VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, 1)`).run(addr, Math.floor(t / 3600), t, o.apy ?? 0.05, o.mqi ?? 95, o.verdict ?? 'green', o.fee ?? 0.05);
let seq = 0;
const event = (db, addr, kind, o = {}) => db.prepare(`
  INSERT INTO vault_events (vault_address, chain_id, kind, source, severity, status, title, details_json, dedupe_key, occurred_at, detected_at)
  VALUES (?, 1, ?, 'x', 'info', 'final', 't', ?, ?, ?, ?)`).run(addr, kind, JSON.stringify(o.details ?? {}), `${kind}-${seq++}`, o.at ?? NOW - 3600, o.at ?? NOW - 3600);

export default {
  digestDue: [
    ['до 09:00 за Києвом дайджесту немає, з 09:00 є, після відправки того ж дня немає', ({ digestDue }) => {
      // 06:59 UTC = 08:59 Kyiv взимку (UTC+2), 07:00 UTC = 09:00 Kyiv
      const t = Date.UTC(2026, 0, 15, 6, 59) / 1000;
      assert.equal(digestDue(t, null), null);
      assert.equal(digestDue(t + 60, null), '2026-01-15');
      assert.equal(digestDue(t + 60, '2026-01-15'), null);
      assert.equal(digestDue(t + 60, '2026-01-14'), '2026-01-15');
    }],
    ['літній час: 06:00 UTC = 09:00 Kyiv (UTC+3); пропущений ранок досилається пізніше того ж дня', ({ digestDue }) => {
      const t = Date.UTC(2026, 6, 15, 5, 59) / 1000;
      assert.equal(digestDue(t, null), null);
      assert.equal(digestDue(t + 60, null), '2026-07-15');
      assert.equal(digestDue(Date.UTC(2026, 6, 15, 18, 0) / 1000, null), '2026-07-15');
    }],
    ['північ за Києвом починає нову дату, але до 09:00 дайджесту ще немає', ({ digestDue }) => {
      assert.equal(digestDue(Date.UTC(2026, 0, 15, 22, 30) / 1000, '2026-01-15'), null);
    }],
  ],
  buildDigest: [
    ['змін немає -> порожній результат; зміна вердикту і fee відносно знімка за ~24 год', ({ buildDigest }) => {
      const db = makeDb();
      sample(db, A, NOW - DAY, {}); sample(db, A, NOW, {});
      assert.deepEqual(buildDigest(db, [A], NOW), []);
      sample(db, A, NOW, { verdict: 'red', fee: 0.1 });
      const r = buildDigest(db, [A], NOW);
      assert.equal(r.length, 1); assert.equal(r[0].name, 'Alpha USDC');
      assert.deepEqual(r[0].items.map(i => i.type), ['verdict', 'fee']);
      db.close();
    }],
    ['vault без знімка за добу (новий) нічого не дає; регістр адреси не важливий', ({ buildDigest }) => {
      const db = makeDb();
      sample(db, A, NOW, { verdict: 'red' });
      assert.deepEqual(buildDigest(db, [A], NOW), []);
      sample(db, A, NOW - DAY, {});
      assert.equal(buildDigest(db, [A.toUpperCase().replace('0X', '0x')], NOW).length, 1);
      db.close();
    }],
    ['Net APY: потрібно >= 48 знімків для середнього; після цього падіння видно', ({ buildDigest }) => {
      const db = makeDb();
      for (let h = 0; h < 40; h++) sample(db, A, NOW - 3600 * (h + 1) * 3, { apy: 0.05 });
      sample(db, A, NOW, { apy: 0.02 });
      assert.deepEqual(buildDigest(db, [A], NOW), []);
      for (let h = 0; h < 30; h++) sample(db, A, NOW - 3600 * (h + 1), { apy: 0.05 });
      const r = buildDigest(db, [A], NOW);
      assert.equal(r.length, 1); assert.equal(r[0].items[0].type, 'apy');
      db.close();
    }],
    ['delisting і зведення перерозподілів за 24 год; старіші за добу не рахуються', ({ buildDigest }) => {
      const db = makeDb();
      event(db, A, 'vault_delisted');
      event(db, B, 'reallocation', { details: { volumeUsd: 2_500_000 } });
      event(db, B, 'reallocation', { details: { volumeUsd: 500_000 } });
      event(db, B, 'reallocation', { details: { volumeUsd: 9_000_000 }, at: NOW - 2 * DAY });
      const r = buildDigest(db, [A, B], NOW);
      assert.equal(r[0].items[0].type, 'delisted');
      assert.equal(r[1].items[0].text, '2 reallocations, about $3.0M moved');
      db.close();
    }],
  ],
  formatDigest: [
    ['заголовок з датою, блок на vault, пункти зі списком', ({ formatDigest }) => {
      const [m] = formatDigest([{ address: A, name: 'Alpha USDC', items: [{ text: 'Verdict changed from GREEN to RED' }, { text: 'x' }] }], '2026-10-22');
      assert.equal(m, '<b>Daily digest</b>\n\n2026-10-22  |  1 vault with changes\n\n<b>Alpha USDC</b>\n<code>0x1111...1111</code>\n- Verdict changed from GREEN to RED\n- x');
    }],
    ['довгий дайджест ділиться на повідомлення до 4096 символів, кожне починається із заголовка, блок не розривається', ({ formatDigest }) => {
      const entries = Array.from({ length: 60 }, (_, i) => ({ address: A, name: `Vault ${i}`, items: [{ text: 'a'.repeat(120) }, { text: 'b'.repeat(120) }] }));
      const msgs = formatDigest(entries, '2026-10-22');
      assert.ok(msgs.length > 1);
      for (const m of msgs) { assert.ok(m.length <= 4096); assert.ok(m.startsWith('<b>Daily digest</b>')); }
      assert.equal(msgs.join('\n').match(/<b>Vault \d+<\/b>/g).length, 60);
    }],
    ['мережа додається після назви, коли відома', ({ formatDigest }) => {
      assert.match(formatDigest([{ address: A, name: 'Alpha', chainId: 8453, items: [{ text: 't' }] }], 'd')[0], /\n<b>Alpha<\/b>  \|  Base\n<code>0x1111\.\.\.1111<\/code>/);
    }],
    ['vault без імені підписується як Vault', ({ formatDigest }) => {
      assert.match(formatDigest([{ address: B, name: null, items: [{ text: 't' }] }], 'd')[0], /\n<b>Vault<\/b>\n<code>0x2222\.\.\.2222<\/code>/);
    }],
    ['назва vault з розміткою екранується', ({ formatDigest }) => {
      assert.ok(formatDigest([{ address: A, name: 'A <b>&</b>', items: [{ text: 'x < y' }] }], 'd')[0].includes('<b>A &lt;b&gt;&amp;&lt;/b&gt;</b>'));
      assert.ok(formatDigest([{ address: A, name: 'n', items: [{ text: 'x < y' }] }], 'd')[0].includes('- x &lt; y'));
    }],
  ],
};
