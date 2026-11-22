// Business owner mode: the business / private / all lenses and the business figures.
//
// Separation rules (docs/API.md, "Business mode"):
//  - every row has ONE effective scope: its own (set by the user), else its merchant rule's, else its
//    account's ('mixed' accounts default to private until a row is tagged);
//  - a business row may carry businessShare (0-100, for mixed-use expenses such as a car): it is split
//    into a business part and a private part that add up to the original amount exactly;
//  - owner transfers (money moved between the user's own business and private accounts) are neutral
//    everywhere: never income or spending in any lens, and counted once in "all";
//  - every screen reads rows through lensRows(); nothing filters on its own.
// Pure functions only (no DB), so every rule is unit-tested.
import { vatRate, exemptCeiling, allocationThreshold, VAT_DUE_DAY } from './business-rates.js';
import { kindOf } from './categories.js';
import { monthOf, addMonths, daysBetween } from './dates.js';

export const LENSES = ['all', 'business', 'private'];
export const SCOPES = ['business', 'private'];
export const ACCOUNT_SCOPES = ['business', 'private', 'mixed'];
export const OWNER_TRANSFER = 'owner-transfer'; // neutral category forced on owner transfers
export const TRANSFER_KINDS = ['owner_draw', 'owner_injection'];

/** The row's effective scope: 'business' | 'private'. */
export function effectiveScope(row, account) {
  if (row.scope === 'business' || row.scope === 'private') return row.scope;
  if (row.ruleScope === 'business' || row.ruleScope === 'private') return row.ruleScope;
  return account?.scope === 'business' ? 'business' : 'private';
}

/** Business share in percent (0..100) of a row. */
export function businessShare(row, account) {
  if (effectiveScope(row, account) !== 'business') return 0;
  const s = row.businessShare;
  return Number.isInteger(s) && s >= 0 && s <= 100 ? s : 100;
}

/** Split an amount (agorot) into business and private parts that add up exactly. */
// Truncated toward zero, exactly like SQLite integer division, so the SQL lens (repo.js) and this one agree.
export function splitAmount(amount, sharePct) {
  const business = Math.trunc((amount * sharePct) / 100);
  return { business, private: amount - business };
}

/** A payment to the tax authorities (VAT, income tax advances, national insurance is an expense):
 * not a business expense and no VAT inside it. Income-tax advances count as tax already paid. */
const TAX_RE = /מע["״']?מ|מס\s*הכנסה|מקדמ(?:ה|ות)\s*מס/;
export const isTaxPayment = (r) => r.amount < 0 && TAX_RE.test(String(r.description || ''));
export const isIncomeTaxPayment = (r) => isTaxPayment(r) && /מס\s*הכנסה|מקדמ/.test(String(r.description || ''));

const isOwnerTransfer = (r) => r.transferKind === 'owner_draw' || r.transferKind === 'owner_injection';

/**
 * Rows as one lens sees them. Never mutates the input rows.
 * @param rows dataset rows (analytics.buildDataset input format) with scope / ruleScope / businessShare / transferKind
 * @param accountById Map(id -> { scope })
 * @param {'all'|'business'|'private'} lens
 * @returns new row objects; amount is the part that belongs to the lens; owner transfers get category
 *   OWNER_TRANSFER and side ('business' | 'private') - the side of the account they moved on.
 */
export function lensRows(rows, accountById, lens) {
  if (!LENSES.includes(lens)) throw new Error(`bad lens ${lens}`);
  const out = [];
  for (const r of rows) {
    const acc = accountById.get(r.accountId);
    if (isOwnerTransfer(r)) {
      const side = acc?.scope === 'business' ? 'business' : effectiveScope(r, acc);
      if (lens === 'all' || lens === side) out.push({ ...r, category: OWNER_TRANSFER, lensSide: side });
      continue;
    }
    if (lens === 'all') { out.push({ ...r, lensSide: effectiveScope(r, acc) }); continue; }
    // In a lens when some of it belongs there: business if its share > 0, private if < 100 (as in SQL).
    const share = businessShare(r, acc);
    if (lens === 'business' ? share === 0 : share === 100) continue;
    const amount = splitAmount(r.amount, share)[lens];
    out.push({ ...r, amount, lensSide: lens, splitFrom: amount !== r.amount ? r.amount : undefined });
  }
  return out;
}

/**
 * Find owner transfers between the user's own accounts: money out of a business account and the same
 * amount into a private account (or the other way) within maxDays. Only accounts marked business or
 * private (not mixed) take part. Rows the user already tagged are left as they are.
 * @returns Map(rowId -> 'owner_draw' | 'owner_injection')
 */
export function detectOwnerTransfers(rows, accountById, { maxDays = 2 } = {}) {
  const found = new Map();
  const side = (r) => accountById.get(r.accountId)?.scope;
  const cands = rows.filter((r) => r.accountType === 'bank' && r.transferKind == null && r.status !== 'pending'
    && (side(r) === 'business' || side(r) === 'private') && r.amount !== 0);
  const ins = new Map(); // amount -> incoming rows
  for (const r of cands) if (r.amount > 0) { if (!ins.has(r.amount)) ins.set(r.amount, []); ins.get(r.amount).push(r); }
  const used = new Set();
  for (const o of cands) {
    if (o.amount >= 0) continue;
    const match = (ins.get(-o.amount) || []).find((i) => !used.has(i.id) && side(i) !== side(o)
      && Math.abs(daysBetween(o.date, i.date)) <= maxDays);
    if (!match) continue;
    used.add(match.id);
    const kind = side(o) === 'business' ? 'owner_draw' : 'owner_injection';
    found.set(o.id, kind);
    found.set(match.id, kind);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// VAT

/** Categories whose business expenses carry no VAT to claim (salaries, insurance, fees, taxes, cash). */
const NO_VAT_CATEGORIES = new Set(['insurance', 'fees', 'cash', 'salary', 'transfers', 'card-payment', OWNER_TRANSFER, 'taxes']);

/** VAT included in a gross amount (agorot), for a date. */
export const vatInGross = (gross, date) => {
  const rate = vatRate(date);
  return Math.round((gross * rate) / (1 + rate));
};

/** The VAT period a month belongs to: monthly, or bi-monthly (Jan-Feb, Mar-Apr, ...). */
export function vatPeriodOf(month, period = 'monthly') {
  if (period !== 'bimonthly') return { first: month, last: month, due: `${addMonths(month, 1)}-${String(VAT_DUE_DAY).padStart(2, '0')}` };
  const m = Number(month.slice(5, 7));
  const first = `${month.slice(0, 4)}-${String(m % 2 ? m : m - 1).padStart(2, '0')}`;
  const last = addMonths(first, 1);
  return { first, last, due: `${addMonths(last, 1)}-${String(VAT_DUE_DAY).padStart(2, '0')}` };
}

/**
 * VAT of one period from business rows (lensRows(..., 'business')).
 * Exempt dealers: always zero. Rows with noVat (or no-VAT categories) carry none.
 */
export function vatForPeriod(bizRows, { type, first, last }) {
  const res = { output: 0, input: 0, due: 0, missingInvoices: [] };
  if (type === 'exempt') return res;
  for (const r of bizRows) {
    const m = monthOf(r.date);
    if (m < first || m > last || r.excluded || r.category === OWNER_TRANSFER || r.noVat || isTaxPayment(r)) continue;
    if (r.amount > 0 && kindOf(r.category) === 'income') res.output += vatInGross(r.amount, r.date);
    else if (r.amount < 0 && kindOf(r.category) === 'expense' && !NO_VAT_CATEGORIES.has(r.category)) {
      const gross = -r.amount;
      const vat = vatInGross(gross, r.date);
      if (gross - vat > allocationThreshold(r.date) && !r.invoice) res.missingInvoices.push(r.id);
      res.input += vat;
    }
  }
  res.due = res.output - res.input;
  return res;
}

// ---------------------------------------------------------------------------------------------
// Business figures

/** Business income and expenses (agorot, VAT included) for months [first..last]; owner transfers apart. */
export function businessTotals(bizRows, first, last) {
  const t = { income: 0, expenses: 0, ownerDraws: 0, ownerInjections: 0, taxPayments: 0, incomeTaxPaid: 0 };
  for (const r of bizRows) {
    const m = monthOf(r.date);
    if (m < first || m > last || r.excluded) continue;
    if (r.category === OWNER_TRANSFER) {
      if (r.transferKind === 'owner_draw') t.ownerDraws += Math.abs(r.amount);
      else t.ownerInjections += Math.abs(r.amount);
      continue;
    }
    if (isTaxPayment(r)) {
      t.taxPayments += -r.amount;
      if (isIncomeTaxPayment(r)) t.incomeTaxPaid += -r.amount;
      continue;
    }
    const k = kindOf(r.category);
    if (k === 'income' && r.amount > 0) t.income += r.amount;
    else if (k === 'expense' || (k === 'income' && r.amount < 0)) t.expenses += -r.amount;
  }
  return t;
}

/** Profit without VAT (agorot): what the business earned, net of VAT both ways. */
export function profitExVat(bizRows, first, last, type) {
  const t = businessTotals(bizRows, first, last);
  const v = vatForPeriod(bizRows, { type, first, last });
  return (t.income - v.output) - (t.expenses - v.input);
}

/**
 * How much of the business money is really its own now (agorot):
 * business bank balances - business card charges still to come - VAT owed - the tax set-aside.
 */
export function reallyYours({ bankBalance, upcomingCards, vatDue, setAside }) {
  return bankBalance - upcomingCards - Math.max(0, vatDue) - Math.max(0, setAside);
}

/** Tax set-aside (agorot): pct of this year's profit, minus tax already paid this year. */
export function taxSetAside({ profitYtd, pct, taxPaidYtd }) {
  return Math.max(0, Math.round((Math.max(0, profitYtd) * pct) / 100) - Math.max(0, taxPaidYtd));
}

/** Exempt dealer: gross business income this calendar year against the ceiling. */
export function exemptStatus(bizRows, year) {
  let income = 0;
  for (const r of bizRows) {
    if (r.date.slice(0, 4) !== String(year) || r.excluded || r.category === OWNER_TRANSFER) continue;
    if (kindOf(r.category) === 'income' && r.amount > 0) income += r.amount;
  }
  const ceiling = exemptCeiling(year);
  return { income, ceiling, pct: ceiling ? (income / ceiling) * 100 : 0 };
}

/**
 * The flow of one month: what the business earned (profit ex VAT), what the owner drew home, and what
 * the home spent (private expenses). homeFundedPct: draws as a share of home spending.
 */
export function monthFlow({ bizRows, privRows, month, type }) {
  const profit = profitExVat(bizRows, month, month, type);
  const biz = businessTotals(bizRows, month, month);
  let home = 0;
  for (const r of privRows) {
    if (monthOf(r.date) !== month || r.excluded || r.category === OWNER_TRANSFER) continue;
    const k = kindOf(r.category);
    if (k === 'expense') home += -r.amount;
  }
  return {
    month, profit, ownerDraws: biz.ownerDraws, ownerInjections: biz.ownerInjections, homeSpending: home,
    homeFundedPct: home > 0 ? Math.round((biz.ownerDraws / home) * 100) : null,
  };
}

/**
 * Red flags for the business (severity alert | warning | info), plain Hebrew.
 * @param o { type, today, bizRows, vat: { due, missingInvoices, periodDue }, setAside, bankBalance }
 */
export function businessFlags({ type, today, bizRows, vat, setAside, bankBalance }) {
  const flags = [];
  const year = Number(today.slice(0, 4));
  if (type === 'exempt') {
    const s = exemptStatus(bizRows, year);
    if (s.pct >= 100) flags.push({ id: 'exempt-over', severity: 'alert', title: 'עברת את תקרת העוסק הפטור', body: 'ההכנסות של העסק השנה עברו את התקרה. צריך לעבור לעוסק מורשה: כדאי לדבר עם רואה החשבון עכשיו.' });
    else if (s.pct >= 80) flags.push({ id: 'exempt-near', severity: 'warning', title: `ניצלת ${Math.round(s.pct)}% מתקרת העוסק הפטור`, body: 'כדאי לתכנן מראש מה קורה אם ההכנסות ימשיכו בקצב הזה עד סוף השנה.' });
  }
  if (type !== 'exempt' && vat) {
    const days = daysBetween(today, vat.periodDue);
    if (vat.due > 0 && days >= 0 && days <= 10 && bankBalance < vat.due + setAside) {
      flags.push({ id: 'vat-cash', severity: 'alert', title: 'תשלום מע"מ מתקרב ואין מספיק כסף בצד', body: `המע"מ לתשלום עד ${vat.periodDue.slice(8, 10)}.${Number(vat.periodDue.slice(5, 7))} גבוה ממה שנשאר בחשבון העסק אחרי ההפרשה למס.` });
    }
    if (vat.missingInvoices.length) {
      flags.push({ id: 'invoices', severity: 'warning', title: `${vat.missingInvoices.length} הוצאות גדולות בלי סימון חשבונית`, body: 'מעל הסף הזה מע"מ יוכר רק עם חשבונית שיש לה מספר הקצאה. סמן את החשבוניות שקיבלת.', rowIds: vat.missingInvoices });
    }
  }
  return flags;
}

