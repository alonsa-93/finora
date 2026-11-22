// Thin client for the Finora JSON API (see docs/API.md).

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const FALLBACK = {
  NETWORK: 'אין חיבור לשרת של Finora. כדאי לוודא שהיישום פועל במחשב ולנסות שוב.',
  DEFAULT: 'משהו השתבש. אפשר לנסות שוב.',
};

function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// Business mode: the lens (all / business / private) every data screen asks for. One place, so no
// screen can forget it; the server ignores it while business mode is off.
let LENS = 'all';
export const setLens = (l) => { LENS = ['all', 'business', 'private'].includes(l) ? l : 'all'; };
const LENS_PATHS = new Set(['/transactions', '/summary', '/insights', '/position', '/recurring', '/annual',
  '/annual/insights', '/price-trends', '/chat']);

// The per-launch API token, sent in X-Finora on every /api call next to the cookie (the cookie
// alone also reaches other 127.0.0.1 ports; this token never leaves our origin). Desktop: from the
// preload. Browser / Edge window: auth.js keeps it in sessionStorage (this tab only, never a URL).
const TOKEN_KEY = 'mc_api'; // also written by auth.js
let token = '';
function apiToken() {
  if (!token) token = String(window.finora?.apiToken || '');
  if (!token) { try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { token = ''; } }
  return token;
}

async function errorOf(res) {
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  const e = data && data.error;
  return new ApiError((e && typeof e.message === 'string' && e.message) || FALLBACK.DEFAULT, {
    status: res.status,
    code: (e && e.code) || `HTTP_${res.status}`,
  });
}

async function request(method, path, { query, body, signal } = {}) {
  // An edit of one row answers with the row as the current lens shows it.
  const lensed = LENS_PATHS.has(path) || (method === 'PATCH' && path.startsWith('/transactions/'));
  if (LENS !== 'all' && lensed) query = { ...(query || {}), lens: LENS };
  const headers = { Accept: 'application/json', 'X-Finora': apiToken() };
  const init = { method, headers, signal, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(`/api${path}${qs(query)}`, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(FALLBACK.NETWORK);
  }
  if (res.status === 204) return null;
  if (!res.ok) throw await errorOf(res);
  try { return await res.json(); } catch { return null; }
}

/**
 * Save a GET /api file (the CSV exports). A plain <a href> navigation cannot carry the token, so the
 * file is fetched with it and handed to the browser as a blob: URL with the server's file name.
 */
export async function downloadApiFile(href) {
  if (typeof href !== 'string' || !href.startsWith('/api/')) throw new ApiError(FALLBACK.DEFAULT);
  let res;
  try {
    res = await fetch(href, { headers: { 'X-Finora': apiToken() }, credentials: 'same-origin', cache: 'no-store' });
  } catch { throw new ApiError(FALLBACK.NETWORK); }
  if (!res.ok) throw await errorOf(res);
  const blob = await res.blob();
  const m = /filename="([^"\\/]+)"/.exec(res.headers.get('content-disposition') || '');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = m ? m[1] : 'finora.csv';
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

export const api = {
  status: (o) => request('GET', '/status', o),
  setDemo: (enabled) => request('POST', '/demo', { body: { enabled } }),
  saveSettings: (settings) => request('PATCH', '/settings', { body: settings }),
  companies: (o) => request('GET', '/companies', o),
  connections: (o) => request('GET', '/connections', o),
  addConnection: (payload) => request('POST', '/connections', { body: payload }),
  updateConnection: (id, patch) => request('PATCH', `/connections/${encodeURIComponent(id)}`, { body: patch }),
  removeConnection: (id, deleteData) => request('DELETE', `/connections/${encodeURIComponent(id)}`, { query: { deleteData: deleteData ? 'true' : 'false' } }),
  sync: (connectionId, { interactive = false } = {}) => request('POST', '/sync', {
    body: connectionId == null ? {} : { connectionId, ...(interactive ? { interactive: true } : {}) },
  }),
  syncStatus: (o) => request('GET', '/sync/status', o),
  accounts: (o) => request('GET', '/accounts', o),
  categories: (o) => request('GET', '/categories', o),
  transactions: (query, o = {}) => request('GET', '/transactions', { ...o, query }),
  updateTransaction: (id, patch) => request('PATCH', `/transactions/${encodeURIComponent(id)}`, { body: patch }),
  similarTransactions: (id, category) => request('GET', `/transactions/${encodeURIComponent(id)}/similar`, { query: { category } }),
  undoChange: (undoId) => request('POST', '/transactions/undo', { body: { undoId } }),
  // summary(month) or summary({ period } | { months: 'YYYY-MM,…' } | { from, to })
  summary: (q, o = {}) => request('GET', '/summary', { ...o, query: q && typeof q === 'object' ? q : { month: q } }),
  insights: (month, o = {}) => request('GET', '/insights', { ...o, query: { month } }),
  position: (months, o = {}) => request('GET', '/position', { ...o, query: months && months.length ? { months: months.join(',') } : {} }),
  recurring: (o) => request('GET', '/recurring', o),
  annual: (end, o = {}) => request('GET', '/annual', { ...o, query: { end } }),
  annualInsights: (end, o = {}) => request('GET', '/annual/insights', { ...o, query: { end } }),
  priceTrends: (end, o = {}) => request('GET', '/price-trends', { ...o, query: { end } }),
  chat: (question, o = {}) => request('POST', '/chat', { ...o, body: { question } }),
  openSync: () => request('POST', '/sync/open', { body: {} }),
  wipe: (confirm) => request('POST', '/wipe', { body: { confirm } }),
  exportUrl: (from, to) => `/api/export.csv${qs({ from, to, lens: LENS === 'all' ? undefined : LENS })}`,
  // business mode
  business: (o) => request('GET', '/business', o),
  saveBusiness: (patch) => request('PATCH', '/business', { body: patch }),
  businessOverview: (o) => request('GET', '/business/overview', o),
  businessFlow: (months, o = {}) => request('GET', '/business/flow', { ...o, query: { months } }),
  businessExportUrl: (from, to) => `/api/business/export.csv${qs({ from, to })}`,
  setAccountScope: (id, scope) => request('PATCH', `/accounts/${encodeURIComponent(id)}`, { body: { scope } }),
  // Google Sheets and their dashboards
  sheets: (o) => request('GET', '/sheets', o),
  sheetTable: (id, o) => request('GET', `/sheets/${encodeURIComponent(id)}/table`, o),
  addSheet: (payload) => request('POST', '/connections', { body: { companyId: 'gsheet', ...payload } }),
  createDashboard: (d) => request('POST', '/dashboards', { body: d }),
  saveDashboard: (id, patch) => request('PATCH', `/dashboards/${encodeURIComponent(id)}`, { body: patch }),
  deleteDashboard: (id) => request('DELETE', `/dashboards/${encodeURIComponent(id)}`),
};
