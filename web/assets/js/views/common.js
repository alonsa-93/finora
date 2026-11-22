// Pieces shared by several views.
import { h, icon } from '../dom.js';
import { state, on } from '../store.js';
import { startSync } from '../sync.js';
import { monthLabel, relativeTime, dateTime } from '../format.js';
import { selectBox } from '../listbox.js';

/** "עודכן לפני 3 שעות · סנכרן עכשיו". Updates itself on sync/status events. */
export function syncLine() {
  const when = h('span', { class: 'when' });
  const btn = h('button', { class: 'btn small', type: 'button' }, icon('sync'), h('span', null, 'סנכרן עכשיו'));
  btn.addEventListener('click', () => startSync());
  const el = h('div', { class: 'syncline', role: 'group', 'aria-label': 'מצב סנכרון' }, when, btn);
  const paint = () => {
    if (!el.isConnected && el.dataset.mounted) { offs.forEach((f) => f()); return; }
    el.dataset.mounted = '1';
    const running = Boolean(state.sync?.running);
    const err = state.connections.some((c) => c.lastStatus === 'error');
    const rel = relativeTime(state.status?.lastSyncAt);
    when.textContent = running ? 'מסנכרן עכשיו…' : err ? 'חלק מהחיבורים נכשלו בסנכרון האחרון' : rel ? `עודכן ${rel}` : 'עוד לא סונכרן';
    when.title = state.status?.lastSyncAt ? `סנכרון אחרון: ${dateTime(state.status.lastSyncAt)}` : '';
    el.dataset.state = running ? 'running' : err ? 'error' : 'idle';
    btn.disabled = running || (!state.status?.demoMode && !state.connections.length);
    btn.setAttribute('aria-busy', String(running));
    btn.lastChild.textContent = running ? 'מסנכרן…' : 'סנכרן עכשיו';
  };
  const offs = [on('sync', paint), on('status', paint), on('reference', paint)];
  queueMicrotask(paint);
  return el;
}

/** Month stepper: older is to the right (previous), newer to the left (next). */
export function monthStepper({ month, months = [], onChange }) {
  const i = months.indexOf(month);
  const older = i >= 0 ? months[i + 1] : null;     // availableMonths is newest-first
  const newer = i > 0 ? months[i - 1] : null;
  const prev = h('button', { class: 'icon-btn', type: 'button', 'aria-label': older ? `החודש הקודם, ${monthLabel(older)}` : 'אין חודש קודם', title: 'החודש הקודם (PageDown)', disabled: !older }, icon('chevron', 'flip'));
  const next = h('button', { class: 'icon-btn', type: 'button', 'aria-label': newer ? `החודש הבא, ${monthLabel(newer)}` : 'אין חודש הבא', title: 'החודש הבא (PageUp)', disabled: !newer }, icon('chevron'));
  prev.addEventListener('click', () => older && onChange(older));
  next.addEventListener('click', () => newer && onChange(newer));
  let label;
  if (months.length) {
    // A glass listbox, not a native <select>: the OS drop-down ignores the theme and the RTL layout.
    const list = months.includes(month) || !month ? months : [month, ...months];
    label = selectBox({
      label: 'בחירת חודש', className: 'label',
      options: list.map((m) => ({ value: m, label: monthLabel(m) })),
      value: month, onChange: (v) => onChange(v),
      anchor: () => label.closest('.month-step'),   // the list hangs from the whole pill
    }).el;
  } else {
    label = h('span', { class: 'label' }, month ? monthLabel(month) : '');
  }
  return h('div', { class: 'month-step', role: 'group', 'aria-label': 'חודש' }, prev, label, next);
}

/** The one empty / no-results / error block: an icon disc, a title, a sentence, at most one action. */
export function emptyState({ icon: ic = 'list', title, text, action = null, small = false, error = false, level = 2, role = null }) {
  return h('div', { class: ['empty', small && 'small', error && 'error'], role },
    h('span', { class: 'empty-ico', 'aria-hidden': 'true' }, icon(ic)),
    h(`h${level}`, null, title), text ? h('p', null, text) : null, action);
}

export function errorState(title, message, retry) {
  const b = retry ? h('button', { class: 'btn', type: 'button' }, icon('sync'), 'לנסות שוב') : null;
  b?.addEventListener('click', retry);
  return emptyState({ icon: 'info', title, text: message || 'משהו השתבש.', action: b, error: true, level: 3, role: 'alert' });
}

/** Loading: skeleton rows in the real row shape (avatar, two lines, amount). */
export function skeletonList(n = 8) {
  return h('div', { class: 'sk-list', 'aria-hidden': 'true' }, Array.from({ length: n }, () =>
    h('div', { class: 'sk-line' }, h('span', { class: 'sk sk-av' }), h('span', { class: 'sk-t' }, h('span', { class: 'sk sk-a' }), h('span', { class: 'sk sk-b' })), h('span', { class: 'sk sk-amt' }))));
}

/** The page header used by every screen: title, one sub-line, then the screen's controls. */
export function pageHead(title, sub, ...controls) {
  return h('div', { class: 'cmdbar' },
    h('div', { class: 'page-title' }, h('h1', null, title), h('p', { class: 'page-sub' }, sub || ' ')),
    controls.length ? [h('span', { class: 'grow' }), controls] : null);
}

export { state };
