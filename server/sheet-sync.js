// Google Sheets connections (company_id 'gsheet'): pulled on every sync (on open, on refresh, daily).
// The link and the sheet kind are sealed like bank credentials. Each pull:
//  - keeps the whole table (header + cells) for the sheet dashboard (sheet_tables);
//  - when the sheet has a date and an amount column, mirrors its rows as transactions of one account
//    (no balance), so they enter every figure through the business / private lens of that account.
// Rows are keyed by sheetRowKeys(): a row that is still in the sheet keeps its id and the user's tags;
// a row that was deleted from the sheet is deleted here too.
import { fetchSheet, parseCsv, sheetRows, sheetRowKeys, SheetError } from './sheets.js';
import { upsertAccount } from './store.js';
import { loadRules, tx } from './db.js';
import { categorize, normalizeDescription, CATEGORIES } from './categories.js';
import { ensureDefaultDashboards } from './dashboards.js';

export const SHEET_COMPANY = 'gsheet';
export const SHEET_KINDS = ['signed', 'income', 'expense'];
const MAX_CELLS = 200_000;

const CAT_BY_NAME = new Map(CATEGORIES.filter((c) => !c.hidden).flatMap((c) => [[c.name, c.id], [c.id, c.id]]));

/** The sheet's own category text -> one of ours (exact name or a word of it), else null. */
function mapCategory(text) {
  if (!text) return null;
  const t = text.trim();
  if (CAT_BY_NAME.has(t)) return CAT_BY_NAME.get(t);
  for (const c of CATEGORIES) if (!c.hidden && c.name.split(/[ ()/,]+/).some((w) => w.length > 2 && t.includes(w))) return c.id;
  return null;
}

/** Store the table for the dashboard. Cells are kept as text; the page types them. */
export function saveSheetTable(db, connectionId, table, now) {
  const header = (table[0] || []).map((h, i) => String(h || '').trim().slice(0, 60) || `עמודה ${i + 1}`);
  const width = header.length;
  const rows = [];
  let cells = 0;
  for (let i = 1; i < table.length && cells < MAX_CELLS; i++) {
    const r = table[i].slice(0, width).map((c) => String(c ?? '').slice(0, 300));
    if (r.every((c) => !c.trim())) continue;
    while (r.length < width) r.push('');
    rows.push(r);
    cells += width;
  }
  db.prepare(`INSERT INTO sheet_tables (connection_id, header, rows, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(connection_id) DO UPDATE SET header = excluded.header, rows = excluded.rows, fetched_at = excluded.fetched_at`)
    .run(connectionId, JSON.stringify(header), JSON.stringify(rows), now);
  return { columns: width, rows: rows.length };
}

/**
 * Mirror the sheet's rows into the account's transactions.
 * @returns {{ inserted, updated, removed }}
 */
export function replaceSheetRows(db, { accountId, rows, now }) {
  const rules = loadRules(db);
  const keys = sheetRowKeys(rows);
  let inserted = 0, updated = 0, removed = 0;
  tx(db, () => {
    const existing = new Map(db.prepare(`SELECT id, dedupe_key, identifier, date, amount, description, category_source
      FROM transactions WHERE account_id = ?`).all(accountId).map((r) => [r.dedupe_key, r]));
    // Rows whose key is gone, by sheet line: a line where only one of date / amount / description was
    // fixed in the sheet is the same row edited, so it is updated in place and keeps its tags.
    const keySet = new Set(keys);
    const goneByLine = new Map();
    for (const ex of existing.values()) if (!keySet.has(ex.dedupe_key) && ex.identifier) goneByLine.set(ex.identifier, ex);
    const moveRow = db.prepare(`UPDATE transactions SET dedupe_key = ?, date = ?, processed_date = ?, description = ?,
      merchant_key = ?, amount = ?, updated_at = ? WHERE id = ?`);
    const ins = db.prepare(`INSERT INTO transactions (account_id, dedupe_key, identifier, date, processed_date, description,
      merchant_key, memo, amount, status, category, category_source, is_card_payment, excluded, invoice, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'completed', ?, ?, 0, 0, ?, ?, ?)`);
    const updCat = db.prepare("UPDATE transactions SET category = ?, category_source = ?, updated_at = ? WHERE id = ? AND category_source != 'user'");
    const updInv = db.prepare('UPDATE transactions SET invoice = 1 WHERE id = ? AND invoice = 0');
    const seen = new Set();
    rows.forEach((r, i) => {
      const key = keys[i];
      seen.add(key);
      const own = mapCategory(r.category);
      const cat = own ? { category: own, source: 'provider' }
        : r.amount > 0 ? { category: 'salary', source: 'auto' }
          : (() => { const c = categorize({ description: r.description, amount: r.amount }, { accountType: 'sheet', rules }); return { category: c.category, source: c.source }; })();
      const ex = existing.get(key);
      if (ex) {
        updCat.run(cat.category, cat.source, now, ex.id);
        if (r.invoice) updInv.run(ex.id);
        updated++;
        return;
      }
      const was = goneByLine.get(`sheet-line-${r.line}`);
      const sameFields = was ? [was.date === r.date, was.amount === r.amount, was.description === r.description].filter(Boolean).length : 0;
      if (was && sameFields >= 2 && !seen.has(was.dedupe_key)) {
        goneByLine.delete(`sheet-line-${r.line}`);
        seen.add(was.dedupe_key);
        moveRow.run(key, r.date, r.date, r.description, normalizeDescription(r.description), r.amount, now, was.id);
        updCat.run(cat.category, cat.source, now, was.id);
        if (r.invoice) updInv.run(was.id);
        updated++;
        return;
      }
      ins.run(accountId, key, `sheet-line-${r.line}`, r.date, r.date, r.description, normalizeDescription(r.description),
        r.amount, cat.category, cat.source, r.invoice ? 1 : 0, now, now);
      inserted++;
    });
    const del = db.prepare('DELETE FROM transactions WHERE id = ?');
    for (const [key, ex] of existing) if (!seen.has(key)) { del.run(ex.id); removed++; }
  });
  return { inserted, updated, removed };
}

/**
 * Pull one sheet connection. `cred` = { url, kind } (already decrypted). Throws SheetError.
 * @returns {{ inserted, removed, rows, ledger: boolean, message }}
 */
export async function syncSheet(db, conn, cred, { now = new Date().toISOString(), fetchImpl } = {}) {
  const csv = await fetchSheet(cred.url, fetchImpl ? { fetchImpl } : {});
  const table = parseCsv(csv);
  saveSheetTable(db, conn.id, table, now);
  let parsed = null;
  try { parsed = sheetRows(csv, { kind: SHEET_KINDS.includes(cred.kind) ? cred.kind : 'signed' }); } catch (e) {
    if (!(e instanceof SheetError && e.code === 'NO_COLUMNS')) throw e;
  }
  if (!parsed) {
    ensureDefaultDashboards(db);
    return { inserted: 0, removed: 0, rows: Math.max(0, table.length - 1), ledger: false, message: 'הגיליון נשמר לדשבורד (אין בו עמודות תאריך וסכום לתנועות)' };
  }
  const first = !db.prepare('SELECT 1 FROM accounts WHERE connection_id = ?').get(conn.id);
  const accountId = upsertAccount(db, { connectionId: conn.id, companyId: SHEET_COMPANY, type: 'bank', accountNumber: String(conn.id).padStart(4, '0'), balance: null, now });
  // The side chosen when the sheet was added applies once; later the user may change it in Settings.
  if (first && ['business', 'private', 'mixed'].includes(cred.scope)) db.prepare('UPDATE accounts SET scope = ? WHERE id = ?').run(cred.scope, accountId);
  const r = replaceSheetRows(db, { accountId, rows: parsed.rows, now });
  ensureDefaultDashboards(db);
  const parts = [r.inserted ? `נוספו ${r.inserted} שורות` : 'אין שורות חדשות'];
  if (r.removed) parts.push(`${r.removed} נמחקו מהגיליון`);
  if (parsed.skipped) parts.push(`${parsed.skipped} דולגו (בלי תאריך או סכום)`);
  return { inserted: r.inserted, removed: r.removed, rows: parsed.rows.length, ledger: true, message: parts.join(', ') };
}
