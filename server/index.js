// CLI entry: `npm start` (opens the default browser) or `node server/index.js --no-open`.
// Port: env PORT (or FINORA_PORT), default 4580.
//
// Browser mode is authenticated like the desktop app: a per-launch session token is required on
// every /api call (HttpOnly SameSite=Strict cookie, plus the API token in X-Finora, config.js).
// The browser receives both through a one-time bootstrap URL http://127.0.0.1:<port>/auth#<one-time
// token> that expires after 2 minutes (see session.js).
// If the port is taken we exit with an error and never open whatever is listening there.
//
// Flags: --no-open, --dev (allow running from a OneDrive folder), --reset-data (start over when
// the stored data can no longer be decrypted, e.g. after a Windows password reset),
// --app-window: the desktop window without Electron. Smart App Control can stop trusting the
// unsigned electron.exe; Node.js and Microsoft Edge are signed. The dashboard opens in an Edge app
// window with its own profile (<data dir>\edge-window). See app-window.js: one Finora at a time
// (a second launch asks the running one for a window), and closing the window stops the server only
// once no sync is running (pid in <data dir>\run\app-window.json).
import './harden-env.js'; // must stay the first import
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { devModeAllowed } from './devmode.js';
import { profileInUse, watchWindow, requestShow, watchShowRequests, isOurServerCommandLine } from './app-window.js';

const argv = process.argv.slice(2);
const appWindow = argv.includes('--app-window');
const noOpen = argv.includes('--no-open') && !appWindow;
const here = dirname(fileURLToPath(import.meta.url));
// Developer mode only from a source checkout (never from the local install), see devmode.js.
const wantDev = argv.includes('--dev') || process.env.FINORA_DEV === '1';
const dev = devModeAllowed(wantDev, join(here, '..'));
if (wantDev && !dev) process.stderr.write('Finora: developer mode is available only from the source folder; starting normally.\n');
if (!dev) {
  delete process.env.FINORA_DATA_DIR;
  delete process.env.FINORA_SMOKE_TEST;
}

const config = await import('./config.js');
const fail = (msg) => { process.stderr.write(`${msg}\n`); process.exit(1); };

if (!dev && config.isUnderOneDrive(here)) {
  fail('Finora לא יפעל מתוך תיקייה שמסונכרנת ל-OneDrive. התקן אותו עם scripts\\install-local.ps1, '
    + 'או הפעל במצב פיתוח (npm start -- --dev).');
}

// Never resolve config files (puppeteer, etc.) relative to wherever the user started us.
try { process.chdir(config.dataDir()); } catch (e) { fail(`Finora: ${e.message}`); }

const { log } = await import('./log.js');
const { finishPendingWipe } = await import('./wipe.js');
finishPendingWipe(join(config.dataDir(), 'electron'));

const pidFile = () => join(config.dataDir(), 'run', 'app-window.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Command line of a process ('' if unknown). pid is an integer; PowerShell by absolute path, no shell. */
function commandLineOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    return execFileSync(config.systemExe('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive',
      '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}

/** A running --app-window server (the user clicked the shortcut again): it opens a window and this
 * launch exits, so a sync in progress is never cut short. Only if it does not answer (hung) is it
 * stopped, with its whole tree. Only a node.exe with the recorded pid whose command line runs this
 * server\index.js with --app-window is touched. */
async function handOffOrReplace() {
  let pid = null;
  try { pid = JSON.parse(readFileSync(pidFile(), 'utf8')).pid; } catch { return; }
  if (!Number.isInteger(pid) || pid === process.pid) return;
  let isNode = false;
  try {
    const out = execFileSync(config.systemExe('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    isNode = /^"node\.exe"/i.test(out.trim());
  } catch { /* treat as gone */ }
  if (!isNode) return;
  if (await requestShow(join(config.dataDir(), 'run'))) {
    log.info('another Finora is running: it opens the window');
    process.exit(0);
  }
  // The recorded pid may have been reused by an unrelated node.exe since: kill only our own server.
  if (!isOurServerCommandLine(commandLineOf(pid), fileURLToPath(import.meta.url))) {
    log.warn('the recorded Finora process is gone (pid reused by another program): not touching it');
    return;
  }
  log.warn('the running Finora did not answer: replacing it');
  // The whole tree: its sync worker, the worker's Chrome and its Edge window. Killing only node left
  // a scrape Chrome holding the connection's profile (the next sync then failed) and an old window.
  try {
    execFileSync(config.systemExe('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    try { process.kill(pid); } catch { return; }
  }
  for (let i = 0; i < 40; i++) { // up to ~4 s for its port to close
    try { process.kill(pid, 0); } catch { return; }
    await sleep(100);
  }
}

function edgePath() {
  const cands = [
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return cands.find((c) => existsSync(c)) || null;
}

const edgeProfile = () => join(config.dataDir(), 'edge-window');

/** The dashboard in its own Edge app window (a new window in the running Edge when one is open). */
function openAppWindow(url) {
  const edge = edgePath();
  if (!edge) { openDefaultBrowser(url); return false; }
  const profile = edgeProfile();
  const child = spawn(edge, [
    `--user-data-dir=${profile}`, `--app=${url}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--window-size=1440,920', '--lang=he',
  ], { stdio: 'ignore', windowsHide: false });
  child.on('error', () => openDefaultBrowser(url));
  return true;
}

function openDefaultBrowser(url) {
  if (noOpen) return;
  try {
    // rundll32 hands the URL to the default browser; the URL is our own constant.
    const child = spawn(config.systemExe('rundll32.exe'), ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* ignore */ }
}

process.on('unhandledRejection', (e) => log.error(`unhandledRejection: ${e?.name || 'Error'} ${e?.code || ''}`));

if (argv.includes('--reset-data')) {
  const keys = await import('./keys.js');
  const { wipeAllData } = await import('./wipe.js');
  if (!keys.hasKeyFile() || (() => { try { keys.ensureKey(); return false; } catch { return true; } })()) {
    await wipeAllData();
    process.stdout.write('הנתונים הישנים נמחקו. Finora יתחיל כהתקנה חדשה.\n');
  } else {
    fail('הנתונים נפתחים כרגיל במחשב הזה, ולכן לא נמחק דבר. למחיקת הכול השתמש ב"מחיקת כל הנתונים" בהגדרות.');
  }
}

const { startServer } = await import('./main.js');
const { setScrapeRunner } = await import('./sync.js');
const { makeWorkerRunner } = await import('./sync-runner.js');
const { armBootstrap } = await import('./session.js');

setScrapeRunner(makeWorkerRunner()); // each scrape runs in its own short-lived process

if (appWindow) await handOffOrReplace();

let s;
try {
  s = await startServer({
    port: config.DEFAULT_PORT,
    authToken: randomBytes(32).toString('base64url'),
    onWipe: () => restart(),
  });
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    fail(`הפורט ${config.DEFAULT_PORT} כבר תפוס. ייתכן ש-Finora כבר פועל (או תוכנה אחרת משתמשת בפורט). `
      + 'סגור אותו ונסה שוב, או הפעל עם PORT=<מספר אחר>.');
  }
  if (e.code === 'KEY_UNAVAILABLE') {
    const { KEY_UNAVAILABLE_HE } = await import('./keys.js');
    fail(`${KEY_UNAVAILABLE_HE}\nכדי להתחיל מחדש: npm start -- --reset-data`);
  }
  log.error(`server failed to start: ${e.code || e.name}`);
  process.exit(1);
}

const url = `${s.url}auth#${armBootstrap()}`;
const shutdown = async () => {
  const { abortSync } = await import('./sync.js');
  await abortSync();
  await s.close();
  if (appWindow) { try { unlinkSync(pidFile()); } catch { /* gone */ } }
  process.exit(0);
};
if (appWindow) {
  try { mkdirSync(join(config.dataDir(), 'run'), { recursive: true }); writeFileSync(pidFile(), JSON.stringify({ pid: process.pid })); } catch { /* best effort */ }
  const { isSyncing } = await import('./sync.js');
  if (openAppWindow(url)) {
    const watcher = watchWindow({
      isOpen: () => profileInUse(edgeProfile()),
      isBusy: () => isSyncing(),
      onBusyClose: () => log.info('window closed: finishing the sync in the background, then exiting'),
      onAllClosed: () => shutdown(),
    });
    watchShowRequests(join(config.dataDir(), 'run'), () => {
      openAppWindow(`${s.url}auth#${armBootstrap()}`);
      watcher.reopened();
    });
  }
} else {
  openDefaultBrowser(url);
}
if (noOpen) process.stdout.write(`פתח בדפדפן (קישור חד-פעמי): ${url}\n`);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function restart() {
  await s.close();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== '--reset-data')],
    { detached: true, stdio: 'ignore', windowsHide: true, cwd: config.dataDir() });
  child.unref();
  process.exit(0);
}
