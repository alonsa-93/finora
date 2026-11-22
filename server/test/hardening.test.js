// Fixes from the security review: fail-closed start, bootstrap expiry, pid-reuse check, no %TEMP%
// sweep, path scrubbing, streamed 5 MB cap, Hebrew sheet errors, range clamp, clipboard rule, DOM
// attribute rules and the browser's proxy-free environment. Pure checks; no server is started.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isolateDataDir, installScraperStub, removeDataDir } from './security-helpers.js';

const DATA_DIR = isolateDataDir();
installScraperStub();
after(() => removeDataDir(DATA_DIR));

test('startServer refuses to run without an auth token (fail closed)', async () => {
  const { startServer } = await import('../main.js');
  await assert.rejects(startServer({ port: 0, openSync: false }), /authToken/);
  await assert.rejects(startServer({ port: 0, openSync: false, insecureNoAuthForTests: 'yes' }), /authToken/);
  const config = await import('../config.js');
  assert.equal(config.noAuthAllowed(), false);
  assert.equal(config.getAuthToken(), null);
});

test('bootstrap token: single use, burnt after 5 failures, void after the TTL', async () => {
  const s = await import('../session.js');
  const t0 = 1_000_000;
  let tok = s.armBootstrap(t0);
  assert.equal(s.consumeBootstrap(tok, t0 + s.BOOTSTRAP_TTL_MS), true, 'right at the limit');
  assert.equal(s.consumeBootstrap(tok, t0 + 1), false, 'single use');
  tok = s.armBootstrap(t0);
  assert.equal(s.consumeBootstrap(tok, t0 + s.BOOTSTRAP_TTL_MS + 1), false, 'expired');
  assert.equal(s.consumeBootstrap(tok, t0 + 1), false, 'stays void (no clock games)');
  tok = s.armBootstrap(t0);
  for (let i = 0; i < 5; i++) assert.equal(s.consumeBootstrap(`wrong${i}`, t0 + 1), false);
  assert.equal(s.consumeBootstrap(tok, t0 + 1), false, 'burnt after 5 wrong attempts');
  assert.equal(s.BOOTSTRAP_TTL_MS <= 5 * 60 * 1000, true);
});

test('app window: only our own server command line may be killed after pid reuse', async () => {
  const { isOurServerCommandLine } = await import('../app-window.js');
  const idx = 'C:\\Users\\u\\AppData\\Local\\Programs\\MoneyCash\\server\\index.js';
  assert.equal(isOurServerCommandLine(`"C:\\Program Files\\nodejs\\node.exe" "${idx}" --app-window`, idx), true);
  assert.equal(isOurServerCommandLine(`node.exe ${idx.toLowerCase().replace(/\\/g, '/')} --dev --app-window`, idx), true);
  for (const other of ['', null, 'node.exe C:\\other\\tool\\index.js --app-window', `node.exe "${idx}"`,
    `node.exe "${idx}" --app-windows`, `node.exe "${idx}x" --x--app-window`, 'node.exe server\\index.js --app-window']) {
    assert.equal(isOurServerCommandLine(other, idx), false, String(other));
  }
  assert.equal(isOurServerCommandLine(`node "${idx}" --app-window`, ''), false);
});

test('profile sweep removes only MoneyCash\'s own run\\scrape-* dirs, never %TEMP%\\puppeteer_dev_*', async () => {
  const { sweepScraperProfiles } = await import('../browser.js');
  const config = await import('../config.js');
  const foreign = join(tmpdir(), `puppeteer_dev_chrome_profile-mctest${randomBytes(4).toString('hex')}`);
  const ours = join(config.dataDir(), 'run', 'scrape-mctest');
  mkdirSync(foreign, { recursive: true });
  mkdirSync(ours, { recursive: true });
  const old = new Date(Date.now() - 3600 * 1000);
  utimesSync(foreign, old, old);
  utimesSync(ours, old, old);
  try {
    assert.equal(sweepScraperProfiles({ minAgeMs: 0 }), 1);
    assert.equal(existsSync(ours), false);
    assert.equal(existsSync(foreign), true, 'another tool\'s profile is left alone');
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

test('scrub() strips Windows paths (they carry the user name) and caps the length', async () => {
  const { scrub } = await import('../errors.js');
  const msg = 'Error at C:\\Users\\Dana Cohen\\AppData\\Local\\x.js:10:5 and "C:\\\\Users\\\\dana\\\\a.json" '
    + 'then \\\\fileserver\\home$\\dana\\f.txt, \\\\?\\D:\\data\\dana-files\\y, file:///C:/Users/dana/z.html, D:\\work\\dana\\q';
  const s = scrub(msg);
  for (const leak of ['Dana', 'Cohen', 'dana', 'fileserver', 'work', ':\\']) assert.ok(!s.includes(leak), `${leak} in ${s}`);
  assert.match(s, /^Error at <path>/);
  assert.ok(s.includes('then <path>'));
  assert.equal(scrub(`C:\\Users\\x ${'a'.repeat(5000)}`).length <= 500, true);
  assert.equal(scrub('timeout of 30000 ms exceeded at https://bank.example/login'), 'timeout of *** ms exceeded at https://bank.example/login');
});

test('sheets: an oversized body is aborted while streaming (no Content-Length)', async () => {
  const { fetchSheet } = await import('../sheets.js');
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024).fill(65);
  const body = new ReadableStream({
    pull(c) { pulled += 1; if (pulled > 50) c.close(); else c.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const fetchImpl = async () => ({ status: 200, ok: true, headers: new Headers({ 'content-type': 'text/csv' }), body });
  await assert.rejects(fetchSheet('https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz0123/edit', { fetchImpl }),
    (e) => e.code === 'TOO_BIG');
  assert.ok(pulled <= 7, `stopped after ~5 MB (pulled ${pulled} MB)`);
  assert.equal(cancelled, true);
  const small = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('date,amount\n')); c.close(); } });
  const ok = async () => ({ status: 200, ok: true, headers: new Headers({ 'content-type': 'text/csv' }), body: small });
  assert.equal(await fetchSheet('https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz0123/edit', { fetchImpl: ok }), 'date,amount\n');
});

test('sheets: users see the Hebrew text of a sheet error, not its code', async () => {
  const { sheetCsvUrl, SheetError, SHEET_ERRORS } = await import('../sheets.js');
  try { sheetCsvUrl('https://example.com/x'); assert.fail('should throw'); } catch (e) {
    assert.ok(e instanceof SheetError);
    assert.equal(e.he, SHEET_ERRORS.BAD_LINK);
  }
  const { readFileSync } = await import('node:fs');
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.doesNotMatch(src('app.js'), /instanceof SheetError \? e\.message/);
  assert.doesNotMatch(src('sync.js'), /instanceof SheetError \? e\.message/);
});

test('period: a custom range is clamped to 10 years', async () => {
  const { resolvePeriod } = await import('../period.js');
  const today = '2026-11-15';
  assert.deepEqual(resolvePeriod({ from: '0001-01-01' }, today), { kind: 'range', from: '2016-11-15', to: today });
  assert.deepEqual(resolvePeriod({ to: '2020-03-31' }, today), { kind: 'range', from: '2010-03-31', to: '2020-03-31' });
  assert.deepEqual(resolvePeriod({ from: '2024-01-01', to: '2024-06-30' }, today), { kind: 'range', from: '2024-01-01', to: '2024-06-30' });
});

test('clipboard: spaces only as a literal space (no tabs, newlines or other whitespace)', async () => {
  const { isCopyableAmount } = await import('../../electron/clipboard-rule.mjs');
  for (const ok of ['₪ 45.90', '45.90 ₪', '- 12.00', '1234.50']) assert.equal(isCopyableAmount(ok), true, ok);
  for (const bad of ['₪\n45.90', '45.90\n', '-\t12', '₪\u00A045.90', '45.90\r₪', '\u2028 1', '₪\v1']) {
    assert.equal(isCopyableAmount(bad), false, JSON.stringify(bad));
  }
});

test('dom: href / src stay inside the app', async () => {
  const { safeUrl } = await import('../../web/assets/js/dom.js');
  for (const ok of ['#main', '#/transactions?x=1', '/api/export.csv?from=2026-01-01', 'blob:http://127.0.0.1:4580/abc', 'icons.svg#x', 'a/b?c=d:e']) {
    assert.equal(safeUrl(ok), true, ok);
  }
  for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'JAVASCRIPT:x', 'data:text/html,x',
    'https://evil.example', '//evil.example/x', '/\\evil.example', '\\\\evil\\x', 'vbscript:x', '\u0001javascript:x']) {
    assert.equal(safeUrl(bad), false, JSON.stringify(bad));
  }
});

test('scrape browser environment has no proxy variables', async () => {
  const { launchOptions } = await import('../browser.js');
  const saved = {};
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy']) { saved[k] = process.env[k]; process.env[k] = 'http://127.0.0.1:9'; }
  try {
    const env = launchOptions('chrome.exe', 'x').env;
    for (const k of Object.keys(env)) assert.doesNotMatch(k, /^(https?|all|no)_proxy$/i, k);
    assert.ok(Object.keys(env).length > 0, 'the rest of the environment is kept');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
