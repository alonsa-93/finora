// Absolute separation between the business and the private side, end to end through the HTTP API
// (docs/API.md, "Business mode"): on the demo data with random tags, every lens returns exactly what the one
// gate business.lensRows() says, business + private = all, and no screen of one side ever mentions a
// merchant that belongs only to the other side. Temp data dir, demo DB only, scraper stubbed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  isolateDataDir, installScraperStub, startTestServer, request, jsonHeaders, removeDataDir,
} from './security-helpers.js';

const DATA_DIR = isolateDataDir();
installScraperStub();

let srv; let port; let origin; let config; let business;
const get = (path) => request(port, 'GET', path, {});
const send = (method, path, body) => request(port, method, path, { body, headers: jsonHeaders(origin) });
const agorot = (ils) => Math.round(ils * 100);

async function allRows(lens) {
  const out = [];
  for (let offset = 0; ; offset += 500) {
    const r = await get(`/api/transactions?lens=${lens}&limit=500&offset=${offset}&sort=date&order=asc`);
    assert.equal(r.status, 200);
    out.push(...r.json.items);
    if (out.length >= r.json.total) return { items: out, sumIn: r.json.sumIn, sumOut: r.json.sumOut };
  }
}

before(async () => {
  srv = await startTestServer();
  ({ port, origin } = srv);
  config = await import('../config.js');
  business = await import('../business.js');
  (await import('../state.js')).activeDb();
});
after(async () => { config.setAuthToken(null); await srv.close(); removeDataDir(DATA_DIR); });

test('business mode off: the lens is ignored, nothing changes', async () => {
  const all = await allRows('all');
  const biz = await allRows('business');
  assert.equal(biz.items.length, all.items.length);
  assert.equal((await get('/api/business/overview')).status, 409);
});

test('separation end to end: lenses match lensRows(), the sides add up, no leaks on any screen', async () => {
  assert.equal((await send('PATCH', '/api/business', { enabled: true, type: 'licensed', vatPeriod: 'bimonthly' })).status, 200);

  // Random tags through the API: a row's side, a business share, an owner transfer, a merchant rule.
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const before = (await allRows('all')).items;
  for (let i = 0; i < 60; i++) {
    const t = before[Math.floor(rnd() * before.length)];
    const body = {};
    const x = rnd();
    if (x < 0.35) body.scope = 'business';
    else if (x < 0.6) body.scope = 'private';
    else if (x < 0.75) { body.scope = 'business'; body.businessShare = Math.floor(rnd() * 101); }
    else if (x < 0.85) body.transferKind = 'owner_draw';
    else { body.scope = rnd() < 0.5 ? 'business' : 'private'; body.applyToMerchant = true; }
    const r = await send('PATCH', `/api/transactions/${t.id}`, body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }

  // The reference: every row as stored, through the JS gate.
  const accounts = (await get('/api/accounts')).json;
  const byId = new Map(accounts.map((a) => [a.id, { id: a.id, scope: a.scope }]));
  const all = await allRows('all');
  const raw = all.items.map((t) => ({ id: t.id, accountId: t.accountId, amount: agorot(t.amount), scope: t.scope,
    ruleScope: t.ruleScope, businessShare: t.businessShare, transferKind: t.transferKind }));
  const sides = {};
  for (const lens of ['business', 'private']) {
    const want = new Map(business.lensRows(raw, byId, lens).map((r) => [r.id, r.amount]));
    const got = await allRows(lens);
    sides[lens] = got;
    assert.equal(got.items.length, want.size, `${lens}: row count`);
    for (const t of got.items) assert.equal(agorot(t.amount), want.get(t.id), `${lens}: row ${t.id}`);
  }
  assert.ok(sides.business.items.length > 50 && sides.private.items.length > 50, 'both sides have rows');
  // Per row business + private = all, so the totals add up to the agora.
  const sum = (k) => agorot(sides.business[k]) + agorot(sides.private[k]);
  assert.equal(sum('sumIn') - sum('sumOut'), agorot(all.sumIn) - agorot(all.sumOut));

  // Leaks: merchants that only one side has must never appear on the other side's screens.
  const descs = (items) => new Set(items.map((t) => t.description));
  const bizD = descs(sides.business.items);
  const privD = descs(sides.private.items);
  const onlyIn = (a, b) => [...a].filter((d) => d.length >= 5 && ![...b].some((o) => o.includes(d) || d.includes(o)));
  const privOnly = onlyIn(privD, bizD);
  const bizOnly = onlyIn(bizD, privD);
  assert.ok(privOnly.length > 5 && bizOnly.length > 3, 'there are side-only merchants to look for');

  // The check can fire: the combined export does mention both sides' own merchants.
  const allCsv = (await get('/api/export.csv?lens=all')).text;
  assert.ok(privOnly.some((d) => allCsv.includes(d)) && bizOnly.some((d) => allCsv.includes(d)));

  const month = new Date().toISOString().slice(0, 7);
  const screens = (lens) => [
    `/api/summary?lens=${lens}`, `/api/summary?lens=${lens}&period=y1`, `/api/position?lens=${lens}`,
    `/api/insights?lens=${lens}`, `/api/annual?lens=${lens}`, `/api/annual/insights?lens=${lens}`,
    `/api/recurring?lens=${lens}`, `/api/price-trends?lens=${lens}`, `/api/export.csv?lens=${lens}`,
    `/api/transactions?lens=${lens}&month=${month}`, `/api/transactions?lens=${lens}&kind=spending`,
  ];
  const questions = ['על מה הוצאתי הכי הרבה השנה', 'כמה הרווחתי בחצי השנה האחרונה', 'מה היתרה שלי', 'כמה הוצאתי החודש',
    'מה המנויים שלי'];
  for (const [lens, forbidden] of [['business', privOnly], ['private', bizOnly]]) {
    const texts = [];
    for (const path of screens(lens)) {
      const r = await get(path);
      assert.equal(r.status, 200, path);
      texts.push([path, r.text]);
    }
    for (const q of questions) {
      const r = await send('POST', `/api/chat?lens=${lens}`, { question: q });
      assert.equal(r.status, 200);
      texts.push([`chat ${q}`, r.text]);
    }
    if (lens === 'business') {
      for (const p of ['/api/business/overview', '/api/business/flow', '/api/business/export.csv']) {
        const r = await get(p);
        assert.equal(r.status, 200, p);
        texts.push([p, r.text]);
      }
    }
    for (const [where, text] of texts) {
      for (const d of forbidden) assert.ok(!text.includes(d), `${lens} screen ${where} mentions "${d}" of the other side`);
    }
  }

  // The accountant's export holds exactly the business rows.
  const csv = (await get('/api/business/export.csv')).text;
  assert.equal(csv.trim().split('\r\n').length - 1, sides.business.items.length);
});

test('business inputs are validated', async () => {
  const t = (await allRows('all')).items[0];
  for (const body of [{ scope: 'home' }, { businessShare: 101 }, { businessShare: 4.5 }, { transferKind: 'gift' }, { invoice: 'yes' }]) {
    assert.equal((await send('PATCH', `/api/transactions/${t.id}`, body)).status, 400, JSON.stringify(body));
  }
  for (const body of [{ type: 'llc' }, { vatPeriod: 'weekly' }, { setAsidePct: 90 }, { enabled: 'yes' }, {}]) {
    assert.equal((await send('PATCH', '/api/business', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await send('PATCH', `/api/accounts/${t.accountId}`, { scope: 'home' })).status, 400);
  for (const url of ['https://evil.com/spreadsheets/d/abc', 'http://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstu', 'x']) {
    assert.equal((await send('POST', '/api/connections', { companyId: 'gsheet', sheet: { url } })).status, 400, url);
  }
  assert.equal((await get('/api/transactions?lens=family')).status, 400);
});
