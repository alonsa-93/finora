// Formatting for Hebrew UI. Every function returns a safe string: never "NaN", "null" or "undefined".
import { h } from './dom.js';

const BIDI_MARKS = /[‎‏؜‪-‮⁦-⁩]/g;
export const DASH = '–';

const nf = {
  ils0: new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0, minimumFractionDigits: 0 }),
  ils2: new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  int: new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 }),
  dec1: new Intl.NumberFormat('he-IL', { maximumFractionDigits: 1 }),
};

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Money as text. Magnitude only unless sign is requested.
 * opts.decimals: 0 | 2 | 'auto' (2 only when the value has agorot)
 * opts.sign: 'none' | 'always' | 'negative'
 */
export function moneyText(value, { decimals = 'auto', sign = 'none' } = {}) {
  if (!isNum(value)) return DASH;
  const abs = Math.abs(value);
  const useDec = decimals === 2 || (decimals === 'auto' && Math.round(abs * 100) % 100 !== 0);
  const body = (useDec ? nf.ils2 : nf.ils0).format(abs).replace(BIDI_MARKS, '').replace(/\s+/g, ' ');
  let prefix = '';
  if (sign === 'always') prefix = value > 0 ? '+' : value < 0 ? '−' : '';
  else if (sign === 'negative' && value < 0) prefix = '−';
  return prefix + body;
}

/** Money as an isolated LTR element: "−412.30 ₪" never gets reordered by surrounding Hebrew. */
export function money(value, opts = {}) {
  return h('bdi', { class: ['num', opts.className], dir: 'ltr' }, moneyText(value, opts));
}

/** Foreign currency amount (original). */
export function foreignText(amount, currency) {
  if (!isNum(amount) || !currency) return DASH;
  try {
    return new Intl.NumberFormat('he-IL', { style: 'currency', currency, maximumFractionDigits: 2 })
      .format(Math.abs(amount)).replace(BIDI_MARKS, '').replace(/\s+/g, ' ');
  } catch {
    return `${nf.dec1.format(Math.abs(amount))} ${currency}`;
  }
}

export function intText(n) { return isNum(n) ? nf.int.format(n) : DASH; }

/** "12.6" -> "13%". Absolute value; direction is always said in words. */
export function pctText(p, { abs = true, digits = 0 } = {}) {
  if (!isNum(p)) return DASH;
  const v = abs ? Math.abs(p) : p;
  const f = digits ? nf.dec1 : nf.int;
  return `${f.format(v)}%`;
}

/* ---------- dates ---------- */

export function parseDate(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  if (iso.length > 10) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const df = {
  dayMonth: new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short' }),
  dayMonthLong: new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long' }),
  full: new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', year: 'numeric' }),
  monthYear: new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' }),
  month: new Intl.DateTimeFormat('he-IL', { month: 'long' }),
  monthShort: new Intl.DateTimeFormat('he-IL', { month: 'short' }),
  monthShortYear: new Intl.DateTimeFormat('he-IL', { month: 'short', year: '2-digit' }),
  weekday: new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }),
  time: new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' }),
  dateTime: new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
};

const fmtDate = (fmt, iso) => { const d = parseDate(iso); return d ? fmt.format(d) : DASH; };
export const dateShort = (iso) => fmtDate(df.dayMonth, iso);
export const dateLong = (iso) => fmtDate(df.dayMonthLong, iso);
export const dateFull = (iso) => fmtDate(df.full, iso);
export const dateTime = (iso) => fmtDate(df.dateTime, iso);
export const weekdayDate = (iso) => fmtDate(df.weekday, iso);

export function monthDate(ym) {
  if (typeof ym !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return null;
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1);
}
export function monthLabel(ym) { const d = monthDate(ym); return d ? df.monthYear.format(d) : DASH; }
export function monthName(ym) { const d = monthDate(ym); return d ? df.month.format(d) : DASH; }
export function monthShort(ym) { const d = monthDate(ym); return d ? df.monthShort.format(d) : DASH; }
export function monthShortYear(ym) { const d = monthDate(ym); return d ? df.monthShortYear.format(d) : DASH; }

export function shiftMonth(ym, delta) {
  const d = monthDate(ym);
  if (!d) return ym;
  d.setMonth(d.getMonth() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function monthBounds(ym) {
  const d = monthDate(ym);
  if (!d) return null;
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return { from: `${ym}-01`, to: `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}` };
}
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Hand-written: Chromium's Hebrew RelativeTimeFormat renders "לפני דקה (1)".
const ago = (n, one, two, many) => (n === 1 ? `לפני ${one}` : n === 2 && two ? `לפני ${two}` : `לפני ${n} ${many}`);

/** "הרגע", "לפני 5 דקות", "לפני שעתיים", "אתמול". */
export function relativeTime(iso) {
  const d = parseDate(iso);
  if (!d) return null;
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 0 && sec > -120) return 'הרגע';
  if (sec < 0) return df.dateTime.format(d);
  if (sec < 45) return 'הרגע';
  if (sec < 3600) return ago(Math.max(1, Math.round(sec / 60)), 'דקה', 'שתי דקות', 'דקות');
  if (sec < 86400) return ago(Math.round(sec / 3600), 'שעה', 'שעתיים', 'שעות');
  const days = Math.round(sec / 86400);
  if (days === 1) return 'אתמול';
  if (days === 2) return 'שלשום';
  if (days < 30) return `לפני ${days} ימים`;
  return df.full.format(d);
}

/** Days from today to a YYYY-MM-DD date, as words: "היום", "מחר", "בעוד 5 ימים". */
export function daysUntil(iso) {
  const d = parseDate(iso);
  if (!d) return null;
  const today = parseDate(todayIso());
  const n = Math.round((d - today) / 86400000);
  if (n === 0) return 'היום';
  if (n === 1) return 'מחר';
  if (n === 2) return 'מחרתיים';
  if (n === -1) return 'אתמול';
  return n > 0 ? `בעוד ${n} ימים` : `לפני ${-n} ימים`;
}

/* ---------- account labels ("מקס •1234") ---------- */
const ACC_RE = /^(.*?)\s*•\s*(\d*)$/;
/**
 * The account as an element: the Hebrew name, then "•1234" as its own LTR run. Without the
 * isolation the bullet attaches to the wrong side and it reads "1234• מקס".
 */
export function accountLabel(name, className) {
  const m = ACC_RE.exec(String(name || ''));
  if (!m) return h('bdi', { class: ['acc-label', className] }, name || '');
  return h('bdi', { class: ['acc-label', className] }, m[1], m[2] ? [' ', h('bdi', { class: 'num acc-digits', dir: 'ltr' }, `•${m[2]}`)] : null);
}
/** The same as plain text (for listbox options and chips): the digits wrapped in LRI…PDI isolates. */
export function accountText(name) {
  const m = ACC_RE.exec(String(name || ''));
  if (!m) return String(name || '');
  return m[2] ? `${m[1]} ⁦•${m[2]}⁩` : m[1];
}
