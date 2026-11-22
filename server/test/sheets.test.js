// Google Sheets source (server/sheets.js): links, CSV, columns, amounts, dates, safe download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sheetCsvUrl, parseCsv, detectColumns, parseSheetAmount, parseSheetDate, sheetRows, fetchSheet, sheetRowKeys, SheetError,
} from '../sheets.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd';

test('links: edit, gid, published; anything else refused', () => {
  assert.equal(sheetCsvUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=12345`),
    `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=12345`);
  assert.equal(sheetCsvUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`),
    `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv`);
  assert.equal(sheetCsvUrl(`https://docs.google.com/spreadsheets/d/e/2PACX-${ID}/pubhtml?gid=7`),
    `https://docs.google.com/spreadsheets/d/e/2PACX-${ID}/pub?output=csv&gid=7`);
  for (const bad of ['http://docs.google.com/spreadsheets/d/' + ID, 'https://evil.com/spreadsheets/d/' + ID,
    'https://docs.google.com.evil.com/spreadsheets/d/' + ID, 'https://docs.google.com/document/d/' + ID, 'not a link', '',
    'https://user@docs.google.com@127.0.0.1/spreadsheets/d/' + ID]) {
    assert.throws(() => sheetCsvUrl(bad), (e) => e instanceof SheetError && e.code === 'BAD_LINK', bad);
  }
});

test('CSV with quotes, commas and new lines inside cells', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"two\nlines",3\n\n'),
    [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', '3']]);
});

test('amounts and dates in the usual sheet formats', () => {
  assert.equal(parseSheetAmount('₪1,234.50'), 123450);
  assert.equal(parseSheetAmount('-1234'), -123400);
  assert.equal(parseSheetAmount('(1,234)'), -123400);
  assert.equal(parseSheetAmount('1.234,50'), 123450);
  assert.equal(parseSheetAmount('250-'), -25000);
  assert.equal(parseSheetAmount('abc'), null);
  assert.equal(parseSheetAmount(''), null);
  assert.equal(parseSheetDate('31/12/2026'), '2026-12-31');
  assert.equal(parseSheetDate('1.3.26'), '2026-03-01');
  assert.equal(parseSheetDate('2026-02-30'), null);
  assert.equal(parseSheetDate('13/13/2026'), null);
});

test('Hebrew headers: separate income and expense columns, invoice and category', () => {
  const csv = 'תאריך,לקוח,הכנסה,הוצאה,קטגוריה,חשבונית\n01/10/2026,דני,"5,900",,,10234\n03/10/2026,פייסבוק,,"1,180",פרסום,\n04/10/2026,ריק,,,,\nלא תאריך,x,5,,,';
  const { rows, skipped, columns } = sheetRows(csv);
  assert.deepEqual(columns, { date: 0, description: 1, income: 2, expense: 3, category: 4, invoice: 5 });
  assert.equal(skipped, 2);
  assert.deepEqual(rows.map((r) => [r.date, r.description, r.amount, r.category, r.invoice]), [
    ['2026-10-01', 'דני', 590000, null, true],
    ['2026-10-03', 'פייסבוק', -118000, 'פרסום', false],
  ]);
});

test('one amount column: the sheet kind decides the sign', () => {
  const csv = 'date,description,amount\n2026-10-01,a,100\n2026-10-02,b,-40';
  assert.deepEqual(sheetRows(csv, { kind: 'signed' }).rows.map((r) => r.amount), [10000, -4000]);
  assert.deepEqual(sheetRows(csv, { kind: 'income' }).rows.map((r) => r.amount), [10000, 4000]);
  assert.deepEqual(sheetRows(csv, { kind: 'expense' }).rows.map((r) => r.amount), [-10000, -4000]);
  assert.throws(() => sheetRows('שם,טלפון\nא,1'), (e) => e.code === 'NO_COLUMNS');
  assert.deepEqual(detectColumns(['Date ', 'Total']), { date: 0, amount: 1 });
});

test('row keys are stable and tell repeated identical rows apart', () => {
  const rows = [{ date: '2026-10-01', amount: 100, description: 'A  b' }, { date: '2026-10-01', amount: 100, description: 'a b' }];
  const keys = sheetRowKeys(rows);
  assert.notEqual(keys[0], keys[1]);
  assert.deepEqual(sheetRowKeys(rows), keys);
});

const resp = (status, body = '', headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  arrayBuffer: async () => Buffer.from(body),
});

test('download: follows Google redirects only, detects private sheets and HTML', async () => {
  const link = `https://docs.google.com/spreadsheets/d/${ID}/edit`;
  const seen = [];
  const ok = async (url) => {
    seen.push(url);
    if (url.includes('docs.google.com')) return resp(307, '', { location: 'https://doc-0s-abc.googleusercontent.com/export/x' });
    return resp(200, 'date,amount\n2026-10-01,5', { 'content-type': 'text/csv' });
  };
  assert.equal(await fetchSheet(link, { fetchImpl: ok }), 'date,amount\n2026-10-01,5');
  assert.equal(seen.length, 2);

  const toEvil = async () => resp(302, '', { location: 'https://evil.example/steal' });
  await assert.rejects(fetchSheet(link, { fetchImpl: toEvil }), (e) => e.code === 'NOT_SHARED');
  const toLogin = async () => resp(302, '', { location: 'https://accounts.google.com/ServiceLogin?x' });
  await assert.rejects(fetchSheet(link, { fetchImpl: toLogin }), (e) => e.code === 'NOT_SHARED');
  const html = async () => resp(200, '<!DOCTYPE html><html>sign in</html>', { 'content-type': 'text/html' });
  await assert.rejects(fetchSheet(link, { fetchImpl: html }), (e) => e.code === 'NOT_SHARED');
  const big = async () => resp(200, 'x', { 'content-type': 'text/csv', 'content-length': String(6 * 1024 * 1024) });
  await assert.rejects(fetchSheet(link, { fetchImpl: big }), (e) => e.code === 'TOO_BIG');
  const gone = async () => resp(404);
  await assert.rejects(fetchSheet(link, { fetchImpl: gone }), (e) => e.code === 'NOT_FOUND');
  const down = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(fetchSheet(link, { fetchImpl: down }), (e) => e.code === 'NETWORK');
});
