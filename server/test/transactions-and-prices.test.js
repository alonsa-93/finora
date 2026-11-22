// Transactions and prices: category change undo, "similar rows" count, the spending drill-down that
// nets to the headline, day totals, the one shared price-change definition, price trends with partial
// history and search by amount. Run: npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MONEYCASH_DATA_DIR = mkdtempSync(join(tmpdir(), 'moneycash-test-'));
process.env.MONEYCASH_QUIET = '1';

let db; let store; let repo; let analytics; let prices; let cats;
before(async () => {
  const { openDb } = await import('../db.js');
  db = openDb('real');
  store = await import('../store.js');
  repo = await import('../repo.js');
  analytics = await import('../analytics.js');
  prices = await import('../prices.js');
  cats = await import('../categories.js');
});

const NOW = '2026-11-13T08:00:00.000Z';
const t = (o) => ({
  identifier: null, processedDate: o.date, memo: null, originalAmount: o.amount, originalCurrency: 'ILS',
  instNumber: null, instTotal: null, status: 'completed', providerCategory: null, ...o,
});
let accN = 0;
function account(type = 'card') {
  accN += 1;
  return store.upsertAccount(db, { connectionId: null, companyId: type === 'card' ? 'max' : 'hapoalim', type, accountNumber: `x${accN}`, balance: null, now: NOW });
}
const catOf = (id) => db.prepare('SELECT category, category_source FROM transactions WHERE id = ?').get(id);
const idsOf = (acc) => db.prepare('SELECT id FROM transactions WHERE account_id = ? ORDER BY id').all(acc).map((r) => r.id);

// ---- undo + similar -------------------------------------------------------------------------------

test('category change: single row by default; similar count; undo restores rows and the merchant rule', () => {
  const acc = account();
  const txns = Array.from({ length: 5 }, (_, i) => t({ date: `2026-10-0${i + 1}`, description: 'קפה הבית', amount: -2000 - i }));
  store.ingestTransactions(db, { accountId: acc, accountType: 'card', txns, windowStart: '2026-09-01', now: NOW });
  const ids = idsOf(acc);
  const before = ids.map(catOf);

  // single row
  const one = repo.patchTransaction(db, ids[0], { category: 'leisure' });
  assert.equal(one.affected, 0);
  assert.equal(catOf(ids[1]).category, before[1].category, 'other rows untouched without applyToSimilar');
  assert.ok(one.undoId);

  // how many would "apply to similar" change?
  const sim = repo.countSimilar(db, ids[0], 'leisure');
  assert.equal(sim.count, 4);
  assert.equal(sim.merchant, 'קפה הבית');

  // undo the single change
  assert.deepEqual(repo.undoChange(db, one.undoId), { restored: 1, ruleReverted: false });
  assert.deepEqual(catOf(ids[0]), before[0]);
  assert.equal(repo.undoChange(db, one.undoId), null, 'an undo id works once');

  // apply to all, then undo: rows AND the rule go back
  const all = repo.patchTransaction(db, ids[2], { category: 'leisure', applyToSimilar: true });
  assert.equal(all.affected, 4);
  assert.equal(db.prepare('SELECT category FROM rules WHERE merchant_key = ?').get(cats.normalizeDescription('קפה הבית'))?.category, 'leisure');
  const r = repo.undoChange(db, all.undoId);
  assert.deepEqual(r, { restored: 5, ruleReverted: true });
  ids.forEach((id, i) => assert.deepEqual(catOf(id), before[i], `row ${i} restored`));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rules WHERE merchant_key = ?').get(cats.normalizeDescription('קפה הבית')).n, 0, 'rule removed');
});

test('undo never overwrites a later edit and restores a previous rule', () => {
  const acc = account();
  const txns = Array.from({ length: 3 }, (_, i) => t({ date: `2026-10-1${i}`, description: 'מאפיית השכונה', amount: -1500 }));
  store.ingestTransactions(db, { accountId: acc, accountType: 'card', txns, windowStart: '2026-09-01', now: NOW });
  const ids = idsOf(acc);
  const first = repo.patchTransaction(db, ids[0], { category: 'restaurants', applyToSimilar: true });
  const second = repo.patchTransaction(db, ids[1], { category: 'shopping', applyToSimilar: true });
  // later single edit on row 2
  repo.patchTransaction(db, ids[2], { category: 'other' });
  const r = repo.undoChange(db, second.undoId);
  assert.equal(r.ruleReverted, true);
  assert.equal(catOf(ids[2]).category, 'other', 'the later edit survives');
  assert.equal(catOf(ids[1]).category, 'restaurants');
  assert.equal(db.prepare('SELECT category FROM rules WHERE merchant_key = ?').get(cats.normalizeDescription('מאפיית השכונה')).category, 'restaurants', 'previous rule back');
  assert.ok(first.undoId);
});

test('undo of an exclusion and unknown / foreign ids', () => {
  const acc = account();
  store.ingestTransactions(db, { accountId: acc, accountType: 'card', txns: [t({ date: '2026-10-20', description: 'KSP', amount: -50000 })], windowStart: '2026-09-01', now: NOW });
  const [id] = idsOf(acc);
  const ex = repo.patchTransaction(db, id, { excluded: true });
  assert.equal(db.prepare('SELECT excluded FROM transactions WHERE id = ?').get(id).excluded, 1);
  assert.equal(repo.undoChange({}, ex.undoId), null, 'another database cannot use the id');
  assert.equal(repo.undoChange(db, ex.undoId).restored, 1);
  assert.equal(db.prepare('SELECT excluded FROM transactions WHERE id = ?').get(id).excluded, 0);
  assert.equal(repo.undoChange(db, 'nope-nope-nope'), null);
});

// ---- spending drill-down nets to the headline ----------------------------------------------------

test('kind=spending lists purchases and refunds and its net equals the overview headline', () => {
  const card = account('card');
  const bank = account('bank');
  store.ingestTransactions(db, { accountId: card, accountType: 'card', windowStart: '2026-07-01', now: NOW, txns: [
    t({ date: '2026-08-03', description: 'ZARA', amount: -40000 }),
    t({ date: '2026-08-09', description: 'ZARA', amount: 19990 }), // refund
    t({ date: '2026-08-12', description: 'שופרסל דיל', amount: -30000 }),
  ] });
  store.ingestTransactions(db, { accountId: bank, accountType: 'bank', windowStart: '2026-07-01', now: NOW, txns: [
    t({ date: '2026-08-10', description: 'משכורת', amount: 1500000 }),
    t({ date: '2026-08-11', description: 'העברה בביט', amount: -10000 }),
    t({ date: '2026-08-15', description: 'ישראכרט', amount: -70000 }),
  ] });
  const ds = repo.loadDataset(db, '2026-11-13');
  const headline = analytics.computeSummary(ds, '2026-08').totals.expenses;
  const q = (kind) => repo.queryTransactions(db, { month: '2026-08', kind, sort: 'date', order: 'desc', limit: 500, offset: 0 });
  const sp = q('spending');
  assert.equal(sp.net.total, headline, 'the number clicked on is the number landed on');
  assert.equal(sp.net.offsets, 199.9);
  assert.equal(Math.round((sp.net.gross - sp.net.offsets) * 100) / 100, sp.net.total);
  assert.ok(sp.items.some((x) => x.amount > 0), 'the refund is in the list');
  assert.ok(!sp.items.some((x) => /ביט|ישראכרט|משכורת/.test(x.description)), 'transfers, card debit and salary are not spending');
  const inc = q('income');
  assert.equal(inc.net.total, analytics.computeSummary(ds, '2026-08').totals.income);
});

// ---- day groups in the transactions list ---------------------------------------------------------

test('transactions: day totals cover every matching row of the day, with the counted rule', () => {
  const card = account('card');
  store.ingestTransactions(db, { accountId: card, accountType: 'card', windowStart: '2026-07-01', now: NOW, txns: [
    t({ date: '2026-09-03', description: 'קפה א', amount: -1000 }),
    t({ date: '2026-09-03', description: 'קפה ב', amount: -2550 }),
    t({ date: '2026-09-03', description: 'החזר', amount: 500 }),
    t({ date: '2026-09-02', description: 'קפה ג', amount: -700 }),
  ] });
  const page = repo.queryTransactions(db, { month: '2026-09', sort: 'date', order: 'desc', limit: 2, offset: 0 });
  assert.equal(page.items.length, 2);
  const d3 = page.days.find((d) => d.date === '2026-09-03');
  assert.deepEqual(d3, { date: '2026-09-03', count: 3, sumOut: 35.5, sumIn: 5 }, 'the whole day, not just this page');
  assert.ok(!page.days.some((d) => d.date === '2026-09-02'), 'only the days on this page');
  assert.equal(page.sumNet, Math.round((page.sumIn - page.sumOut) * 100) / 100);
  const byAmount = repo.queryTransactions(db, { month: '2026-09', sort: 'amount', order: 'desc', limit: 50, offset: 0 });
  assert.equal(byAmount.days, undefined, 'no day groups when sorted by amount');
});

// ---- one price-change definition -----------------------------------------------------------------

test('recurring list and price trends report the same latest price change, with a date', () => {
  const card = account('card');
  // 12 monthly charges, price step in March (2nd charge at the new price in April)
  const amounts = [8990, 8990, 8990, 8990, 8990, 9890, 9890, 9890, 9890, 9890, 9890, 9890];
  const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  store.ingestTransactions(db, { accountId: card, accountType: 'card', windowStart: '2025-10-01', now: NOW,
    txns: months.map((m, i) => t({ date: `${m}-05`, description: 'פרטנר תקשורת', amount: -amounts[i] })) });
  const ds = repo.loadDataset(db, '2026-11-13');
  const rec = analytics.detectRecurring(ds).find((r) => /פרטנר/.test(r.description));
  assert.ok(rec, 'detected');
  assert.ok(rec.priceChange, 'a step before the last two charges is still found');
  assert.equal(rec.priceChange.date, '2026-04-05');
  assert.equal(rec.priceChange.pct, 10);
  const out = analytics.recurringOutput([rec])[0];
  assert.deepEqual([out.priceChange.from, out.priceChange.to, out.priceChange.date], [89.9, 98.9, '2026-04-05']);
  const p = prices.priceTrendsOutput(prices.computePriceTrends(ds));
  const pr = p.recurring.find((r) => /פרטנר/.test(r.description));
  assert.deepEqual(pr.latestChange && [pr.latestChange.from, pr.latestChange.to, pr.latestChange.date], [89.9, 98.9, '2026-04-05']);
  // outside the 12-month window: no "changed" claim on either screen
  const win = analytics.priceChangeWindow('2027-06-01');
  assert.equal(analytics.latestPriceChange(rec, win), null);
});

test('price trends with partial history: the explanation window comes from the data, not the calendar', () => {
  const rows = [];
  let id = 900000;
  for (const m of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
    for (const d of ['02', '09', '16', '23']) {
      rows.push({ id: id++, accountId: 1, accountType: 'card', date: `${m}-${d}`, processedDate: `${m}-${d}`, description: 'שופרסל', merchantKey: 'שופרסל',
        amount: -20000, instNumber: null, instTotal: null, status: 'completed', category: 'groceries', isCardPayment: false, excluded: false });
    }
  }
  const ds = analytics.buildDataset({ rows, accounts: [{ id: 1, type: 'card', name: 'x', balance: null }], today: '2026-11-13' });
  const p = prices.priceTrendsOutput(prices.computePriceTrends(ds));
  assert.equal(p.start, '2025-11', 'the calendar window still starts a year back');
  assert.equal(p.dataStart, '2026-05', 'but the data starts in May');
  assert.deepEqual(p.compare, { first: ['2026-05', '2026-07'], last: ['2026-08', '2026-10'] });
  assert.equal(p.merchants[0].enoughData, true, 'compared over the months that have data');
  const short = analytics.buildDataset({ rows: rows.filter((r) => r.date >= '2026-08'), accounts: [{ id: 1, type: 'card', name: 'x', balance: null }], today: '2026-11-13' });
  assert.equal(prices.priceTrendsOutput(prices.computePriceTrends(short)).compare, null, 'under 6 months: no comparison claimed');
});

test('search by amount: the box promises "description or amount"', () => {
  assert.deepEqual(repo.amountQuery('249'), [24900, 24999]);
  assert.deepEqual(repo.amountQuery('249.9'), [24990, 24990]);
  assert.deepEqual(repo.amountQuery('1,249.90 ₪'), [124990, 124990]);
  assert.deepEqual(repo.amountQuery('-12'), [1200, 1299]);
  for (const q of ['שופרסל', '12a', '1.234', '', '12,34']) assert.equal(repo.amountQuery(q), null, q);
  const acc = account('card');
  store.ingestTransactions(db, { accountId: acc, accountType: 'card', windowStart: '2026-09-01', now: NOW, txns: [t({ date: '2026-10-02', description: 'מוסך הצפון', amount: -24990 })] });
  const r = repo.queryTransactions(db, { q: '249.90', sort: 'date', order: 'desc', limit: 50, offset: 0 });
  assert.ok(r.items.some((x) => x.description === 'מוסך הצפון'));
});
