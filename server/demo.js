// Deterministic demo data: one bank account + two credit cards, 25 months ending today.
// Seeded PRNG, dates relative to today, so every insight type and UI state appears:
// salary, rent, standing orders, card debits on the bank, bank fees, Bit transfers, cash,
// subscriptions (Netflix price increase), instalments, foreign currency, a refund, a duplicate
// charge, an unusual charge, a new merchant + category spike this month, and pending rows.
// The two years of history feed the annual review and the price trends: a salary raise (and a
// bonus month), recurring price steps at different dates (insurance 8 months ago, mobile 5,
// Netflix last month; Spotify in the year before) and one decrease (Bezeq, 10 months ago), a
// supermarket whose average purchase drifts up with the same number of visits, restaurants that
// creep up, less fuel lately, and seasons (holiday shopping in September and April, summer
// flights / hotel / day camp in July and August).
import { tx, getSetting, setSetting } from './db.js';
import { upsertAccount, ingestTransactions } from './store.js';
import { monthOf, addMonths, daysInMonth, addDays, todayISO } from './dates.js';
import { toAgorot } from './money.js';

const DEMO_VERSION = 5;
const DEMO_MONTHS_BACK = 24;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateDemoData(today) {
  const rnd = mulberry32(20241113);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const amt = (a, b) => Math.round((a + rnd() * (b - a)) * 10) / 10; // to 10 agorot
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  let ident = 70000000;
  const nextId = () => String((ident += int(1, 97)));

  const curMonth = monthOf(today);
  const todayDay = Number(today.slice(8, 10));
  const firstMonth = addMonths(curMonth, -DEMO_MONTHS_BACK);
  const months = [];
  for (let m = firstMonth; m <= curMonth; m = addMonths(m, 1)) months.push(m);

  const d = (month, day) => `${month}-${String(Math.min(Math.max(1, day), daysInMonth(month))).padStart(2, '0')}`;
  const inPast = (date) => date <= today;
  // For the current month, keep special rows on or before today.
  const curDay = (day) => d(curMonth, Math.min(day, todayDay));

  const bank = [];
  const max = [];
  const isra = [];
  const maxCharge = (date) => d(addMonths(monthOf(date), 1), 10);
  const israCharge = (date) => d(addMonths(monthOf(date), 1), 2);

  const card = (list, chargeFn, date, description, ils, extra = {}) => {
    if (!inPast(date)) return;
    list.push({
      identifier: extra.status === 'pending' ? null : nextId(),
      date, processedDate: extra.processedDate || chargeFn(date), description, memo: extra.memo || null,
      amount: toAgorot(ils), originalAmount: toAgorot(extra.originalAmount ?? ils),
      originalCurrency: extra.originalCurrency || 'ILS', instNumber: extra.instNumber ?? null,
      instTotal: extra.instTotal ?? null, status: extra.status || 'completed', providerCategory: null,
    });
  };
  const bankRow = (date, description, ils, memo = null) => {
    if (!inPast(date)) return;
    bank.push({
      identifier: nextId(), date, processedDate: date, description, memo, amount: toAgorot(ils),
      originalAmount: toAgorot(ils), originalCurrency: 'ILS', instNumber: null, instTotal: null,
      status: 'completed', providerCategory: null,
    });
  };

  // The weekly supermarket run is its own merchant (שופרסל דיל, four visits every month); the rest
  // of the grocery shopping is spread over other shops.
  const GROCERIES = ['רמי לוי שיווק השקמה', 'יוחננוף', 'ויקטורי', 'AM:PM', 'שופרסל אקספרס'];
  const RESTAURANTS = ['ארומה תל אביב', 'קפה גרג', 'WOLT', 'תן ביס', 'מקדונלדס', 'קופיקס', 'שיפודי התקווה'];
  const FUEL = ['פז אפליקציה', 'סונול', 'דלק מוטורס', 'TEN'];
  const SHOPS = ['ZARA', 'H&M', 'מקס סטוק', 'פוקס', 'איקאה', 'טרמינל X'];

  months.forEach((m, mi) => {
    const isCur = m === curMonth;
    const dim = daysInMonth(m);
    const ago = months.length - 1 - mi;          // 0 = this month
    const cal = Number(m.slice(5, 7));            // calendar month, for the seasons
    // ---- Everyday card (Max) -----------------------------------------------------------------
    // Two months ago the family was abroad (see BOOKING.COM) -> far fewer groceries (categoryDrop).
    const nGroc = ago === 2 ? 1 : int(3, 4);
    for (let i = 0; i < nGroc; i++) card(max, maxCharge, d(m, int(1, dim)), pick(GROCERIES), -amt(85, 470));
    // Supermarket: same four visits a month; the average purchase creeps up (faster in the last year).
    const basket = ago > 12 ? 250 + (DEMO_MONTHS_BACK - ago) * 2 : 274 + (12 - ago) * 7;
    for (const day of [3, 10, 17, 24]) card(max, maxCharge, d(m, day + int(-1, 1)), 'שופרסל דיל', -Math.round(basket * (0.9 + rnd() * 0.2) * 10) / 10);
    // Restaurants: a couple more meals out every quarter of the last year.
    const nRest = int(5, 7) + (ago < 12 ? Math.floor((12 - ago) / 3) : 0);
    for (let i = 0; i < nRest; i++) card(max, maxCharge, d(m, int(1, dim)), pick(RESTAURANTS), -amt(28, 230));
    // Fuel: less driving in the last half year (the train instead).
    for (let i = 0; i < (ago <= 5 ? int(1, 2) : int(2, 3)); i++) card(max, maxCharge, d(m, int(1, dim)), pick(FUEL), -amt(210, 340));
    card(max, maxCharge, d(m, int(1, dim)), 'רב-קו טעינה', -pick([50, 100, 100, 150]));
    for (let i = 0; i < int(1, 3); i++) card(max, maxCharge, d(m, int(1, dim)), 'פנגו חניה', -amt(9, 46));
    if (rnd() < 0.6) card(max, maxCharge, d(m, int(1, dim)), 'כביש 6 חוצה ישראל', -amt(28, 74));
    for (let i = 0; i < int(1, 2); i++) card(max, maxCharge, d(m, int(1, dim)), 'סופר-פארם', -amt(45, 175));
    card(max, maxCharge, d(m, 3), 'צהרון גן חובה - עיריית ת"א', -1150);
    if (rnd() < 0.8) card(max, maxCharge, d(m, int(1, dim)), pick(SHOPS), -amt(79, 420));
    if (rnd() < 0.7) card(max, maxCharge, d(m, int(1, dim)), pick(['סינמה סיטי', 'יס פלאנט']), -amt(70, 125));

    // ---- Seasons ---------------------------------------------------------------------------------
    // (not in the current or the last month, so this month's insights stay the same all year round)
    if (ago >= 2) {
      if ((cal === 9 || cal === 4) && ago !== 2) {
        card(max, maxCharge, d(m, int(5, 12)), 'מגה בעיר', -amt(880, 1240));          // holiday shopping
        card(max, maxCharge, d(m, int(8, 16)), 'המשביר לצרכן', -amt(380, 690));       // holiday gifts
      }
      if (cal === 7) {
        card(max, maxCharge, d(m, int(2, 6)), 'ישראייר', -amt(3300, 3900));            // summer flights
        card(max, maxCharge, d(m, 1), 'קייטנת קיץ - עיריית ת"א', -1640);               // day camp
      }
      if (cal === 8) card(isra, israCharge, d(m, int(3, 9)), 'BOOKING.COM', -amt(1800, 2300), { originalAmount: -amt(450, 560), originalCurrency: 'EUR' });
    }

    // ---- Online / subscriptions card (Isracard) ----------------------------------------------
    const netflix = ago <= 1 ? -54.9 : -49.9;                 // +5 ILS last month
    card(isra, israCharge, d(m, 18), 'NETFLIX.COM', netflix);
    card(isra, israCharge, d(m, 5), 'SPOTIFY', ago <= 16 ? -23.9 : -19.9);          // +4 ILS, 16 months ago
    card(isra, israCharge, d(m, 22), 'APPLE.COM/BILL', -11.9);
    card(isra, israCharge, d(m, 1), 'הולמס פלייס', -249);
    card(isra, israCharge, d(m, 12), 'פרטנר תקשורת', ago <= 5 ? -99 : -89);          // mobile +10, 5 months ago
    card(isra, israCharge, d(m, 15), 'בזק בינלאומי', ago <= 10 ? -99 : -119);       // internet -20, 10 months ago
    if (rnd() < 0.5) card(isra, israCharge, d(m, int(1, dim)), 'עלי אקספרס', -amt(25, 90));

    // ---- Bank account (Hapoalim) --------------------------------------------------------------
    bankRow(d(m, 1), 'הוראת קבע - שכר דירה', -5200);
    // Salary: a raise a year ago and a smaller one three months ago; an annual bonus 7 and 19 months ago.
    const salary = ago <= 3 ? 19120 : ago <= 12 ? 18450 : 17300;
    const bonus = ago === 7 ? 7500 : ago === 19 ? 6000 : 0;
    bankRow(d(m, 10), 'משכורת - אלפא טכנולוגיות בע"מ', salary + bonus);
    bankRow(d(m, 15), 'הראל חברה לביטוח', ago <= 8 ? -204.9 : -186.4);              // insurance +18.5, 8 months ago
    bankRow(d(m, 1), 'דמי ניהול חשבון', -12.9);
    if (mi % 3 === 1) bankRow(d(m, 28), 'ריבית חובה', -amt(18, 42));
    if (mi % 2 === 0) {
      bankRow(d(m, 5), 'עיריית תל אביב - ארנונה', -742);
      bankRow(d(m, 22), 'חברת החשמל לישראל', -amt(390, 560));
      bankRow(d(m, 26), 'מי אביבים', -amt(140, 190));
    }
    if (mi % 2 === 1) bankRow(d(m, int(3, 25)), 'משיכת מזומן כספומט', -pick([300, 400, 500]));
    if (isCur) bankRow(curDay(4), 'עמלת העברה לחשבון אחר', -7.5);
  });

  // ---- Special scenarios ---------------------------------------------------------------------
  // Travel (lumpy, past months): a short trip two months ago
  card(max, maxCharge, d(addMonths(curMonth, -2), 6), 'אל על נתיבי אויר', -2860);
  card(isra, israCharge, d(addMonths(curMonth, -2), 9), 'BOOKING.COM', -1527.6, { originalAmount: -380, originalCurrency: 'EUR' });
  // Foreign currency this month
  card(isra, israCharge, curDay(6), 'AMAZON.COM', -241.12, { originalAmount: -64.99, originalCurrency: 'USD' });
  // Instalments: fridge 6 x 783.33 started 4 months ago; laptop 3 x 1,299 started last month
  for (let k = 1; k <= 6; k++) {
    const date = d(addMonths(curMonth, -4 + k - 1), 7);
    card(max, maxCharge, date, 'מחסני חשמל', -783.33, { originalAmount: -4699.98, instNumber: k, instTotal: 6 });
  }
  for (let k = 1; k <= 3; k++) {
    const date = d(addMonths(curMonth, -1 + k - 1), 20);
    card(isra, israCharge, date, 'KSP מחשבים', -1299, { originalAmount: -3897, instNumber: k, instTotal: 3 });
  }
  // Refund this month (purchase + refund)
  card(max, maxCharge, curDay(2), 'ZARA', -199.9);
  card(max, maxCharge, curDay(9), 'ZARA', 199.9);
  // Duplicate charge this month
  card(max, maxCharge, curDay(Math.max(1, todayDay - 1)), 'שיפודי התקווה', -186);
  card(max, maxCharge, curDay(Math.max(1, todayDay - 1)), 'שיפודי התקווה', -186);
  // Unusual single charge
  card(max, maxCharge, curDay(Math.max(1, todayDay - 2)), 'סופר-פארם', -1180);
  // Category spike + new merchant (leisure)
  card(max, maxCharge, curDay(3), 'זאפה תל אביב - הופעה', -680);
  card(max, maxCharge, curDay(8), 'לונה פארק תל אביב', -240);
  // Bit transfers
  bankRow(d(addMonths(curMonth, -2), 17), 'העברה ב-BIT לדנה כהן', -150);
  bankRow(d(addMonths(curMonth, -1), 23), 'BIT - העברה מיוסי לוי', 200);
  // Pending rows (last two days), charged on the next Max bill
  const nextMaxBill = d(addMonths(curMonth, 1), 10);
  card(max, maxCharge, addDays(today, -1) < `${curMonth}-01` ? today : addDays(today, -1), 'שופרסל דיל', -312.4, { status: 'pending', processedDate: nextMaxBill });
  card(max, maxCharge, today, 'WOLT', -96.5, { status: 'pending', processedDate: nextMaxBill });
  card(max, maxCharge, today, 'פז אפליקציה', -265, { status: 'pending', processedDate: nextMaxBill });

  // ---- Monthly card debits on the bank account ----------------------------------------------
  const debit = (list, desc) => {
    const byDate = new Map();
    for (const r of list) {
      if (r.status !== 'completed' || r.processedDate > today) continue;
      byDate.set(r.processedDate, (byDate.get(r.processedDate) || 0) + r.amount);
    }
    for (const [date, sum] of [...byDate.entries()].sort()) {
      if (date < `${firstMonth}-01`) continue;
      bankRow(date, desc, sum / 100);
    }
  };
  debit(max, 'מקס איט פיננסים');
  debit(isra, 'ישראכרט');

  return { bank, max, isra };
}

/**
 * The business of the demo (business mode): a separate business bank account with clients' payments,
 * business expenses, a VAT payment every two months and a monthly owner draw to the private account
 * (the private side gets the matching row). Its own PRNG, so the private demo stays exactly as it was.
 */
export function generateDemoBusiness(today) {
  const rnd = mulberry32(7700221);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const amt = (a, b) => Math.round((a + rnd() * (b - a)) * 10) / 10;
  let ident = 90000000;
  const curMonth = monthOf(today);
  const d = (month, day) => `${month}-${String(Math.min(Math.max(1, day), daysInMonth(month))).padStart(2, '0')}`;
  const biz = [];
  const priv = [];
  const row = (list, date, description, ils) => {
    if (date > today) return;
    list.push({ identifier: String((ident += int(1, 50))), date, processedDate: date, description, memo: null,
      amount: toAgorot(ils), originalAmount: toAgorot(ils), originalCurrency: 'ILS', instNumber: null, instTotal: null,
      status: 'completed', providerCategory: null });
  };
  const CLIENTS = ['תקבול מלקוח סטודיו אורן', 'תקבול מלקוח גלבוע הפקות', 'תקבול מלקוח מרכז הדר', 'תקבול מלקוח נוי דיגיטל'];
  for (let m = addMonths(curMonth, -DEMO_MONTHS_BACK); m <= curMonth; m = addMonths(m, 1)) {
    const n = int(2, 4);
    for (let i = 0; i < n; i++) row(biz, d(m, int(2, 27)), CLIENTS[int(0, CLIENTS.length - 1)], amt(3500, 14500));
    row(biz, d(m, 3), 'גוגל וורקספייס עסקי', -amt(88, 92));
    row(biz, d(m, 8), 'פייסבוק מודעות קידום', -amt(900, 3200));
    row(biz, d(m, 12), 'רואה חשבון לוי ושות', -1180);
    row(biz, d(m, 15), 'ביטוח לאומי עצמאים', -amt(1400, 1500));
    if (Number(m.slice(5, 7)) % 2 === 1) row(biz, d(m, 15), 'רשות המסים מע"מ דו חודשי', -amt(2800, 5200));
    if (int(0, 3) === 0) row(biz, d(m, int(5, 25)), 'ציוד משרדי אופיס דיפו', -amt(300, 2400));
    const draw = int(7, 10) * 1000;
    row(biz, d(m, 5), 'העברה לחשבון הפרטי', -draw);
    row(priv, d(m, 6), 'העברה מחשבון העסק', draw);
  }
  return { biz, priv };
}

const DEMO_CONNECTIONS = [
  { company: 'hapoalim', nickname: 'חשבון העו״ש (הדגמה)', account: '12-532-5521', type: 'bank', key: 'bank' },
  { company: 'max', nickname: 'מקס (הדגמה)', account: '1234', type: 'card', key: 'max' },
  { company: 'isracard', nickname: 'ישראכרט (הדגמה)', account: '8812', type: 'card', key: 'isra' },
  { company: 'leumi', nickname: 'חשבון העסק (הדגמה)', account: '10-800-4471', type: 'bank', key: 'biz' },
];

/** (Re)build demo.db for `today`. Wipes the demo DB only. */
export function buildDemoDb(db, today = todayISO()) {
  const data = generateDemoData(today);
  const business = generateDemoBusiness(today);
  data.bank = [...data.bank, ...business.priv];
  data.biz = business.biz;
  const syncedAt = new Date(`${today}T05:00:00Z`).toISOString();
  tx(db, () => {
    db.exec('DELETE FROM transactions; DELETE FROM accounts; DELETE FROM connections; DELETE FROM rules; DELETE FROM scope_rules;');
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('transactions','accounts','connections')");
  });
  const accountIds = {};
  for (const c of DEMO_CONNECTIONS) {
    const r = db.prepare(`INSERT INTO connections (company_id, nickname, cred_blob, created_at, last_sync_at, last_success_at, last_status)
      VALUES (?, ?, NULL, ?, ?, ?, 'ok')`).run(c.company, c.nickname, `${addDays(today, -400)}T08:00:00.000Z`, syncedAt, syncedAt);
    accountIds[c.key] = upsertAccount(db, {
      connectionId: Number(r.lastInsertRowid), companyId: c.company, type: c.type, accountNumber: c.account,
      balance: null, now: syncedAt,
    });
    ingestTransactions(db, { accountId: accountIds[c.key], accountType: c.type, txns: data[c.key], windowStart: '2000-01-01', now: syncedAt });
  }
  // Bank balance: deliberately below the upcoming card bills so the low-balance state is visible.
  const upcoming = [...data.max, ...data.isra]
    .filter((r) => r.status === 'pending' || r.processedDate > today)
    .reduce((s, r) => s - r.amount, 0);
  const balance = upcoming > 300000 ? Math.round(upcoming * 0.72 / 100) * 100 : 845000;
  db.prepare('UPDATE accounts SET balance = ? WHERE id = ?').run(balance, accountIds.bank);
  // Business mode in the demo: the business account, the Max card mixed (fuel 45% business), the Isracard and the current account private.
  db.prepare('UPDATE accounts SET balance = ?, scope = ? WHERE id = ?').run(4689000, 'business', accountIds.biz);
  db.prepare("UPDATE accounts SET scope = 'mixed' WHERE id = ?").run(accountIds.max);
  db.prepare(`UPDATE transactions SET scope = 'business', business_share = 45 WHERE account_id = ? AND category = 'fuel'`).run(accountIds.max);
  for (const k of ['business.enabled', 'business.type', 'business.vatPeriod', 'business.setAsidePct']) {
    if (getSetting(db, k) == null) setSetting(db, k, { 'business.enabled': '0', 'business.type': 'licensed', 'business.vatPeriod': 'bimonthly', 'business.setAsidePct': '20' }[k]);
  }
  setSetting(db, 'demoGeneratedFor', `${today}#${DEMO_VERSION}`);
}

export function ensureDemoFresh(db, today = todayISO()) {
  if (getSetting(db, 'demoGeneratedFor') !== `${today}#${DEMO_VERSION}`) buildDemoDb(db, today);
}
