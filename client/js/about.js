// About page: one topic at a time, the side list stays fixed, each switch scrolls back to the top
document.documentElement.classList.remove('no-js');

const topics = [...document.querySelectorAll('.about section')];
const links = [...document.querySelectorAll('.about-nav a')];
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

// Phone: the topic list is a menu under a burger button in the header
const side = document.querySelector('.about-side');
const burger = document.getElementById('about-menu-btn');
function setMenu(open) {
  side.classList.toggle('menu-open', open);
  burger.setAttribute('aria-expanded', String(open));
}
burger.addEventListener('click', () => setMenu(!side.classList.contains('menu-open')));
document.addEventListener('click', e => { if (!side.contains(e.target)) setMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

// The sheet closes by dragging it down from the top of the list
const sheet = document.querySelector('.about-nav');
let startY = null;
let dy = 0;
sheet.addEventListener('touchstart', e => { startY = sheet.scrollTop <= 0 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
sheet.addEventListener('touchmove', e => {
  if (startY === null) return;
  dy = e.touches[0].clientY - startY;
  if (dy <= 0 || sheet.scrollTop > 0) { dy = 0; sheet.style.transform = ''; return; }
  sheet.style.transition = 'none';
  sheet.style.transform = `translateY(${dy}px)`;
}, { passive: true });
sheet.addEventListener('touchend', () => {
  if (startY === null) return;
  sheet.style.transition = '';
  sheet.style.transform = '';
  if (dy > 80) setMenu(false);
  startY = null;
});

function show(id, { scroll = true } = {}) {
  const target = topics.find(t => t.id === id) || topics[0];
  for (const t of topics) t.hidden = t !== target;
  for (const a of nav.querySelectorAll('a')) {
    const on = a.dataset.topic === target.id;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  // Restart the entrance animation
  target.classList.remove('enter');
  void target.offsetWidth;
  target.classList.add('enter');
  setMenu(false);
  const label = document.getElementById('about-menu-label');
  if (label) label.textContent = links.find(l => l.dataset.topic === target.id)?.textContent || '';
  if (scroll) document.body.scrollTo({ top: 0, behavior: reduced.matches ? 'auto' : 'smooth' });
  document.title = `${target.querySelector('h1, h2').textContent} | CheckYourMorpho`;
}

// A button at the end of each topic leads to the next one (the last one wraps to the first)
const nextLinks = topics.map((t, i) => {
  const next = topics[(i + 1) % topics.length];
  const a = document.createElement('a');
  a.className = 'about-next';
  a.href = `#${next.id}`;
  a.dataset.topic = next.id;
  const name = links.find(l => l.dataset.topic === next.id)?.textContent || next.id;
  a.innerHTML = `<span><span class="about-next-label">Next topic</span>${name}</span>`;
  t.appendChild(a);
  return a;
});

const nav = document.querySelector('.about-nav');

for (const a of [...links, ...nextLinks]) {
  a.addEventListener('click', e => {
    e.preventDefault();
    const id = a.dataset.topic;
    if (location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
    show(id);
  });
}

window.addEventListener('popstate', () => show(location.hash.slice(1)));
// A deep link opens at the top of its topic, not wherever the browser restored the scroll
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
show(location.hash.slice(1), { scroll: false });
// The browser scrolls to the fragment after load, so reset once more then
const toTop = () => { document.body.scrollTop = 0; };
toTop();
window.addEventListener('load', () => requestAnimationFrame(toTop));

