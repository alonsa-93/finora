// position.js: bank balance now and rebuilt backwards, the card bill now and per month, red flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataset } from '../analytics.js';
import { computePosition, positionMonths, TIPS } from '../position.js';

const TODAY = '2026-11-20';
let nextId = 1;
const row = (o) => ({
  id: nextId++, accountId: 1, accountType: 'bank', date: '2026-11-01', processedDate: null, description: 'x', merchantKey: 'x',
  amount: 0, instNumber: null, instTotal: null, status: 'completed', category: 'groceries', isCardPayment: false, excluded: false, ...o,
});
const accounts = [
  { id: 1, type: 'bank', name: 'פועלים •1234', balance: 1000000, lastSyncAt: '2026-11-20T08:00:00Z' }, // 10,000 ₪
  { id: 2, type: 'card', name: 'מקס •1111', balance: null },
  { id: 3, type: 'card', name: 'מקס •2222', balance: null },
];

test('default months: the last six up to the current one; future months dropped', () => {
  assert.deepEqual(positionMonths(null, TODAY), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  assert.deepEqual(positionMonths(['2026-12', '2026-03', '2026-01', '2026-03'], TODAY), ['2026-01', '2026-03']);
});

test('bank: the balance is rebuilt backwards from today, per day and per month', () => {
  const rows = [
    row({ date: '2026-10-01', amount: 1500000, category: 'salary' }), // +15,000
    row({ date: '2026-10-10', amount: -400000 }),                     // -4,000
    row({ date: '2026-11-05', amount: -200000 }),                     // -2,000
    row({ date: '2026-11-15', amount: -100000, status: 'pending' }),  // pending: not in the balance
  ];
  const p = computePosition(buildDataset({ rows, accounts: accounts.slice(0, 1), today: TODAY }), { months: ['2026-10', '2026-11'] });
  assert.equal(p.bank.current, 10000);
  assert.equal(p.bank.monthStart, 12000, 'today 10,000 + the 2,000 that left in November');
  assert.equal(p.bank.changeThisMonth, -2000);
  const [oct, nov] = p.bank.months;
  assert.equal(oct.open, 1000, 'end of September: 12,000 - 15,000 + 4,000');
  assert.equal(oct.close, 12000);
  assert.deepEqual([oct.in, oct.out], [15000, 4000]);
  assert.equal(oct.series.length, 31);
  assert.equal(oct.series.find((d) => d.date === '2026-10-09').balance, 16000);
  assert.equal(nov.series.length, 20, 'up to today');
  assert.equal(nov.close, 10000);
  assert.equal(p.cards.hasData, false);
  assert.equal(p.afterCards, null);
});

test('bank: unknown before the first known movement', () => {
  const rows = [row({ date: '2026-11-03', amount: -50000 })];
  const p = computePosition(buildDataset({ rows, accounts: accounts.slice(0, 1), today: TODAY }), { months: ['2026-09', '2026-11'] });
  assert.equal(p.bank.months[0].close, null);
  assert.equal(p.bank.months[1].open, null, 'the end of October is before the history');
  assert.equal(p.bank.months[1].series.find((d) => d.date === '2026-11-02').balance, 10500, 'the day before the first movement is known');
  assert.equal(p.bank.months[1].series.find((d) => d.date === '2026-11-01').balance, null);
});

test('cards: the unpaid bill now, per card, the next charge, and the bill per charge month', () => {
  const rows = [];
  // six complete months of 3,000 ₪ bills on card 2
  for (let i = 1; i <= 6; i += 1) {
    const m = `2026-${String(11 - i).padStart(2, '0')}`;
    rows.push(row({ accountId: 2, accountType: 'card', date: `${m}-05`, processedDate: `${m}-10`, amount: -300000 }));
  }
  // this month: 2,000 already charged on 10.11 + 5,000 to be charged on 10.12 (unpaid)
  rows.push(row({ accountId: 2, accountType: 'card', date: '2026-10-20', processedDate: '2026-11-10', amount: -200000 }));
  rows.push(row({ accountId: 2, accountType: 'card', date: '2026-11-12', processedDate: '2026-12-10', amount: -400000 }));
  rows.push(row({ accountId: 3, accountType: 'card', date: '2026-11-13', processedDate: '2026-12-10', amount: -100000 }));
  rows.push(row({ accountId: 3, accountType: 'card', date: '2026-11-19', status: 'pending', amount: -50000 }));
  const p = computePosition(buildDataset({ rows, accounts, today: TODAY }), { months: ['2026-10', '2026-11'] });
  assert.equal(p.cards.current, 5500, 'unpaid: 4,000 + 1,000 + pending 500');
  assert.deepEqual(p.cards.cards.map((c) => c.current), [4000, 1500]);
  assert.equal(p.cards.nextChargeDate, '2026-12-10');
  assert.equal(p.cards.nextChargeAmount, 5000);
  assert.equal(p.cards.average, 3000);
  assert.equal(p.cards.averageMonths, 5, 'complete months after the first card month');
  assert.equal(p.cards.months[0].total, 3000);
  assert.equal(p.cards.months[1].total, 2500, 'November: 2,000 charged on 10.11 + the pending 500');
  assert.equal(p.afterCards, 10000 - 5500);
});

test('red flags: the card bill well above normal, the bank sliding three months, low balance; each with a tip', () => {
  const rows = [];
  for (let i = 1; i <= 6; i += 1) {
    const m = `2026-${String(11 - i).padStart(2, '0')}`;
    rows.push(row({ accountId: 2, accountType: 'card', date: `${m}-02`, processedDate: `${m}-10`, amount: -200000 }));
    // the bank: salary 10,000 and 13,000 out every month -> slides 3,000 a month
    rows.push(row({ date: `${m}-01`, amount: 1000000, category: 'salary' }));
    rows.push(row({ date: `${m}-03`, amount: -1300000, category: 'housing' }));
  }
  rows.push(row({ accountId: 2, accountType: 'card', date: '2026-11-02', processedDate: '2026-11-10', amount: -600000 }));
  rows.push(row({ accountId: 2, accountType: 'card', date: '2026-11-15', processedDate: '2026-12-10', amount: -1500000 }));
  const p = computePosition(buildDataset({ rows, accounts, today: TODAY }));
  const types = p.redFlags.map((f) => f.type);
  assert.ok(types.includes('cardAboveNormal'), types.join());
  assert.ok(types.includes('bankDecline'), types.join());
  assert.ok(types.includes('lowBalance'), types.join());
  assert.equal(p.redFlags[0].severity, 'alert', 'alerts first');
  for (const f of p.redFlags) assert.ok(f.tip, `tip for ${f.type}`);
  for (const f of p.redFlags) assert.ok(Array.isArray(f.action.filter.ids) || typeof f.action.filter === 'object');
  assert.ok(Object.keys(TIPS).length >= 13);
});
