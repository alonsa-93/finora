// Annual review: the trailing 12 complete months against the 12 before them, trends per series and
// per category, the most / least expensive months, fixed commitments, instalments still to pay and
// how steady the income is - plus year-level conclusions in plain Hebrew (computeAnnualInsights).
// Pure (no DB). Internal amounts are agorot; annualOutput converts to ILS.
//
// Honesty rules (see stats.js for the numbers): a month counts only from the first full month of
// data on (a partial first month would fake a low month); a trend or a first-vs-last-quarter
// comparison needs 6 months with data; the previous year is reported only when all 12 of its months
// are covered (banks give ~12 months back, Yahav 6; history builds up locally over time).
import { CATEGORY_BY_ID } from './categories.js';
import { monthOf, addMonths, daysBetween, addMonthsToDate, hebMonth } from './dates.js';
import { toILS, fmtILS, fmtApprox, fmtPct } from './money.js';
import { monthTotals, detectRecurring, installmentSeries, isInstallment } from './analytics.js';
import {
  trend, compareFirstLast, coefficientOfVariation, robustOutliers, median, pctChange, MIN_TREND_MONTHS,
} from './stats.js';
import { computePriceTrends, windowMonths, lastCompleteMonth, monthEndDate } from './prices.js';
import { be } from './insights.js';

const A = (ils) => Math.round(ils * 100);
const catName = (id) => CATEGORY_BY_ID.get(id)?.name || id;
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

/** Thresholds for category growers / shrinkers (monthly averages, first vs last 3 months). */
export const CATEGORY_RULES = { minMonthlyDiff: A(100), minPct: 20, minYearTotal: A(1200) };
/** How many days without a new instalment row before a plan is treated as ended / unsynced. */
const INSTALMENT_STALE_DAYS = 62;

/**
 * @param ds dataset from analytics.buildDataset
 * @param end YYYY-MM, last month of the window (default: the last complete month)
 */
export function computeAnnual(ds, end) {
  const lastComplete = lastCompleteMonth(ds.today);
  end = end || lastComplete;
  const months = windowMonths(end);
  const prevMonths = windowMonths(addMonths(end, -12));
  const start = months[0];
  const covered = (m) => Boolean(ds.firstFullMonth) && m >= ds.firstFullMonth && m <= lastComplete;
  const cache = new Map();
  const mt = (m) => { if (!cache.has(m)) cache.set(m, monthTotals(ds, m)); return cache.get(m); };

  const point = (m) => {
    if (!covered(m)) return { month: m, covered: false, income: null, expenses: null, net: null, savingsRate: null, byCat: null };
    const t = mt(m);
    const net = t.income - t.expenses;
    return { month: m, covered: true, income: t.income, expenses: t.expenses, net, savingsRate: t.income > 0 ? (net / t.income) * 100 : null, byCat: t.byCat };
  };
  const series = months.map(point);
  const prevSeries = prevMonths.map(point);
  const cov = series.filter((s) => s.covered);
  const prevCov = prevSeries.filter((s) => s.covered);

  const yearTotals = (arr) => {
    const income = sum(arr, (s) => s.income);
    const expenses = sum(arr, (s) => s.expenses);
    const net = income - expenses;
    return {
      income, expenses, net, savingsRate: income > 0 ? (net / income) * 100 : null, months: arr.length,
      avgMonthlyIncome: arr.length ? income / arr.length : null, avgMonthlyExpenses: arr.length ? expenses / arr.length : null,
    };
  };
  const totals = cov.length ? yearTotals(cov) : null;
  const previous = prevCov.length === 12 && cov.length === 12 ? yearTotals(prevCov) : null;
  const change = previous ? {
    expensesPct: pctChange(totals.expenses, previous.expenses),
    incomePct: pctChange(totals.income, previous.income),
    netDiff: totals.net - previous.net,
    savingsRatePts: totals.savingsRate != null && previous.savingsRate != null ? Math.round((totals.savingsRate - previous.savingsRate) * 10) / 10 : null,
  } : null;

  let historyMonths = 0;
  // months of history up to the end of this window (what a "previous year" could be built from)
  const histEnd = end < lastComplete ? end : lastComplete;
  if (ds.firstFullMonth) for (let m = ds.firstFullMonth; m <= histEnd; m = addMonths(m, 1)) historyMonths++;

  const trends = {
    income: trend(series.map((s) => s.income)),
    expenses: trend(series.map((s) => s.expenses)),
    net: trend(series.map((s) => s.net)),
    savingsRate: trend(series.map((s) => s.savingsRate), { absolute: true, flatAbs: 3 }),
  };

  // ---- categories ------------------------------------------------------------------------------
  const catIds = new Set();
  for (const s of cov) for (const [cat, c] of s.byCat) if (c.amount > 0) catIds.add(cat);
  const categories = [];
  // Gradual-change claims (quarters, trend line) leave instalment plans out: a fridge in 6 payments
  // is a one-off purchase, not a habit that grew. Totals and shares keep everything.
  const habitByMonth = new Map();
  for (const s of cov) {
    const map = new Map();
    for (const r of ds.byMonth.get(s.month) || []) {
      if (r.contrib?.type !== 'expense' || isInstallment(r)) continue;
      map.set(r.contrib.category, (map.get(r.contrib.category) || 0) + r.contrib.value);
    }
    habitByMonth.set(s.month, map);
  }
  for (const cat of catIds) {
    const values = series.map((s) => (s.covered ? Math.max(0, s.byCat.get(cat)?.amount || 0) : null));
    const habit = series.map((s) => (s.covered ? Math.max(0, habitByMonth.get(s.month).get(cat) || 0) : null));
    const total = sum(values, (v) => v || 0);
    if (total <= 0) continue;
    const prevTotal = previous ? sum(prevSeries, (s) => Math.max(0, s.byCat.get(cat)?.amount || 0)) : null;
    categories.push({
      category: cat, total, values,
      count: sum(cov, (s) => s.byCat.get(cat)?.count || 0),
      share: totals.expenses > 0 ? (total / totals.expenses) * 100 : 0,
      avgMonthly: total / cov.length,
      quarters: compareFirstLast(habit),
      trend: trend(habit),
      prevTotal, yoyPct: prevTotal != null ? pctChange(total, prevTotal) : null,
    });
  }
  categories.sort((a, b) => b.total - a.total || (a.category < b.category ? -1 : 1));
  const R = CATEGORY_RULES;
  const growers = categories.filter((c) => c.quarters && c.trend && c.total >= R.minYearTotal
    && c.quarters.diff >= R.minMonthlyDiff && c.quarters.pct >= R.minPct && c.trend.direction === 'up')
    .sort((a, b) => b.quarters.diff - a.quarters.diff || (a.category < b.category ? -1 : 1));
  const shrinkers = categories.filter((c) => c.quarters && c.trend && c.total >= R.minYearTotal
    && -c.quarters.diff >= R.minMonthlyDiff && c.quarters.pct <= -R.minPct && c.trend.direction === 'down')
    .sort((a, b) => a.quarters.diff - b.quarters.diff || (a.category < b.category ? -1 : 1));

  // ---- most / least expensive months ---------------------------------------------------------------
  let extremes = null;
  if (cov.length >= MIN_TREND_MONTHS) {
    const avgCat = new Map(categories.map((c) => [c.category, c.avgMonthly]));
    const withDriver = (s, mode) => {
      let best = null;
      for (const c of categories) {
        const amount = Math.max(0, s.byCat.get(c.category)?.amount || 0);
        const gap = mode === 'most' ? amount - avgCat.get(c.category) : avgCat.get(c.category) - amount;
        if (gap > 0 && (!best || gap > best.gap)) best = { category: c.category, amount, avg: avgCat.get(c.category), gap };
      }
      return { month: s.month, expenses: s.expenses, income: s.income, driver: best };
    };
    const sorted = [...cov].sort((a, b) => b.expenses - a.expenses || (a.month < b.month ? -1 : 1));
    extremes = {
      median: median(cov.map((s) => s.expenses)),
      most: sorted.slice(0, 3).map((s) => withDriver(s, 'most')),
      least: sorted.slice(-3).reverse().map((s) => withDriver(s, 'least')),
    };
  }

  // ---- fixed commitments (recurring charges active today) -----------------------------------------
  const prices = computePriceTrends(ds, { end });
  const recurring = detectRecurring(ds);
  const rowById = new Map(ds.rows.map((r) => [r.id, r]));
  const recRows = recurring.flatMap((r) => r.ids.map((id) => rowById.get(id)).filter(Boolean));
  const fixedValues = series.map((s) => (s.covered ? sum(recRows.filter((r) => monthOf(r.date) === s.month), (r) => -r.amount) : null));
  const fixedCov = fixedValues.filter((v) => v != null);
  const recMoves = prices.increases.concat(prices.decreases).filter((x) => x.kind === 'recurring');
  const fixed = {
    count: recurring.length,
    monthlyNow: sum(recurring, (r) => (r.cadence === 'monthly' ? r.amount : r.amount / 2)),
    yearlyNow: sum(recurring, (r) => r.yearlyCost),
    avgMonthly: fixedCov.length ? sum(fixedCov, (v) => v) / fixedCov.length : null,
    values: fixedValues,
    quarters: compareFirstLast(fixedValues),
    priceChanges: {
      increasesYearly: prices.totals.recurringIncreasesYearly,
      decreasesYearly: prices.totals.recurringDecreasesYearly,
      netYearly: prices.totals.recurringNetYearly,
      items: recMoves,
    },
  };

  // ---- instalments still to pay ----------------------------------------------------------------
  const plans = [];
  for (const last of installmentSeries(ds)) {
    if (last.instNumber >= last.instTotal || last.date > ds.today) continue;
    if (daysBetween(last.date, ds.today) > INSTALMENT_STALE_DAYS) continue;
    const remaining = last.instTotal - last.instNumber;
    const ids = ds.rows.filter((r) => r.accountId === last.accountId && r.merchantKey === last.merchantKey
      && r.instTotal === last.instTotal && r.amount === last.amount).map((r) => r.id);
    plans.push({
      description: last.description, category: last.category, monthly: -last.amount, paid: last.instNumber, of: last.instTotal,
      remaining, remainingAmount: -last.amount * remaining,
      nextDate: addMonthsToDate(last.date, 1), lastDate: addMonthsToDate(last.date, remaining), ids,
      dates: Array.from({ length: remaining }, (_, k) => addMonthsToDate(last.date, k + 1)),
    });
  }
  plans.sort((a, b) => b.remainingAmount - a.remainingAmount || (a.description < b.description ? -1 : 1));
  const curMonth = monthOf(ds.today);
  const byMonth = [];
  for (let k = 0; k < 12; k++) {
    const m = addMonths(curMonth, k);
    const amount = sum(plans, (p) => p.dates.filter((d) => monthOf(d) === m && d > ds.today).length * p.monthly);
    if (amount > 0 || byMonth.length) byMonth.push({ month: m, amount });
  }
  while (byMonth.length && byMonth[byMonth.length - 1].amount === 0) byMonth.pop();
  const instalments = {
    count: plans.length, remainingAmount: sum(plans, (p) => p.remainingAmount), monthlyNow: sum(plans, (p) => p.monthly),
    lastDate: plans.reduce((d, p) => (p.lastDate > d ? p.lastDate : d), ''), plans, byMonth,
  };

  // ---- income stability ----------------------------------------------------------------------------
  let incomeStability = null;
  const incomes = series.map((s) => s.income);
  if (cov.length >= MIN_TREND_MONTHS && sum(cov, (s) => s.income) > 0) {
    const cv = coefficientOfVariation(incomes);
    const med = median(incomes);
    const idx = robustOutliers(incomes, { minAbs: A(1000), minRel: 0.15 });
    incomeStability = {
      cv, median: med,
      level: cv == null ? null : cv < 0.1 ? 'stable' : cv < 0.25 ? 'variable' : 'irregular',
      unusual: idx.map((i) => ({ month: series[i].month, income: series[i].income, diff: series[i].income - med })),
      firstMedian: cov.length >= 6 ? median(cov.slice(0, 3).map((s) => s.income)) : null,
      lastMedian: cov.length >= 6 ? median(cov.slice(-3).map((s) => s.income)) : null,
    };
  }

  // Ends the user can pick: complete months that leave at least one covered month in the window.
  const availableEnds = [];
  if (ds.firstFullMonth) for (let m = lastComplete; m >= ds.firstFullMonth && availableEnds.length < 48; m = addMonths(m, -1)) availableEnds.push(m);

  return {
    end, start, months, from: `${start}-01`, to: monthEndDate(end),
    coverage: { months: cov.length, firstDataMonth: ds.firstFullMonth, historyMonths, previousMonths: prevCov.length },
    totals, previous, change, series, trends, categories, growers, shrinkers, extremes, fixed, instalments, incomeStability,
    availableEnds, prices,
  };
}

// ---------------------------------------------------------------------------------------------
// API shape

const I = (v) => (v == null ? null : toILS(Math.round(v)));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const trendOut = (t, money = true) => (t ? {
  slopePerMonth: money ? I(t.slope) : r1(t.slope), start: money ? I(t.start) : r1(t.start), end: money ? I(t.end) : r1(t.end),
  changeOverPeriod: money ? I(t.change) : r1(t.change), pctOverPeriod: t.pct, direction: t.direction, label: t.label, r2: t.r2, months: t.n,
} : null);
const totalsOut = (t) => (t ? {
  income: I(t.income), expenses: I(t.expenses), net: I(t.net), savingsRate: r1(t.savingsRate), months: t.months,
  avgMonthlyIncome: I(t.avgMonthlyIncome), avgMonthlyExpenses: I(t.avgMonthlyExpenses),
} : null);
const quartersOut = (q) => (q ? { firstAvg: I(q.first), lastAvg: I(q.last), diff: I(q.diff), pct: q.pct } : null);

export function annualOutput(a) {
  const meta = (id) => CATEGORY_BY_ID.get(id) || CATEGORY_BY_ID.get('other');
  const catOut = (c) => ({
    category: c.category, name: meta(c.category).name, color: meta(c.category).color,
    total: I(c.total), share: r1(c.share), count: c.count, avgMonthly: I(c.avgMonthly),
    monthly: c.values.map(I), quarters: quartersOut(c.quarters), trend: trendOut(c.trend),
    prevTotal: I(c.prevTotal), yoyPct: c.yoyPct,
  });
  const extremeOut = (e) => ({
    month: e.month, expenses: I(e.expenses), income: I(e.income),
    driver: e.driver ? { category: e.driver.category, name: catName(e.driver.category), amount: I(e.driver.amount), avg: I(e.driver.avg) } : null,
  });
  return {
    end: a.end, start: a.start, months: a.months, from: a.from, to: a.to,
    coverage: a.coverage,
    totals: totalsOut(a.totals), previous: totalsOut(a.previous),
    change: a.change ? { expensesPct: a.change.expensesPct, incomePct: a.change.incomePct, netDiff: I(a.change.netDiff), savingsRatePts: a.change.savingsRatePts } : null,
    monthly: a.series.map((s) => ({ month: s.month, covered: s.covered, income: I(s.income), expenses: I(s.expenses), net: I(s.net), savingsRate: r1(s.savingsRate) })),
    trends: {
      income: trendOut(a.trends.income), expenses: trendOut(a.trends.expenses), net: trendOut(a.trends.net),
      savingsRate: trendOut(a.trends.savingsRate, false),
    },
    categories: a.categories.map(catOut),
    growers: a.growers.slice(0, 5).map((c) => c.category),
    shrinkers: a.shrinkers.slice(0, 5).map((c) => c.category),
    extremes: a.extremes ? { median: I(a.extremes.median), most: a.extremes.most.map(extremeOut), least: a.extremes.least.map(extremeOut) } : null,
    fixed: {
      count: a.fixed.count, monthlyNow: I(a.fixed.monthlyNow), yearlyNow: I(a.fixed.yearlyNow), avgMonthly: I(a.fixed.avgMonthly),
      monthly: a.fixed.values.map(I), quarters: quartersOut(a.fixed.quarters),
      priceChanges: {
        increasesYearly: I(a.fixed.priceChanges.increasesYearly), decreasesYearly: I(a.fixed.priceChanges.decreasesYearly),
        netYearly: I(a.fixed.priceChanges.netYearly),
        items: a.fixed.priceChanges.items.map((x) => ({ description: x.description, category: x.category, from: I(x.from), to: I(x.to), pct: x.pct, yearly: I(x.yearly), date: x.date, confirmed: x.confirmed })),
      },
    },
    instalments: {
      count: a.instalments.count, remainingAmount: I(a.instalments.remainingAmount), monthlyNow: I(a.instalments.monthlyNow),
      lastDate: a.instalments.lastDate || null,
      plans: a.instalments.plans.map((p) => ({
        description: p.description, category: p.category, monthly: I(p.monthly), paid: p.paid, of: p.of,
        remaining: p.remaining, remainingAmount: I(p.remainingAmount), nextDate: p.nextDate, lastDate: p.lastDate, filter: { ids: p.ids.slice(-500) },
      })),
      byMonth: a.instalments.byMonth.map((x) => ({ month: x.month, amount: I(x.amount) })),
    },
    incomeStability: a.incomeStability ? {
      cv: a.incomeStability.cv == null ? null : Math.round(a.incomeStability.cv * 1000) / 1000,
      level: a.incomeStability.level, median: I(a.incomeStability.median),
      unusual: a.incomeStability.unusual.map((u) => ({ month: u.month, income: I(u.income), diff: I(u.diff) })),
    } : null,
    availableEnds: a.availableEnds,
  };
}

// ---------------------------------------------------------------------------------------------
// Year-level conclusions (same shape as /api/insights)

/** Hebrew "from": "מהראל" / "מ-NETFLIX". */
const mi = (name) => (/^[֐-׿]/.test(String(name).trim()) ? `מ${name}` : `מ-${name}`);
const CAT_PHRASE = {
  insurance: 'בביטוח', communication: 'בתקשורת', subscriptions: 'במנויים', bills: 'בחשבונות הבית', housing: 'בדיור',
  kids: 'בחינוך', health: 'בבריאות', fees: 'בעמלות', transport: 'בתחבורה', car: 'ברכב',
};
const joinHe = (parts) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} ו${parts[parts.length - 1]}`);
const plusPct = (p) => `${p > 0 ? '+' : '−'}${fmtPct(p)}`;
const monthsHe = (n) => (n === 1 ? 'חודש אחד' : n === 2 ? 'חודשיים' : `${n} חודשים`);

function make(o) {
  return {
    id: o.id, type: o.type, severity: o.severity, title: o.title, body: o.body,
    amount: o.amount == null ? null : toILS(Math.round(o.amount)), category: o.category ?? null,
    action: { label: o.label || 'הצג תנועות', filter: o.filter },
  };
}
const idsFilter = (ids) => ({ ids: [...new Set(ids)].sort((x, y) => x - y).slice(-500) });

export const ANNUAL_INSIGHT_TYPES = [
  'yearCoverage', 'yearSpending', 'yearSavings', 'yearIncome', 'fixedCostsChange', 'merchantTicket',
  'categoryTrendUp', 'expensiveMonth', 'unusualIncome', 'merchantFrequency', 'categoryTrendDown', 'instalmentsAhead',
];
export const MAX_ANNUAL_INSIGHTS = 10;

/** What to do about each kind of annual conclusion (shown under it as "מה לעשות"). */
export const ANNUAL_TIPS = {
  yearSpending: 'לבחור את שתיים-שלוש הקטגוריות שעלו הכי הרבה ולקבוע להן תקרה חודשית.',
  yearSavings: 'לקבוע הוראת קבע לחיסכון מיד אחרי המשכורת, כדי שהחיסכון יקרה מעצמו. גם סכום קטן מצטבר.',
  yearIncome: 'אם השינוי בהכנסה קבוע, כדאי להתאים אליו את ההוצאות הקבועות.',
  fixedCostsChange: 'לעבור על החיובים הקבועים שהתייקרו: לבקש את המחיר הקודם, לעבור מסלול או לבטל.',
  merchantTicket: 'לבדוק אם אפשר לקבל את אותו דבר בזול יותר, אצל ספק אחר או בקנייה מרוכזת.',
  categoryTrendUp: 'לקבוע לקטגוריה תקרה חודשית ולעקוב אחריה בסקירה.',
  expensiveMonth: 'אם זו הוצאה שחוזרת כל שנה (חגים, ביטוח שנתי, חופשה), כדאי להפריש לה כל חודש מראש.',
  unusualIncome: 'הכנסה גבוהה מהרגיל: להעביר את התוספת לחיסכון לפני שהיא נבלעת. נמוכה מהרגיל: לבדוק שהתשלום הגיע במלואו.',
  merchantFrequency: 'הרבה קניות קטנות מצטברות לסכום שנתי גדול. כדאי לקבוע לעצמך מסגרת שבועית.',
  categoryTrendDown: 'כל הכבוד. כדאי להעביר את ההפרש לחיסכון לפני שהוא מתפזר.',
  instalmentsAhead: 'לפני עסקה חדשה בתשלומים, לבדוק כמה כבר מחויב בכל חודש קדימה.',
};

/** @param a result of computeAnnual */
export function computeAnnualInsights(a) {
  const out = [];
  const n = a.coverage.months;
  const range = { from: a.from, to: a.to };
  if (!a.totals) return out;
  const T = a.totals;

  // ---- not enough months yet: say so, with the little we know -----------------------------------
  if (n < MIN_TREND_MONTHS) {
    out.push(make({
      id: `year-coverage-${a.end}`, type: 'yearCoverage', severity: 'info',
      title: `יש עדיין נתונים רק על ${monthsHe(n)} מלאים`,
      body: `הסיכום השנתי והמגמות יופיעו כשיצטברו לפחות ${MIN_TREND_MONTHS} חודשים מלאים. בינתיים: הוצאות ${fmtILS(toILS(T.expenses))}, הכנסות ${fmtILS(toILS(T.income))}.`,
      amount: T.expenses, filter: { ...range, direction: 'out' },
    }));
  }

  // ---- 1. the year's spending, against the year before ---------------------------------------
  if (n >= MIN_TREND_MONTHS) {
    const E = fmtILS(toILS(T.expenses));
    const avg = fmtApprox(toILS(T.avgMonthlyExpenses));
    if (a.change && a.previous) {
      const p = a.change.expensesPct ?? 0;
      const ip = a.change.incomePct;
      const expPart = Math.abs(p) < 3 ? 'בערך כמו בשנה שלפניה' : `${fmtPct(p)} ${p < 0 ? 'פחות' : 'יותר'} מהשנה שלפניה`;
      let incPart = '';
      if (ip != null && Math.abs(ip) >= 3) {
        const contrast = Math.abs(p) < 3 || (p < 0) !== (ip < 0);
        incPart = `${contrast ? ', בזמן שההכנסות' : ', וגם ההכנסות'} ${ip > 0 ? 'עלו' : 'ירדו'} ב-${fmtPct(ip)}`;
      }
      let severity = 'info';
      if (p <= -3) severity = 'good';
      else if (p >= 10 && (ip == null || p > ip)) severity = 'warning';
      out.push(make({
        id: `year-spending-${a.end}`, type: 'yearSpending', severity,
        title: `בשנה האחרונה הוצאת ${E} — ${expPart}${incPart}`,
        body: `בשנה שלפניה: הוצאות ${fmtILS(toILS(a.previous.expenses))} והכנסות ${fmtILS(toILS(a.previous.income))}. `
          + `השנה: הכנסות ${fmtILS(toILS(T.income))}, ובממוצע ${avg} הוצאות בחודש.`,
        amount: T.expenses, filter: { ...range, direction: 'out' },
      }));
    } else {
      out.push(make({
        id: `year-spending-${a.end}`, type: 'yearSpending', severity: 'info',
        title: n === 12 ? `בשנה האחרונה הוצאת ${E} — כ-${avg} בחודש` : `במהלך ${n} החודשים האחרונים הוצאת ${E} — כ-${avg} בחודש`,
        body: `ההכנסות באותה תקופה: ${fmtILS(toILS(T.income))}. ההשוואה לשנה הקודמת תופיע כשיצטברו 24 חודשים של נתונים (יש כרגע ${monthsHe(a.coverage.historyMonths)}).`,
        amount: T.expenses, filter: { ...range, direction: 'out' },
      }));
    }

    // ---- 2. what was left -------------------------------------------------------------------------
    if (T.income >= A(1000) * n) {
      const rate = T.savingsRate;
      const prevRate = a.previous?.savingsRate;
      let severity = rate >= 15 ? 'good' : rate >= 0 ? 'info' : 'warning';
      if (a.change?.savingsRatePts != null && a.change.savingsRatePts <= -5 && severity === 'good') severity = 'info';
      const prevText = prevRate != null
        ? ` בשנה שלפניה: ${a.previous.net >= 0 ? `נשארו ${fmtILS(toILS(a.previous.net))}` : `חסרו ${fmtILS(toILS(-a.previous.net))}`} (${a.previous.net >= 0 ? '' : 'מינוס '}${fmtPct(prevRate)} מההכנסות).`
        : '';
      out.push(make({
        id: `year-savings-${a.end}`, type: 'yearSavings', severity,
        title: T.net >= 0
          ? `נשארו לך ${fmtILS(toILS(T.net))} — ${fmtPct(rate)} מההכנסות`
          : `הוצאת ${fmtILS(toILS(-T.net))} יותר ממה שהכנסת`,
        body: `הכנסות ${fmtILS(toILS(T.income))} פחות הוצאות ${fmtILS(toILS(T.expenses))}.${prevText}`
          + (rate >= 15 ? ' שיעור חיסכון בריא.' : rate >= 0 ? ' כדאי לכוון ל-10%-20% מההכנסה.' : ' כדאי לבדוק אילו קטגוריות אפשר לצמצם.'),
        amount: T.net, filter: range,
      }));
    }

    // ---- 3. income level, first vs last 3 months (medians: a one-off bonus does not move it) ------
    const st = a.incomeStability;
    if (st?.firstMedian > 0 && st.lastMedian != null) {
      const diff = st.lastMedian - st.firstMedian;
      const pct = (diff / st.firstMedian) * 100;
      if (Math.abs(diff) >= A(300) && Math.abs(pct) >= 3) {
        out.push(make({
          id: `year-income-${a.end}`, type: 'yearIncome', severity: diff > 0 ? 'good' : 'warning',
          title: `ההכנסה החודשית ${diff > 0 ? 'עלתה' : 'ירדה'} מכ-${fmtApprox(toILS(st.firstMedian))} לכ-${fmtApprox(toILS(st.lastMedian))}`,
          body: `${plusPct(pct)} בין שלושת החודשים הראשונים של התקופה לשלושת האחרונים (חציון, כך שמענק חד-פעמי לא משנה את התמונה). `
            + `בקצב הנוכחי זה כ-${fmtApprox(toILS(Math.abs(diff) * 12))} ${diff > 0 ? 'יותר' : 'פחות'} בשנה.`,
          amount: diff, category: 'salary', filter: { ...range, category: 'salary' },
        }));
      }
    }
  }

  // ---- 4. fixed charges that changed price -------------------------------------------------------
  const pc = a.fixed.priceChanges;
  const ups = pc.items.filter((x) => x.yearly > 0);
  const downs = pc.items.filter((x) => x.yearly < 0);
  const moveText = (x) => `${x.description} ${mi(fmtILS(toILS(x.from)))} ל-${fmtILS(toILS(x.to))} (${fmtILS(toILS(Math.abs(x.yearly)))} בשנה)`;
  if (pc.increasesYearly >= A(100)) {
    const cats = [...new Set(ups.map((x) => CAT_PHRASE[x.category]).filter(Boolean))].slice(0, 2);
    const downText = downs.length
      ? ` מנגד, ${downs[0].description} הוזל ${mi(fmtILS(toILS(downs[0].from)))} ל-${fmtILS(toILS(downs[0].to))}, חיסכון של ${fmtILS(toILS(-downs[0].yearly))} בשנה.` : '';
    out.push(make({
      id: `fixed-up-${a.end}`, type: 'fixedCostsChange', severity: pc.increasesYearly >= A(300) ? 'warning' : 'info',
      title: `החשבונות הקבועים התייקרו ב-${fmtILS(toILS(pc.increasesYearly))} בשנה${cats.length ? `, בעיקר ${joinHe(cats)}` : ''}`,
      body: `${ups.length === 1 ? 'ההתייקרות' : 'רוב ההתייקרות'}: ${ups.slice(0, 3).map(moveText).join('; ')}.${downText} כדאי לבדוק אם יש מסלול זול יותר.`,
      amount: pc.increasesYearly, filter: idsFilter(a.prices.increases.filter((x) => x.kind === 'recurring').flatMap((x) => x.ids)),
    }));
  } else if (pc.decreasesYearly >= A(100)) {
    out.push(make({
      id: `fixed-down-${a.end}`, type: 'fixedCostsChange', severity: 'good',
      title: `חיובים קבועים הוזלו: ${fmtILS(toILS(pc.decreasesYearly))} פחות בשנה`,
      body: `${downs.slice(0, 3).map(moveText).join('; ')}.`,
      amount: -pc.decreasesYearly, filter: idsFilter(a.prices.decreases.filter((x) => x.kind === 'recurring').flatMap((x) => x.ids)),
    }));
  }

  // ---- 5. average purchase at a frequent merchant (receipt totals only: never "prices rose") -----
  const merchants = a.prices.merchants;
  const ticketMoves = merchants.filter((m) => m.ticket && m.ticket.direction !== 'flat' && Math.abs(m.split.ticket) >= A(200))
    .sort((x, y) => Math.abs(y.split.ticket) - Math.abs(x.split.ticket) || (x.key < y.key ? -1 : 1));
  for (const m of ticketMoves.slice(0, 2)) {
    const t = m.ticket;
    const f = m.frequency;
    const up = t.direction === 'up';
    const visits = f.direction === 'flat' ? 'בלי שינוי במספר הביקורים'
      : f.direction === 'up' ? 'ובנוסף אתה קונה שם יותר פעמים' : 'למרות שאתה קונה שם פחות פעמים';
    out.push(make({
      id: `ticket-${m.key.replace(/\s+/g, '-')}-${a.end}`, type: 'merchantTicket', severity: up ? (m.split.ticket >= A(1000) ? 'warning' : 'info') : 'good',
      title: `הקנייה הממוצעת ${be(m.description)} ${up ? 'עלתה' : 'ירדה'} מ-${fmtILS(toILS(t.from))} ל-${fmtILS(toILS(t.to))} (${plusPct(t.pct)}) ${visits}`,
      body: `שלושת החודשים הראשונים של התקופה מול שלושת האחרונים: ${f.from.toFixed(1)} מול ${f.to.toFixed(1)} ביקורים בחודש. `
        + 'אנחנו רואים רק את סכום הקבלה ולא את מחירי המוצרים, כך שייתכן שגם הסל השתנה. '
        + `בקצב הנוכחי ההפרש בסכום הקנייה הוא כ-${fmtApprox(toILS(Math.abs(m.split.ticket)))} ${up ? 'יותר' : 'פחות'} בשנה.`,
      amount: m.split.ticket, category: m.category, filter: idsFilter(m.ids),
    }));
  }

  if (n >= MIN_TREND_MONTHS) {
    // ---- 6. categories climbing steadily ---------------------------------------------------------
    for (const c of a.growers.slice(0, 2)) {
      out.push(make({
        id: `cat-trend-up-${c.category}-${a.end}`, type: 'categoryTrendUp', severity: 'warning',
        title: `ההוצאה על ${catName(c.category)} עולה בהדרגה: מכ-${fmtApprox(toILS(c.quarters.first))} לכ-${fmtApprox(toILS(c.quarters.last))} בחודש`,
        body: `${plusPct(c.quarters.pct)} בשלושת החודשים האחרונים לעומת שלושת הראשונים של התקופה, וקו המגמה של כל החודשים מראה את אותו כיוון. סך הכול בתקופה: ${fmtILS(toILS(c.total))}.`,
        amount: c.quarters.diff, category: c.category, filter: { ...range, category: c.category },
      }));
    }

    // ---- 7. the most expensive month and what drove it --------------------------------------------
    const top = a.extremes?.most[0];
    if (top && top.expenses >= a.extremes.median * 1.2 && top.expenses - a.extremes.median >= A(1500)) {
      const d = top.driver;
      out.push(make({
        id: `expensive-month-${top.month}`, type: 'expensiveMonth', severity: 'info',
        title: `${hebMonth(top.month)} היה החודש היקר בתקופה: ${fmtILS(toILS(top.expenses))}`,
        body: `בחודש רגיל יוצא כ-${fmtApprox(toILS(a.extremes.median))}.`
          + (d ? ` רוב ההפרש ${CAT_PHRASE[d.category] || `בקטגוריית ${catName(d.category)}`}: ${fmtILS(toILS(d.amount))}, לעומת כ-${fmtApprox(toILS(d.avg))} בחודש ממוצע.` : ''),
        amount: top.expenses - a.extremes.median, filter: { month: top.month },
      }));
    }

    // ---- 8. months with unusual income -------------------------------------------------------------
    const unusual = a.incomeStability?.unusual || [];
    if (unusual.length === 1) {
      const u = unusual[0];
      const high = u.diff > 0;
      out.push(make({
        id: `unusual-income-${u.month}`, type: 'unusualIncome', severity: high ? 'info' : 'warning',
        title: `ב${hebMonth(u.month)} ההכנסה הייתה ${high ? 'גבוהה' : 'נמוכה'} מהרגיל: ${fmtILS(toILS(u.income))}`,
        body: `בחודש רגיל נכנסים כ-${fmtApprox(toILS(a.incomeStability.median))}. `
          + (high ? 'אם זה מענק, בונוס או החזר חד-פעמי, כדאי לא לבנות עליו בתקציב החודשי.' : 'כדאי לבדוק שלא חסרה משכורת או תשלום.'),
        amount: u.diff, category: 'salary', filter: { month: u.month, category: 'salary' },
      }));
    } else if (unusual.length > 1) {
      out.push(make({
        id: `unusual-income-${a.end}`, type: 'unusualIncome', severity: 'info',
        title: `בחודשים ${joinHe(unusual.map((u) => hebMonth(u.month)))} ההכנסה חרגה מהרגיל`,
        body: `${unusual.map((u) => `${hebMonth(u.month)}: ${fmtILS(toILS(u.income))}`).join(', ')}. בחודש רגיל נכנסים כ-${fmtApprox(toILS(a.incomeStability.median))}.`,
        amount: null, category: 'salary', filter: { ...range, category: 'salary' },
      }));
    }
  }

  // ---- 9. buying more often (same average purchase) -------------------------------------------------
  const freq = merchants.filter((m) => m.driver === 'frequency' && Math.abs(m.split.frequency) >= A(500))
    .sort((x, y) => Math.abs(y.split.frequency) - Math.abs(x.split.frequency) || (x.key < y.key ? -1 : 1))[0];
  if (freq) {
    const more = freq.frequency.direction === 'up';
    out.push(make({
      id: `freq-${freq.key.replace(/\s+/g, '-')}-${a.end}`, type: 'merchantFrequency', severity: more ? 'info' : 'good',
      title: `אתה קונה ${be(freq.description)} ${more ? 'יותר' : 'פחות'} פעמים: מ-${freq.frequency.from.toFixed(1)} ל-${freq.frequency.to.toFixed(1)} ביקורים בחודש`,
      body: `הקנייה הממוצעת כמעט לא השתנתה (${fmtILS(toILS(freq.ticket.from))} מול ${fmtILS(toILS(freq.ticket.to))}), אז השינוי בהוצאה שם בא ממספר הביקורים: כ-${fmtApprox(toILS(Math.abs(freq.split.frequency)))} ${more ? 'יותר' : 'פחות'} בשנה.`,
      amount: freq.split.frequency, category: freq.category, filter: idsFilter(freq.ids),
    }));
  }

  if (n >= MIN_TREND_MONTHS) {
    for (const c of a.shrinkers.slice(0, 1)) {
      out.push(make({
        id: `cat-trend-down-${c.category}-${a.end}`, type: 'categoryTrendDown', severity: 'good',
        title: `ההוצאה על ${catName(c.category)} יורדת: מכ-${fmtApprox(toILS(c.quarters.first))} לכ-${fmtApprox(toILS(c.quarters.last))} בחודש`,
        body: `${plusPct(c.quarters.pct)} בשלושת החודשים האחרונים לעומת שלושת הראשונים של התקופה, וקו המגמה של כל החודשים מראה את אותו כיוון. חיסכון של כ-${fmtApprox(toILS(-c.quarters.diff * 12))} בשנה בקצב הנוכחי.`,
        amount: -c.quarters.diff, category: c.category, filter: { ...range, category: c.category },
      }));
    }
  }

  // ---- 10. instalments still to pay ------------------------------------------------------------------
  const ins = a.instalments;
  if (ins.count && ins.remainingAmount >= A(500)) {
    const last = ins.lastDate ? `${hebMonth(monthOf(ins.lastDate))} ${ins.lastDate.slice(0, 4)}` : '';
    out.push(make({
      id: 'instalments-ahead', type: 'instalmentsAhead', severity: 'info',
      title: `נשארו עוד ${fmtILS(toILS(ins.remainingAmount))} לשלם בתשלומים`,
      body: `${ins.count === 1 ? 'עסקה אחת פתוחה' : `${ins.count} עסקאות פתוחות`}, כ-${fmtApprox(toILS(ins.monthlyNow))} בחודש. `
        + `${last ? `התשלום האחרון צפוי ב${last}. ` : ''}זה כבר מחויב, גם אם עוד לא ירד מהחשבון.`,
      amount: ins.remainingAmount, filter: idsFilter(ins.plans.flatMap((p) => p.ids)),
    }));
  }

  return out.slice(0, MAX_ANNUAL_INSIGHTS).map((i) => ({ ...i, tip: ANNUAL_TIPS[i.type] || null }));
}
