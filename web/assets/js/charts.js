// Hand-built SVG charts. Time runs right-to-left (day 1 / oldest month at the right), matching Hebrew reading order.
// Every chart has a live text readout (hover / arrow keys) and a table alternative.
import { h, s, nextId } from './dom.js';
import { isNum, moneyText, intText, dateLong, monthShort, monthShortYear, monthLabel, parseDate } from './format.js';

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

/** Re-render on size changes so text never scales. */
function responsive(host, draw) {
  let w = 0;
  const ro = new ResizeObserver((entries) => {
    const nw = Math.floor(entries[0].contentRect.width);
    if (nw > 0 && Math.abs(nw - w) > 2) { w = nw; draw(w); }
  });
  ro.observe(host);
  return () => ro.disconnect();
}

/* ======================= cumulative spend: this month vs last ======================= */
export function cumulativeChart({ daily = [], forecast = null, isCurrentMonth, dayOfMonth, height = 236, nowLabel = 'החודש', prevLabel = 'החודש הקודם' }) {
  const n = daily.length;
  const readout = h('p', { class: 'chart-readout', 'aria-live': 'polite' });
  const host = h('div', { class: 'chart-host' });
  const root = h('figure', { class: 'chart cum-chart' }, readout, host);
  const hasData = daily.some((d) => (isNum(d.cumulative) && d.cumulative > 0) || (isNum(d.prevCumulative) && d.prevCumulative > 0));
  if (!n || !hasData) { readout.textContent = 'אין עדיין הוצאות בחודש הזה או בחודש שלפניו, אז אין מה לשרטט.'; return { el: root, table: h('p', null, 'אין נתונים.') }; }

  const lastIdx = isCurrentMonth && isNum(dayOfMonth) ? Math.min(n, dayOfMonth) - 1 : daily.reduce((m, d, i) => (isNum(d.cumulative) ? i : m), -1);
  const maxVal = Math.max(1, ...daily.map((d) => (isNum(d.cumulative) ? d.cumulative : 0)), ...daily.map((d) => (isNum(d.prevCumulative) ? d.prevCumulative : 0)),
    forecast && isNum(forecast.high) ? forecast.high : 0);
  let sel = Math.max(0, lastIdx);

  const label = (i) => {
    const d = daily[i];
    if (!d) return '';
    const parts = [dateLong(d.date)];
    parts.push(isNum(d.cumulative) ? `הוצאת עד אז ${moneyText(d.cumulative)}` : 'עוד לא הגיע');
    if (isNum(d.prevCumulative)) parts.push(`בחודש הקודם באותו יום ${moneyText(d.prevCumulative)}`);
    return parts.join(' · ');
  };

  let svg;
  const gradId = nextId('cum-grad');
  const draw = (W) => {
    const H = height;
    const hasFc = forecast && isNum(forecast.low) && isNum(forecast.high);
    const pad = { top: 22, bottom: 24, start: 56, end: hasFc ? 78 : 16 };
    const pw = W - pad.start - pad.end, ph = H - pad.top - pad.bottom;
    const ticks = niceTicks(maxVal);
    const top = ticks[ticks.length - 1];
    // RTL: x grows to the left; "start" padding is on the right.
    const x = (i) => W - pad.start - (n === 1 ? 0 : (i / (n - 1)) * pw);
    const y = (v) => pad.top + ph - (v / top) * ph;

    const g = [];
    for (const t of ticks) {
      g.push(s('line', { x1: pad.end, x2: W - pad.start, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }));
      g.push(s('text', { x: W - pad.start + 10, y: y(t) + 4, class: 'tick', 'text-anchor': 'start', direction: 'ltr' }, t === 0 ? '0' : intText(t)));
    }
    // day labels: 1, every 5th, last
    for (let i = 0; i < n; i++) {
      const day = i + 1;
      if (day === 1 || (day % 5 === 0 && n - day >= 3) || day === n) g.push(s('text', { x: x(i), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, String(day)));
    }
    const path = (key, upto = n - 1) => {
      let d = '';
      for (let i = 0; i <= upto; i++) { const v = daily[i]?.[key]; if (!isNum(v)) continue; d += `${d ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; }
      return d;
    };
    g.push(s('path', { d: path('prevCumulative'), class: 'line-prev' }));
    const labels = [];   // direct labels instead of a legend: [x, y, anchor, text, cls]
    let prevEnd = -1;
    daily.forEach((d, i) => { if (isNum(d.prevCumulative)) prevEnd = i; });
    if (prevEnd >= 0) {
      const px = x(prevEnd), py = y(daily[prevEnd].prevCumulative);
      labels.push({ x: px + 6, y: py - 9, anchor: 'start', text: prevLabel, cls: 'dl dl-prev' });
    }
    if (lastIdx >= 0) {
      const area = path('cumulative', lastIdx);
      if (area) {
        // a soft coral wash under this month's line, fading to nothing at the baseline
        g.push(s('defs', null, s('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 },
          s('stop', { offset: 0, class: 'area-stop-1' }), s('stop', { offset: 1, class: 'area-stop-2' }))));
        g.push(s('path', { d: `${area}L${x(lastIdx).toFixed(1)} ${y(0)}L${x(0).toFixed(1)} ${y(0)}Z`, class: 'area-now', fill: `url(#${gradId})` }));
      }
      g.push(s('path', { d: area, class: 'line-now' }));
      if (isNum(daily[lastIdx].cumulative)) {
        const cx = x(lastIdx), cy = y(daily[lastIdx].cumulative);
        g.push(s('circle', { cx, cy, r: 8, class: 'dot-halo' }));
        g.push(s('circle', { cx, cy, r: 4, class: 'dot-now' }));
        // centred above the dot while there is room; at the left edge (a finished month) to its right
        const atEdge = cx - pad.end < 60;
        labels.push({ x: atEdge ? cx + 10 : cx, y: cy - 14, anchor: atEdge ? 'start' : 'middle', text: nowLabel, cls: 'dl dl-now' });
      }
    }
    if (hasFc) {
      const fx = pad.end - 26;
      const mid = forecast.projectedExpenses ?? (forecast.low + forecast.high) / 2;
      if (lastIdx >= 0 && isNum(daily[lastIdx].cumulative)) {
        g.push(s('line', { x1: x(lastIdx), y1: y(daily[lastIdx].cumulative), x2: fx, y2: y(mid), class: 'line-forecast' }));
      }
      g.push(s('rect', { x: fx - 5, y: y(forecast.high), width: 10, height: Math.max(3, y(forecast.low) - y(forecast.high)), rx: 2, class: 'fc-range' }));
      g.push(s('line', { x1: fx - 8, x2: fx + 8, y1: y(mid), y2: y(mid), class: 'fc-mid' }));
      g.push(s('text', { x: fx - 12, y: y(mid) - 3, class: 'dl dl-fc', 'text-anchor': 'end' }, 'צפי'));
      g.push(s('text', { x: fx - 12, y: y(mid) + 12, class: 'tick', 'text-anchor': 'end', direction: 'ltr' }, intText(Math.round(mid / 10) * 10)));
    }
    // keep two direct labels from overlapping: push the lower one down
    if (labels.length === 2 && Math.abs(labels[0].y - labels[1].y) < 15 && Math.abs(labels[0].x - labels[1].x) < 90) {
      const [hi, lo] = labels[0].y <= labels[1].y ? labels : [labels[1], labels[0]];
      lo.y = hi.y + 15;
    }
    for (const l of labels) g.push(s('text', { x: l.x, y: Math.max(12, l.y), class: l.cls, 'text-anchor': l.anchor }, l.text));
    // hover rule
    const rule = s('line', { y1: pad.top, y2: pad.top + ph, class: 'hover-rule' });
    g.push(rule);
    const setRule = () => { rule.setAttribute('x1', x(sel)); rule.setAttribute('x2', x(sel)); readout.textContent = label(sel); };
    setRule();

    const next = s('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: '0', role: 'img', direction: 'ltr',
      'aria-label': 'הוצאה מצטברת לפי יום בחודש, בהשוואה לחודש הקודם. חיצים ימינה ושמאלה עוברים בין הימים.',
    }, g);
    next.addEventListener('mousemove', (e) => {
      const r = next.getBoundingClientRect();
      const px = e.clientX - r.left;
      sel = Math.round(((W - pad.start - px) / pw) * (n - 1));
      sel = Math.min(n - 1, Math.max(0, sel));
      setRule();
    });
    next.addEventListener('mouseleave', () => { sel = Math.max(0, lastIdx); setRule(); });
    next.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') sel = Math.min(n - 1, sel + 1);       // left = later
      else if (e.key === 'ArrowRight') sel = Math.max(0, sel - 1);
      else if (e.key === 'Home') sel = 0;
      else if (e.key === 'End') sel = n - 1;
      else return;
      e.preventDefault(); setRule();
    });
    if (svg) svg.replaceWith(next); else host.append(next);
    svg = next;
  };
  responsive(host, draw);

  const table = h('table', { class: 'grid-table compact' },
    h('caption', { class: 'sr-only' }, 'הוצאה מצטברת לפי יום'),
    h('thead', null, h('tr', null, h('th', null, 'יום'), h('th', { class: 'end' }, 'החודש'), h('th', { class: 'end' }, 'החודש הקודם'))),
    h('tbody', null, daily.map((d) => h('tr', null,
      h('td', null, dateLong(d.date)),
      h('td', { class: 'end' }, h('bdi', { class: 'num' }, isNum(d.cumulative) ? moneyText(d.cumulative) : '–')),
      h('td', { class: 'end' }, h('bdi', { class: 'num' }, isNum(d.prevCumulative) ? moneyText(d.prevCumulative) : '–'))))));
  return { el: root, table };
}

/** Bar with a rounded data end and a square foot on the baseline. */
function barPath(x0, yTop, w, yBase) {
  const hgt = Math.max(0, yBase - yTop);
  if (hgt < 0.5) return '';
  const r = Math.min(3, w / 2, hgt);
  return `M${x0} ${yBase}V${yTop + r}Q${x0} ${yTop} ${x0 + r} ${yTop}H${x0 + w - r}Q${x0 + w} ${yTop} ${x0 + w} ${yTop + r}V${yBase}Z`;
}

/* ======================= 12 months: income vs expenses ======================= */
export function monthlyChart({ monthly = [], selected, onPick, height = 190 }) {
  const n = monthly.length;
  const readout = h('p', { class: 'chart-readout', 'aria-live': 'polite' });
  const host = h('div', { class: 'chart-host' });
  const root = h('figure', { class: 'chart month-chart' }, readout, host);
  if (!n || !monthly.some((m) => (m.income || 0) > 0 || (m.expenses || 0) > 0)) { readout.textContent = 'אין עדיין היסטוריה חודשית.'; return { el: root, table: h('p', null, 'אין נתונים.') }; }
  let sel = Math.max(0, monthly.findIndex((m) => m.month === selected));
  if (sel < 0) sel = n - 1;
  const label = (i) => {
    const m = monthly[i];
    const net = (m.income ?? 0) - (m.expenses ?? 0);
    return `${monthLabel(m.month)} · הכנסות ${moneyText(m.income)} · הוצאות ${moneyText(m.expenses)} · ${net >= 0 ? 'נשאר' : 'חסר'} ${moneyText(Math.abs(net))}`;
  };
  const maxVal = Math.max(1, ...monthly.map((m) => Math.max(m.income || 0, m.expenses || 0)));
  let svg;
  const draw = (W) => {
    const H = height;
    const pad = { top: 8, bottom: 24, start: 56, end: 8 };
    const pw = W - pad.start - pad.end, ph = H - pad.top - pad.bottom;
    const ticks = niceTicks(maxVal, 3);
    const top = ticks[ticks.length - 1];
    const slot = pw / n;
    const bw = Math.min(18, Math.max(5, slot * 0.27));
    const cx = (i) => W - pad.start - slot * (i + 0.5);          // oldest at the right
    const y = (v) => pad.top + ph - (v / top) * ph;
    const g = [];
    for (const t of ticks) {
      g.push(s('line', { x1: pad.end, x2: W - pad.start, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }));
      g.push(s('text', { x: W - pad.start + 10, y: y(t) + 4, class: 'tick', 'text-anchor': 'start' }, t === 0 ? '0' : intText(t)));
    }
    const hl = s('rect', { y: pad.top - 4, height: ph + 4 + 18, width: slot - 2, class: 'slot-hl', rx: 3 });
    g.push(hl);
    monthly.forEach((m, i) => {
      const inc = m.income || 0, exp = m.expenses || 0;
      // in RTL the first bar of a pair (income) sits to the right
      g.push(s('path', { d: barPath(cx(i) + 1, y(inc), bw, y(0)), class: 'bar-in' }));
      g.push(s('path', { d: barPath(cx(i) - bw - 1, y(exp), bw, y(0)), class: ['bar-out', exp > inc && 'over'].filter(Boolean).join(' ') }));
      g.push(s('text', { x: cx(i), y: H - 6, class: ['tick', m.month === selected && 'strong'].filter(Boolean).join(' '), 'text-anchor': 'middle' }, monthShort(m.month)));
    });
    const setSel = () => { hl.setAttribute('x', cx(sel) - (slot - 2) / 2); readout.textContent = label(sel); };
    setSel();
    const next = s('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: '0', role: 'img', direction: 'ltr',
      'aria-label': 'הכנסות מול הוצאות ב-12 החודשים האחרונים. חיצים עוברים בין חודשים, Enter פותח את החודש.',
    }, g);
    const idxAt = (e) => { const r = next.getBoundingClientRect(); return Math.min(n - 1, Math.max(0, Math.floor((W - pad.start - (e.clientX - r.left)) / slot))); };
    next.addEventListener('mousemove', (e) => { sel = idxAt(e); setSel(); });
    next.addEventListener('click', (e) => { sel = idxAt(e); onPick?.(monthly[sel].month); });
    next.style.cursor = onPick ? 'pointer' : '';
    next.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') sel = Math.min(n - 1, sel + 1);
      else if (e.key === 'ArrowRight') sel = Math.max(0, sel - 1);
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick?.(monthly[sel].month); return; }
      else return;
      e.preventDefault(); setSel();
    });
    if (svg) svg.replaceWith(next); else host.append(next);
    svg = next;
  };
  responsive(host, draw);
  const table = h('table', { class: 'grid-table compact' },
    h('caption', { class: 'sr-only' }, 'הכנסות והוצאות לפי חודש'),
    h('thead', null, h('tr', null, h('th', null, 'חודש'), h('th', { class: 'end' }, 'הכנסות'), h('th', { class: 'end' }, 'הוצאות'), h('th', { class: 'end' }, 'הפרש'))),
    h('tbody', null, [...monthly].reverse().map((m) => h('tr', null,
      h('td', null, monthLabel(m.month)),
      h('td', { class: 'end' }, h('bdi', { class: 'num' }, moneyText(m.income))),
      h('td', { class: 'end' }, h('bdi', { class: 'num' }, moneyText(m.expenses))),
      h('td', { class: 'end' }, h('bdi', { class: 'num' }, moneyText((m.income || 0) - (m.expenses || 0), { sign: 'negative' })))))));
  return { el: root, table };
}

/* ======================= a year: income vs expenses with trend lines ======================= */
/** Like monthlyChart, plus a dashed least-squares line per series (from the server's trend fit).
 *  Months without data (before the first full month) get no bars and say so in the readout. */
export function trendChart({ monthly = [], trends = {}, height = 230, onPick }) {
  const n = monthly.length;
  const readout = h('p', { class: 'chart-readout', 'aria-live': 'polite' });
  const host = h('div', { class: 'chart-host' });
  const root = h('figure', { class: 'chart month-chart trend-chart' }, readout, host);
  if (!n || !monthly.some((m) => m.covered)) { readout.textContent = 'אין עדיין חודשים מלאים להצגה.'; return { el: root, table: h('p', null, 'אין נתונים.') }; }
  const covered = monthly.map((m, i) => (m.covered ? i : -1)).filter((i) => i >= 0);
  let sel = covered[covered.length - 1];
  const trendText = (t, what) => (t ? `${what} ${t.label}${t.direction === 'flat' ? '' : ` (${t.slopePerMonth >= 0 ? '+' : '−'}${moneyText(Math.abs(t.slopePerMonth), { decimals: 0 })} בחודש)`}` : null);
  const label = (i) => {
    const m = monthly[i];
    if (!m.covered) return `${monthLabel(m.month)} · אין נתונים מלאים לחודש הזה`;
    const net = (m.income ?? 0) - (m.expenses ?? 0);
    return `${monthLabel(m.month)} · הכנסות ${moneyText(m.income, { decimals: 0 })} · הוצאות ${moneyText(m.expenses, { decimals: 0 })} · ${net >= 0 ? 'נשאר' : 'חסר'} ${moneyText(Math.abs(net), { decimals: 0 })}`;
  };
  const maxVal = Math.max(1, ...monthly.map((m) => Math.max(m.income || 0, m.expenses || 0)),
    ...['income', 'expenses'].flatMap((k) => (trends[k] ? [trends[k].start, trends[k].end] : [])));
  let svg;
  const draw = (W) => {
    const H = height;
    const pad = { top: 14, bottom: 26, start: 60, end: 10 };
    const pw = W - pad.start - pad.end, ph = H - pad.top - pad.bottom;
    const ticks = niceTicks(maxVal, 4);
    const top = ticks[ticks.length - 1];
    const slot = pw / n;
    const bw = Math.min(20, Math.max(5, slot * 0.28));
    const cx = (i) => W - pad.start - slot * (i + 0.5);          // oldest at the right
    const y = (v) => pad.top + ph - (Math.max(0, v) / top) * ph;
    const g = [];
    for (const t of ticks) {
      g.push(s('line', { x1: pad.end, x2: W - pad.start, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }));
      g.push(s('text', { x: W - pad.start + 10, y: y(t) + 4, class: 'tick', 'text-anchor': 'start' }, t === 0 ? '0' : intText(t)));
    }
    const hl = s('rect', { y: pad.top - 4, height: ph + 4 + 20, width: slot - 2, class: 'slot-hl', rx: 3 });
    g.push(hl);
    monthly.forEach((m, i) => {
      if (m.covered) {
        const inc = m.income || 0, exp = m.expenses || 0;
        g.push(s('path', { d: barPath(cx(i) + 1, y(inc), bw, y(0)), class: 'bar-in' }));
        g.push(s('path', { d: barPath(cx(i) - bw - 1, y(exp), bw, y(0)), class: ['bar-out', exp > inc && 'over'].filter(Boolean).join(' ') }));
      } else {
        g.push(s('text', { x: cx(i), y: y(0) - 6, class: 'tick nodata', 'text-anchor': 'middle' }, '–'));
      }
      g.push(s('text', { x: cx(i), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, monthShort(m.month)));
    });
    // trend lines across the covered months, labelled at the newest end (left)
    const first = covered[0], last = covered[covered.length - 1];
    const lines = [['income', 'tl-in', 'מגמת הכנסות'], ['expenses', 'tl-out', 'מגמת הוצאות']];
    const ends = [];
    for (const [k, cls, text] of lines) {
      const t = trends[k];
      if (!t || first === last) continue;
      g.push(s('line', { x1: cx(first), y1: y(t.start), x2: cx(last), y2: y(t.end), class: `trend-line ${cls}` }));
      ends.push({ x: cx(last) - 6, y: y(t.end), text, cls });
    }
    if (ends.length === 2 && Math.abs(ends[0].y - ends[1].y) < 16) {
      const [hi, lo] = ends[0].y <= ends[1].y ? ends : [ends[1], ends[0]];
      hi.y -= 8; lo.y += 8;
    }
    for (const e of ends) g.push(s('text', { x: e.x, y: e.y - 6, class: `dl ${e.cls}-l`, 'text-anchor': 'end' }, e.text));
    const setSel = () => { hl.setAttribute('x', cx(sel) - (slot - 2) / 2); readout.textContent = label(sel); };
    setSel();
    const next = s('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: '0', role: 'img', direction: 'ltr',
      'aria-label': `הכנסות מול הוצאות לפי חודש, הישן מימין, עם קווי מגמה. ${[trendText(trends.income, 'הכנסות'), trendText(trends.expenses, 'הוצאות')].filter(Boolean).join('. ')}. חיצים עוברים בין חודשים${onPick ? ', Enter פותח את החודש' : ''}.`,
    }, g);
    const idxAt = (e) => { const r = next.getBoundingClientRect(); return Math.min(n - 1, Math.max(0, Math.floor((W - pad.start - (e.clientX - r.left)) / slot))); };
    next.addEventListener('mousemove', (e) => { sel = idxAt(e); setSel(); });
    if (onPick) {
      next.addEventListener('click', (e) => { sel = idxAt(e); if (monthly[sel].covered) onPick(monthly[sel].month); });
      next.style.cursor = 'pointer';
    }
    next.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') sel = Math.min(n - 1, sel + 1);
      else if (e.key === 'ArrowRight') sel = Math.max(0, sel - 1);
      else if (e.key === 'Home') sel = 0;
      else if (e.key === 'End') sel = n - 1;
      else if ((e.key === 'Enter' || e.key === ' ') && onPick) { e.preventDefault(); if (monthly[sel].covered) onPick(monthly[sel].month); return; }
      else return;
      e.preventDefault(); setSel();
    });
    if (svg) svg.replaceWith(next); else host.append(next);
    svg = next;
  };
  responsive(host, draw);
  const table = h('table', { class: 'grid-table compact' },
    h('caption', { class: 'sr-only' }, 'הכנסות והוצאות לפי חודש'),
    h('thead', null, h('tr', null, h('th', null, 'חודש'), h('th', { class: 'end' }, 'הכנסות'), h('th', { class: 'end' }, 'הוצאות'), h('th', { class: 'end' }, 'הפרש'))),
    h('tbody', null, [...monthly].reverse().map((m) => h('tr', null,
      h('td', null, monthLabel(m.month)),
      m.covered ? [
        h('td', { class: 'end' }, h('bdi', { class: 'num' }, moneyText(m.income, { decimals: 0 }))),
        h('td', { class: 'end' }, h('bdi', { class: 'num' }, moneyText(m.expenses, { decimals: 0 }))),
        h('td', { class: 'end' }, h('bdi', { class: 'num' }, moneyText((m.income || 0) - (m.expenses || 0), { sign: 'negative', decimals: 0 }))),
      ] : h('td', { colspan: '3', class: 'end' }, 'אין נתונים מלאים')))),
    h('tfoot', null, [['income', 'מגמת הכנסות'], ['expenses', 'מגמת הוצאות']].filter(([k]) => trends[k]).map(([k, t]) => h('tr', null,
      h('th', { scope: 'row' }, t),
      h('td', { colspan: '3', class: 'end' }, `${trends[k].label}: `, h('bdi', { class: 'num' }, `${trends[k].slopePerMonth >= 0 ? '+' : '−'}${moneyText(Math.abs(trends[k].slopePerMonth), { decimals: 0 })}`), ' בחודש, ',
        'מ-', h('bdi', { class: 'num' }, moneyText(trends[k].start, { decimals: 0 })), ' ל-', h('bdi', { class: 'num' }, moneyText(trends[k].end, { decimals: 0 })))))));
  return { el: root, table };
}

/* ======================= price history with change points ======================= */
/**
 * points: [{ date: 'YYYY-MM-DD', value, note? }] in time order. kind 'step' (a recurring price: the
 * level holds until the next charge) or 'line' (monthly average purchase). changes: [{ date, from, to, pct }]
 * marked with a ring and a label. bands: [{ from, to, label, level }] shaded periods with a level line
 * (first / last 3 months of the merchant comparison). Time runs right-to-left like every chart here.
 */
export function priceChart({ points = [], changes = [], bands = [], kind = 'step', title = '', height = 230, valueLabel = 'מחיר' }) {
  const readout = h('p', { class: 'chart-readout', 'aria-live': 'polite' });
  const host = h('div', { class: 'chart-host' });
  const root = h('figure', { class: 'chart price-chart' }, readout, host);
  const pts = points.filter((p) => isNum(p.value) && parseDate(p.date));
  if (pts.length < 2) { readout.textContent = 'אין מספיק נקודות כדי לשרטט היסטוריה.'; return { el: root, table: h('p', null, 'אין נתונים.') }; }
  const day = (iso) => Math.round(parseDate(iso).getTime() / 86400000);
  const t0 = day(pts[0].date);
  const t1 = Math.max(t0 + 1, day(pts[pts.length - 1].date));
  const changeAt = new Map(changes.map((c) => [c.date, c]));
  const vals = [...pts.map((p) => p.value), ...bands.map((b) => b.level).filter(isNum)];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, hi * 0.08, 1);
  lo = Math.max(0, lo - span * 0.35); hi += span * 0.35;
  let sel = pts.length - 1;
  const label = (i) => {
    const p = pts[i];
    const c = changeAt.get(p.date);
    const parts = [kind === 'step' ? dateLong(p.date) : monthLabel(p.date.slice(0, 7)), `${valueLabel} ${moneyText(p.value)}`];
    if (p.note) parts.push(p.note);
    if (c) parts.push(`${c.to > c.from ? 'התייקר' : 'הוזל'} מ-${moneyText(c.from)} (${c.to > c.from ? '+' : '−'}${Math.round(Math.abs(c.pct ?? 0))}%)`);
    return parts.join(' · ');
  };
  let svg;
  const draw = (W) => {
    const H = height;
    const pad = { top: 26, bottom: 26, start: 64, end: 18 };
    const pw = W - pad.start - pad.end, ph = H - pad.top - pad.bottom;
    const x = (iso) => W - pad.start - ((day(iso) - t0) / (t1 - t0)) * pw;
    const y = (v) => pad.top + ph - ((v - lo) / (hi - lo)) * ph;
    const g = [];
    // value ticks: 3 lines across the visible range
    for (let k = 0; k <= 2; k++) {
      const v = lo + ((hi - lo) * k) / 2;
      g.push(s('line', { x1: pad.end, x2: W - pad.start, y1: y(v), y2: y(v), class: k === 0 ? 'axis' : 'grid' }));
      g.push(s('text', { x: W - pad.start + 10, y: y(v) + 4, class: 'tick', 'text-anchor': 'start' }, moneyText(v, { decimals: v < 100 ? 'auto' : 0 })));
    }
    // month ticks, thinned to fit
    const first = parseDate(pts[0].date);
    const months = [];
    for (let d = new Date(first.getFullYear(), first.getMonth() + 1, 1); day(isoOf(d)) <= t1; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(isoOf(d));
    const every = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor(pw / 64))));
    months.forEach((iso, k) => { if (k % every === 0) g.push(s('text', { x: x(iso), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, monthShortYear(iso.slice(0, 7)))); });
    for (const b of bands) {
      const xa = x(b.from), xb = x(b.to);
      g.push(s('rect', { x: Math.min(xa, xb), y: pad.top - 4, width: Math.abs(xa - xb), height: ph + 4, class: 'band', rx: 4 }));
      if (isNum(b.level)) g.push(s('line', { x1: xa, x2: xb, y1: y(b.level), y2: y(b.level), class: 'band-level' }));
      g.push(s('text', { x: (xa + xb) / 2, y: pad.top - 10, class: 'tick band-l', 'text-anchor': 'middle' }, b.label));
    }
    let d = '';
    pts.forEach((p, i) => {
      const px = x(p.date).toFixed(1), py = y(p.value).toFixed(1);
      if (!i) d = `M${px} ${py}`;
      else if (kind === 'step') d += `H${px}V${py}`;
      else d += `L${px} ${py}`;
    });
    g.push(s('path', { d, class: 'price-line' }));
    pts.forEach((p) => {
      const c = changeAt.get(p.date);
      if (c) {
        const up = c.to > c.from;
        g.push(s('line', { x1: x(p.date), x2: x(p.date), y1: pad.top - 2, y2: pad.top + ph, class: 'cp-rule' }));
        g.push(s('circle', { cx: x(p.date), cy: y(p.value), r: 7, class: `cp-ring ${up ? 'up' : 'down'}` }));
        g.push(s('text', { x: x(p.date), y: Math.max(12, y(p.value) - 13), class: `dl cp-l ${up ? 'up' : 'down'}`, 'text-anchor': 'middle' }, `${up ? '+' : '−'}${Math.round(Math.abs(c.pct ?? 0))}%`));
      }
      g.push(s('circle', { cx: x(p.date), cy: y(p.value), r: 3, class: 'price-dot' }));
    });
    const rule = s('line', { y1: pad.top, y2: pad.top + ph, class: 'hover-rule' });
    const focus = s('circle', { r: 5.5, class: 'price-focus' });
    g.push(rule, focus);
    const setSel = () => {
      const p = pts[sel];
      rule.setAttribute('x1', x(p.date)); rule.setAttribute('x2', x(p.date));
      focus.setAttribute('cx', x(p.date)); focus.setAttribute('cy', y(p.value));
      readout.textContent = label(sel);
    };
    setSel();
    const next = s('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: '0', role: 'img', direction: 'ltr',
      'aria-label': `${title}: היסטוריית ${valueLabel}, הישן מימין. ${changes.length ? `${changes.length === 1 ? 'שינוי אחד מסומן' : `${changes.length} שינויים מסומנים`} בעיגול. ` : ''}חיצים עוברים בין הנקודות.`,
    }, g);
    next.addEventListener('mousemove', (e) => {
      const r = next.getBoundingClientRect();
      const px = e.clientX - r.left;
      let best = 0, bd = Infinity;
      pts.forEach((p, i) => { const dd = Math.abs(x(p.date) - px); if (dd < bd) { bd = dd; best = i; } });
      sel = best; setSel();
    });
    next.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') sel = Math.min(pts.length - 1, sel + 1);     // left = later
      else if (e.key === 'ArrowRight') sel = Math.max(0, sel - 1);
      else if (e.key === 'Home') sel = 0;
      else if (e.key === 'End') sel = pts.length - 1;
      else return;
      e.preventDefault(); setSel();
    });
    if (svg) svg.replaceWith(next); else host.append(next);
    svg = next;
  };
  responsive(host, draw);
  const table = h('table', { class: 'grid-table compact' },
    h('caption', { class: 'sr-only' }, `${title}: היסטוריה`),
    h('thead', null, h('tr', null, h('th', null, kind === 'step' ? 'תאריך' : 'חודש'), h('th', { class: 'end' }, valueLabel), h('th', null, 'שינוי'))),
    h('tbody', null, [...pts].reverse().map((p) => {
      const c = changeAt.get(p.date);
      return h('tr', null,
        h('td', null, kind === 'step' ? dateLong(p.date) : monthLabel(p.date.slice(0, 7))),
        h('td', { class: 'end' }, h('bdi', { class: 'num' }, moneyText(p.value))),
        h('td', null, c ? [c.to > c.from ? 'התייקר מ-' : 'הוזל מ-', h('bdi', { class: 'num' }, moneyText(c.from))] : (p.note || '')));
    })));
  return { el: root, table };
}

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Panel with a chart/table switch in its header. */
export function chartPanel({ title, sub, legend, chart, className }) {
  const id = nextId('chart');
  let showTable = false;
  const body = h('div', { id }, chart.el);
  const toggle = h('button', { class: 'btn ghost small', type: 'button', 'aria-controls': id, 'aria-pressed': 'false' }, 'טבלה');
  toggle.addEventListener('click', () => {
    showTable = !showTable;
    body.replaceChildren(showTable ? h('div', { class: 'chart-table' }, chart.table) : chart.el);
    toggle.setAttribute('aria-pressed', String(showTable));
  });
  return h('section', { class: ['panel', className], 'aria-labelledby': `${id}-h` },
    h('div', { class: 'panel-head' }, h('h2', { id: `${id}-h` }, title), sub ? h('span', { class: 'sub' }, sub) : null, h('span', { class: 'grow' }), legend || null, toggle),
    body);
}

export function legend(items) {
  return h('ul', { class: 'legend', 'aria-label': 'מקרא' }, items.map(([cls, text]) => h('li', null, h('span', { class: ['key', cls] }), text)));
}

export { parseDate };

/* ======================= sparkline: 12 months in a KPI card ======================= */
/** Time runs right-to-left like every other chart here: the oldest month at the right, the newest (a dot) at the left.
 *  One series, so no legend; the card's label names it and `label` gives screen readers the range. */
/*  Text alternative: with `points` (one label per value, e.g. month names) the accessible name lists
 *  every value; with `interactive` the sparkline is also a tab stop whose arrow keys step through
 *  the months and show (and announce) each one, like the big charts. */
export function sparkline({ values = [], kind = 'in', label = '', height = 40, points = null, fmt = (v) => moneyText(v, { sign: 'negative', decimals: 0 }), interactive = false }) {
  const all = Array.isArray(points) && points.length === values.length
    ? `${label} ${values.map((v, i) => `${points[i]}: ${fmt(v)}`).join('; ')}.` : label;
  const host = h('div', { class: ['spark', `spark-${kind}`], role: 'img', 'aria-label': all });
  const n = values.length;
  if (n < 2) return host;
  let sel = n - 1;   // newest
  let readout = null;
  if (interactive && points) {
    host.tabIndex = 0;
    host.setAttribute('role', 'group');   // an img hides its children: the live readout must stay exposed
    host.setAttribute('aria-roledescription', 'גרף זעיר');
    host.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Home End');
    readout = h('span', { class: 'spark-read', 'aria-live': 'polite' });
    const show = () => { readout.textContent = `${points[sel]}: ${fmt(values[sel])}`; draw.mark?.(sel); };
    host.addEventListener('focus', show);
    host.addEventListener('blur', () => { readout.textContent = ''; draw.mark?.(null); });
    host.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') sel = Math.min(n - 1, sel + 1);        // left = newer (time runs right-to-left)
      else if (e.key === 'ArrowRight') sel = Math.max(0, sel - 1);
      else if (e.key === 'Home') sel = n - 1;
      else if (e.key === 'End') sel = 0;
      else return;
      e.preventDefault(); e.stopPropagation(); show();
    });
  }
  const gid = nextId('spark-grad');
  const min = Math.min(0, ...values), max = Math.max(0, ...values);
  let svg;
  const draw = (W) => {
    const H = height, pad = 4;
    const x = (i) => W - pad - (i / (n - 1)) * (W - pad * 2);
    const y = (v) => pad + (H - pad * 2) * (1 - (v - min) / ((max - min) || 1));
    let d = '';
    values.forEach((v, i) => { d += `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; });
    const g = [
      s('defs', null, s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 },
        s('stop', { offset: 0, class: 'sp-stop-1' }), s('stop', { offset: 1, class: 'sp-stop-2' }))),
    ];
    if (min < 0) g.push(s('line', { x1: pad, x2: W - pad, y1: y(0), y2: y(0), class: 'sp-zero' }));
    g.push(s('path', { d: `${d}L${x(n - 1).toFixed(1)} ${y(min < 0 ? 0 : min).toFixed(1)}L${x(0).toFixed(1)} ${y(min < 0 ? 0 : min).toFixed(1)}Z`, fill: `url(#${gid})`, class: 'sp-area' }));
    g.push(s('path', { d, class: 'sp-line' }));
    g.push(s('circle', { cx: x(n - 1), cy: y(values[n - 1]), r: 3.5, class: 'sp-dot' }));
    const focusDot = s('circle', { cx: x(sel), cy: y(values[sel]), r: 4.5, class: 'sp-focus', visibility: 'hidden' });
    g.push(focusDot);
    draw.mark = (i) => {
      if (i == null) { focusDot.setAttribute('visibility', 'hidden'); return; }
      focusDot.setAttribute('cx', x(i)); focusDot.setAttribute('cy', y(values[i])); focusDot.setAttribute('visibility', 'visible');
    };
    const next = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', direction: 'ltr' }, g);
    if (svg) svg.replaceWith(next); else host.prepend(next);
    svg = next;
    if (document.activeElement === host) draw.mark(sel);
  };
  if (readout) host.append(readout);
  responsive(host, draw);
  return host;
}
