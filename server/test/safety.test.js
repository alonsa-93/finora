// Every upgrade keeps the user's connections: version backups, the empty-folder guard, the sandbox guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupOnVersionChange, hasUserData, listBackups, agentSandboxReason, BACKUP_DIR, VERSION_FILE } from '../safety.js';
import { defaultDataDir } from '../config.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'finora-safety-'));

/** A data folder like a real user's: key, database, a bank profile with a cache. */
function userFolder(dir) {
  mkdirSync(join(dir, 'keys'), { recursive: true });
  writeFileSync(join(dir, 'keys', 'dek.json'), '{"v":1}');
  writeFileSync(join(dir, 'real.db.enc'), 'DB');
  writeFileSync(join(dir, 'real.db.enc.1'), 'DB1');
  mkdirSync(join(dir, 'profiles', 'conn-1', 'Default', 'Cache'), { recursive: true });
  writeFileSync(join(dir, 'profiles', 'conn-1', 'Default', 'Cookies'), 'C');
  writeFileSync(join(dir, 'profiles', 'conn-1', 'Default', 'Cache', 'big'), 'x');
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', 'finora.log'), 'log');
}

test('upgrade: the first start of a new version backs up key, databases and bank profiles', () => {
  const dir = scratch();
  try {
    userFolder(dir);
    writeFileSync(join(dir, VERSION_FILE), JSON.stringify({ version: '1.1.0' }));
    const r = backupOnVersionChange(dir, '1.2.0', { now: new Date('2026-12-01T10:00:00Z') });
    assert.ok(r.backedUp, 'a backup was made');
    assert.equal(readFileSync(join(r.backedUp, 'keys', 'dek.json'), 'utf8'), '{"v":1}');
    assert.equal(readFileSync(join(r.backedUp, 'real.db.enc'), 'utf8'), 'DB');
    assert.equal(readFileSync(join(r.backedUp, 'real.db.enc.1'), 'utf8'), 'DB1');
    assert.equal(readFileSync(join(r.backedUp, 'profiles', 'conn-1', 'Default', 'Cookies'), 'utf8'), 'C');
    assert.equal(existsSync(join(r.backedUp, 'profiles', 'conn-1', 'Default', 'Cache')), false, 'browser cache skipped');
    assert.equal(existsSync(join(r.backedUp, 'logs')), false);
    assert.match(r.backedUp, /1\.1\.0-to-1\.2\.0$/);
    // the original is untouched
    assert.equal(readFileSync(join(dir, 'real.db.enc'), 'utf8'), 'DB');
    assert.equal(JSON.parse(readFileSync(join(dir, VERSION_FILE), 'utf8')).version, '1.2.0');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('upgrade: the same version again makes no new backup', () => {
  const dir = scratch();
  try {
    userFolder(dir);
    assert.ok(backupOnVersionChange(dir, '1.2.0').backedUp, 'data from before version marks is backed up too');
    assert.equal(backupOnVersionChange(dir, '1.2.0').backedUp, null);
    assert.equal(listBackups(dir).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('upgrade: a fresh install has nothing to back up', () => {
  const dir = scratch();
  try {
    assert.equal(backupOnVersionChange(dir, '1.2.0').backedUp, null);
    assert.equal(existsSync(join(dir, BACKUP_DIR)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('upgrade: only the newest 5 backups are kept', () => {
  const dir = scratch();
  try {
    userFolder(dir);
    for (let i = 0; i < 7; i++) {
      backupOnVersionChange(dir, `1.${i}.0`, { now: new Date(Date.UTC(2026, 0, 1 + i)) });
    }
    const left = listBackups(dir);
    assert.equal(left.length, 5);
    assert.match(left[0], /^2026-01-03/);
    assert.equal(readdirSync(join(dir, BACKUP_DIR)).length, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('data folder: an empty Finora folder never hides MoneyCash data; it is set aside, not deleted', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'Finora', 'logs'), { recursive: true });
    writeFileSync(join(root, 'Finora', 'logs', 'finora.log'), 'empty start');
    userFolder(join(root, 'MoneyCash'));
    assert.equal(defaultDataDir(root, { now: new Date('2026-12-01T10:00:00Z') }), join(root, 'Finora'));
    assert.ok(hasUserData(join(root, 'Finora')), 'the data is in Finora now');
    assert.equal(existsSync(join(root, 'MoneyCash')), false);
    const aside = readdirSync(root).find((n) => n.startsWith('Finora-empty-'));
    assert.ok(aside, 'the empty folder was kept');
    assert.equal(readFileSync(join(root, aside, 'logs', 'finora.log'), 'utf8'), 'empty start');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('data folder: Finora with data is never replaced, even if MoneyCash has data too', () => {
  const root = scratch();
  try {
    userFolder(join(root, 'Finora'));
    userFolder(join(root, 'MoneyCash'));
    writeFileSync(join(root, 'Finora', 'real.db.enc'), 'NEW');
    assert.equal(defaultDataDir(root), join(root, 'Finora'));
    assert.equal(readFileSync(join(root, 'Finora', 'real.db.enc'), 'utf8'), 'NEW');
    assert.ok(existsSync(join(root, 'MoneyCash')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sandbox: the real app refuses to start from an AI coding tool', () => {
  assert.equal(agentSandboxReason({ CLAUDECODE: '1' }), 'Claude Code');
  assert.equal(agentSandboxReason({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), 'Claude Code');
  assert.equal(agentSandboxReason({}), '');
});

test('sandbox: both entry points check it before touching the data folder', () => {
  const here = new URL('..', import.meta.url);
  const idx = readFileSync(new URL('index.js', here), 'utf8');
  assert.ok(idx.indexOf('agentSandboxReason()') < idx.indexOf("import('./config.js')"), 'index.js: before config/dataDir');
  const main = readFileSync(new URL('../electron/main.mjs', here), 'utf8');
  assert.ok(main.indexOf('agentSandboxReason()') > 0 && main.indexOf('agentSandboxReason()') < main.indexOf('defaultDataDir('),
    'main.mjs: before the data folder is chosen');
});
