// דשבורדים: dashboards built from Google Sheets. Every sheet gets a first dashboard made from its
// columns; the user adds, edits, moves and removes widgets and sees each change at once (the widgets
// are computed here, in the page, from the typed table GET /api/sheets/:id/table). The layout is saved
// to the server (validated there) a moment after the last change.
import { h, icon, mount } from '../dom.js';
import { api } from '../api.js';
import { on } from '../store.js';
import { setWhere } from '../shell.js';
import { openDialog, confirmDialog, toast } from '../layers.js';
import { relativeTime, monthLabel, monthShort, dateShort } from '../format.js';
import { startSync } from '../sync.js';
import { columnsChart, barsChart, lineChart, donutChart } from '../charts-dash.js';
import { emptyState, errorState } from './common.js';
import { openSheetDialog } from './sheet-dialog.js';
import { getPref, setPref } from '../prefs.js';

const TYPE_LABEL = { kpi: 'מספר בולט', bar: 'עמודות לפי קבוצה', line: 'מגמה לאורך זמן', pie: 'עוגה (חלוקה)', table: 'טבלה' };
const OP_LABEL = { sum: 'סכום', count: 'מספר שורות', avg: 'ממוצע', min: 'מינימום', max: 'מקסימום' };
const BUCKET_LABEL = { day: 'יום', month: 'חודש', year: 'שנה' };
const FILTER_LABEL = { eq: 'שווה ל', neq: 'שונה מ', contains: 'מכיל', gt: 'גדול מ', lt: 'קטן מ' };
const SIZE_LABEL = { s: 'קטן', m: 'בינוני', l: 'רחב' };
const MONEY_RE = /סכום|הכנס|הוצא|מחיר|עלות|תשלום|שכר|רווח|מכיר|amount|total|price|cost|revenue|₪/i;

const nf = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });

// ---- the computation (pure) --------------------------------------------------------------------------
function passes(row, f) {
  if (!f) return true;
  const v = row[f.col];
  if (f.op === 'gt' || f.op === 'lt') {
    const n = Number(String(f.value).replace(/[,₪\s]/g, ''));
    if (typeof v !== 'number' || !Number.isFinite(n)) return false;
    return f.op === 'gt' ? v > n : v < n;
  }
  const a = String(v ?? '').trim().toLowerCase();
  const b = String(f.value ?? '').trim().toLowerCase();
  if (f.op === 'eq') return a === b;
  if (f.op === 'neq') return a !== b;
  return a.includes(b);
}

function measure(rows, m) {
  if (m.op === 'count') return rows.length;
  const vals = rows.map((r) => r[m.col]).filter((v) => typeof v === 'number');
  if (!vals.length) return 0;
  if (m.op === 'sum') return vals.reduce((a, v) => a + v, 0);
  if (m.op === 'avg') return vals.reduce((a, v) => a + v, 0) / vals.length;
  return m.op === 'min' ? Math.min(...vals) : Math.max(...vals);
}

function bucketOf(date, b) { return b === 'year' ? date.slice(0, 4) : b === 'day' ? date : date.slice(0, 7); }

/** Everything a widget shows, from the table. */
export function computeWidget(w, table) {
  const rows = table.rows.filter((r) => passes(r, w.filter));
  if (w.type === 'kpi') return { value: measure(rows, w.measure), rows: rows.length };
  if (w.type === 'bar' || w.type === 'pie') {
    const groups = new Map();
    for (const r of rows) {
      const k = r[w.groupBy] == null || r[w.groupBy] === '' ? 'ללא' : String(r[w.groupBy]);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const items = [...groups].map(([label, rs]) => ({ label, value: measure(rs, w.measure) })).sort((a, b) => b.value - a.value);
    const top = items.slice(0, w.limit || 10);
    const rest = items.slice(top.length);
    if (rest.length && w.type === 'pie') top.push({ label: `אחרים (${rest.length})`, value: rest.reduce((a, it) => a + it.value, 0) });
    return { items: top, more: w.type === 'bar' ? rest.length : 0 };
  }
  if (w.type === 'line') {
    const groups = new Map();
    for (const r of rows) {
      const d = r[w.dateCol];
      if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const k = bucketOf(d, w.bucket);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const points = [...groups.keys()].sort().map((k) => ({ key: k, value: measure(groups.get(k), w.measure) }));
    return { points };
  }
  // table: the newest rows first when there is a date column
  const dc = table.columns.find((c) => c.type === 'date');
  const sorted = dc ? [...rows].sort((a, b) => String(b[dc.index] ?? '').localeCompare(String(a[dc.index] ?? ''))) : rows;
  return { rows: sorted.slice(0, w.limit || 20), total: rows.length };
}

// ---- view --------------------------------------------------------------------------------------------
export function mountDashboards(container, params = {}) {
  let data = null;          // { sheets, dashboards }
  let current = null;       // dashboard
  let table = null;         // typed table of its sheet
  let editing = false;
  // Pending widget saves, one per dashboard: written at once when leaving the screen or switching
  // dashboards, and a reload waits for them so it never brings back an older layout.
  const pending = new Map();   // dashboard id -> { d, timer }
  let inflight = Promise.resolve();
  let ctrl = null;
  const root = h('div', { class: 'ov-pad dash' });
  mount(container, root);
  setWhere('dashboards');

  const isMoney = (col) => col != null && MONEY_RE.test(table?.columns[col]?.name || '');
  const fmtFor = (w) => {
    const money = w.measure && w.measure.op !== 'count' && isMoney(w.measure.col);
    return (v) => (typeof v !== 'number' ? '–' : money ? `${nf0.format(v)} ₪` : nf.format(v));
  };
  const labelOfKey = (k, b) => (b === 'year' ? k : b === 'day' ? dateShort(k) : monthLabel(k));
  const shortOfKey = (k, b) => (b === 'year' ? k : b === 'day' ? dateShort(k) : monthShort(k));

  async function load(keepId) {
    flushSaves();
    await inflight;
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      data = await api.sheets({ signal: ctrl.signal });
    } catch (e) {
      if (e.name === 'AbortError') return;
      mount(root, errorState('לא הצלחנו לטעון את הדשבורדים', e.message, () => load()));
      return;
    }
    if (!data.sheets.length) { paintEmpty(); return; }
    const want = keepId ?? (params.id ? Number(params.id) : getPref('dashId', null));
    current = data.dashboards.find((d) => d.id === want) || data.dashboards.find((d) => d.id === getPref('dashId', null)) || data.dashboards[0] || null;
    await loadTable();
  }

  async function loadTable() {
    table = null;
    if (!current) { paint(); return; }
    setPref('dashId', current.id);
    const sheetId = Number(current.source.split(':')[1]);
    try {
      table = await api.sheetTable(sheetId, { signal: ctrl.signal });
    } catch (e) {
      if (e.name === 'AbortError') return;
      table = { error: e.message };
    }
    paint();
  }

  function paintEmpty() {
    mount(root,
      h('header', { class: 'dash-head' }, h('h1', null, 'דשבורדים')),
      h('section', { class: 'panel' }, emptyState({
        icon: 'grid', title: 'עוד לא חיברת גיליון Google',
        text: 'מחברים גיליון (הכנסות, לקוחות, לידים, מלאי…) ו-MoneyCash בונה ממנו דשבורד. הנתונים נמשכים מחדש בכל פתיחה ובכל לחיצה על סנכרון, ואת הדשבורד אפשר לשנות ולהרכיב כרצונך.',
        action: h('button', { class: 'btn primary', type: 'button', onclick: () => openSheetDialog({ onAdded: () => setTimeout(() => load(), 2500) }) }, icon('link'), 'חיבור גיליון'),
      })));
  }

  function sheetOf(d) { return data.sheets.find((s) => `sheet:${s.id}` === d.source); }

  function paint() {
    const sheet = current ? sheetOf(current) : null;
    const chips = h('div', { class: 'dash-tabs', role: 'tablist', 'aria-label': 'הדשבורדים שלך' },
      data.dashboards.map((d) => h('button', { type: 'button', role: 'tab', class: ['chip-btn', d.id === current?.id ? 'on' : null],
        'aria-selected': String(d.id === current?.id), onclick: () => { if (d.id !== current?.id) { flushSaves(); current = d; editing = false; loadTable(); } } }, icon('grid'), d.name)),
      h('button', { class: 'chip-btn', type: 'button', onclick: newDashboard }, icon('plus'), 'דשבורד חדש'));
    const tools = h('div', { class: 'dash-tools' },
      sheet ? h('span', { class: 'sub' }, sheet.lastStatus === 'error'
        ? h('span', { class: 'bad' }, `הגיליון לא נמשך: ${sheet.lastError || ''}`)
        : `${sheet.nickname} · עודכן ${relativeTime(sheet.tableAt || sheet.lastSyncAt) || 'עכשיו'}`) : null,
      h('span', { class: 'grow' }),
      sheet ? h('button', { class: 'btn small', type: 'button', onclick: () => refreshSheet(sheet) }, icon('sync'), 'משיכה מהגיליון') : null,
      current ? h('button', { class: ['btn small', editing ? 'primary' : null], type: 'button', 'aria-pressed': String(editing),
        onclick: () => { editing = !editing; paint(); } }, icon(editing ? 'check' : 'edit'), editing ? 'סיום עריכה' : 'עריכת הדשבורד') : null,
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => openSheetDialog({ onAdded: () => setTimeout(() => load(), 2500) }) }, icon('link'), 'גיליון נוסף'));
    let content;
    if (!current) content = h('section', { class: 'panel' }, h('p', { class: 'empty-line' }, 'אין עדיין דשבורד. "דשבורד חדש" יוצר אחד מגיליון.'));
    else if (!table) content = h('div', { class: 'sk', style: { height: '260px', borderRadius: '22px' } });
    else if (table.error) content = h('section', { class: 'panel' }, h('p', { class: 'empty-line' }, table.error));
    else content = grid();
    mount(root,
      h('header', { class: 'dash-head' },
        h('div', { class: 'biz-title' }, h('h1', null, current?.name || 'דשבורדים'),
          h('p', { class: 'sub' }, 'נבנה מהגיליון שלך. עריכה: הוספה, שינוי, הזזה ומחיקה של רכיבים, והתוצאה מתעדכנת מיד.')),
        chips),
      tools, content);
  }

  function grid() {
    const cards = current.widgets.map((w, i) => widgetCard(w, i));
    const addBtn = editing ? h('button', { class: 'dash-add', type: 'button', onclick: () => editWidget(null) }, icon('plus'), 'הוספת רכיב') : null;
    const meta = editing ? h('div', { class: 'dash-meta' },
      h('button', { class: 'btn small ghost', type: 'button', onclick: renameDashboard }, icon('edit'), 'שינוי שם'),
      h('button', { class: 'btn small ghost danger', type: 'button', onclick: removeDashboard }, icon('trash'), 'מחיקת הדשבורד')) : null;
    return [h('div', { class: ['dash-grid', editing ? 'editing' : null] }, cards, addBtn), meta];
  }

  function widgetCard(w, i) {
    let bodyEl;
    try { bodyEl = widgetBody(w); } catch { bodyEl = h('p', { class: 'empty-line' }, 'אי אפשר להציג את הרכיב הזה. ערוך אותו.'); }
    const n = current.widgets.length;
    const ctrls = editing ? h('div', { class: 'dw-ctrls', role: 'group', 'aria-label': `פעולות על ${w.title || TYPE_LABEL[w.type]}` },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'הזזה קדימה', title: 'הזזה קדימה', disabled: i === 0, onclick: () => move(i, -1) }, icon('arrowUp')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'הזזה אחורה', title: 'הזזה אחורה', disabled: i === n - 1, onclick: () => move(i, 1) }, icon('arrowDown')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'עריכה', title: 'עריכה', onclick: () => editWidget(i) }, icon('edit')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'מחיקה', title: 'מחיקה', onclick: () => removeWidget(i) }, icon('trash'))) : null;
    return h('section', { class: ['panel', 'dw', `dw-${w.type}`, `size-${w.size || 's'}`], 'aria-label': w.title || TYPE_LABEL[w.type] },
      h('div', { class: 'dw-head' }, h('h2', null, w.title || TYPE_LABEL[w.type]), ctrls), bodyEl);
  }

  function widgetBody(w) {
    const r = computeWidget(w, table);
    const fmt = fmtFor(w);
    const col = (i) => table.columns[i]?.name || '';
    if (w.type === 'kpi') {
      return h('div', { class: 'dw-kpi' }, h('p', { class: 'dw-figure' }, h('bdi', { dir: 'ltr' }, fmt(r.value))),
        h('p', { class: 'sub' }, `${OP_LABEL[w.measure.op]}${w.measure.col != null ? ` של ${col(w.measure.col)}` : ''} · ${nf0.format(r.rows)} שורות`));
    }
    if (w.type === 'bar') {
      if (!r.items.length) return h('p', { class: 'empty-line' }, 'אין שורות שמתאימות.');
      return [barsChart({ items: r.items, fmt, label: w.title || 'עמודות' }), r.more ? h('p', { class: 'sub' }, `ועוד ${r.more} קבוצות`) : null];
    }
    if (w.type === 'pie') {
      if (!r.items.length) return h('p', { class: 'empty-line' }, 'אין שורות שמתאימות.');
      return donutChart({ items: r.items, fmt, label: w.title || 'עוגה' });
    }
    if (w.type === 'line') {
      if (!r.points.length) return h('p', { class: 'empty-line' }, 'אין תאריכים בעמודה שנבחרה.');
      const pts = r.points.map((p) => ({ label: labelOfKey(p.key, w.bucket), short: shortOfKey(p.key, w.bucket), value: p.value }));
      return pts.length <= 18 && w.bucket !== 'day'
        ? columnsChart({ points: pts.map((p) => ({ ...p, values: { v: p.value } })), series: [{ key: 'v', label: w.title || 'ערך', color: 0 }], fmt, label: w.title || 'מגמה' })
        : lineChart({ points: pts, fmt, label: w.title || 'מגמה' });
    }
    const cols = table.columns;
    return h('div', { class: 'dw-table-wrap', tabindex: '0', role: 'region', 'aria-label': w.title || 'טבלה' },
      h('table', { class: 'grid-table dw-table' },
        h('thead', null, h('tr', null, cols.map((c) => h('th', { scope: 'col' }, c.name)))),
        h('tbody', null, r.rows.map((row) => h('tr', null, cols.map((c, i) => h('td', { class: c.type === 'number' ? 'num-cell' : null },
          row[i] == null ? '' : c.type === 'number' ? h('bdi', { dir: 'ltr' }, nf.format(row[i])) : c.type === 'date' ? dateShort(row[i]) : String(row[i]))))))),
      r.total > r.rows.length ? h('p', { class: 'sub' }, `מוצגות ${r.rows.length} מתוך ${nf0.format(r.total)} שורות`) : null);
  }

  // ---- edits ---------------------------------------------------------------------------------------
  function saveNow(id) {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    const widgets = p.d.widgets.map((w) => ({ ...w }));
    inflight = inflight.then(async () => {
      try {
        const saved = await api.saveDashboard(id, { widgets });
        // Only the server's bookkeeping: widgets edited while this save was on its way stay.
        if (saved?.updatedAt) p.d.updatedAt = saved.updatedAt;
      } catch (e) { toast(`הדשבורד לא נשמר: ${e.message}`, { kind: 'error' }); }
    });
  }
  function flushSaves() { [...pending.keys()].forEach(saveNow); }
  function changed() {
    paint();
    const d = current;
    const prev = pending.get(d.id);
    if (prev) clearTimeout(prev.timer);
    pending.set(d.id, { d, timer: setTimeout(() => saveNow(d.id), 600) });
  }
  function move(i, d) {
    const w = current.widgets;
    [w[i], w[i + d]] = [w[i + d], w[i]];
    changed();
    queueMicrotask(() => root.querySelectorAll('.dw')[i + d]?.querySelector(d < 0 ? '[aria-label="הזזה קדימה"]' : '[aria-label="הזזה אחורה"]')?.focus());
  }
  async function removeWidget(i) {
    const w = current.widgets[i];
    if (!(await confirmDialog({ title: 'למחוק את הרכיב?', message: `"${w.title || TYPE_LABEL[w.type]}" יוסר מהדשבורד. הנתונים בגיליון לא משתנים.`, confirmLabel: 'מחיקה', danger: true }))) return;
    current.widgets.splice(i, 1);
    changed();
  }

  function editWidget(index) {
    const cols = table.columns;
    const firstNum = cols.find((c) => c.type === 'number');
    const firstDate = cols.find((c) => c.type === 'date');
    const firstText = cols.find((c) => c.type === 'text');
    const base = index == null
      ? { id: `w${Date.now().toString(36)}`, type: 'kpi', title: '', size: 's', limit: 10, filter: null,
        measure: firstNum ? { op: 'sum', col: firstNum.index } : { op: 'count', col: null } }
      : structuredClone(current.widgets[index]);
    let w = base;
    const opt = (v, l, sel) => h('option', { value: String(v), selected: sel }, l);
    const colSelect = (value, filter, none) => h('select', { class: 'input' },
      none ? opt('', none, value == null) : null,
      cols.filter(filter || (() => true)).map((c) => opt(c.index, `${c.name}${c.type === 'number' ? ' (מספר)' : c.type === 'date' ? ' (תאריך)' : ''}`, c.index === value)));
    const preview = h('div', { class: 'dw-preview' });
    const form = h('div', { class: 'dw-form' });
    const field = (label, el) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), el);

    function normalize() {
      if (w.type !== 'table' && !w.measure) w.measure = { op: 'count', col: null };
      if (w.measure && w.measure.op !== 'count' && w.measure.col == null) w.measure.col = firstNum?.index ?? cols[0].index;
      if ((w.type === 'bar' || w.type === 'pie') && w.groupBy == null) w.groupBy = (firstText || cols[0]).index;
      if (w.type === 'line' && w.dateCol == null) w.dateCol = (firstDate || cols[0]).index;
      if (w.type === 'line' && !w.bucket) w.bucket = 'month';
    }
    function paintForm() {
      normalize();
      const type = h('select', { class: 'input', onchange: (e) => { w.type = e.target.value; paintForm(); } },
        Object.entries(TYPE_LABEL).map(([v, l]) => opt(v, l, v === w.type)));
      const title = h('input', { class: 'input', type: 'text', maxlength: '80', value: w.title, placeholder: 'כותרת (לא חובה)',
        oninput: (e) => { w.title = e.target.value; paintPreview(); } });
      const parts = [field('סוג', type), field('כותרת', title)];
      if (w.type !== 'table') {
        const op = h('select', { class: 'input', onchange: (e) => { w.measure.op = e.target.value; if (w.measure.op === 'count') w.measure.col = null; paintForm(); } },
          Object.entries(OP_LABEL).map(([v, l]) => opt(v, l, v === w.measure.op)));
        parts.push(field('מה לחשב', op));
        if (w.measure.op !== 'count') {
          parts.push(field('של העמודה', colSelect(w.measure.col, (c) => c.type === 'number' || !firstNum, null)));
          parts[parts.length - 1].querySelector('select').addEventListener('change', (e) => { w.measure.col = Number(e.target.value); paintPreview(); });
        }
      }
      if (w.type === 'bar' || w.type === 'pie') {
        const g = colSelect(w.groupBy, null, null);
        g.addEventListener('change', (e) => { w.groupBy = Number(e.target.value); paintPreview(); });
        parts.push(field('לפי', g));
      }
      if (w.type === 'line') {
        const dc = colSelect(w.dateCol, (c) => c.type === 'date' || !firstDate, null);
        dc.addEventListener('change', (e) => { w.dateCol = Number(e.target.value); paintPreview(); });
        const b = h('select', { class: 'input', onchange: (e) => { w.bucket = e.target.value; paintPreview(); } },
          Object.entries(BUCKET_LABEL).map(([v, l]) => opt(v, l, v === w.bucket)));
        parts.push(field('עמודת התאריך', dc), field('קיבוץ לפי', b));
      }
      if (w.type !== 'kpi' && w.type !== 'line') {
        const lim = h('input', { class: 'input', type: 'number', min: '1', max: '100', value: String(w.limit || 10),
          oninput: (e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 100) { w.limit = n; paintPreview(); } } });
        parts.push(field(w.type === 'table' ? 'כמה שורות' : 'כמה קבוצות להציג', lim));
      }
      const fCol = colSelect(w.filter?.col ?? null, null, 'בלי סינון');
      const fOp = h('select', { class: 'input' }, Object.entries(FILTER_LABEL).map(([v, l]) => opt(v, l, v === (w.filter?.op || 'eq'))));
      const fVal = h('input', { class: 'input', type: 'text', maxlength: '100', value: w.filter?.value || '', placeholder: 'ערך' });
      const syncFilter = () => {
        w.filter = fCol.value === '' ? null : { col: Number(fCol.value), op: fOp.value, value: fVal.value };
        fOp.disabled = fVal.disabled = !w.filter;
        paintPreview();
      };
      fCol.addEventListener('change', syncFilter); fOp.addEventListener('change', syncFilter); fVal.addEventListener('input', syncFilter);
      fOp.disabled = fVal.disabled = !w.filter;
      parts.push(h('fieldset', { class: 'dw-filter' }, h('legend', { class: 'field-label' }, 'סינון שורות'), fCol, fOp, fVal));
      const size = h('div', { class: 'dw-sizes', role: 'radiogroup', 'aria-label': 'רוחב' }, Object.entries(SIZE_LABEL).map(([v, l]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String((w.size || 's') === v), class: ['chip-btn', (w.size || 's') === v ? 'on' : null],
          onclick: () => { w.size = v; paintForm(); } }, l)));
      parts.push(h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'רוחב'), size));
      mount(form, parts);
      paintPreview();
    }
    function paintPreview() {
      let el;
      try { el = widgetCard({ ...w }, -1); } catch { el = h('p', { class: 'empty-line' }, 'לא ניתן להציג.'); }
      el.querySelector('.dw-ctrls')?.remove();
      mount(preview, h('p', { class: 'field-label' }, 'תצוגה מקדימה'), el);
    }
    const save = h('button', { class: 'btn primary', type: 'button' }, icon('check'), index == null ? 'הוספה לדשבורד' : 'שמירה');
    const cancel = h('button', { class: 'btn ghost', type: 'button' }, 'ביטול');
    const dlg = openDialog({ title: index == null ? 'רכיב חדש' : 'עריכת רכיב', wide: true, className: 'dw-dlg',
      body: h('div', { class: 'dw-editor' }, form, preview), actions: [save, cancel] });
    const wasEditing = editing;
    editing = false; // the preview card shows without edit controls
    paintForm();
    editing = wasEditing;
    cancel.addEventListener('click', () => dlg.close());
    save.addEventListener('click', () => {
      normalize();
      if (index == null) current.widgets.push(w); else current.widgets[index] = w;
      dlg.close();
      changed();
    });
  }

  async function newDashboard() {
    if (!data.sheets.length) { openSheetDialog(); return; }
    const name = h('input', { class: 'input', type: 'text', maxlength: '60', value: 'דשבורד חדש' });
    const src = h('select', { class: 'input' }, data.sheets.map((s) => h('option', { value: `sheet:${s.id}` }, s.nickname)));
    const ok = h('button', { class: 'btn primary', type: 'button' }, 'יצירה');
    const cancel = h('button', { class: 'btn ghost', type: 'button' }, 'ביטול');
    const dlg = openDialog({ title: 'דשבורד חדש', body: [
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'שם'), name),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'מאיזה גיליון'), src)], actions: [ok, cancel] });
    cancel.addEventListener('click', () => dlg.close());
    ok.addEventListener('click', async () => {
      try {
        const d = await api.createDashboard({ name: name.value.trim() || 'דשבורד חדש', source: src.value, widgets: [] });
        dlg.close();
        editing = true;
        await load(d.id);
      } catch (e) { toast(e.message, { kind: 'error' }); }
    });
  }

  async function renameDashboard() {
    const name = h('input', { class: 'input', type: 'text', maxlength: '60', value: current.name });
    const ok = h('button', { class: 'btn primary', type: 'button' }, 'שמירה');
    const dlg = openDialog({ title: 'שם הדשבורד', body: h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'שם'), name), actions: [ok] });
    ok.addEventListener('click', async () => {
      try { const saved = await api.saveDashboard(current.id, { name: name.value }); current.name = saved.name; current.updatedAt = saved.updatedAt; dlg.close(); paint(); } catch (e) { toast(e.message, { kind: 'error' }); }
    });
  }

  async function removeDashboard() {
    if (!(await confirmDialog({ title: 'למחוק את הדשבורד?', message: `"${current.name}" יימחק. הגיליון והנתונים שלו נשארים.`, confirmLabel: 'מחיקה', danger: true }))) return;
    const gone = current.id; clearTimeout(pending.get(gone)?.timer); pending.delete(gone);
    try { await api.deleteDashboard(gone); editing = false; await load(); } catch (e) { toast(e.message, { kind: 'error' }); }
  }

  async function refreshSheet(sheet) {
    await startSync(sheet.id);
    toast('מושך את הגיליון…');
  }

  load();
  // A finished sync (the sheet was pulled again) emits data-changed.
  const offs = [on('data-changed', () => load(current?.id))];
  return {
    update(p) { if (p?.id && Number(p.id) !== current?.id) { params = p; load(Number(p.id)); } },
    refresh: () => load(current?.id),
    destroy() { flushSaves(); ctrl?.abort(); offs.forEach((f) => f()); },
  };
}

