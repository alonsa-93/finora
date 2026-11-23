// Keeping the user's connections through every upgrade, rename and reinstall.
//
// A user's bank and card connections live in the data folder: keys\dek.json (the data key, wrapped
// for this Windows user), real.db.enc (connections, encrypted credentials, transactions) and
// profiles\conn-* (each bank's browser profile, which keeps the device "known" to the bank). If the
// app ever opens a different, empty folder, every connection looks gone. Three guards:
//
//   1. backupOnVersionChange: the first start of a new version copies those files to
//      <data>\backups\<time>-<from>-to-<to> before anything else touches them (newest 5 kept).
//   2. hasUserData (used by config.defaultDataDir): an empty folder never wins over one with data.
//   3. agentSandboxReason: the real app does not start from inside an AI coding tool. The Claude
//      desktop app is an MSIX package: whatever it launches writes %LOCALAPPDATA% into its own
//      private copy, so the real data would end up where the user's own launch never looks.
//
// No imports from config.js (config.js imports this file).
import { existsSync, readFileSync, writeFileSync, readdirSync, cpSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const BACKUP_DIR = 'backups';
export const VERSION_FILE = 'version.json';
export const BACKUPS_KEPT = 5;

/** Does this folder hold a user's data (a data key or an encrypted database)? */
export function hasUserData(dir) {
  try {
    if (existsSync(join(dir, 'keys', 'dek.json'))) return true;
    return readdirSync(dir).some((f) => /^real\.db\.enc(\.1)?$|^real\.db$/.test(f));
  } catch { return false; }
}

// Browser caches inside a bank profile: large, rebuilt by the browser, not part of the connection.
const SKIP = /^(cache|code cache|gpucache|grshadercache|graphitedawncache|shadercache|dawncache|crashpad|browsermetrics|service worker|component_crx_cache|extensions_crx_cache)$/i;

/** What a backup holds: the key, the databases, the settings and the bank profiles. */
function backupEntries(dir) {
  return readdirSync(dir).filter((f) => f === 'keys' || f === 'profiles' || f === 'desktop.json'
    || /^(real|demo)\.db\.enc(\.1)?$/.test(f) || /^(real|demo)\.db(-wal|-shm)?$/.test(f));
}

const readVersion = (dir) => {
  try { return String(JSON.parse(readFileSync(join(dir, VERSION_FILE), 'utf8')).version || ''); } catch { return ''; }
};

/** Backup folder names sort by time: they start with an ISO timestamp. */
export function listBackups(dir) {
  try {
    return readdirSync(join(dir, BACKUP_DIR))
      .filter((n) => /^\d{4}-\d\d-\d\dT/.test(n) && statSync(join(dir, BACKUP_DIR, n)).isDirectory())
      .sort();
  } catch { return []; }
}

/**
 * Before a new version runs for the first time on this data, copy the connection data aside.
 * Returns { backedUp: path|null, from, to }. Throws only if the copy fails; the caller decides
 * (the version mark is not moved then, so the next start tries again).
 */
export function backupOnVersionChange(dir, version, { now = new Date(), keep = BACKUPS_KEPT } = {}) {
  const from = readVersion(dir);
  const to = String(version);
  if (from === to) return { backedUp: null, from, to };
  let target = null;
  if (hasUserData(dir)) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    target = join(dir, BACKUP_DIR, `${stamp}-${from || 'earlier'}-to-${to}`.replace(/[^\w.-]/g, '_'));
    mkdirSync(target, { recursive: true });
    for (const name of backupEntries(dir)) {
      cpSync(join(dir, name), join(target, name), {
        recursive: true, errorOnExist: false, force: true,
        filter: (src) => !SKIP.test(src.split(/[\\/]/).pop()),
      });
    }
    // Keep the newest `keep` backups.
    const all = listBackups(dir);
    for (const old of all.slice(0, Math.max(0, all.length - keep))) {
      try { rmSync(join(dir, BACKUP_DIR, old), { recursive: true, force: true }); } catch { /* next time */ }
    }
  }
  writeFileSync(join(dir, VERSION_FILE), JSON.stringify({ version: to, at: now.toISOString() }));
  return { backedUp: target, from, to };
}

/**
 * Non-empty = we were started by an AI coding tool, whose sandbox can hide the real data folder.
 * Developer mode (demo data, FINORA_DATA_DIR lab folders) stays allowed there.
 */
export function agentSandboxReason(env = process.env) {
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'Claude Code';
  return '';
}

export const AGENT_SANDBOX_HE = 'Finora לא תפתח את הנתונים האמיתיים מתוך כלי AI לכתיבת קוד (%s): '
  + 'הכלי רץ בסביבה מבודדת, והחיבורים לבנק היו נשמרים במקום שבו הפעלה רגילה לא מוצאת אותם. '
  + 'פתח את Finora מתפריט התחל, או הפעל מצב פיתוח עם נתוני דמו (npm start -- --dev).';
