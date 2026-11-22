import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapLoginForCodes, matchLoginResult } from '../login-wait.js';
import { translateScraperError, ERROR_MESSAGES } from '../errors.js';

const RESULTS = {
  SUCCESS: ['https://bank.test/home', /\/dashboard/],
  INVALID_PASSWORD: [async ({ value }) => value.includes('err=1')],
};

test('matchLoginResult follows the library rules and tolerates a query / hash on string URLs', async () => {
  assert.equal(await matchLoginResult(RESULTS, 'https://bank.test/HOME'), 'SUCCESS');
  assert.equal(await matchLoginResult(RESULTS, 'https://bank.test/home?x=1#y'), 'SUCCESS');
  assert.equal(await matchLoginResult(RESULTS, 'https://bank.test/a/dashboard'), 'SUCCESS');
  assert.equal(await matchLoginResult(RESULTS, 'https://bank.test/login?err=1'), 'INVALID_PASSWORD');
  assert.equal(await matchLoginResult(RESULTS, 'https://bank.test/auth'), null);
});

function fakeScraper(urls, postAction) {
  let i = 0;
  const page = { isClosed: () => false, evaluate: async () => urls[Math.min(i++, urls.length - 1)] };
  return { page, getLoginOptions: () => ({ postAction, possibleResults: RESULTS }) };
}

test('headless: a redirect timeout on a code-asking site becomes CODE_REQUIRED', async () => {
  const s = wrapLoginForCodes(fakeScraper([], async () => { throw new Error('waiting for redirect from https://x/auth'); }), { companyId: 'hapoalim' });
  await assert.rejects(s.getLoginOptions({}).postAction(), /CODE_REQUIRED/);
  // Other sites keep the library's own error.
  const o = wrapLoginForCodes(fakeScraper([], async () => { throw new Error('waiting for redirect from https://x/auth'); }), { companyId: 'max' });
  await assert.rejects(o.getLoginOptions({}).postAction(), /waiting for redirect/);
  assert.equal(translateScraperError('GENERIC', 'CODE_REQUIRED').code, 'CODE_REQUIRED');
  assert.equal(translateScraperError('GENERIC', 'CODE_REQUIRED').message, ERROR_MESSAGES.CODE_REQUIRED);
});

test('interactive: waits while the user types the code, until a login-result URL', async () => {
  let called = false;
  const s = wrapLoginForCodes(fakeScraper(['https://bank.test/auth', 'https://bank.test/auth', 'https://bank.test/home'], async () => { called = true; }),
    { companyId: 'hapoalim', interactive: true, pollMs: 5 });
  await s.getLoginOptions({}).postAction();
  assert.equal(called, false, 'the short library wait is replaced');
  const t = wrapLoginForCodes(fakeScraper(['https://bank.test/auth'], null), { companyId: 'hapoalim', interactive: true, waitMs: 30, pollMs: 5 });
  await assert.rejects(t.getLoginOptions({}).postAction(), /CODE_TIMEOUT/);
  assert.equal(translateScraperError('GENERIC', 'CODE_TIMEOUT').code, 'CODE_TIMEOUT');
  assert.equal(translateScraperError('GENERIC', 'Protocol error: Target closed').code, 'WINDOW_CLOSED');
});

test('sync worker forwards the visible-login flag and accepts only a per-connection profile', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../sync-worker.js', import.meta.url), 'utf8');
  assert.match(src, /interactive: interactive === true/);
  assert.match(src, /profileDir: safeProfileDir\(profileDir\)/);
  const { safeProfileDir, connectionProfileDir } = await import('../browser.js');
  assert.equal(safeProfileDir(connectionProfileDir(7)), connectionProfileDir(7));
  assert.equal(safeProfileDir(connectionProfileDir(7) + '\..\..\keys'), null);
  assert.equal(safeProfileDir('C:\Windows'), null);
  assert.equal(safeProfileDir(null), null);
});

test('pending card charges: chargedAmount 0 falls back to the shekel purchase amount', async () => {
  const { normalizeScrapedTxn } = await import('../sync.js');
  const base = { date: '2026-11-10T00:00:00.000Z', description: 'שופרסל', status: 'pending', chargedAmount: -0 };
  assert.equal(normalizeScrapedTxn({ ...base, originalAmount: -123.45, originalCurrency: 'ILS' }).amount, -12345);
  assert.equal(normalizeScrapedTxn({ ...base, originalAmount: -50, originalCurrency: '₪' }).amount, -5000);
  // Foreign: no shekel amount yet.
  const fx = normalizeScrapedTxn({ ...base, originalAmount: -20, originalCurrency: 'USD' });
  assert.equal(fx.amount, 0);
  assert.equal(fx.originalAmount, -2000);
  // Completed rows keep the charged amount as is.
  assert.equal(normalizeScrapedTxn({ ...base, status: 'completed', chargedAmount: -80, originalAmount: -100, originalCurrency: 'ILS' }).amount, -8000);
});
