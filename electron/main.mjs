// MoneyCash desktop shell (Electron). Runs the existing server in-process on 127.0.0.1
// (port 4580, or a free port if taken) and shows the dashboard in one frameless, hardened window.
// Each bank sync runs in a short-lived utility process (server/sync-worker.js).
import './guard.mjs'; // MUST stay the first import: exits on NODE_OPTIONS / RUN_AS_NODE / --inspect
import {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeTheme, screen, session, nativeImage, dialog, safeStorage,
  utilityProcess, clipboard,
} from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { devModeAllowed } from '../server/devmode.js';
import { isCopyableAmount } from './clipboard-rule.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Stray scraper/puppeteer errors must not pop Electron's default dialog (full message + stack)
// nor kill the tray app. Log only the error class/code.
const logCrash = (kind) => (e) => {
  const line = `${kind}: ${e?.name || 'Error'} ${e?.code || ''}`;
  import('../server/log.js').then(({ log }) => log.error(line)).catch(() => {});
};
process.on('uncaughtException', logCrash('uncaughtException'));
process.on('unhandledRejection', logCrash('unhandledRejection'));

const ASSETS = join(here, 'assets');
const startHidden = process.argv.includes('--hidden');
const fatal = (msg) => { dialog.showErrorBox('MoneyCash', msg); app.exit(1); process.exit(1); };

// ---- start-up guards ---------------------------------------------------------------------------
// Developer mode only from an unpackaged SOURCE CHECKOUT and an explicit opt-in (`npm run dev`).
// The local install runs the stock electron.exe (isPackaged is false there too), so the checkout is
// recognised on disk instead (server/devmode.js: install marker, %LOCALAPPDATA%\Programs, .git).
const DEV = !app.isPackaged
  && devModeAllowed(process.env.MONEYCASH_DEV === '1' || process.argv.includes('--dev'), join(here, '..'));

// Debugging switches would hand the window (and its auth cookie) or the main process to any local
// process. Chromium switches are not covered by the fuses, so refuse them in every mode.
const BANNED_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins',
  'inspect', 'inspect-brk', 'inspect-port', 'inspect-publish-uid', 'js-flags', 'debug', 'debug-brk', 'remote-debugging-targets',
  'enable-logging', 'log-net-log', 'no-sandbox', 'proxy-server', 'proxy-pac-url', 'host-rules',
  'host-resolver-rules', 'user-data-dir', 'load-extension', 'disable-web-security', 'renderer-cmd-prefix',
  'utility-cmd-prefix', 'gpu-launcher', 'browser-subprocess-path', 'disable-gpu-sandbox', 'disable-site-isolation-trials',
  'enable-blink-features', 'disable-features', 'ssl-key-log-file', 'log-file', 'ignore-certificate-errors'];
const badSwitch = BANNED_SWITCHES.find((s) => app.commandLine.hasSwitch(s))
  || process.argv.slice(1).find((a) => /^--?(inspect|remote-debugging|js-flags|debug)/i.test(a));
const badNodeOptions = String(process.env.NODE_OPTIONS || '').trim() !== ''; // guard.mjs exited already; defence in depth
if (badSwitch || badNodeOptions || process.env.ELECTRON_RUN_AS_NODE) {
  // Exit at once, without a dialog: Chromium may already have opened the debugging endpoint, and a
  // modal dialog would keep it alive. Nothing has been loaded yet (no window, no cookie, no data).
  process.stderr.write('MoneyCash: refusing to start with debugging switches.\n');
  app.exit(1);
  process.exit(1);
}

const isUnder = (p, root) => {
  if (!root) return false;
  const a = resolve(p).toLowerCase();
  const b = resolve(root).toLowerCase();
  return a === b || a.startsWith(`${b}\\`);
};
const underOneDrive = (p) => ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].some((k) => isUnder(p, process.env[k]))
  || /\\onedrive( - [^\\]+)?\\/i.test(`${resolve(p)}\\`);

// The code that handles bank credentials must not run from a cloud-synced (writable-from-elsewhere)
// folder: anything that can write to OneDrive could change it.
if (!DEV && underOneDrive(app.getAppPath())) {
  fatal('MoneyCash לא יפעל מתוך תיקייה שמסונכרנת ל-OneDrive, כי כל מי שיכול לשנות קבצים ב-OneDrive '
    + 'היה יכול לשנות גם את הקוד שמטפל בפרטי הבנק.\n\nהתקן את האפליקציה מקומית (scripts\\install-local.ps1) '
    + 'והפעל אותה מקיצור הדרך MoneyCash.');
}

// Developer-only environment switches.
if (!DEV) {
  delete process.env.MONEYCASH_DATA_DIR;
  delete process.env.MONEYCASH_SMOKE_TEST;
}

// Keep Electron's own profile next to the app data (out of OneDrive, out of Roaming).
const DATA_DIR = process.env.MONEYCASH_DATA_DIR
  || join(process.env.LOCALAPPDATA || app.getPath('appData'), 'MoneyCash');
if (process.env.MONEYCASH_DATA_DIR && (!isAbsolute(DATA_DIR) || DATA_DIR.startsWith('\\\\') || underOneDrive(DATA_DIR))) {
  fatal('MONEYCASH_DATA_DIR חייב להיות נתיב מקומי מלא שאינו ב-OneDrive.');
}
mkdirSync(DATA_DIR, { recursive: true });
const ELECTRON_DIR = join(DATA_DIR, 'electron');
// A wipe could not delete Electron's (locked) profile while it was running: finish it now.
if (existsSync(join(DATA_DIR, 'wipe-pending'))) {
  try { rmSync(ELECTRON_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
  try { rmSync(join(DATA_DIR, 'wipe-pending'), { force: true }); } catch { /* ignore */ }
}
app.setPath('userData', ELECTRON_DIR);
app.setPath('crashDumps', join(ELECTRON_DIR, 'Crashpad'));
app.setAppUserModelId('com.moneycash.app');
// puppeteer & co. must never resolve config files relative to where we were started from.
try { process.chdir(DATA_DIR); } catch { /* keep cwd */ }

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---- persisted desktop settings + window state ------------------------------------------------
const DESKTOP_FILE = join(DATA_DIR, 'desktop.json');
function loadDesktop() {
  try { return JSON.parse(readFileSync(DESKTOP_FILE, 'utf8')); } catch { return {}; }
}
let desktop = { closeToTray: true, trayHintShown: false, bounds: null, maximized: false, ...loadDesktop() };
let wiped = false; // after "delete all data" nothing may be written again
function saveDesktop() {
  if (wiped) return;
  try { writeFileSync(DESKTOP_FILE, JSON.stringify(desktop, null, 2), 'utf8'); } catch { /* ignore */ }
}

function loginItemArgs() {
  // Unpackaged (dev, or the local install that runs the stock electron.exe) needs the app path.
  return app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
}
// Distinct registry value names so the dev build never overwrites/removes the installed app's entry.
const LOGIN_ITEM_NAME = DEV ? 'MoneyCash-dev' : 'MoneyCash';
function getOpenAtLogin() {
  return app.getLoginItemSettings({ args: loginItemArgs(), name: LOGIN_ITEM_NAME }).openAtLogin;
}
function setOpenAtLogin(v) {
  app.setLoginItemSettings({ openAtLogin: !!v, args: loginItemArgs(), name: LOGIN_ITEM_NAME });
}

let win = null;
let tray = null;
let server = null;
let apiToken = null; // server/config.js getApiToken(), handed to our window by the preload
let quitting = false;
let dbModule = null; // server/db.js, for a synchronous final flush on quit
let hiddenSince = null; // when the window went to the tray (or launch time for --hidden)

const bg = () => (nativeTheme.shouldUseDarkColors ? '#111315' : '#f6f7f9');

function restoreBounds() {
  const b = desktop.bounds;
  if (!b || typeof b.width !== 'number') return { width: 1280, height: 820 };
  // Only reuse the position if it is still visible on a connected display.
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y >= a.y - 10 && b.y < a.y + a.height - 50;
  });
  return visible ? b : { width: b.width, height: b.height };
}

let saveTimer = null;
function rememberBounds() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    desktop.maximized = win.isMaximized();
    if (!win.isMaximized() && !win.isMinimized()) desktop.bounds = win.getBounds();
    saveDesktop();
  }, 400);
}

const isAppUrl = (url) => {
  try { return new URL(url).origin === new URL(server.url).origin; } catch { return false; }
};
const fromOurWindow = (event) => !!win && event.sender === win.webContents && isAppUrl(event.senderFrame?.url || '');

function createWindow() {
  win = new BrowserWindow({
    ...restoreBounds(),
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: bg(),
    title: 'MoneyCash',
    icon: join(ASSETS, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged && DEV,
    },
  });
  if (desktop.maximized) win.maximize();

  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  // Sync on open, part 2: back from the tray after a long time hidden -> same rules as at launch
  // (server/opensync.js: setting on, real connections, none running, none paused, not synced in 30 min).
  if (startHidden && hiddenSince === null) hiddenSince = Date.now();
  win.on('hide', () => { hiddenSince = Date.now(); });
  win.on('show', () => {
    const since = hiddenSince;
    hiddenSince = null;
    if (since === null) return;
    import('../server/opensync.js').then(({ runOpenSync, RESTORE_AFTER_HIDDEN_MS }) => {
      if (Date.now() - since > RESTORE_AFTER_HIDDEN_MS) runOpenSync('restore');
    }).catch(() => {});
  });
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('maximize', () => { rememberBounds(); win.webContents.send('mc:maximized-changed', true); });
  win.on('unmaximize', () => { rememberBounds(); win.webContents.send('mc:maximized-changed', false); });
  win.on('close', (e) => {
    rememberBounds();
    if (!quitting && desktop.closeToTray) {
      e.preventDefault();
      win.hide();
      if (!desktop.trayHintShown && tray) {
        tray.displayBalloon({ title: 'MoneyCash ממשיך לפעול', content: 'האפליקציה במגש המערכת כדי שהסנכרון היומי ימשיך. לסגירה מלאה: לחיצה ימנית על הסמל ← יציאה.', iconType: 'info' });
        desktop.trayHintShown = true;
        saveDesktop();
      }
    }
  });
  win.on('closed', () => { win = null; });

  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('will-frame-navigate', (e) => { if (!isAppUrl(e.url)) e.preventDefault(); });

  win.loadURL(server.url);
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function syncNow() {
  const { runRealSync } = await import('../server/main.js');
  runRealSync('tray', { followUi: true });
  showWindow();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'פתח', click: showWindow },
    { label: 'סנכרן עכשיו', click: () => { syncNow(); } },
    { type: 'separator' },
    {
      label: 'מזער למגש בסגירת החלון', type: 'checkbox', checked: desktop.closeToTray,
      click: (item) => { desktop.closeToTray = item.checked; saveDesktop(); },
    },
    {
      label: 'הפעל עם Windows', type: 'checkbox', checked: getOpenAtLogin(),
      click: (item) => setOpenAtLogin(item.checked),
    },
    { type: 'separator' },
    { label: 'יציאה', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const img = nativeImage.createFromPath(join(ASSETS, 'tray.png'));
  img.addRepresentation({ scaleFactor: 2, buffer: readFileSync(join(ASSETS, 'tray@2x.png')) });
  tray = new Tray(img);
  tray.setToolTip('MoneyCash');
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
  tray.setContextMenu(null);
}

function hardenSession(origin) {
  const ses = session.defaultSession;
  // No remote content: only our own server (and devtools in dev).
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    const ok = u.startsWith(`${origin}/`) || u === origin || (DEV && u.startsWith('devtools://')) || u.startsWith('data:')
      || u.startsWith('blob:');
    cb({ cancel: !ok });
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // CSV export: suggest Downloads (not the OneDrive-synced Desktop / Documents).
  ses.on('will-download', (_e, item) => {
    try { item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) }); } catch { /* ignore */ }
  });
}

function registerIpc() {
  ipcMain.on('mc:app-info', (event) => {
    if (!fromOurWindow(event)) { event.returnValue = {}; return; }
    // apiToken: the second factor every /api call sends in X-MoneyCash (server/config.js). Our window
    // gets it here, in memory, as browser mode gets it from POST /api/session.
    event.returnValue = { version: app.getVersion(), platform: process.platform, apiToken: apiToken || '' };
  });
  ipcMain.on('mc:win', (event, action) => {
    if (!fromOurWindow(event)) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'toggleMaximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close(); // 'close' handler applies closeToTray
  });
  // "Copy amount": the renderer has no clipboard permission (every permission request is refused),
  // so the preload asks main. Only short amount text from our own window is ever written.
  ipcMain.handle('mc:clipboard-write', (event, text) => {
    if (!fromOurWindow(event) || !isCopyableAmount(text)) return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('mc:win-is-maximized', (event) => (fromOurWindow(event) ? win.isMaximized() : false));
  ipcMain.handle('mc:settings-get', (event) => {
    if (!fromOurWindow(event)) return null;
    return { closeToTray: desktop.closeToTray, openAtLogin: getOpenAtLogin() };
  });
  ipcMain.handle('mc:settings-set', (event, patch) => {
    if (!fromOurWindow(event) || !patch || typeof patch !== 'object') return null;
    if (typeof patch.closeToTray === 'boolean') { desktop.closeToTray = patch.closeToTray; saveDesktop(); }
    if (typeof patch.openAtLogin === 'boolean') setOpenAtLogin(patch.openAtLogin);
    return { closeToTray: desktop.closeToTray, openAtLogin: getOpenAtLogin() };
  });
}

/** After POST /api/wipe deleted the data: clear Electron's storage, drop autostart, restart. */
async function finishWipe() {
  wiped = true;
  quitting = true;
  try { setOpenAtLogin(false); } catch { /* ignore */ }
  try {
    const ses = session.defaultSession;
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
    await ses.clearHostResolverCache();
  } catch { /* the folder itself is removed on the next start (wipe-pending marker) */ }
  const keepHidden = DEV && process.env.MONEYCASH_SMOKE_TEST; // dev smoke check: no window pop-up
  // Unpackaged, argv[1] is the app path, possibly relative ('.'): we chdir'd to DATA_DIR, so pass it absolute.
  const flags = process.argv.slice(1).filter((a) => a.startsWith('--') && (keepHidden || a !== '--hidden'));
  app.relaunch({ args: app.isPackaged ? flags : [app.getAppPath(), ...flags] });
  app.exit(0);
}

/** utilityProcess adapter for server/sync-runner.js. */
async function utilityAdapterFactory() {
  const { WORKER_PATH, workerEnv } = await import('../server/sync-runner.js');
  return () => {
    const child = utilityProcess.fork(WORKER_PATH, [], {
      serviceName: 'MoneyCash sync', stdio: 'ignore', env: workerEnv(), cwd: DATA_DIR,
    });
    return {
      post: (m) => child.postMessage(m),
      onMessage: (cb) => child.on('message', cb),
      onExit: (cb) => { child.on('exit', cb); child.on('error', cb); },
      kill: () => { try { child.kill(); } catch { /* ignore */ } },
    };
  };
}

app.on('second-instance', () => { if (server) showWindow(); });
let abortDone = false;
app.on('before-quit', (e) => {
  quitting = true;
  // A running scrape holds a logged-in bank session: close its browser before we go.
  if (!abortDone && server) {
    e.preventDefault();
    abortDone = true;
    import('../server/sync.js').then(({ abortSync }) => abortSync()).catch(() => {}).finally(() => app.quit());
  }
});
app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
nativeTheme.on('updated', () => { if (win) win.setBackgroundColor(bg()); });

async function askStartOver(message) {
  const r = await dialog.showMessageBox({
    type: 'warning', title: 'MoneyCash', message: 'לא ניתן לפתוח את הנתונים', detail: message,
    buttons: ['התחל מחדש (מחק את הנתונים הישנים)', 'יציאה'], defaultId: 1, cancelId: 1, noLink: true,
  });
  return r.response === 0;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  process.env.MONEYCASH_DATA_DIR = DATA_DIR;
  const keys = await import('../server/keys.js');
  keys.setSafeStorage(safeStorage); // DPAPI-backed, in-process key wrapping
  const { startServer } = await import('../server/main.js');
  dbModule = await import('../server/db.js');
  const { setScrapeRunner } = await import('../server/sync.js');
  const { makeWorkerRunner } = await import('../server/sync-runner.js');
  setScrapeRunner(makeWorkerRunner(await utilityAdapterFactory()));
  // Per-launch API secret, handed to our window only as an HttpOnly session cookie (never on
  // disk): other local processes / Windows users reaching 127.0.0.1 get 401 from /api.
  const authToken = randomBytes(32).toString('base64url');
  try {
    await keys.ensureKeyAsync(); // safeStorage (in-process DPAPI) first, PowerShell DPAPI as fallback
    server = await startServer({ port: 4580, fallbackToFreePort: true, authToken, onWipe: () => { finishWipe(); } });
    const { authCookieName, getApiToken } = await import('../server/config.js');
    apiToken = getApiToken();
    await session.defaultSession.cookies.set({
      url: server.url, name: authCookieName(), value: authToken, httpOnly: true, sameSite: 'strict', path: '/',
    });
  } catch (e) {
    if (e.code === 'KEY_UNAVAILABLE') {
      if (await askStartOver(keys.KEY_UNAVAILABLE_HE)) {
        const { wipeAllData } = await import('../server/wipe.js');
        try { await wipeAllData(); } catch { /* best effort */ }
        await finishWipe();
        return;
      }
      app.exit(1);
      return;
    }
    dialog.showErrorBox('MoneyCash', `לא ניתן להפעיל את השרת המקומי (${e.code || e.name}).`);
    app.exit(1);
    return;
  }
  hardenSession(new URL(server.url).origin);
  registerIpc();
  createTray();
  const smoke = DEV ? process.env.MONEYCASH_SMOKE_TEST : undefined;
  if (smoke) {
    // Dev-only build check: report what the window loaded, then quit.
    const note = (s) => { try { writeFileSync(smoke, `${s}\n`, { flag: 'a' }); } catch { /* ignore */ } };
    note(`server=${server.url}`);
    app.once('browser-window-created', (_e, w) => {
      w.webContents.on('did-fail-load', (_ev, code, desc, url) => note(`fail-load ${code} ${desc} ${url}`));
      w.webContents.on('preload-error', (_ev, p, err) => note(`preload-error ${err?.message}`));
      w.webContents.once('did-finish-load', async () => {
        try {
          note(`page=${await w.webContents.executeJavaScript('document.title + " | moneycash=" + typeof window.moneycash + " | version=" + (window.moneycash && window.moneycash.version) + " | require=" + typeof require')}`);
          note(`status=${await w.webContents.executeJavaScript('fetch("/api/status", { headers: { "X-MoneyCash": window.moneycash.apiToken } }).then(r => r.json()).then(j => JSON.stringify(j))')}`);
          note(`external=${await w.webContents.executeJavaScript('fetch("https://example.com").then(() => "LOADED").catch(() => "blocked")')}`);
          note(`maximized=${await w.webContents.executeJavaScript('window.moneycash.window.isMaximized()')}`);
          let already = '';
          try { already = readFileSync(smoke, 'utf8'); } catch { /* none */ }
          if (process.env.MONEYCASH_SMOKE_WIPE === '1' && !already.includes('wipe=')) {
            // Dev-only check of the full "delete all data" flow (wipe -> clear storage -> relaunch).
            note(`wipe=${await w.webContents.executeJavaScript('fetch("/api/wipe", { method: "POST", headers: { "Content-Type": "application/json", "X-MoneyCash": window.moneycash.apiToken }, body: JSON.stringify({ confirm: "מחק" }) }).then(r => r.status + " " + JSON.stringify(Object.keys(localStorage)))')}`);
            return; // finishWipe() relaunches
          }
        } catch (e) { note(`error ${e.message}`); }
        quitting = true;
        app.quit();
      });
    });
    setTimeout(() => { note('timeout'); quitting = true; app.quit(); }, 30000).unref();
  }
  createWindow();
});

app.on('will-quit', () => {
  // Persist synchronously: the async server.close() callback may not run before exit.
  if (!wiped) { try { dbModule?.flushAll(); } catch { /* logged */ } }
  if (server) server.close();
});
