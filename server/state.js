// App-level state: which DB is active (demo vs real) and persisted settings.
// Settings live in real.db so they survive demo resets.
import { openDb, getSetting, setSetting } from './db.js';
import { ensureDemoFresh } from './demo.js';
import { todayISO } from './dates.js';
import { VERSION, dataDirProtected } from './config.js';
import { isSyncing } from './sync.js';
import { diskEncryption } from './diskcheck.js';

export const realDb = () => openDb('real');
export const demoDb = () => openDb('demo');

export function realConnectionCount() {
  return realDb().prepare('SELECT COUNT(*) AS n FROM connections').get().n;
}

/** Demo data is only for before the first real connection: once one exists, the real data is shown
 * and demo mode cannot be turned on again. */
export function isDemoMode() {
  if (realConnectionCount() > 0) return false;
  const v = getSetting(realDb(), 'demoMode', null);
  if (v === null) return true; // nothing connected yet
  return v === true;
}

export function setDemoMode(enabled) {
  setSetting(realDb(), 'demoMode', !!enabled);
  if (enabled) ensureDemoFresh(demoDb(), todayISO());
}

/** The DB that read endpoints use right now. */
export function activeDb() {
  if (isDemoMode()) {
    const db = demoDb();
    ensureDemoFresh(db, todayISO());
    return db;
  }
  return realDb();
}

export function getAutoSync() {
  const v = getSetting(realDb(), 'autoSync', null);
  return {
    enabled: typeof v?.enabled === 'boolean' ? v.enabled : true,
    time: typeof v?.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.time) ? v.time : '07:00',
  };
}

export function setAutoSync(a) {
  setSetting(realDb(), 'autoSync', { enabled: !!a.enabled, time: a.time });
}

/** "Sync as soon as Finora opens" (default on). See opensync.js. */
export function getSyncOnOpen() {
  const v = getSetting(realDb(), 'syncOnOpen', null);
  return typeof v === 'boolean' ? v : true;
}

export function setSyncOnOpen(enabled) {
  setSetting(realDb(), 'syncOnOpen', !!enabled);
}

export function statusObject() {
  const demo = isDemoMode();
  const db = demo ? activeDb() : realDb();
  const last = db.prepare('SELECT MAX(last_sync_at) AS t FROM connections').get().t || null;
  return {
    demoMode: demo,
    hasConnections: realConnectionCount() > 0,
    lastSyncAt: last,
    syncing: isSyncing(),
    autoSync: getAutoSync(),
    syncOnOpen: getSyncOnOpen(),
    version: VERSION,
    diskEncryption: diskEncryption(), // 'on' | 'off' | null (unknown)
    dataDirProtected: dataDirProtected(), // folder limited to this user + SYSTEM; null = not Windows
  };
}
