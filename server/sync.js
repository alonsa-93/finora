// Sync manager: runs connections sequentially (one headless browser at a time).
// Read-only: it only calls israeli-bank-scrapers' scrape(), which logs in and reads transactions.
// The scrape itself runs in a short-lived worker process when the entry point installed a runner
// (setScrapeRunner: CLI / Electron); otherwise (tests, library use) in-process via scrape.js.
import { openDb, flush, getSetting, setSetting } from './db.js';
import { companyMeta, getCompany } from './companies.js';
import { unprotectLegacySync } from './dpapi.js';
import { isSealedCredential, openCredentialBytes } from './secrets.js';
import { scrub, translateScraperError, ERROR_MESSAGES } from './errors.js';
import { toIsraelDate, todayISO, addDays } from './dates.js';
import { toAgorot } from './money.js';
import { upsertAccount, ingestTransactions } from './store.js';
import { syncSheet, SHEET_COMPANY } from './sheet-sync.js';
import { SheetError } from './sheets.js';
import { refreshOwnerTransfers } from './business-store.js';
import { findBrowser as findSystemBrowser, connectionProfileDir } from './browser.js';
import { CODE_COMPANIES } from './login-wait.js';
import { existsSync } from 'node:fs';
import { runScrape, CONNECTION_TIMEOUT_MS } from './scrape.js';
import { log, securityEvent } from './log.js';

const OVERLAP_DAYS = 45;
const MAX_FAIL_STREAK = 3; // banks typically lock after 3-5 consecutive bad logins

const PROGRESS_HE = {
  // Some sites (Max especially) take a minute or more to load: say so, so it does not look stuck.
  INITIALIZING: 'פותח את אתר המוסד… (יכול לקחת עד 2 דקות)',
  START_SCRAPING: 'פותח את אתר המוסד… (יכול לקחת עד 2 דקות)',
  LOGGING_IN: 'מתחבר…',
  LOGGING_IN_INTERACTIVE: 'בחלון של האתר: הקלד את הקוד שקיבלת ב-SMS…',
  LOGIN_SUCCESS: 'מחובר, מוריד תנועות…',
  LOGIN_FAILED: 'ההתחברות נכשלה',
  CHANGE_PASSWORD: 'נדרשת החלפת סיסמה',
  END_SCRAPING: 'שומר נתונים…',
  TERMINATING: 'מסיים…',
};

let state = { running: false, startedAt: null, finishedAt: null, items: [] };

export function syncStatus() {
  return {
    running: state.running, startedAt: state.startedAt, finishedAt: state.finishedAt,
    items: state.items.map(({ connectionId, companyName, state: s, message, newTransactions }) => ({
      connectionId, companyName, state: s, message, newTransactions,
    })),
  };
}

export const isSyncing = () => state.running;

/** Locate the scraper browser: an installed, auto-updating Chrome / Edge only. */
export async function findBrowser() {
  return findSystemBrowser();
}

let scrapeRunner = null;
/** Entry points install an isolated runner (sync-runner.js); null = in-process. */
export function setScrapeRunner(fn) { scrapeRunner = typeof fn === 'function' ? fn : null; }

let abortController = null;
/** Ask a running sync to stop (closes the browser). Resolves when it has finished. */
export async function abortSync(timeoutMs = 15000) {
  if (!state.running) return;
  abortController?.abort();
  const t0 = Date.now();
  while (state.running && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 50));
}

// Card numbers (PAN) must never be stored, even inside a description / memo: Luhn-valid 13-19 digit
// sequences (optionally separated by spaces / dashes) are reduced to their last 4 digits.
function luhn(d) {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}
export function scrubPan(text) {
  return String(text).replace(/\d(?:[ -]?\d){12,18}/g, (m) => {
    const d = m.replace(/\D/g, '');
    return d.length >= 13 && d.length <= 19 && luhn(d) ? `****${d.slice(-4)}` : m;
  });
}

/** Normalise one scraper transaction into the store's shape (amounts in agorot). */
export function normalizeScrapedTxn(t) {
  const date = toIsraelDate(t.date);
  if (!date) return null;
  const charged = Number(t.chargedAmount);
  const original = Number(t.originalAmount);
  if (!Number.isFinite(charged) && !Number.isFinite(original)) return null;
  const currency = (t.originalCurrency || 'ILS').toString().replace('₪', 'ILS').slice(0, 8);
  let amount = Number.isFinite(charged) ? toAgorot(charged) : toAgorot(original);
  // Card companies (Max and others) report a pending charge with chargedAmount 0: nothing has been
  // billed yet. In shekels the purchase amount is the amount; a foreign one stays 0 (no rate yet)
  // and the UI shows the original amount instead.
  const isPending = t.status === 'pending';
  if (isPending && amount === 0 && Number.isFinite(original) && original !== 0 && currency === 'ILS') amount = toAgorot(original);
  if (amount === 0) amount = 0; // no -0
  const inst = t.installments && Number(t.installments.total) > 1 ? t.installments : null;
  return {
    identifier: t.identifier != null && t.identifier !== '' ? String(t.identifier) : null,
    date,
    processedDate: toIsraelDate(t.processedDate) || date,
    description: scrubPan(String(t.description || '').trim()).slice(0, 300) || 'ללא תיאור',
    memo: t.memo ? scrubPan(String(t.memo).trim()).slice(0, 300) : null,
    amount,
    originalAmount: Number.isFinite(original) ? toAgorot(original) : amount,
    originalCurrency: currency,
    instNumber: inst ? Number(inst.number) : null,
    instTotal: inst ? Number(inst.total) : null,
    status: isPending ? 'pending' : 'completed',
    providerCategory: t.category ? String(t.category).slice(0, 100) : null,
  };
}

function windowStart(conn, companyId, today) {
  const maxBack = addDays(today, -companyMeta(companyId).maxDays);
  if (!conn.last_success_at) return maxBack;
  const overlap = addDays(conn.last_success_at.slice(0, 10), -OVERLAP_DAYS);
  return overlap > maxBack ? overlap : maxBack;
}

async function syncRealConnection(item, { interactive = false } = {}) {
  const db = openDb('real');
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(item.connectionId);
  if (!conn) throw Object.assign(new Error('gone'), { he: 'החיבור נמחק.' });
  const now = () => new Date().toISOString();
  const t0 = Date.now();
  const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  // Lockout protection: a wrong/blocked login stops all retries at once; any other failure that
  // happened without a confirmed login (unknown login result, login-page timeout, ...) counts
  // toward MAX_FAIL_STREAK, after which retries stop too. Only re-saving credentials resumes.
  const fail = (code, message, { attemptedLogin = false, loggedIn = false } = {}) => {
    let streak = conn.fail_streak || 0;
    // A one-time-code request, or a visible login the user did not finish, is not a bad password:
    // it does not count toward the lockout streak.
    if (['CODE_REQUIRED', 'CODE_TIMEOUT', 'WINDOW_CLOSED'].includes(code)) attemptedLogin = false;
    if (attemptedLogin) streak = loggedIn ? 0 : streak + 1;
    if (code === 'CODE_REQUIRED') {
      db.prepare('UPDATE connections SET needs_code_login = 1 WHERE id = ?').run(conn.id);
      if (!conn.needs_code_login) securityEvent('code_required', `connection=${conn.id}`, { rateKey: `code-${conn.id}`, level: 'info' });
    }
    let block = code === 'INVALID_PASSWORD' || code === 'ACCOUNT_BLOCKED';
    if (!block && attemptedLogin && streak >= MAX_FAIL_STREAK) {
      block = true;
      message = ERROR_MESSAGES.PAUSED_AFTER_FAILURES;
    }
    db.prepare(`UPDATE connections SET last_sync_at = ?, last_status = 'error', last_error = ?, fail_streak = ?,
      needs_credentials = CASE WHEN ? THEN 1 ELSE needs_credentials END WHERE id = ?`)
      .run(now(), message, streak, block ? 1 : 0, conn.id);
    if (block && !conn.needs_credentials) securityEvent('lockout', `connection=${conn.id} reason=${code}`, { rateKey: `lockout-${conn.id}` });
    item.state = 'error';
    item.message = message;
  };

  // Blocked: keep the stored reason (wrong password / blocked / paused) instead of overwriting it.
  if (conn.needs_credentials) { fail('NEEDS_CREDENTIALS', conn.last_error || ERROR_MESSAGES.NEEDS_CREDENTIALS); return; }
  // Waiting for a login with a code: an automatic attempt would only send the user another SMS.
  if (conn.needs_code_login && !interactive) { fail('CODE_LOGIN_PENDING', ERROR_MESSAGES.CODE_REQUIRED); return; }
  if (conn.company_id === SHEET_COMPANY) { await syncSheetConnection(db, conn, item, fail, secs); return; }
  const company = await getCompany(conn.company_id);
  if (!company || !company.supported) { fail('UNSUPPORTED', ERROR_MESSAGES.UNSUPPORTED); return; }

  const executablePath = await findBrowser();
  if (!executablePath) { fail('NO_BROWSER', ERROR_MESSAGES.NO_BROWSER); return; }

  // Decrypt to bytes only (never a JS string here); zeroed right after hand-over.
  let credBytes;
  try {
    credBytes = isSealedCredential(conn.cred_blob)
      ? openCredentialBytes(conn.cred_blob, { uuid: conn.cred_uuid, companyId: conn.company_id })
      : unprotectLegacySync(conn.cred_blob); // not yet migrated (DPAPI was unavailable at startup)
  } catch {
    fail('DECRYPT_FAILED', ERROR_MESSAGES.DECRYPT_FAILED);
    return;
  }

  const today = todayISO();
  const start = windowStart(conn, conn.company_id, today);
  const onProgress = (type) => {
    item.message = (interactive && type === 'LOGGING_IN' ? PROGRESS_HE.LOGGING_IN_INTERACTIVE : PROGRESS_HE[type]) || item.message;
  };
  // Sites that ask for a code on a new device keep a per-connection profile, so the code is needed
  // once and not on every sync (see browser.js).
  const profileDir = connectionProfileDir(conn.id);
  const persistent = interactive || CODE_COMPANIES.has(conn.company_id) || existsSync(profileDir);
  // Light loading (browser.js), unless it once failed for this company; a visible login loads fully.
  const liteKey = `liteOff:${conn.company_id}`;
  const lite = !interactive && getSetting(db, liteKey) !== '1';
  const job = {
    companyId: conn.company_id, startDate: start, executablePath, timeoutMs: CONNECTION_TIMEOUT_MS,
    interactive, profileDir: persistent ? profileDir : null, lite,
  };
  if (interactive) item.message = 'פותח חלון התחברות…';
  let result;
  try {
    if (scrapeRunner) {
      result = await scrapeRunner({ job, credentials: credBytes, timeoutMs: CONNECTION_TIMEOUT_MS, onProgress, signal: abortController?.signal });
    } else {
      let credentials;
      try { credentials = JSON.parse(credBytes.toString('utf8')); } finally { credBytes.fill(0); }
      result = await runScrape({ ...job, credentials, onProgress, signal: abortController?.signal });
      credentials = null;
    }
  } catch (e) {
    result = { success: false, errorType: 'GENERIC', errorMessage: scrub(e?.message), loggedIn: false };
  } finally {
    credBytes.fill(0);
  }
  const loggedIn = !!result?.loggedIn;

  if (result?.errorType === 'ABORTED') {
    // Stopped by quit / wipe: not a login failure, the streak is left alone.
    item.state = 'error';
    item.message = 'הסנכרון הופסק.';
    log.info(`sync connection=${conn.id} company=${conn.company_id} stopped after=${secs()}`);
    return;
  }
  if (!result?.success) {
    const t = translateScraperError(result?.errorType, result?.errorMessage);
    // A failure that is not about the login details may come from the light loading: the next sync
    // of this company loads the site in full (for good).
    if (lite && !['INVALID_PASSWORD', 'CHANGE_PASSWORD', 'ACCOUNT_BLOCKED', 'CODE_REQUIRED', 'CODE_TIMEOUT', 'WINDOW_CLOSED'].includes(t.code)) {
      setSetting(db, liteKey, '1');
      log.info(`sync company=${conn.company_id} light loading off after a failure`);
    }
    log.warn(`sync connection=${conn.id} company=${conn.company_id} failed type=${t.code} after=${secs()} detail="${scrub(result?.errorMessage)}"`);
    fail(t.code, t.message, { attemptedLogin: true, loggedIn });
    return;
  }

  const type = companyMeta(conn.company_id).type;
  let inserted = 0;
  item.message = 'שומר נתונים…';
  for (const acc of result.accounts || []) {
    const accountNumber = String(acc.accountNumber ?? '').trim().slice(0, 64) || 'unknown';
    const balance = Number.isFinite(Number(acc.balance)) && acc.balance != null ? toAgorot(acc.balance) : null;
    const accountId = upsertAccount(db, { connectionId: conn.id, companyId: conn.company_id, type, accountNumber, balance, now: now() });
    const txns = (acc.txns || []).map(normalizeScrapedTxn).filter(Boolean);
    inserted += ingestTransactions(db, { accountId, accountType: type, txns, windowStart: start, now: now() }).inserted;
  }
  const ts = now();
  db.prepare(`UPDATE connections SET last_sync_at = ?, last_success_at = ?, last_status = 'ok', last_error = NULL,
    needs_credentials = 0, needs_code_login = 0, fail_streak = 0 WHERE id = ?`).run(ts, ts, conn.id);
  item.state = 'ok';
  item.newTransactions = inserted;
  item.message = inserted ? `נוספו ${inserted} תנועות חדשות` : 'אין תנועות חדשות';
  log.info(`sync connection=${conn.id} company=${conn.company_id} ok accounts=${(result.accounts || []).length} new=${inserted} after=${secs()}`);
}

/** A Google Sheets connection: a plain download, no browser and no login (sheet-sync.js). */
async function syncSheetConnection(db, conn, item, fail, secs) {
  let cred;
  try {
    const bytes = openCredentialBytes(conn.cred_blob, { uuid: conn.cred_uuid, companyId: conn.company_id });
    try { cred = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
  } catch {
    fail('DECRYPT_FAILED', ERROR_MESSAGES.DECRYPT_FAILED);
    return;
  }
  item.message = 'מוריד את הגיליון…';
  try {
    const r = await syncSheet(db, conn, cred);
    const ts = new Date().toISOString();
    db.prepare(`UPDATE connections SET last_sync_at = ?, last_success_at = ?, last_status = 'ok', last_error = NULL,
      fail_streak = 0 WHERE id = ?`).run(ts, ts, conn.id);
    item.state = 'ok';
    item.newTransactions = r.inserted;
    item.message = r.message;
    log.info(`sync connection=${conn.id} company=gsheet ok rows=${r.rows} new=${r.inserted} removed=${r.removed} after=${secs()}`);
  } catch (e) {
    const message = e instanceof SheetError ? e.he : 'לא הצלחנו לקרוא את הגיליון.'; // .message is the code
    log.warn(`sync connection=${conn.id} company=gsheet failed type=${e?.code || 'ERROR'} after=${secs()}`);
    fail(e?.code || 'SHEET_ERROR', message); // no login is attempted: never counts toward a lockout
  } finally {
    cred = null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncDemoConnection(item) {
  for (const m of ['מתחבר…', 'מחובר, מוריד תנועות…', 'שומר נתונים…']) {
    item.message = m;
    await sleep(500);
  }
  openDb('demo').prepare(`UPDATE connections SET last_sync_at = ?, last_status = 'ok', last_error = NULL WHERE id = ?`)
    .run(new Date().toISOString(), item.connectionId);
  item.state = 'ok';
  item.newTransactions = 0;
  item.message = 'אין תנועות חדשות (מצב הדגמה)';
}

/** How many connections sync at the same time (each in its own worker and browser). A bank and a
 * card company are different sites, so running them together cuts the wait to the slowest one. */
export const SYNC_CONCURRENCY = 3;

const syncError = (code) => Object.assign(new Error(code), { code });

/** True while this connection is being scraped right now (not just waiting in the queue). */
export function connectionBusy(id) {
  return state.running && state.items.some((i) => i.connectionId === id && i.state === 'running');
}

/** Take a connection that waits in the queue out of it (it was removed). */
export function dropQueued(id) {
  if (!state.running) return;
  state.items = state.items.filter((i) => !(i.connectionId === id && i.state === 'pending'));
}

/**
 * Start a sync in the background.
 * While one runs, a request for more connections (same mode, not interactive) joins its queue instead
 * of failing; an interactive login or a different mode throws { code: 'SYNC_RUNNING' }.
 * @param {'real'|'demo'} mode
 * @param {number|null} connectionId
 * @param {{skipPaused?: boolean, interactive?: boolean}} opts skipPaused (sync on open): leave out
 *   connections paused after failed logins instead of reporting their stored error again
 */
export function startSync(mode, connectionId = null, { skipPaused = false, interactive = false } = {}) {
  if (interactive && (mode !== 'real' || connectionId == null)) throw syncError('BAD_REQUEST');
  if (state.running && (interactive || state.interactive || state.mode !== mode)) throw syncError('SYNC_RUNNING');
  const db = openDb(mode);
  const conns = connectionId == null
    ? db.prepare('SELECT * FROM connections ORDER BY id').all().filter((c) => !(skipPaused && (c.needs_credentials || c.needs_code_login)))
    : db.prepare('SELECT * FROM connections WHERE id = ?').all(connectionId);
  if (connectionId != null && !conns.length) throw syncError('NOT_FOUND');
  const itemOf = (c) => ({
    connectionId: c.id, companyName: companyMeta(c.company_id).name, state: 'pending', message: 'ממתין בתור…', newTransactions: 0,
  });

  if (state.running) {
    // Join the running sync: only connections that are not already waiting or running in it.
    const active = new Set(state.items.filter((i) => i.state === 'pending' || i.state === 'running').map((i) => i.connectionId));
    const add = conns.filter((c) => !active.has(c.id));
    if (add.length) {
      const ids = new Set(add.map((c) => c.id));
      state.items = [...state.items.filter((i) => !ids.has(i.connectionId)), ...add.map(itemOf)];
      state.fill?.();
    }
    return syncStatus();
  }

  state = {
    running: conns.length > 0,
    mode,
    interactive,
    startedAt: new Date().toISOString(),
    finishedAt: conns.length ? null : new Date().toISOString(),
    items: conns.map(itemOf),
  };
  if (!conns.length) return syncStatus();
  abortController = new AbortController();
  const signal = abortController.signal;
  securityEvent('sync_start', `mode=${mode} connections=${conns.length}`, { rateKey: null });
  const runItem = async (item) => {
    item.state = 'running';
    item.message = 'מתחבר…';
    try {
      if (mode === 'demo') await syncDemoConnection(item);
      else await syncRealConnection(item, { interactive });
    } catch (e) {
      item.state = 'error';
      item.message = e?.he || ERROR_MESSAGES.GENERIC;
      log.error(`sync connection=${item.connectionId} crashed: ${scrub(e?.message)}`);
    }
  };
  const nextPending = () => state.items.find((i) => i.state === 'pending');
  const lane = async () => {
    for (let item = nextPending(); item; item = nextPending()) {
      if (signal.aborted) { item.state = 'error'; item.message = 'הסנכרון הופסק.'; continue; }
      await runItem(item);
    }
  };
  const lanes = interactive ? 1 : SYNC_CONCURRENCY;
  // Lanes run side by side; a connection that joins later gets a free lane at once (fill()).
  let active = 0;
  let finishRun;
  const finished = new Promise((r) => { finishRun = r; });
  // A lane marks its item 'running' before its first await, so the loop below sees the queue shrink.
  const fill = () => {
    while (active < lanes && state.items.some((i) => i.state === 'pending')) {
      active += 1;
      lane().finally(() => {
        active -= 1;
        if (nextPending()) fill();
        if (active === 0) finishRun();
      });
    }
  };
  state.fill = fill;
  const run = () => { fill(); return finished; };
  run().finally(() => {
    try { refreshOwnerTransfers(openDb(mode)); } catch (e) { log.warn(`owner transfers: ${scrub(e?.message)}`); }
    try { flush(mode); } catch { /* logged by db.js */ }
    const ok = state.items.filter((i) => i.state === 'ok').length;
    securityEvent('sync_finish', `mode=${mode} ok=${ok} failed=${state.items.length - ok}`, { rateKey: null });
    state.running = false;
    state.finishedAt = new Date().toISOString();
  });
  return syncStatus();
}
