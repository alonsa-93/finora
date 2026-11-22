// Unit tests for the annual review, the price trends and their statistics. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataset } from '../analytics.js';
import {
  linearFit, trend, pctChange, compareFirstLast, priceLevels, mannWhitneyZ, countChangeZ, decomposeSpend,
  robustOutliers, robustMean, coefficientOfVariation, median,
} from '../stats.js';
import { computeAnnual, annualOutput, computeAnnualInsights, ANNUAL_INSIGHT_TYPES } from '../annual.js';
import { computePriceTrends, priceTrendsOutput } from '../prices.js';
import { normalizeDescription } from '../categories.js';
import { addMonths, addMonthsToDate } from '../dates.js';

// ---- statistics ----------------------------------------------------------------------------------

test('linear fit: exact slope on a straight line, nulls skipped', () => {
  const f = linearFit([100, 110, null, 130, 140]);
  assert.equal(f.n, 4);
  assert.equal(Math.round(f.slope * 1000) / 1000, 10);
  assert.equal(Math.round(f.intercept), 100);
  assert.equal(Math.round(f.r2 * 1000), 1000);
  assert.equal(linearFit([5]), null);
  assert.equal(linearFit([null, 3, null]), null);
});

test('trend: direction needs 6 months, a 5% move and a line that explains the data', () => {
  const up = trend([100, 104, 108, 112, 116, 120, 124]);
  assert.equal(up.direction, 'up');
  assert.equal(up.label, 'במגמת עלייה');
  assert.equal(Math.round(up.slope), 4);
  assert.equal(up.pct, 24); // 100 -> 124 over the period
  assert.equal(trend([100, 101, 100, 101, 100, 101]).direction, 'flat'); // < 5%
  assert.equal(trend([120, 116, 112, 108, 104, 100]).direction, 'down');
  // big swings with no direction: r2 too low
  assert.equal(trend([100, 300, 100, 300, 100, 300, 120]).direction, 'flat');
  assert.equal(trend([100, 110, 120, 130, 140]), null, 'five months: no claim');
  assert.equal(trend([100, null, null, null, null, null, null, 150]), null, 'two points with data: no claim');
  // absolute mode (a rate in percentage points)
  assert.equal(trend([20, 21, 22, 23, 24, 25], { absolute: true, flatAbs: 3 }).direction, 'up');
  assert.equal(trend([20, 20.5, 21, 21.2, 21.5, 22], { absolute: true, flatAbs: 3 }).direction, 'flat');
});

test('period comparisons: % change, first vs last three months', () => {
  assert.equal(pctChange(110, 100), 10);
  assert.equal(pctChange(97, 100), -3);
  assert.equal(pctChange(5, 0), null);
  assert.equal(pctChange(5, null), null);
  const q = compareFirstLast([100, 100, 100, null, 150, 150, 150]);
  assert.deepEqual([q.first, q.last, q.diff, q.pct], [100, 150, 50, 50]);
  assert.equal(compareFirstLast([1, 2, 3, 4, 5]), null, 'needs 6 months with data');
});

test('robust measures: median, trimmed mean ignores a freak receipt, CV, outliers', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(robustMean([100, 100, 100, 100, 5000]), 100);
  assert.equal(Math.round(coefficientOfVariation([100, 100, 100]) * 100), 0);
  assert.equal(coefficientOfVariation([100, 100]), null);
  const incomes = [18000, 18000, 18000, 25500, 18000, 18000, 18000, null, 18000];
  assert.deepEqual(robustOutliers(incomes, { minAbs: 1000, minRel: 0.15 }), [3]);
  assert.deepEqual(robustOutliers([18000, 18100, 17900, 18000, 18050, 18000], { minAbs: 1000 }), []);
  assert.deepEqual(robustOutliers([1, 50, 1], {}), [], 'too few months: no outliers');
});

test('price levels: change points need the old price twice; glitches and variable bills are not changes', () => {
  const step = priceLevels([4990, 4990, 4990, 5490, 5490]);
  assert.equal(step.variable, false);
  assert.equal(step.changes.length, 1);
  assert.deepEqual([step.changes[0].index, step.changes[0].from, step.changes[0].to, step.changes[0].confirmed], [3, 4990, 5490, true]);
  assert.equal(step.changes[0].pct, 10);
  const fresh = priceLevels([4990, 4990, 4990, 5490]);
  assert.equal(fresh.changes[0].confirmed, false, 'one charge at the new price: reported, unconfirmed');
  assert.equal(priceLevels([4990, 5490]).changes.length, 0, 'two charges: no claim');
  assert.equal(priceLevels([5000, 5000, 6000, 5000, 5000]).changes.length, 0, 'a one-off charge in between is ignored');
  const two = priceLevels([8900, 8900, 8900, 9900, 9900, 9900, 10900, 10900]);
  assert.deepEqual(two.changes.map((c) => [c.from, c.to]), [[8900, 9900], [9900, 10900]]);
  const down = priceLevels([11900, 11900, 9900, 9900]);
  assert.equal(down.changes[0].diff, -2000);
  const bill = priceLevels([41000, 52000, 39000, 55000, 47000, 43000]);
  assert.equal(bill.variable, true);
  assert.equal(bill.changes.length, 0);
  assert.equal(priceLevels([4990, 4990, 5000, 4990]).changes.length, 0, 'within 1 ILS is the same price');
});

test('ticket vs frequency: exact decomposition, rank test and Poisson check', () => {
  const d = decomposeSpend({ v1: 12, t1: 280, v2: 12, t2: 340 });
  assert.deepEqual(d, { total: 720, frequency: 0, ticket: 720 });
  const both = decomposeSpend({ v1: 10, t1: 100, v2: 15, t2: 120 });
  assert.equal(both.total, 15 * 120 - 10 * 100);
  assert.equal(both.frequency + both.ticket, both.total);
  const lo = [270, 280, 290, 275, 285, 265, 295, 280, 272, 288, 279, 281];
  const hi = lo.map((x) => x + 60);
  assert.ok(mannWhitneyZ(lo, hi) > 1.96);
  assert.ok(mannWhitneyZ(hi, lo) < -1.96);
  assert.ok(Math.abs(mannWhitneyZ(lo, [...lo].reverse())) < 0.5);
  assert.equal(mannWhitneyZ([1, 2], [3, 4, 5]), null);
  assert.ok(countChangeZ(4, 12) >= 1.96);
  assert.ok(countChangeZ(4, 6) < 1.96);
});

// ---- synthetic household ----------------------------------------------------------------------

let nextId = 1;
const BANK = { id: 1, type: 'bank', name: 'פועלים •5521', balance: 1000000 };
const CARD = { id: 2, type: 'card', name: 'מקס •1234', balance: null };
function row(o) {
  const bank = !!o.bank;
  return {
    id: nextId++, accountId: bank ? 1 : 2, accountType: bank ? 'bank' : 'card', date: o.date, processedDate: o.date,
    description: o.description, merchantKey: normalizeDescription(o.description), amount: Math.round(o.amount * 100),
    instNumber: o.instNumber ?? null, instTotal: o.instTotal ?? null, status: 'completed', category: o.category,
    isCardPayment: false, excluded: false, identifier: null,
  };
}

/**
 * `months` months ending last month (today = 2026-11-14): salary (raise half-way), rent, groceries at a
 * supermarket with a drifting ticket and flat visits, insurance with a price step 6 months ago.
 */
function household(months, { today = '2026-11-14', ticketDrift = 6, insuranceStepAgo = 6 } = {}) {
  const rows = [];
  const cur = today.slice(0, 7);
  for (let k = months; k >= 1; k--) {
    const m = addMonths(cur, -k);
    rows.push(row({ bank: true, date: `${m}-01`, amount: -5000, description: 'שכר דירה', category: 'housing' }));
    rows.push(row({ bank: true, date: `${m}-10`, amount: k > months / 2 ? 15000 : 16000, description: 'משכורת', category: 'salary' }));
    rows.push(row({ bank: true, date: `${m}-15`, amount: k <= insuranceStepAgo ? -220 : -200, description: 'הראל ביטוח', category: 'insurance' }));
    const base = 280 + (months - k) * ticketDrift;
    [3, 10, 17, 24].forEach((day, i) => rows.push(row({ date: `${m}-${String(day).padStart(2, '0')}`, amount: -(base + (i - 1.5) * 4), description: 'שופרסל דיל', category: 'groceries' })));
  }
  return buildDataset({ rows, accounts: [BANK, CARD], today });
}

test('annual: fewer than 12 months -> totals over what exists, no previous year, no claims under 6', () => {
  const a4 = computeAnnual(household(4));
  assert.equal(a4.coverage.months, 4);
  assert.equal(a4.previous, null);
  assert.equal(a4.change, null);
  assert.equal(a4.trends.income, null);
  assert.equal(a4.extremes, null);
  assert.equal(a4.incomeStability, null);
  assert.equal(a4.series.filter((s) => !s.covered).length, 8);
  assert.ok(a4.series.filter((s) => !s.covered).every((s) => s.expenses === null), 'uncovered months are null, not zero');
  const out = annualOutput(a4);
  assert.equal(out.monthly.length, 12);
  assert.equal(out.previous, null);
  const ins = computeAnnualInsights(a4);
  assert.equal(ins[0].type, 'yearCoverage');
  assert.ok(!ins.some((i) => ['yearSpending', 'categoryTrendUp', 'expensiveMonth', 'yearIncome'].includes(i.type)));

  const a7 = computeAnnual(household(7));
  assert.equal(a7.coverage.months, 7);
  assert.equal(a7.coverage.historyMonths, 7);
  assert.equal(computeAnnual(household(24), '2025-06').coverage.historyMonths, 8, 'history counted up to the window end');
  assert.equal(a7.previous, null, 'previous year needs all 12 of its months');
  assert.ok(a7.trends.income);
  const y = computeAnnualInsights(a7).find((i) => i.type === 'yearSpending');
  assert.match(y.title, /^במהלך 7 החודשים האחרונים הוצאת/);
  assert.match(y.body, /ההשוואה לשנה הקודמת תופיע/);
});

test('annual: 24 months -> previous year, exact totals and changes', () => {
  const a = computeAnnual(household(24));
  assert.equal(a.coverage.months, 12);
  assert.ok(a.previous);
  const out = annualOutput(a);
  // this year: salary 16,000 x 12; previous: 15,000 x 12
  assert.equal(out.totals.income, 192000);
  assert.equal(out.previous.income, 180000);
  assert.equal(out.change.incomePct, 6.7);
  // expenses: rent 60,000 + insurance (6 x 200 + 6 x 220) + groceries (4 visits, mean 280 + drift)
  let groceries = 0;
  for (let k = 12; k >= 1; k--) groceries += 4 * (280 + (24 - k) * 6);
  assert.equal(out.totals.expenses, 60000 + 6 * 200 + 6 * 220 + groceries);
  assert.equal(out.totals.net, out.totals.income - out.totals.expenses);
  assert.equal(out.monthly.length, 12);
  assert.equal(out.months[0], '2025-11');
  assert.equal(out.end, '2026-10');
  const g = out.categories.find((c) => c.category === 'groceries');
  assert.equal(g.trend.direction, 'up');
  assert.equal(g.quarters.diff, 4 * 6 * 9); // 9 months between the centres of the first and last 3
});

test('price trends: ticket up with flat visits -> driver "ticket"; recurring step counted per year', () => {
  const ds = household(12, { ticketDrift: 6 });
  const p = computePriceTrends(ds);
  const m = p.merchants.find((x) => x.description === 'שופרסל דיל');
  assert.ok(m.enough);
  assert.equal(m.ticket.direction, 'up');
  assert.equal(m.frequency.direction, 'flat');
  assert.equal(m.driver, 'ticket');
  assert.equal(m.split.frequency, 0);
  assert.equal(m.split.ticket, 12 * (m.ticket.to - m.ticket.from) * 4, 'one year at the new ticket and the current visit rate');
  const ins = p.recurring.find((r) => r.description === 'הראל ביטוח');
  assert.equal(ins.changes.length, 1);
  assert.equal(ins.changes[0].yearly, 2000 * 12);
  assert.equal(p.totals.recurringIncreasesYearly, 24000);
  assert.equal(p.increases[0].kind, 'merchant');
  const out = priceTrendsOutput(p);
  assert.equal(out.totals.recurringIncreasesYearly, 240);
  assert.ok(out.recurring.every((r) => r.history.length >= 3));
  // flat ticket: no claim
  const flat = computePriceTrends(household(12, { ticketDrift: 0 })).merchants.find((x) => x.description === 'שופרסל דיל');
  assert.equal(flat.ticket.direction, 'flat');
  assert.equal(flat.driver, 'none');
});

test('price trends: more visits at the same ticket -> driver "frequency"; thin data -> no claim', () => {
  const rows = [];
  const cur = '2026-11';
  for (let k = 12; k >= 1; k--) {
    const m = addMonths(cur, -k);
    const visits = k > 6 ? 2 : 6;
    for (let i = 0; i < visits; i++) rows.push(row({ date: `${m}-${String(2 + i * 4).padStart(2, '0')}`, amount: -(120 + (i % 3)), description: 'ארומה', category: 'restaurants' }));
    if (k % 2 === 0) rows.push(row({ date: `${m}-05`, amount: -(k > 6 ? 60 : 160), description: 'קפה גרג', category: 'restaurants' }));
  }
  const p = computePriceTrends(buildDataset({ rows, accounts: [BANK, CARD], today: '2026-11-14' }));
  const aroma = p.merchants.find((x) => x.description === 'ארומה');
  assert.equal(aroma.frequency.direction, 'up');
  assert.equal(aroma.ticket.direction, 'flat');
  assert.equal(aroma.driver, 'frequency');
  assert.ok(!p.merchants.some((x) => x.description === 'קפה גרג'), 'six visits a year is not a frequent merchant');
});

test('annual insights: Hebrew-first titles, backed by rows, deterministic, receipt wording', () => {
  const ds = household(24);
  const a1 = computeAnnualInsights(computeAnnual(ds));
  const a2 = computeAnnualInsights(computeAnnual(household(24)));
  assert.deepEqual(a1.map((i) => i.title), a2.map((i) => i.title));
  assert.ok(a1.length >= 3);
  for (const i of a1) {
    assert.match(i.title, /^[א-ת]/, `title starts with a Hebrew word: ${i.title}`);
    assert.ok(ANNUAL_INSIGHT_TYPES.includes(i.type), i.type);
    assert.ok(['good', 'info', 'warning', 'alert'].includes(i.severity));
    assert.ok(i.action.filter && Object.keys(i.action.filter).length, `${i.type} has a filter`);
    if (i.action.filter.ids) assert.ok(i.action.filter.ids.length <= 500);
    assert.doesNotMatch(`${i.title} ${i.body}`, /המחירים עלו/);
  }
  const spend = a1.find((i) => i.type === 'yearSpending');
  assert.match(spend.title, /^בשנה האחרונה הוצאת/);
  assert.match(spend.title, /ההכנסות עלו ב-7%/);
  const ticket = a1.find((i) => i.type === 'merchantTicket');
  assert.match(ticket.title, /^הקנייה הממוצעת בשופרסל דיל עלתה מ-/);
  assert.match(ticket.title, /בלי שינוי במספר הביקורים/);
  const fixed = a1.find((i) => i.type === 'fixedCostsChange');
  assert.match(fixed.title, /התייקרו ב-240 ₪ בשנה, בעיקר בביטוח/);
  assert.ok(fixed.action.filter.ids.length >= 2);
});

test('annual insights: thresholds keep a steady year quiet', () => {
  const rows = [];
  for (let k = 12; k >= 1; k--) {
    const m = addMonths('2026-11', -k);
    rows.push(row({ bank: true, date: `${m}-10`, amount: 15000, description: 'משכורת', category: 'salary' }));
    rows.push(row({ date: `${m}-12`, amount: -(1000 + (k % 2) * 20), description: 'רמי לוי', category: 'groceries' }));
  }
  const ins = computeAnnualInsights(computeAnnual(buildDataset({ rows, accounts: [BANK, CARD], today: '2026-11-14' })));
  const types = ins.map((i) => i.type);
  for (const t of ['categoryTrendUp', 'categoryTrendDown', 'expensiveMonth', 'unusualIncome', 'yearIncome', 'fixedCostsChange', 'merchantTicket', 'instalmentsAhead']) {
    assert.ok(!types.includes(t), `no ${t} for a steady year`);
  }
  assert.deepEqual(types, ['yearSpending', 'yearSavings']);
});

test('annual: unusual income month and open instalments', () => {
  const rows = [];
  for (let k = 12; k >= 1; k--) {
    const m = addMonths('2026-11', -k);
    rows.push(row({ bank: true, date: `${m}-10`, amount: k === 4 ? 22000 : 15000, description: 'משכורת', category: 'salary' }));
    rows.push(row({ date: `${m}-12`, amount: -1000, description: 'רמי לוי', category: 'groceries' }));
  }
  for (let n = 1; n <= 3; n++) rows.push(row({ date: addMonthsToDate('2026-09-07', n - 1), amount: -500, description: 'מחסני חשמל', category: 'shopping', instNumber: n, instTotal: 10 }));
  const a = computeAnnual(buildDataset({ rows, accounts: [BANK, CARD], today: '2026-11-14' }));
  assert.deepEqual(a.incomeStability.unusual.map((u) => u.month), ['2026-07']);
  assert.equal(a.instalments.count, 1);
  assert.equal(a.instalments.remainingAmount, 7 * 50000);
  assert.equal(a.instalments.plans[0].nextDate, '2026-12-07');
  const ins = computeAnnualInsights(a);
  assert.match(ins.find((i) => i.type === 'unusualIncome').title, /^ביולי ההכנסה הייתה גבוהה מהרגיל/);
  assert.equal(ins.find((i) => i.type === 'instalmentsAhead').amount, 3500);
});

test('every annual conclusion that asks for action carries a tip', async () => {
  const { ANNUAL_TIPS } = await import('../annual.js');
  for (const t of ANNUAL_INSIGHT_TYPES) if (t !== 'yearCoverage') assert.ok(ANNUAL_TIPS[t], `tip for ${t}`);
});
