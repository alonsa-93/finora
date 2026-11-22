// The first screen of the overview: where do I stand right now.
//  1. the bank balance now          2. the credit cards now (what is charged and not yet paid)
//  3. how both moved over the picked months: bank and cards apart, each with its own chart
//  4. red flags with what to do about them, then the other insights
// Data: GET /api/position (server/position.js).
import { h, icon, sevMark, mount } from '../dom.js';
import { api } from '../api.js';
import { state } from '../store.js';
import { go } from '../router.js';
import { isNum, money, monthLabel, dateLong, daysUntil, relativeTime, intText } from '../format.js';
import { chartPanel, legend } from '../charts.js';
import { balanceChart, cardBillChart } from '../charts-position.js';
import { openMonthsPicker, monthsText } from '../monthpick.js';
import { getPref, setPref } from '../prefs.js';

const SPANS = [3, 6, 12];

/** The picked months: a preset span (3 / 6 / 12, the default 6) or months picked one by one. */
function readPick() {
  const p = getPref('posPick', 6);
  if (Array.isArray(p) && p.length) return { months: p };
  return { span: SPANS.includes(p) ? p : 6 };
}
function monthsOf(pick, today) {
  if (pick.months) return pick.months;
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  return Array.from({ length: pick.span }, (_, i) => {
    const t = y * 12 + (m - 1) - (pick.span - 1 - i);
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  });
}

const open = (filter, title) => {
  const f = { ...filter };
  if (Array.isArray(f.ids)) f.ids = f.ids.join(',');
  if (title) f.from_insight = title;
  go('transactions', f);
};

export function positionSection() {
  const root = h('div', { class: 'pos' });
  let pick = readPick();
  let ctrl = null;

  async function load() {
    ctrl?.abort();
    ctrl = new AbortController();
    const today = new Date().toISOString().slice(0, 10);
    // First load: a skeleton. A reload (another period, new data): the current content stays,
    // dimmed, and the section keeps its height until the new one is in, so the page never
    // shrinks under the reader and jumps back to the top.
    const reload = root.childElementCount > 0 && !root.querySelector('.sk');
    if (reload) {
      root.style.minHeight = `${root.offsetHeight}px`;
      root.classList.add('is-loading');
      root.setAttribute('aria-busy', 'true');
    } else mount(root, skeleton());
    const done = () => { root.style.minHeight = ''; root.classList.remove('is-loading'); root.removeAttribute('aria-busy'); };
    let p;
    try {
      p = await api.position(monthsOf(pick, today), { signal: ctrl.signal });
    } catch (e) {
      if (e.name === 'AbortError') return;
      done();
      mount(root, h('section', { class: 'panel' }, h('p', { class: 'empty-line' }, `לא הצלחנו לטעון את המצב הנוכחי. ${e.message || ''}`)));
      return;
    }
    const focusKey = document.activeElement?.closest?.('.pos')?.contains(document.activeElement) ? document.activeElement.textContent?.trim() : null;
    mount(root, nowRow(p), trends(p), flags(p));
    done();
    // Keep the keyboard where it was (the period button that was pressed).
    if (focusKey) [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === focusKey)?.focus({ preventScroll: true });
  }

  function skeleton() {
    const sk = (hgt) => h('div', { class: 'sk', style: { height: hgt, borderRadius: '22px' } });
    return [h('span', { class: 'sr-only', role: 'status' }, 'טוען את המצב הנוכחי…'),
      h('div', { class: 'pos-now' }, sk('210px'), sk('210px')), h('div', { class: 'pos-trends' }, sk('320px'), sk('320px'))];
  }

  /* ---------- 1 + 2: the balances now ---------- */
  function nowRow(p) {
    return h('section', { class: 'pos-now', 'aria-label': 'המצב עכשיו' }, bankNow(p), cardsNow(p));
  }

  function bankNow(p) {
    const b = p.bank;
    if (!b.hasData) {
      return h('section', { class: 'pos-card pos-bank hero calm', 'aria-labelledby': 'pb-h' },
        h('h2', { class: 'hero-label', id: 'pb-h' }, 'יתרה בבנק'),
        h('p', { class: 'pos-none' }, 'אין עדיין חשבון בנק מחובר.'));
    }
    const ch = b.changeThisMonth;
    const after = p.afterCards;
    return h('section', { class: 'pos-card pos-bank hero calm', 'aria-labelledby': 'pb-h' },
      h('p', { class: 'hero-tag' }, h('span', { class: 'hero-tag-dot', 'aria-hidden': 'true' }),
        b.asOf ? `עודכן ${relativeTime(b.asOf)}` : 'יתרה בבנק'),
      h('h2', { class: 'hero-label', id: 'pb-h' }, 'יתרה בבנק עכשיו'),
      h('p', { class: ['hero-figure', b.current < 0 ? 'neg' : null] }, money(b.current, { sign: 'negative', decimals: 0 })),
      h('ul', { class: 'pos-facts' },
        isNum(ch) ? h('li', null, h('span', null, 'מתחילת החודש'), money(ch, { sign: 'always', decimals: 0 })) : null,
        isNum(after) ? h('li', { class: after < 0 ? 'bad' : null }, h('span', null, after < 0 ? 'חסר לכיסוי חיובי האשראי' : 'אחרי חיובי האשראי הקרובים'),
          money(Math.abs(after), { decimals: 0 })) : null),
      b.accounts.length > 1 ? h('ul', { class: 'pos-list' }, b.accounts.map((a) => h('li', null,
        h('bdi', null, a.name), money(a.balance, { sign: 'negative', decimals: 0 })))) : null,
      h('div', { class: 'hero-actions' },
        h('button', { class: 'pill-solid', type: 'button', onclick: () => go('transactions', b.accounts.length === 1 ? { accountId: b.accounts[0].id } : {}) },
          'תנועות הבנק', icon('chevron'))));
  }

  function cardsNow(p) {
    const c = p.cards;
    if (!c.hasData) {
      return h('section', { class: 'panel pos-card pos-cards', 'aria-labelledby': 'pc-h' },
        h('h2', { id: 'pc-h' }, 'כרטיסי אשראי'),
        h('p', { class: 'pos-none' }, 'אין עדיין כרטיס אשראי מחובר.'));
    }
    const vsNormal = isNum(c.average) && c.average > 0 && isNum(c.thisMonth)
      ? (c.thisMonth > c.average * 1.1 ? 'up' : c.thisMonth < c.average * 0.9 ? 'down' : 'same') : null;
    return h('section', { class: 'panel pos-card pos-cards', 'aria-labelledby': 'pc-h' },
      h('p', { class: 'pos-tag' }, icon('card'), 'כרטיסי אשראי'),
      h('h2', { class: 'pos-label', id: 'pc-h' }, 'חיובים שעוד לא ירדו מהבנק'),
      h('p', { class: 'pos-figure' }, money(c.current, { decimals: 0 })),
      h('ul', { class: 'pos-facts' },
        c.nextChargeDate ? h('li', null, h('span', null, `החיוב הבא, ${dateLong(c.nextChargeDate)} (${daysUntil(c.nextChargeDate)})`), money(c.nextChargeAmount, { decimals: 0 })) : null,
        isNum(c.average) ? h('li', { class: vsNormal === 'up' ? 'bad' : vsNormal === 'down' ? 'good' : null },
          h('span', null, 'החודש עד עכשיו, מול חודש רגיל'),
          h('span', { class: 'pos-pair' }, money(c.thisMonth, { decimals: 0 }), h('span', { class: 'pos-sep' }, ' / '), money(c.average, { decimals: 0 }))) : null),
      c.cards.length > 1 ? h('ul', { class: 'pos-list' }, c.cards.map((x, i) => h('li', null,
        h('span', { class: `pos-key c${i % 4}`, 'aria-hidden': 'true' }), h('bdi', null, x.name), money(x.current, { decimals: 0 })))) : null);
  }

  /* ---------- 3: trends, bank and cards apart ---------- */
  function trends(p) {
    const avail = state.availableMonths?.length ? state.availableMonths : p.months;
    const chips = h('div', { class: 'pos-pick', role: 'group', 'aria-label': 'תקופת המגמות' },
      SPANS.map((n) => {
        const on = !pick.months && pick.span === n;
        return h('button', { class: ['chip-btn', on ? 'on' : null], type: 'button', 'aria-pressed': String(on),
          onclick: () => { pick = { span: n }; setPref('posPick', n); load(); } }, `${intText(n)} חודשים`);
      }),
      h('button', { class: ['chip-btn', pick.months ? 'on' : null], type: 'button', 'aria-pressed': String(Boolean(pick.months)),
        onclick: (e) => openMonthsPicker(e.currentTarget, {
          available: avail, selected: p.months, title: 'אילו חודשים להציג במגמות',
          onApply: (ms) => { if (!ms.length) return; pick = { months: [...ms].sort() }; setPref('posPick', pick.months); load(); },
        }) }, icon('calendar'), pick.months ? monthsText(pick.months) : 'בחירת חודשים…'));
    const bankChart = balanceChart({ months: p.bank.months });
    const cardChart = cardBillChart({ months: p.cards.months, cards: p.cards.cards, average: p.cards.average });
    const cardLegend = p.cards.cards.length > 1
      ? legend([...p.cards.cards.map((c, i) => [`kc${i % 4}`, c.name]), ['k-avg', 'חודש רגיל']])
      : legend([['k-avg', 'חודש רגיל']]);
    const span = `${monthLabel(p.months[0])}${p.months.length > 1 ? ` – ${monthLabel(p.months[p.months.length - 1])}` : ''}`;
    return h('section', { class: 'pos-trends-wrap', 'aria-labelledby': 'pt-h' },
      h('div', { class: 'pos-trends-head' }, h('h2', { id: 'pt-h' }, 'מגמות'), h('span', { class: 'sub' }, span), h('span', { class: 'grow' }), chips),
      h('div', { class: 'pos-trends' },
        chartPanel({ title: 'יתרה בבנק', sub: 'יום אחר יום', className: 'pos-chart', chart: bankChart }),
        chartPanel({ title: 'חיוב כרטיסי האשראי', sub: 'לפי חודש החיוב', className: 'pos-chart', legend: p.cards.hasData ? cardLegend : null, chart: cardChart })));
  }

  /* ---------- 4: red flags and what to do; then the other insights ---------- */
  function flags(p) {
    // At most four flags in view, the most serious first; the rest fold away with the other insights.
    const allRed = p.redFlags || [];
    const red = allRed.slice(0, 4);
    const restRed = allRed.slice(4);
    const more = p.insights || [];
    const item = (it) => {
      const act = it.action?.filter ? it.action : null;
      return h('li', { class: 'flag', dataset: { sev: it.severity } },
        h('div', { class: 'flag-mark' }, sevMark(it.severity)),
        h('div', { class: 'flag-body' },
          h('h3', null, it.title),
          it.body ? h('p', null, it.body) : null,
          it.tip ? h('p', { class: 'flag-tip' }, h('strong', null, 'מה לעשות: '), it.tip) : null),
        act ? h('button', { class: 'btn small ghost flag-go', type: 'button', onclick: () => open(act.filter, it.title) }, act.label || 'הצג תנועות', icon('chevron')) : null);
    };
    const folded = [...restRed, ...more];
    const moreLabel = restRed.length
      ? `עוד ${intText(restRed.length)} דגלים${more.length ? ` ו-${intText(more.length)} תובנות` : ''}`
      : `תובנות נוספות (${intText(more.length)})`;
    const moreBox = folded.length ? h('details', { class: 'flag-more' },
      h('summary', null, moreLabel),
      h('ul', { class: 'flag-list' }, folded.map(item))) : null;
    return h('section', { class: 'panel pos-flags', 'aria-labelledby': 'pf-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'pf-h' }, 'דגלים אדומים והמלצות'),
        h('span', { class: 'sub' }, allRed.length ? `${intText(allRed.length)} דורשים תשומת לב` : 'הכול בטווח הרגיל')),
      red.length ? h('ul', { class: 'flag-list' }, red.map(item))
        : h('p', { class: 'att-ok' }, sevMark('good'), h('span', null, 'אין כרגע משהו חריג: היתרה, חיובי האשראי וההוצאות בטווח הרגיל שלך.')),
      moreBox);
  }

  load();
  return { el: root, reload: load };
}
