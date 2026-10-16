// Інтерактивний тестовий модуль: node tests/runner.js  (або --all для прогону без меню).
// Дерево файлів і функцій будується скануванням server/ при кожному запуску;
// тести підхоплюються з tests/cases/<шлях__з__подвійним_підкресленням>.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG } from '../server/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['server'];
const FN_RE = /^(export\s+)?(async\s+)?function\s+(\w+)|^export\s+(?:const|let)\s+(\w+)/gm;

// Реальна БД лише для читання: працюємо з копією, щоб міграції getDatabase() не торкалися оригіналу.
export function useDbCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cym-tests-'));
  for (const suffix of ['', '-wal', '-shm']) {
    const src = CONFIG.db.path + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'morpho.db' + suffix));
  }
  CONFIG.db.path = path.join(dir, 'morpho.db');
  return dir;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.js') && !e.name.endsWith('.test.js') ? [p] : [];
  });
}

export async function scan() {
  const files = [];
  for (const d of SCAN_DIRS) {
    for (const abs of walk(path.join(ROOT, d))) {
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      const src = fs.readFileSync(abs, 'utf8');
      const fns = [...src.matchAll(FN_RE)].map(m => ({
        name: m[3] || m[4], exported: Boolean(m[1]) || !m[3], results: null
      }));
      if (!fns.length) continue;
      const casesPath = path.join(ROOT, 'tests', 'cases', rel.replace(/\//g, '__'));
      let cases = {};
      if (fs.existsSync(casesPath)) cases = (await import(pathToFileURL(casesPath).href + '?v=' + Date.now())).default;
      for (const fn of fns) fn.cases = cases[fn.name] || [];
      // Кейси для функцій, яких у коді вже немає: показуємо, щоб їх не забули прибрати
      const stale = Object.keys(cases).filter(n => !fns.some(f => f.name === n));
      files.push({ rel, abs, fns, stale, open: false });
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

export async function runFn(file, fn, mod) {
  fn.results = [];
  for (const [title, run] of fn.cases) {
    const t0 = performance.now();
    try { await run(mod); fn.results.push({ title, ok: true, ms: performance.now() - t0 }); }
    catch (err) { fn.results.push({ title, ok: false, err, ms: performance.now() - t0 }); }
  }
}

export async function runFile(file) {
  // Модулі з побічними ефектами (index.js, sync.js) імпортуємо лише якщо для них є кейси
  if (!file.fns.some(fn => fn.exported && fn.cases.length)) return;
  const mod = await import(pathToFileURL(file.abs).href);
  for (const fn of file.fns) if (fn.exported && fn.cases.length) await runFn(file, fn, mod);
}

function printFnDetail(fn) {
  if (!fn.exported) return console.log('  Не експортована: тест недоступний (експортуйте функцію, щоб її покрити).');
  if (!fn.cases.length) return console.log('  Тестів немає. Додайте кейси в tests/cases/ для цієї функції.');
  fn.cases.forEach(([title], i) => {
    const r = fn.results?.[i];
    console.log(`  ${r ? (r.ok ? '[ OK ]' : '[FAIL]') : '[ .. ]'} ${title}`);
    if (r && !r.ok) console.log(`         ${String(r.err.message).split('\n').join('\n         ')}`);
  });
}

function summary(files) {
  let pass = 0, fail = 0, none = 0;
  for (const f of files) for (const fn of f.fns) {
    if (!fn.exported) continue;
    if (!fn.cases.length) { none++; continue; }
    for (const r of fn.results || []) r.ok ? pass++ : fail++;
  }
  console.log(`Підсумок: пройдено ${pass}, провалено ${fail}, функцій без тестів ${none}`);
  return fail;
}

const C = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', inv: '\x1b[7m', off: '\x1b[0m' };

// Плоский список видимих рядків: файл, його функції, а під розгорнутою функцією - її кейси.
function rowsOf(files) {
  const rows = [];
  for (const f of files) {
    rows.push({ kind: 'file', f });
    if (!f.open) continue;
    for (const fn of f.fns) {
      rows.push({ kind: 'fn', f, fn });
      if (fn.show) {
        if (!fn.exported) rows.push({ kind: 'note', text: 'не експортована: тест недоступний' });
        else if (!fn.cases.length) rows.push({ kind: 'note', text: 'тестів немає: додайте кейси в tests/cases/' });
        else fn.cases.forEach(([title], i) => rows.push({ kind: 'case', title, r: fn.results?.[i] }));
      }
    }
  }
  return rows;
}

function badge(fn) {
  if (!fn.exported) return `${C.dim}[n/a ]${C.off}`;
  if (!fn.cases.length) return `${C.yellow}[ -- ]${C.off}`;
  if (!fn.results) return `${C.dim}[ .. ]${C.off}`;
  return fn.results.every(r => r.ok) ? `${C.green}[ OK ]${C.off}` : `${C.red}[FAIL]${C.off}`;
}

function line(row) {
  if (row.kind === 'file') {
    const exp = row.f.fns.filter(x => x.exported), tested = exp.filter(x => x.cases.length).length;
    const run = exp.filter(x => x.results), bad = run.some(x => x.results.some(r => !r.ok));
    const st = !run.length ? '' : bad ? ` ${C.red}FAIL${C.off}` : run.length === tested ? ` ${C.green}OK${C.off}` : '';
    const stale = row.f.stale.length ? ` ${C.yellow}застарілі: ${row.f.stale.join(', ')}${C.off}` : '';
    return `${row.f.open ? '[-]' : '[+]'} ${C.bold}${row.f.rel}${C.off} ${C.dim}(${tested}/${exp.length})${C.off}${st}${stale}`;
  }
  if (row.kind === 'fn') return `     ${badge(row.fn)} ${row.fn.name}${row.fn.exported ? '' : `${C.dim} (внутрішня)${C.off}`}`;
  if (row.kind === 'note') return `            ${C.dim}${row.text}${C.off}`;
  const mk = !row.r ? `${C.dim}..${C.off}` : row.r.ok ? `${C.green}ok${C.off}` : `${C.red}FAIL${C.off}`;
  const err = row.r && !row.r.ok ? `\n              ${C.red}${String(row.r.err.message).split('\n')[0]}${C.off}` : '';
  return `            ${mk} ${row.title}${err}`;
}

function stats(files) {
  let pass = 0, fail = 0, none = 0;
  for (const f of files) for (const fn of f.fns) {
    if (!fn.exported) continue;
    if (!fn.cases.length) { none++; continue; }
    for (const r of fn.results || []) r.ok ? pass++ : fail++;
  }
  return { pass, fail, none };
}

async function tui(files) {
  let cur = 0, top = 0, status = 'Готово. Натисніть ? для підказки.', help = false;
  const out = process.stdout;
  const draw = () => {
    const rows = rowsOf(files);
    cur = Math.max(0, Math.min(cur, rows.length - 1));
    const h = Math.max(5, (out.rows || 24) - 4);
    if (cur < top) top = cur;
    if (cur >= top + h) top = cur - h + 1;
    const s = stats(files);
    let buf = '\x1b[2J\x1b[H' + `${C.bold}CheckYourMorpho: тестовий модуль${C.off}  ${C.green}ok ${s.pass}${C.off}  ${C.red}fail ${s.fail}${C.off}  ${C.yellow}без тестів ${s.none}${C.off}\n\n`;
    rows.slice(top, top + h).forEach((row, i) => {
      const txt = line(row);
      buf += (top + i === cur ? `${C.inv}>${C.off} ` : '  ') + (top + i === cur && row.kind !== 'case' ? `${C.cyan}${txt}${C.off}` : txt) + '\n';
    });
    buf += `\n${help
      ? 'Стрілки/jk: рух | Enter/Space/Вправо: розгорнути | Вліво: згорнути | r: запустити виділене | a: усе | e/c: розгорнути/згорнути все | q: вихід'
      : `${C.dim}${status}${C.off}`}`;
    out.write(buf);
    return rows;
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let busy = false;
  await new Promise(resolve => {
    const done = () => { process.stdin.setRawMode(false); out.write('\x1b[2J\x1b[H'); resolve(); };
    process.stdin.on('keypress', async (str, key) => {
      if (busy) return;
      const rows = rowsOf(files), row = rows[cur];
      help = false;
      const k = key?.name;
      if (k === 'q' || (key?.ctrl && k === 'c')) return done();
      if (k === 'up' || k === 'k') cur--;
      else if (k === 'down' || k === 'j') cur++;
      else if (k === 'pageup') cur -= 10;
      else if (k === 'pagedown') cur += 10;
      else if (k === 'home') cur = 0;
      else if (k === 'end') cur = rows.length - 1;
      else if (str === '?') help = true;
      else if (['return', 'space', 'right', 'l'].includes(k)) {
        if (row?.kind === 'file') row.f.open = !row.f.open;
        else if (row?.kind === 'fn') row.fn.show = !row.fn.show;
      } else if (k === 'left' || k === 'h') {
        if (row?.kind === 'file') row.f.open = false;
        else if (row?.kind === 'fn' && row.fn.show) row.fn.show = false;
        else if (row?.f) { row.f.open = false; cur = rows.findIndex(x => x.f === row.f); }
      } else if (k === 'e') files.forEach(f => { f.open = true; });
      else if (k === 'c') files.forEach(f => { f.open = false; });
      else if (k === 'r' || k === 'a') {
        busy = true; status = 'Виконується...'; draw();
        try {
          if (k === 'a') for (const f of files) await runFile(f);
          else if (row?.kind === 'file') await runFile(row.f);
          else if (row?.kind === 'fn' && row.fn.exported && row.fn.cases.length) {
            await runFn(row.f, row.fn, await import(pathToFileURL(row.f.abs).href));
            row.fn.show = true;
          }
          const s = stats(files); status = `Завершено: ok ${s.pass}, fail ${s.fail}.`;
        } catch (err) { status = `Помилка запуску: ${err.message}`; }
        busy = false;
      }
      draw();
    });
    draw();
  });
}

async function main() {
  // exit 1 by default so a hung async case (empty event loop) cannot end as success
  process.exitCode = 1;
  useDbCopy();
  const files = await scan();
  if (process.argv.includes('--all')) {
    for (const f of files) await runFile(f);
    for (const f of files) for (const fn of f.fns) if (fn.results?.some(r => !r.ok)) {
      console.log(`${f.rel} :: ${fn.name}`); printFnDetail(fn);
    }
    process.exit(summary(files) ? 1 : 0);
  }
  if (!process.stdin.isTTY) { console.error('Потрібен інтерактивний термінал (або --all).'); process.exit(2); }
  await tui(files);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
