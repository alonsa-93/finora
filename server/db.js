// SQLite storage via the built-in node:sqlite. Two fully separate databases: real (real
// connections + data) and demo (generated demo data). All SQL is parameterised.
//
// At rest: each DB lives in memory and is persisted as an AES-256-GCM encrypted snapshot
// (<kind>.db.enc, key = HKDF(DEK, "mc/db/v1"), AAD binds the kind). Writes are detected through
// total_changes() and flushed within ~1 s, after deletions immediately, and on shutdown. A write
// goes temp file -> fsync -> rename, and the previous generation is kept as <kind>.db.enc.1 for
// crash safety (deletions drop it, so deleted rows do not survive in an old generation).
// There is no WAL / journal / temp file with plaintext on disk at any time.
//
// Migration (upgrades data written by earlier versions; kept so such data still opens):
// a legacy plaintext <kind>.db (+ -wal / -shm) is imported, its v1 DPAPI credential
// blobs are re-sealed (AES-GCM + row UUID) and full account numbers replaced by last-4 + HMAC; the
// plaintext files are then overwritten and deleted.
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from './config.js';
import { subkey } from './keys.js';
import { seal, open, isSealedCredential, sealCredentialBytes, accountKey } from './secrets.js';
import { unprotectLegacySync } from './dpapi.js';
import { log } from './log.js';
import { ERROR_MESSAGES } from './errors.js';
import { categorize } from './categories.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  cred_blob TEXT,                 -- "v2:" AES-256-GCM sealed credentials; NULL for demo connections
  cred_uuid TEXT,                 -- AAD for cred_blob (binds the blob to this row)
  created_at TEXT NOT NULL,
  last_sync_at TEXT,              -- last attempt finished
  last_success_at TEXT,           -- last successful scrape (drives the overlap window)
  last_status TEXT NOT NULL DEFAULT 'never',
  last_error TEXT,                -- Hebrew, user-facing, scrubbed
  needs_credentials INTEGER NOT NULL DEFAULT 0, -- 1 after INVALID_PASSWORD etc.: never retry until re-saved
  fail_streak INTEGER NOT NULL DEFAULT 0,       -- consecutive failures without a confirmed login
  needs_code_login INTEGER NOT NULL DEFAULT 0   -- 1 when the site asked for a one-time code: automatic
                                                -- syncs stop until the user logs in once in a visible window
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
  company_id TEXT NOT NULL,
  type TEXT NOT NULL,             -- bank | card
  account_number TEXT NOT NULL,   -- "h:" + HMAC-SHA256(index key, full number); never the number itself
  last4 TEXT,                     -- what the UI shows
  balance INTEGER,                -- agorot, bank accounts only
  last_sync_at TEXT,
  UNIQUE (connection_id, account_number)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  identifier TEXT,
  date TEXT NOT NULL,             -- YYYY-MM-DD (Israel)
  processed_date TEXT,
  description TEXT NOT NULL,
  merchant_key TEXT NOT NULL,     -- normalised description
  memo TEXT,
  amount INTEGER NOT NULL,        -- charged amount in agorot, signed (negative = out)
  original_amount INTEGER,
  original_currency TEXT,
  inst_number INTEGER,
  inst_total INTEGER,
  status TEXT NOT NULL,           -- completed | pending
  provider_category TEXT,
  category TEXT NOT NULL,
  category_source TEXT NOT NULL,  -- auto | user | provider
  is_card_payment INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS tx_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS tx_merchant ON transactions(merchant_key);

CREATE TABLE IF NOT EXISTS rules (
  merchant_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const MAGIC = Buffer.from('MCDB\x01', 'latin1');
const KINDS = new Set(['real', 'demo']);
const FLUSH_INTERVAL_MS = 1000;

const cache = new Map(); // kind -> { db, lastChanges, timer }
let locked = false; // set by wipe: nothing may be opened or written again in this process

/** After a wipe: refuse to open / persist anything until the process restarts. */
export function lockDb() { locked = true; }
export const isLocked = () => locked;

export const snapshotFile = (kind) => join(dataDir(), `${kind}.db.enc`);
// Plaintext database files written by earlier versions (imported once, then shredded).
const legacyFiles = (kind) => ['', '-wal', '-shm', '-journal'].map((s) => join(dataDir(), `${kind}.db${s}`));

export function last4Of(accountNumber) {
  const digits = String(accountNumber || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : String(accountNumber || '').slice(-4);
}

// ---- snapshot encryption ---------------------------------------------------------------------------
const aad = (kind) => `mcdb|v1|${kind}`;

function encryptImage(kind, image) {
  return Buffer.concat([MAGIC, seal(subkey('mc/db/v1'), image, aad(kind))]);
}

function decryptFile(kind, file) {
  const buf = readFileSync(file);
  if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('BAD_SNAPSHOT');
  return open(subkey('mc/db/v1'), buf.subarray(MAGIC.length), aad(kind));
}

function writeFileDurable(file, data) {
  const fd = openSync(file, 'w', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Best-effort secure removal: overwrite with zeros, flush, delete. */
export function shredFile(file) {
  try {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size > 0) {
      const fd = openSync(file, 'r+');
      try {
        const chunk = Buffer.alloc(Math.min(size, 1 << 20));
        for (let off = 0; off < size; off += chunk.length) writeSync(fd, chunk, 0, Math.min(chunk.length, size - off), off);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
  } catch { /* fall through to unlink */ }
  try { unlinkSync(file); } catch { /* ignore */ }
}

function persist(kind, { dropPrevious = false } = {}) {
  const entry = cache.get(kind);
  if (!entry || locked) return;
  const image = entry.db.serialize();
  let out;
  try {
    out = encryptImage(kind, image);
  } finally {
    image.fill(0);
  }
  const file = snapshotFile(kind);
  const tmp = `${file}.tmp`;
  writeFileDurable(tmp, out);
  if (!dropPrevious && existsSync(file)) renameSync(file, `${file}.1`);
  renameSync(tmp, file);
  if (dropPrevious) shredFile(`${file}.1`);
  entry.lastChanges = totalChanges(entry.db);
}

const totalChanges = (db) => db.prepare('SELECT total_changes() AS n').get().n;

/** Persist now if anything changed (or always with force). */
export function flush(kind, { force = false, dropPrevious = false } = {}) {
  const entry = cache.get(kind);
  if (!entry) return;
  if (!force && !dropPrevious && totalChanges(entry.db) === entry.lastChanges) return;
  try {
    persist(kind, { dropPrevious });
  } catch (e) {
    log.error(`persist ${kind} failed: ${e?.code || e?.name || 'Error'}`);
    throw e;
  }
}

export function flushAll() {
  for (const kind of cache.keys()) {
    try { flush(kind); } catch { /* logged */ }
  }
}

// ---- open / migrate --------------------------------------------------------------------------------
function loadSnapshot(kind, db) {
  const file = snapshotFile(kind);
  for (const f of [file, `${file}.1`]) {
    if (!existsSync(f)) continue;
    let image;
    try {
      image = decryptFile(kind, f);
    } catch {
      log.warn(`snapshot ${kind}${f === file ? '' : ' (previous generation)'} unreadable`);
      continue;
    }
    try { db.deserialize(image); } finally { image.fill(0); }
    if (f !== file) {
      log.warn(`snapshot ${kind}: restored the previous generation`);
      // Drop the unreadable newest file so the next persist does not rotate it over the good one.
      try { unlinkSync(file); } catch { /* not there */ }
    }
    return true;
  }
  if (existsSync(file) || existsSync(`${file}.1`)) {
    const e = new Error('SNAPSHOT_UNREADABLE');
    e.code = 'KEY_UNAVAILABLE';
    e.reason = 'unwrap';
    throw e;
  }
  return false;
}

// Upgrades data written by earlier versions: loads their plaintext database into memory.
function importLegacy(kind, db) {
  const [file] = legacyFiles(kind);
  if (!existsSync(file)) return false;
  const legacy = new DatabaseSync(file);
  let image;
  try {
    legacy.exec('PRAGMA busy_timeout = 5000');
    legacy.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    legacy.exec('PRAGMA journal_mode = DELETE');
    image = legacy.serialize();
  } finally {
    legacy.close();
  }
  try { db.deserialize(image); } finally { image.fill(0); }
  log.info(`migration: imported legacy ${kind} database`);
  return true;
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

/** Schema upgrades + v1 -> v2 data migration. Returns true when rows were rewritten. */
function migrate(kind, db) {
  let changed = false;
  const conn = columns(db, 'connections');
  if (!conn.has('fail_streak')) db.exec('ALTER TABLE connections ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0');
  if (!conn.has('cred_uuid')) db.exec('ALTER TABLE connections ADD COLUMN cred_uuid TEXT');
  if (!conn.has('needs_code_login')) {
    db.exec('ALTER TABLE connections ADD COLUMN needs_code_login INTEGER NOT NULL DEFAULT 0');
    // Before this column, a Hapoalim request for an SMS code was reported as a login-page timeout
    // ("site busy") and counted toward the lockout. Such never-successful connections are moved to
    // the code-login state, so opening the app does not send the user yet another SMS.
    const r = db.prepare(`UPDATE connections SET needs_code_login = 1, fail_streak = 0, last_error = ?
      WHERE company_id = 'hapoalim' AND last_success_at IS NULL AND last_status = 'error' AND needs_credentials = 0`)
      .run(ERROR_MESSAGES.CODE_REQUIRED);
    if (r.changes) changed = true;
  }
  // Pending shekel charges stored with amount 0 by earlier versions (chargedAmount 0). Pending
  // rows are replaced on every sync anyway; this fixes what is already on screen. Idempotent.
  if (db.prepare(`UPDATE transactions SET amount = original_amount WHERE status = 'pending' AND amount = 0
    AND original_amount IS NOT NULL AND original_amount <> 0 AND COALESCE(original_currency, 'ILS') = 'ILS'`).run().changes) changed = true;
  if (!columns(db, 'accounts').has('last4')) db.exec('ALTER TABLE accounts ADD COLUMN last4 TEXT');
  // Business mode (business.js). Only adds columns with neutral defaults: everything stays private,
  // and nothing changes until the user turns business mode on. The previous encrypted snapshot is
  // kept as <kind>.db.enc.1 by persist().
  if (!columns(db, 'accounts').has('scope')) db.exec("ALTER TABLE accounts ADD COLUMN scope TEXT NOT NULL DEFAULT 'private'");
  const txCols = columns(db, 'transactions');
  if (!txCols.has('scope')) db.exec('ALTER TABLE transactions ADD COLUMN scope TEXT'); // NULL = inherit
  if (!txCols.has('business_share')) db.exec('ALTER TABLE transactions ADD COLUMN business_share INTEGER'); // NULL = 100
  // owner_draw | owner_injection | none (the user said it is not one); transfer_auto = 1 when detected
  if (!txCols.has('transfer_kind')) db.exec('ALTER TABLE transactions ADD COLUMN transfer_kind TEXT');
  if (!txCols.has('transfer_auto')) db.exec('ALTER TABLE transactions ADD COLUMN transfer_auto INTEGER NOT NULL DEFAULT 0');
  if (!txCols.has('invoice')) db.exec('ALTER TABLE transactions ADD COLUMN invoice INTEGER NOT NULL DEFAULT 0');
  if (!txCols.has('no_vat')) db.exec('ALTER TABLE transactions ADD COLUMN no_vat INTEGER NOT NULL DEFAULT 0');
  // "This merchant is always business / private" (separate from category rules, which need a category).
  // Google Sheets: the last pulled table of each sheet connection (for its dashboard), and the
  // dashboards the user builds (widgets as JSON, validated by dashboards.js).
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_tables (connection_id INTEGER PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
    header TEXT NOT NULL, rows TEXT NOT NULL, fetched_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS dashboards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    source TEXT NOT NULL, widgets TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS scope_rules (merchant_key TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('business', 'private')), created_at TEXT NOT NULL)`);

  // Full account numbers -> last-4 + HMAC (upgrades data written by earlier versions).
  const plainAccounts = db.prepare("SELECT id, type, account_number FROM accounts WHERE account_number NOT LIKE 'h:%'").all();
  if (plainAccounts.length) {
    const upd = db.prepare('UPDATE accounts SET account_number = ?, last4 = ? WHERE id = ?');
    tx(db, () => { for (const a of plainAccounts) upd.run(accountKey(a.account_number), last4Of(a.account_number), a.id); });
    log.info(`migration: ${kind} account numbers reduced to last-4 + HMAC (${plainAccounts.length})`);
    changed = true;
  }

  // Credential blobs: v1 (DPAPI, fixed entropy) -> v2 (AES-GCM bound to the row UUID). Upgrades
  // credentials written by earlier versions.
  if (kind === 'real') {
    const rows = db.prepare('SELECT id, company_id, cred_blob, cred_uuid FROM connections WHERE cred_blob IS NOT NULL').all();
    for (const r of rows) {
      if (isSealedCredential(r.cred_blob)) continue;
      let plain;
      try {
        plain = unprotectLegacySync(r.cred_blob);
      } catch {
        log.warn(`migration: credentials of connection id=${r.id} could not be decrypted; kept for a later attempt`);
        continue;
      }
      try {
        const uuid = r.cred_uuid || randomUUID();
        const blob = sealCredentialBytes(plain, { uuid, companyId: r.company_id });
        db.prepare('UPDATE connections SET cred_blob = ?, cred_uuid = ? WHERE id = ?').run(blob, uuid, r.id);
        changed = true;
        log.info(`migration: credentials of connection id=${r.id} re-sealed`);
      } finally {
        plain.fill(0);
      }
    }
  }
  // Category rules changed (v2: fuel is its own category, merchant beats a mixed card category):
  // re-run auto categorisation on every row the user did not set. User choices stay.
  const CATEGORIES_VERSION = 2;
  const cv = Number(db.prepare("SELECT value FROM settings WHERE key = 'categories_version'").get()?.value || 1);
  if (cv < CATEGORIES_VERSION) {
    const rules = loadRules(db);
    const rows = db.prepare(`SELECT t.id, t.description, t.memo, t.amount, t.provider_category, t.category, t.category_source,
      t.is_card_payment, a.type AS account_type FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.category_source <> 'user'`).all();
    const upd = db.prepare('UPDATE transactions SET category = ?, category_source = ?, is_card_payment = ? WHERE id = ?');
    for (const r of rows) {
      const c = categorize({ description: r.description, memo: r.memo, amount: r.amount, providerCategory: r.provider_category },
        { accountType: r.account_type, rules });
      if (c.category !== r.category || c.source !== r.category_source || (c.isCardPayment ? 1 : 0) !== r.is_card_payment) {
        upd.run(c.category, c.source, c.isCardPayment ? 1 : 0, r.id);
      }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('categories_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(CATEGORIES_VERSION));
    changed = true;
  }
  return changed;
}

export function openDb(kind) {
  if (!KINDS.has(kind)) throw new Error('bad db kind');
  if (cache.has(kind)) return cache.get(kind).db;
  if (locked) throw Object.assign(new Error('WIPED'), { code: 'WIPED' });
  subkey('mc/db/v1'); // unwrap (or create) the data key first: fail before touching any file
  const db = new DatabaseSync(':memory:');
  let fromLegacy = false;
  try {
    if (!loadSnapshot(kind, db)) fromLegacy = importLegacy(kind, db);
    // secure_delete: deleted rows are zeroed in the image, so they never reach a snapshot.
    db.exec('PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
    db.exec(SCHEMA);
  } catch (e) {
    db.close();
    throw e;
  }
  const entry = { db, lastChanges: -1, timer: null };
  cache.set(kind, entry);
  migrate(kind, db);
  persist(kind, { dropPrevious: fromLegacy });
  if (fromLegacy) {
    // Data written by earlier versions: verify the encrypted copy reads back before destroying the plaintext.
    const check = decryptFile(kind, snapshotFile(kind));
    check.fill(0);
    for (const f of legacyFiles(kind)) shredFile(f);
    log.info(`migration: ${kind} plaintext database removed`);
  }
  entry.timer = setInterval(() => {
    try { flush(kind); } catch { /* logged */ }
  }, FLUSH_INTERVAL_MS);
  entry.timer.unref();
  return db;
}

export const isOpen = (kind) => cache.has(kind);

/** Persist and close every DB. */
export function closeAll({ persist: doPersist = true } = {}) {
  for (const [kind, entry] of cache) {
    clearInterval(entry.timer);
    if (doPersist) { try { flush(kind); } catch { /* logged */ } }
    try { entry.db.close(); } catch { /* ignore */ }
  }
  cache.clear();
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function loadRules(db) {
  return new Map(db.prepare('SELECT merchant_key, category FROM rules').all().map((r) => [r.merchant_key, r.category]));
}
