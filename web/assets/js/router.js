// Hash router: #/overview?month=2026-11, #/transactions?category=x, #/recurring, #/annual?tab=prices, #/settings
import { emit } from './store.js';
import { setPref } from './prefs.js';

// Rail order (settings stays last); `key` is the Ctrl+digit shortcut, kept stable for existing users.
export const SECTIONS = [
  { id: 'overview', label: 'סקירה', icon: 'overview', key: '1' },
  { id: 'transactions', label: 'תנועות', icon: 'list', key: '2' },
  { id: 'recurring', label: 'חיובים קבועים', icon: 'repeat', key: '3' },
  { id: 'annual', label: 'סיכום שנתי', icon: 'year', key: '5' },
  { id: 'chat', label: 'שאלות', icon: 'chat', key: '6' },
  { id: 'business', label: 'העסק', icon: 'briefcase', key: '7', business: true },
  { id: 'dashboards', label: 'דשבורדים', icon: 'grid', key: '8' },
  { id: 'settings', label: 'חשבונות והגדרות', icon: 'bank', key: '4' },
];

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, q = ''] = raw.split('?');
  const section = SECTIONS.some((s) => s.id === path) ? path : null;
  const params = Object.fromEntries(new URLSearchParams(q));
  return { section, params };
}

export function hrefFor(section, params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const q = sp.toString();
  return `#/${section}${q ? `?${q}` : ''}`;
}

export function go(section, params = {}, { replace = false } = {}) {
  const href = hrefFor(section, params);
  if (replace) history.replaceState(null, '', href); else if (location.hash !== href) history.pushState(null, '', href);
  route();
}

export function route() {
  const r = parseHash();
  if (r.section) setPref('lastSection', r.section);
  emit('route', r);
}

window.addEventListener('hashchange', route);
