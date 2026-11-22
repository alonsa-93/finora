// Date helpers working on ISO strings (YYYY-MM-DD / YYYY-MM). Calendar maths is done in UTC
// on date-only values so there are no DST surprises.

const jerusalemFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Convert a scraper ISO timestamp (e.g. "2026-11-01T22:00:00.000Z") to the Israeli calendar date. */
export function toIsraelDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return jerusalemFmt.format(d); // en-CA => YYYY-MM-DD
}

/** Today's date in Israel, as YYYY-MM-DD. */
export function todayISO(now = new Date()) {
  return jerusalemFmt.format(now);
}

export const monthOf = (date) => date.slice(0, 7);

export function parseISO(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fmtISO(dt) {
  return dt.toISOString().slice(0, 10);
}

export function addDays(date, n) {
  const dt = parseISO(date);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmtISO(dt);
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return dt.toISOString().slice(0, 7);
}

/** Same day-of-month n months later, clamped to the month's length. */
export function addMonthsToDate(date, n) {
  const month = addMonths(monthOf(date), n);
  const day = Math.min(Number(date.slice(8, 10)), daysInMonth(month));
  return `${month}-${String(day).padStart(2, '0')}`;
}

export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

export const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(parseISO(s).getTime()) && fmtISO(parseISO(s)) === s;

export const isValidMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export const HEBREW_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי',
  'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

export const hebMonth = (month) => HEBREW_MONTHS[Number(month.slice(5, 7)) - 1];

/** "3.11" style short date for Hebrew text. */
export const shortDate = (date) => `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}`;
