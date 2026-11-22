// Parallel sync with a queue: connections run side by side (up to SYNC_CONCURRENCY), a sync
// request while one runs joins it instead of failing, a connection can be edited or removed unless it
// is the one being scraped, and light loading turns itself off for a company after a failure.
// Headless server, scraper stubbed (no browser, no bank). Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  isolateDataDir, installScraperStub, startTestServer, request, jsonHeaders, waitForSyncIdle, removeDataDir,
} from './security-helpers.js';

const DATA_DIR = isolateDataDir();
installScraperStub();

let srv; let port; let origin; let sync; let state; let db;
const send = (method, path, body) => request(port, method, path, { body, headers: jsonHeaders(origin) });
const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(); }
}

before(async () => {
  sync = await import('../sync.js');
  state = await import('../state.js');
  db = await import('../db.js');
  srv = await startTestServer();
  ({ port, origin } = srv);
});
after(async () => { await srv?.close(); removeDataDir(DATA_DIR); });

test('connections sync side by side; a request while running joins the queue; edit/remove of waiting ones', async () => {
  const pending = new Map(); // companyId -> release()
  globalThis.__mcScrape = (credentials) => new Promise((resolve) => {
    pending.set(credentials.username, () => resolve({ success: true, accounts: [] }));
  });
  const ids = [];
  for (const [companyId, user] of [['max', 'm'], ['visaCal', 'i'], ['leumi', 'a'], ['mizrahi', 'l']]) {
    const c = await send('POST', '/api/connections', { companyId, nickname: user, credentials: { username: user, password: 'p' } });
    assert.equal(c.status, 201, c.text);
    ids.push(c.json.id);
  }
  let r = await send('POST', '/api/sync', {});
  assert.equal(r.status, 202);
  await until(() => pending.size === sync.SYNC_CONCURRENCY);
  assert.equal(sync.SYNC_CONCURRENCY, 3);
  const status = () => sync.syncStatus().items;
  assert.deepEqual(status().map((i) => i.state), ['running', 'running', 'running', 'pending'], 'three at once, the fourth waits');

  // A second request does not fail: it joins, without duplicating what is already queued.
  r = await send('POST', '/api/sync', { connectionId: ids[3] });
  assert.equal(r.status, 202, r.text);
  assert.equal(status().length, 4);

  // The connection being scraped cannot be edited; a waiting one can, and can be removed from the queue.
  assert.equal((await send('PATCH', `/api/connections/${ids[0]}`, { nickname: 'x' })).status, 409);
  assert.equal((await send('PATCH', `/api/connections/${ids[3]}`, { nickname: 'renamed' })).status, 200);
  assert.equal((await request(port, 'DELETE', `/api/connections/${ids[3]}?deleteData=true`, { headers: jsonHeaders(origin) })).status, 204);
  assert.equal(status().length, 3, 'removed from the queue');

  // An interactive login cannot join a running sync.
  assert.equal((await send('POST', '/api/sync', { connectionId: ids[0], interactive: true })).status, 409);

  // Re-queue a finished connection while the others still run: it runs in the same sync.
  pending.get('m')();
  await until(() => status()[0].state === 'ok');
  r = await send('POST', '/api/sync', { connectionId: ids[0] });
  assert.equal(r.status, 202);
  await until(() => status().some((i) => i.connectionId === ids[0] && i.state === 'running'));
  for (const release of pending.values()) release();
  await waitForSyncIdle(sync.isSyncing);
  assert.ok(status().every((i) => i.state === 'ok'));
});

test('light loading turns off for a company after a failure that is not about the login details', async () => {
  const real = state.realDb();
  const maxId = real.prepare("SELECT id FROM connections WHERE company_id = 'max'").get().id;
  assert.equal(db.getSetting(real, 'liteOff:max'), null);
  globalThis.__mcScrape = async () => ({ success: false, errorType: 'INVALID_PASSWORD', errorMessage: 'bad' });
  await send('POST', '/api/sync', { connectionId: maxId });
  await waitForSyncIdle(sync.isSyncing);
  assert.equal(db.getSetting(real, 'liteOff:max'), null, 'a wrong password says nothing about the loading');

  real.prepare('UPDATE connections SET needs_credentials = 0, fail_streak = 0 WHERE id = ?').run(maxId);
  globalThis.__mcScrape = async () => ({ success: false, errorType: 'TIMEOUT', errorMessage: 'slow' });
  await send('POST', '/api/sync', { connectionId: maxId });
  await waitForSyncIdle(sync.isSyncing);
  assert.equal(db.getSetting(real, 'liteOff:max'), '1');
  globalThis.__mcScrape = async () => ({ success: true, accounts: [] });
});

test('light loading blocks images, fonts and trackers, never scripts or CSS of the site', async () => {
  const { LITE_BLOCKED_URLS } = await import('../browser.js');
  assert.ok(LITE_BLOCKED_URLS.includes('*.png') && LITE_BLOCKED_URLS.includes('*.woff2?*'));
  assert.ok(LITE_BLOCKED_URLS.some((u) => u.includes('google-analytics.com')));
  assert.ok(!LITE_BLOCKED_URLS.some((u) => /\.(js|css)\b/.test(u)));
});
