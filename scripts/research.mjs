#!/usr/bin/env node
/**
 * AI research runner for the owner's PC (Node 22, no dependencies). Takes tokens from the server queue, researches each one
 * with the agy CLI and posts the results back. All logic lives in server/services/researchRunner.js; this file only wires
 * it to the real process, network and file system.
 *
 * node scripts/research.mjs --api https://host [--limit 40] [--tokens 1:0x..,8453:0x..] [--dry-run] [--max-minutes 240] [--out dir] [--model name] [--concurrency 1] [--min-free-mb 1400]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUNNER_DEFAULTS, parseArgs, buildAgyArgs, minimalEnv, acquireLock, runProcess, runResearch, researchToken } from '../server/services/researchRunner.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = msg => console.log(`${new Date().toISOString()} ${msg}`);

let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (err) {
  console.error(`${err.message}\nUsage: node scripts/research.mjs --api <baseUrl> [--limit 40] [--tokens 1:0x..,8453:0x..] [--dry-run] [--max-minutes 240] [--out dir] [--model name] [--concurrency 1] [--min-free-mb 1400]`);
  process.exit(1);
}

// The token never reaches the agy environment or the logs
const tokenFile = process.env.RESEARCH_TOKEN_FILE || path.join(process.env.USERPROFILE || os.homedir(), '.checkyourmorpho', 'research_token');
let apiToken = '';
try { apiToken = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { /* reported below */ }
if (!apiToken) { console.error(`Research token not found. Put it in ${tokenFile} or set RESEARCH_TOKEN_FILE.`); process.exit(1); }

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const agyBin = path.join(localAppData, 'agy', 'bin');
const workDir = path.join(localAppData, 'cym-research', 'work');
fs.mkdirSync(workDir, { recursive: true });
const env = minimalEnv(process.env, agyBin);
process.env.PATH = env.PATH;

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const rawDir = path.join(opts.outDir ? path.resolve(opts.outDir) : path.join(root, 'logs', 'research'), runId);
const killTree = pid => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else process.kill(pid, 'SIGKILL');
};
const agy = (args, timeoutMs) => runProcess(spawn, killTree, 'agy', args, { cwd: workDir, env, timeoutMs });
const headers = { authorization: `Bearer ${apiToken}` };

const deps = {
  lock: () => acquireLock(path.join(workDir, '.lock'), Date.now(), fs),
  freeBytes: () => os.freemem(),
  mcp: {
    list: async () => (await agy(['mcp', 'list'], 60000)).stdout,
    disable: name => agy(['mcp', 'disable', name], 60000)
  },
  getQueue: async limit => {
    const res = await fetch(`${opts.api}/api/research/queue?limit=${limit}`, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Queue request failed: HTTP ${res.status}`);
    return (await res.json()).tokens;
  },
  researchToken: (token, ctx) => researchToken(token, { runId, model: opts.model }, {
    now: Date.now,
    log: ctx.log,
    waitMemory: ctx.waitMemory,
    fetchImpl: fetch,
    runAgy: prompt => agy(buildAgyArgs({ prompt, model: opts.model }), RUNNER_DEFAULTS.agyTimeoutMs),
    saveRaw: (t, text) => {
      fs.mkdirSync(rawDir, { recursive: true });
      fs.writeFileSync(path.join(rawDir, `${t.chainId}_${t.address}.json`), text);
    },
    post: async body => {
      try {
        const res = await fetch(`${opts.api}/api/research`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) { log(`  server answered HTTP ${res.status}`); return null; }
        return await res.json();
      } catch (err) {
        log(`  post failed: ${err.message}`);
        return null;
      }
    }
  }),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  now: Date.now,
  log
};

try {
  const { exitCode } = await runResearch(opts, deps);
  process.exit(exitCode);
} catch (err) {
  log(`Run failed: ${err.message}`);
  process.exit(1);
}
