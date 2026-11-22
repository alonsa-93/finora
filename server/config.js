// Central configuration: paths, port, version. Data never lives in the project folder
// (it may sit in a synced folder) - it goes to %LOCALAPPDATA%\MoneyCash by default.
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { protectDir } from './acl.js';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = join(here, '..');
export const WEB_DIR = join(ROOT_DIR, 'web');

const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
export const VERSION = pkg.version;

function parsePort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 1023 && n < 65536 ? n : null;
}
export const DEFAULT_PORT = parsePort(process.env.PORT) ?? parsePort(process.env.MONEYCASH_PORT) ?? 4580;
export const HOST = '127.0.0.1';

// The actual listening port can change at runtime (Electron picks a free port if 4580 is taken),
// so the Host / Origin guards read it through these functions.
let port = DEFAULT_PORT;
export const getPort = () => port;
export function setPort(p) {
  if (!parsePort(p)) throw new Error('bad port');
  port = p;
}
export const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
export const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
export const appUrl = () => `http://127.0.0.1:${port}/`;

// Per-launch API secret, delivered to the window as an HttpOnly cookie. startServer refuses to run
// without one; null only with the explicit test-only switch below.
// Cookies are not port-bound (RFC 6265): every server on 127.0.0.1 would receive a cookie set by
// another. `__Host-` needs https, so the name carries the port instead: a MoneyCash instance on a
// different port neither sends nor accepts this one.
export const authCookieName = () => `mc_auth_${port}`;
let authToken = null;
// Second factor, bound to our origin. The browser still sends the cookie to any other listener on
// 127.0.0.1 the user visits, which could replay it from a non-browser client. This token reaches the
// page only in a response body (POST /api/session, or the Electron preload) and goes back in the
// X-MoneyCash header; another origin can never read it. A new one with every auth token.
let apiToken = null;
let noAuthForTests = false;
export const getAuthToken = () => authToken;
export const getApiToken = () => apiToken;
export function setAuthToken(t) {
  if (t !== null && (typeof t !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(t))) throw new Error('bad auth token');
  authToken = t;
  apiToken = t === null ? null : randomBytes(32).toString('base64url');
}
/** Test-only: /api without cookie and API token while no auth token is set (never in the app). */
export function allowNoAuthForTests() { noAuthForTests = true; }
export const noAuthAllowed = () => noAuthForTests;

/** Absolute path of a Windows system executable (never resolved via cwd / PATH). */
export function systemExe(...parts) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return join(root, 'System32', ...parts);
}

/** Paths under a OneDrive root (synced to the cloud) - never a place for code or data. */
export function isUnderOneDrive(p) {
  const target = resolve(String(p || '')).toLowerCase();
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = process.env[k];
    if (root && (target === resolve(root).toLowerCase() || target.startsWith(`${resolve(root).toLowerCase()}\\`))) return true;
  }
  return /\\onedrive( - [^\\]+)?\\/i.test(`${target}\\`);
}

/** Validate an explicit data-dir override (MONEYCASH_DATA_DIR): local, absolute, not synced. */
export function checkDataDirOverride(p) {
  if (!isAbsolute(p) || /^\\\\|^\/\//.test(p)) return 'must be a local absolute path (no UNC)';
  if (isUnderOneDrive(p)) return 'must not be inside OneDrive';
  return null;
}

let dataDirCache = null;
export function dataDir() {
  const override = process.env.MONEYCASH_DATA_DIR;
  const base = override || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'MoneyCash');
  if (dataDirCache === base) return base;
  if (override) {
    const problem = checkDataDirOverride(override);
    if (problem) throw new Error(`MONEYCASH_DATA_DIR ${problem}`);
  }
  mkdirSync(base, { recursive: true });
  // user + SYSTEM only, no inheritance (on creation and on every start). A failure does not stop the
  // app; startServer logs it and /api/status reports it (dataDirProtected).
  const acl = protectDir(base);
  dirProtected = process.platform === 'win32' ? acl.ok : null;
  mkdirSync(join(base, 'logs'), { recursive: true });
  dataDirCache = base;
  return base;
}

let dirProtected = null;
/** true / false = the protected DACL was / was not applied; null = not Windows or not checked yet. */
export const dataDirProtected = () => dirProtected;
