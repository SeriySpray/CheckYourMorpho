// Мінімальне браузерне середовище для запуску client/js у Node: елементи зберігають записані властивості,
// тож тести можуть перевіряти, що саме функція записала в DOM; решта API - порожні заглушки.
const NOOP_METHODS = ['addEventListener', 'removeEventListener', 'focus', 'blur', 'click', 'appendChild', 'removeChild',
  'remove', 'insertBefore', 'scrollIntoView', 'animate', 'append', 'prepend', 'replaceChildren', 'dispatchEvent',
  'scrollTo', 'toggleAttribute', 'setPointerCapture', 'releasePointerCapture', 'select', 'setProperty', 'showModal', 'close'];

export function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    toggle: (c, force) => { const on = force ?? !set.has(c); if (on) set.add(c); else set.delete(c); return on; },
    contains: c => set.has(c),
    get value() { return [...set].join(' '); }
  };
}

export function makeElement(tag = 'div') {
  const attrs = new Map();
  const store = {
    tagName: tag.toUpperCase(), textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, checked: false,
    className: '', id: '', title: '', children: [], childNodes: [], dataset: {}, style: { setProperty() {}, removeProperty() {} },
    classList: makeClassList(), clientWidth: 480, clientHeight: 400, offsetWidth: 480, offsetHeight: 400, scrollTop: 0,
    scrollHeight: 400, width: 300, height: 300, parentElement: null, parentNode: null
  };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'getAttribute') return name => (attrs.has(name) ? attrs.get(name) : null);
      if (k === 'setAttribute') return (name, v) => { attrs.set(name, String(v)); };
      if (k === 'removeAttribute') return name => { attrs.delete(name); };
      if (k === 'hasAttribute') return name => attrs.has(name);
      if (k === 'closest') return () => null;
      if (k === 'querySelector' || k === 'getContext' || k === 'cloneNode') return () => makeElement();
      if (k === 'querySelectorAll') return () => [];
      if (k === 'matches' || k === 'contains') return () => false;
      if (k === 'getBoundingClientRect') return () => ({ left: 0, top: 0, width: 480, height: 400, right: 480, bottom: 400, x: 0, y: 0 });
      if (NOOP_METHODS.includes(k)) return () => {};
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); }, clear: () => m.clear(), get length() { return m.size; }
  };
}

/** Installs the globals client/js expects. Idempotent; returns the document and its registered elements. */
export function installClientEnv() {
  if (globalThis.__cymClientEnv) return globalThis.__cymClientEnv;
  const elements = new Map();
  const def = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const document = {
    getElementById: id => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
    querySelector: () => makeElement(), querySelectorAll: () => [], createElement: tag => makeElement(tag),
    createDocumentFragment: () => makeElement(), addEventListener() {}, removeEventListener() {},
    contains: () => true, // restoreFocusAfterAudit: елемент вважається приєднаним до документа
    body: makeElement('body'), documentElement: makeElement('html'), activeElement: null, hidden: false, visibilityState: 'visible'
  };
  def('window', globalThis);
  def('document', document);
  def('localStorage', makeStorage());
  def('sessionStorage', makeStorage());
  def('navigator', { userAgent: 'node-tests', maxTouchPoints: 0, clipboard: { writeText: async () => {} } });
  def('innerWidth', 1280); def('innerHeight', 800); def('devicePixelRatio', 1);
  def('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }));
  def('requestAnimationFrame', () => 0); def('cancelAnimationFrame', () => {});
  def('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  def('location', { href: 'http://localhost/', origin: 'http://localhost', search: '', hash: '' });
  def('history', { pushState() {}, replaceState() {} });
  def('ResizeObserver', class { observe() {} disconnect() {} });
  def('IntersectionObserver', class { observe() {} disconnect() {} });
  def('fetch', async () => { throw new Error('network is disabled in tests'); });
  globalThis.addEventListener = globalThis.addEventListener || (() => {});
  globalThis.removeEventListener = globalThis.removeEventListener || (() => {});
  globalThis.__cymClientEnv = { document, elements };
  return globalThis.__cymClientEnv;
}
