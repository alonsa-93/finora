// Money maths: spending/income classification, monthly summary, recurring detection,
// forecast and upcoming charges. Everything here is pure (no DB access) so it is unit-testable.
// All internal amounts are integer agorot; conversion to ILS happens in the *Output helpers.
import { CATEGORY_BY_ID, kindOf } from './categories.js';
import {
  monthOf, addMonths, daysInMonth, addDays, addMonthsToDate, daysBetween,
} from './dates.js';
import { toILS } from './money.js';
import { priceLevels } from './stats.js';

const NON_RECURRING_CATS = new Set(['card-payment', 'transfers', 'cash', 'salary']);

// ---------------------------------------------------------------------------------------------
// Dataset

/**
 * @param rows transactions: { id, accountId, accountType, date, processedDate, description, merchantKey,
 *   amount (agorot), instNumber, instTotal, status, category, isCardPayment, excluded, identifier }
 * @param accounts { id, type, name, balance (agorot|null), ... }
 */
export function buildDataset({ rows, accounts, today }) {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const hasCards = accounts.some((a) => a.type === 'card');
  const firstDate = sorted.length ? sorted[0].date : null;
  // A first month that starts after the 3rd is treated as partial and kept out of baselines.
  let firstFullMonth = null;
  if (firstDate) firstFullMonth = Number(firstDate.slice(8, 10)) <= 3 ? monthOf(firstDate) : addMonths(monthOf(firstDate), 1);
  const byMonth = new Map();
  for (const r of sorted) {
    r.contrib = contribution(r, hasCards);
    const m = monthOf(r.date);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  return { rows: sorted, accounts, today, hasCards, firstDate, firstFullMonth, byMonth,
    accountById: new Map(accounts.map((a) => [a.id, a])) };
}

/**
 * How a row affects totals.
 *  - card rows: purchases are spending; positive card rows (refunds) reduce that category's spending.
 *  - bank rows: income-kind categories are income; expense-kind are spending (positive = refund);
 *    neutral (transfers, card payments) are ignored - except card payments when no card account is
 *    connected, because then the debit is the only record of that spending.
 * @returns {{type:'expense'|'income', category:string, value:number}|null} value in agorot
 */
export function contribution(r, hasCards) {
  if (r.excluded) return null;
  const kind = kindOf(r.category);
  if (r.accountType === 'card') {
    if (kind !== 'expense') return null;
    return { type: 'expense', category: r.category, value: -r.amount };
  }
  if (r.isCardPayment || r.category === 'card-payment') {
    if (hasCards) return null;
    return { type: 'expense', category: 'card-payment', value: -r.amount };
  }
  if (kind === 'neutral') return null;
  if (kind === 'income') return { type: 'income', category: r.category, value: r.amount };
  return { type: 'expense', category: r.category, value: -r.amount };
}

export const isInstallment = (r) => r.instTotal != null && r.instTotal > 1;

/** Aggregate one month. Category totals are net of refunds and clamped at zero. */
export function monthTotals(ds, month, { uptoDay = 31, accountId = null } = {}) {
  const rows = ds.byMonth.get(month) || [];
  const byCat = new Map();
  let income = 0;
  for (const r of rows) {
    if (!r.contrib) continue;
    if (Number(r.date.slice(8, 10)) > uptoDay) continue;
    if (accountId != null && r.accountId !== accountId) continue;
    if (r.contrib.type === 'income') { income += r.contrib.value; continue; }
    const c = byCat.get(r.contrib.category) || { amount: 0, count: 0 };
    c.amount += r.contrib.value;
    c.count += 1;
    byCat.set(r.contrib.category, c);
  }
  let expenses = 0;
  for (const c of byCat.values()) expenses += Math.max(0, c.amount);
  return { income: Math.max(0, income), expenses, byCat, hasData: rows.length > 0 };
}

/** Previous up-to-3 months average for a category (or total), only over full months with data. */
function baselineMonths(ds, month, n = 3) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const m = addMonths(month, -i);
    if (!ds.firstFullMonth || m < ds.firstFullMonth) break;
    out.push(m);
  }
  return out;
}

export function categoryAverage(ds, month, category, n = 3) {
  const months = baselineMonths(ds, month, n);
  if (!months.length) return null;
  let sum = 0;
  for (const m of months) sum += Math.max(0, monthTotals(ds, m).byCat.get(category)?.amount || 0);
  return Math.round(sum / months.length);
}

// ---------------------------------------------------------------------------------------------
// Recurring charges

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const near = (a, b, tol) => Math.abs(a - b) <= Math.max(100, Math.abs(b) * tol); // tol relative, >= 1 ILS

/**
 * Detect subscriptions / standing orders. Deterministic.
 * @returns array of { merchantKey, description, category, amount (agorot), cadence, lastDate, nextDate,
 *   monthsSeen, yearlyCost (agorot), history: [{month,date,amount,ids}], variable, changes: [...],
 *   priceChange: latest change in the last 12 months (see latestPriceChange) | null, ids:[...], lastId }
 */
export function detectRecurring(ds) {
  const groups = new Map();
  for (const r of ds.rows) {
    if (r.excluded || r.amount >= 0 || isInstallment(r) || r.date > ds.today) continue;
    if (NON_RECURRING_CATS.has(r.category) || r.isCardPayment) continue;
    if (!r.merchantKey) continue;
    if (!groups.has(r.merchantKey)) groups.set(r.merchantKey, []);
    groups.get(r.merchantKey).push(r);
  }
  const out = [];
  for (const [key, list] of groups) {
    if (list.length < 3) continue;
    // One charge per period: merge same-month charges; too many per month => not a subscription.
    const months = new Map();
    for (const r of list) {
      const m = monthOf(r.date);
      if (!months.has(m)) months.set(m, []);
      months.get(m).push(r);
    }
    if (list.length / months.size > 1.25) continue;
    if ([...months.values()].some((v) => v.length > 2)) continue;
    const series = [...months.keys()].sort().map((m) => {
      const rs = months.get(m);
      return { month: m, date: rs[0].date, amount: rs.reduce((s, r) => s + -r.amount, 0), rows: rs };
    });
    if (series.length < 3) continue;

    const intervals = [];
    for (let i = 1; i < series.length; i++) intervals.push(daysBetween(series[i - 1].date, series[i].date));
    const medInt = median(intervals);
    let cadence = null;
    if (medInt >= 25 && medInt <= 36) cadence = 'monthly';
    else if (medInt >= 55 && medInt <= 67) cadence = 'bimonthly';
    if (!cadence) continue;
    // Regularity: most intervals close to the cadence.
    const target = cadence === 'monthly' ? 30.4 : 60.8;
    const regular = intervals.filter((d) => Math.abs(d - target) <= (cadence === 'monthly' ? 8 : 12)).length;
    if (regular / intervals.length < 0.7) continue;

    // Amount stability over the recent charges (one outlier allowed; a price step is fine).
    const recent = series.slice(-6);
    const med = median(recent.map((s) => s.amount));
    const offCount = recent.filter((s) => !near(s.amount, med, 0.2)).length;
    if (offCount > 1) continue;

    const last = series[series.length - 1];
    const maxAge = cadence === 'monthly' ? 45 : 75;
    if (daysBetween(last.date, ds.today) > maxAge) continue; // ended

    // Price changes: ONE definition for every screen (קבועים, מגמות מחירים, insights).
    const { history, variable, changes } = chargeChanges(series, cadence);
    const priceChange = latestPriceChange({ variable, changes }, priceChangeWindow(ds.today));

    const lastRow = last.rows[last.rows.length - 1];
    const step = cadence === 'monthly' ? 1 : 2;
    out.push({
      merchantKey: key,
      description: lastRow.description,
      category: lastRow.category,
      amount: last.amount,
      cadence,
      lastDate: last.date,
      nextDate: addMonthsToDate(last.date, step),
      monthsSeen: series.length,
      yearlyCost: last.amount * (12 / step),
      history, variable, changes, priceChange,
      ids: list.map((r) => r.id),
      lastId: lastRow.id,
    });
  }
  out.sort((a, b) => b.yearlyCost - a.yearlyCost || (a.merchantKey < b.merchantKey ? -1 : 1));
  return out;
}

/**
 * Price levels and change points of one recurring charge (one charge per period), via
 * stats.priceLevels: a change needs the old price charged at least twice; a bill that moves every
 * time is `variable` and has no change points. Amounts in agorot.
 */
export function chargeChanges(series, cadence) {
  const history = series.map((s) => ({ month: s.month, date: s.date, amount: s.amount, ids: s.ids || s.rows.map((r) => r.id) }));
  const lv = priceLevels(history.map((h) => h.amount));
  const perYear = cadence === 'monthly' ? 12 : 6;
  const changes = lv.changes.map((c) => {
    const at = history[c.index];
    return {
      date: at.date, from: c.from, to: c.to, diff: c.diff, pct: c.pct, confirmed: c.confirmed,
      yearly: c.diff * perYear, ids: [...history[c.index - 1].ids, ...at.ids],
    };
  });
  return { history, variable: lv.variable, changes };
}

/** The default "has the price changed?" window: the 12 months before the current one, up to today. */
export function priceChangeWindow(today) {
  return { from: `${addMonths(monthOf(today), -12)}-01`, to: today };
}

/**
 * THE answer to "did this recurring charge change price?", shared by the recurring list, the price
 * trends and the insights: the most recent change point inside [from, to], or null.
 */
export function latestPriceChange({ variable, changes }, { from, to }) {
  if (variable) return null;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if (c.date >= from && c.date <= to) return c;
  }
  return null;
}

export function recurringOutput(rec) {
  return rec.map((r) => ({
    description: r.description,
    category: r.category,
    amount: toILS(r.amount),
    cadence: r.cadence,
    lastDate: r.lastDate,
    nextDate: r.nextDate,
    monthsSeen: r.monthsSeen,
    variable: Boolean(r.variable), // a bill that moves every time: no price changes are claimed
    yearlyCost: toILS(r.yearlyCost),
    priceChange: r.priceChange ? {
      from: toILS(r.priceChange.from), to: toILS(r.priceChange.to), pct: r.priceChange.pct, date: r.priceChange.date,
      confirmed: r.priceChange.confirmed, yearly: toILS(r.priceChange.yearly),
    } : null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Upcoming charges

export function accountLabel(a) {
  return a?.name || '';
}

/** Card rows not yet charged to the bank: processed in the future, or still pending. */
export function upcomingCardRows(ds) {
  return ds.rows.filter((r) => r.accountType === 'card' && !r.excluded
    && (r.status === 'pending' || (r.processedDate && r.processedDate > ds.today)));
}

export function upcomingCardChargesTotal(ds) {
  const sum = upcomingCardRows(ds).reduce((s, r) => s + -r.amount, 0);
  return Math.max(0, sum);
}

/** The latest row of every instalment plan (per account, merchant, plan length and amount). */
export function installmentSeries(ds) {
  const series = new Map();
  for (const r of ds.rows) {
    if (!isInstallment(r) || r.excluded || r.amount >= 0) continue;
    const k = `${r.accountId}|${r.merchantKey}|${r.instTotal}|${r.amount}`;
    const cur = series.get(k);
    if (!cur || r.instNumber > cur.instNumber) series.set(k, r);
  }
  return [...series.values()];
}

/** Upcoming known charges within `days` days after today (default 31). Amounts in agorot. */
export function computeUpcoming(ds, recurring, days = 31) {
  const horizon = addDays(ds.today, days);
  const out = [];
  for (const r of recurring) {
    if (r.nextDate > ds.today && r.nextDate <= horizon) {
      out.push({ description: r.description, amount: r.amount, expectedDate: r.nextDate, kind: 'recurring', merchantKey: r.merchantKey });
    }
  }
  for (const last of installmentSeries(ds)) {
    if (last.instNumber >= last.instTotal) continue;
    const next = addMonthsToDate(last.date, 1);
    if (next > ds.today && next <= addDays(ds.today, Math.max(days, 45))) {
      out.push({ description: `${last.description} (תשלום ${last.instNumber + 1} מתוך ${last.instTotal})`,
        amount: -last.amount, expectedDate: next, kind: 'installment', merchantKey: last.merchantKey });
    }
  }
  // Card bills, grouped per card account and charge date.
  const perAccount = new Map();
  for (const r of upcomingCardRows(ds)) {
    if (!perAccount.has(r.accountId)) perAccount.set(r.accountId, []);
    perAccount.get(r.accountId).push(r);
  }
  for (const [accountId, rows] of perAccount) {
    const futureDates = [...new Set(rows.map((r) => r.processedDate).filter((d) => d && d > ds.today))].sort();
    let fallback = futureDates[0];
    if (!fallback) {
      // Estimate from the last known charge day of this card.
      const past = ds.rows.filter((r) => r.accountId === accountId && r.processedDate && r.processedDate <= ds.today)
        .map((r) => r.processedDate).sort();
      const day = past.length ? Number(past[past.length - 1].slice(8, 10)) : 10;
      let cand = `${monthOf(ds.today)}-${String(Math.min(day, daysInMonth(monthOf(ds.today)))).padStart(2, '0')}`;
      if (cand <= ds.today) cand = addMonthsToDate(cand, 1);
      fallback = cand;
    }
    const groups = new Map();
    for (const r of rows) {
      const d = r.processedDate && r.processedDate > ds.today ? r.processedDate : fallback;
      groups.set(d, (groups.get(d) || 0) + -r.amount);
    }
    const acc = ds.accountById.get(accountId);
    for (const [d, amt] of groups) {
      if (amt <= 0) continue;
      out.push({ description: `חיוב ${accountLabel(acc)}`.trim(), amount: amt, expectedDate: d, kind: 'cardCharge' });
    }
  }
  out.sort((a, b) => (a.expectedDate < b.expectedDate ? -1 : a.expectedDate > b.expectedDate ? 1 : b.amount - a.amount));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Forecast (current month only)

/**
 * projected = spent so far + known recurring/instalments still due this month
 *           + discretionary pace x remaining days.
 * Pace blends this month's discretionary daily rate with the 3-month historical rate,
 * weighted by how far into the month we are. Range from historical variability.
 * @returns {{projected, low, high, spent, known, avg3m}|null} agorot
 */
export function computeForecast(ds, recurring) {
  const month = monthOf(ds.today);
  const day = Number(ds.today.slice(8, 10));
  const dim = daysInMonth(month);
  if (day < 5 || !ds.firstDate || daysBetween(ds.firstDate, ds.today) < 5) return null;

  const recurringKeys = new Set(recurring.map((r) => r.merchantKey));
  // One-off large charges (>= 500 ILS) are counted in "spent" but never extrapolated into the pace.
  const LUMPY = 50000;
  const isDiscretionary = (r) => !recurringKeys.has(r.merchantKey) && !isInstallment(r)
    && r.category !== 'housing' && r.category !== 'card-payment'
    && Math.abs(r.contrib?.value || 0) < LUMPY;

  const spent = monthTotals(ds, month).expenses;
  let discSoFar = 0;
  for (const r of ds.byMonth.get(month) || []) {
    if (r.contrib?.type === 'expense' && r.date <= ds.today && isDiscretionary(r)) discSoFar += r.contrib.value;
  }
  discSoFar = Math.max(0, discSoFar);

  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(dim).padStart(2, '0')}`;
  let known = 0;
  for (const r of recurring) {
    if (r.nextDate > ds.today && r.nextDate <= monthEnd && r.lastDate < monthStart) known += r.amount;
  }
  for (const last of installmentSeries(ds)) {
    if (last.instNumber >= last.instTotal) continue;
    const next = addMonthsToDate(last.date, 1);
    if (next > ds.today && next <= monthEnd) known += -last.amount;
  }

  const hist = baselineMonths(ds, month, 3).map((m) => {
    let d = 0;
    for (const r of ds.byMonth.get(m) || []) if (r.contrib?.type === 'expense' && isDiscretionary(r)) d += r.contrib.value;
    return { daily: Math.max(0, d) / daysInMonth(m), total: Math.max(0, d) };
  });
  const curDaily = discSoFar / day;
  const w = day / dim;
  const histDaily = hist.length ? hist.reduce((s, h) => s + h.daily, 0) / hist.length : null;
  const rate = histDaily == null ? curDaily : w * curDaily + (1 - w) * histDaily;
  const remaining = dim - day;
  const projected = spent + known + rate * remaining;

  let cv = 0.15;
  if (hist.length >= 2) {
    const mean = hist.reduce((s, h) => s + h.total, 0) / hist.length;
    const sd = Math.sqrt(hist.reduce((s, h) => s + (h.total - mean) ** 2, 0) / hist.length);
    if (mean > 0) cv = Math.min(0.5, Math.max(0.08, sd / mean));
  }
  const margin = rate * remaining * cv + known * 0.03 + spent * 0.01;
  const totalsHist = baselineMonths(ds, month, 3).map((m) => monthTotals(ds, m).expenses);
  const r10 = (x) => Math.round(x / 1000) * 1000; // round to 10 ILS (in agorot)
  return {
    projected: r10(projected),
    low: r10(Math.max(spent + known, projected - margin)),
    high: r10(projected + margin),
    spent, known,
    avg3m: totalsHist.length ? Math.round(totalsHist.reduce((s, x) => s + x, 0) / totalsHist.length) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Summary

export function computeSummary(ds, month) {
  const curMonth = monthOf(ds.today);
  const isCurrentMonth = month === curMonth;
  const dim = daysInMonth(month);
  const dayOfMonth = isCurrentMonth ? Number(ds.today.slice(8, 10)) : dim;
  const prev = addMonths(month, -1);
  const prevDim = daysInMonth(prev);

  const cur = monthTotals(ds, month);
  const prevFull = monthTotals(ds, prev);
  const prevSame = monthTotals(ds, prev, { uptoDay: Math.min(dayOfMonth, prevDim) });
  const prevHasData = prevFull.hasData && (!ds.firstFullMonth || prev >= ds.firstFullMonth);
  const baseline = isCurrentMonth ? prevSame.expenses : prevFull.expenses;
  const expensesChangePct = prevHasData && baseline > 0
    ? Math.round(((cur.expenses - baseline) / baseline) * 1000) / 10 : null;

  const months = new Set(ds.byMonth.keys());
  months.add(curMonth);
  const availableMonths = [...months].filter((m) => m <= curMonth).sort().reverse();

  // Balances
  const bankAccounts = ds.accounts.filter((a) => a.type === 'bank');
  const withBal = bankAccounts.filter((a) => a.balance != null);
  const bankTotal = withBal.length ? withBal.reduce((s, a) => s + a.balance, 0) : null;
  const accounts = ds.accounts.map((a) => ({
    accountId: a.id, name: a.name, type: a.type,
    balance: a.type === 'bank' ? toILS(a.balance) : null,
    monthSpend: a.type === 'card' ? toILS(monthTotals(ds, month, { accountId: a.id }).expenses) : null,
  }));

  // Categories
  const byCategory = [];
  for (const [cat, c] of cur.byCat) {
    if (c.amount <= 0) continue;
    const meta = CATEGORY_BY_ID.get(cat) || CATEGORY_BY_ID.get('other');
    const avg = categoryAverage(ds, month, cat);
    byCategory.push({
      category: cat, name: meta.name, color: meta.color,
      amount: toILS(c.amount),
      prevAmount: toILS(Math.max(0, prevFull.byCat.get(cat)?.amount || 0)),
      avg3m: avg == null ? null : toILS(avg),
      count: c.count,
    });
  }
  byCategory.sort((a, b) => b.amount - a.amount || (a.category < b.category ? -1 : 1));

  // Daily cumulative
  const dayExp = new Array(dim + 1).fill(0);
  for (const r of ds.byMonth.get(month) || []) {
    if (r.contrib?.type === 'expense') dayExp[Number(r.date.slice(8, 10))] += r.contrib.value;
  }
  const prevDay = new Array(prevDim + 1).fill(0);
  for (const r of ds.byMonth.get(prev) || []) {
    if (r.contrib?.type === 'expense') prevDay[Number(r.date.slice(8, 10))] += r.contrib.value;
  }
  const daily = [];
  let cum = 0;
  let pcum = 0;
  for (let d = 1; d <= dim; d++) {
    if (d <= prevDim) pcum += prevDay[d];
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const future = isCurrentMonth && d > dayOfMonth;
    if (!future) cum += dayExp[d];
    daily.push({
      date,
      expenses: future ? null : toILS(dayExp[d]),
      cumulative: future ? null : toILS(cum),
      prevCumulative: prevHasData ? toILS(pcum) : null,
    });
  }

  // Monthly (last 12 incl. selected)
  const monthly = [];
  for (let i = 11; i >= 0; i--) {
    const m = addMonths(month, -i);
    const t = monthTotals(ds, m);
    monthly.push({ month: m, income: toILS(t.income), expenses: toILS(t.expenses) });
  }

  const recurring = detectRecurring(ds);
  let forecast = null;
  let upcoming = [];
  if (isCurrentMonth) {
    const f = computeForecast(ds, recurring);
    if (f) forecast = { projectedExpenses: toILS(f.projected), low: toILS(f.low), high: toILS(f.high) };
    upcoming = computeUpcoming(ds, recurring).map((u) => ({
      description: u.description, amount: toILS(u.amount), expectedDate: u.expectedDate, kind: u.kind,
    }));
  }

  return {
    month, isCurrentMonth, daysInMonth: dim, dayOfMonth, availableMonths,
    totals: {
      income: toILS(cur.income), expenses: toILS(cur.expenses), net: toILS(cur.income - cur.expenses),
      prevIncome: prevHasData ? toILS(prevFull.income) : null,
      prevExpenses: prevHasData ? toILS(prevFull.expenses) : null,
      prevExpensesSameDay: prevHasData ? toILS(prevSame.expenses) : null,
      expensesChangePct,
    },
    balances: {
      bankTotal: toILS(bankTotal),
      upcomingCardCharges: toILS(upcomingCardChargesTotal(ds)),
      accounts,
    },
    byCategory, daily, monthly, forecast, upcoming,
    topMerchants: topMerchants(ds, month),
  };
}

export function topMerchants(ds, month, limit = 8) {
  const groups = new Map();
  for (const r of ds.byMonth.get(month) || []) {
    if (r.contrib?.type !== 'expense' || r.contrib.category === 'card-payment') continue;
    const g = groups.get(r.merchantKey) || { amount: 0, count: 0, names: new Map() };
    g.amount += r.contrib.value;
    if (r.contrib.value > 0) g.count += 1;
    g.names.set(r.description, (g.names.get(r.description) || 0) + 1);
    groups.set(r.merchantKey, g);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.amount > 0)
    .map(([key, g]) => {
      const name = [...g.names.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
      return { key, description: name, amount: g.amount, count: g.count };
    })
    .sort((a, b) => b.amount - a.amount || (a.key < b.key ? -1 : 1))
    .slice(0, limit)
    .map(({ description, amount, count }) => ({ description, amount: toILS(amount), count }));
}
