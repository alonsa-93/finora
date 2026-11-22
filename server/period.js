// Dashboard summary for a period other than one calendar month: a rolling window (last month,
// 3 months, year), the year so far, a range of months, or any set of months picked together.
// The one-month view stays in analytics.computeSummary; this one answers the same questions for a
// longer span and compares it with the period before it.
import { CATEGORY_BY_ID } from './categories.js';
import { addDays, addMonths, addMonthsToDate, daysBetween, daysInMonth, monthOf, isValidMonth } from './dates.js';
import { toILS } from './money.js';
import { detectRecurring, computeUpcoming, upcomingCardChargesTotal } from './analytics.js';

export const PRESETS = ['m1', 'm3', 'ytd', 'y1'];
const MAX_MONTHS = 36;
const MAX_RANGE_YEARS = 10;

const monthEnd = (m) => `${m}-${String(daysInMonth(m)).padStart(2, '0')}`;

/**
 * Resolve a request into a period. Returns null when it is the plain one-month view.
 * @param {{ period?: string, months?: string[], from?: string, to?: string }} q
 */
export function resolvePeriod(q, today) {
  const curMonth = monthOf(today);
  if (q.months?.length) {
    const months = [...new Set(q.months)].filter((m) => isValidMonth(m) && m <= curMonth).sort();
    if (!months.length) return null;
    const last = months[months.length - 1];
    return { kind: 'months', months, from: `${months[0]}-01`, to: last === curMonth ? today : monthEnd(last) };
  }
  if (q.from || q.to) {
    const to = q.to && q.to < today ? q.to : today;
    // At most MAX_RANGE_YEARS: the summary walks the range month by month, and from=0001-01-01
    // would mean ~24,000 months.
    const floor = addMonthsToDate(to, -12 * MAX_RANGE_YEARS);
    const asked = q.from || '2000-01-01';
    const from = asked < floor ? floor : asked;
    return from <= to ? { kind: 'range', from, to } : null;
  }
  switch (q.period) {
    case 'm1': return { kind: 'm1', from: addDays(addMonthsToDate(today, -1), 1), to: today };
    case 'm3': return { kind: 'm3', from: addDays(addMonthsToDate(today, -3), 1), to: today };
    case 'y1': return { kind: 'y1', from: addDays(addMonthsToDate(today, -12), 1), to: today };
    case 'ytd': return { kind: 'ytd', from: `${today.slice(0, 4)}-01-01`, to: today };
    default: return null;
  }
}

/** The period to compare with: the same months a year earlier for a set of months, otherwise the
 * window of the same length right before it. */
function previousOf(p) {
  if (p.kind === 'months') {
    const months = p.months.map((m) => addMonths(m, -12));
    const lastDay = p.to.slice(8, 10);
    const last = months[months.length - 1];
    // the current month counts up to today's day, so its year-ago twin does too
    const to = p.to.slice(0, 7) === p.months[p.months.length - 1] && p.to !== monthEnd(p.months[p.months.length - 1])
      ? `${last}-${String(Math.min(Number(lastDay), daysInMonth(last))).padStart(2, '0')}` : monthEnd(last);
    return { kind: 'months', months, from: `${months[0]}-01`, to };
  }
  const days = daysBetween(p.from, p.to) + 1;
  const to = addDays(p.from, -1);
  return { kind: 'range', from: addDays(to, -(days - 1)), to };
}

function inPeriod(p) {
  if (p.kind === 'months') {
    const set = new Set(p.months);
    return (d) => set.has(d.slice(0, 7)) && d <= p.to;
  }
  return (d) => d >= p.from && d <= p.to;
}

/** Totals over a period; category totals are net of refunds and clamped at zero (as monthTotals). */
export function periodTotals(ds, p, { accountId = null } = {}) {
  const has = inPeriod(p);
  const byCat = new Map();
  let income = 0;
  let rows = 0;
  for (const r of ds.rows) {
    if (r.date < p.from) continue;
    if (r.date > p.to) break;
    if (!has(r.date)) continue;
    rows += 1;
    if (!r.contrib) continue;
    if (accountId != null && r.accountId !== accountId) continue;
    if (r.contrib.type === 'income') { income += r.contrib.value; continue; }
    const c = byCat.get(r.contrib.category) || { amount: 0, count: 0 };
    c.amount += r.contrib.value;
    c.count += 1;
    byCat.set(r.contrib.category, c);
  }
  let expenses = 0;
  for (const c of byCat.values()) expenses += Math.max(0, c.amount);
  return { income: Math.max(0, income), expenses, byCat, hasData: rows > 0 };
}

function topMerchantsIn(ds, p, limit = 8) {
  const has = inPeriod(p);
  const groups = new Map();
  for (const r of ds.rows) {
    if (r.date < p.from) continue;
    if (r.date > p.to) break;
    if (!has(r.date) || r.contrib?.type !== 'expense' || r.contrib.category === 'card-payment') continue;
    const g = groups.get(r.merchantKey) || { amount: 0, count: 0, names: new Map() };
    g.amount += r.contrib.value;
    if (r.contrib.value > 0) g.count += 1;
    g.names.set(r.description, (g.names.get(r.description) || 0) + 1);
    groups.set(r.merchantKey, g);
  }
  return [...groups.entries()].filter(([, g]) => g.amount > 0)
    .map(([key, g]) => ({ key, description: [...g.names.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0], amount: g.amount, count: g.count }))
    .sort((a, b) => b.amount - a.amount || (a.key < b.key ? -1 : 1))
    .slice(0, limit)
    .map(({ description, amount, count }) => ({ description, amount: toILS(amount), count }));
}

/** Months the period touches, oldest first (for a set: exactly the chosen months). */
function monthsOf(p) {
  if (p.kind === 'months') return p.months;
  const out = [];
  for (let m = monthOf(p.from); m <= monthOf(p.to); m = addMonths(m, 1)) out.push(m);
  return out;
}

export function computePeriodSummary(ds, p) {
  const today = ds.today;
  const prev = previousOf(p);
  const cur = periodTotals(ds, p);
  const before = periodTotals(ds, prev);
  // Compare only when the data covers the whole previous period.
  const prevHasData = before.hasData && ds.firstDate != null && ds.firstDate <= prev.from;
  const days = p.kind === 'months'
    ? p.months.reduce((n, m) => n + (m === monthOf(today) && p.to === today ? Number(today.slice(8, 10)) : daysInMonth(m)), 0)
    : daysBetween(p.from, p.to) + 1;
  const expensesChangePct = prevHasData && before.expenses > 0
    ? Math.round(((cur.expenses - before.expenses) / before.expenses) * 1000) / 10 : null;

  const curMonth = monthOf(today);
  const allMonths = new Set(ds.byMonth.keys());
  allMonths.add(curMonth);
  const availableMonths = [...allMonths].filter((m) => m <= curMonth).sort().reverse();

  const accounts = ds.accounts.map((a) => ({
    accountId: a.id, name: a.name, type: a.type,
    balance: a.type === 'bank' ? toILS(a.balance) : null,
    monthSpend: a.type === 'card' ? toILS(periodTotals(ds, p, { accountId: a.id }).expenses) : null,
  }));
  const withBal = ds.accounts.filter((a) => a.type === 'bank' && a.balance != null);

  const byCategory = [];
  for (const [cat, c] of cur.byCat) {
    if (c.amount <= 0) continue;
    const meta = CATEGORY_BY_ID.get(cat) || CATEGORY_BY_ID.get('other');
    const prevAmount = prevHasData ? toILS(Math.max(0, before.byCat.get(cat)?.amount || 0)) : null;
    byCategory.push({ category: cat, name: meta.name, color: meta.color, amount: toILS(c.amount), prevAmount, count: c.count });
  }
  byCategory.sort((a, b) => b.amount - a.amount || (a.category < b.category ? -1 : 1));

  // Day by day, only for a short continuous window (up to ~2 months), with the previous one beside it.
  let daily = null;
  if (p.kind !== 'months' && days <= 62) {
    const dayExp = new Map();
    const prevExp = new Map();
    for (const r of ds.rows) {
      if (r.contrib?.type !== 'expense') continue;
      if (r.date >= p.from && r.date <= p.to) dayExp.set(r.date, (dayExp.get(r.date) || 0) + r.contrib.value);
      else if (r.date >= prev.from && r.date <= prev.to) prevExp.set(r.date, (prevExp.get(r.date) || 0) + r.contrib.value);
    }
    daily = [];
    let cum = 0, pcum = 0;
    for (let i = 0; i < days; i++) {
      const d = addDays(p.from, i);
      cum += dayExp.get(d) || 0;
      pcum += prevExp.get(addDays(prev.from, i)) || 0;
      daily.push({ date: d, expenses: toILS(dayExp.get(d) || 0), cumulative: toILS(cum), prevCumulative: prevHasData ? toILS(pcum) : null });
    }
  }

  // Month by month inside the period (each month clipped to the period), and the usual 12 months
  // ending at the period's last month for the sparklines.
  const periodMonthly = monthsOf(p).map((m) => {
    const from = `${m}-01` > p.from ? `${m}-01` : p.from;
    const to = monthEnd(m) < p.to ? monthEnd(m) : p.to;
    const t = periodTotals(ds, { kind: 'range', from, to });
    return { month: m, income: toILS(t.income), expenses: toILS(t.expenses) };
  });
  const endMonth = monthOf(p.to);
  const monthly = [];
  for (let i = 11; i >= 0; i--) {
    const m = addMonths(endMonth, -i);
    const t = periodTotals(ds, { kind: 'range', from: `${m}-01`, to: monthEnd(m) });
    monthly.push({ month: m, income: toILS(t.income), expenses: toILS(t.expenses) });
  }

  const isCurrent = p.to === today;
  const upcoming = isCurrent
    ? computeUpcoming(ds, detectRecurring(ds)).map((u) => ({ description: u.description, amount: toILS(u.amount), expectedDate: u.expectedDate, kind: u.kind }))
    : [];

  return {
    mode: 'period',
    period: { kind: p.kind, from: p.from, to: p.to, ...(p.kind === 'months' ? { months: p.months } : {}) },
    previous: { kind: prev.kind, from: prev.from, to: prev.to, ...(prev.kind === 'months' ? { months: prev.months } : {}) },
    isCurrent, days, availableMonths, month: endMonth,
    totals: {
      income: toILS(cur.income), expenses: toILS(cur.expenses), net: toILS(cur.income - cur.expenses),
      prevIncome: prevHasData ? toILS(before.income) : null,
      prevExpenses: prevHasData ? toILS(before.expenses) : null,
      expensesChangePct,
    },
    balances: {
      bankTotal: withBal.length ? toILS(withBal.reduce((s, a) => s + a.balance, 0)) : null,
      upcomingCardCharges: toILS(upcomingCardChargesTotal(ds)),
      accounts,
    },
    byCategory, daily, periodMonthly, monthly, forecast: null, upcoming,
    topMerchants: topMerchantsIn(ds, p),
  };
}

/** Parse `months=YYYY-MM,YYYY-MM` (comma list). Returns undefined when absent, throws on junk. */
export function parseMonthsList(raw) {
  if (raw === undefined) return undefined;
  const list = String(raw).split(',').filter(Boolean);
  if (!list.length || list.length > MAX_MONTHS || !list.every(isValidMonth)) throw Object.assign(new Error('BAD_MONTHS'), { code: 'BAD_MONTHS' });
  return [...new Set(list)].sort();
}
