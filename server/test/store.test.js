// Tests for ingestion/dedupe, categorisation, scrubbing, demo determinism and DPAPI.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MONEYCASH_DATA_DIR = mkdtempSync(join(tmpdir(), 'moneycash-test-'));
process.env.MONEYCASH_QUIET = '1';

let db; let store; let cats; let errors; let demo; let sync;
before(async () => {
  const { openDb } = await import('../db.js');
  db = openDb('real');
  store = await import('../store.js');
  cats = await import('../categories.js');
  errors = await import('../errors.js');
  demo = await import('../demo.js');
  sync = await import('../sync.js');
});

const t = (o) => ({
  identifier: null, processedDate: o.date, memo: null, originalAmount: o.amount, originalCurrency: 'ILS',
  instNumber: null, instTotal: null, status: 'completed', providerCategory: null, ...o,
});
const NOW = '2026-11-13T08:00:00.000Z';

function newAccount(n) {
  return store.upsertAccount(db, { connectionId: null, companyId: 'max', type: 'card', accountNumber: `acc${n}`, balance: null, now: NOW });
}
const count = (acc) => db.prepare('SELECT COUNT(*) n FROM transactions WHERE account_id = ?').get(acc).n;

test('two identical same-day charges are both kept; re-sync does not duplicate', () => {
  const acc = newAccount(1);
  const batch = [t({ date: '2026-11-01', description: 'ארומה', amount: -1800 }), t({ date: '2026-11-01', description: 'ארומה', amount: -1800 })];
  assert.equal(store.ingestTransactions(db, { accountId: acc, accountType: 'card', txns: batch, windowStart: '2026-10-01', now: NOW }).inserted, 2);
  assert.equal(store.ingestTransactions(db, { accountId: acc, accountType: 'card', txns: batch, windowStart: '2026-10-01', now: NOW }).inserted, 0);
  assert.equal(count(acc), 2);
});

test('provider identifiers: instalments of one purchase are separate rows', () => {
  const acc = newAccount(2);
  const batch = [1, 2].map((n) => t({ identifier: 'V123', date: `2026-1${n - 1}-07`, description: 'KSP', amount: -50000, instNumber: n, instTotal: 3 }));
  store.ingestTransactions(db, { accountId: acc, accountType: 'card', txns: batch, windowStart: '2026-09-01', now: NOW });
  store.ingestTransactions(db, { accountId: acc, accountType: 'card', txns: batch, windowStart: '2026-09-01', now: NOW });
  assert.equal(count(acc), 2);
});

test('pending row is replaced by its completed version, keeping the user category', () => {
  const acc = newAccount(3);
  store.ingestTransactions(db, { accountId: acc, accountType: 'card', windowStart: '2026-11-01', now: NOW,
    txns: [t({ date: '2026-11-10', description: 'WOLT', amount: -9650, status: 'pending' })] });
  const p = db.prepare('SELECT id FROM transactions WHERE account_id = ?').get(acc);
  db.prepare("UPDATE transactions SET category = 'groceries', category_source = 'user' WHERE id = ?").run(p.id);
  const r = store.ingestTransactions(db, { accountId: acc, accountType: 'card', windowStart: '2026-11-01', now: NOW,
    txns: [t({ identifier: 'A1', date: '2026-11-10', processedDate: '2026-12-10', description: 'WOLT', amount: -9650 })] });
  assert.equal(r.inserted, 1);
  const rows = db.prepare('SELECT status, category, category_source FROM transactions WHERE account_id = ?').all(acc);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].category, 'groceries');
  assert.equal(rows[0].category_source, 'user');
});

test('still-pending rows are not counted as new and not duplicated', () => {
  const acc = newAccount(4);
  const p = [t({ date: '2026-11-11', description: 'פז', amount: -26500, status: 'pending' })];
  assert.equal(store.ingestTransactions(db, { accountId: acc, accountType: 'card', txns: p, windowStart: '2026-11-01', now: NOW }).inserted, 1);
  assert.equal(store.ingestTransactions(db, { accountId: acc, accountType: 'card', txns: p, windowStart: '2026-11-01', now: NOW }).inserted, 0);
  assert.equal(count(acc), 1);
});

test('categorisation priorities and card-payment detection', () => {
  const c = (description, amount, accountType = 'card', extra = {}) => cats.categorize({ description, amount, ...extra }, { accountType, rules: extra.rules || new Map() });
  assert.equal(c('ישראכרט', -500000, 'bank').category, 'card-payment');
  assert.equal(c('מקס איט פיננסים', -500000, 'bank').isCardPayment, true);
  assert.equal(c('כרטיסי אשראי לי', -500000, 'bank').category, 'card-payment');
  assert.equal(c('ישראכרט', -5000, 'card').category, 'other'); // only bank lines are card payments
  assert.equal(c('שופרסל דיל', -10000).category, 'groceries');
  assert.equal(c('NETFLIX.COM', -4990).category, 'subscriptions');
  assert.equal(c('פז אפליקציה', -20000).category, 'fuel');
  // Max's mixed "fuel, electricity and gas" category: the merchant decides; fuel stays fuel only.
  const mixed = { providerCategory: 'דלק, חשמל וגז' };
  assert.equal(c('חברת החשמל לישראל', -45000, 'card', mixed).category, 'bills');
  assert.equal(c('סונול רמת גן', -25000, 'card', mixed).category, 'fuel');
  assert.equal(c('תחנה כלשהי', -25000, 'card', mixed).category, 'fuel');
  assert.equal(c('פנגו', -1200, 'card', { providerCategory: 'רכב ותחבורה' }).category, 'car');
  assert.equal(c('פנגו', -1200, 'card', mixed).category, 'car');
  assert.equal(c('כביש 6 חוצה ישראל', -3500, 'card', mixed).category, 'car');
  assert.equal(c('רב קו', -5000).category, 'transport');
  assert.equal(c('יס פלאנט', -9000).category, 'leisure');
  assert.equal(c('משכורת חברה', 1500000, 'bank').category, 'salary');
  assert.equal(c('העברה ב-BIT', 20000, 'bank').category, 'transfers');
  assert.equal(c('עמלת העברה', -750, 'bank').category, 'fees');
  assert.equal(c('לקוח כלשהו', 30000, 'bank').category, 'salary'); // unknown money in => income
  assert.equal(c('XYZ', -1000, 'card', { providerCategory: 'מסעדות' }).source, 'provider');
  const rules = new Map([[cats.normalizeDescription('שופרסל דיל'), 'restaurants']]);
  assert.equal(c('שופרסל דיל', -10000, 'card', { rules }).category, 'restaurants');
  assert.equal(c('שופרסל דיל', -10000, 'card', { rules }).source, 'user');
});

test('scrub removes secrets, ids and emails from error text', () => {
  const s = errors.scrub('login failed for user 000000018 password=Hunter22 mail a.b@x.co secretValue', ['secretValue']);
  assert.ok(!s.includes('000000018'));
  assert.ok(!s.includes('Hunter22'));
  assert.ok(!s.includes('a.b@x.co'));
  assert.ok(!s.includes('secretValue'));
  assert.equal(errors.translateScraperError('INVALID_PASSWORD').code, 'INVALID_PASSWORD');
  assert.equal(errors.translateScraperError('GENERIC', 'Navigation timeout of 30000 ms exceeded').code, 'TIMEOUT');
});

test('scraper transaction normalisation: Israeli date, ILS charged amount, instalments', () => {
  const n = sync.normalizeScrapedTxn({ type: 'installments', date: '2026-10-31T22:00:00.000Z', processedDate: '2026-12-01T22:00:00.000Z',
    originalAmount: -64.99, originalCurrency: 'USD', chargedAmount: -241.12, description: ' AMAZON ', status: 'completed',
    installments: { number: 2, total: 3 }, identifier: 991 });
  assert.equal(n.date, '2026-11-01');
  assert.equal(n.processedDate, '2026-12-02');
  assert.equal(n.amount, -24112);
  assert.equal(n.originalAmount, -6499);
  assert.equal(n.originalCurrency, 'USD');
  assert.equal(n.instNumber, 2);
  assert.equal(n.identifier, '991');
  assert.equal(n.description, 'AMAZON');
});

test('demo generator is deterministic for a given day', () => {
  const a = demo.generateDemoData('2026-11-13');
  const b = demo.generateDemoData('2026-11-13');
  assert.deepEqual(a, b);
  assert.ok(a.bank.length > 50 && a.max.length > 200 && a.isra.length > 50);
  assert.ok(a.max.some((r) => r.status === 'pending'));
  assert.ok(a.isra.some((r) => r.originalCurrency === 'USD'));
  assert.ok([...a.max, ...a.isra, ...a.bank].every((r) => r.date <= '2026-11-13'));
});

test('DPAPI round trip (Windows only)', { skip: process.platform !== 'win32' }, async () => {
  const { protectJSON, unprotectJSON } = await import('../dpapi.js');
  const secret = { username: 'דוגמה', password: 'p"a$s`w\'0rd' };
  const blob = await protectJSON(secret);
  assert.ok(!blob.includes('w0rd'));
  assert.deepEqual(await unprotectJSON(blob), secret);
  await assert.rejects(unprotectJSON(`${blob.slice(0, 40)}AAAA${blob.slice(44)}`));
});
