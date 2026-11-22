// Tiny DOM helpers. Text always goes in via textContent; no innerHTML anywhere in the app.

const SVG_NS = 'http://www.w3.org/2000/svg';
const URL_ATTRS = new Set(['href', 'src', 'xlink:href']);

/** Links / sources may only point inside the app: '#…', '/…' (not '//host'), blob: or a relative
 * path. Browsers drop tabs / newlines inside URLs, so they are removed before the scheme check. */
export function safeUrl(v) {
  const s = String(v).replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '');
  if (s.startsWith('#') || s.startsWith('blob:')) return true;
  if (s.startsWith('/')) return !/^\/[/\\]/.test(s);
  return !/^[^/?#]*:/.test(s) && !s.startsWith('\\');
}

function apply(el, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    // Never an inline handler from a string, never a link out of the app (javascript:, data:, http…).
    if (k.startsWith('on') && typeof v !== 'function') continue;
    if (URL_ATTRS.has(k) && !safeUrl(v)) continue;
    if (k === 'class') {
      const list = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      if (list) el.setAttribute('class', list);
    } else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) if (dv != null) el.dataset[dk] = String(dv);
    } else if (k === 'style') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'value' && 'value' in el && el.namespaceURI !== SVG_NS) {
      el.value = v;
    } else if (k === 'checked' || k === 'selected' || (k === 'disabled' && el.namespaceURI !== SVG_NS)) {
      el[k] = Boolean(v);
      if (k === 'disabled' && v) el.setAttribute('disabled', '');
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs && (attrs instanceof Node || typeof attrs !== 'object' || Array.isArray(attrs))) {
    children.unshift(attrs);
  } else apply(el, attrs);
  append(el, children);
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
/** What identifies a control across a re-render: tag, id, label / text, data keys. */
const focusSig = (e) => [e.tagName, e.id, e.getAttribute('role'), e.getAttribute('aria-label'), e.dataset?.item, e.dataset?.k,
  e.dataset?.focusKey, e.tagName === 'SELECT' || e.tagName === 'INPUT' ? e.name || '' : (e.textContent || '').trim().slice(0, 80)].join('|');

/**
 * Replace el's children. A re-render (data refresh, sync finished) must never drop keyboard focus
 * to <body>: the same control in the new content gets it back, else <main>.
 */
export function mount(el, ...children) {
  const ae = document.activeElement;
  const main = document.getElementById('main');
  let had = ae && ae !== el && el.contains(ae) ? { sig: focusSig(ae), tag: ae.tagName } : null;
  // A skeleton in between (load -> skeleton -> content): focus parked on <main>, try again now.
  if (!had && el.lostFocus && (ae === main || ae === document.body)) had = el.lostFocus;
  el.lostFocus = null;
  clear(el); append(el, children);
  if (had && !el.contains(document.activeElement)) {
    const twin = [...el.querySelectorAll(had.tag)].find((x) => focusSig(x) === had.sig);
    if (twin) twin.focus({ preventScroll: true });
    else { el.lostFocus = had; main?.focus({ preventScroll: true }); }
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let uid = 0;
export const nextId = (p = 'id') => `${p}-${++uid}`;

/* ---------- icons: 16px, 1.5 stroke, drawn for this app ---------- */
const PATHS = {
  overview: ['M3 13.5h10', 'M4.5 11V7.5', 'M8 11V4', 'M11.5 11V9'],
  list: ['M5.5 4h8', 'M5.5 8h8', 'M5.5 12h8', 'M2.5 4h.01', 'M2.5 8h.01', 'M2.5 12h.01'],
  repeat: ['M3 7V6a2 2 0 0 1 2-2h7', 'M10 2l2 2-2 2', 'M13 9v1a2 2 0 0 1-2 2H4', 'M6 14l-2-2 2-2'],
  chat: ['M2.5 3.5h11v7.5H7l-3 2.5v-2.5H2.5z', 'M5 6.5h6', 'M5 8.5h3.5'],
  bank: ['M2.5 6h11', 'M8 2.5 13.5 6h-11z', 'M4 6.5v5', 'M8 6.5v5', 'M12 6.5v5', 'M2.5 13.5h11'],
  search: ['M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M14 14l-3.5-3.5'],
  sync: ['M13 4.5A5.5 5.5 0 0 0 3 6', 'M2.7 2.8 3 6l3.2-.4', 'M3 11.5A5.5 5.5 0 0 0 13 10', 'M13.3 13.2 13 10l-3.2.4'],
  chevron: ['M6 3.5 10.5 8 6 12.5'],
  chevronDown: ['M3.5 6 8 10.5 12.5 6'],
  close: ['M4 4l8 8', 'M12 4l-8 8'],
  plus: ['M8 3v10', 'M3 8h10'],
  download: ['M8 2.5v8', 'M4.5 7 8 10.5 11.5 7', 'M3 13.5h10'],
  filter: ['M2.5 3.5h11L9.5 8.5V13l-3-1.5v-3z'],
  sidebar: ['M2.5 3h11v10h-11z', 'M10 3v10'],
  moon: ['M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z'],
  sun: ['M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M8 1.5v1.5', 'M8 13v1.5', 'M1.5 8H3', 'M13 8h1.5', 'M3.4 3.4l1 1', 'M11.6 11.6l1 1', 'M3.4 12.6l1-1', 'M11.6 4.4l1-1'],
  keyboard: ['M1.5 4h13v8h-13z', 'M4 6.5h.01', 'M6.5 6.5h.01', 'M9 6.5h.01', 'M11.5 6.5h.01', 'M5 9.5h6'],
  tag: ['M2.5 2.5h5l6 6-5 5-6-6z', 'M5.5 5.5h.01'],
  store: ['M2.5 6.5 3.5 3h9l1 3.5', 'M2.5 6.5h11', 'M3.5 6.5V13h9V6.5', 'M6.5 13v-3.5h3V13'],
  calendar: ['M2.5 4h11v9.5h-11z', 'M2.5 7h11', 'M5.5 2.5v3', 'M10.5 2.5v3'],
  eyeOff: ['M2 2l12 12', 'M6.6 6.6a2 2 0 0 0 2.8 2.8', 'M4.2 4.3C2.8 5.2 1.9 6.5 1.5 8c.9 2.9 3.6 5 6.5 5 1.3 0 2.5-.4 3.6-1', 'M7 3.1c.3 0 .7-.1 1-.1 2.9 0 5.6 2.1 6.5 5-.3 1-.8 1.8-1.4 2.6'],
  eye: ['M1.5 8C2.4 5.1 5.1 3 8 3s5.6 2.1 6.5 5c-.9 2.9-3.6 5-6.5 5S2.4 10.9 1.5 8z', 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  copy: ['M5.5 5.5h8v8h-8z', 'M10.5 5.5v-3h-8v8h3'],
  lock: ['M3.5 7h9v6.5h-9z', 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'],
  trash: ['M2.5 4h11', 'M6 4V2.5h4V4', 'M4 4l.7 9.5h6.6L12 4'],
  arrowUp: ['M8 13V3', 'M4 7l4-4 4 4'],
  arrowDown: ['M8 3v10', 'M4 9l4 4 4-4'],
  check: ['M3 8.5 6.5 12 13 4.5'],
  info: ['M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M8 7.5v4', 'M8 5h.01'],
  table: ['M2.5 3h11v10h-11z', 'M2.5 6.5h11', 'M2.5 10h11', 'M6.5 3v10'],
  chart: ['M2.5 13.5h11', 'M2.5 2.5v11', 'M4.5 10.5l3-3.5 2.5 2 3.5-5'],
  year: ['M2.5 3.5h11v10h-11z', 'M2.5 6.5h11', 'M5 2v3', 'M11 2v3', 'M4.8 11.4l2.2-2 1.8 1.2 2.6-2.6'],
  tag2: ['M8 2.5v11', 'M5.5 5h4a1.75 1.75 0 0 1 0 3.5h-3a1.75 1.75 0 0 0 0 3.5H11'],
  card: ['M1.5 4h13v8.5h-13z', 'M1.5 7h13', 'M4 10.5h3'],
  wallet: ['M2.5 4.5h9.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2.5 12z', 'M2.5 4.5 10 2.5v2', 'M10.5 9h.01'],
  clock: ['M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M8 4.5V8l2.5 1.5'],
  arrowDownIn: ['M8 2.5v7', 'M5 6.5l3 3 3-3', 'M2.5 11v2.5h11V11'],
  scale: ['M8 2.5v11', 'M5 13.5h6', 'M3 5h10', 'M3 5l-1.5 4a2 2 0 0 0 3 0z', 'M13 5l-1.5 4a2 2 0 0 0 3 0z'],
  briefcase: ['M2 5h12v8.5H2z', 'M5.5 5V3h5v2', 'M2 9h12', 'M7 9v1.5h2V9'],
  grid: ['M2.5 2.5h4.5V7H2.5z', 'M9 2.5h4.5V7H9z', 'M2.5 9h4.5v4.5H2.5z', 'M9 9h4.5v4.5H9z'],
  home: ['M2.5 7.5 8 3l5.5 4.5', 'M4 6.5v7h8v-7', 'M6.8 13.5v-3.5h2.4v3.5'],
  swap: ['M3 5.5h9.5', 'M10 3l2.5 2.5L10 8', 'M13 10.5H3.5', 'M6 8l-2.5 2.5L6 13'],
  link: ['M6.5 9.5l3-3', 'M7 4.5 8.5 3a2.5 2.5 0 0 1 3.5 3.5L10.5 8', 'M9 11.5 7.5 13A2.5 2.5 0 0 1 4 9.5L5.5 8'],
  edit: ['M10.5 2.5l3 3-8 8h-3v-3z', 'M9 4l3 3'],
  gear: ['M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M8 1.5v2', 'M8 12.5v2', 'M1.5 8h2', 'M12.5 8h2', 'M3.4 3.4l1.4 1.4', 'M11.2 11.2l1.4 1.4', 'M3.4 12.6l1.4-1.4', 'M11.2 4.8l1.4-1.4'],
};

/** Directional glyphs are drawn pointing "forward" in LTR and mirrored under RTL. */
const DIRECTIONAL = new Set(['chevron']);

export function icon(name, cls = '') {
  const paths = PATHS[name] || PATHS.info;
  return s('svg', { class: ['ico', DIRECTIONAL.has(name) && 'ico-dir', cls], viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
    paths.map((d) => s('path', { d })));
}

/** App mark: a coral glass tile with a line rising to a glowing point (the coral is the app's signature). */
export function appMark() {
  return s('svg', { viewBox: '0 0 18 18', 'aria-hidden': 'true', class: 'app-mark' },
    s('defs', null, s('linearGradient', { id: 'am-grad', x1: 0, y1: 0, x2: 1, y2: 1 },
      s('stop', { offset: 0, class: 'am-g1' }), s('stop', { offset: 1, class: 'am-g2' }))),
    s('rect', { x: 0.5, y: 0.5, width: 17, height: 17, rx: 5.5, class: 'am-bg' }),
    s('path', { d: 'M4 12.2l3-3 2.4 1.8L13 6.6', 'stroke-width': 1.7, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'am-line' }),
    s('circle', { cx: 13.2, cy: 6.4, r: 1.6, class: 'am-dot' }));
}

/** Severity glyph: alert = filled octagon, warning = triangle, info = ring, good = check in circle. */
export function sevGlyph(sev) {
  const a = { viewBox: '0 0 12 12', 'aria-hidden': 'true' };
  switch (sev) {
    case 'alert': return s('svg', a, s('path', { d: 'M3.8.8h4.4l3 3v4.4l-3 3H3.8l-3-3V3.8z', fill: 'currentColor' }),
      s('path', { d: 'M6 3.2v3.2M6 8.4v.2', stroke: 'var(--sev-knock)', 'stroke-width': 1.5, 'stroke-linecap': 'round' }));
    case 'warning': return s('svg', a, s('path', { d: 'M6 1.2 11.2 10.6H.8z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linejoin': 'round' }),
      s('path', { d: 'M6 4.6v2.6M6 8.9v.1', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }));
    case 'good': return s('svg', a, s('circle', { cx: 6, cy: 6, r: 5.2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }),
      s('path', { d: 'M3.6 6.2 5.3 7.9 8.5 4.4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    default: return s('svg', a, s('circle', { cx: 6, cy: 6, r: 5.2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }),
      s('path', { d: 'M6 5.4v3.2M6 3.6v.1', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }));
  }
}

/** The first letter or digit of a name, for its avatar ("שופרסל" → "ש", "AMAZON.COM" → "A"). */
export function initialOf(text) {
  const m = /[\p{L}\p{N}]/u.exec(String(text || ''));
  return m ? m[0].toUpperCase() : '·';
}
/** Row avatar: a category-tinted tile with the name's first letter, or an icon tile (av-ico). */
export function avatarOf(text, { color, iconName, size = '' } = {}) {
  if (iconName) return h('span', { class: ['av', 'av-ico', size], 'aria-hidden': 'true' }, icon(iconName));
  return h('span', { class: ['av', size], 'aria-hidden': 'true', style: color ? { '--c': color } : null }, initialOf(text));
}

export const SEV_LABEL = { alert: 'דורש טיפול', warning: 'כדאי לבדוק', info: 'לידיעה', good: 'חדשות טובות' };

export function sevMark(sev) {
  const k = SEV_LABEL[sev] ? sev : 'info';
  return h('span', { class: 'sev', dataset: { sev: k } }, sevGlyph(k), SEV_LABEL[k]);
}
