// Business owner mode maths (server/business.js): scopes, lenses, owner transfers, VAT, flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveScope, businessShare, splitAmount, lensRows, detectOwnerTransfers, vatInGross, vatPeriodOf,
  vatForPeriod, businessTotals, profitExVat, reallyYours, taxSetAside, exemptStatus, monthFlow, businessFlags,
  OWNER_TRANSFER,
} from '../business.js';
import { vatRate, exemptCeiling, allocationThreshold } from '../business-rates.js';

const accs = new Map([
  [1, { id: 1, scope: 'business', type: 'bank' }],
  [2, { id: 2, scope: 'private', type: 'bank' }],
  [3, { id: 3, scope: 'mixed', type: 'card' }],
]);
let nextId = 1;
const row = (o) => ({ id: nextId++, accountId: 1, accountType: 'bank', date: '2026-10-10', amount: -100_00,
  category: 'other', status: 'completed', excluded: false, description: 'x', merchantKey: 'x', ...o });

test('rates of 2026', () => {
  assert.equal(vatRate('2026-11-20'), 0.18);
  assert.equal(vatRate('2024-12-31'), 0.17);
  assert.equal(exemptCeiling(2026), 122833_00);
  assert.equal(exemptCeiling(2030), 122833_00, 'latest known year for later years');
  assert.equal(allocationThreshold('2026-03-01'), 10000_00);
  assert.equal(allocationThreshold('2026-06-01'), 5000_00);
});

test('effective scope: row > merchant rule > account; mixed account defaults to private', () => {
  assert.equal(effectiveScope({}, accs.get(1)), 'business');
  assert.equal(effectiveScope({}, accs.get(3)), 'private');
  assert.equal(effectiveScope({ ruleScope: 'business' }, accs.get(3)), 'business');
  assert.equal(effectiveScope({ ruleScope: 'business', scope: 'private' }, accs.get(1)), 'private');
  assert.equal(businessShare({ businessShare: 45 }, accs.get(1)), 45);
  assert.equal(businessShare({ businessShare: 45, scope: 'private' }, accs.get(1)), 0);
});

test('split parts always add up to the original amount', () => {
  for (const amount of [-1, -3, -999_99, 12345, 7]) {
    for (const pct of [0, 1, 33, 45, 50, 99, 100]) {
      const s = splitAmount(amount, pct);
      assert.equal(s.business + s.private, amount);
    }
  }
});

test('lenses: a car expense 45% business is split between business and private', () => {
  const car = row({ accountId: 3, accountType: 'card', amount: -1000_00, category: 'car', scope: 'business', businessShare: 45 });
  const b = lensRows([car], accs, 'business');
  const p = lensRows([car], accs, 'private');
  const a = lensRows([car], accs, 'all');
  assert.equal(b[0].amount, -450_00);
  assert.equal(p[0].amount, -550_00);
  assert.equal(a[0].amount, -1000_00);
  assert.equal(car.amount, -1000_00, 'input not mutated');
});

test('owner transfers: detected, neutral in every lens, counted once in all', () => {
  const out = row({ accountId: 1, amount: -5000_00, date: '2026-10-01', category: 'transfers' });
  const inn = row({ accountId: 2, amount: 5000_00, date: '2026-10-02', category: 'transfers' });
  const other = row({ accountId: 2, amount: 4000_00, date: '2026-10-20', category: 'salary' });
  const found = detectOwnerTransfers([out, inn, other], accs);
  assert.equal(found.get(out.id), 'owner_draw');
  assert.equal(found.get(inn.id), 'owner_draw');
  assert.equal(found.has(other.id), false);
  const tagged = [out, inn].map((r) => ({ ...r, transferKind: found.get(r.id) }));
  const biz = lensRows(tagged, accs, 'business');
  const priv = lensRows(tagged, accs, 'private');
  assert.deepEqual(biz.map((r) => r.id), [out.id], 'business sees only its own side');
  assert.deepEqual(priv.map((r) => r.id), [inn.id], 'private sees only its own side');
  for (const r of [...biz, ...priv, ...lensRows(tagged, accs, 'all')]) assert.equal(r.category, OWNER_TRANSFER);
  assert.equal(businessTotals(biz, '2026-10', '2026-10').ownerDraws, 5000_00);
  assert.equal(businessTotals(biz, '2026-10', '2026-10').expenses, 0, 'a draw is not a business expense');
});

test('absolute separation on random data: no leaks, and business + private = all', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const cats = ['groceries', 'car', 'salary', 'other', 'fees', 'transfers'];
  const rows = [];
  for (let i = 0; i < 600; i++) {
    const accountId = 1 + Math.floor(rnd() * 3);
    const r = row({
      accountId, accountType: accountId === 3 ? 'card' : 'bank',
      amount: Math.round((rnd() - 0.6) * 200000), category: cats[Math.floor(rnd() * cats.length)],
      date: `2026-${String(1 + Math.floor(rnd() * 10)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`,
    });
    const t = rnd();
    if (t < 0.2) r.scope = 'business'; else if (t < 0.3) r.scope = 'private';
    if (rnd() < 0.15) r.businessShare = Math.floor(rnd() * 101);
    if (rnd() < 0.1) r.ruleScope = rnd() < 0.5 ? 'business' : 'private';
    if (rnd() < 0.05) r.transferKind = 'owner_draw';
    rows.push(r);
  }
  const biz = lensRows(rows, accs, 'business');
  const priv = lensRows(rows, accs, 'private');
  const all = lensRows(rows, accs, 'all');
  const scopeOf = (r) => effectiveScope(r, accs.get(r.accountId));
  // No leaks: a business answer only holds rows whose scope is business (or the business side of a
  // transfer); a private answer only private ones (or the private part of a split business row).
  for (const r of biz) {
    const orig = rows.find((x) => x.id === r.id);
    assert.equal(r.transferKind ? r.lensSide : scopeOf(orig), 'business', `row ${r.id} leaked into business`);
  }
  for (const r of priv) {
    const orig = rows.find((x) => x.id === r.id);
    if (r.transferKind) assert.equal(r.lensSide, 'private');
    else assert.ok(scopeOf(orig) === 'private' || businessShare(orig, accs.get(orig.accountId)) < 100, `row ${r.id} leaked into private`);
  }
  // Union: per row, business + private = all (owner transfers sit on exactly one side).
  const sum = (list) => { const m = new Map(); for (const r of list) m.set(r.id, (m.get(r.id) || 0) + r.amount); return m; };
  const sb = sum(biz), sp = sum(priv), sa = sum(all);
  assert.equal(sa.size, rows.length);
  for (const [id, amount] of sa) assert.equal((sb.get(id) || 0) + (sp.get(id) || 0), amount, `row ${id}`);
});

test('VAT: periods, output minus input, exempt pays none, missing invoices above the threshold', () => {
  assert.deepEqual(vatPeriodOf('2026-10'), { first: '2026-10', last: '2026-10', due: '2026-11-15' });
  assert.deepEqual(vatPeriodOf('2026-10', 'bimonthly'), { first: '2026-09', last: '2026-10', due: '2026-11-15' });
  assert.deepEqual(vatPeriodOf('2026-09', 'bimonthly').first, '2026-09');
  assert.equal(vatInGross(118_00, '2026-10-01'), 18_00);
  const rows = [
    row({ amount: 11800_00, category: 'salary' }), // business income 10,000 + VAT 1,800
    row({ amount: -2360_00, category: 'communication' }), // VAT 360
    row({ amount: -500_00, category: 'insurance' }), // no VAT
    row({ amount: -11800_00, category: 'shopping' }), // 10,000 before VAT, no invoice mark
    row({ amount: -11800_00, category: 'shopping', invoice: true }),
  ];
  const biz = lensRows(rows, accs, 'business');
  const v = vatForPeriod(biz, { type: 'licensed', first: '2026-10', last: '2026-10' });
  assert.equal(v.output, 1800_00);
  assert.equal(v.input, 360_00 + 1800_00 + 1800_00);
  assert.equal(v.due, v.output - v.input);
  assert.deepEqual(v.missingInvoices, [rows[3].id]);
  assert.equal(vatForPeriod(biz, { type: 'exempt', first: '2026-10', last: '2026-10' }).due, 0);
  assert.equal(profitExVat(biz, '2026-10', '2026-10', 'licensed'), 10000_00 - (2000_00 + 500_00 + 10000_00 + 10000_00));
});

test('really yours, tax set-aside, exempt ceiling and flags', () => {
  assert.equal(reallyYours({ bankBalance: 68900_00, upcomingCards: 11500_00, vatDue: 9800_00, setAside: 6400_00 }), 41200_00);
  assert.equal(reallyYours({ bankBalance: 100, upcomingCards: 0, vatDue: -50, setAside: 0 }), 100, 'a VAT refund is not counted as cash');
  assert.equal(taxSetAside({ profitYtd: 100000_00, pct: 20, taxPaidYtd: 5000_00 }), 15000_00);
  assert.equal(taxSetAside({ profitYtd: -1, pct: 20, taxPaidYtd: 0 }), 0);
  const inc = [row({ amount: 110000_00, category: 'salary', date: '2026-05-01' })];
  const s = exemptStatus(inc, 2026);
  assert.ok(s.pct > 89 && s.pct < 90);
  const flags = businessFlags({ type: 'exempt', today: '2026-11-20', bizRows: inc });
  assert.equal(flags[0].id, 'exempt-near');
  const vatFlags = businessFlags({ type: 'licensed', today: '2026-11-10', bizRows: [], bankBalance: 1000_00, setAside: 0,
    vat: { due: 5000_00, periodDue: '2026-11-15', missingInvoices: [] } });
  assert.equal(vatFlags[0].id, 'vat-cash');
});

test('month flow: profit, draws, home spending', () => {
  const rows = [
    row({ accountId: 1, amount: 20000_00, category: 'salary' }),
    row({ accountId: 1, amount: -6000_00, category: 'other', transferKind: 'owner_draw' }),
    row({ accountId: 2, amount: 6000_00, category: 'other', transferKind: 'owner_draw' }),
    row({ accountId: 2, amount: -8000_00, category: 'groceries' }),
  ];
  const f = monthFlow({ bizRows: lensRows(rows, accs, 'business'), privRows: lensRows(rows, accs, 'private'), month: '2026-10', type: 'exempt' });
  assert.equal(f.profit, 20000_00);
  assert.equal(f.ownerDraws, 6000_00);
  assert.equal(f.homeSpending, 8000_00);
  assert.equal(f.homeFundedPct, 75);
});
