import { diffVaultSamples } from '../engine/digestEngine.js';
import { escapeHtml, message, vaultBlock, paginate } from '../engine/notifyRules.js';

const DAY = 86400;
const DIGEST_HOUR_KYIV = 9;
const MIN_APY_SAMPLES = 48;

const compactUsd = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));

/**
 * Returns the Kyiv calendar date (YYYY-MM-DD) when a digest is due at nowSec, or null.
 * Due from 09:00 Kyiv time until the date has been sent, so a restart or downtime still delivers it once.
 */
export function digestDue(nowSec, lastDigestDate = null) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(nowSec * 1000)).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return Number(parts.hour) >= DIGEST_HOUR_KYIV && date !== lastDigestDate ? date : null;
}

/**
 * Builds digest entries for the given vault addresses: snapshot diffs against the sample about 24h ago
 * plus delistings and the reallocation summary of the last 24h. Vaults without changes are left out.
 */
export function buildDigest(db, addresses, nowSec = Math.floor(Date.now() / 1000)) {
  const entries = [];
  const latest = db.prepare('SELECT * FROM vault_samples WHERE vault_address = ? ORDER BY hour_bucket DESC LIMIT 1');
  const baselineStmt = db.prepare(`
    SELECT * FROM vault_samples WHERE vault_address = ? AND sampled_at BETWEEN ? AND ?
    ORDER BY ABS(sampled_at - ?) LIMIT 1
  `);
  const avgStmt = db.prepare('SELECT AVG(net_apy) AS avg, COUNT(net_apy) AS n FROM vault_samples WHERE vault_address = ? AND sampled_at >= ? AND net_apy IS NOT NULL');
  const eventsStmt = db.prepare(`
    SELECT kind, title, details_json FROM vault_events
    WHERE vault_address = ? AND kind IN ('vault_delisted', 'reallocation') AND occurred_at >= ?
  `);
  const nameStmt = db.prepare('SELECT name, chain_id FROM vaults WHERE address = ?');

  for (const address of addresses) {
    const addr = String(address).toLowerCase();
    const current = latest.get(addr);
    const baseline = baselineStmt.get(addr, nowSec - 36 * 3600, nowSec - 12 * 3600, nowSec - DAY);
    const avg = avgStmt.get(addr, nowSec - 7 * DAY);
    const items = current && baseline && current.hour_bucket !== baseline.hour_bucket
      ? diffVaultSamples(baseline, current, avg.n >= MIN_APY_SAMPLES ? avg.avg : null)
      : [];

    let reallocCount = 0;
    let reallocUsd = 0;
    for (const ev of eventsStmt.all(addr, nowSec - DAY)) {
      if (ev.kind === 'vault_delisted') { items.push({ type: 'delisted', text: 'Vault was delisted from the Morpho registry' }); continue; }
      reallocCount++;
      try { reallocUsd += Number(JSON.parse(ev.details_json).volumeUsd) || 0; } catch { /* a malformed row only loses its volume */ }
    }
    if (reallocCount > 0) {
      items.push({ type: 'reallocation', text: `${reallocCount} reallocation${reallocCount === 1 ? '' : 's'}${reallocUsd > 0 ? `, about $${compactUsd(reallocUsd)} moved` : ''}` });
    }

    if (items.length > 0) {
      const v = nameStmt.get(addr);
      entries.push({ address: addr, name: v?.name ?? null, chainId: v?.chain_id ?? null, items });
    }
  }
  return entries;
}

/** Formats digest entries into Telegram HTML messages that fit one Telegram message each. */
export function formatDigest(entries, dateLabel) {
  const header = message('Daily digest', `${dateLabel}  |  ${entries.length} vault${entries.length === 1 ? '' : 's'} with changes`);
  const blocks = entries.map(e => [vaultBlock(e.name, e.chainId, e.address), ...e.items.map(i => `- ${escapeHtml(i.text)}`)].join('\n'));
  return paginate(header, blocks);
}
