// Price trends: what got more (or less) expensive over the last year.
//  (a) recurring charges: full charge history, price levels and change points (stats.priceLevels);
//  (b) frequent merchants: average purchase ("ticket") and visit count, first vs last quarter, with
//      the change in spending split into "more visits" and "bigger purchases";
//  (c) ranked increases / decreases in ILS per year.
// We only see receipt totals, never item prices: for merchants we speak of the average purchase,
// never of "prices". Pure (no DB); internal amounts in agorot, converted at the end.
import { monthOf, addMonths, daysInMonth } from './dates.js';
import { toILS } from './money.js';
import { detectRecurring, isInstallment, latestPriceChange } from './analytics.js';
import {
  compareFirstLast, robustMean, median, pctChange, decomposeSpend, mannWhitneyZ, countChangeZ,
} from './stats.js';

/** Merchant rules of evidence. */
export const MERCHANT_RULES = {
  minVisits: 10,          // visits in the 12 months
  minMonths: 6,           // spread over at least this many different months
  minQuarterVisits: 5,    // per quarter, before a ticket change is claimed
  ticketPct: 10,          // average ticket change, %
  ticketAbs: 1500,        // ... and at least 15 ILS (agorot)
  medianAgree: 0.05,      // the median ticket must move the same way by 5%
  ticketZ: 1.96,          // ... and the receipts must differ by rank (Mann-Whitney, p < 0.05)
  freqPct: 25,            // visit count change, %
  freqAbs: 3,             // ... and at least 3 visits a quarter (one a month)
  freqZ: 1.96,            // ... and beyond chance (Poisson, p < 0.05)
};
const MERCHANT_SKIP = new Set(['card-payment', 'transfers', 'cash', 'housing', 'fees', 'salary']);

/** The last complete month before today: the default end of every annual window. */
export const lastCompleteMonth = (today) => addMonths(monthOf(today), -1);

/** 12 months ascending, ending at `end`. */
export function windowMonths(end) {
  const out = [];
  for (let i = 11; i >= 0; i--) out.push(addMonths(end, -i));
  return out;
}
export const monthEndDate = (m) => `${m}-${String(daysInMonth(m)).padStart(2, '0')}`;

/**
 * @param ds dataset (analytics.buildDataset)
 * @param {{end?: string}} opts end = last month of the merchant window (default: last complete month)
 * @returns internal shape in agorot (see priceTrendsOutput)
 */
export function computePriceTrends(ds, { end } = {}) {
  const latest = lastCompleteMonth(ds.today);
  const months = windowMonths(end || latest);
  const from = `${months[0]}-01`;
  // Price changes: the latest window runs up to today (a change last week counts); an older window
  // stops at its own last day.
  const to = months[11] >= latest ? ds.today : monthEndDate(months[11]);

  // ---- (a) recurring charges -------------------------------------------------------------------
  const recurring = detectRecurring(ds);
  const recurringKeys = new Set(recurring.map((r) => r.merchantKey));
  const charges = recurring.map((r) => {
    // Change points come from detectRecurring (analytics.chargeChanges): the same definition the
    // recurring list uses, so both screens always agree.
    const hist = r.history;
    const changes = r.changes.map((c) => ({ ...c, inWindow: c.date >= from && c.date <= to }));
    const latest = latestPriceChange(r, { from, to });
    // A bill that moves every time gets no change points; its level is compared first vs last 3 charges.
    let levelChange = null;
    if (r.variable) {
      const cmp = compareFirstLast(hist.map((h) => h.amount), { minN: 6 });
      if (cmp && cmp.pct != null && Math.abs(cmp.pct) >= 10) levelChange = { from: cmp.first, to: cmp.last, pct: cmp.pct };
    }
    return {
      key: r.merchantKey, description: r.description, category: r.category, cadence: r.cadence,
      amount: r.amount, yearlyCost: r.yearlyCost, variable: r.variable, levelChange, latest,
      history: hist.map((h) => ({ date: h.date, amount: h.amount })), changes, ids: hist.flatMap((h) => h.ids),
    };
  });
  charges.sort((a, b) => b.yearlyCost - a.yearlyCost || (a.key < b.key ? -1 : 1));

  // ---- (b) frequent merchants --------------------------------------------------------------------
  const monthSet = new Set(months);
  const groups = new Map();
  for (const r of ds.rows) {
    if (!monthSet.has(monthOf(r.date))) continue;
    if (r.contrib?.type !== 'expense' || r.amount >= 0 || isInstallment(r) || r.isCardPayment) continue;
    if (MERCHANT_SKIP.has(r.category) || recurringKeys.has(r.merchantKey) || !r.merchantKey) continue;
    if (!groups.has(r.merchantKey)) groups.set(r.merchantKey, []);
    groups.get(r.merchantKey).push(r);
  }
  const R = MERCHANT_RULES;
  // Compare the first and last three months that HAVE data (a partial first month does not count):
  // with partial history the window's first months are empty and must not be named or used.
  const firstData = ds.firstFullMonth || (ds.firstDate ? monthOf(ds.firstDate) : null);
  const dataMonths = firstData ? months.filter((m) => m >= firstData && `${m}-01` <= ds.today) : [];
  const comparable = dataMonths.length >= 6;
  const q1List = comparable ? dataMonths.slice(0, 3) : [];
  const q4List = comparable ? dataMonths.slice(-3) : [];
  const q1Months = new Set(q1List);
  const q4Months = new Set(q4List);
  const merchants = [];
  for (const [key, rows] of groups) {
    const active = new Set(rows.map((r) => monthOf(r.date)));
    if (rows.length < R.minVisits || active.size < R.minMonths) continue;
    const names = new Map();
    for (const r of rows) names.set(r.description, (names.get(r.description) || 0) + 1);
    const description = [...names.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    const q1 = rows.filter((r) => q1Months.has(monthOf(r.date))).map((r) => -r.amount);
    const q4 = rows.filter((r) => q4Months.has(monthOf(r.date))).map((r) => -r.amount);
    const enough = q1.length >= R.minQuarterVisits && q4.length >= R.minQuarterVisits;
    let ticket = null; let frequency = null; let split = null; let driver = 'none';
    if (enough) {
      const t1 = robustMean(q1); const t4 = robustMean(q4);
      const m1 = median(q1); const m4 = median(q4);
      const pct = pctChange(t4, t1);
      const z = mannWhitneyZ(q1, q4);
      let dir = 'flat';
      if (pct >= R.ticketPct && t4 - t1 >= R.ticketAbs && m4 >= m1 * (1 + R.medianAgree) && z >= R.ticketZ) dir = 'up';
      else if (pct <= -R.ticketPct && t1 - t4 >= R.ticketAbs && m4 <= m1 * (1 - R.medianAgree) && z <= -R.ticketZ) dir = 'down';
      ticket = { from: t1, to: t4, medianFrom: m1, medianTo: m4, pct, direction: dir, z: Math.round(z * 100) / 100 };
      const v1 = q1.length; const v4 = q4.length;
      const fpct = pctChange(v4, v1);
      const fz = countChangeZ(v1, v4);
      let fdir = 'flat';
      if (fpct >= R.freqPct && v4 - v1 >= R.freqAbs && fz >= R.freqZ) fdir = 'up';
      else if (fpct <= -R.freqPct && v1 - v4 >= R.freqAbs && fz <= -R.freqZ) fdir = 'down';
      frequency = { from: v1 / 3, to: v4 / 3, pct: fpct, direction: fdir }; // visits per month
      const d = decomposeSpend({ v1, t1, v2: v4, t2: t4 }); // per quarter
      split = { total: d.total * 4, frequency: d.frequency * 4, ticket: d.ticket * 4 }; // per year
      driver = dir !== 'flat' && fdir !== 'flat' ? 'both' : dir !== 'flat' ? 'ticket' : fdir !== 'flat' ? 'frequency' : 'none';
    }
    const monthly = months.map((m) => {
      const t = rows.filter((r) => monthOf(r.date) === m).map((r) => -r.amount);
      return { month: m, visits: t.length, avgTicket: t.length ? robustMean(t) : null, medianTicket: t.length ? median(t) : null, total: t.reduce((s, x) => s + x, 0) };
    });
    merchants.push({
      key, description, category: rows[rows.length - 1].category, visits: rows.length, months: active.size,
      total: rows.reduce((s, r) => s + -r.amount, 0), ticket, frequency, split, driver, enough, monthly,
      ids: rows.map((r) => r.id),
    });
  }
  merchants.sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));

  // ---- (c) ranked increases / decreases ----------------------------------------------------------
  const moves = [];
  for (const c of charges) {
    for (const ch of c.changes) {
      if (!ch.inWindow) continue;
      moves.push({ kind: 'recurring', key: c.key, description: c.description, category: c.category, from: ch.from, to: ch.to, pct: ch.pct, yearly: ch.yearly, date: ch.date, confirmed: ch.confirmed, ids: ch.ids });
    }
  }
  for (const m of merchants) {
    if (!m.ticket || m.ticket.direction === 'flat') continue;
    moves.push({ kind: 'merchant', key: m.key, description: m.description, category: m.category, from: m.ticket.from, to: m.ticket.to, pct: m.ticket.pct, yearly: m.split.ticket, date: null, confirmed: true, ids: m.ids });
  }
  const order = (a, b) => Math.abs(b.yearly) - Math.abs(a.yearly) || (a.key < b.key ? -1 : 1);
  const increases = moves.filter((x) => x.yearly > 0).sort(order);
  const decreases = moves.filter((x) => x.yearly < 0).sort(order);
  const recurringUp = moves.filter((x) => x.kind === 'recurring' && x.yearly > 0).reduce((s, x) => s + x.yearly, 0);
  const recurringDown = moves.filter((x) => x.kind === 'recurring' && x.yearly < 0).reduce((s, x) => s - x.yearly, 0);

  return {
    months, from, to, recurring: charges, merchants, increases, decreases,
    dataStart: dataMonths[0] || null, dataMonths: dataMonths.length,
    compare: comparable ? { first: [q1List[0], q1List[2]], last: [q4List[0], q4List[2]] } : null,
    totals: { recurringIncreasesYearly: recurringUp, recurringDecreasesYearly: recurringDown, recurringNetYearly: recurringUp - recurringDown },
  };
}

const ils = (v) => (v == null ? null : toILS(Math.round(v)));
const ilsMove = (x) => ({
  kind: x.kind, key: `${x.kind === 'recurring' ? 'rec' : 'mer'}:${x.key}`, description: x.description, category: x.category,
  from: ils(x.from), to: ils(x.to), pct: x.pct, yearly: ils(x.yearly), date: x.date, confirmed: x.confirmed,
});

/** API shape (ILS). */
export function priceTrendsOutput(p, { limit = 8 } = {}) {
  return {
    start: p.months[0], end: p.months[11], changesFrom: p.from, changesTo: p.to,
    // The data actually behind the numbers: first month with data inside the window, and the two
    // three-month blocks the merchant comparison uses (null with under 6 months of data).
    dataStart: p.dataStart, dataMonths: p.dataMonths, compare: p.compare,
    rules: { ...MERCHANT_RULES, ticketAbs: toILS(MERCHANT_RULES.ticketAbs) },
    totals: {
      recurringIncreasesYearly: ils(p.totals.recurringIncreasesYearly),
      recurringDecreasesYearly: ils(p.totals.recurringDecreasesYearly),
      recurringNetYearly: ils(p.totals.recurringNetYearly),
    },
    increases: p.increases.slice(0, limit).map(ilsMove),
    decreases: p.decreases.slice(0, limit).map(ilsMove),
    recurring: p.recurring.map((c) => ({
      key: `rec:${c.key}`, description: c.description, category: c.category, cadence: c.cadence,
      amount: ils(c.amount), yearlyCost: ils(c.yearlyCost), variable: c.variable,
      levelChange: c.levelChange ? { from: ils(c.levelChange.from), to: ils(c.levelChange.to), pct: c.levelChange.pct } : null,
      history: c.history.map((h) => ({ date: h.date, amount: ils(h.amount) })),
      changes: c.changes.map((ch) => ({ date: ch.date, from: ils(ch.from), to: ils(ch.to), pct: ch.pct, yearly: ils(ch.yearly), confirmed: ch.confirmed, inWindow: ch.inWindow })),
      latestChange: c.latest ? { date: c.latest.date, from: ils(c.latest.from), to: ils(c.latest.to), pct: c.latest.pct, yearly: ils(c.latest.yearly), confirmed: c.latest.confirmed } : null,
      filter: { ids: c.ids.slice(-500) },
    })),
    merchants: p.merchants.slice(0, 15).map((m) => ({
      key: `mer:${m.key}`, description: m.description, category: m.category, visits: m.visits, months: m.months,
      total: ils(m.total), driver: m.driver, enoughData: m.enough,
      ticket: m.ticket ? { from: ils(m.ticket.from), to: ils(m.ticket.to), medianFrom: ils(m.ticket.medianFrom), medianTo: ils(m.ticket.medianTo), pct: m.ticket.pct, direction: m.ticket.direction } : null,
      frequency: m.frequency ? { from: Math.round(m.frequency.from * 10) / 10, to: Math.round(m.frequency.to * 10) / 10, pct: m.frequency.pct, direction: m.frequency.direction } : null,
      yearlyEffect: m.split ? { total: ils(m.split.total), frequency: ils(m.split.frequency), ticket: ils(m.split.ticket) } : null,
      monthly: m.monthly.map((x) => ({ month: x.month, visits: x.visits, avgTicket: ils(x.avgTicket), medianTicket: ils(x.medianTicket), total: ils(x.total) })),
      filter: { ids: m.ids.slice(-500) },
    })),
  };
}
