// The scraper's browser, launched by us (never by israeli-bank-scrapers itself):
// - pipe:true  -> DevTools talks over an anonymous pipe; Chrome never opens --remote-debugging-port,
//   so no other local process / Windows user can attach to the logged-in bank session.
// - headless, Chrome sandbox left ON (no --no-sandbox), an off-the-record browser context, so
//   cookies / storage of the bank session stay in RAM.
// - a private, throw-away profile dir under DATA_DIR\run (protected DACL), removed in finally and
//   swept at startup. userDataDir is always set, so puppeteer never makes its own %TEMP% profile;
//   %TEMP%\puppeteer_dev_* dirs belong to other tools and are left alone.
// - only a system-wide, auto-updated Chrome / Edge is used (never puppeteer's download cache).
// - exception: a connection whose site asks for a one-time code on new devices gets its own
//   persistent profile, <data dir>/profiles/conn-<id> (same protected DACL; Chrome encrypts its
//   cookies with DPAPI), so after one login with the code the site recognises this computer.
//   It is used through the default (on-the-record) context and deleted with the connection.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataDir } from './config.js';

// Chrome flags on top of puppeteer's defaults: no Safe Browsing / variations / component updates /
// crash reporting / background networking while a bank session is open.
export const HARDENING_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--safebrowsing-disable-auto-update',
  '--disable-sync',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--disable-field-trial-config',
  '--metrics-recording-only',
  '--no-pings',
  '--disable-default-apps',
  '--disable-extensions',
  '--disk-cache-size=1',
  '--disable-features=SafeBrowsing,OptimizationGuideModelDownloading,OptimizationHintsFetching,'
    + 'OptimizationTargetPrediction,OptimizationHints,MediaRouter,AutofillServerCommunication,Translate,'
    + 'CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions,PrivacySandboxSettings4',
];

const FORBIDDEN_ARG = /^--(remote-debugging-port|remote-debugging-address|remote-allow-origins|no-sandbox|disable-web-security)/;

/** Locate an installed, auto-updating Chromium browser (machine-wide first). */
export function findBrowser() {
  const pf = 'C:\\Program Files';
  const pf86 = 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    // Per-user Chrome is user-writable: last resort only.
    local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) || null;
}

const runDir = () => join(dataDir(), 'run');

function rmDir(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); return true; } catch { return false; }
}

/**
 * Remove leftover scraper profiles (crash / forced quit during a sync). Only dirs older than
 * `minAgeMs` are touched so a concurrently running scrape is never pulled from under it.
 */
export function sweepScraperProfiles({ minAgeMs = 15 * 60 * 1000 } = {}) {
  let removed = 0;
  const now = Date.now();
  const sweep = (dir, re) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!re.test(n)) continue;
      const p = join(dir, n);
      try {
        if (now - statSync(p).mtimeMs < minAgeMs) continue;
      } catch { continue; }
      if (rmDir(p)) removed += 1;
    }
  };
  sweep(runDir(), /^scrape-[A-Za-z0-9_-]+$/);
  return removed;
}

/**
 * Launch the hardened browser and an off-the-record context.
 * @returns {Promise<{ browser, context, profileDir, close: () => Promise<void> }>}
 *   context is null when no launcher is available (createScraper then fails closed instead of
 *   launching its own debuggable browser).
 */
// Light loading: what a scrape never needs - images, fonts, video and the sites' analytics / session
// recording scripts - is not downloaded. The bank and card sites load much faster this way. CSS and
// the sites' own scripts are untouched (the scrapers check element visibility). sync.js turns this
// off for a company after a failure with it on (see liteOff there).
export const LITE_BLOCKED_URLS = [
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'mp3', 'ogg']
    .flatMap((x) => [`*.${x}`, `*.${x}?*`]),
  ...['google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googleadservices.com', 'adservice.google',
    'facebook.net', 'connect.facebook', 'hotjar.com', 'hotjar.io', 'clarity.ms', 'taboola.com', 'outbrain.com',
    'glassboxdigital.io', 'glassbox', 'quantummetric.com', 'contentsquare.net', 'tiktok.com', 'linkedin.com/px',
    'bing.com/action', 'yandex', 'newrelic.com', 'nr-data.net', 'dynatrace']
    .map((d) => `*${d}*`),
];

/** Apply light loading to every page the scraper opens in this context. */
export function applyLite(context) {
  if (!context?.on) return;
  const setup = async (target) => {
    try {
      if (target.type() !== 'page') return;
      const page = await target.page();
      if (!page) return;
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: LITE_BLOCKED_URLS });
    } catch { /* the page closed, or the browser does not support it: load normally */ }
  };
  context.on('targetcreated', setup);
}

export async function launchScrapeBrowser(executablePath, { launcher, visible = false, profileDir: keep = null, lite = false } = {}) {
  const profileDir = keep || join(runDir(), `scrape-${randomBytes(9).toString('base64url')}`);
  mkdirSync(profileDir, { recursive: true });
  let browser = null;
  let context = null;
  const close = async () => {
    if (context) { try { await context.close(); } catch { /* ignore */ } }
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
      try { browser.process()?.kill(); } catch { /* ignore */ }
    }
    context = null;
    browser = null;
    if (!keep) rmDir(profileDir);
  };
  try {
    let pptr = launcher;
    if (!pptr) {
      // puppeteer-core (no config-file search, no browser download). 'puppeteer' is tried first only
      // because israeli-bank-scrapers' alias / the test stub resolve under that name.
      let mod;
      try { mod = await import('puppeteer'); } catch { mod = await import('puppeteer-core'); }
      pptr = mod.default || mod;
    }
    if (typeof pptr?.launch !== 'function') return { browser: null, context: null, profileDir, close };
    browser = await pptr.launch(launchOptions(executablePath, profileDir, { visible }));
    const args = browser.process()?.spawnargs || [];
    if (args.some((a) => FORBIDDEN_ARG.test(String(a)))) throw new Error('unsafe browser arguments');
    // Persistent profile: the default context, so the site's "known device" cookie is kept.
    // It is not ours to close (closing the browser ends it).
    if (keep) {
      const ctx = browser.defaultBrowserContext();
      if (lite) applyLite(ctx);
      return { browser, context: ctx, profileDir, close };
    }
    context = await browser.createBrowserContext();
    if (lite) applyLite(context);
    return { browser, context, profileDir, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** Persistent per-connection profile dir (see the header). */
export function connectionProfileDir(connectionId) {
  return join(dataDir(), 'profiles', `conn-${Number(connectionId)}`);
}

/** The worker accepts only a per-connection profile under <data dir>/profiles, nothing else. */
export function safeProfileDir(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  const root = resolve(dataDir(), 'profiles') + sep;
  const full = resolve(dir);
  return full.startsWith(root) && /^conn-[0-9]+$/.test(full.slice(root.length)) ? full : null;
}

/** Delete a connection's persistent profile (connection removed). */
export function removeConnectionProfile(connectionId) {
  return rmDir(connectionProfileDir(connectionId));
}

export function launchOptions(executablePath, userDataDir, { visible = false } = {}) {
  return {
    executablePath,
    headless: !visible,
    ...(visible ? { defaultViewport: null } : {}),
    pipe: true, // --remote-debugging-pipe; no TCP DevTools endpoint
    userDataDir,
    args: visible ? [...HARDENING_ARGS, '--window-size=1120,900', '--lang=he'] : [...HARDENING_ARGS],
    timeout: 60000,
    protocolTimeout: 120000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    env: cleanEnv(),
  };
}

/** Environment for the browser process: no DEBUG / proxy / Chrome-behaviour overrides. A proxy from
 * the environment would route the bank session through whatever it names (Chrome on Windows uses
 * the system proxy settings, which this does not touch). */
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(DEBUG|NODE_OPTIONS|ELECTRON_|PUPPETEER_|CHROME_|GOOGLE_API_KEY)/i.test(k)) continue;
    if (/^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}
