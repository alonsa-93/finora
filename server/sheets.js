// Google Sheets as a source of transactions (docs/API.md, "Google Sheets and dashboards").
//
// The user pastes the sheet's link. The sheet must be shared "anyone with the link can view" (or
// published to the web): Finora downloads it as CSV, with no Google sign-in. The link is a secret
// (anyone holding it can read the sheet), so it is stored encrypted like bank credentials.
// Network: only https://docs.google.com, and the googleusercontent.com download host Google
// redirects to. At most 5 MB, 20 s. Pure parsing below; fetchSheet() is the only I/O.

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const ALLOWED_HOST = /^(docs\.google\.com|[a-z0-9-]+\.googleusercontent\.com)$/i;

export class SheetError extends Error {
  constructor(code, he) { super(code); this.code = code; this.he = he; }
}

export const SHEET_ERRORS = {
  BAD_LINK: 'זה לא קישור לגיליון של Google Sheets. העתק את הקישור מכפתור השיתוף של הגיליון.',
  NOT_SHARED: 'הגיליון לא משותף. ב-Google Sheets: שיתוף, "כל מי שיש לו את הקישור", צופה.',
  NOT_FOUND: 'הגיליון לא נמצא. ייתכן שנמחק או שהקישור השתנה.',
  TOO_BIG: 'הגיליון גדול מדי (יותר מ-5MB).',
  NETWORK: 'אין חיבור ל-Google כרגע. ננסה שוב בסנכרון הבא.',
  NO_COLUMNS: 'לא מצאתי בשורה הראשונה עמודות של תאריך וסכום (או הכנסה/הוצאה).',
};

/**
 * The CSV download URL of a sheet link, or throws SheetError('BAD_LINK').
 * Accepts: .../spreadsheets/d/<id>/edit#gid=<gid>, .../d/<id>/edit?gid=, .../d/e/<pub id>/pubhtml.
 */
export function sheetCsvUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { throw new SheetError('BAD_LINK', SHEET_ERRORS.BAD_LINK); }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'docs.google.com') throw new SheetError('BAD_LINK', SHEET_ERRORS.BAD_LINK);
  const gidRaw = /(?:^|[#&?])gid=(\d{1,12})/.exec(`${u.search}${u.hash}`)?.[1];
  const gid = gidRaw ? `&gid=${gidRaw}` : '';
  const pub = /^\/spreadsheets\/d\/e\/([A-Za-z0-9_-]{20,200})\//.exec(u.pathname);
  if (pub) return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv${gid}`;
  const m = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(\/|$)/.exec(u.pathname);
  if (!m) throw new SheetError('BAD_LINK', SHEET_ERRORS.BAD_LINK);
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid}`;
}

/** RFC 4180 CSV (quotes, doubled quotes, CR/LF inside quotes). BOM tolerated. */
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const HEADERS = {
  date: /^(תאריך|תאריך עסקה|תאריך תשלום|date|day)$/i,
  description: /^(תיאור|פרטים|שם|לקוח|ספק|בית עסק|description|details|name|payee|client|merchant)$/i,
  amount: /^(סכום|סה"?כ|סך הכל|amount|total|sum)$/i,
  income: /^(הכנסה|הכנסות|זכות|income|credit|in)$/i,
  expense: /^(הוצאה|הוצאות|חובה|expense|expenses|debit|out)$/i,
  category: /^(קטגוריה|סיווג|category)$/i,
  vat: /^(מע"?מ|vat)$/i,
  invoice: /^(חשבונית|מס' חשבונית|מספר חשבונית|invoice|receipt)$/i,
};

/** Map header cells to fields. */
export function detectColumns(header) {
  const cols = {};
  header.forEach((h, i) => {
    const name = String(h).trim().replace(/\s+/g, ' ');
    for (const [k, re] of Object.entries(HEADERS)) if (cols[k] === undefined && re.test(name)) cols[k] = i;
  });
  return cols;
}

/** "₪1,234.50" / "-1234" / "(1,234)" / "1.234,50" -> agorot, or null. */
export function parseSheetAmount(v) {
  let s = String(v ?? '').trim().replace(/[₪\s]|ש"ח|ILS|NIS/gi, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^[-−]/.test(s)) { neg = !neg; s = s.slice(1); }
  if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,50
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const agorot = Number(w) * 100 + Number(f.padEnd(2, '0'));
  if (!Number.isSafeInteger(agorot) || agorot > 1e11) return null;
  return neg ? -agorot : agorot;
}

/** "31/12/2026", "31.12.26", "2026-12-31", "31-12-2026" -> "2026-12-31" (day first, Israeli), or null. */
export function parseSheetDate(v) {
  const s = String(v ?? '').trim();
  let y, m, d;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (r) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(s))) {
    [, d, m, y] = r;
    if (y.length === 2) y = `20${y}`;
  } else return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

const truthy = (v) => /^(כן|v|✓|✔|yes|y|true|1|x|יש)$/i.test(String(v ?? '').trim()) || /\d{3,}/.test(String(v ?? ''));

/**
 * Sheet rows -> transactions.
 * @param {string} csv
 * @param {{ kind: 'income'|'expense'|'signed' }} o kind: what a positive "amount" means when there are
 *   no separate income / expense columns ('signed': a minus sign marks an expense).
 * @returns {{ rows: {line, date, description, amount, category, invoice}[], skipped: number, columns: object }}
 */
export function sheetRows(csv, { kind = 'signed' } = {}) {
  const table = parseCsv(csv);
  if (!table.length) throw new SheetError('NO_COLUMNS', SHEET_ERRORS.NO_COLUMNS);
  const cols = detectColumns(table[0]);
  const split = cols.income !== undefined || cols.expense !== undefined;
  if (cols.date === undefined || (cols.amount === undefined && !split)) throw new SheetError('NO_COLUMNS', SHEET_ERRORS.NO_COLUMNS);
  const rows = [];
  let skipped = 0;
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const date = parseSheetDate(cells[cols.date]);
    let amount = null;
    if (split) {
      const inc = cols.income !== undefined ? parseSheetAmount(cells[cols.income]) : null;
      const exp = cols.expense !== undefined ? parseSheetAmount(cells[cols.expense]) : null;
      if (inc) amount = Math.abs(inc);
      else if (exp) amount = -Math.abs(exp);
      else if (cols.amount !== undefined) amount = parseSheetAmount(cells[cols.amount]);
    } else {
      const a = parseSheetAmount(cells[cols.amount]);
      if (a != null) amount = kind === 'income' ? Math.abs(a) : kind === 'expense' ? -Math.abs(a) : a;
    }
    if (!date || amount == null || amount === 0) { skipped++; continue; }
    const description = String(cols.description !== undefined ? cells[cols.description] ?? '' : '').trim().slice(0, 200)
      || (amount > 0 ? 'הכנסה מהגיליון' : 'הוצאה מהגיליון');
    rows.push({
      line: i + 1, date, description, amount,
      category: cols.category !== undefined ? String(cells[cols.category] ?? '').trim().slice(0, 60) || null : null,
      invoice: cols.invoice !== undefined ? truthy(cells[cols.invoice]) : false,
    });
  }
  return { rows, skipped, columns: cols };
}

/** The body, read as a stream and aborted as soon as it passes MAX_BYTES (Content-Length can be
 * missing or wrong), so an oversized answer is never held in memory whole. */
async function readCapped(res, ctl) {
  if (!res.body?.getReader) { // no stream (test doubles): same cap after the fact
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new SheetError('TOO_BIG', SHEET_ERRORS.TOO_BIG);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      ctl.abort();
      throw new SheetError('TOO_BIG', SHEET_ERRORS.TOO_BIG);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Download a sheet as CSV text. Follows up to 3 redirects, each to an allowed Google host only.
 * @param {string} link the user's link
 * @param {{ fetchImpl?: typeof fetch }} o
 */
export async function fetchSheet(link, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  let url = sheetCsvUrl(link);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    for (let hop = 0; hop < 4; hop++) {
      const host = new URL(url).hostname;
      if (new URL(url).protocol !== 'https:' || !ALLOWED_HOST.test(host)) throw new SheetError('NOT_SHARED', SHEET_ERRORS.NOT_SHARED);
      let res;
      try {
        res = await fetchImpl(url, { redirect: 'manual', signal: ctl.signal, credentials: 'omit', headers: { accept: 'text/csv' } });
      } catch { throw new SheetError('NETWORK', SHEET_ERRORS.NETWORK); }
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        if (!next) throw new SheetError('NETWORK', SHEET_ERRORS.NETWORK);
        const abs = new URL(next, url);
        // A redirect to the sign-in page = the sheet is private.
        if (/accounts\.google\.com|ServiceLogin/i.test(abs.href)) throw new SheetError('NOT_SHARED', SHEET_ERRORS.NOT_SHARED);
        url = abs.href;
        continue;
      }
      if (res.status === 404) throw new SheetError('NOT_FOUND', SHEET_ERRORS.NOT_FOUND);
      if (res.status === 401 || res.status === 403) throw new SheetError('NOT_SHARED', SHEET_ERRORS.NOT_SHARED);
      if (!res.ok) throw new SheetError('NETWORK', SHEET_ERRORS.NETWORK);
      const type = res.headers.get('content-type') || '';
      if (/text\/html/i.test(type)) throw new SheetError('NOT_SHARED', SHEET_ERRORS.NOT_SHARED);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_BYTES) throw new SheetError('TOO_BIG', SHEET_ERRORS.TOO_BIG);
      const buf = await readCapped(res, ctl);
      const text = buf.toString('utf8');
      if (/^\s*<(!doctype|html)/i.test(text)) throw new SheetError('NOT_SHARED', SHEET_ERRORS.NOT_SHARED);
      return text;
    }
    throw new SheetError('NETWORK', SHEET_ERRORS.NETWORK);
  } catch (e) {
    if (e instanceof SheetError) throw e;
    throw new SheetError('NETWORK', SHEET_ERRORS.NETWORK);
  } finally {
    clearTimeout(timer);
  }
}

/** Stable key of a sheet row, so tags set in Finora survive a re-import (same date, amount, text, n-th). */
export function sheetRowKeys(rows) {
  const seen = new Map();
  return rows.map((r) => {
    const base = `${r.date}|${r.amount}|${r.description.toLowerCase().replace(/\s+/g, ' ')}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return `sheet:${base}|${n}`;
  });
}
