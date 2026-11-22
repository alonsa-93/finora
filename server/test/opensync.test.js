// Sync on open: the decision rules (pure) and a headless server run with the scraper stubbed
// (temp data dir; no browser, no bank). Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  isolateDataDir, installScraperStub, startTestServer, request, jsonHeaders, waitForSyncIdle, removeDataDir,
} from './security-helpers.js';

const DATA_DIR = isolateDataDir();
installScraperStub();

let open; let srv; let port; let origin; let sync; let state;
const send = (method, path, body) => request(port, method, path, { body, headers: jsonHeaders(origin) });
const get = (path) => request(port, 'GET', path);

before(async () => {
  open = await import('../opensync.js');
  sync = await import('../sync.js');
  state = await import('../state.js');
  srv = await startTestServer();
  ({ port, origin } = srv);
});
after(async () => { await srv?.close(); removeDataDir(DATA_DIR); });

// ---- the rules ---------------------------------------------------------------------------------
const NOW = Date.parse('2026-11-14T08:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const decide = (o) => open.decideOpenSync({ enabled: true, syncing: false, now: NOW, ...o });

test('open sync: a fresh start with stale or never-synced connections syncs at once', () => {
  assert.deepEqual(decide({ connections: [{ id: 1, lastSyncAt: ago(600), paused: false }] }), { start: true, reason: 'stale', connectionIds: [1] });
  assert.equal(decide({ connections: [{ id: 1, lastSyncAt: null, paused: false }] }).start, true);
  // one connection fresh, another stale: the oldest decides
  assert.equal(decide({ connections: [{ id: 1, lastSyncAt: ago(5), paused: false }, { id: 2, lastSyncAt: ago(31), paused: false }] }).start, true);
});

test('open sync: a sync finished within 30 minutes -> nothing', () => {
  assert.equal(open.OPEN_SYNC_MIN_INTERVAL_MS, 30 * 60 * 1000);
  assert.deepEqual(decide({ connections: [{ id: 1, lastSyncAt: ago(29), paused: false }] }), { start: false, reason: 'recent' });
  assert.equal(decide({ connections: [{ id: 1, lastSyncAt: ago(30), paused: false }] }).start, true, 'exactly 30 minutes is stale');
});

test('open sync: a running sync, paused connections, demo / nothing connected, setting off', () => {
  const c = [{ id: 1, lastSyncAt: ago(600), paused: false }];
  assert.deepEqual(decide({ connections: c, syncing: true }), { start: false, reason: 'running' });
  assert.deepEqual(decide({ connections: [{ id: 1, lastSyncAt: ago(600), paused: true }] }), { start: false, reason: 'paused' });
  // a paused connection is left out; a fresh paused one does not count as "recent" for the others
  assert.deepEqual(decide({ connections: [{ id: 1, lastSyncAt: ago(1), paused: true }, { id: 2, lastSyncAt: ago(90), paused: false }] }),
    { start: true, reason: 'stale', connectionIds: [2] });
  assert.deepEqual(decide({ connections: [] }), { start: false, reason: 'no-connections' });
  assert.deepEqual(decide({ connections: c, enabled: false }), { start: false, reason: 'disabled' });
});

// ---- headless server, stubbed scraper ----------------------------------------------------------
test('open sync on the server: demo without connections is quiet; setting persisted; launch / resume / recent / paused', async () => {
  // demo mode, nothing connected: launch did nothing, and resume does nothing
  assert.equal(state.isDemoMode(), true);
  assert.equal(sync.isSyncing(), false);
  let r = await send('POST', '/api/sync/open', {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.started, r.json.reason], [false, 'no-connections']);
  assert.equal((await get('/api/status')).json.syncOnOpen, true, 'default on');

  // a real connection (credentials sealed as usual); its first sync is due
  let release = null;
  globalThis.__mcScrape = () => new Promise((resolve) => { release = () => resolve({ success: true, accounts: [] }); });
  const c = await send('POST', '/api/connections', { companyId: 'max', nickname: 'open-sync', credentials: { username: 'u', password: 'p' } });
  assert.equal(c.status, 201, c.text);
  const before = (globalThis.__mcScrapeCalls || []).length;
  r = await send('POST', '/api/sync/open', {});
  assert.deepEqual([r.json.started, r.json.reason], [true, 'stale']);
  assert.equal(r.json.status.running, true, 'the UI sees the running sync straight away');
  assert.deepEqual((await send('POST', '/api/sync/open', {})).json.reason, 'running');
  while (!release) await new Promise((res) => setTimeout(res, 10));
  release();
  await waitForSyncIdle(sync.isSyncing);
  globalThis.__mcScrape = async () => ({ success: true, accounts: [] });
  assert.equal((globalThis.__mcScrapeCalls || []).length - before, 1, 'one scrape');
  assert.deepEqual((await send('POST', '/api/sync/open', {})).json.reason, 'recent', 'just synced');

  // restart the server: launch skips a connection synced minutes ago...
  await srv.close();
  srv = await startTestServer();
  ({ port, origin } = srv);
  assert.equal(sync.isSyncing(), false);
  // ...and syncs it at launch once it is stale
  state.realDb().prepare('UPDATE connections SET last_sync_at = ?').run(new Date(Date.now() - 2 * 3600 * 1000).toISOString());
  await srv.close();
  srv = await startTestServer();
  ({ port, origin } = srv);
  assert.equal(sync.isSyncing(), true, 'launch started a sync without any request');
  await waitForSyncIdle(sync.isSyncing);
  const db = state.realDb();

  // paused after failed logins: never retried by an open sync (lockout rules stay in charge)
  db.prepare('UPDATE connections SET needs_credentials = 1, last_sync_at = ?').run(new Date(Date.now() - 2 * 3600 * 1000).toISOString());
  const calls = (globalThis.__mcScrapeCalls || []).length;
  assert.deepEqual((await send('POST', '/api/sync/open', {})).json.reason, 'paused');
  assert.equal((globalThis.__mcScrapeCalls || []).length, calls);
  db.prepare('UPDATE connections SET needs_credentials = 0').run();

  // the setting: off -> nothing; validated; persisted in status
  r = await send('PATCH', '/api/settings', { syncOnOpen: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.syncOnOpen, false);
  assert.deepEqual((await send('POST', '/api/sync/open', {})).json.reason, 'disabled');
  assert.equal((await send('PATCH', '/api/settings', { syncOnOpen: 'yes' })).status, 400);
  assert.equal((await send('PATCH', '/api/settings', {})).status, 400);
  r = await send('PATCH', '/api/settings', { syncOnOpen: true, autoSync: { enabled: false, time: '06:30' } });
  assert.deepEqual([r.json.syncOnOpen, r.json.autoSync.enabled, r.json.autoSync.time], [true, false, '06:30']);
});

test('annual endpoints answer and validate the end month', async () => {
  // Demo data can no longer be shown once a real account is connected.
  if (state.realDb().prepare('SELECT COUNT(*) n FROM connections').get().n > 0) {
    assert.equal((await send('POST', '/api/demo', { enabled: true })).status, 409);
    state.realDb().prepare('DELETE FROM connections').run();
  }
  assert.equal((await send('POST', '/api/demo', { enabled: true })).status, 200);
  for (const p of ['/api/annual', '/api/annual/insights', '/api/price-trends']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.equal((await get(`${p}?end=2099-01`)).status, 400, `${p} future end`);
    assert.equal((await get(`${p}?end=2026-13`)).status, 400, `${p} bad month`);
    assert.equal((await get(`${p}?end=2026-01&end=2026-02`)).status, 400, `${p} repeated`);
  }
  const a = (await get('/api/annual')).json;
  assert.equal(a.monthly.length, 12);
  assert.ok(a.previous, 'demo data has two years');
  const ins = (await get('/api/annual/insights')).json;
  assert.ok(ins.length >= 5);
  assert.ok(ins.every((i) => /^[א-ת]/.test(i.title)));
});
