// The app was called MoneyCash before 1.1: its data folder moves to the new name once, never lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultDataDir } from '../config.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'finora-rename-'));

test('data folder: the old MoneyCash folder is moved to Finora, contents intact', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'MoneyCash'));
    writeFileSync(join(root, 'MoneyCash', 'data.bin'), 'x');
    assert.equal(defaultDataDir(root), join(root, 'Finora'));
    assert.equal(readFileSync(join(root, 'Finora', 'data.bin'), 'utf8'), 'x');
    assert.equal(existsSync(join(root, 'MoneyCash')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('data folder: an existing Finora folder wins and the old one is left alone', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'Finora'));
    mkdirSync(join(root, 'MoneyCash'));
    assert.equal(defaultDataDir(root), join(root, 'Finora'));
    assert.equal(existsSync(join(root, 'MoneyCash')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('data folder: a fresh install uses Finora', () => {
  const root = scratch();
  try {
    assert.equal(defaultDataDir(root), join(root, 'Finora'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
