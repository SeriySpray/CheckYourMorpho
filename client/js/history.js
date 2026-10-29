/**
 * CheckYourMorpho: History tab of the vault audit.
 * One large chart that switches metric from a list of sparkline rows, and the past warnings of the vault.
 */

import { explainEvent, formatEventDate } from './eventExplain.js?v=20261028_cents';
import { getEventKinds, groupEvents } from './activity.js?v=20261029_dflti2';

const DAY_SEC = 86400;
const RANGES = { '7d': 7, '30d': 30, '90d': 90, Max: Infinity };
const FETCH_TIMEOUT_MS = 15000;
const PAGE = 5;

const compactUsd = v => {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};

const METRICS = [
  { key: 'netApy', name: 'Net APY', fmt: v => `${(v * 100).toFixed(2)}%` },
  { key: 'tvlUsd', name: 'TVL', fmt: compactUsd },
  { key: 'exitPercent', name: 'Instant exit', fmt: v => `${v.toFixed(1)}%`, min: 0, max: 100 },
  { key: 'activeMarkets', name: 'Active markets', fmt: v => String(Math.round(v)), min: 0 },
  { key: 'flaggedPercent', name: 'In flagged markets', fmt: v => `${v.toFixed(1)}%`, min: 0 }
];

const SEVERITIES = [['all', 'All'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']];
const MAX_EVENT_PAGES = 10; // 200 events a page

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(day) {
  const d = new Date(day * DAY_SEC * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function buildChart(metric, pts) {
  const w = 560, h = 190, p = { l: 44, r: 8, t: 8, b: 20 };
  const d0 = pts[0].day, d1 = pts[pts.length - 1].day, dspan = Math.max(1, d1 - d0);
  const vals = pts.map(q => q.v);
  const lo0 = metric.min ?? Math.min(...vals);
  const hi0 = metric.max ?? Math.max(...vals);
  const pad = ((hi0 - lo0) || Math.abs(hi0) || 1) * 0.08;
  const lo = metric.min !== undefined ? lo0 : lo0 - pad;
  const hi = metric.max !== undefined ? hi0 : hi0 + pad;
  const labels = [0, 1, 2, 3].map(k => metric.fmt(lo + (hi - lo) * k / 3));
  p.l = Math.max(44, 14 + 6.2 * Math.max(...labels.map(t => t.length)));
  const x = day => p.l + (w - p.l - p.r) * (day - d0) / dspan;
  const y = v => p.t + (h - p.t - p.b) * (1 - (v - lo) / ((hi - lo) || 1));
  const path = pts.map(q => `${x(q.day).toFixed(1)},${y(q.v).toFixed(1)}`).join(' L');
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;

  let grid = '';
  for (let k = 0; k <= 3; k++) {
    const v = lo + (hi - lo) * k / 3;
    const yy = y(v).toFixed(1);
    grid += `<line class="hx-gl" x1="${p.l}" x2="${w - p.r}" y1="${yy}" y2="${yy}"/><text class="hx-axis" x="${p.l - 6}" y="${+yy + 3}" text-anchor="end">${esc(metric.fmt(v))}</text>`;
  }
  let xl = '';
  [0, 1 / 3, 2 / 3, 1].forEach((f, k) => {
    xl += `<text class="hx-axis" x="${x(d0 + dspan * f)}" y="${h - 4}" text-anchor="${k === 0 ? 'start' : k === 3 ? 'end' : 'middle'}">${dayLabel(Math.round(d0 + dspan * f))}</text>`;
  });
  const last = pts[pts.length - 1];
  const svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(metric.name)} over the selected period">${grid}${xl}
    <line class="hx-avg" x1="${p.l}" x2="${w - p.r}" y1="${y(avg)}" y2="${y(avg)}"/>
    <path class="hx-ar" d="M${path} L${x(last.day)},${h - p.b} L${x(pts[0].day)},${h - p.b} Z"/><path class="hx-ln" d="M${path}"/>
    <line class="hx-cross" y1="${p.t}" y2="${h - p.b}" hidden/><circle class="hx-end" cx="${x(last.day)}" cy="${y(last.v)}" r="3.4"/><circle class="hx-end hx-hv" r="3.4" hidden/>
    <rect class="hx-hit" x="${p.l}" y="0" width="${w - p.l - p.r}" height="${h}" fill="transparent"/></svg>`;
  return { svg, w, h, x, y, avg, last };
}

function spark(pts) {
  const w = 84, h = 24, d0 = pts[0].day, dspan = Math.max(1, pts[pts.length - 1].day - d0);
  const vs = pts.map(q => q.v), lo = Math.min(...vs), hi = Math.max(...vs);
  const path = pts.map(q => `${(w * (q.day - d0) / dspan).toFixed(1)},${(2 + (h - 4) * (1 - (q.v - lo) / ((hi - lo) || 1))).toFixed(1)}`).join(' L');
  return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="M${path}"/></svg>`;
}

function eventHtml(ev, vault, open) {
  const x = explainEvent(ev, vault);
  const pending = !['applied', 'revoked', 'final'].includes(String(ev.status || '').toLowerCase());
  const status = pending ? 'Pending' : ev.status === 'revoked' ? 'Cancelled' : '';
  const facts = x.facts.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('');
  return `<li class="hx-ev ${esc(ev.severity)}${pending ? ' is-pending' : ''}" data-open="${open}">
    <button type="button" class="hx-ev-btn" data-ev="${ev.id}" aria-expanded="${open}">
      <span><span class="hx-ttl">${esc(ev.title)}</span>${x.summary ? `<span class="hx-sub">${esc(x.summary)}</span>` : ''}${status ? `<span class="hx-st">${status}</span>` : ''}${pending && x.timing ? `<span class="hx-sub">${esc(x.timing)}</span>` : ''}</span>
      <span class="hx-when">${esc(formatEventDate(ev.occurredAt))}</span>
    </button>
    <div class="hx-more">${x.impact ? `<p>${esc(x.impact)}</p>` : ''}${facts ? `<dl>${facts}</dl>` : ''}</div>
  </li>`;
}

/**
 * Renders the tab into `root`. `vault` is the audit vault object (address, name, asset, totalAssetsUsd) used to word the events.
 */
export async function renderHistory(root, vault) {
  if (root.dataset.vault === vault.address) return;
  root.dataset.vault = vault.address;
  root.innerHTML = '<div class="hx-empty">Loading history</div>';

  let points, events;
  try {
    // The same lists the Activity panel shows for this vault: upcoming changes first, then what already happened
    const kinds = getEventKinds(false).join(',');
    const pastEvents = async () => {
      const all = [];
      let before = null;
      for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        const e = await getJson(`/api/events?address=${vault.address}&kinds=${kinds}&history=1&limit=200${before ? `&before=${before}` : ''}`);
        all.push(...(e.events || []));
        before = e.nextBefore;
        if (!before) break;
      }
      return all;
    };
    const [h, upcoming, past] = await Promise.all([
      getJson(`/api/vaults/${vault.address}/history`),
      getJson(`/api/events/pending?address=${vault.address}&kinds=${kinds}&limit=200`),
      pastEvents()
    ]);
    points = h.points || [];
    events = [...groupEvents(upcoming.events || [], true), ...groupEvents(past)];
  } catch {
    delete root.dataset.vault; // the next visit to the tab retries
    root.innerHTML = '<div class="hx-empty">History could not be loaded. Open the tab again to retry.</div>';
    return;
  }

  const st = { range: '30d', metric: 'netApy', sev: 'all', shown: PAGE, open: null };
  const today = Math.floor(Date.now() / 1000 / DAY_SEC);

  function series(m, range) {
    const from = RANGES[range] === Infinity ? -Infinity : today - RANGES[range] + 1;
    return points.filter(q => q.day >= from && q[m.key] !== null && q[m.key] !== undefined).map(q => ({ day: q.day, v: q[m.key] }));
  }

  function draw() {
    const first = points.length ? points[0].day : today;
    const covered = Math.max(1, Math.min(RANGES[st.range], today - first + 1));
    const since = dayLabel(today - covered + 1) + (covered > 300 ? ` ${new Date((today - covered + 1) * DAY_SEC * 1000).getUTCFullYear()}` : '');
    const short = RANGES[st.range] !== Infinity && covered < RANGES[st.range] ? ' (all there is)' : '';
    const note = points.length ? `<span class="hx-note"><b>${covered} day${covered === 1 ? '' : 's'}</b>, since ${since}${short}</span>` : '';
    const focusKey = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const metrics = METRICS.map(m => ({ m, pts: series(m, st.range) })).filter(x => x.pts.length >= 2);
    if (!metrics.some(x => x.m.key === st.metric)) st.metric = metrics[0]?.m.key;
    const cur = metrics.find(x => x.m.key === st.metric);
    const list = events.filter(e => st.sev === 'all' || e.severity === st.sev);
    const shown = list.slice(0, st.shown);
    const count = k => events.filter(e => k === 'all' || e.severity === k).length;

    let top;
    if (cur) {
      const c = buildChart(cur.m, cur.pts);
      st.chart = { c, m: cur.m, pts: cur.pts };
      const avgText = cur.m.key === 'activeMarkets' ? String(Math.round(c.avg)) : cur.m.fmt(c.avg);
      top = `<div class="hx-hero"><div class="hx-name">${esc(cur.m.name)}</div><div class="hx-big">${esc(cur.m.fmt(c.last.v))}</div>
        <div class="hx-avgline"><span>Average, ${st.range}</span><b>${esc(avgText)}</b></div></div>
        <div class="hx-plot">${c.svg}<div class="hx-tip" hidden></div></div>
        <ul class="hx-mlist" aria-label="Metrics">${metrics.map(({ m, pts }) => `<li><button type="button" class="hx-mrow" data-key="m${m.key}" data-m="${m.key}" aria-pressed="${m.key === st.metric}"><span>${esc(m.name)}</span>${spark(pts)}<span class="hx-v">${esc(m.fmt(pts[pts.length - 1].v))}</span></button></li>`).join('')}</ul>`;
    } else {
      st.chart = null;
      const days = points.length;
      top = `<div class="hx-empty">${days ? `Only ${days} day${days === 1 ? '' : 's'} of history is collected so far. Charts appear after the second day.` : 'No history is collected for this vault yet.'}</div>`;
    }

    root.innerHTML = `<div class="hx-bar"><div class="hx-rng" role="group" aria-label="Period">${Object.keys(RANGES).map(k => `<button type="button" data-key="r${k}" data-r="${k}" aria-pressed="${k === st.range}">${k}</button>`).join('')}</div>${note}</div>
      ${top}
      <div class="hx-warn"><div class="hx-warn-h"><h3>Alerts</h3><div class="hx-seg" role="group" aria-label="Severity">${SEVERITIES.map(([k, label]) => `<button type="button" data-key="s${k}" data-s="${k}" aria-pressed="${k === st.sev}">${label}<b>${count(k)}</b></button>`).join('')}</div></div>
      <ul class="hx-tl">${shown.map(e => eventHtml(e, vault, st.open === String(e.id))).join('') || '<li class="hx-empty">No alerts for this vault.</li>'}</ul>
      ${list.length > st.shown ? `<button type="button" class="hx-more-btn" data-key="more" data-more>Show ${Math.min(10, list.length - st.shown)} more</button>` : ''}</div>`;

    if (focusKey) root.querySelector(`[data-key="${focusKey}"]`)?.focus({ preventScroll: true });
    wireChart();
  }

  function wireChart() {
    if (!st.chart) return;
    const { c, m, pts } = st.chart;
    const svg = root.querySelector('.hx-plot svg'), tip = root.querySelector('.hx-tip');
    const cross = svg.querySelector('.hx-cross'), hv = svg.querySelector('.hx-hv');
    const hide = () => { cross.hidden = hv.hidden = tip.hidden = true; };
    svg.querySelector('.hx-hit').addEventListener('pointermove', ev => {
      const r = svg.getBoundingClientRect();
      const sx = (ev.clientX - r.left) / r.width * c.w;
      let best = pts[0];
      for (const q of pts) if (Math.abs(c.x(q.day) - sx) < Math.abs(c.x(best.day) - sx)) best = q;
      const cx = c.x(best.day), cy = c.y(best.v);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); hv.setAttribute('cx', cx); hv.setAttribute('cy', cy);
      cross.hidden = hv.hidden = tip.hidden = false;
      tip.innerHTML = `${esc(m.fmt(best.v))}<span>${dayLabel(best.day)}</span>`;
      tip.style.left = `${Math.max(48, Math.min(r.width - 48, cx / c.w * r.width))}px`;
      tip.style.top = `${cy / c.h * r.height}px`;
    });
    svg.querySelector('.hx-hit').addEventListener('pointerleave', hide);
  }

  root.onclick = e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.r) st.range = t.dataset.r;
    else if (t.dataset.m) st.metric = t.dataset.m;
    else if (t.dataset.s) { st.sev = t.dataset.s; st.shown = PAGE; }
    else if (t.dataset.ev) st.open = st.open === t.dataset.ev ? null : t.dataset.ev;
    else if (t.hasAttribute('data-more')) st.shown += 10;
    else return;
    draw();
  };
  draw();
}
