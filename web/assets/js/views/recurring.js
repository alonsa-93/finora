// קבועים: subscriptions and fixed charges, what they cost per month and per year, and what got pricier.
import { h, icon, sevGlyph, mount, avatarOf } from '../dom.js';
import { api } from '../api.js';
import { categoryById, rememberMerchants, on } from '../store.js';
import { go } from '../router.js';
import { setWhere } from '../shell.js';
import { openMenu } from '../layers.js';
import { isNum, money, moneyText, dateLong, daysUntil, intText, pctText, monthLabel } from '../format.js';
import { errorState, emptyState, skeletonList, pageHead } from './common.js';

const CADENCE = { weekly: 'שבועי', monthly: 'חודשי', bimonthly: 'דו-חודשי', quarterly: 'רבעוני', semiannual: 'חצי שנתי', yearly: 'שנתי', annual: 'שנתי' };

export function mountRecurring(container) {
  let ctrl, list = [], onlyUp = false;
  const view = h('div', { class: 'rc' });
  container.replaceChildren(view);
  setWhere('recurring');
  const offs = [on('data-changed', load)];

  async function load() {
    ctrl?.abort(); ctrl = new AbortController();
    mount(view, bar(), h('div', { class: 'page rc-pad', 'aria-busy': 'true' },
      h('span', { class: 'sr-only', role: 'status' }, 'טוען חיובים קבועים…'),
      h('div', { class: 'rc-summary', 'aria-hidden': 'true' }, [1, 2, 3, 4].map(() => h('div', { class: 'rc-sk' }, h('span', { class: 'sk' }), h('span', { class: 'sk' })))),
      h('div', { class: 'panel rc-panel' }, skeletonList(8))));
    try {
      const res = await api.recurring({ signal: ctrl.signal });
      list = Array.isArray(res) ? res : [];
      rememberMerchants(list.map((r) => r.description));
      render();
    } catch (e) {
      if (e.name === 'AbortError') return;
      mount(view, bar(), h('div', { class: 'page rc-pad' }, h('div', { class: 'panel' }, errorState('לא הצלחנו לטעון את החיובים הקבועים', e.message, load))));
    }
  }

  function bar() {
    const cb = h('input', { type: 'checkbox', checked: onlyUp });
    cb.addEventListener('change', () => { onlyUp = cb.checked; render(); });
    const sub = list.length ? `${intText(list.length)} חיובים שחוזרים באותו סכום ובמרווחים קבועים` : 'מנויים, הוראות קבע וחשבונות שחוזרים';
    return pageHead('חיובים קבועים', sub,
      list.some((r) => r.priceChange && r.priceChange.to > r.priceChange.from) ? h('label', { class: 'check' }, cb, 'רק כאלה שהתייקרו בשנה האחרונה') : null);
  }

  function render() {
    const yearly = list.reduce((s, r) => s + (isNum(r.yearlyCost) ? r.yearlyCost : 0), 0);
    const ups = list.filter((r) => r.priceChange && isNum(r.priceChange.from) && isNum(r.priceChange.to) && r.priceChange.to > r.priceChange.from);
    const rows = onlyUp ? ups : list;
    const summary = h('div', { class: 'rc-summary' },
      h('div', { class: 'rc-main' }, h('span', { class: 'k' }, 'עולים לך בממוצע לחודש'), h('span', { class: 'v' }, money(yearly / 12, { decimals: 0 }))),
      h('div', null, h('span', { class: 'k' }, 'בשנה'), h('span', { class: 'v' }, money(yearly, { decimals: 0 }))),
      h('div', null, h('span', { class: 'k' }, 'חיובים שזוהו'), h('span', { class: 'v num' }, intText(list.length))),
      ups.length ? h('div', { class: 'warn' }, h('span', { class: 'k' }, h('span', { class: 'sev', dataset: { sev: 'alert' } }, sevGlyph('alert'), 'התייקרו')), h('span', { class: 'v' }, h('bdi', { class: 'num' }, intText(ups.length)), ' ',
        h('span', { class: 'v-sub' }, 'תוספת של ', money(ups.reduce((s, r) => s + (r.priceChange.to - r.priceChange.from) * (yearFactor(r)), 0), { decimals: 0 }), ' בשנה'))) : null);
    const explain = h('p', { class: 'rc-explain' }, 'חיובים שחזרו באותו סכום בערך ובמרווחים קבועים. "לחודש" הוא העלות השנתית חלקי 12, כדי שחיוב דו-חודשי או שנתי יהיה בר השוואה. "מחיר" הוא השינוי האחרון ב-12 החודשים האחרונים, באותה הגדרה כמו במגמות המחירים: שינוי נספר רק אחרי שהמחיר הישן חויב לפחות פעמיים. Enter או לחיצה כפולה פותחים את התנועות של החיוב.');

    if (!list.length) {
      mount(view, bar(), h('div', { class: 'page rc-pad' }, h('div', { class: 'panel' }, emptyState({ icon: 'repeat', title: 'עוד לא זוהו חיובים קבועים', text: 'צריך לפחות חודשיים-שלושה של תנועות כדי לזהות מנויים והוראות קבע.' }))));
      return;
    }
    const maxYear = Math.max(1, ...list.map((r) => (isNum(r.yearlyCost) ? r.yearlyCost : 0)));
    const tbody = h('tbody', null, rows.map((r) => rowFor(r, maxYear)));
    mount(view, bar(), h('div', { class: 'page rc-pad' }, summary, h('div', { class: 'panel rc-panel' }, explain,
      h('table', { class: 'grid-table rc-table', 'aria-label': 'חיובים קבועים' },
        h('thead', null, h('tr', null,
          h('th', { class: 'th-av' }, 'שם'), h('th', null, 'קטגוריה'),
          h('th', { class: 'num-col' }, 'כל חיוב'), h('th', { class: 'num-col' }, 'לחודש'), h('th', { class: 'num-col rc-year-h' }, 'לשנה'),
          h('th', null, 'החיוב הבא'), h('th', null, 'מחיר'))),
        tbody))));
  }

  /** "התייקר ב-10% במרץ 2026" + from/to: the same definition and words as the price-trends screen. */
  function priceTag(pc, up) {
    const pct = isNum(pc.pct) ? pc.pct : ((pc.to - pc.from) / pc.from) * 100;
    const when = pc.date ? monthLabel(String(pc.date).slice(0, 7)) : null;
    return h('span', { class: 'rc-price' },
      h('span', { class: ['badge', up ? 'b-up' : 'b-down'] }, up ? 'התייקר ב-' : 'הוזל ב-', h('bdi', { class: 'num' }, pctText(pct)), when ? ` ב${when}` : ''),
      h('span', { class: 'cell-sub' }, 'מ-', h('bdi', { class: 'num' }, moneyText(pc.from)), ' ל-', h('bdi', { class: 'num' }, moneyText(pc.to)),
        pc.confirmed === false ? ' · חויב פעם אחת במחיר החדש' : ''));
  }

  function yearFactor(r) {
    return isNum(r.yearlyCost) && isNum(r.amount) && r.amount > 0 ? r.yearlyCost / r.amount : 12;
  }

  function rowFor(r, maxYear) {
    const cat = categoryById(r.category);
    const pc = r.priceChange && isNum(r.priceChange.from) && isNum(r.priceChange.to) ? r.priceChange : null;
    const up = pc && pc.to > pc.from;
    const next = daysUntil(r.nextDate);
    const tr = h('tr', { tabindex: '0', class: up ? 'is-up' : null, title: 'Enter: כל התנועות של החיוב הזה' },
      h('td', { class: 'rc-name' }, h('div', { class: 'cell-m' }, avatarOf(r.description, { color: cat?.color || 'var(--ink-4)' }),
        h('span', { class: 'cell-t' }, h('bdi', { class: 'cell-n' }, r.description || ''), h('span', { class: 'cell-sub' }, `נראה ב-${intText(r.monthsSeen)} חודשים`)))),
      h('td', { class: 'rc-cat' }, h('span', { class: 'cat-name' }, h('span', { class: 'swatch', style: { background: cat?.color || 'var(--ink-4)' } }), cat?.name || 'ללא קטגוריה')),
      h('td', { class: 'num-col rc-each' }, h('span', { class: 'rc-v' }, money(r.amount, { decimals: 2 })), h('span', { class: 'cell-sub' }, CADENCE[r.cadence] || r.cadence || '')),
      h('td', { class: 'num-col' }, h('span', { class: 'rc-v' }, money(isNum(r.yearlyCost) ? r.yearlyCost / 12 : null, { decimals: 0 }))),
      h('td', { class: 'num-col rc-year' }, h('span', { class: 'rc-year-v' }, money(r.yearlyCost, { decimals: 0 })),
        h('span', { class: 'rc-bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.max(1, ((isNum(r.yearlyCost) ? r.yearlyCost : 0) / maxYear) * 100)}%` } }))),
      h('td', { class: 'rc-next' }, r.nextDate ? [h('span', { class: 'rc-date' }, dateLong(r.nextDate), next ? h('span', { class: 'rc-in' }, ` · ${next}`) : null)] : h('span', { class: 'rc-date' }, 'לא ידוע'),
        h('span', { class: 'cell-sub' }, 'אחרון ', dateLong(r.lastDate))),
      h('td', { class: 'rc-price-cell' }, pc ? priceTag(pc, up) : h('span', { class: 'rc-same' }, r.variable ? 'משתנה לפי צריכה' : 'ללא שינוי בשנה האחרונה')));
    const open = () => go('transactions', { q: r.description });
    tr.addEventListener('dblclick', open);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
      else if (e.key === 'ArrowDown') { e.preventDefault(); tr.nextElementSibling?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); tr.previousElementSibling?.focus(); }
      else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); menu({ anchor: tr.firstChild }); }
    });
    const menu = (pos) => openMenu(pos, [
      { label: 'כל התנועות של החיוב', icon: 'list', kbd: 'Enter', onSelect: open },
      { label: 'הקטגוריה הזו בתנועות', icon: 'tag', onSelect: () => go('transactions', { category: r.category }) },
    ], { label: r.description });
    tr.addEventListener('contextmenu', (e) => { e.preventDefault(); tr.focus(); menu({ x: e.clientX, y: e.clientY }); });
    tr.addEventListener('click', () => tr.focus());
    return tr;
  }

  load();
  return { destroy() { ctrl?.abort(); offs.forEach((f) => f()); }, refresh: load };
}

export { icon };
