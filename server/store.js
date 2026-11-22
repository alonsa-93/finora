// Ingestion of scraped accounts/transactions with robust de-duplication.
//
// Dedupe key per account:
//   - completed rows with a provider identifier: "i:<identifier>|<date>|<instalment#>"
//   - completed rows without one:                "h:<sha1(date|amount|merchant|instalment#)>"
//   - pending rows:                              "p:<sha1(date|amount|merchant)>"
// plus "#<n>" = occurrence index of that base key inside the scraped batch, so two genuinely
// identical same-day charges are both kept, while re-scraping the same window maps onto the
// same keys (upsert, no duplicates).
// Pending rows are volatile: every sync deletes the account's pending rows inside the scraped
// window and re-inserts what the provider still reports as pending. A pending charge that has
// settled therefore disappears and its completed version is inserted instead (user edits such
// as category/excluded are carried across).
import { createHash } from 'node:crypto';
import { categorize, normalizeDescription, CATEGORY_BY_ID } from './categories.js';
import { loadRules, tx, last4Of } from './db.js';
import { accountKey } from './secrets.js';
import { addDays } from './dates.js';

const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 24);

export function baseKey(t) {
  const merchant = normalizeDescription(t.description);
  const inst = t.instNumber || 0;
  if (t.status === 'pending') return `p:${sha1(`${t.date}|${t.amount}|${merchant}`)}`;
  if (t.identifier != null && String(t.identifier).trim() !== '') {
    return `i:${String(t.identifier).trim().slice(0, 64)}|${t.date}|${inst}`;
  }
  return `h:${sha1(`${t.date}|${t.amount}|${merchant}|${inst}`)}`;
}

/** Assign final dedupe keys (base + occurrence index) to a batch, deterministically. */
export function assignKeys(txns) {
  const seen = new Map();
  return txns.map((t) => {
    const base = baseKey(t);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return { ...t, dedupeKey: `${base}#${n}` };
  });
}

export function upsertAccount(db, { connectionId, companyId, type, accountNumber, balance, now }) {
  // The full account / card number is never stored: only last-4 (for display) and a keyed HMAC
  // (to recognise the same account on the next sync).
  const key = accountKey(accountNumber);
  const last4 = last4Of(accountNumber);
  const existing = db.prepare('SELECT id FROM accounts WHERE connection_id IS ? AND account_number = ?')
    .get(connectionId, key);
  if (existing) {
    db.prepare('UPDATE accounts SET balance = ?, last_sync_at = ?, type = ?, last4 = ? WHERE id = ?')
      .run(type === 'bank' ? balance ?? null : null, now, type, last4, existing.id);
    return existing.id;
  }
  const r = db.prepare(`INSERT INTO accounts (connection_id, company_id, type, account_number, last4, balance, last_sync_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(connectionId, companyId, type, key, last4,
    type === 'bank' ? balance ?? null : null, now);
  return Number(r.lastInsertRowid);
}

/**
 * Ingest one account's transactions.
 * @param txns normalised: { identifier, date, processedDate, description, memo, amount (agorot),
 *   originalAmount (agorot), originalCurrency, instNumber, instTotal, status, providerCategory }
 * @param windowStart YYYY-MM-DD - earliest date that was requested from the provider
 * @returns {{ inserted: number }} newly seen transactions
 */
export function ingestTransactions(db, { accountId, accountType, txns, windowStart, now }) {
  const rules = loadRules(db);
  const keyed = assignKeys(txns);
  let inserted = 0;

  tx(db, () => {
    // 1. Remove volatile pending rows in the window (and stale ones), remembering user edits.
    const oldPending = db.prepare(`SELECT dedupe_key, date, amount, merchant_key, category, category_source, excluded,
        scope, business_share, invoice, no_vat, transfer_kind, transfer_auto
      FROM transactions WHERE account_id = ? AND status = 'pending' AND (date >= ? OR date < ?)`)
      .all(accountId, windowStart, addDays(now.slice(0, 10), -60));
    const editsByExact = new Map();
    const editsByLoose = new Map();
    const oldPendingKeys = new Set();
    for (const p of oldPending) {
      oldPendingKeys.add(p.dedupe_key);
      const bizTags = p.scope != null || p.business_share != null || p.invoice || p.no_vat || (p.transfer_kind && !p.transfer_auto);
      if (p.category_source === 'user' || p.excluded || bizTags) {
        const push = (m, k) => { if (!m.has(k)) m.set(k, []); m.get(k).push(p); };
        push(editsByExact, `${p.date}|${p.amount}|${p.merchant_key}`);
        push(editsByLoose, `${p.amount}|${p.merchant_key}`);
      }
    }
    // Each edited pending row is handed to one new row only (exact date first), so two same-size
    // charges at one merchant never both take the tags that were put on one of them.
    const used = new Set();
    const takeEdit = (k1, k2) => {
      for (const list of [editsByExact.get(k1), editsByLoose.get(k2)]) {
        const p = list?.find((x) => !used.has(x));
        if (p) { used.add(p); return p; }
      }
      return null;
    };
    db.prepare(`DELETE FROM transactions WHERE account_id = ? AND status = 'pending' AND (date >= ? OR date < ?)`)
      .run(accountId, windowStart, addDays(now.slice(0, 10), -60));

    const findExisting = db.prepare('SELECT id, category_source FROM transactions WHERE account_id = ? AND dedupe_key = ?');
    const update = db.prepare(`UPDATE transactions SET processed_date = ?, description = ?, merchant_key = ?, memo = ?,
      amount = ?, original_amount = ?, original_currency = ?, inst_number = ?, inst_total = ?, status = ?,
      provider_category = ?, updated_at = ? WHERE id = ?`);
    const updateCat = db.prepare(`UPDATE transactions SET category = ?, category_source = ?, is_card_payment = ? WHERE id = ?`);
    const insert = db.prepare(`INSERT INTO transactions (account_id, dedupe_key, identifier, date, processed_date,
      description, merchant_key, memo, amount, original_amount, original_currency, inst_number, inst_total, status,
      provider_category, category, category_source, is_card_payment, excluded, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const t of keyed) {
      const merchantKey = normalizeDescription(t.description);
      const cat = categorize(t, { accountType, rules });
      const existing = findExisting.get(accountId, t.dedupeKey);
      if (existing) {
        update.run(t.processedDate, t.description, merchantKey, t.memo ?? null, t.amount, t.originalAmount ?? null,
          t.originalCurrency ?? null, t.instNumber ?? null, t.instTotal ?? null, t.status, t.providerCategory ?? null,
          now, existing.id);
        if (existing.category_source !== 'user') updateCat.run(cat.category, cat.source, cat.isCardPayment ? 1 : 0, existing.id);
        continue;
      }
      let category = cat.category;
      let source = cat.source;
      let isCardPayment = cat.isCardPayment;
      let excluded = 0;
      const carried = takeEdit(`${t.date}|${t.amount}|${merchantKey}`, `${t.amount}|${merchantKey}`);
      if (carried) {
        if (carried.category_source === 'user' && CATEGORY_BY_ID.has(carried.category)) {
          category = carried.category;
          source = 'user';
          isCardPayment = accountType === 'bank' && category === 'card-payment';
        }
        excluded = carried.excluded ? 1 : 0;
      }
      insert.run(accountId, t.dedupeKey, t.identifier != null ? String(t.identifier) : null, t.date, t.processedDate,
        t.description, merchantKey, t.memo ?? null, t.amount, t.originalAmount ?? null, t.originalCurrency ?? null,
        t.instNumber ?? null, t.instTotal ?? null, t.status, t.providerCategory ?? null, category, source,
        isCardPayment ? 1 : 0, excluded, now, now);
      // Business tags the user put on the pending row move to the row that replaced it.
      if (carried && (carried.scope != null || carried.business_share != null || carried.invoice || carried.no_vat || (carried.transfer_kind && !carried.transfer_auto))) {
        db.prepare(`UPDATE transactions SET scope = ?, business_share = ?, invoice = ?, no_vat = ?, transfer_kind = ?
          WHERE account_id = ? AND dedupe_key = ?`).run(carried.scope, carried.business_share, carried.invoice, carried.no_vat,
          carried.transfer_auto ? null : carried.transfer_kind, accountId, t.dedupeKey);
      }
      // A pending row that is simply still pending is not "new".
      if (!(t.status === 'pending' && oldPendingKeys.has(t.dedupeKey))) inserted += 1;
    }
  });
  return { inserted };
}
