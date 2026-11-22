// Unit tests for the money maths, recurring detection and insights. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDataset, contribution, monthTotals, computeSummary, detectRecurring, computeForecast,
  upcomingCardChargesTotal, computeUpcoming,
} from '../analytics.js';
import { computeInsights } from '../insights.js';
import { normalizeDescription } from '../categories.js';
import { addMonthsToDate } from '../dates.js';

let nextId = 1;
const BANK = { id: 1, type: 'bank', name: 'פועלים •5521', balance: 1000000 };
const CARD = { id: 2, type: 'card', name: 'מקס •1234', balance: null };

/** Row factory; amount in ILS (converted to agorot). */
function row(o) {
  const amount = Math.round(o.amount * 100);
  return {
    id: nextId++, accountId: o.card === false || o.bank ? 1 : 2, accountType: o.card === false || o.bank ? 'bank' : 'card',
    date: o.date, processedDate: o.processedDate || o.date, description: o.description || 'שופרסל',
    merchantKey: normalizeDescription(o.description || 'שופרסל'), amount, instNumber: o.instNumber ?? null,
    instTotal: o.instTotal ?? null, status: o.status || 'completed', category: o.category || 'groceries',
    isCardPayment: !!o.isCardPayment, excluded: !!o.excluded, identifier: o.identifier ?? null,
  };
}
const ds = (rows, today, accounts = [BANK, CARD]) => buildDataset({ rows, accounts, today });

test('card refunds reduce category spending; card-payment debits only count without card accounts', () => {
  const purchase = row({ date: '2026-10-03', amount: -300, category: 'shopping' });
  const refund = row({ date: '2026-10-05', amount: 120, category: 'shopping' });
  const debit = row({ bank: true, date: '2026-10-10', amount: -2000, category: 'card-payment', isCardPayment: true });
  const salary = row({ bank: true, date: '2026-10-10', amount: 15000, category: 'salary' });
  const bit = row({ bank: true, date: '2026-10-11', amount: 200, category: 'transfers' });
  const d = ds([purchase, refund, debit, salary, bit], '2026-10-31');
  const t = monthTotals(d, '2026-10');
  assert.equal(t.expenses, 18000); // 300 - 120 = 180 ILS, card debit ignored (cards connected)
  assert.equal(t.income, 1500000); // Bit transfer is not income
  assert.equal(contribution(debit, false).value, 200000); // no cards connected => debit is spending
  const noCards = ds([debit], '2026-10-31', [BANK]);
  assert.equal(monthTotals(noCards, '2026-10').expenses, 200000);
});

test('sums are exact in agorot (no float drift)', () => {
  const rows = [];
  for (let i = 0; i < 1000; i++) rows.push(row({ date: '2026-09-15', amount: -0.1, category: 'other' }));
  const s = computeSummary(ds(rows, '2026-09-30'), '2026-09');
  assert.equal(s.totals.expenses, 100);
});

test('excluded rows never count', () => {
  const d = ds([row({ date: '2026-09-02', amount: -500, excluded: true })], '2026-09-30');
  assert.equal(monthTotals(d, '2026-09').expenses, 0);
});

test('instalments count the per-instalment charged amount in their own month', () => {
  const rows = [1, 2, 3].map((n) => row({ date: addMonthsToDate('2026-08-07', n - 1), amount: -400, instNumber: n, instTotal: 3, category: 'shopping', description: 'KSP' }));
  const d = ds(rows, '2026-10-20');
  assert.equal(monthTotals(d, '2026-08').expenses, 40000);
  assert.equal(monthTotals(d, '2026-10').expenses, 40000);
});

test('card spending month uses transaction date, upcoming card charges use processedDate', () => {
  const r1 = row({ date: '2026-10-28', processedDate: '2026-11-10', amount: -100 });
  const r2 = row({ date: '2026-11-02', processedDate: '2026-12-10', amount: -50 });
  const r3 = row({ date: '2026-11-04', amount: -30, status: 'pending' });
  const d = ds([r1, r2, r3], '2026-11-05');
  assert.equal(monthTotals(d, '2026-10').expenses, 10000);
  assert.equal(upcomingCardChargesTotal(d), 18000); // r1 (processed 10.11 > today), r2, r3 (pending)
  const up = computeUpcoming(d, []);
  assert.ok(up.every((u) => u.kind === 'cardCharge'));
  assert.equal(up.reduce((s, u) => s + u.amount, 0), 18000);
});

test('summary shape: daily nulls after today, 12 monthly points, forecast null before day 5', () => {
  const rows = [];
  for (let m = 1; m <= 11; m++) rows.push(row({ date: `2026-${String(m).padStart(2, '0')}-02`, amount: -1000 }));
  const s = computeSummary(ds(rows, '2026-11-03'), '2026-11');
  assert.equal(s.daily.length, 30);
  assert.equal(s.daily[2].cumulative, 1000); // the 1,000 charge on 2.11
  assert.equal(s.daily[3].expenses, null);
  assert.equal(s.daily[3].cumulative, null);
  assert.notEqual(s.daily[3].prevCumulative, null);
  assert.equal(s.monthly.length, 12);
  assert.equal(s.monthly[11].month, '2026-11');
  assert.equal(s.forecast, null);
  assert.equal(s.isCurrentMonth, true);
});

test('expensesChangePct compares to the same day of last month for the current month', () => {
  const rows = [
    row({ date: '2026-09-01', amount: -10 }),
    row({ date: '2026-10-05', amount: -100 }), row({ date: '2026-10-25', amount: -900 }),
    row({ date: '2026-11-04', amount: -150 }),
  ];
  const s = computeSummary(ds(rows, '2026-11-10'), '2026-11');
  assert.equal(s.totals.prevExpensesSameDay, 100);
  assert.equal(s.totals.prevExpenses, 1000);
  assert.equal(s.totals.expensesChangePct, 50);
});

function monthlySeries(desc, amounts, startMonth, day, category = 'subscriptions') {
  return amounts.map((a, i) => row({ date: addMonthsToDate(`${startMonth}-${String(day).padStart(2, '0')}`, i), amount: -a, description: desc, category }));
}

test('recurring: detects monthly subscription and its price increase', () => {
  const rows = monthlySeries('NETFLIX', [49.9, 49.9, 49.9, 49.9, 54.9], '2026-06', 18);
  const rec = detectRecurring(ds(rows, '2026-11-01'));
  assert.equal(rec.length, 1);
  assert.equal(rec[0].cadence, 'monthly');
  assert.equal(rec[0].nextDate, '2026-11-18');
  assert.equal(rec[0].yearlyCost, 5490 * 12);
  assert.deepEqual([rec[0].priceChange.from, rec[0].priceChange.to], [4990, 5490]);
});

test('recurring: weekly grocery shopping and ended subscriptions are not recurring', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row({ date: addMonthsToDate('2026-06-03', Math.floor(i / 4)).slice(0, 8) + String(3 + (i % 4) * 7).padStart(2, '0'), amount: -300 }));
  rows.push(...monthlySeries('SPOTIFY', [23.9, 23.9, 23.9, 23.9], '2026-01', 5));
  const rec = detectRecurring(ds(rows, '2026-11-01'));
  assert.equal(rec.length, 0);
});

test('recurring: bi-monthly bills', () => {
  const rows = [0, 2, 4, 6].map((k) => row({ bank: true, date: addMonthsToDate('2026-02-22', k), amount: -450, description: 'חברת החשמל', category: 'bills' }));
  const rec = detectRecurring(ds(rows, '2026-08-30'));
  assert.equal(rec[0]?.cadence, 'bimonthly');
  assert.equal(rec[0].nextDate, '2026-10-22');
});

function baseHistory(today) {
  // 6 months of steady spending: groceries ~1,500/month, restaurants ~400/month.
  const rows = [];
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  for (const m of months) {
    for (const d of [3, 10, 17, 24]) rows.push(row({ date: `${m}-${d}`, amount: -375, description: 'שופרסל דיל' }));
    for (const d of [6, 20]) rows.push(row({ date: `${m}-${String(d).padStart(2, '0')}`, amount: -200, description: 'ארומה', category: 'restaurants' }));
    rows.push(row({ bank: true, date: `${m}-10`, amount: 15000, description: 'משכורת', category: 'salary' }));
  }
  return rows.filter((r) => r.date <= today);
}

test('insights: category spike needs a meaningful absolute and relative gap', () => {
  const today = '2026-11-20';
  const rows = baseHistory(today);
  rows.push(row({ date: '2026-11-05', amount: -500, description: 'מסעדה א', category: 'restaurants' }));
  rows.push(row({ date: '2026-11-12', amount: -480, description: 'מסעדה ב', category: 'restaurants' }));
  const ins = computeInsights(ds(rows, today), '2026-11');
  const spike = ins.find((i) => i.type === 'categorySpike');
  assert.ok(spike, 'spike expected');
  assert.equal(spike.category, 'restaurants');
  assert.equal(spike.amount, 580);
  assert.deepEqual(spike.action.filter, { category: 'restaurants', month: '2026-11' });
  // small change => no spike
  const quiet = computeInsights(ds([...baseHistory(today), row({ date: '2026-11-05', amount: -450, category: 'restaurants', description: 'ארומה' })], today), '2026-11');
  assert.equal(quiet.filter((i) => i.type === 'categorySpike').length, 0);
});

test('insights: no spike without 3 months of history', () => {
  const rows = [
    row({ date: '2026-10-01', amount: -100, category: 'restaurants', description: 'ארומה' }),
    row({ date: '2026-11-03', amount: -2000, category: 'restaurants', description: 'ארומה' }),
  ];
  const ins = computeInsights(ds(rows, '2026-11-10'), '2026-11');
  assert.equal(ins.filter((i) => i.type === 'categorySpike' || i.type === 'newMerchant').length, 0);
});

test('insights: duplicate charge found, backed by both ids; recurring and instalments excluded', () => {
  const today = '2026-11-20';
  const rows = baseHistory(today);
  const a = row({ date: '2026-11-14', amount: -186, description: 'שיפודי התקווה', category: 'restaurants' });
  const b = row({ date: '2026-11-15', amount: -186, description: 'שיפודי התקווה', category: 'restaurants' });
  const i1 = row({ date: '2026-11-07', amount: -500, description: 'KSP', category: 'shopping', instNumber: 1, instTotal: 3 });
  const i2 = row({ date: '2026-11-07', amount: -500, description: 'KSP', category: 'shopping', instNumber: 1, instTotal: 3 });
  rows.push(a, b, i1, i2);
  const ins = computeInsights(ds(rows, today), '2026-11');
  const dups = ins.filter((i) => i.type === 'duplicateCharge');
  assert.equal(dups.length, 1);
  assert.deepEqual(dups[0].action.filter.ids, [a.id, b.id]);
  assert.match(dups[0].body, /186 ₪/);
});

test('insights: unusual charge vs merchant median; low balance; deterministic', () => {
  const today = '2026-11-20';
  const rows = baseHistory(today);
  const big = row({ date: '2026-11-08', amount: -1400, description: 'שופרסל דיל' });
  rows.push(big);
  rows.push(row({ date: '2026-11-15', processedDate: '2026-12-10', amount: -3000, description: 'איקאה', category: 'shopping' }));
  const accounts = [{ ...BANK, balance: 200000 }, CARD];
  const d1 = computeInsights(ds(rows, today, accounts), '2026-11');
  const d2 = computeInsights(ds(rows.map((r) => ({ ...r })), today, accounts), '2026-11');
  assert.deepEqual(d1, d2);
  const unusual = d1.find((i) => i.type === 'unusualCharge');
  assert.ok(unusual);
  assert.deepEqual(unusual.action.filter.ids, [big.id]);
  const low = d1.find((i) => i.type === 'lowBalance');
  assert.ok(low);
  assert.equal(low.severity, 'alert');
  assert.equal(d1[0].type, 'lowBalance'); // most important first
  for (const i of d1) {
    assert.ok(i.action && i.action.filter && Object.keys(i.action.filter).length);
    assert.ok(['good', 'info', 'warning', 'alert'].includes(i.severity));
  }
  assert.ok(d1.length <= 8);
});

test('forecast: pace + known recurring, range contains projection', () => {
  const today = '2026-11-15';
  const rows = baseHistory(today);
  rows.push(...monthlySeries('NETFLIX', [50, 50, 50, 50, 50, 50], '2026-05', 20));
  rows.push(row({ date: '2026-11-03', amount: -375, description: 'שופרסל דיל' }));
  rows.push(row({ date: '2026-11-10', amount: -375, description: 'שופרסל דיל' }));
  const d = ds(rows, today);
  const f = computeForecast(d, detectRecurring(d));
  assert.ok(f);
  assert.ok(f.low <= f.projected && f.projected <= f.high);
  assert.ok(f.known >= 5000); // Netflix on 20.11 not yet charged
  assert.ok(f.projected > f.spent);
});

test('savings rate insight uses last complete month for the current month', () => {
  const today = '2026-11-20';
  const ins = computeInsights(ds(baseHistory(today), today), '2026-11');
  const s = ins.find((i) => i.type === 'savingsRate');
  assert.ok(s);
  assert.deepEqual(s.action.filter, { month: '2026-10' });
  assert.equal(s.amount, 15000 - 1900);
});
