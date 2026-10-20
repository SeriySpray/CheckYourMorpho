import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SCHEMA_PATH } from '../../server/services/tokenResearch.js';

// Nothing here starts agy or touches the network: every outside dependency is a fake.
const WETH_OUT = fs.readFileSync(new URL('../data/agy_weth.json', import.meta.url), 'utf8');
const WETH_RAW = JSON.parse(JSON.parse(WETH_OUT).response);
const WETH = WETH_RAW.address;
const NOW = Date.parse('2026-10-21T12:00:00Z');
const token = { chainId: 1, address: WETH, symbol: 'WETH', tags: ['eth'] };
const ok = (stdout = WETH_OUT) => ({ code: 0, stdout, stderr: '', timedOut: false });

// Every cited page answers 200 and names the token
const pagesFetch = async () => ({ status: 200, headers: new Headers(), body: new Response(`WETH ${WETH}`).body, text: async () => `WETH ${WETH}` });

function tokenDeps(runs, over = {}) {
  const calls = { agy: 0, posts: [], saved: [], logs: [] };
  const queue = [...runs];
  return {
    calls,
    deps: {
      now: () => NOW, log: m => calls.logs.push(m), fetchImpl: pagesFetch,
      runAgy: async () => { calls.agy++; return queue.shift() ?? ok(); },
      saveRaw: (t, text) => calls.saved.push([t.address, text]),
      post: async body => { calls.posts.push(body); return { outcome: 'accepted', errors: [] }; },
      ...over
    }
  };
}

function runDeps(over = {}) {
  const calls = { logs: [], slept: [], researched: [], disabled: [], released: 0, queueLimit: null };
  const deps = {
    lock: () => ({ ok: true, release: () => { calls.released++; } }),
    freeBytes: () => 4 * 1024 ** 3,
    mcp: { list: async () => 'playwright  enabled\ncontext7  disabled\npencil  disabled', disable: async n => { calls.disabled.push(n); } },
    getQueue: async limit => { calls.queueLimit = limit; return [{ chainId: 1, address: '0xa', symbol: 'A', tags: null }, { chainId: 1, address: '0xb', symbol: 'B', tags: null }]; },
    researchToken: async t => { calls.researched.push(t.address); return { status: 'accepted', detail: '' }; },
    sleep: async ms => { calls.slept.push(ms); }, now: () => NOW, log: m => calls.logs.push(m), ...over
  };
  return { calls, deps };
}
const baseOpts = (over = {}) => ({ api: 'https://x', limit: 40, tokens: null, dryRun: false, maxMinutes: 240, outDir: null, model: 'm', ...over });

// Fake child process for runProcess
function fakeSpawn({ pid = 4242, run }) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter(); child.pid = pid; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    calls.push({ cmd, args, opts });
    queueMicrotask(() => run?.(child));
    return child;
  };
  impl.calls = calls;
  return impl;
}

export default {
  RUNNER_DEFAULTS: [['values from the plan', ({ RUNNER_DEFAULTS: d }) => {
    assert.equal(d.model, 'gemini-3.8-flash-high'); assert.equal(d.limit, 40); assert.equal(d.maxMinutes, 240);
    assert.equal(d.minFreeBytes, 1.2 * 1024 ** 3); assert.equal(d.lockMaxAgeMs, 8 * 3600e3); assert.equal(d.agyTimeoutMs, 12 * 60e3); assert.equal(d.pauseMs, 5000);
    assert.deepEqual(d.mcpToDisable, ['playwright', 'context7', 'pencil']);
  }]],

  parseArgs: [
    ['defaults and a trimmed api URL', ({ parseArgs: f }) => {
      const o = f(['--api', 'https://checkyourmorpho.duckdns.org/']);
      assert.deepEqual(o, { api: 'https://checkyourmorpho.duckdns.org', limit: 40, tokens: null, dryRun: false, maxMinutes: 240, outDir: null, model: 'gemini-3.8-flash-high' });
      assert.equal(f(['--api', 'http://localhost:3000/base/']).api, 'http://localhost:3000/base');
    }],
    ['all flags', ({ parseArgs: f }) => {
      const a = '0x' + 'A'.repeat(40), b = '0x' + 'b'.repeat(40);
      const o = f(['--api', 'https://h', '--limit', '5', '--tokens', `1:${a},8453:${b}`, '--dry-run', '--max-minutes', '30', '--out', 'C:\\x', '--model', 'mm']);
      assert.deepEqual(o, { api: 'https://h', limit: 5, tokens: [{ chainId: 1, address: a.toLowerCase() }, { chainId: 8453, address: b }], dryRun: true, maxMinutes: 30, outDir: 'C:\\x', model: 'mm' });
    }],
    ['unknown flag, missing value, missing api and bad api are errors', ({ parseArgs: f }) => {
      assert.throws(() => f(['--api', 'https://h', '--wat']), /Unknown argument/);
      assert.throws(() => f(['--api']), /needs a value/);
      assert.throws(() => f(['--api', '--limit', '3']), /needs a value/);
      assert.throws(() => f([]), /--api/);
      assert.throws(() => f(['--api', 'ftp://h']), /http or https/);
      assert.throws(() => f(['--api', 'not a url']), /must be a URL/);
    }],
    ['limit and max-minutes ranges, token format', ({ parseArgs: f }) => {
      for (const [flag, v] of [['--limit', '0'], ['--limit', '201'], ['--limit', 'abc'], ['--limit', '1.5'], ['--max-minutes', '0'], ['--max-minutes', '1441']]) {
        assert.throws(() => f(['--api', 'https://h', flag, v]), /must be an integer/, `${flag} ${v}`);
      }
      assert.equal(f(['--api', 'https://h', '--limit', '200']).limit, 200);
      for (const t of ['1:0x12', 'x:0x' + 'a'.repeat(40), '0x' + 'a'.repeat(40), '1:0x' + 'g'.repeat(40), '']) assert.throws(() => f(['--api', 'https://h', '--tokens', t]), /not <chainId>/, t);
    }],
  ],

  buildAgyArgs: [
    ['non-interactive, JSON output, schema, model, sandbox, skip-permissions and 600 s print timeout', ({ buildAgyArgs: f }) => {
      assert.deepEqual(f({ prompt: 'P' }), ['-p', 'P', '--output-format', 'json', '--json-schema', SCHEMA_PATH, '--model', 'gemini-3.8-flash-high',
        '--dangerously-skip-permissions', '--sandbox', '--print-timeout', '600s']);
      const a = f({ prompt: 'P', schemaPath: 'S', model: 'M' });
      assert.ok(a.includes('S') && a.includes('M') && a.includes('--sandbox') && !a.includes('--effort') && !a.includes('--mode'));
    }],
  ],

  minimalEnv: [
    ['keeps only the allowed variables, matches names case-insensitively, drops every secret', ({ minimalEnv: f }) => {
      const e = f({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'u', APPDATA: 'a', LocalAppData: 'l', TEMP: 't',
        RESEARCH_TOKEN: 's1', SYNC_TOKEN: 's2', GEMINI_API_KEY: 's3', HOME: 'h', TMP: 'x' });
      assert.deepEqual(e, { PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'u', APPDATA: 'a', LOCALAPPDATA: 'l', TEMP: 't' });
    }],
    ['puts the agy bin folder first once', ({ minimalEnv: f }) => {
      assert.equal(f({ PATH: 'a' }, 'AGY').PATH, `AGY${path.delimiter}a`);
      assert.equal(f({ PATH: `x${path.delimiter}AGY` }, 'AGY').PATH, `x${path.delimiter}AGY`);
      assert.equal(f({}, 'AGY').PATH, 'AGY');
      assert.deepEqual(f({}), {});
    }],
  ],

  checkMemory: [
    ['threshold is inclusive and free memory is reported in GB', ({ checkMemory: f }) => {
      assert.deepEqual(f(1.2 * 1024 ** 3), { ok: true, freeGb: 1.2 });
      assert.deepEqual(f(1.2 * 1024 ** 3 - 1), { ok: false, freeGb: 1.2 });
      assert.deepEqual(f(0.5 * 1024 ** 3), { ok: false, freeGb: 0.5 });
      assert.equal(f(100, 50).ok, true);
    }],
  ],

  acquireLock: [
    ['first run gets the lock, a second one does not, release frees it', ({ acquireLock: f }) => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cym-lock-')), '.lock');
      const a = f(file, Date.now(), fs); assert.equal(a.ok, true); assert.ok(fs.existsSync(file));
      assert.equal(f(file, Date.now(), fs).ok, false);
      a.release(); assert.ok(!fs.existsSync(file)); a.release();
      const b = f(file, Date.now(), fs); assert.equal(b.ok, true); b.release();
    }],
    ['a lock older than 8 hours is dead and replaced; a fresh one is respected', ({ acquireLock: f }) => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cym-lock-')), '.lock');
      fs.writeFileSync(file, 'old');
      const old = new Date(Date.now() - 9 * 3600e3); fs.utimesSync(file, old, old);
      const a = f(file, Date.now(), fs); assert.equal(a.ok, true);
      assert.notEqual(fs.readFileSync(file, 'utf8'), 'old');
      const younger = new Date(Date.now() - 7 * 3600e3); fs.utimesSync(file, younger, younger);
      assert.equal(f(file, Date.now(), fs).ok, false);
      a.release();
    }],
    ['other file errors are not hidden', ({ acquireLock: f }) => {
      const broken = { writeFileSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
      assert.throws(() => f('x', 0, broken), /denied/);
    }],
  ],

  enabledMcpServers: [
    ['servers not marked disabled are returned', ({ enabledMcpServers: f }) => {
      assert.deepEqual(f('playwright  enabled\ncontext7  disabled\npencil  enabled'), ['playwright', 'pencil']);
      assert.deepEqual(f('Playwright: ON\r\nContext7: off\r\n'), ['playwright']);
      assert.deepEqual(f('playwright (disabled)\ncontext7 (disabled)\npencil (disabled)'), []);
    }],
    ['empty or unrelated output and a custom name list', ({ enabledMcpServers: f }) => {
      assert.deepEqual(f(''), []); assert.deepEqual(f(null), []); assert.deepEqual(f('github  enabled'), []);
      assert.deepEqual(f('github enabled', ['github']), ['github']);
    }],
  ],

  isFatalAgyMessage: [
    ['quota, credits and expired login stop the run', ({ isFatalAgyMessage: f }) => {
      for (const m of ['Error: quota exceeded', 'You are out of credits', 'Authentication expired, run agy login', 'QUOTA']) assert.equal(f(m), true, m);
      for (const m of ['', null, 'timeout', 'ok']) assert.equal(f(m), false, String(m));
    }],
  ],

  runProcess: [
    ['collects stdout and stderr and reports the exit code; options are passed on', async ({ runProcess: f }) => {
      const sp = fakeSpawn({ run: c => { c.stdout.emit('data', 'ab'); c.stdout.emit('data', 'cd'); c.stderr.emit('data', 'warn'); c.emit('close', 0); } });
      const r = await f(sp, () => assert.fail('no kill'), 'agy', ['x'], { cwd: 'W', env: { A: '1' }, timeoutMs: 1000 });
      assert.deepEqual(r, { code: 0, stdout: 'abcd', stderr: 'warn', timedOut: false });
      assert.deepEqual([sp.calls[0].cmd, sp.calls[0].args, sp.calls[0].opts.cwd, sp.calls[0].opts.env, sp.calls[0].opts.windowsHide], ['agy', ['x'], 'W', { A: '1' }, true]);
    }],
    ['a timeout kills the process tree and reports timedOut', async ({ runProcess: f }) => {
      const killed = [];
      const r = await f(fakeSpawn({ pid: 77 }), pid => killed.push(pid), 'agy', [], { cwd: '.', env: {}, timeoutMs: 20 });
      assert.deepEqual([r.code, r.timedOut, killed], [null, true, [77]]);
    }],
    ['a spawn error gives code -1 and keeps the message', async ({ runProcess: f }) => {
      const r = await f(fakeSpawn({ run: c => c.emit('error', new Error('ENOENT agy')) }), () => {}, 'agy', [], { cwd: '.', env: {}, timeoutMs: 1000 });
      assert.deepEqual([r.code, r.timedOut, r.stderr], [-1, false, 'ENOENT agy']);
    }],
    ['a kill that throws does not break the result', async ({ runProcess: f }) => {
      const r = await f(fakeSpawn({}), () => { throw new Error('gone'); }, 'agy', [], { cwd: '.', env: {}, timeoutMs: 10 });
      assert.equal(r.timedOut, true);
    }],
  ],

  researchToken: [
    ['a good answer is checked locally and posted once with the prompt version and checks', async ({ researchToken: f }) => {
      const { calls, deps } = tokenDeps([ok()]);
      const r = await f(token, { runId: 'run-1', model: 'M' }, deps);
      assert.deepEqual(r, { status: 'accepted', detail: '' });
      assert.equal(calls.agy, 1); assert.equal(calls.posts.length, 1);
      const p = calls.posts[0];
      assert.deepEqual([p.runId, p.model, p.promptVersion, p.chainId, p.address, p.raw.risk_tier], ['run-1', 'M', 'research-prompt-2', 1, WETH, 1]);
      assert.equal(p.checks.length, 7); assert.ok(p.checks.every(c => c.status === 200 && c.mentions));
      assert.equal(calls.saved.length, 1);
    }],
    ['an invalid first answer is retried once and the valid second one is posted', async ({ researchToken: f }) => {
      const bad = { ...WETH_RAW, address: '0x' + '2'.repeat(40) };
      const { calls, deps } = tokenDeps([ok(JSON.stringify({ response: JSON.stringify(bad) })), ok()]);
      const r = await f(token, { runId: 'r', model: 'M' }, deps);
      assert.equal(r.status, 'accepted'); assert.equal(calls.agy, 2); assert.equal(calls.posts.length, 1); assert.equal(calls.posts[0].raw.address, WETH);
      assert.ok(calls.logs.some(l => /attempt 1: invalid/.test(l)));
    }],
    ['two invalid answers: the last one is still posted so the server can record and hold the token', async ({ researchToken: f }) => {
      const bad = ok(JSON.stringify({ response: JSON.stringify({ ...WETH_RAW, address: '0x' + '2'.repeat(40) }) }));
      const { calls, deps } = tokenDeps([bad, bad], { post: async b => { calls.posts.push(b); return { outcome: 'rejected', errors: ['address does not match the requested token'] }; } });
      const r = await f(token, { runId: 'r', model: 'M' }, deps);
      assert.equal(r.status, 'rejected'); assert.match(r.detail, /address does not match/); assert.equal(calls.agy, 2); assert.equal(calls.posts.length, 1);
    }],
    ['timeouts and exit codes are retried once, then a runner_error is posted', async ({ researchToken: f }) => {
      const { calls, deps } = tokenDeps([{ code: null, stdout: '', stderr: '', timedOut: true }, { code: 1, stdout: '', stderr: 'boom', timedOut: false }],
        { post: async b => { calls.posts.push(b); return { outcome: 'rejected', errors: ['$.chain_id: missing'] }; } });
      const r = await f(token, { runId: 'r', model: 'M' }, deps);
      assert.equal(r.status, 'rejected'); assert.equal(calls.agy, 2); assert.deepEqual(calls.posts[0].raw, { runner_error: 'exit code 1' }); assert.deepEqual(calls.posts[0].checks, []);
    }],
    ['output without JSON is retried; a later good answer wins', async ({ researchToken: f }) => {
      const { calls, deps } = tokenDeps([ok('I could not do it'), ok()]);
      assert.equal((await f(token, { runId: 'r', model: 'M' }, deps)).status, 'accepted'); assert.equal(calls.agy, 2);
    }],
    ['a quota or login message on a failed call stops everything without posting', async ({ researchToken: f }) => {
      const { calls, deps } = tokenDeps([{ code: 1, stdout: '', stderr: 'Error: Authentication expired', timedOut: false }]);
      const r = await f(token, { runId: 'r', model: 'M' }, deps);
      assert.equal(r.status, 'fatal'); assert.equal(calls.agy, 1); assert.equal(calls.posts.length, 0);
    }],
    ['the words quota or credits inside a good answer are not fatal', async ({ researchToken: f }) => {
      const text = WETH_OUT.replace('Extremely deep liquidity', 'Out of credits quota talk, extremely deep liquidity');
      assert.notEqual(text, WETH_OUT);
      const { deps } = tokenDeps([ok(text)]);
      assert.equal((await f(token, { runId: 'r', model: 'M' }, deps)).status, 'accepted');
    }],
    ['when the server does not answer the token is reported as failed', async ({ researchToken: f }) => {
      const { deps } = tokenDeps([ok()], { post: async () => null });
      assert.equal((await f(token, { runId: 'r', model: 'M' }, deps)).status, 'failed');
    }],
    ['unreachable pages give status 0 checks and an invalid tier, never an exception', async ({ researchToken: f }) => {
      const { calls, deps } = tokenDeps([ok(), ok()], { fetchImpl: async () => { throw new Error('offline'); } });
      await f(token, { runId: 'r', model: 'M' }, deps);
      assert.equal(calls.agy, 2); assert.ok(calls.posts[0].checks.every(c => c.status === 0));
    }],
    ['a token from --tokens has no symbol: the symbol of the answer is used for the page check', async ({ researchToken: f }) => {
      const { calls, deps } = tokenDeps([ok()], { fetchImpl: async () => ({ status: 200, headers: new Headers(), body: new Response('only the word weth here').body }) });
      assert.equal((await f({ chainId: 1, address: WETH, symbol: null, tags: null }, { runId: 'r', model: 'M' }, deps)).status, 'accepted');
      assert.ok(calls.posts[0].checks.every(c => c.mentions));
    }],
  ],

  runResearch: [
    ['a busy lock ends the run with code 3 before anything else', async ({ runResearch: f }) => {
      const { calls, deps } = runDeps({ lock: () => ({ ok: false, release: () => assert.fail('must not release a lock it does not own') }) });
      const r = await f(baseOpts(), deps);
      assert.equal(r.exitCode, 3); assert.deepEqual(calls.researched, []); assert.equal(calls.queueLimit, null);
    }],
    ['low memory ends the run with code 2 and releases the lock', async ({ runResearch: f }) => {
      const { calls, deps } = runDeps({ freeBytes: () => 0.8 * 1024 ** 3 });
      const r = await f(baseOpts(), deps);
      assert.equal(r.exitCode, 2); assert.equal(calls.released, 1); assert.equal(calls.queueLimit, null); assert.ok(calls.logs.some(l => /0\.8 GB/.test(l)));
    }],
    ['enabled MCP servers are disabled and logged, then the queue is processed one by one with pauses', async ({ runResearch: f }) => {
      const { calls, deps } = runDeps();
      const r = await f(baseOpts({ limit: 7 }), deps);
      assert.equal(r.exitCode, 0); assert.deepEqual(r.summary, { accepted: 2, rejected: 0, kept: 0, pending: 0, failed: 0, skipped: 0 });
      assert.deepEqual(calls.disabled, ['playwright']); assert.equal(calls.queueLimit, 7);
      assert.deepEqual(calls.researched, ['0xa', '0xb']); assert.deepEqual(calls.slept, [5000]); assert.equal(calls.released, 1);
      assert.ok(calls.logs.some(l => /"playwright" was enabled/.test(l)));
    }],
    ['outcomes are counted; a thrown error counts as failed and does not stop the run', async ({ runResearch: f }) => {
      const out = ['accepted', 'rejected', 'kept_previous', 'pending_confirmation', 'failed'];
      let i = 0;
      const { deps } = runDeps({
        getQueue: async () => out.concat('boom').map((_, k) => ({ chainId: 1, address: `0x${k}`, symbol: null, tags: null })),
        researchToken: async () => { const s = out[i++]; if (!s) throw new Error('crash'); return { status: s, detail: '' }; }
      });
      assert.deepEqual((await f(baseOpts(), deps)).summary, { accepted: 1, rejected: 1, kept: 1, pending: 1, failed: 2, skipped: 0 });
    }],
    ['a fatal result stops the run with code 1 and counts the rest as skipped', async ({ runResearch: f }) => {
      const { calls, deps } = runDeps({ researchToken: async t => { calls.researched.push(t.address); return { status: 'fatal', detail: 'quota' }; } });
      const r = await f(baseOpts(), deps);
      assert.equal(r.exitCode, 1); assert.deepEqual(calls.researched, ['0xa']); assert.equal(r.summary.skipped, 2); assert.equal(calls.released, 1);
    }],
    ['the time budget stops new tokens and counts the rest as skipped', async ({ runResearch: f }) => {
      let t = NOW;
      const { calls, deps } = runDeps({ now: () => t, researchToken: async x => { calls.researched.push(x.address); t += 61 * 60e3; return { status: 'accepted', detail: '' }; } });
      const r = await f(baseOpts({ maxMinutes: 60 }), deps);
      assert.deepEqual(calls.researched, ['0xa']); assert.deepEqual([r.summary.accepted, r.summary.skipped, r.exitCode], [1, 1, 0]);
    }],
    ['--tokens replaces the queue; those tokens have no symbol or tags', async ({ runResearch: f }) => {
      const seen = [];
      const { calls, deps } = runDeps({ getQueue: async () => assert.fail('queue must not be read'), researchToken: async t => { seen.push(t); return { status: 'accepted', detail: '' }; } });
      await f(baseOpts({ tokens: [{ chainId: 8453, address: '0xc' }] }), deps);
      assert.deepEqual(seen, [{ chainId: 8453, address: '0xc', symbol: null, tags: null }]); assert.deepEqual(calls.slept, []);
    }],
    ['--dry-run lists the queue and runs nothing: no MCP changes, no agy, no pauses', async ({ runResearch: f }) => {
      const { calls, deps } = runDeps({ mcp: { list: async () => assert.fail('no agy in a dry run'), disable: async () => assert.fail('no agy in a dry run') } });
      const r = await f(baseOpts({ dryRun: true }), deps);
      assert.equal(r.exitCode, 0); assert.deepEqual(calls.researched, []); assert.equal(calls.released, 1);
      assert.ok(calls.logs.some(l => l.includes('1:0xa A')) && calls.logs.some(l => l.includes('Queue: 2')));
    }],
    ['the lock is released even when the queue request fails', async ({ runResearch: f }) => {
      const { calls, deps } = runDeps({ getQueue: async () => { throw new Error('HTTP 401'); } });
      await assert.rejects(() => f(baseOpts(), deps), /HTTP 401/); assert.equal(calls.released, 1);
    }],
  ],
};
