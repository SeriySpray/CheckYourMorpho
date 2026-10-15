// Веб-інтерфейс тестового модуля: node tests/web.js  (відкриває http://127.0.0.1:4173).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { exec } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { useDbCopy, scan, runFn, runFile } from './runner.js';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui', 'index.html');
const PORT = Number(process.env.PORT) || 4173;

useDbCopy();
let files = await scan();
let busy = false;

const show = v => util.inspect(v, { depth: 4, breakLength: 80 });
const resultOf = r => r && (r.ok
  ? { ok: true, ms: r.ms }
  : { ok: false, ms: r.ms, message: String(r.err?.message ?? r.err).split('\n')[0],
      expected: r.err && 'expected' in r.err ? show(r.err.expected) : null,
      actual: r.err && 'actual' in r.err ? show(r.err.actual) : null });

// Дерево перебудовується зі сканування при кожному запиті: нові функції з'являються без перезапуску.
async function tree() {
  const prev = new Map(files.flatMap(f => f.fns.map(fn => [`${f.rel}::${fn.name}`, fn.results])));
  files = await scan();
  return files.map(f => ({
    rel: f.rel, stale: f.stale,
    fns: f.fns.map(fn => {
      const results = prev.get(`${f.rel}::${fn.name}`);
      if (results) fn.results = results;
      return {
        name: fn.name, exported: fn.exported,
        cases: fn.cases.map(([title, run], i) => ({ title, code: run.toString(), result: resultOf(fn.results?.[i]) }))
      };
    })
  }));
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const readBody = req => new Promise(resolve => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 1e4) req.destroy(); }); req.on('end', () => resolve(s));
});

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') return send(res, 200, fs.readFileSync(UI, 'utf8'), 'text/html; charset=utf-8');
    if (req.url === '/favicon.ico') return send(res, 204, '');
    if (req.method === 'GET' && req.url === '/api/tree') return send(res, 200, await tree());
    if (req.method === 'POST' && req.url === '/api/run') {
      if (busy) return send(res, 409, { error: 'Тести вже виконуються' });
      const { file, fn } = JSON.parse((await readBody(req)) || '{}');
      busy = true;
      try {
        const targets = file ? files.filter(f => f.rel === file) : files;
        if (file && !targets.length) return send(res, 404, { error: 'Файл не знайдено' });
        for (const f of targets) {
          const one = fn && f.fns.find(x => x.name === fn);
          if (fn && !one) return send(res, 404, { error: 'Функцію не знайдено' });
          if (one) {
            if (one.exported && one.cases.length) await runFn(f, one, await import(pathToFileURL(f.abs).href));
          } else await runFile(f);
        }
      } finally { busy = false; }
      return send(res, 200, await tree());
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) { send(res, 500, { error: err.message }); }
}).listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Тестовий модуль: ${url}  (Ctrl+C для виходу)`);
  if (!process.env.NO_OPEN) exec(process.platform === 'win32' ? `start "" ${url}` : `xdg-open ${url}`);
});
