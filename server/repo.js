// Data access shared by the API: maps DB rows to API shapes, filtered transaction queries.
import { companyMeta } from './companies.js';
import { toILS } from './money.js';
import { buildDataset } from './analytics.js';
import { todayISO, monthOf, addMonths } from './dates.js';
import { randomBytes } from 'node:crypto';
import { CATEGORY_BY_ID, CATEGORIES, normalizeDescription } from './categories.js';
import { tx, getSetting } from './db.js';
import { lensRows, LENSES } from './business.js';

export function accountName(companyId, last4) {
  return `${companyMeta(companyId).short} •${last4 || ''}`;
}

export function connectionOut(c) {
  const meta = companyMeta(c.company_id);
  return {
    id: c.id, companyId: c.company_id, companyName: meta.name, type: meta.type, nickname: c.nickname,
    createdAt: c.created_at, lastSyncAt: c.last_sync_at, lastStatus: c.last_status, lastError: c.last_error,
    needsCodeLogin: !!c.needs_code_login,
  };
}

export function listConnections(db) {
  return db.prepare('SELECT * FROM connections ORDER BY id').all().map(connectionOut);
}

export function listAccountsRaw(db) {
  return db.prepare('SELECT * FROM accounts ORDER BY type, id').all().map((a) => ({
    id: a.id, connectionId: a.connection_id, companyId: a.company_id, type: a.type,
    accountNumber: a.last4 || '', name: accountName(a.company_id, a.last4),
    balance: a.balance, lastSyncAt: a.last_sync_at, scope: a.scope || 'private',
  }));
}

export function listAccounts(db) {
  return listAccountsRaw(db).map((a) => ({
    id: a.id, connectionId: a.connectionId, companyId: a.companyId, companyName: companyMeta(a.companyId).name,
    type: a.type, accountNumber: a.accountNumber, name: a.name,
    balance: a.type === 'bank' ? toILS(a.balance) : null, lastSyncAt: a.lastSyncAt, scope: a.scope,
  }));
}

// ---- business lens ------------------------------------------------------------------------------
// The SQL twin of business.lensRows(): a lens is a sub-select that stands in for `transactions t`
// in every query. It keeps only the rows (or the part of a split row) that belong to the lens, and
// gives owner transfers the neutral category. test/separation.test.js checks, on random data and
// through the API, that it returns exactly what lensRows() returns.
/** Business mode on? Off = everything is shown as before; the lens is ignored. */
export const businessEnabled = (db) => getSetting(db, 'business.enabled') === '1';
/** The lens a request may use: 'all' unless business mode is on and the lens is valid. */
export const lensFor = (db, lens) => (businessEnabled(db) && LENSES.includes(lens) ? lens : 'all');

const EFF = `(CASE WHEN t.scope IN ('business', 'private') THEN t.scope
  WHEN sr.scope IN ('business', 'private') THEN sr.scope
  WHEN a.scope = 'business' THEN 'business' ELSE 'private' END)`;
const SHARE = `(CASE WHEN ${EFF} = 'business' THEN
  (CASE WHEN typeof(t.business_share) = 'integer' AND t.business_share BETWEEN 0 AND 100 THEN t.business_share ELSE 100 END)
  ELSE 0 END)`;
const TK = "(IFNULL(t.transfer_kind, '') IN ('owner_draw', 'owner_injection'))";
const SIDE = `(CASE WHEN a.scope = 'business' THEN 'business' ELSE ${EFF} END)`;
const BIZ = `((t.amount * ${SHARE}) / 100)`;
const LENS_SQL = {
  all: { amount: 't.amount', cond: '1' },
  business: { amount: `CASE WHEN ${TK} THEN t.amount ELSE ${BIZ} END`,
    cond: `((${TK} AND ${SIDE} = 'business') OR (NOT ${TK} AND ${SHARE} > 0))` },
  private: { amount: `CASE WHEN ${TK} THEN t.amount ELSE t.amount - ${BIZ} END`,
    cond: `((${TK} AND ${SIDE} = 'private') OR (NOT ${TK} AND ${SHARE} < 100))` },
};
const txColumns = new WeakMap();
function lensSource(db, lens) {
  if (!businessEnabled(db)) return 'transactions';
  if (!txColumns.has(db)) {
    txColumns.set(db, db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name)
      .filter((n) => n !== 'amount' && n !== 'category'));
  }
  const L = LENS_SQL[lens] || LENS_SQL.all;
  const cols = txColumns.get(db).map((n) => `t."${n}"`).join(', ');
  return `(SELECT ${cols}, ${L.amount} AS amount, t.amount AS full_amount,
      CASE WHEN ${TK} THEN 'owner-transfer' ELSE t.category END AS category, t.category AS own_category,
      sr.scope AS rule_scope, ${EFF} AS eff_scope, ${SHARE} AS eff_share
    FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN scope_rules sr ON sr.merchant_key = t.merchant_key
    WHERE ${L.cond})`;
}
const txSelect = (db, lens = 'all') => `SELECT t.*, a.type AS account_type, a.company_id, a.last4 AS account_last4
  FROM ${lensSource(db, lensFor(db, lens))} t JOIN accounts a ON a.id = t.account_id`;
/** Plain rows with what the JS lens needs (the merchant's scope rule). */
const RAW_SELECT = `SELECT t.*, a.type AS account_type, a.company_id, a.last4 AS account_last4, sr.scope AS rule_scope
  FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN scope_rules sr ON sr.merchant_key = t.merchant_key`;

function rowToInternal(r) {
  return {
    id: r.id, accountId: r.account_id, accountType: r.account_type, date: r.date, processedDate: r.processed_date,
    description: r.description, merchantKey: r.merchant_key, memo: r.memo, amount: r.amount,
    originalAmount: r.original_amount, originalCurrency: r.original_currency,
    instNumber: r.inst_number, instTotal: r.inst_total, status: r.status, category: r.category,
    categorySource: r.category_source, isCardPayment: !!r.is_card_payment, excluded: !!r.excluded,
    identifier: r.identifier, companyId: r.company_id, accountNumber: r.account_last4,
    scope: r.scope ?? null, ruleScope: r.rule_scope ?? null, businessShare: r.business_share ?? null,
    transferKind: r.transfer_kind ?? null, transferAuto: !!r.transfer_auto, invoice: !!r.invoice, noVat: !!r.no_vat,
    fullAmount: r.full_amount ?? null, effScope: r.eff_scope ?? null,
  };
}

export function txOut(r) {
  const i = r.accountType ? r : rowToInternal(r);
  return {
    id: i.id, date: i.date, processedDate: i.processedDate, description: i.description, memo: i.memo || null,
    amount: toILS(i.amount),
    originalAmount: i.originalAmount == null ? toILS(i.amount) : toILS(i.originalAmount),
    originalCurrency: i.originalCurrency || 'ILS',
    category: i.category, categorySource: i.categorySource,
    accountId: i.accountId, accountName: accountName(i.companyId, i.accountNumber), accountType: i.accountType,
    installments: i.instTotal != null && i.instTotal > 1 ? { number: i.instNumber, total: i.instTotal } : null,
    status: i.status, isCardPayment: i.isCardPayment, excluded: i.excluded,
    // Business mode: the row's own scope (null = inherited), the scope it ends up with, its share.
    scope: i.scope ?? null, effectiveScope: i.effScope ?? null, ruleScope: i.ruleScope ?? null,
    businessShare: i.businessShare ?? null, transferKind: i.transferKind ?? null, invoice: !!i.invoice, noVat: !!i.noVat,
    fullAmount: i.fullAmount != null && i.fullAmount !== i.amount ? toILS(i.fullAmount) : null,
  };
}

/**
 * Every row and account as one lens sees them (the analytics input). The rows go through
 * business.lensRows() - the one JS gate. Accounts outside the lens stay known (rows point at them)
 * but are marked inLens: false; ds.rawRows keeps the full amounts for rebuilding bank balances.
 */
export function loadDataset(db, today = todayISO(), lens = 'all') {
  const raw = db.prepare(RAW_SELECT).all().map(rowToInternal);
  const accounts = listAccountsRaw(db);
  if (!businessEnabled(db)) return buildDataset({ rows: raw, accounts, today });
  const L = lensFor(db, lens);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rows = lensRows(raw, byId, L);
  const inLens = (a) => L === 'all' || (L === 'business' ? a.scope === 'business' : a.scope !== 'business');
  const ds = buildDataset({ rows, accounts: accounts.map((a) => ({ ...a, inLens: inLens(a) })), today });
  ds.lens = L;
  ds.rawRows = raw.filter((r) => inLens(byId.get(r.accountId) || {}))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  return ds;
}

/** "1,249.9" / "₪249" / "-249.90" -> [min, max] in agorot; null when the text is not an amount. */
export function amountQuery(q) {
  const m = /^[-−]?\s*₪?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*₪?$/.exec(String(q).trim());
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ''));
  if (!Number.isSafeInteger(whole) || whole > 1e9) return null;
  if (m[2] === undefined) return [whole * 100, whole * 100 + 99];
  const cents = whole * 100 + Number(m[2].padEnd(2, '0'));
  return [cents, cents];
}

/** Build WHERE clause from validated filters. */
function where(f) {
  const cond = [];
  const params = [];
  if (f.month) {
    cond.push('t.date >= ? AND t.date < ?');
    params.push(`${f.month}-01`, `${addMonths(f.month, 1)}-01`);
  }
  if (f.months?.length) {
    cond.push(`substr(t.date, 1, 7) IN (${f.months.map(() => '?').join(',')})`);
    params.push(...f.months);
  }
  if (f.from) { cond.push('t.date >= ?'); params.push(f.from); }
  if (f.to) { cond.push('t.date <= ?'); params.push(f.to); }
  if (f.accountId != null) { cond.push('t.account_id = ?'); params.push(f.accountId); }
  if (f.category) { cond.push('t.category = ?'); params.push(f.category); }
  if (f.direction === 'in') cond.push('t.amount > 0');
  if (f.direction === 'out') cond.push('t.amount < 0');
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // The search box promises "description or amount": a number also matches the amount
    // ("249" finds 249.00-249.99, "249.9" / "249.90" exactly 249.90), either sign.
    const amt = amountQuery(f.q);
    if (amt) {
      cond.push("(t.description LIKE ? ESCAPE '\\' OR IFNULL(t.memo, '') LIKE ? ESCAPE '\\' OR ABS(t.amount) BETWEEN ? AND ?)");
      params.push(like, like, amt[0], amt[1]);
    } else {
      cond.push("(t.description LIKE ? ESCAPE '\\' OR IFNULL(t.memo, '') LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
  }
  if (f.ids) {
    cond.push(`t.id IN (${f.ids.map(() => '?').join(',')})`);
    params.push(...f.ids);
  }
  if (f.kind === 'spending') cond.push(SPENDING_SQL);
  if (f.kind === 'income') cond.push(INCOME_SQL);
  return { sql: cond.length ? `WHERE ${cond.join(' AND ')}` : '', params };
}

// The rows behind the headline figures, mirroring analytics.contribution() in SQL: "spending" is
// every row that counts as an expense (purchases AND their refunds, so the list nets to the
// headline), "income" every row that counts as income. Category lists come from categories.js.
const sqlList = (kind) => CATEGORIES.filter((c) => c.kind === kind).map((c) => `'${c.id.replace(/'/g, '')}'`).join(',');
const HAS_CARDS = "EXISTS (SELECT 1 FROM accounts c WHERE c.type = 'card')";
const IS_CARD_PAY = "(t.is_card_payment = 1 OR (a.type = 'bank' AND t.category = 'card-payment'))";
const SPENDING_SQL = `t.excluded = 0 AND (
  (t.category IN (${sqlList('expense')}) AND NOT ${IS_CARD_PAY})
  OR (${IS_CARD_PAY} AND NOT ${HAS_CARDS}))`;
const INCOME_SQL = `t.excluded = 0 AND a.type = 'bank' AND t.category IN (${sqlList('income')}) AND NOT ${IS_CARD_PAY}`;
/** Category a counted row is totalled under (as in contribution()). */
const NET_KEY = `CASE WHEN ${IS_CARD_PAY} THEN 'card-payment' ELSE t.category END`;

export function queryTransactions(db, f) {
  const w = where(f);
  const SRC = `FROM ${lensSource(db, lensFor(db, f.lens))} t JOIN accounts a ON a.id = t.account_id`;
  // Sums leave out what the UI labels "not counted": rows the user excluded, and the bank's monthly
  // card debit when card accounts are connected (its purchases are already listed from the card).
  const counted = `t.excluded = 0 AND NOT (t.is_card_payment = 1 AND EXISTS (SELECT 1 FROM accounts c WHERE c.type = 'card'))`;
  const agg = db.prepare(`SELECT COUNT(*) AS total,
      IFNULL(SUM(CASE WHEN t.amount < 0 AND ${counted} THEN -t.amount ELSE 0 END), 0) AS sum_out,
      IFNULL(SUM(CASE WHEN t.amount > 0 AND ${counted} THEN t.amount ELSE 0 END), 0) AS sum_in
    ${SRC} ${w.sql}`).get(...w.params);
  // Net figures for the spending / income views, computed exactly like the overview headline:
  // per category, refunds subtract, a category never goes below zero.
  let net = null;
  if (f.kind === 'spending' || f.kind === 'income') {
    const sign = f.kind === 'spending' ? -1 : 1;
    const byCat = db.prepare(`SELECT ${NET_KEY} AS k,
        IFNULL(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) AS out_sum,
        IFNULL(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) AS in_sum,
        IFNULL(SUM(t.amount), 0) AS s
      ${SRC} ${w.sql} GROUP BY k, substr(t.date, 1, 7)`).all(...w.params);
    const total = byCat.reduce((acc, r) => acc + Math.max(0, sign * r.s), 0);
    const gross = byCat.reduce((acc, r) => acc + (f.kind === 'spending' ? r.out_sum : r.in_sum), 0);
    const back = byCat.reduce((acc, r) => acc + (f.kind === 'spending' ? r.in_sum : r.out_sum), 0);
    net = { kind: f.kind, gross: toILS(gross), offsets: toILS(back), total: toILS(total) };
  }
  const sortCol = f.sort === 'amount' ? 'ABS(t.amount)' : 't.date';
  const order = f.order === 'asc' ? 'ASC' : 'DESC';
  const items = db.prepare(`${txSelect(db, f.lens)} ${w.sql} ORDER BY ${sortCol} ${order}, t.id ${order} LIMIT ? OFFSET ?`)
    .all(...w.params, f.limit, f.offset).map(txOut);
  // Day groups (date order only): per day of this page, the totals of ALL matching rows that day
  // (not just the rows on this page), with the same "counted" rule as sumOut / sumIn.
  let days;
  if (f.sort !== 'amount' && items.length) {
    const dates = [...new Set(items.map((t) => t.date))];
    const dayWhere = `${w.sql ? `${w.sql} AND` : 'WHERE'} t.date IN (${dates.map(() => '?').join(',')})`;
    days = db.prepare(`SELECT t.date AS date, COUNT(*) AS n,
        IFNULL(SUM(CASE WHEN t.amount < 0 AND ${counted} THEN -t.amount ELSE 0 END), 0) AS sum_out,
        IFNULL(SUM(CASE WHEN t.amount > 0 AND ${counted} THEN t.amount ELSE 0 END), 0) AS sum_in
      ${SRC} ${dayWhere} GROUP BY t.date`).all(...w.params, ...dates)
      .map((r) => ({ date: r.date, count: r.n, sumOut: toILS(r.sum_out), sumIn: toILS(r.sum_in) }));
  }
  return {
    total: agg.total, sumOut: toILS(agg.sum_out), sumIn: toILS(agg.sum_in), sumNet: toILS(agg.sum_in - agg.sum_out),
    ...(net ? { net } : {}), ...(days ? { days } : {}), items,
  };
}

export function getTransaction(db, id) {
  const r = db.prepare(`${RAW_SELECT} WHERE t.id = ?`).get(id);
  return r ? rowToInternal(r) : null;
}

/** One row as the list shows it in a lens (its side, its part of a split amount, owner-transfer
 *  category), for answers to an edit. Falls back to the plain row when the edit moved it out of the lens. */
export function getTransactionView(db, id, lens = 'all') {
  const r = db.prepare(`${txSelect(db, lens)} WHERE t.id = ?`).get(id);
  return r ? txOut(r) : txOut(getTransaction(db, id));
}

// ---- category changes + undo -------------------------------------------------------------------
// Every PATCH records what it changed (rows + the merchant rule before the change) under a random
// id kept in memory; POST /api/transactions/undo restores it. Only rows still exactly as the change
// left them are restored, so an undo never overwrites a later edit. Newest 30, for 30 minutes.
const UNDO_MAX = 30;
const UNDO_TTL_MS = 30 * 60 * 1000;
const undoLog = new Map(); // id -> { db, at, stamp, rows: [...], rule: {key, before}|null }

function rememberUndo(entry) {
  const id = randomBytes(12).toString('base64url');
  undoLog.set(id, { ...entry, at: Date.now() });
  while (undoLog.size > UNDO_MAX) undoLog.delete(undoLog.keys().next().value);
  return id;
}

/** Key of the "similar" rows: the merchant key (as stored, else normalised from the description). */
const similarKey = (cur) => cur.merchantKey || normalizeDescription(cur.description);

/**
 * The rows "apply to similar" would change: same merchant, not this row, not already in `category`,
 * and either not chosen by the user or following the merchant's previous rule.
 */
function similarWhere(db, cur, category) {
  const key = similarKey(cur);
  if (!key) return null;
  const prevRule = db.prepare('SELECT category FROM rules WHERE merchant_key = ?').get(key)?.category ?? null;
  return {
    key, prevRule,
    sql: "merchant_key = ? AND id != ? AND category != ? AND (category_source != 'user' OR (? IS NOT NULL AND category = ?))",
    params: [key, cur.id, category, prevRule, prevRule],
  };
}

/** How many other rows a category change would also update ("apply to similar"). */
export function countSimilar(db, id, category) {
  const cur = getTransaction(db, id);
  if (!cur) return null;
  const w = similarWhere(db, cur, category);
  const count = w ? db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${w.sql}`).get(...w.params).n : 0;
  return { count: Number(count), merchant: cur.description, hasRule: w?.prevRule != null };
}

const SNAP_COLS = 'id, category, category_source, is_card_payment, excluded, updated_at';

/** PATCH semantics: category / excluded / applyToSimilar. Returns { tx, affected, undoId }. */
export function patchTransaction(db, id, { category, excluded, applyToSimilar }) {
  const cur = getTransaction(db, id);
  if (!cur) return null;
  // A strictly increasing stamp: undo recognises "still as this change left it" by it.
  const now = nextStamp();
  let affected = 0;
  const before = [db.prepare(`SELECT ${SNAP_COLS} FROM transactions WHERE id = ?`).get(id)];
  let rule = null;
  tx(db, () => {
    if (category !== undefined) {
      db.prepare(`UPDATE transactions SET category = ?, category_source = 'user', is_card_payment = ?, updated_at = ? WHERE id = ?`)
        .run(category, cur.accountType === 'bank' && category === 'card-payment' ? 1 : 0, now, id);
      const w = applyToSimilar ? similarWhere(db, cur, category) : null;
      if (w) {
        const oldRule = db.prepare('SELECT category, created_at FROM rules WHERE merchant_key = ?').get(w.key) || null;
        rule = { key: w.key, before: oldRule ? { category: oldRule.category, createdAt: oldRule.created_at } : null };
        // Rows that got their category from the previous rule for this merchant are stored as 'user'
        // too; they follow the rule when it changes (otherwise correcting a rule touches nothing).
        before.push(...db.prepare(`SELECT ${SNAP_COLS} FROM transactions WHERE ${w.sql}`).all(...w.params));
        db.prepare(`INSERT INTO rules (merchant_key, category, created_at) VALUES (?, ?, ?)
          ON CONFLICT(merchant_key) DO UPDATE SET category = excluded.category, created_at = excluded.created_at`)
          .run(w.key, category, now);
        const r1 = db.prepare(`UPDATE transactions SET category = ?, category_source = 'user', updated_at = ?,
            is_card_payment = CASE WHEN ? = 'card-payment' AND account_id IN (SELECT id FROM accounts WHERE type = 'bank') THEN 1 ELSE 0 END
          WHERE ${w.sql}`).run(category, now, category, ...w.params);
        affected = Number(r1.changes);
      }
    }
    if (excluded !== undefined) {
      db.prepare('UPDATE transactions SET excluded = ?, updated_at = ? WHERE id = ?').run(excluded ? 1 : 0, now, id);
    }
  });
  const undoId = rememberUndo({ db, stamp: now, rows: before, rule });
  return { tx: txOut(getTransaction(db, id)), affected, undoId };
}

let lastStamp = '';
function nextStamp() {
  let t = new Date().toISOString();
  if (t <= lastStamp) t = new Date(Date.parse(lastStamp) + 1).toISOString();
  lastStamp = t;
  return t;
}

/**
 * Revert a recorded change. Returns { restored, ruleReverted } or null when the id is unknown,
 * expired, or belongs to the other database (demo / real).
 */
export function undoChange(db, undoId) {
  const e = undoLog.get(undoId);
  if (!e || e.db !== db || Date.now() - e.at > UNDO_TTL_MS) return null;
  undoLog.delete(undoId);
  let restored = 0;
  let ruleReverted = false;
  tx(db, () => {
    const upd = db.prepare(`UPDATE transactions SET category = ?, category_source = ?, is_card_payment = ?, excluded = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?`);
    for (const r of e.rows) {
      restored += Number(upd.run(r.category, r.category_source, r.is_card_payment, r.excluded, r.updated_at, r.id, e.stamp).changes);
    }
    if (e.rule) {
      const curRule = db.prepare('SELECT created_at FROM rules WHERE merchant_key = ?').get(e.rule.key);
      if (curRule && curRule.created_at === e.stamp) { // not replaced by a later change
        if (e.rule.before) {
          db.prepare('UPDATE rules SET category = ?, created_at = ? WHERE merchant_key = ?').run(e.rule.before.category, e.rule.before.createdAt, e.rule.key);
        } else {
          db.prepare('DELETE FROM rules WHERE merchant_key = ?').run(e.rule.key);
        }
        ruleReverted = true;
      }
    }
  });
  return { restored, ruleReverted };
}

export function categoriesOut() {
  return [...CATEGORY_BY_ID.values()].map((c) => ({ id: c.id, name: c.name, color: c.color, kind: c.kind }));
}

export function exportRows(db, { from, to, lens }) {
  const w = where({ from, to });
  return db.prepare(`${txSelect(db, lens)} ${w.sql} ORDER BY t.date ASC, t.id ASC`).all(...w.params).map(txOut);
}

export { monthOf };
