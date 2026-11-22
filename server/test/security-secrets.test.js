// Security regression suite - secret handling and bank-lockout protection.
// Credentials are created through the real API (DPAPI-encrypted, Windows only) and then hunted for
// in every API response, the log file and the raw SQLite bytes. Sync runs against a stubbed
// israeli-bank-scrapers (no browser, no bank is contacted) to exercise error scrubbing and the
// retry-lockout logic exactly as the real sync code path uses it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  isolateDataDir, installScraperStub, startTestServer, request, jsonHeaders, waitForSyncIdle, removeDataDir,
} from './security-helpers.js';

const DATA_DIR = isolateDataDir();
installScraperStub();

const WIN = process.platform === 'win32';
const skip = WIN ? false : 'DPAPI is Windows-only';

const USER = 'mcUserSentinelQx';
const PASS = 'mcPassSentinel#Zq"\'\\w';
const SECRETS = [USER, PASS, 'mcUserSentinel', 'mcPassSentinel'];

let srv; let port; let origin; let state; let sync; let errors; let dpapi; let secrets;
const get = (path) => request(port, 'GET', path);
const send = (method, path, body) => request(port, method, path, { body, headers: jsonHeaders(origin) });
const connRow = (id) => state.realDb().prepare('SELECT * FROM connections WHERE id = ?').get(id);

before(async () => {
  srv = await startTestServer();
  ({ port, origin } = srv);
  state = await import('../state.js');
  sync = await import('../sync.js');
  errors = await import('../errors.js');
  dpapi = await import('../dpapi.js');
  secrets = await import('../secrets.js');
  // No scheduled / catch-up sync may interfere with the scrape-call counting below.
  assert.equal((await send('PATCH', '/api/settings', { autoSync: { enabled: false, time: '23:59' } })).status, 200);
});
after(async () => { await srv.close(); removeDataDir(DATA_DIR); });

function assertNoSecret(text, where) {
  for (const s of SECRETS) {
    assert.ok(!text.includes(s), `${where} contains secret ${JSON.stringify(s)}`);
    assert.ok(!text.includes(JSON.stringify(s).slice(1, -1)), `${where} contains JSON-escaped secret`);
  }
}

async function createConnection(nickname = 'sec') {
  const r = await send('POST', '/api/connections', { companyId: 'max', nickname, credentials: { username: `  ${USER}  `, password: PASS } });
  assert.equal(r.status, 201, r.text);
  return r;
}

async function runSync(id, behaviour) {
  globalThis.__mcScrape = behaviour;
  const before = (globalThis.__mcScrapeCalls || []).length;
  sync.startSync('real', id);
  await waitForSyncIdle(sync.isSyncing);
  return (globalThis.__mcScrapeCalls || []).length - before; // scraper invocations during this run
}

// ---- DPAPI ---------------------------------------------------------------------------------------

test('dpapi: round trip, ciphertext hides plaintext, tampered / truncated / foreign blobs are rejected', { skip }, async () => {
  const secret = { username: USER, password: PASS, hebrew: 'סיסמה' };
  const blob = await dpapi.protectJSON(secret);
  assert.match(blob, /^[A-Za-z0-9+/=]+$/);
  assertNoSecret(blob, 'blob');
  assertNoSecret(Buffer.from(blob, 'base64').toString('latin1'), 'decoded blob');
  assert.ok(!blob.includes(Buffer.from(JSON.stringify(secret)).toString('base64').slice(0, 16)), 'not plain base64');
  assert.deepEqual(await dpapi.unprotectJSON(blob), secret);
  assert.notEqual(await dpapi.protectJSON(secret), blob, 'randomised ciphertext');

  const raw = Buffer.from(blob, 'base64');
  const flip = (i) => { const b = Buffer.from(raw); b[i] ^= 0x01; return b.toString('base64'); };
  const tampered = [flip(Math.floor(raw.length / 2)), flip(raw.length - 1), flip(raw.length - 20),
    raw.subarray(0, raw.length - 8).toString('base64'), raw.subarray(0, 40).toString('base64'),
    Buffer.from('not a dpapi blob at all').toString('base64'), '', '!!!!', `${blob}'; Write-Output pwned; '`];
  for (const t of tampered) {
    await assert.rejects(dpapi.unprotectJSON(t), (e) => {
      assertNoSecret(String(e?.message), 'rejection message');
      return true;
    }, `tampered blob ${t.slice(0, 20)}…`);
  }
});

// ---- secrets never leave ------------------------------------------------------------------------

let connId;
test('secrets: credential values never appear in API responses (incl. errors)', { skip }, async () => {
  const created = await createConnection('נקי');
  connId = created.json.id;
  assertNoSecret(created.text, 'POST /api/connections response');
  assert.deepEqual(Object.keys(created.json).sort(),
    ['companyId', 'companyName', 'createdAt', 'id', 'lastError', 'lastStatus', 'lastSyncAt', 'needsCodeLogin', 'nickname', 'type']);

  // Stored blob is AES-GCM sealed and bound to its row; decrypts to exactly what was sent.
  const row = connRow(connId);
  assertNoSecret(row.cred_blob, 'cred_blob column');
  assert.ok(secrets.isSealedCredential(row.cred_blob), 'credentials use the v2 sealed format');
  const ids = { uuid: row.cred_uuid, companyId: row.company_id };
  assert.deepEqual(await secrets.openCredentials(row.cred_blob, ids), { username: USER, password: PASS });
  // Bound to the row: a different uuid (blob moved to another row) must not decrypt.
  assert.throws(() => secrets.openCredentials(row.cred_blob, { ...ids, uuid: '00000000-0000-4000-8000-000000000000' }));

  for (const p of ['/api/connections', '/api/status', '/api/accounts', '/api/sync/status', '/api/companies',
    '/api/transactions', '/api/summary', '/api/insights', '/api/recurring', '/api/export.csv']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assertNoSecret(r.text, p);
    assert.ok(!r.text.includes(row.cred_blob.slice(0, 24)), `${p} leaks the ciphertext`);
    assert.ok(!/cred_blob|credentials/.test(r.text), `${p} mentions credentials field`);
  }

  // Error paths: validation failures must not echo the submitted values.
  const badBodies = [
    { companyId: 'max', credentials: { username: USER, password: `${PASS}\u0001` } },
    { companyId: 'max', credentials: { username: USER, password: PASS, [USER]: PASS } },
    { companyId: 'max', credentials: { username: USER } },
    { companyId: USER, credentials: { username: USER, password: PASS } },
    { companyId: 'max', nickname: 5, credentials: { username: USER, password: PASS } },
  ];
  for (const b of badBodies) {
    const r = await send('POST', '/api/connections', b);
    assert.equal(r.status, 400);
    assertNoSecret(r.text, `error for ${JSON.stringify(Object.keys(b.credentials || {}))}`);
  }
  const r = await send('PATCH', `/api/connections/${connId}`, { credentials: { username: USER, password: `${PASS}${'x'.repeat(200)}` } });
  assert.equal(r.status, 400);
  assertNoSecret(r.text, 'PATCH error');
  const bigJson = await send('POST', '/api/connections', `{"companyId":"max","credentials":{"username":"${USER}","password":"${'p'.repeat(20000)}"}}`);
  assert.equal(bigJson.status, 413);
  assertNoSecret(bigJson.text, '413');
  const badJson = await send('POST', '/api/connections', `{"companyId":"max","credentials":{"username":"${USER}",`);
  assert.equal(badJson.status, 400);
  assertNoSecret(badJson.text, 'BAD_JSON');
});

test('secrets: scraper errors are scrubbed before reaching the log, lastError and sync status', { skip }, async () => {
  // Scraper echoes the credentials (and ids / e-mails) in its error text, as some sites do.
  const calls = await runSync(connId, async (creds) => ({
    success: false,
    errorType: 'GENERIC',
    errorMessage: `login form error: user=${creds.username} pass=${creds.password} typed "${creds.password}" into #pw `
      + `(${creds.username}) id 000000018 mail a.b@x.co\n  at Page.type (${creds.password})`,
  }));
  assert.equal(calls, 1);
  const lastCall = globalThis.__mcScrapeCalls.at(-1);
  assert.deepEqual(lastCall.credentials, { username: USER, password: PASS }, 'scraper got decrypted credentials');

  // A thrown error (crash inside the scraper) as well.
  await runSync(connId, async (creds) => { throw new Error(`boom ${creds.username}/${creds.password}`); });

  const logText = readFileSync(join(DATA_DIR, 'logs', 'finora.log'), 'utf8');
  assert.match(logText, /sync connection=\d+ company=max failed/, 'failure was logged');
  assertNoSecret(logText, 'log file');
  assert.ok(!logText.includes('000000018') && !logText.includes('a.b@x.co'), 'ids / e-mails scrubbed from log');
  for (const p of ['/api/connections', '/api/sync/status', '/api/status']) assertNoSecret((await get(p)).text, p);
  assertNoSecret(String(connRow(connId).last_error), 'last_error column');
});

test('secrets: no credential plaintext anywhere in the data dir (SQLite + WAL bytes, logs)', { skip }, async () => {
  // Checkpoint so the main DB file has everything; check WAL/SHM files too (before and after).
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p); else files.push(p);
    }
  };
  const scan = () => {
    files.length = 0;
    walk(DATA_DIR);
    assert.ok(files.some((f) => f.endsWith('real.db.enc')), 'real data is persisted as an encrypted snapshot');
    assert.ok(!files.some((f) => /real\.db(-wal|-shm)?$/.test(f)), 'no plaintext SQLite file on disk');
    for (const f of files) {
      const bytes = readFileSync(f);
      for (const s of SECRETS) {
        for (const enc of ['utf8', 'utf16le']) {
          assert.equal(bytes.indexOf(Buffer.from(s, enc)), -1, `${f} contains ${enc} "${s}"`);
        }
      }
    }
  };
  scan();
  state.realDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  scan();
});

test('secrets: JSON-escaped / URL-encoded echoes of a credential are scrubbed from the log too', { skip }, async () => {
  await runSync(connId, async (creds) => ({
    success: false,
    errorType: 'GENERIC',
    errorMessage: `form state ${JSON.stringify(creds)} url /login?u=${encodeURIComponent(creds.username)}&p=${encodeURIComponent(creds.password)}`,
  }));
  const logText = readFileSync(join(DATA_DIR, 'logs', 'finora.log'), 'utf8');
  for (const s of ['mcPassSentinel', 'mcUserSentinel']) assert.ok(!logText.includes(s), `log contains ${s}`);
  assertNoSecret(String(connRow(connId).last_error), 'last_error column');
});

test('secrets: scrub() handles secrets in every shape the scraper may echo them', () => {
  const secrets = [USER, PASS, '123456'];
  const msg = `user ${USER} pass ${PASS} card 123456 json {"username":"${USER}","password":"${PASS}"} `
    + `kv password=${PASS} userCode: ABCDEF id=000123456 mail first.last@bank.co.il\nsecond line`;
  const s = errors.scrub(msg, secrets);
  assertNoSecret(s, 'scrubbed text');
  assert.ok(!s.includes('123456') && !s.includes('first.last@bank.co.il') && !s.includes('ABCDEF'));
  assert.ok(!/[\r\n]/.test(s) && s.length <= 500);
  assert.equal(errors.scrub(`x${'a'.repeat(5000)}`).length <= 500, true);
  assert.equal(errors.scrub(undefined), '');
});

// ---- 8. retry lockout ---------------------------------------------------------------------------

const genericFail = async () => ({ success: false, errorType: 'GENERIC', errorMessage: 'unknown login result' });

test('lockout: after 3 consecutive failed logins the connection stops retrying until credentials are re-saved', { skip }, async () => {
  const id = (await createConnection('lockout')).json.id;
  for (let i = 1; i <= 2; i++) {
    assert.equal(await runSync(id, genericFail), 1, `attempt ${i} reaches the scraper`);
    assert.equal(connRow(id).fail_streak, i);
    assert.equal(connRow(id).needs_credentials, 0);
  }
  assert.equal(await runSync(id, genericFail), 1, 'attempt 3 reaches the scraper');
  assert.equal(connRow(id).fail_streak, 3);
  assert.equal(connRow(id).needs_credentials, 1, 'paused after 3 failures');
  assert.equal(connRow(id).last_error, errors.ERROR_MESSAGES.PAUSED_AFTER_FAILURES);

  // Paused: neither a direct sync, the API sync, nor an all-connections sync touches the scraper.
  assert.equal(await runSync(id, genericFail), 0, 'no 4th login attempt');
  globalThis.__mcScrape = genericFail;
  const before = globalThis.__mcScrapeCalls.length;
  assert.equal((await send('POST', '/api/sync', { connectionId: id })).status, 202);
  await waitForSyncIdle(sync.isSyncing);
  assert.equal(globalThis.__mcScrapeCalls.filter((c, i) => i >= before).length, 0, 'API sync does not retry');
  assert.equal(connRow(id).last_error, errors.ERROR_MESSAGES.PAUSED_AFTER_FAILURES, 'reason kept');
  const listed = (await get('/api/connections')).json.find((c) => c.id === id);
  assert.equal(listed.lastStatus, 'error');
  assert.equal(listed.lastError, errors.ERROR_MESSAGES.PAUSED_AFTER_FAILURES);

  // Nickname-only PATCH does not unblock.
  assert.equal((await send('PATCH', `/api/connections/${id}`, { nickname: 'renamed' })).status, 200);
  assert.equal(await runSync(id, genericFail), 0, 'nickname change does not resume');

  // Re-saving credentials resumes.
  const r = await send('PATCH', `/api/connections/${id}`, { credentials: { username: USER, password: PASS } });
  assert.equal(r.status, 200);
  assertNoSecret(r.text, 'PATCH response');
  assert.equal(connRow(id).needs_credentials, 0);
  assert.equal(connRow(id).fail_streak, 0);
  assert.equal(await runSync(id, async () => ({ success: true, accounts: [] })), 1, 'resumed after re-save');
  assert.equal(connRow(id).last_status, 'ok');
});

test('lockout: a confirmed login resets the failure streak', { skip }, async () => {
  const id = (await createConnection('streak-reset')).json.id;
  await runSync(id, genericFail);
  await runSync(id, genericFail);
  assert.equal(connRow(id).fail_streak, 2);
  // Logged in, then failed while downloading: not a login failure.
  await runSync(id, async (_c, emit) => { emit('LOGIN_SUCCESS'); return { success: false, errorType: 'GENERIC', errorMessage: 'x' }; });
  assert.equal(connRow(id).fail_streak, 0);
  assert.equal(connRow(id).needs_credentials, 0);
  assert.equal(await runSync(id, genericFail), 1);
  assert.equal(connRow(id).needs_credentials, 0, 'streak restarted from 0');
});

for (const [type, message] of [['ACCOUNT_BLOCKED', 'ACCOUNT_BLOCKED'], ['INVALID_PASSWORD', 'INVALID_PASSWORD'],
  ['GENERIC (message says blocked)', 'ACCOUNT_BLOCKED'], ['GENERIC (message says wrong password)', 'INVALID_PASSWORD']]) {
  test(`lockout: ${type} stops retrying immediately`, { skip }, async () => {
    const id = (await createConnection(type)).json.id;
    const fail = type.startsWith('GENERIC')
      ? async () => ({ success: false, errorType: 'GENERIC', errorMessage: message === 'ACCOUNT_BLOCKED' ? 'Account is blocked' : 'Invalid password' })
      : async () => ({ success: false, errorType: type, errorMessage: '' });
    assert.equal(await runSync(id, fail), 1);
    assert.equal(connRow(id).needs_credentials, 1, 'blocked after one attempt');
    assert.equal(connRow(id).last_error, errors.ERROR_MESSAGES[message]);
    assert.equal(await runSync(id, fail), 0, 'no second attempt');
    assert.equal(await runSync(id, fail), 0, 'still no attempt');
    assert.equal(connRow(id).last_error, errors.ERROR_MESSAGES[message], 'reason kept');
    // Only a credential re-save resumes.
    assert.equal((await send('PATCH', `/api/connections/${id}`, { credentials: { username: USER, password: PASS } })).status, 200);
    assert.equal(await runSync(id, async () => ({ success: true, accounts: [] })), 1);
  });
}

test('lockout: re-saving credentials while a sync runs is refused (409)', { skip }, async () => {
  const id = (await createConnection('busy')).json.id;
  let release;
  globalThis.__mcScrape = () => new Promise((resolve) => { release = () => resolve({ success: true, accounts: [] }); });
  sync.startSync('real', id);
  while (!release) await new Promise((r) => setTimeout(r, 10));
  const r = await send('PATCH', `/api/connections/${id}`, { credentials: { username: USER, password: PASS } });
  assert.equal(r.status, 409);
  assert.equal((await send('DELETE', `/api/connections/${id}`)).status, 409);
  release();
  await waitForSyncIdle(sync.isSyncing);
});

test('one-time code: CODE_REQUIRED pauses automatic syncs without counting toward the lockout', { skip }, async () => {
  const id = (await createConnection('code')).json.id;
  const askCode = async () => ({ success: false, errorType: 'GENERIC', errorMessage: 'CODE_REQUIRED' });
  assert.equal(await runSync(id, askCode), 1);
assert.equal(connRow(id).needs_code_login, 1);
  assert.equal(connRow(id).fail_streak, 0, 'not a bad password');
  assert.equal(connRow(id).needs_credentials, 0);
  assert.equal(connRow(id).last_error, errors.ERROR_MESSAGES.CODE_REQUIRED);
  // Automatic attempts would only send another SMS.
  assert.equal(await runSync(id, askCode), 0);
  const list = await send('GET', '/api/connections');
  assert.equal(list.json.find((c) => c.id === id).needsCodeLogin, true);
  // interactive needs a connection id and a boolean.
  assert.equal((await send('POST', '/api/sync', { interactive: true })).status, 400);
  assert.equal((await send('POST', '/api/sync', { connectionId: id, interactive: 'yes' })).status, 400);
  // The visible login: a closed window is not a failure streak either, and keeps the pause.
  globalThis.__mcScrape = async () => ({ success: false, errorType: 'GENERIC', errorMessage: 'Protocol error: Target closed' });
  let before = (globalThis.__mcScrapeCalls || []).length;
  sync.startSync('real', id, { interactive: true });
  await waitForSyncIdle(sync.isSyncing);
  assert.equal((globalThis.__mcScrapeCalls || []).length - before, 1);
  assert.equal(connRow(id).last_error, errors.ERROR_MESSAGES.WINDOW_CLOSED);
  assert.equal(connRow(id).fail_streak, 0);
  assert.equal(connRow(id).needs_code_login, 1);
  // Success clears the pause.
  globalThis.__mcScrape = async () => ({ success: true, accounts: [] });
  before = (globalThis.__mcScrapeCalls || []).length;
  assert.equal((await send('POST', '/api/sync', { connectionId: id, interactive: true })).status, 202);
  await waitForSyncIdle(sync.isSyncing);
  assert.equal((globalThis.__mcScrapeCalls || []).length - before, 1);
  assert.equal(connRow(id).needs_code_login, 0);
  assert.equal(await runSync(id, async () => ({ success: true, accounts: [] })), 1, 'automatic syncs resume');
});
