// A glass date-range calendar (the WAI-ARIA APG date-picker grid), used in the transactions range popover.
// Hebrew month and day names, weeks start on Sunday, and the grid is RTL (Sunday is the right-most column).
// Keys on a day: → / ← the previous / next day (RTL), ↑ / ↓ a week, Home / End the start / end of the week,
// PageUp / PageDown a month (with Shift: a year), Enter / Space pick it. Esc is the popover's (closes it).
// The first pick sets "מתאריך", the second "עד תאריך" (an earlier second pick swaps them). The two ends are
// toggle buttons above the grid, so either end can be re-picked. Days outside [min, max] are disabled.
import { h, icon, nextId } from './dom.js';

const fmtMonth = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' });
const fmtLong = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtEnd = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
const WD = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const WD_LONG = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (d) => (d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '');
const parse = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last));
};
const sameDay = (a, b) => Boolean(a && b) && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

/**
 * rangeCalendar({ from, to, min, max, onChange })  (ISO dates 'YYYY-MM-DD'; empty = open end)
 * returns { el, focusGrid(), value: () => ({ from, to }) }
 */
export function rangeCalendar({ from = '', to = '', min = '', max = '', onChange }) {
  let start = parse(from), end = parse(to);
  const lo = parse(min), hi = parse(max);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const clamp = (d) => (lo && d < lo ? lo : hi && d > hi ? hi : d);
  const allowed = (d) => !(lo && d < lo) && !(hi && d > hi);
  let editing = start && !end ? 'to' : 'from';
  let active = clamp(end || start || today);
  let view = monthStart(active);
  let hover = null;

  const titleId = nextId('rcal');
  const title = h('h3', { class: 'rcal-title', id: titleId, 'aria-live': 'polite' });
  const prev = h('button', { class: 'icon-btn', type: 'button' }, icon('chevron', 'flip'));
  const next = h('button', { class: 'icon-btn', type: 'button' }, icon('chevron'));
  prev.addEventListener('click', () => { view = addMonths(view, -1); active = clamp(addMonths(active, -1)); render(); });
  next.addEventListener('click', () => { view = addMonths(view, 1); active = clamp(addMonths(active, 1)); render(); });

  const endBtn = (which, label) => {
    const v = h('span', { class: 'rcal-v' });
    const b = h('button', { class: 'rcal-end', type: 'button', 'aria-pressed': 'false', dataset: { end: which } }, h('span', { class: 'rcal-k' }, label), v);
    b.addEventListener('click', () => { editing = which; const d = which === 'from' ? start : end; if (d) { active = d; view = monthStart(d); } render(); focusGrid(); });
    return { b, v };
  };
  const fromEnd = endBtn('from', 'מתאריך');
  const toEnd = endBtn('to', 'עד תאריך');
  const hint = h('p', { class: 'rcal-hint', 'aria-live': 'polite' });

  const thead = h('thead', null, h('tr', null, WD.map((w, i) => h('th', { scope: 'col', abbr: WD_LONG[i] }, h('span', { 'aria-hidden': 'true' }, w), h('span', { class: 'sr-only' }, WD_LONG[i])))));
  const tbody = h('tbody');
  const grid = h('table', { class: 'rcal-grid', role: 'grid', 'aria-labelledby': titleId }, thead, tbody);
  let cells = [];   // [{ td, date }]

  function render() {
    title.textContent = fmtMonth.format(view);
    const prevMonth = addMonths(view, -1), nextMonth = monthStart(addMonths(view, 1));
    prev.disabled = Boolean(lo) && monthStart(lo) >= view;
    next.disabled = Boolean(hi) && monthStart(hi) <= view;
    prev.setAttribute('aria-label', `החודש הקודם, ${fmtMonth.format(prevMonth)}`);
    next.setAttribute('aria-label', `החודש הבא, ${fmtMonth.format(nextMonth)}`);
    const first = addDays(view, -view.getDay());   // the Sunday on or before the 1st
    cells = [];
    const rows = [];
    for (let w = 0; w < 6; w++) {   // always six weeks: the popover never changes height
      const tr = h('tr');
      for (let i = 0; i < 7; i++) {
        const d = addDays(first, w * 7 + i);
        if (d.getMonth() !== view.getMonth()) { tr.append(h('td', { class: 'rcal-out', role: 'gridcell', 'aria-hidden': 'true' })); continue; }
        const td = h('td', { role: 'gridcell', tabindex: '-1' }, h('span', { class: 'rcal-n' }, String(d.getDate())));
        td.addEventListener('click', () => pick(d));
        td.addEventListener('mouseenter', () => { if (editing === 'to' && start) { hover = d; paint(); } });
        cells.push({ td, date: d });
        tr.append(td);
      }
      rows.push(tr);
    }
    tbody.replaceChildren(...rows);
    paint();
  }

  /** Classes and ARIA state only: the cells stay, so focus and hover survive. */
  function paint() {
    const tail = end || (editing === 'to' && start && hover && hover > start ? hover : null);
    for (const { td, date } of cells) {
      const isStart = sameDay(date, start), isEnd = sameDay(date, end);
      const inside = start && tail && date > start && date < tail;
      const ok = allowed(date);
      td.className = ['rcal-d', isStart && 'is-start', (isEnd || (!end && sameDay(date, tail))) && 'is-end', inside && 'in-range',
        start && tail && !sameDay(start, tail) && 'has-range', sameDay(date, today) && 'is-today', !ok && 'is-off'].filter(Boolean).join(' ');
      td.setAttribute('aria-selected', String(Boolean(isStart || isEnd || (inside && end))));
      if (!ok) td.setAttribute('aria-disabled', 'true'); else td.removeAttribute('aria-disabled');
      td.setAttribute('aria-label', `${fmtLong.format(date)}${isStart ? ', תאריך ההתחלה' : ''}${isEnd ? ', תאריך הסיום' : ''}${sameDay(date, today) ? ', היום' : ''}`);
      td.tabIndex = sameDay(date, active) ? 0 : -1;
    }
    fromEnd.v.textContent = start ? fmtEnd.format(start) : 'מההתחלה';
    toEnd.v.textContent = end ? fmtEnd.format(end) : 'עד היום';
    fromEnd.b.setAttribute('aria-pressed', String(editing === 'from'));
    toEnd.b.setAttribute('aria-pressed', String(editing === 'to'));
    fromEnd.b.setAttribute('aria-label', `מתאריך: ${start ? fmtLong.format(start) : 'מההתחלה'}${editing === 'from' ? '. הבחירה הבאה בלוח תקבע אותו' : '. לבחירה מחדש'}`);
    toEnd.b.setAttribute('aria-label', `עד תאריך: ${end ? fmtLong.format(end) : 'עד היום'}${editing === 'to' ? '. הבחירה הבאה בלוח תקבע אותו' : '. לבחירה מחדש'}`);
    hint.textContent = editing === 'to' ? 'עכשיו בוחרים את תאריך הסיום'
      : start && end ? 'הטווח נבחר. בחירה נוספת בלוח מתחילה טווח חדש' : 'בוחרים בלוח את תאריך ההתחלה';
  }

  function pick(d) {
    if (!allowed(d)) return;
    active = d;
    if (editing === 'from') {
      start = d;
      if (end && end < start) end = null;
      editing = 'to';
    } else if (start && d < start) {
      end = start; start = d; editing = 'from';
    } else {
      end = d; editing = 'from';
    }
    hover = null;
    if (d.getMonth() !== view.getMonth() || d.getFullYear() !== view.getFullYear()) { view = monthStart(d); render(); } else paint();
    onChange?.({ from: isoOf(start), to: isoOf(end) });
    focusGrid();
  }

  function moveTo(d) {
    d = clamp(d);
    active = d;
    if (d.getMonth() !== view.getMonth() || d.getFullYear() !== view.getFullYear()) { view = monthStart(d); render(); } else paint();
    focusGrid();
  }

  function focusGrid() { cells.find((c) => sameDay(c.date, active))?.td.focus({ preventScroll: true }); }

  grid.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let d = null;
    if (k === 'ArrowLeft') d = addDays(active, 1);            // RTL: left is later
    else if (k === 'ArrowRight') d = addDays(active, -1);
    else if (k === 'ArrowDown') d = addDays(active, 7);
    else if (k === 'ArrowUp') d = addDays(active, -7);
    else if (k === 'Home') d = addDays(active, -active.getDay());
    else if (k === 'End') d = addDays(active, 6 - active.getDay());
    else if (k === 'PageUp') d = addMonths(active, e.shiftKey ? -12 : -1);
    else if (k === 'PageDown') d = addMonths(active, e.shiftKey ? 12 : 1);
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); e.stopPropagation(); pick(active); return; }
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    moveTo(d);
  });
  grid.addEventListener('mouseleave', () => { if (hover) { hover = null; paint(); } });

  const el = h('div', { class: 'rcal' },
    h('div', { class: 'rcal-ends', role: 'group', 'aria-label': 'קצוות הטווח' }, fromEnd.b, h('span', { class: 'rcal-dash', 'aria-hidden': 'true' }, '–'), toEnd.b),
    h('div', { class: 'rcal-box' },
      h('div', { class: 'rcal-head' }, prev, title, next),
      grid),
    hint);
  render();
  return { el, focusGrid, value: () => ({ from: isoOf(start), to: isoOf(end) }) };
}
