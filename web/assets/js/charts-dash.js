// Small SVG charts for the business screen and the sheet dashboards: columns (grouped, per month),
// horizontal bars (top N), a line, and a donut. Each one redraws to its width, carries an aria-label
// and a hidden table with the same numbers, and shows the value of the hovered / focused mark.
import { h, s } from './dom.js';
import { isNum } from './format.js';

const PALETTE = [1, 2, 3, 4, 5, 6].map((n) => `var(--dch-${n})`);
export const seriesColor = (i) => PALETTE[i % PALETTE.length];

function niceMax(v) {
  if (!isNum(v) || v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag).find((x) => x >= v) || v;
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

function frame(label, rows, headers) {
  const readout = h('p', { class: 'dch-readout', 'aria-live': 'polite' }, ' ');
  const host = h('div', { class: 'dch-host' });
  const table = h('table', { class: 'sr-only' },
    h('caption', null, label),
    h('thead', null, h('tr', null, headers.map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => (i ? h('td', null, c) : h('th', { scope: 'row' }, c)))))));
  return { el: h('div', { class: 'dch' }, host, readout, table), host, readout };
}

function svgRoot(w, hgt, label) {
  return s('svg', { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, role: 'img', 'aria-label': label, class: 'dch-svg' });
}

function mark(el, text, readout) {
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', text);
  const show = () => { readout.textContent = text; };
  el.addEventListener('mouseenter', show);
  el.addEventListener('focus', show);
  return el;
}

/**
 * Grouped columns over time. Time runs right to left (RTL): the first point is at the right.
 * @param o { points: [{ label, values: { key: number } }], series: [{ key, label }], fmt, height, label }
 */
export function columnsChart({ points = [], series = [], fmt = String, height = 220, label = 'תרשים' }) {
  const rows = points.map((p) => [p.label, ...series.map((sr) => fmt(p.values[sr.key]))]);
  const f = frame(label, rows, ['', ...series.map((sr) => sr.label)]);
  const max = niceMax(Math.max(0, ...points.flatMap((p) => series.map((sr) => Math.abs(p.values[sr.key] || 0)))));
  const draw = (w) => {
    const padB = 22, padT = 8, padX = 6;
    const svg = svgRoot(w, height, label);
    const plotH = height - padB - padT;
    const slot = (w - padX * 2) / Math.max(1, points.length);
    const bw = Math.max(3, Math.min(18, (slot * 0.72) / Math.max(1, series.length)));
    const y = (v) => padT + plotH - (Math.max(0, v) / max) * plotH;
    for (const t of [0.5, 1]) svg.append(s('line', { x1: 0, x2: w, y1: y(max * t), y2: y(max * t), class: 'dch-grid' }));
    svg.append(s('line', { x1: 0, x2: w, y1: y(0), y2: y(0), class: 'dch-axis' }));
    points.forEach((p, i) => {
      const cx = w - padX - slot * (i + 0.5);
      const groupW = bw * series.length + 2 * (series.length - 1);
      series.forEach((sr, j) => {
        const v = p.values[sr.key] || 0;
        const x = cx + groupW / 2 - (j + 1) * bw - j * 2;
        const top = y(Math.abs(v));
        const r = s('rect', { x, y: top, width: bw, height: Math.max(0.5, y(0) - top), rx: Math.min(3, bw / 2),
          fill: seriesColor(sr.color ?? j), class: [v < 0 ? 'dch-neg' : null, p.partial ? 'dch-partial' : null].filter(Boolean).join(' ') });
        svg.append(mark(r, `${p.label}, ${sr.label}: ${fmt(v)}`, f.readout));
      });
      if (points.length <= 14 || i % 2 === 0) svg.append(s('text', { x: cx, y: height - 6, class: 'dch-lbl', 'text-anchor': 'middle' }, p.short || p.label));
    });
    f.host.replaceChildren(svg);
  };
  queueMicrotask(() => responsive(f.host, draw));
  return f.el;
}

/** Horizontal bars, biggest first. @param o { items: [{ label, value }], fmt, label } */
export function barsChart({ items = [], fmt = String, label = 'תרשים', color = 0 }) {
  const rows = items.map((it) => [it.label, fmt(it.value)]);
  const f = frame(label, rows, ['', 'ערך']);
  const max = Math.max(1e-9, ...items.map((it) => Math.abs(it.value || 0)));
  const list = h('ul', { class: 'dch-bars', role: 'list' }, items.map((it) => {
    const pct = Math.max(1.5, (Math.abs(it.value || 0) / max) * 100);
    const li = h('li', { class: 'dch-bar' },
      h('span', { class: 'dch-bar-lbl' }, h('bdi', null, it.label)),
      h('span', { class: 'dch-bar-track', 'aria-hidden': 'true' }, h('span', { class: 'dch-bar-fill', style: { width: `${pct}%`, background: seriesColor(color) } })),
      h('span', { class: 'dch-bar-val' }, h('bdi', { dir: 'ltr' }, fmt(it.value))));
    return li;
  }));
  f.host.replaceChildren(list);
  return f.el;
}

/** A line over ordered points (RTL: first point at the right). @param o { points: [{ label, value }], fmt, label } */
export function lineChart({ points = [], fmt = String, height = 200, label = 'תרשים' }) {
  const rows = points.map((p) => [p.label, fmt(p.value)]);
  const f = frame(label, rows, ['', 'ערך']);
  const vals = points.map((p) => p.value || 0);
  const hi = niceMax(Math.max(0, ...vals));
  const lo = Math.min(0, ...vals);
  const draw = (w) => {
    const padB = 22, padT = 10, padX = 10;
    const svg = svgRoot(w, height, label);
    const plotH = height - padB - padT;
    const x = (i) => (points.length < 2 ? w / 2 : w - padX - (i / (points.length - 1)) * (w - padX * 2));
    const y = (v) => padT + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
    for (const t of [0.5, 1]) svg.append(s('line', { x1: 0, x2: w, y1: y(lo + (hi - lo) * t), y2: y(lo + (hi - lo) * t), class: 'dch-grid' }));
    svg.append(s('line', { x1: 0, x2: w, y1: y(0), y2: y(0), class: 'dch-axis' }));
    if (points.length) {
      const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value || 0).toFixed(1)}`).join('');
      svg.append(s('path', { d: `${d}L${x(points.length - 1)} ${y(lo)}L${x(0)} ${y(lo)}Z`, class: 'dch-area' }));
      svg.append(s('path', { d, class: 'dch-line' }));
      const step = Math.ceil(points.length / Math.max(2, Math.floor(w / 70)));
      points.forEach((p, i) => {
        svg.append(mark(s('circle', { cx: x(i), cy: y(p.value || 0), r: 4, class: 'dch-dot' }), `${p.label}: ${fmt(p.value)}`, f.readout));
        if (i % step === 0) svg.append(s('text', { x: x(i), y: height - 6, class: 'dch-lbl', 'text-anchor': 'middle' }, p.short || p.label));
      });
    }
    f.host.replaceChildren(svg);
  };
  queueMicrotask(() => responsive(f.host, draw));
  return f.el;
}

/** Donut of shares, with its legend. @param o { items: [{ label, value }], fmt, label } */
export function donutChart({ items = [], fmt = String, label = 'תרשים' }) {
  const pos = items.filter((it) => (it.value || 0) > 0);
  const total = pos.reduce((a, it) => a + it.value, 0);
  const rows = pos.map((it) => [it.label, fmt(it.value), `${Math.round((it.value / (total || 1)) * 100)}%`]);
  const f = frame(label, rows, ['', 'ערך', 'חלק']);
  const size = 168, r = 64, sw = 22, c = 2 * Math.PI * r;
  const svg = svgRoot(size, size, label);
  svg.setAttribute('class', 'dch-svg dch-donut');
  let off = 0;
  svg.append(s('circle', { cx: size / 2, cy: size / 2, r, class: 'dch-ring' }));
  pos.forEach((it, i) => {
    const len = (it.value / (total || 1)) * c;
    const seg = s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: seriesColor(i), 'stroke-width': sw,
      'stroke-dasharray': `${Math.max(0, len - 1.5)} ${c}`, 'stroke-dashoffset': -off, transform: `rotate(-90 ${size / 2} ${size / 2})` });
    svg.append(mark(seg, `${it.label}: ${fmt(it.value)} (${Math.round((it.value / (total || 1)) * 100)}%)`, f.readout));
    off += len;
  });
  const legendEl = h('ul', { class: 'dch-legend' }, pos.map((it, i) => h('li', null,
    h('span', { class: 'dch-key', style: { background: seriesColor(i) }, 'aria-hidden': 'true' }),
    h('bdi', { class: 'dch-legend-lbl' }, it.label), h('span', { class: 'dch-legend-pct' }, `${Math.round((it.value / (total || 1)) * 100)}%`))));
  f.host.replaceChildren(h('div', { class: 'dch-donut-wrap' }, svg, legendEl));
  return f.el;
}
