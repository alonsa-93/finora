// Row tags and the lens: a pending row's tags go to one new row only; an edited
// sheet line keeps its tags; sheet rows never pair up as owner transfers; an edit answers with the
// row as the lens shows it. Run: npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FINORA_DATA_DIR = mkdtempSync(join(tmpdir(), 'finora-test-'));
process.env.FINORA_QUIET = '1';

let db; let store; let ss; let biz; let repo; let setSetting;
before(async () => {
  const D = await import('../db.js');
  db = D.openDb('real');
  setSetting = D.setSetting;
  store = await import('../store.js');
  ss = await import('../sheet-sync.js');
  biz = await import('../business-store.js');
  repo = await import('../repo.js');
});

const NOW = '2026-11-13T08:00:00.000Z';
const t = (o) => ({ identifier: null, processedDate: o.date, memo: null, originalAmount: o.amount, originalCurrency: 'ILS',
  instNumber: null, instTotal: null, status: 'completed', providerCategory: null, ...o });
const LINK = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit';
const csvFetch = (csv) => async () => ({ status: 200, ok: true, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/csv' : null) },
  arrayBuffer: async () => Buffer.from(csv) });

test('a tagged pending row hands its tags to one new row, not to every look-alike', () => {
  const acc = store.upsertAccount(db, { connectionId: null, companyId: 'max', type: 'card', accountNumber: 'p1', balance: null, now: NOW });
  store.ingestTransactions(db, { accountId: acc, accountType: 'card', windowStart: '2026-10-01', now: NOW,
    txns: [t({ date: '2026-11-10', description: 'פז', amount: -1200, status: 'pending', identifier: 'a' }),
      t({ date: '2026-11-10', description: 'פז', amount: -1200, status: 'pending', identifier: 'b' })] });
  const [p1] = db.prepare('SELECT id FROM transactions WHERE account_id = ? ORDER BY id').all(acc);
  db.prepare("UPDATE transactions SET scope = 'business', invoice = 1 WHERE id = ?").run(p1.id);
  store.ingestTransactions(db, { accountId: acc, accountType: 'card', windowStart: '2026-10-01', now: NOW,
    txns: [t({ date: '2026-11-10', description: 'פז', amount: -1200, identifier: 'c' }), t({ date: '2026-11-10', description: 'פז', amount: -1200, identifier: 'd' })] });
  const rows = db.prepare('SELECT scope, invoice FROM transactions WHERE account_id = ?').all(acc);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.scope === 'business').length, 1);
  assert.equal(rows.filter((r) => r.invoice === 1).length, 1);
});

test('fixing one cell of a sheet line keeps the tags of that row', async () => {
  const c = db.prepare("INSERT INTO connections (company_id, nickname, cred_blob, created_at, last_status) VALUES ('gsheet', 'ס', NULL, ?, 'never')").run(NOW);
  const conn = { id: Number(c.lastInsertRowid) };
  await ss.syncSheet(db, conn, { url: LINK, kind: 'signed', scope: 'business' }, { fetchImpl: csvFetch('תאריך,תיאור,סכום\n01/10/2026,דני,500\n02/10/2026,ספק,-80\n') });
  const acc = db.prepare('SELECT id FROM accounts WHERE connection_id = ?').get(conn.id).id;
  const row = db.prepare("SELECT id FROM transactions WHERE account_id = ? AND description = 'ספק'").get(acc);
  db.prepare('UPDATE transactions SET business_share = 40, no_vat = 1 WHERE id = ?').run(row.id);
  // The amount was a typo: -80 -> -90. Same line, same date, same description.
  const r = await ss.syncSheet(db, conn, { url: LINK, kind: 'signed', scope: 'business' }, { fetchImpl: csvFetch('תאריך,תיאור,סכום\n01/10/2026,דני,500\n02/10/2026,ספק,-90\n') });
  assert.equal(r.removed, 0);
  const after = db.prepare('SELECT id, amount, business_share, no_vat FROM transactions WHERE id = ?').get(row.id);
  assert.deepEqual([after.amount, after.business_share, after.no_vat], [-9000, 40, 1]);
  // A line replaced by something else entirely is a new row.
  const r2 = await ss.syncSheet(db, conn, { url: LINK, kind: 'signed', scope: 'business' }, { fetchImpl: csvFetch('תאריך,תיאור,סכום\n01/10/2026,דני,500\n05/10/2026,גיל,-300\n') });
  assert.equal(r2.removed, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE id = ?').get(row.id).n, 0);
});

test('sheet rows never pair up as owner transfers', async () => {
  setSetting(db, 'business.enabled', '1');
  const c = db.prepare("INSERT INTO connections (company_id, nickname, cred_blob, created_at, last_status) VALUES ('gsheet', 'ה', NULL, ?, 'never')").run(NOW);
  await ss.syncSheet(db, { id: Number(c.lastInsertRowid) }, { url: LINK, kind: 'signed', scope: 'business' },
    { fetchImpl: csvFetch('תאריך,תיאור,סכום\n10/11/2026,משיכה,-5000\n') });
  const priv = store.upsertAccount(db, { connectionId: null, companyId: 'hapoalim', type: 'bank', accountNumber: 'pv', balance: 0, now: NOW });
  store.ingestTransactions(db, { accountId: priv, accountType: 'bank', windowStart: '2026-10-01', now: NOW,
    txns: [t({ date: '2026-11-10', description: 'העברה', amount: 500000 })] });
  biz.refreshOwnerTransfers(db);
  const tagged = db.prepare("SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN connections c ON c.id = a.connection_id WHERE c.company_id = 'gsheet' AND t.transfer_kind IS NOT NULL").get().n;
  assert.equal(tagged, 0);
});

test('an edit answers with the row as the lens shows it (split part, side)', () => {
  setSetting(db, 'business.enabled', '1');
  const acc = store.upsertAccount(db, { connectionId: null, companyId: 'max', type: 'card', accountNumber: 'sp', balance: null, now: NOW });
  store.ingestTransactions(db, { accountId: acc, accountType: 'card', windowStart: '2026-10-01', now: NOW,
    txns: [t({ date: '2026-11-05', description: 'דלק', amount: -20000 })] });
  const id = db.prepare('SELECT id FROM transactions WHERE account_id = ?').get(acc).id;
  biz.patchBusinessFields(db, id, { scope: 'business', businessShare: 45 });
  const b = repo.getTransactionView(db, id, 'business');
  assert.equal(b.amount, -90); // shekels, as the API answers
  assert.equal(b.effectiveScope, 'business');
  const p = repo.getTransactionView(db, id, 'private');
  assert.equal(p.amount, -110);
});
