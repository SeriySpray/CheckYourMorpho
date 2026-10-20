/**
 * Logic of the research runner (scripts/research.mjs), kept here so the tests cover it. The runner takes tokens from the
 * server queue, researches them one by one with the agy CLI on the owner's PC and posts each result back. Everything that
 * touches the outside (agy, network, files, memory, clock) comes in through `deps`, so tests never start agy or use the network.
 */
import path from 'node:path';
import { buildResearchPrompt, checkSources, extractResearchJson, validateResearch, SCHEMA_PATH, PROMPT_VERSION } from './tokenResearch.js';

export const RUNNER_DEFAULTS = {
  model: 'gemini-3.8-flash-high',
  limit: 40,
  maxMinutes: 240,
  minFreeBytes: 1.2 * 1024 ** 3,
  lockMaxAgeMs: 8 * 3600e3,
  agyTimeoutMs: 12 * 60e3,
  pauseMs: 5000,
  // MCP servers that make the agent open a browser and eat memory
  mcpToDisable: ['playwright', 'context7', 'pencil']
};

const ENV_KEEP = ['PATH', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP'];
const TOKEN_RE = /^(\d+):(0x[0-9a-fA-F]{40})$/;
const FATAL_RE = /quota|credits|authentication expired/i;

/**
 * Parses the CLI arguments.
 * @returns {{api:string, limit:number, tokens:Array<{chainId:number,address:string}>|null, dryRun:boolean, maxMinutes:number, outDir:string|null, model:string}}
 * @throws {Error} on an unknown flag, a missing value or an invalid value
 */
export function parseArgs(argv) {
  const o = { api: null, limit: RUNNER_DEFAULTS.limit, tokens: null, dryRun: false, maxMinutes: RUNNER_DEFAULTS.maxMinutes, outDir: null, model: RUNNER_DEFAULTS.model };
  const int = (name, v, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') { o.dryRun = true; continue; }
    if (!['--api', '--limit', '--tokens', '--max-minutes', '--out', '--model'].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--api') {
      let u;
      try { u = new URL(value); } catch { throw new Error('--api must be a URL'); }
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('--api must be http or https');
      o.api = u.origin + u.pathname.replace(/\/+$/, '');
    } else if (flag === '--limit') o.limit = int('--limit', value, 1, 200);
    else if (flag === '--max-minutes') o.maxMinutes = int('--max-minutes', value, 1, 1440);
    else if (flag === '--out') o.outDir = value;
    else if (flag === '--model') o.model = value;
    else {
      o.tokens = value.split(',').map(part => {
        const m = TOKEN_RE.exec(part.trim());
        if (!m) throw new Error(`--tokens entry "${part}" is not <chainId>:<0x address>`);
        return { chainId: Number(m[1]), address: m[2].toLowerCase() };
      });
    }
  }
  if (!o.api) throw new Error('--api <baseUrl> is required');
  return o;
}

/** Arguments of one non-interactive agy call. The sandbox flag is mandatory because the agent sometimes runs commands. */
export function buildAgyArgs({ prompt, schemaPath = SCHEMA_PATH, model = RUNNER_DEFAULTS.model }) {
  return ['-p', prompt, '--output-format', 'json', '--json-schema', schemaPath, '--model', model,
    '--dangerously-skip-permissions', '--sandbox', '--print-timeout', '600s'];
}

/** Minimal environment for agy: no secrets, and the agy bin folder on PATH. Variable names match case-insensitively (Windows). */
export function minimalEnv(env, agyBinDir = null) {
  const out = {};
  for (const name of ENV_KEEP) {
    const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
    if (key && env[key] != null) out[name] = String(env[key]);
  }
  if (agyBinDir && !(out.PATH || '').split(path.delimiter).includes(agyBinDir)) out.PATH = [agyBinDir, out.PATH].filter(Boolean).join(path.delimiter);
  return out;
}

/** @returns {{ok:boolean, freeGb:number}} */
export function checkMemory(freeBytes, minBytes = RUNNER_DEFAULTS.minFreeBytes) {
  return { ok: freeBytes >= minBytes, freeGb: Math.round((freeBytes / 1024 ** 3) * 10) / 10 };
}

/**
 * Takes the run lock (a file created exclusively). A lock older than lockMaxAgeMs is considered dead and replaced.
 * @param {{writeFileSync:Function, statSync:Function, unlinkSync:Function}} fsImpl
 * @returns {{ok:boolean, release:()=>void}}
 */
export function acquireLock(lockPath, nowMs, fsImpl) {
  const take = () => { fsImpl.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: nowMs }), { flag: 'wx' }); };
  const release = () => { try { fsImpl.unlinkSync(lockPath); } catch { /* already gone */ } };
  try { take(); return { ok: true, release }; } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  let age = 0;
  try { age = nowMs - fsImpl.statSync(lockPath).mtimeMs; } catch { age = Infinity; }
  if (age < RUNNER_DEFAULTS.lockMaxAgeMs) return { ok: false, release: () => {} };
  release();
  try { take(); return { ok: true, release }; } catch { return { ok: false, release: () => {} }; }
}

/** Names from `agy mcp list` output that are enabled. Lines that do not say "disabled" count as enabled (disabling twice is harmless). */
export function enabledMcpServers(listOutput, names = RUNNER_DEFAULTS.mcpToDisable) {
  const lines = String(listOutput ?? '').split(/\r?\n/);
  return names.filter(name => lines.some(l => l.toLowerCase().includes(name) && !/disabled|\boff\b/i.test(l)));
}

/** True when agy output says the whole run must stop (no quota, no credits, login expired). */
export function isFatalAgyMessage(text) {
  return FATAL_RE.test(String(text ?? ''));
}

/**
 * Runs one process with a time limit and kills its whole tree on timeout.
 * @param {Function} spawnImpl node:child_process spawn compatible
 * @param {(pid:number)=>void} killTree
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
export function runProcess(spawnImpl, killTree, cmd, args, { cwd, env, timeoutMs }) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const child = spawnImpl(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const finish = code => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); } };
    const timer = setTimeout(() => { timedOut = true; try { killTree(child.pid); } catch { /* process already gone */ } finish(null); }, timeoutMs);
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('error', err => { stderr += String(err.message); finish(-1); });
    child.on('close', code => finish(code));
  });
}

/**
 * Researches one token: agy, parse, local checks, post. A failed attempt is repeated once.
 * Posts the last attempt even when invalid, so the server records the failure and can put the token on hold.
 * @param {{chainId:number, address:string, symbol:string|null, tags:string[]|null}} token
 * @param {object} deps {runAgy(prompt), fetchImpl, post(body), saveRaw(token, text), now(), log(msg)}
 * @returns {Promise<{status:'accepted'|'rejected'|'kept_previous'|'pending_confirmation'|'failed'|'fatal', detail:string}>}
 */
export async function researchToken(token, { runId, model }, deps) {
  const today = new Date(deps.now()).toISOString().slice(0, 10);
  const prompt = buildResearchPrompt(token, today);
  let last = { raw: { runner_error: 'no attempt' }, checks: [], problem: 'no attempt' };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await deps.runAgy(prompt);
    deps.saveRaw(token, `${r.stdout}\n--- stderr ---\n${r.stderr}`);
    const failed = r.timedOut || r.code !== 0;
    const raw = failed ? null : extractResearchJson(r.stdout);
    if (!raw) {
      // Only a failed call can mean "no quota": a good answer may contain these words in its text
      if (isFatalAgyMessage(`${r.stdout}\n${r.stderr}`)) return { status: 'fatal', detail: 'agy reported a quota, credits or login problem' };
      const problem = r.timedOut ? 'timeout' : failed ? `exit code ${r.code}` : 'no JSON in the output';
      last = { raw: { runner_error: problem }, checks: [], problem };
      continue;
    }
    const checks = Array.isArray(raw.sources) ? await checkSources(raw.sources.slice(0, 12).filter(s => s && typeof s.url === 'string'), { symbol: token.symbol || raw.symbol, address: token.address }, deps.fetchImpl) : [];
    const verdict = validateResearch(raw, token, checks, Math.floor(deps.now() / 1000));
    last = { raw, checks, problem: verdict.ok ? null : verdict.errors.slice(0, 3).join('; ') };
    if (verdict.ok) break;
    deps.log(`  attempt ${attempt}: invalid (${last.problem})`);
  }
  const out = await deps.post({ runId, model, promptVersion: PROMPT_VERSION, chainId: token.chainId, address: token.address, raw: last.raw, checks: last.checks });
  if (!out || typeof out.outcome !== 'string') return { status: 'failed', detail: 'server did not accept the result' };
  return { status: out.outcome, detail: out.errors?.length ? out.errors.slice(0, 3).join('; ') : (last.problem || '') };
}

/**
 * Whole run. Exit codes: 0 done, 1 failed or stopped by a quota/login problem, 2 not enough free memory, 3 another run holds the lock.
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {object} deps {lock(), freeBytes(), mcp:{list(), disable(name)}, getQueue(limit), researchToken(token), sleep(ms), now(), log(msg)}
 * @returns {Promise<{exitCode:number, summary:object}>}
 */
export async function runResearch(opts, deps) {
  const summary = { accepted: 0, rejected: 0, kept: 0, pending: 0, failed: 0, skipped: 0 };
  const lock = deps.lock();
  if (!lock.ok) { deps.log('Another research run is active (lock file present); exiting.'); return { exitCode: 3, summary }; }
  try {
    const mem = checkMemory(deps.freeBytes());
    if (!mem.ok) { deps.log(`Only ${mem.freeGb} GB of memory is free; not starting.`); return { exitCode: 2, summary }; }
    if (!opts.dryRun) {
      for (const name of enabledMcpServers(await deps.mcp.list())) {
        deps.log(`MCP server "${name}" was enabled; disabling it for research runs.`);
        await deps.mcp.disable(name);
      }
    }
    const tokens = opts.tokens ? opts.tokens.map(t => ({ ...t, symbol: null, tags: null })) : await deps.getQueue(opts.limit);
    deps.log(`Queue: ${tokens.length} token(s).`);
    if (opts.dryRun) {
      tokens.forEach(t => deps.log(`  ${t.chainId}:${t.address} ${t.symbol ?? ''}`));
      return { exitCode: 0, summary };
    }
    const deadline = deps.now() + opts.maxMinutes * 60e3;
    let exitCode = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (deps.now() >= deadline) { summary.skipped += tokens.length - i; deps.log('Time budget used up; the rest waits for the next run.'); break; }
      const t = tokens[i];
      deps.log(`[${i + 1}/${tokens.length}] ${t.chainId}:${t.address} ${t.symbol ?? ''}`);
      let res;
      try { res = await deps.researchToken(t); } catch (err) { res = { status: 'failed', detail: err.message }; }
      deps.log(`  -> ${res.status}${res.detail ? `: ${res.detail}` : ''}`);
      if (res.status === 'fatal') { summary.skipped += tokens.length - i; exitCode = 1; break; }
      if (res.status === 'accepted') summary.accepted++;
      else if (res.status === 'rejected') summary.rejected++;
      else if (res.status === 'kept_previous') summary.kept++;
      else if (res.status === 'pending_confirmation') summary.pending++;
      else summary.failed++;
      if (i < tokens.length - 1) await deps.sleep(RUNNER_DEFAULTS.pauseMs);
    }
    deps.log(`Done: ${JSON.stringify(summary)}`);
    return { exitCode, summary };
  } finally {
    lock.release();
  }
}
