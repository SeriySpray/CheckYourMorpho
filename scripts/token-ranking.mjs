// Ranking of collateral tokens from the stored facts, from the safest to the riskiest (server/engine/tokenRisk.js).
// Usage: node scripts/token-ranking.mjs                 reads token_data from data/morpho.db (read only)
//        node scripts/token-ranking.mjs --file x.jsonl  reads one record per line: {chainId, address, symbol, status, coverage, data}
//        --db path      another SQLite file with a token_data table
//        --top N        rows printed to the console (default 30)
// The full Markdown report goes to reports/token-ranking.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankTokens, RISK_MODEL } from '../server/engine/tokenRisk.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN_NAMES = { 1: 'ethereum', 10: 'optimism', 130: 'unichain', 137: 'polygon', 143: 'monad', 999: 'hyperevm', 8453: 'base', 42161: 'arbitrum', 747474: 'katana' };
const chainName = id => CHAIN_NAMES[id] ?? String(id);
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

async function loadRecords() {
  const file = arg('--file');
  if (file) return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(arg('--db') ?? path.join(ROOT, 'data', 'morpho.db'), { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'token_data'").get()) {
      throw new Error('data/morpho.db has no token_data table yet: start the server once (it creates the table and collects tokens) or pass --file');
    }
    return db.prepare('SELECT chain_id, address, symbol, status, coverage, data_json FROM token_data').all()
      .map(r => ({ chainId: r.chain_id, address: r.address, symbol: r.symbol, status: r.status, coverage: r.coverage, data: JSON.parse(r.data_json) }));
  } finally { db.close(); }
}

const flagText = r => (r.grade === 'NR' ? r.not_rated_reason : r.top_flags.map(f => f.message).join('; ') || '-');
const cell = s => String(s ?? '').replace(/\|/g, '/');
const mdTable = rows => ['| # | Chain | Symbol | Stability | Grade | Confidence | Control | Main flags |', '|---|---|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.rank} | ${chainName(r.chainId)} | ${cell(r.symbol)} | ${r.score ?? '-'} | ${r.grade} | ${r.confidence} | ${r.control_score} | ${cell(flagText(r))} |`)].join('\n');

/** Markdown report of a ranking: counts by grade, the 20 safest, the 20 riskiest rated tokens and the not rated ones with the reason. */
export function rankingReport(ranked, { source = '', generatedAt = new Date().toISOString() } = {}) {
  const grades = ['A', 'B', 'C', 'D', 'E', 'NR'];
  const count = Object.fromEntries(grades.map(g => [g, ranked.filter(r => r.grade === g).length]));
  const rated = ranked.filter(r => r.grade !== 'NR');
  return [
    `# Collateral token ranking`, '',
    `Model \`${RISK_MODEL}\`, ${ranked.length} tokens, source: ${source || 'data/morpho.db'}, generated ${generatedAt}.`,
    'Stability score 0..100, higher is steadier; the rank is by stability only. Control is a separate score (who holds the keys, verification) and does not move the rank. NR: not rated (too little data or no price).', '',
    '## By grade', '', '| Grade | Tokens |', '|---|---|', ...grades.map(g => `| ${g} | ${count[g]} |`), '',
    '## 20 safest', '', mdTable(rated.slice(0, 20)), '',
    '## 20 riskiest (rated)', '', mdTable(rated.slice(-20).reverse()), '',
    `## Not rated (${count.NR})`, '', mdTable(ranked.filter(r => r.grade === 'NR')), ''
  ].join('\n');
}

async function main() {
  const ranked = rankTokens(await loadRecords());
  const top = Number(arg('--top')) || 30;
  const pad = (s, w) => String(s ?? '').slice(0, w).padEnd(w);
  console.log(`${pad('#', 4)} ${pad('chain', 9)} ${pad('symbol', 22)} ${pad('score', 6)} ${pad('grade', 5)} ${pad('conf', 6)} flags`);
  for (const r of ranked.slice(0, top)) console.log(`${pad(r.rank, 4)} ${pad(chainName(r.chainId), 9)} ${pad(r.symbol, 22)} ${pad(r.score ?? '-', 6)} ${pad(r.grade, 5)} ${pad(r.confidence, 6)} ${flagText(r).slice(0, 110)}`);
  const by = ranked.reduce((m, r) => ({ ...m, [r.grade]: (m[r.grade] ?? 0) + 1 }), {});
  console.log(`\n${ranked.length} tokens:`, ['A', 'B', 'C', 'D', 'E', 'NR'].map(g => `${g} ${by[g] ?? 0}`).join(', '));
  const out = path.join(ROOT, 'reports', 'token-ranking.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rankingReport(ranked, { source: arg('--file') ? path.basename(arg('--file')) : '' }));
  console.log(`Report: ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
