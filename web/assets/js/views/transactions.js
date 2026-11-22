// תנועות: every transaction across all accounts, grouped by day. A page header with the period's
// figures (from the server, never added up here), a glass filter bar, a dense keyboard-first list
// with sticky day headers, and the inspector. Filters live in the URL; sort and columns are remembered.
import { h, icon, mount, avatarOf } from '../dom.js';
import { api } from '../api.js';
import { state, categoryById, categoryName, rememberMerchants, on } from '../store.js';
import { go, hrefFor } from '../router.js';
import { setWhere, openInspector, closeInspector, inspectorOpen, MOD } from '../shell.js';
import { openMenu, openPopover, toast, choiceDialog, tip } from '../layers.js';
import { selectBox } from '../listbox.js';
import { pickCategory } from '../catpicker.js';
import { registerUndo } from '../undo.js';
import { getPref, setPref } from '../prefs.js';
import {
  isNum, money, moneyText, foreignText, dateShort, dateFull, weekdayDate, monthLabel, monthBounds, intText,
  todayIso, accountLabel, accountText, shiftMonth,
} from '../format.js';
import { errorState, emptyState } from './common.js';
import { rangeCalendar } from '../rangecal.js';
import { openMonthsPicker, monthsText } from '../monthpick.js';

const PAGE = 100;
const ROW_H = 52;   // keep in step with --tx-row-h (PageUp / PageDown step)
const FILTER_KEYS = ['q', 'month', 'months', 'from', 'to', 'accountId', 'category', 'direction', 'kind', 'ids', 'from_insight'];
// kind: the exact rows behind the overview figures (server: repo.js SPENDING_SQL / INCOME_SQL).
const KIND_LABEL = { spending: 'הוצאות שנספרות בסקירה', income: 'הכנסות שנספרות בסקירה' };
const COLS = [
  { id: 'category', label: 'קטגוריה' },
  { id: 'account', label: 'חשבון' },
  { id: 'processed', label: 'תאריך החיוב (כשהוא שונה)' },
];
const SOURCE_LABEL = { auto: 'זוהתה אוטומטית', user: 'נקבעה על ידך', provider: 'לפי חברת האשראי או הבנק' };
const KIND_GROUP = { expense: 'הוצאות', income: 'הכנסות', neutral: 'העברות וחיובי כרטיס' };
const TIP = {
  pending: 'העסקה עוד לא נקלטה סופית אצל חברת האשראי. הסכום עשוי להשתנות.',
  cardpay: 'זה החיוב החודשי של כרטיס האשראי בחשבון הבנק. העסקאות עצמן כבר מופיעות בנפרד, ולכן הוא לא נספר בהוצאות.',
  excl: 'בחרת להוציא את התנועה מהסיכומים',
  owner: 'כסף שעבר בינך לבין העסק. לא נספר כהוצאה או כהכנסה של אף צד.',
  csv: 'ייצוא התנועות בתקופה לקובץ CSV. הקובץ לא מוצפן: כדאי לשמור אותו בתיקייה שלא מסונכרנת לענן.',
};

export function avatar(t, size = '') {
  return avatarOf(t.description, { color: categoryById(t.category)?.color || 'var(--ink-4)', size });
}

/** One chip style for every status: pending, instalment, card bill, excluded, foreign currency. */
function badges(t, { fx = false } = {}) {
  const out = [];
  if (t.status === 'pending') out.push(tip(h('span', { class: 'badge b-pending' }, 'ממתין'), TIP.pending));
  if (t.installments && isNum(t.installments.number) && isNum(t.installments.total)) out.push(h('span', { class: 'badge b-inst' }, `תשלום ${t.installments.number} מתוך ${t.installments.total}`));
  if (t.isCardPayment) out.push(tip(h('span', { class: 'badge b-card' }, 'חיוב כרטיס, לא נספר'), TIP.cardpay));
  if (t.excluded) out.push(tip(h('span', { class: 'badge b-excl' }, 'לא נספרת'), TIP.excl));
  if (fx && isForeign(t)) out.push(h('span', { class: 'badge b-fx' }, h('bdi', { class: 'num' }, foreignText(t.originalAmount, t.originalCurrency))));
  // Business mode: whose money it is.
  if (state.business?.enabled) {
    if (t.transferKind === 'owner_draw' || t.transferKind === 'owner_injection') {
      out.push(tip(h('span', { class: 'badge b-owner' }, t.transferKind === 'owner_draw' ? 'משיכה מהעסק' : 'הזרמה לעסק'), TIP.owner));
    } else if (t.effectiveScope === 'business') {
      const share = t.businessShare != null && t.businessShare < 100 ? ` ${t.businessShare}%` : '';
      out.push(h('span', { class: 'badge b-biz' }, `עסק${share}`));
    }
    if (isNum(t.fullAmount)) out.push(tip(h('span', { class: 'badge b-split' }, 'חלק מהסכום'), `הסכום המלא בתנועה: ${moneyText(t.fullAmount, { decimals: 2 })}. כאן מוצג רק החלק של הצד הזה.`));
  }
  return out;
}
const isForeign = (t) => t.originalCurrency && t.originalCurrency !== 'ILS' && isNum(t.originalAmount);

export function mountTransactions(container, params) {
  let filters = pickFilters(params);
  let sort = getPref('txSort', { sort: 'date', order: 'desc' });
  let cols = { category: true, account: true, processed: false, ...getPref('txCols', {}) };
  let items = [], total = 0, sums = null, net = null, days = new Map();
  let loading = false, loadingMore = false, error = null, sel = -1;
  let rowEls = [];
  let ctrl = null, months = state.availableMonths.slice();
  const offs = [];

  /* ---------- page header: title, period, the figures ---------- */
  const periodEl = h('p', { class: 'page-sub tx-period' });
  const figs = h('div', { class: 'tx-figs', role: 'group', 'aria-label': 'סיכום התנועות שמוצגות', 'aria-live': 'polite' });
  const head = h('header', { class: 'tx-head' },
    h('div', { class: 'page-title' }, h('h1', null, 'תנועות'), periodEl),
    figs);

  /* ---------- filter bar ---------- */
  const search = h('input', { class: 'tx-search-in', type: 'search', placeholder: 'חיפוש לפי תיאור או סכום', 'aria-label': 'חיפוש תנועות', 'aria-keyshortcuts': '/', value: filters.q || '' });
  const searchWrap = h('label', { class: 'pill-field tx-search' }, icon('search'), search, h('kbd', { 'aria-hidden': 'true' }, '/'));
  const periodBox = selectBox({ label: 'תקופה', icon: 'calendar', className: 'f-period', onChange: onPeriod });
  const accBox = selectBox({ label: 'חשבון', icon: 'card', className: 'f-acc', onChange: (v) => setFilters({ accountId: v }) });
  const catBox = selectBox({ label: 'קטגוריה', icon: 'tag', className: 'f-cat', onChange: (v) => setFilters({ category: v }) });
  const dirSeg = h('div', { class: 'seg tx-dir', role: 'radiogroup', 'aria-label': 'כיוון' },
    [['', 'הכול'], ['out', 'הוצאות'], ['in', 'הכנסות']].map(([v, l]) =>
      h('label', null, h('input', { type: 'radio', name: 'tx-dir', value: v }), l)));
  // The biggest expenses first: expenses only, sorted by amount (the same sort as the amount column).
  const topBtn = h('button', { class: 'btn tool tx-top-btn', type: 'button', 'aria-pressed': 'false', dataset: { tip: 'ההוצאות הגבוהות ביותר קודם' } }, icon('arrowDown'), h('span', { class: 'tool-l' }, 'הגבוהות ביותר'));
  const colsBtn = h('button', { class: 'btn tool', type: 'button', 'aria-haspopup': 'menu', dataset: { tip: 'אילו עמודות להציג' } }, icon('table'), h('span', { class: 'tool-l' }, 'עמודות'));
  const exportA = tip(h('a', { class: 'btn tool', download: '' }, icon('download'), h('span', { class: 'tool-l' }, 'ייצוא CSV')), TIP.csv);
  const bar = h('div', { class: 'tx-bar', role: 'search', 'aria-label': 'סינון תנועות' },
    searchWrap, periodBox.el, accBox.el, catBox.el, dirSeg, topBtn,
    h('span', { class: 'grow' }),
    h('div', { class: 'tx-tools', role: 'group', 'aria-label': 'תצוגה וייצוא' }, colsBtn, exportA));
  const chips = h('div', { class: 'tx-active', role: 'list', 'aria-label': 'מסננים פעילים' });

  /* ---------- the list ---------- */
  const colgroup = h('colgroup');
  const thead = h('thead');
  const table = h('table', { class: 'grid-table tx-table', 'aria-label': 'תנועות', 'aria-rowcount': '-1' }, colgroup, thead);
  const foot = h('div', { class: 'tx-foot' });
  const scroller = h('div', { class: 'tx-sheet' }, table, foot);

  const view = h('div', { class: 'tx' }, h('div', { class: 'tx-top' }, head, bar, chips), scroller);
  container.replaceChildren(view);

  // Wide sheet: category, account (and charge date) are columns. Narrow (< 760px: a 1100px window with the
  // inspector, or 200% zoom): they fold into a sub-line under the merchant. Measured, then re-rendered.
  let narrow = false;
  const NARROW_AT = 760;
  const ro = new ResizeObserver(() => {
    const w = scroller.clientWidth;
    if (!w) return;
    const n = w < NARROW_AT;
    if (n === narrow) return;
    const hadFocus = table.contains(document.activeElement);
    narrow = n;
    view.classList.toggle('tx-narrow', narrow);
    renderHead(); renderRows();
    if (hadFocus && sel >= 0) rowEls[sel]?.focus({ preventScroll: true });
  });
  narrow = (scroller.clientWidth || 9999) < NARROW_AT;
  view.classList.toggle('tx-narrow', narrow);
  ro.observe(scroller);

  /* ---------- filter controls ---------- */
  function rangeText() {
    if (!filters.from && !filters.to) return '';
    return `${filters.from ? dateShort(filters.from) : 'ההתחלה'} – ${filters.to ? dateShort(filters.to) : 'היום'}`;
  }
  function fillFilters() {
    const ms = filters.month && !months.includes(filters.month) ? [filters.month, ...months] : months;
    const range = rangeText();
    periodBox.setOptions([
      { value: '', label: 'כל התקופות' },
      ...ms.map((m) => ({ value: m, label: monthLabel(m) })),
      { value: '__months', label: 'כמה חודשים יחד…', short: filters.months ? monthsText(filters.months.split(',')) : 'כמה חודשים', icon: 'calendar', sepBefore: true },
      { value: '__range', label: 'טווח תאריכים…', short: range || 'טווח תאריכים', icon: 'calendar' },
    ], periodValue());
    paintTop();
    accBox.setOptions([
      { value: '', label: 'כל החשבונות' },
      ...state.accounts.map((a) => ({ value: String(a.id), label: accountText(a.name), hint: a.type === 'bank' ? 'בנק' : 'כרטיס' })),
    ], filters.accountId || '');
    const catOpts = [{ value: '', label: 'כל הקטגוריות' }];
    for (const kind of ['expense', 'income', 'neutral']) {
      state.categories.filter((c) => c.kind === kind).forEach((c, i) => catOpts.push({ value: c.id, label: c.name, swatch: c.color, group: i === 0 ? KIND_GROUP[kind] : null }));
    }
    catBox.setOptions(catOpts, filters.category || '');
    for (const r of dirSeg.querySelectorAll('input')) r.checked = r.value === (filters.direction || '');
  }

  const periodValue = () => (filters.months ? '__months' : filters.from || filters.to ? '__range' : (filters.month || ''));
  function onPeriod(v) {
    if (v === '__range') { openRange(); return; }
    if (v === '__months') { openMonths(); return; }
    setFilters({ month: v, months: '', from: '', to: '' });
  }
  function openMonths() {
    periodBox.setValue(periodValue());
    const sel = filters.months ? filters.months.split(',') : filters.month ? [filters.month] : [];
    openMonthsPicker(periodBox.el, {
      available: months, selected: sel,
      onApply: (ms) => { setFilters({ months: ms.join(','), month: '', from: '', to: '' }); periodBox.el.focus(); },
    });
  }
  // Real spending only (as counted in the overview): no card-bill debits or transfers.
  const isTop = () => sort.sort === 'amount' && sort.order === 'desc' && filters.kind === 'spending';
  function paintTop() { topBtn.setAttribute('aria-pressed', String(isTop())); topBtn.classList.toggle('on', isTop()); }
  topBtn.addEventListener('click', () => {
    const on = !isTop();
    sort = on ? { sort: 'amount', order: 'desc' } : { sort: 'date', order: 'desc' };
    setPref('txSort', sort);
    renderHead();
    if (on && filters.kind !== 'spending') setFilters({ kind: 'spending', direction: '' });
    else if (!on && filters.kind === 'spending') setFilters({ kind: '' });
    else { paintTop(); load(); }
  });

  /** Date range: quick presets, or the glass range calendar. A popover anchored to the period pill. */
  function openRange() {
    // the listbox already shows "טווח"; put back what is really applied BEFORE placing the popover
    // (the pill's width changes with its text, and the popover hangs from its edge)
    periodBox.setValue(periodValue());
    const today = todayIso();
    const thisMonth = today.slice(0, 7);
    const back = (days) => { const d = new Date(); d.setDate(d.getDate() - days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const presets = [
      ['החודש', { month: thisMonth, months: '', from: '', to: '' }],
      ['החודש הקודם', { month: shiftMonth(thisMonth, -1), months: '', from: '', to: '' }],
      ['30 הימים האחרונים', { month: '', months: '', from: back(29), to: today }],
      ['3 חודשים', { month: '', months: '', from: `${shiftMonth(thisMonth, -2)}-01`, to: today }],
      ['מתחילת השנה', { month: '', months: '', from: `${today.slice(0, 4)}-01-01`, to: today }],
    ];
    const err = h('p', { class: 'error-text', role: 'alert' });
    // the calendar's bounds: the first day of the oldest month with data, and today
    const oldest = months.length ? months[months.length - 1] : null;
    const cal = rangeCalendar({ from: filters.from || '', to: filters.to || '', min: oldest ? `${oldest}-01` : '', max: today, onChange: () => { err.textContent = ''; } });
    const apply = h('button', { class: 'btn primary small', type: 'button' }, 'הצגה');
    const cancel = h('button', { class: 'btn ghost small', type: 'button' }, 'ביטול');
    const pop = openPopover(periodBox.el, {
      label: 'טווח תאריכים', className: 'range-pop',
      content: [
        h('h2', { class: 'pop-title' }, 'טווח תאריכים'),
        h('div', { class: 'range-presets', role: 'group', 'aria-label': 'טווחים מוכנים' }, presets.map(([l, patch]) => {
          const b = h('button', { class: 'btn small pchip', type: 'button' }, l);
          b.addEventListener('click', () => { pop.close(true); setFilters(patch); periodBox.el.focus(); });
          return b;
        })),
        cal.el,
        err,
        h('div', { class: 'pop-actions' }, apply, cancel),
      ],
      initialFocus: (el) => el.querySelector('.pchip'),
    });
    apply.addEventListener('click', () => {
      const v = cal.value();
      if (!v.from && !v.to) { err.textContent = 'צריך לבחור בלוח לפחות תאריך אחד.'; cal.focusGrid(); return; }
      pop.close(true);
      setFilters({ month: '', months: '', from: v.from, to: v.to });
      periodBox.el.focus();
    });
    cancel.addEventListener('click', () => pop.close());
  }

  function setFilters(patch, { replace = true } = {}) {
    const next = { ...filters, ...patch };
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] == null) delete next[k];
    filters = next;
    go('transactions', filters, { replace });
  }
  const clearAll = () => { filters = {}; search.value = ''; go('transactions', {}, { replace: true }); };

  let searchTimer;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => setFilters({ q: search.value.trim() }), 220); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; setFilters({ q: '' }); }
    else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); focusRow(Math.max(0, sel)); }
  });
  dirSeg.addEventListener('change', (e) => setFilters({ direction: e.target.value }));
  colsBtn.addEventListener('click', () => openMenu({ anchor: colsBtn }, COLS.map((c) => ({
    label: c.label, checked: Boolean(cols[c.id]),
    onSelect: () => { cols = { ...cols, [c.id]: !cols[c.id] }; setPref('txCols', cols); renderHead(); renderRows(); },
  })), { label: 'מה להציג בכל שורה' }));

  function renderChips() {
    const list = [];
    const chip = (k, v, keys) => {
      const x = h('button', { type: 'button', 'aria-label': `הסרת המסנן ${k}` }, icon('close'));
      x.addEventListener('click', () => setFilters(Object.fromEntries(keys.map((kk) => [kk, '']))));
      return h('span', { class: 'chip', role: 'listitem' }, h('span', { class: 'k' }, `${k}:`), h('bdi', null, v), x);
    };
    if (filters.from_insight) list.push(chip('מתוך מסקנה', filters.from_insight, ['from_insight', 'ids']));
    else if (filters.ids) list.push(chip('תנועות נבחרות', `${filters.ids.split(',').length}`, ['ids']));
    if (filters.q) list.push(chip('חיפוש', filters.q, ['q']));
    if (filters.month) list.push(chip('חודש', monthLabel(filters.month), ['month']));
    if (filters.months) list.push(chip(filters.months.includes(',') ? 'חודשים' : 'חודש', monthsText(filters.months.split(',')), ['months']));
    if (filters.from || filters.to) list.push(chip('תאריכים', `${filters.from ? dateFull(filters.from) : 'ההתחלה'} עד ${filters.to ? dateFull(filters.to) : 'היום'}`, ['from', 'to']));
    if (filters.accountId) list.push(chip('חשבון', accountText(state.accounts.find((a) => String(a.id) === String(filters.accountId))?.name || filters.accountId), ['accountId']));
    if (filters.category) list.push(chip('קטגוריה', categoryName(filters.category), ['category']));
    if (filters.direction) list.push(chip('כיוון', filters.direction === 'out' ? 'הוצאות' : 'הכנסות', ['direction']));
    if (filters.kind && KIND_LABEL[filters.kind]) list.push(chip('מציג', KIND_LABEL[filters.kind], ['kind']));
    if (list.length) {
      const all = h('button', { class: 'link small-link', type: 'button' }, list.length > 1 ? 'ניקוי כל המסננים' : 'ניקוי המסנן');
      all.addEventListener('click', clearAll);
      list.push(h('span', { role: 'listitem', class: 'chip-clear' }, all));
    }
    chips.replaceChildren(...list);
    chips.hidden = !list.length;
    const ms = filters.months ? filters.months.split(',').sort() : null;
    // A set of months exports the span from its first to its last month (the file has a date column).
    const span = filters.month ? monthBounds(filters.month)
      : ms ? { from: monthBounds(ms[0]).from, to: monthBounds(ms[ms.length - 1]).to } : { from: filters.from, to: filters.to };
    exportA.href = api.exportUrl(span?.from, span?.to);
  }

  function periodText() {
    if (filters.from_insight) return `מתוך מסקנה: ${filters.from_insight}`;
    if (filters.month) return monthLabel(filters.month);
    if (filters.months) return monthsText(filters.months.split(','));
    if (filters.from || filters.to) return `${filters.from ? dateFull(filters.from) : 'מההתחלה'} – ${filters.to ? dateFull(filters.to) : 'היום'}`;
    return 'כל התקופות';
  }

  /* ---------- header figures (server numbers only) ---------- */
  function renderHead2() {
    const count = loading && !items.length ? '' : total === 1 ? 'תנועה אחת' : `${intText(total)} תנועות`;
    mount(periodEl, h('span', null, periodText()), filters.kind && KIND_LABEL[filters.kind] ? [h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), h('span', null, KIND_LABEL[filters.kind])] : null,
      count ? [h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), h('span', { class: 'tx-count' }, count)] : null);
    if (error) { figs.replaceChildren(); return; }
    const fig = (k, v, cls, note) => h('div', { class: ['fig', ...[].concat(cls)] }, h('span', { class: 'fig-k' }, k), h('span', { class: 'fig-v' }, v), note ? h('span', { class: 'fig-n' }, note) : null);
    if (loading && !sums) { figs.replaceChildren(...[1, 2, 3].map(() => h('div', { class: 'fig sk-fig', 'aria-hidden': 'true' }, h('span', { class: 'sk' }), h('span', { class: 'sk' })))); return; }
    if (!sums) { figs.replaceChildren(); return; }
    if (net && (net.kind === 'spending' || net.kind === 'income')) {
      // Reconciliation with the overview: gross, minus refunds (or reversals), = the headline figure.
      const sp = net.kind === 'spending';
      mount(figs,
        fig(sp ? 'חיובים' : 'נכנס', money(net.gross, { decimals: 2 }), 'f-gross'),
        isNum(net.offsets) && net.offsets > 0 ? fig(sp ? 'החזרים' : 'קוזז', money(-net.offsets, { sign: 'always', decimals: 2 }), 'f-back') : null,
        fig(sp ? 'נטו אחרי החזרים' : 'סה״כ הכנסות', money(net.total, { decimals: 2 }), 'f-net f-main', 'כמו בסקירה'));
      return;
    }
    mount(figs,
      fig('הוצאות', money(sums.out, { decimals: 2 }), 'f-out'),
      fig('הכנסות', money(sums.in, { decimals: 2 }), 'f-in'),
      isNum(sums.net) ? fig('נטו', money(sums.net, { sign: 'always', decimals: 2 }), ['f-net', sums.net >= 0 ? 'pos' : 'neg'], sums.net >= 0 ? 'נשאר' : 'יצא יותר') : null);
  }

  /* ---------- table ---------- */
  /** The optional columns that are on, in order (wide sheet only; narrow folds them into the sub-line). */
  const extraCols = () => (narrow ? [] : COLS.map((c) => c.id).filter((id) => cols[id]));
  const nCols = () => 2 + extraCols().length;
  const COL_HEAD = { category: 'קטגוריה', account: 'חשבון', processed: 'תאריך החיוב' };
  const COL_CLASS = { category: 'cat', account: 'acc', processed: 'proc' };
  function renderHead() {
    const sortBtn = (key, label) => {
      const active = sort.sort === key;
      const b = h('button', { class: ['sort-btn', active && 'on'], type: 'button' }, label,
        icon(active ? (sort.order === 'desc' ? 'arrowDown' : 'arrowUp') : 'arrowDown', 'arrow'));
      b.addEventListener('click', () => {
        sort = active ? { sort: key, order: sort.order === 'desc' ? 'asc' : 'desc' } : { sort: key, order: 'desc' };
        setPref('txSort', sort); renderHead(); paintTop(); load();
      });
      return b;
    };
    const ariaSort = (key) => (sort.sort === key ? (sort.order === 'desc' ? 'descending' : 'ascending') : null);
    const extra = extraCols();
    mount(colgroup, h('col', { class: 'k-main' }), extra.map((c) => h('col', { class: `k-${COL_CLASS[c]}` })), h('col', { class: 'k-amt' }));
    mount(thead, h('tr', null,
      h('th', { class: 'c-main', scope: 'col', 'aria-sort': ariaSort('date') }, sortBtn('date', 'תאריך ובית עסק')),
      extra.map((c) => h('th', { class: `c-${COL_CLASS[c]}`, scope: 'col' }, COL_HEAD[c])),
      h('th', { class: 'c-amt', scope: 'col', 'aria-sort': ariaSort('amount') }, sortBtn('amount', 'סכום'))));
  }

  function amountCell(t) {
    const inflow = t.amount > 0;
    const fx = isForeign(t);
    // A pending foreign-currency charge has no shekel amount until it is billed.
    const noIls = t.status === 'pending' && t.amount === 0 && fx;
    return h('td', { class: 'c-amt' },
      h('span', { class: 'amt-wrap' },
        noIls ? h('span', { class: 'amt money-out' }, 'טרם חויב')
          : h('bdi', { class: ['num', 'amt', inflow ? 'money-in' : 'money-out'], dir: 'ltr' }, moneyText(t.amount, { sign: 'always', decimals: 2 })),
        inflow || fx ? h('span', { class: 'amt-sub' },
          inflow ? h('span', { class: 'in-word' }, t.category && categoryById(t.category)?.kind === 'expense' ? 'זיכוי' : 'נכנס') : null,
          inflow && fx ? ' · ' : null,
          fx ? h('bdi', { class: 'num', dir: 'ltr' }, foreignText(t.originalAmount, t.originalCurrency)) : null) : null));
  }

  function catButton(t, i) {
    const cat = categoryById(t.category);
    const catBtn = h('button', { class: 'cat-btn', type: 'button', tabindex: '-1', 'aria-label': `קטגוריה: ${cat?.name || 'ללא'}. לשינוי (C)` },
      h('span', { class: 'swatch', style: { background: cat?.color || 'var(--ink-4)' } }), h('span', { class: 'cat-l' }, cat?.name || 'ללא קטגוריה'), icon('chevronDown', 'caret'));
    catBtn.addEventListener('click', (e) => { e.stopPropagation(); select(i); changeCategory(i, { anchor: catBtn }); });
    return catBtn;
  }
  const procText = (t) => (t.processedDate && t.processedDate !== t.date ? `חיוב ב-${dateShort(t.processedDate)}` : '');

  function rowFor(t, i) {
    // line 1: the merchant, then its status chips. Wide: category, account and charge date are their own
    // columns. Narrow: they join a sub-line under the merchant. Sorted by amount, the date joins the sub-line.
    const sub = [];
    const extra = extraCols();
    if (narrow && cols.category) sub.push(h('span', { class: 'mi mi-cat' }, catButton(t, i)));
    if (narrow && cols.account) sub.push(h('span', { class: 'mi' }, accountLabel(t.accountName, 'sub-acc')));
    if (sort.sort === 'amount') sub.push(h('span', { class: 'mi sub-date' }, dateFull(t.date)));
    if (narrow && cols.processed && procText(t)) sub.push(h('span', { class: 'mi sub-proc' }, procText(t)));
    const cells = {
      category: () => h('td', { class: 'c-cat' }, catButton(t, i)),
      account: () => h('td', { class: 'c-acc' }, accountLabel(t.accountName, 'sub-acc')),
      processed: () => h('td', { class: 'c-proc' }, procText(t)),
    };
    const bs = badges(t);
    const tr = h('tr', {
      class: 'tx-row', tabindex: i === sel ? '0' : '-1', 'aria-selected': String(i === sel),
      dataset: { i, excluded: t.excluded ? '1' : null, cardpay: t.isCardPayment ? '1' : null, focusKey: `tx-${t.id}` },
    },
    h('td', { class: 'c-main' },
      h('div', { class: 'tx-m' },
        avatar(t),
        h('div', { class: 'tx-mt' },
          h('span', { class: 'tx-l1' }, h('bdi', { class: 'tx-name desc' }, t.description || 'ללא תיאור'), bs.length ? h('span', { class: 'badges' }, bs) : null),
          sub.length ? h('span', { class: 'tx-sub' }, sub) : null))),
    extra.map((c) => cells[c]()),
    amountCell(t));
    return tr;
  }

  const dayTitle = (iso) => {
    const today = todayIso();
    const y = new Date(); y.setDate(y.getDate() - 1);
    const yIso = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    const base = weekdayDate(iso) + (iso.slice(0, 4) !== today.slice(0, 4) ? ` ${iso.slice(0, 4)}` : '');
    return iso === today ? ['היום', base] : iso === yIso ? ['אתמול', base] : [null, base];
  };
  function dayRow(iso) {
    const d = days.get(iso);
    const [rel, title] = dayTitle(iso);
    const sums = [];
    // the number first (at the start edge, like the row amounts below), then the word after it
    if (d && d.sumOut > 0) sums.push(h('span', { class: 'ds-out' }, money(d.sumOut, { decimals: 2 }), h('span', { class: 'ds-k' }, 'יצא')));
    if (d && d.sumIn > 0) sums.push(h('span', { class: 'ds-in' }, money(d.sumIn, { decimals: 2, sign: 'always' }), h('span', { class: 'ds-k' }, 'נכנס')));
    // the day's totals sit in the amount column, right edges (₪ and decimals) in line with the rows
    return h('tr', { class: 'day-row' },
      h('th', { scope: 'rowgroup', class: 'day-t', colspan: String(nCols() - 1) },
        rel ? h('strong', null, `${rel} · `) : null, title,
        d && d.count ? h('span', { class: 'ds-n' }, d.count === 1 ? 'תנועה אחת' : `${intText(d.count)} תנועות`) : null),
      h('td', { class: 'day-s c-amt' }, sums));
  }

  function skeletonRows(n) {
    return Array.from({ length: n }, () => h('tr', { class: 'sk-row', 'aria-hidden': 'true' },
      h('td', { colspan: String(nCols()) }, h('div', { class: 'sk-line' }, h('span', { class: 'sk sk-av' }), h('span', { class: 'sk-t' }, h('span', { class: 'sk sk-a' }), h('span', { class: 'sk sk-b' })), h('span', { class: 'sk sk-amt' })))));
  }

  const txEmpty = (title, text, action) => {
    const el = emptyState({ icon: action ? 'filter' : 'list', title, text, action });
    el.classList.add('tx-empty');
    return el;
  };

  function renderRows() {
    for (const b of [...table.tBodies]) b.remove();
    rowEls = [];
    if (error) { foot.replaceChildren(errorState('לא הצלחנו לטעון את התנועות', error.message, () => load())); return; }
    if (loading && !items.length) {
      table.append(h('tbody', null, skeletonRows(10)));
      foot.replaceChildren(h('span', { class: 'sr-only', role: 'status' }, 'טוען תנועות…'));
      return;
    }
    if (!items.length) {
      const any = Object.keys(filters).length > 0;
      const btn = any ? h('button', { class: 'btn', type: 'button' }, icon('close'), 'ניקוי המסננים') : null;
      btn?.addEventListener('click', clearAll);
      foot.replaceChildren(any
        ? txEmpty('אין תנועות שמתאימות למסננים', 'אפשר להרחיב את התקופה, לבחור חשבון אחר או לנקות את המסננים.', btn)
        : txEmpty('אין עדיין תנועות', 'אחרי הסנכרון הראשון התנועות יופיעו כאן, מקובצות לפי יום.'));
      return;
    }
    const grouped = sort.sort !== 'amount';
    let body = null, lastDay = null;
    items.forEach((t, i) => {
      if (!body || (grouped && t.date !== lastDay)) {
        body = h('tbody', { class: grouped ? 'day-group' : null }, grouped ? dayRow(t.date) : null);
        table.append(body);
        lastDay = t.date;
      }
      const tr = rowFor(t, i);
      rowEls.push(tr);
      body.append(tr);
    });
    if (loadingMore) table.append(h('tbody', { class: 'sk-more' }, skeletonRows(3)));
    if (items.length < total) {
      const more = h('button', { class: 'btn small', type: 'button' }, loadingMore ? 'טוען…' : `לטעון עוד ${intText(Math.min(PAGE, total - items.length))}`);
      more.disabled = loadingMore;
      more.addEventListener('click', () => load(true));
      foot.replaceChildren(h('div', { class: 'tx-more' }, h('span', { class: 'muted' }, `מוצגות ${intText(items.length)} מתוך ${intText(total)}`), more));
      io.disconnect(); io.observe(more);
    } else foot.replaceChildren(items.length > 12 ? h('p', { class: 'tx-end' }, h('span', null, `סוף הרשימה · ${intText(total)} תנועות`)) : '');
  }

  const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting) && !loading && !loadingMore && items.length < total) load(true); }, { root: null, rootMargin: '400px' });   // the viewport: also right when the whole page scrolls (reflow)

  /* ---------- data ---------- */
  function query(offset) {
    const q = { ...filters, sort: sort.sort, order: sort.order, limit: PAGE, offset };
    delete q.from_insight;
    return q;
  }

  async function load(more = false) {
    if (more && (loading || loadingMore)) return;
    ctrl?.abort();
    ctrl = new AbortController();
    if (more) loadingMore = true; else loading = true;
    error = null;
    const keepId = !more ? items[sel]?.id : null;
    const hadFocus = !more && table.contains(document.activeElement);
    if (!more) { figs.classList.add('stale'); table.classList.add('stale'); }   // old numbers stay, dimmed, until the new ones arrive
    if (more) renderRows();                          // skeleton rows at the end while the next page loads
    else if (!items.length) { renderRows(); renderHead2(); }   // keep old rows on screen while refreshing (no flash)
    try {
      const res = await api.transactions(query(more ? items.length : 0), { signal: ctrl.signal });
      items = more ? items.concat(res.items || []) : (res.items || []);
      total = isNum(res.total) ? res.total : items.length;
      sums = { out: res.sumOut, in: res.sumIn, net: res.sumNet };
      net = res.net || null;
      if (!more) days = new Map();
      for (const d of res.days || []) days.set(d.date, d);
      rememberMerchants(items.slice(0, 60).map((t) => t.description));
      if (!more) {
        const k = keepId != null ? items.findIndex((t) => t.id === keepId) : -1;
        sel = k >= 0 ? k : items.length ? 0 : -1;
        if (k < 0) scroller.scrollTop = 0;
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      error = e;
    }
    loading = false; loadingMore = false;
    figs.classList.remove('stale'); table.classList.remove('stale');
    renderRows(); renderHead2();
    if (!more) {
      if (hadFocus && sel >= 0) rowEls[sel]?.focus({ preventScroll: true });
      if (inspecting && inspectorOpen()) { if (keepId != null && items[sel]?.id === keepId) showInspector(sel, false); else closeInspector(true); }
    }
  }

  /* ---------- selection + keyboard ---------- */
  function select(i, { focus = false } = {}) {
    if (!items.length) return;
    i = Math.max(0, Math.min(items.length - 1, i));
    const prev = rowEls[sel];
    if (prev) { prev.setAttribute('aria-selected', 'false'); prev.tabIndex = -1; }
    sel = i;
    const tr = rowEls[i];
    if (tr) {
      tr.setAttribute('aria-selected', 'true'); tr.tabIndex = 0;
      if (focus) tr.focus({ preventScroll: true });
      keepVisible(tr);
    }
    if (inspectorOpen() && inspecting) showInspector(i, false);
  }
  /** Scroll a row into view below the sticky header and its day header. */
  function keepVisible(tr) {
    if (scroller.scrollHeight <= scroller.clientHeight + 1) { tr.scrollIntoView({ block: 'nearest' }); return; }   // reflow: the page scrolls
    const sh = scroller.getBoundingClientRect();
    const r = tr.getBoundingClientRect();
    const top = sh.top + (thead.getBoundingClientRect().height || 0) + (sort.sort !== 'amount' ? 36 : 0);
    if (r.top < top) scroller.scrollTop -= top - r.top + 4;
    else if (r.bottom > sh.bottom - 6) scroller.scrollTop += r.bottom - sh.bottom + 10;
  }
  const focusRow = (i) => select(i, { focus: true });
  const rowIndex = (target) => { const tr = target.closest?.('tr.tx-row'); return tr ? Number(tr.dataset.i) : -1; };

  table.addEventListener('click', (e) => {
    const i = rowIndex(e.target);
    if (i < 0) return;
    select(i, { focus: true });
    showInspector(i, false);
  });
  table.addEventListener('dblclick', (e) => { const i = rowIndex(e.target); if (i >= 0) showInspector(i); });
  table.addEventListener('contextmenu', (e) => {
    const i = rowIndex(e.target);
    if (i < 0) return;
    e.preventDefault();
    select(i, { focus: true });
    rowMenu(i, { x: e.clientX, y: e.clientY });
  });
  /** Keyboard-opened menu: under the row's name, aligned to the row's right edge (never at 0,0). */
  const rowAnchor = (i) => {
    const tr = rowEls[i];
    if (!tr) return { anchor: scroller };
    const name = tr.querySelector('.tx-mt') || tr;
    const r = tr.getBoundingClientRect(), n = name.getBoundingClientRect();
    return { rect: new DOMRect(n.left, r.top, r.right - n.left, r.height) };
  };
  table.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr.tx-row');
    if (!tr || e.target !== tr) return;
    const i = Number(tr.dataset.i);
    if (i !== sel) select(i);   // focus reached the row without a click/arrow: keep selection in step
    const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 2);
    // Modified keys first: Ctrl+C must copy, not fall into the plain "C" (change category) case.
    // Physical key code so it also works on the Hebrew layout (where Ctrl+C reports key "ב").
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyC' || (!e.code && (e.key || '').toLowerCase() === 'c'))) { e.preventDefault(); copyAmount(i); }
      return;
    }
    const letter = /^Key[CXM]$/.test(e.code || '') && !e.shiftKey ? e.code.slice(3).toLowerCase() : null;
    switch (letter || e.key) {
      case 'ArrowDown': e.preventDefault(); focusRow(i + 1); if (i + 1 >= items.length - 5 && items.length < total) load(true); break;
      case 'ArrowUp': e.preventDefault(); if (i === 0) search.focus(); else focusRow(i - 1); break;
      case 'PageDown': e.preventDefault(); focusRow(i + page); if (i + page >= items.length - 5 && items.length < total) load(true); break;
      case 'PageUp': e.preventDefault(); focusRow(i - page); break;
      case 'Home': e.preventDefault(); focusRow(0); break;
      case 'End': e.preventDefault(); focusRow(items.length - 1); break;
      case 'Enter': case ' ': e.preventDefault(); showInspector(i, false); break;
      case 'c': case 'C': case 'ב': e.preventDefault(); changeCategory(i, rowEls[i]?.querySelector('.cat-btn') ? { anchor: rowEls[i].querySelector('.cat-btn') } : rowAnchor(i)); break;
      case 'x': case 'X': case 'ס': e.preventDefault(); toggleExclude(i); break;
      case 'm': case 'M': case 'צ': e.preventDefault(); sameMerchant(i); break;
      case 'ContextMenu': e.preventDefault(); rowMenu(i, rowAnchor(i)); break;
      case 'F10': if (e.shiftKey) { e.preventDefault(); rowMenu(i, rowAnchor(i)); } break;
      default: break;
    }
  });

  function rowMenu(i, pos) {
    const t = items[i];
    if (!t) return;
    openMenu(pos, [
      { label: 'פרטי התנועה', icon: 'info', kbd: 'Enter', onSelect: () => showInspector(i) },
      { label: 'שינוי קטגוריה…', icon: 'tag', kbd: 'C', onSelect: () => changeCategory(i, rowEls[i]?.querySelector('.cat-btn') ? { anchor: rowEls[i].querySelector('.cat-btn') } : rowAnchor(i)) },
      { label: t.excluded ? 'להחזיר לסיכומים' : 'להוציא מהסיכומים', icon: t.excluded ? 'eye' : 'eyeOff', kbd: 'X', onSelect: () => toggleExclude(i) },
      ...(state.business?.enabled ? [
        { label: 'זה של העסק', icon: 'briefcase', checked: t.effectiveScope === 'business', onSelect: () => saveBiz(i, { scope: 'business' }, 'סומן כעסקי.') },
        { label: 'זה פרטי', icon: 'home', checked: t.effectiveScope === 'private', onSelect: () => saveBiz(i, { scope: 'private' }, 'סומן כפרטי.') },
      ] : []),
      'sep',
      { label: 'כל התנועות מבית העסק הזה', icon: 'store', kbd: 'M', onSelect: () => sameMerchant(i) },
      { label: 'העתקת הסכום', icon: 'copy', kbd: `${MOD}+C`, onSelect: () => copyAmount(i) },
    ], { label: `פעולות על ${t.description || 'התנועה'}` });
  }

  function sameMerchant(i) {
    const t = items[i];
    if (!t?.description) return;
    search.value = t.description;
    filters = { q: t.description };
    go('transactions', filters, { replace: false });
  }

  async function copyAmount(i) {
    const t = items[i];
    if (!t) return;
    const text = Math.abs(t.amount).toFixed(2);
    const back = document.activeElement;
    let ok = false;
    const desk = window.finora?.clipboard;
    if (desk?.writeText) {
      // Desktop: the renderer has no clipboard permission; main writes it after validating (preload).
      try { ok = (await desk.writeText(text)) === true; } catch { ok = false; }
    } else {
      try { await navigator.clipboard.writeText(text); ok = true; } catch { /* permission denied */ }
    }
    if (!ok) {
      // Fallback without the Clipboard API permission: copy from a hidden, read-only field.
      const ta = h('textarea', { readonly: '', 'aria-hidden': 'true', tabindex: '-1', style: { position: 'fixed', top: '0', left: '0', opacity: '0', pointerEvents: 'none' } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      if (back && document.contains(back)) back.focus();
    }
    if (ok) toast(`הסכום ${moneyText(t.amount, { decimals: 2 })} הועתק`);
    else toast('לא הצלחנו להעתיק ללוח', { kind: 'error' });
  }

  function changeCategory(i, pos) {
    const t = items[i];
    if (!t) return;
    pickCategory(pos, { current: t.category, onPick: (cat) => saveCategory(i, cat) });
  }

  /** Same merchant, other rows: ask with the real number. Default = only this row. null = cancelled. */
  async function askSimilar(t, cat) {
    let sim = null;
    try { sim = await api.similarTransactions(t.id, cat); } catch { return 'one'; }
    if (!sim || !isNum(sim.count) || sim.count < 1) return 'one';
    const n = sim.count;
    const merchant = sim.merchant || t.description || '';
    const others = n === 1 ? 'תנועה דומה אחת' : `${intText(n)} תנועות דומות`;
    return choiceDialog({
      title: [`להחיל גם על ${others} מ-`, h('bdi', null, merchant), '?'],
      message: [`התנועה הזו תעבור ל"${categoryName(cat)}". אפשר להעביר גם את ${n === 1 ? 'התנועה האחרת' : `${intText(n)} התנועות האחרות`} מ-`, h('bdi', null, merchant), ', ולזכור את הבחירה לתנועות שיגיעו בהמשך.'],
      extra: h('p', { class: 'hint' }, 'אפשר לבטל אחר כך בכפתור "ביטול" בהודעה או ב-Ctrl+Z.'),
      choices: [
        { value: 'one', label: 'רק התנועה הזו', primary: true },
        { value: 'all', label: n === 1 ? 'גם על הדומה' : `גם על ${intText(n)} הדומות` },
      ],
      initial: 'one',
    });
  }

  async function saveCategory(i, cat) {
    const t = items[i];
    if (!t || cat === t.category) return;
    const choice = await askSimilar(t, cat);
    if (!choice) { rowEls[i]?.focus({ preventScroll: true }); return; }
    const applyToSimilar = choice === 'all';
    try {
      const res = await api.updateTransaction(t.id, { category: cat, applyToSimilar });
      const j = items.findIndex((x) => x.id === t.id);
      if (j >= 0) items[j] = { ...items[j], ...res };
      const name = categoryName(cat);
      const extra = isNum(res?.affected) && res.affected > 0 ? ` וגם ${res.affected === 1 ? 'תנועה דומה אחת' : `${intText(res.affected)} תנועות דומות`}` : '';
      offerUndo(`הקטגוריה עודכנה ל"${name}"${extra}.`, res?.undoId, t.id);
      if (extra) await load(); else if (j >= 0) replaceRow(j);
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }

  /** Toast with "ביטול" + Ctrl+Z: the server reverts the rows (and the merchant rule). */
  function offerUndo(message, undoId, focusId) {
    if (!undoId) { toast(message); return; }
    let closeToast = null;
    const run = async () => {
      closeToast?.();   // the "ביטול" offer is spent (also when undone with Ctrl+Z)
      try {
        const r = await api.undoChange(undoId);
        await load();
        const k = items.findIndex((x) => x.id === focusId);
        if (k >= 0 && !document.querySelector('.layer-scrim')) focusRow(k);
        toast(r?.restored > 1 ? `השינוי בוטל (${intText(r.restored)} תנועות חזרו למצבן הקודם).` : 'השינוי בוטל.');
      } catch (e) { toast(e.message, { kind: 'error' }); }
    };
    const drop = registerUndo(message, run);
    closeToast = toast(message, { timeout: 8000, action: { label: 'ביטול', kbd: 'Control+Z', hint: 'לביטול: Control+Z.', onSelect: () => { drop(); run(); } } });
  }

  async function toggleExclude(i) {
    const t = items[i];
    if (!t) return;
    const next = !t.excluded;
    try {
      const res = await api.updateTransaction(t.id, { excluded: next });
      const j = items.findIndex((x) => x.id === t.id);   // by id: the list may have been re-sorted or reloaded since
      if (j >= 0) { items[j] = { ...items[j], ...res, excluded: res?.excluded ?? next }; replaceRow(j); }
      load();   // totals change; rows and selection are kept
      offerUndo(next ? 'התנועה הוצאה מהסיכומים.' : 'התנועה הוחזרה לסיכומים.', res?.undoId, t.id);
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }

  /** Business fields of a row (scope, share, owner transfer, invoice, no VAT). */
  async function saveBiz(i, patch, okText) {
    const t = items[i];
    if (!t) return;
    try {
      const res = await api.updateTransaction(t.id, patch);
      const j = items.findIndex((x) => x.id === t.id);
      // The list is in a lens: refresh the shown amount only through a reload (a split row's part).
      if (j >= 0) { items[j] = { ...items[j], ...res, amount: items[j].amount, fullAmount: items[j].fullAmount }; replaceRow(j); }
      load();
      if (okText) toast(okText);
    } catch (e) { toast(e.message, { kind: 'error' }); }
  }

  function replaceRow(i) {
    const old = rowEls[i];
    if (!old) return;
    const nr = rowFor(items[i], i);
    const hadFocus = document.activeElement === old;
    old.replaceWith(nr);
    rowEls[i] = nr;
    if (hadFocus) nr.focus({ preventScroll: true });
    if (inspectorOpen() && inspecting && sel === i) showInspector(i, false);
  }

  /* ---------- inspector ---------- */
  let inspecting = false;
  function showInspector(i, focus = true) {
    const t = items[i];
    if (!t) return;
    inspecting = true;
    // Re-rendering an open inspector (after a toggle or category change) must not drop keyboard focus.
    const ae = document.activeElement;
    const keepKey = ae?.closest?.('.inspector') ? (ae.dataset.k || 'panel') : null;
    const cat = categoryById(t.category);
    const inflow = t.amount > 0;
    const row = (k, v) => (v === null || v === undefined || v === '' ? null : h('div', { class: 'dl-row' }, h('dt', null, k), h('dd', null, v)));
    const catBtn = h('button', { class: 'insp-cat', type: 'button', dataset: { k: 'cat' }, 'aria-haspopup': 'dialog' },
      h('span', { class: 'swatch', style: { background: cat?.color || 'var(--ink-4)' } }),
      h('span', { class: 'ic-l' }, h('span', { class: 'ic-name' }, cat?.name || 'ללא קטגוריה'), h('span', { class: 'ic-src' }, SOURCE_LABEL[t.categorySource] || '')),
      h('kbd', { 'aria-hidden': 'true' }, 'C'), icon('chevronDown', 'caret'));
    catBtn.setAttribute('aria-label', `קטגוריה: ${cat?.name || 'ללא קטגוריה'}. ${SOURCE_LABEL[t.categorySource] || ''}. לשינוי`);
    catBtn.addEventListener('click', () => changeCategory(i, { anchor: catBtn }));
    const exclId = `excl-${t.id}`;
    const excl = h('input', { type: 'checkbox', role: 'switch', id: exclId, checked: !t.excluded, dataset: { k: 'excl' }, 'aria-describedby': `${exclId}-d` });
    excl.addEventListener('change', () => toggleExclude(i));
    const action = (k, ic, label, kbd, fn) => h('button', { class: 'insp-act', type: 'button', dataset: { k }, onclick: fn }, icon(ic), h('span', null, label), h('kbd', { 'aria-hidden': 'true' }, kbd));
    const bs = badges(t, { fx: false });
    const headNodes = [
      avatar(t, 'av-lg'),
      h('div', { class: 'ih-t' },
        h('h2', null, h('bdi', null, t.description || 'תנועה')),
        h('p', { class: 'ih-sub' }, dateFull(t.date), h('span', { class: 'dot', 'aria-hidden': 'true' }, '·'), accountLabel(t.accountName))),
    ];
    const content = [
      h('div', { class: ['insp-amount', inflow ? 'is-in' : 'is-out'] },
        h('span', { class: 'ia-k' }, inflow ? (cat?.kind === 'expense' ? 'זיכוי · נכנס לחשבון' : 'נכנס לחשבון') : 'יצא מהחשבון'),
        h('bdi', { class: ['num', 'ia-v', inflow ? 'money-in' : 'money-out'], dir: 'ltr' }, moneyText(t.amount, { sign: 'always', decimals: 2 })),
        isForeign(t) ? h('span', { class: 'ia-fx' }, 'במקור ', h('bdi', { class: 'num', dir: 'ltr' }, foreignText(t.originalAmount, t.originalCurrency))) : null,
        bs.length ? h('span', { class: 'badges' }, bs) : null),
      t.isCardPayment ? h('p', { class: 'insp-note' }, 'זו שורת החיוב החודשי של כרטיס האשראי בחשבון הבנק. כל העסקאות שבתוכה כבר מופיעות בנפרד מהכרטיס, ולכן היא לא נספרת בהוצאות, כדי שלא נספור את אותו כסף פעמיים.') : null,
      h('section', { class: 'insp-sec', 'aria-labelledby': 'is-cat' },
        h('h3', { class: 'insp-h', id: 'is-cat' }, 'קטגוריה'),
        catBtn),
      h('section', { class: 'insp-sec', 'aria-labelledby': 'is-det' },
        h('h3', { class: 'insp-h', id: 'is-det' }, 'פרטים'),
        h('dl', { class: 'insp-dl' },
          row('תאריך העסקה', weekdayDate(t.date) + (t.date ? ` ${t.date.slice(0, 4)}` : '')),
          row('ירד מהחשבון', t.processedDate && t.processedDate !== t.date ? dateFull(t.processedDate) : null),
          row('חשבון', accountLabel(t.accountName)),
          row('מצב', t.status === 'pending' ? 'ממתין לקליטה סופית' : 'נקלט'),
          row('תשלומים', t.installments && isNum(t.installments.total) ? `תשלום ${t.installments.number} מתוך ${t.installments.total}` : null),
          row('סכום מקורי', isForeign(t) ? h('bdi', { class: 'num', dir: 'ltr' }, foreignText(t.originalAmount, t.originalCurrency)) : null),
          row('הערה', t.memo ? h('bdi', null, t.memo) : null))),
      state.business?.enabled ? bizSection(t, i) : null,
      h('div', { class: 'insp-switch' },
        h('label', { class: 'switch', for: exclId }, h('span', { class: 'sw-l' }, 'נספרת בסיכומים ובמסקנות'), excl),
        h('p', { class: 'hint', id: `${exclId}-d` }, t.excluded ? 'כבוי: התנועה לא נכללת בסכומים, בתחזית ובמסקנות.' : 'פועל: התנועה נכללת בסכומים, בתחזית ובמסקנות.', ' ', h('span', { 'aria-hidden': 'true' }, '(X)'))),
      h('div', { class: 'insp-actions', role: 'group', 'aria-label': 'פעולות' },
        action('merchant', 'store', 'כל התנועות מבית העסק', 'M', () => sameMerchant(i)),
        action('copy', 'copy', 'העתקת הסכום', `${MOD}+C`, () => copyAmount(i))),
    ];
    const panel = openInspector({ title: t.description || 'תנועה', head: headNodes, content, label: 'פרטי התנועה', onClose: () => { inspecting = false; rowEls[sel]?.focus(); } });
    if (keepKey) (panel.querySelector(`[data-k="${keepKey}"]`) || panel).focus({ preventScroll: true });
    else if (focus) panel.querySelector('.insp-body button, .insp-body input')?.focus({ preventScroll: true });
  }

  function bizSection(t, i) {
    const owner = t.transferKind === 'owner_draw' || t.transferKind === 'owner_injection';
    const scope = t.effectiveScope || 'private';
    const inherited = !t.scope;
    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'של מי התנועה', dataset: { k: 'scope' } },
      [['business', 'עסק'], ['private', 'פרטי']].map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(scope === v),
        class: scope === v ? 'on' : null, dataset: { k: `scope-${v}` }, disabled: owner,
        onclick: () => { if (scope !== v || inherited) saveBiz(i, { scope: v, applyToMerchant: always.checked }); } }, l)));
    const always = h('input', { type: 'checkbox', dataset: { k: 'always' }, checked: t.ruleScope != null && t.ruleScope === scope });
    always.addEventListener('change', () => saveBiz(i, { scope: always.checked ? scope : null, applyToMerchant: true },
      always.checked ? `מעכשיו: כל התנועות מבית העסק הזה ${scope === 'business' ? 'עסקיות' : 'פרטיות'}.` : 'הכלל לבית העסק הוסר.'));
    const share = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(t.businessShare ?? 100), dataset: { k: 'share' }, 'aria-label': 'אחוז עסקי' });
    const shareOut = h('output', { class: 'num' }, `${t.businessShare ?? 100}%`);
    share.addEventListener('input', () => { shareOut.textContent = `${share.value}%`; });
    share.addEventListener('change', () => saveBiz(i, { businessShare: Number(share.value) === 100 ? null : Number(share.value) }));
    const inv = h('input', { type: 'checkbox', dataset: { k: 'invoice' }, checked: t.invoice });
    inv.addEventListener('change', () => saveBiz(i, { invoice: inv.checked }));
    const noVat = h('input', { type: 'checkbox', dataset: { k: 'novat' }, checked: t.noVat });
    noVat.addEventListener('change', () => saveBiz(i, { noVat: noVat.checked }));
    const kind = h('select', { class: 'input', dataset: { k: 'owner' } },
      [['', 'רגילה'], ['owner_draw', 'משיכה מהעסק לפרטי'], ['owner_injection', 'הזרמה מהפרטי לעסק']].map(([v, l]) => h('option', { value: v, selected: (owner ? t.transferKind : '') === v }, l)));
    kind.addEventListener('change', () => saveBiz(i, { transferKind: kind.value || 'none' }));
    const src = owner ? null : inherited ? (t.ruleScope ? 'לפי הכלל לבית העסק' : 'לפי החשבון') : 'נקבע על ידך';
    return h('section', { class: 'insp-sec insp-biz', 'aria-labelledby': 'is-biz' },
      h('h3', { class: 'insp-h', id: 'is-biz' }, 'עסק או פרטי', src ? h('span', { class: 'insp-h-sub' }, ` · ${src}`) : null),
      owner ? h('p', { class: 'insp-note' }, 'העברה בינך לבין העסק: לא נספרת כהוצאה או כהכנסה של אף צד.') : seg,
      !owner ? h('label', { class: 'check' }, always, 'תמיד, לכל התנועות מבית העסק הזה') : null,
      !owner && scope === 'business' && t.amount < 0 ? h('div', { class: 'insp-share' },
        h('label', { class: 'field-label' }, 'חלק עסקי (למשל רכב או טלפון בשימוש משותף)'), h('div', { class: 'share-row' }, share, shareOut)) : null,
      !owner && scope === 'business' && state.business.type !== 'exempt' ? h('div', { class: 'insp-checks' },
        h('label', { class: 'check' }, inv, 'יש חשבונית מס'),
        h('label', { class: 'check' }, noVat, 'בלי מע"מ (ביטוח, משכורת, ארנונה…)')) : null,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'סוג'), kind));
  }

  /* ---------- lifecycle ---------- */
  async function ensureMonths() {
    if (months.length) return;
    try { const sm = await api.summary(); months = sm.availableMonths || []; state.availableMonths = months; fillFilters(); } catch { /* months stay empty */ }
  }

  function applyParams(p) {
    filters = pickFilters(p);
    if (document.activeElement !== search) search.value = filters.q || '';
    setWhere('transactions', filters.month ? monthLabel(filters.month) : filters.from_insight ? 'מתוך מסקנה' : null);
    fillFilters(); renderChips(); renderHead(); renderHead2(); load();
  }

  offs.push(on('reference', () => { fillFilters(); renderRows(); }));
  offs.push(on('data-changed', () => load()));
  applyParams(params);
  ensureMonths();

  return {
    update: applyParams,
    destroy() { ctrl?.abort(); io.disconnect(); ro.disconnect(); offs.forEach((f) => f()); periodBox.close(); accBox.close(); catBox.close(); if (inspecting) closeInspector(true); },
    focusSearch() { search.focus(); search.select(); },
    refresh: () => load(),
    exportCsv() { exportA.click(); },
  };
}

function pickFilters(p) {
  const f = {};
  for (const k of FILTER_KEYS) if (p[k] !== undefined && p[k] !== '') f[k] = String(p[k]);
  return f;
}

export { hrefFor };
