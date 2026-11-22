// Desktop start-up guards: dev-mode detection (source checkout only), the clipboard rule and the
// Electron start-up guard. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('dev mode only from a source checkout, never from the local install', async () => {
  const { isSourceCheckout, devModeAllowed, INSTALL_MARKER } = await import('../devmode.js');
  const base = mkdtempSync(join(tmpdir(), 'mc-devmode-'));
  const checkout = join(base, 'src');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  assert.equal(isSourceCheckout(checkout, { env: {} }), true);
  assert.equal(devModeAllowed(true, checkout, { env: {} }), true);
  assert.equal(devModeAllowed(false, checkout, { env: {} }), false, 'still needs the opt-in');
  // the install: marker, or anywhere under %LOCALAPPDATA%\Programs
  const install = join(base, 'Programs', 'MoneyCash', 'app');
  mkdirSync(join(install, '.git'), { recursive: true });
  assert.equal(devModeAllowed(true, install, { env: { LOCALAPPDATA: base } }), false, 'under Programs');
  const marked = join(base, 'elsewhere');
  mkdirSync(join(marked, '.git'), { recursive: true });
  writeFileSync(join(marked, INSTALL_MARKER), '{}');
  assert.equal(devModeAllowed(true, marked, { env: {} }), false, 'install marker wins');
  const bare = join(base, 'bare');
  mkdirSync(bare);
  writeFileSync(join(bare, 'package.json'), JSON.stringify({ devDependencies: { electron: '1' } }));
  assert.equal(devModeAllowed(true, bare, { env: {} }), false, 'a copied package.json alone is not a checkout');
  assert.equal(isSourceCheckout(ROOT, { env: {} }), true, 'this repository is a checkout');
});

test('clipboard: only a short amount may be written', async () => {
  const { isCopyableAmount } = await import('../../electron/clipboard-rule.mjs');
  for (const ok of ['1234.50', '0.99', '1,234.50', '-12.00', '₪ 45.90', '45.90 ₪', '−3', '1000000']) assert.equal(isCopyableAmount(ok), true, ok);
  for (const bad of ['', 'abc', '12abc', 'https://x', '1.234', '12.345', '1'.repeat(65), '12\n34', '=1+1', null, 12, '12;rm', '$$12']) {
    assert.equal(isCopyableAmount(bad), false, String(bad));
  }
});

test('electron guard: exits on NODE_OPTIONS, ELECTRON_RUN_AS_NODE and --inspect / --remote-debugging', () => {
  const guard = join(ROOT, 'electron', 'guard.mjs');
  const clean = { ...process.env };
  delete clean.NODE_OPTIONS; delete clean.ELECTRON_RUN_AS_NODE;
  const run = (env, args = []) => spawnSync(process.execPath, [guard, ...args], { env, encoding: 'utf8', timeout: 10000 }).status;
  assert.equal(run(clean), 0, 'clean start passes');
  assert.equal(run({ ...clean, NODE_OPTIONS: '--no-warnings' }), 1, 'any NODE_OPTIONS');
  assert.equal(run({ ...clean, ELECTRON_RUN_AS_NODE: '1' }), 1);
  assert.equal(run(clean, ['--inspect=9229']), 1);
  assert.equal(run(clean, ['--remote-debugging-port=9222']), 1);
  // and it is the very first import of main.mjs
  const main = readFileSync(join(ROOT, 'electron', 'main.mjs'), 'utf8');
  assert.match(main.split('\n').find((l) => /^\s*import\b/.test(l)), /import\s+['"]\.\/guard\.mjs['"]/);
});
