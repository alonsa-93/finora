import { getPref, setPref } from './prefs.js';

const mq = window.matchMedia('(prefers-color-scheme: dark)');

export const THEME_LABEL = { system: 'לפי Windows', light: 'בהיר', dark: 'כהה' };

export function themePref() {
  const p = getPref('theme', 'system');
  return p === 'light' || p === 'dark' ? p : 'system';
}

export function resolvedTheme() {
  const p = themePref();
  return p === 'system' ? (mq.matches ? 'dark' : 'light') : p;
}

function apply() {
  document.documentElement.setAttribute('data-theme', resolvedTheme());
}

export function setTheme(pref) {
  setPref('theme', pref);
  apply();
}

/** Cycle system → light → dark → system. */
export function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  const resolve = (p) => (p === 'system' ? (mq.matches ? 'dark' : 'light') : p);
  const before = resolvedTheme();
  let next = order[(order.indexOf(themePref()) + 1) % order.length];
  // Every press must change what is on screen: skip a step that resolves to the same colours
  // (e.g. "system" → "light" while Windows is already light).
  if (resolve(next) === before) next = order[(order.indexOf(next) + 1) % order.length];
  setTheme(next);
  return next;
}


mq.addEventListener('change', () => { if (themePref() === 'system') apply(); });
