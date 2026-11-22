// Insights engine: plain-language Hebrew conclusions. Each insight is deterministic, backed by
// real rows (action.filter) and only produced when there is enough history to be meaningful.
import { CATEGORY_BY_ID } from './categories.js';
import { monthOf, addMonths, daysBetween, hebMonth, shortDate } from './dates.js';
import { toILS, fmtILS, fmtApprox, fmtPct } from './money.js';
import {
  monthTotals, detectRecurring, computeForecast, upcomingCardRows, upcomingCardChargesTotal,
} from './analytics.js';

const SEVERITY_WEIGHT = { alert: 4000, warning: 3000, info: 2000, good: 1000 };
const TYPE_WEIGHT = {
  lowBalance: 90, duplicateCharge: 80, priceIncrease: 70, categorySpike: 60, unusualCharge: 50,
  forecast: 45, subscription: 40, newMerchant: 35, feeCharge: 30, categoryDrop: 15, savingsRate: 10,
};
export const MAX_INSIGHTS = 8;
const A = (ils) => Math.round(ils * 100); // ILS -> agorot for thresholds

const catName = (id) => CATEGORY_BY_ID.get(id)?.name || id;
const isHebrew = (s) => /^[֐-׿]/.test(String(s).trim());
/** Hebrew preposition "ב" attached correctly: "בשופרסל" / "ב-NETFLIX". */
export const be = (name) => (isHebrew(name) ? `ב${name}` : `ב-${name}`);
const isInstallment = (r) => r.instTotal != null && r.instTotal > 1;
const ids = (rows) => rows.map((r) => r.id);

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function make(o) {
  return {
    id: o.id, type: o.type, severity: o.severity, title: o.title, body: o.body,
    amount: o.amount == null ? null : toILS(o.amount),
    category: o.category ?? null,
    action: { label: o.label || 'הצג תנועות', filter: o.filter },
  };
}

/**
 * @param ds dataset from buildDataset
 * @param month YYYY-MM
 */
export function computeInsights(ds, month) {
  const curMonth = monthOf(ds.today);
  const isCurrent = month === curMonth;
  const when = isCurrent ? 'החודש' : `ב${hebMonth(month)}`;
  const list = [];
  if (!ds.rows.length) return [];
  const recurring = detectRecurring(ds);
  const recurringKeys = new Set(recurring.map((r) => r.merchantKey));
  const monthRows = ds.byMonth.get(month) || [];
  const enoughHistory = (n) => ds.firstFullMonth && addMonths(month, -n) >= ds.firstFullMonth;
  const usedIds = new Set();

  // ---- Category spike / drop vs the 3 previous months (run after unusualCharge, see below) --
  const spikeBlock = (unusualIds) => {
    if (!enoughHistory(3)) return;
    // Behavioural change only: fixed recurring charges (rent, bi-monthly bills, subscriptions)
    // follow billing cycles, not habits - price changes there are covered by priceIncrease.
    // Rows already reported as an unusual single charge are left out, so one big charge does
    // not produce two insights.
    const catTotals = (m) => {
      const map = new Map();
      for (const r of ds.byMonth.get(m) || []) {
        if (r.contrib?.type !== 'expense' || recurringKeys.has(r.merchantKey) || unusualIds.has(r.id)) continue;
        map.set(r.contrib.category, (map.get(r.contrib.category) || 0) + r.contrib.value);
      }
      return map;
    };
    const cur = catTotals(month);
    const base = [1, 2, 3].map((i) => catTotals(addMonths(month, -i)));
    const cats = new Set([...cur.keys(), ...base.flatMap((b) => [...b.keys()])]);
    const spikes = [];
    const drops = [];
    for (const cat of cats) {
      if (cat === 'card-payment') continue;
      const amount = Math.max(0, cur.get(cat) || 0);
      // Median of the 3 previous months: one atypical month (holiday, big purchase) does not
      // distort the baseline.
      const avg = Math.round(median(base.map((b) => Math.max(0, b.get(cat) || 0))));
      if (avg <= 0) continue;
      const gap = amount - avg;
      if (gap >= A(250) && amount >= avg * 1.3 && (avg >= A(150) || amount >= A(500))) {
        spikes.push({ cat, amount, avg, gap });
      } else if (!isCurrent && cat !== 'travel' && base.every((b) => (b.get(cat) || 0) > 0)
        && avg >= A(400) && -gap >= A(300) && amount <= avg * 0.7) {
        // Drops only for categories with steady spending in each of the baseline months.
        drops.push({ cat, amount, avg, gap: -gap });
      }
    }
    spikes.sort((a, b) => b.gap - a.gap || (a.cat < b.cat ? -1 : 1));
    for (const s of spikes.slice(0, 2)) {
      const pct = ((s.amount - s.avg) / s.avg) * 100;
      const ratio = s.amount / s.avg;
      const howMuch = ratio >= 2 ? `פי ${Math.round(ratio * 10) / 10}` : `ב-${fmtPct(pct)}`;
      list.push(make({
        id: `cat-spike-${s.cat}`, type: 'categorySpike',
        severity: s.amount >= s.avg * 2 && s.gap >= A(1000) ? 'alert' : 'warning',
        title: `ההוצאה על ${catName(s.cat)} גבוהה ${howMuch} מהרגיל`,
        body: `הוצאת ${fmtILS(toILS(s.amount))} ${when}, בעוד שבחודש רגיל יוצא לך כ-${fmtApprox(toILS(s.avg))}`
          + ' (לפי שלושת החודשים הקודמים, בלי חיובים קבועים)'
          + `${isCurrent ? ' - וזה עוד לפני סוף החודש.' : '.'}`,
        amount: s.gap, category: s.cat, filter: { category: s.cat, month },
      }));
    }
    drops.sort((a, b) => b.gap - a.gap || (a.cat < b.cat ? -1 : 1));
    for (const d of drops.slice(0, 1)) {
      const pct = (d.gap / d.avg) * 100;
      list.push(make({
        id: `cat-drop-${d.cat}`, type: 'categoryDrop', severity: 'good',
        title: `ההוצאה על ${catName(d.cat)} ירדה ב-${fmtPct(pct)}`,
        body: `הוצאת ${fmtILS(toILS(d.amount))} ${when}, בעוד שבחודש רגיל יוצא לך כ-${fmtApprox(toILS(d.avg))}. חסכת כ-${fmtApprox(toILS(d.gap))}.`,
        amount: d.gap, category: d.cat, filter: { category: d.cat, month },
      }));
    }
  };

  // ---- Price increase of a recurring charge -------------------------------------------------
  for (const r of recurring) {
    const pc = r.priceChange;
    if (!pc || pc.to <= pc.from) continue;
    const relevant = isCurrent ? daysBetween(pc.date, ds.today) <= 45 : monthOf(pc.date) === month;
    if (!relevant) continue;
    const diff = pc.to - pc.from;
    const perYear = diff * (r.cadence === 'monthly' ? 12 : 6);
    list.push(make({
      id: `price-${r.merchantKey.replace(/\s+/g, '-')}`, type: 'priceIncrease', severity: 'warning',
      title: `המחיר של ${r.description} עלה מ-${fmtILS(toILS(pc.from))} ל-${fmtILS(toILS(pc.to))}`,
      body: `החיוב הקבוע עלה ב-${fmtILS(toILS(diff))} (${fmtPct((diff / pc.from) * 100)}) מ-${shortDate(pc.date)}. `
        + `זה ${fmtILS(toILS(perYear))} יותר בשנה - כדאי לבדוק אם יש מסלול זול יותר.`,
      amount: diff, category: r.category, filter: { ids: pc.ids },
    }));
  }

  // ---- Likely duplicate charges -------------------------------------------------------------
  const DUP_SKIP = new Set(['fuel', 'transport', 'car', 'cash', 'transfers', 'card-payment', 'fees', 'salary', 'housing']);
  const dupCandidates = monthRows.filter((r) => r.contrib?.type === 'expense' && r.amount <= -A(50)
    && !isInstallment(r) && !recurringKeys.has(r.merchantKey) && !DUP_SKIP.has(r.category));
  const dups = [];
  for (let i = 0; i < dupCandidates.length; i++) {
    for (let j = i + 1; j < dupCandidates.length; j++) {
      const a = dupCandidates[i];
      const b = dupCandidates[j];
      if (a.merchantKey !== b.merchantKey || a.amount !== b.amount || a.status !== b.status) continue;
      if (Math.abs(daysBetween(a.date, b.date)) > 2) continue;
      if (a.identifier && b.identifier && a.identifier === b.identifier) continue;
      if (usedIds.has(a.id) || usedIds.has(b.id)) continue;
      usedIds.add(a.id); usedIds.add(b.id);
      dups.push([a, b]);
    }
  }
  for (const [a, b] of dups.slice(0, 2)) {
    const same = a.date === b.date;
    list.push(make({
      id: `dup-${a.id}-${b.id}`, type: 'duplicateCharge', severity: 'warning',
      title: `ייתכן שחויבת פעמיים ${be(a.description)}`,
      body: `שתי עסקאות זהות של ${fmtILS(toILS(-a.amount))} ${same ? `באותו יום (${shortDate(a.date)})` : `ב-${shortDate(a.date)} וב-${shortDate(b.date)}`}. `
        + 'אם זו לא קנייה כפולה מכוונת, כדאי לבדוק מול בית העסק או חברת האשראי.',
      amount: -a.amount, category: a.category, filter: { ids: [a.id, b.id] },
    }));
  }

  // ---- Unusually large single charge ----------------------------------------------------------
  const UNUSUAL_SKIP = new Set(['housing', 'card-payment', 'transfers', 'cash', 'salary']);
  const monthStart = `${month}-01`;
  const prior = ds.rows.filter((r) => r.date < monthStart && r.contrib?.type === 'expense' && r.amount < 0 && !isInstallment(r));
  const priorByMerchant = new Map();
  const priorByCat = new Map();
  const sixBack = `${addMonths(month, -6)}-01`;
  for (const r of prior) {
    if (!priorByMerchant.has(r.merchantKey)) priorByMerchant.set(r.merchantKey, []);
    priorByMerchant.get(r.merchantKey).push(-r.amount);
    if (r.date >= sixBack) {
      if (!priorByCat.has(r.category)) priorByCat.set(r.category, []);
      priorByCat.get(r.category).push(-r.amount);
    }
  }
  const unusual = [];
  if (enoughHistory(2)) {
    for (const r of monthRows) {
      if (r.contrib?.type !== 'expense' || r.amount > -A(300) || isInstallment(r) || UNUSUAL_SKIP.has(r.category)) continue;
      if (usedIds.has(r.id)) continue;
      const amt = -r.amount;
      const hist = priorByMerchant.get(r.merchantKey) || [];
      if (hist.length >= 3) {
        const med = median(hist);
        if (amt >= med * 2.5 && amt - med >= A(200)) unusual.push({ r, amt, med, basis: 'merchant' });
      } else if (hist.length >= 1) {
        const catHist = priorByCat.get(r.category) || [];
        if (catHist.length >= 10) {
          const med = median(catHist);
          if (amt >= A(800) && amt >= med * 4) unusual.push({ r, amt, med, basis: 'category' });
        }
      }
    }
  }
  unusual.sort((a, b) => b.amt - a.amt || a.r.id - b.r.id);
  for (const u of unusual.slice(0, 2)) {
    usedIds.add(u.r.id);
    const body = u.basis === 'merchant'
      ? `חויבת ${fmtILS(toILS(u.amt))} ${be(u.r.description)} ב-${shortDate(u.r.date)}, כשבדרך כלל יוצא לך שם כ-${fmtApprox(toILS(u.med))}.`
      : `חויבת ${fmtILS(toILS(u.amt))} ${be(u.r.description)} ב-${shortDate(u.r.date)} - הרבה מעל עסקה רגילה בקטגוריית ${catName(u.r.category)} (בדרך כלל כ-${fmtApprox(toILS(u.med))}).`;
    list.push(make({
      id: `unusual-${u.r.id}`, type: 'unusualCharge', severity: u.amt >= A(1000) ? 'warning' : 'info',
      title: `חיוב גבוה מהרגיל ${be(u.r.description)}`,
      body: `${body} אם אינך מזהה אותו, כדאי לבדוק.`,
      amount: u.amt, category: u.r.category, filter: { ids: [u.r.id] },
    }));
  }

  spikeBlock(new Set(unusual.slice(0, 2).map((u) => u.r.id)));

  // ---- New merchants with notable spend -----------------------------------------------------
  if (enoughHistory(3)) {
    const NEW_SKIP = new Set(['housing', 'transfers', 'card-payment', 'cash', 'salary', 'fees']);
    const firstSeen = new Map();
    for (const r of ds.rows) if (!firstSeen.has(r.merchantKey)) firstSeen.set(r.merchantKey, r.date);
    const groups = new Map();
    for (const r of monthRows) {
      if (r.contrib?.type !== 'expense' || NEW_SKIP.has(r.category)) continue;
      if (monthOf(firstSeen.get(r.merchantKey)) !== month) continue;
      const g = groups.get(r.merchantKey) || { desc: r.description, amount: 0, rows: [] };
      g.amount += r.contrib.value;
      g.rows.push(r);
      groups.set(r.merchantKey, g);
    }
    const notable = [...groups.values()].filter((g) => g.amount >= A(250))
      .sort((a, b) => b.amount - a.amount || (a.desc < b.desc ? -1 : 1));
    if (notable.length === 1) {
      const g = notable[0];
      list.push(make({
        id: `new-merchant-${month}`, type: 'newMerchant', severity: 'info',
        title: `בית עסק חדש: ${g.desc}`,
        body: `הוצאת ${fmtILS(toILS(g.amount))} ${be(g.desc)} ${when}. לא ראינו חיובים ממנו קודם לכן.`,
        amount: g.amount, category: g.rows[0].category, filter: { ids: ids(g.rows) },
      }));
    } else if (notable.length > 1) {
      const total = notable.reduce((s, g) => s + g.amount, 0);
      const top = notable.slice(0, 3).map((g) => `${g.desc} (${fmtILS(toILS(g.amount))})`).join(', ');
      list.push(make({
        id: `new-merchant-${month}`, type: 'newMerchant', severity: 'info',
        title: `נוספו ${notable.length} בתי עסק חדשים ${when}`,
        body: `הוצאת ${fmtILS(toILS(total))} בבתי עסק שלא הופיעו קודם: ${top}.`,
        amount: total, filter: { ids: notable.flatMap((g) => ids(g.rows)) },
      }));
    }
  }

  // ---- Bank fees and interest ---------------------------------------------------------------
  const fees = Math.max(0, monthTotals(ds, month).byCat.get('fees')?.amount || 0);
  if (fees >= A(5)) {
    let yearFees = 0;
    for (let i = 0; i < 12; i++) yearFees += Math.max(0, monthTotals(ds, addMonths(month, -i)).byCat.get('fees')?.amount || 0);
    const yearText = enoughHistory(5) ? `ב-12 החודשים האחרונים שילמת בסך הכול ${fmtILS(toILS(yearFees))}. ` : '';
    list.push(make({
      id: `fees-${month}`, type: 'feeCharge', severity: fees >= A(100) ? 'warning' : 'info',
      title: `שילמת ${fmtILS(toILS(fees))} עמלות וריבית ${when}`,
      body: `${yearText}אפשר לבקש מהבנק מסלול עמלות זול יותר או לעבור לפעולות בערוץ הדיגיטלי.`,
      amount: fees, category: 'fees', filter: { category: 'fees', month },
    }));
  }

  // ---- Current-month only: forecast, low balance, subscriptions ------------------------------
  if (isCurrent) {
    const f = computeForecast(ds, recurring);
    if (f && enoughHistory(1)) {
      let severity = 'info';
      let cmp = '';
      if (f.avg3m && enoughHistory(2)) {
        const diffPct = ((f.projected - f.avg3m) / f.avg3m) * 100;
        if (f.projected > f.avg3m * 1.1 && f.projected - f.avg3m >= A(500)) severity = 'warning';
        else if (f.projected < f.avg3m * 0.9) severity = 'good';
        cmp = Math.abs(diffPct) < 3
          ? ` זה בערך כמו הממוצע שלך (${fmtILS(toILS(f.avg3m))}).`
          : ` זה ${fmtPct(diffPct)} ${diffPct > 0 ? 'יותר' : 'פחות'} מהממוצע של שלושת החודשים הקודמים (${fmtILS(toILS(f.avg3m))}).`;
      }
      list.push(make({
        id: `forecast-${month}`, type: 'forecast', severity,
        title: `צפי להוצאות החודש: כ-${fmtApprox(toILS(f.projected))}`,
        body: `לפי הקצב עד עכשיו והחיובים הקבועים שעוד צפויים, החודש צפוי להסתיים בין ${fmtILS(toILS(f.low))} ל-${fmtILS(toILS(f.high))}.${cmp}`,
        amount: f.projected, filter: { month },
      }));
    }

    const bankAccounts = ds.accounts.filter((a) => a.type === 'bank' && a.balance != null);
    if (bankAccounts.length && ds.hasCards) {
      const bank = bankAccounts.reduce((s, a) => s + a.balance, 0);
      const upcoming = upcomingCardChargesTotal(ds);
      if (upcoming > bank && upcoming > 0) {
        // All rows behind the figure, refunds included, so the drill-down adds up to the stated total.
        const rows = upcomingCardRows(ds);
        list.push(make({
          id: 'low-balance', type: 'lowBalance', severity: 'alert',
          title: 'חיובי האשראי הקרובים גבוהים מהיתרה בבנק',
          body: `בחשבון הבנק יש ${bank < 0 ? 'מינוס של ' : ''}${fmtILS(toILS(bank))}, וחיובי האשראי שעוד לא ירדו מסתכמים ב-${fmtILS(toILS(upcoming))}. `
            + `חסרים כ-${fmtApprox(toILS(upcoming - bank))} - כדאי לדאוג לכיסוי לפני מועד החיוב.`,
          amount: upcoming - bank, filter: { ids: ids(rows).slice(0, 500) },
        }));
      }
    }

    const SUBS_SKIP = new Set(['housing', 'bills', 'fees']);
    const subs = recurring.filter((r) => !SUBS_SKIP.has(r.category));
    if (subs.length >= 2) {
      const yearly = subs.reduce((s, r) => s + r.yearlyCost, 0);
      const monthly = subs.reduce((s, r) => s + (r.cadence === 'monthly' ? r.amount : r.amount / 2), 0);
      const top = subs.slice(0, 3).map((r) => `${r.description} (${fmtILS(toILS(r.yearlyCost))} בשנה)`).join(', ');
      list.push(make({
        id: 'subscriptions', type: 'subscription', severity: 'info',
        title: `המנויים והחיובים הקבועים (${subs.length}) עולים לך ${fmtILS(toILS(yearly))} בשנה`,
        body: `כ-${fmtApprox(toILS(monthly))} בחודש. הגדולים: ${top}. כדאי לעבור על הרשימה ולבטל את מה שלא בשימוש.`,
        amount: yearly, category: 'subscriptions', filter: { ids: subs.map((r) => r.lastId) },
      }));
    }
  }

  // ---- Savings rate (last complete month) ---------------------------------------------------
  const sMonth = isCurrent ? addMonths(month, -1) : month;
  if (ds.firstFullMonth && sMonth >= ds.firstFullMonth) {
    const t = monthTotals(ds, sMonth);
    if (t.income >= A(1000)) {
      const net = t.income - t.expenses;
      const rate = (net / t.income) * 100;
      const severity = rate >= 15 ? 'good' : rate >= 0 ? 'info' : 'warning';
      const title = net >= 0
        ? `ב${hebMonth(sMonth)} נשארו לך ${fmtILS(toILS(net))} - ${fmtPct(rate)} מההכנסה`
        : `ב${hebMonth(sMonth)} הוצאת ${fmtILS(toILS(-net))} יותר ממה שהכנסת`;
      list.push(make({
        id: `savings-${sMonth}`, type: 'savingsRate', severity,
        title,
        body: `הכנסות ${fmtILS(toILS(t.income))}, הוצאות ${fmtILS(toILS(t.expenses))}.`
          + (rate >= 15 ? ' יפה מאוד - שיעור חיסכון בריא.' : rate >= 0 ? ' כדאי לכוון ל-10%-20% חיסכון מההכנסה.' : ' כדאי לבדוק אילו קטגוריות אפשר לצמצם.'),
        amount: net, filter: { month: sMonth },
      }));
    }
  }

  const score = (i) => SEVERITY_WEIGHT[i.severity] + (TYPE_WEIGHT[i.type] || 0);
  list.sort((a, b) => score(b) - score(a) || (b.amount ?? 0) - (a.amount ?? 0) || (a.id < b.id ? -1 : 1));
  return list.slice(0, MAX_INSIGHTS);
}
