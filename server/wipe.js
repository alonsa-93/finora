// "Delete all data": crypto-shred first (the wrapped data key), then every file MoneyCash keeps in
// DATA_DIR. Without the key, any copy that survives elsewhere (restore points, backups, SSD remnants
// of old snapshots) is undecryptable. Electron's own profile (DATA_DIR\electron) is cleared by the
// shell, which also deletes the folder on the next start (it is locked while Electron runs).
import { readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';
import { shredKey } from './keys.js';
import { closeAll, lockDb, shredFile } from './db.js';
import { abortSync } from './sync.js';
import { sweepScraperProfiles } from './browser.js';
import { resetLog, securityEvent } from './log.js';

export const WIPE_MARKER = 'wipe-pending';
// Kept on purpose: nothing personal in it, and the shell needs it to finish the job.
const KEEP = new Set(['electron', WIPE_MARKER]);

const rmTree = (p) => { try { rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } };

/** Wipe everything. Returns the list of top-level entries that could not be removed. */
export async function wipeAllData() {
  const dir = dataDir();
  await abortSync(); // closes a running scrape's browser first
  shredKey(); // 1. crypto-shredding
  closeAll({ persist: false });
  lockDb();
  // Marker: tells the shell (now and on the next start) to drop its profile folder too.
  try { writeFileSync(join(dir, WIPE_MARKER), new Date().toISOString()); } catch { /* ignore */ }
  for (const name of readdirSync(dir)) {
    if (KEEP.has(name)) continue;
    const p = join(dir, name);
    if (/\.(db|enc|1|tmp|json)$|\.db-(wal|shm|journal)$/i.test(name)) shredFile(p);
    rmTree(p);
  }
  sweepScraperProfiles({ minAgeMs: 0 }); // MoneyCash's own run\scrape-* dirs only
  resetLog();
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const left = readdirSync(dir).filter((n) => !KEEP.has(n) && n !== 'logs');
  // The only line in the fresh log: that a wipe happened (no data, no paths).
  securityEvent('wipe', `completed leftovers=${left.length}`, { rateKey: null });
  return left;
}

/** Remove the Electron profile after a wipe (called by the shell before Electron opens it). */
export function finishPendingWipe(electronDir) {
  const dir = dataDir();
  if (!existsSync(join(dir, WIPE_MARKER))) return false;
  rmTree(electronDir);
  rmTree(join(dir, WIPE_MARKER));
  return true;
}
