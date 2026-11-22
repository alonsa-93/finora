// סקירה. The first screen answers "where do I stand right now?" (views/position.js): the bank balance,
// the credit cards, how both moved over the picked months (apart), and the red flags with what to do.
// The spending of a period (the hero with its pace and forecast), all conclusions, categories,
// merchants, accounts, the calendar and 12 months sit under "לעומק", closed by default and remembered.
import { h, s, icon, sevMark, sevGlyph, mount, avatarOf } from '../dom.js';
import { api } from '../api.js';
import { state, rememberMerchants, on } from '../store.js';
import { go } from '../router.js';
import { setWhere } from '../shell.js';
import { startSync } from '../sync.js';
import { cumulativeChart, monthlyChart, chartPanel, legend } from '../charts.js';
import {
  isNum, money, moneyText, pctText, monthLabel, monthName, shiftMonth, dateLong, dateShort, relativeTime, intText, parseDate, todayIso, daysUntil, accountLabel, } from '../format.js';
import { syncLine, monthStepper, errorState, pageHead } from './common.js';
import { selectBox } from '../listbox.js';
import { openPopover } from '../layers.js';
import { rangeCalendar } from '../rangecal.js';
import { openMonthsPicker, monthsText } from '../monthpick.js';
import { getPref, setPref } from '../prefs.js';
import { positionSection } from './position.js';

// The dashboard's period: one calendar month (this one, or one picked), a rolling window, the year
// so far, several months picked together, or a date range. It lives in the URL.
const PERIOD_OPTIONS = [
  { value: 'mtd', label: 'מתחילת החודש' },
  { value: 'm1', label: 'חודש אחרון', hint: '30 יום אחורה' },
  { value: 'm3', label: '3 חודשים אחרונים' },
  { value: 'ytd', label: 'מתחילת השנה' },
  { value: 'y1', label: 'שנה אחרונה', hint: '12 חודשים' },
  { value: 'month', label: 'חודש מסוים…', sepBefore: true },
  { value: 'months', label: 'כמה חודשים יחד…' },
  { value: 'range', label: 'טווח תאריכים…' },
];
const PRESET = new Set(['m1', 'm3', 'ytd', 'y1']);
function pickPeriod(p = {}) {
  if (PRESET.has(p.period)) return { period: p.period };
  if (p.months) return { months: String(p.months) };
  if (p.from || p.to) return { ...(p.from ? { from: p.from } : {}), ...(p.to ? { to: p.to } : {}) };
  if (p.month) return { month: p.month };
  return {};
}
const periodKey = (q) => (q.period || (q.months ? 'months' : q.from || q.to ? 'range' : q.month ? 'month' : 'mtd'));
/** Name of a longer period, for sentences and the header. */
function periodName(sm) {
  const p = sm.period || {};
  switch (p.kind) {
    case 'm1': return 'החודש האחרון';
    case 'm3': return '3 החודשים האחרונים';
    case 'y1': return 'השנה האחרונה';
    case 'ytd': return `${p.from.slice(0, 4)} עד היום`;
    case 'months': return monthsText(p.months);
    default: return `${dateLong(p.from)} – ${dateLong(p.to)}`;
  }
}
const prevPeriodName = (sm) => (sm.period?.kind === 'months' ? 'אותם חודשים בשנה הקודמת' : 'התקופה הקודמת');
/** Transactions behind a figure: the same month, months or dates. */
function txOf(sm, extra = {}) {
  if (sm.mode !== 'period') return { month: sm.month, ...extra };
  if (sm.period.kind === 'months') return { months: sm.period.months.join(','), ...extra };
  return { from: sm.period.from, to: sm.period.to, ...extra };
}
import { openConnectDialog } from './connect.js';

const KIND_LABEL = { recurring: 'חיוב קבוע', installment: 'תשלום', cardCharge: 'חיוב כרטיס אשראי' };
const WEEKDAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const fmtWeekday = new Intl.DateTimeFormat('he-IL', { weekday: 'long' });
const fmtMonthYear = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' });
const fmtMonthShort = new Intl.DateTimeFormat('he-IL', { month: 'short' });

/** Time-of-day greeting. No name: MoneyCash does not know it. */
function greeting(d = new Date()) {
  const hr = d.getHours();
  if (hr >= 5 && hr < 12) return 'בוקר טוב';
  if (hr >= 12 && hr < 17) return 'צהריים טובים';
  if (hr >= 17 && hr < 22) return 'ערב טוב';
  return 'לילה טוב';
}

export function mountOverview(container, params) {
  let q = pickPeriod(params);
  // Coming back to the overview without a period keeps the month that was on screen.
  if (!Object.keys(q).length && state.month && state.month !== todayIso().slice(0, 7)) q = { month: state.month };
  let month = q.month || null;
  let ctrl = null;
  const offs = [];

  const view = h('div', { class: 'ov' });
  container.replaceChildren(view);
  // "Where do I stand" loads once and keeps its own months; the spending period below does not reload it.
  const pos = positionSection();

  async function load() {
    ctrl?.abort();
    ctrl = new AbortController();
    const signal = ctrl.signal;
    renderSkeleton();
    let summary, insights = null, insightsError = null;
    try {
      const isPeriod = q.period || q.months || q.from || q.to;
      [summary, insights] = await Promise.all([
        api.summary(isPeriod ? q : (month || undefined), { signal }),
        // Conclusions are monthly: for a longer period, the ones for this month.
        api.insights(isPeriod ? undefined : (month || undefined), { signal }).catch((e) => { if (e.name === 'AbortError') throw e; insightsError = e; return null; }),
      ]);
    } catch (e) {
      if (e.name === 'AbortError') return;
      mount(view, header(null), h('div', { class: 'page ov-pad' }, errorState('לא הצלחנו לטעון את הסקירה', e.message, load)));
      return;
    }
    if (signal.aborted) return;
    if (summary.mode !== 'period') { month = summary.month; state.month = month; }
    state.availableMonths = summary.availableMonths || [];
    rememberMerchants((summary.topMerchants || []).map((m) => m.description));
    setWhere('overview', summary.mode === 'period' ? periodName(summary) : monthLabel(summary.month));
    render(summary, insights, insightsError);
  }

  /* ---------- greeting header ---------- */
  function header() {
    const now = new Date();
    return pageHead(greeting(now), `${fmtWeekday.format(now)}, ${dateLong(todayIso())}`, syncLine());
  }

  /** The period of the spending part (under "לעומק"). */
  function periodBar(summary) {
    const months = summary?.availableMonths || state.availableMonths || [];
    const m = month || summary?.month;
    const sub = summary?.mode === 'period' ? periodName(summary)
      : summary && !summary.isCurrentMonth ? monthLabel(m) : 'החודש הנוכחי';
    return h('div', { class: 'ov-deep-head' },
      h('h2', { class: 'ov-deep-title' }, 'הוצאות והכנסות', h('span', { class: 'sub' }, sub)),
      h('span', { class: 'grow' }),
      h('div', { class: 'ov-period' },
        periodPicker(summary, months),
        periodKey(q) === 'month' ? monthStepper({ month: m, months, onChange: (x) => go('overview', { month: x }) }) : null));
  }

  function periodPicker(summary, months) {
    const key = periodKey(q);
    const shortFor = {
      months: q.months ? monthsText(q.months.split(',')) : null,
      range: q.from || q.to ? `${q.from ? dateShort(q.from) : 'ההתחלה'} – ${q.to ? dateShort(q.to) : 'היום'}` : null,
    };
    const box = selectBox({
      label: 'תקופה בסקירה', icon: 'calendar', className: 'ov-pbox',
      options: PERIOD_OPTIONS.map((o) => (shortFor[o.value] ? { ...o, short: shortFor[o.value] } : o)),
      value: key,
      onChange: (v) => {
        if (v === 'mtd') { state.month = null; go('overview', {}); }
        else if (PRESET.has(v)) go('overview', { period: v });
        else if (v === 'month') go('overview', { month: summary?.mode !== 'period' && summary?.month ? summary.month : (months[0] || todayIso().slice(0, 7)) });
        else if (v === 'months') {
          box.setValue(key);
          const sel = q.months ? q.months.split(',') : q.month ? [q.month] : [];
          openMonthsPicker(box.el, {
            available: months, selected: sel, title: 'אילו חודשים להציג',
            onApply: (ms) => go('overview', ms.length === 1 ? { month: ms[0] } : { months: ms.join(',') }),
          });
        } else if (v === 'range') { box.setValue(key); openRange(box); }
      },
    });
    return box.el;
  }

  function openRange(box) {
    const months = state.availableMonths || [];
    const oldest = months.length ? months[months.length - 1] : null;
    const err = h('p', { class: 'error-text', role: 'alert' });
    const cal = rangeCalendar({ from: q.from || '', to: q.to || '', min: oldest ? `${oldest}-01` : '', max: todayIso(), onChange: () => { err.textContent = ''; } });
    const apply = h('button', { class: 'btn primary small', type: 'button' }, 'הצגה');
    const cancel = h('button', { class: 'btn ghost small', type: 'button' }, 'ביטול');
    const pop = openPopover(box.el, {
      label: 'טווח תאריכים', className: 'range-pop',
      content: [h('h2', { class: 'pop-title' }, 'טווח תאריכים'), cal.el, err, h('div', { class: 'pop-actions' }, apply, cancel)],
    });
    apply.addEventListener('click', () => {
      const v = cal.value();
      if (!v.from && !v.to) { err.textContent = 'צריך לבחור בלוח לפחות תאריך אחד.'; cal.focusGrid(); return; }
      pop.close(true);
      go('overview', { ...(v.from ? { from: v.from } : {}), ...(v.to ? { to: v.to } : {}) });
    });
    cancel.addEventListener('click', () => pop.close());
  }

  function renderSkeleton() {
    const sk = (st) => h('div', { class: 'sk', style: st });
    mount(view, header(null), h('div', { class: 'page ov-pad', 'aria-busy': 'true' },
      h('span', { class: 'sr-only', role: 'status' }, 'טוען את הסקירה…'),
      pos.el));
  }

  function render(sm, insights, insightsError) {
    const t = sm.totals || {};
    // The deeper sections are built only when opened (and kept while the page lives).
    const deepBody = h('div', { class: 'ov-deep-body', id: 'ov-deep' });
    let deepOpen = getPref('ovDeep', false);
    const toggle = h('button', { class: 'ov-deep-toggle', type: 'button', 'aria-controls': 'ov-deep' });
    const paintDeep = () => {
      toggle.setAttribute('aria-expanded', String(deepOpen));
      mount(toggle, h('span', { class: 'odt-t' }, deepOpen ? 'הסתרת הפרטים' : 'לעומק'),
        h('span', { class: 'odt-s' }, 'הוצאות התקופה וקצב ההוצאה, כל המסקנות, קטגוריות, בתי עסק, חשבונות, חיובים צפויים ו-12 חודשים'),
        icon('chevronDown', deepOpen ? 'odt-ico open' : 'odt-ico'));
      deepBody.hidden = !deepOpen;
      if (deepOpen && !deepBody.childElementCount) mount(deepBody, deepSections(sm, insights, insightsError));
    };
    toggle.addEventListener('click', () => { deepOpen = !deepOpen; setPref('ovDeep', deepOpen); paintDeep(); });
    paintDeep();
    mount(view, header(sm), h('div', { class: 'page ov-pad' },
      noDataNotice(sm),
      pos.el,
      h('section', { class: 'ov-deep', 'aria-label': 'פרטים נוספים' }, toggle, deepBody)));
  }

  function deepSections(sm, insights, insightsError) {
    const t = sm.totals || {};
    return [
      periodBar(sm),
      h('div', { class: 'ov-top' }, heroCard(sm, t), attentionPanel(insights, insightsError, sm)),
      summaryRow(sm, t),
      h('div', { class: 'ov-row' },
        insightsPanel(insights, insightsError, sm),
        h('div', { class: 'ov-side' }, paceBlock(sm), accountsPanel(sm))),
      h('div', { class: 'ov-row ov-where' }, categoriesPanel(sm), merchantsPanel(sm)),
      h('div', { class: 'ov-row' },
        chartPanel({
          title: 'הכנסות מול הוצאות',
          sub: '12 החודשים האחרונים, הישן מימין. לחיצה על חודש פותחת אותו',
          className: 'ov-months',
          legend: legend([['k-in', 'הכנסות'], ['k-out', 'הוצאות']]),
          chart: monthlyChart({ monthly: sm.monthly || [], selected: sm.mode === 'period' ? null : sm.month, onPick: (m) => go('overview', { month: m }) }),
        }),
        upcomingCard(sm)),
    ];
  }

  /* ---------- what to look at: the top three conclusions, no more ---------- */
  function attentionPanel(list, err, sm) {
    const all = Array.isArray(list) ? list : [];
    const rank = { alert: 0, warning: 1, info: 2, good: 3 };
    const top = [...all].sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2)).slice(0, 3);
    let body;
    if (err) body = h('p', { class: 'empty-line' }, 'לא הצלחנו לטעון את המסקנות.');
    else if (!top.length) body = h('p', { class: 'att-ok' }, sevMark('good'), h('span', null, 'אין כרגע משהו שדורש תשומת לב. ההוצאות בטווח הרגיל שלך.'));
    else {
      body = h('ul', { class: 'att-list' }, top.map((it) => {
        const act = it.action && it.action.filter ? it.action : null;
        const open = act ? () => {
          const f = { ...act.filter };
          if (Array.isArray(f.ids)) f.ids = f.ids.join(',');
          f.from_insight = it.title;
          go('transactions', f);
        } : null;
        const inner = [h('span', { class: 'att-mark' }, sevMark(it.severity)), h('span', { class: 'att-t' }, it.title || ''), open ? icon('chevron', 'att-go') : null];
        return h('li', { dataset: { sev: it.severity || 'info' } },
          open ? h('button', { class: 'att-row', type: 'button', onclick: open, title: act.label || 'הצג תנועות' }, inner) : h('div', { class: 'att-row' }, inner));
      }));
    }
    const more = all.length > top.length ? h('button', { class: 'link att-more', type: 'button', onclick: () => openDeep('ins-h') }, `כל ${intText(all.length)} המסקנות`) : null;
    return h('section', { class: 'panel att-panel', 'aria-labelledby': 'att-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'att-h' }, 'כדאי לבדוק')),
      sm.mode === 'period' ? h('p', { class: 'panel-sub' }, 'לפי החודש הנוכחי') : null,
      body, more);
  }

  /** Open the deeper sections (if closed) and move to one of them. */
  function openDeep(headingId) {
    const tg = view.querySelector('.ov-deep-toggle');
    if (tg && tg.getAttribute('aria-expanded') !== 'true') tg.click();
    const el = view.querySelector(`#${headingId}`);
    if (el) { el.setAttribute('tabindex', '-1'); el.scrollIntoView({ block: 'start', behavior: 'smooth' }); el.focus({ preventScroll: true }); }
  }

  /* ---------- three supporting numbers: money in the bank, money in, money still to go out ---------- */
  function summaryRow(sm, t) {
    const b = sm.balances || {};
    const P = sm.mode === 'period';
    const cur = !P && sm.isCurrentMonth;
    const prevName = P ? prevPeriodName(sm) : monthName(shiftMonth(sm.month, -1));
    const cards = [];

    const banks = (b.accounts || []).filter((a) => a.type === 'bank');
    const bankHas = isNum(b.bankTotal);
    let bankNote = null;
    if (bankHas && isNum(b.upcomingCardCharges) && b.upcomingCardCharges > 0) {
      const after = b.bankTotal - b.upcomingCardCharges;
      bankNote = after >= 0
        ? ['אחרי חיובי האשראי יישארו ', money(after, { decimals: 0 })]
        : [h('strong', { class: 'neg-t' }, 'חסרים '), money(Math.abs(after), { decimals: 0 }), ' לכיסוי חיובי האשראי'];
    }
    cards.push(kpi({
      id: 'bank', ico: 'bank', label: 'יתרה בבנק היום',
      value: bankHas ? money(b.bankTotal, { sign: 'negative', decimals: 0 }) : h('span', { class: 'kpi-none' }, 'אין חשבון בנק מחובר'),
      foot: bankNote ? h('p', { class: 'kpi-note' }, bankNote) : null,
      neg: bankHas && b.bankTotal < 0,
      open: banks.length === 1 ? () => go('transactions', txOf(sm, { accountId: banks[0].accountId })) : null,
      openLabel: 'תנועות בחשבון הבנק',
    }));

    const incomeNote = isNum(t.prevIncome)
      ? (cur ? [`כל ${prevName}: `, money(t.prevIncome, { decimals: 0 })] : [`ב${prevName}: `, money(t.prevIncome, { decimals: 0 })])
      : null;
    cards.push(kpi({
      id: 'income', ico: 'arrowDownIn', label: P ? 'נכנס בתקופה' : cur ? 'נכנס החודש' : `נכנס ב${monthName(sm.month)}`,
      value: money(t.income, { decimals: 0 }),
      foot: incomeNote ? h('p', { class: 'kpi-note' }, incomeNote) : null,
      open: () => go('transactions', txOf(sm, { kind: 'income' })), openLabel: 'התנועות שמרכיבות את ההכנסות',
    }));

    const ups = [...(sm.upcoming || [])].filter((u) => isNum(u.amount) && parseDate(u.expectedDate))
      .sort((a, c) => String(a.expectedDate).localeCompare(String(c.expectedDate)));
    const upTotal = ups.reduce((s, u) => s + u.amount, 0);
    const next = ups[0];
    cards.push(kpi({
      id: 'cards', ico: 'calendar', label: 'צפוי לרדת בחודש הקרוב',
      value: ups.length ? money(upTotal, { decimals: 0 }) : h('span', { class: 'kpi-none' }, P && !sm.isCurrent ? 'רק לתקופה שמסתיימת היום' : 'לא זוהו חיובים'),
      foot: next ? h('p', { class: 'kpi-note' }, 'הבא: ', h('bdi', null, accountLabel(next.description)), ` · ${daysUntil(next.expectedDate)} · `, money(next.amount, { decimals: 0 })) : null,
      open: ups.length ? () => openDeep('up-h') : null, openLabel: 'כל החיובים הצפויים',
    }));
    return h('section', { class: 'ov-kpis ov-sum', 'aria-label': 'מספרים עיקריים' }, cards);
  }

  /** Live slot: repainted on sync/reference events so "sync now" turns into "syncing…" and then into the result. */
  let noticeSlot = null, noticeSm = null;
  function noDataNotice(sm) {
    noticeSm = sm;
    noticeSlot = h('div', { class: 'notice-slot' });
    paintNotice();
    return noticeSlot;
  }
  function paintNotice() {
    if (!noticeSlot || !noticeSm) return;
    const n = noticeContent(noticeSm);
    noticeSlot.replaceChildren(...(n ? [n] : []));
  }

  /** Connected but nothing pulled yet: say why, and what to do. */
  function noticeContent(sm) {
    // Demo: say so where the numbers are, with the one next step (connecting a real account).
    if (state.status?.demoMode) {
      return h('div', { class: 'notice demo-notice', role: 'note' },
        h('span', null, 'אלה נתוני הדגמה, לא הכסף שלך. כשתחבר בנק או כרטיס, ההדגמה תיסגר והסקירה תתמלא בנתונים שלך.'),
        h('button', { class: 'btn small primary', type: 'button', onclick: () => openConnectDialog() }, icon('plus'), 'חיבור חשבון אמיתי'));
    }
    const empty = !(sm.monthly || []).some((m) => (m.income || 0) > 0 || (m.expenses || 0) > 0) && !(sm.balances?.accounts || []).length;
    if (!empty) return null;
    const failed = state.connections.filter((c) => c.lastStatus === 'error');
    let text, action;
    if (state.sync?.running) text = 'הסנכרון הראשון רץ עכשיו. הנתונים יופיעו כאן כשהוא יסתיים.';
    else if (failed.length) {
      text = `עוד אין נתונים, כי הסנכרון נכשל: ${failed[0].lastError || 'שגיאה לא ידועה.'}`;
      action = h('button', { class: 'btn small', type: 'button', onclick: () => go('settings') }, 'לחשבונות');
    } else {
      text = 'עוד אין נתונים. אחרי הסנכרון הראשון הסקירה תתמלא.';
      action = h('button', { class: 'btn small', type: 'button', onclick: () => startSync() }, icon('sync'), 'סנכרן עכשיו');
    }
    return h('div', { class: ['notice', failed.length && !state.sync?.running ? 'bad' : null], role: 'status' }, h('span', null, text), action);
  }

  /* ---------- the coral hero: the month's figure, its sentence, the ring ---------- */
  function heroCard(sm, t) {
    const P = sm.mode === 'period';
    // the figure is whole shekels on the first screen; agorot live in the transactions
    const cur = sm.isCurrentMonth;
    const spendLabel = P ? 'הוצאת בתקופה' : cur ? 'הוצאת עד היום' : `הוצאת ב${monthName(sm.month)}`;
    const tag = P
      ? `${periodName(sm)} · ${sm.days === 1 ? 'יום אחד' : `${intText(sm.days)} ימים`}`
      : cur
        ? `${monthName(sm.month)} · יום ${intText(sm.dayOfMonth)} מתוך ${intText(sm.daysInMonth)}`
        : `${monthLabel(sm.month)} · חודש שהסתיים`;
    return h('section', { class: 'hero calm', 'aria-labelledby': 'hero-h' },
      h('div', { class: 'hero-main' },
        h('p', { class: 'hero-tag' }, h('span', { class: 'hero-tag-dot', 'aria-hidden': 'true' }), tag),
        h('h2', { class: 'hero-label', id: 'hero-h' }, spendLabel),
        h('p', { class: 'hero-figure' }, money(t.expenses, { decimals: 0 })),
        h('p', { class: 'hero-sentence' }, changeSentence(sm, t)),
        forecastSentence(sm),
        paceBar(sm, t),
        h('div', { class: 'hero-actions' },
          h('button', { class: 'pill-solid', type: 'button', onclick: () => go('transactions', txOf(sm, { kind: 'spending' })) },
            P ? 'לכל ההוצאות בתקופה' : `לכל ההוצאות של ${monthName(sm.month)}`, icon('chevron')))));
  }

  /** A slim bar instead of a ring (amounts read better as length): spent so far against the
   * forecast for the month, or against the comparison period. */
  function paceBar(sm, t) {
    const f = sm.forecast;
    let base = null, label = null;
    if (sm.mode === 'period') {
      if (isNum(t.prevExpenses) && t.prevExpenses > 0) { base = t.prevExpenses; label = [`מ${prevPeriodName(sm)} (`, money(base, { decimals: 0 }), ')']; }
    } else if (isNum(f?.projectedExpenses) && f.projectedExpenses > 0) {
      base = f.projectedExpenses; label = ['מהצפי לחודש (', money(base, { decimals: 0 }), ')'];
    } else if (isNum(t.prevExpenses) && t.prevExpenses > 0) {
      base = t.prevExpenses; label = [`מכל ${monthName(shiftMonth(sm.month, -1))} (`, money(base, { decimals: 0 }), ')'];
    }
    if (!base || !isNum(t.expenses)) return null;
    const pct = (t.expenses / base) * 100;
    return h('div', { class: 'hero-pace' },
      h('div', { class: 'hp-bar', role: 'img', 'aria-label': `${pctText(pct)} ${label.filter((x) => typeof x === 'string').join('')}` },
        h('span', { class: ['hp-fill', pct > 100 ? 'over' : null], style: { width: `${Math.max(2, Math.min(100, pct))}%` } })),
      h('p', { class: 'hp-label', 'aria-hidden': 'true' }, h('bdi', { class: 'num' }, pctText(pct)), ' ', label));
  }

  function changeSentence(sm, t) {
    const p = t.expensesChangePct;
    if (sm.mode === 'period') {
      const pn = prevPeriodName(sm);
      if (!isNum(p)) return `אין מספיק נתונים על ${pn} כדי להשוות.`;
      const ref = isNum(t.prevExpenses) ? [' (', money(t.prevExpenses, { decimals: 0 }), ')'] : [];
      if (Math.abs(p) < 3) return [`בערך כמו ב${pn}`, ...ref, '.'];
      const up = p > 0;
      return [h('strong', { class: up ? 'up' : 'down' }, h('span', { class: 'dir-ico', 'aria-hidden': 'true' }, icon(up ? 'arrowUp' : 'arrowDown')), `${up ? 'יותר' : 'פחות'} ב-`, h('bdi', { class: 'num' }, pctText(p))), ` מאשר ב${pn}`, ...ref, '.'];
    }
    // `monthly` always holds 12 entries (empty months are zeros), so "first month" = oldest available month.
    const months = sm.availableMonths || [];
    const isFirst = !months.length || months[months.length - 1] === sm.month;
    if (!isNum(p)) return isFirst ? 'זה החודש הראשון שיש לנו עליו נתונים, אז עוד אין למה להשוות.' : 'אין נתונים מהחודש הקודם להשוואה.';
    const base = sm.isCurrentMonth ? t.prevExpensesSameDay : t.prevExpenses;
    const prev = shiftMonth(sm.month, -1);
    const [py, pm] = prev.split('-').map(Number);
    const dd = Math.min(sm.dayOfMonth || 1, new Date(py, pm, 0).getDate());
    const when = sm.isCurrentMonth ? `עד ${dateLong(`${prev}-${String(dd).padStart(2, '0')}`)}` : `ב${monthName(prev)}`;
    const ref = isNum(base) ? [' (', money(base, { decimals: 0 }), ')'] : [];
    if (Math.abs(p) < 3) return [`בערך כמו ${sm.isCurrentMonth ? 'באותה נקודה בחודש שעבר' : `ב${monthName(prev)}`}`, ...ref, '.'];
    const up = p > 0;
    return [h('strong', { class: up ? 'up' : 'down' }, h('span', { class: 'dir-ico', 'aria-hidden': 'true' }, icon(up ? 'arrowUp' : 'arrowDown')), `${up ? 'יותר' : 'פחות'} ב-`, h('bdi', { class: 'num' }, pctText(p))), ` מאשר ${when}`, ...ref, '.'];
  }

  function forecastSentence(sm) {
    const f = sm.forecast;
    if (sm.mode === 'period' || !sm.isCurrentMonth) return null;
    if (!f || !isNum(f.low) || !isNum(f.high)) return h('p', { class: 'hero-forecast' }, 'צפי לסוף החודש יופיע אחרי כמה ימים של נתונים.');
    return h('p', { class: 'hero-forecast' }, 'בקצב הזה החודש ייסגר בין ', money(f.low, { decimals: 0 }), ' ל-', money(f.high, { decimals: 0 }), '.');
  }

  function kpi({ id, ico, label, value, chip, foot, open, openLabel, neg }) {
    const lid = `kpi-${id}`;
    return h('article', { class: ['kpi', 'panel', open ? 'is-link' : null, neg ? 'neg' : null], 'aria-labelledby': lid },
      h('div', { class: 'kpi-top' },
        h('span', { class: ['kpi-ico', `ki-${id}`], 'aria-hidden': 'true' }, icon(ico)),
        chip ? h('span', { class: ['kpi-chip', `kc-${chip.kind}`] }, chip.icon ? icon(chip.icon) : null, chip.text) : null),
      h('h3', { class: 'kpi-label', id: lid }, label),
      h('p', { class: 'kpi-value' }, neg ? h('span', { class: 'kpi-neg-ico', 'aria-hidden': 'true' }, sevGlyph('alert')) : null, value),
      foot ? h('div', { class: 'kpi-foot' }, foot) : null,
      open ? h('button', { class: 'kpi-hit', type: 'button', onclick: open, 'aria-label': openLabel, title: openLabel }) : null);
  }

  /* ---------- pace of spending (cumulative chart) ---------- */
  function paceBlock(sm) {
    if (sm.mode === 'period' && !sm.daily) {
      return chartPanel({
        title: 'חודש אחר חודש', sub: `הכנסות והוצאות בכל חודש בתקופה${(sm.periodMonthly || []).length > 1 ? ', הישן מימין' : ''}`,
        className: 'pace-panel',
        legend: legend([['k-in', 'הכנסות'], ['k-out', 'הוצאות']]),
        chart: monthlyChart({ monthly: sm.periodMonthly || [], selected: null, onPick: (m) => go('overview', { month: m }) }),
      });
    }
    if (sm.mode === 'period') {
      const chart = cumulativeChart({ daily: sm.daily, forecast: null, isCurrentMonth: false, dayOfMonth: sm.days, nowLabel: 'התקופה', prevLabel: prevPeriodName(sm), height: 210 });
      return h('section', { class: 'panel pace-panel', 'aria-labelledby': 'pace-h' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'pace-h' }, 'קצב ההוצאה')),
        h('p', { class: 'panel-sub' }, `מצטבר לפי יום בתקופה, מול ${prevPeriodName(sm)}`),
        chart.el);
    }
    const cur = sm.isCurrentMonth;
    const prevName = monthName(shiftMonth(sm.month, -1));
    const chart = cumulativeChart({
      daily: sm.daily || [], forecast: sm.forecast, isCurrentMonth: cur, dayOfMonth: sm.dayOfMonth,
      nowLabel: cur ? 'החודש' : monthName(sm.month), prevLabel: prevName,
      height: 210,
    });
    const body = h('div', { id: 'cum-body' }, chart.el);
    let showTable = false;
    const toggle = h('button', { class: 'btn ghost small', type: 'button', 'aria-controls': 'cum-body', 'aria-pressed': 'false' }, icon('table'), 'טבלה');
    toggle.addEventListener('click', () => {
      showTable = !showTable;
      body.replaceChildren(showTable ? h('div', { class: 'chart-table' }, chart.table) : chart.el);
      toggle.setAttribute('aria-pressed', String(showTable));
    });
    return h('section', { class: 'panel pace-panel', 'aria-labelledby': 'pace-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'pace-h' }, 'קצב ההוצאה'), h('span', { class: 'grow' }), toggle),
      h('p', { class: 'panel-sub' }, `מצטבר לפי יום, מול ${prevName}`),
      body);
  }

  /* ---------- insights ---------- */
  function insightsPanel(list, err, sm) {
    let body;
    let more = null;
    if (err) body = errorState('לא הצלחנו לטעון את המסקנות', err.message, load);
    else if (!Array.isArray(list) || !list.length) body = h('p', { class: 'empty-line ins-empty' }, sevMark('good'), ` אין ב${sm.mode === 'period' ? 'חודש הנוכחי' : monthName(sm.month)} משהו שדורש תשומת לב. ההוצאות בטווח הרגיל שלך.`);
    else {
      const TOP = 3;
      const top = list.slice(0, TOP), rest = list.slice(TOP);
      body = h('ol', { class: 'ins-list' }, top.map((it) => insightItem(it, false)));
      if (rest.length) {
        const restList = h('ol', { class: 'ins-list ins-rest', id: 'ins-rest', start: String(TOP + 1) });
        let open = false;
        const label = () => (open ? 'בלי ההסברים' : `הסבר מלא ל${rest.length === 1 ? 'מסקנה הנוספת' : `-${intText(rest.length)} המסקנות הנוספות`}`);
        const paint = () => restList.replaceChildren(...rest.map((it) => insightItem(it, !open)));
        paint();
        const toggle = h('button', { class: 'link ins-more', type: 'button', 'aria-controls': 'ins-rest', 'aria-expanded': 'false' }, label());
        toggle.addEventListener('click', () => {
          open = !open; paint();
          toggle.setAttribute('aria-expanded', String(open));
          toggle.textContent = label();
        });
        more = [restList, toggle];
      }
    }
    const count = Array.isArray(list) ? list.filter((i) => i.severity === 'alert' || i.severity === 'warning').length : 0;
    return h('section', { class: 'panel ins-panel', 'aria-labelledby': 'ins-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'ins-h' }, 'מסקנות'),
        count ? h('span', { class: 'badge b-coral' }, `${count === 1 ? 'דבר אחד' : `${intText(count)} דברים`} לבדוק`) : null),
      sm.mode === 'period' ? h('p', { class: 'panel-sub' }, 'המסקנות הן לחודש הנוכחי') : null,
      body, more);
  }

  /** What the insight's `amount` means, per type (see server/insights.js). Unknown types show no figure. */
  function keyFigure(it) {
    if (!isNum(it.amount)) return null;
    const L = {
      lowBalance: 'חסר לכיסוי', duplicateCharge: 'כל אחד מהחיובים', priceIncrease: 'תוספת לכל חיוב',
      categorySpike: 'מעל הרגיל', categoryDrop: 'פחות מהרגיל', unusualCharge: 'החיוב', newMerchant: 'הוצאה',
      feeCharge: 'עמלות', forecast: 'צפי לחודש', subscription: 'בשנה',
    };
    if (it.type === 'savingsRate') return { label: it.amount >= 0 ? 'נשאר' : 'חסר', value: Math.abs(it.amount) };
    return L[it.type] ? { label: L[it.type], value: it.amount } : null;
  }

  function insightItem(it, compact) {
    const act = it.action && it.action.filter ? it.action : null;
    const open = () => {
      const f = { ...act.filter };
      if (Array.isArray(f.ids)) f.ids = f.ids.join(',');
      f.from_insight = it.title;
      go('transactions', f);
    };
    const tid = `ins-${String(it.id || Math.random()).replace(/[^\w-]/g, '')}`;
    const kf = compact ? null : keyFigure(it);
    return h('li', { class: ['ins', compact ? 'compact' : null], dataset: { sev: it.severity || 'info' } },
      h('div', { class: 'ins-mark' }, sevMark(it.severity)),
      h('div', { class: 'ins-body' },
        h('h3', { id: tid }, it.title || ''),
        !compact && it.body ? h('p', null, it.body) : null),
      h('div', { class: 'ins-side' },
        kf ? h('p', { class: 'ins-fig' }, h('span', { class: 'k' }, kf.label), money(kf.value, { decimals: 'auto' })) : null,
        act ? (compact
          ? h('button', { class: 'btn small ghost icon ins-act icon-only', type: 'button', onclick: open, 'aria-label': act.label || 'הצג תנועות', title: act.label || 'הצג תנועות', 'aria-describedby': tid }, icon('chevron'))
          : h('button', { class: 'btn small accent ins-act', type: 'button', onclick: open, 'aria-describedby': tid }, h('span', null, act.label || 'הצג תנועות'), icon('chevron'))) : null));
  }

  /* ---------- upcoming: a calendar card ---------- */
  function upcomingCard(sm) {
    const items = [...(sm.upcoming || [])].filter((u) => parseDate(u.expectedDate))
      .sort((a, b) => String(a.expectedDate).localeCompare(String(b.expectedDate)));
    const total = items.reduce((acc, i) => acc + (isNum(i.amount) ? i.amount : 0), 0);
    const today = parseDate(todayIso());
    const dec = items.some((i) => isNum(i.amount) && Math.round(Math.abs(i.amount) * 100) % 100 !== 0) ? 2 : 0;

    const ul = h('ul', { class: 'up-list' });
    const SHOW = window.innerHeight < 780 ? 2 : 3;   // short windows: keep the conclusions closer to the fold
    const fill = (all) => {
      const shown = all ? items : items.slice(0, SHOW);
      ul.replaceChildren(...shown.map((u, i) => upRow(u, i === 0)));
      if (!all && items.length > shown.length) {
        const more = h('button', { class: 'link', type: 'button' }, `ועוד ${items.length - shown.length} חיובים`);
        more.addEventListener('click', () => {
          fill(true);
          const first = ul.children[SHOW]?.querySelector('.up-desc');
          first?.setAttribute('tabindex', '-1'); first?.focus();
        });
        ul.append(h('li', { class: 'more' }, more));
      }
    };
    function upRow(u, isNext) {
      const d = parseDate(u.expectedDate);
      const days = d && today ? Math.round((d - today) / 86400000) : null;
      const soon = isNum(days) && days >= 0 && days <= 7 ? (days === 0 ? 'היום' : days === 1 ? 'מחר' : `בעוד ${days} ימים`) : null;
      return h('li', { class: isNext ? 'next' : null },
        h('span', { class: 'up-date' }, h('b', { class: 'num' }, String(d.getDate())), h('span', null, fmtMonthShort.format(d))),
        h('span', { class: 'up-desc', title: u.description || '' },
          accountLabel(u.description, 'up-name'),
          h('span', { class: 'up-kind' }, [isNext ? 'הבא בתור' : null, KIND_LABEL[u.kind] || null, soon].filter(Boolean).join(' · '))),
        h('span', { class: 'amt-r' }, money(u.amount, { decimals: dec })));
    }
    fill(false);

    return h('section', { class: 'panel cal', 'aria-labelledby': 'up-h' },
      h('div', { class: 'cal-head' },
        h('div', { class: 'cal-title' },
          h('h2', { id: 'up-h' }, 'צפוי לרדת'),
          items.length ? h('p', { class: 'cal-total' }, 'סה״כ ', money(total, { decimals: 0 })) : null),
        h('div', { class: 'cal-date' },
          h('b', { class: 'num' }, String(today.getDate())),
          h('span', null, h('span', { class: 'cal-wd' }, fmtWeekday.format(today)), h('span', { class: 'cal-my' }, fmtMonthYear.format(today))))),
      miniCalendar(items, today),
      items.length ? ul : h('p', { class: 'empty-line' }, 'לא זיהינו חיובים שצפויים לרדת בימים הקרובים.'));
  }

  /** Four weeks from this week's Sunday; a dot marks a day with an expected charge. The list below carries the details. */
  function miniCalendar(items, today) {
    const byDay = new Map();
    for (const u of items) { const k = String(u.expectedDate).slice(0, 10); byDay.set(k, [...(byDay.get(k) || []), u]); }
    const start = new Date(today); start.setDate(today.getDate() - today.getDay());
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cells = [];
    for (let i = 0; i < 28; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const k = iso(d);
      const ups = byDay.get(k);
      const past = d < today;
      const isToday = k === iso(today);
      const label = d.getDate() === 1 ? `1 ${fmtMonthShort.format(d)}` : String(d.getDate());
      cells.push(h('span', {
        class: ['cd', past ? 'past' : null, isToday ? 'today' : null, ups ? 'has' : null, d.getDate() === 1 ? 'first' : null],
        title: ups ? `${dateLong(k)}: ${ups.map((u) => `${u.description || ''} ${moneyText(u.amount)}`).join(', ')}` : null,
      }, h('span', { class: 'cd-n' }, label), ups ? h('span', { class: 'cd-dot' }) : null));
    }
    return h('div', { class: 'cal-grid', 'aria-hidden': 'true' },
      WEEKDAYS.map((w) => h('span', { class: 'cd-wd' }, w)), cells);
  }

  /* ---------- accounts ---------- */
  function accountsPanel(sm) {
    const acc = sm.balances?.accounts || [];
    return h('section', { class: 'panel', 'aria-labelledby': 'acc-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'acc-h' }, 'חשבונות')),
      acc.length ? h('ul', { class: 'rows acc-list' }, acc.map((a) => h('li', null,
        h('button', { class: 'row-btn acc-row', type: 'button', onclick: () => go('transactions', txOf(sm, { accountId: a.accountId })) },
          avatarOf(a.name, { iconName: a.type === 'bank' ? 'bank' : 'card' }),
          h('span', { class: 'acc-name' }, accountLabel(a.name)),
          a.type === 'bank'
            ? [h('span', { class: 'acc-k' }, 'יתרה'), h('span', { class: 'amt-r' }, money(a.balance, { sign: 'negative', decimals: 0 }))]
            : [h('span', { class: 'acc-k' }, sm.mode === 'period' ? 'בתקופה' : 'החודש'), h('span', { class: 'amt-r' }, money(a.monthSpend, { decimals: 0 }))]))))
        : h('p', { class: 'empty-line' }, 'אין חשבונות מחוברים.', ' ', h('button', { class: 'link', type: 'button', onclick: () => go('settings', { add: 1 }) }, 'לחבר חשבון')));
  }

  /* ---------- categories ---------- */
  function categoriesPanel(sm) {
    const cats = sm.byCategory || [];
    const total = sm.totals?.expenses || cats.reduce((acc, c) => acc + (c.amount || 0), 0);
    // one scale for amount bars and average ticks, so "above / below usual" is visible at a glance
    const ref = (c) => (sm.mode === 'period' ? c.prevAmount : c.avg3m);
    const scaleMax = Math.max(1, ...cats.map((c) => Math.max(c.amount || 0, isNum(ref(c)) ? ref(c) : 0)));
    let expanded = false;
    const tbody = h('tbody');
    const fill = () => {
      const rows = expanded ? cats : cats.slice(0, 8);
      tbody.replaceChildren(...rows.map((c) => catRow(c, total, scaleMax, sm)));
    };
    fill();
    const more = cats.length > 8 ? h('button', { class: 'link', type: 'button' }, `הצג את כל ${cats.length} הקטגוריות`) : null;
    more?.addEventListener('click', () => { expanded = !expanded; fill(); more.textContent = expanded ? 'הצג פחות' : `הצג את כל ${cats.length} הקטגוריות`; });
    return h('section', { class: 'panel cat-panel', 'aria-labelledby': 'cat-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'cat-h' }, 'לאן הלך הכסף')),
      h('p', { class: 'panel-sub' }, sm.mode === 'period' ? `לפי קטגוריה. הקו הדק הוא ${prevPeriodName(sm)}` : 'לפי קטגוריה. הקו הדק הוא הממוצע של 3 החודשים הקודמים'),
      cats.length ? h('table', { class: 'grid-table cat-table' },
        h('thead', null, h('tr', null, h('th', null, 'קטגוריה'), h('th', { class: 'bar-cell' }, h('span', { class: 'sr-only' }, 'סכום מול ההשוואה')), h('th', { class: 'num-col' }, 'סכום'), h('th', null, sm.mode === 'period' ? 'מול התקופה הקודמת' : 'מול הממוצע'))),
        tbody) : h('p', { class: 'empty-line' }, sm.mode === 'period' ? 'אין הוצאות בתקופה הזו.' : 'אין הוצאות בחודש הזה.'),
      more);
  }

  function catRow(c, total, scaleMax, sm) {
    const share = total > 0 ? (c.amount / total) * 100 : 0;
    const open = () => go('transactions', txOf(sm, { category: c.category }));
    const w = Math.max(0.6, Math.min(100, ((c.amount || 0) / scaleMax) * 100));
    const refV = sm.mode === 'period' ? c.prevAmount : c.avg3m;
    const avg = isNum(refV) && refV > 0 ? Math.min(100, (refV / scaleMax) * 100) : null;
    const tr = h('tr', { tabindex: '0', title: `תנועות בקטגוריה ${c.name}` },
      h('td', { class: 'cat-cell' }, h('span', { class: 'cat-name' }, h('span', { class: 'swatch', style: { background: c.color || 'var(--ink-4)' } }), c.name || ''),
        h('span', { class: 'cat-count' }, h('bdi', { class: 'num' }, `${share < 1 && share > 0 ? '<1' : Math.round(share)}%`), ' מההוצאות · ', c.count === 1 ? 'עסקה אחת' : `${intText(c.count)} עסקאות`)),
      h('td', { class: 'bar-cell', 'aria-hidden': 'true' },
        h('span', { class: 'cat-bar' },
          h('span', { class: 'fill', style: { width: `${w}%`, '--c': c.color || 'var(--ink-3)' } }),
          avg !== null ? h('span', { class: 'avg', style: { insetInlineStart: `${avg}%` } }) : null)),
      h('td', { class: 'num-col' }, money(c.amount, { decimals: 0 })),
      h('td', null, sm.mode === 'period' ? vsAvg({ ...c, avg3m: c.prevAmount }, { isNew: 'חדש בתקופה', k: 'קודמת', none: sm.totals?.prevExpenses == null }) : vsAvg(c)));
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return tr;
  }

  function vsAvg(c, { isNew = 'חדש החודש', k = 'ממוצע', none = false } = {}) {
    if (none) return h('span', { class: 'delta same' }, h('span', { class: 'delta-main' }, 'אין להשוואה'));
    if (!isNum(c.avg3m) || c.avg3m <= 0) return h('span', { class: 'delta new' }, isNew);
    const p = ((c.amount - c.avg3m) / c.avg3m) * 100;
    const avgNote = h('span', { class: 'delta-avg' }, `${k} `, money(c.avg3m, { decimals: 0 }));
    if (Math.abs(p) < 10) return h('span', { class: 'delta same' }, h('span', { class: 'delta-main' }, 'כרגיל'), avgNote);
    const up = p > 0;
    const ratio = c.amount / c.avg3m;
    const text = up && ratio >= 2
      ? ['פי ', h('bdi', { class: 'num' }, ratio >= 10 ? intText(Math.round(ratio)) : ratio.toFixed(1))]
      : [up ? 'יותר ב-' : 'פחות ב-', h('bdi', { class: 'num' }, pctText(p))];
    return h('span', { class: ['delta', up ? 'up' : 'down'], title: `ממוצע 3 חודשים: ${moneyText(c.avg3m)}` },
      h('span', { class: 'delta-main' }, icon(up ? 'arrowUp' : 'arrowDown'), ...text), avgNote);
  }

  /* ---------- merchants ---------- */
  function merchantsPanel(sm) {
    const ms = (sm.topMerchants || []).slice(0, 8);
    const max = Math.max(1, ...ms.map((m) => m.amount || 0));
    return h('section', { class: 'panel', 'aria-labelledby': 'mer-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'mer-h' }, 'בתי עסק מובילים')),
      ms.length ? h('ol', { class: 'rows mer-list' }, ms.map((m) => h('li', null,
        h('button', { type: 'button', class: 'row-btn mer-row', onclick: () => go('transactions', txOf(sm, { q: m.description })) },
          avatarOf(m.description),
          h('span', { class: 'mer-name' }, h('span', { class: 'mer-line' }, h('bdi', null, m.description || ''), h('span', { class: 'mer-count' }, m.count === 1 ? 'פעם אחת' : `${intText(m.count)} פעמים`)),
            h('span', { class: 'mer-bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.max(1, ((m.amount || 0) / max) * 100)}%` } }))),
          h('span', { class: 'amt-r' }, money(m.amount, { decimals: 0 }))))))
        : h('p', { class: 'empty-line' }, sm.mode === 'period' ? 'אין בתי עסק בתקופה הזו.' : 'אין עדיין בתי עסק בחודש הזה.'));
  }

  offs.push(on('data-changed', () => { pos.reload(); load(); }));
  offs.push(on('sync', paintNotice), on('reference', paintNotice));
  load();

  return {
    update(p) {
      const next = pickPeriod(p);
      if (JSON.stringify(next) === JSON.stringify(q)) return;
      q = next; month = q.month || null;
      load();
    },
    destroy() { ctrl?.abort(); offs.forEach((f) => f()); },
    refresh: load,
    prevMonth() { if (!month && periodKey(q) !== 'mtd') return; const cur = month || todayIso().slice(0, 7); const i = state.availableMonths.indexOf(cur); const m = state.availableMonths[i + 1]; if (m) go('overview', { month: m }); },
    nextMonth() { if (!month) return; const i = state.availableMonths.indexOf(month); const m = state.availableMonths[i - 1]; if (i > 0 && m) go('overview', { month: m }); },
  };
}

export { relativeTime };
