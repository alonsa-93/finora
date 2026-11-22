// app-window.js: one MoneyCash at a time, and closing the window never cuts a sync short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileInUse, watchWindow, requestShow, watchShowRequests } from '../app-window.js';

function harness({ open, busy, grace = 1000 }) {
  let t = 0;
  const calls = [];
  const w = watchWindow({
    isOpen: () => open(), isBusy: () => busy(),
    onAllClosed: () => calls.push('closed'), onBusyClose: () => calls.push('busy'),
    startGraceMs: grace, setTimer: () => ({}), clearTimer: () => {}, now: () => t,
  });
  return { w, calls, at: (ms) => { t = ms; w.tick(); } };
}

test('window closed with nothing running: the app exits', () => {
  let open = true;
  const h = harness({ open: () => open, busy: () => false });
  h.at(100); assert.deepEqual(h.calls, []);
  open = false;
  h.at(200); assert.deepEqual(h.calls, ['closed']);
  h.at(300); assert.deepEqual(h.calls, ['closed'], 'only once');
});

test('window closed during a sync: the sync finishes first, then the app exits', () => {
  let open = true; let busy = true;
  const h = harness({ open: () => open, busy: () => busy });
  h.at(100);
  open = false;
  h.at(200); h.at(300);
  assert.deepEqual(h.calls, ['busy'], 'noted once, not exited');
  busy = false;
  h.at(400);
  assert.deepEqual(h.calls, ['busy', 'closed']);
});

test('reopened while the sync finishes: the app keeps running', () => {
  let open = false; const busy = true;
  const h = harness({ open: () => open, busy: () => busy, grace: 0 });
  h.at(100);
  open = true; h.w.reopened();
  h.at(200);
  assert.deepEqual(h.calls, ['busy']);
});

test('Edge still starting: not treated as closed during the grace period', () => {
  const h = harness({ open: () => false, busy: () => false, grace: 1000 });
  h.at(500); assert.deepEqual(h.calls, []);
  h.at(1500); assert.deepEqual(h.calls, ['closed']);
});

test('a second launch hands off to the running one', async () => {
  const run = mkdtempSync(join(tmpdir(), 'mc-run-'));
  let shown = 0;
  const stop = watchShowRequests(run, () => { shown += 1; }, { pollMs: 20 });
  assert.equal(await requestShow(run, { waitMs: 2000, pollMs: 20 }), true);
  stop();
  assert.equal(shown, 1);
  assert.deepEqual(readdirSync(run), []);
});

test('nobody answers: the hand-off reports false and cleans up', async () => {
  const run = mkdtempSync(join(tmpdir(), 'mc-run-'));
  assert.equal(await requestShow(run, { waitMs: 100, pollMs: 20 }), false);
  assert.deepEqual(readdirSync(run), []);
});

test('profileInUse: no lockfile or a stale one = not in use', () => {
  const d = mkdtempSync(join(tmpdir(), 'mc-prof-'));
  assert.equal(profileInUse(d), false);
  writeFileSync(join(d, 'lockfile'), '');
  assert.equal(profileInUse(d), false);
});
