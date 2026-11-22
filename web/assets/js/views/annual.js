// שנתי: the last 12 complete months against the 12 before them (סיכום השנה), told as one story
// (see yearTab), and what got more or less expensive (מגמות מחירים). Data: /api/annual, /api/annual/insights, /api/price-trends.
import { h, s, icon, sevMark, mount, avatarOf } from '../dom.js';
import { api } from '../api.js';
import { on, rememberMerchants } from '../store.js';
import { go } from '../router.js';
import { setWhere } from '../shell.js';
import { announce } from '../layers.js';
import { trendChart, priceChart, chartPanel, legend, sparkline } from '../charts.js';
import {
  isNum, money, moneyText, pctText, monthLabel, monthShortYear, dateLong, intText,
} from '../format.js';
import { monthStepper, errorState } from './common.js';

const TABS = [{ id: 'year', label: 'סיכום השנה' }, { id: 'prices', label: 'מגמות מחירים' }];
const monthsHe = (n) => (n === 1 ? 'חודש אחד' : n === 2 ? 'חודשיים' : `${intText(n)} חודשים`);
const CADENCE = { monthly: 'חודשי', bimonthly: 'דו-חודשי' };
const signed = (v, opts = {}) => money(v, { sign: 'always', decimals: 0, ...opts });

export function mountAnnual(container, params) {
  let end = params.end || null;
  let tab = params.tab === 'prices' ? 'prices' : 'year';
  let selected = params.item || null;     // price item key ("rec:..." / "mer:...")
  let ctrl = null;
  let data = null;
  let focusTab = false;
  const offs = [];
  const view = h('div', { class: 'an' });
  container.replaceChildren(view);
  setWhere('annual');

  async function load() {
    ctrl?.abort();
    ctrl = new AbortController();
    const signal = ctrl.signal;
    renderSkeleton();
    const soft = (p) => p.catch((e) => { if (e.name === 'AbortError') throw e; return { error: e }; });
    let annual, insights, prices;
    try {
      [annual, insights, prices] = await Promise.all([
        api.annual(end || undefined, { signal }),
        soft(api.annualInsights(end || undefined, { signal })),
        soft(api.priceTrends(end || undefined, { signal })),
      ]);
    } catch (e) {
      if (e.name === 'AbortError') return;
      mount(view, header(null), h('div', { class: 'page ov-pad' }, errorState('לא הצלחנו לטעון את הסיכום השנתי', e.message, load)));
      return;
    }
    if (signal.aborted) return;
    data = { annual, insights, prices };
    end = annual.end;
    if (!prices.error) rememberMerchants([...prices.merchants, ...prices.recurring].map((x) => x.description));
    render();
  }

  /* ---------- header: title, period, the two tabs ---------- */
  function header(a) {
    const sub = a ? `12 החודשים שהסתיימו ב${monthLabel(a.end)}` : 'טוען…';
    return h('div', { class: 'cmdbar an-head' },
      h('div', { class: 'page-title' }, h('h1', null, 'סיכום שנתי'), h('p', { class: 'page-sub' }, sub)),
      tabs(),
      h('span', { class: 'grow' }),
      a && a.availableEnds?.length ? h('div', { class: 'an-period' }, h('span', { class: 'an-period-k', 'aria-hidden': 'true' }, 'עד'),
        monthStepper({ month: a.end, months: a.availableEnds, onChange: (m) => go('annual', { end: m, tab: tab === 'prices' ? 'prices' : undefined }) })) : null);
  }

  function tabs() {
    const btns = TABS.map((t) => h('button', {
      type: 'button', role: 'tab', id: `an-tab-${t.id}`, class: 'an-tab', 'aria-selected': String(t.id === tab),
      'aria-controls': 'an-panel', tabindex: t.id === tab ? '0' : '-1',
    }, icon(t.id === 'year' ? 'year' : 'tag2'), t.label));
    btns.forEach((b, i) => b.addEventListener('click', () => setTab(TABS[i].id)));
    const list = h('div', { class: 'an-tabs', role: 'tablist', 'aria-label': 'תצוגת הסיכום השנתי' }, btns);
    list.addEventListener('keydown', (e) => {
      const i = TABS.findIndex((t) => t.id === tab);
      let n = null;
      if (e.key === 'ArrowLeft') n = (i + 1) % TABS.length;          // RTL: left is "next"
      else if (e.key === 'ArrowRight') n = (i - 1 + TABS.length) % TABS.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = TABS.length - 1;
      if (n === null) return;
      e.preventDefault();
      focusTab = true;
      setTab(TABS[n].id);
    });
    return list;
  }

  function setTab(id) {
    if (id === tab) return;
    go('annual', { end: end || undefined, tab: id === 'prices' ? 'prices' : undefined, item: id === 'prices' ? selected || undefined : undefined }, { replace: true });
  }

  function renderSkeleton() {
    const sk = (st) => h('div', { class: 'sk', style: st });
    mount(view, header(null), h('div', { class: 'page ov-pad', 'aria-busy': 'true' },
      h('span', { class: 'sr-only', role: 'status' }, 'טוען את הסיכום השנתי…'),
      h('div', { class: 'an-top' }, sk({ height: '300px', borderRadius: '26px' }), sk({ height: '300px', borderRadius: '22px' })),
      h('div', { class: 'ov-kpis' }, [1, 2, 3, 4].map(() => sk({ height: '150px', borderRadius: '22px' })))));
  }

  function render() {
    const a = data.annual;
    setWhere('annual', `${monthShortYear(a.start)} – ${monthShortYear(a.end)}`);
    const panel = h('div', { class: 'page ov-pad an-pad', id: 'an-panel', role: 'tabpanel', 'aria-labelledby': `an-tab-${tab}`, tabindex: '-1' },
      tab === 'year' ? yearTab(a) : pricesTab(data.prices, a));
    mount(view, header(a), panel);
    if (focusTab) { focusTab = false; view.querySelector(`#an-tab-${tab}`)?.focus(); }
  }

  /* =============================== the year =============================== */
  // One story, top to bottom, each number said once:
  //  1. the bottom line: what was left, what came in and went out, against the year before
  //  2. what to take from it: the conclusions, each with what to do
  //  3. month by month: the chart, the typical / dearest / cheapest month, how steady the income is
  //  4. where the money went: categories and how each moved
  //  5. what is already committed ahead: fixed charges and instalments
  function yearTab(a) {
    if (!a.totals) {
      return h('section', { class: 'panel an-empty' }, h('div', { class: 'state' },
        h('h3', null, 'עוד אין חודש שלם של נתונים'),
        h('p', null, 'הסיכום השנתי נבנה מחודשים מלאים. אחרי הסנכרון הראשון (רוב הבנקים מוסרים כ-12 חודשים אחורה) הוא יתמלא.'),
        h('button', { class: 'btn', type: 'button', onclick: () => go('settings') }, icon('bank'), 'לחשבונות')));
    }
    const ins = data.insights;
    return [
      coverageNotice(a),
      bottomLine(a),
      takeawaysPanel(Array.isArray(ins) ? ins : null, ins?.error || null),
      monthsSection(a),
      categoriesPanel(a),
      h('div', { class: 'an-row2' }, fixedPanel(a), instalmentsPanel(a)),
    ];
  }

  function coverageNotice(a) {
    const n = a.coverage.months;
    const hist = a.coverage.historyMonths;
    let text = null;
    if (n < 6) text = `יש נתונים על ${monthsHe(n)} מלאים — הסיכום והמגמות יופיעו כשיצטברו לפחות 6 חודשים, וההשוואה לשנה הקודמת אחרי 24.`;
    else if (!a.previous) text = `יש נתונים על ${monthsHe(hist)} — ההשוואה לשנה הקודמת תופיע כשיצטברו יותר נתונים (צריך 24 חודשים).`;
    return text ? h('div', { class: 'notice an-notice', role: 'status' }, h('span', { class: 'an-notice-ico', 'aria-hidden': 'true' }, icon('info')), h('span', null, text)) : null;
  }

  /* ---------- 1. the bottom line (the coral hero) ---------- */
  function bottomLine(a) {
    const t = a.totals;
    const n = a.coverage.months;
    const tag = `${monthShortYear(a.start)} – ${monthShortYear(a.end)} · ${n === 12 ? '12 חודשים' : `${intText(n)} מתוך 12 חודשים עם נתונים`}`;
    const left = t.net >= 0;
    return h('section', { class: 'hero an-hero', 'aria-labelledby': 'an-hero-h' },
      h('div', { class: 'hero-main' },
        h('p', { class: 'hero-tag' }, h('span', { class: 'hero-tag-dot', 'aria-hidden': 'true' }), tag),
        h('h2', { class: 'hero-label', id: 'an-hero-h' }, left ? 'נשאר לך בשנה' : 'יצא יותר ממה שנכנס, ב-'),
        h('p', { class: ['hero-figure', left ? null : 'neg'] }, money(Math.abs(t.net), { decimals: 0 })),
        h('p', { class: 'hero-sentence an-verdict' }, verdict(a)),
        h('dl', { class: 'hero-stats an-stats' },
          stat('נכנס', t.income, a.change?.incomePct, true, a.previous?.income, 'arrowDownIn'),
          stat('יצא', t.expenses, a.change?.expensesPct, false, a.previous?.expenses, 'card'),
          stat('בחודש רגיל יצא', t.avgMonthlyExpenses, null, false, null, 'calendar')),
        h('div', { class: 'hero-actions' },
          h('button', { class: 'pill-solid', type: 'button', onclick: () => go('transactions', { from: a.from, to: a.to, kind: 'spending' }) }, 'כל ההוצאות בתקופה', icon('chevron')),
          h('button', { class: 'pill-ghost', type: 'button', onclick: () => go('transactions', { from: a.from, to: a.to, kind: 'income' }) }, 'ההכנסות'))),
      savingsRing(a));
  }

  /** The year in one or two sentences: how much of the income stayed, and whether spending ran ahead of income. */
  function verdict(a) {
    const t = a.totals, c = a.change;
    const rate = t.savingsRate;
    const out = [];
    if (!isNum(rate)) out.push('אין הכנסות בתקופה, אז אין מה להשוות אליהן.');
    else if (rate < 0) out.push('ההוצאות עברו את ההכנסות. זה הדבר הראשון לטפל בו.');
    else if (rate < 10) out.push('נשאר ', h('bdi', { class: 'num' }, pctText(rate)), ' מההכנסות: מעט. יעד סביר הוא 10%–20%.');
    else out.push('נשאר ', h('bdi', { class: 'num' }, pctText(rate)), ` מההכנסות: ${rate >= 20 ? 'שנה טובה' : 'בטווח הסביר'}.`);
    if (c && isNum(c.expensesPct) && isNum(c.incomePct)) {
      if (c.expensesPct - c.incomePct >= 3 && c.expensesPct >= 3) {
        out.push(' ההוצאות עלו מהר יותר מההכנסות (', h('bdi', { class: 'num' }, pctText(c.expensesPct)), ' מול ', h('bdi', { class: 'num' }, pctText(c.incomePct)), ').');
      } else if (c.expensesPct <= -3) {
        out.push(' ההוצאות ירדו ב-', h('bdi', { class: 'num' }, pctText(Math.abs(c.expensesPct))), ' מהשנה שלפניה.');
      } else if (Math.abs(c.expensesPct) < 3) {
        out.push(' ההוצאות בערך כמו בשנה שלפניה.');
      }
    }
    return out;
  }

  /** One figure of the bottom line, with its change against the year before in words (never colour alone). */
  function stat(label, value, ch, upGood, prev, ico) {
    let change = null;
    if (isNum(ch)) {
      change = Math.abs(ch) < 3
        ? h('span', { class: 'an-ch' }, 'כמו בשנה שלפניה')
        : h('span', { class: ['an-ch', (ch > 0) === upGood ? 'good' : 'bad'] }, icon(ch > 0 ? 'arrowUp' : 'arrowDown'),
          `${ch > 0 ? 'עלייה' : 'ירידה'} של `, h('bdi', { class: 'num' }, pctText(Math.abs(ch))));
    }
    return h('div', { class: 'hero-stat an-stat' },
      h('dt', null, h('span', { class: 'hs-ico' }, icon(ico)), label),
      h('dd', null, money(value, { decimals: 0 }),
        change, isNum(prev) ? h('span', { class: 'an-prev-y' }, 'שנה קודמת: ', money(prev, { decimals: 0 })) : null));
  }

  /** Ring = what was left as a share of income. A negative year shows an empty ring and says so in words. */
  function savingsRing(a) {
    const rate = a.totals.savingsRate;
    if (!isNum(rate)) return h('div', { class: 'hero-side hero-side-empty' });
    const R = 52, C = 2 * Math.PI * R;
    const frac = Math.max(0, Math.min(1, rate / 100));
    const neg = rate < 0;
    const svg = s('svg', { viewBox: '0 0 128 128', class: 'ring-svg', 'aria-hidden': 'true' },
      s('circle', { cx: 64, cy: 64, r: R, class: 'ring-track' }),
      s('circle', { cx: 64, cy: 64, r: R, class: 'ring-arc', 'stroke-dasharray': `${(C * frac).toFixed(2)} ${C.toFixed(2)}`, transform: 'rotate(-90 64 64)' }));
    const prev = a.previous?.savingsRate;
    const lbl = neg ? 'הוצאת יותר מההכנסות' : 'נשאר מההכנסות';
    const sr = `${neg ? 'מינוס ' : ''}${pctText(rate)} ${lbl}${isNum(prev) ? `. בשנה הקודמת: ${pctText(prev)}` : ''}`;
    return h('div', { class: 'hero-side' },
      h('figure', { class: 'ring', role: 'img', 'aria-label': `שיעור החיסכון: ${sr}` },
        svg,
        h('figcaption', { class: 'ring-center', 'aria-hidden': 'true' },
          h('bdi', { class: 'num ring-pct' }, `${neg ? '−' : ''}${pctText(rate)}`),
          h('span', { class: 'ring-label' }, lbl))),
      h('p', { class: 'ring-note' }, isNum(prev) ? ['שנה קודמת: ', h('bdi', { class: 'num' }, pctText(prev))] : 'שיעור החיסכון'));
  }

  /* ---------- 2. what to take from the year ---------- */
  // The year's totals are already in the bottom line: a conclusion that only repeats them is left out,
  // unless it is a warning (spending ran ahead, little or nothing left, income fell).
  const TOTALS_TYPES = new Set(['yearCoverage', 'yearSpending', 'yearSavings', 'yearIncome']);
  function takeawaysPanel(all, err) {
    let body;
    let more = null;
    const list = all ? all.filter((i) => !TOTALS_TYPES.has(i.type) || i.severity === 'warning' || i.severity === 'alert') : null;
    if (err) body = errorState('לא הצלחנו לטעון את המסקנות', err.message, load);
    else if (!list || !list.length) body = h('p', { class: 'empty-line ins-empty' }, sevMark('good'), ' אין בשנה הזו שינוי שדורש תשומת לב.');
    else {
      const TOP = 4;
      const top = list.slice(0, TOP), rest = list.slice(TOP);
      body = h('ol', { class: 'ins-list' }, top.map((it) => insightItem(it, false)));
      if (rest.length) {
        const restList = h('ol', { class: 'ins-list ins-rest', id: 'an-ins-rest', start: String(TOP + 1) });
        let open = false;
        const lbl = () => (open ? 'בלי ההסברים' : `הסבר מלא ל${rest.length === 1 ? 'מסקנה הנוספת' : `-${intText(rest.length)} המסקנות הנוספות`}`);
        const paint = () => restList.replaceChildren(...rest.map((it) => insightItem(it, !open)));
        paint();
        const toggle = h('button', { class: 'link ins-more', type: 'button', 'aria-controls': 'an-ins-rest', 'aria-expanded': 'false' }, lbl());
        toggle.addEventListener('click', () => { open = !open; paint(); toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = lbl(); });
        more = [restList, toggle];
      }
    }
    const count = Array.isArray(list) ? list.filter((i) => i.severity === 'alert' || i.severity === 'warning').length : 0;
    return h('section', { class: 'panel ins-panel an-ins', 'aria-labelledby': 'an-ins-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'an-ins-h' }, 'מה כדאי לקחת מהשנה'),
        count ? h('span', { class: 'badge b-coral' }, `${count === 1 ? 'דבר אחד' : `${intText(count)} דברים`} לבדוק`) : null),
      body, more);
  }

  /** What the insight's `amount` means, per annual type (server/annual.js). */
  function keyFigure(it) {
    if (!isNum(it.amount)) return null;
    const L = {
      yearSpending: 'הוצאות', yearCoverage: 'הוצאות', yearIncome: 'שינוי בחודש', fixedCostsChange: 'בשנה',
      merchantTicket: 'בשנה', merchantFrequency: 'בשנה', categoryTrendUp: 'יותר בחודש', categoryTrendDown: 'פחות בחודש',
      expensiveMonth: 'מעל חודש רגיל', instalmentsAhead: 'נשאר לשלם',
    };
    if (it.type === 'yearSavings') return { label: it.amount >= 0 ? 'נשאר' : 'חסר', value: Math.abs(it.amount) };
    if (it.type === 'unusualIncome') return { label: it.amount >= 0 ? 'מעל הרגיל' : 'מתחת לרגיל', value: Math.abs(it.amount) };
    return L[it.type] ? { label: L[it.type], value: Math.abs(it.amount) } : null;
  }

  function insightItem(it, compact) {
    const act = it.action && it.action.filter ? it.action : null;
    const open = () => {
      const f = { ...act.filter };
      if (Array.isArray(f.ids)) f.ids = f.ids.join(',');
      f.from_insight = it.title;
      go('transactions', f);
    };
    const tid = `an-ins-${String(it.id || '').replace(/[^\w-]/g, '')}`;
    const kf = compact ? null : keyFigure(it);
    return h('li', { class: ['ins', compact ? 'compact' : null], dataset: { sev: it.severity || 'info' } },
      h('div', { class: 'ins-mark' }, sevMark(it.severity)),
      h('div', { class: 'ins-body' }, h('h3', { id: tid }, it.title || ''),
        !compact && it.body ? h('p', null, it.body) : null,
        !compact && it.tip ? h('p', { class: 'ins-tip' }, h('strong', null, 'מה לעשות: '), it.tip) : null),
      h('div', { class: 'ins-side' },
        kf ? h('p', { class: 'ins-fig' }, h('span', { class: 'k' }, kf.label), money(kf.value, { decimals: 0 })) : null,
        act ? (compact
          ? h('button', { class: 'btn small ghost icon ins-act icon-only', type: 'button', onclick: open, 'aria-label': act.label || 'הצג תנועות', title: act.label || 'הצג תנועות', 'aria-describedby': tid }, icon('chevron'))
          : h('button', { class: 'btn small accent ins-act', type: 'button', onclick: open, 'aria-describedby': tid }, h('span', null, act.label || 'הצג תנועות'), icon('chevron'))) : null));
  }

  /* ---------- 3. month by month: the chart, then what stands out ---------- */
  function monthsSection(a) {
    const panel = chartPanel({
      title: 'חודש אחר חודש',
      sub: 'הכנסות מול הוצאות, הישן מימין. לחיצה על חודש פותחת את הסקירה שלו',
      className: 'an-months',
      legend: legend([['k-in', 'הכנסות'], ['k-out', 'הוצאות'], ['k-tl', 'קו מגמה']]),
      chart: trendChart({ monthly: a.monthly, trends: a.trends, onPick: (m) => go('overview', { month: m }) }),
    });
    panel.append(monthFacts(a));
    return panel;
  }

  function monthFacts(a) {
    const ex = a.extremes;
    const st = a.incomeStability;
    if (!ex && !st) return h('p', { class: 'empty-line an-mf-empty' }, 'החודש הרגיל, היקר והזול יופיעו אחרי 6 חודשים מלאים של נתונים.');
    const monthBtn = (m, why) => h('button', { type: 'button', class: 'an-mf-link', onclick: () => go('overview', { month: m.month }), title: `לסקירת ${monthLabel(m.month)}` },
      h('span', { class: 'an-mf-v' }, money(m.expenses, { decimals: 0 })),
      h('span', { class: 'an-mf-s' }, monthLabel(m.month), why ? [' · ', h('bdi', null, why)] : null));
    const items = [];
    if (ex) {
      const most = ex.most?.[0], least = ex.least?.[0];
      items.push(fact2('חודש רגיל', h('span', { class: 'an-mf-v' }, money(ex.median, { decimals: 0 })), h('span', { class: 'an-mf-s' }, 'חציון ההוצאה החודשית')));
      if (most) items.push(fact2('החודש היקר', monthBtn(most, most.driver ? `בעיקר ${most.driver.name}` : ''), null, 'up'));
      if (least) items.push(fact2('החודש הזול', monthBtn(least, least.driver ? `פחות ${least.driver.name}` : ''), null, 'down'));
    }
    if (st) {
      const LEVEL = { stable: 'יציבה', variable: 'משתנה מעט', irregular: 'לא סדירה' };
      const odd = st.unusual?.length || 0;
      items.push(fact2('ההכנסה', h('span', { class: 'an-mf-v' }, LEVEL[st.level] || '–'),
        h('span', { class: 'an-mf-s' }, 'חודש רגיל: ', moneyText(st.median, { decimals: 0 }), odd ? ` · ${odd === 1 ? 'חודש חריג אחד' : `${intText(odd)} חודשים חריגים`}` : '')));
    }
    return h('dl', { class: 'an-mfacts' }, items);
  }
  function fact2(k, v, sub, dir) {
    return h('div', { class: 'an-mf' },
      h('dt', null, dir ? h('span', { class: ['an-dir', dir], 'aria-hidden': 'true' }, icon(dir === 'up' ? 'arrowUp' : 'arrowDown')) : null, k),
      h('dd', null, v, sub));
  }

  /* ---------- 4. where the money went: categories + first vs last three months ---------- */
  function categoriesPanel(a) {
    const cats = a.categories || [];
    let expanded = false;
    const tbody = h('tbody');
    const growers = new Set(a.growers || []), shrinkers = new Set(a.shrinkers || []);
    const fill = () => tbody.replaceChildren(...(expanded ? cats : cats.slice(0, 8)).map((c) => catRow(c, a, growers, shrinkers)));
    fill();
    const more = cats.length > 8 ? h('button', { class: 'link', type: 'button' }, `הצג את כל ${cats.length} הקטגוריות`) : null;
    more?.addEventListener('click', () => { expanded = !expanded; fill(); more.textContent = expanded ? 'הצג פחות' : `הצג את כל ${cats.length} הקטגוריות`; });
    return h('section', { class: 'panel cat-panel an-cats', 'aria-labelledby': 'an-cat-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'an-cat-h' }, 'לאן הלך הכסף')),
      h('p', { class: 'panel-sub' }, 'הקו הקטן: כל חודש בתקופה, הישן מימין. "שינוי": שלושת החודשים האחרונים מול שלושת הראשונים, בממוצע לחודש ובלי עסקאות בתשלומים'),
      cats.length ? h('table', { class: 'cat-table an-cat-table' },
        h('thead', null, h('tr', null, h('th', null, 'קטגוריה'), h('th', { class: 'an-spark-cell' }, 'לפי חודש'), h('th', { class: 'num-col' }, 'בתקופה'), h('th', null, 'שינוי'), h('th', null, 'מגמה'))),
        tbody) : h('p', { class: 'empty-line' }, 'אין הוצאות בתקופה.'),
      more);
  }

  function catRow(c, a, growers, shrinkers) {
    const vals = (c.monthly || []).filter(isNum);
    const open = () => go('transactions', { category: c.category, from: a.from, to: a.to });
    const q = c.quarters;
    let change = h('span', { class: 'delta same' }, h('span', { class: 'delta-main' }, '–'), h('span', { class: 'delta-avg' }, 'מעט מדי חודשים'));
    const noisy = q && isNum(q.pct) && Math.abs(q.pct) >= 10 && c.trend?.direction === 'flat';
    if (noisy) {
      // first vs last three months moved, but the line over all months did not: billing cycles or one-offs, not a habit
      change = h('span', { class: 'delta same', title: 'שלושת החודשים בקצוות שונים, אבל אין מגמה לאורך כל התקופה' },
        h('span', { class: 'delta-main' }, 'תנודתי, בלי מגמה'),
        h('span', { class: 'delta-avg' }, 'מ-', money(q.firstAvg, { decimals: 0 }), ' ל-', money(q.lastAvg, { decimals: 0 }), ' בחודש'));
    } else if (q && isNum(q.pct)) {
      const up = q.pct > 0;
      const same = Math.abs(q.pct) < 10;
      change = h('span', { class: ['delta', same ? 'same' : up ? 'up' : 'down'] },
        h('span', { class: 'delta-main' }, same ? 'כרגיל' : [icon(up ? 'arrowUp' : 'arrowDown'), `${up ? 'עלייה' : 'ירידה'} של `, h('bdi', { class: 'num' }, pctText(q.pct))]),
        h('span', { class: 'delta-avg' }, 'מ-', money(q.firstAvg, { decimals: 0 }), ' ל-', money(q.lastAvg, { decimals: 0 }), ' בחודש'));
    } else if (q) {
      change = h('span', { class: 'delta new' }, h('span', { class: 'delta-main' }, 'חדש בתקופה'));
    }
    const tr = c.trend;
    const flag = growers.has(c.category) ? h('span', { class: 'badge b-up an-flag' }, 'עולה בהדרגה') : shrinkers.has(c.category) ? h('span', { class: 'badge b-down an-flag' }, 'יורדת') : null;
    const row = h('tr', { tabindex: '0', title: `תנועות בקטגוריה ${c.name} בתקופה` },
      h('td', { class: 'cat-cell' }, h('span', { class: 'cat-name' }, h('span', { class: 'swatch', style: { background: c.color || 'var(--ink-4)' } }), c.name || ''),
        h('span', { class: 'cat-count' }, h('bdi', { class: 'num' }, `${c.share < 1 && c.share > 0 ? '<1' : Math.round(c.share)}%`), ' מההוצאות · ', c.count === 1 ? 'עסקה אחת' : `${intText(c.count)} עסקאות`)),
      h('td', { class: 'an-spark-cell' }, vals.length >= 2 ? sparkline({ values: vals, kind: 'cat', height: 30, label: `${c.name}: הנמוך ${moneyText(Math.min(...vals), { decimals: 0 })}, הגבוה ${moneyText(Math.max(...vals), { decimals: 0 })} בחודש. לפי חודש, מהישן לחדש: ${vals.map((v) => moneyText(v, { decimals: 0 })).join(', ')}.` }) : null),
      h('td', { class: 'num-col' }, money(c.total, { decimals: 0 }), h('span', { class: 'delta-avg an-avg' }, 'כ-', money(c.avgMonthly, { decimals: 0 }), ' בחודש')),
      h('td', null, change),
      h('td', { class: 'an-trend-cell' }, tr ? h('span', { class: ['an-trend', tr.direction] }, tr.direction === 'flat' ? null : icon(tr.direction === 'up' ? 'arrowUp' : 'arrowDown'), tr.label) : h('span', { class: 'rc-same' }, '–'), flag));
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return row;
  }

  /* ---------- 5. what is already committed ahead: fixed charges, then instalments ---------- */
  function fixedPanel(a) {
    const f = a.fixed;
    const pc = f.priceChanges;
    const q = f.quarters;
    const toPrices = h('button', { class: 'btn small', type: 'button', onclick: () => go('annual', { end: end || undefined, tab: 'prices' }) }, icon('tag2'), 'מגמות המחירים');
    return h('section', { class: 'panel an-fixed', 'aria-labelledby': 'an-fix-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'an-fix-h' }, 'התחייבויות קבועות'), h('span', { class: 'grow' }), toPrices),
      h('div', { class: 'an-figs' },
        fig('בחודש, לפי המחירים היום', money(f.monthlyNow, { decimals: 0 }), `${intText(f.count)} חיובים קבועים`),
        fig('בשנה', money(f.yearlyNow, { decimals: 0 })),
        q ? fig('בממוצע לחודש בתקופה', money(f.avgMonthly, { decimals: 0 }), ['בתחילתה ', moneyText(q.firstAvg, { decimals: 0 }), ', בסופה ', moneyText(q.lastAvg, { decimals: 0 })]) : null),
      pc.items.length ? [
        h('h3', { class: 'an-sub-h' }, 'שינויי מחיר בתקופה'),
        h('ul', { class: 'rows an-moves' }, pc.items.map((x) => moveRow(x))),
        h('p', { class: 'an-sum-line' }, 'סה״כ: ', h('strong', null, signed(pc.netYearly)), ' בשנה (התייקרויות ', money(pc.increasesYearly, { decimals: 0 }), ', הוזלות ', money(pc.decreasesYearly, { decimals: 0 }), ').'),
      ] : h('p', { class: 'empty-line' }, 'אף חיוב קבוע לא שינה מחיר בתקופה.'));
  }
  function fig(k, v, sub) {
    return h('div', { class: 'an-fig' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), sub ? h('span', { class: 'an-fig-sub' }, sub) : null);
  }
  function moveRow(x) {
    const up = x.yearly > 0;
    return h('li', { class: 'an-move' },
      avatarOf(x.description),
      h('span', { class: 'an-move-name' }, h('bdi', null, x.description), h('span', { class: 'an-move-sub' }, 'מ-', h('bdi', { class: 'num' }, moneyText(x.from)), ' ל-', h('bdi', { class: 'num' }, moneyText(x.to)), x.date ? ` · ${dateLong(x.date)}` : '')),
      h('span', { class: ['badge', up ? 'b-up' : 'b-down'] }, up ? 'התייקר ' : 'הוזל ', h('bdi', { class: 'num' }, pctText(x.pct))),
      h('span', { class: 'amt-r' }, signed(x.yearly), h('span', { class: 'an-move-sub' }, ' בשנה')));
  }

  /* ---------- instalments still to pay ---------- */
  function instalmentsPanel(a) {
    const ins = a.instalments;
    const head = h('div', { class: 'panel-head' }, h('h2', { id: 'an-inst-h' }, 'תשלומים שעוד נשארו'));
    if (!ins.count) return h('section', { class: 'panel an-inst', 'aria-labelledby': 'an-inst-h' }, head, h('p', { class: 'empty-line' }, 'אין עסקאות פתוחות בתשלומים.'));
    const max = Math.max(1, ...ins.byMonth.map((m) => m.amount));
    return h('section', { class: 'panel an-inst', 'aria-labelledby': 'an-inst-h' }, head,
      h('div', { class: 'an-figs' },
        fig('נשאר לשלם', money(ins.remainingAmount, { decimals: 0 }), ins.lastDate ? ['האחרון ב-', dateLong(ins.lastDate)] : null),
        fig('בחודש עכשיו', money(ins.monthlyNow, { decimals: 0 }), ins.count === 1 ? 'עסקה אחת' : `${intText(ins.count)} עסקאות`)),
      h('ul', { class: 'rows an-plans' }, ins.plans.map((p) => h('li', null,
        h('button', { type: 'button', class: 'row-btn mer-row', onclick: () => go('transactions', { ids: p.filter.ids.join(','), from_insight: `תשלומים: ${p.description}` }) },
          h('span', { class: 'an-plan-prog', 'aria-hidden': 'true' }, h('span', { style: { width: `${(p.paid / p.of) * 100}%` } })),
          h('span', { class: 'mer-name' }, h('span', { class: 'mer-line' }, h('bdi', null, p.description),
            h('span', { class: 'mer-count' }, `שולמו ${p.paid} מתוך ${p.of} · `, money(p.monthly, { decimals: 'auto' }), ` לחודש · עוד ${p.remaining === 1 ? 'תשלום אחד' : `${p.remaining} תשלומים`}`))),
          h('span', { class: 'amt-r' }, money(p.remainingAmount, { decimals: 0 })))))),
      ins.byMonth.length ? h('div', { class: 'an-bymonth', role: 'list', 'aria-label': 'תשלומים לפי חודש' }, ins.byMonth.map((m) => h('div', { class: 'an-bm', role: 'listitem' },
        h('span', { class: 'an-bm-m' }, monthLabel(m.month)),
        h('span', { class: 'an-bm-bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.max(2, (m.amount / max) * 100)}%` } })),
        h('span', { class: 'amt-r' }, money(m.amount, { decimals: 0 }))))) : null);
  }

  /* =============================== price trends =============================== */
  function pricesTab(p, a) {
    if (!p || p.error) return errorState('לא הצלחנו לטעון את מגמות המחירים', p?.error?.message, load);
    if (!p.recurring.length && !p.merchants.length) {
      return h('section', { class: 'panel' }, h('div', { class: 'state' }, h('h3', null, 'עוד אין מספיק היסטוריה למגמות מחירים'),
        h('p', null, 'צריך לפחות שלושה חיובים מאותו מנוי או חשבון, או עשרה ביקורים באותו בית עסק לאורך חצי שנה.')));
    }
    const items = new Map([...p.recurring.map((r) => [r.key, { kind: 'recurring', ...r }]), ...p.merchants.map((m) => [m.key, { kind: 'merchant', ...m }])]);
    if (!selected || !items.has(selected)) selected = p.increases[0]?.key || p.decreases[0]?.key || p.recurring.find((r) => r.changes.length)?.key || p.recurring[0]?.key || p.merchants[0]?.key;
    const detailSlot = h('div', { class: 'an-detail-slot' });
    const select = (key, { focus = false } = {}) => {
      selected = key;
      history.replaceState(null, '', `#/annual?${new URLSearchParams({ ...(end ? { end } : {}), tab: 'prices', item: key })}`);
      detailSlot.replaceChildren(detailPanel(items.get(key)));
      for (const b of view.querySelectorAll('[data-item]')) b.setAttribute('aria-pressed', String(b.dataset.item === key));
      announce(`נבחר: ${items.get(key)?.description || ''}`);
      // The chart draws on its first ResizeObserver callback, so the svg may not exist yet.
      const focusChart = (tries) => {
        const svg = detailSlot.querySelector('svg[tabindex]');
        if (svg) svg.focus({ preventScroll: false });
        else if (tries > 0) setTimeout(() => focusChart(tries - 1), 30);
      };
      if (focus) focusChart(30);
    };
    detailSlot.append(detailPanel(items.get(selected)));
    const merchantsMoved = p.merchants.filter((m) => m.ticket && m.ticket.direction !== 'flat').length;
    const T = p.totals;
    return [
      h('div', { class: 'rc-summary an-psum' },
        h('div', { class: 'rc-main' }, h('span', { class: 'k' }, 'התייקרויות בחיובים קבועים'), h('span', { class: 'v' }, signed(T.recurringIncreasesYearly)), h('span', { class: 'v-sub an-on-coral' }, 'בשנה, לפי המחירים החדשים')),
        h('div', null, h('span', { class: 'k' }, 'הוזלות'), h('span', { class: 'v' }, money(-T.recurringDecreasesYearly, { sign: T.recurringDecreasesYearly ? 'always' : 'none', decimals: 0 })), h('span', { class: 'v-sub' }, 'בשנה')),
        h('div', null, h('span', { class: 'k' }, 'נטו לחיובים הקבועים'), h('span', { class: 'v' }, signed(T.recurringNetYearly)), h('span', { class: 'v-sub' }, 'בשנה')),
        h('div', null, h('span', { class: 'k' }, 'בתי עסק שהקנייה הממוצעת בהם השתנתה'), h('span', { class: 'v num' }, intText(merchantsMoved)), h('span', { class: 'v-sub' }, `מתוך ${intText(p.merchants.length)} קבועים`))),
      h('p', { class: 'rc-explain an-explain' }, explainText(p)),
      h('div', { class: 'an-prices' },
        h('div', { class: 'an-ranked' }, rankedPanel('התייקרו', p.increases, 'up', select), rankedPanel('הוזלו', p.decreases, 'down', select)),
        detailSlot),
      recurringTable(p, select),
      merchantsTable(p, select),
    ];
  }

  /** The rules in words, with the months that actually have data (never a month with no data). */
  function explainText(p) {
    const range = (a, b) => (a === b ? monthLabel(a) : `${monthLabel(a)} – ${monthLabel(b)}`);
    const rec = 'חיובים קבועים: כל חיוב נבדק מול הקודמים; שינוי נספר רק אחרי שהמחיר הישן חויב לפחות פעמיים, וחשבון שמשתנה בכל פעם (חשמל, מים) לא נחשב לשינוי מחיר.';
    const mer = 'בתי עסק: אנחנו רואים רק את סכום הקבלה, ולכן מדובר ב"קנייה ממוצעת" ולא במחירי מוצרים.';
    const partial = p.dataStart && p.dataStart > p.start ? ` יש נתונים רק מ${monthLabel(p.dataStart)}.` : '';
    const cmp = p.compare
      ? ` משווים את שלושת החודשים הראשונים שיש עליהם נתונים (${range(p.compare.first[0], p.compare.first[1])}) לשלושת האחרונים (${range(p.compare.last[0], p.compare.last[1])}), רק כשיש לפחות ${p.rules.minQuarterVisits} ביקורים בכל צד והשינוי ברור סטטיסטית.`
      : ' להשוואת הקנייה הממוצעת צריך לפחות שישה חודשים עם נתונים, ולכן עוד לא משווים.';
    return `${rec} ${mer}${partial}${cmp}`;
  }

  function itemButton(key, select, content, label) {
    const b = h('button', { type: 'button', class: 'row-btn an-item', dataset: { item: key }, 'aria-pressed': String(key === selected), 'aria-label': label }, content);
    b.addEventListener('click', () => select(key, { focus: false }));
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(key, { focus: true }); } });
    return b;
  }

  function rankedPanel(title, list, dir, select) {
    const id = `an-rk-${dir}`;
    return h('section', { class: 'panel an-rk', 'aria-labelledby': id },
      h('div', { class: 'panel-head' }, h('h2', { id }, h('span', { class: ['an-dir', dir === 'up' ? 'up' : 'down'], 'aria-hidden': 'true' }, icon(dir === 'up' ? 'arrowUp' : 'arrowDown')), title),
        h('span', { class: 'sub' }, 'לפי ההשפעה בשקלים לשנה')),
      list.length ? h('ol', { class: 'rows an-rk-list' }, list.map((x) => {
        const kindLabel = x.kind === 'recurring' ? 'חיוב קבוע' : 'קנייה ממוצעת';
        const pct = `${dir === 'up' ? '+' : '−'}${pctText(x.pct)}`;
        return h('li', null, itemButton(x.key, select, [
          avatarOf(x.description),
          h('span', { class: 'an-rk-name' }, h('bdi', null, x.description), h('span', { class: 'an-rk-sub' }, kindLabel, ' · מ-', h('bdi', { class: 'num' }, moneyText(x.from)), ' ל-', h('bdi', { class: 'num' }, moneyText(x.to)), x.confirmed === false ? ' · חויב פעם אחת במחיר החדש' : '')),
          h('span', { class: ['badge', dir === 'up' ? 'b-up' : 'b-down'] }, h('bdi', { class: 'num' }, pct)),
          h('span', { class: 'amt-r an-rk-amt' }, signed(x.yearly), h('span', { class: 'an-rk-sub' }, 'בשנה')),
        ], `${x.description}: ${kindLabel} ${dir === 'up' ? 'התייקר' : 'הוזל'} מ-${moneyText(x.from)} ל-${moneyText(x.to)}, ${moneyText(Math.abs(x.yearly), { decimals: 0 })} ${dir === 'up' ? 'יותר' : 'פחות'} בשנה. הצגת ההיסטוריה`));
      })) : h('p', { class: 'empty-line' }, dir === 'up' ? 'לא זיהינו התייקרויות בתקופה.' : 'לא זיהינו הוזלות בתקופה.'));
  }

  function detailPanel(it) {
    if (!it) return h('section', { class: 'panel an-detail' }, h('p', { class: 'empty-line' }, 'בחר פריט מהרשימה כדי לראות את ההיסטוריה שלו.'));
    let chart, facts, sub, note = null;
    if (it.kind === 'recurring') {
      const changes = it.changes.map((c) => ({ date: c.date, from: c.from, to: c.to, pct: c.pct }));
      chart = priceChart({ points: it.history.map((x) => ({ date: x.date, value: x.amount })), changes, kind: it.variable ? 'line' : 'step', title: it.description, valueLabel: 'חיוב' });
      sub = `חיוב ${CADENCE[it.cadence] || ''} · ${intText(it.history.length)} חיובים${it.variable ? ' · סכום משתנה בכל חיוב' : ''}`;
      facts = h('dl', { class: 'an-facts' },
        fact('עכשיו', [money(it.amount, { decimals: 'auto' }), ' לחיוב · ', money(it.yearlyCost, { decimals: 0 }), ' בשנה']),
        it.variable
          ? fact('שינויי מחיר', it.levelChange ? ['הסכום הממוצע ', it.levelChange.pct > 0 ? 'עלה' : 'ירד', ' מכ-', money(it.levelChange.from, { decimals: 0 }), ' לכ-', money(it.levelChange.to, { decimals: 0 })] : 'חשבון שמשתנה לפי צריכה: לא מסמנים בו שינויי מחיר.')
          : fact('שינויי מחיר', it.changes.length ? h('ul', { class: 'an-facts-list' }, it.changes.map((c) => h('li', null, dateLong(c.date), ': מ-', money(c.from), ' ל-', money(c.to),
            ` (${c.to > c.from ? '+' : '−'}${pctText(c.pct)}, `, signed(c.yearly), ' בשנה)', c.confirmed ? '' : ' · עד כה חויב פעם אחת במחיר החדש', c.inWindow ? '' : ' · לפני התקופה'))) : 'המחיר לא השתנה בהיסטוריה שיש לנו.'));
    } else {
      const m = it;
      const pts = m.monthly.filter((x) => isNum(x.avgTicket)).map((x) => ({ date: `${x.month}-15`, value: x.avgTicket, note: `${x.visits === 1 ? 'ביקור אחד' : `${x.visits} ביקורים`}, סה״כ ${moneyText(x.total, { decimals: 0 })}` }));
      const cmp = data?.prices?.compare;   // the months the comparison really used (data, not calendar)
      const bands = m.ticket && cmp ? [
        { from: `${cmp.first[0]}-01`, to: `${cmp.first[1]}-28`, label: 'התחלה', level: m.ticket.from },
        { from: `${cmp.last[0]}-01`, to: `${cmp.last[1]}-28`, label: 'סוף', level: m.ticket.to },
      ] : [];
      chart = priceChart({ points: pts, bands, kind: 'line', title: m.description, valueLabel: 'קנייה ממוצעת' });
      sub = `${intText(m.visits)} ביקורים ב-${intText(m.months)} חודשים · ${moneyText(m.total, { decimals: 0 })} בתקופה`;
      const DRIVER = {
        ticket: 'השינוי בהוצאה בא מהקנייה הממוצעת, לא ממספר הביקורים.',
        frequency: 'השינוי בהוצאה בא ממספר הביקורים; הקנייה הממוצעת כמעט לא השתנתה.',
        both: 'גם הקנייה הממוצעת וגם מספר הביקורים השתנו.',
        none: 'אין שינוי ברור בקנייה הממוצעת או במספר הביקורים.',
      };
      facts = h('dl', { class: 'an-facts' },
        m.ticket ? fact('קנייה ממוצעת', ['מ-', money(m.ticket.from), ' ל-', money(m.ticket.to), ` (${m.ticket.pct > 0 ? '+' : m.ticket.pct < 0 ? '−' : ''}${pctText(m.ticket.pct)}) · חציון מ-`, money(m.ticket.medianFrom), ' ל-', money(m.ticket.medianTo)]) : null,
        m.frequency ? fact('ביקורים בחודש', ['מ-', h('bdi', { class: 'num' }, m.frequency.from.toFixed(1)), ' ל-', h('bdi', { class: 'num' }, m.frequency.to.toFixed(1))]) : null,
        m.yearlyEffect ? fact('ההשפעה בשנה', ['מהקנייה הממוצעת ', signed(m.yearlyEffect.ticket), ' · ממספר הביקורים ', signed(m.yearlyEffect.frequency)]) : null,
        fact('מה השתנה', m.enoughData ? DRIVER[m.driver] : 'מעט מדי ביקורים בתחילת התקופה או בסופה כדי להשוות.'));
      note = h('p', { class: 'an-facts-note' }, 'סכום הקבלה בלבד: ייתכן שהסל השתנה ולא רק המחירים.');   // outside the <dl>
    }
    const all = h('button', { class: 'btn small', type: 'button', onclick: () => go('transactions', { ids: it.filter.ids.join(','), from_insight: it.description }) }, icon('list'), 'התנועות');
    const pnl = chartPanel({ title: it.description, sub, chart, className: 'an-detail' });
    pnl.querySelector('.panel-head')?.append(all);
    pnl.append(facts);
    if (note) pnl.append(note);
    return pnl;
  }
  function fact(k, v) { return h('div', { class: 'an-fact' }, h('dt', null, k), h('dd', null, v)); }

  function recurringTable(p, select) {
    return h('section', { class: 'panel an-ptable', 'aria-labelledby': 'an-rec-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'an-rec-h' }, 'כל החיובים הקבועים'), h('span', { class: 'sub' }, 'בחירה מציגה את היסטוריית המחיר')),
      h('table', { class: 'grid-table an-table' },
        h('thead', null, h('tr', null, h('th', null, h('span', { class: 'th-av' }, 'חיוב')), h('th', { class: 'num-col' }, 'עכשיו'), h('th', null, 'תדירות'), h('th', { class: 'num-col' }, 'חיובים'), h('th', null, 'שינוי אחרון'))),
        h('tbody', null, p.recurring.map((r) => {
          // The server's latestChange: the same definition the חיובים קבועים screen shows.
          const last = r.latestChange;
          const state2 = r.variable ? h('span', { class: 'rc-same' }, 'משתנה לפי צריכה')
            : last ? h('span', { class: ['badge', last.to > last.from ? 'b-up' : 'b-down'] }, last.to > last.from ? 'התייקר ב-' : 'הוזל ב-', h('bdi', { class: 'num' }, pctText(last.pct)), ` ב${monthLabel(String(last.date).slice(0, 7))}`)
              : h('span', { class: 'rc-same' }, 'ללא שינוי בתקופה');
          return h('tr', null,
            h('td', null, itemButton(r.key, select, [avatarOf(r.description, { size: 'av-sm' }), h('bdi', null, r.description)], `${r.description}: הצגת היסטוריית המחיר`)),
            h('td', { class: 'num-col' }, money(r.amount, { decimals: 'auto' })),
            h('td', null, CADENCE[r.cadence] || r.cadence),
            h('td', { class: 'num-col' }, h('bdi', { class: 'num' }, intText(r.history.length))),
            h('td', null, state2));
        }))));
  }

  function merchantsTable(p, select) {
    const DRIVER = { ticket: 'הקנייה הממוצעת השתנתה', frequency: 'מספר הביקורים השתנה', both: 'גם וגם', none: 'אין שינוי ברור' };
    return h('section', { class: 'panel an-ptable', 'aria-labelledby': 'an-mer-h' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'an-mer-h' }, 'בתי עסק שחוזרים אליהם'), h('span', { class: 'sub' }, `לפחות ${p.rules.minVisits} ביקורים ב-${p.rules.minMonths} חודשים שונים, בלי תשלומים והחזרים`)),
      p.merchants.length ? h('table', { class: 'grid-table an-table' },
        h('thead', null, h('tr', null, h('th', null, h('span', { class: 'th-av' }, 'בית עסק')), h('th', { class: 'num-col' }, 'ביקורים'), h('th', null, 'ביקורים בחודש'), h('th', null, 'קנייה ממוצעת'), h('th', null, 'מה השתנה'))),
        h('tbody', null, p.merchants.map((m) => h('tr', null,
          h('td', null, itemButton(m.key, select, [avatarOf(m.description, { size: 'av-sm' }), h('bdi', null, m.description)], `${m.description}: הצגת הקנייה הממוצעת לפי חודש`)),
          h('td', { class: 'num-col' }, h('bdi', { class: 'num' }, intText(m.visits))),
          h('td', null, m.frequency ? ['מ-', h('bdi', { class: 'num' }, m.frequency.from.toFixed(1)), ' ל-', h('bdi', { class: 'num' }, m.frequency.to.toFixed(1))] : '–'),
          h('td', null, m.ticket ? ['מ-', money(m.ticket.from, { decimals: 0 }), ' ל-', money(m.ticket.to, { decimals: 0 })] : '–'),
          h('td', null, !m.enoughData ? h('span', { class: 'rc-same' }, 'מעט מדי ביקורים להשוואה')
            : m.driver === 'none' ? h('span', { class: 'rc-same' }, DRIVER.none)
              : h('span', { class: ['badge', (m.yearlyEffect?.total ?? 0) > 0 ? 'b-up' : 'b-down'] }, DRIVER[m.driver])))))) : h('p', { class: 'empty-line' }, 'עוד אין בית עסק עם מספיק ביקורים.'));
  }

  offs.push(on('data-changed', load));
  load();

  return {
    update(p) {
      const nextEnd = p.end || null;
      const nextTab = p.tab === 'prices' ? 'prices' : 'year';
      if (p.item) selected = p.item;
      if (nextEnd !== end && !(nextEnd === null && data)) { end = nextEnd; load(); return; }
      if (nextTab !== tab) { tab = nextTab; if (data) render(); }
    },
    destroy() { ctrl?.abort(); offs.forEach((f) => f()); },
    refresh: load,
    prevMonth() { const l = data?.annual.availableEnds || []; const i = l.indexOf(end); if (i >= 0 && l[i + 1]) go('annual', { end: l[i + 1], tab: tab === 'prices' ? 'prices' : undefined }); },
    nextMonth() { const l = data?.annual.availableEnds || []; const i = l.indexOf(end); if (i > 0) go('annual', { end: l[i - 1], tab: tab === 'prices' ? 'prices' : undefined }); },
  };
}
