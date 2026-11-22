// Shared helpers for the security regression suite (server/test/security-*.test.js).
// Not a test file itself (does not match *.test.js).
//
// - isolates the data dir (fresh temp dir; never %LOCALAPPDATA%\Finora)
// - replaces israeli-bank-scrapers and puppeteer with in-memory stubs, so no browser is launched
//   and no bank / card company is ever contacted
// - starts the real server on 127.0.0.1 with a free port and offers a raw HTTP client that can
//   send arbitrary Host / Origin / Sec-Fetch-Site headers.
import { mkdtempSync, rmSync } from 'node:fs';

/** Best-effort removal of the temp data dir (call after the server and DBs are closed). */
export function removeDataDir(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
}
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import http from 'node:http';

export function isolateDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'finora-sec-test-'));
  process.env.FINORA_DATA_DIR = dir;
  process.env.FINORA_QUIET = '1';
  return dir;
}

// The scraper stub: every scrape() call is delegated to globalThis.__mcScrape(credentials, emit)
// where emit(type) fires a progress event (e.g. 'LOGIN_SUCCESS'). Calls are recorded in
// globalThis.__mcScrapeCalls. SCRAPERS is intentionally not exported, so companies.js uses its
// static fallback list.
const SCRAPER_STUB = `
export function createScraper(options) {
  let cb = null;
  return {
    onProgress(fn) { cb = fn; },
    async scrape(credentials) {
      globalThis.__mcScrapeCalls = globalThis.__mcScrapeCalls || [];
      globalThis.__mcScrapeCalls.push({ companyId: options.companyId, credentials: { ...credentials } });
      const fn = globalThis.__mcScrape || (async () => ({ success: false, errorType: 'GENERIC', errorMessage: 'stub' }));
      return fn(credentials, (type) => { if (cb) cb(options.companyId, { type }); });
    },
    async terminate() {},
  };
}
`;
const PUPPETEER_STUB = 'export default { executablePath: () => process.execPath };';
const dataUrl = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

let stubbed = false;
export function installScraperStub() {
  if (stubbed) return;
  stubbed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'israeli-bank-scrapers') return { url: dataUrl(SCRAPER_STUB), format: 'module', shortCircuit: true };
      if (specifier === 'puppeteer') return { url: dataUrl(PUPPETEER_STUB), format: 'module', shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}

/** Start the real server on a free port, without auth (tests set a token with config.setAuthToken
 * where they check it). Returns { port, close, host, origin }. */
export async function startTestServer() {
  const { startServer } = await import('../main.js');
  const s = await startServer({ port: 0, insecureNoAuthForTests: true });
  const port = s.port;
  return { ...s, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
}

export const seen = []; // every response's headers, for the "no CORS headers anywhere" check

/**
 * Raw HTTP request (lets us set Host / Origin / Sec-Fetch-* freely).
 * opts: { headers, body (string|Buffer|object -> JSON), host (Host header; default own) }
 */
export function request(port, method, path, opts = {}) {
  const headers = { Host: `127.0.0.1:${port}`, ...(opts.headers || {}) };
  let body = opts.body;
  if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) body = JSON.stringify(body);
  if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        seen.push({ method, path, headers: res.headers });
        resolve({ status: res.statusCode, headers: res.headers, buf, text, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

/** Headers a legitimate same-origin state-changing request from the dashboard carries. */
export const jsonHeaders = (origin) => ({
  'Content-Type': 'application/json', 'X-Finora': '1', Origin: origin, 'Sec-Fetch-Site': 'same-origin',
});

export async function waitForSyncIdle(isSyncing, timeoutMs = 20000) {
  const t0 = Date.now();
  // Give the async run() a tick to start.
  await new Promise((r) => setTimeout(r, 20));
  while (isSyncing()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('sync did not finish');
    await new Promise((r) => setTimeout(r, 25));
  }
}
