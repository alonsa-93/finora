// Reusable server bootstrap, used by the CLI (server/index.js) and the Electron shell.
import './harden-env.js'; // must stay the first import
import { createApp } from './app.js';
import {
  HOST, DEFAULT_PORT, setPort, getPort, appUrl, dataDir, setAuthToken, allowNoAuthForTests, dataDirProtected,
} from './config.js';
import { realDb, isDemoMode, activeDb, getAutoSync, realConnectionCount } from './state.js';
import { getSetting, setSetting, closeAll } from './db.js';
import { sweepScraperProfiles } from './browser.js';
import { checkDiskEncryption } from './diskcheck.js';
import { consumeBootstrap } from './session.js';
import { startSync, isSyncing } from './sync.js';
import { todayISO } from './dates.js';
import { log, securityEvent } from './log.js';
import { loadScrapersMeta } from './companies.js';
import { runOpenSync } from './opensync.js';
import { backupOnVersionChange } from './safety.js';
import { VERSION } from './config.js';

const pad = (n) => String(n).padStart(2, '0');
const localHHMM = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Start a real sync of all connections (used by scheduler and the tray "sync now"). */
export function runRealSync(reason, { followUi = false } = {}) {
  if (isSyncing()) return false;
  try {
    // followUi (tray "sync now"): behave like the in-app button — demo mode syncs the demo data the
    // user is looking at. Scheduled syncs always refresh real data in the background.
    const demo = isDemoMode() && (followUi || realConnectionCount() === 0);
    startSync(demo ? 'demo' : 'real');
    log.info(`sync started (${reason})`);
    return true;
  } catch (e) {
    log.warn(`sync not started (${reason}): ${e.code || 'error'}`);
    return false;
  }
}

/** True when every real connection's last sync is later than today at HH:MM (local time). */
export function syncedSinceToday(hhmm, db = realDb(), now = new Date()) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 0, m || 0).getTime();
  const rows = db.prepare('SELECT last_sync_at FROM connections').all();
  return rows.length > 0 && rows.every((r) => r.last_sync_at && Date.parse(r.last_sync_at) >= since);
}

let schedulerStarted = false;
function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const tick = () => {
    const a = getAutoSync();
    if (!a.enabled || realConnectionCount() === 0) return;
    const today = localDate();
    if (localHHMM() < a.time) return;
    if (getSetting(realDb(), 'lastAutoSyncDate') === today) return;
    // Already fresh: every connection synced (ok or failed) after today's scheduled time, e.g. the
    // sync on open that just ran. A second full run would only log in to every bank again.
    if (syncedSinceToday(a.time)) { setSetting(realDb(), 'lastAutoSyncDate', today); return; }
    if (runRealSync('daily')) setSetting(realDb(), 'lastAutoSyncDate', today);
  };
  setInterval(tick, 60 * 1000).unref();

  // Catch-up shortly after start if the oldest real connection sync is older than 24h.
  setTimeout(() => {
    if (!getAutoSync().enabled || realConnectionCount() === 0) return;
    const last = realDb().prepare("SELECT MIN(IFNULL(last_sync_at, '1970-01-01')) AS t FROM connections").get().t;
    if (Date.now() - new Date(last).getTime() > 24 * 3600 * 1000) {
      if (runRealSync('catch-up') && localHHMM() >= getAutoSync().time) setSetting(realDb(), 'lastAutoSyncDate', localDate());
    }
  }, 15 * 1000).unref();
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/**
 * Start the HTTP server on 127.0.0.1.
 * @param {{ port?: number, fallbackToFreePort?: boolean, authToken?: string, onWipe?: () => void, openSync?: boolean,
 *   insecureNoAuthForTests?: boolean }} opts
 *   openSync: run the sync-on-open check after listening (default true; see opensync.js).
 *   authToken: required. Every /api request must carry it in the mc_auth cookie (plus the API token,
 *   config.js), so other local processes / other Windows users cannot read the data through the port.
 *   insecureNoAuthForTests: the test suite only; without it a missing token is an error (fail closed).
 * @returns {Promise<{ server, port, url, close }>}
 */
export async function startServer({
  port = DEFAULT_PORT, fallbackToFreePort = false, authToken, onWipe = null, openSync = true, insecureNoAuthForTests = false,
} = {}) {
  if (authToken !== undefined) setAuthToken(authToken);
  else if (insecureNoAuthForTests === true) allowNoAuthForTests();
  else throw new Error('startServer needs an authToken');
  const t0 = Date.now();
  dataDir(); // creates the folder and applies the protected DACL
  if (dataDirProtected() === false) securityEvent('acl_failed', 'data folder permissions could not be restricted', { rateKey: null });
  // First start of a new version: copy the connections aside before anything reads or migrates them.
  try {
    const b = backupOnVersionChange(dataDir(), VERSION);
    if (b.backedUp) log.info(`upgrade ${b.from || 'earlier'} -> ${b.to}: connections backed up to backups\\`);
  } catch (e) {
    log.warn(`upgrade backup failed (${e.code || e.name}); retried on the next start`);
  }
  try { sweepScraperProfiles(); } catch { /* best effort */ }
  const tSweep = Date.now();
  realDb(); // unwraps the data key (throws code KEY_UNAVAILABLE if it cannot) and migrates legacy files
  const tDb = Date.now();
  if (isDemoMode()) activeDb(); // builds demo.db for today if needed
  loadScrapersMeta().catch(() => {});

  checkDiskEncryption().catch(() => {});

  const app = createApp({ onWipe, onSession: consumeBootstrap });
  let server;
  try {
    server = await listen(app, port);
  } catch (e) {
    if (e.code !== 'EADDRINUSE' || !fallbackToFreePort) throw e;
    log.warn(`port ${port} in use - picking a free port`);
    server = await listen(app, 0);
  }
  setPort(server.address().port);
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  log.info(`Finora listening on ${appUrl()} demo=${isDemoMode()} today=${todayISO()}`
    + ` start_ms=${Date.now() - t0} (folder=${tSweep - t0} data=${tDb - tSweep}) since_launch_ms=${Math.round(process.uptime() * 1000)}`);
  startScheduler();
  // Sync on open: refresh the real connections right away (opensync.js has the rules). The window
  // that loads next picks the running sync up from /api/sync/status, with no click.
  if (openSync) runOpenSync('launch');
  return {
    server,
    port: getPort(),
    url: appUrl(),
    close: () => new Promise((resolve) => {
      server.close(() => { closeAll(); resolve(); });
      server.closeAllConnections?.();
    }),
  };
}
