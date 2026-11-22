// "שאלות": answers Hebrew questions about the user's own money, locally. No model, no network:
// the question is parsed into a fixed set of question types (an amount per category / merchant /
// period, a comparison, the biggest expenses, the categories, the merchants, income, net, balances,
// upcoming charges, recurring charges, price changes, insights, the annual review) and answered by
// the same functions the screens use (repo.queryTransactions, analytics, insights, annual).
// Every amount is exact (agorot), and every answer carries the /api/transactions filter behind it,
// so the linked transactions screen shows the same rows and the same total.
import * as repo from './repo.js';

// Business mode: every lookup the answer makes goes through the lens of the question (set for the
// duration of answerQuestion(), which is synchronous), so a business question never reads a private
// row and the other way round.
let LENS = 'all';
const queryTransactions = (db, f) => repo.queryTransactions(db, { ...f, lens: LENS });
const listAccounts = (db) => {
  const L = repo.lensFor(db, LENS);
  return repo.listAccounts(db).filter((a) => L === 'all' || (L === 'business' ? a.scope === 'business' : a.scope !== 'business'));
};
import { detectRecurring, recurringOutput, computeSummary } from './analytics.js';
import { computeInsights } from './insights.js';
import { computeAnnual, annualOutput } from './annual.js';
import { lastCompleteMonth } from './prices.js';
import { CATEGORIES, CATEGORY_BY_ID } from './categories.js';
import { monthOf, addMonths, addDays, daysInMonth, HEBREW_MONTHS, daysBetween } from './dates.js';

export const MAX_QUESTION = 300;

// ---- text ---------------------------------------------------------------------------------------

/** Lower-case, no niqqud / quotes / punctuation, single spaces. Digits are kept. */
export function normalizeQuestion(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[״"'`׳]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PFX = '(?:[ובלהמשכ]|וה|וב|ול|שה|שב|של|מה|כש|וכ|לה|בה)?';
/** A whole word or phrase, with an optional one-letter Hebrew prefix (ב / ל / ה / ו / ש / מ / כ). */
const wordRe = (phrase, { prefix = true } = {}) => new RegExp(`(?:^|\\s)${prefix ? PFX : ''}(${phrase})(?=\\s|$)`);

/** Blank out a matched span so later passes do not see it again. */
function cut(text, m) {
  return `${text.slice(0, m.index)}${' '.repeat(m[0].length)}${text.slice(m.index + m[0].length)}`;
}

const NUM_WORDS = {
  אחד: 1, אחת: 1, שני: 2, שניים: 2, שתי: 2, שתיים: 2, שלוש: 3, שלושה: 3, ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5,
  שש: 6, שישה: 6, שבע: 7, שבעה: 7, שמונה: 8, תשע: 9, תשעה: 9, עשר: 10, עשרה: 10,
};
const NUM = `\\d{1,3}|${Object.keys(NUM_WORDS).join('|')}`;
const toNum = (s) => (/^\d+$/.test(s) ? Number(s) : NUM_WORDS[s]);

// ---- money / dates in sentences -----------------------------------------------------------------

/** Exact amount for the text: "1,234.50 ₪", "54.90 ₪", "1,240 ₪". Uses the magnitude. */
export function fmtMoney(ils) {
  const v = Math.round(Math.abs(Number(ils) || 0) * 100) / 100;
  const whole = Number.isInteger(v);
  return `${v.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })} ₪`;
}
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const dmy = (date) => `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}.${date.slice(0, 4)}`;
const monthName = (m) => `${HEBREW_MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const isHebrew = (s) => /^[֐-׿]/.test(String(s).trim());
const be = (name) => (isHebrew(name) ? `ב${name}` : `ב-${name}`);
const toAg = (ils) => Math.round((Number(ils) || 0) * 100);

/** Answer builder: text parts are strings or { amount } (rendered as a number by the client). */
function sentence() {
  const parts = [];
  const api = {
    t(...s) { for (const x of s) if (x !== '' && x != null) parts.push(String(x)); return api; },
    m(ils) { parts.push({ amount: Math.round(Number(ils) * 100) / 100 }); return api; },
    parts,
  };
  return api;
}
const partsText = (parts) => parts.map((p) => (typeof p === 'string' ? p : fmtMoney(p.amount))).join('');

// ---- periods ------------------------------------------------------------------------------------

/**
 * A period: { from, to, month?, label, kind } where kind is 'month' | 'months' | 'days' | 'year' |
 * 'ytd' | 'day'. `to` never goes past today. `label` reads after a preposition-free slot:
 * "בנובמבר 2026", "ב-3 החודשים האחרונים (1.9.2026–14.11.2026)".
 */
function monthPeriod(m, today, label) {
  const last = `${m}-${String(daysInMonth(m)).padStart(2, '0')}`;
  return { kind: 'month', month: m, from: `${m}-01`, to: last < today ? last : today, label: label || `ב${monthName(m)}` };
}
function rangePeriod(from, to, kind, words) {
  return { kind, from, to, label: `${words} (${dmy(from)}–${dmy(to)})` };
}

const PERIOD_RULES = [
  // "3 החודשים האחרונים", "שלושה חודשים אחרונים", "חודשיים האחרונים", "ברבעון האחרון", "בחצי השנה האחרונה"
  {
    re: new RegExp(`(?:^|\\s)${PFX}(${NUM})\\s+(?:ה)?חודשים(?:\\s+(?:ה)?(?:אחרונים|האחרונים))?(?=\\s|$)`),
    make: (m, today) => nMonths(toNum(m[1]), today),
  },
  { re: wordRe('חודשיים(?:\\s+(?:ה)?אחרונים)?'), make: (m, today) => nMonths(2, today) },
  { re: wordRe('רבעון(?:\\s+(?:ה)?אחרון)?'), make: (m, today) => nMonths(3, today) },
  { re: wordRe('חצי\\s+(?:ה)?שנה(?:\\s+(?:ה)?אחרונה)?'), make: (m, today) => nMonths(6, today) },
  { re: wordRe('שנה\\s+(?:ה)?אחרונה|12\\s+(?:ה)?חודשים(?:\\s+(?:ה)?אחרונים)?'), make: (m, today) => nMonths(12, today) },
  // "30 הימים האחרונים", "השבוע", "בשבוע האחרון", "שבועיים"
  {
    re: new RegExp(`(?:^|\\s)${PFX}(${NUM})\\s+(?:ה)?ימים(?:\\s+(?:ה)?אחרונים)?(?=\\s|$)`),
    make: (m, today) => nDays(toNum(m[1]), today),
  },
  { re: wordRe('שבועיים(?:\\s+(?:ה)?אחרונים)?'), make: (m, today) => nDays(14, today) },
  { re: wordRe('שבוע(?:\\s+(?:ה)?אחרון)?|השבוע'), make: (m, today) => nDays(7, today) },
  // "החודש שעבר", "בחודש הקודם" before "החודש"
  { re: wordRe('(?:ה)?חודש\\s+(?:ש)?עבר|(?:ה)?חודש\\s+(?:ה)?קודם'), make: (m, today) => monthPeriod(addMonths(monthOf(today), -1), today) },
  { re: wordRe('(?:ה)?חודש(?:\\s+(?:ה)?(?:זה|נוכחי))?'), make: (m, today) => monthPeriod(monthOf(today), today, `החודש (${monthName(monthOf(today))})`) },
  // "שנה שעברה", "השנה הקודמת", "השנה", "מתחילת השנה"
  {
    re: wordRe('(?:ה)?שנה\\s+(?:ש)?עברה|(?:ה)?שנה\\s+(?:ה)?קודמת'),
    make: (m, today) => yearPeriod(Number(today.slice(0, 4)) - 1, today),
  },
  {
    re: wordRe('(?:מ)?תחילת\\s+(?:ה)?שנה|(?:ה)?שנה(?:\\s+(?:ה)?(?:זו|זאת|נוכחית))?'),
    make: (m, today) => rangePeriod(`${today.slice(0, 4)}-01-01`, today, 'ytd', 'מתחילת השנה'),
  },
  { re: wordRe('היום'), make: (m, today) => ({ kind: 'day', from: today, to: today, label: `היום (${dmy(today)})` }), prefix: false },
  { re: wordRe('אתמול'), make: (m, today) => { const d = addDays(today, -1); return { kind: 'day', from: d, to: d, label: `אתמול (${dmy(d)})` }; } },
  // "באוקטובר", "בספטמבר 2025", "מאי 2026"
  {
    re: new RegExp(`(?:^|\\s)(?:חודש\\s+)?${PFX}(${HEBREW_MONTHS.join('|')})(?:\\s+(\\d{4}))?(?=\\s|$)`),
    make: (m, today) => {
      const mm = String(HEBREW_MONTHS.indexOf(m[1]) + 1).padStart(2, '0');
      let y = m[2] ? Number(m[2]) : Number(today.slice(0, 4));
      if (!m[2] && `${y}-${mm}` > monthOf(today)) y -= 1;  // "באוקטובר" = the most recent October
      const month = `${y}-${mm}`;
      return month > monthOf(today) ? null : monthPeriod(month, today);
    },
  },
  // "ב-2025", "בשנת 2025"
  {
    re: new RegExp(`(?:^|\\s)(?:${PFX}שנת\\s+|${PFX})(20\\d{2})(?=\\s|$)`),
    make: (m, today) => (Number(m[1]) > Number(today.slice(0, 4)) ? null : yearPeriod(Number(m[1]), today)),
  },
];

function nMonths(n, today) {
  if (!n || n < 1 || n > 60) return null;
  const cur = monthOf(today);
  if (n === 1) return monthPeriod(cur, today, `החודש (${monthName(cur)})`);
  return rangePeriod(`${addMonths(cur, -(n - 1))}-01`, today, 'months', n === 12 ? 'ב-12 החודשים האחרונים' : `ב-${n} החודשים האחרונים`);
}
function nDays(n, today) {
  if (!n || n < 1 || n > 400) return null;
  return rangePeriod(addDays(today, -(n - 1)), today, 'days', n === 7 ? 'בשבוע האחרון' : `ב-${n} הימים האחרונים`);
}
function yearPeriod(y, today) {
  const to = `${y}-12-31` < today ? `${y}-12-31` : today;
  return { kind: 'year', from: `${y}-01-01`, to, label: `בשנת ${y}${to !== `${y}-12-31` ? ` (עד ${dmy(to)})` : ''}` };
}

/** All periods in the text, in order of appearance, plus the text with them blanked out. */
export function extractPeriods(text, today) {
  let rest = text;
  const found = [];
  for (const rule of PERIOD_RULES) {
    for (;;) {
      const m = rule.re.exec(rest);
      if (!m) break;
      const p = rule.make(m, today);
      rest = cut(rest, m);
      if (p) found.push({ at: m.index, period: p });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return { periods: found.map((f) => f.period), rest };
}

/** The period before `p`, of the same length (a month: the previous month; this month so far: the same days of last month). */
export function previousPeriod(p, today) {
  if (p.kind === 'month') {
    const prev = addMonths(p.month, -1);
    if (p.month === monthOf(today)) {
      const day = Math.min(Number(today.slice(8, 10)), daysInMonth(prev));
      const to = `${prev}-${String(day).padStart(2, '0')}`;
      return { kind: 'range', from: `${prev}-01`, to, label: `באותם ימים ב${monthName(prev)} (1–${day})` };
    }
    return monthPeriod(prev, today);
  }
  if (p.kind === 'year' || p.kind === 'ytd') {
    const y = Number(p.from.slice(0, 4)) - 1;
    const to = `${y}${p.to.slice(4)}`;
    return { kind: 'range', from: `${y}-01-01`, to, label: p.kind === 'ytd' ? `באותה תקופה בשנת ${y}` : `בשנת ${y}` };
  }
  if (p.kind === 'months') {
    // whole months: the n months before the first one
    const n = (Number(monthOf(p.to).slice(0, 4)) * 12 + Number(p.to.slice(5, 7))) - (Number(p.from.slice(0, 4)) * 12 + Number(p.from.slice(5, 7))) + 1;
    const startMonth = addMonths(monthOf(p.from), -n);
    const endMonth = addMonths(monthOf(p.from), -1);
    const to = `${endMonth}-${String(daysInMonth(endMonth)).padStart(2, '0')}`;
    return rangePeriod(`${startMonth}-01`, to, 'range', `ב-${n} החודשים שלפני כן`);
  }
  const len = daysBetween(p.from, p.to) + 1;
  const to = addDays(p.from, -1);
  if (len === 1) return { kind: 'day', from: to, to, label: `ביום שלפני (${dmy(to)})` };
  return rangePeriod(addDays(to, -(len - 1)), to, 'range', `ב-${len} הימים שלפני כן`);
}

// ---- categories and merchants -------------------------------------------------------------------

// Everyday words for each category (plus the category's own name). Longer phrases win.
const CATEGORY_WORDS = {
  groceries: ['סופר', 'סופרמרקט', 'סופרים', 'מכולת', 'מכולות', 'קניות בסופר', 'קניות לבית', 'אוכל לבית', 'מזון', 'מצרכים'],
  restaurants: ['מסעדות', 'מסעדה', 'אוכל בחוץ', 'בתי קפה', 'בית קפה', 'קפה', 'משלוחים', 'משלוחי אוכל', 'אוכל'],
  fuel: ['דלק', 'תדלוק', 'תדלוקים', 'בנזין', 'סולר', 'תחנות דלק', 'תחנת דלק'],
  transport: ['תחבורה', 'תחבורה ציבורית', 'אוטובוס', 'אוטובוסים', 'רכבת', 'מוניות', 'מונית', 'רב קו'],
  car: ['רכב', 'האוטו', 'אוטו', 'חניה', 'חנייה', 'חניות', 'כביש 6', 'מוסך', 'טסט'],
  housing: ['שכירות', 'שכר דירה', 'משכנתא', 'משכנתה', 'דיור', 'ועד בית'],
  bills: ['חשבונות', 'חשבונות הבית', 'חשמל', 'מים', 'ארנונה', 'גז'],
  communication: ['תקשורת', 'סלולר', 'טלפון', 'פלאפון', 'אינטרנט', 'סלולרי'],
  health: ['בריאות', 'פארם', 'סופר פארם', 'תרופות', 'רופא', 'רופאים', 'קופת חולים'],
  kids: ['ילדים', 'הילדים', 'חינוך', 'גן', 'צהרון', 'חוגים', 'חוג', 'קייטנה'],
  shopping: ['קניות', 'בגדים', 'ביגוד', 'הלבשה', 'אופנה', 'נעליים'],
  leisure: ['פנאי', 'בילויים', 'בילוי', 'סרטים', 'קולנוע', 'הופעות', 'הופעה', 'כושר', 'חדר כושר'],
  travel: ['חופשות', 'חופשה', 'טיסות', 'טיסה', 'מלונות', 'מלון', 'חול', 'נסיעות לחול', 'תיירות'],
  subscriptions: ['מנויים', 'מנוי'],
  insurance: ['ביטוחים', 'ביטוח'],
  fees: ['עמלות', 'עמלה', 'ריבית', 'ריביות', 'דמי ניהול'],
  cash: ['מזומן', 'מזומנים', 'משיכות', 'כספומט'],
  other: ['אחר', 'שונות'],
};
const CATEGORY_PHRASES = (() => {
  const list = [];
  for (const c of CATEGORIES) {
    if (c.kind !== 'expense') continue;
    const words = new Set([normalizeQuestion(c.name), ...(CATEGORY_WORDS[c.id] || []).map(normalizeQuestion)]);
    for (const w of words) if (w) list.push({ phrase: w, category: c.id });
  }
  return list.sort((a, b) => b.phrase.length - a.phrase.length);
})();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The first expense category named in the text (longest phrase wins), and the text without it. */
export function extractCategory(text) {
  for (const { phrase, category } of CATEGORY_PHRASES) {
    const m = wordRe(escRe(phrase).replace(/ /g, '\\s+')).exec(text);
    if (m) return { category, rest: cut(text, m) };
  }
  return { category: null, rest: text };
}

// Hebrew spellings of merchants the banks print in English.
const MERCHANT_ALIASES = {
  נטפליקס: 'netflix', ספוטיפיי: 'spotify', אמזון: 'amazon', וולט: 'wolt', אפל: 'apple', גוגל: 'google',
  יוטיוב: 'youtube', דיסני: 'disney', אובר: 'uber', גט: 'gett', זארה: 'zara', בוקינג: 'booking', איירביאנבי: 'airbnb',
};

// Words that carry the question, not the subject.
const STOP = new Set(`
כמה מה מהו מהי מהם מהן איך איפה מתי למה האם אם יש היה היו היתה הייתה היו יהיה תהיה זה זו זאת אלה אלו
אני אנחנו אתה את הוא היא הם לי לנו לך שלי שלנו שלך עליי עלינו בשבילי בבקשה תגיד תגידי תראה תראי הראה הצג
הוצאתי הוצאנו הוצאת הוצאה הוצאות ההוצאות ההוצאה הוצא שילמתי שילמנו שילמת תשלום תשלומים התשלומים שולם
עלה עלו עולה עולים עלתה עלות העלות סך סכום הסכום סהכ בסהכ הכל הכול בסך כולל ביחד יחד בערך בדיוק בכלל
על של את עם בין לפי עד מאז אצל כל רק גם עוד יותר פחות הכי מאוד ממש
קנייה קניה רכישה רכישות עסקה עסקאות תנועה תנועות התנועות חיוב חיובים החיובים כסף שקל שקלים שח
בבית עסק עסק בית העסק חנות בחנות
`.split(/\s+/).filter(Boolean));

const meaningfulWords = (text) => normalizeQuestion(text).split(' ').filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));

/**
 * Words left after the period, the category and the question words: a merchant name to look for
 * in the transaction descriptions ("בשופרסל" -> "שופרסל", "נטפליקס" -> "netflix").
 */
export function merchantCandidates(rest) {
  const words = meaningfulWords(rest);
  if (!words.length) return [];
  const variants = (w) => {
    const out = [w];
    if (/^[ובלהמשכ]/.test(w) && w.length > 3) out.push(w.slice(1));
    if (/^(?:וה|וב|ול|שה|שב|של|מה|לה|בה)/.test(w) && w.length > 4) out.push(w.slice(2));
    return out.flatMap((x) => (MERCHANT_ALIASES[x] ? [MERCHANT_ALIASES[x], x] : [x]));
  };
  const cands = [];
  if (words.length > 1) cands.push(words.join(' '), ...variants(words[0]).map((v) => [v, ...words.slice(1)].join(' ')));
  for (const w of [...words].sort((a, b) => b.length - a.length)) cands.push(...variants(w));
  return [...new Set(cands)].filter((c) => c.length >= 2);
}

// ---- intents ------------------------------------------------------------------------------------

const INTENTS = [
  ['help', /^(?:עזרה|help|\?|מה אפשר לשאול|מה (?:אתה|את) (?:יודע|יודעת|יכול|יכולה)|איך (?:זה עובד|משתמשים))/],
  ['insights', /תובנות|מה כדאי (?:לבדוק|לדעת)|מה חריג|חריג|חשוד|כפול|כפולים|מה לבדוק|משהו מוזר/],
  ['annual', /סיכום שנתי|סיכום (?:ה)?שנה|סיכום של השנה/],
  ['price-changes', /התייקר|התייקרו|הוזל|הוזלו|(?:עלה|עלו) במחיר|עליי?ת מחיר|שינויי? מחיר/],
  ['upcoming', /(?:חיובים|חיוב)\s+(?:ה)?(?:באים|הבאים|צפויים|הצפויים|קרובים|הקרובים)|מה (?:עומד|צפוי) לרדת|(?:ירד|ירדו|יורד) מהחשבון|חיוב (?:ה)?כרטיס (?:ה)?(?:הבא|קרוב)|חיובי (?:ה)?כרטיס/],
  ['balances', /יתרה|יתרת|יתרות|(?:^|\s)[בלה]?עוש(?=\s|$)|עובר ושב|כמה כסף (?:יש|נשאר)|מצב (?:ה)?חשבון|כמה יש (?:לי )?בבנק/],
  ['net', /חסכתי|חסכנו|חיסכון|חסכון|נשאר לי|נשאר לנו|מאזן|נטו|הכנסות מול הוצאות|הכנסות פחות הוצאות/],
  ['income', /הכנסה|הכנסות|הרווחתי|הרווחנו|משכורת|משכורות|קיבלתי|נכנס|נכנסו|(?:^|\s)שכר(?!\s+דירה)/],
  ['top-expenses', /(?:ה)?(?:הוצאות|עסקאות|חיובים|קניות|רכישות)\s+(?:ה)?(?:גדולות|גדולים|יקרות|יקרים)|הכי (?:גדול|גדולה|יקר|יקרה|גדולים|יקרים)|(?:הוצאה|עסקה|קנייה|קניה) (?:ה)?(?:גדולה|יקרה)/],
  ['categories', /על מה (?:אני |אנחנו )?(?:מוציא|מוציאה|מוציאים|הוצאתי|הוצאנו|הלך)|באיזו קטגוריה|באילו קטגוריות|לפי קטגוריות|לפי קטגוריה|קטגוריות|לאן (?:הולך|הלך) (?:ה)?כסף/],
  ['merchants', /באיזה (?:בית עסק|עסק|חנות|מקום)|באילו (?:חנויות|עסקים|בתי עסק)|בתי (?:ה)?עסק|איפה (?:אני |אנחנו )?(?:מוציא|מוציאה|מוציאים|קונה|קונים|הוצאתי|הוצאנו)|לפי (?:בית עסק|בתי עסק|חנויות)/],
  ['recurring', /מנויים? (?:ה)?קבועים|חיובים? (?:ה)?קבועים|קבועים|הוראות? קבע|חיובים? חוזרים|מנויים|מנוי/],
];
const COMPARE_RE = /(?:^|\s)[וה]?(?:לעומת|בהשוואה|השווה|השוואה|תשווה|תשווי|מול|הבדל|שינוי)(?=\s|$)|יותר מ|פחות מ|השתנ/;

// ---- the answers --------------------------------------------------------------------------------

const txLink = (label, params) => ({ label, section: 'transactions', params: cleanParams(params) });
function cleanParams(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') out[k] = Array.isArray(v) ? v.join(',') : String(v);
  return out;
}
/** The transactions-screen filter for a period: `month` for a calendar month, else from/to. */
const periodParams = (p) => (p.kind === 'month' ? { month: p.month } : { from: p.from, to: p.to });
const catName = (id) => CATEGORY_BY_ID.get(id)?.name || id;

function spendQuery(db, period, { category, merchant }, extra = {}) {
  return queryTransactions(db, {
    from: period.from, to: period.to, category: category || undefined, q: merchant || undefined,
    kind: 'spending', sort: 'amount', order: 'desc', limit: 5, offset: 0, ...extra,
  });
}
/** What the "spending" view nets to (refunds subtract, a category never below zero per month). */
const spentOf = (r) => (r.net ? r.net.total : 0);

function subjectLabel({ category, merchant, merchantName }) {
  if (category) return `על ${catName(category)}`;
  if (merchant) return be(merchantName || merchant);
  return '';
}

function txItem(t) {
  return {
    label: t.description, sub: `${dmy(t.date)} · ${catName(t.category)}${t.installments ? ` · תשלום ${t.installments.number} מתוך ${t.installments.total}` : ''}`,
    amount: Math.abs(t.amount), link: txLink('לתנועה', { ids: [t.id] }),
  };
}

function answerSpending(ctx) {
  const { db, period, subject } = ctx;
  const r = spendQuery(db, period, subject);
  const spent = spentOf(r);
  const s = sentence();
  const subj = subjectLabel(subject);
  if (!r.total) {
    s.t(`לא מצאתי הוצאות ${subj ? `${subj} ` : ''}${period.label}.`);
  } else {
    s.t(`הוצאת ${subj ? `${subj} ` : ''}${period.label} `).m(spent).t(` ב-${fmtInt(r.total)} ${r.total === 1 ? 'תנועה' : 'תנועות'}.`);
    if (r.net.offsets > 0) s.t(' הסכום כבר אחרי זיכויים והחזרים של ').m(r.net.offsets).t('.');
  }
  const months = monthsIn(period);
  // an average needs whole months: not when the period ends inside the running month
  if (r.total && months > 1 && monthOf(period.to) !== monthOf(ctx.today)) s.t(' ממוצע לחודש: ').m(Math.round(toAg(spent) / months) / 100).t('.');
  return {
    intent: 'spending', s,
    items: r.items.length > 1 ? r.items.slice(0, 5).map(txItem) : [],
    itemsTitle: r.items.length > 1 ? 'התנועות הגדולות בסכום הזה' : null,
    links: [txLink('הצג את התנועות', { ...periodParams(period), category: subject.category, q: subject.merchant, kind: 'spending' })],
  };
}

function monthsIn(p) {
  if (p.kind === 'month' || p.kind === 'day') return 1;
  if (p.kind === 'days') return 0;
  const a = monthOf(p.from); const b = monthOf(p.to);
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1;
}

function answerCompare(ctx) {
  const { db, subject, today } = ctx;
  const [a, b0] = ctx.periods;
  // "החודש לעומת החודש שעבר" while this month is still running: compare the same days.
  const cur = monthOf(today);
  const sameDays = !b0 || (a.kind === 'month' && a.month === cur && b0.kind === 'month' && b0.month === addMonths(cur, -1));
  const b = sameDays ? previousPeriod(a, today) : b0;
  const ra = spendQuery(db, a, subject);
  const rb = spendQuery(db, b, subject);
  const va = spentOf(ra); const vb = spentOf(rb);
  const subj = subjectLabel(subject);
  const s = sentence();
  s.t(`${subj ? `ההוצאות ${subj}` : 'סך ההוצאות'} ${a.label}: `).m(va).t(`. ${b.label}: `).m(vb).t('. ');
  const diff = toAg(va) - toAg(vb);
  if (diff === 0) s.t('אותו סכום בדיוק.');
  else {
    s.t('כלומר ').m(Math.abs(diff) / 100).t(diff > 0 ? ' יותר' : ' פחות');
    if (vb > 0) s.t(` (${diff > 0 ? 'עלייה' : 'ירידה'} של ${Math.round((Math.abs(diff) / toAg(vb)) * 100)}%)`);
    s.t('.');
  }
  const base = { category: subject.category, q: subject.merchant, kind: 'spending' };
  return {
    intent: 'compare', s, items: [],
    links: [
      txLink(`התנועות ${a.label.replace(/ \(.*\)$/, '')}`, { ...periodParams(a), ...base }),
      txLink(`התנועות ${b.label.replace(/ \(.*\)$/, '')}`, { ...periodParams(b), ...base }),
    ],
    comparedTo: b,
  };
}

function answerTopExpenses(ctx) {
  const { db, period, subject } = ctx;
  const r = queryTransactions(db, {
    from: period.from, to: period.to, category: subject.category || undefined, q: subject.merchant || undefined,
    kind: 'spending', direction: 'out', sort: 'amount', order: 'desc', limit: 5, offset: 0,
  });
  const s = sentence();
  const subj = subjectLabel(subject);
  if (!r.items.length) s.t(`לא מצאתי הוצאות ${subj ? `${subj} ` : ''}${period.label}.`);
  else {
    const top = r.items[0];
    s.t(`ההוצאה הגדולה ביותר ${subj ? `${subj} ` : ''}${period.label}: ${top.description}, `).m(Math.abs(top.amount)).t(` ב-${dmy(top.date)}.`);
    if (r.items.length > 1) s.t(` הנה ${r.items.length} הגדולות:`);
  }
  return {
    intent: 'top-expenses', s, items: r.items.map(txItem),
    links: r.items.length ? [txLink('כל ההוצאות לפי סכום', { ...periodParams(period), category: subject.category, q: subject.merchant, kind: 'spending' })] : [],
  };
}

function groupSpending(db, period, by) {
  // One query, every counted spending row in the period (paged to stay bounded).
  const groups = new Map();
  let offset = 0;
  for (let page = 0; page < 40; page++) {
    const r = queryTransactions(db, { from: period.from, to: period.to, kind: 'spending', sort: 'date', order: 'asc', limit: 500, offset });
    for (const t of r.items) {
      const key = by(t);
      if (!key) continue;
      const g = groups.get(key) || { key, ag: 0, count: 0, names: new Map(), ids: [] };
      g.ag += -toAg(t.amount);
      g.ids.push(t.id);
      g.count += 1;
      g.names.set(t.description, (g.names.get(t.description) || 0) + 1);
      groups.set(key, g);
    }
    offset += r.items.length;
    if (r.items.length < 500) break;
  }
  return [...groups.values()];
}

function answerCategories(ctx) {
  const { db, period } = ctx;
  // Per category, exactly what the transactions screen nets to for that category.
  const list = [];
  for (const c of CATEGORIES.filter((x) => x.kind === 'expense' || x.id === 'card-payment')) {
    const r = queryTransactions(db, { from: period.from, to: period.to, category: c.id, kind: 'spending', limit: 1, offset: 0, sort: 'date', order: 'desc' });
    const v = spentOf(r);
    if (v > 0) list.push({ id: c.id, name: c.name, amount: v, count: r.total });
  }
  list.sort((x, y) => y.amount - x.amount || (x.id < y.id ? -1 : 1));
  const total = spentOf(spendQuery(ctx.db, period, {}));
  const s = sentence();
  if (!list.length) s.t(`לא מצאתי הוצאות ${period.label}.`);
  else {
    s.t(`${period.label} הוצאת `).m(total).t(`. הכי הרבה הלך על ${list[0].name}: `).m(list[0].amount)
      .t(total > 0 ? ` (${Math.round((toAg(list[0].amount) / toAg(total)) * 100)}%).` : '.');
  }
  return {
    intent: 'categories', s,
    items: list.slice(0, 8).map((c) => ({
      label: c.name, sub: `${fmtInt(c.count)} תנועות${total > 0 ? ` · ${Math.round((toAg(c.amount) / toAg(total)) * 100)}%` : ''}`,
      amount: c.amount, link: txLink(`התנועות של ${c.name}`, { ...periodParams(period), category: c.id, kind: 'spending' }),
    })),
    links: list.length ? [txLink('כל ההוצאות בתקופה', { ...periodParams(period), kind: 'spending' })] : [],
  };
}

function answerMerchants(ctx) {
  const { db, period } = ctx;
  const groups = groupSpending(db, period, (t) => (t.category === 'card-payment' ? null : normalizeQuestion(t.description)))
    .filter((g) => g.ag > 0)
    .map((g) => ({ ...g, name: [...g.names.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0] }))
    .sort((x, y) => y.ag - x.ag || (x.key < y.key ? -1 : 1));
  const s = sentence();
  if (!groups.length) s.t(`לא מצאתי הוצאות ${period.label}.`);
  else s.t(`${period.label} הכי הרבה כסף יצא ${be(groups[0].name)}: `).m(groups[0].ag / 100).t(groups[0].count === 1 ? ' בחיוב אחד.' : ` ב-${fmtInt(groups[0].count)} חיובים.`);
  return {
    intent: 'merchants', s,
    items: groups.slice(0, 8).map((g) => ({
      label: g.name, sub: `${fmtInt(g.count)} ${g.count === 1 ? 'חיוב' : 'חיובים'}`, amount: g.ag / 100,
      link: txLink(`התנועות ${be(g.name)}`, g.ids.length <= 500 ? { ids: g.ids, kind: 'spending' } : { ...periodParams(period), q: g.name, kind: 'spending' }),
    })),
    links: [],
  };
}

function answerIncome(ctx) {
  const { db, period } = ctx;
  const r = queryTransactions(db, { from: period.from, to: period.to, kind: 'income', sort: 'amount', order: 'desc', limit: 5, offset: 0 });
  const s = sentence();
  const v = r.net ? r.net.total : 0;
  if (!r.total) s.t(`לא מצאתי הכנסות ${period.label}.`);
  else {
    s.t(`ההכנסות ${period.label}: `).m(v).t(` מ-${fmtInt(r.total)} ${r.total === 1 ? 'זיכוי' : 'זיכויים'}.`);
    const months = monthsIn(period);
    if (months > 1 && monthOf(period.to) !== monthOf(ctx.today)) s.t(' ממוצע לחודש: ').m(Math.round(toAg(v) / months) / 100).t('.');
  }
  return {
    intent: 'income', s, items: r.items.length > 1 ? r.items.map(txItem) : [], itemsTitle: r.items.length > 1 ? 'הזיכויים הגדולים' : null,
    links: r.total ? [txLink('הצג את ההכנסות', { ...periodParams(period), kind: 'income' })] : [],
  };
}

function answerNet(ctx) {
  const { db, period } = ctx;
  const inc = queryTransactions(db, { from: period.from, to: period.to, kind: 'income', limit: 1, offset: 0, sort: 'date', order: 'desc' });
  const exp = spendQuery(db, period, {});
  const vi = inc.net ? inc.net.total : 0;
  const ve = spentOf(exp);
  const net = (toAg(vi) - toAg(ve)) / 100;
  const s = sentence();
  s.t(`${period.label}: הכנסות `).m(vi).t(', הוצאות ').m(ve).t('. ');
  if (net >= 0) s.t('נשארו ').m(net).t(vi > 0 ? ` (${Math.round((toAg(net) / toAg(vi)) * 100)}% מההכנסות).` : '.');
  else s.t('ההוצאות היו גבוהות מההכנסות ב-').m(-net).t('.');
  return {
    intent: 'net', s, items: [],
    links: [txLink('ההכנסות', { ...periodParams(period), kind: 'income' }), txLink('ההוצאות', { ...periodParams(period), kind: 'spending' })],
  };
}

function answerBalances(ctx) {
  const { db, ds } = ctx;
  const banks = listAccounts(db).filter((a) => a.type === 'bank');
  const known = banks.filter((a) => a.balance != null);
  const sm = computeSummary(ds, monthOf(ds.today));
  const s = sentence();
  if (!known.length) s.t('אין עדיין יתרה מהבנק. היא מתעדכנת בסנכרון הבא.');
  else {
    const total = known.reduce((x, a) => x + toAg(a.balance), 0) / 100;
    s.t(known.length > 1 ? 'היתרה בכל חשבונות הבנק יחד: ' : `היתרה ב${known[0].name}: `).m(total).t('.');
    const up = sm.balances.upcomingCardCharges;
    if (up > 0) s.t(' חיובי כרטיסי האשראי שעוד ירדו: ').m(up).t(', כך שיישארו בערך ').m((toAg(total) - toAg(up)) / 100).t('.');
  }
  return {
    intent: 'balances', s,
    items: known.length > 1 ? known.map((a) => ({ label: a.name, sub: a.companyName, amount: a.balance, link: txLink(`התנועות ב${a.name}`, { accountId: a.id, month: monthOf(ds.today) }) })) : [],
    links: known.length === 1 ? [txLink('התנועות בחשבון', { accountId: known[0].id, month: monthOf(ds.today) })] : [],
  };
}

function answerUpcoming(ctx) {
  const { ds } = ctx;
  const sm = computeSummary(ds, monthOf(ds.today));
  const list = sm.upcoming || [];
  const s = sentence();
  if (!list.length) s.t('לא זיהיתי חיובים צפויים בחודש הקרוב.');
  else {
    const total = list.reduce((x, u) => x + toAg(u.amount), 0) / 100;
    s.t(`בחודש הקרוב צפויים ${fmtInt(list.length)} חיובים בסך `).m(total).t('. הקרוב ביותר: ')
      .t(`${list[0].description}, `).m(list[0].amount).t(` ב-${dmy(list[0].expectedDate)}.`);
  }
  if (sm.balances.upcomingCardCharges > 0) s.t(' מזה חיובי כרטיסי אשראי שכבר נצברו: ').m(sm.balances.upcomingCardCharges).t('.');
  return {
    intent: 'upcoming', s,
    items: list.slice(0, 8).map((u) => ({ label: u.description, sub: `צפוי ב-${dmy(u.expectedDate)}`, amount: u.amount, link: txLink(`התנועות של ${u.description}`, { q: u.description }) })),
    links: [{ label: 'החיובים הקבועים', section: 'recurring', params: {} }],
  };
}

function answerRecurring(ctx, { onlyChanges = false } = {}) {
  const { ds } = ctx;
  const rec = recurringOutput(detectRecurring(ds));
  const s = sentence();
  if (onlyChanges) {
    const ups = rec.filter((r) => r.priceChange && r.priceChange.to !== r.priceChange.from)
      .sort((a, b) => Math.abs(b.priceChange.yearly) - Math.abs(a.priceChange.yearly));
    if (!ups.length) s.t('אף חיוב קבוע לא שינה מחיר ב-12 החודשים האחרונים.');
    else {
      const upYear = ups.filter((r) => r.priceChange.to > r.priceChange.from).reduce((x, r) => x + toAg(r.priceChange.yearly), 0) / 100;
      const nUp = ups.filter((r) => r.priceChange.to > r.priceChange.from).length;
      s.t(`ב-12 החודשים האחרונים ${fmtInt(ups.length)} חיובים קבועים שינו מחיר`);
      if (nUp) s.t(`. ${fmtInt(nUp)} התייקרו, תוספת של `).m(upYear).t(' בשנה');
      s.t('.');
    }
    return {
      intent: 'price-changes', s,
      items: ups.slice(0, 8).map((r) => ({
        label: r.description,
        sub: `${r.priceChange.to > r.priceChange.from ? 'התייקר' : 'הוזל'} ב-${Math.round(Math.abs(r.priceChange.pct))}% · מ-${fmtMoney(r.priceChange.from)} ל-${fmtMoney(r.priceChange.to)} · ${dmy(r.priceChange.date)}`,
        amount: r.amount, link: txLink(`התנועות של ${r.description}`, { q: r.description }),
      })),
      links: [{ label: 'מגמות מחירים', section: 'annual', params: { tab: 'prices' } }],
    };
  }
  if (!rec.length) s.t('עוד לא זוהו חיובים קבועים. צריך כמה חודשים של תנועות כדי לזהות מנויים והוראות קבע.');
  else {
    const yearly = rec.reduce((x, r) => x + toAg(r.yearlyCost), 0) / 100;
    s.t(`זיהיתי ${fmtInt(rec.length)} חיובים קבועים. הם עולים בערך `).m(Math.round(yearly / 12 * 100) / 100).t(' לחודש, ').m(yearly).t(' בשנה. הגדול ביותר: ')
      .t(`${rec[0].description}, `).m(rec[0].amount).t(rec[0].cadence === 'bimonthly' ? ' כל חודשיים.' : ' בחודש.');
  }
  return {
    intent: 'recurring', s,
    items: rec.slice(0, 12).map((r) => ({
      label: r.description,
      sub: `${r.cadence === 'bimonthly' ? 'דו-חודשי' : 'חודשי'} · ${fmtMoney(r.yearlyCost)} בשנה · הבא ב-${dmy(r.nextDate)}`,
      amount: r.amount, link: txLink(`התנועות של ${r.description}`, { q: r.description }),
    })),
    links: [{ label: 'כל החיובים הקבועים', section: 'recurring', params: {} }],
  };
}

function answerInsights(ctx) {
  const { ds } = ctx;
  const month = monthOf(ds.today);
  const list = computeInsights(ds, month).filter((i) => i.severity === 'alert' || i.severity === 'warning' || i.severity === 'info');
  const s = sentence();
  if (!list.length) s.t('לא מצאתי החודש משהו חריג שכדאי לבדוק.');
  else s.t(`מצאתי ${fmtInt(list.length)} דברים שכדאי לבדוק החודש. הראשון: ${list[0].title}.`);
  return {
    intent: 'insights', s,
    items: list.slice(0, 6).map((i) => ({
      label: i.title, sub: i.body, amount: i.amount,
      link: i.action?.filter ? txLink(i.action.label || 'הצג תנועות', i.action.filter) : null,
    })),
    links: [{ label: 'לסקירה', section: 'overview', params: {} }],
  };
}

function answerAnnual(ctx) {
  const { ds } = ctx;
  const end = lastCompleteMonth(ds.today);
  const a = annualOutput(computeAnnual(ds, end));
  const s = sentence();
  const t = a.totals;
  if (!t || !t.months) s.t('אין עדיין מספיק חודשים מלאים לסיכום שנתי.');
  else {
    s.t(`ב-${fmtInt(t.months)} החודשים המלאים עד ${monthName(end)}: הכנסות `).m(t.income).t(', הוצאות ').m(t.expenses).t('. ');
    if (t.net >= 0) s.t('נשארו ').m(t.net).t(t.savingsRate != null ? ` (${Math.round(t.savingsRate)}% מההכנסות).` : '.');
    else s.t('ההוצאות עלו על ההכנסות ב-').m(-t.net).t('.');
    s.t(' ממוצע הוצאות לחודש: ').m(t.avgMonthlyExpenses).t('.');
  }
  return {
    intent: 'annual', s,
    items: (a.categories || []).slice(0, 6).map((c) => ({
      label: c.name, sub: `${c.share != null ? `${Math.round(c.share)}% מההוצאות · ` : ''}ממוצע ${fmtMoney(c.avgMonthly)} לחודש`, amount: c.total,
      link: txLink(`התנועות של ${c.name}`, { from: a.from, to: a.to, category: c.category, kind: 'spending' }),
    })),
    links: [{ label: 'לסיכום השנתי', section: 'annual', params: {} }],
  };
}

export const SUGGESTIONS = [
  'כמה הוצאתי על סופר ב-3 החודשים האחרונים?',
  'מה המנויים הקבועים שלי?',
  'כמה הוצאתי החודש לעומת החודש שעבר?',
  'מה ההוצאות הגדולות החודש?',
  'על מה הוצאתי הכי הרבה השנה?',
  'מה היתרה שלי?',
  'מה התייקר בשנה האחרונה?',
  'כמה הרווחתי בחצי השנה האחרונה?',
];

function answerHelp(note) {
  const s = sentence();
  s.t(note || 'אפשר לשאול על הכסף שלך, והתשובה מחושבת כאן במחשב מהנתונים של MoneyCash.');
  s.t(' למשל: כמה הוצאת על קטגוריה או בבית עסק בתקופה, השוואה לתקופה קודמת, ההוצאות הגדולות, על מה הוצאת הכי הרבה, הכנסות, כמה נשאר, יתרה, חיובים צפויים, חיובים קבועים, מה התייקר, מה כדאי לבדוק, וסיכום שנתי.');
  return { intent: 'help', s, items: [], links: [] };
}

// ---- entry point --------------------------------------------------------------------------------

/**
 * Parse a Hebrew question. Pure (no DB) except for `merchantExists`, which says whether any
 * transaction description contains a candidate.
 */
export function parseQuestion(question, { today, merchantExists = () => false }) {
  const norm = normalizeQuestion(question);
  let intent = null;
  for (const [id, re] of INTENTS) if (re.test(norm)) { intent = id; break; }
  const { periods, rest: noPeriod } = extractPeriods(norm, today);
  const compare = COMPARE_RE.test(norm) || periods.length > 1;

  // "כמה הוצאתי על מנויים ב-3 החודשים" is spending on a category, not the recurring list.
  if (intent === 'recurring' && periods.length && !/קבוע|קבע|חוזר/.test(norm)) intent = null;
  if (intent === 'help' || intent === 'insights' || intent === 'annual' || intent === 'balances'
    || intent === 'upcoming' || intent === 'recurring' || intent === 'price-changes') {
    return { intent, periods, compare: false, subject: { category: null, merchant: null }, unknown: [] };
  }

  const intentRe = INTENTS.find(([id]) => id === intent)?.[1];
  const { category, rest: noCat } = extractCategory(intentRe ? noPeriod.replace(new RegExp(intentRe.source, 'g'), ' ') : noPeriod);
  let merchant = null;
  let unknown = [];
  if (!category && intent !== 'income' && intent !== 'net' && intent !== 'categories' && intent !== 'merchants') {
    // strip the intent's own words before looking for a merchant name
    let rest = noCat;
    for (const [, re] of INTENTS) rest = rest.replace(new RegExp(re.source, 'g'), ' ');
    rest = rest.replace(new RegExp(COMPARE_RE.source, 'g'), ' ');
    const cands = merchantCandidates(rest);
    merchant = cands.find((c) => merchantExists(c)) || null;
    if (!merchant && cands.length) unknown = meaningfulWords(rest);
  }
  if (!intent) {
    const spendish = /הוצא|שילמ|עלה|עלו|עול|כמה/.test(norm);
    if (compare && (category || merchant || periods.length)) intent = 'compare';
    else if (category || merchant || (spendish && periods.length) || spendish) intent = 'spending';
    else if (periods.length) intent = 'spending';
  } else if (compare && intent !== 'categories' && intent !== 'merchants' && intent !== 'top-expenses' && intent !== 'income' && intent !== 'net') {
    intent = 'compare';
  }
  if (intent === 'spending' && compare) intent = 'compare';
  return { intent: intent || 'unknown', periods, compare, subject: { category, merchant }, unknown };
}

/** The whole answer object (docs/API.md, POST /api/chat). */
export function answerQuestion({ db, ds, question, today, lens = 'all' }) {
  LENS = lens;
  try { return answerInLens({ db, ds, question, today }); } finally { LENS = 'all'; }
}

function answerInLens({ db, ds, question, today }) {
  const merchantExists = (q) => queryTransactions(db, { q, limit: 1, offset: 0, sort: 'date', order: 'desc' }).total > 0;
  const p = parseQuestion(question, { today, merchantExists });
  const hasData = ds.rows.length > 0;
  const defaultPeriod = monthPeriod(monthOf(today), today, `החודש (${monthName(monthOf(today))})`);
  const periods = p.periods.length ? p.periods : [p.intent === 'annual' ? null : defaultPeriod].filter(Boolean);
  const subject = { ...p.subject };
  if (subject.merchant) {
    const names = new Set(queryTransactions(db, { q: subject.merchant, limit: 50, offset: 0, sort: 'date', order: 'desc' }).items.map((t) => t.description));
    if (names.size === 1) [subject.merchantName] = names;
  }
  const ctx = { db, ds, today, periods, period: periods[0], subject };

  let out;
  let note = null;
  if (!hasData && p.intent !== 'help') {
    out = answerHelp('עוד אין נתונים לענות מהם. אחרי הסנכרון הראשון (או במצב הדגמה) אפשר לשאול.');
  } else {
    switch (p.intent) {
      case 'spending': out = answerSpending(ctx); break;
      case 'compare': out = answerCompare(ctx); break;
      case 'top-expenses': out = answerTopExpenses(ctx); break;
      case 'categories': out = answerCategories(ctx); break;
      case 'merchants': out = answerMerchants(ctx); break;
      case 'income': out = answerIncome(ctx); break;
      case 'net': out = answerNet(ctx); break;
      case 'balances': out = answerBalances(ctx); break;
      case 'upcoming': out = answerUpcoming(ctx); break;
      case 'recurring': out = answerRecurring(ctx); break;
      case 'price-changes': out = answerRecurring(ctx, { onlyChanges: true }); break;
      case 'insights': out = answerInsights(ctx); break;
      case 'annual': out = answerAnnual(ctx); break;
      case 'help': out = answerHelp(); break;
      default: out = answerHelp('לא הבנתי את השאלה.');
    }
    if (p.unknown.length && (p.intent === 'spending' || p.intent === 'compare' || p.intent === 'top-expenses')) {
      // say first that the name was not found, then what the numbers are about
      out.s.parts.unshift(`לא מצאתי קטגוריה או בית עסק בשם "${p.unknown.join(' ')}". בינתיים, על כל ההוצאות: `);
    }
    if (!p.periods.length && ['spending', 'compare', 'top-expenses', 'categories', 'merchants', 'income', 'net'].includes(p.intent)) {
      note = [note, 'לא צוינה תקופה, אז זה החודש הנוכחי.'].filter(Boolean).join(' ');
    }
  }
  const usesPeriod = ['spending', 'compare', 'top-expenses', 'categories', 'merchants', 'income', 'net'].includes(out.intent);
  const per = (x) => (x ? { from: x.from, to: x.to, label: x.label } : null);
  return {
    intent: out.intent,
    understood: {
      period: usesPeriod ? per(ctx.period) : null,
      comparedTo: out.comparedTo ? per(out.comparedTo) : (out.intent === 'compare' && periods[1] ? per(periods[1]) : null),
      category: p.subject.category && usesPeriod ? { id: p.subject.category, name: catName(p.subject.category) } : null,
      merchant: usesPeriod ? p.subject.merchant : null,
    },
    text: partsText(out.s.parts),
    parts: out.s.parts,
    items: out.items || [],
    itemsTitle: out.itemsTitle || null,
    links: out.links || [],
    note,
    suggestions: out.intent === 'help' ? SUGGESTIONS.slice(0, 6) : [],
  };
}
