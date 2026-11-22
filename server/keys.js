// Key management. One random 32-byte data key (DEK) per install, wrapped by the OS and stored in
// DATA_DIR\keys\dek.json. Everything at rest is encrypted under HKDF subkeys of it:
//   mc/db/v1    -> AES-256-GCM DB snapshots (db.js)
//   mc/cred/v2  -> AES-256-GCM connection credentials, AAD = connection UUID (secrets.js)
//   mc/index/v1 -> HMAC-SHA256 of full account numbers (store.js; only last-4 kept in clear)
//
// Wrapping: DPAPI CurrentUser (one PowerShell call per launch) is always written so CLI and desktop
// share the key; under Electron an additional safeStorage wrap (also DPAPI on Windows, in-process)
// is preferred for unwrapping.
//
// DPAPI entropy: a random 16-byte value per install, stored next to the wrapped key. Trade-off: it
// is NOT a secret (anyone who can read dek.json can read it), so it adds no protection against
// same-user malware - it only makes the blob useless to generic "CryptUnprotectData everything"
// tools and binds it to this install. A secret entropy would need a user PIN/passphrase, which
// would break unattended daily sync.
//
// Deleting dek.json (wipe) crypto-shreds every snapshot, backup and VSS copy at once.
import { existsSync, mkdirSync, readFileSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync,
  unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, hkdfSync } from 'node:crypto';
import { dataDir } from './config.js';
import { dpapiSync } from './dpapi.js';

export class KeyUnavailableError extends Error {
  constructor(reason) {
    super('KEY_UNAVAILABLE');
    this.code = 'KEY_UNAVAILABLE';
    this.reason = reason; // 'unwrap' | 'missing' | 'corrupt'
  }
}

export const KEY_UNAVAILABLE_HE = 'לא ניתן לפתוח את הנתונים המוצפנים של Finora במשתמש Windows הזה. '
  + 'זה קורה בדרך כלל אחרי איפוס סיסמת Windows, העברת פרופיל או מעבר למחשב אחר. '
  + 'אפשר להתחיל מחדש: הנתונים הישנים יימחקו, ותצטרך לחבר שוב את החשבונות (המשיכה מביאה כ-12 חודשים אחורה).';

// Electron safeStorage (async API). Only used through ensureKeyAsync(), which the desktop shell
// awaits before the server starts; the synchronous path (CLI, tests) uses DPAPI only.
let safeStorage = null;
/** Called by the Electron shell before the server starts. */
export function setSafeStorage(ss) { safeStorage = ss || null; }

let dek = null;
const subkeys = new Map();

export const keyDir = () => join(dataDir(), 'keys');
export const keyFile = () => join(keyDir(), 'dek.json');

async function safeAvailable() {
  try { return !!safeStorage && await safeStorage.isAsyncEncryptionAvailable(); } catch { return false; }
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/** Any encrypted data from an earlier key? (then a missing key file must not mint a new one) */
function encryptedDataExists() {
  try { return readdirSync(dataDir()).some((f) => /\.db\.enc(\.1)?$/.test(f)); } catch { return false; }
}

function checkRecord(rec) {
  if (rec?.v !== 1 || rec.alg !== 'A256GCM' || !rec.wrap) throw new KeyUnavailableError('corrupt');
}

function unwrapDpapi(rec) {
  checkRecord(rec);
  if (rec.wrap.dpapi && typeof rec.entropy === 'string') {
    let out;
    try {
      out = dpapiSync('unprotect', Buffer.from(rec.wrap.dpapi, 'base64'), Buffer.from(rec.entropy, 'base64'));
    } catch {
      throw new KeyUnavailableError('unwrap');
    }
    if (out.length === 32) return out;
    out.fill(0);
  }
  throw new KeyUnavailableError('unwrap');
}

function newRecord(k) {
  const entropy = randomBytes(16);
  const rec = { v: 1, alg: 'A256GCM', created: new Date().toISOString(), entropy: entropy.toString('base64'), wrap: {} };
  try {
    const w = dpapiSync('protect', k, entropy);
    rec.wrap.dpapi = w.toString('base64');
  } catch { /* safeStorage may still work */ }
  return rec;
}

function saveRecord(rec, k) {
  if (!rec.wrap.dpapi && !rec.wrap.safeStorage) {
    k.fill(0);
    const e = new Error('KEY_WRAP_FAILED');
    e.code = 'KEY_WRAP_FAILED';
    throw e;
  }
  mkdirSync(keyDir(), { recursive: true });
  writeAtomic(keyFile(), JSON.stringify(rec));
}

function readRecord() {
  try { return JSON.parse(readFileSync(keyFile(), 'utf8')); } catch { throw new KeyUnavailableError('corrupt'); }
}

/** The data key (32-byte Buffer). Created on first use, unwrapped once per process. */
export function ensureKey() {
  if (dek) return dek;
  if (existsSync(keyFile())) {
    dek = unwrapDpapi(readRecord());
    return dek;
  }
  if (encryptedDataExists()) throw new KeyUnavailableError('missing');
  const k = randomBytes(32);
  saveRecord(newRecord(k), k);
  dek = k;
  return dek;
}

/** Desktop variant: prefers the in-process safeStorage wrap, keeps DPAPI as the shared fallback. */
export async function ensureKeyAsync() {
  if (dek) return dek;
  const useSafe = await safeAvailable();
  if (existsSync(keyFile())) {
    const rec = readRecord();
    checkRecord(rec);
    if (useSafe && rec.wrap.safeStorage) {
      try {
        const { result } = await safeStorage.decryptStringAsync(Buffer.from(rec.wrap.safeStorage, 'base64'));
        const k = Buffer.from(result, 'base64');
        if (k.length === 32) { dek = k; return dek; }
        k.fill(0);
      } catch { /* fall back to DPAPI (e.g. Electron profile was reset) */ }
    }
    dek = unwrapDpapi(rec);
    if (useSafe) { // add / refresh the in-process wrap
      try {
        rec.wrap.safeStorage = (await safeStorage.encryptStringAsync(dek.toString('base64'))).toString('base64');
        writeAtomic(keyFile(), JSON.stringify(rec));
      } catch { /* optional */ }
    }
    return dek;
  }
  if (encryptedDataExists()) throw new KeyUnavailableError('missing');
  const k = randomBytes(32);
  const rec = newRecord(k);
  if (useSafe) {
    try { rec.wrap.safeStorage = (await safeStorage.encryptStringAsync(k.toString('base64'))).toString('base64'); } catch { /* ignore */ }
  }
  saveRecord(rec, k);
  dek = k;
  return dek;
}

export const hasKeyFile = () => existsSync(keyFile());

/** HKDF-SHA256 subkey for a fixed label. */
export function subkey(label) {
  if (subkeys.has(label)) return subkeys.get(label);
  // 'MoneyCash/v1' is the app's former name, frozen: changing it would make existing data unreadable.
  const k = Buffer.from(hkdfSync('sha256', ensureKey(), Buffer.from('MoneyCash/v1'), Buffer.from(label), 32));
  subkeys.set(label, k);
  return k;
}

/** Forget all key material held in this process. */
export function zeroKeys() {
  for (const k of subkeys.values()) k.fill(0);
  subkeys.clear();
  if (dek) dek.fill(0);
  dek = null;
}

/** Crypto-shred: overwrite and delete the wrapped key, then forget the key in memory. */
export function shredKey() {
  const f = keyFile();
  for (const p of [f, `${f}.tmp`]) {
    try {
      if (existsSync(p)) {
        const size = statSync(p).size;
        const fd = openSync(p, 'r+');
        try { writeSync(fd, randomBytes(Math.max(size, 64)), 0, Math.max(size, 64), 0); fsyncSync(fd); } finally { closeSync(fd); }
        unlinkSync(p);
      }
    } catch { /* best effort; the unlink below still runs */ }
    try { unlinkSync(p); } catch { /* gone */ }
  }
  zeroKeys();
}
