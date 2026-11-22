// Dashboard periods: rolling windows, year to date, ranges and sets of months.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataset, monthTotals } from '../analytics.js';
import { resolvePeriod, computePeriodSummary, parseMonthsList } from '../period.js';
import { normalizeDescription } from '../categories.js';

let id = 1;
const CARD = { id: 2, type: 'card', name: 'מקס •1234', balance: null };
const row = (date, amount, category = 'groceries', description = 'שופרסל') => ({
  id: id++, accountId: 2, accountType: 'card', date, processedDate: date, description, merchantKey: normalizeDescription(description),
  amount: Math.round(amount * 100), instNumber: null, instTotal: null, status: 'completed', category, isCardPayment: false, excluded: false,
});
const TODAY = '2026-11-14';
const rows = [];
for (const m of ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']) {
  rows.push(row(`${m}-02`, -100, 'groceries'), row(`${m}-10`, -50, 'fuel', 'סונול'));
}
const ds = buildDataset({ rows, accounts: [CARD], today: TODAY });

test('presets resolve to rolling windows ending today', () => {
  assert.deepEqual(resolvePeriod({ period: 'm1' }, TODAY), { kind: 'm1', from: '2026-10-15', to: TODAY });
  assert.deepEqual(resolvePeriod({ period: 'm3' }, TODAY), { kind: 'm3', from: '2026-08-15', to: TODAY });
  assert.deepEqual(resolvePeriod({ period: 'ytd' }, TODAY), { kind: 'ytd', from: '2026-01-01', to: TODAY });
  assert.deepEqual(resolvePeriod({ period: 'y1' }, TODAY), { kind: 'y1', from: '2025-11-15', to: TODAY });
  assert.equal(resolvePeriod({}, TODAY), null);
  assert.deepEqual(resolvePeriod({ from: '2026-10-01', to: '2027-01-01' }, TODAY).to, TODAY, 'capped at today');
  assert.throws(() => parseMonthsList('2026-13'));
  assert.deepEqual(parseMonthsList('2026-09,2026-03,2026-09'), ['2026-03', '2026-09']);
});

test('a set of months adds up exactly those months and compares with the same months a year earlier', () => {
  const p = resolvePeriod({ months: ['2026-03', '2026-09'] }, TODAY);
  const s = computePeriodSummary(ds, p);
  const exp = (monthTotals(ds, '2026-03').expenses + monthTotals(ds, '2026-09').expenses) / 100;
  assert.equal(s.totals.expenses, exp);
  assert.equal(s.totals.expenses, 300);
  assert.deepEqual(s.previous.months, ['2025-03', '2025-09']);
  assert.equal(s.totals.prevExpenses, null, 'no data a year earlier');
  assert.deepEqual(s.periodMonthly.map((m) => m.month), ['2026-03', '2026-09']);
  assert.equal(s.daily, null);
  assert.equal(s.byCategory.find((c) => c.category === 'fuel').amount, 100);
});

test('a rolling 3 months compares with the 3 months before and has a month-by-month split', () => {
  const s = computePeriodSummary(ds, resolvePeriod({ period: 'm3' }, TODAY));
  // 08-15..11-14: Sep, Oct, Nov full rows (02 and 10 of each) = 3 x 150
  assert.equal(s.totals.expenses, 450);
  assert.equal(s.previous.to, '2026-08-14');
  assert.equal(s.totals.prevExpenses, 450); // 05-15..08-14: Jun, Jul, Aug
  assert.equal(s.totals.expensesChangePct, 0);
  assert.deepEqual(s.periodMonthly.map((m) => m.expenses), [0, 150, 150, 150]);
  assert.equal(s.isCurrent, true);
  assert.equal(s.daily, null, 'over 62 days');
  const m1 = computePeriodSummary(ds, resolvePeriod({ period: 'm1' }, TODAY));
  assert.equal(m1.daily.length, 31);
  assert.equal(m1.daily.at(-1).cumulative, m1.totals.expenses);
});
