// העסק: the business at a glance (how much of the money is really its own, VAT, profit, set-aside,
// flags) and the flow from the business to the home. Data: GET /api/business/overview and
// /api/business/flow - business rows only, read on the server through the business lens.
import { h, icon, sevMark, mount } from '../dom.js';
import { api } from '../api.js';
import { state, on } from '../store.js';
import { go } from '../router.js';
import { setWhere } from '../shell.js';
import { isNum, money, moneyText, monthLabel, monthShort, dateLong, daysUntil, intText } from '../format.js';
import { columnsChart } from '../charts-dash.js';
import { errorState } from './common.js';

const TABS = [['status', 'מצב העסק'], ['flow', 'מהעסק הביתה']];
const TYPE_LABEL = { exempt: 'עוסק פטור', licensed: 'עוסק מורשה', company: 'חברה בע"מ' };
const fmt0 = (v) => moneyText(v, { decimals: 0, sign: 'negative' });
const periodText = (first, last) => (first === last ? monthLabel(first) : `${monthShort(first)}–${monthLabel(last)}`);

export function mountBusiness(container, params = {}) {
  let tab = TABS.some(([id]) => id === params.tab) ? params.tab : 'status';
  let ctrl = null;
  const body = h('div', { class: 'biz-body' });
  const tabs = h('div', { class: 'biz-tabs', role: 'tablist', 'aria-label': 'מסכי העסק' });
  const head = h('header', { class: 'biz-head' },
    h('div', { class: 'biz-title' }, h('h1', null, 'העסק'), h('p', { class: 'sub' }, 'רק תנועות העסק, בלי שום דבר מהפרטי')),
    tabs);
  mount(container, h('div', { class: 'ov-pad biz' }, head, body));

  function paintTabs() {
    mount(tabs, TABS.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(tab === id), tabindex: tab === id ? '0' : '-1', class: ['chip-btn', tab === id ? 'on' : null],
      onclick: () => { if (tab !== id) { tab = id; history.replaceState(null, '', `#/business?tab=${id}`); load(); } },
      onkeydown: (e) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        const i = TABS.findIndex(([t]) => t === tab);
        tab = TABS[(i + (e.key === 'ArrowLeft' ? 1 : -1) + TABS.length) % TABS.length][0];
        load();
        queueMicrotask(() => tabs.querySelector('[aria-selected="true"]')?.focus());
      },
    }, label)));
    setWhere('business', TABS.find(([id]) => id === tab)[1]);
  }

  async function load() {
    paintTabs();
    ctrl?.abort();
    ctrl = new AbortController();
    mount(body, h('div', { class: 'pos-now' }, h('div', { class: 'sk', style: { height: '220px', borderRadius: '22px' } }),
      h('div', { class: 'sk', style: { height: '220px', borderRadius: '22px' } })));
    try {
      if (tab === 'flow') mount(body, flowView(await api.businessFlow(6, { signal: ctrl.signal })));
      else mount(body, statusView(await api.businessOverview({ signal: ctrl.signal })));
    } catch (e) {
      if (e.name === 'AbortError') return;
      mount(body, errorState('לא הצלחנו לטעון את נתוני העסק', e.message, load));
    }
  }

  /* ---------------- status ---------------- */
  function statusView(o) {
    if (!o.hasBusinessAccounts) {
      return h('section', { class: 'panel biz-empty' },
        h('span', { class: 'empty-ico', 'aria-hidden': 'true' }, icon('briefcase')),
        h('h2', null, 'עוד לא סימנת אף חשבון כחשבון של העסק'),
        h('p', null, 'בהגדרות, ליד כל חשבון וכרטיס, בוחרים אם הוא של העסק, פרטי או מעורב. כרטיס מעורב: כל תנועה בו פרטית עד שמסמנים אותה כעסקית.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => go('settings', { tab: 'business' }) }, icon('gear'), 'לסימון החשבונות'));
    }
    return [hero(o), h('div', { class: 'biz-grid' }, vatPanel(o), monthPanel(o)), monthsPanel(o), flagsPanel(o)];
  }

  function hero(o) {
    const s = o.settings;
    const facts = [
      ['יתרה בחשבונות העסק', o.bank.current],
      isNum(o.cardsUpcoming) && o.cardsUpcoming > 0 ? ['חיובי אשראי עסקיים שעוד ירדו', -o.cardsUpcoming] : null,
      o.vat && (o.vat.toPay.due > 0 || o.vat.open.due > 0) ? ['מע"מ שתצטרך לשלם', -Math.max(0, o.vat.toPay.closed ? o.vat.toPay.due + Math.max(0, o.vat.open.due) : o.vat.open.due)] : null,
      o.setAside.amount > 0 ? [`הפרשה למס הכנסה (${intText(s.setAsidePct)}% מהרווח השנה)`, -o.setAside.amount] : null,
    ].filter(Boolean);
    return h('section', { class: 'pos-card pos-bank hero calm biz-hero', 'aria-labelledby': 'bh-h' },
      h('p', { class: 'hero-tag' }, h('span', { class: 'hero-tag-dot', 'aria-hidden': 'true' }), `${TYPE_LABEL[s.type]}${s.name ? ` · ${s.name}` : ''}`),
      h('h2', { class: 'hero-label', id: 'bh-h' }, 'כמה מהכסף של העסק באמת שלך'),
      h('p', { class: ['hero-figure', o.reallyYours < 0 ? 'neg' : null] }, money(o.reallyYours, { sign: 'negative', decimals: 0 })),
      h('ul', { class: 'pos-facts' }, facts.map(([k, v]) => h('li', null, h('span', null, k), money(v, { sign: 'negative', decimals: 0 })))),
      o.unsorted ? h('p', { class: 'biz-unsorted' }, icon('info'),
        h('span', null, `${intText(o.unsorted)} תנועות בכרטיס המעורב מהחודשיים האחרונים עדיין נחשבות פרטיות. סמן מה מהן של העסק.`)) : null,
      h('div', { class: 'hero-actions' },
        h('button', { class: 'pill-solid', type: 'button', onclick: () => go('transactions', { from: `${o.today.slice(0, 7)}-01` }) }, 'תנועות העסק', icon('chevron')),
        h('a', { class: 'pill-ghost', href: api.businessExportUrl(`${o.today.slice(0, 4)}-01-01`, o.today), download: '' }, icon('download'), 'ייצוא לרואה החשבון')));
  }

  function vatPanel(o) {
    if (!o.vat) {
      const e = o.exempt;
      const pct = e ? Math.min(100, e.pct) : 0;
      return h('section', { class: 'panel biz-vat', 'aria-labelledby': 'bv-h' },
        h('div', { class: 'panel-head' }, h('h2', { id: 'bv-h' }, 'תקרת העוסק הפטור'), h('span', { class: 'sub' }, `שנת ${o.today.slice(0, 4)}`)),
        e ? [
          h('p', { class: 'pos-figure' }, money(e.income, { decimals: 0 })),
          h('div', { class: 'biz-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': 'ניצול התקרה' },
            h('span', { style: { width: `${pct}%` }, class: pct >= 80 ? 'warn' : null })),
          h('p', { class: 'sub' }, `${intText(Math.round(e.pct))}% מהתקרה של ${moneyText(e.ceiling, { decimals: 0 })}. עוסק פטור לא גובה מע"מ ולא מקזז מע"מ.`),
        ] : null);
    }
    const v = o.vat;
    const tp = v.toPay;
    return h('section', { class: 'panel biz-vat', 'aria-labelledby': 'bv-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'bv-h' }, 'מע"מ'), h('span', { class: 'sub' }, `${Math.round(v.rate * 100)}%, דיווח ${v.period === 'monthly' ? 'חודשי' : 'דו-חודשי'}`)),
      h('p', { class: 'biz-vat-line' }, h('span', null, `${tp.closed ? 'לתשלום עד' : 'הערכה לתשלום עד'} ${dateLong(tp.dueDate)} (${daysUntil(tp.dueDate)})`)),
      h('p', { class: 'pos-figure' }, money(Math.max(0, tp.due), { decimals: 0 })),
      h('ul', { class: 'pos-facts' },
        h('li', null, h('span', null, `מע"מ שגבית (${periodText(tp.first, tp.last)})`), money(tp.output, { decimals: 0 })),
        h('li', null, h('span', null, 'מע"מ על הוצאות (קיזוז)'), money(-tp.input, { sign: 'negative', decimals: 0 })),
        tp.closed ? h('li', null, h('span', null, `התקופה הנוכחית עד עכשיו (${periodText(v.open.first, v.open.last)})`), money(v.open.due, { sign: 'negative', decimals: 0 })) : null),
      v.missingInvoices ? h('p', { class: 'biz-warn' }, sevMark('warning'),
        h('span', null, `${intText(v.missingInvoices)} הוצאות גדולות בלי סימון חשבונית: בלי מספר הקצאה המע"מ עליהן לא יוכר.`)) : null,
      h('p', { class: 'biz-note' }, 'הערכה לפי התנועות. החשבון הסופי הוא של רואה החשבון.'));
  }

  function monthPanel(o) {
    const t = o.thisMonth, y = o.ytd;
    const row = (k, a, b, cls) => h('tr', { class: cls }, h('th', { scope: 'row' }, k), h('td', null, money(a, { sign: 'negative', decimals: 0 })), h('td', null, money(b, { sign: 'negative', decimals: 0 })));
    return h('section', { class: 'panel biz-month', 'aria-labelledby': 'bm-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'bm-h' }, 'הכנסות, הוצאות ורווח')),
      h('table', { class: 'biz-table' },
        h('thead', null, h('tr', null, h('td', null), h('th', { scope: 'col' }, 'החודש'), h('th', { scope: 'col' }, `מתחילת ${o.today.slice(0, 4)}`))),
        h('tbody', null,
          row('הכנסות (כולל מע"מ)', t.income, y.income),
          row('הוצאות (כולל מע"מ)', -t.expenses, -y.expenses),
          row('רווח לפני מס, בלי מע"מ', t.profit, y.profit, 'em'),
          row('משכת לפרטי', -t.ownerDraws, -y.ownerDraws, 'muted'))),
      h('p', { class: 'biz-note' }, 'העברות בינך לבין העסק לא נספרות כהוצאה או כהכנסה של אף צד.'));
  }

  function monthsPanel(o) {
    const pts = o.months.map((m) => ({ label: monthLabel(m.month), short: monthShort(m.month), partial: !m.complete,
      values: { income: m.income, expenses: m.expenses, profit: Math.max(0, m.profit) } }));
    return h('section', { class: 'panel biz-months', 'aria-labelledby': 'bms-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'bms-h' }, '12 החודשים האחרונים'),
        h('ul', { class: 'dch-legend inline' }, [['הכנסות', 1], ['הוצאות', 0], ['רווח', 2]].map(([l, c]) => h('li', null,
          h('span', { class: 'dch-key', style: { background: `var(${['--series-out', '--series-in', '--coral-bright'][c]})` }, 'aria-hidden': 'true' }), l)))),
      columnsChart({ points: pts, series: [{ key: 'income', label: 'הכנסות', color: 1 }, { key: 'expenses', label: 'הוצאות', color: 0 }, { key: 'profit', label: 'רווח', color: 2 }],
        fmt: fmt0, label: 'הכנסות, הוצאות ורווח של העסק לפי חודש' }));
  }

  function flagsPanel(o) {
    const item = (f) => h('li', { class: 'flag', dataset: { sev: f.severity } },
      h('div', { class: 'flag-mark' }, sevMark(f.severity)),
      h('div', { class: 'flag-body' }, h('h3', null, f.title), f.body ? h('p', null, f.body) : null),
      f.rowIds?.length ? h('button', { class: 'btn small ghost flag-go', type: 'button',
        onclick: () => go('transactions', { ids: f.rowIds.slice(0, 500).join(','), from_insight: f.title }) }, 'לתנועות', icon('chevron')) : null);
    return h('section', { class: 'panel pos-flags', 'aria-labelledby': 'bf-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'bf-h' }, 'דגלים של העסק')),
      o.flags.length ? h('ul', { class: 'flag-list' }, o.flags.map(item))
        : h('p', { class: 'att-ok' }, sevMark('good'), h('span', null, 'אין כרגע משהו שדורש טיפול: מע"מ, תקרות וחשבוניות בסדר.')));
  }

  /* ---------------- flow: business to home ---------------- */
  function flowView(f) {
    const done = f.months.filter((m) => m.complete);
    const a = f.average;
    const cover = isNum(a.ownerDraws) && isNum(a.homeSpending) && a.homeSpending > 0 ? Math.round((a.ownerDraws / a.homeSpending) * 100) : null;
    const story = done.length ? h('section', { class: 'pos-card pos-bank hero calm biz-flow-hero', 'aria-labelledby': 'fl-h' },
      h('p', { class: 'hero-tag' }, h('span', { class: 'hero-tag-dot', 'aria-hidden': 'true' }), `ממוצע ${intText(done.length)} החודשים האחרונים`),
      h('h2', { class: 'hero-label', id: 'fl-h' }, 'מהעסק הביתה, בחודש רגיל'),
      h('ol', { class: 'biz-flow-steps' },
        h('li', null, h('span', null, 'העסק הרוויח'), money(a.profit, { sign: 'negative', decimals: 0 })),
        h('li', null, h('span', null, 'משכת הביתה'), money(a.ownerDraws, { decimals: 0 })),
        h('li', null, h('span', null, 'הבית הוציא'), money(a.homeSpending, { decimals: 0 }))),
      cover != null ? h('p', { class: 'biz-flow-line' }, cover >= 100
        ? `המשיכות מהעסק מכסות את כל הוצאות הבית (${intText(cover)}%).`
        : `המשיכות מהעסק מכסות ${intText(cover)}% מהוצאות הבית. השאר מגיע ממקור אחר או מהחיסכון.`) : null,
      isNum(a.profit) && isNum(a.ownerDraws) && a.ownerDraws > a.profit && a.profit >= 0
        ? h('p', { class: 'biz-flow-line warn' }, 'אתה מושך יותר ממה שהעסק מרוויח: הכסף בעסק הולך וקטן.') : null)
      : h('section', { class: 'panel' }, h('p', { class: 'empty-line' }, 'אין עדיין חודש שלם עם נתונים.'));
    const pts = f.months.map((m) => ({ label: monthLabel(m.month), short: monthShort(m.month), partial: !m.complete,
      values: { profit: Math.max(0, m.profit), draws: m.ownerDraws, home: m.homeSpending } }));
    const chart = h('section', { class: 'panel', 'aria-labelledby': 'flc-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'flc-h' }, 'חודש אחר חודש'),
        h('ul', { class: 'dch-legend inline' }, [['רווח העסק', '--coral-bright'], ['משיכות הביתה', '--series-in'], ['הוצאות הבית', '--series-out']].map(([l, v]) => h('li', null,
          h('span', { class: 'dch-key', style: { background: `var(${v})` }, 'aria-hidden': 'true' }), l)))),
      columnsChart({ points: pts, series: [{ key: 'profit', label: 'רווח העסק', color: 2 }, { key: 'draws', label: 'משיכות הביתה', color: 1 }, { key: 'home', label: 'הוצאות הבית', color: 0 }],
        fmt: fmt0, label: 'רווח העסק, משיכות והוצאות הבית לפי חודש' }),
      h('table', { class: 'biz-table flow' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'חודש'), h('th', { scope: 'col' }, 'רווח'), h('th', { scope: 'col' }, 'משכת'),
          h('th', { scope: 'col' }, 'נשאר בעסק'), h('th', { scope: 'col' }, 'הבית הוציא'), h('th', { scope: 'col' }, 'כיסוי'))),
        h('tbody', null, [...f.months].reverse().map((m) => h('tr', { class: m.complete ? null : 'muted' },
          h('th', { scope: 'row' }, `${monthLabel(m.month)}${m.complete ? '' : ' (עד עכשיו)'}`),
          h('td', null, money(m.profit, { sign: 'negative', decimals: 0 })), h('td', null, money(m.ownerDraws, { decimals: 0 })),
          h('td', { class: m.leftInBusiness < 0 ? 'bad' : null }, money(m.leftInBusiness, { sign: 'always', decimals: 0 })),
          h('td', null, money(m.homeSpending, { decimals: 0 })), h('td', null, m.homeFundedPct == null ? '–' : `${intText(m.homeFundedPct)}%`))))));
    return [story, chart, h('p', { class: 'biz-note' }, 'משיכות והזרמות מזוהות לבד: אותו סכום שיצא מחשבון העסק ונכנס לחשבון הפרטי (או להפך) תוך יומיים. אפשר לתקן בתנועה עצמה.')];
  }

  load();
  const offs = [on('data-changed', load)];
  return {
    update(p) { if (p?.tab && p.tab !== tab && TABS.some(([id]) => id === p.tab)) { tab = p.tab; load(); } },
    refresh: load,
    destroy() { ctrl?.abort(); offs.forEach((f) => f()); },
  };
}
