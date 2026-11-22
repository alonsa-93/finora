// Business mode, stored side: settings, scopes (account / row / merchant), owner-transfer detection,
// and the business screens (overview, flow). Every figure is computed from loadDataset(db, today, lens),
// so it reads rows through the one gate, business.lensRows().
import { getSetting, setSetting, tx } from './db.js';
import { loadDataset, listAccountsRaw, txOut, getTransaction, businessEnabled } from './repo.js';
import {
  detectOwnerTransfers, vatPeriodOf, vatForPeriod, businessTotals, profitExVat, reallyYours, taxSetAside,
  exemptStatus, monthFlow, businessFlags, SCOPES, ACCOUNT_SCOPES, TRANSFER_KINDS,
} from './business.js';
import { BUSINESS_TYPES, VAT_PERIODS, exemptCeiling, vatRate } from './business-rates.js';
import { computePosition } from './position.js';
import { normalizeDescription } from './categories.js';
import { toILS } from './money.js';
import { monthOf, addMonths, hebMonth } from './dates.js';

// ---- settings -------------------------------------------------------------------------------------
const num = (v, def) => (v == null || v === '' || !Number.isFinite(Number(v)) ? def : Number(v));

export function getBusinessSettings(db, today) {
  const year = today.slice(0, 4);
  return {
    enabled: businessEnabled(db),
    type: BUSINESS_TYPES.includes(getSetting(db, 'business.type')) ? getSetting(db, 'business.type') : 'exempt',
    vatPeriod: VAT_PERIODS.includes(getSetting(db, 'business.vatPeriod')) ? getSetting(db, 'business.vatPeriod') : 'bimonthly',
    setAsidePct: num(getSetting(db, 'business.setAsidePct'), 20),
    taxPaidYtd: toILS(num(getSetting(db, `business.taxPaid:${year}`), 0)), // advances paid this year (₪)
    name: getSetting(db, 'business.name') || '',
  };
}

/** Patch of already-validated values (app.js validates). */
export function setBusinessSettings(db, p, today) {
  tx(db, () => {
    if (p.enabled !== undefined) setSetting(db, 'business.enabled', p.enabled ? '1' : '0');
    if (p.type !== undefined) setSetting(db, 'business.type', p.type);
    if (p.vatPeriod !== undefined) setSetting(db, 'business.vatPeriod', p.vatPeriod);
    if (p.setAsidePct !== undefined) setSetting(db, 'business.setAsidePct', String(p.setAsidePct));
    if (p.taxPaidYtd !== undefined) setSetting(db, `business.taxPaid:${today.slice(0, 4)}`, String(Math.round(p.taxPaidYtd * 100)));
    if (p.name !== undefined) setSetting(db, 'business.name', p.name);
  });
  if (p.enabled) refreshOwnerTransfers(db);
  return getBusinessSettings(db, today);
}

// ---- scopes ---------------------------------------------------------------------------------------
export function setAccountScope(db, id, scope) {
  if (!ACCOUNT_SCOPES.includes(scope)) throw new Error('bad scope');
  const r = db.prepare('UPDATE accounts SET scope = ? WHERE id = ?').run(scope, id);
  if (!r.changes) return false;
  refreshOwnerTransfers(db);
  return true;
}

/**
 * Business fields of one row. scope: 'business' | 'private' | null (inherit); businessShare 0..100 | null;
 * transferKind: 'owner_draw' | 'owner_injection' | 'none' | null (detect); invoice / noVat: boolean;
 * applyToMerchant: also remember the scope for this merchant (rows without their own scope follow it).
 */
export function patchBusinessFields(db, id, p) {
  const cur = getTransaction(db, id);
  if (!cur) return null;
  const now = new Date().toISOString();
  tx(db, () => {
    const set = (col, v) => db.prepare(`UPDATE transactions SET ${col} = ?, updated_at = ? WHERE id = ?`).run(v, now, id);
    if (p.scope !== undefined) set('scope', p.scope);
    if (p.businessShare !== undefined) set('business_share', p.businessShare);
    if (p.transferKind !== undefined) {
      db.prepare('UPDATE transactions SET transfer_kind = ?, transfer_auto = 0, updated_at = ? WHERE id = ?').run(p.transferKind, now, id);
    }
    if (p.invoice !== undefined) set('invoice', p.invoice ? 1 : 0);
    if (p.noVat !== undefined) set('no_vat', p.noVat ? 1 : 0);
    if (p.applyToMerchant && p.scope !== undefined) {
      const key = cur.merchantKey || normalizeDescription(cur.description);
      if (key) {
        if (p.scope == null) db.prepare('DELETE FROM scope_rules WHERE merchant_key = ?').run(key);
        else {
          db.prepare(`INSERT INTO scope_rules (merchant_key, scope, created_at) VALUES (?, ?, ?)
            ON CONFLICT(merchant_key) DO UPDATE SET scope = excluded.scope, created_at = excluded.created_at`).run(key, p.scope, now);
        }
      }
    }
  });
  if (p.scope !== undefined || p.transferKind !== undefined) refreshOwnerTransfers(db);
  return txOut(getTransaction(db, id));
}

/**
 * Re-detect owner transfers: rows the detector tagged before are re-checked; rows the user tagged
 * (or marked 'none') are never touched. Runs after a sync and after a scope change.
 */
export function refreshOwnerTransfers(db) {
  if (!businessEnabled(db)) return 0;
  const accounts = new Map(listAccountsRaw(db).map((a) => [a.id, a]));
  // Sheet rows are a record kept by hand, not money moving between accounts: they never pair up as
  // owner transfers (the real bank rows of the same money would then be left as expenses).
  const rows = db.prepare(`SELECT id, account_id, amount, date, status, transfer_kind, transfer_auto,
      (SELECT type FROM accounts a WHERE a.id = t.account_id) AS account_type FROM transactions t
      WHERE t.account_id NOT IN (SELECT a.id FROM accounts a JOIN connections c ON c.id = a.connection_id WHERE c.company_id = 'gsheet')`).all()
    .map((r) => ({ id: r.id, accountId: r.account_id, accountType: r.account_type, amount: r.amount, date: r.date,
      status: r.status, transferKind: r.transfer_auto ? null : r.transfer_kind }));
  const found = detectOwnerTransfers(rows, accounts);
  let n = 0;
  tx(db, () => {
    db.prepare('UPDATE transactions SET transfer_kind = NULL, transfer_auto = 0 WHERE transfer_auto = 1').run();
    const upd = db.prepare('UPDATE transactions SET transfer_kind = ?, transfer_auto = 1 WHERE id = ? AND transfer_kind IS NULL');
    for (const [id, kind] of found) n += Number(upd.run(kind, id).changes);
  });
  return n;
}

// ---- screens --------------------------------------------------------------------------------------
const ils = (a) => toILS(a);

/** The business at a glance: money that is really its own, VAT, profit, set-aside, flags. */
export function businessOverview(db, today) {
  const s = getBusinessSettings(db, today);
  const ds = loadDataset(db, today, 'business');
  const rows = ds.rows;
  const month = monthOf(today);
  const year = today.slice(0, 4);
  const pos = computePosition(ds, {});
  const bankBalance = Math.round((pos.bank.current ?? 0) * 100);
  const upcomingCards = Math.round((pos.cards.current ?? 0) * 100);

  // VAT: the period still to be paid (the last closed one, until its due date), and the open one.
  const open = vatPeriodOf(month, s.vatPeriod);
  const prev = vatPeriodOf(addMonths(open.first, -1), s.vatPeriod);
  const vatOf = (p) => ({ ...p, ...vatForPeriod(rows, { type: s.type, first: p.first, last: p.last }) });
  const vatPrev = vatOf(prev);
  const vatOpen = vatOf(open);
  // The last closed period is still to be paid until its due date; after that, the open one is next.
  const prevOpen = today <= prev.due;
  const toPay = prevOpen ? vatPrev : vatOpen;
  const toPayDate = prevOpen ? prev.due : open.due;
  const owed = (prevOpen ? Math.max(0, vatPrev.due) : 0) + Math.max(0, vatOpen.due);

  const profitYtd = profitExVat(rows, `${year}-01`, month, s.type);
  // Tax already paid this year: income-tax advances seen in the business rows, plus what the user typed.
  const paidSeen = businessTotals(rows, `${year}-01`, month).incomeTaxPaid;
  const setAside = taxSetAside({ profitYtd, pct: s.setAsidePct, taxPaidYtd: paidSeen + Math.round((s.taxPaidYtd || 0) * 100) });
  const mine = reallyYours({ bankBalance, upcomingCards, vatDue: s.type === 'exempt' ? 0 : owed, setAside });

  const months = [];
  for (let i = 11; i >= 0; i--) {
    const m = addMonths(month, -i);
    const t = businessTotals(rows, m, m);
    months.push({ month: m, label: hebMonth(m), income: ils(t.income), expenses: ils(t.expenses),
      profit: ils(profitExVat(rows, m, m, s.type)), ownerDraws: ils(t.ownerDraws), complete: m < month });
  }
  const thisMonth = businessTotals(rows, month, month);
  const ytd = businessTotals(rows, `${year}-01`, month);
  const exempt = s.type === 'exempt' ? exemptStatus(rows, Number(year)) : null;
  const flags = businessFlags({ type: s.type, today, bizRows: rows, bankBalance, setAside,
    vat: { due: toPay.due, periodDue: toPayDate, missingInvoices: toPay.missingInvoices } });

  // Rows on mixed accounts that still follow the account default (nobody said business or private).
  const accounts = listAccountsRaw(db);
  const mixedIds = accounts.filter((a) => a.scope === 'mixed').map((a) => a.id);
  const unsorted = mixedIds.length ? db.prepare(`SELECT COUNT(*) AS n FROM transactions t
      LEFT JOIN scope_rules sr ON sr.merchant_key = t.merchant_key
      WHERE t.account_id IN (${mixedIds.map(() => '?').join(',')}) AND t.scope IS NULL AND sr.scope IS NULL
        AND t.date >= ?`).get(...mixedIds, `${addMonths(month, -2)}-01`).n : 0;

  return {
    settings: s,
    today,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, scope: a.scope })),
    hasBusinessAccounts: accounts.some((a) => a.scope !== 'private'),
    bank: { current: pos.bank.current, hasData: pos.bank.hasData, accounts: pos.bank.accounts },
    cardsUpcoming: pos.cards.current,
    reallyYours: ils(mine),
    setAside: { amount: ils(setAside), pct: s.setAsidePct, profitYtd: ils(profitYtd), taxPaidYtd: s.taxPaidYtd },
    vat: s.type === 'exempt' ? null : {
      rate: vatRate(today), period: s.vatPeriod,
      toPay: { first: toPay.first, last: toPay.last, dueDate: toPayDate,
        output: ils(toPay.output), input: ils(toPay.input), due: ils(toPay.due), closed: prevOpen },
      open: { first: open.first, last: open.last, dueDate: open.due, output: ils(vatOpen.output), input: ils(vatOpen.input), due: ils(vatOpen.due) },
      missingInvoices: toPay.missingInvoices.length,
    },
    thisMonth: { income: ils(thisMonth.income), expenses: ils(thisMonth.expenses), profit: ils(profitExVat(rows, month, month, s.type)),
      ownerDraws: ils(thisMonth.ownerDraws), ownerInjections: ils(thisMonth.ownerInjections) },
    ytd: { income: ils(ytd.income), expenses: ils(ytd.expenses), profit: ils(profitYtd), ownerDraws: ils(ytd.ownerDraws) },
    exempt: exempt ? { income: ils(exempt.income), ceiling: ils(exemptCeiling(Number(year))), pct: Math.round(exempt.pct * 10) / 10 } : null,
    months,
    unsorted,
    flags,
  };
}

/** From the business to the home: per month, profit, owner draws, home spending (the flow part of the העסק screen). */
export function businessFlow(db, today, count = 6) {
  const s = getBusinessSettings(db, today);
  const biz = loadDataset(db, today, 'business').rows;
  const priv = loadDataset(db, today, 'private').rows;
  const month = monthOf(today);
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const f = monthFlow({ bizRows: biz, privRows: priv, month: addMonths(month, -i), type: s.type });
    months.push({ month: f.month, label: hebMonth(f.month), complete: f.month < month, profit: ils(f.profit),
      ownerDraws: ils(f.ownerDraws), ownerInjections: ils(f.ownerInjections), homeSpending: ils(f.homeSpending),
      homeFundedPct: f.homeFundedPct, leftInBusiness: ils(f.profit - f.ownerDraws + f.ownerInjections) });
  }
  const done = months.filter((m) => m.complete);
  const avg = (k) => (done.length ? Math.round(done.reduce((a, m) => a + (m[k] || 0), 0) / done.length) : null);
  return { type: s.type, months, average: { profit: avg('profit'), ownerDraws: avg('ownerDraws'), homeSpending: avg('homeSpending') } };
}

export { SCOPES, ACCOUNT_SCOPES, TRANSFER_KINDS, BUSINESS_TYPES, VAT_PERIODS };
