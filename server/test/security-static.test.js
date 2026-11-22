// Security regression suite - static checks (no server): safe DOM rendering in web/assets/js,
// CSP-compatible web/index.html, and Electron hardening in electron/main.mjs, electron/preload.cjs
// and the electron-builder fuses in package.json. Read-only: never modifies the scanned files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

function walk(dir, ext, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, ext, out); else if (f.endsWith(ext)) out.push(p);
  }
  return out;
}

/** Remove block and line comments (keeps strings; a "//" inside a string literal is left alone). */
function stripComments(src) {
  let out = ''; let i = 0; let quote = null;
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    out += c; i++;
  }
  return out;
}

// ---- 9. safe rendering ---------------------------------------------------------------------------

const SINKS = [
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\s*\.\s*write(ln)?\b/],
  ['eval', /(^|[^.\w$])eval\s*\(/],
  ['new Function', /\bnew\s+Function\s*\(/],
  ['Function(...)', /(^|[^.\w$])Function\s*\(\s*['"`]/],
  ['string setTimeout', /\bsetTimeout\s*\(\s*['"`]/],
  ['string setInterval', /\bsetInterval\s*\(\s*['"`]/],
  ['srcdoc', /\bsrcdoc\b/],
  ['createContextualFragment', /\bcreateContextualFragment\b/],
  ['DOMParser', /\bDOMParser\b/],
  ['javascript: URL', /javascript:/i],
];

test('rendering: web/assets/js uses no HTML-string / code-string sinks', () => {
  const files = walk(join(ROOT, 'web', 'assets', 'js'), '.js');
  assert.ok(files.length > 5, 'found the dashboard scripts');
  const hits = [];
  for (const f of files) {
    const lines = stripComments(readFileSync(f, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const [name, re] of SINKS) if (re.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1} ${name}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('rendering: web/index.html has no inline script, inline style, event handlers or external URLs', () => {
  const html = read('web', 'index.html');
  const problems = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (m[2].trim()) problems.push(`inline <script> content: ${m[2].trim().slice(0, 60)}`);
    if (!/\bsrc\s*=/.test(m[1])) problems.push(`<script> without src: ${m[0].slice(0, 60)}`);
  }
  if (/<style\b/i.test(html)) problems.push('inline <style> block');
  for (const m of html.matchAll(/\sstyle\s*=/gi)) problems.push(`style="" attribute at ${m.index}`);
  for (const m of html.matchAll(/\son[a-z]+\s*=/gi)) problems.push(`inline event handler at ${m.index}: ${html.slice(m.index, m.index + 30)}`);
  for (const m of html.matchAll(/\b(?:src|href|action|srcset|poster|data)\s*=\s*["']?\s*((?:[a-z][a-z0-9+.-]*:)?\/\/[^"'\s>]*|[a-z][a-z0-9+.-]*:[^"'\s>]*)/gi)) {
    if (!/^data:/i.test(m[1])) problems.push(`external / scheme URL: ${m[1]}`);
  }
  for (const m of html.matchAll(/url\(\s*["']?(https?:)?\/\//gi)) problems.push(`external url() at ${m.index}`);
  if (/<base\b/i.test(html)) problems.push('<base> element');
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(html)) problems.push('meta refresh');
  if (/<(iframe|object|embed|frame)\b/i.test(html)) problems.push('embedded frame / object');
  assert.deepEqual(problems, []);
});

test('rendering: CSS and JS assets reference no external URLs', () => {
  const problems = [];
  for (const f of [...walk(join(ROOT, 'web', 'assets', 'css'), '.css'), ...walk(join(ROOT, 'web', 'assets', 'js'), '.js')]) {
    const src = stripComments(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/(https?:)?\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/gi)) {
      if (/^https?:\/\/(www\.)?w3\.org$/i.test(m[0])) continue; // SVG namespace string, not a fetch
      problems.push(`${relative(ROOT, f)}: ${m[0]}`);
    }
    if (/@import\s+(url\()?\s*["']?(https?:)?\/\//i.test(src)) problems.push(`${relative(ROOT, f)}: remote @import`);
  }
  assert.deepEqual(problems, []);
});

// ---- 10. Electron hardening ---------------------------------------------------------------------

const MAIN = stripComments(read('electron', 'main.mjs'));
const PRELOAD = stripComments(read('electron', 'preload.cjs'));

function webPreferencesBlocks(src) {
  const blocks = [];
  for (const m of src.matchAll(/webPreferences\s*:\s*\{/g)) {
    let depth = 0; let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    blocks.push(src.slice(m.index, i + 1));
  }
  return blocks;
}

test('electron: every BrowserWindow uses contextIsolation, no nodeIntegration, sandbox, webSecurity on', () => {
  const windows = [...MAIN.matchAll(/new\s+BrowserWindow\s*\(/g)].length;
  const blocks = webPreferencesBlocks(MAIN);
  assert.ok(windows >= 1, 'a BrowserWindow is created');
  assert.equal(blocks.length, windows, 'every BrowserWindow has explicit webPreferences');
  for (const b of blocks) {
    assert.match(b, /contextIsolation\s*:\s*true\b/);
    assert.match(b, /nodeIntegration\s*:\s*false\b/);
    assert.match(b, /sandbox\s*:\s*true\b/);
    assert.match(b, /webviewTag\s*:\s*false\b/);
    assert.doesNotMatch(b, /webSecurity\s*:/, 'webSecurity left at its secure default');
    assert.doesNotMatch(b, /nodeIntegrationIn(SubFrames|Worker)\s*:\s*true/);
    assert.doesNotMatch(b, /allowRunningInsecureContent\s*:\s*true/);
    assert.doesNotMatch(b, /experimentalFeatures\s*:\s*true/);
    assert.doesNotMatch(b, /enableBlinkFeatures/);
  }
  assert.doesNotMatch(MAIN, /webSecurity\s*:\s*false/);
  // The refused-switches list names them on purpose; nowhere else may they appear.
  const denylist = MAIN.match(/const BANNED_SWITCHES = \[[\s\S]*?\];/);
  assert.ok(denylist, 'main.mjs refuses a list of Chromium switches');
  assert.match(denylist[0], /'disable-web-security'/);
  assert.match(denylist[0], /'ignore-certificate-errors'/);
  assert.doesNotMatch(MAIN.replace(denylist[0], ''), /disable-web-security|ignore-certificate-errors|allow-insecure-localhost/);
  assert.doesNotMatch(MAIN, /appendSwitch\s*\(\s*['"](remote-debugging|inspect|js-flags)/);
  assert.doesNotMatch(MAIN, /devTools\s*:\s*true/, 'devtools never forced on');
  assert.match(MAIN, /devTools\s*:\s*!app\.isPackaged/);
});

test('electron: navigation and new-window handlers block foreign URLs', () => {
  assert.match(MAIN, /setWindowOpenHandler\s*\(\s*\(\)\s*=>\s*\(\s*\{\s*action\s*:\s*['"]deny['"]\s*\}\s*\)\s*\)/);
  assert.match(MAIN, /on\(\s*['"]web-contents-created['"][\s\S]{0,200}setWindowOpenHandler\s*\(\s*\(\)\s*=>\s*\(\s*\{\s*action\s*:\s*['"]deny['"]/,
    'deny window.open for every webContents, not just the main window');
  for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    assert.match(MAIN, new RegExp(`on\\(\\s*['"]${ev}['"][^\\n]*preventDefault\\(\\)`), ev);
  }
  assert.match(MAIN, /on\(\s*['"]will-attach-webview['"][^\n]*preventDefault\(\)/);
  assert.match(MAIN, /isAppUrl\s*=\s*\(url\)\s*=>[\s\S]{0,120}new URL\(url\)\.origin\s*===\s*new URL\(server\.url\)\.origin/,
    'navigation allowed only to the exact local origin');
  assert.doesNotMatch(MAIN, /shell\.openExternal/, 'no openExternal of renderer-supplied URLs');
});

test('electron: permission requests and checks are denied; remote requests cancelled', () => {
  assert.match(MAIN, /setPermissionRequestHandler\s*\(\s*\([^)]*\)\s*=>\s*(cb|callback)\(\s*false\s*\)\s*\)/);
  assert.match(MAIN, /setPermissionCheckHandler\s*\(\s*\(\)\s*=>\s*false\s*\)/);
  assert.match(MAIN, /onBeforeRequest\s*\(/);
  assert.match(MAIN, /cb\(\s*\{\s*cancel\s*:\s*!ok\s*\}\s*\)/);
  assert.doesNotMatch(MAIN, /setDevicePermissionHandler\s*\([^)]*=>\s*true/);
  // Auth cookie: HttpOnly + SameSite strict, per-launch random.
  assert.match(MAIN, /randomBytes\(\s*32\s*\)/);
  assert.match(MAIN, /cookies\.set\(\s*\{[^}]*httpOnly\s*:\s*true[^}]*sameSite\s*:\s*['"]strict['"]/);
});

test('electron: preload exposes only a narrow API (no ipcRenderer / require passthrough)', () => {
  assert.match(PRELOAD, /contextBridge\.exposeInMainWorld\(/);
  const exposed = PRELOAD.slice(PRELOAD.indexOf('exposeInMainWorld'));
  assert.doesNotMatch(exposed, /:\s*ipcRenderer\b|ipcRenderer\s*[,}]|\.\.\.\s*ipcRenderer/, 'ipcRenderer itself is not exposed');
  assert.doesNotMatch(exposed, /\brequire\b|process\.|Buffer|child_process|\bfs\b/);
  const channels = [...PRELOAD.matchAll(/ipcRenderer\.(?:send|sendSync|invoke|on|removeListener)\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(channels.length > 0);
  for (const c of channels) assert.match(c, /^['"]mc:[a-z-]+['"]$/, `fixed channel name, got ${c}`);
  // Main side: privileged IPC handlers check the sender.
  for (const ch of ['mc:win', 'mc:win-is-maximized', 'mc:settings-get', 'mc:settings-set', 'mc:clipboard-write']) {
    const i = MAIN.indexOf(`'${ch}'`);
    assert.ok(i > 0, ch);
    assert.match(MAIN.slice(i, i + 160), /fromOurWindow\(event\)/, `${ch} validates the sender`);
  }
});

test('electron: build config enables asar and the security fuses', () => {
  const pkg = JSON.parse(read('package.json'));
  const b = pkg.build;
  assert.equal(b.asar, true);
  assert.deepEqual({
    runAsNode: b.electronFuses?.runAsNode,
    enableNodeOptionsEnvironmentVariable: b.electronFuses?.enableNodeOptionsEnvironmentVariable,
    enableNodeCliInspectArguments: b.electronFuses?.enableNodeCliInspectArguments,
    onlyLoadAppFromAsar: b.electronFuses?.onlyLoadAppFromAsar,
    enableEmbeddedAsarIntegrityValidation: b.electronFuses?.enableEmbeddedAsarIntegrityValidation,
    grantFileProtocolExtraPrivileges: b.electronFuses?.grantFileProtocolExtraPrivileges,
  }, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
    grantFileProtocolExtraPrivileges: false,
  });
  assert.ok(b.files.includes('!server/test/**'), 'tests are not shipped');
  assert.ok(!b.files.some((f) => /^(\*\*\/\*|\*)$/.test(f)), 'no catch-all include');
});

test('server: harden-env is the first import of server/main.js', () => {
  const firstImport = read('server', 'main.js').split('\n').find((l) => /^\s*import\b/.test(l));
  assert.match(firstImport, /import\s+['"]\.\/harden-env\.js['"]/);
});
