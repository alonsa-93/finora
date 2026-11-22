// "Where do I stand right now": the main dashboard's data (GET /api/position).
//
//  - bank: the current balance of the bank accounts and its trend. The daily balance is rebuilt
//    backwards from today's balance: the balance at the end of a day = today's balance minus every
//    completed bank movement dated after that day. Before the first known bank movement it is unknown.
//  - cards: what is charged on the cards and not yet paid from the bank (the next bill), per card, and
//    the bill of every month (by charge date, processed_date), with the normal (average) bill.
//  - flags: red flags first, then insights, each with a concrete recommendation (tip).
// Pure: takes a dataset from buildDataset. Amounts out are ILS.
import { monthOf, addMonths, addDays, daysInMonth, hebMonth } from './dates.js';
import { toILS, fmtILS, fmtApprox } from './money.js';
import { upcomingCardRows } from './analytics.js';
import { computeInsights } from './insights.js';

export const DEFAULT_MONTHS = 6;
const A = (ils) => Math.round(ils * 100);

/** The selected months, sorted; default: the last DEFAULT_MONTHS months up to the current one. */
export function positionMonths(months, today) {
  const cur = monthOf(today);
  const list = (months && months.length ? months : Array.from({ length: DEFAULT_MONTHS }, (_, i) => addMonths(cur, i - DEFAULT_MONTHS + 1)))
    .filter((m) => m <= cur);
  return [...new Set(list)].sort();
}

const billMonth = (r) => monthOf(r.processedDate || r.date);

function bankPart(ds, months) {
  const accounts = ds.accounts.filter((a) => a.type === 'bank' && a.companyId !== 'gsheet' && a.inLens !== false);
  const known = accounts.filter((a) => a.balance != null);
  const current = known.reduce((s, a) => s + a.balance, 0);
  const ids = new Set(known.map((a) => a.id));
  const rows = (ds.rawRows || ds.rows).filter((r) => ids.has(r.accountId) && r.status !== 'pending');
  const firstDate = rows.length ? rows[0].date : null;
  // Movement per day, and the running sum of everything after a day (from the newest backwards).
  const perDay = new Map();
  for (const r of rows) perDay.set(r.date, (perDay.get(r.date) || 0) + r.amount);
  const days = [...perDay.keys()].sort();
  const after = new Map(); // date -> sum of movements strictly after it
  let acc = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) { after.set(days[i], acc); acc += perDay.get(days[i]); }
  const afterDay = (d) => {
    // sum of movements dated after d: binary search over the sorted days
    let lo = 0; let hi = days.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (days[mid] <= d) lo = mid + 1; else hi = mid; }
    if (lo === days.length) return 0;
    return after.get(days[lo]) + perDay.get(days[lo]);
  };
  const balanceAt = (d) => (!known.length || !firstDate || d < addDays(firstDate, -1) ? null : current - afterDay(d));

  const today = ds.today;
  const monthOut = months.map((m) => {
    const start = `${m}-01`;
    const lastDay = `${m}-${String(daysInMonth(m)).padStart(2, '0')}`;
    const end = lastDay < today ? lastDay : today;
    const series = [];
    for (let d = start; d <= end; d = addDays(d, 1)) series.push({ date: d, balance: toILS(balanceAt(d)) });
    const vals = series.map((p) => p.balance).filter((v) => v != null);
    const mRows = rows.filter((r) => monthOf(r.date) === m);
    return {
      month: m, label: hebMonth(m), complete: lastDay < today,
      open: toILS(balanceAt(addDays(start, -1))), close: toILS(balanceAt(end)),
      low: vals.length ? Math.min(...vals) : null, high: vals.length ? Math.max(...vals) : null,
      in: toILS(mRows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)),
      out: toILS(-mRows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0)),
      series,
    };
  });
  const cur = monthOf(today);
  const monthStart = balanceAt(addDays(`${cur}-01`, -1));
  return {
    hasData: known.length > 0,
    current: known.length ? toILS(current) : null,
    asOf: known.map((a) => a.lastSyncAt).filter(Boolean).sort().pop() || null,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, balance: toILS(a.balance), lastSyncAt: a.lastSyncAt || null })),
    monthStart: toILS(monthStart),
    changeThisMonth: monthStart == null || !known.length ? null : toILS(current - monthStart),
    historyFrom: firstDate,
    months: monthOut,
    raw: { current, balanceAt },
  };
}

function cardPart(ds, months) {
  // In a business / private lens: the cards of that side, and any card with rows in the lens.
  const cards = ds.accounts.filter((a) => a.type === 'card' && (a.inLens !== false || ds.rows.some((r) => r.accountId === a.id)));
  const today = ds.today;
  const cur = monthOf(today);
  const upcoming = upcomingCardRows(ds);
  const byCard = cards.map((c) => {
    const own = upcoming.filter((r) => r.accountId === c.id);
    const next = own.map((r) => r.processedDate).filter((d) => d && d > today).sort()[0] || null;
    return { id: c.id, name: c.name, current: toILS(Math.max(0, own.reduce((s, r) => s - r.amount, 0))), nextChargeDate: next };
  });
  const current = Math.max(0, upcoming.reduce((s, r) => s - r.amount, 0));
  const nextDates = upcoming.map((r) => r.processedDate).filter((d) => d && d > today).sort();
  const nextChargeDate = nextDates[0] || null;
  const nextChargeAmount = nextChargeDate
    ? Math.max(0, upcoming.filter((r) => r.processedDate === nextChargeDate).reduce((s, r) => s - r.amount, 0)) : null;

  // The bill per month (charge-date month) per card: purchases minus refunds, never below zero.
  const rows = ds.rows.filter((r) => r.accountType === 'card' && !r.excluded);
  const billOf = (m) => {
    const per = new Map(cards.map((c) => [c.id, 0]));
    for (const r of rows) if (billMonth(r) === m) per.set(r.accountId, (per.get(r.accountId) || 0) - r.amount);
    const total = Math.max(0, [...per.values()].reduce((s, v) => s + v, 0));
    return { total, per };
  };
  // The normal bill: the average of the last 6 complete months that have card data.
  const firstCard = rows.length ? billMonth(rows.reduce((a, r) => (billMonth(r) < billMonth(a) ? r : a))) : null;
  const normalMonths = [];
  for (let i = 1; i <= 6; i += 1) {
    const m = addMonths(cur, -i);
    if (firstCard && m > firstCard) normalMonths.push(billOf(m).total);
  }
  const average = normalMonths.length ? Math.round(normalMonths.reduce((s, v) => s + v, 0) / normalMonths.length) : null;
  const monthOut = months.map((m) => {
    const b = billOf(m);
    return {
      month: m, label: hebMonth(m), complete: m < cur,
      total: toILS(b.total),
      byCard: cards.map((c) => ({ id: c.id, amount: toILS(Math.max(0, b.per.get(c.id) || 0)) })),
    };
  });
  // This month's bill so far (charged this month + still to be charged this month).
  const thisBill = billOf(cur).total;
  return {
    hasData: cards.length > 0,
    current: cards.length ? toILS(current) : null,
    nextChargeDate, nextChargeAmount: toILS(nextChargeAmount),
    cards: byCard,
    average: toILS(average), averageMonths: normalMonths.length,
    thisMonth: toILS(thisBill),
    months: monthOut,
    raw: { current, average, thisBill },
  };
}

// A concrete next step for every kind of insight.
export const TIPS = {
  lowBalance: 'להעביר כסף לחשבון או להזיז הוצאה גדולה עד אחרי מועד החיוב, כדי לא להיכנס למינוס ולריבית.',
  duplicateCharge: 'לבדוק את שני החיובים, ואם זו טעות - לפנות לבית העסק או לחברת האשראי ולבקש זיכוי.',
  priceIncrease: 'לבדוק אם ההתייקרות מוצדקת: לבקש את המחיר הקודם, לעבור מסלול או לבטל.',
  categorySpike: 'לעבור על התנועות בקטגוריה ולסמן מה חד-פעמי ומה הרגל שכדאי לצמצם.',
  unusualCharge: 'לוודא שאתה מכיר את החיוב. חיוב לא מוכר - לפנות מיד לחברת האשראי.',
  forecast: 'כדי לסיים את החודש קרוב לרגיל, כדאי להאט בהוצאות שאינן הכרחיות עד סוף החודש.',
  subscription: 'לעבור על המינויים ולבטל את מה שלא בשימוש. גם מינוי קטן מצטבר לסכום שנתי.',
  newMerchant: 'לוודא שכל בית עסק חדש מוכר לך.',
  feeCharge: 'לבדוק מול הבנק אם אפשר לוותר על העמלה או לעבור למסלול זול יותר.',
  categoryDrop: 'כל הכבוד - כדאי להעביר את החיסכון לחיסכון או להשקעה לפני שהוא מתפזר.',
  savingsRate: 'כדאי לקבוע הוראת קבע לחיסכון מיד אחרי המשכורת, כדי שהחיסכון יקרה מעצמו.',
  cardAboveNormal: 'לעבור על החיובים הגדולים של החודש בכרטיס ולבדוק מה אפשר לדחות או לפרוס.',
  bankDecline: 'ההוצאות גבוהות מההכנסות כבר כמה חודשים: כדאי לקבוע תקרה חודשית לקטגוריות הגדולות.',
};

const SEV_ORDER = { alert: 0, warning: 1, info: 2, good: 3 };

/** Red flags and insights for the dashboard, each with a tip; red flags (alert / warning) first. */
export function positionFlags(ds, bank, cards) {
  const month = monthOf(ds.today);
  const list = computeInsights(ds, month).map((i) => ({ ...i, tip: TIPS[i.type] || null }));

  // The card bill of this month is well above the normal one.
  const { thisBill, average } = cards.raw;
  if (average != null && cards.averageMonths >= 3 && thisBill > average * 1.2 && thisBill - average >= A(500)) {
    list.push({
      id: `card-above-${month}`, type: 'cardAboveNormal', severity: thisBill > average * 1.5 ? 'alert' : 'warning',
      title: 'חיוב האשראי החודש גבוה מהרגיל',
      body: `חיוב האשראי של ${hebMonth(month)} מגיע ל-${fmtILS(toILS(thisBill))}, לעומת ${fmtILS(toILS(average))} בחודש רגיל `
        + `(ממוצע ${cards.averageMonths} החודשים האחרונים) - כ-${fmtApprox(toILS(thisBill - average))} יותר.`,
      amount: toILS(thisBill - average), category: null,
      action: { label: 'חיובי האשראי של החודש', filter: { ids: ds.rows.filter((r) => r.accountType === 'card' && !r.excluded && billMonth(r) === month).map((r) => r.id).slice(0, 500) } },
      tip: TIPS.cardAboveNormal,
    });
  }

  // The bank balance went down three complete months in a row.
  const closes = [];
  for (let i = 3; i >= 0; i -= 1) {
    const end = addDays(`${addMonths(month, -i)}-01`, -1); // end of the month before
    closes.push(bank.raw.balanceAt ? bank.raw.balanceAt(end) : null);
  }
  if (closes.every((v) => v != null) && closes[1] < closes[0] && closes[2] < closes[1] && closes[3] < closes[2]
    && closes[0] - closes[3] >= A(1000)) {
    list.push({
      id: `bank-decline-${month}`, type: 'bankDecline', severity: 'warning',
      title: 'היתרה בבנק יורדת כבר שלושה חודשים ברצף',
      body: `בסוף ${hebMonth(addMonths(month, -4))} היו בבנק ${fmtILS(toILS(closes[0]))}, ובסוף ${hebMonth(addMonths(month, -1))} `
        + `${fmtILS(toILS(closes[3]))} - ירידה של כ-${fmtApprox(toILS(closes[0] - closes[3]))}.`,
      amount: toILS(closes[0] - closes[3]), category: null,
      action: { label: 'תנועות הבנק', filter: { ids: ds.rows.filter((r) => r.accountType === 'bank' && r.date >= `${addMonths(month, -3)}-01` && r.date < `${month}-01`).map((r) => r.id).slice(0, 500) } },
      tip: TIPS.bankDecline,
    });
  }
  list.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (b.amount ?? 0) - (a.amount ?? 0));
  return list;
}

/**
 * @param ds dataset (buildDataset)
 * @param {{months?: string[]}} opts the selected months (YYYY-MM); default the last 6
 */
export function computePosition(ds, { months } = {}) {
  const sel = positionMonths(months, ds.today);
  const bank = bankPart(ds, sel);
  const cards = cardPart(ds, sel);
  const flags = positionFlags(ds, bank, cards);
  const strip = ({ raw, ...rest }) => rest;
  const afterCards = bank.hasData && cards.hasData ? toILS(bank.raw.current - cards.raw.current) : null;
  return {
    today: ds.today, months: sel,
    bank: strip(bank), cards: strip(cards), afterCards,
    redFlags: flags.filter((f) => f.severity === 'alert' || f.severity === 'warning'),
    insights: flags.filter((f) => f.severity === 'info' || f.severity === 'good'),
  };
}
