// Security regression suite - HTTP layer: request guards (Host / CSRF / Sec-Fetch-Site / OPTIONS /
// CORS), Electron-mode auth cookie, response headers, input validation, SQL metacharacters,
// static-file traversal and CSV export hardening. Runs the real server on a free port with a temp
// data dir (demo DB only; no connections are created here, the scraper is stubbed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import {
  isolateDataDir, installScraperStub, startTestServer, request, jsonHeaders, seen, removeDataDir,
} from './security-helpers.js';

const DATA_DIR = isolateDataDir();
installScraperStub();

const EXPECTED_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; "
  + "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

let srv; let port; let origin; let host; let config; let state;
const get = (path, opts) => request(port, 'GET', path, opts);
const send = (method, path, body, headers = {}) => request(port, method, path,
  { body, headers: { ...jsonHeaders(origin), ...headers } });

before(async () => {
  srv = await startTestServer();
  ({ port, origin, host } = srv);
  config = await import('../config.js');
  state = await import('../state.js');
  // Make sure the demo DB is built (no real connections => demo mode).
  assert.equal(state.isDemoMode(), true);
  state.activeDb();
});
after(async () => { config.setAuthToken(null); await srv.close(); removeDataDir(DATA_DIR); });

// ---- 1. request guards ---------------------------------------------------------------------------

test('guards: Host allowlist accepts only 127.0.0.1:<port> and localhost:<port>', async () => {
  for (const h of [host, `localhost:${port}`]) {
    assert.equal((await get('/api/status', { headers: { Host: h } })).status, 200, h);
    assert.equal((await get('/', { headers: { Host: h } })).status, 200, h);
  }
  const bad = ['evil.example', `evil.example:${port}`, '127.0.0.1', 'localhost', `127.0.0.1:${port + 1}`,
    `[::1]:${port}`, `0.0.0.0:${port}`, `127.0.0.1:${port}.evil.example`, `127.0.0.1.nip.io:${port}`];
  for (const h of bad) {
    for (const path of ['/api/status', '/', '/assets/js/app.js', '/api/export.csv']) {
      const r = await get(path, { headers: { Host: h } });
      assert.equal(r.status, 403, `${path} Host=${JSON.stringify(h)}`);
      assert.equal(r.json?.error?.code, 'BAD_HOST');
    }
  }
  const r = await send('POST', '/api/demo', { enabled: true }, { Host: 'evil.example' });
  assert.equal(r.status, 403);
});

function rawRequest(raw) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.on('data', (d) => { data += d.toString('utf8'); });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
    sock.end(raw);
  });
}

test('guards: missing or empty Host header is refused', async () => {
  for (const raw of ['GET /api/status HTTP/1.0\r\n\r\n', 'GET /api/status HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n',
    'GET / HTTP/1.0\r\n\r\n', `GET http://evil.example/api/status HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`]) {
    const res = await rawRequest(raw);
    const status = Number(res.split(' ')[1]);
    assert.ok(status === 403 || status === 400, `${JSON.stringify(raw)} -> ${status}`);
    assert.ok(!res.includes('"demoMode"'), 'status object not returned');
  }
});

test('guards: state-changing requests need X-MoneyCash: 1', async () => {
  for (const v of [undefined, '0', 'true', '', '11', '1,1']) {
    const r = await send('POST', '/api/demo', { enabled: true }, { 'X-MoneyCash': v });
    assert.equal(r.status, 403, `X-MoneyCash=${JSON.stringify(v)}`);
    assert.equal(r.json?.error?.code, 'FORBIDDEN');
  }
  for (const [m, p] of [['PATCH', '/api/settings'], ['DELETE', '/api/connections/1'], ['PUT', '/api/demo'],
    ['POST', '/api/sync'], ['POST', '/'], ['PATCH', '/api/transactions/1']]) {
    const r = await send(m, p, {}, { 'X-MoneyCash': undefined });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal((await send('POST', '/api/demo', { enabled: true })).status, 200); // control
});

test('guards: state-changing requests need a JSON content type', async () => {
  for (const ct of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x',
    'application/jsonx', 'text/json', 'application/json-patch+json', 'xapplication/json']) {
    const r = await send('POST', '/api/demo', JSON.stringify({ enabled: true }), { 'Content-Type': ct });
    assert.equal(r.status, 403, `Content-Type=${ct}`);
  }
  for (const ct of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON']) {
    assert.equal((await send('POST', '/api/demo', { enabled: true }, { 'Content-Type': ct })).status, 200, ct);
  }
});

test('guards: state-changing requests from a foreign Origin are refused', async () => {
  for (const o of ['http://evil.example', 'null', `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`,
    `http://127.0.0.1:${port}/`, 'http://localhost', `http://[::1]:${port}`, '']) {
    const r = await send('POST', '/api/demo', { enabled: true }, { Origin: o });
    assert.equal(r.status, 403, `Origin=${JSON.stringify(o)}`);
  }
  for (const o of [origin, `http://localhost:${port}`, undefined]) {
    assert.equal((await send('POST', '/api/demo', { enabled: true }, { Origin: o })).status, 200, `Origin=${o}`);
  }
});

test('guards: Sec-Fetch-Site on state-changing requests', async () => {
  for (const s of ['cross-site', 'same-site', 'bogus']) {
    assert.equal((await send('POST', '/api/demo', { enabled: true }, { 'Sec-Fetch-Site': s })).status, 403, s);
  }
  for (const s of ['same-origin', 'none', undefined]) {
    assert.equal((await send('POST', '/api/demo', { enabled: true }, { 'Sec-Fetch-Site': s })).status, 200, String(s));
  }
});

test('guards: Sec-Fetch-Site on /api reads (incl. CSV export)', async () => {
  for (const path of ['/api/status', '/api/transactions', '/api/export.csv', '/api/connections', '/api/nope']) {
    for (const s of ['cross-site', 'same-site', 'bogus']) {
      const r = await get(path, { headers: { 'Sec-Fetch-Site': s } });
      assert.equal(r.status, 403, `${path} ${s}`);
      assert.equal(r.json?.error?.code, 'FORBIDDEN');
      assert.ok(!r.text.includes('תאריך'), 'no CSV body leaked');
    }
  }
  for (const s of ['same-origin', 'none', undefined]) {
    assert.equal((await get('/api/status', { headers: { 'Sec-Fetch-Site': s } })).status, 200, String(s));
  }
});

test('guards: OPTIONS is refused (405) and never answers a CORS preflight', async () => {
  for (const path of ['/api/status', '/api/connections', '/api/demo', '/', '/assets/js/app.js']) {
    const r = await request(port, 'OPTIONS', path, {
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-moneycash, content-type' },
    });
    assert.equal(r.status, 405, path);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal(r.headers['access-control-allow-headers'], undefined);
  }
});

test('guards: no response ever carries CORS headers', async () => {
  // Extra requests with Origin set, on top of every response recorded by the other tests.
  await get('/api/status', { headers: { Origin: 'http://evil.example' } });
  await get('/', { headers: { Origin: 'http://evil.example' } });
  await send('POST', '/api/demo', { enabled: true }, { Origin: 'http://evil.example' });
  assert.ok(seen.length > 20);
  for (const s of seen) {
    const cors = Object.keys(s.headers).filter((k) => k.startsWith('access-control-'));
    assert.deepEqual(cors, [], `${s.method} ${s.path}`);
  }
});

// ---- 2. Electron-mode auth ---------------------------------------------------------------------

test('auth: with a token configured, /api needs the exact per-port mc_auth_<port> cookie AND the API token', async () => {
  const N = `mc_auth_${port}`;
  const token = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';
  const wrongSameLen = `${token.slice(0, -1)}w`;
  config.setAuthToken(token);
  const api = config.getApiToken();
  assert.match(api, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(api, token);
  const X = { 'X-MoneyCash': api };
  try {
    for (const path of ['/api/status', '/api/transactions', '/api/export.csv', '/api/connections', '/api/nope']) {
      const none = await get(path, { headers: X });
      assert.equal(none.status, 401, `${path} without cookie`);
      assert.equal(none.json?.error?.code, 'UNAUTHORIZED');
      for (const c of [`${N}=${wrongSameLen}`, `${N}=short`, `${N}=${token}x`, `${N}=`, `MC_AUTH_${port}=${token}`,
        `x${N}=${token}`, `${N}x=${token}`, `mc_auth=${token}`, `mc_auth_${port + 1}=${token}`]) {
        assert.equal((await get(path, { headers: { Cookie: c, ...X } })).status, 401, `${path} ${c}`);
      }
      // The cookie alone (what another 127.0.0.1 listener could capture) is not enough.
      for (const x of [undefined, '', '1', `${api.slice(0, -1)}A`, `${api}x`, api.slice(1), token]) {
        assert.equal((await get(path, { headers: { Cookie: `${N}=${token}`, 'X-MoneyCash': x } })).status, 401, `${path} X-MoneyCash=${x}`);
      }
      assert.equal((await get(path, { headers: { Cookie: `${N}=${token}`, ...X } })).status === 401, false, `${path} cookie + token`);
    }
    assert.equal((await get('/api/status', { headers: { Cookie: `${N}=${token}`, ...X } })).status, 200);
    assert.equal((await get('/api/status', { headers: { Cookie: `theme=dark; ${N}=${token}; x=1`, ...X } })).status, 200);
    // Mutations: no cookie => 401 even with the token; cookie without the token (or with '1') => 401.
    assert.equal((await send('POST', '/api/demo', { enabled: true }, X)).status, 401);
    assert.equal((await send('POST', '/api/demo', { enabled: true }, { Cookie: `${N}=${token}`, 'X-MoneyCash': undefined })).status, 401);
    assert.equal((await send('POST', '/api/demo', { enabled: true }, { Cookie: `${N}=${token}` })).status, 401);
    assert.equal((await send('POST', '/api/demo', { enabled: true }, { Cookie: `${N}=${token}`, ...X })).status, 200);
    // CSRF rules still apply with both factors.
    assert.equal((await send('POST', '/api/demo', { enabled: true }, { Cookie: `${N}=${token}`, ...X, 'Content-Type': 'text/plain' })).status, 403);
    // Sec-Fetch-Site still applies with a valid cookie.
    assert.equal((await get('/api/status', { headers: { Cookie: `${N}=${token}`, ...X, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    // A new auth token comes with a new API token; the old one stops working.
    config.setAuthToken(token);
    assert.notEqual(config.getApiToken(), api);
    assert.equal((await get('/api/status', { headers: { Cookie: `${N}=${token}`, ...X } })).status, 401);
  } finally {
    config.setAuthToken(null);
  }
  assert.equal(config.getApiToken(), null);
  assert.equal((await get('/api/status')).status, 200, 'test-only no-auth mode needs no cookie');
});

test('auth: POST /api/session trades a one-time token for the cookie and the API token', async () => {
  const session = await import('../session.js');
  const token = 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0F9e';
  config.setAuthToken(token);
  try {
    const one = session.armBootstrap();
    const bad = await send('POST', '/api/session', { token: `${one.slice(0, -1)}${one.endsWith('A') ? 'B' : 'A'}` });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers['set-cookie'], undefined);
    const ok = await send('POST', '/api/session', { token: one });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.apiToken, config.getApiToken());
    assert.match(String(ok.headers['set-cookie']), new RegExp(`^mc_auth_${port}=${token}; HttpOnly; SameSite=Strict; Path=/$`));
    assert.match(String(ok.headers['cache-control']), /no-store/);
    // Single use.
    assert.equal((await send('POST', '/api/session', { token: one })).status, 401);
    // Expired: armed longer ago than the TTL.
    const old = session.armBootstrap(Date.now() - session.BOOTSTRAP_TTL_MS - 1000);
    assert.equal((await send('POST', '/api/session', { token: old })).status, 401);
    // The token from the answer opens /api together with the cookie.
    const X = { Cookie: `mc_auth_${port}=${token}`, 'X-MoneyCash': ok.json.apiToken };
    assert.equal((await get('/api/status', { headers: X })).status, 200);
  } finally {
    config.setAuthToken(null);
  }
});

test('auth: setAuthToken rejects weak / malformed tokens', () => {
  for (const t of ['', 'short', 'a'.repeat(31), 'a'.repeat(129), `${'a'.repeat(40)};x`, `${'a'.repeat(40)} `, 123]) {
    assert.throws(() => config.setAuthToken(t), String(t));
  }
  assert.equal(config.getAuthToken(), null);
});

// ---- 3. response headers -----------------------------------------------------------------------

test('headers: CSP, nosniff, Referrer-Policy and X-Frame-Options on HTML, JS, API and error responses', async () => {
  // There is no /vendor route (no third-party scripts are served): such a path is a 404 with the same headers.
  const cases = [
    ['GET', '/', 200, /text\/html/],
    ['GET', '/index.html', 200, /text\/html/],
    ['GET', '/assets/js/app.js', 200, /javascript/],
    ['GET', '/assets/css/base.css', 200, /text\/css/],
    ['GET', '/api/status', 200, /application\/json/],
    ['GET', '/api/export.csv', 200, /text\/csv/],
    ['GET', '/vendor/chart.umd.js', 404, /json/],
    ['GET', '/api/nope', 404, /json/],
    ['GET', '/nope.html', 404, /json/],
    ['OPTIONS', '/', 405, /json/],
  ];
  for (const [m, p, status, ctype] of cases) {
    const r = await request(port, m, p);
    assert.equal(r.status, status, `${m} ${p}`);
    assert.match(String(r.headers['content-type']), ctype, `${p} content-type`);
    assert.equal(r.headers['content-security-policy'], EXPECTED_CSP, `${p} CSP`);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', p);
    assert.equal(r.headers['x-frame-options'], 'DENY', p);
    assert.equal(r.headers['x-powered-by'], undefined, p);
    if (p.startsWith('/api/')) assert.equal(r.headers['cache-control'], 'no-store', `${p} cache-control`);
  }
  const bad = await get('/', { headers: { Host: 'evil.example' } });
  assert.equal(bad.headers['content-security-policy'], EXPECTED_CSP, 'BAD_HOST response');
  assert.equal(bad.headers['x-frame-options'], 'DENY');
});

test('headers: CSP directives are exactly the expected set (no unsafe-*, no remote sources)', async () => {
  const csp = (await get('/')).headers['content-security-policy'];
  const dirs = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.deepEqual(dirs, {
    'default-src': "'self'", 'img-src': "'self' data:", 'style-src': "'self'", 'script-src': "'self'",
    'object-src': "'none'", 'base-uri': "'none'", 'form-action': "'self'", 'frame-ancestors': "'none'",
  });
  assert.doesNotMatch(csp, /unsafe|\*|https?:/);
});

// ---- 4. input validation ------------------------------------------------------------------------

test('input: body over 16kb => 413', async () => {
  const r = await send('POST', '/api/demo', JSON.stringify({ enabled: true, pad: 'x'.repeat(20 * 1024) }));
  assert.equal(r.status, 413);
  assert.equal(r.json?.error?.code, 'TOO_LARGE');
  const r2 = await send('PATCH', '/api/settings', JSON.stringify({ autoSync: { enabled: false, time: '07:00' }, pad: 'y'.repeat(17 * 1024) }));
  assert.equal(r2.status, 413);
});

test('input: malformed / non-object JSON => 400', async () => {
  for (const b of ['{"enabled":', '{enabled:true}', "{'enabled':true}", '"str"', '42', 'null', '{"enabled":true}}', '\u0000']) {
    const r = await send('POST', '/api/demo', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.ok(['BAD_JSON', 'BAD_REQUEST'].includes(r.json?.error?.code), JSON.stringify(b));
  }
  assert.equal((await send('POST', '/api/demo', '[]')).status, 400);
  assert.equal((await send('POST', '/api/demo', '{"enabled":"true"}')).status, 400);
  // Error bodies never echo the raw input or a stack trace.
  const r = await send('POST', '/api/demo', '{"enabled": <script>MARKER</script>');
  assert.ok(!r.text.includes('MARKER') && !/at \w+ \(/.test(r.text));
});

test('input: unknown / prototype companyId is rejected', async () => {
  for (const id of ['nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype', 'MAX', ' max', 123, null, ['max'], { id: 'max' }]) {
    const r = await send('POST', '/api/connections', { companyId: id, credentials: { username: 'u', password: 'p' } });
    assert.equal(r.status, 400, `companyId=${JSON.stringify(id)}`);
  }
  const r = await send('POST', '/api/connections', { companyId: 'oneZero', credentials: { email: 'a', password: 'b', phoneNumber: 'c', otpLongTermToken: 'd' } });
  assert.equal(r.status, 400);
  assert.equal(r.json?.error?.code, 'UNSUPPORTED_COMPANY');
});

test('input: __proto__ / constructor / unknown keys in credentials are rejected without prototype pollution', async () => {
  const bodies = [
    '{"companyId":"max","credentials":{"username":"u","password":"p","__proto__":{"polluted":"yes"}}}',
    '{"companyId":"max","credentials":{"username":"u","password":"p","constructor":{"prototype":{"polluted":"yes"}}}}',
    '{"companyId":"max","credentials":{"__proto__":{"username":"u","password":"p","polluted":"yes"}}}',
    '{"companyId":"max","credentials":{"username":"u","password":"p","prototype":"x"}}',
    '{"companyId":"max","credentials":{"username":"u","password":"p","extra":"x"}}',
    '{"companyId":"max","credentials":{"username":"u"}}',
    '{"companyId":"max","credentials":{"username":"u","password":""}}',
    '{"companyId":"max","credentials":{"username":"u","password":123}}',
    '{"companyId":"max","credentials":{"username":["u"],"password":"p"}}',
    `{"companyId":"max","credentials":{"username":"u","password":"${'p'.repeat(129)}"}}`,
    '{"companyId":"max","credentials":{"username":"u","password":"p\\u0000"}}',
    '{"companyId":"max","credentials":{"username":"u\\n","password":"p"}}',
    '{"companyId":"max","credentials":[["username","u"],["password","p"]]}',
    '{"companyId":"max","credentials":"username=u&password=p"}',
    '{"companyId":"max"}',
  ];
  for (const b of bodies) {
    const r = await send('POST', '/api/connections', b);
    assert.equal(r.status, 400, b);
  }
  // Top-level __proto__ on another endpoint: accepted request, but no pollution.
  await send('POST', '/api/demo', '{"enabled":true,"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}');
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(state.realDb().prepare('SELECT COUNT(*) AS n FROM connections').get().n, 0, 'no connection was created');
});

test('input: out-of-range limit / offset and invalid sort / order / month / ids / ids / dates => 400', async () => {
  const bad = [
    'limit=0', 'limit=501', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=1e2', 'limit=0x10', 'limit=%2B5', 'limit=99999999999999',
    'offset=-1', 'offset=10000001', 'offset=1.0', 'offset=a',
    'sort=foo', 'sort=date;DROP%20TABLE%20transactions', 'sort=t.amount', 'sort=DATE', 'sort=date%20desc',
    'order=up', 'order=ASC', 'order=asc;--', 'order=desc%2C1',
    'month=2026-13', 'month=2026-00', 'month=2026-1', 'month=26-01', 'month=2026-11-01', 'month=abcd-ef',
    'ids=1,a', 'ids=,1', 'ids=1,', 'ids=1;2', 'ids=-1', 'ids=12345678901', `ids=${Array.from({ length: 501 }, (_, i) => i + 1).join(',')}`,
    'ids=1%20OR%201=1',
    'accountId=0', 'accountId=-5', 'accountId=x', 'category=bogus', 'category=__proto__', 'direction=sideways',
    'from=2026-1-1', 'to=yesterday', 'from=2026-13-01',
    `q=${'a'.repeat(101)}`,
  ];
  for (const qs of bad) {
    const r = await get(`/api/transactions?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.equal(r.json?.error?.code, 'BAD_REQUEST', qs);
  }
  for (const qs of ['month=2026-13', 'month=x']) {
    assert.equal((await get(`/api/summary?${qs}`)).status, 400, `summary ${qs}`);
    assert.equal((await get(`/api/insights?${qs}`)).status, 400, `insights ${qs}`);
  }
  for (const qs of ['from=x', 'to=2026-1-1']) assert.equal((await get(`/api/export.csv?${qs}`)).status, 400, `export ${qs}`);
  for (const p of ['/api/transactions/abc', '/api/transactions/-1', '/api/transactions/12345678901', '/api/transactions/1.5']) {
    assert.equal((await send('PATCH', p, { excluded: true })).status, 400, p);
  }
  for (const p of ['/api/connections/abc', '/api/connections/0x1']) assert.equal((await send('DELETE', p)).status, 400, p);
  // Positive controls.
  for (const qs of ['limit=1', 'limit=500', 'offset=0', 'sort=amount&order=asc', 'sort=date&order=desc', 'month=2026-11',
    `ids=${Array.from({ length: 500 }, (_, i) => i + 1).join(',')}`, 'direction=in', 'category=groceries', 'q=%D7%A9%D7%95%D7%A4%D7%A8%D7%A1%D7%9C']) {
    assert.equal((await get(`/api/transactions?${qs}`)).status, 200, qs);
  }
});

test('input: repeated query parameters are rejected, not merged', async () => {
  for (const qs of ['limit=1&limit=2', 'offset=0&offset=1', 'sort=date&sort=amount', 'order=asc&order=desc',
    'q=a&q=b', 'month=2026-11&month=2026-10', 'ids=1&ids=2', 'category=other&category=groceries', 'accountId=1&accountId=2']) {
    const r = await get(`/api/transactions?${qs}`);
    assert.equal(r.status, 400, qs);
  }
  assert.equal((await get('/api/summary?month=2026-11&month=2026-10')).status, 400);
  assert.equal((await get('/api/export.csv?from=2026-01-01&from=2026-02-01')).status, 400);
});

test('input: settings / sync / transaction patch bodies are type-checked', async () => {
  const cases = [
    ['PATCH', '/api/settings', { autoSync: { enabled: 'yes', time: '07:00' } }],
    ['PATCH', '/api/settings', { autoSync: { enabled: true, time: '25:00' } }],
    ['PATCH', '/api/settings', { autoSync: { enabled: true, time: '7:00' } }],
    ['PATCH', '/api/settings', { autoSync: { enabled: true, time: '07:00; rm' } }],
    ['PATCH', '/api/settings', {}],
    ['POST', '/api/sync', { connectionId: '1' }],
    ['POST', '/api/sync', { connectionId: 0 }],
    ['POST', '/api/sync', { connectionId: 1.5 }],
    ['PATCH', '/api/transactions/1', { category: 'bogus' }],
    ['PATCH', '/api/transactions/1', { category: '__proto__' }],
    ['PATCH', '/api/transactions/1', { excluded: 'true' }],
    ['PATCH', '/api/transactions/1', { applyToSimilar: 1, category: 'other' }],
    ['PATCH', '/api/transactions/1', {}],
  ];
  for (const [m, p, b] of cases) assert.equal((await send(m, p, b)).status, 400, `${m} ${p} ${JSON.stringify(b)}`);
});

// SQL metacharacters in q: insert known rows into the demo DB and search for them.
let demoDb; let demoAccount;
function insertTx(o) {
  const now = new Date().toISOString();
  const r = demoDb.prepare(`INSERT INTO transactions (account_id, dedupe_key, date, processed_date, description, merchant_key,
    memo, amount, original_amount, original_currency, status, category, category_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ILS', 'completed', 'other', 'auto', ?, ?)`)
    .run(demoAccount, `sec-test:${Math.random()}`, o.date, o.date, o.description, `sec ${o.description}`.slice(0, 50),
      o.memo ?? null, o.amount ?? -1234, o.amount ?? -1234, now, now);
  return Number(r.lastInsertRowid);
}

test('input: SQL metacharacters in q are matched as literal text', async () => {
  demoDb = state.activeDb();
  demoAccount = demoDb.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get().id;
  const all = (await get('/api/transactions?limit=1')).json.total;
  const ids = {
    pct: insertTx({ date: '2026-01-15', description: 'SECTEST 100% literal' }),
    und: insertTx({ date: '2026-01-15', description: 'SECTEST under_score' }),
    quote: insertTx({ date: '2026-01-15', description: "SECTEST O'Brien" }),
    dash: insertTx({ date: '2026-01-15', description: 'SECTEST say "--hi' }),
    plain: insertTx({ date: '2026-01-15', description: 'SECTEST plain' }),
    bs: insertTx({ date: '2026-01-15', description: 'SECTEST back\\slash' }),
  };
  const search = async (q) => {
    const r = await get(`/api/transactions?limit=500&q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200, q);
    return r.json;
  };
  const cases = [['%', ids.pct], ['_', ids.und], ["'", ids.quote], ['"--', ids.dash], ['\\', ids.bs]];
  for (const [q, id] of cases) {
    const res = await search(q);
    assert.ok(res.items.some((t) => t.id === id), `q=${q} finds its row`);
    assert.ok(res.total < all + 6, `q=${q} is not a wildcard`);
    for (const t of res.items) {
      assert.ok(t.description.includes(q) || (t.memo || '').includes(q), `q=${q} returned non-matching "${t.description}"`);
    }
  }
  assert.ok(!(await search('%')).items.some((t) => t.id === ids.plain));
  assert.ok(!(await search('_')).items.some((t) => t.id === ids.plain));
  for (const q of ["' OR '1'='1", "%' OR 1=1 --", '") OR 1=1 --', "'; DROP TABLE transactions; --", 'SECTEST%plain', 'SECTEST_plain']) {
    assert.equal((await search(q)).total, 0, q);
  }
  // Table still intact.
  assert.equal((await get('/api/transactions?limit=1')).json.total, all + 6);
});

// ---- 5. static file serving ---------------------------------------------------------------------

const LEAK_MARKERS = ['"name": "moneycash"', 'electronFuses', 'createApp', 'DatabaseSync', '[extensions]', 'for 16-bit app support',
  'root:x:0:0', '"name": "express"', '"name": "chart.js"', 'MONEYCASH', 'harden-env'];
function traversalPaths() {
  const paths = [];
  for (const prefix of ['', '/assets', '/assets/js', '/vendor', '/vendor/heebo']) {
    for (const t of ['/../package.json', '/../../package.json', '/../../../package.json',
      '/%2e%2e/package.json', '/%2e%2e/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/%2e%2e%2f%2e%2e%2fpackage.json',
      '/..%2fpackage.json', '/..%2f..%2fpackage.json', '/..%2f..%2f..%2fpackage.json', '/%2E%2E%2F%2E%2E%2Fpackage.json',
      '/%252e%252e%252fpackage.json', '/%252e%252e/%252e%252e/package.json', '/..%252f..%252fpackage.json',
      '/..%5cpackage.json', '/..%5c..%5cpackage.json', '/..%5c..%5c..%5cpackage.json', '/..\\package.json', '/..\\..\\package.json',
      '/%2e%2e%5c%2e%2e%5cpackage.json', '/..%c0%afpackage.json', '/..%u2216package.json', '/....//package.json',
      '/..;/package.json', '/.%2e/package.json', '/%2e./package.json',
      '/../server/app.js', '/../../server/app.js', '/..%2f..%2fserver%2fapp.js', '/..%5c..%5cserver%5capp.js',
      '/../../../chart.js/package.json', '/..%2f..%2f..%2fchart.js%2fpackage.json', '/../../dist/chart.umd.js',
      '/.env', '/.git/config', '/.htaccess', '/%2eenv', '/.DS_Store', '/.gitignore',
      '/.%2e', '/.%2e/', '/.%2e/index.html', '/%2e%2e', '/%2e%2e/', '/%2e%2e/index.html', '/..%2f', '/..%2findex.html',
      '/package.json', '/server/app.js', '/node_modules/express/package.json',
      '/%00', '/index.html%00.js', '/C:/Windows/win.ini', '/C:%5cWindows%5cwin.ini', '//etc/passwd', '/%2fetc%2fpasswd',
      '/\\\\127.0.0.1\\c$\\Windows\\win.ini']) {
      paths.push(prefix + t);
    }
  }
  paths.push('/vendor/chart.umd.js/../../package.json', '/vendor/chart.umd.js%2f..%2f..%2fpackage.json', '/vendor/heebo/',
    '/vendor/heebo/../chart.umd.js/../../package.json', '/vendor/', '/vendor/chart.js/package.json', '/vendor/heebo/../../package.json',
    '/assets/../../server/config.js', '/assets%2f..%2f..%2fpackage.json', '/vendor%2fheebo%2f..%2f..%2fpackage.json');
  return paths;
}
// Targets that live outside web/ and the two vendor dirs (or are dotfiles): these must never be served.
const OUTSIDE = /package\.json|server|config\.js|win\.ini|passwd|\.env|%2eenv|\.git|\.htaccess|\.DS_Store|node_modules|chart\.umd\.js\/|dist\/chart|%00/i;

test('static: traversal attempts never return files outside web/ and vendor dirs, nor dotfiles', async () => {
  const failures = [];
  for (const p of traversalPaths()) {
    const r = await get(p);
    const leaked = LEAK_MARKERS.find((m) => r.text.includes(m));
    if (leaked) failures.push(`${p} -> ${r.status} LEAK(${leaked})`);
    else if (OUTSIDE.test(p) && r.status !== 404) failures.push(`${p} -> ${r.status}`);
    else if (![200, 301, 404].includes(r.status)) failures.push(`${p} -> ${r.status}`);
  }
  assert.deepEqual(failures, []);
  // Positive controls: allowed dirs still work.
  assert.equal((await get('/assets/js/app.js')).status, 200);
  assert.equal((await get('/assets/css/base.css')).status, 200);
});

test('static: every traversal-style path (incl. encoded dot-segments like /assets/.%2e/) is a plain 404', async () => {
  const failures = [];
  for (const p of traversalPaths()) {
    const r = await get(p);
    if (r.status !== 404) failures.push(`${p} -> ${r.status}`);
  }
  assert.deepEqual(failures, []);
});

// ---- 7. CSV export ------------------------------------------------------------------------------

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test('csv: formula injection is neutralised (= + - @ tab CR, leading space, full-width)', async () => {
  demoDb = state.activeDb();
  demoAccount = demoDb.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get().id;
  const payloads = ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '\t=1+1', '\rcmd', '\tplain', '\rplain', ' =1+1', '  +1', '\u00a0=1',
    '\u3000=1+1', '＝1+1', '＋1', '－1', '＠SUM(A1)', ' ＝1', '=HYPERLINK("http://evil.example","x")',
    "=cmd|' /C calc'!A0", '\n=1+1'];
  payloads.forEach((d, i) => insertTx({ date: `2020-01-${String((i % 28) + 1).padStart(2, '0')}`, description: d, memo: d }));
  const r = await get('/api/export.csv?from=2020-01-01&to=2020-01-31');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/csv; charset=utf-8$/i);
  assert.match(r.headers['content-disposition'], /^attachment; filename="moneycash-2020-01-01-2020-01-31\.csv"$/);
  const rows = parseCsv(r.text.replace(/^\uFEFF/, ''));
  const data = rows.slice(1);
  assert.equal(data.length, payloads.length);
  const failures = [];
  for (const d of payloads) {
    const row = data.find((x) => x[2] === `'${d}`);
    if (!row) failures.push(`description ${JSON.stringify(d)} not neutralised: ${JSON.stringify(data.map((x) => x[2]).find((c) => c.endsWith(d.trim())))}`);
    else if (row[3] !== `'${d}`) failures.push(`memo ${JSON.stringify(d)} not neutralised`);
  }
  assert.deepEqual(failures, []);
  // No cell anywhere (except plain numbers) starts with a formula trigger.
  for (const row of rows) {
    for (const c of row) {
      if (/^-?\d+(\.\d+)?$/.test(c)) continue;
      assert.doesNotMatch(c, /^[\s\u3000]*[=+\-@＝＋－＠]|^[\t\r\n]/, `cell ${JSON.stringify(c)}`);
    }
  }
});

test('csv: UTF-8 BOM and Hebrew header row', async () => {
  const r = await get('/api/export.csv');
  assert.equal(r.status, 200);
  assert.deepEqual([...r.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
  const header = parseCsv(r.text.replace(/^\uFEFF/, ''))[0];
  assert.deepEqual(header, ['תאריך', 'תאריך חיוב', 'תיאור', 'הערה', 'סכום', 'סכום מקורי', 'מטבע מקורי', 'קטגוריה',
    'חשבון', 'תשלום', 'סטטוס', 'חיוב כרטיס אשראי', 'מוחרג מהסיכומים']);
  assert.ok(r.text.endsWith('\r\n'));
  // Export is a GET but still protected against cross-site navigation (see guards).
  assert.equal((await get('/api/export.csv', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } })).status, 403);
});
