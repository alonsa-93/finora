// Tests for שאלות (server/chat.js + POST /api/chat): the Hebrew parser, and on the demo data that every
// answer's amount equals what /api/transactions shows for the linked filter. Real server on a free port
// with a temp data dir (demo DB only; the scraper is stubbed, nothing leaves the computer).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  isolateDataDir, installScraperStub, startTestServer, request, jsonHeaders, removeDataDir,
} from './security-helpers.js';

const DATA_DIR = isolateDataDir();
installScraperStub();

let srv; let port; let origin; let chat; let dates;
const ask = (question, headers = {}) => request(port, 'POST', '/api/chat', { body: { question }, headers: { ...jsonHeaders(origin), ...headers } });
const get = (path) => request(port, 'GET', path);
const qs = (params) => new URLSearchParams(params).toString();

before(async () => {
  srv = await startTestServer();
  ({ port, origin } = srv);
  chat = await import('../chat.js');
  dates = await import('../dates.js');
  const state = await import('../state.js');
  assert.equal(state.isDemoMode(), true);
  state.activeDb();
});
after(async () => { await srv.close(); removeDataDir(DATA_DIR); });

// ---- parser (pure) ---------------------------------------------------------------------------------

const TODAY = '2026-11-14';
const parse = (q, merchants = []) => chat.parseQuestion(q, { today: TODAY, merchantExists: (c) => merchants.includes(c) });

test('parser: category + "3 החודשים האחרונים"', () => {
  const p = parse('כמה הוצאתי על סופר ב-3 החודשים האחרונים?');
  assert.equal(p.intent, 'spending');
  assert.equal(p.subject.category, 'groceries');
  assert.deepEqual([p.periods[0].from, p.periods[0].to], ['2026-09-01', '2026-11-14']);
});

test('parser: recurring, balances, income, net, insights, annual, upcoming, price changes', () => {
  assert.equal(parse('מה המנויים הקבועים שלי?').intent, 'recurring');
  assert.equal(parse('מה היתרה בעו"ש').intent, 'balances');
  assert.equal(parse('כמה הרווחתי בחצי השנה האחרונה').intent, 'income');
  assert.equal(parse('כמה נשאר לי החודש').intent, 'net');
  assert.equal(parse('מה כדאי לבדוק').intent, 'insights');
  assert.equal(parse('סיכום שנתי').intent, 'annual');
  assert.equal(parse('מה החיובים הצפויים').intent, 'upcoming');
  assert.equal(parse('מה התייקר בשנה האחרונה?').intent, 'price-changes');
  assert.equal(parse('על מה הוצאתי הכי הרבה השנה?').intent, 'categories');
  assert.equal(parse('מה ההוצאות הגדולות החודש?').intent, 'top-expenses');
  assert.equal(parse('איפה אני מוציא הכי הרבה כסף?').intent, 'merchants');
});

test('parser: "שכר דירה" is housing spending, not income; "מנויים" with a period is the category', () => {
  const rent = parse('כמה שילמתי על שכר דירה השנה');
  assert.equal(rent.intent, 'spending');
  assert.equal(rent.subject.category, 'housing');
  assert.equal(rent.periods[0].from, '2026-01-01');
  const subs = parse('כמה הוצאתי על מנויים ב-3 החודשים');
  assert.equal(subs.intent, 'spending');
  assert.equal(subs.subject.category, 'subscriptions');
});

test('parser: "דלק" is the fuel category, "רכבת" public transport', () => {
  assert.equal(parse('כמה הוצאתי על דלק החודש').subject.category, 'fuel');
  assert.equal(parse('כמה הוצאתי על רכבת החודש').subject.category, 'transport');
});

test('parser: "סופר פארם" is health, not groceries (longest phrase wins)', () => {
  assert.equal(parse('כמה הוצאתי בסופר-פארם').subject.category, 'health');
});

test('parser: periods - month names, last month, years, days, yesterday', () => {
  assert.equal(parse('כמה הוצאתי באוקטובר').periods[0].month, '2026-10');
  assert.equal(parse('כמה הוצאתי בדצמבר').periods[0].month, '2025-12');     // the most recent December
  assert.equal(parse('כמה הוצאתי בחודש שעבר').periods[0].month, '2026-10');
  assert.equal(parse('כמה הוצאתי בספטמבר 2025').periods[0].month, '2025-09');
  const y = parse('כמה הוצאתי בשנה שעברה').periods[0];
  assert.deepEqual([y.from, y.to], ['2025-01-01', '2025-12-31']);
  const d = parse('כמה הוצאתי ב-30 הימים האחרונים').periods[0];
  assert.deepEqual([d.from, d.to], ['2026-10-16', '2026-11-14']);
  assert.equal(parse('מה ההוצאות הגדולות אתמול').periods[0].from, '2026-11-13');
  assert.equal(parse('כמה הוצאתי בשלושה חודשים אחרונים').periods[0].from, '2026-09-01');
});

test('parser: comparisons; the running month is compared with the same days of the previous one', () => {
  const p = parse('כמה הוצאתי החודש לעומת החודש שעבר?');
  assert.equal(p.intent, 'compare');
  assert.deepEqual(p.periods.map((x) => x.month), ['2026-11', '2026-10']);
  const prev = chat.previousPeriod(p.periods[0], TODAY);
  assert.deepEqual([prev.from, prev.to], ['2026-10-01', '2026-10-14']);
  const m3 = chat.previousPeriod(parse('ב-3 החודשים האחרונים').periods[0], TODAY);
  assert.deepEqual([m3.from, m3.to], ['2026-06-01', '2026-08-31']);
  assert.notEqual(parse('כמה הוצאתי אתמול').intent, 'compare');           // "אתמול" contains "מול"
});

test('parser: merchant names, with a Hebrew prefix or a Hebrew spelling of an English name', () => {
  assert.equal(parse('כמה הוצאתי בשופרסל באוקטובר', ['שופרסל']).subject.merchant, 'שופרסל');
  assert.equal(parse('כמה שילמתי על נטפליקס השנה', ['netflix']).subject.merchant, 'netflix');
  const unknown = parse('כמה הוצאתי על פלאפלים');
  assert.equal(unknown.subject.merchant, null);
  assert.deepEqual(unknown.unknown, ['פלאפלים']);
});

test('money text is exact', () => {
  assert.equal(chat.fmtMoney(1234.5), '1,234.50 ₪');
  assert.equal(chat.fmtMoney(-54.9), '54.90 ₪');
  assert.equal(chat.fmtMoney(5200), '5,200 ₪');
  assert.equal(chat.fmtMoney(0.1 + 0.2), '0.30 ₪');
});

// ---- endpoint on the demo data -----------------------------------------------------------------------

/** The amount behind an answer must be what the linked transactions screen nets to. */
async function linkedNet(link) {
  const r = await get(`/api/transactions?${qs({ ...link.params, limit: '1' })}`);
  assert.equal(r.status, 200, JSON.stringify(link.params));
  return r.json;
}

test('POST /api/chat: category over 3 months quotes the exact net of the linked transactions', async () => {
  const r = await ask('כמה הוצאתי על סופר ב-3 החודשים האחרונים?');
  assert.equal(r.status, 200);
  const a = r.json;
  assert.equal(a.intent, 'spending');
  assert.equal(a.understood.category.id, 'groceries');
  const link = a.links.find((l) => l.section === 'transactions');
  assert.equal(link.params.category, 'groceries');
  assert.equal(link.params.kind, 'spending');
  const t = await linkedNet(link);
  const amounts = a.parts.filter((p) => typeof p === 'object').map((p) => p.amount);
  assert.equal(amounts[0], t.net.total);
  assert.ok(t.net.total > 0);
  assert.ok(a.text.includes(chat.fmtMoney(t.net.total)));
  assert.ok(a.text.includes(`${t.total} תנועות`));
});

test('POST /api/chat: a merchant in a month, and a comparison, match the transactions screen', async () => {
  const today = dates.todayISO();
  const prev = dates.addMonths(dates.monthOf(today), -1);
  const m = (await ask(`כמה הוצאתי בשופרסל ב${dates.hebMonth(prev)}`)).json;
  assert.equal(m.intent, 'spending');
  assert.equal(m.understood.merchant, 'שופרסל');
  const tm = await linkedNet(m.links[0]);
  assert.equal(m.parts.find((p) => typeof p === 'object').amount, tm.net.total);

  const c = (await ask('כמה הוצאתי על מסעדות החודש לעומת החודש שעבר?')).json;
  assert.equal(c.intent, 'compare');
  assert.equal(c.links.length, 2);
  const [ta, tb] = [await linkedNet(c.links[0]), await linkedNet(c.links[1])];
  const nums = c.parts.filter((p) => typeof p === 'object').map((p) => p.amount);
  assert.equal(nums[0], ta.net.total);
  assert.equal(nums[1], tb.net.total);
  assert.equal(Math.round(nums[2] * 100), Math.abs(Math.round(ta.net.total * 100) - Math.round(tb.net.total * 100)));
});

test('POST /api/chat: recurring answers list the same charges as /api/recurring', async () => {
  const a = (await ask('מה המנויים הקבועים שלי?')).json;
  const rec = (await get('/api/recurring')).json;
  assert.equal(a.intent, 'recurring');
  assert.ok(rec.length > 0);
  assert.ok(a.text.includes(`${rec.length} חיובים קבועים`));
  assert.equal(a.items[0].label, rec[0].description);
  assert.equal(a.items[0].amount, rec[0].amount);
  assert.deepEqual(a.items[0].link, { label: `התנועות של ${rec[0].description}`, section: 'transactions', params: { q: rec[0].description } });
});

test('POST /api/chat: top expenses, categories, balances, income and help', async () => {
  const top = (await ask('מה ההוצאות הגדולות החודש?')).json;
  assert.equal(top.intent, 'top-expenses');
  const amounts = top.items.map((i) => i.amount);
  assert.deepEqual(amounts, [...amounts].sort((x, y) => y - x));
  assert.match(top.items[0].link.params.ids, /^\d+$/);

  const cats = (await ask('על מה הוצאתי הכי הרבה השנה?')).json;
  assert.equal(cats.intent, 'categories');
  for (const it of cats.items.slice(0, 3)) assert.equal(it.amount, (await linkedNet(it.link)).net.total);

  const bal = (await ask('מה היתרה שלי?')).json;
  const accounts = (await get('/api/accounts')).json.filter((x) => x.type === 'bank' && x.balance != null);
  assert.equal(bal.intent, 'balances');
  assert.equal(bal.parts.find((p) => typeof p === 'object').amount, accounts.reduce((s, x) => s + x.balance, 0));

  const inc = (await ask('כמה הרווחתי בחצי השנה האחרונה')).json;
  assert.equal(inc.intent, 'income');
  assert.equal(inc.parts.find((p) => typeof p === 'object').amount, (await linkedNet(inc.links[0])).net.total);

  const help = (await ask('שלום')).json;
  assert.equal(help.intent, 'help');
  assert.ok(help.suggestions.length > 0);
});

test('POST /api/chat: every link targets a known screen with string params', async () => {
  for (const q of ['מה התייקר בשנה האחרונה?', 'מה כדאי לבדוק', 'סיכום שנתי', 'מה החיובים הצפויים', 'איפה אני מוציא הכי הרבה כסף?', 'כמה נשאר לי החודש']) {
    const a = (await ask(q)).json;
    const links = [...a.links, ...a.items.map((i) => i.link).filter(Boolean)];
    for (const l of links) {
      assert.ok(['transactions', 'recurring', 'annual', 'overview'].includes(l.section), `${q}: ${l.section}`);
      for (const v of Object.values(l.params)) assert.equal(typeof v, 'string');
      if (l.section === 'transactions') assert.equal((await linkedNet(l)).total >= 0, true);
    }
  }
});

test('POST /api/chat: input validation and the CSRF guard', async () => {
  assert.equal((await ask('')).status, 400);
  assert.equal((await ask('   ')).status, 400);
  assert.equal((await ask('א'.repeat(301))).status, 400);
  assert.equal((await request(port, 'POST', '/api/chat', { body: { question: 5 }, headers: jsonHeaders(origin) })).status, 400);
  assert.equal((await request(port, 'POST', '/api/chat', { body: { question: 'מה היתרה' }, headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await get('/api/chat')).status, 404);
  // SQL / LIKE metacharacters are only text
  const odd = await ask("כמה הוצאתי ב-%' OR 1=1 --");
  assert.equal(odd.status, 200);
});
