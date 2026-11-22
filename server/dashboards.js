// Sheet dashboards: the typed table of a sheet connection, and dashboards the user builds from it.
// The page computes every widget live from the typed table (web/dashboards.js), so editing a widget
// shows the result at once; the server only stores and validates the layout.
import { parseSheetAmount, parseSheetDate } from './sheets.js';
import { toILS } from './money.js';

export const WIDGET_TYPES = ['kpi', 'bar', 'line', 'pie', 'table'];
export const OPS = ['sum', 'count', 'avg', 'min', 'max'];
export const BUCKETS = ['day', 'month', 'year'];
export const FILTER_OPS = ['eq', 'neq', 'contains', 'gt', 'lt'];
export const SIZES = ['s', 'm', 'l'];
const MAX_WIDGETS = 24;

/** Column types by content: 'number' | 'date' | 'text' (70% of the non-empty cells decide). */
export function columnTypes(header, rows) {
  return header.map((_, c) => {
    let filled = 0, nums = 0, dates = 0;
    for (const r of rows) {
      const v = String(r[c] ?? '').trim();
      if (!v) continue;
      filled++;
      if (parseSheetDate(v)) dates++;
      else if (parseSheetAmount(v) != null) nums++;
    }
    if (!filled) return 'text';
    if (dates / filled >= 0.7) return 'date';
    if (nums / filled >= 0.7) return 'number';
    return 'text';
  });
}

/** The table with typed cells: numbers in ₪, dates as YYYY-MM-DD, empty cells null. */
export function typedTable(header, rows) {
  const types = columnTypes(header, rows);
  const out = rows.map((r) => types.map((t, c) => {
    const v = String(r[c] ?? '').trim();
    if (!v) return null;
    if (t === 'number') { const a = parseSheetAmount(v); return a == null ? null : toILS(a); }
    if (t === 'date') return parseSheetDate(v);
    return v;
  }));
  return { columns: header.map((name, i) => ({ index: i, name, type: types[i] })), rows: out };
}

/** A first dashboard made from what the sheet holds. */
export function defaultWidgets(columns, rows) {
  // Invoice / phone / ID numbers are numbers, but adding them up means nothing.
  const ID_NAME = /חשבונית|קבלה|אסמכתא|מספר|מס['׳"]|טלפון|ת\.?ז|מיקוד|\bid\b|\bno\.?\b|#/i;
  const nums = columns.filter((c) => c.type === 'number' && !ID_NAME.test(c.name));
  const date = columns.find((c) => c.type === 'date');
  const texts = columns.filter((c) => c.type === 'text').map((c) => ({
    ...c, distinct: new Set(rows.map((r) => r[c.index]).filter((v) => v != null)).size,
  }));
  const groups = texts.filter((c) => c.distinct >= 2 && c.distinct <= Math.max(30, rows.length / 3)).sort((a, b) => a.distinct - b.distinct);
  const w = [];
  let n = 1;
  const add = (o) => w.push({ id: `w${n++}`, size: 's', filter: null, limit: 10, ...o });
  add({ type: 'kpi', title: 'מספר שורות', measure: { op: 'count', col: null } });
  for (const c of nums.slice(0, 3)) add({ type: 'kpi', title: `סך ${c.name}`, measure: { op: 'sum', col: c.index } });
  if (date && nums[0]) add({ type: 'line', title: `${nums[0].name} לפי חודש`, size: 'l', measure: { op: 'sum', col: nums[0].index }, dateCol: date.index, bucket: 'month' });
  if (groups[0]) add({ type: 'bar', title: nums[0] ? `${nums[0].name} לפי ${groups[0].name}` : `שורות לפי ${groups[0].name}`, size: 'm',
    measure: nums[0] ? { op: 'sum', col: nums[0].index } : { op: 'count', col: null }, groupBy: groups[0].index });
  if (groups[1]) add({ type: 'pie', title: `חלוקה לפי ${groups[1].name}`, size: 'm',
    measure: nums[0] ? { op: 'sum', col: nums[0].index } : { op: 'count', col: null }, groupBy: groups[1].index });
  add({ type: 'table', title: 'השורות האחרונות', size: 'l', limit: 20 });
  return w;
}

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const colOk = (v, width) => Number.isInteger(v) && v >= 0 && v < width;

/** Validate widgets from the page against the table width. Throws Error with a Hebrew message. */
export function validateWidgets(list, width) {
  if (!Array.isArray(list) || list.length > MAX_WIDGETS) throw new Error(`עד ${MAX_WIDGETS} רכיבים בדשבורד.`);
  const ids = new Set();
  return list.map((w) => {
    if (!w || typeof w !== 'object') throw new Error('רכיב לא תקין.');
    if (!isStr(w.id, 20) || !/^[\w-]+$/.test(w.id) || ids.has(w.id)) throw new Error('רכיב לא תקין.');
    ids.add(w.id);
    if (!WIDGET_TYPES.includes(w.type)) throw new Error('סוג רכיב לא מוכר.');
    const title = isStr(w.title, 80) ? w.title.replace(/[\u0000-\u001F\u007F]/g, '').trim() : '';
    const out = { id: w.id, type: w.type, title, size: SIZES.includes(w.size) ? w.size : 's',
      limit: Number.isInteger(w.limit) && w.limit >= 1 && w.limit <= 100 ? w.limit : 10, filter: null };
    if (w.type !== 'table') {
      const m = w.measure || {};
      if (!OPS.includes(m.op)) throw new Error('חישוב לא מוכר.');
      if (m.op !== 'count' && !colOk(m.col, width)) throw new Error('בחר עמודה לחישוב.');
      out.measure = { op: m.op, col: m.op === 'count' ? null : m.col };
    }
    if (w.type === 'bar' || w.type === 'pie') {
      if (!colOk(w.groupBy, width)) throw new Error('בחר עמודה לקיבוץ.');
      out.groupBy = w.groupBy;
    }
    if (w.type === 'line') {
      if (!colOk(w.dateCol, width)) throw new Error('בחר עמודת תאריך.');
      out.dateCol = w.dateCol;
      out.bucket = BUCKETS.includes(w.bucket) ? w.bucket : 'month';
    }
    if (w.filter != null) {
      const f = w.filter;
      if (!f || !colOk(f.col, width) || !FILTER_OPS.includes(f.op) || !isStr(String(f.value ?? ''), 100)) throw new Error('סינון לא תקין.');
      out.filter = { col: f.col, op: f.op, value: String(f.value ?? '') };
    }
    return out;
  });
}

// ---- storage --------------------------------------------------------------------------------------
const dashOut = (d) => ({ id: d.id, name: d.name, source: d.source, widgets: JSON.parse(d.widgets), updatedAt: d.updated_at });

export function sheetTable(db, connectionId) {
  const t = db.prepare('SELECT header, rows, fetched_at FROM sheet_tables WHERE connection_id = ?').get(connectionId);
  if (!t) return null;
  return { ...typedTable(JSON.parse(t.header), JSON.parse(t.rows)), fetchedAt: t.fetched_at };
}

export function listDashboards(db) {
  return db.prepare('SELECT * FROM dashboards ORDER BY id').all().map(dashOut);
}

export function getDashboard(db, id) {
  const d = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(id);
  return d ? dashOut(d) : null;
}

/** Every sheet that has a table but no dashboard yet gets a first one. */
export function ensureDefaultDashboards(db) {
  const missing = db.prepare(`SELECT st.connection_id AS id, c.nickname FROM sheet_tables st JOIN connections c ON c.id = st.connection_id
    WHERE NOT EXISTS (SELECT 1 FROM dashboards d WHERE d.source = 'sheet:' || st.connection_id)`).all();
  for (const m of missing) {
    const t = sheetTable(db, m.id);
    if (!t) continue;
    createDashboard(db, { name: m.nickname || 'הגיליון שלי', source: `sheet:${m.id}`, widgets: defaultWidgets(t.columns, t.rows) });
  }
}

export function createDashboard(db, { name, source, widgets }) {
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO dashboards (name, source, widgets, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, source, JSON.stringify(widgets), now, now);
  return getDashboard(db, Number(r.lastInsertRowid));
}

export function updateDashboard(db, id, { name, widgets }) {
  const now = new Date().toISOString();
  if (name !== undefined) db.prepare('UPDATE dashboards SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id);
  if (widgets !== undefined) db.prepare('UPDATE dashboards SET widgets = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(widgets), now, id);
  return getDashboard(db, id);
}

export function deleteDashboard(db, id) {
  return db.prepare('DELETE FROM dashboards WHERE id = ?').run(id).changes > 0;
}
