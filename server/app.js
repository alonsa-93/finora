// Express app: security guards, JSON API (docs/API.md) and static files.
import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import {
  allowedHosts, allowedOrigins, WEB_DIR, getAuthToken, getApiToken, noAuthAllowed, authCookieName,
} from './config.js';
import { ApiError } from './errors.js';
import { listCompanies, getCompany, companyMeta } from './companies.js';
import { sealCredentials, openCredentials } from './secrets.js';
import { flush, isLocked } from './db.js';
import {
  listConnections, connectionOut, listAccounts, queryTransactions, patchTransaction, categoriesOut, countSimilar, undoChange,
  loadDataset, exportRows, getTransactionView,
} from './repo.js';
import { computeSummary, detectRecurring, recurringOutput } from './analytics.js';
import { computeInsights } from './insights.js';
import { computeAnnual, annualOutput, computeAnnualInsights } from './annual.js';
import { computePriceTrends, priceTrendsOutput, lastCompleteMonth } from './prices.js';
import { runOpenSync } from './opensync.js';
import { answerQuestion, MAX_QUESTION } from './chat.js';
import { isValidCategory } from './categories.js';
import { isValidDate, isValidMonth, todayISO, monthOf } from './dates.js';
import {
  activeDb, realDb, statusObject, setDemoMode, setAutoSync, setSyncOnOpen, isDemoMode, realConnectionCount,
} from './state.js';
import { startSync, syncStatus, connectionBusy, dropQueued } from './sync.js';
import { removeConnectionProfile } from './browser.js';
import { PRESETS, resolvePeriod, computePeriodSummary, parseMonthsList } from './period.js';
import { computePosition } from './position.js';
import { log, securityEvent } from './log.js';
import { bootstrapPage } from './session.js';
import { LENSES, SCOPES, ACCOUNT_SCOPES, TRANSFER_KINDS } from './business.js';
import { BUSINESS_TYPES, VAT_PERIODS, vatRate as vatRateOf } from './business-rates.js';
import {
  getBusinessSettings, setBusinessSettings, setAccountScope, patchBusinessFields, businessOverview, businessFlow,
} from './business-store.js';
import { sheetCsvUrl, SheetError } from './sheets.js';
import { SHEET_COMPANY, SHEET_KINDS } from './sheet-sync.js';
import {
  sheetTable, listDashboards, getDashboard, createDashboard, updateDashboard, deleteDashboard, validateWidgets,
  ensureDefaultDashboards,
} from './dashboards.js';

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; "
  + "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// Only browser features the dashboard needs (none).
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), '
  + 'clipboard-read=(), display-capture=(), fullscreen=()';

// Static paths: anything that is (or decodes to) a dot-segment, a dotfile, a backslash, a NUL, a
// double-encoding or an empty segment is refused before it reaches express.static.
export function badStaticPath(rawUrl) {
  const path = String(rawUrl).split('?')[0];
  if (/%(2e|2f|5c|25|00|c0|c1|e0)|%u|\\|;|\0/i.test(path)) return true;
  return path.split('/').slice(1).some((seg, i, all) => seg.startsWith('.') || (seg === '' && i < all.length - 1));
}

const deny = (res, status, code, message, reason, req) => {
  const path = req.originalUrl.startsWith('/api/') ? req.originalUrl.split('?')[0].replace(/\/\d+/g, '/:id').slice(0, 60) : 'static';
  securityEvent(`deny_${status}`, `reason=${reason} method=${req.method} path=${path}`, { rateKey: `deny-${status}-${reason}` });
  res.status(status).json({ error: { code, message } });
};
const BAD = (msg = 'הבקשה אינה תקינה.') => new ApiError(400, 'BAD_REQUEST', msg);

// ---- validation helpers -----------------------------------------------------------------------
function qStr(req, name, max = 100) {
  const v = req.query[name];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw BAD();
  return v;
}
function qInt(req, name, { min, max, def }) {
  const v = qStr(req, name, 12);
  if (v === undefined) return def;
  if (!/^-?\d+$/.test(v)) throw BAD();
  const n = Number(v);
  if (n < min || n > max) throw BAD();
  return n;
}
function qEnum(req, name, values) {
  const v = qStr(req, name, 20);
  if (v === undefined) return undefined;
  if (!values.includes(v)) throw BAD();
  return v;
}
/** `months=YYYY-MM,YYYY-MM,...` (up to 36): several months picked together. */
function qMonths(req) {
  try { return parseMonthsList(qStr(req, 'months', 7 * 36 + 40)); } catch { throw BAD('רשימת חודשים לא תקינה (YYYY-MM,YYYY-MM).'); }
}
function qMonth(req, name = 'month') {
  const v = qStr(req, name, 7);
  if (v === undefined) return undefined;
  if (!isValidMonth(v)) throw BAD('חודש לא תקין (YYYY-MM).');
  return v;
}
function qDate(req, name) {
  const v = qStr(req, name, 10);
  if (v === undefined) return undefined;
  if (!isValidDate(v)) throw BAD('תאריך לא תקין (YYYY-MM-DD).');
  return v;
}
function idParam(req) {
  const v = req.params.id;
  if (!/^\d{1,10}$/.test(v)) throw BAD();
  return Number(v);
}
function body(req) {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw BAD();
  return b;
}
/** ?lens=all|business|private (repo.lensFor() turns it into 'all' while business mode is off). */
const qLens = (req) => qEnum(req, 'lens', LENSES) || 'all';
const cleanText = (s, max) => String(s).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);

function transactionFilters(req) {
  const idsRaw = qStr(req, 'ids', 6000);
  let ids;
  if (idsRaw !== undefined) {
    if (!/^\d{1,10}(,\d{1,10}){0,499}$/.test(idsRaw)) throw BAD();
    ids = [...new Set(idsRaw.split(',').map(Number))];
  }
  const accountId = qInt(req, 'accountId', { min: 1, max: 1e9, def: undefined });
  const category = qStr(req, 'category', 40);
  if (category !== undefined && !isValidCategory(category)) throw BAD('קטגוריה לא מוכרת.');
  return {
    from: qDate(req, 'from'), to: qDate(req, 'to'), month: qMonth(req), months: qMonths(req), accountId, category,
    q: qStr(req, 'q', 100)?.trim() || undefined,
    direction: qEnum(req, 'direction', ['in', 'out']),
    kind: qEnum(req, 'kind', ['spending', 'income']),
    sort: qEnum(req, 'sort', ['date', 'amount']) || 'date',
    order: qEnum(req, 'order', ['asc', 'desc']) || 'desc',
    limit: qInt(req, 'limit', { min: 1, max: 500, def: 50 }),
    offset: qInt(req, 'offset', { min: 0, max: 10_000_000, def: 0 }),
    ids,
    lens: qLens(req),
  };
}

/** VAT inside a row's amount (₪), at the rate of its date. */
function vatOfRow(t) {
  const rate = vatRateOf(t.date);
  return Math.round(((t.amount * rate) / (1 + rate)) * 100) / 100;
}

const csvCell = (v) => {
  if (v == null) return '';
  let s = String(v);
  // Spreadsheet formula injection (merchant names come from the bank site). Leading whitespace is
  // trimmed by some importers (LibreOffice / Sheets), so look past it; full-width ＝＋－＠ too.
  if (typeof v === 'string' && /^[\s　]*[=+\-@＝＋－＠]|^[\t\r\n]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---- app ----------------------------------------------------------------------------------------
export function createApp({ onWipe = null, onSession = null } = {}) {
  const app = express();
  // Slow requests are logged (path without the query, and the time only), to find what makes the
  // window feel slow.
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      if (ms >= 700) log.info(`slow request ${req.method} ${String(req.path).replace(/[^\w/.-]/g, '_').slice(0, 60)} ms=${ms}`);
    });
    next();
  });
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('query parser', 'simple');

  // Security headers on every response.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': PERMISSIONS_POLICY,
    });
    next();
  });

  // DNS-rebinding guard: only our own host names.
  app.use((req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts().has(host)) {
      deny(res, 403, 'BAD_HOST', 'הגישה מותרת רק מהמחשב הזה.', 'bad_host', req);
      return;
    }
    next();
  });

  // API reads: browsers say where a request comes from. Refuse anything a different site (or
  // another port on 127.0.0.1, which is "same-site") started - e.g. a top-level navigation to
  // /api/export.csv that would drop the full history into Downloads. Non-browser clients send
  // no Sec-Fetch-Site and are handled by the Host check and the auth cookie + API token.
  app.use('/api', (req, res, next) => {
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      deny(res, 403, 'FORBIDDEN', 'הבקשה נחסמה מטעמי אבטחה.', 'fetch_site', req);
      return;
    }
    // The one-time bootstrap exchange (CLI / browser mode) is the only /api call without a cookie.
    if (req.method === 'POST' && req.path === '/session') { next(); return; }
    // Cookie AND API token (X-Finora): the cookie alone can leak to any other 127.0.0.1 listener
    // the browser visits (config.js). No token configured = refused, except in the test suite.
    const token = getAuthToken();
    if (!token ? !noAuthAllowed() : !tokenMatches(cookieValue(req, authCookieName()), token)) {
      deny(res, 401, 'UNAUTHORIZED', 'הגישה מותרת רק מתוך אפליקציית Finora.', 'no_cookie', req);
      return;
    }
    if (token && !tokenMatches(req.headers['x-finora'] ?? '', getApiToken())) {
      deny(res, 401, 'UNAUTHORIZED', 'הגישה מותרת רק מתוך אפליקציית Finora.', 'no_api_token', req);
      return;
    }
    if (isLocked()) {
      res.status(503).json({ error: { code: 'WIPED', message: 'הנתונים נמחקו. האפליקציה מופעלת מחדש.' } });
      return;
    }
    next();
  });

  // CSRF guard for mutating requests.
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'שיטה לא נתמכת.' } });
      return;
    }
    if (!MUTATING.has(req.method)) { next(); return; }
    const origin = req.headers.origin;
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    const fetchSite = req.headers['sec-fetch-site'];
    // X-Finora forces a CORS preflight: '1' (POST /api/session, before the page has a token) or
    // the API token (every other /api call, checked above).
    const x = req.headers['x-finora'];
    const apiToken = getApiToken();
    if ((x !== '1' && !(apiToken && typeof x === 'string' && tokenMatches(x, apiToken)))
      || !/^application\/json(\s*;.*)?$/.test(ctype)
      || (origin !== undefined && !allowedOrigins().has(origin))
      || (fetchSite !== undefined && !['same-origin', 'none'].includes(fetchSite))) {
      deny(res, 403, 'FORBIDDEN', 'הבקשה נחסמה מטעמי אבטחה.', 'csrf', req);
      return;
    }
    next();
  });

  app.use(express.json({ limit: '16kb', strict: true, type: 'application/json' }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const api = express.Router();

  api.get('/status', (req, res) => res.json(statusObject()));

  api.post('/demo', (req, res) => {
    const b = body(req);
    if (typeof b.enabled !== 'boolean') throw BAD();
    if (b.enabled && realConnectionCount() > 0) throw new ApiError(409, 'HAS_CONNECTIONS', 'יש חשבון אמיתי מחובר, ולכן מוצגים תמיד הנתונים שלך.');
    setDemoMode(b.enabled);
    res.json(statusObject());
  });

  api.patch('/settings', (req, res) => {
    const b = body(req);
    if (b.autoSync === undefined && b.syncOnOpen === undefined) throw BAD('אין מה לעדכן.');
    const a = b.autoSync;
    if (a !== undefined && (!a || typeof a !== 'object' || typeof a.enabled !== 'boolean'
      || typeof a.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(a.time))) {
      throw BAD('הגדרת סנכרון לא תקינה (שעה בפורמט HH:MM).');
    }
    if (b.syncOnOpen !== undefined && typeof b.syncOnOpen !== 'boolean') throw BAD('הגדרת סנכרון בפתיחה לא תקינה.');
    if (a !== undefined) setAutoSync(a);
    if (b.syncOnOpen !== undefined) setSyncOnOpen(b.syncOnOpen);
    res.json(statusObject());
  });

  api.get('/companies', async (req, res) => res.json(await listCompanies()));

  api.get('/connections', (req, res) => res.json(listConnections(activeDb())));

  async function validateCredentials(company, creds, uuid) {
    if (!creds || typeof creds !== 'object' || Array.isArray(creds)) throw BAD('חסרים פרטי התחברות.');
    const keys = company.loginFields.map((f) => f.key);
    for (const k of Object.keys(creds)) if (!keys.includes(k)) throw BAD('שדה התחברות לא מוכר.');
    const out = {};
    for (const f of company.loginFields) {
      const v = creds[f.key];
      if (typeof v !== 'string' || v.length < 1 || v.length > 128 || /[\u0000-\u001F\u007F]/.test(v)) {
        throw BAD(`השדה "${f.label}" חסר או לא תקין.`);
      }
      out[f.key] = f.secret ? v : v.trim();
    }
    try {
      return sealCredentials(out, { uuid, companyId: company.id });
    } catch {
      throw new ApiError(500, 'ENCRYPTION_FAILED', 'לא ניתן להצפין את פרטי ההתחברות במחשב הזה.');
    }
  }

  api.post('/connections', async (req, res) => {
    const b = body(req);
    if (b.companyId === SHEET_COMPANY) { addSheetConnection(b, res); return; }
    const company = await getCompany(b.companyId);
    if (!company) throw BAD('מוסד לא מוכר.');
    if (!company.supported) throw new ApiError(400, 'UNSUPPORTED_COMPANY', company.note || 'המוסד הזה עדיין לא נתמך.');
    if (b.nickname !== undefined && typeof b.nickname !== 'string') throw BAD();
    const nickname = cleanText(b.nickname || '', 40) || company.name;
    const uuid = randomUUID();
    const blob = await validateCredentials(company, b.credentials, uuid);
    const db = realDb();
    const r = db.prepare(`INSERT INTO connections (company_id, nickname, cred_blob, cred_uuid, created_at, last_status)
      VALUES (?, ?, ?, ?, ?, 'never')`).run(company.id, nickname, blob, uuid, new Date().toISOString());
    setDemoMode(false); // adding a real connection leaves demo mode
    flush('real');
    securityEvent('credentials_saved', `connection=${r.lastInsertRowid} company=${company.id}`, { rateKey: null, level: 'info' });
    res.status(201).json(connectionOut(db.prepare('SELECT * FROM connections WHERE id = ?').get(Number(r.lastInsertRowid))));
  });

  // A Google Sheets link: checked here (Google hosts only), sealed like a password, pulled at once.
  function sheetCred(b) {
    const c = b.sheet;
    if (!c || typeof c !== 'object') throw BAD('חסר קישור לגיליון.');
    if (typeof c.url !== 'string' || c.url.length > 500) throw BAD('הקישור לגיליון לא תקין.');
    try { sheetCsvUrl(c.url); } catch (e) { throw new ApiError(400, 'BAD_LINK', e instanceof SheetError ? e.he : 'הקישור לגיליון לא תקין.'); }
    if (c.kind !== undefined && !SHEET_KINDS.includes(c.kind)) throw BAD();
    if (c.scope !== undefined && !ACCOUNT_SCOPES.includes(c.scope)) throw BAD();
    return { url: c.url.trim(), kind: c.kind || 'signed', scope: c.scope || 'business' };
  }
  function addSheetConnection(b, res) {
    if (b.nickname !== undefined && typeof b.nickname !== 'string') throw BAD();
    const cred = sheetCred(b);
    const nickname = cleanText(b.nickname || '', 40) || 'הגיליון שלי';
    const uuid = randomUUID();
    let blob;
    try { blob = sealCredentials(cred, { uuid, companyId: SHEET_COMPANY }); } catch {
      throw new ApiError(500, 'ENCRYPTION_FAILED', 'לא ניתן להצפין את הקישור במחשב הזה.');
    }
    const db = realDb();
    const r = db.prepare(`INSERT INTO connections (company_id, nickname, cred_blob, cred_uuid, created_at, last_status)
      VALUES (?, ?, ?, ?, ?, 'never')`).run(SHEET_COMPANY, nickname, blob, uuid, new Date().toISOString());
    setDemoMode(false);
    flush('real');
    const id = Number(r.lastInsertRowid);
    securityEvent('sheet_added', `connection=${id}`, { rateKey: null, level: 'info' });
    try { startSync('real', id); } catch { /* a sync is running: the sheet joins the next one */ }
    res.status(201).json(connectionOut(db.prepare('SELECT * FROM connections WHERE id = ?').get(id)));
  }

  // Addition to the contract: update nickname and/or re-save credentials (clears the
  // "wrong password - do not retry" block).
  api.patch('/connections/:id', async (req, res) => {
    const id = idParam(req);
    const b = body(req);
    if (isDemoMode()) throw new ApiError(409, 'DEMO_MODE', 'לא ניתן לעדכן חיבורים במצב הדגמה.');
    if (connectionBusy(id)) throw new ApiError(409, 'SYNC_RUNNING', 'החיבור הזה מסתנכרן ממש עכשיו. נסה שוב בסיומו.');
    const db = realDb();
    const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
    if (!conn) throw new ApiError(404, 'NOT_FOUND', 'החיבור לא נמצא.');
    if (b.nickname !== undefined) {
      if (typeof b.nickname !== 'string') throw BAD();
      db.prepare('UPDATE connections SET nickname = ? WHERE id = ?').run(cleanText(b.nickname, 40) || companyMeta(conn.company_id).name, id);
    }
    if (b.sheet !== undefined) {
      if (conn.company_id !== SHEET_COMPANY) throw BAD();
      // How the amounts are read and whose rows they are stay as they were unless sent: a new link
      // alone must not flip every amount (which would replace every row and drop its tags).
      let prev = {};
      try { prev = conn.cred_blob ? openCredentials(conn.cred_blob, { uuid: conn.cred_uuid, companyId: SHEET_COMPANY }) || {} : {}; } catch { prev = {}; }
      const next = sheetCred({ sheet: { ...b.sheet, kind: b.sheet?.kind ?? prev.kind, scope: b.sheet?.scope ?? prev.scope } });
      const uuid = randomUUID();
      const blob = sealCredentials(next, { uuid, companyId: SHEET_COMPANY });
      db.prepare("UPDATE connections SET cred_blob = ?, cred_uuid = ?, last_error = NULL, last_status = 'never' WHERE id = ?").run(blob, uuid, id);
    }
    if (b.credentials !== undefined) {
      if (conn.company_id === SHEET_COMPANY) throw BAD();
      const company = await getCompany(conn.company_id);
      if (!company?.supported) throw new ApiError(400, 'UNSUPPORTED_COMPANY', 'המוסד הזה עדיין לא נתמך.');
      const uuid = randomUUID();
      const blob = await validateCredentials(company, b.credentials, uuid);
      db.prepare("UPDATE connections SET cred_blob = ?, cred_uuid = ?, needs_credentials = 0, fail_streak = 0, last_error = NULL, last_status = CASE WHEN last_status = 'error' THEN 'never' ELSE last_status END WHERE id = ?")
        .run(blob, uuid, id);
      securityEvent('credentials_replaced', `connection=${id} company=${conn.company_id}`, { rateKey: null, level: 'info' });
    }
    flush('real');
    res.json(connectionOut(db.prepare('SELECT * FROM connections WHERE id = ?').get(id)));
  });

  api.delete('/connections/:id', (req, res) => {
    const id = idParam(req);
    const del = qEnum(req, 'deleteData', ['true', 'false']) === 'true';
    if (connectionBusy(id)) throw new ApiError(409, 'SYNC_RUNNING', 'החיבור הזה מסתנכרן ממש עכשיו. נסה שוב בסיומו.');
    dropQueued(id);
    const db = activeDb();
    const conn = db.prepare('SELECT id FROM connections WHERE id = ?').get(id);
    if (!conn) throw new ApiError(404, 'NOT_FOUND', 'החיבור לא נמצא.');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (del) {
        db.prepare('DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE connection_id = ?)').run(id);
        db.prepare('DELETE FROM accounts WHERE connection_id = ?').run(id);
        // Merchant rules learnt only from this connection's transactions would keep merchant names.
        db.prepare('DELETE FROM rules WHERE merchant_key NOT IN (SELECT DISTINCT merchant_key FROM transactions)').run();
        db.prepare('DELETE FROM scope_rules WHERE merchant_key NOT IN (SELECT DISTINCT merchant_key FROM transactions)').run();
      }
      db.prepare("DELETE FROM dashboards WHERE source = 'sheet:' || ?").run(id);
      db.prepare('DELETE FROM connections WHERE id = ?').run(id); // credentials blob (and the sheet table) go with it
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    // No recoverable remains: secure_delete zeroed the rows in memory, VACUUM rebuilds the image,
    // and the new snapshot replaces both the current and the previous generation on disk.
    db.exec('VACUUM');
    flush(db === realDb() ? 'real' : 'demo', { dropPrevious: true });
    if (db === realDb()) removeConnectionProfile(id); // the site's "known device" cookies go too
    securityEvent('connection_deleted', `connection=${id} deleteData=${del}`, { rateKey: null, level: 'info' });
    res.status(204).end();
  });

  api.post('/sync', (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    let connectionId = null;
    if (b.connectionId !== undefined && b.connectionId !== null) {
      if (!Number.isInteger(b.connectionId) || b.connectionId < 1) throw BAD();
      connectionId = b.connectionId;
    }
    // interactive: a visible login window for one connection, where the user types a one-time code.
    if (b.interactive !== undefined && typeof b.interactive !== 'boolean') throw BAD();
    const interactive = b.interactive === true;
    if (interactive && (connectionId == null || isDemoMode())) throw BAD();
    try {
      res.status(202).json(startSync(isDemoMode() ? 'demo' : 'real', connectionId, { interactive }));
    } catch (e) {
      if (e.code === 'SYNC_RUNNING') throw new ApiError(409, 'SYNC_RUNNING', 'סנכרון כבר רץ.');
      if (e.code === 'NOT_FOUND') throw new ApiError(404, 'NOT_FOUND', 'החיבור לא נמצא.');
      throw e;
    }
  });

  api.get('/sync/status', (req, res) => res.json(syncStatus()));

  // The window came back after a long time hidden (browser tab / tray): same rules as on launch.
  api.post('/sync/open', (req, res) => {
    const d = runOpenSync('resume');
    res.json({ started: d.start, reason: d.reason, status: syncStatus() });
  });

  // One-time bootstrap (CLI / browser mode): exchanges the token from the /auth#<token> URL for the
  // HttpOnly cookie and, in the body, the API token the page sends in X-Finora from then on.
  // Single use, expires, constant-time comparison (session.js).
  api.post('/session', (req, res) => {
    const b = body(req);
    if (!onSession || !getAuthToken() || typeof b.token !== 'string' || b.token.length > 200 || !onSession(b.token)) {
      deny(res, 401, 'UNAUTHORIZED', 'הקישור לכניסה כבר נוצל או אינו תקין. הפעל את Finora מחדש.', 'bootstrap', req);
      return;
    }
    res.set('Set-Cookie', `${authCookieName()}=${getAuthToken()}; HttpOnly; SameSite=Strict; Path=/`);
    res.status(200).json({ apiToken: getApiToken() });
  });

  // Delete everything (crypto-shred + files + desktop profile), then restart in first-run state.
  let wiping = false;
  api.post('/wipe', async (req, res) => {
    const b = body(req);
    if (b.confirm !== 'מחק') throw new ApiError(400, 'CONFIRM_REQUIRED', 'כדי למחוק הכול יש להקליד "מחק".');
    if (wiping) throw new ApiError(409, 'WIPE_RUNNING', 'המחיקה כבר מתבצעת.');
    wiping = true;
    securityEvent('wipe', 'requested', { rateKey: null });
    const { wipeAllData } = await import('./wipe.js');
    const left = await wipeAllData();
    res.json({ ok: true, restarting: !!onWipe, leftovers: left.length });
    if (onWipe) res.on('finish', () => setTimeout(() => onWipe(), 300));
  });

  api.get('/accounts', (req, res) => res.json(listAccounts(activeDb())));

  api.get('/categories', (req, res) => res.json(categoriesOut()));

  api.get('/transactions', (req, res) => res.json(queryTransactions(activeDb(), transactionFilters(req))));

  api.patch('/transactions/:id', (req, res) => {
    const id = idParam(req);
    const b = body(req);
    const patch = {};
    if (b.category !== undefined) {
      if (!isValidCategory(b.category)) throw BAD('קטגוריה לא מוכרת.');
      patch.category = b.category;
    }
    if (b.excluded !== undefined) {
      if (typeof b.excluded !== 'boolean') throw BAD();
      patch.excluded = b.excluded;
    }
    if (b.applyToSimilar !== undefined && typeof b.applyToSimilar !== 'boolean') throw BAD();
    patch.applyToSimilar = b.applyToSimilar === true;
    // Business mode fields (business-store.js).
    const biz = {};
    if (b.scope !== undefined) {
      if (b.scope !== null && !SCOPES.includes(b.scope)) throw BAD('צד לא מוכר (עסק / פרטי).');
      biz.scope = b.scope;
    }
    if (b.businessShare !== undefined) {
      if (b.businessShare !== null && !(Number.isInteger(b.businessShare) && b.businessShare >= 0 && b.businessShare <= 100)) throw BAD('אחוז עסקי בין 0 ל-100.');
      biz.businessShare = b.businessShare;
    }
    if (b.transferKind !== undefined) {
      if (b.transferKind !== null && ![...TRANSFER_KINDS, 'none'].includes(b.transferKind)) throw BAD();
      biz.transferKind = b.transferKind;
    }
    for (const k of ['invoice', 'noVat', 'applyToMerchant']) {
      if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') throw BAD(); biz[k] = b[k]; }
    }
    const hasBiz = ['scope', 'businessShare', 'transferKind', 'invoice', 'noVat'].some((k) => biz[k] !== undefined);
    if (patch.category === undefined && patch.excluded === undefined && !hasBiz) throw BAD('אין מה לעדכן.');
    if (hasBiz) {
      const db = activeDb();
      const t = patchBusinessFields(db, id, biz);
      if (!t) throw new ApiError(404, 'NOT_FOUND', 'התנועה לא נמצאה.');
      if (patch.category === undefined && patch.excluded === undefined) {
        flush(db === realDb() ? 'real' : 'demo');
        res.json({ ...t, ...getTransactionView(db, id, qLens(req)), affected: 0, undoId: null });
        return;
      }
    }
    const r = patchTransaction(activeDb(), id, patch);
    if (!r) throw new ApiError(404, 'NOT_FOUND', 'התנועה לא נמצאה.');
    flush(activeDb() === realDb() ? 'real' : 'demo');
    res.json({ ...r.tx, ...getTransactionView(activeDb(), id, qLens(req)), affected: r.affected, undoId: r.undoId });
  });

  // How many other rows "apply to similar" would change, so the UI can ask before doing it.
  api.get('/transactions/:id/similar', (req, res) => {
    const id = idParam(req);
    const category = qStr(req, 'category', 40);
    if (!isValidCategory(category)) throw BAD('קטגוריה לא מוכרת.');
    const r = countSimilar(activeDb(), id, category);
    if (!r) throw new ApiError(404, 'NOT_FOUND', 'התנועה לא נמצאה.');
    res.json(r);
  });

  // Undo a category / exclusion change (and the merchant rule it created), by the id PATCH returned.
  api.post('/transactions/undo', (req, res) => {
    const b = body(req);
    if (typeof b.undoId !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(b.undoId)) throw BAD();
    const db = activeDb();
    const r = undoChange(db, b.undoId);
    if (!r) throw new ApiError(410, 'UNDO_EXPIRED', 'אי אפשר לבטל את השינוי הזה יותר (עבר זמן רב מדי או שהמידע התחלף).');
    flush(db === realDb() ? 'real' : 'demo');
    res.json(r);
  });

  api.get('/summary', (req, res) => {
    const today = todayISO();
    // A longer period (preset, set of months, or date range) instead of one calendar month.
    const months = qMonths(req);
    const preset = qEnum(req, 'period', PRESETS);
    const from = qDate(req, 'from'), to = qDate(req, 'to');
    if (months || preset || from || to) {
      const p = resolvePeriod({ period: preset, months, from, to }, today);
      if (!p) throw BAD('התקופה לא תקינה.');
      res.json(computePeriodSummary(loadDataset(activeDb(), today, qLens(req)), p));
      return;
    }
    const month = qMonth(req) || monthOf(today);
    res.json(computeSummary(loadDataset(activeDb(), today, qLens(req)), month));
  });

  // Where do I stand: bank and card balances now, their trend over the selected months, red flags.
  api.get('/position', (req, res) => {
    const today = todayISO();
    const months = qMonths(req);
    if (months && months.length > 36) throw BAD('אפשר לבחור עד 36 חודשים.');
    res.json(computePosition(loadDataset(activeDb(), today, qLens(req)), { months }));
  });

  api.get('/insights', (req, res) => {
    const today = todayISO();
    const month = qMonth(req) || monthOf(today);
    res.json(computeInsights(loadDataset(activeDb(), today, qLens(req)), month));
  });

  // Annual review and price trends: the window ends at a complete month (default: the last one).
  const qEnd = (req) => {
    const end = qMonth(req, 'end');
    if (end && end > lastCompleteMonth(todayISO())) throw BAD('אפשר לבחור רק חודש שהסתיים.');
    return end;
  };
  api.get('/annual', (req, res) => {
    const end = qEnd(req);
    res.json(annualOutput(computeAnnual(loadDataset(activeDb(), todayISO(), qLens(req)), end)));
  });

  api.get('/annual/insights', (req, res) => {
    const end = qEnd(req);
    res.json(computeAnnualInsights(computeAnnual(loadDataset(activeDb(), todayISO(), qLens(req)), end)));
  });

  api.get('/price-trends', (req, res) => {
    const end = qEnd(req);
    res.json(priceTrendsOutput(computePriceTrends(loadDataset(activeDb(), todayISO(), qLens(req)), { end })));
  });

  api.get('/recurring', (req, res) => {
    res.json(recurringOutput(detectRecurring(loadDataset(activeDb(), todayISO(), qLens(req)))));
  });

  // שאלות: a Hebrew question answered locally from the data (server/chat.js). POST so the question
  // stays out of URLs; it is never logged or stored.
  api.post('/chat', (req, res) => {
    const b = body(req);
    if (typeof b.question !== 'string') throw BAD('חסרה שאלה.');
    const question = cleanText(b.question, MAX_QUESTION + 1);
    if (!question) throw BAD('חסרה שאלה.');
    if (question.length > MAX_QUESTION) throw BAD(`השאלה ארוכה מדי (עד ${MAX_QUESTION} תווים).`);
    const db = activeDb();
    const today = todayISO();
    const lens = qLens(req);
    res.json(answerQuestion({ db, ds: loadDataset(db, today, lens), question, today, lens }));
  });

  // ---- business mode ------------------------------------------------------------------------------
  const flushActive = () => flush(activeDb() === realDb() ? 'real' : 'demo');
  api.get('/business', (req, res) => res.json(getBusinessSettings(activeDb(), todayISO())));
  api.patch('/business', (req, res) => {
    const b = body(req);
    const p = {};
    if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw BAD(); p.enabled = b.enabled; }
    if (b.type !== undefined) { if (!BUSINESS_TYPES.includes(b.type)) throw BAD('סוג עסק לא מוכר.'); p.type = b.type; }
    if (b.vatPeriod !== undefined) { if (!VAT_PERIODS.includes(b.vatPeriod)) throw BAD('תקופת דיווח לא מוכרת.'); p.vatPeriod = b.vatPeriod; }
    if (b.setAsidePct !== undefined) {
      if (typeof b.setAsidePct !== 'number' || !Number.isFinite(b.setAsidePct) || b.setAsidePct < 0 || b.setAsidePct > 60) throw BAD('אחוז ההפרשה בין 0 ל-60.');
      p.setAsidePct = Math.round(b.setAsidePct * 10) / 10;
    }
    if (b.taxPaidYtd !== undefined) {
      if (typeof b.taxPaidYtd !== 'number' || !Number.isFinite(b.taxPaidYtd) || b.taxPaidYtd < 0 || b.taxPaidYtd > 1e8) throw BAD('סכום המקדמות לא תקין.');
      p.taxPaidYtd = b.taxPaidYtd;
    }
    if (b.name !== undefined) { if (typeof b.name !== 'string') throw BAD(); p.name = cleanText(b.name, 60); }
    if (!Object.keys(p).length) throw BAD('אין מה לעדכן.');
    const out = setBusinessSettings(activeDb(), p, todayISO());
    flushActive();
    res.json(out);
  });
  api.patch('/accounts/:id', (req, res) => {
    const id = idParam(req);
    const b = body(req);
    if (!ACCOUNT_SCOPES.includes(b.scope)) throw BAD('בחר: עסק, פרטי או מעורב.');
    if (!setAccountScope(activeDb(), id, b.scope)) throw new ApiError(404, 'NOT_FOUND', 'החשבון לא נמצא.');
    flushActive();
    res.json(listAccounts(activeDb()).find((a) => a.id === id));
  });
  const needBusiness = () => {
    if (!getBusinessSettings(activeDb(), todayISO()).enabled) throw new ApiError(409, 'BUSINESS_OFF', 'מצב עסק כבוי. אפשר להפעיל אותו בהגדרות.');
  };
  api.get('/business/overview', (req, res) => { needBusiness(); res.json(businessOverview(activeDb(), todayISO())); });
  api.get('/business/flow', (req, res) => {
    needBusiness();
    res.json(businessFlow(activeDb(), todayISO(), qInt(req, 'months', { min: 2, max: 24, def: 6 })));
  });
  // For the accountant: business rows only, the business part of split rows, with VAT and invoice marks.
  api.get('/business/export.csv', (req, res) => {
    needBusiness();
    const from = qDate(req, 'from');
    const to = qDate(req, 'to');
    const db = activeDb();
    const s = getBusinessSettings(db, todayISO());
    const rows = exportRows(db, { from, to, lens: 'business' });
    const cats = new Map(categoriesOut().map((c) => [c.id, c.name]));
    const header = ['תאריך', 'תיאור', 'סכום (כולל מע"מ)', 'מע"מ', 'סכום לפני מע"מ', 'קטגוריה', 'חשבון', 'חלק עסקי %',
      'סכום מלא בתנועה', 'חשבונית', 'בלי מע"מ', 'העברה בין העסק לפרטי'];
    const lines = [header.map(csvCell).join(',')];
    for (const t of rows) {
      const owner = t.transferKind === 'owner_draw' || t.transferKind === 'owner_injection';
      const vat = s.type === 'exempt' || owner || t.noVat ? 0 : vatOfRow(t);
      lines.push([
        t.date, t.description, t.amount, vat, Math.round((t.amount - vat) * 100) / 100, cats.get(t.category) || t.category,
        t.accountName, t.businessShare ?? 100, t.fullAmount ?? '', t.invoice ? 'כן' : '', t.noVat ? 'כן' : '',
        owner ? (t.transferKind === 'owner_draw' ? 'משיכה לפרטי' : 'הזרמה לעסק') : '',
      ].map(csvCell).join(','));
    }
    const name = `finora-business-${from || 'all'}-${to || todayISO()}.csv`;
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
    res.send(`\ufeff${lines.join('\r\n')}\r\n`);
  });

  // ---- Google Sheets dashboards ---------------------------------------------------------------------
  const sheetConn = (db, id) => {
    const c = db.prepare('SELECT * FROM connections WHERE id = ? AND company_id = ?').get(id, SHEET_COMPANY);
    if (!c) throw new ApiError(404, 'NOT_FOUND', 'הגיליון לא נמצא.');
    return c;
  };
  api.get('/sheets', (req, res) => {
    const db = activeDb();
    ensureDefaultDashboards(db);
    const sheets = db.prepare(`SELECT c.*, st.fetched_at AS table_at FROM connections c LEFT JOIN sheet_tables st ON st.connection_id = c.id
      WHERE c.company_id = ? ORDER BY c.id`).all(SHEET_COMPANY)
      .map((c) => ({ ...connectionOut(c), tableAt: c.table_at || null }));
    res.json({ sheets, dashboards: listDashboards(db) });
  });
  api.get('/sheets/:id/table', (req, res) => {
    const db = activeDb();
    const id = idParam(req);
    sheetConn(db, id);
    const t = sheetTable(db, id);
    if (!t) throw new ApiError(404, 'NO_TABLE', 'הגיליון עוד לא נמשך. לחץ "עדכן" ונסה שוב.');
    res.json(t);
  });
  const dashBody = (db, b, existing) => {
    const out = {};
    if (b.name !== undefined || !existing) {
      if (typeof b.name !== 'string' || !cleanText(b.name, 60)) throw BAD('חסר שם לדשבורד.');
      out.name = cleanText(b.name, 60);
    }
    const source = existing ? existing.source : b.source;
    const m = /^sheet:(\d{1,10})$/.exec(String(source || ''));
    if (!m) throw BAD('מקור לא מוכר.');
    if (b.widgets !== undefined || !existing) {
      const t = sheetTable(db, Number(m[1]));
      if (!t) throw new ApiError(404, 'NO_TABLE', 'הגיליון עוד לא נמשך.');
      try { out.widgets = validateWidgets(b.widgets ?? [], t.columns.length); } catch (e) { throw BAD(e.message); }
    }
    if (!existing) { sheetConn(db, Number(m[1])); out.source = source; }
    return out;
  };
  api.post('/dashboards', (req, res) => {
    const db = activeDb();
    const d = createDashboard(db, dashBody(db, body(req), null));
    flushActive();
    res.status(201).json(d);
  });
  api.patch('/dashboards/:id', (req, res) => {
    const db = activeDb();
    const id = idParam(req);
    const cur = getDashboard(db, id);
    if (!cur) throw new ApiError(404, 'NOT_FOUND', 'הדשבורד לא נמצא.');
    const d = updateDashboard(db, id, dashBody(db, body(req), cur));
    flushActive();
    res.json(d);
  });
  api.delete('/dashboards/:id', (req, res) => {
    if (!deleteDashboard(activeDb(), idParam(req))) throw new ApiError(404, 'NOT_FOUND', 'הדשבורד לא נמצא.');
    flushActive();
    res.status(204).end();
  });

  api.get('/export.csv', (req, res) => {
    const from = qDate(req, 'from');
    const to = qDate(req, 'to');
    const rows = exportRows(activeDb(), { from, to, lens: qLens(req) });
    const header = ['תאריך', 'תאריך חיוב', 'תיאור', 'הערה', 'סכום', 'סכום מקורי', 'מטבע מקורי', 'קטגוריה',
      'חשבון', 'תשלום', 'סטטוס', 'חיוב כרטיס אשראי', 'מוחרג מהסיכומים'];
    const cats = new Map(categoriesOut().map((c) => [c.id, c.name]));
    const lines = [header.map(csvCell).join(',')];
    for (const t of rows) {
      lines.push([
        t.date, t.processedDate, t.description, t.memo, t.amount, t.originalAmount, t.originalCurrency,
        cats.get(t.category) || t.category, t.accountName,
        t.installments ? `${t.installments.number}/${t.installments.total}` : '',
        t.status === 'pending' ? 'ממתין' : 'סופי', t.isCardPayment ? 'כן' : '', t.excluded ? 'כן' : '',
      ].map(csvCell).join(','));
    }
    const name = `finora-${from || 'all'}-${to || todayISO()}.csv`;
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  api.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'הנתיב לא קיים.' } });
  });

  app.use('/api', api);

  // ---- static ----------------------------------------------------------------------------------
  app.use((req, res, next) => {
    if (badStaticPath(req.url)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'הדף לא נמצא.' } });
      return;
    }
    next();
  });
  // One-time bootstrap page for CLI / browser mode (session.js).
  app.get('/auth', (req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(bootstrapPage()); });
  app.use(express.static(WEB_DIR, { index: 'index.html', dotfiles: 'ignore' }));
  app.get('/', (req, res) => {
    if (existsSync(join(WEB_DIR, 'index.html'))) { res.sendFile(join(WEB_DIR, 'index.html')); return; }
    res.type('html').send('<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>Finora</title></head>'
      + '<body><p>השרת פועל, אבל ממשק המשתמש (web/index.html) עדיין לא קיים.</p></body></html>');
  });
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'הדף לא נמצא.' } });
  });

  // ---- errors ----------------------------------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'TOO_LARGE', message: 'הבקשה גדולה מדי.' } });
      return;
    }
    if (err?.type === 'entity.parse.failed' || err?.status === 400) {
      res.status(400).json({ error: { code: 'BAD_JSON', message: 'הבקשה אינה JSON תקין.' } });
      return;
    }
    // Never echo internals (could contain data); log only the error class/code.
    log.error(`unhandled ${req.method} ${req.path}: ${err?.name || 'Error'} ${err?.code || ''}`);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'אירעה שגיאה פנימית. נסה שוב.' } });
  });

  return app;
}
