// About page: one topic at a time, the side list stays fixed, each switch scrolls back to the top
document.documentElement.classList.remove('no-js');

const topics = [...document.querySelectorAll('.about section')];
const links = [...document.querySelectorAll('.about-nav a')];
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

function show(id, { scroll = true } = {}) {
  const target = topics.find(t => t.id === id) || topics[0];
  for (const t of topics) t.hidden = t !== target;
  for (const a of links) {
    const on = a.dataset.topic === target.id;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  // Restart the entrance animation
  target.classList.remove('enter');
  void target.offsetWidth;
  target.classList.add('enter');
  if (scroll) document.body.scrollTo({ top: 0, behavior: reduced.matches ? 'auto' : 'smooth' });
  document.title = `${target.querySelector('h1, h2').textContent} | CheckYourMorpho`;
}

for (const a of links) {
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
