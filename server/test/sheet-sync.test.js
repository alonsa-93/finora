// Google Sheets source end to end without the network: pull -> rows mirrored with tags kept, rows
// deleted from the sheet deleted here, the table kept for the dashboard, a first dashboard made,
// and widgets validated.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MONEYCASH_DATA_DIR = mkdtempSync(join(tmpdir(), 'moneycash-test-'));
process.env.MONEYCASH_QUIET = '1';

let db; let ss; let dash;
before(async () => {
  db = (await import('../db.js')).openDb('real');
  ss = await import('../sheet-sync.js');
  dash = await import('../dashboards.js');
});

const LINK = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit';
const csvFetch = (csv) => async () => ({ status: 200, ok: true, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/csv' : null) },
  arrayBuffer: async () => Buffer.from(csv) });

test('a sheet is mirrored as transactions; tags survive a pull; deleted lines go', async () => {
  const c = db.prepare("INSERT INTO connections (company_id, nickname, cred_blob, created_at, last_status) VALUES ('gsheet', 'הכנסות', NULL, ?, 'never')")
    .run(new Date().toISOString());
  const conn = { id: Number(c.lastInsertRowid) };
  const v1 = 'תאריך,לקוח,הכנסה,הוצאה,פרויקט,חשבונית\n01/10/2026,דני,"5,900",,אתר,1001\n03/10/2026,פייסבוק,,"1,180",שיווק,\n05/10/2026,רינה,2000,,אתר,1002\n';
  const r1 = await ss.syncSheet(db, conn, { url: LINK, kind: 'signed', scope: 'business' }, { fetchImpl: csvFetch(v1) });
  assert.equal(r1.inserted, 3);
  const acc = db.prepare('SELECT * FROM accounts WHERE connection_id = ?').get(conn.id);
  assert.equal(acc.scope, 'business');
  assert.equal(acc.balance, null);
  const rows = db.prepare('SELECT * FROM transactions WHERE account_id = ? ORDER BY date').all(acc.id);
  assert.deepEqual(rows.map((r) => [r.amount, r.category, r.invoice]), [[590000, 'salary', 1], [-118000, rows[1].category, 0], [200000, 'salary', 1]]);
  db.prepare("UPDATE transactions SET category = 'leisure', category_source = 'user', business_share = 50 WHERE id = ?").run(rows[1].id);

  const v2 = 'תאריך,לקוח,הכנסה,הוצאה,פרויקט,חשבונית\n01/10/2026,דני,"5,900",,אתר,1001\n03/10/2026,פייסבוק,,"1,180",שיווק,\n07/10/2026,גיל,700,,לוגו,\n';
  const r2 = await ss.syncSheet(db, conn, { url: LINK, kind: 'signed', scope: 'business' }, { fetchImpl: csvFetch(v2) });
  assert.equal(r2.inserted, 1);
  assert.equal(r2.removed, 1);
  const kept = db.prepare('SELECT * FROM transactions WHERE id = ?').get(rows[1].id);
  assert.equal(kept.category, 'leisure', 'the user category stays');
  assert.equal(kept.business_share, 50, 'the business share stays');

  // The table and a first dashboard built from it.
  const t = dash.sheetTable(db, conn.id);
  assert.deepEqual(t.columns.map((c) => c.type), ['date', 'text', 'number', 'number', 'text', 'number']);
  assert.equal(t.rows[0][2], 5900);
  const ds = dash.listDashboards(db).filter((d) => d.source === `sheet:${conn.id}`);
  assert.equal(ds.length, 1);
  assert.ok(ds[0].widgets.some((w) => w.type === 'line') && ds[0].widgets.some((w) => w.type === 'kpi'));
  assert.deepEqual(dash.validateWidgets(ds[0].widgets, t.columns.length), ds[0].widgets);
});

test('a sheet without date / amount still feeds a dashboard; bad widgets are refused', async () => {
  const c = db.prepare("INSERT INTO connections (company_id, nickname, cred_blob, created_at, last_status) VALUES ('gsheet', 'לידים', NULL, ?, 'never')")
    .run(new Date().toISOString());
  const conn = { id: Number(c.lastInsertRowid) };
  const r = await ss.syncSheet(db, conn, { url: LINK }, { fetchImpl: csvFetch('שם,מקור,סטטוס\nא,פייסבוק,חדש\nב,גוגל,נסגר\nג,פייסבוק,חדש\n') });
  assert.equal(r.ledger, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE connection_id = ?').get(conn.id).n, 0);
  assert.equal(dash.sheetTable(db, conn.id).rows.length, 3);
  for (const bad of [[{ id: 'a', type: 'chart' }], [{ id: 'a', type: 'bar', measure: { op: 'count' }, groupBy: 9 }],
    [{ id: 'a', type: 'kpi', measure: { op: 'sum', col: null } }], [{ id: 'a', type: 'table' }, { id: 'a', type: 'table' }],
    [{ id: 'a', type: 'table', filter: { col: 0, op: 'regex', value: 'x' } }]]) {
    assert.throws(() => dash.validateWidgets(bad, 3), JSON.stringify(bad));
  }
});
