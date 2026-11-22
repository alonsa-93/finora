// Window chrome: title bar (drawn by us; the Electron window is frameless), sidebar, inspector column.
import { h, icon, appMark, mount } from './dom.js';
import { SECTIONS, hrefFor } from './router.js';
import { state, on } from './store.js';
import { getPref, setPref } from './prefs.js';
import { relativeTime } from './format.js';

const desk = window.finora && window.finora.isDesktop ? window.finora : null;
const isMac = /Mac/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

const els = {};

/* ---------- window controls ---------- */
function captionIcon(kind) {
  const svg = (d) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 10 10'); s.setAttribute('aria-hidden', 'true');
    for (const p of d) { const e = document.createElementNS('http://www.w3.org/2000/svg', 'path'); e.setAttribute('d', p); s.append(e); }
    return s;
  };
  if (kind === 'min') return svg(['M0 5.5h10']);
  if (kind === 'max') return svg(['M.5.5h9v9h-9z']);
  if (kind === 'restore') return svg(['M.5 2.5h7v7h-7z', 'M2.5 2.5V.5h7v7h-2']);
  return svg(['M0 0l10 10', 'M10 0L0 10']);
}

function windowControls() {
  if (!desk || !desk.window) return null;
  const w = desk.window;
  const min = h('button', { type: 'button', 'aria-label': 'מזעור', title: 'מזעור' }, captionIcon('min'));
  const max = h('button', { type: 'button', 'aria-label': 'הגדלה', title: 'הגדלה' }, captionIcon('max'));
  const close = h('button', { type: 'button', class: 'close', 'aria-label': 'סגירה', title: 'סגירה' }, captionIcon('close'));
  min.addEventListener('click', () => w.minimize?.());
  max.addEventListener('click', () => w.toggleMaximize?.());
  close.addEventListener('click', () => w.close?.());
  const setMax = (m) => {
    max.replaceChildren(captionIcon(m ? 'restore' : 'max'));
    const label = m ? 'שחזור גודל' : 'הגדלה';
    max.setAttribute('aria-label', label); max.title = label;
  };
  try { Promise.resolve(w.isMaximized?.()).then((m) => setMax(Boolean(m))).catch(() => {}); } catch { /* ignore */ }
  try { w.onMaximizedChange?.((m) => setMax(Boolean(m))); } catch { /* ignore */ }
  // DOM order min, max, close → in RTL the close button ends up outermost (far left), as in mirrored Windows apps.
  return h('div', { class: 'wc', role: 'group', 'aria-label': 'פקדי חלון' }, min, max, close);
}

/* ---------- title bar ---------- */
const LENS_CHOICES = [['all', 'הכול', 'wallet'], ['business', 'עסק', 'briefcase'], ['private', 'פרטי', 'home']];

function titlebar({ onCommand, onSync, onDemo, onLens }) {
  els.where = h('div', { class: 'tb-where', 'aria-live': 'off' });
  els.cmd = h('button', { class: 'tb-cmd', type: 'button', 'aria-label': `חיפוש ופקודות (${MOD}+K)`, 'aria-keyshortcuts': 'Control+K' },
    icon('search'), h('span', null, 'חיפוש, מעבר או פקודה'), h('kbd', null, `${MOD}+K`));
  els.cmd.addEventListener('click', onCommand);
  els.demo = h('button', { class: 'tb-demo', type: 'button', hidden: true, title: 'מוצגים נתוני הדגמה. לחיבור חשבון אמיתי' }, 'נתוני הדגמה');
  els.demo.addEventListener('click', onDemo);
  els.sync = h('button', { class: 'tb-sync', type: 'button' }, icon('sync'), h('span', { class: 'txt' }, ''));
  els.sync.addEventListener('click', onSync);
  // Business mode: which side of the money every screen shows (hidden while business mode is off).
  els.lens = h('div', { class: 'tb-lens', role: 'radiogroup', 'aria-label': 'איזה צד להציג', hidden: true },
    LENS_CHOICES.map(([id, label, ic]) => {
      const b = h('button', { type: 'button', role: 'radio', dataset: { lens: id }, 'aria-checked': 'false' }, icon(ic), h('span', null, label));
      b.addEventListener('click', () => onLens?.(id));
      return b;
    }));
  els.lens.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const i = LENS_CHOICES.findIndex(([id]) => id === state.lens);
    const d = e.key === 'ArrowLeft' ? 1 : -1; // RTL: left = next
    const next = LENS_CHOICES[(i + d + LENS_CHOICES.length) % LENS_CHOICES.length][0];
    onLens?.(next);
    els.lens.querySelector(`[data-lens="${next}"]`)?.focus();
  });
  const bar = h('header', { class: 'titlebar' },
    h('div', { class: 'tb-brand' }, appMark(), h('b', null, 'Finora')),
    els.where,
    els.lens,
    h('div', { class: 'tb-drag' }),
    els.cmd,
    h('div', { class: 'tb-drag' }),
    h('div', { class: 'tb-status' }, els.demo, els.sync),
    windowControls());
  // Double-click on drag regions maximises natively (Windows handles app-region: drag).
  return bar;
}

/** Show the lens switch and the business nav link only while business mode is on. */
export function renderBusinessChrome() {
  const on = Boolean(state.business?.enabled);
  if (els.lens) {
    els.lens.hidden = !on;
    for (const b of els.lens.querySelectorAll('button')) {
      const sel = b.dataset.lens === state.lens;
      b.setAttribute('aria-checked', String(sel));
      b.tabIndex = sel ? 0 : -1;
    }
  }
  for (const a of els.navLinks || []) {
    const sec = SECTIONS.find((x) => x.id === a.dataset.section);
    if (sec?.business) a.hidden = !on;
  }
}

export function setWhere(section, detail) {
  if (!els.where) return;
  const sec = SECTIONS.find((s) => s.id === section);
  mount(els.where,
    h('span', { class: 'sep', 'aria-hidden': 'true' }, '/'),
    h('span', { class: 'cur' }, sec ? sec.label : ''),
    detail ? [h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), h('span', null, detail)] : null);
  document.title = `${sec ? sec.label : ''}${detail ? ` · ${detail}` : ''} · Finora`;
}

export function renderStatusChrome() {
  const st = state.status;
  if (els.demo) els.demo.hidden = !st?.demoMode;
  const sync = state.sync;
  const txt = els.sync?.querySelector('.txt');
  if (!txt) return;
  let label, s = 'idle';
  if (sync?.running) {
    const items = sync.items || [];
    const done = items.filter((i) => i.state === 'ok' || i.state === 'error').length;
    label = items.length ? `מסנכרן ${done} מתוך ${items.length}` : 'מסנכרן…';
    s = 'running';
  } else if (state.connections.some((c) => c.lastStatus === 'error')) {
    label = 'שגיאת סנכרון';
    s = 'error';
  } else {
    const rel = relativeTime(st?.lastSyncAt);
    label = rel ? `עודכן ${rel}` : 'טרם סונכרן';
  }
  // Idle: icon only (the time is on the overview and in the tooltip). Running or failed: say it.
  txt.textContent = s === 'idle' ? '' : label;
  els.sync.dataset.state = s;
  els.sync.title = s === 'running' ? 'הסנכרון פועל. לחיצה פותחת את מסך החשבונות' : s === 'error' ? 'חיבור אחד או יותר נכשל. לפרטים' : `${label}. לחיצה מסנכרנת עכשיו`;
  els.sync.setAttribute('aria-label', s === 'idle' ? els.sync.title : `${label}. ${els.sync.title}`);
  paintSidebarStatus(s, label);
}

/** Sidebar footer: what is connected and how fresh it is, one click from the accounts screen. */
function paintSidebarStatus(s, label) {
  if (!els.sbStatus) return;
  const st = state.status;
  const n = state.connections.length;
  const main = n === 0 ? 'אין חשבונות מחוברים' : n === 1 ? 'חשבון אחד מחובר' : `${n} חשבונות מחוברים`;
  const rel = relativeTime(st?.lastSyncAt);
  const sub = s === 'running' ? label : s === 'error' ? 'סנכרון נכשל, לפרטים' : rel ? `עודכן ${rel}` : 'טרם סונכרן';
  els.sbStatus.dataset.state = n === 0 ? 'none' : s;
  els.sbStatusMain.textContent = main;
  els.sbStatusSub.textContent = sub;
  const full = `${main}. ${sub}${st?.demoMode ? '. מוצגים נתוני הדגמה' : ''}`;
  els.sbStatus.title = full;
  els.sbStatus.setAttribute('aria-label', `${full}. מעבר לחשבונות והגדרות`);
}

/* ---------- sidebar ---------- */
function sidebar(frame) {
  const links = SECTIONS.map((sct) => {
    // In the icon rail the label doubles as the tooltip (shown on hover and on keyboard focus), so no native title.
    const a = h('a', { href: hrefFor(sct.id), dataset: { section: sct.id } },
      icon(sct.icon), h('span', { class: 'lbl', dataset: { kbd: `${MOD}+${sct.key}` } }, sct.label), h('kbd', { 'aria-hidden': 'true' }, `${MOD}+${sct.key}`));
    a.setAttribute('aria-keyshortcuts', `Control+${sct.key}`);
    return a;
  });
  els.navLinks = links;
  const collapse = h('button', { class: 'icon-btn sb-collapse', type: 'button', 'aria-label': `כיווץ סרגל הצד (${MOD}+B)`, title: `כיווץ סרגל הצד (${MOD}+B)` }, icon('sidebar'));
  collapse.addEventListener('click', () => toggleSidebar());
  els.sbStatusMain = h('span', { class: 'sb-st-main' });
  els.sbStatusSub = h('span', { class: 'sb-st-sub' });
  els.sbStatus = h('a', { class: 'sb-status', href: hrefFor('settings') },
    h('span', { class: 'sb-dot', 'aria-hidden': 'true' }), h('span', { class: 'sb-st-text' }, els.sbStatusMain, els.sbStatusSub));
  const resizer = h('div', { class: 'sb-resizer', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'שינוי רוחב סרגל הצד', tabindex: '0', 'aria-valuemin': '160', 'aria-valuemax': '360' });
  wireResizer(resizer, frame);
  return h('aside', { class: 'sidebar', 'aria-label': 'ניווט ראשי' },
    h('nav', { class: 'nav', 'aria-label': 'אזורים' }, links),
    h('div', { class: 'sb-foot' }, els.sbStatus, collapse),
    resizer);
}

function currentWidth() {
  const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sb-w'), 10);
  return Number.isFinite(v) ? v : 200;
}
function setWidth(w) {
  const c = Math.round(Math.min(360, Math.max(160, w)));
  document.documentElement.style.setProperty('--sb-w', `${c}px`);
  setPref('sidebarW', c);
  els.resizer?.setAttribute('aria-valuenow', String(c));
}

function wireResizer(handle, frame) {
  els.resizer = handle;
  handle.setAttribute('aria-valuenow', String(currentWidth()));
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    const startX = e.clientX, startW = frame.querySelector('.sidebar').getBoundingClientRect().width;
    const move = (ev) => setWidth(startW + (startX - ev.clientX)); // RTL: dragging left widens
    const up = () => { handle.classList.remove('dragging'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', () => setWidth(200));
  handle.addEventListener('keydown', (e) => {
    const w = currentWidth();
    if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(w + 16); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(w - 16); }
    else if (e.key === 'Home') { e.preventDefault(); setWidth(200); }
  });
}

export function toggleSidebar(force) {
  const collapsed = force ?? els.frame.dataset.sidebar !== 'collapsed';
  els.frame.dataset.sidebar = collapsed ? 'collapsed' : 'open';
  setPref('railCollapsed', collapsed);
  const label = collapsed ? `הצגת שמות האזורים (${MOD}+B)` : `סרגל סמלים בלבד (${MOD}+B)`;
  const btn = els.frame.querySelector('.sb-collapse');
  btn.setAttribute('aria-label', label); btn.title = label;
}

export function setActiveSection(id) {
  for (const a of els.navLinks || []) {
    if (a.dataset.section === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

export function setNavBadge(section, text, label) {
  const a = (els.navLinks || []).find((l) => l.dataset.section === section);
  if (!a) return;
  a.querySelector('.badge')?.remove();
  if (text) a.querySelector('.lbl').after(h('span', { class: 'badge', 'aria-label': label || text }, text));
}

/* ---------- inspector ---------- */
let inspectorClose = null;
/** head: optional nodes for a richer header (must contain the <h2>); otherwise the title as <h2>. */
export function openInspector({ title, head, content, onClose, label }) {
  closeInspector(true);
  const x = h('button', { class: 'icon-btn insp-close', type: 'button', 'aria-label': 'סגירת חלונית הפרטים', dataset: { tip: 'סגירה (Esc)' } }, icon('close'));
  const panel = h('aside', { class: 'inspector', 'aria-label': label || 'פרטים', tabindex: '-1' },
    h('div', { class: ['insp-head', head && 'rich'] }, head || h('h2', null, title), x),
    h('div', { class: 'insp-body' }, content));
  x.addEventListener('click', () => closeInspector());
  els.inspectorSlot.replaceChildren(panel);
  inspectorClose = onClose || null;
  return panel;
}
export function closeInspector(silent = false) {
  if (!els.inspectorSlot || !els.inspectorSlot.firstChild) return false;
  els.inspectorSlot.replaceChildren();
  const cb = inspectorClose; inspectorClose = null;
  if (!silent) cb?.();
  return true;
}
export const inspectorOpen = () => Boolean(els.inspectorSlot?.firstChild);

/* ---------- build ---------- */
export function buildShell(root, handlers) {
  els.main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  els.inspectorSlot = h('div', { class: 'insp-slot', style: { display: 'contents' } });
  els.frame = h('div', { class: 'frame', dataset: { sidebar: getPref('railCollapsed', true) ? 'collapsed' : 'open' } });
  els.frame.append(sidebar(els.frame), els.main, els.inspectorSlot);
  const skip = h('a', { class: 'sr-only', href: '#main' }, 'דילוג לתוכן');
  skip.addEventListener('click', (e) => { e.preventDefault(); els.main.focus(); });
  mount(root, h('div', { class: 'app' }, titlebar(handlers), els.frame));
  root.prepend(skip);
  toggleSidebar(els.frame.dataset.sidebar === 'collapsed');
  on('status', renderStatusChrome);
  on('sync', renderStatusChrome);
  on('reference', renderStatusChrome);
  setInterval(renderStatusChrome, 60 * 1000);
  return els.main;
}

export const isDesktop = Boolean(desk);
