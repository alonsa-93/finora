// Charts of the main dashboard's "where do I stand" part: the bank balance day by day and the card bill
// per month. Hand-built SVG like charts.js: time runs right-to-left (oldest at the right), a live text
// readout (hover / arrow keys) and a table alternative.
import { h, s, nextId } from './dom.js';
import { isNum, moneyText, intText, dateLong, monthShort, monthLabel } from './format.js';

function niceTicks(max, count = 4) {
  if (!isNum(max) || max <= 0) return [0, 1000];
  max = Math.max(max, 100);
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) || raw;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function responsive(host, draw) {
  let w = 0;
  const ro = new ResizeObserver((entries) => {
    const nw = Math.floor(entries[0].contentRect.width);
    if (nw > 0 && Math.abs(nw - w) > 2) { w = nw; draw(w); }
  });
  ro.observe(host);
  return () => ro.disconnect();
}

function barPath(x0, yTop, w, yBase) {
  const hgt = Math.max(0, yBase - yTop);
  if (hgt < 0.5) return '';
  const r = Math.min(3, w / 2, hgt);
  return `M${x0} ${yBase}V${yTop + r}Q${x0} ${yTop} ${x0 + r} ${yTop}H${x0 + w - r}Q${x0 + w} ${yTop} ${x0 + w} ${yTop + r}V${yBase}Z`;
}

const isNext = (a, b) => {
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return y2 * 12 + m2 === y1 * 12 + m1 + 1;
};

/* ======================= bank balance over the picked months ======================= */
/** The bank balance day by day across the picked months. Months that are not next to each other are
 *  separate stretches; days before the known history are left out. */
export function balanceChart({ months = [], height = 230 }) {
  const readout = h('p', { class: 'chart-readout', 'aria-live': 'polite' });
  const host = h('div', { class: 'chart-host' });
  const root = h('figure', { class: 'chart bal-chart' }, readout, host);
  const cell = (v, sign) => h('td', { class: 'end' }, h('bdi', { class: 'num' }, isNum(v) ? moneyText(v, { sign, decimals: 0 }) : '–'));
  const table = h('table', { class: 'grid-table compact' },
    h('caption', { class: 'sr-only' }, 'יתרת הבנק לפי חודש'),
    h('thead', null, h('tr', null, h('th', null, 'חודש'), h('th', { class: 'end' }, 'בתחילת החודש'), h('th', { class: 'end' }, 'בסוף החודש'),
      h('th', { class: 'end' }, 'הכי נמוכה'), h('th', { class: 'end' }, 'נכנס'), h('th', { class: 'end' }, 'יצא'))),
    h('tbody', null, [...months].reverse().map((m) => h('tr', null,
      h('td', null, monthLabel(m.month)),
      cell(m.open, 'negative'), cell(m.close, 'negative'), cell(m.low, 'negative'), cell(m.in), cell(m.out)))));

  const pts = [];
  months.forEach((m, mi) => { for (const d of m.series || []) pts.push({ date: d.date, v: d.balance, mi }); });
  const known = pts.filter((p) => isNum(p.v));
  if (known.length < 2) {
    readout.textContent = 'אין עדיין מספיק היסטוריה של החשבון כדי לצייר מגמה.';
    return { el: root, table };
  }
  const n = pts.length;
  let sel = n - 1;
  while (sel > 0 && !isNum(pts[sel].v)) sel -= 1;
  const lo = Math.min(0, ...known.map((p) => p.v));
  const hi = Math.max(0, ...known.map((p) => p.v));
  const say = (i) => (isNum(pts[i].v)
    ? `${dateLong(pts[i].date)} · יתרה ${moneyText(pts[i].v, { sign: 'negative', decimals: 0 })}`
    : `${dateLong(pts[i].date)} · לפני תחילת ההיסטוריה`);
  const gid = nextId('balg');
  let svg;
  const draw = (W) => {
    const H = height;
    const pad = { top: 10, bottom: 24, start: 62, end: 8 };
    const pw = W - pad.start - pad.end, ph = H - pad.top - pad.bottom;
    const stepRaw = Math.max(1, hi - lo) / 3;
    const mag = 10 ** Math.floor(Math.log10(stepRaw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= stepRaw) || stepRaw;
    const ticks = [];
    for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.999; v += step) ticks.push(v);
    if (ticks.length < 2) ticks.push(ticks[0] + step);
    const yMin = ticks[0], yMax = ticks[ticks.length - 1];
    const x = (i) => W - pad.start - (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const y = (v) => pad.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
    const g = [];
    for (const t of ticks) {
      g.push(s('line', { x1: pad.end, x2: W - pad.start, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }));
      g.push(s('text', { x: W - pad.start + 10, y: y(t) + 4, class: 'tick', 'text-anchor': 'start' }, t === 0 ? '0' : intText(t)));
    }
    const runs = [];
    let cur = [];
    pts.forEach((p, i) => {
      const gap = i > 0 && p.mi !== pts[i - 1].mi && !isNext(months[pts[i - 1].mi].month, months[p.mi].month);
      if ((!isNum(p.v) || gap) && cur.length) { runs.push(cur); cur = []; }
      if (isNum(p.v)) cur.push(i);
    });
    if (cur.length) runs.push(cur);
    g.push(s('defs', null, s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 },
      s('stop', { offset: '0', class: 'area-stop-1' }), s('stop', { offset: '1', class: 'area-stop-2' }))));
    const base = y(Math.max(yMin, 0));
    for (const r of runs) {
      const line = r.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(pts[i].v).toFixed(1)}`).join('');
      g.push(s('path', { d: `${line}L${x(r[r.length - 1]).toFixed(1)} ${base}L${x(r[0]).toFixed(1)} ${base}Z`, fill: `url(#${gid})` }));
      g.push(s('path', { d: line, class: 'line-now' }));
    }
    let lastLabelX = Infinity;
    pts.forEach((p, i) => {
      if (!(i === 0 || p.mi !== pts[i - 1].mi)) return;
      if (Math.abs(lastLabelX - x(i)) < 34) return;
      lastLabelX = x(i);
      g.push(s('text', { x: x(i), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, monthShort(p.date.slice(0, 7))));
    });
    const rule = s('line', { y1: pad.top, y2: pad.top + ph, class: 'hover-rule' });
    const dot = s('circle', { r: 4.5, class: 'dot-now' });
    g.push(rule, dot);
    const setSel = () => {
      const p = pts[sel];
      rule.setAttribute('x1', x(sel)); rule.setAttribute('x2', x(sel));
      if (isNum(p.v)) { dot.setAttribute('cx', x(sel)); dot.setAttribute('cy', y(p.v)); dot.style.display = ''; } else dot.style.display = 'none';
      readout.textContent = say(sel);
    };
    setSel();
    const next = s('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: '0', role: 'img', direction: 'ltr',
      'aria-label': 'יתרת הבנק יום אחר יום. חיצים עוברים בין ימים, Page Up ו-Page Down בין שבועות.',
    }, g);
    next.addEventListener('mousemove', (e) => {
      const r = next.getBoundingClientRect();
      sel = Math.max(0, Math.min(n - 1, Math.round(((W - pad.start - (e.clientX - r.left)) / pw) * (n - 1))));
      setSel();
    });
    next.addEventListener('keydown', (e) => {
      const by = { ArrowLeft: 1, ArrowRight: -1, PageDown: 7, PageUp: -7, Home: -n, End: n }[e.key];
      if (!by) return;
      e.preventDefault();
      sel = Math.max(0, Math.min(n - 1, sel + by));
      setSel();
    });
    if (svg) svg.replaceWith(next); else host.append(next);
    svg = next;
  };
  responsive(host, draw);
  return { el: root, table };
}

/* ======================= card bill per month, per card ======================= */
/** Stacked bars: each picked month's bill (by charge date), one colour per card, and a dashed line at
 *  the normal (average) bill. */
export function cardBillChart({ months = [], cards = [], average = null, height = 230 }) {
  // Fixed two-line readout: the month and its total, then one chip per card. Its height never
  // changes between months, so moving across the chart does not push the page.
  const readout = h('div', { class: 'chart-readout cro', 'aria-live': 'polite' });
  const host = h('div', { class: 'chart-host' });
  const root = h('figure', { class: 'chart card-chart' }, readout, host);
  const nameOf = (id) => cards.find((c) => c.id === id)?.name || '';
  const amountOf = (m, id) => m.byCard.find((b) => b.id === id)?.amount || 0;
  const table = h('table', { class: 'grid-table compact' },
    h('caption', { class: 'sr-only' }, 'חיוב האשראי לפי חודש'),
    h('thead', null, h('tr', null, h('th', null, 'חודש'),
      ...cards.map((c) => h('th', { class: 'end' }, h('bdi', null, c.name))), h('th', { class: 'end' }, 'סך הכול'))),
    h('tbody', null, [...months].reverse().map((m) => h('tr', null,
      h('td', null, monthLabel(m.month)),
      ...cards.map((c) => h('td', { class: 'end' }, h('bdi', { class: 'num' }, moneyText(amountOf(m, c.id), { decimals: 0 })))),
      h('td', { class: 'end' }, h('bdi', { class: 'num' }, moneyText(m.total, { decimals: 0 })))))));
  const n = months.length;
  if (!n || !months.some((m) => m.total > 0)) {
    readout.textContent = 'אין חיובי אשראי בחודשים האלה.';
    return { el: root, table };
  }
  let sel = n - 1;
  const say = (i) => {
    const m = months[i];
    const diff = isNum(average) && average > 0 && m.total > 0 ? m.total - average : null;
    const main = h('div', { class: 'cro-main' },
      h('span', { class: 'cro-month' }, `${monthLabel(m.month)}${m.complete ? '' : ' (עד עכשיו)'}`),
      h('bdi', { class: 'num cro-total' }, moneyText(m.total, { decimals: 0 })),
      diff != null ? h('span', { class: `cro-vs ${diff > 0 ? 'up' : 'down'}` },
        `${moneyText(Math.abs(diff), { decimals: 0 })} ${diff > 0 ? 'יותר' : 'פחות'} מחודש רגיל`) : null);
    const parts = cards.length > 1 ? h('ul', { class: 'cro-parts', 'aria-label': 'לפי כרטיס' },
      cards.map((c, ci) => ({ c, ci, v: amountOf(m, c.id) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v)
        .map((x) => h('li', null, h('span', { class: `cro-key c${x.ci % 4}`, 'aria-hidden': 'true' }),
          h('bdi', null, nameOf(x.c.id)), h('bdi', { class: 'num' }, moneyText(x.v, { decimals: 0 }))))) : null;
    return [main, parts];
  };
  const maxVal = Math.max(1, average || 0, ...months.map((m) => m.total));
  let svg;
  const draw = (W) => {
    const H = height;
    const pad = { top: 10, bottom: 24, start: 56, end: 8 };
    const pw = W - pad.start - pad.end, ph = H - pad.top - pad.bottom;
    const ticks = niceTicks(maxVal, 3);
    const top = ticks[ticks.length - 1];
    const slot = pw / n;
    const bw = Math.min(34, Math.max(8, slot * 0.5));
    const cx = (i) => W - pad.start - slot * (i + 0.5);
    const y = (v) => pad.top + ph - (v / top) * ph;
    const g = [];
    for (const t of ticks) {
      g.push(s('line', { x1: pad.end, x2: W - pad.start, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }));
      g.push(s('text', { x: W - pad.start + 10, y: y(t) + 4, class: 'tick', 'text-anchor': 'start' }, t === 0 ? '0' : intText(t)));
    }
    const hl = s('rect', { y: pad.top - 4, height: ph + 4 + 18, width: slot - 2, class: 'slot-hl', rx: 3 });
    g.push(hl);
    months.forEach((m, i) => {
      let acc = 0;
      const parts = cards.map((c, ci) => ({ v: amountOf(m, c.id), ci })).filter((p) => p.v > 0);
      parts.forEach((p, k) => {
        const yTop = y(acc + p.v);
        const d = k === parts.length - 1 ? barPath(cx(i) - bw / 2, yTop, bw, y(acc))
          : `M${cx(i) - bw / 2} ${y(acc)}V${yTop}H${cx(i) + bw / 2}V${y(acc)}Z`;
        g.push(s('path', { d, class: `bar-card c${p.ci % 4}${m.complete ? '' : ' partial'}` }));
        acc += p.v;
      });
      g.push(s('text', { x: cx(i), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, monthShort(m.month)));
    });
    if (isNum(average) && average > 0) g.push(s('line', { x1: pad.end, x2: W - pad.start, y1: y(average), y2: y(average), class: 'avg-line' }));
    const setSel = () => { hl.setAttribute('x', cx(sel) - (slot - 2) / 2); readout.replaceChildren(...say(sel).filter(Boolean)); };
    setSel();
    const next = s('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: '0', role: 'img', direction: 'ltr',
      'aria-label': 'חיוב האשראי בכל חודש לפי כרטיס, עם קו של חודש רגיל. חיצים עוברים בין חודשים.',
    }, g);
    const idxAt = (e) => { const r = next.getBoundingClientRect(); return Math.min(n - 1, Math.max(0, Math.floor((W - pad.start - (e.clientX - r.left)) / slot))); };
    next.addEventListener('mousemove', (e) => { sel = idxAt(e); setSel(); });
    next.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') sel = Math.min(n - 1, sel + 1);
      else if (e.key === 'ArrowRight') sel = Math.max(0, sel - 1);
      else return;
      e.preventDefault();
      setSel();
    });
    if (svg) svg.replaceWith(next); else host.append(next);
    svg = next;
  };
  responsive(host, draw);
  return { el: root, table };
}
