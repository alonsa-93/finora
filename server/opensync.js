// Sync on open: when MoneyCash starts (Electron launch, `npm start`) or its window comes back after
// being hidden for a while, refresh the real connections at once, without a click.
//
// Rules (decideOpenSync, pure and unit-tested):
//  - off when the "sync on open" setting is off (PATCH /api/settings { syncOnOpen });
//  - nothing without real connections (demo mode with nothing connected stays quiet);
//  - never while a sync is running;
//  - connections paused after failed logins (needs_credentials) are left out - the lockout rules of
//    sync.js still apply, so no login is ever retried here - and if all are paused nothing starts;
//  - nothing when every remaining connection finished a sync (ok or failed) within
//    OPEN_SYNC_MIN_INTERVAL_MS (30 minutes), so reopening the window repeatedly does not hammer the banks.
import { realDb, getSyncOnOpen } from './state.js';
import { startSync, isSyncing } from './sync.js';
import { log } from './log.js';

/** A connection synced (or attempted) within this window counts as fresh. */
export const OPEN_SYNC_MIN_INTERVAL_MS = 30 * 60 * 1000;
/** The window counts as "reopened" after being hidden (tray / background tab) for longer than this. */
export const RESTORE_AFTER_HIDDEN_MS = 30 * 60 * 1000;

/**
 * @param {{enabled:boolean, syncing:boolean, connections:{id:number, lastSyncAt:string|null, paused:boolean}[], now:number, minIntervalMs?:number}} o
 * @returns {{start:boolean, reason:'disabled'|'no-connections'|'running'|'paused'|'recent'|'stale', connectionIds?:number[]}}
 */
export function decideOpenSync({ enabled, syncing, connections, now, minIntervalMs = OPEN_SYNC_MIN_INTERVAL_MS }) {
  if (!enabled) return { start: false, reason: 'disabled' };
  if (!connections || !connections.length) return { start: false, reason: 'no-connections' };
  if (syncing) return { start: false, reason: 'running' };
  const eligible = connections.filter((c) => !c.paused);
  if (!eligible.length) return { start: false, reason: 'paused' };
  const t = (s) => { const v = s ? Date.parse(s) : NaN; return Number.isFinite(v) ? v : 0; };
  const oldest = Math.min(...eligible.map((c) => t(c.lastSyncAt)));
  if (now - oldest < minIntervalMs) return { start: false, reason: 'recent' };
  return { start: true, reason: 'stale', connectionIds: eligible.map((c) => c.id) };
}

/** Real connections as decideOpenSync sees them. */
export function openSyncInputs(now = Date.now()) {
  const connections = realDb().prepare('SELECT id, last_sync_at, needs_credentials FROM connections ORDER BY id').all()
    .map((c) => ({ id: c.id, lastSyncAt: c.last_sync_at, paused: !!c.needs_credentials }));
  return { enabled: getSyncOnOpen(), syncing: isSyncing(), connections, now };
}

/**
 * Decide and, when due, start a background sync of the real connections (paused ones skipped).
 * @param {'launch'|'restore'|'resume'} trigger for the log only
 */
export function runOpenSync(trigger) {
  const d = decideOpenSync(openSyncInputs());
  if (!d.start) {
    if (d.reason !== 'no-connections' && d.reason !== 'disabled') log.info(`open sync skipped (${trigger}): ${d.reason}`);
    return d;
  }
  try {
    startSync('real', null, { skipPaused: true });
    log.info(`sync started (open:${trigger})`);
    return d;
  } catch (e) {
    return { start: false, reason: e.code === 'SYNC_RUNNING' ? 'running' : 'error' };
  }
}
