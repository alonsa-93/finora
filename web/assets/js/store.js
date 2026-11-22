// Shared app state + a tiny event bus. Views read from here and subscribe to changes.
import { api, setLens } from './api.js';
import { getPref, setPref } from './prefs.js';

const bus = new EventTarget();
export const on = (type, fn) => { const f = (e) => fn(e.detail); bus.addEventListener(type, f); return () => bus.removeEventListener(type, f); };
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

export const state = {
  status: null,          // /api/status
  categories: [],        // /api/categories
  accounts: [],          // /api/accounts
  connections: [],       // /api/connections
  sync: null,            // /api/sync/status
  merchants: [],         // names gathered from summary/recurring for the command palette
  month: null,           // month shown on the overview
  availableMonths: [],
  business: null,        // /api/business (settings); business mode is on when business.enabled
  lens: 'all',           // all | business | private (only while business mode is on)
};

/** Business mode settings, and the lens it allows (the remembered one, or 'all' when it is off). */
/** `silent` only at boot, before any screen has loaded: later (demo switched, settings saved) a lens
 *  that changes must reload the screens, or the switch and the numbers would disagree. */
export async function loadBusiness({ silent = false } = {}) {
  try { state.business = await api.business(); } catch { state.business = state.business || { enabled: false }; }
  const want = state.business.enabled ? getPref('lens', 'all') : 'all';
  setLensState(want, { silent });
  emit('business', state.business);
  return state.business;
}

export function setLensState(lens, { silent = false } = {}) {
  const l = state.business?.enabled && ['all', 'business', 'private'].includes(lens) ? lens : 'all';
  const changed = l !== state.lens;
  state.lens = l;
  setLens(l);
  if (state.business?.enabled) setPref('lens', l);
  document.documentElement.dataset.lens = l;
  if (changed && !silent) { emit('lens', l); emit('data-changed'); }
}

export const categoryById = (id) => state.categories.find((c) => c.id === id) || null;
export const categoryName = (id) => categoryById(id)?.name || (id ? 'ללא קטגוריה' : 'ללא קטגוריה');

export async function loadStatus() {
  state.status = await api.status();
  emit('status', state.status);
  return state.status;
}

export async function loadReference() {
  const [cats, accounts, connections] = await Promise.all([
    api.categories().catch(() => state.categories),
    api.accounts().catch(() => state.accounts),
    api.connections().catch(() => state.connections),
  ]);
  state.categories = Array.isArray(cats) ? cats : [];
  state.accounts = Array.isArray(accounts) ? accounts : [];
  state.connections = Array.isArray(connections) ? connections : [];
  emit('reference');
}

export function rememberMerchants(names) {
  const set = new Set(state.merchants);
  for (const n of names) if (typeof n === 'string' && n.trim()) set.add(n.trim());
  state.merchants = [...set].slice(0, 400);
}

/** True when there is nothing to show: no real connections and demo mode off. */
export const isFirstRun = () => Boolean(state.status && !state.status.demoMode && !state.status.hasConnections);
