// Several months at once: a popover with a year-by-year grid of month toggles. Any set of months
// (they need not be consecutive); Shift+click marks every month between the last click and this one.
// Used by the overview's period picker and the transactions period filter.
import { h } from './dom.js';
import { openPopover } from './layers.js';
import { monthLabel } from './format.js';

const SHORT = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];
const MAX = 36;

/** "ספטמבר–נובמבר 2026", "3 חודשים: מרץ 2026, ..." — a short label for a set of months. */
export function monthsText(months = []) {
  const list = [...months].sort();
  if (!list.length) return '';
  if (list.length === 1) return monthLabel(list[0]);
  const consecutive = list.every((m, i) => i === 0 || nextMonth(list[i - 1]) === m);
  if (consecutive) return `${monthLabel(list[0])} – ${monthLabel(list[list.length - 1])}`;
  return list.length <= 3 ? list.map(monthLabel).join(', ') : `${list.length} חודשים נבחרים`;
}

function nextMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/**
 * @param {HTMLElement} anchor
 * @param {{ available: string[], selected?: string[], onApply: (months: string[]) => void, title?: string }} o
 *   available: months with data (any order); months outside it are shown disabled.
 */
export function openMonthsPicker(anchor, { available = [], selected = [], onApply, title = 'בחירת חודשים' }) {
  const avail = new Set(available);
  const chosen = new Set(selected.filter((m) => avail.has(m)));
  const years = [...new Set(available.map((m) => m.slice(0, 4)))].sort().reverse();
  let last = null;
  const err = h('p', { class: 'error-text', role: 'alert' });
  const status = h('p', { class: 'mp-status', 'aria-live': 'polite' });
  const btns = new Map();

  const paint = () => {
    for (const [m, b] of btns) b.setAttribute('aria-pressed', String(chosen.has(m)));
    status.textContent = chosen.size ? `נבחרו: ${monthsText([...chosen])}` : 'לא נבחר חודש. אפשר לבחור חודש אחד או כמה.';
  };
  const toggle = (m, shift) => {
    err.textContent = '';
    if (shift && last && last !== m) {
      const [a, b] = [last, m].sort();
      const on = !chosen.has(m) || chosen.has(last);
      for (const x of available) if (x >= a && x <= b) { if (on) chosen.add(x); else chosen.delete(x); }
    } else if (chosen.has(m)) chosen.delete(m);
    else chosen.add(m);
    last = m;
    paint();
  };

  const grid = years.map((y) => {
    const months = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
    const all = h('button', { class: 'link mp-all', type: 'button' }, `כל ${y}`);
    all.addEventListener('click', () => {
      const has = months.filter((m) => avail.has(m));
      const every = has.every((m) => chosen.has(m));
      for (const m of has) { if (every) chosen.delete(m); else chosen.add(m); }
      paint();
    });
    return h('section', { class: 'mp-year', 'aria-label': y },
      h('div', { class: 'mp-yhead' }, h('h3', null, y), all),
      h('div', { class: 'mp-grid', role: 'group', 'aria-label': `חודשי ${y}` }, months.map((m, i) => {
        const b = h('button', {
          class: 'mp-m', type: 'button', disabled: !avail.has(m), 'aria-pressed': 'false',
          'aria-label': monthLabel(m), title: avail.has(m) ? monthLabel(m) : `${monthLabel(m)}: אין נתונים`,
        }, SHORT[i]);
        b.addEventListener('click', (e) => toggle(m, e.shiftKey));
        btns.set(m, b);
        return b;
      })));
  });

  const apply = h('button', { class: 'btn primary small', type: 'button' }, 'הצגה');
  const clear = h('button', { class: 'btn ghost small', type: 'button' }, 'ניקוי');
  const cancel = h('button', { class: 'btn ghost small', type: 'button' }, 'ביטול');
  const pop = openPopover(anchor, {
    label: title, className: 'months-pop',
    content: [
      h('h2', { class: 'pop-title' }, title),
      h('p', { class: 'mp-hint' }, 'לחיצה בוחרת או מבטלת חודש. Shift + לחיצה בוחרת את כל החודשים שביניהם.'),
      h('div', { class: 'mp-years' }, grid),
      status, err,
      h('div', { class: 'pop-actions' }, apply, clear, cancel),
    ],
    initialFocus: (el) => el.querySelector('.mp-m[aria-pressed="true"]') || el.querySelector('.mp-m:not([disabled])'),
  });
  paint();
  clear.addEventListener('click', () => { chosen.clear(); last = null; paint(); });
  cancel.addEventListener('click', () => pop.close());
  apply.addEventListener('click', () => {
    if (!chosen.size) { err.textContent = 'צריך לבחור לפחות חודש אחד.'; return; }
    if (chosen.size > MAX) { err.textContent = `אפשר לבחור עד ${MAX} חודשים.`; return; }
    pop.close(true);
    onApply([...chosen].sort());
  });
  return pop;
}
