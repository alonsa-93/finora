// App and sync lifecycle: no second full sync right after the sync on open, log rotation by the
// first line's time, the worker stops when the app goes away, and a relaunch ends the whole tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.FINORA_DATA_DIR ||= mkdtempSync(join(tmpdir(), 'mc-stab-'));
const { syncedSinceToday } = await import('../main.js');
const { firstLineTime } = await import('../log.js');
const here = dirname(fileURLToPath(import.meta.url));

function dbWith(times) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE connections (id INTEGER PRIMARY KEY, last_sync_at TEXT)');
  for (const t of times) db.prepare('INSERT INTO connections (last_sync_at) VALUES (?)').run(t);
  return db;
}

test('daily sync is skipped when every connection synced after today\'s time', () => {
  const now = new Date(2026, 10, 20, 16, 50);
  const after = new Date(2026, 10, 20, 16, 45).toISOString();
  const before = new Date(2026, 10, 20, 5, 0).toISOString();
  assert.equal(syncedSinceToday('06:00', dbWith([after, after]), now), true);
  assert.equal(syncedSinceToday('06:00', dbWith([after, before]), now), false);
  assert.equal(syncedSinceToday('06:00', dbWith([after, null]), now), false);
  assert.equal(syncedSinceToday('06:00', dbWith([]), now), false);
});

test('log age comes from the first line, not the file creation time', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'mc-log-')), 'finora.log');
  writeFileSync(f, '2026-11-19T10:00:00.000Z INFO x\n2026-11-20T10:00:00.000Z INFO y\n');
  assert.equal(firstLineTime(f, 0), Date.parse('2026-11-19T10:00:00.000Z'));
  writeFileSync(f, 'garbage');
  assert.equal(firstLineTime(f, 42), 42);
  assert.equal(firstLineTime(join(dirname(f), 'missing.log'), 7), 7);
});

test('the sync worker stops when the app process goes away', () => {
  const src = readFileSync(join(here, '..', 'sync-worker.js'), 'utf8');
  assert.match(src, /process\.on\('disconnect', orphaned\)/);
  assert.match(src, /controller\.abort\(\)/);
});

test('a relaunch hands off first; only a hung app is ended, with its whole tree', () => {
  const src = readFileSync(join(here, '..', 'index.js'), 'utf8');
  assert.ok(src.indexOf('await requestShow(') < src.indexOf("systemExe('taskkill.exe')"), 'hand-off before kill');
  assert.match(src, /taskkill\.exe'\), \['\/PID', String\(pid\), '\/T', '\/F'\]/);
});
